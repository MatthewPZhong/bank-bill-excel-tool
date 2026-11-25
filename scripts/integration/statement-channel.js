// 网银账单：渠道与子模板（v3.2.15）e2e 集成验证
//   覆盖：真实主库（渠道、归属、渠道账户映射、迁移）+ 真实 xlsx 读取与写出 + main.js 中的真实分组、生成配置与导入校验函数
//   ① 渠道两个子模板、两个文件含同一账号：一份明细、一份余额，Channel 列与余额银行名称/所在地取渠道名，
//      余额跨文件连续，计算种子写在渠道银行段的种子文件；文件名用渠道名
//   ② 余额方式可不一致（v3.2.21）：不同账户各按子模板的方式出余额（计算 / 账单余额列 / 不出余额），
//      组内第一个子模板不出余额时其他账户照常出余额；同一账户同批命中不同方式时整批阻断，导出目录没有新文件
//   ③ 渠道组与普通模板混合导入：按渠道计一组，汇总文件名组数正确，回读两组账号齐全
//   ④ 发生额计算：渠道首次补录只提示一次、补录种子写入渠道银行段；跨文件断档按渠道一次判定
//   ⑤ 旧主/子数据迁移后导入，结果与 ① 相同口径
//   ⑥ 子模板 MerchantId 映射不同（固定账号 / 多大账号）：所选大账号只注入多大账号子模板的文件
//   ⑦ 渠道账户映射：两个子模板的文件都按渠道映射输出清结算账号与兜底币种（回读明细）
//   ⑧ 迁移账户映射冲突：未处理时该渠道导入阻断、普通模板照常；处理后导入成功且回读账号为所选候选
//   ⑱ 加入渠道前核对目标渠道待处理冲突：模板维护了冲突账户号时阻断，模板映射与冲突候选不变
//   ⑲ 渠道迁移备份失败：网银账单导入与月度余额装配被阻断（否则主、子模板同一账号的月度余额重复输出），重试成功后解除
//   UI 由 renderer lifecycle 覆盖；本脚本验证数据、金额与文件在整条链路上的结果。
//
// 用法：node scripts/integration/statement-channel.js

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const XLSX = require('xlsx');
const acorn = require('acorn');

const { AppDatabase } = require('../../src/backend/database');
const {
  buildDetailExportRows,
  buildMappedRows,
  extractHeaders,
  buildFeatureFilterToken,
  buildLogicValueToken,
  normalizeLogicValueFields,
  LOGIC_VALUE_MIN_FIELDS,
  getFeatureFilterRef,
  LEGACY_FEATURE_FILTER_ID,
  parseFeatureFilterToken,
  parseLogicValueToken,
  parseLogicValueFeatureFilterRef,
  buildLogicValueFeatureCandidate,
  resolveUsedFeatureFilters,
  upgradeLegacyFeatureFilter,
  FileValidationError,
  MERCHANT_ID_CURRENCY_ONLY_MARKER,
  mapEachCollectingCurrencyBigAccountIssues,
  normalizeCell,
  writeBalanceWorkbook,
  writeWorkbookRows
} = require('../../src/backend/file-service');
const {
  findPreviousBalanceSeed,
  readBalanceSeedRecords,
  splitTemplateName,
  upsertBalanceSeedRecord
} = require('../../src/backend/balance-seed-store');
const { readBalanceAdjustments } = require('../../src/backend/balance-adjustment-store');
const { createStatementGenerationHelpers } = require('../../src/main-process/statement-generation');
const {
  buildDateRangeLabel,
  buildFieldIndexMap,
  deriveBalanceRecords,
  parseRequiredBillDates,
  resolveAccountBalanceModes,
  scanBalanceSeedStatus
} = require('../../src/main-process/statement-generation-business');
const {
  buildManualBalanceSeedPlan,
  writeManualBalanceSeedPlan
} = require('../../src/main-process/manual-balance-seed-preflight');
const {
  appendStatementSessionImport,
  buildStatementFileEntry,
  cloneRowsWithMetadata,
  createStatementImportSession,
  getStatementSessionEntries,
  mergeMappedDetailRows,
  normalizeInputFilePaths,
  removeStatementSessionEntriesByFilePath,
  resolveSinglePreparedFieldValue
} = require('../../src/main-process/statement-session');
const channelIdentity = require('../../src/main-process/statement-channel-identity');
const { ALL_BANKS_TEMPLATE_SCOPE, assembleMonthlyBalance } = require('../../src/main-process/monthly-balance');

const { createTemplateHeaderUpdateTools } = require('../../src/main-process/template-header-update');
const ROOT = path.join(__dirname, '..', '..');
const MAIN_SOURCE = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
const MAIN_AST = acorn.parse(MAIN_SOURCE, { ecmaVersion: 'latest', sourceType: 'script' });
const ORDERED_FIELDS = ['BillDate', 'MerchantId', 'Currency', 'Credit Amount', 'Debit Amount', 'Balance', 'Channel'];
const TODAY = '2026-11-05';
const FIXED = '__FIXED__:';
const MULTI = '__MULTI_BIG_ACCOUNT__';

let passed = 0;
let failed = 0;
const failures = [];

function assertEq(actual, expected, label) {
  const aJson = JSON.stringify(actual);
  const eJson = JSON.stringify(expected);
  if (aJson === eJson) { passed++; return; }
  failed++; failures.push({ label, actual, expected });
}
function assertTrue(cond, label) {
  if (cond) { passed++; return; }
  failed++; failures.push({ label, actual: cond, expected: true });
}

// 在同一作用域内求值 main.js 的若干顶层函数（可互相调用），其余依赖按名注入。
function loadMainFunctions(names, deps = {}) {
  const sources = names.map((name) => {
    const node = MAIN_AST.body.find((item) => item.type === 'FunctionDeclaration' && item.id && item.id.name === name);
    if (!node) throw new Error(`未找到 main.js 函数：${name}`);
    return MAIN_SOURCE.slice(node.start, node.end);
  });
  const depNames = Object.keys(deps);
  return Function(...depNames, `${sources.join('\n')}\nreturn { ${names.join(', ')} };`)(...depNames.map((key) => deps[key]));
}

// 按需装配 main.js 中的函数运行真实入口：overrides 与 env 已装配的依赖优先；其余 main.js 顶层函数按名称取源码、
//   在同一作用域中求值；顶层 require 绑定按需加载对应模块；顶层字面量常量直接取值。其他模块级状态须由 overrides 给出。
//   返回共享的作用域（同一作用域里取出的函数共用模块级状态）；nested(name) 求值嵌套在函数内的同名变量声明（如 IPC handler）。
function loadMainEntry(name, scopeValues) {
  return createMainScope(scopeValues)[name];
}

function isPlainConstantInit(init) {
  if (init.type === 'ObjectExpression' || init.type === 'ArrayExpression' || init.type === 'TemplateLiteral') return true;
  if (init.type === 'CallExpression' && init.callee.type === 'MemberExpression'
      && init.callee.object.name === 'Object' && init.callee.property.name === 'freeze') return true;
  return init.type === 'NewExpression' && ['Set', 'Map'].includes(init.callee.name);
}

function createMainScope(scopeValues) {
  const scope = new Map(Object.entries(scopeValues));
  const topLevel = new Map();
  for (const node of MAIN_AST.body) {
    if (node.type === 'FunctionDeclaration' && node.id) topLevel.set(node.id.name, { kind: 'function', node });
    if (node.type !== 'VariableDeclaration') continue;
    for (const declarator of node.declarations) {
      const init = declarator.init;
      const requireCall = init && init.type === 'CallExpression' && init.callee.name === 'require' ? init
        : init && init.type === 'MemberExpression' && init.object.type === 'CallExpression' && init.object.callee.name === 'require' ? init.object : null;
      if (requireCall) {
        const specifier = requireCall.arguments[0].value;
        const modulePath = specifier.startsWith('.') ? path.join(ROOT, 'src', specifier) : specifier;
        const member = init.type === 'MemberExpression' ? init.property.name : null;
        if (declarator.id.type === 'Identifier') {
          topLevel.set(declarator.id.name, { kind: 'require', modulePath, member, property: null });
        } else if (declarator.id.type === 'ObjectPattern') {
          for (const property of declarator.id.properties) {
            topLevel.set(property.value.name, { kind: 'require', modulePath, member, property: property.key.name });
          }
        }
      } else if (init && init.type === 'Literal' && declarator.id.type === 'Identifier') {
        topLevel.set(declarator.id.name, { kind: 'literal', value: init.value });
      } else if (init && declarator.id.type === 'Identifier' && node.kind === 'const' && isPlainConstantInit(init)) {
        // 常量表（Object.freeze / 对象 / 数组 / new Set、new Map 字面量）：按需在同一作用域求值
        topLevel.set(declarator.id.name, { kind: 'expression', node: init });
      }
    }
  }
  const evaluate = (source) => Function('scope', `with (scope) { return (${source}); }`)(proxy);
  scope.set('nested', (declarationName) => {
    let found = null;
    (function visit(node) {
      if (!node || typeof node !== 'object' || found) return;
      if (node.type === 'VariableDeclarator' && node.id && node.id.name === declarationName) {
        found = node.init;
        return;
      }
      Object.values(node).forEach((value) => (Array.isArray(value) ? value.forEach(visit) : visit(value)));
    })(MAIN_AST);
    if (!found) throw new Error(`未找到 main.js 声明：${declarationName}`);
    return evaluate(MAIN_SOURCE.slice(found.start, found.end));
  });
  const proxy = new Proxy({}, {
    has: (_target, key) => typeof key === 'string' && (scope.has(key) || topLevel.has(key)),
    get: (_target, key) => {
      if (key === Symbol.unscopables) return undefined;
      if (!scope.has(key)) {
        const item = topLevel.get(key);
        if (item.kind === 'function') {
          scope.set(key, evaluate(MAIN_SOURCE.slice(item.node.start, item.node.end)));
        } else if (item.kind === 'require') {
          const loaded = require(item.modulePath);
          const base = item.member ? loaded[item.member] : loaded;
          scope.set(key, item.property ? base[item.property] : base);
        } else if (item.kind === 'expression') {
          scope.set(key, evaluate(MAIN_SOURCE.slice(item.node.start, item.node.end)));
        } else {
          scope.set(key, item.value);
        }
      }
      return scope.get(key);
    },
    set: (_target, key, value) => {
      scope.set(key, value);
      return true;
    }
  });
  return proxy;
}

// ===== 测试数据 =====

const LAYOUTS = {
  A: { headers: ['Date', 'Account', 'Curr', 'Credit', 'Debit'], map: { BillDate: 'Date', MerchantId: 'Account', Currency: 'Curr', 'Credit Amount': 'Credit', 'Debit Amount': 'Debit' } },
  B: { headers: ['TxnDate', 'Acct', 'Ccy', 'In', 'Out'], map: { BillDate: 'TxnDate', MerchantId: 'Acct', Currency: 'Ccy', 'Credit Amount': 'In', 'Debit Amount': 'Out' } },
  C: { headers: ['D', 'A', 'C', 'Cr', 'Dr'], map: { BillDate: 'D', MerchantId: 'A', Currency: 'C', 'Credit Amount': 'Cr', 'Debit Amount': 'Dr' } },
  // 带账单余额列（取账单余额列时 Balance 映射到 Bal / Bl）
  D: { headers: ['Dt', 'AccNo', 'Cy', 'CrAmt', 'DrAmt', 'Bal'], map: { BillDate: 'Dt', MerchantId: 'AccNo', Currency: 'Cy', 'Credit Amount': 'CrAmt', 'Debit Amount': 'DrAmt' } },
  E: { headers: ['Day', 'No', 'Cur', 'Inc', 'Exp', 'Bl'], map: { BillDate: 'Day', MerchantId: 'No', Currency: 'Cur', 'Credit Amount': 'Inc', 'Debit Amount': 'Exp' } },
  F: { headers: ['Fd', 'Fa', 'Fc', 'Fin', 'Fout'], map: { BillDate: 'Fd', MerchantId: 'Fa', Currency: 'Fc', 'Credit Amount': 'Fin', 'Debit Amount': 'Fout' } }
};

// merchant：MerchantId 改映射到指定值；'' 表示不映射 MerchantId
function exportMappingsFor(layout, { balance = '通过发生额计算', merchant = null } = {}) {
  const map = LAYOUTS[layout].map;
  return [
    ...Object.entries(map).map(([templateField, mappedField]) => ({
      templateField,
      mappedField: templateField === 'MerchantId' && merchant !== null ? merchant : mappedField,
      mappedFields: []
    })),
    { templateField: 'Balance', mappedField: balance, mappedFields: [] }
  ];
}

function writeSource(filePath, layout, rows) {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([LAYOUTS[layout].headers, ...rows]), 'Sheet1');
  XLSX.writeFile(workbook, filePath);
}

function readSheet(filePath) {
  const workbook = XLSX.readFile(filePath, { raw: true });
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { header: 1, raw: true });
  return { header: rows[0], rows: rows.slice(1).filter((row) => row.some((cell) => cell !== undefined && cell !== '')) };
}

