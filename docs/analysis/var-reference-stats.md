# 代码库变量引用统计（自动生成）

> 由 `scripts/scan-vars.js` 自动生成，请不要手改。手工维护的重要变量清单在 `rules/important-variables.md`。

| 字段 | 值 |
|---|---|
| 版本 | v2.1.0-beta.1 |
| 扫描时间 | 2026-5-11 15:57:01 |
| 扫描目录 | `src/` |
| JS 文件数 | 60 |
| 顶层声明总数 | 601 |
| ≥2 次引用 | 509 |
| 跨 ≥3 文件 (A-share) | 101 |
| 跨 2 文件 (A-pair) | 153 |
| 单文件 (A-local) | 255 |
| 跨文件合计 (B) | 254 |

---

## A-share — 跨 ≥3 文件共享

| 名字 | 跨度 | 总次数 | 声明数 | 声明位置（首个） |
|---|---:|---:|---:|---|
| `path` | 23 | 81 | 20 | src/backend/balance-adjustment-store.js |
| `fs` | 19 | 59 | 19 | src/backend/balance-adjustment-store.js |
| `parse` | 16 | 24 | 1 | src/backend/usage-stats.js |
| `normalizeCell` | 13 | 99 | 8 | src/backend/balance-adjustment-store.js |
| `FileValidationError` | 11 | 55 | 7 | src/backend/balance-seed-store.js |
| `PENDING_COLUMNS` | 9 | 33 | 9 | src/backend/pending-db/migrations.js |
| `XLSX` | 8 | 54 | 8 | src/backend/file-service/normalizers.js |
| `dialog` | 5 | 362 | 1 | src/main.js |
| `setCurrentModule` | 5 | 47 | 2 | src/backend/database/settings-repository.js |
| `pad` | 5 | 37 | 2 | src/backend/logger.js |
| `normalizeCellValue` | 5 | 35 | 1 | src/main-process/scenario-engines/engine-utils.js |
| `parseNumericValue` | 5 | 26 | 2 | src/backend/balance-seed-store.js |
| `readRows` | 5 | 12 | 2 | src/backend/bank-account-import.js |
| `makeWarningCollector` | 5 | 10 | 1 | src/main-process/scenario-engines/engine-utils.js |
| `saveMappings` | 5 | 9 | 1 | src/backend/database/template-repository.js |
| `deleteTemplate` | 5 | 7 | 1 | src/backend/database/template-repository.js |
| `state` | 4 | 237 | 1 | src/renderer.js |
| `elements` | 4 | 128 | 1 | src/renderer.js |
| `FIXED_FIELD_VALUE_PREFIX` | 4 | 21 | 2 | src/backend/database/utils.js |
| `BANK_STATEMENT_FIELDS` | 4 | 17 | 3 | src/constants/bank-statement-fields.js |
| `MERCHANT_ID_SELF_INPUT_OPTION` | 4 | 17 | 2 | src/main.js |
| `BALANCE_CALCULATED_OPTION` | 4 | 14 | 2 | src/main.js |
| `ADVANCED_MAPPING_FIELDS` | 4 | 11 | 2 | src/main.js |
| `parseDateValue` | 4 | 11 | 1 | src/backend/file-service/normalizers.js |
| `main` | 4 | 10 | 3 | src/backend/file-service/pdf-worker.js |
| `GATEWAY_RECON_FIELDS` | 4 | 9 | 3 | src/constants/gateway-recon-fields.js |
| `app` | 4 | 8 | 1 | src/main.js |
| `BUSINESS_BILL_FIELDS` | 4 | 8 | 2 | src/constants/recon-id-fix-fields.js |
| `DatabaseSync` | 4 | 8 | 4 | src/backend/database.js |
| `ensureRowId` | 4 | 8 | 1 | src/main-process/scenario-engines/engine-utils.js |
| `evaluateCondition` | 4 | 8 | 1 | src/main-process/scenario-engines/engine-utils.js |
| `listTemplates` | 4 | 8 | 1 | src/backend/database/template-repository.js |
| `makeModificationCollector` | 4 | 8 | 1 | src/main-process/scenario-engines/engine-utils.js |
| `OPPONENT_BILL_FIELDS` | 4 | 8 | 2 | src/constants/recon-id-fix-fields.js |
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
| `sanitizeFileName` | 4 | 4 | 4 | src/backend/balance-seed-store.js |
| `normalizeText` | 3 | 70 | 2 | src/backend/database/migrations.js |
| `setStatus` | 3 | 69 | 1 | src/renderer.js |
| `lastGeneratedExports` | 3 | 24 | 1 | src/main.js |
| `CONCAT_FIELDS_MAPPING_FIELD` | 3 | 17 | 2 | src/main.js |
| `BALANCE_DISABLED_OPTION` | 3 | 16 | 2 | src/main.js |
| `applyStatementResult` | 3 | 13 | 1 | src/renderer.js |
| `setSetting` | 3 | 11 | 1 | src/backend/database/settings-repository.js |
| `getSetting` | 3 | 9 | 1 | src/backend/database/settings-repository.js |
| `inferDateCellFormat` | 3 | 9 | 1 | src/backend/file-service/normalizers.js |
| `parseJsonArray` | 3 | 9 | 2 | src/backend/database/utils.js |
| `toExcelSerial` | 3 | 9 | 1 | src/backend/file-service/normalizers.js |
| `AMOUNT_BASED_ACCOUNT_MAPPING_FIELD` | 3 | 8 | 2 | src/main.js |
| `AMOUNT_BASED_NAME_MAPPING_FIELD` | 3 | 8 | 2 | src/main.js |
| `AMOUNT_SPLIT_BY_FIELD_ENABLED_OPTION` | 3 | 8 | 2 | src/main.js |
| `AMOUNT_SPLIT_BY_FIELD_MAPPING_FIELD` | 3 | 8 | 2 | src/main.js |
| `applyHeaderRowFont` | 3 | 8 | 3 | src/backend/file-service/writers.js |
| `BANK_STATEMENT_VIRTUAL_AMOUNT_ABS` | 3 | 8 | 3 | src/constants/bank-statement-fields.js |
| `cloneRowsWithMetadata` | 3 | 8 | 1 | src/main-process/statement-session.js |
| `getTemplateBigAccounts` | 3 | 8 | 1 | src/backend/database/template-repository.js |
| `SIGNED_AMOUNT_MAPPING_FIELD` | 3 | 8 | 2 | src/main.js |
| `BANK_STATEMENT_FIELDS_FOR_C3` | 3 | 7 | 2 | src/constants/bank-statement-fields.js |
| `normalizeInputFilePaths` | 3 | 7 | 1 | src/main-process/statement-session.js |
| `compileRegexLiteral` | 3 | 6 | 1 | src/backend/file-service/normalizers.js |
| `getAmountSplitRules` | 3 | 6 | 1 | src/backend/database/template-repository.js |
| `getUiStyle` | 3 | 6 | 1 | src/backend/database/settings-repository.js |
| `groupBigAccountRows` | 3 | 6 | 2 | src/backend/database/utils.js |
| `isRegexLiteral` | 3 | 6 | 1 | src/backend/file-service/normalizers.js |
| `loadCurrencyMappings` | 3 | 6 | 2 | src/backend/file-service.js |
| `loadEnumValues` | 3 | 6 | 1 | src/backend/file-service/readers.js |
| `ORDER_REPAIR_FIELDS` | 3 | 6 | 2 | src/constants/recon-id-fix-fields.js |
| `readRowsWithMetadata` | 3 | 6 | 1 | src/backend/file-service/readers.js |
| `resolveSinglePreparedFieldValue` | 3 | 6 | 1 | src/main-process/statement-session.js |
| `runMigrations` | 3 | 6 | 3 | src/backend/pending-db.js |
| `SUPPORTED_EXTENSIONS` | 3 | 6 | 1 | src/backend/file-service/common.js |
| `valuesEqual` | 3 | 6 | 1 | src/main-process/scenario-engines/engine-utils.js |
| `ALL_BANKS_TEMPLATE_SCOPE` | 3 | 5 | 2 | src/main-process/monthly-balance.js |
| `calculateEndingBalanceFromAmounts` | 3 | 5 | 1 | src/backend/file-service/normalizers.js |
| `getRule` | 3 | 5 | 1 | src/backend/pending-db/rule-repository.js |
| `getStatementSessionEntries` | 3 | 5 | 1 | src/main-process/statement-session.js |
| `inferEndingBalance` | 3 | 5 | 1 | src/backend/file-service/normalizers.js |
| `listMonths` | 3 | 5 | 1 | src/backend/pending-db/month-repository.js |
| `mergeMappedDetailRows` | 3 | 5 | 1 | src/main-process/statement-session.js |
| `setUiStyle` | 3 | 5 | 1 | src/backend/database/settings-repository.js |
| `exportAggregate` | 3 | 4 | 1 | src/backend/pending-export/writer.js |
| `isEmptyValue` | 3 | 4 | 1 | src/main-process/scenario-engines/engine-utils.js |
| `sanitizeBankName` | 3 | 4 | 3 | src/backend/balance-adjustment-store.js |
| `writeErrorReport` | 3 | 4 | 1 | src/main-process/exceljs-writer.js |
| `buildTimestampMinute` | 3 | 3 | 2 | src/main-process/bank-statement-io.js |
| `createHash` | 3 | 3 | 1 | src/main.js |

