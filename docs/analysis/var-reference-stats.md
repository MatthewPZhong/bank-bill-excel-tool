# 代码库变量引用统计（自动生成）

> 由 `scripts/scan-vars.js` 自动生成，请不要手改。手工维护的重要变量清单在 `rules/important-variables.md`。

| 字段 | 值 |
|---|---|
| 版本 | v3.0.4 |
| 扫描时间 | 2026-6-15 15:22:23 |
| 扫描目录 | `src/` |
| JS 文件数 | 155 |
| 顶层声明总数 | 1613 |
| ≥2 次引用 | 1491 |
| 跨 ≥3 文件 (A-share) | 271 |
| 跨 2 文件 (A-pair) | 457 |
| 单文件 (A-local) | 763 |
| 跨文件合计 (B) | 728 |

---

## A-share — 跨 ≥3 文件共享

| 名字 | 跨度 | 总次数 | 声明数 | 声明位置（首个） |
|---|---:|---:|---:|---|
| `path` | 56 | 169 | 50 | src/backend/acquiring-bill-currency-import/reader-handrolled.js |
| `fs` | 40 | 123 | 39 | src/backend/balance-adjustment-store.js |
| `parse` | 25 | 50 | 1 | src/backend/usage-stats.js |
| `normalizeCell` | 21 | 113 | 10 | src/backend/balance-adjustment-store.js |
| `FileValidationError` | 18 | 82 | 9 | src/backend/balance-seed-store.js |
| `normalizeCellValue` | 15 | 152 | 6 | src/main-process/adm-bank-deposit-builder.js |
| `appendModuleLog` | 15 | 77 | 11 | src/backend/database.js |
| `FLOW_HEADERS` | 14 | 35 | 8 | src/backend/acquiring-bill-currency-db/columns.js |
| `validateHeaders` | 14 | 34 | 3 | src/backend/pending-import/contract-pending.js |
| `XLSX` | 13 | 69 | 13 | src/backend/bank-bu-recon-import/reader.js |
| `applyWatermark` | 13 | 31 | 13 | src/backend/file-service/writers.js |
| `makeWarningCollector` | 13 | 26 | 4 | src/main-process/scenario-engines/boc-dispatch-order-fix.js |
| `DatabaseSync` | 12 | 28 | 6 | src/backend/biz-op-recon-import/import-worker.js |
| `parseNumber` | 11 | 34 | 4 | src/backend/pending-reconcile/removal-match.js |
| `pad` | 10 | 66 | 2 | src/backend/logger.js |
| `PENDING_COLUMNS` | 10 | 39 | 10 | src/backend/pending-db/migrations.js |
| `BANK_STATEMENT_FIELDS` | 10 | 31 | 9 | src/backend/database/linked-table-repository.js |
| `validateFlowHeaders` | 10 | 20 | 8 | src/backend/acquiring-bill-currency-import/contract-flow.js |
| `FLOW_DB_COLUMNS` | 9 | 27 | 3 | src/backend/biz-op-recon-db/columns.js |
| `listMonths` | 9 | 20 | 4 | src/backend/acquiring-bill-currency-db/import-repository.js |
| `insertRun` | 9 | 13 | 4 | src/backend/acquiring-bill-currency-db/run-repository.js |
| `RUNS_TABLE` | 8 | 66 | 8 | src/backend/acquiring-bill-currency-db/run-repository.js |
| `isRowMeaningful` | 8 | 20 | 2 | src/backend/file-service/common.js |
| `runReconciliation` | 8 | 18 | 5 | src/backend/pending-reconcile/engine.js |
| `FIELD_MAP` | 7 | 103 | 6 | src/constants/adm-bank-deposit-fields.js |
| `runRepository` | 7 | 46 | 7 | src/backend/biz-op-recon-import/import-worker.js |
| `toDate` | 7 | 26 | 6 | src/main-process/scenario-engines/engine-date-utils.js |
| `ExcelJS` | 7 | 19 | 7 | src/main-process/acquiring-bill-currency-writer.js |
| `makeModificationCollector` | 7 | 14 | 1 | src/main-process/scenario-engines/engine-utils.js |
| `createContract` | 7 | 13 | 4 | src/backend/acquiring-bill-currency-import/contract-bill.js |
| `getRunById` | 7 | 12 | 3 | src/backend/acquiring-bill-currency-db/run-repository.js |
| `mapRow` | 7 | 10 | 1 | src/backend/pending-import/removed-reader.js |
| `state` | 6 | 310 | 1 | src/renderer.js |
| `session` | 6 | 60 | 3 | src/main-process/acquiring-bill-currency-run-data.js |
| `MAX_COLLECTED_ERRORS` | 6 | 21 | 5 | src/backend/acquiring-bill-currency-import/contract-bill.js |
| `BILL_HEADERS` | 6 | 18 | 6 | src/backend/acquiring-bill-currency-db/columns.js |
| `BIZ_OP_DB_COLUMNS` | 6 | 18 | 2 | src/backend/biz-op-recon-db/columns.js |
| `GATEWAY_BILL_FIELDS` | 6 | 14 | 4 | src/constants/adm-bank-deposit-fields.js |
| `normalizeDateExportValue` | 6 | 14 | 4 | src/backend/database/linked-table-repository.js |
| `deserializeError` | 6 | 10 | 1 | src/main-process/serialize-error.js |
| `dialog` | 5 | 483 | 1 | src/main.js |
| `setCurrentModule` | 5 | 60 | 2 | src/backend/database/settings-repository.js |
| `parseNumericValue` | 5 | 26 | 2 | src/backend/balance-seed-store.js |
| `serializeError` | 5 | 26 | 1 | src/main-process/serialize-error.js |
| `CancelError` | 5 | 16 | 3 | src/backend/big-table-import/engine.js |
| `TEMPLATE_BILL_HEADERS` | 5 | 15 | 4 | src/backend/acquiring-bill-currency-db/columns.js |
| `cancel` | 5 | 14 | 1 | src/main-process/run-check-worker-pool.js |
| `MS_PER_DAY` | 5 | 14 | 5 | src/main-process/scenario-engines/engine-date-utils.js |
| `VALID_DIRECTION_IN` | 5 | 14 | 4 | src/backend/biz-op-recon-import/validator.js |
| `BIZ_OP_HEADERS` | 5 | 13 | 1 | src/backend/biz-op-recon-db/columns.js |
| `extractMonthKey` | 5 | 13 | 5 | src/backend/acquiring-bill-currency-import/contract-bill.js |
| `getMonthMeta` | 5 | 13 | 2 | src/backend/bank-bu-recon-db/month-repository.js |
| `VALID_DIRECTION_OUT` | 5 | 12 | 4 | src/backend/biz-op-recon-import/validator.js |
| `valuesEqual` | 5 | 12 | 1 | src/main-process/scenario-engines/engine-utils.js |
| `evaluateCondition` | 5 | 11 | 1 | src/main-process/scenario-engines/engine-utils.js |
| `main` | 5 | 11 | 3 | src/backend/biz-op-recon-import/import-worker.js |
| `listRuns` | 5 | 10 | 2 | src/backend/bank-bu-recon-db/run-repository.js |
| `Worker` | 5 | 10 | 5 | src/backend/big-table-import/pipeline.js |
| `formatTimestamp` | 5 | 9 | 5 | src/backend/database/backup.js |
| `JSZip` | 5 | 9 | 5 | src/backend/biz-op-recon-import/reader-streamed.js |
| `loadSharedStrings` | 5 | 9 | 2 | src/backend/acquiring-bill-currency-import/reader.js |
| `readRows` | 5 | 9 | 2 | src/backend/bank-account-import.js |
| `saveMappings` | 5 | 9 | 1 | src/backend/database/template-repository.js |
| `getLatestRun` | 5 | 8 | 2 | src/backend/acquiring-bill-currency-db/run-repository.js |
| `deleteTemplate` | 5 | 7 | 1 | src/backend/database/template-repository.js |
| `updateRunExportPath` | 5 | 7 | 2 | src/backend/bank-bu-recon-db/run-repository.js |
| `elements` | 4 | 157 | 1 | src/renderer.js |
| `runDataStore` | 4 | 60 | 4 | src/main-process/acquiring-bill-currency-run-data.js |
| `parentPort` | 4 | 30 | 4 | src/backend/big-table-import/engine-worker-entry.js |
| `runRepo` | 4 | 28 | 4 | src/main-process/acquiring-bill-currency-run-data.js |
| `openSideDb` | 4 | 26 | 1 | src/backend/run-data-store.js |
| `FIXED_FIELD_VALUE_PREFIX` | 4 | 21 | 2 | src/backend/database/utils.js |
| `importsRepository` | 4 | 21 | 4 | src/backend/biz-op-recon-import/import-worker.js |
| `normalizeBu` | 4 | 18 | 3 | src/backend/biz-op-recon-import/import-worker.js |
| `app` | 4 | 17 | 1 | src/main.js |
| `importRepo` | 4 | 17 | 4 | src/backend/acquiring-bill-currency-import/reader-handrolled.js |
| `MERCHANT_ID_SELF_INPUT_OPTION` | 4 | 17 | 2 | src/main.js |
| `writeErrorReport` | 4 | 17 | 1 | src/main-process/exceljs-writer.js |
| `normalizeHeaderCell` | 4 | 15 | 4 | src/backend/acquiring-bill-currency-import/validator.js |
| `BALANCE_CALCULATED_OPTION` | 4 | 14 | 2 | src/main.js |
| `BILL_KEY_COLUMN_INDICES` | 4 | 12 | 4 | src/backend/acquiring-bill-currency-db/columns.js |
| `logger` | 4 | 12 | 3 | src/main-process/biz-op-recon-session.js |
| `SHARED_STRINGS_ENTRY_NAME` | 4 | 12 | 3 | src/backend/acquiring-bill-currency-import/reader.js |
| `ADVANCED_MAPPING_FIELDS` | 4 | 11 | 2 | src/main.js |
| `FLOW_KEY_COLUMN_INDICES` | 4 | 11 | 4 | src/backend/acquiring-bill-currency-db/columns.js |
| `normalizeTransactionNo` | 4 | 11 | 4 | src/backend/database/linked-table-repository.js |
| `parseDateValue` | 4 | 11 | 1 | src/backend/file-service/normalizers.js |
| `BANK_DB_COLUMNS` | 4 | 10 | 1 | src/backend/bank-bu-recon-db/columns.js |
| `CHANNEL_BILL_FIELDS` | 4 | 10 | 2 | src/constants/gateway-bill-recon-fields.js |
| `getRun` | 4 | 10 | 2 | src/backend/bank-bu-recon-db/run-repository.js |
| `listSideDbFiles` | 4 | 10 | 1 | src/backend/run-data-store.js |
| `PENDING_GUANLI_DB_COLUMNS` | 4 | 10 | 1 | src/backend/bank-bu-recon-db/columns.js |
| `sideDbExists` | 4 | 10 | 1 | src/backend/run-data-store.js |
| `BANK_HEADERS` | 4 | 9 | 1 | src/backend/bank-bu-recon-db/columns.js |
| `dispatchEngineImport` | 4 | 9 | 4 | src/main-process/acquiring-bill-currency-session.js |
| `os` | 4 | 9 | 3 | src/backend/big-table-import/pipeline.js |
| `PENDING_GUANLI_HEADERS` | 4 | 9 | 1 | src/backend/bank-bu-recon-db/columns.js |
| `streamFlowFile` | 4 | 9 | 4 | src/backend/biz-op-recon-import/import-worker.js |
| `BUSINESS_BILL_FIELDS` | 4 | 8 | 2 | src/constants/recon-id-fix-fields.js |
| `clearRunsAndDiffsByDateBu` | 4 | 8 | 1 | src/backend/biz-op-recon-db/run-repository.js |
| `ensureRowId` | 4 | 8 | 1 | src/main-process/scenario-engines/engine-utils.js |
| `getRowsByDateBu` | 4 | 8 | 2 | src/backend/biz-op-recon-db/flow-imports-repository.js |
| `isMainThread` | 4 | 8 | 4 | src/backend/big-table-import/engine-worker-entry.js |
| `listTemplates` | 4 | 8 | 1 | src/backend/database/template-repository.js |
| `OPPONENT_BILL_FIELDS` | 4 | 8 | 2 | src/constants/recon-id-fix-fields.js |
| `ORDER_REPAIR_FIELDS_GATEWAY` | 4 | 8 | 3 | src/constants/gateway-bill-recon-fields.js |
| `saveBillSplitAmountRules` | 4 | 8 | 1 | src/backend/database/template-repository.js |
| `saveBillSplitMeta` | 4 | 8 | 1 | src/backend/database/template-repository.js |
| `validateBillHeaders` | 4 | 8 | 4 | src/backend/acquiring-bill-currency-import/contract-bill.js |
| `validateFlowRow` | 4 | 8 | 3 | src/backend/biz-op-recon-import/contract-flow.js |
| `writeWorkbookRows` | 4 | 8 | 2 | src/backend/file-service.js |
| `assertXlsxEntriesUnderLimit` | 4 | 7 | 4 | src/backend/biz-op-recon-import/reader-streamed.js |
| `errorCodeToCause` | 4 | 7 | 4 | src/backend/file-service/error-causes.js |
| `insertRows` | 4 | 7 | 2 | src/backend/biz-op-recon-db/flow-imports-repository.js |
| `listAllRuns` | 4 | 7 | 1 | src/backend/pending-db/diff-repository.js |
| `readRowsWithMetadata` | 4 | 7 | 1 | src/backend/file-service/readers.js |
| `setChildParent` | 4 | 7 | 1 | src/backend/database/template-repository.js |
| `writeBalanceWorkbook` | 4 | 7 | 2 | src/backend/file-service.js |
| `clearBillSplitMergeGroups` | 4 | 6 | 1 | src/backend/database/template-repository.js |
| `deleteBillSplitRow` | 4 | 6 | 1 | src/backend/database/template-repository.js |
| `deleteSideDbByPath` | 4 | 6 | 1 | src/backend/run-data-store.js |
| `runBizOpImport` | 4 | 6 | 2 | src/backend/biz-op-recon-import/import-worker.js |
| `runFlowImport` | 4 | 6 | 2 | src/backend/biz-op-recon-import/import-worker.js |
| `saveAmountSplitRules` | 4 | 6 | 1 | src/backend/database/template-repository.js |
| `saveBillSplitMappings` | 4 | 6 | 1 | src/backend/database/template-repository.js |
| `saveBillSplitMergeGroup` | 4 | 6 | 1 | src/backend/database/template-repository.js |
| `saveBillSplitRow` | 4 | 6 | 1 | src/backend/database/template-repository.js |
| `saveBillSplitRowCount` | 4 | 6 | 1 | src/backend/database/template-repository.js |
| `setParentStatus` | 4 | 6 | 1 | src/backend/database/template-repository.js |
| `splitTemplateName` | 4 | 6 | 2 | src/backend/database/own-accounts-migration.js |
| `StringDecoder` | 4 | 6 | 4 | src/backend/acquiring-bill-currency-import/reader-handrolled.js |
| `batchDelete` | 4 | 5 | 1 | src/backend/database/scenarios-repository.js |
| `clearByDateBu` | 4 | 5 | 1 | src/backend/biz-op-recon-db/imports-repository.js |
| `deleteSideDb` | 4 | 5 | 1 | src/backend/run-data-store.js |
| `sideDbRelPath` | 4 | 5 | 1 | src/backend/run-data-store.js |
| `sanitizeFileName` | 4 | 4 | 4 | src/backend/balance-seed-store.js |
| `escapeHtml` | 3 | 172 | 1 | src/renderer.js |
| `normalizeText` | 3 | 70 | 2 | src/backend/database/migrations.js |
| `setStatus` | 3 | 69 | 1 | src/renderer.js |
| `MODULE` | 3 | 55 | 3 | src/main-process/acquiring-bill-currency-run-data.js |
| `hasColumn` | 3 | 34 | 2 | src/backend/biz-op-recon-db/migrations.js |
| `lastGeneratedExports` | 3 | 24 | 1 | src/main.js |
| `emit` | 3 | 23 | 3 | src/backend/biz-op-recon-import/import-worker.js |
| `setSetting` | 3 | 22 | 1 | src/backend/database/settings-repository.js |
| `buildOutputRow` | 3 | 21 | 3 | src/main-process/scenario-engines/boc-dispatch-order-fix.js |
| `pad2` | 3 | 21 | 3 | src/backend/usage-stats.js |
| `getSetting` | 3 | 18 | 1 | src/backend/database/settings-repository.js |
| `CONCAT_FIELDS_MAPPING_FIELD` | 3 | 17 | 2 | src/main.js |
| `BALANCE_DISABLED_OPTION` | 3 | 16 | 2 | src/main.js |
| `PRAGMA_EXPECTED` | 3 | 14 | 3 | src/backend/big-table-import/engine.js |
| `applyStatementResult` | 3 | 13 | 1 | src/renderer.js |
| `diffRepo` | 3 | 13 | 3 | src/backend/pending-export/writer.js |
| `YELLOW_FILL` | 3 | 13 | 3 | src/main-process/bank-bu-recon-writer.js |
| `sideDbPath` | 3 | 12 | 1 | src/backend/run-data-store.js |
| `PRAGMA_STATEMENTS` | 3 | 10 | 3 | src/backend/big-table-import/engine.js |
| `BANK_STATEMENT_FIELDS_FOR_C3` | 3 | 9 | 2 | src/constants/bank-statement-fields.js |
| `BANK_STATEMENT_VIRTUAL_AMOUNT_ABS` | 3 | 9 | 3 | src/constants/bank-statement-fields.js |
| `buildHeaderValidator` | 3 | 9 | 3 | src/backend/acquiring-bill-currency-import/validator.js |
| `FLOW_TABLE` | 3 | 9 | 3 | src/backend/acquiring-bill-currency-db/run-repository.js |
| `getChannelById` | 3 | 9 | 1 | src/backend/database/channels-repository.js |
| `inferDateCellFormat` | 3 | 9 | 1 | src/backend/file-service/normalizers.js |
| `isNumericFieldName` | 3 | 9 | 3 | src/backend/pending-reconcile/removal-match.js |
| `parseJsonArray` | 3 | 9 | 2 | src/backend/database/utils.js |
| `REFUND_BANK_COLUMNS` | 3 | 9 | 1 | src/constants/refund-backfill-fields.js |
| `toExcelSerial` | 3 | 9 | 1 | src/backend/file-service/normalizers.js |
| `upsertMainRunMirror` | 3 | 9 | 3 | src/main-process/acquiring-bill-currency-run-data.js |
| `weekTag` | 3 | 9 | 2 | src/main-process/scenario-engines/engine-week-utils.js |
| `AMOUNT_BASED_ACCOUNT_MAPPING_FIELD` | 3 | 8 | 2 | src/main.js |
| `AMOUNT_BASED_NAME_MAPPING_FIELD` | 3 | 8 | 2 | src/main.js |
| `AMOUNT_EPSILON` | 3 | 8 | 1 | src/backend/biz-op-recon-db/columns.js |
| `AMOUNT_SPLIT_BY_FIELD_ENABLED_OPTION` | 3 | 8 | 2 | src/main.js |
| `AMOUNT_SPLIT_BY_FIELD_MAPPING_FIELD` | 3 | 8 | 2 | src/main.js |
| `applyHeaderRowFont` | 3 | 8 | 3 | src/backend/file-service/writers.js |
| `cloneRowsWithMetadata` | 3 | 8 | 1 | src/main-process/statement-session.js |
| `ensureBizOpReconTablesSupport` | 3 | 8 | 3 | src/backend/biz-op-recon-db/migrations.js |
| `FLOW_INSERT_SQL` | 3 | 8 | 3 | src/backend/acquiring-bill-currency-db/import-repository.js |
| `GATEWAY_RECON_FIELDS` | 3 | 8 | 3 | src/constants/gateway-recon-fields.js |
| `getTemplateBigAccounts` | 3 | 8 | 1 | src/backend/database/template-repository.js |
| `listDiffRows` | 3 | 8 | 1 | src/backend/pending-db/diff-repository.js |
| `normalizeCurrency` | 3 | 8 | 3 | src/backend/acquiring-bill-currency-db/import-repository.js |
| `openZipWithEntries` | 3 | 8 | 2 | src/backend/acquiring-bill-currency-import/reader.js |
| `SIGNED_AMOUNT_MAPPING_FIELD` | 3 | 8 | 2 | src/main.js |
| `backfillBocReconLinkIds` | 3 | 7 | 1 | src/main-process/boc-fx-link-builder.js |
| `buildBocBankRows` | 3 | 7 | 1 | src/main-process/boc-fx-link-builder.js |
| `buildInsertSql` | 3 | 7 | 3 | src/backend/bank-bu-recon-db/month-repository.js |
| `createChannel` | 3 | 7 | 1 | src/backend/database/channels-repository.js |
| `createScenario` | 3 | 7 | 1 | src/backend/database/scenarios-repository.js |
| `getMonthReadiness` | 3 | 7 | 1 | src/backend/acquiring-bill-currency-db/import-repository.js |
| `listChannels` | 3 | 7 | 1 | src/backend/database/channels-repository.js |
| `normalizeInputFilePaths` | 3 | 7 | 1 | src/main-process/statement-session.js |
| `readSheetAsRows` | 3 | 7 | 3 | src/backend/bank-bu-recon-import/reader.js |
| `validateContract` | 3 | 7 | 3 | src/backend/big-table-import/contract.js |
| `WORKER_SCRIPT_PATH` | 3 | 7 | 3 | src/backend/big-table-import/pipeline.js |
| `writeBizOpErrorReportXlsx` | 3 | 7 | 1 | src/main-process/biz-op-recon-writer.js |
| `writeFlowErrorReportXlsx` | 3 | 7 | 1 | src/main-process/biz-op-recon-writer.js |
| `xmlUnescape` | 3 | 7 | 3 | src/backend/acquiring-bill-currency-import/reader-handrolled.js |
| `buildDateDir` | 3 | 6 | 3 | src/main-process/acquiring-bill-currency-writer.js |
| `CHANNEL_VALUE` | 3 | 6 | 2 | src/backend/database/linked-table-repository.js |
| `clearMonth` | 3 | 6 | 2 | src/backend/acquiring-bill-currency-db/import-repository.js |
| `columnLetterToIndex` | 3 | 6 | 2 | src/backend/acquiring-bill-currency-import/reader.js |
| `compileRegexLiteral` | 3 | 6 | 1 | src/backend/file-service/normalizers.js |
| `computeRowHash` | 3 | 6 | 3 | src/backend/pending-import/contract-pending.js |
| `dayDiffWithin` | 3 | 6 | 3 | src/main-process/scenario-engines/engine-date-utils.js |
| `deleteMonthSideDb` | 3 | 6 | 3 | src/main-process/acquiring-bill-currency-run-data.js |
| `flowRowToArray` | 3 | 6 | 1 | src/backend/biz-op-recon-db/columns.js |
| `getAmountSplitRules` | 3 | 6 | 1 | src/backend/database/template-repository.js |
| `groupBigAccountRows` | 3 | 6 | 2 | src/backend/database/utils.js |
| `isRegexLiteral` | 3 | 6 | 1 | src/backend/file-service/normalizers.js |
| `loadCurrencyMappings` | 3 | 6 | 2 | src/backend/file-service.js |
| `makeRowInserter` | 3 | 6 | 2 | src/backend/biz-op-recon-db/flow-imports-repository.js |
| `normalizeBillDate` | 3 | 6 | 3 | src/backend/acquiring-bill-currency-db/import-repository.js |
| `ORDER_REPAIR_FIELDS` | 3 | 6 | 2 | src/constants/recon-id-fix-fields.js |
| `parseFtaDate` | 3 | 6 | 2 | src/main-process/scenario-engines/engine-week-utils.js |
| `PAYMENT_OFFLINE_FIELD_MAP` | 3 | 6 | 1 | src/constants/payment-offline-allocation-fields.js |
| `readBankDepositBocCandidates` | 3 | 6 | 1 | src/backend/database/linked-table-repository.js |
| `readBocFxLinkRowsWithIds` | 3 | 6 | 1 | src/backend/database/linked-table-repository.js |
| `readLinkedTableRows` | 3 | 6 | 1 | src/backend/database/linked-table-repository.js |
| `readXlsxStreamed` | 3 | 6 | 3 | src/backend/file-service/readers.js |
| `reconcileOrphans` | 3 | 6 | 3 | src/main-process/acquiring-bill-currency-run-data.js |
| `recordExportPath` | 3 | 6 | 2 | src/main-process/bank-bu-recon-run-data.js |
| `rematchAllBocGroups` | 3 | 6 | 1 | src/main-process/boc-fx-link-builder.js |
| `replaceBocBankDeposit` | 3 | 6 | 1 | src/backend/database/linked-table-repository.js |
| `resolveSinglePreparedFieldValue` | 3 | 6 | 1 | src/main-process/statement-session.js |
| `runMigrations` | 3 | 6 | 3 | src/backend/pending-db.js |
| `SUPPORTED_EXTENSIONS` | 3 | 6 | 1 | src/backend/file-service/common.js |
| `validateBizOpHeaders` | 3 | 6 | 1 | src/backend/biz-op-recon-import/validator.js |
| `validateBizOpRow` | 3 | 6 | 2 | src/backend/biz-op-recon-import/import-worker.js |
| `writeBocFxLinkReconIds` | 3 | 6 | 1 | src/backend/database/linked-table-repository.js |
| `writeDiffWorkbook` | 3 | 6 | 2 | src/main-process/acquiring-bill-currency-writer.js |
| `yauzl` | 3 | 6 | 3 | src/backend/acquiring-bill-currency-import/reader.js |
| `addOneDay` | 3 | 5 | 2 | src/backend/biz-op-recon-import/import-worker.js |
| `ALL_BANKS_TEMPLATE_SCOPE` | 3 | 5 | 2 | src/main-process/monthly-balance.js |
| `bankCreditAmount` | 3 | 5 | 1 | src/main-process/scenario-engines/r5-payment-offline-allocation-backfill.js |
| `buildAdmRows` | 3 | 5 | 2 | src/main-process/adm-bank-deposit-builder.js |
| `buildTimestamp` | 3 | 5 | 3 | src/main-process/acquiring-bill-currency-writer.js |
| `calculateEndingBalanceFromAmounts` | 3 | 5 | 1 | src/backend/file-service/normalizers.js |
| `exportAggregate` | 3 | 5 | 1 | src/backend/pending-export/writer.js |
| `getEnabledModules` | 3 | 5 | 1 | src/backend/database/settings-repository.js |
| `getRule` | 3 | 5 | 1 | src/backend/pending-db/rule-repository.js |
| `getStatementSessionEntries` | 3 | 5 | 1 | src/main-process/statement-session.js |
| `getUiStyle` | 3 | 5 | 1 | src/backend/database/settings-repository.js |
| `importFiles` | 3 | 5 | 2 | src/backend/big-table-import/engine.js |
| `inferEndingBalance` | 3 | 5 | 1 | src/backend/file-service/normalizers.js |
| `lettersToIndex` | 3 | 5 | 2 | src/backend/pending-import/streaming-xlsx-reader.js |
| `listReadyDates` | 3 | 5 | 1 | src/backend/biz-op-recon-db/run-repository.js |
| `mergeMappedDetailRows` | 3 | 5 | 1 | src/main-process/statement-session.js |
| `readBankDepositAdmCandidates` | 3 | 5 | 1 | src/backend/database/linked-table-repository.js |
| `readBizOpFile` | 3 | 5 | 1 | src/backend/biz-op-recon-import/reader.js |
| `readBocFxLinkRowsForRematch` | 3 | 5 | 1 | src/backend/database/linked-table-repository.js |
| `readFlowFile` | 3 | 5 | 1 | src/backend/biz-op-recon-import/reader.js |
| `replaceAdmBankDeposit` | 3 | 5 | 1 | src/backend/database/linked-table-repository.js |
| `runAllScenarios` | 3 | 5 | 3 | src/main-process/reconciliation-orchestrator.js |
| `setEnabledModules` | 3 | 5 | 1 | src/backend/database/settings-repository.js |
| `setReconIdFixBillCategory` | 3 | 5 | 1 | src/backend/database/settings-repository.js |
| `writeBocFxLinkGroupRematch` | 3 | 5 | 1 | src/backend/database/linked-table-repository.js |
| `clearByDate` | 3 | 4 | 1 | src/backend/biz-op-recon-db/flow-imports-repository.js |
| `clearRunsAndDiffsByDate` | 3 | 4 | 1 | src/backend/biz-op-recon-db/run-repository.js |
| `findByNameAndLocation` | 3 | 4 | 1 | src/backend/database/channels-repository.js |
| `getBuiltinGeneral` | 3 | 4 | 1 | src/backend/database/channels-repository.js |
| `importMonthAtomic` | 3 | 4 | 1 | src/backend/bank-bu-recon-db/month-repository.js |
| `isEmptyValue` | 3 | 4 | 1 | src/main-process/scenario-engines/engine-utils.js |
| `listByMonth` | 3 | 4 | 1 | src/backend/pending-db/removed-repository.js |
| `listSuccessDates` | 3 | 4 | 1 | src/backend/biz-op-recon-db/run-repository.js |
| `listSuccessDatesInRange` | 3 | 4 | 1 | src/backend/biz-op-recon-db/run-repository.js |
| `openWorkbook` | 3 | 4 | 1 | src/backend/big-table-import/zip-reader.js |
| `runBizOpImportViaWorker` | 3 | 4 | 1 | src/main-process/biz-op-recon-session.js |
| `runFlowImportViaWorker` | 3 | 4 | 1 | src/main-process/biz-op-recon-session.js |
| `sanitizeBankName` | 3 | 4 | 3 | src/backend/balance-adjustment-store.js |
| `scanSheetRows` | 3 | 4 | 1 | src/backend/big-table-import/row-scanner.js |
| `buildTimestampMinute` | 3 | 3 | 2 | src/main-process/bank-statement-io.js |
| `createHash` | 3 | 3 | 1 | src/main.js |