function excelDate(value) {
  if (typeof value !== 'number') return String(value);
  const { y, m, d } = XLSX.SSF.parse_date_code(value);
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function readBalanceRows(filePath) {
  const { header, rows } = readSheet(filePath);
  const at = (name) => header.indexOf(name);
  return rows.map((row) => [row[at('银行名称')], row[at('所在地')], row[at('银行账号')], row[at('币种')], excelDate(row[at('账单日期')]), row[at('期末余额')]]);
}

function readDetailColumns(filePath, names) {
  const { header, rows } = readSheet(filePath);
  return rows.map((row) => names.map((name) => row[header.indexOf(name)]));
}

// ===== 环境：真实主库 + main.js 真实函数 =====

// 每步打开的主库须在删除临时目录前关闭（Windows 不允许删除仍被打开的 SQLite 文件）。
const openedDatabases = [];

// overrides（v3.2.22 B45 故障注入）：writeWorkbookRows(options, realWrite)、mergeGeneratedXlsxFiles(paths, out, realMerge)、
//   storeGeneratedBalanceSeeds(input, realStore)；realSession: true 时会话条目、批次与导出缓存用真实实现（statement-session）
function createEnvironment(dir, label, overrides = {}) {
  const storageRoot = path.join(dir, `storage-${label}`);
  fs.mkdirSync(storageRoot, { recursive: true });
  const database = new AppDatabase(path.join(dir, `${label}.sqlite`));
  openedDatabases.push(database);
  database.init();
  const exportMappingsByTemplateId = new Map();
  // 模板维护的大账号（导入入口聚合大账号用；默认没有）
  const bigAccountsByTemplateId = new Map();
  const acknowledgedKeys = new Set();
  const imported = [];
  const lastGeneratedExports = { detail: null, balance: null, allDetail: null, allBalance: null };

  const getTemplateMappingConfig = (templateId) => {
    const template = database.getTemplate(templateId);
    if (!template) return null;
    return {
      template,
      exportMappings: exportMappingsByTemplateId.get(Number(templateId)) || [],
      exportTargetFields: ORDERED_FIELDS,
      bigAccounts: bigAccountsByTemplateId.get(Number(templateId)) || []
    };
  };

  const fns = {};
  const sanitizeFileName = loadMainFunctions(['sanitizeFileName']).sanitizeFileName;
  Object.assign(fns, loadMainFunctions(['buildOutputFilePath', 'buildStatementOutputFilePath', 'scopedMergedOutputFileName'], {
    getToday: () => TODAY, path, ensureStorageRoot: () => storageRoot, sanitizeFileName
  }));
  const generation = createStatementGenerationHelpers({
    appendLog: overrides.appendLog || ((_root, error) => { throw error; }),
    buildDateRangeLabel,
    buildDetailExportRows,
    buildFieldIndexMap,
    buildStatementOutputFilePath: overrides.buildStatementOutputFilePath
      ? (options) => overrides.buildStatementOutputFilePath(options, fns.buildStatementOutputFilePath)
      : fns.buildStatementOutputFilePath,
    cloneRowsWithMetadata,
    deriveBalanceRecords,
    ensureStorageRoot: () => storageRoot,
    extractHeaders,
    FileValidationError,
    findPreviousBalanceSeed,
    getAcknowledgedBalanceGapKeys: () => acknowledgedKeys,
    getBalanceTemplatePath: () => path.join(ROOT, 'assets', '余额账单模版.xlsx'),
    getStatementSessionEntries,
    mergeMappedDetailRows,
    normalizeCell,
    normalizeInputFilePaths,
    parseRequiredBillDates,
    readBalanceAdjustments,
    resolveSinglePreparedFieldValue,
    scanBalanceSeedStatus: (input) => scanBalanceSeedStatus(input, storageRoot),
    splitTemplateName,
    storeGeneratedBalanceSeeds: (() => {
      const realStore = ({ templateName, seedRecords }) => {
        seedRecords.forEach((record) => upsertBalanceSeedRecord(storageRoot, { templateName, ...record, overwrite: true }));
      };
      return overrides.storeGeneratedBalanceSeeds ? (input) => overrides.storeGeneratedBalanceSeeds(input, realStore) : realStore;
    })(),
    writeBalanceWorkbook: overrides.writeBalanceWorkbook
      ? (options) => overrides.writeBalanceWorkbook(options, writeBalanceWorkbook)
      : writeBalanceWorkbook,
    writeWorkbookRows: overrides.writeWorkbookRows
      ? (options) => overrides.writeWorkbookRows(options, writeWorkbookRows)
      : writeWorkbookRows
  });

  const removedSessionPaths = [];
  const realMergeGeneratedXlsxFiles = loadMainFunctions(['mergeGeneratedXlsxFiles'], { require, fs, path, applyWatermark: () => {}, prepareWorkbookTextForWrite: require('../../src/backend/file-service/writers').prepareWorkbookTextForWrite }).mergeGeneratedXlsxFiles;
  const mainDeps = {
    database,
    getTemplateMappingConfig,
    getStatementSessionEntries,
    normalizeCell,
    sanitizeFileName,
    splitTemplateName,
    FileValidationError,
    FIXED_FIELD_VALUE_PREFIX: FIXED,
    MERCHANT_ID_MULTI_ACCOUNT_MARKER: MULTI,
    // v3.2.16：「原始账单仅有币种无账户号」相关依赖（buildStatementGenerationConfig / rebuildMatchedTemplateFileEntries 引用）
    MERCHANT_ID_CURRENCY_ONLY_MARKER,
    MERCHANT_ID_CURRENCY_ONLY_OPTION: '原始账单仅有币种无账户号',
    mapEachCollectingCurrencyBigAccountIssues,
    ADVANCED_MAPPING_FIELDS: [],
    // v3.2.19：原始账单预处理「过滤账单」（本脚本不使用，仅满足生成配置的依赖）
    PREPROCESS_ROW_FILTER_MAPPING_FIELD: '过滤账单',
    PREPROCESS_ROW_FILTER_ENABLED_OPTION: '是',
    // v3.2.19：重复账单过滤与逻辑取值（本脚本不使用，仅满足生成配置的依赖）
    DUPLICATE_ROW_FILTER_MAPPING_FIELD: '重复账单过滤',
    DUPLICATE_ROW_FILTER_ENABLED_OPTION: '是',
    LOGIC_VALUE_MAPPING_FIELD: '逻辑取值',
    BALANCE_DISABLED_OPTION: '无',
    BALANCE_CALCULATED_OPTION: '通过发生额计算',
    CONCAT_FIELDS_MAPPING_FIELD: '__CONCAT__',
    // v3.2.16：字段筛选特征值（本脚本不使用，仅满足生成配置的依赖）
    FEATURE_FILTER_MAPPING_FIELD: '__FEATURE_FILTER_MAPPING__',
    // v3.2.18：生成配置的失效映射拦截（与本脚本的标记常量一致）
    templateHeaderUpdateTools: createTemplateHeaderUpdateTools({
      BALANCE_DISABLED_OPTION: '无',
      BALANCE_CALCULATED_OPTION: '通过发生额计算',
      CONCAT_FIELDS_MAPPING_FIELD: '__CONCAT__',
      FEATURE_FILTER_MAPPING_FIELD: '__FEATURE_FILTER_MAPPING__',
      SIGNED_AMOUNT_MAPPING_FIELD: '__SIGNED_AMOUNT__',
      AMOUNT_BASED_NAME_MAPPING_FIELD: '__AMOUNT_NAME__',
      AMOUNT_BASED_ACCOUNT_MAPPING_FIELD: '__AMOUNT_ACCOUNT__'
    }),
    buildFeatureFilterToken,
    buildLogicValueToken,
    normalizeLogicValueFields,
    LOGIC_VALUE_MIN_FIELDS,
    getFeatureFilterRef,
    LEGACY_FEATURE_FILTER_ID,
    parseFeatureFilterToken,
    parseLogicValueToken,
    parseLogicValueFeatureFilterRef,
    buildLogicValueFeatureCandidate,
    resolveUsedFeatureFilters,
    upgradeLegacyFeatureFilter,
    SIGNED_AMOUNT_MAPPING_FIELD: '__SIGNED_AMOUNT__',
    AMOUNT_BASED_NAME_MAPPING_FIELD: '__AMOUNT_NAME__',
    AMOUNT_BASED_ACCOUNT_MAPPING_FIELD: '__AMOUNT_ACCOUNT__',
    getCurrencyMappingTablePath: () => path.join(ROOT, 'assets', '币种映射表.xlsx'),
    loadCurrencyMappings: () => [],
    fs,
    path,
    buildAmountSplitByFieldConfig: () => ({ enabled: false }),
    buildBillSplitMergeConfig: () => ({ enabled: false }),
    buildDateParseOrder: () => undefined,
    buildMappedRows,
    createStatementWorkbookReadGuard: () => undefined,
    buildBigAccountRecognitionBasis: () => null,
    finalizeBigAccountRecognitionBasis: () => null,
    cloneRowsWithMetadata,
    buildFieldIndexMap,
    buildManagedMerchantLookupFlags: () => ({ selfInputMerchant: false, skipDirectMerchantLookup: false }),
    resolveGenerationGroupKey: channelIdentity.resolveGenerationGroupKey,
    resolveStatementOutputName: channelIdentity.resolveStatementOutputName,
    resolveTemplateBalanceMode: channelIdentity.resolveTemplateBalanceMode,
    describeBalanceMode: channelIdentity.describeBalanceMode,
    resolveAccountBalanceModes,
    isZeroOrBlankAmount: require('../../src/backend/file-service/normalizers').isZeroOrBlankAmount,
    mergeMappedDetailRows,
    createStatementOutputJournal: overrides.createStatementOutputJournal
      || require('../../src/main-process/statement-output-rollback').createStatementOutputJournal,
    removeStatementSessionEntriesByFilePath: (session, filePath) => {
      removedSessionPaths.push(filePath);
      if (overrides.realSession) removeStatementSessionEntriesByFilePath(session, filePath);
    },
    generateStatementFiles: generation.generateStatementFiles,
    parseRequiredBillDates,
    buildDateRangeLabel,
    getToday: () => TODAY,
    buildOutputFilePath: fns.buildOutputFilePath,
    mergeGeneratedXlsxFiles: overrides.mergeGeneratedXlsxFiles
      ? (paths, outputPath) => overrides.mergeGeneratedXlsxFiles(paths, outputPath, realMergeGeneratedXlsxFiles)
      : realMergeGeneratedXlsxFiles,
    buildStatementFileEntry: overrides.realSession ? buildStatementFileEntry : (entry) => entry,
    buildStatementFileEntryId: overrides.realSession ? sequence('entry') : () => 'entry',
    appendStatementSessionImport: overrides.realSession ? appendStatementSessionImport : () => 'batch',
    buildStatementBatchId: overrides.realSession ? sequence('batch') : () => 'batch',
    lastGeneratedExports,
    updateStatementSessionCache: (session, batchId, generatedFiles) => {
      generation.updateStatementSessionCache(session, batchId, generatedFiles, lastGeneratedExports);
    },
    buildImportResultFromGeneratedFiles: ({ generatedFiles }) => {
      imported.push(generatedFiles);
      return { status: 'captured' };
    },
    FILENAME_MAPPING_TEMPLATE_ID: '__FILENAME_MAPPING__',
    appendActivityLogEntry: overrides.appendActivityLogEntry || (() => {}),
    extractManualBalancePromptWarning: generation.extractManualBalancePromptWarning,
    statementGenerationHelpers: generation,
    scopedMergedOutputFileName: fns.scopedMergedOutputFileName
  };
  Object.assign(fns, loadMainFunctions([
    'buildMappedFieldLookup',
    'normalizeLookupMappingValue',
    'normalizeMappedFields',
    'getMappingFieldValues',
    'getPrimaryMappedField',
    'buildStatementGenerationConfig', 'buildPreprocessRowFilterRules', 'isPreprocessRowFilterEnabled', 'isDuplicateRowFilterEnabled', 'usesLogicValueMapping', 'isLegacyLogicValueDirectReference',
    'resolveStatementFeatureFilters',
    'buildCurrencyBigAccountMappingConfig',
    'buildMappedRowsForFile',
    'getEntryTemplateConfig',
    'dropIssuesOverriddenBySelectedBigAccount',
    'rebuildMatchedTemplateFileEntries',
    'groupStatementEntriesForGeneration',
    'resolveGenerationGroupEntryBalanceModes',
    'findGenerationGroupBalanceModeConflictGroup',
    'collectGenerationGroupBalanceModeConflicts',
    'findResolvedEntriesBalanceModeConflicts',
    'listBalanceModeMixedEntryIndexes',
    'entryUsesSelectedBigAccount',
    'pickResolvedEntries',
    'buildChannelBalanceRowsIncompleteError',
    'buildChannelBalancePlanningError',
    'buildBalanceModeConflictGroup',
    'collectEntryMerchantIdsForLog',
    'formatBalanceModeConflictLines',
    'resolveGenerationGroupChannelName',
    'collectGroupBalanceIssuesWithoutConfig',
    'buildChannelBalanceModeMismatchError',
    'maskAccountLikeTextForLog',
    'buildPreparedStatementBatchFromEntries',
    'resolveEntryBalanceMode',
    'applyEntryBalanceModes',
    'resolveEntryBalancePlan',
    'inspectBalanceEntryRows',
    'generateMultiTemplateGroupFiles',
    'statementOutputErrorForLog',
    'assertStatementBatchWritable',
    'assertStatementEntriesWritable',
    'assertNoCollectedUnwritableText',
    'planVirtualTemplateBalanceRegeneration',
    'assertVirtualTemplateBalanceOutputPaths',
    'regenerateVirtualTemplateBalanceFromSession',
    'normalizeTemplateChannelAssignment',
    'findGenerationGroupOutputNameConflicts',
    'buildStatementOutputNameConflictError',
    'assertGenerationOutputNameUnique',
    'findGenerationGroupOutputPathConflicts',
    'buildStatementOutputPathConflictError',
    'normalizeBundleAccountMappings',
    'buildBundleV5ChannelRestore',
    'buildLegacyBundleChannelRestore',
    'restoreBundleFollowUpRounds'
  ], mainDeps));

  function defineTemplate(name, layout, options = {}) {
    const template = database.upsertTemplate({ name, sourceFileName: `${name}.xlsx`, headers: LAYOUTS[layout].headers });
    const exportMappings = exportMappingsFor(layout, options);
    exportMappingsByTemplateId.set(template.id, exportMappings);
    return template;
  }

  function saveWithChannel(template, channelAssignment) {
    return database.saveMappings(
      template.id,
      exportMappingsByTemplateId.get(template.id).map((mapping) => ({ ...mapping })),
      [], [], undefined, null,
      { channelAssignment }
    ).channelAssignment;
  }

  function entryFor(template, filePath) {
    const config = getTemplateMappingConfig(template.id);
    const generationConfig = fns.buildStatementGenerationConfig({
      template: config.template,
      mappings: config.exportMappings,
      orderedTargetFields: config.exportTargetFields,
      allowManagedMerchantWithoutSelection: true
    });
    return {
      filePath,
      matchedTemplateId: template.id,
      detailRows: fns.buildMappedRowsForFile({ config: generationConfig, inputFilePath: filePath })
    };
  }

  function generate(fileEntries, selectedBigAccount = null) {
    imported.length = 0;
    fns.generateMultiTemplateGroupFiles({
      fileEntries,
      fallbackTemplateConfig: getTemplateMappingConfig(fileEntries[0].matchedTemplateId),
      selectedBigAccount,
      reuseMappedRows: true,
      session: { key: 'session' },
      inputFilePaths: fileEntries.map((entry) => entry.filePath)
    });
    return imported[0];
  }

  return {
    database,
    storageRoot,
    removedSessionPaths,
    fns,
    generation,
    acknowledgedKeys,
    exportMappingsByTemplateId,
    bigAccountsByTemplateId,
    lastGeneratedExports,
    imported,
    mainDeps,
    getTemplateMappingConfig,
    defineTemplate,
    saveWithChannel,
    entryFor,
    generate,
    exportFiles: () => {
      const base = path.join(storageRoot, 'exports', TODAY);
      return ['detail', 'balance'].flatMap((kind) => {
        const folder = path.join(base, kind);
        return fs.existsSync(folder) ? fs.readdirSync(folder).map((name) => `${kind}/${name}`) : [];
      }).sort();
    }
  };
}

function sequence(prefix) {
  let next = 0;
  return () => `${prefix}-${next += 1}`;
}

function seed(env, bankTemplateName, merchantId, currency, billDate, endBalance) {
  upsertBalanceSeedRecord(env.storageRoot, {
    templateName: bankTemplateName, merchantId, currency, billDate, endBalance, generationMethod: '人工录入'
  });
}

// 两个子模板、两个文件、同一账号 RAW001（渠道账户映射 → M001）
function prepareChannelFiles(dir, label) {
  const fileA = path.join(dir, `${label}-a.xlsx`);
  const fileB = path.join(dir, `${label}-b.xlsx`);
  writeSource(fileA, 'A', [['2026-09-01', 'RAW001', 'USD', '10', ''], ['2026-09-02', 'RAW001', 'USD', '', '1']]);
  writeSource(fileB, 'B', [['2026-09-03', 'RAW001', 'USD', '5', '']]);
  return { fileA, fileB };
}

function verifyChannelOutput(env, result, stepLabel) {
  const files = env.exportFiles();
  assertEq(files.filter((name) => name.startsWith('detail/')).length, 1, `${stepLabel}.只出一份明细`);
  assertEq(files.filter((name) => name.startsWith('balance/')).length, 1, `${stepLabel}.只出一份余额`);
  assertTrue(files.every((name) => /招商银行-上海-/.test(name)), `${stepLabel}.文件名用渠道名：${files.join(',')}`);
  assertEq(readDetailColumns(result.detail.filePath, ['Channel', 'MerchantId', 'Currency']), [
    ['招商银行', 'M001', 'USD'],
    ['招商银行', 'M001', 'USD'],
    ['招商银行', 'M001', 'USD']
  ], `${stepLabel}.明细 Channel 列为渠道银行段，账号按渠道映射输出`);
  assertEq(readBalanceRows(result.balance.filePath), [
    ['招商银行', '上海', 'M001', 'USD', '2026-09-01', 1010],
    ['招商银行', '上海', 'M001', 'USD', '2026-09-02', 1009],
    ['招商银行', '上海', 'M001', 'USD', '2026-09-03', 1014]
  ], `${stepLabel}.余额银行名与所在地为渠道，余额跨两个子模板文件连续`);
  const seeds = readBalanceSeedRecords(env.storageRoot, '招商银行').map((record) => [record.billDate, record.endBalance, record.generationMethod, record.templateName]);
  assertEq(seeds, [
    ['2026-08-31', 1000, '人工录入', '招商银行-上海'],
    ['2026-09-01', 1010, '通过发生额计算', '招商银行-上海'],
    ['2026-09-02', 1009, '通过发生额计算', '招商银行-上海'],
    ['2026-09-03', 1014, '通过发生额计算', '招商银行-上海']
  ], `${stepLabel}.计算种子写入渠道银行段的种子文件`);
  assertEq(readBalanceSeedRecords(env.storageRoot, 'CMB').length, 0, `${stepLabel}.子模板自身银行段没有种子文件`);
}

// ① + ⑦
function verifyChannelGroup(dir) {
  const env = createEnvironment(dir, 'step1');
  const owner = env.defineTemplate('招商银行-上海', 'A');
  const channelId = env.saveWithChannel(owner, { mode: 'create' }).channelId;
  const child = env.defineTemplate('CMB-SH', 'B');
  env.saveWithChannel(child, { mode: 'join', channelId });
  env.database.saveAccountMappings({ channelId }, [{ bankAccountId: 'RAW001', clearingAccountId: 'M001' }]);
  seed(env, '招商银行-上海', 'M001', 'USD', '2026-08-31', 1000);
  const { fileA, fileB } = prepareChannelFiles(dir, 'step1');
  const result = env.generate([env.entryFor(owner, fileA), env.entryFor(child, fileB)]);
  verifyChannelOutput(env, result, 'Step1');
  assertEq(result.warnings.filter((warning) => /balance/.test(warning.type)), [], 'Step1.无余额告警');

  // ⑦ 兜底币种：账户号无币种列时按渠道映射的币种输出（两个子模板都生效）
  env.database.saveAccountMappings({ channelId }, [{ bankAccountId: 'RAW009', clearingAccountId: 'M009', noCurrency: true, currency: 'HKD' }]);
  const fileC = path.join(dir, 'step7-a.xlsx');
  const fileD = path.join(dir, 'step7-b.xlsx');
  writeSource(fileC, 'A', [['2026-09-01', 'RAW009', '', '1', '']]);
  writeSource(fileD, 'B', [['2026-09-02', 'RAW009', '', '2', '']]);
  const entries = [env.entryFor(owner, fileC), env.entryFor(child, fileD)];
  assertEq(entries.map((entry) => readRowsFromEntry(entry, ['MerchantId', 'Currency'])), [
    [['M009', 'HKD']],
    [['M009', 'HKD']]
  ], 'Step7.两个子模板的文件都按渠道映射输出清结算账号与兜底币种');
}

// 单个生成分组的逐账户冲突明细（没有冲突时 null）
function conflictLinesOf(env, group) {
  const found = env.fns.collectGenerationGroupBalanceModeConflicts([group]);
  return found ? found[0].lines : null;
}

function readRowsFromEntry(entry, names) {
  const [header, ...rows] = entry.detailRows;
  return rows.map((row) => names.map((name) => row[header.indexOf(name)]));
}

// ② 余额方式可不一致（v3.2.21 D2、D3）
function verifyMixedBalanceModes(dir) {
  // (a) 子模板 A 通过发生额计算（M001），子模板 B 取账单余额列（M002）：一份明细、一份余额，各账户按自己的方式
  const env = createEnvironment(dir, 'step2');
  const owner = env.defineTemplate('招商银行-上海', 'A');
  const channelId = env.saveWithChannel(owner, { mode: 'create' }).channelId;
  const child = env.defineTemplate('CMB-SH', 'D', { balance: 'Bal' });
  env.saveWithChannel(child, { mode: 'join', channelId });
  seed(env, '招商银行-上海', 'M001', 'USD', '2026-08-31', 1000);
  seed(env, '招商银行-上海', 'M002', 'USD', '2026-08-31', 200);
  const fileA = path.join(dir, 'step2-a.xlsx');
  const fileB = path.join(dir, 'step2-b.xlsx');
  writeSource(fileA, 'A', [['2026-09-01', 'M001', 'USD', '10', ''], ['2026-09-02', 'M001', 'USD', '', '1']]);
  writeSource(fileB, 'D', [['2026-09-01', 'M002', 'USD', '10', '', '210'], ['2026-09-02', 'M002', 'USD', '', '5', '205']]);
  const entries = [env.entryFor(owner, fileA), env.entryFor(child, fileB)];
  const groups = env.fns.groupStatementEntriesForGeneration(entries);
  assertEq(groups.length, 1, 'Step2a.两个子模板同组');
  assertEq(conflictLinesOf(env, groups[0]), null, 'Step2a.账户不同，导入预检放行');
  const result = env.generate(entries);
  const files = env.exportFiles();
  assertEq([files.filter((name) => name.startsWith('detail/')).length, files.filter((name) => name.startsWith('balance/')).length], [1, 1], 'Step2a.一份明细、一份余额');
  assertEq(readDetailColumns(result.detail.filePath, ['MerchantId', 'Credit Amount', 'Debit Amount']).length, 4, 'Step2a.明细含两个子模板的全部行');
  assertEq(readBalanceRows(result.balance.filePath), [
    ['招商银行', '上海', 'M001', 'USD', '2026-09-01', 1010],
    ['招商银行', '上海', 'M001', 'USD', '2026-09-02', 1009],
    ['招商银行', '上海', 'M002', 'USD', '2026-09-01', 210],
    ['招商银行', '上海', 'M002', 'USD', '2026-09-02', 205]
  ], 'Step2a.M001 按种子与发生额推算，M002 取账单余额列');
  const seeds = readBalanceSeedRecords(env.storageRoot, '招商银行')
    .filter((record) => record.billDate > '2026-08-31')
    .map((record) => [record.merchantId, record.billDate, record.endBalance, record.generationMethod])
    .sort((left, right) => `${left[0]}${left[1]}`.localeCompare(`${right[0]}${right[1]}`));
  assertEq(seeds, [
    ['M001', '2026-09-01', 1010, '通过发生额计算'],
    ['M001', '2026-09-02', 1009, '通过发生额计算'],
    ['M002', '2026-09-01', 210, '账单里的余额'],
    ['M002', '2026-09-02', 205, '账单里的余额']
  ], 'Step2a.种子生成方式按账户各自的余额方式');
  assertEq(result.warnings.filter((warning) => /balance/.test(warning.type)), [], 'Step2a.无余额告警');

  // (b) 组内第一个子模板不出余额（M101），另一子模板取账单余额列（M102）：只有 M102 出余额，M101 不提示补录
  const envB = createEnvironment(dir, 'step2b');
  const ownerB = envB.defineTemplate('招商银行-上海', 'A', { balance: '无' });
  const channelIdB = envB.saveWithChannel(ownerB, { mode: 'create' }).channelId;
  const childB = envB.defineTemplate('CMB-SH', 'D', { balance: 'Bal' });
  envB.saveWithChannel(childB, { mode: 'join', channelId: channelIdB });
  seed(envB, '招商银行-上海', 'M102', 'USD', '2026-08-31', 50);
  const fileC = path.join(dir, 'step2b-a.xlsx');
  const fileD = path.join(dir, 'step2b-b.xlsx');
  writeSource(fileC, 'A', [['2026-09-01', 'M101', 'USD', '7', '']]);
  writeSource(fileD, 'D', [['2026-09-01', 'M102', 'USD', '', '20', '30']]);
  const resultB = envB.generate([envB.entryFor(ownerB, fileC), envB.entryFor(childB, fileD)]);
  assertEq(readDetailColumns(resultB.detail.filePath, ['MerchantId']).map((row) => row[0]).sort(), ['M101', 'M102'], 'Step2b.明细含不出余额子模板的行');
  assertTrue(Boolean(resultB.balance), 'Step2b.组内首个子模板不出余额时仍生成余额');
  assertEq(resultB.balance ? readBalanceRows(resultB.balance.filePath) : null, [
    ['招商银行', '上海', 'M102', 'USD', '2026-09-01', 30]
  ], 'Step2b.只有取账单余额列的账户出余额');
  assertEq(resultB.warnings.filter((warning) => /balance/.test(warning.type)), [], 'Step2b.不出余额的账户不提示补录');

  // (c) 同一账户 M201 同批命中两种余额方式：整批阻断，逐账户列出，不产出文件
  const envC = createEnvironment(dir, 'step2c');
  const ownerC = envC.defineTemplate('招商银行-上海', 'A');
  const channelIdC = envC.saveWithChannel(ownerC, { mode: 'create' }).channelId;
  const childC = envC.defineTemplate('CMB-SH', 'D', { balance: 'Bal' });
  envC.saveWithChannel(childC, { mode: 'join', channelId: channelIdC });
  seed(envC, '招商银行-上海', 'M201', 'USD', '2026-08-31', 100);
  const fileE = path.join(dir, 'step2c-a.xlsx');
  const fileF = path.join(dir, 'step2c-b.xlsx');
  writeSource(fileE, 'A', [['2026-09-01', 'M201', 'USD', '1', '']]);
  writeSource(fileF, 'D', [['2026-09-02', 'M201', 'USD', '1', '', '102'], ['2026-09-02', 'M202', 'USD', '1', '', '1']]);
  const entriesC = [envC.entryFor(ownerC, fileE), envC.entryFor(childC, fileF)];
  const expectedLines = ['账户 M201（USD）：CMB-SH（取账单余额列）、招商银行-上海（通过发生额计算）'];
  const groupsC = envC.fns.groupStatementEntriesForGeneration(entriesC);
  assertEq(conflictLinesOf(envC, groupsC[0]), expectedLines, 'Step2c.导入预检逐账户列出冲突');
  let thrown = null;
  try {
    envC.generate(entriesC);
  } catch (error) {
    thrown = error;
  }
  assertEq(thrown && [thrown.code, /招商银行-上海/.test(thrown.message), thrown.detailLines], ['CHANNEL_BALANCE_MODE_MISMATCH', true, expectedLines], 'Step2c.生成前阻断：错误码、渠道名与逐账户明细');
  assertEq(envC.exportFiles(), [], 'Step2c.导出目录没有新文件');

  // (d) 组内第一个子模板不出余额且未映射 MerchantId：不按组配置要求 MerchantId，另一子模板的账户照常出余额
  const envD = createEnvironment(dir, 'step2d');
  const ownerD = envD.defineTemplate('招商银行-上海', 'A', { balance: '无', merchant: '' });
  const channelIdD = envD.saveWithChannel(ownerD, { mode: 'create' }).channelId;
  const childD = envD.defineTemplate('CMB-SH', 'D', { balance: 'Bal' });
  envD.saveWithChannel(childD, { mode: 'join', channelId: channelIdD });
  seed(envD, '招商银行-上海', 'M302', 'USD', '2026-08-31', 50);
  const fileG = path.join(dir, 'step2d-a.xlsx');
  const fileH = path.join(dir, 'step2d-b.xlsx');
  writeSource(fileG, 'A', [['2026-09-01', 'IGNORED', 'USD', '7', '']]);
  writeSource(fileH, 'D', [['2026-09-01', 'M302', 'USD', '', '20', '30']]);
  const resultD = envD.generate([envD.entryFor(ownerD, fileG), envD.entryFor(childD, fileH)]);
  assertEq(resultD && resultD.balance ? readBalanceRows(resultD.balance.filePath) : null, [
    ['招商银行', '上海', 'M302', 'USD', '2026-09-01', 30]
  ], 'Step2d.首个子模板不出余额且未映射 MerchantId 时，取账单余额列的账户照常出余额');
  // 反过来，出余额的子模板的账单行没有 MerchantId（未映射）时在生成前拦下，逐行列出，不产出文件
  const envD2 = createEnvironment(dir, 'step2d2');
  const ownerD2 = envD2.defineTemplate('招商银行-上海', 'A', { balance: '无' });
  const channelIdD2 = envD2.saveWithChannel(ownerD2, { mode: 'create' }).channelId;
  const childD2 = envD2.defineTemplate('CMB-SH', 'D', { balance: 'Bal', merchant: '' });
  envD2.saveWithChannel(childD2, { mode: 'join', channelId: channelIdD2 });
  let thrownD2 = null;
  try {
    envD2.generate([envD2.entryFor(ownerD2, fileG), envD2.entryFor(childD2, fileH)]);
  } catch (error) {
    thrownD2 = error;
  }
  assertEq(thrownD2 && [thrownD2.code, /缺少账单日期或 MerchantId/.test(thrownD2.message), thrownD2.detailLines, thrownD2.persistedDetailLines], [
    'CHANNEL_BALANCE_ROWS_INCOMPLETE',
    true,
    ['文件「step2d-b.xlsx」（子模板「CMB-SH」）第2行：缺少 MerchantId（账单日期：2026-09-01）'],
    ['本组第2个文件（子模板「CMB-SH」）第2行：缺少 MerchantId（账单日期：2026-09-01）']
  ], 'Step2d.出余额的子模板账单行没有 MerchantId 时生成前拦下，界面写文件名、落盘写文件序号');
  // 出余额的子模板只有收支都为 0 的行：不启动余额生成，明细照常
  const envD3 = createEnvironment(dir, 'step2d3');
  const ownerD3 = envD3.defineTemplate('招商银行-上海', 'A', { balance: '无' });
  const channelIdD3 = envD3.saveWithChannel(ownerD3, { mode: 'create' }).channelId;
  const childD3 = envD3.defineTemplate('CMB-SH', 'D', { balance: 'Bal' });
  envD3.saveWithChannel(childD3, { mode: 'join', channelId: channelIdD3 });
  const fileZero = path.join(dir, 'step2d3-b.xlsx');
  writeSource(fileZero, 'D', [['2026-09-01', 'M302', 'USD', '0', '', '30']]);
  const resultD3 = envD3.generate([envD3.entryFor(ownerD3, fileG), envD3.entryFor(childD3, fileZero)]);
  assertEq([Boolean(resultD3 && resultD3.detail), resultD3 && resultD3.balance, (resultD3 ? resultD3.warnings : []).filter((warning) => /balance/.test(warning.type))], [true, null, []],
    'Step2d.出余额的子模板只有收支都为 0 的行时不生成余额、不报余额失败');
  // 出余额的子模板有非零交易缺账单日期（与有日期的交易并存）：余额推导会跳过它、余额与种子漏算，生成前拦下
  const fileUndated = path.join(dir, 'step2d3-undated.xlsx');
  writeSource(fileUndated, 'D', [['2026-09-01', 'M302', 'USD', '10', '', '40'], ['', 'M302', 'USD', '50', '', '90']]);
  let thrownUndated = null;
  try {
    envD3.generate([envD3.entryFor(ownerD3, fileG), envD3.entryFor(childD3, fileUndated)]);
  } catch (error) {
    thrownUndated = error;
  }
  assertEq(thrownUndated && [thrownUndated.code, thrownUndated.detailLines], [
    'CHANNEL_BALANCE_ROWS_INCOMPLETE',
    ['文件「step2d3-undated.xlsx」（子模板「CMB-SH」）第3行：缺少账单日期']
  ], 'Step2d.出余额的交易缺账单日期时生成前拦下，不静默漏算余额');
  assertEq(envD3.exportFiles().filter((name) => name.startsWith('balance/')), [], 'Step2d.缺账单日期时不写出余额');
  // 同一行缺两项时一并列出；逐行明细有上限，其余汇总为一行
  const issueRows = Object.assign([['BillDate', 'MerchantId', 'Currency', 'Credit Amount', 'Debit Amount'],
    ['', '', 'USD', '1', ''], ['2026-09-01', '', 'USD', '1', ''], ['2026-09-01', '', 'USD', '1', '']], { rowMetas: [] });
  const inspected = envD3.fns.inspectBalanceEntryRows([{ templateName: 'CMB-SH', fileName: 'x.xlsx', fileOrdinal: 1, detailRows: issueRows }], 2);
  assertEq([inspected.hasEffectiveRow, inspected.issueCount, inspected.lines], [true, 3, [
    '文件「x.xlsx」（子模板「CMB-SH」）第2行：缺少账单日期、MerchantId',
    '文件「x.xlsx」（子模板「CMB-SH」）第3行：缺少 MerchantId（账单日期：2026-09-01）'
  ]], 'Step2d.同一行缺两项一并列出，逐行明细有上限');
  // 整批共用逐行上限：多个渠道的明细合计不超过上限，只补一行汇总
  const issueGroup = (channelName) => ({ channelName, lines: [`${channelName}-a`, `${channelName}-b`], persistedLines: [`${channelName}-1`, `${channelName}-2`], issueCount: 3 });
  const cappedError = envD3.fns.buildChannelBalanceRowsIncompleteError([issueGroup('渠道甲'), issueGroup('渠道乙')], 3);
  assertEq([cappedError.detailLines, cappedError.persistedDetailLines], [
    ['渠道「渠道甲」渠道甲-a', '渠道「渠道甲」渠道甲-b', '渠道「渠道乙」渠道乙-a', '另有 3 行交易缺少账单日期或 MerchantId，未逐行列出（共 6 行）'],
    ['渠道「渠道甲」渠道甲-1', '渠道「渠道甲」渠道甲-2', '渠道「渠道乙」渠道乙-1', '另有 3 行交易缺少账单日期或 MerchantId，未逐行列出（共 6 行）']
  ], 'Step2d.多个渠道的缺字段明细共用整批上限，只补一行汇总');
  // 拆分出的多笔交易来自同一原文件行：按原文件行合并（合并所缺字段）后再计数和截断
  const splitRows = Object.assign([['BillDate', 'MerchantId', 'Currency', 'Credit Amount', 'Debit Amount'],
    ['2026-09-01', '', 'USD', '1', ''], ['', '', 'USD', '2', ''], ['2026-09-02', '', 'USD', '3', '']],
  { rowMetas: [{ sourceRowNumber: 2 }, { sourceRowNumber: 2 }, { sourceRowNumber: 3 }] });
  assertEq(envD3.fns.inspectBalanceEntryRows([{ templateName: 'CMB-SH', fileName: 'x.xlsx', fileOrdinal: 1, detailRows: splitRows }], 2).lines, [
    '文件「x.xlsx」（子模板「CMB-SH」）第2行：缺少账单日期、MerchantId',
    '文件「x.xlsx」（子模板「CMB-SH」）第3行：缺少 MerchantId（账单日期：2026-09-02）'
  ], 'Step2d.同一原文件行拆出的交易合并为一行，不占满上限');
  // 整列缺 MerchantId 的大批量：只为展示行保留诊断，总数仍准确
  const bulkRows = Object.assign([['BillDate', 'MerchantId', 'Currency', 'Credit Amount', 'Debit Amount']], { rowMetas: [] });
  for (let index = 0; index < 5000; index += 1) {
    bulkRows.push(['2026-09-01', '', 'USD', '1', '']);
    bulkRows.rowMetas.push({ sourceRowNumber: Math.floor(index / 2) + 2 });
  }
  const bulk = envD3.fns.inspectBalanceEntryRows([{ templateName: 'CMB-SH', fileName: 'x.xlsx', fileOrdinal: 1, detailRows: bulkRows }], 3);
  assertEq([bulk.issueCount, bulk.lines.length, bulk.lines[2]], [2500, 3, '文件「x.xlsx」（子模板「CMB-SH」）第4行：缺少 MerchantId（账单日期：2026-09-01）'],
    'Step2d.大批量缺字段按原文件行计数，只列出上限内的行');
  // 只有两种出余额方式、都只有收支为 0 的行：同样不启动余额生成
  const envD4 = createEnvironment(dir, 'step2d4');
  const ownerD4 = envD4.defineTemplate('招商银行-上海', 'A');
  const channelIdD4 = envD4.saveWithChannel(ownerD4, { mode: 'create' }).channelId;
  const childD4 = envD4.defineTemplate('CMB-SH', 'D', { balance: 'Bal' });
  envD4.saveWithChannel(childD4, { mode: 'join', channelId: channelIdD4 });
  const fileZeroA = path.join(dir, 'step2d4-a.xlsx');
  writeSource(fileZeroA, 'A', [['2026-09-01', 'M303', 'USD', '0', '']]);
  const resultD4 = envD4.generate([envD4.entryFor(ownerD4, fileZeroA), envD4.entryFor(childD4, fileZero)]);
  assertEq([resultD4 && resultD4.balance, (resultD4 ? resultD4.warnings : []).filter((warning) => /balance/.test(warning.type))], [null, []],
    'Step2d.两种出余额方式都只有收支为 0 的行时不生成余额、不报余额失败');
  assertEq(envD2.exportFiles(), [], 'Step2d.未映射 MerchantId 时不产出文件');

  // (e) 收支都为 0 的行不进明细与余额，不算命中该子模板；两个渠道各有冲突时一并列出
  const envE = createEnvironment(dir, 'step2e');
  const ownerE = envE.defineTemplate('招商银行-上海', 'A', { balance: '无' });
  const channelIdE = envE.saveWithChannel(ownerE, { mode: 'create' }).channelId;
  const childE = envE.defineTemplate('CMB-SH', 'D', { balance: 'Bal' });
  envE.saveWithChannel(childE, { mode: 'join', channelId: channelIdE });
  const ownerE2 = envE.defineTemplate('工商银行-北京', 'B', { balance: '无' });
  const channelIdE2 = envE.saveWithChannel(ownerE2, { mode: 'create' }).channelId;
  const childE2 = envE.defineTemplate('ICBC-BJ', 'E', { balance: 'Bl' });
  envE.saveWithChannel(childE2, { mode: 'join', channelId: channelIdE2 });
  const fileI = path.join(dir, 'step2e-a.xlsx');
  const fileJ = path.join(dir, 'step2e-b.xlsx');
  const fileK = path.join(dir, 'step2e-c.xlsx');
  const fileL = path.join(dir, 'step2e-d.xlsx');
  writeSource(fileI, 'A', [['2026-09-01', 'M401', 'USD', '0', '']]);
  writeSource(fileJ, 'D', [['2026-09-01', 'M401', 'USD', '3', '', '13']]);
  writeSource(fileK, 'B', [['2026-09-01', 'M501', 'CNY', '1', '']]);
  writeSource(fileL, 'E', [['2026-09-01', 'M501', 'CNY', '2', '', '12']]);
  const zeroOnlyGroups = envE.fns.groupStatementEntriesForGeneration([envE.entryFor(ownerE, fileI), envE.entryFor(childE, fileJ)]);
  assertEq(conflictLinesOf(envE, zeroOnlyGroups[0]), null, 'Step2e.收支都为 0 的行不算命中不出余额的子模板');
  // 收支同时有值的行照常参与判断（它会让生成报错，跳过它会放行冲突、让多组生成先写出前几组）
  const fileBoth = path.join(dir, 'step2e-both.xlsx');
  writeSource(fileBoth, 'A', [['2026-09-01', 'M401', 'USD', '2', '3']]);
  const bothGroups = envE.fns.groupStatementEntriesForGeneration([envE.entryFor(ownerE, fileBoth), envE.entryFor(childE, fileJ)]);
  assertEq(conflictLinesOf(envE, bothGroups[0]), ['账户 M401（USD）：招商银行-上海（不出余额）、CMB-SH（取账单余额列）'], 'Step2e.收支同时有值的行照常参与冲突判断');
  const entriesE = [envE.entryFor(ownerE, fileI), envE.entryFor(childE, fileJ), envE.entryFor(ownerE2, fileK), envE.entryFor(childE2, fileL)];
  const groupsE = envE.fns.groupStatementEntriesForGeneration(entriesE);
  const conflictGroupsE = envE.fns.collectGenerationGroupBalanceModeConflicts(groupsE);
  // groupKey：导入预检据此找出账号由注入改写的渠道（release 审查），不进入错误明细
  assertEq(conflictGroupsE, [{
    channelName: '工商银行-北京',
    lines: ['账户 M501（CNY）：工商银行-北京（不出余额）、ICBC-BJ（取账单余额列）'],
    accountCount: 1,
    templateNames: ['工商银行-北京', 'ICBC-BJ'],
    accountValues: ['M501'],
    groupKey: groupsE.find((group) => group.entries.includes(entriesE[2])).key
  }], 'Step2e.只有真实交易的冲突账户被列出');
  writeSource(fileI, 'A', [['2026-09-01', 'M401', 'USD', '1', '']]);
  const entriesE2 = [envE.entryFor(ownerE, fileI), envE.entryFor(childE, fileJ), envE.entryFor(ownerE2, fileK), envE.entryFor(childE2, fileL)];
  const expectedLinesE = [
    '渠道「招商银行-上海」账户 M401（USD）：招商银行-上海（不出余额）、CMB-SH（取账单余额列）',
    '渠道「工商银行-北京」账户 M501（CNY）：工商银行-北京（不出余额）、ICBC-BJ（取账单余额列）'
  ];
  const errorE = envE.fns.buildChannelBalanceModeMismatchError(
    envE.fns.collectGenerationGroupBalanceModeConflicts(envE.fns.groupStatementEntriesForGeneration(entriesE2))
  );
  assertEq([errorE.code, errorE.message.startsWith('渠道「招商银行-上海」、「工商银行-北京」下'), errorE.detailLines], ['CHANNEL_BALANCE_MODE_MISMATCH', true, expectedLinesE], 'Step2e.导入预检汇总两个渠道的冲突账户');
  // 落盘（错误报告、活动日志）只记渠道、冲突账户数与子模板，不含账号
  assertEq(errorE.persistedDetailLines, [
    '渠道「招商银行-上海」：1 个账户命中余额方式不同的子模板（招商银行-上海、CMB-SH）',
    '渠道「工商银行-北京」：1 个账户命中余额方式不同的子模板（工商银行-北京、ICBC-BJ）'
  ], 'Step2e.落盘明细不含账号');
  let thrownE = null;
  try {
    envE.generate(entriesE2);
  } catch (error) {
    thrownE = error;
  }
  assertEq(thrownE && thrownE.detailLines, expectedLinesE, 'Step2e.生成前兜底同样汇总两个渠道的冲突账户');
  assertEq(envE.exportFiles(), [], 'Step2e.不产出文件');
  // 补录后重算：同样汇总各渠道的冲突账户，在写出之前拦下
  const sessionE = {
    fileEntries: entriesE2.map((entry, index) => ({ ...entry, id: `entry-${index}` })),
    batches: [{ id: 'batch-1', entryIds: entriesE2.map((_entry, index) => `entry-${index}`) }],
    currentBatchId: 'batch-1'
  };
  let regenerateErrorE = null;
  try {
    envE.fns.planVirtualTemplateBalanceRegeneration(sessionE, 'current');
  } catch (error) {
    regenerateErrorE = error;
  }
  assertEq(regenerateErrorE && [regenerateErrorE.code, regenerateErrorE.detailLines], ['CHANNEL_BALANCE_MODE_MISMATCH', expectedLinesE], 'Step2e.补录重算汇总两个渠道的冲突账户');
  // 等待补录期间渠道首个子模板的映射失效（生成配置报错）：该渠道的冲突照常按会话中已映射的明细判断，与其他渠道一并列出
  const ownerEMappings = envE.exportMappingsByTemplateId.get(ownerE.id);
  envE.exportMappingsByTemplateId.set(ownerE.id, ownerEMappings.filter((mapping) => mapping.templateField !== 'BillDate'));
  const brokenGroupE = envE.fns.groupStatementEntriesForGeneration(entriesE2)[0];
  let brokenConfigErrorE = null;
  try {
    envE.fns.buildStatementGenerationConfig({
      template: brokenGroupE.templateConfig.template,
      mappings: brokenGroupE.templateConfig.exportMappings,
      orderedTargetFields: brokenGroupE.templateConfig.exportTargetFields,
      allowManagedMerchantWithoutSelection: true
    });
  } catch (error) {
    brokenConfigErrorE = error;
  }
  assertEq(brokenConfigErrorE && brokenConfigErrorE.message, '当前模板必须映射 BillDate 字段', 'Step2e.前提：该渠道的生成配置报错');
  let brokenMappingErrorE = null;
  try {
    envE.fns.planVirtualTemplateBalanceRegeneration(sessionE, 'current');
  } catch (error) {
    brokenMappingErrorE = error;
  }
  envE.exportMappingsByTemplateId.set(ownerE.id, ownerEMappings);
  assertEq(brokenMappingErrorE && [brokenMappingErrorE.code, brokenMappingErrorE.detailLines], ['CHANNEL_BALANCE_MODE_MISMATCH', expectedLinesE],
    'Step2e.补录重算：渠道首个子模板映射失效时，该渠道的冲突照常与其他渠道一并列出');
  // 夹在两个冲突渠道之间的渠道有交易缺 MerchantId：不遮住其他渠道的冲突，冲突优先、一次列全
  const ownerE3 = envE.defineTemplate('中国银行-广州', 'C', { balance: '无' });
  const channelIdE3 = envE.saveWithChannel(ownerE3, { mode: 'create' }).channelId;
  const childE3 = envE.defineTemplate('BOC-GZ', 'F', { merchant: '' });
  envE.saveWithChannel(childE3, { mode: 'join', channelId: channelIdE3 });
  const fileP = path.join(dir, 'step2e-e.xlsx');
  const fileQ = path.join(dir, 'step2e-f.xlsx');
  writeSource(fileP, 'C', [['2026-09-01', 'M801', 'USD', '1', '']]);
  writeSource(fileQ, 'F', [['2026-09-01', 'IGNORED', 'USD', '4', '']]);
  const incompleteEntries = [envE.entryFor(ownerE3, fileP), envE.entryFor(childE3, fileQ)];
  const entriesE3 = [entriesE2[0], entriesE2[1], ...incompleteEntries, entriesE2[2], entriesE2[3]];
  const sessionE3 = {
    fileEntries: entriesE3.map((entry, index) => ({ ...entry, id: `entry-${index}` })),
    batches: [{ id: 'batch-1', entryIds: entriesE3.map((_entry, index) => `entry-${index}`) }],
    currentBatchId: 'batch-1'
  };
  const planError = (run) => {
    try {
      run();
    } catch (error) {
      return error;
    }
    return null;
  };
  const regenerateErrorE3 = planError(() => envE.fns.planVirtualTemplateBalanceRegeneration(sessionE3, 'current'));
  assertEq(regenerateErrorE3 && [regenerateErrorE3.code, regenerateErrorE3.detailLines], ['CHANNEL_BALANCE_MODE_MISMATCH', expectedLinesE],
    'Step2e.补录重算：缺字段的渠道不遮住前后两个渠道的冲突');
  const generateErrorE3 = planError(() => envE.generate(entriesE3));
  assertEq(generateErrorE3 && [generateErrorE3.code, generateErrorE3.detailLines], ['CHANNEL_BALANCE_MODE_MISMATCH', expectedLinesE],
    'Step2e.导入多组生成：缺字段的渠道不遮住前后两个渠道的冲突');
  // 没有冲突时，各渠道缺字段的行一并列出
  const incompleteError = planError(() => envE.fns.planVirtualTemplateBalanceRegeneration({
    fileEntries: incompleteEntries.map((entry, index) => ({ ...entry, id: `entry-${index}` })),
    batches: [{ id: 'batch-1', entryIds: ['entry-0', 'entry-1'] }],
    currentBatchId: 'batch-1'
  }, 'current'));
  assertEq(incompleteError && [incompleteError.code, incompleteError.detailLines, incompleteError.persistedDetailLines], [
    'CHANNEL_BALANCE_ROWS_INCOMPLETE',
    ['文件「step2e-f.xlsx」（子模板「BOC-GZ」）第2行：缺少 MerchantId（账单日期：2026-09-01）'],
    ['本组第2个文件（子模板「BOC-GZ」）第2行：缺少 MerchantId（账单日期：2026-09-01）']
  ], 'Step2e.补录重算：缺字段的行逐行列出，落盘写文件序号');
  // 等待补录期间该渠道首个子模板的映射失效（生成配置报错）：缺字段的行照常按会话明细列出，不只报映射错误
  const ownerE3Mappings = envE.exportMappingsByTemplateId.get(ownerE3.id);
  envE.exportMappingsByTemplateId.set(ownerE3.id, ownerE3Mappings.filter((mapping) => mapping.templateField !== 'BillDate'));
  const brokenIncompleteGroup = envE.fns.groupStatementEntriesForGeneration(incompleteEntries)[0];
  const brokenIncompleteConfigError = planError(() => envE.fns.buildStatementGenerationConfig({
    template: brokenIncompleteGroup.templateConfig.template,
    mappings: brokenIncompleteGroup.templateConfig.exportMappings,
    orderedTargetFields: brokenIncompleteGroup.templateConfig.exportTargetFields,
    allowManagedMerchantWithoutSelection: true
  }));
  const brokenIncompleteError = planError(() => envE.fns.planVirtualTemplateBalanceRegeneration({
    fileEntries: incompleteEntries.map((entry, index) => ({ ...entry, id: `entry-${index}` })),
    batches: [{ id: 'batch-1', entryIds: ['entry-0', 'entry-1'] }],
    currentBatchId: 'batch-1'
  }, 'current'));
  envE.exportMappingsByTemplateId.set(ownerE3.id, ownerE3Mappings);
  assertEq([
    brokenIncompleteConfigError && brokenIncompleteConfigError.message,
    brokenIncompleteError && brokenIncompleteError.code,
    brokenIncompleteError && brokenIncompleteError.detailLines
  ], [
    '当前模板必须映射 BillDate 字段',
    'CHANNEL_BALANCE_ROWS_INCOMPLETE',
    ['文件「step2e-f.xlsx」（子模板「BOC-GZ」）第2行：缺少 MerchantId（账单日期：2026-09-01）']
  ], 'Step2e.补录重算：渠道首个子模板映射失效时，缺字段的行照常按会话明细列出');
  // 多组规划时整批共用逐行诊断额度：额度用完后只计数，不再构造逐行明细
  const incompleteGroup = envE.fns.groupStatementEntriesForGeneration(incompleteEntries)[0];
  const incompleteConfig = envE.fns.buildStatementGenerationConfig({
    template: incompleteGroup.templateConfig.template,
    mappings: incompleteGroup.templateConfig.exportMappings,
    orderedTargetFields: incompleteGroup.templateConfig.exportTargetFields,
    allowManagedMerchantWithoutSelection: true
  });
  const budgetLeft = { remaining: 5 };
  const withBudget = planError(() => envE.fns.resolveEntryBalancePlan({ config: incompleteConfig, fileEntries: incompleteEntries, issueLineBudget: budgetLeft }));
  const budgetUsedUp = { remaining: 0 };
  const exhausted = planError(() => envE.fns.resolveEntryBalancePlan({ config: incompleteConfig, fileEntries: incompleteEntries, issueLineBudget: budgetUsedUp }));
  assertEq([withBudget && withBudget.detailLines.length, budgetLeft.remaining, exhausted && exhausted.code, exhausted && exhausted.detailLines, budgetUsedUp.remaining], [
    1, 4, 'CHANNEL_BALANCE_ROWS_INCOMPLETE', ['另有 1 行交易缺少账单日期或 MerchantId，未逐行列出（共 1 行）'], 0
  ], 'Step2e.整批共用逐行诊断额度，用完后只计数');
  assertEq(envE.exportFiles(), [], 'Step2e.以上各情形都不产出文件');

  // (f) 账号注入后才确定的冲突（直接生成时自动确定大账号）：多大账号子模板的行注入前没有账号，注入后才与另一子模板同账户。
  //   只把余额方式不同的渠道组的条目交给注入，无关文件不重建
  const envF = createEnvironment(dir, 'step2f');
  const ownerF = envF.defineTemplate('招商银行-上海', 'A', { balance: '无', merchant: `${FIXED}M601` });
  const channelIdF = envF.saveWithChannel(ownerF, { mode: 'create' }).channelId;
  const childF = envF.defineTemplate('CMB-SH', 'D', { balance: 'Bal', merchant: `${FIXED}${MULTI}` });
  envF.saveWithChannel(childF, { mode: 'join', channelId: channelIdF });
  const plainF = envF.defineTemplate('工商银行-北京', 'B');
  const fileM = path.join(dir, 'step2f-a.xlsx');
  const fileN = path.join(dir, 'step2f-b.xlsx');
  const fileO = path.join(dir, 'step2f-c.xlsx');
  writeSource(fileM, 'A', [['2026-09-01', 'IGNORED', 'USD', '1', '']]);
  writeSource(fileN, 'D', [['2026-09-01', 'IGNORED', 'USD', '2', '', '12']]);
  writeSource(fileO, 'B', [['2026-09-01', 'M701', 'USD', '3', '']]);
  const entriesF = [envF.entryFor(ownerF, fileM), envF.entryFor(childF, fileN), envF.entryFor(plainF, fileO)];
  const selectedF = { merchantId: 'M601', currency: 'USD' };
  assertEq(envF.fns.collectGenerationGroupBalanceModeConflicts(envF.fns.groupStatementEntriesForGeneration(entriesF)), null,
    'Step2f.注入前多大账号子模板的行没有账号，导入预检放行');
  // 导入预检时记下余额方式不同的渠道组的条目位置，复核只看这些条目（普通模板的文件不分组、不读配置）
  const mixedIndexesF = envF.fns.listBalanceModeMixedEntryIndexes(envF.fns.groupStatementEntriesForGeneration(entriesF), entriesF);
  assertEq(mixedIndexesF, [0, 1], 'Step2f.记下余额方式不同的渠道组的条目位置');
  // 导入预检的冲突检查时顺带记下（不再重新解析各子模板的余额方式）
  const recordedMixedF = new Set();
  envF.fns.collectGenerationGroupBalanceModeConflicts(envF.fns.groupStatementEntriesForGeneration(entriesF), recordedMixedF);
  assertEq(envF.fns.listBalanceModeMixedEntryIndexes(null, entriesF, recordedMixedF), [0, 1], 'Step2f.冲突检查时顺带记下混合渠道的条目');
  const mixedEntriesF = mixedIndexesF.map((index) => entriesF[index]);
  const resolvedBatches = [];
  const conflictsF = envF.fns.findResolvedEntriesBalanceModeConflicts(mixedEntriesF, (mixedEntries) => {
    resolvedBatches.push(mixedEntries.map((entry) => path.basename(entry.filePath)));
    return envF.fns.rebuildMatchedTemplateFileEntries({
      fileEntries: mixedEntries,
      fallbackTemplateConfig: envF.getTemplateMappingConfig(ownerF.id),
      selectedBigAccount: selectedF,
      reuseMappedRows: true
    });
  });
  assertEq(resolvedBatches, [['step2f-a.xlsx', 'step2f-b.xlsx']], 'Step2f.只注入余额方式不同的渠道组的条目');
  // 直接生成：只有 MerchantId 取所选大账号的条目需要注入，其余条目沿用原行
  const usesSelected = (entry) => envF.fns.entryUsesSelectedBigAccount(entry, envF.getTemplateMappingConfig(ownerF.id));
  resolvedBatches.length = 0;
  const predicateConflicts = envF.fns.findResolvedEntriesBalanceModeConflicts(mixedEntriesF, (pendingEntries) => {
    resolvedBatches.push(pendingEntries.map((entry) => path.basename(entry.filePath)));
    return envF.fns.rebuildMatchedTemplateFileEntries({
      fileEntries: pendingEntries,
      fallbackTemplateConfig: envF.getTemplateMappingConfig(ownerF.id),
      selectedBigAccount: selectedF,
      reuseMappedRows: true
    });
  }, usesSelected);
  assertEq([resolvedBatches, predicateConflicts && predicateConflicts.map((item) => item.lines)], [
    [['step2f-b.xlsx']],
    [['账户 M601（USD）：招商银行-上海（不出余额）、CMB-SH（取账单余额列）']]
  ], 'Step2f.直接生成只注入取所选大账号的条目，仍判断出冲突');
  let predicateCalls = 0;
  assertEq([envF.fns.findResolvedEntriesBalanceModeConflicts(mixedEntriesF, () => { predicateCalls += 1; return []; }, () => false), predicateCalls], [null, 0],
    'Step2f.混合渠道里没有需要注入的条目时不重建');
  assertEq(conflictsF && conflictsF.map((item) => [item.channelName, item.lines]), [
    ['招商银行-上海', ['账户 M601（USD）：招商银行-上海（不出余额）、CMB-SH（取账单余额列）']]
  ], 'Step2f.按注入后的账号判断出冲突');
  let thrownF = null;
  try {
    envF.generate(entriesF, selectedF);
  } catch (error) {
    thrownF = error;
  }
  assertEq(thrownF && thrownF.code, 'CHANNEL_BALANCE_MODE_MISMATCH', 'Step2f.生成前兜底同样阻断');
  assertEq(envF.exportFiles(), [], 'Step2f.不产出文件');
  // 没有余额方式不同的渠道组时不调用注入
  let resolveCalls = 0;
  const plainOnly = [envF.entryFor(plainF, fileO)];
  const plainMixedIndexes = envF.fns.listBalanceModeMixedEntryIndexes(envF.fns.groupStatementEntriesForGeneration(plainOnly), plainOnly);
  assertEq([plainMixedIndexes, envF.fns.findResolvedEntriesBalanceModeConflicts(plainMixedIndexes.map((index) => plainOnly[index]), (mixedEntries) => { resolveCalls += 1; return mixedEntries; }), resolveCalls], [[], null, 0],
    'Step2f.没有余额方式不同的渠道组时不重建条目');
  // 从整批注入结果按位置取子集（查重时两项检查共用整批结果）
  assertEq(envF.fns.pickResolvedEntries(entriesF, ['a', 'b', 'c'], [entriesF[2], entriesF[0]]), ['c', 'a'], 'Step2f.按位置取出子集对应的注入结果');
  assertTrue(importChecksPrecedeGeneration(), 'Step2.导入入口在大账号选择与生成之前完成渠道校验');
}

// (g) 真实导入入口（按文件名映射）的预检：只维护一个大账号时自动确定，注入后才发现同一账户命中余额方式不同的子模板。
//   预检阶段按“未开始”拒绝：返回逐账户明细与 preservesSession，不清除上一批的导出与补录入口、不暂存大账号选择、不进入执行
async function verifyDirectImportRejectsInjectedConflict(dir) {
  const env = createEnvironment(dir, 'step2g');
  const owner = env.defineTemplate('招商银行-上海', 'A', { balance: '无', merchant: `${FIXED}M601` });
  const channelId = env.saveWithChannel(owner, { mode: 'create' }).channelId;
  const child = env.defineTemplate('CMB-SH', 'D', { balance: 'Bal', merchant: `${FIXED}${MULTI}` });
  env.saveWithChannel(child, { mode: 'join', channelId });
  const fileA = path.join(dir, 'step2g-a.xlsx');
  const fileB = path.join(dir, 'step2g-b.xlsx');
  writeSource(fileA, 'A', [['2026-09-01', 'IGNORED', 'USD', '1', '']]);
  // 多大账号子模板的文件在表头上方写明所维护的账号（直接生成时据此识别），MerchantId 取所选大账号
  const workbookB = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbookB, XLSX.utils.aoa_to_sheet([
    ['账号', 'M601'],
    [],
    LAYOUTS.D.headers,
    ['2026-09-01', 'IGNORED', 'USD', '2', '', '12']
  ]), 'Sheet1');
  XLSX.writeFile(workbookB, fileB);
  const runPreview = async () => {
    const sideEffects = [];
    const record = (name) => () => {
      sideEffects.push(name);
    };
    const handler = loadMainEntry('handleFilenameMappingImport', {
      ...env.mainDeps,
      ...env.fns,
      fileImportInProgress: false,
      getEnumConfig: () => ({}),
      getStatementChannelMigrationPendingMessage: () => null,
      clearPendingManualBalancePrompt: record('clearPendingManualBalancePrompt'),
      clearPendingBigAccountSelection: record('clearPendingBigAccountSelection'),
      clearGeneratedExports: record('clearGeneratedExports'),
      statementDuplicateReview: { clear: record('statementDuplicateReview.clear') },
      executeFilenameMappingImportPlan: record('executeFilenameMappingImportPlan'),
      stagePendingBigAccountSelection: record('stagePendingBigAccountSelection'),
      createErrorResult: (payload) => ({ status: 'error', ...payload }),
      appendActivityLogEntry: () => {}
    });
    const prepared = { previewOnly: true, inputFilePaths: [fileA, fileB], selectionResult: { filePaths: [fileA, fileB] } };
    const result = await handler(prepared);
    return { result, sideEffects, prepared };
  };
  // 对照：没有维护大账号时不自动确定账号，注入前的行没有账号，预检放行（步骤 3.5 判断不出这类冲突）
  const control = await runPreview();
  assertEq([control.result && control.result.status, control.sideEffects], ['statement-import-preview-ready', []],
    'Step2g.对照：未自动确定大账号时预检放行');
  env.bigAccountsByTemplateId.set(child.id, [{ merchantId: 'M601', currencies: ['USD'] }]);
  const { result, sideEffects, prepared } = await runPreview();
  assertEq([result && result.errorCode, result && result.detailLines, result && result.preservesSession], [
    'CHANNEL_BALANCE_MODE_MISMATCH',
    ['账户 M601（USD）：招商银行-上海（不出余额）、CMB-SH（取账单余额列）'],
    true
  ], 'Step2g.自动确定唯一大账号后按注入的账号判断出冲突，按未开始拒绝');
  assertEq([sideEffects, prepared.statementImportPlan], [[], undefined],
    'Step2g.预检拒绝时不清除上一批的导出与补录入口、不暂存大账号选择、不进入执行');
  assertEq(env.exportFiles(), [], 'Step2g.不产出文件');
}