## A-pair — 跨 2 文件

| 名字 | 总次数 | 声明位置（首个） |
|---|---:|---|
| `MODULES` | 51 | src/renderer.js |
| `templateRepository` | 33 | src/backend/database.js |
| `emit` | 20 | src/backend/pending-import/worker.js |
| `settingsRepository` | 18 | src/backend/database.js |
| `hasColumn` | 17 | src/backend/database/migrations.js |
| `refreshBankStatementStatus` | 14 | src/renderer.js |
| `sanitizeAmountValue` | 14 | src/backend/file-service/normalizers.js |
| `refreshTemplates` | 13 | src/renderer.js |
| `reloadReconIdFixScenarios` | 13 | src/renderer.js |
| `getCurrencyOptionEntries` | 12 | src/renderer.js |
| `rendererPending` | 11 | src/renderer.js |
| `getTemplate` | 10 | src/backend/database/template-repository.js |
| `pad2` | 10 | src/backend/usage-stats.js |
| `diffRepo` | 9 | src/backend/pending-export/writer.js |
| `hasEffectiveAmount` | 9 | src/backend/file-service/normalizers.js |
| `isRowMeaningful` | 9 | src/backend/file-service/common.js |
| `monthRepo` | 8 | src/backend/pending-import/worker.js |
| `setNewAccountStatus` | 8 | src/renderer.js |
| `sheetToObjects` | 8 | src/main-process/bank-statement-io.js |
| `applyManualBalancePromptStatus` | 7 | src/renderer.js |
| `gatewayReconSession` | 7 | src/main.js |
| `getNewAccountStatusTitle` | 7 | src/renderer.js |
| `isNumericFieldName` | 7 | src/main-process/scenario-engines/c2-offset-bill-mark.js |
| `parseNumber` | 7 | src/main-process/scenario-engines/engine-utils.js |
| `roundAmount` | 7 | src/backend/file-service/normalizers.js |
| `setNewAccountExportAvailability` | 7 | src/renderer.js |
| `syncNewAccountCurrencyMode` | 7 | src/renderer.js |
| `bankStatementSession` | 6 | src/main.js |
| `buildTemplateSummaryFromRow` | 6 | src/backend/database/utils.js |
| `ensureAccountMappingCurrencySupport` | 6 | src/backend/database/migrations.js |
| `ensureAccountMappingTemplateSupport` | 6 | src/backend/database/migrations.js |
| `ensureAmountSplitRulesSupport` | 6 | src/backend/database/migrations.js |
| `ensureBillSplitMergeSupport` | 6 | src/backend/database/migrations.js |
| `ensureBillSplitTargetSeqSupport` | 6 | src/backend/database/migrations.js |
| `ensureBuiltinScenarioNamesUpdate` | 6 | src/backend/database/migrations.js |
| `ensureC3GwFieldCurrencyCaseFix` | 6 | src/backend/database/migrations.js |
| `ensureParentTemplateSupport` | 6 | src/backend/database/migrations.js |
| `ensureScenariosCategoryReconIdFix` | 6 | src/backend/database/migrations.js |
| `ensureScenariosSupport` | 6 | src/backend/database/migrations.js |
| `ensureTemplateBigAccountNatureSupport` | 6 | src/backend/database/migrations.js |
| `ensureTemplateDateFormatSupport` | 6 | src/backend/database/migrations.js |
| `ensureTemplateFilenameFixedFieldSupport` | 6 | src/backend/database/migrations.js |
| `ensureTemplateKeySupport` | 6 | src/backend/database/migrations.js |
| `ensureTemplateMappingEnhancements` | 6 | src/backend/database/migrations.js |
| `FILENAME_MAPPING_TEMPLATE_ID` | 6 | src/main.js |
| `getCurrencyOptionLabel` | 6 | src/renderer.js |
| `matchAmountSplitConditionValue` | 6 | src/backend/file-service/normalizers.js |
| `migrateC4ReconGroupsAmountLockedFieldPair` | 6 | src/backend/database/migrations.js |
| `migrateC4ReconGroupsStructure` | 6 | src/backend/database/migrations.js |
| `normalizeDateExportValue` | 6 | src/backend/file-service/normalizers.js |
| `processingResult` | 6 | src/main.js |
| `splitSignedAmountValue` | 6 | src/backend/file-service/normalizers.js |
| `BUSINESS_BILL_SHEET_NAME` | 5 | src/constants/recon-id-fix-fields.js |
| `ensureSupportedFile` | 5 | src/backend/file-service/readers.js |
| `getBillSplitAmountRules` | 5 | src/backend/database/template-repository.js |
| `getBillSplitMappings` | 5 | src/backend/database/template-repository.js |
| `getBillSplitMeta` | 5 | src/backend/database/template-repository.js |
| `getBillSplitRows` | 5 | src/backend/database/template-repository.js |
| `getScenario` | 5 | src/backend/database/scenarios-repository.js |
| `getTemplateMappings` | 5 | src/backend/database/template-repository.js |
| `listDiffRows` | 5 | src/backend/pending-db/diff-repository.js |
| `OPPONENT_BILL_SHEET_NAME` | 5 | src/constants/recon-id-fix-fields.js |
| `ORDER_REPAIR_SHEET_NAME` | 5 | src/constants/recon-id-fix-fields.js |
| `performance` | 5 | src/main.js |
| `RECON_RESULT_SHEET_NAME` | 5 | src/constants/recon-id-fix-fields.js |
| `runC1Scenario` | 5 | src/main-process/scenario-engines/c1-extract-recon-id.js |
| `runC2Scenario` | 5 | src/main-process/scenario-engines/c2-offset-bill-mark.js |
| `runC3Scenario` | 5 | src/main-process/scenario-engines/c3-gateway-recon-join.js |
| `setExportAvailability` | 5 | src/renderer.js |
| `setNewAccountOpenDateValue` | 5 | src/renderer.js |
| `statementImportSessions` | 5 | src/main.js |
| `updateNewAccountGenerateAvailability` | 5 | src/renderer.js |
| `buildMappedRows` | 4 | src/backend/file-service.js |
| `closeAllNewAccountCurrencyDropdowns` | 4 | src/renderer.js |
| `computeRowHash` | 4 | src/backend/pending-import/validator.js |
| `createPendingSession` | 4 | src/main-process/pending-session.js |
| `createScenario` | 4 | src/backend/database/scenarios-repository.js |
| `crypto` | 4 | src/backend/pending-import/validator.js |
| `deleteScenario` | 4 | src/backend/database/scenarios-repository.js |
| `ensureUiStyleDefault` | 4 | src/backend/database/settings-repository.js |
| `extractEnumValuesFromImportedFile` | 4 | src/backend/file-service/readers.js |
| `getBackgroundConfig` | 4 | src/backend/database/settings-repository.js |
| `getCurrencySuggestion` | 4 | src/renderer.js |
| `getCurrentModule` | 4 | src/backend/database/settings-repository.js |
| `getEnumConfig` | 4 | src/backend/database/settings-repository.js |
| `getMonthMeta` | 4 | src/backend/pending-db/month-repository.js |
| `getTemplateByKey` | 4 | src/backend/database/template-repository.js |
| `getTemplateByName` | 4 | src/backend/database/template-repository.js |
| `isFilenameMappingMode` | 4 | src/main.js |
| `listAccountMappings` | 4 | src/backend/database/settings-repository.js |
| `listChildTemplates` | 4 | src/backend/database/template-repository.js |
| `listScenarios` | 4 | src/backend/database/scenarios-repository.js |
| `listTemplateBundleEntries` | 4 | src/backend/database/template-repository.js |
| `MERCHANT_ID_MULTI_ACCOUNT_MARKER` | 4 | src/backend/database/utils.js |
| `normalizeCurrencyOptionEntry` | 4 | src/renderer.js |
| `openModuleMenu` | 4 | src/renderer.js |
| `PENDING_DB_FILENAME` | 4 | src/backend/pending-db.js |
| `randomUUID` | 4 | src/backend/database/migrations.js |
| `RECON_RESULT_FIELDS` | 4 | src/constants/recon-id-fix-fields.js |
| `reconIdFixResult` | 4 | src/main.js |
| `reconIdFixSession` | 4 | src/main.js |
| `renameTemplate` | 4 | src/backend/database/template-repository.js |
| `resolveCurrencyValue` | 4 | src/backend/file-service/normalizers.js |
| `runC4Scenario` | 4 | src/main-process/recon-id-fix-engine.js |
| `runReconciliation` | 4 | src/backend/pending-reconcile/engine.js |
| `runScenario` | 4 | src/main-process/scenario-dispatcher.js |
| `saveAccountMappings` | 4 | src/backend/database/settings-repository.js |
| `saveTemplateFilenameFixedField` | 4 | src/backend/database/template-repository.js |
| `setBackgroundConfig` | 4 | src/backend/database/settings-repository.js |
| `setEnumConfig` | 4 | src/backend/database/settings-repository.js |
| `toggleScenarioEnabled` | 4 | src/backend/database/scenarios-repository.js |
| `trimTrailingEmptyCells` | 4 | src/backend/file-service/common.js |
| `updateScenario` | 4 | src/backend/database/scenarios-repository.js |
| `upsertTemplate` | 4 | src/backend/database/template-repository.js |
| `validateHeaders` | 4 | src/backend/pending-import/validator.js |
| `writeStreamedXlsx` | 4 | src/backend/pending-import/streaming-xlsx-writer.js |
| `AppDatabase` | 3 | src/backend/database.js |
| `appendStatementSessionImport` | 3 | src/main-process/statement-session.js |
| `assembleMonthlyBalance` | 3 | src/main-process/monthly-balance.js |
| `buildDetailExportRows` | 3 | src/backend/file-service.js |
| `buildStatementFileEntry` | 3 | src/main-process/statement-session.js |
| `countRowsInMonth` | 3 | src/backend/pending-db/month-repository.js |
| `createRowInserter` | 3 | src/backend/pending-db/month-repository.js |
| `createRun` | 3 | src/backend/pending-db/diff-repository.js |
| `createStatementGenerationHelpers` | 3 | src/main-process/statement-generation.js |
| `deleteMonth` | 3 | src/backend/pending-db/month-repository.js |
| `getLatestRunForMonthPair` | 3 | src/backend/pending-db/diff-repository.js |
| `getOrCreateStatementImportSession` | 3 | src/main-process/statement-session.js |
| `getRunById` | 3 | src/backend/pending-db/diff-repository.js |
| `getTemplatesByBankName` | 3 | src/backend/database/template-repository.js |
| `JSZip` | 3 | src/backend/pending-import/streaming-xlsx-reader.js |
| `listRunsForMonthPair` | 3 | src/backend/pending-db/diff-repository.js |
| `openBackgroundPalette` | 3 | src/renderer.js |
| `openPendingDb` | 3 | src/backend/pending-db.js |
| `parseBankAccountExcel` | 3 | src/backend/bank-account-import.js |
| `readBigAccountMode` | 3 | src/backend/big-account-mode-store.js |
| `readBigAccountOrder` | 3 | src/backend/big-account-order-store.js |
| `removeStatementSessionEntriesByFilePath` | 3 | src/main-process/statement-session.js |
| `reportStartupFailure` | 3 | src/backend/startup-failure.js |
| `runAllScenarios` | 3 | src/main-process/scenario-dispatcher.js |
| `runOwnAccountsMigration` | 3 | src/backend/database/own-accounts-migration.js |
| `runReconIdFix` | 3 | src/main-process/recon-id-fix-engine.js |
| `toBalanceRows` | 3 | src/main-process/monthly-balance.js |
| `updateRunStats` | 3 | src/backend/pending-db/diff-repository.js |
| `upsertMonthMeta` | 3 | src/backend/pending-db/month-repository.js |
| `writeBankStatementOutput` | 3 | src/main-process/exceljs-writer.js |
| `writeBigAccountMode` | 3 | src/backend/big-account-mode-store.js |
| `writeBigAccountOrder` | 3 | src/backend/big-account-order-store.js |
| `BALANCE_SEED_GENERATION_METHODS` | 2 | src/backend/balance-seed-store.js |
| `readBankStatement` | 2 | src/main-process/bank-statement-io.js |
| `readGatewayRecon` | 2 | src/main-process/bank-statement-io.js |
| `readReconIdFixFile` | 2 | src/main-process/recon-id-fix-io.js |
| `WINDOWS_RESERVED_NAMES` | 2 | src/main-process/bank-statement-io.js |

