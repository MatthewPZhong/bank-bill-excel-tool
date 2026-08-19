# 代码库变量引用统计（自动生成）

> 由 `scripts/scan-vars.js` 自动生成，请不要手改。手工维护的重要变量清单在 `rules/important-variables.md`。

| 字段 | 值 |
|---|---|
| 版本 | v3.1.12 |
| 扫描时间 | 2026-8-19 14:59:38 |
| 扫描目录 | `src/` |
| 源码集合 | Git 已跟踪 `.js`（排除 ignored/generated/untracked） |
| JS 文件数 | 338 |
| 顶层声明总数 | 4478 |
| ≥2 次引用 | 4311 |
| 跨 ≥3 文件 (A-share) | 656 |
| 跨 2 文件 (A-pair) | 950 |
| 单文件 (A-local) | 2705 |
| 跨文件合计 (B) | 1606 |

---

## A-share — 跨 ≥3 文件共享

| 名字 | 跨度 | 总次数 | 声明数 | 声明位置（首个） |
|---|---:|---:|---:|---|
| `path` | 132 | 801 | 126 | src/backend/acquiring-bill-currency-import/reader-handrolled.js |
| `run` | 100 | 1160 | 3 | src/backend/vcc-financial-op/worker-entry.js |
| `fs` | 89 | 516 | 88 | src/backend/balance-adjustment-store.js |
| `parse` | 58 | 121 | 1 | src/backend/usage-stats.js |
| `crypto` | 54 | 156 | 54 | src/backend/database/archive-repository.js |
| `text` | 47 | 703 | 4 | src/backend/vcc-financial-op/row-mapper.js |
| `randomUUID` | 44 | 89 | 14 | src/backend/biz-op-recon-db/dataset-head-repository.js |
| `state` | 41 | 670 | 1 | src/renderer.js |
| `startsWith` | 39 | 90 | 1 | src/main-process/toolbox-input-kind.js |
| `channel` | 37 | 454 | 1 | src/backend/position-reconciliation-import/worker-entry.js |
| `sha256` | 37 | 266 | 5 | src/backend/vcc-financial-op/operation-audit.js |
| `SOURCE_TYPES` | 34 | 323 | 6 | src/backend/vcc-financial-op/data-target-deletion.js |
| `list` | 32 | 172 | 1 | src/backend/biz-op-recon-db/month-end-copy-intent-repository.js |
| `normalizeCell` | 32 | 168 | 15 | src/backend/balance-adjustment-store.js |
| `DatabaseSync` | 30 | 78 | 25 | src/backend/biz-op-recon-import/import-worker.js |
| `createHash` | 30 | 44 | 1 | src/main.js |
| `FileValidationError` | 28 | 130 | 18 | src/backend/balance-seed-store.js |
| `normalizeCellValue` | 23 | 302 | 12 | src/backend/database/fund-transfer-account-mapping-repository.js |
| `XLSX` | 21 | 104 | 21 | src/backend/bank-bu-recon-import/reader.js |
| `PositionReconciliationError` | 19 | 207 | 1 | src/main-process/position-reconciliation/common.js |
| `sideDbPath` | 19 | 94 | 1 | src/backend/run-data-store.js |
| `BANK_STATEMENT_FIELDS` | 19 | 61 | 14 | src/backend/database/linked-table-repository.js |
| `ExcelJS` | 19 | 47 | 19 | src/backend/position-reconciliation-import/anomaly-report.js |
| `freezeWorkerBatchContext` | 19 | 47 | 4 | src/main-process/archive-center/task-lifecycle.js |
| `pad` | 18 | 103 | 3 | src/backend/logger.js |
| `contentHash` | 18 | 97 | 1 | src/backend/vcc-financial-op/row-mapper.js |
| `repository` | 16 | 238 | 6 | src/backend/vcc-financial-op/data-target-deletion.js |
| `columnName` | 16 | 45 | 1 | src/main-process/toolbox-output-writer.js |
| `appendModuleLog` | 15 | 77 | 11 | src/backend/database.js |
| `SOURCE_DEFINITIONS` | 15 | 50 | 2 | src/backend/vcc-financial-op/definitions.js |
| `makeWarningCollector` | 15 | 30 | 4 | src/main-process/scenario-engines/boc-dispatch-order-fix.js |
| `FLOW_HEADERS` | 14 | 35 | 8 | src/backend/acquiring-bill-currency-db/columns.js |
| `validateHeaders` | 14 | 34 | 3 | src/backend/pending-import/contract-pending.js |
| `finish` | 13 | 79 | 2 | src/backend/vcc-financial-op/worker-entry.js |
| `SUPPORTED_CURRENCIES` | 13 | 62 | 4 | src/backend/vcc-financial-op/adjustment-lineage.js |
| `placeholders` | 13 | 57 | 2 | src/backend/position-reconciliation-import/maintenance-writer.js |
| `stableHash` | 13 | 57 | 3 | src/main-process/duplicate-inbound-match/service.js |
| `SOURCE_LABELS` | 13 | 41 | 3 | src/backend/vcc-financial-op/data-target-deletion.js |
| `applyWatermark` | 13 | 31 | 13 | src/backend/file-service/writers.js |
| `serializeError` | 12 | 49 | 7 | src/backend/vcc-financial-op/worker-entry.js |
| `parseNumber` | 12 | 43 | 4 | src/backend/pending-reconcile/removal-match.js |
| `parentPort` | 11 | 76 | 10 | src/backend/big-table-import/engine-worker-entry.js |
| `cancel` | 11 | 67 | 1 | src/main-process/run-check-worker-pool.js |
| `isRowMeaningful` | 11 | 30 | 2 | src/backend/file-service/common.js |
| `normalize` | 11 | 28 | 1 | src/main-process/bank-bu-recon-session.js |
| `toDate` | 10 | 42 | 9 | src/main-process/position-reconciliation/matching-engine.js |
| `sideDbRelPath` | 10 | 40 | 1 | src/backend/run-data-store.js |
| `PENDING_COLUMNS` | 10 | 39 | 10 | src/backend/pending-db/migrations.js |
| `canonicalizeVccAmount` | 10 | 37 | 10 | src/backend/vcc-financial-op/amount-rules.js |
| `canonicalizeDecimal` | 10 | 32 | 5 | src/backend/vcc-financial-op/amount-rules.js |
| `normalizeYearMonth` | 10 | 32 | 8 | src/backend/vcc-financial-op/calculator.js |
| `getRun` | 10 | 24 | 2 | src/backend/bank-bu-recon-db/run-repository.js |
| `openZipWithEntries` | 10 | 22 | 2 | src/backend/acquiring-bill-currency-import/reader.js |
| `validateFlowHeaders` | 10 | 20 | 8 | src/backend/acquiring-bill-currency-import/contract-flow.js |
| `deserializeError` | 10 | 19 | 4 | src/main-process/serialize-error.js |
| `runDataStore` | 9 | 173 | 9 | src/backend/duplicate-inbound-match-store.js |
| `active` | 9 | 171 | 1 | src/backend/position-reconciliation-import/worker-entry.js |
| `session` | 9 | 87 | 3 | src/main-process/acquiring-bill-currency-run-data.js |
| `remove` | 9 | 80 | 1 | src/backend/biz-op-recon-db/month-end-copy-intent-repository.js |
| `parseJson` | 9 | 57 | 6 | src/backend/database/duplicate-inbound-match-run-repository.js |
| `normalizeDate` | 9 | 31 | 4 | src/backend/vcc-financial-op/row-mapper.js |
| `normalizeHeaderRow` | 9 | 28 | 5 | src/backend/position-reconciliation-import/xlsx-reader.js |
| `bankChannel` | 9 | 27 | 1 | src/main-process/pre-fund-reconciliation/output-mapper.js |
| `FLOW_DB_COLUMNS` | 9 | 27 | 3 | src/backend/biz-op-recon-db/columns.js |
| `sourceSnapshotMatchesStat` | 9 | 26 | 1 | src/main-process/archive-center/source-snapshot.js |
| `sourceSnapshotFromStat` | 9 | 25 | 1 | src/main-process/archive-center/source-snapshot.js |
| `listMonths` | 9 | 20 | 4 | src/backend/acquiring-bill-currency-db/import-repository.js |
| `Worker` | 9 | 20 | 9 | src/backend/big-table-import/pipeline.js |
| `importFiles` | 9 | 19 | 4 | src/backend/big-table-import/engine.js |
| `makeModificationCollector` | 9 | 18 | 1 | src/main-process/scenario-engines/engine-utils.js |
| `saveMappings` | 9 | 17 | 2 | src/backend/database/fund-transfer-account-mapping-repository.js |
| `openReadStream` | 9 | 15 | 1 | src/backend/vcc-financial-op/workbook-reader.js |
| `insertRun` | 9 | 13 | 4 | src/backend/acquiring-bill-currency-db/run-repository.js |
| `fail` | 8 | 242 | 2 | src/backend/toolbox-format/biff8-overlay.js |
| `database` | 8 | 122 | 1 | src/main.js |
| `RUNS_TABLE` | 8 | 79 | 8 | src/backend/acquiring-bill-currency-db/run-repository.js |
| `operationError` | 8 | 56 | 3 | src/backend/vcc-financial-op/operation-audit.js |
| `emit` | 8 | 51 | 3 | src/backend/biz-op-recon-import/import-worker.js |
| `hex` | 8 | 31 | 1 | src/backend/toolbox-format/biff8-records.js |
| `SHA256_RE` | 8 | 29 | 8 | src/backend/database/archive-repository.js |
| `headersEqual` | 8 | 28 | 4 | src/backend/position-reconciliation-import/xlsx-reader.js |
| `FT_RECON_FIELD_MAP` | 8 | 24 | 6 | src/backend/database/linked-table-repository.js |
| `getRunById` | 8 | 22 | 3 | src/backend/acquiring-bill-currency-db/run-repository.js |
| `sax` | 8 | 22 | 8 | src/backend/acquiring-bill-currency-import/reader.js |
| `readDatabaseLocalTimestamp` | 8 | 19 | 3 | src/backend/vcc-financial-op/calculator.js |
| `getMonthMeta` | 8 | 18 | 2 | src/backend/bank-bu-recon-db/month-repository.js |
| `normalizeDateExportValue` | 8 | 18 | 6 | src/backend/database/linked-table-repository.js |
| `runReconciliation` | 8 | 18 | 5 | src/backend/pending-reconcile/engine.js |
| `create` | 8 | 17 | 1 | src/backend/biz-op-recon-db/month-end-copy-intent-repository.js |
| `readRows` | 8 | 16 | 4 | src/backend/bank-account-import.js |
| `acknowledgeArchiveTerminal` | 8 | 15 | 3 | src/backend/biz-op-recon-db/run-repository.js |
| `createRun` | 8 | 11 | 1 | src/backend/pending-db/diff-repository.js |
| `dialog` | 7 | 615 | 1 | src/main.js |
| `MODULE` | 7 | 125 | 6 | src/backend/duplicate-inbound-match-store.js |
| `FIELD_MAP` | 7 | 103 | 6 | src/constants/adm-bank-deposit-fields.js |
| `runRepository` | 7 | 67 | 7 | src/backend/biz-op-recon-import/import-worker.js |
| `stableStringify` | 7 | 39 | 3 | src/backend/vcc-financial-op/operation-state.js |
| `openSideDb` | 7 | 38 | 1 | src/backend/run-data-store.js |
| `parseNumericValue` | 7 | 35 | 2 | src/backend/balance-seed-store.js |
| `normalizeSourceSnapshot` | 7 | 32 | 1 | src/main-process/archive-center/source-snapshot.js |
| `stableJson` | 7 | 28 | 2 | src/backend/vcc-financial-op/result-template-contract.js |
| `BILL_HEADERS` | 7 | 27 | 7 | src/backend/acquiring-bill-currency-db/columns.js |
| `absolutePath` | 7 | 23 | 1 | src/main-process/archive-center/file-plan.js |
| `sideDbExists` | 7 | 21 | 1 | src/backend/run-data-store.js |
| `GATEWAY_BILL_FIELDS` | 7 | 16 | 4 | src/constants/adm-bank-deposit-fields.js |
| `createContract` | 7 | 13 | 4 | src/backend/acquiring-bill-currency-import/contract-bill.js |
| `scanSheet` | 7 | 12 | 2 | src/backend/toolbox-format/biff8-records.js |
| `mapRow` | 7 | 10 | 1 | src/backend/pending-import/removed-reader.js |
| `elements` | 6 | 255 | 1 | src/renderer.js |
| `VCC_MUTATION_OPERATIONS` | 6 | 81 | 1 | src/backend/vcc-financial-op/mutation-policy.js |
| `POSITION_IMPORT_COMMANDS` | 6 | 40 | 1 | src/backend/position-reconciliation-import/constants.js |
| `dependentMonths` | 6 | 30 | 1 | src/backend/vcc-financial-op/unarchive-gate.js |
| `serializeJson` | 6 | 30 | 1 | src/main-process/position-reconciliation/store.js |
| `logger` | 6 | 28 | 3 | src/main-process/biz-op-recon-session.js |
| `monthOf` | 6 | 28 | 2 | src/main-process/biz-op-recon-run-data.js |
| `sourceIdentity` | 6 | 23 | 1 | src/backend/vcc-financial-op/source-lineage.js |
| `MAX_COLLECTED_ERRORS` | 6 | 21 | 5 | src/backend/acquiring-bill-currency-import/contract-bill.js |
| `BANK_SHEET_NAME` | 6 | 20 | 1 | src/main-process/position-reconciliation/constants.js |
| `POSITION_BANK_HEADERS` | 6 | 20 | 1 | src/main-process/position-reconciliation/constants.js |
| `BIZ_OP_DB_COLUMNS` | 6 | 18 | 2 | src/backend/biz-op-recon-db/columns.js |
| `listSideDbFiles` | 6 | 18 | 1 | src/backend/run-data-store.js |
| `parseDateValue` | 6 | 18 | 1 | src/backend/file-service/normalizers.js |
| `addCanonicalDecimals` | 6 | 16 | 2 | src/main-process/financial-decimal.js |
| `assertPositionLargeImportSchema` | 6 | 16 | 1 | src/main-process/position-reconciliation/large-import-schema.js |
| `main` | 6 | 16 | 3 | src/backend/biz-op-recon-import/import-worker.js |
| `MS_PER_DAY` | 6 | 16 | 6 | src/main-process/scenario-engines/dbs-charge-fund-check.js |
| `subtractCanonicalDecimals` | 6 | 15 | 1 | src/main-process/financial-decimal.js |
| `runPositionSideDbMutation` | 6 | 14 | 1 | src/main-process/position-reconciliation/side-db-mutation.js |
| `assertPreservedOperationState` | 6 | 13 | 1 | src/backend/vcc-financial-op/preserved-state.js |
| `formatTimestamp` | 6 | 13 | 6 | src/backend/database/backup.js |
| `getEffectiveRunResult` | 6 | 12 | 5 | src/backend/vcc-financial-op/operation-audit.js |
| `getRunByArchiveTaskRunId` | 6 | 12 | 2 | src/backend/biz-op-recon-db/run-repository.js |
| `isMainThread` | 6 | 12 | 6 | src/backend/big-table-import/engine-worker-entry.js |
| `loadSharedStrings` | 6 | 12 | 1 | src/backend/acquiring-bill-currency-import/reader.js |
| `scanSheetRows` | 6 | 12 | 4 | src/backend/big-table-import/row-scanner.js |
| `trimTrailingEmptyCells` | 6 | 12 | 1 | src/backend/file-service/common.js |
| `JSZip` | 6 | 11 | 6 | src/backend/biz-op-recon-import/reader-streamed.js |
| `deleteSideDbByPath` | 6 | 10 | 1 | src/backend/run-data-store.js |
| `listMappings` | 6 | 9 | 1 | src/backend/database/fund-transfer-account-mapping-repository.js |
| `sanitizeFileName` | 6 | 9 | 5 | src/backend/balance-seed-store.js |
| `listUnacknowledgedArchiveRuns` | 6 | 8 | 2 | src/backend/biz-op-recon-db/run-repository.js |
| `escapeHtml` | 5 | 293 | 1 | src/renderer.js |
| `shell` | 5 | 92 | 1 | src/main.js |
| `setCurrentModule` | 5 | 70 | 2 | src/backend/database/settings-repository.js |
| `app` | 5 | 38 | 1 | src/main.js |
| `localName` | 5 | 35 | 2 | src/backend/toolbox-format/style-registry.js |
| `getSetting` | 5 | 28 | 1 | src/backend/database/settings-repository.js |
| `openExistingSideDb` | 5 | 28 | 1 | src/backend/run-data-store.js |
| `bumpRevision` | 5 | 27 | 4 | src/backend/position-reconciliation-import/account-writer.js |
| `assertNotCancelled` | 5 | 26 | 5 | src/backend/position-reconciliation-import/account-writer.js |
| `cellValue` | 5 | 24 | 1 | src/main-process/position-reconciliation/filtered-source-report.js |
| `MAX_DATA_ROWS_PER_SHEET` | 5 | 22 | 5 | src/main-process/acquiring-bill-currency-writer.js |
| `namespaceAllowed` | 5 | 22 | 1 | src/backend/toolbox-format/ooxml-namespaces.js |
| `tableHasColumn` | 5 | 21 | 5 | src/backend/vcc-financial-op/destructive-write.js |
| `PENDING_HEADERS` | 5 | 20 | 1 | src/backend/vcc-financial-op/definitions.js |
| `normalizeHeaderCell` | 5 | 18 | 4 | src/backend/acquiring-bill-currency-import/validator.js |
| `EXCEL_MAX_ROWS` | 5 | 17 | 4 | src/backend/position-reconciliation-import/anomaly-report.js |
| `normalizePositionCheckpoint` | 5 | 17 | 1 | src/main-process/position-reconciliation/side-db-mutation.js |
| `CancelError` | 5 | 16 | 3 | src/backend/big-table-import/engine.js |
| `getHead` | 5 | 16 | 1 | src/backend/biz-op-recon-db/dataset-head-repository.js |
| `positionCheckpointsEqual` | 5 | 16 | 1 | src/main-process/position-reconciliation/side-db-mutation.js |
| `SPREADSHEETML_NAMESPACES` | 5 | 16 | 1 | src/backend/toolbox-format/ooxml-namespaces.js |
| `getSourceDefinition` | 5 | 15 | 1 | src/backend/vcc-financial-op/definitions.js |
| `hashFileSha256Async` | 5 | 15 | 1 | src/main-process/position-reconciliation/input-staging.js |
| `TEMPLATE_BILL_HEADERS` | 5 | 15 | 4 | src/backend/acquiring-bill-currency-db/columns.js |
| `valuesEqual` | 5 | 15 | 1 | src/main-process/scenario-engines/engine-utils.js |
| `VALID_DIRECTION_IN` | 5 | 14 | 4 | src/backend/biz-op-recon-import/validator.js |
| `absoluteDecimal` | 5 | 13 | 2 | src/main-process/financial-decimal.js |
| `BIZ_OP_HEADERS` | 5 | 13 | 1 | src/backend/biz-op-recon-db/columns.js |
| `dayDiffWithin` | 5 | 13 | 5 | src/main-process/scenario-engines/dbs-charge-fund-check.js |
| `extractMonthKey` | 5 | 13 | 5 | src/backend/acquiring-bill-currency-import/contract-bill.js |
| `insertOperationAudit` | 5 | 13 | 1 | src/backend/vcc-financial-op/operation-audit.js |
| `pipeline` | 5 | 13 | 5 | src/backend/big-table-import/engine.js |
| `refreshPositionSourceSummary` | 5 | 13 | 1 | src/main-process/position-reconciliation/source-summary-cache.js |
| `assertExcelCellTextLength` | 5 | 12 | 1 | src/backend/toolbox-format/excel-text.js |
| `assertPositionImportDiskSpace` | 5 | 12 | 1 | src/backend/position-reconciliation-import/disk-space-gate.js |
| `assertSuccessOperationAudit` | 5 | 12 | 1 | src/backend/vcc-financial-op/operation-audit.js |
| `collectRunEvidence` | 5 | 12 | 1 | src/backend/vcc-financial-op/operation-audit.js |
| `getImportRecord` | 5 | 12 | 1 | src/backend/vcc-financial-op-db/repository.js |
| `persistRolledBackAudit` | 5 | 12 | 1 | src/backend/vcc-financial-op/operation-audit.js |
| `positionLargeImportSchemaFingerprint` | 5 | 12 | 1 | src/main-process/position-reconciliation/large-import-schema.js |
| `SHARED_STRINGS_ENTRY_NAME` | 5 | 12 | 3 | src/backend/acquiring-bill-currency-import/reader.js |
| `VALID_DIRECTION_OUT` | 5 | 12 | 4 | src/backend/biz-op-recon-import/validator.js |
| `validateBankDirection` | 5 | 12 | 4 | src/main-process/scenario-engines/bank-direction-validator.js |
| `validateOperationConfirmation` | 5 | 12 | 1 | src/backend/vcc-financial-op/operation-state.js |
| `deriveLinkedRowsForRecord` | 5 | 11 | 1 | src/main-process/position-reconciliation/derivation.js |
| `evaluateCondition` | 5 | 11 | 1 | src/main-process/scenario-engines/engine-utils.js |
| `freezeWorkerOperationContext` | 5 | 11 | 2 | src/main-process/archive-center/task-lifecycle.js |
| `os` | 5 | 11 | 4 | src/backend/big-table-import/pipeline.js |
| `POSITION_IMPORT_PROGRESS_ROW_INTERVAL` | 5 | 11 | 1 | src/backend/position-reconciliation-import/constants.js |
| `sameDay` | 5 | 11 | 5 | src/main-process/scenario-engines/dbs-charge-fund-check.js |
| `StableArrayHashAccumulator` | 5 | 11 | 1 | src/backend/position-reconciliation-import/contracts.js |
| `WORKBOOK_ENTRY_NAME` | 5 | 11 | 1 | src/backend/big-table-import/zip-reader.js |
| `ensureRowId` | 5 | 10 | 1 | src/main-process/scenario-engines/engine-utils.js |
| `isBlankRow` | 5 | 10 | 1 | src/main-process/position-reconciliation/common.js |
| `LINK_HEADERS` | 5 | 10 | 1 | src/main-process/position-reconciliation/constants.js |
| `listChannels` | 5 | 10 | 1 | src/backend/database/channels-repository.js |
| `listRuns` | 5 | 10 | 2 | src/backend/bank-bu-recon-db/run-repository.js |
| `normalizeFundTransferDatePolicy` | 5 | 10 | 3 | src/main-process/scenario-engines/dbs-charge-fund-check.js |
| `ORDER_REPAIR_FIELDS_GATEWAY` | 5 | 10 | 3 | src/constants/gateway-bill-recon-fields.js |
| `verifySealedLedger` | 5 | 10 | 1 | src/backend/position-reconciliation-import/ledger.js |
| `getLatestRun` | 5 | 9 | 2 | src/backend/acquiring-bill-currency-db/run-repository.js |
| `splitTemplateName` | 5 | 8 | 2 | src/backend/database/own-accounts-migration.js |
| `deleteTemplate` | 5 | 7 | 1 | src/backend/database/template-repository.js |
| `updateRunExportPath` | 5 | 7 | 2 | src/backend/bank-bu-recon-db/run-repository.js |
| `deleteSideDb` | 5 | 6 | 1 | src/backend/run-data-store.js |
| `normalizeText` | 4 | 97 | 3 | src/backend/database/migrations.js |
| `setStatus` | 4 | 87 | 1 | src/renderer.js |
| `trimCell` | 4 | 65 | 3 | src/main-process/pre-fund-reconciliation/bank-row.js |
| `scan` | 4 | 54 | 1 | src/main-process/vcc-op-calc-session.js |
| `step` | 4 | 54 | 1 | src/backend/vcc-financial-op/mutation-policy.js |
| `runRepo` | 4 | 45 | 4 | src/main-process/acquiring-bill-currency-run-data.js |
| `targetPathAliasKey` | 4 | 38 | 1 | src/main-process/toolbox-target-identity.js |
| `normalizeBu` | 4 | 29 | 2 | src/main-process/bank-bu-recon-session.js |
| `tableColumns` | 4 | 29 | 4 | src/backend/vcc-financial-op-db/migrations.js |
| `setSetting` | 4 | 28 | 1 | src/backend/database/settings-repository.js |
| `emitProgress` | 4 | 27 | 4 | src/backend/position-reconciliation-import/maintenance-writer.js |
| `SYSTEM_OP_HEADERS` | 4 | 27 | 1 | src/backend/vcc-financial-op/definitions.js |
| `getStatus` | 4 | 26 | 1 | src/main-process/run-check-worker-pool.js |
| `pad2` | 4 | 26 | 4 | src/backend/usage-stats.js |
| `MATCH_TYPES` | 4 | 23 | 1 | src/main-process/position-reconciliation/constants.js |
| `scopeKey` | 4 | 23 | 1 | src/main-process/position-reconciliation/store.js |
| `monthRepository` | 4 | 22 | 3 | src/main-process/bank-bu-recon-run-data.js |
| `FIXED_FIELD_VALUE_PREFIX` | 4 | 21 | 2 | src/backend/database/utils.js |
| `importsRepository` | 4 | 21 | 4 | src/backend/biz-op-recon-import/import-worker.js |
| `PRESERVED_OPERATIONS` | 4 | 21 | 1 | src/backend/vcc-financial-op/preserved-state.js |
| `isCanonicalFundTransferOwner` | 4 | 19 | 1 | src/main-process/fund-transfer-date-policy.js |
| `workerData` | 4 | 19 | 3 | src/backend/vcc-financial-op/worker-entry.js |
| `importRepo` | 4 | 18 | 4 | src/backend/acquiring-bill-currency-import/reader-handrolled.js |
| `MERCHANT_ID_SELF_INPUT_OPTION` | 4 | 17 | 2 | src/main.js |
| `writeErrorReport` | 4 | 17 | 1 | src/main-process/exceljs-writer.js |
| `ARCHIVE_CONTRACTS` | 4 | 15 | 2 | src/backend/vcc-financial-op/archive-contract.js |
| `readPositionDatabaseCheckpoint` | 4 | 15 | 1 | src/main-process/position-reconciliation/side-db-mutation.js |
| `SOURCE_TYPE_INBOUND` | 4 | 15 | 1 | src/main-process/pre-fund-reconciliation/mpt-schema.js |
| `YELLOW_FILL` | 4 | 15 | 4 | src/main-process/bank-bu-recon-writer.js |
| `BALANCE_CALCULATED_OPTION` | 4 | 14 | 2 | src/main.js |
| `DELETE_TARGET_LABELS` | 4 | 14 | 2 | src/backend/vcc-financial-op/data-target-deletion.js |
| `STATE_CHANGED_CODE` | 4 | 14 | 1 | src/backend/vcc-financial-op/operation-state.js |
| `STATE_CHANGED_MESSAGE` | 4 | 14 | 1 | src/backend/vcc-financial-op/operation-state.js |
| `DecimalAccumulator` | 4 | 13 | 3 | src/backend/vcc-financial-op/calculator.js |
| `inferDateCellFormat` | 4 | 13 | 1 | src/backend/file-service/normalizers.js |
| `normalizeOperationMonth` | 4 | 13 | 1 | src/backend/vcc-financial-op/operation-state.js |
| `rowValues` | 4 | 13 | 3 | src/main-process/duplicate-inbound-match/excel-writer.js |
| `snapshotPreservedOperationState` | 4 | 13 | 1 | src/backend/vcc-financial-op/preserved-state.js |
| `throwIfCancelled` | 4 | 13 | 1 | src/backend/vcc-financial-op/detail-importer.js |
| `toExcelSerial` | 4 | 13 | 1 | src/backend/file-service/normalizers.js |
| `BANK_STATUSES` | 4 | 12 | 1 | src/main-process/position-reconciliation/constants.js |
| `BILL_KEY_COLUMN_INDICES` | 4 | 12 | 4 | src/backend/acquiring-bill-currency-db/columns.js |
| `buildOperationState` | 4 | 12 | 1 | src/backend/vcc-financial-op/operation-state.js |
| `dayDiffAbs` | 4 | 12 | 1 | src/main-process/scenario-engines/r5-payment-offline-allocation-backfill.js |
| `DETAIL_SOURCE_TYPES` | 4 | 12 | 3 | src/backend/vcc-financial-op/dataset-deletion.js |
| `sanitizeSheetName` | 4 | 12 | 4 | src/backend/pending-export/writer.js |
| `ADVANCED_MAPPING_FIELDS` | 4 | 11 | 2 | src/main.js |
| `cancelRequested` | 4 | 11 | 2 | src/backend/vcc-financial-op/worker-entry.js |
| `FLOW_KEY_COLUMN_INDICES` | 4 | 11 | 4 | src/backend/acquiring-bill-currency-db/columns.js |
| `normalizeTransactionNo` | 4 | 11 | 4 | src/backend/database/linked-table-repository.js |
| `PENDING_V1_HEADERS` | 4 | 11 | 1 | src/backend/vcc-financial-op/definitions.js |
| `STAGING_RELATIVE_PATH` | 4 | 11 | 1 | src/main-process/position-reconciliation/input-staging.js |
| `WATERMARK_AUTHOR` | 4 | 11 | 4 | src/main-process/pre-fund-reconciliation/excel-writer.js |
| `assertPreviewToken` | 4 | 10 | 1 | src/backend/vcc-financial-op/operation-state.js |
| `AUDIT_HEADERS` | 4 | 10 | 1 | src/main-process/position-reconciliation/constants.js |
| `BANK_DB_COLUMNS` | 4 | 10 | 1 | src/backend/bank-bu-recon-db/columns.js |
| `CHANNEL_BILL_FIELDS` | 4 | 10 | 2 | src/constants/gateway-bill-recon-fields.js |
| `createChannel` | 4 | 10 | 2 | src/backend/database/channels-repository.js |
| `emptyStats` | 4 | 10 | 1 | src/backend/position-reconciliation-import/preflight.js |
| `ensureBizOpReconTablesSupport` | 4 | 10 | 4 | src/backend/biz-op-recon-db/migrations.js |
| `freezePersistedTaskOwner` | 4 | 10 | 1 | src/main-process/archive-center/worker-operation-context.js |
| `PENDING_GUANLI_DB_COLUMNS` | 4 | 10 | 1 | src/backend/bank-bu-recon-db/columns.js |
| `POSITION_IMPORT_PROTOCOL_VERSION` | 4 | 10 | 1 | src/backend/position-reconciliation-import/constants.js |
| `readerFor` | 4 | 10 | 1 | src/backend/position-reconciliation-import/preflight.js |
| `ToolboxHeaderMismatchError` | 4 | 10 | 4 | src/backend/toolbox-xlsx-stream/multi-sheet-reader.js |
| `assertStagedInputUnchangedAsync` | 4 | 9 | 1 | src/main-process/position-reconciliation/input-staging.js |
| `BANK_HEADERS` | 4 | 9 | 1 | src/backend/bank-bu-recon-db/columns.js |
| `buildRunRowKey` | 4 | 9 | 3 | src/backend/vcc-financial-op/archive-evidence.js |
| `dispatchEngineImport` | 4 | 9 | 4 | src/main-process/acquiring-bill-currency-session.js |
| `getBankRows` | 4 | 9 | 1 | src/backend/bank-bu-recon-db/month-repository.js |
| `hashSourceFiles` | 4 | 9 | 3 | src/backend/vcc-financial-op/import-service.js |
| `isValidInputFingerprint` | 4 | 9 | 3 | src/backend/vcc-financial-op/archive-contract.js |
| `locateSheets` | 4 | 9 | 1 | src/backend/big-table-import/zip-reader.js |
| `moduleDir` | 4 | 9 | 1 | src/backend/run-data-store.js |
| `normalizedSaxAttributes` | 4 | 9 | 1 | src/backend/toolbox-format/ooxml-namespaces.js |
| `operationPreviewToken` | 4 | 9 | 1 | src/backend/vcc-financial-op/operation-state.js |
| `parseWorkbookXml` | 4 | 9 | 2 | src/backend/toolbox-format/xlsx-pass.js |
| `PENDING_GUANLI_HEADERS` | 4 | 9 | 1 | src/backend/bank-bu-recon-db/columns.js |
| `readXlsxStreamed` | 4 | 9 | 4 | src/backend/file-service/readers.js |
| `refreshImportRecordArchiveState` | 4 | 9 | 1 | src/backend/vcc-financial-op-db/repository.js |
| `streamFlowFile` | 4 | 9 | 4 | src/backend/biz-op-recon-import/import-worker.js |
| `styleHeader` | 4 | 9 | 4 | src/backend/position-reconciliation-import/anomaly-report.js |
| `addOneDay` | 4 | 8 | 1 | src/main-process/biz-op-recon-session.js |
| `BUSINESS_BILL_FIELDS` | 4 | 8 | 2 | src/constants/recon-id-fix-fields.js |
| `classifySourceRow` | 4 | 8 | 1 | src/main-process/position-reconciliation/readers.js |
| `clearRunsAndDiffsByDateBu` | 4 | 8 | 1 | src/backend/biz-op-recon-db/run-repository.js |
| `createToolboxCell` | 4 | 8 | 1 | src/backend/toolbox-format/model.js |
| `createToolboxRow` | 4 | 8 | 1 | src/backend/toolbox-format/model.js |
| `createToolboxSheetMeta` | 4 | 8 | 1 | src/backend/toolbox-format/model.js |
| `detectToolboxInputKind` | 4 | 8 | 4 | src/main-process/toolbox-format-io.js |
| `diagnoseFirstMonthFacts` | 4 | 8 | 2 | src/backend/vcc-financial-op-db/state-model.js |
| `filterStagingPathsWithoutProtectedSources` | 4 | 8 | 1 | src/main-process/position-reconciliation/input-staging.js |
| `getRowsByDateBu` | 4 | 8 | 2 | src/backend/biz-op-recon-db/flow-imports-repository.js |
| `listTemplates` | 4 | 8 | 1 | src/backend/database/template-repository.js |
| `OPPONENT_BILL_FIELDS` | 4 | 8 | 2 | src/constants/recon-id-fix-fields.js |
| `saveBillSplitAmountRules` | 4 | 8 | 1 | src/backend/database/template-repository.js |
| `saveBillSplitMeta` | 4 | 8 | 1 | src/backend/database/template-repository.js |
| `scanXlsxSheet` | 4 | 8 | 1 | src/backend/toolbox-format/xlsx-sheet-scanner.js |
| `validateBillHeaders` | 4 | 8 | 4 | src/backend/acquiring-bill-currency-import/contract-bill.js |
| `validateFlowRow` | 4 | 8 | 3 | src/backend/biz-op-recon-import/contract-flow.js |
| `writeWorkbookRows` | 4 | 8 | 2 | src/backend/file-service.js |
| `artifactManifestFromFilePlan` | 4 | 7 | 1 | src/main-process/archive-center/file-plan.js |
| `assertXlsxEntriesUnderLimit` | 4 | 7 | 4 | src/backend/biz-op-recon-import/reader-streamed.js |
| `buildDateDir` | 4 | 7 | 3 | src/main-process/acquiring-bill-currency-writer.js |
| `errorCodeToCause` | 4 | 7 | 4 | src/backend/file-service/error-causes.js |
| `insertRows` | 4 | 7 | 2 | src/backend/biz-op-recon-db/flow-imports-repository.js |
| `normalizeFilePlanV1` | 4 | 7 | 1 | src/main-process/archive-center/file-plan.js |
| `pathsAlias` | 4 | 7 | 1 | src/main-process/toolbox-target-identity.js |
| `readRowsWithMetadata` | 4 | 7 | 1 | src/backend/file-service/readers.js |
| `setChildParent` | 4 | 7 | 1 | src/backend/database/template-repository.js |
| `writeBalanceWorkbook` | 4 | 7 | 2 | src/backend/file-service.js |
| `writeHead` | 4 | 7 | 1 | src/backend/biz-op-recon-db/dataset-head-repository.js |
| `writeXlsxAtomically` | 4 | 7 | 4 | src/main-process/vcc-financial-op-audit-writer.js |
| `buildTimestamp` | 4 | 6 | 3 | src/main-process/acquiring-bill-currency-writer.js |
| `clearBillSplitMergeGroups` | 4 | 6 | 1 | src/backend/database/template-repository.js |
| `createImportRecord` | 4 | 6 | 1 | src/backend/vcc-financial-op-db/repository.js |
| `createImportSource` | 4 | 6 | 1 | src/backend/vcc-financial-op-db/repository.js |
| `createRowFilter` | 4 | 6 | 2 | src/main-process/toolbox-multi-split.js |
| `deleteBillSplitRow` | 4 | 6 | 1 | src/backend/database/template-repository.js |
| `readBankStatement` | 4 | 6 | 3 | src/main-process/bank-statement-io.js |
| `runBizOpImport` | 4 | 6 | 2 | src/backend/biz-op-recon-import/import-worker.js |
| `runFlowImport` | 4 | 6 | 2 | src/backend/biz-op-recon-import/import-worker.js |
| `saveAmountSplitRules` | 4 | 6 | 1 | src/backend/database/template-repository.js |
| `saveBillSplitMappings` | 4 | 6 | 1 | src/backend/database/template-repository.js |
| `saveBillSplitMergeGroup` | 4 | 6 | 1 | src/backend/database/template-repository.js |
| `saveBillSplitRow` | 4 | 6 | 1 | src/backend/database/template-repository.js |
| `saveBillSplitRowCount` | 4 | 6 | 1 | src/backend/database/template-repository.js |
| `setParentStatus` | 4 | 6 | 1 | src/backend/database/template-repository.js |
| `StringDecoder` | 4 | 6 | 4 | src/backend/acquiring-bill-currency-import/reader-handrolled.js |
| `batchDelete` | 4 | 5 | 1 | src/backend/database/scenarios-repository.js |
| `clearByDateBu` | 4 | 5 | 1 | src/backend/biz-op-recon-db/imports-repository.js |
| `deleteArchiveRunByTaskRunId` | 4 | 5 | 1 | src/backend/biz-op-recon-db/run-repository.js |
| `extractHeaders` | 4 | 5 | 1 | src/main-process/toolbox-stream-io.js |
| `failImportBatch` | 4 | 5 | 1 | src/backend/vcc-financial-op-db/repository.js |
| `ToolboxXlsxFormatError` | 3 | 124 | 1 | src/backend/toolbox-format/xlsx-sheet-scanner.js |
| `MODULES` | 3 | 101 | 2 | src/main-process/archive-center/operation-tracker.js |
| `requiredText` | 3 | 96 | 3 | src/backend/database/archive-repository.js |
| `countRows` | 3 | 48 | 3 | src/backend/vcc-financial-op/destructive-write.js |
| `hasColumn` | 3 | 47 | 2 | src/backend/biz-op-recon-db/migrations.js |
| `RECON` | 3 | 43 | 3 | src/main-process/scenario-engines/many-to-many-detector.js |
| `bankValue` | 3 | 41 | 1 | src/main-process/pre-fund-reconciliation/output-mapper.js |
| `settingsRepository` | 3 | 40 | 3 | src/backend/database.js |
| `applyMismatch` | 3 | 38 | 3 | src/backend/position-reconciliation-import/account-writer.js |
| `publicFailure` | 3 | 34 | 3 | src/main-process/archive-center/controller.js |
| `POSITION_IMPORT_MESSAGE_TYPES` | 3 | 31 | 1 | src/backend/position-reconciliation-import/constants.js |
| `runEvidence` | 3 | 31 | 1 | src/main-process/acquiring-bill-currency-run-data.js |
| `validationError` | 3 | 31 | 1 | src/main-process/pre-fund-reconciliation/mpt-schema.js |
| `SYSTEM_OP_DEFINITION` | 3 | 29 | 1 | src/backend/vcc-financial-op/definitions.js |
| `datasetHeadRepository` | 3 | 26 | 3 | src/backend/biz-op-recon-import/import-worker.js |
| `DELETE_TARGET_TYPES` | 3 | 26 | 2 | src/backend/vcc-financial-op/data-target-deletion.js |
| `BigTableImportError` | 3 | 25 | 1 | src/backend/big-table-import/zip-reader.js |
| `lastGeneratedExports` | 3 | 24 | 1 | src/main.js |
| `recoveryError` | 3 | 24 | 1 | src/main-process/pre-fund-archive-lineage.js |
| `REASON_CODES` | 3 | 23 | 2 | src/main-process/position-reconciliation/contracts.js |
| `TABLE` | 3 | 23 | 3 | src/backend/biz-op-recon-db/flow-imports-repository.js |
| `BANK_ROW_CLASSIFICATION` | 3 | 22 | 1 | src/main-process/pre-fund-reconciliation/bank-row.js |
| `buildOutputRow` | 3 | 21 | 3 | src/main-process/scenario-engines/boc-dispatch-order-fix.js |
| `weekTag` | 3 | 20 | 2 | src/main-process/scenario-engines/engine-week-utils.js |
| `parseAmount` | 3 | 19 | 3 | src/backend/biz-op-recon-import/validator.js |
| `safeRollback` | 3 | 19 | 3 | src/backend/big-table-import/engine.js |
| `verifyFile` | 3 | 19 | 1 | src/main-process/archive-center/storage-materializer.js |
| `businessOperationRegistry` | 3 | 18 | 1 | src/main.js |
| `reportError` | 3 | 18 | 2 | src/backend/position-reconciliation-import/anomaly-report.js |
| `CONCAT_FIELDS_MAPPING_FIELD` | 3 | 17 | 2 | src/main.js |
| `json` | 3 | 17 | 1 | src/backend/position-reconciliation-import/ledger.js |
| `TOOLBOX_SHEET_STRATEGIES` | 3 | 17 | 1 | src/main-process/toolbox-format-io.js |
| `BALANCE_DISABLED_OPTION` | 3 | 16 | 2 | src/main.js |
| `yieldToEventLoop` | 3 | 16 | 3 | src/backend/position-reconciliation-import/maintenance-writer.js |
| `diffRepo` | 3 | 15 | 3 | src/backend/pending-export/writer.js |
| `mapRun` | 3 | 15 | 3 | src/backend/duplicate-inbound-match-store.js |
| `own` | 3 | 15 | 1 | src/main-process/duplicate-inbound-match/matching-engine.js |
| `POSITION_IMPORT_ENGINES` | 3 | 15 | 1 | src/backend/position-reconciliation-import/constants.js |
| `RESULT_MUTATION_OPERATIONS` | 3 | 15 | 1 | src/backend/vcc-financial-op/preserved-state.js |
| `PRAGMA_EXPECTED` | 3 | 14 | 3 | src/backend/big-table-import/engine.js |
| `readToolboxMetadataEntryAsString` | 3 | 14 | 1 | src/backend/toolbox-format/xlsx-pass.js |
| `applyStatementResult` | 3 | 13 | 1 | src/renderer.js |
| `BANK_RECON_ID_FIELD` | 3 | 13 | 3 | src/main-process/scenario-engines/dbs-charge-fund-check.js |
| `getRunChunkProgress` | 3 | 12 | 1 | src/backend/acquiring-bill-currency-db/run-repository.js |
| `OFFICE_RELATIONSHIP_NAMESPACES` | 3 | 12 | 1 | src/backend/toolbox-format/ooxml-namespaces.js |
| `upsertMainRunMirror` | 3 | 12 | 3 | src/main-process/acquiring-bill-currency-run-data.js |
| `compareText` | 3 | 11 | 2 | src/backend/vcc-financial-op/archive-evidence.js |
| `EXCEL_CELL_TEXT_MAX_UTF16_UNITS` | 3 | 11 | 1 | src/backend/toolbox-format/excel-text.js |
| `findRelationshipEntry` | 3 | 11 | 1 | src/backend/toolbox-format/xlsx-pass.js |
| `getLinkedTableMeta` | 3 | 11 | 1 | src/backend/database/linked-table-repository.js |
| `getVccFinancialOpModuleState` | 3 | 11 | 1 | src/backend/vcc-financial-op-db/repository.js |
| `parseBalancesJson` | 3 | 11 | 3 | src/backend/vcc-financial-op/calculator.js |
| `parseDecimalLexical` | 3 | 11 | 1 | src/backend/toolbox-format/number-date.js |
| `previewDataTargetDeletion` | 3 | 11 | 1 | src/backend/vcc-financial-op/data-target-deletion.js |
| `processingResult` | 3 | 11 | 1 | src/main.js |
| `rollbackQuietly` | 3 | 11 | 3 | src/backend/duplicate-inbound-match-store.js |
| `setRunChunkProgress` | 3 | 11 | 1 | src/backend/acquiring-bill-currency-db/run-repository.js |
| `assertCurrentPositionCheckpointHistory` | 3 | 10 | 1 | src/main-process/position-reconciliation/side-db-mutation.js |
| `bankAmountAbs` | 3 | 10 | 2 | src/main-process/scenario-engines/r5-fund-transfer-backfill.js |
| `canonicalDecimal` | 3 | 10 | 2 | src/main-process/position-reconciliation/common.js |
| `closeMutationGuard` | 3 | 10 | 1 | src/backend/vcc-financial-op/mutation-guard.js |
| `finishImportRecord` | 3 | 10 | 1 | src/backend/vcc-financial-op-db/repository.js |
| `operations` | 3 | 10 | 1 | src/backend/vcc-financial-op/mutation-policy.js |
| `PRAGMA_STATEMENTS` | 3 | 10 | 3 | src/backend/big-table-import/engine.js |
| `addToAccumulatorMap` | 3 | 9 | 2 | src/backend/vcc-financial-op/calculator.js |
| `amountEqual` | 3 | 9 | 3 | src/main-process/scenario-engines/r5-fund-transfer-backfill.js |
| `attachSourceIdentity` | 3 | 9 | 1 | src/backend/vcc-financial-op/source-lineage.js |
| `BANK_STATEMENT_FIELDS_FOR_C3` | 3 | 9 | 2 | src/constants/bank-statement-fields.js |
| `BANK_STATEMENT_VIRTUAL_AMOUNT_ABS` | 3 | 9 | 3 | src/constants/bank-statement-fields.js |
| `buildHeaderValidator` | 3 | 9 | 3 | src/backend/acquiring-bill-currency-import/validator.js |
| `classifyBankRow` | 3 | 9 | 1 | src/main-process/pre-fund-reconciliation/bank-row.js |
| `classifyExcelNumberFormat` | 3 | 9 | 1 | src/backend/toolbox-format/number-date.js |
| `collectEntrySizes` | 3 | 9 | 1 | src/backend/pending-import/xlsx-size-preflight.js |
| `detectDetailSourceType` | 3 | 9 | 1 | src/backend/vcc-financial-op/definitions.js |
| `exactSaxLocalName` | 3 | 9 | 1 | src/backend/toolbox-format/ooxml-namespaces.js |
| `FLOW_TABLE` | 3 | 9 | 3 | src/backend/acquiring-bill-currency-db/run-repository.js |
| `FUND_TRANSFER_RECON_USED` | 3 | 9 | 1 | src/constants/fund-transfer-recon-fields.js |
| `getChannelById` | 3 | 9 | 1 | src/backend/database/channels-repository.js |
| `getRunMirror` | 3 | 9 | 2 | src/backend/database/duplicate-inbound-match-run-repository.js |
| `GW_RECON_ID_FIELD` | 3 | 9 | 3 | src/main-process/scenario-engines/dbs-charge-fund-check.js |
| `hasFundTransferReservedSignature` | 3 | 9 | 1 | src/main-process/fund-transfer-date-policy.js |
| `isNumericFieldName` | 3 | 9 | 3 | src/backend/pending-reconcile/removal-match.js |
| `MPT_SCHEMAS` | 3 | 9 | 2 | src/main-process/pre-fund-reconciliation/mpt-schema.js |
| `normalizeLegacyStoredCurrency` | 3 | 9 | 1 | src/backend/vcc-financial-op/definitions.js |
| `parseJsonArray` | 3 | 9 | 2 | src/backend/database/utils.js |
| `PENDING_RAW_CONTRACT_V1` | 3 | 9 | 1 | src/backend/vcc-financial-op/definitions.js |
| `PENDING_RAW_CONTRACT_V2` | 3 | 9 | 1 | src/backend/vcc-financial-op/definitions.js |
| `readEntryAsString` | 3 | 9 | 1 | src/backend/big-table-import/zip-reader.js |
| `REFUND_BANK_COLUMNS` | 3 | 9 | 1 | src/constants/refund-backfill-fields.js |
| `streamToolboxTables` | 3 | 9 | 1 | src/main-process/toolbox-format-io.js |
| `toInvalidBothNonzeroError` | 3 | 9 | 1 | src/main-process/pre-fund-reconciliation/bank-row.js |
| `ALLOWED_SOURCE_TYPES` | 3 | 8 | 2 | src/backend/vcc-financial-op/dataset-deletion.js |
| `AMOUNT_BASED_ACCOUNT_MAPPING_FIELD` | 3 | 8 | 2 | src/main.js |
| `AMOUNT_BASED_NAME_MAPPING_FIELD` | 3 | 8 | 2 | src/main.js |
| `AMOUNT_EPSILON` | 3 | 8 | 1 | src/backend/biz-op-recon-db/columns.js |
| `AMOUNT_SPLIT_BY_FIELD_ENABLED_OPTION` | 3 | 8 | 2 | src/main.js |
| `AMOUNT_SPLIT_BY_FIELD_MAPPING_FIELD` | 3 | 8 | 2 | src/main.js |
| `applyHeaderRowFont` | 3 | 8 | 3 | src/backend/file-service/writers.js |
| `assertVccTriggerPolicy` | 3 | 8 | 1 | src/backend/vcc-financial-op/mutation-guard.js |
| `cloneRowsWithMetadata` | 3 | 8 | 1 | src/main-process/statement-session.js |
| `ensureVccFinancialOpTablesSupport` | 3 | 8 | 3 | src/backend/database.js |
| `FLOW_INSERT_SQL` | 3 | 8 | 3 | src/backend/acquiring-bill-currency-db/import-repository.js |
| `GATEWAY_RECON_FIELDS` | 3 | 8 | 3 | src/constants/gateway-recon-fields.js |
| `getMonthReadiness` | 3 | 8 | 1 | src/backend/acquiring-bill-currency-db/import-repository.js |
| `getTemplateBigAccounts` | 3 | 8 | 1 | src/backend/database/template-repository.js |
| `groupBy` | 3 | 8 | 2 | src/main-process/scenario-engines/jpm-dispatch-order-fix.js |
| `inputEvidenceFor` | 3 | 8 | 3 | src/backend/position-reconciliation-import/account-writer.js |
| `listDiffRows` | 3 | 8 | 1 | src/backend/pending-db/diff-repository.js |
| `normalizeCurrency` | 3 | 8 | 3 | src/backend/acquiring-bill-currency-db/import-repository.js |
| `performance` | 3 | 8 | 2 | src/main-process/vcc-financial-op-read-worker.js |
| `REFUND_TEMPLATE_HEADERS` | 3 | 8 | 1 | src/constants/refund-backfill-fields.js |
| `registerVccStorageWriteCapability` | 3 | 8 | 1 | src/backend/vcc-financial-op-db/storage-contract.js |
| `SIGNED_AMOUNT_MAPPING_FIELD` | 3 | 8 | 2 | src/main.js |
| `snapshotResultMutationState` | 3 | 8 | 1 | src/backend/vcc-financial-op/preserved-state.js |
| `sourceIdentityFromError` | 3 | 8 | 2 | src/backend/vcc-financial-op/import-service.js |
| `sourceTypeForFundType` | 3 | 8 | 1 | src/main-process/position-reconciliation/constants.js |
| `TEXT_HEADER_PATTERN` | 3 | 8 | 2 | src/backend/position-reconciliation-import/anomaly-report.js |
| `updateDateRange` | 3 | 8 | 1 | src/backend/position-reconciliation-import/preflight.js |
| `validateConsumedAttributeCase` | 3 | 8 | 3 | src/backend/toolbox-format/style-registry.js |
| `validateSourceRow` | 3 | 8 | 1 | src/main-process/position-reconciliation/readers.js |
| `assertMutationGuardPostwrite` | 3 | 7 | 1 | src/backend/vcc-financial-op/mutation-guard.js |
| `assertMutationRuntimeAvailable` | 3 | 7 | 1 | src/backend/vcc-financial-op/mutation-guard.js |
| `assertNoUnacknowledgedArchiveRunByDateBu` | 3 | 7 | 1 | src/backend/biz-op-recon-db/run-repository.js |
| `assertVccMutationSchema` | 3 | 7 | 1 | src/backend/vcc-financial-op/mutation-guard.js |
| `backfillBocReconLinkIds` | 3 | 7 | 1 | src/main-process/boc-fx-link-builder.js |
| `bankAmountWithExtraFee` | 3 | 7 | 2 | src/main-process/scenario-engines/many-to-many-detector.js |
| `beginMutationGuard` | 3 | 7 | 1 | src/backend/vcc-financial-op/mutation-guard.js |
| `buildBocBankRows` | 3 | 7 | 1 | src/main-process/boc-fx-link-builder.js |
| `buildInsertSql` | 3 | 7 | 3 | src/backend/bank-bu-recon-db/month-repository.js |
| `classifyArchiveContract` | 3 | 7 | 1 | src/backend/vcc-financial-op/archive-contract.js |
| `createScenario` | 3 | 7 | 1 | src/backend/database/scenarios-repository.js |
| `createToolboxOutputWriter` | 3 | 7 | 3 | src/main-process/toolbox-format-operations.js |
| `decodeExcelStXstring` | 3 | 7 | 1 | src/backend/toolbox-format/excel-text.js |
| `DUPLICATE_GATEWAY_HEADERS` | 3 | 7 | 1 | src/main-process/pre-fund-reconciliation/output-mapper.js |
| `ensureSupportedFile` | 3 | 7 | 2 | src/backend/file-service/readers.js |
| `executeRegisteredMutationSteps` | 3 | 7 | 1 | src/backend/vcc-financial-op/mutation-guard.js |
| `expectedLedgerFile` | 3 | 7 | 1 | src/backend/position-reconciliation-import/source-writer.js |
| `fingerprintQuery` | 3 | 7 | 1 | src/backend/vcc-financial-op/operation-state.js |
| `listAllRuns` | 3 | 7 | 1 | src/backend/pending-db/diff-repository.js |
| `mapDetailRow` | 3 | 7 | 1 | src/backend/vcc-financial-op/row-mapper.js |
| `MODULE_PRE_FUND_RECONCILIATION_RESULTS` | 3 | 7 | 1 | src/backend/run-data-store.js |
| `normalizeInputFilePaths` | 3 | 7 | 1 | src/main-process/statement-session.js |
| `normalizePositionImportEngine` | 3 | 7 | 1 | src/backend/position-reconciliation-import/constants.js |
| `normalizeWorksheetTarget` | 3 | 7 | 3 | src/backend/big-table-import/zip-reader.js |
| `openDb` | 3 | 7 | 2 | src/backend/biz-op-recon-import/import-worker.js |
| `parseMptFile` | 3 | 7 | 3 | src/backend/pre-fund-reconciliation-store.js |
| `parseMptFileName` | 3 | 7 | 1 | src/main-process/pre-fund-reconciliation/mpt-schema.js |
| `parsePaymentBigAccounts` | 3 | 7 | 1 | src/main-process/scenario-engines/r5-payment-offline-allocation-backfill.js |
| `parseWorkbookRelationships` | 3 | 7 | 1 | src/backend/toolbox-format/xlsx-pass.js |
| `pendingCanonicalValues` | 3 | 7 | 1 | src/backend/vcc-financial-op/row-mapper.js |
| `readFirstMonthFacts` | 3 | 7 | 1 | src/backend/vcc-financial-op-db/state-model.js |
| `readLinkedTableRows` | 3 | 7 | 1 | src/backend/database/linked-table-repository.js |
| `readSheetAsRows` | 3 | 7 | 3 | src/backend/bank-bu-recon-import/reader.js |
| `resolveFromRel` | 3 | 7 | 1 | src/backend/run-data-store.js |
| `saxAttributeIdentity` | 3 | 7 | 1 | src/backend/toolbox-format/ooxml-namespaces.js |
| `sourceRecords` | 3 | 7 | 1 | src/main-process/position-reconciliation/matching-engine.js |
| `SourceStyleRegistry` | 3 | 7 | 3 | src/backend/toolbox-format/biff8-pass.js |
| `targetSnapshot` | 3 | 7 | 1 | src/main-process/archive-center/file-plan.js |
| `validateContract` | 3 | 7 | 3 | src/backend/big-table-import/contract.js |
| `WORKER_SCRIPT_PATH` | 3 | 7 | 3 | src/backend/big-table-import/pipeline.js |
| `writeBizOpErrorReportXlsx` | 3 | 7 | 1 | src/main-process/biz-op-recon-writer.js |
| `writeFlowErrorReportXlsx` | 3 | 7 | 1 | src/main-process/biz-op-recon-writer.js |
| `xmlUnescape` | 3 | 7 | 3 | src/backend/acquiring-bill-currency-import/reader-handrolled.js |
| `acknowledgeRunByTaskRun` | 3 | 6 | 1 | src/main-process/biz-op-recon-run-data.js |
| `assertExcelStXstringRawLength` | 3 | 6 | 1 | src/backend/toolbox-format/excel-text.js |
| `assertExpectedResultRevision` | 3 | 6 | 1 | src/backend/vcc-financial-op/result-adjustments.js |
| `assertSourceFileMatchesSync` | 3 | 6 | 1 | src/backend/vcc-financial-op/source-lineage.js |
| `buildDeleteTargetTokenV2` | 3 | 6 | 1 | src/backend/vcc-financial-op/operation-token-v2.js |
| `buildOperationTokenV2` | 3 | 6 | 1 | src/backend/vcc-financial-op/operation-token-v2.js |
| `CHANNEL_VALUE` | 3 | 6 | 2 | src/backend/database/linked-table-repository.js |
| `classifyNumericOutput` | 3 | 6 | 1 | src/backend/toolbox-format/number-date.js |
| `clearMonth` | 3 | 6 | 2 | src/backend/acquiring-bill-currency-db/import-repository.js |
| `columnLetterToIndex` | 3 | 6 | 2 | src/backend/acquiring-bill-currency-import/reader.js |
| `compareCanonicalDecimals` | 3 | 6 | 1 | src/main-process/financial-decimal.js |
| `compileRegexLiteral` | 3 | 6 | 1 | src/backend/file-service/normalizers.js |
| `computeRowHash` | 3 | 6 | 3 | src/backend/pending-import/contract-pending.js |
| `configureDatabase` | 3 | 6 | 3 | src/backend/position-reconciliation-import/account-writer.js |
| `createPreFundReconciliationStore` | 3 | 6 | 1 | src/backend/pre-fund-reconciliation-store.js |
| `createRunMirror` | 3 | 6 | 2 | src/backend/database/duplicate-inbound-match-run-repository.js |
| `createSourceStyleRegistryFromOoxml` | 3 | 6 | 1 | src/backend/toolbox-format/style-registry.js |
| `createStorageMaterializer` | 3 | 6 | 1 | src/main-process/archive-center/storage-materializer.js |
| `createTaskPolicyRegistry` | 3 | 6 | 2 | src/main-process/archive-center/operation-tracker.js |
| `DATE_MISMATCH_WARNING_CODE` | 3 | 6 | 3 | src/main-process/scenario-engines/dbs-charge-fund-check.js |
| `deleteMonthSideDb` | 3 | 6 | 3 | src/main-process/acquiring-bill-currency-run-data.js |
| `DIRECTION_MISMATCH_WARNING_CODE` | 3 | 6 | 3 | src/main-process/scenario-engines/dbs-charge-fund-check.js |
| `dispatchPositionLargeImportSchemaMigration` | 3 | 6 | 1 | src/main-process/position-reconciliation/import-dispatch.js |
| `evaluateUnarchiveGate` | 3 | 6 | 2 | src/backend/vcc-financial-op/destructive-write.js |
| `failRunMirror` | 3 | 6 | 2 | src/backend/database/duplicate-inbound-match-run-repository.js |
| `finishRunMirror` | 3 | 6 | 2 | src/backend/database/duplicate-inbound-match-run-repository.js |
| `flowRowToArray` | 3 | 6 | 1 | src/backend/biz-op-recon-db/columns.js |
| `freezePendingDatasetSeedV1` | 3 | 6 | 2 | src/backend/pending-db/dataset-identity.js |
| `FUND_TRANSFER_RECON_UNUSED` | 3 | 6 | 1 | src/constants/fund-transfer-recon-fields.js |
| `FUND_TYPE_PAIRS` | 3 | 6 | 1 | src/main-process/position-reconciliation/constants.js |
| `getAmountSplitRules` | 3 | 6 | 1 | src/backend/database/template-repository.js |
| `groupBigAccountRows` | 3 | 6 | 2 | src/backend/database/utils.js |
| `hslToRgb` | 3 | 6 | 3 | src/backend/toolbox-format/biff8-colors.js |
| `identityFromPendingDatasetSeed` | 3 | 6 | 2 | src/backend/pending-db/dataset-identity.js |
| `inspectSourceFiles` | 3 | 6 | 3 | src/backend/vcc-financial-op/detail-importer.js |
| `isPositionImportCancellationLocked` | 3 | 6 | 1 | src/backend/position-reconciliation-import/constants.js |
| `isPositionImportMutatingCommand` | 3 | 6 | 1 | src/backend/position-reconciliation-import/constants.js |
| `isRegexLiteral` | 3 | 6 | 1 | src/backend/file-service/normalizers.js |
| `JOURNAL_INDEX_NAME` | 3 | 6 | 2 | src/main-process/toolbox-output-publication-dispatch.js |
| `listAdjustmentOptions` | 3 | 6 | 1 | src/backend/vcc-financial-op/result-adjustments.js |
| `listArchivedResultMonths` | 3 | 6 | 1 | src/backend/vcc-financial-op/unarchive.js |
| `listGatewayBillSourceTags` | 3 | 6 | 1 | src/backend/database/linked-table-repository.js |
| `listImportRecords` | 3 | 6 | 1 | src/backend/vcc-financial-op-db/repository.js |
| `listRunMirrors` | 3 | 6 | 2 | src/backend/database/duplicate-inbound-match-run-repository.js |
| `loadCurrencyMappings` | 3 | 6 | 2 | src/backend/file-service.js |
| `loadSharedStringsProvider` | 3 | 6 | 1 | src/backend/position-reconciliation-import/shared-strings-provider.js |
| `makeRowInserter` | 3 | 6 | 2 | src/backend/biz-op-recon-db/flow-imports-repository.js |
| `markRunMirrorUnavailable` | 3 | 6 | 2 | src/backend/database/duplicate-inbound-match-run-repository.js |
| `nextDatasetIdentity` | 3 | 6 | 1 | src/backend/biz-op-recon-db/dataset-head-repository.js |
| `normalizeBillDate` | 3 | 6 | 3 | src/backend/acquiring-bill-currency-db/import-repository.js |
| `openToolboxXlsxPass` | 3 | 6 | 1 | src/backend/toolbox-format/xlsx-pass.js |
| `ORDER_REPAIR_FIELDS` | 3 | 6 | 2 | src/constants/recon-id-fix-fields.js |
| `PACKAGE_RELATIONSHIP_NAMESPACES` | 3 | 6 | 1 | src/backend/toolbox-format/ooxml-namespaces.js |
| `parseFtaDate` | 3 | 6 | 2 | src/main-process/scenario-engines/engine-week-utils.js |
| `PAYMENT_OFFLINE_FIELD_MAP` | 3 | 6 | 1 | src/constants/payment-offline-allocation-fields.js |
| `previewUnarchive` | 3 | 6 | 1 | src/backend/vcc-financial-op/unarchive.js |
| `readBankDepositBocCandidates` | 3 | 6 | 1 | src/backend/database/linked-table-repository.js |
| `readBocFxLinkRowsWithIds` | 3 | 6 | 1 | src/backend/database/linked-table-repository.js |
| `reconcileOrphans` | 3 | 6 | 3 | src/main-process/acquiring-bill-currency-run-data.js |
| `recordExportPath` | 3 | 6 | 2 | src/main-process/bank-bu-recon-run-data.js |
| `recoverPendingToolboxPublications` | 3 | 6 | 1 | src/main-process/toolbox-output-publication.js |
| `rematchAllBocGroups` | 3 | 6 | 1 | src/main-process/boc-fx-link-builder.js |
| `replaceBocBankDeposit` | 3 | 6 | 1 | src/backend/database/linked-table-repository.js |
| `resolveArchiveScope` | 3 | 6 | 3 | src/main-process/archive-center/module-scope-registry.js |
| `resolveSinglePreparedFieldValue` | 3 | 6 | 1 | src/main-process/statement-session.js |
| `runMigrations` | 3 | 6 | 3 | src/backend/pending-db.js |
| `stableRowGuardHash` | 3 | 6 | 1 | src/backend/position-reconciliation-import/contracts.js |
| `streamDetailRows` | 3 | 6 | 3 | src/backend/vcc-financial-op/detail-importer.js |
| `subOneDay` | 3 | 6 | 2 | src/backend/biz-op-recon-db/run-repository.js |
| `SUPPORTED_EXTENSIONS` | 3 | 6 | 1 | src/backend/file-service/common.js |
| `Transform` | 3 | 6 | 3 | src/main-process/archive-center/archive-service.js |
| `validateBizOpHeaders` | 3 | 6 | 1 | src/backend/biz-op-recon-import/validator.js |
| `validateBizOpRow` | 3 | 6 | 2 | src/backend/biz-op-recon-import/import-worker.js |
| `validateFundTransferDirections` | 3 | 6 | 1 | src/main-process/scenario-engines/fund-transfer-engine-policy.js |
| `WORKBOOK_RELS_ENTRY_NAME` | 3 | 6 | 1 | src/backend/big-table-import/zip-reader.js |
| `writeBocFxLinkReconIds` | 3 | 6 | 1 | src/backend/database/linked-table-repository.js |
| `writeDiffWorkbook` | 3 | 6 | 2 | src/main-process/acquiring-bill-currency-writer.js |
| `yauzl` | 3 | 6 | 3 | src/backend/acquiring-bill-currency-import/reader.js |
| `__test_only_set_worker_script__` | 3 | 5 | 3 | src/main-process/run-check-multiworker.js |
| `addRunAdjustment` | 3 | 5 | 1 | src/backend/vcc-financial-op/result-adjustments.js |
| `ALL_BANKS_TEMPLATE_SCOPE` | 3 | 5 | 2 | src/main-process/monthly-balance.js |
| `ALL_TABLE_SIGNATURES` | 3 | 5 | 2 | src/constants/table-signatures.js |
| `assertStagedInputUnchanged` | 3 | 5 | 1 | src/main-process/position-reconciliation/input-staging.js |
| `bankCreditAmount` | 3 | 5 | 1 | src/main-process/scenario-engines/r5-payment-offline-allocation-backfill.js |
| `bizOpRunOutputIntent` | 3 | 5 | 1 | src/main-process/biz-op-archive-lineage.js |
| `buildAdmRows` | 3 | 5 | 2 | src/main-process/adm-bank-deposit-builder.js |
| `buildFundTransferReconRows` | 3 | 5 | 2 | src/main-process/fund-transfer-recon-builder.js |
| `calculateEndingBalanceFromAmounts` | 3 | 5 | 1 | src/backend/file-service/normalizers.js |
| `createArchiveRepository` | 3 | 5 | 1 | src/backend/database/archive-repository.js |
| `createValuesByFieldAccumulator` | 3 | 5 | 1 | src/main-process/toolbox.js |
| `deleteDataset` | 3 | 5 | 1 | src/backend/vcc-financial-op/dataset-deletion.js |
| `encodeExcelStXstring` | 3 | 5 | 1 | src/backend/toolbox-format/excel-text.js |
| `exportToolboxFilter` | 3 | 5 | 1 | src/main-process/toolbox-format-operations.js |
| `exportToolboxMultiFilters` | 3 | 5 | 1 | src/main-process/toolbox-format-operations.js |
| `freezeDatasetSeedV1` | 3 | 5 | 2 | src/backend/biz-op-recon-db/dataset-head-repository.js |
| `freezeFlowDatasetSeedV1` | 3 | 5 | 2 | src/backend/biz-op-recon-db/dataset-head-repository.js |
| `getEnabledModules` | 3 | 5 | 1 | src/backend/database/settings-repository.js |
| `getGatewayBillRawJsonById` | 3 | 5 | 1 | src/backend/database/linked-table-repository.js |
| `getImportBatch` | 3 | 5 | 1 | src/backend/vcc-financial-op-db/repository.js |
| `getRule` | 3 | 5 | 1 | src/backend/pending-db/rule-repository.js |
| `getStatementSessionEntries` | 3 | 5 | 1 | src/main-process/statement-session.js |
| `getUiStyle` | 3 | 5 | 1 | src/backend/database/settings-repository.js |
| `inferEndingBalance` | 3 | 5 | 1 | src/backend/file-service/normalizers.js |
| `iterateGatewayBillRows` | 3 | 5 | 1 | src/backend/database/linked-table-repository.js |
| `lettersToIndex` | 3 | 5 | 2 | src/backend/pending-import/streaming-xlsx-reader.js |
| `listDeleteTargets` | 3 | 5 | 1 | src/backend/vcc-financial-op/data-target-deletion.js |
| `listImportMonths` | 3 | 5 | 1 | src/backend/vcc-financial-op-db/repository.js |
| `listImportSources` | 3 | 5 | 1 | src/backend/vcc-financial-op-db/repository.js |
| `listReadyDates` | 3 | 5 | 1 | src/backend/biz-op-recon-db/run-repository.js |
| `listSuccessDatesInRange` | 3 | 5 | 1 | src/backend/biz-op-recon-db/run-repository.js |
| `mergeMappedDetailRows` | 3 | 5 | 1 | src/main-process/statement-session.js |
| `publishToolboxPublicationAsync` | 3 | 5 | 1 | src/main-process/toolbox-output-publication-dispatch.js |
| `readBalanceSeedRecords` | 3 | 5 | 1 | src/main-process/monthly-balance.js |
| `readBankDepositAdmCandidates` | 3 | 5 | 1 | src/backend/database/linked-table-repository.js |
| `readBizOpFile` | 3 | 5 | 1 | src/backend/biz-op-recon-import/reader.js |
| `readBocFxLinkRowsForRematch` | 3 | 5 | 1 | src/backend/database/linked-table-repository.js |
| `readFlowFile` | 3 | 5 | 1 | src/backend/biz-op-recon-import/reader.js |
| `recoverToolboxPublicationsAsync` | 3 | 5 | 1 | src/main-process/toolbox-output-publication-dispatch.js |
| `recoverToolboxPublicationsIntoArchive` | 3 | 5 | 1 | src/main-process/toolbox-archive-recovery.js |
| `recoverVccStorageMigration` | 3 | 5 | 1 | src/main-process/vcc-financial-op-storage-rebuild.js |
| `replaceAdmBankDeposit` | 3 | 5 | 1 | src/backend/database/linked-table-repository.js |
| `replaceFundTransferReconRows` | 3 | 5 | 1 | src/backend/database/linked-table-repository.js |
| `runAllScenarios` | 3 | 5 | 3 | src/main-process/reconciliation-orchestrator.js |
| `scanToolboxSplitFields` | 3 | 5 | 1 | src/main-process/toolbox-format-operations.js |
| `setEnabledModules` | 3 | 5 | 1 | src/backend/database/settings-repository.js |
| `setReconIdFixBillCategory` | 3 | 5 | 1 | src/backend/database/settings-repository.js |
| `unarchiveMonth` | 3 | 5 | 1 | src/backend/vcc-financial-op/unarchive.js |
| `writeBocFxLinkGroupRematch` | 3 | 5 | 1 | src/backend/database/linked-table-repository.js |
| `assertExpectedHead` | 3 | 4 | 1 | src/backend/biz-op-recon-db/dataset-head-repository.js |
| `assertNoPending` | 3 | 4 | 1 | src/backend/biz-op-recon-db/month-end-copy-intent-repository.js |
| `BALANCE_SEED_GENERATION_METHODS` | 3 | 4 | 1 | src/backend/balance-seed-store.js |
| `clearByDate` | 3 | 4 | 1 | src/backend/biz-op-recon-db/flow-imports-repository.js |
| `clearRunsAndDiffsByDate` | 3 | 4 | 1 | src/backend/biz-op-recon-db/run-repository.js |
| `countExportableImportAnomalies` | 3 | 4 | 1 | src/backend/vcc-financial-op-db/repository.js |
| `countRowsInMonth` | 3 | 4 | 1 | src/backend/pending-db/month-repository.js |
| `createImportBatch` | 3 | 4 | 1 | src/backend/vcc-financial-op-db/repository.js |
| `createLegacyRun` | 3 | 4 | 1 | src/backend/pending-db/diff-repository.js |
| `deleteDataTarget` | 3 | 4 | 1 | src/backend/vcc-financial-op/data-target-deletion.js |
| `findByNameAndLocation` | 3 | 4 | 1 | src/backend/database/channels-repository.js |
| `finishImportBatch` | 3 | 4 | 1 | src/backend/vcc-financial-op-db/repository.js |
| `getBuiltinGeneral` | 3 | 4 | 1 | src/backend/database/channels-repository.js |
| `importMonthAtomic` | 3 | 4 | 1 | src/backend/bank-bu-recon-db/month-repository.js |
| `isEmptyValue` | 3 | 4 | 1 | src/main-process/scenario-engines/engine-utils.js |
| `iterateChannelExports` | 3 | 4 | 1 | src/main-process/pre-fund-reconciliation/output-mapper.js |
| `listByMonth` | 3 | 4 | 1 | src/backend/pending-db/removed-repository.js |
| `listLatestRunsByMonthPair` | 3 | 4 | 1 | src/backend/pending-db/diff-repository.js |
| `listSuccessDates` | 3 | 4 | 1 | src/backend/biz-op-recon-db/run-repository.js |
| `openWorkbook` | 3 | 4 | 1 | src/backend/position-reconciliation-import/xls-reader.js |
| `readXlsxSheetMetaLite` | 3 | 4 | 2 | src/backend/file-service/readers.js |
| `runBizOpImportViaWorker` | 3 | 4 | 1 | src/main-process/biz-op-recon-session.js |
| `runFlowImportViaWorker` | 3 | 4 | 1 | src/main-process/biz-op-recon-session.js |
| `sanitizeBankName` | 3 | 4 | 3 | src/backend/balance-adjustment-store.js |
| `buildTimestampMinute` | 3 | 3 | 2 | src/main-process/bank-statement-io.js |

## A-pair — 跨 2 文件

| 名字 | 总次数 | 声明位置（首个） |
|---|---:|---|
| `VccStorageMigrationError` | 66 | src/main-process/vcc-financial-op-storage-rebuild.js |
| `activeJob` | 47 | src/main-process/run-check-worker-pool.js |
| `linkedTableRepository` | 45 | src/backend/database.js |
| `addReason` | 42 | src/backend/vcc-financial-op/archive-contract.js |
| `normalizeKey` | 38 | src/backend/database/linked-table-repository.js |
| `templateRepository` | 33 | src/backend/database.js |
| `countValue` | 31 | src/backend/vcc-financial-op/dataset-deletion.js |
| `rowValue` | 31 | src/backend/vcc-financial-op/row-mapper.js |
| `fsyncDirectory` | 29 | src/main-process/toolbox-output-publication.js |
| `tablePolicy` | 29 | src/backend/vcc-financial-op/mutation-policy.js |
| `resumeError` | 27 | src/main-process/acquiring-bill-currency-run-data.js |
| `ContractValidationError` | 25 | src/backend/big-table-import/contract.js |
| `HIT_TYPES` | 23 | src/main-process/position-reconciliation/contracts.js |
| `publicArtifact` | 22 | src/main-process/archive-center/archive-service.js |
| `isObjectRecord` | 20 | src/main-process/duplicate-inbound-match/matching-engine.js |
| `refreshBankStatementStatus` | 20 | src/renderer.js |
| `safeName` | 20 | src/main-process/archive-center/archive-service.js |
| `bankRowKey` | 19 | src/main-process/duplicate-inbound-match/matching-engine.js |
| `TEMPLATE_LABEL` | 19 | src/backend/pending-import/removed-reader.js |
| `VCC_STORAGE_CONTRACT_VERSION` | 19 | src/backend/vcc-financial-op-db/storage-contract.js |
| `BANK_FUND_TYPE_FIELD` | 18 | src/main-process/scenario-engines/dbs-charge-fund-check.js |
| `DIFF_TABLE` | 17 | src/backend/acquiring-bill-currency-db/run-repository.js |
| `directoryPathAliasKey` | 17 | src/main-process/toolbox-target-identity.js |
| `isPlainObject` | 17 | src/main-process/position-reconciliation/store.js |
| `PipelineError` | 17 | src/backend/big-table-import/engine.js |
| `selectedValues` | 17 | src/main-process/vcc-financial-op-dataset-writer.js |
| `TOOLBOX_PROJECTION_PROFILES` | 17 | src/backend/toolbox-format/model.js |
| `updateJournal` | 17 | src/main-process/vcc-financial-op-storage-rebuild.js |
| `canonicalStoredAmount` | 16 | src/backend/vcc-financial-op/result-adjustments.js |
| `ImportValidationError` | 16 | src/backend/acquiring-bill-currency-import/reader.js |
| `REMOVED_PENDING_COLUMNS` | 16 | src/backend/pending-export/writer.js |
| `storageContractVersion` | 16 | src/main-process/vcc-financial-op-storage-rebuild.js |
| `reloadReconIdFixScenarios` | 15 | src/renderer.js |
| `coordinateKey` | 14 | src/backend/vcc-financial-op/result-adjustments.js |
| `parsedJson` | 14 | src/backend/position-reconciliation-import/ledger.js |
| `requirePositionPendingArchiveFiles` | 14 | src/main-process/position-reconciliation/operation-lifecycle.js |
| `sanitizeAmountValue` | 14 | src/backend/file-service/normalizers.js |
| `toCents` | 14 | src/main-process/boc-fx-link-builder.js |
| `AUDIT_FIELDS` | 13 | src/main-process/position-reconciliation/contracts.js |
| `cellText` | 13 | src/backend/vcc-financial-op/result-template-contract.js |
| `dateIso` | 13 | src/main-process/toolbox-output-publication.js |
| `ERROR_CODE` | 13 | src/backend/pending-import/removed-reader.js |
| `normalizeAccountKey` | 13 | src/main-process/biz-op-recon-session.js |
| `normalizeLocalDate` | 13 | src/backend/database/archive-repository.js |
| `refreshTemplates` | 13 | src/renderer.js |
| `REQUIRED_DATASET_TYPES` | 13 | src/backend/vcc-financial-op/calculator.js |
| `usesModernSourceIdentity` | 13 | src/main-process/position-reconciliation/store.js |
| `zipReader` | 13 | src/backend/big-table-import/engine.js |
| `assertDatabase` | 12 | src/backend/database/archive-repository.js |
| `cleanupStagingPaths` | 12 | src/main-process/position-reconciliation/input-staging.js |
| `GATEWAY_SOURCE` | 12 | src/main-process/pre-fund-reconciliation/matching-engine.js |
| `getCurrencyOptionEntries` | 12 | src/renderer.js |
| `OPERATION_TOKEN_VERSION` | 12 | src/backend/vcc-financial-op/operation-state.js |
| `removalMatch` | 12 | src/backend/pending-export/writer.js |
| `sheetToObjects` | 12 | src/main-process/bank-statement-io.js |
| `BANK_EXTRA_FEE_FIELD` | 11 | src/main-process/scenario-engines/r4-fund-nature-check.js |
| `BIZ_OP_ACCOUNT_KEY_DB_COLUMN` | 11 | src/backend/biz-op-recon-db/columns.js |
| `deepFreeze` | 11 | src/backend/toolbox-format/style-registry.js |
| `GatewayRowValidationError` | 11 | src/main-process/pre-fund-reconciliation/matching-engine.js |
| `normalizeBorderSide` | 11 | src/backend/toolbox-format/biff8-overlay.js |
| `parseObjectJson` | 11 | src/backend/database/archive-repository.js |
| `publicBatch` | 11 | src/main-process/archive-center/archive-service.js |
| `rendererPending` | 11 | src/renderer.js |
| `TOOLBOX_XLSX_METADATA_LIMITS` | 11 | src/backend/toolbox-format/xlsx-pass.js |
| `datasetLineageIntent` | 10 | src/main-process/biz-op-archive-lineage.js |
| `DIFFERENCE_STATUSES` | 10 | src/main-process/position-reconciliation/constants.js |
| `electronUtilityProcess` | 10 | src/main-process/biz-op-recon-session.js |
| `FUND_TYPES` | 10 | src/main-process/duplicate-inbound-match/matching-engine.js |
| `getScenario` | 10 | src/backend/database/scenarios-repository.js |
| `getTemplate` | 10 | src/backend/database/template-repository.js |
| `NODE_MAX_OLD_SPACE_MB` | 10 | src/main-process/biz-op-recon-session.js |
| `normalizeRgb` | 10 | src/backend/toolbox-format/biff8-colors.js |
| `runArchiveRootOperation` | 10 | src/main-process/archive-center/archive-service.js |
| `SOURCE_TARGET_TYPES` | 10 | src/backend/vcc-financial-op/read-snapshot.js |
| `workerDbPath` | 10 | src/main-process/run-check-worker-pool.js |
| `ARCHIVE_STORAGE_ROOT_SETTING_KEY` | 9 | src/backend/database/archive-repository.js |
| `canonicalJsonValue` | 9 | src/backend/vcc-financial-op/operation-state.js |
| `channelsRepository` | 9 | src/backend/database.js |
| `cloneStyle` | 9 | src/main-process/duplicate-inbound-match/excel-writer.js |
| `hasEffectiveAmount` | 9 | src/backend/file-service/normalizers.js |
| `monthEndCopyIntents` | 9 | src/main-process/biz-op-recon-run-data.js |
| `monthRepo` | 9 | src/backend/pending-import/worker.js |
| `pkg` | 9 | src/main-process/acquiring-bill-currency-writer.js |
| `readJournal` | 9 | src/main-process/toolbox-output-publication.js |
| `readRunProgressBatchContext` | 9 | src/backend/acquiring-bill-currency-db/run-repository.js |
| `resolveIndexedColor` | 9 | src/backend/toolbox-format/biff8-colors.js |
| `RESULT_TEMPLATE_HEADERS` | 9 | src/backend/vcc-financial-op/result-template-contract.js |
| `SHEET_ENTRY_NAME` | 9 | src/backend/acquiring-bill-currency-import/reader.js |
| `SUPPORTED_CURRENCY_SET` | 9 | src/backend/vcc-financial-op/result-adjustments.js |
| `ToolboxExcelTextError` | 9 | src/backend/toolbox-format/excel-text.js |
| `ToolboxStreamEmptyError` | 9 | src/main-process/toolbox-format-operations.js |
| `ToolboxXlsxCancelledError` | 9 | src/backend/toolbox-format/xlsx-sheet-scanner.js |
| `toText` | 9 | src/main-process/duplicate-inbound-match/document-statement-reader.js |
| `uniqueSorted` | 9 | src/backend/vcc-financial-op/archive-contract.js |
| `workerScriptPath` | 9 | src/main-process/toolbox-large-split-dispatch.js |
| `ACQUIRING_BILL_CHUNK_SIZE_DEFAULT` | 8 | src/backend/database/migrations.js |
| `ACQUIRING_BILL_CHUNK_SIZE_KEY` | 8 | src/backend/database/migrations.js |
| `ACQUIRING_BILL_IDLE_CLEANUP_MINUTES_DEFAULT` | 8 | src/backend/database/migrations.js |
| `ACQUIRING_BILL_IDLE_CLEANUP_MINUTES_KEY` | 8 | src/backend/database/migrations.js |
| `ACQUIRING_BILL_RAW_JSON_RETENTION_DAYS_DEFAULT` | 8 | src/backend/database/migrations.js |
| `ACQUIRING_BILL_RAW_JSON_RETENTION_DAYS_KEY` | 8 | src/backend/database/migrations.js |
| `atomicWriteJson` | 8 | src/main-process/archive-center/storage-root-manager.js |
| `BankRowValidationError` | 8 | src/main-process/pre-fund-reconciliation/bank-row.js |
| `canonicalAmount` | 8 | src/main-process/position-reconciliation/decimal.js |
| `currencyMatches` | 8 | src/main-process/scenario-engines/c4-recon-id-fix.js |
| `DETAIL_META_HEADERS` | 8 | src/backend/position-reconciliation-import/anomaly-report.js |
| `DUPLICATE_FOLD_REASON` | 8 | src/backend/pre-fund-reconciliation-run-store.js |
| `freezePlan` | 8 | src/backend/vcc-financial-op/destructive-write.js |
| `outboxBatchId` | 8 | src/main-process/archive-center/outbox-store.js |
| `PENDING_HASH_VERSION` | 8 | src/backend/vcc-financial-op/row-mapper.js |
| `pendingImportError` | 8 | src/main-process/pending-import-preflight.js |
| `readPositionSourceSummary` | 8 | src/main-process/position-reconciliation/source-summary-cache.js |
| `recordRowError` | 8 | src/backend/biz-op-recon-import/import-worker.js |
| `saxAttributeValue` | 8 | src/backend/toolbox-format/ooxml-namespaces.js |
| `setNewAccountStatus` | 8 | src/renderer.js |
| `SHARED_STRINGS_ENTRY` | 8 | src/backend/toolbox-xlsx-stream/large-split-worker.js |
| `SOURCE_TYPE_OUTBOUND` | 8 | src/main-process/pre-fund-reconciliation/mpt-schema.js |
| `THEME_COLOR_NAMES` | 8 | src/backend/toolbox-format/biff8-colors.js |
| `toIsoDate` | 8 | src/main-process/boc-fx-link-builder.js |
| `TOOLBOX_MAX_COL_COUNT` | 8 | src/backend/toolbox-xlsx-stream/multi-sheet-reader.js |
| `VCC_TABLE_POLICY_REGISTRY` | 8 | src/backend/vcc-financial-op/mutation-policy.js |
| `wrapReadError` | 8 | src/backend/biz-op-recon-import/reader-streamed.js |
| `ACQUIRING_BILL_WORKER_COUNT_DEFAULT` | 7 | src/backend/database/migrations.js |
| `ACQUIRING_BILL_WORKER_COUNT_KEY` | 7 | src/backend/database/migrations.js |
| `ALL_MODULE_IDS` | 7 | src/backend/database/settings-repository.js |
| `ANOMALY_HEADERS` | 7 | src/main-process/bank-bu-recon-writer.js |
| `applyManualBalancePromptStatus` | 7 | src/renderer.js |
| `applyTint` | 7 | src/backend/toolbox-format/biff8-colors.js |
| `archiveStorageRootManager` | 7 | src/main.js |
| `bankStatementSession` | 7 | src/main.js |
| `buildChannelFileName` | 7 | src/main-process/pre-fund-reconciliation/excel-writer.js |
| `BUILTIN_NUMBER_FORMATS` | 7 | src/backend/toolbox-format/biff8-records.js |
| `CHECK_EXPORT_DEFINITIONS` | 7 | src/main-process/vcc-financial-op-dataset-writer.js |
| `clearImportStagingRows` | 7 | src/backend/vcc-financial-op-db/repository.js |
| `createBackup` | 7 | src/backend/database/backup.js |
| `CURRENT_DATASET_TYPES` | 7 | src/backend/vcc-financial-op/archive-contract.js |
| `decimalComparable` | 7 | src/backend/toolbox-format/number-date.js |
| `DEFAULT_RETENTION_DAYS` | 7 | src/main-process/archive-center/archive-service.js |
| `DEFAULT_WORKER_ENTRY` | 7 | src/main-process/toolbox-large-split-dispatch.js |
| `DELETABLE_IMPORT_STATUSES` | 7 | src/backend/vcc-financial-op/dataset-deletion.js |
| `EXCEL_ST_XSTRING_MAX_RAW_UTF16_UNITS` | 7 | src/backend/toolbox-format/excel-text.js |
| `FLOW_COLUMN_DEFS` | 7 | src/backend/biz-op-recon-db/columns.js |
| `flowImportsRepository` | 7 | src/backend/biz-op-recon-import/import-worker.js |
| `getNewAccountStatusTitle` | 7 | src/renderer.js |
| `IMPORT_CANCELLED_CODE` | 7 | src/backend/vcc-financial-op/detail-importer.js |
| `loadArchiveEvidenceSet` | 7 | src/backend/vcc-financial-op/read-snapshot.js |
| `mapMirror` | 7 | src/backend/database/duplicate-inbound-match-run-repository.js |
| `normalizeBatchSize` | 7 | src/backend/position-reconciliation-import/maintenance-writer.js |
| `normalizeMonth` | 7 | src/backend/vcc-financial-op/destructive-write.js |
| `OLE_CFB_MAGIC` | 7 | src/backend/toolbox-format/biff8-overlay.js |
| `PAIR_BY_FUND_TYPE` | 7 | src/main-process/position-reconciliation/contracts.js |
| `persistStagingAnomalies` | 7 | src/backend/vcc-financial-op-db/repository.js |
| `POSITION_DB_CHECKPOINT_TOKEN_KEY` | 7 | src/main-process/position-reconciliation/side-db-mutation.js |
| `POSITION_DB_GENERATION_KEY` | 7 | src/main-process/position-reconciliation/side-db-mutation.js |
| `POSITION_IMPORT_LEDGER_SCHEMA_VERSION` | 7 | src/backend/position-reconciliation-import/constants.js |
| `POSITION_IMPORT_MAINTENANCE_BATCH_SIZE` | 7 | src/backend/position-reconciliation-import/constants.js |
| `preflightCalculation` | 7 | src/backend/vcc-financial-op/calculator.js |
| `PREVIEW_MEANINGFUL_ROWS` | 7 | src/backend/vcc-financial-op/workbook-reader.js |
| `RECON_RESULT_FIELDS_GATEWAY` | 7 | src/constants/gateway-bill-recon-fields.js |
| `recoverInterruptedImports` | 7 | src/backend/vcc-financial-op-db/repository.js |
| `resolveManagedRelative` | 7 | src/main-process/archive-center/storage-materializer.js |
| `RESULT_TEMPLATE_SHEET_NAME` | 7 | src/backend/vcc-financial-op/result-template-contract.js |
| `roundAmount` | 7 | src/backend/file-service/normalizers.js |
| `runRowIntegrityHash` | 7 | src/main-process/position-reconciliation/store.js |
| `setNewAccountExportAvailability` | 7 | src/renderer.js |
| `STORAGE_LAYOUT_VERSION` | 7 | src/main-process/archive-center/storage-layout.js |
| `syncNewAccountCurrencyMode` | 7 | src/renderer.js |
| `targetState` | 7 | src/main-process/toolbox-output-publication.js |
| `VALID_CATEGORIES` | 7 | src/backend/database/scenarios-repository.js |
| `validateElementCase` | 7 | src/backend/toolbox-format/style-registry.js |
| `WORKSHEET_ENTRY_RE` | 7 | src/backend/pending-import/xlsx-size-preflight.js |
| `__missingBankColumns` | 6 | src/constants/payment-offline-allocation-fields.js |
| `absoluteAmount` | 6 | src/main-process/position-reconciliation/decimal.js |
| `addCalendarDays` | 6 | src/backend/database/archive-repository.js |
| `addFileFailureAnomaly` | 6 | src/backend/vcc-financial-op-db/repository.js |
| `addImportAnomaly` | 6 | src/backend/vcc-financial-op-db/repository.js |
| `assertEmptyVccStorageForUpgrade` | 6 | src/backend/vcc-financial-op-db/storage-contract.js |
| `assertFilePlanFresh` | 6 | src/main-process/archive-center/file-plan.js |
| `BANK_DEPOSIT_FIELDS` | 6 | src/backend/database/linked-table-repository.js |
| `BANK_DIFF_FIELD_DB_COLUMN` | 6 | src/backend/bank-bu-recon-db/columns.js |
| `BIZ_OP_MODULE_ID` | 6 | src/main-process/biz-op-archive-lineage.js |
| `bizOpRowToArray` | 6 | src/backend/biz-op-recon-db/columns.js |
| `BOC_BANK_FILTER` | 6 | src/constants/boc-fx-link-fields.js |
| `buildBankMatchCriteria` | 6 | src/main-process/pre-fund-reconciliation/matching-engine.js |
| `buildFileReader` | 6 | src/backend/bank-bu-recon-import/reader.js |
| `buildInfo` | 6 | src/main-process/acquiring-bill-currency-writer.js |
| `buildTemplateSummaryFromRow` | 6 | src/backend/database/utils.js |
| `cellReference` | 6 | src/backend/toolbox-format/model.js |
| `CLEANUP_TEMPLATE_HEADERS` | 6 | src/constants/platform-cleanup-template-fields.js |
| `deletePreviewForTarget` | 6 | src/backend/vcc-financial-op/read-snapshot.js |
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
| `ensureC3GwFieldCurrencyCaseRevert` | 6 | src/backend/database/migrations.js |
| `ensureChannelEnumSupport` | 6 | src/backend/database/migrations.js |
| `ensureDbsChargeFundCheckScenarioSeed` | 6 | src/backend/database/migrations.js |
| `ensureDiffRowsCascadeMigration_v2_1_10` | 6 | src/backend/database/migrations.js |
| `ensureDuplicateInboundMatchRunMetadataSupport` | 6 | src/backend/database/migrations.js |
| `ensureFundTransferAccountMappingSupport` | 6 | src/backend/database/migrations.js |
| `ensureFundTransferBackfillCanonicalOwner` | 6 | src/backend/database/migrations.js |
| `ensureFundTransferReconSupport` | 6 | src/backend/database/migrations.js |
| `ensureFundTypeAchReturnConfigMigration` | 6 | src/backend/database/migrations.js |
| `ensureJpmDispatchOrderScenarioSeed` | 6 | src/backend/database/migrations.js |
| `ensureLinkedTableSupport` | 6 | src/backend/database/migrations.js |
| `ensureParentTemplateSupport` | 6 | src/backend/database/migrations.js |
| `ensurePreFundReconciliationRunMetadataSupport` | 6 | src/backend/database/migrations.js |
| `ensureR4DirectionGuardConfigMigration` | 6 | src/backend/database/migrations.js |
| `ensureR4StrictDescriptionMigration` | 6 | src/backend/database/migrations.js |
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
| `excelValueForHeader` | 6 | src/backend/position-reconciliation-import/anomaly-report.js |
| `FILENAME_MAPPING_TEMPLATE_ID` | 6 | src/main.js |
| `fsyncFile` | 6 | src/main-process/toolbox-output-publication.js |
| `FX_DELIVERY_SIGNATURE` | 6 | src/constants/boc-fx-link-fields.js |
| `GatewayPoolEmptyError` | 6 | src/main-process/pre-fund-reconciliation/matching-engine.js |
| `gatewayTagKey` | 6 | src/main-process/pre-fund-archive-lineage.js |
| `getCurrencyOptionLabel` | 6 | src/renderer.js |
| `getVccStorageContractVersion` | 6 | src/backend/vcc-financial-op-db/storage-contract.js |
| `gwAmountAbs` | 6 | src/main-process/scenario-engines/many-to-many-detector.js |
| `handleControlMessage` | 6 | src/backend/vcc-financial-op/worker-entry.js |
| `hashSourceFile` | 6 | src/backend/vcc-financial-op/source-lineage.js |
| `headerValues` | 6 | src/main-process/pre-fund-reconciliation/excel-writer.js |
| `initWorkerDb` | 6 | src/main-process/run-check-multiworker-worker.js |
| `INSERT_SQL` | 6 | src/backend/biz-op-recon-db/flow-imports-repository.js |
| `inspectDatasetDeletion` | 6 | src/backend/vcc-financial-op/dataset-deletion.js |
| `INSTALL_BUSY_MESSAGE` | 6 | src/main-process/business-operation-registry.js |
| `installVccStorageWriteGuards` | 6 | src/backend/vcc-financial-op-db/storage-contract.js |
| `isLeapYear` | 6 | src/backend/toolbox-format/number-date.js |
| `isLegacyPendingHeaders` | 6 | src/backend/vcc-financial-op/definitions.js |
| `listImportedDateBuPairs` | 6 | src/backend/biz-op-recon-db/imports-repository.js |
| `listPositionCommittedOperationInputs` | 6 | src/main-process/position-reconciliation/side-db-mutation.js |
| `loadDeleteEvidenceV2` | 6 | src/backend/vcc-financial-op/read-snapshot.js |
| `localDateOf` | 6 | src/backend/database/archive-repository.js |
| `localMonthKey` | 6 | src/main-process/duplicate-inbound-match/service.js |
| `mapBalancedRow` | 6 | src/main-process/pre-fund-reconciliation/output-mapper.js |
| `mapChannelBillRow` | 6 | src/main-process/pre-fund-reconciliation/output-mapper.js |
| `mapUnbalancedRow` | 6 | src/main-process/pre-fund-reconciliation/output-mapper.js |
| `matchAmountSplitConditionValue` | 6 | src/backend/file-service/normalizers.js |
| `migrateC4ReconGroupsAmountLockedFieldPair` | 6 | src/backend/database/migrations.js |
| `migrateC4ReconGroupsStructure` | 6 | src/backend/database/migrations.js |
| `migrateGatewayReconIdFixFieldPairs` | 6 | src/backend/database/migrations.js |
| `MODULE_BIZ_OP` | 6 | src/backend/run-data-store.js |
| `MODULE_PRE_FUND_RECONCILIATION` | 6 | src/backend/run-data-store.js |
| `monthOfDate` | 6 | src/backend/vcc-financial-op/row-mapper.js |
| `normalizedAttributes` | 6 | src/backend/toolbox-format/style-registry.js |
| `normalizeFill` | 6 | src/backend/toolbox-format/biff8-overlay.js |
| `normalizeFont` | 6 | src/backend/toolbox-format/biff8-overlay.js |
| `normalizeGatewayCandidate` | 6 | src/main-process/pre-fund-reconciliation/matching-engine.js |
| `normalizeImportBatchId` | 6 | src/backend/vcc-financial-op/import-service.js |
| `normalizeStagingBatchId` | 6 | src/main-process/position-reconciliation/input-staging.js |
| `openVccWriteDatabase` | 6 | src/backend/vcc-financial-op/result-write.js |
| `parseCellType` | 6 | src/backend/big-table-import/row-scanner.js |
| `parsePositionPendingArchiveFiles` | 6 | src/main-process/position-reconciliation/operation-lifecycle.js |
| `parseThemeColors` | 6 | src/backend/toolbox-format/biff8-overlay.js |
| `PART_TABLE` | 6 | src/main-process/run-check-multiworker-worker.js |
| `PENDING_DIFF_FIELD_DB_COLUMN` | 6 | src/backend/bank-bu-recon-db/columns.js |
| `pendingHeaderMismatchDetails` | 6 | src/backend/vcc-financial-op/pending-template-contract.js |
| `POSITION_DB_IDENTITY_KEY` | 6 | src/main-process/position-reconciliation/side-db-mutation.js |
| `POSITION_IMPORT_STREAMING_SOURCE_ALLOWLIST` | 6 | src/backend/position-reconciliation-import/constants.js |
| `PositionImportLedger` | 6 | src/backend/position-reconciliation-import/ledger.js |
| `readSystemOpSnapshotCandidates` | 6 | src/backend/vcc-financial-op/system-op-importer.js |
| `reconAmount` | 6 | src/main-process/scenario-engines/r5-payment-offline-allocation-backfill.js |
| `REFUND_RO_COLUMNS` | 6 | src/constants/refund-backfill-fields.js |
| `removedRepo` | 6 | src/backend/pending-export/writer.js |
| `RESULT_TEMPLATE_FILE_NAME` | 6 | src/backend/vcc-financial-op/result-template-contract.js |
| `retireChargeOutboundOrphans` | 6 | src/backend/database/migrations.js |
| `runC1Scenario` | 6 | src/main-process/scenario-engines/c1-extract-recon-id.js |
| `runReconciliationCore` | 6 | src/backend/pending-reconcile/engine.js |
| `signedDayDiff` | 6 | src/main-process/scenario-engines/engine-date-utils.js |
| `snapshotsEqual` | 6 | src/main-process/position-reconciliation/import-recovery.js |
| `splitSignedAmountValue` | 6 | src/backend/file-service/normalizers.js |
| `stageInputFiles` | 6 | src/main-process/position-reconciliation/input-staging.js |
| `STRICT_YEAR_MONTH_PATTERN` | 6 | src/backend/vcc-financial-op-db/state-model.js |
| `SUPPORTED_SCENARIO_BUNDLE_VERSION` | 6 | src/backend/scenarios-bundle-io.js |
| `validatedResultDigest` | 6 | src/backend/vcc-financial-op/operation-token-v2.js |
| `validateName` | 6 | src/backend/database/channels-repository.js |
| `VCC_BILL_DATE_DB_COLUMN` | 6 | src/backend/vcc-op-calc-db/columns.js |
| `VCC_DIRECTION_DB_COLUMN` | 6 | src/backend/vcc-op-calc-db/columns.js |
| `VCC_STORAGE_GUARD_TRIGGER_PREFIX` | 6 | src/backend/vcc-financial-op-db/storage-contract.js |
| `verifyAnomalyReportFile` | 6 | src/main-process/position-reconciliation/filtered-source-report.js |
| `WORKER_SCRIPT` | 6 | src/main-process/biz-op-recon-session.js |
| `workerScriptOverride` | 6 | src/main-process/run-check-multiworker.js |
| `WRITER_OUTPUT_HEADERS_V2` | 6 | src/backend/acquiring-bill-currency-db/columns.js |
| `ZHONGTAI_DISPATCH_ORDER_SIGNATURE` | 6 | src/constants/fund-transfer-recon-fields.js |
| `assertSourceStatsMatch` | 5 | src/backend/position-reconciliation-import/source-writer.js |
| `AsyncLocalStorage` | 5 | src/main-process/archive-center/task-lifecycle.js |
| `BALANCED_HEADERS` | 5 | src/main-process/pre-fund-reconciliation/output-mapper.js |
| `BANK_CURRENCY_FIELD` | 5 | src/main-process/scenario-engines/dbs-charge-fund-check.js |
| `BANK_DIRECTION_FIELDS` | 5 | src/main-process/scenario-engines/bank-direction-validator.js |
| `BANK_STATEMENT_SHEET_NAME` | 5 | src/main-process/bank-statement-io.js |
| `bankContext` | 5 | src/main-process/pre-fund-reconciliation/service.js |
| `Biff8RecordError` | 5 | src/backend/toolbox-format/biff8-records.js |
| `BILL_INSERT_SQL` | 5 | src/backend/acquiring-bill-currency-db/import-repository.js |
| `BIZ_OP_END_BALANCE_DB_COLUMN` | 5 | src/backend/biz-op-recon-db/columns.js |
| `BOC_PAYMENT_DETAIL_KEYWORD` | 5 | src/constants/boc-fx-link-fields.js |
| `buildDefaultFileName` | 5 | src/main-process/duplicate-inbound-match/excel-writer.js |
| `buildFeatureRegex` | 5 | src/main-process/scenario-engines/c1-extract-recon-id.js |
| `buildGatewayFingerprint` | 5 | src/main-process/pre-fund-reconciliation/matching-engine.js |
| `buildResultMutationTokenV2` | 5 | src/backend/vcc-financial-op/operation-token-v2.js |
| `buildRowMapper` | 5 | src/backend/bank-bu-recon-import/reader.js |
| `CHANNEL_BILL_HEADERS` | 5 | src/main-process/pre-fund-reconciliation/output-mapper.js |
| `checkpointValue` | 5 | src/main-process/position-reconciliation/side-db-mutation.js |
| `cleanupStagingPathsAsync` | 5 | src/main-process/position-reconciliation/input-staging.js |
| `COLUMN_WIDTHS` | 5 | src/backend/position-reconciliation-import/anomaly-report.js |
| `createBiff8GridResolver` | 5 | src/backend/toolbox-format/biff8-overlay.js |
| `createInvalidExtraFeeWarning` | 5 | src/main-process/scenario-engines/r5-fund-transfer-backfill.js |
| `createMigrationJournal` | 5 | src/main-process/vcc-financial-op-storage-rebuild.js |
| `createSheet` | 5 | src/main-process/pre-fund-reconciliation/mpt-error-report-writer.js |
| `createSlimEffectiveRowsTable` | 5 | src/backend/vcc-financial-op-db/storage-contract.js |
| `DEFAULT_BUILTIN_FORMATS` | 5 | src/backend/toolbox-format/biff8-records.js |
| `deserializeFromMessage` | 5 | src/main-process/run-check-multiworker.js |
| `DIFF_HEADER_TAIL` | 5 | src/backend/biz-op-recon-db/columns.js |
| `DIFF_OUTPUT_BANK_SHEET` | 5 | src/backend/bank-bu-recon-db/columns.js |
| `DIFF_OUTPUT_PENDING_SHEET` | 5 | src/backend/bank-bu-recon-db/columns.js |
| `dispatchPositionImportPreflight` | 5 | src/main-process/position-reconciliation/import-dispatch.js |
| `ENGINE_WORKER_ENTRY` | 5 | src/main-process/acquiring-bill-currency-session.js |
| `ERROR_HEADER_TAIL` | 5 | src/backend/biz-op-recon-db/columns.js |
| `freezeGatewayTags` | 5 | src/main-process/pre-fund-archive-lineage.js |
| `freezeImportArchiveHandoffFiles` | 5 | src/backend/vcc-financial-op/import-service.js |
| `gatewayReconSession` | 5 | src/main.js |
| `getArchivedRunByMonth` | 5 | src/backend/vcc-financial-op/unarchive.js |
| `getBillSplitAmountRules` | 5 | src/backend/database/template-repository.js |
| `getBillSplitMappings` | 5 | src/backend/database/template-repository.js |
| `getBillSplitMeta` | 5 | src/backend/database/template-repository.js |
| `getBillSplitRows` | 5 | src/backend/database/template-repository.js |
| `getByTaskRunId` | 5 | src/backend/biz-op-recon-db/month-end-copy-intent-repository.js |
| `getMonthHead` | 5 | src/backend/pending-db/removed-repository.js |
| `getStatusDualSource` | 5 | src/main-process/bank-bu-recon-run-data.js |
| `getTemplateMappings` | 5 | src/backend/database/template-repository.js |
| `GW_TRADE_TYPE_FIELD` | 5 | src/main-process/scenario-engines/dbs-charge-fund-check.js |
| `hashFile` | 5 | src/main-process/archive-center/storage-materializer.js |
| `hashSourceFileSync` | 5 | src/backend/vcc-financial-op/source-lineage.js |
| `hasInvalidExtraFee` | 5 | src/main-process/scenario-engines/r5-fund-transfer-backfill.js |
| `importDetailGroup` | 5 | src/backend/vcc-financial-op/detail-importer.js |
| `INBOUND_FIELDS` | 5 | src/main-process/pre-fund-reconciliation/mpt-schema.js |
| `inspectDatasetExport` | 5 | src/main-process/vcc-financial-op-dataset-writer.js |
| `isUnsafeAuditError` | 5 | src/backend/vcc-financial-op/result-write.js |
| `iterateDuplicateAuditRows` | 5 | src/main-process/pre-fund-reconciliation/output-mapper.js |
| `LARGE_TABLE_SCOPE_PROOF_SET` | 5 | src/backend/vcc-financial-op/mutation-guard.js |
| `LARGE_TABLE_SCOPE_PROOF_TABLES` | 5 | src/backend/vcc-financial-op/mutation-policy.js |
| `LEGACY_DATASET_TYPES` | 5 | src/backend/vcc-financial-op/archive-contract.js |
| `listImportedDates` | 5 | src/backend/biz-op-recon-db/flow-imports-repository.js |
| `listMonthsDualSource` | 5 | src/main-process/acquiring-bill-currency-run-data.js |
| `listRunsByDateBu` | 5 | src/backend/biz-op-recon-db/run-repository.js |
| `loadResultMutationEvidence` | 5 | src/backend/vcc-financial-op/read-snapshot.js |
| `loadToolboxSharedStrings` | 5 | src/backend/toolbox-format/xlsx-pass.js |
| `loadUnarchiveGateEvidence` | 5 | src/backend/vcc-financial-op/read-snapshot.js |
| `MAINTENANCE_COMMANDS` | 5 | src/backend/position-reconciliation-import/maintenance-writer.js |
| `makeInvalidExtraFeeWarningDeduper` | 5 | src/main-process/scenario-engines/r5-fund-transfer-backfill.js |
| `MODULE_ACQUIRING` | 5 | src/backend/run-data-store.js |
| `MODULE_BANK_BU` | 5 | src/backend/run-data-store.js |
| `MODULE_DUPLICATE_INBOUND_MATCH` | 5 | src/backend/run-data-store.js |
| `moveFileNoClobber` | 5 | src/main-process/pre-fund-reconciliation/excel-writer.js |
| `MUTATION_SQL_STEP_REGISTRY` | 5 | src/backend/vcc-financial-op/mutation-policy.js |
| `normalizeAdjustmentAmount` | 5 | src/backend/vcc-financial-op/result-adjustments.js |
| `normalizeAdjustmentReason` | 5 | src/backend/vcc-financial-op/result-adjustments.js |
| `normalizeAlignment` | 5 | src/backend/toolbox-format/biff8-overlay.js |
| `normalizeLineageIntentsV1` | 5 | src/main-process/archive-center/task-lifecycle.js |
| `normalizeTargetAliasKey` | 5 | src/main-process/toolbox-target-identity.js |
| `openPositionWorkbook` | 5 | src/backend/position-reconciliation-import/xlsx-reader.js |
| `OUTBOUND_FIELDS` | 5 | src/main-process/pre-fund-reconciliation/mpt-schema.js |
| `OutputStyleRegistry` | 5 | src/backend/toolbox-format/style-registry.js |
| `parseAmountAbs` | 5 | src/backend/acquiring-bill-currency-db/import-repository.js |
| `parseOoxmlWallClock` | 5 | src/backend/toolbox-format/number-date.js |
| `peekImportTarget` | 5 | src/main-process/acquiring-bill-currency-run-data.js |
| `PENDING_INSERT_SQL` | 5 | src/backend/bank-bu-recon-db/month-repository.js |
| `pendingContentHash` | 5 | src/backend/vcc-financial-op/row-mapper.js |
| `pendingHeaderCandidate` | 5 | src/backend/vcc-financial-op/pending-template-contract.js |
| `pendingMonthEvidenceValue` | 5 | src/main-process/pending-import-preflight.js |
| `pendingSession` | 5 | src/main.js |
| `persistRolledBackAuditSafely` | 5 | src/backend/vcc-financial-op/result-write.js |
| `POSITION_IMPORT_MAX_ERROR_DETAILS` | 5 | src/backend/position-reconciliation-import/constants.js |
| `POSITION_RULESET_VERSION` | 5 | src/main-process/position-reconciliation/constants.js |
| `POSITION_SOURCE_SUMMARY_SCHEMA` | 5 | src/main-process/position-reconciliation/source-summary-cache.js |
| `positionRecoveryTerminalOutcome` | 5 | src/main-process/position-reconciliation/operation-lifecycle.js |
| `PRE_SWITCH_PHASES` | 5 | src/main-process/archive-center/storage-root-manager.js |
| `preflightRequiredResult` | 5 | src/backend/vcc-financial-op/calculator.js |
| `previousDate` | 5 | src/main-process/biz-op-archive-lineage.js |
| `PROGRESS_INTERVAL` | 5 | src/backend/vcc-op-calc-import/reader.js |
| `projectOutputCell` | 5 | src/backend/toolbox-format/model.js |
| `readPendingMonthEvidence` | 5 | src/main-process/pending-import-preflight.js |
| `reconAmountAbs` | 5 | src/main-process/scenario-engines/many-to-many-detector.js |
| `reconcileVccImportArchiveLineage` | 5 | src/main-process/vcc-financial-op-archive-lineage.js |
| `reconIdFixSession` | 5 | src/main.js |
| `redactedFailure` | 5 | src/backend/vcc-financial-op/result-write.js |
| `REPORT_ARTIFACT_KEY` | 5 | src/backend/position-reconciliation-import/anomaly-report.js |
| `resolveOperationInputPaths` | 5 | src/main-process/archive-center/operation-tracker.js |
| `ROUND_LABELS` | 5 | src/main-process/reconciliation-orchestrator.js |
| `runC2Scenario` | 5 | src/main-process/scenario-engines/c2-offset-bill-mark.js |
| `runC3Scenario` | 5 | src/main-process/scenario-engines/c3-gateway-recon-join.js |
| `runScenario` | 5 | src/main-process/scenario-dispatcher.js |
| `setExportAvailability` | 5 | src/renderer.js |
| `setNewAccountOpenDateValue` | 5 | src/renderer.js |
| `setVccStorageContractVersion` | 5 | src/backend/vcc-financial-op-db/storage-contract.js |
| `SIDE_DB_DDL_BIZ_OP` | 5 | src/backend/run-data-store.js |
| `SIDE_DB_DDL_PRE_FUND_RUNS` | 5 | src/backend/run-data-store.js |
| `sideDbFileName` | 5 | src/backend/run-data-store.js |
| `SOURCE_DISPLAY_ORDER` | 5 | src/main-process/position-reconciliation/constants.js |
| `SOURCE_FILTER_CODES` | 5 | src/main-process/position-reconciliation/constants.js |
| `SOURCE_TYPE_BY_FUND_TYPE` | 5 | src/main-process/position-reconciliation/constants.js |
| `splitUtf16Safe` | 5 | src/main-process/pre-fund-reconciliation/mpt-error-report-writer.js |
| `statementImportSessions` | 5 | src/main.js |
| `storedRecordResult` | 5 | src/backend/vcc-financial-op/import-service.js |
| `streamBizOpFile` | 5 | src/backend/biz-op-recon-import/import-worker.js |
| `systemHeaderCandidate` | 5 | src/backend/vcc-financial-op/workbook-reader.js |
| `systemHeaderMismatchDetails` | 5 | src/backend/vcc-financial-op/workbook-reader.js |
| `TASK_FILE_PLAN_DEFINITIONS` | 5 | src/main-process/archive-center/task-file-plan-registry.js |
| `TEMPLATE_BILL_KEY_INDICES` | 5 | src/backend/acquiring-bill-currency-db/import-repository.js |
| `TERMINAL_TASK_STATUSES` | 5 | src/main-process/archive-center/controller.js |
| `toolboxRecoveryOutputFiles` | 5 | src/main-process/toolbox-archive-recovery.js |
| `ToolboxSheetReadError` | 5 | src/backend/toolbox-xlsx-stream/multi-sheet-reader.js |
| `ToolboxSplitFieldNotFoundError` | 5 | src/main-process/toolbox-format-operations.js |
| `UNBALANCED_HEADERS` | 5 | src/main-process/pre-fund-reconciliation/output-mapper.js |
| `unwrapBankEntry` | 5 | src/main-process/duplicate-inbound-match/matching-engine.js |
| `updateNewAccountGenerateAvailability` | 5 | src/renderer.js |
| `validateDirection` | 5 | src/main-process/position-reconciliation/decimal.js |
| `valuesFromToolboxRow` | 5 | src/backend/position-reconciliation-import/xlsx-reader.js |
| `VCC_CURRENCY_DB_COLUMN` | 5 | src/backend/vcc-op-calc-db/columns.js |
| `VCC_RECON_AMOUNT_DB_COLUMN` | 5 | src/backend/vcc-op-calc-db/columns.js |
| `vccStorageGuardTriggerDefinition` | 5 | src/backend/vcc-financial-op-db/storage-contract.js |
| `writeResultWorkbook` | 5 | src/main-process/position-reconciliation/excel-io.js |
| `ZHONGTAI_REFUND_ORDER_SIGNATURE` | 5 | src/constants/refund-backfill-fields.js |
| `__reconCols` | 4 | src/constants/fund-transfer-recon-fields.js |
| `acknowledgePendingRunByTaskRun` | 4 | src/main-process/pending-archive-lineage.js |
| `ADJUSTMENT_LINEAGE_NAME_PREFIX` | 4 | src/backend/vcc-financial-op/adjustment-lineage.js |
| `ADM_EXTRA_FIELDS` | 4 | src/constants/adm-bank-deposit-fields.js |
| `ADM_FUND_TYPES` | 4 | src/constants/adm-bank-deposit-fields.js |
| `ADM_MERCHANT_ID` | 4 | src/backend/database/migrations.js |
| `applyApplicableChannelIdsInTx` | 4 | src/backend/database/scenarios-repository.js |
| `applyPositionAccountSnapshot` | 4 | src/backend/position-reconciliation-import/account-writer.js |
| `applyPositionBankBatch` | 4 | src/backend/position-reconciliation-import/bank-writer.js |
| `applyPositionOrdinarySourceFiles` | 4 | src/backend/position-reconciliation-import/source-writer.js |
| `APPROVED_VCC_TRIGGERS` | 4 | src/backend/vcc-financial-op/mutation-policy.js |
| `assertBiff8OverlayMatchesProjection` | 4 | src/backend/toolbox-format/biff8-overlay.js |
| `assertBizOpMonthEndAdmission` | 4 | src/main-process/biz-op-recon-session.js |
| `assertNoPendingMonthEndCopy` | 4 | src/main-process/biz-op-recon-session.js |
| `atomicSwitchVccStorage` | 4 | src/main-process/vcc-financial-op-storage-rebuild.js |
| `balanceSeedRecordsEvidence` | 4 | src/main-process/manual-balance-seed-preflight.js |
| `BANK_DEPOSIT_SIGNATURE` | 4 | src/constants/table-signatures.js |
| `BANK_IDENTIFIER_FIELDS` | 4 | src/main-process/position-reconciliation/contracts.js |
| `BANK_MATCH_KEY_DB_COLUMN` | 4 | src/backend/bank-bu-recon-db/columns.js |
| `BANK_MERCHANT_ID_FIELD` | 4 | src/main-process/scenario-engines/dbs-charge-fund-check.js |
| `bankAmountEqualWithoutExtraFee` | 4 | src/main-process/scenario-engines/r5-fund-transfer-backfill.js |
| `BankStatementMergeError` | 4 | src/main-process/bank-statement-merge.js |
| `baseMappedRow` | 4 | src/backend/vcc-financial-op/row-mapper.js |
| `BIZ_OP_RUN_TASK_KEY` | 4 | src/main-process/biz-op-archive-lineage.js |
| `bizOpRunLineagePlan` | 4 | src/main-process/biz-op-archive-lineage.js |
| `BOC_CHANNEL_NAME` | 4 | src/constants/boc-dispatch-order-fields.js |
| `BOC_CHANNEL_VALUE` | 4 | src/constants/boc-fx-link-fields.js |
| `buildArchiveEvidenceV2` | 4 | src/backend/vcc-financial-op/archive-evidence.js |
| `buildDuplicateInboundGroups` | 4 | src/main-process/duplicate-inbound-match/matching-engine.js |
| `buildFailureAuditPlan` | 4 | src/backend/vcc-financial-op/destructive-write.js |
| `buildLogicalAccounts` | 4 | src/main-process/position-reconciliation/logical-accounts.js |
| `buildMappedRows` | 4 | src/backend/file-service.js |
| `buildOriginalBaseName` | 4 | src/main-process/scenario-hit-rows-writer.js |
| `buildVccStorageCandidate` | 4 | src/main-process/vcc-financial-op-storage-rebuild.js |
| `BUSINESS_BILL_SHEET_NAME` | 4 | src/constants/recon-id-fix-fields.js |
| `C4_CATEGORIES` | 4 | src/main-process/scenario-dispatcher.js |
| `calculateMonth` | 4 | src/backend/vcc-financial-op/calculator.js |
| `cancelError` | 4 | src/backend/position-reconciliation-import/maintenance-writer.js |
| `CHANNEL_BILL_SHEET_NAME` | 4 | src/constants/gateway-bill-recon-fields.js |
| `claimVccFinancialOpFirstMonth` | 4 | src/backend/vcc-financial-op-db/repository.js |
| `CLEANUP_COPY_HEADERS` | 4 | src/constants/platform-cleanup-template-fields.js |
| `clearBankDepositHitMarkersByBizIds` | 4 | src/backend/database/linked-table-repository.js |
| `clearDiffRowsByRunId` | 4 | src/backend/acquiring-bill-currency-db/run-repository.js |
| `closeAllNewAccountCurrencyDropdowns` | 4 | src/renderer.js |
| `closeWorkbookOutputStream` | 4 | src/main-process/toolbox-output-writer.js |
| `compareFileSequences` | 4 | src/main-process/pre-fund-reconciliation/mpt-schema.js |
| `computeAmounts` | 4 | src/main-process/vcc-op-calc-session.js |
| `copyVerifiedAnomalyReport` | 4 | src/main-process/position-reconciliation/filtered-source-report.js |
| `countBankDepositByDateRange` | 4 | src/backend/database/linked-table-repository.js |
| `countByMonth` | 4 | src/backend/pending-db/removed-repository.js |
| `countFxByDateRange` | 4 | src/backend/database/linked-table-repository.js |
| `countGatewayBillByDateRange` | 4 | src/backend/database/linked-table-repository.js |
| `countSignificantDigitsFromString` | 4 | src/backend/file-service/writers.js |
| `createBankBuReconSession` | 4 | src/main-process/bank-bu-recon-session.js |
| `createBoundedValuesAccumulator` | 4 | src/backend/toolbox-xlsx-stream/bounded-values-accumulator.js |
| `createBusinessOperationRegistry` | 4 | src/main-process/business-operation-registry.js |
| `createCancelToken` | 4 | src/main-process/acquiring-bill-currency-session.js |
| `createDuplicateInboundMatchStore` | 4 | src/backend/duplicate-inbound-match-store.js |
| `createPalette` | 4 | src/backend/toolbox-format/biff8-colors.js |
| `createPendingSession` | 4 | src/main-process/pending-session.js |
| `createPositionReconciliationStore` | 4 | src/main-process/position-reconciliation/store.js |
| `createPreFundReconciliationRunStore` | 4 | src/backend/pre-fund-reconciliation-run-store.js |
| `createScenarioImportContextStore` | 4 | src/main-process/archive-center/scenario-import-context-store.js |
| `createVccFinancialOpService` | 4 | src/main-process/vcc-financial-op-service.js |
| `createVccOpCalcSession` | 4 | src/main-process/vcc-op-calc-session.js |
| `currentFileMatchesIdentity` | 4 | src/main-process/pre-fund-reconciliation/excel-writer.js |
| `dateMismatchReason` | 4 | src/main-process/scenario-engines/r5-fund-transfer-backfill.js |
| `deleteBankDepositByDateRange` | 4 | src/backend/database/linked-table-repository.js |
| `deleteChannel` | 4 | src/backend/database/channels-repository.js |
| `deleteFxByDateRange` | 4 | src/backend/database/linked-table-repository.js |
| `deleteGatewayBillByDateRange` | 4 | src/backend/database/linked-table-repository.js |
| `deleteScenario` | 4 | src/backend/database/scenarios-repository.js |
| `deriveLinkedRows` | 4 | src/main-process/position-reconciliation/derivation.js |
| `detectDistribution` | 4 | src/main-process/app-updater.js |
| `detectFundTransferManyToMany` | 4 | src/main-process/reconciliation-orchestrator.js |
| `DRAWINGML_NAMESPACES` | 4 | src/backend/toolbox-format/ooxml-namespaces.js |
| `ensurePositionLargeImportSchemaAtPath` | 4 | src/main-process/position-reconciliation/large-import-schema.js |
| `ensureUiStyleDefault` | 4 | src/backend/database/settings-repository.js |
| `ensureVccStorageSideTables` | 4 | src/backend/vcc-financial-op-db/storage-contract.js |
| `executeDestructiveMutationWithSafeAudit` | 4 | src/backend/vcc-financial-op/destructive-write.js |
| `executeResultMutationWithSafeAudit` | 4 | src/backend/vcc-financial-op/result-write.js |
| `exportFilter` | 4 | src/backend/toolbox-xlsx-stream/split-export-filter.js |
| `exportMultiFilters` | 4 | src/backend/toolbox-xlsx-stream/split-export-filter.js |
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
| `getAutoUpdateEnabled` | 4 | src/backend/database/settings-repository.js |
| `getBackgroundConfig` | 4 | src/backend/database/settings-repository.js |
| `getBuiltinNumberFormat` | 4 | src/backend/toolbox-format/number-date.js |
| `getCurrencySuggestion` | 4 | src/renderer.js |
| `getCurrentModule` | 4 | src/backend/database/settings-repository.js |
| `getDiffRowsByRun` | 4 | src/backend/biz-op-recon-db/run-repository.js |
| `getEnumConfig` | 4 | src/backend/database/settings-repository.js |
| `getLastImportDirectoryCandidates` | 4 | src/backend/database/settings-repository.js |
| `getMaxBocFxOrigGroupNo` | 4 | src/backend/database/linked-table-repository.js |
| `getMirrorRun` | 4 | src/main-process/bank-bu-recon-run-data.js |
| `getReconIdFixBillCategory` | 4 | src/backend/database/settings-repository.js |
| `getRowById` | 4 | src/backend/biz-op-recon-db/imports-repository.js |
| `getRunResultSnapshot` | 4 | src/backend/vcc-financial-op/read-snapshot.js |
| `getTaskFilePlanDefinition` | 4 | src/main-process/archive-center/task-file-plan-registry.js |
| `getTemplateByKey` | 4 | src/backend/database/template-repository.js |
| `getTemplateByName` | 4 | src/backend/database/template-repository.js |
| `gregorianTupleToExcelSerial` | 4 | src/backend/toolbox-format/number-date.js |
| `GW_CURRENCY_FIELD` | 4 | src/main-process/scenario-engines/dbs-charge-fund-check.js |
| `hasLinkedTableRows` | 4 | src/backend/database/linked-table-repository.js |
| `hasMoreThanTwoDecimalsFromString` | 4 | src/backend/file-service/writers.js |
| `hasShownWinOneDriveStorageNotice` | 4 | src/backend/database/settings-repository.js |
| `heapStats` | 4 | src/backend/biz-op-recon-import/import-worker.js |
| `identifyAccountPair` | 4 | src/main-process/position-reconciliation/logical-accounts.js |
| `identifyMptHeader` | 4 | src/main-process/pre-fund-reconciliation/mpt-schema.js |
| `importBillFile` | 4 | src/backend/acquiring-bill-currency-import/reader.js |
| `importFlowFile` | 4 | src/backend/acquiring-bill-currency-import/reader.js |
| `importMonth` | 4 | src/main-process/bank-bu-recon-run-data.js |
| `importSystemOpGroup` | 4 | src/backend/vcc-financial-op/system-op-importer.js |
| `indexColumns` | 4 | src/backend/vcc-financial-op/read-schema.js |
| `initializeOpeningBalances` | 4 | src/backend/vcc-financial-op/calculator.js |
| `inspectFiles` | 4 | src/backend/vcc-financial-op/import-service.js |
| `inspectPositionOperationCommitChain` | 4 | src/main-process/position-reconciliation/side-db-mutation.js |
| `inspectVccStorage` | 4 | src/main-process/vcc-financial-op-storage-rebuild.js |
| `INVALID_DIRECTIONS_WARNING_CODE` | 4 | src/main-process/scenario-engines/r5-fund-transfer-backfill.js |
| `isBankDepositChannelFile` | 4 | src/backend/database/channel-enum-repository.js |
| `isBuiltinNumberFormat` | 4 | src/backend/toolbox-format/number-date.js |
| `isFilenameMappingMode` | 4 | src/main.js |
| `isMemoryLimitError` | 4 | src/backend/file-service/readers.js |
| `isSystemOpHeaders` | 4 | src/backend/vcc-financial-op/definitions.js |
| `legacyPendingUpgradeDetails` | 4 | src/backend/vcc-financial-op/pending-template-contract.js |
| `listAccountMappings` | 4 | src/backend/database/settings-repository.js |
| `listActiveMonthsSnapshot` | 4 | src/backend/vcc-financial-op/read-snapshot.js |
| `listArchiveMonthsSnapshot` | 4 | src/backend/vcc-financial-op/read-snapshot.js |
| `listChannelEnumValues` | 4 | src/backend/database/channel-enum-repository.js |
| `listChildTemplates` | 4 | src/backend/database/template-repository.js |
| `listDeleteTargetsSnapshot` | 4 | src/backend/vcc-financial-op/read-snapshot.js |
| `listDistinctBus` | 4 | src/backend/biz-op-recon-db/imports-repository.js |
| `listLinkedTableMeta` | 4 | src/backend/database/linked-table-repository.js |
| `listRecoverableVccImportArchiveBatchIds` | 4 | src/main-process/vcc-financial-op-archive-lineage.js |
| `listRunsDualSource` | 4 | src/main-process/bank-bu-recon-run-data.js |
| `listScenarios` | 4 | src/backend/database/scenarios-repository.js |
| `listTemplateBundleEntries` | 4 | src/backend/database/template-repository.js |
| `loadJobMeta` | 4 | src/backend/biz-op-recon-import/import-worker.js |
| `makeUnionFind` | 4 | src/main-process/position-reconciliation/logical-accounts.js |
| `mappedRowToInsertParams` | 4 | src/backend/vcc-financial-op/row-mapper.js |
| `markBankDepositHits` | 4 | src/backend/database/linked-table-repository.js |
| `markWinOneDriveStorageNoticeShown` | 4 | src/backend/database/settings-repository.js |
| `MERCHANT_ID_MULTI_ACCOUNT_MARKER` | 4 | src/backend/database/utils.js |
| `MID_ALLOCATION_SUCCESS_STATUS` | 4 | src/constants/fund-transfer-recon-fields.js |
| `MOVEMENT_SOURCE_TYPES` | 4 | src/backend/vcc-financial-op/result-adjustments.js |
| `MPT_DELIMITER` | 4 | src/main-process/pre-fund-reconciliation/mpt-schema.js |
| `MTX_FEATURE` | 4 | src/constants/refund-backfill-fields.js |
| `normalizeCurrencyOptionEntry` | 4 | src/renderer.js |
| `normalizeMaintainedBigAccounts` | 4 | src/main-process/big-account-recognition.js |
| `normalizeMptRow` | 4 | src/main-process/pre-fund-reconciliation/mpt-schema.js |
| `normalizePositionStreamingSourceTypes` | 4 | src/backend/position-reconciliation-import/constants.js |
| `normalizeRunId` | 4 | src/backend/vcc-financial-op/read-snapshot.js |
| `openEntryStream` | 4 | src/backend/position-reconciliation-import/xlsx-reader.js |
| `openModuleMenu` | 4 | src/renderer.js |
| `openToolboxBiff8Pass` | 4 | src/backend/toolbox-format/biff8-pass.js |
| `openToolboxCsvPass` | 4 | src/backend/toolbox-format/csv-pass.js |
| `openVccReadDatabase` | 4 | src/backend/vcc-financial-op/read-schema.js |
| `OPPONENT_BILL_SHEET_NAME` | 4 | src/constants/recon-id-fix-fields.js |
| `ORDER_REPAIR_SHEET_NAME` | 4 | src/constants/recon-id-fix-fields.js |
| `ORDER_REPAIR_SHEET_NAME_GATEWAY` | 4 | src/constants/gateway-bill-recon-fields.js |
| `parseColumnFromCellRef` | 4 | src/backend/acquiring-bill-currency-import/reader.js |
| `parseOutboxBatchId` | 4 | src/main-process/archive-center/outbox-store.js |
| `parseRowXml` | 4 | src/backend/vcc-op-calc-import/reader.js |
| `peekFirstFile` | 4 | src/backend/big-table-import/engine.js |
| `peekToolboxSplitHeaders` | 4 | src/main-process/toolbox-format-operations.js |
| `PENDING_DB_FILENAME` | 4 | src/backend/pending-db.js |
| `PENDING_MATCH_KEY_DB_COLUMN` | 4 | src/backend/bank-bu-recon-db/columns.js |
| `planRunOutputPaths` | 4 | src/main-process/acquiring-bill-currency-writer.js |
| `POSITION_DB_RELATIVE_PATH` | 4 | src/main-process/position-reconciliation/constants.js |
| `POSITION_IMPORT_PROGRESS_HEARTBEAT_MS` | 4 | src/backend/position-reconciliation-import/constants.js |
| `POSITION_SST_LRU_MAX_ENTRIES` | 4 | src/backend/position-reconciliation-import/constants.js |
| `POSITION_SST_MEMORY_BUDGET_BYTES` | 4 | src/backend/position-reconciliation-import/constants.js |
| `positionBankAmountWithExtraFee` | 4 | src/main-process/position-reconciliation/decimal.js |
| `preFundRunLineagePlan` | 4 | src/main-process/pre-fund-archive-lineage.js |
| `preFundRunOutputIntent` | 4 | src/main-process/pre-fund-archive-lineage.js |
| `prepareToolboxPublication` | 4 | src/main-process/toolbox-output-publication.js |
| `PREPROCESS_TABLE_SIGNATURES` | 4 | src/constants/table-signatures.js |
| `previewDeleteTargetSnapshot` | 4 | src/backend/vcc-financial-op/read-snapshot.js |
| `previewUnarchiveSnapshot` | 4 | src/backend/vcc-financial-op/read-snapshot.js |
| `projectOutputRow` | 4 | src/main-process/pre-fund-reconciliation/output-mapper.js |
| `projectToolboxRowValues` | 4 | src/backend/toolbox-format/model.js |
| `pruneStagingRoot` | 4 | src/main-process/position-reconciliation/input-staging.js |
| `publishPreparedToolboxPublication` | 4 | src/main-process/toolbox-output-publication.js |
| `publishVccFinancialOpOutputs` | 4 | src/main-process/vcc-financial-op-output-recovery.js |
| `readAdmBankDepositRows` | 4 | src/backend/database/linked-table-repository.js |
| `readBankDepositHitMarkers` | 4 | src/backend/database/linked-table-repository.js |
| `readBankFiles` | 4 | src/main-process/position-reconciliation/readers.js |
| `readBiff8Overlay` | 4 | src/backend/toolbox-format/biff8-overlay.js |
| `readBocBankDepositRows` | 4 | src/backend/database/linked-table-repository.js |
| `readBocFxLinkRows` | 4 | src/backend/database/linked-table-repository.js |
| `readFundTransferReconRows` | 4 | src/backend/database/linked-table-repository.js |
| `readGatewayBillRowPoolsByChannels` | 4 | src/backend/database/linked-table-repository.js |
| `readGatewayBillRowsByChannels` | 4 | src/backend/database/linked-table-repository.js |
| `readResultWorkbook` | 4 | src/main-process/position-reconciliation/excel-io.js |
| `readSharedStrings` | 4 | src/backend/vcc-op-calc-import/reader.js |
| `readSourceFiles` | 4 | src/main-process/position-reconciliation/readers.js |
| `readXlsxSheetNames` | 4 | src/main-process/duplicate-inbound-match/document-statement-reader.js |
| `RECON_RESULT_FIELDS` | 4 | src/constants/recon-id-fix-fields.js |
| `RECON_RESULT_SHEET_NAME` | 4 | src/constants/recon-id-fix-fields.js |
| `RECON_RESULT_SHEET_NAME_GATEWAY` | 4 | src/constants/gateway-bill-recon-fields.js |
| `reconIdFixResult` | 4 | src/main.js |
| `recordMonthEndCopyIntent` | 4 | src/main-process/biz-op-recon-session.js |
| `recoverPositionImportWorkerExit` | 4 | src/main-process/position-reconciliation/import-recovery.js |
| `refundOrderSession` | 4 | src/main.js |
| `renameTemplate` | 4 | src/backend/database/template-repository.js |
| `replaceBocFxLink` | 4 | src/backend/database/linked-table-repository.js |
| `replaceLinkedTable` | 4 | src/backend/database/linked-table-repository.js |
| `replaceLinkedTableStreaming` | 4 | src/backend/database/linked-table-repository.js |
| `resetFundTransferReconUsage` | 4 | src/main-process/scenario-engines/r5-payment-offline-allocation-backfill.js |
| `resolveBankRuleEligibility` | 4 | src/main-process/pre-fund-reconciliation/matching-engine.js |
| `resolveCurrencyValue` | 4 | src/backend/file-service/normalizers.js |
| `resolveDuplicateInboundDocumentMatches` | 4 | src/main-process/duplicate-inbound-match/matching-engine.js |
| `resolveDuplicateInboundMptMatches` | 4 | src/main-process/duplicate-inbound-match/matching-engine.js |
| `resolveFullColor` | 4 | src/backend/toolbox-format/biff8-colors.js |
| `resolveWorkerScript` | 4 | src/main-process/run-check-multiworker.js |
| `rgbToHsl` | 4 | src/backend/toolbox-format/biff8-colors.js |
| `rowScanner` | 4 | src/backend/big-table-import/engine.js |
| `runBocDispatchOrderFix` | 4 | src/main-process/recon-id-fix-engine.js |
| `runC4Scenario` | 4 | src/main-process/recon-id-fix-engine.js |
| `runCheckCore` | 4 | src/main-process/acquiring-bill-currency-session.js |
| `runDbsChargeFundCheck` | 4 | src/main-process/reconciliation-orchestrator.js |
| `runJpmDispatchOrderFix` | 4 | src/main-process/recon-id-fix-engine.js |
| `runOutputLineageIntent` | 4 | src/main-process/pending-archive-lineage.js |
| `runPositionFundNatureCheck` | 4 | src/main-process/position-reconciliation/matching-engine.js |
| `runPositionImportPreflight` | 4 | src/backend/position-reconciliation-import/preflight.js |
| `runPositionMaintenanceJob` | 4 | src/backend/position-reconciliation-import/maintenance-writer.js |
| `runRound1ReconIdMatch` | 4 | src/main-process/reconciliation-orchestrator.js |
| `runRound4FundNatureCheck` | 4 | src/main-process/reconciliation-orchestrator.js |
| `runRound5FundTransferBackfill` | 4 | src/main-process/reconciliation-orchestrator.js |
| `runRound5FundTransferReconBackfill` | 4 | src/main-process/reconciliation-orchestrator.js |
| `runRound5PaymentOfflineAllocationBackfill` | 4 | src/main-process/scenario-engines/r5-payment-offline-allocation-backfill.js |
| `runRound5PlatformInboundCleanup` | 4 | src/main-process/reconciliation-orchestrator.js |
| `runRound5RefundOrderBackfill` | 4 | src/main-process/reconciliation-orchestrator.js |
| `runViaSideDb` | 4 | src/main-process/bank-bu-recon-run-data.js |
| `saveAccountMappings` | 4 | src/backend/database/settings-repository.js |
| `saveTemplateFilenameFixedField` | 4 | src/backend/database/template-repository.js |
| `scanBiff8WorkbookStream` | 4 | src/backend/toolbox-format/biff8-records.js |
| `scanFields` | 4 | src/backend/toolbox-xlsx-stream/split-scan-fields.js |
| `serial1904To1900` | 4 | src/backend/toolbox-format/number-date.js |
| `setAcquiringBillChunkSize` | 4 | src/backend/database/settings-repository.js |
| `setAcquiringBillIdleCleanupMinutes` | 4 | src/backend/database/settings-repository.js |
| `setAcquiringBillRawJsonRetentionDays` | 4 | src/backend/database/settings-repository.js |
| `setAcquiringBillWorkerCount` | 4 | src/backend/database/settings-repository.js |
| `setAutoUpdateEnabled` | 4 | src/backend/database/settings-repository.js |
| `setBackgroundConfig` | 4 | src/backend/database/settings-repository.js |
| `setEnumConfig` | 4 | src/backend/database/settings-repository.js |
| `setLastImportDirectory` | 4 | src/backend/database/settings-repository.js |
| `showImportOpenDialog` | 4 | src/main-process/import-dialog-state.js |
| `sourceAmountToCents` | 4 | src/main-process/position-reconciliation/decimal.js |
| `sourceSnapshotForPath` | 4 | src/main-process/archive-center/operation-tracker.js |
| `spawn` | 4 | src/main-process/biz-op-recon-session.js |
| `stageInputFilesAsync` | 4 | src/main-process/position-reconciliation/input-staging.js |
| `streamDocumentStatement` | 4 | src/main-process/duplicate-inbound-match/document-statement-reader.js |
| `streamPositionXlsRows` | 4 | src/backend/position-reconciliation-import/xls-reader.js |
| `streamPositionXlsxRows` | 4 | src/backend/position-reconciliation-import/xlsx-reader.js |
| `SUPPORT_ACTION_POLICIES` | 4 | src/main-process/archive-center/task-policy-registry.js |
| `systemRecordResult` | 4 | src/backend/vcc-financial-op/system-op-importer.js |
| `T54_REFUND_RE` | 4 | src/constants/refund-backfill-fields.js |
| `tableInfo` | 4 | src/backend/vcc-financial-op/read-schema.js |
| `TextDecoder` | 4 | src/backend/position-reconciliation-import/shared-strings-provider.js |
| `toggleScenarioEnabled` | 4 | src/backend/database/scenarios-repository.js |
| `toMatchValue` | 4 | src/backend/toolbox-format/model.js |
| `transferScenarios` | 4 | src/backend/database/scenarios-repository.js |
| `UNARCHIVE_GATE_VERSION` | 4 | src/backend/vcc-financial-op/unarchive-gate.js |
| `updateChannel` | 4 | src/backend/database/channels-repository.js |
| `updateRunStatus` | 4 | src/backend/acquiring-bill-currency-db/run-repository.js |
| `updateScenario` | 4 | src/backend/database/scenarios-repository.js |
| `upgradeEmptyVccStorageContract` | 4 | src/backend/vcc-financial-op-db/storage-contract.js |
| `upsertBocFxLink` | 4 | src/backend/database/linked-table-repository.js |
| `upsertLinkedBankDeposit` | 4 | src/backend/database/linked-table-repository.js |
| `upsertLinkedBankDepositStreaming` | 4 | src/backend/database/linked-table-repository.js |
| `upsertLinkedFx` | 4 | src/backend/database/linked-table-repository.js |
| `upsertLinkedGatewayBill` | 4 | src/backend/database/linked-table-repository.js |
| `upsertLinkedGatewayBillStreaming` | 4 | src/backend/database/linked-table-repository.js |
| `upsertTemplate` | 4 | src/backend/database/template-repository.js |
| `v8` | 4 | src/backend/biz-op-recon-import/import-worker.js |
| `VALID_ORDER_STATUSES` | 4 | src/main-process/position-reconciliation/constants.js |
| `validateBankHeaders` | 4 | src/backend/bank-bu-recon-import/validator.js |
| `validateEffectiveResultEvidence` | 4 | src/backend/vcc-financial-op/archive-evidence.js |
| `validatePendingGuanliHeaders` | 4 | src/backend/bank-bu-recon-import/validator.js |
| `verifyPositionImportApplyGrant` | 4 | src/backend/position-reconciliation-import/apply-grant.js |
| `writeAdmMatchFlags` | 4 | src/backend/database/linked-table-repository.js |
| `writeChannelWorkbooks` | 4 | src/main-process/pre-fund-reconciliation/excel-writer.js |
| `writeDatasetWorkbook` | 4 | src/backend/vcc-financial-op/worker-entry.js |
| `writeDuplicateInboundWorkbook` | 4 | src/main-process/duplicate-inbound-match/excel-writer.js |
| `writeImportAuditWorkbook` | 4 | src/main-process/vcc-financial-op-audit-writer.js |
| `writeLinkedWorkbook` | 4 | src/main-process/position-reconciliation/excel-io.js |
| `writeMptErrorReport` | 4 | src/main-process/pre-fund-reconciliation/mpt-error-report-writer.js |
| `writePositionAnomalyReport` | 4 | src/backend/position-reconciliation-import/anomaly-report.js |
| `writeRawWorkbook` | 4 | src/main-process/position-reconciliation/excel-io.js |
| `writeRunFilteredSourcesWorkbook` | 4 | src/main-process/position-reconciliation/filtered-source-report.js |
| `writeStreamedXlsx` | 4 | src/backend/pending-import/streaming-xlsx-writer.js |
| `AppDatabase` | 3 | src/backend/database.js |
| `appendStatementSessionImport` | 3 | src/main-process/statement-session.js |
| `applyScenarioBundleImport` | 3 | src/main-process/scenarios-bundle-import.js |
| `assembleMonthlyBalance` | 3 | src/main-process/monthly-balance.js |
| `assertHeadersIdentical` | 3 | src/main-process/toolbox.js |
| `assertPositionRecoveryInputsUnchanged` | 3 | src/main-process/position-reconciliation/operation-lifecycle.js |
| `authorizePositionImportApply` | 3 | src/main-process/position-reconciliation/operation-lifecycle.js |
| `BIZ_OP_BU_FIELD_DB_COLUMN` | 3 | src/backend/biz-op-recon-db/columns.js |
| `bizOpRunTerminalRoute` | 3 | src/main-process/biz-op-archive-lineage.js |
| `buildDetailExportRows` | 3 | src/backend/file-service.js |
| `buildMergeFileName` | 3 | src/main-process/toolbox.js |
| `buildSplitFileName` | 3 | src/main-process/toolbox.js |
| `buildStaleHitReminder` | 3 | src/main-process/scenario-engines/r5-refund-order-backfill.js |
| `buildStatementFileEntry` | 3 | src/main-process/statement-session.js |
| `buildVccImportArchiveHandoffFiles` | 3 | src/main-process/vcc-financial-op-archive-lineage.js |
| `captureArchiveSourceSnapshots` | 3 | src/main-process/archive-center/source-snapshot.js |
| `clearRunsByMonth` | 3 | src/backend/acquiring-bill-currency-db/run-repository.js |
| `clearStaleSuccessfulRawJson` | 3 | src/backend/acquiring-bill-currency-db/raw-json-retention.js |
| `compareMatchedContent` | 3 | src/backend/pending-reconcile/removal-match.js |
| `completeRunOutputPublication` | 3 | src/backend/acquiring-bill-currency-db/run-repository.js |
| `computeRunStats` | 3 | src/backend/acquiring-bill-currency-db/run-repository.js |
| `computeValuesByField` | 3 | src/main-process/toolbox.js |
| `countC3BankCandidates` | 3 | src/main-process/scenario-engines/c3-gateway-recon-join.js |
| `countRefundBankCandidates` | 3 | src/main-process/scenario-engines/r5-refund-order-backfill.js |
| `createAppUpdaterService` | 3 | src/main-process/app-updater.js |
| `createArchiveCenterController` | 3 | src/main-process/archive-center/controller.js |
| `createArchiveOperationTracker` | 3 | src/main-process/archive-center/operation-tracker.js |
| `createArchiveOutboxStore` | 3 | src/main-process/archive-center/outbox-store.js |
| `createArchiveRuntimeDelegate` | 3 | src/main-process/archive-center/archive-runtime-delegate.js |
| `createArchiveService` | 3 | src/main-process/archive-center/archive-service.js |
| `createArchiveStorageRootManager` | 3 | src/main-process/archive-center/storage-root-manager.js |
| `createBankStatementRunFlowIdentity` | 3 | src/main-process/archive-center/task-policy-registry.js |
| `createBusinessFlowResolver` | 3 | src/main-process/archive-center/business-flow-resolver.js |
| `createDuplicateInboundMatchService` | 3 | src/main-process/duplicate-inbound-match/service.js |
| `createIpcTaskContext` | 3 | src/main-process/archive-center/ipc-task-contract.js |
| `createLegacyRunMirror` | 3 | src/backend/database/pre-fund-reconciliation-run-repository.js |
| `createPendingDatasetSeed` | 3 | src/backend/pending-db/dataset-identity.js |
| `createPositionReconciliationService` | 3 | src/main-process/position-reconciliation/service.js |
| `createPositionRunTaskContract` | 3 | src/main-process/position-reconciliation/interactive-task-preflight.js |
| `createPositionSourceImportTaskContract` | 3 | src/main-process/position-reconciliation/interactive-task-preflight.js |
| `createPreFundReconciliationService` | 3 | src/main-process/pre-fund-reconciliation/service.js |
| `createRowInserter` | 3 | src/backend/pending-db/month-repository.js |
| `createStatementGenerationHelpers` | 3 | src/main-process/statement-generation.js |
| `createTaskLifecycle` | 3 | src/main-process/archive-center/task-lifecycle.js |
| `deleteMonth` | 3 | src/backend/pending-db/month-repository.js |
| `deleteMonthBySide` | 3 | src/backend/acquiring-bill-currency-db/import-repository.js |
| `detectBundleType` | 3 | src/backend/scenarios-bundle-io.js |
| `detectTableType` | 3 | src/main-process/table-type-detector.js |
| `dispatchLargeSplit` | 3 | src/main-process/toolbox-large-split-dispatch.js |
| `encodeAdjustmentLineageName` | 3 | src/backend/vcc-financial-op/adjustment-lineage.js |
| `executeAfterPositionAdmission` | 3 | src/main-process/position-reconciliation/interactive-task-preflight.js |
| `executeIpcTaskInvocation` | 3 | src/main-process/archive-center/ipc-task-contract.js |
| `executePendingImportSubmission` | 3 | src/main-process/pending-import-preflight.js |
| `filterRowsByFieldValues` | 3 | src/main-process/toolbox.js |
| `finalizePendingTerminalIntent` | 3 | src/main-process/pending-archive-lineage.js |
| `finalizePreFundTerminalIntent` | 3 | src/main-process/pre-fund-archive-lineage.js |
| `findByChannelAndName` | 3 | src/backend/database/scenarios-repository.js |
| `getApplicableChannelIds` | 3 | src/backend/database/scenarios-repository.js |
| `getBillDateCounts` | 3 | src/backend/acquiring-bill-currency-db/run-repository.js |
| `getLatestRunByMonth` | 3 | src/backend/vcc-op-calc-db/run-repository.js |
| `getLatestRunForMonthPair` | 3 | src/backend/pending-db/diff-repository.js |
| `getMappingMap` | 3 | src/backend/database/fund-transfer-account-mapping-repository.js |
| `getOrCreateStatementImportSession` | 3 | src/main-process/statement-session.js |
| `getPendingRows` | 3 | src/backend/bank-bu-recon-db/month-repository.js |
| `getRunMirrorByArchiveTaskRunId` | 3 | src/backend/database/pre-fund-reconciliation-run-repository.js |
| `getRunResult` | 3 | src/backend/vcc-financial-op/calculator.js |
| `getSessionStatus` | 3 | src/main-process/acquiring-bill-currency-session.js |
| `getTemplatesByBankName` | 3 | src/backend/database/template-repository.js |
| `importBillFiles` | 3 | src/main-process/acquiring-bill-currency-session.js |
| `importBillFilesWithOverwrite` | 3 | src/main-process/acquiring-bill-currency-session.js |
| `importFlowFiles` | 3 | src/main-process/acquiring-bill-currency-session.js |
| `importFlowFilesWithOverwrite` | 3 | src/main-process/acquiring-bill-currency-session.js |
| `insertArchiveRun` | 3 | src/backend/biz-op-recon-db/run-repository.js |
| `insertBillRow` | 3 | src/backend/acquiring-bill-currency-db/import-repository.js |
| `insertDiffRows` | 3 | src/backend/biz-op-recon-db/run-repository.js |
| `insertDiffRowsByJoinChunked` | 3 | src/backend/acquiring-bill-currency-db/run-repository.js |
| `insertDiffRowsByJoinMultiWorker` | 3 | src/backend/acquiring-bill-currency-db/run-repository.js |
| `insertFlowRow` | 3 | src/backend/acquiring-bill-currency-db/import-repository.js |
| `insertRunFiles` | 3 | src/backend/vcc-op-calc-db/run-repository.js |
| `isStorageRootOnOneDrive` | 3 | src/main-process/onedrive-detector.js |
| `iterateDiffRowsByDateRange` | 3 | src/backend/acquiring-bill-currency-db/run-repository.js |
| `iterateExportableImportAnomalies` | 3 | src/backend/vcc-financial-op-db/repository.js |
| `LINKED_IMPORT_SIGNATURES` | 3 | src/constants/table-signatures.js |
| `listAllByChannelId` | 3 | src/backend/database/scenarios-repository.js |
| `listBuiltinFixedForChannel` | 3 | src/backend/database/scenarios-repository.js |
| `listDistinctMonths` | 3 | src/backend/vcc-op-calc-db/run-repository.js |
| `listImportRecordsByBatch` | 3 | src/backend/vcc-financial-op-db/repository.js |
| `listMatchedDiffRowIds` | 3 | src/backend/pending-reconcile/removal-match.js |
| `listMatchedRemovedRowIds` | 3 | src/backend/pending-reconcile/removal-match.js |
| `listPartialRuns` | 3 | src/backend/acquiring-bill-currency-db/run-repository.js |
| `listRunsForMonthPair` | 3 | src/backend/pending-db/diff-repository.js |
| `loadFundTypeEnum` | 3 | src/constants/fund-type-enum.js |
| `loadGatewayReconHeaders` | 3 | src/constants/gateway-recon-headers-loader.js |
| `loadResultTemplateContract` | 3 | src/backend/vcc-financial-op/result-template-contract.js |
| `markCleanupPending` | 3 | src/backend/acquiring-bill-currency-db/run-repository.js |
| `matchMerchantIds` | 3 | src/main-process/big-account-recognition.js |
| `mergeAoaRows` | 3 | src/main-process/toolbox.js |
| `mergeBankStatementRows` | 3 | src/main-process/bank-statement-merge.js |
| `mergeToolboxFilesToXlsx` | 3 | src/main-process/toolbox-merge-io.js |
| `normalizeIpcTaskHandler` | 3 | src/main-process/archive-center/ipc-task-contract.js |
| `openBackgroundPalette` | 3 | src/renderer.js |
| `openPendingDb` | 3 | src/backend/pending-db.js |
| `parseAdjustmentLineageName` | 3 | src/backend/vcc-financial-op/adjustment-lineage.js |
| `parseBankAccountExcel` | 3 | src/backend/bank-account-import.js |
| `parseScenarioBundle` | 3 | src/backend/scenarios-bundle-io.js |
| `peekMonthKeyFromFile` | 3 | src/backend/acquiring-bill-currency-import/reader.js |
| `pendingAggregateRunSelection` | 3 | src/main-process/pending-archive-lineage.js |
| `pendingRunLineagePlan` | 3 | src/main-process/pending-archive-lineage.js |
| `pendingRunTerminalRoute` | 3 | src/main-process/pending-archive-lineage.js |
| `pickBankDepositFields` | 3 | src/backend/database/linked-table-repository.js |
| `pickStaleHits` | 3 | src/main-process/scenario-engines/r5-refund-order-backfill.js |
| `POSITION_SIDE_DB_BOOTSTRAP_SETTING` | 3 | src/main-process/position-reconciliation/constants.js |
| `POSITION_SIDE_DB_CHECKPOINT_SETTING` | 3 | src/main-process/position-reconciliation/constants.js |
| `POSITION_SIDE_DB_PENDING_SETTING` | 3 | src/main-process/position-reconciliation/constants.js |
| `positionArchiveIntentEvidence` | 3 | src/main-process/position-reconciliation/operation-lifecycle.js |
| `positionBusinessStateForResult` | 3 | src/main-process/position-reconciliation/operation-lifecycle.js |
| `positionCancellationAcceptedPending` | 3 | src/main-process/position-reconciliation/operation-lifecycle.js |
| `positionCommittedRecoveryArchiveFiles` | 3 | src/main-process/position-reconciliation/operation-lifecycle.js |
| `positionPersistentStagingProtectionPaths` | 3 | src/main-process/position-reconciliation/operation-lifecycle.js |
| `positionReconciliationFailureResult` | 3 | src/main-process/position-reconciliation/operation-lifecycle.js |
| `positionRecoveryArchiveFiles` | 3 | src/main-process/position-reconciliation/operation-lifecycle.js |
| `positionRecoveryCleanupInputPaths` | 3 | src/main-process/position-reconciliation/operation-lifecycle.js |
| `positionTerminalOutcomeForResult` | 3 | src/main-process/position-reconciliation/operation-lifecycle.js |
| `preFundRunTerminalRoute` | 3 | src/main-process/pre-fund-archive-lineage.js |
| `prepareBillInsert` | 3 | src/backend/acquiring-bill-currency-db/import-repository.js |
| `prepareFlowInsert` | 3 | src/backend/acquiring-bill-currency-db/import-repository.js |
| `prepareIpcTaskInvocation` | 3 | src/main-process/archive-center/ipc-task-contract.js |
| `prepareManualBalanceSeedSubmission` | 3 | src/main-process/manual-balance-seed-preflight.js |
| `preparePendingImportSubmission` | 3 | src/main-process/pending-import-preflight.js |
| `prepareRunLineage` | 3 | src/main-process/biz-op-recon-run-data.js |
| `preservePreFundRunOwnerAfterMirrorCompensationFailure` | 3 | src/main-process/pre-fund-archive-lineage.js |
| `publicBizOpRun` | 3 | src/main-process/biz-op-archive-lineage.js |
| `publicPendingRun` | 3 | src/main-process/pending-archive-lineage.js |
| `readBankFile` | 3 | src/backend/bank-bu-recon-import/reader.js |
| `readBigAccountMode` | 3 | src/backend/big-account-mode-store.js |
| `readBigAccountOrder` | 3 | src/backend/big-account-order-store.js |
| `readPendingGuanliFile` | 3 | src/backend/bank-bu-recon-import/reader.js |
| `rebuildAdmDerivation` | 3 | src/main-process/linked-derive-rebuild.js |
| `rebuildBankDepositBocDerivation` | 3 | src/main-process/linked-derive-rebuild.js |
| `rebuildFundTransferReconDerivation` | 3 | src/main-process/linked-derive-rebuild.js |
| `rebuildFxBocDerivation` | 3 | src/main-process/linked-derive-rebuild.js |
| `reconcileVccImportArchiveLineageAtStartup` | 3 | src/main-process/vcc-financial-op-archive-lineage.js |
| `recordFromBankStatementRows` | 3 | src/backend/database/channel-enum-repository.js |
| `recoverPendingRunReceipts` | 3 | src/main-process/pending-archive-lineage.js |
| `recoverPreFundRunReceipts` | 3 | src/main-process/pre-fund-archive-lineage.js |
| `recoverVccImportArchiveTasks` | 3 | src/main-process/vcc-financial-op-archive-lineage.js |
| `REFUND_BACKFILL_FIELD_MAP` | 3 | src/constants/refund-backfill-fields.js |
| `removeStatementSessionEntriesByFilePath` | 3 | src/main-process/statement-session.js |
| `reportStartupFailure` | 3 | src/backend/startup-failure.js |
| `resolveFundTransferDatePolicy` | 3 | src/main-process/fund-transfer-date-policy.js |
| `resolveRecognizedBigAccount` | 3 | src/main-process/big-account-recognition.js |
| `runLegacyReconciliation` | 3 | src/backend/pending-reconcile/engine.js |
| `runOwnAccountsMigration` | 3 | src/backend/database/own-accounts-migration.js |
| `runPipeline` | 3 | src/backend/big-table-import/pipeline.js |
| `runPositionOperationLifecycle` | 3 | src/main-process/position-reconciliation/operation-lifecycle.js |
| `runReconIdFix` | 3 | src/main-process/recon-id-fix-engine.js |
| `runWithPreparedResourceCleanup` | 3 | src/main-process/position-reconciliation/interactive-task-preflight.js |
| `scanFxGroups` | 3 | src/main-process/boc-fx-link-builder.js |
| `selectSuccessfulPathsByResultIndex` | 3 | src/main-process/archive-center/operation-tracker.js |
| `serializeScenarioBundle` | 3 | src/backend/scenarios-bundle-io.js |
| `setApplicableChannelIds` | 3 | src/backend/database/scenarios-repository.js |
| `settlePositionArchiveResult` | 3 | src/main-process/position-reconciliation/operation-lifecycle.js |
| `settlePositionRecoveredTask` | 3 | src/main-process/position-reconciliation/operation-lifecycle.js |
| `shouldUseLargeChannel` | 3 | src/main-process/toolbox-large-split-router.js |
| `showComingSoon` | 3 | src/renderer.js |
| `STAGING_ROW_INSERT_SQL` | 3 | src/backend/vcc-financial-op-db/repository.js |
| `streamLinkedRowsToInsert` | 3 | src/main-process/linked-table-stream-source.js |
| `toBalanceRows` | 3 | src/main-process/monthly-balance.js |
| `updateRunStats` | 3 | src/backend/pending-db/diff-repository.js |
| `upsertMonthMeta` | 3 | src/backend/pending-db/month-repository.js |
| `vccFinancialOpErrorResult` | 3 | src/main-process/vcc-financial-op-ipc.js |
| `writeAggregateDiffWorkbook` | 3 | src/main-process/bank-bu-recon-writer.js |
| `writeBankStatementOutput` | 3 | src/main-process/exceljs-writer.js |
| `writeBigAccountMode` | 3 | src/backend/big-account-mode-store.js |
| `writeBigAccountOrder` | 3 | src/backend/big-account-order-store.js |
| `writeDateRangeDiffWorkbook` | 3 | src/main-process/biz-op-recon-writer.js |
| `writeManualBalanceSeedPlan` | 3 | src/main-process/manual-balance-seed-preflight.js |
| `writePlatformCleanupOutput` | 3 | src/main-process/platform-cleanup-writer.js |
| `writeRefundBackfillOutput` | 3 | src/main-process/refund-backfill-writer.js |
| `writeRunOutputs` | 3 | src/main-process/acquiring-bill-currency-writer.js |
| `writeScenarioHitRows` | 3 | src/main-process/scenario-hit-rows-writer.js |
| `writeSingleDateDiffWorkbook` | 3 | src/main-process/biz-op-recon-writer.js |
| `xmlAttrUnescape` | 3 | src/backend/big-table-import/zip-reader.js |
| `CELL_OPEN_RE` | 2 | src/backend/acquiring-bill-currency-import/reader-handrolled.js |
| `CELL_R_RE` | 2 | src/backend/acquiring-bill-currency-import/reader-handrolled.js |
| `readGatewayRecon` | 2 | src/main-process/bank-statement-io.js |
| `readMeaningfulRowsHead` | 2 | src/backend/file-service/readers.js |
| `readReconIdFixFile` | 2 | src/main-process/recon-id-fix-io.js |
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
| `RUN_PROGRESS_BATCH_CONTEXT_VERSION` | 4 |
| `buildSelectOnlyChunkSql` | 3 |
| `CURRENCY_MISMATCH_PREDICATE_SQL` | 3 |
| `DIFF_JOIN_BODY_SQL` | 3 |
| `DIFF_TYPE_CASE_SQL` | 3 |
| `MULTIWORKER_PART_COLUMNS` | 3 |
| `MULTIWORKER_TARGET_COLUMNS` | 3 |
| `updateRunPaths` | 3 |

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
| `ST_SEEK_ROW` | 3 |
| `ST_SEEK_SHEETDATA` | 3 |

### `src/backend/biz-op-recon-db/columns.js`

| 名字 | 总次数 |
|---|---:|
| `BIZ_OP_COLUMN_DEFS` | 5 |

### `src/backend/biz-op-recon-db/dataset-head-repository.js`

| 名字 | 总次数 |
|---|---:|
| `normalizedBuFor` | 4 |

### `src/backend/biz-op-recon-db/month-end-copy-intent-repository.js`

| 名字 | 总次数 |
|---|---:|
| `mapIntent` | 3 |
| `pendingError` | 3 |

### `src/backend/biz-op-recon-db/run-repository.js`

| 名字 | 总次数 |
|---|---:|
| `assertNoUnacknowledgedArchiveRunByDate` | 3 |

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
| `scenariosRepository` | 15 |
| `preFundReconciliationRunRepository` | 10 |
| `duplicateInboundMatchRunRepository` | 7 |
| `formatBytesForLog` | 6 |
| `channelEnumRepository` | 5 |
| `fundTransferAccountMappingRepository` | 4 |
| `ONE_TIME_VACUUM_FLAG_KEY` | 3 |

### `src/backend/database/archive-repository.js`

| 名字 | 总次数 |
|---|---:|
| `withWriteTransaction` | 33 |
| `optionalText` | 23 |
| `BATCH_TASK_STATUSES` | 18 |
| `normalizeModuleId` | 15 |
| `normalizeMetadata` | 14 |
| `BATCH_SELECT` | 13 |
| `mapBatch` | 13 |
| `TASK_RUN_STATUSES` | 13 |
| `ARTIFACT_SELECT` | 11 |
| `BATCH_ARCHIVE_STATUSES` | 11 |
| `mapArtifact` | 11 |
| `ARTIFACT_STATUSES` | 9 |
| `mapBlob` | 9 |
| `VISIBLE_BATCH_PREDICATE_SQL` | 8 |
| `normalizeFlowAnchorIdentity` | 7 |
| `normalizeModuleCode` | 5 |
| `SPLIT_DIRECTORY_REPAIR_TYPE` | 5 |
| `addColumnsIfMissing` | 4 |
| `ARCHIVE_INSTANCE_ID_SETTING_KEY` | 4 |
| `dateToIso` | 4 |
| `formatGlobalBatchNumber` | 4 |
| `mapArtifactHold` | 4 |
| `mapCleanupJob` | 4 |
| `mapFlowBindIntent` | 4 |
| `mapTaskFlowBindIntent` | 4 |
| `normalizeArtifactHoldIdentity` | 4 |
| `normalizeRetentionUntil` | 4 |
| `normalizeSha256` | 4 |
| `ArchiveRepository` | 3 |
| `BATCH_FORMAT_VERSIONS` | 3 |
| `ensureArchiveMetadataSupport` | 3 |
| `formatBatchNumber` | 3 |
| `mapTaskRun` | 3 |
| `normalizeArtifactPayload` | 3 |
| `normalizeSize` | 3 |
| `normalizeTaskStatus` | 3 |
| `parseArrayJson` | 3 |
| `SPLIT_DIRECTORY_REPAIR_BATCH_NUMBERS` | 3 |
| `taskLineageIdentity` | 3 |

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
| `isBankDepositRow` | 3 |
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
| `getDef` | 19 |
| `BOC_FX_TABLE` | 12 |
| `BOC_KEY_MATURITY_ISO` | 9 |
| `BOC_KEY_ORIG_GROUP` | 9 |
| `BOC_KEY_TXN_NO` | 8 |
| `normalizeDateForRange` | 8 |
| `normalizeSourceFileName` | 8 |
| `recomputeLinkedMeta` | 7 |
| `ADM_TABLE` | 6 |
| `BOC_FIELD_GROUP` | 6 |
| `BOC_KEY_SOURCE_ROW` | 6 |
| `FTR_COL` | 6 |
| `buildLinkedUpsertContext` | 5 |
| `HIT_MARKER_READ_CHUNK` | 5 |
| `BOC_BANK_TABLE` | 4 |
| `BOC_FIELD_ALLOCATION_NO` | 4 |
| `BOC_FIELD_RECON_LINK_ID` | 4 |
| `buildDateRangeWhere` | 4 |
| `countLinkedByDateRange` | 4 |
| `FUND_TRANSFER_RECON_TABLE` | 4 |
| `recomputeGatewayMeta` | 4 |
| `upsertLinkedTableMeta` | 4 |
| `__missingDepositFields` | 3 |
| `ALL_TABLE_KEYS` | 3 |
| `BOC_FIELD_TXN_NO` | 3 |
| `buildGatewayUpsertContext` | 3 |
| `createInsertContext` | 3 |
| `gatewaySourceIdentity` | 3 |
| `LINKED_TABLE_DEFS` | 3 |

### `src/backend/database/migrations.js`

| 名字 | 总次数 |
|---|---:|
| `N4_CONT_2_DIFF_ROWS_TABLE` | 10 |
| `FUND_TRANSFER_BACKFILL_CANONICAL_SEED` | 7 |
| `N4_CONT_2_DIFF_ROWS_TABLE_NEW` | 5 |
| `REFUND_BACKFILL_SCENARIO` | 5 |
| `BILL_RAW_JSON_V2_MIGRATED_KEY` | 4 |
| `BOC_DISPATCH_ORDER_SCENARIO` | 4 |
| `DBS_CHARGE_FUND_CHECK_SCENARIO` | 4 |
| `JPM_DISPATCH_ORDER_SCENARIO` | 4 |
| `N4_CONT_2_DIFF_ROWS_CASCADE_MIGRATED_MARKER` | 4 |
| `N5_SCENARIOS_UNIQUE_MIGRATED_MARKER` | 4 |
| `BOC_DISPATCH_ORDER_SCENARIO_SEEDED_MARKER` | 3 |
| `C3_GW_FIELD_CURRENCY_REVERT_KEY` | 3 |
| `DBS_CHARGE_FUND_CHECK_SCENARIO_SEEDED_MARKER` | 3 |
| `ensureChannelsTable` | 3 |
| `ensureScenariosChannelIdColumn` | 3 |
| `FUND_TRANSFER_BACKFILL_CURRENT_FUNCTION` | 3 |
| `JPM_DISPATCH_ORDER_SCENARIO_SEEDED_MARKER` | 3 |
| `N5_MIGRATED_MARKER` | 3 |
| `R4_DIRECTION_GUARD_FIELD` | 3 |
| `R4_STRICT_FUNCTION_BY_SUBCATEGORY` | 3 |
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
| `makeScenarioIdentityError` | 8 |
| `rowToDetail` | 8 |
| `hasChannelIdColumn` | 6 |
| `hasChannelIdColumnCache` | 5 |
| `isScenarioNameUniqueError` | 5 |
| `assertScenarioNotCanonicalOwner` | 4 |
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
| `LAST_IMPORT_DIRECTORY_GLOBAL_KEY` | 7 |
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
| `AUTO_UPDATE_ENABLED_KEY` | 4 |
| `buildLastImportDirectoryKey` | 4 |
| `CURRENT_MODULE_VALID` | 4 |
| `RECON_ID_FIX_BILL_CATEGORY_KEY` | 4 |
| `RECON_ID_FIX_BILL_CATEGORY_VALID` | 4 |
| `UI_STYLE_KEY` | 4 |
| `WIN_ONEDRIVE_STORAGE_NOTICE_SHOWN_KEY` | 4 |
| `CURRENT_MODULE_KEY` | 3 |
| `LAST_IMPORT_DIRECTORY_PREFIX` | 3 |

### `src/backend/database/template-repository.js`

| 名字 | 总次数 |
|---|---:|
| `getTemplateFixedAssignments` | 3 |

### `src/backend/duplicate-inbound-match-store.js`

| 名字 | 总次数 |
|---|---:|
| `DuplicateInboundMatchStore` | 3 |
| `loadValidatedRun` | 3 |
| `mapImport` | 3 |

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

### `src/backend/pending-db/dataset-identity.js`

| 名字 | 总次数 |
|---|---:|
| `DATASET_IDENTITY_KEYS` | 3 |

### `src/backend/pending-db/diff-repository.js`

| 名字 | 总次数 |
|---|---:|
| `createRunWithReceipt` | 3 |

### `src/backend/pending-db/migrations.js`

| 名字 | 总次数 |
|---|---:|
| `ensureColumn` | 8 |

### `src/backend/pending-db/month-repository.js`

| 名字 | 总次数 |
|---|---:|
| `writeMonthMeta` | 3 |

### `src/backend/pending-db/removed-repository.js`

| 名字 | 总次数 |
|---|---:|
| `indexValue` | 13 |
| `replaceByMonthWithIdentity` | 3 |

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
| `buildPendingExportReadSnapshot` | 3 |
| `computeChangedFields` | 3 |
| `exportAggregateRuns` | 3 |
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
| `bytesToGb` | 3 |
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

### `src/backend/position-reconciliation-import/account-writer.js`

| 名字 | 总次数 |
|---|---:|
| `accountStatements` | 3 |

### `src/backend/position-reconciliation-import/anomaly-report.js`

| 名字 | 总次数 |
|---|---:|
| `addHeader` | 3 |
| `REPORT_SOURCE_OPERATION` | 3 |
| `reportDetailValues` | 3 |
| `SUMMARY_SHEET_NAME` | 3 |

### `src/backend/position-reconciliation-import/apply-grant.js`

| 名字 | 总次数 |
|---|---:|
| `invalidGrant` | 5 |

### `src/backend/position-reconciliation-import/bank-writer.js`

| 名字 | 总次数 |
|---|---:|
| `bankScopeKey` | 4 |
| `assertBankStatsMatch` | 3 |
| `initializeIncomingBankTables` | 3 |

### `src/backend/position-reconciliation-import/constants.js`

| 名字 | 总次数 |
|---|---:|
| `POSITION_IMPORT_MUTATING_COMMANDS` | 3 |
| `POSITION_IMPORT_NON_CANCELLABLE_STAGES` | 3 |

### `src/backend/position-reconciliation-import/disk-space-gate.js`

| 名字 | 总次数 |
|---|---:|
| `normalizeNonNegativeInteger` | 5 |
| `POSITION_IMPORT_ESTIMATED_BYTES_PER_ROW` | 4 |
| `availableStorageBytes` | 3 |
| `estimatePositionImportDiskBytes` | 3 |
| `existingStorageBytes` | 3 |
| `POSITION_IMPORT_DISK_SAFETY_MARGIN_BYTES` | 3 |

### `src/backend/position-reconciliation-import/ledger.js`

| 名字 | 总次数 |
|---|---:|
| `PositionImportLedgerError` | 23 |
| `normalizedFileIndex` | 10 |
| `savepointName` | 5 |
| `LEDGER_SCHEMA` | 3 |

### `src/backend/position-reconciliation-import/maintenance-writer.js`

| 名字 | 总次数 |
|---|---:|
| `maintenanceError` | 19 |
| `uniqueTextList` | 4 |
| `bankDeleteSelection` | 3 |
| `deleteBankScopesStreamed` | 3 |
| `deleteInBatches` | 3 |
| `deleteSourceRowsStreamed` | 3 |
| `normalizeMappings` | 3 |
| `rebuildFundTransferLinksStreamed` | 3 |
| `sourceDeleteSelection` | 3 |

### `src/backend/position-reconciliation-import/preflight.js`

| 名字 | 总次数 |
|---|---:|
| `resultFromFailure` | 7 |
| `preflightSourceFile` | 5 |
| `isSystemFatal` | 4 |
| `resultFromAccepted` | 4 |
| `preflightBankFile` | 3 |
| `progressEmitter` | 3 |

### `src/backend/position-reconciliation-import/shared-strings-provider.js`

| 名字 | 总次数 |
|---|---:|
| `PositionSharedStringsError` | 14 |
| `LENGTH_PREFIX_BYTES` | 8 |
| `INDEX_RECORD_BYTES` | 6 |
| `AdaptiveSharedStringsProvider` | 3 |
| `MAX_SST_PAYLOAD_BYTES` | 3 |
| `MemorySharedStringsProvider` | 3 |

### `src/backend/position-reconciliation-import/source-writer.js`

| 名字 | 总次数 |
|---|---:|
| `reportKeyOf` | 10 |
| `applySourceFile` | 3 |
| `initializeApplyIdentityTable` | 3 |
| `ORDINARY_SOURCE_TYPES` | 3 |
| `outputDependenciesSatisfied` | 3 |

### `src/backend/position-reconciliation-import/worker-entry.js`

| 名字 | 总次数 |
|---|---:|
| `cleanupPreApplyArtifacts` | 3 |
| `serializedError` | 3 |

### `src/backend/position-reconciliation-import/xlsx-reader.js`

| 名字 | 总次数 |
|---|---:|
| `parserParityError` | 5 |
| `readPhysicalHeader` | 4 |
| `BASE_DATE` | 3 |
| `HEADER_SCAN_MAX_COLUMNS` | 3 |
| `locatePositionBusinessSheet` | 3 |
| `REFERENCE_DATE` | 3 |
| `REFERENCE_OFFSET` | 3 |
| `sheetJsCompatibleCellValue` | 3 |
| `sheetJsSerialDate` | 3 |
| `workbookInvalid` | 3 |

### `src/backend/pre-fund-reconciliation-run-store.js`

| 名字 | 总次数 |
|---|---:|
| `assertRunIdentity` | 7 |
| `gatewayMatchValues` | 3 |
| `mapGatewayPoolRow` | 3 |
| `parseResultObjectJson` | 3 |
| `PreFundReconciliationRunStore` | 3 |
| `prepareGatewayCandidateStager` | 3 |
| `rawJsonHash` | 3 |

### `src/backend/pre-fund-reconciliation-store.js`

| 名字 | 总次数 |
|---|---:|
| `normalizeSourceTypeFilter` | 7 |
| `withMutationLock` | 6 |
| `BATCH_DATE_RANGE_WHERE` | 5 |
| `MUTATION_TAILS` | 5 |
| `mapBatchRow` | 4 |
| `storeError` | 4 |
| `DEFAULT_WRITE_BATCH_SIZE` | 3 |
| `mapGatewayRow` | 3 |
| `normalizeDateRange` | 3 |
| `normalizeImportOptions` | 3 |
| `PreFundReconciliationStore` | 3 |
| `SELECT_BATCH_BY_IDENTITY` | 3 |
| `SELECT_BATCH_DATE_RANGE_SUMMARY` | 3 |
| `SELECT_BATCH_DATE_RANGE_SUMMARY_BY_SOURCE` | 3 |

### `src/backend/run-data-store.js`

| 名字 | 总次数 |
|---|---:|
| `assertModule` | 5 |
| `KNOWN_MODULES` | 4 |
| `RUN_DATA_DIRNAME` | 4 |
| `SIDE_DB_DDL_PRE_FUND_GATEWAY` | 4 |
| `SIDE_DB_PRAGMA_STATEMENTS` | 4 |
| `assertMonthKey` | 3 |
| `ensurePreFundGatewayArchiveSupport` | 3 |
| `ensurePreFundRunArchiveSupport` | 3 |
| `hasTableColumn` | 3 |
| `monthKeyFromFileName` | 3 |
| `runDataRoot` | 3 |
| `SIDE_DB_DDL_ACQUIRING` | 3 |
| `SIDE_DB_DDL_BANK_BU` | 3 |
| `SIDE_DB_DDL_DUPLICATE_INBOUND_MATCH` | 3 |

### `src/backend/scenarios-bundle-io.js`

| 名字 | 总次数 |
|---|---:|
| `MIN_SCENARIO_BUNDLE_VERSION` | 4 |

### `src/backend/startup-failure.js`

| 名字 | 总次数 |
|---|---:|
| `buildStartupFailureDialogMessage` | 3 |
| `normalizeErrorMessage` | 3 |

### `src/backend/toolbox-format/biff8-colors.js`

| 名字 | 总次数 |
|---|---:|
| `colorError` | 11 |
| `toArgb` | 9 |
| `automaticRgb` | 4 |
| `DEFAULT_INDEXED_RGB` | 3 |

### `src/backend/toolbox-format/biff8-overlay.js`

| 名字 | 总次数 |
|---|---:|
| `MAX_THEME_XML_BYTES` | 6 |
| `BORDER_STYLES` | 4 |
| `FILL_PATTERNS` | 4 |
| `HORIZONTAL_ALIGNMENTS` | 4 |
| `MAX_THEME_ZIP_ENTRIES` | 4 |
| `VERTICAL_ALIGNMENTS` | 4 |
| `Biff8OverlayError` | 3 |
| `DEFAULT_OFFICE_THEME_COLORS` | 3 |
| `extractWorkbookStream` | 3 |
| `localXmlName` | 3 |
| `toToolboxStaticStyle` | 3 |

### `src/backend/toolbox-format/biff8-pass.js`

| 名字 | 总次数 |
|---|---:|
| `ToolboxBiff8PassError` | 6 |
| `assertBiff8ValueFormatsMatch` | 3 |
| `assertSheetStatesMatch` | 3 |
| `buildBiff8ColumnLayout` | 3 |
| `buildLegacyMatchMatrix` | 3 |
| `buildSheetJsProjection` | 3 |
| `createBiff8SourceRegistry` | 3 |
| `decodeSheetJsCell` | 3 |
| `resolveBiff8RowForOutput` | 3 |
| `sheetStateFromHidden` | 3 |
| `ToolboxBiff8Pass` | 3 |

### `src/backend/toolbox-format/biff8-records.js`

| 名字 | 总次数 |
|---|---:|
| `RECORD` | 63 |
| `requireLength` | 19 |
| `requireMinimumLength` | 12 |
| `readCursorByte` | 11 |
| `makeCell` | 9 |
| `parseUnicodeString` | 8 |
| `readScanRecord` | 5 |
| `validateFiniteNumericCell` | 5 |
| `BIFF8_MAX_RECORD_PAYLOAD` | 4 |
| `parseFrtHeader` | 4 |
| `readPhysicalRecord` | 4 |
| `validateCellXfIndex` | 4 |
| `BIFF8_MAX_STRING_LOGICAL_BYTES` | 3 |
| `BIFF8_MAX_THEME_LOGICAL_BYTES` | 3 |
| `CELL_RECORD_NAMES` | 3 |
| `checkAvailable` | 3 |
| `cursorRemaining` | 3 |
| `decodeRkValue` | 3 |
| `ensureBuffer` | 3 |
| `fontIndexToRecordIndex` | 3 |
| `isValidBiff8ErrorCode` | 3 |
| `moveToNextSegment` | 3 |
| `msoCrc32Compute` | 3 |
| `parseBof` | 3 |
| `readCursorUInt16` | 3 |
| `readLogicalRecord` | 3 |

### `src/backend/toolbox-format/csv-pass.js`

| 名字 | 总次数 |
|---|---:|
| `assertSynchronousCallback` | 3 |
| `CSV_SHEET_NAME` | 3 |
| `hasExcelContainerMagic` | 3 |
| `readLegacyCsvRowsAllowEmpty` | 3 |
| `ToolboxCsvCancelledError` | 3 |
| `ToolboxCsvPass` | 3 |

### `src/backend/toolbox-format/excel-text.js`

| 名字 | 总次数 |
|---|---:|
| `assertWellFormedUtf16` | 4 |

### `src/backend/toolbox-format/model.js`

| 名字 | 总次数 |
|---|---:|
| `emitDateFallbackWarning` | 4 |
| `freezeStyleRef` | 4 |
| `projectToolboxValue` | 4 |

### `src/backend/toolbox-format/number-date.js`

| 名字 | 总次数 |
|---|---:|
| `TOOLBOX_MAX_CANONICAL_DECIMAL_CHARS` | 7 |
| `decimalCanonicalLimit` | 4 |
| `TOOLBOX_MAX_GENERATED_NUMFMT_CHARS` | 4 |
| `addIntegerToDecimal` | 3 |
| `classifyMinuteMonthTokens` | 3 |
| `daysBeforeMonth` | 3 |
| `daysBeforeYear` | 3 |
| `generatedPlainNumberFormat` | 3 |
| `parseDecimalLexicalInternal` | 3 |
| `stripFormatLiterals` | 3 |
| `ToolboxDecimalCanonicalLimitError` | 3 |

### `src/backend/toolbox-format/style-registry.js`

| 名字 | 总次数 |
|---|---:|
| `styleParseError` | 39 |
| `canonicalAttributeMap` | 30 |
| `ToolboxStyleParseError` | 20 |
| `normalizeArgb` | 13 |
| `stableSignature` | 13 |
| `DEFAULT_FONT` | 7 |
| `normalizeStaticStyle` | 7 |
| `parseAllowedEnum` | 7 |
| `THEME_INDEX_KEYS` | 7 |
| `DEFAULT_INDEXED_COLORS` | 6 |
| `DEFAULT_STATIC_STYLE` | 6 |
| `parseOoxmlBoolean` | 6 |
| `rawColorSpec` | 6 |
| `resolveColorSpec` | 6 |
| `COLOR_CONSUMED_ATTRIBUTES` | 5 |
| `DEFAULT_ALIGNMENT` | 5 |
| `DEFAULT_BORDER` | 5 |
| `DEFAULT_FILL` | 5 |
| `DEFAULT_THEME_COLORS` | 5 |
| `ToolboxStyleBudgetError` | 5 |
| `hueToRgb` | 4 |
| `assertKnownColorAttributes` | 3 |
| `normalizeBorder` | 3 |
| `normalizeExplicitColorSpec` | 3 |
| `parseNonNegativeInteger` | 3 |
| `parseOoxmlStyles` | 3 |
| `parseOoxmlTextRotation` | 3 |
| `parseStrictDecimalNumber` | 3 |
| `parseStrictInteger` | 3 |
| `STYLE_ELEMENTS_BY_CASEFOLD` | 3 |
| `THEME_ELEMENTS_BY_CASEFOLD` | 3 |
| `THEME_KEY_BY_LOCAL_NAME` | 3 |
| `TOOLBOX_STYLE_BUDGETS` | 3 |

### `src/backend/toolbox-format/xlsx-pass.js`

| 名字 | 总次数 |
|---|---:|
| `TOOLBOX_MAX_SHARED_STRINGS_UNCOMPRESSED_BYTES` | 4 |
| `assertToolboxSharedStringsSize` | 3 |
| `normalizeRelationshipTarget` | 3 |
| `OFFICE_RELATIONSHIP_TYPE_ALLOWLIST` | 3 |
| `RELATIONSHIP_ELEMENTS_BY_CASEFOLD` | 3 |
| `relationshipTypeAllowed` | 3 |
| `SHARED_STRING_ELEMENTS_BY_CASEFOLD` | 3 |
| `ToolboxXlsxPass` | 3 |
| `WORKBOOK_ELEMENTS_BY_CASEFOLD` | 3 |
| `WORKSHEET_STATES` | 3 |

### `src/backend/toolbox-format/xlsx-sheet-scanner.js`

| 名字 | 总次数 |
|---|---:|
| `parseBoolean` | 7 |
| `parseInteger` | 6 |
| `parsePositiveLayoutNumber` | 5 |
| `columnLettersToIndex` | 3 |
| `decodeCellPayload` | 3 |
| `EXCEL_FORMULA_MAX_UTF16_UNITS` | 3 |
| `findColumnMetadata` | 3 |
| `legacyNumericProjection` | 3 |
| `OOXML_CELL_TYPES` | 3 |
| `OOXML_ERROR_VALUES` | 3 |
| `parseCellReference` | 3 |
| `parseOutlineLevel` | 3 |
| `sharedStringCount` | 3 |
| `SPREADSHEETML_CANONICAL_ELEMENTS` | 3 |
| `validateWorksheetElementCase` | 3 |

### `src/backend/toolbox-xlsx-stream/bounded-values-accumulator.js`

| 名字 | 总次数 |
|---|---:|
| `DEFAULT_MAX_DISTINCT_PER_FIELD` | 3 |
| `DEFAULT_MAX_TOTAL_DISTINCT` | 3 |
| `normalizePositiveInt` | 3 |

### `src/backend/toolbox-xlsx-stream/large-split-worker.js`

| 名字 | 总次数 |
|---|---:|
| `ToolboxWorkerMemoryLimitError` | 4 |
| `assertSharedStringsUnderLimit` | 3 |
| `HEAP_USED_LIMIT_BYTES` | 3 |
| `isExplainedError` | 3 |
| `SHARED_STRINGS_UNCOMPRESSED_LIMIT` | 3 |
| `ToolboxSharedStringsTooLargeError` | 3 |

### `src/backend/toolbox-xlsx-stream/multi-sheet-reader.js`

| 名字 | 总次数 |
|---|---:|
| `normalizeLogicalRow` | 5 |
| `makeStopSignal` | 3 |

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

### `src/backend/vcc-financial-op-db/migrations.js`

| 名字 | 总次数 |
|---|---:|
| `currencyMigrationError` | 10 |
| `LEGACY_VCC_CURRENCY` | 10 |
| `CURRENT_VCC_CURRENCY` | 6 |
| `VCC_CURRENCY_CONTRACT_VERSION` | 5 |
| `assertNoCurrencyCoordinateCollision` | 4 |
| `FIRST_MONTH_DIAGNOSTIC_OPERATION` | 4 |
| `currencyContentHash` | 3 |
| `ensureVccCurrencyContractSupport` | 3 |
| `ensureVccFinancialOpStateModelSupport` | 3 |
| `normalizeBalancesJsonCurrency` | 3 |
| `parsePendingRawJson` | 3 |
| `pendingMigrationPlan` | 3 |
| `VCC_CURRENCY_ORDER` | 3 |

### `src/backend/vcc-financial-op-db/repository.js`

| 名字 | 总次数 |
|---|---:|
| `normalizedPositiveInteger` | 7 |
| `compactImportAnomalyCount` | 4 |
| `LEGACY_ERROR_CATEGORY_SQL` | 4 |
| `LEGACY_ERROR_NOT_IN_ROWS_SQL` | 4 |
| `countImportRowsByDisposition` | 3 |
| `finalizeImportingRecords` | 3 |
| `resolveImportSourceForRecord` | 3 |

### `src/backend/vcc-financial-op-db/storage-contract.js`

| 名字 | 总次数 |
|---|---:|
| `addColumnIfMissing` | 6 |
| `assertTableName` | 6 |
| `inspectVccStorageData` | 4 |
| `VCC_STORAGE_CONTRACT_SETTING_KEY` | 4 |
| `VCC_STORAGE_WRITE_CAPABILITY_FUNCTION` | 4 |
| `VCC_STORAGE_WRITE_CAPABILITY_TOKEN` | 4 |
| `vccTableNames` | 4 |

### `src/backend/vcc-financial-op/adjustment-lineage.js`

| 名字 | 总次数 |
|---|---:|
| `MAX_EXCEL_DEFINED_NAME_LENGTH` | 4 |
| `SAFE_EXCEL_DEFINED_NAME_PATTERN` | 4 |
| `ROW_KEY_PATTERN` | 3 |

### `src/backend/vcc-financial-op/amount-rules.js`

| 名字 | 总次数 |
|---|---:|
| `MAX_EXCEL_SIGNIFICANT_DIGITS` | 4 |
| `MAX_FRACTION_DIGITS` | 4 |
| `decimalMetrics` | 3 |

### `src/backend/vcc-financial-op/archive-contract.js`

| 名字 | 总次数 |
|---|---:|
| `sameArray` | 8 |
| `ARCHIVE_CLASSIFIER_VERSION` | 4 |
| `inconsistentResult` | 3 |

### `src/backend/vcc-financial-op/archive-evidence.js`

| 名字 | 总次数 |
|---|---:|
| `compareNumber` | 9 |
| `groupByRunId` | 4 |
| `ARCHIVE_EVIDENCE_VERSION` | 3 |

### `src/backend/vcc-financial-op/calculator.js`

| 名字 | 总次数 |
|---|---:|
| `createVccStateError` | 18 |
| `ARCHIVE_RESULT_OPERATION` | 7 |
| `REPLACE_CALCULATED_RESULT_OPERATION` | 6 |
| `nestedAmountKey` | 5 |
| `REQUIRED_DETAIL_TYPES` | 5 |
| `activeImportBatches` | 4 |
| `aggregateEffectiveRows` | 4 |
| `loadOpeningBalances` | 4 |
| `previousYearMonth` | 4 |
| `buildBalanceRows` | 3 |
| `datasetSnapshot` | 3 |
| `INPUT_FINGERPRINT_RE` | 3 |
| `loadSystemSnapshots` | 3 |
| `nextYearMonth` | 3 |
| `validateCalculatedOutputAmounts` | 3 |

### `src/backend/vcc-financial-op/data-target-deletion.js`

| 名字 | 总次数 |
|---|---:|
| `DELETE_OPENING_OPERATION` | 7 |
| `DELETE_RESULT_OPERATION` | 7 |
| `normalizeDeleteTarget` | 6 |
| `assertTargetMonthRunsDeleted` | 4 |
| `operationStateForTarget` | 4 |
| `assertDeletePreview` | 3 |
| `assertOpeningDeletionPostconditions` | 3 |
| `DELETE_ACTION` | 3 |
| `deleteOpeningInitialization` | 3 |
| `deleteRunChildren` | 3 |
| `deleteUnarchivedResult` | 3 |

### `src/backend/vcc-financial-op/dataset-deletion.js`

| 名字 | 总次数 |
|---|---:|
| `scopeError` | 16 |
| `DELETE_SOURCE_DATASET_OPERATION` | 6 |
| `DEFAULT_DELETE_REASON` | 4 |
| `assertDatasetDeletionRecord` | 3 |
| `assertDeletable` | 3 |
| `assertDeletionPostconditions` | 3 |
| `assertLinkedSystemAttempts` | 3 |
| `assertSystemBackfillUnchanged` | 3 |
| `normalizeScope` | 3 |

### `src/backend/vcc-financial-op/definitions.js`

| 名字 | 总次数 |
|---|---:|
| `buildDefinition` | 6 |
| `CHANNEL_HEADERS` | 3 |
| `FEE_FX_HEADERS` | 3 |
| `normalizeHeader` | 3 |
| `RECHARGE_HEADERS` | 3 |

### `src/backend/vcc-financial-op/destructive-write.js`

| 名字 | 总次数 |
|---|---:|
| `destructiveWriteError` | 26 |
| `largeStep` | 8 |
| `fullRow` | 6 |
| `RUN_CHILD_SCOPES` | 5 |
| `semanticAcceptedCondition` | 5 |
| `DELETE_SUCCESS_OPERATION_TYPES` | 4 |
| `DESTRUCTIVE_OPERATION_TYPES` | 4 |
| `assertDeletePostconditions` | 3 |
| `assertDeleteSuccessAudit` | 3 |
| `assertRunDeletionPostconditions` | 3 |
| `assertUnarchivePostconditions` | 3 |
| `auditStepBindings` | 3 |
| `baseDeletePostState` | 3 |
| `buildDeletePlan` | 3 |
| `buildUnarchivePlan` | 3 |
| `deleteOperationType` | 3 |
| `executeLockedDestructiveMutation` | 3 |
| `loadLockedDeleteEvidence` | 3 |
| `loadLockedUnarchiveEvidence` | 3 |
| `loadRunDeletionScope` | 3 |
| `normalizeDestructivePayload` | 3 |
| `operationAuditBoundary` | 3 |
| `runDeletionSteps` | 3 |
| `runDeletionTableBudgets` | 3 |

### `src/backend/vcc-financial-op/detail-importer.js`

| 名字 | 总次数 |
|---|---:|
| `diffFieldNames` | 4 |
| `recordResult` | 4 |
| `classifyAndPromote` | 3 |
| `comparableRawValues` | 3 |
| `hasEffectiveRawJson` | 3 |
| `sourceFileNames` | 3 |
| `STAGING_COMMIT_INTERVAL` | 3 |
| `updateConflictComparisons` | 3 |

### `src/backend/vcc-financial-op/import-service.js`

| 名字 | 总次数 |
|---|---:|
| `importHandoffMismatch` | 14 |
| `assertImportArchiveHandoffMatches` | 3 |
| `detailRecordResult` | 3 |
| `IMPORT_BATCH_ID_MAX_LENGTH` | 3 |

### `src/backend/vcc-financial-op/mutation-guard.js`

| 名字 | 总次数 |
|---|---:|
| `mutationGuardError` | 21 |
| `changesetSize` | 6 |
| `totalChanges` | 6 |
| `closeProtectedSessions` | 4 |
| `runtimeCapabilityEvidence` | 4 |
| `assertPlanRegistered` | 3 |
| `canonicalTriggerSql` | 3 |
| `createProtectedSessions` | 3 |
| `runRuntimeCapabilityProbe` | 3 |
| `vccTriggers` | 3 |

### `src/backend/vcc-financial-op/operation-state.js`

| 名字 | 总次数 |
|---|---:|
| `appendFingerprintFrame` | 4 |
| `snapshotArchives` | 3 |
| `snapshotDatasets` | 3 |
| `snapshotLaterDependencyMonths` | 3 |
| `snapshotLaterRuns` | 3 |
| `snapshotOpening` | 3 |
| `snapshotRuns` | 3 |
| `snapshotSourceFacts` | 3 |
| `SOURCE_TYPE_ORDER` | 3 |

### `src/backend/vcc-financial-op/operation-token-v2.js`

| 名字 | 总次数 |
|---|---:|
| `archiveStructuralEvidence` | 3 |
| `canonicalGateEvidence` | 3 |
| `canonicalResultMutationGateEvidence` | 3 |

### `src/backend/vcc-financial-op/pending-template-contract.js`

| 名字 | 总次数 |
|---|---:|
| `PENDING_TEMPLATE_FILE_NAME` | 4 |

### `src/backend/vcc-financial-op/preserved-state.js`

| 名字 | 总次数 |
|---|---:|
| `addFingerprint` | 38 |
| `maxId` | 6 |
| `IMPORT_AUDIT_COLUMNS` | 4 |
| `PRESERVED_STATE_VERSION` | 4 |
| `EFFECTIVE_FACT_COLUMNS` | 3 |
| `removeInternalColumns` | 3 |
| `SYSTEM_ATTEMPT_AUDIT_COLUMNS` | 3 |
| `SYSTEM_SNAPSHOT_COLUMNS` | 3 |

### `src/backend/vcc-financial-op/read-schema.js`

| 名字 | 总次数 |
|---|---:|
| `assertVccSchemaReady` | 3 |
| `REQUIRED_INDEXES` | 3 |
| `REQUIRED_PRIMARY_KEYS` | 3 |
| `REQUIRED_TABLE_COLUMNS` | 3 |

### `src/backend/vcc-financial-op/read-snapshot.js`

| 名字 | 总次数 |
|---|---:|
| `executeQuery` | 29 |
| `withCandidates` | 11 |
| `ACTIVE_MONTHS_SQL` | 3 |
| `ARCHIVE_CANDIDATE_SQL` | 3 |
| `loadResultMutationGateEvidence` | 3 |
| `parseJsonEvidence` | 3 |

### `src/backend/vcc-financial-op/result-adjustments.js`

| 名字 | 总次数 |
|---|---:|
| `resultStateError` | 44 |
| `canonicalFinalAmount` | 9 |
| `resultRevisionChanged` | 6 |
| `subjectCurrencyKey` | 6 |
| `accumulateAmounts` | 5 |
| `requireEffectiveRun` | 4 |
| `addAmount` | 3 |
| `emptyCurrencyAmounts` | 3 |
| `finalizeSummaryAmounts` | 3 |
| `normalizedRunRowMetadata` | 3 |
| `normalizeExpectedResultRevision` | 3 |
| `RESULT_REVISION_CHANGED_CODE` | 3 |
| `RESULT_REVISION_CHANGED_MESSAGE` | 3 |
| `RUN_ROW_KEY_VERSION` | 3 |

### `src/backend/vcc-financial-op/result-evidence.js`

| 名字 | 总次数 |
|---|---:|
| `pushViolation` | 31 |
| `addToAmountMap` | 3 |
| `finalizedAmountMap` | 3 |
| `RESULT_VALIDATION_VERSION` | 3 |

### `src/backend/vcc-financial-op/result-template-contract.js`

| 名字 | 总次数 |
|---|---:|
| `deepClone` | 14 |
| `isMergedPair` | 11 |
| `contractMismatch` | 6 |
| `captureCellStyle` | 5 |
| `contractCache` | 5 |
| `isNonEmptyObject` | 5 |
| `RESULT_TEMPLATE_PRINT_AREA` | 5 |
| `ResultTemplateContractError` | 5 |
| `statIdentity` | 5 |
| `RESULT_TEMPLATE_BUSINESS_RANGE` | 4 |
| `RESULT_TEMPLATE_FILE_SHA256` | 4 |
| `RESULT_TEMPLATE_PHYSICAL_RANGE` | 4 |
| `captureRowStyle` | 3 |
| `inspectResultTemplateWorkbook` | 3 |

### `src/backend/vcc-financial-op/result-write.js`

| 名字 | 总次数 |
|---|---:|
| `resultWriteError` | 24 |
| `fullRunRow` | 5 |
| `RESULT_OPERATION_TYPES` | 4 |
| `assertCurrentCalculatedEvidence` | 3 |
| `assertResultMutationPostconditions` | 3 |
| `buildResultMutationPlan` | 3 |
| `commonCalculatedEvidenceValid` | 3 |
| `executeLockedResultMutation` | 3 |
| `isLegacyCalculatedEvidence` | 3 |
| `normalizeOperationPayload` | 3 |
| `revisionsMatch` | 3 |
| `sameTextSet` | 3 |

### `src/backend/vcc-financial-op/row-mapper.js`

| 名字 | 总次数 |
|---|---:|
| `failRow` | 10 |
| `requireText` | 8 |
| `requireSupportedCurrency` | 7 |
| `negateDecimal` | 4 |
| `formatDate` | 3 |
| `HASH_VERSION` | 3 |
| `monthEndIso` | 3 |
| `rawText` | 3 |
| `signByDirection` | 3 |
| `TEXT_CELL_TYPES` | 3 |

### `src/backend/vcc-financial-op/system-op-importer.js`

| 名字 | 总次数 |
|---|---:|
| `systemRowError` | 9 |
| `lexicalStructureError` | 8 |
| `rowField` | 8 |
| `insertAttempt` | 6 |
| `displayAmountToken` | 5 |
| `validationUnitCount` | 5 |
| `workbookFileText` | 5 |
| `addSystemValidationAnomaly` | 4 |
| `rawNumericToken` | 4 |
| `addSystemConflictAnomaly` | 3 |
| `assertUniqueSystemBusinessSheet` | 3 |
| `findSystemHeader` | 3 |
| `meaningfulPreview` | 3 |
| `normalizeSystemCurrency` | 3 |
| `readSystemOpSnapshots` | 3 |
| `systemAmountRead` | 3 |
| `systemBalanceLexicalTokens` | 3 |
| `worksheetEntryPath` | 3 |

### `src/backend/vcc-financial-op/unarchive.js`

| 名字 | 总次数 |
|---|---:|
| `UNARCHIVE_OPERATION` | 10 |
| `inspectArchiveConsistencyFromState` | 5 |
| `logExcludedArchiveMonth` | 4 |
| `inspectRunBalanceSubjects` | 3 |

### `src/backend/vcc-financial-op/workbook-reader.js`

| 名字 | 总次数 |
|---|---:|
| `pendingContractError` | 6 |
| `legacyPendingTemplateError` | 5 |
| `findSystemOpHeaders` | 4 |
| `openWorkbookSheets` | 4 |
| `inspectSourceFile` | 3 |
| `PREVIEW_COLUMN_COUNT` | 3 |
| `previewSheet` | 3 |

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

### `src/constants/fund-transfer-recon-fields.js`

| 名字 | 总次数 |
|---|---:|
| `__missingMid` | 3 |

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

### `src/constants/payment-offline-allocation-fields.js`

| 名字 | 总次数 |
|---|---:|
| `__missingReconColumns` | 3 |

### `src/constants/refund-backfill-fields.js`

| 名字 | 总次数 |
|---|---:|
| `__missingRoColumns` | 3 |

### `src/constants/table-signatures.js`

| 名字 | 总次数 |
|---|---:|
| `LINKED_TABLE_SIGNATURES` | 4 |
| `BANK_STATEMENT_SIGNATURE` | 3 |
| `FX_OPTION_SIGNATURE` | 3 |
| `GATEWAY_RECON_SIGNATURE` | 3 |
| `INTAKE_ORIGINAL_ORDER_SIGNATURE` | 3 |

### `src/main-process/acquiring-bill-currency-run-data.js`

| 名字 | 总次数 |
|---|---:|
| `openResumeSource` | 4 |
| `runFileEvidence` | 4 |
| `acquiringRunFlowIdentity` | 3 |
| `prepareRunExport` | 3 |
| `readResumeTarget` | 3 |

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

### `src/main-process/app-updater.js`

| 名字 | 总次数 |
|---|---:|
| `DISTRIBUTIONS` | 7 |
| `createServiceError` | 5 |
| `AppUpdaterService` | 3 |
| `extractVersion` | 3 |
| `isCancellationError` | 3 |
| `isStrictStableUpgrade` | 3 |
| `parseStableSemver` | 3 |
| `PRODUCTION_UPDATER_CONFIG` | 3 |
| `UPDATE_STATES` | 3 |

### `src/main-process/archive-center/archive-runtime-delegate.js`

| 名字 | 总次数 |
|---|---:|
| `ADMISSION_METHODS` | 3 |
| `ArchiveRuntimeDelegate` | 3 |
| `maintenanceFailure` | 3 |

### `src/main-process/archive-center/archive-service.js`

| 名字 | 总次数 |
|---|---:|
| `ArchiveOperationError` | 28 |
| `safeFailure` | 23 |
| `MAX_MATERIALIZATION_BATCH_SIZE` | 9 |
| `BLOB_ROOT_PARTS` | 6 |
| `ROOT_MUTATION_TAILS` | 5 |
| `blobRelativePath` | 4 |
| `READONLY_DIR_NAME` | 4 |
| `safeCode` | 4 |
| `STAGING_DIR_NAME` | 4 |
| `ArchiveService` | 3 |
| `DEFAULT_STARTUP_MATERIALIZATION_BATCH_SIZE` | 3 |
| `isFileIntegrityFailure` | 3 |
| `isPathInside` | 3 |
| `normalizeExpectedFileEvidence` | 3 |
| `publicMetadata` | 3 |
| `publicRelatedBatch` | 3 |

### `src/main-process/archive-center/business-flow-resolver.js`

| 名字 | 总次数 |
|---|---:|
| `normalizeIdentities` | 4 |
| `normalizeIdentity` | 4 |
| `BusinessFlowResolver` | 3 |
| `FORBIDDEN_IDENTITY_TYPES` | 3 |

### `src/main-process/archive-center/controller.js`

| 名字 | 总次数 |
|---|---:|
| `normalizeTerminalOutcome` | 7 |
| `artifactSupportsReplacementRetry` | 5 |
| `ALLOWED_RETENTION_DAYS` | 4 |
| `ARCHIVE_RETENTION_SETTING_KEY` | 4 |
| `filesHaveDurableArtifacts` | 4 |
| `ARCHIVE_TEMPLATE_EXCLUSIONS_SETTING_KEY` | 3 |
| `ArchiveCenterController` | 3 |
| `parseRetentionDays` | 3 |
| `publicRetryFailure` | 3 |

### `src/main-process/archive-center/file-plan.js`

| 名字 | 总次数 |
|---|---:|
| `planError` | 19 |
| `artifactKeyOf` | 3 |
| `manifestIdentityOf` | 3 |
| `normalizeItem` | 3 |

### `src/main-process/archive-center/module-scope-registry.js`

| 名字 | 总次数 |
|---|---:|
| `ARCHIVE_SCOPE_ALIASES` | 4 |
| `VISIBLE_ARCHIVE_SCOPES` | 4 |
| `ARCHIVE_UTILITY_SCOPES` | 3 |
| `getArchiveScope` | 3 |
| `PRIMARY_ARCHIVE_SCOPES` | 3 |
| `SCOPE_BY_ID` | 3 |

### `src/main-process/archive-center/operation-tracker.js`

| 名字 | 总次数 |
|---|---:|
| `moduleDescriptor` | 18 |
| `normalizePathList` | 17 |
| `FILE_CHANNELS` | 5 |
| `resolveOperationFiles` | 4 |
| `buildFileSpecs` | 3 |
| `firstPayload` | 3 |
| `mapSelectionsToResults` | 3 |
| `RESULT_OUTPUT_KEYS` | 3 |
| `successfulVccImportPaths` | 3 |

### `src/main-process/archive-center/outbox-store.js`

| 名字 | 总次数 |
|---|---:|
| `stableSerialize` | 10 |
| `outboxConflict` | 6 |
| `OUTBOX_ID_PREFIX` | 5 |
| `normalizeFiles` | 4 |
| `OUTBOX_VERSION` | 4 |
| `recordIntegrityHash` | 4 |
| `ArchiveOutboxStore` | 3 |
| `normalizeRecord` | 3 |

### `src/main-process/archive-center/scenario-import-context-store.js`

| 名字 | 总次数 |
|---|---:|
| `ScenarioImportContextStore` | 3 |

### `src/main-process/archive-center/source-snapshot.js`

| 名字 | 总次数 |
|---|---:|
| `addPathValues` | 9 |
| `addPath` | 5 |
| `collectArchiveCandidatePaths` | 3 |

### `src/main-process/archive-center/storage-materializer.js`

| 名字 | 总次数 |
|---|---:|
| `StorageMaterializationError` | 7 |
| `assertNoSymlinkAncestors` | 6 |

### `src/main-process/archive-center/storage-root-manager.js`

| 名字 | 总次数 |
|---|---:|
| `ArchiveStorageRootError` | 49 |
| `comparablePath` | 17 |
| `toRelativePath` | 15 |
| `normalizeRoot` | 10 |
| `ROOT_MARKER_FILE` | 9 |
| `validateMarker` | 7 |
| `INTERNAL_TRANSIENT_DIRS` | 5 |
| `MIGRATION_JOURNAL_SCHEMA_VERSION` | 5 |
| `pathExists` | 5 |
| `exactMarker` | 4 |
| `parentRelativePaths` | 4 |
| `ROOT_MARKER_SCHEMA_VERSION` | 4 |
| `ROOT_MARKER_TYPE` | 4 |
| `ArchiveStorageRootManager` | 3 |
| `MIGRATION_PHASES` | 3 |
| `pathsOverlap` | 3 |
| `syncDirectory` | 3 |
| `validateJournal` | 3 |

### `src/main-process/archive-center/task-file-plan-registry.js`

| 名字 | 总次数 |
|---|---:|
| `eager` | 62 |
| `preparedPickerPlan` | 8 |
| `requiredPreparedFilePlan` | 6 |
| `preparedExportPlan` | 5 |
| `preparedPayloadPlan` | 5 |
| `deferred` | 3 |
| `FILE_PLAN_RESOLVERS_BY_SOURCE_KIND` | 3 |
| `preparedWorkerPlan` | 3 |

### `src/main-process/archive-center/task-lifecycle.js`

| 名字 | 总次数 |
|---|---:|
| `lifecycleFailure` | 22 |
| `createWorkerOperationContextFromTask` | 7 |
| `createWorkerBatchContextFromBatch` | 6 |
| `createWorkerBatchContext` | 5 |
| `taskResultStatus` | 5 |
| `taskPayloadMetadata` | 4 |
| `TaskLifecycle` | 3 |

### `src/main-process/archive-center/task-lineage.js`

| 名字 | 总次数 |
|---|---:|
| `lineageIntentKey` | 5 |
| `requiredLineageText` | 5 |

### `src/main-process/archive-center/task-policy-registry.js`

| 名字 | 总次数 |
|---|---:|
| `vccFlowIdentity` | 7 |
| `classifyKnownStatus` | 5 |
| `NO_FILE_ACTION_CHANNELS` | 5 |
| `FILE_ACTION_CHANNELS` | 4 |
| `standardResultMetadataResolver` | 4 |
| `acquiringExportPlan` | 3 |
| `ARCHIVE_TASK_POLICIES` | 3 |
| `bankBuImportResultFlowIdentities` | 3 |
| `bankBuRunFlowPlan` | 3 |
| `bankStatementExportFlowPlan` | 3 |
| `buildPolicies` | 3 |
| `CONTINUATION_CHANNELS` | 3 |
| `EXCLUDE_REASONS` | 3 |
| `EXCLUDED_CHANNELS_BY_REASON` | 3 |
| `invocationBusinessRunIdentity` | 3 |
| `positionResultClassifier` | 3 |
| `RESERVE_CHANNELS_BY_SCOPE` | 3 |
| `resolveBankBuImportEvidence` | 3 |
| `resultBusinessRunIdentities` | 3 |
| `standardResultClassifier` | 3 |
| `statementResultClassifier` | 3 |
| `TaskPolicyRegistry` | 3 |
| `vccDeleteFlowPlan` | 3 |
| `vccFinancialOpResultClassifier` | 3 |
| `vccImportResultFlowIdentities` | 3 |
| `vccInvocationPayload` | 3 |
| `vccRunFlowIdentity` | 3 |

### `src/main-process/archive-center/worker-batch-context.js`

| 名字 | 总次数 |
|---|---:|
| `WORKER_BATCH_CONTEXT_FIELDS` | 3 |

### `src/main-process/archive-center/worker-operation-context.js`

| 名字 | 总次数 |
|---|---:|
| `WORKER_OPERATION_CONTEXT_FIELDS` | 4 |

### `src/main-process/bank-bu-recon-writer.js`

| 名字 | 总次数 |
|---|---:|
| `rowDbObjectToArray` | 5 |
| `DIFF_OUTPUT_ANOMALY_SHEET` | 4 |
| `ANOMALY_HEADERS_AGGREGATE` | 3 |
| `anomalyRowToArray` | 3 |
| `buildOutputPath` | 3 |

### `src/main-process/bank-statement-io.js`

| 名字 | 总次数 |
|---|---:|
| `GATEWAY_RECON_SHEET_NAME` | 3 |

### `src/main-process/bank-statement-merge.js`

| 名字 | 总次数 |
|---|---:|
| `bankStatementHeadersEqual` | 3 |

### `src/main-process/big-account-recognition.js`

| 名字 | 总次数 |
|---|---:|
| `buildDetailLines` | 4 |
| `stripSpecialCharsForMatch` | 3 |

### `src/main-process/biz-op-archive-lineage.js`

| 名字 | 总次数 |
|---|---:|
| `datasetHeads` | 4 |

### `src/main-process/biz-op-recon-run-data.js`

| 名字 | 总次数 |
|---|---:|
| `monthEndCopyConflict` | 13 |
| `recoveryConflict` | 7 |
| `acknowledgeMonthEndCopyIntent` | 4 |
| `applyMonthEndCopyIntent` | 4 |
| `assertIntentHead` | 3 |
| `copyRunIntoMemDb` | 3 |
| `ensureSideDbExists` | 3 |
| `freezeRunLocator` | 3 |
| `RANGE_IMPORT_ID_STRIDE` | 3 |
| `RANGE_RUN_ID_STRIDE` | 3 |

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

### `src/main-process/duplicate-inbound-match/document-statement-reader.js`

| 名字 | 总次数 |
|---|---:|
| `DOCUMENT_FIELD_INDICES` | 7 |
| `assertExactHeaders` | 3 |
| `DOCUMENT_FIELDS` | 3 |
| `DOCUMENT_VALUE_COLUMN_WHITELIST` | 3 |

### `src/main-process/duplicate-inbound-match/excel-writer.js`

| 名字 | 总次数 |
|---|---:|
| `MAIL_HEADERS` | 13 |
| `DuplicateInboundExportError` | 9 |
| `outputVerificationError` | 5 |
| `MAIL_SHEET_NAME` | 4 |
| `MANUAL_REASON_HEADER` | 4 |
| `MANUAL_SHEET_NAME` | 4 |
| `assertHeaders` | 3 |
| `assertTemplateFile` | 3 |
| `buildWorkbook` | 3 |
| `validateWrittenWorkbook` | 3 |

### `src/main-process/duplicate-inbound-match/matching-engine.js`

| 名字 | 总次数 |
|---|---:|
| `MANUAL_REASON_CODES` | 32 |
| `ERROR_CODES` | 30 |
| `DuplicateInboundMatchError` | 25 |
| `originalText` | 21 |
| `firstPresent` | 18 |
| `pushReason` | 14 |
| `trimmedText` | 11 |
| `structuredKey` | 9 |
| `compareGroups` | 8 |
| `groupRowCount` | 8 |
| `amountError` | 7 |
| `assertIterable` | 6 |
| `compareBankRecords` | 6 |
| `decorateAndSortGroups` | 5 |
| `DOCUMENT_IDENTITY_FIELDS` | 5 |
| `normalizeOrderValue` | 5 |
| `addReasonCount` | 4 |
| `sortReasons` | 4 |
| `GROUP_TEXT_FIELDS` | 3 |
| `MANUAL_REASON_ORDER` | 3 |
| `MANUAL_REASON_PRIORITY` | 3 |
| `materializeBankGroup` | 3 |
| `normalizeDuplicateInboundAmount` | 3 |
| `reasonCodesOf` | 3 |
| `validateCandidateGroup` | 3 |

### `src/main-process/duplicate-inbound-match/service.js`

| 名字 | 总次数 |
|---|---:|
| `DuplicateInboundMatchServiceError` | 13 |
| `trimText` | 7 |
| `runInvalidationActions` | 4 |
| `toDocumentLineage` | 4 |
| `toMptLineage` | 4 |
| `DuplicateInboundMatchService` | 3 |
| `identifyInputFiles` | 3 |
| `MAIL_REMARK` | 3 |
| `mirrorSafeError` | 3 |
| `pickBankFields` | 3 |
| `validateBizIds` | 3 |

### `src/main-process/exceljs-writer.js`

| 名字 | 总次数 |
|---|---:|
| `POF` | 15 |
| `cellToString` | 9 |
| `applyPaymentAuditSheetLayout` | 4 |
| `MARK_WITHOUT_RESULT` | 4 |
| `PAYMENT_OFFLINE_SHEET` | 4 |
| `buildHitDetail` | 3 |
| `buildManyToManyNoteByRowId` | 3 |
| `HIT_DETAIL_HEADER` | 3 |
| `MANY_TO_MANY_NOTE_HEADER` | 3 |
| `resolveReconIdCell` | 3 |
| `SHEET1_A1_NOTICE` | 3 |
| `SHEET1_UNMATCHED_NAME` | 3 |
| `SHEET2_HIT_NAME` | 3 |
| `stripInternalFields` | 3 |
| `wrapHitValue` | 3 |

### `src/main-process/financial-decimal.js`

| 名字 | 总次数 |
|---|---:|
| `createDecimalError` | 9 |
| `MAX_CANONICAL_DECIMAL_LENGTH` | 4 |
| `canonicalDecimalParts` | 3 |
| `combineCanonicalDecimals` | 3 |
| `FinancialDecimalError` | 3 |
| `pairToScaledIntegers` | 3 |

### `src/main-process/fund-transfer-date-policy.js`

| 名字 | 总次数 |
|---|---:|
| `cloneValue` | 5 |
| `DEFAULT_DATE_MATCH_ENABLED` | 5 |
| `DEFAULT_DATE_TOLERANCE_DAYS` | 5 |
| `FundTransferPolicyConfigError` | 4 |
| `makeWarning` | 4 |
| `normalizeForStableStringify` | 4 |
| `describeRawConfigValue` | 3 |
| `describeScenario` | 3 |
| `FUND_TRANSFER_OWNER_CATEGORY` | 3 |
| `FUND_TRANSFER_OWNER_FUNC_CATEGORY` | 3 |
| `FUND_TRANSFER_OWNER_SUB_CATEGORY` | 3 |
| `FUND_TRANSFER_POLICY_SCENARIO_NAME` | 3 |
| `FUND_TRANSFER_POLICY_SCHEMA_VERSION` | 3 |
| `makeSignature` | 3 |
| `MAX_DATE_TOLERANCE_DAYS` | 3 |
| `MIN_DATE_TOLERANCE_DAYS` | 3 |

### `src/main-process/import-dialog-state.js`

| 名字 | 总次数 |
|---|---:|
| `EXTRA_IMPORT_DIALOG_SCOPES` | 3 |
| `getImportDialogDefaultPath` | 3 |
| `rememberImportDialogDirectory` | 3 |
| `resolveExistingDirectory` | 3 |
| `STAT_TIMEOUT_MS` | 3 |

### `src/main-process/manual-balance-seed-preflight.js`

| 名字 | 总次数 |
|---|---:|
| `buildManualBalanceInvalidResult` | 5 |
| `manualBalancePreflightError` | 4 |
| `balanceSeedRecordKey` | 3 |
| `buildManualBalanceSeedPlan` | 3 |
| `formatDateLabel` | 3 |

### `src/main-process/monthly-balance.js`

| 名字 | 总次数 |
|---|---:|
| `buildTargetLastDay` | 3 |
| `isRegularTemplate` | 3 |
| `lastDayOfMonth` | 3 |
| `pickLatestSeedForAccount` | 3 |

### `src/main-process/pending-archive-lineage.js`

| 名字 | 总次数 |
|---|---:|
| `pendingRecoveryError` | 6 |
| `diffRepository` | 5 |
| `acknowledgePendingRun` | 4 |
| `PENDING_MODULE_ID` | 4 |
| `PENDING_RUN_TASK_KEY` | 3 |

### `src/main-process/pending-import-preflight.js`

| 名字 | 总次数 |
|---|---:|
| `buildPendingImportConfirmationResult` | 3 |
| `pendingImportFilePlan` | 3 |
| `validatePendingImportPayload` | 3 |

### `src/main-process/platform-cleanup-writer.js`

| 名字 | 总次数 |
|---|---:|
| `CLEANUP_SHEET_NAME` | 3 |

### `src/main-process/position-reconciliation/common.js`

| 名字 | 总次数 |
|---|---:|
| `decimalToCents` | 4 |

### `src/main-process/position-reconciliation/contracts.js`

| 名字 | 总次数 |
|---|---:|
| `pairDefinition` | 11 |
| `PAIR_DEFINITIONS` | 3 |

### `src/main-process/position-reconciliation/decimal.js`

| 名字 | 总次数 |
|---|---:|
| `amountFailure` | 8 |
| `canonicalToCents` | 4 |

### `src/main-process/position-reconciliation/derivation.js`

| 名字 | 总次数 |
|---|---:|
| `deriveBankAccount` | 3 |
| `deriveFundTransfer` | 3 |
| `deriveGatewayInbound` | 3 |
| `deriveGatewayOutbound` | 3 |
| `deriveTestPayment` | 3 |
| `mappedAccount` | 3 |
| `VALID_STATUS_SET` | 3 |

### `src/main-process/position-reconciliation/excel-io.js`

| 名字 | 总次数 |
|---|---:|
| `atomicWorkbookWrite` | 4 |
| `requiresTextFormat` | 4 |
| `writeTableWorkbook` | 4 |
| `applyTextColumnFormats` | 3 |
| `applyTextFormats` | 3 |

### `src/main-process/position-reconciliation/filtered-source-report.js`

| 名字 | 总次数 |
|---|---:|
| `integrityError` | 10 |
| `initializeSheet` | 4 |
| `normalizeReportReference` | 3 |
| `projectValuesByHeaderOccurrence` | 3 |
| `streamAnomalyDetailRows` | 3 |

### `src/main-process/position-reconciliation/import-dispatch.js`

| 名字 | 总次数 |
|---|---:|
| `fatalError` | 6 |
| `monotonicNowMs` | 4 |
| `WORKER_ENTRY` | 4 |
| `cleanupUncommittedImportArtifacts` | 3 |
| `uncommittedJobRoot` | 3 |
| `workerExitedError` | 3 |

### `src/main-process/position-reconciliation/import-recovery.js`

| 名字 | 总次数 |
|---|---:|
| `recoveryRequired` | 20 |
| `inputPathKey` | 15 |
| `assertCommittedFileSet` | 3 |
| `expectedInputEvidence` | 3 |
| `jobRootFromPreflight` | 3 |
| `proofMatchesExpected` | 3 |
| `rebuildAccountResult` | 3 |
| `rebuildBankResult` | 3 |
| `rebuildOrdinarySourceResult` | 3 |
| `resultInputEvidence` | 3 |

### `src/main-process/position-reconciliation/input-staging.js`

| 名字 | 总次数 |
|---|---:|
| `sourceStat` | 8 |
| `sourceStatAsync` | 8 |
| `HASH_BUFFER_SIZE` | 5 |
| `sameSourceStat` | 5 |
| `hashFileSha256Sync` | 4 |

### `src/main-process/position-reconciliation/interactive-task-preflight.js`

| 名字 | 总次数 |
|---|---:|
| `positionPreflightFailure` | 5 |
| `checkpointEvidence` | 4 |
| `preparePositionRunSubmission` | 3 |

### `src/main-process/position-reconciliation/large-import-schema.js`

| 名字 | 总次数 |
|---|---:|
| `schemaError` | 32 |
| `sameColumns` | 10 |
| `indexDescriptors` | 5 |
| `findIndexByColumns` | 4 |
| `POSITION_LARGE_IMPORT_SCHEMA_FINGERPRINT_KEY` | 4 |
| `assertNoDuplicateSourceLeg` | 3 |
| `assertPositionMigrationDiskSpace` | 3 |
| `ensurePositionLargeImportSchema` | 3 |
| `LEGACY_SOURCE_COLUMNS` | 3 |
| `MODERN_CONSUMED_COLUMNS` | 3 |
| `MODERN_LINK_COLUMNS` | 3 |
| `MODERN_SOURCE_COLUMNS` | 3 |
| `REQUIRED_NAMED_INDEXES` | 3 |
| `schemaSignature` | 3 |

### `src/main-process/position-reconciliation/logical-accounts.js`

| 名字 | 总次数 |
|---|---:|
| `accountIssue` | 7 |
| `matchAccountFields` | 4 |
| `accountAliases` | 3 |
| `BANK_ACCOUNT_FIELDS` | 3 |

### `src/main-process/position-reconciliation/matching-engine.js`

| 名字 | 总次数 |
|---|---:|
| `failureEvaluation` | 9 |
| `resolveStrictOneToOne` | 7 |
| `linkedInputRows` | 6 |
| `lookupByBankIdentifiers` | 5 |
| `makePool` | 5 |
| `uniqueMessages` | 5 |
| `applyResolvedOutcome` | 4 |
| `candidateEvaluation` | 4 |
| `compareLocalCalendarDays` | 4 |
| `consumedSourceMessage` | 4 |
| `evaluateTransferBank` | 4 |
| `formatIdentifierEvidence` | 4 |
| `applyNotApplicable` | 3 |
| `directionFailure` | 3 |
| `evaluateGatewayBank` | 3 |
| `evaluateInboundCurrency` | 3 |
| `evaluateOutboundCurrency` | 3 |
| `FUZZY_PAYMENT_STATUSES` | 3 |
| `makeBankRecord` | 3 |
| `manualFromEvaluation` | 3 |
| `PRECISE_PAYMENT_STATUS` | 3 |

### `src/main-process/position-reconciliation/operation-lifecycle.js`

| 名字 | 总次数 |
|---|---:|
| `recoveryIntegrityError` | 13 |
| `recoveryInputKey` | 10 |
| `assertSameArchiveInputEvidence` | 3 |
| `assertSameArchiveOutputEvidence` | 3 |
| `positionPendingOwner` | 3 |
| `positionPreflightAcceptedInputFiles` | 3 |
| `positionPreflightAnomalyOutputFiles` | 3 |
| `positionUncommittedRecoveryInputPaths` | 3 |

### `src/main-process/position-reconciliation/readers.js`

| 名字 | 总次数 |
|---|---:|
| `requireDecimal` | 5 |
| `invalidEvidenceFields` | 4 |
| `normalizeFileInput` | 4 |
| `ensureReadableWorkbook` | 3 |
| `objectsFromRows` | 3 |
| `readSourceFile` | 3 |

### `src/main-process/position-reconciliation/service.js`

| 名字 | 总次数 |
|---|---:|
| `stagedInputArchiveFile` | 13 |
| `sourceConsumptionKey` | 6 |
| `pureDateValue` | 5 |
| `requireScopeSelection` | 5 |
| `sameExcelDateTime` | 5 |
| `FUND_TYPE_PAIR_BY_VALUE` | 4 |
| `assertEngineResultSet` | 3 |
| `legacySourceImportSummary` | 3 |
| `PositionReconciliationService` | 3 |
| `priorBankConsumptionConflict` | 3 |
| `requiredSourceTypes` | 3 |

### `src/main-process/position-reconciliation/side-db-mutation.js`

| 名字 | 总次数 |
|---|---:|
| `normalizeOperationInputEvidence` | 4 |
| `operationInputEvidenceHash` | 4 |
| `recordPositionOperationInputs` | 3 |

### `src/main-process/position-reconciliation/source-summary-cache.js`

| 名字 | 总次数 |
|---|---:|
| `ensurePositionSourceSummaryCache` | 4 |
| `revisionTimestamp` | 3 |

### `src/main-process/position-reconciliation/store.js`

| 名字 | 总次数 |
|---|---:|
| `throwInvalidSideData` | 54 |
| `checkpointMismatch` | 14 |
| `incompleteSideDatabaseError` | 13 |
| `assertBankPayload` | 9 |
| `assertPayloadFields` | 8 |
| `assertSameTextSet` | 8 |
| `assertStoredCounter` | 8 |
| `decodeScopeKey` | 8 |
| `consumptionRelationKey` | 7 |
| `assertStoredTextList` | 5 |
| `POSITION_DB_INITIALIZATION_MODES` | 5 |
| `quoteSqlIdentifier` | 5 |
| `sameStoredValue` | 5 |
| `assertRunLineage` | 4 |
| `assertRunSnapshot` | 4 |
| `assertRevisionMap` | 3 |
| `assertRunRowContract` | 3 |
| `assertSupportedEmptyLegacyDatabase` | 3 |
| `DATE_JSON_TYPE_KEY` | 3 |
| `normalizeSchemaSql` | 3 |
| `PositionReconciliationStore` | 3 |
| `runFilteredSourceIntegrityHash` | 3 |
| `SCHEMA` | 3 |
| `SUPPORTED_EMPTY_LEGACY_INDEX_INFO` | 3 |
| `SUPPORTED_EMPTY_LEGACY_TABLE_INFO` | 3 |

### `src/main-process/pre-fund-archive-lineage.js`

| 名字 | 总次数 |
|---|---:|
| `datasetIntent` | 4 |
| `PRE_FUND_MODULE_ID` | 4 |
| `PRE_FUND_RUN_TASK_KEY` | 3 |

### `src/main-process/pre-fund-reconciliation/bank-row.js`

| 名字 | 总次数 |
|---|---:|
| `decimalError` | 4 |
| `financialDecimal` | 4 |
| `buildStableTraceId` | 3 |
| `locationText` | 3 |
| `pickFirstValue` | 3 |
| `resolveBankRowContext` | 3 |

### `src/main-process/pre-fund-reconciliation/excel-writer.js`

| 名字 | 总次数 |
|---|---:|
| `SHEET_NAMES` | 14 |
| `clonePlain` | 9 |
| `PreFundTemplateError` | 7 |
| `DUPLICATE_SHEET_NAME` | 6 |
| `appendRows` | 5 |
| `loadTemplateWorkbook` | 4 |
| `TEMPLATE_SHEETS` | 4 |
| `assertExcelDataRowCapacity` | 3 |
| `assertRowsIterable` | 3 |
| `copyWorksheetShell` | 3 |
| `DUPLICATE_SHEET_CONTRACT` | 3 |
| `EXCEL_MAX_DATA_ROWS` | 3 |
| `formatLocalExportDate` | 3 |
| `PUBLICATION_IDENTITY` | 3 |
| `validateTemplateWorkbook` | 3 |
| `writeChannelWorkbook` | 3 |

### `src/main-process/pre-fund-reconciliation/matching-engine.js`

| 名字 | 总次数 |
|---|---:|
| `readGatewayValue` | 27 |
| `formatGatewayLocation` | 13 |
| `assertSyncIterable` | 5 |
| `createStats` | 5 |
| `gatewayLocation` | 5 |
| `unwrapGatewayRow` | 5 |
| `assertConservation` | 4 |
| `fingerprintFromFields` | 4 |
| `normalizeGatewayFingerprintFields` | 4 |
| `validateDateParts` | 4 |
| `buildGatewayPools` | 3 |
| `canonicalizeDate` | 3 |
| `FIELD_ALIASES` | 3 |
| `FINGERPRINT_FIELDS` | 3 |
| `gatewayCandidateMatches` | 3 |
| `rawGatewayBusinessJson` | 3 |
| `readOwnValue` | 3 |

### `src/main-process/pre-fund-reconciliation/mpt-error-report-writer.js`

| 名字 | 总次数 |
|---|---:|
| `excelSafeField` | 8 |
| `RAW_LINE_CHUNK_SIZE` | 5 |
| `META_HEADERS` | 4 |
| `SHEET_CONTRACTS` | 4 |
| `RAW_LINE_HEADER` | 3 |

### `src/main-process/pre-fund-reconciliation/mpt-parser.js`

| 名字 | 总次数 |
|---|---:|
| `MAX_LINE_LENGTH` | 5 |
| `DEFAULT_BATCH_SIZE` | 3 |
| `DEFAULT_ROW_ERROR_SAMPLE_LIMIT` | 3 |

### `src/main-process/pre-fund-reconciliation/mpt-schema.js`

| 名字 | 总次数 |
|---|---:|
| `normalizeDecimalString` | 6 |
| `MPT_EXPECTED_FIELD_COUNT` | 4 |
| `isValidDateParts` | 3 |
| `isValidDateTime` | 3 |

### `src/main-process/pre-fund-reconciliation/output-mapper.js`

| 名字 | 总次数 |
|---|---:|
| `BANK_SOURCE` | 4 |
| `assertOutputConservation` | 3 |
| `DUPLICATE_RAW_JSON_CHUNK_SIZE` | 3 |
| `formatDuplicateDataPosition` | 3 |
| `gatewayFields` | 3 |
| `listResultChannels` | 3 |
| `mapDuplicateAuditRow` | 3 |

### `src/main-process/pre-fund-reconciliation/reconciliation-rules.js`

| 名字 | 总次数 |
|---|---:|
| `BANK_DIRECTION` | 16 |
| `freezeRule` | 15 |
| `normalizeRuleCell` | 4 |
| `RULES_BY_FUND_TYPE` | 4 |
| `RECONCILIATION_RULES` | 3 |

### `src/main-process/pre-fund-reconciliation/service.js`

| 名字 | 总次数 |
|---|---:|
| `PreFundReconciliationError` | 8 |
| `SCENARIO_MISSING_GATEWAY` | 6 |
| `assertSameIdentitySet` | 3 |
| `errorResult` | 3 |
| `PreFundReconciliationService` | 3 |
| `requireManagedMptSourceType` | 3 |

### `src/main-process/recon-id-fix-io.js`

| 名字 | 总次数 |
|---|---:|
| `readSheetOrThrow` | 6 |
| `PRE_FUND_UNBALANCED_SHEET_NAME` | 5 |
| `PRE_FUND_BALANCED_SHEET_NAME` | 4 |
| `PRE_FUND_DUPLICATE_GATEWAY_SHEET_NAME` | 4 |
| `PRE_FUND_SOURCE_FIELD` | 3 |
| `PRE_FUND_UNBALANCED_FIELDS_LEGACY` | 3 |

### `src/main-process/reconciliation-orchestrator.js`

| 名字 | 总次数 |
|---|---:|
| `bucketScenarios` | 3 |
| `buildChannelRegionHits` | 3 |
| `buildOutputRows` | 3 |
| `hasActualFieldChanges` | 3 |

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

### `src/main-process/scenario-engines/bank-direction-validator.js`

| 名字 | 总次数 |
|---|---:|
| `parseOptionalDecimal` | 3 |

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
| `chooseC3MatchedCandidatePreferExistingAssignValue` | 3 |
| `gwMatchesBank` | 3 |

### `src/main-process/scenario-engines/c4-recon-id-fix.js`

| 名字 | 总次数 |
|---|---:|
| `resolveSubBizType` | 14 |
| `parseBillDateMs` | 10 |
| `billDateMatches` | 8 |
| `lookupReconId` | 8 |
| `computeCommonId` | 5 |
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

### `src/main-process/scenario-engines/dbs-charge-fund-check.js`

| 名字 | 总次数 |
|---|---:|
| `BANK_ROW_ID_FIELD` | 15 |
| `DISP` | 9 |
| `DISP_BILL_DATE_FIELD` | 6 |
| `DISP_FUND_TYPE_FIELD` | 4 |
| `BANK_CHANNEL_FIELD` | 3 |
| `BANK_CREDIT_AMOUNT_FIELD` | 3 |
| `DISP_BIG_ACCOUNT_FIELD` | 3 |
| `dispatchAmountAbs` | 3 |
| `dispatchBankAmountEqual` | 3 |

### `src/main-process/scenario-engines/engine-week-utils.js`

| 名字 | 总次数 |
|---|---:|
| `FTA_FEATURE` | 4 |

### `src/main-process/scenario-engines/fund-transfer-engine-policy.js`

| 名字 | 总次数 |
|---|---:|
| `CANONICAL_FUND_TRANSFER_DIRECTIONS` | 5 |
| `DEFAULT_FUND_TRANSFER_DATE_POLICY` | 4 |

### `src/main-process/scenario-engines/jpm-dispatch-order-fix.js`

| 名字 | 总次数 |
|---|---:|
| `extractBillDate` | 4 |
| `GW_TYPE_COL` | 4 |
| `DATE_IN_ADDITION` | 3 |
| `sumEqualsReceive` | 3 |

### `src/main-process/scenario-engines/many-to-many-detector.js`

| 名字 | 总次数 |
|---|---:|
| `appendHit` | 3 |
| `buildNote` | 3 |
| `computeKey` | 3 |
| `detectOneSide` | 3 |

### `src/main-process/scenario-engines/r4-fund-nature-check.js`

| 名字 | 总次数 |
|---|---:|
| `addR4DirectionReason` | 3 |
| `evaluateR4Candidate` | 3 |
| `R4_RULES_BY_SUBCATEGORY` | 3 |

### `src/main-process/scenario-engines/r5-fund-transfer-backfill.js`

| 名字 | 总次数 |
|---|---:|
| `isEmptyAmountValue` | 3 |

### `src/main-process/scenario-engines/r5-payment-offline-allocation-backfill.js`

| 名字 | 总次数 |
|---|---:|
| `dayMs` | 14 |
| `PaymentOfflinePreflightError` | 5 |
| `findGroupForBankDate` | 4 |
| `amountCurrencyEqual` | 3 |
| `billDateNotEarlier` | 3 |
| `billDateWithinLag` | 3 |
| `billDateWithinWindow` | 3 |
| `buildOrderWeekGroups` | 3 |
| `plusCalendarDays` | 3 |

### `src/main-process/scenario-engines/r5-platform-inbound-cleanup.js`

| 名字 | 总次数 |
|---|---:|
| `buildCleanupRow` | 3 |

### `src/main-process/scenario-engines/r5-refund-order-backfill.js`

| 名字 | 总次数 |
|---|---:|
| `RESULT_ERROR` | 9 |
| `HIT_TYPE_PRECISE` | 7 |
| `detailBankToDeposit` | 6 |
| `detailBankToRo` | 6 |
| `lookupDepositByKeys` | 6 |
| `normalizeBizIdKey` | 6 |
| `buildUnmatchedBankRow` | 5 |
| `extractFirstCapture` | 5 |
| `HIT_TYPE_FUZZY` | 5 |
| `consumeAndBackfill` | 4 |
| `extractFeature` | 4 |
| `matchCustomerRefTwoHop` | 4 |
| `replaceUnmatchedOutcome` | 4 |
| `RESULT_NOTICE` | 4 |
| `BANK_PAYMENT_SERIAL_FUZZY_AMOUNT_LIMIT` | 3 |
| `BANK_PAYMENT_SERIAL_FUZZY_DETAIL_PREFIX` | 3 |
| `buildBackfillRow` | 3 |
| `buildDepIndex` | 3 |
| `calculateBankPaymentSerialAmountDifference` | 3 |
| `classifyCardinality` | 3 |
| `classifyS4Window` | 3 |
| `fuzzyLookupKey` | 3 |
| `hasInWindowCandidate` | 3 |
| `matchBankPaymentSerialFuzzy` | 3 |
| `matchDraweeNameDate` | 3 |
| `matchJpmHk` | 3 |
| `matchJpmUs` | 3 |
| `matchMemoContainsDepositRef` | 3 |
| `matchMemoDateAmount` | 3 |
| `matchS1` | 3 |
| `matchS2` | 3 |
| `matchS2Mtx` | 3 |
| `matchS3` | 3 |
| `matchS4` | 3 |
| `normalizeForBlacklist` | 3 |
| `parseDtdDateToken` | 3 |
| `pushBankError` | 3 |
| `runBankPaymentSerialFuzzyFallback` | 3 |
| `S4_DETAIL_TEXT` | 3 |
| `yymmddToDateStr` | 3 |

### `src/main-process/scenario-hit-rows-writer.js`

| 名字 | 总次数 |
|---|---:|
| `buildHitChannelLabel` | 3 |
| `buildHitScenarioLabel` | 3 |
| `DEFAULT_REPORT_SUBDIR` | 3 |
| `normalizeChannelsToLabelMap` | 3 |
| `REPORT_SHEET_NAME` | 3 |
| `SUFFIX_HEADERS` | 3 |

### `src/main-process/serialize-error.js`

| 名字 | 总次数 |
|---|---:|
| `MAX_CAUSE_DEPTH` | 4 |
| `safeCloneAuditFailure` | 4 |
| `safeCloneContext` | 3 |
| `safeCloneStructuredImportErrors` | 3 |

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

### `src/main-process/toolbox-archive-recovery.js`

| 名字 | 总次数 |
|---|---:|
| `toolboxRecoveryInputFiles` | 4 |
| `expectedArtifactIdentity` | 3 |

### `src/main-process/toolbox-format-io.js`

| 名字 | 总次数 |
|---|---:|
| `projectToolboxMatchValues` | 5 |
| `streamToolboxPassTables` | 5 |
| `normalizeToolboxHeaderRow` | 4 |
| `assertSplitContinuationWidth` | 3 |
| `createHeaderInfo` | 3 |
| `isHiddenSheet` | 3 |
| `isToolboxRowMeaningful` | 3 |
| `streamToolboxBiff8Tables` | 3 |
| `streamToolboxCsvTables` | 3 |
| `streamToolboxXlsxTables` | 3 |
| `toolboxRowWidth` | 3 |
| `trimTrailingEmptyMatchValues` | 3 |

### `src/main-process/toolbox-format-operations.js`

| 名字 | 总次数 |
|---|---:|
| `assertUniqueSplitHeaders` | 6 |
| `normalizeSplitEmptyError` | 6 |
| `abortWriters` | 4 |
| `createSplitFilter` | 4 |
| `createWriterFromHeader` | 3 |
| `ToolboxSplitDuplicateHeaderError` | 3 |

### `src/main-process/toolbox-input-kind.js`

| 名字 | 总次数 |
|---|---:|
| `readToolboxFileMagic` | 3 |
| `ZIP_MAGICS` | 3 |

### `src/main-process/toolbox-large-split-dispatch.js`

| 名字 | 总次数 |
|---|---:|
| `WORKER_MAX_OLD_GEN_MB` | 3 |

### `src/main-process/toolbox-large-split-router.js`

| 名字 | 总次数 |
|---|---:|
| `ROUTE_METADATA_LIMIT_BYTES` | 6 |
| `entryUncompressedSize` | 5 |
| `WORKBOOK_ENTRY` | 4 |
| `WORKBOOK_RELS_ENTRY` | 4 |
| `collectRelationshipAwareRouteMetadata` | 3 |
| `SHARED_STRINGS_LARGE_BYTES` | 3 |
| `SINGLE_WORKSHEET_LARGE_BYTES` | 3 |
| `XLSX_EXT_RE` | 3 |

### `src/main-process/toolbox-merge-io.js`

| 名字 | 总次数 |
|---|---:|
| `assertMergeHeadersIdentical` | 3 |
| `sheetSourceLabel` | 3 |
| `streamMergeInputFile` | 3 |
| `ToolboxMergePublishError` | 3 |
| `workbookSheetHidden` | 3 |

### `src/main-process/toolbox-output-publication-dispatch.js`

| 名字 | 总次数 |
|---|---:|
| `createTransportError` | 5 |
| `runWorkerJob` | 4 |
| `createRecoveryFailure` | 3 |
| `createToolboxPublicationDispatcher` | 3 |
| `defaultDispatcher` | 3 |

### `src/main-process/toolbox-output-publication-worker.js`

| 名字 | 总次数 |
|---|---:|
| `runPublicationOperation` | 3 |

### `src/main-process/toolbox-output-publication.js`

| 名字 | 总次数 |
|---|---:|
| `ToolboxPublicationError` | 45 |
| `messageOf` | 36 |
| `ToolboxPublicationManualRecoveryError` | 35 |
| `lstatOrNull` | 22 |
| `callCheckpoint` | 17 |
| `getIndexPath` | 14 |
| `releaseReservations` | 13 |
| `collectRecoveryPaths` | 12 |
| `persistJournal` | 11 |
| `fileMatches` | 10 |
| `INDEX_DISCOVERY_PREPARED` | 8 |
| `normalizeArchiveInputFiles` | 8 |
| `readIndex` | 8 |
| `buildPublishFiles` | 7 |
| `removeKnownFile` | 7 |
| `targetReservations` | 7 |
| `cloneJsonValue` | 6 |
| `INDEX_DISCOVERY_PREPARING` | 6 |
| `removeIndexEntry` | 6 |
| `activeTaskIds` | 5 |
| `cancelPrepared` | 5 |
| `createRuntime` | 5 |
| `extractPath` | 5 |
| `JOURNAL_VERSION` | 5 |
| `writeIndex` | 5 |
| `assertExpectedTargetSnapshot` | 4 |
| `discoverableAnchorsMatchJournal` | 4 |
| `discoverableIntentMatchesJournal` | 4 |
| `INDEX_DISCOVERY_CANCELLING` | 4 |
| `INDEX_DISCOVERY_FINALIZING` | 4 |
| `INDEX_DISCOVERY_ROLLBACK_FINALIZING` | 4 |
| `inspectRegularFile` | 4 |
| `isCrashError` | 4 |
| `lifecycleMutexLocked` | 4 |
| `markIndexEntryCleanupState` | 4 |
| `moveFileNoReplace` | 4 |
| `recoverPreparingIntent` | 4 |
| `recoveryLineage` | 4 |
| `targetReservationKey` | 4 |
| `throwDiscoverableAnchorMismatch` | 4 |
| `withLifecycleMutex` | 4 |
| `assertRegularFile` | 3 |
| `assertTargetUnchangedSincePrepare` | 3 |
| `backupState` | 3 |
| `cleanupCommitted` | 3 |
| `collectMetadataWarnings` | 3 |
| `committedRecoveryAccepted` | 3 |
| `finalizeCommittedPublication` | 3 |
| `generationPathsFrom` | 3 |
| `hashFileSync` | 3 |
| `indexEntryDiscoveryState` | 3 |
| `markManualRecovery` | 3 |
| `PREPARED_RUNTIME` | 3 |
| `readJsonFile` | 3 |
| `recoverFinalizingIntent` | 3 |
| `recoverPendingInternal` | 3 |
| `regularFileIdentity` | 3 |
| `rollbackUncommitted` | 3 |
| `stagingState` | 3 |
| `throwLegacyIndexManualRecovery` | 3 |
| `ToolboxPublicationCrashError` | 3 |

### `src/main-process/toolbox-output-writer.js`

| 名字 | 总次数 |
|---|---:|
| `ToolboxOutputValidationError` | 37 |
| `PACKAGE_RELATIONSHIPS_ENTRY_NAME` | 18 |
| `resolveSourceStyle` | 10 |
| `DEFAULT_STYLE_BUDGETS` | 8 |
| `stripNullish` | 8 |
| `applyExcelJsStyle` | 7 |
| `GENERATED_WORKBOOK_CONTENT_TYPES` | 5 |
| `applyRowMetadata` | 4 |
| `sha256File` | 4 |
| `applySheetLayout` | 3 |
| `countStyleComponents` | 3 |
| `createFallbackOutputRegistry` | 3 |
| `createSheetAndHeader` | 3 |
| `createToolboxWarningCollector` | 3 |
| `defaultProjectCell` | 3 |
| `EXCELJS_ZERO_HEIGHT_PATCH` | 3 |
| `formatHeadersForDetail` | 3 |
| `PACKAGE_RELATIONSHIPS_CONTENT_TYPE` | 3 |
| `prepareExcelTextValue` | 3 |
| `sheetPropertiesFromLayout` | 3 |
| `sourceCellRef` | 3 |
| `validateGeneratedWorkbook` | 3 |
| `WARNING_SAMPLE_LIMIT` | 3 |

### `src/main-process/toolbox-stream-io.js`

| 名字 | 总次数 |
|---|---:|
| `DEFAULT_FORMATTERS` | 5 |
| `canStreamXlsx` | 4 |
| `createRowsStreamWriter` | 4 |
| `buildColumnFormatPlan` | 3 |
| `buildFormattedRow` | 3 |
| `buildNumericCellSpec` | 3 |
| `computeKeepWidth` | 3 |
| `isPhysicallySingleSheetXlsx` | 3 |
| `isStreamableXlsx` | 3 |
| `TOOLBOX_HEADER_SCAN_MAX_ROWS` | 3 |

### `src/main-process/toolbox-target-identity.js`

| 名字 | 总次数 |
|---|---:|
| `pathAliasKeys` | 4 |
| `realpathSyncWith` | 3 |
| `usesCaseInsensitivePathAliases` | 3 |

### `src/main-process/toolbox.js`

| 名字 | 总次数 |
|---|---:|
| `formatTimestamp12` | 4 |
| `SPLIT_VALUE_MAX_LEN` | 4 |
| `SPLIT_VALUE_SEPARATOR` | 3 |

### `src/main-process/vcc-financial-op-archive-lineage.js`

| 名字 | 总次数 |
|---|---:|
| `VCC_IMPORT_SOURCE_OPERATION` | 7 |
| `VCC_ARCHIVE_MODULE_ID` | 6 |
| `vccRepository` | 5 |
| `holdIdentity` | 4 |
| `markSourceFailure` | 4 |
| `VCC_IMPORT_HOLD_TYPE` | 4 |
| `activeReferenceCount` | 3 |
| `recoverableVccImportBatches` | 3 |

### `src/main-process/vcc-financial-op-audit-writer.js`

| 名字 | 总次数 |
|---|---:|
| `ANOMALY_CATEGORY_TEXT` | 3 |
| `anomalyValues` | 3 |
| `parseStringArray` | 3 |

### `src/main-process/vcc-financial-op-dataset-writer.js`

| 名字 | 总次数 |
|---|---:|
| `exportError` | 28 |
| `invalidSystemLineage` | 10 |
| `EXPORT_KINDS` | 7 |
| `exportInspectionEvidence` | 4 |
| `systemSnapshotRows` | 4 |
| `assertMappedLineage` | 3 |
| `createWorksheet` | 3 |
| `detailCheckValues` | 3 |
| `detailRowValuesFromRaw` | 3 |
| `normalizeDatasetExportScope` | 3 |

### `src/main-process/vcc-financial-op-output-publication.js`

| 名字 | 总次数 |
|---|---:|
| `assertXlsxOutputPath` | 3 |

### `src/main-process/vcc-financial-op-output-recovery.js`

| 名字 | 总次数 |
|---|---:|
| `hashRegularFile` | 3 |

### `src/main-process/vcc-financial-op-read-worker.js`

| 名字 | 总次数 |
|---|---:|
| `invalidReadAction` | 3 |

### `src/main-process/vcc-financial-op-service.js`

| 名字 | 总次数 |
|---|---:|
| `DATA_STATUS_TEXT` | 5 |
| `IMPORT_STATUS_TEXT` | 5 |

### `src/main-process/vcc-financial-op-storage-migration.js`

| 名字 | 总次数 |
|---|---:|
| `DEFAULT_WORKER_PATH` | 4 |
| `restoreWorkerError` | 3 |
| `runMigrationWorker` | 3 |

### `src/main-process/vcc-financial-op-storage-rebuild.js`

| 名字 | 总次数 |
|---|---:|
| `quoteIdentifier` | 30 |
| `tableExists` | 28 |
| `invokeFault` | 16 |
| `openReadOnlyDatabase` | 10 |
| `assertIntegrity` | 8 |
| `removeJournalDurably` | 7 |
| `safeUnlink` | 7 |
| `cleanupDatabaseCandidate` | 6 |
| `safeStatSize` | 6 |
| `verifyReopenedDatabase` | 6 |
| `activeSourceReferenceSql` | 5 |
| `collectDbstat` | 5 |
| `completeRollbackJournal` | 5 |
| `exactTableMismatch` | 5 |
| `JOURNAL_SCHEMA_VERSION` | 5 |
| `vccCoreBytes` | 5 |
| `assertSlimEffectiveRowsSchema` | 4 |
| `assertVccGuardTriggers` | 4 |
| `assertVccTablesEmpty` | 4 |
| `beginRollbackJournal` | 4 |
| `deleteOldDatabaseDurably` | 4 |
| `EXPECTED_CURRENCIES` | 4 |
| `migrationEstimate` | 4 |
| `sourceTableMismatch` | 4 |
| `vccTableRowCounts` | 4 |
| `assertPreservedAutoincrementHighWatermarks` | 3 |
| `assertSourceReady` | 3 |
| `IMPORT_COUNTER_COLUMNS` | 3 |
| `isOwnedFailedCandidate` | 3 |
| `MIN_VCC_CORE_REDUCTION_RATIO` | 3 |
| `physicallyVerifyHistoricalArtifact` | 3 |
| `pragmaValue` | 3 |
| `validateAttachedTarget` | 3 |
| `VCC_TABLE_PREFIX` | 3 |
| `writableColumns` | 3 |

### `src/main-process/vcc-financial-op-write-worker.js`

| 名字 | 总次数 |
|---|---:|
| `resolveCriticalDecision` | 7 |
| `cancelledError` | 3 |
| `invalidWriteAction` | 3 |
| `WRITE_ACTIONS` | 3 |

### `src/main-process/vcc-op-calc-session.js`

| 名字 | 总次数 |
|---|---:|
| `centsToAmountString` | 16 |
| `parseAmountToCents` | 4 |
| `validateAndExtractRow` | 4 |
| `extractYearMonth` | 3 |
| `normalizeDirection` | 3 |

### `src/main.js`

| 名字 | 总次数 |
|---|---:|
| `acquiringBillCurrencyOperationLock` | 9 |
| `mainWindow` | 8 |
| `archiveCenterService` | 7 |
| `bankStatementOperationLock` | 6 |
| `pendingDb` | 4 |
| `vccFinancialOpService` | 4 |
| `requireSingleInstanceLock` | 3 |
| `startupMetrics` | 3 |

### `src/preload.js`

| 名字 | 总次数 |
|---|---:|
| `ipcRenderer` | 287 |
| `contextBridge` | 3 |

### `src/renderer.js`

| 名字 | 总次数 |
|---|---:|
| `getNewAccountRowElements` | 19 |
| `getNewAccountRows` | 19 |
| `archiveCenterErrorText` | 16 |
| `updateStatusBox` | 14 |
| `getNewAccountRowState` | 12 |
| `rgbToCss` | 12 |
| `RENDERER_STARTUP_MARKS` | 11 |
| `applyAppUpdateStatus` | 10 |
| `cloneBackgroundSettings` | 10 |
| `getRendererStartupValue` | 10 |
| `isNewAccountMultiCurrencyMode` | 10 |
| `showPreFundFailure` | 9 |
| `archiveCenterBatchId` | 8 |
| `clampColorChannel` | 8 |
| `handleNewAccountFormMutation` | 8 |
| `rendererStartupProfiler` | 8 |
| `updateBankStatementExportButtonsDisabled` | 8 |
| `updateBankStatementRunBtnDisabled` | 8 |
| `verifyArchiveCenterAction` | 8 |
| `applyBackgroundSettings` | 7 |
| `archiveCenterStatusKey` | 7 |
| `refreshOpenAppUpdateDialog` | 7 |
| `closeNewAccountCurrencyDropdown` | 6 |
| `finishPreFundReconciliationAction` | 6 |
| `mixColor` | 6 |
| `readArchiveCenterPayload` | 6 |
| `STATEMENT_MODES` | 6 |
| `updateBankStatementUi` | 6 |
| `updateNewAccountCurrencyDropdownLabel` | 6 |
| `archiveCenterModuleName` | 5 |
| `beginPreFundReconciliationAction` | 5 |
| `DEFAULT_BACKGROUND_SETTINGS` | 5 |
| `DEFAULT_SPECTRUM_PICK_COLOR` | 5 |
| `hexToRgb` | 5 |
| `renderNewAccountCurrencyOptions` | 5 |
| `syncNewAccountRowActionButtons` | 5 |
| `updatePreFundReconciliationUi` | 5 |
| `archiveCenterBatchNumber` | 4 |
| `mixRgb` | 4 |
| `newAccountRowStateMap` | 4 |
| `normalizeColorHex` | 4 |
| `refreshPreFundReconciliationStatus` | 4 |
| `renderNewAccountCurrencyOptionsList` | 4 |
| `syncNewAccountDropdownFlag` | 4 |
| `updateNewAccountCurrencySuggestion` | 4 |
| `applyAppUpdateActionResult` | 3 |
| `archiveCenterStatusText` | 3 |
| `BACKGROUND_FILE_HINT` | 3 |
| `closeBackgroundPalette` | 3 |
| `DEFAULT_APP_UPDATE_STATUS` | 3 |
| `extractAppUpdateStatus` | 3 |
| `formatArchiveCenterBytes` | 3 |
| `getSpectrumColorAtPosition` | 3 |
| `handleBankStatementBatchImport` | 3 |
| `initializeNewAccountRow` | 3 |
| `isGatewayBillReady` | 3 |
| `lastUserActivityReportTs` | 3 |
| `notifyLinkedTableImportFailures` | 3 |
| `positionReconciliationUI` | 3 |
| `proceedToGwCheck` | 3 |
| `refreshReconIdFixStatus` | 3 |
| `resetBackgroundPickerSelection` | 3 |
| `restartAndInstallAppUpdate` | 3 |
| `runBankStatementInternal` | 3 |
| `showDownloadedUpdatePrompt` | 3 |
| `syncNewAccountOpenDateInputType` | 3 |
| `updateSelectedColorSwatch` | 3 |

## B — 跨文件引用完整表

| 名字 | 跨度 | 总次数 | 声明数 | 前三引用位置 |
|---|---:|---:|---:|---|
| `path` | 132 | 801 | 126 | src/main-process/toolbox-output-publication.js(68), src/main-process/position-reconciliation/input-staging.js(42), src/main-process/archive-center/storage-root-manager.js(38) |
| `run` | 100 | 1160 | 3 | src/main-process/position-reconciliation/store.js(89), src/backend/database/archive-repository.js(85), src/backend/database/migrations.js(59) |
| `fs` | 89 | 516 | 88 | src/main-process/archive-center/storage-root-manager.js(68), src/main-process/archive-center/archive-service.js(55), src/main-process/position-reconciliation/input-staging.js(21) |
| `parse` | 58 | 121 | 1 | src/backend/database/linked-table-repository.js(12), src/backend/database/migrations.js(11), src/backend/vcc-financial-op/calculator.js(6) |
| `crypto` | 54 | 156 | 54 | src/main-process/archive-center/archive-service.js(9), src/main-process/position-reconciliation/service.js(8), src/main-process/pre-fund-reconciliation/service.js(7) |
| `text` | 47 | 703 | 4 | src/main-process/position-reconciliation/store.js(150), src/main-process/position-reconciliation/service.js(66), src/renderer.js(63) |
| `randomUUID` | 44 | 89 | 14 | src/main-process/position-reconciliation/service.js(7), src/main-process/toolbox-output-publication.js(6), src/main-process/archive-center/archive-service.js(4) |
| `state` | 41 | 670 | 1 | src/renderer.js(214), src/backend/vcc-financial-op/dataset-deletion.js(59), src/renderer-pending.js(55) |
| `startsWith` | 39 | 90 | 1 | src/main-process/archive-center/task-policy-registry.js(7), src/backend/file-service.js(6), src/main-process/archive-center/archive-service.js(6) |
| `channel` | 37 | 454 | 1 | src/main-process/archive-center/task-lifecycle.js(92), src/main-process/archive-center/task-policy-registry.js(49), src/main-process/position-reconciliation/store.js(46) |
| `sha256` | 37 | 266 | 5 | src/main-process/archive-center/archive-service.js(46), src/main-process/position-reconciliation/operation-lifecycle.js(27), src/main-process/toolbox-output-publication.js(21) |
| `SOURCE_TYPES` | 34 | 323 | 6 | src/main-process/position-reconciliation/constants.js(38), src/backend/position-reconciliation-import/account-writer.js(18), src/backend/vcc-financial-op/definitions.js(17) |
| `list` | 32 | 172 | 1 | src/renderer-dialogs.js(43), src/renderer.js(43), src/preload.js(7) |
| `normalizeCell` | 32 | 168 | 15 | src/backend/file-service.js(34), src/main-process/manual-balance-seed-preflight.js(15), src/backend/file-service/normalizers.js(12) |
| `DatabaseSync` | 30 | 78 | 25 | src/main-process/acquiring-bill-currency-run-data.js(7), src/main-process/run-check-multiworker-worker.js(6), src/backend/vcc-financial-op/mutation-guard.js(4) |
| `createHash` | 30 | 44 | 1 | src/main-process/archive-center/archive-service.js(4), src/backend/vcc-financial-op/calculator.js(3), src/main-process/position-reconciliation/input-staging.js(3) |
| `FileValidationError` | 28 | 130 | 18 | src/backend/file-service/readers.js(15), src/main-process/duplicate-inbound-match/document-statement-reader.js(10), src/main-process/duplicate-inbound-match/service.js(8) |
| `normalizeCellValue` | 23 | 302 | 12 | src/main-process/scenario-engines/r5-refund-order-backfill.js(57), src/main-process/position-reconciliation/matching-engine.js(39), src/main-process/scenario-engines/r5-payment-offline-allocation-backfill.js(22) |
| `XLSX` | 21 | 104 | 21 | src/backend/file-service/writers.js(20), src/main-process/pending-session.js(11), src/backend/pending-export/writer.js(9) |
| `PositionReconciliationError` | 19 | 207 | 1 | src/main-process/position-reconciliation/service.js(41), src/main-process/position-reconciliation/store.js(34), src/main-process/position-reconciliation/side-db-mutation.js(25) |
| `sideDbPath` | 19 | 94 | 1 | src/backend/position-reconciliation-import/maintenance-writer.js(12), src/backend/position-reconciliation-import/worker-entry.js(12), src/backend/duplicate-inbound-match-store.js(11) |
| `BANK_STATEMENT_FIELDS` | 19 | 61 | 14 | src/main-process/duplicate-inbound-match/excel-writer.js(11), src/renderer-dialogs.js(9), src/main-process/position-reconciliation/readers.js(4) |
| `ExcelJS` | 19 | 47 | 19 | src/main-process/biz-op-recon-writer.js(5), src/main-process/duplicate-inbound-match/excel-writer.js(5), src/main-process/bank-bu-recon-writer.js(3) |
| `freezeWorkerBatchContext` | 19 | 47 | 4 | src/main-process/toolbox-output-publication.js(7), src/main-process/archive-center/worker-operation-context.js(4), src/backend/acquiring-bill-currency-db/run-repository.js(3) |
| `pad` | 18 | 103 | 3 | src/main-process/bank-statement-io.js(14), src/renderer.js(13), src/backend/logger.js(11) |
| `contentHash` | 18 | 97 | 1 | src/backend/position-reconciliation-import/preflight.js(11), src/backend/vcc-financial-op/system-op-importer.js(11), src/backend/position-reconciliation-import/source-writer.js(10) |
| `repository` | 16 | 238 | 6 | src/main-process/archive-center/archive-service.js(117), src/backend/vcc-financial-op/detail-importer.js(26), src/main-process/archive-center/controller.js(20) |
| `columnName` | 16 | 45 | 1 | src/backend/vcc-financial-op-db/migrations.js(12), src/backend/database/archive-repository.js(3), src/backend/pending-db/migrations.js(3) |
| `appendModuleLog` | 15 | 77 | 11 | src/backend/database.js(23), src/main-process/acquiring-bill-currency-session.js(13), src/backend/database/migrations.js(8) |
| `SOURCE_DEFINITIONS` | 15 | 50 | 2 | src/main-process/position-reconciliation/store.js(6), src/main-process/position-reconciliation/readers.js(5), src/backend/position-reconciliation-import/preflight.js(4) |
| `makeWarningCollector` | 15 | 30 | 4 | src/main-process/scenario-engines/boc-dispatch-order-fix.js(2), src/main-process/scenario-engines/c1-extract-recon-id.js(2), src/main-process/scenario-engines/c2-offset-bill-mark.js(2) |
| `FLOW_HEADERS` | 14 | 35 | 8 | src/backend/acquiring-bill-currency-db/columns.js(6), src/backend/vcc-op-calc-import/validator.js(4), src/backend/acquiring-bill-currency-import/reader.js(3) |
| `validateHeaders` | 14 | 34 | 3 | src/backend/biz-op-recon-import/reader-streamed.js(7), src/backend/acquiring-bill-currency-import/reader.js(4), src/backend/bank-bu-recon-import/reader.js(4) |
| `finish` | 13 | 79 | 2 | src/backend/toolbox-format/xlsx-pass.js(26), src/main-process/vcc-financial-op-service.js(12), src/main-process/toolbox-output-writer.js(6) |
| `SUPPORTED_CURRENCIES` | 13 | 62 | 4 | src/main-process/vcc-financial-op-dataset-writer.js(13), src/backend/vcc-financial-op/result-adjustments.js(9), src/backend/vcc-financial-op/archive-contract.js(5) |
| `placeholders` | 13 | 57 | 2 | src/main-process/position-reconciliation/store.js(20), src/backend/database/linked-table-repository.js(7), src/backend/database/template-repository.js(6) |
| `stableHash` | 13 | 57 | 3 | src/backend/position-reconciliation-import/source-writer.js(16), src/main-process/pre-fund-reconciliation/service.js(8), src/main-process/position-reconciliation/store.js(6) |
| `SOURCE_LABELS` | 13 | 41 | 3 | src/backend/vcc-financial-op/calculator.js(5), src/backend/vcc-financial-op/detail-importer.js(5), src/main-process/vcc-financial-op-service.js(5) |
| `applyWatermark` | 13 | 31 | 13 | src/main-process/biz-op-recon-writer.js(5), src/backend/file-service/writers.js(3), src/backend/pending-export/writer.js(3) |
| `serializeError` | 12 | 49 | 7 | src/main-process/run-check-worker.js(7), src/main-process/run-check-multiworker-worker.js(6), src/backend/big-table-import/engine-worker-entry.js(5) |
| `parseNumber` | 12 | 43 | 4 | src/main-process/scenario-engines/c3-gateway-recon-join.js(6), src/main-process/scenario-engines/r5-fund-transfer-backfill.js(6), src/main-process/scenario-engines/r5-refund-order-backfill.js(6) |
| `parentPort` | 11 | 76 | 10 | src/main-process/run-check-worker.js(10), src/main-process/vcc-financial-op-storage-migration-worker.js(9), src/main-process/vcc-financial-op-write-worker.js(9) |
| `cancel` | 11 | 67 | 1 | src/renderer-position-reconciliation.js(24), src/renderer-vcc-financial-op.js(18), src/main-process/position-reconciliation/service.js(5) |
| `isRowMeaningful` | 11 | 30 | 2 | src/backend/file-service/readers.js(6), src/main-process/toolbox-stream-io.js(4), src/backend/toolbox-xlsx-stream/multi-sheet-reader.js(3) |
| `normalize` | 11 | 28 | 1 | src/backend/toolbox-format/xlsx-pass.js(5), src/backend/pre-fund-reconciliation-store.js(4), src/main-process/toolbox-output-writer.js(4) |
| `toDate` | 10 | 42 | 9 | src/main-process/scenario-engines/engine-date-utils.js(8), src/main-process/scenario-engines/dbs-charge-fund-check.js(5), src/main-process/scenario-engines/r5-fund-transfer-backfill.js(5) |
| `sideDbRelPath` | 10 | 40 | 1 | src/main-process/biz-op-recon-run-data.js(10), src/main-process/pre-fund-reconciliation/service.js(9), src/main-process/acquiring-bill-currency-run-data.js(5) |
| `PENDING_COLUMNS` | 10 | 39 | 10 | src/backend/pending-export/writer.js(6), src/backend/pending-import/contract-pending.js(6), src/backend/pending-import/validator.js(6) |
| `canonicalizeVccAmount` | 10 | 37 | 10 | src/backend/vcc-financial-op/result-evidence.js(8), src/backend/vcc-financial-op/calculator.js(7), src/backend/vcc-financial-op/result-adjustments.js(4) |
| `canonicalizeDecimal` | 10 | 32 | 5 | src/main-process/pre-fund-reconciliation/bank-row.js(6), src/main-process/financial-decimal.js(5), src/main-process/pre-fund-reconciliation/matching-engine.js(4) |
| `normalizeYearMonth` | 10 | 32 | 8 | src/backend/vcc-financial-op/calculator.js(6), src/backend/vcc-financial-op/row-mapper.js(6), src/main-process/vcc-financial-op-service.js(4) |
| `getRun` | 10 | 24 | 2 | src/main-process/position-reconciliation/store.js(7), src/main-process/bank-bu-recon-session.js(4), src/backend/bank-bu-recon-db/run-repository.js(2) |
| `openZipWithEntries` | 10 | 22 | 2 | src/backend/acquiring-bill-currency-import/reader.js(4), src/backend/toolbox-xlsx-stream/multi-sheet-reader.js(3), src/main-process/duplicate-inbound-match/document-statement-reader.js(3) |
| `validateFlowHeaders` | 10 | 20 | 8 | src/backend/acquiring-bill-currency-import/reader.js(3), src/backend/acquiring-bill-currency-import/contract-flow.js(2), src/backend/acquiring-bill-currency-import/validator.js(2) |
| `deserializeError` | 10 | 19 | 4 | src/main-process/serialize-error.js(3), src/main-process/vcc-financial-op-service.js(3), src/main-process/acquiring-bill-currency-session.js(2) |
| `runDataStore` | 9 | 173 | 9 | src/main-process/biz-op-recon-run-data.js(52), src/backend/duplicate-inbound-match-store.js(33), src/main-process/acquiring-bill-currency-run-data.js(23) |
| `active` | 9 | 171 | 1 | src/backend/position-reconciliation-import/worker-entry.js(96), src/main-process/position-reconciliation/service.js(46), src/renderer.js(7) |
| `session` | 9 | 87 | 3 | src/main-process/statement-session.js(28), src/main-process/biz-op-recon-run-data.js(17), src/main-process/statement-generation.js(10) |
| `remove` | 9 | 80 | 1 | src/renderer-dialogs.js(42), src/renderer-position-reconciliation.js(19), src/renderer.js(6) |
| `parseJson` | 9 | 57 | 6 | src/main-process/position-reconciliation/store.js(29), src/backend/pre-fund-reconciliation-run-store.js(6), src/main-process/position-reconciliation/large-import-schema.js(6) |
| `normalizeDate` | 9 | 31 | 4 | src/main-process/position-reconciliation/derivation.js(5), src/main-process/pre-fund-reconciliation/mpt-schema.js(5), src/backend/vcc-financial-op/row-mapper.js(4) |
| `normalizeHeaderRow` | 9 | 28 | 5 | src/backend/vcc-financial-op/workbook-reader.js(4), src/main-process/position-reconciliation/readers.js(4), src/main-process/toolbox-merge-io.js(4) |
| `bankChannel` | 9 | 27 | 1 | src/main-process/pre-fund-reconciliation/output-mapper.js(5), src/main-process/scenario-engines/dbs-charge-fund-check.js(5), src/main-process/scenario-engines/r5-payment-offline-allocation-backfill.js(4) |
| `FLOW_DB_COLUMNS` | 9 | 27 | 3 | src/backend/biz-op-recon-import/contract-flow.js(6), src/backend/biz-op-recon-db/flow-imports-repository.js(5), src/backend/biz-op-recon-db/columns.js(4) |
| `sourceSnapshotMatchesStat` | 9 | 26 | 1 | src/main-process/position-reconciliation/input-staging.js(6), src/backend/position-reconciliation-import/ledger.js(4), src/main-process/archive-center/archive-service.js(3) |
| `sourceSnapshotFromStat` | 9 | 25 | 1 | src/main-process/position-reconciliation/input-staging.js(5), src/main-process/archive-center/source-snapshot.js(4), src/backend/position-reconciliation-import/ledger.js(3) |
| `listMonths` | 9 | 20 | 4 | src/main-process/bank-bu-recon-session.js(4), src/main-process/acquiring-bill-currency-session.js(3), src/preload.js(3) |
| `Worker` | 9 | 20 | 9 | src/main-process/vcc-financial-op-service.js(4), src/backend/big-table-import/pipeline.js(2), src/main-process/acquiring-bill-currency-session.js(2) |
| `importFiles` | 9 | 19 | 4 | src/backend/vcc-financial-op/system-op-importer.js(4), src/backend/vcc-financial-op/detail-importer.js(3), src/backend/big-table-import/engine.js(2) |
| `makeModificationCollector` | 9 | 18 | 1 | src/main-process/scenario-engines/c1-extract-recon-id.js(2), src/main-process/scenario-engines/c2-offset-bill-mark.js(2), src/main-process/scenario-engines/c3-gateway-recon-join.js(2) |
| `saveMappings` | 9 | 17 | 2 | src/backend/database.js(3), src/renderer-dialogs.js(3), src/backend/database/fund-transfer-account-mapping-repository.js(2) |
| `openReadStream` | 9 | 15 | 1 | src/backend/vcc-financial-op/workbook-reader.js(4), src/backend/acquiring-bill-currency-import/reader.js(2), src/backend/toolbox-format/xlsx-pass.js(2) |
| `insertRun` | 9 | 13 | 4 | src/backend/acquiring-bill-currency-db/run-repository.js(2), src/backend/bank-bu-recon-db/run-repository.js(2), src/backend/biz-op-recon-db/run-repository.js(2) |
| `fail` | 8 | 242 | 2 | src/backend/toolbox-format/biff8-records.js(127), src/main-process/toolbox-output-writer.js(50), src/backend/toolbox-format/biff8-overlay.js(35) |
| `database` | 8 | 122 | 1 | src/main-process/vcc-financial-op-service.js(29), src/main-process/pre-fund-reconciliation/service.js(25), src/main-process/linked-derive-rebuild.js(22) |
| `RUNS_TABLE` | 8 | 79 | 8 | src/backend/biz-op-recon-db/run-repository.js(19), src/backend/acquiring-bill-currency-db/run-repository.js(15), src/main-process/acquiring-bill-currency-run-data.js(10) |
| `operationError` | 8 | 56 | 3 | src/main-process/vcc-financial-op-service.js(12), src/backend/vcc-financial-op/operation-state.js(8), src/backend/vcc-financial-op/unarchive.js(8) |
| `emit` | 8 | 51 | 3 | src/backend/pending-import/worker.js(10), src/main-process/pending-archive-worker.js(10), src/main-process/vcc-financial-op-dataset-writer.js(8) |
| `hex` | 8 | 31 | 1 | src/backend/toolbox-format/biff8-records.js(23), src/backend/toolbox-format/excel-text.js(2), src/backend/toolbox-format/biff8-pass.js(1) |
| `SHA256_RE` | 8 | 29 | 8 | src/main-process/archive-center/archive-service.js(7), src/main-process/position-reconciliation/operation-lifecycle.js(6), src/backend/database/archive-repository.js(3) |
| `headersEqual` | 8 | 28 | 4 | src/backend/vcc-financial-op/definitions.js(5), src/main-process/position-reconciliation/readers.js(5), src/backend/position-reconciliation-import/xls-reader.js(4) |
| `FT_RECON_FIELD_MAP` | 8 | 24 | 6 | src/main-process/fund-transfer-recon-builder.js(5), src/main-process/scenario-engines/dbs-charge-fund-check.js(5), src/constants/fund-transfer-recon-fields.js(4) |
| `getRunById` | 8 | 22 | 3 | src/main-process/biz-op-recon-run-data.js(6), src/backend/biz-op-recon-db/run-repository.js(4), src/backend/pending-db/diff-repository.js(4) |
| `sax` | 8 | 22 | 8 | src/backend/toolbox-format/xlsx-pass.js(4), src/main-process/toolbox-output-writer.js(4), src/backend/acquiring-bill-currency-import/reader.js(3) |
| `readDatabaseLocalTimestamp` | 8 | 19 | 3 | src/backend/vcc-financial-op/calculator.js(3), src/backend/vcc-financial-op/data-target-deletion.js(3), src/backend/vcc-financial-op/result-write.js(3) |
| `getMonthMeta` | 8 | 18 | 2 | src/main-process/bank-bu-recon-run-data.js(4), src/backend/pending-db/month-repository.js(3), src/main-process/bank-bu-recon-session.js(3) |
| `normalizeDateExportValue` | 8 | 18 | 6 | src/backend/file-service.js(3), src/backend/file-service/normalizers.js(3), src/backend/database/linked-table-repository.js(2) |
| `runReconciliation` | 8 | 18 | 5 | src/main-process/bank-bu-recon-session.js(5), src/main-process/bank-bu-recon-run-data.js(3), src/backend/pending-reconcile/engine.js(2) |
| `create` | 8 | 17 | 1 | src/backend/toolbox-xlsx-stream/bounded-values-accumulator.js(4), src/backend/big-table-import/row-scanner.js(3), src/backend/biz-op-recon-db/month-end-copy-intent-repository.js(2) |
| `readRows` | 8 | 16 | 4 | src/backend/file-service.js(3), src/main-process/toolbox-stream-io.js(3), src/backend/bank-account-import.js(2) |
| `acknowledgeArchiveTerminal` | 8 | 15 | 3 | src/main-process/biz-op-recon-run-data.js(5), src/backend/biz-op-recon-db/run-repository.js(2), src/backend/database/pre-fund-reconciliation-run-repository.js(2) |
| `createRun` | 8 | 11 | 1 | src/backend/pending-reconcile/engine.js(3), src/backend/pending-db/diff-repository.js(2), src/backend/duplicate-inbound-match-store.js(1) |
| `dialog` | 7 | 615 | 1 | src/renderer-dialogs.js(442), src/renderer.js(123), src/renderer-pending.js(26) |
| `MODULE` | 7 | 125 | 6 | src/main-process/biz-op-recon-run-data.js(40), src/main-process/acquiring-bill-currency-run-data.js(22), src/backend/duplicate-inbound-match-store.js(21) |
| `FIELD_MAP` | 7 | 103 | 6 | src/main-process/boc-fx-link-builder.js(34), src/main-process/scenario-engines/jpm-dispatch-order-fix.js(28), src/main-process/adm-bank-deposit-builder.js(14) |
| `runRepository` | 7 | 67 | 7 | src/main-process/biz-op-recon-run-data.js(30), src/main-process/bank-bu-recon-run-data.js(9), src/main-process/biz-op-recon-session.js(9) |
| `stableStringify` | 7 | 39 | 3 | src/backend/vcc-financial-op/result-write.js(11), src/backend/vcc-financial-op/destructive-write.js(7), src/backend/vcc-financial-op/operation-token-v2.js(7) |
| `openSideDb` | 7 | 38 | 1 | src/main-process/biz-op-recon-run-data.js(19), src/main-process/bank-bu-recon-run-data.js(8), src/main-process/acquiring-bill-currency-run-data.js(5) |
| `parseNumericValue` | 7 | 35 | 2 | src/backend/file-service.js(14), src/backend/file-service/writers.js(6), src/main-process/toolbox-stream-io.js(6) |
| `normalizeSourceSnapshot` | 7 | 32 | 1 | src/main-process/position-reconciliation/operation-lifecycle.js(7), src/main-process/archive-center/archive-service.js(5), src/main-process/archive-center/source-snapshot.js(5) |
| `stableJson` | 7 | 28 | 2 | src/backend/vcc-financial-op/result-template-contract.js(5), src/main-process/position-reconciliation/common.js(5), src/main-process/position-reconciliation/readers.js(5) |
| `BILL_HEADERS` | 7 | 27 | 7 | src/main-process/duplicate-inbound-match/document-statement-reader.js(9), src/backend/acquiring-bill-currency-db/columns.js(7), src/backend/acquiring-bill-currency-import/contract-bill.js(3) |
| `absolutePath` | 7 | 23 | 1 | src/backend/position-reconciliation-import/xlsx-reader.js(4), src/backend/toolbox-format/biff8-pass.js(4), src/backend/toolbox-format/xlsx-pass.js(4) |
| `sideDbExists` | 7 | 21 | 1 | src/backend/duplicate-inbound-match-store.js(5), src/main-process/biz-op-recon-run-data.js(5), src/main-process/bank-bu-recon-run-data.js(4) |
| `GATEWAY_BILL_FIELDS` | 7 | 16 | 4 | src/renderer-dialogs.js(4), src/constants/adm-bank-deposit-fields.js(2), src/constants/gateway-bill-recon-fields.js(2) |
| `createContract` | 7 | 13 | 4 | src/backend/acquiring-bill-currency-import/contract-bill.js(2), src/backend/acquiring-bill-currency-import/contract-flow.js(2), src/backend/big-table-import/engine.js(2) |
| `scanSheet` | 7 | 12 | 2 | src/backend/toolbox-format/biff8-pass.js(2), src/backend/toolbox-format/biff8-records.js(2), src/backend/toolbox-format/csv-pass.js(2) |
| `mapRow` | 7 | 10 | 1 | src/backend/pending-import/removed-reader.js(3), src/backend/big-table-import/contract.js(2), src/backend/acquiring-bill-currency-import/contract-bill.js(1) |
| `elements` | 6 | 255 | 1 | src/renderer.js(149), src/renderer-previews.js(51), src/renderer-position-reconciliation.js(29) |
| `VCC_MUTATION_OPERATIONS` | 6 | 81 | 1 | src/backend/vcc-financial-op/mutation-policy.js(31), src/backend/vcc-financial-op/destructive-write.js(15), src/backend/vcc-financial-op/result-write.js(14) |
| `POSITION_IMPORT_COMMANDS` | 6 | 40 | 1 | src/backend/position-reconciliation-import/worker-entry.js(9), src/main-process/position-reconciliation/service.js(9), src/backend/position-reconciliation-import/constants.js(7) |
| `dependentMonths` | 6 | 30 | 1 | src/backend/vcc-financial-op/unarchive-gate.js(6), src/backend/vcc-financial-op/unarchive.js(6), src/main-process/serialize-error.js(6) |
| `serializeJson` | 6 | 30 | 1 | src/main-process/position-reconciliation/store.js(18), src/backend/position-reconciliation-import/account-writer.js(3), src/backend/position-reconciliation-import/source-writer.js(3) |
| `logger` | 6 | 28 | 3 | src/backend/vcc-financial-op/unarchive.js(9), src/main-process/app-updater.js(7), src/main-process/biz-op-recon-session.js(5) |
| `monthOf` | 6 | 28 | 2 | src/main-process/biz-op-recon-run-data.js(16), src/main-process/position-reconciliation/readers.js(3), src/renderer-position-reconciliation.js(3) |
| `sourceIdentity` | 6 | 23 | 1 | src/backend/database/linked-table-repository.js(11), src/backend/vcc-financial-op/import-service.js(3), src/backend/vcc-financial-op/source-lineage.js(3) |
| `MAX_COLLECTED_ERRORS` | 6 | 21 | 5 | src/backend/acquiring-bill-currency-import/reader.js(6), src/backend/big-table-import/import-worker.js(4), src/backend/acquiring-bill-currency-import/contract-bill.js(3) |
| `BANK_SHEET_NAME` | 6 | 20 | 1 | src/main-process/position-reconciliation/excel-io.js(5), src/backend/position-reconciliation-import/xls-reader.js(4), src/main-process/position-reconciliation/readers.js(4) |
| `POSITION_BANK_HEADERS` | 6 | 20 | 1 | src/main-process/position-reconciliation/excel-io.js(9), src/main-process/position-reconciliation/readers.js(3), src/backend/position-reconciliation-import/xls-reader.js(2) |
| `BIZ_OP_DB_COLUMNS` | 6 | 18 | 2 | src/backend/biz-op-recon-db/imports-repository.js(5), src/backend/biz-op-recon-db/columns.js(4), src/main-process/biz-op-recon-run-data.js(3) |
| `listSideDbFiles` | 6 | 18 | 1 | src/main-process/biz-op-recon-run-data.js(6), src/backend/pre-fund-reconciliation-run-store.js(4), src/main-process/acquiring-bill-currency-run-data.js(3) |
| `parseDateValue` | 6 | 18 | 1 | src/backend/file-service.js(4), src/backend/file-service/writers.js(4), src/main-process/toolbox-stream-io.js(4) |
| `addCanonicalDecimals` | 6 | 16 | 2 | src/backend/vcc-financial-op/result-evidence.js(4), src/main-process/pre-fund-reconciliation/bank-row.js(4), src/backend/vcc-financial-op/calculator.js(2) |
| `assertPositionLargeImportSchema` | 6 | 16 | 1 | src/main-process/position-reconciliation/large-import-schema.js(5), src/backend/position-reconciliation-import/source-writer.js(3), src/backend/position-reconciliation-import/account-writer.js(2) |
| `main` | 6 | 16 | 3 | src/main-process/position-reconciliation/decimal.js(5), src/renderer-dialogs.js(4), src/backend/biz-op-recon-import/import-worker.js(2) |
| `MS_PER_DAY` | 6 | 16 | 6 | src/main-process/scenario-engines/r5-payment-offline-allocation-backfill.js(5), src/main-process/scenario-engines/engine-date-utils.js(3), src/main-process/scenario-engines/dbs-charge-fund-check.js(2) |
| `subtractCanonicalDecimals` | 6 | 15 | 1 | src/backend/vcc-financial-op/result-adjustments.js(3), src/backend/vcc-financial-op/result-evidence.js(3), src/main-process/scenario-engines/r5-refund-order-backfill.js(3) |
| `runPositionSideDbMutation` | 6 | 14 | 1 | src/backend/position-reconciliation-import/maintenance-writer.js(4), src/backend/position-reconciliation-import/account-writer.js(2), src/backend/position-reconciliation-import/bank-writer.js(2) |
| `assertPreservedOperationState` | 6 | 13 | 1 | src/backend/vcc-financial-op/data-target-deletion.js(3), src/backend/vcc-financial-op/calculator.js(2), src/backend/vcc-financial-op/dataset-deletion.js(2) |
| `formatTimestamp` | 6 | 13 | 6 | src/main-process/position-reconciliation/service.js(4), src/backend/database/backup.js(2), src/main-process/bank-bu-recon-session.js(2) |
| `getEffectiveRunResult` | 6 | 12 | 5 | src/backend/vcc-financial-op/result-adjustments.js(3), src/backend/vcc-financial-op/calculator.js(2), src/backend/vcc-financial-op/operation-audit.js(2) |
| `getRunByArchiveTaskRunId` | 6 | 12 | 2 | src/main-process/biz-op-recon-run-data.js(4), src/backend/biz-op-recon-db/run-repository.js(3), src/backend/pending-db/diff-repository.js(2) |
| `isMainThread` | 6 | 12 | 6 | src/backend/big-table-import/engine-worker-entry.js(2), src/backend/big-table-import/import-worker.js(2), src/backend/toolbox-xlsx-stream/large-split-worker.js(2) |
| `loadSharedStrings` | 6 | 12 | 1 | src/backend/acquiring-bill-currency-import/reader.js(4), src/backend/toolbox-xlsx-stream/multi-sheet-reader.js(3), src/main-process/duplicate-inbound-match/document-statement-reader.js(2) |
| `scanSheetRows` | 6 | 12 | 4 | src/backend/toolbox-xlsx-stream/multi-sheet-reader.js(3), src/backend/vcc-financial-op/workbook-reader.js(3), src/backend/big-table-import/row-scanner.js(2) |
| `trimTrailingEmptyCells` | 6 | 12 | 1 | src/backend/file-service/readers.js(3), src/backend/file-service/common.js(2), src/backend/toolbox-xlsx-stream/multi-sheet-reader.js(2) |
| `JSZip` | 6 | 11 | 6 | src/backend/biz-op-recon-import/reader-streamed.js(2), src/backend/file-service/readers.js(2), src/backend/pending-import/streaming-xlsx-writer.js(2) |
| `deleteSideDbByPath` | 6 | 10 | 1 | src/backend/pre-fund-reconciliation-store.js(3), src/backend/run-data-store.js(3), src/backend/duplicate-inbound-match-store.js(1) |
| `listMappings` | 6 | 9 | 1 | src/backend/database/fund-transfer-account-mapping-repository.js(2), src/main-process/position-reconciliation/service.js(2), src/main-process/position-reconciliation/store.js(2) |
| `sanitizeFileName` | 6 | 9 | 5 | src/main-process/toolbox.js(3), src/main-process/pre-fund-reconciliation/excel-writer.js(2), src/backend/balance-seed-store.js(1) |
| `listUnacknowledgedArchiveRuns` | 6 | 8 | 2 | src/backend/biz-op-recon-db/run-repository.js(2), src/backend/pending-db/diff-repository.js(2), src/backend/pre-fund-reconciliation-run-store.js(1) |
| `escapeHtml` | 5 | 293 | 1 | src/renderer-dialogs.js(159), src/renderer.js(76), src/renderer-position-reconciliation.js(39) |
| `shell` | 5 | 92 | 1 | src/renderer-position-reconciliation.js(79), src/renderer.js(9), src/renderer-dialogs.js(2) |
| `setCurrentModule` | 5 | 70 | 2 | src/renderer-previews.js(61), src/renderer.js(4), src/backend/database.js(2) |
| `app` | 5 | 38 | 1 | src/main-process/app-updater.js(16), src/main.js(9), src/renderer.js(8) |
| `localName` | 5 | 35 | 2 | src/backend/toolbox-format/xlsx-pass.js(12), src/backend/vcc-financial-op/system-op-importer.js(10), src/backend/toolbox-format/style-registry.js(7) |
| `getSetting` | 5 | 28 | 1 | src/backend/database/settings-repository.js(17), src/main-process/archive-center/storage-root-manager.js(5), src/backend/database.js(3) |
| `openExistingSideDb` | 5 | 28 | 1 | src/backend/duplicate-inbound-match-store.js(11), src/backend/pre-fund-reconciliation-store.js(8), src/main-process/biz-op-recon-run-data.js(5) |
| `bumpRevision` | 5 | 27 | 4 | src/main-process/position-reconciliation/store.js(11), src/backend/position-reconciliation-import/maintenance-writer.js(7), src/backend/position-reconciliation-import/account-writer.js(3) |
| `assertNotCancelled` | 5 | 26 | 5 | src/backend/toolbox-format/csv-pass.js(7), src/backend/position-reconciliation-import/maintenance-writer.js(6), src/backend/position-reconciliation-import/source-writer.js(5) |
| `cellValue` | 5 | 24 | 1 | src/main-process/scenario-engines/engine-utils.js(8), src/backend/file-service/writers.js(6), src/main-process/scenario-engines/c1-extract-recon-id.js(6) |
| `MAX_DATA_ROWS_PER_SHEET` | 5 | 22 | 5 | src/main-process/toolbox-stream-io.js(5), src/main-process/vcc-financial-op-audit-writer.js(5), src/main-process/vcc-financial-op-dataset-writer.js(5) |
| `namespaceAllowed` | 5 | 22 | 1 | src/backend/toolbox-format/xlsx-pass.js(11), src/main-process/toolbox-output-writer.js(4), src/backend/toolbox-format/style-registry.js(3) |
| `tableHasColumn` | 5 | 21 | 5 | src/main-process/vcc-financial-op-dataset-writer.js(7), src/main-process/vcc-financial-op-storage-rebuild.js(6), src/main-process/position-reconciliation/store.js(3) |
| `PENDING_HEADERS` | 5 | 20 | 1 | src/backend/vcc-financial-op/pending-template-contract.js(7), src/backend/vcc-financial-op/definitions.js(6), src/backend/vcc-financial-op/row-mapper.js(3) |
| `normalizeHeaderCell` | 5 | 18 | 4 | src/backend/bank-bu-recon-import/validator.js(5), src/backend/biz-op-recon-import/validator.js(4), src/backend/vcc-op-calc-import/validator.js(4) |
| `EXCEL_MAX_ROWS` | 5 | 17 | 4 | src/main-process/pre-fund-reconciliation/mpt-error-report-writer.js(5), src/backend/position-reconciliation-import/anomaly-report.js(3), src/main-process/duplicate-inbound-match/excel-writer.js(3) |
| `normalizePositionCheckpoint` | 5 | 17 | 1 | src/main-process/position-reconciliation/side-db-mutation.js(6), src/main-process/position-reconciliation/store.js(4), src/main-process/position-reconciliation/large-import-schema.js(3) |
| `CancelError` | 5 | 16 | 3 | src/main-process/acquiring-bill-currency-session.js(7), src/backend/big-table-import/pipeline.js(4), src/backend/big-table-import/engine.js(3) |
| `getHead` | 5 | 16 | 1 | src/main-process/biz-op-recon-session.js(5), src/backend/biz-op-recon-db/dataset-head-repository.js(3), src/main-process/biz-op-archive-lineage.js(3) |
| `positionCheckpointsEqual` | 5 | 16 | 1 | src/main-process/position-reconciliation/large-import-schema.js(4), src/main-process/position-reconciliation/service.js(4), src/main-process/position-reconciliation/side-db-mutation.js(3) |
| `SPREADSHEETML_NAMESPACES` | 5 | 16 | 1 | src/backend/toolbox-format/xlsx-pass.js(8), src/backend/toolbox-format/ooxml-namespaces.js(2), src/backend/toolbox-format/style-registry.js(2) |
| `getSourceDefinition` | 5 | 15 | 1 | src/main-process/vcc-financial-op-dataset-writer.js(4), src/backend/vcc-financial-op/definitions.js(3), src/backend/vcc-financial-op/detail-importer.js(3) |
| `hashFileSha256Async` | 5 | 15 | 1 | src/backend/position-reconciliation-import/ledger.js(4), src/main-process/position-reconciliation/input-staging.js(4), src/backend/position-reconciliation-import/anomaly-report.js(3) |
| `TEMPLATE_BILL_HEADERS` | 5 | 15 | 4 | src/main-process/acquiring-bill-currency-writer.js(6), src/backend/acquiring-bill-currency-db/columns.js(3), src/backend/acquiring-bill-currency-db/import-repository.js(2) |
| `valuesEqual` | 5 | 15 | 1 | src/main-process/scenario-engines/dbs-charge-fund-check.js(6), src/main-process/scenario-engines/c3-gateway-recon-join.js(3), src/main-process/scenario-engines/c2-offset-bill-mark.js(2) |
| `VALID_DIRECTION_IN` | 5 | 14 | 4 | src/main-process/vcc-op-calc-session.js(5), src/backend/biz-op-recon-import/validator.js(3), src/backend/vcc-op-calc-db/columns.js(2) |
| `absoluteDecimal` | 5 | 13 | 2 | src/main-process/pre-fund-reconciliation/bank-row.js(4), src/main-process/scenario-engines/r5-refund-order-backfill.js(3), src/main-process/financial-decimal.js(2) |
| `BIZ_OP_HEADERS` | 5 | 13 | 1 | src/main-process/biz-op-recon-writer.js(4), src/backend/biz-op-recon-import/reader-streamed.js(3), src/backend/biz-op-recon-db/columns.js(2) |
| `dayDiffWithin` | 5 | 13 | 5 | src/main-process/scenario-engines/dbs-charge-fund-check.js(3), src/main-process/scenario-engines/r5-fund-transfer-backfill.js(3), src/main-process/scenario-engines/r5-fund-transfer-recon-backfill.js(3) |
| `extractMonthKey` | 5 | 13 | 5 | src/backend/acquiring-bill-currency-import/contract-bill.js(3), src/backend/acquiring-bill-currency-import/contract-flow.js(3), src/backend/acquiring-bill-currency-import/reader.js(3) |
| `insertOperationAudit` | 5 | 13 | 1 | src/backend/vcc-financial-op/calculator.js(3), src/backend/vcc-financial-op/data-target-deletion.js(3), src/backend/vcc-financial-op/operation-audit.js(3) |
| `pipeline` | 5 | 13 | 5 | src/main-process/archive-center/archive-service.js(4), src/backend/big-table-import/engine.js(3), src/main-process/archive-center/storage-materializer.js(2) |
| `refreshPositionSourceSummary` | 5 | 13 | 1 | src/main-process/position-reconciliation/store.js(4), src/backend/position-reconciliation-import/maintenance-writer.js(3), src/backend/position-reconciliation-import/account-writer.js(2) |
| `assertExcelCellTextLength` | 5 | 12 | 1 | src/backend/position-reconciliation-import/shared-strings-provider.js(3), src/backend/toolbox-format/xlsx-sheet-scanner.js(3), src/backend/toolbox-format/excel-text.js(2) |
| `assertPositionImportDiskSpace` | 5 | 12 | 1 | src/backend/position-reconciliation-import/maintenance-writer.js(4), src/backend/position-reconciliation-import/account-writer.js(2), src/backend/position-reconciliation-import/bank-writer.js(2) |
| `assertSuccessOperationAudit` | 5 | 12 | 1 | src/backend/vcc-financial-op/calculator.js(3), src/backend/vcc-financial-op/data-target-deletion.js(3), src/backend/vcc-financial-op/dataset-deletion.js(2) |
| `collectRunEvidence` | 5 | 12 | 1 | src/backend/vcc-financial-op/calculator.js(3), src/backend/vcc-financial-op/data-target-deletion.js(3), src/backend/vcc-financial-op/dataset-deletion.js(2) |
| `getImportRecord` | 5 | 12 | 1 | src/backend/vcc-financial-op-db/repository.js(6), src/backend/vcc-financial-op/system-op-importer.js(3), src/backend/vcc-financial-op/detail-importer.js(1) |
| `persistRolledBackAudit` | 5 | 12 | 1 | src/backend/vcc-financial-op/calculator.js(3), src/backend/vcc-financial-op/data-target-deletion.js(3), src/backend/vcc-financial-op/dataset-deletion.js(2) |
| `positionLargeImportSchemaFingerprint` | 5 | 12 | 1 | src/backend/position-reconciliation-import/source-writer.js(3), src/main-process/position-reconciliation/large-import-schema.js(3), src/backend/position-reconciliation-import/account-writer.js(2) |
| `SHARED_STRINGS_ENTRY_NAME` | 5 | 12 | 3 | src/backend/acquiring-bill-currency-import/reader.js(4), src/backend/pending-import/xlsx-size-preflight.js(4), src/main-process/duplicate-inbound-match/document-statement-reader.js(2) |
| `VALID_DIRECTION_OUT` | 5 | 12 | 4 | src/backend/biz-op-recon-import/validator.js(3), src/main-process/vcc-op-calc-session.js(3), src/backend/vcc-op-calc-db/columns.js(2) |
| `validateBankDirection` | 5 | 12 | 4 | src/main-process/scenario-engines/dbs-charge-fund-check.js(3), src/main-process/scenario-engines/r4-fund-nature-check.js(3), src/main-process/scenario-engines/bank-direction-validator.js(2) |
| `validateOperationConfirmation` | 5 | 12 | 1 | src/backend/vcc-financial-op/data-target-deletion.js(4), src/backend/vcc-financial-op/dataset-deletion.js(2), src/backend/vcc-financial-op/operation-state.js(2) |
| `deriveLinkedRowsForRecord` | 5 | 11 | 1 | src/main-process/position-reconciliation/derivation.js(3), src/backend/position-reconciliation-import/account-writer.js(2), src/backend/position-reconciliation-import/maintenance-writer.js(2) |
| `evaluateCondition` | 5 | 11 | 1 | src/main-process/scenario-engines/c3-gateway-recon-join.js(3), src/main-process/scenario-engines/c1-extract-recon-id.js(2), src/main-process/scenario-engines/c2-offset-bill-mark.js(2) |
| `freezeWorkerOperationContext` | 5 | 11 | 2 | src/main-process/archive-center/worker-operation-context.js(3), src/backend/position-reconciliation-import/worker-entry.js(2), src/backend/vcc-financial-op/worker-entry.js(2) |
| `os` | 5 | 11 | 4 | src/backend/big-table-import/pipeline.js(5), src/backend/vcc-financial-op/workbook-reader.js(2), src/renderer-dialogs.js(2) |
| `POSITION_IMPORT_PROGRESS_ROW_INTERVAL` | 5 | 11 | 1 | src/backend/position-reconciliation-import/preflight.js(3), src/backend/position-reconciliation-import/account-writer.js(2), src/backend/position-reconciliation-import/bank-writer.js(2) |
| `sameDay` | 5 | 11 | 5 | src/main-process/scenario-engines/r5-refund-order-backfill.js(3), src/main-process/scenario-engines/dbs-charge-fund-check.js(2), src/main-process/scenario-engines/engine-date-utils.js(2) |
| `StableArrayHashAccumulator` | 5 | 11 | 1 | src/backend/position-reconciliation-import/preflight.js(3), src/backend/position-reconciliation-import/account-writer.js(2), src/backend/position-reconciliation-import/bank-writer.js(2) |
| `WORKBOOK_ENTRY_NAME` | 5 | 11 | 1 | src/main-process/duplicate-inbound-match/document-statement-reader.js(3), src/backend/big-table-import/zip-reader.js(2), src/backend/position-reconciliation-import/xlsx-reader.js(2) |
| `ensureRowId` | 5 | 10 | 1 | src/main-process/scenario-engines/c1-extract-recon-id.js(2), src/main-process/scenario-engines/c2-offset-bill-mark.js(2), src/main-process/scenario-engines/c3-gateway-recon-join.js(2) |
| `isBlankRow` | 5 | 10 | 1 | src/backend/position-reconciliation-import/xls-reader.js(2), src/backend/position-reconciliation-import/xlsx-reader.js(2), src/main-process/position-reconciliation/common.js(2) |
| `LINK_HEADERS` | 5 | 10 | 1 | src/backend/position-reconciliation-import/account-writer.js(2), src/backend/position-reconciliation-import/maintenance-writer.js(2), src/main-process/position-reconciliation/constants.js(2) |
| `listChannels` | 5 | 10 | 1 | src/main-process/scenarios-bundle-import.js(3), src/backend/database.js(2), src/backend/database/channels-repository.js(2) |
| `listRuns` | 5 | 10 | 2 | src/main-process/bank-bu-recon-session.js(3), src/backend/bank-bu-recon-db/run-repository.js(2), src/backend/vcc-op-calc-db/run-repository.js(2) |
| `normalizeFundTransferDatePolicy` | 5 | 10 | 3 | src/main-process/scenario-engines/dbs-charge-fund-check.js(2), src/main-process/scenario-engines/fund-transfer-engine-policy.js(2), src/main-process/scenario-engines/many-to-many-detector.js(2) |
| `ORDER_REPAIR_FIELDS_GATEWAY` | 5 | 10 | 3 | src/constants/gateway-bill-recon-fields.js(2), src/main-process/pre-fund-reconciliation/excel-writer.js(2), src/main-process/recon-id-fix-io.js(2) |
| `verifySealedLedger` | 5 | 10 | 1 | src/backend/position-reconciliation-import/account-writer.js(2), src/backend/position-reconciliation-import/bank-writer.js(2), src/backend/position-reconciliation-import/ledger.js(2) |
| `getLatestRun` | 5 | 9 | 2 | src/backend/acquiring-bill-currency-db/run-repository.js(2), src/backend/bank-bu-recon-db/run-repository.js(2), src/main-process/acquiring-bill-currency-run-data.js(2) |
| `splitTemplateName` | 5 | 8 | 2 | src/backend/database/own-accounts-migration.js(2), src/main-process/manual-balance-seed-preflight.js(2), src/main-process/monthly-balance.js(2) |
| `deleteTemplate` | 5 | 7 | 1 | src/backend/database.js(2), src/backend/database/template-repository.js(2), src/preload.js(1) |
| `updateRunExportPath` | 5 | 7 | 2 | src/backend/bank-bu-recon-db/run-repository.js(2), src/backend/biz-op-recon-db/run-repository.js(2), src/main-process/bank-bu-recon-run-data.js(1) |
| `deleteSideDb` | 5 | 6 | 1 | src/backend/run-data-store.js(2), src/backend/pre-fund-reconciliation-run-store.js(1), src/main-process/acquiring-bill-currency-run-data.js(1) |
| `normalizeText` | 4 | 97 | 3 | src/backend/database/template-repository.js(57), src/main-process/pre-fund-reconciliation/mpt-schema.js(27), src/backend/database/utils.js(10) |
| `setStatus` | 4 | 87 | 1 | src/renderer.js(36), src/renderer-dialogs.js(32), src/renderer-position-reconciliation.js(18) |
| `trimCell` | 4 | 65 | 3 | src/main-process/pre-fund-reconciliation/matching-engine.js(36), src/main-process/pre-fund-reconciliation/bank-row.js(13), src/main-process/pre-fund-reconciliation/output-mapper.js(12) |
| `scan` | 4 | 54 | 1 | src/main-process/archive-center/storage-root-manager.js(29), src/main-process/archive-center/archive-service.js(20), src/main-process/vcc-op-calc-session.js(4) |
| `step` | 4 | 54 | 1 | src/backend/vcc-financial-op/mutation-policy.js(32), src/backend/vcc-financial-op/destructive-write.js(11), src/backend/vcc-financial-op/result-write.js(10) |
| `runRepo` | 4 | 45 | 4 | src/main-process/acquiring-bill-currency-session.js(25), src/main-process/acquiring-bill-currency-run-data.js(15), src/main-process/acquiring-bill-currency-writer.js(4) |
| `targetPathAliasKey` | 4 | 38 | 1 | src/main-process/toolbox-output-publication.js(31), src/main-process/toolbox-target-identity.js(4), src/main-process/archive-center/file-plan.js(2) |
| `normalizeBu` | 4 | 29 | 2 | src/main-process/biz-op-recon-run-data.js(11), src/main-process/bank-bu-recon-session.js(8), src/main-process/biz-op-recon-session.js(7) |
| `tableColumns` | 4 | 29 | 4 | src/main-process/vcc-financial-op-storage-rebuild.js(10), src/backend/vcc-financial-op-db/migrations.js(8), src/main-process/position-reconciliation/large-import-schema.js(7) |
| `setSetting` | 4 | 28 | 1 | src/backend/database/settings-repository.js(20), src/backend/database.js(3), src/main-process/archive-center/controller.js(3) |
| `emitProgress` | 4 | 27 | 4 | src/main-process/vcc-financial-op-storage-rebuild.js(8), src/backend/vcc-financial-op/destructive-write.js(7), src/backend/vcc-financial-op/result-write.js(7) |
| `SYSTEM_OP_HEADERS` | 4 | 27 | 1 | src/backend/vcc-financial-op/system-op-importer.js(11), src/backend/vcc-financial-op/workbook-reader.js(7), src/main-process/vcc-financial-op-dataset-writer.js(5) |
| `getStatus` | 4 | 26 | 1 | src/main-process/app-updater.js(22), src/main-process/run-check-worker-pool.js(2), src/preload.js(1) |
| `pad2` | 4 | 26 | 4 | src/main-process/acquiring-bill-currency-writer.js(11), src/backend/usage-stats.js(6), src/main-process/toolbox.js(5) |
| `MATCH_TYPES` | 4 | 23 | 1 | src/main-process/position-reconciliation/store.js(10), src/main-process/position-reconciliation/service.js(9), src/main-process/position-reconciliation/constants.js(2) |
| `scopeKey` | 4 | 23 | 1 | src/main-process/position-reconciliation/store.js(10), src/main-process/archive-center/task-policy-registry.js(5), src/main-process/position-reconciliation/service.js(5) |
| `monthRepository` | 4 | 22 | 3 | src/main-process/bank-bu-recon-run-data.js(7), src/main-process/bank-bu-recon-session.js(7), src/main-process/pending-import-preflight.js(5) |
| `FIXED_FIELD_VALUE_PREFIX` | 4 | 21 | 2 | src/backend/file-service.js(13), src/backend/database/utils.js(5), src/backend/file-service/common.js(2) |
| `importsRepository` | 4 | 21 | 4 | src/main-process/biz-op-recon-run-data.js(10), src/main-process/biz-op-recon-session.js(5), src/backend/biz-op-recon-import/import-worker.js(3) |
| `PRESERVED_OPERATIONS` | 4 | 21 | 1 | src/backend/vcc-financial-op/preserved-state.js(10), src/backend/vcc-financial-op/data-target-deletion.js(5), src/backend/vcc-financial-op/dataset-deletion.js(3) |
| `isCanonicalFundTransferOwner` | 4 | 19 | 1 | src/renderer-dialogs.js(7), src/backend/database/scenarios-repository.js(6), src/main-process/fund-transfer-date-policy.js(4) |
| `workerData` | 4 | 19 | 3 | src/main-process/vcc-financial-op-read-worker.js(7), src/main-process/vcc-financial-op-write-worker.js(6), src/backend/vcc-financial-op/worker-entry.js(4) |
| `importRepo` | 4 | 18 | 4 | src/main-process/acquiring-bill-currency-session.js(7), src/backend/acquiring-bill-currency-import/reader.js(5), src/main-process/acquiring-bill-currency-run-data.js(5) |
| `MERCHANT_ID_SELF_INPUT_OPTION` | 4 | 17 | 2 | src/renderer.js(8), src/renderer-dialogs.js(6), src/renderer-previews.js(2) |
| `writeErrorReport` | 4 | 17 | 1 | src/main-process/biz-op-recon-session.js(13), src/main-process/exceljs-writer.js(2), src/main-process/bank-statement-io.js(1) |
| `ARCHIVE_CONTRACTS` | 4 | 15 | 2 | src/backend/vcc-financial-op/archive-contract.js(7), src/backend/vcc-financial-op/destructive-write.js(3), src/backend/vcc-financial-op/read-snapshot.js(3) |
| `readPositionDatabaseCheckpoint` | 4 | 15 | 1 | src/main-process/position-reconciliation/large-import-schema.js(5), src/main-process/position-reconciliation/side-db-mutation.js(4), src/main-process/position-reconciliation/store.js(4) |
| `SOURCE_TYPE_INBOUND` | 4 | 15 | 1 | src/main-process/pre-fund-reconciliation/mpt-schema.js(7), src/main-process/duplicate-inbound-match/service.js(3), src/main-process/pre-fund-reconciliation/mpt-error-report-writer.js(3) |
| `YELLOW_FILL` | 4 | 15 | 4 | src/main-process/bank-bu-recon-writer.js(6), src/main-process/biz-op-recon-writer.js(4), src/main-process/exceljs-writer.js(3) |
| `BALANCE_CALCULATED_OPTION` | 4 | 14 | 2 | src/renderer-dialogs.js(5), src/renderer.js(5), src/renderer-previews.js(3) |
| `DELETE_TARGET_LABELS` | 4 | 14 | 2 | src/backend/vcc-financial-op/data-target-deletion.js(6), src/backend/vcc-financial-op/read-snapshot.js(4), src/backend/vcc-financial-op/destructive-write.js(3) |
| `STATE_CHANGED_CODE` | 4 | 14 | 1 | src/backend/vcc-financial-op/destructive-write.js(4), src/backend/vcc-financial-op/operation-state.js(4), src/backend/vcc-financial-op/result-write.js(3) |
| `STATE_CHANGED_MESSAGE` | 4 | 14 | 1 | src/backend/vcc-financial-op/destructive-write.js(4), src/backend/vcc-financial-op/operation-state.js(4), src/backend/vcc-financial-op/result-write.js(3) |
| `DecimalAccumulator` | 4 | 13 | 3 | src/backend/vcc-financial-op/calculator.js(4), src/backend/vcc-financial-op/result-adjustments.js(4), src/backend/vcc-financial-op/decimal-accumulator.js(3) |
| `inferDateCellFormat` | 4 | 13 | 1 | src/backend/file-service/writers.js(4), src/main-process/toolbox-stream-io.js(4), src/backend/file-service.js(3) |
| `normalizeOperationMonth` | 4 | 13 | 1 | src/backend/vcc-financial-op/unarchive.js(4), src/backend/vcc-financial-op/data-target-deletion.js(3), src/backend/vcc-financial-op/operation-state.js(3) |
| `rowValues` | 4 | 13 | 3 | src/main-process/duplicate-inbound-match/excel-writer.js(4), src/main-process/position-reconciliation/readers.js(4), src/backend/position-reconciliation-import/xls-reader.js(3) |
| `snapshotPreservedOperationState` | 4 | 13 | 1 | src/backend/vcc-financial-op/data-target-deletion.js(5), src/backend/vcc-financial-op/dataset-deletion.js(3), src/backend/vcc-financial-op/unarchive.js(3) |
| `throwIfCancelled` | 4 | 13 | 1 | src/backend/vcc-financial-op/detail-importer.js(7), src/backend/vcc-financial-op/import-service.js(3), src/backend/acquiring-bill-currency-db/run-repository.js(2) |
| `toExcelSerial` | 4 | 13 | 1 | src/backend/file-service/writers.js(4), src/main-process/toolbox-stream-io.js(4), src/backend/file-service.js(3) |
| `BANK_STATUSES` | 4 | 12 | 1 | src/main-process/position-reconciliation/service.js(4), src/main-process/position-reconciliation/store.js(4), src/backend/position-reconciliation-import/bank-writer.js(2) |
| `BILL_KEY_COLUMN_INDICES` | 4 | 12 | 4 | src/backend/acquiring-bill-currency-import/contract-bill.js(6), src/backend/acquiring-bill-currency-import/reader.js(3), src/backend/acquiring-bill-currency-db/columns.js(2) |
| `buildOperationState` | 4 | 12 | 1 | src/backend/vcc-financial-op/unarchive.js(5), src/backend/vcc-financial-op/dataset-deletion.js(3), src/backend/vcc-financial-op/data-target-deletion.js(2) |
| `dayDiffAbs` | 4 | 12 | 1 | src/main-process/scenario-engines/dbs-charge-fund-check.js(3), src/main-process/scenario-engines/r5-fund-transfer-backfill.js(3), src/main-process/scenario-engines/r5-fund-transfer-recon-backfill.js(3) |
| `DETAIL_SOURCE_TYPES` | 4 | 12 | 3 | src/backend/vcc-financial-op/destructive-write.js(4), src/backend/vcc-financial-op/detail-importer.js(4), src/backend/vcc-financial-op/dataset-deletion.js(2) |
| `sanitizeSheetName` | 4 | 12 | 4 | src/backend/pending-export/writer.js(3), src/main-process/acquiring-bill-currency-writer.js(3), src/main-process/toolbox-output-writer.js(3) |
| `ADVANCED_MAPPING_FIELDS` | 4 | 11 | 2 | src/renderer-previews.js(4), src/renderer.js(4), src/renderer-dialogs.js(2) |
| `cancelRequested` | 4 | 11 | 2 | src/main-process/vcc-financial-op-write-worker.js(4), src/backend/vcc-financial-op/worker-entry.js(3), src/main-process/vcc-financial-op-service.js(3) |
| `FLOW_KEY_COLUMN_INDICES` | 4 | 11 | 4 | src/backend/acquiring-bill-currency-import/contract-flow.js(4), src/backend/acquiring-bill-currency-import/reader.js(3), src/backend/acquiring-bill-currency-db/columns.js(2) |
| `normalizeTransactionNo` | 4 | 11 | 4 | src/main-process/boc-fx-link-builder.js(5), src/backend/database/linked-table-repository.js(2), src/backend/database/migrations.js(2) |
| `PENDING_V1_HEADERS` | 4 | 11 | 1 | src/backend/vcc-financial-op/definitions.js(4), src/backend/vcc-financial-op/row-mapper.js(3), src/backend/vcc-financial-op-db/migrations.js(2) |
| `STAGING_RELATIVE_PATH` | 4 | 11 | 1 | src/main-process/position-reconciliation/input-staging.js(5), src/backend/position-reconciliation-import/preflight.js(2), src/main-process/position-reconciliation/import-dispatch.js(2) |
| `WATERMARK_AUTHOR` | 4 | 11 | 4 | src/main-process/workbook-watermark.js(4), src/main-process/pre-fund-reconciliation/excel-writer.js(3), src/main-process/toolbox-output-writer.js(2) |
| `assertPreviewToken` | 4 | 10 | 1 | src/backend/vcc-financial-op/data-target-deletion.js(3), src/backend/vcc-financial-op/dataset-deletion.js(3), src/backend/vcc-financial-op/operation-state.js(2) |
| `AUDIT_HEADERS` | 4 | 10 | 1 | src/main-process/position-reconciliation/contracts.js(4), src/main-process/position-reconciliation/constants.js(3), src/main-process/position-reconciliation/readers.js(2) |
| `BANK_DB_COLUMNS` | 4 | 10 | 1 | src/backend/bank-bu-recon-db/month-repository.js(3), src/main-process/bank-bu-recon-writer.js(3), src/backend/bank-bu-recon-db/columns.js(2) |
| `CHANNEL_BILL_FIELDS` | 4 | 10 | 2 | src/renderer-dialogs.js(4), src/constants/gateway-bill-recon-fields.js(2), src/main-process/recon-id-fix-io.js(2) |
| `createChannel` | 4 | 10 | 2 | src/backend/position-reconciliation-import/worker-entry.js(3), src/main-process/scenarios-bundle-import.js(3), src/backend/database.js(2) |
| `emptyStats` | 4 | 10 | 1 | src/backend/position-reconciliation-import/preflight.js(4), src/backend/position-reconciliation-import/account-writer.js(2), src/backend/position-reconciliation-import/bank-writer.js(2) |
| `ensureBizOpReconTablesSupport` | 4 | 10 | 4 | src/backend/database.js(4), src/backend/biz-op-recon-db/migrations.js(2), src/backend/biz-op-recon-import/import-worker.js(2) |
| `freezePersistedTaskOwner` | 4 | 10 | 1 | src/main-process/archive-center/controller.js(4), src/main-process/position-reconciliation/operation-lifecycle.js(3), src/main-process/archive-center/worker-operation-context.js(2) |
| `PENDING_GUANLI_DB_COLUMNS` | 4 | 10 | 1 | src/backend/bank-bu-recon-db/month-repository.js(3), src/main-process/bank-bu-recon-writer.js(3), src/backend/bank-bu-recon-db/columns.js(2) |
| `POSITION_IMPORT_PROTOCOL_VERSION` | 4 | 10 | 1 | src/backend/position-reconciliation-import/ledger.js(4), src/backend/position-reconciliation-import/constants.js(2), src/backend/position-reconciliation-import/worker-entry.js(2) |
| `readerFor` | 4 | 10 | 1 | src/backend/position-reconciliation-import/preflight.js(4), src/backend/position-reconciliation-import/account-writer.js(2), src/backend/position-reconciliation-import/bank-writer.js(2) |
| `ToolboxHeaderMismatchError` | 4 | 10 | 4 | src/main-process/toolbox.js(4), src/backend/toolbox-xlsx-stream/multi-sheet-reader.js(2), src/main-process/toolbox-format-io.js(2) |
| `assertStagedInputUnchangedAsync` | 4 | 9 | 1 | src/backend/position-reconciliation-import/source-writer.js(3), src/backend/position-reconciliation-import/account-writer.js(2), src/backend/position-reconciliation-import/bank-writer.js(2) |
| `BANK_HEADERS` | 4 | 9 | 1 | src/main-process/bank-bu-recon-writer.js(3), src/backend/bank-bu-recon-db/columns.js(2), src/backend/bank-bu-recon-import/reader.js(2) |
| `buildRunRowKey` | 4 | 9 | 3 | src/backend/vcc-financial-op/result-adjustments.js(3), src/backend/vcc-financial-op/archive-evidence.js(2), src/backend/vcc-financial-op/calculator.js(2) |
| `dispatchEngineImport` | 4 | 9 | 4 | src/main-process/acquiring-bill-currency-session.js(3), src/main-process/big-table-import-dispatch.js(2), src/main-process/biz-op-recon-session.js(2) |
| `getBankRows` | 4 | 9 | 1 | src/main-process/position-reconciliation/service.js(4), src/backend/bank-bu-recon-db/month-repository.js(2), src/main-process/position-reconciliation/store.js(2) |
| `hashSourceFiles` | 4 | 9 | 3 | src/backend/vcc-financial-op/detail-importer.js(3), src/backend/vcc-financial-op/import-service.js(2), src/backend/vcc-financial-op/source-lineage.js(2) |
| `isValidInputFingerprint` | 4 | 9 | 3 | src/backend/vcc-financial-op/calculator.js(3), src/backend/vcc-financial-op/archive-contract.js(2), src/backend/vcc-financial-op/result-write.js(2) |
| `locateSheets` | 4 | 9 | 1 | src/backend/toolbox-xlsx-stream/multi-sheet-reader.js(3), src/main-process/duplicate-inbound-match/document-statement-reader.js(3), src/backend/vcc-financial-op/workbook-reader.js(2) |
| `moduleDir` | 4 | 9 | 1 | src/backend/run-data-store.js(5), src/backend/duplicate-inbound-match-store.js(2), src/backend/pre-fund-reconciliation-run-store.js(1) |
| `normalizedSaxAttributes` | 4 | 9 | 1 | src/backend/toolbox-format/xlsx-pass.js(3), src/backend/toolbox-format/ooxml-namespaces.js(2), src/backend/toolbox-format/style-registry.js(2) |
| `operationPreviewToken` | 4 | 9 | 1 | src/backend/vcc-financial-op/dataset-deletion.js(3), src/backend/vcc-financial-op/data-target-deletion.js(2), src/backend/vcc-financial-op/operation-state.js(2) |
| `parseWorkbookXml` | 4 | 9 | 2 | src/backend/toolbox-format/xlsx-pass.js(3), src/backend/position-reconciliation-import/xlsx-reader.js(2), src/backend/vcc-financial-op/workbook-reader.js(2) |
| `PENDING_GUANLI_HEADERS` | 4 | 9 | 1 | src/main-process/bank-bu-recon-writer.js(3), src/backend/bank-bu-recon-db/columns.js(2), src/backend/bank-bu-recon-import/reader.js(2) |
| `readXlsxStreamed` | 4 | 9 | 4 | src/main-process/toolbox-stream-io.js(3), src/backend/file-service/readers.js(2), src/backend/pending-import/worker.js(2) |
| `refreshImportRecordArchiveState` | 4 | 9 | 1 | src/backend/vcc-financial-op-db/repository.js(3), src/main-process/vcc-financial-op-archive-lineage.js(3), src/backend/vcc-financial-op/import-service.js(2) |
| `streamFlowFile` | 4 | 9 | 4 | src/backend/biz-op-recon-import/reader-streamed.js(3), src/backend/biz-op-recon-import/import-worker.js(2), src/backend/vcc-op-calc-import/reader.js(2) |
| `styleHeader` | 4 | 9 | 4 | src/main-process/vcc-financial-op-dataset-writer.js(3), src/backend/position-reconciliation-import/anomaly-report.js(2), src/main-process/position-reconciliation/filtered-source-report.js(2) |
| `addOneDay` | 4 | 8 | 1 | src/main-process/biz-op-recon-run-data.js(3), src/backend/biz-op-recon-import/import-worker.js(2), src/main-process/biz-op-recon-session.js(2) |
| `BUSINESS_BILL_FIELDS` | 4 | 8 | 2 | src/constants/recon-id-fix-fields.js(2), src/main-process/recon-id-fix-io.js(2), src/preload.js(2) |
| `classifySourceRow` | 4 | 8 | 1 | src/backend/position-reconciliation-import/contracts.js(2), src/backend/position-reconciliation-import/preflight.js(2), src/backend/position-reconciliation-import/source-writer.js(2) |
| `clearRunsAndDiffsByDateBu` | 4 | 8 | 1 | src/backend/biz-op-recon-db/run-repository.js(2), src/backend/biz-op-recon-import/import-worker.js(2), src/main-process/biz-op-recon-run-data.js(2) |
| `createToolboxCell` | 4 | 8 | 1 | src/backend/toolbox-format/biff8-pass.js(2), src/backend/toolbox-format/csv-pass.js(2), src/backend/toolbox-format/model.js(2) |
| `createToolboxRow` | 4 | 8 | 1 | src/backend/toolbox-format/biff8-pass.js(2), src/backend/toolbox-format/csv-pass.js(2), src/backend/toolbox-format/model.js(2) |
| `createToolboxSheetMeta` | 4 | 8 | 1 | src/backend/toolbox-format/biff8-pass.js(2), src/backend/toolbox-format/csv-pass.js(2), src/backend/toolbox-format/model.js(2) |
| `detectToolboxInputKind` | 4 | 8 | 4 | src/main-process/toolbox-format-io.js(2), src/main-process/toolbox-input-kind.js(2), src/main-process/toolbox-large-split-router.js(2) |
| `diagnoseFirstMonthFacts` | 4 | 8 | 2 | src/backend/vcc-financial-op-db/migrations.js(2), src/backend/vcc-financial-op-db/repository.js(2), src/backend/vcc-financial-op-db/state-model.js(2) |
| `filterStagingPathsWithoutProtectedSources` | 4 | 8 | 1 | src/main-process/position-reconciliation/service.js(3), src/main-process/position-reconciliation/import-dispatch.js(2), src/main-process/position-reconciliation/input-staging.js(2) |
| `getRowsByDateBu` | 4 | 8 | 2 | src/main-process/biz-op-recon-session.js(3), src/backend/biz-op-recon-db/flow-imports-repository.js(2), src/backend/biz-op-recon-db/imports-repository.js(2) |
| `listTemplates` | 4 | 8 | 1 | src/backend/database/template-repository.js(3), src/backend/database.js(2), src/main-process/monthly-balance.js(2) |
| `OPPONENT_BILL_FIELDS` | 4 | 8 | 2 | src/constants/recon-id-fix-fields.js(2), src/main-process/recon-id-fix-io.js(2), src/preload.js(2) |
| `saveBillSplitAmountRules` | 4 | 8 | 1 | src/renderer-dialogs.js(3), src/backend/database.js(2), src/backend/database/template-repository.js(2) |
| `saveBillSplitMeta` | 4 | 8 | 1 | src/renderer-dialogs.js(3), src/backend/database.js(2), src/backend/database/template-repository.js(2) |
| `scanXlsxSheet` | 4 | 8 | 1 | src/backend/position-reconciliation-import/xlsx-reader.js(2), src/backend/toolbox-format/xlsx-pass.js(2), src/backend/toolbox-format/xlsx-sheet-scanner.js(2) |
| `validateBillHeaders` | 4 | 8 | 4 | src/backend/acquiring-bill-currency-import/reader.js(3), src/backend/acquiring-bill-currency-import/contract-bill.js(2), src/backend/acquiring-bill-currency-import/validator.js(2) |
| `validateFlowRow` | 4 | 8 | 3 | src/backend/biz-op-recon-import/contract-flow.js(2), src/backend/biz-op-recon-import/import-worker.js(2), src/backend/biz-op-recon-import/validator.js(2) |
| `writeWorkbookRows` | 4 | 8 | 2 | src/backend/file-service.js(4), src/backend/file-service/writers.js(2), src/main-process/statement-generation.js(1) |
| `artifactManifestFromFilePlan` | 4 | 7 | 1 | src/main-process/archive-center/archive-service.js(2), src/main-process/archive-center/file-plan.js(2), src/main-process/archive-center/task-lifecycle.js(2) |
| `assertXlsxEntriesUnderLimit` | 4 | 7 | 4 | src/backend/biz-op-recon-import/reader-streamed.js(2), src/backend/pending-import/xlsx-size-preflight.js(2), src/backend/vcc-op-calc-import/reader.js(2) |
| `buildDateDir` | 4 | 7 | 3 | src/main-process/scenario-hit-rows-writer.js(3), src/main-process/acquiring-bill-currency-writer.js(2), src/main-process/bank-statement-io.js(1) |
| `errorCodeToCause` | 4 | 7 | 4 | src/backend/file-service/error-causes.js(2), src/main-process/exceljs-writer.js(2), src/main-process/pending-session.js(2) |
| `insertRows` | 4 | 7 | 2 | src/backend/biz-op-recon-db/flow-imports-repository.js(2), src/backend/biz-op-recon-db/imports-repository.js(2), src/main-process/biz-op-recon-session.js(2) |
| `normalizeFilePlanV1` | 4 | 7 | 1 | src/main-process/archive-center/archive-service.js(2), src/main-process/archive-center/file-plan.js(2), src/main-process/archive-center/ipc-task-contract.js(2) |
| `pathsAlias` | 4 | 7 | 1 | src/main-process/archive-center/file-plan.js(2), src/main-process/toolbox-output-publication.js(2), src/main-process/toolbox-target-identity.js(2) |
| `readRowsWithMetadata` | 4 | 7 | 1 | src/backend/file-service.js(3), src/main-process/table-type-detector.js(2), src/backend/file-service/readers.js(1) |
| `setChildParent` | 4 | 7 | 1 | src/backend/database.js(2), src/backend/database/template-repository.js(2), src/renderer-dialogs.js(2) |
| `writeBalanceWorkbook` | 4 | 7 | 2 | src/backend/file-service.js(3), src/backend/file-service/writers.js(2), src/main-process/statement-generation.js(1) |
| `writeHead` | 4 | 7 | 1 | src/backend/biz-op-recon-db/dataset-head-repository.js(2), src/backend/biz-op-recon-import/import-worker.js(2), src/main-process/biz-op-recon-session.js(2) |
| `writeXlsxAtomically` | 4 | 7 | 4 | src/main-process/vcc-financial-op-audit-writer.js(2), src/main-process/vcc-financial-op-dataset-writer.js(2), src/main-process/vcc-financial-op-output-publication.js(2) |
| `buildTimestamp` | 4 | 6 | 3 | src/main-process/acquiring-bill-currency-writer.js(2), src/main-process/scenario-hit-rows-writer.js(2), src/main-process/bank-statement-io.js(1) |
| `clearBillSplitMergeGroups` | 4 | 6 | 1 | src/backend/database.js(2), src/backend/database/template-repository.js(2), src/preload.js(1) |
| `createImportRecord` | 4 | 6 | 1 | src/backend/vcc-financial-op-db/repository.js(2), src/backend/vcc-financial-op/detail-importer.js(2), src/backend/vcc-financial-op/import-service.js(1) |
| `createImportSource` | 4 | 6 | 1 | src/backend/vcc-financial-op-db/repository.js(2), src/backend/vcc-financial-op/detail-importer.js(2), src/backend/vcc-financial-op/import-service.js(1) |
| `createRowFilter` | 4 | 6 | 2 | src/main-process/toolbox-format-operations.js(2), src/main-process/toolbox.js(2), src/main-process/toolbox-multi-split.js(1) |
| `deleteBillSplitRow` | 4 | 6 | 1 | src/backend/database.js(2), src/backend/database/template-repository.js(2), src/preload.js(1) |
| `readBankStatement` | 4 | 6 | 3 | src/main-process/duplicate-inbound-match/service.js(2), src/main-process/pre-fund-reconciliation/service.js(2), src/main-process/bank-statement-io.js(1) |
| `runBizOpImport` | 4 | 6 | 2 | src/backend/biz-op-recon-import/import-worker.js(2), src/main-process/biz-op-recon-run-data.js(2), src/main.js(1) |
| `runFlowImport` | 4 | 6 | 2 | src/backend/biz-op-recon-import/import-worker.js(2), src/main-process/biz-op-recon-run-data.js(2), src/main.js(1) |
| `saveAmountSplitRules` | 4 | 6 | 1 | src/backend/database.js(2), src/backend/database/template-repository.js(2), src/preload.js(1) |
| `saveBillSplitMappings` | 4 | 6 | 1 | src/backend/database.js(2), src/backend/database/template-repository.js(2), src/preload.js(1) |
| `saveBillSplitMergeGroup` | 4 | 6 | 1 | src/backend/database.js(2), src/backend/database/template-repository.js(2), src/preload.js(1) |
| `saveBillSplitRow` | 4 | 6 | 1 | src/backend/database.js(2), src/backend/database/template-repository.js(2), src/preload.js(1) |
| `saveBillSplitRowCount` | 4 | 6 | 1 | src/backend/database.js(2), src/backend/database/template-repository.js(2), src/preload.js(1) |
| `setParentStatus` | 4 | 6 | 1 | src/backend/database.js(2), src/backend/database/template-repository.js(2), src/preload.js(1) |
| `StringDecoder` | 4 | 6 | 4 | src/backend/biz-op-recon-import/reader-streamed.js(2), src/backend/vcc-op-calc-import/reader.js(2), src/backend/acquiring-bill-currency-import/reader-handrolled.js(1) |
| `batchDelete` | 4 | 5 | 1 | src/backend/database/scenarios-repository.js(2), src/backend/database.js(1), src/preload.js(1) |
| `clearByDateBu` | 4 | 5 | 1 | src/backend/biz-op-recon-db/imports-repository.js(2), src/backend/biz-op-recon-import/import-worker.js(1), src/main-process/biz-op-recon-run-data.js(1) |
| `deleteArchiveRunByTaskRunId` | 4 | 5 | 1 | src/backend/biz-op-recon-db/run-repository.js(2), src/backend/pre-fund-reconciliation-run-store.js(1), src/main-process/biz-op-recon-run-data.js(1) |
| `extractHeaders` | 4 | 5 | 1 | src/backend/file-service.js(2), src/main-process/statement-generation.js(1), src/main-process/toolbox-stream-io.js(1) |
| `failImportBatch` | 4 | 5 | 1 | src/backend/vcc-financial-op-db/repository.js(2), src/backend/vcc-financial-op/detail-importer.js(1), src/backend/vcc-financial-op/import-service.js(1) |
| `ToolboxXlsxFormatError` | 3 | 124 | 1 | src/backend/toolbox-format/xlsx-sheet-scanner.js(69), src/backend/toolbox-format/xlsx-pass.js(50), src/backend/position-reconciliation-import/xlsx-reader.js(5) |
| `MODULES` | 3 | 101 | 2 | src/renderer-previews.js(62), src/renderer.js(37), src/main-process/archive-center/operation-tracker.js(2) |
| `requiredText` | 3 | 96 | 3 | src/backend/database/archive-repository.js(79), src/main-process/archive-center/business-flow-resolver.js(11), src/main-process/archive-center/file-plan.js(6) |
| `countRows` | 3 | 48 | 3 | src/backend/vcc-financial-op/destructive-write.js(27), src/backend/vcc-financial-op/detail-importer.js(16), src/backend/vcc-financial-op/operation-state.js(5) |
| `hasColumn` | 3 | 47 | 2 | src/backend/database/migrations.js(39), src/backend/biz-op-recon-db/migrations.js(5), src/backend/database.js(3) |
| `RECON` | 3 | 43 | 3 | src/main-process/scenario-engines/r5-payment-offline-allocation-backfill.js(24), src/main-process/scenario-engines/r5-fund-transfer-recon-backfill.js(15), src/main-process/scenario-engines/many-to-many-detector.js(4) |
| `bankValue` | 3 | 41 | 1 | src/main-process/pre-fund-reconciliation/output-mapper.js(33), src/main-process/position-reconciliation/logical-accounts.js(4), src/main-process/scenario-engines/c3-gateway-recon-join.js(4) |
| `settingsRepository` | 3 | 40 | 3 | src/backend/database.js(31), src/main-process/import-dialog-state.js(5), src/backend/database/own-accounts-migration.js(4) |
| `applyMismatch` | 3 | 38 | 3 | src/backend/position-reconciliation-import/source-writer.js(21), src/backend/position-reconciliation-import/account-writer.js(9), src/backend/position-reconciliation-import/bank-writer.js(8) |
| `publicFailure` | 3 | 34 | 3 | src/main-process/archive-center/controller.js(23), src/main-process/archive-center/storage-root-manager.js(7), src/main-process/vcc-financial-op-storage-migration.js(4) |
| `POSITION_IMPORT_MESSAGE_TYPES` | 3 | 31 | 1 | src/backend/position-reconciliation-import/worker-entry.js(18), src/main-process/position-reconciliation/import-dispatch.js(11), src/backend/position-reconciliation-import/constants.js(2) |
| `runEvidence` | 3 | 31 | 1 | src/main-process/acquiring-bill-currency-run-data.js(27), src/backend/vcc-financial-op/calculator.js(2), src/backend/vcc-financial-op/unarchive.js(2) |
| `validationError` | 3 | 31 | 1 | src/main-process/pre-fund-reconciliation/mpt-schema.js(17), src/main-process/pre-fund-reconciliation/mpt-parser.js(11), src/main-process/toolbox-output-writer.js(3) |
| `SYSTEM_OP_DEFINITION` | 3 | 29 | 1 | src/backend/vcc-financial-op/system-op-importer.js(24), src/main-process/vcc-financial-op-dataset-writer.js(3), src/backend/vcc-financial-op/definitions.js(2) |
| `datasetHeadRepository` | 3 | 26 | 3 | src/main-process/biz-op-recon-session.js(11), src/backend/biz-op-recon-import/import-worker.js(10), src/main-process/biz-op-recon-run-data.js(5) |
| `DELETE_TARGET_TYPES` | 3 | 26 | 2 | src/backend/vcc-financial-op/data-target-deletion.js(10), src/backend/vcc-financial-op/destructive-write.js(8), src/backend/vcc-financial-op/read-snapshot.js(8) |
| `BigTableImportError` | 3 | 25 | 1 | src/backend/vcc-financial-op/workbook-reader.js(14), src/backend/big-table-import/engine.js(7), src/backend/big-table-import/zip-reader.js(4) |
| `lastGeneratedExports` | 3 | 24 | 1 | src/main-process/statement-generation.js(17), src/main-process/statement-session.js(6), src/main.js(1) |
| `recoveryError` | 3 | 24 | 1 | src/main-process/toolbox-output-publication-dispatch.js(15), src/main-process/pre-fund-archive-lineage.js(7), src/main-process/position-reconciliation/import-dispatch.js(2) |
| `REASON_CODES` | 3 | 23 | 2 | src/main-process/position-reconciliation/matching-engine.js(14), src/main-process/position-reconciliation/logical-accounts.js(7), src/main-process/position-reconciliation/contracts.js(2) |
| `TABLE` | 3 | 23 | 3 | src/backend/biz-op-recon-db/imports-repository.js(10), src/backend/biz-op-recon-db/flow-imports-repository.js(7), src/backend/biz-op-recon-db/month-end-copy-intent-repository.js(6) |
| `BANK_ROW_CLASSIFICATION` | 3 | 22 | 1 | src/main-process/pre-fund-reconciliation/bank-row.js(8), src/main-process/pre-fund-reconciliation/matching-engine.js(7), src/main-process/pre-fund-reconciliation/service.js(7) |
| `buildOutputRow` | 3 | 21 | 3 | src/main-process/scenario-engines/c4-recon-id-fix.js(17), src/main-process/scenario-engines/boc-dispatch-order-fix.js(2), src/main-process/scenario-engines/jpm-dispatch-order-fix.js(2) |
| `weekTag` | 3 | 20 | 2 | src/main-process/scenario-engines/r5-payment-offline-allocation-backfill.js(14), src/main-process/exceljs-writer.js(3), src/main-process/scenario-engines/engine-week-utils.js(3) |
| `parseAmount` | 3 | 19 | 3 | src/backend/biz-op-recon-import/validator.js(8), src/backend/vcc-financial-op/row-mapper.js(7), src/main-process/biz-op-recon-session.js(4) |
| `safeRollback` | 3 | 19 | 3 | src/main-process/acquiring-bill-currency-session.js(10), src/backend/big-table-import/engine.js(5), src/backend/vcc-financial-op/detail-importer.js(4) |
| `verifyFile` | 3 | 19 | 1 | src/main-process/archive-center/storage-root-manager.js(11), src/main-process/archive-center/storage-materializer.js(5), src/main-process/archive-center/archive-service.js(3) |
| `businessOperationRegistry` | 3 | 18 | 1 | src/main-process/archive-center/task-lifecycle.js(11), src/main-process/vcc-financial-op-storage-migration.js(4), src/main.js(3) |
| `reportError` | 3 | 18 | 2 | src/backend/position-reconciliation-import/preflight.js(9), src/main-process/pre-fund-reconciliation/mpt-error-report-writer.js(5), src/backend/position-reconciliation-import/anomaly-report.js(4) |
| `CONCAT_FIELDS_MAPPING_FIELD` | 3 | 17 | 2 | src/renderer-dialogs.js(14), src/renderer.js(2), src/main.js(1) |
| `json` | 3 | 17 | 1 | src/main-process/vcc-financial-op-dataset-writer.js(8), src/backend/position-reconciliation-import/ledger.js(6), src/backend/database/archive-repository.js(3) |
| `TOOLBOX_SHEET_STRATEGIES` | 3 | 17 | 1 | src/main-process/toolbox-format-io.js(10), src/main-process/toolbox-format-operations.js(5), src/main-process/toolbox-merge-io.js(2) |
| `BALANCE_DISABLED_OPTION` | 3 | 16 | 2 | src/renderer-dialogs.js(9), src/renderer.js(6), src/main.js(1) |
| `yieldToEventLoop` | 3 | 16 | 3 | src/main-process/duplicate-inbound-match/service.js(8), src/main-process/pre-fund-reconciliation/service.js(5), src/backend/position-reconciliation-import/maintenance-writer.js(3) |
| `diffRepo` | 3 | 15 | 3 | src/backend/pending-export/writer.js(8), src/backend/pending-reconcile/engine.js(4), src/backend/pending-reconcile/removal-match.js(3) |
| `mapRun` | 3 | 15 | 3 | src/backend/pending-db/diff-repository.js(7), src/backend/pre-fund-reconciliation-run-store.js(5), src/backend/duplicate-inbound-match-store.js(3) |
| `own` | 3 | 15 | 1 | src/main-process/duplicate-inbound-match/matching-engine.js(10), src/main-process/position-reconciliation/matching-engine.js(4), src/main-process/position-reconciliation/logical-accounts.js(1) |
| `POSITION_IMPORT_ENGINES` | 3 | 15 | 1 | src/main-process/position-reconciliation/service.js(8), src/backend/position-reconciliation-import/constants.js(5), src/main-process/position-reconciliation/import-dispatch.js(2) |
| `RESULT_MUTATION_OPERATIONS` | 3 | 15 | 1 | src/backend/vcc-financial-op/preserved-state.js(9), src/backend/vcc-financial-op/calculator.js(3), src/backend/vcc-financial-op/result-adjustments.js(3) |
| `PRAGMA_EXPECTED` | 3 | 14 | 3 | src/main-process/run-check-multiworker-worker.js(5), src/main-process/run-check-worker.js(5), src/backend/big-table-import/engine.js(4) |
| `readToolboxMetadataEntryAsString` | 3 | 14 | 1 | src/backend/toolbox-format/xlsx-pass.js(6), src/backend/position-reconciliation-import/xlsx-reader.js(5), src/main-process/toolbox-large-split-router.js(3) |
| `applyStatementResult` | 3 | 13 | 1 | src/renderer.js(7), src/renderer-dialogs.js(5), src/renderer-previews.js(1) |
| `BANK_RECON_ID_FIELD` | 3 | 13 | 3 | src/main-process/scenario-engines/dbs-charge-fund-check.js(6), src/main-process/scenario-engines/r4-fund-nature-check.js(4), src/main-process/scenario-engines/r1-recon-id-match.js(3) |
| `getRunChunkProgress` | 3 | 12 | 1 | src/main-process/acquiring-bill-currency-session.js(5), src/backend/acquiring-bill-currency-db/run-repository.js(4), src/main-process/acquiring-bill-currency-run-data.js(3) |
| `OFFICE_RELATIONSHIP_NAMESPACES` | 3 | 12 | 1 | src/backend/toolbox-format/xlsx-pass.js(7), src/main-process/toolbox-output-writer.js(3), src/backend/toolbox-format/ooxml-namespaces.js(2) |
| `upsertMainRunMirror` | 3 | 12 | 3 | src/main-process/acquiring-bill-currency-run-data.js(5), src/main-process/biz-op-recon-run-data.js(4), src/main-process/bank-bu-recon-run-data.js(3) |
| `compareText` | 3 | 11 | 2 | src/backend/vcc-financial-op/archive-evidence.js(5), src/backend/vcc-financial-op/operation-token-v2.js(4), src/renderer-pending.js(2) |
| `EXCEL_CELL_TEXT_MAX_UTF16_UNITS` | 3 | 11 | 1 | src/backend/toolbox-format/excel-text.js(6), src/backend/toolbox-format/xlsx-sheet-scanner.js(3), src/backend/position-reconciliation-import/shared-strings-provider.js(2) |
| `findRelationshipEntry` | 3 | 11 | 1 | src/backend/toolbox-format/xlsx-pass.js(5), src/backend/position-reconciliation-import/xlsx-reader.js(4), src/main-process/toolbox-large-split-router.js(2) |
| `getLinkedTableMeta` | 3 | 11 | 1 | src/backend/database/linked-table-repository.js(6), src/main-process/pre-fund-reconciliation/service.js(3), src/backend/database.js(2) |
| `getVccFinancialOpModuleState` | 3 | 11 | 1 | src/backend/vcc-financial-op-db/repository.js(4), src/backend/vcc-financial-op/calculator.js(4), src/backend/vcc-financial-op/data-target-deletion.js(3) |
| `parseBalancesJson` | 3 | 11 | 3 | src/backend/vcc-financial-op/calculator.js(7), src/backend/vcc-financial-op/data-target-deletion.js(2), src/backend/vcc-financial-op/unarchive.js(2) |
| `parseDecimalLexical` | 3 | 11 | 1 | src/backend/toolbox-format/number-date.js(5), src/backend/toolbox-format/xlsx-sheet-scanner.js(4), src/backend/toolbox-format/model.js(2) |
| `previewDataTargetDeletion` | 3 | 11 | 1 | src/backend/vcc-financial-op/data-target-deletion.js(7), src/main-process/vcc-financial-op-service.js(3), src/preload.js(1) |
| `processingResult` | 3 | 11 | 1 | src/renderer.js(6), src/main-process/archive-center/task-policy-registry.js(4), src/main.js(1) |
| `rollbackQuietly` | 3 | 11 | 3 | src/backend/pre-fund-reconciliation-store.js(5), src/backend/duplicate-inbound-match-store.js(3), src/main-process/pre-fund-reconciliation/service.js(3) |
| `setRunChunkProgress` | 3 | 11 | 1 | src/main-process/acquiring-bill-currency-session.js(7), src/backend/acquiring-bill-currency-db/run-repository.js(3), src/main-process/acquiring-bill-currency-run-data.js(1) |
| `assertCurrentPositionCheckpointHistory` | 3 | 10 | 1 | src/main-process/position-reconciliation/large-import-schema.js(4), src/main-process/position-reconciliation/side-db-mutation.js(4), src/main-process/position-reconciliation/store.js(2) |
| `bankAmountAbs` | 3 | 10 | 2 | src/main-process/scenario-engines/r5-fund-transfer-backfill.js(5), src/main-process/scenario-engines/r5-refund-order-backfill.js(3), src/main-process/scenario-engines/dbs-charge-fund-check.js(2) |
| `canonicalDecimal` | 3 | 10 | 2 | src/main-process/position-reconciliation/readers.js(6), src/main-process/position-reconciliation/common.js(2), src/main-process/position-reconciliation/derivation.js(2) |
| `closeMutationGuard` | 3 | 10 | 1 | src/backend/vcc-financial-op/result-write.js(5), src/backend/vcc-financial-op/destructive-write.js(3), src/backend/vcc-financial-op/mutation-guard.js(2) |
| `finishImportRecord` | 3 | 10 | 1 | src/backend/vcc-financial-op/detail-importer.js(4), src/backend/vcc-financial-op-db/repository.js(3), src/backend/vcc-financial-op/system-op-importer.js(3) |
| `operations` | 3 | 10 | 1 | src/main-process/business-operation-registry.js(5), src/backend/vcc-financial-op/mutation-policy.js(3), src/backend/vcc-financial-op/mutation-guard.js(2) |
| `PRAGMA_STATEMENTS` | 3 | 10 | 3 | src/main-process/run-check-multiworker-worker.js(4), src/backend/big-table-import/engine.js(3), src/main-process/run-check-worker.js(3) |
| `addToAccumulatorMap` | 3 | 9 | 2 | src/backend/vcc-financial-op/calculator.js(5), src/backend/vcc-financial-op/decimal-accumulator.js(2), src/backend/vcc-financial-op/result-adjustments.js(2) |
| `amountEqual` | 3 | 9 | 3 | src/main-process/scenario-engines/r5-fund-transfer-backfill.js(3), src/main-process/scenario-engines/r5-fund-transfer-recon-backfill.js(3), src/main-process/scenario-engines/r5-payment-offline-allocation-backfill.js(3) |
| `attachSourceIdentity` | 3 | 9 | 1 | src/backend/vcc-financial-op/source-lineage.js(4), src/backend/vcc-financial-op/detail-importer.js(3), src/backend/vcc-financial-op/system-op-importer.js(2) |
| `BANK_STATEMENT_FIELDS_FOR_C3` | 3 | 9 | 2 | src/renderer-dialogs.js(5), src/constants/bank-statement-fields.js(2), src/preload.js(2) |
| `BANK_STATEMENT_VIRTUAL_AMOUNT_ABS` | 3 | 9 | 3 | src/constants/bank-statement-fields.js(3), src/main-process/scenario-engines/c3-gateway-recon-join.js(3), src/preload.js(3) |
| `buildHeaderValidator` | 3 | 9 | 3 | src/backend/acquiring-bill-currency-import/validator.js(3), src/backend/bank-bu-recon-import/validator.js(3), src/backend/biz-op-recon-import/validator.js(3) |
| `classifyBankRow` | 3 | 9 | 1 | src/main-process/pre-fund-reconciliation/bank-row.js(3), src/main-process/pre-fund-reconciliation/matching-engine.js(3), src/main-process/pre-fund-reconciliation/service.js(3) |
| `classifyExcelNumberFormat` | 3 | 9 | 1 | src/backend/toolbox-format/number-date.js(4), src/backend/toolbox-format/model.js(3), src/backend/position-reconciliation-import/xlsx-reader.js(2) |
| `collectEntrySizes` | 3 | 9 | 1 | src/backend/toolbox-xlsx-stream/large-split-worker.js(5), src/backend/pending-import/xlsx-size-preflight.js(3), src/main-process/toolbox-large-split-router.js(1) |
| `detectDetailSourceType` | 3 | 9 | 1 | src/backend/vcc-financial-op/workbook-reader.js(4), src/backend/vcc-financial-op/system-op-importer.js(3), src/backend/vcc-financial-op/definitions.js(2) |
| `exactSaxLocalName` | 3 | 9 | 1 | src/backend/toolbox-format/xlsx-pass.js(4), src/backend/toolbox-format/style-registry.js(3), src/backend/toolbox-format/ooxml-namespaces.js(2) |
| `FLOW_TABLE` | 3 | 9 | 3 | src/backend/acquiring-bill-currency-db/run-repository.js(4), src/backend/biz-op-recon-import/contract-flow.js(3), src/backend/biz-op-recon-db/run-repository.js(2) |
| `FUND_TRANSFER_RECON_USED` | 3 | 9 | 1 | src/main-process/scenario-engines/r5-payment-offline-allocation-backfill.js(4), src/main-process/scenario-engines/r5-fund-transfer-recon-backfill.js(3), src/constants/fund-transfer-recon-fields.js(2) |
| `getChannelById` | 3 | 9 | 1 | src/backend/database/channels-repository.js(6), src/backend/database.js(2), src/main-process/scenario-dispatcher.js(1) |
| `getRunMirror` | 3 | 9 | 2 | src/backend/database/pre-fund-reconciliation-run-repository.js(4), src/backend/database/duplicate-inbound-match-run-repository.js(3), src/backend/database.js(2) |
| `GW_RECON_ID_FIELD` | 3 | 9 | 3 | src/main-process/scenario-engines/r4-fund-nature-check.js(4), src/main-process/scenario-engines/r1-recon-id-match.js(3), src/main-process/scenario-engines/dbs-charge-fund-check.js(2) |
| `hasFundTransferReservedSignature` | 3 | 9 | 1 | src/main-process/fund-transfer-date-policy.js(4), src/backend/database/scenarios-repository.js(3), src/main-process/scenarios-bundle-import.js(2) |
| `isNumericFieldName` | 3 | 9 | 3 | src/main-process/scenario-engines/c2-offset-bill-mark.js(4), src/main-process/scenario-engines/c3-gateway-recon-join.js(3), src/backend/pending-reconcile/removal-match.js(2) |
| `MPT_SCHEMAS` | 3 | 9 | 2 | src/main-process/pre-fund-reconciliation/mpt-schema.js(4), src/main-process/pre-fund-reconciliation/service.js(3), src/backend/pre-fund-reconciliation-store.js(2) |
| `normalizeLegacyStoredCurrency` | 3 | 9 | 1 | src/backend/vcc-financial-op/calculator.js(4), src/main-process/vcc-financial-op-dataset-writer.js(3), src/backend/vcc-financial-op/definitions.js(2) |
| `parseJsonArray` | 3 | 9 | 2 | src/backend/database/template-repository.js(3), src/backend/database/utils.js(3), src/backend/pending-db/rule-repository.js(3) |
| `PENDING_RAW_CONTRACT_V1` | 3 | 9 | 1 | src/backend/vcc-financial-op/definitions.js(4), src/backend/vcc-financial-op/row-mapper.js(3), src/backend/vcc-financial-op-db/migrations.js(2) |
| `PENDING_RAW_CONTRACT_V2` | 3 | 9 | 1 | src/backend/vcc-financial-op/row-mapper.js(4), src/backend/vcc-financial-op/definitions.js(3), src/backend/vcc-financial-op-db/migrations.js(2) |
| `readEntryAsString` | 3 | 9 | 1 | src/main-process/toolbox-output-writer.js(4), src/backend/big-table-import/zip-reader.js(3), src/backend/vcc-financial-op/workbook-reader.js(2) |
| `REFUND_BANK_COLUMNS` | 3 | 9 | 1 | src/constants/refund-backfill-fields.js(4), src/main-process/scenario-engines/r5-refund-order-backfill.js(3), src/main-process/refund-backfill-writer.js(2) |
| `streamToolboxTables` | 3 | 9 | 1 | src/main-process/toolbox-format-operations.js(5), src/main-process/toolbox-format-io.js(2), src/main-process/toolbox-merge-io.js(2) |
| `toInvalidBothNonzeroError` | 3 | 9 | 1 | src/main-process/pre-fund-reconciliation/bank-row.js(3), src/main-process/pre-fund-reconciliation/matching-engine.js(3), src/main-process/pre-fund-reconciliation/service.js(3) |
| `ALLOWED_SOURCE_TYPES` | 3 | 8 | 2 | src/backend/vcc-financial-op/data-target-deletion.js(3), src/backend/vcc-financial-op/dataset-deletion.js(3), src/main-process/vcc-financial-op-dataset-writer.js(2) |
| `AMOUNT_BASED_ACCOUNT_MAPPING_FIELD` | 3 | 8 | 2 | src/renderer-previews.js(3), src/renderer.js(3), src/main.js(2) |
| `AMOUNT_BASED_NAME_MAPPING_FIELD` | 3 | 8 | 2 | src/renderer-previews.js(3), src/renderer.js(3), src/main.js(2) |
| `AMOUNT_EPSILON` | 3 | 8 | 1 | src/backend/biz-op-recon-import/validator.js(4), src/backend/biz-op-recon-db/columns.js(2), src/main-process/biz-op-recon-session.js(2) |
| `AMOUNT_SPLIT_BY_FIELD_ENABLED_OPTION` | 3 | 8 | 2 | src/renderer-dialogs.js(5), src/renderer.js(2), src/main.js(1) |
| `AMOUNT_SPLIT_BY_FIELD_MAPPING_FIELD` | 3 | 8 | 2 | src/renderer-dialogs.js(3), src/renderer.js(3), src/main.js(2) |
| `applyHeaderRowFont` | 3 | 8 | 3 | src/backend/file-service/writers.js(3), src/main-process/pending-session.js(3), src/backend/pending-export/writer.js(2) |
| `assertVccTriggerPolicy` | 3 | 8 | 1 | src/backend/vcc-financial-op/mutation-guard.js(3), src/backend/vcc-financial-op/result-write.js(3), src/backend/vcc-financial-op/destructive-write.js(2) |
| `cloneRowsWithMetadata` | 3 | 8 | 1 | src/main-process/statement-session.js(5), src/main-process/statement-generation.js(2), src/main.js(1) |
| `ensureVccFinancialOpTablesSupport` | 3 | 8 | 3 | src/backend/database.js(4), src/backend/vcc-financial-op-db/migrations.js(2), src/backend/vcc-financial-op/worker-entry.js(2) |
| `FLOW_INSERT_SQL` | 3 | 8 | 3 | src/backend/acquiring-bill-currency-import/contract-flow.js(3), src/backend/biz-op-recon-import/contract-flow.js(3), src/backend/acquiring-bill-currency-db/import-repository.js(2) |
| `GATEWAY_RECON_FIELDS` | 3 | 8 | 3 | src/constants/gateway-recon-headers-loader.js(4), src/constants/gateway-recon-fields.js(2), src/main-process/bank-statement-io.js(2) |
| `getMonthReadiness` | 3 | 8 | 1 | src/main-process/acquiring-bill-currency-run-data.js(3), src/main-process/acquiring-bill-currency-session.js(3), src/backend/acquiring-bill-currency-db/import-repository.js(2) |
| `getTemplateBigAccounts` | 3 | 8 | 1 | src/backend/database/template-repository.js(4), src/backend/database.js(2), src/main-process/monthly-balance.js(2) |
| `groupBy` | 3 | 8 | 2 | src/backend/vcc-financial-op-db/migrations.js(3), src/main-process/scenario-engines/r5-refund-order-backfill.js(3), src/main-process/scenario-engines/jpm-dispatch-order-fix.js(2) |
| `inputEvidenceFor` | 3 | 8 | 3 | src/backend/position-reconciliation-import/account-writer.js(3), src/backend/position-reconciliation-import/bank-writer.js(3), src/backend/position-reconciliation-import/source-writer.js(2) |
| `listDiffRows` | 3 | 8 | 1 | src/backend/pending-export/writer.js(4), src/backend/pending-db/diff-repository.js(2), src/backend/pending-reconcile/removal-match.js(2) |
| `normalizeCurrency` | 3 | 8 | 3 | src/backend/acquiring-bill-currency-db/import-repository.js(4), src/backend/acquiring-bill-currency-import/contract-bill.js(2), src/backend/acquiring-bill-currency-import/contract-flow.js(2) |
| `performance` | 3 | 8 | 2 | src/main-process/vcc-financial-op-read-worker.js(3), src/renderer.js(3), src/main.js(2) |
| `REFUND_TEMPLATE_HEADERS` | 3 | 8 | 1 | src/main-process/refund-backfill-writer.js(4), src/constants/refund-backfill-fields.js(2), src/main-process/scenario-engines/r5-refund-order-backfill.js(2) |
| `registerVccStorageWriteCapability` | 3 | 8 | 1 | src/backend/vcc-financial-op-db/storage-contract.js(4), src/backend/vcc-financial-op-db/migrations.js(2), src/backend/vcc-financial-op/mutation-guard.js(2) |
| `SIGNED_AMOUNT_MAPPING_FIELD` | 3 | 8 | 2 | src/renderer-previews.js(3), src/renderer.js(3), src/main.js(2) |
| `snapshotResultMutationState` | 3 | 8 | 1 | src/backend/vcc-financial-op/calculator.js(3), src/backend/vcc-financial-op/result-adjustments.js(3), src/backend/vcc-financial-op/preserved-state.js(2) |
| `sourceIdentityFromError` | 3 | 8 | 2 | src/backend/vcc-financial-op/detail-importer.js(4), src/backend/vcc-financial-op/import-service.js(2), src/backend/vcc-financial-op/source-lineage.js(2) |
| `sourceTypeForFundType` | 3 | 8 | 1 | src/main-process/position-reconciliation/store.js(4), src/main-process/position-reconciliation/constants.js(2), src/main-process/position-reconciliation/service.js(2) |
| `TEXT_HEADER_PATTERN` | 3 | 8 | 2 | src/backend/position-reconciliation-import/anomaly-report.js(4), src/main-process/position-reconciliation/excel-io.js(2), src/main-process/position-reconciliation/filtered-source-report.js(2) |
| `updateDateRange` | 3 | 8 | 1 | src/backend/position-reconciliation-import/preflight.js(4), src/backend/position-reconciliation-import/bank-writer.js(2), src/backend/position-reconciliation-import/source-writer.js(2) |
| `validateConsumedAttributeCase` | 3 | 8 | 3 | src/backend/toolbox-format/style-registry.js(3), src/backend/toolbox-format/xlsx-pass.js(3), src/backend/toolbox-format/xlsx-sheet-scanner.js(2) |
| `validateSourceRow` | 3 | 8 | 1 | src/main-process/position-reconciliation/readers.js(4), src/backend/position-reconciliation-import/account-writer.js(2), src/backend/position-reconciliation-import/contracts.js(2) |
| `assertMutationGuardPostwrite` | 3 | 7 | 1 | src/backend/vcc-financial-op/result-write.js(3), src/backend/vcc-financial-op/destructive-write.js(2), src/backend/vcc-financial-op/mutation-guard.js(2) |
| `assertMutationRuntimeAvailable` | 3 | 7 | 1 | src/backend/vcc-financial-op/result-write.js(3), src/backend/vcc-financial-op/destructive-write.js(2), src/backend/vcc-financial-op/mutation-guard.js(2) |
| `assertNoUnacknowledgedArchiveRunByDateBu` | 3 | 7 | 1 | src/backend/biz-op-recon-db/run-repository.js(4), src/main-process/biz-op-recon-session.js(2), src/main-process/biz-op-recon-run-data.js(1) |
| `assertVccMutationSchema` | 3 | 7 | 1 | src/backend/vcc-financial-op/result-write.js(3), src/backend/vcc-financial-op/destructive-write.js(2), src/backend/vcc-financial-op/mutation-guard.js(2) |
| `backfillBocReconLinkIds` | 3 | 7 | 1 | src/main-process/linked-derive-rebuild.js(4), src/main-process/boc-fx-link-builder.js(2), src/main.js(1) |
| `bankAmountWithExtraFee` | 3 | 7 | 2 | src/main-process/scenario-engines/r5-fund-transfer-backfill.js(3), src/main-process/scenario-engines/many-to-many-detector.js(2), src/main-process/scenario-engines/r5-fund-transfer-recon-backfill.js(2) |
| `beginMutationGuard` | 3 | 7 | 1 | src/backend/vcc-financial-op/result-write.js(3), src/backend/vcc-financial-op/destructive-write.js(2), src/backend/vcc-financial-op/mutation-guard.js(2) |
| `buildBocBankRows` | 3 | 7 | 1 | src/main-process/linked-derive-rebuild.js(4), src/main-process/boc-fx-link-builder.js(2), src/main.js(1) |
| `buildInsertSql` | 3 | 7 | 3 | src/backend/bank-bu-recon-db/month-repository.js(3), src/backend/biz-op-recon-db/flow-imports-repository.js(2), src/backend/biz-op-recon-db/imports-repository.js(2) |
| `classifyArchiveContract` | 3 | 7 | 1 | src/backend/vcc-financial-op/read-snapshot.js(3), src/backend/vcc-financial-op/archive-contract.js(2), src/backend/vcc-financial-op/destructive-write.js(2) |
| `createScenario` | 3 | 7 | 1 | src/main-process/scenarios-bundle-import.js(3), src/backend/database.js(2), src/backend/database/scenarios-repository.js(2) |
| `createToolboxOutputWriter` | 3 | 7 | 3 | src/main-process/toolbox-output-writer.js(3), src/main-process/toolbox-format-operations.js(2), src/main-process/toolbox-merge-io.js(2) |
| `decodeExcelStXstring` | 3 | 7 | 1 | src/backend/toolbox-format/xlsx-sheet-scanner.js(3), src/backend/toolbox-format/excel-text.js(2), src/backend/toolbox-format/xlsx-pass.js(2) |
| `DUPLICATE_GATEWAY_HEADERS` | 3 | 7 | 1 | src/main-process/pre-fund-reconciliation/excel-writer.js(3), src/main-process/pre-fund-reconciliation/output-mapper.js(2), src/main-process/recon-id-fix-io.js(2) |
| `ensureSupportedFile` | 3 | 7 | 2 | src/backend/file-service/readers.js(3), src/backend/file-service.js(2), src/main-process/toolbox-input-kind.js(2) |
| `executeRegisteredMutationSteps` | 3 | 7 | 1 | src/backend/vcc-financial-op/result-write.js(3), src/backend/vcc-financial-op/destructive-write.js(2), src/backend/vcc-financial-op/mutation-guard.js(2) |
| `expectedLedgerFile` | 3 | 7 | 1 | src/backend/position-reconciliation-import/source-writer.js(3), src/backend/position-reconciliation-import/account-writer.js(2), src/backend/position-reconciliation-import/bank-writer.js(2) |
| `fingerprintQuery` | 3 | 7 | 1 | src/backend/vcc-financial-op/dataset-deletion.js(3), src/backend/vcc-financial-op/operation-state.js(2), src/backend/vcc-financial-op/preserved-state.js(2) |
| `listAllRuns` | 3 | 7 | 1 | src/backend/pending-db/diff-repository.js(3), src/renderer-pending.js(3), src/preload.js(1) |
| `mapDetailRow` | 3 | 7 | 1 | src/main-process/vcc-financial-op-dataset-writer.js(3), src/backend/vcc-financial-op/detail-importer.js(2), src/backend/vcc-financial-op/row-mapper.js(2) |
| `MODULE_PRE_FUND_RECONCILIATION_RESULTS` | 3 | 7 | 1 | src/backend/run-data-store.js(5), src/backend/pre-fund-reconciliation-run-store.js(1), src/main-process/pre-fund-reconciliation/service.js(1) |
| `normalizeInputFilePaths` | 3 | 7 | 1 | src/main-process/statement-generation.js(4), src/main-process/statement-session.js(2), src/main.js(1) |
| `normalizePositionImportEngine` | 3 | 7 | 1 | src/backend/position-reconciliation-import/constants.js(3), src/main-process/position-reconciliation/import-dispatch.js(2), src/main-process/position-reconciliation/service.js(2) |
| `normalizeWorksheetTarget` | 3 | 7 | 3 | src/backend/biz-op-recon-import/reader-streamed.js(3), src/backend/big-table-import/zip-reader.js(2), src/backend/vcc-financial-op/system-op-importer.js(2) |
| `openDb` | 3 | 7 | 2 | src/backend/duplicate-inbound-match-store.js(3), src/backend/biz-op-recon-import/import-worker.js(2), src/backend/vcc-financial-op/worker-entry.js(2) |
| `parseMptFile` | 3 | 7 | 3 | src/main-process/pre-fund-reconciliation/mpt-error-report-writer.js(3), src/backend/pre-fund-reconciliation-store.js(2), src/main-process/pre-fund-reconciliation/mpt-parser.js(2) |
| `parseMptFileName` | 3 | 7 | 1 | src/backend/pre-fund-reconciliation-store.js(3), src/main-process/pre-fund-reconciliation/mpt-parser.js(2), src/main-process/pre-fund-reconciliation/mpt-schema.js(2) |
| `parsePaymentBigAccounts` | 3 | 7 | 1 | src/renderer-dialogs.js(3), src/main-process/scenario-engines/r5-payment-offline-allocation-backfill.js(2), src/shared/payment-big-accounts.js(2) |
| `parseWorkbookRelationships` | 3 | 7 | 1 | src/backend/toolbox-format/xlsx-pass.js(3), src/backend/position-reconciliation-import/xlsx-reader.js(2), src/main-process/toolbox-large-split-router.js(2) |
| `pendingCanonicalValues` | 3 | 7 | 1 | src/backend/vcc-financial-op/row-mapper.js(3), src/backend/vcc-financial-op/detail-importer.js(2), src/main-process/vcc-financial-op-dataset-writer.js(2) |
| `readFirstMonthFacts` | 3 | 7 | 1 | src/backend/vcc-financial-op-db/migrations.js(3), src/backend/vcc-financial-op-db/repository.js(2), src/backend/vcc-financial-op-db/state-model.js(2) |
| `readLinkedTableRows` | 3 | 7 | 1 | src/main-process/linked-derive-rebuild.js(3), src/backend/database.js(2), src/backend/database/linked-table-repository.js(2) |
| `readSheetAsRows` | 3 | 7 | 3 | src/backend/pending-import/removed-reader.js(3), src/backend/bank-bu-recon-import/reader.js(2), src/backend/biz-op-recon-import/reader.js(2) |
| `resolveFromRel` | 3 | 7 | 1 | src/main-process/biz-op-recon-run-data.js(4), src/backend/run-data-store.js(2), src/main-process/pre-fund-reconciliation/service.js(1) |
| `saxAttributeIdentity` | 3 | 7 | 1 | src/backend/toolbox-format/xlsx-pass.js(3), src/backend/toolbox-format/ooxml-namespaces.js(2), src/backend/toolbox-format/style-registry.js(2) |
| `sourceRecords` | 3 | 7 | 1 | src/main-process/position-reconciliation/store.js(4), src/main-process/position-reconciliation/matching-engine.js(2), src/main-process/position-reconciliation/service.js(1) |
| `SourceStyleRegistry` | 3 | 7 | 3 | src/backend/toolbox-format/style-registry.js(3), src/backend/toolbox-format/biff8-pass.js(2), src/backend/toolbox-format/csv-pass.js(2) |
| `targetSnapshot` | 3 | 7 | 1 | src/main-process/archive-center/file-plan.js(4), src/backend/database/archive-repository.js(2), src/main-process/archive-center/task-lifecycle.js(1) |
| `validateContract` | 3 | 7 | 3 | src/backend/big-table-import/engine.js(3), src/backend/big-table-import/contract.js(2), src/backend/big-table-import/import-worker.js(2) |
| `WORKER_SCRIPT_PATH` | 3 | 7 | 3 | src/backend/big-table-import/pipeline.js(3), src/main-process/run-check-multiworker.js(2), src/main-process/run-check-worker-pool.js(2) |
| `writeBizOpErrorReportXlsx` | 3 | 7 | 1 | src/main-process/biz-op-recon-session.js(4), src/main-process/biz-op-recon-writer.js(2), src/main.js(1) |
| `writeFlowErrorReportXlsx` | 3 | 7 | 1 | src/main-process/biz-op-recon-session.js(4), src/main-process/biz-op-recon-writer.js(2), src/main.js(1) |
| `xmlUnescape` | 3 | 7 | 3 | src/backend/big-table-import/row-scanner.js(5), src/backend/acquiring-bill-currency-import/reader-handrolled.js(1), src/backend/pending-import/streaming-xlsx-reader.js(1) |
| `acknowledgeRunByTaskRun` | 3 | 6 | 1 | src/main-process/biz-op-recon-run-data.js(3), src/main-process/pre-fund-archive-lineage.js(2), src/main-process/pre-fund-reconciliation/service.js(1) |
| `assertExcelStXstringRawLength` | 3 | 6 | 1 | src/backend/toolbox-format/excel-text.js(2), src/backend/toolbox-format/xlsx-pass.js(2), src/backend/toolbox-format/xlsx-sheet-scanner.js(2) |
| `assertExpectedResultRevision` | 3 | 6 | 1 | src/backend/vcc-financial-op/calculator.js(2), src/backend/vcc-financial-op/result-adjustments.js(2), src/backend/vcc-financial-op/result-write.js(2) |
| `assertSourceFileMatchesSync` | 3 | 6 | 1 | src/backend/vcc-financial-op/detail-importer.js(2), src/backend/vcc-financial-op/source-lineage.js(2), src/backend/vcc-financial-op/system-op-importer.js(2) |
| `buildDeleteTargetTokenV2` | 3 | 6 | 1 | src/backend/vcc-financial-op/destructive-write.js(2), src/backend/vcc-financial-op/operation-token-v2.js(2), src/backend/vcc-financial-op/read-snapshot.js(2) |
| `buildOperationTokenV2` | 3 | 6 | 1 | src/backend/vcc-financial-op/destructive-write.js(2), src/backend/vcc-financial-op/operation-token-v2.js(2), src/backend/vcc-financial-op/read-snapshot.js(2) |
| `CHANNEL_VALUE` | 3 | 6 | 2 | src/backend/database/linked-table-repository.js(2), src/constants/adm-bank-deposit-fields.js(2), src/main-process/adm-bank-deposit-builder.js(2) |
| `classifyNumericOutput` | 3 | 6 | 1 | src/backend/toolbox-format/model.js(2), src/backend/toolbox-format/number-date.js(2), src/backend/toolbox-format/xlsx-sheet-scanner.js(2) |
| `clearMonth` | 3 | 6 | 2 | src/main-process/acquiring-bill-currency-session.js(3), src/backend/acquiring-bill-currency-db/import-repository.js(2), src/preload.js(1) |
| `columnLetterToIndex` | 3 | 6 | 2 | src/backend/acquiring-bill-currency-import/reader.js(3), src/backend/big-table-import/row-scanner.js(2), src/backend/acquiring-bill-currency-import/reader-handrolled.js(1) |
| `compareCanonicalDecimals` | 3 | 6 | 1 | src/main-process/financial-decimal.js(2), src/main-process/position-reconciliation/decimal.js(2), src/main-process/scenario-engines/r5-refund-order-backfill.js(2) |
| `compileRegexLiteral` | 3 | 6 | 1 | src/backend/file-service/normalizers.js(3), src/backend/file-service.js(2), src/main.js(1) |
| `computeRowHash` | 3 | 6 | 3 | src/backend/pending-import/contract-pending.js(2), src/backend/pending-import/validator.js(2), src/backend/pending-import/worker.js(2) |
| `configureDatabase` | 3 | 6 | 3 | src/backend/position-reconciliation-import/account-writer.js(2), src/backend/position-reconciliation-import/bank-writer.js(2), src/backend/position-reconciliation-import/maintenance-writer.js(2) |
| `createPreFundReconciliationStore` | 3 | 6 | 1 | src/backend/pre-fund-reconciliation-store.js(2), src/main-process/duplicate-inbound-match/service.js(2), src/main-process/pre-fund-reconciliation/service.js(2) |
| `createRunMirror` | 3 | 6 | 2 | src/backend/database.js(2), src/backend/database/duplicate-inbound-match-run-repository.js(2), src/backend/database/pre-fund-reconciliation-run-repository.js(2) |
| `createSourceStyleRegistryFromOoxml` | 3 | 6 | 1 | src/backend/position-reconciliation-import/xlsx-reader.js(2), src/backend/toolbox-format/style-registry.js(2), src/backend/toolbox-format/xlsx-pass.js(2) |
| `createStorageMaterializer` | 3 | 6 | 1 | src/main-process/archive-center/archive-service.js(2), src/main-process/archive-center/storage-materializer.js(2), src/main-process/archive-center/storage-root-manager.js(2) |
| `createTaskPolicyRegistry` | 3 | 6 | 2 | src/main-process/archive-center/operation-tracker.js(2), src/main-process/archive-center/task-policy-registry.js(2), src/main.js(2) |
| `DATE_MISMATCH_WARNING_CODE` | 3 | 6 | 3 | src/main-process/scenario-engines/dbs-charge-fund-check.js(2), src/main-process/scenario-engines/r5-fund-transfer-backfill.js(2), src/main-process/scenario-engines/r5-fund-transfer-recon-backfill.js(2) |
| `deleteMonthSideDb` | 3 | 6 | 3 | src/main-process/acquiring-bill-currency-run-data.js(2), src/main-process/bank-bu-recon-run-data.js(2), src/main-process/biz-op-recon-run-data.js(2) |
| `DIRECTION_MISMATCH_WARNING_CODE` | 3 | 6 | 3 | src/main-process/scenario-engines/dbs-charge-fund-check.js(2), src/main-process/scenario-engines/r5-fund-transfer-backfill.js(2), src/main-process/scenario-engines/r5-fund-transfer-recon-backfill.js(2) |
| `dispatchPositionLargeImportSchemaMigration` | 3 | 6 | 1 | src/main-process/position-reconciliation/service.js(3), src/main-process/position-reconciliation/import-dispatch.js(2), src/main.js(1) |
| `evaluateUnarchiveGate` | 3 | 6 | 2 | src/backend/vcc-financial-op/destructive-write.js(2), src/backend/vcc-financial-op/read-snapshot.js(2), src/backend/vcc-financial-op/unarchive-gate.js(2) |
| `failRunMirror` | 3 | 6 | 2 | src/backend/database.js(2), src/backend/database/duplicate-inbound-match-run-repository.js(2), src/backend/database/pre-fund-reconciliation-run-repository.js(2) |
| `finishRunMirror` | 3 | 6 | 2 | src/backend/database.js(2), src/backend/database/duplicate-inbound-match-run-repository.js(2), src/backend/database/pre-fund-reconciliation-run-repository.js(2) |
| `flowRowToArray` | 3 | 6 | 1 | src/backend/biz-op-recon-db/columns.js(2), src/backend/vcc-op-calc-db/columns.js(2), src/main-process/biz-op-recon-writer.js(2) |
| `freezePendingDatasetSeedV1` | 3 | 6 | 2 | src/backend/pending-db/dataset-identity.js(2), src/backend/pending-import/contract-pending.js(2), src/backend/pending-import/worker.js(2) |
| `FUND_TRANSFER_RECON_UNUSED` | 3 | 6 | 1 | src/constants/fund-transfer-recon-fields.js(2), src/main-process/fund-transfer-recon-builder.js(2), src/main-process/scenario-engines/r5-payment-offline-allocation-backfill.js(2) |
| `FUND_TYPE_PAIRS` | 3 | 6 | 1 | src/main-process/position-reconciliation/constants.js(2), src/main-process/position-reconciliation/contracts.js(2), src/main-process/position-reconciliation/service.js(2) |
| `getAmountSplitRules` | 3 | 6 | 1 | src/backend/database/template-repository.js(3), src/backend/database.js(2), src/preload.js(1) |
| `groupBigAccountRows` | 3 | 6 | 2 | src/backend/database/template-repository.js(3), src/backend/database/utils.js(2), src/main.js(1) |
| `hslToRgb` | 3 | 6 | 3 | src/backend/toolbox-format/biff8-colors.js(2), src/backend/toolbox-format/style-registry.js(2), src/renderer.js(2) |
| `identityFromPendingDatasetSeed` | 3 | 6 | 2 | src/backend/pending-db/dataset-identity.js(2), src/backend/pending-db/removed-repository.js(2), src/backend/pending-import/worker.js(2) |
| `inspectSourceFiles` | 3 | 6 | 3 | src/backend/vcc-financial-op/detail-importer.js(2), src/backend/vcc-financial-op/import-service.js(2), src/backend/vcc-financial-op/workbook-reader.js(2) |
| `isPositionImportCancellationLocked` | 3 | 6 | 1 | src/backend/position-reconciliation-import/constants.js(2), src/backend/position-reconciliation-import/worker-entry.js(2), src/main-process/position-reconciliation/service.js(2) |
| `isPositionImportMutatingCommand` | 3 | 6 | 1 | src/backend/position-reconciliation-import/constants.js(2), src/backend/position-reconciliation-import/worker-entry.js(2), src/main-process/position-reconciliation/import-dispatch.js(2) |
| `isRegexLiteral` | 3 | 6 | 1 | src/backend/file-service/normalizers.js(3), src/backend/file-service.js(2), src/main.js(1) |
| `JOURNAL_INDEX_NAME` | 3 | 6 | 2 | src/main-process/toolbox-output-publication.js(3), src/main-process/toolbox-output-publication-dispatch.js(2), src/main.js(1) |
| `listAdjustmentOptions` | 3 | 6 | 1 | src/main-process/vcc-financial-op-service.js(3), src/backend/vcc-financial-op/result-adjustments.js(2), src/preload.js(1) |
| `listArchivedResultMonths` | 3 | 6 | 1 | src/main-process/vcc-financial-op-service.js(3), src/backend/vcc-financial-op/unarchive.js(2), src/preload.js(1) |
| `listGatewayBillSourceTags` | 3 | 6 | 1 | src/backend/database.js(2), src/backend/database/linked-table-repository.js(2), src/main-process/pre-fund-reconciliation/service.js(2) |
| `listImportRecords` | 3 | 6 | 1 | src/main-process/vcc-financial-op-service.js(3), src/backend/vcc-financial-op-db/repository.js(2), src/preload.js(1) |
| `listRunMirrors` | 3 | 6 | 2 | src/backend/database.js(2), src/backend/database/duplicate-inbound-match-run-repository.js(2), src/backend/database/pre-fund-reconciliation-run-repository.js(2) |
| `loadCurrencyMappings` | 3 | 6 | 2 | src/backend/file-service.js(3), src/backend/file-service/normalizers.js(2), src/main.js(1) |
| `loadSharedStringsProvider` | 3 | 6 | 1 | src/backend/position-reconciliation-import/shared-strings-provider.js(2), src/backend/position-reconciliation-import/xlsx-reader.js(2), src/backend/vcc-financial-op/workbook-reader.js(2) |
| `makeRowInserter` | 3 | 6 | 2 | src/backend/biz-op-recon-db/flow-imports-repository.js(2), src/backend/biz-op-recon-db/imports-repository.js(2), src/backend/biz-op-recon-import/import-worker.js(2) |
| `markRunMirrorUnavailable` | 3 | 6 | 2 | src/backend/database.js(2), src/backend/database/duplicate-inbound-match-run-repository.js(2), src/backend/database/pre-fund-reconciliation-run-repository.js(2) |
| `nextDatasetIdentity` | 3 | 6 | 1 | src/backend/biz-op-recon-db/dataset-head-repository.js(2), src/backend/biz-op-recon-import/import-worker.js(2), src/main-process/biz-op-recon-session.js(2) |
| `normalizeBillDate` | 3 | 6 | 3 | src/backend/acquiring-bill-currency-db/import-repository.js(2), src/backend/acquiring-bill-currency-import/contract-bill.js(2), src/backend/acquiring-bill-currency-import/validator.js(2) |
| `openToolboxXlsxPass` | 3 | 6 | 1 | src/backend/toolbox-format/xlsx-pass.js(2), src/main-process/toolbox-format-io.js(2), src/main-process/toolbox-output-writer.js(2) |
| `ORDER_REPAIR_FIELDS` | 3 | 6 | 2 | src/constants/recon-id-fix-fields.js(2), src/main-process/recon-id-fix-io.js(2), src/main-process/scenario-engines/c4-recon-id-fix.js(2) |
| `PACKAGE_RELATIONSHIP_NAMESPACES` | 3 | 6 | 1 | src/backend/toolbox-format/ooxml-namespaces.js(2), src/backend/toolbox-format/xlsx-pass.js(2), src/main-process/toolbox-output-writer.js(2) |
| `parseFtaDate` | 3 | 6 | 2 | src/main-process/exceljs-writer.js(2), src/main-process/scenario-engines/engine-week-utils.js(2), src/main-process/scenario-engines/r5-payment-offline-allocation-backfill.js(2) |
| `PAYMENT_OFFLINE_FIELD_MAP` | 3 | 6 | 1 | src/constants/payment-offline-allocation-fields.js(4), src/main-process/exceljs-writer.js(1), src/main-process/scenario-engines/r5-payment-offline-allocation-backfill.js(1) |
| `previewUnarchive` | 3 | 6 | 1 | src/backend/vcc-financial-op/unarchive.js(3), src/main-process/vcc-financial-op-service.js(2), src/preload.js(1) |
| `readBankDepositBocCandidates` | 3 | 6 | 1 | src/backend/database.js(2), src/backend/database/linked-table-repository.js(2), src/main-process/linked-derive-rebuild.js(2) |
| `readBocFxLinkRowsWithIds` | 3 | 6 | 1 | src/backend/database.js(2), src/backend/database/linked-table-repository.js(2), src/main-process/linked-derive-rebuild.js(2) |
| `reconcileOrphans` | 3 | 6 | 3 | src/main-process/acquiring-bill-currency-run-data.js(2), src/main-process/bank-bu-recon-run-data.js(2), src/main-process/biz-op-recon-run-data.js(2) |
| `recordExportPath` | 3 | 6 | 2 | src/main-process/bank-bu-recon-run-data.js(2), src/main-process/bank-bu-recon-session.js(2), src/main-process/biz-op-recon-run-data.js(2) |
| `recoverPendingToolboxPublications` | 3 | 6 | 1 | src/main-process/toolbox-archive-recovery.js(2), src/main-process/toolbox-output-publication-worker.js(2), src/main-process/toolbox-output-publication.js(2) |
| `rematchAllBocGroups` | 3 | 6 | 1 | src/main-process/linked-derive-rebuild.js(3), src/main-process/boc-fx-link-builder.js(2), src/main.js(1) |
| `replaceBocBankDeposit` | 3 | 6 | 1 | src/backend/database.js(2), src/backend/database/linked-table-repository.js(2), src/main-process/linked-derive-rebuild.js(2) |
| `resolveArchiveScope` | 3 | 6 | 3 | src/main-process/archive-center/module-scope-registry.js(2), src/main-process/archive-center/operation-tracker.js(2), src/main-process/archive-center/task-policy-registry.js(2) |
| `resolveSinglePreparedFieldValue` | 3 | 6 | 1 | src/main-process/statement-generation.js(3), src/main-process/statement-session.js(2), src/main.js(1) |
| `runMigrations` | 3 | 6 | 3 | src/backend/pending-db.js(2), src/backend/pending-db/migrations.js(2), src/backend/pending-import/worker.js(2) |
| `stableRowGuardHash` | 3 | 6 | 1 | src/backend/position-reconciliation-import/contracts.js(2), src/backend/position-reconciliation-import/preflight.js(2), src/backend/position-reconciliation-import/source-writer.js(2) |
| `streamDetailRows` | 3 | 6 | 3 | src/backend/vcc-financial-op/detail-importer.js(2), src/backend/vcc-financial-op/workbook-reader.js(2), src/main-process/vcc-financial-op-dataset-writer.js(2) |
| `subOneDay` | 3 | 6 | 2 | src/backend/biz-op-recon-db/run-repository.js(3), src/main-process/biz-op-recon-session.js(2), src/main-process/biz-op-recon-run-data.js(1) |
| `SUPPORTED_EXTENSIONS` | 3 | 6 | 1 | src/backend/file-service.js(2), src/backend/file-service/common.js(2), src/backend/file-service/readers.js(2) |
| `Transform` | 3 | 6 | 3 | src/main-process/archive-center/archive-service.js(2), src/main-process/position-reconciliation/input-staging.js(2), src/main-process/pre-fund-reconciliation/mpt-parser.js(2) |
| `validateBizOpHeaders` | 3 | 6 | 1 | src/backend/biz-op-recon-import/reader-streamed.js(2), src/backend/biz-op-recon-import/reader.js(2), src/backend/biz-op-recon-import/validator.js(2) |
| `validateBizOpRow` | 3 | 6 | 2 | src/backend/biz-op-recon-import/import-worker.js(2), src/backend/biz-op-recon-import/validator.js(2), src/main-process/biz-op-recon-session.js(2) |
| `validateFundTransferDirections` | 3 | 6 | 1 | src/main-process/scenario-engines/fund-transfer-engine-policy.js(2), src/main-process/scenario-engines/r5-fund-transfer-backfill.js(2), src/main-process/scenario-engines/r5-fund-transfer-recon-backfill.js(2) |
| `WORKBOOK_RELS_ENTRY_NAME` | 3 | 6 | 1 | src/backend/big-table-import/zip-reader.js(2), src/backend/position-reconciliation-import/xlsx-reader.js(2), src/backend/toolbox-format/xlsx-pass.js(2) |
| `writeBocFxLinkReconIds` | 3 | 6 | 1 | src/backend/database.js(2), src/backend/database/linked-table-repository.js(2), src/main-process/linked-derive-rebuild.js(2) |
| `writeDiffWorkbook` | 3 | 6 | 2 | src/main-process/acquiring-bill-currency-writer.js(3), src/main-process/bank-bu-recon-writer.js(2), src/main.js(1) |
| `yauzl` | 3 | 6 | 3 | src/backend/acquiring-bill-currency-import/reader.js(2), src/backend/big-table-import/zip-reader.js(2), src/backend/pending-import/xlsx-size-preflight.js(2) |
| `__test_only_set_worker_script__` | 3 | 5 | 3 | src/main-process/run-check-worker-pool.js(2), src/main-process/toolbox-large-split-dispatch.js(2), src/main-process/run-check-multiworker.js(1) |
| `addRunAdjustment` | 3 | 5 | 1 | src/backend/vcc-financial-op/result-adjustments.js(2), src/main-process/vcc-financial-op-service.js(2), src/preload.js(1) |
| `ALL_BANKS_TEMPLATE_SCOPE` | 3 | 5 | 2 | src/main-process/monthly-balance.js(3), src/main.js(1), src/renderer.js(1) |
| `ALL_TABLE_SIGNATURES` | 3 | 5 | 2 | src/constants/table-signatures.js(2), src/main-process/table-type-detector.js(2), src/main.js(1) |
| `assertStagedInputUnchanged` | 3 | 5 | 1 | src/main-process/position-reconciliation/input-staging.js(2), src/main-process/position-reconciliation/service.js(2), src/main.js(1) |
| `bankCreditAmount` | 3 | 5 | 1 | src/main-process/scenario-engines/r5-payment-offline-allocation-backfill.js(3), src/constants/boc-fx-link-fields.js(1), src/main-process/boc-fx-link-builder.js(1) |
| `bizOpRunOutputIntent` | 3 | 5 | 1 | src/main-process/biz-op-archive-lineage.js(2), src/main-process/biz-op-recon-run-data.js(2), src/main.js(1) |
| `buildAdmRows` | 3 | 5 | 2 | src/main-process/adm-bank-deposit-builder.js(2), src/main-process/linked-derive-rebuild.js(2), src/main.js(1) |
| `buildFundTransferReconRows` | 3 | 5 | 2 | src/main-process/fund-transfer-recon-builder.js(2), src/main-process/linked-derive-rebuild.js(2), src/main.js(1) |
| `calculateEndingBalanceFromAmounts` | 3 | 5 | 1 | src/backend/file-service.js(2), src/backend/file-service/normalizers.js(2), src/main.js(1) |
| `createArchiveRepository` | 3 | 5 | 1 | src/backend/database/archive-repository.js(2), src/main-process/archive-center/archive-service.js(2), src/main.js(1) |
| `createValuesByFieldAccumulator` | 3 | 5 | 1 | src/main-process/toolbox-format-operations.js(2), src/main-process/toolbox.js(2), src/main-process/toolbox-stream-io.js(1) |
| `deleteDataset` | 3 | 5 | 1 | src/backend/vcc-financial-op/data-target-deletion.js(2), src/backend/vcc-financial-op/dataset-deletion.js(2), src/preload.js(1) |
| `encodeExcelStXstring` | 3 | 5 | 1 | src/backend/toolbox-format/excel-text.js(2), src/main-process/toolbox-output-writer.js(2), src/main-process/vcc-financial-op-writer.js(1) |
| `exportToolboxFilter` | 3 | 5 | 1 | src/backend/toolbox-xlsx-stream/split-export-filter.js(2), src/main-process/toolbox-format-operations.js(2), src/main.js(1) |
| `exportToolboxMultiFilters` | 3 | 5 | 1 | src/backend/toolbox-xlsx-stream/split-export-filter.js(2), src/main-process/toolbox-format-operations.js(2), src/main.js(1) |
| `freezeDatasetSeedV1` | 3 | 5 | 2 | src/backend/biz-op-recon-db/dataset-head-repository.js(2), src/backend/pre-fund-reconciliation-store.js(2), src/backend/biz-op-recon-import/import-worker.js(1) |
| `freezeFlowDatasetSeedV1` | 3 | 5 | 2 | src/backend/biz-op-recon-db/dataset-head-repository.js(2), src/backend/biz-op-recon-import/contract-flow.js(2), src/backend/biz-op-recon-import/import-worker.js(1) |
| `getEnabledModules` | 3 | 5 | 1 | src/backend/database.js(2), src/backend/database/settings-repository.js(2), src/preload.js(1) |
| `getGatewayBillRawJsonById` | 3 | 5 | 1 | src/backend/database.js(2), src/backend/database/linked-table-repository.js(2), src/main-process/pre-fund-reconciliation/service.js(1) |
| `getImportBatch` | 3 | 5 | 1 | src/backend/vcc-financial-op-db/repository.js(2), src/main-process/vcc-financial-op-service.js(2), src/main-process/vcc-financial-op-archive-lineage.js(1) |
| `getRule` | 3 | 5 | 1 | src/backend/pending-db/rule-repository.js(2), src/renderer-pending.js(2), src/preload.js(1) |
| `getStatementSessionEntries` | 3 | 5 | 1 | src/main-process/statement-generation.js(2), src/main-process/statement-session.js(2), src/main.js(1) |
| `getUiStyle` | 3 | 5 | 1 | src/backend/database.js(2), src/backend/database/settings-repository.js(2), src/preload.js(1) |
| `inferEndingBalance` | 3 | 5 | 1 | src/backend/file-service.js(2), src/backend/file-service/normalizers.js(2), src/main.js(1) |
| `iterateGatewayBillRows` | 3 | 5 | 1 | src/backend/database.js(2), src/backend/database/linked-table-repository.js(2), src/main-process/pre-fund-reconciliation/service.js(1) |
| `lettersToIndex` | 3 | 5 | 2 | src/backend/biz-op-recon-import/reader-streamed.js(2), src/backend/vcc-op-calc-import/reader.js(2), src/backend/pending-import/streaming-xlsx-reader.js(1) |
| `listDeleteTargets` | 3 | 5 | 1 | src/backend/vcc-financial-op/data-target-deletion.js(2), src/main-process/vcc-financial-op-service.js(2), src/preload.js(1) |
| `listImportMonths` | 3 | 5 | 1 | src/backend/vcc-financial-op-db/repository.js(2), src/main-process/vcc-financial-op-service.js(2), src/preload.js(1) |
| `listImportSources` | 3 | 5 | 1 | src/backend/vcc-financial-op-db/repository.js(2), src/backend/vcc-financial-op/import-service.js(2), src/backend/vcc-financial-op/detail-importer.js(1) |
| `listReadyDates` | 3 | 5 | 1 | src/backend/biz-op-recon-db/run-repository.js(2), src/main-process/biz-op-recon-run-data.js(2), src/preload.js(1) |
| `listSuccessDatesInRange` | 3 | 5 | 1 | src/backend/biz-op-recon-db/run-repository.js(2), src/main-process/biz-op-recon-run-data.js(2), src/main-process/biz-op-recon-writer.js(1) |
| `mergeMappedDetailRows` | 3 | 5 | 1 | src/main-process/statement-generation.js(2), src/main-process/statement-session.js(2), src/main.js(1) |
| `publishToolboxPublicationAsync` | 3 | 5 | 1 | src/main-process/toolbox-output-publication-dispatch.js(2), src/main-process/vcc-financial-op-output-recovery.js(2), src/main.js(1) |
| `readBalanceSeedRecords` | 3 | 5 | 1 | src/main-process/manual-balance-seed-preflight.js(2), src/main-process/monthly-balance.js(2), src/main.js(1) |
| `readBankDepositAdmCandidates` | 3 | 5 | 1 | src/backend/database.js(2), src/backend/database/linked-table-repository.js(2), src/main-process/linked-derive-rebuild.js(1) |
| `readBizOpFile` | 3 | 5 | 1 | src/backend/biz-op-recon-import/reader.js(2), src/main-process/biz-op-recon-session.js(2), src/main.js(1) |
| `readBocFxLinkRowsForRematch` | 3 | 5 | 1 | src/backend/database.js(2), src/backend/database/linked-table-repository.js(2), src/main-process/linked-derive-rebuild.js(1) |
| `readFlowFile` | 3 | 5 | 1 | src/backend/biz-op-recon-import/reader.js(2), src/main-process/biz-op-recon-session.js(2), src/main.js(1) |
| `recoverToolboxPublicationsAsync` | 3 | 5 | 1 | src/main-process/toolbox-output-publication-dispatch.js(2), src/main-process/vcc-financial-op-output-recovery.js(2), src/main.js(1) |
| `recoverToolboxPublicationsIntoArchive` | 3 | 5 | 1 | src/main-process/toolbox-archive-recovery.js(2), src/main-process/vcc-financial-op-output-recovery.js(2), src/main.js(1) |
| `recoverVccStorageMigration` | 3 | 5 | 1 | src/main-process/vcc-financial-op-storage-migration.js(2), src/main-process/vcc-financial-op-storage-rebuild.js(2), src/main.js(1) |
| `replaceAdmBankDeposit` | 3 | 5 | 1 | src/backend/database.js(2), src/backend/database/linked-table-repository.js(2), src/main-process/linked-derive-rebuild.js(1) |
| `replaceFundTransferReconRows` | 3 | 5 | 1 | src/backend/database.js(2), src/backend/database/linked-table-repository.js(2), src/main-process/linked-derive-rebuild.js(1) |
| `runAllScenarios` | 3 | 5 | 3 | src/main-process/reconciliation-orchestrator.js(2), src/main-process/scenario-dispatcher.js(2), src/main.js(1) |
| `scanToolboxSplitFields` | 3 | 5 | 1 | src/backend/toolbox-xlsx-stream/split-scan-fields.js(2), src/main-process/toolbox-format-operations.js(2), src/main.js(1) |
| `setEnabledModules` | 3 | 5 | 1 | src/backend/database.js(2), src/backend/database/settings-repository.js(2), src/preload.js(1) |
| `setReconIdFixBillCategory` | 3 | 5 | 1 | src/backend/database.js(2), src/backend/database/settings-repository.js(2), src/preload.js(1) |
| `unarchiveMonth` | 3 | 5 | 1 | src/backend/vcc-financial-op/unarchive.js(2), src/main-process/vcc-financial-op-service.js(2), src/preload.js(1) |
| `writeBocFxLinkGroupRematch` | 3 | 5 | 1 | src/backend/database.js(2), src/backend/database/linked-table-repository.js(2), src/main-process/linked-derive-rebuild.js(1) |
| `assertExpectedHead` | 3 | 4 | 1 | src/backend/biz-op-recon-db/dataset-head-repository.js(2), src/backend/biz-op-recon-import/import-worker.js(1), src/main-process/biz-op-recon-session.js(1) |
| `assertNoPending` | 3 | 4 | 1 | src/backend/biz-op-recon-db/month-end-copy-intent-repository.js(2), src/main-process/biz-op-recon-run-data.js(1), src/main-process/biz-op-recon-session.js(1) |
| `BALANCE_SEED_GENERATION_METHODS` | 3 | 4 | 1 | src/main-process/manual-balance-seed-preflight.js(2), src/backend/balance-seed-store.js(1), src/main.js(1) |
| `clearByDate` | 3 | 4 | 1 | src/backend/biz-op-recon-db/flow-imports-repository.js(2), src/backend/biz-op-recon-import/import-worker.js(1), src/main-process/biz-op-recon-session.js(1) |
| `clearRunsAndDiffsByDate` | 3 | 4 | 1 | src/backend/biz-op-recon-db/run-repository.js(2), src/backend/biz-op-recon-import/import-worker.js(1), src/main-process/biz-op-recon-session.js(1) |
| `countExportableImportAnomalies` | 3 | 4 | 1 | src/backend/vcc-financial-op-db/repository.js(2), src/main-process/vcc-financial-op-audit-writer.js(1), src/main-process/vcc-financial-op-service.js(1) |
| `countRowsInMonth` | 3 | 4 | 1 | src/backend/pending-db/month-repository.js(2), src/main-process/pending-import-preflight.js(1), src/main-process/pending-session.js(1) |
| `createImportBatch` | 3 | 4 | 1 | src/backend/vcc-financial-op-db/repository.js(2), src/backend/vcc-financial-op/detail-importer.js(1), src/backend/vcc-financial-op/import-service.js(1) |
| `createLegacyRun` | 3 | 4 | 1 | src/backend/pending-db/diff-repository.js(2), src/backend/pending-reconcile/engine.js(1), src/backend/pre-fund-reconciliation-run-store.js(1) |
| `deleteDataTarget` | 3 | 4 | 1 | src/backend/vcc-financial-op/data-target-deletion.js(2), src/main-process/vcc-financial-op-service.js(1), src/preload.js(1) |
| `findByNameAndLocation` | 3 | 4 | 1 | src/backend/database/channels-repository.js(2), src/backend/database.js(1), src/main-process/scenario-dispatcher.js(1) |
| `finishImportBatch` | 3 | 4 | 1 | src/backend/vcc-financial-op-db/repository.js(2), src/backend/vcc-financial-op/detail-importer.js(1), src/backend/vcc-financial-op/import-service.js(1) |
| `getBuiltinGeneral` | 3 | 4 | 1 | src/backend/database/channels-repository.js(2), src/backend/database.js(1), src/main-process/scenario-dispatcher.js(1) |
| `importMonthAtomic` | 3 | 4 | 1 | src/backend/bank-bu-recon-db/month-repository.js(2), src/main-process/bank-bu-recon-run-data.js(1), src/main-process/bank-bu-recon-session.js(1) |
| `isEmptyValue` | 3 | 4 | 1 | src/main-process/scenario-engines/engine-utils.js(2), src/main-process/scenario-engines/c1-extract-recon-id.js(1), src/main-process/scenario-engines/c3-gateway-recon-join.js(1) |
| `iterateChannelExports` | 3 | 4 | 1 | src/main-process/pre-fund-reconciliation/output-mapper.js(2), src/backend/pre-fund-reconciliation-run-store.js(1), src/main-process/pre-fund-reconciliation/service.js(1) |
| `listByMonth` | 3 | 4 | 1 | src/backend/pending-db/removed-repository.js(2), src/backend/pending-export/writer.js(1), src/backend/pending-reconcile/removal-match.js(1) |
| `listLatestRunsByMonthPair` | 3 | 4 | 1 | src/backend/pending-db/diff-repository.js(2), src/backend/pending-export/writer.js(1), src/main-process/pending-archive-lineage.js(1) |
| `listSuccessDates` | 3 | 4 | 1 | src/backend/biz-op-recon-db/run-repository.js(2), src/main-process/biz-op-recon-run-data.js(1), src/preload.js(1) |
| `openWorkbook` | 3 | 4 | 1 | src/backend/position-reconciliation-import/xls-reader.js(2), src/backend/big-table-import/engine.js(1), src/backend/big-table-import/import-worker.js(1) |
| `readXlsxSheetMetaLite` | 3 | 4 | 2 | src/main-process/toolbox-stream-io.js(2), src/backend/file-service/readers.js(1), src/main-process/table-type-detector.js(1) |
| `runBizOpImportViaWorker` | 3 | 4 | 1 | src/main-process/biz-op-recon-run-data.js(2), src/main-process/biz-op-recon-session.js(1), src/main.js(1) |
| `runFlowImportViaWorker` | 3 | 4 | 1 | src/main-process/biz-op-recon-run-data.js(2), src/main-process/biz-op-recon-session.js(1), src/main.js(1) |
| `sanitizeBankName` | 3 | 4 | 3 | src/backend/database/own-accounts-migration.js(2), src/backend/balance-adjustment-store.js(1), src/backend/own-account-store.js(1) |
| `buildTimestampMinute` | 3 | 3 | 2 | src/main-process/bank-statement-io.js(1), src/main-process/recon-id-fix-io.js(1), src/main.js(1) |
| `VccStorageMigrationError` | 2 | 66 | 1 | src/main-process/vcc-financial-op-storage-rebuild.js(64), src/main-process/vcc-financial-op-storage-migration.js(2) |
| `activeJob` | 2 | 47 | 1 | src/main-process/run-check-worker-pool.js(37), src/main-process/run-check-worker.js(10) |
| `linkedTableRepository` | 2 | 45 | 2 | src/backend/database.js(43), src/main-process/pre-fund-reconciliation/service.js(2) |
| `addReason` | 2 | 42 | 2 | src/backend/vcc-financial-op/archive-contract.js(25), src/main-process/scenario-engines/r4-fund-nature-check.js(17) |
| `normalizeKey` | 2 | 38 | 2 | src/backend/database/linked-table-repository.js(33), src/main-process/bank-bu-recon-session.js(5) |
| `templateRepository` | 2 | 33 | 2 | src/backend/database.js(30), src/backend/database/own-accounts-migration.js(3) |
| `countValue` | 2 | 31 | 1 | src/backend/vcc-financial-op/dataset-deletion.js(27), src/main-process/toolbox-output-writer.js(4) |
| `rowValue` | 2 | 31 | 1 | src/backend/vcc-financial-op/row-mapper.js(27), src/main-process/pre-fund-reconciliation/matching-engine.js(4) |
| `fsyncDirectory` | 2 | 29 | 2 | src/main-process/vcc-financial-op-storage-rebuild.js(16), src/main-process/toolbox-output-publication.js(13) |
| `tablePolicy` | 2 | 29 | 1 | src/backend/vcc-financial-op/mutation-policy.js(24), src/backend/vcc-financial-op/mutation-guard.js(5) |
| `resumeError` | 2 | 27 | 1 | src/main-process/acquiring-bill-currency-run-data.js(25), src/main-process/app-updater.js(2) |
| `ContractValidationError` | 2 | 25 | 2 | src/backend/big-table-import/contract.js(22), src/backend/big-table-import/engine.js(3) |
| `HIT_TYPES` | 2 | 23 | 1 | src/main-process/position-reconciliation/matching-engine.js(21), src/main-process/position-reconciliation/contracts.js(2) |
| `publicArtifact` | 2 | 22 | 1 | src/main-process/archive-center/archive-service.js(20), src/main-process/archive-center/controller.js(2) |
| `isObjectRecord` | 2 | 20 | 2 | src/main-process/duplicate-inbound-match/matching-engine.js(16), src/main-process/fund-transfer-date-policy.js(4) |
| `refreshBankStatementStatus` | 2 | 20 | 1 | src/renderer.js(11), src/renderer-dialogs.js(9) |
| `safeName` | 2 | 20 | 1 | src/main-process/archive-center/archive-service.js(14), src/backend/database/channels-repository.js(6) |
| `bankRowKey` | 2 | 19 | 1 | src/main-process/duplicate-inbound-match/matching-engine.js(18), src/main-process/duplicate-inbound-match/service.js(1) |
| `TEMPLATE_LABEL` | 2 | 19 | 2 | src/backend/vcc-op-calc-import/reader.js(11), src/backend/pending-import/removed-reader.js(8) |
| `VCC_STORAGE_CONTRACT_VERSION` | 2 | 19 | 1 | src/backend/vcc-financial-op-db/storage-contract.js(10), src/main-process/vcc-financial-op-storage-rebuild.js(9) |
| `BANK_FUND_TYPE_FIELD` | 2 | 18 | 2 | src/main-process/scenario-engines/dbs-charge-fund-check.js(13), src/main-process/scenario-engines/r4-fund-nature-check.js(5) |
| `DIFF_TABLE` | 2 | 17 | 2 | src/backend/acquiring-bill-currency-db/run-repository.js(11), src/backend/biz-op-recon-db/run-repository.js(6) |
| `directoryPathAliasKey` | 2 | 17 | 1 | src/main-process/toolbox-output-publication.js(15), src/main-process/toolbox-target-identity.js(2) |
| `isPlainObject` | 2 | 17 | 2 | src/main-process/pre-fund-reconciliation/matching-engine.js(10), src/main-process/position-reconciliation/store.js(7) |
| `PipelineError` | 2 | 17 | 2 | src/backend/big-table-import/pipeline.js(9), src/backend/big-table-import/engine.js(8) |
| `selectedValues` | 2 | 17 | 1 | src/renderer-dialogs.js(15), src/main-process/vcc-financial-op-dataset-writer.js(2) |
| `TOOLBOX_PROJECTION_PROFILES` | 2 | 17 | 1 | src/main-process/toolbox-format-io.js(10), src/backend/toolbox-format/model.js(7) |
| `updateJournal` | 2 | 17 | 1 | src/main-process/vcc-financial-op-storage-rebuild.js(12), src/main-process/vcc-financial-op-storage-migration.js(5) |
| `canonicalStoredAmount` | 2 | 16 | 2 | src/backend/vcc-financial-op/result-adjustments.js(8), src/backend/vcc-financial-op/result-evidence.js(8) |
| `ImportValidationError` | 2 | 16 | 1 | src/backend/acquiring-bill-currency-import/reader.js(15), src/backend/acquiring-bill-currency-import/reader-handrolled.js(1) |
| `REMOVED_PENDING_COLUMNS` | 2 | 16 | 2 | src/backend/pending-import/removed-reader.js(13), src/backend/pending-export/writer.js(3) |
| `storageContractVersion` | 2 | 16 | 1 | src/main-process/vcc-financial-op-storage-rebuild.js(10), src/backend/vcc-financial-op-db/migrations.js(6) |
| `reloadReconIdFixScenarios` | 2 | 15 | 1 | src/renderer-dialogs.js(11), src/renderer.js(4) |
| `coordinateKey` | 2 | 14 | 2 | src/backend/vcc-financial-op/result-adjustments.js(8), src/backend/vcc-financial-op/result-evidence.js(6) |
| `parsedJson` | 2 | 14 | 1 | src/backend/position-reconciliation-import/ledger.js(8), src/backend/scenarios-bundle-io.js(6) |
| `requirePositionPendingArchiveFiles` | 2 | 14 | 1 | src/main-process/position-reconciliation/operation-lifecycle.js(13), src/main.js(1) |
| `sanitizeAmountValue` | 2 | 14 | 1 | src/backend/file-service.js(11), src/backend/file-service/normalizers.js(3) |
| `toCents` | 2 | 14 | 2 | src/main-process/scenario-engines/c4-recon-id-fix.js(8), src/main-process/boc-fx-link-builder.js(6) |
| `AUDIT_FIELDS` | 2 | 13 | 1 | src/main-process/position-reconciliation/matching-engine.js(11), src/main-process/position-reconciliation/contracts.js(2) |
| `cellText` | 2 | 13 | 1 | src/backend/vcc-financial-op/result-template-contract.js(12), src/backend/toolbox-format/biff8-pass.js(1) |
| `dateIso` | 2 | 13 | 1 | src/backend/database/linked-table-repository.js(9), src/main-process/toolbox-output-publication.js(4) |
| `ERROR_CODE` | 2 | 13 | 2 | src/backend/vcc-op-calc-import/reader.js(7), src/backend/pending-import/removed-reader.js(6) |
| `normalizeAccountKey` | 2 | 13 | 2 | src/main-process/biz-op-recon-session.js(10), src/main-process/biz-op-recon-writer.js(3) |
| `normalizeLocalDate` | 2 | 13 | 1 | src/backend/database/archive-repository.js(11), src/main-process/archive-center/archive-service.js(2) |
| `refreshTemplates` | 2 | 13 | 1 | src/renderer.js(7), src/renderer-dialogs.js(6) |
| `REQUIRED_DATASET_TYPES` | 2 | 13 | 2 | src/backend/vcc-financial-op/calculator.js(7), src/backend/vcc-financial-op/unarchive.js(6) |
| `usesModernSourceIdentity` | 2 | 13 | 1 | src/main-process/position-reconciliation/store.js(12), src/main-process/position-reconciliation/service.js(1) |
| `zipReader` | 2 | 13 | 2 | src/backend/big-table-import/engine.js(10), src/backend/big-table-import/import-worker.js(3) |
| `assertDatabase` | 2 | 12 | 2 | src/backend/vcc-financial-op-db/storage-contract.js(9), src/backend/database/archive-repository.js(3) |
| `cleanupStagingPaths` | 2 | 12 | 1 | src/main-process/position-reconciliation/service.js(10), src/main-process/position-reconciliation/input-staging.js(2) |
| `GATEWAY_SOURCE` | 2 | 12 | 1 | src/main-process/pre-fund-reconciliation/matching-engine.js(7), src/main-process/pre-fund-reconciliation/service.js(5) |
| `getCurrencyOptionEntries` | 2 | 12 | 1 | src/renderer.js(7), src/renderer-dialogs.js(5) |
| `OPERATION_TOKEN_VERSION` | 2 | 12 | 2 | src/backend/vcc-financial-op/operation-token-v2.js(8), src/backend/vcc-financial-op/operation-state.js(4) |
| `removalMatch` | 2 | 12 | 1 | src/renderer-pending.js(8), src/backend/pending-export/writer.js(4) |
| `sheetToObjects` | 2 | 12 | 2 | src/main-process/recon-id-fix-io.js(9), src/main-process/bank-statement-io.js(3) |
| `BANK_EXTRA_FEE_FIELD` | 2 | 11 | 2 | src/main-process/scenario-engines/r5-fund-transfer-backfill.js(6), src/main-process/scenario-engines/r4-fund-nature-check.js(5) |
| `BIZ_OP_ACCOUNT_KEY_DB_COLUMN` | 2 | 11 | 1 | src/main-process/biz-op-recon-session.js(9), src/backend/biz-op-recon-db/columns.js(2) |
| `deepFreeze` | 2 | 11 | 2 | src/backend/toolbox-format/style-registry.js(8), src/main-process/fund-transfer-date-policy.js(3) |
| `GatewayRowValidationError` | 2 | 11 | 1 | src/main-process/pre-fund-reconciliation/matching-engine.js(9), src/main-process/pre-fund-reconciliation/service.js(2) |
| `normalizeBorderSide` | 2 | 11 | 2 | src/backend/toolbox-format/biff8-overlay.js(6), src/backend/toolbox-format/style-registry.js(5) |
| `parseObjectJson` | 2 | 11 | 2 | src/backend/duplicate-inbound-match-store.js(6), src/backend/database/archive-repository.js(5) |
| `publicBatch` | 2 | 11 | 1 | src/main-process/archive-center/archive-service.js(9), src/main-process/archive-center/controller.js(2) |
| `rendererPending` | 2 | 11 | 1 | src/renderer-previews.js(9), src/renderer.js(2) |
| `TOOLBOX_XLSX_METADATA_LIMITS` | 2 | 11 | 1 | src/backend/toolbox-format/xlsx-pass.js(6), src/backend/position-reconciliation-import/xlsx-reader.js(5) |
| `datasetLineageIntent` | 2 | 10 | 2 | src/main-process/biz-op-archive-lineage.js(5), src/main-process/pending-archive-lineage.js(5) |
| `DIFFERENCE_STATUSES` | 2 | 10 | 1 | src/main-process/position-reconciliation/store.js(8), src/main-process/position-reconciliation/constants.js(2) |
| `electronUtilityProcess` | 2 | 10 | 2 | src/main-process/pending-session.js(6), src/main-process/biz-op-recon-session.js(4) |
| `FUND_TYPES` | 2 | 10 | 1 | src/main-process/duplicate-inbound-match/matching-engine.js(6), src/main-process/duplicate-inbound-match/service.js(4) |
| `getScenario` | 2 | 10 | 1 | src/backend/database/scenarios-repository.js(8), src/backend/database.js(2) |
| `getTemplate` | 2 | 10 | 1 | src/backend/database/template-repository.js(8), src/backend/database.js(2) |
| `NODE_MAX_OLD_SPACE_MB` | 2 | 10 | 2 | src/main-process/pending-session.js(6), src/main-process/biz-op-recon-session.js(4) |
| `normalizeRgb` | 2 | 10 | 1 | src/backend/toolbox-format/biff8-colors.js(8), src/backend/toolbox-format/biff8-overlay.js(2) |
| `runArchiveRootOperation` | 2 | 10 | 1 | src/main-process/archive-center/archive-service.js(6), src/main-process/archive-center/storage-root-manager.js(4) |
| `SOURCE_TARGET_TYPES` | 2 | 10 | 1 | src/backend/vcc-financial-op/destructive-write.js(5), src/backend/vcc-financial-op/read-snapshot.js(5) |
| `workerDbPath` | 2 | 10 | 1 | src/main-process/run-check-worker-pool.js(7), src/main-process/run-check-worker.js(3) |
| `ARCHIVE_STORAGE_ROOT_SETTING_KEY` | 2 | 9 | 1 | src/main-process/archive-center/storage-root-manager.js(5), src/backend/database/archive-repository.js(4) |
| `canonicalJsonValue` | 2 | 9 | 2 | src/backend/vcc-financial-op/operation-token-v2.js(5), src/backend/vcc-financial-op/operation-state.js(4) |
| `channelsRepository` | 2 | 9 | 2 | src/backend/database.js(8), src/main.js(1) |
| `cloneStyle` | 2 | 9 | 2 | src/main-process/duplicate-inbound-match/excel-writer.js(7), src/main-process/vcc-financial-op-writer.js(2) |
| `hasEffectiveAmount` | 2 | 9 | 1 | src/backend/file-service.js(7), src/backend/file-service/normalizers.js(2) |
| `monthEndCopyIntents` | 2 | 9 | 2 | src/main-process/biz-op-recon-run-data.js(6), src/main-process/biz-op-recon-session.js(3) |
| `monthRepo` | 2 | 9 | 2 | src/backend/pending-import/worker.js(5), src/main-process/pending-session.js(4) |
| `pkg` | 2 | 9 | 2 | src/main-process/acquiring-bill-currency-writer.js(7), src/main.js(2) |
| `readJournal` | 2 | 9 | 2 | src/main-process/toolbox-output-publication.js(6), src/main-process/vcc-financial-op-storage-rebuild.js(3) |
| `readRunProgressBatchContext` | 2 | 9 | 1 | src/main-process/acquiring-bill-currency-run-data.js(6), src/backend/acquiring-bill-currency-db/run-repository.js(3) |
| `resolveIndexedColor` | 2 | 9 | 1 | src/backend/toolbox-format/biff8-overlay.js(5), src/backend/toolbox-format/biff8-colors.js(4) |
| `RESULT_TEMPLATE_HEADERS` | 2 | 9 | 1 | src/backend/vcc-financial-op/result-template-contract.js(8), src/main-process/vcc-financial-op-writer.js(1) |
| `SHEET_ENTRY_NAME` | 2 | 9 | 1 | src/backend/acquiring-bill-currency-import/reader.js(6), src/backend/acquiring-bill-currency-import/reader-handrolled.js(3) |
| `SUPPORTED_CURRENCY_SET` | 2 | 9 | 2 | src/backend/vcc-financial-op/result-adjustments.js(5), src/backend/vcc-financial-op/result-evidence.js(4) |
| `ToolboxExcelTextError` | 2 | 9 | 1 | src/backend/toolbox-format/excel-text.js(7), src/main-process/toolbox-output-writer.js(2) |
| `ToolboxStreamEmptyError` | 2 | 9 | 2 | src/main-process/toolbox-format-operations.js(6), src/main-process/toolbox-stream-io.js(3) |
| `ToolboxXlsxCancelledError` | 2 | 9 | 1 | src/backend/toolbox-format/xlsx-sheet-scanner.js(6), src/backend/toolbox-format/xlsx-pass.js(3) |
| `toText` | 2 | 9 | 2 | src/main-process/duplicate-inbound-match/document-statement-reader.js(7), src/main-process/duplicate-inbound-match/service.js(2) |
| `uniqueSorted` | 2 | 9 | 2 | src/backend/vcc-financial-op/archive-contract.js(6), src/backend/vcc-financial-op/unarchive.js(3) |
| `workerScriptPath` | 2 | 9 | 1 | src/main-process/toolbox-output-publication-dispatch.js(6), src/main-process/toolbox-large-split-dispatch.js(3) |
| `ACQUIRING_BILL_CHUNK_SIZE_DEFAULT` | 2 | 8 | 2 | src/backend/database/settings-repository.js(5), src/backend/database/migrations.js(3) |
| `ACQUIRING_BILL_CHUNK_SIZE_KEY` | 2 | 8 | 2 | src/backend/database/migrations.js(4), src/backend/database/settings-repository.js(4) |
| `ACQUIRING_BILL_IDLE_CLEANUP_MINUTES_DEFAULT` | 2 | 8 | 2 | src/backend/database/settings-repository.js(5), src/backend/database/migrations.js(3) |
| `ACQUIRING_BILL_IDLE_CLEANUP_MINUTES_KEY` | 2 | 8 | 2 | src/backend/database/migrations.js(4), src/backend/database/settings-repository.js(4) |
| `ACQUIRING_BILL_RAW_JSON_RETENTION_DAYS_DEFAULT` | 2 | 8 | 2 | src/backend/database/settings-repository.js(5), src/backend/database/migrations.js(3) |
| `ACQUIRING_BILL_RAW_JSON_RETENTION_DAYS_KEY` | 2 | 8 | 2 | src/backend/database/migrations.js(4), src/backend/database/settings-repository.js(4) |
| `atomicWriteJson` | 2 | 8 | 2 | src/main-process/archive-center/storage-root-manager.js(5), src/main-process/toolbox-output-publication.js(3) |
| `BankRowValidationError` | 2 | 8 | 1 | src/main-process/pre-fund-reconciliation/bank-row.js(5), src/main-process/pre-fund-reconciliation/matching-engine.js(3) |
| `canonicalAmount` | 2 | 8 | 2 | src/main-process/position-reconciliation/decimal.js(5), src/main-process/scenario-engines/r4-fund-nature-check.js(3) |
| `currencyMatches` | 2 | 8 | 1 | src/main-process/scenario-engines/c4-recon-id-fix.js(5), src/main-process/big-account-recognition.js(3) |
| `DETAIL_META_HEADERS` | 2 | 8 | 1 | src/backend/position-reconciliation-import/anomaly-report.js(4), src/main-process/position-reconciliation/filtered-source-report.js(4) |
| `DUPLICATE_FOLD_REASON` | 2 | 8 | 2 | src/main-process/pre-fund-reconciliation/output-mapper.js(5), src/backend/pre-fund-reconciliation-run-store.js(3) |
| `freezePlan` | 2 | 8 | 2 | src/backend/vcc-financial-op/destructive-write.js(4), src/backend/vcc-financial-op/result-write.js(4) |
| `outboxBatchId` | 2 | 8 | 1 | src/main-process/archive-center/controller.js(6), src/main-process/archive-center/outbox-store.js(2) |
| `PENDING_HASH_VERSION` | 2 | 8 | 1 | src/backend/vcc-financial-op-db/migrations.js(5), src/backend/vcc-financial-op/row-mapper.js(3) |
| `pendingImportError` | 2 | 8 | 1 | src/main-process/pending-import-preflight.js(7), src/main.js(1) |
| `readPositionSourceSummary` | 2 | 8 | 1 | src/main-process/position-reconciliation/source-summary-cache.js(4), src/main-process/position-reconciliation/store.js(4) |
| `recordRowError` | 2 | 8 | 1 | src/backend/big-table-import/engine.js(4), src/backend/biz-op-recon-import/import-worker.js(4) |
| `saxAttributeValue` | 2 | 8 | 1 | src/backend/toolbox-format/ooxml-namespaces.js(4), src/main-process/toolbox-output-writer.js(4) |
| `setNewAccountStatus` | 2 | 8 | 1 | src/renderer.js(6), src/renderer-previews.js(2) |
| `SHARED_STRINGS_ENTRY` | 2 | 8 | 2 | src/main-process/toolbox-large-split-router.js(5), src/backend/toolbox-xlsx-stream/large-split-worker.js(3) |
| `SOURCE_TYPE_OUTBOUND` | 2 | 8 | 1 | src/main-process/pre-fund-reconciliation/mpt-schema.js(5), src/main-process/pre-fund-reconciliation/mpt-error-report-writer.js(3) |
| `THEME_COLOR_NAMES` | 2 | 8 | 1 | src/backend/toolbox-format/biff8-colors.js(4), src/backend/toolbox-format/biff8-overlay.js(4) |
| `toIsoDate` | 2 | 8 | 2 | src/main-process/boc-fx-link-builder.js(4), src/main-process/scenario-engines/jpm-dispatch-order-fix.js(4) |
| `TOOLBOX_MAX_COL_COUNT` | 2 | 8 | 2 | src/backend/toolbox-xlsx-stream/multi-sheet-reader.js(4), src/main-process/toolbox-stream-io.js(4) |
| `VCC_TABLE_POLICY_REGISTRY` | 2 | 8 | 1 | src/backend/vcc-financial-op/mutation-guard.js(6), src/backend/vcc-financial-op/mutation-policy.js(2) |
| `wrapReadError` | 2 | 8 | 2 | src/backend/biz-op-recon-import/reader-streamed.js(4), src/backend/vcc-op-calc-import/reader.js(4) |
| `ACQUIRING_BILL_WORKER_COUNT_DEFAULT` | 2 | 7 | 2 | src/backend/database/settings-repository.js(5), src/backend/database/migrations.js(2) |
| `ACQUIRING_BILL_WORKER_COUNT_KEY` | 2 | 7 | 2 | src/backend/database/settings-repository.js(4), src/backend/database/migrations.js(3) |
| `ALL_MODULE_IDS` | 2 | 7 | 1 | src/backend/database/settings-repository.js(6), src/main-process/import-dialog-state.js(1) |
| `ANOMALY_HEADERS` | 2 | 7 | 2 | src/main-process/bank-bu-recon-writer.js(4), src/main-process/vcc-financial-op-audit-writer.js(3) |
| `applyManualBalancePromptStatus` | 2 | 7 | 1 | src/renderer.js(4), src/renderer-dialogs.js(3) |
| `applyTint` | 2 | 7 | 2 | src/backend/toolbox-format/biff8-colors.js(4), src/backend/toolbox-format/style-registry.js(3) |
| `archiveStorageRootManager` | 2 | 7 | 1 | src/main-process/vcc-financial-op-storage-migration.js(6), src/main.js(1) |
| `bankStatementSession` | 2 | 7 | 1 | src/renderer.js(6), src/main.js(1) |
| `buildChannelFileName` | 2 | 7 | 1 | src/main-process/pre-fund-reconciliation/excel-writer.js(4), src/main-process/pre-fund-reconciliation/service.js(3) |
| `BUILTIN_NUMBER_FORMATS` | 2 | 7 | 2 | src/backend/toolbox-format/number-date.js(5), src/backend/toolbox-format/biff8-records.js(2) |
| `CHECK_EXPORT_DEFINITIONS` | 2 | 7 | 1 | src/main-process/vcc-financial-op-dataset-writer.js(5), src/main-process/vcc-financial-op-service.js(2) |
| `clearImportStagingRows` | 2 | 7 | 1 | src/backend/vcc-financial-op/detail-importer.js(4), src/backend/vcc-financial-op-db/repository.js(3) |
| `createBackup` | 2 | 7 | 1 | src/backend/database.js(6), src/backend/database/backup.js(1) |
| `CURRENT_DATASET_TYPES` | 2 | 7 | 1 | src/backend/vcc-financial-op/result-write.js(4), src/backend/vcc-financial-op/archive-contract.js(3) |
| `decimalComparable` | 2 | 7 | 1 | src/backend/toolbox-format/number-date.js(4), src/backend/toolbox-format/xlsx-sheet-scanner.js(3) |
| `DEFAULT_RETENTION_DAYS` | 2 | 7 | 2 | src/main-process/archive-center/controller.js(4), src/main-process/archive-center/archive-service.js(3) |
| `DEFAULT_WORKER_ENTRY` | 2 | 7 | 2 | src/main-process/toolbox-large-split-dispatch.js(4), src/main-process/toolbox-output-publication-dispatch.js(3) |
| `DELETABLE_IMPORT_STATUSES` | 2 | 7 | 2 | src/backend/vcc-financial-op/dataset-deletion.js(5), src/backend/vcc-financial-op/preserved-state.js(2) |
| `EXCEL_ST_XSTRING_MAX_RAW_UTF16_UNITS` | 2 | 7 | 1 | src/backend/toolbox-format/excel-text.js(4), src/backend/toolbox-format/xlsx-sheet-scanner.js(3) |
| `FLOW_COLUMN_DEFS` | 2 | 7 | 1 | src/backend/biz-op-recon-db/columns.js(5), src/backend/vcc-op-calc-db/columns.js(2) |
| `flowImportsRepository` | 2 | 7 | 2 | src/main-process/biz-op-recon-session.js(4), src/backend/biz-op-recon-import/import-worker.js(3) |
| `getNewAccountStatusTitle` | 2 | 7 | 1 | src/renderer.js(5), src/renderer-previews.js(2) |
| `IMPORT_CANCELLED_CODE` | 2 | 7 | 1 | src/backend/vcc-financial-op/detail-importer.js(4), src/main-process/vcc-financial-op-service.js(3) |
| `loadArchiveEvidenceSet` | 2 | 7 | 1 | src/backend/vcc-financial-op/read-snapshot.js(5), src/backend/vcc-financial-op/destructive-write.js(2) |
| `mapMirror` | 2 | 7 | 2 | src/backend/database/pre-fund-reconciliation-run-repository.js(4), src/backend/database/duplicate-inbound-match-run-repository.js(3) |
| `normalizeBatchSize` | 2 | 7 | 2 | src/backend/position-reconciliation-import/maintenance-writer.js(5), src/main-process/pre-fund-reconciliation/mpt-parser.js(2) |
| `normalizeMonth` | 2 | 7 | 2 | src/backend/vcc-financial-op/read-snapshot.js(5), src/backend/vcc-financial-op/destructive-write.js(2) |
| `OLE_CFB_MAGIC` | 2 | 7 | 2 | src/backend/toolbox-format/biff8-overlay.js(4), src/main-process/toolbox-input-kind.js(3) |
| `PAIR_BY_FUND_TYPE` | 2 | 7 | 1 | src/main-process/position-reconciliation/contracts.js(4), src/main-process/position-reconciliation/matching-engine.js(3) |
| `persistStagingAnomalies` | 2 | 7 | 1 | src/backend/vcc-financial-op-db/repository.js(4), src/backend/vcc-financial-op/detail-importer.js(3) |
| `POSITION_DB_CHECKPOINT_TOKEN_KEY` | 2 | 7 | 1 | src/main-process/position-reconciliation/side-db-mutation.js(5), src/main-process/position-reconciliation/store.js(2) |
| `POSITION_DB_GENERATION_KEY` | 2 | 7 | 1 | src/main-process/position-reconciliation/side-db-mutation.js(5), src/main-process/position-reconciliation/store.js(2) |
| `POSITION_IMPORT_LEDGER_SCHEMA_VERSION` | 2 | 7 | 1 | src/backend/position-reconciliation-import/ledger.js(5), src/backend/position-reconciliation-import/constants.js(2) |
| `POSITION_IMPORT_MAINTENANCE_BATCH_SIZE` | 2 | 7 | 1 | src/backend/position-reconciliation-import/maintenance-writer.js(5), src/backend/position-reconciliation-import/constants.js(2) |
| `preflightCalculation` | 2 | 7 | 1 | src/backend/vcc-financial-op/calculator.js(5), src/main-process/vcc-financial-op-service.js(2) |
| `PREVIEW_MEANINGFUL_ROWS` | 2 | 7 | 1 | src/backend/vcc-financial-op/workbook-reader.js(4), src/backend/vcc-financial-op/system-op-importer.js(3) |
| `RECON_RESULT_FIELDS_GATEWAY` | 2 | 7 | 1 | src/main-process/recon-id-fix-io.js(5), src/constants/gateway-bill-recon-fields.js(2) |
| `recoverInterruptedImports` | 2 | 7 | 1 | src/main-process/vcc-financial-op-service.js(5), src/backend/vcc-financial-op-db/repository.js(2) |
| `resolveManagedRelative` | 2 | 7 | 2 | src/main-process/archive-center/storage-materializer.js(5), src/main-process/vcc-financial-op-storage-rebuild.js(2) |
| `RESULT_TEMPLATE_SHEET_NAME` | 2 | 7 | 1 | src/backend/vcc-financial-op/result-template-contract.js(5), src/main-process/vcc-financial-op-writer.js(2) |
| `roundAmount` | 2 | 7 | 1 | src/backend/file-service/normalizers.js(5), src/backend/file-service.js(2) |
| `runRowIntegrityHash` | 2 | 7 | 1 | src/main-process/position-reconciliation/store.js(5), src/main-process/position-reconciliation/large-import-schema.js(2) |
| `setNewAccountExportAvailability` | 2 | 7 | 1 | src/renderer.js(5), src/renderer-previews.js(2) |
| `STORAGE_LAYOUT_VERSION` | 2 | 7 | 1 | src/main-process/archive-center/archive-service.js(6), src/main-process/archive-center/storage-layout.js(1) |
| `syncNewAccountCurrencyMode` | 2 | 7 | 1 | src/renderer.js(5), src/renderer-previews.js(2) |
| `targetState` | 2 | 7 | 1 | src/backend/database/archive-repository.js(5), src/main-process/toolbox-output-publication.js(2) |
| `VALID_CATEGORIES` | 2 | 7 | 2 | src/backend/database/scenarios-repository.js(4), src/main-process/recon-id-fix-engine.js(3) |
| `validateElementCase` | 2 | 7 | 2 | src/backend/toolbox-format/xlsx-pass.js(4), src/backend/toolbox-format/style-registry.js(3) |
| `WORKSHEET_ENTRY_RE` | 2 | 7 | 2 | src/backend/pending-import/xlsx-size-preflight.js(4), src/main-process/toolbox-large-split-router.js(3) |
| `__missingBankColumns` | 2 | 6 | 2 | src/constants/payment-offline-allocation-fields.js(3), src/constants/refund-backfill-fields.js(3) |
| `absoluteAmount` | 2 | 6 | 1 | src/main-process/position-reconciliation/decimal.js(4), src/main-process/position-reconciliation/matching-engine.js(2) |
| `addCalendarDays` | 2 | 6 | 2 | src/backend/database/archive-repository.js(3), src/main-process/archive-center/archive-service.js(3) |
| `addFileFailureAnomaly` | 2 | 6 | 1 | src/backend/vcc-financial-op-db/repository.js(3), src/backend/vcc-financial-op/detail-importer.js(3) |
| `addImportAnomaly` | 2 | 6 | 1 | src/backend/vcc-financial-op-db/repository.js(3), src/backend/vcc-financial-op/system-op-importer.js(3) |
| `assertEmptyVccStorageForUpgrade` | 2 | 6 | 1 | src/backend/vcc-financial-op-db/storage-contract.js(4), src/backend/vcc-financial-op-db/migrations.js(2) |
| `assertFilePlanFresh` | 2 | 6 | 1 | src/main-process/archive-center/task-lifecycle.js(4), src/main-process/archive-center/file-plan.js(2) |
| `BANK_DEPOSIT_FIELDS` | 2 | 6 | 2 | src/backend/database/linked-table-repository.js(4), src/constants/boc-fx-link-fields.js(2) |
| `BANK_DIFF_FIELD_DB_COLUMN` | 2 | 6 | 1 | src/main-process/bank-bu-recon-session.js(4), src/backend/bank-bu-recon-db/columns.js(2) |
| `BIZ_OP_MODULE_ID` | 2 | 6 | 1 | src/main-process/biz-op-recon-run-data.js(4), src/main-process/biz-op-archive-lineage.js(2) |
| `bizOpRowToArray` | 2 | 6 | 1 | src/main-process/biz-op-recon-writer.js(4), src/backend/biz-op-recon-db/columns.js(2) |
| `BOC_BANK_FILTER` | 2 | 6 | 2 | src/main-process/boc-fx-link-builder.js(4), src/constants/boc-fx-link-fields.js(2) |
| `buildBankMatchCriteria` | 2 | 6 | 1 | src/main-process/pre-fund-reconciliation/matching-engine.js(4), src/main-process/pre-fund-reconciliation/service.js(2) |
| `buildFileReader` | 2 | 6 | 2 | src/backend/bank-bu-recon-import/reader.js(3), src/backend/biz-op-recon-import/reader.js(3) |
| `buildInfo` | 2 | 6 | 2 | src/main-process/acquiring-bill-currency-writer.js(3), src/main.js(3) |
| `buildTemplateSummaryFromRow` | 2 | 6 | 1 | src/backend/database/template-repository.js(4), src/backend/database/utils.js(2) |
| `cellReference` | 2 | 6 | 1 | src/backend/toolbox-format/model.js(3), src/backend/toolbox-format/xlsx-sheet-scanner.js(3) |
| `CLEANUP_TEMPLATE_HEADERS` | 2 | 6 | 2 | src/constants/platform-cleanup-template-fields.js(3), src/main-process/platform-cleanup-writer.js(3) |
| `deletePreviewForTarget` | 2 | 6 | 1 | src/backend/vcc-financial-op/read-snapshot.js(4), src/backend/vcc-financial-op/destructive-write.js(2) |
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
| `ensureC3GwFieldCurrencyCaseRevert` | 2 | 6 | 1 | src/backend/database.js(4), src/backend/database/migrations.js(2) |
| `ensureChannelEnumSupport` | 2 | 6 | 1 | src/backend/database.js(4), src/backend/database/migrations.js(2) |
| `ensureDbsChargeFundCheckScenarioSeed` | 2 | 6 | 1 | src/backend/database.js(4), src/backend/database/migrations.js(2) |
| `ensureDiffRowsCascadeMigration_v2_1_10` | 2 | 6 | 1 | src/backend/database.js(4), src/backend/database/migrations.js(2) |
| `ensureDuplicateInboundMatchRunMetadataSupport` | 2 | 6 | 1 | src/backend/database.js(4), src/backend/database/migrations.js(2) |
| `ensureFundTransferAccountMappingSupport` | 2 | 6 | 1 | src/backend/database.js(4), src/backend/database/migrations.js(2) |
| `ensureFundTransferBackfillCanonicalOwner` | 2 | 6 | 1 | src/backend/database.js(4), src/backend/database/migrations.js(2) |
| `ensureFundTransferReconSupport` | 2 | 6 | 1 | src/backend/database.js(4), src/backend/database/migrations.js(2) |
| `ensureFundTypeAchReturnConfigMigration` | 2 | 6 | 1 | src/backend/database.js(4), src/backend/database/migrations.js(2) |
| `ensureJpmDispatchOrderScenarioSeed` | 2 | 6 | 1 | src/backend/database.js(4), src/backend/database/migrations.js(2) |
| `ensureLinkedTableSupport` | 2 | 6 | 1 | src/backend/database.js(4), src/backend/database/migrations.js(2) |
| `ensureParentTemplateSupport` | 2 | 6 | 1 | src/backend/database.js(4), src/backend/database/migrations.js(2) |
| `ensurePreFundReconciliationRunMetadataSupport` | 2 | 6 | 1 | src/backend/database.js(4), src/backend/database/migrations.js(2) |
| `ensureR4DirectionGuardConfigMigration` | 2 | 6 | 1 | src/backend/database.js(4), src/backend/database/migrations.js(2) |
| `ensureR4StrictDescriptionMigration` | 2 | 6 | 1 | src/backend/database.js(4), src/backend/database/migrations.js(2) |
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
| `excelValueForHeader` | 2 | 6 | 1 | src/backend/position-reconciliation-import/anomaly-report.js(3), src/main-process/position-reconciliation/filtered-source-report.js(3) |
| `FILENAME_MAPPING_TEMPLATE_ID` | 2 | 6 | 2 | src/renderer.js(4), src/main.js(2) |
| `fsyncFile` | 2 | 6 | 2 | src/main-process/vcc-financial-op-storage-rebuild.js(4), src/main-process/toolbox-output-publication.js(2) |
| `FX_DELIVERY_SIGNATURE` | 2 | 6 | 2 | src/constants/boc-fx-link-fields.js(3), src/constants/table-signatures.js(3) |
| `GatewayPoolEmptyError` | 2 | 6 | 1 | src/main-process/pre-fund-reconciliation/matching-engine.js(4), src/main-process/pre-fund-reconciliation/service.js(2) |
| `gatewayTagKey` | 2 | 6 | 1 | src/main-process/pre-fund-archive-lineage.js(4), src/main-process/pre-fund-reconciliation/service.js(2) |
| `getCurrencyOptionLabel` | 2 | 6 | 1 | src/renderer.js(5), src/renderer-dialogs.js(1) |
| `getVccStorageContractVersion` | 2 | 6 | 1 | src/backend/vcc-financial-op-db/storage-contract.js(4), src/backend/vcc-financial-op-db/migrations.js(2) |
| `gwAmountAbs` | 2 | 6 | 2 | src/main-process/scenario-engines/r5-fund-transfer-backfill.js(4), src/main-process/scenario-engines/many-to-many-detector.js(2) |
| `handleControlMessage` | 2 | 6 | 2 | src/backend/vcc-financial-op/worker-entry.js(3), src/main-process/vcc-financial-op-write-worker.js(3) |
| `hashSourceFile` | 2 | 6 | 2 | src/backend/vcc-financial-op/source-lineage.js(3), src/main-process/vcc-financial-op-dataset-writer.js(3) |
| `headerValues` | 2 | 6 | 1 | src/main-process/toolbox-stream-io.js(4), src/main-process/pre-fund-reconciliation/excel-writer.js(2) |
| `initWorkerDb` | 2 | 6 | 2 | src/main-process/run-check-multiworker-worker.js(3), src/main-process/run-check-worker.js(3) |
| `INSERT_SQL` | 2 | 6 | 2 | src/backend/biz-op-recon-db/flow-imports-repository.js(3), src/backend/biz-op-recon-db/imports-repository.js(3) |
| `inspectDatasetDeletion` | 2 | 6 | 1 | src/backend/vcc-financial-op/dataset-deletion.js(4), src/backend/vcc-financial-op/data-target-deletion.js(2) |
| `INSTALL_BUSY_MESSAGE` | 2 | 6 | 1 | src/main-process/business-operation-registry.js(3), src/main.js(3) |
| `installVccStorageWriteGuards` | 2 | 6 | 1 | src/backend/vcc-financial-op-db/storage-contract.js(4), src/backend/vcc-financial-op-db/migrations.js(2) |
| `isLeapYear` | 2 | 6 | 2 | src/backend/toolbox-format/number-date.js(4), src/main-process/pre-fund-reconciliation/mpt-schema.js(2) |
| `isLegacyPendingHeaders` | 2 | 6 | 1 | src/backend/vcc-financial-op/workbook-reader.js(4), src/backend/vcc-financial-op/definitions.js(2) |
| `listImportedDateBuPairs` | 2 | 6 | 1 | src/main-process/biz-op-recon-run-data.js(4), src/backend/biz-op-recon-db/imports-repository.js(2) |
| `listPositionCommittedOperationInputs` | 2 | 6 | 1 | src/main-process/position-reconciliation/side-db-mutation.js(4), src/main-process/position-reconciliation/store.js(2) |
| `loadDeleteEvidenceV2` | 2 | 6 | 1 | src/backend/vcc-financial-op/read-snapshot.js(4), src/backend/vcc-financial-op/destructive-write.js(2) |
| `localDateOf` | 2 | 6 | 2 | src/backend/database/archive-repository.js(3), src/main-process/archive-center/archive-service.js(3) |
| `localMonthKey` | 2 | 6 | 2 | src/main-process/duplicate-inbound-match/service.js(3), src/main-process/pre-fund-reconciliation/service.js(3) |
| `mapBalancedRow` | 2 | 6 | 1 | src/main-process/pre-fund-reconciliation/output-mapper.js(4), src/main-process/pre-fund-reconciliation/service.js(2) |
| `mapChannelBillRow` | 2 | 6 | 1 | src/main-process/pre-fund-reconciliation/output-mapper.js(4), src/main-process/pre-fund-reconciliation/service.js(2) |
| `mapUnbalancedRow` | 2 | 6 | 1 | src/main-process/pre-fund-reconciliation/output-mapper.js(4), src/main-process/pre-fund-reconciliation/service.js(2) |
| `matchAmountSplitConditionValue` | 2 | 6 | 1 | src/backend/file-service.js(4), src/backend/file-service/normalizers.js(2) |
| `migrateC4ReconGroupsAmountLockedFieldPair` | 2 | 6 | 1 | src/backend/database.js(4), src/backend/database/migrations.js(2) |
| `migrateC4ReconGroupsStructure` | 2 | 6 | 1 | src/backend/database.js(4), src/backend/database/migrations.js(2) |
| `migrateGatewayReconIdFixFieldPairs` | 2 | 6 | 1 | src/backend/database.js(4), src/backend/database/migrations.js(2) |
| `MODULE_BIZ_OP` | 2 | 6 | 1 | src/backend/run-data-store.js(5), src/main-process/biz-op-recon-run-data.js(1) |
| `MODULE_PRE_FUND_RECONCILIATION` | 2 | 6 | 1 | src/backend/run-data-store.js(5), src/backend/pre-fund-reconciliation-store.js(1) |
| `monthOfDate` | 2 | 6 | 2 | src/backend/vcc-financial-op/row-mapper.js(3), src/backend/vcc-financial-op/system-op-importer.js(3) |
| `normalizedAttributes` | 2 | 6 | 2 | src/backend/toolbox-format/style-registry.js(4), src/backend/toolbox-format/xlsx-sheet-scanner.js(2) |
| `normalizeFill` | 2 | 6 | 2 | src/backend/toolbox-format/style-registry.js(4), src/backend/toolbox-format/biff8-overlay.js(2) |
| `normalizeFont` | 2 | 6 | 2 | src/backend/toolbox-format/biff8-overlay.js(3), src/backend/toolbox-format/style-registry.js(3) |
| `normalizeGatewayCandidate` | 2 | 6 | 1 | src/main-process/pre-fund-reconciliation/matching-engine.js(4), src/main-process/pre-fund-reconciliation/service.js(2) |
| `normalizeImportBatchId` | 2 | 6 | 1 | src/backend/vcc-financial-op/import-service.js(4), src/main-process/vcc-financial-op-service.js(2) |
| `normalizeStagingBatchId` | 2 | 6 | 1 | src/main-process/position-reconciliation/input-staging.js(4), src/main-process/position-reconciliation/import-dispatch.js(2) |
| `openVccWriteDatabase` | 2 | 6 | 1 | src/backend/vcc-financial-op/result-write.js(4), src/backend/vcc-financial-op/destructive-write.js(2) |
| `parseCellType` | 2 | 6 | 2 | src/backend/big-table-import/row-scanner.js(4), src/backend/toolbox-format/xlsx-sheet-scanner.js(2) |
| `parsePositionPendingArchiveFiles` | 2 | 6 | 1 | src/main-process/position-reconciliation/operation-lifecycle.js(4), src/main-process/position-reconciliation/service.js(2) |
| `parseThemeColors` | 2 | 6 | 2 | src/backend/toolbox-format/biff8-overlay.js(3), src/backend/toolbox-format/style-registry.js(3) |
| `PART_TABLE` | 2 | 6 | 2 | src/main-process/run-check-multiworker-worker.js(4), src/main-process/run-check-multiworker.js(2) |
| `PENDING_DIFF_FIELD_DB_COLUMN` | 2 | 6 | 1 | src/main-process/bank-bu-recon-session.js(4), src/backend/bank-bu-recon-db/columns.js(2) |
| `pendingHeaderMismatchDetails` | 2 | 6 | 1 | src/backend/vcc-financial-op/workbook-reader.js(4), src/backend/vcc-financial-op/pending-template-contract.js(2) |
| `POSITION_DB_IDENTITY_KEY` | 2 | 6 | 1 | src/main-process/position-reconciliation/side-db-mutation.js(4), src/main-process/position-reconciliation/store.js(2) |
| `POSITION_IMPORT_STREAMING_SOURCE_ALLOWLIST` | 2 | 6 | 1 | src/backend/position-reconciliation-import/constants.js(4), src/backend/position-reconciliation-import/source-writer.js(2) |
| `PositionImportLedger` | 2 | 6 | 1 | src/backend/position-reconciliation-import/preflight.js(4), src/backend/position-reconciliation-import/ledger.js(2) |
| `readSystemOpSnapshotCandidates` | 2 | 6 | 1 | src/backend/vcc-financial-op/system-op-importer.js(4), src/main-process/vcc-financial-op-dataset-writer.js(2) |
| `reconAmount` | 2 | 6 | 1 | src/backend/acquiring-bill-currency-db/columns.js(3), src/main-process/scenario-engines/r5-payment-offline-allocation-backfill.js(3) |
| `REFUND_RO_COLUMNS` | 2 | 6 | 1 | src/constants/refund-backfill-fields.js(4), src/main-process/scenario-engines/r5-refund-order-backfill.js(2) |
| `removedRepo` | 2 | 6 | 2 | src/backend/pending-export/writer.js(4), src/backend/pending-reconcile/removal-match.js(2) |
| `RESULT_TEMPLATE_FILE_NAME` | 2 | 6 | 1 | src/backend/vcc-financial-op/result-template-contract.js(5), src/main-process/vcc-financial-op-writer.js(1) |
| `retireChargeOutboundOrphans` | 2 | 6 | 1 | src/backend/database.js(4), src/backend/database/migrations.js(2) |
| `runC1Scenario` | 2 | 6 | 2 | src/main-process/scenario-engines/index.js(4), src/main-process/scenario-engines/c1-extract-recon-id.js(2) |
| `runReconciliationCore` | 2 | 6 | 2 | src/backend/pending-reconcile/engine.js(3), src/main-process/biz-op-recon-session.js(3) |
| `signedDayDiff` | 2 | 6 | 2 | src/main-process/scenario-engines/r5-refund-order-backfill.js(4), src/main-process/scenario-engines/engine-date-utils.js(2) |
| `snapshotsEqual` | 2 | 6 | 2 | src/main-process/position-reconciliation/operation-lifecycle.js(4), src/main-process/position-reconciliation/import-recovery.js(2) |
| `splitSignedAmountValue` | 2 | 6 | 1 | src/backend/file-service.js(4), src/backend/file-service/normalizers.js(2) |
| `stageInputFiles` | 2 | 6 | 1 | src/main-process/position-reconciliation/service.js(4), src/main-process/position-reconciliation/input-staging.js(2) |
| `STRICT_YEAR_MONTH_PATTERN` | 2 | 6 | 1 | src/backend/vcc-financial-op-db/state-model.js(4), src/backend/vcc-financial-op-db/migrations.js(2) |
| `SUPPORTED_SCENARIO_BUNDLE_VERSION` | 2 | 6 | 1 | src/backend/scenarios-bundle-io.js(5), src/main.js(1) |
| `validatedResultDigest` | 2 | 6 | 1 | src/backend/vcc-financial-op/operation-token-v2.js(4), src/backend/vcc-financial-op/result-write.js(2) |
| `validateName` | 2 | 6 | 2 | src/backend/database/channels-repository.js(3), src/backend/database/scenarios-repository.js(3) |
| `VCC_BILL_DATE_DB_COLUMN` | 2 | 6 | 1 | src/main-process/vcc-op-calc-session.js(4), src/backend/vcc-op-calc-db/columns.js(2) |
| `VCC_DIRECTION_DB_COLUMN` | 2 | 6 | 1 | src/main-process/vcc-op-calc-session.js(4), src/backend/vcc-op-calc-db/columns.js(2) |
| `VCC_STORAGE_GUARD_TRIGGER_PREFIX` | 2 | 6 | 1 | src/backend/vcc-financial-op-db/storage-contract.js(4), src/backend/vcc-financial-op/mutation-guard.js(2) |
| `verifyAnomalyReportFile` | 2 | 6 | 1 | src/main-process/position-reconciliation/filtered-source-report.js(4), src/main-process/position-reconciliation/service.js(2) |
| `WORKER_SCRIPT` | 2 | 6 | 2 | src/main-process/biz-op-recon-session.js(3), src/main-process/pending-session.js(3) |
| `workerScriptOverride` | 2 | 6 | 2 | src/main-process/run-check-multiworker.js(3), src/main-process/run-check-worker-pool.js(3) |
| `WRITER_OUTPUT_HEADERS_V2` | 2 | 6 | 1 | src/main-process/acquiring-bill-currency-writer.js(4), src/backend/acquiring-bill-currency-db/columns.js(2) |
| `ZHONGTAI_DISPATCH_ORDER_SIGNATURE` | 2 | 6 | 2 | src/constants/fund-transfer-recon-fields.js(3), src/constants/table-signatures.js(3) |
| `assertSourceStatsMatch` | 2 | 5 | 1 | src/backend/position-reconciliation-import/source-writer.js(3), src/backend/position-reconciliation-import/account-writer.js(2) |
| `AsyncLocalStorage` | 2 | 5 | 2 | src/main.js(3), src/main-process/archive-center/task-lifecycle.js(2) |
| `BALANCED_HEADERS` | 2 | 5 | 1 | src/main-process/pre-fund-reconciliation/excel-writer.js(3), src/main-process/pre-fund-reconciliation/output-mapper.js(2) |
| `BANK_CURRENCY_FIELD` | 2 | 5 | 2 | src/main-process/scenario-engines/dbs-charge-fund-check.js(3), src/main-process/scenario-engines/r4-fund-nature-check.js(2) |
| `BANK_DIRECTION_FIELDS` | 2 | 5 | 1 | src/main-process/scenario-engines/bank-direction-validator.js(3), src/main-process/scenario-engines/r4-fund-nature-check.js(2) |
| `BANK_STATEMENT_SHEET_NAME` | 2 | 5 | 2 | src/main-process/bank-statement-io.js(3), src/main-process/duplicate-inbound-match/service.js(2) |
| `bankContext` | 2 | 5 | 1 | src/main-process/pre-fund-reconciliation/service.js(3), src/main-process/pre-fund-reconciliation/matching-engine.js(2) |
| `Biff8RecordError` | 2 | 5 | 1 | src/backend/toolbox-format/biff8-records.js(3), src/backend/toolbox-format/biff8-overlay.js(2) |
| `BILL_INSERT_SQL` | 2 | 5 | 2 | src/backend/acquiring-bill-currency-import/contract-bill.js(3), src/backend/acquiring-bill-currency-db/import-repository.js(2) |
| `BIZ_OP_END_BALANCE_DB_COLUMN` | 2 | 5 | 1 | src/main-process/biz-op-recon-session.js(3), src/backend/biz-op-recon-db/columns.js(2) |
| `BOC_PAYMENT_DETAIL_KEYWORD` | 2 | 5 | 2 | src/main-process/boc-fx-link-builder.js(3), src/constants/boc-fx-link-fields.js(2) |
| `buildDefaultFileName` | 2 | 5 | 1 | src/main-process/duplicate-inbound-match/service.js(3), src/main-process/duplicate-inbound-match/excel-writer.js(2) |
| `buildFeatureRegex` | 2 | 5 | 2 | src/main-process/scenario-engines/c1-extract-recon-id.js(3), src/main-process/scenario-engines/r5-refund-order-backfill.js(2) |
| `buildGatewayFingerprint` | 2 | 5 | 2 | src/main-process/pre-fund-reconciliation/mpt-schema.js(3), src/main-process/pre-fund-reconciliation/matching-engine.js(2) |
| `buildResultMutationTokenV2` | 2 | 5 | 1 | src/backend/vcc-financial-op/read-snapshot.js(3), src/backend/vcc-financial-op/operation-token-v2.js(2) |
| `buildRowMapper` | 2 | 5 | 2 | src/backend/biz-op-recon-import/reader.js(3), src/backend/bank-bu-recon-import/reader.js(2) |
| `CHANNEL_BILL_HEADERS` | 2 | 5 | 1 | src/main-process/pre-fund-reconciliation/excel-writer.js(3), src/main-process/pre-fund-reconciliation/output-mapper.js(2) |
| `checkpointValue` | 2 | 5 | 2 | src/main-process/position-reconciliation/side-db-mutation.js(3), src/main-process/position-reconciliation/store.js(2) |
| `cleanupStagingPathsAsync` | 2 | 5 | 1 | src/main-process/position-reconciliation/service.js(3), src/main-process/position-reconciliation/input-staging.js(2) |
| `COLUMN_WIDTHS` | 2 | 5 | 1 | src/backend/position-reconciliation-import/anomaly-report.js(3), src/main-process/position-reconciliation/filtered-source-report.js(2) |
| `createBiff8GridResolver` | 2 | 5 | 1 | src/backend/toolbox-format/biff8-pass.js(3), src/backend/toolbox-format/biff8-overlay.js(2) |
| `createInvalidExtraFeeWarning` | 2 | 5 | 1 | src/main-process/scenario-engines/r5-fund-transfer-backfill.js(3), src/main-process/scenario-engines/r5-fund-transfer-recon-backfill.js(2) |
| `createMigrationJournal` | 2 | 5 | 1 | src/main-process/vcc-financial-op-storage-rebuild.js(3), src/main-process/vcc-financial-op-storage-migration.js(2) |
| `createSheet` | 2 | 5 | 2 | src/main-process/vcc-financial-op-audit-writer.js(3), src/main-process/pre-fund-reconciliation/mpt-error-report-writer.js(2) |
| `createSlimEffectiveRowsTable` | 2 | 5 | 1 | src/backend/vcc-financial-op-db/storage-contract.js(3), src/main-process/vcc-financial-op-storage-rebuild.js(2) |
| `DEFAULT_BUILTIN_FORMATS` | 2 | 5 | 1 | src/backend/toolbox-format/biff8-records.js(3), src/backend/toolbox-format/biff8-overlay.js(2) |
| `deserializeFromMessage` | 2 | 5 | 2 | src/main-process/run-check-worker-pool.js(3), src/main-process/run-check-multiworker.js(2) |
| `DIFF_HEADER_TAIL` | 2 | 5 | 1 | src/main-process/biz-op-recon-writer.js(3), src/backend/biz-op-recon-db/columns.js(2) |
| `DIFF_OUTPUT_BANK_SHEET` | 2 | 5 | 1 | src/main-process/bank-bu-recon-writer.js(3), src/backend/bank-bu-recon-db/columns.js(2) |
| `DIFF_OUTPUT_PENDING_SHEET` | 2 | 5 | 1 | src/main-process/bank-bu-recon-writer.js(3), src/backend/bank-bu-recon-db/columns.js(2) |
| `dispatchPositionImportPreflight` | 2 | 5 | 1 | src/main-process/position-reconciliation/import-dispatch.js(3), src/main-process/position-reconciliation/service.js(2) |
| `ENGINE_WORKER_ENTRY` | 2 | 5 | 2 | src/main-process/big-table-import-dispatch.js(3), src/main-process/acquiring-bill-currency-session.js(2) |
| `ERROR_HEADER_TAIL` | 2 | 5 | 1 | src/main-process/biz-op-recon-writer.js(3), src/backend/biz-op-recon-db/columns.js(2) |
| `freezeGatewayTags` | 2 | 5 | 1 | src/main-process/pre-fund-archive-lineage.js(3), src/main-process/pre-fund-reconciliation/service.js(2) |
| `freezeImportArchiveHandoffFiles` | 2 | 5 | 1 | src/backend/vcc-financial-op/import-service.js(3), src/main-process/vcc-financial-op-service.js(2) |
| `gatewayReconSession` | 2 | 5 | 1 | src/renderer.js(4), src/main.js(1) |
| `getArchivedRunByMonth` | 2 | 5 | 1 | src/main-process/vcc-financial-op-service.js(3), src/backend/vcc-financial-op/unarchive.js(2) |
| `getBillSplitAmountRules` | 2 | 5 | 1 | src/backend/database/template-repository.js(3), src/backend/database.js(2) |
| `getBillSplitMappings` | 2 | 5 | 1 | src/backend/database/template-repository.js(3), src/backend/database.js(2) |
| `getBillSplitMeta` | 2 | 5 | 1 | src/backend/database/template-repository.js(3), src/backend/database.js(2) |
| `getBillSplitRows` | 2 | 5 | 1 | src/backend/database/template-repository.js(3), src/backend/database.js(2) |
| `getByTaskRunId` | 2 | 5 | 1 | src/backend/biz-op-recon-db/month-end-copy-intent-repository.js(3), src/main-process/biz-op-recon-run-data.js(2) |
| `getMonthHead` | 2 | 5 | 1 | src/backend/pending-db/removed-repository.js(4), src/main-process/pending-archive-lineage.js(1) |
| `getStatusDualSource` | 2 | 5 | 2 | src/main-process/biz-op-recon-run-data.js(3), src/main-process/bank-bu-recon-run-data.js(2) |
| `getTemplateMappings` | 2 | 5 | 1 | src/backend/database/template-repository.js(3), src/backend/database.js(2) |
| `GW_TRADE_TYPE_FIELD` | 2 | 5 | 2 | src/main-process/scenario-engines/r4-fund-nature-check.js(3), src/main-process/scenario-engines/dbs-charge-fund-check.js(2) |
| `hashFile` | 2 | 5 | 2 | src/main-process/archive-center/storage-materializer.js(3), src/main-process/duplicate-inbound-match/service.js(2) |
| `hashSourceFileSync` | 2 | 5 | 1 | src/backend/vcc-financial-op/source-lineage.js(3), src/backend/vcc-financial-op/system-op-importer.js(2) |
| `hasInvalidExtraFee` | 2 | 5 | 1 | src/main-process/scenario-engines/r5-fund-transfer-backfill.js(3), src/main-process/scenario-engines/r5-fund-transfer-recon-backfill.js(2) |
| `importDetailGroup` | 2 | 5 | 1 | src/backend/vcc-financial-op/detail-importer.js(3), src/backend/vcc-financial-op/import-service.js(2) |
| `INBOUND_FIELDS` | 2 | 5 | 1 | src/main-process/pre-fund-reconciliation/mpt-schema.js(3), src/main-process/pre-fund-reconciliation/mpt-error-report-writer.js(2) |
| `inspectDatasetExport` | 2 | 5 | 1 | src/main-process/vcc-financial-op-dataset-writer.js(3), src/main-process/vcc-financial-op-service.js(2) |
| `isUnsafeAuditError` | 2 | 5 | 1 | src/backend/vcc-financial-op/result-write.js(3), src/backend/vcc-financial-op/destructive-write.js(2) |
| `iterateDuplicateAuditRows` | 2 | 5 | 1 | src/main-process/pre-fund-reconciliation/output-mapper.js(3), src/main-process/pre-fund-reconciliation/service.js(2) |
| `LARGE_TABLE_SCOPE_PROOF_SET` | 2 | 5 | 2 | src/backend/vcc-financial-op/mutation-guard.js(3), src/backend/vcc-financial-op/mutation-policy.js(2) |
| `LARGE_TABLE_SCOPE_PROOF_TABLES` | 2 | 5 | 1 | src/backend/vcc-financial-op/mutation-policy.js(3), src/backend/vcc-financial-op/mutation-guard.js(2) |
| `LEGACY_DATASET_TYPES` | 2 | 5 | 1 | src/backend/vcc-financial-op/archive-contract.js(3), src/backend/vcc-financial-op/result-write.js(2) |
| `listImportedDates` | 2 | 5 | 1 | src/main-process/biz-op-recon-run-data.js(3), src/backend/biz-op-recon-db/flow-imports-repository.js(2) |
| `listMonthsDualSource` | 2 | 5 | 2 | src/main-process/bank-bu-recon-run-data.js(3), src/main-process/acquiring-bill-currency-run-data.js(2) |
| `listRunsByDateBu` | 2 | 5 | 1 | src/main-process/biz-op-recon-run-data.js(3), src/backend/biz-op-recon-db/run-repository.js(2) |
| `loadResultMutationEvidence` | 2 | 5 | 1 | src/backend/vcc-financial-op/read-snapshot.js(3), src/backend/vcc-financial-op/result-write.js(2) |
| `loadToolboxSharedStrings` | 2 | 5 | 1 | src/backend/toolbox-format/xlsx-pass.js(3), src/backend/position-reconciliation-import/shared-strings-provider.js(2) |
| `loadUnarchiveGateEvidence` | 2 | 5 | 1 | src/backend/vcc-financial-op/read-snapshot.js(3), src/backend/vcc-financial-op/destructive-write.js(2) |
| `MAINTENANCE_COMMANDS` | 2 | 5 | 1 | src/backend/position-reconciliation-import/maintenance-writer.js(3), src/backend/position-reconciliation-import/worker-entry.js(2) |
| `makeInvalidExtraFeeWarningDeduper` | 2 | 5 | 1 | src/main-process/scenario-engines/r5-fund-transfer-backfill.js(3), src/main-process/scenario-engines/r5-fund-transfer-recon-backfill.js(2) |
| `MODULE_ACQUIRING` | 2 | 5 | 1 | src/backend/run-data-store.js(4), src/main-process/acquiring-bill-currency-run-data.js(1) |
| `MODULE_BANK_BU` | 2 | 5 | 1 | src/backend/run-data-store.js(4), src/main-process/bank-bu-recon-run-data.js(1) |
| `MODULE_DUPLICATE_INBOUND_MATCH` | 2 | 5 | 1 | src/backend/run-data-store.js(4), src/backend/duplicate-inbound-match-store.js(1) |
| `moveFileNoClobber` | 2 | 5 | 1 | src/main-process/pre-fund-reconciliation/excel-writer.js(3), src/main-process/pre-fund-reconciliation/service.js(2) |
| `MUTATION_SQL_STEP_REGISTRY` | 2 | 5 | 1 | src/backend/vcc-financial-op/mutation-guard.js(3), src/backend/vcc-financial-op/mutation-policy.js(2) |
| `normalizeAdjustmentAmount` | 2 | 5 | 1 | src/backend/vcc-financial-op/result-adjustments.js(3), src/backend/vcc-financial-op/result-write.js(2) |
| `normalizeAdjustmentReason` | 2 | 5 | 1 | src/backend/vcc-financial-op/result-adjustments.js(3), src/backend/vcc-financial-op/result-write.js(2) |
| `normalizeAlignment` | 2 | 5 | 2 | src/backend/toolbox-format/style-registry.js(3), src/backend/toolbox-format/biff8-overlay.js(2) |
| `normalizeLineageIntentsV1` | 2 | 5 | 2 | src/main-process/archive-center/task-lifecycle.js(3), src/main-process/archive-center/task-lineage.js(2) |
| `normalizeTargetAliasKey` | 2 | 5 | 1 | src/main-process/toolbox-target-identity.js(4), src/main-process/toolbox-multi-split.js(1) |
| `openPositionWorkbook` | 2 | 5 | 1 | src/backend/position-reconciliation-import/xlsx-reader.js(3), src/main-process/position-reconciliation/filtered-source-report.js(2) |
| `OUTBOUND_FIELDS` | 2 | 5 | 1 | src/main-process/pre-fund-reconciliation/mpt-schema.js(3), src/main-process/pre-fund-reconciliation/mpt-error-report-writer.js(2) |
| `OutputStyleRegistry` | 2 | 5 | 1 | src/main-process/toolbox-output-writer.js(3), src/backend/toolbox-format/style-registry.js(2) |
| `parseAmountAbs` | 2 | 5 | 2 | src/backend/acquiring-bill-currency-db/import-repository.js(3), src/backend/acquiring-bill-currency-import/contract-flow.js(2) |
| `parseOoxmlWallClock` | 2 | 5 | 1 | src/backend/toolbox-format/number-date.js(3), src/backend/toolbox-format/xlsx-sheet-scanner.js(2) |
| `peekImportTarget` | 2 | 5 | 2 | src/main-process/acquiring-bill-currency-run-data.js(3), src/main-process/acquiring-bill-currency-session.js(2) |
| `PENDING_INSERT_SQL` | 2 | 5 | 2 | src/backend/pending-import/contract-pending.js(3), src/backend/bank-bu-recon-db/month-repository.js(2) |
| `pendingContentHash` | 2 | 5 | 1 | src/backend/vcc-financial-op/row-mapper.js(3), src/backend/vcc-financial-op-db/migrations.js(2) |
| `pendingHeaderCandidate` | 2 | 5 | 1 | src/backend/vcc-financial-op/workbook-reader.js(3), src/backend/vcc-financial-op/pending-template-contract.js(2) |
| `pendingMonthEvidenceValue` | 2 | 5 | 1 | src/main.js(3), src/main-process/pending-import-preflight.js(2) |
| `pendingSession` | 2 | 5 | 1 | src/main-process/pending-import-preflight.js(4), src/main.js(1) |
| `persistRolledBackAuditSafely` | 2 | 5 | 1 | src/backend/vcc-financial-op/result-write.js(3), src/backend/vcc-financial-op/destructive-write.js(2) |
| `POSITION_IMPORT_MAX_ERROR_DETAILS` | 2 | 5 | 1 | src/backend/position-reconciliation-import/ledger.js(3), src/backend/position-reconciliation-import/constants.js(2) |
| `POSITION_RULESET_VERSION` | 2 | 5 | 1 | src/main-process/position-reconciliation/store.js(3), src/main-process/position-reconciliation/constants.js(2) |
| `POSITION_SOURCE_SUMMARY_SCHEMA` | 2 | 5 | 1 | src/main-process/position-reconciliation/source-summary-cache.js(3), src/main-process/position-reconciliation/store.js(2) |
| `positionRecoveryTerminalOutcome` | 2 | 5 | 1 | src/main-process/position-reconciliation/operation-lifecycle.js(4), src/main.js(1) |
| `PRE_SWITCH_PHASES` | 2 | 5 | 2 | src/main-process/archive-center/storage-root-manager.js(3), src/main-process/vcc-financial-op-storage-rebuild.js(2) |
| `preflightRequiredResult` | 2 | 5 | 1 | src/backend/vcc-financial-op/calculator.js(3), src/main-process/vcc-financial-op-service.js(2) |
| `previousDate` | 2 | 5 | 1 | src/main-process/biz-op-recon-run-data.js(3), src/main-process/biz-op-archive-lineage.js(2) |
| `PROGRESS_INTERVAL` | 2 | 5 | 2 | src/main-process/pre-fund-reconciliation/service.js(3), src/backend/vcc-op-calc-import/reader.js(2) |
| `projectOutputCell` | 2 | 5 | 1 | src/main-process/toolbox-output-writer.js(3), src/backend/toolbox-format/model.js(2) |
| `readPendingMonthEvidence` | 2 | 5 | 1 | src/main-process/pending-import-preflight.js(3), src/main.js(2) |
| `reconAmountAbs` | 2 | 5 | 2 | src/main-process/scenario-engines/r5-fund-transfer-recon-backfill.js(3), src/main-process/scenario-engines/many-to-many-detector.js(2) |
| `reconcileVccImportArchiveLineage` | 2 | 5 | 1 | src/main-process/vcc-financial-op-archive-lineage.js(3), src/main-process/vcc-financial-op-service.js(2) |
| `reconIdFixSession` | 2 | 5 | 1 | src/renderer.js(4), src/main.js(1) |
| `redactedFailure` | 2 | 5 | 1 | src/backend/vcc-financial-op/result-write.js(3), src/backend/vcc-financial-op/destructive-write.js(2) |
| `REPORT_ARTIFACT_KEY` | 2 | 5 | 1 | src/backend/position-reconciliation-import/anomaly-report.js(3), src/backend/position-reconciliation-import/preflight.js(2) |
| `resolveOperationInputPaths` | 2 | 5 | 1 | src/main-process/archive-center/operation-tracker.js(4), src/main.js(1) |
| `ROUND_LABELS` | 2 | 5 | 1 | src/renderer.js(3), src/main-process/reconciliation-orchestrator.js(2) |
| `runC2Scenario` | 2 | 5 | 2 | src/main-process/scenario-engines/index.js(3), src/main-process/scenario-engines/c2-offset-bill-mark.js(2) |
| `runC3Scenario` | 2 | 5 | 2 | src/main-process/scenario-engines/index.js(3), src/main-process/scenario-engines/c3-gateway-recon-join.js(2) |
| `runScenario` | 2 | 5 | 2 | src/main-process/scenario-dispatcher.js(3), src/main-process/scenario-engines/index.js(2) |
| `setExportAvailability` | 2 | 5 | 1 | src/renderer.js(4), src/renderer-previews.js(1) |
| `setNewAccountOpenDateValue` | 2 | 5 | 1 | src/renderer.js(3), src/renderer-previews.js(2) |
| `setVccStorageContractVersion` | 2 | 5 | 1 | src/backend/vcc-financial-op-db/storage-contract.js(3), src/main-process/vcc-financial-op-storage-rebuild.js(2) |
| `SIDE_DB_DDL_BIZ_OP` | 2 | 5 | 1 | src/backend/run-data-store.js(3), src/main-process/biz-op-recon-run-data.js(2) |
| `SIDE_DB_DDL_PRE_FUND_RUNS` | 2 | 5 | 1 | src/backend/run-data-store.js(4), src/backend/pre-fund-reconciliation-run-store.js(1) |
| `sideDbFileName` | 2 | 5 | 1 | src/backend/run-data-store.js(4), src/backend/pre-fund-reconciliation-store.js(1) |
| `SOURCE_DISPLAY_ORDER` | 2 | 5 | 1 | src/main-process/position-reconciliation/store.js(3), src/main-process/position-reconciliation/constants.js(2) |
| `SOURCE_FILTER_CODES` | 2 | 5 | 1 | src/main-process/position-reconciliation/readers.js(3), src/main-process/position-reconciliation/constants.js(2) |
| `SOURCE_TYPE_BY_FUND_TYPE` | 2 | 5 | 1 | src/main-process/position-reconciliation/constants.js(3), src/main-process/position-reconciliation/service.js(2) |
| `splitUtf16Safe` | 2 | 5 | 2 | src/main-process/pre-fund-reconciliation/output-mapper.js(3), src/main-process/pre-fund-reconciliation/mpt-error-report-writer.js(2) |
| `statementImportSessions` | 2 | 5 | 1 | src/main-process/statement-session.js(4), src/main.js(1) |
| `storedRecordResult` | 2 | 5 | 1 | src/backend/vcc-financial-op/import-service.js(3), src/main-process/vcc-financial-op-service.js(2) |
| `streamBizOpFile` | 2 | 5 | 2 | src/backend/biz-op-recon-import/reader-streamed.js(3), src/backend/biz-op-recon-import/import-worker.js(2) |
| `systemHeaderCandidate` | 2 | 5 | 1 | src/backend/vcc-financial-op/workbook-reader.js(3), src/backend/vcc-financial-op/system-op-importer.js(2) |
| `systemHeaderMismatchDetails` | 2 | 5 | 1 | src/backend/vcc-financial-op/workbook-reader.js(3), src/backend/vcc-financial-op/system-op-importer.js(2) |
| `TASK_FILE_PLAN_DEFINITIONS` | 2 | 5 | 1 | src/main-process/archive-center/task-file-plan-registry.js(3), src/main-process/archive-center/task-policy-registry.js(2) |
| `TEMPLATE_BILL_KEY_INDICES` | 2 | 5 | 2 | src/backend/acquiring-bill-currency-import/contract-bill.js(3), src/backend/acquiring-bill-currency-db/import-repository.js(2) |
| `TERMINAL_TASK_STATUSES` | 2 | 5 | 2 | src/main-process/archive-center/task-lifecycle.js(3), src/main-process/archive-center/controller.js(2) |
| `toolboxRecoveryOutputFiles` | 2 | 5 | 1 | src/main-process/toolbox-archive-recovery.js(4), src/main.js(1) |
| `ToolboxSheetReadError` | 2 | 5 | 1 | src/backend/toolbox-xlsx-stream/multi-sheet-reader.js(3), src/main-process/toolbox-merge-io.js(2) |
| `ToolboxSplitFieldNotFoundError` | 2 | 5 | 1 | src/main-process/toolbox-format-operations.js(3), src/backend/toolbox-xlsx-stream/split-export-filter.js(2) |
| `UNBALANCED_HEADERS` | 2 | 5 | 1 | src/main-process/pre-fund-reconciliation/excel-writer.js(3), src/main-process/pre-fund-reconciliation/output-mapper.js(2) |
| `unwrapBankEntry` | 2 | 5 | 2 | src/main-process/pre-fund-reconciliation/matching-engine.js(3), src/main-process/duplicate-inbound-match/matching-engine.js(2) |
| `updateNewAccountGenerateAvailability` | 2 | 5 | 1 | src/renderer.js(3), src/renderer-previews.js(2) |
| `validateDirection` | 2 | 5 | 1 | src/main-process/position-reconciliation/decimal.js(3), src/main-process/position-reconciliation/matching-engine.js(2) |
| `valuesFromToolboxRow` | 2 | 5 | 1 | src/backend/position-reconciliation-import/xlsx-reader.js(3), src/main-process/position-reconciliation/filtered-source-report.js(2) |
| `VCC_CURRENCY_DB_COLUMN` | 2 | 5 | 1 | src/main-process/vcc-op-calc-session.js(3), src/backend/vcc-op-calc-db/columns.js(2) |
| `VCC_RECON_AMOUNT_DB_COLUMN` | 2 | 5 | 1 | src/main-process/vcc-op-calc-session.js(3), src/backend/vcc-op-calc-db/columns.js(2) |
| `vccStorageGuardTriggerDefinition` | 2 | 5 | 1 | src/backend/vcc-financial-op-db/storage-contract.js(3), src/backend/vcc-financial-op/mutation-guard.js(2) |
| `writeResultWorkbook` | 2 | 5 | 1 | src/main-process/position-reconciliation/service.js(3), src/main-process/position-reconciliation/excel-io.js(2) |
| `ZHONGTAI_REFUND_ORDER_SIGNATURE` | 2 | 5 | 2 | src/constants/table-signatures.js(3), src/constants/refund-backfill-fields.js(2) |
| `__reconCols` | 2 | 4 | 2 | src/constants/fund-transfer-recon-fields.js(2), src/constants/payment-offline-allocation-fields.js(2) |
| `acknowledgePendingRunByTaskRun` | 2 | 4 | 1 | src/main-process/pending-archive-lineage.js(3), src/main.js(1) |
| `ADJUSTMENT_LINEAGE_NAME_PREFIX` | 2 | 4 | 1 | src/backend/vcc-financial-op/adjustment-lineage.js(3), src/main-process/vcc-financial-op-writer.js(1) |
| `ADM_EXTRA_FIELDS` | 2 | 4 | 1 | src/constants/adm-bank-deposit-fields.js(2), src/main-process/adm-bank-deposit-builder.js(2) |
| `ADM_FUND_TYPES` | 2 | 4 | 1 | src/constants/adm-bank-deposit-fields.js(2), src/main-process/adm-bank-deposit-builder.js(2) |
| `ADM_MERCHANT_ID` | 2 | 4 | 2 | src/backend/database/migrations.js(2), src/constants/adm-bank-deposit-fields.js(2) |
| `applyApplicableChannelIdsInTx` | 2 | 4 | 1 | src/backend/database/scenarios-repository.js(3), src/backend/database.js(1) |
| `applyPositionAccountSnapshot` | 2 | 4 | 1 | src/backend/position-reconciliation-import/account-writer.js(2), src/backend/position-reconciliation-import/worker-entry.js(2) |
| `applyPositionBankBatch` | 2 | 4 | 1 | src/backend/position-reconciliation-import/bank-writer.js(2), src/backend/position-reconciliation-import/worker-entry.js(2) |
| `applyPositionOrdinarySourceFiles` | 2 | 4 | 1 | src/backend/position-reconciliation-import/source-writer.js(2), src/backend/position-reconciliation-import/worker-entry.js(2) |
| `APPROVED_VCC_TRIGGERS` | 2 | 4 | 1 | src/backend/vcc-financial-op/mutation-guard.js(2), src/backend/vcc-financial-op/mutation-policy.js(2) |
| `assertBiff8OverlayMatchesProjection` | 2 | 4 | 1 | src/backend/toolbox-format/biff8-overlay.js(2), src/backend/toolbox-format/biff8-pass.js(2) |
| `assertBizOpMonthEndAdmission` | 2 | 4 | 1 | src/backend/biz-op-recon-import/import-worker.js(2), src/main-process/biz-op-recon-session.js(2) |
| `assertNoPendingMonthEndCopy` | 2 | 4 | 1 | src/backend/biz-op-recon-import/import-worker.js(2), src/main-process/biz-op-recon-session.js(2) |
| `atomicSwitchVccStorage` | 2 | 4 | 1 | src/main-process/vcc-financial-op-storage-migration.js(2), src/main-process/vcc-financial-op-storage-rebuild.js(2) |
| `balanceSeedRecordsEvidence` | 2 | 4 | 1 | src/main-process/manual-balance-seed-preflight.js(3), src/main.js(1) |
| `BANK_DEPOSIT_SIGNATURE` | 2 | 4 | 1 | src/constants/table-signatures.js(3), src/main.js(1) |
| `BANK_IDENTIFIER_FIELDS` | 2 | 4 | 1 | src/main-process/position-reconciliation/contracts.js(2), src/main-process/position-reconciliation/matching-engine.js(2) |
| `BANK_MATCH_KEY_DB_COLUMN` | 2 | 4 | 1 | src/backend/bank-bu-recon-db/columns.js(2), src/main-process/bank-bu-recon-session.js(2) |
| `BANK_MERCHANT_ID_FIELD` | 2 | 4 | 2 | src/main-process/scenario-engines/dbs-charge-fund-check.js(2), src/main-process/scenario-engines/r4-fund-nature-check.js(2) |
| `bankAmountEqualWithoutExtraFee` | 2 | 4 | 1 | src/main-process/scenario-engines/dbs-charge-fund-check.js(2), src/main-process/scenario-engines/r5-fund-transfer-backfill.js(2) |
| `BankStatementMergeError` | 2 | 4 | 1 | src/main-process/bank-statement-merge.js(3), src/main.js(1) |
| `baseMappedRow` | 2 | 4 | 1 | src/backend/file-service.js(2), src/backend/vcc-financial-op/row-mapper.js(2) |
| `BIZ_OP_RUN_TASK_KEY` | 2 | 4 | 1 | src/main-process/biz-op-archive-lineage.js(2), src/main-process/biz-op-recon-run-data.js(2) |
| `bizOpRunLineagePlan` | 2 | 4 | 1 | src/main-process/biz-op-archive-lineage.js(2), src/main-process/biz-op-recon-run-data.js(2) |
| `BOC_CHANNEL_NAME` | 2 | 4 | 2 | src/constants/boc-dispatch-order-fields.js(2), src/main-process/scenario-engines/boc-dispatch-order-fix.js(2) |
| `BOC_CHANNEL_VALUE` | 2 | 4 | 2 | src/constants/boc-fx-link-fields.js(2), src/main-process/boc-fx-link-builder.js(2) |
| `buildArchiveEvidenceV2` | 2 | 4 | 2 | src/backend/vcc-financial-op/archive-evidence.js(2), src/backend/vcc-financial-op/read-snapshot.js(2) |
| `buildDuplicateInboundGroups` | 2 | 4 | 1 | src/main-process/duplicate-inbound-match/matching-engine.js(2), src/main-process/duplicate-inbound-match/service.js(2) |
| `buildFailureAuditPlan` | 2 | 4 | 2 | src/backend/vcc-financial-op/destructive-write.js(2), src/backend/vcc-financial-op/result-write.js(2) |
| `buildLogicalAccounts` | 2 | 4 | 1 | src/main-process/position-reconciliation/logical-accounts.js(2), src/main-process/position-reconciliation/matching-engine.js(2) |
| `buildMappedRows` | 2 | 4 | 1 | src/backend/file-service.js(3), src/main.js(1) |
| `buildOriginalBaseName` | 2 | 4 | 1 | src/main-process/scenario-hit-rows-writer.js(3), src/main.js(1) |
| `buildVccStorageCandidate` | 2 | 4 | 1 | src/main-process/vcc-financial-op-storage-migration-worker.js(2), src/main-process/vcc-financial-op-storage-rebuild.js(2) |
| `BUSINESS_BILL_SHEET_NAME` | 2 | 4 | 1 | src/constants/recon-id-fix-fields.js(2), src/main-process/recon-id-fix-io.js(2) |
| `C4_CATEGORIES` | 2 | 4 | 2 | src/main-process/scenario-dispatcher.js(3), src/main.js(1) |
| `calculateMonth` | 2 | 4 | 2 | src/backend/vcc-financial-op/calculator.js(2), src/backend/vcc-financial-op/worker-entry.js(2) |
| `cancelError` | 2 | 4 | 2 | src/backend/position-reconciliation-import/maintenance-writer.js(2), src/backend/position-reconciliation-import/source-writer.js(2) |
| `CHANNEL_BILL_SHEET_NAME` | 2 | 4 | 1 | src/constants/gateway-bill-recon-fields.js(2), src/main-process/recon-id-fix-io.js(2) |
| `claimVccFinancialOpFirstMonth` | 2 | 4 | 1 | src/backend/vcc-financial-op-db/repository.js(2), src/backend/vcc-financial-op/calculator.js(2) |
| `CLEANUP_COPY_HEADERS` | 2 | 4 | 2 | src/constants/platform-cleanup-template-fields.js(2), src/main-process/scenario-engines/r5-platform-inbound-cleanup.js(2) |
| `clearBankDepositHitMarkersByBizIds` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/linked-table-repository.js(2) |
| `clearDiffRowsByRunId` | 2 | 4 | 1 | src/backend/acquiring-bill-currency-db/run-repository.js(3), src/main-process/acquiring-bill-currency-session.js(1) |
| `closeAllNewAccountCurrencyDropdowns` | 2 | 4 | 1 | src/renderer.js(3), src/renderer-previews.js(1) |
| `closeWorkbookOutputStream` | 2 | 4 | 2 | src/main-process/toolbox-output-writer.js(2), src/main-process/toolbox-stream-io.js(2) |
| `compareFileSequences` | 2 | 4 | 1 | src/backend/pre-fund-reconciliation-store.js(2), src/main-process/pre-fund-reconciliation/mpt-schema.js(2) |
| `computeAmounts` | 2 | 4 | 1 | src/main-process/vcc-op-calc-session.js(3), src/preload.js(1) |
| `copyVerifiedAnomalyReport` | 2 | 4 | 1 | src/main-process/position-reconciliation/filtered-source-report.js(2), src/main-process/position-reconciliation/service.js(2) |
| `countBankDepositByDateRange` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/linked-table-repository.js(2) |
| `countByMonth` | 2 | 4 | 1 | src/backend/pending-db/removed-repository.js(2), src/backend/pending-export/writer.js(2) |
| `countFxByDateRange` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/linked-table-repository.js(2) |
| `countGatewayBillByDateRange` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/linked-table-repository.js(2) |
| `countSignificantDigitsFromString` | 2 | 4 | 2 | src/backend/file-service/writers.js(2), src/main-process/toolbox-stream-io.js(2) |
| `createBankBuReconSession` | 2 | 4 | 2 | src/main-process/bank-bu-recon-session.js(2), src/main.js(2) |
| `createBoundedValuesAccumulator` | 2 | 4 | 2 | src/backend/toolbox-xlsx-stream/bounded-values-accumulator.js(2), src/main-process/toolbox-format-operations.js(2) |
| `createBusinessOperationRegistry` | 2 | 4 | 1 | src/main-process/business-operation-registry.js(2), src/main.js(2) |
| `createCancelToken` | 2 | 4 | 1 | src/main-process/acquiring-bill-currency-session.js(2), src/main-process/run-check-worker.js(2) |
| `createDuplicateInboundMatchStore` | 2 | 4 | 1 | src/backend/duplicate-inbound-match-store.js(2), src/main-process/duplicate-inbound-match/service.js(2) |
| `createPalette` | 2 | 4 | 1 | src/backend/toolbox-format/biff8-colors.js(2), src/backend/toolbox-format/biff8-overlay.js(2) |
| `createPendingSession` | 2 | 4 | 2 | src/main-process/pending-session.js(2), src/main.js(2) |
| `createPositionReconciliationStore` | 2 | 4 | 1 | src/main-process/position-reconciliation/service.js(2), src/main-process/position-reconciliation/store.js(2) |
| `createPreFundReconciliationRunStore` | 2 | 4 | 1 | src/backend/pre-fund-reconciliation-run-store.js(2), src/main-process/pre-fund-reconciliation/service.js(2) |
| `createScenarioImportContextStore` | 2 | 4 | 1 | src/main-process/archive-center/scenario-import-context-store.js(2), src/main.js(2) |
| `createVccFinancialOpService` | 2 | 4 | 2 | src/main-process/vcc-financial-op-service.js(2), src/main.js(2) |
| `createVccOpCalcSession` | 2 | 4 | 2 | src/main-process/vcc-op-calc-session.js(2), src/main.js(2) |
| `currentFileMatchesIdentity` | 2 | 4 | 1 | src/main-process/pre-fund-reconciliation/excel-writer.js(2), src/main-process/pre-fund-reconciliation/service.js(2) |
| `dateMismatchReason` | 2 | 4 | 2 | src/main-process/scenario-engines/r5-fund-transfer-backfill.js(2), src/main-process/scenario-engines/r5-fund-transfer-recon-backfill.js(2) |
| `deleteBankDepositByDateRange` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/linked-table-repository.js(2) |
| `deleteChannel` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/channels-repository.js(2) |
| `deleteFxByDateRange` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/linked-table-repository.js(2) |
| `deleteGatewayBillByDateRange` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/linked-table-repository.js(2) |
| `deleteScenario` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/scenarios-repository.js(2) |
| `deriveLinkedRows` | 2 | 4 | 1 | src/backend/position-reconciliation-import/preflight.js(2), src/main-process/position-reconciliation/derivation.js(2) |
| `detectDistribution` | 2 | 4 | 1 | src/main-process/app-updater.js(3), src/main.js(1) |
| `detectFundTransferManyToMany` | 2 | 4 | 2 | src/main-process/reconciliation-orchestrator.js(2), src/main-process/scenario-engines/many-to-many-detector.js(2) |
| `DRAWINGML_NAMESPACES` | 2 | 4 | 1 | src/backend/toolbox-format/ooxml-namespaces.js(2), src/backend/toolbox-format/style-registry.js(2) |
| `ensurePositionLargeImportSchemaAtPath` | 2 | 4 | 1 | src/backend/position-reconciliation-import/worker-entry.js(2), src/main-process/position-reconciliation/large-import-schema.js(2) |
| `ensureUiStyleDefault` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/settings-repository.js(2) |
| `ensureVccStorageSideTables` | 2 | 4 | 1 | src/backend/vcc-financial-op-db/migrations.js(2), src/backend/vcc-financial-op-db/storage-contract.js(2) |
| `executeDestructiveMutationWithSafeAudit` | 2 | 4 | 1 | src/backend/vcc-financial-op/destructive-write.js(2), src/main-process/vcc-financial-op-write-worker.js(2) |
| `executeResultMutationWithSafeAudit` | 2 | 4 | 1 | src/backend/vcc-financial-op/result-write.js(2), src/main-process/vcc-financial-op-write-worker.js(2) |
| `exportFilter` | 2 | 4 | 1 | src/backend/toolbox-xlsx-stream/large-split-worker.js(2), src/backend/toolbox-xlsx-stream/split-export-filter.js(2) |
| `exportMultiFilters` | 2 | 4 | 1 | src/backend/toolbox-xlsx-stream/large-split-worker.js(2), src/backend/toolbox-xlsx-stream/split-export-filter.js(2) |
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
| `getAutoUpdateEnabled` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/settings-repository.js(2) |
| `getBackgroundConfig` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/settings-repository.js(2) |
| `getBuiltinNumberFormat` | 2 | 4 | 1 | src/backend/toolbox-format/number-date.js(2), src/backend/toolbox-format/style-registry.js(2) |
| `getCurrencySuggestion` | 2 | 4 | 1 | src/renderer-dialogs.js(2), src/renderer.js(2) |
| `getCurrentModule` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/settings-repository.js(2) |
| `getDiffRowsByRun` | 2 | 4 | 1 | src/backend/biz-op-recon-db/run-repository.js(2), src/main-process/biz-op-recon-writer.js(2) |
| `getEnumConfig` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/settings-repository.js(2) |
| `getLastImportDirectoryCandidates` | 2 | 4 | 1 | src/backend/database/settings-repository.js(3), src/main-process/import-dialog-state.js(1) |
| `getMaxBocFxOrigGroupNo` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/linked-table-repository.js(2) |
| `getMirrorRun` | 2 | 4 | 2 | src/main-process/bank-bu-recon-run-data.js(2), src/main-process/biz-op-recon-run-data.js(2) |
| `getReconIdFixBillCategory` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/settings-repository.js(2) |
| `getRowById` | 2 | 4 | 1 | src/backend/biz-op-recon-db/imports-repository.js(2), src/main-process/biz-op-recon-writer.js(2) |
| `getRunResultSnapshot` | 2 | 4 | 1 | src/backend/vcc-financial-op/read-snapshot.js(2), src/main-process/vcc-financial-op-read-worker.js(2) |
| `getTaskFilePlanDefinition` | 2 | 4 | 1 | src/main-process/archive-center/task-file-plan-registry.js(2), src/main-process/archive-center/task-policy-registry.js(2) |
| `getTemplateByKey` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/template-repository.js(2) |
| `getTemplateByName` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/template-repository.js(2) |
| `gregorianTupleToExcelSerial` | 2 | 4 | 1 | src/backend/toolbox-format/model.js(2), src/backend/toolbox-format/number-date.js(2) |
| `GW_CURRENCY_FIELD` | 2 | 4 | 2 | src/main-process/scenario-engines/dbs-charge-fund-check.js(2), src/main-process/scenario-engines/r4-fund-nature-check.js(2) |
| `hasLinkedTableRows` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/linked-table-repository.js(2) |
| `hasMoreThanTwoDecimalsFromString` | 2 | 4 | 2 | src/backend/file-service/writers.js(2), src/main-process/toolbox-stream-io.js(2) |
| `hasShownWinOneDriveStorageNotice` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/settings-repository.js(2) |
| `heapStats` | 2 | 4 | 2 | src/backend/biz-op-recon-import/import-worker.js(2), src/backend/pending-import/worker.js(2) |
| `identifyAccountPair` | 2 | 4 | 1 | src/main-process/position-reconciliation/logical-accounts.js(2), src/main-process/position-reconciliation/matching-engine.js(2) |
| `identifyMptHeader` | 2 | 4 | 1 | src/main-process/pre-fund-reconciliation/mpt-parser.js(2), src/main-process/pre-fund-reconciliation/mpt-schema.js(2) |
| `importBillFile` | 2 | 4 | 1 | src/backend/acquiring-bill-currency-import/reader.js(2), src/main-process/acquiring-bill-currency-session.js(2) |
| `importFlowFile` | 2 | 4 | 1 | src/backend/acquiring-bill-currency-import/reader.js(2), src/main-process/acquiring-bill-currency-session.js(2) |
| `importMonth` | 2 | 4 | 1 | src/main-process/bank-bu-recon-run-data.js(2), src/main-process/bank-bu-recon-session.js(2) |
| `importSystemOpGroup` | 2 | 4 | 1 | src/backend/vcc-financial-op/import-service.js(2), src/backend/vcc-financial-op/system-op-importer.js(2) |
| `indexColumns` | 2 | 4 | 1 | src/backend/vcc-financial-op/read-schema.js(2), src/main-process/position-reconciliation/store.js(2) |
| `initializeOpeningBalances` | 2 | 4 | 1 | src/backend/vcc-financial-op/calculator.js(2), src/main-process/vcc-financial-op-service.js(2) |
| `inspectFiles` | 2 | 4 | 2 | src/backend/vcc-financial-op/import-service.js(2), src/backend/vcc-financial-op/worker-entry.js(2) |
| `inspectPositionOperationCommitChain` | 2 | 4 | 1 | src/main-process/position-reconciliation/import-recovery.js(2), src/main-process/position-reconciliation/side-db-mutation.js(2) |
| `inspectVccStorage` | 2 | 4 | 1 | src/main-process/vcc-financial-op-storage-migration.js(2), src/main-process/vcc-financial-op-storage-rebuild.js(2) |
| `INVALID_DIRECTIONS_WARNING_CODE` | 2 | 4 | 2 | src/main-process/scenario-engines/r5-fund-transfer-backfill.js(2), src/main-process/scenario-engines/r5-fund-transfer-recon-backfill.js(2) |
| `isBankDepositChannelFile` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/channel-enum-repository.js(2) |
| `isBuiltinNumberFormat` | 2 | 4 | 1 | src/backend/toolbox-format/number-date.js(2), src/backend/toolbox-format/style-registry.js(2) |
| `isFilenameMappingMode` | 2 | 4 | 2 | src/renderer.js(3), src/main.js(1) |
| `isMemoryLimitError` | 2 | 4 | 1 | src/backend/file-service/readers.js(2), src/main-process/toolbox-merge-io.js(2) |
| `isSystemOpHeaders` | 2 | 4 | 1 | src/backend/vcc-financial-op/definitions.js(2), src/backend/vcc-financial-op/workbook-reader.js(2) |
| `legacyPendingUpgradeDetails` | 2 | 4 | 1 | src/backend/vcc-financial-op/pending-template-contract.js(2), src/backend/vcc-financial-op/workbook-reader.js(2) |
| `listAccountMappings` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/settings-repository.js(2) |
| `listActiveMonthsSnapshot` | 2 | 4 | 1 | src/backend/vcc-financial-op/read-snapshot.js(2), src/main-process/vcc-financial-op-read-worker.js(2) |
| `listArchiveMonthsSnapshot` | 2 | 4 | 1 | src/backend/vcc-financial-op/read-snapshot.js(2), src/main-process/vcc-financial-op-read-worker.js(2) |
| `listChannelEnumValues` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/channel-enum-repository.js(2) |
| `listChildTemplates` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/template-repository.js(2) |
| `listDeleteTargetsSnapshot` | 2 | 4 | 1 | src/backend/vcc-financial-op/read-snapshot.js(2), src/main-process/vcc-financial-op-read-worker.js(2) |
| `listDistinctBus` | 2 | 4 | 1 | src/backend/biz-op-recon-db/imports-repository.js(2), src/main-process/biz-op-recon-run-data.js(2) |
| `listLinkedTableMeta` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/linked-table-repository.js(2) |
| `listRecoverableVccImportArchiveBatchIds` | 2 | 4 | 1 | src/main-process/vcc-financial-op-archive-lineage.js(3), src/main.js(1) |
| `listRunsDualSource` | 2 | 4 | 2 | src/main-process/bank-bu-recon-run-data.js(2), src/main-process/biz-op-recon-run-data.js(2) |
| `listScenarios` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/scenarios-repository.js(2) |
| `listTemplateBundleEntries` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/template-repository.js(2) |
| `loadJobMeta` | 2 | 4 | 2 | src/backend/biz-op-recon-import/import-worker.js(2), src/backend/pending-import/worker.js(2) |
| `makeUnionFind` | 2 | 4 | 2 | src/main-process/position-reconciliation/logical-accounts.js(2), src/main-process/scenario-engines/many-to-many-detector.js(2) |
| `mappedRowToInsertParams` | 2 | 4 | 1 | src/backend/vcc-financial-op/detail-importer.js(2), src/backend/vcc-financial-op/row-mapper.js(2) |
| `markBankDepositHits` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/linked-table-repository.js(2) |
| `markWinOneDriveStorageNoticeShown` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/settings-repository.js(2) |
| `MERCHANT_ID_MULTI_ACCOUNT_MARKER` | 2 | 4 | 2 | src/backend/database/utils.js(3), src/main.js(1) |
| `MID_ALLOCATION_SUCCESS_STATUS` | 2 | 4 | 1 | src/constants/fund-transfer-recon-fields.js(2), src/main-process/fund-transfer-recon-builder.js(2) |
| `MOVEMENT_SOURCE_TYPES` | 2 | 4 | 2 | src/backend/vcc-financial-op/result-adjustments.js(2), src/backend/vcc-financial-op/result-evidence.js(2) |
| `MPT_DELIMITER` | 2 | 4 | 1 | src/main-process/pre-fund-reconciliation/mpt-parser.js(2), src/main-process/pre-fund-reconciliation/mpt-schema.js(2) |
| `MTX_FEATURE` | 2 | 4 | 1 | src/constants/refund-backfill-fields.js(2), src/main-process/scenario-engines/r5-refund-order-backfill.js(2) |
| `normalizeCurrencyOptionEntry` | 2 | 4 | 1 | src/renderer-dialogs.js(2), src/renderer.js(2) |
| `normalizeMaintainedBigAccounts` | 2 | 4 | 1 | src/main-process/big-account-recognition.js(3), src/main.js(1) |
| `normalizeMptRow` | 2 | 4 | 1 | src/main-process/pre-fund-reconciliation/mpt-parser.js(2), src/main-process/pre-fund-reconciliation/mpt-schema.js(2) |
| `normalizePositionStreamingSourceTypes` | 2 | 4 | 1 | src/backend/position-reconciliation-import/constants.js(2), src/main-process/position-reconciliation/service.js(2) |
| `normalizeRunId` | 2 | 4 | 2 | src/backend/vcc-financial-op/read-snapshot.js(2), src/backend/vcc-financial-op/result-write.js(2) |
| `openEntryStream` | 2 | 4 | 2 | src/backend/position-reconciliation-import/xlsx-reader.js(2), src/backend/toolbox-format/xlsx-sheet-scanner.js(2) |
| `openModuleMenu` | 2 | 4 | 1 | src/renderer-previews.js(2), src/renderer.js(2) |
| `openToolboxBiff8Pass` | 2 | 4 | 1 | src/backend/toolbox-format/biff8-pass.js(2), src/main-process/toolbox-format-io.js(2) |
| `openToolboxCsvPass` | 2 | 4 | 1 | src/backend/toolbox-format/csv-pass.js(2), src/main-process/toolbox-format-io.js(2) |
| `openVccReadDatabase` | 2 | 4 | 2 | src/backend/vcc-financial-op/read-schema.js(2), src/main-process/vcc-financial-op-read-worker.js(2) |
| `OPPONENT_BILL_SHEET_NAME` | 2 | 4 | 1 | src/constants/recon-id-fix-fields.js(2), src/main-process/recon-id-fix-io.js(2) |
| `ORDER_REPAIR_SHEET_NAME` | 2 | 4 | 1 | src/constants/recon-id-fix-fields.js(2), src/main-process/recon-id-fix-io.js(2) |
| `ORDER_REPAIR_SHEET_NAME_GATEWAY` | 2 | 4 | 1 | src/constants/gateway-bill-recon-fields.js(2), src/main-process/recon-id-fix-io.js(2) |
| `parseColumnFromCellRef` | 2 | 4 | 1 | src/backend/acquiring-bill-currency-import/reader.js(3), src/backend/acquiring-bill-currency-import/reader-handrolled.js(1) |
| `parseOutboxBatchId` | 2 | 4 | 1 | src/main-process/archive-center/controller.js(2), src/main-process/archive-center/outbox-store.js(2) |
| `parseRowXml` | 2 | 4 | 1 | src/backend/biz-op-recon-import/reader-streamed.js(2), src/backend/vcc-op-calc-import/reader.js(2) |
| `peekFirstFile` | 2 | 4 | 1 | src/backend/big-table-import/engine.js(3), src/main-process/acquiring-bill-currency-session.js(1) |
| `peekToolboxSplitHeaders` | 2 | 4 | 1 | src/backend/toolbox-xlsx-stream/split-export-filter.js(2), src/main-process/toolbox-format-operations.js(2) |
| `PENDING_DB_FILENAME` | 2 | 4 | 2 | src/backend/pending-db.js(3), src/main.js(1) |
| `PENDING_MATCH_KEY_DB_COLUMN` | 2 | 4 | 1 | src/backend/bank-bu-recon-db/columns.js(2), src/main-process/bank-bu-recon-session.js(2) |
| `planRunOutputPaths` | 2 | 4 | 1 | src/main-process/acquiring-bill-currency-writer.js(3), src/main-process/acquiring-bill-currency-session.js(1) |
| `POSITION_DB_RELATIVE_PATH` | 2 | 4 | 1 | src/main-process/position-reconciliation/constants.js(2), src/main-process/position-reconciliation/store.js(2) |
| `POSITION_IMPORT_PROGRESS_HEARTBEAT_MS` | 2 | 4 | 1 | src/backend/position-reconciliation-import/constants.js(2), src/main-process/position-reconciliation/import-dispatch.js(2) |
| `POSITION_SST_LRU_MAX_ENTRIES` | 2 | 4 | 1 | src/backend/position-reconciliation-import/constants.js(2), src/backend/position-reconciliation-import/shared-strings-provider.js(2) |
| `POSITION_SST_MEMORY_BUDGET_BYTES` | 2 | 4 | 1 | src/backend/position-reconciliation-import/constants.js(2), src/backend/position-reconciliation-import/shared-strings-provider.js(2) |
| `positionBankAmountWithExtraFee` | 2 | 4 | 1 | src/main-process/position-reconciliation/decimal.js(2), src/main-process/position-reconciliation/matching-engine.js(2) |
| `preFundRunLineagePlan` | 2 | 4 | 1 | src/main-process/pre-fund-archive-lineage.js(2), src/main-process/pre-fund-reconciliation/service.js(2) |
| `preFundRunOutputIntent` | 2 | 4 | 1 | src/main-process/pre-fund-archive-lineage.js(2), src/main-process/pre-fund-reconciliation/service.js(2) |
| `prepareToolboxPublication` | 2 | 4 | 1 | src/main-process/toolbox-output-publication-worker.js(2), src/main-process/toolbox-output-publication.js(2) |
| `PREPROCESS_TABLE_SIGNATURES` | 2 | 4 | 1 | src/constants/table-signatures.js(3), src/main.js(1) |
| `previewDeleteTargetSnapshot` | 2 | 4 | 1 | src/backend/vcc-financial-op/read-snapshot.js(2), src/main-process/vcc-financial-op-read-worker.js(2) |
| `previewUnarchiveSnapshot` | 2 | 4 | 1 | src/backend/vcc-financial-op/read-snapshot.js(2), src/main-process/vcc-financial-op-read-worker.js(2) |
| `projectOutputRow` | 2 | 4 | 1 | src/main-process/pre-fund-reconciliation/excel-writer.js(2), src/main-process/pre-fund-reconciliation/output-mapper.js(2) |
| `projectToolboxRowValues` | 2 | 4 | 1 | src/backend/toolbox-format/model.js(2), src/main-process/toolbox-format-io.js(2) |
| `pruneStagingRoot` | 2 | 4 | 1 | src/main-process/position-reconciliation/input-staging.js(2), src/main-process/position-reconciliation/service.js(2) |
| `publishPreparedToolboxPublication` | 2 | 4 | 1 | src/main-process/toolbox-output-publication-worker.js(2), src/main-process/toolbox-output-publication.js(2) |
| `publishVccFinancialOpOutputs` | 2 | 4 | 1 | src/main-process/vcc-financial-op-output-recovery.js(2), src/main.js(2) |
| `readAdmBankDepositRows` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/linked-table-repository.js(2) |
| `readBankDepositHitMarkers` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/linked-table-repository.js(2) |
| `readBankFiles` | 2 | 4 | 2 | src/main-process/position-reconciliation/readers.js(2), src/main-process/position-reconciliation/service.js(2) |
| `readBiff8Overlay` | 2 | 4 | 1 | src/backend/toolbox-format/biff8-overlay.js(2), src/backend/toolbox-format/biff8-pass.js(2) |
| `readBocBankDepositRows` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/linked-table-repository.js(2) |
| `readBocFxLinkRows` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/linked-table-repository.js(2) |
| `readFundTransferReconRows` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/linked-table-repository.js(2) |
| `readGatewayBillRowPoolsByChannels` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/linked-table-repository.js(2) |
| `readGatewayBillRowsByChannels` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/linked-table-repository.js(2) |
| `readResultWorkbook` | 2 | 4 | 1 | src/main-process/position-reconciliation/excel-io.js(2), src/main-process/position-reconciliation/service.js(2) |
| `readSharedStrings` | 2 | 4 | 1 | src/backend/biz-op-recon-import/reader-streamed.js(2), src/backend/vcc-op-calc-import/reader.js(2) |
| `readSourceFiles` | 2 | 4 | 2 | src/main-process/position-reconciliation/readers.js(2), src/main-process/position-reconciliation/service.js(2) |
| `readXlsxSheetNames` | 2 | 4 | 1 | src/main-process/duplicate-inbound-match/document-statement-reader.js(2), src/main-process/duplicate-inbound-match/service.js(2) |
| `RECON_RESULT_FIELDS` | 2 | 4 | 1 | src/constants/recon-id-fix-fields.js(2), src/main-process/recon-id-fix-io.js(2) |
| `RECON_RESULT_SHEET_NAME` | 2 | 4 | 1 | src/constants/recon-id-fix-fields.js(2), src/main-process/recon-id-fix-io.js(2) |
| `RECON_RESULT_SHEET_NAME_GATEWAY` | 2 | 4 | 1 | src/constants/gateway-bill-recon-fields.js(2), src/main-process/recon-id-fix-io.js(2) |
| `reconIdFixResult` | 2 | 4 | 1 | src/renderer.js(3), src/main.js(1) |
| `recordMonthEndCopyIntent` | 2 | 4 | 1 | src/backend/biz-op-recon-import/import-worker.js(2), src/main-process/biz-op-recon-session.js(2) |
| `recoverPositionImportWorkerExit` | 2 | 4 | 1 | src/main-process/position-reconciliation/import-dispatch.js(2), src/main-process/position-reconciliation/import-recovery.js(2) |
| `refundOrderSession` | 2 | 4 | 1 | src/renderer.js(3), src/main.js(1) |
| `renameTemplate` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/template-repository.js(2) |
| `replaceBocFxLink` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/linked-table-repository.js(2) |
| `replaceLinkedTable` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/linked-table-repository.js(2) |
| `replaceLinkedTableStreaming` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/linked-table-repository.js(2) |
| `resetFundTransferReconUsage` | 2 | 4 | 1 | src/main-process/reconciliation-orchestrator.js(2), src/main-process/scenario-engines/r5-payment-offline-allocation-backfill.js(2) |
| `resolveBankRuleEligibility` | 2 | 4 | 2 | src/main-process/pre-fund-reconciliation/matching-engine.js(2), src/main-process/pre-fund-reconciliation/reconciliation-rules.js(2) |
| `resolveCurrencyValue` | 2 | 4 | 1 | src/backend/file-service.js(2), src/backend/file-service/normalizers.js(2) |
| `resolveDuplicateInboundDocumentMatches` | 2 | 4 | 1 | src/main-process/duplicate-inbound-match/matching-engine.js(2), src/main-process/duplicate-inbound-match/service.js(2) |
| `resolveDuplicateInboundMptMatches` | 2 | 4 | 1 | src/main-process/duplicate-inbound-match/matching-engine.js(2), src/main-process/duplicate-inbound-match/service.js(2) |
| `resolveFullColor` | 2 | 4 | 1 | src/backend/toolbox-format/biff8-colors.js(2), src/backend/toolbox-format/biff8-overlay.js(2) |
| `resolveWorkerScript` | 2 | 4 | 2 | src/main-process/run-check-multiworker.js(2), src/main-process/run-check-worker-pool.js(2) |
| `rgbToHsl` | 2 | 4 | 2 | src/backend/toolbox-format/biff8-colors.js(2), src/backend/toolbox-format/style-registry.js(2) |
| `rowScanner` | 2 | 4 | 2 | src/backend/big-table-import/engine.js(2), src/backend/big-table-import/import-worker.js(2) |
| `runBocDispatchOrderFix` | 2 | 4 | 2 | src/main-process/recon-id-fix-engine.js(2), src/main-process/scenario-engines/boc-dispatch-order-fix.js(2) |
| `runC4Scenario` | 2 | 4 | 2 | src/main-process/recon-id-fix-engine.js(2), src/main-process/scenario-engines/c4-recon-id-fix.js(2) |
| `runCheckCore` | 2 | 4 | 1 | src/main-process/acquiring-bill-currency-session.js(3), src/main-process/run-check-worker.js(1) |
| `runDbsChargeFundCheck` | 2 | 4 | 2 | src/main-process/reconciliation-orchestrator.js(2), src/main-process/scenario-engines/dbs-charge-fund-check.js(2) |
| `runJpmDispatchOrderFix` | 2 | 4 | 2 | src/main-process/recon-id-fix-engine.js(2), src/main-process/scenario-engines/jpm-dispatch-order-fix.js(2) |
| `runOutputLineageIntent` | 2 | 4 | 1 | src/main-process/pending-archive-lineage.js(3), src/main.js(1) |
| `runPositionFundNatureCheck` | 2 | 4 | 1 | src/main-process/position-reconciliation/matching-engine.js(2), src/main-process/position-reconciliation/service.js(2) |
| `runPositionImportPreflight` | 2 | 4 | 1 | src/backend/position-reconciliation-import/preflight.js(2), src/backend/position-reconciliation-import/worker-entry.js(2) |
| `runPositionMaintenanceJob` | 2 | 4 | 1 | src/backend/position-reconciliation-import/maintenance-writer.js(2), src/backend/position-reconciliation-import/worker-entry.js(2) |
| `runRound1ReconIdMatch` | 2 | 4 | 2 | src/main-process/reconciliation-orchestrator.js(2), src/main-process/scenario-engines/r1-recon-id-match.js(2) |
| `runRound4FundNatureCheck` | 2 | 4 | 2 | src/main-process/reconciliation-orchestrator.js(2), src/main-process/scenario-engines/r4-fund-nature-check.js(2) |
| `runRound5FundTransferBackfill` | 2 | 4 | 2 | src/main-process/reconciliation-orchestrator.js(2), src/main-process/scenario-engines/r5-fund-transfer-backfill.js(2) |
| `runRound5FundTransferReconBackfill` | 2 | 4 | 2 | src/main-process/reconciliation-orchestrator.js(2), src/main-process/scenario-engines/r5-fund-transfer-recon-backfill.js(2) |
| `runRound5PaymentOfflineAllocationBackfill` | 2 | 4 | 1 | src/main-process/reconciliation-orchestrator.js(2), src/main-process/scenario-engines/r5-payment-offline-allocation-backfill.js(2) |
| `runRound5PlatformInboundCleanup` | 2 | 4 | 2 | src/main-process/reconciliation-orchestrator.js(2), src/main-process/scenario-engines/r5-platform-inbound-cleanup.js(2) |
| `runRound5RefundOrderBackfill` | 2 | 4 | 2 | src/main-process/reconciliation-orchestrator.js(2), src/main-process/scenario-engines/r5-refund-order-backfill.js(2) |
| `runViaSideDb` | 2 | 4 | 2 | src/main-process/bank-bu-recon-run-data.js(2), src/main-process/biz-op-recon-run-data.js(2) |
| `saveAccountMappings` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/settings-repository.js(2) |
| `saveTemplateFilenameFixedField` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/template-repository.js(2) |
| `scanBiff8WorkbookStream` | 2 | 4 | 1 | src/backend/toolbox-format/biff8-overlay.js(2), src/backend/toolbox-format/biff8-records.js(2) |
| `scanFields` | 2 | 4 | 1 | src/backend/toolbox-xlsx-stream/large-split-worker.js(2), src/backend/toolbox-xlsx-stream/split-scan-fields.js(2) |
| `serial1904To1900` | 2 | 4 | 1 | src/backend/toolbox-format/model.js(2), src/backend/toolbox-format/number-date.js(2) |
| `setAcquiringBillChunkSize` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/settings-repository.js(2) |
| `setAcquiringBillIdleCleanupMinutes` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/settings-repository.js(2) |
| `setAcquiringBillRawJsonRetentionDays` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/settings-repository.js(2) |
| `setAcquiringBillWorkerCount` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/settings-repository.js(2) |
| `setAutoUpdateEnabled` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/settings-repository.js(2) |
| `setBackgroundConfig` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/settings-repository.js(2) |
| `setEnumConfig` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/settings-repository.js(2) |
| `setLastImportDirectory` | 2 | 4 | 1 | src/backend/database/settings-repository.js(2), src/main-process/import-dialog-state.js(2) |
| `showImportOpenDialog` | 2 | 4 | 2 | src/main-process/import-dialog-state.js(2), src/main.js(2) |
| `sourceAmountToCents` | 2 | 4 | 1 | src/main-process/position-reconciliation/decimal.js(2), src/main-process/position-reconciliation/matching-engine.js(2) |
| `sourceSnapshotForPath` | 2 | 4 | 2 | src/main-process/archive-center/operation-tracker.js(2), src/main-process/archive-center/source-snapshot.js(2) |
| `spawn` | 2 | 4 | 2 | src/main-process/biz-op-recon-session.js(2), src/main-process/pending-session.js(2) |
| `stageInputFilesAsync` | 2 | 4 | 1 | src/backend/position-reconciliation-import/preflight.js(2), src/main-process/position-reconciliation/input-staging.js(2) |
| `streamDocumentStatement` | 2 | 4 | 1 | src/main-process/duplicate-inbound-match/document-statement-reader.js(2), src/main-process/duplicate-inbound-match/service.js(2) |
| `streamPositionXlsRows` | 2 | 4 | 1 | src/backend/position-reconciliation-import/preflight.js(2), src/backend/position-reconciliation-import/xls-reader.js(2) |
| `streamPositionXlsxRows` | 2 | 4 | 1 | src/backend/position-reconciliation-import/preflight.js(2), src/backend/position-reconciliation-import/xlsx-reader.js(2) |
| `SUPPORT_ACTION_POLICIES` | 2 | 4 | 1 | src/main-process/archive-center/task-policy-registry.js(2), src/main.js(2) |
| `systemRecordResult` | 2 | 4 | 1 | src/backend/vcc-financial-op/import-service.js(2), src/backend/vcc-financial-op/system-op-importer.js(2) |
| `T54_REFUND_RE` | 2 | 4 | 1 | src/constants/refund-backfill-fields.js(2), src/main-process/scenario-engines/r5-refund-order-backfill.js(2) |
| `tableInfo` | 2 | 4 | 1 | src/backend/vcc-financial-op/read-schema.js(2), src/main-process/position-reconciliation/store.js(2) |
| `TextDecoder` | 2 | 4 | 2 | src/backend/position-reconciliation-import/shared-strings-provider.js(2), src/main-process/pre-fund-reconciliation/mpt-parser.js(2) |
| `toggleScenarioEnabled` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/scenarios-repository.js(2) |
| `toMatchValue` | 2 | 4 | 1 | src/backend/toolbox-format/model.js(2), src/main-process/toolbox-format-io.js(2) |
| `transferScenarios` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/scenarios-repository.js(2) |
| `UNARCHIVE_GATE_VERSION` | 2 | 4 | 1 | src/backend/vcc-financial-op/read-snapshot.js(2), src/backend/vcc-financial-op/unarchive-gate.js(2) |
| `updateChannel` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/channels-repository.js(2) |
| `updateRunStatus` | 2 | 4 | 1 | src/backend/acquiring-bill-currency-db/run-repository.js(3), src/main-process/acquiring-bill-currency-session.js(1) |
| `updateScenario` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/scenarios-repository.js(2) |
| `upgradeEmptyVccStorageContract` | 2 | 4 | 1 | src/backend/vcc-financial-op-db/migrations.js(2), src/backend/vcc-financial-op-db/storage-contract.js(2) |
| `upsertBocFxLink` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/linked-table-repository.js(2) |
| `upsertLinkedBankDeposit` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/linked-table-repository.js(2) |
| `upsertLinkedBankDepositStreaming` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/linked-table-repository.js(2) |
| `upsertLinkedFx` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/linked-table-repository.js(2) |
| `upsertLinkedGatewayBill` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/linked-table-repository.js(2) |
| `upsertLinkedGatewayBillStreaming` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/linked-table-repository.js(2) |
| `upsertTemplate` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/template-repository.js(2) |
| `v8` | 2 | 4 | 2 | src/backend/biz-op-recon-import/import-worker.js(2), src/backend/pending-import/worker.js(2) |
| `VALID_ORDER_STATUSES` | 2 | 4 | 1 | src/main-process/position-reconciliation/constants.js(2), src/main-process/position-reconciliation/derivation.js(2) |
| `validateBankHeaders` | 2 | 4 | 1 | src/backend/bank-bu-recon-import/reader.js(2), src/backend/bank-bu-recon-import/validator.js(2) |
| `validateEffectiveResultEvidence` | 2 | 4 | 2 | src/backend/vcc-financial-op/archive-evidence.js(2), src/backend/vcc-financial-op/result-evidence.js(2) |
| `validatePendingGuanliHeaders` | 2 | 4 | 1 | src/backend/bank-bu-recon-import/reader.js(2), src/backend/bank-bu-recon-import/validator.js(2) |
| `verifyPositionImportApplyGrant` | 2 | 4 | 1 | src/backend/position-reconciliation-import/apply-grant.js(2), src/backend/position-reconciliation-import/worker-entry.js(2) |
| `writeAdmMatchFlags` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/linked-table-repository.js(2) |
| `writeChannelWorkbooks` | 2 | 4 | 1 | src/main-process/pre-fund-reconciliation/excel-writer.js(2), src/main-process/pre-fund-reconciliation/service.js(2) |
| `writeDatasetWorkbook` | 2 | 4 | 2 | src/backend/vcc-financial-op/worker-entry.js(2), src/main-process/vcc-financial-op-dataset-writer.js(2) |
| `writeDuplicateInboundWorkbook` | 2 | 4 | 1 | src/main-process/duplicate-inbound-match/excel-writer.js(2), src/main-process/duplicate-inbound-match/service.js(2) |
| `writeImportAuditWorkbook` | 2 | 4 | 2 | src/main-process/vcc-financial-op-audit-writer.js(2), src/main-process/vcc-financial-op-service.js(2) |
| `writeLinkedWorkbook` | 2 | 4 | 1 | src/main-process/position-reconciliation/excel-io.js(2), src/main-process/position-reconciliation/service.js(2) |
| `writeMptErrorReport` | 2 | 4 | 2 | src/main-process/pre-fund-reconciliation/mpt-error-report-writer.js(2), src/main-process/pre-fund-reconciliation/service.js(2) |
| `writePositionAnomalyReport` | 2 | 4 | 1 | src/backend/position-reconciliation-import/anomaly-report.js(2), src/backend/position-reconciliation-import/preflight.js(2) |
| `writeRawWorkbook` | 2 | 4 | 1 | src/main-process/position-reconciliation/excel-io.js(2), src/main-process/position-reconciliation/service.js(2) |
| `writeRunFilteredSourcesWorkbook` | 2 | 4 | 1 | src/main-process/position-reconciliation/filtered-source-report.js(2), src/main-process/position-reconciliation/service.js(2) |
| `writeStreamedXlsx` | 2 | 4 | 2 | src/backend/pending-import/streaming-xlsx-writer.js(2), src/main-process/pending-archive-worker.js(2) |
| `AppDatabase` | 2 | 3 | 2 | src/backend/database.js(2), src/main.js(1) |
| `appendStatementSessionImport` | 2 | 3 | 1 | src/main-process/statement-session.js(2), src/main.js(1) |
| `applyScenarioBundleImport` | 2 | 3 | 1 | src/main-process/scenarios-bundle-import.js(2), src/main.js(1) |
| `assembleMonthlyBalance` | 2 | 3 | 1 | src/main-process/monthly-balance.js(2), src/main.js(1) |
| `assertHeadersIdentical` | 2 | 3 | 1 | src/main-process/toolbox.js(2), src/main-process/toolbox-stream-io.js(1) |
| `assertPositionRecoveryInputsUnchanged` | 2 | 3 | 1 | src/main-process/position-reconciliation/operation-lifecycle.js(2), src/main.js(1) |
| `authorizePositionImportApply` | 2 | 3 | 1 | src/main-process/position-reconciliation/operation-lifecycle.js(2), src/main.js(1) |
| `BIZ_OP_BU_FIELD_DB_COLUMN` | 2 | 3 | 1 | src/backend/biz-op-recon-db/columns.js(2), src/main-process/biz-op-recon-session.js(1) |
| `bizOpRunTerminalRoute` | 2 | 3 | 1 | src/main-process/biz-op-archive-lineage.js(2), src/main.js(1) |
| `buildDetailExportRows` | 2 | 3 | 1 | src/backend/file-service.js(2), src/main.js(1) |
| `buildMergeFileName` | 2 | 3 | 1 | src/main-process/toolbox.js(2), src/main.js(1) |
| `buildSplitFileName` | 2 | 3 | 1 | src/main-process/toolbox.js(2), src/main.js(1) |
| `buildStaleHitReminder` | 2 | 3 | 1 | src/main-process/scenario-engines/r5-refund-order-backfill.js(2), src/main.js(1) |
| `buildStatementFileEntry` | 2 | 3 | 1 | src/main-process/statement-session.js(2), src/main.js(1) |
| `buildVccImportArchiveHandoffFiles` | 2 | 3 | 1 | src/main-process/vcc-financial-op-archive-lineage.js(2), src/main.js(1) |
| `captureArchiveSourceSnapshots` | 2 | 3 | 1 | src/main-process/archive-center/source-snapshot.js(2), src/main.js(1) |
| `clearRunsByMonth` | 2 | 3 | 1 | src/backend/acquiring-bill-currency-db/run-repository.js(2), src/main-process/acquiring-bill-currency-session.js(1) |
| `clearStaleSuccessfulRawJson` | 2 | 3 | 2 | src/backend/acquiring-bill-currency-db/raw-json-retention.js(2), src/main.js(1) |
| `compareMatchedContent` | 2 | 3 | 1 | src/backend/pending-reconcile/removal-match.js(2), src/backend/pending-export/writer.js(1) |
| `completeRunOutputPublication` | 2 | 3 | 1 | src/backend/acquiring-bill-currency-db/run-repository.js(2), src/main-process/acquiring-bill-currency-session.js(1) |
| `computeRunStats` | 2 | 3 | 1 | src/backend/acquiring-bill-currency-db/run-repository.js(2), src/main-process/acquiring-bill-currency-session.js(1) |
| `computeValuesByField` | 2 | 3 | 1 | src/main-process/toolbox.js(2), src/main-process/toolbox-stream-io.js(1) |
| `countC3BankCandidates` | 2 | 3 | 2 | src/main-process/scenario-engines/c3-gateway-recon-join.js(2), src/main.js(1) |
| `countRefundBankCandidates` | 2 | 3 | 2 | src/main-process/scenario-engines/r5-refund-order-backfill.js(2), src/main.js(1) |
| `createAppUpdaterService` | 2 | 3 | 1 | src/main-process/app-updater.js(2), src/main.js(1) |
| `createArchiveCenterController` | 2 | 3 | 1 | src/main-process/archive-center/controller.js(2), src/main.js(1) |
| `createArchiveOperationTracker` | 2 | 3 | 1 | src/main-process/archive-center/operation-tracker.js(2), src/main.js(1) |
| `createArchiveOutboxStore` | 2 | 3 | 1 | src/main-process/archive-center/outbox-store.js(2), src/main.js(1) |
| `createArchiveRuntimeDelegate` | 2 | 3 | 1 | src/main-process/archive-center/archive-runtime-delegate.js(2), src/main.js(1) |
| `createArchiveService` | 2 | 3 | 1 | src/main-process/archive-center/archive-service.js(2), src/main.js(1) |
| `createArchiveStorageRootManager` | 2 | 3 | 1 | src/main-process/archive-center/storage-root-manager.js(2), src/main.js(1) |
| `createBankStatementRunFlowIdentity` | 2 | 3 | 1 | src/main-process/archive-center/task-policy-registry.js(2), src/main.js(1) |
| `createBusinessFlowResolver` | 2 | 3 | 1 | src/main-process/archive-center/business-flow-resolver.js(2), src/main.js(1) |
| `createDuplicateInboundMatchService` | 2 | 3 | 1 | src/main-process/duplicate-inbound-match/service.js(2), src/main.js(1) |
| `createIpcTaskContext` | 2 | 3 | 1 | src/main-process/archive-center/ipc-task-contract.js(2), src/main.js(1) |
| `createLegacyRunMirror` | 2 | 3 | 1 | src/backend/database/pre-fund-reconciliation-run-repository.js(2), src/backend/database.js(1) |
| `createPendingDatasetSeed` | 2 | 3 | 2 | src/backend/pending-db/dataset-identity.js(2), src/main.js(1) |
| `createPositionReconciliationService` | 2 | 3 | 1 | src/main-process/position-reconciliation/service.js(2), src/main.js(1) |
| `createPositionRunTaskContract` | 2 | 3 | 1 | src/main-process/position-reconciliation/interactive-task-preflight.js(2), src/main.js(1) |
| `createPositionSourceImportTaskContract` | 2 | 3 | 1 | src/main-process/position-reconciliation/interactive-task-preflight.js(2), src/main.js(1) |
| `createPreFundReconciliationService` | 2 | 3 | 1 | src/main-process/pre-fund-reconciliation/service.js(2), src/main.js(1) |
| `createRowInserter` | 2 | 3 | 1 | src/backend/pending-db/month-repository.js(2), src/backend/pending-import/worker.js(1) |
| `createStatementGenerationHelpers` | 2 | 3 | 1 | src/main-process/statement-generation.js(2), src/main.js(1) |
| `createTaskLifecycle` | 2 | 3 | 1 | src/main-process/archive-center/task-lifecycle.js(2), src/main.js(1) |
| `deleteMonth` | 2 | 3 | 1 | src/backend/pending-db/month-repository.js(2), src/backend/pending-import/worker.js(1) |
| `deleteMonthBySide` | 2 | 3 | 1 | src/backend/acquiring-bill-currency-db/import-repository.js(2), src/main-process/acquiring-bill-currency-session.js(1) |
| `detectBundleType` | 2 | 3 | 1 | src/backend/scenarios-bundle-io.js(2), src/main.js(1) |
| `detectTableType` | 2 | 3 | 2 | src/main-process/table-type-detector.js(2), src/main.js(1) |
| `dispatchLargeSplit` | 2 | 3 | 2 | src/main-process/toolbox-large-split-dispatch.js(2), src/main.js(1) |
| `encodeAdjustmentLineageName` | 2 | 3 | 1 | src/backend/vcc-financial-op/adjustment-lineage.js(2), src/main-process/vcc-financial-op-writer.js(1) |
| `executeAfterPositionAdmission` | 2 | 3 | 1 | src/main-process/position-reconciliation/interactive-task-preflight.js(2), src/main.js(1) |
| `executeIpcTaskInvocation` | 2 | 3 | 1 | src/main-process/archive-center/ipc-task-contract.js(2), src/main.js(1) |
| `executePendingImportSubmission` | 2 | 3 | 1 | src/main-process/pending-import-preflight.js(2), src/main.js(1) |
| `filterRowsByFieldValues` | 2 | 3 | 1 | src/main-process/toolbox.js(2), src/main-process/toolbox-stream-io.js(1) |
| `finalizePendingTerminalIntent` | 2 | 3 | 1 | src/main-process/pending-archive-lineage.js(2), src/main.js(1) |
| `finalizePreFundTerminalIntent` | 2 | 3 | 1 | src/main-process/pre-fund-archive-lineage.js(2), src/main.js(1) |
| `findByChannelAndName` | 2 | 3 | 1 | src/backend/database/scenarios-repository.js(2), src/backend/database.js(1) |
| `getApplicableChannelIds` | 2 | 3 | 1 | src/backend/database/scenarios-repository.js(2), src/backend/database.js(1) |
| `getBillDateCounts` | 2 | 3 | 1 | src/backend/acquiring-bill-currency-db/run-repository.js(2), src/main-process/acquiring-bill-currency-writer.js(1) |
| `getLatestRunByMonth` | 2 | 3 | 1 | src/backend/vcc-op-calc-db/run-repository.js(2), src/main-process/vcc-op-calc-session.js(1) |
| `getLatestRunForMonthPair` | 2 | 3 | 1 | src/backend/pending-db/diff-repository.js(2), src/preload.js(1) |
| `getMappingMap` | 2 | 3 | 1 | src/backend/database/fund-transfer-account-mapping-repository.js(2), src/backend/database.js(1) |
| `getOrCreateStatementImportSession` | 2 | 3 | 1 | src/main-process/statement-session.js(2), src/main.js(1) |
| `getPendingRows` | 2 | 3 | 1 | src/backend/bank-bu-recon-db/month-repository.js(2), src/main-process/bank-bu-recon-session.js(1) |
| `getRunMirrorByArchiveTaskRunId` | 2 | 3 | 1 | src/backend/database/pre-fund-reconciliation-run-repository.js(2), src/backend/database.js(1) |
| `getRunResult` | 2 | 3 | 1 | src/backend/vcc-financial-op/calculator.js(2), src/main-process/vcc-financial-op-service.js(1) |
| `getSessionStatus` | 2 | 3 | 1 | src/main-process/acquiring-bill-currency-session.js(2), src/main-process/acquiring-bill-currency-run-data.js(1) |
| `getTemplatesByBankName` | 2 | 3 | 1 | src/backend/database/template-repository.js(2), src/backend/database/own-accounts-migration.js(1) |
| `importBillFiles` | 2 | 3 | 1 | src/main-process/acquiring-bill-currency-session.js(2), src/main-process/acquiring-bill-currency-run-data.js(1) |
| `importBillFilesWithOverwrite` | 2 | 3 | 1 | src/main-process/acquiring-bill-currency-session.js(2), src/main-process/acquiring-bill-currency-run-data.js(1) |
| `importFlowFiles` | 2 | 3 | 1 | src/main-process/acquiring-bill-currency-session.js(2), src/main-process/acquiring-bill-currency-run-data.js(1) |
| `importFlowFilesWithOverwrite` | 2 | 3 | 1 | src/main-process/acquiring-bill-currency-session.js(2), src/main-process/acquiring-bill-currency-run-data.js(1) |
| `insertArchiveRun` | 2 | 3 | 1 | src/backend/biz-op-recon-db/run-repository.js(2), src/main-process/biz-op-recon-session.js(1) |
| `insertBillRow` | 2 | 3 | 1 | src/backend/acquiring-bill-currency-db/import-repository.js(2), src/backend/acquiring-bill-currency-import/reader.js(1) |
| `insertDiffRows` | 2 | 3 | 1 | src/backend/biz-op-recon-db/run-repository.js(2), src/main-process/biz-op-recon-session.js(1) |
| `insertDiffRowsByJoinChunked` | 2 | 3 | 1 | src/backend/acquiring-bill-currency-db/run-repository.js(2), src/main-process/acquiring-bill-currency-session.js(1) |
| `insertDiffRowsByJoinMultiWorker` | 2 | 3 | 1 | src/backend/acquiring-bill-currency-db/run-repository.js(2), src/main-process/acquiring-bill-currency-session.js(1) |
| `insertFlowRow` | 2 | 3 | 1 | src/backend/acquiring-bill-currency-db/import-repository.js(2), src/backend/acquiring-bill-currency-import/reader.js(1) |
| `insertRunFiles` | 2 | 3 | 1 | src/backend/vcc-op-calc-db/run-repository.js(2), src/main-process/vcc-op-calc-session.js(1) |
| `isStorageRootOnOneDrive` | 2 | 3 | 2 | src/main-process/onedrive-detector.js(2), src/main.js(1) |
| `iterateDiffRowsByDateRange` | 2 | 3 | 1 | src/backend/acquiring-bill-currency-db/run-repository.js(2), src/main-process/acquiring-bill-currency-writer.js(1) |
| `iterateExportableImportAnomalies` | 2 | 3 | 1 | src/backend/vcc-financial-op-db/repository.js(2), src/main-process/vcc-financial-op-audit-writer.js(1) |
| `LINKED_IMPORT_SIGNATURES` | 2 | 3 | 1 | src/constants/table-signatures.js(2), src/main.js(1) |
| `listAllByChannelId` | 2 | 3 | 1 | src/backend/database/scenarios-repository.js(2), src/backend/database.js(1) |
| `listBuiltinFixedForChannel` | 2 | 3 | 1 | src/backend/database/scenarios-repository.js(2), src/backend/database.js(1) |
| `listDistinctMonths` | 2 | 3 | 1 | src/backend/vcc-op-calc-db/run-repository.js(2), src/main-process/vcc-op-calc-session.js(1) |
| `listImportRecordsByBatch` | 2 | 3 | 1 | src/backend/vcc-financial-op-db/repository.js(2), src/main-process/vcc-financial-op-service.js(1) |
| `listMatchedDiffRowIds` | 2 | 3 | 1 | src/backend/pending-reconcile/removal-match.js(2), src/backend/pending-export/writer.js(1) |
| `listMatchedRemovedRowIds` | 2 | 3 | 1 | src/backend/pending-reconcile/removal-match.js(2), src/backend/pending-export/writer.js(1) |
| `listPartialRuns` | 2 | 3 | 1 | src/backend/acquiring-bill-currency-db/run-repository.js(2), src/main-process/acquiring-bill-currency-run-data.js(1) |
| `listRunsForMonthPair` | 2 | 3 | 1 | src/backend/pending-db/diff-repository.js(2), src/preload.js(1) |
| `loadFundTypeEnum` | 2 | 3 | 2 | src/constants/fund-type-enum.js(2), src/main.js(1) |
| `loadGatewayReconHeaders` | 2 | 3 | 2 | src/constants/gateway-recon-headers-loader.js(2), src/main.js(1) |
| `loadResultTemplateContract` | 2 | 3 | 1 | src/backend/vcc-financial-op/result-template-contract.js(2), src/main-process/vcc-financial-op-writer.js(1) |
| `markCleanupPending` | 2 | 3 | 1 | src/backend/acquiring-bill-currency-db/run-repository.js(2), src/main-process/acquiring-bill-currency-session.js(1) |
| `matchMerchantIds` | 2 | 3 | 1 | src/main-process/big-account-recognition.js(2), src/main.js(1) |
| `mergeAoaRows` | 2 | 3 | 1 | src/main-process/toolbox.js(2), src/main-process/toolbox-stream-io.js(1) |
| `mergeBankStatementRows` | 2 | 3 | 1 | src/main-process/bank-statement-merge.js(2), src/main.js(1) |
| `mergeToolboxFilesToXlsx` | 2 | 3 | 1 | src/main-process/toolbox-merge-io.js(2), src/main.js(1) |
| `normalizeIpcTaskHandler` | 2 | 3 | 1 | src/main-process/archive-center/ipc-task-contract.js(2), src/main.js(1) |
| `openBackgroundPalette` | 2 | 3 | 1 | src/renderer.js(2), src/renderer-previews.js(1) |
| `openPendingDb` | 2 | 3 | 2 | src/backend/pending-db.js(2), src/main.js(1) |
| `parseAdjustmentLineageName` | 2 | 3 | 1 | src/backend/vcc-financial-op/adjustment-lineage.js(2), src/main-process/vcc-financial-op-writer.js(1) |
| `parseBankAccountExcel` | 2 | 3 | 2 | src/backend/bank-account-import.js(2), src/main.js(1) |
| `parseScenarioBundle` | 2 | 3 | 1 | src/backend/scenarios-bundle-io.js(2), src/main.js(1) |
| `peekMonthKeyFromFile` | 2 | 3 | 1 | src/backend/acquiring-bill-currency-import/reader.js(2), src/main-process/acquiring-bill-currency-session.js(1) |
| `pendingAggregateRunSelection` | 2 | 3 | 1 | src/main-process/pending-archive-lineage.js(2), src/main.js(1) |
| `pendingRunLineagePlan` | 2 | 3 | 1 | src/main-process/pending-archive-lineage.js(2), src/main.js(1) |
| `pendingRunTerminalRoute` | 2 | 3 | 1 | src/main-process/pending-archive-lineage.js(2), src/main.js(1) |
| `pickBankDepositFields` | 2 | 3 | 2 | src/backend/database/linked-table-repository.js(2), src/main.js(1) |
| `pickStaleHits` | 2 | 3 | 1 | src/main-process/scenario-engines/r5-refund-order-backfill.js(2), src/main.js(1) |
| `POSITION_SIDE_DB_BOOTSTRAP_SETTING` | 2 | 3 | 1 | src/main-process/position-reconciliation/constants.js(2), src/main.js(1) |
| `POSITION_SIDE_DB_CHECKPOINT_SETTING` | 2 | 3 | 1 | src/main-process/position-reconciliation/constants.js(2), src/main.js(1) |
| `POSITION_SIDE_DB_PENDING_SETTING` | 2 | 3 | 1 | src/main-process/position-reconciliation/constants.js(2), src/main.js(1) |
| `positionArchiveIntentEvidence` | 2 | 3 | 1 | src/main-process/position-reconciliation/operation-lifecycle.js(2), src/main.js(1) |
| `positionBusinessStateForResult` | 2 | 3 | 1 | src/main-process/position-reconciliation/operation-lifecycle.js(2), src/main.js(1) |
| `positionCancellationAcceptedPending` | 2 | 3 | 1 | src/main-process/position-reconciliation/operation-lifecycle.js(2), src/main.js(1) |
| `positionCommittedRecoveryArchiveFiles` | 2 | 3 | 1 | src/main-process/position-reconciliation/operation-lifecycle.js(2), src/main.js(1) |
| `positionPersistentStagingProtectionPaths` | 2 | 3 | 1 | src/main-process/position-reconciliation/operation-lifecycle.js(2), src/main.js(1) |
| `positionReconciliationFailureResult` | 2 | 3 | 1 | src/main-process/position-reconciliation/operation-lifecycle.js(2), src/main.js(1) |
| `positionRecoveryArchiveFiles` | 2 | 3 | 1 | src/main-process/position-reconciliation/operation-lifecycle.js(2), src/main.js(1) |
| `positionRecoveryCleanupInputPaths` | 2 | 3 | 1 | src/main-process/position-reconciliation/operation-lifecycle.js(2), src/main.js(1) |
| `positionTerminalOutcomeForResult` | 2 | 3 | 1 | src/main-process/position-reconciliation/operation-lifecycle.js(2), src/main.js(1) |
| `preFundRunTerminalRoute` | 2 | 3 | 1 | src/main-process/pre-fund-archive-lineage.js(2), src/main.js(1) |
| `prepareBillInsert` | 2 | 3 | 1 | src/backend/acquiring-bill-currency-db/import-repository.js(2), src/backend/acquiring-bill-currency-import/reader.js(1) |
| `prepareFlowInsert` | 2 | 3 | 1 | src/backend/acquiring-bill-currency-db/import-repository.js(2), src/backend/acquiring-bill-currency-import/reader.js(1) |
| `prepareIpcTaskInvocation` | 2 | 3 | 1 | src/main-process/archive-center/ipc-task-contract.js(2), src/main.js(1) |
| `prepareManualBalanceSeedSubmission` | 2 | 3 | 1 | src/main-process/manual-balance-seed-preflight.js(2), src/main.js(1) |
| `preparePendingImportSubmission` | 2 | 3 | 1 | src/main-process/pending-import-preflight.js(2), src/main.js(1) |
| `prepareRunLineage` | 2 | 3 | 1 | src/main-process/biz-op-recon-run-data.js(2), src/main-process/pre-fund-reconciliation/service.js(1) |
| `preservePreFundRunOwnerAfterMirrorCompensationFailure` | 2 | 3 | 1 | src/main-process/pre-fund-archive-lineage.js(2), src/main.js(1) |
| `publicBizOpRun` | 2 | 3 | 1 | src/main-process/biz-op-archive-lineage.js(2), src/main.js(1) |
| `publicPendingRun` | 2 | 3 | 1 | src/main-process/pending-archive-lineage.js(2), src/main.js(1) |
| `readBankFile` | 2 | 3 | 2 | src/backend/bank-bu-recon-import/reader.js(2), src/main.js(1) |
| `readBigAccountMode` | 2 | 3 | 2 | src/backend/big-account-mode-store.js(2), src/main.js(1) |
| `readBigAccountOrder` | 2 | 3 | 2 | src/backend/big-account-order-store.js(2), src/main.js(1) |
| `readPendingGuanliFile` | 2 | 3 | 2 | src/backend/bank-bu-recon-import/reader.js(2), src/main.js(1) |
| `rebuildAdmDerivation` | 2 | 3 | 1 | src/main-process/linked-derive-rebuild.js(2), src/main.js(1) |
| `rebuildBankDepositBocDerivation` | 2 | 3 | 1 | src/main-process/linked-derive-rebuild.js(2), src/main.js(1) |
| `rebuildFundTransferReconDerivation` | 2 | 3 | 1 | src/main-process/linked-derive-rebuild.js(2), src/main.js(1) |
| `rebuildFxBocDerivation` | 2 | 3 | 1 | src/main-process/linked-derive-rebuild.js(2), src/main.js(1) |
| `reconcileVccImportArchiveLineageAtStartup` | 2 | 3 | 1 | src/main-process/vcc-financial-op-archive-lineage.js(2), src/main.js(1) |
| `recordFromBankStatementRows` | 2 | 3 | 1 | src/backend/database/channel-enum-repository.js(2), src/backend/database.js(1) |
| `recoverPendingRunReceipts` | 2 | 3 | 1 | src/main-process/pending-archive-lineage.js(2), src/main.js(1) |
| `recoverPreFundRunReceipts` | 2 | 3 | 1 | src/main-process/pre-fund-archive-lineage.js(2), src/main.js(1) |
| `recoverVccImportArchiveTasks` | 2 | 3 | 1 | src/main-process/vcc-financial-op-archive-lineage.js(2), src/main.js(1) |
| `REFUND_BACKFILL_FIELD_MAP` | 2 | 3 | 1 | src/constants/refund-backfill-fields.js(2), src/main-process/scenario-engines/r5-refund-order-backfill.js(1) |
| `removeStatementSessionEntriesByFilePath` | 2 | 3 | 1 | src/main-process/statement-session.js(2), src/main.js(1) |
| `reportStartupFailure` | 2 | 3 | 1 | src/backend/startup-failure.js(2), src/main.js(1) |
| `resolveFundTransferDatePolicy` | 2 | 3 | 1 | src/main-process/fund-transfer-date-policy.js(2), src/main.js(1) |
| `resolveRecognizedBigAccount` | 2 | 3 | 1 | src/main-process/big-account-recognition.js(2), src/main.js(1) |
| `runLegacyReconciliation` | 2 | 3 | 2 | src/backend/pending-reconcile/engine.js(2), src/main-process/biz-op-recon-session.js(1) |
| `runOwnAccountsMigration` | 2 | 3 | 2 | src/backend/database/own-accounts-migration.js(2), src/main.js(1) |
| `runPipeline` | 2 | 3 | 1 | src/backend/big-table-import/pipeline.js(2), src/backend/big-table-import/engine.js(1) |
| `runPositionOperationLifecycle` | 2 | 3 | 1 | src/main-process/position-reconciliation/operation-lifecycle.js(2), src/main.js(1) |
| `runReconIdFix` | 2 | 3 | 2 | src/main-process/recon-id-fix-engine.js(2), src/main.js(1) |
| `runWithPreparedResourceCleanup` | 2 | 3 | 1 | src/main-process/position-reconciliation/interactive-task-preflight.js(2), src/main.js(1) |
| `scanFxGroups` | 2 | 3 | 1 | src/main-process/boc-fx-link-builder.js(2), src/main.js(1) |
| `selectSuccessfulPathsByResultIndex` | 2 | 3 | 1 | src/main-process/archive-center/operation-tracker.js(2), src/main.js(1) |
| `serializeScenarioBundle` | 2 | 3 | 1 | src/backend/scenarios-bundle-io.js(2), src/main.js(1) |
| `setApplicableChannelIds` | 2 | 3 | 1 | src/backend/database/scenarios-repository.js(2), src/backend/database.js(1) |
| `settlePositionArchiveResult` | 2 | 3 | 1 | src/main-process/position-reconciliation/operation-lifecycle.js(2), src/main.js(1) |
| `settlePositionRecoveredTask` | 2 | 3 | 1 | src/main-process/position-reconciliation/operation-lifecycle.js(2), src/main.js(1) |
| `shouldUseLargeChannel` | 2 | 3 | 2 | src/main-process/toolbox-large-split-router.js(2), src/main.js(1) |
| `showComingSoon` | 2 | 3 | 1 | src/renderer.js(2), src/renderer-dialogs.js(1) |
| `STAGING_ROW_INSERT_SQL` | 2 | 3 | 1 | src/backend/vcc-financial-op-db/repository.js(2), src/backend/vcc-financial-op/detail-importer.js(1) |
| `streamLinkedRowsToInsert` | 2 | 3 | 2 | src/main-process/linked-table-stream-source.js(2), src/main.js(1) |
| `toBalanceRows` | 2 | 3 | 1 | src/main-process/monthly-balance.js(2), src/main.js(1) |
| `updateRunStats` | 2 | 3 | 1 | src/backend/pending-db/diff-repository.js(2), src/backend/pending-reconcile/engine.js(1) |
| `upsertMonthMeta` | 2 | 3 | 1 | src/backend/pending-db/month-repository.js(2), src/backend/pending-import/worker.js(1) |
| `vccFinancialOpErrorResult` | 2 | 3 | 2 | src/main-process/vcc-financial-op-ipc.js(2), src/main.js(1) |
| `writeAggregateDiffWorkbook` | 2 | 3 | 1 | src/main-process/bank-bu-recon-writer.js(2), src/main.js(1) |
| `writeBankStatementOutput` | 2 | 3 | 1 | src/main-process/exceljs-writer.js(2), src/main-process/bank-statement-io.js(1) |
| `writeBigAccountMode` | 2 | 3 | 2 | src/backend/big-account-mode-store.js(2), src/main.js(1) |
| `writeBigAccountOrder` | 2 | 3 | 2 | src/backend/big-account-order-store.js(2), src/main.js(1) |
| `writeDateRangeDiffWorkbook` | 2 | 3 | 1 | src/main-process/biz-op-recon-writer.js(2), src/main.js(1) |
| `writeManualBalanceSeedPlan` | 2 | 3 | 1 | src/main-process/manual-balance-seed-preflight.js(2), src/main.js(1) |
| `writePlatformCleanupOutput` | 2 | 3 | 2 | src/main-process/platform-cleanup-writer.js(2), src/main.js(1) |
| `writeRefundBackfillOutput` | 2 | 3 | 2 | src/main-process/refund-backfill-writer.js(2), src/main.js(1) |
| `writeRunOutputs` | 2 | 3 | 1 | src/main-process/acquiring-bill-currency-writer.js(2), src/main-process/acquiring-bill-currency-session.js(1) |
| `writeScenarioHitRows` | 2 | 3 | 1 | src/main-process/scenario-hit-rows-writer.js(2), src/main.js(1) |
| `writeSingleDateDiffWorkbook` | 2 | 3 | 1 | src/main-process/biz-op-recon-writer.js(2), src/main.js(1) |
| `xmlAttrUnescape` | 2 | 3 | 2 | src/backend/biz-op-recon-import/reader-streamed.js(2), src/backend/big-table-import/zip-reader.js(1) |
| `CELL_OPEN_RE` | 2 | 2 | 2 | src/backend/acquiring-bill-currency-import/reader-handrolled.js(1), src/backend/pending-import/streaming-xlsx-reader.js(1) |
| `CELL_R_RE` | 2 | 2 | 2 | src/backend/acquiring-bill-currency-import/reader-handrolled.js(1), src/backend/pending-import/streaming-xlsx-reader.js(1) |
| `readGatewayRecon` | 2 | 2 | 1 | src/main-process/bank-statement-io.js(1), src/main.js(1) |
| `readMeaningfulRowsHead` | 2 | 2 | 1 | src/backend/file-service/readers.js(1), src/main-process/table-type-detector.js(1) |
| `readReconIdFixFile` | 2 | 2 | 1 | src/main-process/recon-id-fix-io.js(1), src/main.js(1) |
| `WINDOWS_RESERVED_NAMES` | 2 | 2 | 2 | src/main-process/bank-statement-io.js(1), src/main-process/recon-id-fix-io.js(1) |
