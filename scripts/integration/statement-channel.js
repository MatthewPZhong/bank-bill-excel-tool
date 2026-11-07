// 网银账单：渠道与子模板（v3.2.15）e2e 集成验证
//   覆盖：真实主库（渠道、归属、渠道账户映射、迁移）+ 真实 xlsx 读取与写出 + main.js 中的真实分组、生成配置与导入校验函数
//   ① 渠道两个子模板、两个文件含同一账号：一份明细、一份余额，Channel 列与余额银行名称/所在地取渠道名，
//      余额跨文件连续，计算种子写在渠道银行段的种子文件；文件名用渠道名
//   ② 余额方式不一致：保存映射被拒；绕过保存（直接写库）后导入整批阻断，导出目录没有新文件
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
  FileValidationError,
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

const ROOT = path.join(__dirname, '..', '..');
const MAIN_SOURCE = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
const MAIN_AST = acorn.parse(MAIN_SOURCE, { ecmaVersion: 'latest', sourceType: 'script' });
const ORDERED_FIELDS = ['BillDate', 'MerchantId', 'Currency', 'Credit Amount', 'Debit Amount', 'Channel'];
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

// ===== 测试数据 =====

const LAYOUTS = {
  A: { headers: ['Date', 'Account', 'Curr', 'Credit', 'Debit'], map: { BillDate: 'Date', MerchantId: 'Account', Currency: 'Curr', 'Credit Amount': 'Credit', 'Debit Amount': 'Debit' } },
  B: { headers: ['TxnDate', 'Acct', 'Ccy', 'In', 'Out'], map: { BillDate: 'TxnDate', MerchantId: 'Acct', Currency: 'Ccy', 'Credit Amount': 'In', 'Debit Amount': 'Out' } },
  C: { headers: ['D', 'A', 'C', 'Cr', 'Dr'], map: { BillDate: 'D', MerchantId: 'A', Currency: 'C', 'Credit Amount': 'Cr', 'Debit Amount': 'Dr' } }
};

function exportMappingsFor(layout, { balance = '通过发生额计算', merchant = null } = {}) {
  const map = LAYOUTS[layout].map;
  return [
    ...Object.entries(map).map(([templateField, mappedField]) => ({
      templateField,
      mappedField: templateField === 'MerchantId' && merchant ? merchant : mappedField,
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
      bigAccounts: []
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
    ADVANCED_MAPPING_FIELDS: [],
    BALANCE_DISABLED_OPTION: '无',
    BALANCE_CALCULATED_OPTION: '通过发生额计算',
    CONCAT_FIELDS_MAPPING_FIELD: '__CONCAT__',
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
    findBalanceModeMismatch: channelIdentity.findBalanceModeMismatch,
    buildPreparedStatementBatchFromEntries: generation.buildPreparedStatementBatchFromEntries,
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
    'buildStatementGenerationConfig',
    'buildMappedRowsForFile',
    'getEntryTemplateConfig',
    'rebuildMatchedTemplateFileEntries',
    'groupStatementEntriesForGeneration',
    'findGenerationGroupBalanceModeMismatch',
    'buildChannelBalanceModeMismatchError',
    'generateMultiTemplateGroupFiles',
    'planVirtualTemplateBalanceRegeneration',
    'assertVirtualTemplateBalanceOutputPaths',
    'regenerateVirtualTemplateBalanceFromSession',
    'normalizeTemplateChannelAssignment',
    'findSaveMappingsBalanceModeMismatch',
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

function readRowsFromEntry(entry, names) {
  const [header, ...rows] = entry.detailRows;
  return rows.map((row) => names.map((name) => row[header.indexOf(name)]));
}

// ②
function verifyBalanceModeMismatch(dir) {
  const env = createEnvironment(dir, 'step2');
  const owner = env.defineTemplate('招商银行-上海', 'A');
  const channelId = env.saveWithChannel(owner, { mode: 'create' }).channelId;
  const child = env.defineTemplate('CMB-SH', 'B', { balance: 'Balance' });
  const mismatch = env.fns.findSaveMappingsBalanceModeMismatch({
    template: env.database.getTemplate(child.id),
    channelAssignment: env.fns.normalizeTemplateChannelAssignment({ mode: 'join', channelId }),
    mappings: env.exportMappingsByTemplateId.get(child.id)
  });
  assertEq(mismatch && mismatch.detailLines, ['CMB-SH：取账单余额列', '招商银行-上海：通过发生额计算'], 'Step2.保存映射时余额方式不一致被拒');
  // 绕过保存：直接写库加入渠道
  env.database.restoreTemplateBundleStatementChannels({ channels: [], legacyChannelSources: [], assignments: [{ templateId: child.id, channelName: '招商银行-上海' }] });
  const { fileA, fileB } = prepareChannelFiles(dir, 'step2');
  const entries = [env.entryFor(owner, fileA), env.entryFor(child, fileB)];
  const groups = env.fns.groupStatementEntriesForGeneration(entries);
  assertEq(groups.length, 1, 'Step2.两个子模板同组');
  const lines = env.fns.findGenerationGroupBalanceModeMismatch(groups[0]);
  assertEq(lines, ['招商银行-上海：通过发生额计算', 'CMB-SH：取账单余额列'], 'Step2.导入时整批校验发现不一致');
  const error = env.fns.buildChannelBalanceModeMismatchError(groups[0], lines);
  assertEq([error.code, /招商银行-上海/.test(error.message)], ['CHANNEL_BALANCE_MODE_MISMATCH', true], 'Step2.阻断错误码与渠道名');
  assertEq(env.exportFiles(), [], 'Step2.导出目录没有新文件');
  assertTrue(importChecksPrecedeGeneration(), 'Step2.导入入口在大账号选择与生成之前完成渠道校验');
}

// 导入入口：渠道校验（余额方式、待处理冲突）位于大账号聚合与生成之前。
function importChecksPrecedeGeneration() {
  const node = MAIN_AST.body.find((item) => item.type === 'FunctionDeclaration' && item.id && item.id.name === 'handleFilenameMappingImport');
  const body = MAIN_SOURCE.slice(node.start, node.end);
  const check = body.indexOf('findGenerationGroupBalanceModeMismatch(group)');
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
    verifyBalanceModeMismatch(dir);
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