// (h) 真实的完成大账号选择：导入预检进入选择并暂存上下文后，提交的分配让多大账号子模板与另一子模板同账户、余额方式不同时，
//   prepare 按未开始拒绝（逐账户明细、preservesSession、清除选择上下文，不进入执行）；分配其他账号时照常放行
async function verifyBigAccountCompletionRejectsInjectedConflict(dir) {
  const env = createEnvironment(dir, 'step2h');
  const owner = env.defineTemplate('招商银行-上海', 'A', { balance: '无', merchant: `${FIXED}M601` });
  const channelId = env.saveWithChannel(owner, { mode: 'create' }).channelId;
  const child = env.defineTemplate('CMB-SH', 'D', { balance: 'Bal', merchant: `${FIXED}${MULTI}` });
  env.saveWithChannel(child, { mode: 'join', channelId });
  env.bigAccountsByTemplateId.set(child.id, [{ merchantId: 'M601', currencies: ['USD'] }, { merchantId: 'M602', currencies: ['USD'] }]);
  const fileA = path.join(dir, 'step2h-a.xlsx');
  const fileB = path.join(dir, 'step2h-b.xlsx');
  writeSource(fileA, 'A', [['2026-09-01', 'IGNORED', 'USD', '1', '']]);
  writeSource(fileB, 'D', [['2026-09-01', 'IGNORED', 'USD', '2', '', '12']]);
  const runCompletion = async (merchantId) => {
    const sideEffects = [];
    const record = (name) => () => {
      sideEffects.push(name);
    };
    const scope = createMainScope({
      ...env.mainDeps,
      ...env.fns,
      fileImportInProgress: false,
      lastPendingBigAccountSelection: null,
      getEnumConfig: () => ({}),
      getStatementChannelMigrationPendingMessage: () => null,
      clearPendingManualBalancePrompt: record('clearPendingManualBalancePrompt'),
      clearGeneratedExports: record('clearGeneratedExports'),
      statementDuplicateReview: { clear: record('statementDuplicateReview.clear'), cancel: record('statementDuplicateReview.cancel') },
      executeFilenameMappingImportPlan: record('executeFilenameMappingImportPlan'),
      readBigAccountMode: () => null,
      readBigAccountOrder: () => null,
      ensureStorageRoot: () => env.storageRoot,
      createErrorResult: (payload) => ({ status: 'error', ...payload }),
      appendActivityLogEntry: () => {}
    });
    // 导入预检：两个大账号，进入选择并暂存上下文（与导入入口的 prepare 一样记下）
    const prepared = { previewOnly: true, inputFilePaths: [fileA, fileB], selectionResult: { filePaths: [fileA, fileB] } };
    const preview = await scope.handleFilenameMappingImport(prepared);
    const contextId = prepared.pendingBigAccountSelection
      ? scope.rememberPendingBigAccountSelection(prepared.pendingBigAccountSelection)
      : '';
    const rows = prepared.pendingBigAccountSelection ? prepared.pendingBigAccountSelection.rows : [];
    const handler = scope.nested('completeBigAccountSelectionHandler');
    // 与注册时一样：预检被拒绝时标记未开始（见 markContinuationPrepareRejection）
    const outcome = scope.markContinuationPrepareRejection(await handler.prepare(null, {
      contextId,
      mode: 'unfixed',
      // 子模板 A 的块分配它自己的账号，多大账号子模板的块分配本次的账号
      assignments: rows.map((row) => ({ index: row.index, merchantId: row.filePath === fileA ? 'M601' : merchantId, currency: 'USD' }))
    }), { keepErrorCodes: ['BIG_ACCOUNT_SELECTION_INVALID'] });
    return { preview, rows, outcome, sideEffects, pendingAfter: scope.lastPendingBigAccountSelection };
  };
  const rejected = await runCompletion('M601');
  assertEq([rejected.preview && rejected.preview.status, rejected.rows.length > 0], ['select-big-account', true],
    'Step2h.前提：两个大账号时导入预检进入选择');
  assertEq([
    rejected.outcome.proceed,
    rejected.outcome.result && rejected.outcome.result.errorCode,
    rejected.outcome.result && rejected.outcome.result.detailLines,
    rejected.outcome.result && rejected.outcome.result.preservesSession
  ], [false, 'CHANNEL_BALANCE_MODE_MISMATCH', ['账户 M601（USD）：招商银行-上海（不出余额）、CMB-SH（取账单余额列）'], true],
  'Step2h.分配的账号与另一子模板同账户、余额方式不同时按未开始拒绝');
  assertEq([rejected.pendingAfter, rejected.sideEffects], [null, []], 'Step2h.拒绝时清除选择上下文，不进入执行、不清除上一批');
  const allowed = await runCompletion('M602');
  assertEq([allowed.outcome.proceed, allowed.outcome.result], [true, undefined], 'Step2h.对照：分配其他账号时照常放行');
  assertEq(env.exportFiles(), [], 'Step2h.预检不产出文件');
}

