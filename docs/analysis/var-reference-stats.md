# 代码库变量引用统计（自动生成）

> 由 `scripts/scan-vars.js` 自动生成，请不要手改。手工维护的重要变量清单在 `rules/important-variables.md`。

| 字段 | 值 |
|---|---|
| 版本 | v2.0.0-beta.1 |
| 扫描时间 | 2026-4-23 19:52:34 |
| 扫描目录 | `src/` |
| JS 文件数 | 28 |
| 顶层声明总数 | 355 |
| ≥2 次引用 | 302 |
| 跨 ≥3 文件 (A-share) | 66 |
| 跨 2 文件 (A-pair) | 90 |
| 单文件 (A-local) | 146 |
| 跨文件合计 (B) | 156 |

---

## A-share — 跨 ≥3 文件共享

| 名字 | 跨度 | 总次数 | 声明数 | 声明位置（首个） |
|---|---:|---:|---:|---|
| `path` | 14 | 42 | 14 | src/backend/balance-adjustment-store.js |
| `normalizeCell` | 13 | 99 | 8 | src/backend/balance-adjustment-store.js |
| `fs` | 12 | 38 | 12 | src/backend/balance-adjustment-store.js |
| `FileValidationError` | 9 | 42 | 5 | src/backend/balance-seed-store.js |
| `parseNumericValue` | 5 | 26 | 2 | src/backend/balance-seed-store.js |
| `readRows` | 5 | 12 | 2 | src/backend/bank-account-import.js |
| `saveMappings` | 5 | 9 | 1 | src/backend/database/template-repository.js |
| `deleteTemplate` | 5 | 7 | 1 | src/backend/database/template-repository.js |
| `XLSX` | 4 | 27 | 4 | src/backend/file-service/normalizers.js |
| `FIXED_FIELD_VALUE_PREFIX` | 4 | 21 | 2 | src/backend/database/utils.js |
| `MERCHANT_ID_SELF_INPUT_OPTION` | 4 | 17 | 2 | src/main.js |
| `BALANCE_CALCULATED_OPTION` | 4 | 14 | 2 | src/main.js |
| `ADVANCED_MAPPING_FIELDS` | 4 | 11 | 2 | src/main.js |
| `parseDateValue` | 4 | 11 | 1 | src/backend/file-service/normalizers.js |
| `app` | 4 | 10 | 1 | src/main.js |
| `listTemplates` | 4 | 8 | 1 | src/backend/database/template-repository.js |
| `saveBillSplitAmountRules` | 4 | 8 | 1 | src/backend/database/template-repository.js |
| `saveBillSplitMeta` | 4 | 8 | 1 | src/backend/database/template-repository.js |
| `writeWorkbookRows` | 4 | 8 | 2 | src/backend/file-service.js |
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
| `dialog` | 3 | 241 | 1 | src/main.js |
| `state` | 3 | 138 | 1 | src/renderer.js |
| `elements` | 3 | 114 | 1 | src/renderer.js |
| `setStatus` | 3 | 77 | 1 | src/renderer.js |
| `normalizeText` | 3 | 70 | 2 | src/backend/database/migrations.js |
| `lastGeneratedExports` | 3 | 24 | 1 | src/main.js |
| `CONCAT_FIELDS_MAPPING_FIELD` | 3 | 17 | 2 | src/main.js |
| `BALANCE_DISABLED_OPTION` | 3 | 16 | 2 | src/main.js |
| `inferDateCellFormat` | 3 | 9 | 1 | src/backend/file-service/normalizers.js |
| `toExcelSerial` | 3 | 9 | 1 | src/backend/file-service/normalizers.js |
| `AMOUNT_BASED_ACCOUNT_MAPPING_FIELD` | 3 | 8 | 2 | src/main.js |
| `AMOUNT_BASED_NAME_MAPPING_FIELD` | 3 | 8 | 2 | src/main.js |
| `AMOUNT_SPLIT_BY_FIELD_ENABLED_OPTION` | 3 | 8 | 2 | src/main.js |
| `AMOUNT_SPLIT_BY_FIELD_MAPPING_FIELD` | 3 | 8 | 2 | src/main.js |
| `cloneRowsWithMetadata` | 3 | 8 | 1 | src/main-process/statement-session.js |
| `getTemplateBigAccounts` | 3 | 8 | 1 | src/backend/database/template-repository.js |
| `setSetting` | 3 | 8 | 1 | src/backend/database/settings-repository.js |
| `SIGNED_AMOUNT_MAPPING_FIELD` | 3 | 8 | 2 | src/main.js |
| `getSetting` | 3 | 7 | 1 | src/backend/database/settings-repository.js |
| `normalizeInputFilePaths` | 3 | 7 | 1 | src/main-process/statement-session.js |
| `compileRegexLiteral` | 3 | 6 | 1 | src/backend/file-service/normalizers.js |
| `getAmountSplitRules` | 3 | 6 | 1 | src/backend/database/template-repository.js |
| `groupBigAccountRows` | 3 | 6 | 2 | src/backend/database/utils.js |
| `isRegexLiteral` | 3 | 6 | 1 | src/backend/file-service/normalizers.js |
| `loadCurrencyMappings` | 3 | 6 | 2 | src/backend/file-service.js |
| `loadEnumValues` | 3 | 6 | 1 | src/backend/file-service/readers.js |
| `readRowsWithMetadata` | 3 | 6 | 1 | src/backend/file-service/readers.js |
| `resolveSinglePreparedFieldValue` | 3 | 6 | 1 | src/main-process/statement-session.js |
| `SUPPORTED_EXTENSIONS` | 3 | 6 | 1 | src/backend/file-service/common.js |
| `ALL_BANKS_TEMPLATE_SCOPE` | 3 | 5 | 2 | src/main-process/monthly-balance.js |
| `calculateEndingBalanceFromAmounts` | 3 | 5 | 1 | src/backend/file-service/normalizers.js |
| `getStatementSessionEntries` | 3 | 5 | 1 | src/main-process/statement-session.js |
| `inferEndingBalance` | 3 | 5 | 1 | src/backend/file-service/normalizers.js |
| `mergeMappedDetailRows` | 3 | 5 | 1 | src/main-process/statement-session.js |
| `sanitizeBankName` | 3 | 4 | 3 | src/backend/balance-adjustment-store.js |