## A-local — 仅单文件（≥3 次引用部分）

按文件分组。仅保留 totalHits ≥ 3 的项。

### `src/backend/big-account-mode-store.js`

| 名字 | 总次数 |
|---|---:|
| `getModeFilePath` | 3 |

### `src/backend/big-account-order-store.js`

| 名字 | 总次数 |
|---|---:|
| `getOrderFilePath` | 3 |

### `src/backend/database.js`

| 名字 | 总次数 |
|---|---:|
| `scenariosRepository` | 7 |

### `src/backend/database/migrations.js`

| 名字 | 总次数 |
|---|---:|
| `SCENARIOS_SEEDED_MARKER` | 3 |

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
| `VALID_CATEGORIES` | 4 |
| `validateEnabled` | 4 |
| `calculateNextScenarioId` | 3 |
| `rowToListItem` | 3 |
| `serializeConfig` | 3 |
| `validateName` | 3 |
| `validatePriority` | 3 |

### `src/backend/database/settings-repository.js`

| 名字 | 总次数 |
|---|---:|
| `CURRENT_MODULE_VALID` | 4 |
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

### `src/backend/file-service/pdf-worker.js`

| 名字 | 总次数 |
|---|---:|
| `groupItemsByLine` | 3 |
| `lineItemsToCells` | 3 |