// (i) release 审查：进入大账号选择时，各账号块的账号、币种都由用户的选择覆盖。原行中余额方式不同的两个子模板暂时是同一账户时，
//   预检不按原行拒绝（进入选择），完成选择后按分配结果判断：两边分到不同账号时放行，分到同一账号时按未开始拒绝
async function verifyBigAccountSelectionDefersProvisionalConflict(dir) {
  const env = createEnvironment(dir, 'step2i');
  const owner = env.defineTemplate('招商银行-上海', 'A', { balance: '无' });
  const channelId = env.saveWithChannel(owner, { mode: 'create' }).channelId;
  const child = env.defineTemplate('CMB-SH', 'D', { balance: 'Bal' });
  env.saveWithChannel(child, { mode: 'join', channelId });
  env.bigAccountsByTemplateId.set(child.id, [{ merchantId: 'M601', currencies: ['USD'] }, { merchantId: 'M602', currencies: ['USD'] }]);
  const fileA = path.join(dir, 'step2i-a.xlsx');
  const fileB = path.join(dir, 'step2i-b.xlsx');
  // 原行两边都是 M601：按原行判断是冲突
  writeSource(fileA, 'A', [['2026-09-01', 'M601', 'USD', '1', '']]);
  writeSource(fileB, 'D', [['2026-09-01', 'M601', 'USD', '2', '', '12']]);
  const runCompletion = async (childMerchantId) => {
    const sideEffects = [];
    const record = (name) => () => {
      sideEffects.push(name);
    };
    const scope = createMainScope({
      ...env.mainDeps,
      ...env.fns,
      fileImportInProgress: false,
      lastPendingBigAccountSelection: null,
      getEnumConfig: () => ({}),
      getStatementChannelMigrationPendingMessage: () => null,
      clearPendingManualBalancePrompt: record('clearPendingManualBalancePrompt'),
      clearGeneratedExports: record('clearGeneratedExports'),
      statementDuplicateReview: { clear: record('statementDuplicateReview.clear'), cancel: record('statementDuplicateReview.cancel') },
      executeFilenameMappingImportPlan: record('executeFilenameMappingImportPlan'),
      readBigAccountMode: () => null,
      readBigAccountOrder: () => null,
      ensureStorageRoot: () => env.storageRoot,
      createErrorResult: (payload) => ({ status: 'error', ...payload }),
      appendActivityLogEntry: () => {}
    });
    const prepared = { previewOnly: true, inputFilePaths: [fileA, fileB], selectionResult: { filePaths: [fileA, fileB] } };
    const preview = await scope.handleFilenameMappingImport(prepared);
    const contextId = prepared.pendingBigAccountSelection
      ? scope.rememberPendingBigAccountSelection(prepared.pendingBigAccountSelection)
      : '';
    const rows = prepared.pendingBigAccountSelection ? prepared.pendingBigAccountSelection.rows : [];
    if (!contextId) return { preview, rows, outcome: null };
    const handler = scope.nested('completeBigAccountSelectionHandler');
    const outcome = scope.markContinuationPrepareRejection(await handler.prepare(null, {
      contextId,
      mode: 'unfixed',
      assignments: rows.map((row) => ({ index: row.index, merchantId: row.filePath === fileA ? 'M601' : childMerchantId, currency: 'USD' }))
    }), { keepErrorCodes: ['BIG_ACCOUNT_SELECTION_INVALID'] });
    return { preview, rows, outcome };
  };
  const allowed = await runCompletion('M602');
  assertEq([allowed.preview && allowed.preview.status, allowed.preview && allowed.preview.errorCode, allowed.rows.length], ['select-big-account', undefined, 2],
    'Step2i.原行同账户、余额方式不同，但会进入大账号选择：预检不按原行拒绝');
  assertEq([allowed.outcome && allowed.outcome.proceed, allowed.outcome && allowed.outcome.result], [true, undefined],
    'Step2i.两边分到不同账号时放行');
  const rejected = await runCompletion('M601');
  assertEq([
    rejected.outcome && rejected.outcome.proceed,
    rejected.outcome && rejected.outcome.result && rejected.outcome.result.errorCode,
    rejected.outcome && rejected.outcome.result && rejected.outcome.result.detailLines
  ], [false, 'CHANNEL_BALANCE_MODE_MISMATCH', ['账户 M601（USD）：招商银行-上海（不出余额）、CMB-SH（取账单余额列）']],
  'Step2i.两边分到同一账号时按分配结果拒绝');
  // 对照：渠道只有一个大账号、不进入选择时，按原行的冲突照常在预检拒绝
  env.bigAccountsByTemplateId.set(child.id, [{ merchantId: 'M601', currencies: ['USD'] }]);
  const single = await runCompletion('M601');
  assertEq([single.preview && single.preview.errorCode, single.rows.length], ['CHANNEL_BALANCE_MODE_MISMATCH', 0],
    'Step2i.对照：不进入大账号选择时按原行的冲突在预检拒绝');
  assertEq(env.exportFiles(), [], 'Step2i.预检不产出文件');
}

// (j) release 审查：自动确定唯一大账号时，含要注入账号的条目的渠道，原行的账号会被注入改写（如拆分映射暂时从源列读出的账号），
//   不按原行拒绝，只按注入后的条目判断：注入后分属不同账户时放行，同一账户时拒绝。这里以桩标出子模板的条目要注入账号、
//   注入时把它的 MerchantId 改为所选大账号（真实的拆分映射注入见 statement-currency-big-account），其余走真实的导入预检
async function verifyAutoBigAccountUsesInjectedRows(dir) {
  const env = createEnvironment(dir, 'step2j');
  const owner = env.defineTemplate('招商银行-上海', 'A', { balance: '无' });
  const channelId = env.saveWithChannel(owner, { mode: 'create' }).channelId;
  const child = env.defineTemplate('CMB-SH', 'D', { balance: 'Bal' });
  env.saveWithChannel(child, { mode: 'join', channelId });
  const fileA = path.join(dir, 'step2j-a.xlsx');
  const fileB = path.join(dir, 'step2j-b.xlsx');
  // 原行两边都是 M601：按原行判断是冲突
  writeSource(fileA, 'A', [['2026-09-01', 'M601', 'USD', '1', '']]);
  writeSource(fileB, 'D', [['2026-09-01', 'M601', 'USD', '2', '', '12']]);
  const injectMerchant = (entry, merchantId) => {
    const header = entry.detailRows[0];
    const merchantIndex = header.indexOf('MerchantId');
    const detailRows = [header, ...entry.detailRows.slice(1).map((row) => row.map((cell, index) => (index === merchantIndex ? merchantId : cell)))];
    detailRows.rowMetas = entry.detailRows.rowMetas;
    return { ...entry, detailRows };
  };
  const runPreview = async (bigAccount) => {
    env.bigAccountsByTemplateId.set(child.id, [{ merchantId: bigAccount, currencies: ['USD'] }]);
    const scope = createMainScope({
      ...env.mainDeps,
      ...env.fns,
      fileImportInProgress: false,
      lastPendingBigAccountSelection: null,
      getEnumConfig: () => ({}),
      getStatementChannelMigrationPendingMessage: () => null,
      clearPendingManualBalancePrompt: () => {},
      clearGeneratedExports: () => {},
      statementDuplicateReview: { clear: () => {}, cancel: () => {} },
      executeFilenameMappingImportPlan: () => {},
      readBigAccountMode: () => null,
      readBigAccountOrder: () => null,
      ensureStorageRoot: () => env.storageRoot,
      createErrorResult: (payload) => ({ status: 'error', ...payload }),
      appendActivityLogEntry: () => {},
      entryUsesSelectedBigAccount: (entry) => entry.matchedTemplateId === child.id,
      resolveFilenameMappingFinalEntries: (plan) => plan.trimmedProvisionalEntries.map((entry) => (
        entry.matchedTemplateId === child.id ? injectMerchant(entry, plan.selectedBigAccount.merchantId) : entry
      ))
    });
    const prepared = { previewOnly: true, inputFilePaths: [fileA, fileB], selectionResult: { filePaths: [fileA, fileB] } };
    return scope.handleFilenameMappingImport(prepared);
  };
  const allowed = await runPreview('M602');
  assertEq([allowed && allowed.status, allowed && allowed.errorCode], ['statement-import-preview-ready', undefined],
    'Step2j.原行同账户、但注入后分属不同账户时按注入后的条目判断，放行');
  const rejected = await runPreview('M601');
  assertEq([rejected && rejected.errorCode, rejected && rejected.detailLines], [
    'CHANNEL_BALANCE_MODE_MISMATCH',
    ['账户 M601（USD）：招商银行-上海（不出余额）、CMB-SH（取账单余额列）']
  ], 'Step2j.注入后仍是同一账户时按注入后的条目拒绝（只列一次）');
  assertEq(env.exportFiles(), [], 'Step2j.预检不产出文件');
}

// 导入入口：渠道校验（余额方式、待处理冲突）位于大账号聚合与生成之前。
function importChecksPrecedeGeneration() {
  const node = MAIN_AST.body.find((item) => item.type === 'FunctionDeclaration' && item.id && item.id.name === 'handleFilenameMappingImport');
  const body = MAIN_SOURCE.slice(node.start, node.end);
  const check = body.indexOf('collectGenerationGroupBalanceModeConflicts(importGenerationGroups,');
  const conflict = body.indexOf("'CHANNEL_ACCOUNT_MAPPING_CONFLICT_PENDING'");
  const aggregate = body.indexOf('const aggregatedBigAccounts = [];');
  const generateCall = body.indexOf('executeFilenameMappingImportPlan(');
  const selection = body.indexOf('stagePendingBigAccountSelection(');
  return check > 0 && conflict > check && aggregate > conflict && selection > aggregate && generateCall < check;
}

// ③
function verifyMixedGroups(dir) {
  const env = createEnvironment(dir, 'step3');
  const owner = env.defineTemplate('招商银行-上海', 'A');
  const channelId = env.saveWithChannel(owner, { mode: 'create' }).channelId;
  const child = env.defineTemplate('CMB-SH', 'B');
  env.saveWithChannel(child, { mode: 'join', channelId });
  const normal = env.defineTemplate('工行-深圳', 'C');
  seed(env, '招商银行-上海', 'M001', 'USD', '2026-08-31', 1000);
  seed(env, '工行-深圳', 'M201', 'USD', '2026-08-31', 500);
  const fileA = path.join(dir, 'step3-a.xlsx');
  const fileB = path.join(dir, 'step3-b.xlsx');
  const fileC = path.join(dir, 'step3-c.xlsx');
  writeSource(fileA, 'A', [['2026-09-01', 'M001', 'USD', '10', '']]);
  writeSource(fileB, 'B', [['2026-09-02', 'M001', 'USD', '5', '']]);
  writeSource(fileC, 'C', [['2026-09-01', 'M201', 'USD', '1', '']]);
  const result = env.generate([env.entryFor(owner, fileA), env.entryFor(normal, fileC), env.entryFor(child, fileB)]);
  assertEq([result.detail.fileName, result.balance.fileName], ['2-COMMON-2026-09-01~2026-09-02.xlsx', '2-BALANCE-2026-09-01~2026-09-02.xlsx'], 'Step3.汇总文件名按渠道计一组');
  assertEq(readBalanceRows(result.balance.filePath).map((row) => [row[0], row[2], row[4], row[5]]).sort(), [
    ['工行', 'M201', '2026-09-01', 501],
    ['招商银行', 'M001', '2026-09-01', 1010],
    ['招商银行', 'M001', '2026-09-02', 1015]
  ].sort(), 'Step3.回读余额汇总：渠道组与普通模板各自出余额');
  assertEq(readDetailColumns(result.detail.filePath, ['Channel']).map((row) => row[0]).sort(), ['工行', '招商银行', '招商银行'], 'Step3.明细 Channel 列分别取渠道与普通模板');
}