## A-pair — 跨 2 文件

| 名字 | 总次数 | 声明位置（首个） |
|---|---:|---|
| `MODULES` | 75 | src/renderer.js |
| `activeJob` | 47 | src/main-process/run-check-worker-pool.js |
| `normalizeKey` | 34 | src/backend/database/linked-table-repository.js |
| `settingsRepository` | 33 | src/backend/database.js |
| `templateRepository` | 33 | src/backend/database.js |
| `ContractValidationError` | 25 | src/backend/big-table-import/contract.js |
| `database` | 24 | src/main.js |
| `TEMPLATE_LABEL` | 19 | src/backend/pending-import/removed-reader.js |
| `refreshBankStatementStatus` | 18 | src/renderer.js |
| `PipelineError` | 17 | src/backend/big-table-import/engine.js |
| `TABLE` | 17 | src/backend/biz-op-recon-db/flow-imports-repository.js |
| `DIFF_TABLE` | 16 | src/backend/acquiring-bill-currency-db/run-repository.js |
| `ImportValidationError` | 16 | src/backend/acquiring-bill-currency-import/reader.js |
| `REMOVED_PENDING_COLUMNS` | 16 | src/backend/pending-export/writer.js |
| `reloadReconIdFixScenarios` | 15 | src/renderer.js |
| `safeRollback` | 15 | src/backend/big-table-import/engine.js |
| `monthRepository` | 14 | src/main-process/bank-bu-recon-run-data.js |
| `sanitizeAmountValue` | 14 | src/backend/file-service/normalizers.js |
| `toCents` | 14 | src/main-process/boc-fx-link-builder.js |
| `BigTableImportError` | 13 | src/backend/big-table-import/zip-reader.js |
| `ERROR_CODE` | 13 | src/backend/pending-import/removed-reader.js |
| `normalizeAccountKey` | 13 | src/main-process/biz-op-recon-session.js |
| `refreshTemplates` | 13 | src/renderer.js |
| `zipReader` | 13 | src/backend/big-table-import/engine.js |
| `getCurrencyOptionEntries` | 12 | src/renderer.js |
| `parseAmount` | 12 | src/backend/biz-op-recon-import/validator.js |
| `removalMatch` | 12 | src/backend/pending-export/writer.js |
| `BIZ_OP_ACCOUNT_KEY_DB_COLUMN` | 11 | src/backend/biz-op-recon-db/columns.js |
| `rendererPending` | 11 | src/renderer.js |
| `electronUtilityProcess` | 10 | src/main-process/biz-op-recon-session.js |
| `getTemplate` | 10 | src/backend/database/template-repository.js |
| `NODE_MAX_OLD_SPACE_MB` | 10 | src/main-process/biz-op-recon-session.js |
| `workerDbPath` | 10 | src/main-process/run-check-worker-pool.js |
| `channelsRepository` | 9 | src/backend/database.js |
| `hasEffectiveAmount` | 9 | src/backend/file-service/normalizers.js |
| `SHEET_ENTRY_NAME` | 9 | src/backend/acquiring-bill-currency-import/reader.js |
| `ACQUIRING_BILL_CHUNK_SIZE_DEFAULT` | 8 | src/backend/database/migrations.js |
| `ACQUIRING_BILL_CHUNK_SIZE_KEY` | 8 | src/backend/database/migrations.js |
| `ACQUIRING_BILL_IDLE_CLEANUP_MINUTES_DEFAULT` | 8 | src/backend/database/migrations.js |
| `ACQUIRING_BILL_IDLE_CLEANUP_MINUTES_KEY` | 8 | src/backend/database/migrations.js |
| `ACQUIRING_BILL_RAW_JSON_RETENTION_DAYS_DEFAULT` | 8 | src/backend/database/migrations.js |
| `ACQUIRING_BILL_RAW_JSON_RETENTION_DAYS_KEY` | 8 | src/backend/database/migrations.js |
| `getLinkedTableMeta` | 8 | src/backend/database/linked-table-repository.js |
| `monthRepo` | 8 | src/backend/pending-import/worker.js |
| `pkg` | 8 | src/main-process/acquiring-bill-currency-writer.js |
| `recordRowError` | 8 | src/backend/biz-op-recon-import/import-worker.js |
| `setNewAccountStatus` | 8 | src/renderer.js |
| `setRunChunkProgress` | 8 | src/backend/acquiring-bill-currency-db/run-repository.js |
| `sheetToObjects` | 8 | src/main-process/bank-statement-io.js |
| `toIsoDate` | 8 | src/main-process/boc-fx-link-builder.js |
| `wrapReadError` | 8 | src/backend/biz-op-recon-import/reader-streamed.js |
| `ACQUIRING_BILL_WORKER_COUNT_DEFAULT` | 7 | src/backend/database/migrations.js |
| `ACQUIRING_BILL_WORKER_COUNT_KEY` | 7 | src/backend/database/migrations.js |
| `applyManualBalancePromptStatus` | 7 | src/renderer.js |
| `bankStatementSession` | 7 | src/main.js |
| `createBackup` | 7 | src/backend/database/backup.js |
| `FLOW_COLUMN_DEFS` | 7 | src/backend/biz-op-recon-db/columns.js |
| `flowImportsRepository` | 7 | src/backend/biz-op-recon-import/import-worker.js |
| `getNewAccountStatusTitle` | 7 | src/renderer.js |
| `processingResult` | 7 | src/main.js |
| `roundAmount` | 7 | src/backend/file-service/normalizers.js |
| `setNewAccountExportAvailability` | 7 | src/renderer.js |
| `syncNewAccountCurrencyMode` | 7 | src/renderer.js |
| `VALID_CATEGORIES` | 7 | src/backend/database/scenarios-repository.js |
| `__missingBankColumns` | 6 | src/constants/payment-offline-allocation-fields.js |
| `amountEqual` | 6 | src/main-process/scenario-engines/r5-fund-transfer-backfill.js |
| `BANK_DEPOSIT_FIELDS` | 6 | src/backend/database/linked-table-repository.js |
| `BANK_DIFF_FIELD_DB_COLUMN` | 6 | src/backend/bank-bu-recon-db/columns.js |
| `BANK_RECON_ID_FIELD` | 6 | src/main-process/scenario-engines/r1-recon-id-match.js |
| `bankAmountAbs` | 6 | src/main-process/scenario-engines/r5-fund-transfer-backfill.js |
| `bizOpRowToArray` | 6 | src/backend/biz-op-recon-db/columns.js |
| `BOC_BANK_FILTER` | 6 | src/constants/boc-fx-link-fields.js |
| `buildFeatureRegex` | 6 | src/main-process/scenario-engines/c1-extract-recon-id.js |
| `buildFileReader` | 6 | src/backend/bank-bu-recon-import/reader.js |
| `buildRowMapper` | 6 | src/backend/bank-bu-recon-import/reader.js |
| `buildTemplateSummaryFromRow` | 6 | src/backend/database/utils.js |
| `CLEANUP_TEMPLATE_HEADERS` | 6 | src/constants/platform-cleanup-template-fields.js |
| `dayDiffAbs` | 6 | src/main-process/scenario-engines/r5-payment-offline-allocation-backfill.js |
| `ensureAccountMappingCurrencySupport` | 6 | src/backend/database/migrations.js |
| `ensureAccountMappingTemplateSupport` | 6 | src/backend/database/migrations.js |
| `ensureAcquiringBillChunkSizeSetting` | 6 | src/backend/database/migrations.js |
| `ensureAcquiringBillCurrencyIndexSlimV2` | 6 | src/backend/database/migrations.js |
| `ensureAcquiringBillCurrencyRawJsonRetentionSettings` | 6 | src/backend/database/migrations.js |
| `ensureAcquiringBillCurrencyRunsChunkProgress` | 6 | src/backend/database/migrations.js |
| `ensureAcquiringBillCurrencyRunsCleanupPending` | 6 | src/backend/database/migrations.js |
| `ensureAcquiringBillCurrencyRunsSideDbPath` | 6 | src/backend/database/migrations.js |
| `ensureAcquiringBillCurrencyTablesSupport` | 6 | src/backend/database/migrations.js |
| `ensureAcquiringBillIdleCleanupMinutesSetting` | 6 | src/backend/database/migrations.js |
| `ensureAcquiringBillWorkerCountSetting` | 6 | src/backend/database/migrations.js |
| `ensureAdmBankDepositSupport` | 6 | src/backend/database/migrations.js |
| `ensureAmountSplitRulesSupport` | 6 | src/backend/database/migrations.js |
| `ensureBankBuReconRunsSideDbPath` | 6 | src/backend/database/migrations.js |
| `ensureBankBuReconTablesSupport` | 6 | src/backend/database/migrations.js |
| `ensureBillRawJsonV2Slim` | 6 | src/backend/database/migrations.js |
| `ensureBillSplitMergeSupport` | 6 | src/backend/database/migrations.js |
| `ensureBillSplitTargetSeqSupport` | 6 | src/backend/database/migrations.js |
| `ensureBizOpReconRunsSideDbPath` | 6 | src/backend/database/migrations.js |
| `ensureBocDispatchOrderScenarioSeed` | 6 | src/backend/database/migrations.js |
| `ensureBocFxLinkSupport` | 6 | src/backend/database/migrations.js |
| `ensureBuiltinFixedScenarioMigration` | 6 | src/backend/database/migrations.js |
| `ensureBuiltinFixedScenarioNameUpdate` | 6 | src/backend/database/migrations.js |
| `ensureBuiltinScenarioNamesUpdate` | 6 | src/backend/database/migrations.js |
| `ensureC3AssignAddMode` | 6 | src/backend/database/migrations.js |
| `ensureC3GwFieldCurrencyCaseFix` | 6 | src/backend/database/migrations.js |
| `ensureChannelEnumSupport` | 6 | src/backend/database/migrations.js |
| `ensureDiffRowsCascadeMigration_v2_1_10` | 6 | src/backend/database/migrations.js |
| `ensureFundTypeAchReturnConfigMigration` | 6 | src/backend/database/migrations.js |
| `ensureJpmDispatchOrderScenarioSeed` | 6 | src/backend/database/migrations.js |
| `ensureLinkedTableSupport` | 6 | src/backend/database/migrations.js |
| `ensureParentTemplateSupport` | 6 | src/backend/database/migrations.js |
| `ensureReconRoundBuiltinScenariosSeed` | 6 | src/backend/database/migrations.js |
| `ensureRefundBackfillScenarioSeed` | 6 | src/backend/database/migrations.js |
| `ensureScenarioApplicableChannelsTable` | 6 | src/backend/database/migrations.js |
| `ensureScenariosCategoryBuiltinFixed` | 6 | src/backend/database/migrations.js |
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
| `ensureVccOpCalcTablesSupport` | 6 | src/backend/database/migrations.js |
| `FILENAME_MAPPING_TEMPLATE_ID` | 6 | src/main.js |
| `FX_DELIVERY_SIGNATURE` | 6 | src/constants/boc-fx-link-fields.js |
| `getCurrencyOptionLabel` | 6 | src/renderer.js |
| `GW_RECON_ID_FIELD` | 6 | src/main-process/scenario-engines/r1-recon-id-match.js |
| `initWorkerDb` | 6 | src/main-process/run-check-multiworker-worker.js |
| `INSERT_SQL` | 6 | src/backend/biz-op-recon-db/flow-imports-repository.js |
| `listImportedDateBuPairs` | 6 | src/backend/biz-op-recon-db/imports-repository.js |
| `matchAmountSplitConditionValue` | 6 | src/backend/file-service/normalizers.js |
| `migrateC4ReconGroupsAmountLockedFieldPair` | 6 | src/backend/database/migrations.js |
| `migrateC4ReconGroupsStructure` | 6 | src/backend/database/migrations.js |
| `migrateGatewayReconIdFixFieldPairs` | 6 | src/backend/database/migrations.js |
| `normalizeWorksheetTarget` | 6 | src/backend/big-table-import/zip-reader.js |
| `PART_TABLE` | 6 | src/main-process/run-check-multiworker-worker.js |
| `PENDING_DIFF_FIELD_DB_COLUMN` | 6 | src/backend/bank-bu-recon-db/columns.js |
| `reconIdFixSession` | 6 | src/main.js |
| `removedRepo` | 6 | src/backend/pending-export/writer.js |
| `runC1Scenario` | 6 | src/main-process/scenario-engines/c1-extract-recon-id.js |
| `sanitizeSheetName` | 6 | src/backend/pending-export/writer.js |
| `splitSignedAmountValue` | 6 | src/backend/file-service/normalizers.js |
| `SUPPORTED_SCENARIO_BUNDLE_VERSION` | 6 | src/backend/scenarios-bundle-io.js |
| `validateName` | 6 | src/backend/database/channels-repository.js |
| `VCC_BILL_DATE_DB_COLUMN` | 6 | src/backend/vcc-op-calc-db/columns.js |
| `VCC_DIRECTION_DB_COLUMN` | 6 | src/backend/vcc-op-calc-db/columns.js |
| `WORKER_SCRIPT` | 6 | src/main-process/biz-op-recon-session.js |
| `workerScriptOverride` | 6 | src/main-process/run-check-multiworker.js |
| `WRITER_OUTPUT_HEADERS_V2` | 6 | src/backend/acquiring-bill-currency-db/columns.js |
| `BILL_INSERT_SQL` | 5 | src/backend/acquiring-bill-currency-db/import-repository.js |
| `BIZ_OP_END_BALANCE_DB_COLUMN` | 5 | src/backend/biz-op-recon-db/columns.js |
| `BOC_PAYMENT_DETAIL_KEYWORD` | 5 | src/constants/boc-fx-link-fields.js |
| `buildInfo` | 5 | src/main-process/acquiring-bill-currency-writer.js |
| `deserializeFromMessage` | 5 | src/main-process/run-check-multiworker.js |
| `DIFF_HEADER_TAIL` | 5 | src/backend/biz-op-recon-db/columns.js |
| `DIFF_OUTPUT_BANK_SHEET` | 5 | src/backend/bank-bu-recon-db/columns.js |
| `DIFF_OUTPUT_PENDING_SHEET` | 5 | src/backend/bank-bu-recon-db/columns.js |
| `ENGINE_WORKER_ENTRY` | 5 | src/main-process/acquiring-bill-currency-session.js |
| `ensureSupportedFile` | 5 | src/backend/file-service/readers.js |
| `ERROR_HEADER_TAIL` | 5 | src/backend/biz-op-recon-db/columns.js |
| `gatewayReconSession` | 5 | src/main.js |
| `getBillSplitAmountRules` | 5 | src/backend/database/template-repository.js |
| `getBillSplitMappings` | 5 | src/backend/database/template-repository.js |
| `getBillSplitMeta` | 5 | src/backend/database/template-repository.js |
| `getBillSplitRows` | 5 | src/backend/database/template-repository.js |
| `getScenario` | 5 | src/backend/database/scenarios-repository.js |
| `getStatusDualSource` | 5 | src/main-process/bank-bu-recon-run-data.js |
| `getTemplateMappings` | 5 | src/backend/database/template-repository.js |
| `groupBy` | 5 | src/main-process/scenario-engines/jpm-dispatch-order-fix.js |
| `listImportedDates` | 5 | src/backend/biz-op-recon-db/flow-imports-repository.js |
| `listMonthsDualSource` | 5 | src/main-process/acquiring-bill-currency-run-data.js |
| `MODULE_ACQUIRING` | 5 | src/backend/run-data-store.js |
| `MODULE_BANK_BU` | 5 | src/backend/run-data-store.js |
| `MODULE_BIZ_OP` | 5 | src/backend/run-data-store.js |
| `parseAmountAbs` | 5 | src/backend/acquiring-bill-currency-db/import-repository.js |
| `peekImportTarget` | 5 | src/main-process/acquiring-bill-currency-run-data.js |
| `PENDING_INSERT_SQL` | 5 | src/backend/bank-bu-recon-db/month-repository.js |
| `performance` | 5 | src/main.js |
| `REFUND_TEMPLATE_HEADERS` | 5 | src/constants/refund-backfill-fields.js |
| `runC2Scenario` | 5 | src/main-process/scenario-engines/c2-offset-bill-mark.js |
| `runC3Scenario` | 5 | src/main-process/scenario-engines/c3-gateway-recon-join.js |
| `runScenario` | 5 | src/main-process/scenario-dispatcher.js |
| `sax` | 5 | src/backend/acquiring-bill-currency-import/reader.js |
| `scan` | 5 | src/main-process/vcc-op-calc-session.js |
| `setExportAvailability` | 5 | src/renderer.js |
| `setNewAccountOpenDateValue` | 5 | src/renderer.js |
| `statementImportSessions` | 5 | src/main.js |
| `streamBizOpFile` | 5 | src/backend/biz-op-recon-import/import-worker.js |
| `subOneDay` | 5 | src/backend/biz-op-recon-db/run-repository.js |
| `TEMPLATE_BILL_KEY_INDICES` | 5 | src/backend/acquiring-bill-currency-db/import-repository.js |
| `trimTrailingEmptyCells` | 5 | src/backend/file-service/common.js |
| `updateNewAccountGenerateAvailability` | 5 | src/renderer.js |
| `VCC_CURRENCY_DB_COLUMN` | 5 | src/backend/vcc-op-calc-db/columns.js |
| `VCC_RECON_AMOUNT_DB_COLUMN` | 5 | src/backend/vcc-op-calc-db/columns.js |
| `weekTagToNumber` | 5 | src/main-process/scenario-engines/engine-week-utils.js |
| `ZHONGTAI_DISPATCH_ORDER_SIGNATURE` | 5 | src/constants/table-signatures.js |
| `ADM_EXTRA_FIELDS` | 4 | src/constants/adm-bank-deposit-fields.js |
| `ADM_FUND_TYPES` | 4 | src/constants/adm-bank-deposit-fields.js |
| `ADM_MERCHANT_ID` | 4 | src/backend/database/migrations.js |
| `ALL_TABLE_SIGNATURES` | 4 | src/constants/table-signatures.js |
| `applyApplicableChannelIdsInTx` | 4 | src/backend/database/scenarios-repository.js |
| `BANK_MATCH_KEY_DB_COLUMN` | 4 | src/backend/bank-bu-recon-db/columns.js |
| `BankStatementMergeError` | 4 | src/main-process/bank-statement-merge.js |
| `BOC_CHANNEL_NAME` | 4 | src/constants/boc-dispatch-order-fields.js |
| `BOC_CHANNEL_VALUE` | 4 | src/constants/boc-fx-link-fields.js |
| `buildMappedRows` | 4 | src/backend/file-service.js |
| `BUSINESS_BILL_SHEET_NAME` | 4 | src/constants/recon-id-fix-fields.js |
| `C4_CATEGORIES` | 4 | src/main-process/scenario-dispatcher.js |
| `CHANNEL_BILL_SHEET_NAME` | 4 | src/constants/gateway-bill-recon-fields.js |
| `CLEANUP_COPY_HEADERS` | 4 | src/constants/platform-cleanup-template-fields.js |
| `clearBankDepositHitMarkersByBizIds` | 4 | src/backend/database/linked-table-repository.js |
| `clearDiffRowsByRunId` | 4 | src/backend/acquiring-bill-currency-db/run-repository.js |
| `closeAllNewAccountCurrencyDropdowns` | 4 | src/renderer.js |
| `computeAmounts` | 4 | src/main-process/vcc-op-calc-session.js |
| `countBankDepositByDateRange` | 4 | src/backend/database/linked-table-repository.js |
| `countByMonth` | 4 | src/backend/pending-db/removed-repository.js |
| `countFxByDateRange` | 4 | src/backend/database/linked-table-repository.js |
| `countGatewayBillByDateRange` | 4 | src/backend/database/linked-table-repository.js |
| `createBankBuReconSession` | 4 | src/main-process/bank-bu-recon-session.js |
| `createCancelToken` | 4 | src/main-process/acquiring-bill-currency-session.js |
| `createPendingSession` | 4 | src/main-process/pending-session.js |
| `createVccOpCalcSession` | 4 | src/main-process/vcc-op-calc-session.js |
| `crypto` | 4 | src/backend/pending-import/validator.js |
| `deleteBankDepositByDateRange` | 4 | src/backend/database/linked-table-repository.js |
| `deleteChannel` | 4 | src/backend/database/channels-repository.js |
| `deleteFxByDateRange` | 4 | src/backend/database/linked-table-repository.js |
| `deleteGatewayBillByDateRange` | 4 | src/backend/database/linked-table-repository.js |
| `deleteScenario` | 4 | src/backend/database/scenarios-repository.js |
| `ensureUiStyleDefault` | 4 | src/backend/database/settings-repository.js |
| `extractChannelRegionCombos` | 4 | src/backend/database/channel-enum-repository.js |
| `findHeaderMatchPosition` | 4 | src/backend/file-service/readers.js |
| `FLOW_ACCOUNT_KEY_DB_COLUMN` | 4 | src/backend/biz-op-recon-db/columns.js |
| `FLOW_BU_FIELD_DB_COLUMN` | 4 | src/backend/biz-op-recon-db/columns.js |
| `FLOW_DIRECTION_DB_COLUMN` | 4 | src/backend/biz-op-recon-db/columns.js |
| `FLOW_RECON_AMOUNT_DB_COLUMN` | 4 | src/backend/biz-op-recon-db/columns.js |
| `flowHeaderToDbColumn` | 4 | src/backend/biz-op-recon-db/columns.js |
| `FUND_TYPE_ENUM_FILE_NAME` | 4 | src/constants/fund-type-enum.js |
| `GATEWAY_BILL_SHEET_NAME` | 4 | src/constants/gateway-bill-recon-fields.js |
| `GATEWAY_RECON_HEADERS_FILE_NAME` | 4 | src/constants/gateway-recon-headers-loader.js |
| `getAcquiringBillChunkSize` | 4 | src/backend/database/settings-repository.js |
| `getAcquiringBillIdleCleanupMinutes` | 4 | src/backend/database/settings-repository.js |
| `getAcquiringBillRawJsonRetentionDays` | 4 | src/backend/database/settings-repository.js |
| `getAcquiringBillWorkerCount` | 4 | src/backend/database/settings-repository.js |
| `getBackgroundConfig` | 4 | src/backend/database/settings-repository.js |
| `getCurrencySuggestion` | 4 | src/renderer.js |
| `getCurrentModule` | 4 | src/backend/database/settings-repository.js |
| `getDiffRowsByRun` | 4 | src/backend/biz-op-recon-db/run-repository.js |
| `getEnumConfig` | 4 | src/backend/database/settings-repository.js |
| `getMaxBocFxOrigGroupNo` | 4 | src/backend/database/linked-table-repository.js |
| `getMirrorRun` | 4 | src/main-process/bank-bu-recon-run-data.js |
| `getReconIdFixBillCategory` | 4 | src/backend/database/settings-repository.js |
| `getRowById` | 4 | src/backend/biz-op-recon-db/imports-repository.js |
| `getRunChunkProgress` | 4 | src/backend/acquiring-bill-currency-db/run-repository.js |
| `getTemplateByKey` | 4 | src/backend/database/template-repository.js |
| `getTemplateByName` | 4 | src/backend/database/template-repository.js |
| `hasLinkedTableRows` | 4 | src/backend/database/linked-table-repository.js |
| `hasShownWinOneDriveStorageNotice` | 4 | src/backend/database/settings-repository.js |
| `heapStats` | 4 | src/backend/biz-op-recon-import/import-worker.js |
| `importBillFile` | 4 | src/backend/acquiring-bill-currency-import/reader.js |
| `importFlowFile` | 4 | src/backend/acquiring-bill-currency-import/reader.js |
| `importMonth` | 4 | src/main-process/bank-bu-recon-run-data.js |
| `isFilenameMappingMode` | 4 | src/main.js |
| `listAccountMappings` | 4 | src/backend/database/settings-repository.js |
| `listChannelEnumValues` | 4 | src/backend/database/channel-enum-repository.js |
| `listChildTemplates` | 4 | src/backend/database/template-repository.js |
| `listDistinctBus` | 4 | src/backend/biz-op-recon-db/imports-repository.js |
| `listLinkedTableMeta` | 4 | src/backend/database/linked-table-repository.js |
| `listRunsByDateBu` | 4 | src/backend/biz-op-recon-db/run-repository.js |
| `listRunsDualSource` | 4 | src/main-process/bank-bu-recon-run-data.js |
| `listScenarios` | 4 | src/backend/database/scenarios-repository.js |
| `listTemplateBundleEntries` | 4 | src/backend/database/template-repository.js |
| `loadJobMeta` | 4 | src/backend/biz-op-recon-import/import-worker.js |
| `markBankDepositHits` | 4 | src/backend/database/linked-table-repository.js |
| `markWinOneDriveStorageNoticeShown` | 4 | src/backend/database/settings-repository.js |
| `MERCHANT_ID_MULTI_ACCOUNT_MARKER` | 4 | src/backend/database/utils.js |
| `MTX_FEATURE` | 4 | src/constants/refund-backfill-fields.js |
| `normalizeCurrencyOptionEntry` | 4 | src/renderer.js |
| `openModuleMenu` | 4 | src/renderer.js |
| `OPPONENT_BILL_SHEET_NAME` | 4 | src/constants/recon-id-fix-fields.js |
| `ORDER_REPAIR_SHEET_NAME` | 4 | src/constants/recon-id-fix-fields.js |
| `ORDER_REPAIR_SHEET_NAME_GATEWAY` | 4 | src/constants/gateway-bill-recon-fields.js |
| `parseColumnFromCellRef` | 4 | src/backend/acquiring-bill-currency-import/reader.js |
| `parseRowXml` | 4 | src/backend/vcc-op-calc-import/reader.js |
| `peekFirstFile` | 4 | src/backend/big-table-import/engine.js |
| `PENDING_DB_FILENAME` | 4 | src/backend/pending-db.js |
| `PENDING_MATCH_KEY_DB_COLUMN` | 4 | src/backend/bank-bu-recon-db/columns.js |
| `PREPROCESS_TABLE_SIGNATURES` | 4 | src/constants/table-signatures.js |
| `randomUUID` | 4 | src/backend/database/migrations.js |
| `readAdmBankDepositRows` | 4 | src/backend/database/linked-table-repository.js |
| `readBankDepositHitMarkers` | 4 | src/backend/database/linked-table-repository.js |
| `readBocBankDepositRows` | 4 | src/backend/database/linked-table-repository.js |
| `readBocFxLinkRows` | 4 | src/backend/database/linked-table-repository.js |
| `readSharedStrings` | 4 | src/backend/vcc-op-calc-import/reader.js |
| `RECON_RESULT_FIELDS` | 4 | src/constants/recon-id-fix-fields.js |
| `RECON_RESULT_FIELDS_GATEWAY` | 4 | src/constants/gateway-bill-recon-fields.js |
| `RECON_RESULT_SHEET_NAME` | 4 | src/constants/recon-id-fix-fields.js |
| `RECON_RESULT_SHEET_NAME_GATEWAY` | 4 | src/constants/gateway-bill-recon-fields.js |
| `reconIdFixResult` | 4 | src/main.js |
| `refundOrderSession` | 4 | src/main.js |
| `renameTemplate` | 4 | src/backend/database/template-repository.js |
| `replaceBocFxLink` | 4 | src/backend/database/linked-table-repository.js |
| `replaceLinkedTable` | 4 | src/backend/database/linked-table-repository.js |
| `replaceLinkedTableStreaming` | 4 | src/backend/database/linked-table-repository.js |
| `resolveCurrencyValue` | 4 | src/backend/file-service/normalizers.js |
| `resolveWorkerScript` | 4 | src/main-process/run-check-multiworker.js |
| `rowScanner` | 4 | src/backend/big-table-import/engine.js |
| `runBocDispatchOrderFix` | 4 | src/main-process/recon-id-fix-engine.js |
| `runC4Scenario` | 4 | src/main-process/recon-id-fix-engine.js |
| `runCheckCore` | 4 | src/main-process/acquiring-bill-currency-session.js |
| `runJpmDispatchOrderFix` | 4 | src/main-process/recon-id-fix-engine.js |
| `runRound1ReconIdMatch` | 4 | src/main-process/reconciliation-orchestrator.js |
| `runRound4FundNatureCheck` | 4 | src/main-process/reconciliation-orchestrator.js |
| `runRound5FundTransferBackfill` | 4 | src/main-process/reconciliation-orchestrator.js |
| `runRound5PaymentOfflineAllocationBackfill` | 4 | src/main-process/reconciliation-orchestrator.js |
| `runRound5PlatformInboundCleanup` | 4 | src/main-process/reconciliation-orchestrator.js |
| `runRound5RefundOrderBackfill` | 4 | src/main-process/reconciliation-orchestrator.js |
| `runViaSideDb` | 4 | src/main-process/bank-bu-recon-run-data.js |
| `sameDay` | 4 | src/main-process/scenario-engines/engine-date-utils.js |
| `saveAccountMappings` | 4 | src/backend/database/settings-repository.js |
| `saveTemplateFilenameFixedField` | 4 | src/backend/database/template-repository.js |
| `setAcquiringBillChunkSize` | 4 | src/backend/database/settings-repository.js |
| `setAcquiringBillIdleCleanupMinutes` | 4 | src/backend/database/settings-repository.js |
| `setAcquiringBillRawJsonRetentionDays` | 4 | src/backend/database/settings-repository.js |
| `setAcquiringBillWorkerCount` | 4 | src/backend/database/settings-repository.js |
| `setBackgroundConfig` | 4 | src/backend/database/settings-repository.js |
| `setEnumConfig` | 4 | src/backend/database/settings-repository.js |
| `spawn` | 4 | src/main-process/biz-op-recon-session.js |
| `T54SWIC_FEATURE` | 4 | src/constants/refund-backfill-fields.js |
| `toggleScenarioEnabled` | 4 | src/backend/database/scenarios-repository.js |
| `transferScenarios` | 4 | src/backend/database/scenarios-repository.js |
| `updateChannel` | 4 | src/backend/database/channels-repository.js |
| `updateScenario` | 4 | src/backend/database/scenarios-repository.js |
| `upsertBocFxLink` | 4 | src/backend/database/linked-table-repository.js |
| `upsertLinkedBankDeposit` | 4 | src/backend/database/linked-table-repository.js |
| `upsertLinkedBankDepositStreaming` | 4 | src/backend/database/linked-table-repository.js |
| `upsertLinkedFx` | 4 | src/backend/database/linked-table-repository.js |
| `upsertLinkedGatewayBill` | 4 | src/backend/database/linked-table-repository.js |
| `upsertLinkedGatewayBillStreaming` | 4 | src/backend/database/linked-table-repository.js |
| `upsertTemplate` | 4 | src/backend/database/template-repository.js |
| `v8` | 4 | src/backend/biz-op-recon-import/import-worker.js |
| `validateBankHeaders` | 4 | src/backend/bank-bu-recon-import/validator.js |
| `validatePendingGuanliHeaders` | 4 | src/backend/bank-bu-recon-import/validator.js |
| `weekTagPlusOne` | 4 | src/main-process/scenario-engines/engine-week-utils.js |
| `writeAdmMatchFlags` | 4 | src/backend/database/linked-table-repository.js |
| `writeStreamedXlsx` | 4 | src/backend/pending-import/streaming-xlsx-writer.js |
| `xmlAttrUnescape` | 4 | src/backend/big-table-import/zip-reader.js |
| `__test_only_set_worker_script__` | 3 | src/main-process/run-check-multiworker.js |
| `AppDatabase` | 3 | src/backend/database.js |
| `appendStatementSessionImport` | 3 | src/main-process/statement-session.js |
| `applyScenarioBundleImport` | 3 | src/main-process/scenarios-bundle-import.js |
| `assembleMonthlyBalance` | 3 | src/main-process/monthly-balance.js |
| `BIZ_OP_BU_FIELD_DB_COLUMN` | 3 | src/backend/biz-op-recon-db/columns.js |
| `buildDetailExportRows` | 3 | src/backend/file-service.js |
| `buildStaleHitReminder` | 3 | src/main-process/scenario-engines/r5-refund-order-backfill.js |
| `buildStatementFileEntry` | 3 | src/main-process/statement-session.js |
| `clearRunsByMonth` | 3 | src/backend/acquiring-bill-currency-db/run-repository.js |
| `clearStaleSuccessfulRawJson` | 3 | src/backend/acquiring-bill-currency-db/raw-json-retention.js |
| `compareMatchedContent` | 3 | src/backend/pending-reconcile/removal-match.js |
| `computeRunStats` | 3 | src/backend/acquiring-bill-currency-db/run-repository.js |
| `countC3BankCandidates` | 3 | src/main-process/scenario-engines/c3-gateway-recon-join.js |
| `countRefundBankCandidates` | 3 | src/main-process/scenario-engines/r5-refund-order-backfill.js |
| `countRowsInMonth` | 3 | src/backend/pending-db/month-repository.js |
| `createRowInserter` | 3 | src/backend/pending-db/month-repository.js |
| `createRun` | 3 | src/backend/pending-db/diff-repository.js |
| `createStatementGenerationHelpers` | 3 | src/main-process/statement-generation.js |
| `deleteMonth` | 3 | src/backend/pending-db/month-repository.js |
| `deleteMonthBySide` | 3 | src/backend/acquiring-bill-currency-db/import-repository.js |
| `detectBundleType` | 3 | src/backend/scenarios-bundle-io.js |
| `detectTableType` | 3 | src/main-process/table-type-detector.js |
| `findByChannelAndName` | 3 | src/backend/database/scenarios-repository.js |
| `getApplicableChannelIds` | 3 | src/backend/database/scenarios-repository.js |
| `getBankRows` | 3 | src/backend/bank-bu-recon-db/month-repository.js |
| `getBillDateCounts` | 3 | src/backend/acquiring-bill-currency-db/run-repository.js |
| `getLatestRunByMonth` | 3 | src/backend/vcc-op-calc-db/run-repository.js |
| `getLatestRunForMonthPair` | 3 | src/backend/pending-db/diff-repository.js |
| `getOrCreateStatementImportSession` | 3 | src/main-process/statement-session.js |
| `getPendingRows` | 3 | src/backend/bank-bu-recon-db/month-repository.js |
| `getSessionStatus` | 3 | src/main-process/acquiring-bill-currency-session.js |
| `getTemplatesByBankName` | 3 | src/backend/database/template-repository.js |
| `importBillFiles` | 3 | src/main-process/acquiring-bill-currency-session.js |
| `importBillFilesWithOverwrite` | 3 | src/main-process/acquiring-bill-currency-session.js |
| `importFlowFiles` | 3 | src/main-process/acquiring-bill-currency-session.js |
| `importFlowFilesWithOverwrite` | 3 | src/main-process/acquiring-bill-currency-session.js |
| `insertBillRow` | 3 | src/backend/acquiring-bill-currency-db/import-repository.js |
| `insertDiffRows` | 3 | src/backend/biz-op-recon-db/run-repository.js |
| `insertDiffRowsByJoinChunked` | 3 | src/backend/acquiring-bill-currency-db/run-repository.js |
| `insertDiffRowsByJoinMultiWorker` | 3 | src/backend/acquiring-bill-currency-db/run-repository.js |
| `insertFlowRow` | 3 | src/backend/acquiring-bill-currency-db/import-repository.js |
| `insertRunFiles` | 3 | src/backend/vcc-op-calc-db/run-repository.js |
| `isStorageRootOnOneDrive` | 3 | src/main-process/onedrive-detector.js |
| `iterateDiffRowsByDateRange` | 3 | src/backend/acquiring-bill-currency-db/run-repository.js |
| `LINKED_IMPORT_SIGNATURES` | 3 | src/constants/table-signatures.js |
| `listAllByChannelId` | 3 | src/backend/database/scenarios-repository.js |
| `listBuiltinFixedForChannel` | 3 | src/backend/database/scenarios-repository.js |
| `listDistinctMonths` | 3 | src/backend/vcc-op-calc-db/run-repository.js |
| `listMatchedDiffRowIds` | 3 | src/backend/pending-reconcile/removal-match.js |
| `listMatchedRemovedRowIds` | 3 | src/backend/pending-reconcile/removal-match.js |
| `listRunsForMonthPair` | 3 | src/backend/pending-db/diff-repository.js |
| `loadFundTypeEnum` | 3 | src/constants/fund-type-enum.js |
| `loadGatewayReconHeaders` | 3 | src/constants/gateway-recon-headers-loader.js |
| `markCleanupPending` | 3 | src/backend/acquiring-bill-currency-db/run-repository.js |
| `mergeBankStatementRows` | 3 | src/main-process/bank-statement-merge.js |
| `openBackgroundPalette` | 3 | src/renderer.js |
| `openPendingDb` | 3 | src/backend/pending-db.js |
| `parseBankAccountExcel` | 3 | src/backend/bank-account-import.js |
| `parseScenarioBundle` | 3 | src/backend/scenarios-bundle-io.js |
| `peekMonthKeyFromFile` | 3 | src/backend/acquiring-bill-currency-import/reader.js |
| `pickBankDepositFields` | 3 | src/backend/database/linked-table-repository.js |
| `pickStaleHits` | 3 | src/main-process/scenario-engines/r5-refund-order-backfill.js |
| `prepareBillInsert` | 3 | src/backend/acquiring-bill-currency-db/import-repository.js |
| `prepareFlowInsert` | 3 | src/backend/acquiring-bill-currency-db/import-repository.js |
| `readBankFile` | 3 | src/backend/bank-bu-recon-import/reader.js |
| `readBigAccountMode` | 3 | src/backend/big-account-mode-store.js |
| `readBigAccountOrder` | 3 | src/backend/big-account-order-store.js |
| `readPendingGuanliFile` | 3 | src/backend/bank-bu-recon-import/reader.js |
| `rebuildAdmDerivation` | 3 | src/main-process/linked-derive-rebuild.js |
| `rebuildBankDepositBocDerivation` | 3 | src/main-process/linked-derive-rebuild.js |
| `rebuildFxBocDerivation` | 3 | src/main-process/linked-derive-rebuild.js |
| `recordFromBankStatementRows` | 3 | src/backend/database/channel-enum-repository.js |
| `REFUND_BACKFILL_FIELD_MAP` | 3 | src/constants/refund-backfill-fields.js |
| `removeStatementSessionEntriesByFilePath` | 3 | src/main-process/statement-session.js |
| `reportStartupFailure` | 3 | src/backend/startup-failure.js |
| `runOwnAccountsMigration` | 3 | src/backend/database/own-accounts-migration.js |
| `runPipeline` | 3 | src/backend/big-table-import/pipeline.js |
| `runReconIdFix` | 3 | src/main-process/recon-id-fix-engine.js |
| `scanFxGroups` | 3 | src/main-process/boc-fx-link-builder.js |
| `serializeScenarioBundle` | 3 | src/backend/scenarios-bundle-io.js |
| `setApplicableChannelIds` | 3 | src/backend/database/scenarios-repository.js |
| `showComingSoon` | 3 | src/renderer.js |
| `SIDE_DB_DDL_BIZ_OP` | 3 | src/backend/run-data-store.js |
| `streamLinkedRowsToInsert` | 3 | src/main-process/linked-table-stream-source.js |
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
| `writePlatformCleanupOutput` | 3 | src/main-process/platform-cleanup-writer.js |
| `writeRefundBackfillOutput` | 3 | src/main-process/refund-backfill-writer.js |
| `writeRunOutputs` | 3 | src/main-process/acquiring-bill-currency-writer.js |
| `writeScenarioHitRows` | 3 | src/main-process/scenario-hit-rows-writer.js |
| `writeSingleDateDiffWorkbook` | 3 | src/main-process/biz-op-recon-writer.js |
| `BALANCE_SEED_GENERATION_METHODS` | 2 | src/backend/balance-seed-store.js |
| `CELL_OPEN_RE` | 2 | src/backend/acquiring-bill-currency-import/reader-handrolled.js |
| `CELL_R_RE` | 2 | src/backend/acquiring-bill-currency-import/reader-handrolled.js |
| `readBankStatement` | 2 | src/main-process/bank-statement-io.js |
| `readGatewayRecon` | 2 | src/main-process/bank-statement-io.js |
| `readMeaningfulRowsHead` | 2 | src/backend/file-service/readers.js |
| `readReconIdFixFile` | 2 | src/main-process/recon-id-fix-io.js |
| `readXlsxSheetMetaLite` | 2 | src/backend/file-service/readers.js |
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