### `src/backend/file-service/readers.js`

| 名字 | 总次数 |
|---|---:|
| `collectMatchedRows` | 3 |
| `countNonEmptyCells` | 3 |
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
| `sanitizeSheetName` | 3 |
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

### `src/main-process/bank-statement-io.js`

| 名字 | 总次数 |
|---|---:|
| `BANK_STATEMENT_SHEET_NAME` | 3 |
| `GATEWAY_RECON_SHEET_NAME` | 3 |

### `src/main-process/exceljs-writer.js`

| 名字 | 总次数 |
|---|---:|
| `ExcelJS` | 3 |
| `YELLOW_FILL` | 3 |

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

### `src/main-process/scenario-dispatcher.js`

| 名字 | 总次数 |
|---|---:|
| `filterOutReconIdFix` | 3 |
| `filterScenariosByGwAvailability` | 3 |
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
| `getBankRowValueForC3` | 3 |
| `gwMatchesBank` | 3 |

### `src/main-process/scenario-engines/c4-recon-id-fix.js`

| 名字 | 总次数 |
|---|---:|
| `buildOutputRow` | 14 |
| `resolveSubBizType` | 14 |
| `parseBillDateMs` | 10 |
| `lookupReconId` | 8 |
| `billDateMatches` | 7 |
| `toCents` | 6 |
| `computeCommonId` | 5 |
| `findAmountLockedPair` | 5 |
| `parseRowIdxNum` | 5 |
| `rowsMatchFieldPairs` | 5 |
| `classifyRows` | 4 |
| `findBestAmountSubset` | 4 |
| `pickBestByTieBreak` | 4 |
| `rowsMatchOtherFieldPairs` | 4 |
| `tryManyToOnePool` | 4 |
| `tryOneToManyPool` | 4 |
| `tryOneToOne` | 4 |
| `apply1v1Assignment` | 3 |
| `collectUnmatchedRows` | 3 |
| `groupReconFields` | 3 |

### `src/main-process/statement-session.js`

| 名字 | 总次数 |
|---|---:|
| `getStatementSessionKey` | 4 |
| `clearStatementExportCache` | 3 |
| `createStatementImportSession` | 3 |
| `pruneStatementImportSession` | 3 |

### `src/main.js`

| 名字 | 总次数 |
|---|---:|
| `startupMetrics` | 3 |

### `src/preload.js`

| 名字 | 总次数 |
|---|---:|
| `ipcRenderer` | 93 |
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
| `BACKGROUND_FILE_HINT` | 3 |
| `closeBackgroundPalette` | 3 |
| `getSpectrumColorAtPosition` | 3 |
| `handleBankStatementImportGatewayRecon` | 3 |
| `initializeNewAccountRow` | 3 |
| `refreshReconIdFixStatus` | 3 |
| `resetBackgroundPickerSelection` | 3 |
| `syncNewAccountOpenDateInputType` | 3 |
| `updateSelectedColorSwatch` | 3 |
| `updateStatusBox` | 3 |

## B — 跨文件引用完整表