// ④
function verifyCalculatedSeedAndGap(dir) {
  const env = createEnvironment(dir, 'step4');
  const owner = env.defineTemplate('招商银行-上海', 'A');
  const channelId = env.saveWithChannel(owner, { mode: 'create' }).channelId;
  const child = env.defineTemplate('CMB-SH', 'B');
  env.saveWithChannel(child, { mode: 'join', channelId });
  const fileA = path.join(dir, 'step4-a.xlsx');
  const fileB = path.join(dir, 'step4-b.xlsx');
  writeSource(fileA, 'A', [['2026-09-01', 'M001', 'USD', '10', '']]);
  writeSource(fileB, 'B', [['2026-09-04', 'M001', 'USD', '5', '']]);
  const entries = [env.entryFor(owner, fileA), env.entryFor(child, fileB)];

  const first = env.generate(entries);
  const prompts = first.warnings.filter((warning) => warning.type === 'balance-seed-required');
  assertEq(prompts.map((warning) => [warning.prompt.templateName, warning.prompt.bankName, warning.prompt.merchantId, warning.prompt.queueTotal]), [
    ['招商银行-上海', '招商银行', 'M001', 1]
  ], 'Step4.首次补录按渠道只提示一次，提示用渠道名');
  const plan = buildManualBalanceSeedPlan({
    payload: { billDate: '2026-08-31', endBalance: '100' },
    pendingPrompt: prompts[0].prompt,
    importContext: { template: env.database.getTemplate(child.id) },
    storageRoot: env.storageRoot
  });
  assertEq(plan.stopResult, undefined, 'Step4.补录计划有效');
  assertEq(plan.plan && plan.plan.bankName, '招商银行', 'Step4.补录种子写入渠道银行段');
  writeManualBalanceSeedPlan(plan.plan);

  const second = env.generate(entries);
  const gaps = second.warnings.find((warning) => warning.type === 'balance-gap-confirm')?.gaps || [];
  assertEq(gaps.map((gap) => [gap.templateName, gap.merchantId, gap.anchorDate, gap.targetBillDate]), [
    ['招商银行-上海', 'M001', '2026-09-01', '2026-09-04']
  ], 'Step4.跨两个子模板文件的断档按渠道一次判定');
  env.acknowledgedKeys.add(gaps[0].key);
  const third = env.generate(entries);
  assertEq(readBalanceRows(third.balance.filePath).map((row) => [row[4], row[5]]), [['2026-09-01', 110], ['2026-09-04', 115]], 'Step4.不补录后接着断档前余额');

  // 预检兜底：无提示时按导入上下文模板的渠道名取银行段
  const fallback = buildManualBalanceSeedPlan({
    payload: { billDate: '2026-08-30', endBalance: '1' },
    pendingPrompt: { merchantId: 'M001', currency: 'USD' },
    importContext: { template: env.database.getTemplate(child.id) },
    storageRoot: env.storageRoot
  });
  assertEq(fallback.plan && [fallback.plan.bankName, fallback.plan.record.templateName], ['招商银行', '招商银行-上海'], 'Step4.补录兜底按子模板所属渠道');
}

// ⑤
function verifyLegacyMigration(dir) {
  const env = createEnvironment(dir, 'step5');
  const owner = env.defineTemplate('招商银行-上海', 'A');
  const child = env.defineTemplate('CMB-SH', 'B');
  const raw = env.database.db;
  raw.prepare('UPDATE templates SET is_parent = 1 WHERE id = ?').run(owner.id);
  raw.prepare('UPDATE templates SET parent_template_id = ? WHERE id = ?').run(owner.id, child.id);
  env.database.saveAccountMappings({ templateId: owner.id }, [{ bankAccountId: 'RAW001', clearingAccountId: 'M001' }]);
  env.database.saveAccountMappings({ templateId: child.id }, [{ bankAccountId: 'RAW001', clearingAccountId: 'M001' }]);
  const migration = env.database.runStatementChannelMigration();
  assertEq([migration.status, migration.channelCount, migration.conflictCount], ['migrated', 1, 0], 'Step5.旧主/子数据迁移为渠道');
  seed(env, '招商银行-上海', 'M001', 'USD', '2026-08-31', 1000);
  const { fileA, fileB } = prepareChannelFiles(dir, 'step5');
  const result = env.generate([
    env.entryFor(env.database.getTemplate(owner.id), fileA),
    env.entryFor(env.database.getTemplate(child.id), fileB)
  ]);
  verifyChannelOutput(env, result, 'Step5');
}

// ⑥
function verifyMixedMerchantMappings(dir) {
  const env = createEnvironment(dir, 'step6');
  const owner = env.defineTemplate('招商银行-上海', 'A', { merchant: `${FIXED}M009` });
  const channelId = env.saveWithChannel(owner, { mode: 'create' }).channelId;
  const child = env.defineTemplate('CMB-SH', 'B', { merchant: `${FIXED}${MULTI}` });
  env.saveWithChannel(child, { mode: 'join', channelId });
  seed(env, '招商银行-上海', 'M009', 'USD', '2026-08-31', 100);
  seed(env, '招商银行-上海', 'M777', 'USD', '2026-08-31', 700);
  const fileA = path.join(dir, 'step6-a.xlsx');
  const fileB = path.join(dir, 'step6-b.xlsx');
  writeSource(fileA, 'A', [['2026-09-01', 'IGNORED', 'USD', '1', '']]);
  writeSource(fileB, 'B', [['2026-09-01', 'IGNORED', 'USD', '7', '']]);
  const result = env.generate([env.entryFor(owner, fileA), env.entryFor(child, fileB)], { merchantId: 'M777', currency: 'USD' });
  assertEq(readDetailColumns(result.detail.filePath, ['MerchantId']).map((row) => row[0]).sort(), ['M009', 'M777'], 'Step6.所选大账号只注入多大账号子模板的文件');
  assertEq([result.detail.fileName, result.balance.fileName], ['招商银行-上海-COMMON-2026-09-01.xlsx', '招商银行-上海-BALANCE-2026-09-01.xlsx'],
    'Step6.混有固定账号子模板时，文件名不带所选大账号');
  assertEq(readBalanceRows(result.balance.filePath).map((row) => [row[2], row[5]]).sort(), [['M009', 101], ['M777', 707]], 'Step6.两个账号各自接上种子');
}

// ⑧
function verifyConflictBlocksImport(dir) {
  const env = createEnvironment(dir, 'step8');
  const owner = env.defineTemplate('招商银行-上海', 'A');
  const child = env.defineTemplate('CMB-SH', 'B');
  const normal = env.defineTemplate('工行-深圳', 'C');
  const raw = env.database.db;
  raw.prepare('UPDATE templates SET is_parent = 1 WHERE id = ?').run(owner.id);
  raw.prepare('UPDATE templates SET parent_template_id = ? WHERE id = ?').run(owner.id, child.id);
  env.database.saveAccountMappings({ templateId: owner.id }, [{ bankAccountId: 'RAW001', clearingAccountId: 'M001' }]);
  env.database.saveAccountMappings({ templateId: child.id }, [{ bankAccountId: 'RAW001', clearingAccountId: 'M001-OTHER' }]);
  const migration = env.database.runStatementChannelMigration();
  assertEq(migration.conflictCount, 1, 'Step8.迁移登记一个冲突');
  const channel = env.database.getStatementChannelByName('招商银行-上海');
  const pending = env.database.listStatementChannelAccountMappingConflicts(channel.id);
  assertEq(pending.map((item) => item.conflicts.map((conflict) => conflict.bankAccountId)), [['RAW001']], 'Step8.冲突待处理时该渠道被阻断（导入入口按渠道查询冲突）');
  assertEq(env.database.listStatementChannelAccountMappingConflicts(null).map((item) => item.channelName), ['招商银行-上海'], 'Step8.普通模板不在冲突清单内');
  seed(env, '工行-深圳', 'M201', 'USD', '2026-08-31', 500);
  const fileC = path.join(dir, 'step8-c.xlsx');
  writeSource(fileC, 'C', [['2026-09-01', 'M201', 'USD', '1', '']]);
  const normalOnly = env.generate([env.entryFor(normal, fileC), env.entryFor(normal, fileC)]);
  assertTrue(Boolean(normalOnly.balance), 'Step8.普通模板照常生成');

  const candidates = pending[0].conflicts[0].candidates.map((candidate) => candidate.clearingAccountId);
  env.database.resolveStatementChannelAccountMappingConflicts(channel.id, [{ bankAccountId: 'RAW001', candidateIndex: candidates.indexOf('M001-OTHER') }]);
  assertEq(env.database.countStatementChannelAccountMappingConflicts(channel.id), 0, 'Step8.处理后无待处理冲突');
  seed(env, '招商银行-上海', 'M001-OTHER', 'USD', '2026-08-31', 1000);
  const { fileA, fileB } = prepareChannelFiles(dir, 'step8');
  const result = env.generate([
    env.entryFor(env.database.getTemplate(owner.id), fileA),
    env.entryFor(env.database.getTemplate(child.id), fileB)
  ]);
  assertEq([...new Set(readDetailColumns(result.detail.filePath, ['MerchantId']).map((row) => row[0]))], ['M001-OTHER'], 'Step8.回读账号为所选候选');
}

// ⑨ PR #246 审查：普通模板与渠道同名（模板包或旧数据可能带来）时，两组输出名称相同，生成文件路径、
//    Channel 列、余额与种子归属都会重叠；生成前的兜底检查列出冲突，界面入口阻止形成同名。
function verifyOutputNameConflictGuard(dir) {
  const env = createEnvironment(dir, 'step9');
  const owner = env.defineTemplate('招商银行-上海', 'A');
  const channelId = env.saveWithChannel(owner, { mode: 'create' }).channelId;
  env.database.renameTemplate(owner.id, 'CMB-A');
  const ordinary = env.defineTemplate('招商银行-上海', 'C');
  const fileA = path.join(dir, 'step9-a.xlsx');
  const fileC = path.join(dir, 'step9-c.xlsx');
  writeSource(fileA, 'A', [['2026-09-01', 'M001', 'USD', '10', '']]);
  writeSource(fileC, 'C', [['2026-09-01', 'M001', 'USD', '7', '']]);
  const groups = env.fns.groupStatementEntriesForGeneration([
    env.entryFor(env.database.getTemplate(owner.id), fileA),
    env.entryFor(ordinary, fileC)
  ]);
  assertEq(env.fns.findGenerationGroupOutputNameConflicts(groups), ['输出名称「招商银行-上海」：渠道「招商银行-上海」、模板「招商银行-上海」'],
    'Step9.普通模板与渠道同名时生成前列出冲突');
  let leaveError = null;
  try { env.saveWithChannel(env.database.getTemplate(owner.id), { mode: 'none' }); } catch (error) { leaveError = error; }
  assertEq(leaveError, null, 'Step9.名称不同的子模板可以移出');
  let renameError = null;
  try { env.database.renameStatementChannel(channelId, '招商银行-上海'); } catch (error) { renameError = error; }
  assertEq(renameError && renameError.code, 'CHANNEL_OUTPUT_NAME_CONFLICT', 'Step9.渠道不能改成（或保持）与普通模板相同的名称');
  env.database.renameTemplate(ordinary.id, '招商银行-上海-普通');
  const renamed = env.fns.groupStatementEntriesForGeneration([env.entryFor(env.database.getTemplate(ordinary.id), fileC)]);
  assertEq(env.fns.findGenerationGroupOutputNameConflicts(renamed), null, 'Step9.改名后无冲突');
}

// ⑩ PR #246 审查：模板包导入第一轮被跳过（表头重复、映射校验失败）的模板，第二、三轮不改写其账户映射与渠道归属。
function verifyBundleSkippedTemplateKeepsChannel(dir) {
  const env = createEnvironment(dir, 'step10');
  const kept = env.defineTemplate('招商银行-上海', 'A');
  const keptChannelId = env.saveWithChannel(kept, { mode: 'create' }).channelId;
  env.database.saveAccountMappings({ channelId: keptChannelId }, [{ bankAccountId: 'RAW001', clearingAccountId: 'M001' }]);
  const moved = env.defineTemplate('工行-深圳', 'C');
  const skippedEntry = { templateKey: kept.templateKey, name: kept.name, channelName: '包内渠道',
    accountMappings: [{ bankAccountId: 'RAW001', clearingAccountId: 'M001-FROM-BUNDLE' }] };
  const succeededEntry = { templateKey: moved.templateKey, name: moved.name, channelName: '包内渠道', accountMappings: [] };
  const { restoreResult } = env.fns.restoreBundleFollowUpRounds({
    importedTemplates: [skippedEntry, succeededEntry],
    succeededEntries: new Set([succeededEntry]),
    importedBundleVersion: 5,
    importedChannels: [{ name: '包内渠道', accountMappings: [{ bankAccountId: 'RAW009', clearingAccountId: 'M009' }], accountMappingConflicts: [] }]
  });
  assertEq(restoreResult.channelCount, 1, 'Step10.包内渠道照常还原');
  assertEq(env.database.getTemplate(kept.id).channelName, '招商银行-上海', 'Step10.被跳过的模板保留原渠道归属');
  assertEq(env.database.listAccountMappings({ channelId: keptChannelId }).map((m) => m.clearingAccountId), ['M001'], 'Step10.原渠道映射不变');
  assertEq(env.database.listAccountMappings({ templateId: kept.id }), [], 'Step10.被跳过的模板不写入包内模板级映射');
  assertEq(env.database.getTemplate(moved.id).channelName, '包内渠道', 'Step10.成功导入的模板按包归入渠道');
}

// ⑪ release/v3.2.15 审查：包内渠道与本地渠道同名，而包内归入它的模板全部被跳过时，不还原该渠道：
//    本地渠道的生效映射（清结算账号、兜底币种）与待处理冲突都不变；包内有成功模板的渠道照常还原。
function verifyBundleSkippedSameNameChannelKeepsMappings(dir) {
  const env = createEnvironment(dir, 'step11');
  const kept = env.defineTemplate('招商银行-上海', 'A');
  const channelId = env.saveWithChannel(kept, { mode: 'create' }).channelId;
  env.database.restoreTemplateBundleStatementChannels({
    channels: [{
      name: '招商银行-上海',
      accountMappings: [{ bankAccountId: 'RAW001', clearingAccountId: 'OLD-ACCOUNT', noCurrency: true, currency: 'USD' }],
      accountMappingConflicts: [{ bankAccountId: 'RAW002', candidates: [{ clearingAccountId: 'M002-A' }, { clearingAccountId: 'M002-B' }] }]
    }]
  });
  const mappingsOf = () => env.database.listAccountMappings({ channelId })
    .map((m) => [m.bankAccountId, m.clearingAccountId, Boolean(m.noCurrency), m.currency]);
  const before = mappingsOf();
  assertEq(before, [['RAW001', 'OLD-ACCOUNT', true, 'USD']], 'Step11.前置：本地渠道映射');
  assertEq(env.database.countStatementChannelAccountMappingConflicts(channelId), 1, 'Step11.前置：本地渠道有 1 个待处理冲突');
  const other = env.defineTemplate('工行-深圳', 'C');
  const skippedEntry = { templateKey: kept.templateKey, name: kept.name, channelName: '招商银行-上海', accountMappings: [] };
  const succeededEntry = { templateKey: other.templateKey, name: other.name, channelName: '工行-深圳', accountMappings: [] };
  const { channelRestore, restoreResult } = env.fns.restoreBundleFollowUpRounds({
    importedTemplates: [skippedEntry, succeededEntry],
    succeededEntries: new Set([succeededEntry]),
    importedBundleVersion: 5,
    importedChannels: [
      { name: '招商银行-上海', accountMappings: [{ bankAccountId: 'RAW001', clearingAccountId: 'NEW-ACCOUNT', noCurrency: true, currency: 'EUR' }], accountMappingConflicts: [] },
      { name: '工行-深圳', accountMappings: [{ bankAccountId: 'RAW009', clearingAccountId: 'M009' }], accountMappingConflicts: [] }
    ]
  });
  assertEq(channelRestore.channels.map((channel) => channel.name), ['工行-深圳'], 'Step11.只还原有成功模板的包内渠道');
  assertEq(mappingsOf(), before, 'Step11.被跳过模板所在的同名渠道映射不变');
  assertEq(env.database.countStatementChannelAccountMappingConflicts(channelId), 1, 'Step11.同名渠道的待处理冲突不变');
  assertEq(env.database.getTemplate(kept.id).channelName, '招商银行-上海', 'Step11.被跳过的模板归属不变');
  assertEq(restoreResult.channelCount, 1, 'Step11.还原 1 个渠道');
  const restored = env.database.getStatementChannelByName('工行-深圳');
  assertEq(env.database.listAccountMappings({ channelId: restored.id }).map((m) => m.clearingAccountId), ['M009'], 'Step11.成功模板所在渠道写入包内映射');
}

// ⑫ release/v3.2.15 审查：同名的渠道与普通模板分两批导入时，每批只有一组，也要按库里同名的另一方阻断，
//    否则后一批覆盖前一批的明细、余额文件与同键余额种子。
function verifyOutputNameConflictAcrossBatches(dir) {
  const env = createEnvironment(dir, 'step12');
  const owner = env.defineTemplate('招商银行-上海', 'A');
  env.saveWithChannel(owner, { mode: 'create' });
  env.database.renameTemplate(owner.id, 'CMB-A');
  const ordinary = env.defineTemplate('招商银行-上海', 'C');
  const fileA = path.join(dir, 'step12-a.xlsx');
  const fileC = path.join(dir, 'step12-c.xlsx');
  writeSource(fileA, 'A', [['2026-09-01', 'M001', 'USD', '10', '']]);
  writeSource(fileC, 'C', [['2026-09-01', 'M001', 'USD', '7', '']]);
  const channelBatch = env.fns.groupStatementEntriesForGeneration([env.entryFor(env.database.getTemplate(owner.id), fileA)]);
  const ordinaryBatch = env.fns.groupStatementEntriesForGeneration([env.entryFor(ordinary, fileC)]);
  assertEq(env.fns.findGenerationGroupOutputNameConflicts(channelBatch), ['输出名称「招商银行-上海」：渠道「招商银行-上海」、模板「招商银行-上海」'],
    'Step12.只导入渠道子模板的文件也按库里同名的普通模板阻断');
  assertEq(env.fns.findGenerationGroupOutputNameConflicts(ordinaryBatch), ['输出名称「招商银行-上海」：模板「招商银行-上海」、渠道「招商银行-上海」'],
    'Step12.只导入普通模板的文件也按库里同名的渠道阻断');
  env.database.renameTemplate(ordinary.id, '招商银行-上海-普通');
  assertEq(env.fns.findGenerationGroupOutputNameConflicts(channelBatch), null, 'Step12.普通模板改名后渠道一批不再阻断');
  const renamedBatch = env.fns.groupStatementEntriesForGeneration([env.entryFor(env.database.getTemplate(ordinary.id), fileC)]);
  assertEq(env.fns.findGenerationGroupOutputNameConflicts(renamedBatch), null, 'Step12.普通模板改名后普通模板一批不再阻断');

  // 输出路径不区分大小写、名称去首尾空格：只差大小写或空格的渠道与普通模板同样阻断（两个方向）。
  env.database.renameTemplate(ordinary.id, '招商银行-上海'.replace('上海', 'SH').toLowerCase());
  const lowerName = env.database.getTemplate(ordinary.id).name;
  env.database.renameStatementChannel(env.database.getTemplate(owner.id).channelId, '招商银行-SH');
  const channelBatchUpper = env.fns.groupStatementEntriesForGeneration([env.entryFor(env.database.getTemplate(owner.id), fileA)]);
  const ordinaryBatchLower = env.fns.groupStatementEntriesForGeneration([env.entryFor(env.database.getTemplate(ordinary.id), fileC)]);
  assertEq(env.fns.findGenerationGroupOutputNameConflicts(channelBatchUpper), [`输出名称「招商银行-SH」：渠道「招商银行-SH」、模板「${lowerName}」`],
    'Step12.渠道与只差大小写的普通模板：渠道一批阻断');
  assertEq(env.fns.findGenerationGroupOutputNameConflicts(ordinaryBatchLower), [`输出名称「${lowerName}」：模板「${lowerName}」、渠道「招商银行-SH」`],
    'Step12.渠道与只差大小写的普通模板：普通模板一批阻断');
  env.database.renameTemplate(ordinary.id, ' 招商银行-SH ');
  assertEq(env.database.getTemplate(ordinary.id).name, ' 招商银行-SH ', 'Step12.前置：模板名保留首尾空格');
  assertEq(env.fns.findGenerationGroupOutputNameConflicts(channelBatchUpper), ['输出名称「招商银行-SH」：渠道「招商银行-SH」、模板「招商银行-SH」'],
    'Step12.渠道与只差首尾空格的普通模板：渠道一批阻断');

  // 两个普通模板名称只差首尾空格（显示文字相同、模板不同）：同批仍按两个所有者阻断。
  env.database.renameTemplate(ordinary.id, '工行-深圳');
  const spaced = env.defineTemplate(' 工行-深圳 ', 'A');
  const fileSpaced = path.join(dir, 'step12-spaced.xlsx');
  writeSource(fileSpaced, 'A', [['2026-09-01', 'M001', 'USD', '5', '']]);
  const twoTemplates = env.fns.groupStatementEntriesForGeneration([
    env.entryFor(env.database.getTemplate(ordinary.id), fileC),
    env.entryFor(env.database.getTemplate(spaced.id), fileSpaced)
  ]);
  assertEq(twoTemplates.length, 2, 'Step12.前置：两个普通模板各自成组');
  assertEq(env.fns.findGenerationGroupOutputNameConflicts(twoTemplates), ['输出名称「工行-深圳」：模板「工行-深圳」、模板「工行-深圳」'],
    'Step12.名称只差首尾空格的两个普通模板同批阻断');
}