### `src/backend/acquiring-bill-currency-db/raw-json-retention.js`

| 名字 | 总次数 |
|---|---:|
| `CLEAR_STALE_SQL` | 3 |

### `src/backend/acquiring-bill-currency-db/run-repository.js`

| 名字 | 总次数 |
|---|---:|
| `BILL_TABLE` | 13 |
| `buildSelectOnlyChunkSql` | 3 |
| `CURRENCY_MISMATCH_PREDICATE_SQL` | 3 |
| `DIFF_JOIN_BODY_SQL` | 3 |
| `DIFF_TYPE_CASE_SQL` | 3 |
| `MULTIWORKER_PART_COLUMNS` | 3 |
| `MULTIWORKER_TARGET_COLUMNS` | 3 |

### `src/backend/acquiring-bill-currency-import/contract-bill.js`

| 名字 | 总次数 |
|---|---:|
| `BILL_DELETE_SQL` | 3 |
| `BILL_REQUIRED_COLUMNS` | 3 |

### `src/backend/acquiring-bill-currency-import/contract-flow.js`

| 名字 | 总次数 |
|---|---:|
| `FLOW_VALUE_WHITELIST` | 4 |
| `FLOW_DELETE_SQL` | 3 |

### `src/backend/acquiring-bill-currency-import/reader.js`

| 名字 | 总次数 |
|---|---:|
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

### `src/backend/big-table-import/contract.js`

| 名字 | 总次数 |
|---|---:|
| `isIndexArray` | 3 |

### `src/backend/big-table-import/engine.js`

| 名字 | 总次数 |
|---|---:|
| `openDbWithPragma` | 3 |
| `pipeline` | 3 |

### `src/backend/big-table-import/import-worker.js`

| 名字 | 总次数 |
|---|---:|
| `makeErrEntry` | 4 |
| `recordError` | 4 |
| `throwErrorsLimit` | 4 |
| `parseFile` | 3 |

### `src/backend/big-table-import/pipeline.js`

| 名字 | 总次数 |
|---|---:|
| `computeMaxParallel` | 3 |
| `FREEMEM_GATE_BYTES` | 3 |

### `src/backend/big-table-import/row-scanner.js`

| 名字 | 总次数 |
|---|---:|
| `SLASH` | 9 |
| `GT` | 8 |
| `LT` | 7 |
| `QUOTE` | 7 |
| `isSpaceByte` | 6 |
| `cellValueFromBody` | 5 |
| `ensureIndex` | 5 |
| `cellHasText` | 4 |
| `lastCollectedText` | 4 |
| `BUF_SHEETDATA_OPEN` | 3 |
| `BUF_SHEETDATA_SELFCLOSE` | 3 |
| `isWordByte` | 3 |
| `matchAt` | 3 |
| `parseCellColumn` | 3 |
| `parseCellType` | 3 |
| `ST_SEEK_ROW` | 3 |
| `ST_SEEK_SHEETDATA` | 3 |

### `src/backend/big-table-import/zip-reader.js`

| 名字 | 总次数 |
|---|---:|
| `readEntryAsString` | 4 |
| `locateSheets` | 3 |
| `WORKBOOK_ENTRY_NAME` | 3 |
| `WORKBOOK_RELS_ENTRY_NAME` | 3 |

### `src/backend/biz-op-recon-db/columns.js`

| 名字 | 总次数 |
|---|---:|
| `BIZ_OP_COLUMN_DEFS` | 5 |

### `src/backend/biz-op-recon-import/contract-flow.js`

| 名字 | 总次数 |
|---|---:|
| `buildFlowDbRow` | 3 |
| `FLOW_MAX_COLLECTED_ERRORS` | 3 |

### `src/backend/biz-op-recon-import/import-worker.js`

| 名字 | 总次数 |
|---|---:|
| `emitAndExit` | 21 |
| `_terminalEmitted` | 3 |
| `emitHeaderOrFatal` | 3 |
| `serializeErrorRow` | 3 |

### `src/backend/biz-op-recon-import/reader-streamed.js`

| 名字 | 总次数 |
|---|---:|
| `buildCollectReader` | 3 |
| `buildStreamReader` | 3 |
| `locateFirstSheet` | 3 |

### `src/backend/database.js`

| 名字 | 总次数 |
|---|---:|
| `linkedTableRepository` | 36 |
| `scenariosRepository` | 15 |
| `formatBytesForLog` | 6 |
| `channelEnumRepository` | 4 |
| `ONE_TIME_VACUUM_FLAG_KEY` | 3 |

### `src/backend/database/backup-retention.js`

| 名字 | 总次数 |
|---|---:|
| `isManagedBackupFile` | 4 |
| `NEW_FORMAT_BACKUP_RE` | 3 |
| `OLD_FORMAT_BACKUP_RE` | 3 |
| `PROTECTED_FILE_NAMES` | 3 |

### `src/backend/database/channel-enum-repository.js`

| 名字 | 总次数 |
|---|---:|
| `VALUE_TYPE_CHANNEL` | 5 |
| `VALUE_TYPE_CHANNEL_REGION` | 4 |
| `recordValue` | 3 |

### `src/backend/database/channels-repository.js`

| 名字 | 总次数 |
|---|---:|
| `rowToChannel` | 5 |
| `GENERAL_CHANNEL_ID` | 3 |
| `validateLocation` | 3 |

### `src/backend/database/linked-table-repository.js`

| 名字 | 总次数 |
|---|---:|
| `getDef` | 15 |
| `BOC_FX_TABLE` | 12 |
| `BOC_KEY_MATURITY_ISO` | 9 |
| `BOC_KEY_ORIG_GROUP` | 9 |
| `BOC_KEY_TXN_NO` | 8 |
| `normalizeSourceFileName` | 8 |
| `normalizeDateForRange` | 7 |
| `recomputeLinkedMeta` | 7 |
| `ADM_TABLE` | 6 |
| `BOC_FIELD_GROUP` | 6 |
| `BOC_KEY_SOURCE_ROW` | 6 |
| `buildLinkedUpsertContext` | 5 |
| `HIT_MARKER_READ_CHUNK` | 5 |
| `BOC_BANK_TABLE` | 4 |
| `BOC_FIELD_ALLOCATION_NO` | 4 |
| `BOC_FIELD_RECON_LINK_ID` | 4 |
| `buildDateRangeWhere` | 4 |
| `countLinkedByDateRange` | 4 |
| `recomputeGatewayMeta` | 4 |
| `upsertLinkedTableMeta` | 4 |
| `__missingDepositFields` | 3 |
| `ALL_TABLE_KEYS` | 3 |
| `BOC_FIELD_TXN_NO` | 3 |
| `buildGatewayUpsertContext` | 3 |
| `createInsertContext` | 3 |
| `LINKED_TABLE_DEFS` | 3 |

### `src/backend/database/migrations.js`

| 名字 | 总次数 |
|---|---:|
| `N4_CONT_2_DIFF_ROWS_TABLE` | 10 |
| `N4_CONT_2_DIFF_ROWS_TABLE_NEW` | 5 |
| `REFUND_BACKFILL_SCENARIO` | 5 |
| `BILL_RAW_JSON_V2_MIGRATED_KEY` | 4 |
| `BOC_DISPATCH_ORDER_SCENARIO` | 4 |
| `JPM_DISPATCH_ORDER_SCENARIO` | 4 |
| `N4_CONT_2_DIFF_ROWS_CASCADE_MIGRATED_MARKER` | 4 |
| `N5_SCENARIOS_UNIQUE_MIGRATED_MARKER` | 4 |
| `BOC_DISPATCH_ORDER_SCENARIO_SEEDED_MARKER` | 3 |
| `ensureChannelsTable` | 3 |
| `ensureScenariosChannelIdColumn` | 3 |
| `JPM_DISPATCH_ORDER_SCENARIO_SEEDED_MARKER` | 3 |
| `N5_MIGRATED_MARKER` | 3 |
| `RECON_ROUND_BUILTIN_SCENARIOS` | 3 |
| `RECON_ROUND_BUILTIN_SCENARIOS_SEEDED_MARKER` | 3 |
| `REFUND_BACKFILL_SCENARIO_SEEDED_MARKER` | 3 |
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
| `rowToDetail` | 8 |
| `hasChannelIdColumn` | 6 |
| `hasChannelIdColumnCache` | 5 |
| `isScenarioNameUniqueError` | 5 |
| `RECON_ID_FIX_DISPLAY_INDEX_CATEGORIES` | 4 |
| `validateEnabled` | 4 |
| `calculateNextScenarioId` | 3 |
| `normalizeC2Config` | 3 |
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
| `ACQUIRING_BILL_WORKER_COUNT_MAX` | 5 |
| `ACQUIRING_BILL_WORKER_COUNT_MIN` | 5 |
| `UI_STYLE_DEFAULT` | 5 |
| `CURRENT_MODULE_VALID` | 4 |
| `RECON_ID_FIX_BILL_CATEGORY_KEY` | 4 |
| `RECON_ID_FIX_BILL_CATEGORY_VALID` | 4 |
| `UI_STYLE_KEY` | 4 |
| `WIN_ONEDRIVE_STORAGE_NOTICE_SHOWN_KEY` | 4 |
| `CURRENT_MODULE_KEY` | 3 |

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

### `src/backend/pending-db/removed-repository.js`

| 名字 | 总次数 |
|---|---:|
| `indexValue` | 7 |

### `src/backend/pending-db/rule-repository.js`

| 名字 | 总次数 |
|---|---:|
| `RULE_GLOBAL_ID` | 4 |

### `src/backend/pending-export/writer.js`

| 名字 | 总次数 |
|---|---:|
| `appendSheetWithHeaderFont` | 9 |
| `FUND_TYPE_COLUMN` | 7 |
| `buildExportRowsForDiff` | 6 |
| `buildSingleExportRow` | 6 |
| `buildHeaders` | 5 |
| `computeAmountDiff` | 4 |
| `appendRemovalReconcileSheets` | 3 |
| `computeChangedFields` | 3 |
| `getMetaColIndices` | 3 |
| `readPendingRow` | 3 |
| `REMOVAL_STATUS_COLUMN` | 3 |
| `REMOVAL_STATUS_DIFF_PREFIX` | 3 |
| `REMOVAL_STATUS_MISSING_ONLY` | 3 |
| `REMOVAL_STATUS_VERIFIED` | 3 |
| `resolveRemovalStatus` | 3 |
| `SHEET_FUND_TYPE_DIFF_NAME` | 3 |
| `SHEET_MISSING_REMOVAL_NAME` | 3 |
| `SHEET_REMOVAL_ONLY_NAME` | 3 |
| `SHEET_SUMMARY_NAME` | 3 |

### `src/backend/pending-import/contract-pending.js`

| 名字 | 总次数 |
|---|---:|
| `lastHashValue` | 4 |
| `lastHashValuesRef` | 3 |
| `PENDING_MAX_COLLECTED_ERRORS` | 3 |
| `rowHashFor` | 3 |

### `src/backend/pending-import/removed-reader.js`

| 名字 | 总次数 |
|---|---:|
| `INDEX_FIELDS` | 3 |
| `validateRemovedHeaders` | 3 |

### `src/backend/pending-import/streaming-xlsx-writer.js`

| 名字 | 总次数 |
|---|---:|
| `XML_HEAD` | 6 |
| `buildRowXml` | 4 |
| `columnLetter` | 3 |
| `xmlEscape` | 3 |

