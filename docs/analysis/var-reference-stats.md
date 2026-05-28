# 代码库变量引用统计（自动生成）

> 由 `scripts/scan-vars.js` 自动生成，请不要手改。手工维护的重要变量清单在 `rules/important-variables.md`。

| 字段 | 值 |
|---|---|
| 版本 | v2.1.10-beta.1 |
| 扫描时间 | 2026-5-28 19:06:51 |
| 扫描目录 | `src/` |
| JS 文件数 | 94 |
| 顶层声明总数 | 1001 |
| ≥2 次引用 | 894 |
| 跨 ≥3 文件 (A-share) | 159 |
| 跨 2 文件 (A-pair) | 290 |
| 单文件 (A-local) | 445 |
| 跨文件合计 (B) | 449 |

---

## A-share — 跨 ≥3 文件共享

| 名字 | 跨度 | 总次数 | 声明数 | 声明位置（首个） |
|---|---:|---:|---:|---|
| `path` | 34 | 108 | 31 | src/backend/acquiring-bill-currency-import/reader.js |
| `fs` | 27 | 78 | 27 | src/backend/balance-adjustment-store.js |
| `parse` | 20 | 34 | 1 | src/backend/usage-stats.js |
| `normalizeCell` | 14 | 95 | 7 | src/backend/balance-adjustment-store.js |
| `FileValidationError` | 13 | 63 | 7 | src/backend/balance-seed-store.js |
| `appendModuleLog` | 11 | 46 | 7 | src/backend/database.js |
| `applyWatermark` | 11 | 27 | 11 | src/backend/file-service/writers.js |
| `pad` | 10 | 66 | 2 | src/backend/logger.js |
| `XLSX` | 10 | 60 | 10 | src/backend/bank-bu-recon-import/reader.js |
| `PENDING_COLUMNS` | 9 | 33 | 9 | src/backend/pending-db/migrations.js |
| `FLOW_HEADERS` | 8 | 25 | 4 | src/backend/acquiring-bill-currency-db/columns.js |
| `listMonths` | 7 | 18 | 4 | src/backend/acquiring-bill-currency-db/import-repository.js |
| `validateHeaders` | 6 | 17 | 2 | src/backend/pending-import/validator.js |
| `getRunById` | 6 | 10 | 3 | src/backend/acquiring-bill-currency-db/run-repository.js |
| `insertRun` | 6 | 9 | 3 | src/backend/acquiring-bill-currency-db/run-repository.js |
| `dialog` | 5 | 413 | 1 | src/main.js |
| `setCurrentModule` | 5 | 55 | 2 | src/backend/database/settings-repository.js |
| `normalizeCellValue` | 5 | 39 | 1 | src/main-process/scenario-engines/engine-utils.js |
| `parseNumericValue` | 5 | 26 | 2 | src/backend/balance-seed-store.js |
| `BANK_STATEMENT_FIELDS` | 5 | 19 | 4 | src/constants/bank-statement-fields.js |
| `ExcelJS` | 5 | 15 | 5 | src/main-process/acquiring-bill-currency-writer.js |
| `readRows` | 5 | 12 | 2 | src/backend/bank-account-import.js |
| `evaluateCondition` | 5 | 11 | 1 | src/main-process/scenario-engines/engine-utils.js |
| `runReconciliation` | 5 | 11 | 3 | src/backend/pending-reconcile/engine.js |
| `DatabaseSync` | 5 | 10 | 4 | src/backend/database.js |
| `makeWarningCollector` | 5 | 10 | 1 | src/main-process/scenario-engines/engine-utils.js |
| `formatTimestamp` | 5 | 9 | 5 | src/backend/database/backup.js |
| `saveMappings` | 5 | 9 | 1 | src/backend/database/template-repository.js |
| `deleteTemplate` | 5 | 7 | 1 | src/backend/database/template-repository.js |
| `state` | 4 | 266 | 1 | src/renderer.js |
| `elements` | 4 | 138 | 1 | src/renderer.js |
| `RUNS_TABLE` | 4 | 36 | 4 | src/backend/acquiring-bill-currency-db/run-repository.js |
| `FIXED_FIELD_VALUE_PREFIX` | 4 | 21 | 2 | src/backend/database/utils.js |
| `app` | 4 | 17 | 1 | src/main.js |
| `MERCHANT_ID_SELF_INPUT_OPTION` | 4 | 17 | 2 | src/main.js |
| `BALANCE_CALCULATED_OPTION` | 4 | 14 | 2 | src/main.js |
| `BILL_HEADERS` | 4 | 14 | 3 | src/backend/acquiring-bill-currency-db/columns.js |
| `TEMPLATE_BILL_HEADERS` | 4 | 13 | 2 | src/backend/acquiring-bill-currency-db/columns.js |
| `BIZ_OP_DB_COLUMNS` | 4 | 12 | 2 | src/backend/biz-op-recon-db/columns.js |
| `FLOW_DB_COLUMNS` | 4 | 12 | 2 | src/backend/biz-op-recon-db/columns.js |
| `isRowMeaningful` | 4 | 12 | 1 | src/backend/file-service/common.js |
| `ADVANCED_MAPPING_FIELDS` | 4 | 11 | 2 | src/main.js |
| `GATEWAY_RECON_FIELDS` | 4 | 11 | 3 | src/constants/gateway-recon-fields.js |
| `parseDateValue` | 4 | 11 | 1 | src/backend/file-service/normalizers.js |
| `BANK_DB_COLUMNS` | 4 | 10 | 1 | src/backend/bank-bu-recon-db/columns.js |
| `BIZ_OP_HEADERS` | 4 | 10 | 1 | src/backend/biz-op-recon-db/columns.js |
| `PENDING_GUANLI_DB_COLUMNS` | 4 | 10 | 1 | src/backend/bank-bu-recon-db/columns.js |
| `BANK_HEADERS` | 4 | 9 | 1 | src/backend/bank-bu-recon-db/columns.js |
| `getMonthMeta` | 4 | 9 | 2 | src/backend/bank-bu-recon-db/month-repository.js |
| `logger` | 4 | 9 | 3 | src/main-process/biz-op-recon-session.js |
| `PENDING_GUANLI_HEADERS` | 4 | 9 | 1 | src/backend/bank-bu-recon-db/columns.js |
| `validateFlowHeaders` | 4 | 9 | 3 | src/backend/acquiring-bill-currency-import/reader.js |
| `BUSINESS_BILL_FIELDS` | 4 | 8 | 2 | src/constants/recon-id-fix-fields.js |
| `cancel` | 4 | 8 | 1 | src/main-process/run-check-worker-pool.js |
| `CHANNEL_BILL_FIELDS` | 4 | 8 | 2 | src/constants/gateway-bill-recon-fields.js |
| `ensureRowId` | 4 | 8 | 1 | src/main-process/scenario-engines/engine-utils.js |
| `GATEWAY_BILL_FIELDS` | 4 | 8 | 2 | src/constants/gateway-bill-recon-fields.js |
| `listTemplates` | 4 | 8 | 1 | src/backend/database/template-repository.js |
| `makeModificationCollector` | 4 | 8 | 1 | src/main-process/scenario-engines/engine-utils.js |
| `OPPONENT_BILL_FIELDS` | 4 | 8 | 2 | src/constants/recon-id-fix-fields.js |
| `ORDER_REPAIR_FIELDS_GATEWAY` | 4 | 8 | 3 | src/constants/gateway-bill-recon-fields.js |
| `saveBillSplitAmountRules` | 4 | 8 | 1 | src/backend/database/template-repository.js |
| `saveBillSplitMeta` | 4 | 8 | 1 | src/backend/database/template-repository.js |
| `writeWorkbookRows` | 4 | 8 | 2 | src/backend/file-service.js |
| `errorCodeToCause` | 4 | 7 | 4 | src/backend/file-service/error-causes.js |
| `listAllRuns` | 4 | 7 | 1 | src/backend/pending-db/diff-repository.js |
| `setChildParent` | 4 | 7 | 1 | src/backend/database/template-repository.js |
| `writeBalanceWorkbook` | 4 | 7 | 2 | src/backend/file-service.js |
| `clearBillSplitMergeGroups` | 4 | 6 | 1 | src/backend/database/template-repository.js |
| `deleteBillSplitRow` | 4 | 6 | 1 | src/backend/database/template-repository.js |
| `extractHeaders` | 4 | 6 | 1 | src/backend/file-service/readers.js |
| `saveAmountSplitRules` | 4 | 6 | 1 | src/backend/database/template-repository.js |
| `saveBillSplitMappings` | 4 | 6 | 1 | src/backend/database/template-repository.js |
| `saveBillSplitMergeGroup` | 4 | 6 | 1 | src/backend/database/template-repository.js |
| `saveBillSplitRow` | 4 | 6 | 1 | src/backend/database/template-repository.js |
| `saveBillSplitRowCount` | 4 | 6 | 1 | src/backend/database/template-repository.js |
| `setParentStatus` | 4 | 6 | 1 | src/backend/database/template-repository.js |
| `splitTemplateName` | 4 | 6 | 2 | src/backend/database/own-accounts-migration.js |
| `batchDelete` | 4 | 5 | 1 | src/backend/database/scenarios-repository.js |
| `sanitizeFileName` | 4 | 4 | 4 | src/backend/balance-seed-store.js |
| `normalizeText` | 3 | 70 | 2 | src/backend/database/migrations.js |
| `setStatus` | 3 | 69 | 1 | src/renderer.js |
| `lastGeneratedExports` | 3 | 24 | 1 | src/main.js |
| `hasColumn` | 3 | 23 | 2 | src/backend/biz-op-recon-db/migrations.js |
| `runRepo` | 3 | 23 | 3 | src/main-process/acquiring-bill-currency-session.js |
| `pad2` | 3 | 21 | 3 | src/backend/usage-stats.js |
| `setSetting` | 3 | 20 | 1 | src/backend/database/settings-repository.js |
| `CONCAT_FIELDS_MAPPING_FIELD` | 3 | 17 | 2 | src/main.js |
| `BALANCE_DISABLED_OPTION` | 3 | 16 | 2 | src/main.js |
| `runRepository` | 3 | 16 | 3 | src/main-process/bank-bu-recon-session.js |
| `getSetting` | 3 | 14 | 1 | src/backend/database/settings-repository.js |
| `applyStatementResult` | 3 | 13 | 1 | src/renderer.js |
| `YELLOW_FILL` | 3 | 13 | 3 | src/main-process/bank-bu-recon-writer.js |
| `normalizeHeaderCell` | 3 | 11 | 3 | src/backend/acquiring-bill-currency-import/validator.js |
| `BANK_STATEMENT_FIELDS_FOR_C3` | 3 | 9 | 2 | src/constants/bank-statement-fields.js |
| `buildHeaderValidator` | 3 | 9 | 3 | src/backend/acquiring-bill-currency-import/validator.js |
| `inferDateCellFormat` | 3 | 9 | 1 | src/backend/file-service/normalizers.js |
| `parseJsonArray` | 3 | 9 | 2 | src/backend/database/utils.js |
| `toExcelSerial` | 3 | 9 | 1 | src/backend/file-service/normalizers.js |
| `AMOUNT_BASED_ACCOUNT_MAPPING_FIELD` | 3 | 8 | 2 | src/main.js |
| `AMOUNT_BASED_NAME_MAPPING_FIELD` | 3 | 8 | 2 | src/main.js |
| `AMOUNT_EPSILON` | 3 | 8 | 1 | src/backend/biz-op-recon-db/columns.js |
| `AMOUNT_SPLIT_BY_FIELD_ENABLED_OPTION` | 3 | 8 | 2 | src/main.js |
| `AMOUNT_SPLIT_BY_FIELD_MAPPING_FIELD` | 3 | 8 | 2 | src/main.js |
| `applyHeaderRowFont` | 3 | 8 | 3 | src/backend/file-service/writers.js |
| `BANK_STATEMENT_VIRTUAL_AMOUNT_ABS` | 3 | 8 | 3 | src/constants/bank-statement-fields.js |
| `cloneRowsWithMetadata` | 3 | 8 | 1 | src/main-process/statement-session.js |
| `getTemplateBigAccounts` | 3 | 8 | 1 | src/backend/database/template-repository.js |
| `main` | 3 | 8 | 2 | src/backend/pending-import/worker.js |
| `SIGNED_AMOUNT_MAPPING_FIELD` | 3 | 8 | 2 | src/main.js |
| `buildInsertSql` | 3 | 7 | 3 | src/backend/bank-bu-recon-db/month-repository.js |
| `createChannel` | 3 | 7 | 1 | src/backend/database/channels-repository.js |
| `createScenario` | 3 | 7 | 1 | src/backend/database/scenarios-repository.js |
| `getRowsByDateBu` | 3 | 7 | 2 | src/backend/biz-op-recon-db/flow-imports-repository.js |
| `listChannels` | 3 | 7 | 1 | src/backend/database/channels-repository.js |
| `normalizeInputFilePaths` | 3 | 7 | 1 | src/main-process/statement-session.js |
| `buildDateDir` | 3 | 6 | 3 | src/main-process/acquiring-bill-currency-writer.js |
| `clearMonth` | 3 | 6 | 2 | src/backend/acquiring-bill-currency-db/import-repository.js |
| `compileRegexLiteral` | 3 | 6 | 1 | src/backend/file-service/normalizers.js |
| `getAmountSplitRules` | 3 | 6 | 1 | src/backend/database/template-repository.js |
| `getUiStyle` | 3 | 6 | 1 | src/backend/database/settings-repository.js |
| `groupBigAccountRows` | 3 | 6 | 2 | src/backend/database/utils.js |
| `insertRows` | 3 | 6 | 2 | src/backend/biz-op-recon-db/flow-imports-repository.js |
| `isRegexLiteral` | 3 | 6 | 1 | src/backend/file-service/normalizers.js |
| `listRuns` | 3 | 6 | 1 | src/backend/bank-bu-recon-db/run-repository.js |
| `loadCurrencyMappings` | 3 | 6 | 2 | src/backend/file-service.js |
| `loadEnumValues` | 3 | 6 | 1 | src/backend/file-service/readers.js |
| `ORDER_REPAIR_FIELDS` | 3 | 6 | 2 | src/constants/recon-id-fix-fields.js |
| `readRowsWithMetadata` | 3 | 6 | 1 | src/backend/file-service/readers.js |
| `resolveSinglePreparedFieldValue` | 3 | 6 | 1 | src/main-process/statement-session.js |
| `runMigrations` | 3 | 6 | 3 | src/backend/pending-db.js |
| `SUPPORTED_EXTENSIONS` | 3 | 6 | 1 | src/backend/file-service/common.js |
| `valuesEqual` | 3 | 6 | 1 | src/main-process/scenario-engines/engine-utils.js |
| `writeDiffWorkbook` | 3 | 6 | 2 | src/main-process/acquiring-bill-currency-writer.js |
| `ALL_BANKS_TEMPLATE_SCOPE` | 3 | 5 | 2 | src/main-process/monthly-balance.js |
| `buildTimestamp` | 3 | 5 | 3 | src/main-process/acquiring-bill-currency-writer.js |
| `calculateEndingBalanceFromAmounts` | 3 | 5 | 1 | src/backend/file-service/normalizers.js |
| `exportAggregate` | 3 | 5 | 1 | src/backend/pending-export/writer.js |
| `getEnabledModules` | 3 | 5 | 1 | src/backend/database/settings-repository.js |
| `getLatestRun` | 3 | 5 | 2 | src/backend/acquiring-bill-currency-db/run-repository.js |
| `getRule` | 3 | 5 | 1 | src/backend/pending-db/rule-repository.js |
| `getStatementSessionEntries` | 3 | 5 | 1 | src/main-process/statement-session.js |
| `inferEndingBalance` | 3 | 5 | 1 | src/backend/file-service/normalizers.js |
| `mergeMappedDetailRows` | 3 | 5 | 1 | src/main-process/statement-session.js |
| `readBizOpFile` | 3 | 5 | 1 | src/backend/biz-op-recon-import/reader.js |
| `readFlowFile` | 3 | 5 | 1 | src/backend/biz-op-recon-import/reader.js |
| `setEnabledModules` | 3 | 5 | 1 | src/backend/database/settings-repository.js |
| `setReconIdFixBillCategory` | 3 | 5 | 1 | src/backend/database/settings-repository.js |
| `setUiStyle` | 3 | 5 | 1 | src/backend/database/settings-repository.js |
| `updateRunExportPath` | 3 | 5 | 2 | src/backend/bank-bu-recon-db/run-repository.js |
| `writeBizOpErrorReportXlsx` | 3 | 5 | 1 | src/main-process/biz-op-recon-writer.js |
| `writeFlowErrorReportXlsx` | 3 | 5 | 1 | src/main-process/biz-op-recon-writer.js |
| `findByNameAndLocation` | 3 | 4 | 1 | src/backend/database/channels-repository.js |
| `getBuiltinGeneral` | 3 | 4 | 1 | src/backend/database/channels-repository.js |
| `isEmptyValue` | 3 | 4 | 1 | src/main-process/scenario-engines/engine-utils.js |
| `sanitizeBankName` | 3 | 4 | 3 | src/backend/balance-adjustment-store.js |
| `writeErrorReport` | 3 | 4 | 1 | src/main-process/exceljs-writer.js |
| `buildTimestampMinute` | 3 | 3 | 2 | src/main-process/bank-statement-io.js |
| `createHash` | 3 | 3 | 1 | src/main.js |