// ⑬ release/v3.2.15 审查：v≤4 模板包里父模板第一轮被跳过、子模板成功时，不把本地同 key 的父模板当作包外父模板：
//    本地父模板的归属与模板级映射不变，子模板按普通模板导入，带包内自己的映射。
function verifyLegacyBundleSkippedParent(dir) {
  const env = createEnvironment(dir, 'step13');
  const parent = env.defineTemplate('招商银行-上海', 'A');
  env.database.saveAccountMappings({ templateId: parent.id }, [{ bankAccountId: 'RAW001', clearingAccountId: 'OLD-ACCOUNT', noCurrency: true, currency: 'USD' }]);
  const child = env.defineTemplate('招商银行-上海-2', 'C');
  const parentEntry = { templateKey: parent.templateKey, name: parent.name, isParent: true, parentTemplateKey: null,
    accountMappings: [{ bankAccountId: 'RAW001', clearingAccountId: 'FROM-BUNDLE' }] };
  const childEntry = { templateKey: child.templateKey, name: child.name, isParent: false, parentTemplateKey: parent.templateKey,
    accountMappings: [{ bankAccountId: 'RAW002', clearingAccountId: 'NEW-ACCOUNT', noCurrency: true, currency: 'EUR' }] };
  const { channelRestore, restoreResult } = env.fns.restoreBundleFollowUpRounds({
    importedTemplates: [parentEntry, childEntry],
    succeededEntries: new Set([childEntry]),
    importedBundleVersion: 4,
    importedChannels: []
  });
  const mappingsOf = (scope) => env.database.listAccountMappings(scope)
    .map((m) => [m.bankAccountId, m.clearingAccountId, Boolean(m.noCurrency), m.currency]);
  assertEq(env.database.getTemplate(parent.id).channelId || null, null, 'Step13.被跳过的父模板不归入渠道');
  assertEq(mappingsOf({ templateId: parent.id }), [['RAW001', 'OLD-ACCOUNT', true, 'USD']], 'Step13.被跳过的父模板映射不变');
  assertEq(env.database.getTemplate(child.id).channelId || null, null, 'Step13.子模板按普通模板导入');
  assertEq(mappingsOf({ templateId: child.id }), [['RAW002', 'NEW-ACCOUNT', true, 'EUR']], 'Step13.子模板带包内自己的映射');
  assertEq(channelRestore.orphanedTemplateNames, ['招商银行-上海-2'], 'Step13.列出按普通模板导入的子模板');
  assertEq([restoreResult.channelCount, restoreResult.conflictCount], [0, 0], 'Step13.不新建渠道、不产生冲突');
  assertEq(env.database.listStatementChannels().length, 0, 'Step13.库里没有渠道');
}

// ⑭ release/v3.2.15 复审：同名核对按实际写盘文件名的口径（非法字符替换、内部空白合并、去首尾空格、不区分大小写），
//    并核对库里所有同名的输出所有者（同类与异类都算），名称相近的两方分两批导入也阻断；同一渠道的多个子模板不算冲突。
function verifyOutputNameConflictFileNameKey(dir) {
  const env = createEnvironment(dir, 'step14');
  const fileA = path.join(dir, 'step14-a.xlsx');
  writeSource(fileA, 'A', [['2026-09-01', 'M001', 'USD', '10', '']]);
  const batchOf = (...templates) => env.fns.groupStatementEntriesForGeneration(
    templates.map((template) => env.entryFor(env.database.getTemplate(template.id), fileA))
  );
  const conflicts = (batch) => env.fns.findGenerationGroupOutputNameConflicts(batch);
  const doubleSpace = env.defineTemplate('ACME  BANK-SG', 'A');
  const other = env.defineTemplate('ACME BANK-SG', 'A');
  assertEq(conflicts(batchOf(doubleSpace)), ['输出名称「ACME  BANK-SG」：模板「ACME  BANK-SG」、模板「ACME BANK-SG」'],
    'Step14.内部多一个空格的两个普通模板：分批导入也阻断');
  assertEq(conflicts(batchOf(other)), ['输出名称「ACME BANK-SG」：模板「ACME BANK-SG」、模板「ACME  BANK-SG」'],
    'Step14.内部多一个空格的两个普通模板：另一方单独导入同样阻断');
  env.database.renameTemplate(other.id, 'ACME\u3000BANK-SG');
  assertEq(conflicts(batchOf(doubleSpace)), ['输出名称「ACME  BANK-SG」：模板「ACME  BANK-SG」、模板「ACME\u3000BANK-SG」'],
    'Step14.内部全角空格与半角空格视为同名');
  env.database.renameTemplate(doubleSpace.id, 'ACME-SG?x');
  env.database.renameTemplate(other.id, 'ACME-SG*x');
  assertEq(conflicts(batchOf(doubleSpace)), ['输出名称「ACME-SG?x」：模板「ACME-SG?x」、模板「ACME-SG*x」'],
    'Step14.写盘时替换成同一字符的非法字符视为同名');
  env.database.renameTemplate(other.id, 'ACME-SG-y');
  assertEq(conflicts(batchOf(doubleSpace)), null, 'Step14.改名后写盘文件名不同则放行');
  // Unicode 规范等价：预组合 É 与 E + 组合重音在 APFS 上是同一个文件名。
  env.database.renameTemplate(doubleSpace.id, 'CAF\u00C9-SG');
  env.database.renameTemplate(other.id, 'CAFE\u0301-SG');
  assertEq(conflicts(batchOf(doubleSpace)), ['输出名称「CAF\u00C9-SG」：模板「CAF\u00C9-SG」、模板「CAFE\u0301-SG」'],
    'Step14.Unicode 规范等价的两个名称视为同名');

  // 多模板生成进入副作用前整批核对：冲突时不改会话、不写任何组的文件（预检后配置可能已变化）。
  const fileB = path.join(dir, 'step14-b.xlsx');
  writeSource(fileB, 'A', [['2026-09-02', 'M002', 'USD', '20', '']]);
  const entries = [env.entryFor(env.database.getTemplate(other.id), fileB), env.entryFor(env.database.getTemplate(doubleSpace.id), fileA)];
  let generationError = null;
  try { env.generate(entries); } catch (error) { generationError = error; }
  assertEq(generationError && generationError.code, 'STATEMENT_OUTPUT_NAME_CONFLICT', 'Step14.多模板生成前整批阻断');
  const exportsDir = path.join(env.storageRoot, 'exports');
  const written = fs.existsSync(exportsDir) ? fs.readdirSync(exportsDir, { recursive: true }).filter((name) => String(name).endsWith('.xlsx')) : [];
  assertEq(written, [], 'Step14.阻断时任何组都没有写出文件');

  // 两个渠道名称只差大小写：分批导入也阻断；同一渠道的两个子模板同批不算冲突。
  const upperOwner = env.defineTemplate('BANK-SG', 'A');
  const upperChannelId = env.saveWithChannel(upperOwner, { mode: 'create' }).channelId;
  const upperChild = env.defineTemplate('BANK-SG-2', 'A');
  env.saveWithChannel(upperChild, { mode: 'join', channelId: upperChannelId });
  assertEq(conflicts(batchOf(upperOwner, upperChild)), null, 'Step14.同一渠道的两个子模板同批不算冲突');
  const lowerOwner = env.defineTemplate('bank-sg-tmp', 'A');
  const lowerChannelId = env.saveWithChannel(lowerOwner, { mode: 'create' }).channelId;
  env.database.renameStatementChannel(lowerChannelId, 'bank-sg');
  assertEq(env.database.getStatementChannel(lowerChannelId).name, 'bank-sg', 'Step14.前置：库里允许只差大小写的两个渠道');
  assertEq(conflicts(batchOf(upperOwner)), ['输出名称「BANK-SG」：渠道「BANK-SG」、渠道「bank-sg」'],
    'Step14.只差大小写的两个渠道：分批导入也阻断');
  assertEq(conflicts(batchOf(lowerOwner)), ['输出名称「bank-sg」：渠道「bank-sg」、渠道「BANK-SG」'],
    'Step14.只差大小写的两个渠道：另一方单独导入同样阻断');
}

// ⑮ release/v3.2.15 复审：多层旧版模板包（A→B→C、A→D），A 被跳过：B 仍被成功的 C 引用，与 C 组成渠道「B」；
//    D 按普通模板导入。日志按最终归属分别列出，不把组成渠道的 B 写成按普通模板导入。
function verifyLegacyBundleMultiLevelSkippedParent(dir) {
  const env = createEnvironment(dir, 'step15');
  const [a, b, c, d] = ['层级-A', '层级-B', '层级-C', '层级-D'].map((name) => env.defineTemplate(name, 'A'));
  const entryOf = (template, parent, isParent) => ({ templateKey: template.templateKey, name: template.name, isParent,
    parentTemplateKey: parent ? parent.templateKey : null, accountMappings: [] });
  const entries = [entryOf(a, null, true), entryOf(b, a, true), entryOf(c, b, false), entryOf(d, a, false)];
  const { channelRestore } = env.fns.restoreBundleFollowUpRounds({
    importedTemplates: entries,
    succeededEntries: new Set(entries.slice(1)),
    importedBundleVersion: 4,
    importedChannels: []
  });
  const channelNameOf = (template) => {
    const channelId = env.database.getTemplate(template.id).channelId;
    return channelId ? env.database.getStatementChannel(channelId).name : null;
  };
  assertEq([a, b, c, d].map(channelNameOf), [null, '层级-B', '层级-B', null], 'Step15.B 与 C 组成渠道「B」，A 不变、D 按普通模板导入');
  assertEq(channelRestore.orphanedTemplateNames, ['层级-D'], 'Step15.只把最终按普通模板导入的 D 记为普通模板');
  assertEq(channelRestore.regroupedTemplateNames, ['层级-B（渠道「层级-B」）'], 'Step15.B 记为仍归入渠道，带最终渠道名');

  // 手工合并的包里同一模板出现两次：第一条的父模板被跳过，第二条自身是主模板。归属以最后一条为准，日志按最终归属列一次。
  const env2 = createEnvironment(dir, 'step15-dup');
  const [a2, b2] = ['重复-A', '重复-B'].map((name) => env2.defineTemplate(name, 'A'));
  const entryOf2 = (template, parent, isParent) => ({ templateKey: template.templateKey, name: template.name, isParent,
    parentTemplateKey: parent ? parent.templateKey : null, accountMappings: [] });
  const dupEntries = [entryOf2(a2, null, true), entryOf2(b2, a2, false), entryOf2(b2, null, true)];
  const dup = env2.fns.restoreBundleFollowUpRounds({
    importedTemplates: dupEntries,
    succeededEntries: new Set(dupEntries.slice(1)),
    importedBundleVersion: 4,
    importedChannels: []
  }).channelRestore;
  const b2ChannelId = env2.database.getTemplate(b2.id).channelId;
  assertEq(b2ChannelId ? env2.database.getStatementChannel(b2ChannelId).name : null, '重复-B', 'Step15.重复条目按最后一条归入渠道「B」');
  assertEq([dup.orphanedTemplateNames, dup.regroupedTemplateNames], [[], ['重复-B（渠道「重复-B」）']], 'Step15.重复条目的日志按最终归属只列一次');

  // 重复条目最后一条把 B 归入另一个成功主模板 C 的渠道：日志写最终渠道「C」，不说 B 以自身名称组成渠道。
  const env3 = createEnvironment(dir, 'step15-other');
  const [a3, b3, c3] = ['另归-A', '另归-B', '另归-C'].map((name) => env3.defineTemplate(name, 'A'));
  const otherEntries = [entryOf2(a3, null, true), entryOf2(b3, a3, false), entryOf2(b3, c3, false), entryOf2(c3, null, true)];
  const other = env3.fns.restoreBundleFollowUpRounds({
    importedTemplates: otherEntries,
    succeededEntries: new Set(otherEntries.slice(1)),
    importedBundleVersion: 4,
    importedChannels: []
  }).channelRestore;
  const b3ChannelId = env3.database.getTemplate(b3.id).channelId;
  assertEq(b3ChannelId ? env3.database.getStatementChannel(b3ChannelId).name : null, '另归-C', 'Step15.B 最终归入渠道「C」');
  assertEq([other.orphanedTemplateNames, other.regroupedTemplateNames], [[], ['另归-B（渠道「另归-C」）']], 'Step15.日志写出最终渠道「C」');
}

// ⑯ release/v3.2.15 复审：多模板生成在预检之后、生成之前，
//    （1）有模板被删除：整批拦下，不改会话、不写文件（否则该组按首模板配置生成，与首模板组写到同一文件）；
//    （2）组配置取自之前记下的配置（fallback）而模板已改名、旧名被渠道占用：按实际生成用的配置核对，在替换会话旧文件之前拦下。
function verifyMultiTemplateGenerationStaleState(dir) {
  const env = createEnvironment(dir, 'step16');
  const fileA = path.join(dir, 'step16-a.xlsx');
  const fileB = path.join(dir, 'step16-b.xlsx');
  writeSource(fileA, 'A', [['2026-09-01', 'M001', 'USD', '10', '']]);
  writeSource(fileB, 'A', [['2026-09-01', 'M002', 'USD', '20', '']]);
  const templateA = env.defineTemplate('多组-A', 'A');
  const templateB = env.defineTemplate('多组-B', 'A');
  const entries = [env.entryFor(templateA, fileA), env.entryFor(templateB, fileB)];
  const exportsDir = path.join(env.storageRoot, 'exports');
  const writtenFiles = () => (fs.existsSync(exportsDir)
    ? fs.readdirSync(exportsDir, { recursive: true }).filter((name) => String(name).endsWith('.xlsx')) : []);
  const runGeneration = (fallbackTemplateConfig) => {
    try {
      env.fns.generateMultiTemplateGroupFiles({
        fileEntries: entries,
        fallbackTemplateConfig,
        selectedBigAccount: null,
        reuseMappedRows: true,
        session: { key: 'session' },
        replacePaths: ['/old/replaced.xlsx'],
        inputFilePaths: [fileA, fileB]
      });
      return null;
    } catch (error) {
      return error;
    }
  };

  // （2）先做：A 的旧配置（名称「BANK-SG」）被记下后，A 改名、旧名被只差大小写的渠道占用。
  env.database.renameTemplate(templateA.id, 'BANK-SG');
  const staleConfigA = env.getTemplateMappingConfig(templateA.id);
  env.database.renameTemplate(templateA.id, '多组-A-新');
  const holder = env.defineTemplate('占位-渠道', 'A');
  const holderChannelId = env.saveWithChannel(holder, { mode: 'create' }).channelId;
  env.database.renameStatementChannel(holderChannelId, 'bank-sg');
  const staleError = runGeneration(staleConfigA);
  assertEq(staleError && staleError.code, 'STATEMENT_OUTPUT_NAME_CONFLICT', 'Step16.按实际生成用的旧配置核对出同名');
  assertEq(staleError && staleError.detailLines, ['输出名称「BANK-SG」：模板「BANK-SG」、渠道「bank-sg」'], 'Step16.冲突明细为旧配置名称与渠道');
  assertEq(env.removedSessionPaths, [], 'Step16.拦下前没有替换会话里的旧文件');
  assertEq(writtenFiles(), [], 'Step16.拦下前没有写出文件');

  // （1）删除 B：整批拦下。
  env.database.deleteTemplate(templateB.id);
  const deletedError = runGeneration(env.getTemplateMappingConfig(templateA.id));
  assertEq(deletedError && deletedError.code, 'TEMPLATE_NOT_FOUND', 'Step16.有模板被删除时整批拦下');
  assertEq(deletedError && deletedError.detailLines, [`文件：step16-b.xlsx（模板 ID：${templateB.id}）`], 'Step16.明细列出被删除模板的文件');
  assertEq(env.removedSessionPaths, [], 'Step16.删除拦下时没有替换会话里的旧文件');
  assertEq(writtenFiles(), [], 'Step16.删除拦下时没有写出文件');
}

// ⑰ release/v3.2.15 审查：内部文件名为“输出名称-账号-…”，组内只有一个账号时才带账号。渠道「名称」只有账号 M001、
//    普通模板「名称-M001」有两个账号时，两组拼出同一个文件名；同批生成（导入、补录重算）都应在任一组写出之前拦下。
function verifyOutputPathConcatenationConflict(dir) {
  const env = createEnvironment(dir, 'step17');
  const fileChannel = path.join(dir, 'step17-channel.xlsx');
  const fileTemplate = path.join(dir, 'step17-template.xlsx');
  writeSource(fileChannel, 'A', [['2026-09-01', 'M001', 'USD', '10', '']]);
  writeSource(fileTemplate, 'B', [['2026-09-01', 'M002', 'USD', '20', ''], ['2026-09-01', 'M003', 'USD', '30', '']]);
  const owner = env.defineTemplate('拼接-SG', 'A');
  env.saveWithChannel(owner, { mode: 'create' });
  const concatenated = env.defineTemplate('拼接-SG-M001', 'B');
  const entries = [
    env.entryFor(env.database.getTemplate(owner.id), fileChannel),
    env.entryFor(env.database.getTemplate(concatenated.id), fileTemplate)
  ];
  assertEq(env.fns.findGenerationGroupOutputNameConflicts(env.fns.groupStatementEntriesForGeneration(entries)), null,
    'Step17.前置：两组输出名称本身不同，名称核对放行');
  const exportsDir = path.join(env.storageRoot, 'exports');
  const writtenFiles = () => (fs.existsSync(exportsDir)
    ? fs.readdirSync(exportsDir, { recursive: true }).filter((name) => String(name).endsWith('.xlsx')) : []);
  const expectedLines = ['文件名「拼接-SG-M001」：渠道「拼接-SG」（账号 M001）、模板「拼接-SG-M001」'];

  let importError = null;
  try {
    env.fns.generateMultiTemplateGroupFiles({
      fileEntries: entries,
      fallbackTemplateConfig: env.getTemplateMappingConfig(owner.id),
      selectedBigAccount: null,
      reuseMappedRows: true,
      session: { key: 'session' },
      replacePaths: ['/old/replaced.xlsx'],
      inputFilePaths: [fileChannel, fileTemplate]
    });
  } catch (error) {
    importError = error;
  }
  assertEq(importError && importError.code, 'STATEMENT_OUTPUT_NAME_CONFLICT', 'Step17.导入时按实际文件名整批拦下');
  assertEq(importError && importError.detailLines, expectedLines, 'Step17.明细列出拼接后相同的文件名与两组');
  assertEq(env.removedSessionPaths, [], 'Step17.拦下前没有替换会话里的旧文件');
  assertEq(writtenFiles(), [], 'Step17.拦下前没有写出文件');

  // 补录后按会话当前批次重算余额：同样在任一组写出之前拦下。
  const session = {
    fileEntries: entries.map((entry, index) => ({ ...entry, id: `entry-${index}` })),
    batches: [{ id: 'batch-1', entryIds: ['entry-0', 'entry-1'] }],
    currentBatchId: 'batch-1'
  };
  let regenerateError = null;
  try {
    env.fns.regenerateVirtualTemplateBalanceFromSession(session, 'current');
  } catch (error) {
    regenerateError = error;
  }
  assertEq(regenerateError && regenerateError.detailLines, expectedLines, 'Step17.补录重算时同样拦下');
  assertEq(writtenFiles(), [], 'Step17.补录重算拦下前没有写出文件');
}

