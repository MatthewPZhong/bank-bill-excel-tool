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
  cloneRowsWithMetadata,
  getStatementSessionEntries,
  mergeMappedDetailRows,
  normalizeInputFilePaths,
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

function createEnvironment(dir, label) {
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
    appendLog: (_root, error) => { throw error; },
    buildDateRangeLabel,
    buildDetailExportRows,
    buildFieldIndexMap,
    buildStatementOutputFilePath: fns.buildStatementOutputFilePath,
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
    storeGeneratedBalanceSeeds: ({ templateName, seedRecords }) => {
      seedRecords.forEach((record) => upsertBalanceSeedRecord(storageRoot, { templateName, ...record, overwrite: true }));
    },
    writeBalanceWorkbook,
    writeWorkbookRows
  });

  const removedSessionPaths = [];
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
    removeStatementSessionEntriesByFilePath: (_session, filePath) => { removedSessionPaths.push(filePath); },
    generateStatementFiles: generation.generateStatementFiles,
    parseRequiredBillDates,
    buildDateRangeLabel,
    getToday: () => TODAY,
    buildOutputFilePath: fns.buildOutputFilePath,
    mergeGeneratedXlsxFiles: loadMainFunctions(['mergeGeneratedXlsxFiles'], { require, fs, path, applyWatermark: () => {} }).mergeGeneratedXlsxFiles,
    buildStatementFileEntry: (entry) => entry,
    buildStatementFileEntryId: () => 'entry',
    appendStatementSessionImport: () => 'batch',
    buildStatementBatchId: () => 'batch',
    lastGeneratedExports,
    updateStatementSessionCache: (session, batchId, generatedFiles) => {
      generation.updateStatementSessionCache(session, batchId, generatedFiles, lastGeneratedExports);
    },
    buildImportResultFromGeneratedFiles: ({ generatedFiles }) => {
      imported.push(generatedFiles);
      return { status: 'captured' };
    },
    FILENAME_MAPPING_TEMPLATE_ID: '__FILENAME_MAPPING__',
    appendActivityLogEntry: () => {},
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
    'assertStatementBatchWritable',
    'assertStatementEntriesWritable',
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

// 记录 fn 执行期间业务代码对路径中含 markers 的文件 / 目录的任何访问（读、查存在、列目录、写、删）
async function watchFsAccess(markers, fn) {
  const methods = ['readFileSync', 'openSync', 'existsSync', 'statSync', 'lstatSync', 'accessSync', 'readdirSync', 'writeFileSync',
    'renameSync', 'unlinkSync', 'rmSync', 'copyFileSync', 'mkdirSync', 'createReadStream', 'readFile', 'open', 'stat', 'readdir', 'writeFile'];
  const promiseMethods = ['readFile', 'open', 'stat', 'readdir', 'writeFile', 'access', 'rename', 'unlink', 'rm'];
  const touched = [];
  const hit = (method, args) => {
    const target = String(args[0] == null ? '' : args[0]);
    if (markers.some((marker) => target.includes(marker))) touched.push(`${method}:${path.basename(target)}`);
  };
  const originals = [];
  const wrap = (owner, name, label) => {
    if (typeof owner[name] !== 'function') return;
    const original = owner[name];
    originals.push([owner, name, original]);
    owner[name] = function watched(...args) { hit(label, args); return original.apply(this, args); };
  };
  methods.forEach((name) => wrap(fs, name, name));
  promiseMethods.forEach((name) => wrap(fs.promises, name, `promises.${name}`));
  try {
    return { result: await fn(), touched };
  } finally {
    originals.reverse().forEach(([owner, name, original]) => { owner[name] = original; });
  }
}

