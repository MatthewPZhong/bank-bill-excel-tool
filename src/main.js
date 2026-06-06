const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os'); // v2.1.12 β.1-T3：多 worker D33 OOM clamp（cpus / freemem）
const XLSX = require('xlsx');
const { performance } = require('node:perf_hooks');
const { app, BrowserWindow, dialog, ipcMain, nativeImage, Notification } = require('electron');
const { AppDatabase } = require('./backend/database');
const { openPendingDb, PENDING_DB_FILENAME } = require('./backend/pending-db');
const PENDING_COLUMNS = require('./backend/pending-db/columns');
const pendingRuleRepo = require('./backend/pending-db/rule-repository');
const pendingMonthRepo = require('./backend/pending-db/month-repository');
const pendingDiffRepo = require('./backend/pending-db/diff-repository');
const pendingReconcileEngine = require('./backend/pending-reconcile/engine');
const pendingExportWriter = require('./backend/pending-export/writer');
// v2.1.11 T2 移除核对：移除归档文件 reader + 入库 repo + 对账后 missing↔移除 匹配
const pendingRemovedReader = require('./backend/pending-import/removed-reader');
const pendingRemovedRepo = require('./backend/pending-db/removed-repository');
const pendingRemovalMatch = require('./backend/pending-reconcile/removal-match');
const { createPendingSession } = require('./main-process/pending-session');
const { applyWatermark } = require('./main-process/workbook-watermark');
// v2.1.6 Module B T9：收单单据币种校验 — session + writer
const acquiringBillCurrencySession = require('./main-process/acquiring-bill-currency-session');
// v2.1.8 N1：before-quit 钩子需 module-level runRepo（IPC handler 内 require 来不及）
const runRepo = require('./backend/acquiring-bill-currency-db/run-repository');
// v2.1.10 A3 T10：runCheck 跨进程化 — worker pool 在主进程单例
//   - dispatchRunCheck：IPC handler 调用入口（替代 session.runCheck 直调）
//   - cancel：acquiringBillCurrency:run:cancel handler 转发用
//   - isBusy：N1' idle cleanup 协调用（Phase 2 T12）
//   - shutdown：app.before-quit 时清理（Phase 2 T15）
const runCheckWorkerPool = require('./main-process/run-check-worker-pool');
// v2.1.10 N4-cont-1 T23 (Phase 4)：raw_json idle 自动清理函数
//   - 复用 v2.1.9 N1' idle 30min cleanup 计时器（spec §4.3.1）
//   - 仅清「对账成功」（不在 diff_rows）且 imported_at < retentionDays 天前的 bill_imports.raw_json
//   - 差异行 raw_json 永远保留（writer.js:184 重导差异 xlsx 依赖）
const { clearStaleSuccessfulRawJson } = require('./backend/acquiring-bill-currency-db/raw-json-retention');