// ⑳ v3.2.22 B45：按文件名映射多模板导入写出期间失败（第二组明细 / 余额写出被占用、汇总余额合并写到一半失败）时，
//    还原本批已写的明细 / 余额 / 汇总文件与余额种子，旧会话条目不替换；业务校验失败仍在写出前拦下。重试成功后文件与会话
//    各替换一次；同一账户跨组的余额链在失败与重试后正确。
//    appendLog 用不抛错的桩：余额写出失败若被转成「余额生成失败」告警，批次会继续提交，本步须能识别出来。
//    会话条目、批次与导出缓存用真实实现（realSession）。
function verifyMultiTemplateGenerationRollback(dir) {
  const faults = { writeCalls: 0, failWriteAt: 0, balanceCalls: 0, failBalanceAt: 0, balancePathCalls: 0, failBalancePathAt: 0,
    mergeCalls: 0, failMergeAt: 0,
    seedCalls: 0, failSeedAt: 0, failSeedReadAt: 0, partialSeedWrites: 0, seedRecordsStored: 0, afterJournalWrite: null,
    failTemplateReadAt: 0, cleanupFailedDirectory: null };
  const activityLog = [];
  // 在真实的种子读写处注入（balance-seed-store 经 fs.readFileSync / fs.writeFileSync 读写种子 JSON）：只拦截余额种子文件
  const isSeedFile = (target) => typeof target === 'string' && /[\\/]balance-seeds[\\/][^\\/]+\.json$/.test(target);
  const withPatchedFs = (method, replacement, use) => {
    const original = fs[method];
    fs[method] = (...args) => replacement(original, ...args);
    try {
      return use();
    } finally {
      fs[method] = original;
    }
  };
  const { createStatementOutputJournal: realJournal } = require('../../src/main-process/statement-output-rollback');
  const busy = (what) => Object.assign(new Error(`EBUSY: resource busy or locked（注入：${what}被占用）`), { code: 'EBUSY' });
  // 写进诊断日志的异常（核对不含种子文件路径等内部文件名）
  const loggedErrors = [];
  const env = createEnvironment(dir, 'step20', {
    realSession: true,
    // 余额输出路径准备（建导出目录）的注入点
    buildStatementOutputFilePath: (options, original) => {
      if (options.kind === 'balance') {
        faults.balancePathCalls += 1;
        if (faults.failBalancePathAt && faults.balancePathCalls === faults.failBalancePathAt) {
          throw Object.assign(new Error('EIO: i/o error, mkdir（注入：余额导出目录）'), { code: 'EIO' });
        }
      }
      return original(options);
    },
    appendLog: (_root, error) => {
      loggedErrors.push(error);
      return 'logs/step20.log';
    },
    // 写出记录的 write 返回后（本笔已核对、已记下写后身份）、下一笔开始前的注入点
    // 备份放进测试自有目录（随 dir 统一清理），不依赖提示文案反解析备份位置（Codex 第十轮）
    createStatementOutputJournal: (options = {}) => {
      const journal = realJournal({ ...options, stagingRoot: dir });
      return {
        ...journal,
        write: (filePath, writeFn) => {
          const result = journal.write(filePath, writeFn);
          if (faults.afterJournalWrite) faults.afterJournalWrite(path.resolve(filePath));
          return result;
        },
        // 首次读取种子前的路径检查本身失败（如目录没有遍历权限）
        checkTarget: (filePath) => {
          const injected = faults.checkTargetError && faults.checkTargetError(path.resolve(filePath));
          if (injected) throw injected;
          return journal.checkTarget(filePath);
        },
        // 批次目录重试后仍未能删除（如被扫描程序长时间占用）
        commit: () => {
          const result = journal.commit();
          return faults.cleanupFailedDirectory ? { cleanupFailedDirectory: faults.cleanupFailedDirectory } : result;
        }
      };
    },
    appendActivityLogEntry: (entry) => activityLog.push(entry),
    storeGeneratedBalanceSeeds: (input, realStore) => {
      faults.seedCalls += 1;
      if (faults.failSeedAt && faults.seedCalls === faults.failSeedAt) {
        // 真实写种子 JSON 时只写出前一半字节即磁盘已满
        return withPatchedFs('writeFileSync', (original, target, data, ...rest) => {
          if (!isSeedFile(target)) return original(target, data, ...rest);
          const text = String(data);
          original(target, text.slice(0, Math.floor(text.length / 2)), ...rest);
          faults.partialSeedWrites += 1;
          throw Object.assign(new Error('ENOSPC: no space left on device（注入：种子写入）'), { code: 'ENOSPC' });
        }, () => realStore(input));
      }
      if (faults.failSeedReadAt && faults.seedCalls === faults.failSeedReadAt) {
        // 写入前重读种子 JSON 时读取失败（本笔尚未写入）
        return withPatchedFs('readFileSync', (original, target, ...rest) => {
          if (isSeedFile(target)) throw Object.assign(new Error('EIO: i/o error（注入：种子重读）'), { code: 'EIO' });
          return original(target, ...rest);
        }, () => realStore(input));
      }
      const stored = realStore(input);
      faults.seedRecordsStored += input.seedRecords.length;
      return stored;
    },
    writeWorkbookRows: (options, write) => {
      faults.writeCalls += 1;
      if (faults.failWriteAt && faults.writeCalls === faults.failWriteAt) throw busy('明细文件');
      return write(options);
    },
    writeBalanceWorkbook: (options, write) => {
      faults.balanceCalls += 1;
      if (faults.failBalanceAt && faults.balanceCalls === faults.failBalanceAt) throw busy('余额文件');
      if (faults.failTemplateReadAt && faults.balanceCalls === faults.failTemplateReadAt) {
        // 写出器读余额模板时读取失败（发生在写目标文件之前，原生异常）
        const xlsxStyle = require('xlsx-js-style');
        const readFile = xlsxStyle.readFile;
        xlsxStyle.readFile = (target, ...rest) => {
          if (path.resolve(String(target)) === path.resolve(options.templateFilePath)) {
            throw Object.assign(new Error('EIO: i/o error, read（注入：余额模板）'), { code: 'EIO' });
          }
          return readFile(target, ...rest);
        };
        try {
          return write(options);
        } finally {
          xlsxStyle.readFile = readFile;
        }
      }
      return write(options);
    },
    mergeGeneratedXlsxFiles: (paths, outputPath, merge) => {
      faults.mergeCalls += 1;
      if (faults.failMergeAt && faults.mergeCalls === faults.failMergeAt) {
        // 模拟写到一半失败（如磁盘已满）：目标已被截断
        fs.writeFileSync(outputPath, 'partial');
        throw new Error('合并失败（注入）');
      }
      return merge(paths, outputPath);
    }
  });
  const templateA = env.defineTemplate('回滚-A', 'A');
  const templateB = env.defineTemplate('回滚-B', 'B');
  // 两个模板同属银行段「回滚」，共用一份种子文件：前组写入的种子须随后组失败一并还原
  seed(env, '回滚-A', 'M001', 'USD', '2026-08-31', '100');
  seed(env, '回滚-B', 'M002', 'USD', '2026-08-31', '200');
  const seedFile = path.join(env.storageRoot, 'balance-seeds', '回滚.json');
  const fileA = path.join(dir, 'step20-a.xlsx');
  const fileB = path.join(dir, 'step20-b.xlsx');
  const writeSources = (amountA, amountB, debitB = '') => {
    writeSource(fileA, 'A', [['2026-09-01', 'M001', 'USD', amountA, '']]);
    writeSource(fileB, 'B', [['2026-09-01', 'M002', 'USD', amountB, debitB]]);
    return [env.entryFor(templateA, fileA), env.entryFor(templateB, fileB)];
  };
  const snapshot = () => {
    const files = {};
    for (const base of [path.join(env.storageRoot, 'exports'), path.join(env.storageRoot, 'balance-seeds')]) {
      if (!fs.existsSync(base)) continue;
      for (const name of fs.readdirSync(base, { recursive: true })) {
        const full = path.join(base, String(name));
        if (fs.statSync(full).isFile()) files[path.relative(env.storageRoot, full)] = fs.readFileSync(full).toString('base64');
      }
    }
    return files;
  };
  const defaultSession = createStatementImportSession({ templateId: '__FILENAME_MAPPING__', templateName: '按文件名映射模板' });
  const run = (entries, fallbackTemplateId = templateA.id, { session = defaultSession, replacePaths = ['/old/replaced.xlsx'] } = {}) => {
    faults.writeCalls = 0;
    faults.balanceCalls = 0;
    faults.balancePathCalls = 0;
    faults.mergeCalls = 0;
    faults.seedCalls = 0;
    try {
      env.fns.generateMultiTemplateGroupFiles({
        fileEntries: entries,
        fallbackTemplateConfig: env.getTemplateMappingConfig(fallbackTemplateId),
        selectedBigAccount: null,
        reuseMappedRows: true,
        session,
        replacePaths,
        inputFilePaths: entries.map((entry) => entry.filePath)
      });
      return null;
    } catch (error) {
      return error;
    }
  };

  // （1）首次导入，第二组明细写出时被占用：第一组新写的明细、余额删除，种子文件还原（同一文件身份）
  const initial = snapshot();
  const seedIno = fs.statSync(seedFile).ino;
  faults.failWriteAt = 2;
  const writeError = run(writeSources('10', '20'));
  faults.failWriteAt = 0;
  assertEq(writeError && writeError.code, 'EBUSY', 'Step20.写出失败原样抛出');
  assertEq(snapshot(), initial, 'Step20.首次导入写出失败：新写的明细、余额删除，种子文件内容还原');
  assertEq(fs.statSync(seedFile).ino, seedIno, 'Step20.种子文件原地还原，文件身份不变');
  assertEq(env.removedSessionPaths, [], 'Step20.写出失败时不替换旧会话条目');

  // （2）重试成功：写出两组与汇总，旧会话条目替换一次
  const firstError = run(writeSources('10', '20'));
  assertEq(firstError, null, 'Step20.重试成功');
  const baseline = snapshot();
  const baselineExports = Object.keys(baseline).filter((name) => name.endsWith('.xlsx')).sort();
  assertEq(baselineExports.length, 6, `Step20.两组明细、余额与两份汇总：${baselineExports.join(',')}`);
  assertEq(env.removedSessionPaths, ['/old/replaced.xlsx'], 'Step20.成功后替换一次旧会话条目');

  // （3）覆盖导入（金额变化、文件名相同），余额汇总合并失败：已覆盖的明细、余额、明细汇总全部还原为上次内容，种子还原
  faults.failMergeAt = 2;
  const mergeError = run(writeSources('11', '21'));
  faults.failMergeAt = 0;
  assertEq(mergeError && mergeError.message, '合并失败（注入）', 'Step20.合并失败原样抛出');
  assertEq(snapshot(), baseline, 'Step20.合并写到一半失败：余额汇总逐字节还原，已覆盖的同名输出与种子还原为上次内容');
  assertEq(env.removedSessionPaths, ['/old/replaced.xlsx'], 'Step20.合并失败时不再替换旧会话条目');

  // （3b）覆盖导入，第二组余额文件写出被占用：整批还原（不转成「余额生成失败」告警继续提交），种子不留第一组的新值
  faults.failBalanceAt = 2;
  const balanceError = run(writeSources('11', '21'));
  faults.failBalanceAt = 0;
  assertEq(balanceError && balanceError.code, 'EBUSY', 'Step20.余额写出失败原样抛出');
  assertEq(snapshot(), baseline, 'Step20.余额写出失败：已覆盖的同名输出与种子还原为上次内容');
  assertEq(env.removedSessionPaths, ['/old/replaced.xlsx'], 'Step20.余额写出失败时不替换旧会话条目');

  // （3c）第二组准备余额输出路径时建导出目录失败一次：与写出失败同样整批还原，不转成「余额生成失败」告警提交第一组的种子
  //   （Codex 第十七轮 P1 ⚠️ 资金口径）
  faults.failBalancePathAt = 2;
  const balancePathError = run(writeSources('11', '21'));
  faults.failBalancePathAt = 0;
  assertEq(balancePathError && balancePathError.code, 'EIO', 'Step20.余额输出路径准备失败原样抛出');
  assertEq(snapshot(), baseline, 'Step20.余额输出路径准备失败：已覆盖的同名输出与种子还原为上次内容');
  assertEq(env.removedSessionPaths, ['/old/replaced.xlsx'], 'Step20.余额输出路径准备失败时不替换旧会话条目');

  // （4）第二组业务校验失败（收支同时有值）：写出前拦下，输出与种子不变
  const validationError = run(writeSources('11', '21', '5'));
  assertTrue(Boolean(validationError) && /同时有值/.test(validationError.message), `Step20.业务校验失败被拦下：${validationError && validationError.message}`);
  assertEq(snapshot(), baseline, 'Step20.业务校验失败：输出与种子不变');
  assertEq(env.removedSessionPaths, ['/old/replaced.xlsx'], 'Step20.业务校验失败时不替换旧会话条目');

  // （5）再次重试成功：同名文件替换为新内容，不多出文件，旧会话条目再替换一次
  const retryError = run(writeSources('11', '21'));
  assertEq(retryError, null, 'Step20.再次重试成功');
  const retried = snapshot();
  const retriedExports = Object.keys(retried).filter((name) => name.endsWith('.xlsx')).sort();
  assertEq(retriedExports, baselineExports, 'Step20.重试后输出文件与上次同名同数，不重复');
  assertTrue(retriedExports.some((name) => retried[name] !== baseline[name]), 'Step20.重试后输出为新内容');
  assertEq(env.removedSessionPaths, ['/old/replaced.xlsx', '/old/replaced.xlsx'], 'Step20.每次成功各替换一次旧会话条目');

  // （5b）第二组种子写到一半失败（第二组第一笔已写入、第二笔在真实写 JSON 时只写出一半即磁盘已满）：异常原样传出，
  //   种子字节与文件身份还原，会话不提交；
  //   重试后余额按链正确（两组都换了金额，第一组与第二组首笔的新种子都须还原）
  const seedFaultSources = () => {
    writeSource(fileA, 'A', [['2026-09-01', 'M001', 'USD', '13', '']]);
    writeSource(fileB, 'B', [['2026-09-01', 'M002', 'USD', '23', ''], ['2026-09-02', 'M002', 'USD', '5', '']]);
    return [env.entryFor(templateA, fileA), env.entryFor(templateB, fileB)];
  };
  const beforeSeedFault = snapshot();
  const seedInoBeforeFault = fs.statSync(seedFile).ino;
  faults.failSeedAt = 3;
  const seedError = run(seedFaultSources());
  faults.failSeedAt = 0;
  assertEq(faults.partialSeedWrites, 1, 'Step20.前置：第二组第二笔种子在真实写入时写出一半');
  assertEq(seedError && seedError.code, 'ENOSPC', 'Step20.种子写到一半失败原样抛出');
  assertEq(snapshot(), beforeSeedFault, 'Step20.种子写到一半失败：已写的新余额与同批输出全部还原');
  assertEq(fs.statSync(seedFile).ino, seedInoBeforeFault, 'Step20.种子写到一半失败：种子原地还原，文件身份不变');
  assertEq(env.removedSessionPaths.length, 2, 'Step20.种子写到一半失败时不替换旧会话条目');
  assertEq(run(seedFaultSources()), null, 'Step20.种子写入失败后重试成功');
  assertEq(readBalanceSeedRecords(env.storageRoot, '回滚').map((record) => [record.merchantId, record.billDate, String(record.endBalance)]).sort(),
    [['M001', '2026-08-31', '100'], ['M001', '2026-09-01', '113'], ['M002', '2026-08-31', '200'], ['M002', '2026-09-01', '223'],
      ['M002', '2026-09-02', '228']], 'Step20.种子写入失败后重试：余额按链计算');

  // （5d）同一组逐笔写种子时，前一笔写成后种子被其他程序（如同步盘）另存替换：下一笔不再写入、不覆盖对方的文件，
  //   其余输出照常还原，按还原不完整报告（种子交给人工）；会话不提交
  const beforeSeedReplace = snapshot();
  const seedBytesBeforeReplace = fs.readFileSync(seedFile);
  const externalSeed = '{"external":"sync-client"}\n';
  faults.seedRecordsStored = 0;
  // 第一组 M001 一笔、第二组 M002 第一笔写完且写出记录已记下身份之后、第二笔开始之前替换（命中下一笔的写前核对）
  let replaced = false;
  faults.afterJournalWrite = (filePath) => {
    if (replaced || filePath !== path.resolve(seedFile) || faults.seedRecordsStored < 2) return;
    replaced = true;
    fs.writeFileSync(`${seedFile}.sync`, externalSeed);
    fs.renameSync(`${seedFile}.sync`, seedFile);
  };
  const replacedError = run(seedFaultSources());
  faults.afterJournalWrite = null;
  assertEq(replacedError && replacedError.code, 'STATEMENT_OUTPUT_ROLLBACK_INCOMPLETE', 'Step20.逐笔写种子期间种子被替换：停止并报还原不完整');
  assertEq([replaced, faults.seedRecordsStored], [true, 2], 'Step20.种子在两笔之间被替换后不再写下一笔（实际只写入 2 笔）');
  assertEq(fs.readFileSync(seedFile, 'utf8'), externalSeed, 'Step20.不覆盖其他程序替换后的种子');
  const { [path.relative(env.storageRoot, seedFile)]: _replacedSeed, ...restAfterReplace } = snapshot();
  const { [path.relative(env.storageRoot, seedFile)]: _seedBefore, ...restBeforeReplace } = beforeSeedReplace;
  assertEq(restAfterReplace, restBeforeReplace, 'Step20.种子被替换时其余输出照常还原');
  assertEq(env.removedSessionPaths.length, 3, 'Step20.种子被替换时不替换旧会话条目（仍为 5b 重试成功后的 3 次）');
  fs.writeFileSync(seedFile, seedBytesBeforeReplace); // 人工按恢复清单处理后的状态，供后续步骤使用

  // （5e）逐笔写种子前重读种子失败（FILE_READ，本笔尚未写入）：与初次读取失败一样按「余额生成失败」告警提交，不整批回滚、
  //   不清掉上一批的导出入口（spec D3，Codex 第六轮）
  const sessionsBeforeReadFault = env.removedSessionPaths.length;
  faults.failSeedReadAt = 2;
  writeSource(fileA, 'A', [['2026-09-01', 'M001', 'USD', '19', '']]);
  writeSource(fileB, 'B', [['2026-09-01', 'M002', 'USD', '29', '']]);
  const readFaultError = run([env.entryFor(templateA, fileA), env.entryFor(templateB, fileB)]);
  faults.failSeedReadAt = 0;
  assertEq(readFaultError, null, 'Step20.重读种子失败：不整批回滚');
  assertEq(env.removedSessionPaths.length, sessionsBeforeReadFault + 1, 'Step20.重读种子失败：本批照常提交');
  const readFaultWarnings = (env.imported[env.imported.length - 1].warnings || [])
    .filter((warning) => warning.type === 'balance-generate-failed').map((warning) => warning.message);
  assertEq(readFaultWarnings, ['本地余额种子文件损坏，请检查或删除后重试'], 'Step20.重读种子失败：按「余额生成失败」告警');
  assertEq(readBalanceSeedRecords(env.storageRoot, '回滚').map((record) => [record.merchantId, record.billDate, String(record.endBalance)]).sort(),
    [['M001', '2026-08-31', '100'], ['M001', '2026-09-01', '119'], ['M002', '2026-08-31', '200'], ['M002', '2026-09-01', '223'],
      ['M002', '2026-09-02', '228']], 'Step20.重读种子失败：第一组种子照常更新，第二组种子未写入');

  // （5f）第二组写出器读余额模板失败（原生 EIO，发生在写目标文件之前）：按模板不可读的「余额生成失败」告警提交，
  //   不整批回滚（spec D3，Codex 第七轮）
  const sessionsBeforeTemplateFault = env.removedSessionPaths.length;
  faults.failTemplateReadAt = 2;
  writeSource(fileA, 'A', [['2026-09-01', 'M001', 'USD', '21', '']]);
  writeSource(fileB, 'B', [['2026-09-01', 'M002', 'USD', '31', '']]);
  const templateFaultError = run([env.entryFor(templateA, fileA), env.entryFor(templateB, fileB)]);
  faults.failTemplateReadAt = 0;
  assertEq(templateFaultError, null, 'Step20.读余额模板失败：不整批回滚');
  assertEq(env.removedSessionPaths.length, sessionsBeforeTemplateFault + 1, 'Step20.读余额模板失败：本批照常提交');
  assertEq((env.imported[env.imported.length - 1].warnings || []).filter((warning) => warning.type === 'balance-generate-failed')
    .map((warning) => warning.message), ['余额账单模板不可读，请重新确认'], 'Step20.读余额模板失败：按「余额生成失败」告警');

  // （5g）本批成功、批次临时备份重试后仍未能删除：照常提交，活动日志留痕只记目录位置（Codex 第八轮）
  const sessionsBeforeCleanupFault = env.removedSessionPaths.length;
  const logsBeforeCleanupFault = activityLog.length;
  faults.cleanupFailedDirectory = path.join(dir, 'statement-rollback-step20');
  writeSource(fileA, 'A', [['2026-09-01', 'M001', 'USD', '22', '']]);
  writeSource(fileB, 'B', [['2026-09-01', 'M002', 'USD', '32', '']]);
  const cleanupFaultError = run([env.entryFor(templateA, fileA), env.entryFor(templateB, fileB)]);
  faults.cleanupFailedDirectory = null;
  assertEq([cleanupFaultError, env.removedSessionPaths.length], [null, sessionsBeforeCleanupFault + 1], 'Step20.临时备份未能删除：本批照常提交');
  assertEq(activityLog.slice(logsBeforeCleanupFault).filter((entry) => /临时备份未能删除/.test(entry.message))
    .map((entry) => [entry.level, entry.details]), [['warning', [`目录：${path.join(dir, 'statement-rollback-step20')}`]]],
  'Step20.临时备份未能删除：活动日志留痕只记目录位置');

  // （5c）第二组的余额种子路径是文件夹：首次读取种子前拦下、整批回滚，不转成「余额生成失败」告警提交第一组的新种子与缺组的余额
  const templateE = env.defineTemplate('目录种子-E', 'B');
  const directorySeed = path.join(env.storageRoot, 'balance-seeds', '目录种子.json');
  fs.mkdirSync(directorySeed);
  const fileE = path.join(dir, 'step20-e.xlsx');
  writeSource(fileA, 'A', [['2026-09-01', 'M001', 'USD', '17', '']]);
  writeSource(fileE, 'B', [['2026-09-01', 'M005', 'USD', '7', '']]);
  const beforeDirectorySeed = snapshot();
  const directoryError = run([env.entryFor(templateA, fileA), env.entryFor(templateE, fileE)]);
  assertEq(directoryError && directoryError.code, 'STATEMENT_OUTPUT_TARGET_UNSAFE', 'Step20.种子路径是文件夹：整批拦下');
  assertEq(snapshot(), beforeDirectorySeed, 'Step20.种子路径是文件夹：第一组的输出与新种子还原');
  assertEq(env.removedSessionPaths.length, sessionsBeforeCleanupFault + 1, 'Step20.种子路径是文件夹时不替换旧会话条目');
  fs.rmSync(directorySeed, { recursive: true, force: true });

  // （5c2）检查第二组的种子路径本身失败（目录没有遍历权限 EACCES，尚未写种子）：不当作已确认的不安全目标整批回滚，
  //   按「余额生成失败」处理本组余额、保留明细（spec D3，Codex 第十一轮）
  const sessionsBeforeCheckFault = env.removedSessionPaths.length;
  faults.checkTargetError = (filePath) => (path.basename(filePath) === '目录种子.json'
    ? Object.assign(new Error(`ENOTDIR: not a directory, lstat '${filePath}'`), { code: 'ENOTDIR', path: filePath })
    : null);
  writeSource(fileE, 'B', [['2026-09-01', 'M005', 'USD', '7', '']]);
  const checkFaultError = run([env.entryFor(templateA, fileA), env.entryFor(templateE, fileE)]);
  faults.checkTargetError = null;
  assertEq(checkFaultError && { code: checkFaultError.code }, null, 'Step20.种子路径检查失败（EACCES）：不整批回滚');
  assertEq(env.removedSessionPaths.length, sessionsBeforeCheckFault + 1, 'Step20.种子路径检查失败：本批照常提交');
  assertEq((env.imported[env.imported.length - 1].warnings || [])
    .filter((warning) => warning.type === 'balance-generate-failed').map((warning) => warning.message),
  ['余额账单生成失败，系统异常已写入日志文件'], 'Step20.种子路径检查失败：按「余额生成失败」告警');
  assertEq(fs.existsSync(directorySeed), false, 'Step20.种子路径检查失败：本组不写种子');
  // 系统错误的消息带种子文件路径（文件名可能是完整账号）：写进日志前只保留错误码（Codex 第十二轮）
  const checkFaultLog = loggedErrors[loggedErrors.length - 1];
  assertEq([checkFaultLog && checkFaultLog.code, /目录种子|balance-seeds/.test(String(checkFaultLog && checkFaultLog.stack))],
    ['ENOTDIR', false], 'Step20.种子路径检查失败：日志只记错误码、不含种子文件路径');

  // （6）同一账户跨组的余额链：C 组 09-01、D 组 09-02 同为 M009/USD，D 组的上期余额取 C 组本批写入的种子。
  //   D 组余额写出失败后整批还原（种子只剩期初），重试后两天余额与种子按链计算
  const templateC = env.defineTemplate('回滚链-C', 'A');
  const templateD = env.defineTemplate('回滚链-D', 'B');
  seed(env, '回滚链-C', 'M009', 'USD', '2026-08-31', '100');
  const fileC = path.join(dir, 'step20-c.xlsx');
  const fileD = path.join(dir, 'step20-d.xlsx');
  writeSource(fileC, 'A', [['2026-09-01', 'M009', 'USD', '10', '']]);
  writeSource(fileD, 'B', [['2026-09-02', 'M009', 'USD', '20', '']]);
  const chainEntries = () => [env.entryFor(templateC, fileC), env.entryFor(templateD, fileD)];
  const chainSeeds = () => readBalanceSeedRecords(env.storageRoot, '回滚链')
    .map((record) => [record.merchantId, record.billDate, String(record.endBalance)]).sort();
  const beforeChain = snapshot();
  faults.failBalanceAt = 2;
  const chainError = run(chainEntries(), templateC.id);
  faults.failBalanceAt = 0;
  assertEq(chainError && chainError.code, 'EBUSY', 'Step20.余额链：后组余额写出失败原样抛出');
  assertEq(snapshot(), beforeChain, 'Step20.余额链：失败后输出与种子回到导入前');
  assertEq(chainSeeds(), [['M009', '2026-08-31', '100']], 'Step20.余额链：种子只剩期初');
  assertEq(run(chainEntries(), templateC.id), null, 'Step20.余额链：重试成功');
  assertEq(chainSeeds(), [['M009', '2026-08-31', '100'], ['M009', '2026-09-01', '110'], ['M009', '2026-09-02', '130']],
    'Step20.余额链：重试后 D 组按 C 组本批写入的 09-01 余额续算');
  const balanceFiles = fs.readdirSync(path.join(env.storageRoot, 'exports'), { recursive: true })
    .map(String).filter((name) => /回滚链-[CD].*BALANCE/.test(name)).sort();
  assertEq(balanceFiles.map((name) => readBalanceRows(path.join(env.storageRoot, 'exports', name)).map((row) => [row[4], Number(row[5])])),
    [[['2026-09-01', 110]], [['2026-09-02', 130]]], `Step20.余额链：两组余额文件的期末余额（${balanceFiles.join(',')}）`);

  // （7）真实会话：上一批成功导入 fileA、fileB 后覆盖导入同名文件（replacePaths 即这两个文件），第二组明细写出失败：
  //   会话条目、批次、当前批次与导出缓存都与失败前相同；重试成功后旧条目各替换一次，会话只剩本次的条目与批次
  const session = createStatementImportSession({ templateId: '__FILENAME_MAPPING__', templateName: '按文件名映射模板' });
  const overwrite = { session, replacePaths: [fileA, fileB] };
  assertEq(run(writeSources('12', '22'), templateA.id, overwrite), null, 'Step20.真实会话：上一批导入成功');
  const sessionState = () => JSON.stringify({
    importCount: session.importCount,
    currentBatchId: session.currentBatchId,
    batches: session.batches.map((batch) => [batch.id, batch.entryIds]),
    fileEntries: session.fileEntries.map((entry) => [entry.id, entry.filePath, entry.detailRows.length]),
    exports: env.lastGeneratedExports
  });
  const previousBatch = sessionState();
  const previousBatchId = session.currentBatchId;
  assertEq([session.fileEntries.length, session.batches.length], [2, 1], 'Step20.真实会话：上一批两个条目、一个批次');
  faults.failWriteAt = 2;
  const sessionError = run(writeSources('14', '24'), templateA.id, overwrite);
  faults.failWriteAt = 0;
  assertEq(sessionError && sessionError.code, 'EBUSY', 'Step20.真实会话：覆盖导入写出失败');
  assertEq(sessionState(), previousBatch, 'Step20.真实会话：失败后会话条目、批次、当前批次与导出缓存不变');
  assertEq(run(writeSources('14', '24'), templateA.id, overwrite), null, 'Step20.真实会话：重试成功');
  assertEq([session.importCount, session.fileEntries.length, session.batches.length], [2, 2, 1],
    'Step20.真实会话：重试后旧条目各替换一次，只剩本次的两个条目与一个批次');
  assertTrue(session.currentBatchId !== previousBatchId
    && session.batches[0].id === session.currentBatchId
    && session.fileEntries.map((entry) => entry.filePath).sort().join('|') === [fileA, fileB].sort().join('|'),
  `Step20.真实会话：当前批次为本次导入（${session.currentBatchId}）`);
}