// (h2) v3.2.22 去掉「账号顺序固定」：升级前留下的固定模式与记住的顺序文件不再读取——多大账号导入仍进入手动选择，
//   选择结果不带 forceMode / 含空段的行；完成选择后照常生成，整个过程不读取、不改写这些文件
async function verifyResidualFixedOrderFilesIgnored(dir) {
  const env = createEnvironment(dir, 'step2h2');
  const owner = env.defineTemplate('招商银行-上海', 'A', { balance: '无', merchant: `${FIXED}M601` });
  const channelId = env.saveWithChannel(owner, { mode: 'create' }).channelId;
  const child = env.defineTemplate('CMB-SH', 'D', { balance: 'Bal', merchant: `${FIXED}${MULTI}` });
  env.saveWithChannel(child, { mode: 'join', channelId });
  env.bigAccountsByTemplateId.set(child.id, [{ merchantId: 'M601', currencies: ['USD'] }, { merchantId: 'M602', currencies: ['USD'] }]);
  const fileA = path.join(dir, 'step2h2-a.xlsx');
  const fileB = path.join(dir, 'step2h2-b.xlsx');
  writeSource(fileA, 'A', [['2026-09-01', 'IGNORED', 'USD', '1', '']]);
  writeSource(fileB, 'D', [['2026-09-01', 'IGNORED', 'USD', '2', '', '12']]);
  // 与 v3.2.21 big-account-mode-store / big-account-order-store 相同的文件格式；按文件名映射入口与各模板 id 都写一份
  const residualFiles = [];
  for (const templateId of ['__FILENAME_MAPPING__', owner.id, child.id]) {
    for (const [folder, payload] of [
      ['big-account-modes', { templateId: String(templateId), mode: 'fixed', updatedAt: '2026-11-01T00:00:00.000Z' }],
      ['big-account-orders', {
        templateId: String(templateId),
        assignments: [{ rowIndex: 0, merchantId: 'M601', currency: 'USD' }, { rowIndex: 1, merchantId: 'M602', currency: 'USD' }],
        fileCount: 2,
        files: [
          { fileIndex: 0, accountCount: 1, accounts: [{ merchantId: 'M601', currency: 'USD' }] },
          { fileIndex: 1, accountCount: 1, accounts: [{ merchantId: 'M602', currency: 'USD' }] }
        ],
        updatedAt: '2026-11-01T00:00:00.000Z'
      }]
    ]) {
      const filePath = path.join(env.storageRoot, folder, `${templateId}.json`);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
      residualFiles.push(filePath);
    }
  }
  const snapshot = () => residualFiles.map((filePath) => fs.readFileSync(filePath, 'utf8'))
    .concat(['big-account-modes', 'big-account-orders'].map((folder) => fs.readdirSync(path.join(env.storageRoot, folder)).sort().join(',')));
  const before = snapshot();

  const scope = createMainScope({
    ...env.mainDeps,
    ...env.fns,
    fileImportInProgress: false,
    lastPendingBigAccountSelection: null,
    lastFileImportContext: null,
    statementImportSessions: new Map(),
    getEnumConfig: () => ({}),
    getStatementChannelMigrationPendingMessage: () => null,
    clearPendingManualBalancePrompt: () => {},
    clearGeneratedExports: () => {},
    statementDuplicateReview: { clear: () => {}, cancel: () => {}, review: ({ entries }) => ({ status: 'ok', entries }) },
    executeFilenameMappingImportPlan: () => {},
    ensureStorageRoot: () => env.storageRoot,
    createErrorResult: (payload) => ({ status: 'error', ...payload }),
    appendActivityLogEntry: () => {}
  });
  const prepared = { previewOnly: true, inputFilePaths: [fileA, fileB], selectionResult: { filePaths: [fileA, fileB] } };
  const { result: run, touched } = await watchFsAccess(['big-account-modes', 'big-account-orders'], async () => {
    const preview = await scope.handleFilenameMappingImport(prepared);
    const contextId = scope.rememberPendingBigAccountSelection(prepared.pendingBigAccountSelection);
    const rows = prepared.pendingBigAccountSelection.rows;
    const handler = scope.nested('completeBigAccountSelectionHandler');
    const outcome = scope.markContinuationPrepareRejection(await handler.prepare(null, {
      contextId,
      // 旧版界面会多带 mode / rememberOrder：忽略，按不固定口径校验
      mode: 'fixed',
      rememberOrder: true,
      assignments: rows.map((row) => ({ index: row.index, merchantId: row.filePath === fileA ? 'M601' : 'M602', currency: 'USD' }))
    }), { keepErrorCodes: ['BIG_ACCOUNT_SELECTION_INVALID'] });
    const generated = outcome.proceed
      ? await handler.execute(null, outcome, { fileEvidence: { filePlan: outcome.filePlan } })
      : null;
    return { preview, rows, outcome, generated };
  });
  assertEq([
    run.preview && run.preview.status,
    Object.hasOwn(run.preview || {}, 'forceMode'),
    Object.hasOwn(run.preview || {}, 'rowsWithEmptyBlocks'),
    run.rows.length
  ], ['select-big-account', false, false, 2], 'Step2h2.残留固定模式与记住的顺序时仍进入手动选择，不自动分配');
  assertEq([run.outcome.proceed, run.outcome.result], [true, undefined], 'Step2h2.手动选择完成照常放行');
  assertEq([run.generated && run.generated.status, env.exportFiles().length > 0], ['captured', true], 'Step2h2.按所选账号照常生成');
  const probe = await watchFsAccess(['big-account-modes'], async () => fs.readFileSync(residualFiles[0], 'utf8'));
  assertEq(probe.touched, [`readFileSync:${path.basename(residualFiles[0])}`], 'Step2h2.前提：访问记录能观测到对残留文件的读取');
  assertEq(touched, [], 'Step2h2.导入预检、完成选择与生成全程不访问残留的模式 / 顺序文件');
  assertEq(snapshot(), before, 'Step2h2.残留文件原样保留');
}

