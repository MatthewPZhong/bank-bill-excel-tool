const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os'); // v2.1.12 β.1-T3：多 worker D33 OOM clamp（cpus / freemem）
const { AsyncLocalStorage } = require('node:async_hooks');
const XLSX = require('xlsx');
const { performance } = require('node:perf_hooks');
const { app, BrowserWindow, dialog, ipcMain, nativeImage, Notification, shell } = require('electron');
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
const {
  executePendingImportSubmission,
  pendingImportError,
  pendingMonthEvidenceValue,
  preparePendingImportSubmission,
  readPendingMonthEvidence
} = require('./main-process/pending-import-preflight');
const {
  createAppUpdaterService,
  detectDistribution
} = require('./main-process/app-updater');
const {
  createBusinessOperationRegistry,
  INSTALL_BUSY_MESSAGE
} = require('./main-process/business-operation-registry');
const {
  createArchiveOperationTracker,
  resolveOperationInputPaths,
  selectSuccessfulPathsByResultIndex
} = require('./main-process/archive-center/operation-tracker');
const {
  PR3_HANDOFF_CHANNELS,
  SUPPORT_ACTION_POLICIES,
  createTaskPolicyRegistry
} = require('./main-process/archive-center/task-policy-registry');
const {
  createBusinessFlowResolver
} = require('./main-process/archive-center/business-flow-resolver');
const {
  createTaskLifecycle
} = require('./main-process/archive-center/task-lifecycle');
const {
  createIpcTaskContext,
  executeIpcTaskInvocation,
  normalizeIpcTaskHandler,
  prepareIpcTaskInvocation
} = require('./main-process/archive-center/ipc-task-contract');
const {
  createScenarioImportContextStore
} = require('./main-process/archive-center/scenario-import-context-store');
const {
  captureArchiveSourceSnapshots,
  sourceSnapshotFromStat,
  sourceSnapshotMatchesStat
} = require('./main-process/archive-center/source-snapshot');
const {
  createArchiveService
} = require('./main-process/archive-center/archive-service');
const {
  createArchiveCenterController
} = require('./main-process/archive-center/controller');
const {
  createArchiveOutboxStore
} = require('./main-process/archive-center/outbox-store');
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
// v3.0.5 PR-3（Part B Phase 1）：收单 per-月侧库编排层（import/run/status/listMonths/孤儿/retention 路由侧库）
const acquiringRunData = require('./main-process/acquiring-bill-currency-run-data');
const runDataStore = require('./backend/run-data-store');
// v3.0.14：前置资金对账 session/service（临时 MPT + 严格1:1 + 5-sheet 导出）。
const {
  createPreFundReconciliationService
} = require('./main-process/pre-fund-reconciliation/service');
// v3.0.15：重复入金匹配（银行 Reversal/Inbound 分组 + 临时入金 MPT 回填 + 双 sheet 导出）。
const {
  createDuplicateInboundMatchService
} = require('./main-process/duplicate-inbound-match/service');
// v3.1.0：平盘资金性质校验（持久化银行/链接侧库 + 严格1:1匹配 + 结果回导确认）。
const {
  createPositionReconciliationService
} = require('./main-process/position-reconciliation/service');
const {
  PositionReconciliationError
} = require('./main-process/position-reconciliation/common');
const {
  createPositionRunTaskContract,
  createPositionSourceImportTaskContract,
  executeAfterPositionAdmission,
  runWithPreparedResourceCleanup
} = require('./main-process/position-reconciliation/interactive-task-preflight');
const {
  dispatchPositionLargeImportSchemaMigration
} = require('./main-process/position-reconciliation/import-dispatch');
const {
  assertStagedInputUnchanged,
  filterStagingPathsWithoutProtectedSources,
  hashFileSha256Async
} = require('./main-process/position-reconciliation/input-staging');
const {
  POSITION_SIDE_DB_CHECKPOINT_SETTING,
  POSITION_SIDE_DB_PENDING_SETTING,
  POSITION_SIDE_DB_BOOTSTRAP_SETTING
} = require('./main-process/position-reconciliation/constants');
const {
  assertPositionRecoveryInputsUnchanged,
  positionCommittedRecoveryArchiveFiles,
  positionRecoveryCleanupInputPaths,
  requirePositionPendingArchiveFiles,
  positionRecoveryArchiveFiles,
  positionArchiveIntentEvidence: evaluatePositionArchiveIntentEvidence,
  authorizePositionImportApply,
  positionBusinessStateForResult,
  positionTerminalOutcomeForResult,
  positionPersistentStagingProtectionPaths,
  positionReconciliationFailureResult,
  positionRecoveryTerminalOutcome,
  positionCancellationAcceptedPending,
  runPositionOperationLifecycle,
  settlePositionRecoveredTask,
  settlePositionArchiveResult
} = require('./main-process/position-reconciliation/operation-lifecycle');
// v3.0.5 PR-4（Part B Phase 2）：biz-op / bank-bu per-月侧库编排层（import/run/status/导出/孤儿 路由侧库）
const bizOpReconRunData = require('./main-process/biz-op-recon-run-data');
const bankBuReconRunData = require('./main-process/bank-bu-recon-run-data');
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
// v2.1.15 W1（spec §3 / 决策 xlsx 为准、旧硬编码作废）：C3「网关账单字段」枚举改读
//   assets/网关对账单.xlsx 表头行（main 进程 require；经 IPC scenarios:gateway-recon-headers 暴露给 renderer）
//   preload 无法 require 自定义模块（Electron sandbox），故走 IPC 而非 inline 副本
const { loadGatewayReconHeaders, GATEWAY_RECON_HEADERS_FILE_NAME } = require('./constants/gateway-recon-headers-loader');
// v2.1.16 阶段一 A4：链接表导入（识别 → 读行 → 落库）
//   - detectTableType：A2 按表头自动识别表类型
//   - LINKED_IMPORT_SIGNATURES：链接表「导入」按钮候选集 = 4 张 linked 签名 + 入金表签名（v2.1.16-beta.3 ②）
//   - linkedTableReaders.readRowsWithMetadata：读全部有意义行（交割表表头在第 2 行，滑窗自动定位）
const { detectTableType } = require('./main-process/table-type-detector');
// v3.0.3 PR-D（W5）：检测工作目录是否落在 OneDrive 同步路径（纯函数，启动后单次 toast 用）
const { isStorageRootOnOneDrive } = require('./main-process/onedrive-detector');
// v3.0.0 块 B / PR-2：大文件链接表流式落库——单 sheet .xlsx 边解压边逐行喂入仓储事务（内存恒定，不全量读进内存）
// v2.1.16 阶段一 A5：批量导入（按表头识别）按 scope='preprocess' 过滤候选
//   PREPROCESS_TABLE_SIGNATURES：银行对账单 / 中台退款订单 / 入账原始订单（期权 TODO 不在内）
//   LINKED_IMPORT_SIGNATURES：链接表导入候选集（含入金表；ALL_TABLE_SIGNATURES 不含入金表，详见 table-signatures.js）
//   v3.0.7 需求2d：「导入文件」按钮通用导入候选集 = ALL_TABLE_SIGNATURES
//     （= 预处理 3 张 + 链接 4 张：bank-statement/refund/intake/gateway/fx/fx-option/mid-allocation）。
//     🔴 绝不含 BANK_DEPOSIT_SIGNATURE —— 它与 bank-statement 同构 44 列、指纹相同，同进候选集必 ambiguous
//        （UT-D1 守护）；bank-deposit 由「44列→Channel 二次路由」识别，不靠表头签名。
//     BANK_DEPOSIT_SIGNATURE 仅供「44列→Channel 二次路由」命中确认后显式取用（读 bank-deposit 链接表）。
const {
  LINKED_IMPORT_SIGNATURES, PREPROCESS_TABLE_SIGNATURES, ALL_TABLE_SIGNATURES, BANK_DEPOSIT_SIGNATURE
} = require('./constants/table-signatures');
// v2.1.16-beta.3 ②：入金表 13 字段裁列纯函数（按字段名 pick，非索引切片）
const { pickBankDepositFields } = require('./backend/database/linked-table-repository');
// v2.1.16-beta.5 需求3：ADM 银行对账单链接表派生纯函数（Channel=ADM 行 → ADM 表 + 中台调拨匹配回填）
const { buildAdmRows } = require('./main-process/adm-bank-deposit-builder');
// v3.0.4 块 E 需求2：BOC 链接表派生纯函数（外汇交割表 → BOC链接表 + BOC调拨银行对账单表，logs 上抛 main.js 统一写日志）。
//   v3.0.5 批次2b：fx 派生改「增量进组 + DB 全量重匹配 + 重编号」——matchBocToMidAllocation 不再由 main.js 直调
//     （并入 rematchAllBocGroups 内对全库行重跑 2.2/2.3）；新增 rematchAllBocGroups 纯函数编排。
const {
  scanFxGroups,
  rematchAllBocGroups,
  buildBocBankRows,
  backfillBocReconLinkIds
} = require('./main-process/boc-fx-link-builder');
// v3.0.5 批次4（T6b-1）：链接表派生重建共享编排函数（🔴🔴 资金红线）。导入侧内联派生逻辑抽出此处，
//   供导入/删除共用（spec §3.3 禁复制 = R-5）。T6b-1 接导入侧（行为字节不变 parity）；
//   T6b-2 接删除侧（linked-table:delete-by-date-range handler 三表化：fx 删→重匹配 / bank-deposit 删→ADM+BOC bank 重建）。
const {
  rebuildAdmDerivation,
  rebuildBankDepositBocDerivation,
  rebuildFxBocDerivation,
  rebuildFundTransferReconDerivation
} = require('./main-process/linked-derive-rebuild');
// v3.0.6 需求1（T3）：调拨对账单派生纯函数（mid-allocation 导入触发 → in/out 两行落 linked_fund_transfer_recon）。
const { buildFundTransferReconRows } = require('./main-process/fund-transfer-recon-builder');
const { streamLinkedRowsToInsert } = require('./main-process/linked-table-stream-source');
const linkedTableReaders = require('./backend/file-service/readers');
const {
  normalizeCell: normalizeLinkedCell,
  trimTrailingEmptyCells: trimToolboxTrailingEmptyCells,
  FileValidationError: LinkedFileValidationError
} = require('./backend/file-service/common');
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
// v3.1.6：VCC财务OP校验（四类明细幂等、逐币种计算、系统OP比较与归档）。
const { createVccFinancialOpService } = require('./main-process/vcc-financial-op-service');
const { vccFinancialOpErrorResult } = require('./main-process/vcc-financial-op-ipc');
// v2.1.12 流式改造（spec §9）：reader 改 exceljs 流式后，由 session.streamScanAndCompute 内部调用，main 不再直接 import
const { runAllScenarios, C4_CATEGORIES } = require('./main-process/scenario-dispatcher');
// v2.1.16-beta.2 T1：5 轮对账编排器（R1→R5；bank-statement:run 接入，dispatcher 仅作 R2）
const { runReconciliation } = require('./main-process/reconciliation-orchestrator');
// v3.1.1：调拨日期策略由唯一 canonical 内置场景持有，但读取不依赖该场景 enabled。
const {
  resolveFundTransferDatePolicy
} = require('./main-process/fund-transfer-date-policy');
// v2.1.12 需求6：数据侧预检只读 helper（统计 C3 银行侧候选行，不触碰 runC3Scenario 资金逻辑）
const { countC3BankCandidates } = require('./main-process/scenario-engines/c3-gateway-recon-join');
// v3.0.0 需求3：退款候选预检只读 helper（统计银行侧 FundType=Ach Return 候选行，与 countC3BankCandidates 对称）
const { countRefundBankCandidates } = require('./main-process/scenario-engines/r5-refund-order-backfill');
// v3.0.5 OPEN-7（T5b-2）：跨期重复命中提醒纯函数（export 阶段判定 + 注入回填行「匹配命中详情」；引擎不读库，库读在 main 侧）
//   独立 require 语句（与上行单标识符 require 分开，保留既有「main.js 接线 countRefundBankCandidates」断言正则不破）。
const {
  pickStaleHits,
  buildStaleHitReminder
} = require('./main-process/scenario-engines/r5-refund-order-backfill');
// v3.0.12 PR#82 codex-Minor：账户映射 IPC 预校验/去重归一化与仓储单一真相对齐（仓储 saveMappings/getMappingMap
//   均用 normalizeCellValue：trim + String 化、数值有限化）—— 防异常非串值（如数值 0）下「IPC 去重键 ≠ DB
//   UNIQUE(mid_account_id) 键」漏判到约束兜底。复用引擎归一化函数，禁自写。
const { normalizeCellValue } = require('./main-process/scenario-engines/engine-utils');
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
  buildMainOutputFileName,
  // v2.1.16-beta.2 R5 场景3：中台加款单剔除文件名 formatter（YYYY_MM_DD_HHMM）
  buildPlatformCleanupFileName,
  // v2.1.16-beta.4 R5 场景4：中台退款订单回填文件名 formatter（YYYY_MM_DD_HHMM）
  buildRefundBackfillFileName
} = require('./main-process/bank-statement-io');
// v2.1.16 阶段一 A5：银行对账单批量导入合并对账核心纯函数（🔴 资金红线，抽离便于单测）
//   mergeBankStatementRows：合并多份银行对账单 rows + 全局重编号 _rowId（唯一不变量）；headers 不一致抛 BankStatementMergeError
const {
  mergeBankStatementRows,
  BankStatementMergeError
} = require('./main-process/bank-statement-merge');
// v3.0.8 需求1：工具箱🧰（合表 / 拆表）核心纯逻辑（脱离主对账流程的轻量 Excel 行级搬运）
//   合表表头一致性校验 / 多文件 aoa 合并 / 字段去重值计算 / 按字段值过滤 / 文件名模板（YYYYMMDDHHmm 时间戳）
//   IPC handler（toolbox:merge / toolbox:split:read / toolbox:split:export）做 dialog + file-service IO，纯变换委托本模块
const {
  buildMergeFileName: toolboxBuildMergeFileName,
  buildSplitFileName: toolboxBuildSplitFileName
} = require('./main-process/toolbox');
const {
  mergeToolboxFilesToXlsx: toolboxMergeFilesToXlsx
} = require('./main-process/toolbox-merge-io');
const {
  normalizeMultiSplitGroups: toolboxNormalizeMultiSplitGroups
} = require('./main-process/toolbox-multi-split');
const {
  publishToolboxPublicationAsync,
  recoverToolboxPublicationsAsync
} = require('./main-process/toolbox-output-publication-dispatch');
const {
  exportToolboxFilter,
  exportToolboxMultiFilters,
  scanToolboxSplitFields
} = require('./main-process/toolbox-format-operations');
// v3.0.9 T6：工具箱「按字段值拆分」大文件隔离 worker 通道——路由判定 + 主侧 dispatch。
//   两个 toolbox:split handler（read/export）在现有小文件分支「之前」加 if (await shouldUseLargeChannel(...)) {大通道}，
//   现有小文件分支原样不动（🔴 小文件零回归）。回传契约逐字节一致（前端零改动）。
const { shouldUseLargeChannel } = require('./main-process/toolbox-large-split-router');
const { dispatchLargeSplit } = require('./main-process/toolbox-large-split-dispatch');
// v2.1.9 N5 T26（spec §5.4 🔴 对外契约破坏性变更）：场景命中行独立报表 writer
//   v2.1.8 主输出 Sheet 3 撤除 → 改独立报表 命中场景行-{basename}-{ts}.xlsx
//   v3.0.4 F2：落位由 error-reports/{date}/ 改为 bank-statement-process/{date}/（与错误报告目录互换）
//   失败 graceful：不阻塞主对账流程，仅 log 警告（spec §5.4）
const { writeScenarioHitRows } = require('./main-process/scenario-hit-rows-writer');
// v2.1.16-beta.2 R5 场景3：中台加款单剔除文件 writer（仿 scenario-hit-rows-writer）
//   导出阶段：R5 场景3 有剔除行产出时，落主输出同目录（主输出为空则落 exportRootDir 日期目录）
//   失败 graceful：不阻塞主对账流程，仅 log 警告
const { writePlatformCleanupOutput } = require('./main-process/platform-cleanup-writer');
// v2.1.16-beta.4 R5 场景4：中台退款订单回填双 sheet writer（仿 platform-cleanup-writer）
//   导出阶段：R5 场景4 有回填行产出时，落主输出同目录（主输出为空则落 exportRootDir 日期目录）
//   失败 graceful：不阻塞主对账流程，仅 log 警告
const { writeRefundBackfillOutput } = require('./main-process/refund-backfill-writer');
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
// v3.0.5 PR-2（Part B Phase 0 / B-D8）：备份保留策略（保留最近 2 份，旧备份启动后台清理）
const backupRetention = require('./backend/database/backup-retention');
const {
  BALANCE_SEED_GENERATION_METHODS,
  findPreviousBalanceSeed,
  readBalanceSeedRecords,
  upsertBalanceSeedRecord,
  splitTemplateName
} = require('./backend/balance-seed-store');
const {
  balanceSeedRecordsEvidence,
  prepareManualBalanceSeedSubmission,
  writeManualBalanceSeedPlan
} = require('./main-process/manual-balance-seed-preflight');
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
const {
  showImportOpenDialog: showRememberedImportOpenDialog
} = require('./main-process/import-dialog-state');
const {
  matchMerchantIds,
  normalizeMaintainedBigAccounts,
  resolveRecognizedBigAccount
} = require('./main-process/big-account-recognition');

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
// 运行结果 side DB 会在启动和新 run 时整库回收，必须阻止两个正式应用实例并发操作同一 userData。
// preview/startup:measure 使用隔离临时目录，允许并行启动，避免开发工具争抢正式实例锁。
const requireSingleInstanceLock = !process.env.APP_CAPTURE_PATH;
const hasSingleInstanceLock = !requireSingleInstanceLock || app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else if (requireSingleInstanceLock) {
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
}
let database = null;
let pendingDb = null;
let preFundReconciliationService = null;
let duplicateInboundMatchService = null;
let positionReconciliationService = null;
let vccFinancialOpService = null;
let appUpdaterService = null;
let appUpdaterStartupScheduled = false;
let archiveCenterService = null;
let archiveOperationTracker = null;
let archiveTaskLifecycle = null;
let archiveOperationTail = Promise.resolve();
const archiveOperationContext = new AsyncLocalStorage();
const positionReconciliationOperationContext = new AsyncLocalStorage();
let positionReconciliationOperationActive = null;
const businessOperationRegistry = createBusinessOperationRegistry();
const taskPolicyRegistry = createTaskPolicyRegistry();
const pr3TaskPolicyHandoff = new Set(PR3_HANDOFF_CHANNELS);
const supportActionChannels = new Set(SUPPORT_ACTION_POLICIES.map((policy) => policy.channel));
const scenarioImportContextStore = createScenarioImportContextStore();
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

function getVccFinancialOpService() {
  if (!database || !database.db) throw new Error('数据库未初始化');
  if (!vccFinancialOpService) {
    vccFinancialOpService = createVccFinancialOpService({
      database,
      assetsDir: path.join(__dirname, '../assets'),
      appVersion: pkg.version,
      buildSha: buildInfo.commit,
      archiveConsistencyLogger: ({ targetMonth, consistencyReasons }) => {
        appendActivityLogEntry({
          level: 'warning',
          message: 'VCC 财务OP归档月份状态不一致，已从可操作列表排除',
          details: [
            `月份：${targetMonth}`,
            `一致性原因：${(consistencyReasons || []).join('、') || 'unknown'}`
          ],
          source: 'main',
          domain: 'vcc-financial-op'
        });
      }
    });
  }
  return vccFinancialOpService;
}
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
let lastPendingBalanceSeedConfirmation = null;
let lastPendingBigAccountSelection = null;
let lastPendingImportConfirmation = null;
let fileImportInProgress = false;
let statementImportSessions = new Map();
let nextStatementBatchId = 1;
let nextStatementFileEntryId = 1;
// v2.0.0-beta.3 PR #32a：银行对账单处理模块的进程级 session
// 进程重启不持久化（与 lastFileImportContext 一致）
let bankStatementSession = null;     // { filePath, fileName, rows, headers, importedAt }
// v2.1.16-beta.4 R5 场景4：中台退款订单预加工 session（非链接表）。
//   v2.1.16-beta.6 需求C 已开通：批量导入识别到「中台退款订单表」时落本 session（readLinkedRowsAsObjects 25 列对象数组）。
//   run 阶段注入 refundContext.refundOrderRows；为 null（本批未导退款表）时注入 []，引擎退款路径 no-op。
let refundOrderSession = null;
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

async function showImportOpenDialog(scope, options) {
  const result = await showRememberedImportOpenDialog({
    dialog,
    browserWindow: mainWindow,
    db: database && database.db,
    scope,
    options
  });
  const context = archiveOperationContext.getStore();
  if (context && result && !result.canceled && Array.isArray(result.filePaths)) {
    context.dialogSelections.push({
      scope,
      filePaths: result.filePaths.slice(),
      properties: Array.isArray(options && options.properties) ? options.properties.slice() : []
    });
  }
  return result;
}

function createPreviewSourceFreshnessGuard(filePaths, label) {
  const snapshots = (Array.isArray(filePaths) ? filePaths : []).map((filePath) => {
    const resolvedPath = path.resolve(String(filePath || ''));
    const snapshot = sourceSnapshotFromStat(fs.statSync(resolvedPath));
    if (!snapshot) throw new Error(`${label}源文件不可读`);
    return { filePath: resolvedPath, snapshot };
  });
  return () => {
    for (const item of snapshots) {
      let stat;
      try {
        stat = fs.statSync(item.filePath);
      } catch (_error) {
        throw new Error(`${label}源文件已不存在，请重新选择`);
      }
      if (!sourceSnapshotMatchesStat(item.snapshot, stat)) {
        throw new Error(`${label}源文件在确认期间已变化，请重新选择`);
      }
    }
  };
}

function createPendingImportFreshnessGuard({ db, yearMonth, files, evidence }) {
  const expectedEvidence = pendingMonthEvidenceValue(evidence);
  const assertSourceFresh = createPreviewSourceFreshnessGuard(files, 'Pending 导入');
  return () => {
    assertSourceFresh();
    if (!pendingDb || pendingDb !== db) {
      throw new Error('Pending 数据库在确认期间已变化，请重新导入');
    }
    const currentEvidence = readPendingMonthEvidence(db, pendingMonthRepo, yearMonth);
    if (pendingMonthEvidenceValue(currentEvidence) !== expectedEvidence) {
      throw new Error(`Pending 月份 ${yearMonth} 在确认期间已变化，请重新导入`);
    }
  };
}

// v2.1.6 fix3 → fix9 → fix10：收单单据币种校验模块的通用 operation lock
// 提到 module-level 是为 fix10 启动钩子（app.whenReady 链中 setImmediate 调 cleanupOrphanData）
// 也需要 acquire lock，避免和 IPC handler 并发；register 函数内部仍可访问（JS 闭包向外查找）
const acquiringBillCurrencyOperationLock = { inFlight: false, operation: null, monthKey: null };
function tryAcquireAcquiringBillCurrencyOpLock(operation, monthKey) {
  if (businessOperationRegistry.isInstallTransitionActive()) {
    return { acquired: false, message: INSTALL_BUSY_MESSAGE };
  }
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

// v3.0.11 需求3（批1 · 🔴 资金红线）：银行对账单处理模块的统一 operation lock。
//   三动作 import(bank-statement:batch-import) / run(bank-statement:run) / export(bank-statement:export)
//   共享同一把互斥锁 —— 它们共享全局会话态 bankStatementSession / processingResult / refundOrderSession /
//   gatewayReconSession，并发执行会撕裂状态（如导出读到运行中途的半截 processingResult）。
//   争用即返回 { status:'failed', message:'正在处理中…' }；handler finally 释放（仿收单 acquiringBillCurrencyOperationLock）。
const bankStatementOperationLock = { inFlight: false, operation: null };
function tryAcquireBankStatementOpLock(operation) {
  if (businessOperationRegistry.isInstallTransitionActive()) {
    return { acquired: false, message: INSTALL_BUSY_MESSAGE };
  }
  if (bankStatementOperationLock.inFlight) {
    return { acquired: false, message: '正在处理中…' };
  }
  bankStatementOperationLock.inFlight = true;
  bankStatementOperationLock.operation = operation;
  return { acquired: true };
}
function releaseBankStatementOpLock() {
  bankStatementOperationLock.inFlight = false;
  bankStatementOperationLock.operation = null;
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
    createScenario: (payload) => database.createScenario(payload),
    // v2.1.13 PR#58 P2-1：builtin-fixed 适用渠道还原（事务内调无事务版 set，避免嵌套 BEGIN）
    findChannelByNameAndLocation: (name, ownerLocation) => database.findChannelByNameAndLocation(name, ownerLocation),
    setScenarioApplicableChannels: (scenarioId, channelIds) => database.setScenarioApplicableChannelsInTx(scenarioId, channelIds),
    // v2.1.13 PR#58 P3-2：限定渠道全 resolve 失败时禁用场景（toggleScenarioEnabled 为裸 UPDATE，安全嵌在外层事务内）
    setScenarioEnabled: (scenarioId, enabled) => database.toggleScenarioEnabled(scenarioId, enabled)
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
  lastPendingBalanceSeedConfirmation = null;
}

function statementSessionFreshnessEvidence(session) {
  if (!session) return '';
  return JSON.stringify({
    key: normalizeCell(session.key),
    importCount: Number(session.importCount || 0),
    currentBatchId: normalizeCell(session.currentBatchId),
    fileEntries: (Array.isArray(session.fileEntries) ? session.fileEntries : []).map((entry) => ({
      id: normalizeCell(entry && entry.id),
      filePath: normalizeCell(entry && entry.filePath),
      matchedTemplateId: Number(entry && entry.matchedTemplateId || 0)
    })),
    batches: (Array.isArray(session.batches) ? session.batches : []).map((batch) => ({
      id: normalizeCell(batch && batch.id),
      entryIds: Array.isArray(batch && batch.entryIds)
        ? batch.entryIds.map((entryId) => normalizeCell(entryId))
        : []
    }))
  });
}

function createManualBalanceSeedFreshnessGuard({
  pendingPrompt,
  importContext,
  session,
  plan
}) {
  const sessionEvidence = statementSessionFreshnessEvidence(session);
  const generatedDetail = lastGeneratedExports.detail;
  const usesRememberedSourceFiles = !importContext.preparedDetailRows
    && !(isFilenameMappingMode(importContext.templateId) && session);
  const inputFilePaths = usesRememberedSourceFiles
    ? normalizeInputFilePaths(importContext.inputFilePaths)
    : [];
  const assertSourceFresh = inputFilePaths.length > 0
    ? createPreviewSourceFreshnessGuard(inputFilePaths, '余额补录')
    : null;

  return {
    inputFilePaths,
    assertFresh() {
      if (lastManualBalancePrompt !== pendingPrompt
          || lastFileImportContext !== importContext
          || lastGeneratedExports.detail !== generatedDetail) {
        throw new Error('余额补录会话在确认期间已变化，请重新导入');
      }
      if (importContext.statementSessionKey) {
        const currentSession = statementImportSessions.get(importContext.statementSessionKey) || null;
        if (currentSession !== session
            || statementSessionFreshnessEvidence(currentSession) !== sessionEvidence) {
          throw new Error('余额补录账单会话在确认期间已变化，请重新导入');
        }
      }
      if (assertSourceFresh) assertSourceFresh();
      const currentRecords = readBalanceSeedRecords(plan.storageRoot, plan.bankName);
      if (balanceSeedRecordsEvidence(currentRecords) !== plan.recordsEvidence) {
        throw new Error('余额种子在确认期间已变化，请重新补录');
      }
    }
  };
}

function clearPendingBigAccountSelection(contextId = '') {
  const normalizedContextId = normalizeCell(contextId);
  if (normalizedContextId
      && normalizeCell(lastPendingBigAccountSelection && lastPendingBigAccountSelection.contextId)
        !== normalizedContextId) {
    return false;
  }
  lastPendingBigAccountSelection = null;
  return true;
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
  const contextId = context ? randomUUID() : '';
  lastPendingBigAccountSelection = context
    ? {
        contextId,
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
          : undefined,
        assertFresh: typeof context.assertFresh === 'function'
          ? context.assertFresh
          : null
      }
    : null;
  return contextId;
}

function requirePendingBigAccountSelection(contextId) {
  const normalizedContextId = normalizeCell(contextId);
  if (!normalizedContextId
      || !lastPendingBigAccountSelection
      || normalizeCell(lastPendingBigAccountSelection.contextId) !== normalizedContextId) {
    return null;
  }
  return lastPendingBigAccountSelection;
}

function createPendingBigAccountSelectionContext(prepared, context) {
  return {
    ...context,
    assertFresh: prepared && typeof prepared.assertFresh === 'function'
      ? prepared.assertFresh
      : null
  };
}

function stagePendingBigAccountSelection(prepared, context) {
  const pendingContext = createPendingBigAccountSelectionContext(prepared, context);
  if (prepared && prepared.previewOnly === true) {
    prepared.pendingBigAccountSelection = pendingContext;
    return pendingContext;
  }
  const contextId = rememberPendingBigAccountSelection(pendingContext);
  return requirePendingBigAccountSelection(contextId);
}

function buildManualBalanceRequiredResult(prompt, generatedFiles) {
  clearLastErrorReport();
  lastPendingBalanceSeedConfirmation = null;
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
  const mapRow = (row, index) => ({
    index: Number.isInteger(row.index) ? row.index : index,
    label: `${index + 1}.`,
    sourceRowNumber: Number(row.sourceRowNumber || 0),
    fileName: normalizeCell(row.fileName)
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

function buildBigAccountPreviewResult(result, contextId) {
  const sanitizeRows = (rows) => (Array.isArray(rows) ? rows : []).map((row, index) => ({
    index: Number.isInteger(row && row.index) ? row.index : index,
    label: normalizeCell(row && row.label) || `${index + 1}.`,
    sourceRowNumber: Number(row && row.sourceRowNumber || 0),
    fileName: normalizeCell(row && row.fileName)
  }));
  return {
    ...result,
    contextId,
    rows: sanitizeRows(result && result.rows),
    rowsWithEmptyBlocks: sanitizeRows(
      result && (result.rowsWithEmptyBlocks || result.rows)
    )
  };
}

function normalizePendingBigAccountSelection(pendingContext, payload = {}) {
  const groupedBigAccounts = Array.isArray(pendingContext.bigAccounts)
    ? pendingContext.bigAccounts
    : [];
  const assignments = Array.isArray(payload.assignments)
    ? payload.assignments.map((item, index) => ({
        merchantId: normalizeCell(item.merchantId),
        currency: normalizeCell(item.currency),
        rowIndex: Number.isInteger(item.index)
          ? item.index
          : (Number.isInteger(item.rowIndex) ? item.rowIndex : index)
      }))
    : [];
  const isFixedMode = payload.mode === 'fixed';
  const expectedRows = isFixedMode
    ? (pendingContext.rowsWithEmptyBlocks || pendingContext.rows)
    : pendingContext.rows;
  if (!assignments.length || assignments.length !== expectedRows.length) {
    const error = new FileValidationError(
      'BIG_ACCOUNT_SELECTION_INVALID',
      `请选择有效的大账号 / 币种（需要 ${expectedRows.length} 个，当前 ${assignments.length} 个）`
    );
    throw error;
  }
  const expectedRowIndexes = new Set(expectedRows.map((row, index) => (
    Number.isInteger(row.index) ? row.index : index
  )));
  const assignmentRowIndexes = new Set(assignments.map((assignment) => assignment.rowIndex));
  if (
    assignmentRowIndexes.size !== expectedRowIndexes.size
    || [...assignmentRowIndexes].some((rowIndex) => !expectedRowIndexes.has(rowIndex))
  ) {
    throw new FileValidationError(
      'BIG_ACCOUNT_SELECTION_INVALID',
      '请选择有效的大账号 / 币种'
    );
  }
  const normalizedAssignments = assignments.map((assignment) => {
    const matchedAccount = groupedBigAccounts.find(
      (item) => item.merchantId === assignment.merchantId
    );
    if (!matchedAccount) {
      throw new FileValidationError(
        'BIG_ACCOUNT_SELECTION_INVALID',
        '请选择有效的大账号 / 币种'
      );
    }
    const availableCurrencies = Array.isArray(matchedAccount.currencies)
      ? matchedAccount.currencies
      : [];
    const normalizedCurrency = matchedAccount.isMultiCurrency
      ? normalizeCell(assignment.currency)
      : normalizeCell(availableCurrencies[0] || assignment.currency);
    if (!normalizedCurrency || !availableCurrencies.includes(normalizedCurrency)) {
      throw new FileValidationError(
        'BIG_ACCOUNT_SELECTION_INVALID',
        `大账号 ${matchedAccount.merchantId} 的币种选择无效`
      );
    }
    return {
      merchantId: matchedAccount.merchantId,
      currency: normalizedCurrency,
      rowIndex: assignment.rowIndex
    };
  }).sort((left, right) => left.rowIndex - right.rowIndex);
  return { isFixedMode, normalizedAssignments };
}

function selectPendingBigAccountRows(pendingContext, mode, rowIndexes = []) {
  const requestedRowIndexes = new Set(
    (Array.isArray(rowIndexes) ? rowIndexes : []).filter(Number.isInteger)
  );
  const serverRows = mode === 'fixed'
    ? (pendingContext && (
        pendingContext.rowsWithEmptyBlocks || pendingContext.rows
      ))
    : (pendingContext && pendingContext.rows);
  return (Array.isArray(serverRows) ? serverRows : [])
    .filter((row) => requestedRowIndexes.has(Number(row.index)));
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
  selectedBigAccount = null,
  reuseMappedRows = false
}) {
  // 默认兼容旧路径从原文件重建；prepare 已产出可信映射行时可直接克隆并注入大账号，
  // 避免大型文件在 prepare + execute 两阶段做两次完整解析。
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
    let config = null;
    if (!reuseMappedRows || entrySelectedBigAccount) {
      config = buildStatementGenerationConfig({
        template: entryTemplateConfig.template,
        mappings: entryTemplateConfig.exportMappings,
        orderedTargetFields: entryTemplateConfig.exportTargetFields,
        selectedBigAccount: entrySelectedBigAccount,
        allowManagedMerchantWithoutSelection: true
      });
    }
    const requiresBillSplitRawRebuild = Boolean(
      reuseMappedRows
      && entrySelectedBigAccount
      && config
      && config.billSplitMerge
      && config.billSplitMerge.enabled
    );
    if (reuseMappedRows && !requiresBillSplitRawRebuild) {
      const detailRows = cloneRowsWithMetadata(entry.detailRows);
      if (entrySelectedBigAccount) {
        const fieldIndexMap = buildFieldIndexMap(detailRows[0] || []);
        const merchantIdIndex = fieldIndexMap.get('MerchantId');
        const currencyIndex = fieldIndexMap.get('Currency');
        const merchantId = normalizeCell(entrySelectedBigAccount.merchantId);
        const currency = normalizeCell(entrySelectedBigAccount.currency);
        detailRows.slice(1).forEach((row) => {
          if (!Array.isArray(row)) return;
          if (merchantIdIndex !== undefined) row[merchantIdIndex] = merchantId;
          if (currencyIndex !== undefined) row[currencyIndex] = currency;
        });
        if (Array.isArray(detailRows.issues)) {
          detailRows.issues = detailRows.issues.filter(
            (issue) => !issue || issue.type !== 'currency-unmapped'
          );
        }
      }
      const merchantLookupFlags = buildManagedMerchantLookupFlags(
        entryTemplateConfig.exportMappings
      );
      return {
        filePath: entry.filePath,
        detailRows,
        matchedTemplateId: entry.matchedTemplateId || entryTemplateConfig.template.id || null,
        matchedHeaders: Array.isArray(entry.matchedHeaders)
          ? entry.matchedHeaders.slice()
          : (entryTemplateConfig.template.headers || []).slice(),
        selfInputMerchant: Boolean(entry.selfInputMerchant || merchantLookupFlags.selfInputMerchant),
        skipDirectMerchantLookup: Boolean(
          entry.skipDirectMerchantLookup || merchantLookupFlags.skipDirectMerchantLookup
        )
      };
    }
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

const BIG_ACCOUNT_RECOGNITION_SCAN_MAX_ROWS = 64;

function readRowsForBigAccountRecognition(filePath) {
  try {
    return readRows(filePath, { blankrows: true, maxRows: BIG_ACCOUNT_RECOGNITION_SCAN_MAX_ROWS });
  } catch (_headReadError) {
    return readRows(filePath, { blankrows: true });
  }
}

function identifyAccountsFromFile({ filePath, expectedSourceHeaders, allMerchantIds, allowSubstringMatch = true }) {
  let rawRows = readRowsForBigAccountRecognition(filePath);
  let headerRowNumbers = findHeaderRowNumbersInRawRows(rawRows, expectedSourceHeaders);

  if (!headerRowNumbers.length && rawRows.length >= BIG_ACCOUNT_RECOGNITION_SCAN_MAX_ROWS) {
    rawRows = readRows(filePath, { blankrows: true });
    headerRowNumbers = findHeaderRowNumbersInRawRows(rawRows, expectedSourceHeaders);
  }

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
          const result = matchMerchantIds(cellStr, mid, { allowSubstring: allowSubstringMatch });
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

function isMultiBigAccountMapping(mappings = []) {
  return (Array.isArray(mappings) ? mappings : []).some((mapping) => {
    return normalizeCell(mapping && mapping.templateField) === 'MerchantId'
      && normalizeCell(mapping && mapping.mappedField)
        === `${FIXED_FIELD_VALUE_PREFIX}${MERCHANT_ID_MULTI_ACCOUNT_MARKER}`;
  });
}

function uniqueNormalizedValues(values = []) {
  return Array.from(new Set(
    (Array.isArray(values) ? values : [])
      .map((value) => normalizeCell(value))
      .filter((value) => value !== '')
  ));
}

function resolveDirectBigAccountRecognition({
  fileEntries = [],
  maintainedBigAccounts = [],
  fallbackTemplateConfig,
  templateName
}) {
  const expandedOptions = expandBigAccountConfigurations(maintainedBigAccounts);
  const allMerchantIds = uniqueNormalizedValues(expandedOptions.map((item) => item.merchantId));
  const selectedByEntry = [];
  const templateConfigCache = new Map();

  if (!allMerchantIds.length) {
    return { status: 'ok', selectedBigAccount: null };
  }

  for (const entry of (Array.isArray(fileEntries) ? fileEntries : [])) {
    const entryTemplateConfig = getEntryTemplateConfig({
      entry,
      fallbackTemplateConfig,
      cache: templateConfigCache
    });

    if (!isMultiBigAccountMapping(entryTemplateConfig && entryTemplateConfig.exportMappings)) {
      continue;
    }

    const fileName = path.basename(entry.filePath || '');
    const fileResult = entry.skipDirectMerchantLookup
      ? { accounts: [], isSingleAccount: false }
      : identifyAccountsFromFile({
          filePath: entry.filePath,
          expectedSourceHeaders: entry.matchedHeaders || entryTemplateConfig.template?.headers || [],
          allMerchantIds,
          allowSubstringMatch: false
        });
    const identifiedMerchantIds = uniqueNormalizedValues(
      (fileResult.accounts || []).map((account) => account.merchantId)
    );

    if (identifiedMerchantIds.length === 0) {
      return resolveRecognizedBigAccount({
        extractedMerchantId: '',
        maintainedBigAccounts,
        sourceFileName: fileName,
        templateName
      });
    }

    if (identifiedMerchantIds.length > 1) {
      return {
        status: 'needs-selection',
        candidates: expandedOptions,
        message: '识别到多个大账号，请选择本次使用的大账号 / 币种。',
        detailLines: [
          `文件名：${fileName || 'N/A'}`,
          `识别值：${identifiedMerchantIds.join('、')}`,
          `模板名：${normalizeCell(templateName) || 'N/A'}`
        ]
      };
    }

    const resolution = resolveRecognizedBigAccount({
      extractedMerchantId: identifiedMerchantIds[0],
      extractedCurrency: '',
      maintainedBigAccounts,
      sourceFileName: fileName,
      templateName
    });

    if (resolution.status !== 'ok') {
      return resolution;
    }

    selectedByEntry.push(resolution.selectedBigAccount);
  }

  if (!selectedByEntry.length) {
    return { status: 'ok', selectedBigAccount: null };
  }

  const uniqueSelectedKeys = uniqueNormalizedValues(
    selectedByEntry.map((item) => `${item.merchantId}\u0000${item.currency}`)
  );

  if (uniqueSelectedKeys.length > 1) {
    return {
      status: 'needs-selection',
      candidates: expandedOptions,
      message: '识别到多个大账号，请选择本次使用的大账号 / 币种。',
      detailLines: [
        `识别值：${selectedByEntry.map((item) => `${item.merchantId}/${item.currency}`).join('、')}`,
        `模板名：${normalizeCell(templateName) || 'N/A'}`
      ]
    };
  }

  return {
    status: 'ok',
    selectedBigAccount: { ...selectedByEntry[0] }
  };
}

function resolvePreparedDirectBigAccountRecognition({ prepared, recognitionArgs }) {
  if (!prepared.previewOnly
      && Object.hasOwn(prepared, 'directBigAccountRecognitionDecision')) {
    return prepared.directBigAccountRecognitionDecision;
  }
  const decision = resolveDirectBigAccountRecognition(recognitionArgs);
  if (prepared.previewOnly) {
    prepared.directBigAccountRecognitionDecision = decision;
  }
  return decision;
}

function resolvePreparedFixedBigAccountAutoMatchDecision(prepared, resolveDecision) {
  if (!prepared.previewOnly
      && Object.hasOwn(prepared, 'fixedBigAccountAutoMatchDecision')) {
    return prepared.fixedBigAccountAutoMatchDecision;
  }
  const decision = resolveDecision();
  if (prepared.previewOnly) {
    prepared.fixedBigAccountAutoMatchDecision = decision;
  }
  return decision;
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
  const operationContext = archiveOperationContext.getStore();
  if (operationContext && operationContext.phase === 'prepare') {
    return createPreflightErrorResult({ message, errorCode, detailLines });
  }
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

function createPreflightErrorResult({
  message,
  errorCode = 'BUSINESS_ERROR',
  detailLines = []
}) {
  return {
    status: 'error',
    message: String(message || '业务校验失败'),
    errorCode: String(errorCode || 'BUSINESS_ERROR'),
    detailLines: Array.isArray(detailLines) ? detailLines.slice() : [],
    errorReportReady: false
  };
}

function createBigAccountRecognitionErrorResult(resolution, context = {}) {
  return createErrorResult({
    step: '识别大账号',
    message: resolution.message || '大账号识别失败，请检查导入文件',
    errorCode: resolution.code || 'BIG_ACCOUNT_RECOGNITION_FAILED',
    detailLines: Array.isArray(resolution.detailLines) ? resolution.detailLines : [],
    context,
    templateName: context.templateName || ''
  });
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
  return normalizeMaintainedBigAccounts(bigAccounts);
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

const VCC_PREVIEW_READINESS_TOKENS = new Set([
  'vcc-financial-op-panel',
  'vcc-financial-op-import-month',
  'vcc-financial-op-run-month',
  'vcc-financial-op-data-manager',
  'vcc-financial-op-data-manager-no-archive',
  'vcc-financial-op-delete',
  'vcc-financial-op-delete-first-month',
  'vcc-financial-op-delete-first-month-archived',
  'vcc-financial-op-delete-result',
  'vcc-financial-op-unarchive',
  'vcc-financial-op-unarchive-year-switch',
  'vcc-financial-op-unarchive-non-tail',
  'vcc-financial-op-unarchive-executing',
  'vcc-financial-op-export',
  'vcc-financial-op-result-export-month',
  'vcc-financial-op-result-export-month-empty',
  'vcc-financial-op-result',
  'vcc-financial-op-result-single-adjustment',
  'vcc-financial-op-result-multiple-adjustments',
  'vcc-financial-op-result-archived',
  'vcc-financial-op-result-zoom-125',
  'vcc-financial-op-result-zoom-150',
  'vcc-financial-op-result-min-window',
  'vcc-financial-op-adjustment',
  'vcc-financial-op-run-preflight-error',
  'vcc-financial-op-opening'
]);
const VCC_PREVIEW_READINESS_TIMEOUT_MS = 8000;

async function waitForVccPreviewCaptureReady(webContents) {
  return webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      const startedAt = Date.now();
      const timeoutMs = ${VCC_PREVIEW_READINESS_TIMEOUT_MS};
      const fail = (message) => reject(new Error(message));
      const poll = () => {
        const readiness = window.__vccPreviewCaptureReady;
        const elapsed = Date.now() - startedAt;
        if (!readiness) {
          if (elapsed >= timeoutMs) {
            fail('VCC preview readiness was not registered before timeout');
            return;
          }
          setTimeout(poll, 25);
          return;
        }
        const remaining = Math.max(1, timeoutMs - elapsed);
        const timer = setTimeout(
          () => fail('VCC preview readiness did not settle before timeout'),
          remaining
        );
        Promise.resolve(readiness).then((result) => {
          clearTimeout(timer);
          if (!result || result.status !== 'ready') {
            fail('VCC preview readiness returned an invalid state');
            return;
          }
          resolve(result);
        }, (error) => {
          clearTimeout(timer);
          fail(error && error.message ? error.message : String(error));
        });
      };
      poll();
    })
  `);
}

function createWindow() {
  const windowIcon = loadBundledIcon();
  const windowOptions = {
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
  };
  if (process.env.APP_CAPTURE_PATH) {
    const captureWidth = Number.parseInt(process.env.APP_CAPTURE_WINDOW_WIDTH || '', 10);
    const captureHeight = Number.parseInt(process.env.APP_CAPTURE_WINDOW_HEIGHT || '', 10);
    const captureZoomFactor = Number.parseFloat(process.env.APP_PREVIEW_ZOOM_FACTOR || '');
    if (Number.isInteger(captureWidth)) windowOptions.width = Math.max(1080, captureWidth);
    if (Number.isInteger(captureHeight)) windowOptions.height = Math.max(760, captureHeight);
    if (Number.isFinite(captureZoomFactor)
      && captureZoomFactor >= 0.5
      && captureZoomFactor <= 2) {
      windowOptions.webPreferences.zoomFactor = captureZoomFactor;
    }
  }
  mainWindow = new BrowserWindow(windowOptions);
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
        let captureExitCode = 0;
        try {
          const previewToken = process.env.APP_PREVIEW_MODAL || '';
          if (previewToken.startsWith('vcc-financial-op-')) {
            if (!VCC_PREVIEW_READINESS_TOKENS.has(previewToken)) {
              throw new Error(`Unknown VCC preview capture token: ${previewToken}`);
            }
            await waitForVccPreviewCaptureReady(mainWindow.webContents);
          }
          const image = await mainWindow.webContents.capturePage();
          fs.mkdirSync(path.dirname(process.env.APP_CAPTURE_PATH), { recursive: true });
          fs.writeFileSync(process.env.APP_CAPTURE_PATH, image.toPNG());
        } catch (error) {
          captureExitCode = 1;
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
          app.exit(captureExitCode);
        }
      }, Number(process.env.APP_CAPTURE_DELAY_MS || 1800));
    }
  });
  mainWindow.on('close', (event) => {
    if (businessOperationRegistry.isInstallTransitionActive() && !quitPreparationComplete) {
      event.preventDefault();
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

const APP_UPDATE_RELEASE_URL = 'https://github.com/MatthewPZhong/bank-bill-excel-tool/releases';

function sendAppUpdateStatus(status) {
  try {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send('app-update:status-changed', status);
    }
  } catch (_error) {
    // 窗口关闭过程中忽略状态广播失败。
  }
}

function createAppUpdateLogger() {
  function write(level, message) {
    try {
      appendActivityLogEntry({
        level: level === 'warn' ? 'warning' : level,
        source: 'main',
        domain: 'app-update',
        message: String(message || '')
      });
    } catch (_error) {
      // electron-updater 的日志适配器不得反向打断检查或下载。
    }
  }
  return {
    debug: (message) => write('info', message),
    info: (message) => write('info', message),
    warn: (message) => write('warning', message),
    error: (message) => write('error', message)
  };
}

function listUpdateRestartBusyOperations() {
  const gate = businessOperationRegistry.beginInstallTransition();
  if (!gate.acquired) {
    const labels = Array.isArray(gate.operations)
      ? gate.operations.map((operation) => operation.label).filter(Boolean)
      : [];
    return labels.length > 0 ? labels : ['升级准备中'];
  }

  const busy = [];
  if (bankStatementOperationLock.inFlight) busy.push('资金对账数据处理');
  if (acquiringBillCurrencyOperationLock.inFlight) busy.push('收单单据币种校验');
  try {
    if (runCheckWorkerPool && typeof runCheckWorkerPool.isBusy === 'function' && runCheckWorkerPool.isBusy()) {
      busy.push('收单校验 worker');
    }
  } catch (_error) {
    busy.push('收单校验 worker 状态检查');
  }

  if (busy.length > 0) businessOperationRegistry.cancelInstallTransition();
  return busy;
}

function getFallbackAppUpdateStatus() {
  const distribution = detectDistribution({ app });
  return {
    enabled: false,
    supported: distribution === 'nsis',
    distribution,
    state: 'disabled',
    currentVersion: app.getVersion(),
    targetVersion: null,
    percent: 0,
    lastCheckedAt: null,
    canRestart: false,
    busyOperations: [],
    error: null
  };
}

function initializeAppUpdaterService() {
  if (appUpdaterService) return appUpdaterService;
  const distribution = detectDistribution({ app });
  const persistedEnabled = Boolean(database && database.getAutoUpdateEnabled());
  const enabled = distribution === 'nsis' && persistedEnabled;
  appUpdaterService = createAppUpdaterService({
    app,
    distribution,
    enabled,
    logger: createAppUpdateLogger(),
    callbacks: {
      onStatusChange: sendAppUpdateStatus,
      getBusyOperations: listUpdateRestartBusyOperations,
      cleanupBeforeRestart: prepareApplicationForQuit,
      resumeAfterFailedRestart: resumeApplicationAfterFailedRestart,
      cancelInstallTransition: () => businessOperationRegistry.cancelInstallTransition()
    }
  });
  appUpdaterService.initialize().catch((error) => {
    appendActivityLogEntry({
      level: 'error',
      source: 'main',
      domain: 'app-update',
      message: '在线升级服务初始化失败',
      details: [error && error.message ? error.message : String(error)]
    });
  });
  return appUpdaterService;
}

async function checkAndDownloadAppUpdate(kind) {
  const service = initializeAppUpdaterService();
  const checked = kind === 'startup'
    ? await service.checkForUpdatesOnStartup()
    : (kind === 'toggle'
      ? await service.checkForUpdates('toggle')
      : await service.checkForUpdatesManually());
  if (checked && checked.state === 'available') {
    const completedKind = service.getLastCompletedCheckKind();
    return service.downloadUpdate({ source: completedKind === 'manual' ? 'manual' : 'automatic' });
  }
  return checked;
}

function scheduleAppUpdaterStartupCheck() {
  if (appUpdaterStartupScheduled) return;
  appUpdaterStartupScheduled = true;
  setImmediate(async () => {
    const service = initializeAppUpdaterService();
    const status = service.getStatus();
    if (!status.enabled || !status.supported) return;
    try {
      await checkAndDownloadAppUpdate('startup');
    } catch (error) {
      appendActivityLogEntry({
        level: 'error',
        source: 'main',
        domain: 'app-update',
        message: '启动后台检查更新失败',
        details: [error && error.message ? error.message : String(error)]
      });
    }
  });
}

function registerAppUpdateHandlers() {
  ipcMain.handle('app-update:get-status', () => {
    return appUpdaterService ? appUpdaterService.getStatus() : getFallbackAppUpdateStatus();
  });

  ipcMain.handle('app-update:set-enabled', async (_event, enabled) => {
    if (typeof enabled !== 'boolean') {
      return { status: 'error', message: '自动更新开关值无效', updateStatus: appUpdaterService?.getStatus() || getFallbackAppUpdateStatus() };
    }
    const service = initializeAppUpdaterService();
    const before = service.getStatus();
    if (!database || !database.db) {
      return { status: 'error', message: '应用尚未初始化完成', updateStatus: before };
    }
    if (!before.supported) {
      return { status: 'error', message: '当前安装类型不支持自动更新', updateStatus: before };
    }
    try {
      database.setAutoUpdateEnabled(enabled);
      let updateStatus = await service.setEnabled(enabled);
      const alreadyUpdating = ['checking', 'available', 'downloading', 'downloaded'].includes(before.state);
      if (enabled && !before.enabled && !alreadyUpdating) {
        updateStatus = await checkAndDownloadAppUpdate('toggle');
      }
      return { status: 'success', updateStatus };
    } catch (_error) {
      return {
        status: 'error',
        message: '自动更新设置失败，请稍后重试',
        updateStatus: service.getStatus()
      };
    }
  });

  ipcMain.handle('app-update:check-now', async () => {
    const service = initializeAppUpdaterService();
    const status = service.getStatus();
    if (status.distribution === 'portable') {
      try {
        await shell.openExternal(APP_UPDATE_RELEASE_URL);
        return { status: 'success', updateStatus: status };
      } catch (error) {
        return { status: 'error', message: '无法打开更新下载页面', updateStatus: status };
      }
    }
    if (!status.supported) {
      return { status: 'error', message: '当前环境不支持在线升级', updateStatus: status };
    }
    try {
      return { status: 'success', updateStatus: await checkAndDownloadAppUpdate('manual') };
    } catch (_error) {
      const failedStatus = service.getStatus();
      return {
        status: 'error',
        message: failedStatus.error?.message || '检查失败，请稍后重试',
        updateStatus: failedStatus
      };
    }
  });

  ipcMain.handle('app-update:restart-and-install', async () => {
    const service = initializeAppUpdaterService();
    try {
      const result = await service.restartAndInstall();
      const updateStatus = result.status;
      if (result.restarted) return { status: 'success', updateStatus };
      const messages = {
        busy: '当前有业务正在处理，暂时不能重启升级',
        unsupported: '当前安装类型不支持自动安装更新',
        'not-downloaded': '更新尚未下载完成'
      };
      return {
        status: result.reason === 'busy' ? 'busy' : 'error',
        message: messages[result.reason] || '暂时无法重启升级',
        busyOperations: result.busyOperations || [],
        updateStatus
      };
    } catch (_error) {
      businessOperationRegistry.cancelInstallTransition();
      return {
        status: 'error',
        message: '重启升级失败，请稍后重试',
        updateStatus: service.getStatus()
      };
    }
  });
}

function archiveCenterUnavailableResult() {
  return {
    status: 'failed',
    code: 'ARCHIVE_CENTER_NOT_READY',
    message: '存档中心正在初始化，请稍后重试'
  };
}

function callArchiveCenter(method, ...args) {
  if (!archiveCenterService || typeof archiveCenterService[method] !== 'function') {
    return archiveCenterUnavailableResult();
  }
  return archiveCenterService[method](...args);
}

function registerArchiveCenterHandlers() {
  ipcMain.handle('archive-center:list-batches', (_event, filters) => {
    return callArchiveCenter('listBatches', filters || {});
  });
  ipcMain.handle('archive-center:get-batch', (_event, batchId) => {
    return callArchiveCenter('getBatch', batchId);
  });
  ipcMain.handle('archive-center:open-file', (_event, fileRefId) => {
    return callArchiveCenter('openFile', fileRefId);
  });
  archiveCenterMutationIpcHandle('archive-center:save-as', '另存为', (_event, fileRefId) => {
    return callArchiveCenter('saveAs', fileRefId);
  });
  archiveCenterMutationIpcHandle('archive-center:set-locked', '锁定批次', (_event, batchId, locked) => {
    if (typeof locked !== 'boolean') {
      return { status: 'failed', message: '批次锁定状态无效' };
    }
    return callArchiveCenter('setLocked', batchId, locked);
  });
  archiveCenterMutationIpcHandle('archive-center:delete-batch', '删除批次', (_event, batchId) => {
    return callArchiveCenter('deleteBatch', batchId);
  });
  archiveCenterMutationIpcHandle('archive-center:select-retry-sources',
    '选择存档恢复文件',
    (_event, batchId) => callArchiveCenter('selectRetrySources', batchId)
  );
  archiveCenterMutationIpcHandle('archive-center:retry-batch', '重试存档', (_event, batchId, sourcePaths) => {
    return callArchiveCenter('retryBatch', batchId, sourcePaths);
  });
  ipcMain.handle('archive-center:get-settings', () => callArchiveCenter('getSettings'));
  archiveCenterMutationIpcHandle('archive-center:set-retention-days', '保存存档设置', (_event, retentionDays) => {
    return callArchiveCenter('setRetentionDays', retentionDays);
  });
  ipcMain.handle('archive-center:get-stats', () => callArchiveCenter('getStats'));
}

function archiveCenterMutationIpcHandle(channel, functionKey, handler) {
  const meta = { channel, moduleKey: '存档中心', functionKey };
  ipcMain.handle(channel, runRegisteredBusinessOperation(meta, handler));
}

function initializeArchiveCenter() {
  if (archiveCenterService || !database || !database.db) return archiveCenterService;
  const archiveRoot = path.join(ensureStorageRoot(), '存档中心');
  const archiveOutbox = createArchiveOutboxStore(path.join(
    path.dirname(database.dbPath),
    'run-data',
    'archive-center',
    'outbox'
  ));
  const service = createArchiveService({
    database: database.db,
    rootDir: archiveRoot,
    opener: (filePath) => shell.openPath(filePath),
    onSourceReleased: cleanupPositionArchiveSourcePaths
  });
  archiveCenterService = createArchiveCenterController({
    database,
    service,
    outboxStore: archiveOutbox,
    onOutboxFlushed: cleanupPositionArchiveSourcePaths,
    resolveOutboxTerminalIntent: resolvePositionOutboxTerminalIntent,
    onTerminalIntentFlushed: finalizePositionTerminalIntent,
    showOpenDialog: (options) => showImportOpenDialog('archive-center-retry-source', options),
    showSaveDialog: (options) => dialog.showSaveDialog(mainWindow, options),
    logWarning: (message, detail) => {
      appendActivityLogEntry({
        level: 'warning',
        source: 'main',
        domain: 'archive-center',
        message,
        details: detail ? [String(detail)] : []
      });
    }
  });
  archiveOperationTracker = createArchiveOperationTracker({ sink: archiveCenterService.sink });
  const flowResolver = createBusinessFlowResolver({ archiveService: service });
  archiveTaskLifecycle = createTaskLifecycle({
    businessOperationRegistry,
    archiveService: service,
    flowResolver,
    operationTracker: archiveOperationTracker,
    persistTerminalIntent: (payload) => archiveCenterService.persistTaskTerminalIntent(payload),
    onArchiveWarning: reportArchiveFailure
  });
  archiveCenterService.initialize().catch((error) => {
    appendActivityLogEntry({
      level: 'warning',
      source: 'main',
      domain: 'archive-center',
      message: '存档中心初始化失败，业务功能继续可用',
      details: [error && error.message ? error.message : String(error)]
    });
  });
  return archiveCenterService;
}

function registerAppHandlers() {
  ipcMain.handle('app:get-info', () => {
    // v3.0.5 PR-5（Part B Phase 3）：两段式——init 未完（新时序窗口先行，database 尚未 init）→ 返回 loading 骨架。
    //   renderer 渲染「正在初始化…」状态 + appVersion；收到 app:init-done 后重新 getInfo 拿全量字段。
    //   ⚠️ 必须用 appInitDone（而非仅判 database 非空）：database init 链中途访问 getCurrentModule 等也可能未就绪。
    if (!appInitDone || !database || !database.db) {
      return { initPending: true, version: app.getVersion() };
    }
    const enumConfig = getEnumConfig();
    return {
      initPending: false,
      version: app.getVersion(),
      storageRoot: ensureStorageRoot(),
      hasEnum: Boolean(enumConfig),
      enumFileName: enumConfig ? enumConfig.sourceFileName : '',
      hasErrorReport: Boolean(lastErrorReport && fs.existsSync(lastErrorReport.filePath)),
      accountMappingCount: database.countAllAccountMappings(),
      currencyOptions: getAvailableCurrencyCodes(),
      backgroundConfig: buildBackgroundPayload(),
      previewModal: process.env.APP_CAPTURE_PATH ? (process.env.APP_PREVIEW_MODAL || '') : '',
      // v2.0.0-beta.2 F1 / v2.1.15 W4：UI 风格恒为 'Clear'（General 已弃用）；renderer 启动时立即应用
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
  // v2.1.15 W4：弃用 General 风格。settings:set-ui-style 写链路已移除；
  //   getUiStyle 兜底后恒返回 'Clear'，renderer 启动 applyUiStyle 仍可用。
  ipcMain.handle('settings:get-ui-style', () => {
    return database.getUiStyle() || 'Clear';
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
  // v2.1.15 W1（spec §3 / 决策 xlsx 为准、旧硬编码作废、存量不迁移）：C3「网关账单字段」枚举
  //   - renderer 打开 C3 配置弹窗时拉取，对账字段/条件行/赋值行的「网关账单字段」下拉用本枚举渲染
  //   - 路径解析：打包后用 app.getAppPath() 拼 assets（与 fund-type-enum handler 同范式）；
  //     dev 期候选含 <repo>/assets/
  //   - 降级（文件缺失/读取失败/表头为空）：loadGatewayReconHeaders 内 fallback 到旧硬编码 GATEWAY_RECON_FIELDS（不抛错）
  //   - 🔴 资金红线：loader 已剔除表头中的 __CUSTOM__ sentinel（避免 C3 自取值 mode 误判）
  //   - 模块级缓存（按解析路径）：重复调用不反复读盘
  ipcMain.handle('scenarios:gateway-recon-headers', () => {
    try {
      const candidates = [
        path.join(app.getAppPath(), 'assets', GATEWAY_RECON_HEADERS_FILE_NAME),
        path.join(__dirname, '..', 'assets', GATEWAY_RECON_HEADERS_FILE_NAME)
      ];
      const found = candidates.find((p) => fs.existsSync(p));
      // found 存在 → 显式传入（打包/dev 都命中）；都不存在 → 传第一个候选，loader 内降级 fallback
      const values = loadGatewayReconHeaders(found || candidates[0]);
      return { status: 'ok', values };
    } catch (error) {
      // 防御：任何异常也走 loader 默认路径（其内部再 fallback），保证 renderer 拿到可用枚举
      return { status: 'ok', values: loadGatewayReconHeaders() };
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
  // v2.1.13 PR#58 review P2-A：builtin-fixed（自带写死场景）属银行对账单处理类别 → 只清 processingResult；
  //   漏加会落 unknown 兜底双清，启停写死场景误清第 5 模块 ReconID 修复结果
  const BANK_STATEMENT_CATEGORIES = new Set(['extract-recon-id', 'offset-bill-mark', 'gateway-recon-join', 'builtin-fixed']);
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
      // v3.0.4 块 F · F2（🔴 资金红线契约守卫）：builtin-fixed 场景若本次更新带 config（UI 整包替换 config_json），
      //   必须仍含 funcCategory + subCategory —— 这两个字段是编排器 bucketScenarios 分桶依据（seed 契约）。
      //   丢任一字段会让场景静默掉出 R4/R5 桶或走错轮次（资金红线偏离）。UI 浅合并理应保留，此处兜底拦截。
      //   非 builtin-fixed / 不带 config 的更新（如仅改 priority/enabled）不受影响。
      if (
        existing && existing.category === 'builtin-fixed'
        && fields && Object.prototype.hasOwnProperty.call(fields, 'config')
      ) {
        const cfg = fields.config;
        if (!cfg || typeof cfg !== 'object' || !cfg.funcCategory || !cfg.subCategory) {
          return {
            status: 'failed',
            message: 'builtin-fixed 场景 config 更新必须保留 funcCategory + subCategory（场景分桶契约字段，不可丢失）'
          };
        }
      }
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
  trackedIpcHandle('scenarios:export-bundle', '银行对账单处理', '场景管理', {
    async prepare(_event, payload = {}) {
      try {
        const inputIds = Array.isArray(payload.channelIds) ? payload.channelIds : [];
        const channelIds = [...new Set(inputIds
          .map((value) => Number(value))
          .filter((value) => Number.isFinite(value) && value > 0))];
        if (channelIds.length === 0) {
          return {
            proceed: false,
            result: { status: 'failed', message: '请至少选择一个银行渠道' }
          };
        }

        // 选择目标文件属于预备阶段；任何数据库读取、序列化和写盘都必须等任务开始后执行。
        const dateStr = formatDateYYYYMMDD(new Date());
        const saveResult = await dialog.showSaveDialog(mainWindow, {
          title: '导出场景模板文件',
          defaultPath: `scenarios-bundle-${dateStr}.json`,
          filters: [{ name: 'JSON', extensions: ['json'] }]
        });
        if (saveResult.canceled || !saveResult.filePath) {
          return { proceed: false, result: { status: 'cancelled' } };
        }

        return {
          proceed: true,
          args: [payload],
          outputPaths: [saveResult.filePath],
          savePath: saveResult.filePath,
          channelIds
        };
      } catch (error) {
        return {
          proceed: false,
          result: { status: 'failed', message: String(error && error.message ? error.message : error) }
        };
      }
    },
    async execute(_event, prepared) {
      try {
        const allChannels = database.listChannels();
        const channelById = new Map(allChannels.map((channel) => [Number(channel.id), channel]));
        const selectedChannels = prepared.channelIds
          .map((id) => channelById.get(id))
          .filter(Boolean);
        if (selectedChannels.length === 0) {
          return {
            status: 'failed',
            message: `选中的渠道 id=${prepared.channelIds.join(',')} 不存在`
          };
        }

        // 拉各渠道的全部 scenarios（含 disabled）。builtin-fixed 场景携带适用渠道，
        // 导入端再按名映射，避免限定渠道在跨库导入后退化为“适用全部”。
        const scenariosByChannel = new Map();
        let totalScenarios = 0;
        for (const channel of selectedChannels) {
          const scenarios = database.listAllScenariosByChannelId(channel.id);
          for (const scenario of scenarios) {
            if (scenario.category === 'builtin-fixed') {
              scenario._applicableChannelIds = database.getScenarioApplicableChannels(scenario.id);
            }
          }
          scenariosByChannel.set(channel.id, scenarios);
          totalScenarios += scenarios.length;
        }
        const channelIdToName = new Map(
          allChannels.map((channel) => [
            Number(channel.id),
            { name: channel.name, ownerLocation: channel.ownerLocation }
          ])
        );
        const jsonText = serializeScenarioBundle(
          selectedChannels,
          scenariosByChannel,
          app.getVersion(),
          channelIdToName
        );

        fs.mkdirSync(path.dirname(prepared.savePath), { recursive: true });
        fs.writeFileSync(prepared.savePath, jsonText, 'utf8');

        appendActivityLogEntry({
          level: 'info',
          message: '导出场景模板文件成功',
          details: [
            `导出路径：${prepared.savePath}`,
            `渠道数：${selectedChannels.length}`,
            `场景数：${totalScenarios}`
          ]
        });
        return {
          status: 'ok',
          filePath: prepared.savePath,
          exportedChannels: selectedChannels.length,
          exportedScenarios: totalScenarios
        };
      } catch (error) {
        return { status: 'failed', message: String(error && error.message ? error.message : error) };
      }
    }
  });

  ipcMain.handle('scenarios:import-bundle', async () => {
    try {
      const choice = await showImportOpenDialog('bank-statement-process-bundle', {
        title: '导入场景模板文件',
        properties: ['openFile'],
        filters: [{ name: 'JSON', extensions: ['json'] }]
      });
      if (choice.canceled || !choice.filePaths || choice.filePaths.length === 0) {
        return { status: 'cancelled' };
      }
      const filePath = choice.filePaths[0];
      let sourceEvidence;
      try {
        sourceEvidence = scenarioImportContextStore.captureSource(filePath);
      } catch (e) {
        return { status: 'failed', message: `读取文件失败：${e && e.message ? e.message : e}` };
      }

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
        allChannels.map((c) => [`${c.name}\u0000${c.ownerLocation}`, c])
      );
      const missingChannels = [];
      for (const ch of bundle.channels) {
        if (ch.isBuiltin) continue;
        const key = `${ch.name}\u0000${ch.ownerLocation}`;
        if (!channelKeyToRecord.has(key)) {
          missingChannels.push({ name: ch.name, ownerLocation: ch.ownerLocation });
        }
      }

      const preparedContextId = scenarioImportContextStore.create({
        bundle,
        filePath,
        sourceSnapshot: sourceEvidence.sourceSnapshot,
        missingChannels
      });
      // picker/解析只是 preview；bundle 留在主进程，renderer 只拿一次性 context ID。
      return {
        status: missingChannels.length > 0 ? 'needs-confirm' : 'ready-to-apply',
        missingChannels,
        preparedContextId
      };
    } catch (error) {
      return { status: 'failed', message: String(error && error.message ? error.message : error) };
    }
  });

  trackedIpcHandle('scenarios:import-bundle-apply', '银行对账单处理', '场景管理', {
    prepare(_event, payload = {}) {
      try {
        const context = scenarioImportContextStore.require(payload.preparedContextId, {
          confirmCreateMissingChannels: payload.confirmCreateMissingChannels === true
        });
        return {
          proceed: true,
          args: [payload],
          inputPaths: [context.filePath],
          scenarioImportContext: context,
          beforeStart: () => scenarioImportContextStore.assertUnchanged(context)
        };
      } catch (error) {
        return {
          proceed: false,
          result: { status: 'failed', code: error.code, message: error.message }
        };
      }
    },
    execute(_event, prepared, _taskContext, payload = {}) {
    try {
      const context = scenarioImportContextStore.consume(payload.preparedContextId, {
        confirmCreateMissingChannels: payload.confirmCreateMissingChannels === true
      });
      const { bundle, filePath } = context;
      const applyResult = applyScenarioBundleImport(bundle, {
        confirmCreateMissingChannels: payload.confirmCreateMissingChannels === true
      });
      // 导入会变更 scenarios 库 → 双清 processingResult + reconIdFixResult 避免老结果误用
      processingResult = null;
      reconIdFixResult = null;
      appendActivityLogEntry({
        level: 'info',
        message: '应用场景模板导入成功',
        details: [
          ...(filePath ? [`导入路径：${filePath}`] : []),
          `新增场景数：${applyResult.importedCount}`,
          `跳过同名场景数：${applyResult.conflicts.length}`,
          `创建渠道数：${applyResult.createdChannels.length}`,
          // v2.1.13 PR#58 P2-1：适用渠道还原 warning（匹配不到的渠道）
          ...(Array.isArray(applyResult.warnings) ? applyResult.warnings : [])
        ]
      });
      return Object.assign({ status: 'ok', filePath: filePath || '' }, applyResult);
    } catch (error) {
      return { status: 'failed', message: String(error && error.message ? error.message : error) };
    }
    }
  });

  // v2.0.0-beta.3 PR #32a：银行对账单处理模块 IO + 调度 IPC
  trackedIpcHandle('bank-statement:import', '银行对账单处理', '导入文件', {
    async prepare() {
      const choice = await showImportOpenDialog('bank-statement-process', {
        title: '选择银行对账单文件',
        properties: ['openFile'],
        filters: [{ name: 'Excel', extensions: ['xlsx'] }]
      });
      if (choice.canceled || !choice.filePaths || choice.filePaths.length === 0) {
        return { proceed: false, result: { status: 'cancelled' } };
      }
      return {
        proceed: true,
        inputPaths: [choice.filePaths[0]],
        filePath: choice.filePaths[0]
      };
    },
    async execute(_event, prepared) {
    try {
      const filePath = prepared.filePath;
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
      // v2.1.16-beta.6 PR#65 新 Finding2（🔴 资金红线）：单文件导入也须清旧退款 session（与批量路径一致）——
      //   否则旧 refundOrderSession 残留 → 下次 bank-statement:run 把上一批退款订单注入新银行单 → 跨批错回填。
      //   单文件 = 单个银行对账单，无「同批退款」并存问题 → 无条件清（不需批量路径的 refundImportedThisBatch 判定）。
      refundOrderSession = null;
      // v2.1.16-beta.3 ①：导入成功后沉淀 Channel/Channel-地区 枚举（纯审计沉淀，失败不阻断导入）
      //   SR-log-1：src/main.js 0 console 调用 → 走 appendActivityLogEntry 上报（warning 级，不 rethrow）
      try {
        database.recordChannelEnumFromBankStatement(result.rows);
      } catch (enumErr) {
        appendActivityLogEntry({
          level: 'warning',
          source: 'main',
          domain: 'channel-enum',
          message: '[channel-enum] 单选导入枚举沉淀失败（已忽略，不影响导入）',
          details: [enumErr && enumErr.message ? enumErr.message : String(enumErr)],
          stack: enumErr && enumErr.stack ? enumErr.stack : undefined
        });
      }
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
    }
  });

  trackedIpcHandle('gateway-recon:import', '银行对账单处理', '导入文件', {
    async prepare() {
      const choice = await showImportOpenDialog('bank-statement-process', {
        title: '选择资金对账不平结果表',
        properties: ['openFile'],
        filters: [{ name: 'Excel', extensions: ['xlsx'] }]
      });
      if (choice.canceled || !choice.filePaths || choice.filePaths.length === 0) {
        return { proceed: false, result: { status: 'cancelled' } };
      }
      return {
        proceed: true,
        inputPaths: [choice.filePaths[0]],
        filePath: choice.filePaths[0]
      };
    },
    async execute(_event, prepared) {
    try {
      const filePath = prepared.filePath;
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
    }
  });

  // PR #33 Codex round 3 P1 资金红线（defense in depth）：
  // 即使 round 2 已在 scenarios:* 4 IPC 入口处清空 processingResult，
  // 仍在 run 时记录 snapshot、export 时再比对一次——让 export handler 自身可见显式校验。
  // snapshot key = id + name + priority + enabled + JSON.stringify(config)
  function buildScenariosSnapshot(detailedEnabled, fundTransferDatePolicySignature = '') {
    const scenarioSnapshot = detailedEnabled
      .map((s) => `${s.id}|${s.name}|${s.priority}|${s.enabled ? 1 : 0}|${JSON.stringify(s.config || {})}`)
      .sort()
      .join('\n');
    return [
      scenarioSnapshot,
      `fund-transfer-date-policy|${String(fundTransferDatePolicySignature || '')}`
    ].join('\n');
  }

  // v3.0.8 需求3（运行不阻塞，🔴 资金红线·只改控制流）：handler 改 async + 取 event 供进度转发器；
  //   数据准备阶段边界 + 编排器轮次边界 await 让出事件循环（消除运行期窗口「未响应」）。
  //   结果零变化（golden 字节一致）—— 只插 yield/进度，不改任何数据准备值、轮次顺序、引擎入参、匹配逻辑。
  //   processingResult 仍在 run 全程完成后一次性赋值（中途 yield 期间无并发 run：handler 入口 session 守卫 + 无新并发入口）。
  trackedIpcHandle('bank-statement:run', '银行对账单处理', '开始运行', async (event) => {
    // v3.0.11 需求3（批1 · 🔴 资金红线）：统一互斥锁。争用即返回失败，绝不与 import/export 并发撕裂会话态。
    const opLock = tryAcquireBankStatementOpLock('run');
    if (!opLock.acquired) {
      return { status: 'failed', message: opLock.message };
    }
    try {
      if (!bankStatementSession) {
        return { status: 'failed', message: '请先导入银行对账单' };
      }
      // 新一轮运行一旦开始，上一轮结果立即失效。后续预检或引擎失败时不得继续导出旧结果。
      processingResult = null;
      // v3.0.8 需求3：run 进度转发器（内联，仿 createRunProgressForwarder）。事件只读不写 processingResult。
      //   🔴 必须内联：本 handler 与收单模块 register 函数不在同一作用域，不能引用其内定义的 forwarder（否则运行时 not defined）。
      const onProgress = (!event || !event.sender) ? null : (ev) => {
        try { event.sender.send('bank-statement:run:progress', { ...ev, phase: 'run' }); }
        catch (_e) { /* swallow — 窗口已销毁等不影响 run */ }
      };
      // 让出事件循环 + 可选进度上报的小工具（与编排器 yieldTick 同范式；onProgress 异常吞掉，绝不影响对账）。
      const yieldRun = async (stage) => {
        if (typeof onProgress === 'function') {
          try { onProgress({ stage }); } catch (_e) { /* swallow — 进度上报失败不影响 run */ }
        }
        await new Promise((r) => setImmediate(r));
      };
      const allScenarios = database.listScenarios();
      // 2026-05-27 N5 fix：getScenario 不返 displayIndex / channelId（缺失）— 用 list item 的字段补
      //   listScenarios 已计算渠道内 1-based displayIndex（与 UI 渠道过滤序号一致）
      //   不补则 dispatcher 兜底 scenario.id（DB 自增）→ 状态框「场景 7、8、9」与 UI 序号不一致
      const detailedAllScenarios = allScenarios.map((s) => {
        const detail = database.getScenario(s.id);
        if (!detail) return null;
        // v2.1.13 D-3：builtin-fixed 自带写死场景附「适用银行渠道」列表（空 = 适用全部，dispatcher 不过滤）
        //   dispatcher runChannelBatch 据此逐行过滤候选行（仅对 matchedChannel 在列表内的行提取）
        const applicableChannelIds = detail.category === 'builtin-fixed'
          ? database.getScenarioApplicableChannels(s.id)
          : null;
        return { ...detail, displayIndex: s.displayIndex, channelId: s.channelId, _applicableChannelIds: applicableChannelIds };
      }).filter(Boolean);
      const detailedEnabled = detailedAllScenarios.filter((s) => s.enabled === 1 || s.enabled === true);
      // v3.1.1：必须从含 disabled 的完整场景集合解析一次全局日期策略。owner 重复或伪内置保留
      // 签名冲突会在这里 fail-closed；owner 缺失/旧字段非法的防御回退告警进入最终错误报告。
      const fundTransferPolicyResolution = resolveFundTransferDatePolicy(detailedAllScenarios);
      const fundTransferDatePolicy = fundTransferPolicyResolution.policy;
      // v2.1.0-beta.1 PR-A round 2 P1（资金红线）：C4 (`recon-id-fix`) 走独立模块
      // `recon-id-fix:run`，不应进入银行对账单 dispatcher（C4 没有对应的 case，
      // dispatcher 内 `runScenario` default 分支会 throw "未知 category"）。
      // 此处 + snapshot 都过滤掉 → 银行对账与单据对账两条流水线相互独立。
      // v2.1.0-beta.3 PR #39 Finding 1（P1）：扩展到所有 C4 category（含 'gateway-recon-id-fix'）
      const dispatchScenarios = detailedEnabled.filter((s) => !C4_CATEGORIES.includes(s.category));
      // v3.0.8 需求3：进入「数据准备」前让出一次（场景查询/枚举已就绪，下方 structuredClone + 各大表读为重活）。
      await yieldRun('prepare');
      // 每次 run 都基于原始导入数据 deep clone 一份工作副本
      // （Codex F1 P1 修复：算法层会原地修改字段，不 clone 会让连续运行的 oldValue 漂移
      //  → first-match-wins 失效，低优先级场景可能覆盖高优先级写入的字段）
      const workingBankRows = structuredClone(bankStatementSession.rows);
      // v3.0.11 需求3（批2）：银行行深拷已完成（原子 clone 后的步骤边界，非 clone 内部）→ 让出一次，再读大网关表。
      await yieldRun('prepare-clone-bank');
      // v2.1.16-beta.2 T1：网关行数据源从「资金对账不平 gatewayReconSession」切到链接表 linked_gateway_bill。
      //   readLinkedTableRows('gateway-bill') 无数据时返回 []（下游各轮自然 no-op）。
      // v3.0.7 需求6 修复（🔴 资金红线）：网关账单表（可达数百万行）改「按 Channel 过滤读」根治内存尖峰
      //   （旧 readLinkedTableRows('gateway-bill') 全量读 + structuredClone 深拷，实测 65.7万行 ~1.2GB 尖峰先例）。
      //   业务不变量（已确认）：对账永远同 Channel → 只读本批银行单出现过的 Channel 子集，绝不漏合法匹配
      //   （任一银行行 B 的合法网关对手 G 必有 G.Channel===B.Channel∈bankChannels → 必在子集内）。
      //   仓储一次 SQL 生成 exactRows + c3Rows：前者保持旧大小写敏感口径，后者仅供 C3 trim+NOCASE 预筛。
      //   ⚠️ 删 structuredClone：gwRows 全程只读（R1/R2/R3.5/R5s2/R5s3 仅建索引/比对，modifications 只写 bankRows）
      //     + 每次新解析 → 深拷无保护意义；银行行 structuredClone(bankStatementSession.rows)（上方 workingBankRows）
      //     必须保留（常驻 session、引擎原地改它）。
      const bankChannels = bankStatementSession.rows.map((r) => (r && r.Channel != null ? String(r.Channel).trim() : ''));
      const gatewayRowPools = database.readGatewayBillRowPoolsByChannels(bankChannels);
      const workingGwRows = gatewayRowPools.exactRows;
      const workingC3GwRows = gatewayRowPools.c3Rows;
      // v3.0.11 需求3（批2）：网关账单大表读完（步骤边界）→ 让出一次，再读入金/调拨等链接表。
      //   🔴 原子性前提（codex-P2 → 补强）：linked-table:import / delete-by-date-range 已纳入 bankStatementOperationLock，
      //   run 全程持锁 → 此让出窗口内并发链接表改动被锁挡住（返回「正在处理中…」）→ gw 与后续 deposit/mid/recon 仍是一致快照。
      await yieldRun('prepare-gw');
      // v2.1.16-beta.4 R5 场景4（中台退款订单回填）安全接线：
      //   入金表（链接表 tableKey='bank-deposit'，beta.3② 合法 tableKey）—— JPM-US 子链路用；无数据返回 []。
      //   refund order —— v2.1.16-beta.6 需求C 退款导入已开通：refundOrderSession 非 null 时注入真实退款行；未导入退款表时注入 []（引擎 no-op）。
      //   structuredClone 防止引擎原地改字段污染 DB 还原对象（与 workingGwRows 同口径）。
      // v3.0.7 需求6 修复（🔴 资金红线）：bank-deposit 入金表（实测 65.7万行 ~1.2GB 尖峰）加「消费方门控」防整表无谓载入。
      //   depositRows 仅 R5 场景4（退款回填）消费（编排器 r5s4Bucket.length 门控，reconciliation-orchestrator.js:443）；
      //   退款场景关闭时编排器本就 no-op，注入 [] 与现状字节级等价。
      //   谓词与 orchestrator bucketScenarios r5s4 分桶条件逐字镜像（reconciliation-orchestrator.js:173：
      //     category==='builtin-fixed' && config.funcCategory==='platform-order' && config.subCategory==='refund-order-backfill'），
      //   防分桶条件改了门控漏更新（gateway-channel/refund 单测钉死同源）。
      //   dispatchScenarios 已是 enabled 过滤后集合（无须再判 enabled，与 paymentOfflineEnabled/dbsChargeScenarioEnabled 同范式）。
      const refundBackfillEnabled = dispatchScenarios.some(
        (s) => s && s.category === 'builtin-fixed'
          && s.config && s.config.funcCategory === 'platform-order'
          && s.config.subCategory === 'refund-order-backfill'
      );
      const workingDepositRows = refundBackfillEnabled
        ? structuredClone(database.readLinkedTableRows('bank-deposit') || [])
        : [];
      const workingRefundOrderRows = refundOrderSession ? structuredClone(refundOrderSession.rows) : []; // 已导退款表→真实行；未导→[]
      // v3.1.7（🔴 资金红线）：Payment 与 R5s2-recon 统一读取调拨对账单派生工作副本。
      //   此处只判定 Payment 开关；不再单独读取 mid-allocation 原始订单交给 Payment。
      const r5s2Scenario = dispatchScenarios.find(
        (s) => String(s.id) === String(fundTransferDatePolicy.ownerScenarioId)
      );
      const paymentOfflineEnabled = !!(
        r5s2Scenario && r5s2Scenario.config
        && r5s2Scenario.config.paymentOfflineBackfill
        && r5s2Scenario.config.paymentOfflineBackfill.enabled === true
      );
      // v3.0.11 需求3（批2）：入金/退款/调拨链接表深拷群已完成（步骤边界）→ 让出一次，再做调拨对账单重派生+读取等剩余重活。
      //   🔴 原子性前提同上（见 prepare-gw 处）：linked-table 写入已纳入 op-lock，run 持锁期间并发改表被挡 → 快照一致。
      await yieldRun('prepare-linked');
      // v3.0.6 需求2（🔴 资金红线）：R5s2「对账数据来源」二选一 —— 勾选「中台调拨单表」时改走调拨对账单回填。
      //   默认勾选（config.reconSourceMid !== false，缺省/老库无字段视为勾选，决策 D4）；
      //   仅勾选路才 structuredClone 读隐藏派生表 linked_fund_transfer_recon，否则注入 []（取消路不读本 context）。
      //   structuredClone 防引擎原地改字段污染 DB 还原对象。
      // v3.0.6 codex-pr74-fix P2（细化）：本判定上移到重派生之前先算一次，给「run 入口重派生」与下方读取共用（去重）。
      const configuredReconSourceMidEnabled = !!(
        r5s2Scenario && r5s2Scenario.config && r5s2Scenario.config.reconSourceMid !== false
      );
      // v3.1.7：Payment 开启时强制使用派生调拨对账单。保留原配置值不落库改写，编排器据此输出兼容提示。
      const reconSourceMidEnabled = paymentOfflineEnabled || configuredReconSourceMidEnabled;
      // v3.0.6 codex-pr74-fix P2（细化，🔴 资金红线）：需求3 DBS-Charge 资金校验（R3.5）是否启用 ——
      //   dispatchScenarios 已是 enabled 过滤后集合（见上方注释「无须再判 enabled」），存在 funcCategory='dbs-charge-fund-check'
      //   场景即下游会消费调拨对账单派生表（DBS-Charge seed 默认 enabled）。供重派生门控 + workingDispatchReconRows 门控共用。
      const dbsChargeScenarioEnabled = dispatchScenarios.some(
        (s) => s && s.config && s.config.funcCategory === 'dbs-charge-fund-check'
      );
      // v3.0.6 codex-pr74-fix P2（🔴 资金红线）：读调拨对账单（readFundTransferReconRows）前，从当前 mid-allocation 实时重派生刷新持久表。
      //   背景：建表迁移 ensureFundTransferReconSupport 仅 CREATE TABLE linked_fund_transfer_recon，不从既有 mid-allocation 回填；
      //   且派生 rebuildFundTransferReconDerivation 原仅在「导入 mid-allocation」时触发。两者叠加 → v3.0.5 升级用户
      //   （已有 mid-allocation 但未重导）隐藏表恒空 → R5s2 勾选路读空表 → 静默不回填（真实回归）。
      //   故在此 run 入口、读取之前实时重派生覆盖持久表，再往下读：升级用户无需重导、永不读空/陈旧表、链接表管理显示同步。
      //   范式照搬导入侧（src/main.js mid-allocation 落库后调用 + 函数内部 try/catch 隔离记 created:false）；
      //   此处再加一层 try/catch + warn 日志。Payment 关闭时保留历史降级；Payment 开启时派生表是唯一数据源，
      //   失败必须阻断，禁止读取陈旧派生表继续写 ReconciliationId。
      //   ⚠️ 消费方门控（仿上方 paymentOfflineEnabled「防整表无谓载入」范式）：仅当下游真会读派生表
      //   （需求2 勾选 reconSourceMidEnabled，或 需求3 dbsChargeScenarioEnabled）时才重派生；两者皆否 = 无消费方 → 跳过重派生，
      //   不为大 mid-allocation 表白付全量读 + 2× 写。两门控默认均 true（R5s2 默认勾选 + DBS-Charge seed 默认 enabled），
      //   故默认仍重派生 —— 升级回归修复不被削弱。
      if (reconSourceMidEnabled || dbsChargeScenarioEnabled) {
        try {
          const { fundTransferReconDerive } = rebuildFundTransferReconDerivation({ database, buildFundTransferReconRows });
          if (fundTransferReconDerive && fundTransferReconDerive.created === false) {
            if (paymentOfflineEnabled) {
              const deriveError = new Error(
                `Payment线下调拨运行前生成调拨对账单失败：${String(fundTransferReconDerive.error || '未知错误')}`
              );
              deriveError.code = 'payment-offline-recon-derive-failed';
              throw deriveError;
            }
            appendActivityLogEntry({
              level: 'warning',
              source: 'main',
              domain: 'fund-transfer-recon-derive',
              message: '[调拨对账单] run 入口实时重派生失败，降级继续（读现有持久表）',
              details: [String(fundTransferReconDerive.error || '')]
            });
          }
        } catch (ftrRunErr) {
          appendActivityLogEntry({
            level: 'warning',
            source: 'main',
            domain: 'fund-transfer-recon-derive',
            message: paymentOfflineEnabled
              ? '[调拨对账单] run 入口实时重派生异常，Payment运行已阻断'
              : '[调拨对账单] run 入口实时重派生异常，降级继续（读现有持久表）',
            details: [ftrRunErr && ftrRunErr.message ? ftrRunErr.message : String(ftrRunErr)]
          });
          if (paymentOfflineEnabled) throw ftrRunErr;
        }
      }
      const workingReconRows = reconSourceMidEnabled
        ? structuredClone(database.readFundTransferReconRows() || [])
        : [];
      // v3.0.6 需求3（🔴 资金红线）：DBS-Charge 资金校验（R3.5）的调拨对账单入参。
      //   数据源同为隐藏派生表 linked_fund_transfer_recon，但语义独立于需求2 —— DBS-Charge 总需调拨对账单，
      //   **不受** reconSourceMid 二选一开关控制；故单独注入（与 workingReconRows 并列、互不影响）。
      // v3.0.6 codex-pr74-fix P2（细化）：门控成 dbsChargeScenarioEnabled，与 workingReconRows 受 reconSourceMidEnabled 门控对称
      //   （仿 paymentOfflineEnabled 防整表无谓载入）。安全性：DBS-Charge 禁用时编排器 R3.5 本就不跑（dbsChargeFundCheck 桶空），
      //   注入 [] 无行为变化。structuredClone 防引擎原地改字段污染 DB 还原对象（与 workingReconRows 同口径）。
      const workingDispatchReconRows = dbsChargeScenarioEnabled
        ? structuredClone(database.readFundTransferReconRows() || [])
        : [];
      // v3.1.1 self-review：多对多检测是独立的只读审计消费者，不能继续只复用
      // R5s2「调拨来源」的 workingReconRows。R5s2 关闭而 R3.5 开启时，R3.5 仍会用
      // workingDispatchReconRows 改写银行行；审计必须看到同一批调拨行，才能报告 2×2/N×M。
      // 这里只选择已经按真实消费者门控加载的副本，不额外读表，也绝不把该数组接回 R5 写入引擎。
      const workingFundTransferAuditReconRows = dbsChargeScenarioEnabled
        ? workingDispatchReconRows
        : workingReconRows;
      // v3.0.8 需求3：进入 R1-R5 编排前让出一次（大表读已完成，下面是 CPU 密集的多轮对账）。
      await yieldRun('reconcile');
      // v2.1.16-beta.2 T1：改走 5 轮编排器 runReconciliation（R2 内部仍调 dispatcher，双维 first-match-wins 不变）。
      //   deps 字段名照搬原 dispatcher 调用处：channelsRepo=channelsRepository（findByNameAndLocation/getBuiltinGeneral）、db=database.db。
      //   编排器返回 modifiedRows/unmatchedRows 由「当前最新 bankRows」重建（资金红线：两者互斥且全覆盖 workingBankRows）。
      // v3.0.8 需求3：runReconciliation 改 async（轮次边界让出 + 进度上报）；onProgress 注入转发器（轮次推进刷新状态框）。
      const result = await runReconciliation({
        bankRows: workingBankRows,
        gwRows: workingGwRows,
        c3GwRows: workingC3GwRows,
        scenarios: dispatchScenarios,
        deps: { channelsRepo: channelsRepository, db: database.db },
        // v2.1.16-beta.4 R5 场景4：退款回填引擎入参（refundOrderRows 非空时引擎产出回填/未匹配行；空则该路径 no-op）
        refundContext: { refundOrderRows: workingRefundOrderRows, depositRows: workingDepositRows },
        // v3.1.7：Payment 与 R5s2-recon 共用这一份工作副本；编排器统一初始化并维护“是否被使用”。
        fundTransferReconContext: { reconRows: workingReconRows },
        // v3.0.6 需求3 R3.5：DBS-Charge 资金校验调拨对账单入参（语义独立于需求2，不受 reconSourceMid 控制；桶空→编排器 no-op）
        dispatchReconContext: { dispatchReconRows: workingDispatchReconRows },
        // v3.1.1 self-review：调拨多对多只读审计入参独立于 R5 写入 gating。
        // R5 关闭但 R3.5 开启时仍注入 R3.5 已使用的调拨副本；编排器不得把它交给 R5。
        fundTransferAuditContext: { reconRows: workingFundTransferAuditReconRows },
        // v3.1.1：R3.5、R5s2 两来源和 M2M 审计共享同一不可变日期策略；配置告警排在引擎告警之前。
        fundTransferDatePolicy,
        initialWarnings: fundTransferPolicyResolution.warnings,
        // v3.0.8 需求3：轮次边界进度上报（编排器在 R1→R2→R3.5→R4→R5 各轮完成后调；只读不写 processingResult）。
        onProgress
      });
      processingResult = {
        modifiedRows: result.modifiedRows,
        // v2.1.7 round 3 F8 (spec §9.8.5)：保留编排器返回的 unmatchedRows（导出阶段写第 2 sheet 用）
        //   保留原始 bankRows 顺序 + 原始字段（buildOutputRows 反向 filter 未做转换）
        //   ⚠️ 资金红线：modifiedRows + unmatchedRows = workingBankRows（无遗漏 + 互斥）
        unmatchedRows: result.unmatchedRows,
        modifications: result.modifications,
        errorReport: result.errorReport,
        stats: result.stats,
        // v2.1.16-beta.2 T1：R5 场景3（平台 Inbound-VA 剔除行）产出 → 透传给导出阶段（缺省 []）
        platformCleanupRows: result.platformCleanupRows || [],
        // v2.1.16-beta.4 R5 场景4（中台退款订单回填）产出 → 透传给导出阶段（未导退款表时为 []）
        refundBackfillRows: result.refundBackfillRows || [],
        refundUnmatchedRows: result.refundUnmatchedRows || [],
        // v3.0.5 OPEN-7（T5b-2）：本批「以入金表为来源、回填成功」的命中 BizId（orchestrator 已透传）+ runId。
        //   runId = bankStatementSession.importedAt（同批 run/export 全程稳定；export 阶段据此判跨期、回写标记）。
        refundHitDepositBizIds: result.refundHitDepositBizIds || [],
        runId: bankStatementSession.importedAt,
        // v3.0.4 块 F 修订 R2 Q14：Payment线下调拨匹配对 → 导出阶段追加 3 核对 sheet（未勾选/无命中时为 []）
        paymentOfflineMatchedPairs: result.paymentOfflineMatchedPairs || [],
        // v3.0.12 功能1：异常-人工判断命中银行行（🔴 只读）→ 导出阶段写「异常-人工判断」sheet（无命中时为 []）
        manyToManyReviewRows: result.manyToManyReviewRows || [],
        scenariosSnapshot: buildScenariosSnapshot(
          dispatchScenarios,
          fundTransferDatePolicy.signature
        ),
        ranAt: Date.now()
      };
      return {
        status: 'ok',
        stats: result.stats
      };
    } catch (error) {
      return {
        status: 'failed',
        code: error && error.code ? String(error.code) : undefined,
        message: String(error && error.message ? error.message : error),
        detailLines: error && Array.isArray(error.detailLines) ? error.detailLines : []
      };
    } finally {
      // v3.0.11 需求3（批1）：无论成功/失败/中途让出，run 结束统一释放互斥锁。
      releaseBankStatementOpLock();
    }
  });

  function inspectBankStatementExportState() {
    const result = processingResult;
    if (!result) {
      return { ok: false, message: '请先点击"开始运行"处理对账单' };
    }
    const detailedAllScenarios = database.listScenarios()
      .map((scenario) => database.getScenario(scenario.id))
      .filter(Boolean);
    const detailedEnabled = detailedAllScenarios
      .filter((scenario) => scenario.enabled === 1 || scenario.enabled === true);
    const fundTransferPolicyResolution = resolveFundTransferDatePolicy(detailedAllScenarios);
    const dispatchScenarios = detailedEnabled
      .filter((scenario) => !C4_CATEGORIES.includes(scenario.category));
    const currentSnapshot = buildScenariosSnapshot(
      dispatchScenarios,
      fundTransferPolicyResolution.policy.signature
    );
    if (result.scenariosSnapshot !== currentSnapshot) {
      return { ok: false, message: '场景已变更，请重新点击"开始运行"再导出' };
    }
    const unmatchedCount = Array.isArray(result.unmatchedRows) ? result.unmatchedRows.length : 0;
    return {
      ok: true,
      processingResult: result,
      bankStatementSession,
      unmatchedCount,
      requiresMainOutput: result.modifiedRows.length > 0 || unmatchedCount > 0
    };
  }

  trackedIpcHandle('bank-statement:export', '银行对账单处理', '导出文件', {
    async prepare() {
      let inspected;
      try {
        inspected = inspectBankStatementExportState();
      } catch (error) {
        return {
          proceed: false,
          result: { status: 'failed', message: String(error && error.message ? error.message : error) }
        };
      }
      if (!inspected.ok) {
        return { proceed: false, result: { status: 'failed', message: inspected.message } };
      }
      let mainFilePath = null;
      if (inspected.requiresMainOutput) {
        const saveResult = await dialog.showSaveDialog(mainWindow, {
          title: '保存处理结果',
          defaultPath: path.join(app.getPath('documents'), buildMainOutputFileName()),
          filters: [{ name: 'Excel', extensions: ['xlsx'] }]
        });
        if (saveResult.canceled || !saveResult.filePath) {
          return { proceed: false, result: { status: 'cancelled' } };
        }
        mainFilePath = saveResult.filePath;
      }
      return {
        proceed: true,
        outputPaths: mainFilePath ? [mainFilePath] : [],
        mainFilePath,
        inspected,
        beforeStart() {
          const current = inspectBankStatementExportState();
          if (!current.ok
              || current.processingResult !== inspected.processingResult
              || current.bankStatementSession !== inspected.bankStatementSession
              || current.requiresMainOutput !== inspected.requiresMainOutput) {
            throw new Error('银行对账导出结果在保存确认期间已变化，请重新导出');
          }
        }
      };
    },
    async execute(_event, prepared) {
    // v3.0.11 需求3（批1 · 🔴 资金红线）：统一互斥锁（与 import/run 共享一把）。争用即返回失败。
    const opLock = tryAcquireBankStatementOpLock('export');
    if (!opLock.acquired) {
      return { status: 'failed', message: opLock.message };
    }
    try {
      const currentExportState = inspectBankStatementExportState();
      if (!currentExportState.ok
          || currentExportState.processingResult !== prepared.inspected.processingResult
          || currentExportState.bankStatementSession !== prepared.inspected.bankStatementSession) {
        processingResult = null;
        return {
          status: 'failed',
          message: currentExportState.message
            || '银行对账导出结果已变化，请重新运行'
        };
      }
      const exportRootDir = path.join(ensureStorageRoot(), 'bank-statement-process');
      // v3.0.4 F2：错误报告改落 error-reports/{date}/（与生成网银账单 .txt、业务OP失败报告共目录）。
      //   ⚠️ exportRootDir 本体绝不能改——R5 场景3/4 落位兜底依赖它（下方 cleanupDir/refundDir）。
      const errorReportRootDir = path.join(ensureStorageRoot(), 'error-reports');

      // v2.1.7 round 8 F8 fix（PR #51 reviewer round 2 Finding 1）：
      //   保存框触发条件必须涵盖 unmatchedRows，否则全未命中时 mainFilePath=null →
      //   后面 writeBankStatementMainOutput 因缺 mainFilePath 抛错（bank-statement-io.js:205）
      //   提前算 unmatchedCount，保存框 + empty 返回两处共用
      const unmatchedCount = currentExportState.unmatchedCount;

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
          // v3.0.4 F2：错误报告落 error-reports/{date}/（命中场景行报表则改落 bank-statement-process/）。
          exportRootDir: errorReportRootDir,
          // v3.0.4 F3：传全量银行行（modifiedRows + unmatchedRows，F8 行数守恒契约全覆盖）→
          //   io 层按 _rowId → ReconciliationId enrich，error-report 第 3 列显示对账ID 而非内部 row_N。
          //   ⚠️ unmatchedRows 必含：R5s4 warning 行多在 unmatchedRows（不产 modifications），缺则覆盖不全。
          bankRows: [
            ...processingResult.modifiedRows,
            ...(Array.isArray(processingResult.unmatchedRows) ? processingResult.unmatchedRows : [])
          ]
        });
      }

      // 主输出 savePath 已在 BOR/reserve 前取得；取消时不会落错误报告或业务文件。
      const mainFilePath = prepared.mainFilePath;
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
        unmatchedRows: Array.isArray(processingResult.unmatchedRows) ? processingResult.unmatchedRows : [],
        // v2.1.16-beta.6 需求 B：透传 modifications → 命中场景 sheet「命中明细」列数据源（D9）
        modifications: processingResult.modifications,
        // v3.0.4 块 F 修订 R2 Q14：Payment线下调拨匹配对 → 主文件追加 3 核对 sheet（空/null 时不加 sheet）
        paymentOfflinePairs: processingResult.paymentOfflineMatchedPairs,
        // v3.0.12 功能1：异常-人工判断命中银行行 → 主文件追加「异常-人工判断」sheet（空/null 时不加 sheet）
        manyToManyRows: processingResult.manyToManyReviewRows
      });

      // v2.1.9 N5 T26（spec §5.1-5.4 🔴 对外契约破坏性变更）：场景命中行独立报表
      //   v2.1.8 主输出 Sheet 3「命中场景行」撤除 → 改独立报表 命中场景行-{basename}-{ts}.xlsx
      //   v3.0.4 F2：落位由 error-reports/{date}/ 改为 bank-statement-process/{date}/（与错误报告目录互换）
      //   失败 graceful：不阻塞主对账流程，仅 log + return 主流程（spec §5.4）
      //   仅当 modifiedRows.length > 0 时输出（含表头但 0 行的报表对用户审计无价值）
      //
      //   v2.1.9 D16=b（2026-05-27 用户拍板）：传 channels 给 writer
      //     writer 用 row._hitChannelId 反查 channels.label 渲染「匹配渠道」列
      //     通用 label='通用' / 非通用 label='name-ownerLocation'（与场景管理 UI 一致）
      let hitRowsReport = null;
      // v2.1.16-beta.2 self-review A：N5「命中场景行」报表只放 R2 命中行（带 _hitScenarioId）。
      //   编排器的 modifiedRows 含 R4/R5-only 改写行（无 _hitScenarioId）——它们进主输出 sheet1 标黄即可，
      //   不应进 N5 报表（否则「匹配渠道/匹配状态/命中场景」三列全空白，污染审计报表）。
      const hitScenarioRows = processingResult.modifiedRows.filter(
        (r) => r && r._hitScenarioId !== undefined && r._hitScenarioId !== null
      );
      if (hitScenarioRows.length > 0) {
        try {
          const originalFilePath = bankStatementSession.filePath;
          const channels = channelsRepository.listChannels(database.db);
          hitRowsReport = await writeScenarioHitRows(
            hitScenarioRows,
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

      // v2.1.16-beta.2 R5 场景3：中台加款单剔除文件（独立于主输出）
      //   落位：主输出同目录（mainFilePath 必非空，因上方 empty 分支已 return）；兜底 exportRootDir
      //   失败 graceful：仅 log + 主流程照常返回（与命中场景行报表范式一致，不阻塞主对账流程）
      let platformCleanupReport = null;
      if (Array.isArray(processingResult.platformCleanupRows) && processingResult.platformCleanupRows.length > 0) {
        try {
          const cleanupDir = mainFilePath ? path.dirname(mainFilePath) : exportRootDir;
          const cleanupPath = path.join(cleanupDir, buildPlatformCleanupFileName());
          platformCleanupReport = await writePlatformCleanupOutput(processingResult.platformCleanupRows, cleanupPath);
        } catch (e) {
          appendActivityLogEntry({
            level: 'warning',
            message: '[banking-statement-process] 中台加款单剔除文件生成失败',
            details: [e && e.message ? e.message : String(e)]
          });
          platformCleanupReport = null;
        }
      }

      // v2.1.16-beta.4 R5 场景4：中台退款订单回填双 sheet 文件（独立于主输出，仿场景3 范式）
      //   落位：主输出同目录（mainFilePath 必非空，因上方 empty 分支已 return）；兜底 exportRootDir
      //   失败 graceful：仅 log + 主流程照常返回（不阻塞主对账流程）
      //   v2.1.16-beta.6 需求C 已开通：导入退款表并运行后 refundBackfillRows/refundUnmatchedRows 可非空 → 进入本 block 落退款回填双 sheet 文件
      //   PR#64 Finding 2：sheet2（报错/未匹配）也需落盘——全报错/无成功回填时唯一需人工处理的 sheet2 不能被跳过。
      // v3.0.5 OPEN-7（T5c · Minor）：导出退款回填行先浅拷贝再注入跨期提醒，绝不 mutate processingResult.refundBackfillRows 缓存行。
      //   原因：注入直接改缓存行 → 若本轮 mark 失败、用户再次 export，同一旧 marker 仍判跨期 → 再次 append 同一行 → 重复提醒文本（append 非幂等）。
      //   浅拷贝（{...r}）即可：注入只改顶层「匹配命中详情」字符串字段；下游写盘（:3904 length / :3908 写盘参数）全部指向此拷贝版。
      //   refundUnmatchedRows 只读不注入 → 无需拷贝（保持引用，省内存）。
      const refundBackfillRowsForExport = Array.isArray(processingResult.refundBackfillRows)
        ? processingResult.refundBackfillRows.map((r) => ({ ...r })) : [];
      const refundUnmatchedRowsForExport = Array.isArray(processingResult.refundUnmatchedRows)
        ? processingResult.refundUnmatchedRows : [];

      // v3.0.5 OPEN-7（T5b-2 / T5c · Important）：写盘前读「旧」命中标记 → 判定跨期 → 注入提醒到回填行「匹配命中详情」。
      //   🔴🔴 严格三步时序：判定+注入（用写盘前的旧 marker）→ 写盘 → 回写（写盘后）。
      //   🔴 必须用写盘前的旧 marker 判定（回写在写盘后），否则同批自标为跨期，误报历史残留。
      //   open7HitBizIds 提到写盘 block 外层（同一 try 作用域），供下方写盘后回写复用，避免重复取值。
      //   🔴 T5c Important：marker 读取/判定/注入整块局部 try/catch——marker 是观测增强（非资金数据），绝不能让其抛错落到 export 外层 catch
      //     使整个导出 status:'failed'、退款文件不落盘（违反 R-8）。失败 → warning + open7Markable=false（本轮不回写，下次 export 重试仍能判跨期）。
      //   open7Markable 串联「判定+注入成功」与下方「写成功」：两者皆真才回写标记（见步骤③）。
      const open7HitBizIds = Array.isArray(processingResult.refundHitDepositBizIds)
        ? processingResult.refundHitDepositBizIds : [];
      let open7Markable = false;
      if (open7HitBizIds.length > 0) {
        try {
          const markerMap = database.readBankDepositHitMarkers(open7HitBizIds); // 仓储内部已 chunk 分批，规避 SQLite IN 参数上限
          const staleHits = pickStaleHits(open7HitBizIds, markerMap, processingResult.runId);
          if (staleHits.length > 0) {
            const staleByBizId = new Map(staleHits.map((s) => [s.bizId, s.lastHitAt]));
            for (const row of refundBackfillRowsForExport) {
              const bizId = row && row._bridgeDepositBizId;
              if (bizId && staleByBizId.has(bizId)) {
                const reminder = buildStaleHitReminder(bizId, staleByBizId.get(bizId));
                // 🔴 append 不覆盖：保留原「匹配命中详情」（与 refund-backfill spec O1/O2 后续叠加兼容）。
                row['匹配命中详情'] = (row['匹配命中详情'] ? row['匹配命中详情'] + '\n' : '') + reminder;
              }
            }
          }
          open7Markable = true; // 判定 + 注入全程无异常 → 允许（在写成功的前提下）回写标记
        } catch (e) {
          appendActivityLogEntry({
            level: 'warning',
            message: '[OPEN-7] 命中标记读取/注入失败（不影响导出产物，本轮不回写标记）',
            details: [e && e.message ? e.message : String(e)]
          });
          open7Markable = false;
        }
      }

      let refundBackfillReport = null;
      if (refundBackfillRowsForExport.length > 0 || refundUnmatchedRowsForExport.length > 0) {
        try {
          const refundDir = mainFilePath ? path.dirname(mainFilePath) : exportRootDir;
          const refundPath = path.join(refundDir, buildRefundBackfillFileName());
          refundBackfillReport = await writeRefundBackfillOutput(
            refundBackfillRowsForExport,
            refundUnmatchedRowsForExport,
            refundPath
          );
        } catch (e) {
          appendActivityLogEntry({
            level: 'warning',
            message: '[banking-statement-process] 中台退款订单回填文件生成失败',
            details: [e && e.message ? e.message : String(e)]
          });
          refundBackfillReport = null;
        }
      }

      // v3.0.5 OPEN-7（T5b-2 · 7a / T5c · Critical）：export 成功后回写命中标记（产物均已落盘，return 'ok' 在即）。
      //   🔴 写失败仅 warning，绝不抛错、绝不阻断产物落地（R-8：标记是观测增强，非资金数据）。
      //   markBankDepositHits 内部自开 BEGIN/COMMIT（linked-table-repository.js）——此处无外层事务包裹，不嵌套。
      //   open7HitBizIds 在写盘前已声明（同一 try 作用域），此处复用（用「旧 marker」判跨期，此刻回写为「新 run」标识）。
      //   🔴🔴 T5c Critical：仅「判定+注入成功（open7Markable）」且「退款回填产物成功落盘（refundBackfillReport 非 null）」才推进 runId。
      //     反例（修复前 bug）：writeRefundBackfillOutput 失败被上方 catch 吞掉（refundBackfillReport=null），但仍 markBankDepositHits 推进 runId
      //       → 用户同批重 run→export 时 marker 已=当前 runId，pickStaleHits 不再报，跨期提醒永久丢失。
      //     修复后：写失败 → 保留旧 marker、不推进 runId（下次 export 重试仍能判跨期，提醒不丢）。
      try {
        if (open7Markable && refundBackfillReport && open7HitBizIds.length > 0) {
          database.markBankDepositHits(open7HitBizIds, String(processingResult.runId), new Date().toISOString());
        }
      } catch (e) {
        appendActivityLogEntry({
          level: 'warning',
          message: '[OPEN-7] 命中标记回写失败（不影响导出产物）',
          details: [e && e.message ? e.message : String(e)]
        });
      }

      return {
        status: 'ok',
        mainFilePath: main.filePath,
        mainFileName: main.fileName,
        errorReportPath: errorReport ? errorReport.filePath : null,
        errorReportName: errorReport ? errorReport.fileName : null,
        // v2.1.9 N5 T26：命中场景行报表路径（落 bank-statement-process/{date}/，v3.0.4 F2 与错误报告互换）
        //   注（v3.0.4 F2 修正陈旧注释）：renderer 当前零消费 hitRowsReportPath/Name，状态框提示从未实现。
        hitRowsReportPath: hitRowsReport ? hitRowsReport.filePath : null,
        hitRowsReportName: hitRowsReport ? hitRowsReport.fileName : null,
        // v2.1.16-beta.2 R5 场景3：renderer 用于状态框提示「中台加款单剔除文件已生成：{path}」
        platformCleanupPath: platformCleanupReport ? platformCleanupReport.filePath : null,
        platformCleanupName: platformCleanupReport ? platformCleanupReport.fileName : null,
        // v2.1.16-beta.4 R5 场景4：renderer 用于状态框提示「中台退款订单回填文件已生成：{path}」（未生成时为 null）
        refundBackfillPath: refundBackfillReport ? refundBackfillReport.filePath : null,
        refundBackfillName: refundBackfillReport ? refundBackfillReport.fileName : null
      };
    } catch (error) {
      return { status: 'failed', message: String(error && error.message ? error.message : error) };
    } finally {
      // v3.0.11 需求3（批1）：导出结束统一释放互斥锁（含 cancelled / empty / ok 各早返回路径）。
      releaseBankStatementOpLock();
    }
    }
  });

  ipcMain.handle('bank-statement:session-status', () => {
    return {
      status: 'ok',
      hasBankStatement: bankStatementSession !== null,
      bankStatementFileName: bankStatementSession ? bankStatementSession.fileName : null,
      bankStatementRowCount: bankStatementSession ? bankStatementSession.rows.length : 0,
      // v2.1.16 A5：合并来源文件数（批量合并导入多文件时 > 1；单文件/单选导入兜底 1）
      bankStatementSourceFileCount: bankStatementSession
        ? (Array.isArray(bankStatementSession.sourceFiles) ? bankStatementSession.sourceFiles.length : 1)
        : 0,
      // v3.0.0 需求1：状态框「渠道-地区」前缀数据源 —— 从合并全集 rows 抽唯一组合（去重 + 排序）
      //   无 session 兜底 []；前端按长度拼前缀（0 个无前缀 / 1 个 CITI-HK: / 多个 CITI-HK、JPM-US:）
      bankStatementChannelRegions: bankStatementSession
        ? database.extractChannelRegionCombos(bankStatementSession.rows)
        : [],
      hasGatewayRecon: gatewayReconSession !== null,
      gatewayReconFileName: gatewayReconSession ? gatewayReconSession.fileName : null,
      gatewayReconRowCount: gatewayReconSession ? gatewayReconSession.gwRows.length : 0,
      // v3.0.0 需求3 🔴 资金红线：退款 session 就绪信号（前端运行点 shouldPromptRefundAtRun 据此判「本批是否已导退款表」）。
      //   refundOrderSession 生命周期已由 PR#65 收紧（单文件导入清 :3494、batch 本批未导退款表清 :11460）→ !==null 严格绑定「本批有效导入退款表」。
      hasRefundOrder: refundOrderSession !== null,
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

  // v3.0.0 需求3：退款回填「候选预检」只读 IPC（仿 bank-statement:c3-candidate-count）。
  //   统计当前导入银行对账单中 FundType=Ach Return 的候选行数；前端导入后 / 运行点提醒据此门控（本批无候选则不弹）。
  //   纯只读查询，无副作用 → 不进 trackedIpcHandle 计数（与 c3-candidate-count 范式一致）。
  ipcMain.handle('bank-statement:refund-candidate-count', () => {
    try {
      if (!bankStatementSession || !Array.isArray(bankStatementSession.rows) || bankStatementSession.rows.length === 0) {
        return { status: 'ok', candidateCount: 0 };
      }
      return { status: 'ok', candidateCount: countRefundBankCandidates(bankStatementSession.rows) };
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

  trackedIpcHandle('recon-id-fix:import', '对账单 ReconID 修复', '导入文件', {
    async prepare(_event, payload) {
      // v2.1.0-beta.3 T9：renderer 传 subMode（'business' | 'gateway'，从 state.reconIdFixBillCategory 推导）
      const subMode = (payload && payload.subMode === 'gateway') ? 'gateway' : 'business';
      const dialogTitle = subMode === 'gateway' ? '选择网关对账文件' : '选择单据对账文件';
      const choice = await showImportOpenDialog('recon-id-fix', {
        title: dialogTitle,
        properties: ['openFile'],
        filters: [{ name: 'Excel', extensions: ['xlsx'] }]
      });
      if (choice.canceled || !choice.filePaths || choice.filePaths.length === 0) {
        return { proceed: false, result: { status: 'cancelled' } };
      }
      return {
        proceed: true,
        args: [payload],
        inputPaths: [choice.filePaths[0]],
        filePath: choice.filePaths[0],
        subMode
      };
    },
    async execute(_event, prepared) {
    try {
      const { filePath, subMode } = prepared;
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
      // v2.1.16-beta.5 需求5：JPM 调拨订单修复分流 —— 注入 ADM 隐藏表行做三段匹配回写（🔴 资金红线）。
      //   仅 JPM 场景读 ADM 表（普通 gateway/business 场景不查 ADM，零影响）。
      //   引擎原地改 admRows（资金对账ID / 两个匹配标志）后经 result.admUpdates 原样返回，
      //   run 成功后整批幂等重写回 ADM 表（writeAdmMatchFlags 按 DB id ASC ↔ 下标配对，行数不一致抛错保护）。
      const isJpmScenario = scenario.config && scenario.config.subCategory === 'jpm-dispatch-order-fix';
      // v3.0.4 块 E 需求3：BOC 调拨订单修复分流 —— 注入 BOC链接表行（只读，引擎不回写，区别于 JPM admUpdates）。
      //   仅 BOC 场景读 readBocFxLinkRows（普通 gateway/business/JPM 场景不查 BOC 表，零影响）。
      const isBocScenario = scenario.category === 'gateway-recon-id-fix'
        && scenario.config && scenario.config.subCategory === 'boc-dispatch-order-fix';
      const runOpts = isJpmScenario
        ? { admRows: database.readAdmBankDepositRows() }
        : (isBocScenario ? { bocLinkRows: database.readBocFxLinkRows() } : {});
      const result = runReconIdFix(scenario, clonedSheets, runOpts);
      if (isJpmScenario && result && Array.isArray(result.admUpdates)) {
        // 整批幂等重写 ADM 表匹配标志 / 资金对账ID（与 C4「run 无副作用」不同 —— TECH §4.5 标注）。
        database.writeAdmMatchFlags(result.admUpdates);
      }
      // v3.0.4 块 E 需求3（O2 拍板）：BOC 修复运行后若有警告 → 写 activity log（warning 级，含逐条明细）。
      //   不写 bankStatementStatusBox（renderer.js:4392/:4465 既有禁写决策保留）；前端逐条文案落运行结果弹框。
      if (isBocScenario && result && Array.isArray(result.warnings) && result.warnings.length > 0) {
        const st = (result && result.stats) || {};
        appendActivityLogEntry({
          level: 'warning',
          source: 'main',
          domain: 'boc-dispatch-order-fix',
          message: `[BOC调拨订单修复] 成功 ${st.groupMatched || 0} 组/失败 ${st.groupFailed || 0} 组，${result.warnings.length} 条警告`,
          details: result.warnings.map((w) => (w && (w.message || w.code)) || '')
        });
      }
      reconIdFixResult = {
        scenarioId: scenario.id,
        scenarioName: scenario.name,
        originModuleId: payload && payload.originModuleId === 'bank-statement-process'
          ? 'bank-statement-process'
          : 'recon-id-fix',
        fixedRows: result.fixedRows,
        warnings: result.warnings,
        unmatchedRows: result.unmatchedRows || [],   // Round 3：落 unmatched
        scenariosSnapshot: buildReconIdFixSnapshot(scenario),
        ranAt: Date.now()
      };
      return {
        status: 'ok',
        stats: result.stats,
        // v2.1.16-beta.5 需求1（PR-4）：透传 warnings 供资金对账面板「开始运行」显示警告数（stats 无 warningCount）
        warnings: result.warnings
      };
    } catch (error) {
      return { status: 'failed', message: String(error && error.message ? error.message : error) };
    }
  });

  trackedIpcHandle('recon-id-fix:export', '对账单 ReconID 修复', '导出文件', {
    async prepare() {
      try {
        const resultSnapshot = reconIdFixResult;
        if (!resultSnapshot) {
          return {
            proceed: false,
            result: { status: 'failed', message: '请先点击"开始运行"' }
          };
        }
        const scenario = database.getScenario(resultSnapshot.scenarioId);
        if (!scenario) {
          return {
            proceed: false,
            result: { status: 'failed', code: 'stale-snapshot', message: '场景已删除，请重新选择场景再运行' }
          };
        }
        if (buildReconIdFixSnapshot(scenario) !== resultSnapshot.scenariosSnapshot) {
          return {
            proceed: false,
            result: { status: 'failed', code: 'stale-snapshot', message: '场景已变更，请重新点击"开始运行"再导出' }
          };
        }
        const fixedRows = Array.isArray(resultSnapshot.fixedRows) ? resultSnapshot.fixedRows : [];
        const unmatchedRows = Array.isArray(resultSnapshot.unmatchedRows) ? resultSnapshot.unmatchedRows : [];
        if (fixedRows.length === 0 && unmatchedRows.length === 0) {
          return {
            proceed: false,
            result: { status: 'empty', message: '本次运行无修复记录且无未匹配记录，未生成文件' }
          };
        }
        const timestamp = buildReconIdFixTimestampMinute();
        const exportSubMode = scenario.category === 'gateway-recon-id-fix' ? 'gateway' : 'business';
        const defaultFileName = (fixedRows.length === 0 && unmatchedRows.length > 0)
          ? buildReconIdFixUnmatchedReportFileName(resultSnapshot.scenarioName, timestamp, null, exportSubMode)
          : buildReconIdFixMainOutputFileName(resultSnapshot.scenarioName, timestamp, exportSubMode);
        const dialogSaveTitle = exportSubMode === 'gateway' ? '保存网关对账修复结果' : '保存单据对账修复结果';
        const saveResult = await dialog.showSaveDialog(mainWindow, {
          title: dialogSaveTitle,
          defaultPath: path.join(app.getPath('documents'), defaultFileName),
          filters: [{ name: 'Excel', extensions: ['xlsx'] }]
        });
        if (saveResult.canceled || !saveResult.filePath) {
          return { proceed: false, result: { status: 'cancelled' } };
        }
        return {
          proceed: true,
          outputPaths: [saveResult.filePath],
          savePath: saveResult.filePath,
          resultSnapshot,
          scenarioSnapshot: resultSnapshot.scenariosSnapshot,
          beforeStart() {
            if (reconIdFixResult !== resultSnapshot) {
              throw new Error('ReconID 修复结果已变化，请重新导出');
            }
            const latestScenario = database.getScenario(resultSnapshot.scenarioId);
            if (!latestScenario
                || buildReconIdFixSnapshot(latestScenario) !== resultSnapshot.scenariosSnapshot) {
              throw new Error('场景已变化，请重新运行后导出');
            }
          }
        };
      } catch (error) {
        return {
          proceed: false,
          result: { status: 'failed', message: String(error && error.message ? error.message : error) }
        };
      }
    },
    async execute(_event, prepared) {
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
      const savePath = prepared.savePath;
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
          savePath
        });
        ret.unmatchedFilePath = writeUnmResult.filePath;
        ret.unmatchedFileName = writeUnmResult.fileName;
        ret.unmatchedCount = writeUnmResult.rowCount;
      } else {
        // 主非空：写主文件（v2.1.0-beta.3 T9 — 传 subMode 选输出列模板 + sheet 名）
        const writeResult = await writeReconIdFixOutput({
          fixedRows,
          savePath,
          subMode: exportSubMode
        });
        ret.mainFilePath = writeResult.filePath;
        ret.mainFileName = writeResult.fileName;
        ret.rowCount = writeResult.rowCount;
        // PR #36 self-review round 5（P3-B，2026-05-09）：
        //   主+unmatched 都非空时，unmatched 文件名联动用户改过的主文件 basename：
        //   `{用户主文件名 stem}-未匹配.xlsx`，写到主文件同目录。
        if (unmatchedRows.length > 0) {
          const mainSaveDir = path.dirname(savePath);
          const mainBaseName = path.basename(savePath);
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
    }
  });

  // v2.1.0-beta.3 PR #39 Codex#1（P2）：清空 main 端 session + result
  // 用户切换"账单类别"时调用，避免 reloadReconIdFixScenarios 内的 refreshReconIdFixStatus 从 main 拉回旧 session
  businessIpcHandle('recon-id-fix:clear-session', '清空会话', () => {
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

  supportIpcHandle('app:save-user-guide', '导出使用手册', async () => {
    try {
      // v2.0.0 GA：默认 HTML（filters 第一项被 saveDialog 当默认；同时 defaultPath 带 .html 后缀加固）
      const result = await dialog.showSaveDialog(mainWindow, {
        defaultPath: `使用手册-v${app.getVersion()}.html`,
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
  supportIpcHandle('error:export-last', '导出错误报告', async () => {
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

  businessIpcHandle('account-mapping:distribute-migration', '分配迁移映射', (_event, assignments) => {
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

// v3.0.12 功能2（批A）：账户映射管理保存前校验（仿 validateAccountMappings，无币种 / 无模板维度）。
//   - 两列皆空 → 跳过（空行不保存）；仅一列为空 → 报错。
//   - 中台调拨单账户号去重（DB UNIQUE(mid_account_id) 兜底，这里先给友好提示）。
//   - 长度护栏（≤128，防异常脏数据；不强加字符集正则，账号格式跨系统不一）。
//   归一化（trim + String）由仓储 saveMappings 统一执行；本函数仅做完整性 / 唯一性 / 长度校验。
function validateFundTransferAccountMappings(mappings) {
  if (!Array.isArray(mappings)) {
    return { status: 'error', message: '账户映射数据格式不正确' };
  }

  const cleanedMappings = [];
  const midAccountSeen = new Set();

  for (const mapping of mappings) {
    // codex-Minor：与仓储 saveMappings / getMappingMap 同口径归一化（normalizeCellValue），使下方去重判定
    //   （midAccountSeen）与 DB UNIQUE(mid_account_id) 完全同键，杜绝异常非串值漏判到约束兜底。
    const midAccountId = normalizeCellValue(mapping && mapping.midAccountId);
    const clearingAccountId = normalizeCellValue(mapping && mapping.clearingAccountId);

    if (!midAccountId && !clearingAccountId) {
      continue;
    }

    if (!midAccountId || !clearingAccountId) {
      return {
        status: 'error',
        message: '账户映射存在未填写完整的行，请补全后再保存'
      };
    }

    if (midAccountId.length > 128 || clearingAccountId.length > 128) {
      return {
        status: 'error',
        message: '账户号长度不能超过128位'
      };
    }

    if (midAccountSeen.has(midAccountId)) {
      return {
        status: 'error',
        message: '中台调拨单账户号不可重复，请重新确认'
      };
    }

    midAccountSeen.add(midAccountId);
    cleanedMappings.push({ midAccountId, clearingAccountId });
  }

  return {
    status: 'success',
    mappings: cleanedMappings
  };
}

// v3.0.12 功能2（批A）：账户映射管理 IPC（list 无参 / save 入参 mappings）；校验/错误处理仿 account-mapping:save。
function registerFundTransferAccountMappingHandlers() {
  ipcMain.handle('fund-transfer-account-mapping:list', () => {
    return {
      status: 'success',
      mappings: database.listFundTransferAccountMappings()
    };
  });

  trackedIpcHandle('fund-transfer-account-mapping:save', '链接表管理', '账户映射管理', (_event, mappings) => {
    // v3.0.12 PR#82 codex-P2 补强（🔴 资金红线）：纳入 bankStatementOperationLock —— 账户映射改写「中台调拨订单对账」
    //   派生的 big_account（批B buildFundTransferReconRows 用 getMappingMap 替换），与链接表同性质、同为
    //   bank-statement run（R1-R5 / R5s2-recon）输入。run/export 全程持锁（含轮次间 yield）；本保存若在 run 让出
    //   窗口内并发执行，会在清 processingResult 后被仍在跑的 run 用旧映射结果覆盖回去 → 可导出 stale 对账结果。
    //   争用即返回失败，finally 释放（与 linked-table:import / delete-by-date-range 同范式）。
    const opLock = tryAcquireBankStatementOpLock('account-mapping-save');
    if (!opLock.acquired) return { status: 'failed', message: opLock.message };
    try {
      const validationResult = validateFundTransferAccountMappings(mappings);

      if (validationResult.status !== 'success') {
        return createErrorResult({
          step: '保存账户映射',
          message: validationResult.message,
          errorCode: 'FUND_TRANSFER_ACCOUNT_MAPPING_VALIDATE',
          detailLines: ['账户映射存在格式或完整性问题，未执行保存。'],
          context: { mappings }
        });
      }

      database.saveFundTransferAccountMappings(validationResult.mappings);
      // 🔴 资金红线：账户映射改写调拨对账派生的 big_account（批B buildFundTransferReconRows 用 getMappingMap 替换），
      //   影响「中台调拨订单对账ID回填」R5s2-recon + DBS-Charge R3.5 → 失效已缓存对账结果，强制用户重跑后才能导出。
      //   （同 linked-table 变更范式：bank-statement:export 守卫只校验 scenariosSnapshot、不认账户映射变更，须在此清缓存兜底。）
      processingResult = null;
      clearLastErrorReport();
      appendActivityLogEntry({
        level: 'info',
        message: '保存账户映射管理成功',
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
        errorCode: 'FUND_TRANSFER_ACCOUNT_MAPPING_RUNTIME',
        errorType: '系统错误',
        originalError: error,
        context: { mappings }
      });
    } finally {
      // v3.0.12 PR#82 codex-P2 补强：保存结束统一释放互斥锁（含校验早返回 / 成功 / 异常路径）。
      releaseBankStatementOpLock();
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

  businessIpcHandle('template:set-parent-status', '设置父模板状态', (_event, templateId, isParent) => {
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

  businessIpcHandle('template:set-child-parent', '设置子模板归属', (_event, templateId, parentTemplateId) => {
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

  trackedIpcHandle('template:import', '生成网银账单', '导入模板', {
    async prepare() {
      const result = await showImportOpenDialog('template', {
        properties: ['openFile'],
        filters: templateFileDialogFilters()
      });
      if (result.canceled || result.filePaths.length === 0) {
        return { proceed: false, result: { status: 'cancelled' } };
      }
      return {
        proceed: true,
        inputPaths: [result.filePaths[0]],
        selectedPath: result.filePaths[0]
      };
    },
    async execute(_event, prepared) {
    const selectedPath = prepared.selectedPath;
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
  businessIpcHandle('template:save-filename-fixed-field', '保存文件名固定字段', (_event, payload = {}) => {
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

  trackedIpcHandle('template:export-bundle', '生成网银账单', '模板管理', {
    async prepare() {
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
        return { proceed: false, result: { status: 'cancelled' } };
      }
      return {
        proceed: true,
        outputPaths: [saveResult.filePath],
        savePath: saveResult.filePath
      };
    },
    async execute(_event, prepared) {
    try {
      writeTemplateBundleFile(prepared.savePath);
      clearLastErrorReport();
      appendActivityLogEntry({
        level: 'info',
        message: '导出模板文件成功',
        details: [`导出路径：${prepared.savePath}`]
      });
      return {
        status: 'success',
        message: '模板文件导出成功',
        filePath: prepared.savePath
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
    }
  });

  trackedIpcHandle('template:import-bundle', '生成网银账单', '模板管理', {
    async prepare() {
      const enumConfig = getEnumConfig();
      if (!enumConfig) {
        return {
          proceed: false,
          result: createPreflightErrorResult({
            message: MISSING_ENUM_MESSAGE,
            errorCode: 'ENUM_MISSING'
          })
        };
      }

      const result = await showImportOpenDialog('template-bundle', {
        properties: ['openFile'],
        filters: [{ name: 'JSON', extensions: ['json'] }]
      });
      if (result.canceled || result.filePaths.length === 0) {
        return { proceed: false, result: { status: 'cancelled' } };
      }

      const selectedPath = result.filePaths[0];
      try {
        const assertSourceFresh = createPreviewSourceFreshnessGuard(
          [selectedPath],
          '模板包'
        );
        const enumValues = loadEnumValues(enumConfig.filePath);
        const importedTemplates = readTemplateBundleFile(selectedPath);
        const importCandidates = importedTemplates
          .filter((entry) => entry.name && entry.headers.length);
        const scanExisting = () => importCandidates
          .map((entry) => {
            const existingTemplate = entry.templateKey
              ? database.getTemplateByKey(entry.templateKey)
              : database.getTemplateByName(entry.name);
            return existingTemplate
              ? `${entry.templateKey || entry.name}:${existingTemplate.id}`
              : '';
          });
        const existingRefs = scanExisting();
        const existingTemplateNames = importCandidates
          .filter((_entry, index) => existingRefs[index])
          .map((entry) => entry.name);

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
            return { proceed: false, result: { status: 'cancelled' } };
          }
        }

        return {
          proceed: true,
          inputPaths: [selectedPath],
          selectedPath,
          enumValues,
          importedTemplates,
          beforeStart() {
            assertSourceFresh();
            if (JSON.stringify(scanExisting()) !== JSON.stringify(existingRefs)) {
              throw new Error('模板库在确认期间已变化，请重新导入并确认覆盖范围');
            }
          }
        };
      } catch (error) {
        const errorResult = error instanceof FileValidationError
          ? createPreflightErrorResult({
              message: error.message,
              errorCode: error.code
            })
          : createPreflightErrorResult({
              message: '模板文件导入失败，请导出报错文件查看详情',
              errorCode: 'TEMPLATE_BUNDLE_IMPORT_RUNTIME'
            });
        return { proceed: false, result: errorResult };
      }
    },
    async execute(_event, prepared) {
    const { enumValues, importedTemplates, selectedPath } = prepared;
    try {
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

  businessIpcHandle('template:save-amount-split-rules', '保存发生额拆分规则', (_event, payload = {}) => {
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

  businessIpcHandle('template:save-bill-split-mappings', '保存账单拆分映射', (_event, payload = {}) => {
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

  businessIpcHandle('template:save-bill-split-row-count', '保存账单拆分行数', (_event, payload = {}) => {
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

  businessIpcHandle('template:save-bill-split-row', '保存账单拆分行', (_event, payload = {}) => {
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

  businessIpcHandle('template:delete-bill-split-row', '删除账单拆分行', (_event, payload = {}) => {
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

  businessIpcHandle('template:save-bill-split-merge-group', '保存账单拆分合并组', (_event, payload = {}) => {
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

  businessIpcHandle('template:clear-bill-split-merge-groups', '清空账单拆分合并组', (_event, payload = {}) => {
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

  businessIpcHandle('template:save-bill-split-amount-rules', '保存账单拆分金额规则', (_event, payload = {}) => {
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

  businessIpcHandle('template:save-bill-split-meta', '保存账单拆分配置', (_event, payload = {}) => {
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
  reuseMappedRows = false,
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
          selectedBigAccount,
          reuseMappedRows
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

async function exportGeneratedFile(generatedFile, emptyMessage, step, savePath) {
  if (!generatedFile || !generatedFile.filePath || !fs.existsSync(generatedFile.filePath)) {
    return createErrorResult({
      step,
      message: emptyMessage,
      errorCode: 'EXPORT_EMPTY',
      templateName: generatedFile?.templateName || ''
    });
  }

  try {
    fs.copyFileSync(generatedFile.filePath, savePath);
    clearLastErrorReport();
    appendActivityLogEntry({
      level: 'info',
      message: `${step}成功`,
      details: [
        `模板名：${generatedFile.templateName || 'N/A'}`,
        `导出路径：${savePath}`
      ]
    });
    return {
      status: 'success',
      message: '文件导出成功',
      filePath: savePath
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
        targetFilePath: savePath
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
  filePaths,
  assertFreshAfterConfirmation = null
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
    if (typeof assertFreshAfterConfirmation === 'function') {
      assertFreshAfterConfirmation();
    }

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

function buildStatementExportPlan(kind, scope = 'auto') {
  const session = getCurrentStatementSession();
  const normalizedScope = scope === 'all' || scope === 'current'
    ? scope
    : shouldPromptForExportScope(session)
      ? 'select'
      : 'current';
  if (normalizedScope === 'select') {
    return { stopResult: buildScopeSelectionResult(kind), normalizedScope, session };
  }
  const emptyMessage = normalizedScope === 'all'
    ? `暂无可导出的全部${kind === 'detail' ? '明细' : '余额'}账单`
    : `暂无可导出的${kind === 'detail' ? '明细' : '余额'}账单`;
  const generatedFile = getGeneratedStatementExport(kind, normalizedScope);
  if (generatedFile && generatedFile.filePath && fs.existsSync(generatedFile.filePath)) {
    return {
      normalizedScope,
      session,
      emptyMessage,
      generatedFile,
      defaultFileName: generatedFile.fileName,
      needsGeneration: false
    };
  }
  if (normalizedScope !== 'all' || !session) {
    return {
      stopResult: createPreflightErrorResult({
        message: emptyMessage,
        errorCode: 'EXPORT_EMPTY'
      }),
      normalizedScope,
      session
    };
  }

  let defaultFileName = '';
  if (isFilenameMappingMode(session.templateId)) {
    const groupMap = new Map();
    for (const entry of getStatementSessionEntries(session, 'all')) {
      const templateId = entry.matchedTemplateId || 0;
      if (!groupMap.has(templateId)) groupMap.set(templateId, []);
      groupMap.get(templateId).push(entry);
    }
    const validGroups = [];
    const allDates = [];
    for (const [templateId, entries] of groupMap) {
      const templateConfig = getTemplateMappingConfig(templateId);
      if (!templateConfig) continue;
      const config = buildStatementGenerationConfig({
        template: templateConfig.template,
        mappings: templateConfig.exportMappings,
        orderedTargetFields: templateConfig.exportTargetFields,
        allowManagedMerchantWithoutSelection: true
      });
      const preparedBatch = buildPreparedStatementBatchFromEntries({ config, fileEntries: entries });
      const dates = parseRequiredBillDates(preparedBatch.detailRows);
      allDates.push(...dates);
      validGroups.push({ config, dates });
    }
    if (validGroups.length === 0) {
      return {
        stopResult: createPreflightErrorResult({
          message: emptyMessage,
          errorCode: 'EXPORT_EMPTY'
        }),
        normalizedScope,
        session
      };
    }
    if (validGroups.length > 1) {
      defaultFileName = `${groupMap.size}-${kind === 'detail' ? 'COMMON' : 'BALANCE'}-${buildDateRangeLabel(allDates) || getToday()}.xlsx`;
    } else {
      defaultFileName = `${validGroups[0].config.template.name}-${kind === 'detail' ? 'COMMON' : 'BALANCE'}-${buildDateRangeLabel(validGroups[0].dates) || getToday()}.xlsx`;
    }
  } else {
    const templateConfig = getTemplateMappingConfig(session.templateId);
    if (!templateConfig) {
      return {
        stopResult: createPreflightErrorResult({
          message: '未找到当前模板，请重新选择模板后导入文件',
          errorCode: 'TEMPLATE_NOT_FOUND'
        }),
        normalizedScope,
        session
      };
    }
    const sessionEntries = getStatementSessionEntries(session, 'all');
    const generationTemplateConfig = resolveGenerationTemplateConfig({
      fileEntries: sessionEntries,
      fallbackTemplateConfig: templateConfig
    });
    const { preparedBatch } = buildStatementSessionGenerationContext({
      session,
      template: generationTemplateConfig.template,
      mappings: generationTemplateConfig.exportMappings,
      orderedTargetFields: generationTemplateConfig.exportTargetFields,
      scope: 'all'
    });
    defaultFileName = `${generationTemplateConfig.template.name}-${kind === 'detail' ? 'COMMON' : 'BALANCE'}-${buildDateRangeLabel(parseRequiredBillDates(preparedBatch.detailRows)) || getToday()}.xlsx`;
  }
  return {
    normalizedScope,
    session,
    emptyMessage,
    generatedFile: null,
    defaultFileName,
    needsGeneration: true
  };
}

async function exportStatementByScope(kind, scope = 'auto', savePath) {
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
        const exportResult = await exportGeneratedFile(generatedFile, emptyMessage, step, savePath);
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
    kind === 'detail' ? '导出明细账单' : '导出余额账单',
    savePath
  );
}

function registerBigAccountHandlers() {
  businessIpcHandle('big-account:import-bank-info', '导入银行账号信息', {
    async prepare(_event, templateId) {
      const template = database.getTemplate(templateId);
      if (!template) {
        return {
          proceed: false,
          result: createPreflightErrorResult({
            message: '未找到对应模板',
            errorCode: 'TEMPLATE_NOT_FOUND'
          })
        };
      }
      const result = await showImportOpenDialog('big-account', {
        properties: ['openFile'],
        filters: [{ name: 'Excel', extensions: ['xlsx', 'xls'] }]
      });
      if (result.canceled || result.filePaths.length === 0) {
        return { proceed: false, result: { status: 'cancelled' } };
      }
      return {
        proceed: true,
        inputPaths: [result.filePaths[0]],
        selectedPath: result.filePaths[0],
        template
      };
    },
    async execute(_event, prepared) {
    const { selectedPath, template } = prepared;
    try {
      const parsed = parseBankAccountExcel(selectedPath);

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
    }
  });

  // v1.5.3 R2：deprecated。自有账号已合入 template_big_accounts 表，由 saveMappings 统一写回。
  // 保留该 handler 仅作兼容（防止老调用链报错），任何新调用应改走 saveMappings。
  businessIpcHandle('big-account:save-own-accounts', '保存自有账户', (_event, payload = {}) => {
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

  businessIpcHandle('balance-adjustment:save', '保存余额调整', (_event, payload = {}) => {
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

function buildBigAccountOrderData(pendingContext, assignments = []) {
  const data = { assignments };
  const fileEntries = pendingContext.fileEntries || [];
  const allMerchantIds = (pendingContext.bigAccounts || [])
    .map((ba) => normalizeCell(ba.merchantId))
    .filter((id) => id !== '');
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
                  const matched = expandedOptions.find(
                    (option) => matchMerchantIds(clearingId, option.merchantId) !== 'none'
                  );
                  if (matched) {
                    fileResult = {
                      accounts: [{ merchantId: matched.merchantId, matchType: 'exact' }],
                      isSingleAccount: true
                    };
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
      const matched = expandedOptions.find(
        (option) => matchMerchantIds(identified.merchantId, option.merchantId) !== 'none'
      );
      return matched
        ? { merchantId: matched.merchantId, currency: matched.currency }
        : { merchantId: identified.merchantId, currency: '' };
    });
    return { fileIndex, accountCount: accounts.length, accounts };
  });
  return data;
}

function persistBigAccountOrderAfterGeneration({
  pendingContext,
  normalizedAssignments,
  rememberOrder,
  result
}) {
  if (typeof rememberOrder !== 'boolean') return result;
  try {
    const data = rememberOrder
      ? buildBigAccountOrderData(pendingContext, normalizedAssignments)
      : { assignments: [] };
    writeBigAccountOrder(ensureStorageRoot(), pendingContext.templateId, data);
    return result;
  } catch (error) {
    const warning = rememberOrder
      ? '账单已生成，但大账号顺序保存失败，本次选择未记住。'
      : '账单已生成，但清除已记住的大账号顺序失败，后续仍可能沿用原顺序。';
    appendActivityLogEntry({
      level: 'warning',
      message: '大账号顺序设置保存失败',
      details: [warning, error && error.message ? error.message : String(error)]
    });
    return {
      ...result,
      status: result && result.status === 'success' ? 'warning' : result.status,
      message: [result && result.message, warning].filter(Boolean).join('\n'),
      detailLines: [
        ...(result && Array.isArray(result.detailLines) ? result.detailLines : []),
        warning
      ],
      bigAccountOrderSaveWarning: warning
    };
  }
}

function registerBigAccountOrderHandlers() {
  ipcMain.handle('big-account-mode:load', (_event, templateId) => {
    try {
      return { status: 'success', mode: readBigAccountMode(ensureStorageRoot(), templateId) };
    } catch (_error) {
      return { status: 'success', mode: 'unfixed' };
    }
  });

  businessIpcHandle('big-account-mode:save', '保存大账号模式', (_event, payload = {}) => {
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

  businessIpcHandle('big-account-order:save', '保存大账号顺序', (_event, payload = {}) => {
    try {
      const data = { assignments: payload.assignments || [] };

      if (payload.includeFileInfo) {
        const pendingContext = requirePendingBigAccountSelection(payload.contextId);
        if (!pendingContext) {
          return { status: 'error', message: '大账号选择预览已失效，请重新导入文件' };
        }
        if (pendingContext.assertFresh) pendingContext.assertFresh();
        const fileInfoData = buildBigAccountOrderData(pendingContext, data.assignments);
        data.fileCount = fileInfoData.fileCount;
        data.files = fileInfoData.files;
      }

      writeBigAccountOrder(ensureStorageRoot(), payload.templateId, data);
      return { status: 'success' };
    } catch (_error) {
      return { status: 'error', message: '大账号选择顺序保存失败' };
    }
  });
}

const STATEMENT_IMPORT_PREVIEW_READY = 'statement-import-preview-ready';

function statementImportPreviewReady() {
  return { status: STATEMENT_IMPORT_PREVIEW_READY };
}

function statementImportSessionForInvocation(prepared, templateId, templateName) {
  if (prepared && prepared.previewOnly === true && prepared.previewSession) {
    return prepared.previewSession;
  }
  return getOrCreateStatementImportSession({
    statementImportSessions,
    templateId,
    templateName
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
function executeFilenameMappingImportPlan(plan) {
  const {
    perTemplateConfigCount,
    trimmedProvisionalEntries,
    syntheticTemplateConfig,
    selectedBigAccount,
    selectionResult
  } = plan;
  const session = getOrCreateStatementImportSession({
    statementImportSessions,
    templateId: FILENAME_MAPPING_TEMPLATE_ID,
    templateName: '按文件名映射模板'
  });
  if (perTemplateConfigCount > 1) {
    const { lastResult, lastBatchId, lastGenerationTemplateConfig } = generateMultiTemplateGroupFiles({
      fileEntries: trimmedProvisionalEntries,
      fallbackTemplateConfig: syntheticTemplateConfig,
      selectedBigAccount,
      reuseMappedRows: true,
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
    selectedBigAccount,
    reuseMappedRows: true
  });
  const generationMerchantMapping = (generationTemplateConfig.exportMappings || []).find(
    (mapping) => normalizeCell(mapping.templateField) === 'MerchantId'
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
  const generatedFiles = {
    ...generateStatementFiles({ config, preparedBatch, scope: 'current' }),
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
}

async function handleFilenameMappingImport(prepared) {
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
    if (!prepared.previewOnly) {
      clearPendingManualBalancePrompt();
      clearPendingBigAccountSelection();
    }
    if (!prepared.previewOnly
        && prepared.statementImportPlan
        && prepared.statementImportPlan.kind === 'filename-mapping') {
      return executeFilenameMappingImportPlan(prepared.statementImportPlan);
    }

    // ===== 步骤 0：文件选择与重复确认已在 reserve 前完成 =====
    const inputFilePaths = prepared.inputFilePaths;

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
    const selectionResult = prepared.selectionResult;

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

      stagePendingBigAccountSelection(prepared, {
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
    let selectedBigAccount = bigAccountOptions.length === 1
      ? { merchantId: bigAccountOptions[0].merchantId, currency: bigAccountOptions[0].currency }
      : null;

    if (selectedBigAccount) {
      const recognitionResult = resolveDirectBigAccountRecognition({
        fileEntries: trimmedProvisionalEntries,
        maintainedBigAccounts: aggregatedBigAccounts,
        fallbackTemplateConfig: syntheticTemplateConfig,
        templateName: virtualTemplateName
      });

      if (recognitionResult.status === 'failed') {
        return createBigAccountRecognitionErrorResult(recognitionResult, {
          templateId: FILENAME_MAPPING_TEMPLATE_ID,
          templateName: virtualTemplateName,
          inputFilePaths: selectionResult.filePaths
        });
      }

      if (recognitionResult.status === 'needs-selection') {
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

        stagePendingBigAccountSelection(prepared, {
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

      if (recognitionResult.selectedBigAccount) {
        selectedBigAccount = recognitionResult.selectedBigAccount;
      }
    }

    const statementImportPlan = {
      kind: 'filename-mapping',
      perTemplateConfigCount: perTemplateConfigCache.size,
      trimmedProvisionalEntries,
      syntheticTemplateConfig,
      selectedBigAccount,
      selectionResult
    };
    if (prepared.previewOnly) {
      prepared.statementImportPlan = statementImportPlan;
      return statementImportPreviewReady();
    }
    return executeFilenameMappingImportPlan(statementImportPlan);
  } catch (error) {
    if (!prepared.previewOnly) {
      clearGeneratedExports();
      clearPendingManualBalancePrompt();
      clearPendingBigAccountSelection();
    }

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

    if (prepared.previewOnly) {
      return createPreflightErrorResult({
        message: '文件转换错误，请检查导入文件后重试',
        errorCode: 'FILE_IMPORT_RUNTIME'
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

async function prepareStatementImportFiles(templateId, templateName) {
  const result = await showImportOpenDialog('statement-generator', {
    properties: ['openFile', 'multiSelections'],
    filters: statementFileDialogFilters()
  });
  if (result.canceled || result.filePaths.length === 0) {
    return { proceed: false, result: { status: 'cancelled' } };
  }
  const inputFilePaths = normalizeInputFilePaths(result.filePaths, { dedupe: false });
  const assertSelectionFresh = createPreviewSourceFreshnessGuard(
    inputFilePaths,
    '网银明细'
  );
  const sessionKey = String(templateId || '');
  const existingSession = statementImportSessions.get(sessionKey) || null;
  const previewSession = existingSession || {
    key: sessionKey,
    fileEntries: [],
    batches: [],
    importCount: 0
  };
  const sessionEvidence = JSON.stringify(previewSession.fileEntries.map((entry) => ({
    id: entry.id,
    filePath: entry.filePath
  })));
  const selectionResult = await resolveImportFileSelection({
    templateName,
    session: previewSession,
    filePaths: inputFilePaths,
    assertFreshAfterConfirmation: assertSelectionFresh
  });
  assertSelectionFresh();
  if (selectionResult.status === 'cancelled' || selectionResult.filePaths.length === 0) {
    return { proceed: false, result: { status: 'cancelled' } };
  }
  const assertSourceFresh = createPreviewSourceFreshnessGuard(
    selectionResult.filePaths,
    '网银明细'
  );
  const assertFresh = () => {
    assertSourceFresh();
    const currentSession = statementImportSessions.get(sessionKey) || { fileEntries: [] };
    const currentEvidence = JSON.stringify(currentSession.fileEntries.map((entry) => ({
      id: entry.id,
      filePath: entry.filePath
    })));
    if (currentEvidence !== sessionEvidence) {
      throw new Error('导入会话在重复文件确认期间已变化，请重新选择文件');
    }
  };
  return {
    proceed: true,
    inputPaths: selectionResult.filePaths,
    inputFilePaths,
    selectionResult,
    previewSession,
    assertFresh,
    beforeStart: assertFresh
  };
}

function registerFileHandlers() {
  const fileImportHandler = {
    async prepare(_event, templateId) {
      if (fileImportInProgress) {
        return {
          proceed: false,
          result: createPreflightErrorResult({
            message: '上一次导入尚未完成，请稍候',
            errorCode: 'IMPORT_IN_PROGRESS'
          })
        };
      }
      if (!getEnumConfig()) {
        return {
          proceed: false,
          result: createPreflightErrorResult({
            message: MISSING_ENUM_MESSAGE,
            errorCode: 'ENUM_MISSING'
          })
        };
      }
      const migrationPending = database.getSetting('account_mapping_migration_pending');
      if (migrationPending === 'true') {
        return {
          proceed: false,
          result: createPreflightErrorResult({
            message: '账户映射数据迁移尚未完成，请先打开「账户映射」页面完成数据分配',
            errorCode: 'ACCOUNT_MAPPING_MIGRATION_PENDING'
          })
        };
      }
      let preparedFiles;
      if (isFilenameMappingMode(templateId)) {
        preparedFiles = await prepareStatementImportFiles(
          templateId,
          '按文件名映射模板'
        );
      } else if (!templateId) {
        return {
          proceed: false,
          result: createPreflightErrorResult({
            message: '请选择模板',
            errorCode: 'TEMPLATE_REQUIRED'
          })
        };
      } else {
        const templateConfig = getTemplateMappingConfig(templateId);
        if (!templateConfig) {
          return {
            proceed: false,
            result: createPreflightErrorResult({
              message: '未找到对应模板',
              errorCode: 'TEMPLATE_NOT_FOUND'
            })
          };
        }
        preparedFiles = await prepareStatementImportFiles(
          templateId,
          templateConfig.template.name
        );
      }

      if (!preparedFiles.proceed) return preparedFiles;
      const previewPrepared = {
        ...preparedFiles,
        previewOnly: true,
        pendingBigAccountSelection: null
      };
      const previewResult = await fileImportHandler.execute(
        _event,
        previewPrepared,
        null,
        templateId
      );
      try {
        previewPrepared.assertFresh();
      } catch (error) {
        previewPrepared.previewOnly = false;
        return {
          proceed: false,
          result: createPreflightErrorResult({
            message: error && error.message
              ? error.message
              : '网银明细源文件在预检期间已变化，请重新选择',
            errorCode: 'STATEMENT_IMPORT_SOURCE_CHANGED'
          })
        };
      }
      previewPrepared.previewOnly = false;
      if (previewResult && previewResult.status === STATEMENT_IMPORT_PREVIEW_READY) {
        return previewPrepared;
      }
      if (previewResult
          && (previewResult.status === 'select-big-account'
            || previewResult.status === 'remember-order-mismatch')) {
        const pendingContext = previewPrepared.pendingBigAccountSelection;
        if (!pendingContext) {
          return {
            proceed: false,
            result: createPreflightErrorResult({
              message: '大账号选择预览缺少主进程上下文，请重新导入文件',
              errorCode: 'BIG_ACCOUNT_SELECTION_CONTEXT_MISSING'
            })
          };
        }
        const contextId = rememberPendingBigAccountSelection(pendingContext);
        return {
          proceed: false,
          result: buildBigAccountPreviewResult(previewResult, contextId)
        };
      }
      return { proceed: false, result: previewResult };
    },
    async execute(_event, prepared, _taskContext, templateId) {
    // v1.5.2 需求 3（G3-7）：虚拟 ID 走独立分支
    // 见 handleFilenameMappingImport（文件名+表头双校验 + 整批截断 + 复用大账号选择流程）
    if (isFilenameMappingMode(templateId)) {
      return handleFilenameMappingImport(prepared);
    }

    if (fileImportInProgress) {
      return createErrorResult({
        step: '导入网银明细文件',
        message: '上一次导入尚未完成，请稍候',
        errorCode: 'IMPORT_IN_PROGRESS'
      });
    }

    let templateConfig = null;
    fileImportInProgress = true;

    try {
      if (!prepared.previewOnly) {
        clearPendingManualBalancePrompt();
        clearPendingBigAccountSelection();
      }
      templateConfig = getTemplateMappingConfig(templateId);

      if (!templateConfig) {
        return createErrorResult({
          step: '导入网银明细文件',
          message: '未找到对应模板',
          errorCode: 'TEMPLATE_NOT_FOUND',
          context: { templateId }
        });
      }

      const inputFilePaths = prepared.inputFilePaths;
      const session = statementImportSessionForInvocation(
        prepared,
        templateId,
        templateConfig.template.name
      );
      const selectionResult = prepared.selectionResult;

      // v1.5.1: 主模板导入 — 自动匹配子模板
      if (templateConfig.template.isParent && !selectionResult.parentProvisionalEntries) {
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
        if (prepared.previewOnly && !selectionResult.parentProvisionalEntries) {
          selectionResult.parentProvisionalEntries = provisionalFileEntries;
        }
        const savedMode = readBigAccountMode(ensureStorageRoot(), templateId);
        const savedOrderConfig = readBigAccountOrder(ensureStorageRoot(), templateId);


        let forceUnfixedMode = false;
        if (savedMode === 'fixed' && savedOrderConfig && Array.isArray(savedOrderConfig.files) && savedOrderConfig.files.length > 0) {
          const importFileCount = selectionResult.filePaths.length;

          if (importFileCount !== savedOrderConfig.fileCount) {
            // 文件个数不等于"记住顺序"里的文件个数 → 降级为"不固定"模式
            forceUnfixedMode = true;
          } else if (importFileCount === savedOrderConfig.fileCount) {
            const autoMatchDecision = resolvePreparedFixedBigAccountAutoMatchDecision(
              prepared,
              () => {
                const allMerchantIds = effectiveBigAccounts
                  .map((ba) => normalizeCell(ba.merchantId))
                  .filter((id) => id !== '');
                const defaultExpectedSourceHeaders = templateConfig.template.headers || [];
                const failedFileNames = [];
                const usedSavedIndices = new Set();
                const fileMatchMap = new Map(); // importIndex → savedFileIndex

                // 每个导入文件用账户个数+账户号去全部保存文件里找匹配（不按位置对位）
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
                                const matched = bigAccountOpts.find(
                                  (option) => matchMerchantIds(clearingId, option.merchantId) !== 'none'
                                );
                                if (matched) {
                                  fileResult = {
                                    accounts: [{ merchantId: matched.merchantId, matchType: 'exact' }],
                                    isSingleAccount: true
                                  };
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
                      return fileResult.accounts.some((identified) => (
                        matchMerchantIds(identified.merchantId, savedAccount.merchantId) !== 'none'
                      ));
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

                const reorderedAssignments = [];
                if (failedFileNames.length === 0
                    && Array.isArray(savedOrderConfig.assignments)
                    && savedOrderConfig.assignments.length > 0) {
                  // 按 fileMatchMap 重排 assignments：按导入文件顺序重组保存的 assignments
                  const savedFiles = savedOrderConfig.files || [];
                  const savedAssignments = savedOrderConfig.assignments || [];
                  const savedFileRanges = [];
                  let cumulativeIndex = 0;
                  savedFiles.forEach((savedFile) => {
                    const count = savedFile.accountCount || 0;
                    savedFileRanges.push({ start: cumulativeIndex, count });
                    cumulativeIndex += count;
                  });
                  let newRowIndex = 0;
                  for (let importIdx = 0; importIdx < provisionalFileEntries.length; importIdx += 1) {
                    const savedIdx = fileMatchMap.get(importIdx);
                    if (savedIdx === undefined) continue;
                    const range = savedFileRanges[savedIdx];
                    if (!range) continue;
                    const slice = savedAssignments.slice(range.start, range.start + range.count);
                    slice.forEach((assignment) => {
                      reorderedAssignments.push({ ...assignment, rowIndex: newRowIndex });
                      newRowIndex += 1;
                    });
                  }
                }
                return { failedFileNames, reorderedAssignments };
              }
            );
            const { failedFileNames, reorderedAssignments } = autoMatchDecision;

            if (failedFileNames.length === 0 && reorderedAssignments.length > 0) {

              // 已保存顺序自动命中时只需本地上下文；仅真正进入人工选择时才持久化 opaque context。
              const pendingContext = createPendingBigAccountSelectionContext(prepared, {
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

              const autoResult = prepared.previewOnly
                ? null
                : await ipcMain.emit('__internal-complete-big-account-selection__') || null;
              if (!autoResult) {
                try {
                  const directResult = await (async () => {
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

                    if (prepared.previewOnly) return statementImportPreviewReady();

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
              stagePendingBigAccountSelection(prepared, {
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
                  fileName: normalizeCell(row.fileName)
                })),
                rowsWithEmptyBlocks: buildBigAccountSelectionRows(provisionalFileEntries, { includeEmptyBlocks: true }).map((row, index) => ({
                  index: Number.isInteger(row.index) ? row.index : index,
                  label: `${index + 1}.`,
                  sourceRowNumber: Number(row.sourceRowNumber || 0),
                  fileName: normalizeCell(row.fileName)
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

        stagePendingBigAccountSelection(prepared, {
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
        if (prepared.previewOnly && !selectionResult.parentProvisionalEntries) {
          selectionResult.parentProvisionalEntries = provisionalFileEntries;
        }
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
          stagePendingBigAccountSelection(prepared, {
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

      let selectedBigAccount = bigAccountOptions.length === 1
        ? {
            merchantId: bigAccountOptions[0].merchantId,
            currency: bigAccountOptions[0].currency
          }
        : null;

      if (selectedBigAccount) {
        const recognitionFileEntries = selectionResult.parentProvisionalEntries
          || buildPendingBigAccountFileEntries({
            template: templateConfig.template,
            mappings: templateConfig.exportMappings,
            orderedTargetFields: templateConfig.exportTargetFields,
            inputFilePaths: selectionResult.filePaths
          });
        if (prepared.previewOnly && !selectionResult.parentProvisionalEntries) {
          selectionResult.parentProvisionalEntries = recognitionFileEntries;
        }
        const recognitionResult = resolvePreparedDirectBigAccountRecognition({
          prepared,
          recognitionArgs: {
            fileEntries: recognitionFileEntries,
            maintainedBigAccounts: effectiveBigAccounts,
            fallbackTemplateConfig: templateConfig,
            templateName: templateConfig.template.name
          }
        });

        if (recognitionResult.status === 'failed') {
          return createBigAccountRecognitionErrorResult(recognitionResult, {
            templateId,
            templateName: templateConfig.template.name,
            inputFilePaths: selectionResult.filePaths
          });
        }

        if (recognitionResult.status === 'needs-selection') {
          const selectionRows = buildBigAccountSelectionRows(recognitionFileEntries);

          if (!selectionRows.length) {
            return createErrorResult({
              step: '导入网银明细文件',
              message: '导入文件中没有账号存在交易数据',
              errorCode: 'NO_TRANSACTION_DATA',
              templateName: templateConfig.template.name
            });
          }

          const selectionRowsWithEmpty = buildBigAccountSelectionRows(recognitionFileEntries, { includeEmptyBlocks: true });

          stagePendingBigAccountSelection(prepared, {
            templateId,
            template: templateConfig.template,
            mappings: templateConfig.exportMappings,
            orderedTargetFields: templateConfig.exportTargetFields,
            inputFilePaths: selectionResult.filePaths,
            bigAccounts: effectiveBigAccounts,
            fixedAssignments: templateConfig.fixedAssignments,
            fileEntries: recognitionFileEntries,
            rows: selectionRows,
            rowsWithEmptyBlocks: selectionRowsWithEmpty
          });
          return buildBigAccountSelectionRequiredResult({
            rows: selectionRows,
            rowsWithEmptyBlocks: selectionRowsWithEmpty,
            bigAccounts: effectiveBigAccounts,
            fixedAssignments: templateConfig.fixedAssignments,
            templateId
          });
        }

        if (recognitionResult.selectedBigAccount) {
          selectedBigAccount = recognitionResult.selectedBigAccount;
        }
      }

      if (prepared.previewOnly) return statementImportPreviewReady();

      let generatedFiles;
      if (selectionResult.parentProvisionalEntries) {
        const generationTemplateConfig = resolveGenerationTemplateConfig({
          fileEntries: selectionResult.parentProvisionalEntries,
          fallbackTemplateConfig: templateConfig
        });
        const rebuiltFileEntries = rebuildMatchedTemplateFileEntries({
          fileEntries: selectionResult.parentProvisionalEntries,
          fallbackTemplateConfig: templateConfig,
          selectedBigAccount,
          reuseMappedRows: true
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
      if (!prepared.previewOnly) {
        clearGeneratedExports();
        clearPendingManualBalancePrompt();
        clearPendingBigAccountSelection();
      }

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

      if (prepared.previewOnly) {
        return createPreflightErrorResult({
          message: '文件转换错误，请检查导入文件后重试',
          errorCode: 'FILE_IMPORT_RUNTIME'
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
    }
  };
  trackedIpcHandle(
    'file:import',
    '生成网银账单',
    '导入文件',
    fileImportHandler
  );

  ipcMain.handle('file:cancel-big-account-selection', (_event, contextId) => {
    if (!requirePendingBigAccountSelection(contextId)) {
      return { status: 'not-active' };
    }
    clearPendingBigAccountSelection(contextId);
    return { status: 'success' };
  });

  const completeBigAccountSelectionHandler = {
    prepare(_event, payload = {}) {
      const contextId = normalizeCell(payload.contextId);
      const pendingContext = requirePendingBigAccountSelection(contextId);
      if (!pendingContext) {
        return {
          proceed: false,
          result: createPreflightErrorResult({
            message: '当前没有待处理的大账号选择任务，请重新导入文件',
            errorCode: 'BIG_ACCOUNT_SELECTION_MISSING'
          })
        };
      }
      try {
        if (pendingContext.assertFresh) pendingContext.assertFresh();
        const normalized = normalizePendingBigAccountSelection(pendingContext, payload);
        return {
          proceed: true,
          args: [],
          inputPaths: pendingContext.inputFilePaths,
          contextId,
          pendingContext,
          ...normalized,
          rememberOrder: normalized.isFixedMode && typeof payload.rememberOrder === 'boolean'
            ? payload.rememberOrder
            : null,
          beforeStart() {
            const current = requirePendingBigAccountSelection(contextId);
            if (current !== pendingContext) {
              throw new Error('大账号选择上下文已失效，请重新导入文件');
            }
            if (pendingContext.assertFresh) pendingContext.assertFresh();
          }
        };
      } catch (error) {
        return {
          proceed: false,
          result: createPreflightErrorResult({
            message: error && error.message
              ? error.message
              : '大账号选择无效，请重新选择',
            errorCode: error && error.code
              ? error.code
              : 'BIG_ACCOUNT_SELECTION_INVALID'
          })
        };
      }
    },
    async execute(_event, prepared) {
    const pendingContext = requirePendingBigAccountSelection(prepared.contextId);
    if (!pendingContext) {
      return createErrorResult({
        step: '选择大账号',
        message: '当前没有待处理的大账号选择任务，请重新导入文件',
        errorCode: 'BIG_ACCOUNT_SELECTION_MISSING'
      });
    }
    clearPendingBigAccountSelection(prepared.contextId);
    const { isFixedMode, normalizedAssignments, rememberOrder } = prepared;
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
        return persistBigAccountOrderAfterGeneration({
          pendingContext,
          normalizedAssignments,
          rememberOrder,
          result: lastResult
        });
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
      updateStatementSessionCache(session, batchId, generatedFiles);
      const result = buildImportResultFromGeneratedFiles({
        generatedFiles,
        templateId: pendingContext.templateId,
        templateName: generationTemplateConfig.template.name,
        inputFilePaths: pendingContext.inputFilePaths
      });
      return persistBigAccountOrderAfterGeneration({
        pendingContext,
        normalizedAssignments,
        rememberOrder,
        result
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
    }
  };
  businessIpcHandle(
    'file:complete-big-account-selection',
    '生成账单',
    completeBigAccountSelectionHandler
  );


  ipcMain.handle('file:extract-big-account-order', (_event, payload = {}) => {
    const pendingContext = requirePendingBigAccountSelection(payload.contextId);
    const mode = payload?.mode || 'unfixed';
    const selectedServerRows = selectPendingBigAccountRows(
      pendingContext,
      mode,
      payload.rowIndexes
    );

    if (!pendingContext) {
      return { status: 'error', failedRows: [], message: '当前没有待处理的大账号选择任务，请重新导入文件' };
    }

    const allMerchantIds = (pendingContext.bigAccounts || []).map((ba) => normalizeCell(ba.merchantId)).filter((id) => id !== '');
    const defaultExpectedSourceHeaders = pendingContext.template?.headers || [];
    const expandedOptions = expandBigAccountConfigurations(pendingContext.bigAccounts || []);

    try {
      if (pendingContext.assertFresh) pendingContext.assertFresh();
    } catch (error) {
      return {
        status: 'error',
        failedRows: [],
        message: error && error.message ? error.message : '大账号选择预览已失效，请重新导入文件'
      };
    }

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

      if (selectedServerRows.length === 0) {
        return { status: 'error', failedRows: [], message: '请选择需要提取的大账号预览行' };
      }

      if (mode !== 'fixed') {
        // 不固定模式：前端只回传 rowIndex；主进程从 pending context 解析出源行信息。
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

        selectedServerRows.forEach((fr) => {
          const serverRowIndex = Number(fr.index);
          const cached = fileCache.get(fr.filePath || '') || fileCache.get(
            // fallback: 按 basename 匹配（兼容旧数据）
            [...fileCache.keys()].find((fp) => path.basename(fp) === fr.fileName) || ''
          );

          if (!cached) {
            failedRows.push({ index: serverRowIndex, fileName: fr.fileName || '' });
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
              failedRows.push({ index: serverRowIndex, fileName: fr.fileName || '' });
            }
          } else if (headerIdx < 0 && !cached.entry?.skipDirectMerchantLookup) {

            failedRows.push({ index: serverRowIndex, fileName: fr.fileName || '' });
          } else {

            failedRows.push({ index: serverRowIndex, fileName: fr.fileName || '' });
          }
        });
      } else {
        // 固定模式同样只处理 renderer 回传 rowIndex 命中的服务端 rowsWithEmptyBlocks。
        const requestedRowIndexes = new Set(
          selectedServerRows.map((row) => Number(row.index))
        );
        (pendingContext.fileEntries || []).forEach((entry) => {
          const fileName = path.basename(entry.filePath);
          const blockCount = identifyAccountBlocks(
            entry.detailRows,
            { includeEmptyBlocks: true }
          ).length;
          const firstServerRowIndex = globalIndex;
          globalIndex += blockCount;
          const hasRequestedRow = Array.from(
            { length: blockCount },
            (_unused, index) => firstServerRowIndex + index
          ).some((rowIndex) => requestedRowIndexes.has(rowIndex));
          if (!hasRequestedRow) return;
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

          for (let bi = 0; bi < blockCount; bi += 1) {
          const serverRowIndex = firstServerRowIndex + bi;
          if (!requestedRowIndexes.has(serverRowIndex)) continue;
          const identified = fileResult.accounts[bi];
          if (!identified) {
            failedRows.push({ index: serverRowIndex, fileName });
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
            failedRows.push({ index: serverRowIndex, fileName });
          }
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

  businessIpcHandle('file:save-balance-seed', '补录余额并生成账单', {
    async prepare(_event, payload = {}) {
      const pendingPrompt = lastManualBalancePrompt;
      const importContext = lastFileImportContext;
      try {
        const session = importContext && importContext.statementSessionKey
          ? statementImportSessions.get(importContext.statementSessionKey) || null
          : null;
        const resolution = prepareManualBalanceSeedSubmission({
          payload,
          confirmation: lastPendingBalanceSeedConfirmation,
          pendingPrompt,
          importContext,
          generatedExports: lastGeneratedExports,
          // prepare 只读：不通过 ensureStorageRoot 创建任何目录。
          storageRoot: getStorageRoot(),
          session,
          createContextId: randomUUID,
          createFreshnessGuard: createManualBalanceSeedFreshnessGuard
        });
        lastPendingBalanceSeedConfirmation = resolution.nextConfirmation;
        return resolution.prepared;
      } catch (error) {
        return {
          proceed: false,
          result: createPreflightErrorResult({
            message: error && error.message ? error.message : '余额补录准备失败',
            errorCode: error && error.code || 'BALANCE_SEED_PREPARE_FAILED',
            detailLines: Array.isArray(error && error.detailLines) ? error.detailLines : []
          })
        };
      }
    },

    async execute(_event, prepared) {
      const { plan, pendingPrompt, importContext, session } = prepared || {};
      if (!plan || !pendingPrompt || !importContext
          || (plan.existingIndex >= 0 && prepared.confirmedOverwrite !== true)) {
        throw new TypeError('余额补录 execute 缺少已确认的准备计划');
      }
      if (prepared.confirmedOverwrite === true) {
        // 真实 execute 入口只消费一次主进程确认上下文。
        lastPendingBalanceSeedConfirmation = null;
      }

      try {
        writeManualBalanceSeedPlan(plan);
        const seedTemplateName = plan.record.templateName;
        appendActivityLogEntry({
          level: 'info',
          message: '补录上一账单日余额成功',
          details: [
            `模板名：${seedTemplateName}`,
            `银行账号：${plan.record.merchantId}`,
            `币种：${plan.record.currency || '(空)'}`,
            `账单日期：${plan.record.billDate}`,
            `余额：${plan.record.endBalance}`,
            `生成方式：${BALANCE_SEED_GENERATION_METHODS.manual}`
          ]
        });

        // v1.5.2：虚拟 ID 下走多模板重新生成（避免用单组 importContext 产出不完整余额）
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
    }
  });

  const prepareStatementExport = async (kind, scope) => {
    let plan;
    try {
      plan = buildStatementExportPlan(kind, scope);
    } catch (error) {
      return {
        proceed: false,
        result: createPreflightErrorResult({
          message: error && error.message ? error.message : '导出准备失败',
          errorCode: error && error.code || 'EXPORT_PREPARE_FAILED'
        })
      };
    }
    if (plan.stopResult) return { proceed: false, result: plan.stopResult };
    const saveResult = await dialog.showSaveDialog(mainWindow, {
      defaultPath: plan.defaultFileName,
      filters: [{ name: 'Excel', extensions: ['xlsx'] }]
    });
    if (saveResult.canceled || !saveResult.filePath) {
      return { proceed: false, result: { status: 'cancelled' } };
    }
    return {
      proceed: true,
      outputPaths: [saveResult.filePath],
      kind,
      plan,
      savePath: saveResult.filePath,
      beforeStart() {
        const current = buildStatementExportPlan(kind, plan.normalizedScope);
        if (current.stopResult
            || current.session !== plan.session
            || current.generatedFile !== plan.generatedFile
            || current.needsGeneration !== plan.needsGeneration
            || current.defaultFileName !== plan.defaultFileName) {
          throw new Error('账单导出会话在保存确认期间已变化，请重新导出');
        }
      }
    };
  };

  trackedIpcHandle('file:export-detail', '生成网银账单', '导出明细', {
    prepare: (_event, scope = 'auto') => prepareStatementExport('detail', scope),
    execute: (_event, prepared) => exportStatementByScope(
      'detail',
      prepared.plan.normalizedScope,
      prepared.savePath
    )
  });

  trackedIpcHandle('file:export-balance', '生成网银账单', '导出余额', {
    prepare: (_event, scope = 'auto') => prepareStatementExport('balance', scope),
    execute: (_event, prepared) => exportStatementByScope(
      'balance',
      prepared.plan.normalizedScope,
      prepared.savePath
    )
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
  businessIpcHandle('monthly-balance:assemble', '装配月度余额', async (_event, payload = {}) => {
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
        templateIds: Array.from(new Set(
          assembled.records.map((record) => {
            const matched = assembled.templates.find((template) => template.name === record.templateName);
            return matched ? Number(matched.id) : 0;
          }).filter((templateId) => Number.isInteger(templateId) && templateId > 0)
        )),
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
  trackedIpcHandle('monthly-balance:export', '生成网银账单', '导出余额', {
    async prepare() {
      const pending = lastGeneratedExports.monthlyBalance;
      if (!pending || !pending.filePath) {
        return {
          proceed: false,
          result: {
            status: 'error',
            errorCode: 'MONTHLY_BALANCE_NO_PENDING',
            message: '尚未生成月度余额账单，请先在弹窗中选择模板和时间'
          }
        };
      }
      if (!fs.existsSync(pending.filePath)) {
        return {
          proceed: false,
          result: {
            status: 'error',
            errorCode: 'MONTHLY_BALANCE_FILE_MISSING',
            message: '临时文件已丢失，请重新生成月度余额账单'
          }
        };
      }
      const saveResult = await dialog.showSaveDialog(mainWindow, {
        defaultPath: pending.fileName,
        filters: [{ name: 'Excel', extensions: ['xlsx'] }]
      });
      if (saveResult.canceled || !saveResult.filePath) {
        return { proceed: false, result: { status: 'cancelled' } };
      }
      return {
        proceed: true,
        outputPaths: [saveResult.filePath],
        pending,
        savePath: saveResult.filePath,
        beforeStart() {
          if (lastGeneratedExports.monthlyBalance !== pending || !fs.existsSync(pending.filePath)) {
            throw new Error('月度余额待导出文件已变化，请重新选择导出位置');
          }
        }
      };
    },
    async execute(_event, prepared) {
    try {
      const { pending, savePath } = prepared;
      fs.copyFileSync(pending.filePath, savePath);
      appendActivityLogEntry({
        level: 'info',
        message: '月度余额账单导出成功',
        details: [
          `模板：${pending.templateLabel}`,
          `年月：${pending.year}-${String(pending.month).padStart(2, '0')}`,
          `导出路径：${savePath}`
        ]
      });

      return {
        status: 'success',
        filePath: savePath,
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

  trackedIpcHandle('new-account:export', '新开账户', '导出余额', {
    async prepare() {
      const generatedFile = lastGeneratedExports.newAccount;
      if (!generatedFile || !generatedFile.filePath || !fs.existsSync(generatedFile.filePath)) {
        return {
          proceed: false,
          result: createPreflightErrorResult({
            message: '暂无可导出的新开账户余额账单',
            errorCode: 'EXPORT_EMPTY'
          })
        };
      }
      const saveResult = await dialog.showSaveDialog(mainWindow, {
        defaultPath: generatedFile.fileName,
        filters: [{ name: 'Excel', extensions: ['xlsx'] }]
      });
      if (saveResult.canceled || !saveResult.filePath) {
        return { proceed: false, result: { status: 'cancelled' } };
      }
      return {
        proceed: true,
        outputPaths: [saveResult.filePath],
        generatedFile,
        savePath: saveResult.filePath,
        beforeStart() {
          if (lastGeneratedExports.newAccount !== generatedFile
              || !fs.existsSync(generatedFile.filePath)) {
            throw new Error('新开账户待导出文件已变化，请重新导出');
          }
        }
      };
    },
    execute(_event, prepared) {
      return exportGeneratedFile(
        prepared.generatedFile,
        '暂无可导出的新开账户余额账单',
        '导出新开账户余额账单',
        prepared.savePath
      );
    }
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
    const result = await showImportOpenDialog('pending-reconciliation', {
      title: '选择 Pending 数据文件',
      filters: [{ name: 'Excel', extensions: ['xlsx'] }],
      properties: ['openFile', 'multiSelections']
    });
    if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
      return { cancelled: true };
    }
    return { cancelled: false, files: result.filePaths };
  });

  trackedIpcHandle('pending:import:start', '月度 Pending', '导入文件', {
    async prepare(_event, payload = {}) {
      try {
        const resolution = preparePendingImportSubmission({
          payload,
          confirmation: lastPendingImportConfirmation,
          db: pendingDb,
          monthRepository: pendingMonthRepo,
          dbPath: path.join(app.getPath('userData'), PENDING_DB_FILENAME),
          createContextId: randomUUID,
          createFreshnessGuard: createPendingImportFreshnessGuard
        });
        lastPendingImportConfirmation = resolution.nextConfirmation;
        return resolution.prepared;
      } catch (error) {
        return {
          proceed: false,
          result: pendingImportError(
            error && error.message ? error.message : 'Pending 导入准备失败'
          )
        };
      }
    },

    async execute(event, prepared, taskContext) {
      if (prepared.overwriteConfirmed === true) {
        // 真实 execute 入口只消费一次主进程确认上下文。
        lastPendingImportConfirmation = null;
      }
      const webContents = event.sender;
      return executePendingImportSubmission({
        pendingSession,
        prepared,
        batchContext: taskContext.batchContext,
        onProgress: (ev) => {
          try { webContents.send('pending:import:progress', ev); } catch (_e) { /* swallow */ }
        }
      });
    }
  });

  businessIpcHandle('pending:error:export-report', '导出 Pending 错误报告', {
    async prepare() {
      if (!pendingSession.hasPendingErrorReport()) {
        return { proceed: false, result: { status: 'error', message: '无错误报告' } };
      }
      const result = await dialog.showSaveDialog({
        title: '保存 Pending 导入报错文件',
        defaultPath: `pending-import-errors-${Date.now()}.xlsx`,
        filters: [{ name: 'Excel', extensions: ['xlsx'] }]
      });
      if (result.canceled || !result.filePath) {
        return { proceed: false, result: { status: 'cancelled' } };
      }
      return {
        proceed: true,
        outputPaths: [result.filePath],
        savePath: result.filePath,
        beforeStart() {
          if (!pendingSession.hasPendingErrorReport()) {
            throw new Error('Pending 错误报告已变化，请重新导出');
          }
        }
      };
    },
    async execute(_event, prepared) {
    try {
      return pendingSession.exportErrorReport(prepared.savePath);
    } catch (err) {
      return { status: 'error', message: err && err.message ? err.message : String(err) };
    }
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

  trackedIpcHandle('pending:diff:export-single', '月度 Pending', '导出差异', {
    async prepare(_event, payload = {}) {
      if (!pendingDb) {
        return { proceed: false, result: { status: 'error', message: 'Pending DB 未初始化' } };
      }
      const runId = Number(payload.runId);
      if (!Number.isFinite(runId) || runId <= 0) {
        return { proceed: false, result: { status: 'error', message: 'runId 无效' } };
      }
      const saveResult = await dialog.showSaveDialog({
        title: '保存 Pending 差异文件',
        defaultPath: payload.defaultFileName || `月度Pending差异-run${runId}.xlsx`,
        filters: [{ name: 'Excel', extensions: ['xlsx'] }]
      });
      if (saveResult.canceled || !saveResult.filePath) {
        return { proceed: false, result: { status: 'cancelled' } };
      }
      return {
        proceed: true,
        outputPaths: [saveResult.filePath],
        runId,
        savePath: saveResult.filePath
      };
    },
    async execute(_event, prepared) {
    try {
      return pendingExportWriter.exportSingleRun(pendingDb, prepared.runId, prepared.savePath);
    } catch (err) {
      return { status: 'error', message: err && err.message ? err.message : String(err) };
    }
    }
  });

  trackedIpcHandle('pending:diff:export-aggregate', '月度 Pending', '导出差异', {
    async prepare() {
      if (!pendingDb) {
        return { proceed: false, result: { status: 'error', message: 'Pending DB 未初始化' } };
      }
      const saveResult = await dialog.showSaveDialog({
        title: '保存 Pending 差异汇总文件',
        defaultPath: `月度Pending差异-汇总-${new Date().toISOString().slice(0, 10)}.xlsx`,
        filters: [{ name: 'Excel', extensions: ['xlsx'] }]
      });
      if (saveResult.canceled || !saveResult.filePath) {
        return { proceed: false, result: { status: 'cancelled' } };
      }
      return {
        proceed: true,
        outputPaths: [saveResult.filePath],
        savePath: saveResult.filePath
      };
    },
    async execute(_event, prepared) {
    try {
      return pendingExportWriter.exportAggregate(pendingDb, prepared.savePath);
    } catch (err) {
      return { status: 'error', message: err && err.message ? err.message : String(err) };
    }
    }
  });

  // ============================================================
  // v2.1.11 T2 移除核对：移除归档 Pending 文件 — pending:removed:* IPC handler
  //   流程（spec §3.3 / D-T2-1）：导入某月数据成功 → renderer 弹"是否核对移除pending数据？"
  //     → 是 → pickFiles → import（解析 + 入库 removed_pending_rows，关联导入月份 = 后续对账 upperMonth）
  //   匹配在对账后自动触发（见 pending:reconcile:run handler 末尾，D-T2-2）。
  // ============================================================

  ipcMain.handle('pending:removed:pick-files', async () => {
    const result = await showImportOpenDialog('pending-reconciliation', {
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

  // v3.0.5 PR-4：双源 listMonths（侧库目录 month + 主库旧表 month 合并；历史 run 零变化）
  ipcMain.handle('bankBuRecon:months:list', () => {
    if (!database || !database.db) return [];
    try {
      return bankBuReconRunData.listMonthsDualSource({ userDataDir: path.dirname(database.dbPath), mainDb: database.db });
    } catch (_e) { return []; }
  });

  // v3.0.5 PR-4：双源 status（侧库存在 → 读侧库 meta + 主库镜像 latestRun；否则读主库旧表）
  ipcMain.handle('bankBuRecon:status', (_event, payload = {}) => {
    if (!database || !database.db) return null;
    const { yearMonth } = payload || {};
    if (!yearMonth) return null;
    try {
      return bankBuReconRunData.getStatusDualSource({
        userDataDir: path.dirname(database.dbPath),
        mainDb: database.db,
        yearMonth
      });
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
    const res = await showImportOpenDialog('bank-bu-recon', {
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
    const res = await showImportOpenDialog('bank-bu-recon', {
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
      // v3.0.5 PR-4：导入落 per-月侧库（importMonthAtomic 在侧库 db 上运行 = 主库上运行，原子覆盖语义不变）
      const counts = bankBuReconRunData.importMonth({
        userDataDir: path.dirname(database.dbPath),
        yearMonth,
        pendingRows: pendingResult.rows,
        bankRows: bankResult.rows
      });
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
      // v3.0.5 PR-4：inline 侧库直跑（runReconciliation 在侧库 db 上跑，算法零改动）+ 主库 runs 镜像。
      const result = bankBuReconRunData.runViaSideDb({
        userDataDir: path.dirname(database.dbPath),
        mainDb: database.db,
        yearMonth
      });
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
    // v3.0.5 PR-4：run 校验 + 导出数据均走主库镜像 + 侧库重跑（lastRunCache 侧库化失效 → 重跑路径）。
    const userDataDir = path.dirname(database.dbPath);
    const run = bankBuReconRunData.getMirrorRun({ mainDb: database.db, runId: runIdNum });
    if (!run) return { status: 'error', message: '运行记录不存在' };
    if (run.status !== 'success') {
      return { status: 'error', message: '运行未成功（status=' + run.status + '），无法导出差异表' };
    }
    try {
      const lastResult = bankBuReconRunData.loadExportDataByRun({ userDataDir, mainDb: database.db, runId: runIdNum });
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
      bankBuReconRunData.recordExportPath({ mainDb: database.db, runId: runIdNum, exportPath: exp.filePath });
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
      // v3.0.5 PR-4：跨月汇总逐月 open 侧库重跑（侧库 + 历史主库 run 双源）。
      const { months, skippedMonths } = bankBuReconRunData.aggregateExportData({
        userDataDir: path.dirname(database.dbPath),
        mainDb: database.db
      });
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

  // v3.0.5 PR-4：run:history 走主库镜像（侧库 run 镜像 + 历史主库 run 都在主库 runs 表）。
  ipcMain.handle('bankBuRecon:run:history', (_event, payload = {}) => {
    if (!database || !database.db) return [];
    const { yearMonth } = payload || {};
    if (!yearMonth) return [];
    try { return bankBuReconRunData.listRunsDualSource({ mainDb: database.db, yearMonth }); } catch (_e) { return []; }
  });

  // v0.5: 列出"两侧都已导入"的月份（用于「开始运行」弹窗）
  // v3.0.5 PR-4：双源（侧库目录 + 主库旧表）。
  ipcMain.handle('bankBuRecon:run:list-ready-months', () => {
    if (!database || !database.db) return [];
    try {
      return bankBuReconRunData.listReadyMonthsDualSource({ userDataDir: path.dirname(database.dbPath), mainDb: database.db });
    } catch (_e) {
      return [];
    }
  });

  // v0.5: 列出"有 status=success run"的月份（用于「导出差异」弹窗）
  // v3.0.5 PR-4：主库镜像 GROUP BY（侧库 run 镜像 + 历史主库 run）。
  ipcMain.handle('bankBuRecon:run:list-success-months', () => {
    if (!database || !database.db) return [];
    try { return bankBuReconRunData.listSuccessMonthsDualSource({ mainDb: database.db }); } catch (_e) { return []; }
  });

  // ==========================================================================
  // v2.1.3：业务OP数据核对 IPC handlers（spec §三 共 17 个）
  // 命名空间 bizOpRecon:*；与 bankBuRecon:* 完全独立
  // ==========================================================================

  // 模块状态查询
  // v3.0.5 PR-4：双源（遍历侧库目录所有月 + 主库旧表，去重月末冗余副本）。
  ipcMain.handle('bizOpRecon:status', () => {
    if (!database || !database.db) return { importedDateBuPairs: [], buList: [], flowImportedDates: [] };
    try {
      return bizOpReconRunData.getStatusDualSource({ userDataDir: path.dirname(database.dbPath), mainDb: database.db });
    } catch (_e) {
      return { importedDateBuPairs: [], buList: [], flowImportedDates: [] };
    }
  });

  // BU 下拉框枚举（保留原值不 normalize；#A 拍板）
  // v3.0.5 PR-4：双源去重。
  ipcMain.handle('bizOpRecon:bu:list', () => {
    if (!database || !database.db) return [];
    try {
      return bizOpReconRunData.listBuDualSource({ userDataDir: path.dirname(database.dbPath), mainDb: database.db });
    } catch (_e) {
      return [];
    }
  });

  // 业务OP 文件选择（弹原生文件对话框）
  ipcMain.handle('bizOpRecon:import:pick-biz-op-file', async (_event, payload = {}) => {
    const { date } = payload || {};
    try {
      const result = await showImportOpenDialog('biz-op-recon', {
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
  // v3.0.2 需求1b：支持批量多选（multiSelections），返回 filePaths 数组（全部合并导入到同一日期）。
  //   ⚠️ pick-biz-op-file 不动（业务OP 仍单文件）。
  ipcMain.handle('bizOpRecon:import:pick-flow-file', async (_event, payload = {}) => {
    const { date } = payload || {};
    try {
      const result = await showImportOpenDialog('biz-op-recon', {
        title: `选择流水对账单 文件（日期 ${date || ''}，可多选）`,
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: 'Excel', extensions: ['xlsx'] }]
      });
      if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
        return { status: 'cancelled' };
      }
      // 返回 filePaths 数组（前端按数组处理）；保留 filePath=首个以兼容潜在旧调用。
      return { status: 'ok', filePaths: result.filePaths, filePath: result.filePaths[0] };
    } catch (err) {
      return { status: 'error', message: err && err.message ? err.message : String(err) };
    }
  });

  // 业务OP 导入（#1 双重校验 + #4 替换原子事务 + #5 整批拒绝 + #15 清空旧 runs）
  // PR #45 round 3 P2：trackedIpcHandle 接入；仅 status='success' 计数（rejected/error 不计，spec D6）
  trackedIpcHandle('bizOpRecon:import:run-biz-op', '业务OP数据核对', '导入文件', {
    async execute(event, _prepared, taskContext, payload = {}) {
    if (!database || !database.db) return { status: 'error', message: '数据库未就绪' };
    const { date, filePath } = payload || {};
    if (!date || !filePath) return { status: 'error', message: '入参缺失（date / filePath）' };
    try {
      const errorReportsDir = path.join(ensureStorageRoot(), 'error-reports');
      // v3.0.5 PR-4：导入落 per-月侧库（编排层把 worker dbPath 覆盖为 month(date) 侧库路径；
      //   worker 自开侧库连接 + 幂等建表；月末跨月由编排层补清下月侧库 + 写 T-2 冗余副本，详见 biz-op-recon-run-data.js）。
      //   进度透传 renderer（仿 pending:import:progress 范式，swallow send 失败）。
      const result = await bizOpReconRunData.runBizOpImport({
        userDataDir: path.dirname(database.dbPath),
        runBizOpImportViaWorker: runBizOpImport,
        params: {
          date,
          filePath,
          readBizOpFile,
          writeBizOpErrorReportXlsx,
          errorReportsDir,
          batchContext: taskContext.batchContext,
          onProgress: (ev) => {
            try { event.sender.send('bizOpRecon:import:progress', { ...ev, kind: 'bizOp' }); }
            catch (_e) { /* swallow */ }
          }
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
    }
  });

  // 流水对账单 导入（#3 出入方向枚举 + #5 整批拒绝）
  // PR #45 round 3 P2：trackedIpcHandle 接入；仅 status='success' 计数
  trackedIpcHandle('bizOpRecon:import:run-flow', '业务OP数据核对', '导入文件', {
    async execute(event, _prepared, taskContext, payload = {}) {
    if (!database || !database.db) return { status: 'error', message: '数据库未就绪' };
    // v3.0.2 需求1b：接收 filePaths 数组（多文件合并到同一日期）。
    //   兼容旧入参 filePath（单数）→ 归一为 [filePath]。校验：date 必填 + 至少一个文件。
    const { date, filePaths, filePath } = payload || {};
    const files = Array.isArray(filePaths) && filePaths.length > 0
      ? filePaths
      : (filePath ? [filePath] : []);
    if (!date || files.length === 0) return { status: 'error', message: '入参缺失（date / filePaths）' };
    try {
      const errorReportsDir = path.join(ensureStorageRoot(), 'error-reports');
      // v3.0.5 PR-4：导入落 per-月侧库（编排层把 worker dbPath 覆盖为 month(date) 侧库路径）。
      //   flow 按 date 清（不跨 BU 不跨日）→ 无跨月问题（flow 落 month(date) 侧库，与对账 date 同库）。
      // v3.0.2 需求1b：filePaths 透传 worker（单进程单事务合并、单次 clearByDate，禁止循环调用 runFlowImport）
      const result = await bizOpReconRunData.runFlowImport({
        userDataDir: path.dirname(database.dbPath),
        runFlowImportViaWorker: runFlowImport,
        params: {
          date,
          filePaths: files,
          readFlowFile,
          writeFlowErrorReportXlsx,
          errorReportsDir,
          batchContext: taskContext.batchContext,
          onProgress: (ev) => {
            try { event.sender.send('bizOpRecon:import:progress', { ...ev, kind: 'flow' }); }
            catch (_e) { /* swallow */ }
          }
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
  // v3.0.5 PR-4：双源（遍历侧库所有月 + 主库旧表所有 date，去重）。
  ipcMain.handle('bizOpRecon:import:check-single-day', (_event, payload = {}) => {
    if (!database || !database.db) return { onlyOneDay: false, count: 0 };
    const { buName } = payload || {};
    if (!buName) return { onlyOneDay: false, count: 0 };
    try {
      return bizOpReconRunData.checkSingleDayDualSource({ userDataDir: path.dirname(database.dbPath), mainDb: database.db, buName });
    } catch (_e) {
      return { onlyOneDay: false, count: 0 };
    }
  });

  // 列 ready 日期（#12 + #13 拍板 A）
  // v3.0.5 PR-4：双源（逐月侧库各跑 listReadyDates，每库 T-1/T-2 含月末冗余副本自洽，合并）。
  ipcMain.handle('bizOpRecon:run:list-ready-dates', (_event, payload = {}) => {
    if (!database || !database.db) return [];
    const { buName } = payload || {};
    if (!buName) return [];
    try {
      return bizOpReconRunData.listReadyDatesDualSource({ userDataDir: path.dirname(database.dbPath), mainDb: database.db, buName });
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
      // v3.0.5 PR-4：inline 侧库直跑（runReconciliation 在 month(date) 侧库 db 上跑，算法零改动；
      //   月初 T-2 由月末导入写入的冗余副本保证在库 → 单库自洽）+ 主库 runs 镜像。
      const { runId, stats } = bizOpReconRunData.runViaSideDb({
        userDataDir: path.dirname(database.dbPath),
        mainDb: database.db,
        date,
        buName
      });
      return { runId, status: 'success', stats };
    } catch (err) {
      return { status: 'error', message: err && err.message ? err.message : String(err) };
    }
  });

  // 列 success 日期（#13 拍板 A，导出指定日期下拉来源）
  // v3.0.5 PR-4：主库镜像（侧库 run 镜像 + 历史主库 run 都在主库 runs 表）。
  ipcMain.handle('bizOpRecon:export:list-success-dates', (_event, payload = {}) => {
    if (!database || !database.db) return [];
    const { buName } = payload || {};
    if (!buName) return [];
    try {
      return bizOpReconRunData.listSuccessDatesDualSource({ mainDb: database.db, buName });
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
    // v3.0.5 PR-4：导出走侧库——主库镜像拿 (date,BU)+side_db_rel_path → open 该月侧库给 writer
    //   （writer 读 diff_rows + getRowById(imports) 全在侧库；月初跨月 T-2 行由冗余副本在库 → byte-for-byte）。
    const userDataDir = path.dirname(database.dbPath);
    const ctx = bizOpReconRunData.openExportContextByRun({ userDataDir, mainDb: database.db, runId });
    if (!ctx || !ctx.run) return { status: 'error', message: `run #${runId} 不存在` };
    try {
      const result = await writeBizOpSingleDateDiffWorkbook({
        db: ctx.db,
        date: ctx.run.data_date,
        buName: ctx.run.bu_name,
        // v3.0.5 PR-4：writer getDiffRowsByRun 用侧库内 run id（ctx.exportRunId），非主库镜像 id。
        runId: ctx.exportRunId,
        savePath
      });
      bizOpReconRunData.recordExportPath({ mainDb: database.db, runId, exportPath: result.filePath });
      return { status: 'success', filePath: result.filePath, rowCount: result.rowCount };
    } catch (err) {
      return { status: 'error', message: err && err.message ? err.message : String(err) };
    } finally {
      if (ctx && ctx.sideDb) { try { ctx.sideDb.close(); } catch (_e) { /* swallow */ } }
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
    // v3.0.5 PR-4：区间导出跨多日多月——构造临时内存合并 db（把区间内 success run 的 runs/diff_rows/imports
    //   从各月侧库 + 主库历史合并进内存 db，保 id/source_row_id 映射），writer 在合并 db 上跑（writer 零改动）。
    let memDb = null;
    try {
      memDb = bizOpReconRunData.buildRangeExportDb({
        userDataDir: path.dirname(database.dbPath),
        mainDb: database.db,
        buName, startDate, endDate
      });
      const result = await writeBizOpDateRangeDiffWorkbook({
        db: memDb,
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
    } finally {
      if (memDb) { try { memDb.close(); } catch (_e) { /* swallow */ } }
    }
  });

  // 运行历史（debug 用，可选）
  // v3.0.5 PR-4：主库镜像（侧库 run 镜像 + 历史主库 run 都在主库 runs 表）。
  ipcMain.handle('bizOpRecon:run:history', (_event, payload = {}) => {
    if (!database || !database.db) return [];
    const { date, buName } = payload || {};
    if (!date || !buName) return [];
    try {
      return bizOpReconRunData.listRunsDualSource({ mainDb: database.db, date, buName });
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
    const res = await showImportOpenDialog('vcc-op-calc', {
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

  // ==========================================================================
  // v3.1.6：VCC财务OP校验 — vccFinancialOp:* IPC
  // 四类明细和系统OP使用独立表空间；导入/计算在 worker 中执行，归档在主库事务中执行。
  // ==========================================================================

  ipcMain.handle('vccFinancialOp:import:pick-files', async () => {
    const choice = await showImportOpenDialog('vcc-financial-op', {
      title: '选择 VCC 财务OP校验原表（可多选）',
      filters: [{ name: 'Excel', extensions: ['xlsx'] }],
      properties: ['openFile', 'multiSelections']
    });
    if (choice.canceled || !choice.filePaths || choice.filePaths.length === 0) {
      return { status: 'cancelled' };
    }
    try {
      const files = await getVccFinancialOpService().inspectSelectedFiles(choice.filePaths);
      return { status: 'success', files };
    } catch (error) {
      return {
        status: 'error',
        message: error && error.message ? error.message : String(error),
        detailLines: error && Array.isArray(error.detailLines) ? error.detailLines : []
      };
    }
  });

  trackedIpcHandle('vccFinancialOp:import:apply', 'VCC财务OP校验', '导入文件', async (event, payload = {}) => {
    try {
      const result = await getVccFinancialOpService().importSelectedFiles(payload, (progress) => {
        if (event && event.sender && !event.sender.isDestroyed()) {
          event.sender.send('vccFinancialOp:import:progress', progress);
        }
      });
      return { status: 'success', ...result };
    } catch (error) {
      return {
        status: 'error',
        message: error && error.message ? error.message : String(error),
        detailLines: error && Array.isArray(error.detailLines) ? error.detailLines : []
      };
    }
  });

  ipcMain.handle('vccFinancialOp:task:cancel', async () => {
    try {
      return await getVccFinancialOpService().cancelActiveTask();
    } catch (error) {
      return { status: 'error', message: error && error.message ? error.message : String(error) };
    }
  });

  ipcMain.handle('vccFinancialOp:run:preflight', (_event, payload = {}) => {
    try {
      return getVccFinancialOpService().preflightRun(payload);
    } catch (error) {
      return { status: 'error', message: error && error.message ? error.message : String(error) };
    }
  });

  trackedIpcHandle('vccFinancialOp:run:calculate', 'VCC财务OP校验', '开始运行', async (_event, payload = {}) => {
    try {
      return await getVccFinancialOpService().calculate(payload);
    } catch (error) {
      return vccFinancialOpErrorResult(error);
    }
  });

  trackedIpcHandle('vccFinancialOp:opening:initialize', 'VCC财务OP校验', '初始化期初财务OP', async (_event, payload = {}) => {
    try {
      return await getVccFinancialOpService().initializeOpening(payload);
    } catch (error) {
      return vccFinancialOpErrorResult(error);
    }
  });

  trackedIpcHandle('vccFinancialOp:run:archive', 'VCC财务OP校验', '确认归档', async (_event, payload = {}) => {
    try {
      return await getVccFinancialOpService().archive(payload);
    } catch (error) {
      return vccFinancialOpErrorResult(error);
    }
  });

  ipcMain.handle('vccFinancialOp:run:adjustment-options', (_event, payload = {}) => {
    try {
      const result = getVccFinancialOpService().listAdjustmentOptions(payload);
      return { ...result, runStatus: result.status, status: 'success' };
    } catch (error) {
      return vccFinancialOpErrorResult(error);
    }
  });

  trackedIpcHandle('vccFinancialOp:run:adjustment-add', 'VCC财务OP校验', '修改结果', async (_event, payload = {}) => {
    try {
      const result = await getVccFinancialOpService().addRunAdjustment(payload);
      return { ...result, operationStatus: result.status, status: 'success' };
    } catch (error) {
      return vccFinancialOpErrorResult(error);
    }
  });

  ipcMain.handle('vccFinancialOp:run:archived-months', () => {
    try {
      return {
        status: 'success',
        months: getVccFinancialOpService().listArchivedResultMonths()
      };
    } catch (error) {
      return vccFinancialOpErrorResult(error);
    }
  });

  ipcMain.handle('vccFinancialOp:run:unarchive-preview', (_event, payload = {}) => {
    try {
      return {
        status: 'success',
        ...getVccFinancialOpService().previewUnarchive(payload)
      };
    } catch (error) {
      return vccFinancialOpErrorResult(error);
    }
  });

  trackedIpcHandle('vccFinancialOp:run:unarchive', 'VCC财务OP校验', '解归档', async (_event, payload = {}) => {
    try {
      const result = await getVccFinancialOpService().unarchiveMonth(payload);
      return { ...result, operationStatus: result.status, status: 'success' };
    } catch (error) {
      return vccFinancialOpErrorResult(error);
    }
  });

  ipcMain.handle('vccFinancialOp:imports:list-months', () => {
    return getVccFinancialOpService().listImportMonths();
  });

  ipcMain.handle('vccFinancialOp:imports:list-records', (_event, payload = {}) => {
    return getVccFinancialOpService().listImportRecords(payload.yearMonth);
  });

  ipcMain.handle('vccFinancialOp:imports:get-detail', (_event, payload = {}) => {
    try {
      return { status: 'success', ...getVccFinancialOpService().getImportRecordDetail(payload) };
    } catch (error) {
      return { status: 'error', message: error && error.message ? error.message : String(error) };
    }
  });

  trackedIpcHandle('vccFinancialOp:imports:resolve', 'VCC财务OP校验', '标记导入异常已处理', async (_event, payload = {}) => {
    try {
      return { status: 'success', record: await getVccFinancialOpService().resolveRecord(payload) };
    } catch (error) {
      return { status: 'error', message: error && error.message ? error.message : String(error) };
    }
  });

  ipcMain.handle('vccFinancialOp:data-manager:overview', (_event, payload = {}) => {
    try {
      return { status: 'success', ...getVccFinancialOpService().dataManagerOverview(payload.yearMonth) };
    } catch (error) {
      return { status: 'error', message: error && error.message ? error.message : String(error) };
    }
  });

  ipcMain.handle('vccFinancialOp:data-manager:delete-targets', (_event, payload = {}) => {
    try {
      return {
        status: 'success',
        targets: getVccFinancialOpService().listDeleteTargets(payload)
      };
    } catch (error) {
      return vccFinancialOpErrorResult(error);
    }
  });

  ipcMain.handle('vccFinancialOp:data-manager:delete-preview', (_event, payload = {}) => {
    try {
      return {
        status: 'success',
        ...getVccFinancialOpService().previewDataTargetDeletion(payload)
      };
    } catch (error) {
      return vccFinancialOpErrorResult(error);
    }
  });

  dynamicTrackedIpcHandle(
    'vccFinancialOp:data-manager:delete',
    'VCC财务OP校验',
    '删除数据',
    (_result, _event, payload = {}) => (
      (payload.targetType || payload.sourceType) === 'result' ? '删除结果' : '删除数据'
    ),
    async (_event, payload = {}) => {
    try {
      const service = getVccFinancialOpService();
      const result = await service.deleteDataTarget(payload);
      return {
        ...result,
        targetType: result.targetType || payload.targetType || payload.sourceType,
        operationStatus: result.status || 'deleted',
        status: 'success'
      };
    } catch (error) {
      return vccFinancialOpErrorResult(error);
    }
  });

  ipcMain.handle('vccFinancialOp:data-manager:export-preview', (_event, payload = {}) => {
    try {
      return {
        status: 'success',
        ...getVccFinancialOpService().previewDatasetExport(payload)
      };
    } catch (error) {
      return { status: 'error', message: error && error.message ? error.message : String(error) };
    }
  });

  trackedIpcHandle('vccFinancialOp:data-manager:export', 'VCC财务OP校验', '导出数据', async (_event, payload = {}) => {
    try {
      const service = getVccFinancialOpService();
      const inspection = service.previewDatasetExport(payload);
      if (!inspection.exportable) {
        return { status: 'error', message: inspection.message || '当前选择没有可导出的有效数据' };
      }
      const choice = await dialog.showSaveDialog(mainWindow, {
        title: '导出 VCC 财务OP数据',
        defaultPath: path.join(
          app.getPath('documents'),
          `${inspection.targetMonth}_${sanitizeFileName(inspection.tableName) || 'VCC财务OP数据'}.xlsx`
        ),
        filters: [{ name: 'Excel', extensions: ['xlsx'] }]
      });
      if (choice.canceled || !choice.filePath) return { status: 'cancelled' };
      const result = await service.exportDatasetData({
        ...payload,
        outputPath: choice.filePath
      });
      return { status: 'success', ...result };
    } catch (error) {
      return { status: 'error', message: error && error.message ? error.message : String(error) };
    }
  });

  ipcMain.handle('vccFinancialOp:run:get', (_event, payload = {}) => {
    try {
      const result = getVccFinancialOpService().getRunResult(payload.runId);
      return result
        ? { ...result, runStatus: result.status, status: 'success' }
        : { status: 'error', message: '校验结果不存在' };
    } catch (error) {
      return { status: 'error', message: error && error.message ? error.message : String(error) };
    }
  });

  ipcMain.handle('vccFinancialOp:run:latest-archived', () => {
    try {
      const result = getVccFinancialOpService().latestArchivedRun();
      return result
        ? { ...result, runStatus: result.status, status: 'success' }
        : { status: 'empty' };
    } catch (error) {
      return { status: 'error', message: error && error.message ? error.message : String(error) };
    }
  });

  trackedIpcHandle('vccFinancialOp:export:result', 'VCC财务OP校验', '导出校验结果表', async (_event, payload = {}) => {
    try {
      const service = getVccFinancialOpService();
      const target = service.getArchivedRunByMonth(payload.targetMonth);
      const subjects = target.subjects;
      if (subjects.length === 1) {
        const choice = await dialog.showSaveDialog(mainWindow, {
          title: '导出 VCC 财务OP校验结果表',
          defaultPath: path.join(
            app.getPath('documents'),
            `${target.targetMonth}_${sanitizeFileName(subjects[0]) || '未命名主体'}_VCC财务OP校验结果表.xlsx`
          ),
          filters: [{ name: 'Excel', extensions: ['xlsx'] }]
        });
        if (choice.canceled || !choice.filePath) return { status: 'cancelled' };
        const result = await service.exportRun({
          targetMonth: target.targetMonth,
          outputPath: choice.filePath
        });
        return { status: 'success', ...result };
      }
      const choice = await showImportOpenDialog('vcc-financial-op-export-directory', {
        title: '选择各主体校验结果表保存目录',
        properties: ['openDirectory', 'createDirectory']
      });
      if (choice.canceled || !choice.filePaths || choice.filePaths.length === 0) {
        return { status: 'cancelled' };
      }
      const result = await service.exportRun({
        targetMonth: target.targetMonth,
        outputDirectory: choice.filePaths[0]
      });
      return { status: 'success', ...result };
    } catch (error) {
      return vccFinancialOpErrorResult(error);
    }
  });

  trackedIpcHandle('vccFinancialOp:export:import-audit', 'VCC财务OP校验', '导出导入审计', async (_event, payload = {}) => {
    try {
      const choice = await dialog.showSaveDialog(mainWindow, {
        title: '导出校验原表导入审计',
        defaultPath: path.join(
          app.getPath('documents'),
          `VCC财务OP导入审计_${payload.recordId || ''}.xlsx`
        ),
        filters: [{ name: 'Excel', extensions: ['xlsx'] }]
      });
      if (choice.canceled || !choice.filePath) return { status: 'cancelled' };
      const result = await getVccFinancialOpService().exportImportAudit({
        ...payload,
        outputPath: choice.filePath
      });
      return { status: 'success', ...result };
    } catch (error) {
      return { status: 'error', message: error && error.message ? error.message : String(error) };
    }
  });

  // ==========================================================================
  // v2.1.16 阶段一 A4：链接表管理 — linked-table:* IPC handlers（2 个）
  //   list   ：只读，返回 4 个 tableKey 的元数据（前端弹窗渲染 4 行）
  //   import ：多选 Excel → 逐文件识别（仅 scope='linked' 候选）→ 命中且支持 → 读行落库
  //            ⚠️ 数据红线：gateway-bill 走按 ReconBillBizId 幂等累加 upsert（重导不清空、相同 bizId 覆盖、空 bizId 拒入，v3.0.1）；
  //              其余 3 张表整表覆盖写入（replaceLinkedTable 内 DELETE+INSERT 事务，一张表重导 = 旧数据全删）。
  //            不整批回滚：不同表互不影响，逐文件汇总 results（成功/失败 + 原因）。
  // ==========================================================================

  // A2 detector tableKey → A3 repository tableKey 映射（两层各自独立命名，桥接对齐）。
  //   detector: gateway-recon / zhongtai-dispatch-order / fx-delivery / fx-option / bank-deposit
  //   repo    : gateway-bill  / mid-allocation          / fx-settlement / fx-option / bank-deposit
  const LINKED_DETECTOR_TO_REPO_KEY = {
    'gateway-recon': 'gateway-bill',
    'zhongtai-dispatch-order': 'mid-allocation',
    'fx-delivery': 'fx-settlement',
    'fx-option': 'fx-option',
    // v2.1.16-beta.3 ②：入金表 detector 与 repo 同名
    'bank-deposit': 'bank-deposit'
  };

  // 按 detector tableKey 取对应 linked 签名（拿 expectedHeaders 做列映射）。
  //   v2.1.16-beta.3 ②：用 LINKED_IMPORT_SIGNATURES（含入金表签名），否则查不到 bank-deposit 签名走兜底。
  function getLinkedSignatureByKey(detectorTableKey) {
    return LINKED_IMPORT_SIGNATURES.find((s) => s.tableKey === detectorTableKey) || null;
  }

  // v3.0.0 块 B / O-6：detector read-error 文案细分。历史一律「文件为空或不可读」，
  //   对「明明文件不空（仅大文件读取阶段失败）」是误导（spec O-6 缘起）。据 detector 透出的 reason 区分：
  //     'empty'      → 文件可读但无任何有意义行 = 真·空表/无数据。
  //     'unreadable' → 文件不存在 / 类型不符 / 损坏 / 无法解析（listSheetNames 阶段失败）。
  //     'read-failed'→ 读取阶段抛异常（非空文件）；带回原始原因。
  //   detected 为 detectTableType 的返回对象（含可选 reason / message）。
  function formatDetectorReadErrorMessage(detected) {
    const reason = detected && detected.reason;
    const detail = detected && detected.message ? `（${detected.message}）` : '';
    if (reason === 'empty') {
      return '文件无有效数据（表头/内容为空），请确认文件是否选错或内容是否完整';
    }
    if (reason === 'read-failed') {
      return `文件读取失败，请确认文件是否完整、未被占用后重试${detail}`;
    }
    // 'unreadable' 及未知/缺省：文件不存在 / 格式不符 / 损坏。
    return `文件无法读取，可能已损坏、格式不符或文件不存在，请确认后重新选择${detail}`;
  }

  // 把单个 linked 文件读成 { 表头名: 值 } 对象数组（喂 replaceLinkedTable）。
  //   做法（对三张表统一）：
  //     1) readRowsWithMetadata(fp, []) 取全部有意义行（数组；中间空列保留、尾部空列已 trim）；
  //     2) 用 signature.expectedHeaders 做「整段位置全等」定位表头行 + 起始列偏移
  //        （交割表首行是标题、表头在第 2 行；expectedHeaders 含中间空列 '' 与物理行位置精确对齐）；
  //     3) 表头行之后逐行 zip：obj[expectedHeaders[i]] = normalizeCell(row[colOffset+i])，
  //        跳过空表头名（交割表 idx 9 的 '' 占位列不入对象）；数据行尾部被 trim 时缺失列回退 ''。
  // v2.1.16-beta.3 Codex#1：加 sheetName 参数 —— 用 detector 命中的那个 sheet 读表头/数据
  //   （封面/说明 sheet 在前、数据 sheet 在后时，数据 sheet 非首个）；sheetName=null/undefined 时
  //   readRowsWithMetadata 缺省读首个 sheet，其它链接表行为零回归。
  // v3.0.4 块 E 需求2：拆出 WithMeta 变体，同时返回 objects 与对齐的物理行号 rowNumbers（供 BOC 分组扫描）。
  //   既有 readLinkedRowsAsObjects 退化为只取 objects 的薄封装 → 所有旧调用方零行为变化。
  //   🔴 rowNumbers[i] = objects[i] 所在的原文件物理行号（1-based）；空行被 readRowsWithMetadata 过滤造成的
  //      行号断档（前后差 > 1）是 BOC 分组分隔符的唯一可还原依据（流式路径不透传行号，见 §2.5）。
  function readLinkedRowsAsObjectsWithMeta(filePath, signature, sheetName = null) {
    const expected = Array.isArray(signature.expectedHeaders) ? signature.expectedHeaders : [];
    if (expected.length === 0) {
      return { objects: [], rowNumbers: [] };
    }
    const result = linkedTableReaders.readRowsWithMetadata(filePath, [], { sheetName });
    const rows = Array.isArray(result.rows) ? result.rows : [];
    // rowNumbers 与 rows 同下标对齐（readRowsWithMetadata 过滤全空行后 map 物理行号），缺失则退化为下标+1。
    const allRowNumbers = Array.isArray(result.rowNumbers) ? result.rowNumbers : [];

    // 定位表头行 + 起始列偏移（首个「连续位置全等 expectedHeaders」的行）
    let headerRowIdx = -1;
    let colOffset = -1;
    for (let ri = 0; ri < rows.length && headerRowIdx < 0; ri += 1) {
      const row = Array.isArray(rows[ri]) ? rows[ri] : [];
      const maxStart = row.length - expected.length;
      for (let cs = 0; cs <= maxStart; cs += 1) {
        let matched = true;
        for (let i = 0; i < expected.length; i += 1) {
          const want = normalizeLinkedCell(expected[i]);
          const got = normalizeLinkedCell(row[cs + i]);
          if (want !== got) { matched = false; break; }
        }
        if (matched) {
          headerRowIdx = ri;
          colOffset = cs;
          break;
        }
      }
    }
    if (headerRowIdx < 0) {
      // 理论不应发生（detector 已 matched），守卫：当作未匹配抛出，由调用方记 write-error 明细
      throw new LinkedFileValidationError('FILE_READ', '当前导入文件未匹配到该链接表的表头');
    }

    const objects = [];
    const rowNumbers = [];
    for (let ri = headerRowIdx + 1; ri < rows.length; ri += 1) {
      const row = Array.isArray(rows[ri]) ? rows[ri] : [];
      const obj = {};
      for (let i = 0; i < expected.length; i += 1) {
        const headerName = normalizeLinkedCell(expected[i]);
        if (headerName === '') continue; // 跳过中间空列占位（不入对象）
        const cell = row[colOffset + i];
        obj[headerName] = normalizeLinkedCell(cell === undefined ? '' : cell);
      }
      objects.push(obj);
      // 物理行号：allRowNumbers 同下标取；缺失退化为 ri+1（与 readRowsWithMetadata 无表头分支口径一致）。
      const rn = allRowNumbers[ri];
      rowNumbers.push(rn === undefined || rn === null ? ri + 1 : rn);
    }
    return { objects, rowNumbers };
  }

  // 既有调用方接口：仅取对象数组（行为与重构前完全一致）。
  function readLinkedRowsAsObjects(filePath, signature, sheetName = null) {
    return readLinkedRowsAsObjectsWithMeta(filePath, signature, sheetName).objects;
  }

  // ==========================================================================
  // v3.0.7 需求2d（🔴🔴 资金红线，R-5 禁复制）：链接表「落库 + 派生 + 缓存清理」共享桥接。
  //   把原 linked-table:import handler 的 per-file 落库段（读行→幂等 upsert / 整表覆盖→ADM/BOC/调拨对账单派生
  //   →清 processingResult/reconIdFixResult）整体抽成此函数，供两个入口零复制复用：
  //     ① 「链接表管理」按钮（linked-table:import，候选集 LINKED_IMPORT_SIGNATURES，含 bank-deposit）；
  //     ② 「导入文件」按钮（bank-statement:batch-import 通用导入，候选集 ALL_TABLE_SIGNATURES + 44列→Channel
  //        二次路由命中 bank-deposit）。
  //   🔴 仅搬运既有逻辑，零改任何落库口径 / 派生口径 / 缓存清理时机 —— 字节级 parity（行为与抽出前完全一致）。
  //   入参：均已由调用方解析完毕（detector 命中后）：
  //     - filePath / fileName：当前文件路径与展示名
  //     - detected：detectTableType 返回对象（用 detected.streamingEligible / detected.sheetName）
  //     - repoKey：仓储 tableKey（gateway-bill / mid-allocation / fx-settlement / bank-deposit；fx-option 由调用方拦截）
  //     - signature：repo 对应 linked 签名（拿 expectedHeaders 做列映射）
  //   返回：okResult 对象（含 status:'ok' + outcome:'linked' + tableKey:repoKey + rowCount/派生子字段…），调用方直接 push。
  //   抛错：落库/读行阶段异常向外抛（由调用方 try/catch 记 write-error，与原 handler 同口径）；
  //         派生阶段异常已在各派生函数内部 try/catch 兜住（记 created:false），不外抛、不阻断落库本身。
  //   🔴 async：流式落库路径含 await（upsert*Streaming / replaceLinkedTableStreaming），调用方须 await。
  async function importLinkedFileToRepo({ filePath, fileName, detected, repoKey, signature }) {
    // 🔴 v2.1.16-beta.3 ②：裁列必须在 44 列校验之后。readLinkedRowsAsObjects 内部走
    //   detector L1/L2 + expectedHeaders zip 校验，异构文件读不出 44 列对象（前面 detector 已拦截）。
    //   入金表（bank-deposit）：按 13 字段名 pick 裁列（pickBankDepositFields，非索引切片）；
    //   其余链接表不裁列。raw_json 天然只存裁后字段。
    const transform = repoKey === 'bank-deposit' ? pickBankDepositFields : (x) => x;
    const isGatewayBill = repoKey === 'gateway-bill';
    const isBankDeposit = repoKey === 'bank-deposit';
    const isFxSettlement = repoKey === 'fx-settlement';
    // v3.0.4 块 E 需求2（🔴 守卫）：外汇交割表（fx-settlement）强制走数组路径，绝不走流式（BOC 分组依赖物理行号断档）。
    const useStreamingPath = detected.streamingEligible && repoKey !== 'fx-settlement';
    let ret;
    // fx-settlement 数组路径产物缓存（供下方 BOC 派生块按物理行序扫描分组）。
    let fxObjects = null;
    let fxRowNumbers = null;
    if (useStreamingPath) {
      const feedRows = async (writeOne) => {
        const { matched } = await streamLinkedRowsToInsert(filePath, signature, writeOne, transform);
        if (!matched) {
          throw new LinkedFileValidationError('FILE_READ', '当前导入文件未匹配到该链接表的表头');
        }
      };
      if (isGatewayBill) {
        ret = await database.upsertLinkedGatewayBillStreaming(feedRows, { sourceFileName: fileName });
      } else if (isBankDeposit) {
        ret = await database.upsertLinkedBankDepositStreaming(feedRows, { sourceFileName: fileName });
      } else {
        ret = await database.replaceLinkedTableStreaming(repoKey, feedRows, { sourceFileName: fileName });
      }
    } else {
      // 数组路径：fx-settlement 用 WithMeta 同时取物理行号（BOC 分组扫描热依赖）；其余表零行为变化。
      const meta = readLinkedRowsAsObjectsWithMeta(filePath, signature, detected.sheetName);
      const rows = meta.objects;
      if (repoKey === 'fx-settlement') {
        fxObjects = meta.objects;
        fxRowNumbers = meta.rowNumbers;
      }
      const rowsToWrite = repoKey === 'bank-deposit'
        ? rows.map((r) => pickBankDepositFields(r))
        : rows;
      if (isGatewayBill) {
        ret = database.upsertLinkedGatewayBill(rowsToWrite, { sourceFileName: fileName });
      } else if (isBankDeposit) {
        ret = database.upsertLinkedBankDeposit(rowsToWrite, { sourceFileName: fileName });
      } else if (isFxSettlement) {
        ret = database.upsertLinkedFx(rowsToWrite, { sourceFileName: fileName });
      } else {
        ret = database.replaceLinkedTable(repoKey, rowsToWrite, { sourceFileName: fileName });
      }
    }
    const okResult = {
      fileName,
      tableKey: repoKey,
      status: 'ok',
      // v3.0.7 需求2d：逐文件结果标明走向 —— 'linked'=落链接表（与 'processed'=走 R1-R5 预处理 正交）。
      outcome: 'linked',
      rowCount: ret.rowCount,
      dataDateMin: ret.dataDateMin,
      dataDateMax: ret.dataDateMax
    };
    // v3.0.1 需求1（D3）/ v3.0.5：网关 + 入金表 + 外汇交割表 upsert 回传本次幂等覆盖数 / 空键拒入数 → 前端导入完成框提醒。
    if (isGatewayBill || isBankDeposit || isFxSettlement) {
      okResult.overwriteCount = ret.overwriteCount;
      okResult.rejectedEmptyCount = ret.rejectedEmptyCount;
    }
    if (isGatewayBill) {
      // v3.0.1 PR#68 Finding1（🔴 资金红线）：gateway-bill 数据变更（upsert 导入）后清银行对账缓存。
      processingResult = null;
    }
    // v3.0.4 块 E 需求2（🔴 资金对账敏感）：外汇交割表落库成功后，重建 BOC链接表（进组 + DB 全量重匹配 + 重编号）。
    if (repoKey === 'fx-settlement') {
      try {
        const groupOffset = database.getMaxBocFxOrigGroupNo();
        const scan = scanFxGroups({ objects: fxObjects || [], rowNumbers: fxRowNumbers || [], offset: groupOffset });
        const upsertRet = database.upsertBocFxLink(scan.rows);
        const fxDeriveRet = rebuildFxBocDerivation(
          { database, rematchAllBocGroups, buildBocBankRows, backfillBocReconLinkIds, appendActivityLogEntry },
          { scanLogs: scan.logs, groupCount: scan.groupCount, overwriteCount: upsertRet.overwriteCount }
        );
        okResult.bocDerive = fxDeriveRet.bocDerive;
      } catch (bocErr) {
        okResult.bocDerive = {
          created: false,
          error: bocErr && bocErr.message ? bocErr.message : String(bocErr)
        };
      }
    }
    // v2.1.16-beta.5 需求3（逻辑A）：银行对账单表 / 中台调拨订单表落库成功后，派生隐藏的 ADM 银行对账单链接表。
    //   PR#65 新 Finding1（🔴 资金红线）：bank-deposit 或 mid-allocation 任一变更都须重建 ADM。
    let bankExistsForAdm = repoKey === 'bank-deposit';
    if (repoKey === 'mid-allocation') {
      try { bankExistsForAdm = database.hasLinkedTableRows('bank-deposit'); }
      catch (probeErr) { bankExistsForAdm = false; }
    }
    if (bankExistsForAdm) {
      const { admDerive } = rebuildAdmDerivation({ database, buildAdmRows });
      okResult.admDerive = admDerive;
      // v2.1.16-beta.6 PR#65 Codex FindingB（🔴 资金红线）：ADM 成功重建 → 旧 JPM 修复结果失效 → 清空。
      if (admDerive && admDerive.created) {
        reconIdFixResult = null;
      }
    }
    // v3.0.6 需求1（T3，🔴 资金红线）：中台调拨订单表（mid-allocation）落库成功后，派生隐藏的调拨对账单表。
    if (repoKey === 'mid-allocation') {
      const { fundTransferReconDerive } = rebuildFundTransferReconDerivation({ database, buildFundTransferReconRows });
      okResult.fundTransferReconDerive = fundTransferReconDerive;
    }
    // v3.0.4 块 E 需求2（🔴 资金对账敏感）：银行对账单表落库成功后，重派生 BOC调拨银行对账单表 + 2.5 全量回填。
    if (repoKey === 'bank-deposit') {
      const { bocBankDerive } = rebuildBankDepositBocDerivation(
        { database, buildBocBankRows, backfillBocReconLinkIds, appendActivityLogEntry }
      );
      okResult.bocBankDerive = bocBankDerive;
    }
    // v3.0.1 PR#68 self-review Finding1（🔴 资金红线）：bank-deposit 是 R5 场景4 数据源；
    //   v3.0.4 块 F · F4（🔴 资金红线）：mid-allocation 是 R5 场景2b 数据源 —— 两者重导均须清 run 结果。
    if (repoKey === 'bank-deposit' || repoKey === 'mid-allocation') {
      processingResult = null;
    }
    return okResult;
  }

  // v3.0.0 块 B / PR-2：streamLinkedRowsToInsert（流式行源 = replaceLinkedTableStreaming 的 feedRows 实现体）
  //   已抽到 src/main-process/linked-table-stream-source.js（见顶部 require），便于集成测试调真实实现。
  //   含 🔴 全空行过滤（isRowMeaningful，对齐数组路径 readRowsWithMetadata）。

  // list：4 个 tableKey 元数据（期权恒空 meta）。只读，普通 handle。
  ipcMain.handle('linked-table:list', () => {
    if (!database || !database.db) return { status: 'error', message: '数据库未初始化' };
    try {
      const tables = database.listLinkedTableMeta();
      return { status: 'ok', tables };
    } catch (err) {
      return { status: 'error', message: err && err.message ? err.message : String(err) };
    }
  });

  // v3.0.0 需求2b：单个链接表行数（轻量查 linked_table_meta 单行 meta，不读全表）。
  //   用途：C3 提醒「数据就绪判据」改向链接表 gateway-bill rowCount（替代 gatewayReconSession 门控）。
  //   🔴 资金红线：前端判据严格 rowCount>0 才算就绪；本 handle 任何异常（数据库未初始化 / tableKey 非法 / 查询失败）
  //     一律返回非 ok（{status:'failed'}），由前端按「未就绪」保守处理（仍提醒，防静默漏对账）。只读，普通 handle。
  ipcMain.handle('linked-table:row-count', (_event, tableKey) => {
    if (!database || !database.db) return { status: 'failed', message: '数据库未初始化' };
    try {
      const meta = database.getLinkedTableMeta(tableKey);
      return { status: 'ok', rowCount: (meta && Number.isFinite(meta.rowCount)) ? meta.rowCount : 0 };
    } catch (err) {
      return { status: 'failed', message: err && err.message ? err.message : String(err) };
    }
  });

  // v3.0.5 OPEN-4（T6b-2）🔴🔴 资金红线：按日期范围 count/delete 的「目标表」正向白名单。
  //   仅三张前端可管理的主表（gateway-bill / fx-settlement / bank-deposit）；其余（含隐藏派生表
  //   adm-bank-deposit / boc-fx-settlement / boc-bank-deposit / mid-allocation / fx-option）一律拒绝——
  //   删除不可逆 + 派生联动，绝不允许通过 tableKey 触达隐藏派生表（防误删/绕过派生重建链）。
  const LINKED_DELETE_ALLOWED_TABLES = new Set(['gateway-bill', 'fx-settlement', 'bank-deposit']);

  // v3.0.1 需求1（D4）：按数据日期范围统计将删行数（只读，前端删除弹框预览）。任何异常返回 failed，前端保守处理。
  //   v3.0.5 OPEN-4（T6b-2）🔴 资金红线：三表化 —— 加 tableKey 正向白名单路由（缺省 gateway-bill 向后兼容）。
  //   🔴 绝不用 LINKED_TABLE_DEFS 兜底放行隐藏派生表（adm/boc-*/mid/fx-option）：非白名单直接 failed
  //     （删除红线防线，count 与 delete 同口径白名单——预览与实删目标表必须一致，防「预览主表、删隐藏表」错位）。
  ipcMain.handle('linked-table:count-by-date-range', (_event, payload) => {
    if (!database || !database.db) return { status: 'failed', message: '数据库未初始化' };
    const start = payload && payload.start != null ? String(payload.start).trim() : '';
    const end = payload && payload.end != null ? String(payload.end).trim() : '';
    if (!start || !end || start > end) return { status: 'failed', message: '日期范围非法' };
    // v3.0.1 PR#68 self-review #2：ISO 日期格式守卫。非 ISO 串（'2026/01/01'/'abc'）能过非空/字典序校验，
    //   但 BETWEEN 匹配不到行 → 统计/删除静默 0 行（误导用户）；这里硬拦，强制 YYYY-MM-DD。
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
      return { status: 'failed', message: '日期格式非法（需 YYYY-MM-DD）' };
    }
    // 🔴 正向白名单：仅三张可管理主表；缺省 gateway-bill（前端未传 tableKey 时 = v3.0.1 行为）。
    const tableKey = payload && payload.tableKey != null ? String(payload.tableKey).trim() : 'gateway-bill';
    if (!LINKED_DELETE_ALLOWED_TABLES.has(tableKey)) {
      return { status: 'failed', message: '不支持的删除目标表' };
    }
    try {
      let count;
      if (tableKey === 'fx-settlement') count = database.countFxByDateRange(start, end);
      else if (tableKey === 'bank-deposit') count = database.countBankDepositByDateRange(start, end);
      else count = database.countGatewayBillByDateRange(start, end);
      return { status: 'ok', count };
    } catch (err) {
      return { status: 'failed', message: err && err.message ? err.message : String(err) };
    }
  });

  // v3.0.1 需求1（D4）🔴 资金红线：按数据日期范围删除链接表行（不可逆，闭区间，直接删）。
  //   mutating → trackedIpcHandle 记活动日志；入参校验（起止非空 + 起≤止）；返回删除行数 + 重算后 meta。
  //   v3.0.5 OPEN-4（T6b-2）🔴🔴 资金红线：三表化 —— tableKey 正向白名单路由（缺省 gateway-bill 向后兼容）+ 删除派生联动：
  //     · gateway-bill → 删 + 清 processingResult（v3.0.1 行为字节不变）。
  //     · fx-settlement → 删 fx 主表（T6a 单事务已联动删 BOC 行）→ rebuildFxBocDerivation 全量重匹配重编号（无进组步，传空 ctx）→ 清 reconIdFixResult。
  //     · bank-deposit  → 删 bank 主表（T6a 返回 deletedBizIds）→ rebuildAdmDerivation + rebuildBankDepositBocDerivation 派生重建
  //                      → 清 processingResult + reconIdFixResult + clearBankDepositHitMarkersByBizIds（OPEN-7 标记防悬挂）。
  //   🔴 事务边界：T6a 删除函数各自单事务（BEGIN/COMMIT/ROLLBACK）删完即返回；rebuild* / clearBankDepositHitMarkersByBizIds
  //     各自开独立事务——本处调用点【不在】任何外层 DB 事务内（删除事务已提交），无嵌套事务问题。
  //   🔴 派生重建沿用导入侧语义：rebuild* 内部各自 try/catch 隔离，派生任一步抛错记 created:false 不向外抛、不阻断删除本身（行已删）。
  trackedIpcHandle('linked-table:delete-by-date-range', '链接表管理', '删除', (_event, payload) => {
    // v3.0.11 codex-P2 补强（🔴 资金红线）：纳入 bankStatementOperationLock —— 链接表是 bank-statement run（R1-R5）输入，
    //   run 全程持锁；本删除若在 run 数据准备让出窗口内并发执行会撕裂快照。争用即返回失败，finally 释放。
    const opLock = tryAcquireBankStatementOpLock('linked-delete');
    if (!opLock.acquired) return { status: 'failed', message: opLock.message };
    try {
    if (!database || !database.db) return { status: 'failed', message: '数据库未初始化' };
    const start = payload && payload.start != null ? String(payload.start).trim() : '';
    const end = payload && payload.end != null ? String(payload.end).trim() : '';
    if (!start || !end || start > end) return { status: 'failed', message: '日期范围非法（起止必填且起≤止）' };
    // v3.0.1 PR#68 self-review #2（🔴 删除不可逆）：ISO 日期格式守卫。非 ISO 串（'2026/01/01'/'abc'）能过非空/字典序校验，
    //   但 BETWEEN 匹配不到行 → 静默删 0 行（误导用户「以为删了」）；这里硬拦，强制 YYYY-MM-DD。
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
      return { status: 'failed', message: '日期格式非法（需 YYYY-MM-DD）' };
    }
    // 🔴 正向白名单（与 count 同口径）：仅三张主表；非白名单（含隐藏派生表）一律拒绝——绝不用 LINKED_TABLE_DEFS 兜底放行。
    const tableKey = payload && payload.tableKey != null ? String(payload.tableKey).trim() : 'gateway-bill';
    if (!LINKED_DELETE_ALLOWED_TABLES.has(tableKey)) {
      return { status: 'failed', message: '不支持的删除目标表' };
    }
    try {
      if (tableKey === 'fx-settlement') {
        // 🔴🔴 资金红线：删外汇交割表（T6a 单事务已按 transaction_no 联动删 BOC 行，返回 bocDeleted/deletedTxnNos）。
        const ret = database.deleteFxByDateRange(start, end);
        // 🔴 删除场景【无进组步】（被删 BOC 行已由 T6a 联动删，无新行进组）→ 传空 ctx（scanLogs:[]/groupCount:0/overwriteCount:0），
        //   rebuildFxBocDerivation 从「读全库 BOC 行重匹配」起：readBocFxLinkRowsForRematch → rematchAllBocGroups（重编号 1..N）
        //   → 2.4 replaceBocBankDeposit → 2.5 全量回填 → 对删后全库行重算（复用 T6b-1 抽取函数，禁复制 = R-5）。
        const { bocDerive } = rebuildFxBocDerivation(
          { database, rematchAllBocGroups, buildBocBankRows, backfillBocReconLinkIds, appendActivityLogEntry },
          { scanLogs: [], groupCount: 0, overwriteCount: 0 }
        );
        // 🔴 删 fx → BOC 派生重算 → 旧 reconIdFixResult（基于旧 BOC 调拨数据的修复结果）失效 → 清空（spec §3.3）。
        reconIdFixResult = null;
        return {
          status: 'ok',
          deleted: ret.deleted,
          rowCount: ret.rowCount,
          dataDateMin: ret.dataDateMin,
          dataDateMax: ret.dataDateMax,
          bocDeleted: ret.bocDeleted,
          bocDerive
        };
      }
      if (tableKey === 'bank-deposit') {
        // 🔴 资金红线：删银行对账单入金表（T6a 单事务删 + 返回 deletedBizIds 供清标记/派生重建）。
        const ret = database.deleteBankDepositByDateRange(start, end);
        // 派生重建（复用 T6b-1 抽取函数，禁复制 = R-5）：ADM（全库 Channel=ADM 候选重建）+ BOC bank（2.4 + 2.5 全量回填）。
        const { admDerive } = rebuildAdmDerivation({ database, buildAdmRows });
        const { bocBankDerive } = rebuildBankDepositBocDerivation(
          { database, buildBocBankRows, backfillBocReconLinkIds, appendActivityLogEntry }
        );
        // 🔴 删 bank-deposit → 清 processingResult（R5 场景4 中台退款回填 + 场景2b 数据源失效）
        //   + reconIdFixResult（ADM 表重建 = JPM 修复结果失效）。
        processingResult = null;
        reconIdFixResult = null;
        // 🔴 OPEN-7（spec §3.3）：清被删 BizId 的命中标记防悬挂。
        //   注：当前载体（last_hit_run/last_hit_at 在 linked_bank_deposit 行上）下 DELETE 已隐式清掉被删行的标记，
        //   此调用为 spec §3.3 要求的防御性双保险（口径与 T6a deletedBizIds 字节同源：normalizeKey 去空去重）。
        database.clearBankDepositHitMarkersByBizIds(ret.deletedBizIds);
        return {
          status: 'ok',
          deleted: ret.deleted,
          rowCount: ret.rowCount,
          dataDateMin: ret.dataDateMin,
          dataDateMax: ret.dataDateMax,
          admDerive,
          bocBankDerive
        };
      }
      // gateway-bill（缺省）：v3.0.1 行为字节不变。
      const ret = database.deleteGatewayBillByDateRange(start, end);
      // v3.0.1 PR#68 Finding1（🔴 资金红线）：gateway-bill 数据变更（按日期删除）后清银行对账缓存。
      //   银行对账 run 数据源含 gateway-bill（C3 网关核销 / R5）+ bank-deposit（R5 场景4 中台退款回填）——
      //   gateway-bill 或 bank-deposit 任一变更都使 processingResult 失效（bank-deposit 侧清空见上方分支 + linked-table:import handler）。
      //   旧 processingResult 基于旧网关数据 → 不清则「先跑银行对账、再删网关对账单」仍能导出 stale 结果，强制用户重跑后才能导出。
      processingResult = null;
      return { status: 'ok', deleted: ret.deleted, rowCount: ret.rowCount, dataDateMin: ret.dataDateMin, dataDateMax: ret.dataDateMax };
    } catch (err) {
      return { status: 'failed', message: err && err.message ? err.message : String(err) };
    }
    } finally {
      // v3.0.11 codex-P2 补强：删表结束统一释放互斥锁（含各早返回 / ok / 异常路径）。
      releaseBankStatementOpLock();
    }
  });

  // import：多选 Excel → 逐文件识别 → 命中且支持 → 读行落库 → 汇总 per-file 明细。
  //   数据红线 🔴：gateway-bill 走按 ReconBillBizId 幂等累加 upsert（重导不清空、相同 bizId 覆盖、空 bizId 拒入，v3.0.1，见下方 inline 注释）；
  //     其余 3 张表 replaceLinkedTable 整表覆盖（一张表重导 = 旧数据全删）。不整批回滚。
  trackedIpcHandle('linked-table:import', '链接表管理', '导入', {
    async prepare() {
      if (!database || !database.db) {
        return { proceed: false, result: { status: 'error', message: '数据库未初始化' } };
      }
      const res = await showImportOpenDialog('linked-table', {
        title: '选择链接表文件（可多选）',
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: 'Excel', extensions: ['xlsx', 'xls'] }]
      });
      if (res.canceled || !Array.isArray(res.filePaths) || res.filePaths.length === 0) {
        return { proceed: false, result: { status: 'cancelled' } };
      }
      return { proceed: true, inputPaths: res.filePaths, filePaths: res.filePaths };
    },
    async execute(_event, prepared) {
    // v3.0.11 codex-P2 补强（🔴 资金红线）：纳入 bankStatementOperationLock —— 链接表是 bank-statement run（R1-R5）输入，
    //   run 全程持锁；本导入若在 run 数据准备让出窗口内并发执行会撕裂快照。争用即返回失败，finally 释放。
    const opLock = tryAcquireBankStatementOpLock('linked-import');
    if (!opLock.acquired) return { status: 'failed', message: opLock.message };
    try {
    const results = [];
    for (const filePath of prepared.filePaths) {
      const fileName = path.basename(filePath);
      // 识别：链接表导入候选集（4 张 linked 签名 + 入金表签名；detector 默认含全部，这里收窄）。
      //   v2.1.16-beta.3 ②：入金表与主表同构 44 列，但主表签名不在此集合 → 入金表唯一命中、不 ambiguous。
      let detected;
      try {
        detected = await detectTableType(filePath, LINKED_IMPORT_SIGNATURES);
      } catch (err) {
        results.push({ fileName, status: 'read-error', message: err && err.message ? err.message : String(err) });
        continue;
      }

      if (detected.status === 'ambiguous') {
        results.push({ fileName, status: 'ambiguous', message: '表头同时命中多张链接表，无法唯一判定' });
        continue;
      }
      if (detected.status === 'unrecognized') {
        results.push({ fileName, status: 'unrecognized', message: '未识别为任何链接表' });
        continue;
      }
      if (detected.status === 'read-error') {
        results.push({ fileName, status: 'read-error', message: formatDetectorReadErrorMessage(detected) });
        continue;
      }
      // v2.1.16 PR#61 F3：detector 识别到「已入库但本阶段不接入落库」的表（外汇期权表）→ unsupported。
      //   模板已入库 → 识别得出来，但不建 DB 表、不持久化（阶段二接入）；提示用户已入库待接入。
      if (detected.status === 'unsupported') {
        results.push({
          fileName,
          tableKey: detected.tableKey,
          status: 'unsupported',
          message: '外汇期权表已入库，待阶段二接入'
        });
        continue;
      }

      // matched：映射到 repo tableKey。
      //   双保险：理论上 fx-option 已在上方 unsupported 分支拦截，此处仍守卫缺失映射/签名。
      const detectorKey = detected.tableKey;
      const repoKey = LINKED_DETECTOR_TO_REPO_KEY[detectorKey];
      const signature = getLinkedSignatureByKey(detectorKey);
      if (detectorKey === 'fx-option' || !repoKey || !signature) {
        results.push({
          fileName,
          tableKey: detectorKey,
          status: 'unsupported',
          message: '外汇期权表已入库，待阶段二接入'
        });
        continue;
      }

      // 读行 → 对象数组 → 落库 + 派生（v3.0.7 需求2d：整段抽至 importLinkedFileToRepo 共享函数，
      //   供「链接表管理」与「导入文件」通用导入零复制复用；落库/派生/缓存清理口径字节级 parity）。
      try {
        const okResult = await importLinkedFileToRepo({ filePath, fileName, detected, repoKey, signature });
        results.push(okResult);
      } catch (err) {
        results.push({
          fileName,
          tableKey: repoKey,
          status: 'write-error',
          message: err && err.message ? err.message : String(err)
        });
      }
    }

    // v3.0.4 块 A · A2 #1（修「链接表报错全链路零落盘」）：循环结束后若存在失败项 → 落 activity log（error 级）。
    //   失败状态集 = read-error / write-error / ambiguous / unrecognized（unsupported=外汇期权表待接入，属正常态，不计失败）。
    //   message 含 N/M 失败计数；details 逐文件列 fileName + status + message，供日志查证。
    //   本 handler 为权威落盘点；UI 弹窗按 spec §2.2 #2/#3 走 skipLogReport 避免双写。
    const FAILED_STATUSES = new Set(['read-error', 'write-error', 'ambiguous', 'unrecognized']);
    const failedResults = results.filter((r) => FAILED_STATUSES.has(r.status));
    if (failedResults.length > 0) {
      appendActivityLogEntry({
        level: 'error',
        source: 'main',
        domain: '链接表管理',
        message: `链接表导入：${failedResults.length}/${results.length} 个文件失败`,
        details: failedResults.map((r) => `${r.fileName}｜${r.status}｜${r.message || ''}`)
      });
    }

    return { status: 'ok', results };
    } finally {
      // v3.0.11 codex-P2 补强：导入结束统一释放互斥锁（含 cancelled / ok / 异常路径）。
      releaseBankStatementOpLock();
    }
    }
  });

  // ==========================================================================
  // v2.1.16 阶段一 A5：银行对账单预加工「批量导入（按表头识别）」
  //   v3.0.7 需求2d（🔴🔴 资金红线）：升级为「通用导入」——「导入文件」按钮一次多选 Excel，
  //     合并「预处理识别」与「链接表识别」为一套候选集，逐文件自动路由（识别 + 路由 + 落库桥接）。
  //   候选集 = ALL_TABLE_SIGNATURES（预处理 3 张 + 链接 4 张；🔴 不含 bank-deposit 签名——它与 bank-statement
  //     同构 44 列，靠下方「44列→Channel 二次路由」识别，不靠表头签名，否则 ambiguous）。
  //   逐文件 detectTableType（ALL_TABLE_SIGNATURES 候选）→ 路由：
  //     - bank-statement     → 先按 44 列识别命中；再读 Channel 二次路由：
  //         · 非空渠道-地区组合全 ∈ {ADM, BOC, JPM-US} → 走 bank-deposit 链接表落库 + 派生（复用 importLinkedFileToRepo），
  //           outcome:'linked'（🔴 落库≠跳过：linked_bank_deposit 是 R1-R5 数据源，下次 run 自动读回喂场景4）。
  //         · 含任一常规渠道（或空文件保守判定）→ 现有 R1-R5 预处理：readBankStatement 写/合并 bankStatementSession，
  //           outcome:'processed'。🔴 多个银行对账单 = 合并对账（不覆盖）：追加 rows 到同一 session，统一对账。
  //     - zhongtai-dispatch-order / gateway-recon / fx-delivery / fx-option（scope='linked'）
  //                          → 走对应链接表落库 + 派生（复用 importLinkedFileToRepo），outcome:'linked'
  //                            （与「链接表管理」按钮 linked-table:import 同一落库/派生口径；fx-option 仍 unsupported）。
  //     - zhongtai-refund-order → 读 25 列落 refundOrderSession（R5 退款回填数据源），outcome:'processed'。
  //     - intake-original-order → 本阶段功能开关默认关 → status='disabled'（跳过，不读不写）。
  //     - ambiguous / unrecognized / read-error → 逐条记明细。
  //   返回 per-file results（参考 A4 linked-table:import 范式）；不整批回滚（一文件失败不影响其余）。
  //   🔴 逐文件 outcome 字段（与 status 正交，向后兼容）：'processed'（走 R1-R5 预处理）| 'linked'（落链接表）。
  //
  //   🔴 资金红线（合并语义，2026 用户反馈拍板：合并不覆盖）：
  //     1) 第一个银行对账单建 session（含 sourceFiles）；后续银行对账单先校验 headers 与 session 完全一致
  //        （44 列同结构同顺序），一致才 **追加** rows，不一致该文件标 invalid 不合并（防异构表混入污染对账）。
  //     2) _rowId 全局唯一：readBankStatement 注入的 row_0..row_N 是「文件内」编号，多文件合并会重复；
  //        合并后必须对 session.rows **统一重编号** _rowId='row_'+全局index（0-based 跨文件唯一），
  //        否则 dispatcher 的 rowLockSet（以 _rowId 为键的 first-match-wins 锁）会把不同文件的同序号行
  //        当成同一行 → 漏对 / 误锁（scenario-dispatcher.js modifiedRows/unmatchedRows filter 全依赖 _rowId）。
  //     3) processingResult / gatewayReconSession 整批只清一次（有任一银行对账单成功时），不每文件清。
  //   🔴 绝不改任何对账匹配值 / 匹配逻辑 / 派生口径 —— 本需求只加「识别 + 路由 + 落库桥接」，
  //     落库走既有 importLinkedFileToRepo（与「链接表管理」同源），对账匹配仍发生在 bank-statement:run 阶段。
  //   ⚠️ Runtime-state 红线：bankStatementSession / processingResult / gatewayReconSession 三者皆运行时状态，
  //     合并后的 session 结构（rows 含全局唯一 _rowId、headers 不变、新增 sourceFiles）须与 run/export 读取契约兼容。
  // ==========================================================================

  // v2.1.16-beta.6 需求C：中台退款回填通路已开通（退款分支实装读取 → 落 refundOrderSession）；
  //   入账原始反回填通路仍默认关（待后续阶段实装时改为 true 并补读取/落库）。
  const INTAKE_ORIGINAL_BATCH_ENABLED = false;

  // headers 一致校验 + rows 合并 + _rowId 全局重编号 已抽到 src/main-process/bank-statement-merge.js
  //   （mergeBankStatementRows / BankStatementMergeError，🔴 资金红线，便于单测；见顶部 require）。

  // v2.1.16 PR#61 F1：统计口径与单选 bank-statement:import 一致用「导入文件」
  //   （usage-stats FUNCTION_REGISTRY 无「批量导入」function → 原口径 incrementFunction 静默丢弃 →
  //    「导入对账单」成功不再计入 .usage-stats.txt；改用已注册的「导入文件」使统计连续）。
  trackedIpcHandle('bank-statement:batch-import', '银行对账单处理', '导入文件', {
    async prepare() {
      const choice = await showImportOpenDialog('bank-statement-process', {
        title: '选择要批量导入的文件（可多选）',
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: 'Excel', extensions: ['xlsx', 'xls'] }]
      });
      if (choice.canceled || !Array.isArray(choice.filePaths) || choice.filePaths.length === 0) {
        return { proceed: false, result: { status: 'cancelled' } };
      }
      return { proceed: true, inputPaths: choice.filePaths, filePaths: choice.filePaths };
    },
    async execute(event, prepared) {
    // v3.0.11 需求3（批1 · 🔴 资金红线）：统一互斥锁（与 run/export 共享一把）。争用即返回失败，绝不并发撕裂会话态。
    const opLock = tryAcquireBankStatementOpLock('import');
    if (!opLock.acquired) {
      return { status: 'failed', message: opLock.message };
    }
    // v3.0.11 需求3（批1 · 导入让出+进度）：内联进度转发器（100ms 节流，仿收单 createImportProgressForwarder
    //   + run 内联 onProgress）。stage==='reading' 为文件切换，必发不节流；事件只读，绝不写任何会话/对账态。
    const onImportProgress = (!event || !event.sender) ? null : (() => {
      let lastSentAt = 0;
      const THROTTLE_MS = 100;
      return (ev) => {
        const isStageSwitch = ev && ev.stage === 'reading';
        const now = Date.now();
        if (!isStageSwitch && now - lastSentAt < THROTTLE_MS) return;
        lastSentAt = now;
        try { event.sender.send('bank-statement:import:progress', { ...ev, phase: 'import' }); }
        catch (_e) { /* swallow — 窗口已销毁等不影响导入 */ }
      };
    })();
    try {
    const results = [];
    const fileCount = prepared.filePaths.length;
    // 本批是否已建立/合并过银行对账单 session（用于：① 第一个建 vs 后续合并的分支；
    //   ② processingResult / gatewayReconSession 整批只清一次）。
    let bankStatementMerged = false;
    // v2.1.16-beta.6 PR#65 Finding1：本批是否已导退款订单 —— 避免同批「退款订单先于银行对账单处理」时
    //   被银行对账单分支的「清旧退款」误清掉本批刚导入的退款 session（filePaths 顺序不可控）。
    let refundImportedThisBatch = false;

    for (let fileIndex = 0; fileIndex < prepared.filePaths.length; fileIndex++) {
      const filePath = prepared.filePaths[fileIndex];
      const fileName = path.basename(filePath);
      // v3.0.11 需求3（批1 · 导入让出+进度）：每文件开始前让出事件循环（消除大批量导入期窗口「未响应」）+ 上报进度。
      //   yield 放循环体顶部 = 在「上一文件处理完、本文件重活前」让出，等价于「每文件处理完让出」（规避循环内多处 continue）。
      //   单文件内 readBankStatement（同步 XLSX.readFile）本批不改（单个预处理对账单行数有限，留观察）。
      if (typeof onImportProgress === 'function') onImportProgress({ stage: 'reading', fileIndex, fileCount, filePath });
      await new Promise((r) => setImmediate(r));

      // 识别：v3.0.7 需求2d 通用导入候选集 ALL_TABLE_SIGNATURES（预处理 3 张 + 链接 4 张；🔴 不含 bank-deposit）。
      let detected;
      try {
        detected = await detectTableType(filePath, ALL_TABLE_SIGNATURES);
      } catch (err) {
        results.push({ fileName, status: 'read-error', message: err && err.message ? err.message : String(err) });
        continue;
      }

      if (detected.status === 'ambiguous') {
        results.push({ fileName, status: 'ambiguous', message: '表头同时命中多张表，无法唯一判定' });
        continue;
      }
      if (detected.status === 'unrecognized') {
        results.push({ fileName, status: 'unrecognized', message: '未识别为任何可导入的表（银行对账单 / 中台退款订单 / 入账原始订单 / 链接表）' });
        continue;
      }
      if (detected.status === 'read-error') {
        results.push({ fileName, status: 'read-error', message: formatDetectorReadErrorMessage(detected) });
        continue;
      }
      // v2.1.16 PR#61 F3：守卫「已入库待阶段二接入」表。v3.0.7 需求2d：候选集纳入期权表（ALL_TABLE_SIGNATURES
      //   含 fx-option）→ detector 标 unsupported，此分支正式生效（与「链接表管理」入口同口径，落库待阶段二）。
      if (detected.status === 'unsupported') {
        results.push({
          fileName,
          tableKey: detected.tableKey,
          status: 'unsupported',
          message: '外汇期权表已入库，待阶段二接入'
        });
        continue;
      }

      // matched：按 tableKey 路由
      const tableKey = detected.tableKey;

      if (tableKey === 'bank-statement') {
        // 🔴 合并语义：第一个建 session；后续校验 headers 一致后追加 rows（不覆盖）。
        //   headers 校验 + rows 合并 + _rowId 全局重编号统一交给 mergeBankStatementRows（资金红线纯函数）。
        try {
          const result = readBankStatement(filePath);

          // v3.0.7 需求2d（🔴🔴 资金红线）：44 列 bank-statement 命中后的「Channel 二次路由」——
          //   逐行判定 Channel+地区（database.isBankDepositChannelFile，与 C1 状态框前缀同源同模块的纯函数）：
          //   若至少一行非空 Channel 且全部非空 Channel 行都是入金行 → 这是「银行对账单入金表」，
          //   落 bank-deposit 链接表（不进对账 session）；否则（含任一常规渠道，或空文件 / 全空 Channel）→
          //   走下方现有 R1-R5 预处理合并。
          //   🔴 口径精确（绝不用 'Channel-地区' 组合字符串比白名单）：ADM/BOC 按裸 Channel 列值判定、忽略地区
          //     （真实 BOC 入金行 地区='CN'，组合化会拼成 'BOC-CN' 致误判走预处理）；JPM 仅 地区='US' 判入金
          //     （JPM-HK 排除，走预处理）。详见 channel-enum-repository.isBankDepositRow/isBankDepositChannelFile。
          //   🔴 空文件边界（保守）：无任何非空 Channel 行 → 谓词返回 false，走预处理（绝不吞为链接表）。
          const isBankDepositFile = database.isBankDepositChannelFile(result.rows);

          // v3.0.7 修复1（🔴🔴 资金红线 · 语义）：ADM/BOC/JPM-US 银行单 =「既落表 又对账」。
          //   旧实现是「落表 XOR 对账」（落 bank-deposit 链接表后 continue 跳过对账）→ BOC/JPM-US 行不进 R1-R5、
          //   不出现在输出结果表（手测暴露的语义 bug）。现改为：落库仅作【副作用】（供 JPM-US 二跳 / ADM / BOC
          //   交叉引用），不再 continue —— 同一文件的行【继续往下】走 merge-into-session 逻辑并入 bankStatementSession，
          //   参与对账、出现在「开始运行 → 导出」结果表。
          //   🔴 只改控制流（XOR → AND），绝不改 importLinkedFileToRepo 内部落库/派生口径、mergeBankStatementRows、
          //     isBankDepositChannelFile 谓词、任何对账匹配逻辑。
          //   单文件【只 push 一条】result（复用下方 merge 路径那条 outcome:'processed'），链接副作用经 alsoLinked 挂上去，
          //   不再额外 push 一条 outcome:'linked'（避免双计）。
          let linkedSideEffect = null;
          if (isBankDepositFile) {
            // 🔴 落 bank-deposit 链接表 + 派生（复用 importLinkedFileToRepo，与「链接表管理」同源；零改派生口径）。
            //   关键语义：落库 = 副作用（linked_bank_deposit 是 R5 场景4 JPM-US 二跳 / ADM / BOC 派生的数据源），
            //   与下方并入对账 session 并行存在，不互斥。importLinkedFileToRepo 内部也会清 processingResult（null 幂等，
            //   与 merge 首文件清空不冲突）。
            //   独立 try/catch：落库异常仅记 linkedSideEffect.error，【绝不】因落库失败而跳过对账。
            try {
              const okResult = await importLinkedFileToRepo({
                filePath,
                fileName,
                detected,
                repoKey: 'bank-deposit',
                signature: BANK_DEPOSIT_SIGNATURE
              });
              // 仅保留对前端有意义的副作用信息（行数 + 各派生结果），不带 outcome/status（那是 merge 路径 result 的职责）。
              linkedSideEffect = {
                rowCount: okResult.rowCount,
                overwriteCount: okResult.overwriteCount,
                rejectedEmptyCount: okResult.rejectedEmptyCount,
                admDerive: okResult.admDerive,
                bocBankDerive: okResult.bocBankDerive
              };
            } catch (depositErr) {
              linkedSideEffect = {
                error: depositErr && depositErr.message ? depositErr.message : String(depositErr)
              };
            }
          }

          const isAppend = bankStatementMerged; // false=本批首个银行对账单（建 session）；true=追加合并

          // 合并 + 全局重编号（首个文件 existing 传 null → 不做 headers 校验；追加时 headers 不一致抛 BankStatementMergeError）。
          //   先算出 merged，再写 session：追加失败（headers 不一致）时 session 完全不被改动（不污染对账数据集）。
          const merged = mergeBankStatementRows(
            isAppend ? bankStatementSession.rows : null,
            result.rows,
            isAppend ? bankStatementSession.headers : null,
            result.headers
          );

          if (!isAppend) {
            // 本批第一个银行对账单：建 session
            bankStatementSession = {
              filePath: result.filePath,
              fileName: result.fileName,
              rows: merged.rows,
              headers: merged.headers,
              importedAt: Date.now(),
              // 合并来源文件清单（首个文件入列；后续合并的文件 push 进来）
              sourceFiles: [result.fileName]
            };
            // 整批只清一次：首个银行对账单成功 → 清空运行结果 + 资金对账文件（与单选导入一致）
            processingResult = null;
            gatewayReconSession = null;
            // v2.1.16-beta.6 PR#65 Finding1（🔴 资金红线）：导入新银行对账单批次必须清旧退款 session，
            //   否则 bank-statement:run 会把上一批退款订单注入新批次 → 跨批错误回填。
            //   仅当本批尚未导退款订单时清（防同批「退款订单先处理」被误清）。
            if (!refundImportedThisBatch) refundOrderSession = null;
            bankStatementMerged = true;
          } else {
            // 追加合并成功（headers 已校验一致）→ 回写合并后 rows + 记来源文件
            bankStatementSession.rows = merged.rows;
            bankStatementSession.sourceFiles.push(result.fileName);
          }

          results.push({
            fileName,
            tableKey,
            status: 'ok',
            // v3.0.7 需求2d：走 R1-R5 预处理（合并入对账 session）→ outcome:'processed'。
            outcome: 'processed',
            rowCount: result.rowCount,            // 本文件行数
            merged: isAppend,                     // 是否为追加合并（true=合并到已有 session）
            mergedRowCount: bankStatementSession.rows.length, // 合并后 session 当前总行数
            sourceFileCount: bankStatementSession.sourceFiles.length, // 合并来源文件数
            // v3.0.7 修复1：ADM/BOC/JPM-US 文件同时落了 bank-deposit 链接表（副作用）→ 挂 alsoLinked
            //   （含 rowCount / admDerive / bocBankDerive，或落库失败时的 error）；常规渠道为 null（前端不渲染额外提示）。
            alsoLinked: linkedSideEffect
          });
          // v2.1.16-beta.3 ①：本文件识别为 bank-statement 且导入成功 → 沉淀枚举（失败不阻断）。
          //   🔴 用 result.rows（本文件行）而非 merged.rows（累积行），避免追加合并重复沉淀虚增 seen_count。
          //   SR-log-1：src/main.js 0 console 调用 → 走 appendActivityLogEntry 上报（warning 级，不 rethrow）
          try {
            database.recordChannelEnumFromBankStatement(result.rows);
          } catch (enumErr) {
            appendActivityLogEntry({
              level: 'warning',
              source: 'main',
              domain: 'channel-enum',
              message: '[channel-enum] 批量导入枚举沉淀失败（已忽略，不影响导入）',
              details: [enumErr && enumErr.message ? enumErr.message : String(enumErr)],
              stack: enumErr && enumErr.stack ? enumErr.stack : undefined
            });
          }
        } catch (error) {
          if (error instanceof BankStatementMergeError) {
            // headers 与已导入银行对账单不一致：不合并，session 未被污染（merge 在写 session 前抛出）
            results.push({
              fileName,
              tableKey,
              status: 'invalid',
              message: error.message
            });
          } else if (error && error.name === 'FileValidationError') {
            results.push({
              fileName,
              tableKey,
              status: 'invalid',
              code: error.code,
              message: error.message,
              detailLines: error.detailLines || []
            });
          } else {
            results.push({
              fileName,
              tableKey,
              status: 'read-error',
              message: String(error && error.message ? error.message : error)
            });
          }
        }
        continue;
      }

      if (tableKey === 'zhongtai-refund-order') {
        // v2.1.16-beta.6 需求C P0-1/P0-2：开通退款订单导入通路 → 读 25 列对象数组落 refundOrderSession。
        //   🔴 资金红线：refundOrderSession 是退款回填引擎入参源（run 阶段 main.js 注入）；重导整体覆盖。
        //   读取复用 readLinkedRowsAsObjects（按 signature.expectedHeaders zip，退款签名 25 列）。
        try {
          const refundSignature = PREPROCESS_TABLE_SIGNATURES.find((s) => s.tableKey === 'zhongtai-refund-order');
          const refundRows = readLinkedRowsAsObjects(filePath, refundSignature, detected.sheetName);
          refundOrderSession = { fileName, rows: refundRows, importedAt: Date.now() };
          // v2.1.16-beta.6 PR#65 Finding1（🔴 资金红线）：导入/覆盖退款订单后清运行结果，强制重新运行，
          //   否则导出仍用上一轮旧的 refundBackfillRows/refundUnmatchedRows（跨批复用）。
          processingResult = null;
          refundImportedThisBatch = true; // 标记本批已导退款 → 银行对账单分支不再清它
          // v3.0.7 需求2d：退款订单走预处理（落 refundOrderSession，R5 退款回填数据源）→ outcome:'processed'。
          results.push({ fileName, tableKey, status: 'ok', outcome: 'processed', rowCount: refundRows.length });
        } catch (refundErr) {
          results.push({
            fileName,
            tableKey,
            status: 'read-error',
            message: refundErr && refundErr.message ? refundErr.message : String(refundErr)
          });
        }
        continue;
      }

      if (tableKey === 'intake-original-order') {
        if (!INTAKE_ORIGINAL_BATCH_ENABLED) {
          results.push({
            fileName,
            tableKey,
            status: 'disabled',
            message: '入账原始反回填功能未启用，已跳过'
          });
          continue;
        }
        // 占位：功能开关开启后在此实装入账原始订单读取/落库（本阶段不会走到）
        results.push({ fileName, tableKey, status: 'disabled', message: '入账原始反回填功能未启用，已跳过' });
        continue;
      }

      // v3.0.7 需求2d（🔴🔴 资金红线）：scope='linked' 表（中台调拨订单 / 网关对账单 / 外汇交割表 / 外汇期权表）
      //   → 走对应链接表落库 + 派生（复用 importLinkedFileToRepo，与「链接表管理」按钮 linked-table:import 同源；零改派生口径）。
      //   detector tableKey → repo tableKey 映射 + 取 linked 签名（与 linked-table:import 同口径）。
      //   fx-option 已在上方 unsupported 分支拦截（detectTableType 标 unsupported）；此处仍守卫缺失映射/签名（双保险）。
      const linkedRepoKey = LINKED_DETECTOR_TO_REPO_KEY[tableKey];
      const linkedSignature = getLinkedSignatureByKey(tableKey);
      if (linkedRepoKey && linkedSignature && tableKey !== 'fx-option') {
        // 落库 ≠ 跳过：mid-allocation / gateway-bill / fx-settlement 落库即写对应链接表（+ 派生），
        //   bank-statement:run 阶段自动读回喂 R1-R5（gateway-bill→R1/C3/R5、mid-allocation→R5s2/DBS）。
        //   独立 try/catch：落库异常记 write-error（与 linked-table:import 错误契约一致）。
        try {
          const okResult = await importLinkedFileToRepo({
            filePath,
            fileName,
            detected,
            repoKey: linkedRepoKey,
            signature: linkedSignature
          });
          results.push(okResult);
        } catch (linkedErr) {
          results.push({
            fileName,
            tableKey: linkedRepoKey,
            status: 'write-error',
            message: linkedErr && linkedErr.message ? linkedErr.message : String(linkedErr)
          });
        }
        continue;
      }

      // 理论不可达（ALL_TABLE_SIGNATURES 的 tableKey 已被上述分支全覆盖；fx-option 走 unsupported）；守卫记明细
      results.push({ fileName, tableKey, status: 'unrecognized', message: `未知表类型：${tableKey}` });
    }

    return { status: 'ok', results };
    } finally {
      // v3.0.11 需求3（批1）：无论 cancelled / ok / 抛错，导入结束统一释放互斥锁。
      releaseBankStatementOpLock();
    }
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
    // v3.0.5 PR-3：双源 listMonths（侧库目录 month + 主库旧表 month 合并；历史 run 零变化）
    try {
      return acquiringRunData.listMonthsDualSource({ userDataDir: path.dirname(database.dbPath), mainDb: database.db });
    } catch (_e) { return []; }
  });

  ipcMain.handle('acquiringBillCurrency:sessionStatus', (_event, payload = {}) => {
    if (!database || !database.db) return { monthKey: null, flowReady: false, billReady: false };
    const { monthKey } = payload || {};
    try {
      // v3.0.5 PR-3：双源 sessionStatus（侧库存在 → 读侧库 readiness + 主库 runs 镜像；否则读主库旧表）
      return acquiringRunData.getSessionStatusDualSource({
        userDataDir: path.dirname(database.dbPath),
        mainDb: database.db,
        monthKey
      });
    } catch (_e) {
      return { monthKey: monthKey || null, flowReady: false, billReady: false };
    }
  });

  // fix1（spec §3.4）：importFlow / importBill 改造为三段式
  //   1. 首调（无 payload）：弹 dialog → peek → 查 existingCount → 0 直接进事务；>0 返回 overwrite-required
  //   2. 二次调（{ preparedContextId, confirmOverwrite: true }）：复用主进程预检上下文并复核后，进"单侧清+导入"事务
  //   3. 异常分支：cancelled / error 携带 detailLines
  // fix3 → fix9 → fix10：通用 operation lock 提到 module-level（line 200 附近），import/run/export/cleanup
  // 互斥；cleanup 异步后台跑也持锁；fix10 启动钩子也共享同一把锁，避免 cleanup vs 用户首次 import 并发
  const tryAcquireOpLock = tryAcquireAcquiringBillCurrencyOpLock;
  const releaseOpLock = releaseAcquiringBillCurrencyOpLock;
  const acquiringImportPreviewContexts = new Map();

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

  // v3.0.8 需求3：bank-statement run 进度转发器已内联到 bank-statement:run handler（main.js:3665 附近）——
  //   该 handler 与本收单模块 register 函数不在同一作用域，故不在此处定义命名 helper（避免跨作用域 not defined）。

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

  async function prepareAcquiringImport(kind, payload = {}) {
    const isFlow = kind === 'flow';
    if (!database || !database.db) {
      return { proceed: false, result: { status: 'error', message: '数据库未初始化' } };
    }
    const monthKey = payload.monthKey;
    if (!monthKey || !/^\d{4}-\d{2}$/.test(monthKey)) {
      return {
        proceed: false,
        result: {
          status: 'error',
          message: '缺少月份参数（请先在弹窗中选择对账月份）',
          detailLines: []
        }
      };
    }
    const userDataDir = path.dirname(database.dbPath);
    let filePaths;
    let overwrite = false;
    let previewContext = null;
    if (payload.confirmOverwrite === true) {
      previewContext = acquiringImportPreviewContexts.get(
        String(payload.preparedContextId || '').trim()
      );
      if (!previewContext
          || previewContext.kind !== kind
          || previewContext.monthKey !== monthKey) {
        return {
          proceed: false,
          result: {
            status: 'error',
            message: '覆盖导入预检已失效，请重新选择文件',
            detailLines: []
          }
        };
      }
      filePaths = previewContext.filePaths;
      overwrite = true;
    } else {
      const res = await showImportOpenDialog('acquiring-bill-currency', {
        title: isFlow
          ? `选择收单流水表（月份 ${monthKey}，可多选）`
          : `选择收单流水单据表（月份 ${monthKey}，可多选）`,
        filters: [{ name: 'Excel', extensions: ['xlsx'] }],
        properties: ['openFile', 'multiSelections']
      });
      if (res.canceled || !res.filePaths || res.filePaths.length === 0) {
        return { proceed: false, result: { status: 'cancelled' } };
      }
      filePaths = res.filePaths;
    }

    let peeked;
    let assertSourceFresh;
    try {
      assertSourceFresh = previewContext
        ? previewContext.assertSourceFresh
        : createPreviewSourceFreshnessGuard(filePaths, '收单导入');
      assertSourceFresh();
      peeked = await acquiringRunData.peekImportTarget({
        userDataDir,
        kind,
        filePaths
      });
      assertSourceFresh();
    } catch (err) {
      return {
        proceed: false,
        result: {
          status: 'error',
          message: err && err.message ? err.message : String(err),
          detailLines: err && err.detailLines ? err.detailLines : []
        }
      };
    }
    if (peeked.monthKey !== monthKey) {
      return {
        proceed: false,
        result: {
          status: 'error',
          message: `文件月份 ${peeked.monthKey} 与所选月份 ${monthKey} 不一致，请检查选择`,
          detailLines: [`首文件解析月份：${peeked.monthKey}`, `用户选择月份：${monthKey}`]
        }
      };
    }
    if (!overwrite && peeked.existingCount > 0) {
      const preparedContextId = randomUUID();
      acquiringImportPreviewContexts.clear();
      acquiringImportPreviewContexts.set(preparedContextId, {
        kind,
        monthKey,
        filePaths: filePaths.slice(),
        existingCount: peeked.existingCount,
        assertSourceFresh
      });
      return {
        proceed: false,
        result: {
          status: 'overwrite-required',
          kind,
          monthKey,
          existingCount: peeked.existingCount,
          fileCount: filePaths.length,
          preparedContextId
        }
      };
    }
    if (overwrite && peeked.existingCount !== previewContext.existingCount) {
      return {
        proceed: false,
        result: {
          status: 'error',
          message: '收单待覆盖数据在确认期间已变化，请重新导入',
          detailLines: []
        }
      };
    }
    return {
      proceed: true,
      inputPaths: filePaths,
      kind,
      monthKey,
      userDataDir,
      filePaths,
      overwrite,
      preparedContextId: previewContext ? String(payload.preparedContextId) : '',
      async beforeStart() {
        assertSourceFresh();
        const currentPeek = await acquiringRunData.peekImportTarget({
          userDataDir,
          kind,
          filePaths
        });
        if (currentPeek.monthKey !== monthKey || currentPeek.existingCount !== peeked.existingCount) {
          throw new Error('收单导入预检证据在任务开始前已变化，请重新导入');
        }
        if (previewContext) {
          const current = acquiringImportPreviewContexts.get(String(payload.preparedContextId));
          if (current !== previewContext) {
            throw new Error('覆盖导入预检已失效，请重新导入');
          }
        }
      }
    };
  }

  async function executeAcquiringImport(event, prepared, batchContext) {
    const lock = tryAcquireOpLock('import', prepared.monthKey);
    if (!lock.acquired) return { status: 'error', message: lock.message, detailLines: [] };
    if (prepared.preparedContextId) {
      acquiringImportPreviewContexts.delete(prepared.preparedContextId);
    }
    try {
      try {
        const onProgress = createImportProgressForwarder(event);
        const result = await acquiringRunData.importFiles({
          userDataDir: prepared.userDataDir,
          kind: prepared.kind,
          monthKey: prepared.monthKey,
          filePaths: prepared.filePaths,
          onProgress,
          overwrite: prepared.overwrite,
          batchContext
        });
        return {
          status: 'success',
          ...(prepared.overwrite ? { overwritten: true } : {}),
          ...result
        };
      } catch (err) {
        return {
          status: 'error',
          message: err && err.message ? err.message : String(err),
          detailLines: err && err.detailLines ? err.detailLines : []
        };
      }
    } finally {
      releaseOpLock();
    }
  }

  trackedIpcHandle('acquiringBillCurrency:importFlow', '收单单据币种校验', '导入流水表', {
    prepare: (_event, payload = {}) => prepareAcquiringImport('flow', payload),
    execute: (event, prepared, taskContext) => executeAcquiringImport(
      event,
      prepared,
      taskContext.batchContext
    )
  });

  trackedIpcHandle('acquiringBillCurrency:importBill', '收单单据币种校验', '导入单据表', {
    prepare: (_event, payload = {}) => prepareAcquiringImport('bill', payload),
    execute: (event, prepared, taskContext) => executeAcquiringImport(
      event,
      prepared,
      taskContext.batchContext
    )
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
  trackedIpcHandle('acquiringBillCurrency:run', '收单单据币种校验', '开始运行', {
    async prepare(_event, payload = {}) {
      if (!database || !database.db) {
        return { proceed: false, result: { status: 'error', message: '数据库未初始化' } };
      }
      const { monthKey } = payload || {};
      if (!monthKey || !/^\d{4}-\d{2}$/.test(monthKey)) {
        return {
          proceed: false,
          result: { status: 'error', message: 'monthKey 格式错误（应为 YYYY-MM）' }
        };
      }
      const resumable = acquiringRunData.findBoundResumableRun({
        userDataDir: path.dirname(database.dbPath),
        mainDb: database.db,
        mainDbPath: database.dbPath,
        monthKey
      });
      if (resumable) {
        const repository = archiveCenterService
          && archiveCenterService.service
          && archiveCenterService.service.repository;
        if (!repository) {
          return {
            proceed: false,
            result: {
              status: 'resume-required',
              code: 'ACQUIRING_RUN_RESUME_REQUIRED',
              message: `${monthKey} 存在未完成的可恢复运行；存档身份暂不可核验，请先恢复存档中心后续跑原任务`,
              runId: resumable.runId
            }
          };
        }
        const batch = repository
          ? repository.getBatch(resumable.batchContext.batchId)
          : null;
        const sameIdentity = batch
          && String(batch.taskRunId || '') === resumable.batchContext.taskRunId
          && String(batch.operationKey || '') === resumable.batchContext.operationKey
          && String(batch.parentRunId || '') === resumable.batchContext.parentRunId
          && String(batch.moduleId || '') === resumable.batchContext.moduleId;
        if (!batch || !sameIdentity || ['reserved', 'running'].includes(String(batch.taskStatus || ''))) {
          return {
            proceed: false,
            result: {
              status: 'resume-required',
              code: 'ACQUIRING_RUN_RESUME_REQUIRED',
              message: !batch || !sameIdentity
                ? `${monthKey} 的可恢复运行与存档身份不一致，已停止新运行以保留审计证据`
                : `${monthKey} 存在未完成的可恢复运行，请先续跑原任务`,
              runId: resumable.runId
            }
          };
        }
      }
      const lock = tryAcquireOpLock('run', monthKey);
      if (!lock.acquired) {
        return { proceed: false, result: { status: 'busy', message: lock.message } };
      }
      let released = false;
      const releaseLock = () => {
        if (released) return;
        released = true;
        releaseOpLock();
      };
      return {
        proceed: true,
        monthKey,
        userDataDir: path.dirname(database.dbPath),
        onAbandon: releaseLock,
        releaseLock
      };
    },
    async execute(event, prepared, taskContext) {
    const { monthKey } = prepared;
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
      // v3.0.5 PR-3（Part B Phase 1）：worker pool dispatch __dbPath 改为「该月侧库路径」
      //   - acquiringRunData.runCheckViaSideDb 内：__dbPath = run-data/{module}/month-{monthKey}.sqlite
      //     → worker 自开侧库连接跑 runCheckCore（5 阶段/JOIN/epsilon 零改动，三表同库自洽）
      //     → 成功后把 summary + 路径 + side_db_rel_path 镜像写主库 runs（UI/导出读主库镜像）
      //   - dbPath 切月：worker pool dispatchRunCheck 内检测 workerDbPath≠新侧库 → 重启 worker 重 init
      //   - onLog：worker 内 appendModuleLog → message pipe → 主进程 appendActivityLogEntry
      //   - chunkSize / workerCount / tempDir 透传不变（多 worker 子 worker 也用侧库 dbPath）
      result = await acquiringRunData.runCheckViaSideDb({
        userDataDir: prepared.userDataDir,
        monthKey,
        storageRoot,
        chunkSize,
        workerCount,
        tempDir: mwTempDir,
        batchContext: taskContext.batchContext,
        mainDb: database.db,
        dispatchFn: runCheckWorkerPool.dispatchRunCheck,
        dispatchCallbacks: {
          onProgress,
          onLog: (entry) => {
            try {
              appendActivityLogEntry(entry || {});
            } catch (_e) { /* swallow — log forwarder 失败不阻塞业务 */ }
          },
        },
      });
    } catch (err) {
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
    } finally {
      prepared.releaseLock();
    }
    // v0.12 fix9：release run lock，setImmediate 异步分批清理（不阻塞 handler return）
    // v2.1.8 N1：β 方案 — cleanup 移出对账链路，runCheck 内已 markCleanupPending=1，
    //   不再 setImmediate 立即触发；交 app.before-quit（主清）+ 进入模块时（兜底清）
    //   保留 result.cleanupNeeded 字段（向后兼容；前端不消费此字段）
    // v2.1.7 F7-B1：success 路径弹通知（spec §7.5.2）
    notifyAcquiringBillCurrencyResult(monthKey, 'success', { mismatchRows: result.mismatchRows });
    return { status: 'success', ...result };
    }
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
  trackedIpcHandle('acquiringBillCurrency:run:resume', '收单单据币种校验', '续跑（chunked resume）', {
    async prepare(_event, payload = {}) {
      if (!database || !database.db) {
        return { proceed: false, result: { status: 'error', message: '数据库未初始化' } };
      }
      const { monthKey, runId } = payload || {};
      if (!monthKey || !/^\d{4}-\d{2}$/.test(monthKey)) {
        return {
          proceed: false,
          result: { status: 'error', message: 'monthKey 格式错误（应为 YYYY-MM）' }
        };
      }
      const lock = tryAcquireOpLock('run', monthKey);
      if (!lock.acquired) {
        return { proceed: false, result: { status: 'busy', message: lock.message } };
      }
      let released = false;
      const releaseLock = () => {
        if (released) return;
        released = true;
        releaseOpLock();
      };
      try {
        const resumePlan = acquiringRunData.prepareRunResume({
          userDataDir: path.dirname(database.dbPath),
          mainDb: database.db,
          mainDbPath: database.dbPath,
          monthKey,
          runId
        });
        return {
          proceed: true,
          resumePlan,
          recovery: resumePlan.recovery,
          taskRunId: resumePlan.taskRunId,
          operationKey: resumePlan.operationKey,
          flowPlan: resumePlan.flowPlan,
          onAbandon: releaseLock,
          releaseLock,
          beforeStart: () => acquiringRunData.assertRunResumeFresh({
            userDataDir: path.dirname(database.dbPath),
            mainDb: database.db,
            mainDbPath: database.dbPath,
            prepared: resumePlan
          })
        };
      } catch (err) {
        releaseLock();
        return {
          proceed: false,
          result: { status: 'error', message: err && err.message ? err.message : String(err) }
        };
      }
    },
    async execute(event, prepared, taskContext) {
      const { resumePlan } = prepared;
      const { monthKey, runId: targetRunId, progress } = resumePlan;
      let result;
      try {
        if (!resumePlan.recovery.batchContext) {
          acquiringRunData.persistRunResumeBatchContext({
            userDataDir: path.dirname(database.dbPath),
            mainDb: database.db,
            prepared: resumePlan,
            batchContext: taskContext.batchContext
          });
        }
        const storageRoot = ensureStorageRoot();
        const onProgress = createRunProgressForwarder(event);
        // v2.1.10 SR-FIX-1 Round 6 H4：resume 时 chunkSize 优先从 chunk_progress 复用
        //   用户中途修改 settings 时仍必须沿原 chunk offset 继续；老 progress 缺值才 fallback settings。
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
          // 老 partial run（升级前的 chunk_progress 没 chunkSize 字段）→ fallback 当前 settings
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

        result = await acquiringRunData.resumeRunCheck({
          prepared: resumePlan,
          storageRoot,
          chunkSize,
          batchContext: taskContext.batchContext,
          mainDb: database.db,
          dispatchFn: runCheckWorkerPool.dispatchRunCheck,
          dispatchCallbacks: {
            onProgress,
            onLog: (entry) => {
              try { appendActivityLogEntry(entry || {}); } catch (_e) { /* swallow */ }
            },
          }
        });
      } catch (err) {
        // v2.1.10 SR-FIX-1 round 2 P1-4：CancelError 走 cancelled 路径（同 run handler）
        if (err && err.name === 'CancelError') {
          notifyAcquiringBillCurrencyResult(monthKey, 'cancelled', { stage: err.stage });
          return { status: 'cancelled', resumed: true, message: err.message, stage: err.stage };
        }
        notifyAcquiringBillCurrencyResult(monthKey, 'error', { message: err && err.message });
        return { status: 'error', message: err && err.message ? err.message : String(err) };
      } finally {
        prepared.releaseLock();
      }
      notifyAcquiringBillCurrencyResult(monthKey, 'success', { mismatchRows: result.mismatchRows });
      return { status: 'success', resumed: true, ...result };
    }
  });

  // v0.8 fix5：export = 另存为最近 run 的 diff.xlsx（fs.copyFile）
  // v0.12 fix9：handler 接入 operation lock
  trackedIpcHandle('acquiringBillCurrency:export', '收单单据币种校验', '导出差异', {
    async prepare(_event, payload = {}) {
      if (!database || !database.db) {
        return { proceed: false, result: { status: 'error', message: '数据库未初始化' } };
      }
      const { monthKey } = payload || {};
      if (!monthKey || !/^\d{4}-\d{2}$/.test(monthKey)) {
        return { proceed: false, result: { status: 'error', message: 'monthKey 格式错误' } };
      }
      let exportPlan;
      try {
        exportPlan = acquiringRunData.prepareRunExport({
          userDataDir: path.dirname(database.dbPath),
          mainDb: database.db,
          monthKey
        });
      } catch (error) {
        return {
          proceed: false,
          result: { status: 'error', message: error && error.message ? error.message : String(error) }
        };
      }
      const res = await dialog.showSaveDialog({
        title: '导出差异表另存为',
        defaultPath: path.basename(exportPlan.diffFilePath),
        filters: [{ name: 'Excel', extensions: ['xlsx'] }]
      });
      if (res.canceled || !res.filePath) {
        return { proceed: false, result: { status: 'cancelled' } };
      }
      return {
        proceed: true,
        outputPaths: [res.filePath],
        monthKey,
        exportPlan,
        flowPlan: exportPlan.flowPlan,
        savePath: res.filePath,
        beforeStart() {
          acquiringRunData.assertRunExportFresh({
            userDataDir: path.dirname(database.dbPath),
            mainDb: database.db,
            prepared: exportPlan
          });
        }
      };
    },
    async execute(_event, prepared) {
    const { monthKey, exportPlan, savePath } = prepared;
    const lock = tryAcquireOpLock('export', monthKey);
    if (!lock.acquired) return { status: 'error', message: lock.message };
    try {
      fs.copyFileSync(exportPlan.diffFilePath, savePath);
      return {
        status: 'success',
        runId: exportPlan.runId,
        source: exportPlan.source,
        monthKey,
        savedPath: savePath,
        sourceDiffPath: exportPlan.diffFilePath
      };
    } catch (err) {
      return { status: 'error', message: err && err.message ? err.message : String(err) };
    } finally {
      releaseOpLock();
    }
    }
  });

  businessIpcHandle('acquiringBillCurrency:clearMonth', '清空月份数据', (_event, payload = {}) => {
    if (!database || !database.db) return { status: 'error', message: '数据库未初始化' };
    const { monthKey } = payload || {};
    if (!monthKey || !/^\d{4}-\d{2}$/.test(monthKey)) {
      return { status: 'error', message: 'monthKey 格式错误' };
    }
    try {
      // v3.0.5 PR-3：clearMonth 双源——侧库存在 → 删整月侧库文件 + 主库镜像行（文件级回收）。
      //   codex PR#73 复审修复 P3：升级过渡库同月可能主库仍有 legacy imports 行；只删侧库后
      //   listMonthsDualSource 会回退主库 legacy 致该月 stale 重现 → 无论侧库是否存在都一并清主库
      //   legacy（acquiringBillCurrencySession.clearMonth 幂等，无 legacy 则删 0 行）。
      const userDataDir = path.dirname(database.dbPath);
      if (runDataStore.sideDbExists(userDataDir, acquiringRunData.MODULE, monthKey)) {
        acquiringRunData.deleteMonthSideDb({ userDataDir, mainDb: database.db, monthKey });
      }
      acquiringBillCurrencySession.clearMonth({ db: database.db, monthKey });
      return { status: 'success' };
    } catch (err) {
      return { status: 'error', message: err && err.message ? err.message : String(err) };
    }
  });
}

function getPreFundReconciliationService() {
  if (!database || !database.db) {
    throw new Error('数据库尚未初始化，请稍后重试');
  }
  if (!preFundReconciliationService) {
    preFundReconciliationService = createPreFundReconciliationService({
      userDataDir: path.dirname(database.dbPath),
      database,
      templatePath: path.join(__dirname, '..', 'assets', '资金对账导出不平.xlsx')
    });
  }
  return preFundReconciliationService;
}

function schedulePreFundReconciliationStartupCleanup() {
  setImmediate(() => {
    try {
      getPreFundReconciliationService();
    } catch (error) {
      appendActivityLogEntry({
        level: 'error',
        source: 'main',
        domain: 'pre-fund-reconciliation',
        message: '前置资金对账启动结果回收失败',
        details: [error && error.message ? error.message : String(error)],
        stack: error && error.stack ? error.stack : undefined
      });
    }
  });
}

function preFundFailureResult(error) {
  return {
    status: 'failed',
    code: error && error.code ? String(error.code) : 'pre-fund-reconciliation-failed',
    message: error && error.message ? String(error.message) : String(error),
    detailLines: error && Array.isArray(error.detailLines) ? error.detailLines : []
  };
}

function sendPreFundProgress(event, channel, payload) {
  try {
    if (event && event.sender && !event.sender.isDestroyed()) event.sender.send(channel, payload);
  } catch (_error) { /* renderer 已关闭时忽略进度 */ }
}

function preFundErrorReportFileName(value = new Date()) {
  const pad = (number) => String(number).padStart(2, '0');
  return `MPT临时链接表错误数据_${value.getFullYear()}${pad(value.getMonth() + 1)}${pad(value.getDate())}_${pad(value.getHours())}${pad(value.getMinutes())}${pad(value.getSeconds())}.xlsx`;
}

// v3.0.14：前置资金对账 IPC。所有写/运行/导出与现有资金模块共用 bankStatementOperationLock，
// 避免 linked_gateway_bill 变更与快照构建交错。
function registerPreFundReconciliationHandlers() {
  ipcMain.handle('pre-fund-reconciliation:session-status', async () => {
    try {
      return getPreFundReconciliationService().status();
    } catch (error) {
      return preFundFailureResult(error);
    }
  });

  trackedIpcHandle('pre-fund-reconciliation:import-bank', '前置资金对账', '导入银行对账单', {
    async prepare() {
      const choice = await showImportOpenDialog('pre-fund-reconciliation', {
        title: '导入标准银行对账单',
        properties: ['openFile'],
        filters: [{ name: 'Excel', extensions: ['xlsx', 'xls'] }]
      });
      if (choice.canceled || !choice.filePaths || choice.filePaths.length === 0) {
        return { proceed: false, result: { status: 'cancelled' } };
      }
      return { proceed: true, inputPaths: [choice.filePaths[0]], filePath: choice.filePaths[0] };
    },
    async execute(_event, prepared) {
    const lock = tryAcquireBankStatementOpLock('pre-fund-import-bank');
    if (!lock.acquired) return { status: 'busy', message: lock.message };
    try {
      return getPreFundReconciliationService().importBank(prepared.filePath);
    } catch (error) {
      return preFundFailureResult(error);
    } finally {
      releaseBankStatementOpLock();
    }
    }
  });

  trackedIpcHandle('pre-fund-reconciliation:import-mpt', '前置资金对账', '导入临时网关账单', {
    async prepare() {
      const choice = await showImportOpenDialog('pre-fund-reconciliation', {
        title: '导入 MPT 网关账单（可多选）',
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: 'MPT 网关账单', extensions: ['txt', 'gz'] }]
      });
      if (choice.canceled || !choice.filePaths || choice.filePaths.length === 0) {
        return { proceed: false, result: { status: 'cancelled' } };
      }
      return { proceed: true, inputPaths: choice.filePaths, filePaths: choice.filePaths };
    },
    async execute(event, prepared) {
    const lock = tryAcquireBankStatementOpLock('pre-fund-import-mpt');
    if (!lock.acquired) return { status: 'busy', message: lock.message };
    try {
      return await getPreFundReconciliationService().importMptFiles(
        prepared.filePaths,
        (progress) => sendPreFundProgress(event, 'pre-fund-reconciliation:import-progress', progress)
      );
    } catch (error) {
      return preFundFailureResult(error);
    } finally {
      releaseBankStatementOpLock();
    }
    }
  });

  trackedIpcHandle('pre-fund-reconciliation:mpt-errors:export', '前置资金对账', '导出临时网关错误数据', {
    async prepare(_event, repairTokens = []) {
      const choice = await dialog.showSaveDialog(mainWindow, {
        title: '导出临时网关账单错误数据',
        defaultPath: path.join(app.getPath('documents'), preFundErrorReportFileName()),
        filters: [{ name: 'Excel 工作簿', extensions: ['xlsx'] }]
      });
      if (choice.canceled || !choice.filePath) {
        return { proceed: false, result: { status: 'cancelled' } };
      }
      return {
        proceed: true,
        outputPaths: [choice.filePath],
        repairTokens: Array.isArray(repairTokens) ? repairTokens.slice() : [],
        savePath: choice.filePath
      };
    },
    async execute(_event, prepared) {
    const lock = tryAcquireBankStatementOpLock('pre-fund-export-mpt-errors');
    if (!lock.acquired) return { status: 'busy', message: lock.message };
    try {
      return await getPreFundReconciliationService().exportMptErrorData(
        prepared.repairTokens,
        prepared.savePath
      );
    } catch (error) {
      return preFundFailureResult(error);
    } finally {
      releaseBankStatementOpLock();
    }
    }
  });

  trackedIpcHandle('pre-fund-reconciliation:mpt-errors:repair', '前置资金对账', '删除临时网关错误数据并重跑', async (event, repairTokens = []) => {
    const lock = tryAcquireBankStatementOpLock('pre-fund-repair-mpt-errors');
    if (!lock.acquired) return { status: 'busy', message: lock.message };
    try {
      const service = getPreFundReconciliationService();
      const sourcePaths = service.resolveMptImportFailures(repairTokens).map((failure) => failure.filePath);
      const result = await service.retryMptImportFailures(
        repairTokens,
        (progress) => sendPreFundProgress(event, 'pre-fund-reconciliation:import-progress', progress)
      );
      Object.defineProperty(result, 'archivedSourcePaths', {
        value: selectSuccessfulPathsByResultIndex(sourcePaths, result.results),
        enumerable: false
      });
      return result;
    } catch (error) {
      return preFundFailureResult(error);
    } finally {
      releaseBankStatementOpLock();
    }
  });

  ipcMain.handle('pre-fund-reconciliation:temp:list', async () => {
    try {
      return { status: 'ok', batches: getPreFundReconciliationService().listTempBatches() };
    } catch (error) {
      return preFundFailureResult(error);
    }
  });

  trackedIpcHandle('pre-fund-reconciliation:temp:delete', '前置资金对账', '删除临时批次', async (_event, payload = {}) => {
    const lock = tryAcquireBankStatementOpLock('pre-fund-delete-temp');
    if (!lock.acquired) return { status: 'busy', message: lock.message };
    try {
      return { status: 'ok', ...await getPreFundReconciliationService().deleteTempBatch(payload) };
    } catch (error) {
      return preFundFailureResult(error);
    } finally {
      releaseBankStatementOpLock();
    }
  });

  ipcMain.handle('pre-fund-reconciliation:temp:count-by-date-range', async (_event, payload = {}) => {
    try {
      const result = getPreFundReconciliationService().countTempByDateRange(payload);
      return { status: 'ok', count: result.rowCount, batchCount: result.batchCount };
    } catch (error) {
      return preFundFailureResult(error);
    }
  });

  trackedIpcHandle(
    'pre-fund-reconciliation:temp:delete-by-date-range',
    '前置资金对账',
    '按日期删除临时链接表',
    async (_event, payload = {}) => {
      const lock = tryAcquireBankStatementOpLock('pre-fund-delete-temp-by-date-range');
      if (!lock.acquired) return { status: 'busy', message: lock.message };
      try {
        const result = await getPreFundReconciliationService().deleteTempByDateRange(payload);
        return { status: 'ok', deleted: result.deletedRows, ...result };
      } catch (error) {
        return preFundFailureResult(error);
      } finally {
        releaseBankStatementOpLock();
      }
    }
  );

  trackedIpcHandle('pre-fund-reconciliation:temp:clear', '前置资金对账', '清空临时链接表', async () => {
    const lock = tryAcquireBankStatementOpLock('pre-fund-clear-temp');
    if (!lock.acquired) return { status: 'busy', message: lock.message };
    try {
      return { status: 'ok', ...await getPreFundReconciliationService().clearTemp() };
    } catch (error) {
      return preFundFailureResult(error);
    } finally {
      releaseBankStatementOpLock();
    }
  });

  trackedIpcHandle('pre-fund-reconciliation:run', '前置资金对账', '开始运行', async (event, payload = {}) => {
    const lock = tryAcquireBankStatementOpLock('pre-fund-run');
    if (!lock.acquired) return { status: 'busy', message: lock.message };
    try {
      return await getPreFundReconciliationService().run({
        scenario: payload && payload.scenario,
        onProgress: (progress) => sendPreFundProgress(event, 'pre-fund-reconciliation:run-progress', progress)
      });
    } catch (error) {
      return preFundFailureResult(error);
    } finally {
      releaseBankStatementOpLock();
    }
  });

  trackedIpcHandle('pre-fund-reconciliation:export', '前置资金对账', '导出文件', {
    async prepare() {
      const choice = await showImportOpenDialog('pre-fund-reconciliation-export', {
        title: '选择前置资金对账导出目录',
        properties: ['openDirectory', 'createDirectory']
      });
      if (choice.canceled || !choice.filePaths || choice.filePaths.length === 0) {
        return { proceed: false, result: { status: 'cancelled' } };
      }
      try {
        const service = getPreFundReconciliationService();
        const outputDirectory = choice.filePaths[0];
        const exportDate = new Date();
        const plan = service.buildExportPlan(outputDirectory, exportDate);
        if (plan.length === 0) {
          return {
            proceed: false,
            result: preFundFailureResult(Object.assign(
              new Error('本次运行没有可导出的银行渠道'),
              { code: 'pre-fund-export-empty' }
            ))
          };
        }
        const conflicts = plan.filter((item) => fs.existsSync(item.filePath));
        let overwrite = false;
        if (conflicts.length > 0) {
          const conflictNames = conflicts.map((item) => item.fileName).join('\n');
          const confirm = await dialog.showMessageBox(mainWindow, {
            type: 'warning',
            title: '文件已存在',
            message: `以下文件已存在：\n${conflictNames}`,
            detail: '是否覆盖本次全部冲突文件？取消后不会写入任何文件。',
            buttons: ['取消', '覆盖全部'],
            defaultId: 0,
            cancelId: 0,
            noLink: true
          });
          if (confirm.response !== 1) {
            return { proceed: false, result: { status: 'cancelled' } };
          }
          overwrite = true;
        }
        const conflictPaths = conflicts.map((item) => item.filePath).sort();
        return {
          proceed: true,
          outputPaths: plan.map((item) => item.filePath),
          outputDirectory,
          exportDate,
          overwrite,
          beforeStart() {
            const currentPlan = service.buildExportPlan(outputDirectory, exportDate);
            const currentConflicts = currentPlan
              .filter((item) => fs.existsSync(item.filePath))
              .map((item) => item.filePath)
              .sort();
            if (JSON.stringify(currentPlan.map((item) => item.filePath))
                !== JSON.stringify(plan.map((item) => item.filePath))
                || JSON.stringify(currentConflicts) !== JSON.stringify(conflictPaths)) {
              throw new Error('前置资金对账导出计划在确认期间已变化，请重新导出');
            }
          }
        };
      } catch (error) {
        return { proceed: false, result: preFundFailureResult(error) };
      }
    },
    async execute(event, prepared) {
    const lock = tryAcquireBankStatementOpLock('pre-fund-export');
    if (!lock.acquired) return { status: 'busy', message: lock.message };
    try {
      const service = getPreFundReconciliationService();
      const options = {
        outputDirectory: prepared.outputDirectory,
        overwrite: prepared.overwrite,
        exportDate: prepared.exportDate,
        onProgress: (progress) => sendPreFundProgress(event, 'pre-fund-reconciliation:export-progress', progress)
      };
      return await service.export(options);
    } catch (error) {
      return preFundFailureResult(error);
    } finally {
      releaseBankStatementOpLock();
    }
    }
  });
}

function getDuplicateInboundMatchService() {
  if (!database || !database.db) {
    throw new Error('数据库尚未初始化，请稍后重试');
  }
  if (!duplicateInboundMatchService) {
    duplicateInboundMatchService = createDuplicateInboundMatchService({
      userDataDir: path.dirname(database.dbPath),
      database,
      mailTemplatePath: path.join(__dirname, '..', 'assets', '重复入金召回邮件模板.xlsx'),
      bankTemplatePath: path.join(__dirname, '..', 'assets', '银行对账单.xlsx')
    });
  }
  return duplicateInboundMatchService;
}

function scheduleDuplicateInboundMatchStartupCleanup() {
  setImmediate(() => {
    try {
      getDuplicateInboundMatchService();
    } catch (error) {
      appendActivityLogEntry({
        level: 'error',
        source: 'main',
        domain: 'duplicate-inbound-match',
        message: '重复入金匹配启动结果回收失败',
        details: [error && error.message ? error.message : String(error)],
        stack: error && error.stack ? error.stack : undefined
      });
    }
  });
}

function duplicateInboundMatchFailureResult(error) {
  return {
    status: 'failed',
    code: error && error.code ? String(error.code) : 'duplicate-inbound-match-failed',
    message: error && error.message ? String(error.message) : String(error),
    detailLines: error && Array.isArray(error.detailLines) ? error.detailLines : []
  };
}

function sendDuplicateInboundMatchProgress(event, channel, payload) {
  try {
    if (event && event.sender && !event.sender.isDestroyed()) event.sender.send(channel, payload);
  } catch (_error) { /* renderer 已关闭时忽略进度 */ }
}

// v3.0.15：重复入金匹配与临时 MPT 导入/删除共用资金模块锁，确保运行快照稳定。
function registerDuplicateInboundMatchHandlers() {
  ipcMain.handle('duplicate-inbound-match:session-status', async () => {
    try {
      return getDuplicateInboundMatchService().status();
    } catch (error) {
      return duplicateInboundMatchFailureResult(error);
    }
  });

  trackedIpcHandle('duplicate-inbound-match:import-files', '重复入金匹配', '导入文件', {
    async prepare() {
      const choice = await showImportOpenDialog('duplicate-inbound-match', {
        title: '同时选择银行对账单和单据对账单',
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: 'Excel', extensions: ['xlsx', 'xls'] }]
      });
      if (choice.canceled || !choice.filePaths || choice.filePaths.length === 0) {
        return { proceed: false, result: { status: 'cancelled' } };
      }
      return { proceed: true, inputPaths: choice.filePaths, filePaths: choice.filePaths };
    },
    async execute(event, prepared) {
    const lock = tryAcquireBankStatementOpLock('duplicate-inbound-import-files');
    if (!lock.acquired) return { status: 'busy', message: lock.message };
    try {
      return await getDuplicateInboundMatchService().importFiles(
        prepared.filePaths,
        (progress) => sendDuplicateInboundMatchProgress(
          event,
          'duplicate-inbound-match:import-progress',
          progress
        )
      );
    } catch (error) {
      return duplicateInboundMatchFailureResult(error);
    } finally {
      releaseBankStatementOpLock();
    }
    }
  });

  trackedIpcHandle('duplicate-inbound-match:run', '重复入金匹配', '开始运行', async (event) => {
    const lock = tryAcquireBankStatementOpLock('duplicate-inbound-run');
    if (!lock.acquired) return { status: 'busy', message: lock.message };
    try {
      return await getDuplicateInboundMatchService().run({
        onProgress: (progress) => sendDuplicateInboundMatchProgress(
          event,
          'duplicate-inbound-match:run-progress',
          progress
        )
      });
    } catch (error) {
      return duplicateInboundMatchFailureResult(error);
    } finally {
      releaseBankStatementOpLock();
    }
  });

  trackedIpcHandle('duplicate-inbound-match:export', '重复入金匹配', '导出文件', {
    async prepare() {
      const service = getDuplicateInboundMatchService();
      const choice = await dialog.showSaveDialog(mainWindow, {
        title: '导出重复入金匹配结果',
        defaultPath: service.buildDefaultFileName(),
        filters: [{ name: 'Excel', extensions: ['xlsx'] }]
      });
      if (choice.canceled || !choice.filePath) {
        return { proceed: false, result: { status: 'cancelled' } };
      }
      return { proceed: true, outputPaths: [choice.filePath], savePath: choice.filePath };
    },
    async execute(event, prepared) {
    const lock = tryAcquireBankStatementOpLock('duplicate-inbound-export');
    if (!lock.acquired) return { status: 'busy', message: lock.message };
    try {
      return await getDuplicateInboundMatchService().export({
        savePath: prepared.savePath,
        onProgress: (progress) => sendDuplicateInboundMatchProgress(
          event,
          'duplicate-inbound-match:export-progress',
          progress
        )
      });
    } catch (error) {
      return duplicateInboundMatchFailureResult(error);
    } finally {
      releaseBankStatementOpLock();
    }
    }
  });
}

function readPositionPendingOperation() {
  const raw = database && database.db
    ? database.getSetting(POSITION_SIDE_DB_PENDING_SETTING)
    : '';
  if (!raw) return null;
  let pending;
  try {
    pending = JSON.parse(raw);
  } catch (_error) {
    throw new Error('主库中的平盘待完成操作记录损坏');
  }
  if (!pending || typeof pending !== 'object' || Array.isArray(pending)) {
    throw new Error('主库中的平盘待完成操作记录格式非法');
  }
  return pending;
}

function writePositionPendingOperation(pending, operationToken) {
  const current = readPositionPendingOperation();
  if (!current || current.operationToken !== operationToken) {
    throw new Error('平盘待完成操作所有权已变化');
  }
  database.setSetting(POSITION_SIDE_DB_PENDING_SETTING, JSON.stringify(pending));
}

function capturePositionArchiveFileSnapshot(filePath) {
  try {
    return sourceSnapshotFromStat(fs.statSync(filePath));
  } catch (_error) {
    return null;
  }
}

function recordPositionArchiveIntentFiles(filePaths, role, explicitOperationToken = '') {
  const context = positionReconciliationOperationContext.getStore();
  const operationToken = String(
    explicitOperationToken || (context && context.operationToken) || ''
  ).trim();
  if (!operationToken || !Array.isArray(filePaths) || filePaths.length === 0) return;
  const pending = readPositionPendingOperation();
  if (!pending || pending.operationToken !== operationToken || !pending.archiveRequired) {
    return;
  }
  const seen = new Set(
    (Array.isArray(pending.archiveFiles) ? pending.archiveFiles : []).map(
      (file) => `${file.role || ''}\u0000${file.filePath || ''}`
    )
  );
  const archiveFiles = Array.isArray(pending.archiveFiles)
    ? pending.archiveFiles.slice()
    : [];
  for (const value of filePaths) {
    const descriptor = value && typeof value === 'object' && !Array.isArray(value)
      ? value
      : { filePath: value };
    const rawPath = String(descriptor.filePath || '').trim();
    if (!rawPath) continue;
    const filePath = path.resolve(rawPath);
    const key = `${role}\u0000${filePath}`;
    if (seen.has(key)) continue;
    const archiveFile = role === 'input'
      ? {
          filePath,
          role,
          sourceType: String(descriptor.sourceType || '').trim(),
          sourceSnapshot: descriptor.sourceSnapshot,
          sha256: descriptor.expectedSha256 || descriptor.sha256,
          sizeBytes: descriptor.sizeBytes
        }
      : {
          filePath,
          role,
          beforeSnapshot: capturePositionArchiveFileSnapshot(filePath),
          ...(descriptor.sourceSnapshot ? {
            sourceSnapshot: descriptor.sourceSnapshot,
            sha256: descriptor.expectedSha256 || descriptor.sha256,
            sizeBytes: descriptor.sizeBytes
          } : {}),
          artifactKey: String(descriptor.artifactKey || '').trim(),
          sourceOperation: String(descriptor.sourceOperation || '').trim(),
          originalName: String(descriptor.originalName || path.basename(filePath)),
          requiredInputPaths: descriptor.requiredInputPaths,
          metadata: descriptor.metadata && typeof descriptor.metadata === 'object'
            ? descriptor.metadata
            : {}
        };
    const normalized = requirePositionPendingArchiveFiles({
      archiveFiles: [archiveFile]
    })[0];
    seen.add(key);
    archiveFiles.push(normalized);
  }
  writePositionPendingOperation({
    ...pending,
    archiveState: archiveFiles.length > 0 ? 'intent-recorded' : pending.archiveState,
    archiveFiles
  }, operationToken);
}

function markPositionBusinessOutcome(result) {
  const context = positionReconciliationOperationContext.getStore();
  if (!context) return;
  const pending = readPositionPendingOperation();
  if (!pending || pending.operationToken !== context.operationToken) return;
  writePositionPendingOperation({
    ...pending,
    businessState: positionBusinessStateForResult(result, SUCCESS_STATUSES),
    terminalOutcome: positionTerminalOutcomeForResult(result, SUCCESS_STATUSES)
  }, context.operationToken);
}

function persistPositionCancellationAccepted(active) {
  const operationToken = String(active && active.operationToken || '').trim();
  const pending = readPositionPendingOperation();
  if (!pending || pending.operationToken !== operationToken) {
    throw new Error('平盘取消确认时待完成操作所有权已变化');
  }
  const cancellation = positionCancellationAcceptedPending(
    pending,
    '用户取消平盘对账导入任务'
  );

  // SQLite pending 是取消 ACK 的第一份耐久真相。即使随后主进程崩溃，
  // startup recovery 也会把原 exact-seven 批次收口为 cancelled，而不是 failed。
  writePositionPendingOperation(cancellation, operationToken);

  // 同时把 cancelled 终态写入既有 Archive outbox；直接 CAS 或后续业务
  // promise 尚未来得及返回时，仍能在下一次启动重放到同一 batchId。
  const center = archiveCenterService || initializeArchiveCenter();
  center.persistTaskTerminalIntent({
    batchContext: cancellation.batchContext,
    sourceOperation: String(cancellation.channel || active.channel || 'position-reconciliation'),
    terminalOutcome: {
      ...cancellation.terminalOutcome,
      metadata: { positionCancellationAccepted: true },
      afterTerminal: {
        route: 'position-reconciliation',
        operationToken
      }
    }
  });

  return archiveTaskLifecycle
    ? archiveTaskLifecycle.cancelActive(
        (context) => Boolean(
          context.moduleId === 'position-reconciliation-process'
          && context.taskRunId === operationToken
        ),
        cancellation.terminalOutcome.message
      )
    : null;
}

function markPositionArchiveDurable(archiveResult = {}) {
  const context = positionReconciliationOperationContext.getStore();
  if (!context) return;
  const pending = readPositionPendingOperation();
  if (!pending || pending.operationToken !== context.operationToken || !pending.archiveRequired) {
    return;
  }
  writePositionPendingOperation({
    ...pending,
    archiveState: 'durable',
    archiveReference: archiveResult.batchId || archiveResult.outboxId || ''
  }, context.operationToken);
}

function markPositionArchiveIncomplete(archiveResult = {}) {
  const context = positionReconciliationOperationContext.getStore();
  if (!context) return;
  const pending = readPositionPendingOperation();
  if (!pending || pending.operationToken !== context.operationToken || !pending.archiveRequired) {
    return;
  }
  writePositionPendingOperation({
    ...pending,
    archiveState: 'incomplete',
    archiveWarning: archiveResult && archiveResult.warning
      ? String(archiveResult.warning.message || '')
      : '存档未形成持久重试记录'
  }, context.operationToken);
}

function readDeletedPositionArchiveResult(pending) {
  try {
    const center = archiveCenterService || initializeArchiveCenter();
    const repository = center && center.service && center.service.repository;
    if (!repository) return null;
    const policy = taskPolicyRegistry.get(String(pending.channel || ''));
    const moduleId = policy && policy.scopeId;
    if (!moduleId) return null;
    const operationKey = `position:${pending.operationToken}:${pending.channel}`;
    const issuance = repository.getOperationIssuance(moduleId, operationKey);
    return issuance && issuance.deletedAt
      ? {
          batchId: issuance.batchId,
          operationKey,
          persisted: false,
          operationStatus: 'deleted',
          code: 'ARCHIVE_OPERATION_DELETED'
        }
      : null;
  } catch (_error) {
    return null;
  }
}

function positionArchiveIntentEvidence(pending, currentCheckpoint) {
  return evaluatePositionArchiveIntentEvidence(pending, currentCheckpoint, {
    statSync: fs.statSync,
    sourceSnapshotFromStat,
    sourceSnapshotMatchesStat
  });
}

function persistPositionArchiveIntentIfNeeded(
  pending,
  currentCheckpoint,
  service = positionReconciliationService,
  options = {}
) {
  if (!pending) return null;
  const files = requirePositionPendingArchiveFiles(pending);
  const archiveRequired = pending.archiveRequired === true
    || (
      pending.archiveRequired === undefined
      && archiveOperationTracker
      && archiveOperationTracker.supportsChannel(pending.channel)
    );
  if (!archiveRequired) return null;
  if (pending.archiveState === 'durable') {
    if (options.includeCleanupCandidates !== true
        || !service
        || typeof service.listCommittedOperationInputs !== 'function') {
      return null;
    }
    const committedFiles = positionCommittedRecoveryArchiveFiles(
      { ...pending, archiveFiles: files },
      service.listCommittedOperationInputs(pending.operationToken)
    );
    const archiveResult = readDeletedPositionArchiveResult(pending);
    return {
      archiveResult,
      cleanupInputPaths: positionRecoveryCleanupInputPaths(
        { ...pending, archiveFiles: files },
        committedFiles,
        archiveResult
      )
    };
  }
  const evidence = positionArchiveIntentEvidence(pending, currentCheckpoint);
  if (!evidence.requiresPersistence) {
    return options.includeCleanupCandidates === true
      ? {
          archiveResult: null,
          cleanupInputPaths: positionRecoveryCleanupInputPaths(
            { ...pending, archiveFiles: files },
            [],
            null
          )
        }
      : null;
  }
  if (!service || typeof service.listCommittedOperationInputs !== 'function') {
    throw new Error('平盘业务已提交但无法读取文件级提交凭证，已停止恢复');
  }
  const committedInputs = service.listCommittedOperationInputs(pending.operationToken);
  const committedFiles = positionCommittedRecoveryArchiveFiles(
    { ...pending, archiveFiles: files },
    committedInputs
  );
  if (committedFiles.length === 0 || !archiveCenterService
      || typeof archiveCenterService.persistAppendIntent !== 'function') {
    throw new Error('平盘业务已提交但存档意图不完整，已停止恢复以避免审计文件丢失');
  }
  assertPositionRecoveryInputsUnchanged(
    { archiveFiles: committedFiles },
    assertStagedInputUnchanged
  );
  const recoveryFiles = positionRecoveryArchiveFiles(
    { archiveFiles: committedFiles },
    { captureOutputSnapshot: capturePositionArchiveFileSnapshot }
  );
  const batchContext = pending.batchContext;
  if (!batchContext || typeof batchContext !== 'object') {
    throw new Error('平盘业务已提交但缺少原任务 batchContext，禁止建立幽灵批次');
  }
  const archiveResult = archiveCenterService.persistAppendIntent({
    batchContext,
    sourceOperation: String(pending.channel || ''),
    metadata: { positionOperationToken: pending.operationToken, recovered: true },
    files: recoveryFiles,
    terminalOutcome: positionOutboxTerminalIntent(pending)
  });
  return options.includeCleanupCandidates === true
    ? {
        archiveResult,
        cleanupInputPaths: positionRecoveryCleanupInputPaths(
          { ...pending, archiveFiles: files },
          committedFiles,
          archiveResult
        )
      }
    : archiveResult;
}

function recoverPositionArchiveIntent(pending, currentCheckpoint, service) {
  return persistPositionArchiveIntentIfNeeded(
    pending,
    currentCheckpoint,
    service,
    { includeCleanupCandidates: true }
  );
}

function clearPositionPendingOperation(operationToken) {
  const pending = readPositionPendingOperation();
  if (!pending || pending.operationToken !== operationToken) {
    throw new Error('平盘待完成操作所有权已变化，禁止清理其他操作记录');
  }
  database.setSetting(POSITION_SIDE_DB_PENDING_SETTING, '');
}

async function finalizePositionPendingAfterTaskTerminal({ context }) {
  const pending = readPositionPendingOperation();
  if (!pending) return;
  if (pending.operationToken !== context.taskRunId
      || Number(pending.batchContext && pending.batchContext.batchId) !== context.batchId) {
    throw new Error('平盘任务终态后的 pending 所有权已变化');
  }
  if (pending.archiveRequired === true && pending.archiveState !== 'durable') {
    // 存档尚未完成时保留 pending；后续启动恢复只能追加原 batch。
    return;
  }
  clearPositionPendingOperation(pending.operationToken);
}

async function finalizeRecoveredPositionPending(operationToken, options = {}) {
  const pending = readPositionPendingOperation();
  if (!pending || pending.operationToken !== operationToken) {
    throw new Error('平盘恢复 pending 所有权已变化');
  }
  if (options.archiveDurable === true && pending.archiveRequired === true
      && pending.archiveState !== 'durable') {
    writePositionPendingOperation({
      ...pending,
      archiveState: 'durable',
      archiveReference: options.archiveReference || ''
    }, operationToken);
  }
  const current = readPositionPendingOperation();
  const deletedArchiveResult = options.archiveResult
    && options.archiveResult.code === 'ARCHIVE_OPERATION_DELETED'
      ? options.archiveResult
      : readDeletedPositionArchiveResult(current);
  if (current.archiveRequired === true && current.archiveState !== 'durable'
      && !deletedArchiveResult) {
    throw new Error('平盘恢复存档尚未完成，禁止终结原任务或清理 pending');
  }
  const center = archiveCenterService || initializeArchiveCenter();
  if (!center || !center.service) throw new Error('平盘恢复缺少存档服务');
  if (!deletedArchiveResult && options.terminalSettled !== true) {
    await settlePositionRecoveredTask({
      pending: current,
      archiveService: center.service
    });
  }
  if (!positionReconciliationService) {
    throw new Error('平盘侧库尚未初始化，禁止提前清理恢复 pending');
  }
  if (typeof positionReconciliationService.listCommittedOperationInputs !== 'function') {
    throw new Error('平盘侧库无法读取当前操作的文件级提交凭证，禁止清理恢复 pending');
  }
  const committedFiles = positionCommittedRecoveryArchiveFiles(
    current,
    positionReconciliationService.listCommittedOperationInputs(operationToken)
  );
  const cleanupInputPaths = positionRecoveryCleanupInputPaths(
    current,
    committedFiles,
    deletedArchiveResult
  );
  syncPositionReconciliationCheckpoint();
  database.setSetting(POSITION_SIDE_DB_BOOTSTRAP_SETTING, '');
  clearPositionPendingOperation(operationToken);
  try {
    await cleanupPositionArchiveSourcePaths(cleanupInputPaths);
  } catch (_error) {
    // 原任务、checkpoint 与 pending 已完成收口；暂存清理失败留待后续启动回收。
  }
}

function positionOutboxTerminalIntent(pending) {
  const outcome = positionRecoveryTerminalOutcome(pending);
  const operationToken = String(pending && pending.operationToken || '').trim();
  return {
    ...outcome,
    metadata: {
      recoveredPositionOperation: true,
      positionOperationToken: operationToken,
      positionTerminalOutcome: outcome.taskStatus
    },
    afterTerminal: {
      route: 'position-reconciliation',
      operationToken
    }
  };
}

function resolvePositionOutboxTerminalIntent(record) {
  const payload = record && record.payload;
  const targetBatchId = Number(payload && payload.targetBatchId);
  const operationToken = String(
    payload && payload.metadata && payload.metadata.positionOperationToken || ''
  ).trim();
  if (!Number.isSafeInteger(targetBatchId) || targetBatchId < 1 || !operationToken) return null;
  const pending = readPositionPendingOperation();
  if (!pending || pending.operationToken !== operationToken) return null;
  if (Number(pending.batchContext && pending.batchContext.batchId) !== targetBatchId) {
    throw new Error('平盘 outbox 目标批次与 pending 原任务不一致');
  }
  return positionOutboxTerminalIntent(pending);
}

async function finalizePositionTerminalIntent({ route, record, created }) {
  if (!route || route.route !== 'position-reconciliation') {
    throw new Error(`不支持的任务终态收口路由：${route && route.route || '<empty>'}`);
  }
  const payload = record && record.payload;
  const targetBatchId = Number(payload && payload.targetBatchId);
  const operationToken = String(route.operationToken || '').trim();
  const recordOperationToken = String(
    payload && payload.metadata && payload.metadata.positionOperationToken || ''
  ).trim();
  if (!Number.isSafeInteger(targetBatchId) || targetBatchId < 1
      || !operationToken || recordOperationToken !== operationToken) {
    throw new Error('平盘任务终态路由与 outbox 身份不一致');
  }
  const pending = readPositionPendingOperation();
  if (!pending) return;
  if (pending.operationToken !== operationToken
      || Number(pending.batchContext && pending.batchContext.batchId) !== targetBatchId) {
    throw new Error('平盘 outbox 目标批次与 pending 原任务不一致');
  }
  await finalizeRecoveredPositionPending(operationToken, {
    archiveDurable: true,
    archiveReference: created && created.batch && created.batch.id || targetBatchId,
    terminalSettled: true
  });
}

function persistCurrentPositionArchiveIntentIfNeeded() {
  const context = positionReconciliationOperationContext.getStore();
  if (!context) return null;
  const pending = readPositionPendingOperation();
  if (!pending || pending.operationToken !== context.operationToken) {
    throw new Error('平盘待完成操作所有权已变化，无法登记存档恢复任务');
  }
  const currentCheckpoint = positionReconciliationService
    ? positionReconciliationService.persistenceCheckpoint()
    : pending.baseCheckpoint || {};
  return persistPositionArchiveIntentIfNeeded(
    pending,
    currentCheckpoint,
    positionReconciliationService
  );
}

async function resolvePositionAnomalyReportReference(report = {}) {
  const stagedPath = String(report.reportFilePath || '').trim();
  if (stagedPath) {
    try {
      const stat = await fs.promises.stat(stagedPath);
      const expectedSize = Number(report.reportSizeBytes);
      const expectedSha256 = String(report.reportSha256 || '').trim().toLowerCase();
      if (stat.isFile() && Number(stat.size) === expectedSize) {
        const actual = await hashFileSha256Async(stagedPath);
        if (actual.sha256 === expectedSha256 && actual.sizeBytes === expectedSize) {
          return { filePath: stagedPath };
        }
      }
    } catch (_error) {
      // 导入暂存已回收或无法验证时，继续从锁定的存档批次恢复同一份报告。
    }
  }
  const center = archiveCenterService || initializeArchiveCenter();
  const repository = center && center.service && center.service.repository;
  const operationKey = String(report.archiveOperationKey || '').trim();
  const artifactKey = String(report.reportArtifactKey || '').trim();
  const batch = repository && operationKey
    ? repository.getBatchByOperationKey('position-reconciliation-process', operationKey)
    : null;
  const artifact = batch && artifactKey
    ? repository.getArtifactByKey(batch.id, artifactKey)
    : null;
  if (!artifact || artifact.status !== 'ready') {
    throw new PositionReconciliationError(
      'position-anomaly-report-integrity-invalid',
      '异常报告暂存已不存在，且存档中心没有可用的审计副本'
    );
  }
  const readonly = await center.service.openReadonlyCopy(artifact.id, {
    opener: async () => ''
  });
  if (!readonly || readonly.ok === false || !readonly.filePath) {
    throw new PositionReconciliationError(
      'position-anomaly-report-integrity-invalid',
      '无法从存档中心恢复异常报告',
      [readonly && readonly.message ? readonly.message : '存档副本不可用']
    );
  }
  return { filePath: readonly.filePath };
}

function getPositionReconciliationService() {
  if (!database || !database.db) {
    throw new Error('数据库尚未初始化，请稍后重试');
  }
  if (!positionReconciliationService) {
    const expectedSideDbCheckpoint = database.getSetting(
      POSITION_SIDE_DB_CHECKPOINT_SETTING
    );
    const pendingSideDbOperation = database.getSetting(
      POSITION_SIDE_DB_PENDING_SETTING
    );
    let initialSideDbCheckpoint = null;
    if (!expectedSideDbCheckpoint) {
      initialSideDbCheckpoint = database.getSetting(POSITION_SIDE_DB_BOOTSTRAP_SETTING);
      if (!initialSideDbCheckpoint) {
        initialSideDbCheckpoint = JSON.stringify({
          identity: randomUUID(),
          generation: 0,
          token: randomUUID()
        });
        database.setSetting(POSITION_SIDE_DB_BOOTSTRAP_SETTING, initialSideDbCheckpoint);
      }
    }
    let service = null;
    try {
      service = createPositionReconciliationService({
        userDataDir: path.dirname(database.dbPath),
        templatePath: path.join(__dirname, '..', 'assets', '平盘银行对账单.xlsx'),
        requireExistingSideDb: Boolean(expectedSideDbCheckpoint),
        expectedSideDbCheckpoint,
        expectedPendingOperation: pendingSideDbOperation,
        initialSideDbCheckpoint,
        operationTokenProvider: () => {
          const operation = positionReconciliationOperationContext.getStore();
          return operation && operation.operationToken;
        },
        recordArchiveIntent: (filePaths, role) => {
          recordPositionArchiveIntentFiles(filePaths, role);
        },
        protectedStagingPaths: positionArchivePersistentStagingPaths,
        positionImportEngine: 'streaming',
        resolveAnomalyReport: resolvePositionAnomalyReportReference,
        onImportProgress: (progress) => {
          try {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send(
                'position-reconciliation:import-progress',
                progress
              );
            }
          } catch (_error) {
            // Renderer may be closing while the utility process settles.
          }
        },
        authorizeStreamingSourceApply: async (preflightReady) => {
          const migration = dispatchPositionLargeImportSchemaMigration({
            engine: 'streaming',
            userDataDir: path.dirname(database.dbPath),
            sideDbPath: service.store.dbPath,
            expectedCheckpoint: service.persistenceCheckpoint()
          });
          const schema = await migration.promise;
          return authorizePositionImportApply({
            preflightReady,
            currentCheckpoint: service.persistenceCheckpoint(),
            schemaFingerprint: schema.fingerprint,
            readPending: readPositionPendingOperation,
            writePending: writePositionPendingOperation,
            recordArchiveIntentFiles: recordPositionArchiveIntentFiles
          });
        }
      });
      const checkpoint = service.persistenceCheckpoint();
      const recovery = recoverPositionArchiveIntent(
        pendingSideDbOperation ? readPositionPendingOperation() : null,
        checkpoint,
        service
      );
      positionReconciliationService = service;
      if (pendingSideDbOperation) {
        const pending = readPositionPendingOperation();
        const operationToken = String(pending && pending.operationToken || '');
        const archiveResult = recovery && recovery.archiveResult;
        const recoveryTask = archiveResult
          && archiveResult.code !== 'ARCHIVE_OPERATION_DELETED'
          ? (archiveCenterService || initializeArchiveCenter()).flushOutbox()
          : finalizeRecoveredPositionPending(operationToken, {
              archiveDurable: true,
              archiveReference: archiveResult && archiveResult.batchId
                || pending && pending.archiveReference
                || '',
              archiveResult
            });
        trackArchiveOperationPromise(Promise.resolve(recoveryTask).catch((error) => {
          appendActivityLogEntry({
            level: 'error',
            source: 'main',
            domain: 'position-reconciliation-recovery',
            message: '平盘原任务恢复尚未完成，pending 已保留',
            details: [error && error.message ? error.message : String(error)]
          });
        }));
      } else {
        database.setSetting(
          POSITION_SIDE_DB_CHECKPOINT_SETTING,
          JSON.stringify(checkpoint)
        );
        database.setSetting(POSITION_SIDE_DB_BOOTSTRAP_SETTING, '');
        database.setSetting(POSITION_SIDE_DB_PENDING_SETTING, '');
      }
      const initializationResult = service.store
        && typeof service.store.initializationResult === 'function'
        ? service.store.initializationResult()
        : { mode: 'unknown' };
      appendActivityLogEntry({
        level: 'info',
        source: 'main',
        domain: 'position-reconciliation-side-db-init',
        message: '平盘侧库初始化完成',
        details: [`mode=${String(initializationResult.mode || 'unknown')}`]
      });
    } catch (error) {
      // 只记录结构化 code/reason，不写文件路径、账号、订单号或数据库明细。
      appendActivityLogEntry({
        level: 'error',
        source: 'main',
        domain: 'position-reconciliation-side-db-init',
        message: '平盘侧库初始化被拒绝',
        details: [
          `code=${String(error && error.code ? error.code : 'unknown')}`,
          `reason=${String(error && error.reason ? error.reason : '未提供结构化校验原因')}`
        ]
      });
      if (service) service.close();
      throw error;
    }
  }
  return positionReconciliationService;
}

function syncPositionReconciliationCheckpoint() {
  if (!database || !database.db || !positionReconciliationService) return;
  database.setSetting(
    POSITION_SIDE_DB_CHECKPOINT_SETTING,
    JSON.stringify(positionReconciliationService.persistenceCheckpoint())
  );
}

async function runPositionReconciliationOperation(channel, operation, options = {}) {
  if (positionReconciliationOperationActive) {
    return {
      status: 'busy',
      code: 'position-operation-busy',
      message: '平盘对账正在完成上一项操作，请稍后重试'
    };
  }
  let service;
  let baseCheckpoint;
  const operationToken = String(options.operationToken || randomUUID());
  positionReconciliationOperationActive = { operationToken, channel };
  try {
    service = getPositionReconciliationService();
    const unresolvedPending = database.getSetting(POSITION_SIDE_DB_PENDING_SETTING);
    if (unresolvedPending) {
      throw new Error('上一项平盘对账操作的 checkpoint 尚未完成同步，请重启软件恢复后再试');
    }
    baseCheckpoint = service.persistenceCheckpoint();
    const archiveRequired = Boolean(
      archiveOperationTracker && archiveOperationTracker.supportsChannel(channel)
    );
    return await runPositionOperationLifecycle({
      operationToken,
      pending: {
        operationToken,
        channel,
        batchContext: options.batchContext || null,
        baseCheckpoint,
        archiveRequired,
        archiveState: archiveRequired ? 'awaiting-intent' : 'not-required',
        businessState: 'running',
        terminalOutcome: null,
        archiveFiles: []
      },
      writeInitialPending: (pending) => {
        database.setSetting(POSITION_SIDE_DB_PENDING_SETTING, JSON.stringify(pending));
      },
      runInContext: (task) => positionReconciliationOperationContext.run(
        { operationToken },
        task
      ),
      operation,
      readPending: () => JSON.parse(
        database.getSetting(POSITION_SIDE_DB_PENDING_SETTING) || 'null'
      ),
      syncCheckpoint: syncPositionReconciliationCheckpoint,
      clearPending: () => {
        database.setSetting(POSITION_SIDE_DB_PENDING_SETTING, '');
      },
      failureResult: positionReconciliationFailureResult,
      deferPendingClear: true
    });
  } catch (error) {
    return positionReconciliationFailureResult(error);
  } finally {
    if (positionReconciliationOperationActive
        && positionReconciliationOperationActive.operationToken === operationToken) {
      positionReconciliationOperationActive = null;
    }
  }
}

async function withPositionReconciliationLock(operation, task) {
  const lock = tryAcquireBankStatementOpLock(`position-reconciliation-${operation}`);
  if (!lock.acquired) return { status: 'busy', message: lock.message };
  try {
    return await task();
  } catch (error) {
    return positionReconciliationFailureResult(error);
  } finally {
    releaseBankStatementOpLock();
  }
}

function positionReconciliationExportName(prefix) {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  const stamp = [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    pad(now.getHours()),
    pad(now.getMinutes())
  ].join('');
  return `${stamp}_${sanitizeFileName(prefix)}.xlsx`;
}

function registerPositionReconciliationHandlers() {
  const sourceImportTaskContract = createPositionSourceImportTaskContract({
    pickFiles: () => showImportOpenDialog('position-reconciliation-linked-source', {
      title: '导入链接原始表',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Excel', extensions: ['xlsx', 'xls'] }]
    }),
    getService: getPositionReconciliationService,
    withSourceLock: (task) => withPositionReconciliationLock('source-import', task)
  });
  const runTaskContract = createPositionRunTaskContract({
    getService: getPositionReconciliationService,
    withRunLock: (task) => withPositionReconciliationLock('run', task),
    createContextId: randomUUID
  });
  ipcMain.handle('position-reconciliation:status', () => {
    try {
      return getPositionReconciliationService().status();
    } catch (error) {
      return positionReconciliationFailureResult(error);
    }
  });
  ipcMain.handle('position-reconciliation:data-manager', () => {
    try {
      return getPositionReconciliationService().dataManager();
    } catch (error) {
      return positionReconciliationFailureResult(error);
    }
  });
  ipcMain.handle('position-reconciliation:linked-manager', () => {
    try {
      return getPositionReconciliationService().linkedManager();
    } catch (error) {
      return positionReconciliationFailureResult(error);
    }
  });
  ipcMain.handle('position-reconciliation:mappings:list', () => {
    try {
      return getPositionReconciliationService().listMappings();
    } catch (error) {
      return positionReconciliationFailureResult(error);
    }
  });

  ipcMain.handle(
    'position-reconciliation:bank:prepare-import',
    () => withPositionReconciliationLock('bank-import', async () => {
      const choice = await showImportOpenDialog('position-reconciliation-bank', {
        title: '导入平盘银行对账单',
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: 'Excel', extensions: ['xlsx', 'xls'] }]
      });
      if (choice.canceled || !choice.filePaths || choice.filePaths.length === 0) {
        return { status: 'cancelled' };
      }
      return getPositionReconciliationService().prepareBankImport(choice.filePaths);
    })
  );

  trackedIpcHandle(
    'position-reconciliation:bank:apply-import',
    '平盘对账数据处理',
    '导入银行对账单',
    {
      execute: (_event, _prepared, taskContext, token) => (
        withPositionReconciliationLock('bank-import-apply', () => {
          const service = getPositionReconciliationService();
          recordPositionArchiveIntentFiles(service.bankImportArchiveIntent(token), 'input');
          return service.applyBankImport(token, taskContext.batchContext);
        })
      )
    }
  );

  ipcMain.handle('position-reconciliation:bank:cancel-import', async () => {
    try {
      return await getPositionReconciliationService().cancelBankImport();
    } catch (error) {
      return positionReconciliationFailureResult(error);
    }
  });

  trackedIpcHandle(
    'position-reconciliation:source:prepare-import',
    '平盘对账数据处理',
    '导入链接原始表',
    sourceImportTaskContract
  );

  trackedIpcHandle(
    'position-reconciliation:source:apply-import',
    '平盘对账数据处理',
    '导入链接原始表',
    {
      execute: (_event, _prepared, taskContext, token) => (
        withPositionReconciliationLock('source-import-apply', () => {
          const service = getPositionReconciliationService();
          recordPositionArchiveIntentFiles(service.sourceImportArchiveIntent(token), 'input');
          return service.applySourceImport(token, taskContext.batchContext);
        })
      )
    }
  );

  ipcMain.handle('position-reconciliation:source:cancel-import', async (_event, token) => {
    try {
      return await getPositionReconciliationService().cancelSourceImport(token);
    } catch (error) {
      return positionReconciliationFailureResult(error);
    }
  });

  trackedIpcHandle('position-reconciliation:source:export-anomaly', '平盘对账数据处理', '导出异常报告', {
    async prepare(_event, reportKey) {
      const service = getPositionReconciliationService();
      const choice = await dialog.showSaveDialog(mainWindow, {
        title: '导出链接原始表异常数据',
        defaultPath: service.defaultAnomalyReportFileName(reportKey),
        filters: [{ name: 'Excel', extensions: ['xlsx'] }]
      });
      if (choice.canceled || !choice.filePath) {
        return { proceed: false, result: { status: 'cancelled' } };
      }
      return { proceed: true, outputPaths: [choice.filePath], reportKey, savePath: choice.filePath };
    },
    execute: (_event, prepared) => withPositionReconciliationLock(
      'source-anomaly-export',
      () => {
        recordPositionArchiveIntentFiles([prepared.savePath], 'output');
        return getPositionReconciliationService().exportAnomalyReport(
          prepared.reportKey,
          prepared.savePath
        );
      }
    )
  });

  ipcMain.handle('position-reconciliation:import:cancel', async (_event, jobId) => {
    try {
      const active = positionReconciliationOperationActive;
      return getPositionReconciliationService().cancelActiveImport(
        jobId,
        () => (active ? persistPositionCancellationAccepted(active) : null)
      );
    } catch (error) {
      return positionReconciliationFailureResult(error);
    }
  });

  trackedIpcHandle(
    'position-reconciliation:mappings:save',
    '平盘对账数据处理',
    '账户映射管理',
    {
      execute: (_event, _prepared, taskContext, mappings) => (
        withPositionReconciliationLock('mapping-save', () => (
          getPositionReconciliationService().saveMappings(
            mappings,
            taskContext.batchContext
          )
        ))
      )
    }
  );

  trackedIpcHandle(
    'position-reconciliation:bank:delete',
    '平盘对账数据处理',
    '删除银行数据',
    {
      execute: (_event, _prepared, taskContext, payload = {}) => (
        withPositionReconciliationLock('bank-delete', () => (
          getPositionReconciliationService().deleteBank(
            payload,
            taskContext.batchContext
          )
        ))
      )
    }
  );

  trackedIpcHandle(
    'position-reconciliation:source:delete',
    '平盘对账数据处理',
    '删除链接原始表',
    {
      execute: (_event, _prepared, taskContext, payload = {}) => (
        withPositionReconciliationLock('source-delete', () => (
          getPositionReconciliationService().deleteSource(
            payload,
            taskContext.batchContext
          )
        ))
      )
    }
  );

  trackedIpcHandle(
    'position-reconciliation:bank:export',
    '平盘对账数据处理',
    '导出银行数据',
    {
      async prepare(_event, payload = {}) {
      const choice = await dialog.showSaveDialog(mainWindow, {
        title: '导出平盘银行对账单',
        defaultPath: positionReconciliationExportName('平盘银行对账单'),
        filters: [{ name: 'Excel', extensions: ['xlsx'] }]
      });
      if (choice.canceled || !choice.filePath) {
        return { proceed: false, result: { status: 'cancelled' } };
      }
      return { proceed: true, outputPaths: [choice.filePath], payload, savePath: choice.filePath };
      },
      execute: (_event, prepared) => withPositionReconciliationLock('bank-export', async () => {
        recordPositionArchiveIntentFiles([prepared.savePath], 'output');
        return getPositionReconciliationService().exportBank(prepared.payload, prepared.savePath);
      })
    }
  );

  trackedIpcHandle(
    'position-reconciliation:linked:export',
    '平盘对账数据处理',
    '导出链接对账表',
    {
      async prepare(_event, sourceType, tableName = '平盘链接对账表') {
        const choice = await dialog.showSaveDialog(mainWindow, {
          title: '导出链接对账表',
          defaultPath: positionReconciliationExportName(tableName),
          filters: [{ name: 'Excel', extensions: ['xlsx'] }]
        });
        if (choice.canceled || !choice.filePath) {
          return { proceed: false, result: { status: 'cancelled' } };
        }
        return { proceed: true, outputPaths: [choice.filePath], sourceType, savePath: choice.filePath };
      },
      execute: (_event, prepared) => withPositionReconciliationLock('linked-export', async () => {
        recordPositionArchiveIntentFiles([prepared.savePath], 'output');
        return getPositionReconciliationService().exportLinked(prepared.sourceType, prepared.savePath);
      })
    }
  );

  trackedIpcHandle(
    'position-reconciliation:raw:export',
    '平盘对账数据处理',
    '导出链接原始表',
    {
      async prepare(_event, sourceType, tableName = '链接原始表') {
        const choice = await dialog.showSaveDialog(mainWindow, {
          title: '导出链接原始表',
          defaultPath: positionReconciliationExportName(tableName),
          filters: [{ name: 'Excel', extensions: ['xlsx'] }]
        });
        if (choice.canceled || !choice.filePath) {
          return { proceed: false, result: { status: 'cancelled' } };
        }
        return { proceed: true, outputPaths: [choice.filePath], sourceType, savePath: choice.filePath };
      },
      execute: (_event, prepared) => withPositionReconciliationLock('raw-export', async () => {
        recordPositionArchiveIntentFiles([prepared.savePath], 'output');
        return getPositionReconciliationService().exportRaw(prepared.sourceType, prepared.savePath);
      })
    }
  );

  trackedIpcHandle(
    'position-reconciliation:run',
    '平盘对账数据处理',
    '开始运行',
    runTaskContract
  );

  trackedIpcHandle(
    'position-reconciliation:run:export',
    '平盘对账数据处理',
    '导出文件',
    {
      async prepare(_event, payload = {}) {
      const service = getPositionReconciliationService();
      const choice = await dialog.showSaveDialog(mainWindow, {
        title: payload.differencesOnly ? '导出平盘差异数据' : '导出平盘资金性质校验结果',
        defaultPath: payload.differencesOnly
          ? positionReconciliationExportName('平盘资金性质校验差异数据')
          : service.defaultResultFileName(),
        filters: [{ name: 'Excel', extensions: ['xlsx'] }]
      });
      if (choice.canceled || !choice.filePath) {
        return { proceed: false, result: { status: 'cancelled' } };
      }
      return { proceed: true, outputPaths: [choice.filePath], payload, savePath: choice.filePath };
      },
      execute: (_event, prepared) => withPositionReconciliationLock('result-export', async () => {
        const { payload, savePath } = prepared;
        recordPositionArchiveIntentFiles([savePath], 'output');
        return getPositionReconciliationService().exportRun(payload.runId, savePath, {
          differencesOnly: payload.differencesOnly === true,
          channels: Array.isArray(payload.channels) ? payload.channels : [],
          regions: Array.isArray(payload.regions) ? payload.regions : [],
          months: Array.isArray(payload.months) ? payload.months : [],
          differenceStatuses: Array.isArray(payload.differenceStatuses)
            ? payload.differenceStatuses
            : []
        });
      })
    }
  );

  trackedIpcHandle('position-reconciliation:run:export-filtered', '平盘对账数据处理', '导出筛选结果', {
    async prepare(_event, runId) {
      const service = getPositionReconciliationService();
      const choice = await dialog.showSaveDialog(mainWindow, {
        title: '导出平盘资金性质校验过滤数据',
        defaultPath: service.defaultFilteredResultFileName(runId),
        filters: [{ name: 'Excel', extensions: ['xlsx'] }]
      });
      if (choice.canceled || !choice.filePath) {
        return { proceed: false, result: { status: 'cancelled' } };
      }
      return { proceed: true, outputPaths: [choice.filePath], runId, savePath: choice.filePath };
    },
    execute: (_event, prepared) => withPositionReconciliationLock(
      'result-filtered-export',
      () => {
        recordPositionArchiveIntentFiles([prepared.savePath], 'output');
        return getPositionReconciliationService().exportRunFilteredSources(
          prepared.runId,
          prepared.savePath
        );
      }
    )
  });

  trackedIpcHandle(
    'position-reconciliation:run:import-result',
    '平盘对账数据处理',
    '导入修改结果',
    {
      async prepare(_event, runId) {
      const choice = await showImportOpenDialog('position-reconciliation-result', {
        title: '导入修改后的平盘资金性质校验结果',
        properties: ['openFile'],
        filters: [{ name: 'Excel', extensions: ['xlsx'] }]
      });
      if (choice.canceled || !choice.filePaths || choice.filePaths.length === 0) {
        return { proceed: false, result: { status: 'cancelled' } };
      }
      return {
        proceed: true,
        inputPaths: [choice.filePaths[0]],
        runId,
        filePath: choice.filePaths[0]
      };
      },
      execute: (_event, prepared) => withPositionReconciliationLock(
        'result-import',
        () => getPositionReconciliationService().importRunResult(
          prepared.runId,
          prepared.filePath
        )
      )
    }
  );

  trackedIpcHandle(
    'position-reconciliation:run:confirm',
    '平盘对账数据处理',
    '确认结果',
    (_event, runId) => withPositionReconciliationLock('result-confirm', () => (
      getPositionReconciliationService().confirmRun(runId)
    ))
  );
}

// 工具箱🧰（合表 / 拆表）3 个 IPC handler。
//   行级变换、流式读写和原子发布委托 main-process/toolbox* 模块；本处负责 dialog、IPC 编排、状态反馈和日志。
//
//   返回口径（前端对接契约，与现有 monthly-balance:export / bank-statement:import 范式一致）：
//     单文件成功 { status:'success', filePath }
//     多文件成功 { status:'success', files:[{filePath,fileName,matchedCount}] }
//     取消另存为 { status:'cancelled' }
//     失败     { status:'failed', message, detailLines }（表头不一致 / 空文件 / 字段缺失 / 运行错误）
//   trackedIpcHandle 仅在 status∈{ok,success} 时计 usage（取消/失败不计）。
//
// 把 catch 到的异常归一为 {status:'failed', message, detailLines}（FileValidationError / ToolboxHeaderMismatchError 带 detailLines）。
function toolboxFailureResult(error) {
  const message = error && error.message ? String(error.message) : String(error);
  const detailLines = error && Array.isArray(error.detailLines) ? error.detailLines.slice() : [];
  const detailSet = new Set(detailLines);
  for (const recoveryPath of error && Array.isArray(error.recoveryPaths) ? error.recoveryPaths : []) {
    const line = `恢复路径：${recoveryPath}`;
    if (!detailSet.has(line)) {
      detailSet.add(line);
      detailLines.push(line);
    }
  }
  return { status: 'failed', message, detailLines };
}

function shouldPreserveToolboxTemporaryFiles(error) {
  return Boolean(error && error.preserveTemporaryFiles === true);
}

function cleanupToolboxTemporaryDirectory(directoryPath) {
  try {
    fs.rmSync(directoryPath, { recursive: true, force: true });
    return true;
  } catch (error) {
    // 正式结果可能已经 durable committed。临时目录清理失败只能留下可观测告警，
    // 不能覆盖成功返回并诱导用户重复发布同一批文件。
    appendActivityLogEntry({
      level: 'warning',
      source: 'main',
      domain: 'toolbox',
      message: '工具箱临时目录清理失败',
      details: [
        `临时目录：${directoryPath}`,
        `原因：${error && error.message ? error.message : String(error)}`
      ],
      stack: error && error.stack ? error.stack : undefined
    });
    return false;
  }
}

const EMPTY_TOOLBOX_WARNING_SUMMARY = Object.freeze({
  warningCount: 0,
  warningSamples: Object.freeze([])
});

function aggregateToolboxWarningSummary(files) {
  let warningCount = 0;
  const warningSamples = [];
  for (const file of Array.isArray(files) ? files : []) {
    const summary = file && file.warningSummary;
    if (!summary || typeof summary !== 'object' || Array.isArray(summary)) continue;
    warningCount += Number(summary.warningCount) || 0;
    for (const sample of Array.isArray(summary.warningSamples) ? summary.warningSamples : []) {
      if (warningSamples.length >= 20) break;
      warningSamples.push({ ...sample });
    }
  }
  return { warningCount, warningSamples };
}

const TOOLBOX_STYLE_AUDIT_COMPONENTS = Object.freeze([
  'cellXfs',
  'fonts',
  'fills',
  'borders',
  'customNumFmts'
]);

function formatToolboxStyleAuditCounts(counts) {
  const source = counts && typeof counts === 'object' ? counts : {};
  return TOOLBOX_STYLE_AUDIT_COMPONENTS
    .map((key) => `${key}=${Number(source[key]) || 0}`)
    .join('，');
}

function buildToolboxAuditDetailLines(files, warningSummary = null) {
  const fileList = (Array.isArray(files) ? files : [files]).filter(Boolean);
  const summary = warningSummary && typeof warningSummary === 'object' && !Array.isArray(warningSummary)
    ? warningSummary
    : aggregateToolboxWarningSummary(fileList);
  const warningCount = Number(summary.warningCount) || 0;
  const samples = Array.isArray(summary.warningSamples)
    ? summary.warningSamples.slice(0, 20)
    : [];
  const details = [`日期文本降级总数：${warningCount}`];

  samples.forEach((sample, index) => {
    const location = [
      sample && sample.sourceFileName,
      sample && sample.sourceSheet,
      sample && sample.cellRef
    ].filter(Boolean).join(' / ');
    details.push(
      `日期文本降级样例 ${index + 1}${location ? `（${location}）` : ''}：` +
      `${(sample && sample.message) || '已按原文本保留'}`
    );
  });
  if (warningCount > samples.length) {
    details.push(`其余日期文本降级样例未展开：${warningCount - samples.length}`);
  }

  fileList.forEach((file, index) => {
    const label = file.fileName || file.outputId || file.filePath || `输出 ${index + 1}`;
    const styleStats = file.styleStats && typeof file.styleStats === 'object'
      ? file.styleStats
      : {};
    const projected = styleStats.projectedFinalCounts || styleStats.counts || {};
    const actual = styleStats.actualCounts || {};
    details.push(`[${label}] 样式预算预计：${formatToolboxStyleAuditCounts(projected)}`);
    details.push(`[${label}] 样式组件实际：${formatToolboxStyleAuditCounts(actual)}`);
    // 只有 commitAndValidate 已成功的临时产物才会进入可恢复发布，因此这里的“通过”是
    // 发布前结构、样式预算、文件大小与摘要校验的真实结果，不是乐观推断。
    details.push(`[${label}] 临时产物校验：通过`);
  });
  return details;
}

function publishToolboxArtifacts(kind, artifacts, targets) {
  return publishToolboxPublicationAsync({
    taskId: `toolbox-${kind}-${Date.now()}-${randomUUID()}`,
    artifacts,
    targets,
    userDataDir: app.getPath('userData')
  });
}

async function recoverToolboxPublicationsAtStartup() {
  try {
    const result = await recoverToolboxPublicationsAsync({
      userDataDir: app.getPath('userData')
    });
    const recovered = Array.isArray(result.recovered) ? result.recovered : [];
    if (recovered.length > 0) {
      appendActivityLogEntry({
        level: 'info',
        source: 'main',
        domain: 'toolbox',
        message: '工具箱输出发布恢复完成',
        details: recovered.map((item) => (
          `${item.taskId}：${item.action}`
        ))
      });
    }
  } catch (error) {
    appendActivityLogEntry({
      level: 'error',
      source: 'main',
      domain: 'toolbox',
      message: '工具箱输出发布自动恢复失败',
      details: [
        error && error.message ? error.message : String(error),
        ...(error && Array.isArray(error.detailLines) ? error.detailLines : []),
        ...(error && Array.isArray(error.recoveryPaths)
          ? error.recoveryPaths.map((filePath) => `恢复路径：${filePath}`)
          : [])
      ],
      stack: error && error.stack ? error.stack : undefined
    });
    // 固定恢复根损坏或自动恢复不完整时，不能继续注册 IPC/创建窗口。
    // 继续启动会允许用户生成新产物，直到发布阶段才再次失败，且可能掩盖人工恢复路径。
    throw error;
  }
}

function registerToolboxHandlers() {
  // IPC 1 —— 合表：单/多文件 → 每个可见非空 sheet 严格表头校验 → 按文件/标签/行顺序流式写临时 → 另存为。
  //   v3.0.19：.xlsx 逐 sheet 流式，.xls 一次加载工作簿后遍历可见 sheet，CSV 作为单表；隐藏/空 sheet 跳过。
  //   writer 沿用 by-name 格式与超 104 万行自动分页；IPC、默认文件名和前端流程不变。
  trackedIpcHandle('toolbox:merge', '工具箱', '合并表格', async () => {
    try {
      const choice = await showImportOpenDialog('toolbox', {
        title: '选择要合并的表格（多选，表头需完全一致）',
        properties: ['openFile', 'multiSelections'],
        filters: statementFileDialogFilters()
      });
      if (choice.canceled || !choice.filePaths || choice.filePaths.length === 0) {
        return { status: 'cancelled' };
      }
      const filePaths = choice.filePaths;
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'toolbox-'));
      const tempPath = path.join(tempDir, `toolbox-${Date.now()}.xlsx`);
      let preserveTempDir = false;
      try {
        const writeRes = await toolboxMergeFilesToXlsx({
          filePaths,
          savePath: tempPath,
          sheetBaseName: 'COMMON'
        });

        const saveResult = await dialog.showSaveDialog(mainWindow, {
          defaultPath: toolboxBuildMergeFileName(),
          filters: [{ name: 'Excel', extensions: ['xlsx'] }]
        });
        if (saveResult.canceled || !saveResult.filePath) {
          return { status: 'cancelled' };
        }
        const publishResult = await publishToolboxArtifacts(
          'merge',
          [{
            sourcePath: tempPath,
            outputId: 'merge-1',
            fileName: path.basename(saveResult.filePath),
            byteSize: writeRes.byteSize,
            sha256: writeRes.sha256,
            dataRowCount: writeRes.dataRowCount,
            sheetCount: writeRes.sheetCount,
            warningSummary: writeRes.warningSummary || EMPTY_TOOLBOX_WARNING_SUMMARY,
            styleStats: writeRes.styleStats || null
          }],
          [{ targetPath: saveResult.filePath }]
        );
        const publishedFile = publishResult.files[0];
        appendActivityLogEntry({
          level: 'info',
          source: 'main',
          domain: 'toolbox',
          message: '工具箱合并表格成功',
          details: [
            `合并文件数：${writeRes.fileCount}`,
            `参与合并 sheet 数：${writeRes.inputSheetCount}`,
            `数据行数：${writeRes.dataRowCount}`,
            `输出 sheet 数：${writeRes.sheetCount}`,
            `导出路径：${publishedFile.filePath}`,
            ...buildToolboxAuditDetailLines(publishedFile),
            ...(publishResult.warnings || [])
          ]
        });
        return {
          status: 'success',
          filePath: publishedFile.filePath,
          warningSummary: publishedFile.warningSummary || EMPTY_TOOLBOX_WARNING_SUMMARY,
          warnings: publishResult.warnings || []
        };
      } catch (error) {
        preserveTempDir = shouldPreserveToolboxTemporaryFiles(error);
        throw error;
      } finally {
        if (!preserveTempDir) {
          cleanupToolboxTemporaryDirectory(tempDir);
        }
      }
    } catch (error) {
      return toolboxFailureResult(error);
    }
  });

  // IPC 2 —— 拆表第一步：单选 → 取表头 + 流式扫一遍累积各字段去重值 → 回传给前端选字段弹框
  //   v3.0.8 BUG3：.xlsx 走流式（readHeaderRowStreamed 取表头 + streamDataRows 逐行喂去重累加器，内存常数），
  //   .csv/.xls 回退全量 extractHeaders + readRows + computeValuesByField。返回契约 {status,sourceFilePath,headers,valuesByField} 不变。
  trackedIpcHandle('toolbox:split:read', '工具箱', '拆分表格', async () => {
    try {
      const choice = await showImportOpenDialog('toolbox', {
        title: '选择要拆分的表格',
        properties: ['openFile'],
        filters: statementFileDialogFilters()
      });
      if (choice.canceled || !choice.filePaths || choice.filePaths.length === 0) {
        return { status: 'cancelled' };
      }
      const sourceFilePath = choice.filePaths[0];

      // 普通与 Worker 只区分执行位置，读取、matchValue 和字段去重均走同一 style-aware facade。
      const scanResult = await shouldUseLargeChannel(sourceFilePath)
        ? await dispatchLargeSplit({ op: 'scanFields', filePath: sourceFilePath }).promise
        : await scanToolboxSplitFields(sourceFilePath);
      const { headers, valuesByField } = scanResult || {};
      if (!headers || headers.length === 0) {
        return { status: 'failed', message: '文件为空或不可读，请重新导入', detailLines: [] };
      }
      return { status: 'success', sourceFilePath, headers, valuesByField };
    } catch (error) {
      return toolboxFailureResult(error);
    }
  });

  // IPC 3 —— 拆表第二步：{sourceFilePath, field, values[]} → 流式过滤 row[field]∈values（多选值→单文件）→ 写临时 → 另存为
  //   v3.0.8 BUG3：.xlsx 走流式（readHeaderRowStreamed 取表头判字段是否存在 + createRowFilter 逐行过滤 + writeRowsStreamed 逐行写命中行，内存常数），
  //   .csv/.xls 回退全量 readRows + filterRowsByFieldValues。
  //   口径：字段不存在用「表头」判定（开始前，保留现文案）、命中数 0 用「emit 计数（writeRowsStreamed.dataRowCount）」判定（0 不产文件，删临时，保留现文案）。
  trackedIpcHandle('toolbox:split:export', '工具箱', '拆分表格', async (_event, payload = {}) => {
    try {
      const { sourceFilePath, field, values } = payload || {};
      if (!sourceFilePath || !fs.existsSync(sourceFilePath)) {
        return { status: 'failed', message: '源文件不存在或已被移动，请重新导入', detailLines: [] };
      }
      if (payload && payload.mode === 'multiple') {
        const groups = toolboxNormalizeMultiSplitGroups(payload.groups);
        const directoryChoice = await showImportOpenDialog('toolbox-split-export-directory', {
          title: '选择拆分文件保存目录',
          properties: ['openDirectory', 'createDirectory']
        });
        if (directoryChoice.canceled || !directoryChoice.filePaths || directoryChoice.filePaths.length === 0) {
          return { status: 'cancelled' };
        }

        const outputDirectory = directoryChoice.filePaths[0];
        const targetPlans = groups.map((group) => ({
          ...group,
          targetPath: path.join(outputDirectory, group.fileName)
        }));
        const invalidTargets = targetPlans.filter((plan) => (
          fs.existsSync(plan.targetPath) && !fs.lstatSync(plan.targetPath).isFile()
        ));
        if (invalidTargets.length > 0) {
          return {
            status: 'failed',
            message: '以下目标路径不是可覆盖的普通文件，请修改文件名后重试',
            detailLines: invalidTargets.map((plan) => plan.targetPath)
          };
        }
        const conflicts = targetPlans.filter((plan) => fs.existsSync(plan.targetPath));
        if (conflicts.length > 0) {
          const overwriteChoice = await dialog.showMessageBox(mainWindow, {
            type: 'warning',
            buttons: ['取消', '覆盖全部'],
            defaultId: 0,
            cancelId: 0,
            noLink: true,
            title: '文件已存在',
            message: `有 ${conflicts.length} 个目标文件已存在，是否覆盖全部？`,
            detail: conflicts.map((plan) => plan.fileName).join('\n')
          });
          if (!overwriteChoice || overwriteChoice.response !== 1) {
            return { status: 'cancelled' };
          }
        }

        const tempDir = fs.mkdtempSync(path.join(outputDirectory, '.toolbox-split-'));
        let preserveTempDir = false;
        try {
          const preparedPlans = targetPlans.map((plan, index) => ({
            ...plan,
            outputId: plan.outputId || `split-${index + 1}`,
            temporaryPath: path.join(tempDir, `${String(index + 1).padStart(2, '0')}.xlsx`),
            matchedCount: 0
          }));

          let generationResult;
          if (await shouldUseLargeChannel(sourceFilePath)) {
            generationResult = await dispatchLargeSplit({
              op: 'exportMultiFilters',
              filePath: sourceFilePath,
              groups: preparedPlans.map((plan) => ({
                outputId: plan.outputId,
                fileName: plan.fileName,
                field: plan.field,
                values: plan.values,
                savePath: plan.temporaryPath
              }))
            }).promise;
          } else {
            generationResult = await exportToolboxMultiFilters({
              filePath: sourceFilePath,
              groups: preparedPlans.map((plan) => ({
                outputId: plan.outputId,
                fileName: plan.fileName,
                field: plan.field,
                values: plan.values,
                savePath: plan.temporaryPath
              }))
            });
          }

          const generationFiles = generationResult && Array.isArray(generationResult.files)
            ? generationResult.files
            : [];
          const inputDataRowCount = Number(
            generationResult && generationResult.inputDataRowCount
          ) || 0;
          const generationById = new Map();
          for (const file of generationFiles) {
            if (!file || !file.outputId || generationById.has(file.outputId)) {
              throw new Error('拆分结果缺少唯一 outputId，未发布任何文件');
            }
            generationById.set(file.outputId, file);
          }
          if (generationById.size !== preparedPlans.length) {
            throw new Error('拆分结果数量与请求分组不一致');
          }
          for (const plan of preparedPlans) {
            const generated = generationById.get(plan.outputId);
            if (!generated) {
              throw new Error(`拆分结果缺少分组：${plan.outputId}`);
            }
            plan.matchedCount = Number(generated.matchedCount) || 0;
            plan.byteSize = generated.byteSize;
            plan.sha256 = generated.sha256;
            plan.dataRowCount = generated.dataRowCount;
            plan.sheetCount = generated.sheetCount;
            plan.warningSummary = generated.warningSummary || EMPTY_TOOLBOX_WARNING_SUMMARY;
            plan.styleStats = generated.styleStats || null;
          }

          const publishResult = await publishToolboxArtifacts(
            'split-multi',
            preparedPlans.map((plan, index) => ({
              sourcePath: plan.temporaryPath,
              outputId: plan.outputId || `split-${index + 1}`,
              fileName: plan.fileName,
              matchedCount: plan.matchedCount,
              byteSize: plan.byteSize,
              sha256: plan.sha256,
              dataRowCount: plan.dataRowCount,
              sheetCount: plan.sheetCount,
              warningSummary: plan.warningSummary || EMPTY_TOOLBOX_WARNING_SUMMARY,
              styleStats: plan.styleStats || null
            })),
            preparedPlans.map((plan) => ({ targetPath: plan.targetPath }))
          );
          const files = publishResult.files;
          const warningSummary = aggregateToolboxWarningSummary(files);
          appendActivityLogEntry({
            level: 'info',
            source: 'main',
            domain: 'toolbox',
            message: '工具箱多文件拆分成功',
            details: [
              `输入有效行数：${inputDataRowCount}`,
              ...files.map((file) => `${file.fileName}：${file.matchedCount} 行，${file.filePath}`),
              ...buildToolboxAuditDetailLines(files, warningSummary),
              ...(publishResult.warnings || [])
            ]
          });
          return {
            status: 'success',
            files,
            warningSummary,
            warnings: publishResult.warnings || []
          };
        } catch (error) {
          preserveTempDir = shouldPreserveToolboxTemporaryFiles(error);
          throw error;
        } finally {
          if (!preserveTempDir) {
            cleanupToolboxTemporaryDirectory(tempDir);
          }
        }
      }
      if (!field) {
        return { status: 'failed', message: '未选择拆分字段', detailLines: [] };
      }
      if (!Array.isArray(values) || values.length === 0) {
        return { status: 'failed', message: '请至少选择一个值', detailLines: [] };
      }

      // v3.0.9 T6：大文件（多 sheet / 单 worksheet 解压 ≥1.5GB 的 .xlsx）走隔离 worker 通道流式过滤写临时 xlsx，再另存为。
      //   fail-closed：路由 false 时落下方现有小文件分支（原样不动）。回传契约与现有分支逐字节一致：
      //   {status:'success',filePath} / {status:'cancelled'} / 0 命中沿用现文案 failed。
      //   🔴 修 B20：try/finally 可靠清 mkdtemp 临时目录（含 dispatch reject / worker crash；外层 catch→toolboxFailureResult 兜异常）。
      if (await shouldUseLargeChannel(sourceFilePath)) {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'toolbox-large-'));
        const tempPath = path.join(tempDir, `toolbox-${Date.now()}.xlsx`);
        let preserveTempDir = false;
        try {
          const generationResult = await dispatchLargeSplit({
            op: 'exportFilter',
            filePath: sourceFilePath,
            field,
            values,
            savePath: tempPath
          }).promise;
          const matchedCount = Number(generationResult && generationResult.matchedCount) || 0;
          const inputDataRowCount = Number(
            generationResult && generationResult.inputDataRowCount
          ) || 0;
          if (matchedCount === 0) {
            // 0 命中：不弹保存框、不产用户文件（保留现文案，与小文件分支逐字节一致）。临时目录由 finally 清理。
            return { status: 'failed', message: '所选值在源文件中无匹配行，未生成文件', detailLines: [] };
          }
          const saveResult = await dialog.showSaveDialog(mainWindow, {
            defaultPath: toolboxBuildSplitFileName(values, sanitizeFileName),
            filters: [{ name: 'Excel', extensions: ['xlsx'] }]
          });
          if (saveResult.canceled || !saveResult.filePath) {
            return { status: 'cancelled' };
          }
          const publishResult = await publishToolboxArtifacts(
            'split-single-large',
            [{
              sourcePath: tempPath,
              outputId: 'split-1',
              fileName: path.basename(saveResult.filePath),
              matchedCount,
              byteSize: generationResult.byteSize,
              sha256: generationResult.sha256,
              dataRowCount: generationResult.dataRowCount,
              sheetCount: generationResult.sheetCount,
              warningSummary: generationResult.warningSummary || EMPTY_TOOLBOX_WARNING_SUMMARY,
              styleStats: generationResult.styleStats || null
            }],
            [{ targetPath: saveResult.filePath }]
          );
          const publishedFile = publishResult.files[0];
          appendActivityLogEntry({
            level: 'info',
            source: 'main',
            domain: 'toolbox',
            message: '工具箱拆分表格成功',
            details: [
              `拆分字段：${field}`,
              `选中值数：${values.length}`,
              `输入有效行数：${inputDataRowCount}`,
              `命中行数：${matchedCount}`,
              `导出路径：${publishedFile.filePath}`,
              ...buildToolboxAuditDetailLines(publishedFile),
              ...(publishResult.warnings || [])
            ]
          });
          return {
            status: 'success',
            filePath: publishedFile.filePath,
            warningSummary: publishedFile.warningSummary || EMPTY_TOOLBOX_WARNING_SUMMARY,
            warnings: publishResult.warnings || []
          };
        } catch (error) {
          preserveTempDir = shouldPreserveToolboxTemporaryFiles(error);
          throw error;
        } finally {
          // 🔴 修 B20：可靠清临时目录（800MB 级临时大文件；含 worker crash / dispatch reject 路径）。
          if (!preserveTempDir) {
            cleanupToolboxTemporaryDirectory(tempDir);
          }
        }
      }

      const generationDir = fs.mkdtempSync(path.join(os.tmpdir(), 'toolbox-'));
      const tempPath = path.join(generationDir, `toolbox-${Date.now()}.xlsx`);
      let generationResult;
      try {
        generationResult = await exportToolboxFilter({
          filePath: sourceFilePath,
          field,
          values,
          savePath: tempPath,
          outputId: 'split-1'
        });
      } catch (error) {
        try { fs.rmSync(generationDir, { recursive: true, force: true }); } catch (_e) { /* swallow */ }
        throw error;
      }
      const matchedCount = Number(generationResult.matchedCount) || 0;
      const inputDataRowCount = Number(generationResult.inputDataRowCount) || 0;
      if (matchedCount === 0) {
        try { fs.rmSync(generationDir, { recursive: true, force: true }); } catch (_e) { /* swallow */ }
        return { status: 'failed', message: '所选值在源文件中无匹配行，未生成文件', detailLines: [] };
      }

      let preserveTempDir = false;
      try {
        const saveResult = await dialog.showSaveDialog(mainWindow, {
          defaultPath: toolboxBuildSplitFileName(values, sanitizeFileName),
          filters: [{ name: 'Excel', extensions: ['xlsx'] }]
        });
        if (saveResult.canceled || !saveResult.filePath) {
          return { status: 'cancelled' };
        }
        const publishResult = await publishToolboxArtifacts(
          'split-single',
          [{
            sourcePath: tempPath,
            outputId: 'split-1',
            fileName: path.basename(saveResult.filePath),
            matchedCount,
            byteSize: generationResult.byteSize,
            sha256: generationResult.sha256,
            dataRowCount: generationResult.dataRowCount,
            sheetCount: generationResult.sheetCount,
            warningSummary: generationResult.warningSummary || EMPTY_TOOLBOX_WARNING_SUMMARY,
            styleStats: generationResult.styleStats || null
          }],
          [{ targetPath: saveResult.filePath }]
        );
        const publishedFile = publishResult.files[0];
        appendActivityLogEntry({
          level: 'info',
          source: 'main',
          domain: 'toolbox',
          message: '工具箱拆分表格成功',
          details: [
            `拆分字段：${field}`,
            `选中值数：${values.length}`,
            `输入有效行数：${inputDataRowCount}`,
            `命中行数：${matchedCount}`,
            `导出路径：${publishedFile.filePath}`,
            ...buildToolboxAuditDetailLines(publishedFile),
            ...(publishResult.warnings || [])
          ]
        });
        return {
          status: 'success',
          filePath: publishedFile.filePath,
          warningSummary: publishedFile.warningSummary || EMPTY_TOOLBOX_WARNING_SUMMARY,
          warnings: publishResult.warnings || []
        };
      } catch (error) {
        preserveTempDir = shouldPreserveToolboxTemporaryFiles(error);
        throw error;
      } finally {
        if (!preserveTempDir) {
          const generationDirName = path.basename(generationDir);
          if (generationDirName.startsWith('toolbox-') && generationDir.startsWith(os.tmpdir())) {
            cleanupToolboxTemporaryDirectory(generationDir);
          }
        }
      }
    } catch (error) {
      return toolboxFailureResult(error);
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
const VCC_USAGE_SUCCESS_STATUSES = new Set(['calculated', 'archived', 'initialized', 'all_skipped']);

function isSuccessfulTrackedResult(result, moduleKey) {
  if (!result || typeof result !== 'object') return false;
  if (SUCCESS_STATUSES.has(result.status)) return true;
  return moduleKey === 'VCC财务OP校验' && VCC_USAGE_SUCCESS_STATUSES.has(result.status);
}

function archiveOutputPaths(files) {
  const values = Array.isArray(files) ? files : [];
  const seen = new Set();
  const output = [];
  for (const item of values) {
    const filePath = typeof item === 'string' ? item : item && item.filePath;
    const normalized = String(filePath || '').trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    output.push(normalized);
  }
  return output;
}

function archiveResultSnapshot(result) {
  if (!result || typeof result !== 'object') return result;
  const snapshot = {};
  const scalarKeys = [
    'status', 'detailReady', 'balanceReady', 'runId', 'mirrorId', 'id',
    'filePath', 'savedPath', 'savePath', 'mainFilePath', 'hitRowsReportPath',
    'platformCleanupPath', 'refundBackfillPath', 'unmatchedFilePath',
    'diffFilePath', 'reportFilePath'
  ];
  for (const key of scalarKeys) {
    const value = result[key];
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
      snapshot[key] = value;
    }
  }
  if (Array.isArray(result.results)) {
    snapshot.results = result.results.map((item) => {
      if (!item || typeof item !== 'object') return {};
      return {
        fileName: item.fileName,
        status: item.status,
        tableKey: item.tableKey,
        outcome: item.outcome,
        rowCount: item.rowCount,
        alsoLinked: item.alsoLinked && typeof item.alsoLinked === 'object'
          ? { error: item.alsoLinked.error || '', rowCount: item.alsoLinked.rowCount }
          : item.alsoLinked
      };
    });
  }
  if (Array.isArray(result.files)) {
    snapshot.files = result.files.map((item) => (
      typeof item === 'string'
        ? item
        : { filePath: item && (item.filePath || item.savedPath || item.path) }
    ));
  }
  return snapshot;
}

function statementArchiveRuntime() {
  const session = getCurrentStatementSession();
  const fileEntries = session ? getStatementSessionEntries(session, 'current') : [];
  const inputPaths = lastFileImportContext && Array.isArray(lastFileImportContext.inputFilePaths)
    ? lastFileImportContext.inputFilePaths.slice()
    : fileEntries.map((entry) => entry && entry.filePath).filter(Boolean);
  const templateIds = new Set();
  const contextTemplateId = Number(lastFileImportContext && lastFileImportContext.templateId);
  if (Number.isInteger(contextTemplateId) && contextTemplateId > 0) templateIds.add(contextTemplateId);
  for (const entry of fileEntries) {
    const templateId = Number(entry && entry.matchedTemplateId);
    if (Number.isInteger(templateId) && templateId > 0) templateIds.add(templateId);
  }
  const detail = getGeneratedStatementExport('detail', 'current') || lastGeneratedExports.detail;
  const balance = getGeneratedStatementExport('balance', 'current') || lastGeneratedExports.balance;
  const ids = Array.from(templateIds);
  return {
    inputPaths,
    outputPaths: archiveOutputPaths([detail, balance]),
    templateIds: ids,
    templateNames: ids.map((templateId) => database && database.getTemplate(templateId))
      .filter(Boolean)
      .map((template) => template.name)
  };
}

async function buildArchiveRuntimeSnapshot(channel, args, result) {
  if (channel === 'file:import'
      || channel === 'file:complete-big-account-selection'
      || channel === 'file:save-balance-seed') {
    return statementArchiveRuntime();
  }
  if (channel === 'monthly-balance:assemble') {
    const pending = lastGeneratedExports.monthlyBalance;
    const templateIds = pending && Array.isArray(pending.templateIds) ? pending.templateIds : [];
    return {
      outputPaths: archiveOutputPaths([pending]),
      templateIds,
      metadata: pending ? {
        year: pending.year,
        month: pending.month,
        templateScope: pending.templateScope
      } : {}
    };
  }
  if (channel === 'new-account:generate') {
    return { outputPaths: archiveOutputPaths([lastGeneratedExports.newAccount]) };
  }
  if (channel === 'bank-statement:run' || channel === 'bank-statement:export') {
    return { runKey: processingResult && processingResult.runId };
  }
  if (channel === 'recon-id-fix:run' || channel === 'recon-id-fix:export') {
    return {
      runKey: reconIdFixResult && reconIdFixResult.ranAt,
      originModuleId: reconIdFixResult && reconIdFixResult.originModuleId
    };
  }
  if (channel === 'pre-fund-reconciliation:mpt-errors:repair') {
    const paths = result && Array.isArray(result.archivedSourcePaths) ? result.archivedSourcePaths : [];
    return { inputPaths: paths };
  }
  if (channel === 'position-reconciliation:bank:apply-import') {
    return {
      inputPaths: result && Array.isArray(result.inputPaths) ? result.inputPaths : [],
      inputFiles: result && Array.isArray(result.inputFiles) ? result.inputFiles : [],
      cleanupPaths: result && Array.isArray(result.cleanupPaths) ? result.cleanupPaths : [],
      metadata: {
        scopes: result && Array.isArray(result.scopes) ? result.scopes : [],
        scopeInputs: result && Array.isArray(result.scopeInputs) ? result.scopeInputs : []
      }
    };
  }
  if (channel === 'position-reconciliation:source:prepare-import') {
    return {
      inputPaths: result && Array.isArray(result.inputPaths) ? result.inputPaths : [],
      inputFiles: result && Array.isArray(result.inputFiles) ? result.inputFiles : [],
      outputPaths: result && Array.isArray(result.outputPaths) ? result.outputPaths : [],
      outputFiles: result && Array.isArray(result.outputFiles) ? result.outputFiles : [],
      cleanupPaths: result && Array.isArray(result.cleanupPaths) ? result.cleanupPaths : []
    };
  }
  if (channel === 'position-reconciliation:source:apply-import') {
    return {
      inputPaths: result && Array.isArray(result.inputPaths) ? result.inputPaths : [],
      inputFiles: result && Array.isArray(result.inputFiles) ? result.inputFiles : [],
      cleanupPaths: result && Array.isArray(result.cleanupPaths) ? result.cleanupPaths : []
    };
  }
  if (channel === 'position-reconciliation:run:export'
      || channel === 'position-reconciliation:bank:export'
      || channel === 'position-reconciliation:linked:export'
      || channel === 'position-reconciliation:raw:export') {
    return {
      runKey: result && result.runId,
      outputPaths: archiveOutputPaths([result && result.filePath])
    };
  }
  if (channel === 'position-reconciliation:run:import-result') {
    return {
      runKey: result && result.runId,
      inputPaths: result && Array.isArray(result.inputPaths) ? result.inputPaths : [],
      inputFiles: result && Array.isArray(result.inputFiles) ? result.inputFiles : [],
      cleanupPaths: result && Array.isArray(result.cleanupPaths) ? result.cleanupPaths : []
    };
  }
  return {};
}

function positionArchiveStagingRoot() {
  if (!database || !database.dbPath) return '';
  return path.resolve(
    path.dirname(database.dbPath),
    'run-data',
    'position-reconciliation',
    'import-staging'
  );
}

async function cleanupPositionArchiveStagingDirectories(targets) {
  if (!Array.isArray(targets) || targets.length === 0) return;
  const root = positionArchiveStagingRoot();
  if (!root) return;
  for (const value of targets) {
    const target = path.resolve(String(value || ''));
    if (target === root || !target.startsWith(`${root}${path.sep}`)) continue;
    try {
      await fs.promises.rm(target, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100
      });
      const batchRoot = path.dirname(target);
      if (batchRoot !== root && batchRoot.startsWith(`${root}${path.sep}`)) {
        const entries = await fs.promises.readdir(batchRoot);
        if (entries.length === 0) {
          await fs.promises.rmdir(batchRoot);
        }
      }
    } catch (_error) {
      // 成功存档后的临时副本清理失败留待下次启动回收。
    }
  }
}

function positionArchivePersistentStagingPaths() {
  if (!archiveCenterService
      || typeof archiveCenterService.listUnresolvedSourcePaths !== 'function') {
    return null;
  }
  try {
    return positionPersistentStagingProtectionPaths(
      archiveCenterService.listUnresolvedSourcePaths(),
      readPositionPendingOperation()
    );
  } catch (_error) {
    return null;
  }
}

function positionArchiveProtectedStagingPaths() {
  let protectedPaths = positionArchivePersistentStagingPaths();
  if (!protectedPaths) return null;
  try {
    if (positionReconciliationService
        && typeof positionReconciliationService.activeImportStagingPaths === 'function') {
      const activePaths = positionReconciliationService.activeImportStagingPaths();
      if (!Array.isArray(activePaths)) return null;
      protectedPaths = protectedPaths.concat(activePaths);
    }
  } catch (_error) {
    return null;
  }
  return protectedPaths;
}

async function cleanupPositionArchiveSourcePaths(sourcePaths) {
  const root = positionArchiveStagingRoot();
  if (!root) return;
  const directories = [];
  const jobRoots = [];
  for (const value of Array.isArray(sourcePaths) ? sourcePaths : []) {
    const sourcePath = path.resolve(String(value || ''));
    const relative = path.relative(root, sourcePath);
    const parts = relative.split(path.sep).filter(Boolean);
    if (relative === '..'
        || relative.startsWith(`..${path.sep}`)
        || path.isAbsolute(relative)
        || parts.length < 3) {
      continue;
    }
    directories.push(path.dirname(sourcePath));
    jobRoots.push(path.join(root, parts[0]));
  }
  const protectedPaths = positionArchiveProtectedStagingPaths();
  if (!protectedPaths) return;
  await cleanupPositionArchiveStagingDirectories(
    filterStagingPathsWithoutProtectedSources(
      directories.concat(jobRoots),
      protectedPaths
    )
  );
}

async function cleanupPositionArchiveStaging(runtime) {
  const targets = runtime && Array.isArray(runtime.cleanupPaths) ? runtime.cleanupPaths : [];
  if (targets.length === 0) return;
  const protectedPaths = positionArchiveProtectedStagingPaths();
  if (!protectedPaths) return;
  await cleanupPositionArchiveStagingDirectories(
    filterStagingPathsWithoutProtectedSources(targets, protectedPaths)
  );
}

function reportArchiveFailure(warning) {
  const message = warning && warning.message ? warning.message : '存档副本写入失败';
  appendActivityLogEntry({
    level: 'warning',
    source: 'main',
    domain: 'archive-center',
    message: '业务已成功，但存档失败，可在存档中心重试',
    details: [message]
  });
  try {
    if (Notification && typeof Notification.isSupported === 'function' && Notification.isSupported()) {
      new Notification({
        title: '存档中心',
        body: '业务文件已正常生成，但存档失败，请打开存档中心重试。'
      }).show();
    }
  } catch (_error) { /* 存档告警展示失败不得影响业务 */ }
}

async function resolveArchiveFlowEvidence(kind, args) {
  try {
    if (kind === 'bank-bu-import-bundle') {
      const payload = args[0] && typeof args[0] === 'object' ? args[0] : {};
      const yearMonth = String(payload.yearMonth || '').trim();
      if (!database || !database.db || !/^\d{4}-\d{2}$/.test(yearMonth)) return null;
      return bankBuReconRunData.getImportFlowEvidence({
        userDataDir: path.dirname(database.dbPath),
        mainDb: database.db,
        yearMonth
      });
    }
  } catch (error) {
    appendActivityLogEntry({
      level: 'error',
      source: 'main',
      domain: 'archive-center-flow',
      message: '任务流程证据读取失败，业务未开始',
      details: [error && error.message ? error.message : String(error)]
    });
    throw error;
  }
  return null;
}

async function resolveTaskFlowPlan(policy, invocation) {
  if (typeof policy.flowPlanResolver === 'function') {
    const plan = await policy.flowPlanResolver(invocation);
    if (!plan || typeof plan.startsNewFlow !== 'boolean') {
      throw new TypeError(`task policy ${policy.channel} flowPlanResolver 返回非法`);
    }
    return plan;
  }
  return {
    startsNewFlow: policy.startsNewFlow,
    flowIdentity: typeof policy.flowIdentityResolver === 'function'
      ? policy.flowIdentityResolver(invocation)
      : null
  };
}

function trackArchiveOperationPromise(promise) {
  const previous = archiveOperationTail;
  archiveOperationTail = Promise.allSettled([previous, promise]).then(() => undefined);
  return promise;
}

async function runArchiveAwareOperation(meta, event, args, handler) {
  const contract = normalizeIpcTaskHandler(handler);
  const dialogContext = { dialogSelections: [], batchContext: null, phase: 'prepare' };
  return archiveOperationContext.run(dialogContext, async () => {
    // picker / preview / danger confirmation 必须全部在 BOR.begin 和 reserve 之前完成。
    const prepared = await prepareIpcTaskInvocation(contract, event, args);
    dialogContext.phase = 'execute';
    if (!prepared.proceed) return prepared.result;

    const effectiveArgs = prepared.args;
    const executeBusiness = (taskContext) => executeIpcTaskInvocation(
      contract,
      event,
      prepared,
      effectiveArgs,
      taskContext
    );
    const policy = taskPolicyRegistry.get(meta.channel);
    if (!policy) {
      if (!pr3TaskPolicyHandoff.has(meta.channel)) {
        throw new Error(`未登记 task policy：${meta.channel}`);
      }
      return runRegisteredBusinessOperation(meta, executeBusiness)(event);
    }
    if (policy.batchPolicy !== 'reserve') {
      throw new Error(`受控业务 helper 不得执行 exclude policy：${meta.channel}`);
    }

    const center = archiveCenterService || initializeArchiveCenter();
    if (!center || !archiveTaskLifecycle) {
      if (typeof prepared.onAbandon === 'function') await prepared.onAbandon();
      return {
        status: 'failed',
        code: 'ARCHIVE_TASK_LIFECYCLE_UNAVAILABLE',
        message: '存档中心无法预留任务批次，业务未开始'
      };
    }

    const selectedPaths = [
      ...prepared.inputPaths,
      ...dialogContext.dialogSelections.flatMap((selection) => selection.filePaths || [])
    ];
    const invocation = {
      args: effectiveArgs,
      prepared,
      resolveFlowEvidence: (kind) => resolveArchiveFlowEvidence(kind, effectiveArgs)
    };
    const isPositionOperation = meta.channel.startsWith('position-reconciliation:');
    const positionOperationToken = isPositionOperation ? randomUUID() : '';

    const operationPromise = runWithPreparedResourceCleanup(prepared, (markExecuteStarted) => (
      archiveTaskLifecycle.run({
      meta,
      policy,
      args: effectiveArgs,
      prepared,
      selectedPathsResolver: () => selectedPaths,
      recovery: prepared.recovery || undefined,
      flowPlanResolver: prepared.flowPlan
        ? () => prepared.flowPlan
        : () => resolveTaskFlowPlan(policy, invocation),
      taskRunId: prepared.taskRunId || positionOperationToken || undefined,
      operationKey: prepared.operationKey || (positionOperationToken
        ? `position:${positionOperationToken}:${meta.channel}`
        : undefined),
      resultClassifier: policy.resultClassifier,
      resultMetadataResolver: typeof policy.resultMetadataResolver === 'function'
        ? (result, context, terminal) => policy.resultMetadataResolver(
            result,
            context,
            { ...terminal, invocation }
          )
        : null,
      resultFlowIdentities: typeof policy.resultFlowIdentities === 'function'
        ? (result, context) => policy.resultFlowIdentities(result, context, invocation)
        : null,
      afterTerminal: isPositionOperation
        ? finalizePositionPendingAfterTaskTerminal
        : null,
      afterTerminalIntent: isPositionOperation
        ? { route: 'position-reconciliation', operationToken: positionOperationToken }
        : null,
      beforeStart: async () => {
        if (typeof prepared.beforeStart === 'function') await prepared.beforeStart();
        return {
          sourceSnapshots: captureArchiveSourceSnapshots({
          args: [],
          result: null,
          selectedPaths: resolveOperationInputPaths({
            channel: meta.channel,
            args: effectiveArgs,
            prepared,
            selectedPaths,
            runtime: { inputPaths: prepared.inputPaths }
          }),
            runtime: {}
          })
        };
      },
      runtimeResolver: async ({ result, beforeStartEvidence }) => {
        const runtime = await buildArchiveRuntimeSnapshot(meta.channel, effectiveArgs, result);
        const afterSnapshots = captureArchiveSourceSnapshots({
          args: effectiveArgs,
          result,
          selectedPaths,
          runtime
        });
        runtime.sourceSnapshots = new Map([
          ...(
            beforeStartEvidence && beforeStartEvidence.sourceSnapshots
              ? beforeStartEvidence.sourceSnapshots
              : []
          ),
          ...afterSnapshots
        ]);
        if (positionOperationToken) {
          runtime.metadata = {
            ...(runtime.metadata || {}),
            positionOperationToken
          };
        }
        return runtime;
      },
      execute: async (batchContext, controls) => {
        dialogContext.batchContext = batchContext;
        const taskContext = createIpcTaskContext(batchContext, controls);
        const executePositionBusiness = async () => {
          let result;
          let operationError = null;
          try {
            result = await executeBusiness(taskContext);
          } catch (error) {
            operationError = error;
          }
          markPositionBusinessOutcome(operationError
            ? positionReconciliationFailureResult(operationError)
            : result);
          const settled = await controls.settleArtifacts({
            result,
            error: operationError
          });
          const settledResult = await settlePositionArchiveResult({
            result,
            archiveTask: Promise.resolve(settled.archiveResult),
            runtime: settled.runtime,
            persistRecovery: persistCurrentPositionArchiveIntentIfNeeded,
            markDurable: markPositionArchiveDurable,
            markIncomplete: markPositionArchiveIncomplete,
            cleanup: cleanupPositionArchiveStaging,
            reportFailure: reportArchiveFailure
          });
          if (operationError) throw operationError;
          return settledResult;
        };
        return executeAfterPositionAdmission({
          isPositionOperation,
          markExecuteStarted,
          execute: isPositionOperation
            ? executePositionBusiness
            : () => executeBusiness(taskContext),
          admitPosition: (operation) => runPositionReconciliationOperation(
            meta.channel,
            operation,
            { operationToken: positionOperationToken, batchContext }
          )
        });
      }
      })
    ));
    return trackArchiveOperationPromise(operationPromise);
  });
}

function runRegisteredBusinessOperation(meta, handler) {
  return async (event, ...args) => {
    const operation = businessOperationRegistry.begin(meta);
    if (!operation.accepted) {
      return {
        status: 'busy',
        message: operation.message || INSTALL_BUSY_MESSAGE
      };
    }
    try {
      return await handler(event, ...args);
    } finally {
      businessOperationRegistry.end(operation.token);
    }
  };
}

function businessIpcHandle(channel, label, handler) {
  const meta = { channel, functionKey: label };
  ipcMain.handle(channel, (event, ...args) => runArchiveAwareOperation(
    meta, event, args, handler
  ));
}

function supportIpcHandle(channel, label, handler) {
  if (!supportActionChannels.has(channel)) {
    throw new Error(`未登记 support action：${channel}`);
  }
  const meta = { channel, functionKey: label, operationKind: 'support-action' };
  ipcMain.handle(channel, runRegisteredBusinessOperation(meta, handler));
}

function trackedIpcHandle(channel, moduleKey, functionKey, handler) {
  const meta = { channel, moduleKey, functionKey };
  ipcMain.handle(channel, async (event, ...args) => {
    const result = await runArchiveAwareOperation(meta, event, args, handler);
    if (isSuccessfulTrackedResult(result, moduleKey)) {
      tickUsageStats(moduleKey, functionKey);
    }
    return result;
  });
}

function dynamicTrackedIpcHandle(
  channel,
  moduleKey,
  operationFunctionKey,
  resolveUsageFunctionKey,
  handler
) {
  const meta = { channel, moduleKey, functionKey: operationFunctionKey };
  ipcMain.handle(channel, async (event, ...args) => {
    const result = await runArchiveAwareOperation(meta, event, args, handler);
    if (isSuccessfulTrackedResult(result, moduleKey)) {
      const usageFunctionKey = resolveUsageFunctionKey(result, event, ...args);
      if (usageFunctionKey) tickUsageStats(moduleKey, usageFunctionKey);
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

// v3.0.5 PR-5（Part B Phase 3）：启动窗口先行 —— 回退开关 B-D5（仿 USE_BIG_TABLE_IMPORT_ENGINE 范式，一行切回旧时序）。
//   新时序（默认）：whenReady → 轻量(activity-log/usage-stats) → 立即 createWindow(loading 态) + register*Handlers
//     → 后台 init 链（database.init / pendingDb / 迁移 / syncTemplateLibrary + 各 setImmediate 后台清理）
//     → 完成后 mainWindow.webContents.send('app:init-done') 放开功能。
//   旧时序（DEFERRED_WINDOW_STARTUP=0）：init 链全跑完 → register*Handlers → createWindow（v3.0.4 及之前行为）。
//   ⚠️ 方案①前提（已核实）：register*Handlers 的 handler 体惰性引用 database（闭包 () => database && database.db），
//     注册时不解引用 → 可在 database.init 前注册；首个 IPC（app:get-info）init 未完返回 {initPending:true,version}。
//   稳定一版后移除回退分支（与 USE_BIG_TABLE_IMPORT_ENGINE 同退役路径）。
const DEFERRED_WINDOW_STARTUP = process.env.DEFERRED_WINDOW_STARTUP === '0' ? false : true;

// init 链是否完成（app:get-info 两段式判定：未完返回 loading 骨架；renderer 收 app:init-done 后重 getInfo 拿全量）。
let appInitDone = false;

// v3.0.5 PR-5（B-D6）：升级首启一次性 VACUUM 阻塞前，给 loading 窗口发状态文案。
//   轻量只读 peek 标志位（key 与 database.js ONE_TIME_VACUUM_FLAG_KEY 一致）+ 文件大小判定，决定发哪条文案。
//   全程 try/swallow——peek 失败一律发通用「正在初始化…」，绝不阻断 init。
const ONE_TIME_VACUUM_FLAG_KEY_MIRROR = 'db_one_time_vacuum_v3_0_5_done';
const VACUUM_NOTICE_MIN_DB_BYTES = 500 * 1024 * 1024; // >500MB 才提示「优化数据库（分钟级）」，小库走通用文案
function sendInitProgress(payload) {
  try {
    if (mainWindow && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send('app:init-progress', payload);
    }
  } catch (_e) { /* swallow */ }
}
function maybeSendVacuumLoadingNotice(dbPath) {
  let vacuumPending = false;
  try {
    if (fs.existsSync(dbPath)) {
      const size = fs.statSync(dbPath).size;
      if (size >= VACUUM_NOTICE_MIN_DB_BYTES) {
        // 只读 peek 标志位（throwaway 连接，立即 close；不影响后续 init 的主连接）。
        const { DatabaseSync } = require('node:sqlite');
        let peekDb = null;
        try {
          peekDb = new DatabaseSync(dbPath, { readOnly: true });
          const row = peekDb.prepare('SELECT setting_value FROM app_settings WHERE setting_key = ?').get(ONE_TIME_VACUUM_FLAG_KEY_MIRROR);
          vacuumPending = !(row && row.setting_value === '1');
        } catch (_e) {
          vacuumPending = false; // app_settings 不存在（全新库）等 → 无历史膨胀，不发 VACUUM 文案
        } finally {
          if (peekDb) { try { peekDb.close(); } catch (_e2) { /* swallow */ } }
        }
      }
    }
  } catch (_e) { vacuumPending = false; }
  if (vacuumPending) {
    sendInitProgress({ phase: 'vacuum', text: '正在优化数据库，首次升级约需几分钟，请勿关闭程序…' });
  } else {
    sendInitProgress({ phase: 'init', text: '正在初始化…' });
  }
}

// 10 组 IPC handler 注册（提取为函数，新/旧时序都调一次；handler 体惰性引用 database/pendingDb，注册时不解引用）。
function registerAllIpcHandlers() {
  registerWindowHandlers();
  registerAppHandlers();
  registerAppUpdateHandlers();
  registerArchiveCenterHandlers();
  registerErrorHandlers();
  registerBackgroundHandlers();
  registerAccountMappingHandlers();
  // v3.0.12 功能2（批A）：账户映射管理（中台调拨单账户号 → 清结算系统银行账号）IPC
  registerFundTransferAccountMappingHandlers();
  registerTemplateHandlers();
  registerBigAccountHandlers();
  registerBigAccountOrderHandlers();
  registerFileHandlers();
  registerNewAccountHandlers();
  registerPreFundReconciliationHandlers();
  registerDuplicateInboundMatchHandlers();
  registerPositionReconciliationHandlers();
  registerToolboxHandlers();
  markStartupMetric(STARTUP_METRIC_MARKS.handlersReady);
}

// 后台 init 链 + 所有 post-setup（database/pendingDb/迁移/模板库 + 孤儿清理/备份保留/idle 计时器/failure listener）。
//   新时序：createWindow 后调用；完成后 markAppInitDone() → send('app:init-done')。
//   旧时序：register/createWindow 前调用（同步完成）。
//   本函数内所有 setImmediate 后台块 guard `if (!database || !database.db) return`——新时序下 database 已在本函数体内 init，
//   setImmediate 回调晚于本函数同步体执行，database 已就绪。
function runBackgroundInitChain() {
    const dataPath = path.join(app.getPath('userData'), 'tool-data.sqlite');
    // v3.0.5 PR-5（B-D6）：升级首启一次性 VACUUM 会同步阻塞主进程（大库分钟级）——新时序下窗口已显示 loading 态，
    //   故在 database.init()（内含 VACUUM）之前发一次状态文案，让 loading 态显示「正在优化数据库…请勿关闭程序」。
    //   仅当 VACUUM 待执行（标志位未写）且库文件较大（>500MB，确实膨胀值得多分钟提示）时发；否则发通用「正在初始化…」。
    maybeSendVacuumLoadingNotice(dataPath);
    database = new AppDatabase(dataPath);
    database.init();
    initializeAppUpdaterService();
    initializeArchiveCenter();
    markStartupMetric(STARTUP_METRIC_MARKS.databaseReady);
    // 结果侧库只服务上一进程的最后一次 run；即使模块默认关闭，也要在本次启动后台立即回收。
    schedulePreFundReconciliationStartupCleanup();
    scheduleDuplicateInboundMatchStartupCleanup();

    // v2.0.0-beta.2 F4 / v2.1.15 W4：ui_style 收敛迁移 —— 老库存了 'General'/非法值就地迁移为 'Clear'，未写则 seed 'Clear'。
    //   General 风格已弃用，setUiStyle 写链路移除，APP_PREVIEW_STYLE 强制风格随之去除（风格恒 Clear）。
    database.ensureUiStyleDefault();

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

    runStartupPostSetup();
}

// init 完成标记 + 通知 renderer 放开功能（loading → 全量）。新时序专用；旧时序窗口建好时 init 已完，渲染层首次 getInfo 即全量。
function markAppInitDone() {
  appInitDone = true;
  try {
    if (mainWindow && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send('app:init-done');
    }
  } catch (_e) { /* swallow — 窗口已销毁等 */ }
  scheduleAppUpdaterStartupCheck();
}

if (hasSingleInstanceLock) app.whenReady()
  .then(async () => {
    markStartupMetric(STARTUP_METRIC_MARKS.appReady);
    initializeActivityLog();
    await recoverToolboxPublicationsAtStartup();

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

    // v3.0.5 PR-5（Part B Phase 3）：启动窗口先行（回退开关 DEFERRED_WINDOW_STARTUP，默认新时序）。
    if (DEFERRED_WINDOW_STARTUP) {
      // 新时序：先注册 handler（惰性引用 database） + 立即建窗（loading 态）→ 后台 init 链 → init-done 放开功能。
      registerAllIpcHandlers();
      createWindow();
      // 后台 init 链：放进 setImmediate 让窗口先渲染（loading 骨架），init 完成后 send('app:init-done')。
      //   init 链本身同步（database.init 是 DatabaseSync 同步 API），但放 setImmediate 让 createWindow 的
      //   loadFile/ready-to-show 事件循环先跑一拍——窗口 loading 态先可见，再开始压主线程 init。
      setImmediate(() => {
        try {
          runBackgroundInitChain();
        } catch (initErr) {
          handleStartupFailure(initErr);
          return;
        }
        markAppInitDone();
      });
    } else {
      // 旧时序（DEFERRED_WINDOW_STARTUP=0）：init 链全跑完 → register → createWindow（v3.0.4 及之前行为）。
      runBackgroundInitChain();
      registerAllIpcHandlers();
      createWindow();
      markAppInitDone(); // 旧时序窗口建好时 init 已完；置标记保 getInfo 全量（窗口 onInitDone 监听冗余无害）
    }
  })
  .catch((error) => {
    handleStartupFailure(error);
  });

// v3.0.5 PR-5：启动期后台 post-setup（孤儿清理 / 备份保留 / idle 计时器 / failure listener / OneDrive 提示）。
//   由 runBackgroundInitChain 末尾调用（database 已 init）。所有块 setImmediate 异步，不阻塞窗口。
function runStartupPostSetup() {
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

    // v3.0.5 PR-3（Part B Phase 1 / B.6）：侧库孤儿双向兜底（启动扫描 run-data/{module}/ vs 主库 runs 元数据）
    //   ① 有文件无元数据「且空壳（侧库无 flow/bill imports）」→ 删文件 + log；
    //     🔴 codex PR#73 P1：import-only（已导入未对账，有数据无 mirror）= 有效中间态，保留不删（防丢导入数据，对齐 biz-op/bank-bu）；
    //   ② 有元数据无文件 → 标记 run 失效（UI 降级「数据已清理」不崩溃）。
    //   一致性原则：以侧库文件存在性为准（spec §B.6）。与上面主库孤儿清理（既有行级，双源过渡保留）并存。
    //   后台 setImmediate，不阻塞窗口 ready；持同一把 op lock 避免与用户首次 import/run 并发。
    setImmediate(() => {
      if (!database || !database.db) return;
      const lock = tryAcquireAcquiringBillCurrencyOpLock('cleanup', null);
      if (!lock.acquired) return;
      try {
        const stats = acquiringRunData.reconcileOrphans({
          userDataDir: path.dirname(database.dbPath),
          mainDb: database.db
        });
        if (stats && (stats.deletedOrphanFiles.length > 0 || stats.invalidatedRuns.length > 0)) {
          appendActivityLogEntry({
            level: 'info',
            source: 'main',
            domain: 'acquiring-bill-currency',
            message: '[acquiring-bill-currency] 启动期侧库孤儿双向兜底完成（PR-3）',
            details: [
              `删孤儿文件: ${stats.deletedOrphanFiles.length} (${stats.deletedOrphanFiles.join(', ')})`,
              `标记失效 run: ${stats.invalidatedRuns.length} (${stats.invalidatedRuns.join(', ')})`
            ]
          });
        }
      } catch (err) {
        try {
          appendActivityLogEntry({
            level: 'error',
            source: 'main',
            domain: 'acquiring-bill-currency',
            message: '[acquiring-bill-currency] 启动期侧库孤儿兜底失败（PR-3）',
            details: [String(err && err.stack ? err.stack : err)]
          });
        } catch (_logErr) { /* swallow */ }
      } finally {
        releaseAcquiringBillCurrencyOpLock();
      }
    });

    // v3.0.5 PR-4（Part B Phase 2 / B.6）：biz-op + bank-bu 侧库孤儿双向兜底（启动扫描各自 run-data/{module}/）。
    //   ① 有文件无 imports/镜像（空壳/损坏）→ 删文件；② 有镜像无文件 → 标记 run 失效（UI 降级，不崩溃）。
    //   两模块无 op lock（导入/对账非长任务、无 cleanup 计时器）→ 直接跑；后台 setImmediate 不阻塞窗口。
    setImmediate(() => {
      if (!database || !database.db) return;
      const userDataDir = path.dirname(database.dbPath);
      for (const [domain, runData] of [['biz-op-recon', bizOpReconRunData], ['bank-bu-recon', bankBuReconRunData]]) {
        try {
          const stats = runData.reconcileOrphans({ userDataDir, mainDb: database.db });
          if (stats && (stats.deletedOrphanFiles.length > 0 || stats.invalidatedRuns.length > 0)) {
            appendActivityLogEntry({
              level: 'info',
              source: 'main',
              domain,
              message: `[${domain}] 启动期侧库孤儿双向兜底完成（PR-4）`,
              details: [
                `删孤儿文件: ${stats.deletedOrphanFiles.length} (${stats.deletedOrphanFiles.join(', ')})`,
                `标记失效 run: ${stats.invalidatedRuns.length} (${stats.invalidatedRuns.join(', ')})`
              ]
            });
          }
        } catch (err) {
          try {
            appendActivityLogEntry({
              level: 'error',
              source: 'main',
              domain,
              message: `[${domain}] 启动期侧库孤儿兜底失败（PR-4）`,
              details: [String(err && err.stack ? err.stack : err)]
            });
          } catch (_logErr) { /* swallow */ }
        }
      }
    });

    // v3.0.5 PR-2（Part B Phase 0 / B-D8）：旧备份保留策略 —— 合并 backups/ + 根目录旧格式为一个池子，
    //   mtime 降序保留最近 2 份，其余删除。启动后台异步（setImmediate，与上面 fix10 cleanup 同风格），
    //   不阻塞窗口 ready；逐个被删文件写一条 activity log（含文件名/大小/mtime），单文件删除失败不中断、记 error 级。
    //   ⚠️ 删用户数据动作（R-1）：白名单基于实际命名（tool-data-bak-*.sqlite / tool-data.sqlite.bak-*），
    //   绝不触碰主库本体（tool-data.sqlite / tool-data-pending.sqlite）及 -wal/-shm 旁文件，未知文件一律不动。
    setImmediate(() => {
      try {
        const userDataDir = app.getPath('userData');
        const backupsDir = path.join(userDataDir, 'backups');
        const entries = backupRetention.collectManagedBackupEntries({
          backupsDir,
          rootDir: userDataDir
        });
        const toDelete = backupRetention.selectBackupsToDelete(entries, { keep: 2 });
        if (toDelete.length === 0) return;

        for (const entry of toDelete) {
          try {
            fs.unlinkSync(entry.filePath);
            appendActivityLogEntry({
              level: 'info',
              source: 'main',
              domain: 'backup-retention',
              message: `清理旧备份：${entry.fileName}（保留最近 2 份策略）`,
              details: [
                `大小: ${(entry.size / (1024 * 1024)).toFixed(2)} MB`,
                `修改时间: ${new Date(entry.mtimeMs).toISOString()}`
              ]
            });
          } catch (delErr) {
            // 单文件删除失败不中断后续删除，记 error 级
            appendActivityLogEntry({
              level: 'error',
              source: 'main',
              domain: 'backup-retention',
              message: `清理旧备份失败：${entry.fileName}`,
              details: [String(delErr && delErr.message ? delErr.message : delErr)],
              stack: delErr && delErr.stack ? delErr.stack : undefined
            });
          }
        }
      } catch (err) {
        // 扫描/选取阶段异常仅记日志，不阻塞应用使用
        appendActivityLogEntry({
          level: 'error',
          source: 'main',
          domain: 'backup-retention',
          message: '旧备份保留策略执行失败',
          details: [String(err && err.stack ? err.stack : err)]
        });
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

    // v3.0.3 PR-D（W5）：OneDrive 导出目录提示（启动后单次 toast）
    //   spec acquiring-import-recon-perf §9.4 — 仅 Windows + 工作目录命中 OneDrive 同步路径 + 未提示过 → 弹 Notification。
    //   setImmediate 异步不阻塞窗口 ready（与上面 fix10 startup cleanup 同风格）；失败仅静默兜底。
    setImmediate(() => {
      notifyOneDriveStorageIfNeeded();
    });

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
}

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

// v3.0.3 PR-D（W5）：OneDrive 导出目录提示（spec acquiring-import-recon-perf §9.4 / §二-W5）
//   触发链路：app.whenReady → createWindow 后 setImmediate 调用本函数（主窗口已可用）。
//   触发条件全 AND：
//     (1) 平台 win32 且 ensureStorageRoot() 路径命中 OneDrive（isStorageRootOnOneDrive 内含平台门控）
//     (2) 未提示过（防重 key win_onedrive_storage_notice_shown != '1'）
//   命中 → 弹 Electron Notification（OneDrive 同步会拖慢大文件导出/导入）→ 置防重 key（只提示一次）。
//   ⚠️ Notification 直接构造：notifyAcquiringBillCurrencyResult 是 IPC handler 闭包内局部函数，模块顶层访问不到；
//      沿用其同款 Notification.isSupported() 兜底（无 GUI 的 CI / SSH 头环境不弹）。
//   失败容忍：全程 try/catch，任何异常仅记日志，不影响启动；防重 key 仅在成功 show 后置位。
function notifyOneDriveStorageIfNeeded() {
  try {
    if (!database || !database.db) return;
    const storageRoot = ensureStorageRoot();
    if (!isStorageRootOnOneDrive(storageRoot)) return;
    if (database.hasShownWinOneDriveStorageNotice()) return;
    if (!Notification || typeof Notification.isSupported !== 'function' || !Notification.isSupported()) return;
    new Notification({
      title: '导出目录位于 OneDrive 同步路径',
      body: '大文件导出可能变慢，建议在 OneDrive 设置中排除该目录'
    }).show();
    // 提示成功后才置防重 key（show 失败则下次启动可重试）
    database.markWinOneDriveStorageNoticeShown();
  } catch (err) {
    try {
      appendActivityLogEntry({
        level: 'warning',
        source: 'main',
        domain: 'storage',
        message: '[storage] OneDrive 目录提示失败（不影响启动）',
        details: [err && err.message ? err.message : String(err)],
        stack: err && err.stack ? err.stack : undefined
      });
    } catch (_logErr) { /* swallow */ }
  }
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
    const operation = businessOperationRegistry.begin({
      channel: 'background:idle-cleanup',
      moduleKey: '收单单据币种校验',
      functionKey: '后台清理'
    });
    if (!operation.accepted) return;
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
    } finally {
      businessOperationRegistry.end(operation.token);
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
let quitPreparationPromise = null;
let quitPreparationComplete = false;
let normalQuitInProgress = false;
let normalQuitContinuation = false;
let usageStatsSessionEnded = false;
let quitPreparationPreviousLastClosedAt = null;

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
    throw shutdownErr;
  }
}

function flushUsageStatsForQuit() {
  let failure = null;
  const previousLastClosedAt = usageStats ? usageStats.lastClosedAt : null;
  try {
    if (usageStats) {
      if (!usageStatsSessionEnded) {
        usageStatsModule.recordSessionEnd(usageStats);
        usageStatsSessionEnded = true;
        usageStatsDirty = true;
      }
      if (usageStatsDirty) flushUsageStats();
      if (usageStatsDirty) throw new Error('usage-stats 退出统计落盘失败');
    }
  } catch (err) {
    failure = err;
    if (usageStats) usageStats.lastClosedAt = previousLastClosedAt;
    usageStatsSessionEnded = false;
    usageStatsDirty = Boolean(usageStats);
    appendActivityLogEntry({
      level: 'warning',
      source: 'main',
      domain: 'usage-stats',
      message: '[usage-stats] before-quit flush failed',
      details: [err && err.message ? err.message : String(err)],
      stack: err && err.stack ? err.stack : undefined
    });
  }
  if (!failure) {
    if (usageStatsAutoFlushTimer) {
      clearInterval(usageStatsAutoFlushTimer);
      usageStatsAutoFlushTimer = null;
    }
    if (idleCleanupTimer) {
      clearInterval(idleCleanupTimer);
      idleCleanupTimer = null;
    }
  }
  if (failure) throw failure;
}

function listPendingCleanupRunsForQuit() {
  if (!database || !database.db) return [];
  if (database && database.db) {
    try {
      return runRepo.listPendingCleanupRuns(database.db) || [];
    } catch (listErr) {
      appendActivityLogEntry({
        level: 'error',
        source: 'main',
        domain: 'acquiring-bill-currency',
        message: '[acquiring-bill-currency] before-quit listPendingCleanupRuns 失败',
        details: [listErr && listErr.message ? listErr.message : String(listErr)],
        stack: listErr && listErr.stack ? listErr.stack : undefined
      });
      throw listErr;
    }
  }
  return [];
}

async function prepareApplicationForQuit() {
  if (quitPreparationComplete) return;
  if (quitPreparationPromise) return quitPreparationPromise;

  quitPreparationPromise = (async () => {
    businessOperationRegistry.beginShutdownTransition();
    const businessDrainTimer = setTimeout(() => {
      appendActivityLogEntry({
        level: 'warning',
        source: 'main',
        domain: 'app-quit',
        message: '退出等待活动业务完成已超过 5 秒，完成后将继续退出'
      });
    }, 5000);
    if (businessDrainTimer.unref) businessDrainTimer.unref();
    try {
      await businessOperationRegistry.waitForIdle();
    } finally {
      clearTimeout(businessDrainTimer);
    }

    if (needsWorkerShutdown()) await shutdownWorkerPoolGracefully();

    const archiveDrainTimer = setTimeout(() => {
      appendActivityLogEntry({
        level: 'warning',
        source: 'main',
        domain: 'archive-center',
        message: '退出等待存档任务已超过 5 秒，完成后将继续退出'
      });
    }, 5000);
    if (archiveDrainTimer.unref) archiveDrainTimer.unref();
    try {
      await archiveOperationTail;
    } finally {
      clearTimeout(archiveDrainTimer);
    }

    const pendingRuns = listPendingCleanupRunsForQuit();
    const failures = [];
    if (pendingRuns.length > 0 && database && database.db) {
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
          failures.push(cleanErr);
        }
      }
    }

    if (failures.length > 0) {
      throw new Error(`退出清理失败：${failures.length} 个运行数据未完成清理`);
    }
    if (positionReconciliationService) {
      syncPositionReconciliationCheckpoint();
      positionReconciliationService.close();
      positionReconciliationService = null;
    }
    if (vccFinancialOpService) {
      await vccFinancialOpService.terminate();
      vccFinancialOpService = null;
    }
    quitPreparationPreviousLastClosedAt = usageStats ? usageStats.lastClosedAt : null;
    flushUsageStatsForQuit();
    quitPreparationComplete = true;
  })().finally(() => {
    if (!quitPreparationComplete) {
      businessOperationRegistry.cancelInstallTransition();
      quitPreparationPromise = null;
    }
  });

  return quitPreparationPromise;
}

function resumeApplicationAfterFailedRestart() {
  if (!quitPreparationComplete) return;

  quitPreparationComplete = false;
  quitPreparationPromise = null;
  usageStatsSessionEnded = false;
  if (usageStats) {
    usageStats.lastClosedAt = quitPreparationPreviousLastClosedAt;
    usageStatsDirty = true;
    flushUsageStats();
  }
  quitPreparationPreviousLastClosedAt = null;

  if (!usageStatsAutoFlushTimer) {
    usageStatsAutoFlushTimer = setInterval(flushUsageStats, USAGE_STATS_FLUSH_INTERVAL_MS);
  }
  if (!idleCleanupTimer && database && database.db) setupIdleCleanupTimer();
}

app.on('before-quit', (event) => {
  if (businessOperationRegistry.isInstallTransitionActive() && !quitPreparationComplete) {
    event.preventDefault();
    return;
  }
  if (normalQuitContinuation || quitPreparationComplete) return;
  event.preventDefault();
  if (normalQuitInProgress) return;
  normalQuitInProgress = true;

  prepareApplicationForQuit()
    .catch((error) => {
      // 普通退出维持历史容错语义；升级重启由调用方直接 await 并阻断安装。
      appendActivityLogEntry({
        level: 'error',
        source: 'main',
        domain: 'app-quit',
        message: '退出清理未全部完成，普通退出继续执行',
        details: [error && error.message ? error.message : String(error)]
      });
    })
    .finally(() => {
      normalQuitContinuation = true;
      app.quit();
    });
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