## A-pair — 跨 2 文件

| 名字 | 总次数 | 声明位置（首个） |
|---|---:|---|
| `MODULES` | 68 | src/renderer.js |
| `activeJob` | 47 | src/main-process/run-check-worker-pool.js |
| `templateRepository` | 33 | src/backend/database.js |
| `settingsRepository` | 28 | src/backend/database.js |
| `emit` | 20 | src/backend/pending-import/worker.js |
| `TABLE` | 17 | src/backend/biz-op-recon-db/flow-imports-repository.js |
| `refreshBankStatementStatus` | 16 | src/renderer.js |
| `reloadReconIdFixScenarios` | 15 | src/renderer.js |
| `sanitizeAmountValue` | 14 | src/backend/file-service/normalizers.js |
| `DIFF_TABLE` | 13 | src/backend/acquiring-bill-currency-db/run-repository.js |
| `normalizeAccountKey` | 13 | src/main-process/biz-op-recon-session.js |
| `normalizeBu` | 13 | src/main-process/bank-bu-recon-session.js |
| `refreshTemplates` | 13 | src/renderer.js |
| `getCurrencyOptionEntries` | 12 | src/renderer.js |
| `importRepo` | 12 | src/backend/acquiring-bill-currency-import/reader.js |
| `parseAmount` | 12 | src/backend/biz-op-recon-import/validator.js |
| `BIZ_OP_ACCOUNT_KEY_DB_COLUMN` | 11 | src/backend/biz-op-recon-db/columns.js |
| `rendererPending` | 11 | src/renderer.js |
| `getTemplate` | 10 | src/backend/database/template-repository.js |
| `serializeError` | 10 | src/main-process/serialize-error.js |
| `channelsRepository` | 9 | src/backend/database.js |
| `diffRepo` | 9 | src/backend/pending-export/writer.js |
| `hasEffectiveAmount` | 9 | src/backend/file-service/normalizers.js |
| `ACQUIRING_BILL_CHUNK_SIZE_DEFAULT` | 8 | src/backend/database/migrations.js |
| `ACQUIRING_BILL_CHUNK_SIZE_KEY` | 8 | src/backend/database/migrations.js |
| `ACQUIRING_BILL_IDLE_CLEANUP_MINUTES_DEFAULT` | 8 | src/backend/database/migrations.js |
| `ACQUIRING_BILL_IDLE_CLEANUP_MINUTES_KEY` | 8 | src/backend/database/migrations.js |
| `ACQUIRING_BILL_RAW_JSON_RETENTION_DAYS_DEFAULT` | 8 | src/backend/database/migrations.js |
| `ACQUIRING_BILL_RAW_JSON_RETENTION_DAYS_KEY` | 8 | src/backend/database/migrations.js |
| `CancelError` | 8 | src/main-process/acquiring-bill-currency-session.js |
| `getChannelById` | 8 | src/backend/database/channels-repository.js |
| `importsRepository` | 8 | src/main-process/biz-op-recon-session.js |
| `monthRepo` | 8 | src/backend/pending-import/worker.js |
| `pkg` | 8 | src/main-process/acquiring-bill-currency-writer.js |
| `setNewAccountStatus` | 8 | src/renderer.js |
| `sheetToObjects` | 8 | src/main-process/bank-statement-io.js |
| `applyManualBalancePromptStatus` | 7 | src/renderer.js |
| `createBackup` | 7 | src/backend/database/backup.js |
| `FLOW_TABLE` | 7 | src/backend/acquiring-bill-currency-db/run-repository.js |
| `gatewayReconSession` | 7 | src/main.js |
| `getNewAccountStatusTitle` | 7 | src/renderer.js |
| `isNumericFieldName` | 7 | src/main-process/scenario-engines/c2-offset-bill-mark.js |
| `parseNumber` | 7 | src/main-process/scenario-engines/engine-utils.js |
| `roundAmount` | 7 | src/backend/file-service/normalizers.js |
| `setNewAccountExportAvailability` | 7 | src/renderer.js |
| `setRunChunkProgress` | 7 | src/backend/acquiring-bill-currency-db/run-repository.js |
| `syncNewAccountCurrencyMode` | 7 | src/renderer.js |
| `VALID_CATEGORIES` | 7 | src/backend/database/scenarios-repository.js |
| `BANK_DIFF_FIELD_DB_COLUMN` | 6 | src/backend/bank-bu-recon-db/columns.js |
| `bankStatementSession` | 6 | src/main.js |
| `bizOpRowToArray` | 6 | src/backend/biz-op-recon-db/columns.js |
| `buildFileReader` | 6 | src/backend/bank-bu-recon-import/reader.js |
| `buildRowMapper` | 6 | src/backend/bank-bu-recon-import/reader.js |
| `buildTemplateSummaryFromRow` | 6 | src/backend/database/utils.js |
| `ensureAccountMappingCurrencySupport` | 6 | src/backend/database/migrations.js |
| `ensureAccountMappingTemplateSupport` | 6 | src/backend/database/migrations.js |
| `ensureAcquiringBillChunkSizeSetting` | 6 | src/backend/database/migrations.js |
| `ensureAcquiringBillCurrencyRawJsonRetentionSettings` | 6 | src/backend/database/migrations.js |
| `ensureAcquiringBillCurrencyRunsChunkProgress` | 6 | src/backend/database/migrations.js |
| `ensureAcquiringBillCurrencyRunsCleanupPending` | 6 | src/backend/database/migrations.js |
| `ensureAcquiringBillCurrencyTablesSupport` | 6 | src/backend/database/migrations.js |
| `ensureAcquiringBillIdleCleanupMinutesSetting` | 6 | src/backend/database/migrations.js |
| `ensureAmountSplitRulesSupport` | 6 | src/backend/database/migrations.js |
| `ensureBankBuReconTablesSupport` | 6 | src/backend/database/migrations.js |
| `ensureBillRawJsonV2Slim` | 6 | src/backend/database/migrations.js |
| `ensureBillSplitMergeSupport` | 6 | src/backend/database/migrations.js |
| `ensureBillSplitTargetSeqSupport` | 6 | src/backend/database/migrations.js |
| `ensureBizOpReconTablesSupport` | 6 | src/backend/biz-op-recon-db/migrations.js |
| `ensureBuiltinScenarioNamesUpdate` | 6 | src/backend/database/migrations.js |
| `ensureC3AssignAddMode` | 6 | src/backend/database/migrations.js |
| `ensureC3GwFieldCurrencyCaseFix` | 6 | src/backend/database/migrations.js |
| `ensureDiffRowsCascadeMigration_v2_1_10` | 6 | src/backend/database/migrations.js |
| `ensureParentTemplateSupport` | 6 | src/backend/database/migrations.js |
| `ensureScenariosCategoryGatewayReconIdFix` | 6 | src/backend/database/migrations.js |
| `ensureScenariosCategoryReconIdFix` | 6 | src/backend/database/migrations.js |
| `ensureScenariosNameUniqueByChannelId` | 6 | src/backend/database/migrations.js |
| `ensureScenariosSupport` | 6 | src/backend/database/migrations.js |
| `ensureSchemaV2_1_9_N5` | 6 | src/backend/database/migrations.js |
| `ensureTemplateBigAccountNatureSupport` | 6 | src/backend/database/migrations.js |
| `ensureTemplateDateFormatSupport` | 6 | src/backend/database/migrations.js |
| `ensureTemplateFilenameFixedFieldSupport` | 6 | src/backend/database/migrations.js |
| `ensureTemplateKeySupport` | 6 | src/backend/database/migrations.js |
| `ensureTemplateMappingEnhancements` | 6 | src/backend/database/migrations.js |
| `extractMonthKey` | 6 | src/backend/acquiring-bill-currency-import/reader.js |
| `FILENAME_MAPPING_TEMPLATE_ID` | 6 | src/main.js |
| `getCurrencyOptionLabel` | 6 | src/renderer.js |
| `getRun` | 6 | src/backend/bank-bu-recon-db/run-repository.js |
| `matchAmountSplitConditionValue` | 6 | src/backend/file-service/normalizers.js |
| `migrateC4ReconGroupsAmountLockedFieldPair` | 6 | src/backend/database/migrations.js |
| `migrateC4ReconGroupsStructure` | 6 | src/backend/database/migrations.js |
| `migrateGatewayReconIdFixFieldPairs` | 6 | src/backend/database/migrations.js |
| `normalizeDateExportValue` | 6 | src/backend/file-service/normalizers.js |
| `PENDING_DIFF_FIELD_DB_COLUMN` | 6 | src/backend/bank-bu-recon-db/columns.js |
| `processingResult` | 6 | src/main.js |
| `sanitizeSheetName` | 6 | src/backend/pending-export/writer.js |
| `splitSignedAmountValue` | 6 | src/backend/file-service/normalizers.js |
| `SUPPORTED_SCENARIO_BUNDLE_VERSION` | 6 | src/backend/scenarios-bundle-io.js |
| `validateName` | 6 | src/backend/database/channels-repository.js |
| `WRITER_OUTPUT_HEADERS_V2` | 6 | src/backend/acquiring-bill-currency-db/columns.js |
| `BILL_KEY_COLUMN_INDICES` | 5 | src/backend/acquiring-bill-currency-db/columns.js |
| `BIZ_OP_END_BALANCE_DB_COLUMN` | 5 | src/backend/biz-op-recon-db/columns.js |
| `buildInfo` | 5 | src/main-process/acquiring-bill-currency-writer.js |
| `DIFF_HEADER_TAIL` | 5 | src/backend/biz-op-recon-db/columns.js |
| `DIFF_OUTPUT_BANK_SHEET` | 5 | src/backend/bank-bu-recon-db/columns.js |
| `DIFF_OUTPUT_PENDING_SHEET` | 5 | src/backend/bank-bu-recon-db/columns.js |
| `ensureSupportedFile` | 5 | src/backend/file-service/readers.js |
| `ERROR_HEADER_TAIL` | 5 | src/backend/biz-op-recon-db/columns.js |
| `FLOW_KEY_COLUMN_INDICES` | 5 | src/backend/acquiring-bill-currency-db/columns.js |
| `getBillSplitAmountRules` | 5 | src/backend/database/template-repository.js |
| `getBillSplitMappings` | 5 | src/backend/database/template-repository.js |
| `getBillSplitMeta` | 5 | src/backend/database/template-repository.js |
| `getBillSplitRows` | 5 | src/backend/database/template-repository.js |
| `getMonthReadiness` | 5 | src/backend/acquiring-bill-currency-db/import-repository.js |
| `getScenario` | 5 | src/backend/database/scenarios-repository.js |
| `getTemplateMappings` | 5 | src/backend/database/template-repository.js |
| `listDiffRows` | 5 | src/backend/pending-db/diff-repository.js |
| `normalizeBillDate` | 5 | src/backend/acquiring-bill-currency-db/import-repository.js |
| `performance` | 5 | src/main.js |
| `runC1Scenario` | 5 | src/main-process/scenario-engines/c1-extract-recon-id.js |
| `runC2Scenario` | 5 | src/main-process/scenario-engines/c2-offset-bill-mark.js |
| `runC3Scenario` | 5 | src/main-process/scenario-engines/c3-gateway-recon-join.js |
| `runScenario` | 5 | src/main-process/scenario-dispatcher.js |
| `setExportAvailability` | 5 | src/renderer.js |
| `setNewAccountOpenDateValue` | 5 | src/renderer.js |
| `statementImportSessions` | 5 | src/main.js |
| `subOneDay` | 5 | src/backend/biz-op-recon-db/run-repository.js |
| `updateNewAccountGenerateAvailability` | 5 | src/renderer.js |
| `VALID_DIRECTION_IN` | 5 | src/backend/biz-op-recon-import/validator.js |
| `VALID_DIRECTION_OUT` | 5 | src/backend/biz-op-recon-import/validator.js |
| `validateBillHeaders` | 5 | src/backend/acquiring-bill-currency-import/reader.js |
| `BANK_MATCH_KEY_DB_COLUMN` | 4 | src/backend/bank-bu-recon-db/columns.js |
| `buildMappedRows` | 4 | src/backend/file-service.js |
| `BUSINESS_BILL_SHEET_NAME` | 4 | src/constants/recon-id-fix-fields.js |
| `C4_CATEGORIES` | 4 | src/main-process/scenario-dispatcher.js |
| `CHANNEL_BILL_SHEET_NAME` | 4 | src/constants/gateway-bill-recon-fields.js |
| `clearRunsAndDiffsByDateBu` | 4 | src/backend/biz-op-recon-db/run-repository.js |
| `closeAllNewAccountCurrencyDropdowns` | 4 | src/renderer.js |
| `computeRowHash` | 4 | src/backend/pending-import/validator.js |
| `createBankBuReconSession` | 4 | src/main-process/bank-bu-recon-session.js |
| `createCancelToken` | 4 | src/main-process/acquiring-bill-currency-session.js |
| `createPendingSession` | 4 | src/main-process/pending-session.js |
| `crypto` | 4 | src/backend/pending-import/validator.js |
| `deleteChannel` | 4 | src/backend/database/channels-repository.js |
| `deleteScenario` | 4 | src/backend/database/scenarios-repository.js |
| `deserializeError` | 4 | src/main-process/serialize-error.js |
| `ensureUiStyleDefault` | 4 | src/backend/database/settings-repository.js |
| `extractEnumValuesFromImportedFile` | 4 | src/backend/file-service/readers.js |
| `FLOW_ACCOUNT_KEY_DB_COLUMN` | 4 | src/backend/biz-op-recon-db/columns.js |
| `FLOW_BU_FIELD_DB_COLUMN` | 4 | src/backend/biz-op-recon-db/columns.js |
| `FLOW_DIRECTION_DB_COLUMN` | 4 | src/backend/biz-op-recon-db/columns.js |
| `FLOW_RECON_AMOUNT_DB_COLUMN` | 4 | src/backend/biz-op-recon-db/columns.js |
| `flowRowToArray` | 4 | src/backend/biz-op-recon-db/columns.js |
| `GATEWAY_BILL_SHEET_NAME` | 4 | src/constants/gateway-bill-recon-fields.js |
| `getAcquiringBillChunkSize` | 4 | src/backend/database/settings-repository.js |
| `getAcquiringBillIdleCleanupMinutes` | 4 | src/backend/database/settings-repository.js |
| `getAcquiringBillRawJsonRetentionDays` | 4 | src/backend/database/settings-repository.js |
| `getBackgroundConfig` | 4 | src/backend/database/settings-repository.js |
| `getCurrencySuggestion` | 4 | src/renderer.js |
| `getCurrentModule` | 4 | src/backend/database/settings-repository.js |
| `getDiffRowsByRun` | 4 | src/backend/biz-op-recon-db/run-repository.js |
| `getEnumConfig` | 4 | src/backend/database/settings-repository.js |
| `getReconIdFixBillCategory` | 4 | src/backend/database/settings-repository.js |
| `getRowById` | 4 | src/backend/biz-op-recon-db/imports-repository.js |
| `getRunChunkProgress` | 4 | src/backend/acquiring-bill-currency-db/run-repository.js |
| `getTemplateByKey` | 4 | src/backend/database/template-repository.js |
| `getTemplateByName` | 4 | src/backend/database/template-repository.js |
| `importBillFile` | 4 | src/backend/acquiring-bill-currency-import/reader.js |
| `importFlowFile` | 4 | src/backend/acquiring-bill-currency-import/reader.js |
| `INSERT_SQL` | 4 | src/backend/biz-op-recon-db/flow-imports-repository.js |
| `isFilenameMappingMode` | 4 | src/main.js |
| `listAccountMappings` | 4 | src/backend/database/settings-repository.js |
| `listChildTemplates` | 4 | src/backend/database/template-repository.js |
| `listScenarios` | 4 | src/backend/database/scenarios-repository.js |
| `listTemplateBundleEntries` | 4 | src/backend/database/template-repository.js |
| `MERCHANT_ID_MULTI_ACCOUNT_MARKER` | 4 | src/backend/database/utils.js |
| `normalizeCurrencyOptionEntry` | 4 | src/renderer.js |
| `openModuleMenu` | 4 | src/renderer.js |
| `OPPONENT_BILL_SHEET_NAME` | 4 | src/constants/recon-id-fix-fields.js |
| `ORDER_REPAIR_SHEET_NAME` | 4 | src/constants/recon-id-fix-fields.js |
| `ORDER_REPAIR_SHEET_NAME_GATEWAY` | 4 | src/constants/gateway-bill-recon-fields.js |
| `PENDING_DB_FILENAME` | 4 | src/backend/pending-db.js |
| `PENDING_MATCH_KEY_DB_COLUMN` | 4 | src/backend/bank-bu-recon-db/columns.js |
| `randomUUID` | 4 | src/backend/database/migrations.js |
| `readSheetAsRows` | 4 | src/backend/bank-bu-recon-import/reader.js |
| `RECON_RESULT_FIELDS` | 4 | src/constants/recon-id-fix-fields.js |
| `RECON_RESULT_FIELDS_GATEWAY` | 4 | src/constants/gateway-bill-recon-fields.js |
| `RECON_RESULT_SHEET_NAME` | 4 | src/constants/recon-id-fix-fields.js |
| `RECON_RESULT_SHEET_NAME_GATEWAY` | 4 | src/constants/gateway-bill-recon-fields.js |
| `reconIdFixResult` | 4 | src/main.js |
| `reconIdFixSession` | 4 | src/main.js |
| `renameTemplate` | 4 | src/backend/database/template-repository.js |
| `resolveCurrencyValue` | 4 | src/backend/file-service/normalizers.js |
| `runC4Scenario` | 4 | src/main-process/recon-id-fix-engine.js |
| `runCheckCore` | 4 | src/main-process/acquiring-bill-currency-session.js |
| `saveAccountMappings` | 4 | src/backend/database/settings-repository.js |
| `saveTemplateFilenameFixedField` | 4 | src/backend/database/template-repository.js |
| `setAcquiringBillChunkSize` | 4 | src/backend/database/settings-repository.js |
| `setAcquiringBillIdleCleanupMinutes` | 4 | src/backend/database/settings-repository.js |
| `setAcquiringBillRawJsonRetentionDays` | 4 | src/backend/database/settings-repository.js |
| `setBackgroundConfig` | 4 | src/backend/database/settings-repository.js |
| `setEnumConfig` | 4 | src/backend/database/settings-repository.js |
| `toggleScenarioEnabled` | 4 | src/backend/database/scenarios-repository.js |
| `transferScenarios` | 4 | src/backend/database/scenarios-repository.js |
| `trimTrailingEmptyCells` | 4 | src/backend/file-service/common.js |
| `updateChannel` | 4 | src/backend/database/channels-repository.js |
| `updateScenario` | 4 | src/backend/database/scenarios-repository.js |
| `upsertTemplate` | 4 | src/backend/database/template-repository.js |
| `validateBankHeaders` | 4 | src/backend/bank-bu-recon-import/validator.js |
| `validateBizOpHeaders` | 4 | src/backend/biz-op-recon-import/validator.js |
| `validateBizOpRow` | 4 | src/backend/biz-op-recon-import/validator.js |
| `validateFlowRow` | 4 | src/backend/biz-op-recon-import/validator.js |
| `validatePendingGuanliHeaders` | 4 | src/backend/bank-bu-recon-import/validator.js |
| `writeStreamedXlsx` | 4 | src/backend/pending-import/streaming-xlsx-writer.js |
| `AppDatabase` | 3 | src/backend/database.js |
| `appendStatementSessionImport` | 3 | src/main-process/statement-session.js |
| `applyScenarioBundleImport` | 3 | src/main-process/scenarios-bundle-import.js |
| `assembleMonthlyBalance` | 3 | src/main-process/monthly-balance.js |
| `BIZ_OP_BU_FIELD_DB_COLUMN` | 3 | src/backend/biz-op-recon-db/columns.js |
| `buildDetailExportRows` | 3 | src/backend/file-service.js |
| `buildStatementFileEntry` | 3 | src/main-process/statement-session.js |
| `clearByDate` | 3 | src/backend/biz-op-recon-db/flow-imports-repository.js |
| `clearByDateBu` | 3 | src/backend/biz-op-recon-db/imports-repository.js |
| `clearRunsAndDiffsByDate` | 3 | src/backend/biz-op-recon-db/run-repository.js |
| `clearRunsByMonth` | 3 | src/backend/acquiring-bill-currency-db/run-repository.js |
| `clearStaleSuccessfulRawJson` | 3 | src/backend/acquiring-bill-currency-db/raw-json-retention.js |
| `computeRunStats` | 3 | src/backend/acquiring-bill-currency-db/run-repository.js |
| `countRowsInMonth` | 3 | src/backend/pending-db/month-repository.js |
| `createRowInserter` | 3 | src/backend/pending-db/month-repository.js |
| `createRun` | 3 | src/backend/pending-db/diff-repository.js |
| `createStatementGenerationHelpers` | 3 | src/main-process/statement-generation.js |
| `deleteMonth` | 3 | src/backend/pending-db/month-repository.js |
| `deleteMonthBySide` | 3 | src/backend/acquiring-bill-currency-db/import-repository.js |
| `detectBundleType` | 3 | src/backend/scenarios-bundle-io.js |
| `findByChannelAndName` | 3 | src/backend/database/scenarios-repository.js |
| `getBankRows` | 3 | src/backend/bank-bu-recon-db/month-repository.js |
| `getBillDateCounts` | 3 | src/backend/acquiring-bill-currency-db/run-repository.js |
| `getLatestRunForMonthPair` | 3 | src/backend/pending-db/diff-repository.js |
| `getOrCreateStatementImportSession` | 3 | src/main-process/statement-session.js |
| `getPendingRows` | 3 | src/backend/bank-bu-recon-db/month-repository.js |
| `getTemplatesByBankName` | 3 | src/backend/database/template-repository.js |
| `importMonthAtomic` | 3 | src/backend/bank-bu-recon-db/month-repository.js |
| `insertBillRow` | 3 | src/backend/acquiring-bill-currency-db/import-repository.js |
| `insertDiffRows` | 3 | src/backend/biz-op-recon-db/run-repository.js |
| `insertDiffRowsByJoinChunked` | 3 | src/backend/acquiring-bill-currency-db/run-repository.js |
| `insertFlowRow` | 3 | src/backend/acquiring-bill-currency-db/import-repository.js |
| `JSZip` | 3 | src/backend/pending-import/streaming-xlsx-reader.js |
| `listAllByChannelId` | 3 | src/backend/database/scenarios-repository.js |
| `listDiffRowsByDateRange` | 3 | src/backend/acquiring-bill-currency-db/run-repository.js |
| `listReadyDates` | 3 | src/backend/biz-op-recon-db/run-repository.js |
| `listRunsForMonthPair` | 3 | src/backend/pending-db/diff-repository.js |
| `listSuccessDates` | 3 | src/backend/biz-op-recon-db/run-repository.js |
| `listSuccessDatesInRange` | 3 | src/backend/biz-op-recon-db/run-repository.js |
| `markCleanupPending` | 3 | src/backend/acquiring-bill-currency-db/run-repository.js |
| `openBackgroundPalette` | 3 | src/renderer.js |
| `openPendingDb` | 3 | src/backend/pending-db.js |
| `parseBankAccountExcel` | 3 | src/backend/bank-account-import.js |
| `parseScenarioBundle` | 3 | src/backend/scenarios-bundle-io.js |
| `peekMonthKeyFromFile` | 3 | src/backend/acquiring-bill-currency-import/reader.js |
| `prepareBillInsert` | 3 | src/backend/acquiring-bill-currency-db/import-repository.js |
| `prepareFlowInsert` | 3 | src/backend/acquiring-bill-currency-db/import-repository.js |
| `readBankFile` | 3 | src/backend/bank-bu-recon-import/reader.js |
| `readBigAccountMode` | 3 | src/backend/big-account-mode-store.js |
| `readBigAccountOrder` | 3 | src/backend/big-account-order-store.js |
| `readPendingGuanliFile` | 3 | src/backend/bank-bu-recon-import/reader.js |
| `removeStatementSessionEntriesByFilePath` | 3 | src/main-process/statement-session.js |
| `reportStartupFailure` | 3 | src/backend/startup-failure.js |
| `runAllScenarios` | 3 | src/main-process/scenario-dispatcher.js |
| `runOwnAccountsMigration` | 3 | src/backend/database/own-accounts-migration.js |
| `runReconIdFix` | 3 | src/main-process/recon-id-fix-engine.js |
| `serializeScenarioBundle` | 3 | src/backend/scenarios-bundle-io.js |
| `toBalanceRows` | 3 | src/main-process/monthly-balance.js |
| `updateRunPaths` | 3 | src/backend/acquiring-bill-currency-db/run-repository.js |
| `updateRunStats` | 3 | src/backend/pending-db/diff-repository.js |
| `updateRunStatus` | 3 | src/backend/acquiring-bill-currency-db/run-repository.js |
| `upsertMonthMeta` | 3 | src/backend/pending-db/month-repository.js |
| `writeAggregateDiffWorkbook` | 3 | src/main-process/bank-bu-recon-writer.js |
| `writeBankStatementOutput` | 3 | src/main-process/exceljs-writer.js |
| `writeBigAccountMode` | 3 | src/backend/big-account-mode-store.js |
| `writeBigAccountOrder` | 3 | src/backend/big-account-order-store.js |
| `writeDateRangeDiffWorkbook` | 3 | src/main-process/biz-op-recon-writer.js |
| `writeRunOutputs` | 3 | src/main-process/acquiring-bill-currency-writer.js |
| `writeScenarioHitRows` | 3 | src/main-process/scenario-hit-rows-writer.js |
| `writeSingleDateDiffWorkbook` | 3 | src/main-process/biz-op-recon-writer.js |
| `BALANCE_SEED_GENERATION_METHODS` | 2 | src/backend/balance-seed-store.js |
| `readBankStatement` | 2 | src/main-process/bank-statement-io.js |
| `readGatewayRecon` | 2 | src/main-process/bank-statement-io.js |
| `readReconIdFixFile` | 2 | src/main-process/recon-id-fix-io.js |
| `runBizOpImportAsync` | 2 | src/main-process/biz-op-recon-session.js |
| `runFlowImportAsync` | 2 | src/main-process/biz-op-recon-session.js |
| `WINDOWS_RESERVED_NAMES` | 2 | src/main-process/bank-statement-io.js |