// (h3) v3.2.22 按文件名映射入口（真实读取与映射）：MerchantId 由大账号决定的模板，整批原表只有表头时在混合模式检查、
//   直接识别与手动选择之前报「没有交易数据」，预检阶段按未开始导入处理（保留上一批界面）；混有交易文件时只为它留选择位置
async function verifyFilenameMappingHeaderOnlyBatch(dir) {
  const env = createEnvironment(dir, 'step2h3');
  const template = env.defineTemplate('CMB-SH', 'D', { balance: 'Bal', merchant: `${FIXED}${MULTI}` });
  env.saveWithChannel(template, { mode: 'create' });
  env.bigAccountsByTemplateId.set(template.id, [{ merchantId: 'M601', currencies: ['USD'] }, { merchantId: 'M602', currencies: ['USD'] }]);
  const emptyA = path.join(dir, 'step2h3-empty-a.xlsx');
  const emptyB = path.join(dir, 'step2h3-empty-b.xlsx');
  const withRows = path.join(dir, 'step2h3-rows.xlsx');
  writeSource(emptyA, 'D', []);
  writeSource(emptyB, 'D', []);
  writeSource(withRows, 'D', [['2026-09-01', 'IGNORED', 'USD', '2', '', '12']]);
  const run = async (filePaths) => {
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
      ensureStorageRoot: () => env.storageRoot,
      createErrorResult: (payload) => ({ status: 'error', ...payload }),
      appendActivityLogEntry: () => {}
    });
    const prepared = { previewOnly: true, inputFilePaths: filePaths, selectionResult: { filePaths } };
    return { result: await scope.handleFilenameMappingImport(prepared), prepared };
  };
  const headerOnly = await run([emptyA, emptyB]);
  assertEq([
    headerOnly.result && headerOnly.result.status,
    headerOnly.result && headerOnly.result.errorCode,
    headerOnly.result && headerOnly.result.message,
    headerOnly.result && headerOnly.result.preservesSession,
    headerOnly.prepared.pendingBigAccountSelection || null
  ], ['error', 'NO_TRANSACTION_DATA', '导入文件中没有账号存在交易数据', true, null], 'Step2h3.整批只有表头：报没有交易数据，按未开始导入处理，不进入大账号选择');
  // 一个候选大账号（直接识别）、没有候选大账号（只维护了自有账号）：同样在识别前拦截，不误报未识别到大账号
  for (const [label, bigAccounts] of [['一个候选大账号', [{ merchantId: 'M601', currencies: ['USD'] }]], ['没有候选大账号', []]]) {
    env.bigAccountsByTemplateId.set(template.id, bigAccounts);
    const { result } = await run([emptyA, emptyB]);
    assertEq([result && result.errorCode, result && result.preservesSession], ['NO_TRANSACTION_DATA', true], `Step2h3.整批只有表头（${label}）`);
  }
  env.bigAccountsByTemplateId.set(template.id, [{ merchantId: 'M601', currencies: ['USD'] }, { merchantId: 'M602', currencies: ['USD'] }]);
  const mixed = await run([emptyA, withRows]);
  assertEq([mixed.result && mixed.result.status, (mixed.result && mixed.result.rows || []).map((row) => row.fileName)],
    ['select-big-account', ['step2h3-rows.xlsx']], 'Step2h3.混有交易文件：只为有交易的文件留选择位置');
  assertEq(env.exportFiles(), [], 'Step2h3.预检不产出文件');
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
    await verifyResidualFixedOrderFilesIgnored(dir);
    await verifyFilenameMappingHeaderOnlyBatch(dir);
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