| 名字 | 跨度 | 总次数 | 声明数 | 前三引用位置 |
|---|---:|---:|---:|---|
| `path` | 23 | 81 | 20 | src/main-process/scenario-engines/c4-recon-id-fix.js(15), src/backend/file-service/readers.js(8), src/backend/database/own-accounts-migration.js(6) |
| `fs` | 19 | 59 | 19 | src/backend/usage-stats.js(9), src/backend/file-service/pdf-worker.js(8), src/backend/database/own-accounts-migration.js(6) |
| `parse` | 16 | 24 | 1 | src/backend/database/migrations.js(3), src/backend/usage-stats.js(3), src/main-process/pending-session.js(3) |
| `normalizeCell` | 13 | 99 | 8 | src/backend/file-service.js(34), src/backend/file-service/readers.js(13), src/backend/file-service/normalizers.js(12) |
| `FileValidationError` | 11 | 55 | 7 | src/backend/file-service/readers.js(17), src/backend/file-service/normalizers.js(7), src/main-process/bank-statement-io.js(7) |
| `PENDING_COLUMNS` | 9 | 33 | 9 | src/backend/pending-export/writer.js(6), src/backend/pending-import/validator.js(6), src/main-process/pending-session.js(6) |
| `XLSX` | 8 | 54 | 8 | src/backend/file-service/writers.js(20), src/main-process/pending-session.js(11), src/backend/pending-export/writer.js(9) |
| `dialog` | 5 | 362 | 1 | src/renderer-dialogs.js(258), src/renderer.js(71), src/renderer-pending.js(26) |
| `setCurrentModule` | 5 | 47 | 2 | src/renderer-previews.js(39), src/renderer.js(3), src/backend/database.js(2) |
| `pad` | 5 | 37 | 2 | src/main-process/bank-statement-io.js(14), src/backend/logger.js(11), src/main-process/pending-session.js(6) |
| `normalizeCellValue` | 5 | 35 | 1 | src/main-process/scenario-engines/c4-recon-id-fix.js(19), src/main-process/scenario-engines/engine-utils.js(6), src/main-process/scenario-engines/c1-extract-recon-id.js(4) |
| `parseNumericValue` | 5 | 26 | 2 | src/backend/file-service.js(14), src/backend/file-service/writers.js(6), src/backend/file-service/normalizers.js(4) |
| `readRows` | 5 | 12 | 2 | src/backend/file-service/readers.js(4), src/backend/file-service.js(3), src/backend/bank-account-import.js(2) |
| `makeWarningCollector` | 5 | 10 | 1 | src/main-process/scenario-engines/c1-extract-recon-id.js(2), src/main-process/scenario-engines/c2-offset-bill-mark.js(2), src/main-process/scenario-engines/c3-gateway-recon-join.js(2) |
| `saveMappings` | 5 | 9 | 1 | src/renderer-dialogs.js(3), src/backend/database.js(2), src/backend/database/template-repository.js(2) |
| `deleteTemplate` | 5 | 7 | 1 | src/backend/database.js(2), src/backend/database/template-repository.js(2), src/preload.js(1) |
| `state` | 4 | 237 | 1 | src/renderer.js(130), src/renderer-pending.js(54), src/renderer-previews.js(32) |
| `elements` | 4 | 128 | 1 | src/renderer.js(84), src/renderer-previews.js(23), src/renderer-pending.js(17) |
| `FIXED_FIELD_VALUE_PREFIX` | 4 | 21 | 2 | src/backend/file-service.js(13), src/backend/database/utils.js(5), src/backend/file-service/common.js(2) |
| `BANK_STATEMENT_FIELDS` | 4 | 17 | 3 | src/renderer-dialogs.js(9), src/constants/bank-statement-fields.js(3), src/preload.js(3) |
| `MERCHANT_ID_SELF_INPUT_OPTION` | 4 | 17 | 2 | src/renderer.js(8), src/renderer-dialogs.js(6), src/renderer-previews.js(2) |
| `BALANCE_CALCULATED_OPTION` | 4 | 14 | 2 | src/renderer-dialogs.js(5), src/renderer.js(5), src/renderer-previews.js(3) |
| `ADVANCED_MAPPING_FIELDS` | 4 | 11 | 2 | src/renderer-previews.js(4), src/renderer.js(4), src/renderer-dialogs.js(2) |
| `parseDateValue` | 4 | 11 | 1 | src/backend/file-service.js(4), src/backend/file-service/writers.js(4), src/backend/file-service/normalizers.js(2) |
| `main` | 4 | 10 | 3 | src/renderer-dialogs.js(4), src/backend/file-service/pdf-worker.js(2), src/backend/pending-import/worker.js(2) |
| `GATEWAY_RECON_FIELDS` | 4 | 9 | 3 | src/renderer-dialogs.js(3), src/constants/gateway-recon-fields.js(2), src/main-process/bank-statement-io.js(2) |
| `app` | 4 | 8 | 1 | src/main.js(4), src/renderer.js(2), src/preload.js(1) |
| `BUSINESS_BILL_FIELDS` | 4 | 8 | 2 | src/constants/recon-id-fix-fields.js(2), src/main-process/recon-id-fix-io.js(2), src/preload.js(2) |
| `DatabaseSync` | 4 | 8 | 4 | src/backend/database.js(2), src/backend/pending-db.js(2), src/backend/pending-import/worker.js(2) |
| `ensureRowId` | 4 | 8 | 1 | src/main-process/scenario-engines/c1-extract-recon-id.js(2), src/main-process/scenario-engines/c2-offset-bill-mark.js(2), src/main-process/scenario-engines/c3-gateway-recon-join.js(2) |
| `evaluateCondition` | 4 | 8 | 1 | src/main-process/scenario-engines/c1-extract-recon-id.js(2), src/main-process/scenario-engines/c2-offset-bill-mark.js(2), src/main-process/scenario-engines/c4-recon-id-fix.js(2) |
| `listTemplates` | 4 | 8 | 1 | src/backend/database/template-repository.js(3), src/backend/database.js(2), src/main-process/monthly-balance.js(2) |
| `makeModificationCollector` | 4 | 8 | 1 | src/main-process/scenario-engines/c1-extract-recon-id.js(2), src/main-process/scenario-engines/c2-offset-bill-mark.js(2), src/main-process/scenario-engines/c3-gateway-recon-join.js(2) |
| `OPPONENT_BILL_FIELDS` | 4 | 8 | 2 | src/constants/recon-id-fix-fields.js(2), src/main-process/recon-id-fix-io.js(2), src/preload.js(2) |
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
| `sanitizeFileName` | 4 | 4 | 4 | src/backend/balance-seed-store.js(1), src/main-process/bank-statement-io.js(1), src/main-process/recon-id-fix-io.js(1) |
| `normalizeText` | 3 | 70 | 2 | src/backend/database/template-repository.js(57), src/backend/database/utils.js(10), src/backend/database/migrations.js(3) |
| `setStatus` | 3 | 69 | 1 | src/renderer.js(36), src/renderer-dialogs.js(32), src/renderer-previews.js(1) |
| `lastGeneratedExports` | 3 | 24 | 1 | src/main-process/statement-generation.js(17), src/main-process/statement-session.js(6), src/main.js(1) |
| `CONCAT_FIELDS_MAPPING_FIELD` | 3 | 17 | 2 | src/renderer-dialogs.js(14), src/renderer.js(2), src/main.js(1) |
| `BALANCE_DISABLED_OPTION` | 3 | 16 | 2 | src/renderer-dialogs.js(9), src/renderer.js(6), src/main.js(1) |
| `applyStatementResult` | 3 | 13 | 1 | src/renderer.js(7), src/renderer-dialogs.js(5), src/renderer-previews.js(1) |
| `setSetting` | 3 | 11 | 1 | src/backend/database/settings-repository.js(7), src/backend/database.js(2), src/backend/database/own-accounts-migration.js(2) |
| `getSetting` | 3 | 9 | 1 | src/backend/database/settings-repository.js(6), src/backend/database.js(2), src/backend/database/own-accounts-migration.js(1) |
| `inferDateCellFormat` | 3 | 9 | 1 | src/backend/file-service/writers.js(4), src/backend/file-service.js(3), src/backend/file-service/normalizers.js(2) |
| `parseJsonArray` | 3 | 9 | 2 | src/backend/database/template-repository.js(3), src/backend/database/utils.js(3), src/backend/pending-db/rule-repository.js(3) |
| `toExcelSerial` | 3 | 9 | 1 | src/backend/file-service/writers.js(4), src/backend/file-service.js(3), src/backend/file-service/normalizers.js(2) |
| `AMOUNT_BASED_ACCOUNT_MAPPING_FIELD` | 3 | 8 | 2 | src/renderer-previews.js(3), src/renderer.js(3), src/main.js(2) |
| `AMOUNT_BASED_NAME_MAPPING_FIELD` | 3 | 8 | 2 | src/renderer-previews.js(3), src/renderer.js(3), src/main.js(2) |
| `AMOUNT_SPLIT_BY_FIELD_ENABLED_OPTION` | 3 | 8 | 2 | src/renderer-dialogs.js(5), src/renderer.js(2), src/main.js(1) |
| `AMOUNT_SPLIT_BY_FIELD_MAPPING_FIELD` | 3 | 8 | 2 | src/renderer-dialogs.js(3), src/renderer.js(3), src/main.js(2) |
| `applyHeaderRowFont` | 3 | 8 | 3 | src/backend/file-service/writers.js(3), src/main-process/pending-session.js(3), src/backend/pending-export/writer.js(2) |
| `BANK_STATEMENT_VIRTUAL_AMOUNT_ABS` | 3 | 8 | 3 | src/constants/bank-statement-fields.js(3), src/preload.js(3), src/main-process/scenario-engines/c3-gateway-recon-join.js(2) |
| `cloneRowsWithMetadata` | 3 | 8 | 1 | src/main-process/statement-session.js(5), src/main-process/statement-generation.js(2), src/main.js(1) |
| `getTemplateBigAccounts` | 3 | 8 | 1 | src/backend/database/template-repository.js(4), src/backend/database.js(2), src/main-process/monthly-balance.js(2) |
| `SIGNED_AMOUNT_MAPPING_FIELD` | 3 | 8 | 2 | src/renderer-previews.js(3), src/renderer.js(3), src/main.js(2) |
| `BANK_STATEMENT_FIELDS_FOR_C3` | 3 | 7 | 2 | src/renderer-dialogs.js(3), src/constants/bank-statement-fields.js(2), src/preload.js(2) |
| `normalizeInputFilePaths` | 3 | 7 | 1 | src/main-process/statement-generation.js(4), src/main-process/statement-session.js(2), src/main.js(1) |
| `compileRegexLiteral` | 3 | 6 | 1 | src/backend/file-service/normalizers.js(3), src/backend/file-service.js(2), src/main.js(1) |
| `getAmountSplitRules` | 3 | 6 | 1 | src/backend/database/template-repository.js(3), src/backend/database.js(2), src/preload.js(1) |
| `getUiStyle` | 3 | 6 | 1 | src/backend/database/settings-repository.js(3), src/backend/database.js(2), src/preload.js(1) |
| `groupBigAccountRows` | 3 | 6 | 2 | src/backend/database/template-repository.js(3), src/backend/database/utils.js(2), src/main.js(1) |
| `isRegexLiteral` | 3 | 6 | 1 | src/backend/file-service/normalizers.js(3), src/backend/file-service.js(2), src/main.js(1) |
| `loadCurrencyMappings` | 3 | 6 | 2 | src/backend/file-service.js(3), src/backend/file-service/normalizers.js(2), src/main.js(1) |
| `loadEnumValues` | 3 | 6 | 1 | src/backend/file-service/readers.js(3), src/backend/file-service.js(2), src/main.js(1) |
| `ORDER_REPAIR_FIELDS` | 3 | 6 | 2 | src/constants/recon-id-fix-fields.js(2), src/main-process/recon-id-fix-io.js(2), src/main-process/scenario-engines/c4-recon-id-fix.js(2) |
| `readRowsWithMetadata` | 3 | 6 | 1 | src/backend/file-service.js(3), src/backend/file-service/readers.js(2), src/main.js(1) |
| `resolveSinglePreparedFieldValue` | 3 | 6 | 1 | src/main-process/statement-generation.js(3), src/main-process/statement-session.js(2), src/main.js(1) |
| `runMigrations` | 3 | 6 | 3 | src/backend/pending-db.js(2), src/backend/pending-db/migrations.js(2), src/backend/pending-import/worker.js(2) |
| `SUPPORTED_EXTENSIONS` | 3 | 6 | 1 | src/backend/file-service.js(2), src/backend/file-service/common.js(2), src/backend/file-service/readers.js(2) |
| `valuesEqual` | 3 | 6 | 1 | src/main-process/scenario-engines/c2-offset-bill-mark.js(2), src/main-process/scenario-engines/c3-gateway-recon-join.js(2), src/main-process/scenario-engines/engine-utils.js(2) |
| `ALL_BANKS_TEMPLATE_SCOPE` | 3 | 5 | 2 | src/main-process/monthly-balance.js(3), src/main.js(1), src/renderer.js(1) |
| `calculateEndingBalanceFromAmounts` | 3 | 5 | 1 | src/backend/file-service.js(2), src/backend/file-service/normalizers.js(2), src/main.js(1) |
| `getRule` | 3 | 5 | 1 | src/backend/pending-db/rule-repository.js(2), src/renderer-pending.js(2), src/preload.js(1) |
| `getStatementSessionEntries` | 3 | 5 | 1 | src/main-process/statement-generation.js(2), src/main-process/statement-session.js(2), src/main.js(1) |
| `inferEndingBalance` | 3 | 5 | 1 | src/backend/file-service.js(2), src/backend/file-service/normalizers.js(2), src/main.js(1) |
| `listMonths` | 3 | 5 | 1 | src/backend/pending-db/month-repository.js(2), src/renderer-pending.js(2), src/preload.js(1) |
| `mergeMappedDetailRows` | 3 | 5 | 1 | src/main-process/statement-generation.js(2), src/main-process/statement-session.js(2), src/main.js(1) |
| `setUiStyle` | 3 | 5 | 1 | src/backend/database.js(2), src/backend/database/settings-repository.js(2), src/preload.js(1) |
| `exportAggregate` | 3 | 4 | 1 | src/backend/pending-export/writer.js(2), src/preload.js(1), src/renderer-pending.js(1) |
| `isEmptyValue` | 3 | 4 | 1 | src/main-process/scenario-engines/engine-utils.js(2), src/main-process/scenario-engines/c1-extract-recon-id.js(1), src/main-process/scenario-engines/c3-gateway-recon-join.js(1) |
| `sanitizeBankName` | 3 | 4 | 3 | src/backend/database/own-accounts-migration.js(2), src/backend/balance-adjustment-store.js(1), src/backend/own-account-store.js(1) |
| `writeErrorReport` | 3 | 4 | 1 | src/main-process/exceljs-writer.js(2), src/main-process/bank-statement-io.js(1), src/main.js(1) |
| `buildTimestampMinute` | 3 | 3 | 2 | src/main-process/bank-statement-io.js(1), src/main-process/recon-id-fix-io.js(1), src/main.js(1) |
| `createHash` | 3 | 3 | 1 | src/backend/pending-import/validator.js(1), src/backend/pending-reconcile/engine.js(1), src/main.js(1) |
| `MODULES` | 2 | 51 | 1 | src/renderer-previews.js(39), src/renderer.js(12) |
| `templateRepository` | 2 | 33 | 2 | src/backend/database.js(30), src/backend/database/own-accounts-migration.js(3) |
| `emit` | 2 | 20 | 2 | src/backend/pending-import/worker.js(10), src/main-process/pending-archive-worker.js(10) |
| `settingsRepository` | 2 | 18 | 2 | src/backend/database.js(14), src/backend/database/own-accounts-migration.js(4) |
| `hasColumn` | 2 | 17 | 1 | src/backend/database/migrations.js(14), src/backend/database.js(3) |
| `refreshBankStatementStatus` | 2 | 14 | 1 | src/renderer-dialogs.js(7), src/renderer.js(7) |
| `sanitizeAmountValue` | 2 | 14 | 1 | src/backend/file-service.js(11), src/backend/file-service/normalizers.js(3) |
| `refreshTemplates` | 2 | 13 | 1 | src/renderer.js(7), src/renderer-dialogs.js(6) |
| `reloadReconIdFixScenarios` | 2 | 13 | 1 | src/renderer-dialogs.js(9), src/renderer.js(4) |
| `getCurrencyOptionEntries` | 2 | 12 | 1 | src/renderer.js(7), src/renderer-dialogs.js(5) |
| `rendererPending` | 2 | 11 | 1 | src/renderer-previews.js(9), src/renderer.js(2) |
| `getTemplate` | 2 | 10 | 1 | src/backend/database/template-repository.js(8), src/backend/database.js(2) |
| `pad2` | 2 | 10 | 2 | src/backend/usage-stats.js(6), src/main-process/monthly-balance.js(4) |
| `diffRepo` | 2 | 9 | 2 | src/backend/pending-export/writer.js(6), src/backend/pending-reconcile/engine.js(3) |
| `hasEffectiveAmount` | 2 | 9 | 1 | src/backend/file-service.js(7), src/backend/file-service/normalizers.js(2) |
| `isRowMeaningful` | 2 | 9 | 1 | src/backend/file-service/readers.js(7), src/backend/file-service/common.js(2) |
| `monthRepo` | 2 | 8 | 2 | src/backend/pending-import/worker.js(4), src/main-process/pending-session.js(4) |
| `setNewAccountStatus` | 2 | 8 | 1 | src/renderer.js(6), src/renderer-previews.js(2) |
| `sheetToObjects` | 2 | 8 | 2 | src/main-process/recon-id-fix-io.js(5), src/main-process/bank-statement-io.js(3) |
| `applyManualBalancePromptStatus` | 2 | 7 | 1 | src/renderer.js(4), src/renderer-dialogs.js(3) |
| `gatewayReconSession` | 2 | 7 | 1 | src/renderer.js(6), src/main.js(1) |
| `getNewAccountStatusTitle` | 2 | 7 | 1 | src/renderer.js(5), src/renderer-previews.js(2) |
| `isNumericFieldName` | 2 | 7 | 2 | src/main-process/scenario-engines/c2-offset-bill-mark.js(4), src/main-process/scenario-engines/c3-gateway-recon-join.js(3) |
| `parseNumber` | 2 | 7 | 1 | src/main-process/scenario-engines/engine-utils.js(4), src/main-process/scenario-engines/c3-gateway-recon-join.js(3) |
| `roundAmount` | 2 | 7 | 1 | src/backend/file-service/normalizers.js(5), src/backend/file-service.js(2) |
| `setNewAccountExportAvailability` | 2 | 7 | 1 | src/renderer.js(5), src/renderer-previews.js(2) |
| `syncNewAccountCurrencyMode` | 2 | 7 | 1 | src/renderer.js(5), src/renderer-previews.js(2) |
| `bankStatementSession` | 2 | 6 | 1 | src/renderer.js(5), src/main.js(1) |
| `buildTemplateSummaryFromRow` | 2 | 6 | 1 | src/backend/database/template-repository.js(4), src/backend/database/utils.js(2) |
| `ensureAccountMappingCurrencySupport` | 2 | 6 | 1 | src/backend/database.js(4), src/backend/database/migrations.js(2) |
| `ensureAccountMappingTemplateSupport` | 2 | 6 | 1 | src/backend/database.js(4), src/backend/database/migrations.js(2) |
| `ensureAmountSplitRulesSupport` | 2 | 6 | 1 | src/backend/database.js(4), src/backend/database/migrations.js(2) |
| `ensureBillSplitMergeSupport` | 2 | 6 | 1 | src/backend/database.js(4), src/backend/database/migrations.js(2) |
| `ensureBillSplitTargetSeqSupport` | 2 | 6 | 1 | src/backend/database.js(4), src/backend/database/migrations.js(2) |
| `ensureBuiltinScenarioNamesUpdate` | 2 | 6 | 1 | src/backend/database.js(4), src/backend/database/migrations.js(2) |
| `ensureC3GwFieldCurrencyCaseFix` | 2 | 6 | 1 | src/backend/database.js(4), src/backend/database/migrations.js(2) |
| `ensureParentTemplateSupport` | 2 | 6 | 1 | src/backend/database.js(4), src/backend/database/migrations.js(2) |
| `ensureScenariosCategoryReconIdFix` | 2 | 6 | 1 | src/backend/database.js(4), src/backend/database/migrations.js(2) |
| `ensureScenariosSupport` | 2 | 6 | 1 | src/backend/database.js(4), src/backend/database/migrations.js(2) |
| `ensureTemplateBigAccountNatureSupport` | 2 | 6 | 1 | src/backend/database.js(4), src/backend/database/migrations.js(2) |
| `ensureTemplateDateFormatSupport` | 2 | 6 | 1 | src/backend/database.js(4), src/backend/database/migrations.js(2) |
| `ensureTemplateFilenameFixedFieldSupport` | 2 | 6 | 1 | src/backend/database.js(4), src/backend/database/migrations.js(2) |
| `ensureTemplateKeySupport` | 2 | 6 | 1 | src/backend/database.js(4), src/backend/database/migrations.js(2) |
| `ensureTemplateMappingEnhancements` | 2 | 6 | 1 | src/backend/database.js(4), src/backend/database/migrations.js(2) |
| `FILENAME_MAPPING_TEMPLATE_ID` | 2 | 6 | 2 | src/renderer.js(4), src/main.js(2) |
| `getCurrencyOptionLabel` | 2 | 6 | 1 | src/renderer.js(5), src/renderer-dialogs.js(1) |
| `matchAmountSplitConditionValue` | 2 | 6 | 1 | src/backend/file-service.js(4), src/backend/file-service/normalizers.js(2) |
| `migrateC4ReconGroupsAmountLockedFieldPair` | 2 | 6 | 1 | src/backend/database.js(4), src/backend/database/migrations.js(2) |
| `migrateC4ReconGroupsStructure` | 2 | 6 | 1 | src/backend/database.js(4), src/backend/database/migrations.js(2) |
| `normalizeDateExportValue` | 2 | 6 | 1 | src/backend/file-service.js(3), src/backend/file-service/normalizers.js(3) |
| `processingResult` | 2 | 6 | 1 | src/renderer.js(5), src/main.js(1) |
| `splitSignedAmountValue` | 2 | 6 | 1 | src/backend/file-service.js(4), src/backend/file-service/normalizers.js(2) |
| `BUSINESS_BILL_SHEET_NAME` | 2 | 5 | 1 | src/main-process/recon-id-fix-io.js(3), src/constants/recon-id-fix-fields.js(2) |
| `ensureSupportedFile` | 2 | 5 | 1 | src/backend/file-service/readers.js(3), src/backend/file-service.js(2) |
| `getBillSplitAmountRules` | 2 | 5 | 1 | src/backend/database/template-repository.js(3), src/backend/database.js(2) |
| `getBillSplitMappings` | 2 | 5 | 1 | src/backend/database/template-repository.js(3), src/backend/database.js(2) |
| `getBillSplitMeta` | 2 | 5 | 1 | src/backend/database/template-repository.js(3), src/backend/database.js(2) |
| `getBillSplitRows` | 2 | 5 | 1 | src/backend/database/template-repository.js(3), src/backend/database.js(2) |
| `getScenario` | 2 | 5 | 1 | src/backend/database/scenarios-repository.js(3), src/backend/database.js(2) |
| `getTemplateMappings` | 2 | 5 | 1 | src/backend/database/template-repository.js(3), src/backend/database.js(2) |
| `listDiffRows` | 2 | 5 | 1 | src/backend/pending-export/writer.js(3), src/backend/pending-db/diff-repository.js(2) |
| `OPPONENT_BILL_SHEET_NAME` | 2 | 5 | 1 | src/main-process/recon-id-fix-io.js(3), src/constants/recon-id-fix-fields.js(2) |
| `ORDER_REPAIR_SHEET_NAME` | 2 | 5 | 1 | src/main-process/recon-id-fix-io.js(3), src/constants/recon-id-fix-fields.js(2) |
| `performance` | 2 | 5 | 1 | src/renderer.js(3), src/main.js(2) |
| `RECON_RESULT_SHEET_NAME` | 2 | 5 | 1 | src/main-process/recon-id-fix-io.js(3), src/constants/recon-id-fix-fields.js(2) |
| `runC1Scenario` | 2 | 5 | 2 | src/main-process/scenario-engines/index.js(3), src/main-process/scenario-engines/c1-extract-recon-id.js(2) |
| `runC2Scenario` | 2 | 5 | 2 | src/main-process/scenario-engines/index.js(3), src/main-process/scenario-engines/c2-offset-bill-mark.js(2) |
| `runC3Scenario` | 2 | 5 | 2 | src/main-process/scenario-engines/index.js(3), src/main-process/scenario-engines/c3-gateway-recon-join.js(2) |
| `setExportAvailability` | 2 | 5 | 1 | src/renderer.js(4), src/renderer-previews.js(1) |
| `setNewAccountOpenDateValue` | 2 | 5 | 1 | src/renderer.js(3), src/renderer-previews.js(2) |
| `statementImportSessions` | 2 | 5 | 1 | src/main-process/statement-session.js(4), src/main.js(1) |
| `updateNewAccountGenerateAvailability` | 2 | 5 | 1 | src/renderer.js(3), src/renderer-previews.js(2) |
| `buildMappedRows` | 2 | 4 | 1 | src/backend/file-service.js(3), src/main.js(1) |
| `closeAllNewAccountCurrencyDropdowns` | 2 | 4 | 1 | src/renderer.js(3), src/renderer-previews.js(1) |
| `computeRowHash` | 2 | 4 | 2 | src/backend/pending-import/validator.js(2), src/backend/pending-import/worker.js(2) |
| `createPendingSession` | 2 | 4 | 2 | src/main-process/pending-session.js(2), src/main.js(2) |
| `createScenario` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/scenarios-repository.js(2) |
| `crypto` | 2 | 4 | 2 | src/backend/pending-import/validator.js(2), src/backend/pending-reconcile/engine.js(2) |
| `deleteScenario` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/scenarios-repository.js(2) |
| `ensureUiStyleDefault` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/settings-repository.js(2) |
| `extractEnumValuesFromImportedFile` | 2 | 4 | 1 | src/backend/file-service.js(2), src/backend/file-service/readers.js(2) |
| `getBackgroundConfig` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/settings-repository.js(2) |
| `getCurrencySuggestion` | 2 | 4 | 1 | src/renderer-dialogs.js(2), src/renderer.js(2) |
| `getCurrentModule` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/settings-repository.js(2) |
| `getEnumConfig` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/settings-repository.js(2) |
| `getMonthMeta` | 2 | 4 | 1 | src/backend/pending-db/month-repository.js(2), src/main-process/pending-session.js(2) |
| `getTemplateByKey` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/template-repository.js(2) |
| `getTemplateByName` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/template-repository.js(2) |
| `isFilenameMappingMode` | 2 | 4 | 2 | src/renderer.js(3), src/main.js(1) |
| `listAccountMappings` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/settings-repository.js(2) |
| `listChildTemplates` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/template-repository.js(2) |
| `listScenarios` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/scenarios-repository.js(2) |
| `listTemplateBundleEntries` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/template-repository.js(2) |
| `MERCHANT_ID_MULTI_ACCOUNT_MARKER` | 2 | 4 | 2 | src/backend/database/utils.js(3), src/main.js(1) |
| `normalizeCurrencyOptionEntry` | 2 | 4 | 1 | src/renderer-dialogs.js(2), src/renderer.js(2) |
| `openModuleMenu` | 2 | 4 | 1 | src/renderer-previews.js(2), src/renderer.js(2) |
| `PENDING_DB_FILENAME` | 2 | 4 | 2 | src/backend/pending-db.js(3), src/main.js(1) |
| `randomUUID` | 2 | 4 | 2 | src/backend/database/migrations.js(2), src/backend/database/template-repository.js(2) |
| `RECON_RESULT_FIELDS` | 2 | 4 | 1 | src/constants/recon-id-fix-fields.js(2), src/main-process/recon-id-fix-io.js(2) |
| `reconIdFixResult` | 2 | 4 | 1 | src/renderer.js(3), src/main.js(1) |
| `reconIdFixSession` | 2 | 4 | 1 | src/renderer.js(3), src/main.js(1) |
| `renameTemplate` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/template-repository.js(2) |
| `resolveCurrencyValue` | 2 | 4 | 1 | src/backend/file-service.js(2), src/backend/file-service/normalizers.js(2) |
| `runC4Scenario` | 2 | 4 | 2 | src/main-process/recon-id-fix-engine.js(2), src/main-process/scenario-engines/c4-recon-id-fix.js(2) |
| `runReconciliation` | 2 | 4 | 1 | src/backend/pending-reconcile/engine.js(2), src/renderer-pending.js(2) |
| `runScenario` | 2 | 4 | 2 | src/main-process/scenario-dispatcher.js(2), src/main-process/scenario-engines/index.js(2) |
| `saveAccountMappings` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/settings-repository.js(2) |
| `saveTemplateFilenameFixedField` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/template-repository.js(2) |
| `setBackgroundConfig` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/settings-repository.js(2) |
| `setEnumConfig` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/settings-repository.js(2) |
| `toggleScenarioEnabled` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/scenarios-repository.js(2) |
| `trimTrailingEmptyCells` | 2 | 4 | 1 | src/backend/file-service/common.js(2), src/backend/file-service/readers.js(2) |
| `updateScenario` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/scenarios-repository.js(2) |
| `upsertTemplate` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/template-repository.js(2) |
| `validateHeaders` | 2 | 4 | 2 | src/backend/pending-import/validator.js(2), src/backend/pending-import/worker.js(2) |
| `writeStreamedXlsx` | 2 | 4 | 2 | src/backend/pending-import/streaming-xlsx-writer.js(2), src/main-process/pending-archive-worker.js(2) |
| `AppDatabase` | 2 | 3 | 2 | src/backend/database.js(2), src/main.js(1) |
| `appendStatementSessionImport` | 2 | 3 | 1 | src/main-process/statement-session.js(2), src/main.js(1) |
| `assembleMonthlyBalance` | 2 | 3 | 1 | src/main-process/monthly-balance.js(2), src/main.js(1) |
| `buildDetailExportRows` | 2 | 3 | 1 | src/backend/file-service.js(2), src/main.js(1) |
| `buildStatementFileEntry` | 2 | 3 | 1 | src/main-process/statement-session.js(2), src/main.js(1) |
| `countRowsInMonth` | 2 | 3 | 1 | src/backend/pending-db/month-repository.js(2), src/main-process/pending-session.js(1) |
| `createRowInserter` | 2 | 3 | 1 | src/backend/pending-db/month-repository.js(2), src/backend/pending-import/worker.js(1) |
| `createRun` | 2 | 3 | 1 | src/backend/pending-db/diff-repository.js(2), src/backend/pending-reconcile/engine.js(1) |
| `createStatementGenerationHelpers` | 2 | 3 | 1 | src/main-process/statement-generation.js(2), src/main.js(1) |
| `deleteMonth` | 2 | 3 | 1 | src/backend/pending-db/month-repository.js(2), src/backend/pending-import/worker.js(1) |
| `getLatestRunForMonthPair` | 2 | 3 | 1 | src/backend/pending-db/diff-repository.js(2), src/preload.js(1) |
| `getOrCreateStatementImportSession` | 2 | 3 | 1 | src/main-process/statement-session.js(2), src/main.js(1) |
| `getRunById` | 2 | 3 | 1 | src/backend/pending-db/diff-repository.js(2), src/backend/pending-export/writer.js(1) |
| `getTemplatesByBankName` | 2 | 3 | 1 | src/backend/database/template-repository.js(2), src/backend/database/own-accounts-migration.js(1) |
| `JSZip` | 2 | 3 | 2 | src/backend/pending-import/streaming-xlsx-writer.js(2), src/backend/pending-import/streaming-xlsx-reader.js(1) |
| `listRunsForMonthPair` | 2 | 3 | 1 | src/backend/pending-db/diff-repository.js(2), src/preload.js(1) |
| `openBackgroundPalette` | 2 | 3 | 1 | src/renderer.js(2), src/renderer-previews.js(1) |
| `openPendingDb` | 2 | 3 | 2 | src/backend/pending-db.js(2), src/main.js(1) |
| `parseBankAccountExcel` | 2 | 3 | 2 | src/backend/bank-account-import.js(2), src/main.js(1) |
| `readBigAccountMode` | 2 | 3 | 2 | src/backend/big-account-mode-store.js(2), src/main.js(1) |
| `readBigAccountOrder` | 2 | 3 | 2 | src/backend/big-account-order-store.js(2), src/main.js(1) |
| `removeStatementSessionEntriesByFilePath` | 2 | 3 | 1 | src/main-process/statement-session.js(2), src/main.js(1) |
| `reportStartupFailure` | 2 | 3 | 1 | src/backend/startup-failure.js(2), src/main.js(1) |
| `runAllScenarios` | 2 | 3 | 2 | src/main-process/scenario-dispatcher.js(2), src/main.js(1) |
| `runOwnAccountsMigration` | 2 | 3 | 2 | src/backend/database/own-accounts-migration.js(2), src/main.js(1) |
| `runReconIdFix` | 2 | 3 | 2 | src/main-process/recon-id-fix-engine.js(2), src/main.js(1) |
| `toBalanceRows` | 2 | 3 | 1 | src/main-process/monthly-balance.js(2), src/main.js(1) |
| `updateRunStats` | 2 | 3 | 1 | src/backend/pending-db/diff-repository.js(2), src/backend/pending-reconcile/engine.js(1) |
| `upsertMonthMeta` | 2 | 3 | 1 | src/backend/pending-db/month-repository.js(2), src/backend/pending-import/worker.js(1) |
| `writeBankStatementOutput` | 2 | 3 | 1 | src/main-process/exceljs-writer.js(2), src/main-process/bank-statement-io.js(1) |
| `writeBigAccountMode` | 2 | 3 | 2 | src/backend/big-account-mode-store.js(2), src/main.js(1) |
| `writeBigAccountOrder` | 2 | 3 | 2 | src/backend/big-account-order-store.js(2), src/main.js(1) |
| `BALANCE_SEED_GENERATION_METHODS` | 2 | 2 | 1 | src/backend/balance-seed-store.js(1), src/main.js(1) |
| `readBankStatement` | 2 | 2 | 1 | src/main-process/bank-statement-io.js(1), src/main.js(1) |
| `readGatewayRecon` | 2 | 2 | 1 | src/main-process/bank-statement-io.js(1), src/main.js(1) |
| `readReconIdFixFile` | 2 | 2 | 1 | src/main-process/recon-id-fix-io.js(1), src/main.js(1) |
| `WINDOWS_RESERVED_NAMES` | 2 | 2 | 2 | src/main-process/bank-statement-io.js(1), src/main-process/recon-id-fix-io.js(1) |