## A-pair — 跨 2 文件

| 名字 | 总次数 | 声明位置（首个） |
|---|---:|---|
| `templateRepository` | 33 | src/backend/database.js |
| `MODULES` | 23 | src/renderer.js |
| `setCurrentModule` | 20 | src/renderer.js |
| `hasColumn` | 17 | src/backend/database/migrations.js |
| `refreshTemplates` | 14 | src/renderer.js |
| `sanitizeAmountValue` | 14 | src/backend/file-service/normalizers.js |
| `settingsRepository` | 13 | src/backend/database.js |
| `getCurrencyOptionEntries` | 12 | src/renderer.js |
| `pad` | 12 | src/backend/logger.js |
| `applyStatementResult` | 11 | src/renderer.js |
| `getTemplate` | 10 | src/backend/database/template-repository.js |
| `setNewAccountStatus` | 10 | src/renderer.js |
| `hasEffectiveAmount` | 9 | src/backend/file-service/normalizers.js |
| `isRowMeaningful` | 9 | src/backend/file-service/common.js |
| `getNewAccountStatusTitle` | 8 | src/renderer.js |
| `setNewAccountExportAvailability` | 8 | src/renderer.js |
| `applyManualBalancePromptStatus` | 7 | src/renderer.js |
| `FILENAME_MAPPING_TEMPLATE_ID` | 7 | src/main.js |
| `roundAmount` | 7 | src/backend/file-service/normalizers.js |
| `syncNewAccountCurrencyMode` | 7 | src/renderer.js |
| `buildTemplateSummaryFromRow` | 6 | src/backend/database/utils.js |
| `ensureAccountMappingCurrencySupport` | 6 | src/backend/database/migrations.js |
| `ensureAccountMappingTemplateSupport` | 6 | src/backend/database/migrations.js |
| `ensureAmountSplitRulesSupport` | 6 | src/backend/database/migrations.js |
| `ensureBillSplitMergeSupport` | 6 | src/backend/database/migrations.js |
| `ensureBillSplitTargetSeqSupport` | 6 | src/backend/database/migrations.js |
| `ensureParentTemplateSupport` | 6 | src/backend/database/migrations.js |
| `ensureTemplateBigAccountNatureSupport` | 6 | src/backend/database/migrations.js |
| `ensureTemplateDateFormatSupport` | 6 | src/backend/database/migrations.js |
| `ensureTemplateFilenameFixedFieldSupport` | 6 | src/backend/database/migrations.js |
| `ensureTemplateKeySupport` | 6 | src/backend/database/migrations.js |
| `ensureTemplateMappingEnhancements` | 6 | src/backend/database/migrations.js |
| `getCurrencyOptionLabel` | 6 | src/renderer.js |
| `matchAmountSplitConditionValue` | 6 | src/backend/file-service/normalizers.js |
| `normalizeDateExportValue` | 6 | src/backend/file-service/normalizers.js |
| `openBackgroundPalette` | 6 | src/renderer.js |
| `parseJsonArray` | 6 | src/backend/database/utils.js |
| `setExportAvailability` | 6 | src/renderer.js |
| `splitSignedAmountValue` | 6 | src/backend/file-service/normalizers.js |
| `updateNewAccountGenerateAvailability` | 6 | src/renderer.js |
| `ensureSupportedFile` | 5 | src/backend/file-service/readers.js |
| `getBillSplitAmountRules` | 5 | src/backend/database/template-repository.js |
| `getBillSplitMappings` | 5 | src/backend/database/template-repository.js |
| `getBillSplitMeta` | 5 | src/backend/database/template-repository.js |
| `getBillSplitRows` | 5 | src/backend/database/template-repository.js |
| `getTemplateMappings` | 5 | src/backend/database/template-repository.js |
| `performance` | 5 | src/main.js |
| `setNewAccountOpenDateValue` | 5 | src/renderer.js |
| `statementImportSessions` | 5 | src/main.js |
| `buildMappedRows` | 4 | src/backend/file-service.js |
| `extractEnumValuesFromImportedFile` | 4 | src/backend/file-service/readers.js |
| `getBackgroundConfig` | 4 | src/backend/database/settings-repository.js |
| `getCurrencySuggestion` | 4 | src/renderer.js |
| `getEnumConfig` | 4 | src/backend/database/settings-repository.js |
| `getTemplateByKey` | 4 | src/backend/database/template-repository.js |
| `getTemplateByName` | 4 | src/backend/database/template-repository.js |
| `isFilenameMappingMode` | 4 | src/main.js |
| `listAccountMappings` | 4 | src/backend/database/settings-repository.js |
| `listChildTemplates` | 4 | src/backend/database/template-repository.js |
| `listTemplateBundleEntries` | 4 | src/backend/database/template-repository.js |
| `MERCHANT_ID_MULTI_ACCOUNT_MARKER` | 4 | src/backend/database/utils.js |
| `normalizeCurrencyOptionEntry` | 4 | src/renderer.js |
| `randomUUID` | 4 | src/backend/database/migrations.js |
| `renameTemplate` | 4 | src/backend/database/template-repository.js |
| `resolveCurrencyValue` | 4 | src/backend/file-service/normalizers.js |
| `saveAccountMappings` | 4 | src/backend/database/settings-repository.js |
| `saveTemplateFilenameFixedField` | 4 | src/backend/database/template-repository.js |
| `setBackgroundConfig` | 4 | src/backend/database/settings-repository.js |
| `setEnumConfig` | 4 | src/backend/database/settings-repository.js |
| `trimTrailingEmptyCells` | 4 | src/backend/file-service/common.js |
| `upsertTemplate` | 4 | src/backend/database/template-repository.js |
| `AppDatabase` | 3 | src/backend/database.js |
| `appendStatementSessionImport` | 3 | src/main-process/statement-session.js |
| `assembleMonthlyBalance` | 3 | src/main-process/monthly-balance.js |
| `buildDetailExportRows` | 3 | src/backend/file-service.js |
| `buildStatementFileEntry` | 3 | src/main-process/statement-session.js |
| `createStatementGenerationHelpers` | 3 | src/main-process/statement-generation.js |
| `getOrCreateStatementImportSession` | 3 | src/main-process/statement-session.js |
| `getTemplatesByBankName` | 3 | src/backend/database/template-repository.js |
| `parseBankAccountExcel` | 3 | src/backend/bank-account-import.js |
| `readBigAccountMode` | 3 | src/backend/big-account-mode-store.js |
| `readBigAccountOrder` | 3 | src/backend/big-account-order-store.js |
| `removeStatementSessionEntriesByFilePath` | 3 | src/main-process/statement-session.js |
| `reportStartupFailure` | 3 | src/backend/startup-failure.js |
| `runOwnAccountsMigration` | 3 | src/backend/database/own-accounts-migration.js |
| `toBalanceRows` | 3 | src/main-process/monthly-balance.js |
| `writeBigAccountMode` | 3 | src/backend/big-account-mode-store.js |
| `writeBigAccountOrder` | 3 | src/backend/big-account-order-store.js |
| `BALANCE_SEED_GENERATION_METHODS` | 2 | src/backend/balance-seed-store.js |
| `sanitizeFileName` | 2 | src/backend/balance-seed-store.js |

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