### `src/backend/pending-import/xlsx-size-preflight.js`

| 名字 | 总次数 |
|---|---:|
| `SIZE_LIMIT_BYTES` | 5 |
| `WORKSHEET_ENTRY_RE` | 4 |
| `bytesToGb` | 3 |
| `collectEntrySizes` | 3 |
| `ENTRY_ERROR_CODE` | 3 |

### `src/backend/pending-reconcile/engine.js`

| 名字 | 总次数 |
|---|---:|
| `assertFieldsInPendingColumns` | 4 |
| `buildChangedClause` | 3 |
| `ensureMatchIndex` | 3 |
| `makeFieldIndexName` | 3 |

### `src/backend/pending-reconcile/removal-match.js`

| 名字 | 总次数 |
|---|---:|
| `normalizeCompareKey` | 5 |
| `readRemovedFieldRaw` | 4 |
| `readPendingFieldRaw` | 3 |
| `readPendingFieldValue` | 3 |
| `readRemovedFieldValue` | 3 |

### `src/backend/run-data-store.js`

| 名字 | 总次数 |
|---|---:|
| `assertModule` | 5 |
| `moduleDir` | 5 |
| `KNOWN_MODULES` | 4 |
| `RUN_DATA_DIRNAME` | 4 |
| `SIDE_DB_PRAGMA_STATEMENTS` | 4 |
| `sideDbFileName` | 4 |
| `assertMonthKey` | 3 |
| `monthKeyFromFileName` | 3 |
| `runDataRoot` | 3 |

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

### `src/backend/vcc-op-calc-db/run-repository.js`

| 名字 | 总次数 |
|---|---:|
| `RUN_FILES_TABLE` | 3 |

### `src/backend/vcc-op-calc-import/reader.js`

| 名字 | 总次数 |
|---|---:|
| `COL_COUNT` | 7 |

### `src/constants/adm-bank-deposit-fields.js`

| 名字 | 总次数 |
|---|---:|
| `__gwTypeCol` | 4 |

### `src/constants/boc-dispatch-order-fields.js`

| 名字 | 总次数 |
|---|---:|
| `BOC_FX_FIELD_MAP` | 7 |

### `src/constants/boc-fx-link-fields.js`

| 名字 | 总次数 |
|---|---:|
| `BOC_LINK_EXTRA_FIELDS` | 3 |

### `src/constants/fund-type-enum.js`

| 名字 | 总次数 |
|---|---:|
| `enumCacheByPath` | 5 |
| `getDefaultFundTypeEnumPath` | 3 |

### `src/constants/gateway-recon-headers-loader.js`

| 名字 | 总次数 |
|---|---:|
| `headersCacheByPath` | 5 |
| `CUSTOM_VALUE_SENTINEL` | 3 |
| `getDefaultGatewayReconHeadersPath` | 3 |

### `src/constants/table-signatures.js`

| 名字 | 总次数 |
|---|---:|
| `LINKED_TABLE_SIGNATURES` | 4 |
| `BANK_DEPOSIT_SIGNATURE` | 3 |
| `BANK_STATEMENT_SIGNATURE` | 3 |
| `FX_OPTION_SIGNATURE` | 3 |
| `GATEWAY_RECON_SIGNATURE` | 3 |
| `INTAKE_ORIGINAL_ORDER_SIGNATURE` | 3 |
| `ZHONGTAI_REFUND_ORDER_SIGNATURE` | 3 |

### `src/main-process/acquiring-bill-currency-session.js`

| 名字 | 总次数 |
|---|---:|
| `safeBegin` | 7 |
| `importReader` | 6 |
| `nowIso` | 6 |
| `USE_BIG_TABLE_IMPORT_ENGINE` | 6 |
| `adaptiveChunkSizeForMultiWorker` | 4 |
| `BILL_CONTRACT_PATH` | 4 |
| `FLOW_CONTRACT_PATH` | 4 |
| `cleanupAfterRunBackground` | 3 |
| `emitReadingEvents` | 3 |
| `importFilesInTransaction` | 3 |
| `importFilesWithOverwrite` | 3 |
| `MULTIWORKER_MIN_CHUNK_SIZE` | 3 |
| `MULTIWORKER_MIN_TOTAL_ROWS` | 3 |
| `normalizeEngineResult` | 3 |
| `resolveDbPath` | 3 |
| `shouldFallbackToSingleWorker` | 3 |

### `src/main-process/acquiring-bill-currency-writer.js`

| 名字 | 总次数 |
|---|---:|
| `buildOutputDir` | 4 |
| `formatRanAtLocal` | 4 |
| `MAX_DATA_ROWS_PER_SHEET` | 4 |
| `fmtSheetName` | 3 |
| `planSegments` | 3 |

### `src/main-process/adm-bank-deposit-builder.js`

| 名字 | 总次数 |
|---|---:|
| `normCell` | 8 |
| `normKey` | 4 |
| `assignBatchNo` | 3 |
| `matchAdmToMidAllocation` | 3 |
| `normalizeBillDateIso` | 3 |

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

### `src/main-process/bank-statement-merge.js`

| 名字 | 总次数 |
|---|---:|
| `bankStatementHeadersEqual` | 3 |

### `src/main-process/biz-op-recon-run-data.js`

| 名字 | 总次数 |
|---|---:|
| `monthOf` | 10 |
| `ensureSideDbExists` | 3 |

### `src/main-process/biz-op-recon-session.js`

| 名字 | 总次数 |
|---|---:|
| `BIZOP_FLOW_DB_COLUMNS` | 3 |
| `makeBizOpErrorReportFileName` | 3 |
| `spawnImportWorker` | 3 |

### `src/main-process/biz-op-recon-writer.js`

| 名字 | 总次数 |
|---|---:|
| `addTruncationNote` | 3 |
| `listDatesInRange` | 3 |
| `normalizeDateToISO` | 3 |

### `src/main-process/boc-fx-link-builder.js`

| 名字 | 总次数 |
|---|---:|
| `KEY_MATURITY_ISO` | 6 |
| `KEY_ORIG_GROUP` | 4 |
| `extractLongestDigitRun` | 3 |
| `KEY_SOURCE_ROW` | 3 |
| `KEY_TXN_NO` | 3 |
| `matchBocToMidAllocation` | 3 |

### `src/main-process/exceljs-writer.js`

| 名字 | 总次数 |
|---|---:|
| `POF` | 11 |
| `cellToString` | 9 |
| `MARK_WITHOUT_RESULT` | 4 |
| `PAYMENT_OFFLINE_SHEET` | 4 |
| `buildHitDetail` | 3 |
| `HIT_DETAIL_HEADER` | 3 |
| `resolveReconIdCell` | 3 |
| `SHEET1_A1_NOTICE` | 3 |
| `SHEET1_UNMATCHED_NAME` | 3 |
| `SHEET2_HIT_NAME` | 3 |
| `stripInternalFields` | 3 |

### `src/main-process/monthly-balance.js`

| 名字 | 总次数 |
|---|---:|
| `buildTargetLastDay` | 3 |
| `isRegularTemplate` | 3 |
| `lastDayOfMonth` | 3 |
| `pickLatestSeedForAccount` | 3 |

### `src/main-process/platform-cleanup-writer.js`

| 名字 | 总次数 |
|---|---:|
| `CLEANUP_SHEET_NAME` | 3 |

### `src/main-process/recon-id-fix-io.js`

| 名字 | 总次数 |
|---|---:|
| `readSheetOrThrow` | 5 |

### `src/main-process/reconciliation-orchestrator.js`

| 名字 | 总次数 |
|---|---:|
| `bucketScenarios` | 3 |
| `buildOutputRows` | 3 |

### `src/main-process/refund-backfill-writer.js`

| 名字 | 总次数 |
|---|---:|
| `UNMATCHED_HEADERS` | 4 |
| `BACKFILL_SHEET_NAME` | 3 |
| `projectRow` | 3 |
| `UNMATCHED_SHEET_NAME` | 3 |

### `src/main-process/run-check-multiworker-worker.js`

| 名字 | 总次数 |
|---|---:|
| `buildPartTableSql` | 3 |
| `writeChunkToTemp` | 3 |

### `src/main-process/run-check-worker-pool.js`

| 名字 | 总次数 |
|---|---:|
| `workerInstance` | 25 |
| `workerInitPromise` | 11 |
| `lastBusyEndTs` | 7 |
| `failureListener` | 5 |
| `handleWorkerFailure` | 4 |
| `shutdown` | 4 |
| `ensureInitialized` | 3 |

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

### `src/main-process/scenario-engines/c2-offset-bill-mark.js`

| 名字 | 总次数 |
|---|---:|
| `normalizeBillTypes` | 4 |
| `classifyRowsByBillTypes` | 3 |
| `normalizeBillTypeRow` | 3 |
| `pairsMatch` | 3 |

### `src/main-process/scenario-engines/c3-gateway-recon-join.js`

| 名字 | 总次数 |
|---|---:|
| `evalCondition` | 5 |
| `getBankRowValueForC3` | 4 |
| `gwMatchesBank` | 3 |

### `src/main-process/scenario-engines/c4-recon-id-fix.js`

| 名字 | 总次数 |
|---|---:|
| `resolveSubBizType` | 14 |
| `parseBillDateMs` | 10 |
| `billDateMatches` | 8 |
| `lookupReconId` | 8 |
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
| `applyFieldValueOverrides` | 3 |
| `collectUnmatchedRows` | 3 |
| `groupReconFields` | 3 |
| `normalizeBillDateValue` | 3 |
| `sortRightRowsForManyToOne` | 3 |

### `src/main-process/scenario-engines/engine-week-utils.js`

| 名字 | 总次数 |
|---|---:|
| `FTA_FEATURE` | 4 |

### `src/main-process/scenario-engines/jpm-dispatch-order-fix.js`

| 名字 | 总次数 |
|---|---:|
| `extractBillDate` | 4 |
| `GW_TYPE_COL` | 4 |
| `DATE_IN_ADDITION` | 3 |
| `sumEqualsReceive` | 3 |

### `src/main-process/scenario-engines/r4-fund-nature-check.js`

| 名字 | 总次数 |
|---|---:|
| `BANK_FUND_TYPE_FIELD` | 7 |
| `applyHandler` | 3 |
| `GW_TRADE_TYPE_FIELD` | 3 |

### `src/main-process/scenario-engines/r5-fund-transfer-backfill.js`

| 名字 | 总次数 |
|---|---:|
| `gwAmountAbs` | 3 |

### `src/main-process/scenario-engines/r5-payment-offline-allocation-backfill.js`

| 名字 | 总次数 |
|---|---:|
| `dayMs` | 13 |
| `amountCurrencyEqual` | 5 |
| `billDateNotEarlier` | 3 |
| `billDateWithinLag` | 3 |
| `billDateWithinWindow` | 3 |
| `midPayeeAmount` | 3 |

### `src/main-process/scenario-engines/r5-platform-inbound-cleanup.js`

| 名字 | 总次数 |
|---|---:|
| `buildCleanupRow` | 3 |

### `src/main-process/scenario-engines/r5-refund-order-backfill.js`

| 名字 | 总次数 |
|---|---:|
| `detailBankToRo` | 7 |
| `RESULT_NOTICE` | 6 |
| `buildUnmatchedBankRow` | 5 |
| `extractFeature` | 4 |
| `RESULT_ERROR` | 4 |
| `buildBackfillRow` | 3 |
| `classifyCardinality` | 3 |
| `consumeAndBackfill` | 3 |
| `detailBankToDeposit` | 3 |
| `matchJpmHk` | 3 |
| `matchJpmUs` | 3 |
| `matchS1` | 3 |
| `matchS2` | 3 |
| `matchS2Mtx` | 3 |
| `matchS3` | 3 |
| `matchS4` | 3 |
| `normalizeBizIdKey` | 3 |
| `pushBankError` | 3 |

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

### `src/main-process/table-type-detector.js`

| 名字 | 总次数 |
|---|---:|
| `readers` | 9 |
| `isHeaderNotMatchedError` | 3 |
| `L2_HEADER_SCAN_ROWS` | 3 |
| `SHORT_TABLE_COLUMN_THRESHOLD` | 3 |
| `statusForMatchedKey` | 3 |

### `src/main-process/vcc-op-calc-session.js`

| 名字 | 总次数 |
|---|---:|
| `centsToAmountString` | 16 |
| `parseAmountToCents` | 4 |
| `validateAndExtractRow` | 4 |
| `extractYearMonth` | 3 |
| `normalizeDirection` | 3 |

### `src/main-process/workbook-watermark.js`

| 名字 | 总次数 |
|---|---:|
| `WATERMARK_AUTHOR` | 4 |

### `src/main.js`

| 名字 | 总次数 |
|---|---:|
| `acquiringBillCurrencyOperationLock` | 9 |
| `startupMetrics` | 3 |

### `src/preload.js`

| 名字 | 总次数 |
|---|---:|
| `ipcRenderer` | 175 |
| `contextBridge` | 3 |

### `src/renderer.js`

| 名字 | 总次数 |
|---|---:|
| `getNewAccountRowElements` | 19 |
| `getNewAccountRows` | 19 |
| `getNewAccountRowState` | 12 |
| `rgbToCss` | 12 |
| `RENDERER_STARTUP_MARKS` | 11 |
| `cloneBackgroundSettings` | 10 |
| `getRendererStartupValue` | 10 |
| `isNewAccountMultiCurrencyMode` | 10 |
| `clampColorChannel` | 8 |
| `handleNewAccountFormMutation` | 8 |
| `rendererStartupProfiler` | 8 |
| `applyBackgroundSettings` | 7 |
| `closeNewAccountCurrencyDropdown` | 6 |
| `mixColor` | 6 |
| `STATEMENT_MODES` | 6 |
| `updateNewAccountCurrencyDropdownLabel` | 6 |
| `DEFAULT_BACKGROUND_SETTINGS` | 5 |
| `DEFAULT_SPECTRUM_PICK_COLOR` | 5 |
| `hexToRgb` | 5 |
| `renderNewAccountCurrencyOptions` | 5 |
| `syncNewAccountRowActionButtons` | 5 |
| `updateBankStatementUi` | 5 |
| `mixRgb` | 4 |
| `newAccountRowStateMap` | 4 |
| `normalizeColorHex` | 4 |
| `renderNewAccountCurrencyOptionsList` | 4 |
| `syncNewAccountDropdownFlag` | 4 |
| `updateNewAccountCurrencySuggestion` | 4 |
| `updateStatusBox` | 4 |
| `BACKGROUND_FILE_HINT` | 3 |
| `closeBackgroundPalette` | 3 |
| `getSpectrumColorAtPosition` | 3 |
| `handleBankStatementBatchImport` | 3 |
| `initializeNewAccountRow` | 3 |
| `isGatewayBillReady` | 3 |
| `lastUserActivityReportTs` | 3 |
| `notifyLinkedTableImportFailures` | 3 |
| `proceedToGwCheck` | 3 |
| `refreshReconIdFixStatus` | 3 |
| `resetBackgroundPickerSelection` | 3 |
| `runBankStatementInternal` | 3 |
| `syncNewAccountOpenDateInputType` | 3 |
| `updateSelectedColorSwatch` | 3 |

## B — 跨文件引用完整表