// v2.1.8 N1' (v0.7)：idle 30min 自动 cleanup 计时器（spec §3.2.2 N1''-D6 ~ D13）
//   - lastActivityTs：renderer 上报的用户最后活动时间（IPC `app:user-activity`），main 也用 mutex 间接判定（D6 AND 设计）
//   - IDLE_CLEANUP_MS：闲置阈值
//     v2.1.8：常量硬编码 30min（D8）
//     v2.1.9 N1-settings (T32c, D21=c)：改 settings 化（5-180 分钟可调，默认 30）；启动期从 DB 读
//       D21=c 决议：不提供 UI 设置入口，用户需用 sqlite3 客户端 UPDATE app_settings 后重启应用生效
//   - IDLE_CHECK_INTERVAL_MS：定时器轮询粒度（2 分钟，远小于 30min 阈值，足够及时）
let IDLE_CLEANUP_MS = 30 * 60 * 1000; // 启动后会被 setupIdleCleanupTimer 内 settings 值覆盖（默认 30 fallback）
const IDLE_CHECK_INTERVAL_MS = 2 * 60 * 1000;
let lastUserActivityTs = Date.now();
let idleCleanupTimer = null;
const acquiringBillCurrencyWriter = require('./main-process/acquiring-bill-currency-writer');
// v2.1.6 Module A T3：启动 log 头注入作者 + build SHA
const pkg = require('../package.json');
let buildInfo = { commit: 'dev' };
try { buildInfo = require('./build-info'); } catch (_) { /* dev 期 src/build-info.js 不存在 */ }
// v2.1.11 T3（spec §4.5 / 决策 D-T3-2-src=xlsx）：C2「银行对账单字段赋值」FundType 字段值枚举
//   运行时读 assets/FundType枚举值.xlsx（main 进程 require；经 IPC scenarios:fund-type-enum 暴露给 renderer）
//   preload 无法 require 自定义模块（Electron sandbox），故走 IPC 而非 inline 副本
const { loadFundTypeEnum, FUND_TYPE_ENUM_FILE_NAME } = require('./constants/fund-type-enum');
// v2.1.2 T2：月度银行对账单BU回填校验模块
const { createBankBuReconSession, runReconciliation: runBankBuRecon } = require('./main-process/bank-bu-recon-session');
const {
  writeDiffWorkbook: writeBankBuReconDiffWorkbook,
  writeAggregateDiffWorkbook: writeBankBuReconAggregateDiffWorkbook
} = require('./main-process/bank-bu-recon-writer');
const { readPendingGuanliFile, readBankFile } = require('./backend/bank-bu-recon-import/reader');
// v2.1.3：业务OP数据核对模块
// v2.1.3-fix7-M1：删 makeSingleDateDiffFileName / makeDateRangeDiffFileName 死 import
// （文件名生成在 ipc handler 内部直接 require session 调用，main.js 顶层无引用）
const {
  createBizOpReconSession,
  // v2.1.12-beta β.2-T2：默认走 worker 化导入入口（流式 + 边读边插，解决百万行 OOM/卡主线程）
  //   旧同步 runBizOpImportAsync/runFlowImportAsync 保留作 contract 基线 / 无 dbPath 兜底（worker 入口内部回退）
  runBizOpImportViaWorker: runBizOpImport,
  runFlowImportViaWorker: runFlowImport
} = require('./main-process/biz-op-recon-session');
const {
  writeSingleDateDiffWorkbook: writeBizOpSingleDateDiffWorkbook,
  writeDateRangeDiffWorkbook: writeBizOpDateRangeDiffWorkbook,
  writeBizOpErrorReportXlsx,
  writeFlowErrorReportXlsx
} = require('./main-process/biz-op-recon-writer');
const {
  readBizOpFile,
  readFlowFile
} = require('./backend/biz-op-recon-import/reader');
// v2.1.12 需求1：VCC业务OP计算模块（仅流水文件 → 按月聚合发生额出/入 → 算期末OP，资金红线 🔴）
const { createVccOpCalcSession } = require('./main-process/vcc-op-calc-session');
// v2.1.12 流式改造（spec §9）：reader 改 exceljs 流式后，由 session.streamScanAndCompute 内部调用，main 不再直接 import
const { runAllScenarios, C4_CATEGORIES } = require('./main-process/scenario-dispatcher');
// v2.1.12 需求6：数据侧预检只读 helper（统计 C3 银行侧候选行，不触碰 runC3Scenario 资金逻辑）
const { countC3BankCandidates } = require('./main-process/scenario-engines/c3-gateway-recon-join');
// v2.1.9 N5：dispatcher 双维调度依赖 channels-repository（findByNameAndLocation + getBuiltinGeneral）
const channelsRepository = require('./backend/database/channels-repository');
// v2.1.9 N7：场景模板 bundle 序列化 / 解析 / 类型识别（spec §六）
const {
  serializeScenarioBundle,
  parseScenarioBundle,
  detectBundleType,
  SUPPORTED_SCENARIO_BUNDLE_VERSION
} = require('./backend/scenarios-bundle-io');
// v2.1.9 SR-FIX-1 round 3 / spec §16.3.5：bundle import 主体提取到独立 module
//   方便 integration test 直接走真实代码路径（round 2 因 main.js 局部函数未 exports
//   → integration Case F 只能手写 sham 模拟 → 漏掉 F1+F2 协同 bug）
const {
  applyScenarioBundleImport: applyScenarioBundleImportImpl
} = require('./main-process/scenarios-bundle-import');
const {
  readBankStatement,
  readGatewayRecon,
  writeBankStatementMainOutput,
  writeErrorReportOutput,
  buildMainOutputFileName
} = require('./main-process/bank-statement-io');
// v2.1.9 N5 T26（spec §5.4 🔴 对外契约破坏性变更）：场景命中行独立报表 writer
//   v2.1.8 主输出 Sheet 3 撤除 → 改 error-reports/{date}/命中场景行-{basename}-{ts}.xlsx
//   失败 graceful：不阻塞主对账流程，仅 log 警告（spec §5.4）
const { writeScenarioHitRows } = require('./main-process/scenario-hit-rows-writer');
// v2.1.0-beta.1 PR-B：单据对账 ReconID 修复模块 IO + 引擎
//   Round 3 增加 writeUnmatchedReport / buildUnmatchedReportFileName / buildTimestampMinute（双文件 export）
const {
  readReconIdFixFile,
  writeReconIdFixOutput,
  writeUnmatchedReport,
  buildMainOutputFileName: buildReconIdFixMainOutputFileName,
  buildUnmatchedReportFileName: buildReconIdFixUnmatchedReportFileName,
  buildTimestampMinute: buildReconIdFixTimestampMinute
} = require('./main-process/recon-id-fix-io');
const { runReconIdFix } = require('./main-process/recon-id-fix-engine');
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
  writeErrorReport,
  // v2.1.9 SR-log-1 (T32h)：注入 storageRoot 给 main-process / backend 模块共用 appendModuleLog
  setActivityLogStorageRoot
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
// v2.1.2 T2：月度银行对账单BU回填校验 session（主 DB tool-data.sqlite）
const bankBuReconSession = createBankBuReconSession({
  getDb: () => database && database.db,
  getStorageRoot: () => ensureStorageRoot()
});
// v2.1.3：业务OP数据核对 session（主 DB tool-data.sqlite）
const bizOpReconSession = createBizOpReconSession({
  getDb: () => database && database.db,
  getStorageRoot: () => ensureStorageRoot()
});
// v2.1.12 需求1：VCC业务OP计算 session（主 DB tool-data.sqlite，资金红线 🔴）
const vccOpCalcSession = createVccOpCalcSession({
  getDb: () => database && database.db
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
// v2.0.0-beta.3 PR #32a：银行对账单处理模块的进程级 session
// 进程重启不持久化（与 lastFileImportContext 一致）
let bankStatementSession = null;     // { filePath, fileName, rows, headers, importedAt }
let gatewayReconSession = null;      // { filePath, fileName, gwRows, importedAt }
let processingResult = null;         // { modifiedRows, modifications, errorReport, stats, ranAt }
// v2.1.0-beta.1 PR-A：单据对账 ReconID 修复模块的进程级 session（PR-B 才实装数据 IO，PR-A 仅占位）
// reconIdFixSession = { filePath, fileName, sheets: { reconResult, businessBills, opponentBills, fixTemplate }, importedAt } | null
// reconIdFixResult  = { scenarioId, scenarioName, fixedRows, warnings, scenariosSnapshot, ranAt } | null
// 资金红线（spec §十）：场景任一变更 → 入口主动清 reconIdFixResult；export 端再被动校验 snapshot
let reconIdFixSession = null;
let reconIdFixResult = null;
let startupMetricsReported = false;
// v1.5.3 R2：自有账号迁移失败消息（D15）。null = 无失败；字符串 = 启动时发生失败，
// renderer 首次 app:get-info 时读取并用 error tone 显示状态栏告警
let lastOwnAccountsMigrationError = null;

// v2.1.6 fix3 → fix9 → fix10：收单单据币种校验模块的通用 operation lock
// 提到 module-level 是为 fix10 启动钩子（app.whenReady 链中 setImmediate 调 cleanupOrphanData）
// 也需要 acquire lock，避免和 IPC handler 并发；register 函数内部仍可访问（JS 闭包向外查找）
const acquiringBillCurrencyOperationLock = { inFlight: false, operation: null, monthKey: null };
function tryAcquireAcquiringBillCurrencyOpLock(operation, monthKey) {
  if (acquiringBillCurrencyOperationLock.inFlight) {
    const lock = acquiringBillCurrencyOperationLock;
    const opLabel = { import: '导入', run: '对账', export: '导出', cleanup: '上一次对账后清理' }[lock.operation] || lock.operation;
    const message = lock.operation === 'cleanup'
      ? `${opLabel} ${lock.monthKey || ''} 数据中，请稍后再操作`
      : `当前有${opLabel}任务在执行，请等待完成后再试`;
    return { acquired: false, message };
  }
  acquiringBillCurrencyOperationLock.inFlight = true;
  acquiringBillCurrencyOperationLock.operation = operation;
  acquiringBillCurrencyOperationLock.monthKey = monthKey || null;
  return { acquired: true };
}
function releaseAcquiringBillCurrencyOpLock() {
  acquiringBillCurrencyOperationLock.inFlight = false;
  acquiringBillCurrencyOperationLock.operation = null;
  acquiringBillCurrencyOperationLock.monthKey = null;
}

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

// v2.1.9 N7 (Phase 7 T29)：场景模板 bundle 默认文件名时间戳（D13=a：scenarios-bundle-{YYYYMMDD}.json）
function formatDateYYYYMMDD(date = new Date()) {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
}

// v2.1.9 N7 (Phase 7 T30)：场景模板 bundle 应用导入（事务包裹 + 缺失渠道创建 + 同名场景跳过）
//
// v2.1.9 SR-FIX-1 round 3 / spec §16.3.5：主体提取到 src/main-process/scenarios-bundle-import.js
//   本处保留薄壳 wrapper（保持函数名 + signature 不变，IPC handler 调用接口零变更）；
//   实际逻辑由 applyScenarioBundleImportImpl 实现，deps 注入 database facade。
//
// 函数语义详见 src/main-process/scenarios-bundle-import.js 顶部注释。
function applyScenarioBundleImport(bundle, options = {}) {
  const db = database && database.db;
  if (!db) {
    throw new Error('applyScenarioBundleImport: database 未就绪');
  }
  return applyScenarioBundleImportImpl(bundle, options, {
    db,
    listChannels: () => database.listChannels(),
    getBuiltinGeneralChannel: () => database.getBuiltinGeneralChannel(),
    createChannel: (payload) => database.createChannel(payload),
    findScenarioByChannelAndName: (channelId, name) => database.findScenarioByChannelAndName(channelId, name),
    createScenario: (payload) => database.createScenario(payload)
  });
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

  // v2.1.12 SR-log-1：不再创建/写入 app_activity_log.txt；activityLogFilePath 仅作逻辑锚点
  //   （appendActivityRecord 用其 dirname 推导 storageRoot），日志统一走 logs/ 新结构（JSON Lines）
  activityLogFilePath = getActivityLogFallbackFilePath();
  // v2.1.9 SR-log-1 (T32h)：注入 storageRoot 让 backend / main-process 模块走 appendModuleLog
  setActivityLogStorageRoot(ensureStorageRoot());
  markStartupMetric(STARTUP_METRIC_MARKS.activityLogReady);

  appendActivityLogEntry({
    level: 'info',
    message: '应用启动',
    details: [`版本：${app.getVersion()}`]
  });
  // v2.1.6 Module A T3：个人痕迹 — 紧贴"应用启动"后写入作者 + 构建 SHA
  appendActivityLogEntry({
    level: 'info',
    message: `crafted by ${pkg.author.name} (${pkg.author.email}) · build ${buildInfo.commit}`
  });
  return activityLogFilePath;
}

function handleStartupFailure(error) {
  let logPath = getActivityLogFallbackFilePath();

  try {
    logPath = initializeActivityLog();
  } catch (logError) {
    // v2.1.9 SR-log-1：日志系统初始化失败的最后兜底场景
    //   - appendActivityLogEntry 此时尚未 ready，仅能 stderr 兜底
    //   - 不写 console（v2.1.9 SR-log-1 要求 src/main.js 0 console 调用）
    try { process.stderr.write(`[startup logger init failed] ${logError && logError.stack ? logError.stack : String(logError)}\n`); } catch (_) {}
  }

  // v2.1.9 SR-log-1：启动失败兜底，日志系统不一定 ready → stderr 兜底
  try { process.stderr.write(`[startup failure] ${error && error.stack ? error.stack : String(error)}\n`); } catch (_) {}

  reportStartupFailure({
    error,
    logFilePath: logPath,
    appendRecord: (filePath, payload) => appendActivityRecord(filePath, payload),
    showErrorBox: (title, message) => dialog.showErrorBox(title, message),
    exit: (exitCode) => app.exit(exitCode)
  });
}

// v2.1.9 SR-log-1 (T32g + T32j)：扩展 source / domain / stack 字段以支持双写新日志结构
//   - 旧 caller（仅传 level/message/details）保持兼容（source/domain/stack 默认 undefined → logger 用兜底值）
//   - 新 caller（renderer reportLog / main console.error 改造）传入完整 schema（spec §15.3）
//   - appendActivityRecord 内部双写：旧 app_activity_log.txt（保持 v2.1.8 行为） + 新 logs/ 结构（JSON Lines）
function appendActivityLogEntry({ level = 'info', message, details = [], source, domain, stack } = {}) {
  try {
    const targetPath = activityLogFilePath || initializeActivityLog();
    appendActivityRecord(targetPath, {
      level,
      message,
      details,
      ...(source !== undefined ? { source } : {}),
      ...(domain !== undefined ? { domain } : {}),
      ...(stack !== undefined ? { stack } : {})
    });
  } catch (error) {
    // 旧实现用 console.error；v2.1.9 SR-log-1 要求 src/main.js 0 console 调用
    //   兜底：写 stderr.write（绕开 console），避免无限递归（appendActivityLog → 写日志失败 → console.error → 再触发？）
    //   logger.js 是日志写入兜底链最末端，唯一允许使用 process.stderr/stdout
    try {
      process.stderr.write(`[appendActivityLogEntry fallback] ${error && error.stack ? error.stack : String(error)}\n`);
    } catch (_e) {}
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
    // v2.1.9 SR-log-1：币种映射表读取失败 → 上报日志，返回空数组兜底
    appendActivityLogEntry({
      level: 'error',
      source: 'main',
      domain: 'currency-mapping',
      message: 'getAvailableCurrencyCodes 失败',
      details: [error && error.message ? error.message : String(error)],
      stack: error && error.stack ? error.stack : undefined
    });
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
          // v2.1.9 SR-log-1：startup capture（preview 截图）失败 → 日志上报
          appendActivityLogEntry({
            level: 'error',
            source: 'main',
            domain: 'startup-capture',
            message: 'APP_CAPTURE_PATH 截图失败',
            details: [error && error.message ? error.message : String(error)],
            stack: error && error.stack ? error.stack : undefined
          });
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
      // v2.1.0-beta.3 T4：对账单ReconID修复模块「账单类别」持久化（business | gateway | null）
      reconIdFixBillCategory: database.getReconIdFixBillCategory(),
      // v2.1.4 T3：左上角模块切换按钮的启用列表（renderer 启动时一次拉，省一个 IPC round-trip）
      enabledModules: database.getEnabledModules(),
      // v1.5.3 R2（D15）：启动时自有账号迁移失败的错误文案；null 表示无失败
      ownAccountsMigrationError: lastOwnAccountsMigrationError
    };
  });
  ipcMain.handle('settings:get-ui-style', () => {
    return database.getUiStyle() || 'Clear';
  });
  trackedIpcHandle('settings:set-ui-style', '切换页面风格', '切换', (_event, style) => {
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
  // v2.1.0-beta.3 T4：对账单ReconID修复模块「账单类别」持久化（business | gateway | null）
  ipcMain.handle('settings:set-recon-id-fix-bill-category', (_event, category) => {
    try {
      database.setReconIdFixBillCategory(category);
      return { status: 'ok', reconIdFixBillCategory: category || null };
    } catch (error) {
      return { status: 'failed', message: String(error && error.message ? error.message : error) };
    }
  });
  // v2.1.4 T3：左上角模块切换按钮的启用列表（GET = 启动时拉取 + 首次 seed 默认）
  ipcMain.handle('settings:get-enabled-modules', () => {
    try {
      return { status: 'ok', enabledModules: database.getEnabledModules() };
    } catch (error) {
      return { status: 'failed', message: String(error && error.message ? error.message : error) };
    }
  });
  // v2.1.4 T3：左上角模块切换按钮的启用列表（SET = 模块收纳弹窗「完成」按钮 落库）
  // round 1 self-review M5：return DB 真值（getEnabledModules）而非入参 moduleList，
  //   因为 setEnabledModules 内部 sanitize 会过滤非法 ID + 去重，sanitize 后可能与入参不一致；
  //   renderer 收到后用真值更新 state.enabledModules 保证一致性。
  ipcMain.handle('settings:set-enabled-modules', (_event, moduleList) => {
    try {
      database.setEnabledModules(moduleList);
      return { status: 'ok', enabledModules: database.getEnabledModules() };
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
  // v2.1.11 T3（spec §4.5 / 决策 D-T3-2-src=xlsx / strict=a）：C2 FundType 字段值枚举
  //   - renderer 打开 C2 配置弹窗时拉取，条件行 value + 赋值行 value（field==='FundType'）渲染为严格下拉
  //   - 路径解析：打包后用 app.getAppPath() 拼 assets（与 getBundledIconPath 同范式）；
  //     dev 期传 undefined → fund-type-enum 模块用默认路径 <repo>/assets/
  //   - 降级（文件缺失/读取失败）：loadFundTypeEnum 返空数组（不抛错）→ renderer 回退文本输入 + 一次性提示
  //   - 模块级缓存（按解析路径）：重复调用不反复读盘
  ipcMain.handle('scenarios:fund-type-enum', () => {
    try {
      const candidates = [
        path.join(app.getAppPath(), 'assets', FUND_TYPE_ENUM_FILE_NAME),
        path.join(__dirname, '..', 'assets', FUND_TYPE_ENUM_FILE_NAME)
      ];
      const found = candidates.find((p) => fs.existsSync(p));
      // found 存在 → 显式传入（打包/dev 都命中）；都不存在 → 传第一个候选，loadFundTypeEnum 内降级返空数组
      const values = loadFundTypeEnum(found || candidates[0]);
      return { status: 'ok', values };
    } catch (error) {
      // 防御：任何异常也降级为空数组（renderer 据此回退文本输入），不阻塞弹窗
      return { status: 'ok', values: [] };
    }
  });
  // PR #35 Codex round 3 P2（资金红线分流）：4 个 scenarios:* 入口
  // 不再无条件清两个全局缓存，而是按变更场景的 category 分流：
  // - C1/C2/C3（'extract-recon-id' / 'offset-bill-mark' / 'gateway-recon-join'）→ 只清 processingResult
  // - C4（'recon-id-fix'）→ 只清 reconIdFixResult
  // 否则会出现：用户跑完银行对账（processingResult 已就绪）后改 C4 场景 → 误清 processingResult
  // → 前端 refreshBankStatementStatus() 把已就绪的导出状态翻成"未运行"。反向同理。
  // round 3 self-review P3-A：显式枚举已知 category，未知值（含 undefined）双清并 warn，
  // 避免未来加新 category 时忘了同步本函数会偷偷清 processingResult。
  const BANK_STATEMENT_CATEGORIES = new Set(['extract-recon-id', 'offset-bill-mark', 'gateway-recon-join']);
  // v2.1.0-beta.3 PR #39 Finding 2（P2）：把 ReconID 修复 category 集合化（含 business + gateway 两个子模式）
  // 之前 'gateway-recon-id-fix' 落 unknown 分支 → 双清 processingResult + reconIdFixResult → 用户改 gateway 场景误清银行对账结果
  const RECON_ID_FIX_CATEGORIES = new Set(['recon-id-fix', 'gateway-recon-id-fix']);
  function clearResultCacheForCategory(category) {
    if (RECON_ID_FIX_CATEGORIES.has(category)) {
      reconIdFixResult = null;
    } else if (BANK_STATEMENT_CATEGORIES.has(category)) {
      processingResult = null;
    } else {
      // v2.1.9 SR-log-1：未知 category 兜底（防止未来加新 category 漏改本函数）→ 上报 warning + 双清
      appendActivityLogEntry({
        level: 'warning',
        source: 'main',
        domain: 'scenarios',
        message: '[scenarios:*] 未知 category 双清 cache 兜底',
        details: [`category=${category}`, '双清 processingResult + reconIdFixResult']
      });
      processingResult = null;
      reconIdFixResult = null;
    }
  }
  trackedIpcHandle('scenarios:create', '银行对账单处理', '场景管理', (_event, payload) => {
    try {
      const result = database.createScenario(payload);
      // round 3 P2：按 category 分流（payload.category 已通过 createScenario 内的 validateCategory）
      clearResultCacheForCategory(payload && payload.category);
      return { status: 'ok', id: result.id };
    } catch (error) {
      return { status: 'failed', message: String(error && error.message ? error.message : error) };
    }
  });
  trackedIpcHandle('scenarios:update', '银行对账单处理', '场景管理', (_event, id, fields) => {
    try {
      // round 3 P2：先查老 row 的 category（spec §三 IPC：update 不允许改 category，可信任 DB 现值）
      // 查不到 → updateScenario 自身也会抛 "场景 id=X 不存在"，此处保持 try 链一致
      const existing = database.getScenario(id);
      database.updateScenario(id, fields);
      clearResultCacheForCategory(existing && existing.category);
      return { status: 'ok', id };
    } catch (error) {
      return { status: 'failed', message: String(error && error.message ? error.message : error) };
    }
  });
  trackedIpcHandle('scenarios:delete', '银行对账单处理', '场景管理', (_event, id) => {
    try {
      // round 3 P2：DELETE 后 row 不存在 → 必须先 SELECT category 再删
      const existing = database.getScenario(id);
      const result = database.deleteScenario(id);
      // 仅当 row 真存在过才需要清缓存（不存在时 result.deleted=false，无副作用）
      if (existing) {
        clearResultCacheForCategory(existing.category);
      }
      return { status: 'ok', id, deleted: result.deleted };
    } catch (error) {
      return { status: 'failed', message: String(error && error.message ? error.message : error) };
    }
  });
  trackedIpcHandle('scenarios:toggle-enabled', '银行对账单处理', '场景管理', (_event, id, enabled) => {
    try {
      // round 3 P2：toggle 不改 category，先 SELECT 取 category
      const existing = database.getScenario(id);
      const result = database.toggleScenarioEnabled(id, enabled);
      clearResultCacheForCategory(existing && existing.category);
      return { status: 'ok', id, enabled: result.enabled };
    } catch (error) {
      return { status: 'failed', message: String(error && error.message ? error.message : error) };
    }
  });

  // v2.1.9 N5 Phase 5 T22-T23：批量转移 + 批量删除
  //   payload = { scenarioIds: number[], targetChannelId: number }
  //   scenarios:transfer 单条 / 批量同入口（数组长度 1 即为单条转移）
  //   - 转移前后命中场景的 category 可能跨 BANK_STATEMENT_CATEGORIES / RECON_ID_FIX_CATEGORIES，
  //     保险起见双清 processingResult + reconIdFixResult（场景集变化必须清缓存避免老结果误用）
  //   - DB 层事务保护：任何 id 不存在或目标渠道不存在 → 整批回滚
  trackedIpcHandle('scenarios:transfer', '银行对账单处理', '场景管理', (_event, payload) => {
    try {
      const { scenarioIds, targetChannelId } = payload || {};
      const result = database.transferScenarios(scenarioIds, targetChannelId);
      // 转移会影响调度命中场景的归属 → 双清两组缓存
      processingResult = null;
      reconIdFixResult = null;
      return { status: 'ok', transferredCount: result.transferredCount, targetChannelId: result.targetChannelId };
    } catch (error) {
      return { status: 'failed', message: String(error && error.message ? error.message : error) };
    }
  });
  // scenarios:batch-delete payload = { scenarioIds: number[] }
  //   DB 层 is_builtin=1 保护（防 DevTools 绕过 UI）；任何内置命中整批回滚
  //   清缓存策略同 transfer：双清避免老结果误用
  trackedIpcHandle('scenarios:batch-delete', '银行对账单处理', '场景管理', (_event, payload) => {
    try {
      const { scenarioIds } = payload || {};
      const result = database.batchDeleteScenarios(scenarioIds);
      processingResult = null;
      reconIdFixResult = null;
      return { status: 'ok', deletedCount: result.deletedCount };
    } catch (error) {
      return { status: 'failed', message: String(error && error.message ? error.message : error) };
    }
  });

  // v2.1.13 D-3：自带写死场景「适用银行渠道」读写
  //   get：无副作用查询，返回 channel_id 数组（空数组 = 适用全部渠道）
  ipcMain.handle('scenarios:get-applicable-channels', (_event, id) => {
    try {
      return { status: 'ok', channelIds: database.getScenarioApplicableChannels(id) };
    } catch (error) {
      return { status: 'failed', message: String(error && error.message ? error.message : error) };
    }
  });
  //   set：覆盖式写入（空数组 = 清空 = 适用全部）；改写死场景适用渠道会改变 dispatcher 执行集
  //   （哪些渠道运行时跑该 builtin-fixed 提取场景）→ 清 processingResult 避免老结果误用
  trackedIpcHandle('scenarios:set-applicable-channels', '银行对账单处理', '场景管理', (_event, id, channelIds) => {
    try {
      const result = database.setScenarioApplicableChannels(id, channelIds);
      processingResult = null;
      return { status: 'ok', scenarioId: result.scenarioId, channelIds: result.channelIds };
    } catch (error) {
      return { status: 'failed', message: String(error && error.message ? error.message : error) };
    }
  });

  // v2.1.9 N5：channels CRUD IPC（银行渠道管理）
  //   list 无副作用不进 trackedIpcHandle 计数（参考 scenarios:list 范式）
  //   create/update/delete 进 trackedIpcHandle('银行对账单处理' / '渠道管理') 计数
  //   「通用」内置渠道（is_builtin=1）保护：DB 层在 channels-repository 已实现（updateChannel / deleteChannel 抛错）
  ipcMain.handle('channels:list', () => {
    try {
      return { status: 'ok', channels: database.listChannels() };
    } catch (error) {
      return { status: 'failed', message: String(error && error.message ? error.message : error) };
    }
  });
  trackedIpcHandle('channels:create', '银行对账单处理', '渠道管理', (_event, payload) => {
    try {
      const channel = database.createChannel(payload || {});
      return { status: 'ok', channel };
    } catch (error) {
      return { status: 'failed', message: String(error && error.message ? error.message : error) };
    }
  });
  trackedIpcHandle('channels:update', '银行对账单处理', '渠道管理', (_event, id, fields) => {
    try {
      const channel = database.updateChannel(id, fields || {});
      return { status: 'ok', channel };
    } catch (error) {
      return { status: 'failed', message: String(error && error.message ? error.message : error) };
    }
  });
  trackedIpcHandle('channels:delete', '银行对账单处理', '渠道管理', (_event, id) => {
    try {
      database.deleteChannel(id);
      return { status: 'ok', id };
    } catch (error) {
      return { status: 'failed', message: String(error && error.message ? error.message : error) };
    }
  });

  // v2.1.9 N7 (Phase 7 T29/T30)：场景模板按渠道导入/导出 — bundle IPC（spec §六）
  //
  //   scenarios:export-bundle  payload = { channelIds: number[] }
  //     → 拉所选渠道 + 各自全部 scenarios（含 disabled）→ serializeScenarioBundle
  //     → showSaveDialog 默认文件名 scenarios-bundle-{YYYYMMDD}.json
  //     → 写文件 → return { status: 'ok', filePath, exportedChannels, exportedScenarios }
  //
  //   scenarios:import-bundle  无 payload
  //     → showOpenDialog → 读文件 → JSON.parse → detectBundleType
  //       - 不是 'scenarios' → 抛错「文件类型不匹配」给场景管理入口
  //       - 是 'scenarios' → parseScenarioBundle 解析
  //     → 扫描缺失渠道（非 builtin 且库内不存在）→ 二阶段：
  //       - 有缺失 → return { status: 'needs-confirm', missingChannels, bundle, filePath }
  //       - 无缺失 → 走 apply 路径
  //
  //   scenarios:import-bundle-apply  payload = { bundle, confirmCreateMissingChannels }
  //     → 事务包裹（创建缺失渠道 + 插入新场景；同名场景跳过 + 收集冲突）
  //     → return { status: 'ok', importedCount, createdChannels, conflicts }
  //
  // 资金红线（spec §10.2）：
  //   - 导入涉及用户场景库改动 → 必须二阶段（needs-confirm → apply）避免误覆盖
  //   - bundle 类型互认严格 — reader 必须按顶层 key 区分；误用 bundleVersion=4 文件必报错
  //   - apply 事务包裹保证导入失败不留半状态
  //   - 同名场景跳过 + 收集到冲突清单（D12=a 保守策略）— 不静默覆盖
  trackedIpcHandle('scenarios:export-bundle', '银行对账单处理', '场景管理', async (_event, payload = {}) => {
    try {
      const inputIds = Array.isArray(payload.channelIds) ? payload.channelIds : [];
      const channelIds = inputIds
        .map((v) => Number(v))
        .filter((v) => Number.isFinite(v) && v > 0);
      if (channelIds.length === 0) {
        return { status: 'failed', message: '请至少选择一个银行渠道' };
      }

      // 拉渠道全集 + 过滤所选
      const allChannels = database.listChannels();
      const channelById = new Map(allChannels.map((c) => [Number(c.id), c]));
      const selectedChannels = [];
      const unknownIds = [];
      for (const id of channelIds) {
        if (channelById.has(id)) {
          selectedChannels.push(channelById.get(id));
        } else {
          unknownIds.push(id);
        }
      }
      if (selectedChannels.length === 0) {
        return { status: 'failed', message: `选中的渠道 id=${unknownIds.join(',')} 不存在` };
      }

      // 拉各渠道的全部 scenarios（含 disabled）
      const scenariosByChannel = new Map();
      let totalScenarios = 0;
      for (const ch of selectedChannels) {
        const scenarios = database.listAllScenariosByChannelId(ch.id);
        scenariosByChannel.set(ch.id, scenarios);
        totalScenarios += scenarios.length;
      }

      // 序列化
      const jsonText = serializeScenarioBundle(selectedChannels, scenariosByChannel, app.getVersion());

      // saveDialog 默认文件名（D13=a）
      const dateStr = formatDateYYYYMMDD(new Date());
      const defaultFileName = `scenarios-bundle-${dateStr}.json`;
      const saveResult = await dialog.showSaveDialog(mainWindow, {
        title: '导出场景模板文件',
        defaultPath: defaultFileName,
        filters: [{ name: 'JSON', extensions: ['json'] }]
      });
      if (saveResult.canceled || !saveResult.filePath) {
        return { status: 'cancelled' };
      }

      fs.mkdirSync(path.dirname(saveResult.filePath), { recursive: true });
      fs.writeFileSync(saveResult.filePath, jsonText, 'utf8');

      appendActivityLogEntry({
        level: 'info',
        message: '导出场景模板文件成功',
        details: [
          `导出路径：${saveResult.filePath}`,
          `渠道数：${selectedChannels.length}`,
          `场景数：${totalScenarios}`
        ]
      });
      return {
        status: 'ok',
        filePath: saveResult.filePath,
        exportedChannels: selectedChannels.length,
        exportedScenarios: totalScenarios
      };
    } catch (error) {
      return { status: 'failed', message: String(error && error.message ? error.message : error) };
    }
  });

  trackedIpcHandle('scenarios:import-bundle', '银行对账单处理', '场景管理', async () => {
    try {
      const choice = await dialog.showOpenDialog(mainWindow, {
        title: '导入场景模板文件',
        properties: ['openFile'],
        filters: [{ name: 'JSON', extensions: ['json'] }]
      });
      if (choice.canceled || !choice.filePaths || choice.filePaths.length === 0) {
        return { status: 'cancelled' };
      }
      const filePath = choice.filePaths[0];

      let jsonText;
      try {
        jsonText = fs.readFileSync(filePath, 'utf8');
      } catch (e) {
        return { status: 'failed', message: `读取文件失败：${e && e.message ? e.message : e}` };
      }

      // detectBundleType 必须先 JSON.parse；解析失败 → 友好错误
      let parsedRaw;
      try {
        parsedRaw = JSON.parse(jsonText);
      } catch (e) {
        return { status: 'failed', message: `场景模板文件格式错误：${e && e.message ? e.message : '不是合法 JSON'}` };
      }
      let bundleType;
      try {
        bundleType = detectBundleType(parsedRaw);
      } catch (e) {
        return { status: 'failed', message: String(e && e.message ? e.message : e) };
      }
      if (bundleType !== 'scenarios') {
        // 误用网银账单 bundleVersion=4 文件 → 报错（spec §6.2 / 资金红线）
        return {
          status: 'failed',
          message: `文件类型不匹配：当前文件是「网银账单模板」（bundleVersion），场景管理入口仅接受「场景模板」（scenarioBundleVersion）`
        };
      }

      // 解析为结构化 bundle（版本号校验 + 字段归一化）
      let bundle;
      try {
        bundle = parseScenarioBundle(jsonText);
      } catch (e) {
        return { status: 'failed', message: String(e && e.message ? e.message : e) };
      }

      // 扫描缺失渠道（非 builtin 且库内不存在）— 二阶段确认核心数据
      const allChannels = database.listChannels();
      const channelKeyToRecord = new Map(
        allChannels.map((c) => [`${c.name} ${c.ownerLocation}`, c])
      );
      const missingChannels = [];
      for (const ch of bundle.channels) {
        if (ch.isBuiltin) continue;
        const key = `${ch.name} ${ch.ownerLocation}`;
        if (!channelKeyToRecord.has(key)) {
          missingChannels.push({ name: ch.name, ownerLocation: ch.ownerLocation });
        }
      }

      if (missingChannels.length > 0) {
        // 不直接 apply；返回 needs-confirm 给 renderer 弹确认框
        return {
          status: 'needs-confirm',
          missingChannels,
          bundle,
          filePath
        };
      }

      // 无缺失渠道 → 直接 apply
      const applyResult = applyScenarioBundleImport(bundle, { confirmCreateMissingChannels: false });
      appendActivityLogEntry({
        level: 'info',
        message: '导入场景模板文件成功',
        details: [
          `导入路径：${filePath}`,
          `新增场景数：${applyResult.importedCount}`,
          `跳过同名场景数：${applyResult.conflicts.length}`,
          `创建渠道数：${applyResult.createdChannels.length}`
        ]
      });
      return Object.assign({ status: 'ok', filePath }, applyResult);
    } catch (error) {
      return { status: 'failed', message: String(error && error.message ? error.message : error) };
    }
  });

  trackedIpcHandle('scenarios:import-bundle-apply', '银行对账单处理', '场景管理', (_event, payload = {}) => {
    try {
      const { bundle, confirmCreateMissingChannels } = payload || {};
      if (!bundle || !Array.isArray(bundle.channels)) {
        return { status: 'failed', message: 'apply: 缺少有效的 bundle 参数' };
      }
      const applyResult = applyScenarioBundleImport(bundle, {
        confirmCreateMissingChannels: confirmCreateMissingChannels === true
      });
      // 导入会变更 scenarios 库 → 双清 processingResult + reconIdFixResult 避免老结果误用
      processingResult = null;
      reconIdFixResult = null;
      appendActivityLogEntry({
        level: 'info',
        message: '应用场景模板导入成功',
        details: [
          `新增场景数：${applyResult.importedCount}`,
          `跳过同名场景数：${applyResult.conflicts.length}`,
          `创建渠道数：${applyResult.createdChannels.length}`
        ]
      });
      return Object.assign({ status: 'ok' }, applyResult);
    } catch (error) {
      return { status: 'failed', message: String(error && error.message ? error.message : error) };
    }
  });

  // v2.0.0-beta.3 PR #32a：银行对账单处理模块 IO + 调度 IPC
  trackedIpcHandle('bank-statement:import', '银行对账单处理', '导入文件', async () => {
    try {
      const choice = await dialog.showOpenDialog(mainWindow, {
        title: '选择银行对账单文件',
        properties: ['openFile'],
        filters: [{ name: 'Excel', extensions: ['xlsx'] }]
      });
      if (choice.canceled || !choice.filePaths || choice.filePaths.length === 0) {
        return { status: 'cancelled' };
      }
      const filePath = choice.filePaths[0];
      const result = readBankStatement(filePath);
      bankStatementSession = {
        filePath: result.filePath,
        fileName: result.fileName,
        rows: result.rows,
        headers: result.headers,
        importedAt: Date.now()
      };
      // 重新导入银行对账单 → 同步清空运行结果 + 资金对账文件
      // （Codex F2 P1 修复：避免把上一批 gwRows 误用到新文件）
      processingResult = null;
      gatewayReconSession = null;
      return {
        status: 'ok',
        fileName: result.fileName,
        rowCount: result.rowCount
      };
    } catch (error) {
      if (error && error.name === 'FileValidationError') {
        return {
          status: 'invalid',
          code: error.code,
          message: error.message,
          detailLines: error.detailLines || []
        };
      }
      return { status: 'failed', message: String(error && error.message ? error.message : error) };
    }
  });

  trackedIpcHandle('gateway-recon:import', '银行对账单处理', '导入文件', async () => {
    try {
      const choice = await dialog.showOpenDialog(mainWindow, {
        title: '选择资金对账不平结果表',
        properties: ['openFile'],
        filters: [{ name: 'Excel', extensions: ['xlsx'] }]
      });
      if (choice.canceled || !choice.filePaths || choice.filePaths.length === 0) {
        return { status: 'cancelled' };
      }
      const filePath = choice.filePaths[0];
      const result = readGatewayRecon(filePath);
      gatewayReconSession = {
        filePath: result.filePath,
        fileName: result.fileName,
        gwRows: result.gwRows,
        importedAt: Date.now()
      };
      processingResult = null;
      return {
        status: 'ok',
        fileName: result.fileName,
        rowCount: result.rowCount
      };
    } catch (error) {
      if (error && error.name === 'FileValidationError') {
        return {
          status: 'invalid',
          code: error.code,
          message: error.message,
          detailLines: error.detailLines || []
        };
      }
      return { status: 'failed', message: String(error && error.message ? error.message : error) };
    }
  });

  // PR #33 Codex round 3 P1 资金红线（defense in depth）：
  // 即使 round 2 已在 scenarios:* 4 IPC 入口处清空 processingResult，
  // 仍在 run 时记录 snapshot、export 时再比对一次——让 export handler 自身可见显式校验。
  // snapshot key = id + name + priority + enabled + JSON.stringify(config)
  function buildScenariosSnapshot(detailedEnabled) {
    return detailedEnabled
      .map((s) => `${s.id}|${s.name}|${s.priority}|${s.enabled ? 1 : 0}|${JSON.stringify(s.config || {})}`)
      .sort()
      .join('\n');
  }

  trackedIpcHandle('bank-statement:run', '银行对账单处理', '开始运行', () => {
    try {
      if (!bankStatementSession) {
        return { status: 'failed', message: '请先导入银行对账单' };
      }
      const allScenarios = database.listScenarios();
      const enabled = allScenarios.filter((s) => s.enabled === 1 || s.enabled === true);
      // 2026-05-27 N5 fix：getScenario 不返 displayIndex / channelId（缺失）— 用 list item 的字段补
      //   listScenarios 已计算渠道内 1-based displayIndex（与 UI 渠道过滤序号一致）
      //   不补则 dispatcher 兜底 scenario.id（DB 自增）→ 状态框「场景 7、8、9」与 UI 序号不一致
      const detailedEnabled = enabled.map((s) => {
        const detail = database.getScenario(s.id);
        if (!detail) return null;
        // v2.1.13 D-3：builtin-fixed 自带写死场景附「适用银行渠道」列表（空 = 适用全部，dispatcher 不过滤）
        //   dispatcher runChannelBatch 据此逐行过滤候选行（仅对 matchedChannel 在列表内的行提取）
        const applicableChannelIds = detail.category === 'builtin-fixed'
          ? database.getScenarioApplicableChannels(s.id)
          : null;
        return { ...detail, displayIndex: s.displayIndex, channelId: s.channelId, _applicableChannelIds: applicableChannelIds };
      }).filter(Boolean);
      // v2.1.0-beta.1 PR-A round 2 P1（资金红线）：C4 (`recon-id-fix`) 走独立模块
      // `recon-id-fix:run`，不应进入银行对账单 dispatcher（C4 没有对应的 case，
      // dispatcher 内 `runScenario` default 分支会 throw "未知 category"）。
      // 此处 + snapshot 都过滤掉 → 银行对账与单据对账两条流水线相互独立。
      // v2.1.0-beta.3 PR #39 Finding 1（P1）：扩展到所有 C4 category（含 'gateway-recon-id-fix'）
      const dispatchScenarios = detailedEnabled.filter((s) => !C4_CATEGORIES.includes(s.category));
      // 每次 run 都基于原始导入数据 deep clone 一份工作副本
      // （Codex F1 P1 修复：算法层会原地修改字段，不 clone 会让连续运行的 oldValue 漂移
      //  → first-match-wins 失效，低优先级场景可能覆盖高优先级写入的字段）
      const workingBankRows = structuredClone(bankStatementSession.rows);
      const workingGwRows = gatewayReconSession ? structuredClone(gatewayReconSession.gwRows) : null;
      // v2.1.9 N5：双维 first-match-wins（spec §2.1）— deps 提供激活双维；缺省走 legacy 单维
      //   channelsRepo.findByNameAndLocation/getBuiltinGeneral 用于行的渠道匹配（专属 + 通用兜底）
      //   保留 first-match-wins 不变量：同一行最多命中 1 个场景（spec §2.4）
      const result = runAllScenarios(workingBankRows, workingGwRows, dispatchScenarios, {
        channelsRepo: channelsRepository,
        db: database.db,
      });
      processingResult = {
        modifiedRows: result.modifiedRows,
        // v2.1.7 round 3 F8 (spec §9.8.5)：保留 dispatcher 返回的 unmatchedRows（导出阶段写第 2 sheet 用）
        //   保留原始 bankRows 顺序 + 原始字段（dispatcher 反向 filter 未做 .map 转换）
        //   ⚠️ 资金红线：modifiedRows + unmatchedRows = workingBankRows（无遗漏 + 互斥）
        unmatchedRows: result.unmatchedRows,
        modifications: result.modifications,
        errorReport: result.errorReport,
        stats: result.stats,
        scenariosSnapshot: buildScenariosSnapshot(dispatchScenarios),
        ranAt: Date.now()
      };
      return {
        status: 'ok',
        stats: result.stats
      };
    } catch (error) {
      return { status: 'failed', message: String(error && error.message ? error.message : error) };
    }
  });

  trackedIpcHandle('bank-statement:export', '银行对账单处理', '导出文件', async () => {
    try {
      if (!processingResult) {
        return { status: 'failed', message: '请先点击"开始运行"处理对账单' };
      }
      // round 3 P1 资金红线（defense in depth）：即使 scenarios:* 4 IPC 入口都清了缓存，
      // 这里再校验一次 snapshot；任何场景 CRUD/toggle 在 run 之后发生 → snapshot 不一致 → 拒绝
      const allScenarios = database.listScenarios();
      const enabled = allScenarios.filter((s) => s.enabled === 1 || s.enabled === true);
      const detailedEnabled = enabled.map((s) => database.getScenario(s.id)).filter(Boolean);
      // v2.1.0-beta.1 PR-A round 2 P1：与 bank-statement:run 一致，C4 不参与本模块的 snapshot
      // 否则用户改 C4 场景会让此处 snapshot 变化 → 误报"场景已变更" → 拒绝导出
      // v2.1.0-beta.3 PR #39 Finding 1（P1）：扩展到所有 C4 category
      const dispatchScenarios = detailedEnabled.filter((s) => !C4_CATEGORIES.includes(s.category));
      const currentSnapshot = buildScenariosSnapshot(dispatchScenarios);
      if (processingResult.scenariosSnapshot !== currentSnapshot) {
        processingResult = null;
        return { status: 'failed', message: '场景已变更，请重新点击"开始运行"再导出' };
      }
      const exportRootDir = path.join(ensureStorageRoot(), 'bank-statement-process');

      // v2.1.7 round 8 F8 fix（PR #51 reviewer round 2 Finding 1）：
      //   保存框触发条件必须涵盖 unmatchedRows，否则全未命中时 mainFilePath=null →
      //   后面 writeBankStatementMainOutput 因缺 mainFilePath 抛错（bank-statement-io.js:205）
      //   提前算 unmatchedCount，保存框 + empty 返回两处共用
      const unmatchedCount = Array.isArray(processingResult.unmatchedRows) ? processingResult.unmatchedRows.length : 0;

      // v2.1.8 v2.1.7-minor M-2：errorReport 写入提前到 saveDialog 之前
      //   原顺序：saveDialog → cancel return → errorReport 写（cancel 时 errorReport 漏写）
      //   新顺序：errorReport 写（无条件，独立于 saveDialog）→ saveDialog → cancel 仍 return（但 errorReport 已落盘）
      //   场景：F8 round 8 全未命中 + 用户取消保存框 → 用户至少能拿到错误报告查异常原因
      // error-report 与主输出独立（PRD §189：error-report xlsx 格式独立于主输出）
      // 即使 modifiedRows.length === 0，warnings 仍应落盘——避免唯一可追溯的异常信息被吞掉
      // （Codex Round 2 F1 P1 修复：C1 多字段值不一致 / C2 一对多多对一 时
      //  modifiedRows 可能为空但 warnings 非空）
      let errorReport = null;
      if (processingResult.errorReport.length > 0) {
        errorReport = await writeErrorReportOutput({
          warnings: processingResult.errorReport,
          exportRootDir
        });
      }

      // 主输出走 saveDialog（用户另存为）；先弹保存框，让用户选位置
      // 若 modifiedRows + unmatchedRows 都为空 → 跳过 saveDialog，仅落 error-report（上方已写）
      let mainFilePath = null;
      if (processingResult.modifiedRows.length > 0 || unmatchedCount > 0) {
        const defaultFileName = buildMainOutputFileName();
        const saveResult = await dialog.showSaveDialog(mainWindow, {
          title: '保存处理结果',
          defaultPath: path.join(app.getPath('documents'), defaultFileName),
          filters: [{ name: 'Excel', extensions: ['xlsx'] }]
        });
        if (saveResult.canceled || !saveResult.filePath) {
          // M-2：cancel 时仍 return，但 errorReport 已写入（上方提前），renderer 显示 errorReport 路径
          return { status: 'cancelled', errorReport };
        }
        mainFilePath = saveResult.filePath;
      }
      // v2.1.7 round 7 F8 fix（PR #51 reviewer P1 / self-review I-5）+ round 8 (Finding 1 follow-up)：
      //   仅当 modifiedRows + unmatchedRows 都为 0 才 return empty；
      //   有 unmatchedRows 时上方保存框已经弹过（round 8 fix），mainFilePath 非 null，
      //   下方 writeBankStatementMainOutput 才能正确写主 sheet 空 + 第 2 sheet 全部未命中行
      //   对齐 PRD AC-F8-5：「所有行都未命中场景时，第 2 sheet 应包含全部 N 行」
      if (processingResult.modifiedRows.length === 0 && unmatchedCount === 0) {
        // PRD §717 P0-11：modifiedRows + unmatchedRows 都为 0 才不生成主输出，但 error-report 仍可能已生成
        return {
          status: 'empty',
          message: '无修改记录，未生成主输出文件',
          errorReportPath: errorReport ? errorReport.filePath : null,
          errorReportName: errorReport ? errorReport.fileName : null
        };
      }
      // v2.1.7 round 3 F8 (spec §9.8.5)：透传 unmatchedRows 给 writer 输出第 2 sheet "未命中场景行"
      //   ⚠️ 资金红线：unmatchedRows = bankRows - modifiedRows（dispatcher 反向 filter 保证互斥）
      //   sheet 1 '渠道对账单'：保留命中行 + 标黄；sheet 2 '未命中场景行'：未命中行（原始字段，无诊断列）
      const main = await writeBankStatementMainOutput({
        modifiedRows: processingResult.modifiedRows,
        headers: bankStatementSession.headers,
        mainFilePath,
        unmatchedRows: Array.isArray(processingResult.unmatchedRows) ? processingResult.unmatchedRows : []
      });

      // v2.1.9 N5 T26（spec §5.1-5.4 🔴 对外契约破坏性变更）：场景命中行独立报表
      //   v2.1.8 主输出 Sheet 3「命中场景行」撤除 → 改 error-reports/{date}/命中场景行-{basename}-{ts}.xlsx
      //   失败 graceful：不阻塞主对账流程，仅 log + return 主流程（spec §5.4）
      //   仅当 modifiedRows.length > 0 时输出（含表头但 0 行的报表对用户审计无价值）
      //
      //   v2.1.9 D16=b（2026-05-27 用户拍板）：传 channels 给 writer
      //     writer 用 row._hitChannelId 反查 channels.label 渲染「匹配渠道」列
      //     通用 label='通用' / 非通用 label='name-ownerLocation'（与场景管理 UI 一致）
      let hitRowsReport = null;
      if (processingResult.modifiedRows.length > 0) {
        try {
          const originalFilePath = bankStatementSession.filePath;
          const channels = channelsRepository.listChannels(database.db);
          hitRowsReport = await writeScenarioHitRows(
            processingResult.modifiedRows,
            originalFilePath,
            { exportRoot: ensureStorageRoot(), channels }
          );
        } catch (e) {
          // graceful — log 警告但不阻塞主流程返回
          appendActivityLogEntry({
            level: 'warning',
            message: '[banking-statement-process] 命中场景行独立报表生成失败',
            details: [e && e.message ? e.message : String(e)]
          });
          hitRowsReport = null;
        }
      }

      return {
        status: 'ok',
        mainFilePath: main.filePath,
        mainFileName: main.fileName,
        errorReportPath: errorReport ? errorReport.filePath : null,
        errorReportName: errorReport ? errorReport.fileName : null,
        // v2.1.9 N5 T26：renderer 用于状态框提示「命中场景行报表已生成：{path}」（详 USER_GUIDE v2.1.9）
        hitRowsReportPath: hitRowsReport ? hitRowsReport.filePath : null,
        hitRowsReportName: hitRowsReport ? hitRowsReport.fileName : null
      };
    } catch (error) {
      return { status: 'failed', message: String(error && error.message ? error.message : error) };
    }
  });

  ipcMain.handle('bank-statement:session-status', () => {
    return {
      status: 'ok',
      hasBankStatement: bankStatementSession !== null,
      bankStatementFileName: bankStatementSession ? bankStatementSession.fileName : null,
      bankStatementRowCount: bankStatementSession ? bankStatementSession.rows.length : 0,
      hasGatewayRecon: gatewayReconSession !== null,
      gatewayReconFileName: gatewayReconSession ? gatewayReconSession.fileName : null,
      gatewayReconRowCount: gatewayReconSession ? gatewayReconSession.gwRows.length : 0,
      hasProcessingResult: processingResult !== null,
      processingStats: processingResult ? processingResult.stats : null
    };
  });

  // v2.1.12 需求6：数据侧预检 — 统计当前导入银行对账单中满足「启用的 C3(gateway-recon-join) 场景银行条件」的候选行数
  //   用途：让「资金对账不平跳过提示」仅在确有候选行时弹出（启用 C3 但本次数据无命中行 → 不弹、不提示跳过）
  //   只读查询，不进 trackedIpcHandle 计数（参考 scenarios:list 范式）
  ipcMain.handle('bank-statement:c3-candidate-count', () => {
    try {
      if (!bankStatementSession || !Array.isArray(bankStatementSession.rows) || bankStatementSession.rows.length === 0) {
        return { status: 'ok', candidateCount: 0 };
      }
      const c3Scenarios = database.listScenarios().filter((s) => s.category === 'gateway-recon-join' && s.enabled);
      let candidateCount = 0;
      for (const meta of c3Scenarios) {
        const detail = database.getScenario(meta.id);
        candidateCount += countC3BankCandidates(detail && detail.config, bankStatementSession.rows);
        if (candidateCount > 0) break; // 有候选即可，提前退出
      }
      return { status: 'ok', candidateCount };
    } catch (error) {
      return { status: 'failed', message: String(error && error.message ? error.message : error), candidateCount: 0 };
    }
  });

  // ===== v2.1.0-beta.1 PR-B：单据对账 ReconID 修复模块 IPC（PR-A 占位 → PR-B 实装）=====
  // 资金红线（spec §十）：
  //   1) 入口主动清：scenarios:* 4 IPC 已按 category 分流清 reconIdFixResult（main.js:2743 clearResultCacheForCategory）
  //   2) export 端被动校验：本节 recon-id-fix:export 重读 scenario + 比对 snapshot；不一致拒绝
  //   3) 重新 import：清 reconIdFixResult（避免旧结果误导出新文件）
  //   4) 重新 run：覆盖写 reconIdFixResult + 同步刷新 scenariosSnapshot

  // snapshot 形态（与 bank-statement:run / export 一致）
  //
  // PR #36 self-review round 5（P3-C，2026-05-09）：
  //   原 JSON.stringify 按 object 属性插入顺序输出。同语义 config 在 DB round-trip
  //   前后 key 顺序可能不同（例如 SQLite 序列化反序列化 / repository 重写 config），
  //   导致 snapshot 字符串不同 → 误报 stale-snapshot → 拒导出（资金红线下游有降级保险，
  //   但用户体验差：明明没改场景却被拦）。
  //   修法：改用 stableJsonStringify（递归按 key 排序），保证同语义 config 在任何
  //   round-trip 后产出同一字符串。
  function stableJsonStringify(obj) {
    if (obj === null || obj === undefined) return JSON.stringify(obj);
    if (typeof obj !== 'object') return JSON.stringify(obj);
    if (Array.isArray(obj)) {
      return '[' + obj.map(stableJsonStringify).join(',') + ']';
    }
    const keys = Object.keys(obj).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableJsonStringify(obj[k])).join(',') + '}';
  }

  function buildReconIdFixSnapshot(scenario) {
    if (!scenario) return '';
    return [
      scenario.id,
      scenario.name,
      scenario.priority,
      scenario.enabled ? 1 : 0,
      stableJsonStringify(scenario.config || {})
    ].join('|');
  }

  trackedIpcHandle('recon-id-fix:import', '对账单 ReconID 修复', '导入文件', async (_event, payload) => {
    try {
      // v2.1.0-beta.3 T9：renderer 传 subMode（'business' | 'gateway'，从 state.reconIdFixBillCategory 推导）
      const subMode = (payload && payload.subMode === 'gateway') ? 'gateway' : 'business';
      const dialogTitle = subMode === 'gateway' ? '选择网关对账文件' : '选择单据对账文件';
      const choice = await dialog.showOpenDialog(mainWindow, {
        title: dialogTitle,
        properties: ['openFile'],
        filters: [{ name: 'Excel', extensions: ['xlsx'] }]
      });
      if (choice.canceled || !choice.filePaths || choice.filePaths.length === 0) {
        return { status: 'cancelled' };
      }
      const filePath = choice.filePaths[0];
      const result = readReconIdFixFile(filePath, subMode);
      reconIdFixSession = {
        filePath: result.filePath,
        fileName: result.fileName,
        sheets: result.sheets,
        importedAt: result.importedAt,
        // v2.1.0-beta.3 T9：记录 import 时的 subMode，run/export 校验时核对
        subMode
      };
      // 资金红线：重新导入清空 result（避免旧结果误导出）
      reconIdFixResult = null;
      return {
        status: 'ok',
        fileName: result.fileName,
        sheetCounts: {
          recon: result.sheets.reconResult.length,
          business: result.sheets.businessBills.length,
          opp: result.sheets.opponentBills.length
        }
      };
    } catch (error) {
      // FileValidationError → invalid 分支带 detailLines（spec §三 import 形态）
      if (error && error.name === 'FileValidationError') {
        return {
          status: 'invalid',
          code: error.code,
          message: error.message,
          detailLines: Array.isArray(error.detailLines) ? error.detailLines : []
        };
      }
      return {
        status: 'failed',
        message: String(error && error.message ? error.message : error)
      };
    }
  });

  trackedIpcHandle('recon-id-fix:run', '对账单 ReconID 修复', '开始运行', (_event, payload) => {
    try {
      if (!reconIdFixSession) {
        return { status: 'failed', message: '请先点击"导入文件"' };
      }
      const scenarioId = payload && (payload.scenarioId !== undefined ? payload.scenarioId : null);
      if (scenarioId === null || scenarioId === undefined) {
        return { status: 'failed', message: '请先在主面板"场景"下拉选择一个场景' };
      }
      const scenario = database.getScenario(scenarioId);
      if (!scenario) {
        return { status: 'failed', message: `场景 id=${scenarioId} 不存在` };
      }
      // v2.1.0-beta.3 T9：扩 category 校验到两个 ReconID 子模式 + 验证 session 的 subMode 与 scenario.category 一致
      if (scenario.category !== 'recon-id-fix' && scenario.category !== 'gateway-recon-id-fix') {
        return { status: 'failed', message: `场景 "${scenario.name}" 不是对账单 ReconID 修复类，无法运行` };
      }
      const expectedSubMode = scenario.category === 'gateway-recon-id-fix' ? 'gateway' : 'business';
      const sessionSubMode = reconIdFixSession.subMode || 'business';
      if (expectedSubMode !== sessionSubMode) {
        return {
          status: 'failed',
          message: `场景账单类别（${expectedSubMode === 'gateway' ? '网关对账单' : '单据对账单'}）与已导入文件类别（${sessionSubMode === 'gateway' ? '网关对账单' : '单据对账单'}）不一致，请重新导入文件`
        };
      }
      // 深拷贝 sheets（避免 in-place 修改污染 session；与 bank-statement:run 一致）
      const clonedSheets = {
        reconResult: structuredClone(reconIdFixSession.sheets.reconResult),
        businessBills: structuredClone(reconIdFixSession.sheets.businessBills),
        opponentBills: structuredClone(reconIdFixSession.sheets.opponentBills),
        fixTemplate: reconIdFixSession.sheets.fixTemplate
      };
      const result = runReconIdFix(scenario, clonedSheets);
      reconIdFixResult = {
        scenarioId: scenario.id,
        scenarioName: scenario.name,
        fixedRows: result.fixedRows,
        warnings: result.warnings,
        unmatchedRows: result.unmatchedRows || [],   // Round 3：落 unmatched
        scenariosSnapshot: buildReconIdFixSnapshot(scenario),
        ranAt: Date.now()
      };
      return {
        status: 'ok',
        stats: result.stats
      };
    } catch (error) {
      return { status: 'failed', message: String(error && error.message ? error.message : error) };
    }
  });

  trackedIpcHandle('recon-id-fix:export', '对账单 ReconID 修复', '导出文件', async () => {
    try {
      if (!reconIdFixResult) {
        return { status: 'failed', message: '请先点击"开始运行"' };
      }
      // ===== 资金红线 defense in depth（spec §十.2）=====
      const currentScenario = database.getScenario(reconIdFixResult.scenarioId);
      if (!currentScenario) {
        reconIdFixResult = null;
        return {
          status: 'failed',
          code: 'stale-snapshot',
          message: '场景已删除，请重新选择场景再运行'
        };
      }
      const currentSnapshot = buildReconIdFixSnapshot(currentScenario);
      if (currentSnapshot !== reconIdFixResult.scenariosSnapshot) {
        reconIdFixResult = null;
        return {
          status: 'failed',
          code: 'stale-snapshot',
          message: '场景已变更，请重新点击"开始运行"再导出'
        };
      }
      // Round 3 决策（Decision 3）：双文件输出
      const fixedRows = Array.isArray(reconIdFixResult.fixedRows) ? reconIdFixResult.fixedRows : [];
      const unmatchedRows = Array.isArray(reconIdFixResult.unmatchedRows) ? reconIdFixResult.unmatchedRows : [];
      // 主+unmatched 都空 → empty
      if (fixedRows.length === 0 && unmatchedRows.length === 0) {
        return {
          status: 'empty',
          message: '本次运行无修复记录且无未匹配记录，未生成文件'
        };
      }
      // 同步生成 timestamp，主+unmatched 共用
      const timestamp = buildReconIdFixTimestampMinute();
      // PR #36 self-review round 5（P3-A，2026-05-09）：
      //   fixedRows 空 + unmatched 非空时，saveDialog 默认名直接用 unmatched 名，
      //   让"用户选的路径"语义对得上"实际写出的文件"——避免用户选 A.xlsx 但桌面上是
      //   另一个固定命名的困惑。
      // v2.1.0-beta.3 T9：按 scenario.category 推导 subMode，影响文件名前缀 + writer 输出列模板
      const exportSubMode = currentScenario.category === 'gateway-recon-id-fix' ? 'gateway' : 'business';
      const defaultFileName = (fixedRows.length === 0 && unmatchedRows.length > 0)
        ? buildReconIdFixUnmatchedReportFileName(reconIdFixResult.scenarioName, timestamp, null, exportSubMode)
        : buildReconIdFixMainOutputFileName(reconIdFixResult.scenarioName, timestamp, exportSubMode);
      const dialogSaveTitle = exportSubMode === 'gateway' ? '保存网关对账修复结果' : '保存单据对账修复结果';
      const saveResult = await dialog.showSaveDialog(mainWindow, {
        title: dialogSaveTitle,
        defaultPath: path.join(app.getPath('documents'), defaultFileName),
        filters: [{ name: 'Excel', extensions: ['xlsx'] }]
      });
      if (saveResult.canceled || !saveResult.filePath) {
        return { status: 'cancelled' };
      }
      const ret = {
        status: 'ok',
        mainFilePath: null,
        mainFileName: null,
        unmatchedFilePath: null,
        unmatchedFileName: null,
        rowCount: 0,
        unmatchedCount: 0
      };
      // PR #36 self-review round 5（P3-A 配套）：
      //   fixedRows 空时，用户选的路径直接用作 unmatched 文件路径（默认名也是 unmatched 名）。
      //   fixedRows 非空时，用户选的路径写主文件，unmatched 文件名联动主文件 basename。
      if (fixedRows.length === 0) {
        // 仅 unmatched 分支：用户选定路径就是 unmatched 文件
        const writeUnmResult = await writeUnmatchedReport({
          unmatchedRows,
          savePath: saveResult.filePath
        });
        ret.unmatchedFilePath = writeUnmResult.filePath;
        ret.unmatchedFileName = writeUnmResult.fileName;
        ret.unmatchedCount = writeUnmResult.rowCount;
      } else {
        // 主非空：写主文件（v2.1.0-beta.3 T9 — 传 subMode 选输出列模板 + sheet 名）
        const writeResult = await writeReconIdFixOutput({
          fixedRows,
          savePath: saveResult.filePath,
          subMode: exportSubMode
        });
        ret.mainFilePath = writeResult.filePath;
        ret.mainFileName = writeResult.fileName;
        ret.rowCount = writeResult.rowCount;
        // PR #36 self-review round 5（P3-B，2026-05-09）：
        //   主+unmatched 都非空时，unmatched 文件名联动用户改过的主文件 basename：
        //   `{用户主文件名 stem}-未匹配.xlsx`，写到主文件同目录。
        if (unmatchedRows.length > 0) {
          const mainSaveDir = path.dirname(saveResult.filePath);
          const mainBaseName = path.basename(saveResult.filePath);
          const unmatchedFileName = buildReconIdFixUnmatchedReportFileName(
            reconIdFixResult.scenarioName,
            timestamp,
            mainBaseName,
            exportSubMode
          );
          const unmatchedSavePath = path.join(mainSaveDir, unmatchedFileName);
          const writeUnmResult = await writeUnmatchedReport({
            unmatchedRows,
            savePath: unmatchedSavePath
          });
          ret.unmatchedFilePath = writeUnmResult.filePath;
          ret.unmatchedFileName = writeUnmResult.fileName;
          ret.unmatchedCount = writeUnmResult.rowCount;
        }
      }
      return ret;
    } catch (error) {
      return { status: 'failed', message: String(error && error.message ? error.message : error) };
    }
  });

  // v2.1.0-beta.3 PR #39 Codex#1（P2）：清空 main 端 session + result
  // 用户切换"账单类别"时调用，避免 reloadReconIdFixScenarios 内的 refreshReconIdFixStatus 从 main 拉回旧 session
  ipcMain.handle('recon-id-fix:clear-session', () => {
    reconIdFixSession = null;
    reconIdFixResult = null;
    return { status: 'ok' };
  });
  ipcMain.handle('recon-id-fix:session-status', () => {
    return {
      status: 'ok',
      hasFile: reconIdFixSession !== null,
      fileName: reconIdFixSession ? reconIdFixSession.fileName : null,
      sheetCounts: reconIdFixSession && reconIdFixSession.sheets
        ? {
            recon: Array.isArray(reconIdFixSession.sheets.reconResult) ? reconIdFixSession.sheets.reconResult.length : 0,
            business: Array.isArray(reconIdFixSession.sheets.businessBills) ? reconIdFixSession.sheets.businessBills.length : 0,
            opp: Array.isArray(reconIdFixSession.sheets.opponentBills) ? reconIdFixSession.sheets.opponentBills.length : 0
          }
        : null,
      hasResult: reconIdFixResult !== null,
      resultStats: reconIdFixResult ? {
        fixedRowCount: Array.isArray(reconIdFixResult.fixedRows) ? reconIdFixResult.fixedRows.length : 0,
        warningCount: Array.isArray(reconIdFixResult.warnings) ? reconIdFixResult.warnings.length : 0,
        // Round 3：暴露 unmatchedRowCount
        unmatchedRowCount: Array.isArray(reconIdFixResult.unmatchedRows) ? reconIdFixResult.unmatchedRows.length : 0
      } : null
    };
  });

  ipcMain.handle('app:save-user-guide', async () => {
    try {
      // v2.0.0 GA：默认 HTML（filters 第一项被 saveDialog 当默认；同时 defaultPath 带 .html 后缀加固）
      const result = await dialog.showSaveDialog(mainWindow, {
        defaultPath: '使用手册.html',
        filters: [
          { name: 'HTML 文件', extensions: ['html'] },
          { name: '纯文本文件', extensions: ['txt'] }
        ]
      });

      if (result.canceled || !result.filePath) {
        return { status: 'cancelled' };
      }

      const userGuidePath = path.join(app.getAppPath(), 'docs', 'USER_GUIDE.md');
      const markdown = fs.readFileSync(userGuidePath, 'utf8');
      const ext = path.extname(result.filePath).toLowerCase();

      if (ext === '.txt') {
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

  // v2.1.8 N1' (v0.7)：renderer 上报用户活动（mousemove/keydown/click 节流后）
  //   - 仅更新 lastUserActivityTs（不做日志/统计）
  //   - 高频事件 → ipcMain.on 选用单向通道（无 Promise / 无 reply），renderer 用 ipcRenderer.send
  //   - 节流由 renderer 端做（10s 一次），main 不再做防抖
  ipcMain.on('app:user-activity', () => {
    lastUserActivityTs = Date.now();
  });

  // v2.1.9 SR-log-1 (T32g)：renderer 通用告警上报 handler（spec §15.4）
  //   - 转调 appendActivityLogEntry → 双写 app_activity_log.txt + logs/{YYYY-MM}/{MM-DD}/{level}.log
  //   - 单向通道（与 app:user-activity 一致），不需要 reply
  //   - payload 字段全部用兜底值（防 renderer 漏字段崩 main）
  //   - 异常 graceful：appendActivityLogEntry 内部 try-catch，外层兜底防御
  ipcMain.on('app:report-log', (_event, payload = {}) => {
    try {
      const safePayload = payload && typeof payload === 'object' ? payload : {};
      appendActivityLogEntry({
        level: safePayload.level || 'info',
        source: safePayload.source || 'renderer',
        domain: safePayload.domain,
        message: safePayload.message,
        details: Array.isArray(safePayload.details) ? safePayload.details : [],
        stack: safePayload.stack
      });
    } catch (_error) {
      // graceful — 不向 renderer 抛错（单向通道），不阻塞业务
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

  trackedIpcHandle('account-mapping:save', '生成网银账单', '账户映射', (_event, templateId, mappings) => {
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

  trackedIpcHandle('template:import', '生成网银账单', '导入模板', async () => {
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

  trackedIpcHandle('template:delete', '生成网银账单', '模板管理', (_event, templateId) => {
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

  trackedIpcHandle('template:save-mappings', '生成网银账单', '模板管理', (_event, payload) => {
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

  trackedIpcHandle('template:rename', '生成网银账单', '模板管理', (_event, payload = {}) => {
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

  trackedIpcHandle('template:export-bundle', '生成网银账单', '模板管理', async () => {
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

  trackedIpcHandle('template:import-bundle', '生成网银账单', '模板管理', async () => {
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
  applyWatermark(baseWb);
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
      // v2.1.9 SR-log-1：deprecated IPC 调用警告 → 日志上报
      appendActivityLogEntry({
        level: 'warning',
        source: 'main',
        domain: 'big-account',
        message: '[v1.5.3] big-account:save-own-accounts is deprecated',
        details: ['own accounts should be persisted via template:save-mappings']
      });
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
  trackedIpcHandle('file:import', '生成网银账单', '导入文件', async (_event, templateId) => {
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

  trackedIpcHandle('file:export-detail', '生成网银账单', '导出明细', (_event, scope = 'auto') => {
    return exportStatementByScope('detail', scope);
  });

  trackedIpcHandle('file:export-balance', '生成网银账单', '导出余额', (_event, scope = 'auto') => {
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
  // PR #34 self-review：与 file:export-balance 共享"导出余额"功能 key（用户视角都是月度/单批的导出余额操作）
  trackedIpcHandle('monthly-balance:export', '生成网银账单', '导出余额', async () => {
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
  trackedIpcHandle('new-account:generate', '新开账户', '生成余额账单', (_event, payload = {}) => {
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

  trackedIpcHandle('new-account:export', '新开账户', '导出余额', () => {
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

  trackedIpcHandle('pending:rule:save', '月度 Pending', '规则管理', (_event, payload) => {
    if (!pendingDb) {
      throw new Error('Pending DB 未初始化，无法保存规则');
    }
    // PR #34 round 4 P2：包一层 status 让 trackedIpcHandle 能识别成功
    const data = pendingRuleRepo.upsertRule(pendingDb, payload || {});
    return { status: 'success', ...data };
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

  trackedIpcHandle('pending:import:start', '月度 Pending', '导入文件', async (event, payload) => {
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

  trackedIpcHandle('pending:reconcile:run', '月度 Pending', '开始运行', (_event, payload = {}) => {
    if (!pendingDb) throw new Error('Pending DB 未初始化');
    const rule = pendingRuleRepo.getRule(pendingDb);
    if (!rule || !rule.matchFields || rule.matchFields.length === 0) {
      throw new Error('规则未设置（matchFields 为空）');
    }
    // PR #34 round 4 P2：包一层 status 让 trackedIpcHandle 能识别成功
    const result = pendingReconcileEngine.runReconciliation(pendingDb, {
      upperMonth: payload.upperMonth,
      lowerMonth: payload.lowerMonth,
      rule
    });

    // v2.1.11 T2（D-T2-2 对账后自动匹配）：若该 upperMonth 有移除归档数据 → 用同一套 matchFields
    //   把该 run 的 missing 行与移除数据配对，结果落 pending_removal_matches（供导出标记）。
    //   matchFields 复用对账规则（资金红线：不另造规则）。匹配失败 graceful —— 对账已成功落库，
    //   不因移除核对异常而让整个对账 IPC 报错（用户仍能拿到对账结果 + 重跑导出触发匹配）。
    let removalMatchResult = null;
    try {
      if (result && result.runId
          && pendingRemovedRepo.countByMonth(pendingDb, payload.upperMonth) > 0) {
        removalMatchResult = pendingRemovalMatch.matchRemoval(
          pendingDb, result.runId, payload.upperMonth, rule.matchFields
        );
      }
    } catch (matchErr) {
      appendActivityLogEntry({
        level: 'warning',
        source: 'main',
        domain: 'pending-removal-match',
        message: '[pending] 对账后移除核对匹配失败（对账结果不受影响）',
        details: [matchErr && matchErr.message ? matchErr.message : String(matchErr)],
        stack: matchErr && matchErr.stack ? matchErr.stack : undefined
      });
      // I-R2-1（v2.1.11 SR Round 2）：匹配抛错时返回「可区分的失败标记」，而非沿用 null。
      //   null 语义已被「countByMonth=0 无移除归档数据，未触发核对」占用（上面 try 内 removalMatchResult
      //   初值 null 且仅在有数据时才赋值）。若 error 也返回 null，renderer 会显示"无移除归档数据"——
      //   与"数据确实存在但匹配崩溃"事实相反（资金/对账模块误导）。故 error 态独立标记 { error: true }，
      //   由 buildRemovalMatchSummary 区分出"移除核对执行异常"文案。
      removalMatchResult = { error: true };
    }

    return { status: 'success', ...result, removalMatch: removalMatchResult };
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

  trackedIpcHandle('pending:diff:export-single', '月度 Pending', '导出差异', async (_event, payload = {}) => {
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

  trackedIpcHandle('pending:diff:export-aggregate', '月度 Pending', '导出差异', async () => {
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

  // ============================================================
  // v2.1.11 T2 移除核对：移除归档 Pending 文件 — pending:removed:* IPC handler
  //   流程（spec §3.3 / D-T2-1）：导入某月数据成功 → renderer 弹"是否核对移除pending数据？"
  //     → 是 → pickFiles → import（解析 + 入库 removed_pending_rows，关联导入月份 = 后续对账 upperMonth）
  //   匹配在对账后自动触发（见 pending:reconcile:run handler 末尾，D-T2-2）。
  // ============================================================

  ipcMain.handle('pending:removed:pick-files', async () => {
    const result = await dialog.showOpenDialog({
      title: '选择移除归档 Pending 文件',
      filters: [{ name: 'Excel', extensions: ['xlsx'] }],
      properties: ['openFile', 'multiSelections']
    });
    if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
      return { cancelled: true };
    }
    return { cancelled: false, files: result.filePaths };
  });

  trackedIpcHandle('pending:removed:import', '月度 Pending', '导入移除核对', (_event, payload = {}) => {
    if (!pendingDb) return { status: 'error', message: 'Pending DB 未初始化' };
    const { yearMonth, files } = payload || {};
    if (!yearMonth || !/^\d{4}-\d{2}$/.test(yearMonth)) {
      return { status: 'error', message: 'yearMonth 格式错误（应为 YYYY-MM）' };
    }
    if (!Array.isArray(files) || files.length === 0) {
      return { status: 'error', message: '未选择移除归档文件' };
    }
    // 多文件合并解析；任一文件解析失败（表头不符/空文件）→ 整体报错，不入库（资金红线：避免半写）
    const allRows = [];
    const sourceNames = [];
    try {
      for (const fp of files) {
        const parsed = pendingRemovedReader.readRemovedPendingFile(fp);
        for (const r of parsed.rows) allRows.push(r);
        sourceNames.push(parsed.fileName || fp);
      }
    } catch (err) {
      return {
        status: 'error',
        message: err && err.message ? err.message : String(err),
        detailLines: err && Array.isArray(err.detailLines) ? err.detailLines : undefined
      };
    }
    try {
      const result = pendingRemovedRepo.replaceByMonth(pendingDb, yearMonth, allRows, sourceNames.join(', '));
      return {
        status: 'success',
        yearMonth,
        inserted: result.inserted,
        deleted: result.deleted,
        fileCount: files.length
      };
    } catch (err) {
      return { status: 'error', message: err && err.message ? err.message : String(err) };
    }
  });

  // ============================================================
  // v2.1.2 T2：月度银行对账单BU回填校验 — bankBuRecon:* IPC handler
  // PRD §三 / spec §3.5：10 个 handler；资金红线模块（OPEN ISSUE #10 v0.8 修订：1:1/1:N/N:1 视为对账成功，N:M 异常 sheet）
  // ============================================================

  ipcMain.handle('bankBuRecon:months:list', () => {
    if (!database || !database.db) return [];
    try { return bankBuReconSession.listMonths(); } catch (_e) { return []; }
  });

  ipcMain.handle('bankBuRecon:status', (_event, payload = {}) => {
    if (!database || !database.db) return null;
    const { yearMonth } = payload || {};
    if (!yearMonth) return null;
    try {
      const meta = bankBuReconSession.getMonthMeta(yearMonth);
      const latestRun = bankBuReconSession.listRuns(yearMonth)[0] || null;
      return { meta, latestRun };
    } catch (_e) {
      return null;
    }
  });

  // v2.1.2 spec v0.4 修正：拆为两个独立单选 IPC，前端用 Clear 风 modal 串联流程
  // 旧的 bankBuRecon:import:pick-files（一次返回两个路径 + showMessageBox 提示）已删除：
  //   - macOS dialog.showOpenDialog.title 不显示 → showMessageBox 兜底
  //   - 但 showMessageBox 是系统对话框，与项目其他模块的前端 modal 风格割裂
  // 现在前端用 createBankBuReconFileImportPromptDialog（Clear 风 modal）显式提示，再各调一次 pick-*-file
  ipcMain.handle('bankBuRecon:import:pick-pending-file', async (_event, payload = {}) => {
    const { yearMonth } = payload || {};
    if (!yearMonth || !/^\d{4}-\d{2}$/.test(yearMonth)) {
      return { status: 'error', message: 'yearMonth 格式错误（应为 YYYY-MM）' };
    }
    const res = await dialog.showOpenDialog({
      title: `Pending 数据管理文件（${yearMonth}）`,
      filters: [{ name: 'Excel', extensions: ['xlsx'] }],
      properties: ['openFile']
    });
    if (res.canceled || !res.filePaths || res.filePaths.length === 0) {
      return { status: 'cancelled' };
    }
    return { status: 'success', filePath: res.filePaths[0] };
  });

  ipcMain.handle('bankBuRecon:import:pick-bank-file', async (_event, payload = {}) => {
    const { yearMonth } = payload || {};
    if (!yearMonth || !/^\d{4}-\d{2}$/.test(yearMonth)) {
      return { status: 'error', message: 'yearMonth 格式错误（应为 YYYY-MM）' };
    }
    const res = await dialog.showOpenDialog({
      title: `银行对账单文件（${yearMonth}）`,
      filters: [{ name: 'Excel', extensions: ['xlsx'] }],
      properties: ['openFile']
    });
    if (res.canceled || !res.filePaths || res.filePaths.length === 0) {
      return { status: 'cancelled' };
    }
    return { status: 'success', filePath: res.filePaths[0] };
  });

  trackedIpcHandle('bankBuRecon:import:run', '月度银行对账单BU回填校验', '导入文件', async (_event, payload = {}) => {
    const { yearMonth, pendingPath, bankPath } = payload || {};
    if (!database || !database.db) {
      return { status: 'error', message: '数据库未初始化' };
    }
    if (!yearMonth || !/^\d{4}-\d{2}$/.test(yearMonth)) {
      return { status: 'error', message: 'yearMonth 格式错误（应为 YYYY-MM）' };
    }
    if (!pendingPath || !bankPath) {
      return { status: 'error', message: '缺少文件路径' };
    }
    try {
      const pendingResult = readPendingGuanliFile(pendingPath);
      const bankResult = readBankFile(bankPath);
      const counts = bankBuReconSession.importMonth(yearMonth, pendingResult.rows, bankResult.rows);
      return { status: 'success', yearMonth, ...counts };
    } catch (err) {
      if (err && err.name === 'FileValidationError') {
        return {
          status: 'error',
          code: err.code,
          message: err.message,
          detailLines: err.detailLines || [],
          context: err.context || {}
        };
      }
      return { status: 'error', message: err && err.message ? err.message : String(err) };
    }
  });

  trackedIpcHandle('bankBuRecon:run', '月度银行对账单BU回填校验', '开始运行', (_event, payload = {}) => {
    if (!database || !database.db) return { status: 'error', message: '数据库未初始化' };
    const { yearMonth } = payload || {};
    if (!yearMonth || !/^\d{4}-\d{2}$/.test(yearMonth)) {
      return { status: 'error', message: 'yearMonth 格式错误' };
    }
    try {
      const result = bankBuReconSession.run(yearMonth);
      return { status: 'success', ...result };
    } catch (err) {
      return { status: 'error', message: err && err.message ? err.message : String(err) };
    }
  });

  // v0.5: 弹另存为对话框（前端→后端）
  ipcMain.handle('bankBuRecon:export:pick-save-path', async (_event, payload = {}) => {
    const { defaultFileName } = payload || {};
    const result = await dialog.showSaveDialog({
      title: '保存差异表',
      defaultPath: defaultFileName || '月度银行对账单BU回填校验.xlsx',
      filters: [{ name: 'Excel', extensions: ['xlsx'] }]
    });
    if (result.canceled || !result.filePath) return { status: 'cancelled' };
    return { status: 'success', savePath: result.filePath };
  });

  // v0.5: 单月导出到用户指定路径（替代旧 bankBuRecon:export）
  trackedIpcHandle('bankBuRecon:export:single', '月度银行对账单BU回填校验', '导出差异', async (_event, payload = {}) => {
    if (!database || !database.db) return { status: 'error', message: '数据库未初始化' };
    const { runId, savePath } = payload || {};
    const runIdNum = Number(runId);
    if (!Number.isFinite(runIdNum) || runIdNum <= 0) {
      return { status: 'error', message: 'runId 无效' };
    }
    if (!savePath) return { status: 'error', message: '保存路径未指定' };
    const run = bankBuReconSession.getRun(runIdNum);
    if (!run) return { status: 'error', message: '运行记录不存在' };
    if (run.status !== 'success') {
      return { status: 'error', message: '运行未成功（status=' + run.status + '），无法导出差异表' };
    }
    try {
      const lastResult = bankBuReconSession.loadRunResultByRunId(runIdNum);
      if (!lastResult) {
        return { status: 'error', message: '加载 run 数据失败（可能源数据已变）' };
      }
      const exp = await writeBankBuReconDiffWorkbook({
        storageRoot: ensureStorageRoot(),
        yearMonth: run.year_month,
        matchedPending: lastResult.matchedPending,
        matchedBank: lastResult.matchedBank,
        buDiffPendingIds: lastResult.buDiffPendingIds,
        buDiffBankIds: lastResult.buDiffBankIds,
        nmAnomalies: lastResult.nmAnomalies,   // v0.8: N:M 异常组写入第 3 sheet
        // v0.5：用 savePath 直接写到用户指定路径，不走 buildOutputPath
        overrideSavePath: savePath
      });
      bankBuReconSession.recordExportPath(runIdNum, exp.filePath);
      return { status: 'success', filePath: exp.filePath };
    } catch (err) {
      return { status: 'error', message: err && err.message ? err.message : String(err) };
    }
  });

  // v0.5: 跨月汇总导出到用户指定路径
  trackedIpcHandle('bankBuRecon:export:aggregate', '月度银行对账单BU回填校验', '导出差异', async (_event, payload = {}) => {
    if (!database || !database.db) return { status: 'error', message: '数据库未初始化' };
    const { savePath } = payload || {};
    if (!savePath) return { status: 'error', message: '保存路径未指定' };
    try {
      const { months, skippedMonths } = bankBuReconSession.aggregateLatestSuccessRuns();
      if (months.length === 0) {
        return { status: 'error', message: '无可汇总的成功运行记录', skippedMonths };
      }
      const exp = await writeBankBuReconAggregateDiffWorkbook({
        matchedMonths: months,
        savePath
      });
      return { status: 'success', filePath: exp.filePath, skippedMonths, includedMonths: months.map((m) => m.yearMonth) };
    } catch (err) {
      return { status: 'error', message: err && err.message ? err.message : String(err) };
    }
  });

  ipcMain.handle('bankBuRecon:run:history', (_event, payload = {}) => {
    if (!database || !database.db) return [];
    const { yearMonth } = payload || {};
    if (!yearMonth) return [];
    try { return bankBuReconSession.listRuns(yearMonth); } catch (_e) { return []; }
  });

  // v0.5: 列出"两侧都已导入"的月份（用于「开始运行」弹窗）
  ipcMain.handle('bankBuRecon:run:list-ready-months', () => {
    if (!database || !database.db) return [];
    try {
      const list = bankBuReconSession.listReadyMonths();
      return list.map((m) => m.yearMonth);
    } catch (_e) {
      return [];
    }
  });

  // v0.5: 列出"有 status=success run"的月份（用于「导出差异」弹窗）
  ipcMain.handle('bankBuRecon:run:list-success-months', () => {
    if (!database || !database.db) return [];
    try { return bankBuReconSession.listSuccessMonths(); } catch (_e) { return []; }
  });

  // ==========================================================================
  // v2.1.3：业务OP数据核对 IPC handlers（spec §三 共 17 个）
  // 命名空间 bizOpRecon:*；与 bankBuRecon:* 完全独立
  // ==========================================================================

  // 模块状态查询
  ipcMain.handle('bizOpRecon:status', () => {
    if (!database || !database.db) return { importedDateBuPairs: [], buList: [], flowImportedDates: [] };
    try {
      return bizOpReconSession.getStatus();
    } catch (_e) {
      return { importedDateBuPairs: [], buList: [], flowImportedDates: [] };
    }
  });

  // BU 下拉框枚举（保留原值不 normalize；#A 拍板）
  ipcMain.handle('bizOpRecon:bu:list', () => {
    if (!database || !database.db) return [];
    try {
      return bizOpReconSession.listBu();
    } catch (_e) {
      return [];
    }
  });

  // 业务OP 文件选择（弹原生文件对话框）
  ipcMain.handle('bizOpRecon:import:pick-biz-op-file', async (_event, payload = {}) => {
    const { date } = payload || {};
    try {
      const result = await dialog.showOpenDialog({
        title: `选择业务OP 文件（日期 ${date || ''}）`,
        properties: ['openFile'],
        filters: [{ name: 'Excel', extensions: ['xlsx'] }]
      });
      if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
        return { status: 'cancelled' };
      }
      return { status: 'ok', filePath: result.filePaths[0] };
    } catch (err) {
      return { status: 'error', message: err && err.message ? err.message : String(err) };
    }
  });

  // 流水对账单 文件选择
  ipcMain.handle('bizOpRecon:import:pick-flow-file', async (_event, payload = {}) => {
    const { date } = payload || {};
    try {
      const result = await dialog.showOpenDialog({
        title: `选择流水对账单 文件（日期 ${date || ''}）`,
        properties: ['openFile'],
        filters: [{ name: 'Excel', extensions: ['xlsx'] }]
      });
      if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
        return { status: 'cancelled' };
      }
      return { status: 'ok', filePath: result.filePaths[0] };
    } catch (err) {
      return { status: 'error', message: err && err.message ? err.message : String(err) };
    }
  });

  // 业务OP 导入（#1 双重校验 + #4 替换原子事务 + #5 整批拒绝 + #15 清空旧 runs）
  // PR #45 round 3 P2：trackedIpcHandle 接入；仅 status='success' 计数（rejected/error 不计，spec D6）
  trackedIpcHandle('bizOpRecon:import:run-biz-op', '业务OP数据核对', '导入文件', async (event, payload = {}) => {
    if (!database || !database.db) return { status: 'error', message: '数据库未就绪' };
    const { date, filePath } = payload || {};
    if (!date || !filePath) return { status: 'error', message: '入参缺失（date / filePath）' };
    try {
      const errorReportsDir = path.join(ensureStorageRoot(), 'error-reports');
      // v2.1.12-beta β.2-T2：默认 worker 化（dbPath 主 DB tool-data.sqlite，与 acquiring worker 同库 WAL 并发）
      //   进度透传 renderer（仿 pending:import:progress 范式，swallow send 失败）
      //   readBizOpFile 仍传——worker 入口在无 dbPath 时回退旧同步路径用
      const result = await runBizOpImport(database.db, {
        date,
        filePath,
        dbPath: database.dbPath,
        readBizOpFile,
        writeBizOpErrorReportXlsx,
        errorReportsDir,
        onProgress: (ev) => {
          try { event.sender.send('bizOpRecon:import:progress', { ...ev, kind: 'bizOp' }); }
          catch (_e) { /* swallow */ }
        }
      });
      return result;
    } catch (err) {
      return {
        status: 'error',
        message: err && err.message ? err.message : String(err),
        detailLines: err && err.detailLines ? err.detailLines : []
      };
    }
  });

  // 流水对账单 导入（#3 出入方向枚举 + #5 整批拒绝）
  // PR #45 round 3 P2：trackedIpcHandle 接入；仅 status='success' 计数
  trackedIpcHandle('bizOpRecon:import:run-flow', '业务OP数据核对', '导入文件', async (event, payload = {}) => {
    if (!database || !database.db) return { status: 'error', message: '数据库未就绪' };
    const { date, filePath } = payload || {};
    if (!date || !filePath) return { status: 'error', message: '入参缺失（date / filePath）' };
    try {
      const errorReportsDir = path.join(ensureStorageRoot(), 'error-reports');
      // v2.1.12-beta β.2-T2：默认 worker 化（同 run-biz-op）；readFlowFile 传作无 dbPath 回退用
      const result = await runFlowImport(database.db, {
        date,
        filePath,
        dbPath: database.dbPath,
        readFlowFile,
        writeFlowErrorReportXlsx,
        errorReportsDir,
        onProgress: (ev) => {
          try { event.sender.send('bizOpRecon:import:progress', { ...ev, kind: 'flow' }); }
          catch (_e) { /* swallow */ }
        }
      });
      return result;
    } catch (err) {
      return {
        status: 'error',
        message: err && err.message ? err.message : String(err),
        detailLines: err && err.detailLines ? err.detailLines : []
      };
    }
  });

  // 打开错误报告文件夹（#5 拍板）
  ipcMain.handle('bizOpRecon:import:open-error-report-folder', async (_event, payload = {}) => {
    const { errorReportPath } = payload || {};
    if (!errorReportPath) return { ok: false, message: '路径为空' };
    try {
      const { shell } = require('electron');
      shell.showItemInFolder(errorReportPath);
      return { ok: true };
    } catch (err) {
      return { ok: false, message: err && err.message ? err.message : String(err) };
    }
  });

  // 检查"库里仅有一日数据"（#11 拍板 B）
  ipcMain.handle('bizOpRecon:import:check-single-day', (_event, payload = {}) => {
    if (!database || !database.db) return { onlyOneDay: false, count: 0 };
    const { buName } = payload || {};
    if (!buName) return { onlyOneDay: false, count: 0 };
    try {
      return bizOpReconSession.checkSingleDay(buName);
    } catch (_e) {
      return { onlyOneDay: false, count: 0 };
    }
  });

  // 列 ready 日期（#12 + #13 拍板 A）
  ipcMain.handle('bizOpRecon:run:list-ready-dates', (_event, payload = {}) => {
    if (!database || !database.db) return [];
    const { buName } = payload || {};
    if (!buName) return [];
    try {
      return bizOpReconSession.listReadyDates(buName);
    } catch (_e) {
      return [];
    }
  });

  // 跑对账（#3/#6/#7/#10 拍板）
  // PR #45 round 3 P2：trackedIpcHandle 接入；仅 status='success' 计数
  trackedIpcHandle('bizOpRecon:run', '业务OP数据核对', '开始运行', (_event, payload = {}) => {
    if (!database || !database.db) return { status: 'error', message: '数据库未就绪' };
    const { date, buName } = payload || {};
    if (!date || !buName) return { status: 'error', message: '入参缺失（date / buName）' };
    try {
      const { runId, stats } = bizOpReconSession.run({ date, buName });
      return { runId, status: 'success', stats };
    } catch (err) {
      return { status: 'error', message: err && err.message ? err.message : String(err) };
    }
  });

  // 列 success 日期（#13 拍板 A，导出指定日期下拉来源）
  ipcMain.handle('bizOpRecon:export:list-success-dates', (_event, payload = {}) => {
    if (!database || !database.db) return [];
    const { buName } = payload || {};
    if (!buName) return [];
    try {
      return bizOpReconSession.listSuccessDates(buName);
    } catch (_e) {
      return [];
    }
  });

  // 弹另存为对话框（#9 拍板 A 默认文件名由前端拼好）
  ipcMain.handle('bizOpRecon:export:pick-save-path', async (_event, payload = {}) => {
    const { defaultFileName } = payload || {};
    try {
      const result = await dialog.showSaveDialog({
        title: '另存为',
        defaultPath: path.join(ensureStorageRoot(), 'exports', defaultFileName || 'export.xlsx'),
        filters: [{ name: 'Excel', extensions: ['xlsx'] }]
      });
      if (result.canceled || !result.filePath) return { status: 'cancelled' };
      return { status: 'ok', savePath: result.filePath };
    } catch (err) {
      return { status: 'error', message: err && err.message ? err.message : String(err) };
    }
  });

  // 导出指定日期（#14 拍板 A sheet 名 ISO）
  // PR #45 round 3 P2：trackedIpcHandle 接入；仅 status='success' 计数
  trackedIpcHandle('bizOpRecon:export:date', '业务OP数据核对', '导出差异', async (_event, payload = {}) => {
    if (!database || !database.db) return { status: 'error', message: '数据库未就绪' };
    const { runId, savePath } = payload || {};
    if (!runId || !savePath) return { status: 'error', message: '入参缺失（runId / savePath）' };
    try {
      const run = bizOpReconSession.getRun(runId);
      if (!run) return { status: 'error', message: `run #${runId} 不存在` };
      const result = await writeBizOpSingleDateDiffWorkbook({
        db: database.db,
        date: run.data_date,
        buName: run.bu_name,
        runId,
        savePath
      });
      bizOpReconSession.recordExportPath(runId, result.filePath);
      return { status: 'success', filePath: result.filePath, rowCount: result.rowCount };
    } catch (err) {
      return { status: 'error', message: err && err.message ? err.message : String(err) };
    }
  });

  // 导出指定日期区间（v2.1.3-fix6 拍板回滚：单 sheet 合并 + 第 1 列 Billdate 区分日期）
  // PR #45 round 3 P2：trackedIpcHandle 接入；仅 status='success' 计数
  trackedIpcHandle('bizOpRecon:export:date-range', '业务OP数据核对', '导出差异', async (_event, payload = {}) => {
    if (!database || !database.db) return { status: 'error', message: '数据库未就绪' };
    const { buName, startDate, endDate, savePath } = payload || {};
    if (!buName || !startDate || !endDate || !savePath) {
      return { status: 'error', message: '入参缺失（buName / startDate / endDate / savePath）' };
    }
    try {
      const result = await writeBizOpDateRangeDiffWorkbook({
        db: database.db,
        buName, startDate, endDate, savePath
      });
      return {
        status: 'success',
        filePath: result.filePath,
        sheetCount: result.sheetCount,
        skippedDates: result.skippedDates
      };
    } catch (err) {
      return { status: 'error', message: err && err.message ? err.message : String(err) };
    }
  });

  // 运行历史（debug 用，可选）
  ipcMain.handle('bizOpRecon:run:history', (_event, payload = {}) => {
    if (!database || !database.db) return [];
    const { date, buName } = payload || {};
    if (!date || !buName) return [];
    try {
      const runRepo = require('./backend/biz-op-recon-db/run-repository');
      return runRepo.listRunsByDateBu(database.db, date, buName);
    } catch (_e) {
      return [];
    }
  });

  // ==========================================================================
  // v2.1.12 需求1：VCC业务OP计算 — vccOpCalc:* IPC handlers（spec §3.6，6 个）
  // 命名空间 vccOpCalc:*；与现有 5 模块完全独立。资金红线 🔴（发生额求和 / 期末OP / 整数分精度）。
  // 资金/运行类用 trackedIpcHandle（scan / compute-amounts / save）；只读 list/get 用普通 handle。
  // 中间结果（scan/compute 的原始 rows + 统计）缓存在 vccOpCalcSession（仿 lastRunCache，spec Q1）。
  // ==========================================================================

  // 多选流水 xlsx（仿 bankBuRecon:import:pick-* + pending pick-files 的 multiSelections）
  ipcMain.handle('vccOpCalc:import:pick-files', async () => {
    const res = await dialog.showOpenDialog({
      title: '选择流水对账单文件（可多选）',
      filters: [{ name: 'Excel', extensions: ['xlsx'] }],
      properties: ['openFile', 'multiSelections']
    });
    if (res.canceled || !res.filePaths || res.filePaths.length === 0) {
      return { status: 'cancelled' };
    }
    return { status: 'success', filePaths: res.filePaths };
  });

  // 读多文件 → 统计总条数 + 定月份（供 F1）。
  // 整批拒绝（资金红线 🔴）：非法方向 / 非数值金额 / 空账单日期 / 多月份混杂 → status:'rejected' + errorRows。
  trackedIpcHandle('vccOpCalc:import:scan', 'VCC业务OP计算', '导入文件', async (event, payload = {}) => {
    if (!database || !database.db) return { status: 'error', message: '数据库未初始化' };
    const { filePaths } = payload || {};
    if (!Array.isArray(filePaths) || filePaths.length === 0) {
      return { status: 'error', message: '未选择文件' };
    }
    // 流式读取+聚合（spec §9 大文件路径，合并 scan+compute，不存全量行）；进度推送 renderer。
    // 表头校验失败 → FileValidationError；非法行/多月份混杂 → ok:false + errorRows（整批拒绝）。
    let result;
    try {
      result = await vccOpCalcSession.streamScanAndCompute(filePaths, {
        onProgress: (rows) => {
          if (event && event.sender && !event.sender.isDestroyed()) {
            event.sender.send('vccOpCalc:scan:progress', { rows });
          }
        }
      });
    } catch (err) {
      if (err && err.name === 'FileValidationError') {
        return {
          status: 'error',
          code: err.code,
          message: err.message,
          detailLines: err.detailLines || [],
          context: err.context || {}
        };
      }
      return { status: 'error', message: err && err.message ? err.message : String(err) };
    }
    if (!result.ok) {
      return { status: 'rejected', errorRows: result.errorRows, errorCount: result.errorCount };
    }
    return { status: 'success', yearMonth: result.yearMonth, totalRows: result.totalRows, fileCount: filePaths.length };
  });

  // 统计发生额出/入/总额 + perFile（供 F2，不落库）。复用 scan 缓存的 rows（资金红线：同口径整批校验）。
  trackedIpcHandle('vccOpCalc:run:compute-amounts', 'VCC业务OP计算', '开始运行', (_event, _payload = {}) => {
    if (!database || !database.db) return { status: 'error', message: '数据库未初始化' };
    // 流式改造（spec §9）：scan 阶段已合并统计并缓存 lastComputeCache，这里直接返回缓存（不重读文件）
    const cache = vccOpCalcSession.getComputeCache();
    if (!cache) return { status: 'error', message: '无统计结果（请先导入文件）' };
    return {
      status: 'success',
      yearMonth: cache.yearMonth,
      totals: cache.totals,
      perFile: cache.perFile
    };
  });

  // 收 beginOp → 算 endOp = beginOp + 发生额 → 原子落表 A/B（资金红线 🔴）。返回 { runId, endOp }。
  trackedIpcHandle('vccOpCalc:run:save', 'VCC业务OP计算', '开始运行', (_event, payload = {}) => {
    if (!database || !database.db) return { status: 'error', message: '数据库未初始化' };
    const { beginOp } = payload || {};
    try {
      const saved = vccOpCalcSession.saveRun({ beginOp });
      return { status: 'success', ...saved };
    } catch (err) {
      return { status: 'error', message: err && err.message ? err.message : String(err) };
    }
  });

  // distinct 已计算月份（供 F3 下拉）
  ipcMain.handle('vccOpCalc:balance:list-months', () => {
    if (!database || !database.db) return [];
    try {
      return vccOpCalcSession.listCalculatedMonths().map((m) => m.yearMonth);
    } catch (_e) {
      return [];
    }
  });

  // 取某月最新 run 的 { beginOp, totalAmount, endOp, ... }（供 F3 查看）
  ipcMain.handle('vccOpCalc:balance:get', (_event, payload = {}) => {
    if (!database || !database.db) return null;
    const { yearMonth } = payload || {};
    if (!yearMonth) return null;
    try {
      return vccOpCalcSession.getMonthResult(yearMonth);
    } catch (_e) {
      return null;
    }
  });

  // ============================================================
  // v2.1.6 Module B T9：收单单据币种校验 — acquiringBillCurrency:* IPC handler
  // spec §七：7 个 handler；⚠️ 资金红线模块
  // ============================================================

  ipcMain.handle('acquiringBillCurrency:listMonths', () => {
    if (!database || !database.db) return [];
    // v2.1.8 N1：进入模块兜底 — listMonths 是用户切到收单单据币种校验模块的第 1 个 IPC 调用
    //   spec §三 N1-D3 兜底触发点；检测 cleanup_pending → setImmediate 后台清（不阻塞 listMonths）+ toast
    triggerAcquiringBillCurrencyBackgroundCleanupIfNeeded();
    try { return acquiringBillCurrencySession.listMonths({ db: database.db }); } catch (_e) { return []; }
  });

  ipcMain.handle('acquiringBillCurrency:sessionStatus', (_event, payload = {}) => {
    if (!database || !database.db) return { monthKey: null, flowReady: false, billReady: false };
    const { monthKey } = payload || {};
    try {
      return acquiringBillCurrencySession.getSessionStatus({ db: database.db, monthKey });
    } catch (_e) {
      return { monthKey: monthKey || null, flowReady: false, billReady: false };
    }
  });

  // fix1（spec §3.4）：importFlow / importBill 改造为三段式
  //   1. 首调（无 payload）：弹 dialog → peek → 查 existingCount → 0 直接进事务；>0 返回 overwrite-required
  //   2. 二次调（{ filePaths, confirmOverwrite: true }）：跳过 dialog/peek，进"单侧清+导入"事务
  //   3. 异常分支：cancelled / error 携带 detailLines
  // fix3 → fix9 → fix10：通用 operation lock 提到 module-level（line 200 附近），import/run/export/cleanup
  // 互斥；cleanup 异步后台跑也持锁；fix10 启动钩子也共享同一把锁，避免 cleanup vs 用户首次 import 并发
  const tryAcquireOpLock = tryAcquireAcquiringBillCurrencyOpLock;
  const releaseOpLock = releaseAcquiringBillCurrencyOpLock;

  // v2.1.7 F6：进度事件 forwarder（spec §6.3 改动点 2）
  //   - createImportProgressForwarder：100ms 节流；stage='reading' 切换事件必发（文件切换）
  //   - createRunProgressForwarder：无节流（v2.1.10 SR-FIX-1 round 2 P1-9 reverse sync — 注释过时修订）
  //     v2.1.7 时每 run 仅 6 个事件；v2.1.10 A4 chunked 后每 run 6 + chunkCount 事件
  //     （500w 行 / chunk=10w = 50 chunks → 56 events；5000w 行 → 506 events）
  //     当前不节流；renderer 端 IPC listener 渲染抖动风险随数据量提升 — chunkCount > 100 时考虑节流（v2.1.11+）
  //   - try/catch swallow webContents.send 失败（参考 main.js:9520 pending:import:progress 范式）
  function createImportProgressForwarder(event) {
    if (!event || !event.sender) return null;
    let lastSentAt = 0;
    const THROTTLE_MS = 100;
    return (ev) => {
      const isStageSwitch = ev && ev.stage === 'reading';   // 文件切换必发，不节流
      const now = Date.now();
      if (!isStageSwitch && now - lastSentAt < THROTTLE_MS) return;
      lastSentAt = now;
      try { event.sender.send('acquiringBillCurrency:import:progress', { ...ev, phase: 'import' }); }
      catch (_e) { /* swallow — 窗口已销毁等 */ }
    };
  }
  function createRunProgressForwarder(event) {
    if (!event || !event.sender) return null;
    return (ev) => {
      try { event.sender.send('acquiringBillCurrency:run:progress', { ...ev, phase: 'run' }); }
      catch (_e) { /* swallow */ }
    };
  }

  // v2.1.7 F7-B1：runCheck 完成/失败弹系统通知（spec §7.5.2 / PRD §十一-B1）
  //   success：「收单单据币种校验」{monthKey} 对账完成（共 N 行差异）
  //   error：  「收单单据币种校验」对账失败：{message}（body 200 字符截断兜底 macOS 通知中心）
  //   cancelled (v2.1.10 SR-FIX-1 round 2 P1-4)：「收单单据币种校验」{monthKey} 已取消（轻量提示，不当错误）
  //   helper 内部 try/catch swallow，通知失败不影响 IPC return
  //   Notification.isSupported() 兜底极端环境（如无 GUI 的 CI / SSH 头）
  function notifyAcquiringBillCurrencyResult(monthKey, kind, payload) {
    try {
      if (!Notification || typeof Notification.isSupported !== 'function' || !Notification.isSupported()) return;
      const title = '「收单单据币种校验」';
      let body;
      if (kind === 'success') {
        const mismatch = (payload && typeof payload.mismatchRows === 'number') ? payload.mismatchRows : 0;
        body = `${monthKey} 对账完成（共 ${mismatch} 行差异）`;
      } else if (kind === 'cancelled') {
        // v2.1.10 SR-FIX-1 round 2 P1-4：用户主动取消（CancelError），轻量提示 — 不视为错误
        //   spec §2.4 设计契约 + CancelError class 注释明确：业务语义是用户主动取消
        const stage = payload && payload.stage ? String(payload.stage) : '';
        body = stage ? `${monthKey} 已取消（${stage}）` : `${monthKey} 已取消`;
      } else {
        const msg = (payload && payload.message) ? String(payload.message) : '未知错误';
        body = `对账失败：${msg}`.slice(0, 200);
      }
      new Notification({ title, body }).show();
    } catch (_e) { /* swallow — 通知失败不影响业务 return */ }
  }

  async function handleImportFlowOrBill(kind, payload, event) {
    if (!database || !database.db) return { status: 'error', message: '数据库未初始化' };
    const lock = tryAcquireOpLock('import', payload && payload.monthKey);
    if (!lock.acquired) return { status: 'error', message: lock.message, detailLines: [] };
    try {
      return await doHandleImportFlowOrBill(kind, payload, event);
    } finally {
      releaseOpLock();
    }
  }
  // fix5（spec v0.8 §3.3）：handler 入参必传 monthKey（用户弹窗选）；peek 校验 xlsx 内月份 = 用户选的月份；不一致整批拒绝
  // v2.1.7 F6：event 透传 → onProgress forwarder
  async function doHandleImportFlowOrBill(kind, payload, event) {
    const isFlow = kind === 'flow';
    const sessionImport = isFlow
      ? acquiringBillCurrencySession.importFlowFiles
      : acquiringBillCurrencySession.importBillFiles;
    const sessionOverwrite = isFlow
      ? acquiringBillCurrencySession.importFlowFilesWithOverwrite
      : acquiringBillCurrencySession.importBillFilesWithOverwrite;

    const monthKey = payload && payload.monthKey;
    if (!monthKey || !/^\d{4}-\d{2}$/.test(monthKey)) {
      return {
        status: 'error',
        message: '缺少月份参数（请先在弹窗中选择对账月份）',
        detailLines: []
      };
    }

    // 分支 2：renderer 已确认覆盖
    if (payload.confirmOverwrite === true && Array.isArray(payload.filePaths) && payload.filePaths.length > 0) {
      try {
        const onProgress = createImportProgressForwarder(event);
        const result = await sessionOverwrite({
          db: database.db,
          monthKey,
          filePaths: payload.filePaths,
          onProgress
        });
        return { status: 'success', overwritten: true, ...result };
      } catch (err) {
        return {
          status: 'error',
          message: err && err.message ? err.message : String(err),
          detailLines: err && err.detailLines ? err.detailLines : []
        };
      }
    }

    // 分支 1：弹 dialog 选文件
    const res = await dialog.showOpenDialog({
      title: isFlow ? `选择收单流水表（月份 ${monthKey}，可多选）` : `选择收单流水单据表（月份 ${monthKey}，可多选）`,
      filters: [{ name: 'Excel', extensions: ['xlsx'] }],
      properties: ['openFile', 'multiSelections']
    });
    if (res.canceled || !res.filePaths || res.filePaths.length === 0) {
      return { status: 'cancelled' };
    }

    // peek：读首文件 → 表头校验 + 解析首条数据行 monthKey → 与用户选月份比对
    let peeked;
    try {
      peeked = await acquiringBillCurrencySession.peekImportTarget({
        db: database.db,
        kind,
        filePaths: res.filePaths
      });
    } catch (err) {
      return {
        status: 'error',
        message: err && err.message ? err.message : String(err),
        detailLines: err && err.detailLines ? err.detailLines : []
      };
    }

    // fix5：文件月份与用户选月份必须一致
    if (peeked.monthKey !== monthKey) {
      return {
        status: 'error',
        message: `文件月份 ${peeked.monthKey} 与所选月份 ${monthKey} 不一致，请检查选择`,
        detailLines: [`首文件解析月份：${peeked.monthKey}`, `用户选择月份：${monthKey}`]
      };
    }

    if (peeked.existingCount > 0) {
      return {
        status: 'overwrite-required',
        kind,
        monthKey,
        existingCount: peeked.existingCount,
        filePaths: res.filePaths
      };
    }

    try {
      const onProgress = createImportProgressForwarder(event);
      const result = await sessionImport({
        db: database.db,
        monthKey,
        filePaths: res.filePaths,
        onProgress
      });
      return { status: 'success', ...result };
    } catch (err) {
      return {
        status: 'error',
        message: err && err.message ? err.message : String(err),
        detailLines: err && err.detailLines ? err.detailLines : []
      };
    }
  }

  // v2.1.7 F6：trackedIpcHandle 回调收 (event, payload)；event 透传到 handleImportFlowOrBill → forwarder
  trackedIpcHandle('acquiringBillCurrency:importFlow', '收单单据币种校验', '导入流水表', async (event, payload = {}) => {
    return handleImportFlowOrBill('flow', payload, event);
  });

  trackedIpcHandle('acquiringBillCurrency:importBill', '收单单据币种校验', '导入单据表', async (event, payload = {}) => {
    return handleImportFlowOrBill('bill', payload, event);
  });

  // v0.8 fix5：runCheck 改 async，传 storageRoot 让 session 同步产出 diff.xlsx + report.xlsx
  // v0.12 fix9：handler 接入 operation lock；runCheck return 后异步触发 cleanup（不阻塞 IPC return）
  // v2.1.7 F6：透传 event → onProgress forwarder（spec §6.3 改动点 2）
  // v2.1.10 A3 T10：runCheck 改走 worker pool dispatchRunCheck（spec §2.1 进程边界）
  //   - 长任务在 worker 进程内执行（不阻塞主进程 event loop / IPC / 渲染）
  //   - progress 事件通过 callback → createRunProgressForwarder forward 到 renderer（IPC 通道不变）
  //   - log 事件通过 callback → appendActivityLogEntry forward（spec §1.2：worker 不直写 log）
  //   - 错误透传：worker error → dispatchRunCheck reject → handler catch → 维持现有 status='error' 返回格式
  //   - op lock + notification 现有路径保留
  //   - N1' idle cleanup 协调（worker busy 时 skip）留 Phase 2 T12 改 setupIdleCleanupTimer
  trackedIpcHandle('acquiringBillCurrency:run', '收单单据币种校验', '开始运行', async (event, payload = {}) => {
    if (!database || !database.db) return { status: 'error', message: '数据库未初始化' };
    const { monthKey } = payload || {};
    if (!monthKey || !/^\d{4}-\d{2}$/.test(monthKey)) {
      return { status: 'error', message: 'monthKey 格式错误（应为 YYYY-MM）' };
    }
    const lock = tryAcquireOpLock('run', monthKey);
    if (!lock.acquired) return { status: 'error', message: lock.message };
    let result;
    try {
      const storageRoot = ensureStorageRoot();
      const onProgress = createRunProgressForwarder(event);
      // v2.1.10 A4 T18：从 settings 读 chunkSize（默认 100000；范围 1w-100w，外回退 default）
      const chunkSize = typeof database.getAcquiringBillChunkSize === 'function'
        ? database.getAcquiringBillChunkSize()
        : undefined;
      // v2.1.12 β.1-T3 — 多 worker workerCount 注入（⚠️ 资金红线 · spec §4 D29/D33）：
      //   1. settings 取值（getAcquiringBillWorkerCount：default 2，范围 1-8，越界回退 2）
      //   2. D29 CPU 上限：clamp 到 max(1, cpus-2)（POC：M=4 即甜点，避免过订）
      //   3. D33 OOM 降级：可用内存 < 2GB → 强制降到 1（worker 各 ~800MB peak，低配机兜底）
      //   ⚠️ 纯性能/资源闸——单/多 worker 结果 byte-for-byte 一致（contract 已锁）；clamp 只影响快慢与内存。
      //   ⚠️ 最终 workerCount<=1（如单核机 / 低内存 / settings=1）→ runCheckCore gate 自然回退单 worker，零行为变化。
      const computeWorkerCount = () => {
        const settingsCount = typeof database.getAcquiringBillWorkerCount === 'function'
          ? database.getAcquiringBillWorkerCount()
          : 1;
        let n = Number.isInteger(settingsCount) && settingsCount > 0 ? settingsCount : 1;
        // D29：CPU 上限
        const cpuCap = Math.max(1, (os.cpus() ? os.cpus().length : 1) - 2);
        n = Math.min(n, cpuCap);
        // D33：可用内存 < 2GB → 降到单 worker（OOM 兜底）
        const OOM_FREEMEM_FLOOR_BYTES = 2 * 1024 * 1024 * 1024;
        try {
          if (os.freemem() < OOM_FREEMEM_FLOOR_BYTES) n = 1;
        } catch (_e) { /* freemem 不可用 → 保守不降级（cpuCap 已兜底） */ }
        return Math.max(1, n);
      };
      const workerCount = computeWorkerCount();
      // 多 worker temp db 目录（runWriteSplitChunks 写 part-<ci>.sqlite，跑完 finally 清文件；
      //   空目录复用，不反复 mkdir/rm）。单 worker 路径不使用此目录。
      const mwTempDir = path.join(storageRoot, '.mw-tmp');
      try { fs.mkdirSync(mwTempDir, { recursive: true }); } catch (_e) { /* swallow — 多 worker gate 内会再兜底建 */ }
      // v2.1.10 A3 T10：worker pool dispatch（替代 session.runCheck 主进程直调）
      //   - __dbPath 传 database.dbPath（worker 内 new DatabaseSync(dbPath) — D24 独立 connection）
      //   - onLog：worker 内 appendModuleLog → message pipe → 主进程 appendActivityLogEntry
      //     （避免主/子进程并发写 app_activity_log.txt 的 read-modify-write race）
      // v2.1.10 A4 T18：chunkSize 透传 worker → runCheckCore → insertDiffRowsByJoinChunked
      // v2.1.12 β.1-T3：workerCount + tempDir 透传 worker → runCheckCore → 多 worker gate
      result = await runCheckWorkerPool.dispatchRunCheck(
        {
          __dbPath: database.dbPath,
          monthKey,
          storageRoot,
          chunkSize,
          workerCount,
          tempDir: mwTempDir,
        },
        {
          onProgress,
          onLog: (entry) => {
            try {
              appendActivityLogEntry(entry || {});
            } catch (_e) { /* swallow — log forwarder 失败不阻塞业务 */ }
          },
        }
      );
    } catch (err) {
      releaseOpLock();
      // v2.1.10 SR-FIX-1 round 2 P1-4：CancelError 走 cancelled 路径（spec §2.4 设计契约）
      //   CancelError class 注释明确：业务语义=用户主动取消；handler 应识别，不弹错误 Notification
      //   错误 source 失败时仍弹 error；cross-process worker → instanceof 不可靠 → 用 err.name
      if (err && err.name === 'CancelError') {
        notifyAcquiringBillCurrencyResult(monthKey, 'cancelled', { stage: err.stage });
        return { status: 'cancelled', message: err.message, stage: err.stage };
      }
      // v2.1.7 F7-B1：error 路径弹通知（spec §7.5.2）
      notifyAcquiringBillCurrencyResult(monthKey, 'error', { message: err && err.message });
      return { status: 'error', message: err && err.message ? err.message : String(err) };
    }
    // v0.12 fix9：release run lock，setImmediate 异步分批清理（不阻塞 handler return）
    // v2.1.8 N1：β 方案 — cleanup 移出对账链路，runCheck 内已 markCleanupPending=1，
    //   不再 setImmediate 立即触发；交 app.before-quit（主清）+ 进入模块时（兜底清）
    //   保留 result.cleanupNeeded 字段（向后兼容；前端不消费此字段）
    releaseOpLock();
    // v2.1.7 F7-B1：success 路径弹通知（spec §7.5.2）
    notifyAcquiringBillCurrencyResult(monthKey, 'success', { mismatchRows: result.mismatchRows });
    return { status: 'success', ...result };
  });

  // v2.1.10 A3 T10：cancel handler（Phase 1 提供 API；Phase 2 T13 完善 graceful cancel）
  //   - 调 workerPool.cancel() 设 cancelToken；当前 worker 内 runCheckCore 未读 cancelToken，
  //     所以 Phase 1 cancel 不真打断（worker 完成当前 runCheck 后自然结束）
  //   - Phase 2 T13 在 runCheckCore 内 5 阶段间 cancelToken check + ROLLBACK
  ipcMain.handle('acquiringBillCurrency:run:cancel', (_event, payload = {}) => {
    const jobId = payload && payload.jobId ? payload.jobId : null;
    try {
      const ok = runCheckWorkerPool.cancel(jobId);
      return { status: ok ? 'success' : 'no-active-job' };
    } catch (err) {
      return { status: 'error', message: err && err.message ? err.message : String(err) };
    }
  });

  // v2.1.10 A4 T19：resume handler — 续跑 chunk_progress.status='partial' 的 run
  //   - renderer 暂不暴露 UI（spec §三 / PRD §四 — v2.1.11+ 评估 UI）
  //   - IPC 通道留好供 Phase 4-6 / SR-FIX 阶段加 UI；本 handler 用作集成测试 / 高级用户调用
  //   - payload: { monthKey, runId? }
  //     - 不传 runId：自动找该月最近一个 chunk_progress.status='partial' 的 run
  //     - 传 runId：复用该 runId（caller 已知具体 run；验证 month_key 匹配）
  //   - 返回：与 run handler 一致格式 { status: 'success', runId, ... } / { status: 'error', message }
  trackedIpcHandle('acquiringBillCurrency:run:resume', '收单单据币种校验', '续跑（chunked resume）', async (event, payload = {}) => {
    if (!database || !database.db) return { status: 'error', message: '数据库未初始化' };
    const { monthKey, runId: payloadRunId } = payload || {};
    if (!monthKey || !/^\d{4}-\d{2}$/.test(monthKey)) {
      return { status: 'error', message: 'monthKey 格式错误（应为 YYYY-MM）' };
    }
    const lock = tryAcquireOpLock('run', monthKey);
    if (!lock.acquired) return { status: 'error', message: lock.message };

    let result;
    try {
      const runRepoLocal = require('./backend/acquiring-bill-currency-db/run-repository');
      // 找出要 resume 的 run
      let targetRunId = payloadRunId;
      let progress;
      if (!targetRunId) {
        // v2.1.10 SR-FIX-1 round 2 P1-5：扫该月所有可恢复 chunk_progress 的 runs
        //   原实施只取 getLatestRun → 如最近 run 是 complete（如刚跑完新 run），
        //   前一个 run 是 partial → 用户无法 resume 前一个 partial
        //   修复后：listPartialRuns 按 ran_at DESC 返回所有可恢复 → 取第一个（最近可恢复）
        // v2.1.10 SR-FIX-1 Round 4 F1：listPartialRuns 已扩为返回 partial OR in-progress
        const partialRuns = runRepoLocal.listPartialRuns(database.db, monthKey);
        if (!partialRuns || partialRuns.length === 0) {
          releaseOpLock();
          return { status: 'error', message: `月份 ${monthKey} 暂无可恢复 run，无法 resume（上次 run 可能已跑完）` };
        }
        const latestPartial = partialRuns[0];
        targetRunId = latestPartial.id;
        progress = latestPartial.chunk_progress;
      } else {
        // caller 已知具体 runId — 直接读 progress（校验 month_key 一致）
        progress = runRepoLocal.getRunChunkProgress(database.db, targetRunId);
        if (!progress) {
          releaseOpLock();
          return { status: 'error', message: `run ${targetRunId} 无 chunk_progress 记录，无法 resume` };
        }
      }
      // v2.1.10 SR-FIX-1 Round 4 F1：partial OR in-progress 均允许 resume
      //   in-progress 场景：first-chunk crash + failureListener 未及时兜底（如重启后还未跑到）
      //   → 应允许用户直接调 resume 续跑；resume 内部从 lastCompletedChunkIndex+1 起跑（in-progress 初始 -1 → 从 0 起跑 == 重头）
      if (!['partial', 'in-progress'].includes(progress.status)) {
        releaseOpLock();
        return { status: 'error', message: `run ${targetRunId} 状态为 ${progress.status}，无需 resume` };
      }

      const storageRoot = ensureStorageRoot();
      const onProgress = createRunProgressForwarder(event);
      // v2.1.10 SR-FIX-1 Round 6 H4：resume 时 chunkSize 优先从 chunk_progress 复用
      //   触发场景（Codex Round 5 四复审 P2 资金红线 finding）：
      //     用户跑到一半 cancel → settings 改 chunk size（如 100000 → 10000）→ resume
      //     原实现读当前 settings → insertDiffRowsByJoinChunked 用 OFFSET=chunkIndex*chunkSize 计算错位
      //     → diff_rows 行 skip / 重复（与全新 run byte-for-byte 不一致）
      //   修复：优先复用 progress.chunkSize（H1 占位 / onChunkDone 持久化）
      //     - 持久化值缺失（老 partial run）→ fallback 当前 settings + warning log
      //     - 持久化值与当前 settings 不一致 → warning log（提示用户）；用持久化值（资金红线优先）
      const currentSettingsChunkSize = typeof database.getAcquiringBillChunkSize === 'function'
        ? database.getAcquiringBillChunkSize()
        : undefined;
      let chunkSize;
      if (Number.isInteger(progress.chunkSize) && progress.chunkSize > 0) {
        chunkSize = progress.chunkSize;
        if (Number.isInteger(currentSettingsChunkSize) && currentSettingsChunkSize !== progress.chunkSize) {
          // H4：mismatch warning — 用户改 settings 后 resume；用持久化值优先（资金红线）
          try {
            appendActivityLogEntry({
              level: 'warning',
              source: 'main',
              domain: 'acquiring-bill-currency',
              message: '[acquiring-bill-currency:resume] chunkSize mismatch — 用持久化值（H4 资金红线护栏）',
              details: [
                `runId=${targetRunId}`,
                `monthKey=${monthKey}`,
                `progress.chunkSize=${progress.chunkSize}`,
                `currentSettings.chunkSize=${currentSettingsChunkSize}`,
              ],
            });
          } catch (_e) { /* swallow */ }
        }
      } else {
        // 老 partial run（升级前 chunk_progress 没 chunkSize 字段）→ fallback 当前 settings
        chunkSize = currentSettingsChunkSize;
        try {
          appendActivityLogEntry({
            level: 'warning',
            source: 'main',
            domain: 'acquiring-bill-currency',
            message: '[acquiring-bill-currency:resume] chunk_progress 缺 chunkSize（老 partial run）— fallback settings',
            details: [
              `runId=${targetRunId}`,
              `monthKey=${monthKey}`,
              `fallback chunkSize=${chunkSize}`,
            ],
          });
        } catch (_e) { /* swallow */ }
      }

      // 透传 resumeFromRun = { runId, lastCompletedChunkIndex } → worker → runCheckCore
      //   runCheckCore 跳过 stage 1-3（复用旧 runId / 旧 stats），stage 4' 从 lastCompletedChunkIndex+1 起跑
      result = await runCheckWorkerPool.dispatchRunCheck(
        {
          __dbPath: database.dbPath,
          monthKey,
          storageRoot,
          chunkSize,
          resumeFromRun: {
            runId: targetRunId,
            lastCompletedChunkIndex: progress.lastCompletedChunkIndex,
          },
        },
        {
          onProgress,
          onLog: (entry) => {
            try { appendActivityLogEntry(entry || {}); } catch (_e) { /* swallow */ }
          },
        }
      );
    } catch (err) {
      releaseOpLock();
      // v2.1.10 SR-FIX-1 round 2 P1-4：CancelError 走 cancelled 路径（同 run handler）
      if (err && err.name === 'CancelError') {
        notifyAcquiringBillCurrencyResult(monthKey, 'cancelled', { stage: err.stage });
        return { status: 'cancelled', resumed: true, message: err.message, stage: err.stage };
      }
      notifyAcquiringBillCurrencyResult(monthKey, 'error', { message: err && err.message });
      return { status: 'error', message: err && err.message ? err.message : String(err) };
    }
    releaseOpLock();
    notifyAcquiringBillCurrencyResult(monthKey, 'success', { mismatchRows: result.mismatchRows });
    return { status: 'success', resumed: true, ...result };
  });

  // v0.8 fix5：export = 另存为最近 run 的 diff.xlsx（fs.copyFile）
  // v0.12 fix9：handler 接入 operation lock
  trackedIpcHandle('acquiringBillCurrency:export', '收单单据币种校验', '导出差异', async (_event, payload = {}) => {
    if (!database || !database.db) return { status: 'error', message: '数据库未初始化' };
    const { monthKey } = payload || {};
    if (!monthKey || !/^\d{4}-\d{2}$/.test(monthKey)) {
      return { status: 'error', message: 'monthKey 格式错误' };
    }
    const lock = tryAcquireOpLock('export', monthKey);
    if (!lock.acquired) return { status: 'error', message: lock.message };
    try {
      const runRepo = require('./backend/acquiring-bill-currency-db/run-repository');
      const latestRun = runRepo.getLatestRun(database.db, monthKey);
      if (!latestRun) {
        return { status: 'error', message: `月份 ${monthKey} 暂无 run 记录，请先点「开始运行」` };
      }
      if (!latestRun.diff_file_path || !fs.existsSync(latestRun.diff_file_path)) {
        return { status: 'error', message: `月份 ${monthKey} 的差异表文件不存在，请重新「开始运行」` };
      }
      const defaultName = path.basename(latestRun.diff_file_path);
      const res = await dialog.showSaveDialog({
        title: '导出差异表另存为',
        defaultPath: defaultName,
        filters: [{ name: 'Excel', extensions: ['xlsx'] }]
      });
      if (res.canceled || !res.filePath) {
        return { status: 'cancelled' };
      }
      fs.copyFileSync(latestRun.diff_file_path, res.filePath);
      return { status: 'success', savedPath: res.filePath, sourceDiffPath: latestRun.diff_file_path };
    } catch (err) {
      return { status: 'error', message: err && err.message ? err.message : String(err) };
    } finally {
      releaseOpLock();
    }
  });

  ipcMain.handle('acquiringBillCurrency:clearMonth', (_event, payload = {}) => {
    if (!database || !database.db) return { status: 'error', message: '数据库未初始化' };
    const { monthKey } = payload || {};
    if (!monthKey || !/^\d{4}-\d{2}$/.test(monthKey)) {
      return { status: 'error', message: 'monthKey 格式错误' };
    }
    try {
      acquiringBillCurrencySession.clearMonth({ db: database.db, monthKey });
      return { status: 'success' };
    } catch (err) {
      return { status: 'error', message: err && err.message ? err.message : String(err) };
    }
  });
}

// v2.0.0-beta.4：usage-stats 模块（隐藏 .usage-stats.txt）
const usageStatsModule = require('./backend/usage-stats');
let usageStats = null;
let usageStatsAutoFlushTimer = null;
const USAGE_STATS_FLUSH_INTERVAL_MS = 5 * 60 * 1000;
let usageStatsDirty = false;

function tickUsageStats(moduleKey, functionKey) {
  if (!usageStats) return;
  usageStatsModule.incrementFunction(usageStats, moduleKey, functionKey);
  usageStatsDirty = true;
}

// PR #34 Codex round 2 P2：仅成功才计数（spec D6）
//   使用方式：trackedIpcHandle('xxx:yyy', '模块', '功能', handler)
//   handler 返回成功状态（'ok' 或 'success'）时才 tick；其他状态不计
//
// PR #34 Codex round 3 P2：原仅认 'ok'，但 template:import / delete / save-mappings /
//   account-mapping:save / file:export-detail / new-account:export 等 handler 实际返回
//   `status: 'success'`，导致统计偏低 → 同时接受两种方言（不接受 ready / empty 中间态）
const SUCCESS_STATUSES = new Set(['ok', 'success']);

function trackedIpcHandle(channel, moduleKey, functionKey, handler) {
  ipcMain.handle(channel, async (event, ...args) => {
    const result = await handler(event, ...args);
    if (result && SUCCESS_STATUSES.has(result.status)) {
      tickUsageStats(moduleKey, functionKey);
    }
    return result;
  });
}

function flushUsageStats() {
  if (!usageStats || !usageStatsDirty) return;
  try {
    usageStatsModule.saveStats(ensureStorageRoot(), usageStats);
    usageStatsDirty = false;
  } catch (err) {
    // PR #34 Codex round 1 P2：写盘失败保留 dirty 让下次 tick 重试
    // （原实现无论成败都清 dirty，磁盘满 / 权限错时 session 计数静默丢失）
    // v2.1.9 SR-log-1：替换 console.warn → 日志上报
    appendActivityLogEntry({
      level: 'warning',
      source: 'main',
      domain: 'usage-stats',
      message: '[usage-stats] flush failed (will retry next tick)',
      details: [err && err.message ? err.message : String(err)],
      stack: err && err.stack ? err.stack : undefined
    });
  }
}

app.whenReady()
  .then(() => {
    markStartupMetric(STARTUP_METRIC_MARKS.appReady);
    initializeActivityLog();

    // v2.0.0-beta.4：加载 usage-stats + 记录 sessionStart + 启动定时 flush
    try {
      usageStats = usageStatsModule.loadStats(ensureStorageRoot());
      usageStatsModule.recordSessionStart(usageStats);
      usageStatsDirty = true;
      flushUsageStats();
      usageStatsAutoFlushTimer = setInterval(flushUsageStats, USAGE_STATS_FLUSH_INTERVAL_MS);
    } catch (err) {
      // v2.1.9 SR-log-1：替换 console.warn → 日志上报；usage-stats init 失败 → 默认值兜底
      appendActivityLogEntry({
        level: 'warning',
        source: 'main',
        domain: 'usage-stats',
        message: '[usage-stats] init failed',
        details: [err && err.message ? err.message : String(err)],
        stack: err && err.stack ? err.stack : undefined
      });
      usageStats = usageStatsModule.defaultStats();
    }

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

    // v2.1.6 fix10：启动期孤儿数据 cleanup（后台异步，不阻塞窗口 ready）
    // 触发场景：上一次 run 中途 OOM 闪退 / 异常退出 / 用户 force quit，导致 DB 残留 diff_rows + flow/bill imports
    // 检测口径：runs.status != 'success' OR diff/report 文件丢失（spec §5.4）
    // 复用 fix9 cleanupAfterRunBackground 分批 DELETE + setImmediate 让出 event loop
    // 失败容忍：抛错只记 activity log，不阻塞应用使用
    setImmediate(async () => {
      if (!database || !database.db) return;
      const lock = tryAcquireAcquiringBillCurrencyOpLock('cleanup', null);
      if (!lock.acquired) return;
      try {
        const stats = await acquiringBillCurrencySession.cleanupOrphanData({
          db: database.db,
          onProgress: (p) => {
            try {
              appendActivityLogEntry({
                level: 'info',
                message: `[acquiring-bill-currency] startup cleanup ${p.phase}`,
                details: [JSON.stringify(p)]
              });
            } catch (_logErr) { /* swallow */ }
          }
        });
        if (stats && (stats.orphanRunIds.length > 0 || stats.deletedDiff > 0 || stats.deletedFlow > 0 || stats.deletedBill > 0)) {
          try {
            appendActivityLogEntry({
              level: 'info',
              message: '[acquiring-bill-currency] 启动期 cleanup 完成（fix10）',
              details: [
                `孤儿 run: ${stats.orphanRunIds.length} 个 (${stats.orphanRunIds.join(', ')})`,
                `清空 diff_rows: ${stats.deletedDiff}`,
                `清空 flow_imports: ${stats.deletedFlow}`,
                `清空 bill_imports: ${stats.deletedBill}`,
                `删除 run 记录: ${stats.deletedRuns}`
              ]
            });
          } catch (_logErr) { /* swallow */ }
        }
      } catch (err) {
        try {
          appendActivityLogEntry({
            level: 'error',
            message: '[acquiring-bill-currency] 启动期 cleanup 失败（fix10）',
            details: [String(err && err.stack ? err.stack : err)]
          });
        } catch (_logErr) { /* swallow */ }
      } finally {
        releaseAcquiringBillCurrencyOpLock();
      }
    });

    // v2.1.8 N1' (v0.7)：启动 idle 30min 自动 cleanup 计时器（spec §3.2.2）
    //   database init 完后启动；setInterval 2 分钟 tick，达 30min 闲置 → 触发 cleanup
    try {
      setupIdleCleanupTimer();
    } catch (err) {
      // v2.1.9 SR-log-1：替换 console.error → 日志上报
      appendActivityLogEntry({
        level: 'error',
        source: 'main',
        domain: 'acquiring-bill-currency',
        message: '[acquiring-bill-currency] setupIdleCleanupTimer failed',
        details: [err && err.message ? err.message : String(err)],
        stack: err && err.stack ? err.stack : undefined
      });
    }

    // v2.1.10 A3 Phase 2 T14：注册 worker pool failure listener
    //   - worker exit (code≠0) / error 事件 → pool 自动 reject activeJob + 调本回调
    //   - 主进程职责：① 释放 op lock；② Notification 通知用户；③ activity log；④ 下次 dispatch cold-start（pool 自动 — workerInstance=null）
    //   - hadActiveJob=true：有 job 正在跑挂掉 → 必须释放 op lock（caller IPC handler catch 也会 release，
    //     但 failure 路径走 reject 后 caller catch 释放；此处兜底释放防 caller 异常路径漏释）
    //   - 当 caller 已 release（reject 路径正常走完）则此处 release 是 no-op（lock.inFlight=false 时 release 幂等）
    try {
      runCheckWorkerPool.setFailureListener((info) => {
        try {
          appendActivityLogEntry({
            level: 'error',
            source: 'main',
            domain: 'acquiring-bill-currency',
            message: `[acquiring-bill-currency] worker ${info && info.source} 异常（A3 Phase 2 T14 recover）`,
            details: [
              `message=${info && info.message ? info.message : 'unknown'}`,
              `hadActiveJob=${info && info.hadActiveJob ? 'true' : 'false'}`,
            ],
            stack: info && info.cause && info.cause.stack ? info.cause.stack : undefined
          });
        } catch (_logErr) { /* swallow */ }
        // 释放 op lock（防 caller catch 漏释；release 内部不抛错 — 状态置为 inFlight=false）
        try { releaseAcquiringBillCurrencyOpLock(); } catch (_lockErr) { /* swallow */ }
        // v2.1.10 SR-FIX-1 round 2 P1-7：worker crash 时主进程兜底设 chunk_progress='partial'
        //   触发场景：worker 跑到 chunk M/N 突然 process.exit(1) / OOM / SIGKILL → catch 块（runCheckCore L367-394）不执行
        //     → chunk_progress 停留在 'in-progress'（onChunkDone 写的最后一次值）
        //     → resume handler 检查 progress.status !== 'partial' → 拒绝 resume
        //   修复：crash 后扫所有 chunk_progress.status='in-progress' 的 runs（生产正常路径下 in-progress
        //     只在 chunk 边界短暂存在；crash 时残留）→ 兜底改成 'partial' → resume 可用
        //   失败容忍：try/catch + activity log（不影响其他 failure 处理路径）
        //
        // v2.1.10 SR-FIX-1 Round 7 I1：透传 chunkSize（Codex 5 次复审 finding — 资金红线 P2）
        //   原 Round 2 P1-7 实现：setRunChunkProgress(partial) 没传 chunkSize 入参
        //     → setRunChunkProgress 内部不写 chunkSize 字段 → 持久化 partial JSON 丢失原 in-progress 的 chunkSize
        //   触发场景（Round 6 H4 漏抓的路径）：
        //     worker 跑 chunkSize=100000 到 chunk 2 → SIGKILL → failureListener 触发 → 此处 in-progress → partial
        //     → 重写后 chunk_progress.chunkSize 丢失（变 undefined）
        //     → resume handler fallback 当前 settings 的 chunkSize（如 10000） → OFFSET 偏移错位 → diff_rows 行 skip/重复
        //   修复：透传 progress.chunkSize（H1 / onChunkDone 已写入持久化值）
        //     - 老 partial run（升级前无 chunkSize 字段）→ progress.chunkSize undefined → setRunChunkProgress 不写
        //       → resume handler fallback settings（Round 6 H4 兜底路径仍正确）
        //     - 新场景（Round 6 H1 / H4 之后写入的 progress 都带 chunkSize）→ 透传保留 → 资金红线护栏闭合
        if (info && info.hadActiveJob && database && database.db) {
          try {
            const inProgressRuns = database.db.prepare(`
              SELECT id, month_key, chunk_progress
              FROM acquiring_bill_currency_runs
              WHERE chunk_progress IS NOT NULL
            `).all();
            for (const row of inProgressRuns) {
              try {
                const progress = JSON.parse(row.chunk_progress);
                if (progress && progress.status === 'in-progress') {
                  runRepo.setRunChunkProgress(database.db, {
                    runId: row.id,
                    lastCompletedChunkIndex: progress.lastCompletedChunkIndex,
                    totalChunks: progress.totalChunks,
                    status: 'partial',
                    // Round 7 I1：透传 chunkSize 保证 resume 用原始 chunk size（资金红线 — 防 OFFSET 错位）
                    //   setRunChunkProgress 内部对 undefined / 非正整数自动跳过写入（向后兼容老 row）
                    chunkSize: progress.chunkSize,
                  });
                  appendActivityLogEntry({
                    level: 'warning',
                    source: 'main',
                    domain: 'acquiring-bill-currency',
                    message: '[SR-FIX-1 P1-7] worker crash 后 chunk_progress in-progress → partial 兜底',
                    details: [
                      `runId=${row.id}`,
                      `monthKey=${row.month_key}`,
                      `lastCompletedChunkIndex=${progress.lastCompletedChunkIndex}`,
                      `totalChunks=${progress.totalChunks}`,
                      // Round 7 I1：日志记录 chunkSize 透传（含 undefined 老 row）
                      `chunkSize=${progress.chunkSize == null ? '(legacy/undefined)' : progress.chunkSize}`,
                    ]
                  });
                }
              } catch (_parseErr) { /* swallow — 破坏 JSON 跳过 */ }
            }
          } catch (scanErr) {
            try {
              appendActivityLogEntry({
                level: 'error',
                source: 'main',
                domain: 'acquiring-bill-currency',
                message: '[SR-FIX-1 P1-7] worker crash chunk_progress 兜底扫描失败',
                details: [scanErr && scanErr.message ? scanErr.message : String(scanErr)],
                stack: scanErr && scanErr.stack ? scanErr.stack : undefined
              });
            } catch (_logErr) { /* swallow */ }
          }
        }
        // Notification（用户提示）— 复用既有 notifyAcquiringBillCurrencyResult error 路径
        //   ⚠️ notifyAcquiringBillCurrencyResult 在 IPC handler 闭包内；模块顶层无法访问
        //   直接构造 Notification — 与 notifyAcquiringBillCurrencyResult 内部一致的 isSupported 兜底
        try {
          if (Notification && typeof Notification.isSupported === 'function' && Notification.isSupported()) {
            const body = `worker 异常请重试：${(info && info.message) ? String(info.message).slice(0, 160) : 'worker crash'}`;
            new Notification({ title: '「收单单据币种校验」', body }).show();
          }
        } catch (_notifyErr) { /* swallow — 通知失败不影响业务 */ }
      });
    } catch (err) {
      appendActivityLogEntry({
        level: 'error',
        source: 'main',
        domain: 'acquiring-bill-currency',
        message: '[acquiring-bill-currency] setFailureListener 注册失败',
        details: [err && err.message ? err.message : String(err)],
        stack: err && err.stack ? err.stack : undefined
      });
    }
  })
  .catch((error) => {
    handleStartupFailure(error);
  });

// v2.1.8 N1：进入模块兜底 cleanup
//   spec §三 N1-D3 / D4：listMonths 入口检测 cleanup_pending → 后台串行清 + toast 通知
//   防重入：cleanupBackgroundInProgress flag，避免短时间内多次切回模块触发重复 cleanup
//   并发隔离：用 tryAcquireOpLock('cleanup') 防与 import/run/export 冲突
//   失败容忍：单 run 失败仅日志，继续清下一个；启动期 cleanupOrphanData 兜底
let cleanupBackgroundInProgress = false;
// v2.1.10 SR-FIX-1 round 2 P0-4：返回 Promise（spec §4.3.2 顺序契约）
//   - 早返回路径（cleanupBackgroundInProgress / 无 db / 无 pending / 锁拿不到）→ 立即 resolve（不算执行）
//   - 实际执行路径 → 主 cleanup 全部完成后 resolve
//   - 兼容现有 caller（启动期 + 进入模块兜底 + idle tick）— fire-and-forget 不 await 不破坏既有行为
//   - idle tick caller 可 await 后再调 raw_json 清理，保证顺序契约
function triggerAcquiringBillCurrencyBackgroundCleanupIfNeeded() {
  if (cleanupBackgroundInProgress) return Promise.resolve();
  if (!database || !database.db) return Promise.resolve();
  let pendingRuns;
  try {
    pendingRuns = runRepo.listPendingCleanupRuns(database.db);
  } catch (_e) {
    return Promise.resolve();
  }
  if (!pendingRuns || pendingRuns.length === 0) return Promise.resolve();
  const cleanupLock = tryAcquireAcquiringBillCurrencyOpLock('cleanup', null);
  if (!cleanupLock.acquired) return Promise.resolve(); // import/run/export 进行中，放弃这次（下次入模块再试）
  cleanupBackgroundInProgress = true;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('acquiringBillCurrency:cleanup-background:toast', {
      stage: 'start', pendingCount: pendingRuns.length
    });
  }
  return new Promise((resolve) => {
    setImmediate(async () => {
      try {
        for (const run of pendingRuns) {
          try {
            await acquiringBillCurrencySession.cleanupAfterRunBackground({
              db: database.db, monthKey: run.month_key, runId: run.id
              // v2.1.8 N1' (v0.7)：includeDiff 默认 false → 只清 flow + bill，保留 diff
            });
            runRepo.clearCleanupPending(database.db, { runId: run.id });
          } catch (cleanErr) {
            // v2.1.9 SR-log-1：替换 console.error → 日志上报
            appendActivityLogEntry({
              level: 'error',
              source: 'main',
              domain: 'acquiring-bill-currency',
              message: `[acquiring-bill-currency] background cleanup run ${run.id} 失败`,
              details: [cleanErr && cleanErr.message ? cleanErr.message : String(cleanErr)],
              stack: cleanErr && cleanErr.stack ? cleanErr.stack : undefined
            });
          }
        }
      } finally {
        releaseAcquiringBillCurrencyOpLock();
        cleanupBackgroundInProgress = false;
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('acquiringBillCurrency:cleanup-background:toast', { stage: 'done' });
        }
        resolve();
      }
    });
  });
}

// v2.1.8 N1' (v0.7)：idle 30min 自动 cleanup 计时器（spec §3.2.2）
//   - 触发条件三个 AND：
//       (1) renderer 上报的 lastUserActivityTs 距今 ≥ 30min（D6/D8）
//       (2) mutex 可获取（间接表达 main 进程未在跑 import/run/export，D6 AND 设计）
//       (3) listPendingCleanupRuns 非空（有待清 run）
//   - 触发后复用 triggerAcquiringBillCurrencyBackgroundCleanupIfNeeded 走同一条路径
//     （已有 cleanupBackgroundInProgress 防重入 + tryAcquireOpLock 抢锁 + toast 通知）
//   - 失败仅 console.error（D13 静默策略）；下次 idle 再试 + 进入模块兜底 + 启动 cleanupOrphanData 三重兜底
//   - 启动时机：app.whenReady 后调用 setupIdleCleanupTimer（database init 完之后）
//
// v2.1.9 N1-settings (T32c, D21=c)：阈值从硬编码改 settings 化（不提供 UI）
//   - 启动期：调 database.getAcquiringBillIdleCleanupMinutes() 拿值（默认 30；范围外回退 30 — 资金红线兜底）
//   - 改阈值方式：用户用 sqlite3 客户端执行
//       UPDATE app_settings SET setting_value = '<5..180>' WHERE setting_key = 'acquiring_bill_idle_cleanup_minutes';
//     然后重启应用生效。
//   - 范围 5-180 分钟：后端 setAcquiringBillIdleCleanupMinutes 校验 + getter 范围外回退默认 30（settings-repository）
function loadIdleCleanupMsFromSettings() {
  try {
    if (database && typeof database.getAcquiringBillIdleCleanupMinutes === 'function') {
      const minutes = database.getAcquiringBillIdleCleanupMinutes();
      IDLE_CLEANUP_MS = minutes * 60 * 1000;
      return minutes;
    }
  } catch (err) {
    // v2.1.9 SR-log-1：替换 console.error → 日志上报；阈值回退 30min（资金红线兜底）
    appendActivityLogEntry({
      level: 'error',
      source: 'main',
      domain: 'acquiring-bill-currency',
      message: '[acquiring-bill-currency] loadIdleCleanupMsFromSettings failed (回退 30min)',
      details: [err && err.message ? err.message : String(err)],
      stack: err && err.stack ? err.stack : undefined
    });
  }
  IDLE_CLEANUP_MS = 30 * 60 * 1000;
  return 30;
}

// v2.1.10 Phase 2 T12：worker busy / grace 内 skip idle cleanup（spec §2.3.2）
//   - workerPool.isBusy()=true：worker 正在跑 runCheck，禁止 cleanup（避免抢 DB 写锁）
//   - Phase 1 surprise #1 mitigate：worker reject 后 isBusy() 立即翻 false，但 worker 内 DB 事务可能仍在
//     → 30s grace（默认）内不触发 cleanup；下个 5min tick 再判
//   - GRACE_MS 可在 unit test 中 monkey-patch；生产固定 30s
const RUN_CHECK_WORKER_GRACE_MS = 30000;

function setupIdleCleanupTimer() {
  if (idleCleanupTimer) return; // 重入保护
  // v2.1.9 N1-settings：启动期从 settings 读阈值（默认 30）
  loadIdleCleanupMsFromSettings();
  idleCleanupTimer = setInterval(async () => {
    try {
      const elapsed = Date.now() - lastUserActivityTs;
      if (elapsed < IDLE_CLEANUP_MS) return;

      // v2.1.10 Phase 2 T12：worker busy guard（spec §2.3.2 协调策略）
      //   worker 正在跑 runCheck → skip 本次 idle cleanup（避免与 worker DB 写抢锁）
      if (runCheckWorkerPool && typeof runCheckWorkerPool.isBusy === 'function' && runCheckWorkerPool.isBusy()) {
        appendActivityLogEntry({
          level: 'info',
          source: 'main',
          domain: 'acquiring-bill-currency',
          message: '[acquiring-bill-currency] idle cleanup skip — worker busy（spec §2.3.2）',
          details: [`activeJobId=${(runCheckWorkerPool.getStatus && runCheckWorkerPool.getStatus().activeJobId) || ''}`]
        });
        return;
      }

      // v2.1.10 Phase 2 T12：30s grace（Phase 1 surprise #1 mitigate）
      //   isBusy() 已 false 但 worker 刚 reject/done — worker 内 DB 事务可能仍在
      //   30s grace 内不触发 cleanup；下个 tick 再判
      if (runCheckWorkerPool && typeof runCheckWorkerPool.getLastBusyEndTs === 'function') {
        const lastBusyEndTs = runCheckWorkerPool.getLastBusyEndTs();
        if (lastBusyEndTs > 0 && Date.now() - lastBusyEndTs < RUN_CHECK_WORKER_GRACE_MS) {
          // grace 期内 skip — 不写 activity log（30s 内每 5min 一次 tick 至多 1 次 grace skip，
          // 日志噪声小可忽略；如需诊断可临时打开）
          return;
        }
      }

      // v2.1.10 SR-FIX-1 round 2 P0-4：顺序契约（spec §4.3.2 + PRD §五.2）
      //   修复前：trigger() setImmediate 异步立即返回 + raw_json 同步立即跑 → 两 cleanup 并发
      //   修复后：trigger() 返 Promise → await → raw_json 后跑 → 保证顺序契约 + 日志顺序
      //   兼容：trigger() 早返回路径（无 pending / 已 in progress）立即 resolve；await 立即返回
      //
      // idle 达标 → 复用进入模块兜底路径（含 mutex 抢锁 + cleanup_pending 判定 + 防重入）
      await triggerAcquiringBillCurrencyBackgroundCleanupIfNeeded();

      // === Phase 4 N4-cont-1 raw_json 清理 ===
      //   spec §4.3 + PRD §五.2：复用 N1' idle 30min cleanup 时序
      //   顺序：先 v2.1.8 cleanupAfterRunBackground（清 flow + bill 整行）后 raw_json 清理（NULL 化对账成功老行）
      //   失败不阻塞主 cleanup（独立 try/catch + activity log + 下次 idle 重试）
      //   ⚠️ 资金红线：clearStaleSuccessfulRawJson 内 NOT IN 子查询排除差异行；retentionDays 用 settings getter 范围外回退 7
      try {
        const retentionDays = database.getAcquiringBillRawJsonRetentionDays();
        const rawJsonResult = clearStaleSuccessfulRawJson(database.db, { retentionDays });
        if (rawJsonResult.clearedCount > 0) {
          appendActivityLogEntry({
            level: 'info',
            source: 'main',
            domain: 'acquiring-bill-currency',
            message: '[N4-cont-1] idle cleanup raw_json 清理完成',
            details: [
              `affected=${rawJsonResult.clearedCount}`,
              `retentionDays=${retentionDays}`,
              `elapsedMs=${rawJsonResult.elapsedMs}`
            ]
          });
        }
      } catch (rawJsonErr) {
        // raw_json 清失败不阻塞主 cleanup；下次 idle（30min 后）重试
        appendActivityLogEntry({
          level: 'error',
          source: 'main',
          domain: 'acquiring-bill-currency',
          message: '[N4-cont-1] idle cleanup raw_json 清理失败（下次 idle 重试）',
          details: [rawJsonErr && rawJsonErr.message ? rawJsonErr.message : String(rawJsonErr)],
          stack: rawJsonErr && rawJsonErr.stack ? rawJsonErr.stack : undefined
        });
      }
    } catch (err) {
      // v2.1.9 SR-log-1：替换 console.error → 日志上报；idle tick 失败不阻塞下次 tick
      appendActivityLogEntry({
        level: 'error',
        source: 'main',
        domain: 'acquiring-bill-currency',
        message: '[acquiring-bill-currency] idle cleanup tick 失败',
        details: [err && err.message ? err.message : String(err)],
        stack: err && err.stack ? err.stack : undefined
      });
    }
  }, IDLE_CHECK_INTERVAL_MS);
  if (idleCleanupTimer.unref) idleCleanupTimer.unref(); // 不阻塞退出
}

// v2.0.0-beta.4：退出前 flush usage-stats（before-quit 在窗口全关后触发）
// v2.1.8 N1' (v0.7)：β 方案降级为退出兜底（D10=c）— 简化为静默串行清，删模态框 IPC 广播
//   spec §三 N1'：idle 30min 主触发 + before-quit 退出兜底（防没闲够就退）+ listMonths 崩溃恢复兜底
//   设计：
//     1. 既有 usage-stats flush 不动（同步执行，毫秒级）
//     2. 检查 listPendingCleanupRuns 是否有待清 runs（cleanup_pending=1）
//     3. 有 → event.preventDefault() 阻塞 → 异步静默串行清 → 完成后 app.quit()
//     4. 无 → 直接退出（不阻塞）
//     5. 退出失败 → console.error + 仍 quit（spec N1''-D13 静默 + 进入模块兜底 + 启动 cleanupOrphanData 三重保险）
//     6. cleanupAfterRunBackground 默认 includeDiff=false → 只清 flow + bill，保留 diff
let cleanupQuitInProgress = false; // 防重入

// v2.1.10 SR-FIX-1 round 2 P0-3：worker pool shutdown 辅助（spec §2.1.3 — 主进程退出 graceful close）
//   - workerInstance 不存在（worker 从未启动 / 已退出）→ 立即返回 / 不 preventDefault
//   - workerInstance 存在 → 调 shutdown(5000)；timeout 后 terminate
//   失败 swallow + activity log（不阻塞 quit）；返回 boolean：是否需要异步 shutdown（true → caller 必须 preventDefault）
function needsWorkerShutdown() {
  if (!runCheckWorkerPool || typeof runCheckWorkerPool.getStatus !== 'function') return false;
  try {
    const status = runCheckWorkerPool.getStatus();
    return !!(status && status.workerAlive);
  } catch (_e) {
    return false;
  }
}

async function shutdownWorkerPoolGracefully() {
  try {
    if (runCheckWorkerPool && typeof runCheckWorkerPool.shutdown === 'function') {
      await runCheckWorkerPool.shutdown(5000);
    }
  } catch (shutdownErr) {
    // v2.1.10 SR-FIX-1 round 2 P0-3：shutdown 失败 swallow + 日志（不阻塞 app.quit）
    try {
      appendActivityLogEntry({
        level: 'warning',
        source: 'main',
        domain: 'acquiring-bill-currency',
        message: '[SR-FIX-1 P0-3] before-quit worker shutdown 失败（worker thread 将被强 kill）',
        details: [shutdownErr && shutdownErr.message ? shutdownErr.message : String(shutdownErr)],
        stack: shutdownErr && shutdownErr.stack ? shutdownErr.stack : undefined
      });
    } catch (_e) { /* swallow — 日志失败不阻塞 quit */ }
  }
}

app.on('before-quit', (event) => {
  // usage-stats flush（不变）
  try {
    if (usageStats) {
      usageStatsModule.recordSessionEnd(usageStats);
      usageStatsDirty = true;
      flushUsageStats();
    }
    if (usageStatsAutoFlushTimer) {
      clearInterval(usageStatsAutoFlushTimer);
      usageStatsAutoFlushTimer = null;
    }
  } catch (err) {
    // v2.1.9 SR-log-1：替换 console.warn → 日志上报
    appendActivityLogEntry({
      level: 'warning',
      source: 'main',
      domain: 'usage-stats',
      message: '[usage-stats] before-quit flush failed',
      details: [err && err.message ? err.message : String(err)],
      stack: err && err.stack ? err.stack : undefined
    });
  }

  // v2.1.8 N1' (v0.7)：cleanup 退出兜底（静默）
  if (cleanupQuitInProgress) return; // 重入保护（cleanup 完成 app.quit 时会再次触发 before-quit）

  // v2.1.10 SR-FIX-1 round 2 P0-3：worker pool shutdown（spec §2.1.3 — 主进程退出 graceful close）
  //   决策：保守路径 — workerAlive=true 时 preventDefault + 异步 shutdown，避免 WAL/shm 残留
  //   优先级：先 shutdown worker（防 DB 写锁残留）→ 再跑 pendingRuns cleanup → 最后 app.quit
  const needWorker = needsWorkerShutdown();

  let pendingRuns;
  if (database && database.db) {
    try {
      pendingRuns = runRepo.listPendingCleanupRuns(database.db);
    } catch (listErr) {
      // listPending 失败 → 不阻塞退出（启动期 cleanupOrphanData 会兜底）
      // v2.1.9 SR-log-1：替换 console.error → 日志上报
      appendActivityLogEntry({
        level: 'error',
        source: 'main',
        domain: 'acquiring-bill-currency',
        message: '[acquiring-bill-currency] before-quit listPendingCleanupRuns 失败',
        details: [listErr && listErr.message ? listErr.message : String(listErr)],
        stack: listErr && listErr.stack ? listErr.stack : undefined
      });
      pendingRuns = null; // 走 worker-only 分支或 fast-quit
    }
  }
  const hasPending = pendingRuns && pendingRuns.length > 0;

  // Fast path：无 worker + 无 pending → 直接退出（既有行为不变）
  if (!needWorker && !hasPending) return;

  event.preventDefault();
  cleanupQuitInProgress = true;

  // 异步串行：① shutdown worker → ② cleanup pending runs → ③ app.quit
  (async () => {
    // ① worker shutdown（spec §2.1.3）— 在 cleanup 之前，避免 worker 写锁与 main cleanup 冲突
    if (needWorker) {
      await shutdownWorkerPoolGracefully();
    }

    // ② cleanup pending runs（v2.1.8 N1' 原逻辑保留 — N1''-D9 内部 setImmediate 让出；N1''-D13 静默）
    if (hasPending && database && database.db) {
      for (const run of pendingRuns) {
        try {
          await acquiringBillCurrencySession.cleanupAfterRunBackground({
            db: database.db,
            monthKey: run.month_key,
            runId: run.id
            // includeDiff 默认 false → 保留 diff（spec §3.2.1 N1''-D1/D3）
          });
          runRepo.clearCleanupPending(database.db, { runId: run.id });
        } catch (cleanErr) {
          // v2.1.9 SR-log-1：替换 console.error → 日志上报；cleanup-quit 单 run 失败容忍继续清下一个
          appendActivityLogEntry({
            level: 'error',
            source: 'main',
            domain: 'acquiring-bill-currency',
            message: `[acquiring-bill-currency] cleanup-quit run ${run.id} (${run.month_key}) 失败`,
            details: [cleanErr && cleanErr.message ? cleanErr.message : String(cleanErr)],
            stack: cleanErr && cleanErr.stack ? cleanErr.stack : undefined
          });
        }
      }
    }
    // ③ 失败也 quit（启动期 cleanupOrphanData 兜底；N1''-D13 静默）
    app.quit();
  })();
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