### `src/backend/database/own-accounts-migration.js`

| 名字 | 总次数 |
|---|---:|
| `appendMigrationLog` | 8 |
| `MIGRATION_FLAG_KEY` | 5 |
| `getMigrationLogPath` | 3 |
| `MIGRATION_LOG_FILENAME` | 3 |

### `src/backend/database/template-repository.js`

| 名字 | 总次数 |
|---|---:|
| `getTemplateFixedAssignments` | 3 |

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
| `applyHeaderRowFont` | 3 |
| `buildNumericCellValue` | 3 |

### `src/backend/startup-failure.js`

| 名字 | 总次数 |
|---|---:|
| `buildStartupFailureDialogMessage` | 3 |
| `normalizeErrorMessage` | 3 |

### `src/main-process/monthly-balance.js`

| 名字 | 总次数 |
|---|---:|
| `pad2` | 4 |
| `buildTargetLastDay` | 3 |
| `isRegularTemplate` | 3 |
| `lastDayOfMonth` | 3 |
| `pickLatestSeedForAccount` | 3 |

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
| `ipcRenderer` | 61 |

### `src/renderer.js`

| 名字 | 总次数 |
|---|---:|
| `getNewAccountRowElements` | 20 |
| `getNewAccountRows` | 20 |
| `RENDERER_STARTUP_MARKS` | 20 |
| `cloneBackgroundSettings` | 12 |
| `getNewAccountRowState` | 12 |
| `rgbToCss` | 12 |
| `getRendererStartupValue` | 10 |
| `isNewAccountMultiCurrencyMode` | 10 |
| `markRendererStartup` | 10 |
| `STATEMENT_MODES` | 10 |
| `applyBackgroundSettings` | 8 |
| `clampColorChannel` | 8 |
| `handleNewAccountFormMutation` | 8 |
| `rendererStartupProfiler` | 8 |
| `closeBackgroundPalette` | 6 |
| `closeModuleMenu` | 6 |
| `closeNewAccountCurrencyDropdown` | 6 |
| `mixColor` | 6 |
| `updateNewAccountCurrencyDropdownLabel` | 6 |
| `DEFAULT_BACKGROUND_SETTINGS` | 5 |
| `DEFAULT_SPECTRUM_PICK_COLOR` | 5 |
| `hexToRgb` | 5 |
| `renderNewAccountCurrencyOptions` | 5 |
| `syncNewAccountRowActionButtons` | 5 |
| `applyStatementModeSideEffects` | 4 |
| `closeAllNewAccountCurrencyDropdowns` | 4 |
| `handleOpenAccountMappings` | 4 |
| `mixRgb` | 4 |
| `newAccountRowStateMap` | 4 |
| `normalizeColorHex` | 4 |
| `renderNewAccountCurrencyOptionsList` | 4 |
| `resetBackgroundPickerSelection` | 4 |
| `syncNewAccountDropdownFlag` | 4 |
| `updateNewAccountCurrencySuggestion` | 4 |
| `BACKGROUND_FILE_HINT` | 3 |
| `getEnumStatusMessage` | 3 |
| `getSpectrumColorAtPosition` | 3 |
| `handleExportLastError` | 3 |
| `initializeNewAccountRow` | 3 |
| `pickBackgroundColorFromClientPoint` | 3 |
| `syncNewAccountOpenDateInputType` | 3 |
| `updateSelectedColorSwatch` | 3 |
| `updateStatusBox` | 3 |

