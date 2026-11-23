const { initializeActionTaskBindingStartup } = require('./main-process/background-execution/action-task-binding-registry');
const {
  createRecoveryControlRepository
} = require('./main-process/background-execution/critical/recovery-control-repository');
const {
  createRecoveryControlReadRepository
} = require('./main-process/background-execution/critical/recovery-control-read-repository');
const { withoutRetiredRecoveryRecords } = require('./main-process/background-execution/retired-recovery-actions');
const {
  createRecoveryObservationAttemptRepository,
  createRecoveryRequestOwnerRepository
} = require('./main-process/background-execution/critical/recovery-request-owner-repository');
const {
  createInspectorRegistry
} = require('./main-process/background-execution/inspector-registry');
const {
  createSettlementRecoveryProviderRegistry
} = require('./main-process/background-execution/settlement-recovery-provider-registry');
const {
  createStartupRecoveryCoordinator
} = require('./main-process/background-execution/startup-recovery-coordinator');
const { createApplicationRecoveryComposition } = require('./main-process/execution-descriptors/composition');
const {
  createRecoveryHoldGate
} = require('./main-process/background-execution/recovery-hold-gate');
const {
  createWorkerDurableCoordinatorRouter
} = require('./main-process/background-execution/worker-durable-coordinator-router');
const { createHash, createHmac, randomBytes, randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os'); // v2.1.12 β.1-T3：多 worker D33 OOM clamp（cpus / freemem）
const { AsyncLocalStorage } = require('node:async_hooks');
const XLSX = require('xlsx');
const { performance } = require('node:perf_hooks');
const { app, BrowserWindow, dialog, ipcMain, nativeImage, nativeTheme, Notification, powerMonitor, shell } = require('electron');
const { createDarkModeScheduler, resolveWindowBackgroundColor } = require('./main-process/dark-mode-scheduler');
const {
  parsePackagedRuntimeRequest
} = require('./main-process/background-execution/canary/packaged-runtime-request');

let packagedRuntimeRequest = null;
let packagedRuntimeRequestError = null;
try {
  packagedRuntimeRequest = parsePackagedRuntimeRequest(process.env);
} catch (error) {
  packagedRuntimeRequestError = error;
}
// Env 非法也属于显式 canary 请求，必须走隔离失败退出，不能回落到普通应用启动。
const packagedRuntimeModeSelected = packagedRuntimeRequest !== null || packagedRuntimeRequestError !== null;
function packagedRuntimeStartupErrorCode(error) {
  return error && typeof error.code === 'string' && /^[A-Z0-9_:-]{1,64}$/.test(error.code)
    ? error.code
    : 'PACKAGED_CANARY_STARTUP_FAILED';
}
const { AppDatabase } = require('./backend/database');
const { runStartupPhase, startStartupPhase } = require('./backend/startup-phase');
const {
  createWindowInstrumentation,
  showReadyWindow,
  shouldAcceptInitialRendererMetrics,
  waitForWindowReady
} = require('./main-process/startup-window');
const {
  createPreFundTerminalRouteRegistration,
  preFundRunTerminalRoute,
  preservePreFundRunOwnerAfterMirrorCompensationFailure,
  recoverPreFundRunReceipts
} = require('./main-process/pre-fund-archive-lineage');
const {
  createAppUpdaterService,
  detectDistribution
} = require('./main-process/app-updater');
const { createReleaseNotesState } = require('./main-process/release-notes/service');
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
  SUPPORT_ACTION_POLICIES
} = require('./main-process/archive-center/task-policy-registry');
const {
  createBankStatementRunFlowIdentity
} = require('./main-process/fund-recon-worker/archive-task-policies');
const {
  createTaskPolicyRegistry
} = require('./main-process/execution-descriptors/composition');
const { createBusinessFlowResolver } = require('./main-process/archive-center/business-flow-resolver');
const { createTemplateResourceService } = require('./main-process/template-resources/service');
const {
  STRUCTURE_RESOURCE_ID: BANK_ACCOUNT_STRUCTURE_RESOURCE_ID,
  createBankAccountService
} = require('./main-process/bank-accounts/service');
const { INPUT_STRUCTURES } = require('./main-process/template-resources/input-structures');
const {
  createTaskLifecycle
} = require('./main-process/archive-center/task-lifecycle');
const {
  freezeWorkerBatchContext
} = require('./main-process/archive-center/worker-batch-context');
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
  artifactManifestFromFilePlan,
  normalizeFilePlanV1
} = require('./main-process/archive-center/file-plan');
const {
  createArchiveService
} = require('./main-process/archive-center/archive-service');
const {
  createArchiveRepository
} = require('./backend/database/archive-repository');
const {
  createArchiveRuntimeDelegate
} = require('./main-process/archive-center/archive-runtime-delegate');
const {
  createPositionOwnedDeleteSourceResolver,
  positionDeleteSourceReferences
} = require('./main-process/archive-center/position-owned-delete-sources');
const { createPositionReportDeleteProtection } = require('./main-process/position-reconciliation/archive-report-delete-protection');
const {
  positionInputFilePlanEvidence
} = require('./main-process/position-reconciliation/archive-file-plan-evidence');
const {
  createArchiveStorageRootManager
} = require('./main-process/archive-center/storage-root-manager');
const {
  createArchiveCenterController
} = require('./main-process/archive-center/controller');
const { resolveRetentionDays } = require('./main-process/archive-center/retention-policy');
const { createRetiredTerminalRouteRegistrations } = require('./main-process/archive-center/retired-terminal-routes');
const {
  createArchiveOutboxStore
} = require('./main-process/archive-center/outbox-store');
const { applyWatermark } = require('./main-process/workbook-watermark');
// v3.0.14：前置资金对账 session/service（临时 MPT + 严格1:1 + 5-sheet 导出）。
const {
  createPreFundReconciliationService
} = require('./main-process/pre-fund-reconciliation/service');
const {
  createPreFundMptHoldGate
} = require('./main-process/pre-fund-reconciliation/mpt-import/hold-gate');
const {
  executeManagedPreFundMptImport
} = require('./main-process/pre-fund-reconciliation/mpt-import/managed-import');
const {
  createPreFundMptOutcomeInspector
} = require('./main-process/pre-fund-reconciliation/mpt-import/outcome-inspector');
const {
  PRE_FUND_MPT_POLICIES,
  PRE_FUND_MPT_STATIC_KEYS
} = require('./main-process/pre-fund-reconciliation/mpt-import/policies');
const {
  preFundMptRecoveryPlanTransitions
} = require('./main-process/pre-fund-reconciliation/mpt-import/recovery-plan');
const {
  createWorkerDurableCoordinator: createPreFundMptWorkerDurableCoordinator
} = require('./main-process/pre-fund-reconciliation/mpt-import/worker-durable-coordinator');
const {
  createPreFundMptReceiptAuthority
} = require('./main-process/pre-fund-reconciliation/mpt-import/receipt-authority');
const {
  createReconFixJpmHoldGate
} = require('./main-process/recon-id-fix-service/jpm-hold-gate');
const {
  deriveReconFixJpmDatabaseIdentity
} = require('./main-process/recon-id-fix-service/jpm-database-authority');
const {
  createReconFixJpmOutcomeInspector
} = require('./main-process/recon-id-fix-service/jpm-outcome-inspector');
const {
  createReconFixJpmReceiptAuthority
} = require('./main-process/recon-id-fix-service/jpm-receipt-authority');
const {
  reconFixJpmRecoveryPlanTransitions
} = require('./main-process/recon-id-fix-service/jpm-recovery-plan');
const {
  createReconFixJpmRecoveryTaskStateReader
} = require('./main-process/recon-id-fix-service/jpm-recovery-task-state');
const {
  createReconFixJpmWorkerDurableCoordinator
} = require('./main-process/recon-id-fix-service/jpm-worker-durable-coordinator');
const {
  RECON_FIX_JPM_POLICY,
  RECON_FIX_RUN_JPM_ACTION
} = require('./main-process/recon-id-fix-service/policies');
// v3.0.15：重复入金匹配（银行 Reversal/Inbound 分组 + 临时入金 MPT 回填 + 双 sheet 导出）。
const {
  createDuplicateInboundMatchService
} = require('./main-process/duplicate-inbound-match/service');
const {
  DUPLICATE_STARTUP_CONFLICT_SCOPE_KEY,
  DUPLICATE_IMPORT_STARTUP_INSPECTOR_KEY,
  DUPLICATE_STARTUP_INSPECTOR_KEY,
  DUPLICATE_STARTUP_RECOVERY_KEY,
  createDuplicateStartupOutcomeInspector,
  createDuplicateStartupRecoveryProvider
} = require('./main-process/duplicate-inbound-match/startup-recovery');
const {
  DUPLICATE_STARTUP_GATE_CONTRACT_VERSION
} = require('./main-process/duplicate-inbound-match/startup-gate');
// v3.1.0：平盘资金性质校验（持久化银行/链接侧库 + 严格1:1匹配 + 结果回导确认）。
const {
  createPositionReconciliationService
} = require('./main-process/position-reconciliation/service');
const {
  PositionReconciliationError
} = require('./main-process/position-reconciliation/common');
const { createPositionTaskOwner } = require('./main-process/position-reconciliation/task-owner');
const { createExecutionTaskComposition } = require('./main-process/execution-descriptors/composition');
const { createPreparedResourceScope } = require('./main-process/task-adapters/prepared-resources');
const {
  createPositionRunTaskContract,
  createPositionSourceImportTaskContract
} = require('./main-process/position-reconciliation/interactive-task-preflight');
const {
  dispatchPositionLargeImportSchemaMigration
} = require('./main-process/position-reconciliation/import-dispatch');
const {
  hashFileSha256Async
} = require('./main-process/position-reconciliation/input-staging');
const {
  POSITION_SIDE_DB_CHECKPOINT_SETTING,
  POSITION_SIDE_DB_BOOTSTRAP_SETTING
} = require('./main-process/position-reconciliation/constants');
const {
  authorizePositionImportApply,
  positionPersistentStagingProtectionPaths,
  positionReconciliationFailureResult
} = require('./main-process/position-reconciliation/operation-lifecycle');

// 空闲维护计时器（v3.2.17 起驱动空闲时自动整理主库）
//   - lastUserActivityTs：renderer 上报的用户最后活动时间（IPC `app:user-activity`）
//   - IDLE_CHECK_INTERVAL_MS：定时器轮询粒度（2 分钟）
//   v3.2.20：原收单单据币种校验的空闲清理随模块下线移除。
const IDLE_CHECK_INTERVAL_MS = 2 * 60 * 1000;
let lastUserActivityTs = Date.now();
let idleCleanupTimer = null;
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
const { GATEWAY_RECON_FIELDS } = require('./constants/gateway-recon-fields');
// v2.1.16 阶段一 A4：链接表导入（识别 → 读行 → 落库）
//   - detectTableType：A2 按表头自动识别表类型
//   - LINKED_IMPORT_SIGNATURES：链接表「导入」按钮候选集 = 4 张 linked 签名 + 入金表签名（v2.1.16-beta.3 ②）
//   - linkedTableReaders.readRowsWithMetadata：读全部有意义行（交割表表头在第 2 行，滑窗自动定位）
const { detectTableType } = require('./main-process/table-type-detector');
const {
  linkedStructureMismatchLines,
  projectLinkedRow,
  resolveLinkedSignatures,
  versionSignatureOf,
  withBankStatementStructure
} = require('./main-process/linked-structure-signatures');
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
// v3.2.18：链接表按数据日期统计 / 删除 + 派生联动的共享实现（手工删除与链接表过期清理共用，禁复制 = R-5）。
const {
  isLinkedDeleteTable,
  countLinkedTableRowsByDateRange,
  deleteLinkedTableRowsByDateRange
} = require('./main-process/linked-table-delete');
const {
  listPublicRetentionTables,
  readRetentionDaysByTable: readLinkedRetentionDaysByTable,
  setTableRetentionDays: setLinkedTableRetentionDays
} = require('./main-process/linked-table-retention/policy');
const linkedTableReaders = require('./backend/file-service/readers');
// v3.2.21：渠道余额方式不同时按明细导出的口径识别收支都为空或 0 的行
const { isDetailExportAmountRow, isZeroOrBlankAmount } = require('./backend/file-service/normalizers');
const {
  normalizeCell: normalizeLinkedCell,
  trimTrailingEmptyCells: trimToolboxTrailingEmptyCells,
  FileValidationError: LinkedFileValidationError
} = require('./backend/file-service/common');
// v2.1.12 需求1：VCC业务OP计算模块（仅流水文件 → 按月聚合发生额出/入 → 算期末OP，资金红线 🔴）
const { createVccOpCalcSession } = require('./main-process/vcc-op-calc-session');
const {
  interruptVccOpSaveRunTask,
  isVccOpSaveRunRecoveryRequired
} = require('./main-process/vcc-op-calc/save-run-lifecycle');
// v3.1.6：VCC财务OP校验（四类明细幂等、逐币种计算、系统OP比较与归档）。
const { createVccFinancialOpService } = require('./main-process/vcc-financial-op-service');
const { resolveVccSourceStructures } = require('./main-process/vcc-financial-op-source-structures');
const { resolveFlowStatementStructure } = require('./main-process/flow-statement-structure');
const { bankStatementSourceHeaders, resolveBankStatementStructure } = require('./main-process/bank-statement-structure');
const { createResultExportHandlers } = require('./main-process/vcc-financial-op-result-export-ipc');
const { acquireResultExportLease } = require('./main-process/vcc-financial-op-result-workbook-runner');
const {
  recoverVccStorageMigration
} = require('./main-process/vcc-financial-op-storage-rebuild');
const {
  buildVccImportArchiveHandoffFiles,
  listRecoverableVccImportArchiveBatchIds,
  recoverVccImportArchiveTasks,
  reconcileVccImportArchiveLineageAtStartup,
  persistVccImportHandoffV2
} = require('./main-process/vcc-financial-op-archive-lineage');
const { vccFinancialOpErrorResult } = require('./main-process/vcc-financial-op-ipc');
const {
  publishVccFinancialOpOutputs
} = require('./main-process/vcc-financial-op-output-recovery');
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
  writeErrorReportOutputToPath,
  buildMainOutputFileName,
  buildTimestamp,
  buildTimestampMinuteUnderscore,
  buildDateDir,
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
  createBackgroundExecutionRuntimeManager
} = require('./main-process/execution-descriptors/composition');
const {
  PRE_FUND_READ_ONLY_ACTIONS
} = require('./main-process/read-only-exports/pre-fund/policies');
const {
  assertPreFundSourceSnapshot,
  freezePreFundSourceSnapshot
} = require('./main-process/read-only-exports/pre-fund/query');
const {
  generateValidateAndPublishPreFundExport
} = require('./main-process/read-only-exports/pre-fund/managed-export');
const {
  POSITION_READ_ONLY_ACTION
} = require('./main-process/read-only-exports/position/policies');
const {
  assertPositionSourceSnapshot,
  freezePositionSourceSnapshot
} = require('./main-process/read-only-exports/position/query');
const {
  generateValidateAndPublishPositionExport
} = require('./main-process/read-only-exports/position/managed-export');
const {
  settlePositionPublishedMetadata
} = require('./main-process/read-only-exports/position/settlement');
const {
  VCC_FINANCIAL_OP_READ_ONLY_ACTION
} = require('./main-process/read-only-exports/vcc-financial-op/policies');
const {
  assertVccFinancialOpSourceSnapshot,
  freezeVccDatasetSourceSnapshot,
  freezeVccImportAuditSourceSnapshot
} = require('./main-process/read-only-exports/vcc-financial-op/query');
const {
  generateValidateAndPublishVccFinancialOpExport
} = require('./main-process/read-only-exports/vcc-financial-op/managed-export');
const {
  TOOLBOX_GENERATION_ACTIONS
} = require('./main-process/toolbox-background/generation-contract');
const {
  generateValidateAndPublish: generateValidateAndPublishToolboxArtifact
} = require('./main-process/toolbox-background/generation-validator');
const {
  generateValidateAndPublishMultiOutput
} = require('./main-process/toolbox-background/multi-output-validator');
const { MAX_ROW_SPLIT_FILES, publicResult: toolboxRowsPublicResult } = require('./main-process/toolbox-row-split/contracts');
const { registerWithMemoryActivity, sealMemoryActivityInventory, runMemoryActivity } = require('./main-process/memory-activity');
const { createPublicationMemoryAdmission } = require('./main-process/execution-descriptors/publication-memory');
sealMemoryActivityInventory();
const { prepareRows: prepareToolboxRows, generateValidateAndPublishRows } = require('./main-process/toolbox-row-split/service');
const {
  publishToolboxPublicationAsync,
  getDefaultToolboxPublicationDispatcher
} = require('./main-process/toolbox-output-publication-dispatch');
const { createPublicationRecoveryCoordinator } = require('./main-process/publication-recovery/coordinator');
const { createArchivePublicationOwner } = require('./main-process/publication-recovery/archive-owner');
const {
  RETIRED_PUBLICATION_DEFER_CODE,
  RETIRED_PUBLICATION_MANUAL_CODE,
  createRetiredModulePublicationOwner
} = require('./main-process/publication-recovery/retired-module-owner');
const {
  JOURNAL_INDEX_NAME
} = require('./main-process/toolbox-output-publication');
const {
  recoverToolboxPublicationsIntoArchive,
  acknowledgeToolboxPublicationReceipts: acknowledgeToolboxPublicationReceiptsIntoArchive,
  toolboxRecoveryOutputFiles: toolboxFinalOutputFiles
} = require('./main-process/toolbox-archive-recovery');
const {
  pathsAlias
} = require('./main-process/toolbox-target-identity');
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
const { createToolboxSplitReadOwner } = require('./main-process/toolbox-split-read-owner');
const { recoverToolboxScanResources } = require('./main-process/toolbox-scan-resources');
// v2.1.9 N5 T26（spec §5.4 🔴 对外契约破坏性变更）：场景命中行独立报表 writer
//   v2.1.8 主输出 Sheet 3 撤除 → 改独立报表 命中场景行-{basename}-{ts}.xlsx
//   v3.0.4 F2：落位由 error-reports/{date}/ 改为 bank-statement-process/{date}/（与错误报告目录互换）
//   失败 graceful：不阻塞主对账流程，仅 log 警告（spec §5.4）
const {
  writeScenarioHitRows,
  buildOriginalBaseName: buildScenarioHitRowsBaseName
} = require('./main-process/scenario-hit-rows-writer');
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
const {
  BUSINESS_BILL_FIELDS,
  BUSINESS_BILL_SHEET_NAME,
  OPPONENT_BILL_FIELDS,
  OPPONENT_BILL_SHEET_NAME
} = require('./constants/recon-id-fix-fields');
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
  resolveManualBalanceSeedFilePlanInputPaths,
  writeManualBalanceSeedPlan
} = require('./main-process/manual-balance-seed-preflight');
const {
  MANUAL_BALANCE_ACTION_KEY,
  MANUAL_BALANCE_INSPECTOR_KEY,
  MANUAL_BALANCE_SETTLEMENT_KEY,
  createManualBalanceRecoveryPlanTransitions,
  createManualBalanceSeedInspector,
  createManualBalanceSettlementRecoveryProvider,
  manualBalanceRecoveryPolicy,
  resolveManualBalanceTargetAlias
} = require('./main-process/manual-balance-seed-settlement');
const { parseBankAccountExcel } = require('./backend/bank-account-import');
const {
  matchBalanceSeedImport,
  parseBalanceSeedImportRows,
  readBalanceSeedImportFile
} = require('./backend/balance-seed-import');
const { writeOwnAccounts } = require('./backend/own-account-store');
const {
  readBalanceAdjustments,
  writeBalanceAdjustments,
  resolveBalanceAdjustment
} = require('./backend/balance-adjustment-store');
const { readBigAccountOrder, writeBigAccountOrder } = require('./backend/big-account-order-store');
const { readBigAccountMode, writeBigAccountMode } = require('./backend/big-account-mode-store');
const {
  appendCurrencyBigAccountIssues,
  calculateEndingBalanceFromAmounts,
  buildDetailExportRows,
  buildExpectedHeaderCandidates,
  buildMappedRows,
  buildCurrencyBigAccountUnmappedError,
  compileRegexLiteral,
  FileValidationError,
  FIXED_FIELD_VALUE_PREFIX,
  MERCHANT_ID_CURRENCY_ONLY_MARKER,
  extractHeaders,
  isCurrencyBigAccountUnmappedError,
  isRegexLiteral,
  mapEachCollectingCurrencyBigAccountIssues,
  loadCurrencyMappings,
  loadEnumValues,
  normalizeCell,
  normalizeFeeAmountFormula,
  validateFeeAmountFormula,
  normalizeFeeFieldMappings,
  validateFeeFieldMappings,
  isFeeFieldMappingTemplateFieldExcluded,
  normalizeBillSplitRowFilterRules,
  validateBillSplitRowFilterRules,
  PREPROCESS_ROW_FILTER_MISSING_MESSAGE,
  normalizeRowFilterRules,
  validateRowFilterRules,
  buildFeatureFilterToken,
  buildLogicValueToken,
  describeDuplicateKeeperReplacementConflicts,
  dropDuplicateSourceRows,
  findDuplicateKeeperReplacementConflicts,
  scanDuplicateSourceRows,
  getFeatureFilterRef,
  normalizeFeatureFilterList,
  normalizeLogicValueFields,
  LOGIC_VALUE_MIN_FIELDS,
  parseFeatureFilterToken,
  buildLogicValueFeatureCandidate,
  parseLogicValueFeatureFilterRef,
  parseLogicValueToken,
  resolveUsedFeatureFilters,
  upgradeLegacyFeatureFilter,
  LEGACY_FEATURE_FILTER_ID,
  parseDateValue,
  parseNumericValue,
  prepareWorkbookTextForWrite,
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
  createStatementGenerationHelpers,
  selectBalanceAccountRows
} = require('./main-process/statement-generation');
const {
  DUPLICATE_REVIEW_STATUS,
  createStatementDuplicateReview,
  hasSourceRowKeys: hasDuplicateRowKeys
} = require('./main-process/statement-duplicate-review');
const {
  createTemplateHeaderUpdateTools,
  diffTemplateHeaders
} = require('./main-process/template-header-update');
const {
  buildDateRangeLabel,
  deriveBalanceRecords,
  parseRequiredBillDates,
  resolveAccountBalanceModes,
  scanBalanceSeedStatus: scanStatementBalanceSeedStatus
} = require('./main-process/statement-generation-business');
// v3.2.15：网银账单渠道的输出身份、生成分组与余额方式
const {
  describeBalanceMode,
  resolveGenerationGroupKey,
  resolveStatementOutputName,
  resolveTemplateBalanceMode
} = require('./main-process/statement-channel-identity');
// v3.2.16：模板管理【余额管理】
const {
  BalanceSeedManagementError,
  buildBalanceSeedActivityLog,
  deleteOwnerSeed,
  listOwnerSeeds,
  updateOwnerSeed
} = require('./main-process/balance-seed-management');
// v3.2.18【导入模板】命名
const {
  createPendingTemplateImportStore,
  findTemplateImportNameConflict,
  normalizeTemplateImportName
} = require('./main-process/template-import-naming');
const {
  ALL_BANKS_TEMPLATE_SCOPE,
  assembleMonthlyBalance,
  toBalanceRows
} = require('./main-process/monthly-balance');
const {
  showImportOpenDialog: showRememberedImportOpenDialog
} = require('./main-process/import-dialog-state');
const {
  findSavedOrderFileRowMismatches,
  hasUnidentifiedTransactionRows,
  matchImportFilesToSavedOrder,
  matchMerchantIds,
  normalizeMaintainedBigAccounts,
  resolveRecognizedBigAccount
} = require('./main-process/big-account-recognition');
const {
  NEW_ACCOUNT_EXPORT_NAME,
  normalizeNewAccountAccounts,
  prepareNewAccountGeneration,
  validateNewAccountAccounts
} = require('./main-process/new-account/generation-core');

if (!packagedRuntimeModeSelected && process.env.APP_USER_DATA_DIR) {
  app.setPath('userData', process.env.APP_USER_DATA_DIR);
}

if (!packagedRuntimeModeSelected && process.env.APP_DOCUMENTS_DIR) {
  app.setPath('documents', process.env.APP_DOCUMENTS_DIR);
}

if (!packagedRuntimeModeSelected && process.platform === 'win32') {
  app.setAppUserModelId('com.openai.bankbillexceltool');
}

let mainWindow = null;
let darkModeScheduler = null;
let applicationStartupComplete = false;
let mainWindowReady = false;
let initialStartupWebContentsId = null;
// 运行结果 side DB 会在启动和新 run 时整库回收，必须阻止两个正式应用实例并发操作同一 userData。
// preview/startup:measure 使用隔离临时目录，允许并行启动，避免开发工具争抢正式实例锁。
const requireSingleInstanceLock = !process.env.APP_CAPTURE_PATH
  && process.env.APP_STARTUP_MEASURE_AUTO_QUIT !== '1';
const hasSingleInstanceLock = packagedRuntimeModeSelected
  || !requireSingleInstanceLock
  || app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else if (requireSingleInstanceLock && !packagedRuntimeModeSelected) {
  app.on('second-instance', () => {
    if (!applicationStartupComplete || !mainWindowReady) return;
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
}
let database = null;
// v3.2.18【导入模板】：已预检、待用户命名确认的模板文件（不跨重启）。
const pendingTemplateImports = createPendingTemplateImportStore();
let preFundReconciliationService = null;
let duplicateInboundMatchService = null;
let positionReconciliationService = null;
let positionPendingRecoveryPromise = null;
let vccFinancialOpService = null;
let appUpdaterService = null;
let appUpdaterStartupScheduled = false;
let appUpdateTransitionToken = null;
// v3.2.14：升级后首次启动的「更新说明」，启动时判定一次，不跨重启。
let releaseNotesState = null;
let archiveCenterService = null;
let publicationRecoveryCoordinator = null;

function recoverArchivePublications(options) {
  if (!publicationRecoveryCoordinator) {
    throw Object.assign(new Error('发布恢复协调器尚未装配'), {
      code: 'PUBLICATION_RECOVERY_AUTHORITY_REQUIRED', preserveTemporaryFiles: true
    });
  }
  return publicationRecoveryCoordinator.forOwner('archive-publication').recover(options);
}
let archiveStorageRootManager = null;
let archiveCenterInitializationPromise = null;
let toolboxStartupRecoveryError = null;
let archiveOperationTracker = null;
let archiveTaskLifecycle = null;
let recoveryControlReadRepository = null;
let recoveryHoldGate = null;
let preFundMptHoldGate = null;
let preFundMptWorkerDurableCoordinator = null;
let applicationRecoveryCoordinator = null;
let reconFixJpmHoldGate = null;
let backgroundWorkerDurableCoordinator = null;

function assertReconFixJpmAdmMutationAllowed() {
  if (!reconFixJpmHoldGate) {
    throw Object.assign(new Error('ReconFix JPM Recovery Hold gate 尚未初始化'), {
      code: 'RECON_FIX_JPM_HOLD_GATE_UNAVAILABLE'
    });
  }
  return reconFixJpmHoldGate.assertMutationAllowed();
}

function runReconFixJpmAdmMutationBoundary(work) {
  if (!reconFixJpmHoldGate) {
    throw Object.assign(new Error('ReconFix JPM Recovery Hold gate 尚未初始化'), {
      code: 'RECON_FIX_JPM_HOLD_GATE_UNAVAILABLE'
    });
  }
  return reconFixJpmHoldGate.runSynchronousMutationBoundary(work);
}

// v3.2.18：链接表删除共享实现的主进程依赖（ADM 写边界与 run / 修复结果缓存）。
function linkedTableDeleteDeps() {
  return {
    database,
    appendActivityLogEntry,
    assertAdmMutationAllowed: assertReconFixJpmAdmMutationAllowed,
    admMutationBoundary: runReconFixJpmAdmMutationBoundary,
    clearProcessingResult: () => { processingResult = null; },
    clearReconIdFixResult: () => { reconIdFixResult = null; }
  };
}

let archiveOperationTail = Promise.resolve();
const backgroundExecutionRuntimeManager = createBackgroundExecutionRuntimeManager({
  diagnostics: function recordMemoryAdmissionDiagnostic(event) {
    if (!event.memoryProfile || !['resource-granted', 'resource-released'].includes(event.type)) return;
    appendActivityLogEntry({ source: 'background-execution', message: '后台阶段资源记录', details: [
      JSON.stringify({ type: event.type, action: event.actionKey, mode: event.memoryMode,
        profile: event.memoryProfile, policyDigest: event.policyDigest, bytes: event.memoryBytes,
        at: event.at, lease: event.leaseId || event.resourceId })
    ] });
  },
  workerDurableCoordinatorProvider: () => backgroundWorkerDurableCoordinator,
  reconFixJpmDatabasePathProvider: () => database && database.dbPath,
  duplicateStartupGateProvider: () => Object.freeze({
    contractVersion: DUPLICATE_STARTUP_GATE_CONTRACT_VERSION,
    startupRecoveryReady: applicationRecoveryCoordinator?.snapshot().platformScanCompleted === true
  })
});

function createReadOnlyExportStagingDirectory(batchContext, moduleKey) {
  const root = path.join(
    app.getPath('userData'),
    'run-data',
    'read-only-exports',
    String(moduleKey).replace(/[^a-zA-Z0-9._-]+/g, '-')
  );
  fs.mkdirSync(root, { recursive: true });
  const taskRunId = String(batchContext && batchContext.taskRunId || 'task')
    .replace(/[^a-zA-Z0-9._-]+/g, '-');
  return fs.mkdtempSync(path.join(root, `${taskRunId}-`));
}

function createReadOnlyExportGenerationPlan(
  stagingRoot,
  taskContext,
  actionKey,
  outputIndex = 0
) {
  const output = taskContext && taskContext.fileEvidence &&
    taskContext.fileEvidence.filePlan.outputs[outputIndex];
  if (!output || !output.artifactKey) throw new Error('只读导出缺少 output artifact authority');
  const multipleOutputs = taskContext.fileEvidence.filePlan.outputs.length > 1;
  const stagingResourceId = `${String(actionKey).replace(/[^a-zA-Z0-9._-]+/g, '-')}${
    multipleOutputs ? `-${outputIndex + 1}` : ''
  }.xlsx`;
  return Object.freeze({
    stagingRoot,
    stagingResourceId,
    generationPath: path.join(stagingRoot, stagingResourceId),
    outputArtifactKey: output.artifactKey
  });
}

function cleanupReadOnlyExportStagingDirectory(directoryPath) {
  if (!directoryPath) return;
  try {
    fs.rmSync(directoryPath, { recursive: true, force: true });
  } catch (error) {
    appendActivityLogEntry({
      level: 'warning',
      source: 'main',
      domain: 'read-only-export',
      message: '只读导出临时目录清理失败',
      details: [
        `临时目录：${directoryPath}`,
        `原因：${error && error.message ? error.message : String(error)}`
      ]
    });
  }
}

function publishReadOnlyExportArtifacts(kind, artifacts, taskContext) {
  const outputs = taskContext.fileEvidence.filePlan.outputs;
  const outputByArtifactKey = new Map(outputs.map((output) => [output.artifactKey, output]));
  const artifactByOutputKey = new Map(
    artifacts.map((artifact) => [artifact.outputArtifactKey, artifact])
  );
  if (artifacts.length !== outputs.length || outputByArtifactKey.size !== outputs.length ||
      artifactByOutputKey.size !== artifacts.length) {
    throw new Error('只读导出 artifact 与 FilePlan 输出数量不一致');
  }
  const orderedArtifacts = outputs.map((output) => {
    const artifact = artifactByOutputKey.get(output.artifactKey);
    if (!artifact) throw new Error('只读导出 artifact 缺少 FilePlan authority');
    return artifact;
  });
  return publishToolboxArtifacts(
    `read-only-${kind}`,
    orderedArtifacts.map((artifact, index) => ({
      sourcePath: artifact.generationPath,
      outputId: artifact.outputArtifactKey,
      fileName: path.basename(outputs[index].filePath),
      byteSize: artifact.byteSize,
      sha256: artifact.sha256,
      dataRowCount: artifact.dataRowCount,
      sheetCount: artifact.sheetCount,
      warningSummary: EMPTY_TOOLBOX_WARNING_SUMMARY,
      styleStats: null
    })),
    outputs.map((output) => ({ targetPath: output.filePath })),
    taskContext.batchContext,
    {
      targetSnapshots: taskContext.fileEvidence.targetSnapshots,
      archiveInputFiles: taskContext.fileEvidence.inputFiles,
      settleManifestArtifacts: taskContext.settleArtifacts,
      fileEvidence: taskContext.fileEvidence,
      allowEmptyArchiveInputs: true
    }
  );
}

function attachReadOnlyExportReceiptAcknowledgement(prepared) {
  prepared.afterTerminal = ({ terminalStatus }) => terminalStatus === 'succeeded'
    ? acknowledgeToolboxPublicationReceipts(prepared.readOnlyExportPublicationTaskIds || [])
    : null;
  return prepared;
}

function assertPreFundEvidenceFresh(expected, locator, templatePath) {
  const current = freezePreFundSourceSnapshot({
    mainDb: database.db,
    userDataDir: path.dirname(database.dbPath),
    templatePath,
    locator
  });
  return assertPreFundSourceSnapshot(current, expected);
}

async function freezePositionReadOnlyExportSource(service, variant, runId, filters) {
  await assertManagedExportUsesBuiltinTemplate('position-bank');
  const reportFiles = variant === 'filtered'
    ? (await service.resolveRunFilteredReports(Number(runId))).reportFiles.map((item) => ({
        reportKey: item.reportKey,
        filePath: item.filePath,
        sha256: item.sha256,
        sizeBytes: item.sizeBytes
      }))
    : [];
  return freezePositionSourceSnapshot({
    store: service.store,
    templatePath: service.templatePath,
    variant,
    runId,
    filters,
    reportFiles
  });
}

async function assertPositionEvidenceFresh(service, expected, context) {
  const current = await freezePositionSourceSnapshot({
    store: service.store,
    templatePath: service.templatePath,
    variant: context.variant,
    runId: expected.runId,
    filters: context.filters,
    reportFiles: context.reportFiles
  });
  return assertPositionSourceSnapshot(current, expected);
}

async function executeManagedPositionReadOnlyExport(service, prepared, taskContext) {
  const stagingRoot = createReadOnlyExportStagingDirectory(
    taskContext.batchContext,
    'position'
  );
  let preserveStaging = false;
  try {
    const generationPlan = createReadOnlyExportGenerationPlan(
      stagingRoot,
      taskContext,
      POSITION_READ_ONLY_ACTION
    );
    const assertSourceFresh = () => assertPositionEvidenceFresh(
      service,
      prepared.stableRunEvidence,
      prepared.positionExportContext
    );
    const generated = await generateValidateAndPublishPositionExport({
      runtime: backgroundExecutionRuntimeManager.get(),
      actionKey: POSITION_READ_ONLY_ACTION,
      operationKey: taskContext.batchContext.operationKey,
      taskRunId: taskContext.batchContext.taskRunId,
      batchContext: taskContext.batchContext,
      stableRunEvidence: prepared.stableRunEvidence,
      dbPathOrManagedSource: {
        kind: 'sqlite',
        sideDatabasePath: service.store.dbPath,
        templatePath: service.templatePath,
        userDataDir: service.userDataDir
      },
      generationPlan,
      context: prepared.positionExportContext,
      production: true,
      assertSourceFresh,
      publisher: (artifacts) => publishReadOnlyExportArtifacts(
        `position-${prepared.positionExportContext.variant}`,
        artifacts,
        taskContext
      )
    });
    prepared.readOnlyExportPublicationTaskIds = [generated.publication.taskId];
    const published = generated.publication.files[0];
    const metadata = settlePositionPublishedMetadata({
      store: service.store,
      variant: prepared.positionExportContext.variant,
      runId: generated.summary.runId,
      onWarning(error) {
        appendActivityLogEntry({
          level: 'warning',
          source: 'main',
          domain: 'position-read-only-export',
          message: 'Position 文件发布成功后 exported_at 补写失败',
          details: [
            `runId：${generated.summary.runId}`,
            `原因：${error && error.message ? error.message : String(error)}`
          ]
        });
      }
    });
    return {
      status: 'ok',
      filePath: published.filePath,
      runId: generated.summary.runId,
      rowCount: generated.summary.rowCount,
      fileName: path.basename(published.filePath),
      warnings: [...metadata.warnings]
    };
  } catch (error) {
    preserveStaging = shouldPreserveToolboxTemporaryFiles(error);
    throw error;
  } finally {
    if (!preserveStaging) cleanupReadOnlyExportStagingDirectory(stagingRoot);
  }
}

async function freezeVccFinancialOpReadOnlyExportSource(service, variant, payload = {}) {
  if (variant === 'import-audit') {
    return freezeVccImportAuditSourceSnapshot({
      db: database.db,
      recordId: Number(payload.recordId)
    });
  }
  const archiveSources = await service.resolveDatasetArchiveSources(payload);
  return freezeVccDatasetSourceSnapshot({
    db: database.db,
    targetMonth: payload.targetMonth,
    sourceType: payload.sourceType,
    targetKind: payload.targetKind,
    archiveSources
  });
}

async function assertVccFinancialOpEvidenceFresh(service, expected, context) {
  const current = context.kind === 'vcc-import-audit'
    ? freezeVccImportAuditSourceSnapshot({
        db: database.db,
        recordId: context.recordId
      })
    : await freezeVccFinancialOpReadOnlyExportSource(service, 'dataset', {
        targetMonth: context.targetMonth,
        sourceType: context.sourceType,
        targetKind: context.targetKind
      });
  return assertVccFinancialOpSourceSnapshot(current, expected);
}

async function publishManagedVccFinancialOpArtifact(artifacts, prepared, taskContext) {
  const outputs = taskContext.fileEvidence.filePlan.outputs;
  if (artifacts.length !== 1 || outputs.length !== 1) {
    throw new Error('VCC Financial OP read-only export 必须精确生成一个 artifact');
  }
  return publishVccFinancialOpOutputs({
    recoverPublications: recoverArchivePublications,
    batchContext: taskContext.batchContext,
    generationFilePaths: [artifacts[0].generationPath],
    targetFilePaths: [outputs[0].filePath],
    targetSnapshots: taskContext.fileEvidence.targetSnapshots,
    expectedArtifacts: [{
      byteSize: artifacts[0].byteSize,
      sha256: artifacts[0].sha256
    }],
    deferGenerationCleanup: true,
    userDataDir: app.getPath('userData'),
    archiveCenter: archiveCenterService,
    settleManifestArtifacts: (publication, evidence) => (
      settleVccOutputPublication(prepared, taskContext, publication, evidence)
    ),
    onHandoffPending: (error) => {
      appendActivityLogEntry({
        level: 'error',
        source: 'main',
        domain: 'vcc-financial-op',
        message: 'VCC 正式输出已提交，但存档接管待重试',
        details: [error && error.message ? error.message : String(error)]
      });
    }
  });
}

async function executeManagedVccFinancialOpReadOnlyExport(service, prepared, taskContext) {
  return service.runManagedReadOnlyExport('export-read-only', async () => {
    const stagingRoot = createReadOnlyExportStagingDirectory(
      taskContext.batchContext,
      'vcc-financial-op'
    );
    let preserveStaging = false;
    try {
      const generationPlan = createReadOnlyExportGenerationPlan(
        stagingRoot,
        taskContext,
        VCC_FINANCIAL_OP_READ_ONLY_ACTION
      );
      const assertSourceFresh = () => assertVccFinancialOpEvidenceFresh(
        service,
        prepared.stableRunEvidence,
        prepared.vccReadOnlyExportContext
      );
      const generated = await generateValidateAndPublishVccFinancialOpExport({
        runtime: backgroundExecutionRuntimeManager.get(),
        actionKey: VCC_FINANCIAL_OP_READ_ONLY_ACTION,
        operationKey: taskContext.batchContext.operationKey,
        taskRunId: taskContext.batchContext.taskRunId,
        batchContext: taskContext.batchContext,
        stableRunEvidence: prepared.stableRunEvidence,
        dbPathOrManagedSource: {
          kind: 'sqlite',
          mainDatabasePath: database.dbPath
        },
        generationPlan,
        context: prepared.vccReadOnlyExportContext,
        production: true,
        assertSourceFresh,
        publisher: (artifacts) => publishManagedVccFinancialOpArtifact(
          artifacts,
          prepared,
          taskContext
        )
      });
      prepared.vccOutputPublicationTaskIds = [generated.publication.taskId];
      const outputPath = taskContext.fileEvidence.filePlan.outputs[0].filePath;
      if (generated.summary.variant === 'import-audit') {
        return {
          status: 'success',
          filePath: outputPath,
          recordId: generated.summary.recordId,
          rowCount: generated.summary.rowCount,
          sheetCount: generated.summary.sheetCount
        };
      }
      return {
        status: 'success',
        filePath: outputPath,
        tableName: prepared.expectedInspection.tableName,
        targetMonth: generated.summary.targetMonth,
        sourceType: generated.summary.sourceType,
        targetKind: generated.summary.targetKind,
        dataCount: generated.summary.dataCount,
        totalRows: generated.summary.totalRows,
        exportableRows: generated.summary.dataCount,
        missingRows: generated.summary.missingRows,
        incomplete: generated.summary.incomplete,
        sheetCount: generated.summary.sheetCount
      };
    } catch (error) {
      preserveStaging = shouldPreserveToolboxTemporaryFiles(error);
      throw error;
    } finally {
      if (!preserveStaging) cleanupReadOnlyExportStagingDirectory(stagingRoot);
    }
  });
}
const archiveOperationContext = new AsyncLocalStorage();
const statementSourceReadContext = new AsyncLocalStorage();
const positionTaskOwner = createPositionTaskOwner({
  readSetting: (key) => database.getSetting(key),
  writeSetting: (key, value) => database.setSetting(key, value),
  settingsAvailable: () => Boolean(database && database.db),
  getDatabasePath: () => database && database.dbPath,
  getCurrentService: () => positionReconciliationService,
  getService: getPositionReconciliationService,
  getArchiveCenter: () => archiveCenterService,
  initializeArchiveCenter,
  getTaskLifecycle: () => archiveTaskLifecycle,
  getTaskPolicy: (channel) => taskPolicyRegistry.get(channel),
  supportsArchiveChannel: (channel) => Boolean(
    archiveOperationTracker && archiveOperationTracker.supportsChannel(channel)
  )
});
const terminalRouteRegistrations = [
  positionTaskOwner.terminalRegistration,
  // v3.2.20：已下线模块（Pending / 业务OP）的遗留终态 route 只保留识别；其通知由存档中心原样留给回退旧版。
  ...createRetiredTerminalRouteRegistrations(),
  createPreFundTerminalRouteRegistration({ getService: getPreFundReconciliationService })
];
const businessOperationRegistry = createBusinessOperationRegistry();
// v3.2.17 空闲时自动整理主库：用户 30 分钟无操作且无任务时在子进程中 VACUUM，用户一操作即中止。
const { createIdleCompactionController } = require('./main-process/database-compaction/idle-compaction');
const idleDatabaseCompaction = createIdleCompactionController({
  getDatabase: () => (database && database.db ? {
    db: database.db,
    dbPath: database.dbPath,
    getSetting: (key) => database.getSetting(key),
    setSetting: (key, value) => database.setSetting(key, value)
  } : null),
  registry: businessOperationRegistry,
  getLastUserActivityTs: () => lastUserActivityTs,
  isOtherWorkBusy: () => idleCompactionBusyReason(),
  beginMaintenance: async () => (archiveStorageRootManager
    ? archiveStorageRootManager.beginDatabaseMaintenance('正在整理存储空间，请稍后重试')
    : { acquired: true }),
  endMaintenance: async () => {
    if (archiveStorageRootManager) await archiveStorageRootManager.endDatabaseMaintenance();
  },
  log: (entry) => appendActivityLogEntry({
    level: entry.level,
    source: 'main',
    domain: 'database-maintenance',
    message: `[空闲存储整理] ${entry.message}`,
    details: entry.details
  })
});
// v3.2.18 链接表过期清理（🔴🔴 资金红线）：触发方式同空闲整理主库；持银行对账锁 + 过渡租约，
//   按设置 → 数据管理 → 链接表保留期限逐表删除过期行（与「链接表管理 → 删除」同一删除与派生链路）。
const { createIdleLinkedTableRetentionController } = require('./main-process/linked-table-retention/idle-retention');
const idleLinkedTableRetention = createIdleLinkedTableRetentionController({
  getDatabase: () => (database && database.db ? database : null),
  registry: businessOperationRegistry,
  getLastUserActivityTs: () => lastUserActivityTs,
  isOtherWorkBusy: () => idleCompactionBusyReason(),
  acquireLock: () => tryAcquireBankStatementOpLock('linked-retention'),
  releaseLock: () => releaseBankStatementOpLock(),
  countExpired: (range) => countLinkedTableRowsByDateRange(database, range),
  deleteExpired: (range) => deleteLinkedTableRowsByDateRange(linkedTableDeleteDeps(), range),
  log: (entry) => appendActivityLogEntry({
    level: entry.level,
    source: 'main',
    domain: 'linked-table-retention',
    message: `[链接表过期清理] ${entry.message}`,
    details: entry.details
  })
});
const taskPolicyRegistry = createTaskPolicyRegistry();
const executionTaskComposition = createExecutionTaskComposition({
  terminalRoutes: terminalRouteRegistrations,
  positionOwner: positionTaskOwner,
  acknowledgeReceipts: acknowledgeToolboxPublicationReceipts,
  reportArchiveFailure
});
const { taskAdapterRegistry, terminalRouteRegistry } = executionTaskComposition;
// Recovery adapter 只能消费这个启动期 frozen exact host。先一次性冻结 binding authority，
// 再允许 initializeApplication 建 DB，之后才注册 IPC；任一 authority 漂移在基础设施前失败。
const taskPolicyBindingHost = Object.freeze({
  list: taskPolicyRegistry.list.bind(taskPolicyRegistry)
});
const { actionTaskBindingRegistry, run: runActionTaskBindingStartup } = initializeActionTaskBindingStartup(taskPolicyBindingHost, Object.freeze({ initializeDatabase: initializeApplication, registerIpc: registerAllIpcHandlers }));
const supportActionChannels = new Set(SUPPORT_ACTION_POLICIES.map((policy) => policy.channel));
const scenarioImportContextStore = createScenarioImportContextStore();
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
      pendingTemplateSource: getTemplateResourceService().source('vcc-pending-calc', 'vcc-financial-op'),
      appVersion: pkg.version,
      buildSha: buildInfo.commit,
      acquireResultExportLeaseFn: (operationKey) => acquireResultExportLease(
        backgroundExecutionRuntimeManager.get().resourceGovernor, operationKey
      ),
      publishOutputFilesFn: (payload) => publishVccFinancialOpOutputs({
        ...payload,
        recoverPublications: recoverArchivePublications,
        userDataDir: app.getPath('userData'),
        archiveCenter: archiveCenterService,
        onHandoffPending: (error) => {
          appendActivityLogEntry({
            level: 'error',
            source: 'main',
            domain: 'vcc-financial-op',
            message: 'VCC 正式输出已提交，但存档接管待重试',
            details: [error && error.message ? error.message : String(error)]
          });
        }
      }),
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
      },
      archiveRepositoryProvider: () => (
        archiveCenterService
        && archiveCenterService.service
        && archiveCenterService.service.repository
      ),
      archiveServiceProvider: () => (
        archiveCenterService && archiveCenterService.service
      )
    });
  }
  return vccFinancialOpService;
}

function vccStorageMigrationJournalPath() {
  return path.join(
    app.getPath('userData'),
    'run-data',
    'vcc-financial-op',
    'storage-migration.json'
  );
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
  const properties = Array.isArray(options && options.properties)
    ? options.properties
    : [];
  const selectsFiles = properties.includes('openFile');
  const selectsDirectories = properties.includes('openDirectory');
  if (selectsFiles === selectsDirectories) {
    throw new TypeError('导入选择框必须且只能声明 openFile 或 openDirectory');
  }
  const kind = selectsFiles ? 'file' : 'directory';
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
      kind,
      filePaths: result.filePaths.slice(),
      properties: properties.slice()
    });
  }
  return result;
}

function createPreviewSourceFreshnessGuard(filePaths, label) {
  const snapshots = (Array.isArray(filePaths) ? filePaths : []).map((filePath) => {
    const resolvedPath = path.resolve(String(filePath || ''));
    const snapshot = sourceSnapshotFromStat(fs.statSync(resolvedPath, { bigint: true }));
    if (!snapshot) throw new Error(`${label}源文件不可读`);
    return { filePath: resolvedPath, snapshot };
  });
  return () => {
    for (const item of snapshots) {
      let stat;
      try {
        stat = fs.statSync(item.filePath, { bigint: true });
      } catch (_error) {
        throw new Error(`${label}源文件已不存在，请重新选择`);
      }
      if (!sourceSnapshotMatchesStat(item.snapshot, stat)) {
        throw new Error(`${label}源文件在确认期间已变化，请重新选择`);
      }
    }
  };
}

const STATEMENT_SOURCE_FRESHNESS_FAILURE = Object.freeze({
  code: 'BANK_STATEMENT_SOURCE_CHANGED_DURING_CONFIRMATION',
  message: '网银明细源文件在确认期间已变化，请重新选择'
});

function statementSourceFreshnessError() {
  const error = new Error(STATEMENT_SOURCE_FRESHNESS_FAILURE.message);
  error.code = STATEMENT_SOURCE_FRESHNESS_FAILURE.code;
  return error;
}

function createStatementWorkbookReadGuard(filePath, fsImpl = fs) {
  const resolvedPath = path.resolve(filePath);
  const expectedSnapshot = statementSourceReadContext.getStore()?.get(resolvedPath) || null;
  return Object.freeze({
    beforeRead() {
      try {
        const stat = fsImpl.lstatSync(resolvedPath, { bigint: true });
        const snapshot = sourceSnapshotFromStat(stat);
        if (stat.isSymbolicLink()
            || !snapshot
            || (expectedSnapshot && !sourceSnapshotMatchesStat(expectedSnapshot, stat))) {
          throw statementSourceFreshnessError();
        }
        return Object.freeze({ ...snapshot });
      } catch (error) {
        if (error && error.code === STATEMENT_SOURCE_FRESHNESS_FAILURE.code) throw error;
        throw statementSourceFreshnessError();
      }
    },
    afterRead(startedSnapshot) {
      try {
        const stat = fsImpl.lstatSync(resolvedPath, { bigint: true });
        if (stat.isSymbolicLink()
            || !stat.isFile()
            || !sourceSnapshotMatchesStat(startedSnapshot, stat)) {
          throw statementSourceFreshnessError();
        }
      } catch (error) {
        if (error && error.code === STATEMENT_SOURCE_FRESHNESS_FAILURE.code) throw error;
        throw statementSourceFreshnessError();
      }
    }
  });
}

function runWithStatementConfirmedSourceSnapshots(channel, taskContext, execute) {
  if (channel !== 'file:import' && channel !== 'file:complete-big-account-selection') {
    return execute();
  }
  const inputs = taskContext && taskContext.fileEvidence && taskContext.fileEvidence.filePlan
    ? taskContext.fileEvidence.filePlan.inputs
    : [];
  const expectedByPath = new Map((Array.isArray(inputs) ? inputs : []).map((input) => [
    path.resolve(input.filePath),
    Object.freeze({ ...input.sourceSnapshot })
  ]));
  return statementSourceReadContext.run(expectedByPath, execute);
}

function captureStatementSourceSelections(filePaths) {
  const selections = normalizeInputFilePaths(filePaths, { dedupe: false }).map((filePath) => {
    const resolvedPath = path.resolve(filePath);
    let stat;
    try {
      stat = fs.lstatSync(resolvedPath, { bigint: true });
    } catch (_error) {
      throw statementSourceFreshnessError();
    }
    const sourceSnapshot = sourceSnapshotFromStat(stat);
    if (stat.isSymbolicLink() || !sourceSnapshot) {
      throw statementSourceFreshnessError();
    }
    return Object.freeze({
      resolvedPath,
      sourceSnapshot: Object.freeze({ ...sourceSnapshot })
    });
  });
  return Object.freeze(selections);
}

function selectStatementSourceSelections(selections, filePaths) {
  const selectionByPath = new Map(
    (Array.isArray(selections) ? selections : []).map((selection) => [
      path.resolve(selection.resolvedPath),
      selection
    ])
  );
  return Object.freeze(normalizeInputFilePaths(filePaths, { dedupe: false }).map((filePath) => {
    const selection = selectionByPath.get(path.resolve(filePath));
    if (!selection) throw new Error('网银明细 picker snapshot 与最终选择不一致');
    return selection;
  }));
}

function buildStatementInputFilePlanItems(selections, sourceOperation) {
  return Object.freeze((Array.isArray(selections) ? selections : []).map((selection) => ({
    filePath: selection.resolvedPath,
    role: 'input',
    sourceOperation,
    sourceSnapshot: selection.sourceSnapshot,
    freshnessFailure: STATEMENT_SOURCE_FRESHNESS_FAILURE
  })));
}

// v3.0.11 需求3（批1 · 🔴 资金红线）：银行对账单处理模块的统一 operation lock。
//   三动作 import(bank-statement:batch-import) / run(bank-statement:run) / export(bank-statement:export)
//   共享同一把互斥锁 —— 它们共享全局会话态 bankStatementSession / processingResult / refundOrderSession /
//   gatewayReconSession，并发执行会撕裂状态（如导出读到运行中途的半截 processingResult）。
//   争用即返回 { status:'failed', message:'正在处理中…' }；handler finally 释放。
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
// v3.2.18 模板管理【更新】：旧版方向的映射须先在【修改】中保存一次再更新表头
const LEGACY_ORIENTED_MAPPINGS_MESSAGE = '该模板的映射关系为旧版格式，请先点【修改】打开映射关系并点【完成】保存一次，再更新模板';
const BALANCE_DISABLED_OPTION = '无';
const BALANCE_CALCULATED_OPTION = '通过发生额计算';
const MERCHANT_ID_SELF_INPUT_OPTION = '自己输入';
const MERCHANT_ID_MULTI_ACCOUNT_MARKER = '__MULTI_BIG_ACCOUNT__';
// v3.2.16：MerchantId 按每行币种取【映射管理】中维护的大账号（存储值见 MERCHANT_ID_CURRENCY_ONLY_MARKER）
const MERCHANT_ID_CURRENCY_ONLY_OPTION = '原始账单仅有币种无账户号';
const CONCAT_FIELDS_MAPPING_FIELD = '需要拼接字段';
// v3.2.16：映射值「字段筛选特征值」——从一个源字段按规则筛出特征值。
// v3.2.18：模板可有多个特征值（templates.feature_filter_json 存数组），映射行的 mappedFields[0] 为所选特征值 id。
const FEATURE_FILTER_MAPPING_FIELD = '字段筛选特征值';
// v3.2.19：映射值「逻辑取值 → 候补字段取值」——mappedFields 为有序候补字段，生成时取第一个非空值（spec §8.4）。
// v3.2.21：候补也可以是模板的特征值，存为 `\u0000__FEATURE_FILTER__:<id>`（buildLogicValueFeatureCandidate /
//   parseLogicValueFeatureFilterRef；以 NUL 开头，旧版本的源列名候补不会被误读为特征值），取该行筛出的特征值，
//   未筛出视为空、取下一个候补（changes/v3.2.21/feat/mapping-logic-feature-layout/spec.md）。
const LOGIC_VALUE_MAPPING_FIELD = '逻辑取值';
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
// v3.2.19：根据字段值过滤账单——命中过滤规则的源行走拆分/合并映射，未命中的走主映射；只在开启拆分/合并时生效。
const BILL_SPLIT_ROW_FILTER_MAPPING_FIELD = '根据字段值过滤账单';
const BILL_SPLIT_ROW_FILTER_ENABLED_OPTION = '是';
// v3.2.19：原始账单预处理「过滤账单」——勾选时生成前按过滤规则只保留命中的源行（原始账单加工表），
//   未命中的行不参与明细/余额生成；与拆分/合并无关。开关存为映射行，规则存 templates.preprocess_row_filter_rules_json。
const PREPROCESS_ROW_FILTER_MAPPING_FIELD = '过滤账单';
const PREPROCESS_ROW_FILTER_ENABLED_OPTION = '是';
// v3.2.19：原始账单预处理「重复账单过滤」——勾选时一次导入的全部文件中，所有字段值相同且账户相同的源行
//   经用户确认后只保留第一行（spec §8.3）。开关存为映射行，没有规则。
const DUPLICATE_ROW_FILTER_MAPPING_FIELD = '重复账单过滤';
const DUPLICATE_ROW_FILTER_ENABLED_OPTION = '是';
// v1.5.2 需求 3（G3-6，决策 ③A）：保持 v4 不升 v5；新增的 `filenameFixedField` 为 v4 schema 下的透明扩展字段。
// - `buildTemplateLibraryPayload` 通过 `listTemplateBundleEntries` 透传该字段（template-repository.js:856）
// - `readTemplateBundleFile` 对未知字段采用显式解构式解析（:1221-1243），v1.5.1 旧应用读 v1.5.2 导出的 bundle 时自然忽略该字段
// - v1.5.1 旧 bundle 若不含该字段，读时 fallback 为空串（:1242）
// v3.2.15：v5 以渠道取代主/子模板（顶层 channels，条目 channelName），兼容读取 v≤4。
// v3.2.16：用到「字段筛选特征值」（主映射或拆分映射）或 MerchantId「原始账单仅有币种无账户号」（条目带 currencyBigAccounts）
//   的模板包写 v6，让旧版按版本号整包拒绝（旧版会静默输出空值，或把新存储值当成映射字段）；都未用到时仍写 v5，旧版照常可导入。
// v3.2.18：用到「字段筛选特征值」时写 v7（条目带 featureFilters 数组，映射行带所选特征值 id），v3.2.16/3.2.17 读到整包拒绝；
//   只用到「原始账单仅有币种无账户号」时仍写 v6。读取 v6 包时把单套 featureFilter 升级为特征值（同启动迁移口径）。
// v3.2.19：用到拆分/合并账单「费用账单」（标了费用账单行或勾选了特殊取值逻辑）或「根据字段值过滤账单」（勾选或有过滤规则）
//   时写 v8，v3.2.18 及更早版本整包拒绝（旧版会忽略费用标记与公式、过滤规则，静默输出不同的发生额或把全部行拆分）；
//   用到原始账单预处理「过滤账单」（勾选或有过滤规则）时同样写 v8（旧版会忽略过滤，把非账单行也输出）；
//   勾选「重复账单过滤」或映射用到「逻辑取值」时同样写 v8（旧版会忽略去重、把逻辑取值当作拼接，静默输出不同的结果）；
//   未用到时按上面的规则写 v5/v6/v7。
// v3.2.21：「逻辑取值」候补含特征值，或用到费用账单「字段映射特殊处理」（勾选或存有设置）时写 v9，v3.2.20 及更早版本
//   整包按版本拒绝（旧版会把特征值 token 当成源字段名，报「映射字段不存在」跳过该模板；或忽略覆盖，费用账单行静默输出
//   原映射的字段值）；两项同在 v3.2.21 首次出现，共用 v9。未用到时按上面的规则写 v5～v8。
const SUPPORTED_BUNDLE_VERSION = 9;
// v3.2.21 功能首次出现的包版本（固定；SUPPORTED_BUNDLE_VERSION 只表示能读取的最高版本）
const LOGIC_VALUE_FEATURE_BUNDLE_VERSION = 9;
const FEE_FIELD_MAPPING_BUNDLE_VERSION = 9;
// v3.2.19：拆分账单「费用账单」、两类过滤、重复账单过滤或「逻辑取值」的包版本
const LOGIC_VALUE_BUNDLE_VERSION = 8;
const FEATURE_FILTER_BUNDLE_VERSION = 7;
const CURRENCY_ONLY_BUNDLE_VERSION = 6;
const BASE_BUNDLE_VERSION = 5;
// v3.2.21：模板日期格式（templates.date_format）只决定文本日期中日、月的先后（解析见 normalizers.js 的 dateParseOrder）：
//   auto 与 DMY 都按日在前、日在前不是有效日期时改按月在前，MDY 反之。映射关系管理「个性化映射设置 → 日期格式」不勾选为 auto。
//   模板包 v4 起已带 dateFormat，各版本对三档的解析一致，故不升模板包版本。
const TEMPLATE_DATE_FORMAT_LABELS = Object.freeze({ auto: '自动', DMY: '日在前（dd/mm/yyyy）', MDY: '月在前（mm/dd/yyyy）' });
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
// v3.2.21：映射关系管理中自上而下为 拆分/合并明细账单、根据字段值过滤账单、复用模块字段的映射关系（映射按字段名读写，顺序只影响展示）
const BILL_SPLIT_GROUP_FIELDS = [
  BILL_SPLIT_MERGE_MAPPING_FIELD,
  BILL_SPLIT_ROW_FILTER_MAPPING_FIELD,
  REUSE_MODULE_MAPPING_FIELD
];
// v3.2.19：映射关系管理「原始账单预处理」分组（位于「个性化映射设置」之前）
const PREPROCESS_FIELDS = [
  PREPROCESS_ROW_FILTER_MAPPING_FIELD,
  DUPLICATE_ROW_FILTER_MAPPING_FIELD
];
// v3.2.18 模板管理【更新】：引用源字段的位置收集与生成前失效引用拦截（与保存校验同一组标记常量）
const templateHeaderUpdateTools = createTemplateHeaderUpdateTools({
  BALANCE_DISABLED_OPTION,
  BALANCE_CALCULATED_OPTION,
  CONCAT_FIELDS_MAPPING_FIELD,
  FEATURE_FILTER_MAPPING_FIELD,
  LOGIC_VALUE_MAPPING_FIELD,
  AMOUNT_SPLIT_BY_FIELD_MAPPING_FIELD,
  AMOUNT_SPLIT_BY_FIELD_ENABLED_OPTION,
  BILL_SPLIT_MERGE_MAPPING_FIELD,
  BILL_SPLIT_MERGE_ENABLED_OPTION,
  REUSE_MODULE_MAPPING_FIELD,
  BILL_SPLIT_ROW_FILTER_MAPPING_FIELD,
  BILL_SPLIT_ROW_FILTER_ENABLED_OPTION,
  PREPROCESS_ROW_FILTER_MAPPING_FIELD,
  PREPROCESS_ROW_FILTER_ENABLED_OPTION,
  DUPLICATE_ROW_FILTER_MAPPING_FIELD,
  SIGNED_AMOUNT_MAPPING_FIELD,
  AMOUNT_BASED_NAME_MAPPING_FIELD,
  AMOUNT_BASED_ACCOUNT_MAPPING_FIELD
});
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
  phases: [],
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

function recordStartupPhase(record) {
  const safeRecord = record && typeof record === 'object' ? { ...record } : null;
  if (!safeRecord || safeRecord.event !== 'startup-phase') return;
  if (safeRecord.state === 'end') startupMetrics.phases.push(safeRecord);
  appendActivityLogEntry({
    level: safeRecord.outcome === 'failed' ? 'error' : 'info',
    source: 'main',
    domain: 'startup',
    message: 'startup-phase',
    details: [JSON.stringify(safeRecord)]
  });
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
    phases: startupMetrics.phases.slice(),
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
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();
  mainWindow = null;
  mainWindowReady = false;
  let logPath = '';

  try {
    logPath = getActivityLogFallbackFilePath();
    logPath = initializeActivityLog();
  } catch (logError) {
    // v2.1.9 SR-log-1：日志系统初始化失败的最后兜底场景
    //   - appendActivityLogEntry 此时尚未 ready，仅能 stderr 兜底
    //   - 不写 console（v2.1.9 SR-log-1 要求 src/main.js 0 console 调用）
    try { process.stderr.write(`[startup logger init failed] ${logError && logError.stack ? logError.stack : String(logError)}\n`); } catch (_) {}
  }

  // v2.1.9 SR-log-1：启动失败兜底，日志系统不一定 ready → stderr 兜底
  try {
    const details = Array.isArray(error && error.detailLines) ? error.detailLines.slice(0, 20) : [];
    const lines = [`[startup failure] ${error && error.stack ? error.stack : String(error)}`, ...details];
    process.stderr.write(`${lines.join('\n')}\n`);
  } catch (_) {}

  reportStartupFailure({
    error,
    logFilePath: logPath || '',
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
      // “不补录”断档不写种子，没有种子证据需要核对。
      if (!plan) return;
      const currentRecords = readBalanceSeedRecords(plan.storageRoot, plan.bankName);
      if (balanceSeedRecordsEvidence(currentRecords) !== plan.recordsEvidence) {
        throw new Error('余额种子在确认期间已变化，请重新补录');
      }
    }
  };
}

// 断档“不补录”与余额不一致“确认继续”只记在内存中的账单会话上：不落盘，重启后失效。
// 两类确认共用同一集合，键按类型区分（余额不一致键以 mismatch| 开头）。
function rememberAcknowledgedBalanceGaps({ session, importContext, gapKeys }) {
  const owner = session || importContext;
  if (!owner) return false;
  if (!(owner.acknowledgedBalanceGapKeys instanceof Set)) {
    owner.acknowledgedBalanceGapKeys = new Set();
  }
  gapKeys.forEach((key) => owner.acknowledgedBalanceGapKeys.add(key));
  return true;
}

function hasAcknowledgedBalanceGap(key) {
  if (lastFileImportContext && lastFileImportContext.acknowledgedBalanceGapKeys instanceof Set
      && lastFileImportContext.acknowledgedBalanceGapKeys.has(key)) {
    return true;
  }
  for (const session of statementImportSessions.values()) {
    if (session && session.acknowledgedBalanceGapKeys instanceof Set
        && session.acknowledgedBalanceGapKeys.has(key)) {
      return true;
    }
  }
  return false;
}

function getAcknowledgedBalanceGapKeys() {
  return { has: hasAcknowledgedBalanceGap };
}

function formatBalanceAmount(value, { signed = false } = {}) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) return '(空)';
  const text = numericValue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 12 });
  return signed && numericValue > 0 ? `+${text}` : text;
}

function formatBalanceSeedMismatchLine(seedMismatch) {
  const statementBalances = (Array.isArray(seedMismatch.statementBalances) ? seedMismatch.statementBalances : [])
    .map((value) => formatBalanceAmount(value))
    .join('、');
  return `已有 ${seedMismatch.seedDate} 余额 ${formatBalanceAmount(seedMismatch.seedBalance)}（${seedMismatch.seedGenerationMethod || '人工录入'}）；`
    + `${seedMismatch.billDate}：上一日余额 ${formatBalanceAmount(seedMismatch.anchorBalance)}`
    + ` + 收入 ${formatBalanceAmount(seedMismatch.creditAmount)} − 支出 ${formatBalanceAmount(seedMismatch.debitAmount)}`
    + ` = 预期 ${formatBalanceAmount(seedMismatch.expectedBalance)}，账单当日余额 ${statementBalances || '(空)'} 都对不上`
    + (seedMismatch.missingFrom
      ? `；中间缺 ${seedMismatch.missingFrom === seedMismatch.missingTo
        ? seedMismatch.missingFrom
        : `${seedMismatch.missingFrom} ~ ${seedMismatch.missingTo}`}`
      : '');
}

function formatBalanceMismatchLine(mismatch) {
  const anchorLabel = mismatch.anchorSource === 'seed'
    ? `余额种子 ${mismatch.anchorDate}`
    : `上一账单日 ${mismatch.anchorDate}`;
  const missingRange = mismatch.missingFrom
    ? `，中间缺 ${mismatch.missingFrom === mismatch.missingTo ? mismatch.missingFrom : `${mismatch.missingFrom} ~ ${mismatch.missingTo}`}`
    : '';
  return `银行账号：${mismatch.merchantId}，币种：${mismatch.currency || '(空)'}，账单日期：${mismatch.billDate}，`
    + `上一日余额：${formatBalanceAmount(mismatch.anchorBalance)}（${anchorLabel}），`
    + `收入：${formatBalanceAmount(mismatch.creditAmount)}，支出：${formatBalanceAmount(mismatch.debitAmount)}，`
    + `预期余额：${formatBalanceAmount(mismatch.expectedBalance)}，账单余额：${formatBalanceAmount(mismatch.statementBalance)}，`
    + `差额：${formatBalanceAmount(mismatch.difference, { signed: true })}${missingRange}`;
}

function formatBalanceSeedReplaceLine(replacement) {
  const balanceLabel = replacement.balanceSource === 'calculated' ? '计算余额' : '账单余额';
  const adjustment = Number(replacement.adjustment) || 0;
  const written = adjustment
    ? `，另加余额附加值 ${formatBalanceAmount(adjustment)} 后写入 ${formatBalanceAmount(replacement.writtenBalance)}`
    : '';
  return `银行账号：${replacement.merchantId}，币种：${replacement.currency || '(空)'}，账单日期：${replacement.billDate}，`
    + `人工补录余额：${formatBalanceAmount(replacement.manualBalance)}，${balanceLabel}：${formatBalanceAmount(replacement.balance)}，`
    + `差额：${formatBalanceAmount(replacement.difference, { signed: true })}${written}`;
}

function formatBalanceGapLine(gap) {
  const missingRange = gap.missingFrom === gap.missingTo
    ? gap.missingFrom
    : `${gap.missingFrom} ~ ${gap.missingTo}`;
  return `银行账号：${gap.merchantId}，币种：${gap.currency || '(空)'}，${gap.anchorDate} 之后下一个账单日是 ${gap.targetBillDate}，缺 ${missingRange}`;
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
        replacePaths: Array.isArray(context.replacePaths) ? context.replacePaths.slice() : [],
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
        // v3.2.21（D3）：导入预检时记下的余额方式不同的渠道组的条目位置（空数组表示没有），完成选择时按位置复核
        balanceModeMixedEntryIndexes: Array.isArray(context.balanceModeMixedEntryIndexes)
          ? context.balanceModeMixedEntryIndexes.slice()
          : null,
        rows: Array.isArray(context.rows)
          ? context.rows.map((row) => ({
              index: Number(row.index || 0),
              fileBlockOrdinal: Number(row.fileBlockOrdinal),
              sourceRowNumber: Number(row.sourceRowNumber || 0),
              fileName: normalizeCell(row.fileName),
              filePath: row.filePath || ''
            }))
          : [],
        rowsWithEmptyBlocks: Array.isArray(context.rowsWithEmptyBlocks)
          ? context.rowsWithEmptyBlocks.map((row) => ({
              index: Number(row.index || 0),
              fileBlockOrdinal: Number(row.fileBlockOrdinal),
              sourceRowNumber: Number(row.sourceRowNumber || 0),
              fileName: normalizeCell(row.fileName),
              filePath: row.filePath || ''
            }))
          : undefined,
        statementSelectionSessionId: normalizeCell(context.statementSelectionSessionId),
        sourceSelections: Array.isArray(context.sourceSelections)
          ? Object.freeze(context.sourceSelections.map((selection) => Object.freeze({
              resolvedPath: path.resolve(selection.resolvedPath),
              sourceSnapshot: Object.freeze({ ...selection.sourceSnapshot })
            })))
          : Object.freeze([]),
        assertSessionCurrent: typeof context.assertSessionCurrent === 'function'
          ? context.assertSessionCurrent
          : null,
        bigAccountOrderEvidence: context.bigAccountOrderEvidence || null,
        // v3.2.19：重复账单过滤——映射这些条目时的模板配置指纹（见 buildDuplicateReviewConfigStamp）
        ...(context.duplicateReviewConfig ? {
          duplicateReviewConfig: Object.freeze({
            templateIds: context.duplicateReviewConfig.templateIds.slice(),
            stamp: context.duplicateReviewConfig.stamp,
            catalogStamp: context.duplicateReviewConfig.catalogStamp || null
          })
        } : {})
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

// 大账号续跑时删除的会话旧记录：重复提示中确认覆盖的旧路径（可能与本次路径不同：跨目录同名、改名同内容），
// 加上本次输入路径（同路径覆盖）。
function resolvePendingReplacePaths(pendingContext) {
  return Array.from(new Set([
    ...(Array.isArray(pendingContext.replacePaths) ? pendingContext.replacePaths : []),
    ...(Array.isArray(pendingContext.inputFilePaths) ? pendingContext.inputFilePaths : [])
  ]));
}

function createPendingBigAccountSelectionContext(prepared, context) {
  const selectionReplacePaths = prepared && prepared.selectionResult
    && Array.isArray(prepared.selectionResult.replacePaths)
    ? prepared.selectionResult.replacePaths
    : [];
  const pendingContext = {
    ...context,
    replacePaths: selectionReplacePaths.slice(),
    statementSelectionSessionId: normalizeCell(prepared && prepared.statementSelectionSessionId),
    sourceSelections: prepared && Array.isArray(prepared.sourceSelections)
      ? prepared.sourceSelections
      : Object.freeze([]),
    assertSessionCurrent: prepared && typeof prepared.assertSessionCurrent === 'function'
      ? prepared.assertSessionCurrent
      : null
  };
  const cachedEvidence = prepared && prepared.bigAccountOrderEvidence;
  const bigAccountOrderEvidence = cachedEvidence
    && cachedEvidence.sessionId === pendingContext.statementSelectionSessionId
    ? cachedEvidence
    : buildBigAccountOrderEvidence(pendingContext);
  if (prepared && prepared.previewOnly === true) {
    prepared.bigAccountOrderEvidence = bigAccountOrderEvidence;
  }
  return {
    ...pendingContext,
    bigAccountOrderEvidence
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
  // 已有种子但首日对不上（v3.2.16 D7）：提示与日志写明是已有余额对不上，不是缺余额。
  const seedMismatch = normalizedPrompt?.seedMismatch || null;
  appendActivityLogEntry({
    level: 'info',
    message: seedMismatch ? '上一账单日余额与账单对不上，等待重新补录' : '等待补录上一账单日余额',
    details: [
      `模板名：${normalizedPrompt?.templateName || 'N/A'}`,
      `银行账号：${normalizedPrompt?.merchantId || 'N/A'}`,
      `币种：${normalizedPrompt?.currency || '(空)'}`,
      `当前账单日期：${normalizedPrompt?.targetBillDate || 'N/A'}`,
      ...(seedMismatch ? [formatBalanceSeedMismatchLine(seedMismatch)] : [])
    ]
  });

  return {
    status: 'manual-balance-required',
    message: seedMismatch
      ? '上一账单日余额与账单对不上，请核对后重新补录'
      : '因首次导入余额，请导入上一个账单日余额用于余额校验',
    detailReady: Boolean(generatedFiles?.detail),
    balanceReady: false,
    errorReportReady: false,
    manualBalancePromptReady: true,
    manualBalancePrompt: normalizedPrompt ? { ...normalizedPrompt } : null
  };
}

// 断档复用补录通道：prompt 指向第一处断档，gaps 列出本次全部待确认断档。
function buildBalanceGapConfirmResult(gaps, generatedFiles) {
  clearLastErrorReport();
  lastPendingBalanceSeedConfirmation = null;
  const promptGaps = gaps.map((gap) => ({
    key: gap.key,
    templateName: gap.templateName,
    bankName: gap.bankName,
    merchantId: gap.merchantId,
    currency: gap.currency,
    anchorDate: gap.anchorDate,
    targetBillDate: gap.targetBillDate,
    missingFrom: gap.missingFrom,
    missingTo: gap.missingTo,
    suggestedSeedDate: gap.suggestedSeedDate
  }));
  const [first] = promptGaps;
  const prompt = {
    reason: 'gap',
    templateName: first.templateName,
    bankName: first.bankName,
    merchantId: first.merchantId,
    currency: first.currency,
    targetBillDate: first.targetBillDate,
    anchorDate: first.anchorDate,
    missingFrom: first.missingFrom,
    missingTo: first.missingTo,
    suggestedSeedDate: first.suggestedSeedDate,
    gapKey: first.key,
    gaps: promptGaps
  };
  lastManualBalancePrompt = prompt;
  appendActivityLogEntry({
    level: 'info',
    message: '账单日期不连续，等待确认是否补录期末余额',
    details: [`模板名：${first.templateName}`, ...promptGaps.map(formatBalanceGapLine)]
  });

  return {
    status: 'manual-balance-required',
    message: `账单日期不连续（${promptGaps.length} 处），请确认是否补录断档前一日的期末余额`,
    detailReady: Boolean(generatedFiles?.detail),
    balanceReady: false,
    errorReportReady: false,
    manualBalancePromptReady: true,
    manualBalancePrompt: { ...prompt, gaps: promptGaps.map((gap) => ({ ...gap })) }
  };
}

// 同一账单日人工补录的期末余额与本次余额不一致（v3.2.16）：替换前复用补录通道确认，prompt 列出全部待替换项。
function buildBalanceSeedReplaceConfirmResult(replacements, generatedFiles) {
  clearLastErrorReport();
  lastPendingBalanceSeedConfirmation = null;
  const promptReplacements = replacements.map((replacement) => ({
    key: replacement.key,
    templateName: replacement.templateName,
    bankName: replacement.bankName,
    merchantId: replacement.merchantId,
    currency: replacement.currency,
    billDate: replacement.billDate,
    balanceSource: replacement.balanceSource,
    manualBalance: replacement.manualBalance,
    balance: replacement.balance,
    difference: replacement.difference,
    adjustment: replacement.adjustment,
    writtenBalance: replacement.writtenBalance
  }));
  const [first] = promptReplacements;
  const prompt = {
    reason: 'seed-replace',
    templateName: first.templateName,
    bankName: first.bankName,
    merchantId: first.merchantId,
    currency: first.currency,
    targetBillDate: first.billDate,
    replacements: promptReplacements
  };
  lastManualBalancePrompt = prompt;
  appendActivityLogEntry({
    level: 'info',
    message: '人工补录的期末余额与本次余额不一致，等待核查或确认替换',
    details: [`模板名：${first.templateName}`, ...promptReplacements.map(formatBalanceSeedReplaceLine)]
  });

  return {
    status: 'manual-balance-required',
    message: `人工补录的期末余额与本次余额不一致（${promptReplacements.length} 处），请核查或确认替换`,
    detailReady: Boolean(generatedFiles?.detail),
    balanceReady: false,
    errorReportReady: false,
    manualBalancePromptReady: true,
    manualBalancePrompt: { ...prompt, replacements: promptReplacements.map((replacement) => ({ ...replacement })) }
  };
}

// 账单里的余额逐日校验不一致（v3.2.16）：复用补录通道，prompt 列出本次全部待确认的不一致。
function buildBalanceMismatchConfirmResult(mismatches, generatedFiles) {
  clearLastErrorReport();
  lastPendingBalanceSeedConfirmation = null;
  const promptMismatches = mismatches.map((mismatch) => ({
    key: mismatch.key,
    templateName: mismatch.templateName,
    bankName: mismatch.bankName,
    merchantId: mismatch.merchantId,
    currency: mismatch.currency,
    billDate: mismatch.billDate,
    anchorDate: mismatch.anchorDate,
    anchorSource: mismatch.anchorSource,
    anchorBalance: mismatch.anchorBalance,
    creditAmount: mismatch.creditAmount,
    debitAmount: mismatch.debitAmount,
    expectedBalance: mismatch.expectedBalance,
    statementBalance: mismatch.statementBalance,
    difference: mismatch.difference,
    missingFrom: mismatch.missingFrom || '',
    missingTo: mismatch.missingTo || ''
  }));
  const [first] = promptMismatches;
  const prompt = {
    reason: 'mismatch',
    templateName: first.templateName,
    bankName: first.bankName,
    merchantId: first.merchantId,
    currency: first.currency,
    targetBillDate: first.billDate,
    mismatches: promptMismatches
  };
  lastManualBalancePrompt = prompt;
  appendActivityLogEntry({
    level: 'info',
    message: '账单余额校验不一致，等待核查或确认按账单余额生成',
    details: [`模板名：${first.templateName}`, ...promptMismatches.map(formatBalanceMismatchLine)]
  });

  return {
    status: 'manual-balance-required',
    message: `账单余额校验不一致（${promptMismatches.length} 处），请核查或确认按账单余额生成`,
    detailReady: Boolean(generatedFiles?.detail),
    balanceReady: false,
    errorReportReady: false,
    manualBalancePromptReady: true,
    manualBalancePrompt: { ...prompt, mismatches: promptMismatches.map((mismatch) => ({ ...mismatch })) }
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

  // v3.2.16：币种未维护大账号的问题跨文件汇总后一次报错（spec D1）
  return mapEachCollectingCurrencyBigAccountIssues(
    normalizeInputFilePaths(inputFilePaths, { dedupe: false }),
    (inputFilePath) => ({
      filePath: inputFilePath,
      ...merchantLookupFlags,
      detailRows: buildMappedRowsForFile({
        config,
        inputFilePath
      })
    })
  );
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

// 模板配置（大账号、固定赋值、仅有币种时的大账号、账户映射的银行账号与清算账号，以及旧模板只在 MerchantId 映射行保存的
//   固定账号）中的账号：日志里的模板名、渠道名等按它们整体脱敏（以不含连续 4 位数字的实际账号命名时，只按数字写法脱敏会漏，
//   release 审查）
function collectTemplateAccountValuesForLog(...configurations) {
  return configurations.flatMap((configuration) => [
    ...['bigAccounts', 'fixedAssignments', 'currencyBigAccounts']
      .flatMap((key) => (configuration && Array.isArray(configuration[key]) ? configuration[key] : []))
      .map((item) => normalizeCell(item && item.merchantId)),
    ...(configuration && Array.isArray(configuration.accountMappings) ? configuration.accountMappings : [])
      .flatMap((item) => [normalizeCell(item && item.bankAccountId), normalizeCell(item && item.clearingAccountId)]),
    // 旧模板（含旧模板包条目）只在 MerchantId 映射行保存固定账号、不建大账号记录时，按兼容口径解出该账号
    ...(configuration && Array.isArray(configuration.mappings)
      ? buildCompatibleBigAccounts({ mappings: configuration.mappings }).map((item) => normalizeCell(item.merchantId))
      : [])
  ]);
}

// 库里为模板维护的账号（大账号含自有账号、固定赋值、仅有币种时的大账号、生效的账户映射）：只用于日志脱敏，读不到时返回空
//   （按数字写法脱敏兜底）
function readTemplateAccountValuesForLog(template) {
  if (!template || !template.id) return [];
  try {
    return collectTemplateAccountValuesForLog(database.getTemplateMappings(template.id), {
      bigAccounts: database.getTemplateBigAccounts(template.id, { includeOwn: true }),
      accountMappings: database.listEffectiveAccountMappings(template)
    });
  } catch (_error) {
    return [];
  }
}

// v3.2.21：写进活动日志的说明文字中的账号、卡号等编号不持久化（AGENTS.md 敏感数据边界）。
//   accountValues：调用方已知的账号（如模板包条目里的大账号），在文中原样出现时整体替换，不按写法猜边界；
//   其余连续 4 位以上的数字（数字之间可夹空格、连字符、点，如按四位一组书写的号码；含全角数字）一律只写位数
function maskAccountLikeTextForLog(text, accountValues = []) {
  let masked = String(text == null ? '' : text);
  Array.from(new Set((Array.isArray(accountValues) ? accountValues : [])
    .map((value) => String(value == null ? '' : value).trim())
    .filter((value) => value !== '')))
    .sort((left, right) => right.length - left.length)
    .forEach((value) => {
      masked = masked.split(value).join(`（${value.length}位账号）`);
    });
  return masked.replace(/[0-9\uFF10-\uFF19](?:[\s._-]*[0-9\uFF10-\uFF19]){3,}/g, (digits) => (
    `（${(digits.match(/[0-9\uFF10-\uFF19]/g) || []).length}位数字）`
  ));
}

// 改选大账号后复用已生成的明细：大账号 / 币种列被所选大账号覆盖（overriddenTargetFields），去掉币种未匹配提示；
//   v3.2.21 B112：长数字提示中只写进这些列的源字段（cells[].targetFields，见 buildMappedRows）也去掉，其余提示不变
//   （手动分配大账号按行复用这一口径，见 applyBigAccountAssignmentsToFileEntries）
function dropIssuesOverriddenBySelectedBigAccount(issues, overriddenTargetFields) {
  return issues.reduce((kept, issue) => {
    if (issue && issue.type === 'currency-unmapped') return kept;
    if (issue && issue.type === 'long-number-unverified' && Array.isArray(issue.cells)) {
      const cells = issue.cells.filter((cell) => !(
        cell && Array.isArray(cell.targetFields) && cell.targetFields.length
        && cell.targetFields.every((field) => overriddenTargetFields.has(field))
      ));
      if (!cells.length) return kept;
      kept.push(cells.length === issue.cells.length ? issue : { ...issue, cells });
      return kept;
    }
    kept.push(issue);
    return kept;
  }, []);
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

  // v3.2.16：从原文件重建时，币种未维护大账号的问题跨文件汇总后一次报错（spec D1）
  return mapEachCollectingCurrencyBigAccountIssues(Array.isArray(fileEntries) ? fileEntries : [], (entry) => {
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
          detailRows.issues = dropIssuesOverriddenBySelectedBigAccount(detailRows.issues, new Set([
            ...(merchantIdIndex !== undefined ? ['MerchantId'] : []),
            ...(currencyIndex !== undefined ? ['Currency'] : [])
          ]));
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
      blockOrdinal: 0,
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

  headerBreaks.forEach((breakRowNumber, blockOrdinal) => {
    const splitIndex = rowMetas.findIndex(
      (meta, i) => i >= blockStart && meta.sourceRowNumber >= breakRowNumber
    );
    const effectiveSplit = splitIndex >= 0 ? splitIndex : dataRows.length;

    const rawEnd = effectiveSplit > blockStart ? effectiveSplit - 1 : blockStart - 1;
    const trimmed = trimBlock(blockStart, rawEnd);
    if (includeEmptyBlocks) {
      blocks.push({
        blockOrdinal,
        startIndex: trimmed.startIndex,
        endIndex: trimmed.endIndex,
        startRowNumber: rowMetas[trimmed.startIndex]?.sourceRowNumber || prevBreakRowNumber || blockStart + 2
      });
    } else if (trimmed.startIndex <= trimmed.endIndex) {
      blocks.push({
        blockOrdinal,
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
      blockOrdinal: headerBreaks.length,
      startIndex: lastTrimmed.startIndex,
      endIndex: lastTrimmed.endIndex,
      startRowNumber: rowMetas[lastTrimmed.startIndex]?.sourceRowNumber || lastBreakRowNumber || blockStart + 2
    });
  } else if (lastTrimmed.startIndex <= lastTrimmed.endIndex) {
    blocks.push({
      blockOrdinal: headerBreaks.length,
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
      blockOrdinal: 0,
      startIndex: 0,
      endIndex: Math.max(0, dataRows.length - 1),
      startRowNumber: rowMetas[0]?.sourceRowNumber || 2
    }];
  }

  return [];
}

// 返回原始行里所有表头行的行号（1 起）。表头口径与 readRowsWithMetadata 相同（buildExpectedHeaderCandidates）：
// 先按保留中间空项的完整结构找，一行都找不到再退回去空口径，避免两侧定位到不同的表头而丢失账号扫描窗口。
function findHeaderRowNumbersInRawRows(rawRows, expectedSourceHeaders) {
  for (const normalizedExpected of buildExpectedHeaderCandidates(expectedSourceHeaders)) {
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
    if (results.length) return results;
  }
  return [];
}

// v3.2.21 B112：导入时识别大账号（identifyAccountsFromFile）按读取库的值定位表头（与模板表头一致），再把表头以外各行的
//   长整数换成文件原文（readRows 的不可枚举属性 sourceText：Map<行下标, Map<列下标, 原文>>），账号按原文匹配。
//   生成时的识别依据（buildBigAccountRecognitionBasis）在窗口内逐行取原文，口径相同。
//   headerRowNumbers 为 findHeaderRowNumbersInRawRows 的结果（下标 + 1）。返回新数组，保留 firstRowNumber。
function applyBigAccountRecognitionSourceText(rawRows, headerRowNumbers) {
  const sourceText = rawRows && rawRows.sourceText instanceof Map ? rawRows.sourceText : null;
  if (!sourceText || !sourceText.size) return rawRows;
  const headerIndexes = new Set((headerRowNumbers || []).map((rowNumber) => rowNumber - 1));
  const rows = rawRows.map((row, index) => {
    const rowText = headerIndexes.has(index) ? null : sourceText.get(index);
    if (!rowText || !Array.isArray(row)) return row;
    const next = row.slice();
    rowText.forEach((text, columnIndex) => {
      if (columnIndex < next.length) next[columnIndex] = text;
    });
    return next;
  });
  if (rawRows.firstRowNumber !== undefined) {
    Object.defineProperty(rows, 'firstRowNumber', { value: rawRows.firstRowNumber, enumerable: false });
  }
  return rows;
}

function buildBigAccountRecognitionBasis({
  rawRows,
  expectedSourceHeaders,
  accountMappingByBankId = {}
}) {
  const rows = Array.isArray(rawRows) ? rawRows : [];
  const headerRowNumbers = findHeaderRowNumbersInRawRows(rows, expectedSourceHeaders);
  // v3.2.21 B112：表头按读取库的值定位（同上），窗口内各行的长整数换成文件原文（rawRows.sourceText，见 readers.js）
  const sourceText = rows.sourceText instanceof Map ? rows.sourceText : null;
  // v3.2.19：工作表有效范围不从第 1 行开始时，rows 下标与物理行号差一个偏移；记录的行号与
  //   readRowsWithMetadata 的源行号同为物理行号（finalizeBigAccountRecognitionBasis 按行号比较两者）。
  const rowNumberOffset = Number(rows.firstRowNumber) > 1 ? Number(rows.firstRowNumber) - 1 : 0;
  const bridgeMappings = Object.entries(accountMappingByBankId || {})
    .map(([bankId, mapping]) => ({
      bankId: normalizeCell(bankId),
      clearingAccountId: normalizeCell(mapping && mapping.clearingAccountId)
    }))
    .filter((mapping) => mapping.bankId && mapping.clearingAccountId);
  const bridgeCandidatesByBlock = [];
  const headerWindows = headerRowNumbers.map((headerRowNumber, index) => {
    const previousBoundary = index === 0 ? 0 : headerRowNumbers[index - 1];
    const startIndex = Math.max(previousBoundary, headerRowNumber - 10);
    const endIndex = headerRowNumber - 2;
    const candidateRowsWithSource = rows
      .slice(startIndex, Math.max(startIndex, endIndex + 1))
      .map((row, candidateIndex) => {
        const rowText = sourceText && sourceText.get(startIndex + candidateIndex);
        return {
          sourceRow: startIndex + candidateIndex + 1 + rowNumberOffset,
          cells: (Array.isArray(row) ? row : [])
            .map((cell, columnIndex) => normalizeCell(rowText && rowText.has(columnIndex) ? rowText.get(columnIndex) : cell))
            .filter((cell) => cell !== '')
        };
      });
    // v3.2.21 B112：精确命中的候选排在模糊命中之前（与 findBigAccountMatchInRows 同一口径）。长账号按原文读取后，
    //   完整账号与其较短后缀可能同时命中，不能按账户映射的枚举顺序取。各自仍按离表头由近到远排列
    const exactBridgeCandidates = [];
    const fuzzyBridgeCandidates = [];
    const seenBridgeCandidates = new Set();
    for (let rowIndex = candidateRowsWithSource.length - 1; rowIndex >= 0; rowIndex -= 1) {
      const candidateRow = candidateRowsWithSource[rowIndex];
      for (const cellText of candidateRow.cells) {
        for (const mapping of bridgeMappings) {
          const matchType = matchMerchantIds(cellText, mapping.bankId);
          if (matchType === 'none') continue;
          const candidateKey = `${candidateRow.sourceRow}\u0000${mapping.clearingAccountId}\u0000${matchType}`;
          if (seenBridgeCandidates.has(candidateKey)) continue;
          seenBridgeCandidates.add(candidateKey);
          (matchType === 'exact' ? exactBridgeCandidates : fuzzyBridgeCandidates).push(Object.freeze({
            sourceRow: candidateRow.sourceRow,
            clearingAccountId: mapping.clearingAccountId
          }));
        }
      }
    }
    bridgeCandidatesByBlock.push(Object.freeze(exactBridgeCandidates.concat(fuzzyBridgeCandidates)));
    return Object.freeze({
      headerRowNumber: headerRowNumber + rowNumberOffset,
      candidateRows: Object.freeze(candidateRowsWithSource.map(
        (candidateRow) => Object.freeze(candidateRow.cells)
      ))
    });
  });
  return Object.freeze({
    version: 1,
    headerWindows: Object.freeze(headerWindows),
    bridgeCandidatesByBlock: Object.freeze(bridgeCandidatesByBlock)
  });
}

function finalizeBigAccountRecognitionBasis(basis, mappedRows) {
  const headerWindows = basis && Array.isArray(basis.headerWindows)
    ? basis.headerWindows
    : [];
  const bridgeCandidatesByBlock = basis && Array.isArray(basis.bridgeCandidatesByBlock)
    ? basis.bridgeCandidatesByBlock
    : [];
  const rowMetas = Array.isArray(mappedRows && mappedRows.rowMetas)
    ? mappedRows.rowMetas
    : [];
  const preprocessStats = mappedRows && mappedRows.preprocessRowFilterStats;
  const droppedTransactionRowNumbers = preprocessStats && Array.isArray(preprocessStats.droppedTransactionRowNumbers)
    ? preprocessStats.droppedTransactionRowNumbers
    : [];
  const blocks = identifyAccountBlocks(mappedRows || [], { includeEmptyBlocks: true });
  const blockByOrdinal = new Map(
    blocks.map((block) => [Number(block.blockOrdinal), block])
  );

  const bridgeClearingIdsByBlock = headerWindows.map((window, blockOrdinal) => {
    const currentHeaderRow = Number(window && window.headerRowNumber);
    if (!Number.isInteger(currentHeaderRow) || currentHeaderRow <= 0) return '';

    let lowerExclusive = 0;
    if (blockOrdinal > 0) {
      const previousHeaderRow = Number(headerWindows[blockOrdinal - 1]?.headerRowNumber);
      const previousBlock = blockByOrdinal.get(blockOrdinal - 1);
      if (!Number.isInteger(previousHeaderRow) || previousHeaderRow <= 0 || !previousBlock) {
        return '';
      }
      if (previousBlock.startIndex <= previousBlock.endIndex) {
        const lastTransactionSourceRow = Number(
          rowMetas[previousBlock.endIndex] && rowMetas[previousBlock.endIndex].sourceRowNumber
        );
        if (!Number.isInteger(lastTransactionSourceRow) || lastTransactionSourceRow <= previousHeaderRow) {
          return '';
        }
        lowerExclusive = lastTransactionSourceRow;
      } else {
        lowerExclusive = previousHeaderRow;
      }
    }

    // v3.2.19：原始账单预处理过滤掉的交易行仍属于上一段：界线不早于其中最后一行，避免把其中的账号当成本段账号。
    if (blockOrdinal > 0) {
      droppedTransactionRowNumbers.forEach((rowNumber) => {
        if (rowNumber > lowerExclusive && rowNumber < currentHeaderRow) lowerExclusive = rowNumber;
      });
    }

    const candidates = Array.isArray(bridgeCandidatesByBlock[blockOrdinal])
      ? bridgeCandidatesByBlock[blockOrdinal]
      : [];
    const ownedCandidate = candidates.find((candidate) => {
      const sourceRow = Number(candidate && candidate.sourceRow);
      return Number.isInteger(sourceRow)
        && sourceRow > lowerExclusive
        && sourceRow < currentHeaderRow;
    });
    return normalizeCell(ownedCandidate && ownedCandidate.clearingAccountId);
  });

  return Object.freeze({
    version: 1,
    headerWindows,
    bridgeClearingIdsByBlock: Object.freeze(bridgeClearingIdsByBlock)
  });
}

function identifyAccountsFromRecognitionBasis({
  basis,
  allMerchantIds,
  allowSubstringMatch = true
}) {
  const headerWindows = basis && Array.isArray(basis.headerWindows)
    ? basis.headerWindows
    : [];
  const matches = headerWindows.map((window) => findBigAccountMatchInRows(
      window.candidateRows,
      0,
      window.candidateRows.length - 1,
      allMerchantIds,
      allowSubstringMatch
    ));
  return {
    accounts: matches.filter(Boolean),
    isSingleAccount: headerWindows.length <= 1,
    matches
  };
}

const BIG_ACCOUNT_RECOGNITION_SCAN_MAX_ROWS = 64;

// v3.2.21 B112：与映射读取（buildMappedRows）同样取长数字原文（exactSourceText），大账号识别与映射读到同一个值；
//   原文在定位表头后用于账户信息行（applyBigAccountRecognitionSourceText）
function readRowsForBigAccountRecognition(filePath) {
  try {
    return readRows(filePath, {
      blankrows: true,
      maxRows: BIG_ACCOUNT_RECOGNITION_SCAN_MAX_ROWS,
      readGuard: createStatementWorkbookReadGuard(filePath),
      exactSourceText: true
    });
  } catch (headReadError) {
    if (headReadError && headReadError.code === STATEMENT_SOURCE_FRESHNESS_FAILURE.code) {
      throw headReadError;
    }
    return readRows(filePath, {
      blankrows: true,
      readGuard: createStatementWorkbookReadGuard(filePath),
      exactSourceText: true
    });
  }
}

function identifyAccountsFromFile({
  filePath,
  expectedSourceHeaders,
  allMerchantIds,
  allowSubstringMatch = true,
  recognitionBasis = null
}) {
  if (recognitionBasis) {
    return identifyAccountsFromRecognitionBasis({
      basis: recognitionBasis,
      allMerchantIds,
      allowSubstringMatch
    });
  }
  let rawRows = readRowsForBigAccountRecognition(filePath);
  let headerRowNumbers = findHeaderRowNumbersInRawRows(rawRows, expectedSourceHeaders);

  if (!headerRowNumbers.length && rawRows.length >= BIG_ACCOUNT_RECOGNITION_SCAN_MAX_ROWS) {
    rawRows = readRows(filePath, {
      blankrows: true,
      readGuard: createStatementWorkbookReadGuard(filePath),
      exactSourceText: true
    });
    headerRowNumbers = findHeaderRowNumbersInRawRows(rawRows, expectedSourceHeaders);
  }
  rawRows = applyBigAccountRecognitionSourceText(rawRows, headerRowNumbers);

  const isSingleAccount = headerRowNumbers.length <= 1;
  const identified = [];

  headerRowNumbers.forEach((headerRowNum, idx) => {
    // 只搜索 header 前面有限行（避免搜到上一个账户的交易数据行里的账户号）
    // BOC-CN 格式：查询账号在 header 上方约 7 行，留 10 行余量
    const prevBoundary = idx === 0 ? 0 : headerRowNumbers[idx - 1];
    const narrowStart = Math.max(prevBoundary, headerRowNum - 10);
    const candidateEndIdx = headerRowNum - 2;
    const match = findBigAccountMatchInRows(
      rawRows,
      narrowStart,
      candidateEndIdx,
      allMerchantIds,
      allowSubstringMatch
    );
    if (match) {
      identified.push(match);
    }
  });

  if (headerRowNumbers.length === 0) {
    const match = findBigAccountMatchInRows(
      rawRows,
      0,
      rawRows.length - 1,
      allMerchantIds,
      allowSubstringMatch
    );
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

// v3.2.16：MerchantId「原始账单仅有币种无账户号」— 逐行按币种回填，不参与大账号识别与选择
function isCurrencyOnlyMerchantMapping(mappings = []) {
  return (Array.isArray(mappings) ? mappings : []).some((mapping) => {
    return normalizeCell(mapping && mapping.templateField) === 'MerchantId'
      && normalizeCell(mapping && mapping.mappedField) === MERCHANT_ID_CURRENCY_ONLY_MARKER;
  });
}

// v3.2.16（spec §4.4）：按文件名映射导入时，找出 MerchantId 为本模式的文件（按各文件命中的模板判断）。
function classifyCurrencyOnlyEntries(fileEntries = [], templateConfigById = new Map()) {
  const entries = Array.isArray(fileEntries) ? fileEntries : [];
  const currencyOnlyFileNames = entries
    .filter((entry) => {
      const entryConfig = templateConfigById.get(entry.matchedTemplateId);
      return isCurrencyOnlyMerchantMapping(entryConfig && entryConfig.exportMappings);
    })
    .map((entry) => path.basename(entry.filePath || ''));
  return {
    currencyOnlyFileNames,
    allCurrencyOnly: currencyOnlyFileNames.length > 0 && currencyOnlyFileNames.length === entries.length
  };
}

// v3.2.16（spec §4.4）：本模式的文件不能与需要选择大账号的文件同批导入——选择窗口按块列出全部文件，
// 选定后会覆盖每个块的 MerchantId / Currency。此时整批阻断，提示分开导入。
function createCurrencyOnlyMixedSelectionErrorResult(fileNames, templateName) {
  return createDetailedErrorResult({
    step: '导入网银明细文件',
    message: `以下文件的模板 MerchantId 为「${MERCHANT_ID_CURRENCY_ONLY_OPTION}」，不能与需要选择大账号的文件同批导入，请分开导入。已取消本次导入。`,
    errorCode: 'CURRENCY_BIG_ACCOUNT_MIXED_SELECTION',
    detailLines: fileNames.map((fileName) => `文件「${fileName}」`),
    context: { fileNames: fileNames.slice() },
    templateName
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
          allowSubstringMatch: false,
          recognitionBasis: entry.detailRows && entry.detailRows.bigAccountRecognitionBasis
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
        fileBlockOrdinal: block.blockOrdinal,
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

// options.onlyEntries（Set）：只返回其中的条目（按原顺序）；其余条目只计入账号块序号，不复制明细行。
// options.blockCounts（Map：文件路径 → 账号块数，见 countSelectionRowsByFile）：其余条目按它计数，不再识别账号块
function applyBigAccountAssignmentsToFileEntries(fileEntries = [], assignments = [], options = {}) {
  const { includeEmptyBlocks = false, onlyEntries = null, blockCounts = null } = options;
  const normalizedAssignments = assignments.map((item, index) => ({
    merchantId: normalizeCell(item.merchantId),
    currency: normalizeCell(item.currency),
    rowIndex: Number.isInteger(item.rowIndex) ? item.rowIndex : index
  }));
  const assignmentByRowIndex = new Map(normalizedAssignments.map((item) => [item.rowIndex, item]));
  let globalBlockIndex = 0;

  const assignedEntries = fileEntries.map((entry) => {
    if (onlyEntries && !onlyEntries.has(entry)) {
      globalBlockIndex += blockCounts
        ? (blockCounts.get(entry.filePath) || 0)
        : identifyAccountBlocks(entry.detailRows, { includeEmptyBlocks }).length;
      return null;
    }
    const blocks = identifyAccountBlocks(entry.detailRows, { includeEmptyBlocks });
    const nextRows = cloneRowsWithMetadata(entry.detailRows);
    const fieldIndexMap = buildFieldIndexMap(nextRows[0] || []);
    const merchantIdIndex = fieldIndexMap.get('MerchantId');
    const currencyIndex = fieldIndexMap.get('Currency');
    const dataRows = nextRows.slice(1);

    const keepIndices = new Set();
    // v3.2.21 B112：各源行（rowMetas 的 sourceRowNumber）导出的明细行是否都被分配的大账号覆盖了 MerchantId / Currency
    const sourceRowNumberOf = (i) => (Array.isArray(nextRows.rowMetas) && nextRows.rowMetas[i]
      ? nextRows.rowMetas[i].sourceRowNumber
      : undefined);
    const assignedSourceRows = new Set();
    const unassignedSourceRows = new Set();

    blocks.forEach((block) => {
      const assignment = assignmentByRowIndex.get(globalBlockIndex);

      for (let i = block.startIndex; i <= block.endIndex && i < dataRows.length; i++) {
        keepIndices.add(i);
        const sourceRowNumber = sourceRowNumberOf(i);
        if (sourceRowNumber !== undefined) (assignment ? assignedSourceRows : unassignedSourceRows).add(sourceRowNumber);
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
    if (Array.isArray(nextRows.issues)) {
      // 与自动选定大账号复用明细同一口径（dropIssuesOverriddenBySelectedBigAccount）：长数字提示中只写进被分配的大账号
      //   覆盖的列的源字段不再提示；只处理导出行全部被覆盖的源行，其余提示不变
      const overriddenTargetFields = new Set([
        ...(merchantIdIndex !== undefined ? ['MerchantId'] : []),
        ...(currencyIndex !== undefined ? ['Currency'] : [])
      ]);
      filteredRows.issues = nextRows.issues.reduce((kept, issue) => {
        if (issue && issue.type === 'long-number-unverified'
          && assignedSourceRows.has(issue.rowNumber) && !unassignedSourceRows.has(issue.rowNumber)) {
          kept.push(...dropIssuesOverriddenBySelectedBigAccount([issue], overriddenTargetFields));
          return kept;
        }
        kept.push(issue);
        return kept;
      }, []);
    }
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
  return onlyEntries ? assignedEntries.filter(Boolean) : assignedEntries;
}

// v3.2.21：选择窗口的账号块行（buildBigAccountSelectionRows 按条目顺序、与 identifyAccountBlocks 同口径生成）按文件计数。
//   行的文件都能对上条目时返回 Map（没有行的文件即 0 块），否则 null（调用方退回逐个识别账号块）。
function countSelectionRowsByFile(rows, entries) {
  if (!Array.isArray(rows)) return null;
  const entryPaths = new Set((Array.isArray(entries) ? entries : []).map((entry) => entry && entry.filePath));
  const counts = new Map();
  for (const row of rows) {
    if (!row || !entryPaths.has(row.filePath)) return null;
    counts.set(row.filePath, (counts.get(row.filePath) || 0) + 1);
  }
  return counts;
}

function createErrorReport(payload) {
  const report = writeErrorReport(ensureStorageRoot(), payload);
  lastErrorReport = report;
  return report;
}

// persistedDetailLines：写入错误报告与活动日志的明细，默认同 detailLines。展示明细含账号等不宜落盘的内容时另给
//   （v3.2.21：渠道余额方式冲突的错误对象带 persistedDetailLines，只记渠道、账户数与子模板）。
// logMaskValues：落盘时须整体脱敏的已知账号（如渠道余额冲突的实际 MerchantId，含不是纯数字的账号）；不给时取 originalError 上的。
function createErrorResult({
  step,
  message,
  errorCode = 'BUSINESS_ERROR',
  errorType = '业务校验错误',
  detailLines = [],
  persistedDetailLines = null,
  logMaskValues = null,
  context = {},
  templateName = '',
  originalError = null
}) {
  const usesPersistedDetailLines = Array.isArray(persistedDetailLines)
    || Boolean(originalError && Array.isArray(originalError.persistedDetailLines));
  const knownAccountValues = Array.isArray(logMaskValues)
    ? logMaskValues
    : (originalError && Array.isArray(originalError.logMaskValues) ? originalError.logMaskValues : []);
  // v3.2.21：带落盘明细的错误（展示内容含账号）落盘时，模板名、上下文、摘要与原始异常中的已知账号与其他编号同样只写位数：
  //   子模板名、渠道名由用户填写，可能以账号命名；报错文件名取自模板名（release 审查）。界面照常显示原文
  const maskRecorded = (value) => (
    usesPersistedDetailLines && typeof value === 'string' ? maskAccountLikeTextForLog(value, knownAccountValues) : value
  );
  const operationContext = archiveOperationContext.getStore();
  if (operationContext && operationContext.phase === 'prepare') {
    // 预检阶段不写报告；界面状态框转写活动日志时同样用脱敏的摘要
    return createPreflightErrorResult({
      message,
      errorCode,
      detailLines,
      ...(usesPersistedDetailLines ? { logMessage: maskRecorded(String(message || '业务校验失败')) } : {})
    });
  }
  const recordedDetailLines = Array.isArray(persistedDetailLines)
    ? persistedDetailLines
    : (originalError && Array.isArray(originalError.persistedDetailLines) ? originalError.persistedDetailLines : detailLines);
  const recordedContext = usesPersistedDetailLines && context && typeof context === 'object'
    ? Object.fromEntries(Object.entries(context).map(([key, value]) => [key, maskRecorded(value)]))
    : context;
  const recordedTemplateName = maskRecorded(templateName);
  const recordedMessage = maskRecorded(message);
  const recordedOriginalError = usesPersistedDetailLines && originalError
    ? (() => {
        const originalMessage = String(originalError.message || '');
        const stack = String(originalError.stack || originalMessage || originalError);
        return { stack: originalMessage ? stack.split(originalMessage).join(maskRecorded(originalMessage)) : maskRecorded(stack) };
      })()
    : originalError;
  const report = createErrorReport({
    step,
    message: recordedMessage,
    errorCode,
    errorType,
    detailLines: recordedDetailLines,
    context: recordedContext,
    templateName: recordedTemplateName,
    originalError: recordedOriginalError
  });
  lastErrorReport = report;
  appendActivityLogEntry({
    level: 'error',
    message: `${step}失败`,
    details: [
      `模板名：${recordedTemplateName || recordedContext.templateName || recordedContext.moduleName || 'N/A'}`,
      `错误摘要：${recordedMessage}`,
      `错误代码：${errorCode}`,
      ...recordedDetailLines
    ]
  });

  return {
    status: 'error',
    message,
    // 界面状态框会把错误摘要转写到活动日志（app:report-log）：带落盘明细的错误另给脱敏后的摘要供其使用（release 审查）
    ...(usesPersistedDetailLines ? { logMessage: recordedMessage } : {}),
    errorReportReady: true,
    errorReportFileName: report.fileName
  };
}

// logMessage（可选）：界面状态框转写活动日志时用的摘要（消息含用户填写的名称、可能以账号命名时给脱敏后的文字）
function createPreflightErrorResult({
  message,
  errorCode = 'BUSINESS_ERROR',
  detailLines = [],
  logMessage
}) {
  return {
    status: 'error',
    message: String(message || '业务校验失败'),
    ...(typeof logMessage === 'string' ? { logMessage } : {}),
    errorCode: String(errorCode || 'BUSINESS_ERROR'),
    detailLines: Array.isArray(detailLines) ? detailLines.slice() : [],
    errorReportReady: false
  };
}

// v3.2.19：续跑请求（重复账单【确认】、完成大账号选择）在预检阶段被拒绝（proceed: false）时没有开始生成：
//   给拒绝结果标记 preservesSession，界面据此只提示原因、保留上一批的导出与补录入口，不靠错误码清单推断。
//   keepErrorCodes：仍按原方式处理的错误（如大账号选择无效时保留选择窗口重新选择）。
function markContinuationPrepareRejection(outcome, { keepErrorCodes = [] } = {}) {
  if (!outcome || outcome.proceed !== false || !outcome.result || outcome.result.status !== 'error') return outcome;
  if (keepErrorCodes.includes(String(outcome.result.errorCode || ''))) return outcome;
  return { ...outcome, result: { ...outcome.result, preservesSession: true } };
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
      // v1.5.1: 导出账户映射；v3.2.15：渠道子模板的账户映射在渠道层，条目不带。
      if (!entry.channelName) {
        entry.accountMappings = database.listAccountMappings({ templateId: template.id }).map(toBundleAccountMapping);
      }
    }
    return entry;
  });

  // v3.2.15（§5.3）：渠道列表（保留空渠道）、渠道账户映射与未处理的冲突。
  const channels = database.listStatementChannels().map((channel) => {
    const conflictGroup = database.listStatementChannelAccountMappingConflicts(channel.id)[0];
    return {
      name: channel.name,
      accountMappings: database.listAccountMappings({ channelId: channel.id }).map(toBundleAccountMapping),
      accountMappingConflicts: conflictGroup ? conflictGroup.conflicts : []
    };
  });

  return {
    bundleVersion: resolveTemplateBundleVersion(templates),
    exportedAt: new Date().toISOString(),
    channels,
    templates
  };
}

// v3.2.21：逻辑取值候补含特征值，或用到费用账单「字段映射特殊处理」时写 v9；
// v3.2.19：否则用到拆分账单「费用账单」、两类过滤、重复账单过滤或逻辑取值时写 v8；否则任一模板的主映射或拆分映射用到「字段筛选特征值」时写 v7；
//   只用到「原始账单仅有币种无账户号」时写 v6；都未用到时写 v5（见 SUPPORTED_BUNDLE_VERSION 注释）。
function resolveTemplateBundleVersion(templates) {
  const entries = Array.isArray(templates) ? templates : [];
  const usesFeeFieldMapping = entries.some((entry) => {
    const meta = entry && entry.billSplitMeta;
    return Boolean(meta && (meta.feeFieldMappingEnabled === true || normalizeFeeFieldMappings(meta.feeFieldMappings).length > 0));
  });
  if (usesFeeFieldMapping) {
    return FEE_FIELD_MAPPING_BUNDLE_VERSION;
  }
  const usesFeatureFilter = entries.some((entry) => (
    [].concat(entry && entry.mappings || [], entry && entry.billSplitMappings || [])
      .some((mapping) => normalizeCell(mapping && mapping.mappedField) === FEATURE_FILTER_MAPPING_FIELD)
  ));
  // v3.2.16：MerchantId「原始账单仅有币种无账户号」——旧版会把存储值当成映射字段，或丢掉 currencyBigAccounts
  const usesCurrencyOnlyMerchant = entries.some((entry) => isCurrencyOnlyMerchantMapping(entry && entry.mappings));
  const usesFeeBill = entries.some((entry) => (
    (Array.isArray(entry && entry.billSplitRows) ? entry.billSplitRows : []).some((row) => row && row.isFeeBill === true)
      || Boolean(entry && entry.billSplitMeta && entry.billSplitMeta.feeAmountFormulaEnabled)
  ));
  // v3.2.19：根据字段值过滤账单（开关是映射行，规则在 billSplitMeta）
  const usesBillSplitRowFilter = entries.some((entry) => (
    (Array.isArray(entry && entry.mappings) ? entry.mappings : []).some((mapping) => (
      normalizeCell(mapping && mapping.templateField) === BILL_SPLIT_ROW_FILTER_MAPPING_FIELD
        && normalizeCell(mapping && mapping.mappedField) === BILL_SPLIT_ROW_FILTER_ENABLED_OPTION
    ))
      || normalizeBillSplitRowFilterRules(entry && entry.billSplitMeta && entry.billSplitMeta.rowFilterRules).length > 0
  ));
  // v3.2.19：原始账单预处理「过滤账单」（开关是映射行，规则在条目 preprocessRowFilterRules）
  const usesPreprocessRowFilter = entries.some((entry) => (
    isPreprocessRowFilterEnabled(entry && entry.mappings)
      || normalizeRowFilterRules(entry && entry.preprocessRowFilterRules).length > 0
  ));
  // v3.2.19：原始账单预处理「重复账单过滤」与映射值「逻辑取值」（旧版会忽略去重、把逻辑取值当作拼接）
  const usesDuplicateRowFilter = entries.some((entry) => isDuplicateRowFilterEnabled(entry && entry.mappings));
  const usesLogicValue = entries.some((entry) => (
    usesLogicValueMapping(entry && entry.mappings) || usesLogicValueMapping(entry && entry.billSplitMappings)
  ));
  // v3.2.21：逻辑取值候补含特征值（旧版会把特征值 token 当成源字段名）
  const usesLogicValueFeatureCandidate = entries.some((entry) => (
    [].concat(entry && entry.mappings || [], entry && entry.billSplitMappings || []).some((mapping) => (
      normalizeCell(mapping && mapping.mappedField) === LOGIC_VALUE_MAPPING_FIELD
        && (Array.isArray(mapping.mappedFields) ? mapping.mappedFields : [])
          .some((field) => parseLogicValueFeatureFilterRef(normalizeCell(field)) !== null)
    ))
  ));
  if (usesLogicValueFeatureCandidate) {
    return LOGIC_VALUE_FEATURE_BUNDLE_VERSION;
  }
  if (usesFeeBill || usesBillSplitRowFilter || usesPreprocessRowFilter || usesDuplicateRowFilter || usesLogicValue) {
    return LOGIC_VALUE_BUNDLE_VERSION;
  }
  if (usesFeatureFilter) {
    return FEATURE_FILTER_BUNDLE_VERSION;
  }
  return usesCurrencyOnlyMerchant ? CURRENCY_ONLY_BUNDLE_VERSION : BASE_BUNDLE_VERSION;
}

function toBundleAccountMapping(m) {
  return {
    bankAccountId: m.bankAccountId,
    clearingAccountId: m.clearingAccountId,
    noCurrency: Boolean(m.noCurrency),
    currency: m.currency || ''
  };
}

function normalizeBundleAccountMappings(list) {
  return (Array.isArray(list) ? list : []).map((m) => ({
    bankAccountId: normalizeCell(m && m.bankAccountId),
    clearingAccountId: normalizeCell(m && m.clearingAccountId),
    noCurrency: Boolean(m && m.noCurrency),
    currency: normalizeCell(m && m.currency)
  })).filter((m) => m.bankAccountId);
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

// 模板包里的表头与 extractHeaders 同口径：保留空项位置（合并单元格占位的中间空列参与表头定位），
// 只去掉末尾空项；全空视为没有表头。
// v3.2.19：拆分配置的正负号字段、费用账单公式与过滤规则（读模板包与映射配置共用；指定账单序号不随包导出）。
// v3.2.21（v9）：费用账单「字段映射特殊处理」的勾选与设置。
function normalizeBundleBillSplitMeta(meta) {
  const source = meta && typeof meta === 'object' ? meta : {};
  return {
    signedAmountSourceField: normalizeCell(source.signedAmountSourceField),
    feeAmountFormulaEnabled: source.feeAmountFormulaEnabled === true,
    feeAmountFormula: normalizeFeeAmountFormula(source.feeAmountFormula),
    rowFilterRules: normalizeBillSplitRowFilterRules(source.rowFilterRules),
    feeFieldMappingEnabled: source.feeFieldMappingEnabled === true,
    feeFieldMappings: normalizeFeeFieldMappings(source.feeFieldMappings)
  };
}

// v3.2.21：合法的模板日期格式（auto / DMY / MDY）原样返回，否则返回空串，由调用方决定报错或按 auto。
//   只接受字符串：数组等其他类型字符串化后可能恰好等于合法值（如 ['MDY']），一律视为无效。
function normalizeTemplateDateFormat(value) {
  const dateFormat = typeof value === 'string' ? value.trim() : '';
  return Object.prototype.hasOwnProperty.call(TEMPLATE_DATE_FORMAT_LABELS, dateFormat) ? dateFormat : '';
}

// v3.2.21：活动日志中的日期格式显示名；库内三档以外的旧值（旧版导入模板包时可能原样写入）原样标出，解析时按自动
// accountValues：已知账号，旧值中原样出现时整体只写位数
function formatTemplateDateFormatLabel(value, accountValues = []) {
  return normalizeTemplateDateFormat(value)
    ? TEMPLATE_DATE_FORMAT_LABELS[value]
    // 旧模板包可带来任意文字：编号只写位数（release 审查）
    : `无效值「${maskAccountLikeTextForLog(value, accountValues)}」（按自动解析）`;
}

function normalizeBundleTemplateHeaders(headers) {
  const normalized = headers.map((value) => normalizeCell(value));
  while (normalized.length && normalized[normalized.length - 1] === '') {
    normalized.pop();
  }
  return normalized;
}

// v3.2.18：v≤6 模板包里选「字段筛选特征值」的映射行不带特征值 id；包内有单套规则时让它们引用升级后的「特征值1」。
function upgradeLegacyBundleFeatureFilterRefs(item) {
  if (!item || typeof item !== 'object' || !item.featureFilter || typeof item.featureFilter !== 'object'
    || Array.isArray(item.featureFilter)) {
    return item;
  }
  const withLegacyRef = (rows) => (Array.isArray(rows) ? rows : []).map((mapping) => (
    mapping && normalizeCell(mapping.mappedField) === FEATURE_FILTER_MAPPING_FIELD && !getFeatureFilterRef(mapping)
      ? { ...mapping, mappedFields: [LEGACY_FEATURE_FILTER_ID] }
      : mapping
  ));
  return {
    ...item,
    mappings: withLegacyRef(item.mappings),
    billSplitMappings: withLegacyRef(item.billSplitMappings)
  };
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
  const channels = bundleVersion >= 5 && Array.isArray(parsed?.channels)
    ? parsed.channels
      .map((item) => ({
        name: normalizeCell(item && item.name),
        accountMappings: normalizeBundleAccountMappings(item && item.accountMappings),
        accountMappingConflicts: (Array.isArray(item && item.accountMappingConflicts) ? item.accountMappingConflicts : [])
          .map((conflict) => ({
            bankAccountId: normalizeCell(conflict && conflict.bankAccountId),
            candidates: Array.isArray(conflict && conflict.candidates) ? conflict.candidates : []
          }))
          .filter((conflict) => conflict.bankAccountId && conflict.candidates.length > 1)
      }))
      .filter((item) => item.name)
    : [];

  return {
    bundleVersion,
    channels,
    templates: templates.map((item) => (bundleVersion >= 7 ? item : upgradeLegacyBundleFeatureFilterRefs(item)))
      // v3.2.19：v7 及更早的包不可能含「逻辑取值」模式；mappedField 为「逻辑取值」的多字段映射是旧式按序拼接（首个字段恰好是
      //   名为「逻辑取值」的源列），还原为需要拼接字段，单字段 / 无字段的是直接映射该列，保持原样（见 buildMappedFieldLookup）。
      .map((item) => {
        if (bundleVersion >= 8 || !item || typeof item !== 'object') return item;
        const restoreLegacyConcat = (rows) => (Array.isArray(rows) ? rows.map((mapping) => (
          mapping && normalizeCell(mapping.mappedField) === LOGIC_VALUE_MAPPING_FIELD
            && (Array.isArray(mapping.mappedFields) ? mapping.mappedFields : []).filter((value) => normalizeCell(value) !== '').length > 1
            ? { ...mapping, mappedField: CONCAT_FIELDS_MAPPING_FIELD }
            : mapping
        )) : rows);
        return { ...item, mappings: restoreLegacyConcat(item.mappings), billSplitMappings: restoreLegacyConcat(item.billSplitMappings) };
      })
      .map((item) => ({
    templateKey: normalizeCell(item.templateKey),
    name: normalizeCell(item.name),
    sourceFileName: normalizeCell(item.sourceFileName) || `${normalizeCell(item.name) || 'template'}.xlsx`,
    headers: Array.isArray(item.headers) ? normalizeBundleTemplateHeaders(item.headers) : [],
    mappings: Array.isArray(item.mappings) ? item.mappings : [],
    bigAccounts: Array.isArray(item.bigAccounts) ? item.bigAccounts : [],
    fixedAssignments: Array.isArray(item.fixedAssignments) ? item.fixedAssignments : [],
    // v3.2.16（v6）：MerchantId「原始账单仅有币种无账户号」的 币种 → 大账号；v≤5 的包没有此字段
    currencyBigAccounts: Array.isArray(item.currencyBigAccounts)
      ? item.currencyBigAccounts.map((pair) => ({
          currency: normalizeCell(pair && pair.currency),
          merchantId: normalizeCell(pair && pair.merchantId)
        }))
      : [],
    amountSplitRules: Array.isArray(item.amountSplitRules) ? item.amountSplitRules : [],
    billSplitMappings: Array.isArray(item.billSplitMappings) ? item.billSplitMappings : [],
    billSplitRows: Array.isArray(item.billSplitRows) ? item.billSplitRows : [],
    billSplitAmountRules: Array.isArray(item.billSplitAmountRules) ? item.billSplitAmountRules : [],
    billSplitMeta: normalizeBundleBillSplitMeta(item.billSplitMeta),
    // v3.2.21：非字符串的日期格式按 auto（字符串化后可能恰好等于合法值）；其余取值在导入处理器按 normalizeTemplateDateFormat 规范化
    dateFormat: (typeof item.dateFormat === 'string' ? item.dateFormat.trim() : '') || 'auto',
    // v3.2.18：特征值列表（导入时再校验）。本版本导出的包都带 featureFilters 数组——映射都没选用时仍写 v5/v6，
    //   故按字段而非版本判断；没有数组时才是 v3.2.16/3.2.17 的单套 featureFilter，升级为「特征值1」。
    featureFilters: upgradeLegacyFeatureFilter(Array.isArray(item.featureFilters) ? item.featureFilters : item.featureFilter),
    // v3.2.19（v8）：原始账单预处理的过滤规则（只规范化；开关在 mappings 中，生成前再校验）
    preprocessRowFilterRules: normalizeRowFilterRules(item.preprocessRowFilterRules),
    // v3.2.15（v5）：所属渠道；v≤4 的主/子模板字段只用于导入时转为渠道。
    channelName: bundleVersion >= 5 ? (normalizeCell(item.channelName) || null) : null,
    isParent: bundleVersion < 5 && Boolean(item.isParent),
    parentTemplateKey: bundleVersion < 5 ? (normalizeCell(item.parentTemplateKey) || null) : null,
    accountMappings: Array.isArray(item.accountMappings) ? item.accountMappings : [],
    // v1.5.2 需求 3：文件名固定字段（老 bundle 无此字段时落为空串）
    filenameFixedField: normalizeCell(item.filenameFixedField) || ''
    }))
  };
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
  return buildMappingTargetFields(enumValues)
    .concat(PREPROCESS_FIELDS)
    .concat(ADVANCED_MAPPING_FIELDS)
    .concat(BILL_SPLIT_GROUP_FIELDS);
}

// v3.2.19：映射行中「过滤账单」是否勾选（原始账单预处理）
function isPreprocessRowFilterEnabled(mappings) {
  return (Array.isArray(mappings) ? mappings : []).some((mapping) => (
    normalizeCell(mapping && mapping.templateField) === PREPROCESS_ROW_FILTER_MAPPING_FIELD
      && normalizeCell(mapping && mapping.mappedField) === PREPROCESS_ROW_FILTER_ENABLED_OPTION
  ));
}

// v3.2.19：原始账单预处理「重复账单过滤」是否勾选（开关是映射行）
function isDuplicateRowFilterEnabled(mappings) {
  return (Array.isArray(mappings) ? mappings : []).some((mapping) => (
    normalizeCell(mapping && mapping.templateField) === DUPLICATE_ROW_FILTER_MAPPING_FIELD
      && normalizeCell(mapping && mapping.mappedField) === DUPLICATE_ROW_FILTER_ENABLED_OPTION
  ));
}

// v3.2.19：mappedField 为「逻辑取值」时，是否为旧版本直接引用名为「逻辑取值」的源列：没有真正的候补字段——
//   去空后为空，或只有一个同名列本身。按去重前的原值判断：多项（含重复的同名列）都按逻辑取值处理。
function isLegacyLogicValueDirectReference(mappedFields) {
  const nonEmptyFields = (Array.isArray(mappedFields) ? mappedFields : [])
    .map((value) => normalizeCell(value))
    .filter((value) => value !== '');
  return nonEmptyFields.length === 0
    || (nonEmptyFields.length === 1 && nonEmptyFields[0] === LOGIC_VALUE_MAPPING_FIELD);
}

// v3.2.19：映射行是否用到「逻辑取值」（主映射；拆分映射不支持）
// 只有带候补字段的才是 v3.2.19 的逻辑取值；没有候补字段的是直接映射名为「逻辑取值」的源列（旧版本可读，不升模板包版本）
function usesLogicValueMapping(mappings) {
  return (Array.isArray(mappings) ? mappings : []).some((mapping) => (
    normalizeCell(mapping && mapping.mappedField) === LOGIC_VALUE_MAPPING_FIELD
    && !isLegacyLogicValueDirectReference(mapping.mappedFields)
  ));
}

function getBalanceTemplatePath() {
  const appRoot = app.getAppPath();
  return path.join(appRoot, 'assets', '余额账单模版.xlsx');
}

function buildImportWarningDetailLines(warnings) {
  const detailLines = [];
  const currencyWarnings = warnings.filter((warning) => warning.type === 'currency-unmapped');
  const skippedDetailWarnings = warnings.filter((warning) => warning.type === 'detail-row-skipped');
  const summaryRowWarnings = warnings.filter((warning) => warning.type === 'summary-row-skipped');
  const balanceWarnings = warnings.filter((warning) => warning.type === 'balance-generate-failed');
  const skippedBalanceGaps = warnings
    .filter((warning) => warning.type === 'balance-gap-skipped')
    .flatMap((warning) => (Array.isArray(warning.gaps) ? warning.gaps : []));
  const featureValueWarnings = warnings.filter((warning) => warning.type === 'feature-value-unmatched');
  const longNumberWarnings = warnings.filter((warning) => warning.type === 'long-number-unverified');
  const confirmedBalanceMismatches = warnings
    .filter((warning) => warning.type === 'balance-mismatch-confirmed')
    .flatMap((warning) => (Array.isArray(warning.mismatches) ? warning.mismatches : []));
  const confirmedBalanceSeedReplacements = warnings
    .filter((warning) => warning.type === 'balance-seed-replace-confirmed')
    .flatMap((warning) => (Array.isArray(warning.replacements) ? warning.replacements : []));

  if (summaryRowWarnings.length) {
    detailLines.push('以下行的账单日期列是账单自带的合计标签，按合计行处理，未写入导出的明细账单：');
    summaryRowWarnings.forEach((warning) => {
      detailLines.push(`第${warning.rowNumber}行，账单日期列="${warning.rawValue || '(空)'}"`);
    });
  }

  if (skippedDetailWarnings.length) {
    detailLines.push('以下明细记录因 Credit Amount 和 Debit Amount 同时为 0 或空值，未写入导出的明细账单：');
    skippedDetailWarnings.forEach((warning) => {
      detailLines.push(
        `第${warning.rowNumber}行，Credit Amount="${warning.creditAmount || '(空)'}"，Debit Amount="${warning.debitAmount || '(空)'}"`
      );
    });
  }

  // v3.2.16：字段筛选特征值未命中的行（选该映射值的字段已留空）；v3.2.18 逐个特征值列出
  if (featureValueWarnings.length) {
    detailLines.push('以下行未筛出特征值，选择「字段筛选特征值」的字段已留空：');
    featureValueWarnings.forEach((warning) => {
      (Array.isArray(warning.misses) ? warning.misses : []).forEach((miss) => {
        detailLines.push(
          `第${warning.rowNumber}行，特征值“${miss.featureName}”，源字段“${miss.sourceField}”，原值“${miss.rawValue || '(空)'}”`
        );
      });
    });
  }

  // v3.2.21 B112：文件中只有近似值的长数字（二进制 .xls、Excel 另存的 xlsx 等），无法按原文还原。
  //   只列文件、行号、源字段与位数，不写值（多是卡号、账号；本提示同时写入活动日志）。
  //   整列都是这类数值时可能有很多行，明细最多列 100 处
  if (longNumberWarnings.length) {
    const LONG_NUMBER_WARNING_DETAIL_LIMIT = 100;
    detailLines.push('以下单元格是超出精度的数值，文件中没有可核对的原值，导出值可能与银行原值不同，请向银行索取该列为文本格式的文件：');
    let cellCount = 0;
    longNumberWarnings.forEach((warning) => {
      (Array.isArray(warning.cells) ? warning.cells : []).forEach((cell) => {
        cellCount += 1;
        if (cellCount > LONG_NUMBER_WARNING_DETAIL_LIMIT) return;
        detailLines.push(`${warning.fileName ? `文件“${warning.fileName}”` : ''}第${warning.rowNumber}行，源字段“${cell.sourceField}”，${cell.digitCount}位数值`);
      });
    });
    if (cellCount > LONG_NUMBER_WARNING_DETAIL_LIMIT) {
      detailLines.push(`……等共${cellCount}处`);
    }
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

  if (skippedBalanceGaps.length) {
    detailLines.push('以下账单日期不连续且未补录期末余额，断档后的余额按断档前的余额接着计算，可能不准确：');
    skippedBalanceGaps.forEach((gap) => detailLines.push(formatBalanceGapLine(gap)));
  }

  if (confirmedBalanceMismatches.length) {
    detailLines.push('以下账单余额与「上一日余额 + 当日收入 − 当日支出」不一致，已确认按账单余额生成，请核查是否漏单、重复或种子有误：');
    confirmedBalanceMismatches.forEach((mismatch) => detailLines.push(formatBalanceMismatchLine(mismatch)));
  }

  if (confirmedBalanceSeedReplacements.length) {
    detailLines.push('以下账单日的人工补录期末余额与本次余额不一致，已确认按本次余额生成并替换人工补录：');
    confirmedBalanceSeedReplacements.forEach((replacement) => detailLines.push(formatBalanceSeedReplaceLine(replacement)));
  }

  return detailLines;
}

function buildImportWarningMessage({ warnings, balanceReady, balanceRequested }) {
  const warningParts = [];
  const skippedDetailCount = warnings.filter((warning) => warning.type === 'detail-row-skipped').length;
  const summaryRowCount = warnings.filter((warning) => warning.type === 'summary-row-skipped').length;
  const hasCurrencyWarning = warnings.some((warning) => warning.type === 'currency-unmapped');
  const hasBalanceWarning = warnings.some((warning) => warning.type === 'balance-generate-failed');
  const featureValueMissCount = warnings.filter((warning) => warning.type === 'feature-value-unmatched').length;
  const longNumberRowCount = warnings.filter((warning) => warning.type === 'long-number-unverified').length;
  const skippedBalanceGapCount = warnings
    .filter((warning) => warning.type === 'balance-gap-skipped')
    .reduce((sum, warning) => sum + (Array.isArray(warning.gaps) ? warning.gaps.length : 0), 0);
  const confirmedBalanceMismatchCount = warnings
    .filter((warning) => warning.type === 'balance-mismatch-confirmed')
    .reduce((sum, warning) => sum + (Array.isArray(warning.mismatches) ? warning.mismatches.length : 0), 0);
  const confirmedBalanceSeedReplaceCount = warnings
    .filter((warning) => warning.type === 'balance-seed-replace-confirmed')
    .reduce((sum, warning) => sum + (Array.isArray(warning.replacements) ? warning.replacements.length : 0), 0);
  const exportParts = ['明细账单可导出'];

  if (balanceReady) {
    exportParts.push('余额账单可导出');
  } else if (balanceRequested) {
    exportParts.push('余额账单未生成');
  }

  if (summaryRowCount > 0) {
    warningParts.push(`已跳过${summaryRowCount}条账单自带的合计行`);
  }

  if (skippedDetailCount > 0) {
    warningParts.push(`已过滤${skippedDetailCount}条收支均为0或空值的明细`);
  }

  if (featureValueMissCount > 0) {
    warningParts.push(`${featureValueMissCount}行未筛出特征值，相关字段已留空`);
  }

  if (longNumberRowCount > 0) {
    warningParts.push(`${longNumberRowCount}行长数字无法核对原值`);
  }

  if (hasCurrencyWarning) {
    warningParts.push('存在币种未匹配记录');
  }

  if (hasBalanceWarning) {
    warningParts.push('存在余额账单异常');
  }

  if (skippedBalanceGapCount > 0) {
    warningParts.push(`${skippedBalanceGapCount}处账单日期不连续未补录，余额可能不准确`);
  }

  if (confirmedBalanceMismatchCount > 0) {
    warningParts.push(`${confirmedBalanceMismatchCount}处余额校验不一致，已按账单余额生成`);
  }

  if (confirmedBalanceSeedReplaceCount > 0) {
    warningParts.push(`${confirmedBalanceSeedReplaceCount}处人工补录余额已按本次余额替换`);
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

  // v3.2.16：按币种取大账号——界面显示为选项文字，不属于「自己输入」
  if (normalizedValue === MERCHANT_ID_CURRENCY_ONLY_MARKER) {
    return {
      isCustomInput: false,
      mappedField: MERCHANT_ID_CURRENCY_ONLY_OPTION,
      customValue: '',
      isMultiBigAccount: false
    };
  }

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
          // v3.2.19：逻辑取值的候补字段不在这里去重，模板包导入时由 validateTemplateConfiguration 拒绝重复项
          mappedFields: normalizeCell(mapping.mappedField) === LOGIC_VALUE_MAPPING_FIELD
            ? (Array.isArray(mapping.mappedFields) ? mapping.mappedFields : [])
                .map((value) => normalizeCell(value))
                .filter((value) => value !== '')
            : getMappingFieldValues(mapping)
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
    // v3.2.18：mappedFields[0] 是所选特征值 id，不是源字段
    if (rawMappedField === FEATURE_FILTER_MAPPING_FIELD) {
      const featureFilterRef = getFeatureFilterRef(savedMapping);
      return {
        templateField: fieldName,
        mappedField: FEATURE_FILTER_MAPPING_FIELD,
        mappedFields: featureFilterRef ? [featureFilterRef] : [],
        customValue: '',
        isMultiBigAccount: false
      };
    }
    // v3.2.19：逻辑取值的 mappedFields 是有序候补字段；须在拼接判断之前处理，否则多字段会被当成需要拼接字段。
    //   这里只去空白、去空，不去重：模板包导入随后经 validateTemplateConfiguration 校验，重复的候补字段须被拒绝。
    if (rawMappedField === LOGIC_VALUE_MAPPING_FIELD) {
      return {
        templateField: fieldName,
        mappedField: LOGIC_VALUE_MAPPING_FIELD,
        mappedFields: (Array.isArray(savedMapping && savedMapping.mappedFields) ? savedMapping.mappedFields : [])
          .map((value) => normalizeCell(value))
          .filter(Boolean),
        customValue: '',
        isMultiBigAccount: false
      };
    }
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
    // v3.2.18：mappedFields[0] 是所选特征值 id，不是源字段；生成用映射须保留它（buildMappedFieldLookup 据此取特征值）
    if (rawMappedField === FEATURE_FILTER_MAPPING_FIELD) {
      const featureFilterRef = getFeatureFilterRef(savedMapping);
      return {
        templateField: fieldName,
        mappedField: FEATURE_FILTER_MAPPING_FIELD,
        mappedFields: featureFilterRef ? [featureFilterRef] : []
      };
    }
    // v3.2.19：逻辑取值保留有序候补字段（buildMappedFieldLookup 据此生成取值 token）
    if (rawMappedField === LOGIC_VALUE_MAPPING_FIELD) {
      return {
        templateField: fieldName,
        mappedField: LOGIC_VALUE_MAPPING_FIELD,
        mappedFields: normalizeLogicValueFields(savedMapping && savedMapping.mappedFields)
      };
    }
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

// enumCache：一次计算多个模板配置时共用的枚举值缓存（如配置指纹），避免每个模板都重新解析枚举表
function getTemplateMappingConfig(templateId, { enumCache = null } = {}) {
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

  const enumValues = enumCache && Array.isArray(enumCache.values) ? enumCache.values : loadEnumValues(enumConfig.filePath);
  if (enumCache) enumCache.values = enumValues;
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
    preprocessFields: PREPROCESS_FIELDS.slice(),
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
          mergedGroupSeq: r.mergedGroupSeq === null || r.mergedGroupSeq === undefined ? null : Number(r.mergedGroupSeq),
          isFeeBill: Boolean(r.isFeeBill)
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
    billSplitMeta: normalizeBundleBillSplitMeta(templatePayload.billSplitMeta),
    // v3.2.16：MerchantId「原始账单仅有币种无账户号」的 币种 → 大账号
    currencyBigAccounts: Array.isArray(templatePayload.currencyBigAccounts)
      ? templatePayload.currencyBigAccounts.map((item) => ({
          currency: normalizeCell(item.currency),
          merchantId: normalizeCell(item.merchantId)
        }))
      : []
  };
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

function buildStatementDeferredOutputManifest(filePath, sourceOperation) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  return artifactManifestFromFilePlan(normalizeFilePlanV1({
    version: 1,
    allocation: 'eager',
    inputs: [],
    outputs: [{ filePath, role: 'output', sourceOperation }]
  }));
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
  return scanStatementBalanceSeedStatus({ detailRows, templateName }, ensureStorageRoot());
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

// 主窗口关闭（含任务栏“关闭窗口”、Alt+F4 等不经渲染层的入口）：
//   空闲存储整理或链接表过期清理持有过渡租约时，先中止并等其收尾，再重新关闭；升级准备期间仍阻止关闭。
function handleMainWindowClose(event) {
  if (quitPreparationComplete) return;
  if (idleDatabaseCompaction.isRunning() || idleLinkedTableRetention.isRunning()) {
    event.preventDefault();
    const closingWindow = mainWindow;
    Promise.all([
      idleLinkedTableRetention.stop('window-close'),
      idleDatabaseCompaction.stop('window-close')
    ]).then(() => {
      if (closingWindow && !closingWindow.isDestroyed()) closingWindow.close();
    });
    return;
  }
  if (businessOperationRegistry.isInstallTransitionActive()) event.preventDefault();
}

function createWindow(options = {}) {
  const instrumentation = createWindowInstrumentation({
    enabled: options.instrumentation === 'initial',
    mark: markStartupMetric,
    startPhase: (phase) => startStartupPhase(phase, recordStartupPhase)
  });
  mainWindowReady = false;
  const finishCreatePhase = instrumentation.startPhase('window-create');
  let finishLoadPhase = null;
  let finishReadyPhase = null;
  let settled = false;
  let resolveReady;
  let rejectReady;
  const readyPromise = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const failWindowStartup = (error) => {
    if (settled) return;
    settled = true;
    if (finishLoadPhase) finishLoadPhase('failed', { error });
    if (finishReadyPhase) finishReadyPhase('failed', { error });
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();
    mainWindow = null;
    mainWindowReady = false;
    rejectReady(error);
  };
  try {
  const windowIcon = loadBundledIcon();
  const appearance = darkModeScheduler.refresh();
  const windowOptions = {
    width: 1240,
    height: 860,
    minWidth: 1080,
    minHeight: 760,
    frame: false,
    backgroundColor: resolveWindowBackgroundColor(appearance.effectiveTheme, appearance.darkModeLightness),
    show: false,
    icon: windowIcon,
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      // v3.2.17：首帧早于 app:get-info，深浅度经 argv 交给 preload，由 head 同步脚本在 CSS 前绘制。
      additionalArguments: [`--dark-mode-lightness=${appearance.darkModeLightness}`]
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
  if (instrumentation.enabled) initialStartupWebContentsId = mainWindow.webContents.id;
  instrumentation.mark(STARTUP_METRIC_MARKS.windowCreated);

  if (windowIcon && process.platform !== 'darwin') {
    mainWindow.setIcon(windowIcon);
  }

  instrumentation.mark(STARTUP_METRIC_MARKS.loadStarted);
  finishLoadPhase = instrumentation.startPhase('window-load');
  finishReadyPhase = instrumentation.startPhase('window-ready');
  const readiness = waitForWindowReady({
    window: mainWindow,
    load: () => mainWindow.loadFile(path.join(app.getAppPath(), 'index.html')),
    timeoutMs: 30000,
    onLoad: () => {
      instrumentation.mark(STARTUP_METRIC_MARKS.didFinishLoad);
      finishLoadPhase('success');
    }
  });
  finishCreatePhase('success');
  readiness.then(() => {
    if (settled) return;
    instrumentation.mark(STARTUP_METRIC_MARKS.readyToShow);
    showReadyWindow({ window: mainWindow, sendWindowState });
    finishReadyPhase('success');
    mainWindowReady = true;
    settled = true;
    resolveReady(mainWindow);

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
  }).catch(failWindowStartup);
  mainWindow.on('close', handleMainWindowClose);
  mainWindow.on('maximize', sendWindowState);
  mainWindow.on('unmaximize', sendWindowState);
  } catch (error) {
    finishCreatePhase('failed', { error });
    failWindowStartup(error);
  }
  return readyPromise;
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
    // v3.2.15：所属渠道（取代主/子模板标记）
    channelId: template.channelId || null,
    channelName: template.channelName || '',
    // v1.5.2 需求 3（G3-4）：透传「文件名里的固定字段」给映射关系对话框回显
    filenameFixedField: String(template.filenameFixedField || ''),
    // v3.2.18：模板的特征值列表，供映射关系对话框的「选择特征值」与【特征值管理】回显
    featureFilters: Array.isArray(template.featureFilters)
      ? template.featureFilters.map((item) => ({ ...item }))
      : [],
    // v3.2.19：原始账单预处理「过滤账单」的过滤规则，供【规则设置】回显
    preprocessRowFilterRules: normalizeRowFilterRules(template.preprocessRowFilterRules)
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

function releaseAppUpdateTransition() {
  const token = appUpdateTransitionToken;
  if (token === null) return false;
  const released = businessOperationRegistry.releaseTransition(token);
  if (released && appUpdateTransitionToken === token) {
    appUpdateTransitionToken = null;
  }
  return released;
}

// 空闲整理准入：未登记到业务操作登记表的写入方也视为忙（与升级重启前的忙检查同口径）——
//   银行对账单操作锁。整理开始后该入口会因过渡租约拿不到锁，这里只需挡住整理开始前已在进行的写入。
function idleCompactionBusyReason() {
  if (bankStatementOperationLock.inFlight) return 'bank-statement-operation-busy';
  return '';
}

function listUpdateRestartBusyOperations() {
  const gate = businessOperationRegistry.beginInstallTransition('app-updater');
  if (!gate.acquired) {
    const labels = Array.isArray(gate.operations)
      ? gate.operations.map((operation) => operation.label).filter(Boolean)
      : [];
    return labels.length > 0 ? labels : ['升级准备中'];
  }
  appUpdateTransitionToken = gate.token;

  const busy = [];
  if (bankStatementOperationLock.inFlight) busy.push('资金对账数据处理');

  if (busy.length > 0) releaseAppUpdateTransition();
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
      cleanupBeforeRestart: () => prepareApplicationForQuit({
        transitionOwner: 'app-updater',
        transitionToken: appUpdateTransitionToken
      }),
      resumeAfterFailedRestart: resumeApplicationAfterFailedRestart,
      cancelInstallTransition: releaseAppUpdateTransition
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
  return runMemoryActivity(() => checkAndDownloadAppUpdateWithMemoryActivity(kind));
}

async function checkAndDownloadAppUpdateWithMemoryActivity(kind) {
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
      releaseAppUpdateTransition();
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
  ipcMain.handle('archive-center:prepare-delete-batch', (event, batchId) => {
    return callArchiveCenter('prepareDeleteBatch', batchId, { senderId: event.sender.id });
  });
  archiveCenterMutationIpcHandle('archive-center:delete-batch', '删除批次', (event, batchId, confirmationToken) => {
    return callArchiveCenter('deleteBatch', batchId, confirmationToken, { senderId: event.sender.id });
  });
  ipcMain.handle('archive-center:list-delete-cleanup-jobs', () => {
    return callArchiveCenter('listDeleteCleanupJobs');
  });
  archiveCenterMutationIpcHandle('archive-center:retry-delete-cleanup-job', '重试永久删除', (_event, cleanupJobId) => {
    return callArchiveCenter('retryDeleteCleanupJob', cleanupJobId);
  });
  archiveCenterMutationIpcHandle('archive-center:select-retry-sources',
    '选择存档恢复文件',
    (_event, batchId) => callArchiveCenter('selectRetrySources', batchId)
  );
  archiveCenterMutationIpcHandle('archive-center:retry-batch', '重试存档', async (_event, batchId, sourcePaths) => {
    const result = await callArchiveCenter('retryBatch', batchId, sourcePaths);
    if (result && result.status === 'success') {
      getVccFinancialOpService().syncImportArchiveLineage();
    }
    return result;
  });
  ipcMain.handle('archive-center:get-settings', () => callArchiveCenter('getSettings'));
  archiveCenterMutationIpcHandle('archive-center:change-storage-location',
    '变更存档位置',
    () => callArchiveCenter('changeStorageLocation')
  );
  archiveCenterMutationIpcHandle('archive-center:set-retention-days', '保存存档设置', (_event, retentionDays) => {
    return callArchiveCenter('setRetentionDays', retentionDays);
  });
  archiveCenterMutationIpcHandle('archive-center:set-module-retention-days', '保存模块存档设置', (_event, payload) => {
    return callArchiveCenter('setModuleRetentionDays', payload);
  });
  ipcMain.handle('archive-center:get-stats', () => callArchiveCenter('getStats'));
  ipcMain.handle('archive-center:start-entry-maintenance', (_event, visitId) => {
    return callArchiveCenter('startEntryMaintenance', visitId);
  });
}

function archiveCenterMutationIpcHandle(channel, functionKey, handler) {
  const meta = { channel, moduleKey: '存档中心', functionKey };
  ipcMain.handle(channel, runRegisteredBusinessOperation(meta, handler));
}

let templateResourceService = null;

// 设置 → 模板文件：用户版本文件存 {userData}/template-resources/，元数据与变更记录在主库。
function getTemplateResourceService() {
  if (!database || !database.db) throw new Error('数据库尚未初始化，请稍后重试');
  if (!templateResourceService) {
    templateResourceService = createTemplateResourceService({
      appRoot: app.getAppPath(),
      appVersion: app.getVersion(),
      userDataRoot: app.getPath('userData'),
      store: database,
      log: ({ level, message, details }) => appendActivityLogEntry({ level, message, details }),
      onChanged: (payload) => broadcastTemplateResourcesChanged(payload)
    });
  }
  return templateResourceService;
}

function broadcastTemplateResourcesChanged(payload) {
  for (const window of BrowserWindow.getAllWindows()) {
    try {
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
        window.webContents.send('template-resources:changed', payload);
      }
    } catch (_error) { /* 窗口关闭中，下次打开会重新读取 */ }
  }
}

// managed 导出守卫用：当前版本是否为内置；服务不可用时视为内置，由调用方沿用原路径逻辑。
async function resolveTemplateResourceFileForRead(resourceId) {
  try {
    return await getTemplateResourceService().resolveCurrentFile(resourceId);
  } catch (_error) {
    return { status: 'builtin' };
  }
}

// 缓存读取类模板（FundType 枚举、网关表头）的当前取值：用户版本返回导入时在检查 Worker 中解析的取值，主进程不解析用户文件；
//   内置或服务不可用时返回 builtin，由调用方沿用原路径逻辑读取随包文件。
// 平盘链接原始表各来源类型的当前导入识别结构（设置 → 模板文件）。
async function resolvePositionSourceStructures() {
  const service = getTemplateResourceService();
  const structures = {};
  for (const resourceId of Object.keys(INPUT_STRUCTURES)) {
    const spec = INPUT_STRUCTURES[resourceId];
    if (spec.group === 'position-sources') structures[spec.moduleKey] = await service.currentInputStructure(resourceId);
  }
  return structures;
}

async function resolveTemplateResourceValues(resourceId) {
  try {
    return await getTemplateResourceService().currentRuntimeValues(resourceId);
  } catch (_error) {
    return { status: 'builtin' };
  }
}

// managed（后台 Worker）只读导出在生产中未启用，尚未接入模板版本；启用了用户版本时拒绝走该路径，不静默改用内置模板。
async function assertManagedExportUsesBuiltinTemplate(resourceId) {
  const current = await resolveTemplateResourceFileForRead(resourceId);
  if (current.status !== 'builtin') {
    throw new Error('后台导出暂不支持已启用的用户模板版本，请在 设置 → 模板文件 恢复默认后重试');
  }
}

// 设置 → 模板文件：查询、另存为、导入新版本、启用 / 恢复默认、删除版本与变更记录。
function registerTemplateResourceHandlers() {
  ipcMain.handle('template-resources:list', () => getTemplateResourceService().list());
  ipcMain.handle('template-resources:get', (_event, resourceId) => getTemplateResourceService().get(resourceId));
  ipcMain.handle('template-resources:list-changes', () => getTemplateResourceService().listChanges());
  ipcMain.handle('template-resources:pick-import-file', async () => {
    const service = getTemplateResourceService();
    const choice = await showImportOpenDialog('template-resources', {
      title: '选择要导入的模板文件',
      properties: ['openFile'],
      filters: [{ name: 'Excel 工作簿', extensions: ['xlsx'] }]
    });
    const filePath = !choice.canceled && Array.isArray(choice.filePaths) ? choice.filePaths[0] : '';
    if (!filePath) return { status: 'cancelled' };
    let size = null;
    try {
      size = fs.statSync(filePath).size;
    } catch (_error) { /* 预检时再报告读取失败 */ }
    service.rememberPickedFile(filePath);
    return { status: 'success', filePath, fileName: path.basename(filePath), size };
  });
  ipcMain.handle('template-resources:prepare-import', (_event, payload) => getTemplateResourceService().prepareImport(payload || {}));
  ipcMain.handle('template-resources:discard-import', (_event, importToken) => getTemplateResourceService().discardImport(importToken));
  supportIpcHandle('template-resources:commit-import', '导入模板版本', (_event, payload) => (
    getTemplateResourceService().commitImport(payload || {})
  ));
  supportIpcHandle('template-resources:set-current-version', '切换模板版本', (_event, payload) => (
    getTemplateResourceService().setCurrentVersion(payload || {})
  ));
  supportIpcHandle('template-resources:delete-version', '删除模板版本', (_event, payload) => (
    getTemplateResourceService().deleteVersion(payload || {})
  ));
  supportIpcHandle('template-resources:save-as', '另存模板文件', async (_event, payload) => {
    const service = getTemplateResourceService();
    const target = service.resolveVersion(payload || {});
    if (target.status !== 'success') return target;
    const choice = await dialog.showSaveDialog(mainWindow, {
      title: '另存模板文件',
      defaultPath: target.fileName,
      filters: [{ name: target.extension.toUpperCase(), extensions: [target.extension] }]
    });
    if (choice.canceled || !choice.filePath) return { status: 'cancelled' };
    return service.exportVersion({ ...payload, targetPath: choice.filePath });
  });
}

let bankAccountService = null;

// 设置 → 账户管理：清结算系统银行账户表原文件存 {userData}/bank-accounts/，元数据与账户行在主库；
//   表头识别结构取模板文件「清结算银行账户表」当前版本（与平盘共用）。
function getBankAccountService() {
  if (!database || !database.db) throw new Error('数据库尚未初始化，请稍后重试');
  if (!bankAccountService) {
    bankAccountService = createBankAccountService({
      userDataRoot: app.getPath('userData'),
      store: database,
      appVersion: app.getVersion(),
      resolveStructure: () => getTemplateResourceService().currentInputStructure(BANK_ACCOUNT_STRUCTURE_RESOURCE_ID),
      log: ({ level, message, details }) => appendActivityLogEntry({ level, message, details }),
      onChanged: (payload) => broadcastBankAccountsChanged(payload)
    });
  }
  return bankAccountService;
}

function broadcastBankAccountsChanged(payload) {
  for (const window of BrowserWindow.getAllWindows()) {
    try {
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
        window.webContents.send('bank-accounts:changed', payload);
      }
    } catch (_error) { /* 窗口关闭中，下次打开会重新读取 */ }
  }
}

// 设置 → 账户管理：概况与分页查询、导入（选择 → 预检 → 确认替换）、另存为原表。
function registerBankAccountHandlers() {
  ipcMain.handle('bank-accounts:get-overview', () => getBankAccountService().getOverview());
  ipcMain.handle('bank-accounts:list', (_event, payload) => getBankAccountService().list(payload || {}));
  ipcMain.handle('bank-accounts:pick-import-file', async () => {
    const service = getBankAccountService();
    const choice = await showImportOpenDialog('bank-accounts', {
      title: '选择银行账户信息文件',
      properties: ['openFile'],
      filters: [{ name: 'Excel', extensions: ['xlsx', 'xls'] }]
    });
    const filePath = !choice.canceled && Array.isArray(choice.filePaths) ? choice.filePaths[0] : '';
    if (!filePath) return { status: 'cancelled' };
    service.rememberPickedFile(filePath);
    return { status: 'success', filePath, fileName: path.basename(filePath) };
  });
  ipcMain.handle('bank-accounts:prepare-import', (_event, payload) => getBankAccountService().prepareImport(payload || {}));
  ipcMain.handle('bank-accounts:discard-import', (_event, importToken) => getBankAccountService().discardImport(importToken));
  supportIpcHandle('bank-accounts:commit-import', '导入银行账户信息', (_event, payload) => (
    getBankAccountService().commitImport(payload || {})
  ));
  supportIpcHandle('bank-accounts:save-as', '导出银行账户表原表', async () => {
    const service = getBankAccountService();
    const target = service.resolveOriginal();
    if (target.status !== 'success') return target;
    const choice = await dialog.showSaveDialog(mainWindow, {
      title: '导出银行账户表原表',
      defaultPath: target.fileName,
      filters: [{ name: target.extension.toUpperCase(), extensions: [target.extension] }]
    });
    if (choice.canceled || !choice.filePath) return { status: 'cancelled' };
    return service.exportOriginal({ targetPath: choice.filePath });
  });
}

function readToolboxRecoveryBatchIds(userDataDir) {
  const indexPath = path.join(userDataDir, JOURNAL_INDEX_NAME);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return { batchIds: [], sweepUnsafe: false };
    }
    // 非 ENOENT 读取失败或 JSON 损坏代表 owner 身份不可验证，绝不能降级成
    // “没有受保护批次”，否则通用 sweep 会把 committed/running 原批次误标 failed。
    return { batchIds: [], sweepUnsafe: true, error };
  }
  if (!parsed || !Array.isArray(parsed.entries)) {
    return {
      batchIds: [],
      sweepUnsafe: true,
      error: new Error(`工具箱发布恢复索引结构无效：${indexPath}`)
    };
  }
  const batchIds = new Set();
  for (const entry of parsed.entries) {
    try {
      const context = freezeWorkerBatchContext(entry && entry.batchContext, { required: true });
      batchIds.add(context.batchId);
    } catch (error) {
      return { batchIds: [], sweepUnsafe: true, error };
    }
  }
  return { batchIds: [...batchIds], sweepUnsafe: false };
}

async function recoverPositionPendingBeforeInterruptedSweep() {
  const raw = positionTaskOwner.readPositionPendingRaw();
  if (!raw) return null;
  // Service 初始化会核 side-db checkpoint、persist append intent，并以同一 pending 原批次收口。
  try {
    getPositionReconciliationService();
    return await positionPendingRecoveryPromise;
  } catch (error) {
    error.blocksArchiveStartup = true;
    throw error;
  }
}

function recoverPreFundRunsBeforeInterruptedSweep() {
  if (!archiveCenterService) {
    throw new Error('前置资金 run Archive 恢复依赖尚未就绪');
  }
  return recoverPreFundRunReceipts({
    service: getPreFundReconciliationService(),
    archiveService: archiveCenterService.service
  });
}

function vccImportArchiveRecoveryOptions() {
  const archiveRepository = archiveCenterService
    && archiveCenterService.service
    && archiveCenterService.service.repository;
  if (!database || !database.db || !archiveRepository) {
    throw new Error('VCC 导入 Archive 恢复依赖尚未就绪');
  }
  return { db: database.db, archiveRepository };
}

function recoverVccImportBeforeInterruptedSweep() {
  // 构造 service 会先把上次崩溃时仍 importing 的业务批次收口为 failed；随后
  // owner 以同一 exact7 Archive batch 写入耐久 terminal intent。
  getVccFinancialOpService();
  return recoverVccImportArchiveTasks({
    ...vccImportArchiveRecoveryOptions(),
    archiveCenter: archiveCenterService
  });
}

function reconcileVccImportArchiveBeforeRetentionCleanup() {
  return reconcileVccImportArchiveLineageAtStartup(vccImportArchiveRecoveryOptions());
}

function protectedInterruptedTaskBatchIds() {
  const batchIds = new Set();
  const taskRunIds = [];
  try {
    const protection = positionTaskOwner.protectedInterruptedTasks();
    protection.batchIds.forEach((id) => batchIds.add(id));
    taskRunIds.push(...protection.taskRunIds);
  } catch (error) {
    return { batchIds: [...batchIds], taskRunIds, sweepUnsafe: true, error };
  }
  const toolboxProtection = readToolboxRecoveryBatchIds(app.getPath('userData'));
  if (toolboxProtection.sweepUnsafe === true) {
    return {
      batchIds: [...batchIds].sort((left, right) => left - right),
      sweepUnsafe: true,
      error: toolboxProtection.error
    };
  }
  for (const batchId of toolboxProtection.batchIds) {
    batchIds.add(batchId);
  }
  try {
    for (const batchId of listRecoverableVccImportArchiveBatchIds(
      vccImportArchiveRecoveryOptions()
    )) batchIds.add(batchId);
  } catch (error) {
    return {
      batchIds: [...batchIds].sort((left, right) => left - right),
      sweepUnsafe: true,
      error
    };
  }
  return {
    batchIds: [...batchIds].sort((left, right) => left - right),
    taskRunIds,
    sweepUnsafe: false
  };
}

function initializeArchiveCenter() {
  if (archiveCenterService || !database || !database.db) return archiveCenterService;
  const archiveRoot = path.join(getStorageRoot(), '存档中心');
  const archiveOutbox = createArchiveOutboxStore(path.join(
    path.dirname(database.dbPath),
    'run-data',
    'archive-center',
    'outbox'
  ));
  const createService = (rootDir) => {
    const service = createArchiveService({
      database: database.db,
      rootDir,
      resolveRetentionDays: (moduleId) => resolveRetentionDays(database, moduleId),
      opener: (filePath) => shell.openPath(filePath),
      onSourceReleased: positionTaskOwner.cleanupPositionArchiveSourcePaths
    });
    service.runDeleteWithOwnerGuard = (batchId, operation, options) => (
      archiveCenterService.runDeleteWithOwnerGuard(batchId, operation, options)
    );
    service.resolveOwnedDeleteSources = createPositionOwnedDeleteSourceResolver({
      userDataPath: path.dirname(database.dbPath),
      reportReferenceProvider: createPositionReportDeleteProtection({
        userDataPath: path.dirname(database.dbPath),
        getExpectedCheckpoint: () => database.getSetting(POSITION_SIDE_DB_CHECKPOINT_SETTING)
          || database.getSetting(POSITION_SIDE_DB_BOOTSTRAP_SETTING)
      }),
      protectedPathProvider: async ({ batch, artifacts }) => {
        // 在记录层排除本批次，不能从路径集合删元素，否则会漏掉其他批次的同路径引用。
        const references = positionDeleteSourceReferences(service.repository, batch.id, artifacts);
        const protectedPaths = positionPersistentStagingProtectionPaths(
          references.protectedPaths.concat(archiveOutbox.listSourcePaths()),
          positionTaskOwner.readPositionPendingOperation()
        );
        if (!Array.isArray(protectedPaths)) throw new Error('平盘暂存保护清单不可验证');
        if (positionReconciliationService) {
          const activePaths = positionReconciliationService.activeImportStagingPaths();
          if (!Array.isArray(activePaths)) throw new Error('平盘活动暂存保护清单不可验证');
          protectedPaths.push(...activePaths);
        }
        return {
          protectedPaths,
          sharedPaths: references.sharedPaths
        };
      }
    });
    return service;
  };
  const archiveRepository = createArchiveRepository(database.db);
  const runtimeService = createArchiveRuntimeDelegate({
    repository: archiveRepository,
    rootDir: database.getSetting('archive_center_storage_root') || archiveRoot
  });
  archiveStorageRootManager = createArchiveStorageRootManager({
    database,
    repository: archiveRepository,
    runtimeDelegate: runtimeService,
    createService,
    defaultRoot: archiveRoot,
    journalPath: path.join(
      path.dirname(database.dbPath),
      'run-data',
      'archive-center',
      'storage-migration.json'
    ),
    blockedRoots: [
      getAppRootDirectory(),
      path.dirname(database.dbPath),
      os.tmpdir()
    ],
    waitForArchiveOperations: () => archiveOperationTail,
    showOpenDialog: (options) => showImportOpenDialog('archive-center-storage-location', options),
    onProgress: (progress) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('archive-center:storage-migration-progress', progress);
      }
    },
    deferStartupRecovery: true
  });
  archiveCenterService = createArchiveCenterController({
    database,
    service: runtimeService,
    storageRootManager: archiveStorageRootManager,
    outboxStore: archiveOutbox,
    onOutboxFlushed: positionTaskOwner.cleanupPositionArchiveSourcePaths,
    resolveOutboxTerminalIntent: positionTaskOwner.resolvePositionOutboxTerminalIntent,
    terminalRouteRegistry,
    recoverInterruptedTaskOwners: applicationRecoveryCoordinator.archiveOwnerHooks(),
    postOutboxStartupHooks: applicationRecoveryCoordinator.postOutboxHooks(),
    getProtectedInterruptedTaskBatchIds: protectedInterruptedTaskBatchIds,
    onStartupPhase: recordStartupPhase,
    onEntryMaintenanceEvent: (eventName, payload) => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      const channels = {
        progress: 'archive-center:entry-maintenance-progress',
        completed: 'archive-center:entry-maintenance-completed',
        failed: 'archive-center:entry-maintenance-failed'
      };
      const channel = channels[eventName];
      if (channel) mainWindow.webContents.send(channel, payload);
    },
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
  const flowResolver = createBusinessFlowResolver({ archiveService: runtimeService });
  archiveTaskLifecycle = createTaskLifecycle({
    businessOperationRegistry,
    archiveService: runtimeService,
    flowResolver,
    operationTracker: archiveOperationTracker,
    persistTerminalIntent: (payload) => archiveCenterService.persistTaskTerminalIntent(payload),
    onArchiveWarning: reportArchiveFailure
  });
  archiveCenterInitializationPromise = archiveCenterService.initialize().catch((error) => {
    appendActivityLogEntry({
      level: 'error',
      source: 'main',
      domain: 'archive-center',
      message: '存档中心初始化失败，已阻止业务启动',
      details: [error && error.message ? error.message : String(error)]
    });
    throw error;
  });
  return archiveCenterService;
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
      previewModal: process.env.APP_CAPTURE_PATH ? (process.env.APP_PREVIEW_MODAL || '') : '',
      // v2.0.0-beta.2 F1 / v2.1.15 W4：UI 风格恒为 'Clear'（General 已弃用）；renderer 启动时立即应用
      uiStyle: database.getUiStyle() || 'Clear',
      ...darkModeScheduler.refresh(),
      // 上次使用模块；renderer 启动时恢复
      currentModule: database.getCurrentModule() || 'statement-generator',
      // v2.1.0-beta.3 T4：对账单ReconID修复模块「账单类别」持久化（business | gateway | null）
      reconIdFixBillCategory: database.getReconIdFixBillCategory(),
      // v2.1.4 T3：左上角模块切换按钮的启用列表（renderer 启动时一次拉，省一个 IPC round-trip）
      enabledModules: database.getEnabledModules(),
      // v1.5.3 R2（D15）：启动时自有账号迁移失败的错误文案；null 表示无失败
      ownAccountsMigrationError: lastOwnAccountsMigrationError,
      // v3.2.14：current = 本版说明（设置中查看）；pending = 升级后待弹出的说明
      releaseNotes: releaseNotesState ? releaseNotesState.getSnapshot() : { current: null, pending: null, history: null }
    };
  });
  ipcMain.handle('settings:acknowledge-release-notes', (_event, version) => {
    if (!releaseNotesState) return { status: 'ignored' };
    return releaseNotesState.acknowledge(version);
  });
  // v2.1.15 W4：弃用 General 风格。settings:set-ui-style 写链路已移除；
  //   getUiStyle 兜底后恒返回 'Clear'，renderer 启动 applyUiStyle 仍可用。
  ipcMain.handle('settings:get-ui-style', () => {
    return database.getUiStyle() || 'Clear';
  });
  ipcMain.handle('settings:set-dark-mode-schedule', (_event, config) => {
    try {
      return { status: 'ok', ...darkModeScheduler.setSchedule(config) };
    } catch (error) {
      return { status: 'failed', message: String(error && error.message ? error.message : error) };
    }
  });
  ipcMain.handle('settings:set-dark-mode-lightness', (_event, lightness) => {
    try {
      return { status: 'ok', ...darkModeScheduler.setLightness(lightness) };
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
  ipcMain.handle('scenarios:fund-type-enum', async () => {
    try {
      // 设置 → 模板文件：启用了用户版本时使用该版本导入时解析的取值（主进程不再解析用户文件）；不可用时按原降级返回空数组。
      const current = await resolveTemplateResourceValues('fund-type-enum');
      if (current.status === 'user') return { status: 'ok', values: current.values };
      if (current.status === 'unavailable') return { status: 'ok', values: [] };
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
  ipcMain.handle('scenarios:gateway-recon-headers', async () => {
    try {
      // 设置 → 模板文件：启用了用户版本时使用该版本导入时解析的表头字段（已剔除 __CUSTOM__）；不可用时按原降级返回旧字段。
      const current = await resolveTemplateResourceValues('gateway-recon');
      if (current.status === 'user') return { status: 'ok', values: current.values };
      if (current.status === 'unavailable') return { status: 'ok', values: [...GATEWAY_RECON_FIELDS] };
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
  // C4 单据模式场景配置的主 / 从字段下拉：设置 → 模板文件启用了「单据对账导出不平」用户版本时，取该版本
  //   业务部门账单 / 对手部门账单的表头；内置版本、版本不可用或读取异常时回落内置字段（与导入预检的场景引用保护同口径）。
  ipcMain.handle('scenarios:recon-id-fix-fields', async () => {
    const builtin = { status: 'ok', businessBillFields: [...BUSINESS_BILL_FIELDS], opponentBillFields: [...OPPONENT_BILL_FIELDS] };
    try {
      const current = await getTemplateResourceService().currentInputStructure('doc-recon-unbalanced');
      if (current.status !== 'user') return builtin;
      return {
        status: 'ok',
        businessBillFields: [...current.sheets[BUSINESS_BILL_SHEET_NAME]],
        opponentBillFields: [...current.sheets[OPPONENT_BILL_SHEET_NAME]]
      };
    } catch (_error) {
      return builtin;
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
          channelIds,
          filePlan: {
            version: 1,
            allocation: 'eager',
            inputs: [],
            outputs: [{
              filePath: saveResult.filePath,
              role: 'output',
              sourceOperation: 'scenarios:export-bundle'
            }]
          }
        };
      } catch (error) {
        return {
          proceed: false,
          result: { status: 'failed', message: String(error && error.message ? error.message : error) }
        };
      }
    },
    async execute(_event, prepared, taskContext) {
      try {
        const outputPath = taskContext.fileEvidence.filePlan.outputs[0].filePath;
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

        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        fs.writeFileSync(outputPath, jsonText, 'utf8');
        await taskContext.settleArtifacts({
          files: taskContext.fileEvidence.filePlan.outputs
            .map((item) => ({ artifactKey: item.artifactKey }))
        });

        appendActivityLogEntry({
          level: 'info',
          message: '导出场景模板文件成功',
          details: [
            `导出路径：${outputPath}`,
            `渠道数：${selectedChannels.length}`,
            `场景数：${totalScenarios}`
          ]
        });
        return {
          status: 'ok',
          filePath: outputPath,
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
          scenarioImportContext: context,
          filePlan: {
            version: 1,
            allocation: 'eager',
            inputs: [{
              filePath: context.filePath,
              role: 'input',
              sourceOperation: 'scenarios:import-bundle-apply'
            }],
            outputs: []
          },
          beforeStart: () => scenarioImportContextStore.assertUnchanged(context)
        };
      } catch (error) {
        return {
          proceed: false,
          result: { status: 'failed', code: error.code, message: error.message }
        };
      }
    },
    execute(_event, prepared, taskContext, payload = {}) {
    try {
      const context = scenarioImportContextStore.consume(payload.preparedContextId, {
        confirmCreateMissingChannels: payload.confirmCreateMissingChannels === true
      });
      const { bundle } = context;
      const filePath = taskContext.fileEvidence.filePlan.inputs[0].filePath;
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
        filePlan: {
          version: 1,
          allocation: 'eager',
          inputs: [{
            filePath: choice.filePaths[0],
            role: 'input',
            sourceOperation: 'bank-statement:import'
          }],
          outputs: []
        }
      };
    },
    async execute(_event, _prepared, taskContext) {
    try {
      const filePath = taskContext.fileEvidence.filePlan.inputs[0].filePath;
      const result = readBankStatement(filePath, {
        sourceHeaders: bankStatementSourceHeaders(await resolveBankStatementStructure(getTemplateResourceService()))
      });
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
        filePlan: {
          version: 1,
          allocation: 'eager',
          inputs: [{
            filePath: choice.filePaths[0],
            role: 'input',
            sourceOperation: 'gateway-recon:import'
          }],
          outputs: []
        }
      };
    },
    async execute(_event, _prepared, taskContext) {
    try {
      const filePath = taskContext.fileEvidence.filePlan.inputs[0].filePath;
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
  trackedIpcHandle('bank-statement:run', '银行对账单处理', '开始运行', {
    async prepare() {
      const flowIdentity = createBankStatementRunFlowIdentity();
      return {
        proceed: true,
        flowPlan: Object.freeze({ startsNewFlow: true, flowIdentity })
      };
    },
    async execute(event, prepared) {
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
      // v3.0.8 需求3：run 进度转发器（内联）。事件只读不写 processingResult。
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
        // 本轮 run 按 C04 窄化不分配存档批次，但 export 仍需稳定区分每次显式重跑。
        // 仅在当前 processingResult 内保存一次性身份；每次真实 export 各建一个含输出的可见批次，
        // 并以该身份续接同一轮 parent。
        // 不以月份、importedAt 或 latest 猜测，也不新增持久 tracker。
        archiveFlowIdentity: prepared.flowPlan.flowIdentity,
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
      const exportMoment = new Date();
      const storageRoot = getStorageRoot();
      const dateDir = buildDateDir(exportMoment);
      const timestamp = buildTimestamp(exportMoment);
      const minuteTimestamp = buildTimestampMinuteUnderscore(exportMoment);
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
      const outputKinds = [];
      const outputs = [];
      const addOutput = (kind, filePath) => {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        outputKinds.push(kind);
        outputs.push({
          filePath,
          role: 'output',
          sourceOperation: 'bank-statement:export'
        });
      };
      if (inspected.processingResult.errorReport.length > 0) {
        addOutput(
          'error-report',
          path.join(storageRoot, 'error-reports', dateDir, `${timestamp}-error-report.xlsx`)
        );
      }
      if (mainFilePath) addOutput('main', mainFilePath);
      const hitScenarioRows = inspected.processingResult.modifiedRows.filter(
        (row) => row && row._hitScenarioId !== undefined && row._hitScenarioId !== null
      );
      if (mainFilePath && hitScenarioRows.length > 0) {
        const baseName = buildScenarioHitRowsBaseName(inspected.bankStatementSession.filePath);
        addOutput(
          'hit-scenarios',
          path.join(
            storageRoot,
            'bank-statement-process',
            dateDir,
            `命中场景行-${baseName}-${timestamp}.xlsx`
          )
        );
      }
      if (mainFilePath
          && Array.isArray(inspected.processingResult.platformCleanupRows)
          && inspected.processingResult.platformCleanupRows.length > 0) {
        addOutput(
          'platform-cleanup',
          path.join(path.dirname(mainFilePath), buildPlatformCleanupFileName(minuteTimestamp))
        );
      }
      const hasRefundOutput = mainFilePath
        && ((Array.isArray(inspected.processingResult.refundBackfillRows)
              && inspected.processingResult.refundBackfillRows.length > 0)
          || (Array.isArray(inspected.processingResult.refundUnmatchedRows)
              && inspected.processingResult.refundUnmatchedRows.length > 0));
      if (hasRefundOutput) {
        addOutput(
          'refund-backfill',
          path.join(path.dirname(mainFilePath), buildRefundBackfillFileName(minuteTimestamp))
        );
      }
      if (outputs.length === 0) {
        return {
          proceed: false,
          result: {
            status: 'empty',
            message: '无修改记录，未生成主输出文件',
            errorReportPath: null,
            errorReportName: null
          }
        };
      }
      return {
        proceed: true,
        inspected,
        outputKinds: Object.freeze(outputKinds),
        filePlan: {
          version: 1,
          allocation: 'eager',
          inputs: [],
          outputs
        },
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
    async execute(_event, prepared, taskContext) {
    // v3.0.11 需求3（批1 · 🔴 资金红线）：统一互斥锁（与 import/run 共享一把）。争用即返回失败。
    const opLock = tryAcquireBankStatementOpLock('export');
    if (!opLock.acquired) {
      return { status: 'failed', message: opLock.message };
    }
    try {
      const outputByKind = new Map(prepared.outputKinds.map((kind, index) => [
        kind,
        taskContext.fileEvidence.filePlan.outputs[index].filePath
      ]));
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
        errorReport = await writeErrorReportOutputToPath({
          warnings: processingResult.errorReport,
          outputPath: outputByKind.get('error-report'),
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
      const mainFilePath = outputByKind.get('main');
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
            { outputPath: outputByKind.get('hit-scenarios'), channels }
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
          platformCleanupReport = await writePlatformCleanupOutput(
            processingResult.platformCleanupRows,
            outputByKind.get('platform-cleanup')
          );
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
          refundBackfillReport = await writeRefundBackfillOutput(
            refundBackfillRowsForExport,
            refundUnmatchedRowsForExport,
            outputByKind.get('refund-backfill')
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
      await taskContext.settleArtifacts({
        files: taskContext.fileEvidence.filePlan.outputs
          .map((item) => ({ artifactKey: item.artifactKey }))
      });
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
        subMode,
        filePlan: {
          version: 1,
          allocation: 'eager',
          inputs: [{
            filePath: choice.filePaths[0],
            role: 'input',
            sourceOperation: 'recon-id-fix:import'
          }],
          outputs: []
        }
      };
    },
    async execute(_event, prepared, taskContext) {
    try {
      const { subMode } = prepared;
      const filePath = taskContext.fileEvidence.filePlan.inputs[0].filePath;
      // 单据模式的 4 张工作表结构按设置 → 模板文件的当前版本识别；网关模式读资金对账导出不平，结构固定。
      let structure = null;
      if (subMode !== 'gateway') {
        structure = await getTemplateResourceService().currentInputStructure('doc-recon-unbalanced');
        if (structure.status === 'unavailable') return { status: 'failed', message: structure.message };
      }
      const result = readReconIdFixFile(filePath, subMode, { structure });
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
      if (isJpmScenario) {
        if (!reconFixJpmHoldGate) {
          throw Object.assign(new Error('ReconFix JPM Recovery Hold gate 尚未初始化'), {
            code: 'RECON_FIX_JPM_HOLD_GATE_UNAVAILABLE'
          });
        }
      }
      const runOpts = isJpmScenario
        ? { admRows: reconFixJpmHoldGate.runSynchronousMutationBoundary(
            () => database.readAdmBankDepositRows()
          ) }
        : (isBocScenario ? { bocLinkRows: database.readBocFxLinkRows() } : {});
      const result = runReconIdFix(scenario, clonedSheets, runOpts);
      if (isJpmScenario && result && Array.isArray(result.admUpdates)) {
        // 整批幂等重写 ADM 表匹配标志 / 资金对账ID（与 C4「run 无副作用」不同 —— TECH §4.5 标注）。
        // engine执行期间可能有startup/live recovery创建ADM Hold；写回前再次按
        // exact scope gate，禁止legacy路径跨过恢复阻断。
        reconFixJpmHoldGate.runSynchronousMutationBoundary(
          () => database.writeAdmMatchFlags(result.admUpdates)
        );
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
        const outputPaths = [saveResult.filePath];
        if (fixedRows.length > 0 && unmatchedRows.length > 0) {
          outputPaths.push(path.join(
            path.dirname(saveResult.filePath),
            buildReconIdFixUnmatchedReportFileName(
              resultSnapshot.scenarioName,
              timestamp,
              path.basename(saveResult.filePath),
              exportSubMode
            )
          ));
        }
        return {
          proceed: true,
          resultSnapshot,
          scenarioSnapshot: resultSnapshot.scenariosSnapshot,
          filePlan: {
            version: 1,
            allocation: 'eager',
            inputs: [],
            outputs: outputPaths.map((filePath) => ({
              filePath,
              role: 'output',
              sourceOperation: 'recon-id-fix:export'
            }))
          },
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
    async execute(_event, prepared, taskContext) {
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
      // PR #36 self-review round 5（P3-A，2026-05-09）：
      //   fixedRows 空 + unmatched 非空时，saveDialog 默认名直接用 unmatched 名，
      //   让"用户选的路径"语义对得上"实际写出的文件"——避免用户选 A.xlsx 但桌面上是
      //   另一个固定命名的困惑。
      // v2.1.0-beta.3 T9：按 scenario.category 推导 subMode，影响文件名前缀 + writer 输出列模板
      const exportSubMode = currentScenario.category === 'gateway-recon-id-fix' ? 'gateway' : 'business';
      const outputPaths = taskContext.fileEvidence.filePlan.outputs
        .map((item) => item.filePath);
      const savePath = outputPaths[0];
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
          const unmatchedSavePath = outputPaths[1];
          const writeUnmResult = await writeUnmatchedReport({
            unmatchedRows,
            savePath: unmatchedSavePath
          });
          ret.unmatchedFilePath = writeUnmResult.filePath;
          ret.unmatchedFileName = writeUnmResult.fileName;
          ret.unmatchedCount = writeUnmResult.rowCount;
        }
      }
      await taskContext.settleArtifacts({
        files: taskContext.fileEvidence.filePlan.outputs
          .map((item) => ({ artifactKey: item.artifactKey }))
      });
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
  ipcMain.on('app:report-startup-metrics', (event, payload = {}) => {
    if (!shouldAcceptInitialRendererMetrics({
      senderId: event.sender && event.sender.id,
      initialWebContentsId: initialStartupWebContentsId,
      hasExistingMetrics: startupMetrics.renderer !== null
    })) return;
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
    idleLinkedTableRetention.abort('user-activity');
    idleDatabaseCompaction.abort('user-activity');
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

// v3.2.15（D7）：账户映射的作用范围 —— { channelId } 为渠道层，{ templateId } 或数字为模板（兼容旧调用）。
function normalizeAccountMappingScopeArg(scope) {
  if (scope && typeof scope === 'object') {
    const channelId = Number(scope.channelId || 0);
    if (channelId > 0) return { channelId };
    return { templateId: Number(scope.templateId || 0) };
  }
  return { templateId: Number(scope || 0) };
}

function describeAccountMappingScope(scope) {
  if (scope.channelId) {
    const channel = database.getStatementChannel(scope.channelId);
    return `渠道：${channel ? channel.name : scope.channelId}`;
  }
  const template = database.getTemplate(scope.templateId);
  return `模板：${template ? template.name : scope.templateId}`;
}

function registerAccountMappingHandlers() {
  ipcMain.handle('account-mapping:list', (_event, rawScope) => {
    const scope = normalizeAccountMappingScopeArg(rawScope);
    return {
      status: 'success',
      mappings: database.listAccountMappings(scope),
      conflictCount: scope.channelId ? database.countStatementChannelAccountMappingConflicts(scope.channelId) : 0
    };
  });

  trackedIpcHandle('account-mapping:save', '生成网银账单', '账户映射', (_event, rawScope, mappings) => {
    const scope = normalizeAccountMappingScopeArg(rawScope);
    const templateId = scope.templateId || null;
    try {
      if (scope.channelId && !database.getStatementChannel(scope.channelId)) {
        return createErrorResult({
          step: '保存账户映射',
          message: '未找到对应渠道，请刷新后重试',
          errorCode: 'CHANNEL_NOT_FOUND',
          context: { channelId: scope.channelId }
        });
      }
      if (!scope.channelId) {
        const template = database.getTemplate(scope.templateId);
        if (template && template.channelId) {
          return createErrorResult({
            step: '保存账户映射',
            message: `模板「${template.name}」属于渠道「${template.channelName}」，账户映射请在渠道层统一设置`,
            errorCode: 'ACCOUNT_MAPPING_CHANNEL_SCOPE_REQUIRED',
            context: { templateId: template.id, channelId: template.channelId }
          });
        }
      }
      const validationResult = validateAccountMappings(mappings);

      if (validationResult.status !== 'success') {
        return createErrorResult({
          step: '保存账户映射',
          message: validationResult.message,
          errorCode: 'ACCOUNT_MAPPING_VALIDATE',
          detailLines: ['账户映射存在格式或完整性问题，未执行保存。'],
          context: { ...scope, mappings }
        });
      }

      const saveResult = database.saveAccountMappings(scope, validationResult.mappings);
      const resolvedConflicts = (saveResult && saveResult.resolvedConflictBankAccountIds) || [];
      clearLastErrorReport();
      appendActivityLogEntry({
        level: 'info',
        message: '保存账户映射成功',
        details: [
          describeAccountMappingScope(scope),
          `映射条数：${validationResult.mappings.length}`,
          ...(resolvedConflicts.length ? [`按本次设置处理的冲突账户号：${resolvedConflicts.join('、')}`] : [])
        ]
      });
      return {
        status: 'success',
        message: resolvedConflicts.length
          ? `账户映射保存成功，账户号 ${resolvedConflicts.join('、')} 的冲突按本次设置处理`
          : '账户映射保存成功'
      };
    } catch (error) {
      return createErrorResult({
        step: '保存账户映射',
        message: '账户映射保存失败，请导出报错文件查看详情',
        errorCode: 'ACCOUNT_MAPPING_RUNTIME',
        errorType: '系统错误',
        originalError: error,
        context: { ...scope, templateId, mappings }
      });
    }
  });

  // v3.2.15（D8）：迁移 / 旧版模板包合并时登记的渠道账户映射冲突。
  ipcMain.handle('channel-account-mapping:list-conflicts', () => ({
    status: 'success',
    channels: database.listStatementChannelAccountMappingConflicts()
  }));

  supportIpcHandle('channel-account-mapping:resolve-conflicts', '处理渠道账户映射冲突', (_event, payload = {}) => {
    const channelId = Number(payload.channelId);
    try {
      const { resolved, remaining } = database.resolveStatementChannelAccountMappingConflicts(channelId, payload.choices);
      const channel = database.getStatementChannel(channelId);
      clearLastErrorReport();
      appendActivityLogEntry({
        level: 'info',
        message: '处理渠道账户映射冲突',
        details: [
          `渠道：${channel ? channel.name : channelId}`,
          ...resolved.map((item) => `账户号 ${item.bankAccountId} → 清结算账号 ${item.clearingAccountId}${item.noCurrency ? `（无币种，兜底币种 ${item.currency}）` : ''}`),
          `剩余未处理：${remaining}`
        ]
      });
      return { status: 'success', message: '账户映射冲突已处理', remaining };
    } catch (error) {
      return createStatementChannelErrorResult('处理渠道账户映射冲突', error, { channelId });
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

      const droppedRows = [];
      // v3.2.15（D7）：渠道子模板不再持有模板级账户映射，迁移分配只面向普通模板。
      const channelTemplateIds = new Set(allTemplates.filter((t) => t.channelId).map((t) => t.id));
      const channelTargetRows = assignments.filter((a) => channelTemplateIds.has(Number(a.templateId)));
      if (channelTargetRows.length > 0) {
        return createErrorResult({
          step: '分配账户映射',
          message: `${channelTargetRows.length} 条映射的目标模板属于渠道，渠道的账户映射请在「账户映射」中选择渠道设置`,
          errorCode: 'MIGRATION_DISTRIBUTE_CHANNEL_TEMPLATE'
        });
      }
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

      // 清空所有普通模板的 account_mappings，再按分配写入（渠道子模板不持有模板级映射）
      for (const template of allTemplates) {
        if (template.channelId) continue;
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

// v3.2.18：【特征值管理】保存载荷校验——逐条校验名称与条件（已有 id 须存在，新条目分配 id）；
//   被删掉的特征值若仍被已保存的主映射或拆分映射选用则拒绝，提示被哪些字段使用。
function validateFeatureFiltersPayload(rawList, template) {
  const existing = Array.isArray(template.featureFilters) ? template.featureFilters : [];
  const knownIds = new Set(existing.map((item) => normalizeCell(item && item.id)).filter(Boolean));
  // v3.2.21：已保存映射仍引用、但特征值已不存在的 id 不分配给新特征值（否则悬空引用会被悄悄绑定到新规则）
  const referencedIds = database.listTemplateFeatureFilterReferences(template.id, FEATURE_FILTER_MAPPING_FIELD, {
    logicValueMappingValue: LOGIC_VALUE_MAPPING_FIELD,
    parseCandidateRef: parseLogicValueFeatureFilterRef
  }).map((reference) => reference.ref).filter(Boolean);
  // 未改动的已有特征值不按当前表头校验（模板【更新】后可逐个修复），新增与改动的照常校验
  const featureFilters = normalizeFeatureFilterList(rawList, {
    headers: template.headers, knownIds, preserved: existing, reservedIds: referencedIds
  });
  const keptIds = new Set(featureFilters.map((item) => item.id));
  const removed = existing.filter((item) => !keptIds.has(normalizeCell(item && item.id)));
  if (removed.length) {
    // v3.2.21：「逻辑取值」候补里的特征值同样算引用
    const references = database.listTemplateFeatureFilterReferences(template.id, FEATURE_FILTER_MAPPING_FIELD, {
      logicValueMappingValue: LOGIC_VALUE_MAPPING_FIELD,
      parseCandidateRef: parseLogicValueFeatureFilterRef
    });
    removed.forEach((item) => {
      const id = normalizeCell(item.id);
      const fields = references
        .filter((reference) => reference.ref === id)
        .map((reference) => {
          const label = reference.role === 'logic-value'
            ? `${reference.templateField}（${LOGIC_VALUE_MAPPING_FIELD}）`
            : reference.templateField;
          return reference.scope === 'split' ? `${label}（拆分/合并映射）` : label;
        })
        .filter((label, index, labels) => labels.indexOf(label) === index);
      if (fields.length) {
        throw new FileValidationError(
          'FILE_READ',
          `特征值「${normalizeCell(item.name)}」正被 ${fields.join('、')} 使用，请先改选其他特征值后再删除`
        );
      }
    });
  }
  return featureFilters;
}

// v3.2.21：映射（主映射、拆分映射）引用的特征值 id：直选「字段筛选特征值」的所选 id 与「逻辑取值」的特征值候补。
//   模板包导入时不分配给未带 id 的特征值，避免悬空引用被绑定到新规则。
function collectReferencedFeatureFilterIds(...mappingLists) {
  return [].concat(...mappingLists.map((list) => (Array.isArray(list) ? list : [])))
    .flatMap((mapping) => {
      const mappedField = normalizeCell(mapping && mapping.mappedField);
      const values = Array.isArray(mapping && mapping.mappedFields) ? mapping.mappedFields : [];
      if (mappedField === FEATURE_FILTER_MAPPING_FIELD) return [normalizeCell(values[0])];
      if (mappedField === LOGIC_VALUE_MAPPING_FIELD) {
        return values.map((value) => parseLogicValueFeatureFilterRef(normalizeCell(value))).filter((ref) => ref !== null);
      }
      return [];
    })
    .filter(Boolean);
}

// v3.2.18：选「字段筛选特征值」的映射行 → [{ templateField, ref }]；label 用于拆分映射的提示前缀。
function collectFeatureFilterRefs(mappings, label = '') {
  return (Array.isArray(mappings) ? mappings : [])
    .filter((mapping) => normalizeCell(mapping && mapping.mappedField) === FEATURE_FILTER_MAPPING_FIELD)
    .map((mapping) => ({
      templateField: `${label}${normalizeCell(mapping.templateField)}`,
      ref: getFeatureFilterRef(mapping)
    }));
}

function validateTemplateConfiguration({
  template,
  mappings,
  enumValues,
  bigAccounts = [],
  fixedAssignments = [],
  // v3.2.18：模板的特征值列表（库中已存，或模板包内已校验的列表）
  featureFilters = [],
  billSplitMappings = [],
  // v3.2.16：MerchantId「原始账单仅有币种无账户号」的 币种 → 大账号，与币种映射表中的币种代码
  currencyBigAccounts = [],
  availableCurrencyCodes = null,
  // v3.2.21：false 时（导入 v8 及更早的模板包）逻辑取值候补都按源列名校验，形如特征值候补的值不认作特征值
  allowLogicValueFeatureCandidates = true
}) {
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

    const isFeatureFilterMode = rawMappedField === FEATURE_FILTER_MAPPING_FIELD;
    const isLogicValueMode = rawMappedField === LOGIC_VALUE_MAPPING_FIELD;
    const featureFilterRef = isFeatureFilterMode ? getFeatureFilterRef(mapping) : '';
    mappingByTarget.set(targetField, {
      mappedField: rawMappedField === CONCAT_FIELDS_MAPPING_FIELD || isFeatureFilterMode || isLogicValueMode
        ? rawMappedField
        : sourceField,
      mappedFields: isFeatureFilterMode
        ? (featureFilterRef ? [featureFilterRef] : [])
        : isLogicValueMode
          // 保留重复项，交给下方校验报「不能重复」
          ? (Array.isArray(mapping.mappedFields) ? mapping.mappedFields : [])
              .map((value) => normalizeCell(value))
              .filter((value) => value !== '')
          : getMappingFieldValues(mapping),
      customValue: normalizeCell(mapping.customValue)
    });
  });

  const cleanedMappings = [];
  const featureFilterRefs = [];
  const merchantIdMapping = mappingByTarget.get('MerchantId') || {
    mappedField: '',
    mappedFields: [],
    customValue: '',
    isMultiBigAccount: false
  };
  const merchantIdManagedByBigAccounts = merchantIdMapping.mappedField === MERCHANT_ID_SELF_INPUT_OPTION;
  const merchantIdManagedByCurrency = merchantIdMapping.mappedField === MERCHANT_ID_CURRENCY_ONLY_OPTION
    || merchantIdMapping.mappedField === MERCHANT_ID_CURRENCY_ONLY_MARKER;
  const signedAmountSourceField = normalizeCell(mappingByTarget.get(SIGNED_AMOUNT_MAPPING_FIELD)?.mappedField);
  const creditAmountSourceField = normalizeCell(mappingByTarget.get('Credit Amount')?.mappedField);
  const debitAmountSourceField = normalizeCell(mappingByTarget.get('Debit Amount')?.mappedField);
  const amountSplitByFieldOption = normalizeCell(mappingByTarget.get(AMOUNT_SPLIT_BY_FIELD_MAPPING_FIELD)?.mappedField);
  const billSplitMergeOption = normalizeCell(mappingByTarget.get(BILL_SPLIT_MERGE_MAPPING_FIELD)?.mappedField);
  const billSplitRowFilterOption = normalizeCell(mappingByTarget.get(BILL_SPLIT_ROW_FILTER_MAPPING_FIELD)?.mappedField);
  const usesSignedAmountMapping = signedAmountSourceField !== '';
  const usesDirectAmountMapping = creditAmountSourceField !== '' || debitAmountSourceField !== '';
  const usesAmountSplitByField = amountSplitByFieldOption === AMOUNT_SPLIT_BY_FIELD_ENABLED_OPTION;
  const usesBillSplitMerge = billSplitMergeOption === BILL_SPLIT_MERGE_ENABLED_OPTION;
  // v3.2.19：开启拆分且根据字段值过滤账单时，未命中过滤规则的行走主映射，主映射的发生额配置不再与拆分互斥
  const usesBillSplitRowFilter = usesBillSplitMerge && billSplitRowFilterOption === BILL_SPLIT_ROW_FILTER_ENABLED_OPTION;
  const mainAmountModes = [
    usesDirectAmountMapping,
    usesSignedAmountMapping,
    usesAmountSplitByField
  ].filter(Boolean).length;

  if (usesBillSplitRowFilter) {
    if (mainAmountModes > 1) {
      throw new FileValidationError(
        'FILE_READ',
        'Credit Amount / Debit Amount 直接映射、按正负号拆分的发生额、按字段区分发生额 三者只能启用其中一种'
      );
    }
    if (mainAmountModes === 0) {
      throw new FileValidationError(
        'FILE_READ',
        '已勾选「根据字段值过滤账单」：未命中过滤规则的账单按主映射生成，请设置 Credit Amount / Debit Amount、按正负号拆分的发生额或按字段区分发生额'
      );
    }
  } else if (mainAmountModes + (usesBillSplitMerge ? 1 : 0) > 1) {
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

    if (targetField === BILL_SPLIT_ROW_FILTER_MAPPING_FIELD) {
      cleanedMappings.push({
        templateField: targetField,
        mappedField: normalizedSourceField === BILL_SPLIT_ROW_FILTER_ENABLED_OPTION
          ? BILL_SPLIT_ROW_FILTER_ENABLED_OPTION
          : '',
        mappedFields: []
      });
      return;
    }

    if (targetField === PREPROCESS_ROW_FILTER_MAPPING_FIELD) {
      cleanedMappings.push({
        templateField: targetField,
        mappedField: normalizedSourceField === PREPROCESS_ROW_FILTER_ENABLED_OPTION
          ? PREPROCESS_ROW_FILTER_ENABLED_OPTION
          : '',
        mappedFields: []
      });
      return;
    }

    if (targetField === DUPLICATE_ROW_FILTER_MAPPING_FIELD) {
      cleanedMappings.push({
        templateField: targetField,
        mappedField: normalizedSourceField === DUPLICATE_ROW_FILTER_ENABLED_OPTION
          ? DUPLICATE_ROW_FILTER_ENABLED_OPTION
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

    if (targetField === 'MerchantId' && merchantIdManagedByCurrency) {
      cleanedMappings.push({
        templateField: targetField,
        mappedField: MERCHANT_ID_CURRENCY_ONLY_MARKER,
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

    // v3.2.19：逻辑取值（候补字段取值），可用字段同「需要拼接字段」；候补字段至少 2 个、不重复、都在模板表头中。
    if (normalizedSourceField === LOGIC_VALUE_MAPPING_FIELD) {
      // 旧映射（v3.2.18 及更早，含旧模板包）：直接映射名为「逻辑取值」的真实源列，没有候补字段——表头有该列时原样保存，
      //   生成时按该列读取（buildMappedFieldLookup）；界面新建的「逻辑取值」在保存前已要求设置候补字段。
      // 没有真正的候补字段：为空，或只有一个同名列本身（旧版本单列映射也可能把列名记在 mappedFields 里）；
      //   多项（含重复的同名列）按逻辑取值校验，重复照常拒绝
      if (isLegacyLogicValueDirectReference(selectedMapping.mappedFields) && sourceFieldSet.has(LOGIC_VALUE_MAPPING_FIELD)) {
        cleanedMappings.push({
          templateField: targetField,
          mappedField: LOGIC_VALUE_MAPPING_FIELD,
          mappedFields: []
        });
        return;
      }
      if (
        targetField === 'Balance'
        || targetField === 'MerchantId'
        || targetField === 'Currency'
        || ADVANCED_MAPPING_FIELDS.includes(targetField)
      ) {
        throw new FileValidationError('FILE_READ', `${targetField} 不支持使用"${LOGIC_VALUE_MAPPING_FIELD}"`);
      }
      // v3.2.21：特征值候补统一为规范写法（id 去首尾空白）后再查重与计数，同一特征值的不同写法算重复。
      //   模板表头与特征值候补写法相同（只可能是构造的含 NUL 列名）时无法区分源列与特征值，按原写法与规范写法都检查，
      //   拒绝保存而不是任选其一。
      //   提示不带候补原文（含 NUL，特征值 id 也可能是模板包带入的任意字符串）。
      const ambiguousCandidateError = () => new FileValidationError(
        'FILE_READ',
        `${targetField} 的「${LOGIC_VALUE_MAPPING_FIELD}」有特征值候补与模板中一个列名内部写法相同，无法区分，请修改该列名`
      );
      const rawCandidates = (Array.isArray(selectedMapping.mappedFields) ? selectedMapping.mappedFields : [])
        .map((value) => normalizeCell(value))
        .filter((value) => value !== '')
        .map((value) => {
          const featureFilterRef = parseLogicValueFeatureFilterRef(value);
          if (featureFilterRef === null) return value;
          if (sourceFieldSet.has(value)) throw ambiguousCandidateError();
          // 旧版本模板包：这种写法只可能是源列名，表头里没有该列（失效的旧候补），拒绝而不是改认作特征值
          if (!allowLogicValueFeatureCandidates) {
            throw new FileValidationError(
              'FILE_READ',
              `${targetField} 的「${LOGIC_VALUE_MAPPING_FIELD}」有候补字段在模板表头中不存在，请在原版本中重新选择候补字段后再导出`
            );
          }
          return buildLogicValueFeatureCandidate(featureFilterRef);
        });
      if (new Set(rawCandidates).size !== rawCandidates.length) {
        throw new FileValidationError('FILE_READ', `${targetField} 的「${LOGIC_VALUE_MAPPING_FIELD}」候补字段不能重复`);
      }
      if (rawCandidates.length < LOGIC_VALUE_MIN_FIELDS) {
        throw new FileValidationError(
          'FILE_READ',
          `${targetField} 使用"${LOGIC_VALUE_MAPPING_FIELD}"时请至少选择 ${LOGIC_VALUE_MIN_FIELDS} 个候补字段`
        );
      }
      // v3.2.21：特征值候补不按表头校验，与「字段筛选特征值」一起在循环后按生效映射校验特征值存在且条件有效
      rawCandidates.forEach((fieldName) => {
        const featureFilterRef = parseLogicValueFeatureFilterRef(fieldName);
        if (featureFilterRef !== null && sourceFieldSet.has(fieldName)) {
          throw ambiguousCandidateError();
        }
        if (featureFilterRef !== null) {
          featureFilterRefs.push({ templateField: `${targetField}（${LOGIC_VALUE_MAPPING_FIELD}）`, ref: featureFilterRef });
          return;
        }
        if (!sourceFieldSet.has(fieldName)) {
          throw new FileValidationError('FILE_READ', `映射字段不存在：${fieldName}`);
        }
      });
      cleanedMappings.push({
        templateField: targetField,
        mappedField: LOGIC_VALUE_MAPPING_FIELD,
        mappedFields: rawCandidates
      });
      return;
    }

    // v3.2.16：字段筛选特征值，可用字段同「需要拼接字段」；v3.2.18 各行带所选特征值 id，循环后按生效映射统一校验。
    if (normalizedSourceField === FEATURE_FILTER_MAPPING_FIELD) {
      if (
        targetField === 'Balance'
        || targetField === 'MerchantId'
        || targetField === 'Currency'
        || ADVANCED_MAPPING_FIELDS.includes(targetField)
      ) {
        throw new FileValidationError('FILE_READ', `${targetField} 不支持使用"${FEATURE_FILTER_MAPPING_FIELD}"`);
      }
      const featureFilterRef = normalizeCell(selectedSourceFields[0]);
      featureFilterRefs.push({ templateField: targetField, ref: featureFilterRef });
      cleanedMappings.push({
        templateField: targetField,
        mappedField: FEATURE_FILTER_MAPPING_FIELD,
        mappedFields: featureFilterRef ? [featureFilterRef] : []
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
        // B132：结构化键，账号或币种本身含 @@ 时不同账户不同键
        const compositeKey = JSON.stringify([item.merchantId, currency]);

        if (duplicateKeys.has(compositeKey)) {
          throw new FileValidationError('FILE_READ', `大账号 ${item.merchantId} 的币种 ${currency} 重复`);
        }

        duplicateKeys.add(compositeKey);
      });
    });
  }

  // v3.2.16：只按实际生效的映射判断是否用到（与生成口径 resolveStatementFeatureFilters 一致）：
  //   启用拆分/合并且不复用模块映射时看拆分映射（已存或模板包内），否则看主映射。
  // v3.2.18：生效映射里每个选该值的字段都须选了特征值，且特征值存在、条件有效。
  const splitMappingsEffective = usesBillSplitMerge && cleanedMappings.some((mapping) => (
    mapping.templateField === REUSE_MODULE_MAPPING_FIELD && mapping.mappedField === '否'
  ));
  // v3.2.19：根据字段值过滤账单时未命中的行走主映射，主映射与拆分映射所选特征值都须有效。
  const splitFeatureFilterRefs = splitMappingsEffective
    ? collectFeatureFilterRefs(billSplitMappings, '拆分/合并账单映射关系设置中的 ')
    : [];
  // v3.2.19：逻辑取值只在主映射提供；模板包导入也不保存界面不能创建的拆分映射（同 validateBillSplitMappingsPayload）。
  //   没有候补字段的是旧版本直接引用名为「逻辑取值」的源列，照常允许（生成时按该列读取）；按去重前的原值判断，
  //   重复的同名候补（如两个「逻辑取值」）不是旧版本的形态，同样拒绝（仓储去重后会被当成直接引用写入）。
  const logicValueSplitMapping = (Array.isArray(billSplitMappings) ? billSplitMappings : [])
    .find((mapping) => normalizeCell(mapping && mapping.mappedField) === LOGIC_VALUE_MAPPING_FIELD
      && !isLegacyLogicValueDirectReference(mapping.mappedFields));
  if (logicValueSplitMapping) {
    throw new FileValidationError(
      'FILE_READ',
      `拆分/合并账单映射中的「${normalizeCell(logicValueSplitMapping.templateField)}」不支持使用"${LOGIC_VALUE_MAPPING_FIELD}"，请改选源字段`
    );
  }
  resolveUsedFeatureFilters(
    featureFilters,
    splitMappingsEffective
      ? (usesBillSplitRowFilter ? featureFilterRefs.concat(splitFeatureFilterRefs) : splitFeatureFilterRefs)
      : featureFilterRefs,
    { headers: template.headers }
  );
  // 根据字段值过滤账单时未命中的行按主映射取币种，Currency 照不拆分时的要求校验
  const cleanedCurrencyBigAccounts = merchantIdManagedByCurrency
    ? validateCurrencyBigAccountConfiguration({
        cleanedMappings,
        currencyBigAccounts,
        availableCurrencyCodes,
        usesBillSplitMerge: usesBillSplitMerge && !usesBillSplitRowFilter
      })
    : [];

  return {
    mappings: cleanedMappings,
    bigAccounts: expandBigAccountConfigurations(cleanedBigAccounts),
    fixedAssignments: cleanedFixedAssignments,
    currencyBigAccounts: cleanedCurrencyBigAccounts,
    usesBillSplitRowFilter,
    // v3.2.19：原始账单预处理「过滤账单」（与拆分无关）
    usesPreprocessRowFilter: isPreprocessRowFilterEnabled(cleanedMappings),
    // v3.2.19：原始账单预处理「重复账单过滤」
    usesDuplicateRowFilter: isDuplicateRowFilterEnabled(cleanedMappings)
  };
}

// v3.2.16：MerchantId「原始账单仅有币种无账户号」的保存校验（spec §4.1、§4.2）。
// 不拆分明细时 Currency 必须映射到原始账单的单个币种列；启用拆分 / 合并明细账单时币种取自各拆分行。
// 币种不区分大小写、统一存大写代码，必须在币种映射表中，且只能出现一次；一个大账号可对应多个币种。
function validateCurrencyBigAccountConfiguration({
  cleanedMappings,
  currencyBigAccounts = [],
  availableCurrencyCodes = null,
  usesBillSplitMerge = false
}) {
  const invalid = (message) => new FileValidationError('CURRENCY_BIG_ACCOUNT_INVALID', message);

  if (!usesBillSplitMerge) {
    const currencyMapping = cleanedMappings.find((mapping) => mapping.templateField === 'Currency');
    const currencySource = normalizeCell(currencyMapping && currencyMapping.mappedField);
    const currencySourceFields = Array.isArray(currencyMapping && currencyMapping.mappedFields)
      ? currencyMapping.mappedFields
      : [];
    if (
      !currencySource
      || currencySource === CONCAT_FIELDS_MAPPING_FIELD
      || currencySource.startsWith(FIXED_FIELD_VALUE_PREFIX)
      || currencySourceFields.length > 1
    ) {
      throw invalid(`MerchantId 选择「${MERCHANT_ID_CURRENCY_ONLY_OPTION}」时，Currency 必须映射到原始账单中的币种列`);
    }
  }

  const pairs = [];
  (Array.isArray(currencyBigAccounts) ? currencyBigAccounts : []).forEach((item, index) => {
    const currency = normalizeCell(item && item.currency).toUpperCase();
    const merchantId = normalizeCell(item && item.merchantId);
    if (!currency && !merchantId) {
      return;
    }
    if (!currency) {
      throw invalid(`【映射管理】第 ${index + 1} 行币种为空`);
    }
    if (!merchantId) {
      throw invalid(`【映射管理】第 ${index + 1} 行大账号为空`);
    }
    pairs.push({ currency, merchantId, rowNumber: index + 1 });
  });

  if (!pairs.length) {
    throw invalid('请在 MerchantId 的【映射管理】中至少维护 1 组币种与大账号');
  }

  if (Array.isArray(availableCurrencyCodes)) {
    const knownCodes = new Set(availableCurrencyCodes.map((code) => normalizeCell(code).toUpperCase()).filter(Boolean));
    if (!knownCodes.size) {
      throw invalid('未读取到币种映射表，无法校验【映射管理】中的币种');
    }
    const unknown = pairs.find((pair) => !knownCodes.has(pair.currency));
    if (unknown) {
      throw invalid(`【映射管理】第 ${unknown.rowNumber} 行币种「${unknown.currency}」不在币种映射表中`);
    }
  }

  const seen = new Map();
  pairs.forEach((pair) => {
    if (seen.has(pair.currency)) {
      throw invalid(`【映射管理】币种「${pair.currency}」重复（第 ${seen.get(pair.currency)}、${pair.rowNumber} 行），一个币种只能对应一个大账号`);
    }
    seen.set(pair.currency, pair.rowNumber);
  });

  return pairs.map(({ currency, merchantId }) => ({ currency, merchantId }));
}

// v3.2.15：旧的主/子模板通道只保留注册（冻结登记），调用一律拒绝且不写数据。
function createRetiredParentTemplateResult(step) {
  return {
    status: 'error',
    message: '主模板 / 子模板已改为渠道，请在映射关系管理中使用【渠道存在多个子模板】或【设为子模板】',
    errorCode: 'TEMPLATE_PARENT_RETIRED',
    step
  };
}

// v3.2.15 PR #246 审查：主/子模板转为渠道的启动迁移未完成（备份失败或事务回滚，旧主/子标记保留）时，主、子模板都未归入渠道，
//   按渠道模型生成会各自输出、月度余额对同一账号重复输出。迁移完成前阻断网银账单导入与月度余额装配，下次启动自动重试迁移。
//   返回阻断提示；迁移已完成或无需迁移时返回空字符串。
function getStatementChannelMigrationPendingMessage() {
  if (!database.hasPendingStatementChannelMigration()) return '';
  return '主模板 / 子模板转为渠道的数据迁移尚未完成（启动时迁移失败，原因见活动日志），为避免主、子模板的账单与余额重复输出，暂不能导入网银账单或装配月度余额；请重启应用重试迁移';
}

const STATEMENT_CHANNEL_BUSINESS_ERROR_CODES = new Set([
  'CHANNEL_NOT_FOUND',
  'CHANNEL_NAME_REQUIRED',
  'CHANNEL_NAME_DUPLICATED',
  'CHANNEL_ASSIGNMENT_INVALID',
  'CHANNEL_ACCOUNT_MAPPING_CONFLICT',
  'CHANNEL_ACCOUNT_MAPPING_CONFLICT_STALE',
  'CHANNEL_ACCOUNT_MAPPING_CONFLICT_PENDING',
  'CHANNEL_OUTPUT_NAME_CONFLICT',
  'TEMPLATE_NOT_FOUND'
]);

// v3.2.15：渠道相关业务错误需要界面逐条展示明细（如冲突账户号），
//   在通用错误结果上补充 errorCode 与 detailLines；不改变 createErrorResult 的公共返回形状。
function createDetailedErrorResult(options) {
  return {
    ...createErrorResult(options),
    errorCode: options.errorCode,
    detailLines: Array.isArray(options.detailLines) ? options.detailLines.slice() : []
  };
}

function createStatementChannelErrorResult(step, error, context = {}) {
  if (error && STATEMENT_CHANNEL_BUSINESS_ERROR_CODES.has(error.code)) {
    return createDetailedErrorResult({
      step,
      message: error.message,
      errorCode: error.code,
      detailLines: Array.isArray(error.detailLines) ? error.detailLines : [],
      context: { ...context, ...(error.context || {}) }
    });
  }
  return createErrorResult({
    step,
    message: `${step}失败，请导出报错文件查看详情`,
    errorCode: 'STATEMENT_CHANNEL_RUNTIME',
    errorType: '系统错误',
    originalError: error,
    context
  });
}

// v3.2.15【导入子模板】（spec §4.4，D9）：表头规则同【导入模板】；模板名按渠道编号自动生成，总是新建，不占用失败的编号。
function importStatementChildTemplate(channelId, selectedPath) {
  try {
    const headers = extractHeaders(selectedPath);
    const conflict = findConflictingTemplateByHeaders(headers, null);
    if (conflict) {
      return createErrorResult({
        step: '导入子模板',
        message: `该文件的表头与已有模板「${conflict.name}」完全相同，无法创建重复表头的模板。`,
        errorCode: 'TEMPLATE_HEADERS_DUPLICATE',
        context: { conflictTemplateName: conflict.name, channelId }
      });
    }
    const created = database.createChildTemplate(channelId, {
      sourceFileName: path.basename(selectedPath),
      headers
    });
    syncTemplateLibraryFile();
    clearLastErrorReport();
    appendActivityLogEntry({
      level: 'info',
      message: '导入子模板成功',
      details: [`渠道：${created.channel.name}`, `模板名：${created.name}`, `源文件：${selectedPath}`]
    });
    return {
      status: 'success',
      message: `已导入子模板「${created.name}」，请在【修改】中维护映射关系`,
      template: buildTemplateSummary(created.template),
      channelId: created.channel.id
    };
  } catch (error) {
    if (error instanceof FileValidationError) {
      return createErrorResult({
        step: '导入子模板',
        message: error.message,
        errorCode: error.code,
        detailLines: ['模板文件无法读取或表头无效，未完成导入。'],
        context: { selectedPath, channelId }
      });
    }
    if (error && STATEMENT_CHANNEL_BUSINESS_ERROR_CODES.has(error.code)) {
      return createStatementChannelErrorResult('导入子模板', error, { selectedPath, channelId });
    }
    return createErrorResult({
      step: '导入子模板',
      message: '子模板导入失败，请导出报错文件查看详情',
      errorCode: 'TEMPLATE_IMPORT_RUNTIME',
      errorType: '系统错误',
      originalError: error,
      context: { selectedPath, channelId }
    });
  }
}

// v3.2.18【导入模板】命名（spec：changes/v3.2.18/feat/template-import-naming/spec.md）：
//   template:prepare-import 选文件并识别为新模板 → 渲染层弹框输入银行渠道名、地区 → template:import 带 token 与名称提交。
//   待确认文件只登记在 Main，按发送方窗口归属；渲染层不回传路径。
function templateImportOwnerId(event) {
  return Number(event && event.sender && event.sender.id) || 0;
}

function createTemplateImportFileErrorResult(error, selectedPath) {
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

function createTemplateHeadersDuplicateResult(conflict) {
  return createErrorResult({
    step: '导入模板文件',
    message: `该文件的表头与已有模板「${conflict.name}」完全相同，无法创建重复表头的模板。`,
    errorCode: 'TEMPLATE_HEADERS_DUPLICATE',
    context: { conflictTemplateName: conflict.name }
  });
}

// 预检：表头能读出且与所有已有模板都不相同，才算新模板并登记待命名；表头重复沿用原报错，不弹命名框。
function prepareOrdinaryTemplateImport(ownerId, selectedPath) {
  try {
    const headers = extractHeaders(selectedPath);
    const conflict = findConflictingTemplateByHeaders(headers, null);
    if (conflict) {
      return createTemplateHeadersDuplicateResult(conflict);
    }
    const sourceFileName = path.basename(selectedPath);
    const importToken = pendingTemplateImports.register({ ownerId, filePath: selectedPath, sourceFileName, headers });
    return { status: 'ready', importToken, sourceFileName };
  } catch (error) {
    return createTemplateImportFileErrorResult(error, selectedPath);
  }
}

// 名称按 D1 规范化（大写），并按 D2 与已有模板、渠道查重（忽略大小写）。
function checkOrdinaryTemplateImportName(options = {}) {
  const name = normalizeTemplateImportName(options || {});
  if (!name.ok) {
    return {
      ok: false,
      result: createErrorResult({ step: '导入模板文件', message: name.message, errorCode: name.errorCode })
    };
  }
  const conflict = findTemplateImportNameConflict({
    templateName: name.templateName,
    templates: database.listTemplates(),
    channels: database.listStatementChannels()
  });
  if (conflict) {
    return {
      ok: false,
      result: createErrorResult({
        step: '导入模板文件',
        message: conflict.message,
        errorCode: conflict.errorCode,
        context: { templateName: name.templateName }
      })
    };
  }
  return { ok: true, name };
}

function createTemplateImportExpiredResult() {
  return createErrorResult({
    step: '导入模板文件',
    message: '本次导入已失效，请重新点击【导入模板】选择文件',
    errorCode: 'TEMPLATE_IMPORT_EXPIRED'
  });
}

// template:import 的 prepare：核对待确认文件与名称；不通过时直接返回，不预留归档批次，token 保留供改名重试。
function resolveOrdinaryTemplateImport(event, options = {}) {
  const pending = pendingTemplateImports.peek(options && options.importToken, templateImportOwnerId(event));
  if (!pending) {
    return { ok: false, result: createTemplateImportExpiredResult() };
  }
  const checked = checkOrdinaryTemplateImportName(options);
  if (!checked.ok) return checked;
  return { ok: true, filePath: pending.filePath, templateName: checked.name.templateName };
}

// template:import 的 execute：复核名称（防并发），重读表头须与预检一致，再新建模板。
function importOrdinaryTemplate(event, options = {}, selectedPath) {
  const ownerId = templateImportOwnerId(event);
  const importToken = options && options.importToken;
  const pending = pendingTemplateImports.peek(importToken, ownerId);
  if (!pending || pending.filePath !== selectedPath) {
    return createTemplateImportExpiredResult();
  }
  const checked = checkOrdinaryTemplateImportName(options);
  if (!checked.ok) return checked.result;
  const { templateName, bankName, region } = checked.name;
  pendingTemplateImports.consume(importToken, ownerId);
  try {
    const headers = extractHeaders(selectedPath);
    if (JSON.stringify(headers) !== JSON.stringify(pending.headers)) {
      return createErrorResult({
        step: '导入模板文件',
        message: '模板文件在确认期间已变化，请重新点击【导入模板】选择文件',
        errorCode: 'TEMPLATE_IMPORT_FILE_CHANGED',
        context: { selectedPath }
      });
    }
    const conflict = findConflictingTemplateByHeaders(headers, null);
    if (conflict) {
      return createTemplateHeadersDuplicateResult(conflict);
    }
    // 已确认不重名（忽略大小写），upsertTemplate 只会新建，不会覆盖已有模板的映射与配置。
    const template = database.upsertTemplate({
      name: templateName,
      sourceFileName: pending.sourceFileName,
      headers
    });
    syncTemplateLibraryFile();
    clearLastErrorReport();
    appendActivityLogEntry({
      level: 'info',
      message: '导入模板文件成功',
      details: [`模板名：${templateName}`, `银行渠道名：${bankName}`, `地区：${region}`, `源文件：${selectedPath}`]
    });
    return {
      status: 'success',
      message: `已导入模板「${templateName}」，请在模板管理中维护映射关系`,
      template: buildTemplateSummary(template)
    };
  } catch (error) {
    return createTemplateImportFileErrorResult(error, selectedPath);
  }
}

// v3.2.15：template:save-mappings 的 channel 参数 → 仓储的归属指令；缺省或无法识别为不改归属。
function normalizeTemplateChannelAssignment(channel) {
  if (!channel || typeof channel !== 'object') return { mode: 'keep' };
  const mode = normalizeCell(channel.mode);
  if (mode === 'none' || mode === 'create') return { mode };
  if (mode === 'join') return { mode, channelId: Number(channel.channelId) };
  return { mode: 'keep' };
}

// v3.2.15（§5.3）：v5 模板包——按名称取得或新建渠道，写入渠道映射与冲突，再按条目 channelName 归属。
//   包内有模板归入、但这些模板第一轮全部被跳过的渠道不还原：渠道层的映射与冲突整体替换，
//   还原它会改写被跳过模板所在同名渠道的生效映射并清掉待处理冲突（release/v3.2.15 审查）。
function buildBundleV5ChannelRestore(importedChannels, importedTemplateRecords, importedTemplates = []) {
  const packagedChannelNames = new Set(importedTemplates.map((entry) => entry && entry.channelName).filter(Boolean));
  const restoredChannelNames = new Set(importedTemplateRecords.map(({ entry }) => entry.channelName).filter(Boolean));
  const channels = (Array.isArray(importedChannels) ? importedChannels : [])
    .filter((channel) => !packagedChannelNames.has(channel.name) || restoredChannelNames.has(channel.name))
    .map((channel) => ({
      name: channel.name,
      accountMappings: normalizeBundleAccountMappings(channel.accountMappings),
      accountMappingConflicts: channel.accountMappingConflicts || []
    }));
  const assignments = importedTemplateRecords.map(({ entry, template }) => ({
    templateId: template.id,
    channelName: entry.channelName || null
  }));
  return { channels, legacyChannelSources: [], assignments };
}

// v3.2.15（§5.3）：v≤4 模板包——isParent 的条目按其名称建渠道，它和 parentTemplateKey 指向它的条目归入该渠道，
//   各条目的账户映射按迁移口径合并（相同去重、不一致登记为待处理冲突）。
//   父模板在包内但第一轮被跳过时，不当作包外父模板去找本地同 key 模板（release/v3.2.15 审查）：
//   否则本地模板会被归入渠道、清掉模板级映射，与“被跳过模板保留原映射与归属”相违；子模板按无父模板处理。
function buildLegacyBundleChannelRestore(importedTemplateRecords, importedTemplates = []) {
  const byKey = new Map();
  importedTemplateRecords.forEach((record) => {
    if (record.entry.templateKey) byKey.set(record.entry.templateKey, record);
  });
  const packagedKeys = new Set(importedTemplates.map((entry) => entry && entry.templateKey).filter(Boolean));
  // 父模板在包内但被跳过的成功模板，按最终归属分两类写日志：按普通模板导入的，以及最终仍归入渠道的（自身仍是主模板、
  //   被成功的子模板引用，或手工合并的包里另一条把它归入别的渠道），后者带上最终渠道名（release/v3.2.15 复审）。
  const parentSkippedRecords = [];
  const resolveParent = (record) => {
    const parentKey = record.entry.parentTemplateKey;
    if (!parentKey) return null;
    if (byKey.has(parentKey)) return { record: byKey.get(parentKey) };
    if (packagedKeys.has(parentKey)) return null;
    const external = database.getTemplateByKey(parentKey);
    return external ? { external } : null;
  };
  const referencedKeys = new Set(importedTemplateRecords.map((record) => record.entry.parentTemplateKey).filter(Boolean));
  const rootNameOf = (record) => {
    let current = record;
    const seen = new Set();
    for (;;) {
      seen.add(current.template.id);
      const parent = resolveParent(current);
      if (!parent) return { name: current.template.name };
      if (parent.external) {
        return { name: parent.external.channelName || parent.external.name, external: parent.external };
      }
      if (seen.has(parent.record.template.id)) return { name: current.template.name };
      current = parent.record;
    }
  };
  const membersByChannel = new Map();
  const assignments = [];
  importedTemplateRecords.forEach((record) => {
    const parentKey = record.entry.parentTemplateKey;
    const parentSkipped = Boolean(parentKey && !byKey.has(parentKey) && packagedKeys.has(parentKey));
    const involved = record.entry.isParent || Boolean(resolveParent(record))
      || (record.entry.templateKey && referencedKeys.has(record.entry.templateKey));
    if (parentSkipped) parentSkippedRecords.push(record);
    if (!involved) {
      assignments.push({ templateId: record.template.id, channelName: null });
      return;
    }
    const root = rootNameOf(record);
    if (!membersByChannel.has(root.name)) membersByChannel.set(root.name, { sources: [], externalIds: new Set() });
    const member = membersByChannel.get(root.name);
    member.sources.push({ sourceName: record.template.name, mappings: normalizeBundleAccountMappings(record.entry.accountMappings) });
    if (root.external && !root.external.channelId && !member.externalIds.has(root.external.id)) {
      // 包外的主模板随渠道转换一起归入，账户映射一并合并（同迁移 D1）。
      member.externalIds.add(root.external.id);
      member.sources.push({
        sourceName: root.external.name,
        mappings: database.listAccountMappings({ templateId: root.external.id })
      });
      assignments.push({ templateId: root.external.id, channelName: root.name });
    }
    assignments.push({ templateId: record.template.id, channelName: root.name });
  });
  // 已有同名渠道的映射与待处理冲突由 restoreTemplateBundleStatementChannels 在同一事务内并入来源。
  const legacyChannelSources = Array.from(membersByChannel.entries())
    .map(([name, member]) => ({ name, sources: member.sources }));
  // 归属按顺序生效，同一模板出现多次（手工合并的包）时以最后一条为准；日志按模板最终归属分类、每个模板只列一次。
  const finalChannelByTemplateId = new Map(assignments.map((assignment) => [assignment.templateId, assignment.channelName]));
  const orphanedTemplateNames = [];
  const regroupedTemplateNames = [];
  const loggedTemplateIds = new Set();
  parentSkippedRecords.forEach((record) => {
    if (loggedTemplateIds.has(record.template.id)) return;
    loggedTemplateIds.add(record.template.id);
    const finalChannelName = finalChannelByTemplateId.get(record.template.id);
    if (finalChannelName) regroupedTemplateNames.push(`${record.template.name}（渠道「${finalChannelName}」）`);
    else orphanedTemplateNames.push(record.template.name);
  });
  return { channels: [], legacyChannelSources, assignments, orphanedTemplateNames, regroupedTemplateNames };
}

// 模板包导入的第二、三轮，只处理第一轮成功导入的条目（succeededEntries）：
//   第二轮写入模板级账户映射（v1.5.1，覆盖导入时也清除旧映射）；第三轮还原渠道与归属（v3.2.15，§5.3，v≤4 的主/子关系转为渠道）。
//   被跳过的模板（表头重复、映射校验失败）保留原有映射与归属（v3.2.15 PR #246 审查）。
function restoreBundleFollowUpRounds({ importedTemplates, succeededEntries, importedBundleVersion, importedChannels }) {
  const importedTemplateRecords = [];
  importedTemplates.forEach((entry) => {
    if (!succeededEntries.has(entry)) return;
    const template = entry.templateKey
      ? database.getTemplateByKey(entry.templateKey)
      : database.getTemplateByName(entry.name);
    if (!template) return;
    importedTemplateRecords.push({ entry, template });

    // 始终写入：v3 bundle 无 accountMappings 时 mappings=[] → 清除旧映射
    database.saveAccountMappings({ templateId: template.id }, normalizeBundleAccountMappings(entry.accountMappings));
  });

  const channelRestore = importedBundleVersion >= 5
    ? buildBundleV5ChannelRestore(importedChannels, importedTemplateRecords, importedTemplates)
    : buildLegacyBundleChannelRestore(importedTemplateRecords, importedTemplates);
  const restoreResult = database.restoreTemplateBundleStatementChannels(channelRestore);
  return { importedTemplateRecords, channelRestore, restoreResult };
}

function registerTemplateHandlers() {
  ipcMain.handle('template:list', () => {
    return database.listTemplates();
  });

  // v3.2.15：主/子模板已由渠道取代。以下三个通道仍在冻结的 G7 归档登记与 preload 中，暂保留注册，
  //   但不再读写任何数据；界面改用渠道接口（channel:* 与 template:save-mappings 的 channel 参数）。
  ipcMain.handle('template:list-children', () => []);

  businessIpcHandle('template:set-parent-status', '设置父模板状态', () => (
    createRetiredParentTemplateResult('设置主模板状态')
  ));

  businessIpcHandle('template:set-child-parent', '设置子模板归属', () => (
    createRetiredParentTemplateResult('设置子模板')
  ));

  ipcMain.handle('channel:list', () => database.listStatementChannels());

  supportIpcHandle('channel:rename', '重命名渠道', (_event, payload = {}) => {
    const channelId = Number(payload.channelId);
    try {
      const { previous, channel } = database.renameStatementChannel(channelId, payload.name);
      syncTemplateLibraryFile();
      clearLastErrorReport();
      appendActivityLogEntry({
        level: 'info',
        message: '重命名渠道成功',
        details: [
          `原渠道名：${previous.name}`,
          `新渠道名：${channel.name}`,
          '渠道下子模板的输出身份、余额种子与余额调整改按新渠道名的银行段读取'
        ]
      });
      return { status: 'success', message: '渠道名称修改成功', channel };
    } catch (error) {
      return createStatementChannelErrorResult('重命名渠道', error, { channelId });
    }
  });

  supportIpcHandle('channel:delete', '删除渠道', (_event, channelId) => {
    try {
      const { channel, releasedTemplates, conflictCount } = database.deleteStatementChannel(channelId);
      syncTemplateLibraryFile();
      clearGeneratedExports();
      clearPendingManualBalancePrompt();
      clearPendingBigAccountSelection();
      // v3.2.19：待确认的重复账单复核引用删除前的模板 / 渠道配置，一并作废（确认时提示重新导入）
      statementDuplicateReview.clear();
      clearLastErrorReport();
      appendActivityLogEntry({
        level: 'info',
        message: '删除渠道成功',
        details: [
          `渠道名：${channel.name}`,
          `恢复为普通模板：${releasedTemplates.map((item) => item.name).join('、') || '（无）'}`,
          ...(conflictCount > 0 ? [`未处理的账户映射冲突 ${conflictCount} 个已随渠道清除，请为这些模板重新检查账户映射`] : [])
        ]
      });
      return {
        status: 'success',
        message: conflictCount > 0
          ? `渠道已删除，${releasedTemplates.length} 个子模板恢复为普通模板；有 ${conflictCount} 个未处理的账户映射冲突随渠道清除，请为这些模板重新检查账户映射`
          : `渠道已删除，${releasedTemplates.length} 个子模板恢复为普通模板`,
        releasedTemplateCount: releasedTemplates.length,
        clearedConflictCount: conflictCount
      };
    } catch (error) {
      return createStatementChannelErrorResult('删除渠道', error, { channelId });
    }
  });

  // v3.2.18【导入模板】：选文件并识别为新模板（只读预检）；确认命名后走 template:import 写入。
  ipcMain.handle('template:prepare-import', async (event) => {
    const choice = await showImportOpenDialog('template', {
      properties: ['openFile'],
      filters: templateFileDialogFilters()
    });
    const selectedPath = !choice.canceled && Array.isArray(choice.filePaths) ? choice.filePaths[0] : '';
    if (!selectedPath) {
      return { status: 'cancelled' };
    }
    return prepareOrdinaryTemplateImport(templateImportOwnerId(event), selectedPath);
  });

  // v3.2.18【导入模板】：命名弹框取消时丢弃待确认文件。
  ipcMain.handle('template:discard-import', (event, importToken) => {
    pendingTemplateImports.discard(importToken, templateImportOwnerId(event));
    return { status: 'success' };
  });

  // v3.2.15：传 { channelId } 即【导入子模板】（T7）——模板名按渠道编号生成，总是新建并归入该渠道。
  // v3.2.18：普通导入传 { importToken, bankName, region }——文件来自 template:prepare-import，模板名 = 银行渠道名-地区。
  trackedIpcHandle('template:import', '生成网银账单', '导入模板', {
    async prepare(event, options = {}) {
      const childChannelId = Number(options && options.channelId || 0);
      if (childChannelId && !database.getStatementChannel(childChannelId)) {
        return {
          proceed: false,
          result: createErrorResult({
            step: '导入子模板',
            message: '未找到对应渠道，请刷新后重试',
            errorCode: 'CHANNEL_NOT_FOUND',
            context: { channelId: childChannelId }
          })
        };
      }
      let selectedPath = '';
      if (childChannelId) {
        const result = await showImportOpenDialog('template', {
          properties: ['openFile'],
          filters: templateFileDialogFilters()
        });
        if (result.canceled || result.filePaths.length === 0) {
          return { proceed: false, result: { status: 'cancelled' } };
        }
        selectedPath = result.filePaths[0];
      } else {
        const resolved = resolveOrdinaryTemplateImport(event, options);
        if (!resolved.ok) {
          return { proceed: false, result: resolved.result };
        }
        selectedPath = resolved.filePath;
      }
      return {
        proceed: true,
        filePlan: {
          version: 1,
          allocation: 'eager',
          inputs: [{
            filePath: selectedPath,
            role: 'input',
            sourceOperation: 'template:import'
          }],
          outputs: []
        }
      };
    },
    async execute(event, prepared, taskContext, options = {}) {
      const selectedPath = taskContext.fileEvidence.filePlan.inputs[0].filePath;
      const childChannelId = Number(options && options.channelId || 0);
      if (childChannelId) {
        return importStatementChildTemplate(childChannelId, selectedPath);
      }
      return importOrdinaryTemplate(event, options, selectedPath);
    }
  });

  trackedIpcHandle('template:delete', '生成网银账单', '模板管理', (_event, templateId) => {
    const template = database.getTemplate(templateId);
    database.deleteTemplate(templateId);
    syncTemplateLibraryFile();
    clearGeneratedExports();
    clearPendingManualBalancePrompt();
    clearPendingBigAccountSelection();
    // v3.2.19：待确认的重复账单复核引用删除前的模板配置，一并作废（确认时提示重新导入）
    statementDuplicateReview.clear();
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
        preprocessFields: mappingConfig.preprocessFields,
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
        currencyBigAccounts: mappingConfig.currencyBigAccounts,
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

      // v3.2.21：模板日期格式随映射【保存】提交；未传时保持原值（其他调用方），取值不在 auto / DMY / MDY 内时拒绝
      const dateFormat = payload.dateFormat === undefined || payload.dateFormat === null
        ? undefined
        : normalizeTemplateDateFormat(payload.dateFormat);
      if (dateFormat === '') {
        // 模板名由用户填写、可能以账号命名：错误报告（含文件名）、上下文与活动日志按模板维护的账号与数字写法脱敏（release 审查）
        return createErrorResult({
          step: '保存模板映射',
          message: '日期格式无效，请重新选择',
          errorCode: 'TEMPLATE_DATE_FORMAT_INVALID',
          context: { templateId: payload.templateId, templateName: template.name },
          templateName: template.name,
          persistedDetailLines: [],
          logMaskValues: readTemplateAccountValuesForLog(template)
        });
      }
      // 库内旧值：空按 auto；三档以外的旧值原样保留，用于比较与留痕（改为合法值时也记录）
      const previousDateFormat = normalizeCell(template.dateFormat) || 'auto';
      // 保存前模板维护的账号：同次保存移除的账号仍可能出现在模板名或旧值中，留痕时与保存后的一并用于脱敏（release 审查）
      const previousTemplateAccountValues = readTemplateAccountValuesForLog(template);

      const templateConfiguration = validateTemplateConfiguration({
        template,
        mappings: payload.mappings,
        enumValues: loadEnumValues(enumConfig.filePath),
        bigAccounts: payload.bigAccounts,
        fixedAssignments: payload.fixedAssignments,
        // v3.2.18：特征值由【特征值管理】即时保存，这里按库中列表校验所选特征值；不复用的拆分映射一并校验
        featureFilters: template.featureFilters,
        billSplitMappings: database.getBillSplitMappings(payload.templateId),
        currencyBigAccounts: payload.currencyBigAccounts,
        availableCurrencyCodes: getAvailableCurrencyCodes().map((option) => option.code)
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

      // v3.2.19：过滤规则随映射【保存】一起落库；勾选「根据字段值过滤账单」（且开启拆分）时须至少一条有效规则，
      //   字段须在模板表头中。未生效时只规范化保存（保留草稿，开启时再校验）；未传时按已存规则校验、保持原值。
      let billSplitRowFilterRules = null;
      if (Array.isArray(payload.billSplitRowFilterRules)) {
        billSplitRowFilterRules = templateConfiguration.usesBillSplitRowFilter
          ? validateBillSplitRowFilterRules(payload.billSplitRowFilterRules, template.headers)
          : normalizeBillSplitRowFilterRules(payload.billSplitRowFilterRules);
      } else if (templateConfiguration.usesBillSplitRowFilter) {
        validateBillSplitRowFilterRules((database.getBillSplitMeta(payload.templateId) || {}).rowFilterRules, template.headers);
      }
      // v3.2.19：原始账单预处理「过滤账单」的过滤规则同口径：勾选时须至少一条有效规则且字段（含比较字段）在模板表头中。
      const preprocessRuleOptions = { missingMessage: PREPROCESS_ROW_FILTER_MISSING_MESSAGE };
      let preprocessRowFilterRules = null;
      if (Array.isArray(payload.preprocessRowFilterRules)) {
        preprocessRowFilterRules = templateConfiguration.usesPreprocessRowFilter
          ? validateRowFilterRules(payload.preprocessRowFilterRules, template.headers, preprocessRuleOptions)
          : normalizeRowFilterRules(payload.preprocessRowFilterRules);
      } else if (templateConfiguration.usesPreprocessRowFilter) {
        validateRowFilterRules(template.preprocessRowFilterRules, template.headers, preprocessRuleOptions);
      }

      // v1.5.3 R2 round 3 (Codex Finding 5)：透传 preserveOwn
      // 默认 false（向后兼容旧行为：DELETE all + INSERT all，caller 接管 own 全集）
      // 仅当前端显式传 preserveOwn=true（即维护大账号没被打开过 → bigAccountsLoadedWithOwn=false → currentBigAccounts 是 client-only）才走 DELETE-client-only 保留 own 路径
      const preserveOwn = payload.preserveOwn === true;
      // v3.2.15（§4.2、T6）：渠道归属随映射一起提交；缺省为不改归属。
      //   v3.2.21（D1）：渠道内各子模板的余额方式可以不同，保存时不再比较。
      const channelAssignment = normalizeTemplateChannelAssignment(payload.channel);
      const saveResult = database.saveMappings(
        payload.templateId,
        templateConfiguration.mappings,
        templateConfiguration.bigAccounts,
        templateConfiguration.fixedAssignments,
        dateFormat,
        null,
        {
          preserveOwn,
          channelAssignment,
          currencyBigAccounts: templateConfiguration.currencyBigAccounts,
          billSplitRowFilterRules,
          preprocessRowFilterRules
        }
      );
      // v3.2.21：日期格式决定交易归属日，变化时在落库后立即留痕——不受随后模板库文件同步失败影响
      //   （同步失败时界面提示保存失败，但库内已是新值；重试时旧值已等于新值，不会再记）
      // 模板名由用户填写、可能以账号命名：本次保存的两条日志都只写编号位数；模板维护的账号（本次提交的，与只提交客户账号时
      //   库里保留的自有账号）原样出现时整体替换（release 审查）
      const templateAccountValues = collectTemplateAccountValuesForLog(templateConfiguration)
        .concat(previousTemplateAccountValues, readTemplateAccountValuesForLog(database.getTemplate(payload.templateId)));
      const loggedTemplateName = maskAccountLikeTextForLog(template.name, templateAccountValues);
      if (dateFormat && dateFormat !== previousDateFormat) {
        appendActivityLogEntry({
          level: 'info',
          message: '模板日期格式已修改',
          details: [
            `模板名：${loggedTemplateName}`,
            `日期格式：${formatTemplateDateFormatLabel(previousDateFormat, templateAccountValues)} → ${formatTemplateDateFormatLabel(dateFormat, templateAccountValues)}`
          ]
        });
      }
      const assignmentResult = saveResult && saveResult.channelAssignment;
      syncTemplateLibraryFile();
      clearLastErrorReport();
      const savedTemplate = database.getTemplate(payload.templateId);
      appendActivityLogEntry({
        level: 'info',
        message: '保存模板映射成功',
        details: [
          `模板名：${loggedTemplateName}`,
          ...(assignmentResult && assignmentResult.changed
            ? [`渠道：${savedTemplate && savedTemplate.channelName ? maskAccountLikeTextForLog(savedTemplate.channelName, templateAccountValues) : '（不属于任何渠道）'}`]
            : [])
        ]
      });
      return {
        status: 'success',
        message: assignmentResult && assignmentResult.createdChannel
          ? `模板映射保存成功，已新建渠道「${assignmentResult.createdChannel.name}」`
          : '模板映射保存成功',
        template: savedTemplate ? buildTemplateSummary(savedTemplate) : null
      };
    } catch (error) {
      if (error && STATEMENT_CHANNEL_BUSINESS_ERROR_CODES.has(error.code)) {
        return createStatementChannelErrorResult('保存模板映射', error, {
          templateId: payload.templateId,
          templateName: template?.name || ''
        });
      }
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

      // v3.2.15：普通模板按模板名输出，不能与渠道同名（属于渠道的子模板按渠道名输出，不受限）。
      if (!template.channelId && database.getStatementChannelByName(nextName)) {
        return createErrorResult({
          step: '重命名模板',
          message: `已有同名渠道「${nextName}」，普通模板与渠道同名会使两者的输出名称相同，请换一个名称`,
          errorCode: 'TEMPLATE_NAME_CHANNEL_CONFLICT',
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

  // v3.2.18 模板管理【更新】：选择新模板文件并预览字段变更（只读预检，确认后走 template:update-headers 写入）。
  ipcMain.handle('template:preview-header-update', async (_event, rawTemplateId) => {
    const templateId = Number(rawTemplateId);
    if (!database.getTemplate(templateId)) {
      return createErrorResult({
        step: '更新模板',
        message: '未找到对应模板，请刷新后重试',
        errorCode: 'TEMPLATE_NOT_FOUND',
        context: { templateId }
      });
    }
    const choice = await showImportOpenDialog('template', {
      properties: ['openFile'],
      filters: templateFileDialogFilters()
    });
    const selectedPath = !choice.canceled && Array.isArray(choice.filePaths) ? choice.filePaths[0] : '';
    if (!selectedPath) {
      return { status: 'cancelled' };
    }
    try {
      return prepareTemplateHeaderUpdate({ templateId, filePath: selectedPath });
    } catch (error) {
      if (error instanceof FileValidationError) {
        return createErrorResult({
          step: '更新模板',
          message: error.message,
          errorCode: error.code,
          detailLines: ['模板文件无法读取或表头无效，未更新模板。'],
          context: { templateId, selectedPath }
        });
      }
      return createErrorResult({
        step: '更新模板',
        message: '读取模板文件失败，请导出报错文件查看详情',
        errorCode: 'TEMPLATE_HEADER_UPDATE_PREVIEW_RUNTIME',
        errorType: '系统错误',
        originalError: error,
        context: { templateId, selectedPath }
      });
    }
  });

  // v3.2.18 模板管理【更新】：确认后只替换表头（仅主库写入，不产生文件）。
  supportIpcHandle('template:update-headers', '更新模板表头', (_event, payload = {}) => {
    try {
      return applyTemplateHeaderUpdate(payload || {});
    } catch (error) {
      return createErrorResult({
        step: '更新模板',
        message: '模板更新失败，请导出报错文件查看详情',
        errorCode: 'TEMPLATE_HEADER_UPDATE_RUNTIME',
        errorType: '系统错误',
        originalError: error,
        context: { templateId: Number(payload && payload.templateId) }
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
        filePlan: {
          version: 1,
          allocation: 'eager',
          inputs: [],
          outputs: [{
            filePath: saveResult.filePath,
            role: 'output',
            sourceOperation: 'template:export-bundle'
          }]
        }
      };
    },
    async execute(_event, prepared, taskContext) {
    try {
      const outputPath = taskContext.fileEvidence.filePlan.outputs[0].filePath;
      writeTemplateBundleFile(outputPath);
      await taskContext.settleArtifacts({
        files: taskContext.fileEvidence.filePlan.outputs
          .map((item) => ({ artifactKey: item.artifactKey }))
      });
      clearLastErrorReport();
      appendActivityLogEntry({
        level: 'info',
        message: '导出模板文件成功',
        details: [`导出路径：${outputPath}`]
      });
      return {
        status: 'success',
        message: '模板文件导出成功',
        filePath: outputPath
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
        const importedBundle = readTemplateBundleFile(selectedPath);
        const importedTemplates = importedBundle.templates;
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
          enumValues,
          importedTemplates,
          importedBundleVersion: importedBundle.bundleVersion,
          importedChannels: importedBundle.channels,
          filePlan: {
            version: 1,
            allocation: 'eager',
            inputs: [{
              filePath: selectedPath,
              role: 'input',
              sourceOperation: 'template:import-bundle'
            }],
            outputs: []
          },
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
    async execute(_event, prepared, taskContext) {
    const { enumValues, importedTemplates } = prepared;
    const importedBundleVersion = Number(prepared.importedBundleVersion || 1);
    const importedChannels = Array.isArray(prepared.importedChannels) ? prepared.importedChannels : [];
    const selectedPath = taskContext.fileEvidence.filePlan.inputs[0].filePath;
    try {
      let createdCount = 0;
      let updatedCount = 0;
      let skippedCount = 0;
      // v3.2.15（PR #246 审查）：只有第一轮成功导入的条目进入后两轮（账户映射、渠道归属）；
      //   被跳过的模板保留原有映射与归属，不按包内容改写。
      const succeededEntries = new Set();

      // v3.2.16：校验「原始账单仅有币种无账户号」的币种用（只读一次币种映射表）
      const bundleCurrencyCodes = getAvailableCurrencyCodes().map((option) => option.code);
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

          const draftTemplate = buildBundleImportDraftTemplate(entry, existingTemplate);
          // v3.2.18：包内特征值只校验名称与条件（保留包内 id），不按表头校验筛选字段：模板【更新】后未被选用的
          //   特征值可能引用已删除的字段，不应让整条模板被跳过；生效映射所选特征值由 validateTemplateConfiguration
          //   按表头校验，随映射同事务写入。
          // v3.2.21：包内映射引用的 id 不分配给未带 id 的特征值（引用了包内不存在的特征值时照常按「特征值不存在」拒绝）
          const bundleFeatureFilters = normalizeFeatureFilterList(entry.featureFilters || [], {
            reservedIds: collectReferencedFeatureFilterIds(entry.mappings, entry.billSplitMappings)
          });
          const validated = validateTemplateConfiguration({
            template: draftTemplate,
            mappings: normalizeMappingRows({
              template: draftTemplate,
              mappings: entry.mappings,
              enumValues
            }),
            enumValues,
            bigAccounts: entry.bigAccounts,
            fixedAssignments: entry.fixedAssignments,
            featureFilters: bundleFeatureFilters,
            billSplitMappings: entry.billSplitMappings,
            currencyBigAccounts: entry.currencyBigAccounts,
            availableCurrencyCodes: bundleCurrencyCodes,
            // v3.2.21：v8 及更早的包不可能含特征值候补，形如特征值候补的值按旧语义是源列名
            allowLogicValueFeatureCandidates: importedBundleVersion >= LOGIC_VALUE_FEATURE_BUNDLE_VERSION
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
            // v3.2.21：包内日期格式不在 auto / DMY / MDY 内时按 auto（各版本对这类值本就按 auto 解析）
            normalizeTemplateDateFormat(entry.dateFormat) || 'auto',
            normalizedAmountSplitRules,
            {
              preserveOwn: false,
              featureFilters: bundleFeatureFilters,
              currencyBigAccounts: validated.currencyBigAccounts,
              preprocessRowFilterRules: Array.isArray(entry.preprocessRowFilterRules) ? entry.preprocessRowFilterRules : []
            }
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

          applyBundleBillSplitConfig(template.id, entry);

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
          succeededEntries.add(entry);
        } catch (error) {
          if (error instanceof FileValidationError) {
            skippedCount += 1;
            // v3.2.21：记下跳过的模板与原因（如旧版本模板包里失效的逻辑取值候补），导入结果只给出跳过数量。
            //   模板名（用户填写）与原因中的账号等编号不写进日志：条目里的大账号原样出现时整体替换（不论写法），其余长数字只写位数（release 审查）
            const entryAccountValues = collectTemplateAccountValuesForLog(entry);
            appendActivityLogEntry({
              level: 'warning',
              message: '模板包导入时跳过模板',
              details: [
                `模板名：${maskAccountLikeTextForLog(entry.name, entryAccountValues)}`,
                `原因：${maskAccountLikeTextForLog(error.message, entryAccountValues)}`
              ]
            });
            return;
          }

          throw error;
        }
      });

      const { channelRestore, restoreResult } = restoreBundleFollowUpRounds({
        importedTemplates, succeededEntries, importedBundleVersion, importedChannels
      });
      const restoredChannelNames = new Set(channelRestore.channels.map((channel) => channel.name));
      const unrestoredChannelNames = importedChannels.map((channel) => channel.name).filter((name) => !restoredChannelNames.has(name));

      syncTemplateLibraryFile();
      clearLastErrorReport();
      appendActivityLogEntry({
        level: 'info',
        message: '导入模板包成功',
        details: [
          `源文件：${selectedPath}`,
          `模板包版本：${importedBundleVersion}`,
          `新增：${createdCount}`,
          `更新：${updatedCount}`,
          `跳过：${skippedCount}`,
          `渠道：${restoreResult.channelCount}`,
          ...(unrestoredChannelNames.length ? [`未还原的渠道（包内归入的模板均被跳过，原有映射与冲突不变）：${unrestoredChannelNames.join('、')}`] : []),
          ...(channelRestore.orphanedTemplateNames && channelRestore.orphanedTemplateNames.length
            ? [`父模板在包内被跳过、按普通模板导入的子模板：${channelRestore.orphanedTemplateNames.join('、')}`]
            : []),
          ...(channelRestore.regroupedTemplateNames && channelRestore.regroupedTemplateNames.length
            ? [`父模板在包内被跳过、仍归入渠道的模板：${channelRestore.regroupedTemplateNames.join('、')}`]
            : []),
          ...(restoreResult.conflictCount > 0 ? [`待处理的渠道账户映射冲突：${restoreResult.conflictCount} 个账户号`] : [])
        ]
      });
      const followUps = [];
      if (restoreResult.conflictCount > 0) followUps.push(`有 ${restoreResult.conflictCount} 个渠道账户号的映射设置不一致，请在「账户映射」中处理`);
      return {
        status: 'success',
        message: `模板文件导入成功：新增${createdCount}，更新${updatedCount}，跳过${skippedCount}${followUps.length ? `。${followUps.join('；')}` : ''}`
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

  ipcMain.handle('template:get-bill-split-config', (event, templateId, options = {}) => {
    templateId = Number(templateId);
    const restoreOptions = options && typeof options === 'object' ? options : {};
    const restoreOwner = event && event.sender;
    // v3.2.21：行管理窗口释放时带本窗口的恢复令牌结束撤销会话（只结束该令牌所属的会话，旧窗口迟到的释放不影响新窗口），
    //   不读取配置；放在读取模板之前，读取失败也不会让会话残留。
    if (Object.prototype.hasOwnProperty.call(restoreOptions, 'endRestoreSession')) {
      endBillSplitRestoreSession(templateId, restoreOptions.endRestoreSession);
      return { status: 'success', restoreSessionEnded: true };
    }
    // v3.2.21：行管理窗口挂载时激活本窗口的撤销会话，作废同模板的其他会话（被取代窗口的【返回】随之失效，
    //   不能把其他窗口已确认的修改撤销掉）；未挂载的乱序打开请求不激活，不影响当前窗口。不读取配置。
    if (Object.prototype.hasOwnProperty.call(restoreOptions, 'activateRestoreSession')) {
      return { status: 'success', restoreSessionActivated: activateBillSplitRestoreSession(templateId, restoreOptions.activateRestoreSession) };
    }
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
      // v3.2.21：行管理打开时开启独立的撤销会话并签发恢复令牌（不取代其他会话）；窗口释放时结束会话（见上），旧令牌随之失效。
      //   读出的配置不满足快照结构时不签发，行管理不打开。其他读取不签发、不影响会话。
      let restoreToken = null;
      if (restoreOptions.openRestoreSession === true) {
        trackBillSplitRestoreOwner(restoreOwner);
        restoreToken = issueBillSplitRestoreToken(template, { billSplitRows, billSplitAmountRules, billSplitMeta }, restoreOwner && restoreOwner.id);
      }
      return {
        status: 'success',
        enabled,
        reuseModule,
        billSplitMappings,
        billSplitRows,
        billSplitAmountRules,
        billSplitMeta,
        restoreToken
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
      // v3.2.18：选「字段筛选特征值」的字段须选了库中存在的特征值（特征值由【特征值管理】即时保存）
      resolveUsedFeatureFilters(template.featureFilters, collectFeatureFilterRefs(validated), { headers: template.headers });
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

  // v3.2.18 映射关系管理【特征值管理】：保存、删除特征值即时落库（spec D7）。整表替换；
  //   已保存的主映射 / 拆分映射仍在使用的特征值不能被删掉（spec D5）。
  supportIpcHandle('template:save-feature-filters', '保存特征值', (_event, payload = {}) => {
    const templateId = Number(payload?.templateId);
    let template = null;
    try {
      template = database.getTemplate(templateId);
      if (!template) {
        return createErrorResult({
          step: '保存特征值',
          message: '未找到对应模板',
          errorCode: 'TEMPLATE_NOT_FOUND',
          context: { templateId }
        });
      }
      const featureFilters = validateFeatureFiltersPayload(payload.featureFilters, template);
      database.saveTemplateFeatureFilters(templateId, featureFilters);
      syncTemplateLibraryFile();
      return { status: 'success', message: '特征值已保存', featureFilters };
    } catch (error) {
      if (error instanceof FileValidationError) {
        return createErrorResult({
          step: '保存特征值',
          message: error.message,
          errorCode: error.code,
          originalError: error,
          context: { templateId, templateName: template?.name || '' },
          templateName: template?.name || ''
        });
      }
      return createErrorResult({
        step: '保存特征值',
        message: '特征值保存失败，请导出报错文件查看详情',
        errorCode: 'FEATURE_FILTERS_SAVE_RUNTIME',
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
      // v3.2.19：费用账单行不读 Credit（启用特殊取值时也不读 Debit），同列校验只比实际生效的映射
      const storedRow = (database.getBillSplitRows(templateId) || [])
        .find((row) => row.seqNo === Number(payload?.row?.seqNo));
      const isFeeBillRow = Boolean(storedRow && storedRow.isFeeBill);
      validateBillSplitRowPayload(payload?.row, {
        creditIgnored: isFeeBillRow,
        debitIgnored: isFeeBillRow && Boolean((database.getBillSplitMeta(templateId) || {}).feeAmountFormulaEnabled)
      });
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
          '发生额取值设置中的"按正负号取发生额"和"按字段取发生额"只能启用其中一种'
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

  // v3.2.19：载荷只带本次要改的部分，未带的保持原值——
  //   正负号字段与指定账单序号（三项一起）、费用账单行 feeBillSeqNo（null 为取消）、
  //   费用账单特殊取值 feeAmountFormulaEnabled / feeAmountFormula（公式按模板表头校验）。
  // v3.2.21：费用账单「字段映射特殊处理」feeFieldMappingEnabled / feeFieldMappings（按模板表头与可选模板字段校验）；
  //   restoreSnapshot + restoreToken：拆分/合并账单映射关系管理【返回】/ × 撤销本次修改，单独提交，其余字段忽略
  //   （复用本通道，不另增 IPC：恢复的正是本通道与同组拆分通道写入的配置）。
  businessIpcHandle('template:save-bill-split-meta', '保存账单拆分配置', (event, payload = {}) => {
    const templateId = Number(payload?.templateId);
    const has = (key) => Boolean(payload) && Object.prototype.hasOwnProperty.call(payload, key) && payload[key] !== undefined;
    const savesSignedConfig = has('signedAmountSourceField')
      || has('signedAmountTargetSeqNos')
      || has('byFieldAmountTargetSeqNos');
    const restoresSnapshot = has('restoreSnapshot');
    const step = restoresSnapshot
      ? '撤销拆分账单修改'
      : savesSignedConfig ? '保存拆分账单按正负号拆分字段' : '保存拆分账单费用账单设置';
    try {
      if (restoresSnapshot) {
        return restoreBillSplitConfigFromPayload(templateId, payload, step, event && event.sender && event.sender.id);
      }
      const meta = {};
      if (savesSignedConfig) {
        const signedAmountSourceField = normalizeCell(payload.signedAmountSourceField);
        const existingRules = database.getBillSplitAmountRules(templateId) || [];
        if (signedAmountSourceField && existingRules.length > 0) {
          throw new FileValidationError(
            'FILE_READ',
            '发生额取值设置中的"按正负号取发生额"和"按字段取发生额"只能启用其中一种'
          );
        }
        Object.assign(meta, {
          signedAmountSourceField,
          signedAmountTargetSeqNos: payload.signedAmountTargetSeqNos || [],
          byFieldAmountTargetSeqNos: payload.byFieldAmountTargetSeqNos || []
        });
      }
      if (has('feeAmountFormula')) {
        const template = database.getTemplate(templateId);
        if (!template) {
          throw new FileValidationError('TEMPLATE_NOT_FOUND', '未找到对应模板');
        }
        meta.feeAmountFormula = validateFeeAmountFormula(payload.feeAmountFormula, template.headers);
      }
      if (has('feeAmountFormulaEnabled')) {
        meta.feeAmountFormulaEnabled = payload.feeAmountFormulaEnabled === true;
      }
      if (has('feeFieldMappings')) {
        const template = database.getTemplate(templateId);
        if (!template) {
          throw new FileValidationError('TEMPLATE_NOT_FOUND', '未找到对应模板');
        }
        meta.feeFieldMappings = validateFeeFieldMappings(payload.feeFieldMappings, {
          headers: template.headers,
          allowedTemplateFields: getFeeFieldMappingTemplateFields()
        });
      }
      if (has('feeFieldMappingEnabled')) {
        meta.feeFieldMappingEnabled = payload.feeFieldMappingEnabled === true;
      }
      let feeBillSeqNo;
      if (has('feeBillSeqNo')) {
        feeBillSeqNo = payload.feeBillSeqNo === null ? null : Number(payload.feeBillSeqNo);
        if (feeBillSeqNo !== null && (!Number.isInteger(feeBillSeqNo) || feeBillSeqNo < 1)) {
          throw new FileValidationError('FILE_READ', '费用账单的账单序号无效');
        }
        try {
          database.setBillSplitFeeBillRow(templateId, feeBillSeqNo);
        } catch (error) {
          if (error && error.code === 'BILL_SPLIT_ROW_NOT_FOUND') {
            throw new FileValidationError('FILE_READ', `${error.message}，请关闭后重新打开再设置`);
          }
          throw error;
        }
      }
      if (Object.keys(meta).length > 0) {
        database.saveBillSplitMeta(templateId, meta);
      }
      const saved = feeBillSeqNo === undefined
        ? { status: 'success' }
        : { status: 'success', currentRows: database.getBillSplitRows(templateId) || [] };
      // v3.2.21：主库已提交后模板库文件同步失败：按已保存返回并单独提示（本次设置已生效），不再报「保存失败」
      if (!syncTemplateLibraryAfterBillSplitWrite(database.getTemplate(templateId), '保存拆分账单配置后同步模板库文件失败')) {
        return { ...saved, librarySyncFailed: true, message: '已保存，本次设置已生效；模板库文件同步失败，下次启动或修改模板时会重新同步' };
      }
      return saved;
    } catch (error) {
      if (error instanceof FileValidationError) {
        return createErrorResult({
          step,
          message: error.message,
          errorCode: error.code,
          originalError: error,
          context: { templateId }
        });
      }
      return createErrorResult({
        step,
        message: `${step}失败，请导出报错文件查看详情`,
        errorCode: 'BILL_SPLIT_META_SAVE_RUNTIME',
        errorType: '系统错误',
        originalError: error,
        context: { templateId }
      });
    }
  });
}

// v3.2.21：字段映射特殊处理可选的模板字段——同「拆分/合并账单映射关系设置」（映射目标字段，不含 Channel 与预处理 / 高级 / 拆分分组
//   控制项；枚举里恰有与控制项同名的字段时同样排除，与渲染端 buildFeeFieldMappingTemplateFields 一致）；
//   账户号、币种、发生额、余额由 validateFeeFieldMappings 排除。保存与生成共用。
function filterFeeFieldMappingTemplateFields(fields) {
  const controlFields = new Set([...PREPROCESS_FIELDS, ...ADVANCED_MAPPING_FIELDS, ...BILL_SPLIT_GROUP_FIELDS]);
  return (Array.isArray(fields) ? fields : []).filter((field) => field !== 'Channel' && !controlFields.has(field));
}

function getFeeFieldMappingTemplateFields() {
  const enumConfig = getEnumConfig();
  if (!enumConfig) {
    throw new FileValidationError('FILE_READ', MISSING_ENUM_MESSAGE);
  }
  return filterFeeFieldMappingTemplateFields(buildMappingTargetFields(loadEnumValues(enumConfig.filePath)));
}

// v3.2.21：【返回】/ × 只能恢复主进程签发的快照：template:get-bill-split-config 读出配置时按本进程随机密钥对
//   规范化后的快照签名（restoreToken），恢复时重新规范化并核对签名。快照因此只能是本次运行中确实读出过的已保存状态
//   （打开弹窗时的配置），渲染进程无法改写或拼接成正常保存入口不允许的配置；应用重启后旧令牌失效。
const BILL_SPLIT_RESTORE_TOKEN_SECRET = randomBytes(32);
// 行管理撤销会话（templateId → Map(sessionId → { token, ownerId, activated })）：每次打开签发独立会话，签发时不取代同模板的其他会话——
//   打开请求可能因低内存屏障乱序执行，迟到的旧请求不能让当前窗口的令牌失效；窗口挂载时激活本会话并作废其他会话
//   （activateBillSplitRestoreSession），同一模板同一时间只有一个窗口能撤销。会话在窗口释放、放弃打开（按令牌）、
//   签发页面销毁或渲染进程退出时结束；令牌绑定会话 id，已结束会话的令牌即使快照与代次都对也不再被接受。
//   ownerId 为签发时的 webContents id：只接受同一渲染页面的恢复请求，该页面销毁或渲染进程退出（崩溃、被终止）时
//   由主进程清理其会话（渲染层来不及在 onDispose 中结束）。每个模板最多保留若干会话，防止释放失败时累积；
//   超出时先淘汰最早签发的未激活会话，当前窗口已激活的会话不被淘汰。
const BILL_SPLIT_RESTORE_SESSIONS = new Map();
const BILL_SPLIT_RESTORE_OWNERS = new WeakSet();
const BILL_SPLIT_RESTORE_SESSION_LIMIT = 8;

function endBillSplitRestoreSessionsForOwner(ownerId) {
  for (const [templateId, sessions] of BILL_SPLIT_RESTORE_SESSIONS) {
    for (const [sessionId, session] of sessions) {
      if (session.ownerId === ownerId) sessions.delete(sessionId);
    }
    if (!sessions.size) BILL_SPLIT_RESTORE_SESSIONS.delete(templateId);
  }
}

function findBillSplitRestoreSessionId(templateId, restoreToken) {
  const sessions = BILL_SPLIT_RESTORE_SESSIONS.get(Number(templateId));
  if (!sessions || typeof restoreToken !== 'string' || !restoreToken) return '';
  for (const [sessionId, session] of sessions) {
    if (session.token === restoreToken) return sessionId;
  }
  return '';
}

function trackBillSplitRestoreOwner(owner) {
  if (!owner || typeof owner.once !== 'function' || BILL_SPLIT_RESTORE_OWNERS.has(owner)) return;
  BILL_SPLIT_RESTORE_OWNERS.add(owner);
  const ownerId = owner.id;
  const release = () => endBillSplitRestoreSessionsForOwner(ownerId);
  owner.once('destroyed', release);
  owner.on('render-process-gone', release);
}

// 前提：应用单实例、单窗口，弹窗栈同一时间只有一个行管理窗口；拆分写入不带会话身份，支持多窗口前须让写入校验活动会话（backlog B115）。
// 激活 restoreToken 所属的会话：同一模板同一时间只有最后挂载的行管理窗口可以撤销，其余会话全部作废。
//   拆分写入不改模板代次、也不带会话身份，交叠的两个会话都能通过签名核对；作废被取代的会话，避免先打开的窗口
//   撤销时把后打开窗口已确认的修改（如新增的拆分行、发生额规则）一起覆盖掉。
function activateBillSplitRestoreSession(templateId, restoreToken) {
  const sessionId = findBillSplitRestoreSessionId(templateId, restoreToken);
  if (!sessionId) return false;
  const sessions = BILL_SPLIT_RESTORE_SESSIONS.get(Number(templateId));
  for (const id of [...sessions.keys()]) {
    if (id !== sessionId) sessions.delete(id);
  }
  sessions.get(sessionId).activated = true;
  return true;
}

// 只结束 restoreToken 所属的会话，同模板其他窗口（或其他打开请求）的会话不受影响。
function endBillSplitRestoreSession(templateId, restoreToken) {
  const sessionId = findBillSplitRestoreSessionId(templateId, restoreToken);
  if (!sessionId) return;
  const sessions = BILL_SPLIT_RESTORE_SESSIONS.get(Number(templateId));
  sessions.delete(sessionId);
  if (!sessions.size) BILL_SPLIT_RESTORE_SESSIONS.delete(Number(templateId));
}

// 令牌同时绑定模板代次（templates.updated_at）：本弹窗内的拆分写入不改它，模板包覆盖导入、更新表头、改名、
//   保存映射等替换或改动模板的操作会改它，之后打开前签发的令牌即失效，旧快照不能写回新配置。
function buildBillSplitRestoreToken(normalizedSnapshot, templateUpdatedAt, sessionId) {
  return createHmac('sha256', BILL_SPLIT_RESTORE_TOKEN_SECRET)
    .update(JSON.stringify({ sessionId: String(sessionId || ''), templateUpdatedAt: String(templateUpdatedAt || ''), snapshot: normalizedSnapshot }))
    .digest('hex');
}

// 【返回】/ × 撤销：先核对令牌（快照、模板代次、令牌所属的撤销会话及其签发页面），通过后才在一个事务内恢复并同步模板库文件。令牌失效不能靠重试解决：结果带错误码，
//   界面据此暂停本窗口的配置写入（createErrorResult 不回传错误码）。结构无效抛 FileValidationError，由调用方转成错误结果。
function restoreBillSplitConfigFromPayload(templateId, payload, step, ownerId) {
  const template = database.getTemplate(templateId);
  if (!template) {
    throw new FileValidationError('TEMPLATE_NOT_FOUND', '未找到对应模板');
  }
  const snapshot = normalizeBillSplitRestoreSnapshot(payload && payload.restoreSnapshot, templateId);
  const matchedSessionId = findBillSplitRestoreSessionId(templateId, payload && payload.restoreToken);
  const session = matchedSessionId ? BILL_SPLIT_RESTORE_SESSIONS.get(Number(templateId)).get(matchedSessionId) : null;
  // 只接受已激活（行管理窗口已挂载）的会话：迟到的打开请求签发的会话即使属于同一页面也不能撤销，
  //   否则未挂载的旧快照会覆盖当前窗口之后保存的拆分行或费用规则（拆分写入不改模板代次，签名无法区分）
  const sessionId = session && session.ownerId === ownerId && session.activated === true ? matchedSessionId : '';
  if (!sessionId || typeof (payload && payload.restoreToken) !== 'string'
    || payload.restoreToken !== buildBillSplitRestoreToken(snapshot, template.updatedAt, sessionId)) {
    return {
      ...createErrorResult({
        step,
        message: '撤销修改失败：打开时记下的配置无法核对（模板可能已被替换或修改），请关闭后重新打开确认当前配置',
        errorCode: 'BILL_SPLIT_RESTORE_TOKEN_STALE',
        context: { templateId }
      }),
      errorCode: 'BILL_SPLIT_RESTORE_TOKEN_STALE'
    };
  }
  database.restoreBillSplitEditableConfig(templateId, snapshot);
  // 主库已恢复：之后的模板库文件同步失败不影响撤销结果（启动和下次修改模板时会重新同步），单独提示，不再重复撤销。
  if (!syncTemplateLibraryAfterBillSplitWrite(template, '撤销拆分账单修改后同步模板库文件失败')) {
    return {
      status: 'success',
      restored: true,
      librarySyncFailed: true,
      message: '已撤销本次修改；模板库文件同步失败，下次启动或修改模板时会重新同步'
    };
  }
  return { status: 'success', restored: true };
}

// v3.2.21：拆分配置已提交到主库后同步模板库文件。失败时记 warning 活动日志并返回 false，由调用方按「已保存 / 已撤销，
//   文件未同步」单独提示（启动与下次修改模板时会重新同步），不把已生效的修改报成失败。
function syncTemplateLibraryAfterBillSplitWrite(template, logMessage) {
  try {
    syncTemplateLibraryFile();
    return true;
  } catch (error) {
    appendActivityLogEntry({
      level: 'warning',
      message: logMessage,
      // 模板名由用户填写、可能以账号命名；原因可能含模板名或路径：模板维护的账号整体只写位数、其余编号只写位数，
      //   另记模板 ID 供定位（release 审查）
      details: (() => {
        const accountValues = readTemplateAccountValuesForLog(template);
        return [
          `模板 ID：${template ? template.id : ''}`,
          `模板名：${template ? maskAccountLikeTextForLog(template.name, accountValues) : ''}`,
          `原因：${maskAccountLikeTextForLog(error && error.message ? error.message : String(error), accountValues)}`
        ];
      })()
    });
    return false;
  }
}

// 读取拆分配置时签发恢复令牌；读出的配置不满足快照结构时不签发（返回 null，行管理不打开）。
function issueBillSplitRestoreToken(template, { billSplitRows, billSplitAmountRules, billSplitMeta }, ownerId) {
  let snapshot;
  try {
    snapshot = normalizeBillSplitRestoreSnapshot({
      templateId: template.id, billSplitRows, billSplitAmountRules, billSplitMeta
    }, template.id);
  } catch (_error) {
    return null;
  }
  const sessionId = randomUUID();
  const token = buildBillSplitRestoreToken(snapshot, template.updatedAt, sessionId);
  const templateKey = Number(template.id);
  const sessions = BILL_SPLIT_RESTORE_SESSIONS.get(templateKey) || new Map();
  sessions.set(sessionId, { token, ownerId, activated: false });
  // 超出上限时丢弃最早签发的未激活会话（Map 按插入顺序迭代）：已激活的是当前挂载窗口的撤销点，
  //   不能被迟到的旧打开请求挤掉；激活时其他会话已作废，同一模板最多一个已激活会话。
  while (sessions.size > BILL_SPLIT_RESTORE_SESSION_LIMIT) {
    const evicted = [...sessions.entries()].find(([, session]) => !session.activated);
    sessions.delete(evicted ? evicted[0] : sessions.keys().next().value);
  }
  BILL_SPLIT_RESTORE_SESSIONS.set(templateKey, sessions);
  return token;
}

// 恢复快照的结构规范化（签名与核对共用同一形状，保证确定性）：快照须属于本模板，序号须为 1..n 连续、费用账单最多一行、
//   合并组序号须指向不大于本行的已有行。业务约束不在这里重复校验——签名保证快照就是读出过的已保存状态，
//   含打开时已失效（标为失效）的引用与旧版本留下的配置，都照原样恢复。不合格时整体拒绝，不做部分恢复。
function normalizeBillSplitRestoreSnapshot(snapshot, templateId) {
  const invalid = () => new FileValidationError('FILE_READ', '撤销修改失败：打开时记下的配置无效，请关闭后重新打开确认');
  if (!snapshot || typeof snapshot !== 'object' || Number(snapshot.templateId) !== Number(templateId)
    || !Array.isArray(snapshot.billSplitRows) || !Array.isArray(snapshot.billSplitAmountRules)
    || !snapshot.billSplitMeta || typeof snapshot.billSplitMeta !== 'object' || Array.isArray(snapshot.billSplitMeta)) {
    throw invalid();
  }
  const rows = snapshot.billSplitRows.map((row) => ({
    seqNo: Number(row && row.seqNo),
    currencySourceField: normalizeCell(row && row.currencySourceField),
    creditSourceField: normalizeCell(row && row.creditSourceField),
    debitSourceField: normalizeCell(row && row.debitSourceField),
    amountSourceField: normalizeCell(row && row.amountSourceField),
    rowStatus: row && row.rowStatus === 'completed' ? 'completed' : 'draft',
    mergedGroupSeq: row && row.mergedGroupSeq !== null && row.mergedGroupSeq !== undefined ? Number(row.mergedGroupSeq) : null,
    isFeeBill: Boolean(row && row.isFeeBill === true)
  })).sort((left, right) => left.seqNo - right.seqNo);
  const seqNoSet = new Set(rows.map((row) => row.seqNo));
  const valid = rows.every((row, index) => (
    row.seqNo === index + 1
      && (row.mergedGroupSeq === null
        || (Number.isInteger(row.mergedGroupSeq) && row.mergedGroupSeq <= row.seqNo && seqNoSet.has(row.mergedGroupSeq)))
  )) && rows.filter((row) => row.isFeeBill).length <= 1;
  if (!valid) {
    throw invalid();
  }
  const billSplitAmountRules = snapshot.billSplitAmountRules.map((rule, index) => {
    if (!rule || typeof rule !== 'object') throw invalid();
    return {
      targetField: normalizeCell(rule.targetField),
      conditionField: normalizeCell(rule.conditionField),
      conditionValue: normalizeCell(rule.conditionValue),
      mappedField: normalizeCell(rule.mappedField),
      rowIndex: Number.isInteger(rule.rowIndex) ? rule.rowIndex : index
    };
  });
  const meta = snapshot.billSplitMeta;
  // 指定账单序号原样恢复（含已不存在、甚至非整数的序号：它们也影响生成时是否「勾选了指定账单」，过滤会改变取额范围）；
  //   无法按数字原样往返的值整体拒绝（不签发令牌，行管理不打开）。
  const seqNos = (value) => {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) throw invalid();
    return value.map((seqNo) => {
      const numeric = Number(seqNo);
      if (!Number.isFinite(numeric)) throw invalid();
      return numeric;
    });
  };
  return {
    templateId: Number(templateId),
    billSplitRows: rows,
    billSplitAmountRules,
    billSplitMeta: {
      signedAmountSourceField: normalizeCell(meta.signedAmountSourceField),
      signedAmountTargetSeqNos: seqNos(meta.signedAmountTargetSeqNos),
      byFieldAmountTargetSeqNos: seqNos(meta.byFieldAmountTargetSeqNos),
      feeAmountFormulaEnabled: meta.feeAmountFormulaEnabled === true,
      feeAmountFormula: normalizeFeeAmountFormula(meta.feeAmountFormula),
      feeFieldMappingEnabled: meta.feeFieldMappingEnabled === true,
      feeFieldMappings: normalizeFeeFieldMappings(meta.feeFieldMappings)
    }
  };
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
    // v3.2.16：字段筛选特征值不带源字段；v3.2.18 mappedFields 只保留所选特征值 id（由保存处校验存在）
    if (mappedField === FEATURE_FILTER_MAPPING_FIELD) {
      if (templateField === 'Balance') {
        throw new FileValidationError('FILE_READ', `${templateField} 不支持使用"${FEATURE_FILTER_MAPPING_FIELD}"`);
      }
      normalized.push({
        templateField,
        mappedField,
        mappedFields: mappedFields.slice(0, 1),
        rowIndex: Number.isInteger(mapping?.rowIndex) ? mapping.rowIndex : index
      });
      return;
    }
    // v3.2.19：逻辑取值只在主映射（映射关系管理）中提供，拆分/合并账单映射不支持；
    //   没有候补字段的是旧版本直接引用名为「逻辑取值」的源列，按普通源字段继续校验（须在表头中）。
    if (mappedField === LOGIC_VALUE_MAPPING_FIELD && !isLegacyLogicValueDirectReference(mapping?.mappedFields)) {
      throw new FileValidationError(
        'FILE_READ',
        `拆分/合并账单映射中的「${templateField}」不支持使用"${LOGIC_VALUE_MAPPING_FIELD}"，请改选源字段`
      );
    }
    // Header existence check (allow custom prefix to pass)。拼接模式只由外层 mappedField 决定（下方调用前已排除），
    // v3.2.18：拼接展开后的字段即使名为「需要拼接字段」也是真实源列，须校验存在（模板【更新】删列后不再被放行保存）。
    const checkSourceFieldExists = (field) => {
      if (!field) return;
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

function validateBillSplitRowPayload(row, { creditIgnored = false, debitIgnored = false } = {}) {
  if (!row || !Number.isInteger(Number(row?.seqNo)) || Number(row.seqNo) < 1) {
    throw new FileValidationError('FILE_READ', '拆分账单行数据格式错误');
  }
  const credit = creditIgnored ? '' : normalizeCell(row?.creditSourceField);
  const debit = debitIgnored ? '' : normalizeCell(row?.debitSourceField);
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

// sourceHeaders：模板表头，用于识别「逻辑取值」没有候补字段的旧映射（见下）。
function buildMappedFieldLookup(mappings, { sourceHeaders = null } = {}) {
  return mappings.reduce((accumulator, mapping) => {
    const mappedFields = getMappingFieldValues(mapping);
    const isConcatMode = normalizeCell(mapping.mappedField) === CONCAT_FIELDS_MAPPING_FIELD;
    // v3.2.16：字段筛选特征值转为内部 token，由 buildMappedRows 逐行取值；v3.2.18 token 带所选特征值 id
    if (normalizeCell(mapping.mappedField) === FEATURE_FILTER_MAPPING_FIELD) {
      accumulator[mapping.templateField] = buildFeatureFilterToken(getFeatureFilterRef(mapping));
      return accumulator;
    }
    // v3.2.19：逻辑取值转为内部 token（带有序候补字段），由 buildMappedRows 逐行取第一个非空值
    if (normalizeCell(mapping.mappedField) === LOGIC_VALUE_MAPPING_FIELD) {
      if (!isLegacyLogicValueDirectReference(mapping.mappedFields)) {
        accumulator[mapping.templateField] = buildLogicValueToken(normalizeLogicValueFields(mapping.mappedFields));
        return accumulator;
      }
      // 没有候补字段（空，或只有一个同名列本身，两种都是旧写法）：v3.2.18 及更早版本直接映射名为「逻辑取值」的源列时即为此形态——
      //   按源列名（不是内部 token）读取，按源字段名判断的逻辑（如根据发生额做映射的户名）与旧版本一致；模板表头有这一列时照旧按源列读取，
      //   不改变已有账单的取值；否则拒绝生成并提示重新设置，不能把该字段（如发生额）静默变成空。
      const headerSet = new Set((Array.isArray(sourceHeaders) ? sourceHeaders : []).map((header) => normalizeCell(header)));
      if (headerSet.has(LOGIC_VALUE_MAPPING_FIELD)) {
        accumulator[mapping.templateField] = LOGIC_VALUE_MAPPING_FIELD;
        return accumulator;
      }
      throw new FileValidationError(
        'FILE_READ',
        `「${normalizeCell(mapping.templateField)}」选择了「${LOGIC_VALUE_MAPPING_FIELD}」但没有候补字段，请在映射关系管理中点击【设置】重新选择`
      );
    }
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

// currencyMappingCache：一次计算多个模板配置时共用的币种表缓存（如配置指纹），避免每个模板都重新解析币种映射表
function buildStatementGenerationConfig({
  template,
  mappings,
  orderedTargetFields,
  selectedBigAccount = null,
  allowManagedMerchantWithoutSelection = false,
  currencyMappingCache = null
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

  const mappingByTargetField = buildMappedFieldLookup(selectedMappings, { sourceHeaders: template.headers });
  // v3.2.15（T3）：属于渠道的模板按渠道名输出，明细 Channel 列与余额、种子、文件名同一口径。
  const outputName = resolveStatementOutputName(template);
  const templateNameParts = splitTemplateName(outputName);
  const merchantIdMappingValue = normalizeLookupMappingValue(mappingByTargetField.MerchantId);
  // v3.2.16：按币种取大账号的模板逐行回填 MerchantId，不使用选择的大账号（防御：即便传入也忽略）。
  const isCurrencyOnlyTemplate = merchantIdMappingValue === MERCHANT_ID_CURRENCY_ONLY_MARKER;
  const selectedMerchantId = isCurrencyOnlyTemplate ? '' : normalizeCell(selectedBigAccount?.merchantId);
  const selectedCurrency = isCurrencyOnlyTemplate ? '' : normalizeCell(selectedBigAccount?.currency);
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

  const exportTargetFields = Array.from(
    new Set(
      (orderedTargetFields || mappings.map((mapping) => mapping.templateField))
        .map((fieldName) => normalizeCell(fieldName))
        .filter((fieldName) => fieldName !== '')
    )
  );

  // v3.2.15（T11）：属于渠道的模板使用渠道账户映射。
  const accountMappingByBankId = database.listEffectiveAccountMappings(template).reduce((accumulator, mapping) => {
    accumulator[mapping.bankAccountId] = {
      clearingAccountId: mapping.clearingAccountId,
      noCurrency: Boolean(mapping.noCurrency),
      currency: mapping.currency || ''
    };
    return accumulator;
  }, {});

  const amountSplitByFieldConfig = buildAmountSplitByFieldConfig(template, selectedMappings);
  // v3.2.21：字段映射特殊处理只保留本次会导出的模板字段（枚举表变化后已不导出的旧设置不参与校验、失效引用拦截与生成）
  const billSplitMergeConfig = buildBillSplitMergeConfig(template, selectedMappings, { exportTargetFields: orderedTargetFields });

  let currencyMappings = [];
  // v3.2.19：根据字段值过滤账单时命中行拆分出的币种也按币种映射表规范化（buildMappedRows），按实际下发的规则加载映射表
  const usesBillSplitRowFilter = Boolean(billSplitMergeConfig.enabled
    && Array.isArray(billSplitMergeConfig.rowFilterRules)
    && billSplitMergeConfig.rowFilterRules.length > 0);

  if (usesBillSplitRowFilter || (
    (Array.isArray(mappingByTargetField.Currency) ? mappingByTargetField.Currency.length > 0 : Boolean(currencyMappingValue)) &&
    !selectedCurrency &&
    !currencyMappingValue.startsWith(FIXED_FIELD_VALUE_PREFIX)
  )) {
    const currencyMappingTablePath = getCurrencyMappingTablePath();

    if (!fs.existsSync(currencyMappingTablePath)) {
      throw new FileValidationError('FILE_READ', '未找到币种映射表，请确认文件已放入 assets 目录');
    }

    currencyMappings = currencyMappingCache && Array.isArray(currencyMappingCache.mappings)
      ? currencyMappingCache.mappings
      : loadCurrencyMappings(currencyMappingTablePath);
    if (currencyMappingCache) currencyMappingCache.mappings = currencyMappings;
  }
  // v3.2.18：模板【更新】后映射仍引用已删除的字段时拒绝生成（否则该列静默输出空值），在读取文件与写出之前拦截。
  templateHeaderUpdateTools.assertTemplateFieldReferencesAvailable(template, {
    mappings: selectedMappings,
    amountSplitRules: amountSplitByFieldConfig.rules || [],
    billSplitMappings: billSplitMergeConfig.billSplitMappings || [],
    billSplitRows: billSplitMergeConfig.billSplitRows || [],
    billSplitAmountRules: billSplitMergeConfig.billSplitAmountRules || [],
    billSplitSignedAmountSourceField: billSplitMergeConfig.signedAmountSourceField || '',
    billSplitFeeAmountFormula: billSplitMergeConfig.feeAmountFormula || [],
    billSplitFeeAmountFormulaEnabled: Boolean(billSplitMergeConfig.feeAmountFormula),
    billSplitFeeFieldMappings: billSplitMergeConfig.feeFieldMappings || [],
    billSplitFeeFieldMappingEnabled: Boolean(billSplitMergeConfig.feeFieldMappings),
    billSplitRowFilterRules: billSplitMergeConfig.rowFilterRules || [],
    preprocessRowFilterRules: template && Array.isArray(template.preprocessRowFilterRules)
      ? template.preprocessRowFilterRules
      : [],
    featureFilters: template && Array.isArray(template.featureFilters) ? template.featureFilters : []
  });
  const preprocessRowFilterRules = buildPreprocessRowFilterRules(template, selectedMappings);
  const featureFilters = resolveStatementFeatureFilters(template, mappingByTargetField, billSplitMergeConfig);
  const currencyBigAccountMapping = isCurrencyOnlyTemplate
    ? buildCurrencyBigAccountMappingConfig(template, outputName)
    : null;

  return {
    template,
    outputName,
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
    featureFilters,
    currencyBigAccountMapping,
    preprocessRowFilterRules,
    // v3.2.19：原始账单预处理「重复账单过滤」——映射时为源行算指纹，导入时跨文件查重（spec §8.3）
    duplicateRowFilterEnabled: isDuplicateRowFilterEnabled(selectedMappings),
    dateParseOrder: template.dateFormat || 'auto'
  };
}

// v3.2.19：原始账单预处理「过滤账单」——勾选时下发过滤规则（buildMappedRows 只保留命中的源行）；未勾选返回 null。
// 勾选了却没有有效规则时拒绝生成。规则字段是否仍在模板表头由失效引用拦截负责，是否在源文件表头由 buildMappedRows 校验。
function buildPreprocessRowFilterRules(template, selectedMappings) {
  if (!isPreprocessRowFilterEnabled(selectedMappings)) {
    return null;
  }
  try {
    return validateRowFilterRules(template && template.preprocessRowFilterRules, null, {
      missingMessage: PREPROCESS_ROW_FILTER_MISSING_MESSAGE
    });
  } catch (error) {
    if (!(error instanceof FileValidationError)) {
      throw error;
    }
    throw new FileValidationError(
      'PREPROCESS_ROW_FILTER_MISSING',
      `模板「${normalizeCell(template && template.name)}」已勾选原始账单预处理「过滤账单」，但过滤规则未设置完整（${error.message}），`
        + '请在映射关系管理中点击【规则设置】设置并保存后重新导入'
    );
  }
}

// v3.2.16：实际生效的映射（拆分/合并且不复用时为拆分映射，否则为主映射）用到「字段筛选特征值」时，
// 所选特征值须存在且有效，否则拒绝生成；与 buildMappedRows 的启用口径一致。
// v3.2.18：返回用到的特征值 { [id]: { id, name, ...rule } }，未用到时为 {}。
// v3.2.19：根据字段值过滤账单时未命中的行走主映射，主映射与拆分映射的引用都计入。
function resolveStatementFeatureFilters(template, mappingByTargetField, billSplitMergeConfig) {
  const splitMappingsEffective = Boolean(billSplitMergeConfig
    && billSplitMergeConfig.enabled
    && billSplitMergeConfig.reuseModuleMapping === false);
  const rowFilterEnabled = Boolean(billSplitMergeConfig
    && billSplitMergeConfig.enabled
    && Array.isArray(billSplitMergeConfig.rowFilterRules)
    && billSplitMergeConfig.rowFilterRules.length > 0);
  const effectiveLookups = splitMappingsEffective
    ? (rowFilterEnabled
      ? [mappingByTargetField, billSplitMergeConfig.billSplitMappingByTargetField]
      : [billSplitMergeConfig.billSplitMappingByTargetField])
    : [mappingByTargetField];
  const refs = [];
  effectiveLookups.forEach((effectiveLookup) => {
    Object.entries(effectiveLookup || {}).forEach(([templateField, value]) => {
      [].concat(value).forEach((item) => {
        const ref = parseFeatureFilterToken(item);
        if (ref !== null) {
          refs.push({ templateField, ref });
          return;
        }
        // v3.2.21：逻辑取值候补里的特征值
        (parseLogicValueToken(item) || []).forEach((field) => {
          const candidateRef = parseLogicValueFeatureFilterRef(field);
          if (candidateRef !== null) {
            refs.push({ templateField: `${templateField}（${LOGIC_VALUE_MAPPING_FIELD}）`, ref: candidateRef });
          }
        });
      });
    });
  });
  return resolveUsedFeatureFilters(template && template.featureFilters, refs, { headers: template && template.headers });
}

// v3.2.16：MerchantId「原始账单仅有币种无账户号」— 读取模板【映射管理】中的 币种 → 大账号。
// 没有配置时拒绝生成，避免 MerchantId 整列留空。
function buildCurrencyBigAccountMappingConfig(template, outputName) {
  const pairs = template && template.id
    ? (database.getTemplateCurrencyBigAccounts(template.id) || [])
      .map((item) => ({ currency: normalizeCell(item.currency), merchantId: normalizeCell(item.merchantId) }))
      .filter((item) => item.currency && item.merchantId)
    : [];
  const templateName = normalizeCell(template && template.name) || normalizeCell(outputName);
  if (!pairs.length) {
    throw new FileValidationError(
      'CURRENCY_BIG_ACCOUNT_CONFIG_MISSING',
      `模板「${templateName}」的 MerchantId 为「${MERCHANT_ID_CURRENCY_ONLY_OPTION}」，但未在【映射管理】中维护币种与大账号，请先维护后重新导入`
    );
  }
  return { templateName, pairs };
}

// 模板包导入：恢复拆分行（含费用账单标记）、合并组、拆分发生额规则与拆分配置；拆分映射由调用方先行保存。
function applyBundleBillSplitConfig(templateId, entry) {
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
            : Number(row.mergedGroupSeq),
          isFeeBill: row?.isFeeBill === true
        }))
        .filter((row) => Number.isInteger(row.seqNo) && row.seqNo >= 1)
        .sort((a, b) => a.seqNo - b.seqNo)
    : [];
  database.saveBillSplitRowCount(templateId, normalizedBillSplitRows.length);
  normalizedBillSplitRows.forEach((row) => {
    database.saveBillSplitRow(templateId, row);
  });
  // v3.2.19：按包设置费用账单行（覆盖已有模板时同时清掉原来的标记）
  const importedFeeBillRow = normalizedBillSplitRows.find((row) => row.isFeeBill);
  database.setBillSplitFeeBillRow(templateId, importedFeeBillRow ? importedFeeBillRow.seqNo : null);
  // Restore merge groups
  database.clearBillSplitMergeGroups(templateId);
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
      database.saveBillSplitMergeGroup(templateId, seqNos);
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
  database.saveBillSplitAmountRules(templateId, normalizedBillSplitAmountRules);

  database.saveBillSplitMeta(templateId, {
    signedAmountSourceField: normalizeCell(entry.billSplitMeta?.signedAmountSourceField),
    signedAmountTargetSeqNos: entry.billSplitMeta?.signedAmountTargetSeqNos || [],
    byFieldAmountTargetSeqNos: entry.billSplitMeta?.byFieldAmountTargetSeqNos || [],
    // v3.2.19：导入只规范化不阻断，生成时再校验公式与过滤规则
    feeAmountFormulaEnabled: entry.billSplitMeta?.feeAmountFormulaEnabled === true,
    feeAmountFormula: normalizeFeeAmountFormula(entry.billSplitMeta?.feeAmountFormula),
    rowFilterRules: normalizeBillSplitRowFilterRules(entry.billSplitMeta?.rowFilterRules),
    // v3.2.21：字段映射特殊处理同样只规范化不阻断，生成时再校验
    feeFieldMappingEnabled: entry.billSplitMeta?.feeFieldMappingEnabled === true,
    feeFieldMappings: normalizeFeeFieldMappings(entry.billSplitMeta?.feeFieldMappings)
  });
}

// exportTargetFields（可选）：本次导出的目标字段。给出时字段映射特殊处理先去掉目标已不导出的旧设置再校验
//   （受保护的 BillDate / MerchantId / Currency / 发生额 / Balance / Channel 都是导出字段，不会因此被放过）。
function buildBillSplitMergeConfig(template, selectedMappings, { exportTargetFields = null } = {}) {
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
  // v3.2.19：复用模块字段的映射关系时拆分映射不参与生成，不构造（其中失效的旧引用不阻断生成，同失效引用拦截只看生效映射）
  const billSplitMappingByTargetField = reuseModuleMapping
    ? {}
    : buildMappedFieldLookup(
      billSplitMappings.filter((m) => m.templateField),
      { sourceHeaders: template.headers }
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
        : Number(row.mergedGroupSeq),
      isFeeBill: row.isFeeBill === true
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

  // v3.2.19：费用账单公式只在勾选特殊取值且有已完成的费用账单行时下发；勾选了却没有有效公式时拒绝生成。
  // 这里只校验结构，公式字段是否仍在模板表头由生成前的失效引用拦截（列出具体位置）负责。
  let feeAmountFormula = null;
  if (meta.feeAmountFormulaEnabled === true && billSplitRows.some((row) => row.isFeeBill)) {
    try {
      feeAmountFormula = validateFeeAmountFormula(meta.feeAmountFormula, null);
    } catch (error) {
      if (!(error instanceof FileValidationError)) {
        throw error;
      }
      throw new FileValidationError(
        'BILL_SPLIT_FEE_FORMULA_MISSING',
        `模板「${normalizeCell(template.name)}」已勾选「发生额取值特殊处理」，但发生额公式未设置完整（${error.message}），`
          + '请在映射关系管理 → 拆分/合并账单中点击【设置】保存公式后重新导入'
      );
    }
  }

  // v3.2.21：费用账单「字段映射特殊处理」只在勾选且有已完成的费用账单行时下发；勾选了却没有有效设置时拒绝生成。
  // 映射字段是否仍在模板表头由生成前的失效引用拦截负责，是否在源文件表头由 buildMappedRows 校验。
  let feeFieldMappings = null;
  if (meta.feeFieldMappingEnabled === true && billSplitRows.some((row) => row.isFeeBill)) {
    // 只跳过写明了目标、且该目标本次不导出的旧设置；缺少目标的项、受保护字段（即使本次枚举表不导出）照常校验并拒绝。
    // 已有设置但目标全部不再导出时不覆盖任何字段（按原映射生成），从未设置时仍按设置缺失拒绝。
    const exportedTargets = Array.isArray(exportTargetFields) ? new Set(exportTargetFields) : null;
    const savedFeeFieldMappings = Array.isArray(meta.feeFieldMappings) ? meta.feeFieldMappings : [];
    const activeFeeFieldMappings = savedFeeFieldMappings.filter((item) => {
      const target = normalizeCell(item && item.templateField);
      return !exportedTargets || !target || exportedTargets.has(target) || isFeeFieldMappingTemplateFieldExcluded(target);
    });
    try {
      feeFieldMappings = savedFeeFieldMappings.length > 0 && activeFeeFieldMappings.length === 0
        ? []
        : validateFeeFieldMappings(activeFeeFieldMappings, {
          allowedTemplateFields: exportedTargets ? filterFeeFieldMappingTemplateFields(exportTargetFields) : null
        });
    } catch (error) {
      if (!(error instanceof FileValidationError)) {
        throw error;
      }
      throw new FileValidationError(
        'BILL_SPLIT_FEE_FIELD_MAPPING_MISSING',
        `模板「${normalizeCell(template.name)}」已勾选「字段映射特殊处理」，但设置不完整（${error.message}），`
          + '请在映射关系管理 → 拆分/合并账单中点击【设置】保存后重新导入'
      );
    }
  }

  // v3.2.19：根据字段值过滤账单——勾选时下发过滤规则（只有命中的源行走拆分）；勾选了却没有有效规则时拒绝生成。
  // 规则字段是否仍在模板表头由生成前的失效引用拦截负责，是否在源文件表头由 buildMappedRows 校验。
  const rowFilterEnabled = selectedMappings.some((mapping) => (
    normalizeCell(mapping.templateField) === BILL_SPLIT_ROW_FILTER_MAPPING_FIELD
      && normalizeCell(mapping.mappedField) === BILL_SPLIT_ROW_FILTER_ENABLED_OPTION
  ));
  let rowFilterRules = null;
  if (rowFilterEnabled) {
    try {
      rowFilterRules = validateBillSplitRowFilterRules(meta.rowFilterRules, null);
    } catch (error) {
      if (!(error instanceof FileValidationError)) {
        throw error;
      }
      throw new FileValidationError(
        'BILL_SPLIT_ROW_FILTER_MISSING',
        `模板「${normalizeCell(template.name)}」已勾选「根据字段值过滤账单」，但过滤规则未设置完整（${error.message}），`
          + '请在映射关系管理中点击【过滤规则设置】设置并保存后重新导入'
      );
    }
  }

  return {
    enabled: true,
    reuseModuleMapping,
    billSplitMappings,
    billSplitMappingByTargetField,  // P1 Fix A (PR #16 review)
    billSplitRows,
    billSplitAmountRules,
    signedAmountSourceField,
    signedAmountTargetSeqNos,
    byFieldAmountTargetSeqNos,
    feeAmountFormula,
    feeFieldMappings,
    rowFilterRules
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
  let provisionalRecognitionBasis = null;
  const mappedRows = buildMappedRows({
    inputFilePath,
    orderedTargetFields: config.exportTargetFields,
    mappingByField: config.mappingByTargetField,
    accountMappingByBankId: config.accountMappingByBankId,
    currencyMappings: config.currencyMappings,
    amountMappingRules: config.amountMappingRules,
    amountSplitByField: config.amountSplitByField,
    billSplitMerge: config.billSplitMerge,
    featureFilters: config.featureFilters || null,
    expectedSourceHeaders: config.template.headers,
    selectedBigAccount: {
      merchantId: config.selectedMerchantId,
      currency: config.selectedCurrency
    },
    currencyBigAccountMapping: config.currencyBigAccountMapping || null,
    preprocessRowFilterRules: config.preprocessRowFilterRules || null,
    duplicateRowKeys: Boolean(config.duplicateRowFilterEnabled),
    dateParseOrder: config.dateParseOrder,
    readOptions: {
      readGuard: createStatementWorkbookReadGuard(inputFilePath),
      onWorkbookRows(rawRows) {
        provisionalRecognitionBasis = buildBigAccountRecognitionBasis({
          rawRows,
          expectedSourceHeaders: config.template.headers,
          accountMappingByBankId: config.accountMappingByBankId
        });
      }
    }
  });
  const recognitionBasis = finalizeBigAccountRecognitionBasis(
    provisionalRecognitionBasis,
    mappedRows
  );
  Object.defineProperty(mappedRows, 'bigAccountRecognitionBasis', {
    value: recognitionBasis,
    enumerable: false,
    configurable: false,
    writable: false
  });
  return mappedRows;
}

// v3.2.19：原始账单预处理「重复账单过滤」的导入暂停 / 确认 / 取消（spec §8.3）
const statementDuplicateReview = createStatementDuplicateReview({
  randomUUID,
  appendActivityLogEntry: (entry) => appendActivityLogEntry(entry),
  createErrorResult: (payload) => createErrorResult(payload),
  scanDuplicateSourceRows,
  dropDuplicateSourceRows
});

// 预检阶段：最终用于生成的条目里有重复账单时返回暂停标记（扫描结果记在 prepared 上，由 prepare 保存待确认上下文）。
// v3.2.19：只在同一生成组（同一模板，或同一渠道的各子模板；即同一份输出明细、同一条余额链）内查重。不同生成组的相同行
//   不互判重复（照常各自生成）：跨组去除是把交易从一家银行的账单挪到另一家，不是去除重复；也避免某组被整组去空、
//   该组之前生成的余额失去明细依据。条目带 duplicateScope 供 scanDuplicateSourceRows 分组，返回前去掉。
function scopeDuplicateEntries(entries) {
  const scopeByTemplate = new Map();
  return (Array.isArray(entries) ? entries : []).map((entry) => {
    if (!entry) return entry;
    const templateId = Number(entry.matchedTemplateId || 0);
    if (!scopeByTemplate.has(templateId)) {
      const template = templateId ? database.getTemplate(templateId) : null;
      scopeByTemplate.set(templateId, resolveGenerationGroupKey(template || { id: templateId }));
    }
    return { ...entry, duplicateScope: scopeByTemplate.get(templateId) };
  });
}

function unscopeDuplicateEntries(entries) {
  return (Array.isArray(entries) ? entries : []).map((entry) => {
    if (!entry || !Object.prototype.hasOwnProperty.call(entry, 'duplicateScope')) return entry;
    const { duplicateScope: _scope, ...rest } = entry;
    return rest;
  });
}

function previewDuplicateRows(entries, prepared, templateName) {
  const outcome = statementDuplicateReview.review({ entries: scopeDuplicateEntries(entries), prepared, phase: 'preview', templateName });
  if (outcome.status !== 'pause') return null;
  prepared.pendingDuplicateReview = {
    scan: outcome.scan,
    templateName,
    templateIds: (Array.isArray(entries) ? entries : []).map((entry) => entry && entry.matchedTemplateId)
  };
  return { status: DUPLICATE_REVIEW_STATUS };
}

// v3.2.19：确认续跑沿用预检时已映射的明细（账号、账期、渠道、指纹）。等待确认期间参与的模板、渠道归属或账户映射变化，
//   会让旧明细与新配置混用（如明细 Channel 仍是旧渠道、却按新渠道分组生成），且复核摘要发现不了：
//   暂停时记下参与模板的配置指纹，续跑前核对，变化即要求重新导入。模板已删除记为 missing。
function buildDuplicateReviewConfigStamp(templateIds) {
  const ids = new Set((Array.isArray(templateIds) ? templateIds : [])
    .map((id) => Number(id))
    .filter((id) => Number.isInteger(id) && id > 0));
  // 每个模板的配置只读一次，枚举表、币种表各只解析一次（模板多时避免反复同步读文件）
  const enumCache = {};
  const currencyMappingCache = {};
  const configs = new Map();
  const loadConfig = (id) => {
    if (!configs.has(id)) {
      let config;
      try {
        config = getTemplateMappingConfig(id, { enumCache });
      } catch (_error) {
        config = null;
      }
      configs.set(id, config);
    }
    return configs.get(id);
  };
  // 同渠道的兄弟模板：按文件名映射时它们的大账号也参与聚合与选择，一并纳入
  Array.from(ids).forEach((id) => {
    try {
      const config = loadConfig(id);
      const channelId = Number(config && config.template && config.template.channelId || 0);
      if (channelId) database.listStatementChannelTemplates(channelId).forEach((sibling) => ids.add(Number(sibling.id)));
    } catch (_error) {
      // 模板已删除：下方记为 missing
    }
  });
  return createHash('sha256').update(JSON.stringify(Array.from(ids).sort((left, right) => left - right).map((id) => {
    const config = loadConfig(id);
    if (!config || !config.template) return [id, 'missing'];
    const {
      enumValues: _enumValues,
      targetFields: _targetFields,
      preprocessFields: _preprocessFields,
      advancedMappingFields: _advancedMappingFields,
      billSplitGroupFields: _billSplitGroupFields,
      ...templateConfig
    } = config;
    // 生成实际使用的配置（拆分金额的指定账单序号、特征值、过滤规则等不都在模板配置里）；币种映射表是全局资源，不计入
    let generationConfig;
    try {
      const { currencyMappings: _currencyMappings, ...rest } = buildStatementGenerationConfig({
        template: config.template,
        mappings: config.exportMappings,
        orderedTargetFields: config.exportTargetFields,
        allowManagedMerchantWithoutSelection: true,
        currencyMappingCache
      });
      generationConfig = rest;
    } catch (error) {
      generationConfig = { error: String(error && error.message || error) };
    }
    // 拆分/合并的原始元数据（正负号 / 按字段取发生额的指定账单序号等）也直接计入：不论当前是否生效，变化即重新确认
    // 大账号「固定模式」与记住的顺序（按记住的顺序自动分配大账号时决定各段账号）：存于模板配置以外，一并计入
    let bigAccountSelection;
    try {
      bigAccountSelection = [readBigAccountMode(ensureStorageRoot(), id), readBigAccountOrder(ensureStorageRoot(), id)];
    } catch (error) {
      bigAccountSelection = { error: String(error && error.message || error) };
    }
    return [id, templateConfig, database.listEffectiveAccountMappings(config.template), database.getBillSplitMeta(id), generationConfig,
      bigAccountSelection];
  }))).digest('hex');
}

// v3.2.19：按文件名映射时，文件命中哪个模板取决于全部模板的表头（matchFileToTemplate 取表头匹配最多的一项）：
//   模板目录快照（全部模板的记录与映射行，只读数据库、不解析文件）在映射前记下，之后新增、删除或修改任一模板都会让快照变化，
//   命中结果可能不同，须重新导入。
function buildTemplateCatalogStamp() {
  return createHash('sha256').update(JSON.stringify(database.listTemplates()
    .map((template) => [template, database.getTemplateMappings(template.id)]))).digest('hex');
}

// v3.2.19：预检映射的条目在任务开始后才使用：beforeStart 之后到业务入口之间（任务批次预留、证据采集等）配置仍可能被修改，
//   业务入口使用条目前再核对（prepared.importConfigGuard）。配置变化时还没有改动会话与输出，按未开始返回（界面保留上一批状态）。
function checkImportConfigGuard(prepared, message = IMPORT_CONFIG_CHANGED_MESSAGE) {
  if (!prepared || typeof prepared.importConfigGuard !== 'function' || prepared.importConfigGuard()) return null;
  return Object.assign(createPreflightErrorResult({ message, errorCode: 'IMPORT_CONFIG_CHANGED' }), { preservesSession: true });
}

// 配置指纹（及按文件名映射时的模板目录快照）仍与记下时一致
function isImportConfigStampCurrent(config) {
  if (!config) return true;
  if (config.stamp !== buildDuplicateReviewConfigStamp(config.templateIds)) return false;
  return !config.catalogStamp || config.catalogStamp === buildTemplateCatalogStamp();
}

function isDuplicateReviewConfigCurrent(review) {
  return Boolean(review) && review.configStamp === buildDuplicateReviewConfigStamp(review.configTemplateIds)
    && (!review.catalogStamp || review.catalogStamp === buildTemplateCatalogStamp());
}

const DUPLICATE_REVIEW_CONFIG_CHANGED_MESSAGE = '等待确认期间模板、渠道或账户映射已修改，请重新导入文件';
// v3.2.19：导入预检按当时的配置映射条目，任务开始前配置已变化（任务预留、证据采集期间修改了映射、渠道等）
const IMPORT_CONFIG_CHANGED_MESSAGE = '导入期间模板、渠道或账户映射已修改，请重新导入文件';

// 执行阶段：有重复账单时须已确认（摘要一致），返回删除后的条目；否则返回 { result } 拒绝生成。
function applyConfirmedDuplicateRowFilter(entries, prepared, templateName) {
  const outcome = statementDuplicateReview.review({ entries: scopeDuplicateEntries(entries), prepared, phase: 'execute', templateName });
  if (outcome.status === 'stale') return { result: outcome.result };
  return { entries: unscopeDuplicateEntries(outcome.entries) };
}

// v3.2.19：单模板导入复用预检映射行时，执行阶段实际用于生成的条目（预检查重与执行同一口径）。
function resolveReusedSingleTemplateEntries({ parentProvisionalEntries, templateConfig, selectedBigAccount }) {
  return rebuildMatchedTemplateFileEntries({
    fileEntries: parentProvisionalEntries,
    fallbackTemplateConfig: templateConfig,
    selectedBigAccount,
    reuseMappedRows: true
  });
}

// v3.2.19：按文件名映射导入实际用于生成的条目。各条目带 matchedTemplateId，按条目自己的模板重建，
//   与多模板分组生成（generateMultiTemplateGroupFiles）逐组重建的结果一致。
function resolveFilenameMappingFinalEntries(plan) {
  return rebuildMatchedTemplateFileEntries({
    fileEntries: plan.trimmedProvisionalEntries,
    fallbackTemplateConfig: plan.syntheticTemplateConfig,
    selectedBigAccount: plan.selectedBigAccount,
    reuseMappedRows: true
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
  buildBalanceGapConfirmResult,
  buildBalanceMismatchConfirmResult,
  buildBalanceSeedReplaceConfirmResult,
  getAcknowledgedBalanceGapKeys,
  buildDetailExportRows,
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
  getBalanceTemplatePath,
  getStatementSessionEntries,
  mergeMappedDetailRows,
  normalizeCell,
  normalizeInputFilePaths,
  parseRequiredBillDates,
  resolveSinglePreparedFieldValue,
  scanBalanceSeedStatus,
  readBalanceAdjustments,
  readBalanceSeedRecords,
  splitTemplateName,
  storeGeneratedBalanceSeeds,
  writeBalanceWorkbook,
  writeWorkbookRows
});

// balancePlan：同一阶段已用 resolveEntryBalancePlan 校验过的方案（null 表示不需要按账户分方式），给出时不再重复解析。
// issueLineBudget：多组规划时整批共用的缺字段逐行诊断额度（见 resolveEntryBalancePlan）。
function buildPreparedStatementBatchFromEntries({ config, fileEntries = [], balancePlan, issueLineBudget }) {
  const preparedBatch = statementGenerationHelpers.buildPreparedStatementBatchFromEntries({ config, fileEntries });
  return applyEntryBalanceModes({ config, fileEntries, preparedBatch, balancePlan, issueLineBudget });
}

// v3.2.21（T7）：条目的余额方式。条目模板就是组配置模板时按组配置（可能是等待确认期间记下的配置），
//   否则按库中该模板当前映射；模板已不存在时退回组配置。
function resolveEntryBalanceMode(entry, config, templateConfigCache = new Map()) {
  const configTemplate = config && config.template ? config.template : null;
  const fallback = {
    templateName: String(configTemplate && configTemplate.name || ''),
    balanceMode: config && config.balanceRequested ? config.balanceMode : 'none'
  };
  const templateId = Number(entry && entry.matchedTemplateId || 0);
  if (!templateId || templateId === Number(configTemplate && configTemplate.id || 0)) return fallback;
  if (!templateConfigCache.has(templateId)) templateConfigCache.set(templateId, getTemplateMappingConfig(templateId));
  const templateConfig = templateConfigCache.get(templateId);
  if (!templateConfig) return fallback;
  return {
    templateName: templateConfig.template.name,
    balanceMode: resolveTemplateBalanceMode(templateConfig.exportMappings)
  };
}

// v3.2.21（D2、D3、T4）：渠道组内子模板余额方式不同时，余额按账户取各自子模板的方式。
//   同一账户命中不同方式时整批阻断（导入多组生成时在规划阶段抛出，尚未写出文件或替换会话）；参与余额的交易行
//   须有账单日期与 MerchantId（按各行实际取到的值核对，拆分行用独立映射时同样适用；组配置模板可能不出余额，生成时
//   不再只看组配置的映射）。否则在批次上附加账户 → 方式表，并按出余额条目是否有交易行决定是否生成余额（组配置模板不出余额时
//   其他账户照常出余额；只有收支都为空或 0 的行时不生成）；组内有不出余额的条目时，标记余额只用出余额账户的行
//   （balanceRowsByAccountMode：生成与另存为命名时按账户方式表从明细行中取行引用，不另复制一份，release 审查）。
//   条目来自同一模板或余额方式都相同时原样返回，行为与此前一致。
function applyEntryBalanceModes({ config, fileEntries, preparedBatch, balancePlan, issueLineBudget }) {
  const plan = balancePlan === undefined ? resolveEntryBalancePlan({ config, fileEntries, issueLineBudget }) : balancePlan;
  if (!plan) return preparedBatch;
  const { modes, modeByAccount, hasEffectiveRow } = plan;
  if (!modes.has('none')) {
    return { ...preparedBatch, balanceModeByAccount: modeByAccount, balanceRequested: hasEffectiveRow };
  }
  return {
    ...preparedBatch,
    balanceModeByAccount: modeByAccount,
    balanceRowsByAccountMode: true,
    balanceRequested: hasEffectiveRow
  };
}

// v3.2.21（D2、D3）：渠道组内按条目判断余额方式。条目来自同一模板或余额方式都相同时返回 null；同一账户命中不同方式、
//   出余额的交易缺账单日期或 MerchantId 时抛错；否则返回 { modes, modeByAccount, balanceEntries, hasEffectiveRow }。
//   只扫描条目的明细行、不复制，可在写出任何文件之前对全部组校验（「导出全部」执行时用它逐组校验，通过后再逐组构建批次）。
//   issueLineBudget（{ remaining }，可选）：多组规划时整批共用的缺字段逐行诊断额度，用完后只计数、不再构造逐行明细；
//   不给时本组单独 200 行。
function resolveEntryBalancePlan({ config, fileEntries, issueLineBudget = { remaining: 200 } }) {
  const entries = (Array.isArray(fileEntries) ? fileEntries : []).filter(Boolean);
  const templateIds = new Set(entries.map((entry) => Number(entry.matchedTemplateId || 0)));
  if (templateIds.size < 2) return null;
  const templateConfigCache = new Map();
  const entryModes = entries.map((entry, index) => ({
    ...resolveEntryBalanceMode(entry, config, templateConfigCache),
    detailRows: entry.detailRows,
    fileName: path.basename(String(entry.filePath || '')),
    fileOrdinal: index + 1
  }));
  const modes = new Set(entryModes.map((item) => item.balanceMode));
  if (modes.size < 2) return null;
  const channelName = (config && config.outputName) || resolveStatementOutputName(config && config.template);
  const { modeByAccount, conflicts } = resolveAccountBalanceModes(entryModes);
  if (conflicts.length) {
    throw buildChannelBalanceModeMismatchError([buildBalanceModeConflictGroup(channelName, conflicts, entryModes)]);
  }
  const balanceEntries = entryModes.filter((item) => item.balanceMode !== 'none');
  const balanceRowCheck = inspectBalanceEntryRows(balanceEntries, Math.max(0, issueLineBudget.remaining),
    entryModes.filter((item) => item.balanceMode === 'none'));
  issueLineBudget.remaining -= balanceRowCheck.lines.length;
  if (balanceRowCheck.issueCount) {
    throw buildChannelBalanceRowsIncompleteError([{
      channelName,
      lines: balanceRowCheck.lines,
      persistedLines: balanceRowCheck.persistedLines,
      issueCount: balanceRowCheck.issueCount,
      accountValues: balanceRowCheck.accountValues
    }]);
  }
  return { modes, modeByAccount, balanceEntries, hasEffectiveRow: balanceRowCheck.hasEffectiveRow };
}

// 出余额条目的交易行（收支不都为空或 0，与余额推导经 buildDetailExportRows 后的口径相同）：是否存在；缺账单日期或
//   MerchantId 的交易行按原文件行列出。余额推导会跳过这类行，交易仍进明细，余额与种子却漏算，因此在写出任何文件之前拦下。
//   拆分出的多笔交易来自同一原文件行（在明细中相邻输出）时合并为一行（合并所缺字段），按原文件行计数。
//   lines 写明文件名（可能含账号，只用于界面）；persistedLines 用本组第几个文件代替文件名，供错误报告与活动日志。
//   accountValues：这些出余额条目的交易行读到的 MerchantId，落盘时子模板名、渠道名按它们整体脱敏（以字母数字混合的
//   实际账号命名时没有连续 4 位数字，只按数字写法脱敏会漏，release 审查）。有缺字段的行时另从 otherEntries（同组不出余额的
//   条目，不做缺字段校验）读取 MerchantId 一并用于脱敏（collectEntryMerchantIdsForLog，只在报错时多读这一遍）。
//   只为前 lineLimit 行保留诊断对象（整列未映射时每笔交易都缺，诊断占用不随行数增长），issueCount 为总行数；
//   超出上限的汇总行由 buildChannelBalanceRowsIncompleteError 按整批共享的上限补上。
function inspectBalanceEntryRows(balanceEntries, lineLimit = 200, otherEntries = []) {
  let hasEffectiveRow = false;
  let issueCount = 0;
  const shownIssues = [];
  const accountValues = new Set();
  for (const item of balanceEntries) {
    const rows = Array.isArray(item.detailRows) ? item.detailRows : [];
    const indexes = buildFieldIndexMap(Array.isArray(rows[0]) ? rows[0] : []);
    const dateIndex = indexes.get('BillDate');
    const merchantIndex = indexes.get('MerchantId');
    const creditIndex = indexes.get('Credit Amount');
    const debitIndex = indexes.get('Debit Amount');
    const rowMetas = Array.isArray(rows.rowMetas) ? rows.rowMetas : [];
    let lastSourceRowNumber = null;
    let currentIssue = null;
    for (let rowIndex = 0; rowIndex < rows.length - 1; rowIndex += 1) {
      const row = rows[rowIndex + 1];
      if (!Array.isArray(row)) continue;
      if (
        creditIndex !== undefined && debitIndex !== undefined
        && isZeroOrBlankAmount(row[creditIndex]) && isZeroOrBlankAmount(row[debitIndex])
      ) continue;
      hasEffectiveRow = true;
      const billDate = dateIndex === undefined ? '' : normalizeCell(row[dateIndex]);
      const merchantId = merchantIndex === undefined ? '' : normalizeCell(row[merchantIndex]);
      if (merchantId) accountValues.add(merchantId);
      if (billDate && merchantId) continue;
      const sourceRowNumber = rowMetas[rowIndex] && rowMetas[rowIndex].sourceRowNumber || rowIndex + 2;
      if (sourceRowNumber !== lastSourceRowNumber) {
        lastSourceRowNumber = sourceRowNumber;
        issueCount += 1;
        currentIssue = issueCount <= lineLimit
          ? { item, sourceRowNumber, billDate: '', missingDate: false, missingMerchantId: false }
          : null;
        if (currentIssue) shownIssues.push(currentIssue);
      }
      if (!currentIssue) continue;
      if (billDate && !currentIssue.billDate) currentIssue.billDate = billDate;
      if (!billDate) currentIssue.missingDate = true;
      if (!merchantId) currentIssue.missingMerchantId = true;
    }
  }
  if (issueCount) collectEntryMerchantIdsForLog(otherEntries).forEach((merchantId) => accountValues.add(merchantId));
  const lines = [];
  const persistedLines = [];
  const knownAccounts = Array.from(accountValues);
  const maskedTemplateNames = new Map();
  const maskTemplateName = (name) => {
    if (!maskedTemplateNames.has(name)) maskedTemplateNames.set(name, maskAccountLikeTextForLog(name, knownAccounts));
    return maskedTemplateNames.get(name);
  };
  shownIssues.forEach((issue) => {
    const missing = [issue.missingDate ? '账单日期' : '', issue.missingMerchantId ? 'MerchantId' : ''].filter(Boolean).join('、');
    const problem = issue.missingDate ? `缺少${missing}` : `缺少 ${missing}（账单日期：${issue.billDate}）`;
    lines.push(`文件「${issue.item.fileName}」（子模板「${issue.item.templateName}」）第${issue.sourceRowNumber}行：${problem}`);
    // 落盘（错误报告、活动日志）不写文件名，子模板名（用户填写，可能以账号命名）中的编号只写位数（release 审查）
    persistedLines.push(`本组第${issue.item.fileOrdinal}个文件（子模板「${maskTemplateName(issue.item.templateName)}」）第${issue.sourceRowNumber}行：${problem}`);
  });
  return { hasEffectiveRow, lines, persistedLines, issueCount, accountValues: issueCount ? knownAccounts : [] };
}

function buildPreparedStatementBatchFromFilePaths({ config, inputFilePaths = [] }) {
  return statementGenerationHelpers.buildPreparedStatementBatchFromFilePaths({ config, inputFilePaths });
}

function generateStatementFiles(options) {
  assertGenerationOutputNameUnique(options && options.config && options.config.template);
  return statementGenerationHelpers.generateStatementFiles(options);
}

// v3.2.21：多组生成写出任何组之前的只读校验（与 generateStatementFiles 写出前的检查同口径，见 statement-generation.js）
function assertStatementBatchWritable(options) {
  return statementGenerationHelpers.assertStatementBatchWritable(options);
}

function assertStatementEntriesWritable(options) {
  return statementGenerationHelpers.assertStatementEntriesWritable(options);
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
  // v3.2.22 B113：读回时字面 _xHHHH_ 已还原成原文，写出前须与单组写出同样转义，否则合并文件中的流水号等被改写
  prepareWorkbookTextForWrite(baseWb);
  fs.mkdirSync(path.dirname(mergedOutputPath), { recursive: true });
  applyWatermark(baseWb);
  XLSXStyle.writeFile(baseWb, mergedOutputPath);
  return mergedOutputPath;
}

// 全部范围与当前批次的汇总文件可能同名（模板数、日期范围相同）；内部文件按范围加后缀隔离，
// 避免覆盖当前批次已缓存的文件。对外文件名不变，与 buildStatementOutputFilePath 的 internalSuffix 同口径。
function scopedMergedOutputFileName(fileName, scope) {
  return scope === 'all' ? fileName.replace(/\.xlsx$/i, '__all.xlsx') : fileName;
}

// v3.2.15（T4）：按生成分组键把文件条目分组：属于渠道的子模板合为一组（一条余额链），普通模板各自一组。
//   组配置取组内第一个仍存在的模板（输出身份在渠道内一致；v3.2.21 起余额方式可不同，按账户取，见
//   applyEntryBalanceModes）；明细行仍是各条目按自己子模板构建的结果。
//   返回 [{ key, entries, templateIds, templateConfig }]；组内模板都已删除时 templateConfig 为 null。
function groupStatementEntriesForGeneration(entries) {
  const templateCache = new Map();
  const templateById = (templateId) => {
    if (!templateCache.has(templateId)) {
      templateCache.set(templateId, templateId ? database.getTemplate(templateId) : null);
    }
    return templateCache.get(templateId);
  };
  const groups = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    const templateId = Number(entry && entry.matchedTemplateId || 0);
    const key = resolveGenerationGroupKey(templateById(templateId) || { id: templateId });
    if (!groups.has(key)) groups.set(key, { key, entries: [], templateIds: [] });
    const group = groups.get(key);
    group.entries.push(entry);
    if (!group.templateIds.includes(templateId)) group.templateIds.push(templateId);
  }
  // 各组共用一份枚举值，不为每组重新读取枚举工作簿
  const enumCache = {};
  return Array.from(groups.values()).map((group) => {
    let templateConfig = null;
    for (const templateId of group.templateIds) {
      templateConfig = templateId ? getTemplateMappingConfig(templateId, { enumCache }) : null;
      if (templateConfig) break;
    }
    return { ...group, templateConfig };
  });
}

// v3.2.21（D3、T6）：渠道组内各条目按各自子模板（库中当前映射）的余额方式。不是渠道组、组内只有一个模板或
//   余额方式都相同时返回 null（不需要按账户判断）。
function resolveGenerationGroupEntryBalanceModes(group) {
  if (!group || !String(group.key).startsWith('channel:') || group.templateIds.length < 2) return null;
  const templateConfigCache = new Map();
  const entryModes = group.entries.map((entry) => {
    const templateId = Number(entry && entry.matchedTemplateId || 0);
    if (!templateConfigCache.has(templateId)) {
      templateConfigCache.set(templateId, templateId ? getTemplateMappingConfig(templateId) : null);
    }
    const templateConfig = templateConfigCache.get(templateId);
    if (!templateConfig) return null;
    return {
      entry,
      templateName: templateConfig.template.name,
      balanceMode: resolveTemplateBalanceMode(templateConfig.exportMappings),
      detailRows: entry.detailRows
    };
  }).filter(Boolean);
  return new Set(entryModes.map((item) => item.balanceMode)).size < 2 ? null : entryModes;
}

// v3.2.21（D3、T6）：渠道组内同一账户命中余额方式不同的子模板时返回该渠道的冲突（见 buildBalanceModeConflictGroup），
//   否则 null（取代 v3.2.15 D2 的“各子模板余额方式必须一致”）。账号尚未确定的行（如多大账号模板在选择大账号之前）
//   不参与判断，账号确定后见 findResolvedEntriesBalanceModeConflicts，生成前由 applyEntryBalanceModes 兜底。
//   mixedEntries（Set 或 Map，可选）：余额方式不同的渠道组的条目一并记入，供注入大账号后的复核取位置，不再重新解析；
//   给 Map 时另记各条目所属渠道与余额方式（{ groupKey, channelName, mode: { templateName, balanceMode } | null }），
//   同次预检注入账号后直接复用（见 findResolvedEntriesBalanceModeConflicts），不再分组、读取模板配置。
function findGenerationGroupBalanceModeConflictGroup(group, mixedEntries = null) {
  const entryModes = resolveGenerationGroupEntryBalanceModes(group);
  if (!entryModes) return null;
  const channelName = resolveGenerationGroupChannelName(group);
  if (mixedEntries instanceof Map) {
    const modeByEntry = new Map(entryModes.map((item) => [item.entry, { templateName: item.templateName, balanceMode: item.balanceMode }]));
    group.entries.forEach((entry) => mixedEntries.set(entry, { groupKey: group.key, channelName, mode: modeByEntry.get(entry) || null }));
  } else if (mixedEntries) {
    group.entries.forEach((entry) => mixedEntries.add(entry));
  }
  const { conflicts } = resolveAccountBalanceModes(entryModes);
  // groupKey：导入预检据此找出账号由注入改写的渠道（步骤 8），不进入错误明细
  return conflicts.length ? { ...buildBalanceModeConflictGroup(channelName, conflicts, entryModes), groupKey: group.key } : null;
}

// v3.2.21（D3）：汇总本批各渠道组的冲突，整批逐账户列出（不在第一个渠道处停下）。返回冲突渠道的数组，没有时 null。
//   mixedEntries 见 findGenerationGroupBalanceModeConflictGroup。
function collectGenerationGroupBalanceModeConflicts(groups, mixedEntries = null) {
  const conflictGroups = (Array.isArray(groups) ? groups : [])
    .map((group) => findGenerationGroupBalanceModeConflictGroup(group, mixedEntries))
    .filter(Boolean);
  return conflictGroups.length ? conflictGroups : null;
}

// 一个渠道的冲突：lines 逐账户列出（含账号，只用于界面展示）；accountCount、templateNames 供落盘的诊断（不含账号）；
//   accountValues：冲突的实际 MerchantId 与本组条目（entries，可选）交易行读到的全部 MerchantId，落盘时据此脱敏以账号命名的
//   渠道、子模板（含不是纯数字的账号；渠道可能以本组未冲突的账号命名，release 审查）。
function buildBalanceModeConflictGroup(channelName, conflicts, entries = []) {
  return {
    channelName,
    lines: formatBalanceModeConflictLines(conflicts),
    accountCount: conflicts.length,
    templateNames: [...new Set(conflicts.flatMap((conflict) => conflict.templates.map((item) => item.templateName)))],
    accountValues: [...new Set([
      ...conflicts.map((conflict) => conflict.merchantId).filter(Boolean),
      ...collectEntryMerchantIdsForLog(entries)
    ])]
  };
}

// 条目交易行读到的 MerchantId：只用于报错时的日志脱敏（渠道、子模板可能以这些账号命名，release 审查）
function collectEntryMerchantIdsForLog(entries) {
  const values = new Set();
  for (const item of Array.isArray(entries) ? entries : []) {
    const rows = Array.isArray(item && item.detailRows) ? item.detailRows : [];
    const merchantIndex = buildFieldIndexMap(Array.isArray(rows[0]) ? rows[0] : []).get('MerchantId');
    if (merchantIndex === undefined) continue;
    for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
      const merchantId = Array.isArray(rows[rowIndex]) ? normalizeCell(rows[rowIndex][merchantIndex]) : '';
      if (merchantId) values.add(merchantId);
    }
  }
  return values;
}


// v3.2.21（D3）：账号要注入大账号后才确定时（完成大账号选择、直接生成时自动确定的大账号），按注入后的条目判断。
//   mixedEntries：导入预检时已识别的、余额方式不同的渠道组的条目（见 listBalanceModeMixedEntryIndexes），其他渠道与普通
//   模板的文件不再分组、不读配置、不重建。其中需要注入的条目（needsResolution，默认全部）交给
//   resolveEntries(pendingEntries) 注入（返回与之一一对应的条目），其余沿用原行（导入预检已按原行判断过）。
//   没有需要注入的条目时不调用，返回 null。只复核含需要注入条目的渠道（同渠道未变的条目留作比对对象）；其他渠道的
//   账号都来自原列，导入预检已按原行判断过，不再读配置、扫描交易行（分组键与 groupStatementEntriesForGeneration 同口径，
//   只看模板与渠道归属，与注入前后无关）。
//   recordedModes（Map，可选）：同次预检的渠道组校验记下的条目所属渠道与余额方式（见 findGenerationGroupBalanceModeConflictGroup），
//   给出时直接复用，只替换注入后的明细行再判断，不再分组、读取模板配置。
function findResolvedEntriesBalanceModeConflicts(mixedEntries, resolveEntries, needsResolution = () => true, recordedModes = null) {
  const candidates = Array.isArray(mixedEntries) ? mixedEntries : [];
  const pendingEntries = candidates.filter((entry) => needsResolution(entry));
  if (!pendingEntries.length) return null;
  const pendingSet = new Set(pendingEntries);
  if (recordedModes instanceof Map) {
    const recordedGroups = new Map();
    for (const entry of candidates) {
      const recorded = recordedModes.get(entry);
      if (!recorded) continue;
      if (!recordedGroups.has(recorded.groupKey)) recordedGroups.set(recorded.groupKey, { channelName: recorded.channelName, entries: [] });
      recordedGroups.get(recorded.groupKey).entries.push(entry);
    }
    const affected = Array.from(recordedGroups.values()).filter((group) => group.entries.some((entry) => pendingSet.has(entry)));
    const resolvedEntries = resolveEntries(pendingEntries);
    const resolvedByEntry = new Map(pendingEntries.map((entry, index) => [entry, resolvedEntries[index]]));
    const conflictGroups = affected.map((group) => {
      const entryModes = group.entries
        .map((entry) => {
          const { mode } = recordedModes.get(entry);
          return mode ? { ...mode, detailRows: (resolvedByEntry.get(entry) || entry).detailRows } : null;
        })
        .filter(Boolean);
      const { conflicts } = resolveAccountBalanceModes(entryModes);
      return conflicts.length ? buildBalanceModeConflictGroup(group.channelName, conflicts, entryModes) : null;
    }).filter(Boolean);
    return conflictGroups.length ? conflictGroups : null;
  }
  // 先按分组键（只看模板与渠道归属）筛出含需要注入条目的渠道，再分组读取这些渠道的配置
  const templateKeyCache = new Map();
  const groupKeyOf = (entry) => {
    const templateId = Number(entry && entry.matchedTemplateId || 0);
    if (!templateKeyCache.has(templateId)) {
      templateKeyCache.set(templateId, resolveGenerationGroupKey((templateId ? database.getTemplate(templateId) : null) || { id: templateId }));
    }
    return templateKeyCache.get(templateId);
  };
  const affectedKeys = new Set(pendingEntries.map(groupKeyOf));
  const affectedGroups = groupStatementEntriesForGeneration(candidates.filter((entry) => affectedKeys.has(groupKeyOf(entry))));
  const resolvedEntries = resolveEntries(pendingEntries);
  const resolvedByEntry = new Map(pendingEntries.map((entry, index) => [entry, resolvedEntries[index]]));
  return collectGenerationGroupBalanceModeConflicts(affectedGroups.map((group) => ({
    ...group,
    entries: group.entries.map((entry) => resolvedByEntry.get(entry) || entry)
  })));
}

// v3.2.21（D3）：余额方式不同的渠道组的条目在 entries 中的位置。按位置记：条目在预检、执行之间会被重新绑定（复制），
//   完成大账号选择时按位置从暂存的条目中取回，不再对整批分组、读取配置。mixedEntries：已记下的条目（Set，见
//   collectGenerationGroupBalanceModeConflicts）；不给时按 groups 解析。
function listBalanceModeMixedEntryIndexes(groups, entries, mixedEntries = null) {
  const mixed = mixedEntries || new Set((Array.isArray(groups) ? groups : [])
    .filter((group) => resolveGenerationGroupEntryBalanceModes(group))
    .flatMap((group) => group.entries));
  const indexes = [];
  (Array.isArray(entries) ? entries : []).forEach((entry, index) => {
    if (mixed.has(entry)) indexes.push(index);
  });
  return indexes;
}

// 直接生成时条目的 MerchantId 是否取所选大账号（多大账号模板）：只有这类条目的账号在注入后才确定（同
//   rebuildMatchedTemplateFileEntries 的判断）
//   cache：模板 ID → 模板配置（同 getEntryTemplateConfig），同一模板的多份文件不重复读取配置
function entryUsesSelectedBigAccount(entry, fallbackTemplateConfig, cache = new Map()) {
  const entryTemplateConfig = getEntryTemplateConfig({ entry, fallbackTemplateConfig, cache });
  const merchantMapping = (entryTemplateConfig.exportMappings || []).find(
    (mapping) => normalizeCell(mapping.templateField) === 'MerchantId'
  );
  return normalizeCell(merchantMapping && merchantMapping.mappedField)
    === `${FIXED_FIELD_VALUE_PREFIX}${MERCHANT_ID_MULTI_ACCOUNT_MARKER}`;
}

// 从整批已注入的条目中按位置取出 subset 对应的条目（整批注入与原条目一一对应）
function pickResolvedEntries(entries, resolvedEntries, subset) {
  return subset.map((entry) => resolvedEntries[entries.indexOf(entry)]);
}

function formatBalanceModeConflictLines(conflicts) {
  return conflicts.map((conflict) => {
    const account = conflict.currency ? `${conflict.merchantId}（${conflict.currency}）` : conflict.merchantId;
    const templates = conflict.templates
      .map((item) => `${item.templateName}（${describeBalanceMode(item.balanceMode)}）`)
      .join('、');
    return `账户 ${account}：${templates}`;
  });
}

function resolveGenerationGroupChannelName(group) {
  return group && group.templateConfig
    ? resolveStatementOutputName(group.templateConfig.template)
    : String(group && group.key || '');
}

// v3.2.21（D3）：多组规划中渠道的生成配置报错（如首个子模板映射失效）时，仍按会话中已映射的明细与各子模板当前的
//   余额方式校验该渠道（账户冲突、出余额的交易缺字段，同 resolveEntryBalancePlan），不依赖失效的映射；与其他组共用
//   逐行诊断额度，发现的问题记入调用方的汇总，各渠道一次列全。
// v3.2.21（D3）：「导出全部」另存为确认后的渠道余额复检（另存为框打开期间映射可能变化）。只在本次仍需重新生成、会话未变的
//   按文件名映射会话中进行，只看余额方式可能不同的渠道组（多个子模板），只扫描不复制明细、不解析日期；生成配置报错的渠道
//   按会话明细校验（见 collectGroupBalanceIssuesWithoutConfig）。有问题时返回与预检相同的带明细结果，否则 null；
//   其他变化（会话、缓存、映射缺字段等）仍由 beforeStart 处理。
function recheckStatementExportChannelBalance(kind, plan) {
  if (!plan || !plan.needsGeneration || !plan.session || plan.normalizedScope !== 'all') return null;
  const session = getCurrentStatementSession();
  if (session !== plan.session || !isFilenameMappingMode(session.templateId)) return null;
  const cached = getGeneratedStatementExport(kind, plan.normalizedScope);
  if (cached && cached.filePath && fs.existsSync(cached.filePath)) return null;
  const conflictGroups = [];
  const rowIssueGroups = [];
  const issueLineBudget = { remaining: 200 };
  const channelGroups = groupStatementEntriesForGeneration(getStatementSessionEntries(session, 'all'))
    .filter((group) => group.templateConfig && group.templateIds.length > 1);
  for (const group of channelGroups) {
    let config = null;
    try {
      config = buildStatementGenerationConfig({
        template: group.templateConfig.template,
        mappings: group.templateConfig.exportMappings,
        orderedTargetFields: group.templateConfig.exportTargetFields,
        allowManagedMerchantWithoutSelection: true
      });
    } catch (error) {
      if (!(error instanceof FileValidationError)) throw error;
    }
    if (!config) {
      collectGroupBalanceIssuesWithoutConfig(group, { conflictGroups, rowIssueGroups, issueLineBudget });
      continue;
    }
    try {
      resolveEntryBalancePlan({ config, fileEntries: group.entries, issueLineBudget });
    } catch (error) {
      if (error && error.code === 'CHANNEL_BALANCE_MODE_MISMATCH' && Array.isArray(error.conflictGroups)) {
        conflictGroups.push(...error.conflictGroups);
      } else if (error && error.code === 'CHANNEL_BALANCE_ROWS_INCOMPLETE' && Array.isArray(error.rowIssueGroups)) {
        rowIssueGroups.push(...error.rowIssueGroups);
      } else {
        throw error;
      }
    }
  }
  if (!conflictGroups.length && !rowIssueGroups.length) return null;
  const error = buildChannelBalancePlanningError(conflictGroups, rowIssueGroups);
  return createPreflightErrorResult({
    message: error.message,
    errorCode: error.code,
    detailLines: error.detailLines,
    logMessage: maskAccountLikeTextForLog(error.message, error.logMaskValues)
  });
}

function collectGroupBalanceIssuesWithoutConfig(group, { conflictGroups, rowIssueGroups, issueLineBudget }) {
  try {
    resolveEntryBalancePlan({
      config: { template: null, outputName: resolveGenerationGroupChannelName(group) },
      fileEntries: group.entries,
      issueLineBudget
    });
  } catch (error) {
    if (error && error.code === 'CHANNEL_BALANCE_MODE_MISMATCH' && Array.isArray(error.conflictGroups)) {
      conflictGroups.push(...error.conflictGroups);
      return;
    }
    if (error && error.code === 'CHANNEL_BALANCE_ROWS_INCOMPLETE' && Array.isArray(error.rowIssueGroups)) {
      rowIssueGroups.push(...error.rowIssueGroups);
      return;
    }
    throw error;
  }
}

// conflictGroups：见 buildBalanceModeConflictGroup。多个渠道时每行前加渠道名；conflictGroups 随错误带出，供多组规划汇总。
//   detailLines 逐账户列出（含账号）供界面弹窗；persistedDetailLines 只记渠道、冲突账户数与子模板，供错误报告与活动日志。
function buildChannelBalanceModeMismatchError(conflictGroups) {
  const groups = (Array.isArray(conflictGroups) ? conflictGroups : []).filter(Boolean);
  const channelNames = groups.map((item) => item.channelName);
  const detailLines = groups.length > 1
    ? groups.flatMap((item) => item.lines.map((line) => `渠道「${item.channelName}」${line}`))
    : groups.flatMap((item) => item.lines);
  // 不建议分开导入（release 审查）：同一账户同一天的交易拆成两批时，后一批只查目标日之前的种子、按前一日余额重算，
  //   再覆盖前一批写入的当日余额，两份交易不会累加
  const error = new FileValidationError(
    'CHANNEL_BALANCE_MODE_MISMATCH',
    `渠道${channelNames.map((name) => `「${name}」`).join('、')}下同一账户命中了余额方式不同的子模板，无法生成余额，请在映射关系管理中统一这些子模板的余额方式后整批重新导入`,
    { detailLines, context: { channelName: channelNames.join('、') } }
  );
  error.conflictGroups = groups;
  // 渠道名、子模板名由用户填写、可能以账号命名：落盘时其中的冲突账号与其他编号只写位数（release 审查）；
  //   logMaskValues 随错误带出，落盘的摘要、模板名与界面转写日志的摘要按同样的账号脱敏（见 createErrorResult）
  const accountValues = [...new Set(groups.flatMap((item) => (Array.isArray(item.accountValues) ? item.accountValues : [])))];
  const maskForLog = (text) => maskAccountLikeTextForLog(text, accountValues);
  error.logMaskValues = accountValues;
  error.persistedDetailLines = groups.map((item) => (
    `渠道「${maskForLog(item.channelName)}」：${item.accountCount} 个账户命中余额方式不同的子模板（${item.templateNames.map((name) => maskForLog(name)).join('、')}）`
  ));
  return error;
}

// v3.2.21：渠道出余额的交易缺账单日期或 MerchantId。rowIssueGroups：[{ channelName, lines, persistedLines, issueCount, accountValues }]；
//   多个渠道时每行前加渠道名；整批最多逐行列出 lineLimit 行，超出时补一行汇总（按原文件行去重后的总数）。
//   rowIssueGroups 随错误带出，供多组规划汇总。
function buildChannelBalanceRowsIncompleteError(rowIssueGroups, lineLimit = 200) {
  const groups = (Array.isArray(rowIssueGroups) ? rowIssueGroups : []).filter(Boolean);
  const channelNames = groups.map((item) => item.channelName);
  // 各组读到的账号：落盘的渠道名、摘要与模板名按它们整体脱敏（见 inspectBalanceEntryRows、createErrorResult）
  const accountValues = Array.from(new Set(groups.flatMap((item) => (Array.isArray(item.accountValues) ? item.accountValues : []))));
  const totalIssueCount = groups.reduce((sum, item) => sum + (Number(item.issueCount) || item.lines.length), 0);
  // channelLabel：落盘明细的渠道名同样只写编号位数（渠道名由用户填写、可能以账号命名，release 审查）
  const prefixed = (pick, channelLabel = (name) => name) => {
    const lines = (groups.length > 1
      ? groups.flatMap((item) => pick(item).map((line) => `渠道「${channelLabel(item.channelName)}」${line}`))
      : groups.flatMap((item) => pick(item))).slice(0, lineLimit);
    return totalIssueCount > lines.length
      ? lines.concat(`另有 ${totalIssueCount - lines.length} 行交易缺少账单日期或 MerchantId，未逐行列出（共 ${totalIssueCount} 行）`)
      : lines;
  };
  const error = new FileValidationError(
    'CHANNEL_BALANCE_ROWS_INCOMPLETE',
    `渠道${channelNames.map((name) => `「${name}」`).join('、')}出余额的子模板有交易缺少账单日期或 MerchantId，无法生成余额，请检查导入文件与映射`,
    { detailLines: prefixed((item) => item.lines), context: { channelName: channelNames.join('、') } }
  );
  error.rowIssueGroups = groups;
  error.persistedDetailLines = prefixed((item) => item.persistedLines, (name) => maskAccountLikeTextForLog(name, accountValues));
  error.logMaskValues = accountValues;
  return error;
}

// v3.2.21（D3）：多组规划（导入多组生成、补录重算、导出全部）收集到的渠道余额错误一并抛出。余额方式冲突优先：
//   冲突的渠道须统一余额方式后整批重新导入，缺字段的行修好后仍会被拦下。
function buildChannelBalancePlanningError(conflictGroups, rowIssueGroups) {
  return conflictGroups.length
    ? buildChannelBalanceModeMismatchError(conflictGroups)
    : buildChannelBalanceRowsIncompleteError(rowIssueGroups);
}

// preservesSession：在预检阶段（未开始导入）返回时为 true，界面只弹窗提示、保留上一批的导出与补录入口
function createChannelBalanceModeMismatchResult({ step, conflictGroups, templateName, preservesSession = false }) {
  const error = buildChannelBalanceModeMismatchError(conflictGroups);
  const result = createDetailedErrorResult({
    step,
    message: error.message,
    errorCode: error.code,
    detailLines: error.detailLines,
    persistedDetailLines: error.persistedDetailLines,
    logMaskValues: error.logMaskValues,
    context: error.context,
    templateName
  });
  return preservesSession ? { ...result, preservesSession: true } : result;
}

// v3.2.15（PR #246 审查）：不同生成分组的输出名称不能相同。普通模板与渠道同名时（模板包或旧数据可能带来），
//   两组的生成文件路径、明细 Channel 列与余额文件都相同，会互相覆盖。返回逐行明细，否则 null。
//   release/v3.2.15 审查补充：
//   - 名称按实际写盘文件名的口径比较：同 sanitizeFileName 替换非法字符、合并内部空白、去首尾空格，再按 Unicode NFC
//     规范化、不区分大小写（Windows / macOS 默认文件系统不区分大小写，APFS 不区分规范等价的写法）；
//   - 所有者按组身份（渠道 / 模板 ID）去重，不按显示文字，名称只差空格的两个模板仍算两个所有者；
//   - 除本批各组外，还核对库里所有同名的输出所有者（不属于任何渠道的普通模板、渠道，同类与异类都算）：
//     同名的两方分两批导入时，每批只有一组，只比本批会放行，后一批覆盖前一批的明细与余额文件。
//     属于渠道的子模板由渠道代表，不单独计数。库里只取各所有者的身份与名称（listStatementOutputOwners），
//     不用带映射、大账号统计的模板摘要查询，避免每次生成前同步重聚合全库。
function findGenerationGroupOutputNameConflicts(groups) {
  const statementOutputNameKey = (name) => sanitizeFileName(normalizeCell(name)).normalize('NFC').toLowerCase();
  const byName = new Map();
  const addOwner = (outputName, identity, label) => {
    const nameKey = statementOutputNameKey(outputName);
    if (!byName.has(nameKey)) byName.set(nameKey, { outputName, owners: new Map() });
    const record = byName.get(nameKey);
    if (!record.owners.has(identity)) record.owners.set(identity, label);
  };
  for (const group of Array.isArray(groups) ? groups : []) {
    if (!group || !group.templateConfig) continue;
    const outputName = resolveStatementOutputName(group.templateConfig.template);
    const isChannel = String(group.key).startsWith('channel:');
    addOwner(outputName, String(group.key),
      isChannel ? `渠道「${outputName}」` : `模板「${normalizeCell(group.templateConfig.template.name)}」`);
  }
  if (byName.size) {
    const owners = database.listStatementOutputOwners();
    for (const template of owners.templates) {
      if (byName.has(statementOutputNameKey(template.name))) {
        addOwner(template.name, `template:${template.id}`, `模板「${normalizeCell(template.name)}」`);
      }
    }
    for (const channel of owners.channels) {
      if (byName.has(statementOutputNameKey(channel.name))) {
        addOwner(channel.name, `channel:${channel.id}`, `渠道「${normalizeCell(channel.name)}」`);
      }
    }
  }
  const lines = Array.from(byName.values())
    .filter((record) => record.owners.size > 1)
    .map((record) => `输出名称「${record.outputName}」：${Array.from(record.owners.values()).join('、')}`);
  return lines.length ? lines : null;
}

function buildStatementOutputNameConflictError(detailLines) {
  return new FileValidationError(
    'STATEMENT_OUTPUT_NAME_CONFLICT',
    '有模板或渠道的输出名称相同（只差大小写、空格或文件名不允许的字符也算相同），生成的账单与余额会混在一起，请先在模板管理中重命名后再导入',
    { detailLines }
  );
}

// v3.2.15（release 复审）：每次生成前按本次实际使用的模板配置再核对一次。导入预检、大账号选择、补录确认等
//   等待期间模板或渠道可能被改名，生成时用的仍是之前记下的配置。身份取库里模板当前的归属（导入后移入渠道的模板
//   不与自己的渠道冲突），名称取本次实际写盘用的配置。虚拟模板（按文件名映射）不是库里的所有者，跳过。
//   可一次传入多个模板（多模板生成整批核对）。
function assertGenerationOutputNameUnique(templates) {
  const owners = (Array.isArray(templates) ? templates : [templates]).map((template) => {
    const templateId = Number(template && template.id);
    if (!(templateId > 0)) return null;
    const current = database.getTemplate(templateId);
    return { key: resolveGenerationGroupKey(current || template), templateConfig: { template } };
  }).filter(Boolean);
  if (!owners.length) return;
  const conflicts = findGenerationGroupOutputNameConflicts(owners);
  if (conflicts) throw buildStatementOutputNameConflictError(conflicts);
}

// v3.2.15（release 审查）：同一批各组的实际输出文件名不能相同。内部文件名为“输出名称-账号-…”，组内只有一个账号时才带账号，
//   不同的输出名称拼上账号后可能相同（如渠道「BANK-SG」只有账号 1001、模板「BANK-SG-1001」有多个账号），两组写到同一个文件，
//   汇总时一组数据丢失、另一组重复。plans 为各组 { config, preparedBatch }；scope 为 'all' 时文件名不带账号。
//   名称按写盘口径比较（同 findGenerationGroupOutputNameConflicts）。返回逐行明细，否则 null。
function findGenerationGroupOutputPathConflicts(plans, scope = 'current') {
  const byStem = new Map();
  for (const plan of Array.isArray(plans) ? plans : []) {
    const config = plan && plan.config;
    const template = config && config.template;
    if (!template) continue;
    const outputName = normalizeCell(config.outputName) || normalizeCell(template.name);
    const merchantId = scope === 'all' ? '' : normalizeCell(plan.preparedBatch && plan.preparedBatch.selectedMerchantId);
    const stem = merchantId ? `${outputName}-${merchantId}` : outputName;
    const stemKey = sanitizeFileName(stem).normalize('NFC').toLowerCase();
    const current = Number(template.id) > 0 ? database.getTemplate(template.id) : null;
    const identity = resolveGenerationGroupKey(current || template);
    const label = `${identity.startsWith('channel:') ? `渠道「${outputName}」` : `模板「${normalizeCell(template.name)}」`}`
      + (merchantId ? `（账号 ${merchantId}）` : '');
    if (!byStem.has(stemKey)) byStem.set(stemKey, { stem, owners: new Map() });
    const record = byStem.get(stemKey);
    if (!record.owners.has(identity)) record.owners.set(identity, label);
  }
  const lines = Array.from(byStem.values())
    .filter((record) => record.owners.size > 1)
    .map((record) => `文件名「${record.stem}」：${Array.from(record.owners.values()).join('、')}`);
  return lines.length ? lines : null;
}

function buildStatementOutputPathConflictError(detailLines) {
  return new FileValidationError(
    'STATEMENT_OUTPUT_NAME_CONFLICT',
    '有两组账单的输出名称拼上账号后文件名相同，生成的账单会互相覆盖，请先在模板管理中重命名后再导入',
    { detailLines }
  );
}

// 按文件名映射补录后重新生成余额前的分组规划：只读会话和模板配置，不写文件、不读种子。
//   补录在写入种子、登记断档之前用它核对各组实际输出文件名，再把同一份规划交给重新生成。
function planVirtualTemplateBalanceRegeneration(session, scope = 'all') {
  const generationGroups = groupStatementEntriesForGeneration(getStatementSessionEntries(session, scope));
  const groupPlans = [];
  const skippedGroups = [];
  const balanceModeConflictGroups = [];
  const balanceRowIssueGroups = [];
  const issueLineBudget = { remaining: 200 };
  // 其他组的错误（如映射失效）暂存，先完成各渠道的余额校验；有渠道余额错误时优先报出，否则照常抛出
  let otherError = null;
  for (const group of generationGroups) {
    const { entries: groupEntries, templateIds, templateConfig } = group;
    if (!templateConfig) {
      skippedGroups.push({ templateIds, fileCount: groupEntries.length });
      continue;
    }
    // 已确定整批失败后，单模板组不可能补充渠道余额诊断：不再读取配置
    if ((balanceModeConflictGroups.length || balanceRowIssueGroups.length || otherError) && !(templateIds.length > 1)) continue;

    let groupGenConfig = null;
    try {
      groupGenConfig = buildStatementGenerationConfig({
        template: templateConfig.template,
        mappings: templateConfig.exportMappings,
        orderedTargetFields: templateConfig.exportTargetFields,
        allowManagedMerchantWithoutSelection: true
      });
      // 已确定不会重算时，后面的组只校验（只扫描不复制），不再构建、保留批次
      if (balanceModeConflictGroups.length || balanceRowIssueGroups.length || otherError) {
        resolveEntryBalancePlan({ config: groupGenConfig, fileEntries: groupEntries, issueLineBudget });
        continue;
      }
      const groupPreparedBatch = buildPreparedStatementBatchFromEntries({
        config: groupGenConfig,
        fileEntries: groupEntries,
        issueLineBudget
      });
      // 写出前的检查（收支同时有值、账单日期等）在任何组写出余额与种子之前做完
      assertStatementBatchWritable({ config: groupGenConfig, preparedBatch: groupPreparedBatch, includeBalance: true });
      groupPlans.push({ config: groupGenConfig, preparedBatch: groupPreparedBatch });
    } catch (error) {
      // v3.2.21（D3）：补录重算同样汇总各渠道的冲突账户与缺字段的行，在写种子、生成之前一并阻断
      if (error && error.code === 'CHANNEL_BALANCE_MODE_MISMATCH' && Array.isArray(error.conflictGroups)) {
        balanceModeConflictGroups.push(...error.conflictGroups);
        continue;
      }
      if (error && error.code === 'CHANNEL_BALANCE_ROWS_INCOMPLETE' && Array.isArray(error.rowIssueGroups)) {
        balanceRowIssueGroups.push(...error.rowIssueGroups);
        continue;
      }
      // 只暂存业务校验错误；其他错误（如源文件在确认期间变化、系统异常）立即抛出，按原路径处理
      if (!(error instanceof FileValidationError)) throw error;
      if (!otherError) otherError = error;
      // 生成配置失败（如首个子模板映射失效）时，仍按会话中已映射的明细与各子模板当前的余额方式校验该渠道（账户冲突、缺字段的交易），各渠道一次列全
      if (!groupGenConfig) collectGroupBalanceIssuesWithoutConfig(group, { conflictGroups: balanceModeConflictGroups, rowIssueGroups: balanceRowIssueGroups, issueLineBudget });
    }
  }
  if (balanceModeConflictGroups.length || balanceRowIssueGroups.length) {
    throw buildChannelBalancePlanningError(balanceModeConflictGroups, balanceRowIssueGroups);
  }
  if (otherError) throw otherError;
  return { scope, generationGroups, groupPlans, skippedGroups };
}

function assertVirtualTemplateBalanceOutputPaths(regenerationPlan) {
  const outputPathConflicts = findGenerationGroupOutputPathConflicts(regenerationPlan.groupPlans, regenerationPlan.scope);
  if (outputPathConflicts) throw buildStatementOutputPathConflictError(outputPathConflicts);
}

// v1.5.2：虚拟 ID 下从 session 重新生成合并的余额文件（补录 seed 后调用）
function regenerateVirtualTemplateBalanceFromSession(
  session,
  scope = 'all',
  regenerationPlan = planVirtualTemplateBalanceRegeneration(session, scope)
) {
  const { generationGroups, groupPlans, skippedGroups } = regenerationPlan;
  const balancePaths = [];
  const billDates = [];
  const allWarnings = [];
  const skippedCount = skippedGroups.length;
  for (const { templateIds, fileCount } of skippedGroups) {
    appendActivityLogEntry({
      level: 'warn',
      message: `余额重新生成时跳过模板组（templateId=${templateIds.join('、')}）：模板已被删除，${fileCount} 个文件的数据未包含`
    });
  }
  // v3.2.15（release 审查）：先规划全部组，再核对各组实际输出文件名，任一组写出之前拦下。
  assertVirtualTemplateBalanceOutputPaths(regenerationPlan);

  for (const { config: groupGenConfig, preparedBatch: groupPreparedBatch } of groupPlans) {
    // 按本次重算的真实范围命名：只有一个模板组时这个文件直接作为该范围的余额，
    // 固定按全部范围生成会与“导出全部”同名，当前批次的余额随后被全部批次覆盖。
    const groupGeneratedFiles = generateStatementFiles({
      config: groupGenConfig,
      preparedBatch: groupPreparedBatch,
      scope,
      includeDetail: false,
      includeBalance: true
    });
    if (groupGeneratedFiles.balance) balancePaths.push(groupGeneratedFiles.balance.filePath);
    // 逐条合并：告警可能每行一条（如 v3.2.21 长数字提示），展开传参会超过函数参数上限
    if (Array.isArray(groupGeneratedFiles.warnings)) groupGeneratedFiles.warnings.forEach((warning) => allWarnings.push(warning));
    // v3.2.21：汇总文件按各组实际写出的余额记录日期命名（渠道组内不出余额的子模板的交易不算，与单组余额文件同口径）
    for (const date of (groupGeneratedFiles.balance && groupGeneratedFiles.balance.billDates) || []) billDates.push(date);
  }

  // 如果还有 group 需要 seed → 返回 prompt
  const seedWarning = extractManualBalancePromptWarning(allWarnings);
  if (seedWarning) {
    return { needsSeed: true, prompt: seedWarning.prompt, warnings: allWarnings };
  }
  // 任一模板组有待确认断档时不合并部分余额，统一询问。
  const balanceGaps = statementGenerationHelpers.extractBalanceGapConfirmGaps(allWarnings);
  if (balanceGaps.length) {
    return { needsSeed: true, gaps: balanceGaps, warnings: allWarnings };
  }
  // 余额不一致同样不合并部分余额，统一确认。
  const balanceMismatches = statementGenerationHelpers.extractBalanceMismatchConfirmItems(allWarnings);
  if (balanceMismatches.length) {
    return { needsSeed: true, mismatches: balanceMismatches, warnings: allWarnings };
  }
  const balanceSeedReplacements = statementGenerationHelpers.extractBalanceSeedReplaceConfirmItems(allWarnings);
  if (balanceSeedReplacements.length) {
    return { needsSeed: true, replacements: balanceSeedReplacements, warnings: allWarnings };
  }

  // 合并
  let mergedBalance = null;
  if (balancePaths.length > 1) {
    const dateRange = buildDateRangeLabel(billDates);
    const mergedFileName = `${generationGroups.length}-BALANCE-${dateRange || getToday()}.xlsx`;
    const { outputFilePath: mergedPath } = buildOutputFilePath({
      kind: 'balance',
      outputFileName: scopedMergedOutputFileName(mergedFileName, scope)
    });
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
  // v3.2.19：条目已按各自模板重建并注入大账号（如已去除重复账单）时为 true，组内不再重建
  entriesResolved = false,
  session,
  replacePaths,
  inputFilePaths
}) {
  // v3.2.15（T4）：按渠道 / 模板分组；渠道内各文件合为一份明细、一条余额链。
  const generationGroups = groupStatementEntriesForGeneration(fileEntries);

  // v3.2.15（release 复审）：预检后、生成前模板被删除时整批拦下。否则该组按首模板的配置生成，
  //   与首模板组写到同一个文件，汇总时一组数据丢失、另一组重复，导入仍显示成功。
  const deletedTemplateGroups = generationGroups.filter((group) => (
    !group.templateConfig && group.templateIds.some((templateId) => Number(templateId) > 0)
  ));
  if (deletedTemplateGroups.length) {
    throw new FileValidationError('TEMPLATE_NOT_FOUND', '导入期间有模板已被删除，请重新导入文件', {
      detailLines: deletedTemplateGroups.flatMap((group) => group.entries.map((entry) => (
        `文件：${path.basename(String(entry.filePath || ''))}（模板 ID：${Number(entry.matchedTemplateId) || ''}）`
      )))
    });
  }

  let lastBatchId = null;
  let lastGenerationTemplateConfig = null;
  const allDetailPaths = [];
  const allBalancePaths = [];
  const allFileEntries = [];
  const allBillDates = [];
  // v3.2.21：余额汇总文件按实际写出的余额记录日期命名（明细按全部明细日期）
  const allBalanceDates = [];
  const allWarnings = [];
  const groupPlans = [];
  const balanceModeConflictGroups = [];
  const balanceRowIssueGroups = [];
  const issueLineBudget = { remaining: 200 };

  const multiBigAccountMarker = `${FIXED_FIELD_VALUE_PREFIX}${MERCHANT_ID_MULTI_ACCOUNT_MARKER}`;
  const isMultiBigAccountConfig = (config) => normalizeCell((config.exportMappings || []).find(
    (m) => normalizeCell(m.templateField) === 'MerchantId'
  )?.mappedField) === multiBigAccountMarker;
  // 其他组的错误（如映射失效）暂存，先完成各渠道的余额校验；有渠道余额错误时优先报出，否则照常抛出
  let otherError = null;
  for (const group of generationGroups) {
    const groupEntries = group.entries;
    // 已确定整批失败后，单模板组不可能补充渠道余额诊断：不再读取配置
    if ((balanceModeConflictGroups.length || balanceRowIssueGroups.length || otherError) && !(group.templateIds.length > 1)) continue;
    try {
      // 同组多份文件命中同一子模板时只读取一次配置
      const entryTemplateConfigCache = new Map();
      const groupTemplateConfig = getEntryTemplateConfig({
        entry: groupEntries[0],
        fallbackTemplateConfig,
        cache: entryTemplateConfigCache
      });
      const groupFailed = balanceModeConflictGroups.length || balanceRowIssueGroups.length || otherError;

      // v3.2.15（T9）：渠道内各子模板的 MerchantId 映射可能不同。大账号注入由 rebuildMatchedTemplateFileEntries
      //   按各条目自己的子模板判断；组配置只在全部条目都是多大账号模板时带上所选大账号（它只决定输出文件名中的账号），
      //   混有固定账号子模板时不把所选大账号写进文件名。整批已失败时不再生成文件，不需要这项判断。
      const groupIsMultiBigAccount = !groupFailed && groupEntries.every((entry) => isMultiBigAccountConfig(
        getEntryTemplateConfig({ entry, fallbackTemplateConfig, cache: entryTemplateConfigCache })
      ));

      const groupConfig = buildStatementGenerationConfig({
        template: groupTemplateConfig.template,
        mappings: groupTemplateConfig.exportMappings,
        orderedTargetFields: groupTemplateConfig.exportTargetFields,
        selectedBigAccount: groupIsMultiBigAccount ? selectedBigAccount : null,
        allowManagedMerchantWithoutSelection: true
      });

      // v3.2.21（D3）：已确定整批失败后，只有余额方式不同的渠道组还需要校验（与 resolveEntryBalancePlan 的提前返回同口径，
      //   只看模板与映射、不读行），其余组不再重建条目
      if (groupFailed) {
        const templateConfigCache = new Map();
        const groupTemplateIds = new Set(groupEntries.map((entry) => Number(entry.matchedTemplateId || 0)));
        const groupModes = new Set(groupEntries.map((entry) => resolveEntryBalanceMode(entry, groupConfig, templateConfigCache).balanceMode));
        if (groupTemplateIds.size < 2 || groupModes.size < 2) continue;
        // 只为校验：只重建账号取自所选大账号的条目，其余沿用原条目（不复制明细），保持原文件顺序
        let checkEntries = groupEntries;
        if (selectedBigAccount && !entriesResolved) {
          const entryConfigCache = new Map();
          const pendingEntries = groupEntries.filter((entry) => entryUsesSelectedBigAccount(entry, groupTemplateConfig, entryConfigCache));
          if (pendingEntries.length) {
            const rebuiltEntries = rebuildMatchedTemplateFileEntries({
              fileEntries: pendingEntries,
              fallbackTemplateConfig: groupTemplateConfig,
              selectedBigAccount,
              reuseMappedRows
            });
            const rebuiltByEntry = new Map(pendingEntries.map((entry, index) => [entry, rebuiltEntries[index]]));
            checkEntries = groupEntries.map((entry) => rebuiltByEntry.get(entry) || entry);
          }
        }
        resolveEntryBalancePlan({ config: groupConfig, fileEntries: checkEntries, issueLineBudget });
        continue;
      }

      // 步骤 8 路径（selectedBigAccount 有值）：entries 来自步骤 3，MerchantId 未注入，需 rebuild
      // 大账号选择路径（selectedBigAccount 为 null）：entries 已由 applyBigAccountAssignments 注入，不 rebuild
      const effectiveEntries = selectedBigAccount && !entriesResolved
        ? rebuildMatchedTemplateFileEntries({
            fileEntries: groupEntries,
            fallbackTemplateConfig: groupTemplateConfig,
            selectedBigAccount,
            reuseMappedRows
          })
        : groupEntries;

      const groupPreparedBatch = buildPreparedStatementBatchFromEntries({
        config: groupConfig,
        fileEntries: effectiveEntries,
        issueLineBudget
      });
      // 写出前的检查（收支同时有值、账单日期等）在任何组写出、移除旧会话条目之前做完
      assertStatementBatchWritable({ config: groupConfig, preparedBatch: groupPreparedBatch });

      groupPlans.push({
        groupTemplateConfig,
        groupConfig,
        effectiveEntries,
        groupPreparedBatch
      });
    } catch (error) {
      // v3.2.21（D3）：各渠道的冲突账户与缺字段的行汇总后一并阻断（仍在副作用之前）
      if (error && error.code === 'CHANNEL_BALANCE_MODE_MISMATCH' && Array.isArray(error.conflictGroups)) {
        balanceModeConflictGroups.push(...error.conflictGroups);
        continue;
      }
      if (error && error.code === 'CHANNEL_BALANCE_ROWS_INCOMPLETE' && Array.isArray(error.rowIssueGroups)) {
        balanceRowIssueGroups.push(...error.rowIssueGroups);
        continue;
      }
      // 只暂存业务校验错误；其他错误（如源文件在确认期间变化、系统异常）立即抛出，按原路径交给任务归档与重新选择源文件的提示
      if (!(error instanceof FileValidationError)) throw error;
      if (!otherError) otherError = error;
    }
  }

  if (balanceModeConflictGroups.length || balanceRowIssueGroups.length) {
    throw buildChannelBalancePlanningError(balanceModeConflictGroups, balanceRowIssueGroups);
  }
  if (otherError) throw otherError;

  // 所有组先完成 source-stable 解析，再进入 session/输出副作用。
  // v3.2.15（release 复审）：进入副作用前，按各组实际生成用的配置整批核对输出名称。等待确认期间配置可能已变化，
  //   而组配置可能取自之前记下的配置（getEntryTemplateConfig 的 fallback），不能按库里当前配置核对；
  //   避免先改了会话（替换旧文件）、前几组已写出，后一组才被拦下。
  assertGenerationOutputNameUnique(groupPlans.map((plan) => plan.groupTemplateConfig && plan.groupTemplateConfig.template));
  const outputPathConflicts = findGenerationGroupOutputPathConflicts(
    groupPlans.map((plan) => ({ config: plan.groupConfig, preparedBatch: plan.groupPreparedBatch }))
  );
  if (outputPathConflicts) throw buildStatementOutputPathConflictError(outputPathConflicts);
  if (Array.isArray(replacePaths)) {
    replacePaths.forEach((filePath) => {
      removeStatementSessionEntriesByFilePath(session, filePath);
    });
  }

  for (const {
    groupTemplateConfig,
    groupConfig,
    effectiveEntries,
    groupPreparedBatch
  } of groupPlans) {

    const groupGeneratedFiles = {
      ...generateStatementFiles({ config: groupConfig, preparedBatch: groupPreparedBatch, scope: 'current' }),
      fileEntries: effectiveEntries,
      preparedBatch: groupPreparedBatch
    };

    if (groupGeneratedFiles.detail) allDetailPaths.push(groupGeneratedFiles.detail.filePath);
    if (groupGeneratedFiles.balance) allBalancePaths.push(groupGeneratedFiles.balance.filePath);
    for (const date of (groupGeneratedFiles.balance && groupGeneratedFiles.balance.billDates) || []) allBalanceDates.push(date);
    // 逐条合并：告警可能每行一条（如 v3.2.21 长数字提示），展开传参会超过函数参数上限
    if (Array.isArray(groupGeneratedFiles.warnings)) groupGeneratedFiles.warnings.forEach((warning) => allWarnings.push(warning));
    // v3.2.21：明细汇总按各组写出明细时确定的日期命名（剔除跳过的零金额行，与单组明细文件、另存为默认文件名同口径）；
    //   逐个追加，展开成参数在大批量时会超出调用栈
    for (const date of (groupGeneratedFiles.detail && groupGeneratedFiles.detail.billDates) || []) allBillDates.push(date);

    lastGenerationTemplateConfig = groupTemplateConfig;
    allFileEntries.push(...effectiveEntries);
  }

  // 合并多组文件为汇总文件，命名：组数-COMMON/BALANCE-日期范围.xlsx（渠道按一组计）
  const templateCount = generationGroups.length;
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

  // 任一模板组还需补录或确认断档时不合并、不缓存余额：汇总只含已算出的组，文件名却按全部模板计数。
  // 已算出的组照常写出各自的余额文件和计算种子，补录或不补录后按全部模板组重算（断档 spec §4.2 第 1 条）。
  const balancePending = allWarnings.some(
    (w) => w.type === 'balance-seed-required' || w.type === 'balance-gap-confirm'
      || w.type === 'balance-mismatch-confirm' || w.type === 'balance-seed-replace-confirm'
  );
  const mergeableBalancePaths = balancePending ? [] : allBalancePaths;
  const mergedBalance = mergeableBalancePaths.length > 1
    ? (() => {
        const mergedFileName = `${templateCount}-BALANCE-${buildDateRangeLabel(allBalanceDates) || getToday()}.xlsx`;
        const { outputFilePath: mergedPath } = buildOutputFilePath({ kind: 'balance', outputFileName: mergedFileName });
        mergeGeneratedXlsxFiles(mergeableBalancePaths, mergedPath);
        return { filePath: mergedPath, fileName: mergedFileName, templateName: '按文件名映射模板' };
      })()
    : mergeableBalancePaths.length === 1
      ? { filePath: mergeableBalancePaths[0], fileName: path.basename(mergeableBalancePaths[0]), templateName: '按文件名映射模板' }
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
    balanceRequested: allBalancePaths.length > 0 || balancePending
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
      readRowsWithMetadata(filePath, headers, {
        readGuard: createStatementWorkbookReadGuard(filePath)
      });
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

  // 过滤子集匹配：多个模板匹配时，只保留有效表头最多的（最精确匹配）。
  // v3.2.15（release 审查）：按非空表头计数。模板表头保留合并单元格占位的中间空列（K1）后，空占位不能算作精确度，
  //   否则空列多、有效字段少的模板（借去空口径匹配上）会挤掉有效字段更多的正确模板，漏读其余列。
  if (matches.length > 1) {
    const effectiveHeaderCount = (template) => (template.headers || []).filter((header) => normalizeCell(header) !== '').length;
    const maxHeaderCount = Math.max(...matches.map(effectiveHeaderCount));
    return matches.filter((template) => effectiveHeaderCount(template) === maxHeaderCount);
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
  assertGenerationOutputNameUnique(context && context.template);
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

function cacheAllStatementExport(kind, generatedFile, balanceWarnings = []) {
  statementGenerationHelpers.cacheAllStatementExport(lastGeneratedExports, kind, generatedFile, balanceWarnings);
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
  // v3.2.21（D2）：另存为默认文件名的日期范围与生成时的文件名同口径（release 审查）：先按全部明细行校验账单日期（原有检查），
  //   再按实际写出的行取日期——剔除收支都为空或 0 的行（生成时跳过）；明细没有其他行时按全部明细行；
  //   余额只取出余额账户的行（balanceRowsByAccountMode 时按账户方式表取行引用，与生成同口径），组内都不出余额或没有
  //   出余额的交易时不计
  const exportNamingDatesOf = (preparedBatch) => {
    const detailDates = parseRequiredBillDates(preparedBatch.detailRows);
    const balanceKind = kind === 'balance';
    if (balanceKind && preparedBatch.balanceRequested === false) return [];
    const sourceRows = balanceKind && preparedBatch.balanceRowsByAccountMode
      ? selectBalanceAccountRows(preparedBatch.detailRows, preparedBatch.balanceModeByAccount)
      : preparedBatch.detailRows;
    // 只取写出的行的引用（isDetailExportAmountRow，与 buildDetailExportRows 同一判断），不复制行
    const header = Array.isArray(sourceRows[0]) ? sourceRows[0] : [];
    const creditIndex = header.findIndex((field) => normalizeCell(field) === 'Credit Amount');
    const debitIndex = header.findIndex((field) => normalizeCell(field) === 'Debit Amount');
    const writtenRows = [header];
    for (let index = 1; index < sourceRows.length; index += 1) {
      const row = Array.isArray(sourceRows[index]) ? sourceRows[index] : [];
      if (isDetailExportAmountRow(row[creditIndex], row[debitIndex], { hasCredit: creditIndex >= 0, hasDebit: debitIndex >= 0 })) {
        writtenRows.push(row);
      }
    }
    if (writtenRows.length > 1) return parseRequiredBillDates(writtenRows);
    return balanceKind ? [] : detailDates;
  };
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
    const generationGroups = groupStatementEntriesForGeneration(getStatementSessionEntries(session, 'all'));
    const validGroups = [];
    const allDates = [];
    const balanceModeConflictGroups = [];
    const balanceRowIssueGroups = [];
    const issueLineBudget = { remaining: 200 };
    // 其他组的错误（如映射缺字段）暂存，先完成各渠道的余额校验；有渠道余额错误时优先返回，否则照常抛出
    let otherError = null;
    for (const group of generationGroups) {
      const { entries, templateConfig } = group;
      if (!templateConfig) continue;
      // 已确定整批失败后，单模板组不可能补充渠道余额诊断：不再读取配置
      if ((balanceModeConflictGroups.length || balanceRowIssueGroups.length || otherError) && !(group.templateIds.length > 1)) continue;
      let config;
      try {
        config = buildStatementGenerationConfig({
          template: templateConfig.template,
          mappings: templateConfig.exportMappings,
          orderedTargetFields: templateConfig.exportTargetFields,
          allowManagedMerchantWithoutSelection: true
        });
      } catch (error) {
        if (!(error instanceof FileValidationError)) throw error;
        if (!otherError) otherError = error;
        // 生成配置失败（如首个子模板映射失效）时，仍按会话中已映射的明细与各子模板当前的余额方式校验该渠道（账户冲突、缺字段的交易），各渠道一次列全
        collectGroupBalanceIssuesWithoutConfig(group, { conflictGroups: balanceModeConflictGroups, rowIssueGroups: balanceRowIssueGroups, issueLineBudget });
        continue;
      }
      // v3.2.21（D3）：导出全部前，各渠道的余额方式冲突与出余额的交易缺字段汇总后一并列出（冲突优先），不弹另存为框。
      //   已有这类错误时导出不会继续：后面的组只校验（resolveEntryBalancePlan，只扫描不复制），不再构建批次、算日期
      //   只暂存业务校验错误；其他错误（系统异常等）立即抛出
      const collectChannelBalanceError = (error) => {
        if (error && error.code === 'CHANNEL_BALANCE_MODE_MISMATCH' && Array.isArray(error.conflictGroups)) {
          balanceModeConflictGroups.push(...error.conflictGroups);
          return true;
        }
        if (error && error.code === 'CHANNEL_BALANCE_ROWS_INCOMPLETE' && Array.isArray(error.rowIssueGroups)) {
          balanceRowIssueGroups.push(...error.rowIssueGroups);
          return true;
        }
        if (!(error instanceof FileValidationError)) throw error;
        return false;
      };
      if (balanceModeConflictGroups.length || balanceRowIssueGroups.length || otherError) {
        try {
          resolveEntryBalancePlan({ config, fileEntries: entries, issueLineBudget });
        } catch (error) {
          if (!collectChannelBalanceError(error) && !otherError) otherError = error;
        }
        continue;
      }
      let preparedBatch;
      let dates;
      try {
        preparedBatch = buildPreparedStatementBatchFromEntries({ config, fileEntries: entries, issueLineBudget });
        // 日期解析失败（如单独成组的文件没有有效账单日期）同样暂存，不遮住后面渠道的余额错误
        dates = exportNamingDatesOf(preparedBatch);
      } catch (error) {
        if (!collectChannelBalanceError(error) && !otherError) otherError = error;
        continue;
      }
      // 逐个追加：每笔交易一个日期，展开成参数在大批量时会超出调用栈
      for (const date of dates) allDates.push(date);
      validGroups.push({ config, dates });
    }
    if (balanceModeConflictGroups.length || balanceRowIssueGroups.length) {
      const error = buildChannelBalancePlanningError(balanceModeConflictGroups, balanceRowIssueGroups);
      return {
        stopResult: createPreflightErrorResult({
          message: error.message,
          errorCode: error.code,
          detailLines: error.detailLines,
          // 渠道名可能以账号命名：状态框转写活动日志时只写编号位数（release 审查）
          logMessage: maskAccountLikeTextForLog(error.message, error.logMaskValues)
        }),
        normalizedScope,
        session
      };
    }
    if (otherError) throw otherError;
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
      defaultFileName = `${generationGroups.length}-${kind === 'detail' ? 'COMMON' : 'BALANCE'}-${buildDateRangeLabel(allDates) || getToday()}.xlsx`;
    } else {
      defaultFileName = `${validGroups[0].config.outputName}-${kind === 'detail' ? 'COMMON' : 'BALANCE'}-${buildDateRangeLabel(validGroups[0].dates) || getToday()}.xlsx`;
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
    defaultFileName = `${resolveStatementOutputName(generationTemplateConfig.template)}-${kind === 'detail' ? 'COMMON' : 'BALANCE'}-${buildDateRangeLabel(exportNamingDatesOf(preparedBatch)) || getToday()}.xlsx`;
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
  // 导出全部余额会重新生成：记下本次重算的告警，导出成功后带出已接受的风险。
  // 命中“全部”余额缓存时取随文件缓存的告警（重算后再次导出、确认后重算再导出）。
  let exportBalanceWarnings = kind === 'balance' && normalizedScope === 'all' &&
    generatedFile && Array.isArray(generatedFile.balanceWarnings)
    ? generatedFile.balanceWarnings
    : [];

  if (!generatedFile && normalizedScope === 'all') {
    if (!session) {
      return createErrorResult({
        step: kind === 'detail' ? '导出明细账单' : '导出余额账单',
        message: emptyMessage,
        errorCode: 'EXPORT_EMPTY'
      });
    }

    // v1.5.2：虚拟 ID 按生成分组（v3.2.15 起渠道合为一组），每组用组配置生成，最后合并
    if (isVirtualTemplate) {
      const allEntries = getStatementSessionEntries(session, 'all');
      const generationGroups = groupStatementEntriesForGeneration(allEntries);
      // v3.2.15：导入后若经模板包等途径使普通模板与渠道同名，导出全部同样阻断。
      const outputNameConflicts = findGenerationGroupOutputNameConflicts(generationGroups);
      if (outputNameConflicts) {
        const error = buildStatementOutputNameConflictError(outputNameConflicts);
        return createErrorResult({
          step: kind === 'detail' ? '导出明细账单' : '导出余额账单',
          message: error.message,
          errorCode: error.code,
          detailLines: outputNameConflicts,
          templateName: session.templateName
        });
      }
      const perGroupPaths = []; // [{detail, balance, warnings}]
      const exportBillDates = [];
      const skippedGroupNames = [];
      let lastGroupTemplateConfig = null;
      // v3.2.21（D3）：先按执行时的配置校验全部组（resolveEntryBalancePlan，只扫描不复制），渠道余额方式冲突（各渠道的
      //   冲突账户一并列出）与出余额的交易缺字段汇总后一并阻断；全部通过后才逐组构建批次（复用该组校验得到的方案）、
      //   记上下文、写出文件与种子，不会前几组已写出、后一组才失败
      const exportGroupPlans = [];
      const balanceModeConflictGroups = [];
      const balanceRowIssueGroups = [];
      const issueLineBudget = { remaining: 200 };
      // 其他组的错误（如映射缺字段）暂存，先完成各渠道的余额校验；有渠道余额错误时优先返回，否则照常抛出
      let otherError = null;
      for (const group of generationGroups) {
        const { entries: groupEntries, templateIds, templateConfig } = group;
        if (!templateConfig) {
          appendActivityLogEntry({
            level: 'warn',
            message: `导出时跳过模板组（templateId=${templateIds.join('、')}）：模板已被删除，${groupEntries.length} 个文件的数据未包含在导出中`
          });
          skippedGroupNames.push(`模板ID=${templateIds.join('、')}（${groupEntries.length}个文件）`);
          continue;
        }
        // 已确定整批失败后，单模板组不可能补充渠道余额诊断：不再读取配置
        if ((balanceModeConflictGroups.length || balanceRowIssueGroups.length || otherError) && !(templateIds.length > 1)) continue;
        let groupGenConfig;
        let balancePlan;
        try {
          groupGenConfig = buildStatementGenerationConfig({
            template: templateConfig.template,
            mappings: templateConfig.exportMappings,
            orderedTargetFields: templateConfig.exportTargetFields,
            allowManagedMerchantWithoutSelection: true
          });
          balancePlan = resolveEntryBalancePlan({ config: groupGenConfig, fileEntries: groupEntries, issueLineBudget });
          // 已确定不会写出时只需补全渠道余额诊断：不再做写出检查、不保留方案
          if (balanceModeConflictGroups.length || balanceRowIssueGroups.length || otherError) continue;
          // 写出前的检查（收支同时有值、账单日期等）同样在任何组写出之前做完（只扫描条目，不构建批次）
          assertStatementEntriesWritable({
            config: groupGenConfig,
            fileEntries: groupEntries,
            balancePlan,
            includeBalance: kind === 'balance'
          });
        } catch (error) {
          if (error && error.code === 'CHANNEL_BALANCE_MODE_MISMATCH' && Array.isArray(error.conflictGroups)) {
            balanceModeConflictGroups.push(...error.conflictGroups);
            continue;
          }
          if (error && error.code === 'CHANNEL_BALANCE_ROWS_INCOMPLETE' && Array.isArray(error.rowIssueGroups)) {
            balanceRowIssueGroups.push(...error.rowIssueGroups);
            continue;
          }
          // 只暂存业务校验错误；其他错误（系统异常等）立即抛出
          if (!(error instanceof FileValidationError)) throw error;
          if (!otherError) otherError = error;
          // 生成配置失败（如首个子模板映射失效）时，仍按会话中已映射的明细与各子模板当前的余额方式校验该渠道（账户冲突、缺字段的交易），各渠道一次列全
          if (!groupGenConfig) collectGroupBalanceIssuesWithoutConfig(group, { conflictGroups: balanceModeConflictGroups, rowIssueGroups: balanceRowIssueGroups, issueLineBudget });
          continue;
        }
        // 只记配置与条目引用，写出时再逐组构建批次（不同时持有全部组的明细副本）
        exportGroupPlans.push({ templateConfig, groupGenConfig, groupEntries, balancePlan });
      }
      if (balanceModeConflictGroups.length || balanceRowIssueGroups.length) {
        const error = buildChannelBalancePlanningError(balanceModeConflictGroups, balanceRowIssueGroups);
        return createDetailedErrorResult({
          step: kind === 'detail' ? '导出明细账单' : '导出余额账单',
          message: error.message,
          errorCode: error.code,
          detailLines: error.detailLines,
          persistedDetailLines: error.persistedDetailLines,
          logMaskValues: error.logMaskValues,
          context: error.context,
          templateName: session.templateName
        });
      }
      if (otherError) throw otherError;
      for (const { templateConfig, groupGenConfig, groupEntries, balancePlan } of exportGroupPlans) {
        lastGroupTemplateConfig = templateConfig;
        const tid = templateConfig.template.id;
        const groupPreparedBatch = buildPreparedStatementBatchFromEntries({
          config: groupGenConfig,
          fileEntries: groupEntries,
          balancePlan
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

        // v3.2.21：汇总文件按各组实际写出的余额记录 / 明细行的日期命名（与单组文件、另存为默认文件名同口径）；逐个追加
        const generatedFileOfKind = kind === 'balance' ? groupGeneratedFiles.balance : groupGeneratedFiles.detail;
        for (const date of (generatedFileOfKind && generatedFileOfKind.billDates) || []) exportBillDates.push(date);
        perGroupPaths.push({
          // 渠道组按渠道名列出（与输出文件、余额银行名同口径），普通模板为模板名。
          templateName: groupGenConfig.outputName || templateConfig.template.name,
          detail: groupGeneratedFiles.detail ? groupGeneratedFiles.detail.filePath : null,
          balance: groupGeneratedFiles.balance ? groupGeneratedFiles.balance.filePath : null,
          warnings: groupGeneratedFiles.warnings || []
        });
      }

      // 循环结束后统一检查 balance-seed-required（补录后重新导出时 seed 已持久化）
      if (kind === 'balance') {
        const allGroupWarnings = perGroupPaths.flatMap((g) => g.warnings || []);
        const manualBalanceWarning = extractManualBalancePromptWarning(allGroupWarnings);
        const balanceGaps = statementGenerationHelpers.extractBalanceGapConfirmGaps(allGroupWarnings);
        const balanceMismatches = statementGenerationHelpers.extractBalanceMismatchConfirmItems(allGroupWarnings);
        const balanceSeedReplacements = statementGenerationHelpers.extractBalanceSeedReplaceConfirmItems(allGroupWarnings);
        if ((manualBalanceWarning || balanceGaps.length || balanceMismatches.length || balanceSeedReplacements.length)
            && lastGroupTemplateConfig) {
          // 循环里逐组记下的是单模板上下文；补录或不补录后须按全部模板组重算，否则只剩最后一组。
          rememberLastFileImportContext(createGenerationContext({
            templateId: FILENAME_MAPPING_TEMPLATE_ID,
            template: lastGroupTemplateConfig.template,
            mappings: lastGroupTemplateConfig.exportMappings,
            orderedTargetFields: lastGroupTemplateConfig.exportTargetFields,
            scope: 'all',
            statementSessionKey: session.key,
            currentBatchId: session.currentBatchId
          }));
        }
        if (manualBalanceWarning) {
          return buildManualBalanceRequiredResult(manualBalanceWarning.prompt, {
            warnings: allGroupWarnings,
            balance: null,
            detail: null,
            balanceRequested: true
          });
        }
        if (balanceGaps.length) {
          return buildBalanceGapConfirmResult(balanceGaps, { balance: null, detail: null });
        }
        if (balanceMismatches.length) {
          return buildBalanceMismatchConfirmResult(balanceMismatches, { balance: null, detail: null });
        }
        if (balanceSeedReplacements.length) {
          return buildBalanceSeedReplaceConfirmResult(balanceSeedReplacements, { balance: null, detail: null });
        }
        // 任一模板组余额生成失败（如某日未找到期末余额）时阻断：否则合并结果缺这些组的账户，仍显示导出成功。
        const failedGroupLines = perGroupPaths
          .map((group) => ({
            templateName: group.templateName,
            messages: (group.warnings || [])
              .filter((warning) => warning && warning.type === 'balance-generate-failed')
              .map((warning) => warning.message)
          }))
          .filter((group) => group.messages.length > 0)
          .map((group) => `${group.templateName}：${group.messages.join('；')}`);
        if (failedGroupLines.length) {
          return createErrorResult({
            step: '导出余额账单',
            message: `余额账单未导出：${failedGroupLines.length} 个模板组的余额生成失败，导出全部会缺少这些组的账户余额，请处理后重新导出`,
            errorCode: 'EXPORT_EMPTY',
            detailLines: failedGroupLines,
            templateName: session.templateName
          });
        }
        exportBalanceWarnings = allGroupWarnings;
      }

      // 合并多组文件，命名：模板数量-COMMON/BALANCE-日期范围.xlsx
      const targetPaths = perGroupPaths.map((g) => kind === 'detail' ? g.detail : g.balance).filter(Boolean);
      if (targetPaths.length > 1) {
        const exportDateRange = buildDateRangeLabel(exportBillDates);
        const outputTag = kind === 'detail' ? 'COMMON' : 'BALANCE';
        const mergedFileName = `${generationGroups.length}-${outputTag}-${exportDateRange || getToday()}.xlsx`;
        const { outputFilePath: mergedPath } = buildOutputFilePath({
          kind,
          outputFileName: scopedMergedOutputFileName(mergedFileName, 'all')
        });
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
        const incompleteMessage = `文件已导出，但数据不完整：${skippedGroupNames.join('、')} 的模板已被删除，对应文件未包含在导出中`;
        if (exportResult.status === 'success') {
          exportResult.message = `${incompleteMessage}。`;
        }
        return kind === 'balance'
          ? withAcceptedBalanceRiskWarnings(exportResult, exportBalanceWarnings, session.templateName || '', incompleteMessage)
          : exportResult;
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

      // v3.2.15（release 审查）：导入后模板可能已改名，与库里的渠道或其他普通模板输出名称相同；重新生成前同样阻断。
      const exportAllOutputNameConflicts = findGenerationGroupOutputNameConflicts([
        { key: resolveGenerationGroupKey(generationTemplateConfig.template), templateConfig: generationTemplateConfig }
      ]);
      if (exportAllOutputNameConflicts) {
        const error = buildStatementOutputNameConflictError(exportAllOutputNameConflicts);
        return createErrorResult({
          step: kind === 'detail' ? '导出明细账单' : '导出余额账单',
          message: error.message,
          errorCode: error.code,
          detailLines: exportAllOutputNameConflicts,
          templateName: session.templateName
        });
      }

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
        const balanceGaps = statementGenerationHelpers.extractBalanceGapConfirmGaps(generatedFiles.warnings);
        if (balanceGaps.length) {
          return buildBalanceGapConfirmResult(balanceGaps, generatedFiles);
        }
        const balanceMismatches = statementGenerationHelpers.extractBalanceMismatchConfirmItems(generatedFiles.warnings);
        if (balanceMismatches.length) {
          return buildBalanceMismatchConfirmResult(balanceMismatches, generatedFiles);
        }
        const balanceSeedReplacements = statementGenerationHelpers.extractBalanceSeedReplaceConfirmItems(generatedFiles.warnings);
        if (balanceSeedReplacements.length) {
          return buildBalanceSeedReplaceConfirmResult(balanceSeedReplacements, generatedFiles);
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

        cacheAllStatementExport('balance', generatedFiles.balance, generatedFiles.warnings);
        generatedFile = generatedFiles.balance;
        exportBalanceWarnings = generatedFiles.warnings || [];
      }
    }
  }

  const exportResult = await exportGeneratedFile(
    generatedFile,
    emptyMessage,
    kind === 'detail' ? '导出明细账单' : '导出余额账单',
    savePath
  );
  return kind === 'balance'
    ? withAcceptedBalanceRiskWarnings(exportResult, exportBalanceWarnings, generatedFile?.templateName || session?.templateName || '')
    : exportResult;
}

// v3.2.16（Codex 审查）：导出全部余额重新生成时，本次重算中已接受的风险——断档未补录、已确认的余额不一致、
// 已确认替换人工补录——随导出结果告警并可导出报错文件，不只提示“文件导出成功”。
function withAcceptedBalanceRiskWarnings(exportResult, warnings, templateName, leadMessage = '文件导出成功') {
  const acceptedTypes = ['balance-gap-skipped', 'balance-mismatch-confirmed', 'balance-seed-replace-confirmed'];
  const accepted = (Array.isArray(warnings) ? warnings : [])
    .filter((warning) => warning && acceptedTypes.includes(warning.type));
  if (!exportResult || exportResult.status !== 'success' || !accepted.length) return exportResult;
  const countOf = (type, field) => accepted
    .filter((warning) => warning.type === type)
    .reduce((sum, warning) => sum + (Array.isArray(warning[field]) ? warning[field].length : 0), 0);
  const parts = [
    [countOf('balance-gap-skipped', 'gaps'), (count) => `${count}处账单日期不连续未补录，余额可能不准确`],
    [countOf('balance-mismatch-confirmed', 'mismatches'), (count) => `${count}处余额校验不一致，已按账单余额生成`],
    [countOf('balance-seed-replace-confirmed', 'replacements'), (count) => `${count}处人工补录余额已按本次余额替换`]
  ].filter(([count]) => count > 0).map(([count, text]) => text(count));
  const warningResult = createWarningResult({
    step: '导出余额账单',
    message: `${leadMessage}，${parts.join('，')}，请点击状态框导出报错文件`,
    balanceReady: true,
    detailLines: buildImportWarningDetailLines(accepted),
    context: { templateName, filePath: exportResult.filePath },
    errorCode: 'EXPORT_BALANCE_WARNING',
    templateName
  });
  return { ...warningResult, filePath: exportResult.filePath };
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
        template,
        filePlan: {
          version: 1,
          allocation: 'eager',
          inputs: [{
            filePath: result.filePaths[0],
            role: 'input',
            sourceOperation: 'big-account:import-bank-info'
          }],
          outputs: []
        }
      };
    },
    async execute(_event, prepared, taskContext) {
    const { template } = prepared;
    const selectedPath = taskContext.fileEvidence.filePlan.inputs[0].filePath;
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

  // v3.2.17：补录余额「导入余额文件」——选择余额文件，按当前补录提示的待补录账号（银行账号 + 币种）提取上一账单日余额，
  //   返回给补录弹窗的「余额确认」视图。只读预检：不写种子、不改补录 prompt 与生成缓存；确认后由渲染层逐个账号
  //   沿用 file:save-balance-seed 写入（主进程照常只接受当前 prompt 指向的账号并校验）。
  ipcMain.handle('file:import-balance-seed-file', async () => {
    const pendingPrompt = lastManualBalancePrompt;
    const pendingAccounts = pendingPrompt && !pendingPrompt.reason && !pendingPrompt.seedMismatch
      && Array.isArray(pendingPrompt.pendingAccounts)
      ? pendingPrompt.pendingAccounts
      : [];
    if (!pendingAccounts.length) {
      return {
        status: 'error',
        errorCode: 'BALANCE_IMPORT_NO_PENDING_ACCOUNT',
        message: '当前没有待补录的账号，请重新生成余额'
      };
    }
    const choice = await showImportOpenDialog('balance-seed-file', {
      title: '选择余额文件',
      properties: ['openFile'],
      filters: statementFileDialogFilters()
    });
    const filePath = !choice.canceled && Array.isArray(choice.filePaths) ? choice.filePaths[0] : '';
    if (!filePath) return { status: 'cancelled' };
    const fileName = path.basename(filePath);
    try {
      const { rows, displayRows, date1904 } = readBalanceSeedImportFile(filePath);
      const { records, skippedRowCount } = parseBalanceSeedImportRows(rows, { displayRows, date1904 });
      const matched = matchBalanceSeedImport(records, pendingAccounts);
      appendActivityLogEntry({
        level: 'info',
        message: '导入余额文件，等待确认补录余额',
        details: [
          `文件：${fileName}`,
          `模板名：${pendingPrompt.templateName || 'N/A'}`,
          `待补录账号：${matched.accounts.length} 个`,
          `从文件提取：${matched.matchedCount} 个`,
          `需手工录入：${matched.manualCount} 个`,
          ...(skippedRowCount ? [`跳过无效行：${skippedRowCount} 行`] : [])
        ]
      });
      return {
        status: 'success',
        fileName,
        templateName: pendingPrompt.templateName || '',
        skippedRowCount,
        ...matched
      };
    } catch (error) {
      if (error instanceof FileValidationError) {
        return {
          status: 'error',
          errorCode: error.code,
          message: error.message,
          detailLines: Array.isArray(error.detailLines) ? error.detailLines : []
        };
      }
      const logPath = appendLog(ensureStorageRoot(), error);
      return {
        status: 'error',
        errorCode: 'BALANCE_IMPORT_RUNTIME',
        message: '余额文件读取失败',
        detailLines: [`日志文件：${logPath}`]
      };
    }
  });

  // v3.2.16 模板管理【余额管理】：按渠道 / 普通模板查看余额种子，修改余额、删除单条种子。
  ipcMain.handle('balance-seed:list', (_event, owner) => {
    try {
      return {
        status: 'success',
        ...listOwnerSeeds({ database, storageRoot: ensureStorageRoot(), owner })
      };
    } catch (error) {
      return createBalanceSeedManagementErrorResult('读取余额种子', error, { owner });
    }
  });

  supportIpcHandle('balance-seed:update', '修改余额种子', (_event, rawPayload) => {
    const payload = normalizeBalanceSeedPayload(rawPayload);
    try {
      const result = updateOwnerSeed({ database, storageRoot: ensureStorageRoot(), payload });
      if (result.status === 'success' && result.changed) {
        appendActivityLogEntry({ level: 'info', ...buildBalanceSeedActivityLog('update', result) });
      }
      return result;
    } catch (error) {
      return createBalanceSeedManagementErrorResult('修改余额种子', error, { key: payload.key, owner: payload.owner });
    }
  });

  supportIpcHandle('balance-seed:delete', '删除余额种子', (_event, rawPayload) => {
    const payload = normalizeBalanceSeedPayload(rawPayload);
    try {
      const result = deleteOwnerSeed({ database, storageRoot: ensureStorageRoot(), payload });
      if (result.status === 'success') {
        appendActivityLogEntry({ level: 'info', ...buildBalanceSeedActivityLog('delete', result) });
      }
      return result;
    } catch (error) {
      return createBalanceSeedManagementErrorResult('删除余额种子', error, { key: payload.key, owner: payload.owner });
    }
  });
}

// 非对象载荷（如 null）按空对象处理，由服务返回结构化的业务错误。
function normalizeBalanceSeedPayload(payload) {
  return payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
}

// 选项失效、余额非法、种子文件损坏等按业务错误返回原因；其余按系统错误生成报错文件。
function createBalanceSeedManagementErrorResult(step, error, context = {}) {
  if (error instanceof BalanceSeedManagementError || error instanceof FileValidationError) {
    return createDetailedErrorResult({
      step,
      message: error.message,
      errorCode: error.code || 'BALANCE_SEED_MANAGEMENT_FAILED',
      detailLines: Array.isArray(error.detailLines) ? error.detailLines : [],
      context: { ...context, ...(error.context || {}) }
    });
  }
  return createErrorResult({
    step,
    message: `${step}失败，请导出报错文件查看详情`,
    errorCode: 'BALANCE_SEED_MANAGEMENT_RUNTIME',
    errorType: '系统错误',
    originalError: error,
    context
  });
}

function findBigAccountMatchInRows(
  rawRows,
  startIndex,
  endIndex,
  merchantIds,
  allowSubstringMatch = true
) {
  let bestMatch = null;
  for (let rowIndex = Math.min(endIndex, rawRows.length - 1); rowIndex >= startIndex; rowIndex -= 1) {
    const row = rawRows[rowIndex];
    if (!Array.isArray(row)) continue;
    for (const cell of row) {
      const cellText = normalizeCell(cell);
      if (!cellText) continue;
      for (const merchantId of merchantIds) {
        const matchType = matchMerchantIds(cellText, merchantId, {
          allowSubstring: allowSubstringMatch
        });
        if (matchType === 'exact') return { merchantId, matchType };
        if (matchType === 'fuzzy') bestMatch = { merchantId, matchType };
      }
    }
  }
  return bestMatch;
}

function findSelfInputBigAccountBridge(recognitionBasis, expandedOptions, blockOrdinal) {
  const clearingIds = recognitionBasis && Array.isArray(recognitionBasis.bridgeClearingIdsByBlock)
    ? recognitionBasis.bridgeClearingIdsByBlock
    : [];
  if (!Number.isInteger(blockOrdinal) || blockOrdinal < 0) return null;
  const clearingId = normalizeCell(clearingIds[blockOrdinal]);
  if (!clearingId) return null;
  // v3.2.21 B112：先按完整 ID 精确匹配，再退回模糊匹配，不按维护列表的顺序取第一个模糊命中
  const matched = expandedOptions.find((option) => matchMerchantIds(clearingId, option.merchantId) === 'exact')
    || expandedOptions.find((option) => matchMerchantIds(clearingId, option.merchantId) !== 'none');
  if (matched) {
    return { merchantId: matched.merchantId, matchType: 'exact', viaBridge: true };
  }
  return null;
}

// 大账号预览行对应的块里有没有交易（收入或支出非空的行），按块实际包含的明细行判断：
//   没有分段的文件整份是一块，起止不经裁剪，只有表头时也是 [0, 0]，不能只看起止。
//   明细没有收入 / 支出列时无法判断，返回 null（按有交易处理）。
function bigAccountBlockHasTransactions(detailRows, startIndex, endIndex) {
  const headerRow = Array.isArray(detailRows) && Array.isArray(detailRows[0]) ? detailRows[0] : [];
  const amountIndexes = ['Credit Amount', 'Debit Amount']
    .map((field) => headerRow.indexOf(field))
    .filter((index) => index >= 0);
  if (!amountIndexes.length) return null;
  const start = Number(startIndex);
  const end = Number(endIndex);
  if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
  const dataRows = detailRows.slice(1);
  for (let index = Math.max(0, start); index <= end && index < dataRows.length; index += 1) {
    const row = dataRows[index];
    if (Array.isArray(row) && amountIndexes.some((amountIndex) => normalizeCell(row[amountIndex]) !== '')) return true;
  }
  return false;
}

function buildBigAccountOrderEvidence(pendingContext) {
  const fileEntries = Array.isArray(pendingContext.fileEntries) ? pendingContext.fileEntries : [];
  const allMerchantIds = (pendingContext.bigAccounts || [])
    .map((ba) => normalizeCell(ba.merchantId))
    .filter((id) => id !== '');
  const expandedOptions = expandBigAccountConfigurations(pendingContext.bigAccounts || []);
  const previewRows = Array.isArray(pendingContext.rowsWithEmptyBlocks)
    ? pendingContext.rowsWithEmptyBlocks
    : (pendingContext.rows || []);

  const files = fileEntries.map((entry, fileOrdinal) => {
    const resolvedPath = path.resolve(entry.filePath);
    const fileRows = previewRows.filter(
      (row) => path.resolve(row.filePath || '') === resolvedPath
    );
    const recognitionBasis = entry.detailRows && entry.detailRows.bigAccountRecognitionBasis;
    const recognition = identifyAccountsFromRecognitionBasis({
      basis: recognitionBasis,
      allMerchantIds
    });
    // 维护检查覆盖整份文件，独立于待提取行和已匹配的 accountKey。
    // 桥接值必须在查询维护列表之前保留，未维护不能退化为“未识别”。
    const maintenanceChecks = [];
    if (entry.selfInputMerchant) {
      const clearingIds = Array.isArray(recognitionBasis?.bridgeClearingIdsByBlock)
        ? recognitionBasis.bridgeClearingIdsByBlock : [];
      const windows = Array.isArray(recognitionBasis?.headerWindows)
        ? recognitionBasis.headerWindows : [];
      const blockOrdinals = new Set([
        ...fileRows.map((row) => Number(row.fileBlockOrdinal)),
        ...windows.map((_window, index) => index),
        ...clearingIds.map((_id, index) => index)
      ]);
      [...blockOrdinals].filter((ordinal) => Number.isInteger(ordinal) && ordinal >= 0)
        .sort((left, right) => left - right).forEach((blockOrdinal) => {
          const previewRow = fileRows.find((row) => Number(row.fileBlockOrdinal) === blockOrdinal);
          maintenanceChecks.push(Object.freeze({
            blockOrdinal,
            // 空段的预览行可能指向下一段交易，维护提示优先定位本段冻结表头。
            sourceRowNumber: Number(windows[blockOrdinal]?.headerRowNumber || previewRow?.sourceRowNumber || 0),
            extractedMerchantId: normalizeCell(clearingIds[blockOrdinal])
              || normalizeCell(recognition.matches[blockOrdinal]?.merchantId)
          }));
        });
    }
    const rows = fileRows.map((previewRow) => {
      const blockOrdinal = Number(previewRow.fileBlockOrdinal);
      const sourceRow = Number(previewRow.sourceRowNumber || 0);
      let identified = !entry.skipDirectMerchantLookup && Number.isInteger(blockOrdinal)
        ? recognition.matches[blockOrdinal]
        : null;
      if (!identified && entry.selfInputMerchant) {
        identified = findSelfInputBigAccountBridge(
          recognitionBasis,
          expandedOptions,
          blockOrdinal
        );
      }
      // 直接识别和桥接返回的都是维护列表里的账号，按账号精确取其币种选项；
      // 子串匹配会把相互包含的其他维护账号也算进来。
      const identifiedMerchantId = identified ? normalizeCell(identified.merchantId) : '';
      const accountOptions = identifiedMerchantId
        ? expandedOptions.filter((option) => normalizeCell(option.merchantId) === identifiedMerchantId)
        : [];
      const matched = accountOptions[0];
      const merchantId = matched ? matched.merchantId : '';
      const currency = matched ? matched.currency : '';
      // 提取不读取账单里的币种，维护了多个币种时默认取首个币种；无论直接识别还是桥接都须提醒用户核对。
      const ambiguityCode = new Set(
        accountOptions.map((option) => normalizeCell(option.currency))
      ).size > 1
        ? 'MULTI_CURRENCY'
        : null;
      // 区分无交易空段与“有交易但未识别账号”的块，记住顺序时据此核对未识别块的位置是否变化。
      const hasTransactions = bigAccountBlockHasTransactions(
        entry.detailRows,
        previewRow.blockStartIndex,
        previewRow.blockEndIndex
      );
      return Object.freeze({
        blockOrdinal,
        sourceRow,
        merchantId,
        currency,
        matchKind: identified ? identified.matchType : '',
        accountKey: merchantId ? `${merchantId}\u0000${currency}` : '',
        ambiguityCode,
        empty: typeof hasTransactions === 'boolean' ? !hasTransactions : null
      });
    });
    return Object.freeze({
      fileOrdinal,
      resolvedPath,
      fileName: path.basename(resolvedPath),
      rows: Object.freeze(rows),
      maintenanceChecks: Object.freeze(maintenanceChecks),
      orderedAccountKeys: Object.freeze(
        rows.map((row) => row.accountKey).filter((accountKey) => accountKey !== '')
      )
    });
  });

  return Object.freeze({
    version: 1,
    sessionId: normalizeCell(pendingContext.statementSelectionSessionId),
    files: Object.freeze(files)
  });
}

function extractBigAccountOrderFromEvidence(pendingContext, mode, rowIndexes) {
  const evidence = pendingContext.bigAccountOrderEvidence;
  if (!evidence || evidence.sessionId !== pendingContext.statementSelectionSessionId) {
    return { status: 'error', failedRows: [], message: '大账号选择预览已失效，请重新导入文件' };
  }
  const maintainedIds = new Set((pendingContext.bigAccounts || [])
    .map((account) => normalizeCell(account.merchantId)).filter(Boolean));
  const unmaintainedAccounts = [];
  for (const file of evidence.files) {
    const seen = new Set();
    for (const check of (file.maintenanceChecks || [])) {
      const merchantId = normalizeCell(check.extractedMerchantId);
      const key = `${check.blockOrdinal}\u0000${merchantId}`;
      if (!merchantId || maintainedIds.has(merchantId) || seen.has(key)) continue;
      seen.add(key);
      unmaintainedAccounts.push({
        merchantId,
        fileName: file.fileName,
        fileOrdinal: file.fileOrdinal,
        blockOrdinal: check.blockOrdinal,
        sourceRowNumber: check.sourceRowNumber
      });
    }
  }
  if (unmaintainedAccounts.length) {
    return {
      status: 'error',
      errorCode: 'BIG_ACCOUNT_NOT_MAINTAINED',
      message: '存在未维护大账号，本次导入将终止。',
      failedRows: [],
      unmaintainedAccounts
    };
  }
  const selectedRows = selectPendingBigAccountRows(pendingContext, mode, rowIndexes);
  if (selectedRows.length === 0) {
    return { status: 'error', failedRows: [], message: '请选择需要提取的大账号预览行' };
  }
  const accounts = [];
  const failedRows = [];
  const ambiguousCurrencyFiles = [];
  for (const selectedRow of selectedRows) {
    const resolvedPath = path.resolve(selectedRow.filePath || '');
    const fileEvidence = evidence.files.find((file) => file.resolvedPath === resolvedPath);
    const rowEvidence = fileEvidence && fileEvidence.rows.find(
      (row) => row.blockOrdinal === Number(selectedRow.fileBlockOrdinal)
    );
    if (!rowEvidence || !rowEvidence.accountKey) {
      failedRows.push({
        index: Number(selectedRow.index),
        fileName: normalizeCell(selectedRow.fileName)
      });
      continue;
    }
    accounts.push({
      merchantId: rowEvidence.merchantId,
      currency: rowEvidence.currency,
      matchType: rowEvidence.matchKind,
      fileName: fileEvidence.fileName
    });
    if (rowEvidence.ambiguityCode === 'MULTI_CURRENCY') {
      ambiguousCurrencyFiles.push(fileEvidence.fileName);
    }
  }
  if (failedRows.length > 0) return { status: 'error', failedRows };
  const result = { status: 'ok', accounts };
  if (ambiguousCurrencyFiles.length > 0) {
    result.ambiguousCurrencyFiles = Array.from(new Set(ambiguousCurrencyFiles));
  }
  return result;
}

// 大账号顺序证据里每份文件逐块（与固定模式预览行一一对应）的 { merchantId（未识别为 ''）, empty（是否无交易，未知为 null）}；
// 与保存顺序的 rowAccounts / rowEmpty 同口径。
function bigAccountOrderEvidenceRowLists(evidence) {
  const files = evidence && Array.isArray(evidence.files) ? evidence.files : [];
  return files.map((file) => (Array.isArray(file.rows) ? file.rows : [])
    .map((row) => ({
      merchantId: row.accountKey !== '' ? normalizeCell(row.merchantId) : '',
      empty: typeof row.empty === 'boolean' ? row.empty : null
    })));
}

// 逐块结果里识别到的账号（按块顺序），供匹配记住的文件。
function identifiedAccountsFromRowLists(rowLists) {
  return rowLists.map((rows) => rows
    .filter((row) => row.merchantId !== '')
    .map((row) => ({ merchantId: row.merchantId })));
}

// v3.2.15（release 审查）：固定模式下界面按位置逐块套用记住的分配，而完成选择时服务端只核对账号、不核对币种。
//   记住的顺序与本次导入文件无法按位置逐块对上时（文件个数不同、匹配不上、同一多币种大账号的多份账单或同一文件里
//   同一账号多个币种、文件或账号块换序、空段 / 未识别段的位置变化），按位置套用会把账号 / 币种填到别的块上，
//   因此降级为不固定模式由用户选择，界面也不再套用记住的分配（forceMode 存在即不预填）。
//   各文件逐块识别到的账号取大账号顺序证据，与保存顺序同口径；没有文件信息的旧顺序无法核对，沿用原行为。
function resolveSavedBigAccountOrderDecision(pendingContext) {
  const keep = { forceUnfixed: false, reason: '', fileNames: [] };
  const templateId = pendingContext && pendingContext.templateId;
  if (readBigAccountMode(ensureStorageRoot(), templateId) !== 'fixed') return keep;
  const savedOrderConfig = readBigAccountOrder(ensureStorageRoot(), templateId);
  if (!savedOrderConfig || !Array.isArray(savedOrderConfig.assignments) || !savedOrderConfig.assignments.length) return keep;
  if (!Array.isArray(savedOrderConfig.files) || !savedOrderConfig.files.length) return keep;
  const evidenceFiles = pendingContext.bigAccountOrderEvidence && Array.isArray(pendingContext.bigAccountOrderEvidence.files)
    ? pendingContext.bigAccountOrderEvidence.files
    : [];
  const fileNamesOf = (indexes) => indexes.map((index) => evidenceFiles[index].fileName);
  if (evidenceFiles.length !== savedOrderConfig.fileCount) return { forceUnfixed: true, reason: 'file-count', fileNames: [] };
  const importRowLists = bigAccountOrderEvidenceRowLists(pendingContext.bigAccountOrderEvidence);
  const { failedImportIndexes, ambiguousImportIndexes, savedIndexByImport } = matchImportFilesToSavedOrder(
    identifiedAccountsFromRowLists(importRowLists),
    savedOrderConfig
  );
  if (ambiguousImportIndexes.length) {
    return { forceUnfixed: true, reason: 'ambiguous', fileNames: fileNamesOf(ambiguousImportIndexes) };
  }
  if (failedImportIndexes.length) return { forceUnfixed: true, reason: 'mismatch', fileNames: fileNamesOf(failedImportIndexes) };
  // 界面按位置套用：本次第 i 份文件须对上记住的第 i 份，且逐块识别结果一致（不比较拼接后的分配，空段不会造成误降级）。
  const reorderedIndexes = savedIndexByImport
    .map((savedIndex, importIndex) => (savedIndex === importIndex ? -1 : importIndex))
    .filter((importIndex) => importIndex >= 0);
  if (reorderedIndexes.length) return { forceUnfixed: true, reason: 'reordered', fileNames: fileNamesOf(reorderedIndexes) };
  const rowMismatches = findSavedOrderFileRowMismatches(importRowLists, savedOrderConfig, savedIndexByImport);
  if (rowMismatches.length) return { forceUnfixed: true, reason: 'rows', fileNames: fileNamesOf(rowMismatches) };
  return keep;
}

const SAVED_BIG_ACCOUNT_ORDER_DOWNGRADE_REASONS = Object.freeze({
  'file-count': '本次导入的文件个数与记住的不同',
  mismatch: '部分文件的账户个数、账户号或账号块顺序与记住的对不上',
  reordered: '文件顺序与记住的不同',
  rows: '部分文件的账号块（含无交易的空段、未识别账号的块）与记住的对不上'
});

// 降级在预检阶段做出：常规导入预检返回大账号选择后直接转入完成选择，不会再以非预检方式运行到这里，
// 因此日志不区分预检；同一次导入只会判定一次。
function logSavedBigAccountOrderDowngrade(templateName, decision) {
  const ambiguous = decision.reason === 'ambiguous';
  appendActivityLogEntry({
    level: 'info',
    message: ambiguous
      ? '已记住的大账号顺序无法唯一确定部分文件的账号 / 币种，改为人工选择'
      : '已记住的大账号顺序与本次导入文件对不上，改为人工选择',
    details: [
      `模板名：${normalizeCell(templateName) || 'N/A'}`,
      ...(ambiguous ? [] : [`原因：${SAVED_BIG_ACCOUNT_ORDER_DOWNGRADE_REASONS[decision.reason] || decision.reason}`]),
      ...(decision.fileNames.length ? [`涉及文件：${decision.fileNames.join('、')}`] : [])
    ]
  });
}

function applySavedBigAccountOrderGuard(_prepared, pendingContext, selectionRequired) {
  const decision = resolveSavedBigAccountOrderDecision(pendingContext);
  if (!decision.forceUnfixed) return selectionRequired;
  logSavedBigAccountOrderDowngrade(pendingContext.template && pendingContext.template.name, decision);
  return { ...selectionRequired, forceMode: 'unfixed' };
}

function buildBigAccountOrderData(pendingContext, assignments = []) {
  const evidence = pendingContext.bigAccountOrderEvidence;
  if (!evidence || evidence.sessionId !== pendingContext.statementSelectionSessionId) {
    throw new Error('大账号顺序证据已失效');
  }
  return {
    assignments,
    fileCount: evidence.files.length,
    files: evidence.files.map((file) => {
      const accounts = file.rows
        .filter((row) => row.accountKey !== '')
        .map((row) => ({ merchantId: row.merchantId, currency: row.currency }));
      // 逐块识别账号、是否无交易与 assignments 一一对应（含空段 / 未识别段），供下次按块核对能否按位置套用。
      const rowAccounts = file.rows.map((row) => (row.accountKey !== '' ? row.merchantId : ''));
      const rowEmpty = file.rows.map((row) => (typeof row.empty === 'boolean' ? row.empty : null));
      return { fileIndex: file.fileOrdinal, accountCount: accounts.length, accounts, rowAccounts, rowEmpty };
    })
  };
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
// 模板包导入：校验用的模板草稿。覆盖已有模板时随后会写入包里的表头，校验也必须按包里的表头进行；
// v3.2.18 起（模板【更新】后交接给其他电脑的场景）不再沿用本机旧表头，避免新字段映射被误判为不存在而整条跳过。
function buildBundleImportDraftTemplate(entry, existingTemplate) {
  if (existingTemplate) {
    return { ...existingTemplate, headers: entry.headers };
  }
  return {
    id: 0,
    templateKey: entry.templateKey,
    name: entry.name,
    sourceFileName: entry.sourceFileName,
    headers: entry.headers,
    createdAt: '',
    updatedAt: ''
  };
}

// v3.2.18 模板管理【更新】：模板配置 → 引用收集输入（与 buildStatementGenerationConfig 拦截同一口径）
function buildTemplateFieldReferenceInput(templateConfig) {
  return {
    mappings: Array.isArray(templateConfig && templateConfig.exportMappings) ? templateConfig.exportMappings : [],
    amountSplitRules: Array.isArray(templateConfig && templateConfig.amountSplitRules) ? templateConfig.amountSplitRules : [],
    billSplitMappings: Array.isArray(templateConfig && templateConfig.billSplitMappings) ? templateConfig.billSplitMappings : [],
    billSplitRows: Array.isArray(templateConfig && templateConfig.billSplitRows) ? templateConfig.billSplitRows : [],
    billSplitAmountRules: Array.isArray(templateConfig && templateConfig.billSplitAmountRules)
      ? templateConfig.billSplitAmountRules
      : [],
    billSplitSignedAmountSourceField: normalizeCell(templateConfig && templateConfig.billSplitMeta
      && templateConfig.billSplitMeta.signedAmountSourceField),
    billSplitFeeAmountFormula: templateConfig && templateConfig.billSplitMeta
      && Array.isArray(templateConfig.billSplitMeta.feeAmountFormula)
      ? templateConfig.billSplitMeta.feeAmountFormula
      : [],
    billSplitFeeAmountFormulaEnabled: Boolean(templateConfig && templateConfig.billSplitMeta
      && templateConfig.billSplitMeta.feeAmountFormulaEnabled),
    billSplitFeeFieldMappings: templateConfig && templateConfig.billSplitMeta
      && Array.isArray(templateConfig.billSplitMeta.feeFieldMappings)
      ? templateConfig.billSplitMeta.feeFieldMappings
      : [],
    billSplitFeeFieldMappingEnabled: Boolean(templateConfig && templateConfig.billSplitMeta
      && templateConfig.billSplitMeta.feeFieldMappingEnabled),
    // 生成时只保留会导出的目标字段（buildStatementGenerationConfig），更新检查按同一口径标记
    billSplitFeeFieldMappingTargetFields: templateConfig && Array.isArray(templateConfig.exportTargetFields)
      ? templateConfig.exportTargetFields
      : null,
    billSplitRowFilterRules: templateConfig && templateConfig.billSplitMeta
      && Array.isArray(templateConfig.billSplitMeta.rowFilterRules)
      ? templateConfig.billSplitMeta.rowFilterRules
      : [],
    preprocessRowFilterRules: templateConfig && templateConfig.template
      && Array.isArray(templateConfig.template.preprocessRowFilterRules)
      ? templateConfig.template.preprocessRowFilterRules
      : [],
    featureFilters: templateConfig && templateConfig.template && Array.isArray(templateConfig.template.featureFilters)
      ? templateConfig.template.featureFilters
      : []
  };
}

// 按给定表头找出模板配置中失效的源字段引用（含未启用的配置，结果带 active 标记）。
function collectStaleTemplateFieldReferences(templateId, headers) {
  const templateConfig = getTemplateMappingConfig(templateId);
  if (!templateConfig) {
    return [];
  }
  const references = templateHeaderUpdateTools.collectTemplateFieldReferences(
    buildTemplateFieldReferenceInput(templateConfig)
  );
  return templateHeaderUpdateTools.findStaleFieldReferences(references, headers);
}

// 旧版映射方向（template_field 存源字段、mapped_field 存目标字段）由 resolveCurrentMappings 按当前表头识别；
// 表头替换后可能识别不出旧方向，映射会整体读空。这类模板先在【修改】中保存一次（按新方向写回）再更新。
function isLegacyOrientedTemplateMappings(templateId) {
  const templateConfig = getTemplateMappingConfig(templateId);
  const payload = database.getTemplateMappings(templateId);
  if (!templateConfig || !payload) {
    return false;
  }
  const targetFieldSet = new Set(buildManagedMappingFields(templateConfig.enumValues));
  const sourceFieldSet = new Set((templateConfig.template.headers || []).map((header) => normalizeCell(header)));
  const mappings = Array.isArray(payload.mappings) ? payload.mappings : [];
  const currentOrientationScore = mappings.filter((mapping) => targetFieldSet.has(mapping.templateField)).length;
  const legacyOrientationScore = mappings.filter((mapping) => {
    return sourceFieldSet.has(normalizeCell(mapping.templateField)) && targetFieldSet.has(mapping.mappedField);
  }).length;
  return legacyOrientationScore > currentOrientationScore;
}

// 读取所选文件表头并与模板当前表头对比；只读，不写库。
// v3.2.21：模板已保存的逻辑取值候补中，有特征值候补与当前或待写入表头的列名内部写法相同（只可能是构造的含 NUL 列名）。
//   更新前后任一侧出现这种列名，更新后都无法再判断该候补是源列还是特征值（生成会拒绝或改取其他值），拒绝更新。
function hasAmbiguousLogicValueFeatureCandidate(templateId, headerLists) {
  const headerSet = new Set([].concat(...(headerLists || []).map((headers) => (Array.isArray(headers) ? headers : [])))
    .map((header) => normalizeCell(header)));
  return [].concat(
    (database.getTemplateMappings(templateId) || {}).mappings || [],
    database.getBillSplitMappings(templateId) || []
  ).some((mapping) => normalizeCell(mapping && mapping.mappedField) === LOGIC_VALUE_MAPPING_FIELD
    && (Array.isArray(mapping.mappedFields) ? mapping.mappedFields : []).some((field) => {
      const candidate = normalizeCell(field);
      const featureFilterRef = parseLogicValueFeatureFilterRef(candidate);
      return featureFilterRef !== null
        && (headerSet.has(candidate) || headerSet.has(buildLogicValueFeatureCandidate(featureFilterRef)));
    }));
}

function prepareTemplateHeaderUpdate({ templateId, filePath }) {
  const template = database.getTemplate(templateId);
  if (!template) {
    return createErrorResult({
      step: '更新模板',
      message: '未找到对应模板，请刷新后重试',
      errorCode: 'TEMPLATE_NOT_FOUND',
      context: { templateId }
    });
  }
  if (isLegacyOrientedTemplateMappings(template.id)) {
    return createErrorResult({
      step: '更新模板',
      message: LEGACY_ORIENTED_MAPPINGS_MESSAGE,
      errorCode: 'TEMPLATE_MAPPINGS_LEGACY_ORIENTATION',
      context: { templateId, templateName: template.name }
    });
  }
  const headers = normalizeBundleTemplateHeaders(extractHeaders(filePath));
  if (!headers.some((header) => header !== '')) {
    throw new FileValidationError('TEMPLATE_HEADERS_INVALID', '所选文件没有有效的表头');
  }
  if (hasAmbiguousLogicValueFeatureCandidate(templateId, [template.headers, headers])) {
    return createErrorResult({
      step: '更新模板',
      message: `模板「${template.name}」有列名与「${LOGIC_VALUE_MAPPING_FIELD}」的特征值候补内部写法相同，请先在映射关系管理中重新选择候补字段后再更新`,
      errorCode: 'TEMPLATE_LOGIC_VALUE_CANDIDATE_AMBIGUOUS',
      context: { templateId, templateName: template.name }
    });
  }
  const diff = diffTemplateHeaders(template.headers, headers);
  if (!diff.identical) {
    const conflict = findConflictingTemplateByHeaders(headers, templateId);
    if (conflict) {
      return createErrorResult({
        step: '更新模板',
        message: `该文件的表头与已有模板「${conflict.name}」完全相同，无法更新为重复表头的模板。`,
        errorCode: 'TEMPLATE_HEADERS_DUPLICATE',
        context: { templateName: template.name, conflictTemplateName: conflict.name }
      });
    }
  }
  const staleReferences = diff.identical ? [] : collectStaleTemplateFieldReferences(templateId, headers);
  return {
    status: 'success',
    templateId: template.id,
    templateName: template.name,
    channelId: template.channelId || null,
    sourceFileName: path.basename(filePath),
    expectedHeaders: template.headers,
    headers,
    diff,
    affectedMappings: templateHeaderUpdateTools.formatFieldReferenceLines(staleReferences),
    activeStaleCount: staleReferences.filter((reference) => reference.active).length
  };
}

// 确认更新：只替换表头与源文件名，映射等配置全部保留；renderer 回传的表头在此全量复核。
function applyTemplateHeaderUpdate(payload = {}) {
  const templateId = Number(payload.templateId);
  const fail = (errorCode, message, extra = {}) => createErrorResult({
    step: '更新模板',
    message,
    errorCode,
    context: { templateId, ...extra }
  });
  if (!Array.isArray(payload.headers) || !Array.isArray(payload.expectedHeaders)) {
    return fail('TEMPLATE_HEADERS_INVALID', '模板表头无效，请重新点击【更新】选择文件');
  }
  const headers = normalizeBundleTemplateHeaders(payload.headers);
  const expectedHeaders = payload.expectedHeaders.map((value) => (value === null || value === undefined ? '' : String(value)));
  if (!headers.some((header) => header !== '')) {
    return fail('TEMPLATE_HEADERS_INVALID', '所选文件没有有效的表头');
  }
  const template = database.getTemplate(templateId);
  if (!template) {
    return fail('TEMPLATE_NOT_FOUND', '模板已被删除，请刷新后重试');
  }
  if (JSON.stringify(template.headers) !== JSON.stringify(expectedHeaders)) {
    return fail('TEMPLATE_HEADERS_CHANGED', '模板在此期间已被修改，请重新点击【更新】', { templateName: template.name });
  }
  const diff = diffTemplateHeaders(template.headers, headers);
  if (diff.identical) {
    return fail('TEMPLATE_HEADERS_UNCHANGED', '所选文件的表头与当前模板一致，无需更新', { templateName: template.name });
  }
  if (isLegacyOrientedTemplateMappings(templateId)) {
    return fail('TEMPLATE_MAPPINGS_LEGACY_ORIENTATION', LEGACY_ORIENTED_MAPPINGS_MESSAGE, { templateName: template.name });
  }
  if (hasAmbiguousLogicValueFeatureCandidate(templateId, [template.headers, headers])) {
    return fail(
      'TEMPLATE_LOGIC_VALUE_CANDIDATE_AMBIGUOUS',
      `模板「${template.name}」有列名与「${LOGIC_VALUE_MAPPING_FIELD}」的特征值候补内部写法相同，请先在映射关系管理中重新选择候补字段后再更新`,
      { templateName: template.name }
    );
  }
  const conflict = findConflictingTemplateByHeaders(headers, templateId);
  if (conflict) {
    return fail(
      'TEMPLATE_HEADERS_DUPLICATE',
      `该文件的表头与已有模板「${conflict.name}」完全相同，无法更新为重复表头的模板。`,
      { templateName: template.name, conflictTemplateName: conflict.name }
    );
  }
  const sourceFileName = path.basename(normalizeCell(payload.sourceFileName)) || template.sourceFileName || '';

  let updatedTemplate;
  try {
    updatedTemplate = database.updateTemplateHeaders(templateId, { expectedHeaders, headers, sourceFileName });
  } catch (error) {
    if (error && error.code === 'TEMPLATE_NOT_FOUND') {
      return fail('TEMPLATE_NOT_FOUND', '模板已被删除，请刷新后重试');
    }
    if (error && error.code === 'TEMPLATE_HEADERS_CHANGED') {
      return fail('TEMPLATE_HEADERS_CHANGED', '模板在此期间已被修改，请重新点击【更新】', { templateName: template.name });
    }
    throw error;
  }
  // 表头已写入主库：之后的模板库文件同步失败不影响更新结果（启动和下次修改模板时会重新同步），单独提示。
  let librarySyncFailed = false;
  try {
    syncTemplateLibraryFile();
  } catch (error) {
    librarySyncFailed = true;
    appendActivityLogEntry({
      level: 'warn',
      message: '更新模板表头后同步模板库文件失败',
      details: [`模板名：${template.name}`, `原因：${error && error.message ? error.message : String(error)}`]
    });
  }
  clearLastErrorReport();

  const staleReferences = collectStaleTemplateFieldReferences(templateId, updatedTemplate.headers);
  const staleMappings = templateHeaderUpdateTools.formatFieldReferenceLines(staleReferences);
  const activeStaleCount = staleReferences.filter((reference) => reference.active).length;
  appendActivityLogEntry({
    level: 'info',
    message: '更新模板表头成功',
    details: [
      `模板名：${template.name}`,
      `源文件：${sourceFileName || 'N/A'}`,
      `新增字段：${diff.added.join('、') || '（无）'}`,
      `删除字段：${diff.removed.join('、') || '（无）'}`,
      `字段顺序：${diff.orderChanged ? '有调整' : '无变化'}`,
      `失效映射：${staleMappings.length} 处（需修改后才能生成：${activeStaleCount} 处）`,
      '映射、大账号、固定值、字段筛选与拆分规则均保留'
    ]
  });
  const baseMessage = activeStaleCount > 0
    ? `模板「${template.name}」已更新，有 ${activeStaleCount} 处映射引用的字段已删除，修改映射关系前无法用该模板生成账单`
    : `模板「${template.name}」已更新，映射关系已保留`;
  return {
    status: 'success',
    message: librarySyncFailed ? `${baseMessage}；模板库文件同步失败，下次启动或修改模板时会重新同步` : baseMessage,
    template: buildTemplateSummary(updatedTemplate),
    diff,
    staleMappings,
    activeStaleCount,
    librarySyncFailed
  };
}

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
    readRowsWithMetadata(filePath, headers, {
      readGuard: createStatementWorkbookReadGuard(filePath)
    });
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
function executeFilenameMappingImportPlan(plan, prepared = null) {
  const {
    perTemplateConfigCount,
    syntheticTemplateConfig,
    selectedBigAccount,
    selectionResult
  } = plan;
  // v3.2.19：重复账单过滤——在全部文件的最终条目上按确认结果去重（没有重复时原样返回）。
  //   未开启（条目没有指纹）且不是确认续跑时不预先重建，沿用原流程（多模板按组重建，避免整批多克隆一份）。
  let finalEntries = null;
  if (hasDuplicateRowKeys(plan.trimmedProvisionalEntries) || (prepared && prepared.duplicateReviewConfirmation)) {
    const reviewed = applyConfirmedDuplicateRowFilter(
      resolveFilenameMappingFinalEntries(plan),
      prepared,
      '按文件名映射模板'
    );
    if (reviewed.result) return reviewed.result;
    finalEntries = reviewed.entries;
  }
  const session = getOrCreateStatementImportSession({
    statementImportSessions,
    templateId: FILENAME_MAPPING_TEMPLATE_ID,
    templateName: '按文件名映射模板'
  });
  if (perTemplateConfigCount > 1) {
    const { lastResult, lastBatchId, lastGenerationTemplateConfig } = generateMultiTemplateGroupFiles({
      fileEntries: finalEntries || plan.trimmedProvisionalEntries,
      fallbackTemplateConfig: syntheticTemplateConfig,
      selectedBigAccount,
      reuseMappedRows: true,
      entriesResolved: Boolean(finalEntries),
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

  const rebuiltFileEntries = finalEntries || resolveFilenameMappingFinalEntries(plan);
  const generationTemplateConfig = resolveGenerationTemplateConfig({
    fileEntries: rebuiltFileEntries,
    fallbackTemplateConfig: syntheticTemplateConfig
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

  const channelMigrationPendingMessage = getStatementChannelMigrationPendingMessage();
  if (channelMigrationPendingMessage) {
    return createErrorResult({
      step: '导入网银明细文件',
      message: channelMigrationPendingMessage,
      errorCode: 'STATEMENT_CHANNEL_MIGRATION_PENDING'
    });
  }

  // 虚拟模板名，用于错误上下文 / session 标题 / 文件名重复提示
  const virtualTemplateName = '按文件名映射模板';

  fileImportInProgress = true;
  try {
    if (!prepared.previewOnly) {
      clearPendingManualBalancePrompt();
      clearPendingBigAccountSelection();
      statementDuplicateReview.clear();
    }
    if (!prepared.previewOnly
        && prepared.statementImportPlan
        && prepared.statementImportPlan.kind === 'filename-mapping') {
      return executeFilenameMappingImportPlan(prepared.statementImportPlan, prepared);
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
    // v3.2.16：币种未维护大账号的问题先收集，全部文件解析完再一次报错（spec D1）
    const currencyBigAccountIssues = [];

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
      let detailRows;
      try {
        detailRows = buildMappedRowsForFile({ config, inputFilePath: filePath });
      } catch (error) {
        if (!isCurrencyBigAccountUnmappedError(error)) {
          throw error;
        }
        appendCurrencyBigAccountIssues(currencyBigAccountIssues, error);
        continue;
      }

      parentProvisionalEntries.push({
        filePath,
        detailRows,
        matchedTemplateId: matchedId,
        matchedHeaders: matchedConfig.template.headers || [],
        selfInputMerchant: merchantLookupFlags.selfInputMerchant,
        skipDirectMerchantLookup: merchantLookupFlags.skipDirectMerchantLookup
      });
    }

    if (currencyBigAccountIssues.length) {
      throw buildCurrencyBigAccountUnmappedError(currencyBigAccountIssues);
    }

    // ===== 步骤 3.5（v3.2.15）：渠道组校验 =====
    // 按渠道分组后，任一渠道组内同一账户命中余额方式不同的子模板（v3.2.21 D3），或渠道还有未处理的账户映射冲突，
    // 整批阻断，不进入大账号选择与生成。
    const importGenerationGroups = groupStatementEntriesForGeneration(parentProvisionalEntries);
    const outputNameConflicts = findGenerationGroupOutputNameConflicts(importGenerationGroups);
    if (outputNameConflicts) {
      const error = buildStatementOutputNameConflictError(outputNameConflicts);
      return createErrorResult({
        step: '导入网银明细文件',
        message: error.message,
        errorCode: error.code,
        detailLines: outputNameConflicts,
        templateName: virtualTemplateName
      });
    }
    // 余额方式不同的渠道组的条目一并记下（含所属渠道与余额方式），注入大账号后的复核按位置取用（见步骤 5、8）。
    //   按原行判断的冲突在确定不进入大账号选择后才返回（步骤 8）：进入选择时各账号块的账号、币种都由用户的选择覆盖，
    //   原行的账号不作数，改在完成选择后按分配结果判断（completeBigAccountSelectionHandler）；自动确定唯一大账号时，
    //   含要注入账号的条目的渠道同样只按注入后的条目判断（release 审查）
    const balanceModeMixedEntries = new Map();
    const balanceModeConflicts = collectGenerationGroupBalanceModeConflicts(importGenerationGroups, balanceModeMixedEntries);
    const pendingConflictChannels = [];
    const checkedChannelIds = new Set();
    for (const [, matchedConfig] of perTemplateConfigCache) {
      const channelId = Number(matchedConfig.template.channelId || 0);
      if (!channelId || checkedChannelIds.has(channelId)) continue;
      checkedChannelIds.add(channelId);
      const conflicts = database.listStatementChannelAccountMappingConflicts(channelId);
      conflicts.forEach((item) => pendingConflictChannels.push(item));
    }
    if (pendingConflictChannels.length > 0) {
      return createErrorResult({
        step: '导入网银明细文件',
        message: `渠道「${pendingConflictChannels.map((item) => item.channelName).join('、')}」的账户映射还有待处理的冲突，请先在「账户映射」中为每个账户号选定一条设置后再导入`,
        errorCode: 'CHANNEL_ACCOUNT_MAPPING_CONFLICT_PENDING',
        detailLines: pendingConflictChannels.map((item) => (
          `渠道「${item.channelName}」：账户号 ${item.conflicts.map((conflict) => conflict.bankAccountId).join('、')}`
        )),
        context: { channelIds: pendingConflictChannels.map((item) => item.channelId) },
        templateName: virtualTemplateName
      });
    }

    // ===== 步骤 4：聚合大账号 =====
    // 每个命中的模板自身 bigAccounts；v3.2.15（A3）：命中渠道的任一子模板时，取该渠道全部子模板的 bigAccounts。
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

    const channelIdsProcessed = new Set();
    for (const [, matchedConfig] of perTemplateConfigCache) {
      addBigAccounts(matchedConfig.bigAccounts);
      const channelId = Number(matchedConfig.template.channelId || 0);
      if (channelId && !channelIdsProcessed.has(channelId)) {
        channelIdsProcessed.add(channelId);
        for (const sibling of database.listStatementChannelTemplates(channelId)) {
          if (perTemplateConfigCache.has(sibling.id)) continue;
          const siblingConfig = getTemplateMappingConfig(sibling.id);
          if (siblingConfig) addBigAccounts(siblingConfig.bigAccounts);
        }
      }
    }

    // ===== 步骤 5：session + 文件重复检测（复用 resolveImportFileSelection）=====
    // 用虚拟 ID 作为 session key：同一批「按文件名映射模板」导入共享 session，支持重复文件提示
    const selectionResult = prepared.selectionResult;

    // resolveImportFileSelection 可能剔除重复文件 → 同步裁剪 parentProvisionalEntries
    const acceptedPathSet = new Set(selectionResult.filePaths);
    const trimmedProvisionalEntries = parentProvisionalEntries.filter((entry) => acceptedPathSet.has(entry.filePath));
    // v3.2.21（D3）：余额方式不同的渠道组的条目位置（复用步骤 3.5 的分组），注入大账号后的复核只看这些条目
    const balanceModeMixedEntryIndexes = listBalanceModeMixedEntryIndexes(
      importGenerationGroups,
      trimmedProvisionalEntries,
      balanceModeMixedEntries
    );

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
    // v3.2.16（spec §4.4）：「原始账单仅有币种无账户号」的文件逐行按币种回填，不参与选择。
    //   全部文件都是本模式时跳过选择（渠道兄弟子模板的大账号不应触发选择）；与需要选择的文件混在一起时阻断。
    const { currencyOnlyFileNames, allCurrencyOnly } = classifyCurrencyOnlyEntries(
      trimmedProvisionalEntries,
      perTemplateConfigCache
    );
    const bigAccountOptions = allCurrencyOnly ? [] : expandBigAccountConfigurations(aggregatedBigAccounts);

    if (bigAccountOptions.length > 1 && currencyOnlyFileNames.length) {
      return createCurrencyOnlyMixedSelectionErrorResult(currencyOnlyFileNames, virtualTemplateName);
    }

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

      const pendingContext = stagePendingBigAccountSelection(prepared, {
        templateId: FILENAME_MAPPING_TEMPLATE_ID,
        template: syntheticTemplateConfig.template,
        mappings: syntheticTemplateConfig.exportMappings,
        orderedTargetFields: syntheticTemplateConfig.exportTargetFields,
        inputFilePaths: selectionResult.filePaths,
        bigAccounts: aggregatedBigAccounts,
        fixedAssignments: [],
        fileEntries: trimmedProvisionalEntries,
        balanceModeMixedEntryIndexes,
        rows: selectionRows,
        rowsWithEmptyBlocks: selectionRowsWithEmpty
      });
      return applySavedBigAccountOrderGuard(prepared, pendingContext, buildBigAccountSelectionRequiredResult({
        rows: selectionRows,
        rowsWithEmptyBlocks: selectionRowsWithEmpty,
        bigAccounts: aggregatedBigAccounts,
        fixedAssignments: [],
        templateId: FILENAME_MAPPING_TEMPLATE_ID
      }));
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

      if (recognitionResult.status === 'needs-selection' && currencyOnlyFileNames.length) {
        return createCurrencyOnlyMixedSelectionErrorResult(currencyOnlyFileNames, virtualTemplateName);
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

        const pendingContext = stagePendingBigAccountSelection(prepared, {
          templateId: FILENAME_MAPPING_TEMPLATE_ID,
          template: syntheticTemplateConfig.template,
          mappings: syntheticTemplateConfig.exportMappings,
          orderedTargetFields: syntheticTemplateConfig.exportTargetFields,
          inputFilePaths: selectionResult.filePaths,
          bigAccounts: aggregatedBigAccounts,
          fixedAssignments: [],
          fileEntries: trimmedProvisionalEntries,
          balanceModeMixedEntryIndexes,
          rows: selectionRows,
          rowsWithEmptyBlocks: selectionRowsWithEmpty
        });
        return applySavedBigAccountOrderGuard(prepared, pendingContext, buildBigAccountSelectionRequiredResult({
          rows: selectionRows,
          rowsWithEmptyBlocks: selectionRowsWithEmpty,
          bigAccounts: aggregatedBigAccounts,
          fixedAssignments: [],
          templateId: FILENAME_MAPPING_TEMPLATE_ID
        }));
      }

      if (recognitionResult.selectedBigAccount) {
        selectedBigAccount = recognitionResult.selectedBigAccount;
      }
    }
    // 不进入大账号选择：原行的冲突作数（步骤 3.5 已判断）。自动确定唯一大账号时，含要注入账号的条目的渠道，账号由注入改写
    //   （如拆分映射暂时从源列读出的账号），按原行判断不作数，只按注入后的条目判断（见下）；其余渠道沿用原行的判断（release 审查）
    // 复用导入时已按模板读取的配置（另起一份，不改动 perTemplateConfigCache）
    const selectedBigAccountConfigCache = new Map(perTemplateConfigCache);
    const usesSelectedBigAccount = (entry) => entryUsesSelectedBigAccount(entry, syntheticTemplateConfig, selectedBigAccountConfigCache);
    const injectedBalanceModeGroupKeys = new Set();
    if (selectedBigAccount) {
      balanceModeMixedEntryIndexes.forEach((index) => {
        const entry = trimmedProvisionalEntries[index];
        const recorded = balanceModeMixedEntries.get(entry);
        if (recorded && usesSelectedBigAccount(entry)) injectedBalanceModeGroupKeys.add(recorded.groupKey);
      });
    }
    const provisionalBalanceModeConflicts = (balanceModeConflicts || [])
      .filter((group) => !injectedBalanceModeGroupKeys.has(group.groupKey));

    const statementImportPlan = {
      kind: 'filename-mapping',
      perTemplateConfigCount: perTemplateConfigCache.size,
      trimmedProvisionalEntries,
      syntheticTemplateConfig,
      selectedBigAccount,
      selectionResult
    };
    // 最终条目（注入大账号后）在本次预检内只构建一次：要查重时整批构建，余额方式冲突与重复账单两项检查共用；
    //   不查重时冲突检查只注入余额方式不同的渠道组的条目
    let finalEntries = null;
    const resolveFinalEntries = () => finalEntries || (finalEntries = resolveFilenameMappingFinalEntries(statementImportPlan));
    const previewsDuplicateRows = Boolean(prepared.previewOnly) && hasDuplicateRowKeys(trimmedProvisionalEntries);
    // v3.2.21（D3）：直接生成时大账号已确定，按注入账号后的条目再判断一次（步骤 3.5 时多大账号模板的行还没有账号），
    //   在开始生成前拦下，不进入生成后才失败的收尾。与其余渠道按原行判断出的冲突一并列出
    const resolvedBalanceModeConflicts = selectedBigAccount
      ? findResolvedEntriesBalanceModeConflicts(
        balanceModeMixedEntryIndexes.map((index) => trimmedProvisionalEntries[index]),
        (pendingEntries) => (previewsDuplicateRows
          ? pickResolvedEntries(trimmedProvisionalEntries, resolveFinalEntries(), pendingEntries)
          : resolveFilenameMappingFinalEntries({ ...statementImportPlan, trimmedProvisionalEntries: pendingEntries })),
        usesSelectedBigAccount,
        // 复用步骤 3.5 记下的渠道与余额方式，只替换注入后的明细行再判断
        balanceModeMixedEntries
      )
      : null;
    const importBalanceModeConflicts = provisionalBalanceModeConflicts.concat(resolvedBalanceModeConflicts || []);
    if (importBalanceModeConflicts.length) {
      return createChannelBalanceModeMismatchResult({
        step: '导入网银明细文件',
        conflictGroups: importBalanceModeConflicts,
        templateName: virtualTemplateName,
        preservesSession: Boolean(prepared.previewOnly)
      });
    }
    if (prepared.previewOnly) {
      prepared.statementImportPlan = statementImportPlan;
      // v3.2.19：重复账单过滤——预检时在最终条目上查重，有重复先暂停等待确认
      if (previewsDuplicateRows) {
        const paused = previewDuplicateRows(
          resolveFinalEntries(),
          prepared,
          virtualTemplateName
        );
        if (paused) return paused;
      }
      return statementImportPreviewReady();
    }
    return executeFilenameMappingImportPlan(statementImportPlan, prepared);
  } catch (error) {
    if (!prepared.previewOnly) {
      clearGeneratedExports();
      clearPendingManualBalancePrompt();
      clearPendingBigAccountSelection();
    }

    if (error && error.code === STATEMENT_SOURCE_FRESHNESS_FAILURE.code) {
      if (prepared.previewOnly) {
        return createPreflightErrorResult({
          message: STATEMENT_SOURCE_FRESHNESS_FAILURE.message,
          errorCode: STATEMENT_SOURCE_FRESHNESS_FAILURE.code
        });
      }
      throw error;
    }

    if (error instanceof FileValidationError) {
      // v3.2.16：币种未维护大账号需要把文件 / 币种 / 行号带回界面弹窗（spec D1）；
      //   v3.2.21：渠道余额方式冲突、出余额的交易缺账单日期或 MerchantId 同样带回明细
      const buildResult = String(error.code || '').startsWith('CURRENCY_BIG_ACCOUNT_')
        || error.code === 'CHANNEL_BALANCE_MODE_MISMATCH'
        || error.code === 'CHANNEL_BALANCE_ROWS_INCOMPLETE'
        ? createDetailedErrorResult
        : createErrorResult;
      return buildResult({
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
  const pickerSelections = captureStatementSourceSelections(inputFilePaths);
  const statementSelectionSessionId = randomUUID();
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
    filePaths: inputFilePaths
  });
  if (selectionResult.status === 'cancelled' || selectionResult.filePaths.length === 0) {
    return { proceed: false, result: { status: 'cancelled' } };
  }
  // v3.2.19：重复账单过滤——会话中已确认的跨文件去重关系，两端须一起覆盖：只覆盖保留方会让去除的交易丢失，
  //   只覆盖去除方会把去除的交易带回来重复入账。拦下并提示把相关文件一起重新导入（一起导入时重新查重）。
  const keeperConflicts = findDuplicateKeeperReplacementConflicts(previewSession.fileEntries, selectionResult.replacePaths);
  if (keeperConflicts.length) {
    const { message, detailLines } = describeDuplicateKeeperReplacementConflicts(keeperConflicts);
    return {
      proceed: false,
      // preservesSession：未开始导入，会话、导出与补录入口都没变，界面只提示、不按失败的导入处理
      result: Object.assign(createPreflightErrorResult({
        message,
        errorCode: 'DUPLICATE_KEEPER_REPLACEMENT',
        detailLines
      }), { preservesSession: true })
    };
  }
  const sourceSelections = selectStatementSourceSelections(
    pickerSelections,
    selectionResult.filePaths
  );
  const assertSessionCurrent = () => {
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
    filePlan: {
      version: 1,
      allocation: 'eager',
      inputs: buildStatementInputFilePlanItems(sourceSelections, 'file:import'),
      outputs: []
    },
    inputFilePaths: selectionResult.filePaths,
    selectionResult,
    previewSession,
    statementSelectionSessionId,
    sourceSelections,
    assertSessionCurrent,
    beforeStart: assertSessionCurrent
  };
}

function bindStatementImportPreparedToFileEvidence(prepared, filePlan) {
  const inputFilePaths = filePlan.inputs.map((item) => item.filePath);
  const sourcePaths = prepared.selectionResult.filePaths;
  const frozenPathBySource = new Map(
    sourcePaths.map((filePath, index) => [filePath, inputFilePaths[index]])
  );
  const bindEntries = (entries) => entries && entries.map((entry) => ({
    ...entry,
    filePath: frozenPathBySource.get(entry.filePath)
  }));
  const selectionResult = {
    ...prepared.selectionResult,
    filePaths: inputFilePaths,
    parentProvisionalEntries: bindEntries(prepared.selectionResult.parentProvisionalEntries)
  };
  const statementImportPlan = prepared.statementImportPlan
    ? {
        ...prepared.statementImportPlan,
        trimmedProvisionalEntries: bindEntries(prepared.statementImportPlan.trimmedProvisionalEntries),
        selectionResult
      }
    : null;
  return {
    ...prepared,
    inputFilePaths,
    selectionResult,
    ...(statementImportPlan ? { statementImportPlan } : {})
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
      const channelMigrationPendingMessage = getStatementChannelMigrationPendingMessage();
      if (channelMigrationPendingMessage) {
        return {
          proceed: false,
          result: createPreflightErrorResult({
            message: channelMigrationPendingMessage,
            errorCode: 'STATEMENT_CHANNEL_MIGRATION_PENDING'
          })
        };
      }
      // v3.2.19：重复账单提醒【确认】——用暂停时保存的预检结果续跑（不再弹文件选择），执行阶段按确认摘要去重
      const duplicateReviewContextId = templateId && typeof templateId === 'object'
        ? normalizeCell(templateId.duplicateReviewContextId)
        : '';
      if (duplicateReviewContextId) {
        const review = statementDuplicateReview.requireContext(duplicateReviewContextId);
        if (!review || review.kind !== 'file-import' || !review.prepared) {
          return {
            proceed: false,
            result: Object.assign(createPreflightErrorResult({
              message: '当前没有待确认的重复账单，请重新导入文件',
              errorCode: 'DUPLICATE_REVIEW_MISSING'
            }), { preservesSession: true })
          };
        }
        if (!isDuplicateReviewConfigCurrent(review)) {
          statementDuplicateReview.cancel(duplicateReviewContextId);
          return {
            proceed: false,
            result: Object.assign(createPreflightErrorResult({
              message: DUPLICATE_REVIEW_CONFIG_CHANGED_MESSAGE,
              errorCode: 'DUPLICATE_REVIEW_CONFIG_CHANGED'
            }), { preservesSession: true })
          };
        }
        const storedPrepared = review.prepared;
        return {
          ...storedPrepared,
          proceed: true,
          previewOnly: false,
          args: [review.templateId],
          duplicateReviewConfirmation: { contextId: duplicateReviewContextId, digest: review.digest },
          importConfigGuard: () => isDuplicateReviewConfigCurrent(review),
          beforeStart(...beforeStartArgs) {
            if (statementDuplicateReview.requireContext(duplicateReviewContextId) !== review) {
              throw new Error('重复账单确认已失效，请重新导入文件');
            }
            if (!isDuplicateReviewConfigCurrent(review)) {
              throw new Error(DUPLICATE_REVIEW_CONFIG_CHANGED_MESSAGE);
            }
            return typeof storedPrepared.beforeStart === 'function'
              ? storedPrepared.beforeStart(...beforeStartArgs)
              : undefined;
          }
        };
      }
      if (templateId && typeof templateId === 'object') {
        return {
          proceed: false,
          result: createPreflightErrorResult({ message: '请选择模板', errorCode: 'TEMPLATE_REQUIRED' })
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
      // v3.2.19：预检映射前记下配置：指定模板记该模板（含同渠道模板）的配置指纹；按文件名映射时参与的模板要映射后才知道，
      //   记模板目录快照（命中的模板另在映射后记配置指纹）。预检放行后，各路径（指定模板查重、按记住的顺序分配大账号、
      //   单账户识别、按文件名映射等）都可能复用预检映射的条目；任务开始前配置已变化时拒绝，不按旧配置的条目生成。
      const filenameMappingImport = isFilenameMappingMode(templateId);
      const catalogStampBeforeMapping = filenameMappingImport ? buildTemplateCatalogStamp() : null;
      const configStampBeforeMapping = filenameMappingImport ? null : buildDuplicateReviewConfigStamp([templateId]);
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
      previewPrepared.previewOnly = false;
      if (previewResult && previewResult.status === STATEMENT_IMPORT_PREVIEW_READY) {
        // v3.2.19：预检放行的条目随任务执行（可能复用预检映射的明细）：开始前核对映射前记下的配置
        const importConfig = filenameMappingImport
          ? (() => {
              const plan = previewPrepared.statementImportPlan;
              const matchedTemplateIds = (plan && Array.isArray(plan.trimmedProvisionalEntries) ? plan.trimmedProvisionalEntries : [])
                .map((entry) => entry && entry.matchedTemplateId);
              return {
                templateIds: matchedTemplateIds,
                stamp: buildDuplicateReviewConfigStamp(matchedTemplateIds),
                catalogStamp: catalogStampBeforeMapping
              };
            })()
          : { templateIds: [templateId], stamp: configStampBeforeMapping };
        previewPrepared.importConfigGuard = () => isImportConfigStampCurrent(importConfig);
        return previewPrepared;
      }
      // v3.2.19：重复账单过滤发现重复——保存预检结果，返回提醒，等待用户【确认】或【取消】
      if (previewResult && previewResult.status === DUPLICATE_REVIEW_STATUS && previewPrepared.pendingDuplicateReview) {
        const { scan, templateName } = previewPrepared.pendingDuplicateReview;
        const configTemplateIds = [templateId].concat(previewPrepared.pendingDuplicateReview.templateIds || []);
        const review = statementDuplicateReview.remember({
          kind: 'file-import',
          templateId,
          prepared: previewPrepared,
          scan,
          templateName,
          configTemplateIds,
          configStamp: buildDuplicateReviewConfigStamp(configTemplateIds),
          catalogStamp: catalogStampBeforeMapping
        });
        delete previewPrepared.pendingDuplicateReview;
        return {
          proceed: false,
          result: statementDuplicateReview.buildReviewResult(scan, {
            contextId: review.contextId,
            reviewKind: 'file-import',
            templateName
          })
        };
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
        // v3.2.19：条目已按当前模板配置映射；记下配置指纹，完成大账号选择时先核对（等待选择期间改了配置，如启用 / 关闭查重、
        //   改金额映射，须重新导入），再决定是否查重。与旧条目是否带查重指纹无关。
        {
          const duplicateTemplateIds = [templateId].concat(pendingContext.fileEntries.map((entry) => entry && entry.matchedTemplateId));
          pendingContext.duplicateReviewConfig = {
            templateIds: duplicateTemplateIds,
            stamp: buildDuplicateReviewConfigStamp(duplicateTemplateIds),
            catalogStamp: catalogStampBeforeMapping
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
    async execute(_event, prepared, taskContext, templateId) {
    if (!prepared.previewOnly) {
      const configChanged = checkImportConfigGuard(prepared, prepared.duplicateReviewConfirmation
        ? DUPLICATE_REVIEW_CONFIG_CHANGED_MESSAGE
        : IMPORT_CONFIG_CHANGED_MESSAGE);
      if (configChanged) return configChanged;
      // v3.2.19：重复账单【确认】在业务入口按 ID 核对并消费待确认上下文（同步完成，不会被并发请求穿插）：同一确认的
      //   第二个请求即使也通过了 beforeStart，到这里时上下文已被第一个取走，按未开始返回，不会重复写入会话
      if (prepared.duplicateReviewConfirmation) {
        const confirmationId = prepared.duplicateReviewConfirmation.contextId;
        if (!statementDuplicateReview.requireContext(confirmationId)) {
          return Object.assign(createPreflightErrorResult({
            message: '当前没有待确认的重复账单，请重新导入文件',
            errorCode: 'DUPLICATE_REVIEW_MISSING'
          }), { preservesSession: true });
        }
        statementDuplicateReview.clear(confirmationId);
      }
      prepared = bindStatementImportPreparedToFileEvidence(
        prepared,
        taskContext.fileEvidence.filePlan
      );
    }
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
        statementDuplicateReview.clear();
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

      // v3.2.15（D8）：与按表头匹配的导入一致，渠道有待处理的账户映射冲突时阻断。
      const singleTemplateChannelId = Number(templateConfig.template.channelId || 0);
      if (singleTemplateChannelId && database.countStatementChannelAccountMappingConflicts(singleTemplateChannelId) > 0) {
        return createErrorResult({
          step: '导入网银明细文件',
          message: `渠道「${templateConfig.template.channelName}」的账户映射还有待处理的冲突，请先在「账户映射」中为每个账户号选定一条设置后再导入`,
          errorCode: 'CHANNEL_ACCOUNT_MAPPING_CONFLICT_PENDING',
          context: { channelId: singleTemplateChannelId }
        });
      }

      // v3.2.15（release 审查）：指定模板导入同样核对库里输出名称相同的渠道 / 普通模板，避免两者的输出文件互相覆盖。
      const singleTemplateOutputNameConflicts = findGenerationGroupOutputNameConflicts([
        { key: resolveGenerationGroupKey(templateConfig.template), templateConfig }
      ]);
      if (singleTemplateOutputNameConflicts) {
        const error = buildStatementOutputNameConflictError(singleTemplateOutputNameConflicts);
        return createErrorResult({
          step: '导入网银明细文件',
          message: error.message,
          errorCode: error.code,
          detailLines: singleTemplateOutputNameConflicts,
          templateName: templateConfig.template.name
        });
      }

      const inputFilePaths = prepared.inputFilePaths;
      const session = statementImportSessionForInvocation(
        prepared,
        templateId,
        templateConfig.template.name
      );
      const selectionResult = prepared.selectionResult;


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
            // 文件个数不等于"记住顺序"里的文件个数 → 降级为"不固定"模式（不缓存判定，预检返回选择后不会再执行到这里）
            forceUnfixedMode = true;
            logSavedBigAccountOrderDowngrade(templateConfig.template.name, { reason: 'file-count', fileNames: [] });
          } else if (importFileCount === savedOrderConfig.fileCount) {
            const autoMatchDecision = resolvePreparedFixedBigAccountAutoMatchDecision(
              prepared,
              () => {
                // 每个导入文件按块顺序识别到的账号去全部保存文件里找匹配（不按位置对位）。识别取大账号顺序证据，
                // 与保存顺序同口径：直接识别逐块取，自定义输入 MerchantId 逐块经账户映射桥接（部分块桥接不到时
                // 保留已桥接的块，与保存时一致），只用导入时冻结的识别依据，不重开源文件。
                const importAccountLists = identifiedAccountsFromRowLists(bigAccountOrderEvidenceRowLists(
                  buildBigAccountOrderEvidence({
                    fileEntries: provisionalFileEntries,
                    bigAccounts: effectiveBigAccounts,
                    rowsWithEmptyBlocks: buildBigAccountSelectionRows(provisionalFileEntries, { includeEmptyBlocks: true })
                  })
                ));

                const {
                  failedImportIndexes,
                  ambiguousImportIndexes,
                  reorderedAssignments,
                  savedIndexByImport
                } = matchImportFilesToSavedOrder(importAccountLists, savedOrderConfig);
                const importFileName = (index) => path.basename(provisionalFileEntries[index].filePath);
                return {
                  failedFileNames: failedImportIndexes.map(importFileName),
                  ambiguousFileNames: ambiguousImportIndexes.map(importFileName),
                  reorderedAssignments,
                  savedIndexByImport
                };
              }
            );
            const { failedFileNames, ambiguousFileNames, reorderedAssignments, savedIndexByImport } = autoMatchDecision;

            // 记住的顺序无法唯一对应导入文件时（如同一多币种大账号的多份账单）不自动套用，降级为不固定模式由用户确认；
            // 匹配不上的文件仍走下方“记住顺序不匹配”提示。
            if (failedFileNames.length === 0 && ambiguousFileNames.length > 0) {
              forceUnfixedMode = true;
              // 常规导入在预检阶段即返回大账号选择，日志须在预检时写（判定按 prepared 缓存，同一次导入只写一次）。
              if (prepared.previewOnly || !Object.hasOwn(prepared, 'fixedBigAccountAutoMatchDecision')) {
                logSavedBigAccountOrderDowngrade(templateConfig.template.name, {
                  reason: 'ambiguous',
                  fileNames: ambiguousFileNames
                });
              }
            }

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

              // 重排后按位置逐块套用：每份文件逐块识别结果须与对上的记住文件一致（空段 / 未识别段位置、
              // 旧数据无法还原逐块信息时不自动套用，转人工选择，由下方选择结果的顺序核对降级）。
              // 有交易但识别不出账号的块只能按位置取分配、无法核对，也不自动生成，交由用户在选择窗口确认。
              const importRowLists = bigAccountOrderEvidenceRowLists(pendingContext.bigAccountOrderEvidence);
              const autoApplicable = findSavedOrderFileRowMismatches(importRowLists, savedOrderConfig, savedIndexByImport).length === 0
                && !hasUnidentifiedTransactionRows(importRowLists);
              const autoResult = prepared.previewOnly
                ? null
                : await ipcMain.emit('__internal-complete-big-account-selection__') || null;
              if (!autoResult && autoApplicable) {
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

                    // v3.2.19：重复账单过滤——在按记住顺序分配大账号后的条目上查重；预检有重复先暂停，
                    //   执行时按确认摘要去重。须以返回值传出（外层 catch 会把异常当成自动套用失败转人工选择）。
                    if (prepared.previewOnly) {
                      if (hasDuplicateRowKeys(pendingContext.fileEntries)) {
                        const paused = previewDuplicateRows(
                          applyBigAccountAssignmentsToFileEntries(
                            pendingContext.fileEntries,
                            normalizedAssignments,
                            { includeEmptyBlocks: isFixedMode }
                          ),
                          prepared,
                          templateConfig.template.name
                        );
                        if (paused) return paused;
                      }
                      return statementImportPreviewReady();
                    }

                    const reviewedAutoEntries = applyConfirmedDuplicateRowFilter(
                      applyBigAccountAssignmentsToFileEntries(
                        pendingContext.fileEntries,
                        normalizedAssignments,
                        { includeEmptyBlocks: isFixedMode }
                      ),
                      prepared,
                      templateConfig.template.name
                    );
                    if (reviewedAutoEntries.result) return reviewedAutoEntries.result;
                    const resolvedFileEntries = reviewedAutoEntries.entries;
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

                    resolvePendingReplacePaths(pendingContext).forEach((fp) => {
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
                } catch (autoMatchError) {
                  // v3.2.19：重复账单【确认】后的续跑：条目已按记住的顺序分配并经用户确认，生成失败（如收支同时有值）
                  //   照常按导入失败报错，不降级为重新选择大账号（复核窗口会把它当作最终结果）
                  if (prepared && prepared.duplicateReviewConfirmation && !prepared.previewOnly) throw autoMatchError;
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

        const pendingContext = stagePendingBigAccountSelection(prepared, {
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
          return selectionRequired;
        }
        // 固定模式未能自动套用（重排后逐块对不上、币种不可用等）而进入人工选择时，界面会按位置预填记住的分配，
        // 与标准入口同样按位置逐块核对，对不上就降级。
        return applySavedBigAccountOrderGuard(prepared, pendingContext, selectionRequired);
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

      // v3.2.19：重复账单过滤——需要在生成前跨文件查重，先映射全部文件（复用路径与多大账号相同），
      //   预检有重复先暂停，执行时按确认摘要去重。未勾选时不改变原路径。
      if (isDuplicateRowFilterEnabled(templateConfig.exportMappings) && !selectionResult.parentProvisionalEntries) {
        try {
          // 预映射放宽了受管大账号的校验；正式生成前按原路径（prepareGeneratedFiles）同一口径校验：
          //   多大账号模板未选定大账号时照常拒绝，不能因勾选查重生成账户为空的明细。
          buildStatementGenerationConfig({
            template: templateConfig.template,
            mappings: templateConfig.exportMappings,
            orderedTargetFields: templateConfig.exportTargetFields,
            selectedBigAccount
          });
          selectionResult.parentProvisionalEntries = buildPendingBigAccountFileEntries({
            template: templateConfig.template,
            mappings: templateConfig.exportMappings,
            orderedTargetFields: templateConfig.exportTargetFields,
            inputFilePaths: selectionResult.filePaths
          });
        } catch (error) {
          // 预检阶段不写报错文件：校验 / 映射失败时不在预检拦截，执行阶段重新映射并按原路径报错
          //   （与未勾选时一致，可导出含逐行明细的报错文件）。
          if (!prepared.previewOnly || !(error instanceof FileValidationError)
            || error.code === STATEMENT_SOURCE_FRESHNESS_FAILURE.code) {
            throw error;
          }
        }
      }

      if (prepared.previewOnly) {
        if (hasDuplicateRowKeys(selectionResult.parentProvisionalEntries)) {
          const paused = previewDuplicateRows(
            resolveReusedSingleTemplateEntries({
              parentProvisionalEntries: selectionResult.parentProvisionalEntries,
              templateConfig,
              selectedBigAccount
            }),
            prepared,
            templateConfig.template.name
          );
          if (paused) return paused;
        }
        return statementImportPreviewReady();
      }

      let generatedFiles;
      if (selectionResult.parentProvisionalEntries) {
        const generationTemplateConfig = resolveGenerationTemplateConfig({
          fileEntries: selectionResult.parentProvisionalEntries,
          fallbackTemplateConfig: templateConfig
        });
        const reviewedEntries = applyConfirmedDuplicateRowFilter(
          resolveReusedSingleTemplateEntries({
            parentProvisionalEntries: selectionResult.parentProvisionalEntries,
            templateConfig,
            selectedBigAccount
          }),
          prepared,
          templateConfig.template.name
        );
        if (reviewedEntries.result) return reviewedEntries.result;
        const rebuiltFileEntries = reviewedEntries.entries;
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

      if (error && error.code === STATEMENT_SOURCE_FRESHNESS_FAILURE.code) {
        if (prepared.previewOnly) {
          return createPreflightErrorResult({
            message: STATEMENT_SOURCE_FRESHNESS_FAILURE.message,
            errorCode: STATEMENT_SOURCE_FRESHNESS_FAILURE.code
          });
        }
        throw error;
      }

      if (error instanceof FileValidationError) {
        // v3.2.16：币种未维护大账号需要把文件 / 币种 / 行号带回界面弹窗（spec D1）；
        //   v3.2.21：渠道余额方式冲突、出余额的交易缺账单日期或 MerchantId 同样带回明细
        const buildResult = String(error.code || '').startsWith('CURRENCY_BIG_ACCOUNT_')
          || error.code === 'CHANNEL_BALANCE_MODE_MISMATCH'
          || error.code === 'CHANNEL_BALANCE_ROWS_INCOMPLETE'
          ? createDetailedErrorResult
          : createErrorResult;
        return buildResult({
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
  // v3.2.19：重复账单【确认】续跑在预检被拒绝时标记未开始（见 markContinuationPrepareRejection）
  const prepareFileImportRequest = fileImportHandler.prepare;
  fileImportHandler.prepare = async (event, templateId) => {
    const outcome = await prepareFileImportRequest(event, templateId);
    const isContinuation = Boolean(templateId && typeof templateId === 'object'
      && normalizeCell(templateId.duplicateReviewContextId));
    return isContinuation ? markContinuationPrepareRejection(outcome) : outcome;
  };
  trackedIpcHandle(
    'file:import',
    '生成网银账单',
    '导入文件',
    fileImportHandler
  );

  ipcMain.handle('file:cancel-big-account-selection', (_event, contextId) => {
    // v3.2.19：重复账单提醒【取消】也走本通道：清除待确认的重复账单及其关联的大账号选择，不生成、不改会话
    const duplicateReview = statementDuplicateReview.cancel(contextId);
    if (duplicateReview) {
      if (duplicateReview.bigAccountContextId) clearPendingBigAccountSelection(duplicateReview.bigAccountContextId);
      return { status: 'success' };
    }
    if (!requirePendingBigAccountSelection(contextId)) {
      return { status: 'not-active' };
    }
    clearPendingBigAccountSelection(contextId);
    return { status: 'success' };
  });

  const completeBigAccountSelectionHandler = {
    prepare(_event, requestPayload = {}) {
      // v3.2.19：带 duplicateReviewContextId 时为重复账单提醒【确认】——按暂停时保存的大账号选择重新预检，带上确认摘要续跑
      const prepareCompletion = (payload = {}, { confirmation = null, review = null } = {}) => {
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
          const normalized = normalizePendingBigAccountSelection(pendingContext, payload);
          // v3.2.19：重复账单过滤——条目是导入时按当时的配置映射的；等待选择期间配置变化（如关闭查重、改金额映射）须重新导入
          const mappingConfig = pendingContext.duplicateReviewConfig || null;
          if (!confirmation && mappingConfig && !isImportConfigStampCurrent(mappingConfig)) {
            clearPendingBigAccountSelection(contextId);
            return {
              proceed: false,
              result: Object.assign(createPreflightErrorResult({
                message: DUPLICATE_REVIEW_CONFIG_CHANGED_MESSAGE,
                errorCode: 'DUPLICATE_REVIEW_CONFIG_CHANGED'
              }), { preservesSession: true })
            };
          }
          // 分配大账号后的条目在本次预检内只构建一次：要查重时整批构建，余额方式冲突与重复账单两项检查共用；
          //   不查重时冲突检查只分配余额方式不同的渠道组的条目
          let assignedEntries = null;
          const resolveAssignedEntries = () => assignedEntries || (assignedEntries = applyBigAccountAssignmentsToFileEntries(
            pendingContext.fileEntries,
            normalized.normalizedAssignments,
            { includeEmptyBlocks: normalized.isFixedMode }
          ));
          const reviewsDuplicateRows = !confirmation && hasDuplicateRowKeys(pendingContext.fileEntries);
          // v3.2.21（D3）：按本次分配的大账号判断渠道组内同一账户是否命中不同余额方式（导入预检时多大账号模板的行还没有账号）。
          //   有则未开始即拒绝（保留上一批的导出与补录入口），须统一余额方式后整批重新导入
          const balanceModeConflicts = isFilenameMappingMode(pendingContext.templateId)
            ? findResolvedEntriesBalanceModeConflicts(
              (Array.isArray(pendingContext.balanceModeMixedEntryIndexes)
                ? pendingContext.balanceModeMixedEntryIndexes
                : listBalanceModeMixedEntryIndexes(groupStatementEntriesForGeneration(pendingContext.fileEntries), pendingContext.fileEntries)
              ).map((index) => pendingContext.fileEntries[index]),
              (mixedEntries) => (reviewsDuplicateRows
                ? pickResolvedEntries(pendingContext.fileEntries, resolveAssignedEntries(), mixedEntries)
                : applyBigAccountAssignmentsToFileEntries(
                  pendingContext.fileEntries,
                  normalized.normalizedAssignments,
                  {
                    includeEmptyBlocks: normalized.isFixedMode,
                    onlyEntries: new Set(mixedEntries),
                    // 不参与复核的文件按选择窗口已识别的账号块计数，不再扫描
                    blockCounts: countSelectionRowsByFile(
                      normalized.isFixedMode ? pendingContext.rowsWithEmptyBlocks : pendingContext.rows,
                      pendingContext.fileEntries
                    )
                  }
                ))
            )
            : null;
          if (balanceModeConflicts) {
            clearPendingBigAccountSelection(contextId);
            if (confirmation) statementDuplicateReview.cancel(confirmation.contextId);
            const error = buildChannelBalanceModeMismatchError(balanceModeConflicts);
            return {
              proceed: false,
              result: createPreflightErrorResult({
                message: error.message,
                errorCode: error.code,
                detailLines: error.detailLines
              })
            };
          }
          // v3.2.19：重复账单过滤——按本次分配大账号后的条目查重；有重复且尚未确认时暂停（保留大账号选择上下文）
          if (reviewsDuplicateRows) {
            const reviewPrepared = {};
            const paused = previewDuplicateRows(
              resolveAssignedEntries(),
              reviewPrepared,
              pendingContext.template && pendingContext.template.name
            );
            if (paused) {
              const { scan, templateName, templateIds } = reviewPrepared.pendingDuplicateReview;
              // 指纹沿用映射条目时记下的（核对的是生成这些条目时的配置），没有时按当前配置记
              const configTemplateIds = mappingConfig
                ? mappingConfig.templateIds.slice()
                : [pendingContext.templateId].concat(templateIds || []);
              const pendingReview = statementDuplicateReview.remember({
                kind: 'big-account',
                templateId: pendingContext.templateId,
                bigAccountContextId: contextId,
                bigAccountPayload: { ...payload },
                scan,
                templateName,
                configTemplateIds,
                configStamp: mappingConfig ? mappingConfig.stamp : buildDuplicateReviewConfigStamp(configTemplateIds),
                catalogStamp: mappingConfig ? mappingConfig.catalogStamp || null : null
              });
              return {
                proceed: false,
                result: statementDuplicateReview.buildReviewResult(scan, {
                  contextId: pendingReview.contextId,
                  reviewKind: 'big-account',
                  templateName
                })
              };
            }
          }
          return {
            proceed: true,
            args: [],
            contextId,
            pendingContext,
            ...normalized,
            ...(confirmation ? { duplicateReviewConfirmation: confirmation } : {}),
            filePlan: {
              version: 1,
              allocation: 'eager',
              inputs: buildStatementInputFilePlanItems(
                pendingContext.sourceSelections,
                'file:complete-big-account-selection'
              ),
              outputs: []
            },
            rememberOrder: normalized.isFixedMode && typeof payload.rememberOrder === 'boolean'
              ? payload.rememberOrder
              : null,
            importConfigGuard: () => (review ? isDuplicateReviewConfigCurrent(review) : isImportConfigStampCurrent(mappingConfig)),
            beforeStart() {
              const current = requirePendingBigAccountSelection(contextId);
              if (current !== pendingContext) {
                throw new Error('大账号选择上下文已失效，请重新导入文件');
              }
              if (review && statementDuplicateReview.requireContext(confirmation.contextId) !== review) {
                throw new Error('重复账单确认已失效，请重新导入文件');
              }
              if (review && !isDuplicateReviewConfigCurrent(review)) {
                throw new Error(DUPLICATE_REVIEW_CONFIG_CHANGED_MESSAGE);
              }
              // 普通选择（不经重复账单确认）：预检之后、任务开始之前（文件批次预留、证据采集期间）配置也可能被修改，
              //   条目仍是按旧配置映射的，同一口径拒绝、要求重新导入
              if (!review && mappingConfig && !isImportConfigStampCurrent(mappingConfig)) {
                throw new Error(DUPLICATE_REVIEW_CONFIG_CHANGED_MESSAGE);
              }
              if (pendingContext.assertSessionCurrent) pendingContext.assertSessionCurrent();
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
      };
      const duplicateReviewContextId = normalizeCell(requestPayload && requestPayload.duplicateReviewContextId);
      if (duplicateReviewContextId) {
        const review = statementDuplicateReview.requireContext(duplicateReviewContextId);
        if (!review || review.kind !== 'big-account' || !review.bigAccountPayload) {
          return {
            proceed: false,
            result: Object.assign(createPreflightErrorResult({
              message: '当前没有待确认的重复账单，请重新导入文件',
              errorCode: 'DUPLICATE_REVIEW_MISSING'
            }), { preservesSession: true })
          };
        }
        if (!isDuplicateReviewConfigCurrent(review)) {
          statementDuplicateReview.cancel(duplicateReviewContextId);
          if (review.bigAccountContextId) clearPendingBigAccountSelection(review.bigAccountContextId);
          return {
            proceed: false,
            result: Object.assign(createPreflightErrorResult({
              message: DUPLICATE_REVIEW_CONFIG_CHANGED_MESSAGE,
              errorCode: 'DUPLICATE_REVIEW_CONFIG_CHANGED'
            }), { preservesSession: true })
          };
        }
        return prepareCompletion(review.bigAccountPayload, {
          confirmation: { contextId: duplicateReviewContextId, digest: review.digest },
          review
        });
      }
      return prepareCompletion(requestPayload, {});
    },
    async execute(_event, prepared, taskContext) {
    // 暂存的条目按记下时的配置映射：业务入口使用前再核对（见 checkImportConfigGuard）
    const configChanged = checkImportConfigGuard(prepared, prepared.duplicateReviewConfirmation
      ? DUPLICATE_REVIEW_CONFIG_CHANGED_MESSAGE
      : IMPORT_CONFIG_CHANGED_MESSAGE);
    if (configChanged) return configChanged;
    const storedPendingContext = requirePendingBigAccountSelection(prepared.contextId);
    if (!storedPendingContext) {
      return createErrorResult({
        step: '选择大账号',
        message: '当前没有待处理的大账号选择任务，请重新导入文件',
        errorCode: 'BIG_ACCOUNT_SELECTION_MISSING'
      });
    }
    const inputFilePaths = taskContext.fileEvidence.filePlan.inputs
      .map((item) => item.filePath);
    const pendingContext = {
      ...storedPendingContext,
      inputFilePaths,
      fileEntries: storedPendingContext.fileEntries.map((entry, index) => ({
        ...entry,
        filePath: inputFilePaths[index]
      }))
    };
    clearPendingBigAccountSelection(prepared.contextId);
    statementDuplicateReview.clear();
    const { isFixedMode, normalizedAssignments, rememberOrder } = prepared;
    try {
      const session = getOrCreateStatementImportSession({
        statementImportSessions,
        templateId: pendingContext.templateId,
        templateName: pendingContext.template.name
      });

      // v3.2.19：重复账单过滤——有重复时须已确认（摘要一致）才去重生成，否则拒绝
      const reviewedEntries = applyConfirmedDuplicateRowFilter(
        applyBigAccountAssignmentsToFileEntries(
          pendingContext.fileEntries,
          normalizedAssignments,
          { includeEmptyBlocks: isFixedMode }
        ),
        prepared,
        pendingContext.template.name
      );
      if (reviewedEntries.result) return reviewedEntries.result;
      const resolvedFileEntries = reviewedEntries.entries;
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
          replacePaths: resolvePendingReplacePaths(pendingContext),
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

      resolvePendingReplacePaths(pendingContext).forEach((filePath) => {
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

      if (error && error.code === STATEMENT_SOURCE_FRESHNESS_FAILURE.code) {
        throw error;
      }

      if (error instanceof FileValidationError) {
        // v3.2.16：币种未维护大账号需要把文件 / 币种 / 行号带回界面弹窗（spec D1）；
        //   v3.2.21：渠道余额方式冲突、出余额的交易缺账单日期或 MerchantId 同样带回明细
        const buildResult = String(error.code || '').startsWith('CURRENCY_BIG_ACCOUNT_')
          || error.code === 'CHANNEL_BALANCE_MODE_MISMATCH'
          || error.code === 'CHANNEL_BALANCE_ROWS_INCOMPLETE'
          ? createDetailedErrorResult
          : createErrorResult;
        return buildResult({
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

  // v3.2.19：完成大账号选择（含重复账单【确认】续跑）在预检被拒绝时标记未开始；大账号选择无效时保留选择窗口重新选择
  const prepareBigAccountCompletion = completeBigAccountSelectionHandler.prepare;
  completeBigAccountSelectionHandler.prepare = async (event, requestPayload) => markContinuationPrepareRejection(
    await prepareBigAccountCompletion(event, requestPayload),
    { keepErrorCodes: requestPayload && normalizeCell(requestPayload.duplicateReviewContextId) ? [] : ['BIG_ACCOUNT_SELECTION_INVALID'] }
  );
  businessIpcHandle(
    'file:complete-big-account-selection',
    '生成账单',
    completeBigAccountSelectionHandler
  );


  ipcMain.handle('file:extract-big-account-order', (_event, payload = {}) => {
    const pendingContext = requirePendingBigAccountSelection(payload.contextId);
    if (!pendingContext) {
      return { status: 'error', failedRows: [], message: '当前没有待处理的大账号选择任务，请重新导入文件' };
    }
    return extractBigAccountOrderFromEvidence(
      pendingContext,
      payload?.mode || 'unfixed',
      payload.rowIndexes
    );
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
        if (!resolution.prepared.proceed) return resolution.prepared;
        const filePlanInputPaths = resolveManualBalanceSeedFilePlanInputPaths({
          prepared: resolution.prepared,
          importContext,
          session
        });
        if (!filePlanInputPaths.length) {
          return {
            proceed: false,
            result: createPreflightErrorResult({
              message: '当前账单会话缺少源文件，请重新导入后再补录余额',
              errorCode: 'BALANCE_SEED_SOURCE_MISSING'
            })
          };
        }
        return {
          ...resolution.prepared,
          filePlan: {
            version: 1,
            allocation: 'eager',
            inputs: filePlanInputPaths.map((filePath) => ({
              filePath,
              role: 'input',
              sourceOperation: 'file:save-balance-seed'
            })),
            outputs: []
          }
        };
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

    async execute(_event, prepared, taskContext) {
      const inputFilePaths = taskContext.fileEvidence.filePlan.inputs
        .map((item) => item.filePath);
      const { plan, pendingPrompt, session } = prepared || {};
      const skipBalanceGapKeys = Array.isArray(prepared && prepared.skipBalanceGapKeys)
        ? prepared.skipBalanceGapKeys
        : null;
      const confirmBalanceMismatchKeys = Array.isArray(prepared && prepared.confirmBalanceMismatchKeys)
        ? prepared.confirmBalanceMismatchKeys
        : null;
      const confirmBalanceSeedReplaceKeys = Array.isArray(prepared && prepared.confirmBalanceSeedReplaceKeys)
        ? prepared.confirmBalanceSeedReplaceKeys
        : null;
      const importContext = prepared && prepared.importContext
        ? { ...prepared.importContext, inputFilePaths }
        : null;
      if ((!plan && !skipBalanceGapKeys && !confirmBalanceMismatchKeys && !confirmBalanceSeedReplaceKeys)
          || !pendingPrompt || !importContext
          || (plan && plan.existingIndex >= 0 && prepared.confirmedOverwrite !== true)) {
        throw new TypeError('余额补录 execute 缺少已确认的准备计划');
      }
      if (prepared.confirmedOverwrite === true) {
        // 真实 execute 入口只消费一次主进程确认上下文。
        lastPendingBalanceSeedConfirmation = null;
      }

      try {
        // v3.2.15（release 审查）：补录后会重新生成；先按将使用的输出配置核对输出名称，冲突时不写入种子、不登记断档、不生成。
        //   按文件名映射按会话全部分组核对；指定模板按记下的生成上下文核对（导入后模板或渠道可能已改名）。
        //   按文件名映射另按将重新生成的各组规划核对实际输出文件名（名称拼上账号），同样在写种子、登记断档之前拦下。
        let regenerationPlan = null;
        if (isFilenameMappingMode(importContext.templateId) && session) {
          const outputNameConflicts = findGenerationGroupOutputNameConflicts(
            groupStatementEntriesForGeneration(getStatementSessionEntries(session, importContext.scope || 'current'))
          );
          if (outputNameConflicts) throw buildStatementOutputNameConflictError(outputNameConflicts);
          regenerationPlan = planVirtualTemplateBalanceRegeneration(session, importContext.scope || 'current');
          assertVirtualTemplateBalanceOutputPaths(regenerationPlan);
        } else {
          assertGenerationOutputNameUnique(importContext.template);
        }
        if (skipBalanceGapKeys) {
          // 登记在真实会话（或原 importContext）上，execute 内的 importContext 只是副本。
          if (!rememberAcknowledgedBalanceGaps({
            session,
            importContext: prepared.importContext,
            gapKeys: skipBalanceGapKeys
          })) {
            throw new FileValidationError('BALANCE_GAP_CONTEXT_MISSING', '当前账单会话已失效，请重新导入文件');
          }
          appendActivityLogEntry({
            level: 'warn',
            message: '账单日期不连续，选择不补录期末余额，余额可能不准确',
            details: [
              `模板名：${pendingPrompt.templateName || 'N/A'}`,
              ...(prepared.skippedBalanceGaps || []).map(formatBalanceGapLine)
            ]
          });
        } else if (confirmBalanceMismatchKeys) {
          // 与断档“不补录”同一会话确认集合；登记后按账单余额重算，种子照常回写。
          if (!rememberAcknowledgedBalanceGaps({
            session,
            importContext: prepared.importContext,
            gapKeys: confirmBalanceMismatchKeys
          })) {
            throw new FileValidationError('BALANCE_MISMATCH_CONTEXT_MISSING', '当前账单会话已失效，请重新导入文件');
          }
          appendActivityLogEntry({
            level: 'warn',
            message: '余额校验不一致，已确认按账单余额生成',
            details: [
              `模板名：${pendingPrompt.templateName || 'N/A'}`,
              ...(prepared.confirmedBalanceMismatches || []).map(formatBalanceMismatchLine)
            ]
          });
        } else if (confirmBalanceSeedReplaceKeys) {
          // 与断档、余额不一致同一确认集合；登记后重算，按本次余额回写并替换人工补录。
          if (!rememberAcknowledgedBalanceGaps({
            session,
            importContext: prepared.importContext,
            gapKeys: confirmBalanceSeedReplaceKeys
          })) {
            throw new FileValidationError('BALANCE_SEED_REPLACE_CONTEXT_MISSING', '当前账单会话已失效，请重新导入文件');
          }
          appendActivityLogEntry({
            level: 'warn',
            message: '人工补录的期末余额与本次余额不一致，已确认替换',
            details: [
              `模板名：${pendingPrompt.templateName || 'N/A'}`,
              ...(prepared.confirmedBalanceSeedReplacements || []).map(formatBalanceSeedReplaceLine)
            ]
          });
        } else {
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
        }

        // v3.2.19：本次重新生成范围内确认去除的重复账单行数（会话条目保留去重统计），补录后的提示照常附上
        const duplicateDroppedRowCount = session
          ? statementGenerationHelpers.countDuplicateDroppedRows(getStatementSessionEntries(session, importContext.scope || 'current'))
          : 0;
        const duplicateUncheckedRowCount = session
          ? statementGenerationHelpers.countDuplicateUncheckedRows(getStatementSessionEntries(session, importContext.scope || 'current'))
          : 0;
        const withDuplicateDropped = (result) => statementGenerationHelpers.attachDuplicateDropped(result, duplicateDroppedRowCount, duplicateUncheckedRowCount);
        // v1.5.2：虚拟 ID 下走多模板重新生成（避免用单组 importContext 产出不完整余额）
        if (isFilenameMappingMode(importContext.templateId) && session) {
          const regenResult = regenerateVirtualTemplateBalanceFromSession(
            session,
            importContext.scope || 'current',
            regenerationPlan || undefined
          );
          if (regenResult.needsSeed) {
            const pendingFiles = {
              warnings: regenResult.warnings,
              balance: null,
              detail: lastGeneratedExports.detail,
              balanceRequested: true
            };
            // 还有其他 group 需要补录、确认断档或确认余额不一致 → 返回下一个 prompt
            if (regenResult.gaps) return withDuplicateDropped(buildBalanceGapConfirmResult(regenResult.gaps, pendingFiles));
            if (regenResult.mismatches) return withDuplicateDropped(buildBalanceMismatchConfirmResult(regenResult.mismatches, pendingFiles));
            if (regenResult.replacements) {
              return withDuplicateDropped(buildBalanceSeedReplaceConfirmResult(regenResult.replacements, pendingFiles));
            }
            return withDuplicateDropped(buildManualBalanceRequiredResult(regenResult.prompt, pendingFiles));
          }
          const generatedFiles = regenResult.generatedFiles;
          if (importContext.scope === 'all') {
            // 任一模板组余额生成失败时不缓存缺组的“全部”余额：再次导出全部时重新生成并按失败组阻断。
            const hasFailedGroup = (generatedFiles.warnings || [])
              .some((warning) => warning && warning.type === 'balance-generate-failed');
            cacheAllStatementExport('balance', hasFailedGroup ? null : generatedFiles.balance, generatedFiles.warnings);
          } else {
            lastGeneratedExports.balance = generatedFiles.balance;
          }
          return buildImportResultFromGeneratedFiles({
            generatedFiles: { ...generatedFiles, detail: lastGeneratedExports.detail, duplicateDroppedRowCount, duplicateUncheckedRowCount },
            templateId: FILENAME_MAPPING_TEMPLATE_ID,
            templateName: '按文件名映射模板',
            inputFilePaths: importContext.inputFilePaths
          });
        }

        const generatedFiles = generateFilesFromRememberedContext(importContext);

        if (importContext.scope === 'all') {
          cacheAllStatementExport('balance', generatedFiles.balance, generatedFiles.warnings);
        } else if (session) {
          updateStatementSessionCache(session, importContext.currentBatchId || session.currentBatchId, generatedFiles);
        } else {
          lastGeneratedExports.detail = generatedFiles.detail;
          lastGeneratedExports.balance = generatedFiles.balance;
        }

        return buildImportResultFromGeneratedFiles({
          generatedFiles: { ...generatedFiles, duplicateDroppedRowCount, duplicateUncheckedRowCount },
          templateId: importContext.templateId,
          templateName: importContext.template.name,
          inputFilePaths: importContext.inputFilePaths
        });
      } catch (error) {
        if (error instanceof FileValidationError) {
          clearPendingManualBalancePrompt();
          // v3.2.21：渠道余额方式冲突、出余额的交易缺账单日期或 MerchantId 时带回明细供弹窗列出
          const buildResult = error.code === 'CHANNEL_BALANCE_MODE_MISMATCH' || error.code === 'CHANNEL_BALANCE_ROWS_INCOMPLETE'
            ? createDetailedErrorResult
            : createErrorResult;
          return buildResult({
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
          errorCode: error && error.code || 'EXPORT_PREPARE_FAILED',
          detailLines: error && Array.isArray(error.detailLines) ? error.detailLines : []
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
    // v3.2.21（D3）：另存为框打开期间映射可能变化。确认后先复检渠道余额，不通过时在开始任务之前带逐行明细拒绝（不预留输出、
    //   不进入执行，与第一次预检相同）；其他变化与之后到任务开始之间的变化仍由 beforeStart 按“会话已变化”拒绝
    let channelBalanceStop = null;
    try {
      channelBalanceStop = recheckStatementExportChannelBalance(kind, plan);
    } catch (_error) {
      // 其他错误交给 beforeStart 处理（与此前一致）
    }
    if (channelBalanceStop) return { proceed: false, result: channelBalanceStop };
    return {
      proceed: true,
      kind,
      plan,
      filePlan: {
        version: 1,
        allocation: 'eager',
        inputs: [],
        outputs: [{
          filePath: saveResult.filePath,
          role: 'output',
          sourceOperation: kind === 'detail' ? 'file:export-detail' : 'file:export-balance'
        }]
      },
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
    async execute(_event, prepared, taskContext) {
      const result = exportStatementByScope(
        'detail',
        prepared.plan.normalizedScope,
        taskContext.fileEvidence.filePlan.outputs[0].filePath
      );
      await taskContext.settleArtifacts({
        files: taskContext.fileEvidence.filePlan.outputs
          .map((item) => ({ artifactKey: item.artifactKey }))
      });
      return result;
    }
  });

  trackedIpcHandle('file:export-balance', '生成网银账单', '导出余额', {
    prepare: (_event, scope = 'auto') => prepareStatementExport('balance', scope),
    async execute(_event, prepared, taskContext) {
      const result = exportStatementByScope(
        'balance',
        prepared.plan.normalizedScope,
        taskContext.fileEvidence.filePlan.outputs[0].filePath
      );
      await taskContext.settleArtifacts({
        files: taskContext.fileEvidence.filePlan.outputs
          .map((item) => ({ artifactKey: item.artifactKey }))
      });
      return result;
    }
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
  trackedIpcHandle('monthly-balance:assemble', '装配月度余额', '装配月度余额', {
    prepare: (_event, payload = {}) => ({
      proceed: true,
      payload,
      filePlan: { version: 1, allocation: 'deferred', inputs: [], outputs: [] }
    }),
    async execute(_event, prepared, taskContext) {
    const payload = prepared.payload;
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

      const channelMigrationPendingMessage = getStatementChannelMigrationPendingMessage();
      if (channelMigrationPendingMessage) {
        lastGeneratedExports.monthlyBalance = null;
        return {
          status: 'error',
          errorCode: 'STATEMENT_CHANNEL_MIGRATION_PENDING',
          message: channelMigrationPendingMessage
        };
      }

      const storageRoot = getStorageRoot();
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
      const promotionManifest = buildStatementDeferredOutputManifest(
        output.outputFilePath,
        'monthly-balance:assemble'
      );
      await taskContext.ensureFileBatch(promotionManifest);
      const promotedOutputPath = promotionManifest.outputs[0].filePath;

      writeBalanceWorkbook({
        templateFilePath: balanceTemplatePath,
        records,
        templateFields: balanceTemplateFields,
        outputFilePath: promotedOutputPath
      });
      await taskContext.settleArtifacts({
        files: promotionManifest.outputs.map((item) => ({ artifactKey: item.artifactKey }))
      });

      lastGeneratedExports.monthlyBalance = {
        filePath: promotedOutputPath,
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
          `临时文件：${promotedOutputPath}`
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
        pending,
        filePlan: {
          version: 1,
          allocation: 'eager',
          inputs: [],
          outputs: [{
            filePath: saveResult.filePath,
            role: 'output',
            sourceOperation: 'monthly-balance:export'
          }]
        },
        beforeStart() {
          if (lastGeneratedExports.monthlyBalance !== pending || !fs.existsSync(pending.filePath)) {
            throw new Error('月度余额待导出文件已变化，请重新选择导出位置');
          }
        }
      };
    },
    async execute(_event, prepared, taskContext) {
    try {
      const { pending } = prepared;
      const savePath = taskContext.fileEvidence.filePlan.outputs[0].filePath;
      fs.copyFileSync(pending.filePath, savePath);
      await taskContext.settleArtifacts({
        files: taskContext.fileEvidence.filePlan.outputs
          .map((item) => ({ artifactKey: item.artifactKey }))
      });
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
  trackedIpcHandle('new-account:generate', '新开账户', '生成余额账单', {
    prepare: (_event, payload = {}) => ({
      proceed: true,
      payload,
      filePlan: { version: 1, allocation: 'deferred', inputs: [], outputs: [] }
    }),
    async execute(_event, prepared, taskContext) {
    const payload = prepared.payload;
    const accounts = normalizeNewAccountAccounts(payload);

    try {
      validateNewAccountAccounts(accounts);
    } catch (error) {
      if (error instanceof FileValidationError) {
        return createErrorResult({
          step: '生成新开账户余额账单',
          message: error.message,
          errorCode: error.code,
          detailLines: error.detailLines,
          originalError: error,
          templateName: NEW_ACCOUNT_EXPORT_NAME,
          context: { moduleName: NEW_ACCOUNT_EXPORT_NAME }
        });
      }
      throw error;
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

      const generated = prepareNewAccountGeneration({
        accounts,
        balanceTemplateFields
      });

      const output = buildOutputFilePath({
        kind: 'new-account',
        outputFileName: generated.fileName
      });
      const promotionManifest = buildStatementDeferredOutputManifest(
        output.outputFilePath,
        'new-account:generate'
      );
      await taskContext.ensureFileBatch(promotionManifest);
      const promotedOutputPath = promotionManifest.outputs[0].filePath;

      writeBalanceWorkbook({
        templateFilePath: balanceTemplatePath,
        records: generated.records,
        templateFields: balanceTemplateFields,
        outputFilePath: promotedOutputPath
      });
      await taskContext.settleArtifacts({
        files: promotionManifest.outputs.map((item) => ({ artifactKey: item.artifactKey }))
      });

      lastGeneratedExports = {
        detail: lastGeneratedExports.detail,
        balance: lastGeneratedExports.balance,
        newAccount: {
          filePath: promotedOutputPath,
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
          `币种：${generated.currencySegment}`,
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
          detailLines: error.detailLines,
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
        generatedFile,
        filePlan: {
          version: 1,
          allocation: 'eager',
          inputs: [],
          outputs: [{
            filePath: saveResult.filePath,
            role: 'output',
            sourceOperation: 'new-account:export'
          }]
        },
        beforeStart() {
          if (lastGeneratedExports.newAccount !== generatedFile
              || !fs.existsSync(generatedFile.filePath)) {
            throw new Error('新开账户待导出文件已变化，请重新导出');
          }
        }
      };
    },
    async execute(_event, prepared, taskContext) {
      const result = exportGeneratedFile(
        prepared.generatedFile,
        '暂无可导出的新开账户余额账单',
        '导出新开账户余额账单',
        taskContext.fileEvidence.filePlan.outputs[0].filePath
      );
      await taskContext.settleArtifacts({
        files: taskContext.fileEvidence.filePlan.outputs
          .map((item) => ({ artifactKey: item.artifactKey }))
      });
      return result;
    }
  });

  // ==========================================================================
  // v2.1.12 需求1：VCC业务OP计算 — vccOpCalc:* IPC handlers（spec §3.6，6 个）
  // 命名空间 vccOpCalc:*；与现有 5 模块完全独立。资金红线 🔴（发生额求和 / 期末OP / 整数分精度）。
  // 资金/运行类用 trackedIpcHandle（scan / compute-amounts / save）；只读 list/get 用普通 handle。
  // 中间结果（scan/compute 的原始 rows + 统计）缓存在 vccOpCalcSession（仿 lastRunCache，spec Q1）。
  // ==========================================================================

  // 多选流水 xlsx（multiSelections）
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
  trackedIpcHandle('vccOpCalc:import:scan', 'VCC业务OP计算', '导入文件', {
    prepare(_event, payload = {}) {
      const { filePaths } = payload || {};
      if (!database || !database.db) return { proceed: false, result: { status: 'error', message: '数据库未初始化' } };
      if (!Array.isArray(filePaths) || filePaths.length === 0) {
        return { proceed: false, result: { status: 'error', message: '未选择文件' } };
      }
      return {
        proceed: true,
        filePlan: {
          version: 1,
          allocation: 'eager',
          inputs: filePaths.map((filePath) => ({
            filePath,
            role: 'input',
            sourceOperation: 'vccOpCalc:import:scan'
          })),
          outputs: []
        }
      };
    },
    async execute(event, _prepared, taskContext) {
    const filePaths = taskContext.fileEvidence.filePlan.inputs.map((item) => item.filePath);
    // 流式读取+聚合（spec §9 大文件路径，合并 scan+compute，不存全量行）；进度推送 renderer。
    // 表头校验失败 → FileValidationError；非法行/多月份混杂 → ok:false + errorRows（整批拒绝）。
    let result;
    try {
      // 设置 → 模板文件「流水对账单」当前结构：每次扫描时解析，不可用时中止并指向设置。
      const flowStructure = await resolveFlowStatementStructure(getTemplateResourceService());
      result = await vccOpCalcSession.streamScanAndCompute(filePaths, {
        sourceHeaders: flowStructure ? flowStructure.headers : null,
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
    }
  });

  // 统计发生额出/入/总额 + perFile（供 F2，不落库）。复用 scan 缓存的 rows（资金红线：同口径整批校验）。
  trackedIpcHandle('vccOpCalc:run:compute-amounts', 'VCC业务OP计算', '开始运行', {
    execute: (_event, _prepared, taskContext, _payload = {}) => {
    if (!database || !database.db) return { status: 'error', message: '数据库未初始化' };
    // 流式改造（spec §9）：scan 阶段已合并统计并缓存 lastComputeCache，这里直接返回缓存（不重读文件）
    const cache = vccOpCalcSession.getComputeCache();
    if (!cache) return { status: 'error', message: '无统计结果（请先导入文件）' };
    appendActivityLogEntry({
      level: 'info',
      source: 'main',
      domain: 'vcc-op-calc',
      message: 'VCC 业务 OP 发生额统计完成',
      details: [`Task Run：${taskContext.operationContext.taskRunId}`]
    });
    return {
      status: 'success',
      yearMonth: cache.yearMonth,
      totals: cache.totals,
      perFile: cache.perFile
    };
    }
  });

  // 收 beginOp → 算 endOp = beginOp + 发生额 → 原子落表 A/B（资金红线 🔴）。返回 { runId, endOp }。
  trackedIpcHandle('vccOpCalc:run:save', 'VCC业务OP计算', '开始运行', {
    execute: (_event, _prepared, taskContext, payload = {}) => {
    if (!database || !database.db) return { status: 'error', message: '数据库未初始化' };
    const { beginOp } = payload || {};
    try {
      const saved = vccOpCalcSession.saveRun({
        beginOp,
        // operation identity 只取 Main TaskLifecycle owner；Renderer payload 无法注入或覆盖。
        operationOwner: taskContext.operationContext
      });
      appendActivityLogEntry({
        level: 'info',
        source: 'main',
        domain: 'vcc-op-calc',
        message: 'VCC 业务 OP 计算结果保存成功',
        details: [`Task Run：${taskContext.operationContext.taskRunId}`, `业务运行：${saved.runId}`]
      });
      return { status: 'success', ...saved };
    } catch (err) {
      if (isVccOpSaveRunRecoveryRequired(err)) {
        return interruptVccOpSaveRunTask({
          archiveService: archiveCenterService && archiveCenterService.service,
          operationOwner: taskContext.operationContext,
          error: err
        });
      }
      return { status: 'error', message: err && err.message ? err.message : String(err) };
    }
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

  const vccImportPlans = new Map();
  const vccImportPlanOwners = new WeakSet();
  const {
    publicImportPlan, resolveImportPlan, collectChannelCorrections, planError: vccPlanError
  } = require('./backend/vcc-financial-op/workbook-import-plan');
  ipcMain.handle('vccFinancialOp:import:pick-files', async (event, payload = {}) => {
    const owner = event.sender;
    const selectionToken = {};
    vccImportPlans.set(owner.id, selectionToken);
    if (!vccImportPlanOwners.has(owner)) {
      vccImportPlanOwners.add(owner);
      owner.once('destroyed', () => vccImportPlans.delete(owner.id));
    }
    const choice = await showImportOpenDialog('vcc-financial-op', {
      title: '选择 VCC 财务OP校验原表（可多选）',
      filters: [{ name: 'Excel', extensions: ['xlsx'] }],
      properties: ['openFile', 'multiSelections']
    });
    if (choice.canceled || !choice.filePaths || choice.filePaths.length === 0) {
      if (vccImportPlans.get(owner.id) === selectionToken) vccImportPlans.delete(owner.id);
      return { status: 'cancelled' };
    }
    try {
      const sourceStructures = await resolveVccSourceStructures(getTemplateResourceService());
      const targetMonth = payload && typeof payload.targetMonth === 'string' ? payload.targetMonth : null;
      const plan = await getVccFinancialOpService().inspectSelectedFiles(choice.filePaths, (progress) => {
        if (!owner.isDestroyed()) owner.send('vccFinancialOp:import:progress', progress);
      }, sourceStructures, targetMonth);
      if (owner.isDestroyed() || vccImportPlans.get(owner.id) !== selectionToken) throw vccPlanError('vcc-import-plan-stale', '文件选择已更新，请重新预检');
      vccImportPlans.set(owner.id, plan);
      return { status: 'success', plan: publicImportPlan(plan) };
    } catch (error) {
      return {
        status: 'error',
        code: error && error.code || 'vcc-import-failed',
        message: error && error.message ? error.message : String(error),
        detailLines: error && Array.isArray(error.detailLines) ? error.detailLines : []
      };
    }
  });

  trackedIpcHandle('vccFinancialOp:import:apply', 'VCC财务OP校验', '导入文件', {
    prepare: async (event, payload = {}) => {
      const plan = vccImportPlans.get(event.sender.id);
      const inspectedFiles = resolveImportPlan(plan, payload);
      await getVccFinancialOpService().validateImportPlan(plan, (progress) => {
        if (!event.sender.isDestroyed()) event.sender.send('vccFinancialOp:import:progress', progress);
      });
      if (event.sender.isDestroyed() || vccImportPlans.get(event.sender.id) !== plan) throw vccPlanError('vcc-import-plan-stale', '导入计划已更新');
      const fileDescriptors = Object.freeze(inspectedFiles.map((file) => {
        const { filePath: _filePath, ...descriptor } = file;
        return Object.freeze(descriptor);
      }));
      return {
        proceed: true,
        fileDescriptors,
        channelCorrections: collectChannelCorrections(inspectedFiles),
        filePlan: {
          version: 1,
          allocation: 'eager',
          inputs: inspectedFiles.map((file) => ({
            filePath: file.filePath,
            role: 'input',
            sourceOperation: 'vccFinancialOp:import:apply'
          })),
          outputs: []
        },
        beforeStart: async (batchContext, fileEvidence) => {
          const files = fileDescriptors.map((descriptor, index) => ({
            ...descriptor,
            filePath: fileEvidence.filePlan.inputs[index].filePath
          }));
          if (event.sender.isDestroyed() || vccImportPlans.get(event.sender.id) !== plan) throw vccPlanError('vcc-import-plan-stale', '导入计划已失效');
          const handoff = await prepareVccImportArchiveHandoff({ files }, batchContext);
          persistVccImportHandoffV2(vccImportArchiveRecoveryOptions().archiveRepository,
            batchContext, fileEvidence.filePlan.inputs, handoff);
          vccImportPlans.delete(event.sender.id);
          return { vccImportArchiveHandoffFiles: handoff };
        }
      };
    },
    execute: async (event, prepared, taskContext, payload = {}) => {
      let service = null;
      try {
        const batchContext = taskContext.batchContext;
        const files = prepared.fileDescriptors.map((descriptor, index) => ({
          ...descriptor,
          filePath: taskContext.fileEvidence.filePlan.inputs[index].filePath
        }));
        service = getVccFinancialOpService();
        const handoffFiles = taskContext.fileEvidence.vccImportArchiveHandoffFiles;
        const settled = await taskContext.settleArtifacts({
          files: taskContext.fileEvidence.filePlan.inputs.map((item, index) => ({
            artifactKey: item.artifactKey,
            expectedSha256: handoffFiles[index].expectedSha256,
            expectedSizeBytes: handoffFiles[index].expectedSizeBytes
          }))
        });
        if (!settled || settled.ok !== true || settled.durable !== true) {
          const error = new Error('VCC 导入输入文件未全部形成 ready 存档，业务未开始');
          error.code = 'VCC_IMPORT_ARCHIVE_HANDOFF_FAILED';
          throw error;
        }
        const frozenFiles = [];
        for (let index = 0; index < files.length; index += 1) {
          const artifactId = settled.results[index].artifact.id;
          const ready = await archiveCenterService.service.resolveVerifiedArtifact(artifactId);
          if (!ready?.ok) throw Object.assign(new Error(ready?.message || '无法读取已冻结原件'), { code: ready?.code });
          const metadata = handoffFiles[index].metadata;
          frozenFiles.push({ ...files[index], filePath: ready.filePath, archiveArtifactId: artifactId,
            members: metadata.vccSourceMembers });
        }
        const workerHandoffFiles = { version: 2, taskRunId: batchContext.taskRunId, files: frozenFiles };
        const businessPayload = {
          targetMonth: payload.targetMonth,
          files: frozenFiles,
          channelCorrections: prepared.channelCorrections || []
        };
        const result = await service.importSelectedFiles(businessPayload, (progress) => {
          if (event && event.sender && !event.sender.isDestroyed()) {
            event.sender.send('vccFinancialOp:import:progress', progress);
          }
        }, batchContext, workerHandoffFiles);
        const businessResult = { status: 'success', ...result };
        service.syncImportArchiveLineage();
        return businessResult;
      } catch (error) {
        const partial = error && error.partialResult && typeof error.partialResult === 'object'
          ? error.partialResult
          : {};
        const businessResult = {
          status: 'error',
          code: error && error.code || 'vcc-import-failed',
          message: error && error.message ? error.message : String(error),
          detailLines: error && Array.isArray(error.detailLines) ? error.detailLines : [],
          batchId: partial.batchId || null,
          targetMonth: partial.targetMonth || payload.targetMonth || null,
          partialCommitted: partial.partialCommitted === true,
          records: Array.isArray(partial.records) ? partial.records : []
        };
        if (service) {
          service.syncImportArchiveLineage();
        }
        return businessResult;
      }
    }
  });

  ipcMain.handle('vccFinancialOp:task:cancel', async () => {
    try {
      return await getVccFinancialOpService().cancelActiveTask(() => (
        archiveTaskLifecycle.cancelActive(
          (context) => context.moduleId === 'vcc-financial-op',
          '用户取消 VCC 财务OP任务'
        )
      ));
    } catch (error) {
      return { status: 'error', message: error && error.message ? error.message : String(error) };
    }
  });

  ipcMain.handle('vccFinancialOp:run:preflight', async (_event, payload = {}) => {
    try {
      return await getVccFinancialOpService().preflightRun(payload);
    } catch (error) {
      return { status: 'error', message: error && error.message ? error.message : String(error) };
    }
  });

  trackedIpcHandle('vccFinancialOp:run:calculate', 'VCC财务OP校验', '开始运行', {
    execute: async (_event, _prepared, taskContext, payload = {}) => {
      try {
        return await getVccFinancialOpService().calculate(
          payload,
          taskContext.operationContext
        );
      } catch (error) {
        return vccFinancialOpErrorResult(error);
      }
    }
  });

  trackedIpcHandle('vccFinancialOp:opening:initialize', 'VCC财务OP校验', '初始化期初财务OP', {
    execute: async (_event, _prepared, taskContext, payload = {}) => {
      try {
        return await getVccFinancialOpService().initializeOpening(
          payload,
          taskContext.operationContext
        );
      } catch (error) {
        return vccFinancialOpErrorResult(error);
      }
    }
  });

  trackedIpcHandle('vccFinancialOp:run:archive', 'VCC财务OP校验', '确认归档', {
    execute: async (event, _prepared, taskContext, payload = {}) => {
      try {
        return await getVccFinancialOpService().archive(payload, (progress) => {
          if (event && event.sender && !event.sender.isDestroyed()) {
            event.sender.send('vccFinancialOp:operation:progress', progress);
          }
        }, taskContext.operationContext);
      } catch (error) {
        return vccFinancialOpErrorResult(error);
      }
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

  trackedIpcHandle('vccFinancialOp:run:adjustment-add', 'VCC财务OP校验', '修改结果', {
    execute: async (event, _prepared, taskContext, payload = {}) => {
      try {
        const result = await getVccFinancialOpService().addRunAdjustment(payload, (progress) => {
          if (event && event.sender && !event.sender.isDestroyed()) {
            event.sender.send('vccFinancialOp:operation:progress', progress);
          }
        }, taskContext.operationContext);
        return { ...result, operationStatus: result.status, status: 'success' };
      } catch (error) {
        return vccFinancialOpErrorResult(error);
      }
    }
  });

  ipcMain.handle('vccFinancialOp:run:archived-months', async () => {
    try {
      return {
        status: 'success',
        months: await getVccFinancialOpService().listArchivedResultMonths()
      };
    } catch (error) {
      return vccFinancialOpErrorResult(error);
    }
  });

  ipcMain.handle('vccFinancialOp:run:unarchive-preview', async (_event, payload = {}) => {
    try {
      return {
        status: 'success',
        ...await getVccFinancialOpService().previewUnarchive(payload)
      };
    } catch (error) {
      return vccFinancialOpErrorResult(error);
    }
  });

  trackedIpcHandle('vccFinancialOp:run:unarchive', 'VCC财务OP校验', '解归档', {
    prepare: async (_event, payload = {}) => {
      try {
        const preview = await getVccFinancialOpService().previewUnarchive(payload);
        return { proceed: true, runId: preview.runId };
      } catch (error) {
        return { proceed: false, result: vccFinancialOpErrorResult(error) };
      }
    },
    execute: async (event, prepared, taskContext, payload = {}) => {
      try {
        const result = await getVccFinancialOpService().unarchiveMonth(payload, (progress) => {
          if (event && event.sender && !event.sender.isDestroyed()) {
            event.sender.send('vccFinancialOp:operation:progress', progress);
          }
        }, taskContext.operationContext);
        return { ...result, runId: result.runId || prepared.runId, operationStatus: result.status, status: 'success' };
      } catch (error) {
        return vccFinancialOpErrorResult(error);
      }
    }
  });

  ipcMain.handle('vccFinancialOp:imports:list-months', async () => {
    return await getVccFinancialOpService().listImportMonths();
  });

  ipcMain.handle('vccFinancialOp:imports:list-records', async (_event, payload = {}) => {
    return await getVccFinancialOpService().listImportRecords(payload.yearMonth);
  });

  ipcMain.handle('vccFinancialOp:data-manager:overview', (_event, payload = {}) => {
    try {
      return { status: 'success', ...getVccFinancialOpService().dataManagerOverview(payload.yearMonth) };
    } catch (error) {
      return { status: 'error', message: error && error.message ? error.message : String(error) };
    }
  });

  ipcMain.handle('vccFinancialOp:data-manager:delete-targets', async (_event, payload = {}) => {
    try {
      return {
        status: 'success',
        targets: await getVccFinancialOpService().listDeleteTargets(payload)
      };
    } catch (error) {
      return vccFinancialOpErrorResult(error);
    }
  });

  ipcMain.handle('vccFinancialOp:data-manager:delete-preview', async (_event, payload = {}) => {
    try {
      return {
        status: 'success',
        ...await getVccFinancialOpService().previewDataTargetDeletion(payload)
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
    {
      prepare: async (_event, payload = {}) => {
        try {
          const preview = await getVccFinancialOpService().previewDataTargetDeletion(payload);
          return {
            proceed: true,
            targetType: preview.targetType,
            runIds: Array.isArray(preview.runIds) ? preview.runIds.slice() : []
          };
        } catch (error) {
          return { proceed: false, result: vccFinancialOpErrorResult(error) };
        }
      },
      execute: async (event, _prepared, taskContext, payload = {}) => {
        try {
          const service = getVccFinancialOpService();
          const result = await service.deleteDataTarget(payload, (progress) => {
            if (event && event.sender && !event.sender.isDestroyed()) {
              event.sender.send('vccFinancialOp:operation:progress', progress);
            }
          }, taskContext.operationContext);
          service.syncImportArchiveLineage();
          return {
            ...result,
            targetType: result.targetType || payload.targetType || payload.sourceType,
            operationStatus: result.status || 'deleted',
            status: 'success'
          };
        } catch (error) {
          return vccFinancialOpErrorResult(error);
        }
      }
    }
  );

  ipcMain.handle('vccFinancialOp:data-manager:export-preview', async (_event, payload = {}) => {
    try {
      return {
        status: 'success',
        ...await getVccFinancialOpService().previewDatasetExport(payload)
      };
    } catch (error) {
      return { status: 'error', message: error && error.message ? error.message : String(error) };
    }
  });

  trackedIpcHandle('vccFinancialOp:data-manager:export', 'VCC财务OP校验', '导出数据', {
    prepare: async (_event, payload = {}) => {
      try {
        const inspection = await getVccFinancialOpService().previewDatasetExport(payload);
        if (!inspection.exportable) {
          return {
            proceed: false,
            result: { status: 'error', message: inspection.message || '当前选择没有可导出的有效数据' }
          };
        }
        if (inspection.incomplete) {
          const confirmation = await dialog.showMessageBox(mainWindow, {
            type: 'warning',
            title: '导出不完整校验原表',
            message: '历史数据存在原表血缘缺口，本次只能导出已覆盖数据和缺口说明。',
            detail: [
              `有效总行数：${inspection.totalRows}`,
              `可导出行数：${inspection.exportableRows}`,
              `缺失行数：${inspection.missingRows}`,
              '导出文件将包含“导出说明”sheet，并在文件名中标记“不完整”。'
            ].join('\n'),
            buttons: ['继续不完整导出', '取消'],
            defaultId: 1,
            cancelId: 1,
            noLink: true
          });
          if (confirmation.response !== 0) {
            return { proceed: false, result: { status: 'cancelled' } };
          }
        }
        const choice = await dialog.showSaveDialog(mainWindow, {
          title: '导出 VCC 财务OP数据',
          defaultPath: path.join(
            app.getPath('documents'),
            `${inspection.targetMonth}_${sanitizeFileName(inspection.tableName) || 'VCC财务OP数据'}${inspection.incomplete ? ' 不完整' : ''}.xlsx`
          ),
          filters: [{ name: 'Excel', extensions: ['xlsx'] }]
        });
        if (choice.canceled || !choice.filePath) {
          return { proceed: false, result: { status: 'cancelled' } };
        }
        let outputPath = choice.filePath;
        if (inspection.incomplete && !path.basename(outputPath, path.extname(outputPath)).includes('不完整')) {
          const extension = path.extname(outputPath) || '.xlsx';
          outputPath = path.join(
            path.dirname(outputPath),
            `${path.basename(outputPath, path.extname(outputPath))} 不完整${extension}`
          );
        }
        const useManagedExport = backgroundExecutionRuntimeManager.isProductionEnabled(
          VCC_FINANCIAL_OP_READ_ONLY_ACTION
        );
        const stableSnapshot = useManagedExport
          ? await freezeVccFinancialOpReadOnlyExportSource(
              getVccFinancialOpService(),
              'dataset',
              payload
            )
          : null;
        const prepared = {
          proceed: true,
          expectedInspection: inspection,
          taskGeneration: inspection.taskGeneration,
          useManagedExport,
          vccReadOnlyExportContext: stableSnapshot && stableSnapshot.context,
          stableRunEvidence: stableSnapshot && stableSnapshot.evidence,
          vccOutputPublicationTaskIds: [],
          filePlan: {
            version: 1,
            allocation: 'eager',
            inputs: [],
            outputs: [{
              filePath: outputPath,
              role: 'output',
              sourceOperation: 'vccFinancialOp:data-manager:export'
            }]
          },
          async beforeStart() {
            if (useManagedExport) {
              await assertVccFinancialOpEvidenceFresh(
                getVccFinancialOpService(),
                stableSnapshot.evidence,
                stableSnapshot.context
              );
            }
          }
        };
        return prepared;
      } catch (error) {
        return {
          proceed: false,
          result: { status: 'error', message: error && error.message ? error.message : String(error) }
        };
      }
    },
    execute: async (_event, prepared, taskContext, payload = {}) => {
      if (prepared.useManagedExport) {
        try {
          return await executeManagedVccFinancialOpReadOnlyExport(
            getVccFinancialOpService(),
            prepared,
            taskContext
          );
        } catch (error) {
          return { status: 'error', message: error && error.message ? error.message : String(error) };
        }
      }
      const batchContext = taskContext.batchContext;
      const outputPath = taskContext.fileEvidence.filePlan.outputs[0].filePath;
      const publicationStagingDirectory = createVccOutputStagingDirectory(batchContext);
      try {
        const result = await getVccFinancialOpService().exportDatasetData({
          ...payload,
          outputPath,
          generationOutputPath: path.join(publicationStagingDirectory, 'dataset.xlsx'),
          expectedInspection: prepared.expectedInspection,
          taskGeneration: prepared.taskGeneration,
          targetSnapshots: taskContext.fileEvidence.targetSnapshots,
          onDurableHandoff: (publication, _exportResult, evidence) => (
            settleVccOutputPublication(prepared, taskContext, publication, evidence)
          )
        }, undefined, batchContext);
        return { status: 'success', ...result };
      } catch (error) {
        return { status: 'error', message: error && error.message ? error.message : String(error) };
      } finally {
        if (!fs.existsSync(publicationStagingDirectory)
            || !fs.readdirSync(publicationStagingDirectory).length) {
          cleanupVccOutputStagingDirectory(publicationStagingDirectory);
        }
      }
    }
  });

  ipcMain.handle('vccFinancialOp:run:get', async (_event, payload = {}) => {
    try {
      const result = await getVccFinancialOpService().getRunResult(payload.runId);
      return result
        ? { ...result, runStatus: result.status, status: 'success' }
        : { status: 'error', message: '校验结果不存在' };
    } catch (error) {
      return { status: 'error', message: error && error.message ? error.message : String(error) };
    }
  });

  ipcMain.handle('vccFinancialOp:run:latest-archived', async () => {
    try {
      const result = await getVccFinancialOpService().latestArchivedRun();
      return result
        ? { ...result, runStatus: result.status, status: 'success' }
        : { status: 'empty' };
    } catch (error) {
      return { status: 'error', message: error && error.message ? error.message : String(error) };
    }
  });

  supportIpcHandle('vccFinancialOp:export:review', '导出 VCC 待确认表',
    require('./main-process/vcc-financial-op-review-ipc').createReviewExportHandler({
      getService: () => vccFinancialOpService,
      dialog,
      getWindow: () => mainWindow,
      documentsPath: app.getPath('documents'),
      tempRoot: path.join(app.getPath('userData'), 'run-data', 'vcc-financial-op', 'review-export'),
      protectedRoots: [app.getPath('userData'), app.getAppPath(), process.resourcesPath,
        path.dirname(database.dbPath)]
    }));

  trackedIpcHandle('vccFinancialOp:export:result', 'VCC财务OP校验', '导出校验结果表',
    createResultExportHandlers({
      getService: getVccFinancialOpService,
      dialog,
      getWindow: () => mainWindow,
      documentsPath: app.getPath('documents'),
      createStagingDirectory: createVccOutputStagingDirectory,
      cleanupStagingDirectory: cleanupVccOutputStagingDirectory,
      settlePublication: settleVccOutputPublication
    }));

  trackedIpcHandle('vccFinancialOp:export:import-audit', 'VCC财务OP校验', '导出导入审计', {
    prepare: async (_event, payload = {}) => {
      try {
        const choice = await dialog.showSaveDialog(mainWindow, {
          title: '导出 VCC 异常明细',
          defaultPath: path.join(
            app.getPath('documents'),
            `VCC财务OP异常明细_${payload.recordId || ''}.xlsx`
          ),
          filters: [{ name: 'Excel', extensions: ['xlsx'] }]
        });
        if (choice.canceled || !choice.filePath) {
          return { proceed: false, result: { status: 'cancelled' } };
        }
        const useManagedExport = backgroundExecutionRuntimeManager.isProductionEnabled(
          VCC_FINANCIAL_OP_READ_ONLY_ACTION
        );
        const stableSnapshot = useManagedExport
          ? freezeVccImportAuditSourceSnapshot({
              db: database.db,
              recordId: Number(payload.recordId)
            })
          : null;
        const prepared = {
          proceed: true,
          useManagedExport,
          vccReadOnlyExportContext: stableSnapshot && stableSnapshot.context,
          stableRunEvidence: stableSnapshot && stableSnapshot.evidence,
          vccOutputPublicationTaskIds: [],
          filePlan: {
            version: 1,
            allocation: 'eager',
            inputs: [],
            outputs: [{
              filePath: choice.filePath,
              role: 'output',
              sourceOperation: 'vccFinancialOp:export:import-audit'
            }]
          },
          beforeStart() {
            if (useManagedExport) {
              return assertVccFinancialOpEvidenceFresh(
                getVccFinancialOpService(),
                stableSnapshot.evidence,
                stableSnapshot.context
              );
            }
            return undefined;
          }
        };
        return prepared;
      } catch (error) {
        return {
          proceed: false,
          result: { status: 'error', message: error && error.message ? error.message : String(error) }
        };
      }
    },
    execute: async (_event, prepared, taskContext, payload = {}) => {
      if (prepared.useManagedExport) {
        try {
          return await executeManagedVccFinancialOpReadOnlyExport(
            getVccFinancialOpService(),
            prepared,
            taskContext
          );
        } catch (error) {
          return { status: 'error', message: error && error.message ? error.message : String(error) };
        }
      }
      const batchContext = taskContext.batchContext;
      const outputPath = taskContext.fileEvidence.filePlan.outputs[0].filePath;
      const publicationStagingDirectory = createVccOutputStagingDirectory(batchContext);
      try {
        const result = await getVccFinancialOpService().exportImportAudit({
          ...payload,
          outputPath,
          generationOutputPath: path.join(publicationStagingDirectory, 'import-anomalies.xlsx'),
          targetSnapshots: taskContext.fileEvidence.targetSnapshots,
          onDurableHandoff: (publication, _exportResult, evidence) => (
            settleVccOutputPublication(prepared, taskContext, publication, evidence)
          )
        }, batchContext);
        return { status: 'success', ...result };
      } catch (error) {
        return { status: 'error', message: error && error.message ? error.message : String(error) };
      } finally {
        if (!fs.existsSync(publicationStagingDirectory)
            || !fs.readdirSync(publicationStagingDirectory).length) {
          cleanupVccOutputStagingDirectory(publicationStagingDirectory);
        }
      }
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
  //   signatures：本次导入按模板文件当前版本解析后的签名（resolveImportSignatures），缺省为内置签名。
  function getLinkedSignatureByKey(detectorTableKey, signatures = LINKED_IMPORT_SIGNATURES) {
    return signatures.find((s) => s.tableKey === detectorTableKey) || null;
  }

  // 设置 → 模板文件：网关对账单 / 中台调拨订单 / 中台退款订单 / 外汇交割表的签名随当前版本（每次导入解析一次）。
  function resolveImportSignatures(signatures) {
    return resolveLinkedSignatures(signatures, (resourceId) => getTemplateResourceService().currentInputStructure(resourceId));
  }

  // 未识别或指纹相近但不是当前版本表头：带与最接近候选结构的差异明细（含导入新版本的指引）。
  function unrecognizedLinkedResult(fileName, detected, signatures, fallbackMessage) {
    const signature = detected.status === 'structure-mismatch'
      ? signatures.find((item) => item.tableKey === detected.tableKey)
      : null;
    const message = signature
      ? `表头与「${signature.label}」${signature.versionLabel ? `当前版本 ${signature.versionLabel}` : '当前结构'}不一致`
      : fallbackMessage;
    return { fileName, status: 'unrecognized', message, detailLines: linkedStructureMismatchLines(detected, signatures) };
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
  async function importLinkedFileToRepo({
    filePath,
    fileName,
    detected,
    repoKey,
    signature,
    sourceIdentity
  }) {
    // 🔴 v2.1.16-beta.3 ②：裁列必须在 44 列校验之后。readLinkedRowsAsObjects 内部走
    //   detector L1/L2 + expectedHeaders zip 校验，异构文件读不出 44 列对象（前面 detector 已拦截）。
    //   入金表（bank-deposit）：按 13 字段名 pick 裁列（pickBankDepositFields，非索引切片）；
    //   其余链接表不裁列。raw_json 天然只存裁后字段。
    // 设置 → 模板文件启用了用户版本时，按当前版本读出的行先对应回内置列名（见 linked-structure-signatures）。
    const transform = repoKey === 'bank-deposit'
      ? (row) => pickBankDepositFields(projectLinkedRow(signature, row))
      : (row) => projectLinkedRow(signature, row);
    const isGatewayBill = repoKey === 'gateway-bill';
    const isBankDeposit = repoKey === 'bank-deposit';
    const isMidAllocation = repoKey === 'mid-allocation';
    const isFxSettlement = repoKey === 'fx-settlement';
    // E11-B：bank/mid 都是全局 ADM image 的 source。先于任何 source write 检查
    // 同一 durable Hold/open Intent scope；ADM replace 前还会在同步写边界复检。
    if (isBankDeposit || isMidAllocation) assertReconFixJpmAdmMutationAllowed();
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
        ret = await database.upsertLinkedGatewayBillStreaming(feedRows, {
          sourceFileName: fileName,
          sourceIdentity
        });
      } else if (isBankDeposit) {
        ret = await database.upsertLinkedBankDepositStreaming(feedRows, { sourceFileName: fileName });
      } else {
        ret = await database.replaceLinkedTableStreaming(repoKey, feedRows, { sourceFileName: fileName });
      }
    } else {
      // 数组路径：fx-settlement 用 WithMeta 同时取物理行号（BOC 分组扫描热依赖）；其余表零行为变化。
      const meta = readLinkedRowsAsObjectsWithMeta(filePath, signature, detected.sheetName);
      // 一行对应一行，物理行号 rowNumbers 与之对齐不变（BOC 分组依赖行号断档）。
      const rows = meta.objects.map((row) => projectLinkedRow(signature, row));
      if (repoKey === 'fx-settlement') {
        fxObjects = rows;
        fxRowNumbers = meta.rowNumbers;
      }
      const rowsToWrite = repoKey === 'bank-deposit'
        ? rows.map((r) => pickBankDepositFields(r))
        : rows;
      if (isGatewayBill) {
        ret = database.upsertLinkedGatewayBill(rowsToWrite, {
          sourceFileName: fileName,
          sourceIdentity
        });
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
      const { admDerive } = rebuildAdmDerivation({
        database,
        buildAdmRows,
        admMutationBoundary: runReconFixJpmAdmMutationBoundary
      });
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
  //   v3.2.18：白名单、统计与删除联动抽到 src/main-process/linked-table-delete.js（与链接表过期清理共用）。

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
    if (!isLinkedDeleteTable(tableKey)) {
      return { status: 'failed', message: '不支持的删除目标表' };
    }
    try {
      const count = countLinkedTableRowsByDateRange(database, { tableKey, start, end });
      return { status: 'ok', count };
    } catch (err) {
      return { status: 'failed', message: err && err.message ? err.message : String(err) };
    }
  });

  // v3.0.1 需求1（D4）🔴 资金红线：按数据日期范围删除链接表行（不可逆，闭区间，直接删）。
  //   mutating → trackedIpcHandle 记活动日志；入参校验（起止非空 + 起≤止）；返回删除行数 + 重算后 meta。
  //   v3.0.5 OPEN-4（T6b-2）🔴🔴 资金红线：三表化 —— tableKey 正向白名单路由（缺省 gateway-bill 向后兼容）+ 删除派生联动
  //     （gateway 清 processingResult；fx 联动删 BOC + 重匹配 + 清 reconIdFixResult；bank-deposit ADM gate + ADM/BOC bank 重建
  //      + 清两类缓存与命中标记）。v3.2.18 起联动实现见 src/main-process/linked-table-delete.js，返回结构不变。
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
    if (!isLinkedDeleteTable(tableKey)) {
      return { status: 'failed', message: '不支持的删除目标表' };
    }
    try {
      const result = deleteLinkedTableRowsByDateRange(linkedTableDeleteDeps(), { tableKey, start, end });
      return { status: 'ok', ...result };
    } catch (err) {
      return { status: 'failed', message: err && err.message ? err.message : String(err) };
    }
    } finally {
      // v3.0.11 codex-P2 补强：删表结束统一释放互斥锁（含各早返回 / ok / 异常路径）。
      releaseBankStatementOpLock();
    }
  });

  // v3.2.18 链接表保留期限（设置 → 数据管理）：读取三张累加表当前生效期限（含内置默认）。只读，普通 handle。
  ipcMain.handle('linked-table:get-retention-settings', () => {
    if (!database || !database.db) return { status: 'failed', message: '数据库未初始化' };
    try {
      return {
        status: 'ok',
        tables: listPublicRetentionTables(),
        retentionDaysByTable: readLinkedRetentionDaysByTable(database)
      };
    } catch (err) {
      return { status: 'failed', message: err && err.message ? err.message : String(err) };
    }
  });

  // v3.2.18：保存单张链接表的保留期限（15/30/60/90/180/365 天或 null=永久）。只写设置，不立即删除；
  //   保存后清空上次成功清理时间，新期限在下一次空闲清理时生效。
  ipcMain.handle('linked-table:set-retention-days', (_event, payload) => {
    if (!database || !database.db) return { status: 'failed', message: '数据库未初始化' };
    try {
      const retentionDaysByTable = setLinkedTableRetentionDays(database, payload);
      return { status: 'ok', retentionDaysByTable };
    } catch (err) {
      return { status: 'failed', message: err && err.message ? err.message : String(err) };
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
      return {
        proceed: true,
        filePlan: {
          version: 1,
          allocation: 'eager',
          inputs: res.filePaths.map((filePath) => ({
            filePath,
            role: 'input',
            sourceOperation: 'linked-table:import'
          })),
          outputs: []
        }
      };
    },
    async execute(_event, _prepared, taskContext) {
    // v3.0.11 codex-P2 补强（🔴 资金红线）：纳入 bankStatementOperationLock —— 链接表是 bank-statement run（R1-R5）输入，
    //   run 全程持锁；本导入若在 run 数据准备让出窗口内并发执行会撕裂快照。争用即返回失败，finally 释放。
    const opLock = tryAcquireBankStatementOpLock('linked-import');
    if (!opLock.acquired) return { status: 'failed', message: opLock.message };
    try {
    const results = [];
    // 银行对账单入金表（D17）：启用了导入识别结构用户版本时，内置签名之外追加当前版本签名。
    const linkedSignatures = withBankStatementStructure(await resolveImportSignatures(LINKED_IMPORT_SIGNATURES),
      await resolveBankStatementStructure(getTemplateResourceService()));
    for (const filePath of taskContext.fileEvidence.filePlan.inputs.map((item) => item.filePath)) {
      const fileName = path.basename(filePath);
      // 识别：链接表导入候选集（4 张 linked 签名 + 入金表签名；detector 默认含全部，这里收窄）。
      //   v2.1.16-beta.3 ②：入金表与主表同构 44 列，但主表签名不在此集合 → 入金表唯一命中、不 ambiguous。
      let detected;
      try {
        detected = await detectTableType(filePath, linkedSignatures);
      } catch (err) {
        results.push({ fileName, status: 'read-error', message: err && err.message ? err.message : String(err) });
        continue;
      }

      if (detected.status === 'ambiguous') {
        results.push({ fileName, status: 'ambiguous', message: '表头同时命中多张链接表，无法唯一判定' });
        continue;
      }
      if (detected.status === 'unrecognized' || detected.status === 'structure-mismatch') {
        results.push(unrecognizedLinkedResult(fileName, detected, linkedSignatures, '未识别为任何链接表'));
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
      // 只由当前版本签名命中（入金表按新结构导出）时按该签名读取并对应回内置列。
      const signature = (detected.matchedVersion && versionSignatureOf(linkedSignatures, detectorKey))
        || getLinkedSignatureByKey(detectorKey, linkedSignatures);
      if (detectorKey === 'fx-option' || !repoKey || !signature) {
        results.push({
          fileName,
          tableKey: detectorKey,
          status: 'unsupported',
          message: '外汇期权表已入库，待阶段二接入'
        });
        continue;
      }

      if (signature.structureUnavailable) {
        results.push({ fileName, tableKey: repoKey, status: 'read-error', message: signature.structureUnavailable });
        continue;
      }
      // 读行 → 对象数组 → 落库 + 派生（v3.0.7 需求2d：整段抽至 importLinkedFileToRepo 共享函数，
      //   供「链接表管理」与「导入文件」通用导入零复制复用；落库/派生/缓存清理口径字节级 parity）。
      try {
        const okResult = await importLinkedFileToRepo({
          filePath,
          fileName,
          detected,
          repoKey,
          signature,
          sourceIdentity: repoKey === 'gateway-bill' ? {
            datasetId: randomUUID(),
            producerTaskRunId: taskContext.batchContext.taskRunId,
            sourceContractVersion: 1
          } : undefined
        });
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
        details: failedResults.flatMap((r) => [
          `${r.fileName}｜${r.status}｜${r.message || ''}`,
          ...(Array.isArray(r.detailLines) ? r.detailLines : [])
        ])
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
      return {
        proceed: true,
        filePlan: {
          version: 1,
          allocation: 'eager',
          inputs: choice.filePaths.map((filePath) => ({
            filePath,
            role: 'input',
            sourceOperation: 'bank-statement:batch-import'
          })),
          outputs: []
        }
      };
    },
    async execute(event, _prepared, taskContext) {
    // v3.0.11 需求3（批1 · 🔴 资金红线）：统一互斥锁（与 run/export 共享一把）。争用即返回失败，绝不并发撕裂会话态。
    const opLock = tryAcquireBankStatementOpLock('import');
    if (!opLock.acquired) {
      return { status: 'failed', message: opLock.message };
    }
    // v3.0.11 需求3（批1 · 导入让出+进度）：内联进度转发器（100ms 节流
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
    const filePaths = taskContext.fileEvidence.filePlan.inputs.map((item) => item.filePath);
    const fileCount = filePaths.length;
    const bankStructure = await resolveBankStatementStructure(getTemplateResourceService());
    const batchSignatures = withBankStatementStructure(await resolveImportSignatures(ALL_TABLE_SIGNATURES), bankStructure);
    // 银行对账单按当前版本读取时，入金表二次分流用同一结构的入金表签名。
    const bankDepositVersionSignature = versionSignatureOf(withBankStatementStructure([BANK_DEPOSIT_SIGNATURE], bankStructure), 'bank-deposit');
    // 本批是否已建立/合并过银行对账单 session（用于：① 第一个建 vs 后续合并的分支；
    //   ② processingResult / gatewayReconSession 整批只清一次）。
    let bankStatementMerged = false;
    // v2.1.16-beta.6 PR#65 Finding1：本批是否已导退款订单 —— 避免同批「退款订单先于银行对账单处理」时
    //   被银行对账单分支的「清旧退款」误清掉本批刚导入的退款 session（filePaths 顺序不可控）。
    let refundImportedThisBatch = false;

    for (let fileIndex = 0; fileIndex < filePaths.length; fileIndex++) {
      const filePath = filePaths[fileIndex];
      const fileName = path.basename(filePath);
      // v3.0.11 需求3（批1 · 导入让出+进度）：每文件开始前让出事件循环（消除大批量导入期窗口「未响应」）+ 上报进度。
      //   yield 放循环体顶部 = 在「上一文件处理完、本文件重活前」让出，等价于「每文件处理完让出」（规避循环内多处 continue）。
      //   单文件内 readBankStatement（同步 XLSX.readFile）本批不改（单个预处理对账单行数有限，留观察）。
      if (typeof onImportProgress === 'function') onImportProgress({ stage: 'reading', fileIndex, fileCount, filePath });
      await new Promise((r) => setImmediate(r));

      // 识别：v3.0.7 需求2d 通用导入候选集 ALL_TABLE_SIGNATURES（预处理 3 张 + 链接 4 张；🔴 不含 bank-deposit）。
      let detected;
      try {
        detected = await detectTableType(filePath, batchSignatures);
      } catch (err) {
        results.push({ fileName, status: 'read-error', message: err && err.message ? err.message : String(err) });
        continue;
      }

      if (detected.status === 'ambiguous') {
        results.push({ fileName, status: 'ambiguous', message: '表头同时命中多张表，无法唯一判定' });
        continue;
      }
      if (detected.status === 'unrecognized' || detected.status === 'structure-mismatch') {
        results.push(unrecognizedLinkedResult(fileName, detected, batchSignatures,
          '未识别为任何可导入的表（银行对账单 / 中台退款订单 / 入账原始订单 / 链接表）'));
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
          const result = readBankStatement(filePath, { sourceHeaders: bankStatementSourceHeaders(bankStructure) });

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
                signature: result.structure === 'current' && bankDepositVersionSignature
                  ? bankDepositVersionSignature : BANK_DEPOSIT_SIGNATURE
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
          const refundSignature = batchSignatures.find((s) => s.tableKey === 'zhongtai-refund-order');
          if (refundSignature.structureUnavailable) throw new Error(refundSignature.structureUnavailable);
          // 按当前版本读出后对应回内置列名（退款回填按内置列名读取）。
          const refundRows = readLinkedRowsAsObjects(filePath, refundSignature, detected.sheetName)
            .map((row) => projectLinkedRow(refundSignature, row));
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
      const linkedSignature = getLinkedSignatureByKey(tableKey, batchSignatures);
      if (linkedRepoKey && linkedSignature && tableKey !== 'fx-option') {
        // 设置 → 模板文件当前版本不可用（缺失、被修改、不兼容）：该表导入中止，不按内置结构入库。
        if (linkedSignature.structureUnavailable) {
          results.push({ fileName, tableKey: linkedRepoKey, status: 'read-error', message: linkedSignature.structureUnavailable });
          continue;
        }
        // 落库 ≠ 跳过：mid-allocation / gateway-bill / fx-settlement 落库即写对应链接表（+ 派生），
        //   bank-statement:run 阶段自动读回喂 R1-R5（gateway-bill→R1/C3/R5、mid-allocation→R5s2/DBS）。
        //   独立 try/catch：落库异常记 write-error（与 linked-table:import 错误契约一致）。
        try {
          const okResult = await importLinkedFileToRepo({
            filePath,
            fileName,
            detected,
            repoKey: linkedRepoKey,
            signature: linkedSignature,
            sourceIdentity: linkedRepoKey === 'gateway-bill' ? {
              datasetId: randomUUID(),
              producerTaskRunId: taskContext.batchContext.taskRunId,
              sourceContractVersion: 1
            } : undefined
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
}

function getPreFundReconciliationService() {
  if (!database || !database.db) {
    throw new Error('数据库尚未初始化，请稍后重试');
  }
  if (!preFundReconciliationService) {
    preFundReconciliationService = createPreFundReconciliationService({
      userDataDir: path.dirname(database.dbPath),
      database,
      templatePath: path.join(__dirname, '..', 'assets', '资金对账导出不平.xlsx'),
      templateSource: getTemplateResourceService().source('prefund-unbalanced', 'pre-fund-reconciliation')
    });
  }
  return preFundReconciliationService;
}

function schedulePreFundReconciliationStartupCleanup() {
  setImmediate(observeBackgroundMemoryActivity(() => {
    try {
      getPreFundReconciliationService().reconcilePersistedRunMirrors();
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
  }));
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
      const filePath = choice.filePaths[0];
      return {
        proceed: true,
        filePlan: {
          version: 1,
          allocation: 'eager',
          inputs: [{
            filePath,
            role: 'input',
            sourceOperation: 'pre-fund-reconciliation:import-bank'
          }],
          outputs: []
        }
      };
    },
    async execute(_event, _prepared, taskContext) {
    const lock = tryAcquireBankStatementOpLock('pre-fund-import-bank');
    if (!lock.acquired) return { status: 'busy', message: lock.message };
    try {
      const imported = getPreFundReconciliationService().importBank(
        taskContext.fileEvidence.filePlan.inputs[0].filePath,
        taskContext.batchContext.taskRunId,
        { sourceHeaders: bankStatementSourceHeaders(await resolveBankStatementStructure(getTemplateResourceService())) }
      );
      return imported;
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
      const holdEvidence = await preFundMptHoldGate.inspectFiles(choice.filePaths);
      return {
        proceed: true,
        recoveryConflictScopeKeys: holdEvidence.conflictScopeKeys,
        preparedMptIdentities: holdEvidence.identities,
        async beforeStart() {
          await preFundMptHoldGate.inspectFiles(choice.filePaths);
          return null;
        },
        filePlan: {
          version: 1,
          allocation: 'eager',
          inputs: choice.filePaths.map((filePath) => ({
            filePath,
            role: 'input',
            sourceOperation: 'pre-fund-reconciliation:import-mpt'
          })),
          outputs: []
        }
      };
    },
    async execute(event, _prepared, taskContext) {
    const lock = tryAcquireBankStatementOpLock('pre-fund-import-mpt');
    if (!lock.acquired) return { status: 'busy', message: lock.message };
    try {
      const service = getPreFundReconciliationService();
      const filePaths = taskContext.fileEvidence.filePlan.inputs.map((item) => item.filePath);
      const progress = (value) => sendPreFundProgress(
        event,
        'pre-fund-reconciliation:import-progress',
        value
      );
      if (!backgroundExecutionRuntimeManager.isProductionEnabled('pre-fund:mpt-import')) {
        const imported = await getPreFundReconciliationService().importMptFiles(
          filePaths,
          {
            producerTaskRunId: taskContext.batchContext.taskRunId,
            identityGate: (identity) => preFundMptHoldGate.assertIdentities([identity]),
            onProgress: progress
          }
        );
        return imported;
      }
      const imported = await executeManagedPreFundMptImport({
        actionKey: 'pre-fund:mpt-import',
        runtime: backgroundExecutionRuntimeManager.get(),
        service,
        filePaths,
        userDataDir: app.getPath('userData'),
        taskStagingDir: path.join(
          app.getPath('userData'),
          'background-execution-staging',
          taskContext.batchContext.taskRunId
        ),
        batchContext: taskContext.batchContext,
        production: true,
        onProgress: progress
      });
      return imported;
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
        repairTokens: Array.isArray(repairTokens) ? repairTokens.slice() : [],
        filePlan: {
          version: 1,
          allocation: 'eager',
          inputs: [],
          outputs: [{
            filePath: choice.filePath,
            role: 'output',
            sourceOperation: 'pre-fund-reconciliation:mpt-errors:export'
          }]
        }
      };
    },
    async execute(_event, prepared, taskContext) {
    const lock = tryAcquireBankStatementOpLock('pre-fund-export-mpt-errors');
    if (!lock.acquired) return { status: 'busy', message: lock.message };
    try {
      const exported = await getPreFundReconciliationService().exportMptErrorData(
        prepared.repairTokens,
        taskContext.fileEvidence.filePlan.outputs[0].filePath
      );
      await taskContext.settleArtifacts({
        files: taskContext.fileEvidence.filePlan.outputs
          .map((item) => ({ artifactKey: item.artifactKey }))
      });
      return exported;
    } catch (error) {
      return preFundFailureResult(error);
    } finally {
      releaseBankStatementOpLock();
    }
    }
  });

  trackedIpcHandle('pre-fund-reconciliation:mpt-errors:repair', '前置资金对账', '删除临时网关错误数据并重跑', {
    async prepare(_event, repairTokens = []) {
      const tokens = Array.isArray(repairTokens) ? repairTokens.slice() : [];
      const failures = getPreFundReconciliationService().resolveMptImportFailures(tokens);
      const holdEvidence = await preFundMptHoldGate.inspectFiles(
        failures.map((failure) => failure.filePath),
        failures
      );
      return {
        proceed: true,
        repairTokens: tokens,
        recoveryConflictScopeKeys: holdEvidence.conflictScopeKeys,
        preparedMptIdentities: holdEvidence.identities,
        async beforeStart() {
          await preFundMptHoldGate.inspectFiles(
            failures.map((failure) => failure.filePath),
            failures
          );
          return null;
        },
        filePlan: {
          version: 1,
          allocation: 'eager',
          inputs: failures.map((failure) => ({
            filePath: failure.filePath,
            role: 'input',
            sourceOperation: 'pre-fund-reconciliation:mpt-errors:repair'
          })),
          outputs: []
        }
      };
    },
    async execute(event, prepared, taskContext) {
    const lock = tryAcquireBankStatementOpLock('pre-fund-repair-mpt-errors');
    if (!lock.acquired) return { status: 'busy', message: lock.message };
    try {
      const service = getPreFundReconciliationService();
      const filePaths = taskContext.fileEvidence.filePlan.inputs.map((item) => item.filePath);
      const progress = (value) => sendPreFundProgress(
        event,
        'pre-fund-reconciliation:import-progress',
        value
      );
      const result = backgroundExecutionRuntimeManager.isProductionEnabled('pre-fund:mpt-repair-import')
        ? await executeManagedPreFundMptImport({
            actionKey: 'pre-fund:mpt-repair-import',
            runtime: backgroundExecutionRuntimeManager.get(),
            service,
            filePaths,
            repairFailures: service.resolveMptImportFailures(prepared.repairTokens),
            userDataDir: app.getPath('userData'),
            taskStagingDir: path.join(
              app.getPath('userData'),
              'background-execution-staging',
              taskContext.batchContext.taskRunId
            ),
            batchContext: taskContext.batchContext,
            production: true,
            onProgress: progress
          })
        : await service.retryMptImportFailures(prepared.repairTokens, {
          filePaths,
          producerTaskRunId: taskContext.batchContext.taskRunId,
          identityGate: (identity) => preFundMptHoldGate.assertIdentities([identity]),
          onProgress: progress
        });
      return result;
    } catch (error) {
      return preFundFailureResult(error);
    } finally {
      releaseBankStatementOpLock();
    }
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
      preFundMptHoldGate.assertDeleteBatch(payload);
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
        const service = getPreFundReconciliationService();
        const normalizedRange = preFundMptHoldGate.assertDeleteDateRange(service, payload);
        const result = await service.deleteTempByDateRange(normalizedRange);
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
      preFundMptHoldGate.assertAnyMutationAllowed();
      return { status: 'ok', ...await getPreFundReconciliationService().clearTemp() };
    } catch (error) {
      return preFundFailureResult(error);
    } finally {
      releaseBankStatementOpLock();
    }
  });

  trackedIpcHandle('pre-fund-reconciliation:run', '前置资金对账', '开始运行', {
    prepare(_event, payload = {}) {
      const service = getPreFundReconciliationService();
      const taskRunId = randomUUID();
      const plan = service.prepareRunLineage();
      return {
        proceed: true,
        taskRunId,
        scenario: payload && payload.scenario,
        lineageIntents: plan.lineageIntents,
        expectedDatasets: plan.expectedDatasets,
        afterTerminal: terminalRouteRegistry.createAfterTerminal(preFundRunTerminalRoute(taskRunId)),
        afterTerminalIntent: preFundRunTerminalRoute(taskRunId)
      };
    },
    async execute(event, prepared, taskContext) {
    const lock = tryAcquireBankStatementOpLock('pre-fund-run');
    if (!lock.acquired) return { status: 'busy', message: lock.message };
    try {
      return await getPreFundReconciliationService().run({
        scenario: prepared.scenario,
        taskRunId: taskContext.operationContext.taskRunId,
        expectedDatasets: prepared.expectedDatasets,
        onProgress: (progress) => sendPreFundProgress(event, 'pre-fund-reconciliation:run-progress', progress)
      });
    } catch (error) {
      await preservePreFundRunOwnerAfterMirrorCompensationFailure({
        error,
        archiveService: archiveCenterService.service,
        taskRunId: taskContext.operationContext.taskRunId
      });
      return preFundFailureResult(error);
    } finally {
      releaseBankStatementOpLock();
    }
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
        const runLocator = service.lastRunLocator();
        const plan = service.buildExportPlan(outputDirectory, exportDate, runLocator);
        if (plan.length === 0) {
          return {
            proceed: false,
            result: preFundFailureResult(Object.assign(
              new Error('本次运行没有可导出的银行渠道'),
              { code: 'pre-fund-export-empty' }
            ))
          };
        }
        // 同一用户动作可能同时包含普通渠道与重复审计渠道。为保持整批原子发布，
        // 两个 capability 必须同时通过 production gate，禁止 managed/legacy 混合写正式目录。
        const useManagedExport = backgroundExecutionRuntimeManager.isProductionEnabled(
          PRE_FUND_READ_ONLY_ACTIONS.CHANNEL
        ) && backgroundExecutionRuntimeManager.isProductionEnabled(
          PRE_FUND_READ_ONLY_ACTIONS.AUDIT
        );
        if (useManagedExport) await assertManagedExportUsesBuiltinTemplate('prefund-unbalanced');
        const stableSnapshot = useManagedExport
          ? freezePreFundSourceSnapshot({
              mainDb: database.db,
              userDataDir: path.dirname(database.dbPath),
              templatePath: service.templatePath,
              locator: runLocator
            })
          : null;
        if (useManagedExport && JSON.stringify(stableSnapshot.channels.map((item) => item.channel)) !==
            JSON.stringify(plan.map((item) => item.channel))) {
          throw new Error('前置资金对账导出渠道集合在准备期间已变化，请重新导出');
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
        const prepared = {
          proceed: true,
          exportDate,
          overwrite,
          runLocator,
          useManagedExport,
          stableRunEvidence: stableSnapshot && stableSnapshot.evidence,
          managedChannels: stableSnapshot && stableSnapshot.channels,
          sideDatabasePath: stableSnapshot && stableSnapshot.sideDbPath,
          lineageIntents: [service.lastRunLineageIntent()],
          flowPlan: service.lastRunBusinessFlowPlan(runLocator),
          filePlan: {
            version: 1,
            allocation: 'eager',
            inputs: [],
            outputs: plan.map((item) => ({
              filePath: item.filePath,
              role: 'output',
              sourceOperation: 'pre-fund-reconciliation:export'
            }))
          },
          beforeStart() {
            const currentPlan = service.buildExportPlan(outputDirectory, exportDate, runLocator);
            if (JSON.stringify(currentPlan.map((item) => item.filePath))
                !== JSON.stringify(plan.map((item) => item.filePath))) {
              throw new Error('前置资金对账导出计划在确认期间已变化，请重新导出');
            }
            if (useManagedExport) {
              assertPreFundEvidenceFresh(
                stableSnapshot.evidence,
                runLocator,
                service.templatePath
              );
            }
          }
        };
        return useManagedExport
          ? attachReadOnlyExportReceiptAcknowledgement(prepared)
          : prepared;
      } catch (error) {
        return { proceed: false, result: preFundFailureResult(error) };
      }
    },
    async execute(event, prepared, taskContext) {
    const lock = tryAcquireBankStatementOpLock('pre-fund-export');
    if (!lock.acquired) return { status: 'busy', message: lock.message };
    try {
      const service = getPreFundReconciliationService();
      const outputPaths = taskContext.fileEvidence.filePlan.outputs
        .map((item) => item.filePath);
      if (prepared.useManagedExport) {
        const stagingRoot = createReadOnlyExportStagingDirectory(
          taskContext.batchContext,
          'pre-fund'
        );
        let preserveStaging = false;
        try {
          const units = prepared.managedChannels.map((channel, index) => {
            const actionKey = channel.hasDuplicateRecords
              ? PRE_FUND_READ_ONLY_ACTIONS.AUDIT
              : PRE_FUND_READ_ONLY_ACTIONS.CHANNEL;
            return Object.freeze({
              actionKey,
              generationPlan: createReadOnlyExportGenerationPlan(
                stagingRoot,
                taskContext,
                actionKey,
                index
              ),
              context: Object.freeze({
                kind: 'pre-fund-channel',
                channel: channel.channel,
                channelDigest: channel.channelDigest,
                hasDuplicateRecords: channel.hasDuplicateRecords
              })
            });
          });
          const assertSourceFresh = () => {
            const currentPlan = service.buildExportPlan(
              path.dirname(outputPaths[0]),
              prepared.exportDate,
              prepared.runLocator
            );
            if (JSON.stringify(currentPlan.map((item) => item.filePath)) !==
                JSON.stringify(outputPaths)) {
              const error = new Error('前置资金对账导出计划已变化，请重新导出');
              error.code = 'PRE_FUND_EXPORT_SOURCE_STALE';
              throw error;
            }
            return assertPreFundEvidenceFresh(
              prepared.stableRunEvidence,
              prepared.runLocator,
              service.templatePath
            );
          };
          sendPreFundProgress(event, 'pre-fund-reconciliation:export-progress', {
            stage: 'export-start',
            current: 0,
            total: units.length
          });
          const generated = await generateValidateAndPublishPreFundExport({
            runtime: backgroundExecutionRuntimeManager.get(),
            batchContext: taskContext.batchContext,
            taskRunId: taskContext.batchContext.taskRunId,
            stableRunEvidence: prepared.stableRunEvidence,
            dbPathOrManagedSource: {
              kind: 'sqlite',
              mainDatabasePath: database.dbPath,
              sideDatabasePath: prepared.sideDatabasePath,
              templatePath: service.templatePath,
              userDataDir: path.dirname(database.dbPath)
            },
            units,
            production: true,
            assertSourceFresh,
            publisher: (artifacts) => publishReadOnlyExportArtifacts(
              'pre-fund',
              artifacts,
              taskContext
            )
          });
          prepared.readOnlyExportPublicationTaskIds = [generated.publication.taskId];
          const files = generated.publication.files.map((published, index) => {
            const channel = prepared.managedChannels[index];
            const summary = generated.summaries[index];
            const rowCounts = {
              unbalanced: summary.unbalancedCount,
              balanced: summary.balancedCount,
              gatewayBill: 0,
              channelBill: summary.channelBillCount,
              orderRepair: 0
            };
            if (channel.hasDuplicateRecords) {
              rowCounts.duplicateGateway = summary.duplicateGatewayCount;
            }
            return {
              filePath: published.filePath,
              fileName: path.basename(published.filePath),
              channel: channel.channel,
              rowCounts
            };
          });
          sendPreFundProgress(event, 'pre-fund-reconciliation:export-progress', {
            stage: 'export-done',
            current: files.length,
            total: files.length
          });
          return { status: 'ok', files, warnings: [] };
        } catch (error) {
          preserveStaging = shouldPreserveToolboxTemporaryFiles(error);
          return preFundFailureResult(error);
        } finally {
          if (!preserveStaging) cleanupReadOnlyExportStagingDirectory(stagingRoot);
        }
      }
      const options = {
        outputDirectory: path.dirname(outputPaths[0]),
        outputPaths,
        overwrite: prepared.overwrite,
        runLocator: prepared.runLocator,
        exportDate: prepared.exportDate,
        onProgress: (progress) => sendPreFundProgress(event, 'pre-fund-reconciliation:export-progress', progress)
      };
      const exported = await service.export(options);
      await taskContext.settleArtifacts({
        files: taskContext.fileEvidence.filePlan.outputs
          .map((item) => ({ artifactKey: item.artifactKey }))
      });
      return exported;
    } catch (error) {
      return preFundFailureResult(error);
    } finally {
      releaseBankStatementOpLock();
    }
    }
  });
}

function assertDuplicateInboundMatchStartupAvailable() {
  if (!applicationRecoveryCoordinator?.snapshot().platformScanCompleted || !recoveryHoldGate) {
    throw Object.assign(new Error('重复入金启动恢复门禁尚未完成'), {
      code: 'DUPLICATE_STARTUP_RECOVERY_UNAVAILABLE'
    });
  }
  recoveryHoldGate.assertNoRecoveryHold({
    conflictScopeKey: DUPLICATE_STARTUP_CONFLICT_SCOPE_KEY
  });
  return true;
}

function getDuplicateInboundMatchService() {
  assertDuplicateInboundMatchStartupAvailable();
  if (!database || !database.db) {
    throw new Error('数据库尚未初始化，请稍后重试');
  }
  if (!duplicateInboundMatchService) {
    duplicateInboundMatchService = createDuplicateInboundMatchService({
      userDataDir: path.dirname(database.dbPath),
      database,
      mailTemplatePath: path.join(__dirname, '..', 'assets', '重复入金召回邮件模板.xlsx'),
      bankTemplatePath: path.join(__dirname, '..', 'assets', '银行对账单.xlsx'),
      mailTemplateSource: getTemplateResourceService().source('dup-recall-mail', 'duplicate-inbound-match'),
      bankTemplateSource: getTemplateResourceService().source('bank-statement', 'duplicate-inbound-match'),
      resolveBankSourceHeaders: async () => bankStatementSourceHeaders(await resolveBankStatementStructure(getTemplateResourceService()))
    });
  }
  return duplicateInboundMatchService;
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
      assertDuplicateInboundMatchStartupAvailable();
      const choice = await showImportOpenDialog('duplicate-inbound-match', {
        title: '同时选择银行对账单和单据对账单',
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: 'Excel', extensions: ['xlsx', 'xls'] }]
      });
      if (choice.canceled || !choice.filePaths || choice.filePaths.length === 0) {
        return { proceed: false, result: { status: 'cancelled' } };
      }
      return {
        proceed: true,
        filePlan: {
          version: 1,
          allocation: 'eager',
          inputs: choice.filePaths.map((filePath) => ({
            filePath,
            role: 'input',
            sourceOperation: 'duplicate-inbound-match:import-files'
          })),
          outputs: []
        }
      };
    },
    async execute(event, _prepared, taskContext) {
    const lock = tryAcquireBankStatementOpLock('duplicate-inbound-import-files');
    if (!lock.acquired) return { status: 'busy', message: lock.message };
    try {
      const imported = await getDuplicateInboundMatchService().importFiles(
        taskContext.fileEvidence.filePlan.inputs.map((item) => item.filePath),
        (progress) => sendDuplicateInboundMatchProgress(
          event,
          'duplicate-inbound-match:import-progress',
          progress
        )
      );
      return imported;
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
      return {
        proceed: true,
        filePlan: {
          version: 1,
          allocation: 'eager',
          inputs: [],
          outputs: [{
            filePath: choice.filePath,
            role: 'output',
            sourceOperation: 'duplicate-inbound-match:export'
          }]
        }
      };
    },
    async execute(event, prepared, taskContext) {
    const lock = tryAcquireBankStatementOpLock('duplicate-inbound-export');
    if (!lock.acquired) return { status: 'busy', message: lock.message };
    try {
      const exported = await getDuplicateInboundMatchService().export({
        savePath: taskContext.fileEvidence.filePlan.outputs[0].filePath,
        onProgress: (progress) => sendDuplicateInboundMatchProgress(
          event,
          'duplicate-inbound-match:export-progress',
          progress
        )
      });
      await taskContext.settleArtifacts({
        files: taskContext.fileEvidence.filePlan.outputs
          .map((item) => ({ artifactKey: item.artifactKey }))
      });
      return exported;
    } catch (error) {
      return duplicateInboundMatchFailureResult(error);
    } finally {
      releaseBankStatementOpLock();
    }
    }
  });
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
    const pendingSideDbOperation = positionTaskOwner.readPositionPendingRaw();
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
        templateSource: getTemplateResourceService().source('position-bank', 'position-reconciliation-process'),
        resolveSourceStructures: resolvePositionSourceStructures,
        requireExistingSideDb: Boolean(expectedSideDbCheckpoint),
        expectedSideDbCheckpoint,
        expectedPendingOperation: pendingSideDbOperation,
        initialSideDbCheckpoint,
        operationTokenProvider: () => {
          return positionTaskOwner.currentOperationToken();
        },
        recordArchiveIntent: (filePaths, role) => {
          positionTaskOwner.recordPositionArchiveIntentFiles(filePaths, role);
        },
        protectedStagingPaths: positionTaskOwner.positionArchivePersistentStagingPaths,
        positionImportEngine: 'streaming',
        resolveBankSourceHeaders: async () => bankStatementSourceHeaders(await resolveBankStatementStructure(getTemplateResourceService())),
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
            readPending: positionTaskOwner.readPositionPendingOperation,
            writePending: positionTaskOwner.writePositionPendingOperation,
            recordArchiveIntentFiles: positionTaskOwner.recordPositionArchiveIntentFiles
          });
        }
      });
      const checkpoint = service.persistenceCheckpoint();
      const recovery = positionTaskOwner.recoverPositionArchiveIntent(
        pendingSideDbOperation ? positionTaskOwner.readPositionPendingOperation() : null,
        checkpoint,
        service
      );
      positionReconciliationService = service;
      if (pendingSideDbOperation) {
        const pending = positionTaskOwner.readPositionPendingOperation();
        const operationToken = String(pending && pending.operationToken || '');
        const archiveResult = recovery && recovery.archiveResult;
        const recoveryTask = archiveResult
          && archiveResult.code !== 'ARCHIVE_OPERATION_DELETED'
          ? (archiveCenterService || initializeArchiveCenter()).flushOutbox()
          : positionTaskOwner.finalizeRecoveredPositionPending(operationToken, {
              archiveDurable: true,
              archiveReference: archiveResult && archiveResult.batchId
                || pending && pending.archiveReference
                || '',
              archiveResult
            });
        positionPendingRecoveryPromise = Promise.resolve(recoveryTask)
          .then((result) => {
            const unresolved = positionTaskOwner.readPositionPendingOperation();
            if (unresolved && unresolved.operationToken === operationToken) {
              throw new Error('平盘原任务恢复尚未完成，pending 已保留');
            }
            return result;
          })
          .catch((error) => {
            appendActivityLogEntry({
              level: 'error',
              source: 'main',
              domain: 'position-reconciliation-recovery',
              message: '平盘原任务恢复尚未完成，pending 已保留',
              details: [error && error.message ? error.message : String(error)]
            });
            throw error;
          });
        trackArchiveOperationPromise(positionPendingRecoveryPromise);
      } else {
        positionTaskOwner.completePositionServiceInitialization(checkpoint);
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
      prepare: (_event, token) => {
        const files = getPositionReconciliationService().bankImportArchiveIntent(token);
        return {
          proceed: true,
          positionArchiveEvidence: Object.freeze({
            inputs: Object.freeze(files.map((file) => Object.freeze({
              sourceType: file.sourceType,
              sha256: file.expectedSha256 || file.sha256,
              sizeBytes: file.sizeBytes
            }))),
            outputs: Object.freeze([])
          }),
          filePlan: {
            version: 1,
            allocation: 'eager',
            inputs: files.map((file) => ({
              filePath: file.filePath,
              ...positionInputFilePlanEvidence(file),
              originalName: file.originalName,
              role: 'input',
              sourceOperation: 'position-reconciliation:bank:apply-import'
            })),
            outputs: []
          }
        };
      },
      execute: (_event, _prepared, taskContext, token) => (
        withPositionReconciliationLock('bank-import-apply', () => {
          return getPositionReconciliationService().applyBankImport(
            token,
            taskContext.batchContext,
            taskContext.fileEvidence.filePlan.inputs.map((item) => item.filePath)
          );
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
      prepare: (_event, token) => {
        const files = getPositionReconciliationService().sourceImportArchiveIntent(token);
        return {
          proceed: true,
          positionArchiveEvidence: Object.freeze({
            inputs: Object.freeze(files.map((file) => Object.freeze({
              sourceType: file.sourceType,
              sha256: file.expectedSha256 || file.sha256,
              sizeBytes: file.sizeBytes
            }))),
            outputs: Object.freeze([])
          }),
          filePlan: {
            version: 1,
            allocation: 'eager',
            inputs: files.map((file) => ({
              filePath: file.filePath,
              ...positionInputFilePlanEvidence(file),
              originalName: file.originalName,
              role: 'input',
              sourceOperation: 'position-reconciliation:source:apply-import'
            })),
            outputs: []
          }
        };
      },
      execute: (_event, _prepared, taskContext, token) => (
        withPositionReconciliationLock('source-import-apply', () => {
          return getPositionReconciliationService().applySourceImport(
            token,
            taskContext.batchContext,
            taskContext.fileEvidence.filePlan.inputs.map((item) => item.filePath)
          );
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
      return {
        proceed: true,
        reportKey,
        filePlan: {
          version: 1,
          allocation: 'eager',
          inputs: [],
          outputs: [{
            filePath: choice.filePath,
            role: 'output',
            sourceOperation: 'position-reconciliation:source:export-anomaly'
          }]
        }
      };
    },
    execute: (_event, prepared, taskContext) => withPositionReconciliationLock(
      'source-anomaly-export',
      async () => {
        const result = await getPositionReconciliationService().exportAnomalyReport(
          prepared.reportKey,
          taskContext.fileEvidence.filePlan.outputs[0].filePath
        );
        return result;
      }
    )
  });

  ipcMain.handle('position-reconciliation:import:cancel', async (_event, jobId) => {
    try {
      const active = positionTaskOwner.activeOperation();
      return getPositionReconciliationService().cancelActiveImport(
        jobId,
        () => (active ? positionTaskOwner.persistPositionCancellationAccepted(active) : null)
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
            taskContext.operationContext
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
            taskContext.operationContext
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
            taskContext.operationContext
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
        return {
          proceed: true,
          payload,
          filePlan: {
            version: 1,
            allocation: 'eager',
            inputs: [],
            outputs: [{
              filePath: choice.filePath,
              role: 'output',
              sourceOperation: 'position-reconciliation:bank:export'
            }]
          }
        };
      },
      execute: (_event, prepared, taskContext) => withPositionReconciliationLock('bank-export', async () => {
        const result = await getPositionReconciliationService().exportBank(
          prepared.payload,
          taskContext.fileEvidence.filePlan.outputs[0].filePath
        );
        return result;
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
        return {
          proceed: true,
          sourceType,
          filePlan: {
            version: 1,
            allocation: 'eager',
            inputs: [],
            outputs: [{
              filePath: choice.filePath,
              role: 'output',
              sourceOperation: 'position-reconciliation:linked:export'
            }]
          }
        };
      },
      execute: (_event, prepared, taskContext) => withPositionReconciliationLock('linked-export', async () => {
        const result = await getPositionReconciliationService().exportLinked(
          prepared.sourceType,
          taskContext.fileEvidence.filePlan.outputs[0].filePath
        );
        return result;
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
        return {
          proceed: true,
          sourceType,
          filePlan: {
            version: 1,
            allocation: 'eager',
            inputs: [],
            outputs: [{
              filePath: choice.filePath,
              role: 'output',
              sourceOperation: 'position-reconciliation:raw:export'
            }]
          }
        };
      },
      execute: (_event, prepared, taskContext) => withPositionReconciliationLock('raw-export', async () => {
        const result = await getPositionReconciliationService().exportRaw(
          prepared.sourceType,
          taskContext.fileEvidence.filePlan.outputs[0].filePath
        );
        return result;
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
        const useManagedExport = backgroundExecutionRuntimeManager.isProductionEnabled(
          POSITION_READ_ONLY_ACTION
        );
        const filters = {
          channels: Array.isArray(payload.channels) ? payload.channels : [],
          regions: Array.isArray(payload.regions) ? payload.regions : [],
          months: Array.isArray(payload.months) ? payload.months : [],
          differenceStatuses: Array.isArray(payload.differenceStatuses)
            ? payload.differenceStatuses
            : []
        };
        const variant = payload.differencesOnly === true ? 'differences' : 'run';
        const stableSnapshot = useManagedExport
          ? await freezePositionReadOnlyExportSource(
              service,
              variant,
              payload.runId,
              filters
            )
          : null;
        const prepared = {
          proceed: true,
          payload,
          useManagedExport,
          positionExportContext: stableSnapshot && stableSnapshot.context,
          stableRunEvidence: stableSnapshot && stableSnapshot.evidence,
          filePlan: {
            version: 1,
            allocation: 'eager',
            inputs: [],
            outputs: [{
              filePath: choice.filePath,
              role: 'output',
              sourceOperation: 'position-reconciliation:run:export'
            }]
          },
          async beforeStart() {
            if (useManagedExport) {
              await assertPositionEvidenceFresh(
                service,
                stableSnapshot.evidence,
                stableSnapshot.context
              );
            }
          }
        };
        return useManagedExport
          ? attachReadOnlyExportReceiptAcknowledgement(prepared)
          : prepared;
      },
      execute: (_event, prepared, taskContext) => withPositionReconciliationLock('result-export', async () => {
        const service = getPositionReconciliationService();
        if (prepared.useManagedExport) {
          return executeManagedPositionReadOnlyExport(service, prepared, taskContext);
        }
        const { payload } = prepared;
        const result = await service.exportRun(
          payload.runId,
          taskContext.fileEvidence.filePlan.outputs[0].filePath,
          {
            differencesOnly: payload.differencesOnly === true,
            channels: Array.isArray(payload.channels) ? payload.channels : [],
            regions: Array.isArray(payload.regions) ? payload.regions : [],
            months: Array.isArray(payload.months) ? payload.months : [],
            differenceStatuses: Array.isArray(payload.differenceStatuses)
              ? payload.differenceStatuses
              : []
          }
        );
        return result;
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
      const useManagedExport = backgroundExecutionRuntimeManager.isProductionEnabled(
        POSITION_READ_ONLY_ACTION
      );
      const stableSnapshot = useManagedExport
        ? await freezePositionReadOnlyExportSource(service, 'filtered', runId, {})
        : null;
      const prepared = {
        proceed: true,
        runId,
        useManagedExport,
        positionExportContext: stableSnapshot && stableSnapshot.context,
        stableRunEvidence: stableSnapshot && stableSnapshot.evidence,
        filePlan: {
          version: 1,
          allocation: 'eager',
          inputs: [],
          outputs: [{
            filePath: choice.filePath,
            role: 'output',
            sourceOperation: 'position-reconciliation:run:export-filtered'
          }]
        },
        async beforeStart() {
          if (useManagedExport) {
            await assertPositionEvidenceFresh(
              service,
              stableSnapshot.evidence,
              stableSnapshot.context
            );
          }
        }
      };
      return useManagedExport
        ? attachReadOnlyExportReceiptAcknowledgement(prepared)
        : prepared;
    },
    execute: (_event, prepared, taskContext) => withPositionReconciliationLock(
      'result-filtered-export',
      async () => {
        const service = getPositionReconciliationService();
        if (prepared.useManagedExport) {
          return executeManagedPositionReadOnlyExport(service, prepared, taskContext);
        }
        const result = await service.exportRunFilteredSources(
          prepared.runId,
          taskContext.fileEvidence.filePlan.outputs[0].filePath
        );
        return result;
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
          runId,
          filePlan: {
            version: 1,
            allocation: 'eager',
            inputs: [{
              filePath: choice.filePaths[0],
              role: 'input',
              sourceOperation: 'position-reconciliation:run:import-result'
            }],
            outputs: []
          }
        };
      },
      execute: (_event, prepared, taskContext) => withPositionReconciliationLock(
        'result-import',
        () => getPositionReconciliationService().importRunResult(
          prepared.runId,
          taskContext.fileEvidence.filePlan.inputs[0].filePath
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
//     失败     { status:'failed', message, detailLines, code? }（表头不一致 / 空文件 / 字段缺失 / 运行错误）
//   trackedIpcHandle 仅在 status∈{ok,success} 时计 usage（取消/失败不计）。
//
// 把异常归一为失败结果，保留已有错误码与诊断；无错误码的旧异常仍保持原返回形状。
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
  return { status: 'failed', message, detailLines,
    ...(error && typeof error.code === 'string' && error.code ? { code: error.code } : {}) };
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

async function publishToolboxArtifacts(
  kind,
  artifacts,
  targets,
  batchContext,
  options = {}
) {
  const targetSnapshots = Array.isArray(options.targetSnapshots)
    ? options.targetSnapshots
    : [];
  const publication = await publishToolboxPublicationAsync({
    taskId: `toolbox-${kind}-${Date.now()}-${randomUUID()}`,
    artifacts,
    targets: (Array.isArray(targets) ? targets : []).map((target, index) => ({
      ...(target && typeof target === 'object' ? target : { targetPath: target }),
      ...(targetSnapshots[index]
        ? { expectedTargetSnapshot: targetSnapshots[index] }
        : {})
    })),
    protectedSourcePaths: options.protectedSourcePaths,
    userDataDir: app.getPath('userData'),
    batchContext,
    archiveInputFiles: options.archiveInputFiles,
    allowEmptyArchiveInputs: options.allowEmptyArchiveInputs === true
  });
  try {
    if (typeof options.settleManifestArtifacts === 'function') {
      const plan = options.fileEvidence && options.fileEvidence.filePlan;
      if (!plan || plan.outputs.length !== publication.files.length) {
        throw new Error('工具箱 publication 与 manifest output 数量不一致');
      }
      const files = [
        ...plan.inputs.map((item) => ({ artifactKey: item.artifactKey })),
        ...plan.outputs.map((item, index) => ({
          artifactKey: item.artifactKey,
          expectedSha256: publication.files[index].sha256,
          expectedSizeBytes: publication.files[index].byteSize
        }))
      ];
      const settled = await options.settleManifestArtifacts({ files });
      if (!settled || settled.durable !== true) {
        throw new Error('工具箱 manifest artifact 尚未全部 durable');
      }
    } else {
      await recoverToolboxPublicationsIntoArchive({
        userDataDir: app.getPath('userData'),
        archiveCenter: archiveCenterService,
        recoverPublications: recoverArchivePublications,
        taskIds: [publication.taskId]
      });
    }
  } catch (error) {
    // 正式目标已经 committed，不能把存档暂时失败重新解释成业务失败并让
    // TaskLifecycle 把原批次写成 failed。receipt 仍保留并阻止下一次发布；
    // 当前 lifecycle 继续用冻结 input/output 证据重试，启动 owner 也可再次接管。
    publication.pendingArchiveHandoff = true;
    publication.warnings = [
      ...(Array.isArray(publication.warnings) ? publication.warnings : []),
      '正式输出已保存；存档接管尚未完成，后续工具箱发布将暂时受限并自动重试。'
    ];
    appendActivityLogEntry({
      level: 'error',
      source: 'main',
      domain: 'toolbox',
      message: '工具箱正式输出已提交，但存档耐久接管待重试',
      details: [
        error && error.message ? error.message : String(error),
        ...(error && Array.isArray(error.detailLines) ? error.detailLines : [])
      ],
      stack: error && error.stack ? error.stack : undefined
    });
  }
  return publication;
}

async function acknowledgeToolboxPublicationReceipts(taskIds) {
  return acknowledgeToolboxPublicationReceiptsIntoArchive({
    userDataDir: app.getPath('userData'),
    archiveCenter: archiveCenterService,
    recoverPublications: recoverArchivePublications,
    taskIds
  });
}

function captureToolboxTargetSnapshot(targetPath) {
  const resolvedPath = path.resolve(String(targetPath || ''));
  try {
    const stat = fs.lstatSync(resolvedPath, { bigint: true });
    const snapshot = sourceSnapshotFromStat(stat);
    if (!snapshot) throw new Error(`输出目标不是可覆盖的普通文件：${resolvedPath}`);
    return Object.freeze({ exists: true, snapshot: Object.freeze(snapshot) });
  } catch (error) {
    if (error && error.code === 'ENOENT') return Object.freeze({ exists: false });
    throw error;
  }
}

function captureToolboxTargetSnapshots(targetPaths) {
  return (Array.isArray(targetPaths) ? targetPaths : []).map(
    (targetPath) => captureToolboxTargetSnapshot(targetPath)
  );
}

function createVccOutputStagingDirectory(batchContext) {
  const root = path.join(
    app.getPath('userData'),
    'run-data',
    'vcc-financial-op',
    'output-generation'
  );
  fs.mkdirSync(root, { recursive: true });
  return fs.mkdtempSync(path.join(root, `${batchContext.taskRunId.replace(/[^a-zA-Z0-9._-]+/g, '-')}-`));
}

function cleanupVccOutputStagingDirectory(directoryPath) {
  if (!directoryPath) return;
  try {
    fs.rmSync(directoryPath, { recursive: true, force: true });
  } catch (error) {
    appendActivityLogEntry({
      level: 'warning',
      source: 'main',
      domain: 'vcc-financial-op',
      message: 'VCC 导出临时目录清理失败',
      details: [
        `临时目录：${directoryPath}`,
        `原因：${error && error.message ? error.message : String(error)}`
      ]
    });
  }
}

function assertToolboxTargetSnapshotsFresh(targetPaths, snapshots) {
  const paths = Array.isArray(targetPaths) ? targetPaths : [];
  const expected = Array.isArray(snapshots) ? snapshots : [];
  if (paths.length !== expected.length) throw new Error('输出目标确认信息已失效，请重新选择');
  for (let index = 0; index < paths.length; index += 1) {
    let stat = null;
    try {
      stat = fs.lstatSync(paths[index], { bigint: true });
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error;
    }
    const unchanged = expected[index].exists
      ? Boolean(stat && sourceSnapshotMatchesStat(expected[index].snapshot, stat))
      : !stat;
    if (!unchanged) throw new Error(`输出目标在确认后发生变化，请重新确认：${paths[index]}`);
  }
}

function assertToolboxTargetsDoNotAliasSources(sourcePaths, targetPaths) {
  for (const sourcePath of Array.isArray(sourcePaths) ? sourcePaths : []) {
    for (const targetPath of Array.isArray(targetPaths) ? targetPaths : []) {
      if (pathsAlias(fs, sourcePath, targetPath)) {
        throw new Error(`输出文件不能覆盖输入源文件：${targetPath}`);
      }
    }
  }
}

let toolboxSplitReadContext = null;
const toolboxSplitReadOwners = new WeakMap();

function recoverToolboxScansAtStartup() {
  const report = recoverToolboxScanResources({
    temporaryRoot: path.join(app.getPath('userData'), 'toolbox-scan-temp')
  });
  if (report.cleanupPendingCount > 0) {
    try { appendActivityLogEntry({
      level: 'warning', source: 'main', domain: 'toolbox',
      message: '拆分扫描临时资源仍待清理，已保留责任记录和原内容',
      details: report.cleanupFailures.map((item) => `${item.id || 'root'}: ${item.code} ${item.message}`)
    }); } catch (error) { console.warn('扫描补偿诊断写入日志失败，责任记录继续保留', error); }
  }
  return report;
}

function getToolboxSplitReadOwner() {
  const runtime = backgroundExecutionRuntimeManager.get();
  if (!toolboxSplitReadOwners.has(runtime)) {
    toolboxSplitReadOwners.set(runtime, createToolboxSplitReadOwner({ governor: runtime.resourceGovernor,
      temporaryRoot: path.join(app.getPath('userData'), 'toolbox-scan-temp') }));
  }
  return toolboxSplitReadOwners.get(runtime);
}

function createToolboxSplitReadContext(sourceFilePath, dataRowCount, senderId = null) {
  const resolvedPath = path.resolve(String(sourceFilePath || ''));
  const snapshot = sourceSnapshotFromStat(fs.statSync(resolvedPath, { bigint: true }));
  if (!snapshot) throw new Error('拆分源文件不可读，请重新选择');
  const context = Object.freeze({
    token: randomUUID(),
    senderId,
    sourceFilePath: resolvedPath,
    dataRowCount,
    snapshot: Object.freeze({ ...snapshot })
  });
  toolboxSplitReadContext = context;
  return context;
}

function requireToolboxSplitReadContext(payload = {}, event = null) {
  if (event && getToolboxSplitReadOwner().ownsToken(event.sender, payload.splitReadToken)) {
    return getToolboxSplitReadOwner().requireContext(event.sender, payload);
  }
  const token = String(payload.splitReadToken || '').trim();
  const sourceFilePath = path.resolve(String(payload.sourceFilePath || ''));
  const context = toolboxSplitReadContext;
  if (!context || context.token !== token || context.sourceFilePath !== sourceFilePath ||
      (context.senderId !== null && context.senderId !== event?.sender?.id)) {
    const error = new Error('拆分源文件准备信息已失效，请重新选择');
    error.code = 'TOOLBOX_SPLIT_READ_CONTEXT_STALE';
    throw error;
  }
  return context;
}

function clearToolboxSplitReadContext(context) {
  if (toolboxSplitReadContext === context) toolboxSplitReadContext = null;
  if (context && context.senderId != null && context.fields instanceof Map) getToolboxSplitReadOwner().clear(context);
}

function assertToolboxSplitSourceFresh(context, sourceEvidence) {
  let stat;
  try {
    stat = fs.statSync(context.sourceFilePath, { bigint: true });
  } catch (_error) {
    clearToolboxSplitReadContext(context);
    throw new Error('拆分源文件已不存在，请重新选择');
  }
  if (!sourceEvidence
      || sourceEvidence.filePath !== context.sourceFilePath
      || !sourceSnapshotMatchesStat(context.snapshot, stat)
      || !sourceSnapshotMatchesStat(sourceEvidence.sourceSnapshot, stat)) {
    clearToolboxSplitReadContext(context);
    throw new Error('拆分源文件在读取后已变化，请重新选择');
  }
}

async function recoverToolboxPublicationsAtStartup() {
  toolboxStartupRecoveryError = null;
  try {
    const result = await recoverToolboxPublicationsIntoArchive({
      userDataDir: app.getPath('userData'),
      archiveCenter: archiveCenterService,
      recoverPublications: recoverArchivePublications
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
    // v3.2.20：已下线模块（业务OP数据核对）遗留的发布记录原样保留，启动继续；
    //   共享发布器在其被处理前会拒绝新的导出，这里记录原因与恢复路径便于处理。
    const deferredItems = Array.isArray(result.deferred) ? result.deferred : [];
    for (const [code, message, guidance] of [
      [RETIRED_PUBLICATION_DEFER_CODE, '已下线模块「业务OP数据核对」遗留未完成的导出，记录已原样保留',
        '在用 v3.2.19 及更早版本打开一次完成收尾前，新的导出会被拒绝'],
      [RETIRED_PUBLICATION_MANUAL_CODE, '已下线模块「业务OP数据核对」遗留需人工恢复的导出，记录已原样保留',
        '旧版也无法自动收尾：请按下列恢复路径人工处理，处理完成前新的导出会被拒绝']
    ]) {
      const retiredDeferred = deferredItems.filter((item) => item && item.code === code);
      if (retiredDeferred.length === 0) continue;
      appendActivityLogEntry({
        level: 'warning',
        source: 'main',
        domain: 'toolbox',
        message,
        details: [
          guidance,
          ...retiredDeferred.map((item) => `${item.taskId}`),
          ...retiredDeferred.flatMap((item) => (item.recoveryPaths || []).map((filePath) => `恢复路径：${filePath}`))
        ]
      });
    }
  } catch (error) {
    toolboxStartupRecoveryError = error;
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
  trackedIpcHandle('toolbox:merge', '工具箱', '合并表格', {
    async prepare() {
      try {
        const choice = await showImportOpenDialog('toolbox', {
          title: '选择要合并的表格（多选，表头需完全一致）',
          properties: ['openFile', 'multiSelections'],
          filters: statementFileDialogFilters()
        });
        if (choice.canceled || !choice.filePaths || choice.filePaths.length === 0) {
          return { proceed: false, result: { status: 'cancelled' } };
        }
        const saveResult = await dialog.showSaveDialog(mainWindow, {
          defaultPath: toolboxBuildMergeFileName(),
          filters: [{ name: 'Excel', extensions: ['xlsx'] }]
        });
        if (saveResult.canceled || !saveResult.filePath) {
          return { proceed: false, result: { status: 'cancelled' } };
        }
        assertToolboxTargetsDoNotAliasSources(choice.filePaths, [saveResult.filePath]);
        const inputFiles = Object.freeze(choice.filePaths.map((filePath) => Object.freeze({
          filePath,
          role: 'input',
          sourceOperation: 'toolbox:merge'
        })));
        const prepared = {
          proceed: true,
          filePlan: {
            version: 1,
            allocation: 'eager',
            inputs: inputFiles,
            outputs: [{
              filePath: saveResult.filePath,
              role: 'output',
              sourceOperation: 'toolbox:merge'
            }]
          }
        };
        return prepared;
      } catch (error) {
        return { proceed: false, result: toolboxFailureResult(error) };
      }
    },
    async execute(_event, prepared, taskContext) {
      try {
        const filePaths = taskContext.fileEvidence.inputFiles.map((file) => file.filePath);
        const outputPath = taskContext.fileEvidence.filePlan.outputs[0].filePath;
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'toolbox-'));
        const tempPath = path.join(tempDir, `toolbox-${Date.now()}.xlsx`);
        let preserveTempDir = false;
        try {
          const publishMergeArtifacts = async (artifacts) => {
            const publication = await publishToolboxArtifacts(
              'merge',
              artifacts,
              [{ targetPath: outputPath }],
              taskContext.batchContext,
              {
                protectedSourcePaths: filePaths,
                targetSnapshots: taskContext.fileEvidence.targetSnapshots,
                archiveInputFiles: taskContext.fileEvidence.inputFiles,
                settleManifestArtifacts: taskContext.settleArtifacts,
                fileEvidence: taskContext.fileEvidence
              }
            );
            return publication;
          };
          let writeRes;
          let publishResult;
          if (backgroundExecutionRuntimeManager.isProductionEnabled(
            TOOLBOX_GENERATION_ACTIONS.MERGE
          )) {
            const generated = await generateValidateAndPublishToolboxArtifact({
              runtime: backgroundExecutionRuntimeManager.get(),
              actionKey: TOOLBOX_GENERATION_ACTIONS.MERGE,
              filePlan: taskContext.fileEvidence.filePlan,
              batchContext: taskContext.batchContext,
              generationPath: tempPath,
              operationConfig: { sheetBaseName: 'COMMON' },
              production: true,
              publisher: (artifacts) => publishMergeArtifacts(
                artifacts.map((artifact) => ({
                  sourcePath: artifact.generationPath,
                  outputId: artifact.outputId,
                  fileName: path.basename(outputPath),
                  byteSize: artifact.byteSize,
                  sha256: artifact.sha256,
                  dataRowCount: artifact.dataRowCount,
                  sheetCount: artifact.sheetCount,
                  warningSummary: artifact.warningSummary,
                  styleStats: artifact.styleStats
                }))
              )
            });
            writeRes = {
              ...generated.artifact,
              fileCount: generated.summary.sourceFileCount,
              inputSheetCount: generated.summary.inputSheetCount,
              dataRowCount: generated.summary.outputDataRowCount
            };
            publishResult = generated.publication;
          } else {
            writeRes = await toolboxMergeFilesToXlsx({
              filePaths,
              savePath: tempPath,
              sheetBaseName: 'COMMON'
            });
            publishResult = await publishMergeArtifacts([{
              sourcePath: tempPath,
              outputId: 'merge-1',
              fileName: path.basename(outputPath),
              byteSize: writeRes.byteSize,
              sha256: writeRes.sha256,
              dataRowCount: writeRes.dataRowCount,
              sheetCount: writeRes.sheetCount,
              warningSummary: writeRes.warningSummary || EMPTY_TOOLBOX_WARNING_SUMMARY,
              styleStats: writeRes.styleStats || null
            }]);
          }
          prepared.toolboxPublicationTaskIds = [publishResult.taskId];
          const publishedFile = publishResult.files[0];
          prepared.outputFiles = toolboxFinalOutputFiles(
            publishResult.files,
            'toolbox:merge'
          );
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
    }
  });

  // IPC 2 —— 拆表第一步：单选 → 取表头 + 流式扫一遍累积各字段去重值 → 回传给前端选字段弹框
  //   v3.0.8 BUG3：.xlsx 走流式（readHeaderRowStreamed 取表头 + streamDataRows 逐行喂去重累加器，内存常数），
  //   .csv/.xls 回退全量 extractHeaders + readRows + computeValuesByField。返回契约 {status,sourceFilePath,headers,valuesByField} 不变。
  ipcMain.handle('toolbox:split:read', async (event, request) => {
    try {
      if (request !== undefined) {
        return await getToolboxSplitReadOwner().read(event.sender, request, async () => {
          const choice = await showImportOpenDialog('toolbox', {
            title: '选择要拆分的表格', properties: ['openFile'], filters: statementFileDialogFilters()
          });
          return !choice.canceled && choice.filePaths && choice.filePaths[0];
        });
      }
      // 保留旧调用的显式兼容入口；新 Renderer 始终使用 version:2。
      toolboxSplitReadContext = null;
      const choice = await showImportOpenDialog('toolbox', {
        title: '选择要拆分的表格',
        properties: ['openFile'],
        filters: statementFileDialogFilters()
      });
      if (choice.canceled || !choice.filePaths || choice.filePaths.length === 0) {
        return { status: 'cancelled' };
      }
      const sourceFilePath = choice.filePaths[0];
      const readStartedSnapshot = sourceSnapshotFromStat(fs.statSync(sourceFilePath, { bigint: true }));
      if (!readStartedSnapshot) throw new Error('拆分源文件不可读，请重新选择');

      // 普通与 Worker 只区分执行位置，读取、matchValue 和字段去重均走同一 style-aware facade。
      const scanResult = await shouldUseLargeChannel(sourceFilePath)
        ? await dispatchLargeSplit({ op: 'scanFields', filePath: sourceFilePath }).promise
        : await scanToolboxSplitFields(sourceFilePath);
      const { headers, valuesByField, dataRowCount } = scanResult || {};
      if (!headers || headers.length === 0) {
        return { status: 'failed', message: '文件为空或不可读，请重新导入', detailLines: [] };
      }
      const readContext = createToolboxSplitReadContext(sourceFilePath, dataRowCount, event?.sender?.id ?? null);
      if (!sourceSnapshotMatchesStat(readStartedSnapshot, fs.statSync(sourceFilePath, { bigint: true }))) {
        clearToolboxSplitReadContext(readContext);
        throw new Error('拆分源文件在读取过程中已变化，请重新选择');
      }
      return {
        status: 'success',
        sourceFilePath: readContext.sourceFilePath,
        splitReadToken: readContext.token,
        dataRowCount: readContext.dataRowCount,
        maxRowSplitFiles: MAX_ROW_SPLIT_FILES,
        headers,
        valuesByField
      };
    } catch (error) {
      return toolboxFailureResult(error);
    }
  });

  ipcMain.handle('toolbox:split:read-values', async (event, request) => {
    try { return await getToolboxSplitReadOwner().readValues(event.sender, request); }
    catch (error) { return toolboxFailureResult(error); }
  });
  ipcMain.handle('toolbox:split:cancel-read', async (event, request) => {
    try { return getToolboxSplitReadOwner().cancel(event.sender, request); }
    catch (error) { return toolboxFailureResult(error); }
  });

  // IPC 3 —— 拆表第二步：{sourceFilePath, field, values[]} → 流式过滤 row[field]∈values（多选值→单文件）→ 写临时 → 另存为
  //   v3.0.8 BUG3：.xlsx 走流式（readHeaderRowStreamed 取表头判字段是否存在 + createRowFilter 逐行过滤 + writeRowsStreamed 逐行写命中行，内存常数），
  //   .csv/.xls 回退全量 readRows + filterRowsByFieldValues。
  //   口径：字段不存在用「表头」判定（开始前，保留现文案）、命中数 0 用「emit 计数（writeRowsStreamed.dataRowCount）」判定（0 不产文件，删临时，保留现文案）。
  trackedIpcHandle('toolbox:split:export', '工具箱', '拆分表格', {
    async prepare(_event, payload = {}) {
      try {
        const readContext = requireToolboxSplitReadContext(payload, _event);
        if (![undefined, 'single', 'multiple', 'rows'].includes(payload.mode)) {
          throw new Error('不支持的拆分模式');
        }
        const { field, values } = payload;
        if (payload.mode !== 'multiple' && payload.mode !== 'rows' && !field) {
          return {
            proceed: false,
            result: { status: 'failed', message: '未选择拆分字段', detailLines: [] }
          };
        }
        if (payload.mode !== 'multiple' && payload.mode !== 'rows' && (!Array.isArray(values) || values.length === 0)) {
          return {
            proceed: false,
            result: { status: 'failed', message: '请至少选择一个值', detailLines: [] }
          };
        }
        let outputPaths;
        let targetPlans = null;
        let savePath = '';
        let rows = null;
        if (payload.mode === 'rows') {
          rows = await prepareToolboxRows(payload, readContext, {
            metadataDirectory: app.getPath('userData'),
            chooseDirectory: async () => {
              const choice = await showImportOpenDialog('toolbox-split-export-directory', {
                title: '选择拆分文件保存目录', properties: ['openDirectory', 'createDirectory']
              });
              return !choice.canceled && choice.filePaths && choice.filePaths[0];
            },
            confirmOverwrite: async (conflicts) => {
              const choice = await dialog.showMessageBox(mainWindow, {
                type: 'warning', buttons: ['返回', '覆盖全部'], defaultId: 0, cancelId: 0,
                noLink: true, title: '文件已存在',
                message: `有 ${conflicts.length} 个目标文件已存在，是否覆盖全部？`,
                detail: conflicts.map((item) => item.fileName).join('\n')
              });
              return choice && choice.response === 1;
            }
          });
          if (!rows) return { proceed: false, result: { status: 'cancelled' } };
          outputPaths = rows.targets.map((item) => item.filePath);
        } else if (payload.mode === 'multiple') {
          const groups = toolboxNormalizeMultiSplitGroups(payload.groups);
          const directoryChoice = await showImportOpenDialog('toolbox-split-export-directory', {
            title: '选择拆分文件保存目录',
            properties: ['openDirectory', 'createDirectory']
          });
          if (directoryChoice.canceled
              || !directoryChoice.filePaths
              || directoryChoice.filePaths.length === 0) {
            return { proceed: false, result: { status: 'cancelled' } };
          }

          const outputDirectory = directoryChoice.filePaths[0];
          targetPlans = groups.map((group) => ({
            ...group,
            targetPath: path.join(outputDirectory, group.fileName)
          }));
          const invalidTargets = targetPlans.filter((plan) => (
            fs.existsSync(plan.targetPath) && !fs.lstatSync(plan.targetPath).isFile()
          ));
          if (invalidTargets.length > 0) {
            return {
              proceed: false,
              result: {
                status: 'failed',
                message: '以下目标路径不是可覆盖的普通文件，请修改文件名后重试',
                detailLines: invalidTargets.map((plan) => plan.targetPath)
              }
            };
          }
          const conflicts = targetPlans.filter((plan) => fs.existsSync(plan.targetPath));
          if (conflicts.length > 0) {
            const overwriteChoice = await dialog.showMessageBox(mainWindow, {
              type: 'warning',
              buttons: ['返回', '覆盖全部'],
              defaultId: 0,
              cancelId: 0,
              noLink: true,
              title: '文件已存在',
              message: `有 ${conflicts.length} 个目标文件已存在，是否覆盖全部？`,
              detail: conflicts.map((plan) => plan.fileName).join('\n')
            });
            if (!overwriteChoice || overwriteChoice.response !== 1) {
              return { proceed: false, result: { status: 'cancelled' } };
            }
          }
          outputPaths = targetPlans.map((plan) => plan.targetPath);
          targetPlans = groups.map((group, index) => ({
            ...group,
            outputId: `split-${index + 1}`
          }));
        } else {
          const saveResult = await dialog.showSaveDialog(mainWindow, {
            defaultPath: toolboxBuildSplitFileName(values, sanitizeFileName),
            filters: [{ name: 'Excel', extensions: ['xlsx'] }]
          });
          if (saveResult.canceled || !saveResult.filePath) {
            return { proceed: false, result: { status: 'cancelled' } };
          }
          savePath = saveResult.filePath;
          outputPaths = [savePath];
        }
        assertToolboxTargetsDoNotAliasSources(
          [readContext.sourceFilePath],
          outputPaths
        );
        const prepared = {
          proceed: true,
          payload,
          readContext,
          field,
          values,
          targetPlans,
          rows
        };
        const inputFiles = Object.freeze([Object.freeze({
          filePath: readContext.sourceFilePath,
          role: 'input',
          sourceOperation: 'toolbox:split:export'
        })]);
        prepared.filePlan = rows ? rows.filePlan : {
          version: 1,
          allocation: 'eager',
          inputs: inputFiles,
          outputs: outputPaths.map((filePath) => ({
            filePath,
            role: 'output',
            sourceOperation: 'toolbox:split:export'
          }))
        };
        prepared.beforeStart = (_batchContext, planEvidence) => {
          const sourceEvidence = planEvidence.inputFiles[0];
          assertToolboxSplitSourceFresh(readContext, sourceEvidence);
          return {};
        };
        return prepared;
      } catch (error) {
        return { proceed: false, result: toolboxFailureResult(error) };
      }
    },
    async execute(_event, prepared, taskContext) {
      try {
        const {
          payload,
          readContext,
          field,
          values,
          targetPlans
        } = prepared;
        const sourceFilePath = taskContext.fileEvidence.inputFiles[0].filePath;
        const outputPaths = taskContext.fileEvidence.filePlan.outputs
          .map((item) => item.filePath);
        if (payload.mode === 'rows') {
          const tempDir = fs.mkdtempSync(path.join(prepared.rows.outputDirectory, '.toolbox-rows-'));
          let preserveTempDir = false;
          try {
            const generated = await generateValidateAndPublishRows({
              runtime: backgroundExecutionRuntimeManager.get(),
              filePlan: taskContext.fileEvidence.filePlan,
              batchContext: taskContext.batchContext,
              counts: prepared.rows.counts,
              privateDirectory: tempDir,
              metadataDirectory: app.getPath('userData'),
              publisher: (artifacts) => publishToolboxArtifacts(
                'split-rows', artifacts,
                taskContext.fileEvidence.filePlan.outputs.map((output) => ({
                  targetPath: output.filePath,
                  expectedTargetParentIdentity: output.targetParentIdentity
                })),
                taskContext.batchContext, {
                  protectedSourcePaths: [sourceFilePath],
                  targetSnapshots: taskContext.fileEvidence.targetSnapshots,
                  archiveInputFiles: taskContext.fileEvidence.inputFiles,
                  settleManifestArtifacts: taskContext.settleArtifacts,
                  fileEvidence: taskContext.fileEvidence
                }
              )
            });
            const publication = generated.publication;
            prepared.toolboxPublicationTaskIds = [publication.taskId];
            prepared.outputFiles = toolboxFinalOutputFiles(publication.files, 'toolbox:split:export');
            clearToolboxSplitReadContext(readContext);
            appendActivityLogEntry({
              level: 'info', source: 'main', domain: 'toolbox', message: '工具箱按行拆分成功',
              details: [
                `输入有效行数：${prepared.rows.counts.rowCount}`,
                `每份最多行数：${prepared.rows.counts.rowsPerFile}`,
                `输出文件数：${publication.files.length}`,
                ...buildToolboxAuditDetailLines(publication.files, generated.warningSummary),
                ...(publication.warnings || [])
              ]
            });
            return toolboxRowsPublicResult(prepared.rows.counts, publication.files,
              generated.warningSummary, publication.warnings || []);
          } catch (error) {
            preserveTempDir = shouldPreserveToolboxTemporaryFiles(error);
            if (error && ['RESOURCE_BUDGET_UNAVAILABLE', 'ADMISSION_TIMEOUT'].includes(error.code)) {
              try {
                appendActivityLogEntry({ level: 'error', source: 'main', domain: 'toolbox',
                  message: error.message, details: [`错误代码：${error.code}`, ...(error.detailLines || [])] });
              } catch (_logError) { /* 日志失败不覆盖原始准入错误。 */ }
            }
            throw error;
          } finally {
            if (!preserveTempDir) cleanupToolboxTemporaryDirectory(tempDir);
          }
        }
        if (payload.mode === 'multiple') {
          const outputDirectory = path.dirname(outputPaths[0]);
          const tempDir = fs.mkdtempSync(path.join(outputDirectory, '.toolbox-split-'));
          let preserveTempDir = false;
          try {
            const preparedPlans = targetPlans.map((plan, index) => ({
              ...plan,
              targetPath: outputPaths[index],
              temporaryPath: path.join(tempDir, `${String(index + 1).padStart(2, '0')}.xlsx`),
              matchedCount: 0
            }));

          let generationResult;
          let publishResult = null;
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
              })),
              batchContext: taskContext.batchContext
            }).promise;
          } else if (backgroundExecutionRuntimeManager.isProductionEnabled(
            TOOLBOX_GENERATION_ACTIONS.SPLIT_MULTI_OUTPUT
          )) {
            const generated = await generateValidateAndPublishMultiOutput({
              runtime: backgroundExecutionRuntimeManager.get(),
              filePlan: taskContext.fileEvidence.filePlan,
              batchContext: taskContext.batchContext,
              groups: preparedPlans,
              generationPaths: preparedPlans.map((plan) => plan.temporaryPath),
              routeDbPath: path.join(tempDir, 'route.sqlite'),
              routeManifestPath: path.join(tempDir, 'route.sealed.json'),
              production: true,
              publisher: (artifacts) => publishToolboxArtifacts(
                'split-multi',
                artifacts.map((artifact, index) => ({
                  sourcePath: artifact.generationPath,
                  outputId: artifact.outputId,
                  fileName: preparedPlans[index].fileName,
                  matchedCount: artifact.matchedCount,
                  byteSize: artifact.byteSize,
                  sha256: artifact.sha256,
                  dataRowCount: artifact.dataRowCount,
                  sheetCount: artifact.sheetCount,
                  warningSummary: artifact.warningSummary,
                  styleStats: artifact.styleStats
                })),
                preparedPlans.map((plan) => ({ targetPath: plan.targetPath })),
                taskContext.batchContext,
                {
                  protectedSourcePaths: [sourceFilePath],
                  targetSnapshots: taskContext.fileEvidence.targetSnapshots,
                  archiveInputFiles: taskContext.fileEvidence.inputFiles,
                  settleManifestArtifacts: taskContext.settleArtifacts,
                  fileEvidence: taskContext.fileEvidence
                }
              )
            });
            publishResult = generated.publication;
            generationResult = {
              files: generated.artifacts.map((artifact, index) => ({
                ...artifact,
                savePath: artifact.generationPath,
                fileName: preparedPlans[index].fileName
              })),
              inputDataRowCount: generated.summary.inputDataRowCount
            };
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

          if (!publishResult) {
            publishResult = await publishToolboxArtifacts(
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
              preparedPlans.map((plan) => ({ targetPath: plan.targetPath })),
              taskContext.batchContext,
              {
                protectedSourcePaths: [sourceFilePath],
                targetSnapshots: taskContext.fileEvidence.targetSnapshots,
                archiveInputFiles: taskContext.fileEvidence.inputFiles,
                settleManifestArtifacts: taskContext.settleArtifacts,
                fileEvidence: taskContext.fileEvidence
              }
            );
          }
          prepared.toolboxPublicationTaskIds = [publishResult.taskId];
          const files = publishResult.files;
          prepared.outputFiles = toolboxFinalOutputFiles(
            files,
            'toolbox:split:export'
          );
          clearToolboxSplitReadContext(readContext);
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
      // v3.0.9 T6：大文件（多 sheet / 单 worksheet 解压 ≥1.5GB 的 .xlsx）走隔离 worker 通道流式过滤写临时 xlsx，再另存为。
      //   fail-closed：路由 false 时落下方现有小文件分支（原样不动）。回传契约与现有分支逐字节一致：
      //   {status:'success',filePath} / {status:'cancelled'} / 0 命中沿用现文案 failed。
      //   🔴 修 B20：try/finally 可靠清 mkdtemp 临时目录（含 dispatch reject / worker crash；外层 catch→toolboxFailureResult 兜异常）。
      if (await shouldUseLargeChannel(sourceFilePath)) {
        const outputPath = outputPaths[0];
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'toolbox-large-'));
        const tempPath = path.join(tempDir, `toolbox-${Date.now()}.xlsx`);
        let preserveTempDir = false;
        try {
          const generationResult = await dispatchLargeSplit({
            op: 'exportFilter',
            filePath: sourceFilePath,
            field,
            values,
            savePath: tempPath,
            batchContext: taskContext.batchContext
          }).promise;
          const matchedCount = Number(generationResult && generationResult.matchedCount) || 0;
          const inputDataRowCount = Number(
            generationResult && generationResult.inputDataRowCount
          ) || 0;
          if (matchedCount === 0) {
            // 0 命中：不弹保存框、不产用户文件（保留现文案，与小文件分支逐字节一致）。临时目录由 finally 清理。
            return { status: 'failed', message: '所选值在源文件中无匹配行，未生成文件', detailLines: [] };
          }
          const publishResult = await publishToolboxArtifacts(
            'split-single-large',
            [{
              sourcePath: tempPath,
              outputId: 'split-1',
              fileName: path.basename(outputPath),
              matchedCount,
              byteSize: generationResult.byteSize,
              sha256: generationResult.sha256,
              dataRowCount: generationResult.dataRowCount,
              sheetCount: generationResult.sheetCount,
              warningSummary: generationResult.warningSummary || EMPTY_TOOLBOX_WARNING_SUMMARY,
              styleStats: generationResult.styleStats || null
            }],
            [{ targetPath: outputPath }],
            taskContext.batchContext,
            {
              protectedSourcePaths: [sourceFilePath],
              targetSnapshots: taskContext.fileEvidence.targetSnapshots,
              archiveInputFiles: taskContext.fileEvidence.inputFiles,
              settleManifestArtifacts: taskContext.settleArtifacts,
              fileEvidence: taskContext.fileEvidence
            }
          );
          prepared.toolboxPublicationTaskIds = [publishResult.taskId];
          const publishedFile = publishResult.files[0];
          prepared.outputFiles = toolboxFinalOutputFiles(
            publishResult.files,
            'toolbox:split:export'
          );
          clearToolboxSplitReadContext(readContext);
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
      const outputPath = outputPaths[0];
      const tempPath = path.join(generationDir, `toolbox-${Date.now()}.xlsx`);
      let preserveTempDir = false;
      try {
        const publishSplitArtifact = async (artifacts) => {
          const publication = await publishToolboxArtifacts(
            'split-single',
            artifacts,
            [{ targetPath: outputPath }],
            taskContext.batchContext,
            {
              protectedSourcePaths: [sourceFilePath],
              targetSnapshots: taskContext.fileEvidence.targetSnapshots,
              archiveInputFiles: taskContext.fileEvidence.inputFiles,
              settleManifestArtifacts: taskContext.settleArtifacts,
              fileEvidence: taskContext.fileEvidence
            }
          );
          return publication;
        };
        let matchedCount;
        let inputDataRowCount;
        let publishResult;
        if (backgroundExecutionRuntimeManager.isProductionEnabled(
          TOOLBOX_GENERATION_ACTIONS.SPLIT_SINGLE
        )) {
          const generated = await generateValidateAndPublishToolboxArtifact({
            runtime: backgroundExecutionRuntimeManager.get(),
            actionKey: TOOLBOX_GENERATION_ACTIONS.SPLIT_SINGLE,
            filePlan: taskContext.fileEvidence.filePlan,
            batchContext: taskContext.batchContext,
            generationPath: tempPath,
            operationConfig: { field, values },
            requireNonEmptySplit: true,
            production: true,
            publisher: (artifacts) => publishSplitArtifact(
              artifacts.map((artifact) => ({
                sourcePath: artifact.generationPath,
                outputId: artifact.outputId,
                fileName: path.basename(outputPath),
                matchedCount: artifact.matchedCount,
                byteSize: artifact.byteSize,
                sha256: artifact.sha256,
                dataRowCount: artifact.dataRowCount,
                sheetCount: artifact.sheetCount,
                warningSummary: artifact.warningSummary,
                styleStats: artifact.styleStats
              }))
            )
          });
          matchedCount = generated.artifact.matchedCount;
          inputDataRowCount = generated.summary.inputDataRowCount;
          publishResult = generated.publication;
        } else {
          const generationResult = await exportToolboxFilter({
            filePath: sourceFilePath,
            field,
            values,
            savePath: tempPath,
            outputId: 'split-1'
          });
          matchedCount = Number(generationResult.matchedCount) || 0;
          inputDataRowCount = Number(generationResult.inputDataRowCount) || 0;
          if (matchedCount === 0) {
            return {
              status: 'failed',
              message: '所选值在源文件中无匹配行，未生成文件',
              detailLines: []
            };
          }
          publishResult = await publishSplitArtifact([{
            sourcePath: tempPath,
            outputId: 'split-1',
            fileName: path.basename(outputPath),
            matchedCount,
            byteSize: generationResult.byteSize,
            sha256: generationResult.sha256,
            dataRowCount: generationResult.dataRowCount,
            sheetCount: generationResult.sheetCount,
            warningSummary: generationResult.warningSummary || EMPTY_TOOLBOX_WARNING_SUMMARY,
            styleStats: generationResult.styleStats || null
          }]);
        }
        prepared.toolboxPublicationTaskIds = [publishResult.taskId];
        const publishedFile = publishResult.files[0];
        prepared.outputFiles = toolboxFinalOutputFiles(
          publishResult.files,
          'toolbox:split:export'
        );
        clearToolboxSplitReadContext(readContext);
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

async function prepareVccImportArchiveHandoff(args, batchContext) {
  return buildVccImportArchiveHandoffFiles(args, batchContext);
}

async function settleVccOutputPublication(prepared, taskContext, publication, evidence) {
  prepared.vccOutputPublicationTaskIds.push(publication.taskId);
  const settled = await taskContext.settleArtifacts({
    files: taskContext.fileEvidence.filePlan.outputs.map((item, index) => ({
      artifactKey: item.artifactKey,
      expectedSha256: evidence[index].sha256,
      expectedSizeBytes: evidence[index].byteSize
    }))
  });
  if (!settled || settled.durable !== true) {
    throw new Error('VCC 输出 manifest artifact 尚未全部 durable');
  }
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

function reportPreparedResourceCleanupFailure({ originalError, cleanupError, enteredLifecycle }) {
  appendActivityLogEntry({
    level: 'error', source: 'main', domain: 'archive',
    message: '任务准备资源清理失败，保留资源等待诊断',
    details: [
      `已进入生命周期：${enteredLifecycle}`,
      `原错误：${originalError && originalError.code || ''} ${originalError && originalError.message || ''}`,
      `清理错误：${cleanupError && cleanupError.code || ''} ${cleanupError && cleanupError.message || ''}`
    ]
  });
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
    const policy = taskPolicyRegistry.get(meta.channel);
    if (!policy) throw new Error(`未登记 task policy：${meta.channel}`);
    if (policy.batchPolicy === 'exclude') {
      throw new Error(`受控业务 helper 不得执行 exclude policy：${meta.channel}`);
    }
    if (!['reserve', 'no-file'].includes(policy.batchPolicy)) {
      throw new Error(`不支持的 task batch policy：${meta.channel}`);
    }
    // 已知 Hold 在 picker/prepare 前拒绝；prepare 自身负责取消和失败时的资源。
    assertTaskPolicyNotHeld(policy, null);
    const prepared = await prepareIpcTaskInvocation(contract, event, args);
    if (!prepared.proceed) return prepared.result;
    const resourceScope = createPreparedResourceScope(prepared, {
      reportCleanupFailure: reportPreparedResourceCleanupFailure
    });
    // 登记的 Promise 包含第二 gate、初始化、adapter 构造及最终 abandon。
    return trackArchiveOperationPromise(resourceScope.run(async () => {
      dialogContext.phase = 'execute';
      assertTaskPolicyNotHeld(policy, prepared);
      const center = archiveCenterService || initializeArchiveCenter();
      if (!center || !archiveTaskLifecycle) {
        return {
          status: 'failed',
          code: 'ARCHIVE_TASK_LIFECYCLE_UNAVAILABLE',
          message: '存档中心无法预留任务批次，业务未开始'
        };
      }
      const effectiveArgs = prepared.args;
      const adapterInvocation = taskAdapterRegistry.resolve(policy.taskKey).createInvocation({
        meta, policy, prepared, args: effectiveArgs
      });
      const invocation = {
        args: effectiveArgs,
        prepared
      };
      const isFileTask = policy.batchPolicy !== 'no-file';
      const useLegacyExistingBatchRecovery = isFileTask && prepared.legacyExistingBatchRecovery === true;
      const runLifecycle = !isFileTask
        ? archiveTaskLifecycle.runOperationOnly.bind(archiveTaskLifecycle)
        : useLegacyExistingBatchRecovery
          ? archiveTaskLifecycle.run.bind(archiveTaskLifecycle)
          : policy.allocation === 'deferred'
            ? archiveTaskLifecycle.runDeferredFileTask.bind(archiveTaskLifecycle)
            : archiveTaskLifecycle.runFileTask.bind(archiveTaskLifecycle);
      const payload = {
        meta, policy, args: effectiveArgs, prepared,
        lineageIntents: prepared.lineageIntents,
        taskRunId: adapterInvocation.identity.taskRunId,
        operationKey: adapterInvocation.identity.operationKey,
        flowPlanResolver: prepared.flowPlan
          ? () => prepared.flowPlan
          : () => resolveTaskFlowPlan(policy, invocation),
        resultClassifier: policy.resultClassifier,
        resultMetadataResolver: typeof policy.resultMetadataResolver === 'function'
          ? (result, context, terminal) => policy.resultMetadataResolver(
              result, context, { ...terminal, invocation }
            )
          : null,
        resultFlowIdentities: typeof policy.resultFlowIdentities === 'function'
          ? (result, context) => policy.resultFlowIdentities(result, context, invocation)
          : null,
        beforeTerminalSettlement: adapterInvocation.beforeTerminalSettlement,
        afterTerminal: adapterInvocation.afterTerminal,
        afterTerminalIntent: adapterInvocation.afterTerminalIntent,
        beforeStart: async (context, filePlanEvidence) => {
          // 原第三 gate 必须先于任何领域 beforeStart 副作用。
          assertTaskPolicyNotHeld(policy, prepared);
          if (!isFileTask) {
            return typeof prepared.beforeStart === 'function' ? prepared.beforeStart(context) : {};
          }
          const preparedEvidence = typeof prepared.beforeStart === 'function'
            ? await prepared.beforeStart(context, filePlanEvidence)
            : null;
          if (!useLegacyExistingBatchRecovery) return preparedEvidence || {};
          return {
            ...(preparedEvidence || {}),
            sourceSnapshots: captureArchiveSourceSnapshots({
              args: [], result: null,
              selectedPaths: resolveOperationInputPaths({
                channel: meta.channel, args: effectiveArgs, prepared,
                selectedPaths: [], runtime: { inputPaths: prepared.inputPaths }
              }),
              runtime: {}
            })
          };
        },
        execute: async (context, controls) => {
          if (isFileTask) dialogContext.batchContext = context;
          const taskContext = createIpcTaskContext(context, controls);
          return adapterInvocation.execute({
            taskContext, controls,
            markExecuteStarted: resourceScope.markExecuteStarted,
            executeBusiness: () => runWithStatementConfirmedSourceSnapshots(
              meta.channel, taskContext,
              () => executeIpcTaskInvocation(contract, event, prepared, effectiveArgs, taskContext)
            )
          });
        }
      };
      if (isFileTask) Object.assign(payload, {
        filePlanResolver: !useLegacyExistingBatchRecovery
          ? ({ taskRun }) => policy.filePlanResolver({
              channel: meta.channel, args: effectiveArgs, prepared, taskRun
            })
          : null,
        selectedPathsResolver: useLegacyExistingBatchRecovery ? () => [] : null,
        recovery: prepared.recovery || undefined,
        explicitParentRunId: prepared.explicitParentRunId || undefined,
        runtimeResolver: null
      });
      resourceScope.enterLifecycle();
      return runLifecycle(payload);
    }));
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

// 完整初始化成功后才注册 IPC 并创建业务窗口。
function registerAllIpcHandlers() {
  return registerWithMemoryActivity(ipcMain, registerAllIpcHandlersWithMemoryActivity);
}

function registerAllIpcHandlersWithMemoryActivity() {
  registerWindowHandlers();
  registerAppHandlers();
  registerAppUpdateHandlers();
  registerArchiveCenterHandlers();
  registerTemplateResourceHandlers();
  registerBankAccountHandlers();
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

async function initializeBackgroundExecutionRecovery() {
  if (!database || !database.db) throw new Error('Recovery Coordinator 要求 Main control DB 已初始化');
  // v3.2.20：已下线模块（业务OP数据核对）留在恢复控制表中的 hold 只读跳过，不改写、不删除。
  recoveryControlReadRepository = withoutRetiredRecoveryRecords(
    createRecoveryControlReadRepository(database.db)
  );
  const inspectorRegistry = createInspectorRegistry();
  const providerRegistry = createSettlementRecoveryProviderRegistry();
  const inspectPreFundMpt = createPreFundMptOutcomeInspector({
    userDataDir: path.dirname(database.dbPath)
  });
  const inspectReconFixJpm = createReconFixJpmOutcomeInspector({
    databasePath: database.dbPath
  });
  for (const actionKey of Object.keys(PRE_FUND_MPT_STATIC_KEYS)) {
    inspectorRegistry.register(PRE_FUND_MPT_STATIC_KEYS[actionKey].inspector, inspectPreFundMpt);
  }
  inspectorRegistry.register(MANUAL_BALANCE_INSPECTOR_KEY, createManualBalanceSeedInspector({
    resolveTargetPath: (targetAliasKey) => resolveManualBalanceTargetAlias(
      getStorageRoot(),
      targetAliasKey
    ),
    readRepository: recoveryControlReadRepository
  }));
  providerRegistry.register(
    MANUAL_BALANCE_SETTLEMENT_KEY,
    createManualBalanceSettlementRecoveryProvider()
  );
  const duplicateRecoveryOptions = {
    userDataDir: path.dirname(database.dbPath),
    listRunMirrors: () => database.listDuplicateInboundMatchRunMirrors(),
    getRecoveryAuditBySource: (sourceRef) => (
      database.getDuplicateInboundMatchRecoveryAuditBySource(sourceRef)
    )
  };
  const inspectDuplicateRecovery = createDuplicateStartupOutcomeInspector(
    duplicateRecoveryOptions
  );
  inspectorRegistry.register(DUPLICATE_IMPORT_STARTUP_INSPECTOR_KEY, inspectDuplicateRecovery);
  inspectorRegistry.register(DUPLICATE_STARTUP_INSPECTOR_KEY, inspectDuplicateRecovery);
  providerRegistry.register(
    DUPLICATE_STARTUP_RECOVERY_KEY,
    createDuplicateStartupRecoveryProvider({
      ...duplicateRecoveryOptions,
      mainDatabase: database.db,
      getRecoveryAuditByOperation: (actionKey, operationKey, taskRunId) => (
        database.getDuplicateInboundMatchRecoveryAuditByOperation(
          actionKey, operationKey, taskRunId
        )
      ),
      inspectOperation: inspectDuplicateRecovery
    })
  );
  inspectorRegistry.register(RECON_FIX_JPM_POLICY.commit.inspectorKey, inspectReconFixJpm);

  inspectorRegistry.freeze();
  providerRegistry.freeze();

  const requestOwnerRepository = createRecoveryRequestOwnerRepository(database.db);
  const observationAttemptRepository = createRecoveryObservationAttemptRepository(database.db);
  const recoveryControlRepository = createRecoveryControlRepository(database.db);
  const manualBalancePlanTransitions = createManualBalanceRecoveryPlanTransitions(
    recoveryControlReadRepository
  );
  const resolveReconFixJpmTaskState = createReconFixJpmRecoveryTaskStateReader(database.db);
  const coordinator = createStartupRecoveryCoordinator({
    readRepository: recoveryControlReadRepository,
    inspectorRegistry,
    providerRegistry,
    requestOwnerRepository,
    observationAttemptRepository,
    recoveryControlRepository,
    resolvePolicy: (actionKey) => actionKey === MANUAL_BALANCE_ACTION_KEY
      ? manualBalanceRecoveryPolicy()
      : [...PRE_FUND_MPT_POLICIES, RECON_FIX_JPM_POLICY]
        .find((policy) => policy.actionKey === actionKey) || null,
    resolveTaskState: (source) => resolveReconFixJpmTaskState(source),
    planTransitions(input) {
      if (input && input.source && input.source.actionKey === MANUAL_BALANCE_ACTION_KEY) {
        return manualBalancePlanTransitions(input);
      }
      return [
        ...preFundMptRecoveryPlanTransitions(input),
        ...reconFixJpmRecoveryPlanTransitions(input)
      ];
    }
  });
  publicationRecoveryCoordinator = createPublicationRecoveryCoordinator({
    userDataDir: path.dirname(database.dbPath),
    dispatcher: getDefaultToolboxPublicationDispatcher(),
    acquireMemory: createPublicationMemoryAdmission(() => backgroundExecutionRuntimeManager.get()),
    owners: [
      createArchivePublicationOwner({ getArchiveCenter: () => archiveCenterService }),
      // v3.2.20：已下线的业务OP数据核对（BizOP v327）遗留发布记录只识别、原样保留给旧版，不阻断启动。
      createRetiredModulePublicationOwner()
    ]
  });
  publicationRecoveryCoordinator.bindDispatcherAuthority();
  applicationRecoveryCoordinator = createApplicationRecoveryComposition({
    platform: coordinator,
    recoverPreFundRuns: recoverPreFundRunsBeforeInterruptedSweep,
    recoverPosition: recoverPositionPendingBeforeInterruptedSweep,
    recoverToolboxVccPublications: recoverToolboxPublicationsAtStartup,
    recoverVccImportTerminal: recoverVccImportBeforeInterruptedSweep,
    reconcileVccImportLineage: reconcileVccImportArchiveBeforeRetentionCleanup
  });
  const preflight = await applicationRecoveryCoordinator.preflight();
  const summary = preflight.participantResults.find((entry) => entry.id === 'platform-scan').result;
  for (const hold of recoveryControlReadRepository.listActiveRecoveryHolds()) {
    const taskKeys = actionTaskBindingRegistry.allowedTaskKeys(hold.actionKey);
    if (!Array.isArray(taskKeys) || taskKeys.length === 0) {
      throw Object.assign(new Error(`Recovery Hold action 无法映射到生产 TaskPolicy：${hold.actionKey}`), {
        code: 'RECOVERY_HOLD_ACTION_UNBOUND'
      });
    }
  }
  recoveryHoldGate = createRecoveryHoldGate(recoveryControlReadRepository);
  preFundMptHoldGate = createPreFundMptHoldGate({
    readRepository: recoveryControlReadRepository,
    recoveryHoldGate
  });
  reconFixJpmHoldGate = createReconFixJpmHoldGate({
    recoveryHoldGate,
    readRepository: recoveryControlReadRepository
  });
  preFundMptWorkerDurableCoordinator = createPreFundMptWorkerDurableCoordinator({
    readRepository: recoveryControlReadRepository,
    requestOwnerRepository,
    recoveryControlRepository,
    recoveryCoordinator: coordinator,
    receiptAuthority: createPreFundMptReceiptAuthority({
      userDataDir: path.dirname(database.dbPath),
      outcomeInspector: inspectPreFundMpt
    }),
    conflictScopeGate: (identity) => preFundMptHoldGate.assertIdentities([identity])
  });
  const reconFixJpmWorkerDurableCoordinator = createReconFixJpmWorkerDurableCoordinator({
    readRepository: recoveryControlReadRepository,
    requestOwnerRepository,
    recoveryControlRepository,
    recoveryCoordinator: coordinator,
    receiptAuthority: createReconFixJpmReceiptAuthority({
      databasePath: database.dbPath,
      outcomeInspector: inspectReconFixJpm
    }),
    databaseIdentity: deriveReconFixJpmDatabaseIdentity(database.dbPath),
    conflictScopeGate: () => reconFixJpmHoldGate.assertMutationAllowed()
  });
  backgroundWorkerDurableCoordinator = createWorkerDurableCoordinatorRouter({
    ...Object.fromEntries(PRE_FUND_MPT_POLICIES.map((policy) => [
      policy.actionKey,
      preFundMptWorkerDurableCoordinator
    ])),
    [RECON_FIX_RUN_JPM_ACTION]: reconFixJpmWorkerDurableCoordinator
  });
  appendActivityLogEntry({
    level: 'info',
    source: 'main',
    domain: 'background-execution-recovery',
    message: '启动恢复扫描完成',
    details: [
      `sources=${summary.sourceCount}`,
      `activeHolds=${summary.activeHoldCount}`
    ]
  });
  return summary;
}

const PRE_FUND_SCOPED_HOLD_TASK_KEYS = new Set([
  'pre-fund-reconciliation:import-mpt',
  'pre-fund-reconciliation:mpt-errors:repair'
]);

function assertTaskPolicyNotHeld(policy, prepared = null) {
  if (!recoveryHoldGate || !recoveryControlReadRepository) {
    throw Object.assign(new Error('Recovery Hold gate 尚未初始化'), {
      code: 'RECOVERY_HOLD_GATE_UNAVAILABLE'
    });
  }
  if (PRE_FUND_SCOPED_HOLD_TASK_KEYS.has(policy.taskKey)) {
    // MPT必须在picker/header只读识别后按exact batch scope gate；首次picker前
    // 不得因同action下任意无关batch Hold而全局拒绝。
    if (prepared === null) return true;
    if (!preFundMptHoldGate || !Array.isArray(prepared.recoveryConflictScopeKeys)) {
      throw Object.assign(new Error('PreFund MPT exact Recovery Hold gate证据缺失'), {
        code: 'PREFUND_RECOVERY_SCOPE_UNAVAILABLE'
      });
    }
    for (const conflictScopeKey of prepared.recoveryConflictScopeKeys) {
      recoveryHoldGate.assertNoRecoveryHold({ conflictScopeKey });
    }
    return true;
  }
  for (const hold of recoveryControlReadRepository.listActiveRecoveryHolds()) {
    if (hold.actionKey === RECON_FIX_RUN_JPM_ACTION) continue;
    const taskKeys = actionTaskBindingRegistry.allowedTaskKeys(hold.actionKey);
    if (!Array.isArray(taskKeys) || taskKeys.length === 0) {
      throw Object.assign(new Error(`Recovery Hold action 无法映射到生产 TaskPolicy：${hold.actionKey}`), {
        code: 'RECOVERY_HOLD_ACTION_UNBOUND'
      });
    }
    if (taskKeys.includes(policy.taskKey)) {
      recoveryHoldGate.assertNoRecoveryHold({ conflictScopeKey: hold.conflictScopeKey });
    }
  }
}

async function initializeApplication() {
    const dataPath = path.join(app.getPath('userData'), 'tool-data.sqlite');
    // v3.2.14：主库此前不存在即全新安装，「更新说明」不弹出。
    const databaseExisted = fs.existsSync(dataPath);
    // v3.1.10：VCC copy-on-write 迁移恢复必须先于任何数据库连接。
    // setting 真相仍在主库；journal 只负责 prepared/switching/switched 崩溃窗口收口。
    recoverVccStorageMigration({ journalPath: vccStorageMigrationJournalPath() });
    database = new AppDatabase(dataPath);
    database.init({ onStartupPhase: recordStartupPhase });
    darkModeScheduler = createDarkModeScheduler({
      readSchedule: () => database.getDarkModeSchedule(),
      writeSchedule: (config) => database.setDarkModeSchedule(config),
      readLightness: () => database.getDarkModeLightness(),
      writeLightness: (lightness) => database.setDarkModeLightness(lightness),
      nativeTheme,
      getWindows: () => BrowserWindow.getAllWindows(),
      focusSource: app,
      powerMonitor,
      onChanged: (snapshot) => {
        for (const window of BrowserWindow.getAllWindows()) {
          if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
            window.webContents.send('settings:dark-mode-schedule-changed', snapshot);
          }
        }
      }
    });
    darkModeScheduler.start();
    markStartupMetric(STARTUP_METRIC_MARKS.databaseReady);
    // Recovery Contract startup boundary：任何 Archive owner recovery、cleanup 或业务 IPC
    // 之前冻结注册器并预检；平台全量扫描在预检阶段完成。
    try {
      await initializeBackgroundExecutionRecovery();
    } catch (error) {
      applicationRecoveryCoordinator?.failArchiveInitialization(error);
      throw error;
    }
    initializeAppUpdaterService();
    try {
      initializeArchiveCenter();
      // 唯一 Archive 初始化 Promise 完成后，由应用层确认平台扫描事实。
      const initialized = await archiveCenterInitializationPromise;
      applicationRecoveryCoordinator.completeArchiveInitialization(initialized);
    } catch (error) {
      applicationRecoveryCoordinator.failArchiveInitialization(error);
      throw error;
    }
    // Controller 会保留 owner 批次并继续扫尾其它孤儿；Toolbox 固定恢复根损坏
    // 仍沿用既有 fail-closed 启动合同，不能放行新的工具箱任务。
    if (toolboxStartupRecoveryError) throw toolboxStartupRecoveryError;
    // Toolbox committed publication 已作为 ArchiveCenter owner recovery 在通用
    // interrupted sweep 前写入“附件 + succeeded”耐久 outbox 并完成重放。
    // VCC lineage/hold 只由 Archive controller 的 post-outbox hook 执行一次。
    recoverToolboxScansAtStartup();
    // 结果侧库只服务上一进程的最后一次 run；即使模块默认关闭，也要在本次启动后台立即回收。
    schedulePreFundReconciliationStartupCleanup();

    // v2.0.0-beta.2 F4 / v2.1.15 W4：ui_style 收敛迁移 —— 老库存了 'General'/非法值就地迁移为 'Clear'，未写则 seed 'Clear'。
    //   General 风格已弃用，setUiStyle 写链路移除，APP_PREVIEW_STYLE 强制风格随之去除（风格恒 Clear）。
    database.ensureUiStyleDefault();

    // v2.0.0-beta.2 D16：风格-背景色联动（仅魔法值场景）
    ensureBackgroundColorMatchesStyle();

    // v3.2.14：更新说明只影响提示，判定失败不阻断启动。
    try {
      releaseNotesState = createReleaseNotesState({
        store: database,
        currentVersion: app.getVersion(),
        databaseExisted,
        log: ({ level, message, details }) => appendActivityLogEntry({ level, source: 'main', domain: 'release-notes', message, details })
      });
    } catch (error) {
      releaseNotesState = null;
      appendActivityLogEntry({
        level: 'warning',
        source: 'main',
        domain: 'release-notes',
        message: '更新说明判定失败，本次不弹出',
        details: [error && error.message ? error.message : String(error)]
      });
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

    await runStartupPhase('template-sync', async () => syncTemplateLibraryFile(), {
      onRecord: recordStartupPhase
    });
    markStartupMetric(STARTUP_METRIC_MARKS.templateLibrarySynced);

    runStartupPostSetup();
}

if (hasSingleInstanceLock) app.whenReady()
  .then(async () => {
    if (packagedRuntimeModeSelected) {
      let exitCode = 1;
      let errorCode = packagedRuntimeRequestError
        ? packagedRuntimeStartupErrorCode(packagedRuntimeRequestError)
        : null;
      try {
        if (packagedRuntimeRequestError) throw packagedRuntimeRequestError;
        const {
          runPackagedRuntimeCanary
        } = require('./main-process/background-execution/canary/packaged-runtime-runner');
        const result = await runPackagedRuntimeCanary({
          app,
          request: packagedRuntimeRequest
        });
        exitCode = result.exitCode;
        errorCode = result.errorCode;
      } catch (error) {
        errorCode = packagedRuntimeStartupErrorCode(error);
      }
      if (errorCode) {
        process.stderr.write(`BACKGROUND_EXECUTION_PACKAGED_CANARY_ERROR=${errorCode}\n`);
      }
      app.exit(exitCode);
      return;
    }
    let finishStartupTotal = null;
    try {
      finishStartupTotal = startStartupPhase('startup-total', recordStartupPhase);
      markStartupMetric(STARTUP_METRIC_MARKS.appReady);
      initializeActivityLog();

      // usage-stats 仍是非关键能力：统计初始化失败保留既有 default 降级，
      // 但整个尝试位于 startup-total 内，耗时和后续关键启动失败均不会漏记。
      try {
        usageStats = usageStatsModule.loadStats(ensureStorageRoot());
        usageStatsModule.recordSessionStart(usageStats);
        usageStatsDirty = true;
        flushUsageStats();
        usageStatsAutoFlushTimer = setInterval(flushUsageStats, USAGE_STATS_FLUSH_INTERVAL_MS);
      } catch (err) {
        try {
          appendActivityLogEntry({
            level: 'warning',
            source: 'main',
            domain: 'usage-stats',
            message: '[usage-stats] init failed',
            details: [err && err.message ? err.message : String(err)],
            stack: err && err.stack ? err.stack : undefined
          });
        } catch (_logErr) {
          // 非关键统计与其 warning 均不得阻断主启动 admission。
        }
        usageStats = usageStatsModule.defaultStats();
      }
      await runActionTaskBindingStartup();
      await createWindow({ instrumentation: 'initial' });
      applicationStartupComplete = true;
      scheduleAppUpdaterStartupCheck();
      finishStartupTotal('success');
      reportStartupMetrics();
      if (process.env.APP_STARTUP_MEASURE_AUTO_QUIT === '1') {
        setImmediate(() => app.quit());
      }
    } catch (error) {
      if (finishStartupTotal) finishStartupTotal('failed', { error });
      throw error;
    }
  })
  .catch((error) => {
    if (packagedRuntimeModeSelected) {
      try {
        process.stderr.write(
          `BACKGROUND_EXECUTION_PACKAGED_CANARY_ERROR=${packagedRuntimeStartupErrorCode(error)}\n`
        );
      } catch (_stderrError) {
        // 专用 canary 失败不得转入普通 startup failure/log/window 路径。
      }
      app.exit(1);
      return;
    }
    handleStartupFailure(error);
  });

// v3.0.5 PR-5：启动期后台 post-setup（孤儿清理 / 备份保留 / idle 计时器 / failure listener / OneDrive 提示）。
//   由 initializeApplication 末尾调用（database 已 init）。所有块 setImmediate 异步，不阻塞窗口。
function observeBackgroundMemoryActivity(work) {
  return function runObservedBackgroundWork(...args) {
    return runMemoryActivity(() => work(...args)).catch((error) => {
      appendActivityLogEntry({ level: 'warning', source: 'background-execution', message: '后台维护本次未完成',
        details: [error.code || 'BACKGROUND_MAINTENANCE_FAILED'] });
    });
  };
}

function runStartupPostSetup() {
    // v3.0.5 PR-2（Part B Phase 0 / B-D8）：旧备份保留策略 —— 合并 backups/ + 根目录旧格式为一个池子，
    //   mtime 降序保留最近 2 份，其余删除。启动后台异步（setImmediate，与上面 fix10 cleanup 同风格），
    //   不阻塞窗口 ready；逐个被删文件写一条 activity log（含文件名/大小/mtime），单文件删除失败不中断、记 error 级。
    //   ⚠️ 删用户数据动作（R-1）：白名单基于实际命名（tool-data-bak-*.sqlite / tool-data.sqlite.bak-*），
    //   绝不触碰主库本体（tool-data.sqlite / tool-data-pending.sqlite）及 -wal/-shm 旁文件，未知文件一律不动。
    setImmediate(observeBackgroundMemoryActivity(() => {
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
    }));

    // 空闲维护计时器：database init 完后启动；setInterval 2 分钟 tick。
    try {
      setupIdleCleanupTimer();
    } catch (err) {
      appendActivityLogEntry({
        level: 'error',
        source: 'main',
        domain: 'idle-maintenance',
        message: 'setupIdleCleanupTimer failed',
        details: [err && err.message ? err.message : String(err)],
        stack: err && err.stack ? err.stack : undefined
      });
    }

    // v3.0.3 PR-D（W5）：OneDrive 导出目录提示（启动后单次 toast）
    //   spec acquiring-import-recon-perf §9.4 — 仅 Windows + 工作目录命中 OneDrive 同步路径 + 未提示过 → 弹 Notification。
    //   setImmediate 异步不阻塞窗口 ready；失败仅静默兜底。
    setImmediate(observeBackgroundMemoryActivity(() => {
      notifyOneDriveStorageIfNeeded();
    }));

}

// v3.0.3 PR-D（W5）：OneDrive 导出目录提示（spec acquiring-import-recon-perf §9.4 / §二-W5）
//   触发链路：app.whenReady → createWindow 后 setImmediate 调用本函数（主窗口已可用）。
//   触发条件全 AND：
//     (1) 平台 win32 且 ensureStorageRoot() 路径命中 OneDrive（isStorageRootOnOneDrive 内含平台门控）
//     (2) 未提示过（防重 key win_onedrive_storage_notice_shown != '1'）
//   命中 → 弹 Electron Notification（OneDrive 同步会拖慢大文件导出/导入）→ 置防重 key（只提示一次）。
//   ⚠️ Notification.isSupported() 兜底（无 GUI 的 CI / SSH 头环境不弹）。
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

function setupIdleCleanupTimer() {
  if (idleCleanupTimer) return; // 重入保护
  idleCleanupTimer = setInterval(observeBackgroundMemoryActivity(async () => {
    // v3.2.18：先做链接表过期清理（自带空闲、间隔、任务与锁条件，结果已记日志），
    //   再判断是否整理主库（先删再整理，两者串行，不同时持租约）。
    //   v3.2.20：原收单单据币种校验的空闲清理随模块下线移除。
    try {
      await idleLinkedTableRetention.maybeRun();
    } catch (_retentionError) { /* 下次空闲再试 */ }
    // 空闲整理主库自带空闲、任务与磁盘条件，失败已记日志。
    try {
      await idleDatabaseCompaction.maybeRun();
    } catch (_compactionError) { /* 下次空闲再试 */ }
  }), IDLE_CHECK_INTERVAL_MS);
  if (idleCleanupTimer.unref) idleCleanupTimer.unref(); // 不阻塞退出
}

// v2.0.0-beta.4：退出前 flush usage-stats（before-quit 在窗口全关后触发）
let quitPreparationPromise = null;
let quitPreparationComplete = false;
let normalQuitInProgress = false;
let normalQuitContinuation = false;
let usageStatsSessionEnded = false;
let quitPreparationPreviousLastClosedAt = null;

async function shutdownBackgroundExecutionRuntimeGracefully() {
  const runtime = backgroundExecutionRuntimeManager.peek();
  const readOwner = runtime && toolboxSplitReadOwners.get(runtime);
  if (readOwner) {
    const closed = await readOwner.close();
    if (closed.unclosedCount > 0) throw Object.assign(new Error('拆分准备扫描尚未关闭'), { code: 'TOOLBOX_SPLIT_READ_CLOSE_UNCONFIRMED' });
    if (closed.cleanupPendingCount > 0) {
      const pending = readOwner.snapshot();
      if (pending.cleanupUnpersistedCount > 0) throw Object.assign(new Error('拆分扫描清理责任尚未保存，请重试退出'),
        { code: 'TOOLBOX_SPLIT_READ_CLEANUP_UNPERSISTED' });
      try { appendActivityLogEntry({ level: 'warning', source: 'main', domain: 'toolbox',
        message: '拆分扫描载体已退出，临时资源保留待下次启动重试清理',
        details: pending.cleanupFailures.map((item) => `${item.code || 'PENDING'}: ${item.message || '清理待重试'}`) });
      } catch (error) { console.warn('扫描补偿诊断写入日志失败，责任记录继续保留', error); }
    }
  }
  const report = await backgroundExecutionRuntimeManager.shutdown({ timeoutMs: 5000 });
  const leakedTransports = Array.isArray(report && report.leakedTransports)
    ? report.leakedTransports
    : [];
  const errors = Array.isArray(report && report.errors) ? report.errors : [];
  if (leakedTransports.length === 0 && errors.length === 0) return report;
  const error = new Error(
    `后台执行 runtime 关闭不完整：${leakedTransports.length} 个 transport，${errors.length} 个错误`
  );
  error.code = 'BACKGROUND_EXECUTION_SHUTDOWN_INCOMPLETE';
  error.detailLines = [
    ...leakedTransports.map((jobId) => `未关闭任务：${jobId}`),
    ...errors.map((item) => item && item.message ? item.message : String(item))
  ];
  throw error;
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

async function prepareApplicationForQuit(options = {}) {
  if (quitPreparationComplete) return;
  if (quitPreparationPromise) return quitPreparationPromise;

  const suppliedTransitionToken = options.transitionToken == null
    ? null
    : options.transitionToken;
  const suppliedTransitionOwner = String(options.transitionOwner || '');
  let acquiredTransitionToken = null;
  let backgroundRuntimeShutdownClean = false;
  quitPreparationPromise = (async () => {
    if (suppliedTransitionToken !== null) {
      if (suppliedTransitionOwner !== 'app-updater'
          || suppliedTransitionToken !== appUpdateTransitionToken) {
        const error = new Error('升级退出未持有匹配的 updater transition lease');
        error.code = 'APP_UPDATE_TRANSITION_TOKEN_MISMATCH';
        throw error;
      }
      acquiredTransitionToken = suppliedTransitionToken;
    } else {
      const transition = businessOperationRegistry.beginShutdownTransition('app-exit');
      if (!transition.acquired) {
        const error = new Error(`退出维护闸门正由 ${transition.owner || '其他维护任务'} 持有`);
        error.code = 'APP_SHUTDOWN_TRANSITION_BUSY';
        error.transitionOwner = transition.owner || '';
        throw error;
      }
      acquiredTransitionToken = transition.token;
    }
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

    await shutdownBackgroundExecutionRuntimeGracefully();
    backgroundRuntimeShutdownClean = true;

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

    if (positionReconciliationService) {
      positionTaskOwner.syncPositionReconciliationCheckpoint();
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
  })().catch((error) => {
    if (backgroundRuntimeShutdownClean) {
      backgroundExecutionRuntimeManager.resume();
    }
    throw error;
  }).finally(() => {
    if (!quitPreparationComplete) {
      if (acquiredTransitionToken !== null
          && acquiredTransitionToken === appUpdateTransitionToken) {
        releaseAppUpdateTransition();
      } else if (acquiredTransitionToken !== null) {
        businessOperationRegistry.releaseTransition(acquiredTransitionToken);
      }
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
  backgroundExecutionRuntimeManager.resume();

  if (!usageStatsAutoFlushTimer) {
    usageStatsAutoFlushTimer = setInterval(flushUsageStats, USAGE_STATS_FLUSH_INTERVAL_MS);
  }
  if (!idleCleanupTimer && database && database.db) setupIdleCleanupTimer();
}

if (!packagedRuntimeModeSelected) {
  app.on('before-quit', (event) => {
    // 空闲存储整理或链接表过期清理持有过渡租约；退出时先中止并等其收尾，再继续退出。
    if ((idleDatabaseCompaction.isRunning() || idleLinkedTableRetention.isRunning()) && !quitPreparationComplete) {
      event.preventDefault();
      Promise.all([
        idleLinkedTableRetention.stop('quit'),
        idleDatabaseCompaction.stop('quit')
      ]).then(() => app.quit());
      return;
    }
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

  app.on('will-quit', () => {
    if (darkModeScheduler) darkModeScheduler.stop();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  app.on('activate', () => {
    if (applicationStartupComplete && BrowserWindow.getAllWindows().length === 0) {
      createWindow({ instrumentation: 'supplemental' }).catch(handleStartupFailure);
    }
  });
}