## A-local — 仅单文件（≥3 次引用部分）

按文件分组。仅保留 totalHits ≥ 3 的项。

### `src/backend/acquiring-bill-currency-db/columns.js`

| 名字 | 总次数 |
|---|---:|
| `BILL_KEY_COLUMNS` | 6 |
| `FLOW_KEY_COLUMNS` | 6 |
| `WRITER_OUTPUT_BILL_COPY_HEADER` | 4 |
| `WRITER_OUTPUT_FLOW_AMOUNT_ABS_HEADER` | 4 |
| `WRITER_OUTPUT_FLOW_CURRENCY_HEADER` | 4 |

### `src/backend/acquiring-bill-currency-db/import-repository.js`

| 名字 | 总次数 |
|---|---:|
| `normalizeCurrency` | 4 |
| `parseAmountAbs` | 3 |

### `src/backend/acquiring-bill-currency-db/raw-json-retention.js`

| 名字 | 总次数 |
|---|---:|
| `CLEAR_STALE_SQL` | 3 |

### `src/backend/acquiring-bill-currency-db/run-repository.js`

| 名字 | 总次数 |
|---|---:|
| `BILL_TABLE` | 12 |

### `src/backend/acquiring-bill-currency-import/reader.js`

| 名字 | 总次数 |
|---|---:|
| `ImportValidationError` | 15 |
| `MAX_COLLECTED_ERRORS` | 5 |
| `SHEET_ENTRY_NAME` | 5 |
| `loadSharedStrings` | 3 |
| `openZipWithEntries` | 3 |
| `sax` | 3 |
| `SHARED_STRINGS_ENTRY_NAME` | 3 |
| `streamImportOneFile` | 3 |
| `streamSheetRows` | 3 |

### `src/backend/bank-bu-recon-db/columns.js`

| 名字 | 总次数 |
|---|---:|
| `BANK_COLUMN_DEFS` | 5 |
| `PENDING_GUANLI_COLUMN_DEFS` | 5 |

### `src/backend/bank-bu-recon-db/month-repository.js`

| 名字 | 总次数 |
|---|---:|
| `BANK_TABLE` | 7 |
| `PENDING_TABLE` | 7 |
| `buildBatchInserterInTxn` | 3 |

### `src/backend/big-account-mode-store.js`

| 名字 | 总次数 |
|---|---:|
| `getModeFilePath` | 3 |

### `src/backend/big-account-order-store.js`

| 名字 | 总次数 |
|---|---:|
| `getOrderFilePath` | 3 |

### `src/backend/biz-op-recon-db/columns.js`

| 名字 | 总次数 |
|---|---:|
| `BIZ_OP_COLUMN_DEFS` | 5 |
| `FLOW_COLUMN_DEFS` | 5 |

### `src/backend/database.js`

| 名字 | 总次数 |
|---|---:|
| `scenariosRepository` | 11 |

### `src/backend/database/channels-repository.js`

| 名字 | 总次数 |
|---|---:|
| `rowToChannel` | 5 |
| `GENERAL_CHANNEL_ID` | 3 |
| `validateLocation` | 3 |

### `src/backend/database/migrations.js`

| 名字 | 总次数 |
|---|---:|
| `N4_CONT_2_DIFF_ROWS_TABLE` | 10 |
| `N4_CONT_2_DIFF_ROWS_TABLE_NEW` | 5 |
| `BILL_RAW_JSON_V2_MIGRATED_KEY` | 4 |
| `N4_CONT_2_DIFF_ROWS_CASCADE_MIGRATED_MARKER` | 4 |
| `N5_SCENARIOS_UNIQUE_MIGRATED_MARKER` | 4 |
| `ensureChannelsTable` | 3 |
| `ensureScenariosChannelIdColumn` | 3 |
| `N5_MIGRATED_MARKER` | 3 |
| `SCENARIOS_SEEDED_MARKER` | 3 |
| `writeN4Cont2Marker` | 3 |
| `writeUniqueMigratedMarker` | 3 |

### `src/backend/database/own-accounts-migration.js`

| 名字 | 总次数 |
|---|---:|
| `appendMigrationLog` | 8 |
| `MIGRATION_FLAG_KEY` | 5 |
| `getMigrationLogPath` | 3 |
| `MIGRATION_LOG_FILENAME` | 3 |

### `src/backend/database/scenarios-repository.js`

| 名字 | 总次数 |
|---|---:|
| `rowToDetail` | 7 |
| `hasChannelIdColumn` | 6 |
| `hasChannelIdColumnCache` | 5 |
| `isScenarioNameUniqueError` | 5 |
| `validateEnabled` | 4 |
| `calculateNextScenarioId` | 3 |
| `rowToListItem` | 3 |
| `serializeConfig` | 3 |
| `validatePriority` | 3 |

### `src/backend/database/settings-repository.js`

| 名字 | 总次数 |
|---|---:|
| `DEFAULT_ENABLED_MODULES` | 8 |
| `ALL_MODULE_IDS` | 6 |
| `ENABLED_MODULES_KEY` | 6 |
| `ACQUIRING_BILL_CHUNK_SIZE_MAX` | 5 |
| `ACQUIRING_BILL_CHUNK_SIZE_MIN` | 5 |
| `ACQUIRING_BILL_IDLE_CLEANUP_MINUTES_MAX` | 5 |
| `ACQUIRING_BILL_IDLE_CLEANUP_MINUTES_MIN` | 5 |
| `ACQUIRING_BILL_RAW_JSON_RETENTION_DAYS_MAX` | 5 |
| `ACQUIRING_BILL_RAW_JSON_RETENTION_DAYS_MIN` | 5 |
| `CURRENT_MODULE_VALID` | 4 |
| `RECON_ID_FIX_BILL_CATEGORY_KEY` | 4 |
| `RECON_ID_FIX_BILL_CATEGORY_VALID` | 4 |
| `UI_STYLE_KEY` | 4 |
| `UI_STYLE_VALID` | 4 |
| `CURRENT_MODULE_KEY` | 3 |
| `UI_STYLE_DEFAULT` | 3 |

### `src/backend/database/template-repository.js`

| 名字 | 总次数 |
|---|---:|
| `getTemplateFixedAssignments` | 3 |

### `src/backend/file-service/error-causes.js`

| 名字 | 总次数 |
|---|---:|
| `CAUSE_MAP` | 3 |

### `src/backend/file-service/normalizers.js`

| 名字 | 总次数 |
|---|---:|
| `buildNormalizedDateResult` | 21 |
| `buildDateObject` | 18 |
| `formatIsoDateValue` | 12 |
| `normalizeCurrencyAlias` | 5 |
| `extractCurrencyAliases` | 4 |
| `REGEX_LITERAL_PATTERN` | 3 |
| `roundAmountHighPrecision` | 3 |
| `sanitizeSignedAmountValue` | 3 |
| `stripDateTimeSuffix` | 3 |

### `src/backend/file-service/readers.js`

| 名字 | 总次数 |
|---|---:|
| `collectMatchedRows` | 3 |
| `readWorkbookRows` | 3 |

### `src/backend/file-service/writers.js`

| 名字 | 总次数 |
|---|---:|
| `applyBalanceFieldFormats` | 3 |
| `applyExportFieldFormats` | 3 |
| `buildNumericCellValue` | 3 |