## B — 跨文件引用完整表

| 名字 | 跨度 | 总次数 | 声明数 | 前三引用位置 |
|---|---:|---:|---:|---|
| `path` | 14 | 42 | 14 | src/backend/file-service/readers.js(8), src/backend/database/own-accounts-migration.js(6), src/backend/file-service/pdf-worker.js(5) |
| `normalizeCell` | 13 | 99 | 8 | src/backend/file-service.js(34), src/backend/file-service/readers.js(13), src/backend/file-service/normalizers.js(12) |
| `fs` | 12 | 38 | 12 | src/backend/file-service/pdf-worker.js(8), src/backend/database/own-accounts-migration.js(6), src/backend/big-account-mode-store.js(5) |
| `FileValidationError` | 9 | 42 | 5 | src/backend/file-service/readers.js(17), src/backend/file-service/normalizers.js(7), src/backend/file-service.js(6) |
| `parseNumericValue` | 5 | 26 | 2 | src/backend/file-service.js(14), src/backend/file-service/writers.js(6), src/backend/file-service/normalizers.js(4) |
| `readRows` | 5 | 12 | 2 | src/backend/file-service/readers.js(4), src/backend/file-service.js(3), src/backend/bank-account-import.js(2) |
| `saveMappings` | 5 | 9 | 1 | src/renderer-dialogs.js(3), src/backend/database.js(2), src/backend/database/template-repository.js(2) |
| `deleteTemplate` | 5 | 7 | 1 | src/backend/database.js(2), src/backend/database/template-repository.js(2), src/preload.js(1) |
| `XLSX` | 4 | 27 | 4 | src/backend/file-service/writers.js(20), src/backend/file-service/normalizers.js(3), src/backend/file-service/readers.js(3) |
| `FIXED_FIELD_VALUE_PREFIX` | 4 | 21 | 2 | src/backend/file-service.js(13), src/backend/database/utils.js(5), src/backend/file-service/common.js(2) |
| `MERCHANT_ID_SELF_INPUT_OPTION` | 4 | 17 | 2 | src/renderer.js(8), src/renderer-dialogs.js(6), src/renderer-previews.js(2) |
| `BALANCE_CALCULATED_OPTION` | 4 | 14 | 2 | src/renderer-dialogs.js(5), src/renderer.js(5), src/renderer-previews.js(3) |
| `ADVANCED_MAPPING_FIELDS` | 4 | 11 | 2 | src/renderer-previews.js(4), src/renderer.js(4), src/renderer-dialogs.js(2) |
| `parseDateValue` | 4 | 11 | 1 | src/backend/file-service.js(4), src/backend/file-service/writers.js(4), src/backend/file-service/normalizers.js(2) |
| `app` | 4 | 10 | 1 | src/main.js(4), src/renderer.js(4), src/preload.js(1) |
| `listTemplates` | 4 | 8 | 1 | src/backend/database/template-repository.js(3), src/backend/database.js(2), src/main-process/monthly-balance.js(2) |
| `saveBillSplitAmountRules` | 4 | 8 | 1 | src/renderer-dialogs.js(3), src/backend/database.js(2), src/backend/database/template-repository.js(2) |
| `saveBillSplitMeta` | 4 | 8 | 1 | src/renderer-dialogs.js(3), src/backend/database.js(2), src/backend/database/template-repository.js(2) |
| `writeWorkbookRows` | 4 | 8 | 2 | src/backend/file-service.js(4), src/backend/file-service/writers.js(2), src/main-process/statement-generation.js(1) |
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
| `dialog` | 3 | 241 | 1 | src/renderer-dialogs.js(169), src/renderer.js(71), src/main.js(1) |
| `state` | 3 | 138 | 1 | src/renderer.js(122), src/renderer-dialogs.js(10), src/renderer-previews.js(6) |
| `elements` | 3 | 114 | 1 | src/renderer.js(100), src/renderer-previews.js(10), src/renderer-dialogs.js(4) |
| `setStatus` | 3 | 77 | 1 | src/renderer.js(44), src/renderer-dialogs.js(32), src/renderer-previews.js(1) |
| `normalizeText` | 3 | 70 | 2 | src/backend/database/template-repository.js(57), src/backend/database/utils.js(10), src/backend/database/migrations.js(3) |
| `lastGeneratedExports` | 3 | 24 | 1 | src/main-process/statement-generation.js(17), src/main-process/statement-session.js(6), src/main.js(1) |
| `CONCAT_FIELDS_MAPPING_FIELD` | 3 | 17 | 2 | src/renderer-dialogs.js(14), src/renderer.js(2), src/main.js(1) |
| `BALANCE_DISABLED_OPTION` | 3 | 16 | 2 | src/renderer-dialogs.js(9), src/renderer.js(6), src/main.js(1) |
| `inferDateCellFormat` | 3 | 9 | 1 | src/backend/file-service/writers.js(4), src/backend/file-service.js(3), src/backend/file-service/normalizers.js(2) |
| `toExcelSerial` | 3 | 9 | 1 | src/backend/file-service/writers.js(4), src/backend/file-service.js(3), src/backend/file-service/normalizers.js(2) |
| `AMOUNT_BASED_ACCOUNT_MAPPING_FIELD` | 3 | 8 | 2 | src/renderer-previews.js(3), src/renderer.js(3), src/main.js(2) |
| `AMOUNT_BASED_NAME_MAPPING_FIELD` | 3 | 8 | 2 | src/renderer-previews.js(3), src/renderer.js(3), src/main.js(2) |
| `AMOUNT_SPLIT_BY_FIELD_ENABLED_OPTION` | 3 | 8 | 2 | src/renderer-dialogs.js(5), src/renderer.js(2), src/main.js(1) |
| `AMOUNT_SPLIT_BY_FIELD_MAPPING_FIELD` | 3 | 8 | 2 | src/renderer-dialogs.js(3), src/renderer.js(3), src/main.js(2) |
| `cloneRowsWithMetadata` | 3 | 8 | 1 | src/main-process/statement-session.js(5), src/main-process/statement-generation.js(2), src/main.js(1) |
| `getTemplateBigAccounts` | 3 | 8 | 1 | src/backend/database/template-repository.js(4), src/backend/database.js(2), src/main-process/monthly-balance.js(2) |
| `setSetting` | 3 | 8 | 1 | src/backend/database/settings-repository.js(4), src/backend/database.js(2), src/backend/database/own-accounts-migration.js(2) |
| `SIGNED_AMOUNT_MAPPING_FIELD` | 3 | 8 | 2 | src/renderer-previews.js(3), src/renderer.js(3), src/main.js(2) |
| `getSetting` | 3 | 7 | 1 | src/backend/database/settings-repository.js(4), src/backend/database.js(2), src/backend/database/own-accounts-migration.js(1) |
| `normalizeInputFilePaths` | 3 | 7 | 1 | src/main-process/statement-generation.js(4), src/main-process/statement-session.js(2), src/main.js(1) |
| `compileRegexLiteral` | 3 | 6 | 1 | src/backend/file-service/normalizers.js(3), src/backend/file-service.js(2), src/main.js(1) |
| `getAmountSplitRules` | 3 | 6 | 1 | src/backend/database/template-repository.js(3), src/backend/database.js(2), src/preload.js(1) |
| `groupBigAccountRows` | 3 | 6 | 2 | src/backend/database/template-repository.js(3), src/backend/database/utils.js(2), src/main.js(1) |
| `isRegexLiteral` | 3 | 6 | 1 | src/backend/file-service/normalizers.js(3), src/backend/file-service.js(2), src/main.js(1) |
| `loadCurrencyMappings` | 3 | 6 | 2 | src/backend/file-service.js(3), src/backend/file-service/normalizers.js(2), src/main.js(1) |
| `loadEnumValues` | 3 | 6 | 1 | src/backend/file-service/readers.js(3), src/backend/file-service.js(2), src/main.js(1) |
| `readRowsWithMetadata` | 3 | 6 | 1 | src/backend/file-service.js(3), src/backend/file-service/readers.js(2), src/main.js(1) |
| `resolveSinglePreparedFieldValue` | 3 | 6 | 1 | src/main-process/statement-generation.js(3), src/main-process/statement-session.js(2), src/main.js(1) |
| `SUPPORTED_EXTENSIONS` | 3 | 6 | 1 | src/backend/file-service.js(2), src/backend/file-service/common.js(2), src/backend/file-service/readers.js(2) |
| `ALL_BANKS_TEMPLATE_SCOPE` | 3 | 5 | 2 | src/main-process/monthly-balance.js(3), src/main.js(1), src/renderer.js(1) |
| `calculateEndingBalanceFromAmounts` | 3 | 5 | 1 | src/backend/file-service.js(2), src/backend/file-service/normalizers.js(2), src/main.js(1) |
| `getStatementSessionEntries` | 3 | 5 | 1 | src/main-process/statement-generation.js(2), src/main-process/statement-session.js(2), src/main.js(1) |
| `inferEndingBalance` | 3 | 5 | 1 | src/backend/file-service.js(2), src/backend/file-service/normalizers.js(2), src/main.js(1) |
| `mergeMappedDetailRows` | 3 | 5 | 1 | src/main-process/statement-generation.js(2), src/main-process/statement-session.js(2), src/main.js(1) |
| `sanitizeBankName` | 3 | 4 | 3 | src/backend/database/own-accounts-migration.js(2), src/backend/balance-adjustment-store.js(1), src/backend/own-account-store.js(1) |
| `templateRepository` | 2 | 33 | 2 | src/backend/database.js(30), src/backend/database/own-accounts-migration.js(3) |
| `MODULES` | 2 | 23 | 1 | src/renderer-previews.js(16), src/renderer.js(7) |
| `setCurrentModule` | 2 | 20 | 1 | src/renderer-previews.js(16), src/renderer.js(4) |
| `hasColumn` | 2 | 17 | 1 | src/backend/database/migrations.js(14), src/backend/database.js(3) |
| `refreshTemplates` | 2 | 14 | 1 | src/renderer.js(8), src/renderer-dialogs.js(6) |
| `sanitizeAmountValue` | 2 | 14 | 1 | src/backend/file-service.js(11), src/backend/file-service/normalizers.js(3) |
| `settingsRepository` | 2 | 13 | 2 | src/backend/database.js(9), src/backend/database/own-accounts-migration.js(4) |
| `getCurrencyOptionEntries` | 2 | 12 | 1 | src/renderer.js(7), src/renderer-dialogs.js(5) |
| `pad` | 2 | 12 | 2 | src/backend/logger.js(11), src/main.js(1) |
| `applyStatementResult` | 2 | 11 | 1 | src/renderer.js(6), src/renderer-dialogs.js(5) |
| `getTemplate` | 2 | 10 | 1 | src/backend/database/template-repository.js(8), src/backend/database.js(2) |
| `setNewAccountStatus` | 2 | 10 | 1 | src/renderer.js(8), src/renderer-previews.js(2) |
| `hasEffectiveAmount` | 2 | 9 | 1 | src/backend/file-service.js(7), src/backend/file-service/normalizers.js(2) |
| `isRowMeaningful` | 2 | 9 | 1 | src/backend/file-service/readers.js(7), src/backend/file-service/common.js(2) |
| `getNewAccountStatusTitle` | 2 | 8 | 1 | src/renderer.js(6), src/renderer-previews.js(2) |
| `setNewAccountExportAvailability` | 2 | 8 | 1 | src/renderer.js(6), src/renderer-previews.js(2) |
| `applyManualBalancePromptStatus` | 2 | 7 | 1 | src/renderer.js(4), src/renderer-dialogs.js(3) |
| `FILENAME_MAPPING_TEMPLATE_ID` | 2 | 7 | 2 | src/renderer.js(5), src/main.js(2) |
| `roundAmount` | 2 | 7 | 1 | src/backend/file-service/normalizers.js(5), src/backend/file-service.js(2) |
| `syncNewAccountCurrencyMode` | 2 | 7 | 1 | src/renderer.js(5), src/renderer-previews.js(2) |
| `buildTemplateSummaryFromRow` | 2 | 6 | 1 | src/backend/database/template-repository.js(4), src/backend/database/utils.js(2) |
| `ensureAccountMappingCurrencySupport` | 2 | 6 | 1 | src/backend/database.js(4), src/backend/database/migrations.js(2) |
| `ensureAccountMappingTemplateSupport` | 2 | 6 | 1 | src/backend/database.js(4), src/backend/database/migrations.js(2) |
| `ensureAmountSplitRulesSupport` | 2 | 6 | 1 | src/backend/database.js(4), src/backend/database/migrations.js(2) |
| `ensureBillSplitMergeSupport` | 2 | 6 | 1 | src/backend/database.js(4), src/backend/database/migrations.js(2) |
| `ensureBillSplitTargetSeqSupport` | 2 | 6 | 1 | src/backend/database.js(4), src/backend/database/migrations.js(2) |
| `ensureParentTemplateSupport` | 2 | 6 | 1 | src/backend/database.js(4), src/backend/database/migrations.js(2) |
| `ensureTemplateBigAccountNatureSupport` | 2 | 6 | 1 | src/backend/database.js(4), src/backend/database/migrations.js(2) |
| `ensureTemplateDateFormatSupport` | 2 | 6 | 1 | src/backend/database.js(4), src/backend/database/migrations.js(2) |
| `ensureTemplateFilenameFixedFieldSupport` | 2 | 6 | 1 | src/backend/database.js(4), src/backend/database/migrations.js(2) |
| `ensureTemplateKeySupport` | 2 | 6 | 1 | src/backend/database.js(4), src/backend/database/migrations.js(2) |
| `ensureTemplateMappingEnhancements` | 2 | 6 | 1 | src/backend/database.js(4), src/backend/database/migrations.js(2) |
| `getCurrencyOptionLabel` | 2 | 6 | 1 | src/renderer.js(5), src/renderer-dialogs.js(1) |
| `matchAmountSplitConditionValue` | 2 | 6 | 1 | src/backend/file-service.js(4), src/backend/file-service/normalizers.js(2) |
| `normalizeDateExportValue` | 2 | 6 | 1 | src/backend/file-service.js(3), src/backend/file-service/normalizers.js(3) |
| `openBackgroundPalette` | 2 | 6 | 1 | src/renderer.js(5), src/renderer-previews.js(1) |
| `parseJsonArray` | 2 | 6 | 1 | src/backend/database/template-repository.js(3), src/backend/database/utils.js(3) |
| `setExportAvailability` | 2 | 6 | 1 | src/renderer.js(5), src/renderer-previews.js(1) |
| `splitSignedAmountValue` | 2 | 6 | 1 | src/backend/file-service.js(4), src/backend/file-service/normalizers.js(2) |
| `updateNewAccountGenerateAvailability` | 2 | 6 | 1 | src/renderer.js(4), src/renderer-previews.js(2) |
| `ensureSupportedFile` | 2 | 5 | 1 | src/backend/file-service/readers.js(3), src/backend/file-service.js(2) |
| `getBillSplitAmountRules` | 2 | 5 | 1 | src/backend/database/template-repository.js(3), src/backend/database.js(2) |
| `getBillSplitMappings` | 2 | 5 | 1 | src/backend/database/template-repository.js(3), src/backend/database.js(2) |
| `getBillSplitMeta` | 2 | 5 | 1 | src/backend/database/template-repository.js(3), src/backend/database.js(2) |
| `getBillSplitRows` | 2 | 5 | 1 | src/backend/database/template-repository.js(3), src/backend/database.js(2) |
| `getTemplateMappings` | 2 | 5 | 1 | src/backend/database/template-repository.js(3), src/backend/database.js(2) |
| `performance` | 2 | 5 | 1 | src/renderer.js(3), src/main.js(2) |
| `setNewAccountOpenDateValue` | 2 | 5 | 1 | src/renderer.js(3), src/renderer-previews.js(2) |
| `statementImportSessions` | 2 | 5 | 1 | src/main-process/statement-session.js(4), src/main.js(1) |
| `buildMappedRows` | 2 | 4 | 1 | src/backend/file-service.js(3), src/main.js(1) |
| `extractEnumValuesFromImportedFile` | 2 | 4 | 1 | src/backend/file-service.js(2), src/backend/file-service/readers.js(2) |
| `getBackgroundConfig` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/settings-repository.js(2) |
| `getCurrencySuggestion` | 2 | 4 | 1 | src/renderer-dialogs.js(2), src/renderer.js(2) |
| `getEnumConfig` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/settings-repository.js(2) |
| `getTemplateByKey` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/template-repository.js(2) |
| `getTemplateByName` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/template-repository.js(2) |
| `isFilenameMappingMode` | 2 | 4 | 2 | src/renderer.js(3), src/main.js(1) |
| `listAccountMappings` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/settings-repository.js(2) |
| `listChildTemplates` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/template-repository.js(2) |
| `listTemplateBundleEntries` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/template-repository.js(2) |
| `MERCHANT_ID_MULTI_ACCOUNT_MARKER` | 2 | 4 | 2 | src/backend/database/utils.js(3), src/main.js(1) |
| `normalizeCurrencyOptionEntry` | 2 | 4 | 1 | src/renderer-dialogs.js(2), src/renderer.js(2) |
| `randomUUID` | 2 | 4 | 2 | src/backend/database/migrations.js(2), src/backend/database/template-repository.js(2) |
| `renameTemplate` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/template-repository.js(2) |
| `resolveCurrencyValue` | 2 | 4 | 1 | src/backend/file-service.js(2), src/backend/file-service/normalizers.js(2) |
| `saveAccountMappings` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/settings-repository.js(2) |
| `saveTemplateFilenameFixedField` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/template-repository.js(2) |
| `setBackgroundConfig` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/settings-repository.js(2) |
| `setEnumConfig` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/settings-repository.js(2) |
| `trimTrailingEmptyCells` | 2 | 4 | 1 | src/backend/file-service/common.js(2), src/backend/file-service/readers.js(2) |
| `upsertTemplate` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/template-repository.js(2) |
| `AppDatabase` | 2 | 3 | 2 | src/backend/database.js(2), src/main.js(1) |
| `appendStatementSessionImport` | 2 | 3 | 1 | src/main-process/statement-session.js(2), src/main.js(1) |
| `assembleMonthlyBalance` | 2 | 3 | 1 | src/main-process/monthly-balance.js(2), src/main.js(1) |
| `buildDetailExportRows` | 2 | 3 | 1 | src/backend/file-service.js(2), src/main.js(1) |
| `buildStatementFileEntry` | 2 | 3 | 1 | src/main-process/statement-session.js(2), src/main.js(1) |
| `createStatementGenerationHelpers` | 2 | 3 | 1 | src/main-process/statement-generation.js(2), src/main.js(1) |
| `getOrCreateStatementImportSession` | 2 | 3 | 1 | src/main-process/statement-session.js(2), src/main.js(1) |
| `getTemplatesByBankName` | 2 | 3 | 1 | src/backend/database/template-repository.js(2), src/backend/database/own-accounts-migration.js(1) |
| `parseBankAccountExcel` | 2 | 3 | 2 | src/backend/bank-account-import.js(2), src/main.js(1) |
| `readBigAccountMode` | 2 | 3 | 2 | src/backend/big-account-mode-store.js(2), src/main.js(1) |
| `readBigAccountOrder` | 2 | 3 | 2 | src/backend/big-account-order-store.js(2), src/main.js(1) |
| `removeStatementSessionEntriesByFilePath` | 2 | 3 | 1 | src/main-process/statement-session.js(2), src/main.js(1) |
| `reportStartupFailure` | 2 | 3 | 1 | src/backend/startup-failure.js(2), src/main.js(1) |
| `runOwnAccountsMigration` | 2 | 3 | 2 | src/backend/database/own-accounts-migration.js(2), src/main.js(1) |
| `toBalanceRows` | 2 | 3 | 1 | src/main-process/monthly-balance.js(2), src/main.js(1) |
| `writeBigAccountMode` | 2 | 3 | 2 | src/backend/big-account-mode-store.js(2), src/main.js(1) |
| `writeBigAccountOrder` | 2 | 3 | 2 | src/backend/big-account-order-store.js(2), src/main.js(1) |
| `BALANCE_SEED_GENERATION_METHODS` | 2 | 2 | 1 | src/backend/balance-seed-store.js(1), src/main.js(1) |
| `sanitizeFileName` | 2 | 2 | 2 | src/backend/balance-seed-store.js(1), src/main.js(1) |