| 名字 | 跨度 | 总次数 | 声明数 | 前三引用位置 |
|---|---:|---:|---:|---|
| `path` | 56 | 169 | 50 | src/main-process/scenario-engines/c4-recon-id-fix.js(15), src/backend/run-data-store.js(9), src/main-process/biz-op-recon-session.js(7) |
| `fs` | 40 | 123 | 39 | src/backend/usage-stats.js(9), src/backend/file-service/readers.js(7), src/backend/run-data-store.js(7) |
| `parse` | 25 | 50 | 1 | src/backend/database/linked-table-repository.js(8), src/backend/database/migrations.js(7), src/backend/database/settings-repository.js(3) |
| `normalizeCell` | 21 | 113 | 10 | src/backend/file-service.js(34), src/backend/file-service/normalizers.js(12), src/backend/big-account-order-store.js(9) |
| `FileValidationError` | 18 | 82 | 9 | src/backend/file-service/readers.js(14), src/backend/file-service/normalizers.js(7), src/main-process/bank-statement-io.js(7) |
| `normalizeCellValue` | 15 | 152 | 6 | src/main-process/scenario-engines/r5-refund-order-backfill.js(30), src/main-process/scenario-engines/c4-recon-id-fix.js(21), src/main-process/boc-fx-link-builder.js(15) |
| `appendModuleLog` | 15 | 77 | 11 | src/backend/database.js(23), src/main-process/acquiring-bill-currency-session.js(13), src/backend/database/migrations.js(8) |
| `FLOW_HEADERS` | 14 | 35 | 8 | src/backend/acquiring-bill-currency-db/columns.js(6), src/backend/vcc-op-calc-import/validator.js(4), src/backend/acquiring-bill-currency-import/reader.js(3) |
| `validateHeaders` | 14 | 34 | 3 | src/backend/biz-op-recon-import/reader-streamed.js(7), src/backend/acquiring-bill-currency-import/reader.js(4), src/backend/bank-bu-recon-import/reader.js(4) |
| `XLSX` | 13 | 69 | 13 | src/backend/file-service/writers.js(20), src/main-process/pending-session.js(11), src/backend/pending-export/writer.js(9) |
| `applyWatermark` | 13 | 31 | 13 | src/main-process/biz-op-recon-writer.js(5), src/backend/file-service/writers.js(3), src/backend/pending-export/writer.js(3) |
| `makeWarningCollector` | 13 | 26 | 4 | src/main-process/scenario-engines/boc-dispatch-order-fix.js(2), src/main-process/scenario-engines/c1-extract-recon-id.js(2), src/main-process/scenario-engines/c2-offset-bill-mark.js(2) |
| `DatabaseSync` | 12 | 28 | 6 | src/main-process/run-check-multiworker-worker.js(6), src/backend/run-data-store.js(3), src/backend/big-table-import/engine.js(2) |
| `parseNumber` | 11 | 34 | 4 | src/main-process/scenario-engines/c3-gateway-recon-join.js(6), src/main-process/scenario-engines/engine-utils.js(4), src/main-process/scenario-engines/r5-fund-transfer-backfill.js(4) |
| `pad` | 10 | 66 | 2 | src/main-process/bank-statement-io.js(14), src/backend/logger.js(11), src/main-process/biz-op-recon-session.js(10) |
| `PENDING_COLUMNS` | 10 | 39 | 10 | src/backend/pending-export/writer.js(6), src/backend/pending-import/contract-pending.js(6), src/backend/pending-import/validator.js(6) |
| `BANK_STATEMENT_FIELDS` | 10 | 31 | 9 | src/renderer-dialogs.js(9), src/constants/bank-statement-fields.js(3), src/constants/table-signatures.js(3) |
| `validateFlowHeaders` | 10 | 20 | 8 | src/backend/acquiring-bill-currency-import/reader.js(3), src/backend/acquiring-bill-currency-import/contract-flow.js(2), src/backend/acquiring-bill-currency-import/validator.js(2) |
| `FLOW_DB_COLUMNS` | 9 | 27 | 3 | src/backend/biz-op-recon-import/contract-flow.js(6), src/backend/biz-op-recon-db/flow-imports-repository.js(5), src/backend/biz-op-recon-db/columns.js(4) |
| `listMonths` | 9 | 20 | 4 | src/main-process/bank-bu-recon-session.js(4), src/main-process/acquiring-bill-currency-session.js(3), src/preload.js(3) |
| `insertRun` | 9 | 13 | 4 | src/backend/acquiring-bill-currency-db/run-repository.js(2), src/backend/bank-bu-recon-db/run-repository.js(2), src/backend/biz-op-recon-db/run-repository.js(2) |
| `RUNS_TABLE` | 8 | 66 | 8 | src/backend/acquiring-bill-currency-db/run-repository.js(15), src/backend/biz-op-recon-db/run-repository.js(11), src/main-process/bank-bu-recon-run-data.js(9) |
| `isRowMeaningful` | 8 | 20 | 2 | src/backend/file-service/readers.js(6), src/backend/bank-bu-recon-import/reader.js(2), src/backend/biz-op-recon-import/reader-streamed.js(2) |
| `runReconciliation` | 8 | 18 | 5 | src/main-process/bank-bu-recon-session.js(5), src/main-process/bank-bu-recon-run-data.js(3), src/backend/pending-reconcile/engine.js(2) |
| `FIELD_MAP` | 7 | 103 | 6 | src/main-process/boc-fx-link-builder.js(34), src/main-process/scenario-engines/jpm-dispatch-order-fix.js(28), src/main-process/adm-bank-deposit-builder.js(14) |
| `runRepository` | 7 | 46 | 7 | src/main-process/biz-op-recon-run-data.js(12), src/main-process/bank-bu-recon-run-data.js(9), src/main-process/bank-bu-recon-session.js(6) |
| `toDate` | 7 | 26 | 6 | src/main-process/scenario-engines/r5-refund-order-backfill.js(7), src/main-process/scenario-engines/engine-date-utils.js(6), src/main-process/scenario-engines/engine-week-utils.js(4) |
| `ExcelJS` | 7 | 19 | 7 | src/main-process/biz-op-recon-writer.js(5), src/main-process/bank-bu-recon-writer.js(3), src/main-process/exceljs-writer.js(3) |
| `makeModificationCollector` | 7 | 14 | 1 | src/main-process/scenario-engines/c1-extract-recon-id.js(2), src/main-process/scenario-engines/c2-offset-bill-mark.js(2), src/main-process/scenario-engines/c3-gateway-recon-join.js(2) |
| `createContract` | 7 | 13 | 4 | src/backend/acquiring-bill-currency-import/contract-bill.js(2), src/backend/acquiring-bill-currency-import/contract-flow.js(2), src/backend/big-table-import/engine.js(2) |
| `getRunById` | 7 | 12 | 3 | src/backend/acquiring-bill-currency-db/run-repository.js(2), src/backend/biz-op-recon-db/run-repository.js(2), src/backend/pending-db/diff-repository.js(2) |
| `mapRow` | 7 | 10 | 1 | src/backend/pending-import/removed-reader.js(3), src/backend/big-table-import/contract.js(2), src/backend/acquiring-bill-currency-import/contract-bill.js(1) |
| `state` | 6 | 310 | 1 | src/renderer.js(154), src/renderer-pending.js(55), src/renderer-previews.js(41) |
| `session` | 6 | 60 | 3 | src/main-process/statement-session.js(28), src/main-process/statement-generation.js(10), src/main-process/acquiring-bill-currency-run-data.js(7) |
| `MAX_COLLECTED_ERRORS` | 6 | 21 | 5 | src/backend/acquiring-bill-currency-import/reader.js(6), src/backend/big-table-import/import-worker.js(4), src/backend/acquiring-bill-currency-import/contract-bill.js(3) |
| `BILL_HEADERS` | 6 | 18 | 6 | src/backend/acquiring-bill-currency-db/columns.js(7), src/backend/acquiring-bill-currency-import/contract-bill.js(3), src/backend/acquiring-bill-currency-import/reader.js(3) |
| `BIZ_OP_DB_COLUMNS` | 6 | 18 | 2 | src/backend/biz-op-recon-db/imports-repository.js(5), src/backend/biz-op-recon-db/columns.js(4), src/main-process/biz-op-recon-run-data.js(3) |
| `GATEWAY_BILL_FIELDS` | 6 | 14 | 4 | src/renderer-dialogs.js(4), src/constants/adm-bank-deposit-fields.js(2), src/constants/gateway-bill-recon-fields.js(2) |
| `normalizeDateExportValue` | 6 | 14 | 4 | src/backend/file-service.js(3), src/backend/file-service/normalizers.js(3), src/backend/database/linked-table-repository.js(2) |
| `deserializeError` | 6 | 10 | 1 | src/main-process/serialize-error.js(3), src/main-process/acquiring-bill-currency-session.js(2), src/main-process/big-table-import-dispatch.js(2) |
| `dialog` | 5 | 483 | 1 | src/renderer-dialogs.js(380), src/renderer.js(71), src/renderer-pending.js(26) |
| `setCurrentModule` | 5 | 60 | 2 | src/renderer-previews.js(52), src/renderer.js(3), src/backend/database.js(2) |
| `parseNumericValue` | 5 | 26 | 2 | src/backend/file-service.js(14), src/backend/file-service/writers.js(6), src/backend/file-service/normalizers.js(4) |
| `serializeError` | 5 | 26 | 1 | src/main-process/run-check-worker.js(7), src/main-process/run-check-multiworker-worker.js(6), src/backend/big-table-import/engine-worker-entry.js(5) |
| `CancelError` | 5 | 16 | 3 | src/main-process/acquiring-bill-currency-session.js(7), src/backend/big-table-import/pipeline.js(4), src/backend/big-table-import/engine.js(3) |
| `TEMPLATE_BILL_HEADERS` | 5 | 15 | 4 | src/main-process/acquiring-bill-currency-writer.js(6), src/backend/acquiring-bill-currency-db/columns.js(3), src/backend/acquiring-bill-currency-db/import-repository.js(2) |
| `cancel` | 5 | 14 | 1 | src/backend/big-table-import/pipeline.js(4), src/renderer-dialogs.js(4), src/main-process/run-check-worker.js(3) |
| `MS_PER_DAY` | 5 | 14 | 5 | src/main-process/scenario-engines/r5-payment-offline-allocation-backfill.js(5), src/main-process/scenario-engines/r5-refund-order-backfill.js(3), src/main-process/scenario-engines/engine-date-utils.js(2) |
| `VALID_DIRECTION_IN` | 5 | 14 | 4 | src/main-process/vcc-op-calc-session.js(5), src/backend/biz-op-recon-import/validator.js(3), src/backend/vcc-op-calc-db/columns.js(2) |
| `BIZ_OP_HEADERS` | 5 | 13 | 1 | src/main-process/biz-op-recon-writer.js(4), src/backend/biz-op-recon-import/reader-streamed.js(3), src/backend/biz-op-recon-db/columns.js(2) |
| `extractMonthKey` | 5 | 13 | 5 | src/backend/acquiring-bill-currency-import/contract-bill.js(3), src/backend/acquiring-bill-currency-import/contract-flow.js(3), src/backend/acquiring-bill-currency-import/reader.js(3) |
| `getMonthMeta` | 5 | 13 | 2 | src/main-process/bank-bu-recon-run-data.js(4), src/main-process/bank-bu-recon-session.js(3), src/backend/bank-bu-recon-db/month-repository.js(2) |
| `VALID_DIRECTION_OUT` | 5 | 12 | 4 | src/backend/biz-op-recon-import/validator.js(3), src/main-process/vcc-op-calc-session.js(3), src/backend/vcc-op-calc-db/columns.js(2) |
| `valuesEqual` | 5 | 12 | 1 | src/main-process/scenario-engines/c3-gateway-recon-join.js(3), src/main-process/scenario-engines/r5-fund-transfer-backfill.js(3), src/main-process/scenario-engines/c2-offset-bill-mark.js(2) |
| `evaluateCondition` | 5 | 11 | 1 | src/main-process/scenario-engines/c3-gateway-recon-join.js(3), src/main-process/scenario-engines/c1-extract-recon-id.js(2), src/main-process/scenario-engines/c2-offset-bill-mark.js(2) |
| `main` | 5 | 11 | 3 | src/renderer-dialogs.js(4), src/backend/biz-op-recon-import/import-worker.js(2), src/backend/pending-import/worker.js(2) |
| `listRuns` | 5 | 10 | 2 | src/main-process/bank-bu-recon-session.js(3), src/backend/bank-bu-recon-db/run-repository.js(2), src/backend/vcc-op-calc-db/run-repository.js(2) |
| `Worker` | 5 | 10 | 5 | src/backend/big-table-import/pipeline.js(2), src/main-process/acquiring-bill-currency-session.js(2), src/main-process/big-table-import-dispatch.js(2) |
| `formatTimestamp` | 5 | 9 | 5 | src/backend/database/backup.js(2), src/main-process/bank-bu-recon-session.js(2), src/main-process/bank-bu-recon-writer.js(2) |
| `JSZip` | 5 | 9 | 5 | src/backend/biz-op-recon-import/reader-streamed.js(2), src/backend/file-service/readers.js(2), src/backend/pending-import/streaming-xlsx-writer.js(2) |
| `loadSharedStrings` | 5 | 9 | 2 | src/backend/acquiring-bill-currency-import/reader.js(4), src/backend/big-table-import/zip-reader.js(2), src/backend/acquiring-bill-currency-import/reader-handrolled.js(1) |
| `readRows` | 5 | 9 | 2 | src/backend/file-service.js(3), src/backend/bank-account-import.js(2), src/backend/file-service/normalizers.js(2) |
| `saveMappings` | 5 | 9 | 1 | src/renderer-dialogs.js(3), src/backend/database.js(2), src/backend/database/template-repository.js(2) |
| `getLatestRun` | 5 | 8 | 2 | src/backend/acquiring-bill-currency-db/run-repository.js(2), src/backend/bank-bu-recon-db/run-repository.js(2), src/main-process/bank-bu-recon-run-data.js(2) |
| `deleteTemplate` | 5 | 7 | 1 | src/backend/database.js(2), src/backend/database/template-repository.js(2), src/preload.js(1) |
| `updateRunExportPath` | 5 | 7 | 2 | src/backend/bank-bu-recon-db/run-repository.js(2), src/backend/biz-op-recon-db/run-repository.js(2), src/main-process/bank-bu-recon-run-data.js(1) |
| `elements` | 4 | 157 | 1 | src/renderer.js(98), src/renderer-previews.js(38), src/renderer-pending.js(17) |
| `runDataStore` | 4 | 60 | 4 | src/main-process/biz-op-recon-run-data.js(26), src/main-process/bank-bu-recon-run-data.js(17), src/main-process/acquiring-bill-currency-run-data.js(16) |
| `parentPort` | 4 | 30 | 4 | src/main-process/run-check-worker.js(10), src/backend/big-table-import/engine-worker-entry.js(7), src/main-process/run-check-multiworker-worker.js(7) |
| `runRepo` | 4 | 28 | 4 | src/main-process/acquiring-bill-currency-session.js(21), src/main-process/acquiring-bill-currency-writer.js(4), src/main-process/acquiring-bill-currency-run-data.js(2) |
| `openSideDb` | 4 | 26 | 1 | src/main-process/biz-op-recon-run-data.js(12), src/main-process/bank-bu-recon-run-data.js(7), src/main-process/acquiring-bill-currency-run-data.js(5) |
| `FIXED_FIELD_VALUE_PREFIX` | 4 | 21 | 2 | src/backend/file-service.js(13), src/backend/database/utils.js(5), src/backend/file-service/common.js(2) |
| `importsRepository` | 4 | 21 | 4 | src/main-process/biz-op-recon-run-data.js(10), src/main-process/biz-op-recon-session.js(5), src/backend/biz-op-recon-import/import-worker.js(3) |
| `normalizeBu` | 4 | 18 | 3 | src/main-process/bank-bu-recon-session.js(8), src/main-process/biz-op-recon-session.js(5), src/backend/biz-op-recon-import/import-worker.js(3) |
| `app` | 4 | 17 | 1 | src/renderer.js(8), src/main.js(4), src/renderer-dialogs.js(4) |
| `importRepo` | 4 | 17 | 4 | src/main-process/acquiring-bill-currency-session.js(7), src/backend/acquiring-bill-currency-import/reader.js(5), src/main-process/acquiring-bill-currency-run-data.js(4) |
| `MERCHANT_ID_SELF_INPUT_OPTION` | 4 | 17 | 2 | src/renderer.js(8), src/renderer-dialogs.js(6), src/renderer-previews.js(2) |
| `writeErrorReport` | 4 | 17 | 1 | src/main-process/biz-op-recon-session.js(13), src/main-process/exceljs-writer.js(2), src/main-process/bank-statement-io.js(1) |
| `normalizeHeaderCell` | 4 | 15 | 4 | src/backend/bank-bu-recon-import/validator.js(4), src/backend/biz-op-recon-import/validator.js(4), src/backend/vcc-op-calc-import/validator.js(4) |
| `BALANCE_CALCULATED_OPTION` | 4 | 14 | 2 | src/renderer-dialogs.js(5), src/renderer.js(5), src/renderer-previews.js(3) |
| `BILL_KEY_COLUMN_INDICES` | 4 | 12 | 4 | src/backend/acquiring-bill-currency-import/contract-bill.js(6), src/backend/acquiring-bill-currency-import/reader.js(3), src/backend/acquiring-bill-currency-db/columns.js(2) |
| `logger` | 4 | 12 | 3 | src/main-process/biz-op-recon-session.js(5), src/main-process/run-check-worker.js(3), src/main-process/biz-op-recon-writer.js(2) |
| `SHARED_STRINGS_ENTRY_NAME` | 4 | 12 | 3 | src/backend/acquiring-bill-currency-import/reader.js(4), src/backend/pending-import/xlsx-size-preflight.js(4), src/backend/big-table-import/zip-reader.js(3) |
| `ADVANCED_MAPPING_FIELDS` | 4 | 11 | 2 | src/renderer-previews.js(4), src/renderer.js(4), src/renderer-dialogs.js(2) |
| `FLOW_KEY_COLUMN_INDICES` | 4 | 11 | 4 | src/backend/acquiring-bill-currency-import/contract-flow.js(4), src/backend/acquiring-bill-currency-import/reader.js(3), src/backend/acquiring-bill-currency-db/columns.js(2) |
| `normalizeTransactionNo` | 4 | 11 | 4 | src/main-process/boc-fx-link-builder.js(5), src/backend/database/linked-table-repository.js(2), src/backend/database/migrations.js(2) |
| `parseDateValue` | 4 | 11 | 1 | src/backend/file-service.js(4), src/backend/file-service/writers.js(4), src/backend/file-service/normalizers.js(2) |
| `BANK_DB_COLUMNS` | 4 | 10 | 1 | src/backend/bank-bu-recon-db/month-repository.js(3), src/main-process/bank-bu-recon-writer.js(3), src/backend/bank-bu-recon-db/columns.js(2) |
| `CHANNEL_BILL_FIELDS` | 4 | 10 | 2 | src/renderer-dialogs.js(4), src/constants/gateway-bill-recon-fields.js(2), src/main-process/recon-id-fix-io.js(2) |
| `getRun` | 4 | 10 | 2 | src/main-process/bank-bu-recon-session.js(4), src/backend/bank-bu-recon-db/run-repository.js(2), src/backend/vcc-op-calc-db/run-repository.js(2) |
| `listSideDbFiles` | 4 | 10 | 1 | src/main-process/biz-op-recon-run-data.js(4), src/backend/run-data-store.js(2), src/main-process/acquiring-bill-currency-run-data.js(2) |
| `PENDING_GUANLI_DB_COLUMNS` | 4 | 10 | 1 | src/backend/bank-bu-recon-db/month-repository.js(3), src/main-process/bank-bu-recon-writer.js(3), src/backend/bank-bu-recon-db/columns.js(2) |
| `sideDbExists` | 4 | 10 | 1 | src/main-process/acquiring-bill-currency-run-data.js(3), src/main-process/bank-bu-recon-run-data.js(3), src/backend/run-data-store.js(2) |
| `BANK_HEADERS` | 4 | 9 | 1 | src/main-process/bank-bu-recon-writer.js(3), src/backend/bank-bu-recon-db/columns.js(2), src/backend/bank-bu-recon-import/reader.js(2) |
| `dispatchEngineImport` | 4 | 9 | 4 | src/main-process/acquiring-bill-currency-session.js(3), src/main-process/big-table-import-dispatch.js(2), src/main-process/biz-op-recon-session.js(2) |
| `os` | 4 | 9 | 3 | src/backend/big-table-import/pipeline.js(5), src/renderer-dialogs.js(2), src/main-process/run-check-multiworker.js(1) |
| `PENDING_GUANLI_HEADERS` | 4 | 9 | 1 | src/main-process/bank-bu-recon-writer.js(3), src/backend/bank-bu-recon-db/columns.js(2), src/backend/bank-bu-recon-import/reader.js(2) |
| `streamFlowFile` | 4 | 9 | 4 | src/backend/biz-op-recon-import/reader-streamed.js(3), src/backend/biz-op-recon-import/import-worker.js(2), src/backend/vcc-op-calc-import/reader.js(2) |
| `BUSINESS_BILL_FIELDS` | 4 | 8 | 2 | src/constants/recon-id-fix-fields.js(2), src/main-process/recon-id-fix-io.js(2), src/preload.js(2) |
| `clearRunsAndDiffsByDateBu` | 4 | 8 | 1 | src/backend/biz-op-recon-db/run-repository.js(2), src/backend/biz-op-recon-import/import-worker.js(2), src/main-process/biz-op-recon-run-data.js(2) |
| `ensureRowId` | 4 | 8 | 1 | src/main-process/scenario-engines/c1-extract-recon-id.js(2), src/main-process/scenario-engines/c2-offset-bill-mark.js(2), src/main-process/scenario-engines/c3-gateway-recon-join.js(2) |
| `getRowsByDateBu` | 4 | 8 | 2 | src/main-process/biz-op-recon-session.js(3), src/backend/biz-op-recon-db/flow-imports-repository.js(2), src/backend/biz-op-recon-db/imports-repository.js(2) |
| `isMainThread` | 4 | 8 | 4 | src/backend/big-table-import/engine-worker-entry.js(2), src/backend/big-table-import/import-worker.js(2), src/main-process/run-check-multiworker-worker.js(2) |
| `listTemplates` | 4 | 8 | 1 | src/backend/database/template-repository.js(3), src/backend/database.js(2), src/main-process/monthly-balance.js(2) |
| `OPPONENT_BILL_FIELDS` | 4 | 8 | 2 | src/constants/recon-id-fix-fields.js(2), src/main-process/recon-id-fix-io.js(2), src/preload.js(2) |
| `ORDER_REPAIR_FIELDS_GATEWAY` | 4 | 8 | 3 | src/constants/gateway-bill-recon-fields.js(2), src/main-process/recon-id-fix-io.js(2), src/main-process/scenario-engines/c4-recon-id-fix.js(2) |
| `saveBillSplitAmountRules` | 4 | 8 | 1 | src/renderer-dialogs.js(3), src/backend/database.js(2), src/backend/database/template-repository.js(2) |
| `saveBillSplitMeta` | 4 | 8 | 1 | src/renderer-dialogs.js(3), src/backend/database.js(2), src/backend/database/template-repository.js(2) |
| `validateBillHeaders` | 4 | 8 | 4 | src/backend/acquiring-bill-currency-import/reader.js(3), src/backend/acquiring-bill-currency-import/contract-bill.js(2), src/backend/acquiring-bill-currency-import/validator.js(2) |
| `validateFlowRow` | 4 | 8 | 3 | src/backend/biz-op-recon-import/contract-flow.js(2), src/backend/biz-op-recon-import/import-worker.js(2), src/backend/biz-op-recon-import/validator.js(2) |
| `writeWorkbookRows` | 4 | 8 | 2 | src/backend/file-service.js(4), src/backend/file-service/writers.js(2), src/main-process/statement-generation.js(1) |
| `assertXlsxEntriesUnderLimit` | 4 | 7 | 4 | src/backend/biz-op-recon-import/reader-streamed.js(2), src/backend/pending-import/xlsx-size-preflight.js(2), src/backend/vcc-op-calc-import/reader.js(2) |
| `errorCodeToCause` | 4 | 7 | 4 | src/backend/file-service/error-causes.js(2), src/main-process/exceljs-writer.js(2), src/main-process/pending-session.js(2) |
| `insertRows` | 4 | 7 | 2 | src/backend/biz-op-recon-db/flow-imports-repository.js(2), src/backend/biz-op-recon-db/imports-repository.js(2), src/main-process/biz-op-recon-session.js(2) |
| `listAllRuns` | 4 | 7 | 1 | src/renderer-pending.js(3), src/backend/pending-db/diff-repository.js(2), src/backend/pending-export/writer.js(1) |
| `readRowsWithMetadata` | 4 | 7 | 1 | src/backend/file-service.js(3), src/main-process/table-type-detector.js(2), src/backend/file-service/readers.js(1) |
| `setChildParent` | 4 | 7 | 1 | src/backend/database.js(2), src/backend/database/template-repository.js(2), src/renderer-dialogs.js(2) |
| `writeBalanceWorkbook` | 4 | 7 | 2 | src/backend/file-service.js(3), src/backend/file-service/writers.js(2), src/main-process/statement-generation.js(1) |
| `clearBillSplitMergeGroups` | 4 | 6 | 1 | src/backend/database.js(2), src/backend/database/template-repository.js(2), src/preload.js(1) |
| `deleteBillSplitRow` | 4 | 6 | 1 | src/backend/database.js(2), src/backend/database/template-repository.js(2), src/preload.js(1) |
| `deleteSideDbByPath` | 4 | 6 | 1 | src/backend/run-data-store.js(3), src/main-process/acquiring-bill-currency-run-data.js(1), src/main-process/bank-bu-recon-run-data.js(1) |
| `runBizOpImport` | 4 | 6 | 2 | src/backend/biz-op-recon-import/import-worker.js(2), src/main-process/biz-op-recon-run-data.js(2), src/main.js(1) |
| `runFlowImport` | 4 | 6 | 2 | src/backend/biz-op-recon-import/import-worker.js(2), src/main-process/biz-op-recon-run-data.js(2), src/main.js(1) |
| `saveAmountSplitRules` | 4 | 6 | 1 | src/backend/database.js(2), src/backend/database/template-repository.js(2), src/preload.js(1) |
| `saveBillSplitMappings` | 4 | 6 | 1 | src/backend/database.js(2), src/backend/database/template-repository.js(2), src/preload.js(1) |
| `saveBillSplitMergeGroup` | 4 | 6 | 1 | src/backend/database.js(2), src/backend/database/template-repository.js(2), src/preload.js(1) |
| `saveBillSplitRow` | 4 | 6 | 1 | src/backend/database.js(2), src/backend/database/template-repository.js(2), src/preload.js(1) |
| `saveBillSplitRowCount` | 4 | 6 | 1 | src/backend/database.js(2), src/backend/database/template-repository.js(2), src/preload.js(1) |
| `setParentStatus` | 4 | 6 | 1 | src/backend/database.js(2), src/backend/database/template-repository.js(2), src/preload.js(1) |
| `splitTemplateName` | 4 | 6 | 2 | src/backend/database/own-accounts-migration.js(2), src/main-process/monthly-balance.js(2), src/main-process/statement-generation.js(1) |
| `StringDecoder` | 4 | 6 | 4 | src/backend/biz-op-recon-import/reader-streamed.js(2), src/backend/vcc-op-calc-import/reader.js(2), src/backend/acquiring-bill-currency-import/reader-handrolled.js(1) |
| `batchDelete` | 4 | 5 | 1 | src/backend/database/scenarios-repository.js(2), src/backend/database.js(1), src/preload.js(1) |
| `clearByDateBu` | 4 | 5 | 1 | src/backend/biz-op-recon-db/imports-repository.js(2), src/backend/biz-op-recon-import/import-worker.js(1), src/main-process/biz-op-recon-run-data.js(1) |
| `deleteSideDb` | 4 | 5 | 1 | src/backend/run-data-store.js(2), src/main-process/acquiring-bill-currency-run-data.js(1), src/main-process/bank-bu-recon-run-data.js(1) |
| `sideDbRelPath` | 4 | 5 | 1 | src/backend/run-data-store.js(2), src/main-process/acquiring-bill-currency-run-data.js(1), src/main-process/bank-bu-recon-run-data.js(1) |
| `sanitizeFileName` | 4 | 4 | 4 | src/backend/balance-seed-store.js(1), src/main-process/bank-statement-io.js(1), src/main-process/recon-id-fix-io.js(1) |
| `escapeHtml` | 3 | 172 | 1 | src/renderer-dialogs.js(142), src/renderer.js(29), src/renderer-previews.js(1) |
| `normalizeText` | 3 | 70 | 2 | src/backend/database/template-repository.js(57), src/backend/database/utils.js(10), src/backend/database/migrations.js(3) |
| `setStatus` | 3 | 69 | 1 | src/renderer.js(36), src/renderer-dialogs.js(32), src/renderer-previews.js(1) |
| `MODULE` | 3 | 55 | 3 | src/main-process/biz-op-recon-run-data.js(24), src/main-process/bank-bu-recon-run-data.js(16), src/main-process/acquiring-bill-currency-run-data.js(15) |
| `hasColumn` | 3 | 34 | 2 | src/backend/database/migrations.js(29), src/backend/database.js(3), src/backend/biz-op-recon-db/migrations.js(2) |
| `lastGeneratedExports` | 3 | 24 | 1 | src/main-process/statement-generation.js(17), src/main-process/statement-session.js(6), src/main.js(1) |
| `emit` | 3 | 23 | 3 | src/backend/pending-import/worker.js(10), src/main-process/pending-archive-worker.js(10), src/backend/biz-op-recon-import/import-worker.js(3) |
| `setSetting` | 3 | 22 | 1 | src/backend/database/settings-repository.js(17), src/backend/database.js(3), src/backend/database/own-accounts-migration.js(2) |
| `buildOutputRow` | 3 | 21 | 3 | src/main-process/scenario-engines/c4-recon-id-fix.js(17), src/main-process/scenario-engines/boc-dispatch-order-fix.js(2), src/main-process/scenario-engines/jpm-dispatch-order-fix.js(2) |
| `pad2` | 3 | 21 | 3 | src/main-process/acquiring-bill-currency-writer.js(11), src/backend/usage-stats.js(6), src/main-process/monthly-balance.js(4) |
| `getSetting` | 3 | 18 | 1 | src/backend/database/settings-repository.js(14), src/backend/database.js(3), src/backend/database/own-accounts-migration.js(1) |
| `CONCAT_FIELDS_MAPPING_FIELD` | 3 | 17 | 2 | src/renderer-dialogs.js(14), src/renderer.js(2), src/main.js(1) |
| `BALANCE_DISABLED_OPTION` | 3 | 16 | 2 | src/renderer-dialogs.js(9), src/renderer.js(6), src/main.js(1) |
| `PRAGMA_EXPECTED` | 3 | 14 | 3 | src/main-process/run-check-multiworker-worker.js(5), src/main-process/run-check-worker.js(5), src/backend/big-table-import/engine.js(4) |
| `applyStatementResult` | 3 | 13 | 1 | src/renderer.js(7), src/renderer-dialogs.js(5), src/renderer-previews.js(1) |
| `diffRepo` | 3 | 13 | 3 | src/backend/pending-export/writer.js(7), src/backend/pending-reconcile/engine.js(3), src/backend/pending-reconcile/removal-match.js(3) |
| `YELLOW_FILL` | 3 | 13 | 3 | src/main-process/bank-bu-recon-writer.js(6), src/main-process/biz-op-recon-writer.js(4), src/main-process/exceljs-writer.js(3) |
| `sideDbPath` | 3 | 12 | 1 | src/main-process/biz-op-recon-run-data.js(6), src/backend/run-data-store.js(5), src/main-process/acquiring-bill-currency-run-data.js(1) |
| `PRAGMA_STATEMENTS` | 3 | 10 | 3 | src/main-process/run-check-multiworker-worker.js(4), src/backend/big-table-import/engine.js(3), src/main-process/run-check-worker.js(3) |
| `BANK_STATEMENT_FIELDS_FOR_C3` | 3 | 9 | 2 | src/renderer-dialogs.js(5), src/constants/bank-statement-fields.js(2), src/preload.js(2) |
| `BANK_STATEMENT_VIRTUAL_AMOUNT_ABS` | 3 | 9 | 3 | src/constants/bank-statement-fields.js(3), src/main-process/scenario-engines/c3-gateway-recon-join.js(3), src/preload.js(3) |
| `buildHeaderValidator` | 3 | 9 | 3 | src/backend/acquiring-bill-currency-import/validator.js(3), src/backend/bank-bu-recon-import/validator.js(3), src/backend/biz-op-recon-import/validator.js(3) |
| `FLOW_TABLE` | 3 | 9 | 3 | src/backend/acquiring-bill-currency-db/run-repository.js(4), src/backend/biz-op-recon-import/contract-flow.js(3), src/backend/biz-op-recon-db/run-repository.js(2) |
| `getChannelById` | 3 | 9 | 1 | src/backend/database/channels-repository.js(6), src/backend/database.js(2), src/main-process/scenario-dispatcher.js(1) |
| `inferDateCellFormat` | 3 | 9 | 1 | src/backend/file-service/writers.js(4), src/backend/file-service.js(3), src/backend/file-service/normalizers.js(2) |
| `isNumericFieldName` | 3 | 9 | 3 | src/main-process/scenario-engines/c2-offset-bill-mark.js(4), src/main-process/scenario-engines/c3-gateway-recon-join.js(3), src/backend/pending-reconcile/removal-match.js(2) |
| `parseJsonArray` | 3 | 9 | 2 | src/backend/database/template-repository.js(3), src/backend/database/utils.js(3), src/backend/pending-db/rule-repository.js(3) |
| `REFUND_BANK_COLUMNS` | 3 | 9 | 1 | src/constants/refund-backfill-fields.js(4), src/main-process/scenario-engines/r5-refund-order-backfill.js(3), src/main-process/refund-backfill-writer.js(2) |
| `toExcelSerial` | 3 | 9 | 1 | src/backend/file-service/writers.js(4), src/backend/file-service.js(3), src/backend/file-service/normalizers.js(2) |
| `upsertMainRunMirror` | 3 | 9 | 3 | src/main-process/acquiring-bill-currency-run-data.js(3), src/main-process/bank-bu-recon-run-data.js(3), src/main-process/biz-op-recon-run-data.js(3) |
| `weekTag` | 3 | 9 | 2 | src/main-process/exceljs-writer.js(3), src/main-process/scenario-engines/engine-week-utils.js(3), src/main-process/scenario-engines/r5-payment-offline-allocation-backfill.js(3) |
| `AMOUNT_BASED_ACCOUNT_MAPPING_FIELD` | 3 | 8 | 2 | src/renderer-previews.js(3), src/renderer.js(3), src/main.js(2) |
| `AMOUNT_BASED_NAME_MAPPING_FIELD` | 3 | 8 | 2 | src/renderer-previews.js(3), src/renderer.js(3), src/main.js(2) |
| `AMOUNT_EPSILON` | 3 | 8 | 1 | src/backend/biz-op-recon-import/validator.js(4), src/backend/biz-op-recon-db/columns.js(2), src/main-process/biz-op-recon-session.js(2) |
| `AMOUNT_SPLIT_BY_FIELD_ENABLED_OPTION` | 3 | 8 | 2 | src/renderer-dialogs.js(5), src/renderer.js(2), src/main.js(1) |
| `AMOUNT_SPLIT_BY_FIELD_MAPPING_FIELD` | 3 | 8 | 2 | src/renderer-dialogs.js(3), src/renderer.js(3), src/main.js(2) |
| `applyHeaderRowFont` | 3 | 8 | 3 | src/backend/file-service/writers.js(3), src/main-process/pending-session.js(3), src/backend/pending-export/writer.js(2) |
| `cloneRowsWithMetadata` | 3 | 8 | 1 | src/main-process/statement-session.js(5), src/main-process/statement-generation.js(2), src/main.js(1) |
| `ensureBizOpReconTablesSupport` | 3 | 8 | 3 | src/backend/database.js(4), src/backend/biz-op-recon-db/migrations.js(2), src/backend/biz-op-recon-import/import-worker.js(2) |
| `FLOW_INSERT_SQL` | 3 | 8 | 3 | src/backend/acquiring-bill-currency-import/contract-flow.js(3), src/backend/biz-op-recon-import/contract-flow.js(3), src/backend/acquiring-bill-currency-db/import-repository.js(2) |
| `GATEWAY_RECON_FIELDS` | 3 | 8 | 3 | src/constants/gateway-recon-headers-loader.js(4), src/constants/gateway-recon-fields.js(2), src/main-process/bank-statement-io.js(2) |
| `getTemplateBigAccounts` | 3 | 8 | 1 | src/backend/database/template-repository.js(4), src/backend/database.js(2), src/main-process/monthly-balance.js(2) |
| `listDiffRows` | 3 | 8 | 1 | src/backend/pending-export/writer.js(4), src/backend/pending-db/diff-repository.js(2), src/backend/pending-reconcile/removal-match.js(2) |
| `normalizeCurrency` | 3 | 8 | 3 | src/backend/acquiring-bill-currency-db/import-repository.js(4), src/backend/acquiring-bill-currency-import/contract-bill.js(2), src/backend/acquiring-bill-currency-import/contract-flow.js(2) |
| `openZipWithEntries` | 3 | 8 | 2 | src/backend/acquiring-bill-currency-import/reader.js(4), src/backend/big-table-import/zip-reader.js(3), src/backend/acquiring-bill-currency-import/reader-handrolled.js(1) |
| `SIGNED_AMOUNT_MAPPING_FIELD` | 3 | 8 | 2 | src/renderer-previews.js(3), src/renderer.js(3), src/main.js(2) |
| `backfillBocReconLinkIds` | 3 | 7 | 1 | src/main-process/linked-derive-rebuild.js(4), src/main-process/boc-fx-link-builder.js(2), src/main.js(1) |
| `buildBocBankRows` | 3 | 7 | 1 | src/main-process/linked-derive-rebuild.js(4), src/main-process/boc-fx-link-builder.js(2), src/main.js(1) |
| `buildInsertSql` | 3 | 7 | 3 | src/backend/bank-bu-recon-db/month-repository.js(3), src/backend/biz-op-recon-db/flow-imports-repository.js(2), src/backend/biz-op-recon-db/imports-repository.js(2) |
| `createChannel` | 3 | 7 | 1 | src/main-process/scenarios-bundle-import.js(3), src/backend/database.js(2), src/backend/database/channels-repository.js(2) |
| `createScenario` | 3 | 7 | 1 | src/main-process/scenarios-bundle-import.js(3), src/backend/database.js(2), src/backend/database/scenarios-repository.js(2) |
| `getMonthReadiness` | 3 | 7 | 1 | src/main-process/acquiring-bill-currency-session.js(3), src/backend/acquiring-bill-currency-db/import-repository.js(2), src/main-process/acquiring-bill-currency-run-data.js(2) |
| `listChannels` | 3 | 7 | 1 | src/main-process/scenarios-bundle-import.js(3), src/backend/database.js(2), src/backend/database/channels-repository.js(2) |
| `normalizeInputFilePaths` | 3 | 7 | 1 | src/main-process/statement-generation.js(4), src/main-process/statement-session.js(2), src/main.js(1) |
| `readSheetAsRows` | 3 | 7 | 3 | src/backend/pending-import/removed-reader.js(3), src/backend/bank-bu-recon-import/reader.js(2), src/backend/biz-op-recon-import/reader.js(2) |
| `validateContract` | 3 | 7 | 3 | src/backend/big-table-import/engine.js(3), src/backend/big-table-import/contract.js(2), src/backend/big-table-import/import-worker.js(2) |
| `WORKER_SCRIPT_PATH` | 3 | 7 | 3 | src/backend/big-table-import/pipeline.js(3), src/main-process/run-check-multiworker.js(2), src/main-process/run-check-worker-pool.js(2) |
| `writeBizOpErrorReportXlsx` | 3 | 7 | 1 | src/main-process/biz-op-recon-session.js(4), src/main-process/biz-op-recon-writer.js(2), src/main.js(1) |
| `writeFlowErrorReportXlsx` | 3 | 7 | 1 | src/main-process/biz-op-recon-session.js(4), src/main-process/biz-op-recon-writer.js(2), src/main.js(1) |
| `xmlUnescape` | 3 | 7 | 3 | src/backend/big-table-import/row-scanner.js(5), src/backend/acquiring-bill-currency-import/reader-handrolled.js(1), src/backend/pending-import/streaming-xlsx-reader.js(1) |
| `buildDateDir` | 3 | 6 | 3 | src/main-process/scenario-hit-rows-writer.js(3), src/main-process/acquiring-bill-currency-writer.js(2), src/main-process/bank-statement-io.js(1) |
| `CHANNEL_VALUE` | 3 | 6 | 2 | src/backend/database/linked-table-repository.js(2), src/constants/adm-bank-deposit-fields.js(2), src/main-process/adm-bank-deposit-builder.js(2) |
| `clearMonth` | 3 | 6 | 2 | src/main-process/acquiring-bill-currency-session.js(3), src/backend/acquiring-bill-currency-db/import-repository.js(2), src/preload.js(1) |
| `columnLetterToIndex` | 3 | 6 | 2 | src/backend/acquiring-bill-currency-import/reader.js(3), src/backend/big-table-import/row-scanner.js(2), src/backend/acquiring-bill-currency-import/reader-handrolled.js(1) |
| `compileRegexLiteral` | 3 | 6 | 1 | src/backend/file-service/normalizers.js(3), src/backend/file-service.js(2), src/main.js(1) |
| `computeRowHash` | 3 | 6 | 3 | src/backend/pending-import/contract-pending.js(2), src/backend/pending-import/validator.js(2), src/backend/pending-import/worker.js(2) |
| `dayDiffWithin` | 3 | 6 | 3 | src/main-process/scenario-engines/engine-date-utils.js(2), src/main-process/scenario-engines/r5-fund-transfer-backfill.js(2), src/main-process/scenario-engines/r5-refund-order-backfill.js(2) |
| `deleteMonthSideDb` | 3 | 6 | 3 | src/main-process/acquiring-bill-currency-run-data.js(2), src/main-process/bank-bu-recon-run-data.js(2), src/main-process/biz-op-recon-run-data.js(2) |
| `flowRowToArray` | 3 | 6 | 1 | src/backend/biz-op-recon-db/columns.js(2), src/backend/vcc-op-calc-db/columns.js(2), src/main-process/biz-op-recon-writer.js(2) |
| `getAmountSplitRules` | 3 | 6 | 1 | src/backend/database/template-repository.js(3), src/backend/database.js(2), src/preload.js(1) |
| `groupBigAccountRows` | 3 | 6 | 2 | src/backend/database/template-repository.js(3), src/backend/database/utils.js(2), src/main.js(1) |
| `isRegexLiteral` | 3 | 6 | 1 | src/backend/file-service/normalizers.js(3), src/backend/file-service.js(2), src/main.js(1) |
| `loadCurrencyMappings` | 3 | 6 | 2 | src/backend/file-service.js(3), src/backend/file-service/normalizers.js(2), src/main.js(1) |
| `makeRowInserter` | 3 | 6 | 2 | src/backend/biz-op-recon-db/flow-imports-repository.js(2), src/backend/biz-op-recon-db/imports-repository.js(2), src/backend/biz-op-recon-import/import-worker.js(2) |
| `normalizeBillDate` | 3 | 6 | 3 | src/backend/acquiring-bill-currency-db/import-repository.js(2), src/backend/acquiring-bill-currency-import/contract-bill.js(2), src/backend/acquiring-bill-currency-import/validator.js(2) |
| `ORDER_REPAIR_FIELDS` | 3 | 6 | 2 | src/constants/recon-id-fix-fields.js(2), src/main-process/recon-id-fix-io.js(2), src/main-process/scenario-engines/c4-recon-id-fix.js(2) |
| `parseFtaDate` | 3 | 6 | 2 | src/main-process/exceljs-writer.js(2), src/main-process/scenario-engines/engine-week-utils.js(2), src/main-process/scenario-engines/r5-payment-offline-allocation-backfill.js(2) |
| `PAYMENT_OFFLINE_FIELD_MAP` | 3 | 6 | 1 | src/constants/payment-offline-allocation-fields.js(4), src/main-process/exceljs-writer.js(1), src/main-process/scenario-engines/r5-payment-offline-allocation-backfill.js(1) |
| `readBankDepositBocCandidates` | 3 | 6 | 1 | src/backend/database.js(2), src/backend/database/linked-table-repository.js(2), src/main-process/linked-derive-rebuild.js(2) |
| `readBocFxLinkRowsWithIds` | 3 | 6 | 1 | src/backend/database.js(2), src/backend/database/linked-table-repository.js(2), src/main-process/linked-derive-rebuild.js(2) |
| `readLinkedTableRows` | 3 | 6 | 1 | src/backend/database.js(2), src/backend/database/linked-table-repository.js(2), src/main-process/linked-derive-rebuild.js(2) |
| `readXlsxStreamed` | 3 | 6 | 3 | src/backend/file-service/readers.js(2), src/backend/pending-import/worker.js(2), src/main-process/linked-table-stream-source.js(2) |
| `reconcileOrphans` | 3 | 6 | 3 | src/main-process/acquiring-bill-currency-run-data.js(2), src/main-process/bank-bu-recon-run-data.js(2), src/main-process/biz-op-recon-run-data.js(2) |
| `recordExportPath` | 3 | 6 | 2 | src/main-process/bank-bu-recon-run-data.js(2), src/main-process/bank-bu-recon-session.js(2), src/main-process/biz-op-recon-run-data.js(2) |
| `rematchAllBocGroups` | 3 | 6 | 1 | src/main-process/linked-derive-rebuild.js(3), src/main-process/boc-fx-link-builder.js(2), src/main.js(1) |
| `replaceBocBankDeposit` | 3 | 6 | 1 | src/backend/database.js(2), src/backend/database/linked-table-repository.js(2), src/main-process/linked-derive-rebuild.js(2) |
| `resolveSinglePreparedFieldValue` | 3 | 6 | 1 | src/main-process/statement-generation.js(3), src/main-process/statement-session.js(2), src/main.js(1) |
| `runMigrations` | 3 | 6 | 3 | src/backend/pending-db.js(2), src/backend/pending-db/migrations.js(2), src/backend/pending-import/worker.js(2) |
| `SUPPORTED_EXTENSIONS` | 3 | 6 | 1 | src/backend/file-service.js(2), src/backend/file-service/common.js(2), src/backend/file-service/readers.js(2) |
| `validateBizOpHeaders` | 3 | 6 | 1 | src/backend/biz-op-recon-import/reader-streamed.js(2), src/backend/biz-op-recon-import/reader.js(2), src/backend/biz-op-recon-import/validator.js(2) |
| `validateBizOpRow` | 3 | 6 | 2 | src/backend/biz-op-recon-import/import-worker.js(2), src/backend/biz-op-recon-import/validator.js(2), src/main-process/biz-op-recon-session.js(2) |
| `writeBocFxLinkReconIds` | 3 | 6 | 1 | src/backend/database.js(2), src/backend/database/linked-table-repository.js(2), src/main-process/linked-derive-rebuild.js(2) |
| `writeDiffWorkbook` | 3 | 6 | 2 | src/main-process/acquiring-bill-currency-writer.js(3), src/main-process/bank-bu-recon-writer.js(2), src/main.js(1) |
| `yauzl` | 3 | 6 | 3 | src/backend/acquiring-bill-currency-import/reader.js(2), src/backend/big-table-import/zip-reader.js(2), src/backend/pending-import/xlsx-size-preflight.js(2) |
| `addOneDay` | 3 | 5 | 2 | src/backend/biz-op-recon-import/import-worker.js(2), src/main-process/biz-op-recon-session.js(2), src/main-process/biz-op-recon-run-data.js(1) |
| `ALL_BANKS_TEMPLATE_SCOPE` | 3 | 5 | 2 | src/main-process/monthly-balance.js(3), src/main.js(1), src/renderer.js(1) |
| `bankCreditAmount` | 3 | 5 | 1 | src/main-process/scenario-engines/r5-payment-offline-allocation-backfill.js(3), src/constants/boc-fx-link-fields.js(1), src/main-process/boc-fx-link-builder.js(1) |
| `buildAdmRows` | 3 | 5 | 2 | src/main-process/adm-bank-deposit-builder.js(2), src/main-process/linked-derive-rebuild.js(2), src/main.js(1) |
| `buildTimestamp` | 3 | 5 | 3 | src/main-process/acquiring-bill-currency-writer.js(2), src/main-process/scenario-hit-rows-writer.js(2), src/main-process/bank-statement-io.js(1) |
| `calculateEndingBalanceFromAmounts` | 3 | 5 | 1 | src/backend/file-service.js(2), src/backend/file-service/normalizers.js(2), src/main.js(1) |
| `exportAggregate` | 3 | 5 | 1 | src/backend/pending-export/writer.js(2), src/preload.js(2), src/renderer-pending.js(1) |
| `getEnabledModules` | 3 | 5 | 1 | src/backend/database.js(2), src/backend/database/settings-repository.js(2), src/preload.js(1) |
| `getRule` | 3 | 5 | 1 | src/backend/pending-db/rule-repository.js(2), src/renderer-pending.js(2), src/preload.js(1) |
| `getStatementSessionEntries` | 3 | 5 | 1 | src/main-process/statement-generation.js(2), src/main-process/statement-session.js(2), src/main.js(1) |
| `getUiStyle` | 3 | 5 | 1 | src/backend/database.js(2), src/backend/database/settings-repository.js(2), src/preload.js(1) |
| `importFiles` | 3 | 5 | 2 | src/backend/big-table-import/engine.js(2), src/main-process/acquiring-bill-currency-run-data.js(2), src/backend/big-table-import/engine-worker-entry.js(1) |
| `inferEndingBalance` | 3 | 5 | 1 | src/backend/file-service.js(2), src/backend/file-service/normalizers.js(2), src/main.js(1) |
| `lettersToIndex` | 3 | 5 | 2 | src/backend/biz-op-recon-import/reader-streamed.js(2), src/backend/vcc-op-calc-import/reader.js(2), src/backend/pending-import/streaming-xlsx-reader.js(1) |
| `listReadyDates` | 3 | 5 | 1 | src/backend/biz-op-recon-db/run-repository.js(2), src/main-process/biz-op-recon-run-data.js(2), src/preload.js(1) |
| `mergeMappedDetailRows` | 3 | 5 | 1 | src/main-process/statement-generation.js(2), src/main-process/statement-session.js(2), src/main.js(1) |
| `readBankDepositAdmCandidates` | 3 | 5 | 1 | src/backend/database.js(2), src/backend/database/linked-table-repository.js(2), src/main-process/linked-derive-rebuild.js(1) |
| `readBizOpFile` | 3 | 5 | 1 | src/backend/biz-op-recon-import/reader.js(2), src/main-process/biz-op-recon-session.js(2), src/main.js(1) |
| `readBocFxLinkRowsForRematch` | 3 | 5 | 1 | src/backend/database.js(2), src/backend/database/linked-table-repository.js(2), src/main-process/linked-derive-rebuild.js(1) |
| `readFlowFile` | 3 | 5 | 1 | src/backend/biz-op-recon-import/reader.js(2), src/main-process/biz-op-recon-session.js(2), src/main.js(1) |
| `replaceAdmBankDeposit` | 3 | 5 | 1 | src/backend/database.js(2), src/backend/database/linked-table-repository.js(2), src/main-process/linked-derive-rebuild.js(1) |
| `runAllScenarios` | 3 | 5 | 3 | src/main-process/reconciliation-orchestrator.js(2), src/main-process/scenario-dispatcher.js(2), src/main.js(1) |
| `setEnabledModules` | 3 | 5 | 1 | src/backend/database.js(2), src/backend/database/settings-repository.js(2), src/preload.js(1) |
| `setReconIdFixBillCategory` | 3 | 5 | 1 | src/backend/database.js(2), src/backend/database/settings-repository.js(2), src/preload.js(1) |
| `writeBocFxLinkGroupRematch` | 3 | 5 | 1 | src/backend/database.js(2), src/backend/database/linked-table-repository.js(2), src/main-process/linked-derive-rebuild.js(1) |
| `clearByDate` | 3 | 4 | 1 | src/backend/biz-op-recon-db/flow-imports-repository.js(2), src/backend/biz-op-recon-import/import-worker.js(1), src/main-process/biz-op-recon-session.js(1) |
| `clearRunsAndDiffsByDate` | 3 | 4 | 1 | src/backend/biz-op-recon-db/run-repository.js(2), src/backend/biz-op-recon-import/import-worker.js(1), src/main-process/biz-op-recon-session.js(1) |
| `findByNameAndLocation` | 3 | 4 | 1 | src/backend/database/channels-repository.js(2), src/backend/database.js(1), src/main-process/scenario-dispatcher.js(1) |
| `getBuiltinGeneral` | 3 | 4 | 1 | src/backend/database/channels-repository.js(2), src/backend/database.js(1), src/main-process/scenario-dispatcher.js(1) |
| `importMonthAtomic` | 3 | 4 | 1 | src/backend/bank-bu-recon-db/month-repository.js(2), src/main-process/bank-bu-recon-run-data.js(1), src/main-process/bank-bu-recon-session.js(1) |
| `isEmptyValue` | 3 | 4 | 1 | src/main-process/scenario-engines/engine-utils.js(2), src/main-process/scenario-engines/c1-extract-recon-id.js(1), src/main-process/scenario-engines/c3-gateway-recon-join.js(1) |
| `listByMonth` | 3 | 4 | 1 | src/backend/pending-db/removed-repository.js(2), src/backend/pending-export/writer.js(1), src/backend/pending-reconcile/removal-match.js(1) |
| `listSuccessDates` | 3 | 4 | 1 | src/backend/biz-op-recon-db/run-repository.js(2), src/main-process/biz-op-recon-run-data.js(1), src/preload.js(1) |
| `listSuccessDatesInRange` | 3 | 4 | 1 | src/backend/biz-op-recon-db/run-repository.js(2), src/main-process/biz-op-recon-run-data.js(1), src/main-process/biz-op-recon-writer.js(1) |
| `openWorkbook` | 3 | 4 | 1 | src/backend/big-table-import/zip-reader.js(2), src/backend/big-table-import/engine.js(1), src/backend/big-table-import/import-worker.js(1) |
| `runBizOpImportViaWorker` | 3 | 4 | 1 | src/main-process/biz-op-recon-run-data.js(2), src/main-process/biz-op-recon-session.js(1), src/main.js(1) |
| `runFlowImportViaWorker` | 3 | 4 | 1 | src/main-process/biz-op-recon-run-data.js(2), src/main-process/biz-op-recon-session.js(1), src/main.js(1) |
| `sanitizeBankName` | 3 | 4 | 3 | src/backend/database/own-accounts-migration.js(2), src/backend/balance-adjustment-store.js(1), src/backend/own-account-store.js(1) |
| `scanSheetRows` | 3 | 4 | 1 | src/backend/big-table-import/row-scanner.js(2), src/backend/big-table-import/engine.js(1), src/backend/big-table-import/import-worker.js(1) |
| `buildTimestampMinute` | 3 | 3 | 2 | src/main-process/bank-statement-io.js(1), src/main-process/recon-id-fix-io.js(1), src/main.js(1) |
| `createHash` | 3 | 3 | 1 | src/backend/pending-import/validator.js(1), src/backend/pending-reconcile/engine.js(1), src/main.js(1) |
| `MODULES` | 2 | 75 | 1 | src/renderer-previews.js(53), src/renderer.js(22) |
| `activeJob` | 2 | 47 | 1 | src/main-process/run-check-worker-pool.js(37), src/main-process/run-check-worker.js(10) |
| `normalizeKey` | 2 | 34 | 2 | src/backend/database/linked-table-repository.js(29), src/main-process/bank-bu-recon-session.js(5) |
| `settingsRepository` | 2 | 33 | 2 | src/backend/database.js(29), src/backend/database/own-accounts-migration.js(4) |
| `templateRepository` | 2 | 33 | 2 | src/backend/database.js(30), src/backend/database/own-accounts-migration.js(3) |
| `ContractValidationError` | 2 | 25 | 2 | src/backend/big-table-import/contract.js(22), src/backend/big-table-import/engine.js(3) |
| `database` | 2 | 24 | 1 | src/main-process/linked-derive-rebuild.js(17), src/main.js(7) |
| `TEMPLATE_LABEL` | 2 | 19 | 2 | src/backend/vcc-op-calc-import/reader.js(11), src/backend/pending-import/removed-reader.js(8) |
| `refreshBankStatementStatus` | 2 | 18 | 1 | src/renderer-dialogs.js(9), src/renderer.js(9) |
| `PipelineError` | 2 | 17 | 2 | src/backend/big-table-import/pipeline.js(9), src/backend/big-table-import/engine.js(8) |
| `TABLE` | 2 | 17 | 2 | src/backend/biz-op-recon-db/imports-repository.js(10), src/backend/biz-op-recon-db/flow-imports-repository.js(7) |
| `DIFF_TABLE` | 2 | 16 | 2 | src/backend/acquiring-bill-currency-db/run-repository.js(11), src/backend/biz-op-recon-db/run-repository.js(5) |
| `ImportValidationError` | 2 | 16 | 1 | src/backend/acquiring-bill-currency-import/reader.js(15), src/backend/acquiring-bill-currency-import/reader-handrolled.js(1) |
| `REMOVED_PENDING_COLUMNS` | 2 | 16 | 2 | src/backend/pending-import/removed-reader.js(13), src/backend/pending-export/writer.js(3) |
| `reloadReconIdFixScenarios` | 2 | 15 | 1 | src/renderer-dialogs.js(11), src/renderer.js(4) |
| `safeRollback` | 2 | 15 | 2 | src/main-process/acquiring-bill-currency-session.js(10), src/backend/big-table-import/engine.js(5) |
| `monthRepository` | 2 | 14 | 2 | src/main-process/bank-bu-recon-run-data.js(7), src/main-process/bank-bu-recon-session.js(7) |
| `sanitizeAmountValue` | 2 | 14 | 1 | src/backend/file-service.js(11), src/backend/file-service/normalizers.js(3) |
| `toCents` | 2 | 14 | 2 | src/main-process/scenario-engines/c4-recon-id-fix.js(8), src/main-process/boc-fx-link-builder.js(6) |
| `BigTableImportError` | 2 | 13 | 1 | src/backend/big-table-import/engine.js(7), src/backend/big-table-import/zip-reader.js(6) |
| `ERROR_CODE` | 2 | 13 | 2 | src/backend/vcc-op-calc-import/reader.js(7), src/backend/pending-import/removed-reader.js(6) |
| `normalizeAccountKey` | 2 | 13 | 2 | src/main-process/biz-op-recon-session.js(10), src/main-process/biz-op-recon-writer.js(3) |
| `refreshTemplates` | 2 | 13 | 1 | src/renderer.js(7), src/renderer-dialogs.js(6) |
| `zipReader` | 2 | 13 | 2 | src/backend/big-table-import/engine.js(10), src/backend/big-table-import/import-worker.js(3) |
| `getCurrencyOptionEntries` | 2 | 12 | 1 | src/renderer.js(7), src/renderer-dialogs.js(5) |
| `parseAmount` | 2 | 12 | 2 | src/backend/biz-op-recon-import/validator.js(8), src/main-process/biz-op-recon-session.js(4) |
| `removalMatch` | 2 | 12 | 1 | src/renderer-pending.js(8), src/backend/pending-export/writer.js(4) |
| `BIZ_OP_ACCOUNT_KEY_DB_COLUMN` | 2 | 11 | 1 | src/main-process/biz-op-recon-session.js(9), src/backend/biz-op-recon-db/columns.js(2) |
| `rendererPending` | 2 | 11 | 1 | src/renderer-previews.js(9), src/renderer.js(2) |
| `electronUtilityProcess` | 2 | 10 | 2 | src/main-process/pending-session.js(6), src/main-process/biz-op-recon-session.js(4) |
| `getTemplate` | 2 | 10 | 1 | src/backend/database/template-repository.js(8), src/backend/database.js(2) |
| `NODE_MAX_OLD_SPACE_MB` | 2 | 10 | 2 | src/main-process/pending-session.js(6), src/main-process/biz-op-recon-session.js(4) |
| `workerDbPath` | 2 | 10 | 1 | src/main-process/run-check-worker-pool.js(7), src/main-process/run-check-worker.js(3) |
| `channelsRepository` | 2 | 9 | 2 | src/backend/database.js(8), src/main.js(1) |
| `hasEffectiveAmount` | 2 | 9 | 1 | src/backend/file-service.js(7), src/backend/file-service/normalizers.js(2) |
| `SHEET_ENTRY_NAME` | 2 | 9 | 1 | src/backend/acquiring-bill-currency-import/reader.js(6), src/backend/acquiring-bill-currency-import/reader-handrolled.js(3) |
| `ACQUIRING_BILL_CHUNK_SIZE_DEFAULT` | 2 | 8 | 2 | src/backend/database/settings-repository.js(5), src/backend/database/migrations.js(3) |
| `ACQUIRING_BILL_CHUNK_SIZE_KEY` | 2 | 8 | 2 | src/backend/database/migrations.js(4), src/backend/database/settings-repository.js(4) |
| `ACQUIRING_BILL_IDLE_CLEANUP_MINUTES_DEFAULT` | 2 | 8 | 2 | src/backend/database/settings-repository.js(5), src/backend/database/migrations.js(3) |
| `ACQUIRING_BILL_IDLE_CLEANUP_MINUTES_KEY` | 2 | 8 | 2 | src/backend/database/migrations.js(4), src/backend/database/settings-repository.js(4) |
| `ACQUIRING_BILL_RAW_JSON_RETENTION_DAYS_DEFAULT` | 2 | 8 | 2 | src/backend/database/settings-repository.js(5), src/backend/database/migrations.js(3) |
| `ACQUIRING_BILL_RAW_JSON_RETENTION_DAYS_KEY` | 2 | 8 | 2 | src/backend/database/migrations.js(4), src/backend/database/settings-repository.js(4) |
| `getLinkedTableMeta` | 2 | 8 | 1 | src/backend/database/linked-table-repository.js(6), src/backend/database.js(2) |
| `monthRepo` | 2 | 8 | 2 | src/backend/pending-import/worker.js(4), src/main-process/pending-session.js(4) |
| `pkg` | 2 | 8 | 2 | src/main-process/acquiring-bill-currency-writer.js(7), src/main.js(1) |
| `recordRowError` | 2 | 8 | 1 | src/backend/big-table-import/engine.js(4), src/backend/biz-op-recon-import/import-worker.js(4) |
| `setNewAccountStatus` | 2 | 8 | 1 | src/renderer.js(6), src/renderer-previews.js(2) |
| `setRunChunkProgress` | 2 | 8 | 1 | src/main-process/acquiring-bill-currency-session.js(6), src/backend/acquiring-bill-currency-db/run-repository.js(2) |
| `sheetToObjects` | 2 | 8 | 2 | src/main-process/recon-id-fix-io.js(5), src/main-process/bank-statement-io.js(3) |
| `toIsoDate` | 2 | 8 | 2 | src/main-process/boc-fx-link-builder.js(4), src/main-process/scenario-engines/jpm-dispatch-order-fix.js(4) |
| `wrapReadError` | 2 | 8 | 2 | src/backend/biz-op-recon-import/reader-streamed.js(4), src/backend/vcc-op-calc-import/reader.js(4) |
| `ACQUIRING_BILL_WORKER_COUNT_DEFAULT` | 2 | 7 | 2 | src/backend/database/settings-repository.js(5), src/backend/database/migrations.js(2) |
| `ACQUIRING_BILL_WORKER_COUNT_KEY` | 2 | 7 | 2 | src/backend/database/settings-repository.js(4), src/backend/database/migrations.js(3) |
| `applyManualBalancePromptStatus` | 2 | 7 | 1 | src/renderer.js(4), src/renderer-dialogs.js(3) |
| `bankStatementSession` | 2 | 7 | 1 | src/renderer.js(6), src/main.js(1) |
| `createBackup` | 2 | 7 | 1 | src/backend/database.js(6), src/backend/database/backup.js(1) |
| `FLOW_COLUMN_DEFS` | 2 | 7 | 1 | src/backend/biz-op-recon-db/columns.js(5), src/backend/vcc-op-calc-db/columns.js(2) |
| `flowImportsRepository` | 2 | 7 | 2 | src/main-process/biz-op-recon-session.js(4), src/backend/biz-op-recon-import/import-worker.js(3) |
| `getNewAccountStatusTitle` | 2 | 7 | 1 | src/renderer.js(5), src/renderer-previews.js(2) |
| `processingResult` | 2 | 7 | 1 | src/renderer.js(6), src/main.js(1) |
| `roundAmount` | 2 | 7 | 1 | src/backend/file-service/normalizers.js(5), src/backend/file-service.js(2) |
| `setNewAccountExportAvailability` | 2 | 7 | 1 | src/renderer.js(5), src/renderer-previews.js(2) |
| `syncNewAccountCurrencyMode` | 2 | 7 | 1 | src/renderer.js(5), src/renderer-previews.js(2) |
| `VALID_CATEGORIES` | 2 | 7 | 2 | src/backend/database/scenarios-repository.js(4), src/main-process/recon-id-fix-engine.js(3) |
| `__missingBankColumns` | 2 | 6 | 2 | src/constants/payment-offline-allocation-fields.js(3), src/constants/refund-backfill-fields.js(3) |
| `amountEqual` | 2 | 6 | 2 | src/main-process/scenario-engines/r5-fund-transfer-backfill.js(3), src/main-process/scenario-engines/r5-payment-offline-allocation-backfill.js(3) |
| `BANK_DEPOSIT_FIELDS` | 2 | 6 | 2 | src/backend/database/linked-table-repository.js(4), src/constants/boc-fx-link-fields.js(2) |
| `BANK_DIFF_FIELD_DB_COLUMN` | 2 | 6 | 1 | src/main-process/bank-bu-recon-session.js(4), src/backend/bank-bu-recon-db/columns.js(2) |
| `BANK_RECON_ID_FIELD` | 2 | 6 | 2 | src/main-process/scenario-engines/r1-recon-id-match.js(3), src/main-process/scenario-engines/r4-fund-nature-check.js(3) |
| `bankAmountAbs` | 2 | 6 | 2 | src/main-process/scenario-engines/r5-fund-transfer-backfill.js(3), src/main-process/scenario-engines/r5-refund-order-backfill.js(3) |
| `bizOpRowToArray` | 2 | 6 | 1 | src/main-process/biz-op-recon-writer.js(4), src/backend/biz-op-recon-db/columns.js(2) |
| `BOC_BANK_FILTER` | 2 | 6 | 2 | src/main-process/boc-fx-link-builder.js(4), src/constants/boc-fx-link-fields.js(2) |
| `buildFeatureRegex` | 2 | 6 | 2 | src/main-process/scenario-engines/c1-extract-recon-id.js(3), src/main-process/scenario-engines/r5-refund-order-backfill.js(3) |
| `buildFileReader` | 2 | 6 | 2 | src/backend/bank-bu-recon-import/reader.js(3), src/backend/biz-op-recon-import/reader.js(3) |
| `buildRowMapper` | 2 | 6 | 2 | src/backend/bank-bu-recon-import/reader.js(3), src/backend/biz-op-recon-import/reader.js(3) |
| `buildTemplateSummaryFromRow` | 2 | 6 | 1 | src/backend/database/template-repository.js(4), src/backend/database/utils.js(2) |
| `CLEANUP_TEMPLATE_HEADERS` | 2 | 6 | 2 | src/constants/platform-cleanup-template-fields.js(3), src/main-process/platform-cleanup-writer.js(3) |
| `dayDiffAbs` | 2 | 6 | 1 | src/main-process/scenario-engines/r5-fund-transfer-backfill.js(3), src/main-process/scenario-engines/r5-payment-offline-allocation-backfill.js(3) |
| `ensureAccountMappingCurrencySupport` | 2 | 6 | 1 | src/backend/database.js(4), src/backend/database/migrations.js(2) |
| `ensureAccountMappingTemplateSupport` | 2 | 6 | 1 | src/backend/database.js(4), src/backend/database/migrations.js(2) |
| `ensureAcquiringBillChunkSizeSetting` | 2 | 6 | 1 | src/backend/database.js(4), src/backend/database/migrations.js(2) |
| `ensureAcquiringBillCurrencyIndexSlimV2` | 2 | 6 | 1 | src/backend/database.js(4), src/backend/database/migrations.js(2) |
| `ensureAcquiringBillCurrencyRawJsonRetentionSettings` | 2 | 6 | 1 | src/backend/database.js(4), src/backend/database/migrations.js(2) |
| `ensureAcquiringBillCurrencyRunsChunkProgress` | 2 | 6 | 1 | src/backend/database.js(4), src/backend/database/migrations.js(2) |
| `ensureAcquiringBillCurrencyRunsCleanupPending` | 2 | 6 | 1 | src/backend/database.js(4), src/backend/database/migrations.js(2) |
| `ensureAcquiringBillCurrencyRunsSideDbPath` | 2 | 6 | 1 | src/backend/database.js(4), src/backend/database/migrations.js(2) |
| `ensureAcquiringBillCurrencyTablesSupport` | 2 | 6 | 1 | src/backend/database.js(4), src/backend/database/migrations.js(2) |
| `ensureAcquiringBillIdleCleanupMinutesSetting` | 2 | 6 | 1 | src/backend/database.js(4), src/backend/database/migrations.js(2) |
| `ensureAcquiringBillWorkerCountSetting` | 2 | 6 | 1 | src/backend/database.js(4), src/backend/database/migrations.js(2) |
| `ensureAdmBankDepositSupport` | 2 | 6 | 1 | src/backend/database.js(4), src/backend/database/migrations.js(2) |
| `ensureAmountSplitRulesSupport` | 2 | 6 | 1 | src/backend/database.js(4), src/backend/database/migrations.js(2) |
| `ensureBankBuReconRunsSideDbPath` | 2 | 6 | 1 | src/backend/database.js(4), src/backend/database/migrations.js(2) |
| `ensureBankBuReconTablesSupport` | 2 | 6 | 1 | src/backend/database.js(4), src/backend/database/migrations.js(2) |
| `ensureBillRawJsonV2Slim` | 2 | 6 | 1 | src/backend/database.js(4), src/backend/database/migrations.js(2) |
| `ensureBillSplitMergeSupport` | 2 | 6 | 1 | src/backend/database.js(4), src/backend/database/migrations.js(2) |
| `ensureBillSplitTargetSeqSupport` | 2 | 6 | 1 | src/backend/database.js(4), src/backend/database/migrations.js(2) |
| `ensureBizOpReconRunsSideDbPath` | 2 | 6 | 1 | src/backend/database.js(4), src/backend/database/migrations.js(2) |
| `ensureBocDispatchOrderScenarioSeed` | 2 | 6 | 1 | src/backend/database.js(4), src/backend/database/migrations.js(2) |
| `ensureBocFxLinkSupport` | 2 | 6 | 1 | src/backend/database.js(4), src/backend/database/migrations.js(2) |
| `ensureBuiltinFixedScenarioMigration` | 2 | 6 | 1 | src/backend/database.js(4), src/backend/database/migrations.js(2) |
| `ensureBuiltinFixedScenarioNameUpdate` | 2 | 6 | 1 | src/backend/database.js(4), src/backend/database/migrations.js(2) |
| `ensureBuiltinScenarioNamesUpdate` | 2 | 6 | 1 | src/backend/database.js(4), src/backend/database/migrations.js(2) |
| `ensureC3AssignAddMode` | 2 | 6 | 1 | src/backend/database.js(4), src/backend/database/migrations.js(2) |
| `ensureC3GwFieldCurrencyCaseFix` | 2 | 6 | 1 | src/backend/database.js(4), src/backend/database/migrations.js(2) |
| `ensureChannelEnumSupport` | 2 | 6 | 1 | src/backend/database.js(4), src/backend/database/migrations.js(2) |
| `ensureDiffRowsCascadeMigration_v2_1_10` | 2 | 6 | 1 | src/backend/database.js(4), src/backend/database/migrations.js(2) |
| `ensureFundTypeAchReturnConfigMigration` | 2 | 6 | 1 | src/backend/database.js(4), src/backend/database/migrations.js(2) |
| `ensureJpmDispatchOrderScenarioSeed` | 2 | 6 | 1 | src/backend/database.js(4), src/backend/database/migrations.js(2) |
| `ensureLinkedTableSupport` | 2 | 6 | 1 | src/backend/database.js(4), src/backend/database/migrations.js(2) |
| `ensureParentTemplateSupport` | 2 | 6 | 1 | src/backend/database.js(4), src/backend/database/migrations.js(2) |
| `ensureReconRoundBuiltinScenariosSeed` | 2 | 6 | 1 | src/backend/database.js(4), src/backend/database/migrations.js(2) |
| `ensureRefundBackfillScenarioSeed` | 2 | 6 | 1 | src/backend/database.js(4), src/backend/database/migrations.js(2) |
| `ensureScenarioApplicableChannelsTable` | 2 | 6 | 1 | src/backend/database.js(4), src/backend/database/migrations.js(2) |
| `ensureScenariosCategoryBuiltinFixed` | 2 | 6 | 1 | src/backend/database.js(4), src/backend/database/migrations.js(2) |
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
| `ensureVccOpCalcTablesSupport` | 2 | 6 | 1 | src/backend/database.js(4), src/backend/database/migrations.js(2) |
| `FILENAME_MAPPING_TEMPLATE_ID` | 2 | 6 | 2 | src/renderer.js(4), src/main.js(2) |
| `FX_DELIVERY_SIGNATURE` | 2 | 6 | 2 | src/constants/boc-fx-link-fields.js(3), src/constants/table-signatures.js(3) |
| `getCurrencyOptionLabel` | 2 | 6 | 1 | src/renderer.js(5), src/renderer-dialogs.js(1) |
| `GW_RECON_ID_FIELD` | 2 | 6 | 2 | src/main-process/scenario-engines/r1-recon-id-match.js(3), src/main-process/scenario-engines/r4-fund-nature-check.js(3) |
| `initWorkerDb` | 2 | 6 | 2 | src/main-process/run-check-multiworker-worker.js(3), src/main-process/run-check-worker.js(3) |
| `INSERT_SQL` | 2 | 6 | 2 | src/backend/biz-op-recon-db/flow-imports-repository.js(3), src/backend/biz-op-recon-db/imports-repository.js(3) |
| `listImportedDateBuPairs` | 2 | 6 | 1 | src/main-process/biz-op-recon-run-data.js(4), src/backend/biz-op-recon-db/imports-repository.js(2) |
| `matchAmountSplitConditionValue` | 2 | 6 | 1 | src/backend/file-service.js(4), src/backend/file-service/normalizers.js(2) |
| `migrateC4ReconGroupsAmountLockedFieldPair` | 2 | 6 | 1 | src/backend/database.js(4), src/backend/database/migrations.js(2) |
| `migrateC4ReconGroupsStructure` | 2 | 6 | 1 | src/backend/database.js(4), src/backend/database/migrations.js(2) |
| `migrateGatewayReconIdFixFieldPairs` | 2 | 6 | 1 | src/backend/database.js(4), src/backend/database/migrations.js(2) |
| `normalizeWorksheetTarget` | 2 | 6 | 2 | src/backend/big-table-import/zip-reader.js(3), src/backend/biz-op-recon-import/reader-streamed.js(3) |
| `PART_TABLE` | 2 | 6 | 2 | src/main-process/run-check-multiworker-worker.js(4), src/main-process/run-check-multiworker.js(2) |
| `PENDING_DIFF_FIELD_DB_COLUMN` | 2 | 6 | 1 | src/main-process/bank-bu-recon-session.js(4), src/backend/bank-bu-recon-db/columns.js(2) |
| `reconIdFixSession` | 2 | 6 | 1 | src/renderer.js(5), src/main.js(1) |
| `removedRepo` | 2 | 6 | 2 | src/backend/pending-export/writer.js(4), src/backend/pending-reconcile/removal-match.js(2) |
| `runC1Scenario` | 2 | 6 | 2 | src/main-process/scenario-engines/index.js(4), src/main-process/scenario-engines/c1-extract-recon-id.js(2) |
| `sanitizeSheetName` | 2 | 6 | 2 | src/backend/pending-export/writer.js(3), src/main-process/acquiring-bill-currency-writer.js(3) |
| `splitSignedAmountValue` | 2 | 6 | 1 | src/backend/file-service.js(4), src/backend/file-service/normalizers.js(2) |
| `SUPPORTED_SCENARIO_BUNDLE_VERSION` | 2 | 6 | 1 | src/backend/scenarios-bundle-io.js(5), src/main.js(1) |
| `validateName` | 2 | 6 | 2 | src/backend/database/channels-repository.js(3), src/backend/database/scenarios-repository.js(3) |
| `VCC_BILL_DATE_DB_COLUMN` | 2 | 6 | 1 | src/main-process/vcc-op-calc-session.js(4), src/backend/vcc-op-calc-db/columns.js(2) |
| `VCC_DIRECTION_DB_COLUMN` | 2 | 6 | 1 | src/main-process/vcc-op-calc-session.js(4), src/backend/vcc-op-calc-db/columns.js(2) |
| `WORKER_SCRIPT` | 2 | 6 | 2 | src/main-process/biz-op-recon-session.js(3), src/main-process/pending-session.js(3) |
| `workerScriptOverride` | 2 | 6 | 2 | src/main-process/run-check-multiworker.js(3), src/main-process/run-check-worker-pool.js(3) |
| `WRITER_OUTPUT_HEADERS_V2` | 2 | 6 | 1 | src/main-process/acquiring-bill-currency-writer.js(4), src/backend/acquiring-bill-currency-db/columns.js(2) |
| `BILL_INSERT_SQL` | 2 | 5 | 2 | src/backend/acquiring-bill-currency-import/contract-bill.js(3), src/backend/acquiring-bill-currency-db/import-repository.js(2) |
| `BIZ_OP_END_BALANCE_DB_COLUMN` | 2 | 5 | 1 | src/main-process/biz-op-recon-session.js(3), src/backend/biz-op-recon-db/columns.js(2) |
| `BOC_PAYMENT_DETAIL_KEYWORD` | 2 | 5 | 2 | src/main-process/boc-fx-link-builder.js(3), src/constants/boc-fx-link-fields.js(2) |
| `buildInfo` | 2 | 5 | 2 | src/main-process/acquiring-bill-currency-writer.js(3), src/main.js(2) |
| `deserializeFromMessage` | 2 | 5 | 2 | src/main-process/run-check-worker-pool.js(3), src/main-process/run-check-multiworker.js(2) |
| `DIFF_HEADER_TAIL` | 2 | 5 | 1 | src/main-process/biz-op-recon-writer.js(3), src/backend/biz-op-recon-db/columns.js(2) |
| `DIFF_OUTPUT_BANK_SHEET` | 2 | 5 | 1 | src/main-process/bank-bu-recon-writer.js(3), src/backend/bank-bu-recon-db/columns.js(2) |
| `DIFF_OUTPUT_PENDING_SHEET` | 2 | 5 | 1 | src/main-process/bank-bu-recon-writer.js(3), src/backend/bank-bu-recon-db/columns.js(2) |
| `ENGINE_WORKER_ENTRY` | 2 | 5 | 2 | src/main-process/big-table-import-dispatch.js(3), src/main-process/acquiring-bill-currency-session.js(2) |
| `ensureSupportedFile` | 2 | 5 | 1 | src/backend/file-service/readers.js(3), src/backend/file-service.js(2) |
| `ERROR_HEADER_TAIL` | 2 | 5 | 1 | src/main-process/biz-op-recon-writer.js(3), src/backend/biz-op-recon-db/columns.js(2) |
| `gatewayReconSession` | 2 | 5 | 1 | src/renderer.js(4), src/main.js(1) |
| `getBillSplitAmountRules` | 2 | 5 | 1 | src/backend/database/template-repository.js(3), src/backend/database.js(2) |
| `getBillSplitMappings` | 2 | 5 | 1 | src/backend/database/template-repository.js(3), src/backend/database.js(2) |
| `getBillSplitMeta` | 2 | 5 | 1 | src/backend/database/template-repository.js(3), src/backend/database.js(2) |
| `getBillSplitRows` | 2 | 5 | 1 | src/backend/database/template-repository.js(3), src/backend/database.js(2) |
| `getScenario` | 2 | 5 | 1 | src/backend/database/scenarios-repository.js(3), src/backend/database.js(2) |
| `getStatusDualSource` | 2 | 5 | 2 | src/main-process/biz-op-recon-run-data.js(3), src/main-process/bank-bu-recon-run-data.js(2) |
| `getTemplateMappings` | 2 | 5 | 1 | src/backend/database/template-repository.js(3), src/backend/database.js(2) |
| `groupBy` | 2 | 5 | 2 | src/main-process/scenario-engines/r5-refund-order-backfill.js(3), src/main-process/scenario-engines/jpm-dispatch-order-fix.js(2) |
| `listImportedDates` | 2 | 5 | 1 | src/main-process/biz-op-recon-run-data.js(3), src/backend/biz-op-recon-db/flow-imports-repository.js(2) |
| `listMonthsDualSource` | 2 | 5 | 2 | src/main-process/bank-bu-recon-run-data.js(3), src/main-process/acquiring-bill-currency-run-data.js(2) |
| `MODULE_ACQUIRING` | 2 | 5 | 1 | src/backend/run-data-store.js(4), src/main-process/acquiring-bill-currency-run-data.js(1) |
| `MODULE_BANK_BU` | 2 | 5 | 1 | src/backend/run-data-store.js(4), src/main-process/bank-bu-recon-run-data.js(1) |
| `MODULE_BIZ_OP` | 2 | 5 | 1 | src/backend/run-data-store.js(4), src/main-process/biz-op-recon-run-data.js(1) |
| `parseAmountAbs` | 2 | 5 | 2 | src/backend/acquiring-bill-currency-db/import-repository.js(3), src/backend/acquiring-bill-currency-import/contract-flow.js(2) |
| `peekImportTarget` | 2 | 5 | 2 | src/main-process/acquiring-bill-currency-run-data.js(3), src/main-process/acquiring-bill-currency-session.js(2) |
| `PENDING_INSERT_SQL` | 2 | 5 | 2 | src/backend/pending-import/contract-pending.js(3), src/backend/bank-bu-recon-db/month-repository.js(2) |
| `performance` | 2 | 5 | 1 | src/renderer.js(3), src/main.js(2) |
| `REFUND_TEMPLATE_HEADERS` | 2 | 5 | 1 | src/main-process/refund-backfill-writer.js(3), src/constants/refund-backfill-fields.js(2) |
| `runC2Scenario` | 2 | 5 | 2 | src/main-process/scenario-engines/index.js(3), src/main-process/scenario-engines/c2-offset-bill-mark.js(2) |
| `runC3Scenario` | 2 | 5 | 2 | src/main-process/scenario-engines/index.js(3), src/main-process/scenario-engines/c3-gateway-recon-join.js(2) |
| `runScenario` | 2 | 5 | 2 | src/main-process/scenario-dispatcher.js(3), src/main-process/scenario-engines/index.js(2) |
| `sax` | 2 | 5 | 2 | src/backend/acquiring-bill-currency-import/reader.js(3), src/backend/big-table-import/zip-reader.js(2) |
| `scan` | 2 | 5 | 1 | src/main-process/vcc-op-calc-session.js(4), src/preload.js(1) |
| `setExportAvailability` | 2 | 5 | 1 | src/renderer.js(4), src/renderer-previews.js(1) |
| `setNewAccountOpenDateValue` | 2 | 5 | 1 | src/renderer.js(3), src/renderer-previews.js(2) |
| `statementImportSessions` | 2 | 5 | 1 | src/main-process/statement-session.js(4), src/main.js(1) |
| `streamBizOpFile` | 2 | 5 | 2 | src/backend/biz-op-recon-import/reader-streamed.js(3), src/backend/biz-op-recon-import/import-worker.js(2) |
| `subOneDay` | 2 | 5 | 2 | src/backend/biz-op-recon-db/run-repository.js(3), src/main-process/biz-op-recon-session.js(2) |
| `TEMPLATE_BILL_KEY_INDICES` | 2 | 5 | 2 | src/backend/acquiring-bill-currency-import/contract-bill.js(3), src/backend/acquiring-bill-currency-db/import-repository.js(2) |
| `trimTrailingEmptyCells` | 2 | 5 | 1 | src/backend/file-service/readers.js(3), src/backend/file-service/common.js(2) |
| `updateNewAccountGenerateAvailability` | 2 | 5 | 1 | src/renderer.js(3), src/renderer-previews.js(2) |
| `VCC_CURRENCY_DB_COLUMN` | 2 | 5 | 1 | src/main-process/vcc-op-calc-session.js(3), src/backend/vcc-op-calc-db/columns.js(2) |
| `VCC_RECON_AMOUNT_DB_COLUMN` | 2 | 5 | 1 | src/main-process/vcc-op-calc-session.js(3), src/backend/vcc-op-calc-db/columns.js(2) |
| `weekTagToNumber` | 2 | 5 | 2 | src/main-process/scenario-engines/r5-payment-offline-allocation-backfill.js(3), src/main-process/scenario-engines/engine-week-utils.js(2) |
| `ZHONGTAI_DISPATCH_ORDER_SIGNATURE` | 2 | 5 | 2 | src/constants/table-signatures.js(3), src/main-process/exceljs-writer.js(2) |
| `ADM_EXTRA_FIELDS` | 2 | 4 | 1 | src/constants/adm-bank-deposit-fields.js(2), src/main-process/adm-bank-deposit-builder.js(2) |
| `ADM_FUND_TYPES` | 2 | 4 | 1 | src/constants/adm-bank-deposit-fields.js(2), src/main-process/adm-bank-deposit-builder.js(2) |
| `ADM_MERCHANT_ID` | 2 | 4 | 2 | src/backend/database/migrations.js(2), src/constants/adm-bank-deposit-fields.js(2) |
| `ALL_TABLE_SIGNATURES` | 2 | 4 | 2 | src/constants/table-signatures.js(2), src/main-process/table-type-detector.js(2) |
| `applyApplicableChannelIdsInTx` | 2 | 4 | 1 | src/backend/database/scenarios-repository.js(3), src/backend/database.js(1) |
| `BANK_MATCH_KEY_DB_COLUMN` | 2 | 4 | 1 | src/backend/bank-bu-recon-db/columns.js(2), src/main-process/bank-bu-recon-session.js(2) |
| `BankStatementMergeError` | 2 | 4 | 1 | src/main-process/bank-statement-merge.js(3), src/main.js(1) |
| `BOC_CHANNEL_NAME` | 2 | 4 | 2 | src/constants/boc-dispatch-order-fields.js(2), src/main-process/scenario-engines/boc-dispatch-order-fix.js(2) |
| `BOC_CHANNEL_VALUE` | 2 | 4 | 2 | src/constants/boc-fx-link-fields.js(2), src/main-process/boc-fx-link-builder.js(2) |
| `buildMappedRows` | 2 | 4 | 1 | src/backend/file-service.js(3), src/main.js(1) |
| `BUSINESS_BILL_SHEET_NAME` | 2 | 4 | 1 | src/constants/recon-id-fix-fields.js(2), src/main-process/recon-id-fix-io.js(2) |
| `C4_CATEGORIES` | 2 | 4 | 2 | src/main-process/scenario-dispatcher.js(3), src/main.js(1) |
| `CHANNEL_BILL_SHEET_NAME` | 2 | 4 | 1 | src/constants/gateway-bill-recon-fields.js(2), src/main-process/recon-id-fix-io.js(2) |
| `CLEANUP_COPY_HEADERS` | 2 | 4 | 2 | src/constants/platform-cleanup-template-fields.js(2), src/main-process/scenario-engines/r5-platform-inbound-cleanup.js(2) |
| `clearBankDepositHitMarkersByBizIds` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/linked-table-repository.js(2) |
| `clearDiffRowsByRunId` | 2 | 4 | 1 | src/backend/acquiring-bill-currency-db/run-repository.js(3), src/main-process/acquiring-bill-currency-session.js(1) |
| `closeAllNewAccountCurrencyDropdowns` | 2 | 4 | 1 | src/renderer.js(3), src/renderer-previews.js(1) |
| `computeAmounts` | 2 | 4 | 1 | src/main-process/vcc-op-calc-session.js(3), src/preload.js(1) |
| `countBankDepositByDateRange` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/linked-table-repository.js(2) |
| `countByMonth` | 2 | 4 | 1 | src/backend/pending-db/removed-repository.js(2), src/backend/pending-export/writer.js(2) |
| `countFxByDateRange` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/linked-table-repository.js(2) |
| `countGatewayBillByDateRange` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/linked-table-repository.js(2) |
| `createBankBuReconSession` | 2 | 4 | 2 | src/main-process/bank-bu-recon-session.js(2), src/main.js(2) |
| `createCancelToken` | 2 | 4 | 1 | src/main-process/acquiring-bill-currency-session.js(2), src/main-process/run-check-worker.js(2) |
| `createPendingSession` | 2 | 4 | 2 | src/main-process/pending-session.js(2), src/main.js(2) |
| `createVccOpCalcSession` | 2 | 4 | 2 | src/main-process/vcc-op-calc-session.js(2), src/main.js(2) |
| `crypto` | 2 | 4 | 2 | src/backend/pending-import/validator.js(2), src/backend/pending-reconcile/engine.js(2) |
| `deleteBankDepositByDateRange` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/linked-table-repository.js(2) |
| `deleteChannel` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/channels-repository.js(2) |
| `deleteFxByDateRange` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/linked-table-repository.js(2) |
| `deleteGatewayBillByDateRange` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/linked-table-repository.js(2) |
| `deleteScenario` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/scenarios-repository.js(2) |
| `ensureUiStyleDefault` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/settings-repository.js(2) |
| `extractChannelRegionCombos` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/channel-enum-repository.js(2) |
| `findHeaderMatchPosition` | 2 | 4 | 2 | src/backend/file-service/readers.js(2), src/main-process/table-type-detector.js(2) |
| `FLOW_ACCOUNT_KEY_DB_COLUMN` | 2 | 4 | 1 | src/backend/biz-op-recon-db/columns.js(2), src/main-process/biz-op-recon-session.js(2) |
| `FLOW_BU_FIELD_DB_COLUMN` | 2 | 4 | 1 | src/backend/biz-op-recon-db/columns.js(2), src/main-process/biz-op-recon-session.js(2) |
| `FLOW_DIRECTION_DB_COLUMN` | 2 | 4 | 1 | src/backend/biz-op-recon-db/columns.js(2), src/main-process/biz-op-recon-session.js(2) |
| `FLOW_RECON_AMOUNT_DB_COLUMN` | 2 | 4 | 1 | src/backend/biz-op-recon-db/columns.js(2), src/main-process/biz-op-recon-session.js(2) |
| `flowHeaderToDbColumn` | 2 | 4 | 1 | src/backend/biz-op-recon-db/columns.js(2), src/backend/vcc-op-calc-db/columns.js(2) |
| `FUND_TYPE_ENUM_FILE_NAME` | 2 | 4 | 2 | src/constants/fund-type-enum.js(3), src/main.js(1) |
| `GATEWAY_BILL_SHEET_NAME` | 2 | 4 | 1 | src/constants/gateway-bill-recon-fields.js(2), src/main-process/recon-id-fix-io.js(2) |
| `GATEWAY_RECON_HEADERS_FILE_NAME` | 2 | 4 | 2 | src/constants/gateway-recon-headers-loader.js(3), src/main.js(1) |
| `getAcquiringBillChunkSize` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/settings-repository.js(2) |
| `getAcquiringBillIdleCleanupMinutes` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/settings-repository.js(2) |
| `getAcquiringBillRawJsonRetentionDays` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/settings-repository.js(2) |
| `getAcquiringBillWorkerCount` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/settings-repository.js(2) |
| `getBackgroundConfig` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/settings-repository.js(2) |
| `getCurrencySuggestion` | 2 | 4 | 1 | src/renderer-dialogs.js(2), src/renderer.js(2) |
| `getCurrentModule` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/settings-repository.js(2) |
| `getDiffRowsByRun` | 2 | 4 | 1 | src/backend/biz-op-recon-db/run-repository.js(2), src/main-process/biz-op-recon-writer.js(2) |
| `getEnumConfig` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/settings-repository.js(2) |
| `getMaxBocFxOrigGroupNo` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/linked-table-repository.js(2) |
| `getMirrorRun` | 2 | 4 | 2 | src/main-process/bank-bu-recon-run-data.js(2), src/main-process/biz-op-recon-run-data.js(2) |
| `getReconIdFixBillCategory` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/settings-repository.js(2) |
| `getRowById` | 2 | 4 | 1 | src/backend/biz-op-recon-db/imports-repository.js(2), src/main-process/biz-op-recon-writer.js(2) |
| `getRunChunkProgress` | 2 | 4 | 1 | src/backend/acquiring-bill-currency-db/run-repository.js(2), src/main-process/acquiring-bill-currency-session.js(2) |
| `getTemplateByKey` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/template-repository.js(2) |
| `getTemplateByName` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/template-repository.js(2) |
| `hasLinkedTableRows` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/linked-table-repository.js(2) |
| `hasShownWinOneDriveStorageNotice` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/settings-repository.js(2) |
| `heapStats` | 2 | 4 | 2 | src/backend/biz-op-recon-import/import-worker.js(2), src/backend/pending-import/worker.js(2) |
| `importBillFile` | 2 | 4 | 1 | src/backend/acquiring-bill-currency-import/reader.js(2), src/main-process/acquiring-bill-currency-session.js(2) |
| `importFlowFile` | 2 | 4 | 1 | src/backend/acquiring-bill-currency-import/reader.js(2), src/main-process/acquiring-bill-currency-session.js(2) |
| `importMonth` | 2 | 4 | 1 | src/main-process/bank-bu-recon-run-data.js(2), src/main-process/bank-bu-recon-session.js(2) |
| `isFilenameMappingMode` | 2 | 4 | 2 | src/renderer.js(3), src/main.js(1) |
| `listAccountMappings` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/settings-repository.js(2) |
| `listChannelEnumValues` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/channel-enum-repository.js(2) |
| `listChildTemplates` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/template-repository.js(2) |
| `listDistinctBus` | 2 | 4 | 1 | src/backend/biz-op-recon-db/imports-repository.js(2), src/main-process/biz-op-recon-run-data.js(2) |
| `listLinkedTableMeta` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/linked-table-repository.js(2) |
| `listRunsByDateBu` | 2 | 4 | 1 | src/backend/biz-op-recon-db/run-repository.js(2), src/main-process/biz-op-recon-run-data.js(2) |
| `listRunsDualSource` | 2 | 4 | 2 | src/main-process/bank-bu-recon-run-data.js(2), src/main-process/biz-op-recon-run-data.js(2) |
| `listScenarios` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/scenarios-repository.js(2) |
| `listTemplateBundleEntries` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/template-repository.js(2) |
| `loadJobMeta` | 2 | 4 | 2 | src/backend/biz-op-recon-import/import-worker.js(2), src/backend/pending-import/worker.js(2) |
| `markBankDepositHits` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/linked-table-repository.js(2) |
| `markWinOneDriveStorageNoticeShown` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/settings-repository.js(2) |
| `MERCHANT_ID_MULTI_ACCOUNT_MARKER` | 2 | 4 | 2 | src/backend/database/utils.js(3), src/main.js(1) |
| `MTX_FEATURE` | 2 | 4 | 1 | src/constants/refund-backfill-fields.js(2), src/main-process/scenario-engines/r5-refund-order-backfill.js(2) |
| `normalizeCurrencyOptionEntry` | 2 | 4 | 1 | src/renderer-dialogs.js(2), src/renderer.js(2) |
| `openModuleMenu` | 2 | 4 | 1 | src/renderer-previews.js(2), src/renderer.js(2) |
| `OPPONENT_BILL_SHEET_NAME` | 2 | 4 | 1 | src/constants/recon-id-fix-fields.js(2), src/main-process/recon-id-fix-io.js(2) |
| `ORDER_REPAIR_SHEET_NAME` | 2 | 4 | 1 | src/constants/recon-id-fix-fields.js(2), src/main-process/recon-id-fix-io.js(2) |
| `ORDER_REPAIR_SHEET_NAME_GATEWAY` | 2 | 4 | 1 | src/constants/gateway-bill-recon-fields.js(2), src/main-process/recon-id-fix-io.js(2) |
| `parseColumnFromCellRef` | 2 | 4 | 1 | src/backend/acquiring-bill-currency-import/reader.js(3), src/backend/acquiring-bill-currency-import/reader-handrolled.js(1) |
| `parseRowXml` | 2 | 4 | 1 | src/backend/biz-op-recon-import/reader-streamed.js(2), src/backend/vcc-op-calc-import/reader.js(2) |
| `peekFirstFile` | 2 | 4 | 1 | src/backend/big-table-import/engine.js(3), src/main-process/acquiring-bill-currency-session.js(1) |
| `PENDING_DB_FILENAME` | 2 | 4 | 2 | src/backend/pending-db.js(3), src/main.js(1) |
| `PENDING_MATCH_KEY_DB_COLUMN` | 2 | 4 | 1 | src/backend/bank-bu-recon-db/columns.js(2), src/main-process/bank-bu-recon-session.js(2) |
| `PREPROCESS_TABLE_SIGNATURES` | 2 | 4 | 2 | src/constants/table-signatures.js(3), src/main.js(1) |
| `randomUUID` | 2 | 4 | 2 | src/backend/database/migrations.js(2), src/backend/database/template-repository.js(2) |
| `readAdmBankDepositRows` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/linked-table-repository.js(2) |
| `readBankDepositHitMarkers` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/linked-table-repository.js(2) |
| `readBocBankDepositRows` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/linked-table-repository.js(2) |
| `readBocFxLinkRows` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/linked-table-repository.js(2) |
| `readSharedStrings` | 2 | 4 | 1 | src/backend/biz-op-recon-import/reader-streamed.js(2), src/backend/vcc-op-calc-import/reader.js(2) |
| `RECON_RESULT_FIELDS` | 2 | 4 | 1 | src/constants/recon-id-fix-fields.js(2), src/main-process/recon-id-fix-io.js(2) |
| `RECON_RESULT_FIELDS_GATEWAY` | 2 | 4 | 1 | src/constants/gateway-bill-recon-fields.js(2), src/main-process/recon-id-fix-io.js(2) |
| `RECON_RESULT_SHEET_NAME` | 2 | 4 | 1 | src/constants/recon-id-fix-fields.js(2), src/main-process/recon-id-fix-io.js(2) |
| `RECON_RESULT_SHEET_NAME_GATEWAY` | 2 | 4 | 1 | src/constants/gateway-bill-recon-fields.js(2), src/main-process/recon-id-fix-io.js(2) |
| `reconIdFixResult` | 2 | 4 | 1 | src/renderer.js(3), src/main.js(1) |
| `refundOrderSession` | 2 | 4 | 1 | src/renderer.js(3), src/main.js(1) |
| `renameTemplate` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/template-repository.js(2) |
| `replaceBocFxLink` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/linked-table-repository.js(2) |
| `replaceLinkedTable` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/linked-table-repository.js(2) |
| `replaceLinkedTableStreaming` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/linked-table-repository.js(2) |
| `resolveCurrencyValue` | 2 | 4 | 1 | src/backend/file-service.js(2), src/backend/file-service/normalizers.js(2) |
| `resolveWorkerScript` | 2 | 4 | 2 | src/main-process/run-check-multiworker.js(2), src/main-process/run-check-worker-pool.js(2) |
| `rowScanner` | 2 | 4 | 2 | src/backend/big-table-import/engine.js(2), src/backend/big-table-import/import-worker.js(2) |
| `runBocDispatchOrderFix` | 2 | 4 | 2 | src/main-process/recon-id-fix-engine.js(2), src/main-process/scenario-engines/boc-dispatch-order-fix.js(2) |
| `runC4Scenario` | 2 | 4 | 2 | src/main-process/recon-id-fix-engine.js(2), src/main-process/scenario-engines/c4-recon-id-fix.js(2) |
| `runCheckCore` | 2 | 4 | 1 | src/main-process/acquiring-bill-currency-session.js(3), src/main-process/run-check-worker.js(1) |
| `runJpmDispatchOrderFix` | 2 | 4 | 2 | src/main-process/recon-id-fix-engine.js(2), src/main-process/scenario-engines/jpm-dispatch-order-fix.js(2) |
| `runRound1ReconIdMatch` | 2 | 4 | 2 | src/main-process/reconciliation-orchestrator.js(2), src/main-process/scenario-engines/r1-recon-id-match.js(2) |
| `runRound4FundNatureCheck` | 2 | 4 | 2 | src/main-process/reconciliation-orchestrator.js(2), src/main-process/scenario-engines/r4-fund-nature-check.js(2) |
| `runRound5FundTransferBackfill` | 2 | 4 | 2 | src/main-process/reconciliation-orchestrator.js(2), src/main-process/scenario-engines/r5-fund-transfer-backfill.js(2) |
| `runRound5PaymentOfflineAllocationBackfill` | 2 | 4 | 2 | src/main-process/reconciliation-orchestrator.js(2), src/main-process/scenario-engines/r5-payment-offline-allocation-backfill.js(2) |
| `runRound5PlatformInboundCleanup` | 2 | 4 | 2 | src/main-process/reconciliation-orchestrator.js(2), src/main-process/scenario-engines/r5-platform-inbound-cleanup.js(2) |
| `runRound5RefundOrderBackfill` | 2 | 4 | 2 | src/main-process/reconciliation-orchestrator.js(2), src/main-process/scenario-engines/r5-refund-order-backfill.js(2) |
| `runViaSideDb` | 2 | 4 | 2 | src/main-process/bank-bu-recon-run-data.js(2), src/main-process/biz-op-recon-run-data.js(2) |
| `sameDay` | 2 | 4 | 2 | src/main-process/scenario-engines/engine-date-utils.js(2), src/main-process/scenario-engines/r5-fund-transfer-backfill.js(2) |
| `saveAccountMappings` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/settings-repository.js(2) |
| `saveTemplateFilenameFixedField` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/template-repository.js(2) |
| `setAcquiringBillChunkSize` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/settings-repository.js(2) |
| `setAcquiringBillIdleCleanupMinutes` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/settings-repository.js(2) |
| `setAcquiringBillRawJsonRetentionDays` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/settings-repository.js(2) |
| `setAcquiringBillWorkerCount` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/settings-repository.js(2) |
| `setBackgroundConfig` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/settings-repository.js(2) |
| `setEnumConfig` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/settings-repository.js(2) |
| `spawn` | 2 | 4 | 2 | src/main-process/biz-op-recon-session.js(2), src/main-process/pending-session.js(2) |
| `T54SWIC_FEATURE` | 2 | 4 | 1 | src/constants/refund-backfill-fields.js(2), src/main-process/scenario-engines/r5-refund-order-backfill.js(2) |
| `toggleScenarioEnabled` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/scenarios-repository.js(2) |
| `transferScenarios` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/scenarios-repository.js(2) |
| `updateChannel` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/channels-repository.js(2) |
| `updateScenario` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/scenarios-repository.js(2) |
| `upsertBocFxLink` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/linked-table-repository.js(2) |
| `upsertLinkedBankDeposit` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/linked-table-repository.js(2) |
| `upsertLinkedBankDepositStreaming` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/linked-table-repository.js(2) |
| `upsertLinkedFx` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/linked-table-repository.js(2) |
| `upsertLinkedGatewayBill` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/linked-table-repository.js(2) |
| `upsertLinkedGatewayBillStreaming` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/linked-table-repository.js(2) |
| `upsertTemplate` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/template-repository.js(2) |
| `v8` | 2 | 4 | 2 | src/backend/biz-op-recon-import/import-worker.js(2), src/backend/pending-import/worker.js(2) |
| `validateBankHeaders` | 2 | 4 | 1 | src/backend/bank-bu-recon-import/reader.js(2), src/backend/bank-bu-recon-import/validator.js(2) |
| `validatePendingGuanliHeaders` | 2 | 4 | 1 | src/backend/bank-bu-recon-import/reader.js(2), src/backend/bank-bu-recon-import/validator.js(2) |
| `weekTagPlusOne` | 2 | 4 | 2 | src/main-process/scenario-engines/engine-week-utils.js(2), src/main-process/scenario-engines/r5-payment-offline-allocation-backfill.js(2) |
| `writeAdmMatchFlags` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/linked-table-repository.js(2) |
| `writeStreamedXlsx` | 2 | 4 | 2 | src/backend/pending-import/streaming-xlsx-writer.js(2), src/main-process/pending-archive-worker.js(2) |
| `xmlAttrUnescape` | 2 | 4 | 2 | src/backend/big-table-import/zip-reader.js(2), src/backend/biz-op-recon-import/reader-streamed.js(2) |
| `__test_only_set_worker_script__` | 2 | 3 | 2 | src/main-process/run-check-worker-pool.js(2), src/main-process/run-check-multiworker.js(1) |
| `AppDatabase` | 2 | 3 | 2 | src/backend/database.js(2), src/main.js(1) |
| `appendStatementSessionImport` | 2 | 3 | 1 | src/main-process/statement-session.js(2), src/main.js(1) |
| `applyScenarioBundleImport` | 2 | 3 | 1 | src/main-process/scenarios-bundle-import.js(2), src/main.js(1) |
| `assembleMonthlyBalance` | 2 | 3 | 1 | src/main-process/monthly-balance.js(2), src/main.js(1) |
| `BIZ_OP_BU_FIELD_DB_COLUMN` | 2 | 3 | 1 | src/backend/biz-op-recon-db/columns.js(2), src/main-process/biz-op-recon-session.js(1) |
| `buildDetailExportRows` | 2 | 3 | 1 | src/backend/file-service.js(2), src/main.js(1) |
| `buildStaleHitReminder` | 2 | 3 | 1 | src/main-process/scenario-engines/r5-refund-order-backfill.js(2), src/main.js(1) |
| `buildStatementFileEntry` | 2 | 3 | 1 | src/main-process/statement-session.js(2), src/main.js(1) |
| `clearRunsByMonth` | 2 | 3 | 1 | src/backend/acquiring-bill-currency-db/run-repository.js(2), src/main-process/acquiring-bill-currency-session.js(1) |
| `clearStaleSuccessfulRawJson` | 2 | 3 | 2 | src/backend/acquiring-bill-currency-db/raw-json-retention.js(2), src/main.js(1) |
| `compareMatchedContent` | 2 | 3 | 1 | src/backend/pending-reconcile/removal-match.js(2), src/backend/pending-export/writer.js(1) |
| `computeRunStats` | 2 | 3 | 1 | src/backend/acquiring-bill-currency-db/run-repository.js(2), src/main-process/acquiring-bill-currency-session.js(1) |
| `countC3BankCandidates` | 2 | 3 | 2 | src/main-process/scenario-engines/c3-gateway-recon-join.js(2), src/main.js(1) |
| `countRefundBankCandidates` | 2 | 3 | 2 | src/main-process/scenario-engines/r5-refund-order-backfill.js(2), src/main.js(1) |
| `countRowsInMonth` | 2 | 3 | 1 | src/backend/pending-db/month-repository.js(2), src/main-process/pending-session.js(1) |
| `createRowInserter` | 2 | 3 | 1 | src/backend/pending-db/month-repository.js(2), src/backend/pending-import/worker.js(1) |
| `createRun` | 2 | 3 | 1 | src/backend/pending-db/diff-repository.js(2), src/backend/pending-reconcile/engine.js(1) |
| `createStatementGenerationHelpers` | 2 | 3 | 1 | src/main-process/statement-generation.js(2), src/main.js(1) |
| `deleteMonth` | 2 | 3 | 1 | src/backend/pending-db/month-repository.js(2), src/backend/pending-import/worker.js(1) |
| `deleteMonthBySide` | 2 | 3 | 1 | src/backend/acquiring-bill-currency-db/import-repository.js(2), src/main-process/acquiring-bill-currency-session.js(1) |
| `detectBundleType` | 2 | 3 | 1 | src/backend/scenarios-bundle-io.js(2), src/main.js(1) |
| `detectTableType` | 2 | 3 | 2 | src/main-process/table-type-detector.js(2), src/main.js(1) |
| `findByChannelAndName` | 2 | 3 | 1 | src/backend/database/scenarios-repository.js(2), src/backend/database.js(1) |
| `getApplicableChannelIds` | 2 | 3 | 1 | src/backend/database/scenarios-repository.js(2), src/backend/database.js(1) |
| `getBankRows` | 2 | 3 | 1 | src/backend/bank-bu-recon-db/month-repository.js(2), src/main-process/bank-bu-recon-session.js(1) |
| `getBillDateCounts` | 2 | 3 | 1 | src/backend/acquiring-bill-currency-db/run-repository.js(2), src/main-process/acquiring-bill-currency-writer.js(1) |
| `getLatestRunByMonth` | 2 | 3 | 1 | src/backend/vcc-op-calc-db/run-repository.js(2), src/main-process/vcc-op-calc-session.js(1) |
| `getLatestRunForMonthPair` | 2 | 3 | 1 | src/backend/pending-db/diff-repository.js(2), src/preload.js(1) |
| `getOrCreateStatementImportSession` | 2 | 3 | 1 | src/main-process/statement-session.js(2), src/main.js(1) |
| `getPendingRows` | 2 | 3 | 1 | src/backend/bank-bu-recon-db/month-repository.js(2), src/main-process/bank-bu-recon-session.js(1) |
| `getSessionStatus` | 2 | 3 | 1 | src/main-process/acquiring-bill-currency-session.js(2), src/main-process/acquiring-bill-currency-run-data.js(1) |
| `getTemplatesByBankName` | 2 | 3 | 1 | src/backend/database/template-repository.js(2), src/backend/database/own-accounts-migration.js(1) |
| `importBillFiles` | 2 | 3 | 1 | src/main-process/acquiring-bill-currency-session.js(2), src/main-process/acquiring-bill-currency-run-data.js(1) |
| `importBillFilesWithOverwrite` | 2 | 3 | 1 | src/main-process/acquiring-bill-currency-session.js(2), src/main-process/acquiring-bill-currency-run-data.js(1) |
| `importFlowFiles` | 2 | 3 | 1 | src/main-process/acquiring-bill-currency-session.js(2), src/main-process/acquiring-bill-currency-run-data.js(1) |
| `importFlowFilesWithOverwrite` | 2 | 3 | 1 | src/main-process/acquiring-bill-currency-session.js(2), src/main-process/acquiring-bill-currency-run-data.js(1) |
| `insertBillRow` | 2 | 3 | 1 | src/backend/acquiring-bill-currency-db/import-repository.js(2), src/backend/acquiring-bill-currency-import/reader.js(1) |
| `insertDiffRows` | 2 | 3 | 1 | src/backend/biz-op-recon-db/run-repository.js(2), src/main-process/biz-op-recon-session.js(1) |
| `insertDiffRowsByJoinChunked` | 2 | 3 | 1 | src/backend/acquiring-bill-currency-db/run-repository.js(2), src/main-process/acquiring-bill-currency-session.js(1) |
| `insertDiffRowsByJoinMultiWorker` | 2 | 3 | 1 | src/backend/acquiring-bill-currency-db/run-repository.js(2), src/main-process/acquiring-bill-currency-session.js(1) |
| `insertFlowRow` | 2 | 3 | 1 | src/backend/acquiring-bill-currency-db/import-repository.js(2), src/backend/acquiring-bill-currency-import/reader.js(1) |
| `insertRunFiles` | 2 | 3 | 1 | src/backend/vcc-op-calc-db/run-repository.js(2), src/main-process/vcc-op-calc-session.js(1) |
| `isStorageRootOnOneDrive` | 2 | 3 | 2 | src/main-process/onedrive-detector.js(2), src/main.js(1) |
| `iterateDiffRowsByDateRange` | 2 | 3 | 1 | src/backend/acquiring-bill-currency-db/run-repository.js(2), src/main-process/acquiring-bill-currency-writer.js(1) |
| `LINKED_IMPORT_SIGNATURES` | 2 | 3 | 2 | src/constants/table-signatures.js(2), src/main.js(1) |
| `listAllByChannelId` | 2 | 3 | 1 | src/backend/database/scenarios-repository.js(2), src/backend/database.js(1) |
| `listBuiltinFixedForChannel` | 2 | 3 | 1 | src/backend/database/scenarios-repository.js(2), src/backend/database.js(1) |
| `listDistinctMonths` | 2 | 3 | 1 | src/backend/vcc-op-calc-db/run-repository.js(2), src/main-process/vcc-op-calc-session.js(1) |
| `listMatchedDiffRowIds` | 2 | 3 | 1 | src/backend/pending-reconcile/removal-match.js(2), src/backend/pending-export/writer.js(1) |
| `listMatchedRemovedRowIds` | 2 | 3 | 1 | src/backend/pending-reconcile/removal-match.js(2), src/backend/pending-export/writer.js(1) |
| `listRunsForMonthPair` | 2 | 3 | 1 | src/backend/pending-db/diff-repository.js(2), src/preload.js(1) |
| `loadFundTypeEnum` | 2 | 3 | 2 | src/constants/fund-type-enum.js(2), src/main.js(1) |
| `loadGatewayReconHeaders` | 2 | 3 | 2 | src/constants/gateway-recon-headers-loader.js(2), src/main.js(1) |
| `markCleanupPending` | 2 | 3 | 1 | src/backend/acquiring-bill-currency-db/run-repository.js(2), src/main-process/acquiring-bill-currency-session.js(1) |
| `mergeBankStatementRows` | 2 | 3 | 1 | src/main-process/bank-statement-merge.js(2), src/main.js(1) |
| `openBackgroundPalette` | 2 | 3 | 1 | src/renderer.js(2), src/renderer-previews.js(1) |
| `openPendingDb` | 2 | 3 | 2 | src/backend/pending-db.js(2), src/main.js(1) |
| `parseBankAccountExcel` | 2 | 3 | 2 | src/backend/bank-account-import.js(2), src/main.js(1) |
| `parseScenarioBundle` | 2 | 3 | 1 | src/backend/scenarios-bundle-io.js(2), src/main.js(1) |
| `peekMonthKeyFromFile` | 2 | 3 | 1 | src/backend/acquiring-bill-currency-import/reader.js(2), src/main-process/acquiring-bill-currency-session.js(1) |
| `pickBankDepositFields` | 2 | 3 | 2 | src/backend/database/linked-table-repository.js(2), src/main.js(1) |
| `pickStaleHits` | 2 | 3 | 1 | src/main-process/scenario-engines/r5-refund-order-backfill.js(2), src/main.js(1) |
| `prepareBillInsert` | 2 | 3 | 1 | src/backend/acquiring-bill-currency-db/import-repository.js(2), src/backend/acquiring-bill-currency-import/reader.js(1) |
| `prepareFlowInsert` | 2 | 3 | 1 | src/backend/acquiring-bill-currency-db/import-repository.js(2), src/backend/acquiring-bill-currency-import/reader.js(1) |
| `readBankFile` | 2 | 3 | 2 | src/backend/bank-bu-recon-import/reader.js(2), src/main.js(1) |
| `readBigAccountMode` | 2 | 3 | 2 | src/backend/big-account-mode-store.js(2), src/main.js(1) |
| `readBigAccountOrder` | 2 | 3 | 2 | src/backend/big-account-order-store.js(2), src/main.js(1) |
| `readPendingGuanliFile` | 2 | 3 | 2 | src/backend/bank-bu-recon-import/reader.js(2), src/main.js(1) |
| `rebuildAdmDerivation` | 2 | 3 | 1 | src/main-process/linked-derive-rebuild.js(2), src/main.js(1) |
| `rebuildBankDepositBocDerivation` | 2 | 3 | 1 | src/main-process/linked-derive-rebuild.js(2), src/main.js(1) |
| `rebuildFxBocDerivation` | 2 | 3 | 1 | src/main-process/linked-derive-rebuild.js(2), src/main.js(1) |
| `recordFromBankStatementRows` | 2 | 3 | 1 | src/backend/database/channel-enum-repository.js(2), src/backend/database.js(1) |
| `REFUND_BACKFILL_FIELD_MAP` | 2 | 3 | 1 | src/constants/refund-backfill-fields.js(2), src/main-process/scenario-engines/r5-refund-order-backfill.js(1) |
| `removeStatementSessionEntriesByFilePath` | 2 | 3 | 1 | src/main-process/statement-session.js(2), src/main.js(1) |
| `reportStartupFailure` | 2 | 3 | 1 | src/backend/startup-failure.js(2), src/main.js(1) |
| `runOwnAccountsMigration` | 2 | 3 | 2 | src/backend/database/own-accounts-migration.js(2), src/main.js(1) |
| `runPipeline` | 2 | 3 | 1 | src/backend/big-table-import/pipeline.js(2), src/backend/big-table-import/engine.js(1) |
| `runReconIdFix` | 2 | 3 | 2 | src/main-process/recon-id-fix-engine.js(2), src/main.js(1) |
| `scanFxGroups` | 2 | 3 | 1 | src/main-process/boc-fx-link-builder.js(2), src/main.js(1) |
| `serializeScenarioBundle` | 2 | 3 | 1 | src/backend/scenarios-bundle-io.js(2), src/main.js(1) |
| `setApplicableChannelIds` | 2 | 3 | 1 | src/backend/database/scenarios-repository.js(2), src/backend/database.js(1) |
| `showComingSoon` | 2 | 3 | 1 | src/renderer.js(2), src/renderer-dialogs.js(1) |
| `SIDE_DB_DDL_BIZ_OP` | 2 | 3 | 1 | src/backend/run-data-store.js(2), src/main-process/biz-op-recon-run-data.js(1) |
| `streamLinkedRowsToInsert` | 2 | 3 | 2 | src/main-process/linked-table-stream-source.js(2), src/main.js(1) |
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
| `writePlatformCleanupOutput` | 2 | 3 | 2 | src/main-process/platform-cleanup-writer.js(2), src/main.js(1) |
| `writeRefundBackfillOutput` | 2 | 3 | 2 | src/main-process/refund-backfill-writer.js(2), src/main.js(1) |
| `writeRunOutputs` | 2 | 3 | 1 | src/main-process/acquiring-bill-currency-writer.js(2), src/main-process/acquiring-bill-currency-session.js(1) |
| `writeScenarioHitRows` | 2 | 3 | 2 | src/main-process/scenario-hit-rows-writer.js(2), src/main.js(1) |
| `writeSingleDateDiffWorkbook` | 2 | 3 | 1 | src/main-process/biz-op-recon-writer.js(2), src/main.js(1) |
| `BALANCE_SEED_GENERATION_METHODS` | 2 | 2 | 1 | src/backend/balance-seed-store.js(1), src/main.js(1) |
| `CELL_OPEN_RE` | 2 | 2 | 2 | src/backend/acquiring-bill-currency-import/reader-handrolled.js(1), src/backend/pending-import/streaming-xlsx-reader.js(1) |
| `CELL_R_RE` | 2 | 2 | 2 | src/backend/acquiring-bill-currency-import/reader-handrolled.js(1), src/backend/pending-import/streaming-xlsx-reader.js(1) |
| `readBankStatement` | 2 | 2 | 1 | src/main-process/bank-statement-io.js(1), src/main.js(1) |
| `readGatewayRecon` | 2 | 2 | 1 | src/main-process/bank-statement-io.js(1), src/main.js(1) |
| `readMeaningfulRowsHead` | 2 | 2 | 1 | src/backend/file-service/readers.js(1), src/main-process/table-type-detector.js(1) |
| `readReconIdFixFile` | 2 | 2 | 1 | src/main-process/recon-id-fix-io.js(1), src/main.js(1) |
| `readXlsxSheetMetaLite` | 2 | 2 | 1 | src/backend/file-service/readers.js(1), src/main-process/table-type-detector.js(1) |
| `WINDOWS_RESERVED_NAMES` | 2 | 2 | 2 | src/main-process/bank-statement-io.js(1), src/main-process/recon-id-fix-io.js(1) |