### `src/backend/pending-db/diff-repository.js`

| 名字 | 总次数 |
|---|---:|
| `mapRun` | 5 |

### `src/backend/pending-db/rule-repository.js`

| 名字 | 总次数 |
|---|---:|
| `RULE_GLOBAL_ID` | 4 |

### `src/backend/pending-export/writer.js`

| 名字 | 总次数 |
|---|---:|
| `appendSheetWithHeaderFont` | 7 |
| `FUND_TYPE_COLUMN` | 7 |
| `buildSingleExportRow` | 6 |
| `buildExportRowsForDiff` | 5 |
| `buildHeaders` | 4 |
| `computeAmountDiff` | 4 |
| `computeChangedFields` | 3 |
| `getMetaColIndices` | 3 |
| `readPendingRow` | 3 |
| `SHEET_FUND_TYPE_DIFF_NAME` | 3 |
| `SHEET_SUMMARY_NAME` | 3 |

### `src/backend/pending-import/streaming-xlsx-writer.js`

| 名字 | 总次数 |
|---|---:|
| `XML_HEAD` | 6 |
| `buildRowXml` | 4 |
| `columnLetter` | 3 |
| `xmlEscape` | 3 |

### `src/backend/pending-reconcile/engine.js`

| 名字 | 总次数 |
|---|---:|
| `assertFieldsInPendingColumns` | 4 |
| `buildChangedClause` | 3 |
| `ensureMatchIndex` | 3 |
| `makeFieldIndexName` | 3 |

### `src/backend/scenarios-bundle-io.js`

| 名字 | 总次数 |
|---|---:|
| `MIN_SCENARIO_BUNDLE_VERSION` | 4 |

### `src/backend/startup-failure.js`

| 名字 | 总次数 |
|---|---:|
| `buildStartupFailureDialogMessage` | 3 |
| `normalizeErrorMessage` | 3 |

### `src/backend/usage-stats.js`

| 名字 | 总次数 |
|---|---:|
| `defaultStats` | 5 |
| `FUNCTION_REGISTRY` | 5 |
| `calcModuleSubtotal` | 4 |
| `nowIsoLocal` | 4 |
| `STATS_FILENAME` | 4 |
| `calcGrandTotal` | 3 |
| `serialize` | 3 |
| `STATS_TMP_FILENAME` | 3 |

### `src/main-process/acquiring-bill-currency-session.js`

| 名字 | 总次数 |
|---|---:|
| `safeRollback` | 10 |
| `safeBegin` | 7 |
| `importReader` | 6 |
| `nowIso` | 4 |
| `cleanupAfterRunBackground` | 3 |
| `importFilesInTransaction` | 3 |
| `importFilesWithOverwrite` | 3 |

### `src/main-process/acquiring-bill-currency-writer.js`

| 名字 | 总次数 |
|---|---:|
| `buildOutputDir` | 4 |
| `formatRanAtLocal` | 4 |
| `MAX_DATA_ROWS_PER_SHEET` | 4 |
| `fmtSheetName` | 3 |
| `planSegments` | 3 |

### `src/main-process/bank-bu-recon-session.js`

| 名字 | 总次数 |
|---|---:|
| `monthRepository` | 7 |
| `normalizeKey` | 5 |

### `src/main-process/bank-bu-recon-writer.js`

| 名字 | 总次数 |
|---|---:|
| `rowDbObjectToArray` | 5 |
| `ANOMALY_HEADERS` | 4 |
| `DIFF_OUTPUT_ANOMALY_SHEET` | 4 |
| `ANOMALY_HEADERS_AGGREGATE` | 3 |
| `anomalyRowToArray` | 3 |
| `buildOutputPath` | 3 |

### `src/main-process/bank-statement-io.js`

| 名字 | 总次数 |
|---|---:|
| `BANK_STATEMENT_SHEET_NAME` | 3 |
| `GATEWAY_RECON_SHEET_NAME` | 3 |

### `src/main-process/biz-op-recon-session.js`

| 名字 | 总次数 |
|---|---:|
| `flowImportsRepository` | 4 |

### `src/main-process/biz-op-recon-writer.js`

| 名字 | 总次数 |
|---|---:|
| `listDatesInRange` | 3 |
| `normalizeDateToISO` | 3 |

### `src/main-process/exceljs-writer.js`

| 名字 | 总次数 |
|---|---:|
| `buildSheetData` | 3 |

### `src/main-process/monthly-balance.js`

| 名字 | 总次数 |
|---|---:|
| `buildTargetLastDay` | 3 |
| `isRegularTemplate` | 3 |
| `lastDayOfMonth` | 3 |
| `pickLatestSeedForAccount` | 3 |

### `src/main-process/pending-session.js`

| 名字 | 总次数 |
|---|---:|
| `electronUtilityProcess` | 6 |
| `NODE_MAX_OLD_SPACE_MB` | 6 |
| `WORKER_SCRIPT` | 3 |

### `src/main-process/recon-id-fix-io.js`

| 名字 | 总次数 |
|---|---:|
| `readSheetOrThrow` | 5 |

### `src/main-process/run-check-worker-pool.js`

| 名字 | 总次数 |
|---|---:|
| `workerInstance` | 24 |
| `workerInitPromise` | 11 |
| `lastBusyEndTs` | 7 |
| `failureListener` | 5 |
| `workerDbPath` | 5 |
| `handleWorkerFailure` | 4 |
| `deserializeFromMessage` | 3 |
| `ensureInitialized` | 3 |
| `shutdown` | 3 |

### `src/main-process/run-check-worker.js`

| 名字 | 总次数 |
|---|---:|
| `parentPort` | 10 |
| `PRAGMA_EXPECTED` | 5 |
| `initWorkerDb` | 3 |
| `PRAGMA_STATEMENTS` | 3 |

### `src/main-process/scenario-dispatcher.js`

| 名字 | 总次数 |
|---|---:|
| `buildChannelKey` | 4 |
| `runChannelBatch` | 4 |
| `CHANNEL_FIELD_NAME` | 3 |
| `extractChannelLocation` | 3 |
| `extractChannelName` | 3 |
| `filterOutReconIdFix` | 3 |
| `filterScenariosByGwAvailability` | 3 |
| `groupScenariosByChannelId` | 3 |
| `LOCATION_FIELD_NAME` | 3 |
| `sortScenariosByPriority` | 3 |

### `src/main-process/scenario-engines/c1-extract-recon-id.js`

| 名字 | 总次数 |
|---|---:|
| `RECONCILIATION_ID_COLUMN` | 5 |
| `buildFeatureRegex` | 3 |

### `src/main-process/scenario-engines/c2-offset-bill-mark.js`

| 名字 | 总次数 |
|---|---:|
| `classifyRowsByBillTypes` | 3 |
| `pairsMatch` | 3 |

### `src/main-process/scenario-engines/c3-gateway-recon-join.js`

| 名字 | 总次数 |
|---|---:|
| `evalCondition` | 4 |
| `getBankRowValueForC3` | 4 |
| `gwMatchesBank` | 3 |

### `src/main-process/scenario-engines/c4-recon-id-fix.js`

| 名字 | 总次数 |
|---|---:|
| `buildOutputRow` | 17 |
| `resolveSubBizType` | 14 |
| `parseBillDateMs` | 10 |
| `billDateMatches` | 8 |
| `lookupReconId` | 8 |
| `toCents` | 8 |
| `computeCommonId` | 5 |
| `currencyMatches` | 5 |
| `findAmountLockedPair` | 5 |
| `parseRowIdxNum` | 5 |
| `rowsMatchFieldPairs` | 5 |
| `rowsMatchOtherFieldPairs` | 5 |
| `classifyRows` | 4 |
| `computeReferenceGateway` | 4 |
| `findBestAmountSubset` | 4 |
| `pickBestByTieBreak` | 4 |
| `tryManyToOnePool` | 4 |
| `tryOneToManyPool` | 4 |
| `tryOneToOne` | 4 |
| `apply1v1Assignment` | 3 |
| `collectUnmatchedRows` | 3 |
| `groupReconFields` | 3 |
| `normalizeBillDateValue` | 3 |
| `sortRightRowsForManyToOne` | 3 |

### `src/main-process/scenario-hit-rows-writer.js`

| 名字 | 总次数 |
|---|---:|
| `buildHitChannelLabel` | 3 |
| `buildHitScenarioLabel` | 3 |
| `buildOriginalBaseName` | 3 |
| `DEFAULT_REPORT_SUBDIR` | 3 |
| `normalizeChannelsToLabelMap` | 3 |
| `REPORT_SHEET_NAME` | 3 |
| `SUFFIX_HEADERS` | 3 |

### `src/main-process/serialize-error.js`

| 名字 | 总次数 |
|---|---:|
| `MAX_CAUSE_DEPTH` | 4 |
| `safeCloneContext` | 3 |

### `src/main-process/statement-session.js`

| 名字 | 总次数 |
|---|---:|
| `getStatementSessionKey` | 4 |
| `clearStatementExportCache` | 3 |
| `createStatementImportSession` | 3 |
| `pruneStatementImportSession` | 3 |

### `src/main-process/workbook-watermark.js`

| 名字 | 总次数 |
|---|---:|
| `WATERMARK_AUTHOR` | 4 |

### `src/main.js`

| 名字 | 总次数 |
|---|---:|
| `acquiringBillCurrencyOperationLock` | 9 |
| `database` | 5 |
| `startupMetrics` | 3 |

### `src/preload.js`

| 名字 | 总次数 |
|---|---:|
| `ipcRenderer` | 150 |
| `contextBridge` | 3 |

### `src/renderer.js`

| 名字 | 总次数 |
|---|---:|
| `getNewAccountRowElements` | 19 |
| `getNewAccountRows` | 19 |
| `cloneBackgroundSettings` | 12 |
| `getNewAccountRowState` | 12 |
| `rgbToCss` | 12 |
| `RENDERER_STARTUP_MARKS` | 11 |
| `getRendererStartupValue` | 10 |
| `isNewAccountMultiCurrencyMode` | 10 |
| `applyBackgroundSettings` | 8 |
| `clampColorChannel` | 8 |
| `handleNewAccountFormMutation` | 8 |
| `rendererStartupProfiler` | 8 |
| `closeNewAccountCurrencyDropdown` | 6 |
| `mixColor` | 6 |
| `STATEMENT_MODES` | 6 |
| `updateNewAccountCurrencyDropdownLabel` | 6 |
| `DEFAULT_BACKGROUND_SETTINGS` | 5 |
| `DEFAULT_SPECTRUM_PICK_COLOR` | 5 |
| `hexToRgb` | 5 |
| `renderNewAccountCurrencyOptions` | 5 |
| `syncNewAccountRowActionButtons` | 5 |
| `mixRgb` | 4 |
| `newAccountRowStateMap` | 4 |
| `normalizeColorHex` | 4 |
| `renderNewAccountCurrencyOptionsList` | 4 |
| `runBankStatementInternal` | 4 |
| `syncNewAccountDropdownFlag` | 4 |
| `updateBankStatementUi` | 4 |
| `updateNewAccountCurrencySuggestion` | 4 |
| `updateStatusBox` | 4 |
| `BACKGROUND_FILE_HINT` | 3 |
| `closeBackgroundPalette` | 3 |
| `getSpectrumColorAtPosition` | 3 |
| `handleBankStatementImportGatewayRecon` | 3 |
| `initializeNewAccountRow` | 3 |
| `lastUserActivityReportTs` | 3 |
| `refreshReconIdFixStatus` | 3 |
| `resetBackgroundPickerSelection` | 3 |
| `syncNewAccountOpenDateInputType` | 3 |
| `updateSelectedColorSwatch` | 3 |

## B — 跨文件引用完整表