// ⑳b v3.2.22 B45：导入入口对写出期间失败的处理（真实 createErrorResult，界面拿到的结果只有 message 等正式字段）。
//   系统异常（如文件被占用）且本批已完整还原：按未生效的导入返回（preservesSession），不清空上一批的导出缓存、
//   不替换上一批可导出的报错文件，写日志失败也照常返回；还原不完整时消息里给出未还原数量与恢复清单位置；
//   业务校验失败或未打标记的异常仍按失败的导入清空。
async function verifyRestoredImportFailureKeepsPreviousBatch(dir) {
  const env = createEnvironment(dir, 'step20b');
  const { createStatementOutputJournal } = require('../../src/main-process/statement-output-rollback');
  const target = path.join(dir, 'step20b-detail.xlsx');
  const failedError = (error, { incomplete = false } = {}) => {
    fs.writeFileSync(target, 'before');
    const journal = createStatementOutputJournal({ stagingRoot: dir });
    journal.write(target, () => fs.writeFileSync(target, 'after'));
    if (incomplete) fs.appendFileSync(target, '-external'); // 写完后被其他程序改动：不自动还原
    return journal.failBatch(error);
  };
  const previousReport = { fileName: '上一批的报错文件.txt' };
  // realPersistence：报错文件、诊断日志与活动日志都用 main.js 的真实写出函数（logger 落盘），由用例回读落盘内容（Codex 第十四轮）
  const createScope = (sideEffects, thrown, { logFails = false, reportFails = false, captured = null, realPersistence = false, extra = {} } = {}) => {
    const record = (name) => () => { sideEffects.push(name); };
    const scopeValues = {
      ...env.mainDeps,
      ...env.fns,
      fileImportInProgress: false,
      getEnumConfig: () => ({}),
      getStatementChannelMigrationPendingMessage: () => null,
      clearPendingManualBalancePrompt: record('clearPendingManualBalancePrompt'),
      clearPendingBigAccountSelection: record('clearPendingBigAccountSelection'),
      clearGeneratedExports: record('clearGeneratedExports'),
      statementDuplicateReview: { clear: record('statementDuplicateReview.clear') },
      executeFilenameMappingImportPlan: () => { throw thrown; },
      ensureStorageRoot: () => env.storageRoot,
      appendLog: () => {
        if (logFails) throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
        return 'logs/step20b.log';
      },
      appendActivityLogEntry: (entry) => {
        if (logFails) throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
        if (captured) captured.push(entry);
      },
      archiveOperationContext: { getStore: () => null },
      createErrorReport: (payload) => {
        if (captured) captured.push(payload);
        const { message } = payload;
        // 导出所在的数据目录已满：报错文件也写不出
        if (reportFails) throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
        return { fileName: `本次-${message.length}.txt` };
      },
      lastErrorReport: previousReport,
      ...extra
    };
    if (realPersistence) {
      delete scopeValues.appendLog;
      delete scopeValues.appendActivityLogEntry;
      delete scopeValues.createErrorReport;
      scopeValues.activityLogFilePath = path.join(env.storageRoot, 'app_activity_log.txt');
    }
    return createMainScope(scopeValues);
  };
  // 落盘内容：报错文件目录与日志目录下的全部文件（文件名与正文）
  const persistedDirs = ['error-reports', 'logs'].map((name) => path.join(env.storageRoot, name));
  const readPersisted = () => {
    const files = [];
    const walk = (current) => {
      if (!fs.existsSync(current)) return;
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) walk(full);
        else files.push({ relative: path.relative(env.storageRoot, full), text: fs.readFileSync(full, 'utf8') });
      }
    };
    persistedDirs.forEach(walk);
    return files;
  };
  const resetPersisted = () => persistedDirs.forEach((dirPath) => fs.rmSync(dirPath, { recursive: true, force: true }));
  const runExecute = async (thrown, options = {}) => {
    const sideEffects = [];
    const scope = createScope(sideEffects, thrown, options);
    const result = await scope.handleFilenameMappingImport({ previewOnly: false, statementImportPlan: { kind: 'filename-mapping' } });
    return { result, cleared: sideEffects.includes('clearGeneratedExports'), report: scope.lastErrorReport };
  };
  // 完成大账号选择后的执行入口：生成前后的同一处理（在会话准备处注入写出期间的失败）
  //   multiTemplate：两份文件匹配到不同模板，在多模板分组生成处注入失败（与真实入口相同的分支）
  const runSelectionExecute = async (thrown, { templateName = '按文件名映射', multiTemplate = false, ...options } = {}) => {
    const sideEffects = [];
    const scope = createScope(sideEffects, thrown, { ...options, extra: {
      checkImportConfigGuard: () => null,
      statementImportSessions: new Map(),
      requirePendingBigAccountSelection: () => ({
        templateId: 1, template: { name: templateName }, mappings: [], orderedTargetFields: [], fileEntries: []
      }),
      getOrCreateStatementImportSession: () => {
        if (multiTemplate) return { key: 'step20b' };
        throw thrown;
      },
      ...(multiTemplate ? {
        applyBigAccountAssignmentsToFileEntries: (entries) => entries,
        applyConfirmedDuplicateRowFilter: () => ({ entries: [{ matchedTemplateId: 1 }, { matchedTemplateId: 2 }] }),
        isFilenameMappingMode: () => true,
        resolvePendingReplacePaths: () => [],
        generateMultiTemplateGroupFiles: () => { throw thrown; }
      } : {})
    } });
    const handler = scope.nested('completeBigAccountSelectionHandler');
    const result = await handler.execute(null, {
      contextId: 'step20b', isFixedMode: false, normalizedAssignments: [], rememberOrder: false
    }, { fileEvidence: { filePlan: { inputs: [] } } });
    return { result, cleared: sideEffects.includes('clearGeneratedExports'), report: scope.lastErrorReport };
  };
  const busy = failedError(Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' })).error;
  assertEq(fs.readFileSync(target, 'utf8'), 'before', 'Step20b.前置：写出已还原');
  for (const logFails of [false, true]) {
    const restored = await runExecute(busy, { logFails });
    assertEq([restored.result.status, restored.result.preservesSession, restored.result.errorCode, restored.result.errorReportReady,
      restored.cleared, restored.report], ['error', true, 'FILE_IMPORT_RUNTIME', false, false, previousReport],
    `Step20b.已完整还原的系统异常${logFails ? '（写日志失败）' : ''}：按未生效的导入返回，不清空上一批的导出缓存、不替换上一批的报错文件`);
    assertTrue(/已还原为导入前的状态/.test(restored.result.message), `Step20b.提示已还原：${restored.result.message}`);
  }
  // 单模板（会话准备处）与多模板（多模板分组生成处，Codex 第十五轮）两条分支
  for (const multiTemplate of [false, true]) {
    const selectionRestored = await runSelectionExecute(busy, { multiTemplate });
    assertEq([selectionRestored.result.status, selectionRestored.result.preservesSession, selectionRestored.result.errorCode,
      selectionRestored.result.errorReportReady, selectionRestored.cleared, selectionRestored.report],
    ['error', true, 'BIG_ACCOUNT_SELECTION_RUNTIME', false, false, previousReport],
    `Step20b.完成大账号选择后${multiTemplate ? '多模板生成' : ''}执行期写出失败、已完整还原：同样按未生效的导入返回，保留上一批的导出缓存与报错文件`);
  }
  const plain = await runExecute(Object.assign(new Error('EBUSY'), { code: 'EBUSY' }));
  assertEq([plain.result.preservesSession, plain.cleared], [undefined, true], 'Step20b.未经回滚的异常仍按失败的导入清空');
  const business = await runExecute(failedError(new FileValidationError('FILE_READ', '合并失败', { detailLines: ['明细'] })).error);
  assertEq([business.result.preservesSession, business.result.errorReportReady, business.cleared], [undefined, true, true],
    'Step20b.写出阶段的业务校验失败仍按失败的导入处理，可导出报错文件');
  const { error: incompleteError, outcome } = failedError(Object.assign(new Error('EBUSY'), { code: 'EBUSY' }), { incomplete: true });
  const incomplete = await runExecute(incompleteError);
  assertEq([incomplete.result.status, incomplete.result.preservesSession, incomplete.cleared], ['error', undefined, true],
    'Step20b.还原不完整：按失败的导入处理');
  assertTrue(incomplete.result.message.includes('有 1 处输出未能自动还原')
    && incomplete.result.message.includes(`恢复清单：${outcome.manifestPath}`),
  `Step20b.还原不完整时界面消息给出数量与恢复清单位置：${incomplete.result.message}`);
  // 报错文件也写不出（数据目录已满，正是还原失败的常见原因）：仍返回恢复指引，不被写报错文件的异常盖掉
  for (const [label, run] of [['导入入口', runExecute], ['完成大账号选择', runSelectionExecute]]) {
    const unreported = await run(incompleteError, { reportFails: true });
    assertEq([unreported.result.status, unreported.result.errorCode, unreported.result.errorReportReady, unreported.report],
      ['error', 'STATEMENT_OUTPUT_ROLLBACK_INCOMPLETE', false, previousReport],
      `Step20b.${label}：还原不完整且报错文件写不出时仍返回业务错误，不替换上一批的报错文件`);
    assertTrue(unreported.result.message.includes(`恢复清单：${outcome.manifestPath}`),
      `Step20b.${label}：报错文件写不出时消息仍给出恢复清单位置：${unreported.result.message}`);
  }
  // 完成大账号选择后多模板生成失败（还原不完整、导出位置不安全且已完整还原）：首个匹配模板的真实名称（可能含完整账号）
  //   不写入报错文件与活动日志（Codex 第七、八轮）
  const unsafeError = failedError(new FileValidationError('STATEMENT_OUTPUT_TARGET_UNSAFE',
    '导出位置有同名的快捷方式（符号链接）或文件夹，无法安全覆盖，请移走后重新导入', { detailLines: [`所在目录：${dir}`] })).error;
  // 各组的业务校验错误在上下文中带该组模板的真实名称；未经回滚的系统异常走另一分支（Codex 第九轮）
  const groupError = new FileValidationError('FILE_READ', '存在1条明细的 Credit Amount 与 Debit Amount 同时有值', {
    detailLines: ['第2行，Credit Amount="1"，Debit Amount="2"'], context: { templateName: '中行-6222020200012345678' } });
  // 回读真实写出的报错文件（文件名与正文）和日志：都不含完整账号，报错文件用固定名称
  const assertPersistedMasked = (label) => {
    const files = readPersisted();
    const reports = files.filter((file) => file.relative.startsWith('error-reports') && file.relative.endsWith('.txt'));
    const logs = files.filter((file) => file.relative.startsWith('logs'));
    const leaked = files.filter((file) => file.relative.includes('6222020200012345678') || file.text.includes('6222020200012345678'));
    assertTrue(reports.length === 1 && logs.length >= 1 && leaked.length === 0,
      `Step20b.${label}：落盘的报错文件与日志不含真实模板名：${JSON.stringify(files.map((file) => [file.relative, file.text.slice(0, 160)]))}`);
    // 命名契约单独核对：报错文件名用固定名称（正文的上下文本来就含该名称，Codex 第十五轮）
    assertTrue(reports.every((file) => path.basename(file.relative).includes('按文件名映射模板')),
      `Step20b.${label}：报错文件名用固定模板名：${reports.map((file) => path.basename(file.relative)).join('、')}`);
  };
  for (const [label, thrown, expected] of [['还原不完整', incompleteError, '未能自动还原'], ['导出位置不安全', unsafeError, '无法安全覆盖'],
    ['组内业务校验失败', groupError, '同时有值'], ['系统异常', Object.assign(new Error('EIO'), { code: 'EIO' }), '文件转换错误']]) {
    resetPersisted();
    const named = await runSelectionExecute(thrown, { templateName: '中行-6222020200012345678', multiTemplate: true, realPersistence: true });
    assertTrue(named.result.message.includes(expected), `Step20b.前置：完成大账号选择后${label}：${named.result.message}`);
    assertPersistedMasked(`完成大账号选择后${label}`);
  }
  // 直接导入入口（按文件名映射）：组内业务校验错误上下文中的真实模板名同样被固定名称覆盖（Codex 第九轮）
  resetPersisted();
  const direct = await runExecute(groupError, { realPersistence: true });
  assertTrue(direct.result.message.includes('同时有值'), `Step20b.前置：直接导入时组内业务校验失败：${direct.result.message}`);
  assertPersistedMasked('直接导入时组内业务校验失败');
  fs.rmSync(outcome.backupDirectory, { recursive: true, force: true });
}

// ⑱ PR #246 审查：目标渠道账户号有待处理冲突（候选 OLD1 / OLD2）、待加入模板维护该账户号为 NEW。只比较生效映射会放行加入，
//    NEW 写入渠道而不在候选里，之后处理冲突被所选候选覆盖、账户血缘丢失。加入前一并核对待处理冲突。
function verifyJoinChecksPendingConflicts(dir) {
  const env = createEnvironment(dir, 'step18');
  const owner = env.defineTemplate('招商银行-上海', 'A');
  const child = env.defineTemplate('CMB-SH', 'B');
  const raw = env.database.db;
  raw.prepare('UPDATE templates SET is_parent = 1 WHERE id = ?').run(owner.id);
  raw.prepare('UPDATE templates SET parent_template_id = ? WHERE id = ?').run(owner.id, child.id);
  env.database.saveAccountMappings({ templateId: owner.id }, [{ bankAccountId: 'RAW001', clearingAccountId: 'OLD1' }]);
  env.database.saveAccountMappings({ templateId: child.id }, [{ bankAccountId: 'RAW001', clearingAccountId: 'OLD2' }]);
  assertEq(env.database.runStatementChannelMigration().conflictCount, 1, 'Step18.前置：迁移登记 RAW001 冲突');
  const channel = env.database.getStatementChannelByName('招商银行-上海');
  const candidates = () => env.database.listStatementChannelAccountMappingConflicts(channel.id)
    .flatMap((item) => item.conflicts.flatMap((conflict) => conflict.candidates.map((candidate) => candidate.clearingAccountId))).sort();
  const joiner = env.defineTemplate('招行-浦东', 'C');
  env.database.saveAccountMappings({ templateId: joiner.id }, [{ bankAccountId: 'RAW001', clearingAccountId: 'NEW' }]);
  const tryJoin = () => {
    try {
      env.saveWithChannel(joiner, { mode: 'join', channelId: channel.id });
      return null;
    } catch (error) {
      return error;
    }
  };
  const pendingError = tryJoin();
  assertEq(pendingError && [pendingError.code, pendingError.detailLines.length], ['CHANNEL_ACCOUNT_MAPPING_CONFLICT_PENDING', 1],
    'Step18.加入被阻断并列出冲突账户号');
  assertEq(env.database.getTemplate(joiner.id).channelId, null, 'Step18.模板仍为普通模板');
  assertEq(env.database.listAccountMappings({ templateId: joiner.id }).map((m) => [m.bankAccountId, m.clearingAccountId]), [['RAW001', 'NEW']],
    'Step18.模板映射保留');
  assertEq(env.database.listAccountMappings({ channelId: channel.id }).map((m) => m.clearingAccountId), [], 'Step18.NEW 未写入渠道');
  assertEq(candidates(), ['OLD1', 'OLD2'], 'Step18.冲突候选不变');
  const pending = env.database.listStatementChannelAccountMappingConflicts(channel.id)[0].conflicts[0].candidates.map((c) => c.clearingAccountId);
  env.database.resolveStatementChannelAccountMappingConflicts(channel.id, [{ bankAccountId: 'RAW001', candidateIndex: pending.indexOf('OLD2') }]);
  const a9Error = tryJoin();
  assertEq(a9Error && a9Error.code, 'CHANNEL_ACCOUNT_MAPPING_CONFLICT', 'Step18.处理冲突后按 A9 比较生效映射，设置不同仍阻断');
  assertEq(env.database.listAccountMappings({ channelId: channel.id }).map((m) => [m.bankAccountId, m.clearingAccountId]), [['RAW001', 'OLD2']],
    'Step18.渠道保留所选候选');
}

// ⑲ PR #246 审查：渠道迁移备份失败（或事务回滚）后旧主/子标记保留、模板未归入渠道。月度余额只按 channelId 排除渠道模板，
//    主、子模板维护同一账号时同一余额输出两次；迁移完成前网银账单导入（两个入口）与月度余额装配都被阻断，重试成功后解除。
function verifyMigrationFailureBlocksStatementOperations(dir) {
  const env = createEnvironment(dir, 'step19');
  const owner = env.defineTemplate('招商银行-上海', 'A');
  const child = env.defineTemplate('招商银行-上海-B', 'B');
  for (const template of [owner, child]) {
    env.database.saveMappings(template.id, env.exportMappingsByTemplateId.get(template.id), [{ merchantId: 'M001', currency: 'USD' }]);
  }
  const raw = env.database.db;
  raw.prepare('UPDATE templates SET is_parent = 1 WHERE id = ?').run(owner.id);
  raw.prepare('UPDATE templates SET parent_template_id = ? WHERE id = ?').run(owner.id, child.id);
  seed(env, '招商银行-上海', 'M001', 'USD', '2026-08-31', 1000);
  env.database.createBackup = () => { throw new Error('backup directory not writable'); };
  assertEq(env.database.runStatementChannelMigration().status, 'backup-failed', 'Step19.前置：备份失败，迁移未执行');
  const assemble = () => assembleMonthlyBalance({
    templateScope: ALL_BANKS_TEMPLATE_SCOPE, year: 2026, month: 8, db: env.database, storageRoot: env.storageRoot
  }).records.map((record) => [record.templateName, record.merchantId, record.endBalance]).sort();
  assertEq(assemble(), [['招商银行-上海', 'M001', 1000], ['招商银行-上海-B', 'M001', 1000]],
    'Step19.风险前提：迁移未完成时按渠道模型装配，同一账号余额输出两次');
  const gate = loadMainFunctions(['getStatementChannelMigrationPendingMessage'], { database: env.database }).getStatementChannelMigrationPendingMessage;
  assertTrue(/数据迁移尚未完成/.test(gate()), 'Step19.迁移未完成：阻断提示');
  assertTrue(statementOperationsGatedByChannelMigration(), 'Step19.两个导入入口与月度余额装配在实际处理前核对迁移状态');

  delete env.database.createBackup;
  assertEq(env.database.runStatementChannelMigration().status, 'migrated', 'Step19.下次启动重试成功');
  assertEq(gate(), '', 'Step19.迁移完成后解除阻断');
  assertEq(assemble(), [], 'Step19.迁移完成后渠道模板不在月度余额范围（A7），不再重复');
}

function statementOperationsGatedByChannelMigration() {
  const gateCall = 'getStatementChannelMigrationPendingMessage()';
  const node = MAIN_AST.body.find((item) => item.type === 'FunctionDeclaration' && item.id && item.id.name === 'handleFilenameMappingImport');
  const filenameMapping = MAIN_SOURCE.slice(node.start, node.end);
  const designated = MAIN_SOURCE.slice(MAIN_SOURCE.indexOf('const fileImportHandler = {'), MAIN_SOURCE.indexOf('let preparedFiles;'));
  const monthly = MAIN_SOURCE.slice(
    MAIN_SOURCE.indexOf("trackedIpcHandle('monthly-balance:assemble'"),
    MAIN_SOURCE.indexOf("trackedIpcHandle('monthly-balance:export'")
  );
  const filenameGate = filenameMapping.indexOf(gateCall);
  const monthlyGate = monthly.indexOf(gateCall);
  return filenameGate > 0 && filenameGate < filenameMapping.indexOf('fileImportInProgress = true;')
    && designated.includes(gateCall)
    && monthlyGate > 0 && monthlyGate < monthly.indexOf('assembleMonthlyBalance({');
}

async function run() {
  console.log('==== 网银账单渠道与子模板 e2e 集成验证 ====');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stmt-channel-'));
  try {
    verifyChannelGroup(dir);
    verifyMixedBalanceModes(dir);
    await verifyDirectImportRejectsInjectedConflict(dir);
    await verifyBigAccountCompletionRejectsInjectedConflict(dir);
    await verifyBigAccountSelectionDefersProvisionalConflict(dir);
    await verifyAutoBigAccountUsesInjectedRows(dir);
    verifyMixedGroups(dir);
    verifyCalculatedSeedAndGap(dir);
    verifyLegacyMigration(dir);
    verifyMixedMerchantMappings(dir);
    verifyConflictBlocksImport(dir);
    verifyOutputNameConflictGuard(dir);
    verifyBundleSkippedTemplateKeepsChannel(dir);
    verifyBundleSkippedSameNameChannelKeepsMappings(dir);
    verifyOutputNameConflictAcrossBatches(dir);
    verifyLegacyBundleSkippedParent(dir);
    verifyOutputNameConflictFileNameKey(dir);
    verifyLegacyBundleMultiLevelSkippedParent(dir);
    verifyMultiTemplateGenerationStaleState(dir);
    verifyOutputPathConcatenationConflict(dir);
    verifyMultiTemplateGenerationRollback(dir);
    await verifyRestoredImportFailureKeepsPreviousBatch(dir);
    verifyJoinChecksPendingConflicts(dir);
    verifyMigrationFailureBlocksStatementOperations(dir);
  } finally {
    openedDatabases.splice(0).forEach((database) => {
      try { database.close(); } catch (error) { console.error('关闭测试主库失败', error); }
    });
    fs.rmSync(dir, { recursive: true, force: true });
  }

  const total = passed + failed;
  console.log(`\n==== ${passed}/${total} PASS ====`);
  if (failed > 0) {
    console.error('FAILURES:');
    failures.forEach((f) => {
      console.error(`  - ${f.label}: actual=${JSON.stringify(f.actual)} expected=${JSON.stringify(f.expected)}`);
    });
    process.exit(1);
  }
}

run().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