| 名字 | 跨度 | 总次数 | 声明数 | 前三引用位置 |
|---|---:|---:|---:|---|
| `path` | 34 | 108 | 31 | src/main-process/scenario-engines/c4-recon-id-fix.js(15), src/backend/database/own-accounts-migration.js(6), src/main-process/pending-session.js(6) |
| `fs` | 27 | 78 | 27 | src/backend/usage-stats.js(9), src/backend/database/own-accounts-migration.js(6), src/backend/big-account-mode-store.js(5) |
| `parse` | 20 | 34 | 1 | src/backend/database/migrations.js(6), src/backend/database/settings-repository.js(3), src/backend/usage-stats.js(3) |
| `normalizeCell` | 14 | 95 | 7 | src/backend/file-service.js(34), src/backend/file-service/normalizers.js(12), src/backend/file-service/readers.js(12) |
| `FileValidationError` | 13 | 63 | 7 | src/backend/file-service/readers.js(15), src/backend/file-service/normalizers.js(7), src/main-process/bank-statement-io.js(7) |
| `appendModuleLog` | 11 | 46 | 7 | src/backend/database.js(19), src/main-process/acquiring-bill-currency-session.js(9), src/backend/database/migrations.js(3) |
| `applyWatermark` | 11 | 27 | 11 | src/main-process/biz-op-recon-writer.js(5), src/backend/file-service/writers.js(3), src/backend/pending-export/writer.js(3) |
| `pad` | 10 | 66 | 2 | src/main-process/bank-statement-io.js(14), src/backend/logger.js(11), src/main-process/biz-op-recon-session.js(10) |
| `XLSX` | 10 | 60 | 10 | src/backend/file-service/writers.js(20), src/main-process/pending-session.js(11), src/backend/pending-export/writer.js(9) |
| `PENDING_COLUMNS` | 9 | 33 | 9 | src/backend/pending-export/writer.js(6), src/backend/pending-import/validator.js(6), src/main-process/pending-session.js(6) |
| `FLOW_HEADERS` | 8 | 25 | 4 | src/backend/acquiring-bill-currency-db/columns.js(6), src/backend/acquiring-bill-currency-db/import-repository.js(6), src/backend/acquiring-bill-currency-import/reader.js(3) |
| `listMonths` | 7 | 18 | 4 | src/main-process/bank-bu-recon-session.js(4), src/main-process/acquiring-bill-currency-session.js(3), src/preload.js(3) |
| `validateHeaders` | 6 | 17 | 2 | src/backend/acquiring-bill-currency-import/reader.js(4), src/backend/bank-bu-recon-import/reader.js(4), src/backend/biz-op-recon-import/reader.js(4) |
| `getRunById` | 6 | 10 | 3 | src/backend/acquiring-bill-currency-db/run-repository.js(2), src/backend/biz-op-recon-db/run-repository.js(2), src/backend/pending-db/diff-repository.js(2) |
| `insertRun` | 6 | 9 | 3 | src/backend/acquiring-bill-currency-db/run-repository.js(2), src/backend/bank-bu-recon-db/run-repository.js(2), src/backend/biz-op-recon-db/run-repository.js(2) |
| `dialog` | 5 | 413 | 1 | src/renderer-dialogs.js(310), src/renderer.js(71), src/renderer-pending.js(26) |
| `setCurrentModule` | 5 | 55 | 2 | src/renderer-previews.js(47), src/renderer.js(3), src/backend/database.js(2) |
| `normalizeCellValue` | 5 | 39 | 1 | src/main-process/scenario-engines/c4-recon-id-fix.js(21), src/main-process/scenario-engines/engine-utils.js(6), src/main-process/scenario-engines/c1-extract-recon-id.js(4) |
| `parseNumericValue` | 5 | 26 | 2 | src/backend/file-service.js(14), src/backend/file-service/writers.js(6), src/backend/file-service/normalizers.js(4) |
| `BANK_STATEMENT_FIELDS` | 5 | 19 | 4 | src/renderer-dialogs.js(9), src/constants/bank-statement-fields.js(3), src/preload.js(3) |
| `ExcelJS` | 5 | 15 | 5 | src/main-process/biz-op-recon-writer.js(5), src/main-process/bank-bu-recon-writer.js(3), src/main-process/exceljs-writer.js(3) |
| `readRows` | 5 | 12 | 2 | src/backend/file-service/readers.js(4), src/backend/file-service.js(3), src/backend/bank-account-import.js(2) |
| `evaluateCondition` | 5 | 11 | 1 | src/main-process/scenario-engines/c3-gateway-recon-join.js(3), src/main-process/scenario-engines/c1-extract-recon-id.js(2), src/main-process/scenario-engines/c2-offset-bill-mark.js(2) |
| `runReconciliation` | 5 | 11 | 3 | src/main-process/bank-bu-recon-session.js(5), src/backend/pending-reconcile/engine.js(2), src/renderer-pending.js(2) |
| `DatabaseSync` | 5 | 10 | 4 | src/backend/database.js(2), src/backend/pending-db.js(2), src/backend/pending-import/worker.js(2) |
| `makeWarningCollector` | 5 | 10 | 1 | src/main-process/scenario-engines/c1-extract-recon-id.js(2), src/main-process/scenario-engines/c2-offset-bill-mark.js(2), src/main-process/scenario-engines/c3-gateway-recon-join.js(2) |
| `formatTimestamp` | 5 | 9 | 5 | src/backend/database/backup.js(2), src/main-process/bank-bu-recon-session.js(2), src/main-process/bank-bu-recon-writer.js(2) |
| `saveMappings` | 5 | 9 | 1 | src/renderer-dialogs.js(3), src/backend/database.js(2), src/backend/database/template-repository.js(2) |
| `deleteTemplate` | 5 | 7 | 1 | src/backend/database.js(2), src/backend/database/template-repository.js(2), src/preload.js(1) |
| `state` | 4 | 266 | 1 | src/renderer.js(143), src/renderer-pending.js(54), src/renderer-previews.js(41) |
| `elements` | 4 | 138 | 1 | src/renderer.js(90), src/renderer-previews.js(27), src/renderer-pending.js(17) |
| `RUNS_TABLE` | 4 | 36 | 4 | src/backend/acquiring-bill-currency-db/run-repository.js(15), src/backend/biz-op-recon-db/run-repository.js(11), src/backend/bank-bu-recon-db/run-repository.js(6) |
| `FIXED_FIELD_VALUE_PREFIX` | 4 | 21 | 2 | src/backend/file-service.js(13), src/backend/database/utils.js(5), src/backend/file-service/common.js(2) |
| `app` | 4 | 17 | 1 | src/renderer.js(8), src/main.js(4), src/renderer-dialogs.js(4) |
| `MERCHANT_ID_SELF_INPUT_OPTION` | 4 | 17 | 2 | src/renderer.js(8), src/renderer-dialogs.js(6), src/renderer-previews.js(2) |
| `BALANCE_CALCULATED_OPTION` | 4 | 14 | 2 | src/renderer-dialogs.js(5), src/renderer.js(5), src/renderer-previews.js(3) |
| `BILL_HEADERS` | 4 | 14 | 3 | src/backend/acquiring-bill-currency-db/columns.js(7), src/backend/acquiring-bill-currency-import/reader.js(3), src/backend/acquiring-bill-currency-db/import-repository.js(2) |
| `TEMPLATE_BILL_HEADERS` | 4 | 13 | 2 | src/main-process/acquiring-bill-currency-writer.js(6), src/backend/acquiring-bill-currency-db/columns.js(3), src/backend/acquiring-bill-currency-db/import-repository.js(2) |
| `BIZ_OP_DB_COLUMNS` | 4 | 12 | 2 | src/backend/biz-op-recon-db/columns.js(4), src/backend/biz-op-recon-db/imports-repository.js(4), src/backend/biz-op-recon-import/reader.js(2) |
| `FLOW_DB_COLUMNS` | 4 | 12 | 2 | src/backend/biz-op-recon-db/columns.js(4), src/backend/biz-op-recon-db/flow-imports-repository.js(4), src/backend/biz-op-recon-import/reader.js(2) |
| `isRowMeaningful` | 4 | 12 | 1 | src/backend/file-service/readers.js(6), src/backend/bank-bu-recon-import/reader.js(2), src/backend/biz-op-recon-import/reader.js(2) |
| `ADVANCED_MAPPING_FIELDS` | 4 | 11 | 2 | src/renderer-previews.js(4), src/renderer.js(4), src/renderer-dialogs.js(2) |
| `GATEWAY_RECON_FIELDS` | 4 | 11 | 3 | src/renderer-dialogs.js(5), src/constants/gateway-recon-fields.js(2), src/main-process/bank-statement-io.js(2) |
| `parseDateValue` | 4 | 11 | 1 | src/backend/file-service.js(4), src/backend/file-service/writers.js(4), src/backend/file-service/normalizers.js(2) |
| `BANK_DB_COLUMNS` | 4 | 10 | 1 | src/backend/bank-bu-recon-db/month-repository.js(3), src/main-process/bank-bu-recon-writer.js(3), src/backend/bank-bu-recon-db/columns.js(2) |
| `BIZ_OP_HEADERS` | 4 | 10 | 1 | src/main-process/biz-op-recon-writer.js(4), src/backend/biz-op-recon-db/columns.js(2), src/backend/biz-op-recon-import/reader.js(2) |
| `PENDING_GUANLI_DB_COLUMNS` | 4 | 10 | 1 | src/backend/bank-bu-recon-db/month-repository.js(3), src/main-process/bank-bu-recon-writer.js(3), src/backend/bank-bu-recon-db/columns.js(2) |
| `BANK_HEADERS` | 4 | 9 | 1 | src/main-process/bank-bu-recon-writer.js(3), src/backend/bank-bu-recon-db/columns.js(2), src/backend/bank-bu-recon-import/reader.js(2) |
| `getMonthMeta` | 4 | 9 | 2 | src/main-process/bank-bu-recon-session.js(3), src/backend/bank-bu-recon-db/month-repository.js(2), src/backend/pending-db/month-repository.js(2) |
| `logger` | 4 | 9 | 3 | src/main-process/run-check-worker.js(3), src/main-process/biz-op-recon-session.js(2), src/main-process/biz-op-recon-writer.js(2) |
| `PENDING_GUANLI_HEADERS` | 4 | 9 | 1 | src/main-process/bank-bu-recon-writer.js(3), src/backend/bank-bu-recon-db/columns.js(2), src/backend/bank-bu-recon-import/reader.js(2) |
| `validateFlowHeaders` | 4 | 9 | 3 | src/backend/acquiring-bill-currency-import/reader.js(3), src/backend/acquiring-bill-currency-import/validator.js(2), src/backend/biz-op-recon-import/reader.js(2) |
| `BUSINESS_BILL_FIELDS` | 4 | 8 | 2 | src/constants/recon-id-fix-fields.js(2), src/main-process/recon-id-fix-io.js(2), src/preload.js(2) |
| `cancel` | 4 | 8 | 1 | src/main-process/run-check-worker.js(3), src/main-process/run-check-worker-pool.js(2), src/renderer-dialogs.js(2) |
| `CHANNEL_BILL_FIELDS` | 4 | 8 | 2 | src/constants/gateway-bill-recon-fields.js(2), src/main-process/recon-id-fix-io.js(2), src/preload.js(2) |
| `ensureRowId` | 4 | 8 | 1 | src/main-process/scenario-engines/c1-extract-recon-id.js(2), src/main-process/scenario-engines/c2-offset-bill-mark.js(2), src/main-process/scenario-engines/c3-gateway-recon-join.js(2) |
| `GATEWAY_BILL_FIELDS` | 4 | 8 | 2 | src/constants/gateway-bill-recon-fields.js(2), src/main-process/recon-id-fix-io.js(2), src/preload.js(2) |
| `listTemplates` | 4 | 8 | 1 | src/backend/database/template-repository.js(3), src/backend/database.js(2), src/main-process/monthly-balance.js(2) |
| `makeModificationCollector` | 4 | 8 | 1 | src/main-process/scenario-engines/c1-extract-recon-id.js(2), src/main-process/scenario-engines/c2-offset-bill-mark.js(2), src/main-process/scenario-engines/c3-gateway-recon-join.js(2) |
| `OPPONENT_BILL_FIELDS` | 4 | 8 | 2 | src/constants/recon-id-fix-fields.js(2), src/main-process/recon-id-fix-io.js(2), src/preload.js(2) |
| `ORDER_REPAIR_FIELDS_GATEWAY` | 4 | 8 | 3 | src/constants/gateway-bill-recon-fields.js(2), src/main-process/recon-id-fix-io.js(2), src/main-process/scenario-engines/c4-recon-id-fix.js(2) |
| `saveBillSplitAmountRules` | 4 | 8 | 1 | src/renderer-dialogs.js(3), src/backend/database.js(2), src/backend/database/template-repository.js(2) |
| `saveBillSplitMeta` | 4 | 8 | 1 | src/renderer-dialogs.js(3), src/backend/database.js(2), src/backend/database/template-repository.js(2) |
| `writeWorkbookRows` | 4 | 8 | 2 | src/backend/file-service.js(4), src/backend/file-service/writers.js(2), src/main-process/statement-generation.js(1) |
| `errorCodeToCause` | 4 | 7 | 4 | src/backend/file-service/error-causes.js(2), src/main-process/exceljs-writer.js(2), src/main-process/pending-session.js(2) |
| `listAllRuns` | 4 | 7 | 1 | src/renderer-pending.js(3), src/backend/pending-db/diff-repository.js(2), src/backend/pending-export/writer.js(1) |
| `setChildParent` | 4 | 7 | 1 | src/backend/database.js(2), src/backend/database/template-repository.js(2), src/renderer-dialogs.js(2) |
| `writeBalanceWorkbook` | 4 | 7 | 2 | src/backend/file-service.js(3), src/backend/file-service/writers.js(2), src/main-process/statement-generation.js(1) |
| `clearBillSplitMergeGroups` | 4 | 6 | 1 | src/backend/database.js(2), src/backend/database/template-repository.js(2), src/preload.js(1) |
| `deleteBillSplitRow` | 4 | 6 | 1 | src/backend/database.js(2), src/backend/database/template-repository.js(2), src/preload.js(1) |
| `extractHeaders` | 4 | 6 | 1 | src/backend/file-service.js(2), src/backend/file-service/readers.js(2), src/main-process/statement-generation.js(1) |
| `saveAmountSplitRules` | 4 | 6 | 1 | src/backend/database.js(2), src/backend/database/template-repository.js(2), src/preload.js(1) |
| `saveBillSplitMappings` | 4 | 6 | 1 | src/backend/database.js(2), src/backend/database/template-repository.js(2), src/preload.js(1) |
| `saveBillSplitMergeGroup` | 4 | 6 | 1 | src/backend/database.js(2), src/backend/database/template-repository.js(2), src/preload.js(1) |
| `saveBillSplitRow` | 4 | 6 | 1 | src/backend/database.js(2), src/backend/database/template-repository.js(2), src/preload.js(1) |
| `saveBillSplitRowCount` | 4 | 6 | 1 | src/backend/database.js(2), src/backend/database/template-repository.js(2), src/preload.js(1) |
| `setParentStatus` | 4 | 6 | 1 | src/backend/database.js(2), src/backend/database/template-repository.js(2), src/preload.js(1) |
| `splitTemplateName` | 4 | 6 | 2 | src/backend/database/own-accounts-migration.js(2), src/main-process/monthly-balance.js(2), src/main-process/statement-generation.js(1) |
| `batchDelete` | 4 | 5 | 1 | src/backend/database/scenarios-repository.js(2), src/backend/database.js(1), src/preload.js(1) |
| `sanitizeFileName` | 4 | 4 | 4 | src/backend/balance-seed-store.js(1), src/main-process/bank-statement-io.js(1), src/main-process/recon-id-fix-io.js(1) |
| `normalizeText` | 3 | 70 | 2 | src/backend/database/template-repository.js(57), src/backend/database/utils.js(10), src/backend/database/migrations.js(3) |
| `setStatus` | 3 | 69 | 1 | src/renderer.js(36), src/renderer-dialogs.js(32), src/renderer-previews.js(1) |
| `lastGeneratedExports` | 3 | 24 | 1 | src/main-process/statement-generation.js(17), src/main-process/statement-session.js(6), src/main.js(1) |
| `hasColumn` | 3 | 23 | 2 | src/backend/database/migrations.js(18), src/backend/database.js(3), src/backend/biz-op-recon-db/migrations.js(2) |
| `runRepo` | 3 | 23 | 3 | src/main-process/acquiring-bill-currency-session.js(18), src/main-process/acquiring-bill-currency-writer.js(4), src/main.js(1) |
| `pad2` | 3 | 21 | 3 | src/main-process/acquiring-bill-currency-writer.js(11), src/backend/usage-stats.js(6), src/main-process/monthly-balance.js(4) |
| `setSetting` | 3 | 20 | 1 | src/backend/database/settings-repository.js(16), src/backend/database.js(2), src/backend/database/own-accounts-migration.js(2) |
| `CONCAT_FIELDS_MAPPING_FIELD` | 3 | 17 | 2 | src/renderer-dialogs.js(14), src/renderer.js(2), src/main.js(1) |
| `BALANCE_DISABLED_OPTION` | 3 | 16 | 2 | src/renderer-dialogs.js(9), src/renderer.js(6), src/main.js(1) |
| `runRepository` | 3 | 16 | 3 | src/main-process/bank-bu-recon-session.js(6), src/main-process/biz-op-recon-session.js(6), src/main-process/biz-op-recon-writer.js(4) |
| `getSetting` | 3 | 14 | 1 | src/backend/database/settings-repository.js(11), src/backend/database.js(2), src/backend/database/own-accounts-migration.js(1) |
| `applyStatementResult` | 3 | 13 | 1 | src/renderer.js(7), src/renderer-dialogs.js(5), src/renderer-previews.js(1) |
| `YELLOW_FILL` | 3 | 13 | 3 | src/main-process/bank-bu-recon-writer.js(6), src/main-process/biz-op-recon-writer.js(4), src/main-process/exceljs-writer.js(3) |
| `normalizeHeaderCell` | 3 | 11 | 3 | src/backend/bank-bu-recon-import/validator.js(4), src/backend/biz-op-recon-import/validator.js(4), src/backend/acquiring-bill-currency-import/validator.js(3) |
| `BANK_STATEMENT_FIELDS_FOR_C3` | 3 | 9 | 2 | src/renderer-dialogs.js(5), src/constants/bank-statement-fields.js(2), src/preload.js(2) |
| `buildHeaderValidator` | 3 | 9 | 3 | src/backend/acquiring-bill-currency-import/validator.js(3), src/backend/bank-bu-recon-import/validator.js(3), src/backend/biz-op-recon-import/validator.js(3) |
| `inferDateCellFormat` | 3 | 9 | 1 | src/backend/file-service/writers.js(4), src/backend/file-service.js(3), src/backend/file-service/normalizers.js(2) |
| `parseJsonArray` | 3 | 9 | 2 | src/backend/database/template-repository.js(3), src/backend/database/utils.js(3), src/backend/pending-db/rule-repository.js(3) |
| `toExcelSerial` | 3 | 9 | 1 | src/backend/file-service/writers.js(4), src/backend/file-service.js(3), src/backend/file-service/normalizers.js(2) |
| `AMOUNT_BASED_ACCOUNT_MAPPING_FIELD` | 3 | 8 | 2 | src/renderer-previews.js(3), src/renderer.js(3), src/main.js(2) |
| `AMOUNT_BASED_NAME_MAPPING_FIELD` | 3 | 8 | 2 | src/renderer-previews.js(3), src/renderer.js(3), src/main.js(2) |
| `AMOUNT_EPSILON` | 3 | 8 | 1 | src/backend/biz-op-recon-import/validator.js(4), src/backend/biz-op-recon-db/columns.js(2), src/main-process/biz-op-recon-session.js(2) |
| `AMOUNT_SPLIT_BY_FIELD_ENABLED_OPTION` | 3 | 8 | 2 | src/renderer-dialogs.js(5), src/renderer.js(2), src/main.js(1) |
| `AMOUNT_SPLIT_BY_FIELD_MAPPING_FIELD` | 3 | 8 | 2 | src/renderer-dialogs.js(3), src/renderer.js(3), src/main.js(2) |
| `applyHeaderRowFont` | 3 | 8 | 3 | src/backend/file-service/writers.js(3), src/main-process/pending-session.js(3), src/backend/pending-export/writer.js(2) |
| `BANK_STATEMENT_VIRTUAL_AMOUNT_ABS` | 3 | 8 | 3 | src/constants/bank-statement-fields.js(3), src/preload.js(3), src/main-process/scenario-engines/c3-gateway-recon-join.js(2) |
| `cloneRowsWithMetadata` | 3 | 8 | 1 | src/main-process/statement-session.js(5), src/main-process/statement-generation.js(2), src/main.js(1) |
| `getTemplateBigAccounts` | 3 | 8 | 1 | src/backend/database/template-repository.js(4), src/backend/database.js(2), src/main-process/monthly-balance.js(2) |
| `main` | 3 | 8 | 2 | src/renderer-dialogs.js(4), src/backend/pending-import/worker.js(2), src/main-process/pending-archive-worker.js(2) |
| `SIGNED_AMOUNT_MAPPING_FIELD` | 3 | 8 | 2 | src/renderer-previews.js(3), src/renderer.js(3), src/main.js(2) |
| `buildInsertSql` | 3 | 7 | 3 | src/backend/bank-bu-recon-db/month-repository.js(3), src/backend/biz-op-recon-db/flow-imports-repository.js(2), src/backend/biz-op-recon-db/imports-repository.js(2) |
| `createChannel` | 3 | 7 | 1 | src/main-process/scenarios-bundle-import.js(3), src/backend/database.js(2), src/backend/database/channels-repository.js(2) |
| `createScenario` | 3 | 7 | 1 | src/main-process/scenarios-bundle-import.js(3), src/backend/database.js(2), src/backend/database/scenarios-repository.js(2) |
| `getRowsByDateBu` | 3 | 7 | 2 | src/main-process/biz-op-recon-session.js(3), src/backend/biz-op-recon-db/flow-imports-repository.js(2), src/backend/biz-op-recon-db/imports-repository.js(2) |
| `listChannels` | 3 | 7 | 1 | src/main-process/scenarios-bundle-import.js(3), src/backend/database.js(2), src/backend/database/channels-repository.js(2) |
| `normalizeInputFilePaths` | 3 | 7 | 1 | src/main-process/statement-generation.js(4), src/main-process/statement-session.js(2), src/main.js(1) |
| `buildDateDir` | 3 | 6 | 3 | src/main-process/scenario-hit-rows-writer.js(3), src/main-process/acquiring-bill-currency-writer.js(2), src/main-process/bank-statement-io.js(1) |
| `clearMonth` | 3 | 6 | 2 | src/main-process/acquiring-bill-currency-session.js(3), src/backend/acquiring-bill-currency-db/import-repository.js(2), src/preload.js(1) |
| `compileRegexLiteral` | 3 | 6 | 1 | src/backend/file-service/normalizers.js(3), src/backend/file-service.js(2), src/main.js(1) |
| `getAmountSplitRules` | 3 | 6 | 1 | src/backend/database/template-repository.js(3), src/backend/database.js(2), src/preload.js(1) |
| `getUiStyle` | 3 | 6 | 1 | src/backend/database/settings-repository.js(3), src/backend/database.js(2), src/preload.js(1) |
| `groupBigAccountRows` | 3 | 6 | 2 | src/backend/database/template-repository.js(3), src/backend/database/utils.js(2), src/main.js(1) |
| `insertRows` | 3 | 6 | 2 | src/backend/biz-op-recon-db/flow-imports-repository.js(2), src/backend/biz-op-recon-db/imports-repository.js(2), src/main-process/biz-op-recon-session.js(2) |
| `isRegexLiteral` | 3 | 6 | 1 | src/backend/file-service/normalizers.js(3), src/backend/file-service.js(2), src/main.js(1) |
| `listRuns` | 3 | 6 | 1 | src/main-process/bank-bu-recon-session.js(3), src/backend/bank-bu-recon-db/run-repository.js(2), src/preload.js(1) |
| `loadCurrencyMappings` | 3 | 6 | 2 | src/backend/file-service.js(3), src/backend/file-service/normalizers.js(2), src/main.js(1) |
| `loadEnumValues` | 3 | 6 | 1 | src/backend/file-service/readers.js(3), src/backend/file-service.js(2), src/main.js(1) |
| `ORDER_REPAIR_FIELDS` | 3 | 6 | 2 | src/constants/recon-id-fix-fields.js(2), src/main-process/recon-id-fix-io.js(2), src/main-process/scenario-engines/c4-recon-id-fix.js(2) |
| `readRowsWithMetadata` | 3 | 6 | 1 | src/backend/file-service.js(3), src/backend/file-service/readers.js(2), src/main.js(1) |
| `resolveSinglePreparedFieldValue` | 3 | 6 | 1 | src/main-process/statement-generation.js(3), src/main-process/statement-session.js(2), src/main.js(1) |
| `runMigrations` | 3 | 6 | 3 | src/backend/pending-db.js(2), src/backend/pending-db/migrations.js(2), src/backend/pending-import/worker.js(2) |
| `SUPPORTED_EXTENSIONS` | 3 | 6 | 1 | src/backend/file-service.js(2), src/backend/file-service/common.js(2), src/backend/file-service/readers.js(2) |
| `valuesEqual` | 3 | 6 | 1 | src/main-process/scenario-engines/c2-offset-bill-mark.js(2), src/main-process/scenario-engines/c3-gateway-recon-join.js(2), src/main-process/scenario-engines/engine-utils.js(2) |
| `writeDiffWorkbook` | 3 | 6 | 2 | src/main-process/acquiring-bill-currency-writer.js(3), src/main-process/bank-bu-recon-writer.js(2), src/main.js(1) |
| `ALL_BANKS_TEMPLATE_SCOPE` | 3 | 5 | 2 | src/main-process/monthly-balance.js(3), src/main.js(1), src/renderer.js(1) |
| `buildTimestamp` | 3 | 5 | 3 | src/main-process/acquiring-bill-currency-writer.js(2), src/main-process/scenario-hit-rows-writer.js(2), src/main-process/bank-statement-io.js(1) |
| `calculateEndingBalanceFromAmounts` | 3 | 5 | 1 | src/backend/file-service.js(2), src/backend/file-service/normalizers.js(2), src/main.js(1) |
| `exportAggregate` | 3 | 5 | 1 | src/backend/pending-export/writer.js(2), src/preload.js(2), src/renderer-pending.js(1) |
| `getEnabledModules` | 3 | 5 | 1 | src/backend/database.js(2), src/backend/database/settings-repository.js(2), src/preload.js(1) |
| `getLatestRun` | 3 | 5 | 2 | src/backend/acquiring-bill-currency-db/run-repository.js(2), src/backend/bank-bu-recon-db/run-repository.js(2), src/main-process/acquiring-bill-currency-session.js(1) |
| `getRule` | 3 | 5 | 1 | src/backend/pending-db/rule-repository.js(2), src/renderer-pending.js(2), src/preload.js(1) |
| `getStatementSessionEntries` | 3 | 5 | 1 | src/main-process/statement-generation.js(2), src/main-process/statement-session.js(2), src/main.js(1) |
| `inferEndingBalance` | 3 | 5 | 1 | src/backend/file-service.js(2), src/backend/file-service/normalizers.js(2), src/main.js(1) |
| `mergeMappedDetailRows` | 3 | 5 | 1 | src/main-process/statement-generation.js(2), src/main-process/statement-session.js(2), src/main.js(1) |
| `readBizOpFile` | 3 | 5 | 1 | src/backend/biz-op-recon-import/reader.js(2), src/main-process/biz-op-recon-session.js(2), src/main.js(1) |
| `readFlowFile` | 3 | 5 | 1 | src/backend/biz-op-recon-import/reader.js(2), src/main-process/biz-op-recon-session.js(2), src/main.js(1) |
| `setEnabledModules` | 3 | 5 | 1 | src/backend/database.js(2), src/backend/database/settings-repository.js(2), src/preload.js(1) |
| `setReconIdFixBillCategory` | 3 | 5 | 1 | src/backend/database.js(2), src/backend/database/settings-repository.js(2), src/preload.js(1) |
| `setUiStyle` | 3 | 5 | 1 | src/backend/database.js(2), src/backend/database/settings-repository.js(2), src/preload.js(1) |
| `updateRunExportPath` | 3 | 5 | 2 | src/backend/bank-bu-recon-db/run-repository.js(2), src/backend/biz-op-recon-db/run-repository.js(2), src/main-process/bank-bu-recon-session.js(1) |
| `writeBizOpErrorReportXlsx` | 3 | 5 | 1 | src/main-process/biz-op-recon-session.js(2), src/main-process/biz-op-recon-writer.js(2), src/main.js(1) |
| `writeFlowErrorReportXlsx` | 3 | 5 | 1 | src/main-process/biz-op-recon-session.js(2), src/main-process/biz-op-recon-writer.js(2), src/main.js(1) |
| `findByNameAndLocation` | 3 | 4 | 1 | src/backend/database/channels-repository.js(2), src/backend/database.js(1), src/main-process/scenario-dispatcher.js(1) |
| `getBuiltinGeneral` | 3 | 4 | 1 | src/backend/database/channels-repository.js(2), src/backend/database.js(1), src/main-process/scenario-dispatcher.js(1) |
| `isEmptyValue` | 3 | 4 | 1 | src/main-process/scenario-engines/engine-utils.js(2), src/main-process/scenario-engines/c1-extract-recon-id.js(1), src/main-process/scenario-engines/c3-gateway-recon-join.js(1) |
| `sanitizeBankName` | 3 | 4 | 3 | src/backend/database/own-accounts-migration.js(2), src/backend/balance-adjustment-store.js(1), src/backend/own-account-store.js(1) |
| `writeErrorReport` | 3 | 4 | 1 | src/main-process/exceljs-writer.js(2), src/main-process/bank-statement-io.js(1), src/main.js(1) |
| `buildTimestampMinute` | 3 | 3 | 2 | src/main-process/bank-statement-io.js(1), src/main-process/recon-id-fix-io.js(1), src/main.js(1) |
| `createHash` | 3 | 3 | 1 | src/backend/pending-import/validator.js(1), src/backend/pending-reconcile/engine.js(1), src/main.js(1) |
| `MODULES` | 2 | 68 | 1 | src/renderer-previews.js(48), src/renderer.js(20) |
| `activeJob` | 2 | 47 | 1 | src/main-process/run-check-worker-pool.js(37), src/main-process/run-check-worker.js(10) |
| `templateRepository` | 2 | 33 | 2 | src/backend/database.js(30), src/backend/database/own-accounts-migration.js(3) |
| `settingsRepository` | 2 | 28 | 2 | src/backend/database.js(24), src/backend/database/own-accounts-migration.js(4) |
| `emit` | 2 | 20 | 2 | src/backend/pending-import/worker.js(10), src/main-process/pending-archive-worker.js(10) |
| `TABLE` | 2 | 17 | 2 | src/backend/biz-op-recon-db/imports-repository.js(10), src/backend/biz-op-recon-db/flow-imports-repository.js(7) |
| `refreshBankStatementStatus` | 2 | 16 | 1 | src/renderer-dialogs.js(9), src/renderer.js(7) |
| `reloadReconIdFixScenarios` | 2 | 15 | 1 | src/renderer-dialogs.js(11), src/renderer.js(4) |
| `sanitizeAmountValue` | 2 | 14 | 1 | src/backend/file-service.js(11), src/backend/file-service/normalizers.js(3) |
| `DIFF_TABLE` | 2 | 13 | 2 | src/backend/acquiring-bill-currency-db/run-repository.js(8), src/backend/biz-op-recon-db/run-repository.js(5) |
| `normalizeAccountKey` | 2 | 13 | 2 | src/main-process/biz-op-recon-session.js(10), src/main-process/biz-op-recon-writer.js(3) |
| `normalizeBu` | 2 | 13 | 2 | src/main-process/bank-bu-recon-session.js(8), src/main-process/biz-op-recon-session.js(5) |
| `refreshTemplates` | 2 | 13 | 1 | src/renderer.js(7), src/renderer-dialogs.js(6) |
| `getCurrencyOptionEntries` | 2 | 12 | 1 | src/renderer.js(7), src/renderer-dialogs.js(5) |
| `importRepo` | 2 | 12 | 2 | src/main-process/acquiring-bill-currency-session.js(7), src/backend/acquiring-bill-currency-import/reader.js(5) |
| `parseAmount` | 2 | 12 | 2 | src/backend/biz-op-recon-import/validator.js(8), src/main-process/biz-op-recon-session.js(4) |
| `BIZ_OP_ACCOUNT_KEY_DB_COLUMN` | 2 | 11 | 1 | src/main-process/biz-op-recon-session.js(9), src/backend/biz-op-recon-db/columns.js(2) |
| `rendererPending` | 2 | 11 | 1 | src/renderer-previews.js(9), src/renderer.js(2) |
| `getTemplate` | 2 | 10 | 1 | src/backend/database/template-repository.js(8), src/backend/database.js(2) |
| `serializeError` | 2 | 10 | 1 | src/main-process/run-check-worker.js(7), src/main-process/serialize-error.js(3) |
| `channelsRepository` | 2 | 9 | 2 | src/backend/database.js(8), src/main.js(1) |
| `diffRepo` | 2 | 9 | 2 | src/backend/pending-export/writer.js(6), src/backend/pending-reconcile/engine.js(3) |
| `hasEffectiveAmount` | 2 | 9 | 1 | src/backend/file-service.js(7), src/backend/file-service/normalizers.js(2) |
| `ACQUIRING_BILL_CHUNK_SIZE_DEFAULT` | 2 | 8 | 2 | src/backend/database/settings-repository.js(5), src/backend/database/migrations.js(3) |
| `ACQUIRING_BILL_CHUNK_SIZE_KEY` | 2 | 8 | 2 | src/backend/database/migrations.js(4), src/backend/database/settings-repository.js(4) |
| `ACQUIRING_BILL_IDLE_CLEANUP_MINUTES_DEFAULT` | 2 | 8 | 2 | src/backend/database/settings-repository.js(5), src/backend/database/migrations.js(3) |
| `ACQUIRING_BILL_IDLE_CLEANUP_MINUTES_KEY` | 2 | 8 | 2 | src/backend/database/migrations.js(4), src/backend/database/settings-repository.js(4) |
| `ACQUIRING_BILL_RAW_JSON_RETENTION_DAYS_DEFAULT` | 2 | 8 | 2 | src/backend/database/settings-repository.js(5), src/backend/database/migrations.js(3) |
| `ACQUIRING_BILL_RAW_JSON_RETENTION_DAYS_KEY` | 2 | 8 | 2 | src/backend/database/migrations.js(4), src/backend/database/settings-repository.js(4) |
| `CancelError` | 2 | 8 | 1 | src/main-process/acquiring-bill-currency-session.js(7), src/main-process/run-check-worker.js(1) |
| `getChannelById` | 2 | 8 | 1 | src/backend/database/channels-repository.js(6), src/backend/database.js(2) |
| `importsRepository` | 2 | 8 | 2 | src/main-process/biz-op-recon-session.js(5), src/main-process/biz-op-recon-writer.js(3) |
| `monthRepo` | 2 | 8 | 2 | src/backend/pending-import/worker.js(4), src/main-process/pending-session.js(4) |
| `pkg` | 2 | 8 | 2 | src/main-process/acquiring-bill-currency-writer.js(7), src/main.js(1) |
| `setNewAccountStatus` | 2 | 8 | 1 | src/renderer.js(6), src/renderer-previews.js(2) |
| `sheetToObjects` | 2 | 8 | 2 | src/main-process/recon-id-fix-io.js(5), src/main-process/bank-statement-io.js(3) |
| `applyManualBalancePromptStatus` | 2 | 7 | 1 | src/renderer.js(4), src/renderer-dialogs.js(3) |
| `createBackup` | 2 | 7 | 1 | src/backend/database.js(6), src/backend/database/backup.js(1) |
| `FLOW_TABLE` | 2 | 7 | 2 | src/backend/acquiring-bill-currency-db/run-repository.js(5), src/backend/biz-op-recon-db/run-repository.js(2) |
| `gatewayReconSession` | 2 | 7 | 1 | src/renderer.js(6), src/main.js(1) |
| `getNewAccountStatusTitle` | 2 | 7 | 1 | src/renderer.js(5), src/renderer-previews.js(2) |
| `isNumericFieldName` | 2 | 7 | 2 | src/main-process/scenario-engines/c2-offset-bill-mark.js(4), src/main-process/scenario-engines/c3-gateway-recon-join.js(3) |
| `parseNumber` | 2 | 7 | 1 | src/main-process/scenario-engines/engine-utils.js(4), src/main-process/scenario-engines/c3-gateway-recon-join.js(3) |
| `roundAmount` | 2 | 7 | 1 | src/backend/file-service/normalizers.js(5), src/backend/file-service.js(2) |
| `setNewAccountExportAvailability` | 2 | 7 | 1 | src/renderer.js(5), src/renderer-previews.js(2) |
| `setRunChunkProgress` | 2 | 7 | 1 | src/main-process/acquiring-bill-currency-session.js(5), src/backend/acquiring-bill-currency-db/run-repository.js(2) |
| `syncNewAccountCurrencyMode` | 2 | 7 | 1 | src/renderer.js(5), src/renderer-previews.js(2) |
| `VALID_CATEGORIES` | 2 | 7 | 2 | src/backend/database/scenarios-repository.js(4), src/main-process/recon-id-fix-engine.js(3) |
| `BANK_DIFF_FIELD_DB_COLUMN` | 2 | 6 | 1 | src/main-process/bank-bu-recon-session.js(4), src/backend/bank-bu-recon-db/columns.js(2) |
| `bankStatementSession` | 2 | 6 | 1 | src/renderer.js(5), src/main.js(1) |
| `bizOpRowToArray` | 2 | 6 | 1 | src/main-process/biz-op-recon-writer.js(4), src/backend/biz-op-recon-db/columns.js(2) |
| `buildFileReader` | 2 | 6 | 2 | src/backend/bank-bu-recon-import/reader.js(3), src/backend/biz-op-recon-import/reader.js(3) |
| `buildRowMapper` | 2 | 6 | 2 | src/backend/bank-bu-recon-import/reader.js(3), src/backend/biz-op-recon-import/reader.js(3) |
| `buildTemplateSummaryFromRow` | 2 | 6 | 1 | src/backend/database/template-repository.js(4), src/backend/database/utils.js(2) |
| `ensureAccountMappingCurrencySupport` | 2 | 6 | 1 | src/backend/database.js(4), src/backend/database/migrations.js(2) |
| `ensureAccountMappingTemplateSupport` | 2 | 6 | 1 | src/backend/database.js(4), src/backend/database/migrations.js(2) |
| `ensureAcquiringBillChunkSizeSetting` | 2 | 6 | 1 | src/backend/database.js(4), src/backend/database/migrations.js(2) |
| `ensureAcquiringBillCurrencyRawJsonRetentionSettings` | 2 | 6 | 1 | src/backend/database.js(4), src/backend/database/migrations.js(2) |
| `ensureAcquiringBillCurrencyRunsChunkProgress` | 2 | 6 | 1 | src/backend/database.js(4), src/backend/database/migrations.js(2) |
| `ensureAcquiringBillCurrencyRunsCleanupPending` | 2 | 6 | 1 | src/backend/database.js(4), src/backend/database/migrations.js(2) |
| `ensureAcquiringBillCurrencyTablesSupport` | 2 | 6 | 1 | src/backend/database.js(4), src/backend/database/migrations.js(2) |
| `ensureAcquiringBillIdleCleanupMinutesSetting` | 2 | 6 | 1 | src/backend/database.js(4), src/backend/database/migrations.js(2) |
| `ensureAmountSplitRulesSupport` | 2 | 6 | 1 | src/backend/database.js(4), src/backend/database/migrations.js(2) |
| `ensureBankBuReconTablesSupport` | 2 | 6 | 1 | src/backend/database.js(4), src/backend/database/migrations.js(2) |
| `ensureBillRawJsonV2Slim` | 2 | 6 | 1 | src/backend/database.js(4), src/backend/database/migrations.js(2) |
| `ensureBillSplitMergeSupport` | 2 | 6 | 1 | src/backend/database.js(4), src/backend/database/migrations.js(2) |
| `ensureBillSplitTargetSeqSupport` | 2 | 6 | 1 | src/backend/database.js(4), src/backend/database/migrations.js(2) |
| `ensureBizOpReconTablesSupport` | 2 | 6 | 2 | src/backend/database.js(4), src/backend/biz-op-recon-db/migrations.js(2) |
| `ensureBuiltinScenarioNamesUpdate` | 2 | 6 | 1 | src/backend/database.js(4), src/backend/database/migrations.js(2) |
| `ensureC3AssignAddMode` | 2 | 6 | 1 | src/backend/database.js(4), src/backend/database/migrations.js(2) |
| `ensureC3GwFieldCurrencyCaseFix` | 2 | 6 | 1 | src/backend/database.js(4), src/backend/database/migrations.js(2) |
| `ensureDiffRowsCascadeMigration_v2_1_10` | 2 | 6 | 1 | src/backend/database.js(4), src/backend/database/migrations.js(2) |
| `ensureParentTemplateSupport` | 2 | 6 | 1 | src/backend/database.js(4), src/backend/database/migrations.js(2) |
| `ensureScenariosCategoryGatewayReconIdFix` | 2 | 6 | 1 | src/backend/database.js(4), src/backend/database/migrations.js(2) |
| `ensureScenariosCategoryReconIdFix` | 2 | 6 | 1 | src/backend/database.js(4), src/backend/database/migrations.js(2) |
| `ensureScenariosNameUniqueByChannelId` | 2 | 6 | 1 | src/backend/database.js(4), src/backend/database/migrations.js(2) |
| `ensureScenariosSupport` | 2 | 6 | 1 | src/backend/database.js(4), src/backend/database/migrations.js(2) |
| `ensureSchemaV2_1_9_N5` | 2 | 6 | 1 | src/backend/database.js(4), src/backend/database/migrations.js(2) |
| `ensureTemplateBigAccountNatureSupport` | 2 | 6 | 1 | src/backend/database.js(4), src/backend/database/migrations.js(2) |
| `ensureTemplateDateFormatSupport` | 2 | 6 | 1 | src/backend/database.js(4), src/backend/database/migrations.js(2) |
| `ensureTemplateFilenameFixedFieldSupport` | 2 | 6 | 1 | src/backend/database.js(4), src/backend/database/migrations.js(2) |
| `ensureTemplateKeySupport` | 2 | 6 | 1 | src/backend/database.js(4), src/backend/database/migrations.js(2) |
| `ensureTemplateMappingEnhancements` | 2 | 6 | 1 | src/backend/database.js(4), src/backend/database/migrations.js(2) |
| `extractMonthKey` | 2 | 6 | 2 | src/backend/acquiring-bill-currency-import/reader.js(3), src/backend/acquiring-bill-currency-import/validator.js(3) |
| `FILENAME_MAPPING_TEMPLATE_ID` | 2 | 6 | 2 | src/renderer.js(4), src/main.js(2) |
| `getCurrencyOptionLabel` | 2 | 6 | 1 | src/renderer.js(5), src/renderer-dialogs.js(1) |
| `getRun` | 2 | 6 | 1 | src/main-process/bank-bu-recon-session.js(4), src/backend/bank-bu-recon-db/run-repository.js(2) |
| `matchAmountSplitConditionValue` | 2 | 6 | 1 | src/backend/file-service.js(4), src/backend/file-service/normalizers.js(2) |
| `migrateC4ReconGroupsAmountLockedFieldPair` | 2 | 6 | 1 | src/backend/database.js(4), src/backend/database/migrations.js(2) |
| `migrateC4ReconGroupsStructure` | 2 | 6 | 1 | src/backend/database.js(4), src/backend/database/migrations.js(2) |
| `migrateGatewayReconIdFixFieldPairs` | 2 | 6 | 1 | src/backend/database.js(4), src/backend/database/migrations.js(2) |
| `normalizeDateExportValue` | 2 | 6 | 1 | src/backend/file-service.js(3), src/backend/file-service/normalizers.js(3) |
| `PENDING_DIFF_FIELD_DB_COLUMN` | 2 | 6 | 1 | src/main-process/bank-bu-recon-session.js(4), src/backend/bank-bu-recon-db/columns.js(2) |
| `processingResult` | 2 | 6 | 1 | src/renderer.js(5), src/main.js(1) |
| `sanitizeSheetName` | 2 | 6 | 2 | src/backend/pending-export/writer.js(3), src/main-process/acquiring-bill-currency-writer.js(3) |
| `splitSignedAmountValue` | 2 | 6 | 1 | src/backend/file-service.js(4), src/backend/file-service/normalizers.js(2) |
| `SUPPORTED_SCENARIO_BUNDLE_VERSION` | 2 | 6 | 1 | src/backend/scenarios-bundle-io.js(5), src/main.js(1) |
| `validateName` | 2 | 6 | 2 | src/backend/database/channels-repository.js(3), src/backend/database/scenarios-repository.js(3) |
| `WRITER_OUTPUT_HEADERS_V2` | 2 | 6 | 1 | src/main-process/acquiring-bill-currency-writer.js(4), src/backend/acquiring-bill-currency-db/columns.js(2) |
| `BILL_KEY_COLUMN_INDICES` | 2 | 5 | 2 | src/backend/acquiring-bill-currency-import/reader.js(3), src/backend/acquiring-bill-currency-db/columns.js(2) |
| `BIZ_OP_END_BALANCE_DB_COLUMN` | 2 | 5 | 1 | src/main-process/biz-op-recon-session.js(3), src/backend/biz-op-recon-db/columns.js(2) |
| `buildInfo` | 2 | 5 | 2 | src/main-process/acquiring-bill-currency-writer.js(3), src/main.js(2) |
| `DIFF_HEADER_TAIL` | 2 | 5 | 1 | src/main-process/biz-op-recon-writer.js(3), src/backend/biz-op-recon-db/columns.js(2) |
| `DIFF_OUTPUT_BANK_SHEET` | 2 | 5 | 1 | src/main-process/bank-bu-recon-writer.js(3), src/backend/bank-bu-recon-db/columns.js(2) |
| `DIFF_OUTPUT_PENDING_SHEET` | 2 | 5 | 1 | src/main-process/bank-bu-recon-writer.js(3), src/backend/bank-bu-recon-db/columns.js(2) |
| `ensureSupportedFile` | 2 | 5 | 1 | src/backend/file-service/readers.js(3), src/backend/file-service.js(2) |
| `ERROR_HEADER_TAIL` | 2 | 5 | 1 | src/main-process/biz-op-recon-writer.js(3), src/backend/biz-op-recon-db/columns.js(2) |
| `FLOW_KEY_COLUMN_INDICES` | 2 | 5 | 2 | src/backend/acquiring-bill-currency-import/reader.js(3), src/backend/acquiring-bill-currency-db/columns.js(2) |
| `getBillSplitAmountRules` | 2 | 5 | 1 | src/backend/database/template-repository.js(3), src/backend/database.js(2) |
| `getBillSplitMappings` | 2 | 5 | 1 | src/backend/database/template-repository.js(3), src/backend/database.js(2) |
| `getBillSplitMeta` | 2 | 5 | 1 | src/backend/database/template-repository.js(3), src/backend/database.js(2) |
| `getBillSplitRows` | 2 | 5 | 1 | src/backend/database/template-repository.js(3), src/backend/database.js(2) |
| `getMonthReadiness` | 2 | 5 | 1 | src/main-process/acquiring-bill-currency-session.js(3), src/backend/acquiring-bill-currency-db/import-repository.js(2) |
| `getScenario` | 2 | 5 | 1 | src/backend/database/scenarios-repository.js(3), src/backend/database.js(2) |
| `getTemplateMappings` | 2 | 5 | 1 | src/backend/database/template-repository.js(3), src/backend/database.js(2) |
| `listDiffRows` | 2 | 5 | 1 | src/backend/pending-export/writer.js(3), src/backend/pending-db/diff-repository.js(2) |
| `normalizeBillDate` | 2 | 5 | 2 | src/backend/acquiring-bill-currency-db/import-repository.js(3), src/backend/acquiring-bill-currency-import/validator.js(2) |
| `performance` | 2 | 5 | 1 | src/renderer.js(3), src/main.js(2) |
| `runC1Scenario` | 2 | 5 | 2 | src/main-process/scenario-engines/index.js(3), src/main-process/scenario-engines/c1-extract-recon-id.js(2) |
| `runC2Scenario` | 2 | 5 | 2 | src/main-process/scenario-engines/index.js(3), src/main-process/scenario-engines/c2-offset-bill-mark.js(2) |
| `runC3Scenario` | 2 | 5 | 2 | src/main-process/scenario-engines/index.js(3), src/main-process/scenario-engines/c3-gateway-recon-join.js(2) |
| `runScenario` | 2 | 5 | 2 | src/main-process/scenario-dispatcher.js(3), src/main-process/scenario-engines/index.js(2) |
| `setExportAvailability` | 2 | 5 | 1 | src/renderer.js(4), src/renderer-previews.js(1) |
| `setNewAccountOpenDateValue` | 2 | 5 | 1 | src/renderer.js(3), src/renderer-previews.js(2) |
| `statementImportSessions` | 2 | 5 | 1 | src/main-process/statement-session.js(4), src/main.js(1) |
| `subOneDay` | 2 | 5 | 2 | src/backend/biz-op-recon-db/run-repository.js(3), src/main-process/biz-op-recon-session.js(2) |
| `updateNewAccountGenerateAvailability` | 2 | 5 | 1 | src/renderer.js(3), src/renderer-previews.js(2) |
| `VALID_DIRECTION_IN` | 2 | 5 | 2 | src/backend/biz-op-recon-import/validator.js(3), src/main-process/biz-op-recon-session.js(2) |
| `VALID_DIRECTION_OUT` | 2 | 5 | 2 | src/backend/biz-op-recon-import/validator.js(3), src/main-process/biz-op-recon-session.js(2) |
| `validateBillHeaders` | 2 | 5 | 2 | src/backend/acquiring-bill-currency-import/reader.js(3), src/backend/acquiring-bill-currency-import/validator.js(2) |
| `BANK_MATCH_KEY_DB_COLUMN` | 2 | 4 | 1 | src/backend/bank-bu-recon-db/columns.js(2), src/main-process/bank-bu-recon-session.js(2) |
| `buildMappedRows` | 2 | 4 | 1 | src/backend/file-service.js(3), src/main.js(1) |
| `BUSINESS_BILL_SHEET_NAME` | 2 | 4 | 1 | src/constants/recon-id-fix-fields.js(2), src/main-process/recon-id-fix-io.js(2) |
| `C4_CATEGORIES` | 2 | 4 | 2 | src/main-process/scenario-dispatcher.js(3), src/main.js(1) |
| `CHANNEL_BILL_SHEET_NAME` | 2 | 4 | 1 | src/constants/gateway-bill-recon-fields.js(2), src/main-process/recon-id-fix-io.js(2) |
| `clearRunsAndDiffsByDateBu` | 2 | 4 | 1 | src/backend/biz-op-recon-db/run-repository.js(2), src/main-process/biz-op-recon-session.js(2) |
| `closeAllNewAccountCurrencyDropdowns` | 2 | 4 | 1 | src/renderer.js(3), src/renderer-previews.js(1) |
| `computeRowHash` | 2 | 4 | 2 | src/backend/pending-import/validator.js(2), src/backend/pending-import/worker.js(2) |
| `createBankBuReconSession` | 2 | 4 | 2 | src/main-process/bank-bu-recon-session.js(2), src/main.js(2) |
| `createCancelToken` | 2 | 4 | 1 | src/main-process/acquiring-bill-currency-session.js(2), src/main-process/run-check-worker.js(2) |
| `createPendingSession` | 2 | 4 | 2 | src/main-process/pending-session.js(2), src/main.js(2) |
| `crypto` | 2 | 4 | 2 | src/backend/pending-import/validator.js(2), src/backend/pending-reconcile/engine.js(2) |
| `deleteChannel` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/channels-repository.js(2) |
| `deleteScenario` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/scenarios-repository.js(2) |
| `deserializeError` | 2 | 4 | 1 | src/main-process/serialize-error.js(3), src/main-process/run-check-worker-pool.js(1) |
| `ensureUiStyleDefault` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/settings-repository.js(2) |
| `extractEnumValuesFromImportedFile` | 2 | 4 | 1 | src/backend/file-service.js(2), src/backend/file-service/readers.js(2) |
| `FLOW_ACCOUNT_KEY_DB_COLUMN` | 2 | 4 | 1 | src/backend/biz-op-recon-db/columns.js(2), src/main-process/biz-op-recon-session.js(2) |
| `FLOW_BU_FIELD_DB_COLUMN` | 2 | 4 | 1 | src/backend/biz-op-recon-db/columns.js(2), src/main-process/biz-op-recon-session.js(2) |
| `FLOW_DIRECTION_DB_COLUMN` | 2 | 4 | 1 | src/backend/biz-op-recon-db/columns.js(2), src/main-process/biz-op-recon-session.js(2) |
| `FLOW_RECON_AMOUNT_DB_COLUMN` | 2 | 4 | 1 | src/backend/biz-op-recon-db/columns.js(2), src/main-process/biz-op-recon-session.js(2) |
| `flowRowToArray` | 2 | 4 | 1 | src/backend/biz-op-recon-db/columns.js(2), src/main-process/biz-op-recon-writer.js(2) |
| `GATEWAY_BILL_SHEET_NAME` | 2 | 4 | 1 | src/constants/gateway-bill-recon-fields.js(2), src/main-process/recon-id-fix-io.js(2) |
| `getAcquiringBillChunkSize` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/settings-repository.js(2) |
| `getAcquiringBillIdleCleanupMinutes` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/settings-repository.js(2) |
| `getAcquiringBillRawJsonRetentionDays` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/settings-repository.js(2) |
| `getBackgroundConfig` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/settings-repository.js(2) |
| `getCurrencySuggestion` | 2 | 4 | 1 | src/renderer-dialogs.js(2), src/renderer.js(2) |
| `getCurrentModule` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/settings-repository.js(2) |
| `getDiffRowsByRun` | 2 | 4 | 1 | src/backend/biz-op-recon-db/run-repository.js(2), src/main-process/biz-op-recon-writer.js(2) |
| `getEnumConfig` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/settings-repository.js(2) |
| `getReconIdFixBillCategory` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/settings-repository.js(2) |
| `getRowById` | 2 | 4 | 1 | src/backend/biz-op-recon-db/imports-repository.js(2), src/main-process/biz-op-recon-writer.js(2) |
| `getRunChunkProgress` | 2 | 4 | 1 | src/backend/acquiring-bill-currency-db/run-repository.js(2), src/main-process/acquiring-bill-currency-session.js(2) |
| `getTemplateByKey` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/template-repository.js(2) |
| `getTemplateByName` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/template-repository.js(2) |
| `importBillFile` | 2 | 4 | 1 | src/backend/acquiring-bill-currency-import/reader.js(2), src/main-process/acquiring-bill-currency-session.js(2) |
| `importFlowFile` | 2 | 4 | 1 | src/backend/acquiring-bill-currency-import/reader.js(2), src/main-process/acquiring-bill-currency-session.js(2) |
| `INSERT_SQL` | 2 | 4 | 2 | src/backend/biz-op-recon-db/flow-imports-repository.js(2), src/backend/biz-op-recon-db/imports-repository.js(2) |
| `isFilenameMappingMode` | 2 | 4 | 2 | src/renderer.js(3), src/main.js(1) |
| `listAccountMappings` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/settings-repository.js(2) |
| `listChildTemplates` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/template-repository.js(2) |
| `listScenarios` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/scenarios-repository.js(2) |
| `listTemplateBundleEntries` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/template-repository.js(2) |
| `MERCHANT_ID_MULTI_ACCOUNT_MARKER` | 2 | 4 | 2 | src/backend/database/utils.js(3), src/main.js(1) |
| `normalizeCurrencyOptionEntry` | 2 | 4 | 1 | src/renderer-dialogs.js(2), src/renderer.js(2) |
| `openModuleMenu` | 2 | 4 | 1 | src/renderer-previews.js(2), src/renderer.js(2) |
| `OPPONENT_BILL_SHEET_NAME` | 2 | 4 | 1 | src/constants/recon-id-fix-fields.js(2), src/main-process/recon-id-fix-io.js(2) |
| `ORDER_REPAIR_SHEET_NAME` | 2 | 4 | 1 | src/constants/recon-id-fix-fields.js(2), src/main-process/recon-id-fix-io.js(2) |
| `ORDER_REPAIR_SHEET_NAME_GATEWAY` | 2 | 4 | 1 | src/constants/gateway-bill-recon-fields.js(2), src/main-process/recon-id-fix-io.js(2) |
| `PENDING_DB_FILENAME` | 2 | 4 | 2 | src/backend/pending-db.js(3), src/main.js(1) |
| `PENDING_MATCH_KEY_DB_COLUMN` | 2 | 4 | 1 | src/backend/bank-bu-recon-db/columns.js(2), src/main-process/bank-bu-recon-session.js(2) |
| `randomUUID` | 2 | 4 | 2 | src/backend/database/migrations.js(2), src/backend/database/template-repository.js(2) |
| `readSheetAsRows` | 2 | 4 | 2 | src/backend/bank-bu-recon-import/reader.js(2), src/backend/biz-op-recon-import/reader.js(2) |
| `RECON_RESULT_FIELDS` | 2 | 4 | 1 | src/constants/recon-id-fix-fields.js(2), src/main-process/recon-id-fix-io.js(2) |
| `RECON_RESULT_FIELDS_GATEWAY` | 2 | 4 | 1 | src/constants/gateway-bill-recon-fields.js(2), src/main-process/recon-id-fix-io.js(2) |
| `RECON_RESULT_SHEET_NAME` | 2 | 4 | 1 | src/constants/recon-id-fix-fields.js(2), src/main-process/recon-id-fix-io.js(2) |
| `RECON_RESULT_SHEET_NAME_GATEWAY` | 2 | 4 | 1 | src/constants/gateway-bill-recon-fields.js(2), src/main-process/recon-id-fix-io.js(2) |
| `reconIdFixResult` | 2 | 4 | 1 | src/renderer.js(3), src/main.js(1) |
| `reconIdFixSession` | 2 | 4 | 1 | src/renderer.js(3), src/main.js(1) |
| `renameTemplate` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/template-repository.js(2) |
| `resolveCurrencyValue` | 2 | 4 | 1 | src/backend/file-service.js(2), src/backend/file-service/normalizers.js(2) |
| `runC4Scenario` | 2 | 4 | 2 | src/main-process/recon-id-fix-engine.js(2), src/main-process/scenario-engines/c4-recon-id-fix.js(2) |
| `runCheckCore` | 2 | 4 | 1 | src/main-process/acquiring-bill-currency-session.js(3), src/main-process/run-check-worker.js(1) |
| `saveAccountMappings` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/settings-repository.js(2) |
| `saveTemplateFilenameFixedField` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/template-repository.js(2) |
| `setAcquiringBillChunkSize` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/settings-repository.js(2) |
| `setAcquiringBillIdleCleanupMinutes` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/settings-repository.js(2) |
| `setAcquiringBillRawJsonRetentionDays` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/settings-repository.js(2) |
| `setBackgroundConfig` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/settings-repository.js(2) |
| `setEnumConfig` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/settings-repository.js(2) |
| `toggleScenarioEnabled` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/scenarios-repository.js(2) |
| `transferScenarios` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/scenarios-repository.js(2) |
| `trimTrailingEmptyCells` | 2 | 4 | 1 | src/backend/file-service/common.js(2), src/backend/file-service/readers.js(2) |
| `updateChannel` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/channels-repository.js(2) |
| `updateScenario` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/scenarios-repository.js(2) |
| `upsertTemplate` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/template-repository.js(2) |
| `validateBankHeaders` | 2 | 4 | 1 | src/backend/bank-bu-recon-import/reader.js(2), src/backend/bank-bu-recon-import/validator.js(2) |
| `validateBizOpHeaders` | 2 | 4 | 1 | src/backend/biz-op-recon-import/reader.js(2), src/backend/biz-op-recon-import/validator.js(2) |
| `validateBizOpRow` | 2 | 4 | 1 | src/backend/biz-op-recon-import/validator.js(2), src/main-process/biz-op-recon-session.js(2) |
| `validateFlowRow` | 2 | 4 | 1 | src/backend/biz-op-recon-import/validator.js(2), src/main-process/biz-op-recon-session.js(2) |
| `validatePendingGuanliHeaders` | 2 | 4 | 1 | src/backend/bank-bu-recon-import/reader.js(2), src/backend/bank-bu-recon-import/validator.js(2) |
| `writeStreamedXlsx` | 2 | 4 | 2 | src/backend/pending-import/streaming-xlsx-writer.js(2), src/main-process/pending-archive-worker.js(2) |
| `AppDatabase` | 2 | 3 | 2 | src/backend/database.js(2), src/main.js(1) |
| `appendStatementSessionImport` | 2 | 3 | 1 | src/main-process/statement-session.js(2), src/main.js(1) |
| `applyScenarioBundleImport` | 2 | 3 | 1 | src/main-process/scenarios-bundle-import.js(2), src/main.js(1) |
| `assembleMonthlyBalance` | 2 | 3 | 1 | src/main-process/monthly-balance.js(2), src/main.js(1) |
| `BIZ_OP_BU_FIELD_DB_COLUMN` | 2 | 3 | 1 | src/backend/biz-op-recon-db/columns.js(2), src/main-process/biz-op-recon-session.js(1) |
| `buildDetailExportRows` | 2 | 3 | 1 | src/backend/file-service.js(2), src/main.js(1) |
| `buildStatementFileEntry` | 2 | 3 | 1 | src/main-process/statement-session.js(2), src/main.js(1) |
| `clearByDate` | 2 | 3 | 1 | src/backend/biz-op-recon-db/flow-imports-repository.js(2), src/main-process/biz-op-recon-session.js(1) |
| `clearByDateBu` | 2 | 3 | 1 | src/backend/biz-op-recon-db/imports-repository.js(2), src/main-process/biz-op-recon-session.js(1) |
| `clearRunsAndDiffsByDate` | 2 | 3 | 1 | src/backend/biz-op-recon-db/run-repository.js(2), src/main-process/biz-op-recon-session.js(1) |
| `clearRunsByMonth` | 2 | 3 | 1 | src/backend/acquiring-bill-currency-db/run-repository.js(2), src/main-process/acquiring-bill-currency-session.js(1) |
| `clearStaleSuccessfulRawJson` | 2 | 3 | 2 | src/backend/acquiring-bill-currency-db/raw-json-retention.js(2), src/main.js(1) |
| `computeRunStats` | 2 | 3 | 1 | src/backend/acquiring-bill-currency-db/run-repository.js(2), src/main-process/acquiring-bill-currency-session.js(1) |
| `countRowsInMonth` | 2 | 3 | 1 | src/backend/pending-db/month-repository.js(2), src/main-process/pending-session.js(1) |
| `createRowInserter` | 2 | 3 | 1 | src/backend/pending-db/month-repository.js(2), src/backend/pending-import/worker.js(1) |
| `createRun` | 2 | 3 | 1 | src/backend/pending-db/diff-repository.js(2), src/backend/pending-reconcile/engine.js(1) |
| `createStatementGenerationHelpers` | 2 | 3 | 1 | src/main-process/statement-generation.js(2), src/main.js(1) |
| `deleteMonth` | 2 | 3 | 1 | src/backend/pending-db/month-repository.js(2), src/backend/pending-import/worker.js(1) |
| `deleteMonthBySide` | 2 | 3 | 1 | src/backend/acquiring-bill-currency-db/import-repository.js(2), src/main-process/acquiring-bill-currency-session.js(1) |
| `detectBundleType` | 2 | 3 | 1 | src/backend/scenarios-bundle-io.js(2), src/main.js(1) |
| `findByChannelAndName` | 2 | 3 | 1 | src/backend/database/scenarios-repository.js(2), src/backend/database.js(1) |
| `getBankRows` | 2 | 3 | 1 | src/backend/bank-bu-recon-db/month-repository.js(2), src/main-process/bank-bu-recon-session.js(1) |
| `getBillDateCounts` | 2 | 3 | 1 | src/backend/acquiring-bill-currency-db/run-repository.js(2), src/main-process/acquiring-bill-currency-writer.js(1) |
| `getLatestRunForMonthPair` | 2 | 3 | 1 | src/backend/pending-db/diff-repository.js(2), src/preload.js(1) |
| `getOrCreateStatementImportSession` | 2 | 3 | 1 | src/main-process/statement-session.js(2), src/main.js(1) |
| `getPendingRows` | 2 | 3 | 1 | src/backend/bank-bu-recon-db/month-repository.js(2), src/main-process/bank-bu-recon-session.js(1) |
| `getTemplatesByBankName` | 2 | 3 | 1 | src/backend/database/template-repository.js(2), src/backend/database/own-accounts-migration.js(1) |
| `importMonthAtomic` | 2 | 3 | 1 | src/backend/bank-bu-recon-db/month-repository.js(2), src/main-process/bank-bu-recon-session.js(1) |
| `insertBillRow` | 2 | 3 | 1 | src/backend/acquiring-bill-currency-db/import-repository.js(2), src/backend/acquiring-bill-currency-import/reader.js(1) |
| `insertDiffRows` | 2 | 3 | 1 | src/backend/biz-op-recon-db/run-repository.js(2), src/main-process/biz-op-recon-session.js(1) |
| `insertDiffRowsByJoinChunked` | 2 | 3 | 1 | src/backend/acquiring-bill-currency-db/run-repository.js(2), src/main-process/acquiring-bill-currency-session.js(1) |
| `insertFlowRow` | 2 | 3 | 1 | src/backend/acquiring-bill-currency-db/import-repository.js(2), src/backend/acquiring-bill-currency-import/reader.js(1) |
| `JSZip` | 2 | 3 | 2 | src/backend/pending-import/streaming-xlsx-writer.js(2), src/backend/pending-import/streaming-xlsx-reader.js(1) |
| `listAllByChannelId` | 2 | 3 | 1 | src/backend/database/scenarios-repository.js(2), src/backend/database.js(1) |
| `listDiffRowsByDateRange` | 2 | 3 | 1 | src/backend/acquiring-bill-currency-db/run-repository.js(2), src/main-process/acquiring-bill-currency-writer.js(1) |
| `listReadyDates` | 2 | 3 | 1 | src/backend/biz-op-recon-db/run-repository.js(2), src/preload.js(1) |
| `listRunsForMonthPair` | 2 | 3 | 1 | src/backend/pending-db/diff-repository.js(2), src/preload.js(1) |
| `listSuccessDates` | 2 | 3 | 1 | src/backend/biz-op-recon-db/run-repository.js(2), src/preload.js(1) |
| `listSuccessDatesInRange` | 2 | 3 | 1 | src/backend/biz-op-recon-db/run-repository.js(2), src/main-process/biz-op-recon-writer.js(1) |
| `markCleanupPending` | 2 | 3 | 1 | src/backend/acquiring-bill-currency-db/run-repository.js(2), src/main-process/acquiring-bill-currency-session.js(1) |
| `openBackgroundPalette` | 2 | 3 | 1 | src/renderer.js(2), src/renderer-previews.js(1) |
| `openPendingDb` | 2 | 3 | 2 | src/backend/pending-db.js(2), src/main.js(1) |
| `parseBankAccountExcel` | 2 | 3 | 2 | src/backend/bank-account-import.js(2), src/main.js(1) |
| `parseScenarioBundle` | 2 | 3 | 1 | src/backend/scenarios-bundle-io.js(2), src/main.js(1) |
| `peekMonthKeyFromFile` | 2 | 3 | 1 | src/backend/acquiring-bill-currency-import/reader.js(2), src/main-process/acquiring-bill-currency-session.js(1) |
| `prepareBillInsert` | 2 | 3 | 1 | src/backend/acquiring-bill-currency-db/import-repository.js(2), src/backend/acquiring-bill-currency-import/reader.js(1) |
| `prepareFlowInsert` | 2 | 3 | 1 | src/backend/acquiring-bill-currency-db/import-repository.js(2), src/backend/acquiring-bill-currency-import/reader.js(1) |
| `readBankFile` | 2 | 3 | 2 | src/backend/bank-bu-recon-import/reader.js(2), src/main.js(1) |
| `readBigAccountMode` | 2 | 3 | 2 | src/backend/big-account-mode-store.js(2), src/main.js(1) |
| `readBigAccountOrder` | 2 | 3 | 2 | src/backend/big-account-order-store.js(2), src/main.js(1) |
| `readPendingGuanliFile` | 2 | 3 | 2 | src/backend/bank-bu-recon-import/reader.js(2), src/main.js(1) |
| `removeStatementSessionEntriesByFilePath` | 2 | 3 | 1 | src/main-process/statement-session.js(2), src/main.js(1) |
| `reportStartupFailure` | 2 | 3 | 1 | src/backend/startup-failure.js(2), src/main.js(1) |
| `runAllScenarios` | 2 | 3 | 2 | src/main-process/scenario-dispatcher.js(2), src/main.js(1) |
| `runOwnAccountsMigration` | 2 | 3 | 2 | src/backend/database/own-accounts-migration.js(2), src/main.js(1) |
| `runReconIdFix` | 2 | 3 | 2 | src/main-process/recon-id-fix-engine.js(2), src/main.js(1) |
| `serializeScenarioBundle` | 2 | 3 | 1 | src/backend/scenarios-bundle-io.js(2), src/main.js(1) |
| `toBalanceRows` | 2 | 3 | 1 | src/main-process/monthly-balance.js(2), src/main.js(1) |
| `updateRunPaths` | 2 | 3 | 1 | src/backend/acquiring-bill-currency-db/run-repository.js(2), src/main-process/acquiring-bill-currency-session.js(1) |
| `updateRunStats` | 2 | 3 | 1 | src/backend/pending-db/diff-repository.js(2), src/backend/pending-reconcile/engine.js(1) |
| `updateRunStatus` | 2 | 3 | 1 | src/backend/acquiring-bill-currency-db/run-repository.js(2), src/main-process/acquiring-bill-currency-session.js(1) |
| `upsertMonthMeta` | 2 | 3 | 1 | src/backend/pending-db/month-repository.js(2), src/backend/pending-import/worker.js(1) |
| `writeAggregateDiffWorkbook` | 2 | 3 | 1 | src/main-process/bank-bu-recon-writer.js(2), src/main.js(1) |
| `writeBankStatementOutput` | 2 | 3 | 1 | src/main-process/exceljs-writer.js(2), src/main-process/bank-statement-io.js(1) |
| `writeBigAccountMode` | 2 | 3 | 2 | src/backend/big-account-mode-store.js(2), src/main.js(1) |
| `writeBigAccountOrder` | 2 | 3 | 2 | src/backend/big-account-order-store.js(2), src/main.js(1) |
| `writeDateRangeDiffWorkbook` | 2 | 3 | 1 | src/main-process/biz-op-recon-writer.js(2), src/main.js(1) |
| `writeRunOutputs` | 2 | 3 | 1 | src/main-process/acquiring-bill-currency-writer.js(2), src/main-process/acquiring-bill-currency-session.js(1) |
| `writeScenarioHitRows` | 2 | 3 | 2 | src/main-process/scenario-hit-rows-writer.js(2), src/main.js(1) |
| `writeSingleDateDiffWorkbook` | 2 | 3 | 1 | src/main-process/biz-op-recon-writer.js(2), src/main.js(1) |
| `BALANCE_SEED_GENERATION_METHODS` | 2 | 2 | 1 | src/backend/balance-seed-store.js(1), src/main.js(1) |
| `readBankStatement` | 2 | 2 | 1 | src/main-process/bank-statement-io.js(1), src/main.js(1) |
| `readGatewayRecon` | 2 | 2 | 1 | src/main-process/bank-statement-io.js(1), src/main.js(1) |
| `readReconIdFixFile` | 2 | 2 | 1 | src/main-process/recon-id-fix-io.js(1), src/main.js(1) |
| `runBizOpImportAsync` | 2 | 2 | 1 | src/main-process/biz-op-recon-session.js(1), src/main.js(1) |
| `runFlowImportAsync` | 2 | 2 | 1 | src/main-process/biz-op-recon-session.js(1), src/main.js(1) |
| `WINDOWS_RESERVED_NAMES` | 2 | 2 | 2 | src/main-process/bank-statement-io.js(1), src/main-process/recon-id-fix-io.js(1) |

