# 代码库变量引用统计（自动生成）

> 由 `scripts/scan-vars.js` 自动生成，请不要手改。手工维护的重要变量清单在 `rules/important-variables.md`。

| 字段 | 值 |
|---|---|
| 版本 | v3.2.6 |
| 扫描时间 | 2026-9-5 15:17:58 |
| 扫描目录 | `src/` |
| 源码集合 | Git 已跟踪 `.js`（排除 ignored/generated/untracked） |
| JS 文件数 | 602 |
| 顶层声明总数 | 6779 |
| ≥2 次引用 | 6597 |
| 跨 ≥3 文件 (A-share) | 1103 |
| 跨 2 文件 (A-pair) | 1437 |
| 单文件 (A-local) | 4057 |
| 跨文件合计 (B) | 2540 |

---

## A-share — 跨 ≥3 文件共享

| 名字 | 跨度 | 总次数 | 声明数 | 声明位置（首个） |
|---|---:|---:|---:|---|
| `path` | 231 | 1555 | 205 | src/backend/acquiring-bill-currency-import/reader-handrolled.js |
| `db` | 163 | 5501 | 1 | src/main-process/background-execution/canary/durable-worker.js |
| `fs` | 157 | 992 | 156 | src/backend/balance-adjustment-store.js |
| `run` | 129 | 1476 | 3 | src/backend/vcc-financial-op/worker-entry.js |
| `rowCount` | 112 | 580 | 1 | src/main-process/statement-worker/probe-state-builder.js |
| `sha256` | 108 | 506 | 7 | src/backend/vcc-financial-op/operation-audit.js |
| `crypto` | 93 | 271 | 93 | src/backend/database/archive-repository.js |
| `parse` | 91 | 165 | 1 | src/backend/usage-stats.js |
| `digest` | 89 | 215 | 5 | src/main-process/background-execution/service-host.js |
| `state` | 80 | 1258 | 1 | src/renderer.js |
| `createHash` | 77 | 124 | 10 | src/main-process/background-execution/action-task-binding-registry.js |
| `monthKey` | 65 | 892 | 1 | src/main-process/read-only-exports/acquiring/actions.js |
| `startsWith` | 64 | 124 | 1 | src/main-process/toolbox-input-kind.js |
| `text` | 60 | 819 | 7 | src/backend/vcc-financial-op/row-mapper.js |
| `randomUUID` | 57 | 120 | 20 | src/backend/biz-op-recon-db/dataset-head-repository.js |
| `channel` | 52 | 519 | 1 | src/backend/position-reconciliation-import/worker-entry.js |
| `DatabaseSync` | 52 | 135 | 47 | src/backend/biz-op-recon-import/import-worker.js |
| `canonicalSha256` | 50 | 228 | 37 | src/main-process/background-execution/canary/durable-recovery.js |
| `artifact` | 46 | 986 | 1 | src/main-process/bank-bu-worker/export-operation.js |
| `sourceSnapshot` | 40 | 197 | 2 | src/main-process/bank-bu-worker/spool-writer.js |
| `fail` | 39 | 1047 | 29 | src/backend/database/recon-fix-operation-receipt-repository.js |
| `list` | 39 | 186 | 1 | src/backend/biz-op-recon-db/month-end-copy-intent-repository.js |
| `service` | 38 | 253 | 2 | src/main-process/recon-id-fix-service/worker-entry.js |
| `normalizeCell` | 38 | 220 | 20 | src/backend/balance-adjustment-store.js |
| `cancel` | 35 | 116 | 1 | src/main-process/run-check-worker-pool.js |
| `SOURCE_TYPES` | 34 | 330 | 6 | src/backend/vcc-financial-op/data-target-deletion.js |
| `canonicalJsonSnapshot` | 33 | 135 | 14 | src/main-process/background-execution/canonical-json-v1.js |
| `exactKeys` | 32 | 151 | 26 | src/backend/database/recon-fix-operation-receipt-repository.js |
| `FileValidationError` | 31 | 162 | 20 | src/backend/balance-seed-store.js |
| `errorCode` | 31 | 116 | 1 | src/main-process/background-execution/startup-recovery-coordinator.js |
| `policy` | 29 | 582 | 1 | src/main-process/bank-bu-worker/policies.js |
| `contentHash` | 29 | 157 | 1 | src/backend/vcc-financial-op/row-mapper.js |
| `finish` | 28 | 174 | 2 | src/backend/vcc-financial-op/worker-entry.js |
| `parentPort` | 28 | 157 | 27 | src/backend/big-table-import/engine-worker-entry.js |
| `XLSX` | 27 | 135 | 27 | src/backend/bank-bu-recon-import/reader.js |
| `sideDbPath` | 27 | 110 | 1 | src/backend/run-data-store.js |
| `workerData` | 25 | 106 | 14 | src/backend/vcc-financial-op/worker-entry.js |
| `freezeWorkerBatchContext` | 25 | 61 | 7 | src/main-process/archive-center/task-lifecycle.js |
| `emit` | 24 | 158 | 6 | src/backend/biz-op-recon-import/import-worker.js |
| `sourceSnapshotMatchesStat` | 24 | 72 | 4 | src/main-process/archive-center/source-snapshot.js |
| `normalize` | 24 | 49 | 1 | src/main-process/bank-bu-recon-session.js |
| `normalizeCellValue` | 23 | 304 | 12 | src/backend/database/fund-transfer-account-mapping-repository.js |
| `inspection` | 23 | 286 | 2 | src/main-process/pre-fund-reconciliation/mpt-import/outcome-inspector.js |
| `terminal` | 22 | 176 | 4 | src/main-process/background-execution/canary/pure-compute-worker.js |
| `session` | 20 | 356 | 4 | src/main-process/acquiring-bill-currency-run-data.js |
| `runDataStore` | 20 | 227 | 20 | src/backend/duplicate-inbound-match-store.js |
| `pad` | 20 | 106 | 5 | src/backend/logger.js |
| `BANK_STATEMENT_FIELDS` | 20 | 63 | 15 | src/backend/database/linked-table-repository.js |
| `sourceSnapshotFromStat` | 20 | 59 | 3 | src/main-process/archive-center/source-snapshot.js |
| `ExcelJS` | 20 | 53 | 20 | src/backend/position-reconciliation-import/anomaly-report.js |
| `active` | 19 | 249 | 1 | src/backend/position-reconciliation-import/worker-entry.js |
| `PositionReconciliationError` | 19 | 212 | 1 | src/main-process/position-reconciliation/common.js |
| `sideDbRelPath` | 19 | 92 | 1 | src/backend/run-data-store.js |
| `normalizeSourceSnapshot` | 19 | 60 | 7 | src/main-process/archive-center/source-snapshot.js |
| `repository` | 18 | 255 | 7 | src/backend/vcc-financial-op/data-target-deletion.js |
| `Worker` | 18 | 37 | 17 | src/backend/big-table-import/pipeline.js |
| `absolutePath` | 17 | 71 | 5 | src/main-process/archive-center/file-plan.js |
| `stableHash` | 17 | 69 | 4 | src/main-process/duplicate-inbound-match/service.js |
| `toProtocolError` | 17 | 58 | 17 | src/main-process/background-execution/adapters/existing-dispatch-adapter.js |
| `spoolError` | 16 | 200 | 6 | src/main-process/bank-bu-worker/spool-contract.js |
| `columnName` | 16 | 45 | 1 | src/main-process/toolbox-output-writer.js |
| `validateTaskOwnedStagingPath` | 16 | 45 | 8 | src/main-process/new-account/generation-core.js |
| `freezeWorkerOperationContext` | 16 | 33 | 5 | src/main-process/archive-center/task-lifecycle.js |
| `MAX_SAFE_INTEGER` | 16 | 27 | 1 | src/main-process/background-execution/canonical-json-v1.js |
| `appendModuleLog` | 15 | 77 | 11 | src/backend/database.js |
| `SOURCE_DEFINITIONS` | 15 | 50 | 2 | src/backend/vcc-financial-op/definitions.js |
| `open` | 15 | 39 | 1 | src/main-process/bank-bu-worker/side-database.js |
| `createDirectionSequenceTracker` | 15 | 35 | 10 | src/main-process/background-execution/canary/pure-compute-worker.js |
| `makeWarningCollector` | 15 | 30 | 4 | src/main-process/scenario-engines/boc-dispatch-order-fix.js |
| `transition` | 14 | 331 | 1 | src/main-process/background-execution/canary/packaged-runtime-runner.js |
| `assertNotCancelled` | 14 | 80 | 9 | src/backend/position-reconciliation-import/account-writer.js |
| `checkpoint` | 14 | 67 | 1 | src/main-process/new-account/artifact-copy.js |
| `assertDatabase` | 14 | 49 | 14 | src/backend/database/archive-repository.js |
| `FLOW_HEADERS` | 14 | 35 | 8 | src/backend/acquiring-bill-currency-db/columns.js |
| `validateHeaders` | 14 | 34 | 3 | src/backend/pending-import/contract-pending.js |
| `applyWatermark` | 14 | 32 | 14 | src/backend/file-service/writers.js |
| `SUPPORTED_CURRENCIES` | 13 | 63 | 4 | src/backend/vcc-financial-op/adjustment-lineage.js |
| `placeholders` | 13 | 57 | 2 | src/backend/position-reconciliation-import/maintenance-writer.js |
| `sourceIdentity` | 13 | 51 | 1 | src/backend/vcc-financial-op/source-lineage.js |
| `isDeepStrictEqual` | 13 | 41 | 13 | src/backend/database/duplicate-inbound-match-run-repository.js |
| `SOURCE_LABELS` | 13 | 41 | 3 | src/backend/vcc-financial-op/data-target-deletion.js |
| `normalizeSource` | 13 | 34 | 10 | src/main-process/bank-bu-worker/spool-contract.js |
| `getOperationReceipt` | 13 | 32 | 4 | src/backend/database/recon-fix-operation-receipt-repository.js |
| `pathsAlias` | 13 | 30 | 8 | src/main-process/new-account/generation-validator.js |
| `validateEnvelope` | 13 | 30 | 9 | src/main-process/background-execution/canary/pure-compute-worker.js |
| `createCanonicalEventEmitter` | 13 | 28 | 7 | src/main-process/background-execution/adapters/canonical-event-emitter.js |
| `getRun` | 13 | 27 | 2 | src/backend/bank-bu-recon-db/run-repository.js |
| `fromProtocolError` | 13 | 26 | 13 | src/main-process/background-execution/error-codec.js |
| `readOwnedArtifactEvidence` | 13 | 26 | 13 | src/main-process/read-only-exports/acquiring/business-validator.js |
| `readWorkbookBusinessEvidence` | 13 | 26 | 13 | src/main-process/read-only-exports/acquiring/business-validator.js |
| `validationError` | 12 | 101 | 9 | src/main-process/pre-fund-reconciliation/mpt-schema.js |
| `warningSummary` | 12 | 77 | 1 | src/main-process/statement-worker/generation.js |
| `numeric` | 12 | 59 | 1 | src/main-process/statement-generation-business.js |
| `serializeError` | 12 | 49 | 7 | src/backend/vcc-financial-op/worker-entry.js |
| `parseNumber` | 12 | 43 | 4 | src/backend/pending-reconcile/removal-match.js |
| `hex` | 12 | 36 | 1 | src/backend/toolbox-format/biff8-records.js |
| `safeError` | 12 | 30 | 3 | src/main-process/bank-bu-worker/parser-worker-entry.js |
| `openZipWithEntries` | 12 | 25 | 2 | src/backend/acquiring-bill-currency-import/reader.js |
| `RUNS_TABLE` | 11 | 89 | 10 | src/backend/acquiring-bill-currency-db/run-repository.js |
| `remove` | 11 | 83 | 1 | src/backend/biz-op-recon-db/month-end-copy-intent-repository.js |
| `requireText` | 11 | 80 | 11 | src/backend/database/duplicate-inbound-match-run-repository.js |
| `fsyncDirectory` | 11 | 66 | 8 | src/main-process/background-execution/durable-file.js |
| `abortController` | 11 | 62 | 4 | src/main-process/background-execution/canary/pure-compute-worker.js |
| `rowHash` | 11 | 57 | 1 | src/main-process/recon-id-fix-service/jpm-writeback-plan.js |
| `throwIfCancelled` | 11 | 56 | 8 | src/backend/vcc-financial-op/detail-importer.js |
| `PENDING_COLUMNS` | 11 | 40 | 11 | src/backend/pending-db/migrations.js |
| `sha256File` | 11 | 32 | 10 | src/main-process/bank-bu-worker/identity.js |
| `TOOLBOX_GENERATION_ACTIONS` | 11 | 31 | 5 | src/main-process/toolbox-background/generation-contract.js |
| `isRowMeaningful` | 11 | 30 | 2 | src/backend/file-service/common.js |
| `ZERO_RESOURCES` | 11 | 28 | 11 | src/main-process/background-execution/acquiring-adapter-policies.js |
| `sax` | 11 | 27 | 11 | src/backend/acquiring-bill-currency-import/reader.js |
| `SHA256_PATTERN` | 11 | 27 | 11 | src/backend/database/recon-fix-operation-receipt-repository.js |
| `runReconciliation` | 11 | 25 | 8 | src/backend/pending-reconcile/engine.js |
| `MODULE` | 10 | 139 | 9 | src/backend/duplicate-inbound-match-store.js |
| `runRepository` | 10 | 78 | 10 | src/backend/biz-op-recon-import/import-worker.js |
| `parseJson` | 10 | 67 | 7 | src/backend/database/duplicate-inbound-match-run-repository.js |
| `exact` | 10 | 45 | 4 | src/main-process/new-account/generation-contract.js |
| `canonicalizeJson` | 10 | 44 | 4 | src/main-process/background-execution/canary/durable-recovery.js |
| `stableJson` | 10 | 44 | 4 | src/backend/vcc-financial-op/result-template-contract.js |
| `RECON_FIX_RUN_JPM_ACTION` | 10 | 43 | 5 | src/main-process/recon-id-fix-service/jpm-hold-gate.js |
| `toDate` | 10 | 42 | 9 | src/main-process/position-reconciliation/matching-engine.js |
| `utilTypes` | 10 | 42 | 10 | src/main-process/background-execution/adapters/worker-thread-adapter.js |
| `parseNumericValue` | 10 | 41 | 3 | src/backend/balance-seed-store.js |
| `canonicalizeVccAmount` | 10 | 37 | 10 | src/backend/vcc-financial-op/amount-rules.js |
| `normalizeDate` | 10 | 34 | 4 | src/backend/vcc-financial-op/row-mapper.js |
| `canonicalizeDecimal` | 10 | 32 | 5 | src/backend/vcc-financial-op/amount-rules.js |
| `normalizeYearMonth` | 10 | 32 | 7 | src/backend/vcc-financial-op/calculator.js |
| `normalizeRecoverySource` | 10 | 31 | 6 | src/main-process/background-execution/canary/durable-recovery.js |
| `normalizeSpoolDescriptor` | 10 | 28 | 2 | src/main-process/bank-bu-worker/spool-contract.js |
| `main` | 10 | 27 | 4 | src/backend/biz-op-recon-import/import-worker.js |
| `transitionRequestKey` | 10 | 27 | 6 | src/main-process/background-execution/canary/packaged-runtime-runner.js |
| `assertJsonSafe` | 10 | 26 | 7 | src/main-process/background-execution/action-manifest.js |
| `getRunById` | 10 | 25 | 3 | src/backend/acquiring-bill-currency-db/run-repository.js |
| `importFiles` | 10 | 21 | 4 | src/backend/big-table-import/engine.js |
| `insertOperationReceipt` | 10 | 20 | 5 | src/backend/database/recon-fix-operation-receipt-repository.js |
| `validateFlowHeaders` | 10 | 20 | 8 | src/backend/acquiring-bill-currency-import/contract-flow.js |
| `deserializeError` | 10 | 19 | 4 | src/main-process/serialize-error.js |
| `openReadStream` | 10 | 16 | 1 | src/backend/vcc-financial-op/workbook-reader.js |
| `database` | 9 | 142 | 1 | src/main.js |
| `FIELD_MAP` | 9 | 114 | 8 | src/backend/database/linked-table-writeback-reader.js |
| `managedError` | 9 | 60 | 9 | src/main-process/bank-bu-worker/dual-parser-dispatch.js |
| `openSideDb` | 9 | 46 | 1 | src/backend/run-data-store.js |
| `SHA256_RE` | 9 | 35 | 9 | src/backend/database/archive-repository.js |
| `workerError` | 9 | 35 | 6 | src/main-process/read-only-exports/biz-op/writer.js |
| `normalizeHeaderRow` | 9 | 28 | 5 | src/backend/position-reconciliation-import/xlsx-reader.js |
| `bankChannel` | 9 | 27 | 1 | src/main-process/pre-fund-reconciliation/output-mapper.js |
| `FLOW_DB_COLUMNS` | 9 | 27 | 3 | src/backend/biz-op-recon-db/columns.js |
| `parseDateValue` | 9 | 27 | 2 | src/backend/file-service/normalizers.js |
| `listMonths` | 9 | 20 | 4 | src/backend/acquiring-bill-currency-db/import-repository.js |
| `validate` | 9 | 20 | 1 | src/main-process/background-execution/recovery-source.js |
| `create` | 9 | 18 | 1 | src/backend/biz-op-recon-db/month-end-copy-intent-repository.js |
| `makeModificationCollector` | 9 | 18 | 1 | src/main-process/scenario-engines/engine-utils.js |
| `incomingSequence` | 9 | 17 | 3 | src/main-process/background-execution/canary/pure-compute-worker.js |
| `saveMappings` | 9 | 17 | 2 | src/backend/database/fund-transfer-account-mapping-repository.js |
| `insertRun` | 9 | 13 | 4 | src/backend/acquiring-bill-currency-db/run-repository.js |
| `jobRef` | 8 | 108 | 3 | src/main-process/duplicate-inbound-match/worker-host.js |
| `purpose` | 8 | 65 | 1 | src/main-process/statement-worker/contracts.js |
| `operationError` | 8 | 56 | 3 | src/backend/vcc-financial-op/operation-audit.js |
| `scopeKey` | 8 | 52 | 1 | src/main-process/position-reconciliation/store.js |
| `POSITION_IMPORT_COMMANDS` | 8 | 51 | 1 | src/backend/position-reconciliation-import/constants.js |
| `startEnvelope` | 8 | 40 | 3 | src/main-process/background-execution/canary/pure-compute-worker.js |
| `cancelRequested` | 8 | 36 | 2 | src/backend/vcc-financial-op/worker-entry.js |
| `targetSnapshot` | 8 | 30 | 2 | src/main-process/archive-center/file-plan.js |
| `VCC_EXPORT_SUBJECTS_ACTION` | 8 | 30 | 3 | src/main-process/vcc-financial-op-output/policies.js |
| `headersEqual` | 8 | 28 | 4 | src/backend/position-reconciliation-import/xlsx-reader.js |
| `FT_RECON_FIELD_MAP` | 8 | 24 | 6 | src/backend/database/linked-table-repository.js |
| `os` | 8 | 24 | 7 | src/backend/big-table-import/pipeline.js |
| `readDatabaseLocalTimestamp` | 8 | 19 | 3 | src/backend/vcc-financial-op/calculator.js |
| `getMonthMeta` | 8 | 18 | 2 | src/backend/bank-bu-recon-db/month-repository.js |
| `normalizeDateExportValue` | 8 | 18 | 6 | src/backend/database/linked-table-repository.js |
| `withReadSnapshot` | 8 | 18 | 4 | src/main-process/read-only-exports/pending/query.js |
| `readRows` | 8 | 16 | 4 | src/backend/bank-account-import.js |
| `acknowledgeArchiveTerminal` | 8 | 15 | 3 | src/backend/biz-op-recon-db/run-repository.js |
| `hasOperationReceiptTable` | 8 | 15 | 4 | src/backend/database/recon-fix-operation-receipt-repository.js |
| `mapRow` | 8 | 14 | 2 | src/backend/pending-import/removed-reader.js |
| `createRun` | 8 | 11 | 1 | src/backend/pending-db/diff-repository.js |
| `dialog` | 7 | 613 | 1 | src/main.js |
| `boundedText` | 7 | 62 | 7 | src/main-process/archive-center/target-parent-identity.js |
| `localName` | 7 | 44 | 3 | src/backend/toolbox-format/style-registry.js |
| `stableStringify` | 7 | 39 | 3 | src/backend/vcc-financial-op/operation-state.js |
| `isPlainObject` | 7 | 33 | 7 | src/main-process/archive-center/target-parent-identity.js |
| `receiptRepository` | 7 | 32 | 7 | src/main-process/bank-bu-worker/main-coordinator.js |
| `deepFreeze` | 7 | 30 | 7 | src/backend/toolbox-format/style-registry.js |
| `operations` | 7 | 28 | 1 | src/backend/vcc-financial-op/mutation-policy.js |
| `BILL_HEADERS` | 7 | 27 | 7 | src/backend/acquiring-bill-currency-db/columns.js |
| `subjectDigest` | 7 | 24 | 1 | src/main-process/vcc-financial-op-output/subject-evidence.js |
| `ACQUIRING_EXPORT_ACTIONS` | 7 | 23 | 2 | src/main-process/read-only-exports/acquiring/policies.js |
| `sideDbExists` | 7 | 23 | 1 | src/backend/run-data-store.js |
| `normalizeContext` | 7 | 20 | 6 | src/main-process/read-only-exports/acquiring/actions.js |
| `operationContextFromBatch` | 7 | 20 | 7 | src/main-process/read-only-exports/acquiring/managed-export.js |
| `listSideDbFiles` | 7 | 19 | 1 | src/backend/run-data-store.js |
| `normalizeEvidence` | 7 | 19 | 6 | src/main-process/read-only-exports/acquiring/actions.js |
| `BANK_DB_COLUMNS` | 7 | 16 | 1 | src/backend/bank-bu-recon-db/columns.js |
| `GATEWAY_BILL_FIELDS` | 7 | 16 | 4 | src/constants/adm-bank-deposit-fields.js |
| `PENDING_GUANLI_DB_COLUMNS` | 7 | 16 | 1 | src/backend/bank-bu-recon-db/columns.js |
| `extractHeaders` | 7 | 14 | 3 | src/main-process/new-account/generation-core.js |
| `isMainThread` | 7 | 14 | 7 | src/backend/big-table-import/engine-worker-entry.js |
| `MODULE_BANK_BU` | 7 | 14 | 1 | src/backend/run-data-store.js |
| `normalizeReadOnlyExportInput` | 7 | 14 | 1 | src/main-process/read-only-exports/common/contract.js |
| `startReadOnlyExportWorker` | 7 | 14 | 7 | src/main-process/read-only-exports/acquiring/worker-entry.js |
| `createContract` | 7 | 13 | 4 | src/backend/acquiring-bill-currency-import/contract-bill.js |
| `getRunByArchiveTaskRunId` | 7 | 13 | 2 | src/backend/biz-op-recon-db/run-repository.js |
| `normalizeFilePlanV1` | 7 | 13 | 3 | src/main-process/archive-center/file-plan.js |
| `JSZip` | 7 | 12 | 7 | src/backend/biz-op-recon-import/reader-streamed.js |
| `scanSheet` | 7 | 12 | 2 | src/backend/toolbox-format/biff8-records.js |
| `sanitizeFileName` | 7 | 10 | 6 | src/backend/balance-seed-store.js |
| `elements` | 6 | 261 | 1 | src/renderer.js |
| `activeJob` | 6 | 152 | 2 | src/main-process/recon-id-fix-service/worker-entry.js |
| `requiredText` | 6 | 115 | 6 | src/backend/database/archive-repository.js |
| `sourceError` | 6 | 92 | 6 | src/main-process/read-only-exports/acquiring/query.js |
| `VCC_MUTATION_OPERATIONS` | 6 | 81 | 1 | src/backend/vcc-financial-op/mutation-policy.js |
| `assertExactKeys` | 6 | 52 | 5 | src/main-process/background-execution/resource-lease.js |
| `app` | 6 | 45 | 1 | src/main.js |
| `invalid` | 6 | 31 | 1 | src/main-process/statement-worker/staging-ownership.js |
| `dependentMonths` | 6 | 30 | 1 | src/backend/vcc-financial-op/unarchive-gate.js |
| `positiveInteger` | 6 | 30 | 6 | src/main-process/new-account/strict-worksheet-readback.js |
| `serializeJson` | 6 | 30 | 1 | src/main-process/position-reconciliation/store.js |
| `cancellationError` | 6 | 29 | 3 | src/main-process/background-execution/adapters/position-import-adapter.js |
| `logger` | 6 | 28 | 3 | src/main-process/biz-op-recon-session.js |
| `monthOf` | 6 | 28 | 2 | src/main-process/biz-op-recon-run-data.js |
| `RECEIPTS_TABLE` | 6 | 28 | 5 | src/backend/database/recon-fix-operation-receipt-repository.js |
| `cellValue` | 6 | 26 | 2 | src/main-process/position-reconciliation/filtered-source-report.js |
| `reconFixEvidenceSha256` | 6 | 25 | 4 | src/main-process/recon-id-fix-service/artifact-evidence.js |
| `namespaceAllowed` | 6 | 23 | 1 | src/backend/toolbox-format/ooxml-namespaces.js |
| `rollbackQuietly` | 6 | 23 | 6 | src/backend/duplicate-inbound-match-store.js |
| `normalizePositionCheckpoint` | 6 | 22 | 1 | src/main-process/position-reconciliation/side-db-mutation.js |
| `targetParentIdentity` | 6 | 22 | 1 | src/main-process/archive-center/file-plan.js |
| `MAX_COLLECTED_ERRORS` | 6 | 21 | 5 | src/backend/acquiring-bill-currency-import/contract-bill.js |
| `BANK_SHEET_NAME` | 6 | 20 | 1 | src/main-process/position-reconciliation/constants.js |
| `cloneRowsWithMetadata` | 6 | 20 | 1 | src/main-process/statement-session.js |
| `POSITION_BANK_HEADERS` | 6 | 20 | 1 | src/main-process/position-reconciliation/constants.js |
| `getHead` | 6 | 19 | 1 | src/backend/biz-op-recon-db/dataset-head-repository.js |
| `outputPlanHash` | 6 | 19 | 2 | src/main-process/toolbox-background/multi-output-validator.js |
| `positionCheckpointsEqual` | 6 | 19 | 1 | src/main-process/position-reconciliation/side-db-mutation.js |
| `BIZ_OP_DB_COLUMNS` | 6 | 18 | 2 | src/backend/biz-op-recon-db/columns.js |
| `syncDirectory` | 6 | 18 | 2 | src/main-process/archive-center/storage-materializer.js |
| `listRunMirrors` | 6 | 17 | 2 | src/backend/database/duplicate-inbound-match-run-repository.js |
| `splitTemplateName` | 6 | 17 | 2 | src/backend/database/own-accounts-migration.js |
| `SPREADSHEETML_NAMESPACES` | 6 | 17 | 1 | src/backend/toolbox-format/ooxml-namespaces.js |
| `addCanonicalDecimals` | 6 | 16 | 2 | src/main-process/financial-decimal.js |
| `assertPositionLargeImportSchema` | 6 | 16 | 1 | src/main-process/position-reconciliation/large-import-schema.js |
| `MS_PER_DAY` | 6 | 16 | 6 | src/main-process/scenario-engines/dbs-charge-fund-check.js |
| `VALID_DIRECTION_IN` | 6 | 16 | 4 | src/backend/biz-op-recon-import/validator.js |
| `requireMonth` | 6 | 15 | 6 | src/main-process/bank-bu-worker/identity.js |
| `shutdown` | 6 | 15 | 1 | src/main-process/run-check-worker-pool.js |
| `subtractCanonicalDecimals` | 6 | 15 | 1 | src/main-process/financial-decimal.js |
| `listChannels` | 6 | 14 | 1 | src/backend/database/channels-repository.js |
| `normalizeOperationIdentity` | 6 | 14 | 6 | src/main-process/bank-bu-worker/identity.js |
| `resolveTaskStagingResource` | 6 | 14 | 2 | src/main-process/new-account/generation-contract.js |
| `runPositionSideDbMutation` | 6 | 14 | 1 | src/main-process/position-reconciliation/side-db-mutation.js |
| `validatePrivateSpoolDirectory` | 6 | 14 | 4 | src/main-process/bank-bu-worker/spool-filesystem.js |
| `assertPreservedOperationState` | 6 | 13 | 1 | src/backend/vcc-financial-op/preserved-state.js |
| `deriveFileIdentity` | 6 | 13 | 4 | src/main-process/pre-fund-reconciliation/mpt-import/managed-import.js |
| `formatTimestamp` | 6 | 13 | 6 | src/backend/database/backup.js |
| `getImportRecord` | 6 | 13 | 1 | src/backend/vcc-financial-op-db/repository.js |
| `VALID_DIRECTION_OUT` | 6 | 13 | 4 | src/backend/biz-op-recon-import/validator.js |
| `createServiceControlEnvelope` | 6 | 12 | 3 | src/main-process/background-execution/protocol.js |
| `ensurePrivateSpoolDirectory` | 6 | 12 | 2 | src/main-process/bank-bu-worker/spool-filesystem.js |
| `getEffectiveRunResult` | 6 | 12 | 4 | src/backend/vcc-financial-op/operation-audit.js |
| `loadSharedStrings` | 6 | 12 | 1 | src/backend/acquiring-bill-currency-import/reader.js |
| `moduleDir` | 6 | 12 | 1 | src/backend/run-data-store.js |
| `scanSheetRows` | 6 | 12 | 4 | src/backend/big-table-import/row-scanner.js |
| `startToolboxGenerationWorker` | 6 | 12 | 6 | src/main-process/toolbox-background/merge-worker-entry.js |
| `TextDecoder` | 6 | 12 | 6 | src/backend/position-reconciliation-import/shared-strings-provider.js |
| `trimTrailingEmptyCells` | 6 | 12 | 1 | src/backend/file-service/common.js |
| `writeBalanceWorkbook` | 6 | 12 | 3 | src/backend/file-service.js |
| `getStatementSessionEntries` | 6 | 11 | 1 | src/main-process/statement-session.js |
| `deleteSideDbByPath` | 6 | 10 | 1 | src/backend/run-data-store.js |
| `getLatestRun` | 6 | 10 | 2 | src/backend/acquiring-bill-currency-db/run-repository.js |
| `readBankStatement` | 6 | 10 | 4 | src/main-process/bank-statement-io.js |
| `resolveFromRel` | 6 | 10 | 1 | src/backend/run-data-store.js |
| `listMappings` | 6 | 9 | 1 | src/backend/database/fund-transfer-account-mapping-repository.js |
| `listUnacknowledgedArchiveRuns` | 6 | 8 | 2 | src/backend/biz-op-recon-db/run-repository.js |
| `escapeHtml` | 5 | 302 | 1 | src/renderer.js |
| `shell` | 5 | 92 | 1 | src/main.js |
| `setCurrentModule` | 5 | 70 | 2 | src/backend/database/settings-repository.js |
| `inputError` | 5 | 64 | 5 | src/main-process/read-only-exports/acquiring/actions.js |
| `safeCount` | 5 | 58 | 5 | src/main-process/background-execution/acquiring-adapter-policies.js |
| `processingResult` | 5 | 56 | 1 | src/main.js |
| `columnNumber` | 5 | 54 | 1 | src/main-process/new-account/strict-worksheet-readback.js |
| `runRepo` | 5 | 49 | 5 | src/main-process/acquiring-bill-currency-run-data.js |
| `targetPathAliasKey` | 5 | 44 | 1 | src/main-process/toolbox-target-identity.js |
| `lastGeneratedExports` | 5 | 43 | 1 | src/main.js |
| `normalizeBu` | 5 | 34 | 3 | src/main-process/bank-bu-recon-session.js |
| `observationScopeKey` | 5 | 34 | 1 | src/main-process/background-execution/recovery-control-contract.js |
| `tableColumns` | 5 | 31 | 5 | src/backend/vcc-financial-op-db/migrations.js |
| `getSetting` | 5 | 28 | 1 | src/backend/database/settings-repository.js |
| `monthRepository` | 5 | 28 | 4 | src/main-process/bank-bu-recon-run-data.js |
| `openExistingSideDb` | 5 | 28 | 1 | src/backend/run-data-store.js |
| `stableSummary` | 5 | 28 | 1 | src/main-process/fund-recon-worker/service.js |
| `bumpRevision` | 5 | 27 | 4 | src/backend/position-reconciliation-import/account-writer.js |
| `json` | 5 | 22 | 1 | src/backend/position-reconciliation-import/ledger.js |
| `MAX_DATA_ROWS_PER_SHEET` | 5 | 22 | 5 | src/main-process/acquiring-bill-currency-writer.js |
| `PENDING_READ_ONLY_ACTIONS` | 5 | 22 | 1 | src/main-process/read-only-exports/pending/policies.js |
| `TOOLBOX_GENERATION_SCHEMA_VERSION` | 5 | 22 | 1 | src/main-process/toolbox-background/generation-contract.js |
| `checkedAdd` | 5 | 21 | 4 | src/main-process/background-execution/resource-lease.js |
| `RECON_FIX_EXPORT_ACTION` | 5 | 21 | 1 | src/main-process/recon-id-fix-service/policies.js |
| `yieldToEventLoop` | 5 | 21 | 3 | src/backend/position-reconciliation-import/maintenance-writer.js |
| `PENDING_HEADERS` | 5 | 20 | 1 | src/backend/vcc-financial-op/definitions.js |
| `tableHasColumn` | 5 | 20 | 5 | src/backend/vcc-financial-op/destructive-write.js |
| `VCC_EXPORT_SINGLE_ACTION` | 5 | 20 | 2 | src/main-process/vcc-financial-op-output/policies.js |
| `DUPLICATE_INPUT_ROLES` | 5 | 19 | 1 | src/main-process/duplicate-inbound-match/spool-contract.js |
| `MAX_TIMER_DELAY_MS` | 5 | 19 | 4 | src/main-process/background-execution/admission-queue.js |
| `MEBIBYTE` | 5 | 19 | 5 | src/main-process/background-execution/resource-budget.js |
| `BANK_BU_INPUT_ROLES` | 5 | 18 | 1 | src/main-process/bank-bu-worker/spool-contract.js |
| `normalizeHeaderCell` | 5 | 18 | 4 | src/backend/acquiring-bill-currency-import/validator.js |
| `ARCHIVE_CONTRACTS` | 5 | 17 | 2 | src/backend/vcc-financial-op/archive-contract.js |
| `EXCEL_MAX_ROWS` | 5 | 17 | 4 | src/backend/position-reconciliation-import/anomaly-report.js |
| `CancelError` | 5 | 16 | 3 | src/backend/big-table-import/engine.js |
| `controller` | 5 | 16 | 3 | src/main-process/bank-bu-worker/parser-worker-entry.js |
| `fileSha256` | 5 | 15 | 1 | src/main-process/statement-worker/artifact-descriptor.js |
| `getSourceDefinition` | 5 | 15 | 1 | src/backend/vcc-financial-op/definitions.js |
| `hashFileSha256Async` | 5 | 15 | 1 | src/main-process/position-reconciliation/input-staging.js |
| `inferDateCellFormat` | 5 | 15 | 1 | src/backend/file-service/normalizers.js |
| `normalizeJobId` | 5 | 15 | 3 | src/main-process/bank-bu-worker/spool-contract.js |
| `TEMPLATE_BILL_HEADERS` | 5 | 15 | 4 | src/backend/acquiring-bill-currency-db/columns.js |
| `valuesEqual` | 5 | 15 | 1 | src/main-process/scenario-engines/engine-utils.js |
| `WATERMARK_AUTHOR` | 5 | 15 | 5 | src/main-process/pre-fund-reconciliation/excel-writer.js |
| `assertFilePlanFresh` | 5 | 14 | 2 | src/main-process/archive-center/file-plan.js |
| `bounded` | 5 | 14 | 1 | src/main-process/background-execution/recovery-control-contract.js |
| `MPT_SCHEMAS` | 5 | 14 | 3 | src/main-process/pre-fund-reconciliation/mpt-import/file-result-safety.js |
| `absoluteDecimal` | 5 | 13 | 2 | src/main-process/financial-decimal.js |
| `bankBuSpoolPaths` | 5 | 13 | 1 | src/main-process/bank-bu-worker/spool-contract.js |
| `BIZ_OP_HEADERS` | 5 | 13 | 1 | src/backend/biz-op-recon-db/columns.js |
| `dayDiffWithin` | 5 | 13 | 5 | src/main-process/scenario-engines/dbs-charge-fund-check.js |
| `duplicateSpoolPaths` | 5 | 13 | 1 | src/main-process/duplicate-inbound-match/spool-contract.js |
| `extractMonthKey` | 5 | 13 | 5 | src/backend/acquiring-bill-currency-import/contract-bill.js |
| `hashFile` | 5 | 13 | 5 | src/main-process/archive-center/storage-materializer.js |
| `insertOperationAudit` | 5 | 13 | 1 | src/backend/vcc-financial-op/operation-audit.js |
| `observationRequestKey` | 5 | 13 | 1 | src/main-process/background-execution/recovery-control-contract.js |
| `pipeline` | 5 | 13 | 5 | src/backend/big-table-import/engine.js |
| `refreshPositionSourceSummary` | 5 | 13 | 1 | src/main-process/position-reconciliation/source-summary-cache.js |
| `assertExcelCellTextLength` | 5 | 12 | 1 | src/backend/toolbox-format/excel-text.js |
| `assertPositionImportDiskSpace` | 5 | 12 | 1 | src/backend/position-reconciliation-import/disk-space-gate.js |
| `assertSuccessOperationAudit` | 5 | 12 | 1 | src/backend/vcc-financial-op/operation-audit.js |
| `collectRunEvidence` | 5 | 12 | 1 | src/backend/vcc-financial-op/operation-audit.js |
| `normalizeTargetAliasKey` | 5 | 12 | 3 | src/main-process/statement-worker/artifact-descriptor.js |
| `persistRolledBackAudit` | 5 | 12 | 1 | src/backend/vcc-financial-op/operation-audit.js |
| `positionLargeImportSchemaFingerprint` | 5 | 12 | 1 | src/main-process/position-reconciliation/large-import-schema.js |
| `SHARED_STRINGS_ENTRY_NAME` | 5 | 12 | 3 | src/backend/acquiring-bill-currency-import/reader.js |
| `validateBankDirection` | 5 | 12 | 4 | src/main-process/scenario-engines/bank-direction-validator.js |
| `validateJobEnvelope` | 5 | 12 | 1 | src/main-process/background-execution/protocol-validator.js |
| `validateOperationConfirmation` | 5 | 12 | 1 | src/backend/vcc-financial-op/operation-state.js |
| `writeWorkbookRows` | 5 | 12 | 2 | src/backend/file-service.js |
| `createSchemaValidator` | 5 | 11 | 4 | src/main-process/background-execution/execution-policy-registry.js |
| `deriveLinkedRowsForRecord` | 5 | 11 | 1 | src/main-process/position-reconciliation/derivation.js |
| `ensureBackgroundExecutionRecoveryControlSchema` | 5 | 11 | 1 | src/backend/database/background-execution-schema.js |
| `evaluateCondition` | 5 | 11 | 1 | src/main-process/scenario-engines/engine-utils.js |
| `isValidInputFingerprint` | 5 | 11 | 3 | src/backend/vcc-financial-op/archive-contract.js |
| `normalizeDualImportDescriptor` | 5 | 11 | 3 | src/main-process/bank-bu-worker/import-operation.js |
| `normalizeExactOperationReceipt` | 5 | 11 | 3 | src/main-process/bank-bu-worker/operation-receipt-repository.js |
| `normalizeFileIndex` | 5 | 11 | 3 | src/main-process/pre-fund-reconciliation/mpt-import/ordered-coordinator.js |
| `normalizePairedImportDescriptor` | 5 | 11 | 2 | src/main-process/duplicate-inbound-match/spool-contract.js |
| `POSITION_IMPORT_PROGRESS_ROW_INTERVAL` | 5 | 11 | 1 | src/backend/position-reconciliation-import/constants.js |
| `sameDay` | 5 | 11 | 5 | src/main-process/scenario-engines/dbs-charge-fund-check.js |
| `StableArrayHashAccumulator` | 5 | 11 | 1 | src/backend/position-reconciliation-import/contracts.js |
| `streamFlowFile` | 5 | 11 | 5 | src/backend/biz-op-recon-import/import-worker.js |
| `WORKBOOK_ENTRY_NAME` | 5 | 11 | 1 | src/backend/big-table-import/zip-reader.js |
| `COMMITTED_AT_PATTERN` | 5 | 10 | 5 | src/backend/database/recon-fix-operation-receipt-repository.js |
| `createRecoveryControlReadRepository` | 5 | 10 | 1 | src/main-process/background-execution/critical/recovery-control-read-repository.js |
| `createToolboxCell` | 5 | 10 | 1 | src/backend/toolbox-format/model.js |
| `createToolboxRow` | 5 | 10 | 1 | src/backend/toolbox-format/model.js |
| `createToolboxSheetMeta` | 5 | 10 | 1 | src/backend/toolbox-format/model.js |
| `ensureRowId` | 5 | 10 | 1 | src/main-process/scenario-engines/engine-utils.js |
| `generationEvidencePath` | 5 | 10 | 1 | src/main-process/toolbox-background/generation-contract.js |
| `isBlankRow` | 5 | 10 | 1 | src/main-process/position-reconciliation/common.js |
| `isValidTaskStagingResourceId` | 5 | 10 | 4 | src/main-process/new-account/generation-contract.js |
| `LINK_HEADERS` | 5 | 10 | 1 | src/main-process/position-reconciliation/constants.js |
| `listRuns` | 5 | 10 | 2 | src/backend/bank-bu-recon-db/run-repository.js |
| `locateSheets` | 5 | 10 | 1 | src/backend/big-table-import/zip-reader.js |
| `normalizedSaxAttributes` | 5 | 10 | 1 | src/backend/toolbox-format/ooxml-namespaces.js |
| `normalizeFundTransferDatePolicy` | 5 | 10 | 3 | src/main-process/scenario-engines/dbs-charge-fund-check.js |
| `ORDER_REPAIR_FIELDS_GATEWAY` | 5 | 10 | 3 | src/constants/gateway-bill-recon-fields.js |
| `verifySealedLedger` | 5 | 10 | 1 | src/backend/position-reconciliation-import/ledger.js |
| `writeDiffWorkbook` | 5 | 10 | 3 | src/main-process/acquiring-bill-currency-writer.js |
| `readRowsWithMetadata` | 5 | 8 | 1 | src/backend/file-service/readers.js |
| `deleteTemplate` | 5 | 7 | 1 | src/backend/database/template-repository.js |
| `updateRunExportPath` | 5 | 7 | 2 | src/backend/bank-bu-recon-db/run-repository.js |
| `deleteSideDb` | 5 | 6 | 1 | src/backend/run-data-store.js |
| `normalizeText` | 4 | 97 | 3 | src/backend/database/migrations.js |
| `setStatus` | 4 | 91 | 1 | src/renderer.js |
| `trimCell` | 4 | 65 | 3 | src/main-process/pre-fund-reconciliation/bank-row.js |
| `coordinatorError` | 4 | 58 | 4 | src/main-process/bank-bu-worker/main-coordinator.js |
| `scan` | 4 | 54 | 1 | src/main-process/vcc-op-calc-session.js |
| `step` | 4 | 54 | 1 | src/backend/vcc-financial-op/mutation-policy.js |
| `linkedTableRepository` | 4 | 52 | 4 | src/backend/database.js |
| `countRows` | 4 | 50 | 4 | src/backend/vcc-financial-op/destructive-write.js |
| `checkedMultiply` | 4 | 30 | 3 | src/main-process/background-execution/resource-lease.js |
| `datasetHeadRepository` | 4 | 30 | 4 | src/backend/biz-op-recon-import/import-worker.js |
| `reportError` | 4 | 28 | 2 | src/backend/position-reconciliation-import/anomaly-report.js |
| `setSetting` | 4 | 28 | 1 | src/backend/database/settings-repository.js |
| `sourceKey` | 4 | 28 | 1 | src/main-process/background-execution/startup-recovery-coordinator.js |
| `SYSTEM_OP_HEADERS` | 4 | 28 | 1 | src/backend/vcc-financial-op/definitions.js |
| `centsToAmountString` | 4 | 27 | 1 | src/main-process/vcc-op-calc/parser-core.js |
| `emitProgress` | 4 | 27 | 4 | src/backend/position-reconciliation-import/maintenance-writer.js |
| `getStatus` | 4 | 26 | 1 | src/main-process/run-check-worker-pool.js |
| `pad2` | 4 | 26 | 4 | src/backend/usage-stats.js |
| `nonEmptyText` | 4 | 24 | 2 | src/main-process/read-only-exports/common/contract.js |
| `CANONICAL_ACTION_KEYS` | 4 | 23 | 3 | src/main-process/background-execution/action-manifest.js |
| `MATCH_TYPES` | 4 | 23 | 1 | src/main-process/position-reconciliation/constants.js |
| `ACQUIRING_ADAPTER_ACTIONS` | 4 | 22 | 1 | src/main-process/background-execution/acquiring-adapter-policies.js |
| `FIXED_FIELD_VALUE_PREFIX` | 4 | 21 | 2 | src/backend/database/utils.js |
| `importsRepository` | 4 | 21 | 4 | src/backend/biz-op-recon-import/import-worker.js |
| `PRESERVED_OPERATIONS` | 4 | 21 | 1 | src/backend/vcc-financial-op/preserved-state.js |
| `SHA256` | 4 | 21 | 4 | src/main-process/new-account/artifact-copy.js |
| `isCanonicalFundTransferOwner` | 4 | 19 | 1 | src/main-process/fund-transfer-date-policy.js |
| `numericValue` | 4 | 19 | 1 | src/main-process/new-account/strict-worksheet-readback.js |
| `POSITION_IMPORT_ADAPTER_ACTION` | 4 | 19 | 1 | src/main-process/background-execution/position-import-adapter-policy.js |
| `TOOLBOX_SHEET_STRATEGIES` | 4 | 19 | 2 | src/main-process/toolbox-background/route-db-sealer.js |
| `importRepo` | 4 | 18 | 4 | src/backend/acquiring-bill-currency-import/reader-handrolled.js |
| `nextId` | 4 | 18 | 1 | src/main-process/recon-id-fix-service/worker-entry.js |
| `parseObjectJson` | 4 | 18 | 4 | src/backend/database/archive-repository.js |
| `RECON_FIX_JPM_UNIT_ID` | 4 | 18 | 1 | src/main-process/recon-id-fix-service/policies.js |
| `textValue` | 4 | 18 | 1 | src/main-process/statement-worker/artifact-descriptor.js |
| `DUPLICATE_ACTIONS` | 4 | 17 | 2 | src/main-process/duplicate-inbound-match/managed-service.js |
| `MERCHANT_ID_SELF_INPUT_OPTION` | 4 | 17 | 2 | src/main.js |
| `mirrorRepository` | 4 | 17 | 4 | src/main-process/duplicate-inbound-match/mirror-database.js |
| `POSITION_IMPORT_ENGINES` | 4 | 17 | 1 | src/backend/position-reconciliation-import/constants.js |
| `writeErrorReport` | 4 | 17 | 1 | src/main-process/exceljs-writer.js |
| `normalizeReceiptPayload` | 4 | 16 | 4 | src/backend/database/recon-fix-operation-receipt-repository.js |
| `readPositionDatabaseCheckpoint` | 4 | 16 | 1 | src/main-process/position-reconciliation/side-db-mutation.js |
| `recoveryHoldGate` | 4 | 15 | 1 | src/main.js |
| `SOURCE_TYPE_INBOUND` | 4 | 15 | 1 | src/main-process/pre-fund-reconciliation/mpt-schema.js |
| `YELLOW_FILL` | 4 | 15 | 4 | src/main-process/bank-bu-recon-writer.js |
| `BALANCE_CALCULATED_OPTION` | 4 | 14 | 2 | src/main.js |
| `channelsRepository` | 4 | 14 | 4 | src/backend/database.js |
| `DELETE_TARGET_LABELS` | 4 | 14 | 2 | src/backend/vcc-financial-op/data-target-deletion.js |
| `OFFICE_RELATIONSHIP_NAMESPACES` | 4 | 14 | 2 | src/backend/toolbox-format/ooxml-namespaces.js |
| `STATE_CHANGED_CODE` | 4 | 14 | 1 | src/backend/vcc-financial-op/operation-state.js |
| `STATE_CHANGED_MESSAGE` | 4 | 14 | 1 | src/backend/vcc-financial-op/operation-state.js |
| `ADM_TABLE` | 4 | 13 | 2 | src/backend/database/linked-table-repository.js |
| `BIZ_OP_READ_ONLY_ACTIONS` | 4 | 13 | 2 | src/main-process/read-only-exports/biz-op/policies.js |
| `createStaticRegistry` | 4 | 13 | 1 | src/main-process/background-execution/execution-policy-registry.js |
| `DecimalAccumulator` | 4 | 13 | 3 | src/backend/vcc-financial-op/calculator.js |
| `financeSafeTextViolation` | 4 | 13 | 2 | src/main-process/background-execution/error-codec.js |
| `formatDateLabel` | 4 | 13 | 3 | src/main-process/manual-balance-seed-preflight.js |
| `getRunChunkProgress` | 4 | 13 | 1 | src/backend/acquiring-bill-currency-db/run-repository.js |
| `normalizeInputFilePaths` | 4 | 13 | 1 | src/main-process/statement-session.js |
| `normalizeOperationMonth` | 4 | 13 | 1 | src/backend/vcc-financial-op/operation-state.js |
| `rowValues` | 4 | 13 | 3 | src/main-process/duplicate-inbound-match/excel-writer.js |
| `snapshotPreservedOperationState` | 4 | 13 | 1 | src/backend/vcc-financial-op/preserved-state.js |
| `toExcelSerial` | 4 | 13 | 1 | src/backend/file-service/normalizers.js |
| `validateResourceVector` | 4 | 13 | 3 | src/main-process/background-execution/resource-lease.js |
| `BANK_STATUSES` | 4 | 12 | 1 | src/main-process/position-reconciliation/constants.js |
| `BILL_KEY_COLUMN_INDICES` | 4 | 12 | 4 | src/backend/acquiring-bill-currency-db/columns.js |
| `buildOperationState` | 4 | 12 | 1 | src/backend/vcc-financial-op/operation-state.js |
| `dayDiffAbs` | 4 | 12 | 1 | src/main-process/scenario-engines/r5-payment-offline-allocation-backfill.js |
| `DETAIL_SOURCE_TYPES` | 4 | 12 | 3 | src/backend/vcc-financial-op/dataset-deletion.js |
| `getLinkedTableMeta` | 4 | 12 | 1 | src/backend/database/linked-table-repository.js |
| `getRunMirror` | 4 | 12 | 2 | src/backend/database/duplicate-inbound-match-run-repository.js |
| `policyByAction` | 4 | 12 | 1 | src/main-process/background-execution/coverage-check.js |
| `readEntryAsString` | 4 | 12 | 1 | src/backend/big-table-import/zip-reader.js |
| `sanitizeSheetName` | 4 | 12 | 4 | src/backend/pending-export/writer.js |
| `VCC_EXPORT_SUBJECTS_MAX_WRITERS` | 4 | 12 | 2 | src/main-process/vcc-financial-op-output/policies.js |
| `ADVANCED_MAPPING_FIELDS` | 4 | 11 | 2 | src/main.js |
| `applyHeaderRowFont` | 4 | 11 | 3 | src/backend/file-service/writers.js |
| `FLOW_KEY_COLUMN_INDICES` | 4 | 11 | 4 | src/backend/acquiring-bill-currency-db/columns.js |
| `mptSpoolPaths` | 4 | 11 | 2 | src/main-process/pre-fund-reconciliation/mpt-import/parser-outcome.js |
| `normalizeTransactionNo` | 4 | 11 | 4 | src/backend/database/linked-table-repository.js |
| `parseMptFileName` | 4 | 11 | 2 | src/main-process/pre-fund-reconciliation/mpt-import/file-result-safety.js |
| `PENDING_V1_HEADERS` | 4 | 11 | 1 | src/backend/vcc-financial-op/definitions.js |
| `readAdmRowsForWriteback` | 4 | 11 | 1 | src/backend/database/linked-table-writeback-reader.js |
| `safeMptFileName` | 4 | 11 | 2 | src/main-process/pre-fund-reconciliation/mpt-import/file-result-safety.js |
| `sameReceiptPayload` | 4 | 11 | 4 | src/backend/database/recon-fix-operation-receipt-repository.js |
| `STAGING_RELATIVE_PATH` | 4 | 11 | 1 | src/main-process/position-reconciliation/input-staging.js |
| `streamToolboxTables` | 4 | 11 | 2 | src/main-process/toolbox-background/route-db-sealer.js |
| `ACQUIRING_EXPORT_ACTION_SET` | 4 | 10 | 2 | src/main-process/read-only-exports/acquiring/managed-export.js |
| `assertPreviewToken` | 4 | 10 | 1 | src/backend/vcc-financial-op/operation-state.js |
| `AUDIT_HEADERS` | 4 | 10 | 1 | src/main-process/position-reconciliation/constants.js |
| `BANK_BU_SPOOL_SCHEMA_VERSION` | 4 | 10 | 1 | src/main-process/bank-bu-worker/spool-contract.js |
| `BIZ_OP_READ_ONLY_ACTION_SET` | 4 | 10 | 2 | src/main-process/read-only-exports/biz-op/policies.js |
| `CHANNEL_BILL_FIELDS` | 4 | 10 | 2 | src/constants/gateway-bill-recon-fields.js |
| `createChannel` | 4 | 10 | 2 | src/backend/database/channels-repository.js |
| `DUPLICATE_SPOOL_SCHEMA_VERSION` | 4 | 10 | 1 | src/main-process/duplicate-inbound-match/spool-contract.js |
| `emptyStats` | 4 | 10 | 1 | src/backend/position-reconciliation-import/preflight.js |
| `ensureBizOpReconTablesSupport` | 4 | 10 | 4 | src/backend/biz-op-recon-db/migrations.js |
| `exactSaxLocalName` | 4 | 10 | 1 | src/backend/toolbox-format/ooxml-namespaces.js |
| `freezePersistedTaskOwner` | 4 | 10 | 1 | src/main-process/archive-center/worker-operation-context.js |
| `NEW_ACCOUNT_GENERATION_ACTION` | 4 | 10 | 3 | src/main-process/new-account/generation-contract.js |
| `performance` | 4 | 10 | 3 | src/backend/startup-phase.js |
| `POSITION_IMPORT_PROTOCOL_VERSION` | 4 | 10 | 1 | src/backend/position-reconciliation-import/constants.js |
| `PRE_FUND_READ_ONLY_ACTION_SET` | 4 | 10 | 2 | src/main-process/read-only-exports/pre-fund/policies.js |
| `PRE_FUND_READ_ONLY_ACTIONS` | 4 | 10 | 1 | src/main-process/read-only-exports/pre-fund/policies.js |
| `readerFor` | 4 | 10 | 1 | src/backend/position-reconciliation-import/preflight.js |
| `TOOLBOX_GENERATION_EVIDENCE_MAX_BYTES` | 4 | 10 | 1 | src/main-process/toolbox-background/generation-contract.js |
| `ToolboxHeaderMismatchError` | 4 | 10 | 4 | src/backend/toolbox-xlsx-stream/multi-sheet-reader.js |
| `assertStagedInputUnchangedAsync` | 4 | 9 | 1 | src/main-process/position-reconciliation/input-staging.js |
| `BALANCE_SEED_GENERATION_METHODS` | 4 | 9 | 1 | src/backend/balance-seed-store.js |
| `BANK_BU_SINGLETON_UNIT_ID` | 4 | 9 | 4 | src/main-process/bank-bu-worker/dual-parser-dispatch.js |
| `BANK_HEADERS` | 4 | 9 | 1 | src/backend/bank-bu-recon-db/columns.js |
| `buildRunRowKey` | 4 | 9 | 3 | src/backend/vcc-financial-op/archive-evidence.js |
| `classifyArchiveContract` | 4 | 9 | 1 | src/backend/vcc-financial-op/archive-contract.js |
| `createJobEnvelope` | 4 | 9 | 3 | src/main-process/background-execution/adapters/canonical-event-emitter.js |
| `createToolboxOutputWriter` | 4 | 9 | 4 | src/main-process/toolbox-background/output-writer-core.js |
| `deriveReconFixJpmConflictScopeKey` | 4 | 9 | 4 | src/main-process/recon-id-fix-service/jpm-conflict-scope.js |
| `dispatchEngineImport` | 4 | 9 | 4 | src/main-process/acquiring-bill-currency-session.js |
| `getBankRows` | 4 | 9 | 1 | src/backend/bank-bu-recon-db/month-repository.js |
| `getRecoveryAuditBySource` | 4 | 9 | 1 | src/backend/database/duplicate-inbound-match-run-repository.js |
| `hashSourceFiles` | 4 | 9 | 3 | src/backend/vcc-financial-op/import-service.js |
| `mapReceipt` | 4 | 9 | 4 | src/backend/database/recon-fix-operation-receipt-repository.js |
| `MODULE_ACQUIRING` | 4 | 9 | 1 | src/backend/run-data-store.js |
| `normalizeRecoveryInspectionResult` | 4 | 9 | 1 | src/main-process/background-execution/recovery-source.js |
| `operationPreviewToken` | 4 | 9 | 1 | src/backend/vcc-financial-op/operation-state.js |
| `parseMptFile` | 4 | 9 | 3 | src/main-process/pre-fund-reconciliation/mpt-error-report-writer.js |
| `parseStrictJson` | 4 | 9 | 1 | src/main-process/background-execution/canonical-json-v1.js |
| `parseWorkbookXml` | 4 | 9 | 2 | src/backend/toolbox-format/xlsx-pass.js |
| `PENDING_GUANLI_HEADERS` | 4 | 9 | 1 | src/backend/bank-bu-recon-db/columns.js |
| `readXlsxStreamed` | 4 | 9 | 4 | src/backend/file-service/readers.js |
| `refreshImportRecordArchiveState` | 4 | 9 | 1 | src/backend/vcc-financial-op-db/repository.js |
| `sameDuplicateSideDbRelPath` | 4 | 9 | 1 | src/backend/duplicate-inbound-match-side-db-identity.js |
| `SchemaValidationError` | 4 | 9 | 3 | src/main-process/background-execution/recovery-control-contract.js |
| `startStartupPhase` | 4 | 9 | 3 | src/backend/startup-phase.js |
| `styleHeader` | 4 | 9 | 4 | src/backend/position-reconciliation-import/anomaly-report.js |
| `validateNewAccountGenerationResult` | 4 | 9 | 1 | src/main-process/new-account/generation-contract.js |
| `validateServiceControlEnvelope` | 4 | 9 | 1 | src/main-process/background-execution/protocol-validator.js |
| `validateVccExportSubjectsResult` | 4 | 9 | 1 | src/main-process/vcc-financial-op-output/policies.js |
| `WORKER_BATCH_CONTEXT_FIELDS` | 4 | 9 | 1 | src/main-process/archive-center/worker-batch-context.js |
| `addOneDay` | 4 | 8 | 1 | src/main-process/biz-op-recon-session.js |
| `buildDetailExportRows` | 4 | 8 | 1 | src/backend/file-service.js |
| `BUSINESS_BILL_FIELDS` | 4 | 8 | 2 | src/constants/recon-id-fix-fields.js |
| `classifySourceRow` | 4 | 8 | 1 | src/main-process/position-reconciliation/readers.js |
| `clearRunsAndDiffsByDateBu` | 4 | 8 | 1 | src/backend/biz-op-recon-db/run-repository.js |
| `createExecutionPolicyRegistry` | 4 | 8 | 1 | src/main-process/background-execution/execution-policy-registry.js |
| `createExecutionSupervisor` | 4 | 8 | 4 | src/main-process/background-execution/canary/packaged-runtime-runner.js |
| `createRecoveryControlRepository` | 4 | 8 | 1 | src/main-process/background-execution/critical/recovery-control-repository.js |
| `createRecoveryRequestOwnerRepository` | 4 | 8 | 1 | src/main-process/background-execution/critical/recovery-request-owner-repository.js |
| `createResourceGovernor` | 4 | 8 | 4 | src/main-process/background-execution/canary/packaged-runtime-runner.js |
| `createUtilityProcessAdapter` | 4 | 8 | 4 | src/main-process/background-execution/adapters/utility-process-adapter.js |
| `createWorkerThreadAdapter` | 4 | 8 | 4 | src/main-process/background-execution/adapters/worker-thread-adapter.js |
| `detectToolboxInputKind` | 4 | 8 | 4 | src/main-process/toolbox-format-io.js |
| `diagnoseFirstMonthFacts` | 4 | 8 | 2 | src/backend/vcc-financial-op-db/state-model.js |
| `dispatchPositionLargeImportSchemaMigration` | 4 | 8 | 1 | src/main-process/position-reconciliation/import-dispatch.js |
| `ensureCanaryReceiptSchema` | 4 | 8 | 3 | src/main-process/background-execution/canary/canary-schema.js |
| `executeRun` | 4 | 8 | 2 | src/main-process/bank-bu-worker/run-operation.js |
| `filterStagingPathsWithoutProtectedSources` | 4 | 8 | 1 | src/main-process/position-reconciliation/input-staging.js |
| `getRowsByDateBu` | 4 | 8 | 2 | src/backend/biz-op-recon-db/flow-imports-repository.js |
| `listTemplates` | 4 | 8 | 1 | src/backend/database/template-repository.js |
| `MODULE_PRE_FUND_RECONCILIATION` | 4 | 8 | 1 | src/backend/run-data-store.js |
| `MODULE_PRE_FUND_RECONCILIATION_RESULTS` | 4 | 8 | 1 | src/backend/run-data-store.js |
| `normalizeGenerationEvidence` | 4 | 8 | 1 | src/main-process/toolbox-background/generation-contract.js |
| `normalizeManifestSource` | 4 | 8 | 2 | src/main-process/bank-bu-worker/spool-contract.js |
| `normalizeMultiSplitInput` | 4 | 8 | 1 | src/main-process/toolbox-background/generation-contract.js |
| `openVccReadDatabase` | 4 | 8 | 4 | src/backend/vcc-financial-op/read-schema.js |
| `OPPONENT_BILL_FIELDS` | 4 | 8 | 2 | src/constants/recon-id-fix-fields.js |
| `publishToolboxPublicationAsync` | 4 | 8 | 2 | src/main-process/recon-id-fix-service/export-operation.js |
| `readLinkedTableRows` | 4 | 8 | 1 | src/backend/database/linked-table-repository.js |
| `recoverToolboxPublicationsAsync` | 4 | 8 | 1 | src/main-process/toolbox-output-publication-dispatch.js |
| `resolveSinglePreparedFieldValue` | 4 | 8 | 1 | src/main-process/statement-session.js |
| `saveBillSplitAmountRules` | 4 | 8 | 1 | src/backend/database/template-repository.js |
| `saveBillSplitMeta` | 4 | 8 | 1 | src/backend/database/template-repository.js |
| `scanXlsxSheet` | 4 | 8 | 1 | src/backend/toolbox-format/xlsx-sheet-scanner.js |
| `validateBillHeaders` | 4 | 8 | 4 | src/backend/acquiring-bill-currency-import/contract-bill.js |
| `validateFlowRow` | 4 | 8 | 3 | src/backend/biz-op-recon-import/contract-flow.js |
| `validateToolboxMultiGenerationResult` | 4 | 8 | 1 | src/main-process/toolbox-background/generation-contract.js |
| `yauzl` | 4 | 8 | 4 | src/backend/acquiring-bill-currency-import/reader.js |
| `appendStatementSessionImport` | 4 | 7 | 1 | src/main-process/statement-session.js |
| `artifactManifestFromFilePlan` | 4 | 7 | 1 | src/main-process/archive-center/file-plan.js |
| `assertXlsxEntriesUnderLimit` | 4 | 7 | 4 | src/backend/biz-op-recon-import/reader-streamed.js |
| `buildDateDir` | 4 | 7 | 3 | src/main-process/acquiring-bill-currency-writer.js |
| `buildStatementFileEntry` | 4 | 7 | 1 | src/main-process/statement-session.js |
| `calculateEndingBalanceFromAmounts` | 4 | 7 | 1 | src/backend/file-service/normalizers.js |
| `createInspectorRegistry` | 4 | 7 | 2 | src/main-process/background-execution/canary/packaged-runtime-runner.js |
| `createNewAccountGenerationInput` | 4 | 7 | 1 | src/main-process/new-account/generation-contract.js |
| `createRecoveryHoldGate` | 4 | 7 | 2 | src/main-process/background-execution/recovery-hold-gate.js |
| `createRecoveryObservationAttemptRepository` | 4 | 7 | 1 | src/main-process/background-execution/critical/recovery-request-owner-repository.js |
| `createRunMirror` | 4 | 7 | 2 | src/backend/database/duplicate-inbound-match-run-repository.js |
| `createSettlementRecoveryProviderRegistry` | 4 | 7 | 1 | src/main-process/background-execution/settlement-recovery-provider-registry.js |
| `createStartupRecoveryCoordinator` | 4 | 7 | 2 | src/main-process/background-execution/canary/packaged-runtime-runner.js |
| `errorCodeToCause` | 4 | 7 | 4 | src/backend/file-service/error-causes.js |
| `exportToolboxFilter` | 4 | 7 | 2 | src/main-process/toolbox-background/generation-core.js |
| `failRunMirror` | 4 | 7 | 2 | src/backend/database/duplicate-inbound-match-run-repository.js |
| `finishRunMirror` | 4 | 7 | 2 | src/backend/database/duplicate-inbound-match-run-repository.js |
| `inferEndingBalance` | 4 | 7 | 1 | src/backend/file-service/normalizers.js |
| `insertRows` | 4 | 7 | 2 | src/backend/biz-op-recon-db/flow-imports-repository.js |
| `listOperationReceipts` | 4 | 7 | 2 | src/backend/vcc-op-calc-db/operation-receipt-repository.js |
| `markRunMirrorUnavailable` | 4 | 7 | 2 | src/backend/database/duplicate-inbound-match-run-repository.js |
| `mergeMappedDetailRows` | 4 | 7 | 1 | src/main-process/statement-session.js |
| `normalizeExactReceipt` | 4 | 7 | 1 | src/backend/database/recon-fix-operation-receipt-repository.js |
| `readBalanceSeedRecords` | 4 | 7 | 1 | src/main-process/monthly-balance.js |
| `readBankFile` | 4 | 7 | 4 | src/backend/bank-bu-recon-import/reader.js |
| `readPendingGuanliFile` | 4 | 7 | 4 | src/backend/bank-bu-recon-import/reader.js |
| `setChildParent` | 4 | 7 | 1 | src/backend/database/template-repository.js |
| `writeHead` | 4 | 7 | 1 | src/backend/biz-op-recon-db/dataset-head-repository.js |
| `writeXlsxAtomically` | 4 | 7 | 4 | src/main-process/vcc-financial-op-audit-writer.js |
| `buildTimestamp` | 4 | 6 | 3 | src/main-process/acquiring-bill-currency-writer.js |
| `clearBillSplitMergeGroups` | 4 | 6 | 1 | src/backend/database/template-repository.js |
| `createImportRecord` | 4 | 6 | 1 | src/backend/vcc-financial-op-db/repository.js |
| `createImportSource` | 4 | 6 | 1 | src/backend/vcc-financial-op-db/repository.js |
| `createRowFilter` | 4 | 6 | 2 | src/main-process/toolbox-multi-split.js |
| `deleteBillSplitRow` | 4 | 6 | 1 | src/backend/database/template-repository.js |
| `listSuccessDatesInRange` | 4 | 6 | 1 | src/backend/biz-op-recon-db/run-repository.js |
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
| `countExportableImportAnomalies` | 4 | 5 | 1 | src/backend/vcc-financial-op-db/repository.js |
| `createCommittedRunMirror` | 4 | 5 | 1 | src/backend/database/duplicate-inbound-match-run-repository.js |
| `deleteArchiveRunByTaskRunId` | 4 | 5 | 1 | src/backend/biz-op-recon-db/run-repository.js |
| `failImportBatch` | 4 | 5 | 1 | src/backend/vcc-financial-op-db/repository.js |
| `protocol` | 4 | 5 | 1 | src/main-process/background-execution/index.js |
| `ToolboxXlsxFormatError` | 3 | 124 | 1 | src/backend/toolbox-format/xlsx-sheet-scanner.js |
| `MODULES` | 3 | 101 | 2 | src/main-process/archive-center/operation-tracker.js |
| `ProtocolValidationError` | 3 | 54 | 1 | src/main-process/background-execution/protocol-validator.js |
| `hasColumn` | 3 | 52 | 2 | src/backend/biz-op-recon-db/migrations.js |
| `RECON` | 3 | 43 | 3 | src/main-process/scenario-engines/many-to-many-detector.js |
| `bankValue` | 3 | 41 | 1 | src/main-process/pre-fund-reconciliation/output-mapper.js |
| `settingsRepository` | 3 | 40 | 3 | src/backend/database.js |
| `applyMismatch` | 3 | 38 | 3 | src/backend/position-reconciliation-import/account-writer.js |
| `publicFailure` | 3 | 35 | 3 | src/main-process/archive-center/controller.js |
| `SYSTEM_OP_DEFINITION` | 3 | 35 | 1 | src/backend/vcc-financial-op/definitions.js |
| `invokeFault` | 3 | 31 | 3 | src/main-process/recon-id-fix-service/jpm-writeback-transaction.js |
| `POSITION_IMPORT_MESSAGE_TYPES` | 3 | 31 | 1 | src/backend/position-reconciliation-import/constants.js |
| `runEvidence` | 3 | 31 | 1 | src/main-process/acquiring-bill-currency-run-data.js |
| `BANK_BU_ACTIONS` | 3 | 30 | 3 | src/main-process/bank-bu-worker/main-coordinator.js |
| `writerError` | 3 | 29 | 2 | src/main-process/pre-fund-reconciliation/mpt-import/single-writer-session.js |
| `DELETE_TARGET_TYPES` | 3 | 26 | 2 | src/backend/vcc-financial-op/data-target-deletion.js |
| `BigTableImportError` | 3 | 25 | 1 | src/backend/big-table-import/zip-reader.js |
| `recoveryRequired` | 3 | 25 | 1 | src/main-process/position-reconciliation/import-recovery.js |
| `authorityError` | 3 | 24 | 3 | src/main-process/pre-fund-reconciliation/mpt-import/receipt-authority.js |
| `pathFailure` | 3 | 24 | 3 | src/main-process/bank-bu-worker/spool-filesystem.js |
| `recoveryError` | 3 | 24 | 1 | src/main-process/pre-fund-archive-lineage.js |
| `emitControl` | 3 | 23 | 1 | src/main-process/recon-id-fix-service/worker-entry.js |
| `REASON_CODES` | 3 | 23 | 2 | src/main-process/position-reconciliation/contracts.js |
| `TABLE` | 3 | 23 | 3 | src/backend/biz-op-recon-db/flow-imports-repository.js |
| `BANK_ROW_CLASSIFICATION` | 3 | 22 | 1 | src/main-process/pre-fund-reconciliation/bank-row.js |
| `buildOutputRow` | 3 | 21 | 3 | src/main-process/scenario-engines/boc-dispatch-order-fix.js |
| `canonicalRealPath` | 3 | 21 | 1 | src/main-process/statement-worker/source-identity.js |
| `evidenceError` | 3 | 21 | 3 | src/main-process/recon-id-fix-service/artifact-evidence.js |
| `directoryPathAliasKey` | 3 | 20 | 1 | src/main-process/toolbox-target-identity.js |
| `weekTag` | 3 | 20 | 2 | src/main-process/scenario-engines/engine-week-utils.js |
| `emptyState` | 3 | 19 | 1 | src/main-process/fund-recon-worker/service.js |
| `nullable` | 3 | 19 | 1 | src/main-process/background-execution/recovery-control-contract.js |
| `safeRollback` | 3 | 19 | 3 | src/backend/big-table-import/engine.js |
| `verifyFile` | 3 | 19 | 1 | src/main-process/archive-center/storage-materializer.js |
| `businessOperationRegistry` | 3 | 18 | 1 | src/main.js |
| `CONCAT_FIELDS_MAPPING_FIELD` | 3 | 17 | 2 | src/main.js |
| `parseAmount` | 3 | 17 | 3 | src/backend/biz-op-recon-import/validator.js |
| `readers` | 3 | 17 | 2 | src/main-process/fund-recon-worker/source-readers.js |
| `BALANCE_DISABLED_OPTION` | 3 | 16 | 2 | src/main.js |
| `operationReceipts` | 3 | 16 | 2 | src/main-process/duplicate-inbound-match/service.js |
| `snapshotsEqual` | 3 | 16 | 3 | src/main-process/manual-balance-seed-settlement.js |
| `createRecoveryHoldRequest` | 3 | 15 | 1 | src/main-process/background-execution/recovery-hold-request.js |
| `diffRepo` | 3 | 15 | 3 | src/backend/pending-export/writer.js |
| `mapRun` | 3 | 15 | 3 | src/backend/duplicate-inbound-match-store.js |
| `MAX_RECORDS` | 3 | 15 | 1 | src/main-process/new-account/generation-contract.js |
| `own` | 3 | 15 | 1 | src/main-process/duplicate-inbound-match/matching-engine.js |
| `requireHash` | 3 | 15 | 3 | src/backend/database/duplicate-inbound-match-run-repository.js |
| `RESULT_MUTATION_OPERATIONS` | 3 | 15 | 1 | src/backend/vcc-financial-op/preserved-state.js |
| `resultRows` | 3 | 15 | 1 | src/main-process/background-execution/adapters/position-import-adapter.js |
| `statementImportSessions` | 3 | 15 | 1 | src/main.js |
| `cellText` | 3 | 14 | 1 | src/backend/vcc-financial-op/result-template-contract.js |
| `PRAGMA_EXPECTED` | 3 | 14 | 3 | src/backend/big-table-import/engine.js |
| `readToolboxMetadataEntryAsString` | 3 | 14 | 1 | src/backend/toolbox-format/xlsx-pass.js |
| `remainingTimeout` | 3 | 14 | 2 | src/main-process/background-execution/external-parser-finalization.js |
| `applyStatementResult` | 3 | 13 | 1 | src/renderer.js |
| `BANK_RECON_ID_FIELD` | 3 | 13 | 3 | src/main-process/scenario-engines/dbs-charge-fund-check.js |
| `FUND_RECON_ACTIONS` | 3 | 13 | 1 | src/main-process/fund-recon-worker/policies.js |
| `PRE_FUND_MPT_REPAIR_ACTION` | 3 | 13 | 2 | src/main-process/pre-fund-reconciliation/mpt-import/policies.js |
| `RECON_FIX_RUN_READONLY_ACTION` | 3 | 13 | 1 | src/main-process/recon-id-fix-service/policies.js |
| `RecoveryRegistryError` | 3 | 13 | 2 | src/main-process/background-execution/inspector-registry.js |
| `safeSnapshot` | 3 | 13 | 3 | src/main-process/background-execution/capability-inventory.js |
| `STATEMENT_RESOURCE_CONTRACT` | 3 | 13 | 1 | src/main-process/statement-worker/contracts.js |
| `cancelledError` | 3 | 12 | 2 | src/main-process/vcc-financial-op-output/writer-core.js |
| `hasEffectiveAmount` | 3 | 12 | 2 | src/backend/file-service/normalizers.js |
| `isSafeMptErrorText` | 3 | 12 | 1 | src/main-process/pre-fund-reconciliation/mpt-import/file-result-safety.js |
| `requestEvidence` | 3 | 12 | 1 | src/main-process/background-execution/recovery-control-contract.js |
| `upsertMainRunMirror` | 3 | 12 | 3 | src/main-process/acquiring-bill-currency-run-data.js |
| `utf8Size` | 3 | 12 | 2 | src/main-process/background-execution/error-codec.js |
| `assertCurrentPositionCheckpointHistory` | 3 | 11 | 1 | src/main-process/position-reconciliation/side-db-mutation.js |
| `buildFieldIndexMap` | 3 | 11 | 1 | src/main-process/statement-generation-business.js |
| `compareText` | 3 | 11 | 2 | src/backend/vcc-financial-op/archive-evidence.js |
| `EXCEL_CELL_TEXT_MAX_UTF16_UNITS` | 3 | 11 | 1 | src/backend/toolbox-format/excel-text.js |
| `findRelationshipEntry` | 3 | 11 | 1 | src/backend/toolbox-format/xlsx-pass.js |
| `getScenario` | 3 | 11 | 1 | src/backend/database/scenarios-repository.js |
| `getVccFinancialOpModuleState` | 3 | 11 | 1 | src/backend/vcc-financial-op-db/repository.js |
| `MAX_PARSER_ERROR_ROWS` | 3 | 11 | 1 | src/main-process/vcc-op-calc/parser-core.js |
| `mirrorError` | 3 | 11 | 1 | src/main-process/bank-bu-worker/mirror-repository.js |
| `normalizeTargetParentIdentity` | 3 | 11 | 1 | src/main-process/archive-center/target-parent-identity.js |
| `parseBalancesJson` | 3 | 11 | 3 | src/backend/vcc-financial-op/calculator.js |
| `parseDecimalLexical` | 3 | 11 | 1 | src/backend/toolbox-format/number-date.js |
| `PARSER_RESULT_MAX_BYTES` | 3 | 11 | 1 | src/main-process/vcc-op-calc/parser-core.js |
| `parserFailure` | 3 | 11 | 1 | src/main-process/pre-fund-reconciliation/mpt-import/managed-import.js |
| `previewDataTargetDeletion` | 3 | 11 | 1 | src/backend/vcc-financial-op/data-target-deletion.js |
| `RECON_FIX_IMPORT_ACTION` | 3 | 11 | 1 | src/main-process/recon-id-fix-service/policies.js |
| `setRunChunkProgress` | 3 | 11 | 1 | src/backend/acquiring-bill-currency-db/run-repository.js |
| `assertDirectoryDurable` | 3 | 10 | 3 | src/main-process/pre-fund-reconciliation/mpt-import/parser-outcome.js |
| `bankAmountAbs` | 3 | 10 | 2 | src/main-process/scenario-engines/r5-fund-transfer-backfill.js |
| `canonicalDecimal` | 3 | 10 | 2 | src/main-process/position-reconciliation/common.js |
| `closeMutationGuard` | 3 | 10 | 1 | src/backend/vcc-financial-op/mutation-guard.js |
| `duplicateSideDbRelPath` | 3 | 10 | 1 | src/backend/duplicate-inbound-match-side-db-identity.js |
| `finishImportRecord` | 3 | 10 | 1 | src/backend/vcc-financial-op-db/repository.js |
| `isSafeMptErrorCode` | 3 | 10 | 1 | src/main-process/pre-fund-reconciliation/mpt-import/file-result-safety.js |
| `MPT_SPOOL_FILE_NAMES` | 3 | 10 | 1 | src/main-process/pre-fund-reconciliation/mpt-import/spool-contract.js |
| `NEW_ACCOUNT_SAVE_AS_ACTION` | 3 | 10 | 2 | src/main-process/new-account/artifact-copy.js |
| `normalizeTaskStagingDir` | 3 | 10 | 3 | src/main-process/bank-bu-worker/spool-contract.js |
| `PENDING_RAW_CONTRACT_V2` | 3 | 10 | 1 | src/backend/vcc-financial-op/definitions.js |
| `PRAGMA_STATEMENTS` | 3 | 10 | 3 | src/backend/big-table-import/engine.js |
| `PRE_FUND_MPT_IMPORT_ACTION` | 3 | 10 | 2 | src/main-process/pre-fund-reconciliation/mpt-import/policies.js |
| `RecoveryControlError` | 3 | 10 | 1 | src/main-process/background-execution/critical/recovery-request-owner-repository.js |
| `validateObservationRequest` | 3 | 10 | 1 | src/main-process/background-execution/recovery-control-contract.js |
| `validateTransitionRequest` | 3 | 10 | 1 | src/main-process/background-execution/recovery-control-contract.js |
| `VCC_OP_SAVE_RUN_ACTION_KEY` | 3 | 10 | 1 | src/main-process/vcc-op-calc/save-run-contract.js |
| `addToAccumulatorMap` | 3 | 9 | 2 | src/backend/vcc-financial-op/calculator.js |
| `admImageHash` | 3 | 9 | 1 | src/backend/database/linked-table-writeback-reader.js |
| `amountEqual` | 3 | 9 | 3 | src/main-process/scenario-engines/r5-fund-transfer-backfill.js |
| `assertC1Transition` | 3 | 9 | 1 | src/main-process/background-execution/recovery-control-contract.js |
| `assertMetadataCurrent` | 3 | 9 | 2 | src/main-process/statement-worker/generation.js |
| `attachSourceIdentity` | 3 | 9 | 1 | src/backend/vcc-financial-op/source-lineage.js |
| `BANK_STATEMENT_FIELDS_FOR_C3` | 3 | 9 | 2 | src/constants/bank-statement-fields.js |
| `BANK_STATEMENT_VIRTUAL_AMOUNT_ABS` | 3 | 9 | 3 | src/constants/bank-statement-fields.js |
| `buildHeaderValidator` | 3 | 9 | 3 | src/backend/acquiring-bill-currency-import/validator.js |
| `classifyBankRow` | 3 | 9 | 1 | src/main-process/pre-fund-reconciliation/bank-row.js |
| `classifyExcelNumberFormat` | 3 | 9 | 1 | src/backend/toolbox-format/number-date.js |
| `collectEntrySizes` | 3 | 9 | 1 | src/backend/pending-import/xlsx-size-preflight.js |
| `detectDetailSourceType` | 3 | 9 | 1 | src/backend/vcc-financial-op/definitions.js |
| `FLOW_TABLE` | 3 | 9 | 3 | src/backend/acquiring-bill-currency-db/run-repository.js |
| `FUND_TRANSFER_RECON_USED` | 3 | 9 | 1 | src/constants/fund-transfer-recon-fields.js |
| `getChannelById` | 3 | 9 | 1 | src/backend/database/channels-repository.js |
| `GW_RECON_ID_FIELD` | 3 | 9 | 3 | src/main-process/scenario-engines/dbs-charge-fund-check.js |
| `hasFundTransferReservedSignature` | 3 | 9 | 1 | src/main-process/fund-transfer-date-policy.js |
| `isNumericFieldName` | 3 | 9 | 3 | src/backend/pending-reconcile/removal-match.js |
| `isoDate` | 3 | 9 | 2 | src/main-process/read-only-exports/biz-op/actions.js |
| `loadArchiveEvidenceSet` | 3 | 9 | 1 | src/backend/vcc-financial-op/read-snapshot.js |
| `normalizedRow` | 3 | 9 | 1 | src/main-process/bank-bu-worker/spool-writer.js |
| `normalizeLegacyStoredCurrency` | 3 | 9 | 1 | src/backend/vcc-financial-op/definitions.js |
| `parseJsonArray` | 3 | 9 | 2 | src/backend/database/utils.js |
| `PENDING_RAW_CONTRACT_V1` | 3 | 9 | 1 | src/backend/vcc-financial-op/definitions.js |
| `receiptError` | 3 | 9 | 3 | src/main-process/bank-bu-worker/operation-receipt-repository.js |
| `RECON_FIX_SERVICE_KEY` | 3 | 9 | 1 | src/main-process/recon-id-fix-service/policies.js |
| `REFUND_BANK_COLUMNS` | 3 | 9 | 1 | src/constants/refund-backfill-fields.js |
| `requireSafeId` | 3 | 9 | 3 | src/backend/database/duplicate-inbound-match-run-repository.js |
| `toInvalidBothNonzeroError` | 3 | 9 | 1 | src/main-process/pre-fund-reconciliation/bank-row.js |
| `VCC_EXPORT_SUBJECTS_MAX_ARTIFACTS` | 3 | 9 | 1 | src/main-process/vcc-financial-op-output/policies.js |
| `writeFileAtomicDurable` | 3 | 9 | 3 | src/main-process/background-execution/canary/durable-recovery.js |
| `ALLOWED_SOURCE_TYPES` | 3 | 8 | 2 | src/backend/vcc-financial-op/dataset-deletion.js |
| `AMOUNT_BASED_ACCOUNT_MAPPING_FIELD` | 3 | 8 | 2 | src/main.js |
| `AMOUNT_BASED_NAME_MAPPING_FIELD` | 3 | 8 | 2 | src/main.js |
| `AMOUNT_EPSILON` | 3 | 8 | 1 | src/backend/biz-op-recon-db/columns.js |
| `AMOUNT_SPLIT_BY_FIELD_ENABLED_OPTION` | 3 | 8 | 2 | src/main.js |
| `AMOUNT_SPLIT_BY_FIELD_MAPPING_FIELD` | 3 | 8 | 2 | src/main.js |
| `assertDistinctTaskOwnedPaths` | 3 | 8 | 1 | src/main-process/statement-worker/staging-ownership.js |
| `assertVccTriggerPolicy` | 3 | 8 | 1 | src/backend/vcc-financial-op/mutation-guard.js |
| `buildHeaderIdentity` | 3 | 8 | 2 | src/main-process/pre-fund-reconciliation/mpt-import/parser-core.js |
| `checkpointGeneration` | 3 | 8 | 1 | src/main-process/position-reconciliation/side-db-mutation.js |
| `compactJson` | 3 | 8 | 1 | src/main-process/background-execution/protocol-validator.js |
| `createStatementPublicTokenIdentity` | 3 | 8 | 2 | src/main-process/statement-worker/generation-contracts.js |
| `deadlineAfter` | 3 | 8 | 2 | src/main-process/background-execution/external-parser-finalization.js |
| `ensureVccFinancialOpTablesSupport` | 3 | 8 | 3 | src/backend/database.js |
| `FLOW_INSERT_SQL` | 3 | 8 | 3 | src/backend/acquiring-bill-currency-db/import-repository.js |
| `fsyncFile` | 3 | 8 | 3 | src/main-process/toolbox-background/route-db-sealer.js |
| `GATEWAY_RECON_FIELDS` | 3 | 8 | 3 | src/constants/gateway-recon-fields.js |
| `getMonthReadiness` | 3 | 8 | 1 | src/backend/acquiring-bill-currency-db/import-repository.js |
| `getTemplateBigAccounts` | 3 | 8 | 1 | src/backend/database/template-repository.js |
| `groupBy` | 3 | 8 | 2 | src/main-process/scenario-engines/jpm-dispatch-order-fix.js |
| `inputEvidenceFor` | 3 | 8 | 3 | src/backend/position-reconciliation-import/account-writer.js |
| `jobDirectoryToken` | 3 | 8 | 3 | src/main-process/bank-bu-worker/spool-contract.js |
| `listDiffRows` | 3 | 8 | 1 | src/backend/pending-db/diff-repository.js |
| `MAX_ARTIFACT_BYTES` | 3 | 8 | 3 | src/main-process/new-account/generation-contract.js |
| `NEW_ACCOUNT_GENERATION_SCHEMA_VERSION` | 3 | 8 | 1 | src/main-process/new-account/generation-contract.js |
| `normalizeCurrency` | 3 | 8 | 3 | src/backend/acquiring-bill-currency-db/import-repository.js |
| `normalizeOptions` | 3 | 8 | 3 | src/main-process/bank-bu-worker/dual-parser-dispatch.js |
| `parseAmountToCents` | 3 | 8 | 1 | src/main-process/vcc-op-calc/parser-core.js |
| `PENDING_READ_ONLY_ACTION_SET` | 3 | 8 | 2 | src/main-process/read-only-exports/pending/policies.js |
| `pendingCanonicalValues` | 3 | 8 | 1 | src/backend/vcc-financial-op/row-mapper.js |
| `pendingContentHash` | 3 | 8 | 1 | src/backend/vcc-financial-op/row-mapper.js |
| `policyForAction` | 3 | 8 | 2 | src/main-process/background-execution/execution-policy-registry.js |
| `POSITION_IMPORT_STREAMING_SOURCE_ALLOWLIST` | 3 | 8 | 1 | src/backend/position-reconciliation-import/constants.js |
| `previousDate` | 3 | 8 | 2 | src/main-process/biz-op-archive-lineage.js |
| `REFUND_TEMPLATE_HEADERS` | 3 | 8 | 1 | src/constants/refund-backfill-fields.js |
| `registerVccStorageWriteCapability` | 3 | 8 | 1 | src/backend/vcc-financial-op-db/storage-contract.js |
| `RESULT_TEMPLATE_FILE_NAME` | 3 | 8 | 1 | src/backend/vcc-financial-op/result-template-contract.js |
| `sanitizeFinanceSafeValue` | 3 | 8 | 3 | src/main-process/background-execution/error-codec.js |
| `scanBalanceSeedStatus` | 3 | 8 | 1 | src/main-process/statement-generation-business.js |
| `sha256RegularFile` | 3 | 8 | 3 | src/main-process/pre-fund-reconciliation/mpt-import/spool-reader.js |
| `SIGNED_AMOUNT_MAPPING_FIELD` | 3 | 8 | 2 | src/main.js |
| `snapshotResultMutationState` | 3 | 8 | 1 | src/backend/vcc-financial-op/preserved-state.js |
| `sourceForIntent` | 3 | 8 | 1 | src/main-process/manual-balance-seed-settlement.js |
| `sourceIdentityFromError` | 3 | 8 | 2 | src/backend/vcc-financial-op/import-service.js |
| `sourceTypeForFundType` | 3 | 8 | 1 | src/main-process/position-reconciliation/constants.js |
| `TEXT_HEADER_PATTERN` | 3 | 8 | 2 | src/backend/position-reconciliation-import/anomaly-report.js |
| `topologyError` | 3 | 8 | 2 | src/main-process/pre-fund-reconciliation/mpt-import/topology.js |
| `updateDateRange` | 3 | 8 | 1 | src/backend/position-reconciliation-import/preflight.js |
| `validateConsumedAttributeCase` | 3 | 8 | 3 | src/backend/toolbox-format/style-registry.js |
| `validateSourceRow` | 3 | 8 | 1 | src/main-process/position-reconciliation/readers.js |
| `verifyAnomalyReportFile` | 3 | 8 | 1 | src/main-process/position-reconciliation/filtered-source-report.js |
| `ACTION_KEYS` | 3 | 7 | 3 | src/main-process/bank-bu-worker/operation-receipt-repository.js |
| `assertMutationGuardPostwrite` | 3 | 7 | 1 | src/backend/vcc-financial-op/mutation-guard.js |
| `assertMutationRuntimeAvailable` | 3 | 7 | 1 | src/backend/vcc-financial-op/mutation-guard.js |
| `assertNoUnacknowledgedArchiveRunByDateBu` | 3 | 7 | 1 | src/backend/biz-op-recon-db/run-repository.js |
| `assertPendingRunEvidence` | 3 | 7 | 1 | src/main-process/read-only-exports/pending/query.js |
| `assertTargetParentIdentityFresh` | 3 | 7 | 1 | src/main-process/archive-center/target-parent-identity.js |
| `assertTaskStagingIdentity` | 3 | 7 | 1 | src/main-process/vcc-financial-op-output/staging-identity.js |
| `assertVccFinancialOpSourceSnapshot` | 3 | 7 | 1 | src/main-process/read-only-exports/vcc-financial-op/query.js |
| `assertVccMutationSchema` | 3 | 7 | 1 | src/backend/vcc-financial-op/mutation-guard.js |
| `backfillBocReconLinkIds` | 3 | 7 | 1 | src/main-process/boc-fx-link-builder.js |
| `balanceSeedRecordsEvidence` | 3 | 7 | 1 | src/main-process/manual-balance-seed-preflight.js |
| `bankAmountWithExtraFee` | 3 | 7 | 2 | src/main-process/scenario-engines/many-to-many-detector.js |
| `beginMutationGuard` | 3 | 7 | 1 | src/backend/vcc-financial-op/mutation-guard.js |
| `buildBocBankRows` | 3 | 7 | 1 | src/main-process/boc-fx-link-builder.js |
| `buildDateRangeLabel` | 3 | 7 | 1 | src/main-process/statement-generation-business.js |
| `buildGatewayFingerprint` | 3 | 7 | 2 | src/main-process/pre-fund-reconciliation/matching-engine.js |
| `buildInsertSql` | 3 | 7 | 3 | src/backend/bank-bu-recon-db/month-repository.js |
| `buildMappedRows` | 3 | 7 | 2 | src/backend/file-service.js |
| `captureMirrorPreimage` | 3 | 7 | 2 | src/main-process/bank-bu-worker/main-coordinator.js |
| `cleanupBankBuSpool` | 3 | 7 | 1 | src/main-process/bank-bu-worker/spool-filesystem.js |
| `cleanupDuplicateSpool` | 3 | 7 | 1 | src/main-process/duplicate-inbound-match/spool-filesystem.js |
| `cleanupMptFileSpool` | 3 | 7 | 3 | src/main-process/pre-fund-reconciliation/mpt-import/managed-import.js |
| `computeDuplicateResultPostImage` | 3 | 7 | 1 | src/backend/duplicate-inbound-match-result-digest.js |
| `createBigTableImportMatureBinding` | 3 | 7 | 1 | src/main-process/big-table-import-dispatch.js |
| `createScenario` | 3 | 7 | 1 | src/backend/database/scenarios-repository.js |
| `createStatementImportSession` | 3 | 7 | 1 | src/main-process/statement-session.js |
| `createStatementInteractionRequiredResult` | 3 | 7 | 1 | src/main-process/statement-worker/contracts.js |
| `createStatementTokenHandleDto` | 3 | 7 | 1 | src/main-process/statement-worker/contracts.js |
| `decodeExcelStXstring` | 3 | 7 | 1 | src/backend/toolbox-format/excel-text.js |
| `deriveBalanceRecords` | 3 | 7 | 1 | src/main-process/statement-generation-business.js |
| `dispatchPositionImportPreflight` | 3 | 7 | 1 | src/main-process/position-reconciliation/import-dispatch.js |
| `DUPLICATE_GATEWAY_HEADERS` | 3 | 7 | 1 | src/main-process/pre-fund-reconciliation/output-mapper.js |
| `DUPLICATE_SERVICE_KEY` | 3 | 7 | 1 | src/main-process/duplicate-inbound-match/policies.js |
| `DUPLICATE_STARTUP_CONFLICT_SCOPE_KEY` | 3 | 7 | 1 | src/main-process/duplicate-inbound-match/startup-recovery.js |
| `ensureSupportedFile` | 3 | 7 | 2 | src/backend/file-service/readers.js |
| `EXACT_RECEIPT_KEYS` | 3 | 7 | 3 | src/main-process/bank-bu-worker/operation-receipt-repository.js |
| `executeRegisteredMutationSteps` | 3 | 7 | 1 | src/backend/vcc-financial-op/mutation-guard.js |
| `expectedLedgerFile` | 3 | 7 | 1 | src/backend/position-reconciliation-import/source-writer.js |
| `failExecutionTransportForCoordinator` | 3 | 7 | 1 | src/main-process/background-execution/supervisor.js |
| `fingerprintQuery` | 3 | 7 | 1 | src/backend/vcc-financial-op/operation-state.js |
| `fitsWithin` | 3 | 7 | 2 | src/main-process/background-execution/resource-lease.js |
| `FUND_RECON_SERVICE_KEY` | 3 | 7 | 1 | src/main-process/fund-recon-worker/policies.js |
| `inspectDatasetExport` | 3 | 7 | 1 | src/main-process/vcc-financial-op-dataset-writer.js |
| `iterateDuplicateAuditRows` | 3 | 7 | 2 | src/main-process/pre-fund-reconciliation/output-mapper.js |
| `listAllRuns` | 3 | 7 | 1 | src/backend/pending-db/diff-repository.js |
| `mapDetailRow` | 3 | 7 | 1 | src/backend/vcc-financial-op/row-mapper.js |
| `MODULE_BIZ_OP` | 3 | 7 | 1 | src/backend/run-data-store.js |
| `MPT_DELIMITER` | 3 | 7 | 1 | src/main-process/pre-fund-reconciliation/mpt-schema.js |
| `MPT_SPOOL_SCHEMA_VERSION` | 3 | 7 | 1 | src/main-process/pre-fund-reconciliation/mpt-import/spool-contract.js |
| `normalizeParserInput` | 3 | 7 | 1 | src/main-process/vcc-op-calc/parser-core.js |
| `normalizePositionImportEngine` | 3 | 7 | 1 | src/backend/position-reconciliation-import/constants.js |
| `normalizeWorksheetTarget` | 3 | 7 | 3 | src/backend/big-table-import/zip-reader.js |
| `openDb` | 3 | 7 | 2 | src/backend/biz-op-recon-import/import-worker.js |
| `parsePaymentBigAccounts` | 3 | 7 | 1 | src/main-process/scenario-engines/r5-payment-offline-allocation-backfill.js |
| `parseRequiredBillDates` | 3 | 7 | 1 | src/main-process/statement-generation-business.js |
| `parseWorkbookRelationships` | 3 | 7 | 1 | src/backend/toolbox-format/xlsx-pass.js |
| `PERSISTENT` | 3 | 7 | 1 | src/main-process/duplicate-inbound-match/policies.js |
| `plainObject` | 3 | 7 | 1 | src/main-process/read-only-exports/common/contract.js |
| `POSITION_DB_RELATIVE_PATH` | 3 | 7 | 2 | src/main-process/position-reconciliation/constants.js |
| `publicResult` | 3 | 7 | 1 | src/main-process/recon-id-fix-service/service.js |
| `publishVccFinancialOpOutputs` | 3 | 7 | 2 | src/main-process/vcc-financial-op-output-recovery.js |
| `readAndValidateMptFileSpool` | 3 | 7 | 2 | src/main-process/pre-fund-reconciliation/mpt-import/single-writer-session.js |
| `readFirstMonthFacts` | 3 | 7 | 1 | src/backend/vcc-financial-op-db/state-model.js |
| `readSheetAsRows` | 3 | 7 | 3 | src/backend/bank-bu-recon-import/reader.js |
| `RecoveryHoldActiveError` | 3 | 7 | 1 | src/main-process/background-execution/recovery-hold-gate.js |
| `recoveryHoldReasonForInspection` | 3 | 7 | 1 | src/main-process/background-execution/recovery-hold-request.js |
| `requireSha256` | 3 | 7 | 3 | src/main-process/bank-bu-worker/operation-receipt-repository.js |
| `rowText` | 3 | 7 | 1 | src/main-process/duplicate-inbound-match/spool-reader.js |
| `saxAttributeIdentity` | 3 | 7 | 1 | src/backend/toolbox-format/ooxml-namespaces.js |
| `sourceRecords` | 3 | 7 | 1 | src/main-process/position-reconciliation/matching-engine.js |
| `SourceStyleRegistry` | 3 | 7 | 3 | src/backend/toolbox-format/biff8-pass.js |
| `syncStagedFile` | 3 | 7 | 1 | src/main-process/archive-center/storage-materializer.js |
| `v8` | 3 | 7 | 3 | src/backend/biz-op-recon-import/import-worker.js |
| `validateAcquiringExportResult` | 3 | 7 | 1 | src/main-process/read-only-exports/acquiring/policies.js |
| `validateBizOpReadOnlyExportResult` | 3 | 7 | 2 | src/main-process/read-only-exports/biz-op/business-validator.js |
| `validateContract` | 3 | 7 | 3 | src/backend/big-table-import/contract.js |
| `validateGeneratedWorkbook` | 3 | 7 | 2 | src/main-process/toolbox-background/multi-output-validator.js |
| `validatePendingReadOnlyExportResult` | 3 | 7 | 2 | src/main-process/read-only-exports/pending/business-validator.js |
| `validatePositionReadOnlyExportResult` | 3 | 7 | 2 | src/main-process/read-only-exports/position/business-validator.js |
| `validatePreFundReadOnlyExportResult` | 3 | 7 | 2 | src/main-process/read-only-exports/pre-fund/business-validator.js |
| `validatePureComputeCanaryResult` | 3 | 7 | 1 | src/main-process/background-execution/canary/pure-compute.js |
| `validateReconFixExportResult` | 3 | 7 | 1 | src/main-process/recon-id-fix-service/policies.js |
| `validateReconFixJpmResult` | 3 | 7 | 1 | src/main-process/recon-id-fix-service/policies.js |
| `validateReconFixServiceResult` | 3 | 7 | 1 | src/main-process/recon-id-fix-service/policies.js |
| `validateStatementGenerationResult` | 3 | 7 | 2 | src/main-process/statement-worker/generation-contracts.js |
| `validateVccExportSingleResult` | 3 | 7 | 1 | src/main-process/vcc-financial-op-output/policies.js |
| `validateVccFinancialOpReadOnlyExportResult` | 3 | 7 | 2 | src/main-process/read-only-exports/vcc-financial-op/business-validator.js |
| `waitForExternalParserShutdownPhase` | 3 | 7 | 1 | src/main-process/background-execution/external-parser-finalization.js |
| `WORKER_SCRIPT_PATH` | 3 | 7 | 3 | src/backend/big-table-import/pipeline.js |
| `writeBizOpErrorReportXlsx` | 3 | 7 | 1 | src/main-process/biz-op-recon-writer.js |
| `writeFlowErrorReportXlsx` | 3 | 7 | 1 | src/main-process/biz-op-recon-writer.js |
| `writeResultWorkbook` | 3 | 7 | 2 | src/main-process/position-reconciliation/excel-io.js |
| `xmlUnescape` | 3 | 7 | 3 | src/backend/acquiring-bill-currency-import/reader-handrolled.js |
| `ZHONGTAI_REFUND_ORDER_SIGNATURE` | 3 | 7 | 2 | src/constants/refund-backfill-fields.js |
| `acknowledgeRunByTaskRun` | 3 | 6 | 1 | src/main-process/biz-op-recon-run-data.js |
| `assertBizOpSourceSnapshot` | 3 | 6 | 1 | src/main-process/read-only-exports/biz-op/query.js |
| `assertExcelStXstringRawLength` | 3 | 6 | 1 | src/backend/toolbox-format/excel-text.js |
| `assertExpectedResultRevision` | 3 | 6 | 1 | src/backend/vcc-financial-op/result-adjustments.js |
| `assertPositionSourceSnapshot` | 3 | 6 | 1 | src/main-process/read-only-exports/position/query.js |
| `assertPreFundSourceSnapshot` | 3 | 6 | 1 | src/main-process/read-only-exports/pre-fund/query.js |
| `assertSourceFileMatchesSync` | 3 | 6 | 1 | src/backend/vcc-financial-op/source-lineage.js |
| `BASE_RESOURCES` | 3 | 6 | 3 | src/main-process/background-execution/acquiring-adapter-policies.js |
| `batchMatchesReceiptEvidence` | 3 | 6 | 1 | src/main-process/pre-fund-reconciliation/mpt-import/business-evidence.js |
| `beginExternalParserShutdown` | 3 | 6 | 1 | src/main-process/background-execution/external-parser-finalization.js |
| `buildDeleteTargetTokenV2` | 3 | 6 | 1 | src/backend/vcc-financial-op/operation-token-v2.js |
| `buildOperationTokenV2` | 3 | 6 | 1 | src/backend/vcc-financial-op/operation-token-v2.js |
| `C4_CATEGORIES` | 3 | 6 | 3 | src/main-process/fund-recon-worker/evidence-provider.js |
| `CHANNEL_VALUE` | 3 | 6 | 2 | src/backend/database/linked-table-repository.js |
| `classifyNumericOutput` | 3 | 6 | 1 | src/backend/toolbox-format/number-date.js |
| `cleanupMptSpoolParents` | 3 | 6 | 3 | src/main-process/pre-fund-reconciliation/mpt-import/managed-import.js |
| `clearMonth` | 3 | 6 | 2 | src/backend/acquiring-bill-currency-db/import-repository.js |
| `columnLetterToIndex` | 3 | 6 | 2 | src/backend/acquiring-bill-currency-import/reader.js |
| `commitMirrorCas` | 3 | 6 | 2 | src/main-process/bank-bu-worker/main-coordinator.js |
| `compareCanonicalDecimals` | 3 | 6 | 1 | src/main-process/financial-decimal.js |
| `compileRegexLiteral` | 3 | 6 | 1 | src/backend/file-service/normalizers.js |
| `computeRowHash` | 3 | 6 | 3 | src/backend/pending-import/contract-pending.js |
| `configureDatabase` | 3 | 6 | 3 | src/backend/position-reconciliation-import/account-writer.js |
| `createExistingDispatchAdapter` | 3 | 6 | 2 | src/main-process/background-execution/adapters/existing-dispatch-adapter.js |
| `createInlineAsyncAdapter` | 3 | 6 | 3 | src/main-process/background-execution/adapters/inline-async-adapter.js |
| `createPlatformResourceBudgets` | 3 | 6 | 2 | src/main-process/background-execution/resource-budget.js |
| `createPreFundReconciliationStore` | 3 | 6 | 1 | src/backend/pre-fund-reconciliation-store.js |
| `createServiceHost` | 3 | 6 | 2 | src/main-process/background-execution/index.js |
| `createSourceStyleRegistryFromOoxml` | 3 | 6 | 1 | src/backend/toolbox-format/style-registry.js |
| `createStatementPublicInteractionDto` | 3 | 6 | 1 | src/main-process/statement-worker/contracts.js |
| `createStorageMaterializer` | 3 | 6 | 1 | src/main-process/archive-center/storage-materializer.js |
| `createTaskPolicyRegistry` | 3 | 6 | 2 | src/main-process/archive-center/operation-tracker.js |
| `DATE_MISMATCH_WARNING_CODE` | 3 | 6 | 3 | src/main-process/scenario-engines/dbs-charge-fund-check.js |
| `delay` | 3 | 6 | 2 | src/main-process/bank-bu-worker/spool-reader.js |
| `deleteMonthSideDb` | 3 | 6 | 3 | src/main-process/acquiring-bill-currency-run-data.js |
| `derivePreFundMptConflictScopeKey` | 3 | 6 | 1 | src/main-process/pre-fund-reconciliation/mpt-import/conflict-scope.js |
| `deriveReconFixJpmDatabaseIdentity` | 3 | 6 | 1 | src/main-process/recon-id-fix-service/jpm-database-authority.js |
| `DIRECTION_MISMATCH_WARNING_CODE` | 3 | 6 | 3 | src/main-process/scenario-engines/dbs-charge-fund-check.js |
| `evaluateUnarchiveGate` | 3 | 6 | 2 | src/backend/vcc-financial-op/destructive-write.js |
| `executePureComputeCanary` | 3 | 6 | 2 | src/main-process/background-execution/canary/pure-compute-worker.js |
| `executeVccExportWriter` | 3 | 6 | 3 | src/main-process/vcc-financial-op-output/shard-writer-worker-entry.js |
| `flowRowToArray` | 3 | 6 | 1 | src/backend/biz-op-recon-db/columns.js |
| `freezePendingDatasetSeedV1` | 3 | 6 | 2 | src/backend/pending-db/dataset-identity.js |
| `FUND_TRANSFER_RECON_UNUSED` | 3 | 6 | 1 | src/constants/fund-transfer-recon-fields.js |
| `FUND_TYPE_PAIRS` | 3 | 6 | 1 | src/main-process/position-reconciliation/constants.js |
| `getAmountSplitRules` | 3 | 6 | 1 | src/backend/database/template-repository.js |
| `getMirrorRun` | 3 | 6 | 2 | src/main-process/bank-bu-recon-run-data.js |
| `getReconIdFixOutputContract` | 3 | 6 | 1 | src/main-process/recon-id-fix-io.js |
| `groupBigAccountRows` | 3 | 6 | 2 | src/backend/database/utils.js |
| `handleControl` | 3 | 6 | 1 | src/main-process/recon-id-fix-service/worker-entry.js |
| `hslToRgb` | 3 | 6 | 3 | src/backend/toolbox-format/biff8-colors.js |
| `identityFromPendingDatasetSeed` | 3 | 6 | 2 | src/backend/pending-db/dataset-identity.js |
| `initializeActionTaskBindingStartup` | 3 | 6 | 2 | src/main-process/background-execution/action-task-binding-registry.js |
| `inspectFiles` | 3 | 6 | 2 | src/backend/vcc-financial-op/import-service.js |
| `inspectionObservationSafePayload` | 3 | 6 | 1 | src/main-process/background-execution/recovery-hold-request.js |
| `inspectSealedRouteDb` | 3 | 6 | 2 | src/main-process/toolbox-background/multi-output-validator.js |
| `inspectSourceFiles` | 3 | 6 | 3 | src/backend/vcc-financial-op/detail-importer.js |
| `isPositionImportCancellationLocked` | 3 | 6 | 1 | src/backend/position-reconciliation-import/constants.js |
| `isPositionImportMutatingCommand` | 3 | 6 | 1 | src/backend/position-reconciliation-import/constants.js |
| `isPreFundMptConflictScopeKey` | 3 | 6 | 2 | src/main-process/pre-fund-reconciliation/mpt-import/conflict-scope.js |
| `isRegexLiteral` | 3 | 6 | 1 | src/backend/file-service/normalizers.js |
| `JOURNAL_INDEX_NAME` | 3 | 6 | 2 | src/main-process/toolbox-output-publication-dispatch.js |
| `listAdjustmentOptions` | 3 | 6 | 1 | src/backend/vcc-financial-op/result-adjustments.js |
| `listArchivedResultMonths` | 3 | 6 | 1 | src/backend/vcc-financial-op/unarchive.js |
| `listGatewayBillSourceTags` | 3 | 6 | 1 | src/backend/database/linked-table-repository.js |
| `listImportRecords` | 3 | 6 | 1 | src/backend/vcc-financial-op-db/repository.js |
| `listRunsByDateBu` | 3 | 6 | 1 | src/backend/biz-op-recon-db/run-repository.js |
| `loadCurrencyMappings` | 3 | 6 | 2 | src/backend/file-service.js |
| `loadSharedStringsProvider` | 3 | 6 | 1 | src/backend/position-reconciliation-import/shared-strings-provider.js |
| `makeRowInserter` | 3 | 6 | 2 | src/backend/biz-op-recon-db/flow-imports-repository.js |
| `nextDatasetIdentity` | 3 | 6 | 1 | src/backend/biz-op-recon-db/dataset-head-repository.js |
| `normalizeBillDate` | 3 | 6 | 3 | src/backend/acquiring-bill-currency-db/import-repository.js |
| `normalizeMptRow` | 3 | 6 | 1 | src/main-process/pre-fund-reconciliation/mpt-schema.js |
| `openToolboxXlsxPass` | 3 | 6 | 1 | src/backend/toolbox-format/xlsx-pass.js |
| `ORDER_REPAIR_FIELDS` | 3 | 6 | 2 | src/constants/recon-id-fix-fields.js |
| `PACKAGE_RELATIONSHIP_NAMESPACES` | 3 | 6 | 1 | src/backend/toolbox-format/ooxml-namespaces.js |
| `parseFtaDate` | 3 | 6 | 2 | src/main-process/scenario-engines/engine-week-utils.js |
| `PARSER_ENTRY` | 3 | 6 | 3 | src/main-process/bank-bu-worker/dual-parser-dispatch.js |
| `PAYMENT_OFFLINE_FIELD_MAP` | 3 | 6 | 1 | src/constants/payment-offline-allocation-fields.js |
| `POSITION_READ_ONLY_ACTION_SET` | 3 | 6 | 3 | src/main-process/read-only-exports/position/actions.js |
| `postImageFromSide` | 3 | 6 | 2 | src/main-process/bank-bu-worker/main-coordinator.js |
| `prepareStoredBankRows` | 3 | 6 | 2 | src/main-process/duplicate-inbound-match/import-model.js |
| `prepareToolboxPublication` | 3 | 6 | 1 | src/main-process/toolbox-output-publication.js |
| `previewUnarchive` | 3 | 6 | 1 | src/backend/vcc-financial-op/unarchive.js |
| `publishPreparedToolboxPublication` | 3 | 6 | 1 | src/main-process/toolbox-output-publication.js |
| `readBalanceAdjustments` | 3 | 6 | 1 | src/main-process/statement-generation-business.js |
| `readBankDepositBocCandidates` | 3 | 6 | 1 | src/backend/database/linked-table-repository.js |
| `readBankDepositHitMarkers` | 3 | 6 | 1 | src/backend/database/linked-table-repository.js |
| `readBatchActualCounts` | 3 | 6 | 1 | src/main-process/pre-fund-reconciliation/mpt-import/business-evidence.js |
| `readBocFxLinkRows` | 3 | 6 | 2 | src/backend/database/linked-table-repository.js |
| `readBocFxLinkRowsWithIds` | 3 | 6 | 1 | src/backend/database/linked-table-repository.js |
| `readMptHeader` | 3 | 6 | 3 | src/main-process/pre-fund-reconciliation/mpt-import/hold-gate.js |
| `readReconFixArtifactEvidence` | 3 | 6 | 3 | src/main-process/recon-id-fix-service/artifact-evidence.js |
| `RECON_FIX_POLICIES` | 3 | 6 | 1 | src/main-process/recon-id-fix-service/policies.js |
| `reconcileOrphans` | 3 | 6 | 3 | src/main-process/acquiring-bill-currency-run-data.js |
| `recordExportPath` | 3 | 6 | 2 | src/main-process/bank-bu-recon-run-data.js |
| `recoverPendingToolboxPublications` | 3 | 6 | 1 | src/main-process/toolbox-output-publication.js |
| `registerExternalParserFinalization` | 3 | 6 | 1 | src/main-process/background-execution/external-parser-finalization.js |
| `rematchAllBocGroups` | 3 | 6 | 1 | src/main-process/boc-fx-link-builder.js |
| `replaceAdmBankDeposit` | 3 | 6 | 1 | src/backend/database/linked-table-repository.js |
| `replaceBocBankDeposit` | 3 | 6 | 1 | src/backend/database/linked-table-repository.js |
| `resolveArchiveScope` | 3 | 6 | 3 | src/main-process/archive-center/module-scope-registry.js |
| `runMigrations` | 3 | 6 | 3 | src/backend/pending-db.js |
| `runReconIdFix` | 3 | 6 | 3 | src/main-process/recon-id-fix-engine.js |
| `runStartupPhase` | 3 | 6 | 3 | src/backend/startup-phase.js |
| `stableRowGuardHash` | 3 | 6 | 1 | src/backend/position-reconciliation-import/contracts.js |
| `streamDetailRows` | 3 | 6 | 3 | src/backend/vcc-financial-op/detail-importer.js |
| `streamDocumentStatement` | 3 | 6 | 2 | src/main-process/duplicate-inbound-match/document-statement-reader.js |
| `subOneDay` | 3 | 6 | 2 | src/backend/biz-op-recon-db/run-repository.js |
| `SUPPORTED_EXTENSIONS` | 3 | 6 | 1 | src/backend/file-service/common.js |
| `toSafeMptErrorFields` | 3 | 6 | 2 | src/main-process/pre-fund-reconciliation/mpt-import/file-result-safety.js |
| `Transform` | 3 | 6 | 3 | src/main-process/archive-center/archive-service.js |
| `validateBizOpHeaders` | 3 | 6 | 1 | src/backend/biz-op-recon-import/validator.js |
| `validateBizOpRow` | 3 | 6 | 2 | src/backend/biz-op-recon-import/import-worker.js |
| `validateFundTransferDirections` | 3 | 6 | 1 | src/main-process/scenario-engines/fund-transfer-engine-policy.js |
| `validateResult` | 3 | 6 | 2 | src/main-process/background-execution/critical/recovery-control-read-repository.js |
| `validateToolboxGenerationResult` | 3 | 6 | 1 | src/main-process/toolbox-background/generation-contract.js |
| `VCC_FINANCIAL_OP_READ_ONLY_ACTION_SET` | 3 | 6 | 2 | src/main-process/read-only-exports/vcc-financial-op/policies.js |
| `WORKBOOK_RELS_ENTRY_NAME` | 3 | 6 | 1 | src/backend/big-table-import/zip-reader.js |
| `WORKER_RESOURCES` | 3 | 6 | 3 | src/main-process/read-only-exports/biz-op/policies.js |
| `writeBocFxLinkReconIds` | 3 | 6 | 1 | src/backend/database/linked-table-repository.js |
| `writeDatasetWorkbook` | 3 | 6 | 3 | src/backend/vcc-financial-op/worker-entry.js |
| `writeImportAuditWorkbook` | 3 | 6 | 3 | src/main-process/read-only-exports/vcc-financial-op/writer.js |
| `writePendingErrorReport` | 3 | 6 | 1 | src/backend/pending-export/error-report-writer.js |
| `writePlatformCleanupOutput` | 3 | 6 | 3 | src/main-process/fund-recon-worker/artifact-generator.js |
| `writeRefundBackfillOutput` | 3 | 6 | 3 | src/main-process/fund-recon-worker/artifact-generator.js |
| `writeRunFilteredSourcesWorkbook` | 3 | 6 | 1 | src/main-process/position-reconciliation/filtered-source-report.js |
| `writeScenarioHitRows` | 3 | 6 | 2 | src/main-process/fund-recon-worker/artifact-generator.js |
| `__test_only_set_worker_script__` | 3 | 5 | 3 | src/main-process/run-check-multiworker.js |
| `addRunAdjustment` | 3 | 5 | 1 | src/backend/vcc-financial-op/result-adjustments.js |
| `ALL_BANKS_TEMPLATE_SCOPE` | 3 | 5 | 2 | src/main-process/monthly-balance.js |
| `ALL_TABLE_SIGNATURES` | 3 | 5 | 2 | src/constants/table-signatures.js |
| `assertStagedInputUnchanged` | 3 | 5 | 1 | src/main-process/position-reconciliation/input-staging.js |
| `bankCreditAmount` | 3 | 5 | 1 | src/main-process/scenario-engines/r5-payment-offline-allocation-backfill.js |
| `bizOpRunOutputIntent` | 3 | 5 | 1 | src/main-process/biz-op-archive-lineage.js |
| `buildAdmRows` | 3 | 5 | 2 | src/main-process/adm-bank-deposit-builder.js |
| `buildFundTransferReconRows` | 3 | 5 | 2 | src/main-process/fund-transfer-recon-builder.js |
| `buildStaleHitReminder` | 3 | 5 | 1 | src/main-process/scenario-engines/r5-refund-order-backfill.js |
| `buildVccSubjectAuthority` | 3 | 5 | 1 | src/main-process/vcc-financial-op-output/subject-evidence.js |
| `compareVccSubjects` | 3 | 5 | 1 | src/main-process/vcc-financial-op-output/subject-evidence.js |
| `createArchiveRepository` | 3 | 5 | 1 | src/backend/database/archive-repository.js |
| `createDuplicateInboundMatchService` | 3 | 5 | 2 | src/main-process/duplicate-inbound-match/managed-service.js |
| `createMptRowAggregateError` | 3 | 5 | 2 | src/main-process/pre-fund-reconciliation/mpt-import/single-writer-session.js |
| `createStatementGenerationHelpers` | 3 | 5 | 2 | src/main-process/statement-generation-business.js |
| `createValuesByFieldAccumulator` | 3 | 5 | 1 | src/main-process/toolbox.js |
| `deleteDataset` | 3 | 5 | 1 | src/backend/vcc-financial-op/dataset-deletion.js |
| `encodeExcelStXstring` | 3 | 5 | 1 | src/backend/toolbox-format/excel-text.js |
| `exportToolboxMultiFilters` | 3 | 5 | 1 | src/main-process/toolbox-format-operations.js |
| `freezeDatasetSeedV1` | 3 | 5 | 2 | src/backend/biz-op-recon-db/dataset-head-repository.js |
| `freezeFlowDatasetSeedV1` | 3 | 5 | 2 | src/backend/biz-op-recon-db/dataset-head-repository.js |
| `getEnabledModules` | 3 | 5 | 1 | src/backend/database/settings-repository.js |
| `getGatewayBillRawJsonById` | 3 | 5 | 1 | src/backend/database/linked-table-repository.js |
| `getImportBatch` | 3 | 5 | 1 | src/backend/vcc-financial-op-db/repository.js |
| `getRecoveryAuditByOperation` | 3 | 5 | 1 | src/backend/database/duplicate-inbound-match-run-repository.js |
| `getRule` | 3 | 5 | 1 | src/backend/pending-db/rule-repository.js |
| `getUiStyle` | 3 | 5 | 1 | src/backend/database/settings-repository.js |
| `iterateGatewayBillRows` | 3 | 5 | 1 | src/backend/database/linked-table-repository.js |
| `lettersToIndex` | 3 | 5 | 2 | src/backend/pending-import/streaming-xlsx-reader.js |
| `listDeleteTargets` | 3 | 5 | 1 | src/backend/vcc-financial-op/data-target-deletion.js |
| `listImportMonths` | 3 | 5 | 1 | src/backend/vcc-financial-op-db/repository.js |
| `listImportSources` | 3 | 5 | 1 | src/backend/vcc-financial-op-db/repository.js |
| `listReadyDates` | 3 | 5 | 1 | src/backend/biz-op-recon-db/run-repository.js |
| `listScenarios` | 3 | 5 | 1 | src/backend/database/scenarios-repository.js |
| `loadResultTemplateContract` | 3 | 5 | 1 | src/backend/vcc-financial-op/result-template-contract.js |
| `mergeBankStatementRows` | 3 | 5 | 2 | src/main-process/bank-statement-merge.js |
| `mergeToolboxFilesToXlsx` | 3 | 5 | 2 | src/main-process/toolbox-background/generation-core.js |
| `pickStaleHits` | 3 | 5 | 1 | src/main-process/scenario-engines/r5-refund-order-backfill.js |
| `PRE_FUND_MPT_POLICIES` | 3 | 5 | 1 | src/main-process/pre-fund-reconciliation/mpt-import/policies.js |
| `readBankDepositAdmCandidates` | 3 | 5 | 1 | src/backend/database/linked-table-repository.js |
| `readBizOpFile` | 3 | 5 | 1 | src/backend/biz-op-recon-import/reader.js |
| `readBocFxLinkRowsForRematch` | 3 | 5 | 1 | src/backend/database/linked-table-repository.js |
| `readFlowFile` | 3 | 5 | 1 | src/backend/biz-op-recon-import/reader.js |
| `readFundTransferReconRows` | 3 | 5 | 1 | src/backend/database/linked-table-repository.js |
| `readGatewayBillRowPoolsByChannels` | 3 | 5 | 1 | src/backend/database/linked-table-repository.js |
| `recoverToolboxPublicationsIntoArchive` | 3 | 5 | 1 | src/main-process/toolbox-archive-recovery.js |
| `recoverVccStorageMigration` | 3 | 5 | 1 | src/main-process/vcc-financial-op-storage-rebuild.js |
| `replaceFundTransferReconRows` | 3 | 5 | 1 | src/backend/database/linked-table-repository.js |
| `resolveFundTransferDatePolicy` | 3 | 5 | 2 | src/main-process/fund-recon-worker/evidence-provider.js |
| `runAllScenarios` | 3 | 5 | 3 | src/main-process/reconciliation-orchestrator.js |
| `scanToolboxSplitFields` | 3 | 5 | 1 | src/main-process/toolbox-format-operations.js |
| `setEnabledModules` | 3 | 5 | 1 | src/backend/database/settings-repository.js |
| `setReconIdFixBillCategory` | 3 | 5 | 1 | src/backend/database/settings-repository.js |
| `unarchiveMonth` | 3 | 5 | 1 | src/backend/vcc-financial-op/unarchive.js |
| `writeAggregateDiffWorkbook` | 3 | 5 | 1 | src/main-process/bank-bu-recon-writer.js |
| `writeBocFxLinkGroupRematch` | 3 | 5 | 1 | src/backend/database/linked-table-repository.js |
| `writeDateRangeDiffWorkbook` | 3 | 5 | 1 | src/main-process/biz-op-recon-writer.js |
| `writeSingleDateDiffWorkbook` | 3 | 5 | 1 | src/main-process/biz-op-recon-writer.js |
| `actionTaskBindingRegistry` | 3 | 4 | 1 | src/main.js |
| `assertExpectedHead` | 3 | 4 | 1 | src/backend/biz-op-recon-db/dataset-head-repository.js |
| `assertNoPending` | 3 | 4 | 1 | src/backend/biz-op-recon-db/month-end-copy-intent-repository.js |
| `clearByDate` | 3 | 4 | 1 | src/backend/biz-op-recon-db/flow-imports-repository.js |
| `clearRunsAndDiffsByDate` | 3 | 4 | 1 | src/backend/biz-op-recon-db/run-repository.js |
| `countRowsInMonth` | 3 | 4 | 1 | src/backend/pending-db/month-repository.js |
| `createImportBatch` | 3 | 4 | 1 | src/backend/vcc-financial-op-db/repository.js |
| `createLegacyRun` | 3 | 4 | 1 | src/backend/pending-db/diff-repository.js |
| `deleteDataTarget` | 3 | 4 | 1 | src/backend/vcc-financial-op/data-target-deletion.js |
| `findByNameAndLocation` | 3 | 4 | 1 | src/backend/database/channels-repository.js |
| `finishImportBatch` | 3 | 4 | 1 | src/backend/vcc-financial-op-db/repository.js |
| `getApplicableChannelIds` | 3 | 4 | 1 | src/backend/database/scenarios-repository.js |
| `getBuiltinGeneral` | 3 | 4 | 1 | src/backend/database/channels-repository.js |
| `importMonthAtomic` | 3 | 4 | 1 | src/backend/bank-bu-recon-db/month-repository.js |
| `isEmptyValue` | 3 | 4 | 1 | src/main-process/scenario-engines/engine-utils.js |
| `iterateChannelExports` | 3 | 4 | 1 | src/main-process/pre-fund-reconciliation/output-mapper.js |
| `iterateExportableImportAnomalies` | 3 | 4 | 1 | src/backend/vcc-financial-op-db/repository.js |
| `listByMonth` | 3 | 4 | 1 | src/backend/pending-db/removed-repository.js |
| `listLatestRunsByMonthPair` | 3 | 4 | 1 | src/backend/pending-db/diff-repository.js |
| `listSuccessDates` | 3 | 4 | 1 | src/backend/biz-op-recon-db/run-repository.js |
| `normalizeNewAccountAccounts` | 3 | 4 | 1 | src/main-process/new-account/generation-core.js |
| `openWorkbook` | 3 | 4 | 1 | src/backend/position-reconciliation-import/xls-reader.js |
| `readGatewayRecon` | 3 | 4 | 1 | src/main-process/bank-statement-io.js |
| `readReconIdFixFile` | 3 | 4 | 1 | src/main-process/recon-id-fix-io.js |
| `readXlsxSheetMetaLite` | 3 | 4 | 2 | src/backend/file-service/readers.js |
| `runBizOpImportViaWorker` | 3 | 4 | 1 | src/main-process/biz-op-recon-session.js |
| `runFlowImportViaWorker` | 3 | 4 | 1 | src/main-process/biz-op-recon-session.js |
| `sanitizeBankName` | 3 | 4 | 3 | src/backend/balance-adjustment-store.js |
| `validateNewAccountAccounts` | 3 | 4 | 1 | src/main-process/new-account/generation-core.js |
| `buildTimestampMinute` | 3 | 3 | 2 | src/main-process/bank-statement-io.js |

## A-pair — 跨 2 文件

| 名字 | 总次数 | 声明位置（首个） |
|---|---:|---|
| `adapterError` | 70 | src/main-process/background-execution/adapters/acquiring-adapter.js |
| `VccStorageMigrationError` | 66 | src/main-process/vcc-financial-op-storage-rebuild.js |
| `exportError` | 61 | src/main-process/recon-id-fix-service/export-operation.js |
| `ResourceGovernorError` | 49 | src/main-process/background-execution/resource-lease.js |
| `addReason` | 42 | src/backend/vcc-financial-op/archive-contract.js |
| `safeHash` | 41 | src/main-process/recon-id-fix-service/policies.js |
| `normalizeKey` | 38 | src/backend/database/linked-table-repository.js |
| `ServiceHostProtocolError` | 37 | src/main-process/background-execution/service-host.js |
| `templateRepository` | 33 | src/backend/database.js |
| `countValue` | 31 | src/backend/vcc-financial-op/dataset-deletion.js |
| `contractError` | 30 | src/main-process/read-only-exports/common/contract.js |
| `rowValue` | 29 | src/backend/vcc-financial-op/row-mapper.js |
| `tablePolicy` | 29 | src/backend/vcc-financial-op/mutation-policy.js |
| `normalizedSource` | 28 | src/main-process/recon-id-fix-service/jpm-writeback-plan.js |
| `routeError` | 28 | src/main-process/toolbox-background/route-db-contract.js |
| `resumeError` | 27 | src/main-process/acquiring-bill-currency-run-data.js |
| `pendingRequests` | 26 | src/main-process/recon-id-fix-service/worker-entry.js |
| `ContractValidationError` | 25 | src/backend/big-table-import/contract.js |
| `optionalText` | 25 | src/backend/database/archive-repository.js |
| `StartupRecoveryError` | 24 | src/main-process/background-execution/startup-recovery-coordinator.js |
| `HIT_TYPES` | 23 | src/main-process/position-reconciliation/contracts.js |
| `NEW_ACCOUNT_GENERATION_SHAPE_LIMITS` | 22 | src/main-process/new-account/generation-contract.js |
| `publicArtifact` | 22 | src/main-process/archive-center/archive-service.js |
| `scenariosRepository` | 22 | src/backend/database.js |
| `ownerRow` | 21 | src/main-process/background-execution/critical/recovery-request-owner-repository.js |
| `isObjectRecord` | 20 | src/main-process/duplicate-inbound-match/matching-engine.js |
| `refreshBankStatementStatus` | 20 | src/renderer.js |
| `bankRowKey` | 19 | src/main-process/duplicate-inbound-match/matching-engine.js |
| `deepClone` | 19 | src/backend/vcc-financial-op/result-template-contract.js |
| `fatalError` | 19 | src/main-process/position-reconciliation/import-dispatch.js |
| `safeName` | 19 | src/main-process/archive-center/archive-service.js |
| `TEMPLATE_LABEL` | 19 | src/backend/pending-import/removed-reader.js |
| `VCC_STORAGE_CONTRACT_VERSION` | 19 | src/backend/vcc-financial-op-db/storage-contract.js |
| `BANK_FUND_TYPE_FIELD` | 18 | src/main-process/scenario-engines/dbs-charge-fund-check.js |
| `nonNegativeInteger` | 18 | src/main-process/read-only-exports/vcc-financial-op/actions.js |
| `SafeErrorValidationError` | 18 | src/main-process/background-execution/error-codec.js |
| `canary` | 17 | src/main-process/background-execution/canary/packaged-runtime-runner.js |
| `DIFF_TABLE` | 17 | src/backend/acquiring-bill-currency-db/run-repository.js |
| `exactObject` | 17 | src/main-process/background-execution/critical/recovery-request-owner-repository.js |
| `PipelineError` | 17 | src/backend/big-table-import/engine.js |
| `selectedValues` | 17 | src/main-process/vcc-financial-op-dataset-writer.js |
| `taskPolicyRegistry` | 17 | src/main.js |
| `TOOLBOX_PROJECTION_PROFILES` | 17 | src/backend/toolbox-format/model.js |
| `updateJournal` | 17 | src/main-process/vcc-financial-op-storage-rebuild.js |
| `admissionError` | 16 | src/main-process/pre-fund-reconciliation/mpt-import/spool-admission.js |
| `canonicalStoredAmount` | 16 | src/backend/vcc-financial-op/result-adjustments.js |
| `ImportValidationError` | 16 | src/backend/acquiring-bill-currency-import/reader.js |
| `REMOVED_PENDING_COLUMNS` | 16 | src/backend/pending-export/writer.js |
| `storageContractVersion` | 16 | src/main-process/vcc-financial-op-storage-rebuild.js |
| `ACTION_TASK_BINDING_CONTRACT` | 15 | src/main-process/background-execution/action-task-binding-registry.js |
| `lastPendingBigAccountSelection` | 15 | src/main.js |
| `reloadReconIdFixScenarios` | 15 | src/renderer.js |
| `transaction` | 15 | src/main-process/position-reconciliation/common.js |
| `BOC_FX_TABLE` | 14 | src/backend/database/linked-table-repository.js |
| `coordinateKey` | 14 | src/backend/vcc-financial-op/result-adjustments.js |
| `jsonSnapshot` | 14 | src/main-process/background-execution/action-manifest.js |
| `parsedJson` | 14 | src/backend/position-reconciliation-import/ledger.js |
| `requirePositionPendingArchiveFiles` | 14 | src/main-process/position-reconciliation/operation-lifecycle.js |
| `sanitizeAmountValue` | 14 | src/backend/file-service/normalizers.js |
| `toCents` | 14 | src/main-process/boc-fx-link-builder.js |
| `AUDIT_FIELDS` | 13 | src/main-process/position-reconciliation/contracts.js |
| `dateIso` | 13 | src/main-process/toolbox-output-publication.js |
| `ERROR_CODE` | 13 | src/backend/pending-import/removed-reader.js |
| `HASH` | 13 | src/main-process/recon-id-fix-service/jpm-outcome-inspector.js |
| `normalizeAccountKey` | 13 | src/main-process/biz-op-recon-session.js |
| `normalizeLocalDate` | 13 | src/backend/database/archive-repository.js |
| `refreshTemplates` | 13 | src/renderer.js |
| `REQUIRED_DATASET_TYPES` | 13 | src/backend/vcc-financial-op/calculator.js |
| `usesModernSourceIdentity` | 13 | src/main-process/position-reconciliation/store.js |
| `xmlAttribute` | 13 | src/main-process/recon-id-fix-service/artifact-evidence.js |
| `zipReader` | 13 | src/backend/big-table-import/engine.js |
| `cleanupStagingPaths` | 12 | src/main-process/position-reconciliation/input-staging.js |
| `GATEWAY_SOURCE` | 12 | src/main-process/pre-fund-reconciliation/matching-engine.js |
| `getCurrencyOptionEntries` | 12 | src/renderer.js |
| `lastPendingBalanceSeedConfirmation` | 12 | src/main.js |
| `OBJECT_OVERHEAD_BYTES` | 12 | src/main-process/fund-recon-worker/state-footprint.js |
| `OPERATION_TOKEN_VERSION` | 12 | src/backend/vcc-financial-op/operation-state.js |
| `removalMatch` | 12 | src/backend/pending-export/writer.js |
| `sameJobRef` | 12 | src/main-process/duplicate-inbound-match/worker-host.js |
| `sheetToObjects` | 12 | src/main-process/bank-statement-io.js |
| `ZERO` | 12 | src/main-process/bank-bu-worker/policies.js |
| `BANK_EXTRA_FEE_FIELD` | 11 | src/main-process/scenario-engines/r4-fund-nature-check.js |
| `BIZ_OP_ACCOUNT_KEY_DB_COLUMN` | 11 | src/backend/biz-op-recon-db/columns.js |
| `canonicalFilePlan` | 11 | src/main-process/vcc-financial-op-output/dispatch.js |
| `checkCancelled` | 11 | src/main-process/bank-bu-worker/spool-writer.js |
| `estimateValueBytes` | 11 | src/main-process/fund-recon-worker/state-footprint.js |
| `GatewayRowValidationError` | 11 | src/main-process/pre-fund-reconciliation/matching-engine.js |
| `MANUAL_BALANCE_ACTION_KEY` | 11 | src/main-process/manual-balance-seed-settlement.js |
| `normalizeBorderSide` | 11 | src/backend/toolbox-format/biff8-overlay.js |
| `PRIORITIES` | 11 | src/main-process/background-execution/admission-queue.js |
| `publicBatch` | 11 | src/main-process/archive-center/archive-service.js |
| `realDirectory` | 11 | src/main-process/bank-bu-worker/spool-filesystem.js |
| `rendererPending` | 11 | src/renderer.js |
| `safeAdd` | 11 | src/main-process/vcc-op-calc/ordered-reducer.js |
| `sourceStat` | 11 | src/main-process/new-account/artifact-copy.js |
| `TOOLBOX_XLSX_METADATA_LIMITS` | 11 | src/backend/toolbox-format/xlsx-pass.js |
| `assertSourcesFresh` | 10 | src/main-process/toolbox-background/generation-core.js |
| `datasetLineageIntent` | 10 | src/main-process/biz-op-archive-lineage.js |
| `DIFFERENCE_STATUSES` | 10 | src/main-process/position-reconciliation/constants.js |
| `electronUtilityProcess` | 10 | src/main-process/biz-op-recon-session.js |
| `errorResult` | 10 | src/main-process/pre-fund-reconciliation/mpt-import/single-writer-session.js |
| `FUND_TYPES` | 10 | src/main-process/duplicate-inbound-match/matching-engine.js |
| `getTemplate` | 10 | src/backend/database/template-repository.js |
| `lastFileImportContext` | 10 | src/main.js |
| `NODE_MAX_OLD_SPACE_MB` | 10 | src/main-process/biz-op-recon-session.js |
| `normalizeRgb` | 10 | src/backend/toolbox-format/biff8-colors.js |
| `ownDataValue` | 10 | src/main-process/background-execution/adapters/worker-thread-adapter.js |
| `REPORT_CHECK_KEYS` | 10 | src/main-process/background-execution/canary/packaged-runtime-request.js |
| `runArchiveRootOperation` | 10 | src/main-process/archive-center/archive-service.js |
| `SOURCE_TARGET_TYPES` | 10 | src/backend/vcc-financial-op/read-snapshot.js |
| `statIdentity` | 10 | src/backend/vcc-financial-op/result-template-contract.js |
| `workerDbPath` | 10 | src/main-process/run-check-worker-pool.js |
| `ARCHIVE_STORAGE_ROOT_SETTING_KEY` | 9 | src/backend/database/archive-repository.js |
| `canonicalJsonValue` | 9 | src/backend/vcc-financial-op/operation-state.js |
| `cloneStyle` | 9 | src/main-process/duplicate-inbound-match/excel-writer.js |
| `DEFER_ADMISSION` | 9 | src/main-process/background-execution/admission-queue.js |
| `getAvailableDiskBytes` | 9 | src/main-process/pre-fund-reconciliation/mpt-import/spool-admission.js |
| `iterateOutputRows` | 9 | src/main-process/read-only-exports/pre-fund/query.js |
| `monthEndCopyIntents` | 9 | src/main-process/biz-op-recon-run-data.js |
| `monthRepo` | 9 | src/backend/pending-import/worker.js |
| `normalizeBizIdKey` | 9 | src/main-process/scenario-engines/r5-refund-order-backfill.js |
| `normalizeIncomingVccCurrency` | 9 | src/backend/vcc-financial-op/row-mapper.js |
| `normalizeStaticStyle` | 9 | src/backend/toolbox-format/style-registry.js |
| `nowIso` | 9 | src/main-process/acquiring-bill-currency-session.js |
| `pkg` | 9 | src/main-process/acquiring-bill-currency-writer.js |
| `readJournal` | 9 | src/main-process/toolbox-output-publication.js |
| `readRunProgressBatchContext` | 9 | src/backend/acquiring-bill-currency-db/run-repository.js |
| `resolveIndexedColor` | 9 | src/backend/toolbox-format/biff8-colors.js |
| `RESULT_TEMPLATE_HEADERS` | 9 | src/backend/vcc-financial-op/result-template-contract.js |
| `ROUTE_DB_CODEC_VERSION` | 9 | src/main-process/toolbox-background/route-db-contract.js |
| `SHEET_ENTRY_NAME` | 9 | src/backend/acquiring-bill-currency-import/reader.js |
| `SOURCE_TYPE_OUTBOUND` | 9 | src/main-process/pre-fund-reconciliation/mpt-schema.js |
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
| `assertUniqueSplitHeaders` | 8 | src/main-process/toolbox-background/route-db-sealer.js |
| `atomicWriteJson` | 8 | src/main-process/archive-center/storage-root-manager.js |
| `BANK_TABLE` | 8 | src/backend/bank-bu-recon-db/month-repository.js |
| `BankRowValidationError` | 8 | src/main-process/pre-fund-reconciliation/bank-row.js |
| `buildStableSummary` | 8 | src/main-process/statement-worker/session-state.js |
| `canonicalAmount` | 8 | src/main-process/position-reconciliation/decimal.js |
| `checkedSubtract` | 8 | src/main-process/background-execution/resource-lease.js |
| `currencyMatches` | 8 | src/main-process/scenario-engines/c4-recon-id-fix.js |
| `DETAIL_META_HEADERS` | 8 | src/backend/position-reconciliation-import/anomaly-report.js |
| `DUPLICATE_FOLD_REASON` | 8 | src/backend/pre-fund-reconciliation-run-store.js |
| `DurabilityBarrierError` | 8 | src/main-process/background-execution/durable-file.js |
| `freezePlan` | 8 | src/backend/vcc-financial-op/destructive-write.js |
| `mapMirror` | 8 | src/backend/database/duplicate-inbound-match-run-repository.js |
| `MAX_CURRENCIES_PER_ACCOUNT` | 8 | src/main-process/new-account/generation-contract.js |
| `normalizeBoundedJpmReceipt` | 8 | src/main-process/recon-id-fix-service/jpm-receipt-evidence.js |
| `normalizeDecimalString` | 8 | src/main-process/pre-fund-reconciliation/mpt-schema.js |
| `outboxBatchId` | 8 | src/main-process/archive-center/outbox-store.js |
| `parseCellReference` | 8 | src/backend/toolbox-format/xlsx-sheet-scanner.js |
| `PENDING_TABLE` | 8 | src/backend/bank-bu-recon-db/month-repository.js |
| `pendingImportError` | 8 | src/main-process/pending-import-preflight.js |
| `POSITION_READ_ONLY_ACTION` | 8 | src/main-process/read-only-exports/position/policies.js |
| `readPositionSourceSummary` | 8 | src/main-process/position-reconciliation/source-summary-cache.js |
| `recordRowError` | 8 | src/backend/biz-op-recon-import/import-worker.js |
| `requireCount` | 8 | src/backend/database/recon-fix-operation-receipt-repository.js |
| `runData` | 8 | src/main-process/background-execution/adapters/acquiring-adapter.js |
| `saxAttributeValue` | 8 | src/backend/toolbox-format/ooxml-namespaces.js |
| `ServiceClientError` | 8 | src/main-process/background-execution/index.js |
| `setNewAccountStatus` | 8 | src/renderer.js |
| `SHARED_STRINGS_ENTRY` | 8 | src/backend/toolbox-xlsx-stream/large-split-worker.js |
| `THEME_COLOR_NAMES` | 8 | src/backend/toolbox-format/biff8-colors.js |
| `timestampOf` | 8 | src/main-process/background-execution/critical/recovery-control-repository.js |
| `today` | 8 | src/main-process/statement-generation-business.js |
| `toIsoDate` | 8 | src/main-process/boc-fx-link-builder.js |
| `TOOLBOX_MAX_COL_COUNT` | 8 | src/backend/toolbox-xlsx-stream/multi-sheet-reader.js |
| `trimText` | 8 | src/main-process/duplicate-inbound-match/import-model.js |
| `validateAndExtractRow` | 8 | src/main-process/vcc-op-calc/parser-core.js |
| `validatePositionImportAdapterResult` | 8 | src/main-process/background-execution/position-import-adapter-policy.js |
| `validatorFor` | 8 | src/main-process/background-execution/recovery-control-contract.js |
| `VCC_FINANCIAL_OP_READ_ONLY_ACTION` | 8 | src/main-process/read-only-exports/vcc-financial-op/policies.js |
| `VCC_TABLE_POLICY_REGISTRY` | 8 | src/backend/vcc-financial-op/mutation-policy.js |
| `wrapReadError` | 8 | src/backend/biz-op-recon-import/reader-streamed.js |
| `ACQUIRING_ADAPTER_POLICIES` | 7 | src/main-process/background-execution/acquiring-adapter-policies.js |
| `ACQUIRING_BILL_WORKER_COUNT_DEFAULT` | 7 | src/backend/database/migrations.js |
| `ACQUIRING_BILL_WORKER_COUNT_KEY` | 7 | src/backend/database/migrations.js |
| `ALL_MODULE_IDS` | 7 | src/backend/database/settings-repository.js |
| `ANOMALY_HEADERS` | 7 | src/main-process/bank-bu-recon-writer.js |
| `applyManualBalancePromptStatus` | 7 | src/renderer.js |
| `applyTint` | 7 | src/backend/toolbox-format/biff8-colors.js |
| `archiveStorageRootManager` | 7 | src/main.js |
| `assertKey` | 7 | src/main-process/background-execution/inspector-registry.js |
| `assertSourceSnapshot` | 7 | src/main-process/statement-worker/source-identity.js |
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
| `DUPLICATE_SPOOL_FILE_NAMES` | 7 | src/main-process/duplicate-inbound-match/spool-contract.js |
| `ensureContained` | 7 | src/main-process/bank-bu-worker/spool-filesystem.js |
| `EXCEL_ST_XSTRING_MAX_RAW_UTF16_UNITS` | 7 | src/backend/toolbox-format/excel-text.js |
| `FLOW_COLUMN_DEFS` | 7 | src/backend/biz-op-recon-db/columns.js |
| `flowImportsRepository` | 7 | src/backend/biz-op-recon-import/import-worker.js |
| `getCommittedRunByOperation` | 7 | src/main-process/bank-bu-worker/side-database.js |
| `getNewAccountStatusTitle` | 7 | src/renderer.js |
| `IMPORT_CANCELLED_CODE` | 7 | src/backend/vcc-financial-op/detail-importer.js |
| `lastManualBalancePrompt` | 7 | src/main.js |
| `localDateOf` | 7 | src/backend/database/archive-repository.js |
| `localMonthKey` | 7 | src/main-process/duplicate-inbound-match/service.js |
| `MANUAL_BALANCE_INSPECTOR_KEY` | 7 | src/main-process/manual-balance-seed-settlement.js |
| `MAX_INPUT_BYTES` | 7 | src/main-process/new-account/generation-contract.js |
| `normalizeBatchSize` | 7 | src/backend/position-reconciliation-import/maintenance-writer.js |
| `normalizeMonth` | 7 | src/backend/vcc-financial-op/destructive-write.js |
| `OLE_CFB_MAGIC` | 7 | src/backend/toolbox-format/biff8-overlay.js |
| `openBizOpReadDatabase` | 7 | src/main-process/read-only-exports/biz-op/query.js |
| `openReadDatabase` | 7 | src/main-process/read-only-exports/pre-fund/query.js |
| `PAIR_BY_FUND_TYPE` | 7 | src/main-process/position-reconciliation/contracts.js |
| `PENDING_BIZOP_ADAPTER_POLICIES` | 7 | src/main-process/background-execution/pending-bizop-adapter-policies.js |
| `persistStagingAnomalies` | 7 | src/backend/vcc-financial-op-db/repository.js |
| `POSITION_DB_CHECKPOINT_TOKEN_KEY` | 7 | src/main-process/position-reconciliation/side-db-mutation.js |
| `POSITION_DB_GENERATION_KEY` | 7 | src/main-process/position-reconciliation/side-db-mutation.js |
| `POSITION_IMPORT_ADAPTER_POLICY` | 7 | src/main-process/background-execution/position-import-adapter-policy.js |
| `POSITION_IMPORT_LEDGER_SCHEMA_VERSION` | 7 | src/backend/position-reconciliation-import/constants.js |
| `POSITION_IMPORT_MAINTENANCE_BATCH_SIZE` | 7 | src/backend/position-reconciliation-import/constants.js |
| `preflightCalculation` | 7 | src/backend/vcc-financial-op/calculator.js |
| `PREVIEW_MEANINGFUL_ROWS` | 7 | src/backend/vcc-financial-op/workbook-reader.js |
| `pureComputePolicy` | 7 | src/main-process/background-execution/canary/index.js |
| `readSideOperation` | 7 | src/main-process/bank-bu-worker/outcome-inspector.js |
| `RECON_RESULT_FIELDS_GATEWAY` | 7 | src/constants/gateway-bill-recon-fields.js |
| `recoverInterruptedImports` | 7 | src/backend/vcc-financial-op-db/repository.js |
| `RECOVERY_REQUEST_MAX_BYTES` | 7 | src/main-process/background-execution/recovery-control-contract.js |
| `recoveryHoldIdFor` | 7 | src/main-process/background-execution/recovery-hold-request.js |
| `REPORT_MODE` | 7 | src/main-process/background-execution/canary/packaged-runtime-request.js |
| `resolveManagedRelative` | 7 | src/main-process/archive-center/storage-materializer.js |
| `RESULT_TEMPLATE_SHEET_NAME` | 7 | src/backend/vcc-financial-op/result-template-contract.js |
| `roundAmount` | 7 | src/backend/file-service/normalizers.js |
| `ROUTE_DB_SCHEMA_VERSION` | 7 | src/main-process/toolbox-background/route-db-contract.js |
| `runRowIntegrityHash` | 7 | src/main-process/position-reconciliation/store.js |
| `setNewAccountExportAvailability` | 7 | src/renderer.js |
| `sideOperationSnapshots` | 7 | src/main-process/duplicate-inbound-match/startup-recovery.js |
| `stateDigest` | 7 | src/main-process/recon-id-fix-service/service.js |
| `STORAGE_LAYOUT_VERSION` | 7 | src/main-process/archive-center/storage-layout.js |
| `subjectAuthority` | 7 | src/main-process/vcc-financial-op-output/authority.js |
| `syncNewAccountCurrencyMode` | 7 | src/renderer.js |
| `tableNames` | 7 | src/main-process/duplicate-inbound-match/startup-recovery.js |
| `targetState` | 7 | src/main-process/toolbox-output-publication.js |
| `VALID_CATEGORIES` | 7 | src/backend/database/scenarios-repository.js |
| `validateDuplicateInputSpool` | 7 | src/main-process/duplicate-inbound-match/spool-reader.js |
| `validateElementCase` | 7 | src/backend/toolbox-format/style-registry.js |
| `validateTransition` | 7 | src/main-process/background-execution/recovery-control-contract.js |
| `VccOpSaveRunContractError` | 7 | src/main-process/vcc-op-calc/save-run-contract.js |
| `WORKSHEET_ENTRY_RE` | 7 | src/backend/pending-import/xlsx-size-preflight.js |
| `__missingBankColumns` | 6 | src/constants/payment-offline-allocation-fields.js |
| `abortWriters` | 6 | src/main-process/toolbox-background/output-writer-core.js |
| `absoluteAmount` | 6 | src/main-process/position-reconciliation/decimal.js |
| `ACQUIRING_ADAPTER_ACTION_SET` | 6 | src/main-process/background-execution/acquiring-adapter-policies.js |
| `addCalendarDays` | 6 | src/backend/database/archive-repository.js |
| `addFileFailureAnomaly` | 6 | src/backend/vcc-financial-op-db/repository.js |
| `addImportAnomaly` | 6 | src/backend/vcc-financial-op-db/repository.js |
| `admIdSequenceDigest` | 6 | src/backend/database/linked-table-writeback-reader.js |
| `ADMITTED_TOPOLOGY_WORKER_DATA_KEY` | 6 | src/main-process/background-execution/adapters/worker-thread-adapter.js |
| `artifactFrom` | 6 | src/main-process/toolbox-background/generation-core.js |
| `assertEmptyVccStorageForUpgrade` | 6 | src/backend/vcc-financial-op-db/storage-contract.js |
| `assertNoRouteSidecars` | 6 | src/main-process/toolbox-background/route-db-contract.js |
| `assertUnicodeScalarString` | 6 | src/main-process/background-execution/canonical-json-v1.js |
| `assertVccExportAuthorityEqual` | 6 | src/main-process/vcc-financial-op-output/authority.js |
| `AsyncLocalStorage` | 6 | src/main-process/archive-center/task-lifecycle.js |
| `BANK_BU_DUAL_IMPORT_CONTRACT_VERSION` | 6 | src/main-process/bank-bu-worker/spool-contract.js |
| `BANK_BU_SPOOL_FILE_NAMES` | 6 | src/main-process/bank-bu-worker/spool-contract.js |
| `BANK_DEPOSIT_FIELDS` | 6 | src/backend/database/linked-table-repository.js |
| `BANK_DIFF_FIELD_DB_COLUMN` | 6 | src/backend/bank-bu-recon-db/columns.js |
| `BILL_CONTRACT_PATH` | 6 | src/main-process/acquiring-bill-currency-session.js |
| `BIZ_OP_MODULE_ID` | 6 | src/main-process/biz-op-archive-lineage.js |
| `bizOpRowToArray` | 6 | src/backend/biz-op-recon-db/columns.js |
| `BOC_BANK_FILTER` | 6 | src/constants/boc-fx-link-fields.js |
| `buildBankMatchCriteria` | 6 | src/main-process/pre-fund-reconciliation/matching-engine.js |
| `buildFileReader` | 6 | src/backend/bank-bu-recon-import/reader.js |
| `buildInfo` | 6 | src/main-process/acquiring-bill-currency-writer.js |
| `buildNumericCellValue` | 6 | src/backend/file-service/writers.js |
| `buildTemplateSummaryFromRow` | 6 | src/backend/database/utils.js |
| `canonicalDuplicateSideDbRelPath` | 6 | src/backend/duplicate-inbound-match-side-db-identity.js |
| `cellReference` | 6 | src/backend/toolbox-format/model.js |
| `CLEANUP_TEMPLATE_HEADERS` | 6 | src/constants/platform-cleanup-template-fields.js |
| `cleanupPreparedInspectionUnavailableLegacyGap` | 6 | src/main-process/background-execution/critical/recovery-request-owner-repository.js |
| `createGenerationInput` | 6 | src/main-process/toolbox-background/generation-validator.js |
| `createRecoveryTransitionAdapter` | 6 | src/main-process/background-execution/task-lifecycle-adapter.js |
| `createSplitFilter` | 6 | src/main-process/toolbox-background/route-db-sealer.js |
| `createStatementImportResult` | 6 | src/main-process/statement-worker/contracts.js |
| `createStatementStatusDto` | 6 | src/main-process/statement-worker/contracts.js |
| `deferred` | 6 | src/main-process/archive-center/task-file-plan-registry.js |
| `deletePreviewForTarget` | 6 | src/backend/vcc-financial-op/read-snapshot.js |
| `dispatchEngineImportHandle` | 6 | src/main-process/big-table-import-dispatch.js |
| `DUPLICATE_PAIRED_IMPORT_CONTRACT_VERSION` | 6 | src/main-process/duplicate-inbound-match/spool-contract.js |
| `DUPLICATE_STARTUP_GATE_CONTRACT_VERSION` | 6 | src/main-process/duplicate-inbound-match/startup-gate.js |
| `durableCanary` | 6 | src/main-process/background-execution/index.js |
| `encodePayload` | 6 | src/main-process/toolbox-background/route-db-contract.js |
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
| `ensureBankBuReconRunIdentitySupport` | 6 | src/backend/database/migrations.js |
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
| `ensureReconFixOperationReceiptSupport` | 6 | src/backend/database/migrations.js |
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
| `evidenceMatches` | 6 | src/main-process/read-only-exports/position/query.js |
| `exactActionMap` | 6 | src/main-process/background-execution/capability-inventory.js |
| `excelValueForHeader` | 6 | src/backend/position-reconciliation-import/anomaly-report.js |
| `exportInspectionEvidence` | 6 | src/main-process/vcc-financial-op-dataset-writer.js |
| `FILENAME_MAPPING_TEMPLATE_ID` | 6 | src/main.js |
| `FLOW_CONTRACT_PATH` | 6 | src/main-process/acquiring-bill-currency-session.js |
| `FX_DELIVERY_SIGNATURE` | 6 | src/constants/boc-fx-link-fields.js |
| `GatewayPoolEmptyError` | 6 | src/main-process/pre-fund-reconciliation/matching-engine.js |
| `gatewayTagKey` | 6 | src/main-process/pre-fund-archive-lineage.js |
| `getCurrencyOptionLabel` | 6 | src/renderer.js |
| `getDatasetEvidence` | 6 | src/main-process/bank-bu-worker/side-database.js |
| `getVccStorageContractVersion` | 6 | src/backend/vcc-financial-op-db/storage-contract.js |
| `gwAmountAbs` | 6 | src/main-process/scenario-engines/many-to-many-detector.js |
| `handleControlMessage` | 6 | src/backend/vcc-financial-op/worker-entry.js |
| `hasAnyOperationReceipts` | 6 | src/main-process/pre-fund-reconciliation/mpt-import/operation-receipt-repository.js |
| `hashOrdinaryFile` | 6 | src/main-process/read-only-exports/position/query.js |
| `hashSourceFile` | 6 | src/backend/vcc-financial-op/source-lineage.js |
| `headerValues` | 6 | src/main-process/pre-fund-reconciliation/excel-writer.js |
| `identifyInputFiles` | 6 | src/main-process/duplicate-inbound-match/input-classifier.js |
| `importEvidenceHash` | 6 | src/main-process/duplicate-inbound-match/service.js |
| `initWorkerDb` | 6 | src/main-process/run-check-multiworker-worker.js |
| `INSERT_SQL` | 6 | src/backend/biz-op-recon-db/flow-imports-repository.js |
| `inspectDatasetDeletion` | 6 | src/backend/vcc-financial-op/dataset-deletion.js |
| `INSTALL_BUSY_MESSAGE` | 6 | src/main-process/business-operation-registry.js |
| `installVccStorageWriteGuards` | 6 | src/backend/vcc-financial-op-db/storage-contract.js |
| `isLeapYear` | 6 | src/backend/toolbox-format/number-date.js |
| `isLegacyPendingHeaders` | 6 | src/backend/vcc-financial-op/definitions.js |
| `isPathInside` | 6 | src/main-process/archive-center/archive-service.js |
| `LEGACY_HANDLER_PAIRS` | 6 | src/main-process/background-execution/action-manifest.js |
| `listImportedDateBuPairs` | 6 | src/backend/biz-op-recon-db/imports-repository.js |
| `listPositionCommittedOperationInputs` | 6 | src/main-process/position-reconciliation/side-db-mutation.js |
| `loadDeleteEvidenceV2` | 6 | src/backend/vcc-financial-op/read-snapshot.js |
| `locationText` | 6 | src/main-process/pre-fund-reconciliation/bank-row.js |
| `MANUAL_BALANCE_SETTLEMENT_KEY` | 6 | src/main-process/manual-balance-seed-settlement.js |
| `mapBalancedRow` | 6 | src/main-process/pre-fund-reconciliation/output-mapper.js |
| `mapChannelBillRow` | 6 | src/main-process/pre-fund-reconciliation/output-mapper.js |
| `mapUnbalancedRow` | 6 | src/main-process/pre-fund-reconciliation/output-mapper.js |
| `matchAmountSplitConditionValue` | 6 | src/backend/file-service/normalizers.js |
| `materializeManualBalanceSeedPlan` | 6 | src/main-process/manual-balance-seed-preflight.js |
| `migrateC4ReconGroupsAmountLockedFieldPair` | 6 | src/backend/database/migrations.js |
| `migrateC4ReconGroupsStructure` | 6 | src/backend/database/migrations.js |
| `migrateGatewayReconIdFixFieldPairs` | 6 | src/backend/database/migrations.js |
| `MODULE_DUPLICATE_INBOUND_MATCH` | 6 | src/backend/run-data-store.js |
| `monthOfDate` | 6 | src/backend/vcc-financial-op/row-mapper.js |
| `MUTATION_ACTIONS` | 6 | src/main-process/bank-bu-worker/main-coordinator.js |
| `normalizeArchiveSources` | 6 | src/main-process/read-only-exports/vcc-financial-op/actions.js |
| `normalizeDateRange` | 6 | src/backend/pre-fund-reconciliation-store.js |
| `normalizedAttributes` | 6 | src/backend/toolbox-format/style-registry.js |
| `normalizeFill` | 6 | src/backend/toolbox-format/biff8-overlay.js |
| `normalizeFont` | 6 | src/backend/toolbox-format/biff8-overlay.js |
| `normalizeGatewayCandidate` | 6 | src/main-process/pre-fund-reconciliation/matching-engine.js |
| `normalizeImportBatchId` | 6 | src/backend/vcc-financial-op/import-service.js |
| `normalizeScope` | 6 | src/backend/vcc-financial-op/dataset-deletion.js |
| `normalizeStagingBatchId` | 6 | src/main-process/position-reconciliation/input-staging.js |
| `openVccWriteDatabase` | 6 | src/backend/vcc-financial-op/result-write.js |
| `ownDataKeys` | 6 | src/main-process/bank-bu-worker/operation-receipt-repository.js |
| `OWNER_KEY_HASH` | 6 | src/main-process/duplicate-inbound-match/worker-host.js |
| `parseCellType` | 6 | src/backend/big-table-import/row-scanner.js |
| `parsePositionPendingArchiveFiles` | 6 | src/main-process/position-reconciliation/operation-lifecycle.js |
| `PARSER_CONTRACT_VERSION` | 6 | src/main-process/vcc-op-calc/parser-core.js |
| `parseThemeColors` | 6 | src/backend/toolbox-format/biff8-overlay.js |
| `PART_TABLE` | 6 | src/main-process/run-check-multiworker-worker.js |
| `PENDING_BIZOP_ADAPTER_ACTION_SET` | 6 | src/main-process/background-execution/pending-bizop-adapter-policies.js |
| `PENDING_DIFF_FIELD_DB_COLUMN` | 6 | src/backend/bank-bu-recon-db/columns.js |
| `pendingHeaderMismatchDetails` | 6 | src/backend/vcc-financial-op/pending-template-contract.js |
| `pendingSession` | 6 | src/main.js |
| `POSITION_DB_IDENTITY_KEY` | 6 | src/main-process/position-reconciliation/side-db-mutation.js |
| `PositionImportLedger` | 6 | src/backend/position-reconciliation-import/ledger.js |
| `PRE_SWITCH_PHASES` | 6 | src/main-process/archive-center/storage-root-manager.js |
| `protocolSchema` | 6 | src/main-process/background-execution/protocol-validator.js |
| `readDuplicateParserOutcome` | 6 | src/main-process/duplicate-inbound-match/parser-outcome.js |
| `readRegularFile` | 6 | src/main-process/bank-bu-worker/spool-reader.js |
| `readSystemOpSnapshotCandidates` | 6 | src/backend/vcc-financial-op/system-op-importer.js |
| `reconAmount` | 6 | src/main-process/scenario-engines/r5-payment-offline-allocation-backfill.js |
| `reconIdFixSession` | 6 | src/main.js |
| `REFUND_RO_COLUMNS` | 6 | src/constants/refund-backfill-fields.js |
| `removeArtifacts` | 6 | src/main-process/statement-worker/generation.js |
| `removedRepo` | 6 | src/backend/pending-export/writer.js |
| `requireDatabasePath` | 6 | src/main-process/fund-recon-worker/service.js |
| `requirePlainObject` | 6 | src/main-process/duplicate-inbound-match/managed-service.js |
| `resolveDuplicateInputFiles` | 6 | src/main-process/duplicate-inbound-match/input-classifier.js |
| `resultCounts` | 6 | src/backend/duplicate-inbound-match-store.js |
| `retireChargeOutboundOrphans` | 6 | src/backend/database/migrations.js |
| `runC1Scenario` | 6 | src/main-process/scenario-engines/c1-extract-recon-id.js |
| `runParserWorker` | 6 | src/main-process/pre-fund-reconciliation/mpt-import/managed-import.js |
| `runReconciliationCore` | 6 | src/backend/pending-reconcile/engine.js |
| `runStartupPhaseSync` | 6 | src/backend/startup-phase.js |
| `sha256Bytes` | 6 | src/main-process/toolbox-background/route-db-contract.js |
| `sha256FileSync` | 6 | src/main-process/toolbox-background/route-db-contract.js |
| `shouldFallbackToSingleWorker` | 6 | src/main-process/acquiring-bill-currency-session.js |
| `signedDayDiff` | 6 | src/main-process/scenario-engines/engine-date-utils.js |
| `splitSignedAmountValue` | 6 | src/backend/file-service/normalizers.js |
| `stageInputFiles` | 6 | src/main-process/position-reconciliation/input-staging.js |
| `statementGenerationInputEvidence` | 6 | src/main-process/statement-worker/session-state.js |
| `STRICT_YEAR_MONTH_PATTERN` | 6 | src/backend/vcc-financial-op-db/state-model.js |
| `SUPPORTED_SCENARIO_BUNDLE_VERSION` | 6 | src/backend/scenarios-bundle-io.js |
| `validateAcquiringRunAdapterResult` | 6 | src/main-process/background-execution/acquiring-adapter-policies.js |
| `validatedResultDigest` | 6 | src/backend/vcc-financial-op/operation-token-v2.js |
| `validateName` | 6 | src/backend/database/channels-repository.js |
| `validateNewAccountSaveAsResult` | 6 | src/main-process/new-account/artifact-copy.js |
| `validatePolicyDocument` | 6 | src/main-process/background-execution/execution-policy-registry.js |
| `validateReconFixExportAuthority` | 6 | src/main-process/recon-id-fix-service/policies.js |
| `validateRequest` | 6 | src/main-process/background-execution/resource-governor.js |
| `VCC_BILL_DATE_DB_COLUMN` | 6 | src/backend/vcc-op-calc-db/columns.js |
| `VCC_DIRECTION_DB_COLUMN` | 6 | src/backend/vcc-op-calc-db/columns.js |
| `VCC_RECON_AMOUNT_DB_COLUMN` | 6 | src/backend/vcc-op-calc-db/columns.js |
| `VCC_STORAGE_GUARD_TRIGGER_PREFIX` | 6 | src/backend/vcc-financial-op-db/storage-contract.js |
| `waitUntil` | 6 | src/main-process/background-execution/external-parser-finalization.js |
| `WORKER_OPERATION_CONTEXT_FIELDS` | 6 | src/main-process/archive-center/worker-operation-context.js |
| `WORKER_SCRIPT` | 6 | src/main-process/biz-op-recon-session.js |
| `workerScriptOverride` | 6 | src/main-process/run-check-multiworker.js |
| `WRITER_OUTPUT_HEADERS_V2` | 6 | src/backend/acquiring-bill-currency-db/columns.js |
| `ZHONGTAI_DISPATCH_ORDER_SIGNATURE` | 6 | src/constants/fund-transfer-recon-fields.js |
| `ACTION_MANIFEST_VERSION` | 5 | src/main-process/background-execution/action-manifest.js |
| `ActionTaskBindingRegistryError` | 5 | src/main-process/background-execution/action-task-binding-registry.js |
| `allowMptFinanceSafeValue` | 5 | src/main-process/pre-fund-reconciliation/mpt-import/file-result-safety.js |
| `assertDatasetCurrent` | 5 | src/main-process/bank-bu-worker/side-database.js |
| `assertDuplicateResultConservation` | 5 | src/backend/duplicate-inbound-match-result-digest.js |
| `assertFinanceSafeValue` | 5 | src/main-process/background-execution/error-codec.js |
| `assertJpmWritebackPlan` | 5 | src/main-process/recon-id-fix-service/jpm-writeback-plan.js |
| `assertManagedSourceStillRegular` | 5 | src/main-process/read-only-exports/pending/actions.js |
| `assertNormalizedFilePlanV1` | 5 | src/main-process/archive-center/file-plan.js |
| `assertPlainObject` | 5 | src/main-process/pre-fund-reconciliation/mpt-import/spool-reader.js |
| `assertReconFixEvidenceSettlementAdmission` | 5 | src/main-process/recon-id-fix-service/evidence-settlement-admission.js |
| `assertSourceStatsMatch` | 5 | src/backend/position-reconciliation-import/source-writer.js |
| `assertStagingDirectory` | 5 | src/main-process/recon-id-fix-service/export-operation.js |
| `assertStatementSourceIdentityCurrent` | 5 | src/main-process/statement-worker/source-identity.js |
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
| `buildImportEvidence` | 5 | src/main-process/bank-bu-worker/identity.js |
| `buildResultMutationTokenV2` | 5 | src/backend/vcc-financial-op/operation-token-v2.js |
| `buildRowMapper` | 5 | src/backend/bank-bu-recon-import/reader.js |
| `buildStatementImportCandidate` | 5 | src/main-process/statement-worker/session-state.js |
| `captureTargetParentIdentity` | 5 | src/main-process/archive-center/target-parent-identity.js |
| `CHANNEL_BILL_HEADERS` | 5 | src/main-process/pre-fund-reconciliation/output-mapper.js |
| `checkpointValue` | 5 | src/main-process/position-reconciliation/side-db-mutation.js |
| `cleanupStagingPathsAsync` | 5 | src/main-process/position-reconciliation/input-staging.js |
| `COLUMN_WIDTHS` | 5 | src/backend/position-reconciliation-import/anomaly-report.js |
| `computeMaxParallel` | 5 | src/backend/big-table-import/pipeline.js |
| `computeParserSemanticHash` | 5 | src/main-process/vcc-op-calc/parser-core.js |
| `consumeDuplicateInputSpool` | 5 | src/main-process/duplicate-inbound-match/spool-reader.js |
| `consumeRows` | 5 | src/main-process/bank-bu-worker/spool-reader.js |
| `createActionTaskBindingRegistry` | 5 | src/main-process/background-execution/action-task-binding-registry.js |
| `createBiff8GridResolver` | 5 | src/backend/toolbox-format/biff8-overlay.js |
| `createExecutionResult` | 5 | src/main-process/background-execution/execution-result.js |
| `createInvalidExtraFeeWarning` | 5 | src/main-process/scenario-engines/r5-fund-transfer-backfill.js |
| `createMainExpectedArtifactDescriptors` | 5 | src/main-process/statement-worker/artifact-descriptor.js |
| `createMigrationJournal` | 5 | src/main-process/vcc-financial-op-storage-rebuild.js |
| `createResourceLease` | 5 | src/main-process/background-execution/resource-lease.js |
| `createSheet` | 5 | src/main-process/pre-fund-reconciliation/mpt-error-report-writer.js |
| `createSlimEffectiveRowsTable` | 5 | src/backend/vcc-financial-op-db/storage-contract.js |
| `createStatementImportRequest` | 5 | src/main-process/statement-worker/import-contracts.js |
| `createStatementInteractionCancelledResult` | 5 | src/main-process/statement-worker/contracts.js |
| `createStatementServiceState` | 5 | src/main-process/statement-worker/session-state.js |
| `createStatementStatusResult` | 5 | src/main-process/statement-worker/contracts.js |
| `datasetHeads` | 5 | src/main-process/biz-op-archive-lineage.js |
| `DEFAULT_BUILTIN_FORMATS` | 5 | src/backend/toolbox-format/biff8-records.js |
| `deriveSlotIdentity` | 5 | src/main-process/duplicate-inbound-match/spool-contract.js |
| `deserializeFromMessage` | 5 | src/main-process/run-check-multiworker.js |
| `DIFF_HEADER_TAIL` | 5 | src/backend/biz-op-recon-db/columns.js |
| `DIFF_OUTPUT_BANK_SHEET` | 5 | src/backend/bank-bu-recon-db/columns.js |
| `DIFF_OUTPUT_PENDING_SHEET` | 5 | src/backend/bank-bu-recon-db/columns.js |
| `DUPLICATE_STARTUP_INSPECTOR_KEY` | 5 | src/main-process/duplicate-inbound-match/startup-recovery.js |
| `DUPLICATE_STARTUP_RECOVERY_KEY` | 5 | src/main-process/duplicate-inbound-match/startup-recovery.js |
| `DUPLICATE_STATE_BUDGET_BYTES` | 5 | src/main-process/duplicate-inbound-match/policies.js |
| `ENGINE_WORKER_ENTRY` | 5 | src/main-process/acquiring-bill-currency-session.js |
| `ensureArchiveMetadataSupport` | 5 | src/backend/database/archive-repository.js |
| `ERROR_HEADER_TAIL` | 5 | src/backend/biz-op-recon-db/columns.js |
| `estimateMptFileSpoolBytes` | 5 | src/main-process/pre-fund-reconciliation/mpt-import/spool-admission.js |
| `estimateStatementServiceStateFootprint` | 5 | src/main-process/statement-worker/service.js |
| `exactOperationInspection` | 5 | src/main-process/duplicate-inbound-match/startup-recovery.js |
| `executeAcquiringExport` | 5 | src/main-process/read-only-exports/acquiring/executor.js |
| `extractYearMonth` | 5 | src/main-process/vcc-op-calc/parser-core.js |
| `freezeGatewayTags` | 5 | src/main-process/pre-fund-archive-lineage.js |
| `freezeImportArchiveHandoffFiles` | 5 | src/backend/vcc-financial-op/import-service.js |
| `freezePositionSourceSnapshot` | 5 | src/main-process/read-only-exports/position/query.js |
| `freezeVccImportAuditSourceSnapshot` | 5 | src/main-process/read-only-exports/vcc-financial-op/query.js |
| `FUND_RECON_STATE_BUDGET_BYTES` | 5 | src/main-process/fund-recon-worker/policies.js |
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
| `HASH_VERSION` | 5 | src/backend/vcc-financial-op/row-mapper.js |
| `hashRegularFile` | 5 | src/main-process/vcc-financial-op-output-recovery.js |
| `hashSourceFileSync` | 5 | src/backend/vcc-financial-op/source-lineage.js |
| `hasInvalidExtraFee` | 5 | src/main-process/scenario-engines/r5-fund-transfer-backfill.js |
| `identifyMptHeader` | 5 | src/main-process/pre-fund-reconciliation/mpt-schema.js |
| `identityError` | 5 | src/main-process/vcc-financial-op-output/staging-identity.js |
| `importDetailGroup` | 5 | src/backend/vcc-financial-op/detail-importer.js |
| `INBOUND_FIELDS` | 5 | src/main-process/pre-fund-reconciliation/mpt-schema.js |
| `initializeActionTaskBindingRegistry` | 5 | src/main-process/background-execution/action-task-binding-registry.js |
| `inspectDuplicateInputFile` | 5 | src/main-process/duplicate-inbound-match/input-classifier.js |
| `inspectImportOutcome` | 5 | src/main-process/bank-bu-worker/outcome-inspector.js |
| `inspectRunOutcome` | 5 | src/main-process/bank-bu-worker/outcome-inspector.js |
| `inspectVccOpSaveRunEvidence` | 5 | src/main-process/vcc-op-calc/save-run-contract.js |
| `isMptSourceBatch` | 5 | src/main-process/pre-fund-reconciliation/mpt-import/file-result-safety.js |
| `isUnsafeAuditError` | 5 | src/backend/vcc-financial-op/result-write.js |
| `isVccOpSaveRunRecoveryRequired` | 5 | src/main-process/vcc-op-calc/save-run-lifecycle.js |
| `iterateDuplicateRecords` | 5 | src/main-process/read-only-exports/pre-fund/query.js |
| `KEY_PATTERN` | 5 | src/main-process/background-execution/inspector-registry.js |
| `LARGE_TABLE_SCOPE_PROOF_SET` | 5 | src/backend/vcc-financial-op/mutation-guard.js |
| `LARGE_TABLE_SCOPE_PROOF_TABLES` | 5 | src/backend/vcc-financial-op/mutation-policy.js |
| `LEGACY_DATASET_TYPES` | 5 | src/backend/vcc-financial-op/archive-contract.js |
| `listImportedDates` | 5 | src/backend/biz-op-recon-db/flow-imports-repository.js |
| `listMonthsDualSource` | 5 | src/main-process/acquiring-bill-currency-run-data.js |
| `loadResultMutationEvidence` | 5 | src/backend/vcc-financial-op/read-snapshot.js |
| `loadToolboxSharedStrings` | 5 | src/backend/toolbox-format/xlsx-pass.js |
| `loadUnarchiveGateEvidence` | 5 | src/backend/vcc-financial-op/read-snapshot.js |
| `MAINTENANCE_COMMANDS` | 5 | src/backend/position-reconciliation-import/maintenance-writer.js |
| `makeInvalidExtraFeeWarningDeduper` | 5 | src/main-process/scenario-engines/r5-fund-transfer-backfill.js |
| `MIN_NEW_ACCOUNT_GENERATION_MEMORY_BYTES` | 5 | src/main-process/new-account/policies.js |
| `moveFileNoClobber` | 5 | src/main-process/pre-fund-reconciliation/excel-writer.js |
| `MPT_SPOOL_MAX_NDJSON_LINE_BYTES` | 5 | src/main-process/pre-fund-reconciliation/mpt-import/spool-contract.js |
| `MUTATION_SQL_STEP_REGISTRY` | 5 | src/backend/vcc-financial-op/mutation-policy.js |
| `NEW_ACCOUNT_GENERATION_POLICY` | 5 | src/main-process/new-account/policies.js |
| `normalizeAdjustmentAmount` | 5 | src/backend/vcc-financial-op/result-adjustments.js |
| `normalizeAdjustmentReason` | 5 | src/backend/vcc-financial-op/result-adjustments.js |
| `normalizeAlignment` | 5 | src/backend/toolbox-format/biff8-overlay.js |
| `normalizeDirection` | 5 | src/main-process/vcc-op-calc/parser-core.js |
| `normalizeDuplicateStartupGateDescriptor` | 5 | src/main-process/duplicate-inbound-match/startup-gate.js |
| `normalizeJpmIntentEvidence` | 5 | src/main-process/recon-id-fix-service/jpm-outcome-inspector.js |
| `normalizeLineageIntentsV1` | 5 | src/main-process/archive-center/task-lifecycle.js |
| `normalizeNewAccountCurrencyValues` | 5 | src/main-process/new-account/generation-core.js |
| `normalizeOperationOwner` | 5 | src/main-process/vcc-op-calc/save-run-contract.js |
| `normalizeTaskStagingIdentity` | 5 | src/main-process/vcc-financial-op-output/staging-identity.js |
| `normalizeWriterInput` | 5 | src/main-process/vcc-financial-op-output/writer-coordinator.js |
| `openPositionWorkbook` | 5 | src/backend/position-reconciliation-import/xlsx-reader.js |
| `operationSource` | 5 | src/main-process/duplicate-inbound-match/startup-recovery.js |
| `OUTBOUND_FIELDS` | 5 | src/main-process/pre-fund-reconciliation/mpt-schema.js |
| `OutputStyleRegistry` | 5 | src/backend/toolbox-format/style-registry.js |
| `parseAdmRawJsonText` | 5 | src/backend/database/linked-table-writeback-reader.js |
| `parseAmountAbs` | 5 | src/backend/acquiring-bill-currency-db/import-repository.js |
| `parseOoxmlWallClock` | 5 | src/backend/toolbox-format/number-date.js |
| `PARSER_RESOURCES` | 5 | src/main-process/pre-fund-reconciliation/mpt-import/topology.js |
| `peekImportTarget` | 5 | src/main-process/acquiring-bill-currency-run-data.js |
| `PENDING_DB_FILENAME` | 5 | src/backend/pending-db.js |
| `PENDING_HASH_VERSION` | 5 | src/backend/vcc-financial-op/row-mapper.js |
| `PENDING_INSERT_SQL` | 5 | src/backend/bank-bu-recon-db/month-repository.js |
| `PENDING_SHEET_NAME` | 5 | src/main-process/vcc-financial-op-writer.js |
| `pendingHeaderCandidate` | 5 | src/backend/vcc-financial-op/pending-template-contract.js |
| `pendingMonthEvidenceValue` | 5 | src/main-process/pending-import-preflight.js |
| `persistRolledBackAuditSafely` | 5 | src/backend/vcc-financial-op/result-write.js |
| `pickBankFields` | 5 | src/main-process/duplicate-inbound-match/import-model.js |
| `POSITION_IMPORT_MAX_ERROR_DETAILS` | 5 | src/backend/position-reconciliation-import/constants.js |
| `POSITION_RULESET_VERSION` | 5 | src/main-process/position-reconciliation/constants.js |
| `POSITION_SOURCE_SUMMARY_SCHEMA` | 5 | src/main-process/position-reconciliation/source-summary-cache.js |
| `positionRecoveryTerminalOutcome` | 5 | src/main-process/position-reconciliation/operation-lifecycle.js |
| `positiveSafeInteger` | 5 | src/main-process/background-execution/critical/recovery-control-read-repository.js |
| `preflightRequiredResult` | 5 | src/backend/vcc-financial-op/calculator.js |
| `PreFundReconciliationStore` | 5 | src/backend/pre-fund-reconciliation-store.js |
| `PROGRESS_INTERVAL` | 5 | src/backend/vcc-op-calc-import/reader.js |
| `projectNewAccountGenerationShape` | 5 | src/main-process/new-account/generation-contract.js |
| `projectOutputCell` | 5 | src/backend/toolbox-format/model.js |
| `readBankBuParserOutcome` | 5 | src/main-process/bank-bu-worker/parser-outcome.js |
| `readBankSource` | 5 | src/main-process/fund-recon-worker/source-readers.js |
| `readBizOpSourceSnapshot` | 5 | src/main-process/read-only-exports/biz-op/query.js |
| `readGatewaySource` | 5 | src/main-process/fund-recon-worker/source-readers.js |
| `readPendingMonthEvidence` | 5 | src/main-process/pending-import-preflight.js |
| `readPositionSourceSnapshotFromStore` | 5 | src/main-process/read-only-exports/position/query.js |
| `readPreFundSourceSnapshotFromDatabases` | 5 | src/main-process/read-only-exports/pre-fund/query.js |
| `readRefundSource` | 5 | src/main-process/fund-recon-worker/source-readers.js |
| `readRegenerateEvidenceFromDb` | 5 | src/main-process/read-only-exports/acquiring/executor.js |
| `readVccDatasetSourceSnapshotFromDb` | 5 | src/main-process/read-only-exports/vcc-financial-op/query.js |
| `readVccExportWorkerSnapshot` | 5 | src/main-process/vcc-financial-op-output/authority.js |
| `readVccImportAuditSourceSnapshotFromDb` | 5 | src/main-process/read-only-exports/vcc-financial-op/query.js |
| `RECON_FIX_EVIDENCE_MAX_BYTES` | 5 | src/main-process/recon-id-fix-service/evidence-projection.js |
| `reconAmountAbs` | 5 | src/main-process/scenario-engines/many-to-many-detector.js |
| `reconcileVccImportArchiveLineage` | 5 | src/main-process/vcc-financial-op-archive-lineage.js |
| `ReconFixJpmWritebackError` | 5 | src/main-process/recon-id-fix-service/jpm-writeback-plan.js |
| `reconIdFixResult` | 5 | src/main.js |
| `redactedFailure` | 5 | src/backend/vcc-financial-op/result-write.js |
| `releaseResourceWhenUnreferenced` | 5 | src/main-process/background-execution/resource-governor.js |
| `REPORT_ARTIFACT_KEY` | 5 | src/backend/position-reconciliation-import/anomaly-report.js |
| `resolveOperationInputPaths` | 5 | src/main-process/archive-center/operation-tracker.js |
| `ROUND_LABELS` | 5 | src/main-process/reconciliation-orchestrator.js |
| `roundReservationBytes` | 5 | src/main-process/fund-recon-worker/state-footprint.js |
| `ROUTE_DB_MANIFEST_VERSION` | 5 | src/main-process/toolbox-background/route-db-contract.js |
| `rowColumns` | 5 | src/main-process/bank-bu-worker/spool-writer.js |
| `runC2Scenario` | 5 | src/main-process/scenario-engines/c2-offset-bill-mark.js |
| `runC3Scenario` | 5 | src/main-process/scenario-engines/c3-gateway-recon-join.js |
| `runEnvelope` | 5 | src/main-process/read-only-exports/position/query.js |
| `runJob` | 5 | src/backend/position-reconciliation-import/worker-entry.js |
| `runScenario` | 5 | src/main-process/scenario-dispatcher.js |
| `sameFileIdentity` | 5 | src/main-process/recon-id-fix-service/service.js |
| `samePostImage` | 5 | src/main-process/bank-bu-worker/mirror-repository.js |
| `samePreimage` | 5 | src/main-process/bank-bu-worker/mirror-repository.js |
| `setExportAvailability` | 5 | src/renderer.js |
| `setNewAccountOpenDateValue` | 5 | src/renderer.js |
| `setVccStorageContractVersion` | 5 | src/backend/vcc-financial-op-db/storage-contract.js |
| `sha256Text` | 5 | src/main-process/pre-fund-reconciliation/mpt-import/spool-contract.js |
| `SIDE_DB_DDL_BIZ_OP` | 5 | src/backend/run-data-store.js |
| `SIDE_DB_DDL_PRE_FUND_RUNS` | 5 | src/backend/run-data-store.js |
| `SIDE_DB_FAMILY_RE` | 5 | src/backend/duplicate-inbound-match-store.js |
| `sideDbFileName` | 5 | src/backend/run-data-store.js |
| `SOURCE_DISPLAY_ORDER` | 5 | src/main-process/position-reconciliation/constants.js |
| `SOURCE_FILTER_CODES` | 5 | src/main-process/position-reconciliation/constants.js |
| `SOURCE_TYPE_BY_FUND_TYPE` | 5 | src/main-process/position-reconciliation/constants.js |
| `splitUtf16Safe` | 5 | src/main-process/pre-fund-reconciliation/mpt-error-report-writer.js |
| `storedRecordResult` | 5 | src/backend/vcc-financial-op/import-service.js |
| `streamBizOpFile` | 5 | src/backend/biz-op-recon-import/import-worker.js |
| `systemHeaderCandidate` | 5 | src/backend/vcc-financial-op/workbook-reader.js |
| `systemHeaderMismatchDetails` | 5 | src/backend/vcc-financial-op/workbook-reader.js |
| `TASK_FILE_PLAN_DEFINITIONS` | 5 | src/main-process/archive-center/task-file-plan-registry.js |
| `TEMPLATE_BILL_KEY_INDICES` | 5 | src/backend/acquiring-bill-currency-db/import-repository.js |
| `templateIdentity` | 5 | src/main-process/statement-worker/contracts.js |
| `TERMINAL_TASK_STATUSES` | 5 | src/main-process/archive-center/controller.js |
| `terminalPayload` | 5 | src/main-process/bank-bu-worker/parser-outcome.js |
| `timerSafeDuration` | 5 | src/main-process/background-execution/external-parser-finalization.js |
| `toolboxRecoveryOutputFiles` | 5 | src/main-process/toolbox-archive-recovery.js |
| `ToolboxSheetReadError` | 5 | src/backend/toolbox-xlsx-stream/multi-sheet-reader.js |
| `ToolboxSplitFieldNotFoundError` | 5 | src/main-process/toolbox-format-operations.js |
| `UNBALANCED_HEADERS` | 5 | src/main-process/pre-fund-reconciliation/output-mapper.js |
| `unwrapBankEntry` | 5 | src/main-process/duplicate-inbound-match/matching-engine.js |
| `updateNewAccountGenerateAvailability` | 5 | src/renderer.js |
| `validateAcquiringImportAdapterResult` | 5 | src/main-process/background-execution/acquiring-adapter-policies.js |
| `validateBizIds` | 5 | src/main-process/duplicate-inbound-match/import-model.js |
| `validateDirection` | 5 | src/main-process/position-reconciliation/decimal.js |
| `validateManifestItem` | 5 | src/main-process/statement-worker/generation-contracts.js |
| `validatePositionImportAdapterProgress` | 5 | src/main-process/background-execution/position-import-adapter-policy.js |
| `validatePreFundMptImportResult` | 5 | src/main-process/pre-fund-reconciliation/mpt-import/policies.js |
| `validatePreFundMptRepairResult` | 5 | src/main-process/pre-fund-reconciliation/mpt-import/policies.js |
| `validateSafeErrorV1` | 5 | src/main-process/background-execution/error-codec.js |
| `valuesFromToolboxRow` | 5 | src/backend/position-reconciliation-import/xlsx-reader.js |
| `VCC_CURRENCY_DB_COLUMN` | 5 | src/backend/vcc-op-calc-db/columns.js |
| `vccStorageGuardTriggerDefinition` | 5 | src/backend/vcc-financial-op-db/storage-contract.js |
| `WORKER_ERROR_MARKER` | 5 | src/main-process/vcc-op-calc/parser-pipeline.js |
| `writeBankBuParserFailure` | 5 | src/main-process/bank-bu-worker/parser-outcome.js |
| `writeChannelWorkbook` | 5 | src/main-process/pre-fund-reconciliation/excel-writer.js |
| `writeParserOutcome` | 5 | src/main-process/pre-fund-reconciliation/mpt-import/managed-import.js |
| `XLSXStyle` | 5 | src/main-process/recon-id-fix-io.js |
| `zeroResourceVector` | 5 | src/main-process/background-execution/resource-lease.js |
| `__reconCols` | 4 | src/constants/fund-transfer-recon-fields.js |
| `ABSENT_MIRROR_DIGEST` | 4 | src/main-process/bank-bu-worker/identity.js |
| `acknowledgePendingRunByTaskRun` | 4 | src/main-process/pending-archive-lineage.js |
| `ACQUIRING_EXPORT_POLICIES` | 4 | src/main-process/read-only-exports/acquiring/policies.js |
| `acquiringRunData` | 4 | src/main-process/read-only-exports/acquiring/query.js |
| `ADJUSTMENT_LINEAGE_NAME_PREFIX` | 4 | src/backend/vcc-financial-op/adjustment-lineage.js |
| `ADM_EXTRA_FIELDS` | 4 | src/constants/adm-bank-deposit-fields.js |
| `ADM_FUND_TYPES` | 4 | src/constants/adm-bank-deposit-fields.js |
| `ADM_MERCHANT_ID` | 4 | src/backend/database/migrations.js |
| `applyApplicableChannelIdsInTx` | 4 | src/backend/database/scenarios-repository.js |
| `applyPositionAccountSnapshot` | 4 | src/backend/position-reconciliation-import/account-writer.js |
| `applyPositionBankBatch` | 4 | src/backend/position-reconciliation-import/bank-writer.js |
| `applyPositionOrdinarySourceFiles` | 4 | src/backend/position-reconciliation-import/source-writer.js |
| `APPROVED_VCC_TRIGGERS` | 4 | src/backend/vcc-financial-op/mutation-policy.js |
| `ARRAY_OVERHEAD_BYTES` | 4 | src/main-process/fund-recon-worker/state-footprint.js |
| `assertAcquiringCopySourceFresh` | 4 | src/main-process/read-only-exports/acquiring/query.js |
| `assertBiff8OverlayMatchesProjection` | 4 | src/backend/toolbox-format/biff8-overlay.js |
| `assertBizOpMonthEndAdmission` | 4 | src/main-process/biz-op-recon-session.js |
| `assertMptSpoolDiskCapacity` | 4 | src/main-process/pre-fund-reconciliation/mpt-import/managed-import.js |
| `assertNewAccountExpectedArtifactAuthority` | 4 | src/main-process/new-account/generation-validator.js |
| `assertNoPendingMonthEndCopy` | 4 | src/main-process/biz-op-recon-session.js |
| `assertRunResumeFresh` | 4 | src/main-process/acquiring-bill-currency-run-data.js |
| `assertSourceGroupEvidence` | 4 | src/main-process/read-only-exports/biz-op/query.js |
| `assertVccExportWorkerSnapshotEqual` | 4 | src/main-process/vcc-financial-op-output/authority.js |
| `atomicSwitchVccStorage` | 4 | src/main-process/vcc-financial-op-storage-rebuild.js |
| `BANK_BU_SPOOL_MAX_MANIFEST_BYTES` | 4 | src/main-process/bank-bu-worker/spool-contract.js |
| `BANK_BU_SPOOL_MAX_NDJSON_LINE_BYTES` | 4 | src/main-process/bank-bu-worker/spool-contract.js |
| `BANK_DEPOSIT_SIGNATURE` | 4 | src/constants/table-signatures.js |
| `BANK_IDENTIFIER_FIELDS` | 4 | src/main-process/position-reconciliation/contracts.js |
| `BANK_MATCH_KEY_DB_COLUMN` | 4 | src/backend/bank-bu-recon-db/columns.js |
| `BANK_MERCHANT_ID_FIELD` | 4 | src/main-process/scenario-engines/dbs-charge-fund-check.js |
| `bankAmountEqualWithoutExtraFee` | 4 | src/main-process/scenario-engines/r5-fund-transfer-backfill.js |
| `BankStatementMergeError` | 4 | src/main-process/bank-statement-merge.js |
| `baseMappedRow` | 4 | src/backend/vcc-financial-op/row-mapper.js |
| `bindingSnapshot` | 4 | src/main-process/background-execution/action-task-binding-registry.js |
| `BIZ_OP_READ_ONLY_POLICIES` | 4 | src/main-process/read-only-exports/biz-op/policies.js |
| `BIZ_OP_RUN_TASK_KEY` | 4 | src/main-process/biz-op-archive-lineage.js |
| `bizOpRunLineagePlan` | 4 | src/main-process/biz-op-archive-lineage.js |
| `BOC_CHANNEL_NAME` | 4 | src/constants/boc-dispatch-order-fields.js |
| `BOC_CHANNEL_VALUE` | 4 | src/constants/boc-fx-link-fields.js |
| `boundedJpmReceiptFromExact` | 4 | src/main-process/recon-id-fix-service/jpm-receipt-evidence.js |
| `buildArchiveEvidenceV2` | 4 | src/backend/vcc-financial-op/archive-evidence.js |
| `buildBigAccountInteractionDraft` | 4 | src/main-process/statement-worker/session-state.js |
| `buildDuplicateInboundGroups` | 4 | src/main-process/duplicate-inbound-match/matching-engine.js |
| `buildFailureAuditPlan` | 4 | src/backend/vcc-financial-op/destructive-write.js |
| `buildJpmWritebackPlan` | 4 | src/main-process/recon-id-fix-service/jpm-writeback-plan.js |
| `buildLogicalAccounts` | 4 | src/main-process/position-reconciliation/logical-accounts.js |
| `buildOriginalBaseName` | 4 | src/main-process/scenario-hit-rows-writer.js |
| `buildVccStorageCandidate` | 4 | src/main-process/vcc-financial-op-storage-rebuild.js |
| `BUSINESS_BILL_SHEET_NAME` | 4 | src/constants/recon-id-fix-fields.js |
| `calculateMonth` | 4 | src/backend/vcc-financial-op/calculator.js |
| `cancelError` | 4 | src/backend/position-reconciliation-import/maintenance-writer.js |
| `capabilityInventory` | 4 | src/main-process/background-execution/index.js |
| `captureProvisionalTaskStagingIdentity` | 4 | src/main-process/vcc-financial-op-output/staging-identity.js |
| `CHANNEL_BILL_SHEET_NAME` | 4 | src/constants/gateway-bill-recon-fields.js |
| `claimVccFinancialOpFirstMonth` | 4 | src/backend/vcc-financial-op-db/repository.js |
| `CLEANUP_COPY_HEADERS` | 4 | src/constants/platform-cleanup-template-fields.js |
| `cleanupBankBuSpoolParents` | 4 | src/main-process/bank-bu-worker/spool-filesystem.js |
| `cleanupDuplicateSpoolParents` | 4 | src/main-process/duplicate-inbound-match/spool-filesystem.js |
| `cleanupKnownFiles` | 4 | src/main-process/duplicate-inbound-match/spool-filesystem.js |
| `cleanupSpools` | 4 | src/main-process/bank-bu-worker/dual-parser-dispatch.js |
| `clearBankDepositHitMarkersByBizIds` | 4 | src/backend/database/linked-table-repository.js |
| `clearDiffRowsByRunId` | 4 | src/backend/acquiring-bill-currency-db/run-repository.js |
| `closeAllNewAccountCurrencyDropdowns` | 4 | src/renderer.js |
| `closeResourceGovernor` | 4 | src/main-process/background-execution/resource-governor.js |
| `closeWorkbookOutputStream` | 4 | src/main-process/toolbox-output-writer.js |
| `commitJpmAdmMutationWithReceipt` | 4 | src/main-process/recon-id-fix-service/jpm-writeback-transaction.js |
| `commitRun` | 4 | src/main-process/bank-bu-worker/side-database.js |
| `compareFileSequences` | 4 | src/main-process/pre-fund-reconciliation/mpt-schema.js |
| `completeMirrorFromCommittedSide` | 4 | src/main-process/bank-bu-worker/outcome-inspector.js |
| `componentMax` | 4 | src/main-process/background-execution/resource-lease.js |
| `computeAmounts` | 4 | src/main-process/vcc-op-calc-session.js |
| `copyVerifiedAnomalyReport` | 4 | src/main-process/position-reconciliation/filtered-source-report.js |
| `countBankDepositByDateRange` | 4 | src/backend/database/linked-table-repository.js |
| `countByMonth` | 4 | src/backend/pending-db/removed-repository.js |
| `countFxByDateRange` | 4 | src/backend/database/linked-table-repository.js |
| `countGatewayBillByDateRange` | 4 | src/backend/database/linked-table-repository.js |
| `countSignificantDigitsFromString` | 4 | src/backend/file-service/writers.js |
| `createAcquiringMatureBindings` | 4 | src/main-process/background-execution/adapters/acquiring-adapter.js |
| `createAdmissionQueue` | 4 | src/main-process/background-execution/admission-queue.js |
| `createBackgroundExecutionRuntimeManager` | 4 | src/main-process/background-execution/runtime.js |
| `createBankBuReconSession` | 4 | src/main-process/bank-bu-recon-session.js |
| `createBatchRecoveryOverlayAdapter` | 4 | src/main-process/background-execution/task-lifecycle-adapter.js |
| `createBoundedValuesAccumulator` | 4 | src/backend/toolbox-xlsx-stream/bounded-values-accumulator.js |
| `createBusinessOperationRegistry` | 4 | src/main-process/business-operation-registry.js |
| `createCanaryReceiptInspector` | 4 | src/main-process/background-execution/canary/durable-recovery.js |
| `createCancelToken` | 4 | src/main-process/acquiring-bill-currency-session.js |
| `createDuplicateInboundMatchStore` | 4 | src/backend/duplicate-inbound-match-store.js |
| `createDuplicateManagedService` | 4 | src/main-process/duplicate-inbound-match/managed-service.js |
| `createDuplicateManagedStartupGate` | 4 | src/main-process/duplicate-inbound-match/managed-service.js |
| `createDuplicateMirrorDatabase` | 4 | src/main-process/duplicate-inbound-match/managed-service.js |
| `createDuplicatePairedTopologyPlanner` | 4 | src/main-process/duplicate-inbound-match/topology.js |
| `createExistingDispatchTransportAdapter` | 4 | src/main-process/background-execution/adapters/existing-dispatch-adapter.js |
| `createFundReconArtifactGenerator` | 4 | src/main-process/fund-recon-worker/artifact-generator.js |
| `createFundReconEvidenceProvider` | 4 | src/main-process/fund-recon-worker/evidence-provider.js |
| `createFundReconService` | 4 | src/main-process/fund-recon-worker/service.js |
| `createGenerationHelpers` | 4 | src/main-process/statement-generation-business.js |
| `createManualBalanceSeedInspector` | 4 | src/main-process/manual-balance-seed-settlement.js |
| `createMatureActionAdapterBindings` | 4 | src/main-process/background-execution/mature-action-adapters.js |
| `createOrderedMptCoordinator` | 4 | src/main-process/pre-fund-reconciliation/mpt-import/managed-import.js |
| `createOrderedReducer` | 4 | src/main-process/vcc-op-calc/ordered-reducer.js |
| `createPalette` | 4 | src/backend/toolbox-format/biff8-colors.js |
| `createPendingSession` | 4 | src/main-process/pending-session.js |
| `createPositionImportMatureBinding` | 4 | src/main-process/background-execution/adapters/position-import-adapter.js |
| `createPositionReconciliationStore` | 4 | src/main-process/position-reconciliation/store.js |
| `createPreFundMptTopologyPlanner` | 4 | src/main-process/pre-fund-reconciliation/mpt-import/topology.js |
| `createPreFundReconciliationRunStore` | 4 | src/backend/pre-fund-reconciliation-run-store.js |
| `createReconFixEvidenceSettlementAdmission` | 4 | src/main-process/recon-id-fix-service/evidence-settlement-admission.js |
| `createReconFixJpmDatabaseAuthority` | 4 | src/main-process/recon-id-fix-service/jpm-database-authority.js |
| `createReconFixService` | 4 | src/main-process/recon-id-fix-service/service.js |
| `createRecoveryTaskLifecycleAdapter` | 4 | src/main-process/background-execution/task-lifecycle-adapter.js |
| `createRetryableSpoolCleanup` | 4 | src/main-process/bank-bu-worker/dual-parser-dispatch.js |
| `createScenarioImportContextStore` | 4 | src/main-process/archive-center/scenario-import-context-store.js |
| `createServiceClient` | 4 | src/main-process/background-execution/index.js |
| `createSingleWriterSession` | 4 | src/main-process/pre-fund-reconciliation/mpt-import/single-writer-session.js |
| `createSpools` | 4 | src/main-process/bank-bu-worker/dual-parser-dispatch.js |
| `createStatementBalanceSeedOverwritePrivateContextDto` | 4 | src/main-process/statement-worker/contracts.js |
| `createStatementBalanceSeedOverwritePromptDto` | 4 | src/main-process/statement-worker/contracts.js |
| `createStatementBigAccountContinuationRequest` | 4 | src/main-process/statement-worker/interaction-contracts.js |
| `createStatementCancelInteractionRequest` | 4 | src/main-process/statement-worker/interaction-contracts.js |
| `createStatementGenerationRequest` | 4 | src/main-process/statement-worker/generation-contracts.js |
| `createStatementInteractionPromptDto` | 4 | src/main-process/statement-worker/contracts.js |
| `createStatementService` | 4 | src/main-process/statement-worker/service.js |
| `createStatementServiceRequest` | 4 | src/main-process/statement-worker/import-contracts.js |
| `createStatementSourceIdentityGuard` | 4 | src/main-process/statement-worker/source-identity.js |
| `createStatementTokenStore` | 4 | src/main-process/statement-worker/service.js |
| `createToolboxLargeSplitMatureBinding` | 4 | src/main-process/toolbox-large-split-dispatch.js |
| `createToolboxPublicationMatureBinding` | 4 | src/main-process/toolbox-output-publication-dispatch.js |
| `createVccExportTopologyPlanner` | 4 | src/main-process/vcc-financial-op-output/topology.js |
| `createVccFinancialOpService` | 4 | src/main-process/vcc-financial-op-service.js |
| `createVccOpCalcSession` | 4 | src/main-process/vcc-op-calc-session.js |
| `currentFileMatchesIdentity` | 4 | src/main-process/pre-fund-reconciliation/excel-writer.js |
| `dateMismatchReason` | 4 | src/main-process/scenario-engines/r5-fund-transfer-backfill.js |
| `daysInMonth` | 4 | src/backend/toolbox-format/number-date.js |
| `decodeHeaderPayload` | 4 | src/main-process/toolbox-background/route-db-contract.js |
| `decodeRowPayload` | 4 | src/main-process/toolbox-background/route-db-contract.js |
| `decodeStylePayload` | 4 | src/main-process/toolbox-background/route-db-contract.js |
| `defaultIdFactory` | 4 | src/main-process/background-execution/resource-governor.js |
| `deleteBankDepositByDateRange` | 4 | src/backend/database/linked-table-repository.js |
| `deleteChannel` | 4 | src/backend/database/channels-repository.js |
| `deleteFxByDateRange` | 4 | src/backend/database/linked-table-repository.js |
| `deleteGatewayBillByDateRange` | 4 | src/backend/database/linked-table-repository.js |
| `deleteScenario` | 4 | src/backend/database/scenarios-repository.js |
| `deriveLinkedRows` | 4 | src/main-process/position-reconciliation/derivation.js |
| `detectDistribution` | 4 | src/main-process/app-updater.js |
| `detectFundTransferManyToMany` | 4 | src/main-process/reconciliation-orchestrator.js |
| `dispatchLargeSplit` | 4 | src/main-process/toolbox-large-split-dispatch.js |
| `dispatchRunCheck` | 4 | src/main-process/run-check-worker-pool.js |
| `DRAWINGML_NAMESPACES` | 4 | src/backend/toolbox-format/ooxml-namespaces.js |
| `DUPLICATE_IMPORT_STARTUP_INSPECTOR_KEY` | 4 | src/main-process/duplicate-inbound-match/startup-recovery.js |
| `DUPLICATE_POLICIES` | 4 | src/main-process/duplicate-inbound-match/policies.js |
| `DUPLICATE_SPOOL_MAX_MANIFEST_BYTES` | 4 | src/main-process/duplicate-inbound-match/spool-contract.js |
| `DUPLICATE_SPOOL_MAX_NDJSON_LINE_BYTES` | 4 | src/main-process/duplicate-inbound-match/spool-contract.js |
| `DUPLICATE_STATE_OWNER_KEY` | 4 | src/main-process/duplicate-inbound-match/policies.js |
| `durableRecoveryPolicy` | 4 | src/main-process/background-execution/canary/index.js |
| `ensureMptSpoolDirectory` | 4 | src/main-process/pre-fund-reconciliation/mpt-import/parser-outcome.js |
| `ensurePositionLargeImportSchemaAtPath` | 4 | src/main-process/position-reconciliation/large-import-schema.js |
| `ensureUiStyleDefault` | 4 | src/backend/database/settings-repository.js |
| `ensureVccStorageSideTables` | 4 | src/backend/vcc-financial-op-db/storage-contract.js |
| `escapeRegExp` | 4 | src/main-process/scenario-engines/r5-refund-order-backfill.js |
| `estimateDuplicateStateFootprint` | 4 | src/main-process/duplicate-inbound-match/managed-service.js |
| `estimateFundReconStateFootprint` | 4 | src/main-process/fund-recon-worker/service.js |
| `estimateNewAccountGenerationPhaseResources` | 4 | src/main-process/new-account/resource-estimator.js |
| `estimateStatementPendingInteractionFootprint` | 4 | src/main-process/statement-worker/state-footprint.js |
| `executeBizOpReadOnlyExport` | 4 | src/main-process/read-only-exports/biz-op/worker-entry.js |
| `executeDestructiveMutationWithSafeAudit` | 4 | src/backend/vcc-financial-op/destructive-write.js |
| `executeExportAggregate` | 4 | src/main-process/bank-bu-worker/export-operation.js |
| `executeExportSingle` | 4 | src/main-process/bank-bu-worker/export-operation.js |
| `executeImportMonth` | 4 | src/main-process/bank-bu-worker/import-operation.js |
| `executeMergeGeneration` | 4 | src/main-process/toolbox-background/generation-core.js |
| `executeMultiSplitGeneration` | 4 | src/main-process/toolbox-background/route-scanner-core.js |
| `executePendingReadOnlyExport` | 4 | src/main-process/read-only-exports/pending/worker-entry.js |
| `executePositionReadOnlyExport` | 4 | src/main-process/read-only-exports/position/worker-entry.js |
| `executePreFundReadOnlyExport` | 4 | src/main-process/read-only-exports/pre-fund/worker-entry.js |
| `executeResultMutationWithSafeAudit` | 4 | src/backend/vcc-financial-op/result-write.js |
| `executeSplitGeneration` | 4 | src/main-process/toolbox-background/generation-core.js |
| `executeStatementGenerationWithSafepoints` | 4 | src/main-process/statement-worker/generation.js |
| `executeVccExportWriterGraph` | 4 | src/main-process/vcc-financial-op-output/writer-coordinator.js |
| `executeVccFinancialOpReadOnlyExport` | 4 | src/main-process/read-only-exports/vcc-financial-op/worker-entry.js |
| `EXECUTION_TERMINAL_SOURCES` | 4 | src/main-process/background-execution/execution-result.js |
| `expandDynamicResourceVector` | 4 | src/main-process/background-execution/resource-lease.js |
| `exportAggregateRuns` | 4 | src/backend/pending-export/writer.js |
| `exportFilter` | 4 | src/backend/toolbox-xlsx-stream/split-export-filter.js |
| `exportMultiFilters` | 4 | src/backend/toolbox-xlsx-stream/split-export-filter.js |
| `extractChannelRegionCombos` | 4 | src/backend/database/channel-enum-repository.js |
| `findHeaderMatchPosition` | 4 | src/backend/file-service/readers.js |
| `FLOW_ACCOUNT_KEY_DB_COLUMN` | 4 | src/backend/biz-op-recon-db/columns.js |
| `FLOW_BU_FIELD_DB_COLUMN` | 4 | src/backend/biz-op-recon-db/columns.js |
| `FLOW_DIRECTION_DB_COLUMN` | 4 | src/backend/biz-op-recon-db/columns.js |
| `FLOW_RECON_AMOUNT_DB_COLUMN` | 4 | src/backend/biz-op-recon-db/columns.js |
| `flowHeaderToDbColumn` | 4 | src/backend/biz-op-recon-db/columns.js |
| `freezeAcquiringCopySource` | 4 | src/main-process/read-only-exports/acquiring/query.js |
| `freezeBizOpSourceSnapshot` | 4 | src/main-process/read-only-exports/biz-op/query.js |
| `freezePreFundSourceSnapshot` | 4 | src/main-process/read-only-exports/pre-fund/query.js |
| `freezeVccDatasetSourceSnapshot` | 4 | src/main-process/read-only-exports/vcc-financial-op/query.js |
| `FUND_RECON_POLICIES` | 4 | src/main-process/fund-recon-worker/policies.js |
| `FUND_RECON_STATE_OWNER_KEY` | 4 | src/main-process/fund-recon-worker/policies.js |
| `FUND_TYPE_ENUM_FILE_NAME` | 4 | src/constants/fund-type-enum.js |
| `GATEWAY_BILL_SHEET_NAME` | 4 | src/constants/gateway-bill-recon-fields.js |
| `GATEWAY_RECON_HEADERS_FILE_NAME` | 4 | src/constants/gateway-recon-headers-loader.js |
| `generateValidateAndPublishAcquiringExport` | 4 | src/main-process/read-only-exports/acquiring/managed-export.js |
| `generateValidateAndPublishPositionExport` | 4 | src/main-process/read-only-exports/position/managed-export.js |
| `generateValidateAndPublishVccFinancialOpExport` | 4 | src/main-process/read-only-exports/vcc-financial-op/managed-export.js |
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
| `getReconIdFixBillCategory` | 4 | src/backend/database/settings-repository.js |
| `getRowById` | 4 | src/backend/biz-op-recon-db/imports-repository.js |
| `getRunResultSnapshot` | 4 | src/backend/vcc-financial-op/read-snapshot.js |
| `getTaskFilePlanDefinition` | 4 | src/main-process/archive-center/task-file-plan-registry.js |
| `getTemplateByKey` | 4 | src/backend/database/template-repository.js |
| `getTemplateByName` | 4 | src/backend/database/template-repository.js |
| `gregorianTupleToExcelSerial` | 4 | src/backend/toolbox-format/number-date.js |
| `GW_CURRENCY_FIELD` | 4 | src/main-process/scenario-engines/dbs-charge-fund-check.js |
| `handleResourceGrant` | 4 | src/main-process/recon-id-fix-service/worker-entry.js |
| `handleResourceReject` | 4 | src/main-process/recon-id-fix-service/worker-entry.js |
| `handleResourceRevoke` | 4 | src/main-process/recon-id-fix-service/worker-entry.js |
| `hasLinkedTableRows` | 4 | src/backend/database/linked-table-repository.js |
| `hasMoreThanTwoDecimalsFromString` | 4 | src/backend/file-service/writers.js |
| `hasShownWinOneDriveStorageNotice` | 4 | src/backend/database/settings-repository.js |
| `heapStats` | 4 | src/backend/biz-op-recon-import/import-worker.js |
| `identifyAccountPair` | 4 | src/main-process/position-reconciliation/logical-accounts.js |
| `IMPORT_BASE_RESOURCES` | 4 | src/main-process/pre-fund-reconciliation/mpt-import/topology.js |
| `IMPORT_WRITER_RESOURCES` | 4 | src/main-process/pre-fund-reconciliation/mpt-import/topology.js |
| `importBillFile` | 4 | src/backend/acquiring-bill-currency-import/reader.js |
| `importCommittedDataset` | 4 | src/main-process/bank-bu-worker/import-operation.js |
| `importFlowFile` | 4 | src/backend/acquiring-bill-currency-import/reader.js |
| `importMonth` | 4 | src/main-process/bank-bu-recon-run-data.js |
| `importSystemOpGroup` | 4 | src/backend/vcc-financial-op/system-op-importer.js |
| `indexColumns` | 4 | src/backend/vcc-financial-op/read-schema.js |
| `initializeOpeningBalances` | 4 | src/backend/vcc-financial-op/calculator.js |
| `insertBankRowsInTxn` | 4 | src/backend/bank-bu-recon-db/month-repository.js |
| `insertPendingRowsInTxn` | 4 | src/backend/bank-bu-recon-db/month-repository.js |
| `inspectPositionOperationCommitChain` | 4 | src/main-process/position-reconciliation/side-db-mutation.js |
| `inspectVccStorage` | 4 | src/main-process/vcc-financial-op-storage-rebuild.js |
| `INVALID_DIRECTIONS_WARNING_CODE` | 4 | src/main-process/scenario-engines/r5-fund-transfer-backfill.js |
| `isBankDepositChannelFile` | 4 | src/backend/database/channel-enum-repository.js |
| `isBuiltinNumberFormat` | 4 | src/backend/toolbox-format/number-date.js |
| `isFilenameMappingMode` | 4 | src/main.js |
| `isMemoryLimitError` | 4 | src/backend/file-service/readers.js |
| `isSafeMptDetailLines` | 4 | src/main-process/pre-fund-reconciliation/mpt-import/file-result-safety.js |
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
| `listTemplateBundleEntries` | 4 | src/backend/database/template-repository.js |
| `loadExportDataByRun` | 4 | src/main-process/bank-bu-recon-run-data.js |
| `loadJobMeta` | 4 | src/backend/biz-op-recon-import/import-worker.js |
| `loadValidationContext` | 4 | src/main-process/vcc-financial-op-output/artifact-evidence.js |
| `makeUnionFind` | 4 | src/main-process/position-reconciliation/logical-accounts.js |
| `MAP_ENTRY_OVERHEAD_BYTES` | 4 | src/main-process/fund-recon-worker/state-footprint.js |
| `mappedRowToInsertParams` | 4 | src/backend/vcc-financial-op/row-mapper.js |
| `markBankDepositHits` | 4 | src/backend/database/linked-table-repository.js |
| `markWinOneDriveStorageNoticeShown` | 4 | src/backend/database/settings-repository.js |
| `MERCHANT_ID_MULTI_ACCOUNT_MARKER` | 4 | src/backend/database/utils.js |
| `MID_ALLOCATION_SUCCESS_STATUS` | 4 | src/constants/fund-transfer-recon-fields.js |
| `MIN_RESERVATION_BYTES` | 4 | src/main-process/fund-recon-worker/state-footprint.js |
| `MONTH_KEY_PATTERN` | 4 | src/main-process/bank-bu-worker/operation-receipt-repository.js |
| `MOVEMENT_SOURCE_TYPES` | 4 | src/backend/vcc-financial-op/result-adjustments.js |
| `MPT_SPOOL_MAX_MANIFEST_BYTES` | 4 | src/main-process/pre-fund-reconciliation/mpt-import/spool-contract.js |
| `MTX_FEATURE` | 4 | src/constants/refund-backfill-fields.js |
| `NEW_ACCOUNT_SAVE_AS_POLICY` | 4 | src/main-process/new-account/policies.js |
| `normalizeAcquiringExportInput` | 4 | src/main-process/read-only-exports/acquiring/actions.js |
| `normalizeBizOpReadOnlyExportInput` | 4 | src/main-process/read-only-exports/biz-op/actions.js |
| `normalizeCurrencyOptionEntry` | 4 | src/renderer.js |
| `normalizeMaintainedBigAccounts` | 4 | src/main-process/big-account-recognition.js |
| `normalizeMergeInput` | 4 | src/main-process/toolbox-background/generation-contract.js |
| `normalizePendingReadOnlyExportInput` | 4 | src/main-process/read-only-exports/pending/actions.js |
| `normalizePositionReadOnlyExportInput` | 4 | src/main-process/read-only-exports/position/actions.js |
| `normalizePositionStreamingSourceTypes` | 4 | src/backend/position-reconciliation-import/constants.js |
| `normalizePreFundReadOnlyExportInput` | 4 | src/main-process/read-only-exports/pre-fund/actions.js |
| `normalizeRunId` | 4 | src/backend/vcc-financial-op/read-snapshot.js |
| `normalizeSettlementRecoveryResult` | 4 | src/main-process/background-execution/recovery-source.js |
| `normalizeSplitInput` | 4 | src/main-process/toolbox-background/generation-contract.js |
| `normalizeVccExportShard` | 4 | src/main-process/vcc-financial-op-output/shard-planner.js |
| `normalizeVccFinancialOpReadOnlyExportInput` | 4 | src/main-process/read-only-exports/vcc-financial-op/actions.js |
| `openEntryStream` | 4 | src/backend/position-reconciliation-import/xlsx-reader.js |
| `openModuleMenu` | 4 | src/renderer.js |
| `openPositionExportStore` | 4 | src/main-process/read-only-exports/position/query.js |
| `openPositionReconciliationStoreReadOnly` | 4 | src/main-process/position-reconciliation/store.js |
| `openToolboxBiff8Pass` | 4 | src/backend/toolbox-format/biff8-pass.js |
| `openToolboxCsvPass` | 4 | src/backend/toolbox-format/csv-pass.js |
| `openVccFinancialOpExportDatabase` | 4 | src/main-process/read-only-exports/vcc-financial-op/query.js |
| `OPPONENT_BILL_SHEET_NAME` | 4 | src/constants/recon-id-fix-fields.js |
| `ORDER_REPAIR_SHEET_NAME` | 4 | src/constants/recon-id-fix-fields.js |
| `ORDER_REPAIR_SHEET_NAME_GATEWAY` | 4 | src/constants/gateway-bill-recon-fields.js |
| `OWNED_ACTIONS` | 4 | src/main-process/duplicate-inbound-match/worker-host.js |
| `parseAndValidateEnvelope` | 4 | src/main-process/background-execution/protocol-validator.js |
| `parseColumnFromCellRef` | 4 | src/backend/acquiring-bill-currency-import/reader.js |
| `parseMptCandidates` | 4 | src/main-process/pre-fund-reconciliation/mpt-import/parser-core.js |
| `parseOutboxBatchId` | 4 | src/main-process/archive-center/outbox-store.js |
| `parsePackagedRuntimeRequest` | 4 | src/main-process/background-execution/canary/packaged-runtime-request.js |
| `PARSER_RESULT_KEYS` | 4 | src/main-process/vcc-op-calc/parser-core.js |
| `parseRowXml` | 4 | src/backend/vcc-op-calc-import/reader.js |
| `parseVccFileUnit` | 4 | src/main-process/vcc-op-calc/parser-core.js |
| `peekFirstFile` | 4 | src/backend/big-table-import/engine.js |
| `peekToolboxSplitHeaders` | 4 | src/main-process/toolbox-format-operations.js |
| `PENDING_MATCH_KEY_DB_COLUMN` | 4 | src/backend/bank-bu-recon-db/columns.js |
| `PENDING_READ_ONLY_POLICIES` | 4 | src/main-process/read-only-exports/pending/policies.js |
| `pendingExportWriter` | 4 | src/main-process/read-only-exports/pending/writer.js |
| `PERSISTENT_STATE_RESOURCES` | 4 | src/main-process/fund-recon-worker/policies.js |
| `PHASE_RESOURCES` | 4 | src/main-process/fund-recon-worker/policies.js |
| `planRunOutputPaths` | 4 | src/main-process/acquiring-bill-currency-writer.js |
| `planVccExportShards` | 4 | src/main-process/vcc-financial-op-output/shard-planner.js |
| `POSITION_IMPORT_PROGRESS_HEARTBEAT_MS` | 4 | src/backend/position-reconciliation-import/constants.js |
| `POSITION_READ_ONLY_POLICY` | 4 | src/main-process/read-only-exports/position/policies.js |
| `POSITION_SST_LRU_MAX_ENTRIES` | 4 | src/backend/position-reconciliation-import/constants.js |
| `POSITION_SST_MEMORY_BUDGET_BYTES` | 4 | src/backend/position-reconciliation-import/constants.js |
| `positionBankAmountWithExtraFee` | 4 | src/main-process/position-reconciliation/decimal.js |
| `positiveDelta` | 4 | src/main-process/background-execution/resource-lease.js |
| `PRE_FUND_MPT_STATIC_KEYS` | 4 | src/main-process/pre-fund-reconciliation/mpt-import/policies.js |
| `PRE_FUND_READ_ONLY_POLICIES` | 4 | src/main-process/read-only-exports/pre-fund/policies.js |
| `preFundRunLineagePlan` | 4 | src/main-process/pre-fund-archive-lineage.js |
| `preFundRunOutputIntent` | 4 | src/main-process/pre-fund-archive-lineage.js |
| `prepareRunExport` | 4 | src/main-process/acquiring-bill-currency-run-data.js |
| `prepareRunResume` | 4 | src/main-process/acquiring-bill-currency-run-data.js |
| `PREPROCESS_TABLE_SIGNATURES` | 4 | src/constants/table-signatures.js |
| `previewDeleteTargetSnapshot` | 4 | src/backend/vcc-financial-op/read-snapshot.js |
| `previewUnarchiveSnapshot` | 4 | src/backend/vcc-financial-op/read-snapshot.js |
| `projectOutputRow` | 4 | src/main-process/pre-fund-reconciliation/output-mapper.js |
| `projectToolboxRowValues` | 4 | src/backend/toolbox-format/model.js |
| `pruneStagingRoot` | 4 | src/main-process/position-reconciliation/input-staging.js |
| `publishDurableArtifactAsync` | 4 | src/main-process/toolbox-output-publication-dispatch.js |
| `PURE_COMPUTE_ACTION_KEY` | 4 | src/main-process/background-execution/canary/index.js |
| `PURE_COMPUTE_ENTRY_KEY` | 4 | src/main-process/background-execution/canary/index.js |
| `PURE_COMPUTE_RESULT_VALIDATOR_KEY` | 4 | src/main-process/background-execution/canary/index.js |
| `PURE_COMPUTE_WORKER_BINDING` | 4 | src/main-process/background-execution/canary/index.js |
| `PURE_COMPUTE_WORKER_ENTRY` | 4 | src/main-process/background-execution/canary/index.js |
| `readAdmBankDepositRows` | 4 | src/backend/database/linked-table-repository.js |
| `readBankBuSpoolPair` | 4 | src/main-process/bank-bu-worker/import-operation.js |
| `readBankFiles` | 4 | src/main-process/position-reconciliation/readers.js |
| `readBiff8Overlay` | 4 | src/backend/toolbox-format/biff8-overlay.js |
| `readBocBankDepositRows` | 4 | src/backend/database/linked-table-repository.js |
| `readChannelExport` | 4 | src/main-process/read-only-exports/pre-fund/query.js |
| `readGatewayBillRowsByChannels` | 4 | src/backend/database/linked-table-repository.js |
| `readline` | 4 | src/main-process/bank-bu-worker/spool-reader.js |
| `readParserOutcome` | 4 | src/main-process/pre-fund-reconciliation/mpt-import/parser-outcome.js |
| `readResultWorkbook` | 4 | src/main-process/position-reconciliation/excel-io.js |
| `readSharedStrings` | 4 | src/backend/vcc-op-calc-import/reader.js |
| `readSourceFiles` | 4 | src/main-process/position-reconciliation/readers.js |
| `readXlsxSheetNames` | 4 | src/main-process/duplicate-inbound-match/document-statement-reader.js |
| `RECON_FIX_JPM_POLICY` | 4 | src/main-process/recon-id-fix-service/policies.js |
| `RECON_RESULT_FIELDS` | 4 | src/constants/recon-id-fix-fields.js |
| `RECON_RESULT_SHEET_NAME` | 4 | src/constants/recon-id-fix-fields.js |
| `RECON_RESULT_SHEET_NAME_GATEWAY` | 4 | src/constants/gateway-bill-recon-fields.js |
| `recordMonthEndCopyIntent` | 4 | src/main-process/biz-op-recon-session.js |
| `recoverPositionImportWorkerExit` | 4 | src/main-process/position-reconciliation/import-recovery.js |
| `refundOrderSession` | 4 | src/main.js |
| `registerDuplicatePairedParserFinalization` | 4 | src/main-process/duplicate-inbound-match/paired-parser-shutdown.js |
| `renameTemplate` | 4 | src/backend/database/template-repository.js |
| `REPAIR_WRITER_RESOURCES` | 4 | src/main-process/pre-fund-reconciliation/mpt-import/topology.js |
| `replaceBocFxLink` | 4 | src/backend/database/linked-table-repository.js |
| `replaceLinkedTable` | 4 | src/backend/database/linked-table-repository.js |
| `replaceLinkedTableStreaming` | 4 | src/backend/database/linked-table-repository.js |
| `resetFundTransferReconUsage` | 4 | src/main-process/scenario-engines/r5-payment-offline-allocation-backfill.js |
| `resolveBankRuleEligibility` | 4 | src/main-process/pre-fund-reconciliation/matching-engine.js |
| `resolveCurrencyValue` | 4 | src/backend/file-service/normalizers.js |
| `resolveDuplicateInboundDocumentMatches` | 4 | src/main-process/duplicate-inbound-match/matching-engine.js |
| `resolveDuplicateInboundMptMatches` | 4 | src/main-process/duplicate-inbound-match/matching-engine.js |
| `resolveFullColor` | 4 | src/backend/toolbox-format/biff8-colors.js |
| `resolveSourceResource` | 4 | src/main-process/statement-worker/worker-entry.js |
| `resolveStatementSourceIdentity` | 4 | src/main-process/statement-worker/source-identity.js |
| `resolveWorkerScript` | 4 | src/main-process/run-check-multiworker.js |
| `rgbToHsl` | 4 | src/backend/toolbox-format/biff8-colors.js |
| `rollbackOpenTransaction` | 4 | src/main-process/recon-id-fix-service/jpm-writeback-transaction.js |
| `routeMaskForIndexes` | 4 | src/main-process/toolbox-background/route-db-contract.js |
| `routeMaskIncludes` | 4 | src/main-process/toolbox-background/route-db-contract.js |
| `rowScanner` | 4 | src/backend/big-table-import/engine.js |
| `runAcquiringExistingDiffCopyInline` | 4 | src/main-process/read-only-exports/acquiring/executor.js |
| `runBocDispatchOrderFix` | 4 | src/main-process/recon-id-fix-engine.js |
| `runC4Scenario` | 4 | src/main-process/recon-id-fix-engine.js |
| `runCheckCore` | 4 | src/main-process/acquiring-bill-currency-session.js |
| `runDbsChargeFundCheck` | 4 | src/main-process/reconciliation-orchestrator.js |
| `runEvidenceHash` | 4 | src/main-process/duplicate-inbound-match/service.js |
| `runJpmDispatchOrderFix` | 4 | src/main-process/recon-id-fix-engine.js |
| `runNewAccountArtifactCopyInline` | 4 | src/main-process/new-account/artifact-copy.js |
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
| `runVccParserPipeline` | 4 | src/main-process/vcc-op-calc-session.js |
| `runViaSideDb` | 4 | src/main-process/bank-bu-recon-run-data.js |
| `runWorkerDurableCanary` | 4 | src/main-process/background-execution/canary/durable-recovery.js |
| `safeCauseCode` | 4 | src/main-process/bank-bu-worker/parser-outcome.js |
| `sameBoundedJpmReceipt` | 4 | src/main-process/recon-id-fix-service/jpm-receipt-evidence.js |
| `sameExactOperationReceipt` | 4 | src/main-process/pre-fund-reconciliation/mpt-import/operation-receipt-repository.js |
| `sameRunResult` | 4 | src/main-process/acquiring-bill-currency-run-data.js |
| `saveAccountMappings` | 4 | src/backend/database/settings-repository.js |
| `savepointSequence` | 4 | src/backend/database/archive-repository.js |
| `saveTemplateFilenameFixedField` | 4 | src/backend/database/template-repository.js |
| `saveVccOpRunWithReceipt` | 4 | src/main-process/vcc-op-calc-session.js |
| `scanAndSealRouteDb` | 4 | src/main-process/toolbox-background/route-db-sealer.js |
| `scanBiff8WorkbookStream` | 4 | src/backend/toolbox-format/biff8-records.js |
| `scanFields` | 4 | src/backend/toolbox-xlsx-stream/split-scan-fields.js |
| `serial1904To1900` | 4 | src/backend/toolbox-format/number-date.js |
| `serialize` | 4 | src/backend/usage-stats.js |
| `serializePackagedRuntimeReport` | 4 | src/main-process/background-execution/canary/packaged-runtime-request.js |
| `serviceTransportCreatedGeneration` | 4 | src/main-process/background-execution/service-host.js |
| `SET_ENTRY_OVERHEAD_BYTES` | 4 | src/main-process/fund-recon-worker/state-footprint.js |
| `setAcquiringBillChunkSize` | 4 | src/backend/database/settings-repository.js |
| `setAcquiringBillIdleCleanupMinutes` | 4 | src/backend/database/settings-repository.js |
| `setAcquiringBillRawJsonRetentionDays` | 4 | src/backend/database/settings-repository.js |
| `setAcquiringBillWorkerCount` | 4 | src/backend/database/settings-repository.js |
| `setAutoUpdateEnabled` | 4 | src/backend/database/settings-repository.js |
| `setBackgroundConfig` | 4 | src/backend/database/settings-repository.js |
| `setEnumConfig` | 4 | src/backend/database/settings-repository.js |
| `setLastImportDirectory` | 4 | src/backend/database/settings-repository.js |
| `settlePositionPublishedMetadata` | 4 | src/main-process/read-only-exports/position/settlement.js |
| `showImportOpenDialog` | 4 | src/main-process/import-dialog-state.js |
| `sourceAmountToCents` | 4 | src/main-process/position-reconciliation/decimal.js |
| `sourceSnapshotForPath` | 4 | src/main-process/archive-center/operation-tracker.js |
| `spawn` | 4 | src/main-process/biz-op-recon-session.js |
| `stageInputFilesAsync` | 4 | src/main-process/position-reconciliation/input-staging.js |
| `startBankBuWorker` | 4 | src/main-process/bank-bu-worker/worker-entry.js |
| `startDuplicateWorker` | 4 | src/main-process/duplicate-inbound-match/worker-entry.js |
| `startFundReconWorker` | 4 | src/main-process/fund-recon-worker/worker-entry.js |
| `streamPositionXlsRows` | 4 | src/backend/position-reconciliation-import/xls-reader.js |
| `streamPositionXlsxRows` | 4 | src/backend/position-reconciliation-import/xlsx-reader.js |
| `SUPPORT_ACTION_POLICIES` | 4 | src/main-process/archive-center/task-policy-registry.js |
| `systemRecordResult` | 4 | src/backend/vcc-financial-op/system-op-importer.js |
| `T54_REFUND_RE` | 4 | src/constants/refund-backfill-fields.js |
| `tableInfo` | 4 | src/backend/vcc-financial-op/read-schema.js |
| `taskStagingIdentityFromProvisional` | 4 | src/main-process/vcc-financial-op-output/staging-identity.js |
| `toggleScenarioEnabled` | 4 | src/backend/database/scenarios-repository.js |
| `toMatchValue` | 4 | src/backend/toolbox-format/model.js |
| `TOOLBOX_GENERATION_POLICIES` | 4 | src/main-process/toolbox-background/policies.js |
| `toSafeParserFileResult` | 4 | src/main-process/pre-fund-reconciliation/mpt-import/managed-import.js |
| `transferScenarios` | 4 | src/backend/database/scenarios-repository.js |
| `transitionEventType` | 4 | src/main-process/background-execution/recovery-control-contract.js |
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
| `UUID_TOKEN_PATTERN` | 4 | src/main-process/vcc-financial-op-output/dispatch.js |
| `VALID_ORDER_STATUSES` | 4 | src/main-process/position-reconciliation/constants.js |
| `validateAcquiringGeneratedArtifact` | 4 | src/main-process/read-only-exports/acquiring/business-validator.js |
| `validateBankHeaders` | 4 | src/backend/bank-bu-recon-import/validator.js |
| `validateBizOpGeneratedArtifact` | 4 | src/main-process/read-only-exports/biz-op/business-validator.js |
| `validateDuplicateExportResult` | 4 | src/main-process/duplicate-inbound-match/policies.js |
| `validateDuplicateImportResult` | 4 | src/main-process/duplicate-inbound-match/policies.js |
| `validateDuplicateRunResult` | 4 | src/main-process/duplicate-inbound-match/policies.js |
| `validateDuplicateSpoolPair` | 4 | src/main-process/duplicate-inbound-match/spool-reader.js |
| `validateEffectiveResultEvidence` | 4 | src/backend/vcc-financial-op/archive-evidence.js |
| `validateFundReconExportResult` | 4 | src/main-process/fund-recon-worker/policies.js |
| `validateFundReconImportResult` | 4 | src/main-process/fund-recon-worker/policies.js |
| `validateFundReconRunResult` | 4 | src/main-process/fund-recon-worker/policies.js |
| `validateImportEvidence` | 4 | src/main-process/bank-bu-worker/identity.js |
| `validatePendingBizOpAdapterResult` | 4 | src/main-process/background-execution/pending-bizop-adapter-policies.js |
| `validatePendingGeneratedArtifact` | 4 | src/main-process/read-only-exports/pending/business-validator.js |
| `validatePendingGuanliHeaders` | 4 | src/backend/bank-bu-recon-import/validator.js |
| `validatePositionGeneratedArtifact` | 4 | src/main-process/read-only-exports/position/business-validator.js |
| `validatePreFundGeneratedArtifact` | 4 | src/main-process/read-only-exports/pre-fund/business-validator.js |
| `validateProtocolSequence` | 4 | src/main-process/background-execution/index.js |
| `validateStatementArtifactWorkbook` | 4 | src/main-process/statement-worker/artifact-descriptor.js |
| `validateVccFinancialOpGeneratedArtifact` | 4 | src/main-process/read-only-exports/vcc-financial-op/business-validator.js |
| `validateVccSubjectArtifact` | 4 | src/main-process/vcc-financial-op-output/artifact-evidence.js |
| `VCC_EXPORT_SINGLE_POLICY` | 4 | src/main-process/vcc-financial-op-output/policies.js |
| `VCC_EXPORT_SUBJECTS_POLICY` | 4 | src/main-process/vcc-financial-op-output/policies.js |
| `VCC_FINANCIAL_OP_READ_ONLY_POLICY` | 4 | src/main-process/read-only-exports/vcc-financial-op/policies.js |
| `VCC_SAVE_RUN_INSPECTION_EVIDENCE_VERSION` | 4 | src/main-process/vcc-op-calc/save-run-contract.js |
| `verifyPositionImportApplyGrant` | 4 | src/backend/position-reconciliation-import/apply-grant.js |
| `waitForBankBuSpoolsReady` | 4 | src/main-process/bank-bu-worker/import-operation.js |
| `waitForDuplicateSpoolPairReady` | 4 | src/main-process/duplicate-inbound-match/spool-reader.js |
| `WORKER_PATH` | 4 | src/main-process/background-execution/canary/durable-recovery.js |
| `writeAdmMatchFlags` | 4 | src/backend/database/linked-table-repository.js |
| `writeBankBuInputSpool` | 4 | src/main-process/bank-bu-worker/parser-worker-entry.js |
| `writeBankBuParserSuccess` | 4 | src/main-process/bank-bu-worker/parser-outcome.js |
| `writeChannelWorkbooks` | 4 | src/main-process/pre-fund-reconciliation/excel-writer.js |
| `writeDuplicateInboundWorkbook` | 4 | src/main-process/duplicate-inbound-match/excel-writer.js |
| `writeDuplicateInputSpool` | 4 | src/main-process/duplicate-inbound-match/parser-worker-entry.js |
| `writeDuplicateParserFailure` | 4 | src/main-process/duplicate-inbound-match/parser-outcome.js |
| `writeDuplicateParserSuccess` | 4 | src/main-process/duplicate-inbound-match/parser-outcome.js |
| `writeLinkedWorkbook` | 4 | src/main-process/position-reconciliation/excel-io.js |
| `writeMptErrorReport` | 4 | src/main-process/pre-fund-reconciliation/mpt-error-report-writer.js |
| `writeMptFileSpool` | 4 | src/main-process/pre-fund-reconciliation/mpt-import/parser-worker-entry.js |
| `writeOutputsFromSealedRouteDb` | 4 | src/main-process/toolbox-background/output-writer-core.js |
| `writePositionAnomalyReport` | 4 | src/backend/position-reconciliation-import/anomaly-report.js |
| `writeRawWorkbook` | 4 | src/main-process/position-reconciliation/excel-io.js |
| `writeRunWorkbooks` | 4 | src/main-process/vcc-financial-op-output/writer-core.js |
| `writeStreamedXlsx` | 4 | src/backend/pending-import/streaming-xlsx-writer.js |
| `AppDatabase` | 3 | src/backend/database.js |
| `applyScenarioBundleImport` | 3 | src/main-process/scenarios-bundle-import.js |
| `assembleMonthlyBalance` | 3 | src/main-process/monthly-balance.js |
| `assertHeadersIdentical` | 3 | src/main-process/toolbox.js |
| `assertPositionRecoveryInputsUnchanged` | 3 | src/main-process/position-reconciliation/operation-lifecycle.js |
| `assertRunExportFresh` | 3 | src/main-process/acquiring-bill-currency-run-data.js |
| `authorizePositionImportApply` | 3 | src/main-process/position-reconciliation/operation-lifecycle.js |
| `BIZ_OP_BU_FIELD_DB_COLUMN` | 3 | src/backend/biz-op-recon-db/columns.js |
| `bizOpReconRunData` | 3 | src/main-process/read-only-exports/biz-op/writer.js |
| `bizOpRunTerminalRoute` | 3 | src/main-process/biz-op-archive-lineage.js |
| `buildFrozenRangeExportDb` | 3 | src/main-process/biz-op-recon-run-data.js |
| `buildMergeFileName` | 3 | src/main-process/toolbox.js |
| `buildSplitFileName` | 3 | src/main-process/toolbox.js |
| `buildVccImportArchiveHandoffFiles` | 3 | src/main-process/vcc-financial-op-archive-lineage.js |
| `captureArchiveSourceSnapshots` | 3 | src/main-process/archive-center/source-snapshot.js |
| `clearRunsByMonth` | 3 | src/backend/acquiring-bill-currency-db/run-repository.js |
| `clearStaleSuccessfulRawJson` | 3 | src/backend/acquiring-bill-currency-db/raw-json-retention.js |
| `compareMatchedContent` | 3 | src/backend/pending-reconcile/removal-match.js |
| `completeRunOutputPublication` | 3 | src/backend/acquiring-bill-currency-db/run-repository.js |
| `composePositionTerminalSettlement` | 3 | src/main-process/read-only-exports/position/settlement.js |
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
| `createDuplicateStartupOutcomeInspector` | 3 | src/main-process/duplicate-inbound-match/startup-recovery.js |
| `createDuplicateStartupRecoveryProvider` | 3 | src/main-process/duplicate-inbound-match/startup-recovery.js |
| `createIpcTaskContext` | 3 | src/main-process/archive-center/ipc-task-contract.js |
| `createLegacyRunMirror` | 3 | src/backend/database/pre-fund-reconciliation-run-repository.js |
| `createManualBalanceRecoveryPlanTransitions` | 3 | src/main-process/manual-balance-seed-settlement.js |
| `createManualBalanceSettlementRecoveryProvider` | 3 | src/main-process/manual-balance-seed-settlement.js |
| `createPendingDatasetSeed` | 3 | src/backend/pending-db/dataset-identity.js |
| `createPositionReconciliationService` | 3 | src/main-process/position-reconciliation/service.js |
| `createPositionRunTaskContract` | 3 | src/main-process/position-reconciliation/interactive-task-preflight.js |
| `createPositionSourceImportTaskContract` | 3 | src/main-process/position-reconciliation/interactive-task-preflight.js |
| `createPreFundMptHoldGate` | 3 | src/main-process/pre-fund-reconciliation/mpt-import/hold-gate.js |
| `createPreFundMptOutcomeInspector` | 3 | src/main-process/pre-fund-reconciliation/mpt-import/outcome-inspector.js |
| `createPreFundMptReceiptAuthority` | 3 | src/main-process/pre-fund-reconciliation/mpt-import/receipt-authority.js |
| `createPreFundReconciliationService` | 3 | src/main-process/pre-fund-reconciliation/service.js |
| `createReconFixJpmHoldGate` | 3 | src/main-process/recon-id-fix-service/jpm-hold-gate.js |
| `createReconFixJpmOutcomeInspector` | 3 | src/main-process/recon-id-fix-service/jpm-outcome-inspector.js |
| `createReconFixJpmReceiptAuthority` | 3 | src/main-process/recon-id-fix-service/jpm-receipt-authority.js |
| `createReconFixJpmRecoveryTaskStateReader` | 3 | src/main-process/recon-id-fix-service/jpm-recovery-task-state.js |
| `createReconFixJpmWorkerDurableCoordinator` | 3 | src/main-process/recon-id-fix-service/jpm-worker-durable-coordinator.js |
| `createRowInserter` | 3 | src/backend/pending-db/month-repository.js |
| `createTaskLifecycle` | 3 | src/main-process/archive-center/task-lifecycle.js |
| `createWindowInstrumentation` | 3 | src/main-process/startup-window.js |
| `createWorkerDurableCoordinator` | 3 | src/main-process/pre-fund-reconciliation/mpt-import/worker-durable-coordinator.js |
| `createWorkerDurableCoordinatorRouter` | 3 | src/main-process/background-execution/worker-durable-coordinator-router.js |
| `deleteMonth` | 3 | src/backend/pending-db/month-repository.js |
| `deleteMonthBySide` | 3 | src/backend/acquiring-bill-currency-db/import-repository.js |
| `detectBundleType` | 3 | src/backend/scenarios-bundle-io.js |
| `detectTableType` | 3 | src/main-process/table-type-detector.js |
| `encodeAdjustmentLineageName` | 3 | src/backend/vcc-financial-op/adjustment-lineage.js |
| `executeAfterPositionAdmission` | 3 | src/main-process/position-reconciliation/interactive-task-preflight.js |
| `executeIpcTaskInvocation` | 3 | src/main-process/archive-center/ipc-task-contract.js |
| `executeManagedPreFundMptImport` | 3 | src/main-process/pre-fund-reconciliation/mpt-import/managed-import.js |
| `executePendingImportSubmission` | 3 | src/main-process/pending-import-preflight.js |
| `exportSingleRun` | 3 | src/backend/pending-export/writer.js |
| `filterRowsByFieldValues` | 3 | src/main-process/toolbox.js |
| `finalizePendingTerminalIntent` | 3 | src/main-process/pending-archive-lineage.js |
| `finalizePreFundTerminalIntent` | 3 | src/main-process/pre-fund-archive-lineage.js |
| `findByChannelAndName` | 3 | src/backend/database/scenarios-repository.js |
| `freezePendingRunEvidence` | 3 | src/main-process/read-only-exports/pending/query.js |
| `generateValidateAndPublish` | 3 | src/main-process/toolbox-background/generation-validator.js |
| `generateValidateAndPublishBizOpExport` | 3 | src/main-process/read-only-exports/biz-op/managed-export.js |
| `generateValidateAndPublishMultiOutput` | 3 | src/main-process/toolbox-background/multi-output-validator.js |
| `generateValidateAndPublishPendingExport` | 3 | src/main-process/read-only-exports/pending/managed-export.js |
| `generateValidateAndPublishPreFundExport` | 3 | src/main-process/read-only-exports/pre-fund/managed-export.js |
| `getBillDateCounts` | 3 | src/backend/acquiring-bill-currency-db/run-repository.js |
| `getEffectiveRunResultForSubject` | 3 | src/backend/vcc-financial-op/result-adjustments.js |
| `getLatestRunByMonth` | 3 | src/backend/vcc-op-calc-db/run-repository.js |
| `getLatestRunForMonthPair` | 3 | src/backend/pending-db/diff-repository.js |
| `getMappingMap` | 3 | src/backend/database/fund-transfer-account-mapping-repository.js |
| `getOrCreateStatementImportSession` | 3 | src/main-process/statement-session.js |
| `getPendingRows` | 3 | src/backend/bank-bu-recon-db/month-repository.js |
| `getRunFiles` | 3 | src/backend/vcc-op-calc-db/run-repository.js |
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
| `insertManagedRun` | 3 | src/backend/bank-bu-recon-db/run-repository.js |
| `insertRecoveryAudit` | 3 | src/backend/database/duplicate-inbound-match-run-repository.js |
| `insertRunFiles` | 3 | src/backend/vcc-op-calc-db/run-repository.js |
| `interruptVccOpSaveRunTask` | 3 | src/main-process/vcc-op-calc/save-run-lifecycle.js |
| `isStorageRootOnOneDrive` | 3 | src/main-process/onedrive-detector.js |
| `iterateDiffRowsByDateRange` | 3 | src/backend/acquiring-bill-currency-db/run-repository.js |
| `LINKED_IMPORT_SIGNATURES` | 3 | src/constants/table-signatures.js |
| `listAllByChannelId` | 3 | src/backend/database/scenarios-repository.js |
| `listBuiltinFixedForChannel` | 3 | src/backend/database/scenarios-repository.js |
| `listDistinctMonths` | 3 | src/backend/vcc-op-calc-db/run-repository.js |
| `listImportRecordsByBatch` | 3 | src/backend/vcc-financial-op-db/repository.js |
| `listMatchedDiffRowIds` | 3 | src/backend/pending-reconcile/removal-match.js |
| `listMatchedRemovedRowIds` | 3 | src/backend/pending-reconcile/removal-match.js |
| `listPartialRuns` | 3 | src/backend/acquiring-bill-currency-db/run-repository.js |
| `listRunReceipts` | 3 | src/backend/vcc-op-calc-db/operation-receipt-repository.js |
| `listRunsForMonthPair` | 3 | src/backend/pending-db/diff-repository.js |
| `loadFundTypeEnum` | 3 | src/constants/fund-type-enum.js |
| `loadGatewayReconHeaders` | 3 | src/constants/gateway-recon-headers-loader.js |
| `loadNewAccountSharedStrings` | 3 | src/main-process/new-account/strict-worksheet-readback.js |
| `manualBalanceRecoveryPolicy` | 3 | src/main-process/manual-balance-seed-settlement.js |
| `markCleanupPending` | 3 | src/backend/acquiring-bill-currency-db/run-repository.js |
| `matchMerchantIds` | 3 | src/main-process/big-account-recognition.js |
| `mergeAoaRows` | 3 | src/main-process/toolbox.js |
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
| `preFundMptRecoveryPlanTransitions` | 3 | src/main-process/pre-fund-reconciliation/mpt-import/recovery-plan.js |
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
| `readBigAccountMode` | 3 | src/backend/big-account-mode-store.js |
| `readBigAccountOrder` | 3 | src/backend/big-account-order-store.js |
| `rebuildAdmDerivation` | 3 | src/main-process/linked-derive-rebuild.js |
| `rebuildBankDepositBocDerivation` | 3 | src/main-process/linked-derive-rebuild.js |
| `rebuildFundTransferReconDerivation` | 3 | src/main-process/linked-derive-rebuild.js |
| `rebuildFxBocDerivation` | 3 | src/main-process/linked-derive-rebuild.js |
| `reconcileVccImportArchiveLineageAtStartup` | 3 | src/main-process/vcc-financial-op-archive-lineage.js |
| `reconFixJpmRecoveryPlanTransitions` | 3 | src/main-process/recon-id-fix-service/jpm-recovery-plan.js |
| `recordFromBankStatementRows` | 3 | src/backend/database/channel-enum-repository.js |
| `recoverPendingRunReceipts` | 3 | src/main-process/pending-archive-lineage.js |
| `recoverPreFundRunReceipts` | 3 | src/main-process/pre-fund-archive-lineage.js |
| `recoverVccImportArchiveTasks` | 3 | src/main-process/vcc-financial-op-archive-lineage.js |
| `REFUND_BACKFILL_FIELD_MAP` | 3 | src/constants/refund-backfill-fields.js |
| `removeStatementSessionEntriesByFilePath` | 3 | src/main-process/statement-session.js |
| `reportStartupFailure` | 3 | src/backend/startup-failure.js |
| `resolveBalanceAdjustment` | 3 | src/main-process/statement-generation-business.js |
| `resolveManualBalanceSeedFilePlanInputPaths` | 3 | src/main-process/manual-balance-seed-preflight.js |
| `resolveManualBalanceTargetAlias` | 3 | src/main-process/manual-balance-seed-settlement.js |
| `resolveRecognizedBigAccount` | 3 | src/main-process/big-account-recognition.js |
| `RESULT_SHEET_NAME` | 3 | src/main-process/vcc-financial-op-writer.js |
| `resumeRunCheck` | 3 | src/main-process/acquiring-bill-currency-run-data.js |
| `runCheckViaSideDb` | 3 | src/main-process/acquiring-bill-currency-run-data.js |
| `runCheckWorkerPool` | 3 | src/main-process/background-execution/adapters/acquiring-adapter.js |
| `runLegacyReconciliation` | 3 | src/backend/pending-reconcile/engine.js |
| `runOwnAccountsMigration` | 3 | src/backend/database/own-accounts-migration.js |
| `runPipeline` | 3 | src/backend/big-table-import/pipeline.js |
| `runPositionOperationLifecycle` | 3 | src/main-process/position-reconciliation/operation-lifecycle.js |
| `runWithPreparedResourceCleanup` | 3 | src/main-process/position-reconciliation/interactive-task-preflight.js |
| `sameExactReceipt` | 3 | src/backend/database/recon-fix-operation-receipt-repository.js |
| `scanFxGroups` | 3 | src/main-process/boc-fx-link-builder.js |
| `scanNewAccountWorksheetRows` | 3 | src/main-process/new-account/strict-worksheet-readback.js |
| `selectSuccessfulPathsByResultIndex` | 3 | src/main-process/archive-center/operation-tracker.js |
| `serializeScenarioBundle` | 3 | src/backend/scenarios-bundle-io.js |
| `setApplicableChannelIds` | 3 | src/backend/database/scenarios-repository.js |
| `settlePositionArchiveResult` | 3 | src/main-process/position-reconciliation/operation-lifecycle.js |
| `settlePositionRecoveredTask` | 3 | src/main-process/position-reconciliation/operation-lifecycle.js |
| `shouldAcceptInitialRendererMetrics` | 3 | src/main-process/startup-window.js |
| `shouldUseLargeChannel` | 3 | src/main-process/toolbox-large-split-router.js |
| `showComingSoon` | 3 | src/renderer.js |
| `showReadyWindow` | 3 | src/main-process/startup-window.js |
| `STAGING_ROW_INSERT_SQL` | 3 | src/backend/vcc-financial-op-db/repository.js |
| `streamLinkedRowsToInsert` | 3 | src/main-process/linked-table-stream-source.js |
| `toBalanceRows` | 3 | src/main-process/monthly-balance.js |
| `updateRunStats` | 3 | src/backend/pending-db/diff-repository.js |
| `upsertMonthMeta` | 3 | src/backend/pending-db/month-repository.js |
| `vccFinancialOpErrorResult` | 3 | src/main-process/vcc-financial-op-ipc.js |
| `waitForWindowReady` | 3 | src/main-process/startup-window.js |
| `writeBankStatementOutput` | 3 | src/main-process/exceljs-writer.js |
| `writeBigAccountMode` | 3 | src/backend/big-account-mode-store.js |
| `writeBigAccountOrder` | 3 | src/backend/big-account-order-store.js |
| `writeManualBalanceSeedPlan` | 3 | src/main-process/manual-balance-seed-preflight.js |
| `writePendingManagedErrorSource` | 3 | src/main-process/read-only-exports/pending/managed-export.js |
| `writeRunOutputs` | 3 | src/main-process/acquiring-bill-currency-writer.js |
| `xmlAttrUnescape` | 3 | src/backend/big-table-import/zip-reader.js |
| `CELL_OPEN_RE` | 2 | src/backend/acquiring-bill-currency-import/reader-handrolled.js |
| `CELL_R_RE` | 2 | src/backend/acquiring-bill-currency-import/reader-handrolled.js |
| `NEW_ACCOUNT_EXPORT_NAME` | 2 | src/main-process/new-account/generation-core.js |
| `readMeaningfulRowsHead` | 2 | src/backend/file-service/readers.js |
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
| `duplicateInboundMatchRunRepository` | 10 |
| `preFundReconciliationRunRepository` | 10 |
| `formatBytesForLog` | 6 |
| `channelEnumRepository` | 5 |
| `fundTransferAccountMappingRepository` | 4 |
| `ONE_TIME_VACUUM_FLAG_KEY` | 3 |

### `src/backend/database/archive-repository.js`

| 名字 | 总次数 |
|---|---:|
| `withWriteTransaction` | 33 |
| `BATCH_TASK_STATUSES` | 18 |
| `normalizeModuleId` | 15 |
| `normalizeMetadata` | 14 |
| `BATCH_SELECT` | 13 |
| `mapBatch` | 13 |
| `TASK_RUN_STATUSES` | 13 |
| `ARTIFACT_SELECT` | 11 |
| `BATCH_ARCHIVE_STATUSES` | 11 |
| `mapArtifact` | 11 |
| `mapBlob` | 10 |
| `ARTIFACT_STATUSES` | 9 |
| `VISIBLE_BATCH_PREDICATE_SQL` | 8 |
| `normalizeFlowAnchorIdentity` | 7 |
| `normalizeFingerprint` | 6 |
| `addColumnsIfMissing` | 5 |
| `normalizeModuleCode` | 5 |
| `SPLIT_DIRECTORY_REPAIR_TYPE` | 5 |
| `ARCHIVE_INSTANCE_ID_SETTING_KEY` | 4 |
| `dateToIso` | 4 |
| `formatGlobalBatchNumber` | 4 |
| `mapArtifactHold` | 4 |
| `mapCleanupJob` | 4 |
| `mapFingerprint` | 4 |
| `mapFlowBindIntent` | 4 |
| `mapTaskFlowBindIntent` | 4 |
| `normalizeArtifactHoldIdentity` | 4 |
| `normalizeRetentionUntil` | 4 |
| `normalizeSha256` | 4 |
| `normalizeSize` | 4 |
| `ArchiveRepository` | 3 |
| `BATCH_FORMAT_VERSIONS` | 3 |
| `formatBatchNumber` | 3 |
| `mapTaskRun` | 3 |
| `normalizeArtifactPayload` | 3 |
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

### `src/backend/database/duplicate-inbound-match-run-repository.js`

| 名字 | 总次数 |
|---|---:|
| `getRunMirrorByOperation` | 3 |
| `mapRecoveryAudit` | 3 |
| `normalizeManagedIdentity` | 3 |

### `src/backend/database/linked-table-repository.js`

| 名字 | 总次数 |
|---|---:|
| `getDef` | 19 |
| `BOC_KEY_MATURITY_ISO` | 9 |
| `BOC_KEY_ORIG_GROUP` | 9 |
| `BOC_KEY_TXN_NO` | 8 |
| `normalizeDateForRange` | 8 |
| `normalizeSourceFileName` | 8 |
| `recomputeLinkedMeta` | 7 |
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

### `src/backend/database/linked-table-writeback-reader.js`

| 名字 | 总次数 |
|---|---:|
| `readerError` | 7 |
| `ADM_IMAGE_CONTRACT_VERSION` | 5 |
| `assertStrictAscendingIds` | 4 |
| `MAX_REDACTED_ID_SAMPLES` | 4 |
| `ADM_WRITEBACK_SELECT_SQL` | 3 |
| `AdmWritebackReaderError` | 3 |
| `redactedIdToken` | 3 |

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

### `src/backend/database/recon-fix-operation-receipt-repository.js`

| 名字 | 总次数 |
|---|---:|
| `ACTION_KEY` | 8 |
| `RECEIPT_INPUT_KEYS` | 5 |
| `RECEIPT_KEYS` | 3 |
| `ReconFixOperationReceiptError` | 3 |

### `src/backend/database/scenarios-repository.js`

| 名字 | 总次数 |
|---|---:|
| `makeScenarioIdentityError` | 8 |
| `rowToDetail` | 8 |
| `hasChannelIdColumn` | 6 |
| `hasChannelIdColumnCache` | 5 |
| `isScenarioNameUniqueError` | 5 |
| `assertScenarioNotCanonicalOwner` | 4 |
| `normalizeC2Config` | 4 |
| `RECON_ID_FIX_DISPLAY_INDEX_CATEGORIES` | 4 |
| `validateEnabled` | 4 |
| `calculateNextScenarioId` | 3 |
| `prepareScenarioConfig` | 3 |
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

### `src/backend/duplicate-inbound-match-result-digest.js`

| 名字 | 总次数 |
|---|---:|
| `addFrame` | 7 |
| `requireArray` | 5 |
| `requireObject` | 5 |
| `canonicalJson` | 4 |
| `DUPLICATE_RESULT_DIGEST_VERSION` | 4 |

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

### `src/backend/pending-export/error-report-writer.js`

| 名字 | 总次数 |
|---|---:|
| `normalizeErrorReportSnapshot` | 3 |

### `src/backend/pending-export/writer.js`

| 名字 | 总次数 |
|---|---:|
| `appendSheetWithHeaderFont` | 9 |
| `FUND_TYPE_COLUMN` | 7 |
| `buildExportRowsForDiff` | 6 |
| `buildSingleExportRow` | 6 |
| `buildHeaders` | 5 |
| `buildPendingExportReadSnapshot` | 4 |
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
| `withMutationLock` | 7 |
| `BATCH_DATE_RANGE_WHERE` | 5 |
| `MUTATION_TAILS` | 5 |
| `mapBatchRow` | 4 |
| `normalizeImportOptions` | 4 |
| `storeError` | 4 |
| `DEFAULT_WRITE_BATCH_SIZE` | 3 |
| `ensureRepairSchema` | 3 |
| `mapGatewayRow` | 3 |
| `MptImportTransaction` | 3 |
| `SELECT_BATCH_BY_IDENTITY` | 3 |
| `SELECT_BATCH_DATE_RANGE_SUMMARY` | 3 |
| `SELECT_BATCH_DATE_RANGE_SUMMARY_BY_SOURCE` | 3 |

### `src/backend/run-data-store.js`

| 名字 | 总次数 |
|---|---:|
| `assertModule` | 5 |
| `hasTableColumn` | 4 |
| `KNOWN_MODULES` | 4 |
| `RUN_DATA_DIRNAME` | 4 |
| `SIDE_DB_DDL_BANK_BU` | 4 |
| `SIDE_DB_DDL_DUPLICATE_INBOUND_MATCH` | 4 |
| `SIDE_DB_DDL_PRE_FUND_GATEWAY` | 4 |
| `SIDE_DB_PRAGMA_STATEMENTS` | 4 |
| `assertMonthKey` | 3 |
| `ensureBankBuManagedSchema` | 3 |
| `ensureDuplicateInboundMatchResultDigestSupport` | 3 |
| `ensurePreFundGatewayArchiveSupport` | 3 |
| `ensurePreFundRunArchiveSupport` | 3 |
| `monthKeyFromFileName` | 3 |
| `runDataRoot` | 3 |
| `SIDE_DB_DDL_ACQUIRING` | 3 |

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
| `STATS_TMP_FILENAME` | 3 |

### `src/backend/vcc-financial-op-db/migrations.js`

| 名字 | 总次数 |
|---|---:|
| `currencyMigrationError` | 10 |
| `LEGACY_VCC_CURRENCY` | 10 |
| `CURRENT_VCC_CURRENCY` | 6 |
| `LEGACY_PENDING_RAW_CONTRACT_HASH_VERSION` | 6 |
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
| `resultStateError` | 45 |
| `canonicalFinalAmount` | 9 |
| `normalizeSubjectFilter` | 6 |
| `resultRevisionChanged` | 6 |
| `subjectCurrencyKey` | 6 |
| `accumulateAmounts` | 5 |
| `requireEffectiveRun` | 4 |
| `addAmount` | 3 |
| `emptyCurrencyAmounts` | 3 |
| `finalizeSummaryAmounts` | 3 |
| `getEffectiveRunResultInternal` | 3 |
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
| `isMergedPair` | 11 |
| `contractMismatch` | 6 |
| `captureCellStyle` | 5 |
| `contractCache` | 5 |
| `isNonEmptyObject` | 5 |
| `RESULT_TEMPLATE_PRINT_AREA` | 5 |
| `ResultTemplateContractError` | 5 |
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
| `applyCanonicalCurrencyHash` | 4 |
| `monthEndIso` | 4 |
| `negateDecimal` | 4 |
| `rawText` | 4 |
| `formatDate` | 3 |
| `signByDirection` | 3 |
| `TEXT_CELL_TYPES` | 3 |

### `src/backend/vcc-financial-op/system-op-importer.js`

| 名字 | 总次数 |
|---|---:|
| `rowField` | 10 |
| `systemRowError` | 10 |
| `insertAttempt` | 8 |
| `lexicalStructureError` | 8 |
| `displayAmountToken` | 5 |
| `validationUnitCount` | 5 |
| `workbookFileText` | 5 |
| `addSystemValidationAnomaly` | 4 |
| `rawNumericToken` | 4 |
| `snapshotCurrencyEvidence` | 4 |
| `addSystemConflictAnomaly` | 3 |
| `assertUniqueSystemBusinessSheet` | 3 |
| `findSystemHeader` | 3 |
| `meaningfulPreview` | 3 |
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
| `readResumeTarget` | 3 |

### `src/main-process/acquiring-bill-currency-session.js`

| 名字 | 总次数 |
|---|---:|
| `safeBegin` | 7 |
| `importReader` | 6 |
| `USE_BIG_TABLE_IMPORT_ENGINE` | 6 |
| `adaptiveChunkSizeForMultiWorker` | 4 |
| `cleanupAfterRunBackground` | 3 |
| `emitReadingEvents` | 3 |
| `importFilesInTransaction` | 3 |
| `importFilesWithOverwrite` | 3 |
| `MULTIWORKER_MIN_CHUNK_SIZE` | 3 |
| `MULTIWORKER_MIN_TOTAL_ROWS` | 3 |
| `normalizeEngineResult` | 3 |
| `resolveDbPath` | 3 |

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
| `ArchiveOperationError` | 37 |
| `safeFailure` | 20 |
| `BLOB_ROOT_PARTS` | 9 |
| `MAX_MATERIALIZATION_BATCH_SIZE` | 9 |
| `READONLY_DIR_NAME` | 7 |
| `STAGING_DIR_NAME` | 7 |
| `ROOT_MUTATION_TAILS` | 5 |
| `blobRelativePath` | 4 |
| `safeCode` | 4 |
| `ArchiveService` | 3 |
| `DEFAULT_STARTUP_MATERIALIZATION_BATCH_SIZE` | 3 |
| `isFileIntegrityFailure` | 3 |
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
| `STARTUP_DEFERRED_MAINTENANCE` | 3 |

### `src/main-process/archive-center/file-plan.js`

| 名字 | 总次数 |
|---|---:|
| `planError` | 24 |
| `normalizedFilePlans` | 4 |
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
| `statTimeMs` | 3 |

### `src/main-process/archive-center/storage-materializer.js`

| 名字 | 总次数 |
|---|---:|
| `StorageMaterializationError` | 8 |
| `assertNoSymlinkAncestors` | 6 |

### `src/main-process/archive-center/storage-root-manager.js`

| 名字 | 总次数 |
|---|---:|
| `ArchiveStorageRootError` | 62 |
| `toRelativePath` | 18 |
| `comparablePath` | 17 |
| `ROOT_MARKER_FILE` | 11 |
| `normalizeRoot` | 10 |
| `pathExists` | 8 |
| `validateMarker` | 8 |
| `INTERNAL_TRANSIENT_DIRS` | 6 |
| `MIGRATION_JOURNAL_SCHEMA_VERSION` | 5 |
| `parentRelativePaths` | 5 |
| `exactMarker` | 4 |
| `pathsOverlap` | 4 |
| `ROOT_MARKER_SCHEMA_VERSION` | 4 |
| `ROOT_MARKER_TYPE` | 4 |
| `ArchiveStorageRootManager` | 3 |
| `MIGRATION_PHASES` | 3 |
| `validateJournal` | 3 |

### `src/main-process/archive-center/target-parent-identity.js`

| 名字 | 总次数 |
|---|---:|
| `bigintIdentity` | 4 |
| `TargetParentIdentityError` | 4 |
| `identitiesEqual` | 3 |
| `positiveDecimal` | 3 |
| `targetParentIdentitiesMatch` | 3 |

### `src/main-process/archive-center/task-file-plan-registry.js`

| 名字 | 总次数 |
|---|---:|
| `eager` | 62 |
| `preparedPickerPlan` | 8 |
| `requiredPreparedFilePlan` | 6 |
| `preparedExportPlan` | 5 |
| `preparedPayloadPlan` | 5 |
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
| `standardResultClassifier` | 4 |
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
| `statementResultClassifier` | 3 |
| `TaskPolicyRegistry` | 3 |
| `vccDeleteFlowPlan` | 3 |
| `vccFinancialOpResultClassifier` | 3 |
| `vccImportResultFlowIdentities` | 3 |
| `vccInvocationPayload` | 3 |
| `vccOpSaveRunResultClassifier` | 3 |
| `vccRunFlowIdentity` | 3 |

### `src/main-process/background-execution/acquiring-adapter-policies.js`

| 名字 | 总次数 |
|---|---:|
| `ROOT_POOL_RESOURCES` | 4 |
| `acquiringAdapterPolicy` | 3 |

### `src/main-process/background-execution/action-manifest.js`

| 名字 | 总次数 |
|---|---:|
| `ActionManifestError` | 9 |
| `compareStringArrays` | 3 |
| `PLATFORM_CANARY_ACTION_KEYS` | 3 |

### `src/main-process/background-execution/action-task-binding-registry.js`

| 名字 | 总次数 |
|---|---:|
| `ACTION_TASK_BINDINGS` | 8 |
| `failCaught` | 6 |
| `ownDataSnapshot` | 5 |
| `validateString` | 4 |
| `bindingDigest` | 3 |
| `validateBindingAuthority` | 3 |

### `src/main-process/background-execution/adapters/acquiring-adapter.js`

| 名字 | 总次数 |
|---|---:|
| `MAX_RUN_CHILDREN` | 5 |
| `normalizeChunkSize` | 5 |
| `MAX_IMPORT_CHILDREN` | 4 |
| `validateMonthKey` | 4 |
| `assertNoAuthorityOverrides` | 3 |
| `assertOutputIntent` | 3 |
| `createAcquiringImportMatureBinding` | 3 |
| `createAcquiringRunMatureBindings` | 3 |
| `defaultCountBillRows` | 3 |
| `normalizeWorkerCount` | 3 |
| `requireUserDataDir` | 3 |
| `validateImportInput` | 3 |
| `validateRunInput` | 3 |

### `src/main-process/background-execution/adapters/existing-dispatch-adapter.js`

| 名字 | 总次数 |
|---|---:|
| `cancelWasAcknowledged` | 3 |
| `normalizeCancelResult` | 3 |
| `normalizeDispatchResult` | 3 |
| `resolveDispatch` | 3 |

### `src/main-process/background-execution/adapters/inline-async-adapter.js`

| 名字 | 总次数 |
|---|---:|
| `resolveInlineEntry` | 3 |

### `src/main-process/background-execution/adapters/position-import-adapter.js`

| 名字 | 总次数 |
|---|---:|
| `POSITION_IMPORT_ADAPTER_INTENTS` | 13 |
| `optionalCountEvidence` | 6 |
| `resolveProvider` | 5 |
| `freezeMatchedBatchContext` | 4 |
| `requirePreflightEvidence` | 4 |
| `assertCountEvidenceMatches` | 3 |
| `normalizeRequest` | 3 |
| `projectProgress` | 3 |
| `projectResult` | 3 |
| `requirePath` | 3 |
| `validateFiles` | 3 |

### `src/main-process/background-execution/adapters/utility-process-adapter.js`

| 名字 | 总次数 |
|---|---:|
| `defaultUtilityFork` | 3 |
| `killFailedError` | 3 |
| `normalizeUtilityEntry` | 3 |
| `utilityProcessError` | 3 |

### `src/main-process/background-execution/adapters/worker-thread-adapter.js`

| 名字 | 总次数 |
|---|---:|
| `normalizeWorkerEntry` | 3 |

### `src/main-process/background-execution/admission-queue.js`

| 名字 | 总次数 |
|---|---:|
| `AdmissionQueueError` | 11 |
| `validateDuration` | 3 |

### `src/main-process/background-execution/canary/durable-recovery.js`

| 名字 | 总次数 |
|---|---:|
| `CANARY_SETTLEMENT_KEY` | 6 |
| `CANARY_ACTION_KEY` | 3 |
| `CANARY_INSPECTOR_KEY` | 3 |

### `src/main-process/background-execution/canary/packaged-runtime-request.js`

| 名字 | 总次数 |
|---|---:|
| `requestError` | 10 |
| `PACKAGED_CANARY_ENV` | 4 |
| `PACKAGED_CANARY_REPORT_PATH_ENV` | 4 |
| `MAX_REPORT_BYTES` | 3 |
| `normalizePackagedRuntimeReport` | 3 |
| `RUNNER_TEMP_ENV` | 3 |

### `src/main-process/background-execution/canary/packaged-runtime-runner.js`

| 名字 | 总次数 |
|---|---:|
| `canaryError` | 12 |
| `buildReport` | 4 |
| `safeErrorCode` | 4 |
| `writePackagedRuntimeReport` | 4 |
| `assertPackagedLayout` | 3 |
| `CANARY_SCHEMA_PATH` | 3 |
| `DURABLE_WORKER_PATH` | 3 |
| `executePackagedRuntimeCanary` | 3 |
| `openPrivateDatabase` | 3 |
| `pathUsesAppAsar` | 3 |

### `src/main-process/background-execution/canary/pure-compute.js`

| 名字 | 总次数 |
|---|---:|
| `CANARY_RESULT_KEYS` | 4 |
| `normalizeInput` | 3 |

### `src/main-process/background-execution/canonical-json-v1.js`

| 名字 | 总次数 |
|---|---:|
| `assertCanonicalValue` | 5 |
| `CanonicalJsonError` | 4 |
| `serializeCanonical` | 4 |
| `pointer` | 3 |

### `src/main-process/background-execution/capability-inventory.js`

| 名字 | 总次数 |
|---|---:|
| `CapabilityInventoryError` | 10 |
| `CAPABILITY_INVENTORY_VERSION` | 3 |
| `createCapabilityInventory` | 3 |

### `src/main-process/background-execution/coverage-check.js`

| 名字 | 总次数 |
|---|---:|
| `COVERAGE_SURFACE_KEYS` | 7 |
| `assertExactSet` | 6 |
| `expectedPairIdentities` | 4 |
| `pairIdentity` | 4 |
| `ActionCoverageError` | 3 |
| `sortedUnique` | 3 |

### `src/main-process/background-execution/critical/recovery-control-read-repository.js`

| 名字 | 总次数 |
|---|---:|
| `criticalIntentFromRow` | 5 |
| `INTENT_SELECT` | 5 |
| `parsePersistedObject` | 5 |
| `HOLD_SELECT` | 4 |
| `recoveryHoldFromRow` | 4 |

### `src/main-process/background-execution/critical/recovery-control-repository.js`

| 名字 | 总次数 |
|---|---:|
| `assertOne` | 13 |
| `immutableResult` | 5 |
| `mergeMetadata` | 4 |
| `commitOwner` | 3 |
| `insertEvent` | 3 |
| `intentRow` | 3 |
| `verifyOwner` | 3 |

### `src/main-process/background-execution/critical/recovery-request-owner-repository.js`

| 名字 | 总次数 |
|---|---:|
| `runImmediate` | 6 |
| `insertOwner` | 4 |
| `preparedTransitionRequest` | 4 |
| `verifyExistingOwner` | 4 |
| `assertPreparedMatchesDraft` | 3 |
| `exactTransitionDraft` | 3 |
| `normalizeInspectionUnavailableSource` | 3 |
| `preparedExactRequest` | 3 |
| `preparedInspectionUnavailableState` | 3 |

### `src/main-process/background-execution/durable-file.js`

| 名字 | 总次数 |
|---|---:|
| `DIRECTORY_FSYNC_UNSUPPORTED_CODES` | 3 |

### `src/main-process/background-execution/error-codec.js`

| 名字 | 总次数 |
|---|---:|
| `REDACTED_TEXT` | 12 |
| `errorData` | 5 |
| `privacyViolation` | 5 |
| `SAFE_ERROR_KEYS` | 5 |
| `sanitizeText` | 5 |
| `truncateUtf8` | 5 |
| `DEFAULT_SAFE_ERROR_MAX_BYTES` | 4 |
| `DEFAULT_SAFE_ERROR_MAX_ITEMS` | 4 |
| `safeErrorDetailLines` | 3 |

### `src/main-process/background-execution/execution-policy-registry.js`

| 名字 | 总次数 |
|---|---:|
| `PolicyRegistryError` | 24 |
| `dataMethod` | 23 |
| `policyJsonSafetyError` | 4 |
| `registryLookup` | 4 |
| `STATIC_REFERENCE_PATHS` | 4 |
| `collectionHas` | 3 |
| `policySchema` | 3 |
| `policySchemaValidator` | 3 |
| `semanticPolicyErrors` | 3 |
| `staticRegistryInstances` | 3 |
| `valueAtPath` | 3 |

### `src/main-process/background-execution/external-parser-finalization.js`

| 名字 | 总次数 |
|---|---:|
| `finalizersByRuntime` | 4 |
| `shutdownError` | 4 |
| `observeBarrier` | 3 |
| `observeFinalizationAttempt` | 3 |
| `runtimeState` | 3 |

### `src/main-process/background-execution/mature-action-adapters.js`

| 名字 | 总次数 |
|---|---:|
| `MATURE_ACTION_KEYS` | 14 |
| `MATURE_ACTION_PRODUCTION` | 3 |

### `src/main-process/background-execution/pending-bizop-adapter-policies.js`

| 名字 | 总次数 |
|---|---:|
| `PENDING_BIZOP_ADAPTER_ACTIONS` | 5 |
| `pendingBizOpAdapterPolicy` | 3 |

### `src/main-process/background-execution/position-import-adapter-policy.js`

| 名字 | 总次数 |
|---|---:|
| `POSITION_IMPORT_ADAPTER_COMMAND_SET` | 3 |
| `POSITION_IMPORT_ADAPTER_COMMANDS` | 3 |
| `POSITION_IMPORT_ADAPTER_OUTCOMES` | 3 |

### `src/main-process/background-execution/production-strategy-snapshot.js`

| 名字 | 总次数 |
|---|---:|
| `actionOptionMap` | 3 |
| `buildExpected` | 3 |
| `PRODUCTION_STRATEGY_SNAPSHOT_VERSION` | 3 |
| `ProductionStrategySnapshotError` | 3 |

### `src/main-process/background-execution/protocol-validator.js`

| 名字 | 总次数 |
|---|---:|
| `jsonValueError` | 15 |
| `plainBody` | 7 |
| `validatePrivacy` | 6 |
| `PLATFORM_PROTOCOL_MAX_BYTES` | 5 |
| `appendJsonPath` | 4 |
| `tightenByteLimit` | 4 |
| `byteLimitForEnvelope` | 3 |
| `deepFreezeJson` | 3 |
| `ownEnumerableDataValue` | 3 |
| `protocolSchemaValidator` | 3 |
| `validateExpectedRoute` | 3 |

### `src/main-process/background-execution/recovery-control-contract.js`

| 名字 | 总次数 |
|---|---:|
| `RecoveryControlValidationError` | 10 |
| `validators` | 6 |
| `validateWith` | 5 |
| `BOUNDED_JSON_MAX_BYTES` | 4 |
| `recoveryControlSchema` | 4 |
| `TRANSITION_EVENT_TYPES` | 4 |
| `assertImplementedTransition` | 3 |
| `OBSERVATION_EVENT_TYPES` | 3 |
| `REQUEST_KEY_PREFIX` | 3 |
| `validateBoundedFields` | 3 |
| `validateTransitionSemantics` | 3 |

### `src/main-process/background-execution/recovery-hold-request.js`

| 名字 | 总次数 |
|---|---:|
| `recoveryHoldSafeSummary` | 3 |

### `src/main-process/background-execution/recovery-source.js`

| 名字 | 总次数 |
|---|---:|
| `RecoverySourceValidationError` | 10 |
| `recoverySourceSchema` | 5 |
| `RECOVERY_EVIDENCE_MAX_BYTES` | 4 |
| `validateBoundedObject` | 4 |
| `assertIdentity` | 3 |
| `createRuntimeSchemaView` | 3 |
| `definitionValidator` | 3 |
| `RECOVERY_ENVELOPE_MAX_BYTES` | 3 |

### `src/main-process/background-execution/resource-budget.js`

| 名字 | 总次数 |
|---|---:|
| `nonNegativeSafeInteger` | 4 |
| `COMPATIBILITY_MINIMUM_MEMORY_HARD_CEILING_BYTES` | 3 |
| `DEFAULT_SYSTEM_RESERVE_BYTES` | 3 |

### `src/main-process/background-execution/resource-governor.js`

| 名字 | 总次数 |
|---|---:|
| `assertNonEmptyString` | 13 |
| `governorClosers` | 3 |
| `governorDeferredReleasers` | 3 |

### `src/main-process/background-execution/resource-lease.js`

| 名字 | 总次数 |
|---|---:|
| `RESOURCE_VECTOR_KEYS` | 12 |
| `freezeVector` | 9 |
| `DYNAMIC_RESOURCE_VECTOR_KEYS` | 4 |
| `LEASE_KINDS` | 3 |
| `ownEnumerableKeys` | 3 |
| `validateComponent` | 3 |

### `src/main-process/background-execution/runtime.js`

| 名字 | 总次数 |
|---|---:|
| `BACKGROUND_EXECUTION_POLICIES` | 13 |
| `assertNonProductionGovernorRequest` | 4 |
| `createBackgroundExecutionRuntime` | 3 |
| `createBackgroundExecutionRuntimeInternal` | 3 |
| `isBackgroundExecutionProductionEnabled` | 3 |

### `src/main-process/background-execution/schema-validator.js`

| 名字 | 总次数 |
|---|---:|
| `SchemaCompileError` | 12 |
| `appendPointer` | 7 |
| `jsonValueEqual` | 7 |
| `isSchema` | 6 |
| `escapePointerToken` | 5 |
| `SUPPORTED_SCHEMA_KEYWORDS` | 4 |
| `auditSchema` | 3 |
| `collectSchemaKeywords` | 3 |
| `resolveLocalRef` | 3 |
| `SCHEMA_ARRAY_KEYWORDS` | 3 |
| `SCHEMA_MAP_KEYWORDS` | 3 |
| `SCHEMA_VALUE_KEYWORDS` | 3 |

### `src/main-process/background-execution/sequence-tracker.js`

| 名字 | 总次数 |
|---|---:|
| `scopeKeyOwned` | 4 |
| `sequenceScopeOwned` | 4 |

### `src/main-process/background-execution/service-client.js`

| 名字 | 总次数 |
|---|---:|
| `requireMethod` | 4 |

### `src/main-process/background-execution/service-host.js`

| 名字 | 总次数 |
|---|---:|
| `ServiceHostError` | 44 |
| `jobRefMatches` | 4 |
| `validateTimerDuration` | 4 |
| `carrierKind` | 3 |
| `serviceTransportOwnership` | 3 |

### `src/main-process/background-execution/startup-recovery-coordinator.js`

| 名字 | 总次数 |
|---|---:|
| `requireDependency` | 13 |
| `holdIdFor` | 6 |
| `DEFAULT_BACKOFF_BASE_MS` | 3 |
| `DEFAULT_BACKOFF_MAX_MS` | 3 |
| `DEFAULT_TRANSIENT_ATTEMPTS` | 3 |
| `retainedCommittedResultLostHoldSummary` | 3 |

### `src/main-process/background-execution/supervisor.js`

| 名字 | 总次数 |
|---|---:|
| `SupervisorError` | 64 |
| `validateStringField` | 7 |
| `validateResultBody` | 6 |
| `promiseWithTimeout` | 4 |
| `coordinatorTransportFailures` | 3 |
| `makeId` | 3 |
| `normalizeCancelReason` | 3 |
| `snapshotExecuteRequest` | 3 |

### `src/main-process/background-execution/task-lifecycle-adapter.js`

| 名字 | 总次数 |
|---|---:|
| `batchBase` | 4 |
| `taskBase` | 4 |

### `src/main-process/bank-bu-recon-writer.js`

| 名字 | 总次数 |
|---|---:|
| `rowDbObjectToArray` | 5 |
| `DIFF_OUTPUT_ANOMALY_SHEET` | 4 |
| `ANOMALY_HEADERS_AGGREGATE` | 3 |
| `anomalyRowToArray` | 3 |
| `buildOutputPath` | 3 |

### `src/main-process/bank-bu-worker/dual-parser-dispatch.js`

| 名字 | 总次数 |
|---|---:|
| `executeManagedBankBuDualImport` | 3 |
| `isDualParserGateApproved` | 3 |
| `MIN_DUAL_IMPROVEMENT_RATIO` | 3 |
| `runBankBuParserWorker` | 3 |

### `src/main-process/bank-bu-worker/export-operation.js`

| 名字 | 总次数 |
|---|---:|
| `cleanupStaging` | 4 |
| `loadManagedSnapshot` | 4 |
| `readManagedState` | 4 |
| `assertFreshExportIdentity` | 3 |
| `latestRuns` | 3 |
| `managedSidePath` | 3 |
| `readManagedStateFresh` | 3 |
| `resolveStaging` | 3 |
| `runIdentity` | 3 |

### `src/main-process/bank-bu-worker/identity.js`

| 名字 | 总次数 |
|---|---:|
| `buildRoleEvidence` | 3 |
| `canonicalRows` | 3 |

### `src/main-process/bank-bu-worker/mirror-repository.js`

| 名字 | 总次数 |
|---|---:|
| `hashMirror` | 3 |

### `src/main-process/bank-bu-worker/operation-receipt-repository.js`

| 名字 | 总次数 |
|---|---:|
| `ACTION_KINDS` | 4 |

### `src/main-process/bank-bu-worker/parser-outcome.js`

| 名字 | 总次数 |
|---|---:|
| `writeBankBuParserOutcome` | 3 |

### `src/main-process/bank-bu-worker/policies.js`

| 名字 | 总次数 |
|---|---:|
| `IMPORT_PHASE` | 3 |

### `src/main-process/bank-bu-worker/side-database.js`

| 名字 | 总次数 |
|---|---:|
| `assertImportReplayCurrent` | 3 |

### `src/main-process/bank-bu-worker/spool-contract.js`

| 名字 | 总次数 |
|---|---:|
| `normalizeRole` | 4 |
| `BankBuSpoolError` | 3 |

### `src/main-process/bank-bu-worker/spool-reader.js`

| 名字 | 总次数 |
|---|---:|
| `assertSourceAuthority` | 6 |
| `readBankBuSpoolManifest` | 5 |
| `readBankBuInputSpool` | 4 |

### `src/main-process/bank-bu-worker/spool-writer.js`

| 名字 | 总次数 |
|---|---:|
| `assertSnapshot` | 4 |

### `src/main-process/bank-bu-worker/worker-host.js`

| 名字 | 总次数 |
|---|---:|
| `EXECUTORS` | 3 |

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

### `src/main-process/big-table-import-dispatch.js`

| 名字 | 总次数 |
|---|---:|
| `adapterContextError` | 4 |
| `inspectBigTableImportTopology` | 3 |

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

### `src/main-process/duplicate-inbound-match/input-classifier.js`

| 名字 | 总次数 |
|---|---:|
| `inspectSheetNames` | 3 |

### `src/main-process/duplicate-inbound-match/managed-service.js`

| 名字 | 总次数 |
|---|---:|
| `DuplicateManagedServiceError` | 29 |
| `emptySummary` | 5 |
| `summaryFromService` | 5 |
| `DUPLICATE_EXPORT_STAGING_PLAN_VERSION` | 3 |
| `exportPlanObject` | 3 |
| `normalizeDuplicateExportStagingPlan` | 3 |
| `prepareDuplicateExportStaging` | 3 |
| `runtimeIdentity` | 3 |

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

### `src/main-process/duplicate-inbound-match/operation-receipt-repository.js`

| 名字 | 总次数 |
|---|---:|
| `ACTION_PHASES` | 4 |

### `src/main-process/duplicate-inbound-match/paired-parser-dispatch.js`

| 名字 | 总次数 |
|---|---:|
| `executeManagedDuplicatePairedImport` | 3 |
| `isPairedParserGateApproved` | 3 |
| `MIN_PAIRED_IMPROVEMENT_RATIO` | 3 |
| `runDuplicateParserWorker` | 3 |

### `src/main-process/duplicate-inbound-match/paired-parser-shutdown.js`

| 名字 | 总次数 |
|---|---:|
| `assertDuplicateRuntime` | 3 |

### `src/main-process/duplicate-inbound-match/parser-outcome.js`

| 名字 | 总次数 |
|---|---:|
| `writeDuplicateParserOutcome` | 3 |

### `src/main-process/duplicate-inbound-match/policies.js`

| 名字 | 总次数 |
|---|---:|
| `validCompact` | 4 |
| `duplicatePolicy` | 3 |
| `PHASE_IMPORT` | 3 |

### `src/main-process/duplicate-inbound-match/service.js`

| 名字 | 总次数 |
|---|---:|
| `DuplicateInboundMatchServiceError` | 25 |
| `recoveryRequiredError` | 8 |
| `countFundTypes` | 4 |
| `toDocumentLineage` | 4 |
| `toMptLineage` | 4 |
| `assertImportNotAborted` | 3 |
| `DuplicateInboundMatchService` | 3 |
| `MAIL_REMARK` | 3 |
| `mirrorSafeError` | 3 |
| `runInvalidationActions` | 3 |

### `src/main-process/duplicate-inbound-match/spool-contract.js`

| 名字 | 总次数 |
|---|---:|
| `normalizeSlotIndex` | 4 |
| `DuplicateSpoolError` | 3 |

### `src/main-process/duplicate-inbound-match/spool-reader.js`

| 名字 | 总次数 |
|---|---:|
| `assertSourceIdentity` | 6 |
| `readDuplicateSpoolManifest` | 5 |
| `resolveDuplicateSpoolPair` | 4 |

### `src/main-process/duplicate-inbound-match/spool-writer.js`

| 名字 | 总次数 |
|---|---:|
| `assertSourceUnchanged` | 3 |
| `writeRow` | 3 |

### `src/main-process/duplicate-inbound-match/startup-gate.js`

| 名字 | 总次数 |
|---|---:|
| `DuplicateManagedStartupGateError` | 8 |

### `src/main-process/duplicate-inbound-match/startup-recovery.js`

| 名字 | 总次数 |
|---|---:|
| `makeInspection` | 9 |
| `sidePostImageHash` | 9 |
| `settlementResult` | 7 |
| `tablePresence` | 4 |
| `DUPLICATE_STARTUP_ACTION` | 3 |
| `DUPLICATE_STARTUP_SOURCE_REF` | 3 |
| `inspectSideDatabases` | 3 |
| `mirrorPostImageHash` | 3 |

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

### `src/main-process/fund-recon-worker/artifact-generator.js`

| 名字 | 总次数 |
|---|---:|
| `FundReconArtifactError` | 15 |
| `OUTPUT_KINDS` | 4 |
| `assertPhysicalParentInside` | 3 |
| `normalizeStagingPlan` | 3 |
| `prepareRefundSettlement` | 3 |
| `resolveInside` | 3 |

### `src/main-process/fund-recon-worker/evidence-provider.js`

| 名字 | 总次数 |
|---|---:|
| `FundReconEvidenceError` | 5 |
| `createEvidenceSignature` | 3 |
| `detailedScenarios` | 3 |
| `enabledConsumerFlags` | 3 |
| `openReadSnapshot` | 3 |

### `src/main-process/fund-recon-worker/policies.js`

| 名字 | 总次数 |
|---|---:|
| `isNonNegativeInteger` | 6 |
| `fundReconPolicy` | 5 |
| `validateStableSummary` | 4 |
| `validateFundReconCompactResult` | 3 |

### `src/main-process/fund-recon-worker/service.js`

| 名字 | 总次数 |
|---|---:|
| `FundReconServiceError` | 16 |
| `assertNotAborted` | 5 |
| `buildImportedCandidate` | 3 |
| `compactResult` | 3 |
| `processingResultFromRun` | 3 |
| `requirePlainInput` | 3 |

### `src/main-process/fund-recon-worker/source-readers.js`

| 名字 | 总次数 |
|---|---:|
| `FundReconSourceError` | 5 |
| `requireFilePath` | 4 |
| `readLinkedRowsAsObjects` | 3 |

### `src/main-process/fund-recon-worker/state-footprint.js`

| 名字 | 总次数 |
|---|---:|
| `FundReconStateFootprintError` | 3 |

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
| `balanceSeedRecordKey` | 5 |
| `buildManualBalanceInvalidResult` | 5 |
| `manualBalancePreflightError` | 4 |
| `buildManualBalanceSeedPlan` | 3 |

### `src/main-process/manual-balance-seed-settlement.js`

| 名字 | 总次数 |
|---|---:|
| `MANUAL_BALANCE_SOURCE_KIND` | 6 |
| `createManualBalanceOperationIdentity` | 5 |
| `createManualBalanceTargetAlias` | 5 |
| `ManualBalanceSeedSettlementError` | 5 |
| `MANUAL_BALANCE_MAX_ORDINAL` | 4 |
| `manualBalancePlanBinding` | 3 |
| `snapshotForBytes` | 3 |
| `writeManualBalanceTargetPostImage` | 3 |

### `src/main-process/monthly-balance.js`

| 名字 | 总次数 |
|---|---:|
| `buildTargetLastDay` | 3 |
| `isRegularTemplate` | 3 |
| `lastDayOfMonth` | 3 |
| `pickLatestSeedForAccount` | 3 |

### `src/main-process/new-account/artifact-copy.js`

| 名字 | 总次数 |
|---|---:|
| `NEW_ACCOUNT_SAVE_AS_SCHEMA_VERSION` | 7 |
| `statIdentityValue` | 7 |
| `assertNoSymlinkPathChain` | 6 |
| `assertSourceCurrent` | 6 |
| `fileSha256Async` | 5 |
| `normalizeCopyInput` | 5 |
| `assertSaveAsPathsDistinct` | 4 |
| `cleanupOwnedCopyStaging` | 4 |
| `MAX_COPY_ARTIFACT_BYTES` | 4 |
| `snapshotSourceGenerationResult` | 4 |
| `STAGING_SNAPSHOT_KEYS` | 4 |
| `validateCopiedArtifact` | 4 |
| `assertSourceMetadataCurrent` | 3 |
| `createNewAccountSaveAsInput` | 3 |
| `executeNewAccountArtifactCopy` | 3 |
| `MAX_COPY_CONTRACT_BYTES` | 3 |
| `NewAccountSaveAsError` | 3 |
| `snapshotMatches` | 3 |

### `src/main-process/new-account/generation-contract.js`

| 名字 | 总次数 |
|---|---:|
| `checkedProjectionAdd` | 19 |
| `checkedProjectionMultiply` | 7 |
| `cellEncodedUtf8Bytes` | 5 |
| `MAX_ACCOUNTS` | 5 |
| `utf16Bytes` | 5 |
| `ISO_DATE` | 3 |
| `isoDayOrdinal` | 3 |
| `MAX_RESULT_BYTES` | 3 |
| `NewAccountGenerationContractError` | 3 |
| `projectNewAccountGenerationRecordCount` | 3 |
| `validateNewAccountBusinessEvidence` | 3 |
| `validateNewAccountGenerationArtifact` | 3 |

### `src/main-process/new-account/generation-core.js`

| 名字 | 总次数 |
|---|---:|
| `normalizeDateOnly` | 4 |

### `src/main-process/new-account/generation-validator.js`

| 名字 | 总次数 |
|---|---:|
| `expectedArtifactAuthorities` | 4 |
| `cleanupOwnedGeneration` | 3 |
| `createNewAccountExpectedArtifactAuthorityCooperatively` | 3 |
| `createNewAccountFilePlan` | 3 |
| `createNewAccountWorkerInput` | 3 |
| `normalizeMainAccounts` | 3 |
| `technicalValidateNewAccountArtifact` | 3 |

### `src/main-process/new-account/policies.js`

| 名字 | 总次数 |
|---|---:|
| `GENERATION_RESOURCES` | 3 |
| `SAVE_AS_RESOURCES` | 3 |

### `src/main-process/new-account/resource-estimator.js`

| 名字 | 总次数 |
|---|---:|
| `NEW_ACCOUNT_GENERATION_MEMORY_MODEL` | 17 |
| `NewAccountResourceEstimateError` | 10 |
| `checkedSum` | 4 |
| `FIXED_MEMORY_ENVELOPE_BYTES` | 4 |
| `MAX_OUTPUT_CELL_ENCODED_UTF8_BYTES_PER_RECORD` | 4 |
| `MAX_OUTPUT_TEXT_CODE_UNITS_PER_RECORD` | 4 |
| `MAX_OUTPUT_TEXT_UTF16_BYTES_PER_RECORD` | 4 |
| `MAX_OUTPUT_TEXT_UTF8_BYTES_PER_RECORD` | 4 |
| `calculateNewAccountGenerationMemory` | 3 |
| `createNewAccountGenerationResourceEstimate` | 3 |
| `estimateNewAccountGenerationMemory` | 3 |
| `MAX_NEW_ACCOUNT_GENERATION_MEMORY_BYTES` | 3 |
| `MAX_NEW_ACCOUNT_GENERATION_SHAPE` | 3 |
| `NEW_ACCOUNT_GENERATION_RESOURCE_MODEL_VERSION` | 3 |

### `src/main-process/new-account/strict-worksheet-readback.js`

| 名字 | 总次数 |
|---|---:|
| `assertSpreadsheetElement` | 13 |
| `failXml` | 7 |
| `attributeValue` | 6 |
| `encodeCellReference` | 5 |
| `rangesEqual` | 5 |
| `decodeExcelEscapes` | 4 |
| `parseCanonicalRangeReference` | 4 |
| `parseDimensionReference` | 4 |
| `decodeCell` | 3 |
| `ERROR_VALUES` | 3 |
| `parseUtf8StreamStrict` | 3 |
| `SHEETJS_BASE_DATE` | 3 |
| `sheetJsDateSerial` | 3 |
| `XLSX_MAX_COLUMNS` | 3 |
| `XLSX_MAX_ROWS` | 3 |

### `src/main-process/new-account/worker-entry.js`

| 名字 | 总次数 |
|---|---:|
| `testReadbackStagePort` | 9 |
| `testReadbackPauseStage` | 6 |
| `testReadbackPauseOccurrence` | 5 |
| `allowedTemplatePath` | 4 |
| `closeTestReadbackStagePort` | 4 |

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
| `monotonicNowMs` | 4 |
| `WORKER_ENTRY` | 4 |
| `cleanupUncommittedImportArtifacts` | 3 |
| `uncommittedJobRoot` | 3 |
| `workerExitedError` | 3 |

### `src/main-process/position-reconciliation/import-recovery.js`

| 名字 | 总次数 |
|---|---:|
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
| `checkpointMismatch` | 15 |
| `incompleteSideDatabaseError` | 13 |
| `assertBankPayload` | 9 |
| `assertPayloadFields` | 8 |
| `assertSameTextSet` | 8 |
| `assertStoredCounter` | 8 |
| `decodeScopeKey` | 8 |
| `consumptionRelationKey` | 7 |
| `POSITION_DB_INITIALIZATION_MODES` | 6 |
| `assertStoredTextList` | 5 |
| `quoteSqlIdentifier` | 5 |
| `sameStoredValue` | 5 |
| `assertRunLineage` | 4 |
| `assertRunSnapshot` | 4 |
| `PositionReconciliationStore` | 4 |
| `assertRevisionMap` | 3 |
| `assertRunRowContract` | 3 |
| `assertSupportedEmptyLegacyDatabase` | 3 |
| `DATE_JSON_TYPE_KEY` | 3 |
| `normalizeSchemaSql` | 3 |
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

### `src/main-process/pre-fund-reconciliation/mpt-import/conflict-scope.js`

| 名字 | 总次数 |
|---|---:|
| `canonicalMptBatchIdentity` | 3 |
| `requireIdentityText` | 3 |

### `src/main-process/pre-fund-reconciliation/mpt-import/managed-import.js`

| 名字 | 总次数 |
|---|---:|
| `failAfterParentTerminal` | 4 |

### `src/main-process/pre-fund-reconciliation/mpt-import/operation-receipt-repository.js`

| 名字 | 总次数 |
|---|---:|
| `requireSafeInteger` | 4 |
| `optionalVersion` | 3 |
| `OUTCOME_KINDS` | 3 |

### `src/main-process/pre-fund-reconciliation/mpt-import/ordered-coordinator.js`

| 名字 | 总次数 |
|---|---:|
| `OrderedMptCoordinator` | 3 |

### `src/main-process/pre-fund-reconciliation/mpt-import/parser-core.js`

| 名字 | 总次数 |
|---|---:|
| `INVALID_ROW_DISPOSITIONS` | 5 |

### `src/main-process/pre-fund-reconciliation/mpt-import/parser-outcome.js`

| 名字 | 总次数 |
|---|---:|
| `BASE_FAILURE_KEYS` | 3 |
| `exactFileResult` | 3 |
| `exactOutcome` | 3 |
| `MAX_BYTES` | 3 |
| `MAX_DETAIL_LINE_BYTES` | 3 |
| `MAX_DETAIL_LINES` | 3 |

### `src/main-process/pre-fund-reconciliation/mpt-import/policies.js`

| 名字 | 总次数 |
|---|---:|
| `preFundMptPolicy` | 4 |
| `validatePreFundMptParentResult` | 4 |

### `src/main-process/pre-fund-reconciliation/mpt-import/recovery-plan.js`

| 名字 | 总次数 |
|---|---:|
| `TASK_KEYS` | 4 |
| `createInterruptedTransitions` | 3 |

### `src/main-process/pre-fund-reconciliation/mpt-import/single-writer-session.js`

| 名字 | 总次数 |
|---|---:|
| `normalizeJobInput` | 3 |
| `normalizeUnitInput` | 3 |
| `successResult` | 3 |

### `src/main-process/pre-fund-reconciliation/mpt-import/spool-admission.js`

| 名字 | 总次数 |
|---|---:|
| `checkedSafeNumber` | 4 |
| `estimateMptSpoolBytes` | 3 |
| `FIXED_SAFETY_BYTES` | 3 |
| `PER_FILE_SAFETY_BYTES` | 3 |
| `SPOOL_EXPANSION_NUMERATOR` | 3 |

### `src/main-process/pre-fund-reconciliation/mpt-import/spool-contract.js`

| 名字 | 总次数 |
|---|---:|
| `MPT_SPOOL_MAX_FILE_INDEX` | 3 |
| `MptSpoolError` | 3 |
| `paddedFileIndex` | 3 |

### `src/main-process/pre-fund-reconciliation/mpt-import/spool-reader.js`

| 名字 | 总次数 |
|---|---:|
| `assertRegularNoSymlink` | 5 |
| `scanNdjson` | 5 |
| `assertSafeCount` | 4 |
| `assertSha256` | 4 |
| `NORMALIZED_ROW_KEYS` | 4 |
| `validateIssueEnvelope` | 3 |
| `validateRowEnvelope` | 3 |

### `src/main-process/pre-fund-reconciliation/mpt-import/spool-writer.js`

| 名字 | 总次数 |
|---|---:|
| `lstatDirectory` | 4 |
| `assertContainedDirectory` | 3 |
| `assertFreshRegularSource` | 3 |
| `closeDurably` | 3 |
| `ensurePrivateDirectory` | 3 |
| `openPart` | 3 |
| `readyArtifact` | 3 |

### `src/main-process/pre-fund-reconciliation/mpt-import/topology.js`

| 名字 | 总次数 |
|---|---:|
| `MAX_IMPORT_PARSER_COUNT` | 3 |
| `normalizePositiveCount` | 3 |

### `src/main-process/pre-fund-reconciliation/mpt-parser.js`

| 名字 | 总次数 |
|---|---:|
| `MAX_LINE_LENGTH` | 5 |
| `DEFAULT_BATCH_SIZE` | 3 |
| `DEFAULT_ROW_ERROR_SAMPLE_LIMIT` | 3 |
| `forwardPipedStreamError` | 3 |
| `iterateUtf8Lines` | 3 |
| `mapStreamError` | 3 |

### `src/main-process/pre-fund-reconciliation/mpt-schema.js`

| 名字 | 总次数 |
|---|---:|
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
| `PreFundReconciliationService` | 3 |
| `TERMINAL_MPT_REPAIR_CODES` | 3 |

### `src/main-process/read-only-exports/acquiring/actions.js`

| 名字 | 总次数 |
|---|---:|
| `normalizeCopyEvidence` | 3 |
| `normalizeCopySource` | 3 |
| `normalizeRegenerateEvidence` | 3 |
| `normalizeRegenerateSource` | 3 |
| `regularFile` | 3 |

### `src/main-process/read-only-exports/acquiring/executor.js`

| 名字 | 总次数 |
|---|---:|
| `executorError` | 8 |
| `assertCopySourceCurrent` | 4 |
| `cleanupOwnedStaging` | 4 |
| `sha256WithCancellation` | 4 |
| `copySourceStat` | 3 |
| `executeCopy` | 3 |
| `executeRegenerate` | 3 |

### `src/main-process/read-only-exports/acquiring/policies.js`

| 名字 | 总次数 |
|---|---:|
| `acquiringExportPolicy` | 3 |

### `src/main-process/read-only-exports/acquiring/query.js`

| 名字 | 总次数 |
|---|---:|
| `hashQuery` | 5 |
| `singleLinkFileStat` | 4 |
| `updateHashRecord` | 4 |
| `freezeAcquiringRegenerateSource` | 3 |
| `resolveRegenerateRunAuthority` | 3 |
| `sha256FileStable` | 3 |
| `validMonthKey` | 3 |

### `src/main-process/read-only-exports/biz-op/policies.js`

| 名字 | 总次数 |
|---|---:|
| `bizOpReadOnlyExportPolicy` | 3 |

### `src/main-process/read-only-exports/biz-op/query.js`

| 名字 | 总次数 |
|---|---:|
| `assertStableRun` | 5 |
| `readSourceGroup` | 5 |
| `assertBizOpSidePath` | 4 |
| `selectRunLocators` | 3 |
| `sourceRunRevision` | 3 |
| `withMainReadSnapshot` | 3 |

### `src/main-process/read-only-exports/biz-op/writer.js`

| 名字 | 总次数 |
|---|---:|
| `buildFrozenExportDb` | 3 |
| `selectorForInput` | 3 |

### `src/main-process/read-only-exports/common/artifact-evidence.js`

| 名字 | 总次数 |
|---|---:|
| `artifactError` | 3 |

### `src/main-process/read-only-exports/common/contract.js`

| 名字 | 总次数 |
|---|---:|
| `normalizeGenerationPlan` | 3 |

### `src/main-process/read-only-exports/common/workbook-evidence.js`

| 名字 | 总次数 |
|---|---:|
| `sheetSemanticEvidence` | 3 |

### `src/main-process/read-only-exports/pending/policies.js`

| 名字 | 总次数 |
|---|---:|
| `pendingReadOnlyExportPolicy` | 3 |

### `src/main-process/read-only-exports/pending/query.js`

| 名字 | 总次数 |
|---|---:|
| `pendingSourceError` | 8 |
| `readPendingRunSourceSnapshot` | 4 |
| `normalizeRunIds` | 3 |
| `revisionForRun` | 3 |

### `src/main-process/read-only-exports/pending/writer.js`

| 名字 | 总次数 |
|---|---:|
| `openPendingReadDatabase` | 3 |
| `readManagedErrorSnapshot` | 3 |

### `src/main-process/read-only-exports/position/actions.js`

| 名字 | 总次数 |
|---|---:|
| `normalizeTextArray` | 5 |
| `normalizeFilters` | 3 |
| `normalizeReportFiles` | 3 |

### `src/main-process/read-only-exports/position/query.js`

| 名字 | 总次数 |
|---|---:|
| `normalizeExportFilters` | 3 |
| `reportInventoryFromRows` | 3 |
| `requireExportRun` | 3 |
| `resolveReportFiles` | 3 |

### `src/main-process/read-only-exports/pre-fund/managed-export.js`

| 名字 | 总次数 |
|---|---:|
| `childOperationContext` | 3 |
| `executeUnit` | 3 |
| `normalizeUnits` | 3 |

### `src/main-process/read-only-exports/pre-fund/policies.js`

| 名字 | 总次数 |
|---|---:|
| `preFundReadOnlyExportPolicy` | 3 |

### `src/main-process/read-only-exports/pre-fund/query.js`

| 名字 | 总次数 |
|---|---:|
| `resolveSideDatabasePath` | 4 |
| `assertStableReceipt` | 3 |
| `listChannelInventory` | 3 |
| `readPreFundSourceSnapshot` | 3 |

### `src/main-process/read-only-exports/pre-fund/writer.js`

| 名字 | 总次数 |
|---|---:|
| `findExactChannel` | 3 |
| `locatorFromEvidence` | 3 |

### `src/main-process/read-only-exports/vcc-financial-op/actions.js`

| 名字 | 总次数 |
|---|---:|
| `normalizeInspection` | 3 |

### `src/main-process/read-only-exports/vcc-financial-op/query.js`

| 名字 | 总次数 |
|---|---:|
| `nonNegativeRecordInteger` | 8 |
| `requireJsonArrayText` | 4 |
| `anomalyEnvelope` | 3 |
| `readDatasetRevisionEnvelope` | 3 |
| `recordEnvelope` | 3 |

### `src/main-process/read-only-exports/vcc-financial-op/writer.js`

| 名字 | 总次数 |
|---|---:|
| `resultSummary` | 3 |
| `writeAudit` | 3 |
| `writeDataset` | 3 |

### `src/main-process/recon-id-fix-io.js`

| 名字 | 总次数 |
|---|---:|
| `readSheetOrThrow` | 6 |
| `PRE_FUND_UNBALANCED_SHEET_NAME` | 5 |
| `PRE_FUND_BALANCED_SHEET_NAME` | 4 |
| `PRE_FUND_DUPLICATE_GATEWAY_SHEET_NAME` | 4 |
| `getSheetConfigBySubMode` | 3 |
| `PRE_FUND_SOURCE_FIELD` | 3 |
| `PRE_FUND_UNBALANCED_FIELDS_LEGACY` | 3 |

### `src/main-process/recon-id-fix-service/evidence-projection.js`

| 名字 | 总次数 |
|---|---:|
| `reconFixEvidenceProjection` | 4 |
| `UNSAFE_INTEGER_KIND` | 3 |

### `src/main-process/recon-id-fix-service/evidence-settlement-admission.js`

| 名字 | 总次数 |
|---|---:|
| `admissionStates` | 3 |
| `assertOperationKey` | 3 |
| `RECON_FIX_EVIDENCE_WRITER_KINDS` | 3 |

### `src/main-process/recon-id-fix-service/export-operation.js`

| 名字 | 总次数 |
|---|---:|
| `canonicalReconFixFilePlan` | 5 |
| `freezeReconFixArtifactBindings` | 5 |
| `exactResultReference` | 4 |
| `freezeReconFixExportBatchAuthority` | 4 |
| `createReconFixExportInputFromReference` | 3 |
| `publishReconFixExportArtifacts` | 3 |
| `RECON_FIX_EXPORT_SOURCE_OPERATION` | 3 |
| `validateReconFixExportJoin` | 3 |

### `src/main-process/recon-id-fix-service/jpm-conflict-scope.js`

| 名字 | 总次数 |
|---|---:|
| `RECON_FIX_JPM_ADM_CONFLICT_SCOPE` | 3 |

### `src/main-process/recon-id-fix-service/jpm-database-authority.js`

| 名字 | 总次数 |
|---|---:|
| `normalizeReconFixJpmDatabasePath` | 4 |

### `src/main-process/recon-id-fix-service/jpm-outcome-inspector.js`

| 名字 | 总次数 |
|---|---:|
| `currentMatches` | 4 |
| `receiptMatchesSource` | 3 |

### `src/main-process/recon-id-fix-service/jpm-receipt-evidence.js`

| 名字 | 总次数 |
|---|---:|
| `KEYS` | 3 |

### `src/main-process/recon-id-fix-service/jpm-recovery-plan.js`

| 名字 | 总次数 |
|---|---:|
| `interruptedTransition` | 5 |
| `failureForOutcome` | 4 |
| `recoveryPlanError` | 4 |
| `definitiveHeldRecoveryTransitions` | 3 |
| `exactTaskState` | 3 |
| `inspectorUnavailableInterruption` | 3 |

### `src/main-process/recon-id-fix-service/jpm-recovery-task-state.js`

| 名字 | 总次数 |
|---|---:|
| `persistedStateError` | 3 |
| `RECON_FIX_MODULE_ID` | 3 |

### `src/main-process/recon-id-fix-service/jpm-worker-durable-coordinator.js`

| 名字 | 总次数 |
|---|---:|
| `deriveWorkerInstanceIdentity` | 4 |

### `src/main-process/recon-id-fix-service/jpm-writeback-plan.js`

| 名字 | 总次数 |
|---|---:|
| `requireExactKeys` | 5 |
| `JPM_BOUNDED_SUMMARY_MAX_BYTES` | 3 |
| `JPM_WRITEBACK_PLAN_CONTRACT_VERSION` | 3 |
| `RECON_FIX_JPM_ACTION` | 3 |
| `VALID_PLANS` | 3 |
| `withoutWritebackFields` | 3 |
| `WRITEBACK_FIELDS` | 3 |

### `src/main-process/recon-id-fix-service/jpm-writeback-transaction.js`

| 名字 | 总次数 |
|---|---:|
| `assertCommittedPostImage` | 3 |

### `src/main-process/recon-id-fix-service/policies.js`

| 名字 | 总次数 |
|---|---:|
| `reconFixReadonlyPolicy` | 6 |
| `RECON_FIX_ENTRY_KEYS` | 5 |
| `RECON_FIX_RESULT_VALIDATOR_KEYS` | 5 |
| `allowReconFixFinanceSafeValue` | 4 |
| `RECON_FIX_EXPORT_POLICY` | 3 |
| `RECON_FIX_READONLY_POLICIES` | 3 |
| `reconFixExportPolicy` | 3 |
| `reconFixJpmPolicy` | 3 |

### `src/main-process/recon-id-fix-service/service.js`

| 名字 | 总次数 |
|---|---:|
| `fileIdentity` | 6 |
| `assertExpectedRevision` | 5 |
| `createCandidate` | 5 |
| `assertCurrentLinkedEvidence` | 4 |
| `estimateRunPhaseBytes` | 4 |
| `MAX_PERSISTENT_STATE_BYTES` | 4 |
| `MAX_PHASE_EXTENSION_BYTES` | 4 |
| `projectRows` | 4 |
| `statInputFile` | 4 |
| `buildReconFixExportAuthority` | 3 |
| `buildScenarioSnapshot` | 3 |
| `createCandidateAtRevision` | 3 |
| `estimateImportPhaseBytes` | 3 |
| `estimatePersistentStateBytes` | 3 |
| `MEMORY_OVERHEAD_MULTIPLIER` | 3 |
| `PHASE_EXTENSION_GRANULARITY_BYTES` | 3 |
| `PHASE_FIXED_OVERHEAD_BYTES` | 3 |
| `phaseExtensionReservationBytes` | 3 |
| `prepareBocReadSnapshot` | 3 |
| `ReconFixServiceError` | 3 |

### `src/main-process/recon-id-fix-service/worker-entry.js`

| 名字 | 总次数 |
|---|---:|
| `serviceIdentity` | 21 |
| `cancellationSafepoint` | 11 |
| `adoptCandidateAtSafepoint` | 7 |
| `phaseReservations` | 7 |
| `closeRequested` | 6 |
| `pendingReleases` | 6 |
| `mainRevokeReleases` | 5 |
| `controlEventSeq` | 3 |
| `emitJobTerminal` | 3 |
| `lastTerminalJobId` | 3 |
| `RECON_FIX_CANCELLED` | 3 |

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

### `src/main-process/startup-window.js`

| 名字 | 总次数 |
|---|---:|
| `startupWindowError` | 7 |

### `src/main-process/statement-generation-business.js`

| 名字 | 总次数 |
|---|---:|
| `seededBalance` | 3 |

### `src/main-process/statement-session.js`

| 名字 | 总次数 |
|---|---:|
| `getStatementSessionKey` | 4 |
| `clearStatementExportCache` | 3 |
| `pruneStatementImportSession` | 3 |

### `src/main-process/statement-worker/artifact-descriptor.js`

| 名字 | 总次数 |
|---|---:|
| `createFramedHasher` | 7 |
| `isBlankCell` | 7 |
| `expectedWriterCellStyle` | 6 |
| `validateAmountCell` | 5 |
| `BALANCE_PROFILE` | 4 |
| `blankCellContract` | 4 |
| `BUSINESS_EVIDENCE_KEYS` | 4 |
| `DETAIL_PROFILE` | 4 |
| `fieldSets` | 4 |
| `jsonSafe` | 4 |
| `parseStyleEvidenceXml` | 4 |
| `readWorkbook` | 4 |
| `StatementArtifactDescriptorError` | 4 |
| `workbookPartXml` | 4 |
| `workbookStructure` | 4 |
| `actualCellContract` | 3 |
| `CELL_CONTRACT_EVIDENCE_KEYS` | 3 |
| `cellStyleIndexes` | 3 |
| `cellStyleSignature` | 3 |
| `createBusinessEvidenceAccumulator` | 3 |
| `createCellContractAccumulator` | 3 |
| `createMainExpectedArtifactDescriptor` | 3 |
| `createStatementArtifactLineage` | 3 |
| `decimalParts` | 3 |
| `excelSerialDate` | 3 |
| `MAX_DESCRIPTOR_BYTES` | 3 |
| `primitiveCellContract` | 3 |
| `validateDateCell` | 3 |
| `validateTextCell` | 3 |
| `WORKBOOK_PART` | 3 |

### `src/main-process/statement-worker/contracts.js`

| 名字 | 总次数 |
|---|---:|
| `ownDataRecord` | 23 |
| `boundedArray` | 10 |
| `boundedOptionalText` | 10 |
| `MAX_BIG_ACCOUNT_ROWS` | 7 |
| `MAX_BIG_ACCOUNTS` | 5 |
| `assertNoPrivatePublicKeys` | 4 |
| `STATEMENT_ACTION_PURPOSES` | 4 |
| `allowedInteractionPurposes` | 3 |
| `BALANCE_SEED_OVERWRITE_MESSAGE` | 3 |
| `createBigAccountItemDto` | 3 |
| `createBigAccountRowDto` | 3 |
| `createExpandedBigAccountItemDto` | 3 |
| `createFixedAssignmentItemDto` | 3 |
| `createManualBalancePromptDto` | 3 |
| `createPurposePromptDto` | 3 |
| `createStatementFinanceSafeValueDelegate` | 3 |
| `createStatementPublicInteractionValue` | 3 |
| `createStatementResultValidator` | 3 |
| `STATEMENT_ACTIVE_PHASES` | 3 |
| `STATEMENT_PURPOSES` | 3 |
| `StatementContractError` | 3 |

### `src/main-process/statement-worker/generation-contracts.js`

| 名字 | 总次数 |
|---|---:|
| `MAX_ARTIFACTS` | 4 |
| `createStatementGenerationExecuteRequest` | 3 |
| `createStatementGenerationPrepareRequest` | 3 |
| `normalizeKind` | 3 |
| `StatementGenerationContractError` | 3 |
| `validateWarningSummary` | 3 |

### `src/main-process/statement-worker/generation.js`

| 名字 | 总次数 |
|---|---:|
| `StatementGenerationError` | 13 |
| `assertSourcesCurrent` | 5 |
| `resolveArtifactPlans` | 4 |
| `executeStatementGeneration` | 3 |
| `resolveGenerationGroups` | 3 |

### `src/main-process/statement-worker/import-contracts.js`

| 名字 | 总次数 |
|---|---:|
| `exactRecord` | 7 |
| `MAX_IMPORT_INPUT_BYTES` | 5 |
| `plainJsonObject` | 5 |
| `assertNoRetainedBusinessState` | 4 |
| `createStatementTemplateSnapshot` | 4 |
| `createStatementStatusRequest` | 3 |
| `createStatementTemplateEvidence` | 3 |
| `MAX_TEMPLATE_CATALOG_ENTRIES` | 3 |
| `nullableJson` | 3 |
| `StatementImportContractError` | 3 |
| `stringArray` | 3 |

### `src/main-process/statement-worker/interaction-contracts.js`

| 名字 | 总次数 |
|---|---:|
| `StatementInteractionContractError` | 9 |

### `src/main-process/statement-worker/probe-state-builder.js`

| 名字 | 总次数 |
|---|---:|
| `LEGACY_GLOBAL_KEYS` | 6 |
| `stableSourceEvidence` | 5 |
| `expandStatementProbeRows` | 4 |
| `projectDisplayRows` | 3 |
| `projectFileEntry` | 3 |
| `STATEMENT_EXPORT_KEYS` | 3 |

### `src/main-process/statement-worker/publication.js`

| 名字 | 总次数 |
|---|---:|
| `ownershipFailure` | 5 |
| `cleanupStatementStagingResources` | 3 |
| `journalPublisher` | 3 |
| `StatementPublicationError` | 3 |
| `validateBusinessArtifacts` | 3 |
| `validateOwnedArtifactEvidence` | 3 |
| `validateTechnicalArtifacts` | 3 |

### `src/main-process/statement-worker/runtime-bindings.js`

| 名字 | 总次数 |
|---|---:|
| `createStatementWorkerEntry` | 3 |
| `STATEMENT_ENTRY_KEYS` | 3 |

### `src/main-process/statement-worker/service.js`

| 名字 | 总次数 |
|---|---:|
| `StatementServiceError` | 32 |

### `src/main-process/statement-worker/session-state.js`

| 名字 | 总次数 |
|---|---:|
| `StatementSessionError` | 11 |
| `importRequiresBigAccountInteraction` | 6 |
| `mappedRowsEvidence` | 4 |
| `buildMappedRowsForSource` | 3 |
| `cloneStatementServiceState` | 3 |
| `generationConfigFromTemplate` | 3 |
| `identifyAccountBlocks` | 3 |
| `provisionalDigest` | 3 |
| `selectionRows` | 3 |
| `sourceChanged` | 3 |
| `templateCatalogByRef` | 3 |

### `src/main-process/statement-worker/source-identity.js`

| 名字 | 总次数 |
|---|---:|
| `statInteger` | 5 |
| `regularFileStat` | 4 |
| `SOURCE_IDENTITY_VERSION` | 4 |
| `addIdentity` | 3 |
| `fileIdKey` | 3 |
| `StatementSourceIdentityError` | 3 |
| `streamSha256` | 3 |

### `src/main-process/statement-worker/staging-ownership.js`

| 名字 | 总次数 |
|---|---:|
| `isStrictDescendant` | 6 |
| `readLstat` | 5 |
| `isMissing` | 3 |
| `StatementStagingOwnershipError` | 3 |

### `src/main-process/statement-worker/state-footprint.js`

| 名字 | 总次数 |
|---|---:|
| `addChecked` | 13 |
| `estimateStatementValueBytes` | 8 |
| `PAGE_BYTES` | 5 |
| `assertNoOwnState` | 4 |
| `estimateStatementFootprint` | 4 |
| `stringBytes` | 4 |
| `assertDataDescriptor` | 3 |
| `HEADROOM_DENOMINATOR` | 3 |
| `HEADROOM_NUMERATOR` | 3 |
| `PROPERTY_SLOT_BYTES` | 3 |
| `roundStatementReservationBytes` | 3 |
| `StatementStateFootprintError` | 3 |

### `src/main-process/statement-worker/token-store.js`

| 名字 | 总次数 |
|---|---:|
| `hasExactKeys` | 4 |
| `StatementTokenStoreError` | 3 |

### `src/main-process/statement-worker/waiting-user-coordinator.js`

| 名字 | 总次数 |
|---|---:|
| `TOKEN_KEYS` | 5 |
| `StatementWaitingUserError` | 4 |
| `CLEANUP_RECEIPT_KEYS` | 3 |
| `TERMINAL_FORGET_KEYS` | 3 |

### `src/main-process/statement-worker/worker-entry.js`

| 名字 | 总次数 |
|---|---:|
| `statementSourceRoot` | 9 |
| `generationSafepointDelayMs` | 7 |
| `adoptionGrantOrdinal` | 4 |
| `failAfterGrantOrdinal` | 4 |
| `failBeforeAdoptOrdinal` | 4 |
| `statementBalanceTemplatePath` | 4 |
| `statementStagingRoot` | 4 |
| `statementStorageRoot` | 4 |
| `withholdAdoptOrdinal` | 4 |
| `candidateOrdinal` | 3 |

### `src/main-process/table-type-detector.js`

| 名字 | 总次数 |
|---|---:|
| `isHeaderNotMatchedError` | 3 |
| `L2_HEADER_SCAN_ROWS` | 3 |
| `SHORT_TABLE_COLUMN_THRESHOLD` | 3 |
| `statusForMatchedKey` | 3 |

### `src/main-process/toolbox-archive-recovery.js`

| 名字 | 总次数 |
|---|---:|
| `toolboxRecoveryInputFiles` | 4 |
| `expectedArtifactIdentity` | 3 |

### `src/main-process/toolbox-background/generation-contract.js`

| 名字 | 总次数 |
|---|---:|
| `normalizeGeneration` | 3 |
| `normalizeWarningSummary` | 3 |
| `STYLE_COUNT_KEYS` | 3 |
| `validStyleStats` | 3 |

### `src/main-process/toolbox-background/generation-core.js`

| 名字 | 总次数 |
|---|---:|
| `generationError` | 7 |
| `cancelTokenFor` | 3 |
| `writeGenerationEvidence` | 3 |

### `src/main-process/toolbox-background/generation-validator.js`

| 名字 | 总次数 |
|---|---:|
| `validateGeneratedArtifact` | 3 |

### `src/main-process/toolbox-background/multi-output-validator.js`

| 名字 | 总次数 |
|---|---:|
| `createMultiGenerationInput` | 3 |
| `validateMultiGenerationResult` | 3 |

### `src/main-process/toolbox-background/policies.js`

| 名字 | 总次数 |
|---|---:|
| `toolboxGenerationPolicy` | 4 |
| `ROUTE_WRITER_RESOURCES` | 3 |
| `toolboxMultiOutputPolicy` | 3 |

### `src/main-process/toolbox-background/route-db-contract.js`

| 名字 | 总次数 |
|---|---:|
| `decodeEnvelope` | 4 |
| `ROUTE_DB_MAX_OUTPUTS` | 4 |
| `compactRow` | 3 |
| `compactStyleRef` | 3 |
| `expandRow` | 3 |
| `expandStyleRef` | 3 |
| `readRouteManifest` | 3 |

### `src/main-process/toolbox-background/route-db-sealer.js`

| 名字 | 总次数 |
|---|---:|
| `removeRouteFiles` | 4 |
| `writeSealedManifest` | 3 |

### `src/main-process/toolbox-background/route-scanner-core.js`

| 名字 | 总次数 |
|---|---:|
| `runOutputWriter` | 3 |

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
| `normalizeSplitEmptyError` | 6 |
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
| `defaultDispatcher` | 4 |
| `runWorkerJob` | 4 |
| `createRecoveryFailure` | 3 |
| `createToolboxPublicationDispatcher` | 3 |

### `src/main-process/toolbox-output-publication-worker.js`

| 名字 | 总次数 |
|---|---:|
| `runPublicationOperation` | 3 |

### `src/main-process/toolbox-output-publication.js`

| 名字 | 总次数 |
|---|---:|
| `ToolboxPublicationError` | 50 |
| `messageOf` | 41 |
| `ToolboxPublicationManualRecoveryError` | 41 |
| `lstatOrNull` | 22 |
| `assertJournalTargetParentsOrManual` | 18 |
| `callCheckpoint` | 18 |
| `releaseReservations` | 16 |
| `getIndexPath` | 15 |
| `collectRecoveryPaths` | 13 |
| `assertExpectedTargetParentIdentity` | 11 |
| `assertJournalTargetParentIdentities` | 11 |
| `persistJournal` | 11 |
| `fileMatches` | 10 |
| `assertIndexTargetParentsOrManual` | 8 |
| `INDEX_DISCOVERY_PREPARED` | 8 |
| `isTargetParentIdentityFailure` | 8 |
| `normalizeArchiveInputFiles` | 8 |
| `readIndex` | 8 |
| `buildPublishFiles` | 7 |
| `cloneJsonValue` | 7 |
| `removeKnownFile` | 7 |
| `targetReservations` | 7 |
| `INDEX_DISCOVERY_PREPARING` | 6 |
| `removeIndexEntry` | 6 |
| `activeTaskIds` | 5 |
| `cancelPrepared` | 5 |
| `createRuntime` | 5 |
| `extractPath` | 5 |
| `JOURNAL_VERSION` | 5 |
| `throwTargetParentManualRecovery` | 5 |
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
| `pathAliasIsWithinDirectory` | 4 |
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
| `directoryIdentitiesOverlap` | 3 |
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
| `realpathSyncWith` | 5 |
| `existingPathAliasKey` | 4 |
| `pathAliasKeys` | 4 |
| `windowsSimpleUppercaseIdentity` | 4 |
| `TargetIdentityError` | 3 |

### `src/main-process/toolbox.js`

| 名字 | 总次数 |
|---|---:|
| `formatTimestamp12` | 4 |
| `SPLIT_VALUE_MAX_LEN` | 4 |
| `SPLIT_VALUE_SEPARATOR` | 3 |

### `src/main-process/vcc-financial-op-archive-lineage.js`

| 名字 | 总次数 |
|---|---:|
| `activeReferenceCounts` | 8 |
| `VCC_IMPORT_SOURCE_OPERATION` | 7 |
| `VCC_ARCHIVE_MODULE_ID` | 6 |
| `vccRepository` | 5 |
| `holdIdentity` | 4 |
| `markSourceFailure` | 4 |
| `VCC_IMPORT_HOLD_TYPE` | 4 |
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
| `invalidSystemLineage` | 10 |
| `EXPORT_KINDS` | 7 |
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

### `src/main-process/vcc-financial-op-output/artifact-evidence.js`

| 名字 | 总次数 |
|---|---:|
| `normalizeStyle` | 10 |
| `pendingSheetProjection` | 4 |

### `src/main-process/vcc-financial-op-output/dispatch.js`

| 名字 | 总次数 |
|---|---:|
| `dispatchError` | 37 |
| `cleanupGenerationArtifacts` | 6 |
| `freezeTaskAuthority` | 5 |
| `isTaskPrivatePath` | 5 |
| `VCC_EXPORT_RECOVERY_PATH_LIMIT` | 5 |
| `VCC_EXPORT_SOURCE_OPERATION` | 5 |
| `preserveUnconfirmedTaskDirectory` | 4 |
| `publishCleanupRecovery` | 4 |
| `VCC_EXPORT_CLEANUP_DIAGNOSTIC_LIMIT` | 4 |
| `appendCleanupDiagnostics` | 3 |
| `assertTaskAuthorityEqual` | 3 |
| `freezeBatchAuthority` | 3 |
| `selectedIndexesForAction` | 3 |
| `validateJoin` | 3 |

### `src/main-process/vcc-financial-op-output/policies.js`

| 名字 | 总次数 |
|---|---:|
| `allowVccExportFinanceSafeValue` | 3 |
| `validateVccExportResult` | 3 |
| `VCC_EXPORT_SINGLE_ENTRY_KEY` | 3 |
| `VCC_EXPORT_SINGLE_RESULT_VALIDATOR_KEY` | 3 |
| `VCC_EXPORT_SUBJECTS_ENTRY_KEY` | 3 |
| `VCC_EXPORT_SUBJECTS_RESULT_VALIDATOR_KEY` | 3 |
| `WRITER_RESOURCES` | 3 |

### `src/main-process/vcc-financial-op-output/shard-planner.js`

| 名字 | 总次数 |
|---|---:|
| `shardError` | 7 |

### `src/main-process/vcc-financial-op-output/staging-identity.js`

| 名字 | 总次数 |
|---|---:|
| `STAGING_IDENTITY_CONTRACT_VERSION` | 5 |
| `isDirectChild` | 3 |
| `PROVISIONAL_STAGING_IDENTITY_CONTRACT_VERSION` | 3 |

### `src/main-process/vcc-financial-op-output/subject-evidence.js`

| 名字 | 总次数 |
|---|---:|
| `pendingSummaryProjection` | 3 |
| `pendingTotalsProjection` | 3 |

### `src/main-process/vcc-financial-op-output/writer-coordinator.js`

| 名字 | 总次数 |
|---|---:|
| `safeTerminate` | 4 |
| `mergeVccExportShardResults` | 3 |
| `normalizeAdmittedTopology` | 3 |
| `runVccExportShardWorker` | 3 |
| `shardInput` | 3 |

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
| `invalidWriteAction` | 3 |
| `WRITE_ACTIONS` | 3 |

### `src/main-process/vcc-op-calc-session.js`

| 名字 | 总次数 |
|---|---:|
| `VccComputeSnapshotError` | 3 |

### `src/main-process/vcc-op-calc/ordered-reducer.js`

| 名字 | 总次数 |
|---|---:|
| `assertSafeNonNegativeInteger` | 4 |
| `assertSortedUniqueStrings` | 3 |
| `buildParserInputEvidenceHash` | 3 |
| `COMPUTE_SNAPSHOT_CONTRACT_VERSION` | 3 |
| `exactJsonEqual` | 3 |
| `INPUT_EVIDENCE_PROJECTION_VERSION` | 3 |
| `parserInputEvidenceProjection` | 3 |
| `safeSubtract` | 3 |
| `validateUnitResult` | 3 |
| `VccOrderedReducerError` | 3 |

### `src/main-process/vcc-op-calc/parser-core.js`

| 名字 | 总次数 |
|---|---:|
| `PARSER_INPUT_KEYS` | 3 |
| `PARSER_SEMANTIC_PROJECTION_VERSION` | 3 |
| `parserSemanticProjection` | 3 |
| `readStat` | 3 |
| `VccParserContractError` | 3 |

### `src/main-process/vcc-op-calc/parser-pipeline.js`

| 名字 | 总次数 |
|---|---:|
| `VccParserPipelineError` | 8 |
| `EFFECTIVE_PARSER_WORKER_COUNT` | 4 |
| `MAX_REQUESTED_PARSER_WORKER_COUNT` | 4 |
| `buildParserUnits` | 3 |
| `PARSER_WORKER_PATH` | 3 |
| `resolveEffectiveWorkerCount` | 3 |

### `src/main-process/vcc-op-calc/parser-worker.js`

| 名字 | 总次数 |
|---|---:|
| `serializeWorkerError` | 3 |

### `src/main-process/vcc-op-calc/save-run-contract.js`

| 名字 | 总次数 |
|---|---:|
| `normalizeCanonicalAmount` | 15 |
| `addSafeCents` | 8 |
| `subtractSafeCents` | 5 |
| `validateExpectedIdentity` | 4 |
| `VCC_COMPUTE_SNAPSHOT_HASH_VERSION` | 4 |
| `hashVccOpComputeSnapshot` | 3 |
| `validateComputeSnapshot` | 3 |
| `VCC_OP_SAVE_RUN_MODULE_ID` | 3 |
| `VCC_OP_SAVE_RUN_TASK_KEY` | 3 |
| `YEAR_MONTH_PATTERN` | 3 |

### `src/main-process/vcc-op-calc/save-run-inspector.js`

| 名字 | 总次数 |
|---|---:|
| `inspectVccOpSaveRunOutcome` | 3 |
| `VCC_OP_SAVE_RUN_INSPECTOR_KEY` | 3 |

### `src/main-process/vcc-op-calc/save-run-lifecycle.js`

| 名字 | 总次数 |
|---|---:|
| `VCC_OP_SAVE_RUN_RECOVERY_REQUIRED_STATUS` | 3 |
| `vccOpSaveRunRecoveryRequiredResult` | 3 |

### `src/main.js`

| 名字 | 总次数 |
|---|---:|
| `acquiringBillCurrencyOperationLock` | 9 |
| `archiveCenterService` | 8 |
| `mainWindow` | 8 |
| `statementSourceFreshnessError` | 7 |
| `bankStatementOperationLock` | 6 |
| `packagedRuntimeModeSelected` | 6 |
| `pendingDb` | 6 |
| `STATEMENT_SOURCE_FRESHNESS_FAILURE` | 6 |
| `reconFixJpmHoldGate` | 5 |
| `backgroundExecutionRuntimeManager` | 4 |
| `cleanupReadOnlyExportStagingDirectory` | 4 |
| `createReadOnlyExportGenerationPlan` | 4 |
| `createReadOnlyExportStagingDirectory` | 4 |
| `vccFinancialOpService` | 4 |
| `packagedRuntimeRequest` | 3 |
| `packagedRuntimeRequestError` | 3 |
| `publishReadOnlyExportArtifacts` | 3 |
| `requireSingleInstanceLock` | 3 |
| `startupMetrics` | 3 |
| `statementSourceReadContext` | 3 |

### `src/preload.js`

| 名字 | 总次数 |
|---|---:|
| `ipcRenderer` | 290 |
| `contextBridge` | 3 |

### `src/renderer.js`

| 名字 | 总次数 |
|---|---:|
| `getNewAccountRowElements` | 19 |
| `getNewAccountRows` | 19 |
| `archiveCenterErrorText` | 16 |
| `updateStatusBox` | 16 |
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
| `path` | 231 | 1555 | 205 | src/main-process/toolbox-output-publication.js(72), src/main-process/background-execution/schema-validator.js(46), src/main-process/position-reconciliation/input-staging.js(42) |
| `db` | 163 | 5501 | 1 | src/backend/database/migrations.js(512), src/backend/database/archive-repository.js(249), src/backend/database.js(233) |
| `fs` | 157 | 992 | 156 | src/main-process/archive-center/storage-root-manager.js(75), src/main-process/archive-center/archive-service.js(61), src/main-process/manual-balance-seed-settlement.js(36) |
| `run` | 129 | 1476 | 3 | src/main-process/position-reconciliation/store.js(89), src/backend/database/archive-repository.js(88), src/main-process/bank-bu-worker/export-operation.js(69) |
| `rowCount` | 112 | 580 | 1 | src/backend/database/linked-table-repository.js(36), src/main-process/duplicate-inbound-match/service.js(33), src/renderer-position-reconciliation.js(25) |
| `sha256` | 108 | 506 | 7 | src/main-process/archive-center/archive-service.js(50), src/main-process/position-reconciliation/operation-lifecycle.js(27), src/main-process/toolbox-output-publication.js(21) |
| `crypto` | 93 | 271 | 93 | src/main-process/archive-center/archive-service.js(11), src/main-process/position-reconciliation/service.js(8), src/main-process/pre-fund-reconciliation/service.js(8) |
| `parse` | 91 | 165 | 1 | src/backend/database/linked-table-repository.js(12), src/backend/database/migrations.js(11), src/backend/vcc-financial-op/calculator.js(6) |
| `digest` | 89 | 215 | 5 | src/main-process/statement-worker/artifact-descriptor.js(11), src/main-process/read-only-exports/vcc-financial-op/actions.js(10), src/main-process/archive-center/archive-service.js(9) |
| `state` | 80 | 1258 | 1 | src/renderer.js(216), src/main-process/recon-id-fix-service/service.js(98), src/backend/vcc-financial-op/dataset-deletion.js(59) |
| `createHash` | 77 | 124 | 10 | src/main-process/archive-center/archive-service.js(6), src/main-process/new-account/artifact-copy.js(4), src/main-process/statement-worker/artifact-descriptor.js(4) |
| `monthKey` | 65 | 892 | 1 | src/main-process/acquiring-bill-currency-run-data.js(97), src/main-process/duplicate-inbound-match/service.js(70), src/main-process/acquiring-bill-currency-session.js(65) |
| `startsWith` | 64 | 124 | 1 | src/main-process/archive-center/task-policy-registry.js(7), src/backend/file-service.js(6), src/main-process/archive-center/archive-service.js(6) |
| `text` | 60 | 819 | 7 | src/main-process/position-reconciliation/store.js(150), src/main-process/position-reconciliation/service.js(66), src/renderer.js(63) |
| `randomUUID` | 57 | 120 | 20 | src/main-process/position-reconciliation/service.js(7), src/main-process/toolbox-output-publication.js(6), src/main-process/archive-center/storage-root-manager.js(5) |
| `channel` | 52 | 519 | 1 | src/main-process/archive-center/task-lifecycle.js(92), src/main-process/archive-center/task-policy-registry.js(50), src/main-process/position-reconciliation/store.js(46) |
| `DatabaseSync` | 52 | 135 | 47 | src/main-process/acquiring-bill-currency-run-data.js(7), src/main-process/run-check-multiworker-worker.js(6), src/main-process/bank-bu-worker/export-operation.js(5) |
| `canonicalSha256` | 50 | 228 | 37 | src/main-process/read-only-exports/acquiring/query.js(17), src/main-process/background-execution/startup-recovery-coordinator.js(13), src/main-process/duplicate-inbound-match/startup-recovery.js(12) |
| `artifact` | 46 | 986 | 1 | src/main-process/archive-center/archive-service.js(177), src/backend/database/archive-repository.js(114), src/main-process/toolbox-background/generation-contract.js(55) |
| `sourceSnapshot` | 40 | 197 | 2 | src/main-process/position-reconciliation/operation-lifecycle.js(30), src/main-process/archive-center/archive-service.js(20), src/main-process/position-reconciliation/side-db-mutation.js(13) |
| `fail` | 39 | 1047 | 29 | src/backend/toolbox-format/biff8-records.js(127), src/main-process/new-account/strict-worksheet-readback.js(80), src/main-process/recon-id-fix-service/service.js(72) |
| `list` | 39 | 186 | 1 | src/renderer-dialogs.js(43), src/renderer.js(43), src/preload.js(7) |
| `service` | 38 | 253 | 2 | src/main-process/archive-center/controller.js(58), src/main.js(23), src/main-process/recon-id-fix-service/worker-entry.js(20) |
| `normalizeCell` | 38 | 220 | 20 | src/backend/file-service.js(34), src/main-process/manual-balance-seed-preflight.js(21), src/main-process/statement-generation-business.js(17) |
| `cancel` | 35 | 116 | 1 | src/renderer-position-reconciliation.js(24), src/renderer-vcc-financial-op.js(18), src/main-process/background-execution/adapters/existing-dispatch-adapter.js(7) |
| `SOURCE_TYPES` | 34 | 330 | 6 | src/main-process/position-reconciliation/constants.js(38), src/backend/position-reconciliation-import/account-writer.js(18), src/main-process/vcc-financial-op-dataset-writer.js(18) |
| `canonicalJsonSnapshot` | 33 | 135 | 14 | src/main-process/statement-worker/contracts.js(13), src/main-process/background-execution/supervisor.js(12), src/main-process/statement-worker/import-contracts.js(11) |
| `exactKeys` | 32 | 151 | 26 | src/main-process/recon-id-fix-service/policies.js(14), src/main-process/background-execution/acquiring-adapter-policies.js(9), src/main-process/duplicate-inbound-match/spool-reader.js(9) |
| `FileValidationError` | 31 | 162 | 20 | src/main-process/statement-generation-business.js(20), src/backend/file-service/readers.js(15), src/main-process/duplicate-inbound-match/document-statement-reader.js(10) |
| `errorCode` | 31 | 116 | 1 | src/main-process/new-account/strict-worksheet-readback.js(23), src/main-process/background-execution/startup-recovery-coordinator.js(17), src/backend/biz-op-recon-import/reader-streamed.js(12) |
| `policy` | 29 | 582 | 1 | src/main-process/archive-center/task-lifecycle.js(105), src/main-process/background-execution/runtime.js(102), src/main-process/background-execution/supervisor.js(84) |
| `contentHash` | 29 | 157 | 1 | src/backend/pre-fund-reconciliation-store.js(16), src/backend/vcc-financial-op/system-op-importer.js(12), src/backend/position-reconciliation-import/preflight.js(11) |
| `finish` | 28 | 174 | 2 | src/backend/toolbox-format/xlsx-pass.js(26), src/main-process/background-execution/supervisor.js(21), src/main-process/vcc-financial-op-service.js(12) |
| `parentPort` | 28 | 157 | 27 | src/main-process/run-check-worker.js(10), src/main-process/vcc-financial-op-storage-migration-worker.js(9), src/main-process/vcc-financial-op-write-worker.js(9) |
| `XLSX` | 27 | 135 | 27 | src/backend/file-service/writers.js(20), src/main-process/statement-worker/artifact-descriptor.js(18), src/backend/pending-export/writer.js(9) |
| `sideDbPath` | 27 | 110 | 1 | src/backend/position-reconciliation-import/maintenance-writer.js(12), src/backend/position-reconciliation-import/worker-entry.js(12), src/backend/duplicate-inbound-match-store.js(11) |
| `workerData` | 25 | 106 | 14 | src/main-process/statement-worker/worker-entry.js(28), src/main-process/new-account/worker-entry.js(13), src/main-process/background-execution/canary/durable-worker.js(11) |
| `freezeWorkerBatchContext` | 25 | 61 | 7 | src/main-process/toolbox-output-publication.js(7), src/main-process/archive-center/worker-operation-context.js(4), src/backend/acquiring-bill-currency-db/run-repository.js(3) |
| `emit` | 24 | 158 | 6 | src/main-process/pre-fund-reconciliation/mpt-import/single-writer-session.js(15), src/backend/pending-import/worker.js(10), src/main-process/bank-bu-worker/worker-host.js(10) |
| `sourceSnapshotMatchesStat` | 24 | 72 | 4 | src/main-process/archive-center/archive-service.js(7), src/main-process/position-reconciliation/input-staging.js(6), src/main-process/new-account/artifact-copy.js(5) |
| `normalize` | 24 | 49 | 1 | src/backend/toolbox-format/xlsx-pass.js(5), src/backend/pre-fund-reconciliation-store.js(4), src/main-process/statement-worker/artifact-descriptor.js(4) |
| `normalizeCellValue` | 23 | 304 | 12 | src/main-process/scenario-engines/r5-refund-order-backfill.js(57), src/main-process/position-reconciliation/matching-engine.js(39), src/main-process/scenario-engines/r5-payment-offline-allocation-backfill.js(22) |
| `inspection` | 23 | 286 | 2 | src/main-process/vcc-financial-op-dataset-writer.js(45), src/main-process/background-execution/startup-recovery-coordinator.js(43), src/main-process/manual-balance-seed-settlement.js(43) |
| `terminal` | 22 | 176 | 4 | src/main-process/background-execution/supervisor.js(28), src/main-process/duplicate-inbound-match/parser-outcome.js(14), src/main-process/recon-id-fix-service/worker-entry.js(14) |
| `session` | 20 | 356 | 4 | src/main-process/bank-bu-worker/main-coordinator.js(96), src/main-process/statement-worker/probe-state-builder.js(53), src/main-process/statement-worker/session-state.js(43) |
| `runDataStore` | 20 | 227 | 20 | src/main-process/biz-op-recon-run-data.js(52), src/backend/duplicate-inbound-match-store.js(38), src/backend/pre-fund-reconciliation-store.js(23) |
| `pad` | 20 | 106 | 5 | src/main-process/bank-statement-io.js(14), src/backend/logger.js(11), src/main-process/biz-op-recon-session.js(10) |
| `BANK_STATEMENT_FIELDS` | 20 | 63 | 15 | src/main-process/duplicate-inbound-match/excel-writer.js(11), src/renderer-dialogs.js(9), src/main-process/position-reconciliation/readers.js(4) |
| `sourceSnapshotFromStat` | 20 | 59 | 3 | src/main-process/archive-center/archive-service.js(8), src/main-process/new-account/artifact-copy.js(5), src/main-process/position-reconciliation/input-staging.js(5) |
| `ExcelJS` | 20 | 53 | 20 | src/main-process/vcc-financial-op-output/artifact-evidence.js(6), src/main-process/biz-op-recon-writer.js(5), src/main-process/duplicate-inbound-match/excel-writer.js(5) |
| `active` | 19 | 249 | 1 | src/backend/position-reconciliation-import/worker-entry.js(96), src/main-process/position-reconciliation/service.js(46), src/main-process/pre-fund-reconciliation/mpt-import/single-writer-session.js(18) |
| `PositionReconciliationError` | 19 | 212 | 1 | src/main-process/position-reconciliation/service.js(41), src/main-process/position-reconciliation/store.js(39), src/main-process/position-reconciliation/side-db-mutation.js(25) |
| `sideDbRelPath` | 19 | 92 | 1 | src/main-process/duplicate-inbound-match/service.js(12), src/main-process/biz-op-recon-run-data.js(10), src/main-process/read-only-exports/pre-fund/query.js(10) |
| `normalizeSourceSnapshot` | 19 | 60 | 7 | src/main-process/position-reconciliation/operation-lifecycle.js(7), src/main-process/archive-center/archive-service.js(5), src/main-process/archive-center/source-snapshot.js(5) |
| `repository` | 18 | 255 | 7 | src/main-process/archive-center/archive-service.js(124), src/backend/vcc-financial-op/detail-importer.js(26), src/main-process/archive-center/controller.js(21) |
| `Worker` | 18 | 37 | 17 | src/main-process/vcc-financial-op-service.js(4), src/backend/big-table-import/pipeline.js(2), src/main-process/acquiring-bill-currency-session.js(2) |
| `absolutePath` | 17 | 71 | 5 | src/main-process/new-account/artifact-copy.js(8), src/main-process/toolbox-background/generation-contract.js(6), src/main-process/read-only-exports/acquiring/actions.js(5) |
| `stableHash` | 17 | 69 | 4 | src/backend/position-reconciliation-import/source-writer.js(16), src/main-process/pre-fund-reconciliation/service.js(8), src/main-process/position-reconciliation/store.js(6) |
| `toProtocolError` | 17 | 58 | 17 | src/main-process/background-execution/supervisor.js(11), src/main-process/recon-id-fix-service/worker-entry.js(7), src/main-process/duplicate-inbound-match/worker-host.js(5) |
| `spoolError` | 16 | 200 | 6 | src/main-process/pre-fund-reconciliation/mpt-import/spool-reader.js(46), src/main-process/duplicate-inbound-match/spool-reader.js(23), src/main-process/bank-bu-worker/spool-reader.js(19) |
| `columnName` | 16 | 45 | 1 | src/backend/vcc-financial-op-db/migrations.js(12), src/backend/database/archive-repository.js(3), src/backend/pending-db/migrations.js(3) |
| `validateTaskOwnedStagingPath` | 16 | 45 | 8 | src/main-process/new-account/artifact-copy.js(7), src/main-process/read-only-exports/acquiring/executor.js(5), src/main-process/statement-worker/generation.js(5) |
| `freezeWorkerOperationContext` | 16 | 33 | 5 | src/main-process/archive-center/worker-operation-context.js(3), src/backend/position-reconciliation-import/worker-entry.js(2), src/backend/vcc-financial-op/worker-entry.js(2) |
| `MAX_SAFE_INTEGER` | 16 | 27 | 1 | src/main-process/scenario-engines/c4-recon-id-fix.js(4), src/main-process/pre-fund-reconciliation/mpt-import/spool-admission.js(3), src/main-process/background-execution/canonical-json-v1.js(2) |
| `appendModuleLog` | 15 | 77 | 11 | src/backend/database.js(23), src/main-process/acquiring-bill-currency-session.js(13), src/backend/database/migrations.js(8) |
| `SOURCE_DEFINITIONS` | 15 | 50 | 2 | src/main-process/position-reconciliation/store.js(6), src/main-process/position-reconciliation/readers.js(5), src/backend/position-reconciliation-import/preflight.js(4) |
| `open` | 15 | 39 | 1 | src/backend/pre-fund-reconciliation-run-store.js(10), src/main-process/duplicate-inbound-match/mirror-database.js(7), src/renderer.js(4) |
| `createDirectionSequenceTracker` | 15 | 35 | 10 | src/main-process/background-execution/service-host.js(3), src/main-process/background-execution/supervisor.js(3), src/main-process/duplicate-inbound-match/worker-host.js(3) |
| `makeWarningCollector` | 15 | 30 | 4 | src/main-process/scenario-engines/boc-dispatch-order-fix.js(2), src/main-process/scenario-engines/c1-extract-recon-id.js(2), src/main-process/scenario-engines/c2-offset-bill-mark.js(2) |
| `transition` | 14 | 331 | 1 | src/main-process/background-execution/critical/recovery-control-repository.js(118), src/main-process/background-execution/recovery-control-contract.js(59), src/main-process/background-execution/startup-recovery-coordinator.js(55) |
| `assertNotCancelled` | 14 | 80 | 9 | src/main-process/new-account/strict-worksheet-readback.js(8), src/main-process/statement-worker/session-state.js(8), src/backend/toolbox-format/csv-pass.js(7) |
| `checkpoint` | 14 | 67 | 1 | src/main-process/background-execution/adapters/position-import-adapter.js(10), src/main-process/vcc-financial-op-storage-rebuild.js(10), src/main-process/new-account/artifact-copy.js(8) |
| `assertDatabase` | 14 | 49 | 14 | src/backend/vcc-financial-op-db/storage-contract.js(9), src/main-process/duplicate-inbound-match/operation-receipt-repository.js(5), src/backend/database/recon-fix-operation-receipt-repository.js(4) |
| `FLOW_HEADERS` | 14 | 35 | 8 | src/backend/acquiring-bill-currency-db/columns.js(6), src/backend/vcc-op-calc-import/validator.js(4), src/backend/acquiring-bill-currency-import/reader.js(3) |
| `validateHeaders` | 14 | 34 | 3 | src/backend/biz-op-recon-import/reader-streamed.js(7), src/backend/acquiring-bill-currency-import/reader.js(4), src/backend/bank-bu-recon-import/reader.js(4) |
| `applyWatermark` | 14 | 32 | 14 | src/main-process/biz-op-recon-writer.js(5), src/backend/file-service/writers.js(3), src/backend/pending-export/writer.js(3) |
| `SUPPORTED_CURRENCIES` | 13 | 63 | 4 | src/main-process/vcc-financial-op-dataset-writer.js(13), src/backend/vcc-financial-op/result-adjustments.js(9), src/backend/vcc-financial-op/system-op-importer.js(6) |
| `placeholders` | 13 | 57 | 2 | src/main-process/position-reconciliation/store.js(20), src/backend/database/linked-table-repository.js(7), src/backend/database/template-repository.js(6) |
| `sourceIdentity` | 13 | 51 | 1 | src/backend/database/linked-table-repository.js(11), src/main-process/statement-worker/session-state.js(9), src/main-process/statement-worker/source-identity.js(6) |
| `isDeepStrictEqual` | 13 | 41 | 13 | src/main-process/background-execution/protocol-sequence-validator.js(5), src/main-process/background-execution/service-host.js(5), src/main-process/bank-bu-worker/main-coordinator.js(5) |
| `SOURCE_LABELS` | 13 | 41 | 3 | src/backend/vcc-financial-op/calculator.js(5), src/backend/vcc-financial-op/detail-importer.js(5), src/main-process/vcc-financial-op-service.js(5) |
| `normalizeSource` | 13 | 34 | 10 | src/main-process/toolbox-background/generation-contract.js(4), src/main-process/duplicate-inbound-match/spool-contract.js(3), src/main-process/read-only-exports/biz-op/actions.js(3) |
| `getOperationReceipt` | 13 | 32 | 4 | src/backend/database/recon-fix-operation-receipt-repository.js(5), src/backend/duplicate-inbound-match-store.js(3), src/main-process/bank-bu-worker/operation-receipt-repository.js(3) |
| `pathsAlias` | 13 | 30 | 8 | src/main-process/recon-id-fix-service/export-operation.js(4), src/main-process/new-account/generation-validator.js(3), src/main-process/toolbox-background/multi-output-validator.js(3) |
| `validateEnvelope` | 13 | 30 | 9 | src/main-process/background-execution/protocol-validator.js(5), src/main-process/background-execution/protocol.js(3), src/main-process/background-execution/canary/pure-compute-worker.js(2) |
| `createCanonicalEventEmitter` | 13 | 28 | 7 | src/main-process/duplicate-inbound-match/worker-host.js(3), src/main-process/recon-id-fix-service/worker-entry.js(3), src/main-process/background-execution/adapters/canonical-event-emitter.js(2) |
| `getRun` | 13 | 27 | 2 | src/main-process/position-reconciliation/store.js(7), src/main-process/bank-bu-recon-session.js(4), src/backend/bank-bu-recon-db/run-repository.js(2) |
| `fromProtocolError` | 13 | 26 | 13 | src/main-process/background-execution/error-codec.js(2), src/main-process/read-only-exports/acquiring/managed-export.js(2), src/main-process/read-only-exports/biz-op/managed-export.js(2) |
| `readOwnedArtifactEvidence` | 13 | 26 | 13 | src/main-process/read-only-exports/acquiring/business-validator.js(2), src/main-process/read-only-exports/acquiring/executor.js(2), src/main-process/read-only-exports/biz-op/business-validator.js(2) |
| `readWorkbookBusinessEvidence` | 13 | 26 | 13 | src/main-process/read-only-exports/acquiring/business-validator.js(2), src/main-process/read-only-exports/acquiring/executor.js(2), src/main-process/read-only-exports/biz-op/business-validator.js(2) |
| `validationError` | 12 | 101 | 9 | src/main-process/toolbox-background/generation-validator.js(18), src/main-process/pre-fund-reconciliation/mpt-schema.js(17), src/main-process/toolbox-background/multi-output-validator.js(16) |
| `warningSummary` | 12 | 77 | 1 | src/main-process/statement-worker/generation-contracts.js(19), src/main-process/statement-worker/artifact-descriptor.js(18), src/main-process/statement-worker/generation.js(9) |
| `numeric` | 12 | 59 | 1 | src/backend/toolbox-format/style-registry.js(13), src/backend/position-reconciliation-import/xlsx-reader.js(6), src/backend/toolbox-format/number-date.js(6) |
| `serializeError` | 12 | 49 | 7 | src/main-process/run-check-worker.js(7), src/main-process/run-check-multiworker-worker.js(6), src/backend/big-table-import/engine-worker-entry.js(5) |
| `parseNumber` | 12 | 43 | 4 | src/main-process/scenario-engines/c3-gateway-recon-join.js(6), src/main-process/scenario-engines/r5-fund-transfer-backfill.js(6), src/main-process/scenario-engines/r5-refund-order-backfill.js(6) |
| `hex` | 12 | 36 | 1 | src/backend/toolbox-format/biff8-records.js(23), src/backend/toolbox-format/excel-text.js(2), src/main-process/new-account/strict-worksheet-readback.js(2) |
| `safeError` | 12 | 30 | 3 | src/main-process/background-execution/supervisor.js(7), src/main-process/background-execution/startup-recovery-coordinator.js(3), src/main-process/bank-bu-worker/worker-host.js(3) |
| `openZipWithEntries` | 12 | 25 | 2 | src/backend/acquiring-bill-currency-import/reader.js(4), src/backend/toolbox-xlsx-stream/multi-sheet-reader.js(3), src/main-process/duplicate-inbound-match/document-statement-reader.js(3) |
| `RUNS_TABLE` | 11 | 89 | 10 | src/backend/biz-op-recon-db/run-repository.js(19), src/backend/acquiring-bill-currency-db/run-repository.js(15), src/main-process/acquiring-bill-currency-run-data.js(10) |
| `remove` | 11 | 83 | 1 | src/renderer-dialogs.js(42), src/renderer-position-reconciliation.js(19), src/renderer.js(6) |
| `requireText` | 11 | 80 | 11 | src/backend/database/duplicate-inbound-match-run-repository.js(15), src/main-process/background-execution/recovery-hold-request.js(10), src/main-process/pre-fund-reconciliation/mpt-import/operation-receipt-repository.js(10) |
| `fsyncDirectory` | 11 | 66 | 8 | src/main-process/vcc-financial-op-storage-rebuild.js(16), src/main-process/toolbox-output-publication.js(13), src/main-process/manual-balance-seed-settlement.js(8) |
| `abortController` | 11 | 62 | 4 | src/main-process/background-execution/service-host.js(11), src/main-process/new-account/worker-entry.js(7), src/main-process/background-execution/adapters/inline-async-adapter.js(6) |
| `rowHash` | 11 | 57 | 1 | src/backend/position-reconciliation-import/source-writer.js(14), src/main-process/position-reconciliation/readers.js(10), src/main-process/position-reconciliation/store.js(7) |
| `throwIfCancelled` | 11 | 56 | 8 | src/main-process/read-only-exports/acquiring/executor.js(10), src/backend/vcc-financial-op/detail-importer.js(7), src/main-process/read-only-exports/pending/writer.js(7) |
| `PENDING_COLUMNS` | 11 | 40 | 11 | src/backend/pending-export/writer.js(6), src/backend/pending-import/contract-pending.js(6), src/backend/pending-import/validator.js(6) |
| `sha256File` | 11 | 32 | 10 | src/main-process/bank-bu-worker/import-operation.js(5), src/main-process/bank-bu-worker/spool-writer.js(4), src/main-process/statement-worker/generation.js(4) |
| `TOOLBOX_GENERATION_ACTIONS` | 11 | 31 | 5 | src/main-process/toolbox-background/generation-contract.js(5), src/main-process/toolbox-background/policies.js(5), src/main-process/background-execution/runtime.js(4) |
| `isRowMeaningful` | 11 | 30 | 2 | src/backend/file-service/readers.js(6), src/main-process/toolbox-stream-io.js(4), src/backend/toolbox-xlsx-stream/multi-sheet-reader.js(3) |
| `ZERO_RESOURCES` | 11 | 28 | 11 | src/main-process/new-account/policies.js(4), src/main-process/vcc-financial-op-output/policies.js(4), src/main-process/background-execution/acquiring-adapter-policies.js(3) |
| `sax` | 11 | 27 | 11 | src/backend/toolbox-format/xlsx-pass.js(4), src/main-process/toolbox-output-writer.js(4), src/backend/acquiring-bill-currency-import/reader.js(3) |
| `SHA256_PATTERN` | 11 | 27 | 11 | src/main-process/statement-worker/contracts.js(6), src/main-process/vcc-op-calc/save-run-contract.js(3), src/backend/database/recon-fix-operation-receipt-repository.js(2) |
| `runReconciliation` | 11 | 25 | 8 | src/main-process/bank-bu-recon-session.js(5), src/main-process/bank-bu-recon-run-data.js(3), src/main-process/fund-recon-worker/service.js(3) |
| `MODULE` | 10 | 139 | 9 | src/main-process/biz-op-recon-run-data.js(40), src/backend/duplicate-inbound-match-store.js(26), src/main-process/acquiring-bill-currency-run-data.js(22) |
| `runRepository` | 10 | 78 | 10 | src/main-process/biz-op-recon-run-data.js(30), src/main-process/bank-bu-recon-run-data.js(9), src/main-process/biz-op-recon-session.js(9) |
| `parseJson` | 10 | 67 | 7 | src/main-process/position-reconciliation/store.js(29), src/backend/duplicate-inbound-match-result-digest.js(9), src/backend/pre-fund-reconciliation-run-store.js(6) |
| `exact` | 10 | 45 | 4 | src/main-process/new-account/generation-contract.js(9), src/main-process/statement-worker/generation-contracts.js(8), src/main-process/statement-worker/artifact-descriptor.js(7) |
| `canonicalizeJson` | 10 | 44 | 4 | src/main-process/background-execution/critical/recovery-control-repository.js(8), src/main-process/statement-worker/artifact-descriptor.js(8), src/main-process/statement-worker/contracts.js(5) |
| `stableJson` | 10 | 44 | 4 | src/main-process/pre-fund-reconciliation/mpt-import/spool-reader.js(7), src/backend/vcc-financial-op/result-template-contract.js(5), src/main-process/position-reconciliation/common.js(5) |
| `RECON_FIX_RUN_JPM_ACTION` | 10 | 43 | 5 | src/main-process/recon-id-fix-service/policies.js(11), src/main-process/recon-id-fix-service/worker-entry.js(7), src/main-process/recon-id-fix-service/service.js(5) |
| `toDate` | 10 | 42 | 9 | src/main-process/scenario-engines/engine-date-utils.js(8), src/main-process/scenario-engines/dbs-charge-fund-check.js(5), src/main-process/scenario-engines/r5-fund-transfer-backfill.js(5) |
| `utilTypes` | 10 | 42 | 10 | src/main-process/background-execution/execution-policy-registry.js(10), src/main-process/statement-worker/contracts.js(7), src/main-process/background-execution/error-codec.js(6) |
| `parseNumericValue` | 10 | 41 | 3 | src/backend/file-service.js(14), src/backend/file-service/writers.js(6), src/main-process/toolbox-stream-io.js(6) |
| `canonicalizeVccAmount` | 10 | 37 | 10 | src/backend/vcc-financial-op/result-evidence.js(8), src/backend/vcc-financial-op/calculator.js(7), src/backend/vcc-financial-op/result-adjustments.js(4) |
| `normalizeDate` | 10 | 34 | 4 | src/backend/vcc-financial-op/row-mapper.js(5), src/main-process/position-reconciliation/derivation.js(5), src/main-process/pre-fund-reconciliation/mpt-schema.js(5) |
| `canonicalizeDecimal` | 10 | 32 | 5 | src/main-process/pre-fund-reconciliation/bank-row.js(6), src/main-process/financial-decimal.js(5), src/main-process/pre-fund-reconciliation/matching-engine.js(4) |
| `normalizeYearMonth` | 10 | 32 | 7 | src/backend/vcc-financial-op/calculator.js(6), src/backend/vcc-financial-op/row-mapper.js(6), src/main-process/vcc-financial-op-service.js(4) |
| `normalizeRecoverySource` | 10 | 31 | 6 | src/main-process/background-execution/canary/durable-recovery.js(6), src/main-process/manual-balance-seed-settlement.js(5), src/main-process/background-execution/recovery-source.js(4) |
| `normalizeSpoolDescriptor` | 10 | 28 | 2 | src/main-process/bank-bu-worker/spool-filesystem.js(4), src/main-process/duplicate-inbound-match/spool-filesystem.js(4), src/main-process/bank-bu-worker/parser-outcome.js(3) |
| `main` | 10 | 27 | 4 | src/main-process/bank-bu-worker/main-coordinator.js(6), src/main-process/position-reconciliation/decimal.js(5), src/renderer-dialogs.js(4) |
| `transitionRequestKey` | 10 | 27 | 6 | src/main-process/background-execution/critical/recovery-request-owner-repository.js(5), src/main-process/background-execution/startup-recovery-coordinator.js(5), src/main-process/manual-balance-seed-settlement.js(3) |
| `assertJsonSafe` | 10 | 26 | 7 | src/main-process/background-execution/protocol-validator.js(6), src/main-process/background-execution/execution-policy-registry.js(3), src/main-process/recon-id-fix-service/jpm-writeback-plan.js(3) |
| `getRunById` | 10 | 25 | 3 | src/main-process/biz-op-recon-run-data.js(6), src/backend/biz-op-recon-db/run-repository.js(4), src/backend/pending-db/diff-repository.js(4) |
| `importFiles` | 10 | 21 | 4 | src/backend/vcc-financial-op/system-op-importer.js(5), src/backend/vcc-financial-op/detail-importer.js(3), src/backend/big-table-import/engine.js(2) |
| `insertOperationReceipt` | 10 | 20 | 5 | src/backend/duplicate-inbound-match-store.js(4), src/backend/database/recon-fix-operation-receipt-repository.js(2), src/backend/pre-fund-reconciliation-store.js(2) |
| `validateFlowHeaders` | 10 | 20 | 8 | src/backend/acquiring-bill-currency-import/reader.js(3), src/backend/acquiring-bill-currency-import/contract-flow.js(2), src/backend/acquiring-bill-currency-import/validator.js(2) |
| `deserializeError` | 10 | 19 | 4 | src/main-process/serialize-error.js(3), src/main-process/vcc-financial-op-service.js(3), src/main-process/acquiring-bill-currency-session.js(2) |
| `openReadStream` | 10 | 16 | 1 | src/backend/vcc-financial-op/workbook-reader.js(4), src/backend/acquiring-bill-currency-import/reader.js(2), src/backend/toolbox-format/xlsx-pass.js(2) |
| `database` | 9 | 142 | 1 | src/main.js(31), src/main-process/vcc-financial-op-service.js(29), src/main-process/pre-fund-reconciliation/service.js(25) |
| `FIELD_MAP` | 9 | 114 | 8 | src/main-process/boc-fx-link-builder.js(34), src/main-process/scenario-engines/jpm-dispatch-order-fix.js(28), src/main-process/adm-bank-deposit-builder.js(14) |
| `managedError` | 9 | 60 | 9 | src/main-process/pre-fund-reconciliation/mpt-import/managed-import.js(11), src/main-process/bank-bu-worker/dual-parser-dispatch.js(10), src/main-process/duplicate-inbound-match/paired-parser-dispatch.js(10) |
| `openSideDb` | 9 | 46 | 1 | src/main-process/biz-op-recon-run-data.js(19), src/main-process/bank-bu-recon-run-data.js(8), src/main-process/acquiring-bill-currency-run-data.js(5) |
| `SHA256_RE` | 9 | 35 | 9 | src/main-process/archive-center/archive-service.js(7), src/main-process/background-execution/adapters/position-import-adapter.js(6), src/main-process/position-reconciliation/operation-lifecycle.js(6) |
| `workerError` | 9 | 35 | 6 | src/main-process/read-only-exports/pending/writer.js(7), src/main-process/position-reconciliation/import-recovery.js(6), src/main-process/toolbox-output-publication-dispatch.js(6) |
| `normalizeHeaderRow` | 9 | 28 | 5 | src/backend/vcc-financial-op/workbook-reader.js(4), src/main-process/position-reconciliation/readers.js(4), src/main-process/toolbox-merge-io.js(4) |
| `bankChannel` | 9 | 27 | 1 | src/main-process/pre-fund-reconciliation/output-mapper.js(5), src/main-process/scenario-engines/dbs-charge-fund-check.js(5), src/main-process/scenario-engines/r5-payment-offline-allocation-backfill.js(4) |
| `FLOW_DB_COLUMNS` | 9 | 27 | 3 | src/backend/biz-op-recon-import/contract-flow.js(6), src/backend/biz-op-recon-db/flow-imports-repository.js(5), src/backend/biz-op-recon-db/columns.js(4) |
| `parseDateValue` | 9 | 27 | 2 | src/backend/file-service.js(4), src/backend/file-service/writers.js(4), src/main-process/statement-generation-business.js(4) |
| `listMonths` | 9 | 20 | 4 | src/main-process/bank-bu-recon-session.js(4), src/main-process/acquiring-bill-currency-session.js(3), src/preload.js(3) |
| `validate` | 9 | 20 | 1 | src/main-process/background-execution/execution-policy-registry.js(4), src/main-process/background-execution/recovery-source.js(4), src/main-process/background-execution/schema-validator.js(3) |
| `create` | 9 | 18 | 1 | src/backend/toolbox-xlsx-stream/bounded-values-accumulator.js(4), src/backend/big-table-import/row-scanner.js(3), src/backend/biz-op-recon-db/month-end-copy-intent-repository.js(2) |
| `makeModificationCollector` | 9 | 18 | 1 | src/main-process/scenario-engines/c1-extract-recon-id.js(2), src/main-process/scenario-engines/c2-offset-bill-mark.js(2), src/main-process/scenario-engines/c3-gateway-recon-join.js(2) |
| `incomingSequence` | 9 | 17 | 3 | src/main-process/background-execution/canary/pure-compute-worker.js(2), src/main-process/duplicate-inbound-match/worker-host.js(2), src/main-process/fund-recon-worker/worker-host.js(2) |
| `saveMappings` | 9 | 17 | 2 | src/backend/database.js(3), src/renderer-dialogs.js(3), src/backend/database/fund-transfer-account-mapping-repository.js(2) |
| `insertRun` | 9 | 13 | 4 | src/backend/acquiring-bill-currency-db/run-repository.js(2), src/backend/bank-bu-recon-db/run-repository.js(2), src/backend/biz-op-recon-db/run-repository.js(2) |
| `jobRef` | 8 | 108 | 3 | src/main-process/background-execution/service-host.js(46), src/main-process/statement-worker/service.js(33), src/main-process/recon-id-fix-service/worker-entry.js(9) |
| `purpose` | 8 | 65 | 1 | src/main-process/statement-worker/token-store.js(19), src/main-process/statement-worker/contracts.js(17), src/main-process/statement-worker/probe-state-builder.js(16) |
| `operationError` | 8 | 56 | 3 | src/main-process/vcc-financial-op-service.js(12), src/backend/vcc-financial-op/operation-state.js(8), src/backend/vcc-financial-op/unarchive.js(8) |
| `scopeKey` | 8 | 52 | 1 | src/main-process/background-execution/critical/recovery-request-owner-repository.js(17), src/main-process/position-reconciliation/store.js(10), src/main-process/archive-center/task-policy-registry.js(5) |
| `POSITION_IMPORT_COMMANDS` | 8 | 51 | 1 | src/backend/position-reconciliation-import/worker-entry.js(9), src/main-process/position-reconciliation/service.js(9), src/backend/position-reconciliation-import/constants.js(7) |
| `startEnvelope` | 8 | 40 | 3 | src/main-process/bank-bu-worker/worker-host.js(9), src/main-process/background-execution/adapters/canonical-event-emitter.js(7), src/main-process/background-execution/adapters/inline-async-adapter.js(4) |
| `cancelRequested` | 8 | 36 | 2 | src/main-process/recon-id-fix-service/worker-entry.js(8), src/main-process/background-execution/adapters/position-import-adapter.js(7), src/main-process/background-execution/supervisor.js(7) |
| `targetSnapshot` | 8 | 30 | 2 | src/main-process/manual-balance-seed-settlement.js(11), src/main-process/recon-id-fix-service/export-operation.js(5), src/main-process/archive-center/file-plan.js(4) |
| `VCC_EXPORT_SUBJECTS_ACTION` | 8 | 30 | 3 | src/main-process/vcc-financial-op-output/policies.js(6), src/main-process/vcc-financial-op-output/writer-core.js(6), src/main-process/background-execution/runtime.js(5) |
| `headersEqual` | 8 | 28 | 4 | src/backend/vcc-financial-op/definitions.js(5), src/main-process/position-reconciliation/readers.js(5), src/backend/position-reconciliation-import/xls-reader.js(4) |
| `FT_RECON_FIELD_MAP` | 8 | 24 | 6 | src/main-process/fund-transfer-recon-builder.js(5), src/main-process/scenario-engines/dbs-charge-fund-check.js(5), src/constants/fund-transfer-recon-fields.js(4) |
| `os` | 8 | 24 | 7 | src/main-process/background-execution/resource-budget.js(7), src/backend/big-table-import/pipeline.js(5), src/main-process/background-execution/runtime.js(4) |
| `readDatabaseLocalTimestamp` | 8 | 19 | 3 | src/backend/vcc-financial-op/calculator.js(3), src/backend/vcc-financial-op/data-target-deletion.js(3), src/backend/vcc-financial-op/result-write.js(3) |
| `getMonthMeta` | 8 | 18 | 2 | src/main-process/bank-bu-recon-run-data.js(4), src/backend/pending-db/month-repository.js(3), src/main-process/bank-bu-recon-session.js(3) |
| `normalizeDateExportValue` | 8 | 18 | 6 | src/backend/file-service.js(3), src/backend/file-service/normalizers.js(3), src/backend/database/linked-table-repository.js(2) |
| `withReadSnapshot` | 8 | 18 | 4 | src/main-process/read-only-exports/pre-fund/query.js(4), src/main-process/read-only-exports/pending/query.js(3), src/main-process/read-only-exports/pending/writer.js(2) |
| `readRows` | 8 | 16 | 4 | src/backend/file-service.js(3), src/main-process/toolbox-stream-io.js(3), src/backend/bank-account-import.js(2) |
| `acknowledgeArchiveTerminal` | 8 | 15 | 3 | src/main-process/biz-op-recon-run-data.js(5), src/backend/biz-op-recon-db/run-repository.js(2), src/backend/database/pre-fund-reconciliation-run-repository.js(2) |
| `hasOperationReceiptTable` | 8 | 15 | 4 | src/main-process/pre-fund-reconciliation/mpt-import/operation-receipt-repository.js(3), src/backend/database/recon-fix-operation-receipt-repository.js(2), src/main-process/bank-bu-worker/operation-receipt-repository.js(2) |
| `mapRow` | 8 | 14 | 2 | src/main-process/bank-bu-worker/mirror-repository.js(4), src/backend/pending-import/removed-reader.js(3), src/backend/big-table-import/contract.js(2) |
| `createRun` | 8 | 11 | 1 | src/backend/pending-reconcile/engine.js(3), src/backend/pending-db/diff-repository.js(2), src/backend/duplicate-inbound-match-store.js(1) |
| `dialog` | 7 | 613 | 1 | src/renderer-dialogs.js(443), src/renderer.js(120), src/renderer-pending.js(26) |
| `boundedText` | 7 | 62 | 7 | src/main-process/statement-worker/contracts.js(26), src/main-process/new-account/generation-contract.js(11), src/main-process/statement-worker/import-contracts.js(10) |
| `localName` | 7 | 44 | 3 | src/backend/toolbox-format/xlsx-pass.js(12), src/backend/vcc-financial-op/system-op-importer.js(10), src/backend/toolbox-format/style-registry.js(7) |
| `stableStringify` | 7 | 39 | 3 | src/backend/vcc-financial-op/result-write.js(11), src/backend/vcc-financial-op/destructive-write.js(7), src/backend/vcc-financial-op/operation-token-v2.js(7) |
| `isPlainObject` | 7 | 33 | 7 | src/main-process/pre-fund-reconciliation/matching-engine.js(10), src/main-process/position-reconciliation/store.js(7), src/main-process/fund-recon-worker/policies.js(6) |
| `receiptRepository` | 7 | 32 | 7 | src/main-process/recon-id-fix-service/jpm-writeback-transaction.js(7), src/main-process/bank-bu-worker/side-database.js(6), src/main-process/vcc-op-calc/save-run-contract.js(5) |
| `deepFreeze` | 7 | 30 | 7 | src/backend/toolbox-format/style-registry.js(8), src/main-process/background-execution/execution-policy-registry.js(7), src/main-process/background-execution/action-manifest.js(3) |
| `operations` | 7 | 28 | 1 | src/main-process/duplicate-inbound-match/startup-recovery.js(8), src/main-process/business-operation-registry.js(5), src/main-process/duplicate-inbound-match/worker-host.js(4) |
| `BILL_HEADERS` | 7 | 27 | 7 | src/main-process/duplicate-inbound-match/document-statement-reader.js(9), src/backend/acquiring-bill-currency-db/columns.js(7), src/backend/acquiring-bill-currency-import/contract-bill.js(3) |
| `subjectDigest` | 7 | 24 | 1 | src/main-process/vcc-financial-op-output/dispatch.js(7), src/main-process/vcc-financial-op-output/authority.js(6), src/main-process/vcc-financial-op-output/subject-evidence.js(4) |
| `ACQUIRING_EXPORT_ACTIONS` | 7 | 23 | 2 | src/main-process/read-only-exports/acquiring/policies.js(6), src/main-process/read-only-exports/acquiring/actions.js(5), src/main-process/background-execution/runtime.js(3) |
| `sideDbExists` | 7 | 23 | 1 | src/backend/duplicate-inbound-match-store.js(7), src/main-process/biz-op-recon-run-data.js(5), src/main-process/bank-bu-recon-run-data.js(4) |
| `normalizeContext` | 7 | 20 | 6 | src/main-process/read-only-exports/acquiring/actions.js(3), src/main-process/read-only-exports/biz-op/actions.js(3), src/main-process/read-only-exports/pending/actions.js(3) |
| `operationContextFromBatch` | 7 | 20 | 7 | src/main-process/read-only-exports/acquiring/managed-export.js(3), src/main-process/read-only-exports/biz-op/managed-export.js(3), src/main-process/read-only-exports/pending/managed-export.js(3) |
| `listSideDbFiles` | 7 | 19 | 1 | src/main-process/biz-op-recon-run-data.js(6), src/backend/pre-fund-reconciliation-run-store.js(4), src/main-process/acquiring-bill-currency-run-data.js(3) |
| `normalizeEvidence` | 7 | 19 | 6 | src/main-process/read-only-exports/biz-op/actions.js(3), src/main-process/read-only-exports/pending/actions.js(3), src/main-process/read-only-exports/position/actions.js(3) |
| `BANK_DB_COLUMNS` | 7 | 16 | 1 | src/backend/bank-bu-recon-db/month-repository.js(3), src/main-process/bank-bu-recon-writer.js(3), src/backend/bank-bu-recon-db/columns.js(2) |
| `GATEWAY_BILL_FIELDS` | 7 | 16 | 4 | src/renderer-dialogs.js(4), src/constants/adm-bank-deposit-fields.js(2), src/constants/gateway-bill-recon-fields.js(2) |
| `PENDING_GUANLI_DB_COLUMNS` | 7 | 16 | 1 | src/backend/bank-bu-recon-db/month-repository.js(3), src/main-process/bank-bu-recon-writer.js(3), src/backend/bank-bu-recon-db/columns.js(2) |
| `extractHeaders` | 7 | 14 | 3 | src/main-process/statement-generation-business.js(4), src/main-process/new-account/generation-validator.js(3), src/backend/file-service.js(2) |
| `isMainThread` | 7 | 14 | 7 | src/backend/big-table-import/engine-worker-entry.js(2), src/backend/big-table-import/import-worker.js(2), src/backend/toolbox-xlsx-stream/large-split-worker.js(2) |
| `MODULE_BANK_BU` | 7 | 14 | 1 | src/backend/run-data-store.js(5), src/main-process/bank-bu-worker/outcome-inspector.js(3), src/main-process/bank-bu-worker/run-operation.js(2) |
| `normalizeReadOnlyExportInput` | 7 | 14 | 1 | src/main-process/read-only-exports/acquiring/actions.js(2), src/main-process/read-only-exports/biz-op/actions.js(2), src/main-process/read-only-exports/common/contract.js(2) |
| `startReadOnlyExportWorker` | 7 | 14 | 7 | src/main-process/read-only-exports/acquiring/worker-entry.js(2), src/main-process/read-only-exports/biz-op/worker-entry.js(2), src/main-process/read-only-exports/common/worker-host.js(2) |
| `createContract` | 7 | 13 | 4 | src/backend/acquiring-bill-currency-import/contract-bill.js(2), src/backend/acquiring-bill-currency-import/contract-flow.js(2), src/backend/big-table-import/engine.js(2) |
| `getRunByArchiveTaskRunId` | 7 | 13 | 2 | src/main-process/biz-op-recon-run-data.js(4), src/backend/biz-op-recon-db/run-repository.js(3), src/backend/pending-db/diff-repository.js(2) |
| `normalizeFilePlanV1` | 7 | 13 | 3 | src/main-process/archive-center/archive-service.js(2), src/main-process/archive-center/file-plan.js(2), src/main-process/archive-center/ipc-task-contract.js(2) |
| `JSZip` | 7 | 12 | 7 | src/backend/biz-op-recon-import/reader-streamed.js(2), src/backend/file-service/readers.js(2), src/backend/pending-import/streaming-xlsx-writer.js(2) |
| `scanSheet` | 7 | 12 | 2 | src/backend/toolbox-format/biff8-pass.js(2), src/backend/toolbox-format/biff8-records.js(2), src/backend/toolbox-format/csv-pass.js(2) |
| `sanitizeFileName` | 7 | 10 | 6 | src/main-process/toolbox.js(3), src/main-process/pre-fund-reconciliation/excel-writer.js(2), src/backend/balance-seed-store.js(1) |
| `elements` | 6 | 261 | 1 | src/renderer.js(153), src/renderer-previews.js(51), src/renderer-position-reconciliation.js(29) |
| `activeJob` | 6 | 152 | 2 | src/main-process/run-check-worker-pool.js(37), src/main-process/recon-id-fix-service/worker-entry.js(30), src/main-process/statement-worker/service.js(30) |
| `requiredText` | 6 | 115 | 6 | src/backend/database/archive-repository.js(79), src/main-process/archive-center/business-flow-resolver.js(11), src/main-process/archive-center/file-plan.js(8) |
| `sourceError` | 6 | 92 | 6 | src/main-process/read-only-exports/pre-fund/query.js(20), src/main-process/read-only-exports/position/query.js(16), src/main-process/read-only-exports/vcc-financial-op/query.js(16) |
| `VCC_MUTATION_OPERATIONS` | 6 | 81 | 1 | src/backend/vcc-financial-op/mutation-policy.js(31), src/backend/vcc-financial-op/destructive-write.js(15), src/backend/vcc-financial-op/result-write.js(14) |
| `assertExactKeys` | 6 | 52 | 5 | src/main-process/toolbox-background/generation-contract.js(25), src/main-process/pre-fund-reconciliation/mpt-import/spool-reader.js(12), src/main-process/recon-id-fix-service/service.js(6) |
| `app` | 6 | 45 | 1 | src/main-process/app-updater.js(16), src/main.js(13), src/renderer.js(8) |
| `invalid` | 6 | 31 | 1 | src/main-process/statement-worker/staging-ownership.js(19), src/backend/vcc-financial-op/calculator.js(5), src/main-process/toolbox-output-publication.js(3) |
| `dependentMonths` | 6 | 30 | 1 | src/backend/vcc-financial-op/unarchive-gate.js(6), src/backend/vcc-financial-op/unarchive.js(6), src/main-process/serialize-error.js(6) |
| `positiveInteger` | 6 | 30 | 6 | src/main-process/statement-worker/contracts.js(11), src/main-process/read-only-exports/vcc-financial-op/actions.js(6), src/main-process/read-only-exports/acquiring/actions.js(5) |
| `serializeJson` | 6 | 30 | 1 | src/main-process/position-reconciliation/store.js(18), src/backend/position-reconciliation-import/account-writer.js(3), src/backend/position-reconciliation-import/source-writer.js(3) |
| `cancellationError` | 6 | 29 | 3 | src/main-process/background-execution/adapters/position-import-adapter.js(6), src/main-process/recon-id-fix-service/worker-entry.js(6), src/main-process/vcc-op-calc/parser-pipeline.js(5) |
| `logger` | 6 | 28 | 3 | src/backend/vcc-financial-op/unarchive.js(9), src/main-process/app-updater.js(7), src/main-process/biz-op-recon-session.js(5) |
| `monthOf` | 6 | 28 | 2 | src/main-process/biz-op-recon-run-data.js(16), src/main-process/position-reconciliation/readers.js(3), src/renderer-position-reconciliation.js(3) |
| `RECEIPTS_TABLE` | 6 | 28 | 5 | src/main-process/duplicate-inbound-match/operation-receipt-repository.js(6), src/main-process/pre-fund-reconciliation/mpt-import/operation-receipt-repository.js(6), src/backend/database/recon-fix-operation-receipt-repository.js(5) |
| `cellValue` | 6 | 26 | 2 | src/main-process/scenario-engines/engine-utils.js(8), src/backend/file-service/writers.js(6), src/main-process/scenario-engines/c1-extract-recon-id.js(6) |
| `reconFixEvidenceSha256` | 6 | 25 | 4 | src/main-process/recon-id-fix-service/service.js(13), src/main-process/recon-id-fix-service/artifact-evidence.js(3), src/main-process/recon-id-fix-service/jpm-writeback-plan.js(3) |
| `namespaceAllowed` | 6 | 23 | 1 | src/backend/toolbox-format/xlsx-pass.js(11), src/main-process/toolbox-output-writer.js(4), src/backend/toolbox-format/style-registry.js(3) |
| `rollbackQuietly` | 6 | 23 | 6 | src/backend/pre-fund-reconciliation-store.js(7), src/backend/duplicate-inbound-match-store.js(5), src/main-process/bank-bu-worker/side-database.js(3) |
| `normalizePositionCheckpoint` | 6 | 22 | 1 | src/main-process/position-reconciliation/side-db-mutation.js(6), src/main-process/position-reconciliation/store.js(5), src/main-process/background-execution/adapters/position-import-adapter.js(4) |
| `targetParentIdentity` | 6 | 22 | 1 | src/main-process/archive-center/file-plan.js(5), src/main-process/recon-id-fix-service/export-operation.js(5), src/main-process/toolbox-output-publication.js(4) |
| `MAX_COLLECTED_ERRORS` | 6 | 21 | 5 | src/backend/acquiring-bill-currency-import/reader.js(6), src/backend/big-table-import/import-worker.js(4), src/backend/acquiring-bill-currency-import/contract-bill.js(3) |
| `BANK_SHEET_NAME` | 6 | 20 | 1 | src/main-process/position-reconciliation/excel-io.js(5), src/backend/position-reconciliation-import/xls-reader.js(4), src/main-process/position-reconciliation/readers.js(4) |
| `cloneRowsWithMetadata` | 6 | 20 | 1 | src/main-process/statement-session.js(5), src/main-process/statement-worker/probe-state-builder.js(4), src/main-process/statement-worker/session-state.js(4) |
| `POSITION_BANK_HEADERS` | 6 | 20 | 1 | src/main-process/position-reconciliation/excel-io.js(9), src/main-process/position-reconciliation/readers.js(3), src/backend/position-reconciliation-import/xls-reader.js(2) |
| `getHead` | 6 | 19 | 1 | src/main-process/biz-op-recon-session.js(5), src/backend/biz-op-recon-db/dataset-head-repository.js(3), src/main-process/biz-op-archive-lineage.js(3) |
| `outputPlanHash` | 6 | 19 | 2 | src/main-process/toolbox-background/route-db-contract.js(5), src/main-process/toolbox-background/multi-output-validator.js(4), src/main-process/toolbox-background/output-writer-core.js(4) |
| `positionCheckpointsEqual` | 6 | 19 | 1 | src/main-process/position-reconciliation/large-import-schema.js(4), src/main-process/position-reconciliation/service.js(4), src/main-process/position-reconciliation/store.js(4) |
| `BIZ_OP_DB_COLUMNS` | 6 | 18 | 2 | src/backend/biz-op-recon-db/imports-repository.js(5), src/backend/biz-op-recon-db/columns.js(4), src/main-process/biz-op-recon-run-data.js(3) |
| `syncDirectory` | 6 | 18 | 2 | src/main-process/manual-balance-seed-settlement.js(5), src/main-process/archive-center/storage-root-manager.js(4), src/main-process/pre-fund-reconciliation/mpt-import/spool-writer.js(3) |
| `listRunMirrors` | 6 | 17 | 2 | src/main-process/duplicate-inbound-match/startup-recovery.js(8), src/backend/database.js(2), src/backend/database/duplicate-inbound-match-run-repository.js(2) |
| `splitTemplateName` | 6 | 17 | 2 | src/main-process/statement-generation-business.js(6), src/main-process/manual-balance-seed-preflight.js(3), src/main-process/statement-generation.js(3) |
| `SPREADSHEETML_NAMESPACES` | 6 | 17 | 1 | src/backend/toolbox-format/xlsx-pass.js(8), src/backend/toolbox-format/ooxml-namespaces.js(2), src/backend/toolbox-format/style-registry.js(2) |
| `addCanonicalDecimals` | 6 | 16 | 2 | src/backend/vcc-financial-op/result-evidence.js(4), src/main-process/pre-fund-reconciliation/bank-row.js(4), src/backend/vcc-financial-op/calculator.js(2) |
| `assertPositionLargeImportSchema` | 6 | 16 | 1 | src/main-process/position-reconciliation/large-import-schema.js(5), src/backend/position-reconciliation-import/source-writer.js(3), src/backend/position-reconciliation-import/account-writer.js(2) |
| `MS_PER_DAY` | 6 | 16 | 6 | src/main-process/scenario-engines/r5-payment-offline-allocation-backfill.js(5), src/main-process/scenario-engines/engine-date-utils.js(3), src/main-process/scenario-engines/dbs-charge-fund-check.js(2) |
| `VALID_DIRECTION_IN` | 6 | 16 | 4 | src/main-process/vcc-op-calc-session.js(4), src/backend/biz-op-recon-import/validator.js(3), src/main-process/vcc-op-calc/parser-core.js(3) |
| `requireMonth` | 6 | 15 | 6 | src/main-process/bank-bu-worker/identity.js(3), src/main-process/bank-bu-worker/main-coordinator.js(3), src/main-process/bank-bu-worker/mirror-repository.js(3) |
| `shutdown` | 6 | 15 | 1 | src/main-process/background-execution/runtime.js(4), src/main-process/run-check-worker-pool.js(4), src/main-process/background-execution/canary/packaged-runtime-runner.js(2) |
| `subtractCanonicalDecimals` | 6 | 15 | 1 | src/backend/vcc-financial-op/result-adjustments.js(3), src/backend/vcc-financial-op/result-evidence.js(3), src/main-process/scenario-engines/r5-refund-order-backfill.js(3) |
| `listChannels` | 6 | 14 | 1 | src/main-process/fund-recon-worker/artifact-generator.js(4), src/main-process/scenarios-bundle-import.js(3), src/backend/database.js(2) |
| `normalizeOperationIdentity` | 6 | 14 | 6 | src/main-process/duplicate-inbound-match/service.js(4), src/main-process/bank-bu-worker/identity.js(2), src/main-process/bank-bu-worker/import-operation.js(2) |
| `resolveTaskStagingResource` | 6 | 14 | 2 | src/main-process/new-account/artifact-copy.js(3), src/main-process/statement-worker/publication.js(3), src/main-process/new-account/generation-contract.js(2) |
| `runPositionSideDbMutation` | 6 | 14 | 1 | src/backend/position-reconciliation-import/maintenance-writer.js(4), src/backend/position-reconciliation-import/account-writer.js(2), src/backend/position-reconciliation-import/bank-writer.js(2) |
| `validatePrivateSpoolDirectory` | 6 | 14 | 4 | src/main-process/bank-bu-worker/spool-reader.js(3), src/main-process/duplicate-inbound-match/spool-reader.js(3), src/main-process/bank-bu-worker/parser-outcome.js(2) |
| `assertPreservedOperationState` | 6 | 13 | 1 | src/backend/vcc-financial-op/data-target-deletion.js(3), src/backend/vcc-financial-op/calculator.js(2), src/backend/vcc-financial-op/dataset-deletion.js(2) |
| `deriveFileIdentity` | 6 | 13 | 4 | src/main-process/pre-fund-reconciliation/mpt-import/managed-import.js(3), src/main-process/pre-fund-reconciliation/mpt-import/parser-outcome.js(2), src/main-process/pre-fund-reconciliation/mpt-import/single-writer-session.js(2) |
| `formatTimestamp` | 6 | 13 | 6 | src/main-process/position-reconciliation/service.js(4), src/backend/database/backup.js(2), src/main-process/bank-bu-recon-session.js(2) |
| `getImportRecord` | 6 | 13 | 1 | src/backend/vcc-financial-op-db/repository.js(6), src/backend/vcc-financial-op/system-op-importer.js(3), src/backend/vcc-financial-op/detail-importer.js(1) |
| `VALID_DIRECTION_OUT` | 6 | 13 | 4 | src/backend/biz-op-recon-import/validator.js(3), src/backend/vcc-op-calc-db/columns.js(2), src/backend/vcc-op-calc-import/validator.js(2) |
| `createServiceControlEnvelope` | 6 | 12 | 3 | src/main-process/background-execution/protocol.js(2), src/main-process/background-execution/service-host.js(2), src/main-process/duplicate-inbound-match/worker-host.js(2) |
| `ensurePrivateSpoolDirectory` | 6 | 12 | 2 | src/main-process/bank-bu-worker/parser-outcome.js(2), src/main-process/bank-bu-worker/spool-filesystem.js(2), src/main-process/bank-bu-worker/spool-writer.js(2) |
| `getEffectiveRunResult` | 6 | 12 | 4 | src/backend/vcc-financial-op/result-adjustments.js(3), src/backend/vcc-financial-op/calculator.js(2), src/backend/vcc-financial-op/operation-audit.js(2) |
| `loadSharedStrings` | 6 | 12 | 1 | src/backend/acquiring-bill-currency-import/reader.js(4), src/backend/toolbox-xlsx-stream/multi-sheet-reader.js(3), src/main-process/duplicate-inbound-match/document-statement-reader.js(2) |
| `moduleDir` | 6 | 12 | 1 | src/backend/run-data-store.js(5), src/backend/duplicate-inbound-match-store.js(3), src/backend/pre-fund-reconciliation-run-store.js(1) |
| `scanSheetRows` | 6 | 12 | 4 | src/backend/toolbox-xlsx-stream/multi-sheet-reader.js(3), src/backend/vcc-financial-op/workbook-reader.js(3), src/backend/big-table-import/row-scanner.js(2) |
| `startToolboxGenerationWorker` | 6 | 12 | 6 | src/main-process/toolbox-background/merge-worker-entry.js(2), src/main-process/toolbox-background/route-scanner-worker-entry.js(2), src/main-process/toolbox-background/split-worker-entry.js(2) |
| `TextDecoder` | 6 | 12 | 6 | src/backend/position-reconciliation-import/shared-strings-provider.js(2), src/main-process/background-execution/canonical-json-v1.js(2), src/main-process/background-execution/protocol-validator.js(2) |
| `trimTrailingEmptyCells` | 6 | 12 | 1 | src/backend/file-service/readers.js(3), src/backend/file-service/common.js(2), src/backend/toolbox-xlsx-stream/multi-sheet-reader.js(2) |
| `writeBalanceWorkbook` | 6 | 12 | 3 | src/backend/file-service.js(3), src/main-process/statement-generation-business.js(3), src/backend/file-service/writers.js(2) |
| `getStatementSessionEntries` | 6 | 11 | 1 | src/main-process/manual-balance-seed-preflight.js(2), src/main-process/statement-generation-business.js(2), src/main-process/statement-generation.js(2) |
| `deleteSideDbByPath` | 6 | 10 | 1 | src/backend/pre-fund-reconciliation-store.js(3), src/backend/run-data-store.js(3), src/backend/duplicate-inbound-match-store.js(1) |
| `getLatestRun` | 6 | 10 | 2 | src/backend/acquiring-bill-currency-db/run-repository.js(2), src/backend/bank-bu-recon-db/run-repository.js(2), src/main-process/acquiring-bill-currency-run-data.js(2) |
| `readBankStatement` | 6 | 10 | 4 | src/main-process/duplicate-inbound-match/service.js(2), src/main-process/duplicate-inbound-match/spool-writer.js(2), src/main-process/fund-recon-worker/source-readers.js(2) |
| `resolveFromRel` | 6 | 10 | 1 | src/main-process/biz-op-recon-run-data.js(4), src/backend/run-data-store.js(2), src/main-process/bank-bu-worker/export-operation.js(1) |
| `listMappings` | 6 | 9 | 1 | src/backend/database/fund-transfer-account-mapping-repository.js(2), src/main-process/position-reconciliation/service.js(2), src/main-process/position-reconciliation/store.js(2) |
| `listUnacknowledgedArchiveRuns` | 6 | 8 | 2 | src/backend/biz-op-recon-db/run-repository.js(2), src/backend/pending-db/diff-repository.js(2), src/backend/pre-fund-reconciliation-run-store.js(1) |
| `escapeHtml` | 5 | 302 | 1 | src/renderer-dialogs.js(167), src/renderer.js(77), src/renderer-position-reconciliation.js(39) |
| `shell` | 5 | 92 | 1 | src/renderer-position-reconciliation.js(79), src/renderer.js(9), src/renderer-dialogs.js(2) |
| `setCurrentModule` | 5 | 70 | 2 | src/renderer-previews.js(61), src/renderer.js(4), src/backend/database.js(2) |
| `inputError` | 5 | 64 | 5 | src/main-process/read-only-exports/vcc-financial-op/actions.js(20), src/main-process/read-only-exports/acquiring/actions.js(15), src/main-process/read-only-exports/position/actions.js(15) |
| `safeCount` | 5 | 58 | 5 | src/main-process/recon-id-fix-service/policies.js(22), src/main-process/background-execution/position-import-adapter-policy.js(14), src/main-process/background-execution/adapters/position-import-adapter.js(10) |
| `processingResult` | 5 | 56 | 1 | src/main-process/fund-recon-worker/artifact-generator.js(29), src/main-process/fund-recon-worker/service.js(16), src/renderer.js(6) |
| `columnNumber` | 5 | 54 | 1 | src/main-process/new-account/strict-worksheet-readback.js(41), src/main-process/toolbox-output-writer.js(4), src/main-process/vcc-financial-op-output/artifact-evidence.js(4) |
| `runRepo` | 5 | 49 | 5 | src/main-process/acquiring-bill-currency-session.js(25), src/main-process/acquiring-bill-currency-run-data.js(15), src/main-process/acquiring-bill-currency-writer.js(4) |
| `targetPathAliasKey` | 5 | 44 | 1 | src/main-process/toolbox-output-publication.js(31), src/main-process/manual-balance-seed-settlement.js(6), src/main-process/toolbox-target-identity.js(4) |
| `lastGeneratedExports` | 5 | 43 | 1 | src/main-process/statement-worker/probe-state-builder.js(18), src/main-process/statement-generation.js(17), src/main-process/statement-session.js(6) |
| `normalizeBu` | 5 | 34 | 3 | src/main-process/biz-op-recon-run-data.js(11), src/main-process/bank-bu-recon-session.js(8), src/main-process/biz-op-recon-session.js(7) |
| `observationScopeKey` | 5 | 34 | 1 | src/main-process/background-execution/critical/recovery-request-owner-repository.js(14), src/main-process/background-execution/startup-recovery-coordinator.js(10), src/main-process/background-execution/critical/recovery-control-repository.js(5) |
| `tableColumns` | 5 | 31 | 5 | src/main-process/vcc-financial-op-storage-rebuild.js(10), src/backend/vcc-financial-op-db/migrations.js(8), src/main-process/position-reconciliation/large-import-schema.js(7) |
| `getSetting` | 5 | 28 | 1 | src/backend/database/settings-repository.js(17), src/main-process/archive-center/storage-root-manager.js(5), src/backend/database.js(3) |
| `monthRepository` | 5 | 28 | 4 | src/main-process/bank-bu-recon-run-data.js(7), src/main-process/bank-bu-recon-session.js(7), src/main-process/bank-bu-worker/side-database.js(6) |
| `openExistingSideDb` | 5 | 28 | 1 | src/backend/duplicate-inbound-match-store.js(11), src/backend/pre-fund-reconciliation-store.js(8), src/main-process/biz-op-recon-run-data.js(5) |
| `stableSummary` | 5 | 28 | 1 | src/main-process/duplicate-inbound-match/managed-service.js(10), src/main-process/fund-recon-worker/service.js(6), src/main-process/statement-worker/service.js(6) |
| `bumpRevision` | 5 | 27 | 4 | src/main-process/position-reconciliation/store.js(11), src/backend/position-reconciliation-import/maintenance-writer.js(7), src/backend/position-reconciliation-import/account-writer.js(3) |
| `json` | 5 | 22 | 1 | src/main-process/vcc-financial-op-dataset-writer.js(8), src/backend/position-reconciliation-import/ledger.js(6), src/main-process/recon-id-fix-service/service.js(4) |
| `MAX_DATA_ROWS_PER_SHEET` | 5 | 22 | 5 | src/main-process/toolbox-stream-io.js(5), src/main-process/vcc-financial-op-audit-writer.js(5), src/main-process/vcc-financial-op-dataset-writer.js(5) |
| `PENDING_READ_ONLY_ACTIONS` | 5 | 22 | 1 | src/main-process/read-only-exports/pending/actions.js(7), src/main-process/read-only-exports/pending/policies.js(6), src/main-process/read-only-exports/pending/writer.js(5) |
| `TOOLBOX_GENERATION_SCHEMA_VERSION` | 5 | 22 | 1 | src/main-process/toolbox-background/generation-contract.js(12), src/main-process/toolbox-background/generation-core.js(4), src/main-process/toolbox-background/generation-validator.js(2) |
| `checkedAdd` | 5 | 21 | 4 | src/main-process/background-execution/resource-governor.js(6), src/main-process/new-account/resource-estimator.js(5), src/main-process/recon-id-fix-service/service.js(5) |
| `RECON_FIX_EXPORT_ACTION` | 5 | 21 | 1 | src/main-process/recon-id-fix-service/policies.js(11), src/main-process/recon-id-fix-service/export-operation.js(3), src/main-process/recon-id-fix-service/service.js(3) |
| `yieldToEventLoop` | 5 | 21 | 3 | src/main-process/duplicate-inbound-match/service.js(10), src/main-process/pre-fund-reconciliation/service.js(5), src/backend/position-reconciliation-import/maintenance-writer.js(3) |
| `PENDING_HEADERS` | 5 | 20 | 1 | src/backend/vcc-financial-op/pending-template-contract.js(7), src/backend/vcc-financial-op/definitions.js(6), src/backend/vcc-financial-op/row-mapper.js(3) |
| `tableHasColumn` | 5 | 20 | 5 | src/main-process/vcc-financial-op-dataset-writer.js(7), src/main-process/vcc-financial-op-storage-rebuild.js(6), src/main-process/position-reconciliation/store.js(3) |
| `VCC_EXPORT_SINGLE_ACTION` | 5 | 20 | 2 | src/main-process/vcc-financial-op-output/policies.js(6), src/main-process/background-execution/runtime.js(4), src/main-process/vcc-financial-op-output/dispatch.js(4) |
| `DUPLICATE_INPUT_ROLES` | 5 | 19 | 1 | src/main-process/duplicate-inbound-match/spool-reader.js(7), src/main-process/duplicate-inbound-match/paired-parser-dispatch.js(4), src/main-process/duplicate-inbound-match/parser-outcome.js(3) |
| `MAX_TIMER_DELAY_MS` | 5 | 19 | 4 | src/main-process/background-execution/service-host.js(6), src/main-process/background-execution/admission-queue.js(4), src/main-process/background-execution/external-parser-finalization.js(3) |
| `MEBIBYTE` | 5 | 19 | 5 | src/main-process/new-account/resource-estimator.js(5), src/main-process/pre-fund-reconciliation/mpt-import/topology.js(5), src/main-process/statement-worker/contracts.js(4) |
| `BANK_BU_INPUT_ROLES` | 5 | 18 | 1 | src/main-process/bank-bu-worker/dual-parser-dispatch.js(6), src/main-process/bank-bu-worker/spool-contract.js(5), src/main-process/bank-bu-worker/spool-writer.js(3) |
| `normalizeHeaderCell` | 5 | 18 | 4 | src/backend/bank-bu-recon-import/validator.js(5), src/backend/biz-op-recon-import/validator.js(4), src/backend/vcc-op-calc-import/validator.js(4) |
| `ARCHIVE_CONTRACTS` | 5 | 17 | 2 | src/backend/vcc-financial-op/archive-contract.js(7), src/backend/vcc-financial-op/destructive-write.js(3), src/backend/vcc-financial-op/read-snapshot.js(3) |
| `EXCEL_MAX_ROWS` | 5 | 17 | 4 | src/main-process/pre-fund-reconciliation/mpt-error-report-writer.js(5), src/backend/position-reconciliation-import/anomaly-report.js(3), src/main-process/duplicate-inbound-match/excel-writer.js(3) |
| `CancelError` | 5 | 16 | 3 | src/main-process/acquiring-bill-currency-session.js(7), src/backend/big-table-import/pipeline.js(4), src/backend/big-table-import/engine.js(3) |
| `controller` | 5 | 16 | 3 | src/main-process/vcc-op-calc-session.js(4), src/backend/big-table-import/engine.js(3), src/main-process/bank-bu-worker/parser-worker-entry.js(3) |
| `fileSha256` | 5 | 15 | 1 | src/main-process/bank-bu-worker/identity.js(5), src/main-process/new-account/generation-validator.js(4), src/main-process/statement-worker/artifact-descriptor.js(3) |
| `getSourceDefinition` | 5 | 15 | 1 | src/main-process/vcc-financial-op-dataset-writer.js(4), src/backend/vcc-financial-op/definitions.js(3), src/backend/vcc-financial-op/detail-importer.js(3) |
| `hashFileSha256Async` | 5 | 15 | 1 | src/backend/position-reconciliation-import/ledger.js(4), src/main-process/position-reconciliation/input-staging.js(4), src/backend/position-reconciliation-import/anomaly-report.js(3) |
| `inferDateCellFormat` | 5 | 15 | 1 | src/backend/file-service/writers.js(4), src/main-process/toolbox-stream-io.js(4), src/backend/file-service.js(3) |
| `normalizeJobId` | 5 | 15 | 3 | src/main-process/duplicate-inbound-match/spool-contract.js(4), src/main-process/pre-fund-reconciliation/mpt-import/spool-contract.js(4), src/main-process/bank-bu-worker/spool-contract.js(3) |
| `TEMPLATE_BILL_HEADERS` | 5 | 15 | 4 | src/main-process/acquiring-bill-currency-writer.js(6), src/backend/acquiring-bill-currency-db/columns.js(3), src/backend/acquiring-bill-currency-db/import-repository.js(2) |
| `valuesEqual` | 5 | 15 | 1 | src/main-process/scenario-engines/dbs-charge-fund-check.js(6), src/main-process/scenario-engines/c3-gateway-recon-join.js(3), src/main-process/scenario-engines/c2-offset-bill-mark.js(2) |
| `WATERMARK_AUTHOR` | 5 | 15 | 5 | src/main-process/statement-worker/artifact-descriptor.js(4), src/main-process/workbook-watermark.js(4), src/main-process/pre-fund-reconciliation/excel-writer.js(3) |
| `assertFilePlanFresh` | 5 | 14 | 2 | src/main-process/archive-center/task-lifecycle.js(4), src/main-process/new-account/artifact-copy.js(4), src/main-process/archive-center/file-plan.js(2) |
| `bounded` | 5 | 14 | 1 | src/main-process/background-execution/recovery-control-contract.js(5), src/main-process/recon-id-fix-service/jpm-worker-durable-coordinator.js(3), src/main-process/recon-id-fix-service/service.js(3) |
| `MPT_SCHEMAS` | 5 | 14 | 3 | src/main-process/pre-fund-reconciliation/mpt-schema.js(4), src/main-process/pre-fund-reconciliation/mpt-import/spool-reader.js(3), src/main-process/pre-fund-reconciliation/service.js(3) |
| `absoluteDecimal` | 5 | 13 | 2 | src/main-process/pre-fund-reconciliation/bank-row.js(4), src/main-process/scenario-engines/r5-refund-order-backfill.js(3), src/main-process/financial-decimal.js(2) |
| `bankBuSpoolPaths` | 5 | 13 | 1 | src/main-process/bank-bu-worker/spool-filesystem.js(4), src/main-process/bank-bu-worker/parser-outcome.js(3), src/main-process/bank-bu-worker/spool-contract.js(2) |
| `BIZ_OP_HEADERS` | 5 | 13 | 1 | src/main-process/biz-op-recon-writer.js(4), src/backend/biz-op-recon-import/reader-streamed.js(3), src/backend/biz-op-recon-db/columns.js(2) |
| `dayDiffWithin` | 5 | 13 | 5 | src/main-process/scenario-engines/dbs-charge-fund-check.js(3), src/main-process/scenario-engines/r5-fund-transfer-backfill.js(3), src/main-process/scenario-engines/r5-fund-transfer-recon-backfill.js(3) |
| `duplicateSpoolPaths` | 5 | 13 | 1 | src/main-process/duplicate-inbound-match/spool-filesystem.js(4), src/main-process/duplicate-inbound-match/parser-outcome.js(3), src/main-process/duplicate-inbound-match/spool-contract.js(2) |
| `extractMonthKey` | 5 | 13 | 5 | src/backend/acquiring-bill-currency-import/contract-bill.js(3), src/backend/acquiring-bill-currency-import/contract-flow.js(3), src/backend/acquiring-bill-currency-import/reader.js(3) |
| `hashFile` | 5 | 13 | 5 | src/main-process/duplicate-inbound-match/spool-writer.js(4), src/main-process/archive-center/storage-materializer.js(3), src/main-process/duplicate-inbound-match/service.js(2) |
| `insertOperationAudit` | 5 | 13 | 1 | src/backend/vcc-financial-op/calculator.js(3), src/backend/vcc-financial-op/data-target-deletion.js(3), src/backend/vcc-financial-op/operation-audit.js(3) |
| `observationRequestKey` | 5 | 13 | 1 | src/main-process/background-execution/critical/recovery-request-owner-repository.js(4), src/main-process/background-execution/startup-recovery-coordinator.js(3), src/main-process/background-execution/critical/recovery-control-repository.js(2) |
| `pipeline` | 5 | 13 | 5 | src/main-process/archive-center/archive-service.js(4), src/backend/big-table-import/engine.js(3), src/main-process/archive-center/storage-materializer.js(2) |
| `refreshPositionSourceSummary` | 5 | 13 | 1 | src/main-process/position-reconciliation/store.js(4), src/backend/position-reconciliation-import/maintenance-writer.js(3), src/backend/position-reconciliation-import/account-writer.js(2) |
| `assertExcelCellTextLength` | 5 | 12 | 1 | src/backend/position-reconciliation-import/shared-strings-provider.js(3), src/backend/toolbox-format/xlsx-sheet-scanner.js(3), src/backend/toolbox-format/excel-text.js(2) |
| `assertPositionImportDiskSpace` | 5 | 12 | 1 | src/backend/position-reconciliation-import/maintenance-writer.js(4), src/backend/position-reconciliation-import/account-writer.js(2), src/backend/position-reconciliation-import/bank-writer.js(2) |
| `assertSuccessOperationAudit` | 5 | 12 | 1 | src/backend/vcc-financial-op/calculator.js(3), src/backend/vcc-financial-op/data-target-deletion.js(3), src/backend/vcc-financial-op/dataset-deletion.js(2) |
| `collectRunEvidence` | 5 | 12 | 1 | src/backend/vcc-financial-op/calculator.js(3), src/backend/vcc-financial-op/data-target-deletion.js(3), src/backend/vcc-financial-op/dataset-deletion.js(2) |
| `normalizeTargetAliasKey` | 5 | 12 | 3 | src/main-process/toolbox-target-identity.js(4), src/main-process/statement-worker/staging-ownership.js(3), src/main-process/statement-worker/artifact-descriptor.js(2) |
| `persistRolledBackAudit` | 5 | 12 | 1 | src/backend/vcc-financial-op/calculator.js(3), src/backend/vcc-financial-op/data-target-deletion.js(3), src/backend/vcc-financial-op/dataset-deletion.js(2) |
| `positionLargeImportSchemaFingerprint` | 5 | 12 | 1 | src/backend/position-reconciliation-import/source-writer.js(3), src/main-process/position-reconciliation/large-import-schema.js(3), src/backend/position-reconciliation-import/account-writer.js(2) |
| `SHARED_STRINGS_ENTRY_NAME` | 5 | 12 | 3 | src/backend/acquiring-bill-currency-import/reader.js(4), src/backend/pending-import/xlsx-size-preflight.js(4), src/main-process/duplicate-inbound-match/document-statement-reader.js(2) |
| `validateBankDirection` | 5 | 12 | 4 | src/main-process/scenario-engines/dbs-charge-fund-check.js(3), src/main-process/scenario-engines/r4-fund-nature-check.js(3), src/main-process/scenario-engines/bank-direction-validator.js(2) |
| `validateJobEnvelope` | 5 | 12 | 1 | src/main-process/background-execution/protocol.js(3), src/main-process/background-execution/service-host.js(3), src/main-process/background-execution/protocol-validator.js(2) |
| `validateOperationConfirmation` | 5 | 12 | 1 | src/backend/vcc-financial-op/data-target-deletion.js(4), src/backend/vcc-financial-op/dataset-deletion.js(2), src/backend/vcc-financial-op/operation-state.js(2) |
| `writeWorkbookRows` | 5 | 12 | 2 | src/backend/file-service.js(4), src/main-process/statement-generation-business.js(3), src/backend/file-service/writers.js(2) |
| `createSchemaValidator` | 5 | 11 | 4 | src/main-process/background-execution/recovery-source.js(3), src/main-process/background-execution/execution-policy-registry.js(2), src/main-process/background-execution/protocol-validator.js(2) |
| `deriveLinkedRowsForRecord` | 5 | 11 | 1 | src/main-process/position-reconciliation/derivation.js(3), src/backend/position-reconciliation-import/account-writer.js(2), src/backend/position-reconciliation-import/maintenance-writer.js(2) |
| `ensureBackgroundExecutionRecoveryControlSchema` | 5 | 11 | 1 | src/main-process/background-execution/critical/recovery-request-owner-repository.js(3), src/backend/database/archive-repository.js(2), src/backend/database/background-execution-schema.js(2) |
| `evaluateCondition` | 5 | 11 | 1 | src/main-process/scenario-engines/c3-gateway-recon-join.js(3), src/main-process/scenario-engines/c1-extract-recon-id.js(2), src/main-process/scenario-engines/c2-offset-bill-mark.js(2) |
| `isValidInputFingerprint` | 5 | 11 | 3 | src/backend/vcc-financial-op/calculator.js(3), src/backend/vcc-financial-op/archive-contract.js(2), src/backend/vcc-financial-op/result-write.js(2) |
| `normalizeDualImportDescriptor` | 5 | 11 | 3 | src/main-process/bank-bu-worker/spool-reader.js(3), src/main-process/bank-bu-worker/dual-parser-dispatch.js(2), src/main-process/bank-bu-worker/import-operation.js(2) |
| `normalizeExactOperationReceipt` | 5 | 11 | 3 | src/main-process/pre-fund-reconciliation/mpt-import/receipt-authority.js(3), src/main-process/bank-bu-worker/main-coordinator.js(2), src/main-process/bank-bu-worker/operation-receipt-repository.js(2) |
| `normalizeFileIndex` | 5 | 11 | 3 | src/main-process/pre-fund-reconciliation/mpt-import/spool-contract.js(3), src/main-process/pre-fund-reconciliation/mpt-import/ordered-coordinator.js(2), src/main-process/pre-fund-reconciliation/mpt-import/single-writer-session.js(2) |
| `normalizePairedImportDescriptor` | 5 | 11 | 2 | src/main-process/duplicate-inbound-match/spool-reader.js(3), src/main-process/duplicate-inbound-match/paired-parser-dispatch.js(2), src/main-process/duplicate-inbound-match/spool-contract.js(2) |
| `POSITION_IMPORT_PROGRESS_ROW_INTERVAL` | 5 | 11 | 1 | src/backend/position-reconciliation-import/preflight.js(3), src/backend/position-reconciliation-import/account-writer.js(2), src/backend/position-reconciliation-import/bank-writer.js(2) |
| `sameDay` | 5 | 11 | 5 | src/main-process/scenario-engines/r5-refund-order-backfill.js(3), src/main-process/scenario-engines/dbs-charge-fund-check.js(2), src/main-process/scenario-engines/engine-date-utils.js(2) |
| `StableArrayHashAccumulator` | 5 | 11 | 1 | src/backend/position-reconciliation-import/preflight.js(3), src/backend/position-reconciliation-import/account-writer.js(2), src/backend/position-reconciliation-import/bank-writer.js(2) |
| `streamFlowFile` | 5 | 11 | 5 | src/backend/biz-op-recon-import/reader-streamed.js(3), src/backend/biz-op-recon-import/import-worker.js(2), src/backend/vcc-op-calc-import/reader.js(2) |
| `WORKBOOK_ENTRY_NAME` | 5 | 11 | 1 | src/main-process/duplicate-inbound-match/document-statement-reader.js(3), src/backend/big-table-import/zip-reader.js(2), src/backend/position-reconciliation-import/xlsx-reader.js(2) |
| `COMMITTED_AT_PATTERN` | 5 | 10 | 5 | src/backend/database/recon-fix-operation-receipt-repository.js(2), src/main-process/bank-bu-worker/operation-receipt-repository.js(2), src/main-process/duplicate-inbound-match/operation-receipt-repository.js(2) |
| `createRecoveryControlReadRepository` | 5 | 10 | 1 | src/main-process/background-execution/canary/packaged-runtime-runner.js(3), src/main-process/background-execution/critical/recovery-control-read-repository.js(2), src/main-process/background-execution/index.js(2) |
| `createToolboxCell` | 5 | 10 | 1 | src/backend/toolbox-format/biff8-pass.js(2), src/backend/toolbox-format/csv-pass.js(2), src/backend/toolbox-format/model.js(2) |
| `createToolboxRow` | 5 | 10 | 1 | src/backend/toolbox-format/biff8-pass.js(2), src/backend/toolbox-format/csv-pass.js(2), src/backend/toolbox-format/model.js(2) |
| `createToolboxSheetMeta` | 5 | 10 | 1 | src/backend/toolbox-format/biff8-pass.js(2), src/backend/toolbox-format/csv-pass.js(2), src/backend/toolbox-format/model.js(2) |
| `ensureRowId` | 5 | 10 | 1 | src/main-process/scenario-engines/c1-extract-recon-id.js(2), src/main-process/scenario-engines/c2-offset-bill-mark.js(2), src/main-process/scenario-engines/c3-gateway-recon-join.js(2) |
| `generationEvidencePath` | 5 | 10 | 1 | src/main-process/toolbox-background/generation-contract.js(2), src/main-process/toolbox-background/generation-core.js(2), src/main-process/toolbox-background/generation-validator.js(2) |
| `isBlankRow` | 5 | 10 | 1 | src/backend/position-reconciliation-import/xls-reader.js(2), src/backend/position-reconciliation-import/xlsx-reader.js(2), src/main-process/position-reconciliation/common.js(2) |
| `isValidTaskStagingResourceId` | 5 | 10 | 4 | src/main-process/new-account/generation-contract.js(2), src/main-process/read-only-exports/common/contract.js(2), src/main-process/statement-worker/artifact-descriptor.js(2) |
| `LINK_HEADERS` | 5 | 10 | 1 | src/backend/position-reconciliation-import/account-writer.js(2), src/backend/position-reconciliation-import/maintenance-writer.js(2), src/main-process/position-reconciliation/constants.js(2) |
| `listRuns` | 5 | 10 | 2 | src/main-process/bank-bu-recon-session.js(3), src/backend/bank-bu-recon-db/run-repository.js(2), src/backend/vcc-op-calc-db/run-repository.js(2) |
| `locateSheets` | 5 | 10 | 1 | src/backend/toolbox-xlsx-stream/multi-sheet-reader.js(3), src/main-process/duplicate-inbound-match/document-statement-reader.js(3), src/backend/vcc-financial-op/workbook-reader.js(2) |
| `normalizedSaxAttributes` | 5 | 10 | 1 | src/backend/toolbox-format/xlsx-pass.js(3), src/backend/toolbox-format/ooxml-namespaces.js(2), src/backend/toolbox-format/style-registry.js(2) |
| `normalizeFundTransferDatePolicy` | 5 | 10 | 3 | src/main-process/scenario-engines/dbs-charge-fund-check.js(2), src/main-process/scenario-engines/fund-transfer-engine-policy.js(2), src/main-process/scenario-engines/many-to-many-detector.js(2) |
| `ORDER_REPAIR_FIELDS_GATEWAY` | 5 | 10 | 3 | src/constants/gateway-bill-recon-fields.js(2), src/main-process/pre-fund-reconciliation/excel-writer.js(2), src/main-process/recon-id-fix-io.js(2) |
| `verifySealedLedger` | 5 | 10 | 1 | src/backend/position-reconciliation-import/account-writer.js(2), src/backend/position-reconciliation-import/bank-writer.js(2), src/backend/position-reconciliation-import/ledger.js(2) |
| `writeDiffWorkbook` | 5 | 10 | 3 | src/main-process/acquiring-bill-currency-writer.js(3), src/main-process/bank-bu-recon-writer.js(2), src/main-process/bank-bu-worker/export-operation.js(2) |
| `readRowsWithMetadata` | 5 | 8 | 1 | src/backend/file-service.js(3), src/main-process/table-type-detector.js(2), src/backend/file-service/readers.js(1) |
| `deleteTemplate` | 5 | 7 | 1 | src/backend/database.js(2), src/backend/database/template-repository.js(2), src/preload.js(1) |
| `updateRunExportPath` | 5 | 7 | 2 | src/backend/bank-bu-recon-db/run-repository.js(2), src/backend/biz-op-recon-db/run-repository.js(2), src/main-process/bank-bu-recon-run-data.js(1) |
| `deleteSideDb` | 5 | 6 | 1 | src/backend/run-data-store.js(2), src/backend/pre-fund-reconciliation-run-store.js(1), src/main-process/acquiring-bill-currency-run-data.js(1) |
| `normalizeText` | 4 | 97 | 3 | src/backend/database/template-repository.js(57), src/main-process/pre-fund-reconciliation/mpt-schema.js(27), src/backend/database/utils.js(10) |
| `setStatus` | 4 | 91 | 1 | src/renderer.js(36), src/renderer-dialogs.js(34), src/renderer-position-reconciliation.js(20) |
| `trimCell` | 4 | 65 | 3 | src/main-process/pre-fund-reconciliation/matching-engine.js(36), src/main-process/pre-fund-reconciliation/bank-row.js(13), src/main-process/pre-fund-reconciliation/output-mapper.js(12) |
| `coordinatorError` | 4 | 58 | 4 | src/main-process/recon-id-fix-service/jpm-worker-durable-coordinator.js(20), src/main-process/bank-bu-worker/main-coordinator.js(16), src/main-process/vcc-financial-op-output/writer-coordinator.js(13) |
| `scan` | 4 | 54 | 1 | src/main-process/archive-center/storage-root-manager.js(29), src/main-process/archive-center/archive-service.js(20), src/main-process/vcc-op-calc-session.js(4) |
| `step` | 4 | 54 | 1 | src/backend/vcc-financial-op/mutation-policy.js(32), src/backend/vcc-financial-op/destructive-write.js(11), src/backend/vcc-financial-op/result-write.js(10) |
| `linkedTableRepository` | 4 | 52 | 4 | src/backend/database.js(43), src/main-process/fund-recon-worker/evidence-provider.js(5), src/main-process/fund-recon-worker/artifact-generator.js(2) |
| `countRows` | 4 | 50 | 4 | src/backend/vcc-financial-op/destructive-write.js(27), src/backend/vcc-financial-op/detail-importer.js(16), src/backend/vcc-financial-op/operation-state.js(5) |
| `checkedMultiply` | 4 | 30 | 3 | src/main-process/new-account/resource-estimator.js(19), src/main-process/recon-id-fix-service/service.js(7), src/main-process/background-execution/resource-governor.js(2) |
| `datasetHeadRepository` | 4 | 30 | 4 | src/main-process/biz-op-recon-session.js(11), src/backend/biz-op-recon-import/import-worker.js(10), src/main-process/biz-op-recon-run-data.js(5) |
| `reportError` | 4 | 28 | 2 | src/main-process/background-execution/adapters/existing-dispatch-adapter.js(10), src/backend/position-reconciliation-import/preflight.js(9), src/main-process/pre-fund-reconciliation/mpt-error-report-writer.js(5) |
| `setSetting` | 4 | 28 | 1 | src/backend/database/settings-repository.js(20), src/backend/database.js(3), src/main-process/archive-center/controller.js(3) |
| `sourceKey` | 4 | 28 | 1 | src/main-process/read-only-exports/biz-op/query.js(13), src/main-process/biz-op-recon-run-data.js(8), src/main-process/background-execution/startup-recovery-coordinator.js(5) |
| `SYSTEM_OP_HEADERS` | 4 | 28 | 1 | src/backend/vcc-financial-op/system-op-importer.js(12), src/backend/vcc-financial-op/workbook-reader.js(7), src/main-process/vcc-financial-op-dataset-writer.js(5) |
| `centsToAmountString` | 4 | 27 | 1 | src/main-process/vcc-op-calc-session.js(14), src/main-process/vcc-op-calc/ordered-reducer.js(7), src/main-process/vcc-op-calc/save-run-contract.js(4) |
| `emitProgress` | 4 | 27 | 4 | src/main-process/vcc-financial-op-storage-rebuild.js(8), src/backend/vcc-financial-op/destructive-write.js(7), src/backend/vcc-financial-op/result-write.js(7) |
| `getStatus` | 4 | 26 | 1 | src/main-process/app-updater.js(22), src/main-process/run-check-worker-pool.js(2), src/preload.js(1) |
| `pad2` | 4 | 26 | 4 | src/main-process/acquiring-bill-currency-writer.js(11), src/backend/usage-stats.js(6), src/main-process/toolbox.js(5) |
| `nonEmptyText` | 4 | 24 | 2 | src/main-process/toolbox-background/generation-contract.js(12), src/main-process/read-only-exports/common/contract.js(7), src/main-process/read-only-exports/biz-op/actions.js(3) |
| `CANONICAL_ACTION_KEYS` | 4 | 23 | 3 | src/main-process/background-execution/coverage-check.js(8), src/main-process/background-execution/action-manifest.js(6), src/main-process/background-execution/production-strategy-snapshot.js(5) |
| `MATCH_TYPES` | 4 | 23 | 1 | src/main-process/position-reconciliation/store.js(10), src/main-process/position-reconciliation/service.js(9), src/main-process/position-reconciliation/constants.js(2) |
| `ACQUIRING_ADAPTER_ACTIONS` | 4 | 22 | 1 | src/main-process/background-execution/adapters/acquiring-adapter.js(9), src/main-process/background-execution/acquiring-adapter-policies.js(7), src/main-process/background-execution/mature-action-adapters.js(4) |
| `FIXED_FIELD_VALUE_PREFIX` | 4 | 21 | 2 | src/backend/file-service.js(13), src/backend/database/utils.js(5), src/backend/file-service/common.js(2) |
| `importsRepository` | 4 | 21 | 4 | src/main-process/biz-op-recon-run-data.js(10), src/main-process/biz-op-recon-session.js(5), src/backend/biz-op-recon-import/import-worker.js(3) |
| `PRESERVED_OPERATIONS` | 4 | 21 | 1 | src/backend/vcc-financial-op/preserved-state.js(10), src/backend/vcc-financial-op/data-target-deletion.js(5), src/backend/vcc-financial-op/dataset-deletion.js(3) |
| `SHA256` | 4 | 21 | 4 | src/main-process/new-account/artifact-copy.js(6), src/main-process/new-account/generation-contract.js(6), src/main-process/statement-worker/artifact-descriptor.js(6) |
| `isCanonicalFundTransferOwner` | 4 | 19 | 1 | src/renderer-dialogs.js(7), src/backend/database/scenarios-repository.js(6), src/main-process/fund-transfer-date-policy.js(4) |
| `numericValue` | 4 | 19 | 1 | src/backend/file-service/normalizers.js(9), src/backend/file-service/writers.js(4), src/main-process/toolbox-stream-io.js(4) |
| `POSITION_IMPORT_ADAPTER_ACTION` | 4 | 19 | 1 | src/main-process/background-execution/position-import-adapter-policy.js(12), src/main-process/background-execution/runtime.js(3), src/main-process/background-execution/adapters/position-import-adapter.js(2) |
| `TOOLBOX_SHEET_STRATEGIES` | 4 | 19 | 2 | src/main-process/toolbox-format-io.js(10), src/main-process/toolbox-format-operations.js(5), src/main-process/toolbox-background/route-db-sealer.js(2) |
| `importRepo` | 4 | 18 | 4 | src/main-process/acquiring-bill-currency-session.js(7), src/backend/acquiring-bill-currency-import/reader.js(5), src/main-process/acquiring-bill-currency-run-data.js(5) |
| `nextId` | 4 | 18 | 1 | src/main-process/recon-id-fix-service/worker-entry.js(8), src/backend/database/scenarios-repository.js(4), src/main-process/background-execution/resource-governor.js(3) |
| `parseObjectJson` | 4 | 18 | 4 | src/backend/duplicate-inbound-match-store.js(6), src/backend/database/archive-repository.js(5), src/main-process/read-only-exports/pre-fund/query.js(5) |
| `RECON_FIX_JPM_UNIT_ID` | 4 | 18 | 1 | src/main-process/recon-id-fix-service/worker-entry.js(11), src/main-process/recon-id-fix-service/jpm-worker-durable-coordinator.js(3), src/main-process/background-execution/runtime.js(2) |
| `textValue` | 4 | 18 | 1 | src/backend/file-service/writers.js(10), src/main-process/pre-fund-reconciliation/mpt-import/conflict-scope.js(3), src/renderer-dialogs.js(3) |
| `DUPLICATE_ACTIONS` | 4 | 17 | 2 | src/main-process/duplicate-inbound-match/policies.js(6), src/main-process/background-execution/runtime.js(4), src/main-process/duplicate-inbound-match/managed-service.js(4) |
| `MERCHANT_ID_SELF_INPUT_OPTION` | 4 | 17 | 2 | src/renderer.js(8), src/renderer-dialogs.js(6), src/renderer-previews.js(2) |
| `mirrorRepository` | 4 | 17 | 4 | src/main-process/duplicate-inbound-match/mirror-database.js(7), src/main-process/duplicate-inbound-match/startup-recovery.js(4), src/main-process/duplicate-inbound-match/startup-gate.js(3) |
| `POSITION_IMPORT_ENGINES` | 4 | 17 | 1 | src/main-process/position-reconciliation/service.js(8), src/backend/position-reconciliation-import/constants.js(5), src/main-process/background-execution/adapters/position-import-adapter.js(2) |
| `writeErrorReport` | 4 | 17 | 1 | src/main-process/biz-op-recon-session.js(13), src/main-process/exceljs-writer.js(2), src/main-process/bank-statement-io.js(1) |
| `normalizeReceiptPayload` | 4 | 16 | 4 | src/backend/database/recon-fix-operation-receipt-repository.js(4), src/main-process/bank-bu-worker/operation-receipt-repository.js(4), src/main-process/duplicate-inbound-match/operation-receipt-repository.js(4) |
| `readPositionDatabaseCheckpoint` | 4 | 16 | 1 | src/main-process/position-reconciliation/large-import-schema.js(5), src/main-process/position-reconciliation/store.js(5), src/main-process/position-reconciliation/side-db-mutation.js(4) |
| `recoveryHoldGate` | 4 | 15 | 1 | src/main-process/pre-fund-reconciliation/mpt-import/hold-gate.js(6), src/main-process/manual-balance-seed-settlement.js(5), src/main-process/recon-id-fix-service/jpm-hold-gate.js(3) |
| `SOURCE_TYPE_INBOUND` | 4 | 15 | 1 | src/main-process/pre-fund-reconciliation/mpt-schema.js(7), src/main-process/duplicate-inbound-match/service.js(3), src/main-process/pre-fund-reconciliation/mpt-error-report-writer.js(3) |
| `YELLOW_FILL` | 4 | 15 | 4 | src/main-process/bank-bu-recon-writer.js(6), src/main-process/biz-op-recon-writer.js(4), src/main-process/exceljs-writer.js(3) |
| `BALANCE_CALCULATED_OPTION` | 4 | 14 | 2 | src/renderer-dialogs.js(5), src/renderer.js(5), src/renderer-previews.js(3) |
| `channelsRepository` | 4 | 14 | 4 | src/backend/database.js(8), src/main-process/fund-recon-worker/evidence-provider.js(3), src/main-process/fund-recon-worker/artifact-generator.js(2) |
| `DELETE_TARGET_LABELS` | 4 | 14 | 2 | src/backend/vcc-financial-op/data-target-deletion.js(6), src/backend/vcc-financial-op/read-snapshot.js(4), src/backend/vcc-financial-op/destructive-write.js(3) |
| `OFFICE_RELATIONSHIP_NAMESPACES` | 4 | 14 | 2 | src/backend/toolbox-format/xlsx-pass.js(7), src/main-process/toolbox-output-writer.js(3), src/backend/toolbox-format/ooxml-namespaces.js(2) |
| `STATE_CHANGED_CODE` | 4 | 14 | 1 | src/backend/vcc-financial-op/destructive-write.js(4), src/backend/vcc-financial-op/operation-state.js(4), src/backend/vcc-financial-op/result-write.js(3) |
| `STATE_CHANGED_MESSAGE` | 4 | 14 | 1 | src/backend/vcc-financial-op/destructive-write.js(4), src/backend/vcc-financial-op/operation-state.js(4), src/backend/vcc-financial-op/result-write.js(3) |
| `ADM_TABLE` | 4 | 13 | 2 | src/backend/database/linked-table-repository.js(6), src/backend/database/linked-table-writeback-reader.js(3), src/main-process/recon-id-fix-service/jpm-writeback-transaction.js(2) |
| `BIZ_OP_READ_ONLY_ACTIONS` | 4 | 13 | 2 | src/main-process/read-only-exports/biz-op/policies.js(5), src/main-process/read-only-exports/biz-op/writer.js(4), src/main-process/read-only-exports/biz-op/actions.js(3) |
| `createStaticRegistry` | 4 | 13 | 1 | src/main-process/background-execution/runtime.js(6), src/main-process/background-execution/canary/packaged-runtime-runner.js(3), src/main-process/background-execution/execution-policy-registry.js(2) |
| `DecimalAccumulator` | 4 | 13 | 3 | src/backend/vcc-financial-op/calculator.js(4), src/backend/vcc-financial-op/result-adjustments.js(4), src/backend/vcc-financial-op/decimal-accumulator.js(3) |
| `financeSafeTextViolation` | 4 | 13 | 2 | src/main-process/background-execution/error-codec.js(7), src/main-process/pre-fund-reconciliation/mpt-import/file-result-safety.js(2), src/main-process/recon-id-fix-service/policies.js(2) |
| `formatDateLabel` | 4 | 13 | 3 | src/main-process/statement-generation-business.js(6), src/main-process/manual-balance-seed-preflight.js(3), src/main-process/new-account/generation-core.js(2) |
| `getRunChunkProgress` | 4 | 13 | 1 | src/main-process/acquiring-bill-currency-session.js(5), src/backend/acquiring-bill-currency-db/run-repository.js(4), src/main-process/acquiring-bill-currency-run-data.js(3) |
| `normalizeInputFilePaths` | 4 | 13 | 1 | src/main-process/manual-balance-seed-preflight.js(4), src/main-process/statement-generation.js(4), src/main.js(3) |
| `normalizeOperationMonth` | 4 | 13 | 1 | src/backend/vcc-financial-op/unarchive.js(4), src/backend/vcc-financial-op/data-target-deletion.js(3), src/backend/vcc-financial-op/operation-state.js(3) |
| `rowValues` | 4 | 13 | 3 | src/main-process/duplicate-inbound-match/excel-writer.js(4), src/main-process/position-reconciliation/readers.js(4), src/backend/position-reconciliation-import/xls-reader.js(3) |
| `snapshotPreservedOperationState` | 4 | 13 | 1 | src/backend/vcc-financial-op/data-target-deletion.js(5), src/backend/vcc-financial-op/dataset-deletion.js(3), src/backend/vcc-financial-op/unarchive.js(3) |
| `toExcelSerial` | 4 | 13 | 1 | src/backend/file-service/writers.js(4), src/main-process/toolbox-stream-io.js(4), src/backend/file-service.js(3) |
| `validateResourceVector` | 4 | 13 | 3 | src/main-process/background-execution/resource-governor.js(7), src/main-process/background-execution/resource-lease.js(2), src/main-process/background-execution/supervisor.js(2) |
| `BANK_STATUSES` | 4 | 12 | 1 | src/main-process/position-reconciliation/service.js(4), src/main-process/position-reconciliation/store.js(4), src/backend/position-reconciliation-import/bank-writer.js(2) |
| `BILL_KEY_COLUMN_INDICES` | 4 | 12 | 4 | src/backend/acquiring-bill-currency-import/contract-bill.js(6), src/backend/acquiring-bill-currency-import/reader.js(3), src/backend/acquiring-bill-currency-db/columns.js(2) |
| `buildOperationState` | 4 | 12 | 1 | src/backend/vcc-financial-op/unarchive.js(5), src/backend/vcc-financial-op/dataset-deletion.js(3), src/backend/vcc-financial-op/data-target-deletion.js(2) |
| `dayDiffAbs` | 4 | 12 | 1 | src/main-process/scenario-engines/dbs-charge-fund-check.js(3), src/main-process/scenario-engines/r5-fund-transfer-backfill.js(3), src/main-process/scenario-engines/r5-fund-transfer-recon-backfill.js(3) |
| `DETAIL_SOURCE_TYPES` | 4 | 12 | 3 | src/backend/vcc-financial-op/destructive-write.js(4), src/backend/vcc-financial-op/detail-importer.js(4), src/backend/vcc-financial-op/dataset-deletion.js(2) |
| `getLinkedTableMeta` | 4 | 12 | 1 | src/backend/database/linked-table-repository.js(6), src/main-process/pre-fund-reconciliation/service.js(3), src/backend/database.js(2) |
| `getRunMirror` | 4 | 12 | 2 | src/backend/database/duplicate-inbound-match-run-repository.js(4), src/backend/database/pre-fund-reconciliation-run-repository.js(4), src/backend/database.js(2) |
| `policyByAction` | 4 | 12 | 1 | src/main-process/background-execution/action-manifest.js(6), src/main-process/background-execution/capability-inventory.js(2), src/main-process/background-execution/coverage-check.js(2) |
| `readEntryAsString` | 4 | 12 | 1 | src/main-process/toolbox-output-writer.js(4), src/backend/big-table-import/zip-reader.js(3), src/main-process/recon-id-fix-service/artifact-evidence.js(3) |
| `sanitizeSheetName` | 4 | 12 | 4 | src/backend/pending-export/writer.js(3), src/main-process/acquiring-bill-currency-writer.js(3), src/main-process/toolbox-output-writer.js(3) |
| `VCC_EXPORT_SUBJECTS_MAX_WRITERS` | 4 | 12 | 2 | src/main-process/vcc-financial-op-output/policies.js(4), src/main-process/vcc-financial-op-output/shard-planner.js(3), src/main-process/vcc-financial-op-output/topology.js(3) |
| `ADVANCED_MAPPING_FIELDS` | 4 | 11 | 2 | src/renderer-previews.js(4), src/renderer.js(4), src/renderer-dialogs.js(2) |
| `applyHeaderRowFont` | 4 | 11 | 3 | src/backend/pending-export/error-report-writer.js(4), src/backend/file-service/writers.js(3), src/backend/pending-export/writer.js(2) |
| `FLOW_KEY_COLUMN_INDICES` | 4 | 11 | 4 | src/backend/acquiring-bill-currency-import/contract-flow.js(4), src/backend/acquiring-bill-currency-import/reader.js(3), src/backend/acquiring-bill-currency-db/columns.js(2) |
| `mptSpoolPaths` | 4 | 11 | 2 | src/main-process/pre-fund-reconciliation/mpt-import/spool-writer.js(5), src/main-process/pre-fund-reconciliation/mpt-import/parser-outcome.js(2), src/main-process/pre-fund-reconciliation/mpt-import/spool-contract.js(2) |
| `normalizeTransactionNo` | 4 | 11 | 4 | src/main-process/boc-fx-link-builder.js(5), src/backend/database/linked-table-repository.js(2), src/backend/database/migrations.js(2) |
| `parseMptFileName` | 4 | 11 | 2 | src/backend/pre-fund-reconciliation-store.js(3), src/main-process/pre-fund-reconciliation/mpt-import/file-result-safety.js(3), src/main-process/pre-fund-reconciliation/mpt-parser.js(3) |
| `PENDING_V1_HEADERS` | 4 | 11 | 1 | src/backend/vcc-financial-op/definitions.js(4), src/backend/vcc-financial-op/row-mapper.js(3), src/backend/vcc-financial-op-db/migrations.js(2) |
| `readAdmRowsForWriteback` | 4 | 11 | 1 | src/main-process/recon-id-fix-service/jpm-writeback-transaction.js(4), src/main-process/recon-id-fix-service/service.js(3), src/backend/database/linked-table-writeback-reader.js(2) |
| `safeMptFileName` | 4 | 11 | 2 | src/main-process/pre-fund-reconciliation/mpt-import/file-result-safety.js(3), src/main-process/pre-fund-reconciliation/mpt-import/parser-outcome.js(3), src/main-process/pre-fund-reconciliation/mpt-import/policies.js(3) |
| `sameReceiptPayload` | 4 | 11 | 4 | src/backend/database/recon-fix-operation-receipt-repository.js(5), src/main-process/bank-bu-worker/operation-receipt-repository.js(2), src/main-process/duplicate-inbound-match/operation-receipt-repository.js(2) |
| `STAGING_RELATIVE_PATH` | 4 | 11 | 1 | src/main-process/position-reconciliation/input-staging.js(5), src/backend/position-reconciliation-import/preflight.js(2), src/main-process/position-reconciliation/import-dispatch.js(2) |
| `streamToolboxTables` | 4 | 11 | 2 | src/main-process/toolbox-format-operations.js(5), src/main-process/toolbox-background/route-db-sealer.js(2), src/main-process/toolbox-format-io.js(2) |
| `ACQUIRING_EXPORT_ACTION_SET` | 4 | 10 | 2 | src/main-process/read-only-exports/acquiring/policies.js(4), src/main-process/background-execution/runtime.js(2), src/main-process/read-only-exports/acquiring/actions.js(2) |
| `assertPreviewToken` | 4 | 10 | 1 | src/backend/vcc-financial-op/data-target-deletion.js(3), src/backend/vcc-financial-op/dataset-deletion.js(3), src/backend/vcc-financial-op/operation-state.js(2) |
| `AUDIT_HEADERS` | 4 | 10 | 1 | src/main-process/position-reconciliation/contracts.js(4), src/main-process/position-reconciliation/constants.js(3), src/main-process/position-reconciliation/readers.js(2) |
| `BANK_BU_SPOOL_SCHEMA_VERSION` | 4 | 10 | 1 | src/main-process/bank-bu-worker/parser-outcome.js(3), src/main-process/bank-bu-worker/spool-writer.js(3), src/main-process/bank-bu-worker/spool-contract.js(2) |
| `BIZ_OP_READ_ONLY_ACTION_SET` | 4 | 10 | 2 | src/main-process/read-only-exports/biz-op/policies.js(4), src/main-process/background-execution/runtime.js(2), src/main-process/read-only-exports/biz-op/actions.js(2) |
| `CHANNEL_BILL_FIELDS` | 4 | 10 | 2 | src/renderer-dialogs.js(4), src/constants/gateway-bill-recon-fields.js(2), src/main-process/recon-id-fix-io.js(2) |
| `createChannel` | 4 | 10 | 2 | src/backend/position-reconciliation-import/worker-entry.js(3), src/main-process/scenarios-bundle-import.js(3), src/backend/database.js(2) |
| `DUPLICATE_SPOOL_SCHEMA_VERSION` | 4 | 10 | 1 | src/main-process/duplicate-inbound-match/parser-outcome.js(3), src/main-process/duplicate-inbound-match/spool-writer.js(3), src/main-process/duplicate-inbound-match/spool-contract.js(2) |
| `emptyStats` | 4 | 10 | 1 | src/backend/position-reconciliation-import/preflight.js(4), src/backend/position-reconciliation-import/account-writer.js(2), src/backend/position-reconciliation-import/bank-writer.js(2) |
| `ensureBizOpReconTablesSupport` | 4 | 10 | 4 | src/backend/database.js(4), src/backend/biz-op-recon-db/migrations.js(2), src/backend/biz-op-recon-import/import-worker.js(2) |
| `exactSaxLocalName` | 4 | 10 | 1 | src/backend/toolbox-format/xlsx-pass.js(4), src/backend/toolbox-format/style-registry.js(3), src/backend/toolbox-format/ooxml-namespaces.js(2) |
| `freezePersistedTaskOwner` | 4 | 10 | 1 | src/main-process/archive-center/controller.js(4), src/main-process/position-reconciliation/operation-lifecycle.js(3), src/main-process/archive-center/worker-operation-context.js(2) |
| `NEW_ACCOUNT_GENERATION_ACTION` | 4 | 10 | 3 | src/main-process/new-account/generation-validator.js(4), src/main-process/new-account/generation-contract.js(2), src/main-process/new-account/policies.js(2) |
| `performance` | 4 | 10 | 3 | src/main-process/vcc-financial-op-read-worker.js(3), src/renderer.js(3), src/backend/startup-phase.js(2) |
| `POSITION_IMPORT_PROTOCOL_VERSION` | 4 | 10 | 1 | src/backend/position-reconciliation-import/ledger.js(4), src/backend/position-reconciliation-import/constants.js(2), src/backend/position-reconciliation-import/worker-entry.js(2) |
| `PRE_FUND_READ_ONLY_ACTION_SET` | 4 | 10 | 2 | src/main-process/read-only-exports/pre-fund/policies.js(4), src/main-process/read-only-exports/pre-fund/actions.js(2), src/main-process/read-only-exports/pre-fund/managed-export.js(2) |
| `PRE_FUND_READ_ONLY_ACTIONS` | 4 | 10 | 1 | src/main-process/read-only-exports/pre-fund/policies.js(5), src/main-process/read-only-exports/pre-fund/actions.js(2), src/main-process/read-only-exports/pre-fund/managed-export.js(2) |
| `readerFor` | 4 | 10 | 1 | src/backend/position-reconciliation-import/preflight.js(4), src/backend/position-reconciliation-import/account-writer.js(2), src/backend/position-reconciliation-import/bank-writer.js(2) |
| `TOOLBOX_GENERATION_EVIDENCE_MAX_BYTES` | 4 | 10 | 1 | src/main-process/toolbox-background/generation-contract.js(4), src/main-process/toolbox-background/generation-core.js(2), src/main-process/toolbox-background/generation-validator.js(2) |
| `ToolboxHeaderMismatchError` | 4 | 10 | 4 | src/main-process/toolbox.js(4), src/backend/toolbox-xlsx-stream/multi-sheet-reader.js(2), src/main-process/toolbox-format-io.js(2) |
| `assertStagedInputUnchangedAsync` | 4 | 9 | 1 | src/backend/position-reconciliation-import/source-writer.js(3), src/backend/position-reconciliation-import/account-writer.js(2), src/backend/position-reconciliation-import/bank-writer.js(2) |
| `BALANCE_SEED_GENERATION_METHODS` | 4 | 9 | 1 | src/main-process/manual-balance-seed-preflight.js(4), src/main-process/statement-generation-business.js(3), src/backend/balance-seed-store.js(1) |
| `BANK_BU_SINGLETON_UNIT_ID` | 4 | 9 | 4 | src/main-process/bank-bu-worker/dual-parser-dispatch.js(3), src/main-process/bank-bu-worker/main-coordinator.js(2), src/main-process/bank-bu-worker/singleton-unit.js(2) |
| `BANK_HEADERS` | 4 | 9 | 1 | src/main-process/bank-bu-recon-writer.js(3), src/backend/bank-bu-recon-db/columns.js(2), src/backend/bank-bu-recon-import/reader.js(2) |
| `buildRunRowKey` | 4 | 9 | 3 | src/backend/vcc-financial-op/result-adjustments.js(3), src/backend/vcc-financial-op/archive-evidence.js(2), src/backend/vcc-financial-op/calculator.js(2) |
| `classifyArchiveContract` | 4 | 9 | 1 | src/backend/vcc-financial-op/read-snapshot.js(3), src/backend/vcc-financial-op/archive-contract.js(2), src/backend/vcc-financial-op/destructive-write.js(2) |
| `createJobEnvelope` | 4 | 9 | 3 | src/main-process/background-execution/supervisor.js(4), src/main-process/background-execution/adapters/canonical-event-emitter.js(2), src/main-process/background-execution/protocol.js(2) |
| `createToolboxOutputWriter` | 4 | 9 | 4 | src/main-process/toolbox-output-writer.js(3), src/main-process/toolbox-background/output-writer-core.js(2), src/main-process/toolbox-format-operations.js(2) |
| `deriveReconFixJpmConflictScopeKey` | 4 | 9 | 4 | src/main-process/recon-id-fix-service/jpm-worker-durable-coordinator.js(3), src/main-process/recon-id-fix-service/jpm-conflict-scope.js(2), src/main-process/recon-id-fix-service/jpm-hold-gate.js(2) |
| `dispatchEngineImport` | 4 | 9 | 4 | src/main-process/acquiring-bill-currency-session.js(3), src/main-process/big-table-import-dispatch.js(2), src/main-process/biz-op-recon-session.js(2) |
| `getBankRows` | 4 | 9 | 1 | src/main-process/position-reconciliation/service.js(4), src/backend/bank-bu-recon-db/month-repository.js(2), src/main-process/position-reconciliation/store.js(2) |
| `getRecoveryAuditBySource` | 4 | 9 | 1 | src/backend/database/duplicate-inbound-match-run-repository.js(3), src/main-process/duplicate-inbound-match/startup-recovery.js(3), src/main-process/duplicate-inbound-match/startup-gate.js(2) |
| `hashSourceFiles` | 4 | 9 | 3 | src/backend/vcc-financial-op/detail-importer.js(3), src/backend/vcc-financial-op/import-service.js(2), src/backend/vcc-financial-op/source-lineage.js(2) |
| `mapReceipt` | 4 | 9 | 4 | src/main-process/duplicate-inbound-match/operation-receipt-repository.js(3), src/backend/database/recon-fix-operation-receipt-repository.js(2), src/main-process/bank-bu-worker/operation-receipt-repository.js(2) |
| `MODULE_ACQUIRING` | 4 | 9 | 1 | src/backend/run-data-store.js(4), src/main-process/background-execution/adapters/acquiring-adapter.js(3), src/main-process/acquiring-bill-currency-run-data.js(1) |
| `normalizeRecoveryInspectionResult` | 4 | 9 | 1 | src/main-process/background-execution/recovery-source.js(3), src/main-process/background-execution/startup-recovery-coordinator.js(2), src/main-process/pre-fund-reconciliation/mpt-import/receipt-authority.js(2) |
| `operationPreviewToken` | 4 | 9 | 1 | src/backend/vcc-financial-op/dataset-deletion.js(3), src/backend/vcc-financial-op/data-target-deletion.js(2), src/backend/vcc-financial-op/operation-state.js(2) |
| `parseMptFile` | 4 | 9 | 3 | src/main-process/pre-fund-reconciliation/mpt-error-report-writer.js(3), src/backend/pre-fund-reconciliation-store.js(2), src/main-process/pre-fund-reconciliation/mpt-import/parser-core.js(2) |
| `parseStrictJson` | 4 | 9 | 1 | src/main-process/background-execution/recovery-control-contract.js(3), src/backend/database/linked-table-writeback-reader.js(2), src/main-process/background-execution/canonical-json-v1.js(2) |
| `parseWorkbookXml` | 4 | 9 | 2 | src/backend/toolbox-format/xlsx-pass.js(3), src/backend/position-reconciliation-import/xlsx-reader.js(2), src/backend/vcc-financial-op/workbook-reader.js(2) |
| `PENDING_GUANLI_HEADERS` | 4 | 9 | 1 | src/main-process/bank-bu-recon-writer.js(3), src/backend/bank-bu-recon-db/columns.js(2), src/backend/bank-bu-recon-import/reader.js(2) |
| `readXlsxStreamed` | 4 | 9 | 4 | src/main-process/toolbox-stream-io.js(3), src/backend/file-service/readers.js(2), src/backend/pending-import/worker.js(2) |
| `refreshImportRecordArchiveState` | 4 | 9 | 1 | src/backend/vcc-financial-op-db/repository.js(3), src/main-process/vcc-financial-op-archive-lineage.js(3), src/backend/vcc-financial-op/import-service.js(2) |
| `sameDuplicateSideDbRelPath` | 4 | 9 | 1 | src/main-process/duplicate-inbound-match/service.js(3), src/backend/database/duplicate-inbound-match-run-repository.js(2), src/backend/duplicate-inbound-match-side-db-identity.js(2) |
| `SchemaValidationError` | 4 | 9 | 3 | src/main-process/background-execution/schema-validator.js(3), src/main-process/background-execution/protocol-validator.js(2), src/main-process/background-execution/recovery-control-contract.js(2) |
| `startStartupPhase` | 4 | 9 | 3 | src/backend/startup-phase.js(4), src/backend/database.js(2), src/main-process/archive-center/controller.js(2) |
| `styleHeader` | 4 | 9 | 4 | src/main-process/vcc-financial-op-dataset-writer.js(3), src/backend/position-reconciliation-import/anomaly-report.js(2), src/main-process/position-reconciliation/filtered-source-report.js(2) |
| `validateNewAccountGenerationResult` | 4 | 9 | 1 | src/main-process/new-account/generation-contract.js(3), src/main-process/background-execution/runtime.js(2), src/main-process/new-account/artifact-copy.js(2) |
| `validateServiceControlEnvelope` | 4 | 9 | 1 | src/main-process/background-execution/protocol.js(3), src/main-process/background-execution/protocol-validator.js(2), src/main-process/background-execution/service-host.js(2) |
| `validateVccExportSubjectsResult` | 4 | 9 | 1 | src/main-process/vcc-financial-op-output/policies.js(3), src/main-process/background-execution/runtime.js(2), src/main-process/vcc-financial-op-output/dispatch.js(2) |
| `WORKER_BATCH_CONTEXT_FIELDS` | 4 | 9 | 1 | src/main-process/archive-center/worker-batch-context.js(3), src/main-process/background-execution/adapters/acquiring-adapter.js(2), src/main-process/background-execution/adapters/position-import-adapter.js(2) |
| `addOneDay` | 4 | 8 | 1 | src/main-process/biz-op-recon-run-data.js(3), src/backend/biz-op-recon-import/import-worker.js(2), src/main-process/biz-op-recon-session.js(2) |
| `buildDetailExportRows` | 4 | 8 | 1 | src/main-process/statement-generation-business.js(3), src/backend/file-service.js(2), src/main-process/statement-generation.js(2) |
| `BUSINESS_BILL_FIELDS` | 4 | 8 | 2 | src/constants/recon-id-fix-fields.js(2), src/main-process/recon-id-fix-io.js(2), src/preload.js(2) |
| `classifySourceRow` | 4 | 8 | 1 | src/backend/position-reconciliation-import/contracts.js(2), src/backend/position-reconciliation-import/preflight.js(2), src/backend/position-reconciliation-import/source-writer.js(2) |
| `clearRunsAndDiffsByDateBu` | 4 | 8 | 1 | src/backend/biz-op-recon-db/run-repository.js(2), src/backend/biz-op-recon-import/import-worker.js(2), src/main-process/biz-op-recon-run-data.js(2) |
| `createExecutionPolicyRegistry` | 4 | 8 | 1 | src/main-process/background-execution/canary/packaged-runtime-runner.js(2), src/main-process/background-execution/execution-policy-registry.js(2), src/main-process/background-execution/index.js(2) |
| `createExecutionSupervisor` | 4 | 8 | 4 | src/main-process/background-execution/canary/packaged-runtime-runner.js(2), src/main-process/background-execution/index.js(2), src/main-process/background-execution/runtime.js(2) |
| `createRecoveryControlRepository` | 4 | 8 | 1 | src/main-process/background-execution/canary/packaged-runtime-runner.js(3), src/main-process/background-execution/critical/recovery-control-repository.js(2), src/main-process/background-execution/index.js(2) |
| `createRecoveryRequestOwnerRepository` | 4 | 8 | 1 | src/main-process/background-execution/canary/packaged-runtime-runner.js(3), src/main-process/background-execution/critical/recovery-request-owner-repository.js(2), src/main-process/background-execution/index.js(2) |
| `createResourceGovernor` | 4 | 8 | 4 | src/main-process/background-execution/canary/packaged-runtime-runner.js(2), src/main-process/background-execution/index.js(2), src/main-process/background-execution/resource-governor.js(2) |
| `createUtilityProcessAdapter` | 4 | 8 | 4 | src/main-process/background-execution/adapters/utility-process-adapter.js(2), src/main-process/background-execution/index.js(2), src/main-process/background-execution/service-host.js(2) |
| `createWorkerThreadAdapter` | 4 | 8 | 4 | src/main-process/background-execution/adapters/worker-thread-adapter.js(2), src/main-process/background-execution/index.js(2), src/main-process/background-execution/service-host.js(2) |
| `detectToolboxInputKind` | 4 | 8 | 4 | src/main-process/toolbox-format-io.js(2), src/main-process/toolbox-input-kind.js(2), src/main-process/toolbox-large-split-router.js(2) |
| `diagnoseFirstMonthFacts` | 4 | 8 | 2 | src/backend/vcc-financial-op-db/migrations.js(2), src/backend/vcc-financial-op-db/repository.js(2), src/backend/vcc-financial-op-db/state-model.js(2) |
| `dispatchPositionLargeImportSchemaMigration` | 4 | 8 | 1 | src/main-process/position-reconciliation/service.js(3), src/main-process/background-execution/adapters/position-import-adapter.js(2), src/main-process/position-reconciliation/import-dispatch.js(2) |
| `ensureCanaryReceiptSchema` | 4 | 8 | 3 | src/main-process/background-execution/canary/canary-schema.js(2), src/main-process/background-execution/canary/durable-recovery.js(2), src/main-process/background-execution/canary/durable-worker.js(2) |
| `executeRun` | 4 | 8 | 2 | src/main-process/bank-bu-worker/run-operation.js(2), src/main-process/bank-bu-worker/worker-host.js(2), src/main-process/duplicate-inbound-match/managed-service.js(2) |
| `filterStagingPathsWithoutProtectedSources` | 4 | 8 | 1 | src/main-process/position-reconciliation/service.js(3), src/main-process/position-reconciliation/import-dispatch.js(2), src/main-process/position-reconciliation/input-staging.js(2) |
| `getRowsByDateBu` | 4 | 8 | 2 | src/main-process/biz-op-recon-session.js(3), src/backend/biz-op-recon-db/flow-imports-repository.js(2), src/backend/biz-op-recon-db/imports-repository.js(2) |
| `listTemplates` | 4 | 8 | 1 | src/backend/database/template-repository.js(3), src/backend/database.js(2), src/main-process/monthly-balance.js(2) |
| `MODULE_PRE_FUND_RECONCILIATION` | 4 | 8 | 1 | src/backend/run-data-store.js(5), src/backend/pre-fund-reconciliation-store.js(1), src/main-process/pre-fund-reconciliation/mpt-import/outcome-inspector.js(1) |
| `MODULE_PRE_FUND_RECONCILIATION_RESULTS` | 4 | 8 | 1 | src/backend/run-data-store.js(5), src/backend/pre-fund-reconciliation-run-store.js(1), src/main-process/pre-fund-reconciliation/service.js(1) |
| `normalizeGenerationEvidence` | 4 | 8 | 1 | src/main-process/toolbox-background/generation-contract.js(2), src/main-process/toolbox-background/generation-core.js(2), src/main-process/toolbox-background/generation-validator.js(2) |
| `normalizeManifestSource` | 4 | 8 | 2 | src/main-process/bank-bu-worker/spool-contract.js(2), src/main-process/bank-bu-worker/spool-reader.js(2), src/main-process/duplicate-inbound-match/spool-contract.js(2) |
| `normalizeMultiSplitInput` | 4 | 8 | 1 | src/main-process/toolbox-background/generation-contract.js(2), src/main-process/toolbox-background/multi-output-validator.js(2), src/main-process/toolbox-background/output-writer-core.js(2) |
| `openVccReadDatabase` | 4 | 8 | 4 | src/backend/vcc-financial-op/read-schema.js(2), src/main-process/read-only-exports/vcc-financial-op/query.js(2), src/main-process/vcc-financial-op-output/writer-core.js(2) |
| `OPPONENT_BILL_FIELDS` | 4 | 8 | 2 | src/constants/recon-id-fix-fields.js(2), src/main-process/recon-id-fix-io.js(2), src/preload.js(2) |
| `publishToolboxPublicationAsync` | 4 | 8 | 2 | src/main-process/toolbox-output-publication-dispatch.js(3), src/main-process/recon-id-fix-service/export-operation.js(2), src/main-process/vcc-financial-op-output-recovery.js(2) |
| `readLinkedTableRows` | 4 | 8 | 1 | src/main-process/linked-derive-rebuild.js(3), src/backend/database.js(2), src/backend/database/linked-table-repository.js(2) |
| `recoverToolboxPublicationsAsync` | 4 | 8 | 1 | src/main-process/toolbox-output-publication-dispatch.js(3), src/main-process/new-account/artifact-copy.js(2), src/main-process/vcc-financial-op-output-recovery.js(2) |
| `resolveSinglePreparedFieldValue` | 4 | 8 | 1 | src/main-process/statement-generation.js(3), src/main-process/statement-generation-business.js(2), src/main-process/statement-session.js(2) |
| `saveBillSplitAmountRules` | 4 | 8 | 1 | src/renderer-dialogs.js(3), src/backend/database.js(2), src/backend/database/template-repository.js(2) |
| `saveBillSplitMeta` | 4 | 8 | 1 | src/renderer-dialogs.js(3), src/backend/database.js(2), src/backend/database/template-repository.js(2) |
| `scanXlsxSheet` | 4 | 8 | 1 | src/backend/position-reconciliation-import/xlsx-reader.js(2), src/backend/toolbox-format/xlsx-pass.js(2), src/backend/toolbox-format/xlsx-sheet-scanner.js(2) |
| `validateBillHeaders` | 4 | 8 | 4 | src/backend/acquiring-bill-currency-import/reader.js(3), src/backend/acquiring-bill-currency-import/contract-bill.js(2), src/backend/acquiring-bill-currency-import/validator.js(2) |
| `validateFlowRow` | 4 | 8 | 3 | src/backend/biz-op-recon-import/contract-flow.js(2), src/backend/biz-op-recon-import/import-worker.js(2), src/backend/biz-op-recon-import/validator.js(2) |
| `validateToolboxMultiGenerationResult` | 4 | 8 | 1 | src/main-process/background-execution/runtime.js(2), src/main-process/toolbox-background/generation-contract.js(2), src/main-process/toolbox-background/multi-output-validator.js(2) |
| `yauzl` | 4 | 8 | 4 | src/backend/acquiring-bill-currency-import/reader.js(2), src/backend/big-table-import/zip-reader.js(2), src/backend/pending-import/xlsx-size-preflight.js(2) |
| `appendStatementSessionImport` | 4 | 7 | 1 | src/main-process/statement-session.js(2), src/main-process/statement-worker/probe-state-builder.js(2), src/main-process/statement-worker/session-state.js(2) |
| `artifactManifestFromFilePlan` | 4 | 7 | 1 | src/main-process/archive-center/archive-service.js(2), src/main-process/archive-center/file-plan.js(2), src/main-process/archive-center/task-lifecycle.js(2) |
| `assertXlsxEntriesUnderLimit` | 4 | 7 | 4 | src/backend/biz-op-recon-import/reader-streamed.js(2), src/backend/pending-import/xlsx-size-preflight.js(2), src/backend/vcc-op-calc-import/reader.js(2) |
| `buildDateDir` | 4 | 7 | 3 | src/main-process/scenario-hit-rows-writer.js(3), src/main-process/acquiring-bill-currency-writer.js(2), src/main-process/bank-statement-io.js(1) |
| `buildStatementFileEntry` | 4 | 7 | 1 | src/main-process/statement-session.js(2), src/main-process/statement-worker/probe-state-builder.js(2), src/main-process/statement-worker/session-state.js(2) |
| `calculateEndingBalanceFromAmounts` | 4 | 7 | 1 | src/backend/file-service.js(2), src/backend/file-service/normalizers.js(2), src/main-process/statement-generation-business.js(2) |
| `createInspectorRegistry` | 4 | 7 | 2 | src/main-process/background-execution/canary/packaged-runtime-runner.js(2), src/main-process/background-execution/index.js(2), src/main-process/background-execution/inspector-registry.js(2) |
| `createNewAccountGenerationInput` | 4 | 7 | 1 | src/main-process/new-account/generation-contract.js(2), src/main-process/new-account/generation-validator.js(2), src/main-process/new-account/resource-estimator.js(2) |
| `createRecoveryHoldGate` | 4 | 7 | 2 | src/main-process/background-execution/index.js(2), src/main-process/background-execution/recovery-hold-gate.js(2), src/main-process/duplicate-inbound-match/startup-gate.js(2) |
| `createRecoveryObservationAttemptRepository` | 4 | 7 | 1 | src/main-process/background-execution/canary/packaged-runtime-runner.js(2), src/main-process/background-execution/critical/recovery-request-owner-repository.js(2), src/main-process/background-execution/index.js(2) |
| `createRunMirror` | 4 | 7 | 2 | src/backend/database.js(2), src/backend/database/duplicate-inbound-match-run-repository.js(2), src/backend/database/pre-fund-reconciliation-run-repository.js(2) |
| `createSettlementRecoveryProviderRegistry` | 4 | 7 | 1 | src/main-process/background-execution/canary/packaged-runtime-runner.js(2), src/main-process/background-execution/index.js(2), src/main-process/background-execution/settlement-recovery-provider-registry.js(2) |
| `createStartupRecoveryCoordinator` | 4 | 7 | 2 | src/main-process/background-execution/canary/packaged-runtime-runner.js(2), src/main-process/background-execution/index.js(2), src/main-process/background-execution/startup-recovery-coordinator.js(2) |
| `errorCodeToCause` | 4 | 7 | 4 | src/backend/file-service/error-causes.js(2), src/backend/pending-export/error-report-writer.js(2), src/main-process/exceljs-writer.js(2) |
| `exportToolboxFilter` | 4 | 7 | 2 | src/backend/toolbox-xlsx-stream/split-export-filter.js(2), src/main-process/toolbox-background/generation-core.js(2), src/main-process/toolbox-format-operations.js(2) |
| `failRunMirror` | 4 | 7 | 2 | src/backend/database.js(2), src/backend/database/duplicate-inbound-match-run-repository.js(2), src/backend/database/pre-fund-reconciliation-run-repository.js(2) |
| `finishRunMirror` | 4 | 7 | 2 | src/backend/database.js(2), src/backend/database/duplicate-inbound-match-run-repository.js(2), src/backend/database/pre-fund-reconciliation-run-repository.js(2) |
| `inferEndingBalance` | 4 | 7 | 1 | src/backend/file-service.js(2), src/backend/file-service/normalizers.js(2), src/main-process/statement-generation-business.js(2) |
| `insertRows` | 4 | 7 | 2 | src/backend/biz-op-recon-db/flow-imports-repository.js(2), src/backend/biz-op-recon-db/imports-repository.js(2), src/main-process/biz-op-recon-session.js(2) |
| `listOperationReceipts` | 4 | 7 | 2 | src/backend/vcc-op-calc-db/operation-receipt-repository.js(2), src/main-process/duplicate-inbound-match/operation-receipt-repository.js(2), src/main-process/vcc-op-calc/save-run-contract.js(2) |
| `markRunMirrorUnavailable` | 4 | 7 | 2 | src/backend/database.js(2), src/backend/database/duplicate-inbound-match-run-repository.js(2), src/backend/database/pre-fund-reconciliation-run-repository.js(2) |
| `mergeMappedDetailRows` | 4 | 7 | 1 | src/main-process/statement-generation-business.js(2), src/main-process/statement-generation.js(2), src/main-process/statement-session.js(2) |
| `normalizeExactReceipt` | 4 | 7 | 1 | src/backend/database/recon-fix-operation-receipt-repository.js(3), src/main-process/recon-id-fix-service/jpm-writeback-transaction.js(2), src/main-process/recon-id-fix-service/jpm-outcome-inspector.js(1) |
| `readBalanceSeedRecords` | 4 | 7 | 1 | src/main-process/manual-balance-seed-preflight.js(2), src/main-process/manual-balance-seed-settlement.js(2), src/main-process/monthly-balance.js(2) |
| `readBankFile` | 4 | 7 | 4 | src/backend/bank-bu-recon-import/reader.js(2), src/main-process/bank-bu-worker/import-operation.js(2), src/main-process/bank-bu-worker/spool-writer.js(2) |
| `readPendingGuanliFile` | 4 | 7 | 4 | src/backend/bank-bu-recon-import/reader.js(2), src/main-process/bank-bu-worker/import-operation.js(2), src/main-process/bank-bu-worker/spool-writer.js(2) |
| `setChildParent` | 4 | 7 | 1 | src/backend/database.js(2), src/backend/database/template-repository.js(2), src/renderer-dialogs.js(2) |
| `writeHead` | 4 | 7 | 1 | src/backend/biz-op-recon-db/dataset-head-repository.js(2), src/backend/biz-op-recon-import/import-worker.js(2), src/main-process/biz-op-recon-session.js(2) |
| `writeXlsxAtomically` | 4 | 7 | 4 | src/main-process/vcc-financial-op-audit-writer.js(2), src/main-process/vcc-financial-op-dataset-writer.js(2), src/main-process/vcc-financial-op-output-publication.js(2) |
| `buildTimestamp` | 4 | 6 | 3 | src/main-process/acquiring-bill-currency-writer.js(2), src/main-process/scenario-hit-rows-writer.js(2), src/main-process/bank-statement-io.js(1) |
| `clearBillSplitMergeGroups` | 4 | 6 | 1 | src/backend/database.js(2), src/backend/database/template-repository.js(2), src/preload.js(1) |
| `createImportRecord` | 4 | 6 | 1 | src/backend/vcc-financial-op-db/repository.js(2), src/backend/vcc-financial-op/detail-importer.js(2), src/backend/vcc-financial-op/import-service.js(1) |
| `createImportSource` | 4 | 6 | 1 | src/backend/vcc-financial-op-db/repository.js(2), src/backend/vcc-financial-op/detail-importer.js(2), src/backend/vcc-financial-op/import-service.js(1) |
| `createRowFilter` | 4 | 6 | 2 | src/main-process/toolbox-format-operations.js(2), src/main-process/toolbox.js(2), src/main-process/toolbox-multi-split.js(1) |
| `deleteBillSplitRow` | 4 | 6 | 1 | src/backend/database.js(2), src/backend/database/template-repository.js(2), src/preload.js(1) |
| `listSuccessDatesInRange` | 4 | 6 | 1 | src/backend/biz-op-recon-db/run-repository.js(2), src/main-process/biz-op-recon-run-data.js(2), src/main-process/biz-op-recon-writer.js(1) |
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
| `countExportableImportAnomalies` | 4 | 5 | 1 | src/backend/vcc-financial-op-db/repository.js(2), src/main-process/read-only-exports/vcc-financial-op/query.js(1), src/main-process/vcc-financial-op-audit-writer.js(1) |
| `createCommittedRunMirror` | 4 | 5 | 1 | src/backend/database/duplicate-inbound-match-run-repository.js(2), src/backend/database.js(1), src/main-process/duplicate-inbound-match/mirror-database.js(1) |
| `deleteArchiveRunByTaskRunId` | 4 | 5 | 1 | src/backend/biz-op-recon-db/run-repository.js(2), src/backend/pre-fund-reconciliation-run-store.js(1), src/main-process/biz-op-recon-run-data.js(1) |
| `failImportBatch` | 4 | 5 | 1 | src/backend/vcc-financial-op-db/repository.js(2), src/backend/vcc-financial-op/detail-importer.js(1), src/backend/vcc-financial-op/import-service.js(1) |
| `protocol` | 4 | 5 | 1 | src/main-process/background-execution/index.js(2), src/main-process/duplicate-inbound-match/policies.js(1), src/main-process/fund-recon-worker/policies.js(1) |
| `ToolboxXlsxFormatError` | 3 | 124 | 1 | src/backend/toolbox-format/xlsx-sheet-scanner.js(69), src/backend/toolbox-format/xlsx-pass.js(50), src/backend/position-reconciliation-import/xlsx-reader.js(5) |
| `MODULES` | 3 | 101 | 2 | src/renderer-previews.js(62), src/renderer.js(37), src/main-process/archive-center/operation-tracker.js(2) |
| `ProtocolValidationError` | 3 | 54 | 1 | src/main-process/background-execution/protocol-validator.js(29), src/main-process/background-execution/supervisor.js(21), src/main-process/background-execution/sequence-tracker.js(4) |
| `hasColumn` | 3 | 52 | 2 | src/backend/database/migrations.js(44), src/backend/biz-op-recon-db/migrations.js(5), src/backend/database.js(3) |
| `RECON` | 3 | 43 | 3 | src/main-process/scenario-engines/r5-payment-offline-allocation-backfill.js(24), src/main-process/scenario-engines/r5-fund-transfer-recon-backfill.js(15), src/main-process/scenario-engines/many-to-many-detector.js(4) |
| `bankValue` | 3 | 41 | 1 | src/main-process/pre-fund-reconciliation/output-mapper.js(33), src/main-process/position-reconciliation/logical-accounts.js(4), src/main-process/scenario-engines/c3-gateway-recon-join.js(4) |
| `settingsRepository` | 3 | 40 | 3 | src/backend/database.js(31), src/main-process/import-dialog-state.js(5), src/backend/database/own-accounts-migration.js(4) |
| `applyMismatch` | 3 | 38 | 3 | src/backend/position-reconciliation-import/source-writer.js(21), src/backend/position-reconciliation-import/account-writer.js(9), src/backend/position-reconciliation-import/bank-writer.js(8) |
| `publicFailure` | 3 | 35 | 3 | src/main-process/archive-center/controller.js(24), src/main-process/archive-center/storage-root-manager.js(7), src/main-process/vcc-financial-op-storage-migration.js(4) |
| `SYSTEM_OP_DEFINITION` | 3 | 35 | 1 | src/backend/vcc-financial-op/system-op-importer.js(30), src/main-process/vcc-financial-op-dataset-writer.js(3), src/backend/vcc-financial-op/definitions.js(2) |
| `invokeFault` | 3 | 31 | 3 | src/main-process/vcc-financial-op-storage-rebuild.js(16), src/main-process/recon-id-fix-service/jpm-writeback-transaction.js(8), src/main-process/vcc-op-calc/save-run-contract.js(7) |
| `POSITION_IMPORT_MESSAGE_TYPES` | 3 | 31 | 1 | src/backend/position-reconciliation-import/worker-entry.js(18), src/main-process/position-reconciliation/import-dispatch.js(11), src/backend/position-reconciliation-import/constants.js(2) |
| `runEvidence` | 3 | 31 | 1 | src/main-process/acquiring-bill-currency-run-data.js(27), src/backend/vcc-financial-op/calculator.js(2), src/backend/vcc-financial-op/unarchive.js(2) |
| `BANK_BU_ACTIONS` | 3 | 30 | 3 | src/main-process/bank-bu-worker/main-coordinator.js(14), src/main-process/bank-bu-worker/worker-host.js(9), src/main-process/bank-bu-worker/policies.js(7) |
| `writerError` | 3 | 29 | 2 | src/main-process/pre-fund-reconciliation/mpt-import/single-writer-session.js(13), src/main-process/vcc-financial-op-output/writer-core.js(12), src/main-process/duplicate-inbound-match/service.js(4) |
| `DELETE_TARGET_TYPES` | 3 | 26 | 2 | src/backend/vcc-financial-op/data-target-deletion.js(10), src/backend/vcc-financial-op/destructive-write.js(8), src/backend/vcc-financial-op/read-snapshot.js(8) |
| `BigTableImportError` | 3 | 25 | 1 | src/backend/vcc-financial-op/workbook-reader.js(14), src/backend/big-table-import/engine.js(7), src/backend/big-table-import/zip-reader.js(4) |
| `recoveryRequired` | 3 | 25 | 1 | src/main-process/position-reconciliation/import-recovery.js(20), src/main-process/vcc-op-calc/save-run-contract.js(3), src/main-process/vcc-op-calc/save-run-lifecycle.js(2) |
| `authorityError` | 3 | 24 | 3 | src/main-process/vcc-financial-op-output/authority.js(12), src/main-process/pre-fund-reconciliation/mpt-import/receipt-authority.js(9), src/main-process/recon-id-fix-service/jpm-receipt-authority.js(3) |
| `pathFailure` | 3 | 24 | 3 | src/main-process/duplicate-inbound-match/spool-filesystem.js(9), src/main-process/pre-fund-reconciliation/mpt-import/spool-writer.js(8), src/main-process/bank-bu-worker/spool-filesystem.js(7) |
| `recoveryError` | 3 | 24 | 1 | src/main-process/toolbox-output-publication-dispatch.js(15), src/main-process/pre-fund-archive-lineage.js(7), src/main-process/position-reconciliation/import-dispatch.js(2) |
| `emitControl` | 3 | 23 | 1 | src/main-process/recon-id-fix-service/worker-entry.js(9), src/main-process/duplicate-inbound-match/worker-host.js(7), src/main-process/fund-recon-worker/worker-host.js(7) |
| `REASON_CODES` | 3 | 23 | 2 | src/main-process/position-reconciliation/matching-engine.js(14), src/main-process/position-reconciliation/logical-accounts.js(7), src/main-process/position-reconciliation/contracts.js(2) |
| `TABLE` | 3 | 23 | 3 | src/backend/biz-op-recon-db/imports-repository.js(10), src/backend/biz-op-recon-db/flow-imports-repository.js(7), src/backend/biz-op-recon-db/month-end-copy-intent-repository.js(6) |
| `BANK_ROW_CLASSIFICATION` | 3 | 22 | 1 | src/main-process/pre-fund-reconciliation/bank-row.js(8), src/main-process/pre-fund-reconciliation/matching-engine.js(7), src/main-process/pre-fund-reconciliation/service.js(7) |
| `buildOutputRow` | 3 | 21 | 3 | src/main-process/scenario-engines/c4-recon-id-fix.js(17), src/main-process/scenario-engines/boc-dispatch-order-fix.js(2), src/main-process/scenario-engines/jpm-dispatch-order-fix.js(2) |
| `canonicalRealPath` | 3 | 21 | 1 | src/main-process/archive-center/target-parent-identity.js(15), src/main-process/statement-worker/source-identity.js(4), src/main-process/toolbox-output-publication.js(2) |
| `evidenceError` | 3 | 21 | 3 | src/main-process/recon-id-fix-service/artifact-evidence.js(8), src/main-process/recon-id-fix-service/evidence-projection.js(7), src/main-process/vcc-financial-op-output/artifact-evidence.js(6) |
| `directoryPathAliasKey` | 3 | 20 | 1 | src/main-process/toolbox-output-publication.js(16), src/main-process/archive-center/target-parent-identity.js(2), src/main-process/toolbox-target-identity.js(2) |
| `weekTag` | 3 | 20 | 2 | src/main-process/scenario-engines/r5-payment-offline-allocation-backfill.js(14), src/main-process/exceljs-writer.js(3), src/main-process/scenario-engines/engine-week-utils.js(3) |
| `emptyState` | 3 | 19 | 1 | src/renderer.js(12), src/renderer-dialogs.js(4), src/main-process/fund-recon-worker/service.js(3) |
| `nullable` | 3 | 19 | 1 | src/main-process/background-execution/recovery-control-contract.js(13), src/main-process/read-only-exports/vcc-financial-op/actions.js(4), src/main-process/background-execution/resource-governor.js(2) |
| `safeRollback` | 3 | 19 | 3 | src/main-process/acquiring-bill-currency-session.js(10), src/backend/big-table-import/engine.js(5), src/backend/vcc-financial-op/detail-importer.js(4) |
| `verifyFile` | 3 | 19 | 1 | src/main-process/archive-center/storage-root-manager.js(11), src/main-process/archive-center/storage-materializer.js(5), src/main-process/archive-center/archive-service.js(3) |
| `businessOperationRegistry` | 3 | 18 | 1 | src/main-process/archive-center/task-lifecycle.js(11), src/main-process/vcc-financial-op-storage-migration.js(4), src/main.js(3) |
| `CONCAT_FIELDS_MAPPING_FIELD` | 3 | 17 | 2 | src/renderer-dialogs.js(14), src/renderer.js(2), src/main.js(1) |
| `parseAmount` | 3 | 17 | 3 | src/backend/biz-op-recon-import/validator.js(8), src/backend/vcc-financial-op/row-mapper.js(5), src/main-process/biz-op-recon-session.js(4) |
| `readers` | 3 | 17 | 2 | src/main-process/table-type-detector.js(9), src/main-process/fund-recon-worker/service.js(6), src/main-process/fund-recon-worker/source-readers.js(2) |
| `BALANCE_DISABLED_OPTION` | 3 | 16 | 2 | src/renderer-dialogs.js(9), src/renderer.js(6), src/main.js(1) |
| `operationReceipts` | 3 | 16 | 2 | src/backend/duplicate-inbound-match-store.js(11), src/main-process/duplicate-inbound-match/startup-recovery.js(3), src/main-process/duplicate-inbound-match/service.js(2) |
| `snapshotsEqual` | 3 | 16 | 3 | src/main-process/manual-balance-seed-settlement.js(10), src/main-process/position-reconciliation/operation-lifecycle.js(4), src/main-process/position-reconciliation/import-recovery.js(2) |
| `createRecoveryHoldRequest` | 3 | 15 | 1 | src/main-process/background-execution/startup-recovery-coordinator.js(10), src/main-process/manual-balance-seed-settlement.js(3), src/main-process/background-execution/recovery-hold-request.js(2) |
| `diffRepo` | 3 | 15 | 3 | src/backend/pending-export/writer.js(8), src/backend/pending-reconcile/engine.js(4), src/backend/pending-reconcile/removal-match.js(3) |
| `mapRun` | 3 | 15 | 3 | src/backend/pending-db/diff-repository.js(7), src/backend/pre-fund-reconciliation-run-store.js(5), src/backend/duplicate-inbound-match-store.js(3) |
| `MAX_RECORDS` | 3 | 15 | 1 | src/main-process/new-account/resource-estimator.js(9), src/main-process/new-account/generation-contract.js(5), src/main-process/new-account/generation-core.js(1) |
| `own` | 3 | 15 | 1 | src/main-process/duplicate-inbound-match/matching-engine.js(10), src/main-process/position-reconciliation/matching-engine.js(4), src/main-process/position-reconciliation/logical-accounts.js(1) |
| `requireHash` | 3 | 15 | 3 | src/backend/database/duplicate-inbound-match-run-repository.js(6), src/main-process/recon-id-fix-service/jpm-writeback-plan.js(5), src/backend/database/recon-fix-operation-receipt-repository.js(4) |
| `RESULT_MUTATION_OPERATIONS` | 3 | 15 | 1 | src/backend/vcc-financial-op/preserved-state.js(9), src/backend/vcc-financial-op/calculator.js(3), src/backend/vcc-financial-op/result-adjustments.js(3) |
| `resultRows` | 3 | 15 | 1 | src/main-process/position-reconciliation/service.js(12), src/main-process/background-execution/adapters/position-import-adapter.js(2), src/main-process/position-reconciliation/matching-engine.js(1) |
| `statementImportSessions` | 3 | 15 | 1 | src/main-process/statement-worker/probe-state-builder.js(10), src/main-process/statement-session.js(4), src/main.js(1) |
| `cellText` | 3 | 14 | 1 | src/backend/vcc-financial-op/result-template-contract.js(12), src/backend/toolbox-format/biff8-pass.js(1), src/main-process/statement-worker/artifact-descriptor.js(1) |
| `PRAGMA_EXPECTED` | 3 | 14 | 3 | src/main-process/run-check-multiworker-worker.js(5), src/main-process/run-check-worker.js(5), src/backend/big-table-import/engine.js(4) |
| `readToolboxMetadataEntryAsString` | 3 | 14 | 1 | src/backend/toolbox-format/xlsx-pass.js(6), src/backend/position-reconciliation-import/xlsx-reader.js(5), src/main-process/toolbox-large-split-router.js(3) |
| `remainingTimeout` | 3 | 14 | 2 | src/main-process/background-execution/supervisor.js(7), src/main-process/background-execution/runtime.js(4), src/main-process/background-execution/external-parser-finalization.js(3) |
| `applyStatementResult` | 3 | 13 | 1 | src/renderer.js(7), src/renderer-dialogs.js(5), src/renderer-previews.js(1) |
| `BANK_RECON_ID_FIELD` | 3 | 13 | 3 | src/main-process/scenario-engines/dbs-charge-fund-check.js(6), src/main-process/scenario-engines/r4-fund-nature-check.js(4), src/main-process/scenario-engines/r1-recon-id-match.js(3) |
| `FUND_RECON_ACTIONS` | 3 | 13 | 1 | src/main-process/fund-recon-worker/policies.js(7), src/main-process/fund-recon-worker/service.js(4), src/main-process/fund-recon-worker/worker-host.js(2) |
| `PRE_FUND_MPT_REPAIR_ACTION` | 3 | 13 | 2 | src/main-process/pre-fund-reconciliation/mpt-import/policies.js(7), src/main-process/background-execution/runtime.js(3), src/main-process/pre-fund-reconciliation/mpt-import/topology.js(3) |
| `RECON_FIX_RUN_READONLY_ACTION` | 3 | 13 | 1 | src/main-process/recon-id-fix-service/policies.js(8), src/main-process/recon-id-fix-service/service.js(3), src/main-process/recon-id-fix-service/worker-entry.js(2) |
| `RecoveryRegistryError` | 3 | 13 | 2 | src/main-process/background-execution/inspector-registry.js(6), src/main-process/background-execution/settlement-recovery-provider-registry.js(5), src/main-process/background-execution/index.js(2) |
| `safeSnapshot` | 3 | 13 | 3 | src/main-process/background-execution/production-strategy-snapshot.js(5), src/main-process/background-execution/capability-inventory.js(4), src/main-process/background-execution/coverage-check.js(4) |
| `STATEMENT_RESOURCE_CONTRACT` | 3 | 13 | 1 | src/main-process/statement-worker/contracts.js(6), src/main-process/statement-worker/token-store.js(4), src/main-process/statement-worker/state-footprint.js(3) |
| `cancelledError` | 3 | 12 | 2 | src/main-process/background-execution/admission-queue.js(7), src/main-process/vcc-financial-op-write-worker.js(3), src/main-process/vcc-financial-op-output/writer-core.js(2) |
| `hasEffectiveAmount` | 3 | 12 | 2 | src/backend/file-service.js(7), src/main-process/statement-worker/session-state.js(3), src/backend/file-service/normalizers.js(2) |
| `isSafeMptErrorText` | 3 | 12 | 1 | src/main-process/pre-fund-reconciliation/mpt-import/file-result-safety.js(7), src/main-process/pre-fund-reconciliation/mpt-import/parser-outcome.js(3), src/main-process/pre-fund-reconciliation/mpt-import/policies.js(2) |
| `requestEvidence` | 3 | 12 | 1 | src/main-process/background-execution/critical/recovery-request-owner-repository.js(8), src/main-process/background-execution/critical/recovery-control-repository.js(2), src/main-process/background-execution/recovery-control-contract.js(2) |
| `upsertMainRunMirror` | 3 | 12 | 3 | src/main-process/acquiring-bill-currency-run-data.js(5), src/main-process/biz-op-recon-run-data.js(4), src/main-process/bank-bu-recon-run-data.js(3) |
| `utf8Size` | 3 | 12 | 2 | src/main-process/background-execution/error-codec.js(6), src/main-process/background-execution/protocol-validator.js(4), src/main-process/background-execution/supervisor.js(2) |
| `assertCurrentPositionCheckpointHistory` | 3 | 11 | 1 | src/main-process/position-reconciliation/large-import-schema.js(4), src/main-process/position-reconciliation/side-db-mutation.js(4), src/main-process/position-reconciliation/store.js(3) |
| `buildFieldIndexMap` | 3 | 11 | 1 | src/main-process/statement-generation-business.js(6), src/main-process/statement-generation.js(3), src/main-process/statement-session.js(2) |
| `compareText` | 3 | 11 | 2 | src/backend/vcc-financial-op/archive-evidence.js(5), src/backend/vcc-financial-op/operation-token-v2.js(4), src/renderer-pending.js(2) |
| `EXCEL_CELL_TEXT_MAX_UTF16_UNITS` | 3 | 11 | 1 | src/backend/toolbox-format/excel-text.js(6), src/backend/toolbox-format/xlsx-sheet-scanner.js(3), src/backend/position-reconciliation-import/shared-strings-provider.js(2) |
| `findRelationshipEntry` | 3 | 11 | 1 | src/backend/toolbox-format/xlsx-pass.js(5), src/backend/position-reconciliation-import/xlsx-reader.js(4), src/main-process/toolbox-large-split-router.js(2) |
| `getScenario` | 3 | 11 | 1 | src/backend/database/scenarios-repository.js(8), src/backend/database.js(2), src/main-process/fund-recon-worker/evidence-provider.js(1) |
| `getVccFinancialOpModuleState` | 3 | 11 | 1 | src/backend/vcc-financial-op-db/repository.js(4), src/backend/vcc-financial-op/calculator.js(4), src/backend/vcc-financial-op/data-target-deletion.js(3) |
| `MAX_PARSER_ERROR_ROWS` | 3 | 11 | 1 | src/main-process/vcc-op-calc/ordered-reducer.js(4), src/main-process/vcc-op-calc/parser-core.js(4), src/main-process/vcc-op-calc/parser-pipeline.js(3) |
| `mirrorError` | 3 | 11 | 1 | src/main-process/bank-bu-worker/mirror-repository.js(5), src/main-process/biz-op-recon-run-data.js(3), src/main-process/pre-fund-reconciliation/service.js(3) |
| `normalizeTargetParentIdentity` | 3 | 11 | 1 | src/main-process/toolbox-output-publication.js(5), src/main-process/archive-center/target-parent-identity.js(4), src/main-process/new-account/artifact-copy.js(2) |
| `parseBalancesJson` | 3 | 11 | 3 | src/backend/vcc-financial-op/calculator.js(7), src/backend/vcc-financial-op/data-target-deletion.js(2), src/backend/vcc-financial-op/unarchive.js(2) |
| `parseDecimalLexical` | 3 | 11 | 1 | src/backend/toolbox-format/number-date.js(5), src/backend/toolbox-format/xlsx-sheet-scanner.js(4), src/backend/toolbox-format/model.js(2) |
| `PARSER_RESULT_MAX_BYTES` | 3 | 11 | 1 | src/main-process/vcc-op-calc/ordered-reducer.js(4), src/main-process/vcc-op-calc/parser-core.js(4), src/main-process/vcc-op-calc/save-run-contract.js(3) |
| `parserFailure` | 3 | 11 | 1 | src/main-process/bank-bu-worker/dual-parser-dispatch.js(5), src/main-process/duplicate-inbound-match/paired-parser-dispatch.js(3), src/main-process/pre-fund-reconciliation/mpt-import/managed-import.js(3) |
| `previewDataTargetDeletion` | 3 | 11 | 1 | src/backend/vcc-financial-op/data-target-deletion.js(7), src/main-process/vcc-financial-op-service.js(3), src/preload.js(1) |
| `RECON_FIX_IMPORT_ACTION` | 3 | 11 | 1 | src/main-process/recon-id-fix-service/policies.js(6), src/main-process/recon-id-fix-service/service.js(3), src/main-process/recon-id-fix-service/worker-entry.js(2) |
| `setRunChunkProgress` | 3 | 11 | 1 | src/main-process/acquiring-bill-currency-session.js(7), src/backend/acquiring-bill-currency-db/run-repository.js(3), src/main-process/acquiring-bill-currency-run-data.js(1) |
| `assertDirectoryDurable` | 3 | 10 | 3 | src/main-process/pre-fund-reconciliation/mpt-import/spool-writer.js(4), src/main-process/toolbox-background/route-db-sealer.js(4), src/main-process/pre-fund-reconciliation/mpt-import/parser-outcome.js(2) |
| `bankAmountAbs` | 3 | 10 | 2 | src/main-process/scenario-engines/r5-fund-transfer-backfill.js(5), src/main-process/scenario-engines/r5-refund-order-backfill.js(3), src/main-process/scenario-engines/dbs-charge-fund-check.js(2) |
| `canonicalDecimal` | 3 | 10 | 2 | src/main-process/position-reconciliation/readers.js(6), src/main-process/position-reconciliation/common.js(2), src/main-process/position-reconciliation/derivation.js(2) |
| `closeMutationGuard` | 3 | 10 | 1 | src/backend/vcc-financial-op/result-write.js(5), src/backend/vcc-financial-op/destructive-write.js(3), src/backend/vcc-financial-op/mutation-guard.js(2) |
| `duplicateSideDbRelPath` | 3 | 10 | 1 | src/main-process/duplicate-inbound-match/service.js(5), src/main-process/duplicate-inbound-match/startup-recovery.js(3), src/backend/duplicate-inbound-match-side-db-identity.js(2) |
| `finishImportRecord` | 3 | 10 | 1 | src/backend/vcc-financial-op/detail-importer.js(4), src/backend/vcc-financial-op-db/repository.js(3), src/backend/vcc-financial-op/system-op-importer.js(3) |
| `isSafeMptErrorCode` | 3 | 10 | 1 | src/main-process/pre-fund-reconciliation/mpt-import/file-result-safety.js(4), src/main-process/pre-fund-reconciliation/mpt-import/parser-outcome.js(4), src/main-process/pre-fund-reconciliation/mpt-import/policies.js(2) |
| `MPT_SPOOL_FILE_NAMES` | 3 | 10 | 1 | src/main-process/pre-fund-reconciliation/mpt-import/spool-writer.js(4), src/main-process/pre-fund-reconciliation/mpt-import/spool-contract.js(3), src/main-process/pre-fund-reconciliation/mpt-import/spool-reader.js(3) |
| `NEW_ACCOUNT_SAVE_AS_ACTION` | 3 | 10 | 2 | src/main-process/new-account/artifact-copy.js(5), src/main-process/background-execution/runtime.js(3), src/main-process/new-account/policies.js(2) |
| `normalizeTaskStagingDir` | 3 | 10 | 3 | src/main-process/duplicate-inbound-match/spool-contract.js(4), src/main-process/bank-bu-worker/spool-contract.js(3), src/main-process/pre-fund-reconciliation/mpt-import/spool-contract.js(3) |
| `PENDING_RAW_CONTRACT_V2` | 3 | 10 | 1 | src/backend/vcc-financial-op/row-mapper.js(5), src/backend/vcc-financial-op/definitions.js(3), src/backend/vcc-financial-op-db/migrations.js(2) |
| `PRAGMA_STATEMENTS` | 3 | 10 | 3 | src/main-process/run-check-multiworker-worker.js(4), src/backend/big-table-import/engine.js(3), src/main-process/run-check-worker.js(3) |
| `PRE_FUND_MPT_IMPORT_ACTION` | 3 | 10 | 2 | src/main-process/pre-fund-reconciliation/mpt-import/policies.js(6), src/main-process/background-execution/runtime.js(2), src/main-process/pre-fund-reconciliation/mpt-import/topology.js(2) |
| `RecoveryControlError` | 3 | 10 | 1 | src/main-process/background-execution/critical/recovery-control-repository.js(4), src/main-process/background-execution/critical/recovery-request-owner-repository.js(4), src/main-process/background-execution/index.js(2) |
| `validateObservationRequest` | 3 | 10 | 1 | src/main-process/background-execution/critical/recovery-request-owner-repository.js(4), src/main-process/background-execution/recovery-control-contract.js(4), src/main-process/background-execution/critical/recovery-control-repository.js(2) |
| `validateTransitionRequest` | 3 | 10 | 1 | src/main-process/background-execution/critical/recovery-request-owner-repository.js(5), src/main-process/background-execution/recovery-control-contract.js(3), src/main-process/background-execution/critical/recovery-control-repository.js(2) |
| `VCC_OP_SAVE_RUN_ACTION_KEY` | 3 | 10 | 1 | src/main-process/vcc-op-calc/save-run-contract.js(6), src/main-process/vcc-op-calc/save-run-inspector.js(2), src/main-process/vcc-op-calc/save-run-lifecycle.js(2) |
| `addToAccumulatorMap` | 3 | 9 | 2 | src/backend/vcc-financial-op/calculator.js(5), src/backend/vcc-financial-op/decimal-accumulator.js(2), src/backend/vcc-financial-op/result-adjustments.js(2) |
| `admImageHash` | 3 | 9 | 1 | src/main-process/recon-id-fix-service/jpm-writeback-plan.js(4), src/backend/database/linked-table-writeback-reader.js(3), src/main-process/recon-id-fix-service/jpm-writeback-transaction.js(2) |
| `amountEqual` | 3 | 9 | 3 | src/main-process/scenario-engines/r5-fund-transfer-backfill.js(3), src/main-process/scenario-engines/r5-fund-transfer-recon-backfill.js(3), src/main-process/scenario-engines/r5-payment-offline-allocation-backfill.js(3) |
| `assertC1Transition` | 3 | 9 | 1 | src/main-process/background-execution/critical/recovery-request-owner-repository.js(4), src/main-process/background-execution/recovery-control-contract.js(3), src/main-process/background-execution/critical/recovery-control-repository.js(2) |
| `assertMetadataCurrent` | 3 | 9 | 2 | src/main-process/statement-worker/source-identity.js(4), src/main-process/statement-worker/session-state.js(3), src/main-process/statement-worker/generation.js(2) |
| `attachSourceIdentity` | 3 | 9 | 1 | src/backend/vcc-financial-op/source-lineage.js(4), src/backend/vcc-financial-op/detail-importer.js(3), src/backend/vcc-financial-op/system-op-importer.js(2) |
| `BANK_STATEMENT_FIELDS_FOR_C3` | 3 | 9 | 2 | src/renderer-dialogs.js(5), src/constants/bank-statement-fields.js(2), src/preload.js(2) |
| `BANK_STATEMENT_VIRTUAL_AMOUNT_ABS` | 3 | 9 | 3 | src/constants/bank-statement-fields.js(3), src/main-process/scenario-engines/c3-gateway-recon-join.js(3), src/preload.js(3) |
| `buildHeaderValidator` | 3 | 9 | 3 | src/backend/acquiring-bill-currency-import/validator.js(3), src/backend/bank-bu-recon-import/validator.js(3), src/backend/biz-op-recon-import/validator.js(3) |
| `classifyBankRow` | 3 | 9 | 1 | src/main-process/pre-fund-reconciliation/bank-row.js(3), src/main-process/pre-fund-reconciliation/matching-engine.js(3), src/main-process/pre-fund-reconciliation/service.js(3) |
| `classifyExcelNumberFormat` | 3 | 9 | 1 | src/backend/toolbox-format/number-date.js(4), src/backend/toolbox-format/model.js(3), src/backend/position-reconciliation-import/xlsx-reader.js(2) |
| `collectEntrySizes` | 3 | 9 | 1 | src/backend/toolbox-xlsx-stream/large-split-worker.js(5), src/backend/pending-import/xlsx-size-preflight.js(3), src/main-process/toolbox-large-split-router.js(1) |
| `detectDetailSourceType` | 3 | 9 | 1 | src/backend/vcc-financial-op/workbook-reader.js(4), src/backend/vcc-financial-op/system-op-importer.js(3), src/backend/vcc-financial-op/definitions.js(2) |
| `FLOW_TABLE` | 3 | 9 | 3 | src/backend/acquiring-bill-currency-db/run-repository.js(4), src/backend/biz-op-recon-import/contract-flow.js(3), src/backend/biz-op-recon-db/run-repository.js(2) |
| `FUND_TRANSFER_RECON_USED` | 3 | 9 | 1 | src/main-process/scenario-engines/r5-payment-offline-allocation-backfill.js(4), src/main-process/scenario-engines/r5-fund-transfer-recon-backfill.js(3), src/constants/fund-transfer-recon-fields.js(2) |
| `getChannelById` | 3 | 9 | 1 | src/backend/database/channels-repository.js(6), src/backend/database.js(2), src/main-process/scenario-dispatcher.js(1) |
| `GW_RECON_ID_FIELD` | 3 | 9 | 3 | src/main-process/scenario-engines/r4-fund-nature-check.js(4), src/main-process/scenario-engines/r1-recon-id-match.js(3), src/main-process/scenario-engines/dbs-charge-fund-check.js(2) |
| `hasFundTransferReservedSignature` | 3 | 9 | 1 | src/main-process/fund-transfer-date-policy.js(4), src/backend/database/scenarios-repository.js(3), src/main-process/scenarios-bundle-import.js(2) |
| `isNumericFieldName` | 3 | 9 | 3 | src/main-process/scenario-engines/c2-offset-bill-mark.js(4), src/main-process/scenario-engines/c3-gateway-recon-join.js(3), src/backend/pending-reconcile/removal-match.js(2) |
| `isoDate` | 3 | 9 | 2 | src/main-process/read-only-exports/biz-op/actions.js(4), src/main-process/statement-worker/artifact-descriptor.js(3), src/main-process/pre-fund-reconciliation/mpt-schema.js(2) |
| `loadArchiveEvidenceSet` | 3 | 9 | 1 | src/backend/vcc-financial-op/read-snapshot.js(5), src/backend/vcc-financial-op/destructive-write.js(2), src/main-process/vcc-financial-op-output/authority.js(2) |
| `normalizedRow` | 3 | 9 | 1 | src/backend/file-service/writers.js(4), src/main-process/pre-fund-reconciliation/mpt-parser.js(3), src/main-process/bank-bu-worker/spool-writer.js(2) |
| `normalizeLegacyStoredCurrency` | 3 | 9 | 1 | src/backend/vcc-financial-op/calculator.js(4), src/main-process/vcc-financial-op-dataset-writer.js(3), src/backend/vcc-financial-op/definitions.js(2) |
| `parseJsonArray` | 3 | 9 | 2 | src/backend/database/template-repository.js(3), src/backend/database/utils.js(3), src/backend/pending-db/rule-repository.js(3) |
| `PENDING_RAW_CONTRACT_V1` | 3 | 9 | 1 | src/backend/vcc-financial-op/definitions.js(4), src/backend/vcc-financial-op/row-mapper.js(3), src/backend/vcc-financial-op-db/migrations.js(2) |
| `receiptError` | 3 | 9 | 3 | src/main-process/bank-bu-worker/operation-receipt-repository.js(3), src/main-process/duplicate-inbound-match/operation-receipt-repository.js(3), src/main-process/pre-fund-reconciliation/mpt-import/operation-receipt-repository.js(3) |
| `RECON_FIX_SERVICE_KEY` | 3 | 9 | 1 | src/main-process/recon-id-fix-service/worker-entry.js(4), src/main-process/recon-id-fix-service/policies.js(3), src/main-process/background-execution/runtime.js(2) |
| `REFUND_BANK_COLUMNS` | 3 | 9 | 1 | src/constants/refund-backfill-fields.js(4), src/main-process/scenario-engines/r5-refund-order-backfill.js(3), src/main-process/refund-backfill-writer.js(2) |
| `requireSafeId` | 3 | 9 | 3 | src/backend/database/duplicate-inbound-match-run-repository.js(4), src/main-process/duplicate-inbound-match/operation-receipt-repository.js(3), src/main-process/bank-bu-worker/operation-receipt-repository.js(2) |
| `toInvalidBothNonzeroError` | 3 | 9 | 1 | src/main-process/pre-fund-reconciliation/bank-row.js(3), src/main-process/pre-fund-reconciliation/matching-engine.js(3), src/main-process/pre-fund-reconciliation/service.js(3) |
| `VCC_EXPORT_SUBJECTS_MAX_ARTIFACTS` | 3 | 9 | 1 | src/main-process/vcc-financial-op-output/policies.js(4), src/main-process/vcc-financial-op-output/authority.js(3), src/main-process/vcc-financial-op-output/writer-core.js(2) |
| `writeFileAtomicDurable` | 3 | 9 | 3 | src/main-process/background-execution/canary/durable-recovery.js(5), src/main-process/background-execution/durable-file.js(2), src/main-process/toolbox-background/route-db-sealer.js(2) |
| `ALLOWED_SOURCE_TYPES` | 3 | 8 | 2 | src/backend/vcc-financial-op/data-target-deletion.js(3), src/backend/vcc-financial-op/dataset-deletion.js(3), src/main-process/vcc-financial-op-dataset-writer.js(2) |
| `AMOUNT_BASED_ACCOUNT_MAPPING_FIELD` | 3 | 8 | 2 | src/renderer-previews.js(3), src/renderer.js(3), src/main.js(2) |
| `AMOUNT_BASED_NAME_MAPPING_FIELD` | 3 | 8 | 2 | src/renderer-previews.js(3), src/renderer.js(3), src/main.js(2) |
| `AMOUNT_EPSILON` | 3 | 8 | 1 | src/backend/biz-op-recon-import/validator.js(4), src/backend/biz-op-recon-db/columns.js(2), src/main-process/biz-op-recon-session.js(2) |
| `AMOUNT_SPLIT_BY_FIELD_ENABLED_OPTION` | 3 | 8 | 2 | src/renderer-dialogs.js(5), src/renderer.js(2), src/main.js(1) |
| `AMOUNT_SPLIT_BY_FIELD_MAPPING_FIELD` | 3 | 8 | 2 | src/renderer-dialogs.js(3), src/renderer.js(3), src/main.js(2) |
| `assertDistinctTaskOwnedPaths` | 3 | 8 | 1 | src/main-process/statement-worker/generation.js(3), src/main-process/statement-worker/publication.js(3), src/main-process/statement-worker/staging-ownership.js(2) |
| `assertVccTriggerPolicy` | 3 | 8 | 1 | src/backend/vcc-financial-op/mutation-guard.js(3), src/backend/vcc-financial-op/result-write.js(3), src/backend/vcc-financial-op/destructive-write.js(2) |
| `buildHeaderIdentity` | 3 | 8 | 2 | src/main-process/pre-fund-reconciliation/mpt-import/parser-core.js(3), src/main-process/pre-fund-reconciliation/mpt-import/spool-reader.js(3), src/main-process/pre-fund-reconciliation/mpt-import/spool-contract.js(2) |
| `checkpointGeneration` | 3 | 8 | 1 | src/main-process/background-execution/position-import-adapter-policy.js(5), src/main-process/position-reconciliation/side-db-mutation.js(2), src/main-process/background-execution/adapters/position-import-adapter.js(1) |
| `compactJson` | 3 | 8 | 1 | src/main-process/background-execution/protocol-validator.js(4), src/main-process/background-execution/protocol.js(2), src/main-process/recon-id-fix-service/jpm-writeback-plan.js(2) |
| `createStatementPublicTokenIdentity` | 3 | 8 | 2 | src/main-process/statement-worker/interaction-contracts.js(4), src/main-process/statement-worker/generation-contracts.js(2), src/main-process/statement-worker/token-store.js(2) |
| `deadlineAfter` | 3 | 8 | 2 | src/main-process/background-execution/external-parser-finalization.js(3), src/main-process/background-execution/supervisor.js(3), src/main-process/background-execution/runtime.js(2) |
| `ensureVccFinancialOpTablesSupport` | 3 | 8 | 3 | src/backend/database.js(4), src/backend/vcc-financial-op-db/migrations.js(2), src/backend/vcc-financial-op/worker-entry.js(2) |
| `FLOW_INSERT_SQL` | 3 | 8 | 3 | src/backend/acquiring-bill-currency-import/contract-flow.js(3), src/backend/biz-op-recon-import/contract-flow.js(3), src/backend/acquiring-bill-currency-db/import-repository.js(2) |
| `fsyncFile` | 3 | 8 | 3 | src/main-process/vcc-financial-op-storage-rebuild.js(4), src/main-process/toolbox-background/route-db-sealer.js(2), src/main-process/toolbox-output-publication.js(2) |
| `GATEWAY_RECON_FIELDS` | 3 | 8 | 3 | src/constants/gateway-recon-headers-loader.js(4), src/constants/gateway-recon-fields.js(2), src/main-process/bank-statement-io.js(2) |
| `getMonthReadiness` | 3 | 8 | 1 | src/main-process/acquiring-bill-currency-run-data.js(3), src/main-process/acquiring-bill-currency-session.js(3), src/backend/acquiring-bill-currency-db/import-repository.js(2) |
| `getTemplateBigAccounts` | 3 | 8 | 1 | src/backend/database/template-repository.js(4), src/backend/database.js(2), src/main-process/monthly-balance.js(2) |
| `groupBy` | 3 | 8 | 2 | src/backend/vcc-financial-op-db/migrations.js(3), src/main-process/scenario-engines/r5-refund-order-backfill.js(3), src/main-process/scenario-engines/jpm-dispatch-order-fix.js(2) |
| `inputEvidenceFor` | 3 | 8 | 3 | src/backend/position-reconciliation-import/account-writer.js(3), src/backend/position-reconciliation-import/bank-writer.js(3), src/backend/position-reconciliation-import/source-writer.js(2) |
| `jobDirectoryToken` | 3 | 8 | 3 | src/main-process/duplicate-inbound-match/spool-contract.js(3), src/main-process/pre-fund-reconciliation/mpt-import/spool-contract.js(3), src/main-process/bank-bu-worker/spool-contract.js(2) |
| `listDiffRows` | 3 | 8 | 1 | src/backend/pending-export/writer.js(4), src/backend/pending-db/diff-repository.js(2), src/backend/pending-reconcile/removal-match.js(2) |
| `MAX_ARTIFACT_BYTES` | 3 | 8 | 3 | src/main-process/new-account/generation-contract.js(3), src/main-process/statement-worker/generation-contracts.js(3), src/main-process/statement-worker/generation.js(2) |
| `NEW_ACCOUNT_GENERATION_SCHEMA_VERSION` | 3 | 8 | 1 | src/main-process/new-account/generation-contract.js(5), src/main-process/new-account/generation-validator.js(2), src/main-process/new-account/generation-core.js(1) |
| `normalizeCurrency` | 3 | 8 | 3 | src/backend/acquiring-bill-currency-db/import-repository.js(4), src/backend/acquiring-bill-currency-import/contract-bill.js(2), src/backend/acquiring-bill-currency-import/contract-flow.js(2) |
| `normalizeOptions` | 3 | 8 | 3 | src/main-process/bank-bu-worker/dual-parser-dispatch.js(3), src/main-process/duplicate-inbound-match/paired-parser-dispatch.js(3), src/main-process/pre-fund-reconciliation/mpt-import/managed-import.js(2) |
| `parseAmountToCents` | 3 | 8 | 1 | src/main-process/vcc-op-calc/parser-core.js(3), src/main-process/vcc-op-calc/save-run-contract.js(3), src/main-process/vcc-op-calc-session.js(2) |
| `PENDING_READ_ONLY_ACTION_SET` | 3 | 8 | 2 | src/main-process/read-only-exports/pending/policies.js(4), src/main-process/read-only-exports/pending/actions.js(2), src/main-process/read-only-exports/pending/worker-entry.js(2) |
| `pendingCanonicalValues` | 3 | 8 | 1 | src/backend/vcc-financial-op/row-mapper.js(3), src/main-process/vcc-financial-op-dataset-writer.js(3), src/backend/vcc-financial-op/detail-importer.js(2) |
| `pendingContentHash` | 3 | 8 | 1 | src/backend/vcc-financial-op/row-mapper.js(4), src/backend/vcc-financial-op-db/migrations.js(2), src/main-process/vcc-financial-op-dataset-writer.js(2) |
| `policyForAction` | 3 | 8 | 2 | src/main-process/background-execution/execution-policy-registry.js(3), src/main-process/background-execution/protocol-validator.js(3), src/main-process/background-execution/protocol-sequence-validator.js(2) |
| `POSITION_IMPORT_STREAMING_SOURCE_ALLOWLIST` | 3 | 8 | 1 | src/backend/position-reconciliation-import/constants.js(4), src/backend/position-reconciliation-import/source-writer.js(2), src/main-process/background-execution/adapters/position-import-adapter.js(2) |
| `previousDate` | 3 | 8 | 2 | src/main-process/biz-op-recon-run-data.js(3), src/main-process/read-only-exports/biz-op/query.js(3), src/main-process/biz-op-archive-lineage.js(2) |
| `REFUND_TEMPLATE_HEADERS` | 3 | 8 | 1 | src/main-process/refund-backfill-writer.js(4), src/constants/refund-backfill-fields.js(2), src/main-process/scenario-engines/r5-refund-order-backfill.js(2) |
| `registerVccStorageWriteCapability` | 3 | 8 | 1 | src/backend/vcc-financial-op-db/storage-contract.js(4), src/backend/vcc-financial-op-db/migrations.js(2), src/backend/vcc-financial-op/mutation-guard.js(2) |
| `RESULT_TEMPLATE_FILE_NAME` | 3 | 8 | 1 | src/backend/vcc-financial-op/result-template-contract.js(5), src/main-process/vcc-financial-op-output/artifact-evidence.js(2), src/main-process/vcc-financial-op-writer.js(1) |
| `sanitizeFinanceSafeValue` | 3 | 8 | 3 | src/main-process/background-execution/error-codec.js(4), src/main-process/background-execution/supervisor.js(2), src/main-process/recon-id-fix-service/service.js(2) |
| `scanBalanceSeedStatus` | 3 | 8 | 1 | src/main-process/statement-generation-business.js(5), src/main-process/statement-generation.js(2), src/main.js(1) |
| `sha256RegularFile` | 3 | 8 | 3 | src/main-process/read-only-exports/common/artifact-evidence.js(3), src/main-process/read-only-exports/pending/writer.js(3), src/main-process/pre-fund-reconciliation/mpt-import/spool-reader.js(2) |
| `SIGNED_AMOUNT_MAPPING_FIELD` | 3 | 8 | 2 | src/renderer-previews.js(3), src/renderer.js(3), src/main.js(2) |
| `snapshotResultMutationState` | 3 | 8 | 1 | src/backend/vcc-financial-op/calculator.js(3), src/backend/vcc-financial-op/result-adjustments.js(3), src/backend/vcc-financial-op/preserved-state.js(2) |
| `sourceForIntent` | 3 | 8 | 1 | src/main-process/pre-fund-reconciliation/mpt-import/worker-durable-coordinator.js(3), src/main-process/recon-id-fix-service/jpm-worker-durable-coordinator.js(3), src/main-process/manual-balance-seed-settlement.js(2) |
| `sourceIdentityFromError` | 3 | 8 | 2 | src/backend/vcc-financial-op/detail-importer.js(4), src/backend/vcc-financial-op/import-service.js(2), src/backend/vcc-financial-op/source-lineage.js(2) |
| `sourceTypeForFundType` | 3 | 8 | 1 | src/main-process/position-reconciliation/store.js(4), src/main-process/position-reconciliation/constants.js(2), src/main-process/position-reconciliation/service.js(2) |
| `TEXT_HEADER_PATTERN` | 3 | 8 | 2 | src/backend/position-reconciliation-import/anomaly-report.js(4), src/main-process/position-reconciliation/excel-io.js(2), src/main-process/position-reconciliation/filtered-source-report.js(2) |
| `topologyError` | 3 | 8 | 2 | src/main-process/pre-fund-reconciliation/mpt-import/topology.js(4), src/main-process/duplicate-inbound-match/paired-parser-dispatch.js(2), src/main-process/vcc-financial-op-output/topology.js(2) |
| `updateDateRange` | 3 | 8 | 1 | src/backend/position-reconciliation-import/preflight.js(4), src/backend/position-reconciliation-import/bank-writer.js(2), src/backend/position-reconciliation-import/source-writer.js(2) |
| `validateConsumedAttributeCase` | 3 | 8 | 3 | src/backend/toolbox-format/style-registry.js(3), src/backend/toolbox-format/xlsx-pass.js(3), src/backend/toolbox-format/xlsx-sheet-scanner.js(2) |
| `validateSourceRow` | 3 | 8 | 1 | src/main-process/position-reconciliation/readers.js(4), src/backend/position-reconciliation-import/account-writer.js(2), src/backend/position-reconciliation-import/contracts.js(2) |
| `verifyAnomalyReportFile` | 3 | 8 | 1 | src/main-process/position-reconciliation/filtered-source-report.js(4), src/main-process/position-reconciliation/service.js(2), src/main-process/read-only-exports/position/query.js(2) |
| `ACTION_KEYS` | 3 | 7 | 3 | src/main-process/pre-fund-reconciliation/mpt-import/operation-receipt-repository.js(3), src/main-process/bank-bu-worker/operation-receipt-repository.js(2), src/main-process/duplicate-inbound-match/operation-receipt-repository.js(2) |
| `assertMutationGuardPostwrite` | 3 | 7 | 1 | src/backend/vcc-financial-op/result-write.js(3), src/backend/vcc-financial-op/destructive-write.js(2), src/backend/vcc-financial-op/mutation-guard.js(2) |
| `assertMutationRuntimeAvailable` | 3 | 7 | 1 | src/backend/vcc-financial-op/result-write.js(3), src/backend/vcc-financial-op/destructive-write.js(2), src/backend/vcc-financial-op/mutation-guard.js(2) |
| `assertNoUnacknowledgedArchiveRunByDateBu` | 3 | 7 | 1 | src/backend/biz-op-recon-db/run-repository.js(4), src/main-process/biz-op-recon-session.js(2), src/main-process/biz-op-recon-run-data.js(1) |
| `assertPendingRunEvidence` | 3 | 7 | 1 | src/main-process/read-only-exports/pending/writer.js(3), src/main-process/read-only-exports/pending/query.js(2), src/main.js(2) |
| `assertTargetParentIdentityFresh` | 3 | 7 | 1 | src/main-process/toolbox-output-publication.js(3), src/main-process/archive-center/file-plan.js(2), src/main-process/archive-center/target-parent-identity.js(2) |
| `assertTaskStagingIdentity` | 3 | 7 | 1 | src/main-process/vcc-financial-op-output/dispatch.js(3), src/main-process/vcc-financial-op-output/staging-identity.js(2), src/main-process/vcc-financial-op-output/writer-core.js(2) |
| `assertVccFinancialOpSourceSnapshot` | 3 | 7 | 1 | src/main-process/read-only-exports/vcc-financial-op/writer.js(3), src/main-process/read-only-exports/vcc-financial-op/query.js(2), src/main.js(2) |
| `assertVccMutationSchema` | 3 | 7 | 1 | src/backend/vcc-financial-op/result-write.js(3), src/backend/vcc-financial-op/destructive-write.js(2), src/backend/vcc-financial-op/mutation-guard.js(2) |
| `backfillBocReconLinkIds` | 3 | 7 | 1 | src/main-process/linked-derive-rebuild.js(4), src/main-process/boc-fx-link-builder.js(2), src/main.js(1) |
| `balanceSeedRecordsEvidence` | 3 | 7 | 1 | src/main-process/manual-balance-seed-preflight.js(4), src/main-process/manual-balance-seed-settlement.js(2), src/main.js(1) |
| `bankAmountWithExtraFee` | 3 | 7 | 2 | src/main-process/scenario-engines/r5-fund-transfer-backfill.js(3), src/main-process/scenario-engines/many-to-many-detector.js(2), src/main-process/scenario-engines/r5-fund-transfer-recon-backfill.js(2) |
| `beginMutationGuard` | 3 | 7 | 1 | src/backend/vcc-financial-op/result-write.js(3), src/backend/vcc-financial-op/destructive-write.js(2), src/backend/vcc-financial-op/mutation-guard.js(2) |
| `buildBocBankRows` | 3 | 7 | 1 | src/main-process/linked-derive-rebuild.js(4), src/main-process/boc-fx-link-builder.js(2), src/main.js(1) |
| `buildDateRangeLabel` | 3 | 7 | 1 | src/main-process/statement-generation-business.js(3), src/main-process/statement-generation.js(3), src/main.js(1) |
| `buildGatewayFingerprint` | 3 | 7 | 2 | src/main-process/pre-fund-reconciliation/mpt-schema.js(3), src/main-process/pre-fund-reconciliation/matching-engine.js(2), src/main-process/pre-fund-reconciliation/mpt-import/spool-reader.js(2) |
| `buildInsertSql` | 3 | 7 | 3 | src/backend/bank-bu-recon-db/month-repository.js(3), src/backend/biz-op-recon-db/flow-imports-repository.js(2), src/backend/biz-op-recon-db/imports-repository.js(2) |
| `buildMappedRows` | 3 | 7 | 2 | src/backend/file-service.js(3), src/main-process/statement-worker/session-state.js(3), src/main.js(1) |
| `captureMirrorPreimage` | 3 | 7 | 2 | src/main-process/bank-bu-worker/mirror-repository.js(3), src/main-process/bank-bu-worker/main-coordinator.js(2), src/main-process/bank-bu-worker/outcome-inspector.js(2) |
| `cleanupBankBuSpool` | 3 | 7 | 1 | src/main-process/bank-bu-worker/dual-parser-dispatch.js(3), src/main-process/bank-bu-worker/spool-filesystem.js(2), src/main-process/bank-bu-worker/spool-writer.js(2) |
| `cleanupDuplicateSpool` | 3 | 7 | 1 | src/main-process/duplicate-inbound-match/paired-parser-dispatch.js(3), src/main-process/duplicate-inbound-match/spool-filesystem.js(2), src/main-process/duplicate-inbound-match/spool-writer.js(2) |
| `cleanupMptFileSpool` | 3 | 7 | 3 | src/main-process/pre-fund-reconciliation/mpt-import/spool-writer.js(3), src/main-process/pre-fund-reconciliation/mpt-import/managed-import.js(2), src/main-process/pre-fund-reconciliation/mpt-import/single-writer-session.js(2) |
| `computeDuplicateResultPostImage` | 3 | 7 | 1 | src/backend/duplicate-inbound-match-store.js(3), src/backend/duplicate-inbound-match-result-digest.js(2), src/main-process/duplicate-inbound-match/startup-recovery.js(2) |
| `createBigTableImportMatureBinding` | 3 | 7 | 1 | src/main-process/background-execution/mature-action-adapters.js(3), src/main-process/background-execution/adapters/acquiring-adapter.js(2), src/main-process/big-table-import-dispatch.js(2) |
| `createScenario` | 3 | 7 | 1 | src/main-process/scenarios-bundle-import.js(3), src/backend/database.js(2), src/backend/database/scenarios-repository.js(2) |
| `createStatementImportSession` | 3 | 7 | 1 | src/main-process/statement-session.js(3), src/main-process/statement-worker/probe-state-builder.js(2), src/main-process/statement-worker/session-state.js(2) |
| `createStatementInteractionRequiredResult` | 3 | 7 | 1 | src/main-process/statement-worker/contracts.js(3), src/main-process/statement-worker/probe-state-builder.js(2), src/main-process/statement-worker/service.js(2) |
| `createStatementTokenHandleDto` | 3 | 7 | 1 | src/main-process/statement-worker/contracts.js(3), src/main-process/statement-worker/probe-state-builder.js(2), src/main-process/statement-worker/token-store.js(2) |
| `decodeExcelStXstring` | 3 | 7 | 1 | src/backend/toolbox-format/xlsx-sheet-scanner.js(3), src/backend/toolbox-format/excel-text.js(2), src/backend/toolbox-format/xlsx-pass.js(2) |
| `deriveBalanceRecords` | 3 | 7 | 1 | src/main-process/statement-generation-business.js(4), src/main-process/statement-generation.js(2), src/main.js(1) |
| `dispatchPositionImportPreflight` | 3 | 7 | 1 | src/main-process/position-reconciliation/import-dispatch.js(3), src/main-process/background-execution/adapters/position-import-adapter.js(2), src/main-process/position-reconciliation/service.js(2) |
| `DUPLICATE_GATEWAY_HEADERS` | 3 | 7 | 1 | src/main-process/pre-fund-reconciliation/excel-writer.js(3), src/main-process/pre-fund-reconciliation/output-mapper.js(2), src/main-process/recon-id-fix-io.js(2) |
| `DUPLICATE_SERVICE_KEY` | 3 | 7 | 1 | src/main-process/duplicate-inbound-match/policies.js(3), src/main-process/background-execution/runtime.js(2), src/main-process/duplicate-inbound-match/worker-host.js(2) |
| `DUPLICATE_STARTUP_CONFLICT_SCOPE_KEY` | 3 | 7 | 1 | src/main-process/duplicate-inbound-match/startup-recovery.js(4), src/main-process/duplicate-inbound-match/startup-gate.js(2), src/main.js(1) |
| `ensureSupportedFile` | 3 | 7 | 2 | src/backend/file-service/readers.js(3), src/backend/file-service.js(2), src/main-process/toolbox-input-kind.js(2) |
| `EXACT_RECEIPT_KEYS` | 3 | 7 | 3 | src/main-process/pre-fund-reconciliation/mpt-import/operation-receipt-repository.js(3), src/main-process/bank-bu-worker/operation-receipt-repository.js(2), src/main-process/duplicate-inbound-match/operation-receipt-repository.js(2) |
| `executeRegisteredMutationSteps` | 3 | 7 | 1 | src/backend/vcc-financial-op/result-write.js(3), src/backend/vcc-financial-op/destructive-write.js(2), src/backend/vcc-financial-op/mutation-guard.js(2) |
| `expectedLedgerFile` | 3 | 7 | 1 | src/backend/position-reconciliation-import/source-writer.js(3), src/backend/position-reconciliation-import/account-writer.js(2), src/backend/position-reconciliation-import/bank-writer.js(2) |
| `failExecutionTransportForCoordinator` | 3 | 7 | 1 | src/main-process/bank-bu-worker/dual-parser-dispatch.js(3), src/main-process/background-execution/supervisor.js(2), src/main-process/duplicate-inbound-match/paired-parser-dispatch.js(2) |
| `fingerprintQuery` | 3 | 7 | 1 | src/backend/vcc-financial-op/dataset-deletion.js(3), src/backend/vcc-financial-op/operation-state.js(2), src/backend/vcc-financial-op/preserved-state.js(2) |
| `fitsWithin` | 3 | 7 | 2 | src/main-process/background-execution/resource-governor.js(3), src/main-process/background-execution/resource-lease.js(2), src/main-process/background-execution/supervisor.js(2) |
| `FUND_RECON_SERVICE_KEY` | 3 | 7 | 1 | src/main-process/fund-recon-worker/policies.js(3), src/main-process/background-execution/runtime.js(2), src/main-process/fund-recon-worker/worker-host.js(2) |
| `inspectDatasetExport` | 3 | 7 | 1 | src/main-process/vcc-financial-op-dataset-writer.js(3), src/main-process/read-only-exports/vcc-financial-op/query.js(2), src/main-process/vcc-financial-op-service.js(2) |
| `iterateDuplicateAuditRows` | 3 | 7 | 2 | src/main-process/pre-fund-reconciliation/output-mapper.js(3), src/main-process/pre-fund-reconciliation/service.js(2), src/main-process/read-only-exports/pre-fund/query.js(2) |
| `listAllRuns` | 3 | 7 | 1 | src/backend/pending-db/diff-repository.js(3), src/renderer-pending.js(3), src/preload.js(1) |
| `mapDetailRow` | 3 | 7 | 1 | src/main-process/vcc-financial-op-dataset-writer.js(3), src/backend/vcc-financial-op/detail-importer.js(2), src/backend/vcc-financial-op/row-mapper.js(2) |
| `MODULE_BIZ_OP` | 3 | 7 | 1 | src/backend/run-data-store.js(5), src/main-process/biz-op-recon-run-data.js(1), src/main-process/read-only-exports/biz-op/query.js(1) |
| `MPT_DELIMITER` | 3 | 7 | 1 | src/main-process/pre-fund-reconciliation/mpt-parser.js(3), src/main-process/pre-fund-reconciliation/mpt-import/spool-reader.js(2), src/main-process/pre-fund-reconciliation/mpt-schema.js(2) |
| `MPT_SPOOL_SCHEMA_VERSION` | 3 | 7 | 1 | src/main-process/pre-fund-reconciliation/mpt-import/spool-writer.js(3), src/main-process/pre-fund-reconciliation/mpt-import/spool-contract.js(2), src/main-process/pre-fund-reconciliation/mpt-import/spool-reader.js(2) |
| `normalizeParserInput` | 3 | 7 | 1 | src/main-process/vcc-op-calc/parser-core.js(3), src/main-process/vcc-op-calc/ordered-reducer.js(2), src/main-process/vcc-op-calc/parser-pipeline.js(2) |
| `normalizePositionImportEngine` | 3 | 7 | 1 | src/backend/position-reconciliation-import/constants.js(3), src/main-process/position-reconciliation/import-dispatch.js(2), src/main-process/position-reconciliation/service.js(2) |
| `normalizeWorksheetTarget` | 3 | 7 | 3 | src/backend/biz-op-recon-import/reader-streamed.js(3), src/backend/big-table-import/zip-reader.js(2), src/backend/vcc-financial-op/system-op-importer.js(2) |
| `openDb` | 3 | 7 | 2 | src/backend/duplicate-inbound-match-store.js(3), src/backend/biz-op-recon-import/import-worker.js(2), src/backend/vcc-financial-op/worker-entry.js(2) |
| `parsePaymentBigAccounts` | 3 | 7 | 1 | src/renderer-dialogs.js(3), src/main-process/scenario-engines/r5-payment-offline-allocation-backfill.js(2), src/shared/payment-big-accounts.js(2) |
| `parseRequiredBillDates` | 3 | 7 | 1 | src/main-process/statement-generation-business.js(3), src/main-process/statement-generation.js(3), src/main.js(1) |
| `parseWorkbookRelationships` | 3 | 7 | 1 | src/backend/toolbox-format/xlsx-pass.js(3), src/backend/position-reconciliation-import/xlsx-reader.js(2), src/main-process/toolbox-large-split-router.js(2) |
| `PERSISTENT` | 3 | 7 | 1 | src/main-process/pre-fund-reconciliation/matching-engine.js(3), src/main-process/duplicate-inbound-match/policies.js(2), src/main-process/pre-fund-reconciliation/service.js(2) |
| `plainObject` | 3 | 7 | 1 | src/main-process/read-only-exports/common/contract.js(3), src/main-process/read-only-exports/biz-op/actions.js(2), src/main-process/read-only-exports/pending/actions.js(2) |
| `POSITION_DB_RELATIVE_PATH` | 3 | 7 | 2 | src/main-process/position-reconciliation/store.js(3), src/main-process/position-reconciliation/constants.js(2), src/main-process/read-only-exports/position/actions.js(2) |
| `publicResult` | 3 | 7 | 1 | src/main-process/recon-id-fix-service/worker-entry.js(3), src/main-process/pre-fund-reconciliation/service.js(2), src/main-process/recon-id-fix-service/service.js(2) |
| `publishVccFinancialOpOutputs` | 3 | 7 | 2 | src/main.js(3), src/main-process/vcc-financial-op-output-recovery.js(2), src/main-process/vcc-financial-op-output/dispatch.js(2) |
| `readAndValidateMptFileSpool` | 3 | 7 | 2 | src/backend/pre-fund-reconciliation-store.js(3), src/main-process/pre-fund-reconciliation/mpt-import/single-writer-session.js(2), src/main-process/pre-fund-reconciliation/mpt-import/spool-reader.js(2) |
| `readFirstMonthFacts` | 3 | 7 | 1 | src/backend/vcc-financial-op-db/migrations.js(3), src/backend/vcc-financial-op-db/repository.js(2), src/backend/vcc-financial-op-db/state-model.js(2) |
| `readSheetAsRows` | 3 | 7 | 3 | src/backend/pending-import/removed-reader.js(3), src/backend/bank-bu-recon-import/reader.js(2), src/backend/biz-op-recon-import/reader.js(2) |
| `RecoveryHoldActiveError` | 3 | 7 | 1 | src/main-process/background-execution/recovery-hold-gate.js(3), src/main-process/background-execution/index.js(2), src/main-process/recon-id-fix-service/jpm-hold-gate.js(2) |
| `recoveryHoldReasonForInspection` | 3 | 7 | 1 | src/main-process/manual-balance-seed-settlement.js(3), src/main-process/background-execution/recovery-hold-request.js(2), src/main-process/background-execution/startup-recovery-coordinator.js(2) |
| `requireSha256` | 3 | 7 | 3 | src/main-process/pre-fund-reconciliation/mpt-import/operation-receipt-repository.js(3), src/main-process/bank-bu-worker/operation-receipt-repository.js(2), src/main-process/duplicate-inbound-match/operation-receipt-repository.js(2) |
| `rowText` | 3 | 7 | 1 | src/main-process/duplicate-inbound-match/spool-reader.js(3), src/main-process/duplicate-inbound-match/matching-engine.js(2), src/main-process/pre-fund-reconciliation/bank-row.js(2) |
| `saxAttributeIdentity` | 3 | 7 | 1 | src/backend/toolbox-format/xlsx-pass.js(3), src/backend/toolbox-format/ooxml-namespaces.js(2), src/backend/toolbox-format/style-registry.js(2) |
| `sourceRecords` | 3 | 7 | 1 | src/main-process/position-reconciliation/store.js(4), src/main-process/position-reconciliation/matching-engine.js(2), src/main-process/position-reconciliation/service.js(1) |
| `SourceStyleRegistry` | 3 | 7 | 3 | src/backend/toolbox-format/style-registry.js(3), src/backend/toolbox-format/biff8-pass.js(2), src/backend/toolbox-format/csv-pass.js(2) |
| `syncStagedFile` | 3 | 7 | 1 | src/main-process/archive-center/storage-materializer.js(3), src/main-process/archive-center/archive-service.js(2), src/main-process/archive-center/storage-root-manager.js(2) |
| `v8` | 3 | 7 | 3 | src/main-process/toolbox-background/route-db-contract.js(3), src/backend/biz-op-recon-import/import-worker.js(2), src/backend/pending-import/worker.js(2) |
| `validateAcquiringExportResult` | 3 | 7 | 1 | src/main-process/read-only-exports/acquiring/policies.js(3), src/main-process/background-execution/runtime.js(2), src/main-process/read-only-exports/acquiring/business-validator.js(2) |
| `validateBizOpReadOnlyExportResult` | 3 | 7 | 2 | src/main-process/read-only-exports/biz-op/policies.js(3), src/main-process/background-execution/runtime.js(2), src/main-process/read-only-exports/biz-op/business-validator.js(2) |
| `validateContract` | 3 | 7 | 3 | src/backend/big-table-import/engine.js(3), src/backend/big-table-import/contract.js(2), src/backend/big-table-import/import-worker.js(2) |
| `validateGeneratedWorkbook` | 3 | 7 | 2 | src/main-process/toolbox-output-writer.js(3), src/main-process/toolbox-background/generation-validator.js(2), src/main-process/toolbox-background/multi-output-validator.js(2) |
| `validatePendingReadOnlyExportResult` | 3 | 7 | 2 | src/main-process/read-only-exports/pending/policies.js(3), src/main-process/background-execution/runtime.js(2), src/main-process/read-only-exports/pending/business-validator.js(2) |
| `validatePositionReadOnlyExportResult` | 3 | 7 | 2 | src/main-process/read-only-exports/position/policies.js(3), src/main-process/background-execution/runtime.js(2), src/main-process/read-only-exports/position/business-validator.js(2) |
| `validatePreFundReadOnlyExportResult` | 3 | 7 | 2 | src/main-process/read-only-exports/pre-fund/policies.js(3), src/main-process/background-execution/runtime.js(2), src/main-process/read-only-exports/pre-fund/business-validator.js(2) |
| `validatePureComputeCanaryResult` | 3 | 7 | 1 | src/main-process/background-execution/canary/index.js(3), src/main-process/background-execution/canary/packaged-runtime-runner.js(2), src/main-process/background-execution/canary/pure-compute.js(2) |
| `validateReconFixExportResult` | 3 | 7 | 1 | src/main-process/recon-id-fix-service/policies.js(3), src/main-process/background-execution/runtime.js(2), src/main-process/recon-id-fix-service/export-operation.js(2) |
| `validateReconFixJpmResult` | 3 | 7 | 1 | src/main-process/recon-id-fix-service/policies.js(3), src/main-process/background-execution/runtime.js(2), src/main-process/recon-id-fix-service/export-operation.js(2) |
| `validateReconFixServiceResult` | 3 | 7 | 1 | src/main-process/recon-id-fix-service/policies.js(3), src/main-process/background-execution/runtime.js(2), src/main-process/recon-id-fix-service/export-operation.js(2) |
| `validateStatementGenerationResult` | 3 | 7 | 2 | src/main-process/statement-worker/contracts.js(3), src/main-process/statement-worker/generation-contracts.js(2), src/main-process/statement-worker/publication.js(2) |
| `validateVccExportSingleResult` | 3 | 7 | 1 | src/main-process/vcc-financial-op-output/policies.js(3), src/main-process/background-execution/runtime.js(2), src/main-process/vcc-financial-op-output/dispatch.js(2) |
| `validateVccFinancialOpReadOnlyExportResult` | 3 | 7 | 2 | src/main-process/read-only-exports/vcc-financial-op/policies.js(3), src/main-process/background-execution/runtime.js(2), src/main-process/read-only-exports/vcc-financial-op/business-validator.js(2) |
| `waitForExternalParserShutdownPhase` | 3 | 7 | 1 | src/main-process/background-execution/runtime.js(3), src/main-process/background-execution/external-parser-finalization.js(2), src/main-process/duplicate-inbound-match/paired-parser-shutdown.js(2) |
| `WORKER_SCRIPT_PATH` | 3 | 7 | 3 | src/backend/big-table-import/pipeline.js(3), src/main-process/run-check-multiworker.js(2), src/main-process/run-check-worker-pool.js(2) |
| `writeBizOpErrorReportXlsx` | 3 | 7 | 1 | src/main-process/biz-op-recon-session.js(4), src/main-process/biz-op-recon-writer.js(2), src/main.js(1) |
| `writeFlowErrorReportXlsx` | 3 | 7 | 1 | src/main-process/biz-op-recon-session.js(4), src/main-process/biz-op-recon-writer.js(2), src/main.js(1) |
| `writeResultWorkbook` | 3 | 7 | 2 | src/main-process/position-reconciliation/service.js(3), src/main-process/position-reconciliation/excel-io.js(2), src/main-process/read-only-exports/position/writer.js(2) |
| `xmlUnescape` | 3 | 7 | 3 | src/backend/big-table-import/row-scanner.js(5), src/backend/acquiring-bill-currency-import/reader-handrolled.js(1), src/backend/pending-import/streaming-xlsx-reader.js(1) |
| `ZHONGTAI_REFUND_ORDER_SIGNATURE` | 3 | 7 | 2 | src/constants/table-signatures.js(3), src/constants/refund-backfill-fields.js(2), src/main-process/fund-recon-worker/source-readers.js(2) |
| `acknowledgeRunByTaskRun` | 3 | 6 | 1 | src/main-process/biz-op-recon-run-data.js(3), src/main-process/pre-fund-archive-lineage.js(2), src/main-process/pre-fund-reconciliation/service.js(1) |
| `assertBizOpSourceSnapshot` | 3 | 6 | 1 | src/main-process/read-only-exports/biz-op/query.js(2), src/main-process/read-only-exports/biz-op/writer.js(2), src/main.js(2) |
| `assertExcelStXstringRawLength` | 3 | 6 | 1 | src/backend/toolbox-format/excel-text.js(2), src/backend/toolbox-format/xlsx-pass.js(2), src/backend/toolbox-format/xlsx-sheet-scanner.js(2) |
| `assertExpectedResultRevision` | 3 | 6 | 1 | src/backend/vcc-financial-op/calculator.js(2), src/backend/vcc-financial-op/result-adjustments.js(2), src/backend/vcc-financial-op/result-write.js(2) |
| `assertPositionSourceSnapshot` | 3 | 6 | 1 | src/main-process/read-only-exports/position/query.js(2), src/main-process/read-only-exports/position/writer.js(2), src/main.js(2) |
| `assertPreFundSourceSnapshot` | 3 | 6 | 1 | src/main-process/read-only-exports/pre-fund/query.js(2), src/main-process/read-only-exports/pre-fund/writer.js(2), src/main.js(2) |
| `assertSourceFileMatchesSync` | 3 | 6 | 1 | src/backend/vcc-financial-op/detail-importer.js(2), src/backend/vcc-financial-op/source-lineage.js(2), src/backend/vcc-financial-op/system-op-importer.js(2) |
| `BASE_RESOURCES` | 3 | 6 | 3 | src/main-process/background-execution/acquiring-adapter-policies.js(2), src/main-process/fund-recon-worker/policies.js(2), src/main-process/recon-id-fix-service/policies.js(2) |
| `batchMatchesReceiptEvidence` | 3 | 6 | 1 | src/backend/pre-fund-reconciliation-store.js(2), src/main-process/pre-fund-reconciliation/mpt-import/business-evidence.js(2), src/main-process/pre-fund-reconciliation/mpt-import/outcome-inspector.js(2) |
| `beginExternalParserShutdown` | 3 | 6 | 1 | src/main-process/background-execution/external-parser-finalization.js(2), src/main-process/background-execution/runtime.js(2), src/main-process/duplicate-inbound-match/paired-parser-shutdown.js(2) |
| `buildDeleteTargetTokenV2` | 3 | 6 | 1 | src/backend/vcc-financial-op/destructive-write.js(2), src/backend/vcc-financial-op/operation-token-v2.js(2), src/backend/vcc-financial-op/read-snapshot.js(2) |
| `buildOperationTokenV2` | 3 | 6 | 1 | src/backend/vcc-financial-op/destructive-write.js(2), src/backend/vcc-financial-op/operation-token-v2.js(2), src/backend/vcc-financial-op/read-snapshot.js(2) |
| `C4_CATEGORIES` | 3 | 6 | 3 | src/main-process/scenario-dispatcher.js(3), src/main-process/fund-recon-worker/evidence-provider.js(2), src/main.js(1) |
| `CHANNEL_VALUE` | 3 | 6 | 2 | src/backend/database/linked-table-repository.js(2), src/constants/adm-bank-deposit-fields.js(2), src/main-process/adm-bank-deposit-builder.js(2) |
| `classifyNumericOutput` | 3 | 6 | 1 | src/backend/toolbox-format/model.js(2), src/backend/toolbox-format/number-date.js(2), src/backend/toolbox-format/xlsx-sheet-scanner.js(2) |
| `cleanupMptSpoolParents` | 3 | 6 | 3 | src/main-process/pre-fund-reconciliation/mpt-import/managed-import.js(2), src/main-process/pre-fund-reconciliation/mpt-import/single-writer-session.js(2), src/main-process/pre-fund-reconciliation/mpt-import/spool-writer.js(2) |
| `clearMonth` | 3 | 6 | 2 | src/main-process/acquiring-bill-currency-session.js(3), src/backend/acquiring-bill-currency-db/import-repository.js(2), src/preload.js(1) |
| `columnLetterToIndex` | 3 | 6 | 2 | src/backend/acquiring-bill-currency-import/reader.js(3), src/backend/big-table-import/row-scanner.js(2), src/backend/acquiring-bill-currency-import/reader-handrolled.js(1) |
| `commitMirrorCas` | 3 | 6 | 2 | src/main-process/bank-bu-worker/main-coordinator.js(2), src/main-process/bank-bu-worker/mirror-repository.js(2), src/main-process/bank-bu-worker/outcome-inspector.js(2) |
| `compareCanonicalDecimals` | 3 | 6 | 1 | src/main-process/financial-decimal.js(2), src/main-process/position-reconciliation/decimal.js(2), src/main-process/scenario-engines/r5-refund-order-backfill.js(2) |
| `compileRegexLiteral` | 3 | 6 | 1 | src/backend/file-service/normalizers.js(3), src/backend/file-service.js(2), src/main.js(1) |
| `computeRowHash` | 3 | 6 | 3 | src/backend/pending-import/contract-pending.js(2), src/backend/pending-import/validator.js(2), src/backend/pending-import/worker.js(2) |
| `configureDatabase` | 3 | 6 | 3 | src/backend/position-reconciliation-import/account-writer.js(2), src/backend/position-reconciliation-import/bank-writer.js(2), src/backend/position-reconciliation-import/maintenance-writer.js(2) |
| `createExistingDispatchAdapter` | 3 | 6 | 2 | src/main-process/background-execution/adapters/existing-dispatch-adapter.js(2), src/main-process/background-execution/index.js(2), src/main-process/background-execution/supervisor.js(2) |
| `createInlineAsyncAdapter` | 3 | 6 | 3 | src/main-process/background-execution/adapters/inline-async-adapter.js(2), src/main-process/background-execution/index.js(2), src/main-process/background-execution/supervisor.js(2) |
| `createPlatformResourceBudgets` | 3 | 6 | 2 | src/main-process/background-execution/index.js(2), src/main-process/background-execution/resource-budget.js(2), src/main-process/background-execution/runtime.js(2) |
| `createPreFundReconciliationStore` | 3 | 6 | 1 | src/backend/pre-fund-reconciliation-store.js(2), src/main-process/duplicate-inbound-match/service.js(2), src/main-process/pre-fund-reconciliation/service.js(2) |
| `createServiceHost` | 3 | 6 | 2 | src/main-process/background-execution/index.js(2), src/main-process/background-execution/service-host.js(2), src/main-process/background-execution/supervisor.js(2) |
| `createSourceStyleRegistryFromOoxml` | 3 | 6 | 1 | src/backend/position-reconciliation-import/xlsx-reader.js(2), src/backend/toolbox-format/style-registry.js(2), src/backend/toolbox-format/xlsx-pass.js(2) |
| `createStatementPublicInteractionDto` | 3 | 6 | 1 | src/main-process/statement-worker/contracts.js(2), src/main-process/statement-worker/probe-state-builder.js(2), src/main-process/statement-worker/token-store.js(2) |
| `createStorageMaterializer` | 3 | 6 | 1 | src/main-process/archive-center/archive-service.js(2), src/main-process/archive-center/storage-materializer.js(2), src/main-process/archive-center/storage-root-manager.js(2) |
| `createTaskPolicyRegistry` | 3 | 6 | 2 | src/main-process/archive-center/operation-tracker.js(2), src/main-process/archive-center/task-policy-registry.js(2), src/main.js(2) |
| `DATE_MISMATCH_WARNING_CODE` | 3 | 6 | 3 | src/main-process/scenario-engines/dbs-charge-fund-check.js(2), src/main-process/scenario-engines/r5-fund-transfer-backfill.js(2), src/main-process/scenario-engines/r5-fund-transfer-recon-backfill.js(2) |
| `delay` | 3 | 6 | 2 | src/main-process/bank-bu-worker/spool-reader.js(2), src/main-process/duplicate-inbound-match/spool-reader.js(2), src/main-process/statement-worker/service.js(2) |
| `deleteMonthSideDb` | 3 | 6 | 3 | src/main-process/acquiring-bill-currency-run-data.js(2), src/main-process/bank-bu-recon-run-data.js(2), src/main-process/biz-op-recon-run-data.js(2) |
| `derivePreFundMptConflictScopeKey` | 3 | 6 | 1 | src/main-process/pre-fund-reconciliation/mpt-import/conflict-scope.js(2), src/main-process/pre-fund-reconciliation/mpt-import/hold-gate.js(2), src/main-process/pre-fund-reconciliation/mpt-import/worker-durable-coordinator.js(2) |
| `deriveReconFixJpmDatabaseIdentity` | 3 | 6 | 1 | src/main-process/recon-id-fix-service/jpm-database-authority.js(3), src/main-process/recon-id-fix-service/service.js(2), src/main.js(1) |
| `DIRECTION_MISMATCH_WARNING_CODE` | 3 | 6 | 3 | src/main-process/scenario-engines/dbs-charge-fund-check.js(2), src/main-process/scenario-engines/r5-fund-transfer-backfill.js(2), src/main-process/scenario-engines/r5-fund-transfer-recon-backfill.js(2) |
| `evaluateUnarchiveGate` | 3 | 6 | 2 | src/backend/vcc-financial-op/destructive-write.js(2), src/backend/vcc-financial-op/read-snapshot.js(2), src/backend/vcc-financial-op/unarchive-gate.js(2) |
| `executePureComputeCanary` | 3 | 6 | 2 | src/main-process/background-execution/canary/index.js(2), src/main-process/background-execution/canary/pure-compute-worker.js(2), src/main-process/background-execution/canary/pure-compute.js(2) |
| `executeVccExportWriter` | 3 | 6 | 3 | src/main-process/vcc-financial-op-output/shard-writer-worker-entry.js(2), src/main-process/vcc-financial-op-output/single-writer-worker-entry.js(2), src/main-process/vcc-financial-op-output/writer-core.js(2) |
| `flowRowToArray` | 3 | 6 | 1 | src/backend/biz-op-recon-db/columns.js(2), src/backend/vcc-op-calc-db/columns.js(2), src/main-process/biz-op-recon-writer.js(2) |
| `freezePendingDatasetSeedV1` | 3 | 6 | 2 | src/backend/pending-db/dataset-identity.js(2), src/backend/pending-import/contract-pending.js(2), src/backend/pending-import/worker.js(2) |
| `FUND_TRANSFER_RECON_UNUSED` | 3 | 6 | 1 | src/constants/fund-transfer-recon-fields.js(2), src/main-process/fund-transfer-recon-builder.js(2), src/main-process/scenario-engines/r5-payment-offline-allocation-backfill.js(2) |
| `FUND_TYPE_PAIRS` | 3 | 6 | 1 | src/main-process/position-reconciliation/constants.js(2), src/main-process/position-reconciliation/contracts.js(2), src/main-process/position-reconciliation/service.js(2) |
| `getAmountSplitRules` | 3 | 6 | 1 | src/backend/database/template-repository.js(3), src/backend/database.js(2), src/preload.js(1) |
| `getMirrorRun` | 3 | 6 | 2 | src/main-process/bank-bu-recon-run-data.js(2), src/main-process/bank-bu-worker/export-operation.js(2), src/main-process/biz-op-recon-run-data.js(2) |
| `getReconIdFixOutputContract` | 3 | 6 | 1 | src/main-process/recon-id-fix-service/service.js(3), src/main-process/recon-id-fix-service/artifact-evidence.js(2), src/main-process/recon-id-fix-io.js(1) |
| `groupBigAccountRows` | 3 | 6 | 2 | src/backend/database/template-repository.js(3), src/backend/database/utils.js(2), src/main.js(1) |
| `handleControl` | 3 | 6 | 1 | src/main-process/duplicate-inbound-match/worker-host.js(2), src/main-process/fund-recon-worker/worker-host.js(2), src/main-process/recon-id-fix-service/worker-entry.js(2) |
| `hslToRgb` | 3 | 6 | 3 | src/backend/toolbox-format/biff8-colors.js(2), src/backend/toolbox-format/style-registry.js(2), src/renderer.js(2) |
| `identityFromPendingDatasetSeed` | 3 | 6 | 2 | src/backend/pending-db/dataset-identity.js(2), src/backend/pending-db/removed-repository.js(2), src/backend/pending-import/worker.js(2) |
| `initializeActionTaskBindingStartup` | 3 | 6 | 2 | src/main-process/background-execution/action-task-binding-registry.js(2), src/main-process/background-execution/index.js(2), src/main.js(2) |
| `inspectFiles` | 3 | 6 | 2 | src/backend/vcc-financial-op/import-service.js(2), src/backend/vcc-financial-op/worker-entry.js(2), src/main-process/pre-fund-reconciliation/mpt-import/hold-gate.js(2) |
| `inspectionObservationSafePayload` | 3 | 6 | 1 | src/main-process/background-execution/recovery-hold-request.js(2), src/main-process/background-execution/startup-recovery-coordinator.js(2), src/main-process/manual-balance-seed-settlement.js(2) |
| `inspectSealedRouteDb` | 3 | 6 | 2 | src/main-process/toolbox-background/multi-output-validator.js(2), src/main-process/toolbox-background/output-writer-core.js(2), src/main-process/toolbox-background/route-db-contract.js(2) |
| `inspectSourceFiles` | 3 | 6 | 3 | src/backend/vcc-financial-op/detail-importer.js(2), src/backend/vcc-financial-op/import-service.js(2), src/backend/vcc-financial-op/workbook-reader.js(2) |
| `isPositionImportCancellationLocked` | 3 | 6 | 1 | src/backend/position-reconciliation-import/constants.js(2), src/backend/position-reconciliation-import/worker-entry.js(2), src/main-process/position-reconciliation/service.js(2) |
| `isPositionImportMutatingCommand` | 3 | 6 | 1 | src/backend/position-reconciliation-import/constants.js(2), src/backend/position-reconciliation-import/worker-entry.js(2), src/main-process/position-reconciliation/import-dispatch.js(2) |
| `isPreFundMptConflictScopeKey` | 3 | 6 | 2 | src/main-process/pre-fund-reconciliation/mpt-import/conflict-scope.js(2), src/main-process/pre-fund-reconciliation/mpt-import/file-result-safety.js(2), src/main-process/pre-fund-reconciliation/mpt-import/hold-gate.js(2) |
| `isRegexLiteral` | 3 | 6 | 1 | src/backend/file-service/normalizers.js(3), src/backend/file-service.js(2), src/main.js(1) |
| `JOURNAL_INDEX_NAME` | 3 | 6 | 2 | src/main-process/toolbox-output-publication.js(3), src/main-process/toolbox-output-publication-dispatch.js(2), src/main.js(1) |
| `listAdjustmentOptions` | 3 | 6 | 1 | src/main-process/vcc-financial-op-service.js(3), src/backend/vcc-financial-op/result-adjustments.js(2), src/preload.js(1) |
| `listArchivedResultMonths` | 3 | 6 | 1 | src/main-process/vcc-financial-op-service.js(3), src/backend/vcc-financial-op/unarchive.js(2), src/preload.js(1) |
| `listGatewayBillSourceTags` | 3 | 6 | 1 | src/backend/database.js(2), src/backend/database/linked-table-repository.js(2), src/main-process/pre-fund-reconciliation/service.js(2) |
| `listImportRecords` | 3 | 6 | 1 | src/main-process/vcc-financial-op-service.js(3), src/backend/vcc-financial-op-db/repository.js(2), src/preload.js(1) |
| `listRunsByDateBu` | 3 | 6 | 1 | src/main-process/biz-op-recon-run-data.js(3), src/backend/biz-op-recon-db/run-repository.js(2), src/main-process/read-only-exports/biz-op/query.js(1) |
| `loadCurrencyMappings` | 3 | 6 | 2 | src/backend/file-service.js(3), src/backend/file-service/normalizers.js(2), src/main.js(1) |
| `loadSharedStringsProvider` | 3 | 6 | 1 | src/backend/position-reconciliation-import/shared-strings-provider.js(2), src/backend/position-reconciliation-import/xlsx-reader.js(2), src/backend/vcc-financial-op/workbook-reader.js(2) |
| `makeRowInserter` | 3 | 6 | 2 | src/backend/biz-op-recon-db/flow-imports-repository.js(2), src/backend/biz-op-recon-db/imports-repository.js(2), src/backend/biz-op-recon-import/import-worker.js(2) |
| `nextDatasetIdentity` | 3 | 6 | 1 | src/backend/biz-op-recon-db/dataset-head-repository.js(2), src/backend/biz-op-recon-import/import-worker.js(2), src/main-process/biz-op-recon-session.js(2) |
| `normalizeBillDate` | 3 | 6 | 3 | src/backend/acquiring-bill-currency-db/import-repository.js(2), src/backend/acquiring-bill-currency-import/contract-bill.js(2), src/backend/acquiring-bill-currency-import/validator.js(2) |
| `normalizeMptRow` | 3 | 6 | 1 | src/main-process/pre-fund-reconciliation/mpt-import/spool-reader.js(2), src/main-process/pre-fund-reconciliation/mpt-parser.js(2), src/main-process/pre-fund-reconciliation/mpt-schema.js(2) |
| `openToolboxXlsxPass` | 3 | 6 | 1 | src/backend/toolbox-format/xlsx-pass.js(2), src/main-process/toolbox-format-io.js(2), src/main-process/toolbox-output-writer.js(2) |
| `ORDER_REPAIR_FIELDS` | 3 | 6 | 2 | src/constants/recon-id-fix-fields.js(2), src/main-process/recon-id-fix-io.js(2), src/main-process/scenario-engines/c4-recon-id-fix.js(2) |
| `PACKAGE_RELATIONSHIP_NAMESPACES` | 3 | 6 | 1 | src/backend/toolbox-format/ooxml-namespaces.js(2), src/backend/toolbox-format/xlsx-pass.js(2), src/main-process/toolbox-output-writer.js(2) |
| `parseFtaDate` | 3 | 6 | 2 | src/main-process/exceljs-writer.js(2), src/main-process/scenario-engines/engine-week-utils.js(2), src/main-process/scenario-engines/r5-payment-offline-allocation-backfill.js(2) |
| `PARSER_ENTRY` | 3 | 6 | 3 | src/main-process/bank-bu-worker/dual-parser-dispatch.js(2), src/main-process/duplicate-inbound-match/paired-parser-dispatch.js(2), src/main-process/pre-fund-reconciliation/mpt-import/managed-import.js(2) |
| `PAYMENT_OFFLINE_FIELD_MAP` | 3 | 6 | 1 | src/constants/payment-offline-allocation-fields.js(4), src/main-process/exceljs-writer.js(1), src/main-process/scenario-engines/r5-payment-offline-allocation-backfill.js(1) |
| `POSITION_READ_ONLY_ACTION_SET` | 3 | 6 | 3 | src/main-process/read-only-exports/position/actions.js(2), src/main-process/read-only-exports/position/policies.js(2), src/main-process/read-only-exports/position/worker-entry.js(2) |
| `postImageFromSide` | 3 | 6 | 2 | src/main-process/bank-bu-worker/main-coordinator.js(2), src/main-process/bank-bu-worker/mirror-repository.js(2), src/main-process/bank-bu-worker/outcome-inspector.js(2) |
| `prepareStoredBankRows` | 3 | 6 | 2 | src/main-process/duplicate-inbound-match/import-model.js(2), src/main-process/duplicate-inbound-match/service.js(2), src/main-process/duplicate-inbound-match/spool-writer.js(2) |
| `prepareToolboxPublication` | 3 | 6 | 1 | src/main-process/statement-worker/publication.js(2), src/main-process/toolbox-output-publication-worker.js(2), src/main-process/toolbox-output-publication.js(2) |
| `previewUnarchive` | 3 | 6 | 1 | src/backend/vcc-financial-op/unarchive.js(3), src/main-process/vcc-financial-op-service.js(2), src/preload.js(1) |
| `publishPreparedToolboxPublication` | 3 | 6 | 1 | src/main-process/statement-worker/publication.js(2), src/main-process/toolbox-output-publication-worker.js(2), src/main-process/toolbox-output-publication.js(2) |
| `readBalanceAdjustments` | 3 | 6 | 1 | src/main-process/statement-generation-business.js(3), src/main-process/statement-generation.js(2), src/main.js(1) |
| `readBankDepositBocCandidates` | 3 | 6 | 1 | src/backend/database.js(2), src/backend/database/linked-table-repository.js(2), src/main-process/linked-derive-rebuild.js(2) |
| `readBankDepositHitMarkers` | 3 | 6 | 1 | src/backend/database.js(2), src/backend/database/linked-table-repository.js(2), src/main-process/fund-recon-worker/artifact-generator.js(2) |
| `readBatchActualCounts` | 3 | 6 | 1 | src/backend/pre-fund-reconciliation-store.js(2), src/main-process/pre-fund-reconciliation/mpt-import/business-evidence.js(2), src/main-process/pre-fund-reconciliation/mpt-import/outcome-inspector.js(2) |
| `readBocFxLinkRows` | 3 | 6 | 2 | src/backend/database.js(2), src/backend/database/linked-table-repository.js(2), src/main-process/recon-id-fix-service/service.js(2) |
| `readBocFxLinkRowsWithIds` | 3 | 6 | 1 | src/backend/database.js(2), src/backend/database/linked-table-repository.js(2), src/main-process/linked-derive-rebuild.js(2) |
| `readMptHeader` | 3 | 6 | 3 | src/main-process/pre-fund-reconciliation/mpt-import/hold-gate.js(2), src/main-process/pre-fund-reconciliation/mpt-import/spool-reader.js(2), src/main-process/pre-fund-reconciliation/mpt-parser.js(2) |
| `readReconFixArtifactEvidence` | 3 | 6 | 3 | src/main-process/recon-id-fix-service/artifact-evidence.js(2), src/main-process/recon-id-fix-service/export-operation.js(2), src/main-process/recon-id-fix-service/service.js(2) |
| `RECON_FIX_POLICIES` | 3 | 6 | 1 | src/main-process/background-execution/runtime.js(2), src/main-process/recon-id-fix-service/policies.js(2), src/main-process/recon-id-fix-service/service.js(2) |
| `reconcileOrphans` | 3 | 6 | 3 | src/main-process/acquiring-bill-currency-run-data.js(2), src/main-process/bank-bu-recon-run-data.js(2), src/main-process/biz-op-recon-run-data.js(2) |
| `recordExportPath` | 3 | 6 | 2 | src/main-process/bank-bu-recon-run-data.js(2), src/main-process/bank-bu-recon-session.js(2), src/main-process/biz-op-recon-run-data.js(2) |
| `recoverPendingToolboxPublications` | 3 | 6 | 1 | src/main-process/toolbox-archive-recovery.js(2), src/main-process/toolbox-output-publication-worker.js(2), src/main-process/toolbox-output-publication.js(2) |
| `registerExternalParserFinalization` | 3 | 6 | 1 | src/main-process/background-execution/external-parser-finalization.js(2), src/main-process/bank-bu-worker/dual-parser-dispatch.js(2), src/main-process/duplicate-inbound-match/paired-parser-shutdown.js(2) |
| `rematchAllBocGroups` | 3 | 6 | 1 | src/main-process/linked-derive-rebuild.js(3), src/main-process/boc-fx-link-builder.js(2), src/main.js(1) |
| `replaceAdmBankDeposit` | 3 | 6 | 1 | src/backend/database.js(2), src/backend/database/linked-table-repository.js(2), src/main-process/linked-derive-rebuild.js(2) |
| `replaceBocBankDeposit` | 3 | 6 | 1 | src/backend/database.js(2), src/backend/database/linked-table-repository.js(2), src/main-process/linked-derive-rebuild.js(2) |
| `resolveArchiveScope` | 3 | 6 | 3 | src/main-process/archive-center/module-scope-registry.js(2), src/main-process/archive-center/operation-tracker.js(2), src/main-process/archive-center/task-policy-registry.js(2) |
| `runMigrations` | 3 | 6 | 3 | src/backend/pending-db.js(2), src/backend/pending-db/migrations.js(2), src/backend/pending-import/worker.js(2) |
| `runReconIdFix` | 3 | 6 | 3 | src/main-process/recon-id-fix-service/service.js(3), src/main-process/recon-id-fix-engine.js(2), src/main.js(1) |
| `runStartupPhase` | 3 | 6 | 3 | src/main-process/archive-center/controller.js(3), src/backend/startup-phase.js(2), src/main.js(1) |
| `stableRowGuardHash` | 3 | 6 | 1 | src/backend/position-reconciliation-import/contracts.js(2), src/backend/position-reconciliation-import/preflight.js(2), src/backend/position-reconciliation-import/source-writer.js(2) |
| `streamDetailRows` | 3 | 6 | 3 | src/backend/vcc-financial-op/detail-importer.js(2), src/backend/vcc-financial-op/workbook-reader.js(2), src/main-process/vcc-financial-op-dataset-writer.js(2) |
| `streamDocumentStatement` | 3 | 6 | 2 | src/main-process/duplicate-inbound-match/document-statement-reader.js(2), src/main-process/duplicate-inbound-match/service.js(2), src/main-process/duplicate-inbound-match/spool-writer.js(2) |
| `subOneDay` | 3 | 6 | 2 | src/backend/biz-op-recon-db/run-repository.js(3), src/main-process/biz-op-recon-session.js(2), src/main-process/biz-op-recon-run-data.js(1) |
| `SUPPORTED_EXTENSIONS` | 3 | 6 | 1 | src/backend/file-service.js(2), src/backend/file-service/common.js(2), src/backend/file-service/readers.js(2) |
| `toSafeMptErrorFields` | 3 | 6 | 2 | src/main-process/pre-fund-reconciliation/mpt-import/file-result-safety.js(2), src/main-process/pre-fund-reconciliation/mpt-import/parser-outcome.js(2), src/main-process/pre-fund-reconciliation/mpt-import/single-writer-session.js(2) |
| `Transform` | 3 | 6 | 3 | src/main-process/archive-center/archive-service.js(2), src/main-process/position-reconciliation/input-staging.js(2), src/main-process/pre-fund-reconciliation/mpt-parser.js(2) |
| `validateBizOpHeaders` | 3 | 6 | 1 | src/backend/biz-op-recon-import/reader-streamed.js(2), src/backend/biz-op-recon-import/reader.js(2), src/backend/biz-op-recon-import/validator.js(2) |
| `validateBizOpRow` | 3 | 6 | 2 | src/backend/biz-op-recon-import/import-worker.js(2), src/backend/biz-op-recon-import/validator.js(2), src/main-process/biz-op-recon-session.js(2) |
| `validateFundTransferDirections` | 3 | 6 | 1 | src/main-process/scenario-engines/fund-transfer-engine-policy.js(2), src/main-process/scenario-engines/r5-fund-transfer-backfill.js(2), src/main-process/scenario-engines/r5-fund-transfer-recon-backfill.js(2) |
| `validateResult` | 3 | 6 | 2 | src/main-process/background-execution/critical/recovery-control-read-repository.js(2), src/main-process/background-execution/critical/recovery-control-repository.js(2), src/main-process/background-execution/recovery-control-contract.js(2) |
| `validateToolboxGenerationResult` | 3 | 6 | 1 | src/main-process/background-execution/runtime.js(2), src/main-process/toolbox-background/generation-contract.js(2), src/main-process/toolbox-background/generation-validator.js(2) |
| `VCC_FINANCIAL_OP_READ_ONLY_ACTION_SET` | 3 | 6 | 2 | src/main-process/read-only-exports/vcc-financial-op/actions.js(2), src/main-process/read-only-exports/vcc-financial-op/policies.js(2), src/main-process/read-only-exports/vcc-financial-op/worker-entry.js(2) |
| `WORKBOOK_RELS_ENTRY_NAME` | 3 | 6 | 1 | src/backend/big-table-import/zip-reader.js(2), src/backend/position-reconciliation-import/xlsx-reader.js(2), src/backend/toolbox-format/xlsx-pass.js(2) |
| `WORKER_RESOURCES` | 3 | 6 | 3 | src/main-process/read-only-exports/biz-op/policies.js(2), src/main-process/read-only-exports/pending/policies.js(2), src/main-process/read-only-exports/pre-fund/policies.js(2) |
| `writeBocFxLinkReconIds` | 3 | 6 | 1 | src/backend/database.js(2), src/backend/database/linked-table-repository.js(2), src/main-process/linked-derive-rebuild.js(2) |
| `writeDatasetWorkbook` | 3 | 6 | 3 | src/backend/vcc-financial-op/worker-entry.js(2), src/main-process/read-only-exports/vcc-financial-op/writer.js(2), src/main-process/vcc-financial-op-dataset-writer.js(2) |
| `writeImportAuditWorkbook` | 3 | 6 | 3 | src/main-process/read-only-exports/vcc-financial-op/writer.js(2), src/main-process/vcc-financial-op-audit-writer.js(2), src/main-process/vcc-financial-op-service.js(2) |
| `writePendingErrorReport` | 3 | 6 | 1 | src/backend/pending-export/error-report-writer.js(2), src/main-process/pending-session.js(2), src/main-process/read-only-exports/pending/writer.js(2) |
| `writePlatformCleanupOutput` | 3 | 6 | 3 | src/main-process/fund-recon-worker/artifact-generator.js(3), src/main-process/platform-cleanup-writer.js(2), src/main.js(1) |
| `writeRefundBackfillOutput` | 3 | 6 | 3 | src/main-process/fund-recon-worker/artifact-generator.js(3), src/main-process/refund-backfill-writer.js(2), src/main.js(1) |
| `writeRunFilteredSourcesWorkbook` | 3 | 6 | 1 | src/main-process/position-reconciliation/filtered-source-report.js(2), src/main-process/position-reconciliation/service.js(2), src/main-process/read-only-exports/position/writer.js(2) |
| `writeScenarioHitRows` | 3 | 6 | 2 | src/main-process/fund-recon-worker/artifact-generator.js(3), src/main-process/scenario-hit-rows-writer.js(2), src/main.js(1) |
| `__test_only_set_worker_script__` | 3 | 5 | 3 | src/main-process/run-check-worker-pool.js(2), src/main-process/toolbox-large-split-dispatch.js(2), src/main-process/run-check-multiworker.js(1) |
| `addRunAdjustment` | 3 | 5 | 1 | src/backend/vcc-financial-op/result-adjustments.js(2), src/main-process/vcc-financial-op-service.js(2), src/preload.js(1) |
| `ALL_BANKS_TEMPLATE_SCOPE` | 3 | 5 | 2 | src/main-process/monthly-balance.js(3), src/main.js(1), src/renderer.js(1) |
| `ALL_TABLE_SIGNATURES` | 3 | 5 | 2 | src/constants/table-signatures.js(2), src/main-process/table-type-detector.js(2), src/main.js(1) |
| `assertStagedInputUnchanged` | 3 | 5 | 1 | src/main-process/position-reconciliation/input-staging.js(2), src/main-process/position-reconciliation/service.js(2), src/main.js(1) |
| `bankCreditAmount` | 3 | 5 | 1 | src/main-process/scenario-engines/r5-payment-offline-allocation-backfill.js(3), src/constants/boc-fx-link-fields.js(1), src/main-process/boc-fx-link-builder.js(1) |
| `bizOpRunOutputIntent` | 3 | 5 | 1 | src/main-process/biz-op-archive-lineage.js(2), src/main-process/biz-op-recon-run-data.js(2), src/main.js(1) |
| `buildAdmRows` | 3 | 5 | 2 | src/main-process/adm-bank-deposit-builder.js(2), src/main-process/linked-derive-rebuild.js(2), src/main.js(1) |
| `buildFundTransferReconRows` | 3 | 5 | 2 | src/main-process/fund-transfer-recon-builder.js(2), src/main-process/linked-derive-rebuild.js(2), src/main.js(1) |
| `buildStaleHitReminder` | 3 | 5 | 1 | src/main-process/fund-recon-worker/artifact-generator.js(2), src/main-process/scenario-engines/r5-refund-order-backfill.js(2), src/main.js(1) |
| `buildVccSubjectAuthority` | 3 | 5 | 1 | src/main-process/vcc-financial-op-output/authority.js(2), src/main-process/vcc-financial-op-output/subject-evidence.js(2), src/main-process/vcc-financial-op-writer.js(1) |
| `compareVccSubjects` | 3 | 5 | 1 | src/main-process/vcc-financial-op-output/authority.js(2), src/main-process/vcc-financial-op-output/subject-evidence.js(2), src/main-process/vcc-financial-op-writer.js(1) |
| `createArchiveRepository` | 3 | 5 | 1 | src/backend/database/archive-repository.js(2), src/main-process/archive-center/archive-service.js(2), src/main.js(1) |
| `createDuplicateInboundMatchService` | 3 | 5 | 2 | src/main-process/duplicate-inbound-match/managed-service.js(2), src/main-process/duplicate-inbound-match/service.js(2), src/main.js(1) |
| `createMptRowAggregateError` | 3 | 5 | 2 | src/main-process/pre-fund-reconciliation/mpt-import/single-writer-session.js(2), src/main-process/pre-fund-reconciliation/mpt-parser.js(2), src/backend/pre-fund-reconciliation-store.js(1) |
| `createStatementGenerationHelpers` | 3 | 5 | 2 | src/main-process/statement-generation-business.js(2), src/main-process/statement-generation.js(2), src/main.js(1) |
| `createValuesByFieldAccumulator` | 3 | 5 | 1 | src/main-process/toolbox-format-operations.js(2), src/main-process/toolbox.js(2), src/main-process/toolbox-stream-io.js(1) |
| `deleteDataset` | 3 | 5 | 1 | src/backend/vcc-financial-op/data-target-deletion.js(2), src/backend/vcc-financial-op/dataset-deletion.js(2), src/preload.js(1) |
| `encodeExcelStXstring` | 3 | 5 | 1 | src/backend/toolbox-format/excel-text.js(2), src/main-process/toolbox-output-writer.js(2), src/main-process/vcc-financial-op-writer.js(1) |
| `exportToolboxMultiFilters` | 3 | 5 | 1 | src/backend/toolbox-xlsx-stream/split-export-filter.js(2), src/main-process/toolbox-format-operations.js(2), src/main.js(1) |
| `freezeDatasetSeedV1` | 3 | 5 | 2 | src/backend/biz-op-recon-db/dataset-head-repository.js(2), src/backend/pre-fund-reconciliation-store.js(2), src/backend/biz-op-recon-import/import-worker.js(1) |
| `freezeFlowDatasetSeedV1` | 3 | 5 | 2 | src/backend/biz-op-recon-db/dataset-head-repository.js(2), src/backend/biz-op-recon-import/contract-flow.js(2), src/backend/biz-op-recon-import/import-worker.js(1) |
| `getEnabledModules` | 3 | 5 | 1 | src/backend/database.js(2), src/backend/database/settings-repository.js(2), src/preload.js(1) |
| `getGatewayBillRawJsonById` | 3 | 5 | 1 | src/backend/database.js(2), src/backend/database/linked-table-repository.js(2), src/main-process/pre-fund-reconciliation/service.js(1) |
| `getImportBatch` | 3 | 5 | 1 | src/backend/vcc-financial-op-db/repository.js(2), src/main-process/vcc-financial-op-service.js(2), src/main-process/vcc-financial-op-archive-lineage.js(1) |
| `getRecoveryAuditByOperation` | 3 | 5 | 1 | src/backend/database/duplicate-inbound-match-run-repository.js(2), src/main-process/duplicate-inbound-match/startup-recovery.js(2), src/backend/database.js(1) |
| `getRule` | 3 | 5 | 1 | src/backend/pending-db/rule-repository.js(2), src/renderer-pending.js(2), src/preload.js(1) |
| `getUiStyle` | 3 | 5 | 1 | src/backend/database.js(2), src/backend/database/settings-repository.js(2), src/preload.js(1) |
| `iterateGatewayBillRows` | 3 | 5 | 1 | src/backend/database.js(2), src/backend/database/linked-table-repository.js(2), src/main-process/pre-fund-reconciliation/service.js(1) |
| `lettersToIndex` | 3 | 5 | 2 | src/backend/biz-op-recon-import/reader-streamed.js(2), src/backend/vcc-op-calc-import/reader.js(2), src/backend/pending-import/streaming-xlsx-reader.js(1) |
| `listDeleteTargets` | 3 | 5 | 1 | src/backend/vcc-financial-op/data-target-deletion.js(2), src/main-process/vcc-financial-op-service.js(2), src/preload.js(1) |
| `listImportMonths` | 3 | 5 | 1 | src/backend/vcc-financial-op-db/repository.js(2), src/main-process/vcc-financial-op-service.js(2), src/preload.js(1) |
| `listImportSources` | 3 | 5 | 1 | src/backend/vcc-financial-op-db/repository.js(2), src/backend/vcc-financial-op/import-service.js(2), src/backend/vcc-financial-op/detail-importer.js(1) |
| `listReadyDates` | 3 | 5 | 1 | src/backend/biz-op-recon-db/run-repository.js(2), src/main-process/biz-op-recon-run-data.js(2), src/preload.js(1) |
| `listScenarios` | 3 | 5 | 1 | src/backend/database.js(2), src/backend/database/scenarios-repository.js(2), src/main-process/fund-recon-worker/evidence-provider.js(1) |
| `loadResultTemplateContract` | 3 | 5 | 1 | src/backend/vcc-financial-op/result-template-contract.js(2), src/main-process/vcc-financial-op-output/artifact-evidence.js(2), src/main-process/vcc-financial-op-writer.js(1) |
| `mergeBankStatementRows` | 3 | 5 | 2 | src/main-process/bank-statement-merge.js(2), src/main-process/fund-recon-worker/service.js(2), src/main.js(1) |
| `mergeToolboxFilesToXlsx` | 3 | 5 | 2 | src/main-process/toolbox-background/generation-core.js(2), src/main-process/toolbox-merge-io.js(2), src/main.js(1) |
| `pickStaleHits` | 3 | 5 | 1 | src/main-process/fund-recon-worker/artifact-generator.js(2), src/main-process/scenario-engines/r5-refund-order-backfill.js(2), src/main.js(1) |
| `PRE_FUND_MPT_POLICIES` | 3 | 5 | 1 | src/main-process/background-execution/runtime.js(2), src/main-process/pre-fund-reconciliation/mpt-import/policies.js(2), src/main.js(1) |
| `readBankDepositAdmCandidates` | 3 | 5 | 1 | src/backend/database.js(2), src/backend/database/linked-table-repository.js(2), src/main-process/linked-derive-rebuild.js(1) |
| `readBizOpFile` | 3 | 5 | 1 | src/backend/biz-op-recon-import/reader.js(2), src/main-process/biz-op-recon-session.js(2), src/main.js(1) |
| `readBocFxLinkRowsForRematch` | 3 | 5 | 1 | src/backend/database.js(2), src/backend/database/linked-table-repository.js(2), src/main-process/linked-derive-rebuild.js(1) |
| `readFlowFile` | 3 | 5 | 1 | src/backend/biz-op-recon-import/reader.js(2), src/main-process/biz-op-recon-session.js(2), src/main.js(1) |
| `readFundTransferReconRows` | 3 | 5 | 1 | src/backend/database.js(2), src/backend/database/linked-table-repository.js(2), src/main-process/fund-recon-worker/evidence-provider.js(1) |
| `readGatewayBillRowPoolsByChannels` | 3 | 5 | 1 | src/backend/database.js(2), src/backend/database/linked-table-repository.js(2), src/main-process/fund-recon-worker/evidence-provider.js(1) |
| `recoverToolboxPublicationsIntoArchive` | 3 | 5 | 1 | src/main-process/toolbox-archive-recovery.js(2), src/main-process/vcc-financial-op-output-recovery.js(2), src/main.js(1) |
| `recoverVccStorageMigration` | 3 | 5 | 1 | src/main-process/vcc-financial-op-storage-migration.js(2), src/main-process/vcc-financial-op-storage-rebuild.js(2), src/main.js(1) |
| `replaceFundTransferReconRows` | 3 | 5 | 1 | src/backend/database.js(2), src/backend/database/linked-table-repository.js(2), src/main-process/linked-derive-rebuild.js(1) |
| `resolveFundTransferDatePolicy` | 3 | 5 | 2 | src/main-process/fund-recon-worker/evidence-provider.js(2), src/main-process/fund-transfer-date-policy.js(2), src/main.js(1) |
| `runAllScenarios` | 3 | 5 | 3 | src/main-process/reconciliation-orchestrator.js(2), src/main-process/scenario-dispatcher.js(2), src/main.js(1) |
| `scanToolboxSplitFields` | 3 | 5 | 1 | src/backend/toolbox-xlsx-stream/split-scan-fields.js(2), src/main-process/toolbox-format-operations.js(2), src/main.js(1) |
| `setEnabledModules` | 3 | 5 | 1 | src/backend/database.js(2), src/backend/database/settings-repository.js(2), src/preload.js(1) |
| `setReconIdFixBillCategory` | 3 | 5 | 1 | src/backend/database.js(2), src/backend/database/settings-repository.js(2), src/preload.js(1) |
| `unarchiveMonth` | 3 | 5 | 1 | src/backend/vcc-financial-op/unarchive.js(2), src/main-process/vcc-financial-op-service.js(2), src/preload.js(1) |
| `writeAggregateDiffWorkbook` | 3 | 5 | 1 | src/main-process/bank-bu-recon-writer.js(2), src/main-process/bank-bu-worker/export-operation.js(2), src/main.js(1) |
| `writeBocFxLinkGroupRematch` | 3 | 5 | 1 | src/backend/database.js(2), src/backend/database/linked-table-repository.js(2), src/main-process/linked-derive-rebuild.js(1) |
| `writeDateRangeDiffWorkbook` | 3 | 5 | 1 | src/main-process/biz-op-recon-writer.js(2), src/main-process/read-only-exports/biz-op/writer.js(2), src/main.js(1) |
| `writeSingleDateDiffWorkbook` | 3 | 5 | 1 | src/main-process/biz-op-recon-writer.js(2), src/main-process/read-only-exports/biz-op/writer.js(2), src/main.js(1) |
| `actionTaskBindingRegistry` | 3 | 4 | 1 | src/main-process/background-execution/action-task-binding-registry.js(2), src/main-process/background-execution/task-lifecycle-adapter.js(1), src/main.js(1) |
| `assertExpectedHead` | 3 | 4 | 1 | src/backend/biz-op-recon-db/dataset-head-repository.js(2), src/backend/biz-op-recon-import/import-worker.js(1), src/main-process/biz-op-recon-session.js(1) |
| `assertNoPending` | 3 | 4 | 1 | src/backend/biz-op-recon-db/month-end-copy-intent-repository.js(2), src/main-process/biz-op-recon-run-data.js(1), src/main-process/biz-op-recon-session.js(1) |
| `clearByDate` | 3 | 4 | 1 | src/backend/biz-op-recon-db/flow-imports-repository.js(2), src/backend/biz-op-recon-import/import-worker.js(1), src/main-process/biz-op-recon-session.js(1) |
| `clearRunsAndDiffsByDate` | 3 | 4 | 1 | src/backend/biz-op-recon-db/run-repository.js(2), src/backend/biz-op-recon-import/import-worker.js(1), src/main-process/biz-op-recon-session.js(1) |
| `countRowsInMonth` | 3 | 4 | 1 | src/backend/pending-db/month-repository.js(2), src/main-process/pending-import-preflight.js(1), src/main-process/pending-session.js(1) |
| `createImportBatch` | 3 | 4 | 1 | src/backend/vcc-financial-op-db/repository.js(2), src/backend/vcc-financial-op/detail-importer.js(1), src/backend/vcc-financial-op/import-service.js(1) |
| `createLegacyRun` | 3 | 4 | 1 | src/backend/pending-db/diff-repository.js(2), src/backend/pending-reconcile/engine.js(1), src/backend/pre-fund-reconciliation-run-store.js(1) |
| `deleteDataTarget` | 3 | 4 | 1 | src/backend/vcc-financial-op/data-target-deletion.js(2), src/main-process/vcc-financial-op-service.js(1), src/preload.js(1) |
| `findByNameAndLocation` | 3 | 4 | 1 | src/backend/database/channels-repository.js(2), src/backend/database.js(1), src/main-process/scenario-dispatcher.js(1) |
| `finishImportBatch` | 3 | 4 | 1 | src/backend/vcc-financial-op-db/repository.js(2), src/backend/vcc-financial-op/detail-importer.js(1), src/backend/vcc-financial-op/import-service.js(1) |
| `getApplicableChannelIds` | 3 | 4 | 1 | src/backend/database/scenarios-repository.js(2), src/backend/database.js(1), src/main-process/fund-recon-worker/evidence-provider.js(1) |
| `getBuiltinGeneral` | 3 | 4 | 1 | src/backend/database/channels-repository.js(2), src/backend/database.js(1), src/main-process/scenario-dispatcher.js(1) |
| `importMonthAtomic` | 3 | 4 | 1 | src/backend/bank-bu-recon-db/month-repository.js(2), src/main-process/bank-bu-recon-run-data.js(1), src/main-process/bank-bu-recon-session.js(1) |
| `isEmptyValue` | 3 | 4 | 1 | src/main-process/scenario-engines/engine-utils.js(2), src/main-process/scenario-engines/c1-extract-recon-id.js(1), src/main-process/scenario-engines/c3-gateway-recon-join.js(1) |
| `iterateChannelExports` | 3 | 4 | 1 | src/main-process/pre-fund-reconciliation/output-mapper.js(2), src/backend/pre-fund-reconciliation-run-store.js(1), src/main-process/pre-fund-reconciliation/service.js(1) |
| `iterateExportableImportAnomalies` | 3 | 4 | 1 | src/backend/vcc-financial-op-db/repository.js(2), src/main-process/read-only-exports/vcc-financial-op/query.js(1), src/main-process/vcc-financial-op-audit-writer.js(1) |
| `listByMonth` | 3 | 4 | 1 | src/backend/pending-db/removed-repository.js(2), src/backend/pending-export/writer.js(1), src/backend/pending-reconcile/removal-match.js(1) |
| `listLatestRunsByMonthPair` | 3 | 4 | 1 | src/backend/pending-db/diff-repository.js(2), src/backend/pending-export/writer.js(1), src/main-process/pending-archive-lineage.js(1) |
| `listSuccessDates` | 3 | 4 | 1 | src/backend/biz-op-recon-db/run-repository.js(2), src/main-process/biz-op-recon-run-data.js(1), src/preload.js(1) |
| `normalizeNewAccountAccounts` | 3 | 4 | 1 | src/main-process/new-account/generation-validator.js(2), src/main-process/new-account/generation-core.js(1), src/main.js(1) |
| `openWorkbook` | 3 | 4 | 1 | src/backend/position-reconciliation-import/xls-reader.js(2), src/backend/big-table-import/engine.js(1), src/backend/big-table-import/import-worker.js(1) |
| `readGatewayRecon` | 3 | 4 | 1 | src/main-process/fund-recon-worker/source-readers.js(2), src/main-process/bank-statement-io.js(1), src/main.js(1) |
| `readReconIdFixFile` | 3 | 4 | 1 | src/main-process/recon-id-fix-service/service.js(2), src/main-process/recon-id-fix-io.js(1), src/main.js(1) |
| `readXlsxSheetMetaLite` | 3 | 4 | 2 | src/main-process/toolbox-stream-io.js(2), src/backend/file-service/readers.js(1), src/main-process/table-type-detector.js(1) |
| `runBizOpImportViaWorker` | 3 | 4 | 1 | src/main-process/biz-op-recon-run-data.js(2), src/main-process/biz-op-recon-session.js(1), src/main.js(1) |
| `runFlowImportViaWorker` | 3 | 4 | 1 | src/main-process/biz-op-recon-run-data.js(2), src/main-process/biz-op-recon-session.js(1), src/main.js(1) |
| `sanitizeBankName` | 3 | 4 | 3 | src/backend/database/own-accounts-migration.js(2), src/backend/balance-adjustment-store.js(1), src/backend/own-account-store.js(1) |
| `validateNewAccountAccounts` | 3 | 4 | 1 | src/main-process/new-account/generation-validator.js(2), src/main-process/new-account/generation-core.js(1), src/main.js(1) |
| `buildTimestampMinute` | 3 | 3 | 2 | src/main-process/bank-statement-io.js(1), src/main-process/recon-id-fix-io.js(1), src/main.js(1) |
| `adapterError` | 2 | 70 | 2 | src/main-process/background-execution/adapters/position-import-adapter.js(38), src/main-process/background-execution/adapters/acquiring-adapter.js(32) |
| `VccStorageMigrationError` | 2 | 66 | 1 | src/main-process/vcc-financial-op-storage-rebuild.js(64), src/main-process/vcc-financial-op-storage-migration.js(2) |
| `exportError` | 2 | 61 | 2 | src/main-process/recon-id-fix-service/export-operation.js(31), src/main-process/vcc-financial-op-dataset-writer.js(30) |
| `ResourceGovernorError` | 2 | 49 | 1 | src/main-process/background-execution/resource-governor.js(36), src/main-process/background-execution/resource-lease.js(13) |
| `addReason` | 2 | 42 | 2 | src/backend/vcc-financial-op/archive-contract.js(25), src/main-process/scenario-engines/r4-fund-nature-check.js(17) |
| `safeHash` | 2 | 41 | 2 | src/main-process/recon-id-fix-service/policies.js(33), src/main-process/vcc-financial-op-output/policies.js(8) |
| `normalizeKey` | 2 | 38 | 2 | src/backend/database/linked-table-repository.js(33), src/main-process/bank-bu-recon-session.js(5) |
| `ServiceHostProtocolError` | 2 | 37 | 1 | src/main-process/background-execution/service-host.js(34), src/main-process/background-execution/supervisor.js(3) |
| `templateRepository` | 2 | 33 | 2 | src/backend/database.js(30), src/backend/database/own-accounts-migration.js(3) |
| `countValue` | 2 | 31 | 1 | src/backend/vcc-financial-op/dataset-deletion.js(27), src/main-process/toolbox-output-writer.js(4) |
| `contractError` | 2 | 30 | 2 | src/main-process/toolbox-background/generation-contract.js(22), src/main-process/read-only-exports/common/contract.js(8) |
| `rowValue` | 2 | 29 | 1 | src/backend/vcc-financial-op/row-mapper.js(25), src/main-process/pre-fund-reconciliation/matching-engine.js(4) |
| `tablePolicy` | 2 | 29 | 1 | src/backend/vcc-financial-op/mutation-policy.js(24), src/backend/vcc-financial-op/mutation-guard.js(5) |
| `normalizedSource` | 2 | 28 | 1 | src/main-process/duplicate-inbound-match/startup-recovery.js(26), src/main-process/recon-id-fix-service/jpm-writeback-plan.js(2) |
| `routeError` | 2 | 28 | 2 | src/main-process/toolbox-background/route-db-contract.js(20), src/main-process/toolbox-background/route-db-sealer.js(8) |
| `resumeError` | 2 | 27 | 1 | src/main-process/acquiring-bill-currency-run-data.js(25), src/main-process/app-updater.js(2) |
| `pendingRequests` | 2 | 26 | 1 | src/main-process/background-execution/service-host.js(15), src/main-process/recon-id-fix-service/worker-entry.js(11) |
| `ContractValidationError` | 2 | 25 | 2 | src/backend/big-table-import/contract.js(22), src/backend/big-table-import/engine.js(3) |
| `optionalText` | 2 | 25 | 2 | src/backend/database/archive-repository.js(23), src/main-process/pre-fund-reconciliation/mpt-import/operation-receipt-repository.js(2) |
| `StartupRecoveryError` | 2 | 24 | 1 | src/main-process/background-execution/startup-recovery-coordinator.js(22), src/main-process/background-execution/index.js(2) |
| `HIT_TYPES` | 2 | 23 | 1 | src/main-process/position-reconciliation/matching-engine.js(21), src/main-process/position-reconciliation/contracts.js(2) |
| `NEW_ACCOUNT_GENERATION_SHAPE_LIMITS` | 2 | 22 | 1 | src/main-process/new-account/resource-estimator.js(12), src/main-process/new-account/generation-contract.js(10) |
| `publicArtifact` | 2 | 22 | 1 | src/main-process/archive-center/archive-service.js(20), src/main-process/archive-center/controller.js(2) |
| `scenariosRepository` | 2 | 22 | 2 | src/backend/database.js(15), src/main-process/fund-recon-worker/evidence-provider.js(7) |
| `ownerRow` | 2 | 21 | 1 | src/main-process/position-reconciliation/store.js(15), src/main-process/background-execution/critical/recovery-request-owner-repository.js(6) |
| `isObjectRecord` | 2 | 20 | 2 | src/main-process/duplicate-inbound-match/matching-engine.js(16), src/main-process/fund-transfer-date-policy.js(4) |
| `refreshBankStatementStatus` | 2 | 20 | 1 | src/renderer.js(11), src/renderer-dialogs.js(9) |
| `bankRowKey` | 2 | 19 | 1 | src/main-process/duplicate-inbound-match/matching-engine.js(18), src/main-process/duplicate-inbound-match/service.js(1) |
| `deepClone` | 2 | 19 | 2 | src/backend/vcc-financial-op/result-template-contract.js(14), src/main-process/background-execution/execution-policy-registry.js(5) |
| `fatalError` | 2 | 19 | 1 | src/main-process/pre-fund-reconciliation/mpt-import/ordered-coordinator.js(13), src/main-process/position-reconciliation/import-dispatch.js(6) |
| `safeName` | 2 | 19 | 1 | src/main-process/archive-center/archive-service.js(13), src/backend/database/channels-repository.js(6) |
| `TEMPLATE_LABEL` | 2 | 19 | 2 | src/backend/vcc-op-calc-import/reader.js(11), src/backend/pending-import/removed-reader.js(8) |
| `VCC_STORAGE_CONTRACT_VERSION` | 2 | 19 | 1 | src/backend/vcc-financial-op-db/storage-contract.js(10), src/main-process/vcc-financial-op-storage-rebuild.js(9) |
| `BANK_FUND_TYPE_FIELD` | 2 | 18 | 2 | src/main-process/scenario-engines/dbs-charge-fund-check.js(13), src/main-process/scenario-engines/r4-fund-nature-check.js(5) |
| `nonNegativeInteger` | 2 | 18 | 2 | src/main-process/statement-worker/contracts.js(15), src/main-process/read-only-exports/vcc-financial-op/actions.js(3) |
| `SafeErrorValidationError` | 2 | 18 | 1 | src/main-process/background-execution/error-codec.js(15), src/main-process/background-execution/protocol-validator.js(3) |
| `canary` | 2 | 17 | 2 | src/main-process/background-execution/canary/packaged-runtime-runner.js(15), src/main-process/background-execution/index.js(2) |
| `DIFF_TABLE` | 2 | 17 | 2 | src/backend/acquiring-bill-currency-db/run-repository.js(11), src/backend/biz-op-recon-db/run-repository.js(6) |
| `exactObject` | 2 | 17 | 2 | src/main-process/background-execution/critical/recovery-request-owner-repository.js(11), src/main-process/new-account/artifact-copy.js(6) |
| `PipelineError` | 2 | 17 | 2 | src/backend/big-table-import/pipeline.js(9), src/backend/big-table-import/engine.js(8) |
| `selectedValues` | 2 | 17 | 1 | src/renderer-dialogs.js(15), src/main-process/vcc-financial-op-dataset-writer.js(2) |
| `taskPolicyRegistry` | 2 | 17 | 1 | src/main-process/background-execution/action-task-binding-registry.js(14), src/main.js(3) |
| `TOOLBOX_PROJECTION_PROFILES` | 2 | 17 | 1 | src/main-process/toolbox-format-io.js(10), src/backend/toolbox-format/model.js(7) |
| `updateJournal` | 2 | 17 | 1 | src/main-process/vcc-financial-op-storage-rebuild.js(12), src/main-process/vcc-financial-op-storage-migration.js(5) |
| `admissionError` | 2 | 16 | 2 | src/main-process/recon-id-fix-service/evidence-settlement-admission.js(9), src/main-process/pre-fund-reconciliation/mpt-import/spool-admission.js(7) |
| `canonicalStoredAmount` | 2 | 16 | 2 | src/backend/vcc-financial-op/result-adjustments.js(8), src/backend/vcc-financial-op/result-evidence.js(8) |
| `ImportValidationError` | 2 | 16 | 1 | src/backend/acquiring-bill-currency-import/reader.js(15), src/backend/acquiring-bill-currency-import/reader-handrolled.js(1) |
| `REMOVED_PENDING_COLUMNS` | 2 | 16 | 2 | src/backend/pending-import/removed-reader.js(13), src/backend/pending-export/writer.js(3) |
| `storageContractVersion` | 2 | 16 | 1 | src/main-process/vcc-financial-op-storage-rebuild.js(10), src/backend/vcc-financial-op-db/migrations.js(6) |
| `ACTION_TASK_BINDING_CONTRACT` | 2 | 15 | 1 | src/main-process/background-execution/action-task-binding-registry.js(13), src/main-process/background-execution/index.js(2) |
| `lastPendingBigAccountSelection` | 2 | 15 | 1 | src/main-process/statement-worker/probe-state-builder.js(14), src/main.js(1) |
| `reloadReconIdFixScenarios` | 2 | 15 | 1 | src/renderer-dialogs.js(11), src/renderer.js(4) |
| `transaction` | 2 | 15 | 1 | src/backend/pre-fund-reconciliation-store.js(13), src/main-process/position-reconciliation/common.js(2) |
| `BOC_FX_TABLE` | 2 | 14 | 2 | src/backend/database/linked-table-repository.js(12), src/main-process/recon-id-fix-service/service.js(2) |
| `coordinateKey` | 2 | 14 | 2 | src/backend/vcc-financial-op/result-adjustments.js(8), src/backend/vcc-financial-op/result-evidence.js(6) |
| `jsonSnapshot` | 2 | 14 | 2 | src/main-process/statement-worker/probe-state-builder.js(11), src/main-process/background-execution/action-manifest.js(3) |
| `parsedJson` | 2 | 14 | 1 | src/backend/position-reconciliation-import/ledger.js(8), src/backend/scenarios-bundle-io.js(6) |
| `requirePositionPendingArchiveFiles` | 2 | 14 | 1 | src/main-process/position-reconciliation/operation-lifecycle.js(13), src/main.js(1) |
| `sanitizeAmountValue` | 2 | 14 | 1 | src/backend/file-service.js(11), src/backend/file-service/normalizers.js(3) |
| `toCents` | 2 | 14 | 2 | src/main-process/scenario-engines/c4-recon-id-fix.js(8), src/main-process/boc-fx-link-builder.js(6) |
| `AUDIT_FIELDS` | 2 | 13 | 1 | src/main-process/position-reconciliation/matching-engine.js(11), src/main-process/position-reconciliation/contracts.js(2) |
| `dateIso` | 2 | 13 | 1 | src/backend/database/linked-table-repository.js(9), src/main-process/toolbox-output-publication.js(4) |
| `ERROR_CODE` | 2 | 13 | 2 | src/backend/vcc-op-calc-import/reader.js(7), src/backend/pending-import/removed-reader.js(6) |
| `HASH` | 2 | 13 | 2 | src/main-process/recon-id-fix-service/jpm-outcome-inspector.js(8), src/main-process/recon-id-fix-service/jpm-receipt-evidence.js(5) |
| `normalizeAccountKey` | 2 | 13 | 2 | src/main-process/biz-op-recon-session.js(10), src/main-process/biz-op-recon-writer.js(3) |
| `normalizeLocalDate` | 2 | 13 | 1 | src/backend/database/archive-repository.js(11), src/main-process/archive-center/archive-service.js(2) |
| `refreshTemplates` | 2 | 13 | 1 | src/renderer.js(7), src/renderer-dialogs.js(6) |
| `REQUIRED_DATASET_TYPES` | 2 | 13 | 2 | src/backend/vcc-financial-op/calculator.js(7), src/backend/vcc-financial-op/unarchive.js(6) |
| `usesModernSourceIdentity` | 2 | 13 | 1 | src/main-process/position-reconciliation/store.js(12), src/main-process/position-reconciliation/service.js(1) |
| `xmlAttribute` | 2 | 13 | 2 | src/main-process/statement-worker/artifact-descriptor.js(8), src/main-process/recon-id-fix-service/artifact-evidence.js(5) |
| `zipReader` | 2 | 13 | 2 | src/backend/big-table-import/engine.js(10), src/backend/big-table-import/import-worker.js(3) |
| `cleanupStagingPaths` | 2 | 12 | 1 | src/main-process/position-reconciliation/service.js(10), src/main-process/position-reconciliation/input-staging.js(2) |
| `GATEWAY_SOURCE` | 2 | 12 | 1 | src/main-process/pre-fund-reconciliation/matching-engine.js(7), src/main-process/pre-fund-reconciliation/service.js(5) |
| `getCurrencyOptionEntries` | 2 | 12 | 1 | src/renderer.js(7), src/renderer-dialogs.js(5) |
| `lastPendingBalanceSeedConfirmation` | 2 | 12 | 1 | src/main-process/statement-worker/probe-state-builder.js(11), src/main.js(1) |
| `OBJECT_OVERHEAD_BYTES` | 2 | 12 | 2 | src/main-process/fund-recon-worker/state-footprint.js(7), src/main-process/statement-worker/state-footprint.js(5) |
| `OPERATION_TOKEN_VERSION` | 2 | 12 | 2 | src/backend/vcc-financial-op/operation-token-v2.js(8), src/backend/vcc-financial-op/operation-state.js(4) |
| `removalMatch` | 2 | 12 | 1 | src/renderer-pending.js(8), src/backend/pending-export/writer.js(4) |
| `sameJobRef` | 2 | 12 | 1 | src/main-process/statement-worker/service.js(9), src/main-process/duplicate-inbound-match/worker-host.js(3) |
| `sheetToObjects` | 2 | 12 | 2 | src/main-process/recon-id-fix-io.js(9), src/main-process/bank-statement-io.js(3) |
| `ZERO` | 2 | 12 | 2 | src/main-process/duplicate-inbound-match/policies.js(7), src/main-process/bank-bu-worker/policies.js(5) |
| `BANK_EXTRA_FEE_FIELD` | 2 | 11 | 2 | src/main-process/scenario-engines/r5-fund-transfer-backfill.js(6), src/main-process/scenario-engines/r4-fund-nature-check.js(5) |
| `BIZ_OP_ACCOUNT_KEY_DB_COLUMN` | 2 | 11 | 1 | src/main-process/biz-op-recon-session.js(9), src/backend/biz-op-recon-db/columns.js(2) |
| `canonicalFilePlan` | 2 | 11 | 1 | src/main-process/recon-id-fix-service/export-operation.js(7), src/main-process/vcc-financial-op-output/dispatch.js(4) |
| `checkCancelled` | 2 | 11 | 2 | src/main-process/duplicate-inbound-match/spool-writer.js(6), src/main-process/bank-bu-worker/spool-writer.js(5) |
| `estimateValueBytes` | 2 | 11 | 1 | src/main-process/fund-recon-worker/state-footprint.js(9), src/main-process/duplicate-inbound-match/state-footprint.js(2) |
| `GatewayRowValidationError` | 2 | 11 | 1 | src/main-process/pre-fund-reconciliation/matching-engine.js(9), src/main-process/pre-fund-reconciliation/service.js(2) |
| `MANUAL_BALANCE_ACTION_KEY` | 2 | 11 | 1 | src/main-process/manual-balance-seed-settlement.js(10), src/main.js(1) |
| `normalizeBorderSide` | 2 | 11 | 2 | src/backend/toolbox-format/biff8-overlay.js(6), src/backend/toolbox-format/style-registry.js(5) |
| `PRIORITIES` | 2 | 11 | 1 | src/main-process/background-execution/admission-queue.js(9), src/main-process/background-execution/resource-governor.js(2) |
| `publicBatch` | 2 | 11 | 1 | src/main-process/archive-center/archive-service.js(9), src/main-process/archive-center/controller.js(2) |
| `realDirectory` | 2 | 11 | 2 | src/main-process/duplicate-inbound-match/spool-filesystem.js(6), src/main-process/bank-bu-worker/spool-filesystem.js(5) |
| `rendererPending` | 2 | 11 | 1 | src/renderer-previews.js(9), src/renderer.js(2) |
| `safeAdd` | 2 | 11 | 2 | src/main-process/vcc-op-calc/ordered-reducer.js(6), src/main-process/vcc-op-calc/parser-core.js(5) |
| `sourceStat` | 2 | 11 | 2 | src/main-process/position-reconciliation/input-staging.js(8), src/main-process/new-account/artifact-copy.js(3) |
| `TOOLBOX_XLSX_METADATA_LIMITS` | 2 | 11 | 1 | src/backend/toolbox-format/xlsx-pass.js(6), src/backend/position-reconciliation-import/xlsx-reader.js(5) |
| `assertSourcesFresh` | 2 | 10 | 2 | src/main-process/toolbox-background/generation-core.js(6), src/main-process/toolbox-background/route-db-sealer.js(4) |
| `datasetLineageIntent` | 2 | 10 | 2 | src/main-process/biz-op-archive-lineage.js(5), src/main-process/pending-archive-lineage.js(5) |
| `DIFFERENCE_STATUSES` | 2 | 10 | 1 | src/main-process/position-reconciliation/store.js(8), src/main-process/position-reconciliation/constants.js(2) |
| `electronUtilityProcess` | 2 | 10 | 2 | src/main-process/pending-session.js(6), src/main-process/biz-op-recon-session.js(4) |
| `errorResult` | 2 | 10 | 2 | src/main-process/pre-fund-reconciliation/mpt-import/single-writer-session.js(7), src/main-process/pre-fund-reconciliation/service.js(3) |
| `FUND_TYPES` | 2 | 10 | 1 | src/main-process/duplicate-inbound-match/matching-engine.js(6), src/main-process/duplicate-inbound-match/service.js(4) |
| `getTemplate` | 2 | 10 | 1 | src/backend/database/template-repository.js(8), src/backend/database.js(2) |
| `lastFileImportContext` | 2 | 10 | 1 | src/main-process/statement-worker/probe-state-builder.js(9), src/main.js(1) |
| `NODE_MAX_OLD_SPACE_MB` | 2 | 10 | 2 | src/main-process/pending-session.js(6), src/main-process/biz-op-recon-session.js(4) |
| `normalizeRgb` | 2 | 10 | 1 | src/backend/toolbox-format/biff8-colors.js(8), src/backend/toolbox-format/biff8-overlay.js(2) |
| `ownDataValue` | 2 | 10 | 2 | src/main-process/background-execution/adapters/worker-thread-adapter.js(7), src/main-process/background-execution/execution-policy-registry.js(3) |
| `REPORT_CHECK_KEYS` | 2 | 10 | 1 | src/main-process/background-execution/canary/packaged-runtime-request.js(6), src/main-process/background-execution/canary/packaged-runtime-runner.js(4) |
| `runArchiveRootOperation` | 2 | 10 | 1 | src/main-process/archive-center/archive-service.js(6), src/main-process/archive-center/storage-root-manager.js(4) |
| `SOURCE_TARGET_TYPES` | 2 | 10 | 1 | src/backend/vcc-financial-op/destructive-write.js(5), src/backend/vcc-financial-op/read-snapshot.js(5) |
| `statIdentity` | 2 | 10 | 2 | src/backend/vcc-financial-op/result-template-contract.js(5), src/main-process/vcc-financial-op-output/staging-identity.js(5) |
| `workerDbPath` | 2 | 10 | 1 | src/main-process/run-check-worker-pool.js(7), src/main-process/run-check-worker.js(3) |
| `ARCHIVE_STORAGE_ROOT_SETTING_KEY` | 2 | 9 | 1 | src/main-process/archive-center/storage-root-manager.js(5), src/backend/database/archive-repository.js(4) |
| `canonicalJsonValue` | 2 | 9 | 2 | src/backend/vcc-financial-op/operation-token-v2.js(5), src/backend/vcc-financial-op/operation-state.js(4) |
| `cloneStyle` | 2 | 9 | 2 | src/main-process/duplicate-inbound-match/excel-writer.js(7), src/main-process/vcc-financial-op-writer.js(2) |
| `DEFER_ADMISSION` | 2 | 9 | 1 | src/main-process/background-execution/resource-governor.js(6), src/main-process/background-execution/admission-queue.js(3) |
| `getAvailableDiskBytes` | 2 | 9 | 1 | src/main-process/pre-fund-reconciliation/mpt-import/managed-import.js(5), src/main-process/pre-fund-reconciliation/mpt-import/spool-admission.js(4) |
| `iterateOutputRows` | 2 | 9 | 1 | src/main-process/read-only-exports/pre-fund/query.js(5), src/backend/pre-fund-reconciliation-run-store.js(4) |
| `monthEndCopyIntents` | 2 | 9 | 2 | src/main-process/biz-op-recon-run-data.js(6), src/main-process/biz-op-recon-session.js(3) |
| `monthRepo` | 2 | 9 | 2 | src/backend/pending-import/worker.js(5), src/main-process/pending-session.js(4) |
| `normalizeBizIdKey` | 2 | 9 | 1 | src/main-process/scenario-engines/r5-refund-order-backfill.js(6), src/main-process/fund-recon-worker/artifact-generator.js(3) |
| `normalizeIncomingVccCurrency` | 2 | 9 | 1 | src/backend/vcc-financial-op/row-mapper.js(6), src/backend/vcc-financial-op/system-op-importer.js(3) |
| `normalizeStaticStyle` | 2 | 9 | 2 | src/backend/toolbox-format/style-registry.js(7), src/main-process/toolbox-background/route-db-contract.js(2) |
| `nowIso` | 2 | 9 | 1 | src/main-process/acquiring-bill-currency-session.js(6), src/main-process/background-execution/adapters/acquiring-adapter.js(3) |
| `pkg` | 2 | 9 | 2 | src/main-process/acquiring-bill-currency-writer.js(7), src/main.js(2) |
| `readJournal` | 2 | 9 | 2 | src/main-process/toolbox-output-publication.js(6), src/main-process/vcc-financial-op-storage-rebuild.js(3) |
| `readRunProgressBatchContext` | 2 | 9 | 1 | src/main-process/acquiring-bill-currency-run-data.js(6), src/backend/acquiring-bill-currency-db/run-repository.js(3) |
| `resolveIndexedColor` | 2 | 9 | 1 | src/backend/toolbox-format/biff8-overlay.js(5), src/backend/toolbox-format/biff8-colors.js(4) |
| `RESULT_TEMPLATE_HEADERS` | 2 | 9 | 1 | src/backend/vcc-financial-op/result-template-contract.js(8), src/main-process/vcc-financial-op-writer.js(1) |
| `ROUTE_DB_CODEC_VERSION` | 2 | 9 | 1 | src/main-process/toolbox-background/route-db-contract.js(6), src/main-process/toolbox-background/route-db-sealer.js(3) |
| `SHEET_ENTRY_NAME` | 2 | 9 | 1 | src/backend/acquiring-bill-currency-import/reader.js(6), src/backend/acquiring-bill-currency-import/reader-handrolled.js(3) |
| `SOURCE_TYPE_OUTBOUND` | 2 | 9 | 1 | src/main-process/pre-fund-reconciliation/mpt-schema.js(6), src/main-process/pre-fund-reconciliation/mpt-error-report-writer.js(3) |
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
| `assertUniqueSplitHeaders` | 2 | 8 | 2 | src/main-process/toolbox-format-operations.js(6), src/main-process/toolbox-background/route-db-sealer.js(2) |
| `atomicWriteJson` | 2 | 8 | 2 | src/main-process/archive-center/storage-root-manager.js(5), src/main-process/toolbox-output-publication.js(3) |
| `BANK_TABLE` | 2 | 8 | 1 | src/backend/bank-bu-recon-db/month-repository.js(7), src/main-process/bank-bu-worker/side-database.js(1) |
| `BankRowValidationError` | 2 | 8 | 1 | src/main-process/pre-fund-reconciliation/bank-row.js(5), src/main-process/pre-fund-reconciliation/matching-engine.js(3) |
| `buildStableSummary` | 2 | 8 | 1 | src/main-process/statement-worker/service.js(5), src/main-process/statement-worker/session-state.js(3) |
| `canonicalAmount` | 2 | 8 | 2 | src/main-process/position-reconciliation/decimal.js(5), src/main-process/scenario-engines/r4-fund-nature-check.js(3) |
| `checkedSubtract` | 2 | 8 | 1 | src/main-process/background-execution/resource-governor.js(6), src/main-process/background-execution/resource-lease.js(2) |
| `currencyMatches` | 2 | 8 | 1 | src/main-process/scenario-engines/c4-recon-id-fix.js(5), src/main-process/big-account-recognition.js(3) |
| `DETAIL_META_HEADERS` | 2 | 8 | 1 | src/backend/position-reconciliation-import/anomaly-report.js(4), src/main-process/position-reconciliation/filtered-source-report.js(4) |
| `DUPLICATE_FOLD_REASON` | 2 | 8 | 2 | src/main-process/pre-fund-reconciliation/output-mapper.js(5), src/backend/pre-fund-reconciliation-run-store.js(3) |
| `DurabilityBarrierError` | 2 | 8 | 1 | src/main-process/background-execution/durable-file.js(5), src/main-process/manual-balance-seed-settlement.js(3) |
| `freezePlan` | 2 | 8 | 2 | src/backend/vcc-financial-op/destructive-write.js(4), src/backend/vcc-financial-op/result-write.js(4) |
| `mapMirror` | 2 | 8 | 2 | src/backend/database/duplicate-inbound-match-run-repository.js(4), src/backend/database/pre-fund-reconciliation-run-repository.js(4) |
| `MAX_CURRENCIES_PER_ACCOUNT` | 2 | 8 | 2 | src/main-process/new-account/generation-contract.js(4), src/main-process/statement-worker/contracts.js(4) |
| `normalizeBoundedJpmReceipt` | 2 | 8 | 1 | src/main-process/recon-id-fix-service/jpm-receipt-evidence.js(5), src/main-process/recon-id-fix-service/jpm-receipt-authority.js(3) |
| `normalizeDecimalString` | 2 | 8 | 1 | src/main-process/pre-fund-reconciliation/mpt-schema.js(6), src/main-process/pre-fund-reconciliation/mpt-import/spool-reader.js(2) |
| `outboxBatchId` | 2 | 8 | 1 | src/main-process/archive-center/controller.js(6), src/main-process/archive-center/outbox-store.js(2) |
| `parseCellReference` | 2 | 8 | 2 | src/main-process/new-account/strict-worksheet-readback.js(5), src/backend/toolbox-format/xlsx-sheet-scanner.js(3) |
| `PENDING_TABLE` | 2 | 8 | 1 | src/backend/bank-bu-recon-db/month-repository.js(7), src/main-process/bank-bu-worker/side-database.js(1) |
| `pendingImportError` | 2 | 8 | 1 | src/main-process/pending-import-preflight.js(7), src/main.js(1) |
| `POSITION_READ_ONLY_ACTION` | 2 | 8 | 1 | src/main-process/read-only-exports/position/policies.js(5), src/main.js(3) |
| `readPositionSourceSummary` | 2 | 8 | 1 | src/main-process/position-reconciliation/source-summary-cache.js(4), src/main-process/position-reconciliation/store.js(4) |
| `recordRowError` | 2 | 8 | 1 | src/backend/big-table-import/engine.js(4), src/backend/biz-op-recon-import/import-worker.js(4) |
| `requireCount` | 2 | 8 | 2 | src/main-process/recon-id-fix-service/jpm-writeback-plan.js(5), src/backend/database/recon-fix-operation-receipt-repository.js(3) |
| `runData` | 2 | 8 | 2 | src/main-process/bank-bu-worker/export-operation.js(5), src/main-process/background-execution/adapters/acquiring-adapter.js(3) |
| `saxAttributeValue` | 2 | 8 | 1 | src/backend/toolbox-format/ooxml-namespaces.js(4), src/main-process/toolbox-output-writer.js(4) |
| `ServiceClientError` | 2 | 8 | 2 | src/main-process/background-execution/service-client.js(6), src/main-process/background-execution/index.js(2) |
| `setNewAccountStatus` | 2 | 8 | 1 | src/renderer.js(6), src/renderer-previews.js(2) |
| `SHARED_STRINGS_ENTRY` | 2 | 8 | 2 | src/main-process/toolbox-large-split-router.js(5), src/backend/toolbox-xlsx-stream/large-split-worker.js(3) |
| `THEME_COLOR_NAMES` | 2 | 8 | 1 | src/backend/toolbox-format/biff8-colors.js(4), src/backend/toolbox-format/biff8-overlay.js(4) |
| `timestampOf` | 2 | 8 | 2 | src/main-process/background-execution/critical/recovery-request-owner-repository.js(5), src/main-process/background-execution/critical/recovery-control-repository.js(3) |
| `today` | 2 | 8 | 1 | src/main-process/new-account/generation-core.js(6), src/main-process/statement-generation-business.js(2) |
| `toIsoDate` | 2 | 8 | 2 | src/main-process/boc-fx-link-builder.js(4), src/main-process/scenario-engines/jpm-dispatch-order-fix.js(4) |
| `TOOLBOX_MAX_COL_COUNT` | 2 | 8 | 2 | src/backend/toolbox-xlsx-stream/multi-sheet-reader.js(4), src/main-process/toolbox-stream-io.js(4) |
| `trimText` | 2 | 8 | 2 | src/main-process/duplicate-inbound-match/import-model.js(4), src/main-process/duplicate-inbound-match/service.js(4) |
| `validateAndExtractRow` | 2 | 8 | 1 | src/main-process/vcc-op-calc-session.js(5), src/main-process/vcc-op-calc/parser-core.js(3) |
| `validatePositionImportAdapterResult` | 2 | 8 | 1 | src/main-process/background-execution/position-import-adapter-policy.js(6), src/main-process/background-execution/runtime.js(2) |
| `validatorFor` | 2 | 8 | 2 | src/main-process/background-execution/recovery-control-contract.js(6), src/main-process/background-execution/supervisor.js(2) |
| `VCC_FINANCIAL_OP_READ_ONLY_ACTION` | 2 | 8 | 1 | src/main-process/read-only-exports/vcc-financial-op/policies.js(5), src/main.js(3) |
| `VCC_TABLE_POLICY_REGISTRY` | 2 | 8 | 1 | src/backend/vcc-financial-op/mutation-guard.js(6), src/backend/vcc-financial-op/mutation-policy.js(2) |
| `wrapReadError` | 2 | 8 | 2 | src/backend/biz-op-recon-import/reader-streamed.js(4), src/backend/vcc-op-calc-import/reader.js(4) |
| `ACQUIRING_ADAPTER_POLICIES` | 2 | 7 | 1 | src/main-process/background-execution/runtime.js(5), src/main-process/background-execution/acquiring-adapter-policies.js(2) |
| `ACQUIRING_BILL_WORKER_COUNT_DEFAULT` | 2 | 7 | 2 | src/backend/database/settings-repository.js(5), src/backend/database/migrations.js(2) |
| `ACQUIRING_BILL_WORKER_COUNT_KEY` | 2 | 7 | 2 | src/backend/database/settings-repository.js(4), src/backend/database/migrations.js(3) |
| `ALL_MODULE_IDS` | 2 | 7 | 1 | src/backend/database/settings-repository.js(6), src/main-process/import-dialog-state.js(1) |
| `ANOMALY_HEADERS` | 2 | 7 | 2 | src/main-process/bank-bu-recon-writer.js(4), src/main-process/vcc-financial-op-audit-writer.js(3) |
| `applyManualBalancePromptStatus` | 2 | 7 | 1 | src/renderer.js(4), src/renderer-dialogs.js(3) |
| `applyTint` | 2 | 7 | 2 | src/backend/toolbox-format/biff8-colors.js(4), src/backend/toolbox-format/style-registry.js(3) |
| `archiveStorageRootManager` | 2 | 7 | 1 | src/main-process/vcc-financial-op-storage-migration.js(6), src/main.js(1) |
| `assertKey` | 2 | 7 | 2 | src/main-process/background-execution/settlement-recovery-provider-registry.js(4), src/main-process/background-execution/inspector-registry.js(3) |
| `assertSourceSnapshot` | 2 | 7 | 2 | src/main-process/statement-worker/source-identity.js(4), src/main-process/vcc-op-calc/parser-core.js(3) |
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
| `DUPLICATE_SPOOL_FILE_NAMES` | 2 | 7 | 1 | src/main-process/duplicate-inbound-match/spool-filesystem.js(4), src/main-process/duplicate-inbound-match/spool-contract.js(3) |
| `ensureContained` | 2 | 7 | 2 | src/main-process/bank-bu-worker/spool-filesystem.js(4), src/main-process/duplicate-inbound-match/spool-filesystem.js(3) |
| `EXCEL_ST_XSTRING_MAX_RAW_UTF16_UNITS` | 2 | 7 | 1 | src/backend/toolbox-format/excel-text.js(4), src/backend/toolbox-format/xlsx-sheet-scanner.js(3) |
| `FLOW_COLUMN_DEFS` | 2 | 7 | 1 | src/backend/biz-op-recon-db/columns.js(5), src/backend/vcc-op-calc-db/columns.js(2) |
| `flowImportsRepository` | 2 | 7 | 2 | src/main-process/biz-op-recon-session.js(4), src/backend/biz-op-recon-import/import-worker.js(3) |
| `getCommittedRunByOperation` | 2 | 7 | 1 | src/main-process/bank-bu-worker/side-database.js(4), src/main-process/bank-bu-worker/run-operation.js(3) |
| `getNewAccountStatusTitle` | 2 | 7 | 1 | src/renderer.js(5), src/renderer-previews.js(2) |
| `IMPORT_CANCELLED_CODE` | 2 | 7 | 1 | src/backend/vcc-financial-op/detail-importer.js(4), src/main-process/vcc-financial-op-service.js(3) |
| `lastManualBalancePrompt` | 2 | 7 | 1 | src/main-process/statement-worker/probe-state-builder.js(6), src/main.js(1) |
| `localDateOf` | 2 | 7 | 2 | src/main-process/archive-center/archive-service.js(4), src/backend/database/archive-repository.js(3) |
| `localMonthKey` | 2 | 7 | 2 | src/main-process/duplicate-inbound-match/service.js(4), src/main-process/pre-fund-reconciliation/service.js(3) |
| `MANUAL_BALANCE_INSPECTOR_KEY` | 2 | 7 | 1 | src/main-process/manual-balance-seed-settlement.js(6), src/main.js(1) |
| `MAX_INPUT_BYTES` | 2 | 7 | 2 | src/main-process/statement-worker/generation-contracts.js(4), src/main-process/new-account/generation-contract.js(3) |
| `normalizeBatchSize` | 2 | 7 | 2 | src/backend/position-reconciliation-import/maintenance-writer.js(5), src/main-process/pre-fund-reconciliation/mpt-parser.js(2) |
| `normalizeMonth` | 2 | 7 | 2 | src/backend/vcc-financial-op/read-snapshot.js(5), src/backend/vcc-financial-op/destructive-write.js(2) |
| `OLE_CFB_MAGIC` | 2 | 7 | 2 | src/backend/toolbox-format/biff8-overlay.js(4), src/main-process/toolbox-input-kind.js(3) |
| `openBizOpReadDatabase` | 2 | 7 | 1 | src/main-process/read-only-exports/biz-op/writer.js(4), src/main-process/read-only-exports/biz-op/query.js(3) |
| `openReadDatabase` | 2 | 7 | 1 | src/main-process/read-only-exports/pre-fund/query.js(4), src/main-process/read-only-exports/pre-fund/writer.js(3) |
| `PAIR_BY_FUND_TYPE` | 2 | 7 | 1 | src/main-process/position-reconciliation/contracts.js(4), src/main-process/position-reconciliation/matching-engine.js(3) |
| `PENDING_BIZOP_ADAPTER_POLICIES` | 2 | 7 | 1 | src/main-process/background-execution/runtime.js(5), src/main-process/background-execution/pending-bizop-adapter-policies.js(2) |
| `persistStagingAnomalies` | 2 | 7 | 1 | src/backend/vcc-financial-op-db/repository.js(4), src/backend/vcc-financial-op/detail-importer.js(3) |
| `POSITION_DB_CHECKPOINT_TOKEN_KEY` | 2 | 7 | 1 | src/main-process/position-reconciliation/side-db-mutation.js(5), src/main-process/position-reconciliation/store.js(2) |
| `POSITION_DB_GENERATION_KEY` | 2 | 7 | 1 | src/main-process/position-reconciliation/side-db-mutation.js(5), src/main-process/position-reconciliation/store.js(2) |
| `POSITION_IMPORT_ADAPTER_POLICY` | 2 | 7 | 1 | src/main-process/background-execution/runtime.js(5), src/main-process/background-execution/position-import-adapter-policy.js(2) |
| `POSITION_IMPORT_LEDGER_SCHEMA_VERSION` | 2 | 7 | 1 | src/backend/position-reconciliation-import/ledger.js(5), src/backend/position-reconciliation-import/constants.js(2) |
| `POSITION_IMPORT_MAINTENANCE_BATCH_SIZE` | 2 | 7 | 1 | src/backend/position-reconciliation-import/maintenance-writer.js(5), src/backend/position-reconciliation-import/constants.js(2) |
| `preflightCalculation` | 2 | 7 | 1 | src/backend/vcc-financial-op/calculator.js(5), src/main-process/vcc-financial-op-service.js(2) |
| `PREVIEW_MEANINGFUL_ROWS` | 2 | 7 | 1 | src/backend/vcc-financial-op/workbook-reader.js(4), src/backend/vcc-financial-op/system-op-importer.js(3) |
| `pureComputePolicy` | 2 | 7 | 1 | src/main-process/background-execution/canary/packaged-runtime-runner.js(4), src/main-process/background-execution/canary/index.js(3) |
| `readSideOperation` | 2 | 7 | 1 | src/main-process/bank-bu-worker/main-coordinator.js(4), src/main-process/bank-bu-worker/outcome-inspector.js(3) |
| `RECON_RESULT_FIELDS_GATEWAY` | 2 | 7 | 1 | src/main-process/recon-id-fix-io.js(5), src/constants/gateway-bill-recon-fields.js(2) |
| `recoverInterruptedImports` | 2 | 7 | 1 | src/main-process/vcc-financial-op-service.js(5), src/backend/vcc-financial-op-db/repository.js(2) |
| `RECOVERY_REQUEST_MAX_BYTES` | 2 | 7 | 1 | src/main-process/background-execution/recovery-control-contract.js(5), src/main-process/background-execution/critical/recovery-request-owner-repository.js(2) |
| `recoveryHoldIdFor` | 2 | 7 | 1 | src/main-process/background-execution/startup-recovery-coordinator.js(4), src/main-process/background-execution/recovery-hold-request.js(3) |
| `REPORT_MODE` | 2 | 7 | 1 | src/main-process/background-execution/canary/packaged-runtime-request.js(5), src/main-process/background-execution/canary/packaged-runtime-runner.js(2) |
| `resolveManagedRelative` | 2 | 7 | 2 | src/main-process/archive-center/storage-materializer.js(5), src/main-process/vcc-financial-op-storage-rebuild.js(2) |
| `RESULT_TEMPLATE_SHEET_NAME` | 2 | 7 | 1 | src/backend/vcc-financial-op/result-template-contract.js(5), src/main-process/vcc-financial-op-writer.js(2) |
| `roundAmount` | 2 | 7 | 1 | src/backend/file-service/normalizers.js(5), src/backend/file-service.js(2) |
| `ROUTE_DB_SCHEMA_VERSION` | 2 | 7 | 1 | src/main-process/toolbox-background/route-db-contract.js(4), src/main-process/toolbox-background/route-db-sealer.js(3) |
| `runRowIntegrityHash` | 2 | 7 | 1 | src/main-process/position-reconciliation/store.js(5), src/main-process/position-reconciliation/large-import-schema.js(2) |
| `setNewAccountExportAvailability` | 2 | 7 | 1 | src/renderer.js(5), src/renderer-previews.js(2) |
| `sideOperationSnapshots` | 2 | 7 | 1 | src/main-process/duplicate-inbound-match/startup-recovery.js(5), src/main-process/duplicate-inbound-match/startup-gate.js(2) |
| `stateDigest` | 2 | 7 | 1 | src/main-process/recon-id-fix-service/service.js(6), src/main-process/recon-id-fix-service/policies.js(1) |
| `STORAGE_LAYOUT_VERSION` | 2 | 7 | 1 | src/main-process/archive-center/archive-service.js(6), src/main-process/archive-center/storage-layout.js(1) |
| `subjectAuthority` | 2 | 7 | 1 | src/main-process/vcc-financial-op-output/dispatch.js(5), src/main-process/vcc-financial-op-output/authority.js(2) |
| `syncNewAccountCurrencyMode` | 2 | 7 | 1 | src/renderer.js(5), src/renderer-previews.js(2) |
| `tableNames` | 2 | 7 | 1 | src/main-process/vcc-financial-op-storage-rebuild.js(4), src/main-process/duplicate-inbound-match/startup-recovery.js(3) |
| `targetState` | 2 | 7 | 1 | src/backend/database/archive-repository.js(5), src/main-process/toolbox-output-publication.js(2) |
| `VALID_CATEGORIES` | 2 | 7 | 2 | src/backend/database/scenarios-repository.js(4), src/main-process/recon-id-fix-engine.js(3) |
| `validateDuplicateInputSpool` | 2 | 7 | 1 | src/main-process/duplicate-inbound-match/spool-reader.js(4), src/main-process/duplicate-inbound-match/service.js(3) |
| `validateElementCase` | 2 | 7 | 2 | src/backend/toolbox-format/xlsx-pass.js(4), src/backend/toolbox-format/style-registry.js(3) |
| `validateTransition` | 2 | 7 | 1 | src/main-process/background-execution/critical/recovery-request-owner-repository.js(4), src/main-process/background-execution/recovery-control-contract.js(3) |
| `VccOpSaveRunContractError` | 2 | 7 | 1 | src/main-process/vcc-op-calc/save-run-contract.js(5), src/main-process/vcc-op-calc/save-run-lifecycle.js(2) |
| `WORKSHEET_ENTRY_RE` | 2 | 7 | 2 | src/backend/pending-import/xlsx-size-preflight.js(4), src/main-process/toolbox-large-split-router.js(3) |
| `__missingBankColumns` | 2 | 6 | 2 | src/constants/payment-offline-allocation-fields.js(3), src/constants/refund-backfill-fields.js(3) |
| `abortWriters` | 2 | 6 | 2 | src/main-process/toolbox-format-operations.js(4), src/main-process/toolbox-background/output-writer-core.js(2) |
| `absoluteAmount` | 2 | 6 | 1 | src/main-process/position-reconciliation/decimal.js(4), src/main-process/position-reconciliation/matching-engine.js(2) |
| `ACQUIRING_ADAPTER_ACTION_SET` | 2 | 6 | 1 | src/main-process/background-execution/acquiring-adapter-policies.js(3), src/main-process/background-execution/runtime.js(3) |
| `addCalendarDays` | 2 | 6 | 2 | src/backend/database/archive-repository.js(3), src/main-process/archive-center/archive-service.js(3) |
| `addFileFailureAnomaly` | 2 | 6 | 1 | src/backend/vcc-financial-op-db/repository.js(3), src/backend/vcc-financial-op/detail-importer.js(3) |
| `addImportAnomaly` | 2 | 6 | 1 | src/backend/vcc-financial-op-db/repository.js(3), src/backend/vcc-financial-op/system-op-importer.js(3) |
| `admIdSequenceDigest` | 2 | 6 | 1 | src/backend/database/linked-table-writeback-reader.js(3), src/main-process/recon-id-fix-service/jpm-writeback-plan.js(3) |
| `ADMITTED_TOPOLOGY_WORKER_DATA_KEY` | 2 | 6 | 1 | src/main-process/background-execution/adapters/worker-thread-adapter.js(4), src/main-process/vcc-financial-op-output/writer-worker-entry.js(2) |
| `artifactFrom` | 2 | 6 | 2 | src/main-process/toolbox-background/generation-core.js(4), src/main-process/toolbox-background/output-writer-core.js(2) |
| `assertEmptyVccStorageForUpgrade` | 2 | 6 | 1 | src/backend/vcc-financial-op-db/storage-contract.js(4), src/backend/vcc-financial-op-db/migrations.js(2) |
| `assertNoRouteSidecars` | 2 | 6 | 1 | src/main-process/toolbox-background/route-db-contract.js(3), src/main-process/toolbox-background/route-db-sealer.js(3) |
| `assertUnicodeScalarString` | 2 | 6 | 2 | src/main-process/background-execution/canonical-json-v1.js(4), src/main-process/recon-id-fix-service/evidence-projection.js(2) |
| `assertVccExportAuthorityEqual` | 2 | 6 | 1 | src/main-process/vcc-financial-op-output/dispatch.js(4), src/main-process/vcc-financial-op-output/authority.js(2) |
| `AsyncLocalStorage` | 2 | 6 | 2 | src/main.js(4), src/main-process/archive-center/task-lifecycle.js(2) |
| `BANK_BU_DUAL_IMPORT_CONTRACT_VERSION` | 2 | 6 | 1 | src/main-process/bank-bu-worker/spool-contract.js(4), src/main-process/bank-bu-worker/dual-parser-dispatch.js(2) |
| `BANK_BU_SPOOL_FILE_NAMES` | 2 | 6 | 1 | src/main-process/bank-bu-worker/spool-contract.js(3), src/main-process/bank-bu-worker/spool-filesystem.js(3) |
| `BANK_DEPOSIT_FIELDS` | 2 | 6 | 2 | src/backend/database/linked-table-repository.js(4), src/constants/boc-fx-link-fields.js(2) |
| `BANK_DIFF_FIELD_DB_COLUMN` | 2 | 6 | 1 | src/main-process/bank-bu-recon-session.js(4), src/backend/bank-bu-recon-db/columns.js(2) |
| `BILL_CONTRACT_PATH` | 2 | 6 | 2 | src/main-process/acquiring-bill-currency-session.js(4), src/main-process/background-execution/adapters/acquiring-adapter.js(2) |
| `BIZ_OP_MODULE_ID` | 2 | 6 | 1 | src/main-process/biz-op-recon-run-data.js(4), src/main-process/biz-op-archive-lineage.js(2) |
| `bizOpRowToArray` | 2 | 6 | 1 | src/main-process/biz-op-recon-writer.js(4), src/backend/biz-op-recon-db/columns.js(2) |
| `BOC_BANK_FILTER` | 2 | 6 | 2 | src/main-process/boc-fx-link-builder.js(4), src/constants/boc-fx-link-fields.js(2) |
| `buildBankMatchCriteria` | 2 | 6 | 1 | src/main-process/pre-fund-reconciliation/matching-engine.js(4), src/main-process/pre-fund-reconciliation/service.js(2) |
| `buildFileReader` | 2 | 6 | 2 | src/backend/bank-bu-recon-import/reader.js(3), src/backend/biz-op-recon-import/reader.js(3) |
| `buildInfo` | 2 | 6 | 2 | src/main-process/acquiring-bill-currency-writer.js(3), src/main.js(3) |
| `buildNumericCellValue` | 2 | 6 | 2 | src/backend/file-service/writers.js(4), src/main-process/statement-worker/artifact-descriptor.js(2) |
| `buildTemplateSummaryFromRow` | 2 | 6 | 1 | src/backend/database/template-repository.js(4), src/backend/database/utils.js(2) |
| `canonicalDuplicateSideDbRelPath` | 2 | 6 | 1 | src/backend/duplicate-inbound-match-side-db-identity.js(4), src/main-process/duplicate-inbound-match/startup-recovery.js(2) |
| `cellReference` | 2 | 6 | 1 | src/backend/toolbox-format/model.js(3), src/backend/toolbox-format/xlsx-sheet-scanner.js(3) |
| `CLEANUP_TEMPLATE_HEADERS` | 2 | 6 | 2 | src/constants/platform-cleanup-template-fields.js(3), src/main-process/platform-cleanup-writer.js(3) |
| `cleanupPreparedInspectionUnavailableLegacyGap` | 2 | 6 | 1 | src/main-process/background-execution/critical/recovery-request-owner-repository.js(3), src/main-process/background-execution/startup-recovery-coordinator.js(3) |
| `createGenerationInput` | 2 | 6 | 2 | src/main-process/toolbox-background/generation-validator.js(3), src/main-process/vcc-financial-op-output/dispatch.js(3) |
| `createRecoveryTransitionAdapter` | 2 | 6 | 1 | src/main-process/background-execution/task-lifecycle-adapter.js(4), src/main-process/background-execution/index.js(2) |
| `createSplitFilter` | 2 | 6 | 2 | src/main-process/toolbox-format-operations.js(4), src/main-process/toolbox-background/route-db-sealer.js(2) |
| `createStatementImportResult` | 2 | 6 | 1 | src/main-process/statement-worker/contracts.js(3), src/main-process/statement-worker/service.js(3) |
| `createStatementStatusDto` | 2 | 6 | 1 | src/main-process/statement-worker/contracts.js(4), src/main-process/statement-worker/service.js(2) |
| `deferred` | 2 | 6 | 2 | src/main-process/archive-center/task-file-plan-registry.js(3), src/main-process/bank-bu-worker/main-coordinator.js(3) |
| `deletePreviewForTarget` | 2 | 6 | 1 | src/backend/vcc-financial-op/read-snapshot.js(4), src/backend/vcc-financial-op/destructive-write.js(2) |
| `dispatchEngineImportHandle` | 2 | 6 | 1 | src/main-process/big-table-import-dispatch.js(4), src/main-process/background-execution/adapters/acquiring-adapter.js(2) |
| `DUPLICATE_PAIRED_IMPORT_CONTRACT_VERSION` | 2 | 6 | 1 | src/main-process/duplicate-inbound-match/spool-contract.js(4), src/main-process/duplicate-inbound-match/paired-parser-dispatch.js(2) |
| `DUPLICATE_STARTUP_GATE_CONTRACT_VERSION` | 2 | 6 | 1 | src/main-process/duplicate-inbound-match/startup-gate.js(4), src/main.js(2) |
| `durableCanary` | 2 | 6 | 1 | src/main-process/background-execution/execution-policy-registry.js(4), src/main-process/background-execution/index.js(2) |
| `encodePayload` | 2 | 6 | 1 | src/main-process/toolbox-background/route-db-sealer.js(4), src/main-process/toolbox-background/route-db-contract.js(2) |
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
| `ensureBankBuReconRunIdentitySupport` | 2 | 6 | 1 | src/backend/database.js(4), src/backend/database/migrations.js(2) |
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
| `ensureReconFixOperationReceiptSupport` | 2 | 6 | 1 | src/backend/database.js(4), src/backend/database/migrations.js(2) |
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
| `evidenceMatches` | 2 | 6 | 2 | src/main-process/read-only-exports/position/query.js(3), src/main-process/read-only-exports/vcc-financial-op/query.js(3) |
| `exactActionMap` | 2 | 6 | 2 | src/main-process/background-execution/capability-inventory.js(3), src/main-process/background-execution/production-strategy-snapshot.js(3) |
| `excelValueForHeader` | 2 | 6 | 1 | src/backend/position-reconciliation-import/anomaly-report.js(3), src/main-process/position-reconciliation/filtered-source-report.js(3) |
| `exportInspectionEvidence` | 2 | 6 | 1 | src/main-process/vcc-financial-op-dataset-writer.js(4), src/main-process/read-only-exports/vcc-financial-op/query.js(2) |
| `FILENAME_MAPPING_TEMPLATE_ID` | 2 | 6 | 2 | src/renderer.js(4), src/main.js(2) |
| `FLOW_CONTRACT_PATH` | 2 | 6 | 2 | src/main-process/acquiring-bill-currency-session.js(4), src/main-process/background-execution/adapters/acquiring-adapter.js(2) |
| `FX_DELIVERY_SIGNATURE` | 2 | 6 | 2 | src/constants/boc-fx-link-fields.js(3), src/constants/table-signatures.js(3) |
| `GatewayPoolEmptyError` | 2 | 6 | 1 | src/main-process/pre-fund-reconciliation/matching-engine.js(4), src/main-process/pre-fund-reconciliation/service.js(2) |
| `gatewayTagKey` | 2 | 6 | 1 | src/main-process/pre-fund-archive-lineage.js(4), src/main-process/pre-fund-reconciliation/service.js(2) |
| `getCurrencyOptionLabel` | 2 | 6 | 1 | src/renderer.js(5), src/renderer-dialogs.js(1) |
| `getDatasetEvidence` | 2 | 6 | 1 | src/main-process/bank-bu-worker/side-database.js(4), src/main-process/bank-bu-worker/run-operation.js(2) |
| `getVccStorageContractVersion` | 2 | 6 | 1 | src/backend/vcc-financial-op-db/storage-contract.js(4), src/backend/vcc-financial-op-db/migrations.js(2) |
| `gwAmountAbs` | 2 | 6 | 2 | src/main-process/scenario-engines/r5-fund-transfer-backfill.js(4), src/main-process/scenario-engines/many-to-many-detector.js(2) |
| `handleControlMessage` | 2 | 6 | 2 | src/backend/vcc-financial-op/worker-entry.js(3), src/main-process/vcc-financial-op-write-worker.js(3) |
| `hasAnyOperationReceipts` | 2 | 6 | 1 | src/backend/pre-fund-reconciliation-store.js(4), src/main-process/pre-fund-reconciliation/mpt-import/operation-receipt-repository.js(2) |
| `hashOrdinaryFile` | 2 | 6 | 2 | src/main-process/read-only-exports/position/query.js(3), src/main-process/read-only-exports/pre-fund/query.js(3) |
| `hashSourceFile` | 2 | 6 | 2 | src/backend/vcc-financial-op/source-lineage.js(3), src/main-process/vcc-financial-op-dataset-writer.js(3) |
| `headerValues` | 2 | 6 | 1 | src/main-process/toolbox-stream-io.js(4), src/main-process/pre-fund-reconciliation/excel-writer.js(2) |
| `identifyInputFiles` | 2 | 6 | 2 | src/main-process/duplicate-inbound-match/service.js(4), src/main-process/duplicate-inbound-match/input-classifier.js(2) |
| `importEvidenceHash` | 2 | 6 | 2 | src/main-process/duplicate-inbound-match/service.js(4), src/main-process/duplicate-inbound-match/startup-recovery.js(2) |
| `initWorkerDb` | 2 | 6 | 2 | src/main-process/run-check-multiworker-worker.js(3), src/main-process/run-check-worker.js(3) |
| `INSERT_SQL` | 2 | 6 | 2 | src/backend/biz-op-recon-db/flow-imports-repository.js(3), src/backend/biz-op-recon-db/imports-repository.js(3) |
| `inspectDatasetDeletion` | 2 | 6 | 1 | src/backend/vcc-financial-op/dataset-deletion.js(4), src/backend/vcc-financial-op/data-target-deletion.js(2) |
| `INSTALL_BUSY_MESSAGE` | 2 | 6 | 1 | src/main-process/business-operation-registry.js(3), src/main.js(3) |
| `installVccStorageWriteGuards` | 2 | 6 | 1 | src/backend/vcc-financial-op-db/storage-contract.js(4), src/backend/vcc-financial-op-db/migrations.js(2) |
| `isLeapYear` | 2 | 6 | 2 | src/backend/toolbox-format/number-date.js(4), src/main-process/pre-fund-reconciliation/mpt-schema.js(2) |
| `isLegacyPendingHeaders` | 2 | 6 | 1 | src/backend/vcc-financial-op/workbook-reader.js(4), src/backend/vcc-financial-op/definitions.js(2) |
| `isPathInside` | 2 | 6 | 2 | src/main-process/archive-center/archive-service.js(3), src/main-process/duplicate-inbound-match/managed-service.js(3) |
| `LEGACY_HANDLER_PAIRS` | 2 | 6 | 1 | src/main-process/background-execution/action-manifest.js(4), src/main-process/background-execution/coverage-check.js(2) |
| `listImportedDateBuPairs` | 2 | 6 | 1 | src/main-process/biz-op-recon-run-data.js(4), src/backend/biz-op-recon-db/imports-repository.js(2) |
| `listPositionCommittedOperationInputs` | 2 | 6 | 1 | src/main-process/position-reconciliation/side-db-mutation.js(4), src/main-process/position-reconciliation/store.js(2) |
| `loadDeleteEvidenceV2` | 2 | 6 | 1 | src/backend/vcc-financial-op/read-snapshot.js(4), src/backend/vcc-financial-op/destructive-write.js(2) |
| `locationText` | 2 | 6 | 1 | src/main-process/background-execution/adapters/utility-process-adapter.js(3), src/main-process/pre-fund-reconciliation/bank-row.js(3) |
| `MANUAL_BALANCE_SETTLEMENT_KEY` | 2 | 6 | 1 | src/main-process/manual-balance-seed-settlement.js(5), src/main.js(1) |
| `mapBalancedRow` | 2 | 6 | 1 | src/main-process/pre-fund-reconciliation/output-mapper.js(4), src/main-process/pre-fund-reconciliation/service.js(2) |
| `mapChannelBillRow` | 2 | 6 | 1 | src/main-process/pre-fund-reconciliation/output-mapper.js(4), src/main-process/pre-fund-reconciliation/service.js(2) |
| `mapUnbalancedRow` | 2 | 6 | 1 | src/main-process/pre-fund-reconciliation/output-mapper.js(4), src/main-process/pre-fund-reconciliation/service.js(2) |
| `matchAmountSplitConditionValue` | 2 | 6 | 1 | src/backend/file-service.js(4), src/backend/file-service/normalizers.js(2) |
| `materializeManualBalanceSeedPlan` | 2 | 6 | 1 | src/main-process/manual-balance-seed-preflight.js(3), src/main-process/manual-balance-seed-settlement.js(3) |
| `migrateC4ReconGroupsAmountLockedFieldPair` | 2 | 6 | 1 | src/backend/database.js(4), src/backend/database/migrations.js(2) |
| `migrateC4ReconGroupsStructure` | 2 | 6 | 1 | src/backend/database.js(4), src/backend/database/migrations.js(2) |
| `migrateGatewayReconIdFixFieldPairs` | 2 | 6 | 1 | src/backend/database.js(4), src/backend/database/migrations.js(2) |
| `MODULE_DUPLICATE_INBOUND_MATCH` | 2 | 6 | 1 | src/backend/run-data-store.js(5), src/backend/duplicate-inbound-match-store.js(1) |
| `monthOfDate` | 2 | 6 | 1 | src/backend/vcc-financial-op/row-mapper.js(3), src/backend/vcc-financial-op/system-op-importer.js(3) |
| `MUTATION_ACTIONS` | 2 | 6 | 2 | src/main-process/bank-bu-worker/main-coordinator.js(3), src/main-process/bank-bu-worker/worker-host.js(3) |
| `normalizeArchiveSources` | 2 | 6 | 2 | src/main-process/read-only-exports/vcc-financial-op/actions.js(3), src/main-process/read-only-exports/vcc-financial-op/query.js(3) |
| `normalizeDateRange` | 2 | 6 | 1 | src/backend/pre-fund-reconciliation-store.js(5), src/main-process/pre-fund-reconciliation/service.js(1) |
| `normalizedAttributes` | 2 | 6 | 2 | src/backend/toolbox-format/style-registry.js(4), src/backend/toolbox-format/xlsx-sheet-scanner.js(2) |
| `normalizeFill` | 2 | 6 | 2 | src/backend/toolbox-format/style-registry.js(4), src/backend/toolbox-format/biff8-overlay.js(2) |
| `normalizeFont` | 2 | 6 | 2 | src/backend/toolbox-format/biff8-overlay.js(3), src/backend/toolbox-format/style-registry.js(3) |
| `normalizeGatewayCandidate` | 2 | 6 | 1 | src/main-process/pre-fund-reconciliation/matching-engine.js(4), src/main-process/pre-fund-reconciliation/service.js(2) |
| `normalizeImportBatchId` | 2 | 6 | 1 | src/backend/vcc-financial-op/import-service.js(4), src/main-process/vcc-financial-op-service.js(2) |
| `normalizeScope` | 2 | 6 | 2 | src/backend/vcc-financial-op/dataset-deletion.js(3), src/main-process/background-execution/critical/recovery-request-owner-repository.js(3) |
| `normalizeStagingBatchId` | 2 | 6 | 1 | src/main-process/position-reconciliation/input-staging.js(4), src/main-process/position-reconciliation/import-dispatch.js(2) |
| `openVccWriteDatabase` | 2 | 6 | 1 | src/backend/vcc-financial-op/result-write.js(4), src/backend/vcc-financial-op/destructive-write.js(2) |
| `ownDataKeys` | 2 | 6 | 2 | src/main-process/bank-bu-worker/operation-receipt-repository.js(3), src/main-process/duplicate-inbound-match/operation-receipt-repository.js(3) |
| `OWNER_KEY_HASH` | 2 | 6 | 2 | src/main-process/duplicate-inbound-match/worker-host.js(3), src/main-process/fund-recon-worker/worker-host.js(3) |
| `parseCellType` | 2 | 6 | 2 | src/backend/big-table-import/row-scanner.js(4), src/backend/toolbox-format/xlsx-sheet-scanner.js(2) |
| `parsePositionPendingArchiveFiles` | 2 | 6 | 1 | src/main-process/position-reconciliation/operation-lifecycle.js(4), src/main-process/position-reconciliation/service.js(2) |
| `PARSER_CONTRACT_VERSION` | 2 | 6 | 1 | src/main-process/vcc-op-calc/parser-core.js(4), src/main-process/vcc-op-calc/parser-pipeline.js(2) |
| `parseThemeColors` | 2 | 6 | 2 | src/backend/toolbox-format/biff8-overlay.js(3), src/backend/toolbox-format/style-registry.js(3) |
| `PART_TABLE` | 2 | 6 | 2 | src/main-process/run-check-multiworker-worker.js(4), src/main-process/run-check-multiworker.js(2) |
| `PENDING_BIZOP_ADAPTER_ACTION_SET` | 2 | 6 | 1 | src/main-process/background-execution/pending-bizop-adapter-policies.js(3), src/main-process/background-execution/runtime.js(3) |
| `PENDING_DIFF_FIELD_DB_COLUMN` | 2 | 6 | 1 | src/main-process/bank-bu-recon-session.js(4), src/backend/bank-bu-recon-db/columns.js(2) |
| `pendingHeaderMismatchDetails` | 2 | 6 | 1 | src/backend/vcc-financial-op/workbook-reader.js(4), src/backend/vcc-financial-op/pending-template-contract.js(2) |
| `pendingSession` | 2 | 6 | 1 | src/main-process/pending-import-preflight.js(4), src/main.js(2) |
| `POSITION_DB_IDENTITY_KEY` | 2 | 6 | 1 | src/main-process/position-reconciliation/side-db-mutation.js(4), src/main-process/position-reconciliation/store.js(2) |
| `PositionImportLedger` | 2 | 6 | 1 | src/backend/position-reconciliation-import/preflight.js(4), src/backend/position-reconciliation-import/ledger.js(2) |
| `PRE_SWITCH_PHASES` | 2 | 6 | 2 | src/main-process/archive-center/storage-root-manager.js(4), src/main-process/vcc-financial-op-storage-rebuild.js(2) |
| `protocolSchema` | 2 | 6 | 2 | src/main-process/background-execution/protocol-validator.js(3), src/main-process/background-execution/protocol.js(3) |
| `readDuplicateParserOutcome` | 2 | 6 | 2 | src/main-process/duplicate-inbound-match/parser-outcome.js(4), src/main-process/duplicate-inbound-match/spool-reader.js(2) |
| `readRegularFile` | 2 | 6 | 2 | src/main-process/bank-bu-worker/spool-reader.js(3), src/main-process/duplicate-inbound-match/spool-reader.js(3) |
| `readSystemOpSnapshotCandidates` | 2 | 6 | 1 | src/backend/vcc-financial-op/system-op-importer.js(4), src/main-process/vcc-financial-op-dataset-writer.js(2) |
| `reconAmount` | 2 | 6 | 1 | src/backend/acquiring-bill-currency-db/columns.js(3), src/main-process/scenario-engines/r5-payment-offline-allocation-backfill.js(3) |
| `reconIdFixSession` | 2 | 6 | 1 | src/renderer.js(5), src/main.js(1) |
| `REFUND_RO_COLUMNS` | 2 | 6 | 1 | src/constants/refund-backfill-fields.js(4), src/main-process/scenario-engines/r5-refund-order-backfill.js(2) |
| `removeArtifacts` | 2 | 6 | 1 | src/main-process/statement-worker/generation.js(4), src/main-process/statement-worker/service.js(2) |
| `removedRepo` | 2 | 6 | 2 | src/backend/pending-export/writer.js(4), src/backend/pending-reconcile/removal-match.js(2) |
| `requireDatabasePath` | 2 | 6 | 2 | src/main-process/fund-recon-worker/service.js(4), src/main-process/recon-id-fix-service/service.js(2) |
| `requirePlainObject` | 2 | 6 | 2 | src/main-process/duplicate-inbound-match/managed-service.js(3), src/main-process/fund-recon-worker/artifact-generator.js(3) |
| `resolveDuplicateInputFiles` | 2 | 6 | 2 | src/main-process/duplicate-inbound-match/input-classifier.js(4), src/main-process/duplicate-inbound-match/spool-reader.js(2) |
| `resultCounts` | 2 | 6 | 1 | src/main-process/duplicate-inbound-match/startup-recovery.js(4), src/backend/duplicate-inbound-match-store.js(2) |
| `retireChargeOutboundOrphans` | 2 | 6 | 1 | src/backend/database.js(4), src/backend/database/migrations.js(2) |
| `runC1Scenario` | 2 | 6 | 2 | src/main-process/scenario-engines/index.js(4), src/main-process/scenario-engines/c1-extract-recon-id.js(2) |
| `runParserWorker` | 2 | 6 | 2 | src/main-process/pre-fund-reconciliation/mpt-import/managed-import.js(3), src/main-process/vcc-op-calc/parser-pipeline.js(3) |
| `runReconciliationCore` | 2 | 6 | 2 | src/backend/pending-reconcile/engine.js(3), src/main-process/biz-op-recon-session.js(3) |
| `runStartupPhaseSync` | 2 | 6 | 1 | src/backend/database.js(4), src/backend/startup-phase.js(2) |
| `sha256Bytes` | 2 | 6 | 1 | src/main-process/toolbox-background/route-db-contract.js(4), src/main-process/toolbox-background/route-db-sealer.js(2) |
| `sha256FileSync` | 2 | 6 | 1 | src/main-process/toolbox-background/route-db-contract.js(3), src/main-process/toolbox-background/route-db-sealer.js(3) |
| `shouldFallbackToSingleWorker` | 2 | 6 | 1 | src/main-process/acquiring-bill-currency-session.js(3), src/main-process/background-execution/adapters/acquiring-adapter.js(3) |
| `signedDayDiff` | 2 | 6 | 2 | src/main-process/scenario-engines/r5-refund-order-backfill.js(4), src/main-process/scenario-engines/engine-date-utils.js(2) |
| `splitSignedAmountValue` | 2 | 6 | 1 | src/backend/file-service.js(4), src/backend/file-service/normalizers.js(2) |
| `stageInputFiles` | 2 | 6 | 1 | src/main-process/position-reconciliation/service.js(4), src/main-process/position-reconciliation/input-staging.js(2) |
| `statementGenerationInputEvidence` | 2 | 6 | 1 | src/main-process/statement-worker/service.js(4), src/main-process/statement-worker/session-state.js(2) |
| `STRICT_YEAR_MONTH_PATTERN` | 2 | 6 | 1 | src/backend/vcc-financial-op-db/state-model.js(4), src/backend/vcc-financial-op-db/migrations.js(2) |
| `SUPPORTED_SCENARIO_BUNDLE_VERSION` | 2 | 6 | 1 | src/backend/scenarios-bundle-io.js(5), src/main.js(1) |
| `validateAcquiringRunAdapterResult` | 2 | 6 | 1 | src/main-process/background-execution/acquiring-adapter-policies.js(4), src/main-process/background-execution/runtime.js(2) |
| `validatedResultDigest` | 2 | 6 | 1 | src/backend/vcc-financial-op/operation-token-v2.js(4), src/backend/vcc-financial-op/result-write.js(2) |
| `validateName` | 2 | 6 | 2 | src/backend/database/channels-repository.js(3), src/backend/database/scenarios-repository.js(3) |
| `validateNewAccountSaveAsResult` | 2 | 6 | 1 | src/main-process/new-account/artifact-copy.js(4), src/main-process/background-execution/runtime.js(2) |
| `validatePolicyDocument` | 2 | 6 | 1 | src/main-process/background-execution/execution-policy-registry.js(4), src/main-process/background-execution/index.js(2) |
| `validateReconFixExportAuthority` | 2 | 6 | 1 | src/main-process/recon-id-fix-service/policies.js(4), src/main-process/recon-id-fix-service/export-operation.js(2) |
| `validateRequest` | 2 | 6 | 1 | src/main-process/background-execution/resource-governor.js(4), src/main-process/background-execution/critical/recovery-request-owner-repository.js(2) |
| `VCC_BILL_DATE_DB_COLUMN` | 2 | 6 | 1 | src/main-process/vcc-op-calc/parser-core.js(4), src/backend/vcc-op-calc-db/columns.js(2) |
| `VCC_DIRECTION_DB_COLUMN` | 2 | 6 | 1 | src/main-process/vcc-op-calc/parser-core.js(4), src/backend/vcc-op-calc-db/columns.js(2) |
| `VCC_RECON_AMOUNT_DB_COLUMN` | 2 | 6 | 1 | src/main-process/vcc-op-calc/parser-core.js(4), src/backend/vcc-op-calc-db/columns.js(2) |
| `VCC_STORAGE_GUARD_TRIGGER_PREFIX` | 2 | 6 | 1 | src/backend/vcc-financial-op-db/storage-contract.js(4), src/backend/vcc-financial-op/mutation-guard.js(2) |
| `waitUntil` | 2 | 6 | 1 | src/main-process/background-execution/supervisor.js(4), src/main-process/background-execution/external-parser-finalization.js(2) |
| `WORKER_OPERATION_CONTEXT_FIELDS` | 2 | 6 | 1 | src/main-process/archive-center/worker-operation-context.js(4), src/main-process/background-execution/adapters/acquiring-adapter.js(2) |
| `WORKER_SCRIPT` | 2 | 6 | 2 | src/main-process/biz-op-recon-session.js(3), src/main-process/pending-session.js(3) |
| `workerScriptOverride` | 2 | 6 | 2 | src/main-process/run-check-multiworker.js(3), src/main-process/run-check-worker-pool.js(3) |
| `WRITER_OUTPUT_HEADERS_V2` | 2 | 6 | 1 | src/main-process/acquiring-bill-currency-writer.js(4), src/backend/acquiring-bill-currency-db/columns.js(2) |
| `ZHONGTAI_DISPATCH_ORDER_SIGNATURE` | 2 | 6 | 2 | src/constants/fund-transfer-recon-fields.js(3), src/constants/table-signatures.js(3) |
| `ACTION_MANIFEST_VERSION` | 2 | 5 | 1 | src/main-process/background-execution/action-manifest.js(3), src/main-process/background-execution/coverage-check.js(2) |
| `ActionTaskBindingRegistryError` | 2 | 5 | 1 | src/main-process/background-execution/action-task-binding-registry.js(3), src/main-process/background-execution/index.js(2) |
| `allowMptFinanceSafeValue` | 2 | 5 | 1 | src/main-process/pre-fund-reconciliation/mpt-import/policies.js(3), src/main-process/pre-fund-reconciliation/mpt-import/file-result-safety.js(2) |
| `assertDatasetCurrent` | 2 | 5 | 1 | src/main-process/bank-bu-worker/side-database.js(3), src/main-process/bank-bu-worker/run-operation.js(2) |
| `assertDuplicateResultConservation` | 2 | 5 | 1 | src/backend/duplicate-inbound-match-store.js(3), src/backend/duplicate-inbound-match-result-digest.js(2) |
| `assertFinanceSafeValue` | 2 | 5 | 1 | src/main-process/background-execution/error-codec.js(3), src/main-process/background-execution/protocol-validator.js(2) |
| `assertJpmWritebackPlan` | 2 | 5 | 1 | src/main-process/recon-id-fix-service/jpm-writeback-plan.js(3), src/main-process/recon-id-fix-service/jpm-writeback-transaction.js(2) |
| `assertManagedSourceStillRegular` | 2 | 5 | 1 | src/main-process/read-only-exports/pending/writer.js(3), src/main-process/read-only-exports/pending/actions.js(2) |
| `assertNormalizedFilePlanV1` | 2 | 5 | 1 | src/main-process/new-account/artifact-copy.js(3), src/main-process/archive-center/file-plan.js(2) |
| `assertPlainObject` | 2 | 5 | 2 | src/main-process/pre-fund-reconciliation/mpt-import/spool-reader.js(3), src/main-process/toolbox-background/generation-contract.js(2) |
| `assertReconFixEvidenceSettlementAdmission` | 2 | 5 | 1 | src/main-process/recon-id-fix-service/export-operation.js(3), src/main-process/recon-id-fix-service/evidence-settlement-admission.js(2) |
| `assertSourceStatsMatch` | 2 | 5 | 1 | src/backend/position-reconciliation-import/source-writer.js(3), src/backend/position-reconciliation-import/account-writer.js(2) |
| `assertStagingDirectory` | 2 | 5 | 2 | src/main-process/recon-id-fix-service/export-operation.js(3), src/main-process/vcc-financial-op-output/dispatch.js(2) |
| `assertStatementSourceIdentityCurrent` | 2 | 5 | 1 | src/main-process/statement-worker/session-state.js(3), src/main-process/statement-worker/source-identity.js(2) |
| `BALANCED_HEADERS` | 2 | 5 | 1 | src/main-process/pre-fund-reconciliation/excel-writer.js(3), src/main-process/pre-fund-reconciliation/output-mapper.js(2) |
| `BANK_CURRENCY_FIELD` | 2 | 5 | 2 | src/main-process/scenario-engines/dbs-charge-fund-check.js(3), src/main-process/scenario-engines/r4-fund-nature-check.js(2) |
| `BANK_DIRECTION_FIELDS` | 2 | 5 | 1 | src/main-process/scenario-engines/bank-direction-validator.js(3), src/main-process/scenario-engines/r4-fund-nature-check.js(2) |
| `BANK_STATEMENT_SHEET_NAME` | 2 | 5 | 2 | src/main-process/bank-statement-io.js(3), src/main-process/duplicate-inbound-match/input-classifier.js(2) |
| `bankContext` | 2 | 5 | 1 | src/main-process/pre-fund-reconciliation/service.js(3), src/main-process/pre-fund-reconciliation/matching-engine.js(2) |
| `Biff8RecordError` | 2 | 5 | 1 | src/backend/toolbox-format/biff8-records.js(3), src/backend/toolbox-format/biff8-overlay.js(2) |
| `BILL_INSERT_SQL` | 2 | 5 | 2 | src/backend/acquiring-bill-currency-import/contract-bill.js(3), src/backend/acquiring-bill-currency-db/import-repository.js(2) |
| `BIZ_OP_END_BALANCE_DB_COLUMN` | 2 | 5 | 1 | src/main-process/biz-op-recon-session.js(3), src/backend/biz-op-recon-db/columns.js(2) |
| `BOC_PAYMENT_DETAIL_KEYWORD` | 2 | 5 | 2 | src/main-process/boc-fx-link-builder.js(3), src/constants/boc-fx-link-fields.js(2) |
| `buildDefaultFileName` | 2 | 5 | 1 | src/main-process/duplicate-inbound-match/service.js(3), src/main-process/duplicate-inbound-match/excel-writer.js(2) |
| `buildFeatureRegex` | 2 | 5 | 2 | src/main-process/scenario-engines/c1-extract-recon-id.js(3), src/main-process/scenario-engines/r5-refund-order-backfill.js(2) |
| `buildImportEvidence` | 2 | 5 | 2 | src/main-process/bank-bu-worker/identity.js(3), src/main-process/bank-bu-worker/import-operation.js(2) |
| `buildResultMutationTokenV2` | 2 | 5 | 1 | src/backend/vcc-financial-op/read-snapshot.js(3), src/backend/vcc-financial-op/operation-token-v2.js(2) |
| `buildRowMapper` | 2 | 5 | 2 | src/backend/biz-op-recon-import/reader.js(3), src/backend/bank-bu-recon-import/reader.js(2) |
| `buildStatementImportCandidate` | 2 | 5 | 1 | src/main-process/statement-worker/service.js(3), src/main-process/statement-worker/session-state.js(2) |
| `captureTargetParentIdentity` | 2 | 5 | 1 | src/main-process/archive-center/target-parent-identity.js(3), src/main-process/archive-center/file-plan.js(2) |
| `CHANNEL_BILL_HEADERS` | 2 | 5 | 1 | src/main-process/pre-fund-reconciliation/excel-writer.js(3), src/main-process/pre-fund-reconciliation/output-mapper.js(2) |
| `checkpointValue` | 2 | 5 | 2 | src/main-process/position-reconciliation/side-db-mutation.js(3), src/main-process/position-reconciliation/store.js(2) |
| `cleanupStagingPathsAsync` | 2 | 5 | 1 | src/main-process/position-reconciliation/service.js(3), src/main-process/position-reconciliation/input-staging.js(2) |
| `COLUMN_WIDTHS` | 2 | 5 | 1 | src/backend/position-reconciliation-import/anomaly-report.js(3), src/main-process/position-reconciliation/filtered-source-report.js(2) |
| `computeMaxParallel` | 2 | 5 | 2 | src/backend/big-table-import/pipeline.js(3), src/main-process/big-table-import-dispatch.js(2) |
| `computeParserSemanticHash` | 2 | 5 | 1 | src/main-process/vcc-op-calc/parser-core.js(3), src/main-process/vcc-op-calc/ordered-reducer.js(2) |
| `consumeDuplicateInputSpool` | 2 | 5 | 1 | src/main-process/duplicate-inbound-match/service.js(3), src/main-process/duplicate-inbound-match/spool-reader.js(2) |
| `consumeRows` | 2 | 5 | 2 | src/main-process/duplicate-inbound-match/spool-reader.js(3), src/main-process/bank-bu-worker/spool-reader.js(2) |
| `createActionTaskBindingRegistry` | 2 | 5 | 1 | src/main-process/background-execution/action-task-binding-registry.js(3), src/main-process/background-execution/index.js(2) |
| `createBiff8GridResolver` | 2 | 5 | 1 | src/backend/toolbox-format/biff8-pass.js(3), src/backend/toolbox-format/biff8-overlay.js(2) |
| `createExecutionResult` | 2 | 5 | 2 | src/main-process/background-execution/supervisor.js(3), src/main-process/background-execution/execution-result.js(2) |
| `createInvalidExtraFeeWarning` | 2 | 5 | 1 | src/main-process/scenario-engines/r5-fund-transfer-backfill.js(3), src/main-process/scenario-engines/r5-fund-transfer-recon-backfill.js(2) |
| `createMainExpectedArtifactDescriptors` | 2 | 5 | 1 | src/main-process/statement-worker/publication.js(3), src/main-process/statement-worker/artifact-descriptor.js(2) |
| `createMigrationJournal` | 2 | 5 | 1 | src/main-process/vcc-financial-op-storage-rebuild.js(3), src/main-process/vcc-financial-op-storage-migration.js(2) |
| `createResourceLease` | 2 | 5 | 1 | src/main-process/background-execution/resource-governor.js(3), src/main-process/background-execution/resource-lease.js(2) |
| `createSheet` | 2 | 5 | 2 | src/main-process/vcc-financial-op-audit-writer.js(3), src/main-process/pre-fund-reconciliation/mpt-error-report-writer.js(2) |
| `createSlimEffectiveRowsTable` | 2 | 5 | 1 | src/backend/vcc-financial-op-db/storage-contract.js(3), src/main-process/vcc-financial-op-storage-rebuild.js(2) |
| `createStatementImportRequest` | 2 | 5 | 2 | src/main-process/statement-worker/import-contracts.js(3), src/main-process/statement-worker/interaction-contracts.js(2) |
| `createStatementInteractionCancelledResult` | 2 | 5 | 1 | src/main-process/statement-worker/contracts.js(3), src/main-process/statement-worker/service.js(2) |
| `createStatementServiceState` | 2 | 5 | 1 | src/main-process/statement-worker/service.js(3), src/main-process/statement-worker/session-state.js(2) |
| `createStatementStatusResult` | 2 | 5 | 1 | src/main-process/statement-worker/contracts.js(3), src/main-process/statement-worker/service.js(2) |
| `datasetHeads` | 2 | 5 | 1 | src/main-process/biz-op-archive-lineage.js(4), src/main-process/read-only-exports/biz-op/query.js(1) |
| `DEFAULT_BUILTIN_FORMATS` | 2 | 5 | 1 | src/backend/toolbox-format/biff8-records.js(3), src/backend/toolbox-format/biff8-overlay.js(2) |
| `deriveSlotIdentity` | 2 | 5 | 1 | src/main-process/duplicate-inbound-match/spool-contract.js(3), src/main-process/duplicate-inbound-match/paired-parser-dispatch.js(2) |
| `deserializeFromMessage` | 2 | 5 | 2 | src/main-process/run-check-worker-pool.js(3), src/main-process/run-check-multiworker.js(2) |
| `DIFF_HEADER_TAIL` | 2 | 5 | 1 | src/main-process/biz-op-recon-writer.js(3), src/backend/biz-op-recon-db/columns.js(2) |
| `DIFF_OUTPUT_BANK_SHEET` | 2 | 5 | 1 | src/main-process/bank-bu-recon-writer.js(3), src/backend/bank-bu-recon-db/columns.js(2) |
| `DIFF_OUTPUT_PENDING_SHEET` | 2 | 5 | 1 | src/main-process/bank-bu-recon-writer.js(3), src/backend/bank-bu-recon-db/columns.js(2) |
| `DUPLICATE_STARTUP_INSPECTOR_KEY` | 2 | 5 | 1 | src/main-process/duplicate-inbound-match/startup-recovery.js(4), src/main.js(1) |
| `DUPLICATE_STARTUP_RECOVERY_KEY` | 2 | 5 | 1 | src/main-process/duplicate-inbound-match/startup-recovery.js(4), src/main.js(1) |
| `DUPLICATE_STATE_BUDGET_BYTES` | 2 | 5 | 2 | src/main-process/duplicate-inbound-match/policies.js(3), src/main-process/duplicate-inbound-match/state-footprint.js(2) |
| `ENGINE_WORKER_ENTRY` | 2 | 5 | 2 | src/main-process/big-table-import-dispatch.js(3), src/main-process/acquiring-bill-currency-session.js(2) |
| `ensureArchiveMetadataSupport` | 2 | 5 | 1 | src/backend/database/archive-repository.js(3), src/main-process/background-execution/canary/packaged-runtime-runner.js(2) |
| `ERROR_HEADER_TAIL` | 2 | 5 | 1 | src/main-process/biz-op-recon-writer.js(3), src/backend/biz-op-recon-db/columns.js(2) |
| `estimateMptFileSpoolBytes` | 2 | 5 | 2 | src/main-process/pre-fund-reconciliation/mpt-import/spool-admission.js(3), src/main-process/pre-fund-reconciliation/mpt-import/spool-writer.js(2) |
| `estimateStatementServiceStateFootprint` | 2 | 5 | 2 | src/main-process/statement-worker/service.js(3), src/main-process/statement-worker/state-footprint.js(2) |
| `exactOperationInspection` | 2 | 5 | 1 | src/main-process/duplicate-inbound-match/startup-recovery.js(3), src/main-process/duplicate-inbound-match/startup-gate.js(2) |
| `executeAcquiringExport` | 2 | 5 | 2 | src/main-process/read-only-exports/acquiring/executor.js(3), src/main-process/read-only-exports/acquiring/worker-entry.js(2) |
| `extractYearMonth` | 2 | 5 | 1 | src/main-process/vcc-op-calc/parser-core.js(3), src/main-process/vcc-op-calc-session.js(2) |
| `freezeGatewayTags` | 2 | 5 | 1 | src/main-process/pre-fund-archive-lineage.js(3), src/main-process/pre-fund-reconciliation/service.js(2) |
| `freezeImportArchiveHandoffFiles` | 2 | 5 | 1 | src/backend/vcc-financial-op/import-service.js(3), src/main-process/vcc-financial-op-service.js(2) |
| `freezePositionSourceSnapshot` | 2 | 5 | 1 | src/main.js(3), src/main-process/read-only-exports/position/query.js(2) |
| `freezeVccImportAuditSourceSnapshot` | 2 | 5 | 1 | src/main.js(3), src/main-process/read-only-exports/vcc-financial-op/query.js(2) |
| `FUND_RECON_STATE_BUDGET_BYTES` | 2 | 5 | 1 | src/main-process/fund-recon-worker/policies.js(3), src/main-process/fund-recon-worker/state-footprint.js(2) |
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
| `HASH_VERSION` | 2 | 5 | 1 | src/backend/vcc-financial-op/row-mapper.js(3), src/main-process/vcc-financial-op-dataset-writer.js(2) |
| `hashRegularFile` | 2 | 5 | 2 | src/main-process/vcc-financial-op-output-recovery.js(3), src/main-process/vcc-financial-op-output/writer-core.js(2) |
| `hashSourceFileSync` | 2 | 5 | 1 | src/backend/vcc-financial-op/source-lineage.js(3), src/backend/vcc-financial-op/system-op-importer.js(2) |
| `hasInvalidExtraFee` | 2 | 5 | 1 | src/main-process/scenario-engines/r5-fund-transfer-backfill.js(3), src/main-process/scenario-engines/r5-fund-transfer-recon-backfill.js(2) |
| `identifyMptHeader` | 2 | 5 | 1 | src/main-process/pre-fund-reconciliation/mpt-parser.js(3), src/main-process/pre-fund-reconciliation/mpt-schema.js(2) |
| `identityError` | 2 | 5 | 1 | src/main-process/vcc-financial-op-output/staging-identity.js(3), src/main-process/vcc-financial-op-output/dispatch.js(2) |
| `importDetailGroup` | 2 | 5 | 1 | src/backend/vcc-financial-op/detail-importer.js(3), src/backend/vcc-financial-op/import-service.js(2) |
| `INBOUND_FIELDS` | 2 | 5 | 1 | src/main-process/pre-fund-reconciliation/mpt-schema.js(3), src/main-process/pre-fund-reconciliation/mpt-error-report-writer.js(2) |
| `initializeActionTaskBindingRegistry` | 2 | 5 | 1 | src/main-process/background-execution/action-task-binding-registry.js(3), src/main-process/background-execution/index.js(2) |
| `inspectDuplicateInputFile` | 2 | 5 | 2 | src/main-process/duplicate-inbound-match/input-classifier.js(3), src/main-process/duplicate-inbound-match/spool-writer.js(2) |
| `inspectImportOutcome` | 2 | 5 | 1 | src/main-process/bank-bu-worker/main-coordinator.js(3), src/main-process/bank-bu-worker/outcome-inspector.js(2) |
| `inspectRunOutcome` | 2 | 5 | 1 | src/main-process/bank-bu-worker/outcome-inspector.js(3), src/main-process/bank-bu-worker/main-coordinator.js(2) |
| `inspectVccOpSaveRunEvidence` | 2 | 5 | 1 | src/main-process/vcc-op-calc/save-run-contract.js(3), src/main-process/vcc-op-calc/save-run-inspector.js(2) |
| `isMptSourceBatch` | 2 | 5 | 2 | src/main-process/pre-fund-reconciliation/mpt-schema.js(3), src/main-process/pre-fund-reconciliation/mpt-import/file-result-safety.js(2) |
| `isUnsafeAuditError` | 2 | 5 | 1 | src/backend/vcc-financial-op/result-write.js(3), src/backend/vcc-financial-op/destructive-write.js(2) |
| `isVccOpSaveRunRecoveryRequired` | 2 | 5 | 1 | src/main-process/vcc-op-calc/save-run-lifecycle.js(4), src/main.js(1) |
| `iterateDuplicateRecords` | 2 | 5 | 1 | src/main-process/read-only-exports/pre-fund/query.js(3), src/backend/pre-fund-reconciliation-run-store.js(2) |
| `KEY_PATTERN` | 2 | 5 | 2 | src/main-process/background-execution/inspector-registry.js(3), src/main-process/background-execution/settlement-recovery-provider-registry.js(2) |
| `LARGE_TABLE_SCOPE_PROOF_SET` | 2 | 5 | 2 | src/backend/vcc-financial-op/mutation-guard.js(3), src/backend/vcc-financial-op/mutation-policy.js(2) |
| `LARGE_TABLE_SCOPE_PROOF_TABLES` | 2 | 5 | 1 | src/backend/vcc-financial-op/mutation-policy.js(3), src/backend/vcc-financial-op/mutation-guard.js(2) |
| `LEGACY_DATASET_TYPES` | 2 | 5 | 1 | src/backend/vcc-financial-op/archive-contract.js(3), src/backend/vcc-financial-op/result-write.js(2) |
| `listImportedDates` | 2 | 5 | 1 | src/main-process/biz-op-recon-run-data.js(3), src/backend/biz-op-recon-db/flow-imports-repository.js(2) |
| `listMonthsDualSource` | 2 | 5 | 2 | src/main-process/bank-bu-recon-run-data.js(3), src/main-process/acquiring-bill-currency-run-data.js(2) |
| `loadResultMutationEvidence` | 2 | 5 | 1 | src/backend/vcc-financial-op/read-snapshot.js(3), src/backend/vcc-financial-op/result-write.js(2) |
| `loadToolboxSharedStrings` | 2 | 5 | 1 | src/backend/toolbox-format/xlsx-pass.js(3), src/backend/position-reconciliation-import/shared-strings-provider.js(2) |
| `loadUnarchiveGateEvidence` | 2 | 5 | 1 | src/backend/vcc-financial-op/read-snapshot.js(3), src/backend/vcc-financial-op/destructive-write.js(2) |
| `MAINTENANCE_COMMANDS` | 2 | 5 | 1 | src/backend/position-reconciliation-import/maintenance-writer.js(3), src/backend/position-reconciliation-import/worker-entry.js(2) |
| `makeInvalidExtraFeeWarningDeduper` | 2 | 5 | 1 | src/main-process/scenario-engines/r5-fund-transfer-backfill.js(3), src/main-process/scenario-engines/r5-fund-transfer-recon-backfill.js(2) |
| `MIN_NEW_ACCOUNT_GENERATION_MEMORY_BYTES` | 2 | 5 | 2 | src/main-process/new-account/resource-estimator.js(3), src/main-process/new-account/policies.js(2) |
| `moveFileNoClobber` | 2 | 5 | 1 | src/main-process/pre-fund-reconciliation/excel-writer.js(3), src/main-process/pre-fund-reconciliation/service.js(2) |
| `MPT_SPOOL_MAX_NDJSON_LINE_BYTES` | 2 | 5 | 1 | src/main-process/pre-fund-reconciliation/mpt-import/spool-reader.js(3), src/main-process/pre-fund-reconciliation/mpt-import/spool-contract.js(2) |
| `MUTATION_SQL_STEP_REGISTRY` | 2 | 5 | 1 | src/backend/vcc-financial-op/mutation-guard.js(3), src/backend/vcc-financial-op/mutation-policy.js(2) |
| `NEW_ACCOUNT_GENERATION_POLICY` | 2 | 5 | 1 | src/main-process/background-execution/runtime.js(3), src/main-process/new-account/policies.js(2) |
| `normalizeAdjustmentAmount` | 2 | 5 | 1 | src/backend/vcc-financial-op/result-adjustments.js(3), src/backend/vcc-financial-op/result-write.js(2) |
| `normalizeAdjustmentReason` | 2 | 5 | 1 | src/backend/vcc-financial-op/result-adjustments.js(3), src/backend/vcc-financial-op/result-write.js(2) |
| `normalizeAlignment` | 2 | 5 | 2 | src/backend/toolbox-format/style-registry.js(3), src/backend/toolbox-format/biff8-overlay.js(2) |
| `normalizeDirection` | 2 | 5 | 1 | src/main-process/vcc-op-calc/parser-core.js(3), src/main-process/vcc-op-calc-session.js(2) |
| `normalizeDuplicateStartupGateDescriptor` | 2 | 5 | 1 | src/main-process/duplicate-inbound-match/startup-gate.js(3), src/main-process/background-execution/runtime.js(2) |
| `normalizeJpmIntentEvidence` | 2 | 5 | 2 | src/main-process/recon-id-fix-service/jpm-outcome-inspector.js(3), src/main-process/recon-id-fix-service/jpm-worker-durable-coordinator.js(2) |
| `normalizeLineageIntentsV1` | 2 | 5 | 2 | src/main-process/archive-center/task-lifecycle.js(3), src/main-process/archive-center/task-lineage.js(2) |
| `normalizeNewAccountCurrencyValues` | 2 | 5 | 1 | src/main-process/new-account/generation-core.js(3), src/main-process/new-account/generation-validator.js(2) |
| `normalizeOperationOwner` | 2 | 5 | 1 | src/main-process/vcc-op-calc/save-run-contract.js(3), src/main-process/vcc-op-calc/save-run-lifecycle.js(2) |
| `normalizeTaskStagingIdentity` | 2 | 5 | 1 | src/main-process/vcc-financial-op-output/staging-identity.js(3), src/main-process/vcc-financial-op-output/writer-core.js(2) |
| `normalizeWriterInput` | 2 | 5 | 2 | src/main-process/vcc-financial-op-output/writer-core.js(3), src/main-process/vcc-financial-op-output/writer-coordinator.js(2) |
| `openPositionWorkbook` | 2 | 5 | 1 | src/backend/position-reconciliation-import/xlsx-reader.js(3), src/main-process/position-reconciliation/filtered-source-report.js(2) |
| `operationSource` | 2 | 5 | 1 | src/main-process/duplicate-inbound-match/startup-recovery.js(3), src/main-process/duplicate-inbound-match/startup-gate.js(2) |
| `OUTBOUND_FIELDS` | 2 | 5 | 1 | src/main-process/pre-fund-reconciliation/mpt-schema.js(3), src/main-process/pre-fund-reconciliation/mpt-error-report-writer.js(2) |
| `OutputStyleRegistry` | 2 | 5 | 1 | src/main-process/toolbox-output-writer.js(3), src/backend/toolbox-format/style-registry.js(2) |
| `parseAdmRawJsonText` | 2 | 5 | 1 | src/backend/database/linked-table-writeback-reader.js(3), src/main-process/recon-id-fix-service/jpm-writeback-plan.js(2) |
| `parseAmountAbs` | 2 | 5 | 2 | src/backend/acquiring-bill-currency-db/import-repository.js(3), src/backend/acquiring-bill-currency-import/contract-flow.js(2) |
| `parseOoxmlWallClock` | 2 | 5 | 1 | src/backend/toolbox-format/number-date.js(3), src/backend/toolbox-format/xlsx-sheet-scanner.js(2) |
| `PARSER_RESOURCES` | 2 | 5 | 1 | src/main-process/pre-fund-reconciliation/mpt-import/policies.js(3), src/main-process/pre-fund-reconciliation/mpt-import/topology.js(2) |
| `peekImportTarget` | 2 | 5 | 2 | src/main-process/acquiring-bill-currency-run-data.js(3), src/main-process/acquiring-bill-currency-session.js(2) |
| `PENDING_DB_FILENAME` | 2 | 5 | 2 | src/backend/pending-db.js(3), src/main.js(2) |
| `PENDING_HASH_VERSION` | 2 | 5 | 1 | src/backend/vcc-financial-op/row-mapper.js(3), src/main-process/vcc-financial-op-dataset-writer.js(2) |
| `PENDING_INSERT_SQL` | 2 | 5 | 2 | src/backend/pending-import/contract-pending.js(3), src/backend/bank-bu-recon-db/month-repository.js(2) |
| `PENDING_SHEET_NAME` | 2 | 5 | 1 | src/main-process/vcc-financial-op-output/artifact-evidence.js(4), src/main-process/vcc-financial-op-writer.js(1) |
| `pendingHeaderCandidate` | 2 | 5 | 1 | src/backend/vcc-financial-op/workbook-reader.js(3), src/backend/vcc-financial-op/pending-template-contract.js(2) |
| `pendingMonthEvidenceValue` | 2 | 5 | 1 | src/main.js(3), src/main-process/pending-import-preflight.js(2) |
| `persistRolledBackAuditSafely` | 2 | 5 | 1 | src/backend/vcc-financial-op/result-write.js(3), src/backend/vcc-financial-op/destructive-write.js(2) |
| `pickBankFields` | 2 | 5 | 1 | src/main-process/duplicate-inbound-match/import-model.js(3), src/main-process/duplicate-inbound-match/service.js(2) |
| `POSITION_IMPORT_MAX_ERROR_DETAILS` | 2 | 5 | 1 | src/backend/position-reconciliation-import/ledger.js(3), src/backend/position-reconciliation-import/constants.js(2) |
| `POSITION_RULESET_VERSION` | 2 | 5 | 1 | src/main-process/position-reconciliation/store.js(3), src/main-process/position-reconciliation/constants.js(2) |
| `POSITION_SOURCE_SUMMARY_SCHEMA` | 2 | 5 | 1 | src/main-process/position-reconciliation/source-summary-cache.js(3), src/main-process/position-reconciliation/store.js(2) |
| `positionRecoveryTerminalOutcome` | 2 | 5 | 1 | src/main-process/position-reconciliation/operation-lifecycle.js(4), src/main.js(1) |
| `positiveSafeInteger` | 2 | 5 | 2 | src/main-process/background-execution/resource-budget.js(3), src/main-process/background-execution/critical/recovery-control-read-repository.js(2) |
| `preflightRequiredResult` | 2 | 5 | 1 | src/backend/vcc-financial-op/calculator.js(3), src/main-process/vcc-financial-op-service.js(2) |
| `PreFundReconciliationStore` | 2 | 5 | 2 | src/backend/pre-fund-reconciliation-store.js(3), src/main-process/pre-fund-reconciliation/mpt-import/writer-worker-entry.js(2) |
| `PROGRESS_INTERVAL` | 2 | 5 | 2 | src/main-process/pre-fund-reconciliation/service.js(3), src/backend/vcc-op-calc-import/reader.js(2) |
| `projectNewAccountGenerationShape` | 2 | 5 | 1 | src/main-process/new-account/generation-contract.js(3), src/main-process/new-account/resource-estimator.js(2) |
| `projectOutputCell` | 2 | 5 | 1 | src/main-process/toolbox-output-writer.js(3), src/backend/toolbox-format/model.js(2) |
| `readBankBuParserOutcome` | 2 | 5 | 2 | src/main-process/bank-bu-worker/parser-outcome.js(3), src/main-process/bank-bu-worker/spool-reader.js(2) |
| `readBankSource` | 2 | 5 | 1 | src/main-process/fund-recon-worker/service.js(3), src/main-process/fund-recon-worker/source-readers.js(2) |
| `readBizOpSourceSnapshot` | 2 | 5 | 1 | src/main-process/read-only-exports/biz-op/query.js(3), src/main-process/read-only-exports/biz-op/writer.js(2) |
| `readGatewaySource` | 2 | 5 | 1 | src/main-process/fund-recon-worker/service.js(3), src/main-process/fund-recon-worker/source-readers.js(2) |
| `readPendingMonthEvidence` | 2 | 5 | 1 | src/main-process/pending-import-preflight.js(3), src/main.js(2) |
| `readPositionSourceSnapshotFromStore` | 2 | 5 | 1 | src/main-process/read-only-exports/position/query.js(3), src/main-process/read-only-exports/position/writer.js(2) |
| `readPreFundSourceSnapshotFromDatabases` | 2 | 5 | 1 | src/main-process/read-only-exports/pre-fund/query.js(3), src/main-process/read-only-exports/pre-fund/writer.js(2) |
| `readRefundSource` | 2 | 5 | 1 | src/main-process/fund-recon-worker/service.js(3), src/main-process/fund-recon-worker/source-readers.js(2) |
| `readRegenerateEvidenceFromDb` | 2 | 5 | 2 | src/main-process/read-only-exports/acquiring/query.js(3), src/main-process/read-only-exports/acquiring/executor.js(2) |
| `readVccDatasetSourceSnapshotFromDb` | 2 | 5 | 1 | src/main-process/read-only-exports/vcc-financial-op/query.js(3), src/main-process/read-only-exports/vcc-financial-op/writer.js(2) |
| `readVccExportWorkerSnapshot` | 2 | 5 | 1 | src/main-process/vcc-financial-op-output/writer-core.js(3), src/main-process/vcc-financial-op-output/authority.js(2) |
| `readVccImportAuditSourceSnapshotFromDb` | 2 | 5 | 1 | src/main-process/read-only-exports/vcc-financial-op/query.js(3), src/main-process/read-only-exports/vcc-financial-op/writer.js(2) |
| `RECON_FIX_EVIDENCE_MAX_BYTES` | 2 | 5 | 1 | src/main-process/recon-id-fix-service/evidence-projection.js(3), src/backend/database/linked-table-writeback-reader.js(2) |
| `reconAmountAbs` | 2 | 5 | 2 | src/main-process/scenario-engines/r5-fund-transfer-recon-backfill.js(3), src/main-process/scenario-engines/many-to-many-detector.js(2) |
| `reconcileVccImportArchiveLineage` | 2 | 5 | 1 | src/main-process/vcc-financial-op-archive-lineage.js(3), src/main-process/vcc-financial-op-service.js(2) |
| `ReconFixJpmWritebackError` | 2 | 5 | 1 | src/main-process/recon-id-fix-service/jpm-writeback-plan.js(3), src/main-process/recon-id-fix-service/jpm-writeback-transaction.js(2) |
| `reconIdFixResult` | 2 | 5 | 1 | src/renderer.js(4), src/main.js(1) |
| `redactedFailure` | 2 | 5 | 1 | src/backend/vcc-financial-op/result-write.js(3), src/backend/vcc-financial-op/destructive-write.js(2) |
| `releaseResourceWhenUnreferenced` | 2 | 5 | 2 | src/main-process/background-execution/service-host.js(3), src/main-process/background-execution/resource-governor.js(2) |
| `REPORT_ARTIFACT_KEY` | 2 | 5 | 1 | src/backend/position-reconciliation-import/anomaly-report.js(3), src/backend/position-reconciliation-import/preflight.js(2) |
| `resolveOperationInputPaths` | 2 | 5 | 1 | src/main-process/archive-center/operation-tracker.js(4), src/main.js(1) |
| `ROUND_LABELS` | 2 | 5 | 1 | src/renderer.js(3), src/main-process/reconciliation-orchestrator.js(2) |
| `roundReservationBytes` | 2 | 5 | 1 | src/main-process/fund-recon-worker/state-footprint.js(3), src/main-process/duplicate-inbound-match/state-footprint.js(2) |
| `ROUTE_DB_MANIFEST_VERSION` | 2 | 5 | 1 | src/main-process/toolbox-background/route-db-contract.js(3), src/main-process/toolbox-background/route-db-sealer.js(2) |
| `rowColumns` | 2 | 5 | 1 | src/main-process/vcc-financial-op-storage-rebuild.js(3), src/main-process/bank-bu-worker/spool-writer.js(2) |
| `runC2Scenario` | 2 | 5 | 2 | src/main-process/scenario-engines/index.js(3), src/main-process/scenario-engines/c2-offset-bill-mark.js(2) |
| `runC3Scenario` | 2 | 5 | 2 | src/main-process/scenario-engines/index.js(3), src/main-process/scenario-engines/c3-gateway-recon-join.js(2) |
| `runEnvelope` | 2 | 5 | 2 | src/main-process/read-only-exports/position/query.js(3), src/main-process/read-only-exports/pre-fund/query.js(2) |
| `runJob` | 2 | 5 | 2 | src/main-process/recon-id-fix-service/worker-entry.js(3), src/backend/position-reconciliation-import/worker-entry.js(2) |
| `runScenario` | 2 | 5 | 2 | src/main-process/scenario-dispatcher.js(3), src/main-process/scenario-engines/index.js(2) |
| `sameFileIdentity` | 2 | 5 | 2 | src/main-process/recon-id-fix-service/service.js(3), src/main-process/toolbox-output-publication.js(2) |
| `samePostImage` | 2 | 5 | 1 | src/main-process/bank-bu-worker/mirror-repository.js(3), src/main-process/bank-bu-worker/outcome-inspector.js(2) |
| `samePreimage` | 2 | 5 | 1 | src/main-process/bank-bu-worker/mirror-repository.js(3), src/main-process/bank-bu-worker/outcome-inspector.js(2) |
| `setExportAvailability` | 2 | 5 | 1 | src/renderer.js(4), src/renderer-previews.js(1) |
| `setNewAccountOpenDateValue` | 2 | 5 | 1 | src/renderer.js(3), src/renderer-previews.js(2) |
| `setVccStorageContractVersion` | 2 | 5 | 1 | src/backend/vcc-financial-op-db/storage-contract.js(3), src/main-process/vcc-financial-op-storage-rebuild.js(2) |
| `sha256Text` | 2 | 5 | 2 | src/main-process/statement-worker/source-identity.js(3), src/main-process/pre-fund-reconciliation/mpt-import/spool-contract.js(2) |
| `SIDE_DB_DDL_BIZ_OP` | 2 | 5 | 1 | src/backend/run-data-store.js(3), src/main-process/biz-op-recon-run-data.js(2) |
| `SIDE_DB_DDL_PRE_FUND_RUNS` | 2 | 5 | 1 | src/backend/run-data-store.js(4), src/backend/pre-fund-reconciliation-run-store.js(1) |
| `SIDE_DB_FAMILY_RE` | 2 | 5 | 2 | src/main-process/duplicate-inbound-match/startup-recovery.js(3), src/backend/duplicate-inbound-match-store.js(2) |
| `sideDbFileName` | 2 | 5 | 1 | src/backend/run-data-store.js(4), src/backend/pre-fund-reconciliation-store.js(1) |
| `SOURCE_DISPLAY_ORDER` | 2 | 5 | 1 | src/main-process/position-reconciliation/store.js(3), src/main-process/position-reconciliation/constants.js(2) |
| `SOURCE_FILTER_CODES` | 2 | 5 | 1 | src/main-process/position-reconciliation/readers.js(3), src/main-process/position-reconciliation/constants.js(2) |
| `SOURCE_TYPE_BY_FUND_TYPE` | 2 | 5 | 1 | src/main-process/position-reconciliation/constants.js(3), src/main-process/position-reconciliation/service.js(2) |
| `splitUtf16Safe` | 2 | 5 | 2 | src/main-process/pre-fund-reconciliation/output-mapper.js(3), src/main-process/pre-fund-reconciliation/mpt-error-report-writer.js(2) |
| `storedRecordResult` | 2 | 5 | 1 | src/backend/vcc-financial-op/import-service.js(3), src/main-process/vcc-financial-op-service.js(2) |
| `streamBizOpFile` | 2 | 5 | 2 | src/backend/biz-op-recon-import/reader-streamed.js(3), src/backend/biz-op-recon-import/import-worker.js(2) |
| `systemHeaderCandidate` | 2 | 5 | 1 | src/backend/vcc-financial-op/workbook-reader.js(3), src/backend/vcc-financial-op/system-op-importer.js(2) |
| `systemHeaderMismatchDetails` | 2 | 5 | 1 | src/backend/vcc-financial-op/workbook-reader.js(3), src/backend/vcc-financial-op/system-op-importer.js(2) |
| `TASK_FILE_PLAN_DEFINITIONS` | 2 | 5 | 1 | src/main-process/archive-center/task-file-plan-registry.js(3), src/main-process/archive-center/task-policy-registry.js(2) |
| `TEMPLATE_BILL_KEY_INDICES` | 2 | 5 | 2 | src/backend/acquiring-bill-currency-import/contract-bill.js(3), src/backend/acquiring-bill-currency-db/import-repository.js(2) |
| `templateIdentity` | 2 | 5 | 2 | src/main-process/statement-worker/import-contracts.js(3), src/main-process/statement-worker/contracts.js(2) |
| `TERMINAL_TASK_STATUSES` | 2 | 5 | 2 | src/main-process/archive-center/task-lifecycle.js(3), src/main-process/archive-center/controller.js(2) |
| `terminalPayload` | 2 | 5 | 2 | src/main-process/duplicate-inbound-match/parser-outcome.js(3), src/main-process/bank-bu-worker/parser-outcome.js(2) |
| `timerSafeDuration` | 2 | 5 | 1 | src/main-process/background-execution/supervisor.js(3), src/main-process/background-execution/external-parser-finalization.js(2) |
| `toolboxRecoveryOutputFiles` | 2 | 5 | 1 | src/main-process/toolbox-archive-recovery.js(4), src/main.js(1) |
| `ToolboxSheetReadError` | 2 | 5 | 1 | src/backend/toolbox-xlsx-stream/multi-sheet-reader.js(3), src/main-process/toolbox-merge-io.js(2) |
| `ToolboxSplitFieldNotFoundError` | 2 | 5 | 1 | src/main-process/toolbox-format-operations.js(3), src/backend/toolbox-xlsx-stream/split-export-filter.js(2) |
| `UNBALANCED_HEADERS` | 2 | 5 | 1 | src/main-process/pre-fund-reconciliation/excel-writer.js(3), src/main-process/pre-fund-reconciliation/output-mapper.js(2) |
| `unwrapBankEntry` | 2 | 5 | 2 | src/main-process/pre-fund-reconciliation/matching-engine.js(3), src/main-process/duplicate-inbound-match/matching-engine.js(2) |
| `updateNewAccountGenerateAvailability` | 2 | 5 | 1 | src/renderer.js(3), src/renderer-previews.js(2) |
| `validateAcquiringImportAdapterResult` | 2 | 5 | 1 | src/main-process/background-execution/acquiring-adapter-policies.js(3), src/main-process/background-execution/runtime.js(2) |
| `validateBizIds` | 2 | 5 | 1 | src/main-process/duplicate-inbound-match/import-model.js(3), src/main-process/duplicate-inbound-match/service.js(2) |
| `validateDirection` | 2 | 5 | 1 | src/main-process/position-reconciliation/decimal.js(3), src/main-process/position-reconciliation/matching-engine.js(2) |
| `validateManifestItem` | 2 | 5 | 1 | src/main-process/statement-worker/generation-contracts.js(3), src/main-process/statement-worker/contracts.js(2) |
| `validatePositionImportAdapterProgress` | 2 | 5 | 1 | src/main-process/background-execution/position-import-adapter-policy.js(3), src/main-process/background-execution/adapters/position-import-adapter.js(2) |
| `validatePreFundMptImportResult` | 2 | 5 | 1 | src/main-process/pre-fund-reconciliation/mpt-import/policies.js(3), src/main-process/background-execution/runtime.js(2) |
| `validatePreFundMptRepairResult` | 2 | 5 | 1 | src/main-process/pre-fund-reconciliation/mpt-import/policies.js(3), src/main-process/background-execution/runtime.js(2) |
| `validateSafeErrorV1` | 2 | 5 | 1 | src/main-process/background-execution/error-codec.js(3), src/main-process/background-execution/protocol-validator.js(2) |
| `valuesFromToolboxRow` | 2 | 5 | 1 | src/backend/position-reconciliation-import/xlsx-reader.js(3), src/main-process/position-reconciliation/filtered-source-report.js(2) |
| `VCC_CURRENCY_DB_COLUMN` | 2 | 5 | 1 | src/main-process/vcc-op-calc/parser-core.js(3), src/backend/vcc-op-calc-db/columns.js(2) |
| `vccStorageGuardTriggerDefinition` | 2 | 5 | 1 | src/backend/vcc-financial-op-db/storage-contract.js(3), src/backend/vcc-financial-op/mutation-guard.js(2) |
| `WORKER_ERROR_MARKER` | 2 | 5 | 2 | src/main-process/vcc-op-calc/parser-worker.js(3), src/main-process/vcc-op-calc/parser-pipeline.js(2) |
| `writeBankBuParserFailure` | 2 | 5 | 1 | src/main-process/bank-bu-worker/dual-parser-dispatch.js(3), src/main-process/bank-bu-worker/parser-outcome.js(2) |
| `writeChannelWorkbook` | 2 | 5 | 2 | src/main-process/pre-fund-reconciliation/excel-writer.js(3), src/main-process/read-only-exports/pre-fund/writer.js(2) |
| `writeParserOutcome` | 2 | 5 | 2 | src/main-process/pre-fund-reconciliation/mpt-import/managed-import.js(3), src/main-process/pre-fund-reconciliation/mpt-import/parser-outcome.js(2) |
| `XLSXStyle` | 2 | 5 | 2 | src/main-process/recon-id-fix-service/artifact-evidence.js(4), src/main-process/recon-id-fix-io.js(1) |
| `zeroResourceVector` | 2 | 5 | 1 | src/main-process/background-execution/resource-lease.js(3), src/main-process/background-execution/resource-governor.js(2) |
| `__reconCols` | 2 | 4 | 2 | src/constants/fund-transfer-recon-fields.js(2), src/constants/payment-offline-allocation-fields.js(2) |
| `ABSENT_MIRROR_DIGEST` | 2 | 4 | 2 | src/main-process/bank-bu-worker/identity.js(2), src/main-process/bank-bu-worker/mirror-repository.js(2) |
| `acknowledgePendingRunByTaskRun` | 2 | 4 | 1 | src/main-process/pending-archive-lineage.js(3), src/main.js(1) |
| `ACQUIRING_EXPORT_POLICIES` | 2 | 4 | 1 | src/main-process/background-execution/runtime.js(2), src/main-process/read-only-exports/acquiring/policies.js(2) |
| `acquiringRunData` | 2 | 4 | 2 | src/main-process/read-only-exports/acquiring/query.js(3), src/main.js(1) |
| `ADJUSTMENT_LINEAGE_NAME_PREFIX` | 2 | 4 | 1 | src/backend/vcc-financial-op/adjustment-lineage.js(3), src/main-process/vcc-financial-op-writer.js(1) |
| `ADM_EXTRA_FIELDS` | 2 | 4 | 1 | src/constants/adm-bank-deposit-fields.js(2), src/main-process/adm-bank-deposit-builder.js(2) |
| `ADM_FUND_TYPES` | 2 | 4 | 1 | src/constants/adm-bank-deposit-fields.js(2), src/main-process/adm-bank-deposit-builder.js(2) |
| `ADM_MERCHANT_ID` | 2 | 4 | 2 | src/backend/database/migrations.js(2), src/constants/adm-bank-deposit-fields.js(2) |
| `applyApplicableChannelIdsInTx` | 2 | 4 | 1 | src/backend/database/scenarios-repository.js(3), src/backend/database.js(1) |
| `applyPositionAccountSnapshot` | 2 | 4 | 1 | src/backend/position-reconciliation-import/account-writer.js(2), src/backend/position-reconciliation-import/worker-entry.js(2) |
| `applyPositionBankBatch` | 2 | 4 | 1 | src/backend/position-reconciliation-import/bank-writer.js(2), src/backend/position-reconciliation-import/worker-entry.js(2) |
| `applyPositionOrdinarySourceFiles` | 2 | 4 | 1 | src/backend/position-reconciliation-import/source-writer.js(2), src/backend/position-reconciliation-import/worker-entry.js(2) |
| `APPROVED_VCC_TRIGGERS` | 2 | 4 | 1 | src/backend/vcc-financial-op/mutation-guard.js(2), src/backend/vcc-financial-op/mutation-policy.js(2) |
| `ARRAY_OVERHEAD_BYTES` | 2 | 4 | 2 | src/main-process/fund-recon-worker/state-footprint.js(2), src/main-process/statement-worker/state-footprint.js(2) |
| `assertAcquiringCopySourceFresh` | 2 | 4 | 1 | src/main-process/read-only-exports/acquiring/query.js(2), src/main.js(2) |
| `assertBiff8OverlayMatchesProjection` | 2 | 4 | 1 | src/backend/toolbox-format/biff8-overlay.js(2), src/backend/toolbox-format/biff8-pass.js(2) |
| `assertBizOpMonthEndAdmission` | 2 | 4 | 1 | src/backend/biz-op-recon-import/import-worker.js(2), src/main-process/biz-op-recon-session.js(2) |
| `assertMptSpoolDiskCapacity` | 2 | 4 | 2 | src/main-process/pre-fund-reconciliation/mpt-import/managed-import.js(2), src/main-process/pre-fund-reconciliation/mpt-import/spool-admission.js(2) |
| `assertNewAccountExpectedArtifactAuthority` | 2 | 4 | 1 | src/main-process/new-account/artifact-copy.js(2), src/main-process/new-account/generation-validator.js(2) |
| `assertNoPendingMonthEndCopy` | 2 | 4 | 1 | src/backend/biz-op-recon-import/import-worker.js(2), src/main-process/biz-op-recon-session.js(2) |
| `assertRunResumeFresh` | 2 | 4 | 1 | src/main-process/acquiring-bill-currency-run-data.js(2), src/main-process/background-execution/adapters/acquiring-adapter.js(2) |
| `assertSourceGroupEvidence` | 2 | 4 | 1 | src/main-process/read-only-exports/biz-op/query.js(2), src/main-process/read-only-exports/biz-op/writer.js(2) |
| `assertVccExportWorkerSnapshotEqual` | 2 | 4 | 1 | src/main-process/vcc-financial-op-output/authority.js(2), src/main-process/vcc-financial-op-output/writer-core.js(2) |
| `atomicSwitchVccStorage` | 2 | 4 | 1 | src/main-process/vcc-financial-op-storage-migration.js(2), src/main-process/vcc-financial-op-storage-rebuild.js(2) |
| `BANK_BU_SPOOL_MAX_MANIFEST_BYTES` | 2 | 4 | 1 | src/main-process/bank-bu-worker/spool-contract.js(2), src/main-process/bank-bu-worker/spool-reader.js(2) |
| `BANK_BU_SPOOL_MAX_NDJSON_LINE_BYTES` | 2 | 4 | 1 | src/main-process/bank-bu-worker/spool-contract.js(2), src/main-process/bank-bu-worker/spool-reader.js(2) |
| `BANK_DEPOSIT_SIGNATURE` | 2 | 4 | 1 | src/constants/table-signatures.js(3), src/main.js(1) |
| `BANK_IDENTIFIER_FIELDS` | 2 | 4 | 1 | src/main-process/position-reconciliation/contracts.js(2), src/main-process/position-reconciliation/matching-engine.js(2) |
| `BANK_MATCH_KEY_DB_COLUMN` | 2 | 4 | 1 | src/backend/bank-bu-recon-db/columns.js(2), src/main-process/bank-bu-recon-session.js(2) |
| `BANK_MERCHANT_ID_FIELD` | 2 | 4 | 2 | src/main-process/scenario-engines/dbs-charge-fund-check.js(2), src/main-process/scenario-engines/r4-fund-nature-check.js(2) |
| `bankAmountEqualWithoutExtraFee` | 2 | 4 | 1 | src/main-process/scenario-engines/dbs-charge-fund-check.js(2), src/main-process/scenario-engines/r5-fund-transfer-backfill.js(2) |
| `BankStatementMergeError` | 2 | 4 | 1 | src/main-process/bank-statement-merge.js(3), src/main.js(1) |
| `baseMappedRow` | 2 | 4 | 1 | src/backend/file-service.js(2), src/backend/vcc-financial-op/row-mapper.js(2) |
| `bindingSnapshot` | 2 | 4 | 1 | src/main-process/background-execution/action-task-binding-registry.js(2), src/main-process/background-execution/index.js(2) |
| `BIZ_OP_READ_ONLY_POLICIES` | 2 | 4 | 1 | src/main-process/background-execution/runtime.js(2), src/main-process/read-only-exports/biz-op/policies.js(2) |
| `BIZ_OP_RUN_TASK_KEY` | 2 | 4 | 1 | src/main-process/biz-op-archive-lineage.js(2), src/main-process/biz-op-recon-run-data.js(2) |
| `bizOpRunLineagePlan` | 2 | 4 | 1 | src/main-process/biz-op-archive-lineage.js(2), src/main-process/biz-op-recon-run-data.js(2) |
| `BOC_CHANNEL_NAME` | 2 | 4 | 2 | src/constants/boc-dispatch-order-fields.js(2), src/main-process/scenario-engines/boc-dispatch-order-fix.js(2) |
| `BOC_CHANNEL_VALUE` | 2 | 4 | 2 | src/constants/boc-fx-link-fields.js(2), src/main-process/boc-fx-link-builder.js(2) |
| `boundedJpmReceiptFromExact` | 2 | 4 | 1 | src/main-process/recon-id-fix-service/jpm-receipt-evidence.js(2), src/main-process/recon-id-fix-service/service.js(2) |
| `buildArchiveEvidenceV2` | 2 | 4 | 2 | src/backend/vcc-financial-op/archive-evidence.js(2), src/backend/vcc-financial-op/read-snapshot.js(2) |
| `buildBigAccountInteractionDraft` | 2 | 4 | 1 | src/main-process/statement-worker/service.js(2), src/main-process/statement-worker/session-state.js(2) |
| `buildDuplicateInboundGroups` | 2 | 4 | 1 | src/main-process/duplicate-inbound-match/matching-engine.js(2), src/main-process/duplicate-inbound-match/service.js(2) |
| `buildFailureAuditPlan` | 2 | 4 | 2 | src/backend/vcc-financial-op/destructive-write.js(2), src/backend/vcc-financial-op/result-write.js(2) |
| `buildJpmWritebackPlan` | 2 | 4 | 1 | src/main-process/recon-id-fix-service/jpm-writeback-plan.js(2), src/main-process/recon-id-fix-service/service.js(2) |
| `buildLogicalAccounts` | 2 | 4 | 1 | src/main-process/position-reconciliation/logical-accounts.js(2), src/main-process/position-reconciliation/matching-engine.js(2) |
| `buildOriginalBaseName` | 2 | 4 | 1 | src/main-process/scenario-hit-rows-writer.js(3), src/main.js(1) |
| `buildVccStorageCandidate` | 2 | 4 | 1 | src/main-process/vcc-financial-op-storage-migration-worker.js(2), src/main-process/vcc-financial-op-storage-rebuild.js(2) |
| `BUSINESS_BILL_SHEET_NAME` | 2 | 4 | 1 | src/constants/recon-id-fix-fields.js(2), src/main-process/recon-id-fix-io.js(2) |
| `calculateMonth` | 2 | 4 | 2 | src/backend/vcc-financial-op/calculator.js(2), src/backend/vcc-financial-op/worker-entry.js(2) |
| `cancelError` | 2 | 4 | 2 | src/backend/position-reconciliation-import/maintenance-writer.js(2), src/backend/position-reconciliation-import/source-writer.js(2) |
| `capabilityInventory` | 2 | 4 | 1 | src/main-process/background-execution/index.js(2), src/main-process/background-execution/production-strategy-snapshot.js(2) |
| `captureProvisionalTaskStagingIdentity` | 2 | 4 | 1 | src/main-process/vcc-financial-op-output/dispatch.js(2), src/main-process/vcc-financial-op-output/staging-identity.js(2) |
| `CHANNEL_BILL_SHEET_NAME` | 2 | 4 | 1 | src/constants/gateway-bill-recon-fields.js(2), src/main-process/recon-id-fix-io.js(2) |
| `claimVccFinancialOpFirstMonth` | 2 | 4 | 1 | src/backend/vcc-financial-op-db/repository.js(2), src/backend/vcc-financial-op/calculator.js(2) |
| `CLEANUP_COPY_HEADERS` | 2 | 4 | 2 | src/constants/platform-cleanup-template-fields.js(2), src/main-process/scenario-engines/r5-platform-inbound-cleanup.js(2) |
| `cleanupBankBuSpoolParents` | 2 | 4 | 1 | src/main-process/bank-bu-worker/dual-parser-dispatch.js(2), src/main-process/bank-bu-worker/spool-filesystem.js(2) |
| `cleanupDuplicateSpoolParents` | 2 | 4 | 1 | src/main-process/duplicate-inbound-match/paired-parser-dispatch.js(2), src/main-process/duplicate-inbound-match/spool-filesystem.js(2) |
| `cleanupKnownFiles` | 2 | 4 | 2 | src/main-process/duplicate-inbound-match/spool-filesystem.js(2), src/main-process/pre-fund-reconciliation/mpt-import/spool-writer.js(2) |
| `cleanupSpools` | 2 | 4 | 2 | src/main-process/bank-bu-worker/dual-parser-dispatch.js(2), src/main-process/duplicate-inbound-match/paired-parser-dispatch.js(2) |
| `clearBankDepositHitMarkersByBizIds` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/linked-table-repository.js(2) |
| `clearDiffRowsByRunId` | 2 | 4 | 1 | src/backend/acquiring-bill-currency-db/run-repository.js(3), src/main-process/acquiring-bill-currency-session.js(1) |
| `closeAllNewAccountCurrencyDropdowns` | 2 | 4 | 1 | src/renderer.js(3), src/renderer-previews.js(1) |
| `closeResourceGovernor` | 2 | 4 | 2 | src/main-process/background-execution/resource-governor.js(2), src/main-process/background-execution/supervisor.js(2) |
| `closeWorkbookOutputStream` | 2 | 4 | 2 | src/main-process/toolbox-output-writer.js(2), src/main-process/toolbox-stream-io.js(2) |
| `commitJpmAdmMutationWithReceipt` | 2 | 4 | 1 | src/main-process/recon-id-fix-service/jpm-writeback-transaction.js(2), src/main-process/recon-id-fix-service/service.js(2) |
| `commitRun` | 2 | 4 | 1 | src/main-process/bank-bu-worker/run-operation.js(2), src/main-process/bank-bu-worker/side-database.js(2) |
| `compareFileSequences` | 2 | 4 | 1 | src/backend/pre-fund-reconciliation-store.js(2), src/main-process/pre-fund-reconciliation/mpt-schema.js(2) |
| `completeMirrorFromCommittedSide` | 2 | 4 | 1 | src/main-process/bank-bu-worker/main-coordinator.js(2), src/main-process/bank-bu-worker/outcome-inspector.js(2) |
| `componentMax` | 2 | 4 | 2 | src/main-process/background-execution/resource-lease.js(2), src/main-process/background-execution/service-host.js(2) |
| `computeAmounts` | 2 | 4 | 1 | src/main-process/vcc-op-calc-session.js(3), src/preload.js(1) |
| `copyVerifiedAnomalyReport` | 2 | 4 | 1 | src/main-process/position-reconciliation/filtered-source-report.js(2), src/main-process/position-reconciliation/service.js(2) |
| `countBankDepositByDateRange` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/linked-table-repository.js(2) |
| `countByMonth` | 2 | 4 | 1 | src/backend/pending-db/removed-repository.js(2), src/backend/pending-export/writer.js(2) |
| `countFxByDateRange` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/linked-table-repository.js(2) |
| `countGatewayBillByDateRange` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/linked-table-repository.js(2) |
| `countSignificantDigitsFromString` | 2 | 4 | 2 | src/backend/file-service/writers.js(2), src/main-process/toolbox-stream-io.js(2) |
| `createAcquiringMatureBindings` | 2 | 4 | 1 | src/main-process/background-execution/adapters/acquiring-adapter.js(2), src/main-process/background-execution/mature-action-adapters.js(2) |
| `createAdmissionQueue` | 2 | 4 | 1 | src/main-process/background-execution/admission-queue.js(2), src/main-process/background-execution/resource-governor.js(2) |
| `createBackgroundExecutionRuntimeManager` | 2 | 4 | 1 | src/main-process/background-execution/runtime.js(2), src/main.js(2) |
| `createBankBuReconSession` | 2 | 4 | 2 | src/main-process/bank-bu-recon-session.js(2), src/main.js(2) |
| `createBatchRecoveryOverlayAdapter` | 2 | 4 | 1 | src/main-process/background-execution/index.js(2), src/main-process/background-execution/task-lifecycle-adapter.js(2) |
| `createBoundedValuesAccumulator` | 2 | 4 | 2 | src/backend/toolbox-xlsx-stream/bounded-values-accumulator.js(2), src/main-process/toolbox-format-operations.js(2) |
| `createBusinessOperationRegistry` | 2 | 4 | 1 | src/main-process/business-operation-registry.js(2), src/main.js(2) |
| `createCanaryReceiptInspector` | 2 | 4 | 1 | src/main-process/background-execution/canary/durable-recovery.js(2), src/main-process/background-execution/canary/packaged-runtime-runner.js(2) |
| `createCancelToken` | 2 | 4 | 1 | src/main-process/acquiring-bill-currency-session.js(2), src/main-process/run-check-worker.js(2) |
| `createDuplicateInboundMatchStore` | 2 | 4 | 1 | src/backend/duplicate-inbound-match-store.js(2), src/main-process/duplicate-inbound-match/service.js(2) |
| `createDuplicateManagedService` | 2 | 4 | 2 | src/main-process/duplicate-inbound-match/managed-service.js(2), src/main-process/duplicate-inbound-match/worker-host.js(2) |
| `createDuplicateManagedStartupGate` | 2 | 4 | 2 | src/main-process/duplicate-inbound-match/managed-service.js(2), src/main-process/duplicate-inbound-match/startup-gate.js(2) |
| `createDuplicateMirrorDatabase` | 2 | 4 | 2 | src/main-process/duplicate-inbound-match/managed-service.js(2), src/main-process/duplicate-inbound-match/mirror-database.js(2) |
| `createDuplicatePairedTopologyPlanner` | 2 | 4 | 1 | src/main-process/background-execution/runtime.js(2), src/main-process/duplicate-inbound-match/topology.js(2) |
| `createExistingDispatchTransportAdapter` | 2 | 4 | 1 | src/main-process/background-execution/adapters/existing-dispatch-adapter.js(2), src/main-process/background-execution/supervisor.js(2) |
| `createFundReconArtifactGenerator` | 2 | 4 | 2 | src/main-process/fund-recon-worker/artifact-generator.js(2), src/main-process/fund-recon-worker/service.js(2) |
| `createFundReconEvidenceProvider` | 2 | 4 | 2 | src/main-process/fund-recon-worker/evidence-provider.js(2), src/main-process/fund-recon-worker/service.js(2) |
| `createFundReconService` | 2 | 4 | 2 | src/main-process/fund-recon-worker/service.js(2), src/main-process/fund-recon-worker/worker-host.js(2) |
| `createGenerationHelpers` | 2 | 4 | 2 | src/main-process/statement-generation-business.js(2), src/main-process/statement-worker/generation.js(2) |
| `createManualBalanceSeedInspector` | 2 | 4 | 1 | src/main-process/manual-balance-seed-settlement.js(3), src/main.js(1) |
| `createMatureActionAdapterBindings` | 2 | 4 | 1 | src/main-process/background-execution/mature-action-adapters.js(2), src/main-process/background-execution/runtime.js(2) |
| `createOrderedMptCoordinator` | 2 | 4 | 2 | src/main-process/pre-fund-reconciliation/mpt-import/managed-import.js(2), src/main-process/pre-fund-reconciliation/mpt-import/ordered-coordinator.js(2) |
| `createOrderedReducer` | 2 | 4 | 2 | src/main-process/vcc-op-calc/ordered-reducer.js(2), src/main-process/vcc-op-calc/parser-pipeline.js(2) |
| `createPalette` | 2 | 4 | 1 | src/backend/toolbox-format/biff8-colors.js(2), src/backend/toolbox-format/biff8-overlay.js(2) |
| `createPendingSession` | 2 | 4 | 2 | src/main-process/pending-session.js(2), src/main.js(2) |
| `createPositionImportMatureBinding` | 2 | 4 | 1 | src/main-process/background-execution/adapters/position-import-adapter.js(2), src/main-process/background-execution/mature-action-adapters.js(2) |
| `createPositionReconciliationStore` | 2 | 4 | 1 | src/main-process/position-reconciliation/service.js(2), src/main-process/position-reconciliation/store.js(2) |
| `createPreFundMptTopologyPlanner` | 2 | 4 | 1 | src/main-process/background-execution/runtime.js(2), src/main-process/pre-fund-reconciliation/mpt-import/topology.js(2) |
| `createPreFundReconciliationRunStore` | 2 | 4 | 1 | src/backend/pre-fund-reconciliation-run-store.js(2), src/main-process/pre-fund-reconciliation/service.js(2) |
| `createReconFixEvidenceSettlementAdmission` | 2 | 4 | 1 | src/main-process/background-execution/runtime.js(2), src/main-process/recon-id-fix-service/evidence-settlement-admission.js(2) |
| `createReconFixJpmDatabaseAuthority` | 2 | 4 | 1 | src/main-process/background-execution/runtime.js(2), src/main-process/recon-id-fix-service/jpm-database-authority.js(2) |
| `createReconFixService` | 2 | 4 | 2 | src/main-process/recon-id-fix-service/service.js(2), src/main-process/recon-id-fix-service/worker-entry.js(2) |
| `createRecoveryTaskLifecycleAdapter` | 2 | 4 | 1 | src/main-process/background-execution/index.js(2), src/main-process/background-execution/task-lifecycle-adapter.js(2) |
| `createRetryableSpoolCleanup` | 2 | 4 | 2 | src/main-process/bank-bu-worker/dual-parser-dispatch.js(2), src/main-process/duplicate-inbound-match/paired-parser-dispatch.js(2) |
| `createScenarioImportContextStore` | 2 | 4 | 1 | src/main-process/archive-center/scenario-import-context-store.js(2), src/main.js(2) |
| `createServiceClient` | 2 | 4 | 2 | src/main-process/background-execution/index.js(2), src/main-process/background-execution/service-client.js(2) |
| `createSingleWriterSession` | 2 | 4 | 2 | src/main-process/pre-fund-reconciliation/mpt-import/single-writer-session.js(2), src/main-process/pre-fund-reconciliation/mpt-import/writer-worker-entry.js(2) |
| `createSpools` | 2 | 4 | 2 | src/main-process/bank-bu-worker/dual-parser-dispatch.js(2), src/main-process/duplicate-inbound-match/paired-parser-dispatch.js(2) |
| `createStatementBalanceSeedOverwritePrivateContextDto` | 2 | 4 | 1 | src/main-process/statement-worker/contracts.js(2), src/main-process/statement-worker/probe-state-builder.js(2) |
| `createStatementBalanceSeedOverwritePromptDto` | 2 | 4 | 1 | src/main-process/statement-worker/contracts.js(2), src/main-process/statement-worker/probe-state-builder.js(2) |
| `createStatementBigAccountContinuationRequest` | 2 | 4 | 1 | src/main-process/statement-worker/interaction-contracts.js(2), src/main-process/statement-worker/service.js(2) |
| `createStatementCancelInteractionRequest` | 2 | 4 | 1 | src/main-process/statement-worker/interaction-contracts.js(2), src/main-process/statement-worker/service.js(2) |
| `createStatementGenerationRequest` | 2 | 4 | 2 | src/main-process/statement-worker/generation-contracts.js(2), src/main-process/statement-worker/service.js(2) |
| `createStatementInteractionPromptDto` | 2 | 4 | 1 | src/main-process/statement-worker/contracts.js(2), src/main-process/statement-worker/token-store.js(2) |
| `createStatementService` | 2 | 4 | 2 | src/main-process/statement-worker/service.js(2), src/main-process/statement-worker/worker-entry.js(2) |
| `createStatementServiceRequest` | 2 | 4 | 2 | src/main-process/statement-worker/import-contracts.js(2), src/main-process/statement-worker/service.js(2) |
| `createStatementSourceIdentityGuard` | 2 | 4 | 1 | src/main-process/statement-worker/service.js(2), src/main-process/statement-worker/source-identity.js(2) |
| `createStatementTokenStore` | 2 | 4 | 2 | src/main-process/statement-worker/service.js(2), src/main-process/statement-worker/token-store.js(2) |
| `createToolboxLargeSplitMatureBinding` | 2 | 4 | 1 | src/main-process/background-execution/mature-action-adapters.js(2), src/main-process/toolbox-large-split-dispatch.js(2) |
| `createToolboxPublicationMatureBinding` | 2 | 4 | 1 | src/main-process/background-execution/mature-action-adapters.js(2), src/main-process/toolbox-output-publication-dispatch.js(2) |
| `createVccExportTopologyPlanner` | 2 | 4 | 1 | src/main-process/background-execution/runtime.js(2), src/main-process/vcc-financial-op-output/topology.js(2) |
| `createVccFinancialOpService` | 2 | 4 | 2 | src/main-process/vcc-financial-op-service.js(2), src/main.js(2) |
| `createVccOpCalcSession` | 2 | 4 | 2 | src/main-process/vcc-op-calc-session.js(2), src/main.js(2) |
| `currentFileMatchesIdentity` | 2 | 4 | 1 | src/main-process/pre-fund-reconciliation/excel-writer.js(2), src/main-process/pre-fund-reconciliation/service.js(2) |
| `dateMismatchReason` | 2 | 4 | 2 | src/main-process/scenario-engines/r5-fund-transfer-backfill.js(2), src/main-process/scenario-engines/r5-fund-transfer-recon-backfill.js(2) |
| `daysInMonth` | 2 | 4 | 1 | src/backend/toolbox-format/number-date.js(2), src/main-process/background-execution/schema-validator.js(2) |
| `decodeHeaderPayload` | 2 | 4 | 1 | src/main-process/toolbox-background/output-writer-core.js(2), src/main-process/toolbox-background/route-db-contract.js(2) |
| `decodeRowPayload` | 2 | 4 | 1 | src/main-process/toolbox-background/output-writer-core.js(2), src/main-process/toolbox-background/route-db-contract.js(2) |
| `decodeStylePayload` | 2 | 4 | 1 | src/main-process/toolbox-background/output-writer-core.js(2), src/main-process/toolbox-background/route-db-contract.js(2) |
| `defaultIdFactory` | 2 | 4 | 2 | src/main-process/background-execution/resource-governor.js(2), src/main-process/background-execution/service-host.js(2) |
| `deleteBankDepositByDateRange` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/linked-table-repository.js(2) |
| `deleteChannel` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/channels-repository.js(2) |
| `deleteFxByDateRange` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/linked-table-repository.js(2) |
| `deleteGatewayBillByDateRange` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/linked-table-repository.js(2) |
| `deleteScenario` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/scenarios-repository.js(2) |
| `deriveLinkedRows` | 2 | 4 | 1 | src/backend/position-reconciliation-import/preflight.js(2), src/main-process/position-reconciliation/derivation.js(2) |
| `detectDistribution` | 2 | 4 | 1 | src/main-process/app-updater.js(3), src/main.js(1) |
| `detectFundTransferManyToMany` | 2 | 4 | 2 | src/main-process/reconciliation-orchestrator.js(2), src/main-process/scenario-engines/many-to-many-detector.js(2) |
| `dispatchLargeSplit` | 2 | 4 | 2 | src/main-process/toolbox-large-split-dispatch.js(3), src/main.js(1) |
| `dispatchRunCheck` | 2 | 4 | 1 | src/main-process/background-execution/adapters/acquiring-adapter.js(2), src/main-process/run-check-worker-pool.js(2) |
| `DRAWINGML_NAMESPACES` | 2 | 4 | 1 | src/backend/toolbox-format/ooxml-namespaces.js(2), src/backend/toolbox-format/style-registry.js(2) |
| `DUPLICATE_IMPORT_STARTUP_INSPECTOR_KEY` | 2 | 4 | 1 | src/main-process/duplicate-inbound-match/startup-recovery.js(3), src/main.js(1) |
| `DUPLICATE_POLICIES` | 2 | 4 | 1 | src/main-process/background-execution/runtime.js(2), src/main-process/duplicate-inbound-match/policies.js(2) |
| `DUPLICATE_SPOOL_MAX_MANIFEST_BYTES` | 2 | 4 | 1 | src/main-process/duplicate-inbound-match/spool-contract.js(2), src/main-process/duplicate-inbound-match/spool-reader.js(2) |
| `DUPLICATE_SPOOL_MAX_NDJSON_LINE_BYTES` | 2 | 4 | 1 | src/main-process/duplicate-inbound-match/spool-contract.js(2), src/main-process/duplicate-inbound-match/spool-reader.js(2) |
| `DUPLICATE_STATE_OWNER_KEY` | 2 | 4 | 1 | src/main-process/duplicate-inbound-match/policies.js(2), src/main-process/duplicate-inbound-match/worker-host.js(2) |
| `durableRecoveryPolicy` | 2 | 4 | 1 | src/main-process/background-execution/canary/index.js(2), src/main-process/background-execution/canary/packaged-runtime-runner.js(2) |
| `ensureMptSpoolDirectory` | 2 | 4 | 2 | src/main-process/pre-fund-reconciliation/mpt-import/parser-outcome.js(2), src/main-process/pre-fund-reconciliation/mpt-import/spool-writer.js(2) |
| `ensurePositionLargeImportSchemaAtPath` | 2 | 4 | 1 | src/backend/position-reconciliation-import/worker-entry.js(2), src/main-process/position-reconciliation/large-import-schema.js(2) |
| `ensureUiStyleDefault` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/settings-repository.js(2) |
| `ensureVccStorageSideTables` | 2 | 4 | 1 | src/backend/vcc-financial-op-db/migrations.js(2), src/backend/vcc-financial-op-db/storage-contract.js(2) |
| `escapeRegExp` | 2 | 4 | 2 | src/main-process/scenario-engines/r5-refund-order-backfill.js(2), src/main-process/vcc-financial-op-output/dispatch.js(2) |
| `estimateDuplicateStateFootprint` | 2 | 4 | 2 | src/main-process/duplicate-inbound-match/managed-service.js(2), src/main-process/duplicate-inbound-match/state-footprint.js(2) |
| `estimateFundReconStateFootprint` | 2 | 4 | 2 | src/main-process/fund-recon-worker/service.js(2), src/main-process/fund-recon-worker/state-footprint.js(2) |
| `estimateNewAccountGenerationPhaseResources` | 2 | 4 | 1 | src/main-process/background-execution/runtime.js(2), src/main-process/new-account/resource-estimator.js(2) |
| `estimateStatementPendingInteractionFootprint` | 2 | 4 | 1 | src/main-process/statement-worker/state-footprint.js(2), src/main-process/statement-worker/token-store.js(2) |
| `executeBizOpReadOnlyExport` | 2 | 4 | 2 | src/main-process/read-only-exports/biz-op/worker-entry.js(2), src/main-process/read-only-exports/biz-op/writer.js(2) |
| `executeDestructiveMutationWithSafeAudit` | 2 | 4 | 1 | src/backend/vcc-financial-op/destructive-write.js(2), src/main-process/vcc-financial-op-write-worker.js(2) |
| `executeExportAggregate` | 2 | 4 | 2 | src/main-process/bank-bu-worker/export-operation.js(2), src/main-process/bank-bu-worker/worker-host.js(2) |
| `executeExportSingle` | 2 | 4 | 2 | src/main-process/bank-bu-worker/export-operation.js(2), src/main-process/bank-bu-worker/worker-host.js(2) |
| `executeImportMonth` | 2 | 4 | 2 | src/main-process/bank-bu-worker/import-operation.js(2), src/main-process/bank-bu-worker/worker-host.js(2) |
| `executeMergeGeneration` | 2 | 4 | 2 | src/main-process/toolbox-background/generation-core.js(2), src/main-process/toolbox-background/merge-worker-entry.js(2) |
| `executeMultiSplitGeneration` | 2 | 4 | 2 | src/main-process/toolbox-background/route-scanner-core.js(2), src/main-process/toolbox-background/route-scanner-worker-entry.js(2) |
| `executePendingReadOnlyExport` | 2 | 4 | 2 | src/main-process/read-only-exports/pending/worker-entry.js(2), src/main-process/read-only-exports/pending/writer.js(2) |
| `executePositionReadOnlyExport` | 2 | 4 | 2 | src/main-process/read-only-exports/position/worker-entry.js(2), src/main-process/read-only-exports/position/writer.js(2) |
| `executePreFundReadOnlyExport` | 2 | 4 | 2 | src/main-process/read-only-exports/pre-fund/worker-entry.js(2), src/main-process/read-only-exports/pre-fund/writer.js(2) |
| `executeResultMutationWithSafeAudit` | 2 | 4 | 1 | src/backend/vcc-financial-op/result-write.js(2), src/main-process/vcc-financial-op-write-worker.js(2) |
| `executeSplitGeneration` | 2 | 4 | 2 | src/main-process/toolbox-background/generation-core.js(2), src/main-process/toolbox-background/split-worker-entry.js(2) |
| `executeStatementGenerationWithSafepoints` | 2 | 4 | 1 | src/main-process/statement-worker/generation.js(2), src/main-process/statement-worker/service.js(2) |
| `executeVccExportWriterGraph` | 2 | 4 | 2 | src/main-process/vcc-financial-op-output/writer-coordinator.js(2), src/main-process/vcc-financial-op-output/writer-worker-entry.js(2) |
| `executeVccFinancialOpReadOnlyExport` | 2 | 4 | 2 | src/main-process/read-only-exports/vcc-financial-op/worker-entry.js(2), src/main-process/read-only-exports/vcc-financial-op/writer.js(2) |
| `EXECUTION_TERMINAL_SOURCES` | 2 | 4 | 2 | src/main-process/background-execution/execution-result.js(2), src/main-process/background-execution/protocol.js(2) |
| `expandDynamicResourceVector` | 2 | 4 | 2 | src/main-process/background-execution/resource-lease.js(2), src/main-process/background-execution/service-host.js(2) |
| `exportAggregateRuns` | 2 | 4 | 1 | src/backend/pending-export/writer.js(3), src/main-process/read-only-exports/pending/writer.js(1) |
| `exportFilter` | 2 | 4 | 1 | src/backend/toolbox-xlsx-stream/large-split-worker.js(2), src/backend/toolbox-xlsx-stream/split-export-filter.js(2) |
| `exportMultiFilters` | 2 | 4 | 1 | src/backend/toolbox-xlsx-stream/large-split-worker.js(2), src/backend/toolbox-xlsx-stream/split-export-filter.js(2) |
| `extractChannelRegionCombos` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/channel-enum-repository.js(2) |
| `findHeaderMatchPosition` | 2 | 4 | 2 | src/backend/file-service/readers.js(2), src/main-process/table-type-detector.js(2) |
| `FLOW_ACCOUNT_KEY_DB_COLUMN` | 2 | 4 | 1 | src/backend/biz-op-recon-db/columns.js(2), src/main-process/biz-op-recon-session.js(2) |
| `FLOW_BU_FIELD_DB_COLUMN` | 2 | 4 | 1 | src/backend/biz-op-recon-db/columns.js(2), src/main-process/biz-op-recon-session.js(2) |
| `FLOW_DIRECTION_DB_COLUMN` | 2 | 4 | 1 | src/backend/biz-op-recon-db/columns.js(2), src/main-process/biz-op-recon-session.js(2) |
| `FLOW_RECON_AMOUNT_DB_COLUMN` | 2 | 4 | 1 | src/backend/biz-op-recon-db/columns.js(2), src/main-process/biz-op-recon-session.js(2) |
| `flowHeaderToDbColumn` | 2 | 4 | 1 | src/backend/biz-op-recon-db/columns.js(2), src/backend/vcc-op-calc-db/columns.js(2) |
| `freezeAcquiringCopySource` | 2 | 4 | 1 | src/main-process/read-only-exports/acquiring/query.js(3), src/main.js(1) |
| `freezeBizOpSourceSnapshot` | 2 | 4 | 1 | src/main-process/read-only-exports/biz-op/query.js(2), src/main.js(2) |
| `freezePreFundSourceSnapshot` | 2 | 4 | 1 | src/main-process/read-only-exports/pre-fund/query.js(2), src/main.js(2) |
| `freezeVccDatasetSourceSnapshot` | 2 | 4 | 1 | src/main-process/read-only-exports/vcc-financial-op/query.js(2), src/main.js(2) |
| `FUND_RECON_POLICIES` | 2 | 4 | 1 | src/main-process/background-execution/runtime.js(2), src/main-process/fund-recon-worker/policies.js(2) |
| `FUND_RECON_STATE_OWNER_KEY` | 2 | 4 | 1 | src/main-process/fund-recon-worker/policies.js(2), src/main-process/fund-recon-worker/worker-host.js(2) |
| `FUND_TYPE_ENUM_FILE_NAME` | 2 | 4 | 2 | src/constants/fund-type-enum.js(3), src/main.js(1) |
| `GATEWAY_BILL_SHEET_NAME` | 2 | 4 | 1 | src/constants/gateway-bill-recon-fields.js(2), src/main-process/recon-id-fix-io.js(2) |
| `GATEWAY_RECON_HEADERS_FILE_NAME` | 2 | 4 | 2 | src/constants/gateway-recon-headers-loader.js(3), src/main.js(1) |
| `generateValidateAndPublishAcquiringExport` | 2 | 4 | 1 | src/main-process/read-only-exports/acquiring/managed-export.js(2), src/main.js(2) |
| `generateValidateAndPublishPositionExport` | 2 | 4 | 1 | src/main-process/read-only-exports/position/managed-export.js(2), src/main.js(2) |
| `generateValidateAndPublishVccFinancialOpExport` | 2 | 4 | 1 | src/main-process/read-only-exports/vcc-financial-op/managed-export.js(2), src/main.js(2) |
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
| `getReconIdFixBillCategory` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/settings-repository.js(2) |
| `getRowById` | 2 | 4 | 1 | src/backend/biz-op-recon-db/imports-repository.js(2), src/main-process/biz-op-recon-writer.js(2) |
| `getRunResultSnapshot` | 2 | 4 | 1 | src/backend/vcc-financial-op/read-snapshot.js(2), src/main-process/vcc-financial-op-read-worker.js(2) |
| `getTaskFilePlanDefinition` | 2 | 4 | 1 | src/main-process/archive-center/task-file-plan-registry.js(2), src/main-process/archive-center/task-policy-registry.js(2) |
| `getTemplateByKey` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/template-repository.js(2) |
| `getTemplateByName` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/template-repository.js(2) |
| `gregorianTupleToExcelSerial` | 2 | 4 | 1 | src/backend/toolbox-format/model.js(2), src/backend/toolbox-format/number-date.js(2) |
| `GW_CURRENCY_FIELD` | 2 | 4 | 2 | src/main-process/scenario-engines/dbs-charge-fund-check.js(2), src/main-process/scenario-engines/r4-fund-nature-check.js(2) |
| `handleResourceGrant` | 2 | 4 | 1 | src/main-process/recon-id-fix-service/worker-entry.js(2), src/main-process/statement-worker/service.js(2) |
| `handleResourceReject` | 2 | 4 | 1 | src/main-process/recon-id-fix-service/worker-entry.js(2), src/main-process/statement-worker/service.js(2) |
| `handleResourceRevoke` | 2 | 4 | 1 | src/main-process/recon-id-fix-service/worker-entry.js(2), src/main-process/statement-worker/service.js(2) |
| `hasLinkedTableRows` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/linked-table-repository.js(2) |
| `hasMoreThanTwoDecimalsFromString` | 2 | 4 | 2 | src/backend/file-service/writers.js(2), src/main-process/toolbox-stream-io.js(2) |
| `hasShownWinOneDriveStorageNotice` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/settings-repository.js(2) |
| `heapStats` | 2 | 4 | 2 | src/backend/biz-op-recon-import/import-worker.js(2), src/backend/pending-import/worker.js(2) |
| `identifyAccountPair` | 2 | 4 | 1 | src/main-process/position-reconciliation/logical-accounts.js(2), src/main-process/position-reconciliation/matching-engine.js(2) |
| `IMPORT_BASE_RESOURCES` | 2 | 4 | 1 | src/main-process/pre-fund-reconciliation/mpt-import/policies.js(2), src/main-process/pre-fund-reconciliation/mpt-import/topology.js(2) |
| `IMPORT_WRITER_RESOURCES` | 2 | 4 | 1 | src/main-process/pre-fund-reconciliation/mpt-import/policies.js(2), src/main-process/pre-fund-reconciliation/mpt-import/topology.js(2) |
| `importBillFile` | 2 | 4 | 1 | src/backend/acquiring-bill-currency-import/reader.js(2), src/main-process/acquiring-bill-currency-session.js(2) |
| `importCommittedDataset` | 2 | 4 | 2 | src/main-process/bank-bu-worker/import-operation.js(2), src/main-process/bank-bu-worker/side-database.js(2) |
| `importFlowFile` | 2 | 4 | 1 | src/backend/acquiring-bill-currency-import/reader.js(2), src/main-process/acquiring-bill-currency-session.js(2) |
| `importMonth` | 2 | 4 | 1 | src/main-process/bank-bu-recon-run-data.js(2), src/main-process/bank-bu-recon-session.js(2) |
| `importSystemOpGroup` | 2 | 4 | 1 | src/backend/vcc-financial-op/import-service.js(2), src/backend/vcc-financial-op/system-op-importer.js(2) |
| `indexColumns` | 2 | 4 | 1 | src/backend/vcc-financial-op/read-schema.js(2), src/main-process/position-reconciliation/store.js(2) |
| `initializeOpeningBalances` | 2 | 4 | 1 | src/backend/vcc-financial-op/calculator.js(2), src/main-process/vcc-financial-op-service.js(2) |
| `insertBankRowsInTxn` | 2 | 4 | 1 | src/backend/bank-bu-recon-db/month-repository.js(3), src/main-process/bank-bu-worker/side-database.js(1) |
| `insertPendingRowsInTxn` | 2 | 4 | 1 | src/backend/bank-bu-recon-db/month-repository.js(3), src/main-process/bank-bu-worker/side-database.js(1) |
| `inspectPositionOperationCommitChain` | 2 | 4 | 1 | src/main-process/position-reconciliation/import-recovery.js(2), src/main-process/position-reconciliation/side-db-mutation.js(2) |
| `inspectVccStorage` | 2 | 4 | 1 | src/main-process/vcc-financial-op-storage-migration.js(2), src/main-process/vcc-financial-op-storage-rebuild.js(2) |
| `INVALID_DIRECTIONS_WARNING_CODE` | 2 | 4 | 2 | src/main-process/scenario-engines/r5-fund-transfer-backfill.js(2), src/main-process/scenario-engines/r5-fund-transfer-recon-backfill.js(2) |
| `isBankDepositChannelFile` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/channel-enum-repository.js(2) |
| `isBuiltinNumberFormat` | 2 | 4 | 1 | src/backend/toolbox-format/number-date.js(2), src/backend/toolbox-format/style-registry.js(2) |
| `isFilenameMappingMode` | 2 | 4 | 2 | src/renderer.js(3), src/main.js(1) |
| `isMemoryLimitError` | 2 | 4 | 1 | src/backend/file-service/readers.js(2), src/main-process/toolbox-merge-io.js(2) |
| `isSafeMptDetailLines` | 2 | 4 | 1 | src/main-process/pre-fund-reconciliation/mpt-import/file-result-safety.js(2), src/main-process/pre-fund-reconciliation/mpt-import/policies.js(2) |
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
| `listTemplateBundleEntries` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/template-repository.js(2) |
| `loadExportDataByRun` | 2 | 4 | 1 | src/main-process/bank-bu-recon-run-data.js(2), src/main-process/bank-bu-worker/export-operation.js(2) |
| `loadJobMeta` | 2 | 4 | 2 | src/backend/biz-op-recon-import/import-worker.js(2), src/backend/pending-import/worker.js(2) |
| `loadValidationContext` | 2 | 4 | 1 | src/main-process/vcc-financial-op-output/artifact-evidence.js(2), src/main-process/vcc-financial-op-output/dispatch.js(2) |
| `makeUnionFind` | 2 | 4 | 2 | src/main-process/position-reconciliation/logical-accounts.js(2), src/main-process/scenario-engines/many-to-many-detector.js(2) |
| `MAP_ENTRY_OVERHEAD_BYTES` | 2 | 4 | 2 | src/main-process/fund-recon-worker/state-footprint.js(2), src/main-process/statement-worker/state-footprint.js(2) |
| `mappedRowToInsertParams` | 2 | 4 | 1 | src/backend/vcc-financial-op/detail-importer.js(2), src/backend/vcc-financial-op/row-mapper.js(2) |
| `markBankDepositHits` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/linked-table-repository.js(2) |
| `markWinOneDriveStorageNoticeShown` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/settings-repository.js(2) |
| `MERCHANT_ID_MULTI_ACCOUNT_MARKER` | 2 | 4 | 2 | src/backend/database/utils.js(3), src/main.js(1) |
| `MID_ALLOCATION_SUCCESS_STATUS` | 2 | 4 | 1 | src/constants/fund-transfer-recon-fields.js(2), src/main-process/fund-transfer-recon-builder.js(2) |
| `MIN_RESERVATION_BYTES` | 2 | 4 | 2 | src/main-process/fund-recon-worker/state-footprint.js(2), src/main-process/statement-worker/state-footprint.js(2) |
| `MONTH_KEY_PATTERN` | 2 | 4 | 2 | src/main-process/bank-bu-worker/operation-receipt-repository.js(2), src/main-process/duplicate-inbound-match/operation-receipt-repository.js(2) |
| `MOVEMENT_SOURCE_TYPES` | 2 | 4 | 2 | src/backend/vcc-financial-op/result-adjustments.js(2), src/backend/vcc-financial-op/result-evidence.js(2) |
| `MPT_SPOOL_MAX_MANIFEST_BYTES` | 2 | 4 | 1 | src/main-process/pre-fund-reconciliation/mpt-import/spool-contract.js(2), src/main-process/pre-fund-reconciliation/mpt-import/spool-reader.js(2) |
| `MTX_FEATURE` | 2 | 4 | 1 | src/constants/refund-backfill-fields.js(2), src/main-process/scenario-engines/r5-refund-order-backfill.js(2) |
| `NEW_ACCOUNT_SAVE_AS_POLICY` | 2 | 4 | 1 | src/main-process/background-execution/runtime.js(2), src/main-process/new-account/policies.js(2) |
| `normalizeAcquiringExportInput` | 2 | 4 | 2 | src/main-process/read-only-exports/acquiring/actions.js(2), src/main-process/read-only-exports/acquiring/executor.js(2) |
| `normalizeBizOpReadOnlyExportInput` | 2 | 4 | 2 | src/main-process/read-only-exports/biz-op/actions.js(2), src/main-process/read-only-exports/biz-op/writer.js(2) |
| `normalizeCurrencyOptionEntry` | 2 | 4 | 1 | src/renderer-dialogs.js(2), src/renderer.js(2) |
| `normalizeMaintainedBigAccounts` | 2 | 4 | 1 | src/main-process/big-account-recognition.js(3), src/main.js(1) |
| `normalizeMergeInput` | 2 | 4 | 1 | src/main-process/toolbox-background/generation-contract.js(2), src/main-process/toolbox-background/generation-core.js(2) |
| `normalizePendingReadOnlyExportInput` | 2 | 4 | 1 | src/main-process/read-only-exports/pending/actions.js(2), src/main-process/read-only-exports/pending/writer.js(2) |
| `normalizePositionReadOnlyExportInput` | 2 | 4 | 2 | src/main-process/read-only-exports/position/actions.js(2), src/main-process/read-only-exports/position/writer.js(2) |
| `normalizePositionStreamingSourceTypes` | 2 | 4 | 1 | src/backend/position-reconciliation-import/constants.js(2), src/main-process/position-reconciliation/service.js(2) |
| `normalizePreFundReadOnlyExportInput` | 2 | 4 | 2 | src/main-process/read-only-exports/pre-fund/actions.js(2), src/main-process/read-only-exports/pre-fund/writer.js(2) |
| `normalizeRunId` | 2 | 4 | 2 | src/backend/vcc-financial-op/read-snapshot.js(2), src/backend/vcc-financial-op/result-write.js(2) |
| `normalizeSettlementRecoveryResult` | 2 | 4 | 1 | src/main-process/background-execution/recovery-source.js(2), src/main-process/background-execution/startup-recovery-coordinator.js(2) |
| `normalizeSplitInput` | 2 | 4 | 1 | src/main-process/toolbox-background/generation-contract.js(2), src/main-process/toolbox-background/generation-core.js(2) |
| `normalizeVccExportShard` | 2 | 4 | 2 | src/main-process/vcc-financial-op-output/shard-planner.js(2), src/main-process/vcc-financial-op-output/writer-core.js(2) |
| `normalizeVccFinancialOpReadOnlyExportInput` | 2 | 4 | 2 | src/main-process/read-only-exports/vcc-financial-op/actions.js(2), src/main-process/read-only-exports/vcc-financial-op/writer.js(2) |
| `openEntryStream` | 2 | 4 | 2 | src/backend/position-reconciliation-import/xlsx-reader.js(2), src/backend/toolbox-format/xlsx-sheet-scanner.js(2) |
| `openModuleMenu` | 2 | 4 | 1 | src/renderer-previews.js(2), src/renderer.js(2) |
| `openPositionExportStore` | 2 | 4 | 1 | src/main-process/read-only-exports/position/query.js(2), src/main-process/read-only-exports/position/writer.js(2) |
| `openPositionReconciliationStoreReadOnly` | 2 | 4 | 1 | src/main-process/position-reconciliation/store.js(2), src/main-process/read-only-exports/position/query.js(2) |
| `openToolboxBiff8Pass` | 2 | 4 | 1 | src/backend/toolbox-format/biff8-pass.js(2), src/main-process/toolbox-format-io.js(2) |
| `openToolboxCsvPass` | 2 | 4 | 1 | src/backend/toolbox-format/csv-pass.js(2), src/main-process/toolbox-format-io.js(2) |
| `openVccFinancialOpExportDatabase` | 2 | 4 | 1 | src/main-process/read-only-exports/vcc-financial-op/query.js(2), src/main-process/read-only-exports/vcc-financial-op/writer.js(2) |
| `OPPONENT_BILL_SHEET_NAME` | 2 | 4 | 1 | src/constants/recon-id-fix-fields.js(2), src/main-process/recon-id-fix-io.js(2) |
| `ORDER_REPAIR_SHEET_NAME` | 2 | 4 | 1 | src/constants/recon-id-fix-fields.js(2), src/main-process/recon-id-fix-io.js(2) |
| `ORDER_REPAIR_SHEET_NAME_GATEWAY` | 2 | 4 | 1 | src/constants/gateway-bill-recon-fields.js(2), src/main-process/recon-id-fix-io.js(2) |
| `OWNED_ACTIONS` | 2 | 4 | 2 | src/main-process/duplicate-inbound-match/worker-host.js(2), src/main-process/fund-recon-worker/worker-host.js(2) |
| `parseAndValidateEnvelope` | 2 | 4 | 1 | src/main-process/background-execution/protocol-validator.js(2), src/main-process/background-execution/protocol.js(2) |
| `parseColumnFromCellRef` | 2 | 4 | 1 | src/backend/acquiring-bill-currency-import/reader.js(3), src/backend/acquiring-bill-currency-import/reader-handrolled.js(1) |
| `parseMptCandidates` | 2 | 4 | 2 | src/main-process/pre-fund-reconciliation/mpt-import/parser-core.js(2), src/main-process/pre-fund-reconciliation/mpt-import/spool-writer.js(2) |
| `parseOutboxBatchId` | 2 | 4 | 1 | src/main-process/archive-center/controller.js(2), src/main-process/archive-center/outbox-store.js(2) |
| `parsePackagedRuntimeRequest` | 2 | 4 | 1 | src/main-process/background-execution/canary/packaged-runtime-request.js(2), src/main.js(2) |
| `PARSER_RESULT_KEYS` | 2 | 4 | 1 | src/main-process/vcc-op-calc/ordered-reducer.js(2), src/main-process/vcc-op-calc/parser-core.js(2) |
| `parseRowXml` | 2 | 4 | 1 | src/backend/biz-op-recon-import/reader-streamed.js(2), src/backend/vcc-op-calc-import/reader.js(2) |
| `parseVccFileUnit` | 2 | 4 | 2 | src/main-process/vcc-op-calc/parser-core.js(2), src/main-process/vcc-op-calc/parser-worker.js(2) |
| `peekFirstFile` | 2 | 4 | 1 | src/backend/big-table-import/engine.js(3), src/main-process/acquiring-bill-currency-session.js(1) |
| `peekToolboxSplitHeaders` | 2 | 4 | 1 | src/backend/toolbox-xlsx-stream/split-export-filter.js(2), src/main-process/toolbox-format-operations.js(2) |
| `PENDING_MATCH_KEY_DB_COLUMN` | 2 | 4 | 1 | src/backend/bank-bu-recon-db/columns.js(2), src/main-process/bank-bu-recon-session.js(2) |
| `PENDING_READ_ONLY_POLICIES` | 2 | 4 | 1 | src/main-process/background-execution/runtime.js(2), src/main-process/read-only-exports/pending/policies.js(2) |
| `pendingExportWriter` | 2 | 4 | 2 | src/main-process/read-only-exports/pending/writer.js(3), src/main.js(1) |
| `PERSISTENT_STATE_RESOURCES` | 2 | 4 | 2 | src/main-process/fund-recon-worker/policies.js(2), src/main-process/recon-id-fix-service/policies.js(2) |
| `PHASE_RESOURCES` | 2 | 4 | 2 | src/main-process/fund-recon-worker/policies.js(2), src/main-process/recon-id-fix-service/policies.js(2) |
| `planRunOutputPaths` | 2 | 4 | 1 | src/main-process/acquiring-bill-currency-writer.js(3), src/main-process/acquiring-bill-currency-session.js(1) |
| `planVccExportShards` | 2 | 4 | 2 | src/main-process/vcc-financial-op-output/shard-planner.js(2), src/main-process/vcc-financial-op-output/writer-coordinator.js(2) |
| `POSITION_IMPORT_PROGRESS_HEARTBEAT_MS` | 2 | 4 | 1 | src/backend/position-reconciliation-import/constants.js(2), src/main-process/position-reconciliation/import-dispatch.js(2) |
| `POSITION_READ_ONLY_POLICY` | 2 | 4 | 1 | src/main-process/background-execution/runtime.js(2), src/main-process/read-only-exports/position/policies.js(2) |
| `POSITION_SST_LRU_MAX_ENTRIES` | 2 | 4 | 1 | src/backend/position-reconciliation-import/constants.js(2), src/backend/position-reconciliation-import/shared-strings-provider.js(2) |
| `POSITION_SST_MEMORY_BUDGET_BYTES` | 2 | 4 | 1 | src/backend/position-reconciliation-import/constants.js(2), src/backend/position-reconciliation-import/shared-strings-provider.js(2) |
| `positionBankAmountWithExtraFee` | 2 | 4 | 1 | src/main-process/position-reconciliation/decimal.js(2), src/main-process/position-reconciliation/matching-engine.js(2) |
| `positiveDelta` | 2 | 4 | 1 | src/main-process/background-execution/resource-governor.js(2), src/main-process/background-execution/resource-lease.js(2) |
| `PRE_FUND_MPT_STATIC_KEYS` | 2 | 4 | 1 | src/main-process/pre-fund-reconciliation/mpt-import/policies.js(3), src/main.js(1) |
| `PRE_FUND_READ_ONLY_POLICIES` | 2 | 4 | 1 | src/main-process/background-execution/runtime.js(2), src/main-process/read-only-exports/pre-fund/policies.js(2) |
| `preFundRunLineagePlan` | 2 | 4 | 1 | src/main-process/pre-fund-archive-lineage.js(2), src/main-process/pre-fund-reconciliation/service.js(2) |
| `preFundRunOutputIntent` | 2 | 4 | 1 | src/main-process/pre-fund-archive-lineage.js(2), src/main-process/pre-fund-reconciliation/service.js(2) |
| `prepareRunExport` | 2 | 4 | 1 | src/main-process/acquiring-bill-currency-run-data.js(3), src/main-process/read-only-exports/acquiring/query.js(1) |
| `prepareRunResume` | 2 | 4 | 1 | src/main-process/acquiring-bill-currency-run-data.js(2), src/main-process/background-execution/adapters/acquiring-adapter.js(2) |
| `PREPROCESS_TABLE_SIGNATURES` | 2 | 4 | 1 | src/constants/table-signatures.js(3), src/main.js(1) |
| `previewDeleteTargetSnapshot` | 2 | 4 | 1 | src/backend/vcc-financial-op/read-snapshot.js(2), src/main-process/vcc-financial-op-read-worker.js(2) |
| `previewUnarchiveSnapshot` | 2 | 4 | 1 | src/backend/vcc-financial-op/read-snapshot.js(2), src/main-process/vcc-financial-op-read-worker.js(2) |
| `projectOutputRow` | 2 | 4 | 1 | src/main-process/pre-fund-reconciliation/excel-writer.js(2), src/main-process/pre-fund-reconciliation/output-mapper.js(2) |
| `projectToolboxRowValues` | 2 | 4 | 1 | src/backend/toolbox-format/model.js(2), src/main-process/toolbox-format-io.js(2) |
| `pruneStagingRoot` | 2 | 4 | 1 | src/main-process/position-reconciliation/input-staging.js(2), src/main-process/position-reconciliation/service.js(2) |
| `publishDurableArtifactAsync` | 2 | 4 | 1 | src/main-process/new-account/artifact-copy.js(2), src/main-process/toolbox-output-publication-dispatch.js(2) |
| `PURE_COMPUTE_ACTION_KEY` | 2 | 4 | 1 | src/main-process/background-execution/canary/index.js(2), src/main-process/background-execution/canary/packaged-runtime-runner.js(2) |
| `PURE_COMPUTE_ENTRY_KEY` | 2 | 4 | 1 | src/main-process/background-execution/canary/index.js(3), src/main-process/background-execution/canary/packaged-runtime-runner.js(1) |
| `PURE_COMPUTE_RESULT_VALIDATOR_KEY` | 2 | 4 | 1 | src/main-process/background-execution/canary/index.js(3), src/main-process/background-execution/canary/packaged-runtime-runner.js(1) |
| `PURE_COMPUTE_WORKER_BINDING` | 2 | 4 | 1 | src/main-process/background-execution/canary/index.js(3), src/main-process/background-execution/canary/packaged-runtime-runner.js(1) |
| `PURE_COMPUTE_WORKER_ENTRY` | 2 | 4 | 1 | src/main-process/background-execution/canary/index.js(3), src/main-process/background-execution/canary/packaged-runtime-runner.js(1) |
| `readAdmBankDepositRows` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/linked-table-repository.js(2) |
| `readBankBuSpoolPair` | 2 | 4 | 2 | src/main-process/bank-bu-worker/import-operation.js(2), src/main-process/bank-bu-worker/spool-reader.js(2) |
| `readBankFiles` | 2 | 4 | 2 | src/main-process/position-reconciliation/readers.js(2), src/main-process/position-reconciliation/service.js(2) |
| `readBiff8Overlay` | 2 | 4 | 1 | src/backend/toolbox-format/biff8-overlay.js(2), src/backend/toolbox-format/biff8-pass.js(2) |
| `readBocBankDepositRows` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/linked-table-repository.js(2) |
| `readChannelExport` | 2 | 4 | 1 | src/main-process/read-only-exports/pre-fund/query.js(2), src/main-process/read-only-exports/pre-fund/writer.js(2) |
| `readGatewayBillRowsByChannels` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/linked-table-repository.js(2) |
| `readline` | 2 | 4 | 2 | src/main-process/bank-bu-worker/spool-reader.js(2), src/main-process/duplicate-inbound-match/spool-reader.js(2) |
| `readParserOutcome` | 2 | 4 | 2 | src/main-process/pre-fund-reconciliation/mpt-import/parser-outcome.js(2), src/main-process/pre-fund-reconciliation/mpt-import/single-writer-session.js(2) |
| `readResultWorkbook` | 2 | 4 | 1 | src/main-process/position-reconciliation/excel-io.js(2), src/main-process/position-reconciliation/service.js(2) |
| `readSharedStrings` | 2 | 4 | 1 | src/backend/biz-op-recon-import/reader-streamed.js(2), src/backend/vcc-op-calc-import/reader.js(2) |
| `readSourceFiles` | 2 | 4 | 2 | src/main-process/position-reconciliation/readers.js(2), src/main-process/position-reconciliation/service.js(2) |
| `readXlsxSheetNames` | 2 | 4 | 2 | src/main-process/duplicate-inbound-match/document-statement-reader.js(2), src/main-process/duplicate-inbound-match/input-classifier.js(2) |
| `RECON_FIX_JPM_POLICY` | 2 | 4 | 1 | src/main-process/recon-id-fix-service/policies.js(3), src/main.js(1) |
| `RECON_RESULT_FIELDS` | 2 | 4 | 1 | src/constants/recon-id-fix-fields.js(2), src/main-process/recon-id-fix-io.js(2) |
| `RECON_RESULT_SHEET_NAME` | 2 | 4 | 1 | src/constants/recon-id-fix-fields.js(2), src/main-process/recon-id-fix-io.js(2) |
| `RECON_RESULT_SHEET_NAME_GATEWAY` | 2 | 4 | 1 | src/constants/gateway-bill-recon-fields.js(2), src/main-process/recon-id-fix-io.js(2) |
| `recordMonthEndCopyIntent` | 2 | 4 | 1 | src/backend/biz-op-recon-import/import-worker.js(2), src/main-process/biz-op-recon-session.js(2) |
| `recoverPositionImportWorkerExit` | 2 | 4 | 1 | src/main-process/position-reconciliation/import-dispatch.js(2), src/main-process/position-reconciliation/import-recovery.js(2) |
| `refundOrderSession` | 2 | 4 | 1 | src/renderer.js(3), src/main.js(1) |
| `registerDuplicatePairedParserFinalization` | 2 | 4 | 1 | src/main-process/duplicate-inbound-match/paired-parser-dispatch.js(2), src/main-process/duplicate-inbound-match/paired-parser-shutdown.js(2) |
| `renameTemplate` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/template-repository.js(2) |
| `REPAIR_WRITER_RESOURCES` | 2 | 4 | 1 | src/main-process/pre-fund-reconciliation/mpt-import/policies.js(2), src/main-process/pre-fund-reconciliation/mpt-import/topology.js(2) |
| `replaceBocFxLink` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/linked-table-repository.js(2) |
| `replaceLinkedTable` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/linked-table-repository.js(2) |
| `replaceLinkedTableStreaming` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/linked-table-repository.js(2) |
| `resetFundTransferReconUsage` | 2 | 4 | 1 | src/main-process/reconciliation-orchestrator.js(2), src/main-process/scenario-engines/r5-payment-offline-allocation-backfill.js(2) |
| `resolveBankRuleEligibility` | 2 | 4 | 2 | src/main-process/pre-fund-reconciliation/matching-engine.js(2), src/main-process/pre-fund-reconciliation/reconciliation-rules.js(2) |
| `resolveCurrencyValue` | 2 | 4 | 1 | src/backend/file-service.js(2), src/backend/file-service/normalizers.js(2) |
| `resolveDuplicateInboundDocumentMatches` | 2 | 4 | 1 | src/main-process/duplicate-inbound-match/matching-engine.js(2), src/main-process/duplicate-inbound-match/service.js(2) |
| `resolveDuplicateInboundMptMatches` | 2 | 4 | 1 | src/main-process/duplicate-inbound-match/matching-engine.js(2), src/main-process/duplicate-inbound-match/service.js(2) |
| `resolveFullColor` | 2 | 4 | 1 | src/backend/toolbox-format/biff8-colors.js(2), src/backend/toolbox-format/biff8-overlay.js(2) |
| `resolveSourceResource` | 2 | 4 | 1 | src/main-process/statement-worker/service.js(2), src/main-process/statement-worker/worker-entry.js(2) |
| `resolveStatementSourceIdentity` | 2 | 4 | 1 | src/main-process/statement-worker/service.js(2), src/main-process/statement-worker/source-identity.js(2) |
| `resolveWorkerScript` | 2 | 4 | 2 | src/main-process/run-check-multiworker.js(2), src/main-process/run-check-worker-pool.js(2) |
| `rgbToHsl` | 2 | 4 | 2 | src/backend/toolbox-format/biff8-colors.js(2), src/backend/toolbox-format/style-registry.js(2) |
| `rollbackOpenTransaction` | 2 | 4 | 2 | src/main-process/recon-id-fix-service/jpm-writeback-transaction.js(2), src/main-process/vcc-op-calc/save-run-contract.js(2) |
| `routeMaskForIndexes` | 2 | 4 | 1 | src/main-process/toolbox-background/route-db-contract.js(2), src/main-process/toolbox-background/route-db-sealer.js(2) |
| `routeMaskIncludes` | 2 | 4 | 1 | src/main-process/toolbox-background/output-writer-core.js(2), src/main-process/toolbox-background/route-db-contract.js(2) |
| `rowScanner` | 2 | 4 | 2 | src/backend/big-table-import/engine.js(2), src/backend/big-table-import/import-worker.js(2) |
| `runAcquiringExistingDiffCopyInline` | 2 | 4 | 1 | src/main-process/background-execution/runtime.js(2), src/main-process/read-only-exports/acquiring/executor.js(2) |
| `runBocDispatchOrderFix` | 2 | 4 | 2 | src/main-process/recon-id-fix-engine.js(2), src/main-process/scenario-engines/boc-dispatch-order-fix.js(2) |
| `runC4Scenario` | 2 | 4 | 2 | src/main-process/recon-id-fix-engine.js(2), src/main-process/scenario-engines/c4-recon-id-fix.js(2) |
| `runCheckCore` | 2 | 4 | 1 | src/main-process/acquiring-bill-currency-session.js(3), src/main-process/run-check-worker.js(1) |
| `runDbsChargeFundCheck` | 2 | 4 | 2 | src/main-process/reconciliation-orchestrator.js(2), src/main-process/scenario-engines/dbs-charge-fund-check.js(2) |
| `runEvidenceHash` | 2 | 4 | 2 | src/main-process/duplicate-inbound-match/service.js(2), src/main-process/duplicate-inbound-match/startup-recovery.js(2) |
| `runJpmDispatchOrderFix` | 2 | 4 | 2 | src/main-process/recon-id-fix-engine.js(2), src/main-process/scenario-engines/jpm-dispatch-order-fix.js(2) |
| `runNewAccountArtifactCopyInline` | 2 | 4 | 1 | src/main-process/background-execution/runtime.js(2), src/main-process/new-account/artifact-copy.js(2) |
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
| `runVccParserPipeline` | 2 | 4 | 2 | src/main-process/vcc-op-calc-session.js(2), src/main-process/vcc-op-calc/parser-pipeline.js(2) |
| `runViaSideDb` | 2 | 4 | 2 | src/main-process/bank-bu-recon-run-data.js(2), src/main-process/biz-op-recon-run-data.js(2) |
| `runWorkerDurableCanary` | 2 | 4 | 1 | src/main-process/background-execution/canary/durable-recovery.js(2), src/main-process/background-execution/canary/packaged-runtime-runner.js(2) |
| `safeCauseCode` | 2 | 4 | 2 | src/main-process/bank-bu-worker/parser-outcome.js(2), src/main-process/duplicate-inbound-match/parser-outcome.js(2) |
| `sameBoundedJpmReceipt` | 2 | 4 | 1 | src/main-process/recon-id-fix-service/jpm-receipt-authority.js(2), src/main-process/recon-id-fix-service/jpm-receipt-evidence.js(2) |
| `sameExactOperationReceipt` | 2 | 4 | 1 | src/main-process/pre-fund-reconciliation/mpt-import/operation-receipt-repository.js(2), src/main-process/pre-fund-reconciliation/mpt-import/receipt-authority.js(2) |
| `sameRunResult` | 2 | 4 | 2 | src/main-process/acquiring-bill-currency-run-data.js(2), src/main-process/read-only-exports/acquiring/query.js(2) |
| `saveAccountMappings` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/settings-repository.js(2) |
| `savepointSequence` | 2 | 4 | 2 | src/backend/database/archive-repository.js(2), src/backend/database/background-execution-schema.js(2) |
| `saveTemplateFilenameFixedField` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/template-repository.js(2) |
| `saveVccOpRunWithReceipt` | 2 | 4 | 2 | src/main-process/vcc-op-calc-session.js(2), src/main-process/vcc-op-calc/save-run-contract.js(2) |
| `scanAndSealRouteDb` | 2 | 4 | 2 | src/main-process/toolbox-background/route-db-sealer.js(2), src/main-process/toolbox-background/route-scanner-core.js(2) |
| `scanBiff8WorkbookStream` | 2 | 4 | 1 | src/backend/toolbox-format/biff8-overlay.js(2), src/backend/toolbox-format/biff8-records.js(2) |
| `scanFields` | 2 | 4 | 1 | src/backend/toolbox-xlsx-stream/large-split-worker.js(2), src/backend/toolbox-xlsx-stream/split-scan-fields.js(2) |
| `serial1904To1900` | 2 | 4 | 1 | src/backend/toolbox-format/model.js(2), src/backend/toolbox-format/number-date.js(2) |
| `serialize` | 2 | 4 | 1 | src/backend/usage-stats.js(3), src/main-process/toolbox-background/route-db-contract.js(1) |
| `serializePackagedRuntimeReport` | 2 | 4 | 1 | src/main-process/background-execution/canary/packaged-runtime-request.js(2), src/main-process/background-execution/canary/packaged-runtime-runner.js(2) |
| `serviceTransportCreatedGeneration` | 2 | 4 | 1 | src/main-process/background-execution/service-host.js(2), src/main-process/background-execution/supervisor.js(2) |
| `SET_ENTRY_OVERHEAD_BYTES` | 2 | 4 | 2 | src/main-process/fund-recon-worker/state-footprint.js(2), src/main-process/statement-worker/state-footprint.js(2) |
| `setAcquiringBillChunkSize` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/settings-repository.js(2) |
| `setAcquiringBillIdleCleanupMinutes` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/settings-repository.js(2) |
| `setAcquiringBillRawJsonRetentionDays` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/settings-repository.js(2) |
| `setAcquiringBillWorkerCount` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/settings-repository.js(2) |
| `setAutoUpdateEnabled` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/settings-repository.js(2) |
| `setBackgroundConfig` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/settings-repository.js(2) |
| `setEnumConfig` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/settings-repository.js(2) |
| `setLastImportDirectory` | 2 | 4 | 1 | src/backend/database/settings-repository.js(2), src/main-process/import-dialog-state.js(2) |
| `settlePositionPublishedMetadata` | 2 | 4 | 1 | src/main-process/read-only-exports/position/settlement.js(2), src/main.js(2) |
| `showImportOpenDialog` | 2 | 4 | 2 | src/main-process/import-dialog-state.js(2), src/main.js(2) |
| `sourceAmountToCents` | 2 | 4 | 1 | src/main-process/position-reconciliation/decimal.js(2), src/main-process/position-reconciliation/matching-engine.js(2) |
| `sourceSnapshotForPath` | 2 | 4 | 2 | src/main-process/archive-center/operation-tracker.js(2), src/main-process/archive-center/source-snapshot.js(2) |
| `spawn` | 2 | 4 | 2 | src/main-process/biz-op-recon-session.js(2), src/main-process/pending-session.js(2) |
| `stageInputFilesAsync` | 2 | 4 | 1 | src/backend/position-reconciliation-import/preflight.js(2), src/main-process/position-reconciliation/input-staging.js(2) |
| `startBankBuWorker` | 2 | 4 | 2 | src/main-process/bank-bu-worker/worker-entry.js(2), src/main-process/bank-bu-worker/worker-host.js(2) |
| `startDuplicateWorker` | 2 | 4 | 2 | src/main-process/duplicate-inbound-match/worker-entry.js(2), src/main-process/duplicate-inbound-match/worker-host.js(2) |
| `startFundReconWorker` | 2 | 4 | 2 | src/main-process/fund-recon-worker/worker-entry.js(2), src/main-process/fund-recon-worker/worker-host.js(2) |
| `streamPositionXlsRows` | 2 | 4 | 1 | src/backend/position-reconciliation-import/preflight.js(2), src/backend/position-reconciliation-import/xls-reader.js(2) |
| `streamPositionXlsxRows` | 2 | 4 | 1 | src/backend/position-reconciliation-import/preflight.js(2), src/backend/position-reconciliation-import/xlsx-reader.js(2) |
| `SUPPORT_ACTION_POLICIES` | 2 | 4 | 1 | src/main-process/archive-center/task-policy-registry.js(2), src/main.js(2) |
| `systemRecordResult` | 2 | 4 | 1 | src/backend/vcc-financial-op/import-service.js(2), src/backend/vcc-financial-op/system-op-importer.js(2) |
| `T54_REFUND_RE` | 2 | 4 | 1 | src/constants/refund-backfill-fields.js(2), src/main-process/scenario-engines/r5-refund-order-backfill.js(2) |
| `tableInfo` | 2 | 4 | 1 | src/backend/vcc-financial-op/read-schema.js(2), src/main-process/position-reconciliation/store.js(2) |
| `taskStagingIdentityFromProvisional` | 2 | 4 | 1 | src/main-process/vcc-financial-op-output/dispatch.js(2), src/main-process/vcc-financial-op-output/staging-identity.js(2) |
| `toggleScenarioEnabled` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/scenarios-repository.js(2) |
| `toMatchValue` | 2 | 4 | 1 | src/backend/toolbox-format/model.js(2), src/main-process/toolbox-format-io.js(2) |
| `TOOLBOX_GENERATION_POLICIES` | 2 | 4 | 1 | src/main-process/background-execution/runtime.js(2), src/main-process/toolbox-background/policies.js(2) |
| `toSafeParserFileResult` | 2 | 4 | 2 | src/main-process/pre-fund-reconciliation/mpt-import/managed-import.js(2), src/main-process/pre-fund-reconciliation/mpt-import/parser-outcome.js(2) |
| `transferScenarios` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/scenarios-repository.js(2) |
| `transitionEventType` | 2 | 4 | 1 | src/main-process/background-execution/critical/recovery-control-repository.js(2), src/main-process/background-execution/recovery-control-contract.js(2) |
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
| `UUID_TOKEN_PATTERN` | 2 | 4 | 2 | src/main-process/vcc-financial-op-output/dispatch.js(2), src/main-process/vcc-financial-op-output/staging-identity.js(2) |
| `VALID_ORDER_STATUSES` | 2 | 4 | 1 | src/main-process/position-reconciliation/constants.js(2), src/main-process/position-reconciliation/derivation.js(2) |
| `validateAcquiringGeneratedArtifact` | 2 | 4 | 2 | src/main-process/read-only-exports/acquiring/business-validator.js(2), src/main-process/read-only-exports/acquiring/managed-export.js(2) |
| `validateBankHeaders` | 2 | 4 | 1 | src/backend/bank-bu-recon-import/reader.js(2), src/backend/bank-bu-recon-import/validator.js(2) |
| `validateBizOpGeneratedArtifact` | 2 | 4 | 2 | src/main-process/read-only-exports/biz-op/business-validator.js(2), src/main-process/read-only-exports/biz-op/managed-export.js(2) |
| `validateDuplicateExportResult` | 2 | 4 | 1 | src/main-process/background-execution/runtime.js(2), src/main-process/duplicate-inbound-match/policies.js(2) |
| `validateDuplicateImportResult` | 2 | 4 | 1 | src/main-process/background-execution/runtime.js(2), src/main-process/duplicate-inbound-match/policies.js(2) |
| `validateDuplicateRunResult` | 2 | 4 | 1 | src/main-process/background-execution/runtime.js(2), src/main-process/duplicate-inbound-match/policies.js(2) |
| `validateDuplicateSpoolPair` | 2 | 4 | 1 | src/main-process/duplicate-inbound-match/service.js(2), src/main-process/duplicate-inbound-match/spool-reader.js(2) |
| `validateEffectiveResultEvidence` | 2 | 4 | 2 | src/backend/vcc-financial-op/archive-evidence.js(2), src/backend/vcc-financial-op/result-evidence.js(2) |
| `validateFundReconExportResult` | 2 | 4 | 1 | src/main-process/background-execution/runtime.js(2), src/main-process/fund-recon-worker/policies.js(2) |
| `validateFundReconImportResult` | 2 | 4 | 1 | src/main-process/background-execution/runtime.js(2), src/main-process/fund-recon-worker/policies.js(2) |
| `validateFundReconRunResult` | 2 | 4 | 1 | src/main-process/background-execution/runtime.js(2), src/main-process/fund-recon-worker/policies.js(2) |
| `validateImportEvidence` | 2 | 4 | 2 | src/main-process/bank-bu-worker/identity.js(2), src/main-process/bank-bu-worker/side-database.js(2) |
| `validatePendingBizOpAdapterResult` | 2 | 4 | 1 | src/main-process/background-execution/pending-bizop-adapter-policies.js(2), src/main-process/background-execution/runtime.js(2) |
| `validatePendingGeneratedArtifact` | 2 | 4 | 2 | src/main-process/read-only-exports/pending/business-validator.js(2), src/main-process/read-only-exports/pending/managed-export.js(2) |
| `validatePendingGuanliHeaders` | 2 | 4 | 1 | src/backend/bank-bu-recon-import/reader.js(2), src/backend/bank-bu-recon-import/validator.js(2) |
| `validatePositionGeneratedArtifact` | 2 | 4 | 2 | src/main-process/read-only-exports/position/business-validator.js(2), src/main-process/read-only-exports/position/managed-export.js(2) |
| `validatePreFundGeneratedArtifact` | 2 | 4 | 2 | src/main-process/read-only-exports/pre-fund/business-validator.js(2), src/main-process/read-only-exports/pre-fund/managed-export.js(2) |
| `validateProtocolSequence` | 2 | 4 | 2 | src/main-process/background-execution/index.js(2), src/main-process/background-execution/protocol-sequence-validator.js(2) |
| `validateStatementArtifactWorkbook` | 2 | 4 | 1 | src/main-process/statement-worker/artifact-descriptor.js(2), src/main-process/statement-worker/publication.js(2) |
| `validateVccFinancialOpGeneratedArtifact` | 2 | 4 | 2 | src/main-process/read-only-exports/vcc-financial-op/business-validator.js(2), src/main-process/read-only-exports/vcc-financial-op/managed-export.js(2) |
| `validateVccSubjectArtifact` | 2 | 4 | 1 | src/main-process/vcc-financial-op-output/artifact-evidence.js(2), src/main-process/vcc-financial-op-output/dispatch.js(2) |
| `VCC_EXPORT_SINGLE_POLICY` | 2 | 4 | 1 | src/main-process/background-execution/runtime.js(2), src/main-process/vcc-financial-op-output/policies.js(2) |
| `VCC_EXPORT_SUBJECTS_POLICY` | 2 | 4 | 1 | src/main-process/background-execution/runtime.js(2), src/main-process/vcc-financial-op-output/policies.js(2) |
| `VCC_FINANCIAL_OP_READ_ONLY_POLICY` | 2 | 4 | 1 | src/main-process/background-execution/runtime.js(2), src/main-process/read-only-exports/vcc-financial-op/policies.js(2) |
| `VCC_SAVE_RUN_INSPECTION_EVIDENCE_VERSION` | 2 | 4 | 1 | src/main-process/vcc-op-calc/save-run-contract.js(2), src/main-process/vcc-op-calc/save-run-inspector.js(2) |
| `verifyPositionImportApplyGrant` | 2 | 4 | 1 | src/backend/position-reconciliation-import/apply-grant.js(2), src/backend/position-reconciliation-import/worker-entry.js(2) |
| `waitForBankBuSpoolsReady` | 2 | 4 | 2 | src/main-process/bank-bu-worker/import-operation.js(2), src/main-process/bank-bu-worker/spool-reader.js(2) |
| `waitForDuplicateSpoolPairReady` | 2 | 4 | 1 | src/main-process/duplicate-inbound-match/spool-reader.js(2), src/main-process/duplicate-inbound-match/worker-host.js(2) |
| `WORKER_PATH` | 2 | 4 | 2 | src/main-process/background-execution/canary/durable-recovery.js(2), src/main-process/vcc-financial-op-service.js(2) |
| `writeAdmMatchFlags` | 2 | 4 | 1 | src/backend/database.js(2), src/backend/database/linked-table-repository.js(2) |
| `writeBankBuInputSpool` | 2 | 4 | 2 | src/main-process/bank-bu-worker/parser-worker-entry.js(2), src/main-process/bank-bu-worker/spool-writer.js(2) |
| `writeBankBuParserSuccess` | 2 | 4 | 1 | src/main-process/bank-bu-worker/dual-parser-dispatch.js(2), src/main-process/bank-bu-worker/parser-outcome.js(2) |
| `writeChannelWorkbooks` | 2 | 4 | 1 | src/main-process/pre-fund-reconciliation/excel-writer.js(2), src/main-process/pre-fund-reconciliation/service.js(2) |
| `writeDuplicateInboundWorkbook` | 2 | 4 | 1 | src/main-process/duplicate-inbound-match/excel-writer.js(2), src/main-process/duplicate-inbound-match/service.js(2) |
| `writeDuplicateInputSpool` | 2 | 4 | 2 | src/main-process/duplicate-inbound-match/parser-worker-entry.js(2), src/main-process/duplicate-inbound-match/spool-writer.js(2) |
| `writeDuplicateParserFailure` | 2 | 4 | 1 | src/main-process/duplicate-inbound-match/paired-parser-dispatch.js(2), src/main-process/duplicate-inbound-match/parser-outcome.js(2) |
| `writeDuplicateParserSuccess` | 2 | 4 | 1 | src/main-process/duplicate-inbound-match/paired-parser-dispatch.js(2), src/main-process/duplicate-inbound-match/parser-outcome.js(2) |
| `writeLinkedWorkbook` | 2 | 4 | 1 | src/main-process/position-reconciliation/excel-io.js(2), src/main-process/position-reconciliation/service.js(2) |
| `writeMptErrorReport` | 2 | 4 | 2 | src/main-process/pre-fund-reconciliation/mpt-error-report-writer.js(2), src/main-process/pre-fund-reconciliation/service.js(2) |
| `writeMptFileSpool` | 2 | 4 | 2 | src/main-process/pre-fund-reconciliation/mpt-import/parser-worker-entry.js(2), src/main-process/pre-fund-reconciliation/mpt-import/spool-writer.js(2) |
| `writeOutputsFromSealedRouteDb` | 2 | 4 | 2 | src/main-process/toolbox-background/output-writer-core.js(2), src/main-process/toolbox-background/output-writer-worker-entry.js(2) |
| `writePositionAnomalyReport` | 2 | 4 | 1 | src/backend/position-reconciliation-import/anomaly-report.js(2), src/backend/position-reconciliation-import/preflight.js(2) |
| `writeRawWorkbook` | 2 | 4 | 1 | src/main-process/position-reconciliation/excel-io.js(2), src/main-process/position-reconciliation/service.js(2) |
| `writeRunWorkbooks` | 2 | 4 | 2 | src/main-process/vcc-financial-op-output/writer-core.js(2), src/main-process/vcc-financial-op-service.js(2) |
| `writeStreamedXlsx` | 2 | 4 | 2 | src/backend/pending-import/streaming-xlsx-writer.js(2), src/main-process/pending-archive-worker.js(2) |
| `AppDatabase` | 2 | 3 | 2 | src/backend/database.js(2), src/main.js(1) |
| `applyScenarioBundleImport` | 2 | 3 | 1 | src/main-process/scenarios-bundle-import.js(2), src/main.js(1) |
| `assembleMonthlyBalance` | 2 | 3 | 1 | src/main-process/monthly-balance.js(2), src/main.js(1) |
| `assertHeadersIdentical` | 2 | 3 | 1 | src/main-process/toolbox.js(2), src/main-process/toolbox-stream-io.js(1) |
| `assertPositionRecoveryInputsUnchanged` | 2 | 3 | 1 | src/main-process/position-reconciliation/operation-lifecycle.js(2), src/main.js(1) |
| `assertRunExportFresh` | 2 | 3 | 1 | src/main-process/acquiring-bill-currency-run-data.js(2), src/main-process/read-only-exports/acquiring/query.js(1) |
| `authorizePositionImportApply` | 2 | 3 | 1 | src/main-process/position-reconciliation/operation-lifecycle.js(2), src/main.js(1) |
| `BIZ_OP_BU_FIELD_DB_COLUMN` | 2 | 3 | 1 | src/backend/biz-op-recon-db/columns.js(2), src/main-process/biz-op-recon-session.js(1) |
| `bizOpReconRunData` | 2 | 3 | 2 | src/main-process/read-only-exports/biz-op/writer.js(2), src/main.js(1) |
| `bizOpRunTerminalRoute` | 2 | 3 | 1 | src/main-process/biz-op-archive-lineage.js(2), src/main.js(1) |
| `buildFrozenRangeExportDb` | 2 | 3 | 1 | src/main-process/biz-op-recon-run-data.js(2), src/main-process/read-only-exports/biz-op/writer.js(1) |
| `buildMergeFileName` | 2 | 3 | 1 | src/main-process/toolbox.js(2), src/main.js(1) |
| `buildSplitFileName` | 2 | 3 | 1 | src/main-process/toolbox.js(2), src/main.js(1) |
| `buildVccImportArchiveHandoffFiles` | 2 | 3 | 1 | src/main-process/vcc-financial-op-archive-lineage.js(2), src/main.js(1) |
| `captureArchiveSourceSnapshots` | 2 | 3 | 1 | src/main-process/archive-center/source-snapshot.js(2), src/main.js(1) |
| `clearRunsByMonth` | 2 | 3 | 1 | src/backend/acquiring-bill-currency-db/run-repository.js(2), src/main-process/acquiring-bill-currency-session.js(1) |
| `clearStaleSuccessfulRawJson` | 2 | 3 | 2 | src/backend/acquiring-bill-currency-db/raw-json-retention.js(2), src/main.js(1) |
| `compareMatchedContent` | 2 | 3 | 1 | src/backend/pending-reconcile/removal-match.js(2), src/backend/pending-export/writer.js(1) |
| `completeRunOutputPublication` | 2 | 3 | 1 | src/backend/acquiring-bill-currency-db/run-repository.js(2), src/main-process/acquiring-bill-currency-session.js(1) |
| `composePositionTerminalSettlement` | 2 | 3 | 1 | src/main-process/read-only-exports/position/settlement.js(2), src/main.js(1) |
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
| `createBusinessFlowResolver` | 2 | 3 | 2 | src/main-process/archive-center/business-flow-resolver.js(2), src/main.js(1) |
| `createDuplicateStartupOutcomeInspector` | 2 | 3 | 1 | src/main-process/duplicate-inbound-match/startup-recovery.js(2), src/main.js(1) |
| `createDuplicateStartupRecoveryProvider` | 2 | 3 | 1 | src/main-process/duplicate-inbound-match/startup-recovery.js(2), src/main.js(1) |
| `createIpcTaskContext` | 2 | 3 | 1 | src/main-process/archive-center/ipc-task-contract.js(2), src/main.js(1) |
| `createLegacyRunMirror` | 2 | 3 | 1 | src/backend/database/pre-fund-reconciliation-run-repository.js(2), src/backend/database.js(1) |
| `createManualBalanceRecoveryPlanTransitions` | 2 | 3 | 1 | src/main-process/manual-balance-seed-settlement.js(2), src/main.js(1) |
| `createManualBalanceSettlementRecoveryProvider` | 2 | 3 | 1 | src/main-process/manual-balance-seed-settlement.js(2), src/main.js(1) |
| `createPendingDatasetSeed` | 2 | 3 | 2 | src/backend/pending-db/dataset-identity.js(2), src/main.js(1) |
| `createPositionReconciliationService` | 2 | 3 | 1 | src/main-process/position-reconciliation/service.js(2), src/main.js(1) |
| `createPositionRunTaskContract` | 2 | 3 | 1 | src/main-process/position-reconciliation/interactive-task-preflight.js(2), src/main.js(1) |
| `createPositionSourceImportTaskContract` | 2 | 3 | 1 | src/main-process/position-reconciliation/interactive-task-preflight.js(2), src/main.js(1) |
| `createPreFundMptHoldGate` | 2 | 3 | 1 | src/main-process/pre-fund-reconciliation/mpt-import/hold-gate.js(2), src/main.js(1) |
| `createPreFundMptOutcomeInspector` | 2 | 3 | 1 | src/main-process/pre-fund-reconciliation/mpt-import/outcome-inspector.js(2), src/main.js(1) |
| `createPreFundMptReceiptAuthority` | 2 | 3 | 1 | src/main-process/pre-fund-reconciliation/mpt-import/receipt-authority.js(2), src/main.js(1) |
| `createPreFundReconciliationService` | 2 | 3 | 1 | src/main-process/pre-fund-reconciliation/service.js(2), src/main.js(1) |
| `createReconFixJpmHoldGate` | 2 | 3 | 1 | src/main-process/recon-id-fix-service/jpm-hold-gate.js(2), src/main.js(1) |
| `createReconFixJpmOutcomeInspector` | 2 | 3 | 1 | src/main-process/recon-id-fix-service/jpm-outcome-inspector.js(2), src/main.js(1) |
| `createReconFixJpmReceiptAuthority` | 2 | 3 | 1 | src/main-process/recon-id-fix-service/jpm-receipt-authority.js(2), src/main.js(1) |
| `createReconFixJpmRecoveryTaskStateReader` | 2 | 3 | 1 | src/main-process/recon-id-fix-service/jpm-recovery-task-state.js(2), src/main.js(1) |
| `createReconFixJpmWorkerDurableCoordinator` | 2 | 3 | 1 | src/main-process/recon-id-fix-service/jpm-worker-durable-coordinator.js(2), src/main.js(1) |
| `createRowInserter` | 2 | 3 | 1 | src/backend/pending-db/month-repository.js(2), src/backend/pending-import/worker.js(1) |
| `createTaskLifecycle` | 2 | 3 | 1 | src/main-process/archive-center/task-lifecycle.js(2), src/main.js(1) |
| `createWindowInstrumentation` | 2 | 3 | 1 | src/main-process/startup-window.js(2), src/main.js(1) |
| `createWorkerDurableCoordinator` | 2 | 3 | 1 | src/main-process/pre-fund-reconciliation/mpt-import/worker-durable-coordinator.js(2), src/main.js(1) |
| `createWorkerDurableCoordinatorRouter` | 2 | 3 | 1 | src/main-process/background-execution/worker-durable-coordinator-router.js(2), src/main.js(1) |
| `deleteMonth` | 2 | 3 | 1 | src/backend/pending-db/month-repository.js(2), src/backend/pending-import/worker.js(1) |
| `deleteMonthBySide` | 2 | 3 | 1 | src/backend/acquiring-bill-currency-db/import-repository.js(2), src/main-process/acquiring-bill-currency-session.js(1) |
| `detectBundleType` | 2 | 3 | 1 | src/backend/scenarios-bundle-io.js(2), src/main.js(1) |
| `detectTableType` | 2 | 3 | 2 | src/main-process/table-type-detector.js(2), src/main.js(1) |
| `encodeAdjustmentLineageName` | 2 | 3 | 1 | src/backend/vcc-financial-op/adjustment-lineage.js(2), src/main-process/vcc-financial-op-writer.js(1) |
| `executeAfterPositionAdmission` | 2 | 3 | 1 | src/main-process/position-reconciliation/interactive-task-preflight.js(2), src/main.js(1) |
| `executeIpcTaskInvocation` | 2 | 3 | 1 | src/main-process/archive-center/ipc-task-contract.js(2), src/main.js(1) |
| `executeManagedPreFundMptImport` | 2 | 3 | 1 | src/main-process/pre-fund-reconciliation/mpt-import/managed-import.js(2), src/main.js(1) |
| `executePendingImportSubmission` | 2 | 3 | 1 | src/main-process/pending-import-preflight.js(2), src/main.js(1) |
| `exportSingleRun` | 2 | 3 | 1 | src/backend/pending-export/writer.js(2), src/main-process/read-only-exports/pending/writer.js(1) |
| `filterRowsByFieldValues` | 2 | 3 | 1 | src/main-process/toolbox.js(2), src/main-process/toolbox-stream-io.js(1) |
| `finalizePendingTerminalIntent` | 2 | 3 | 1 | src/main-process/pending-archive-lineage.js(2), src/main.js(1) |
| `finalizePreFundTerminalIntent` | 2 | 3 | 1 | src/main-process/pre-fund-archive-lineage.js(2), src/main.js(1) |
| `findByChannelAndName` | 2 | 3 | 1 | src/backend/database/scenarios-repository.js(2), src/backend/database.js(1) |
| `freezePendingRunEvidence` | 2 | 3 | 1 | src/main-process/read-only-exports/pending/query.js(2), src/main.js(1) |
| `generateValidateAndPublish` | 2 | 3 | 1 | src/main-process/toolbox-background/generation-validator.js(2), src/main.js(1) |
| `generateValidateAndPublishBizOpExport` | 2 | 3 | 1 | src/main-process/read-only-exports/biz-op/managed-export.js(2), src/main.js(1) |
| `generateValidateAndPublishMultiOutput` | 2 | 3 | 1 | src/main-process/toolbox-background/multi-output-validator.js(2), src/main.js(1) |
| `generateValidateAndPublishPendingExport` | 2 | 3 | 1 | src/main-process/read-only-exports/pending/managed-export.js(2), src/main.js(1) |
| `generateValidateAndPublishPreFundExport` | 2 | 3 | 1 | src/main-process/read-only-exports/pre-fund/managed-export.js(2), src/main.js(1) |
| `getBillDateCounts` | 2 | 3 | 1 | src/backend/acquiring-bill-currency-db/run-repository.js(2), src/main-process/acquiring-bill-currency-writer.js(1) |
| `getEffectiveRunResultForSubject` | 2 | 3 | 1 | src/backend/vcc-financial-op/result-adjustments.js(2), src/main-process/vcc-financial-op-writer.js(1) |
| `getLatestRunByMonth` | 2 | 3 | 1 | src/backend/vcc-op-calc-db/run-repository.js(2), src/main-process/vcc-op-calc-session.js(1) |
| `getLatestRunForMonthPair` | 2 | 3 | 1 | src/backend/pending-db/diff-repository.js(2), src/preload.js(1) |
| `getMappingMap` | 2 | 3 | 1 | src/backend/database/fund-transfer-account-mapping-repository.js(2), src/backend/database.js(1) |
| `getOrCreateStatementImportSession` | 2 | 3 | 1 | src/main-process/statement-session.js(2), src/main.js(1) |
| `getPendingRows` | 2 | 3 | 1 | src/backend/bank-bu-recon-db/month-repository.js(2), src/main-process/bank-bu-recon-session.js(1) |
| `getRunFiles` | 2 | 3 | 1 | src/backend/vcc-op-calc-db/run-repository.js(2), src/main-process/vcc-op-calc/save-run-contract.js(1) |
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
| `insertManagedRun` | 2 | 3 | 1 | src/backend/bank-bu-recon-db/run-repository.js(2), src/main-process/bank-bu-worker/side-database.js(1) |
| `insertRecoveryAudit` | 2 | 3 | 1 | src/backend/database/duplicate-inbound-match-run-repository.js(2), src/main-process/duplicate-inbound-match/startup-recovery.js(1) |
| `insertRunFiles` | 2 | 3 | 1 | src/backend/vcc-op-calc-db/run-repository.js(2), src/main-process/vcc-op-calc/save-run-contract.js(1) |
| `interruptVccOpSaveRunTask` | 2 | 3 | 1 | src/main-process/vcc-op-calc/save-run-lifecycle.js(2), src/main.js(1) |
| `isStorageRootOnOneDrive` | 2 | 3 | 2 | src/main-process/onedrive-detector.js(2), src/main.js(1) |
| `iterateDiffRowsByDateRange` | 2 | 3 | 1 | src/backend/acquiring-bill-currency-db/run-repository.js(2), src/main-process/acquiring-bill-currency-writer.js(1) |
| `LINKED_IMPORT_SIGNATURES` | 2 | 3 | 1 | src/constants/table-signatures.js(2), src/main.js(1) |
| `listAllByChannelId` | 2 | 3 | 1 | src/backend/database/scenarios-repository.js(2), src/backend/database.js(1) |
| `listBuiltinFixedForChannel` | 2 | 3 | 1 | src/backend/database/scenarios-repository.js(2), src/backend/database.js(1) |
| `listDistinctMonths` | 2 | 3 | 1 | src/backend/vcc-op-calc-db/run-repository.js(2), src/main-process/vcc-op-calc-session.js(1) |
| `listImportRecordsByBatch` | 2 | 3 | 1 | src/backend/vcc-financial-op-db/repository.js(2), src/main-process/vcc-financial-op-service.js(1) |
| `listMatchedDiffRowIds` | 2 | 3 | 1 | src/backend/pending-reconcile/removal-match.js(2), src/backend/pending-export/writer.js(1) |
| `listMatchedRemovedRowIds` | 2 | 3 | 1 | src/backend/pending-reconcile/removal-match.js(2), src/backend/pending-export/writer.js(1) |
| `listPartialRuns` | 2 | 3 | 1 | src/backend/acquiring-bill-currency-db/run-repository.js(2), src/main-process/acquiring-bill-currency-run-data.js(1) |
| `listRunReceipts` | 2 | 3 | 1 | src/backend/vcc-op-calc-db/operation-receipt-repository.js(2), src/main-process/vcc-op-calc/save-run-contract.js(1) |
| `listRunsForMonthPair` | 2 | 3 | 1 | src/backend/pending-db/diff-repository.js(2), src/preload.js(1) |
| `loadFundTypeEnum` | 2 | 3 | 2 | src/constants/fund-type-enum.js(2), src/main.js(1) |
| `loadGatewayReconHeaders` | 2 | 3 | 2 | src/constants/gateway-recon-headers-loader.js(2), src/main.js(1) |
| `loadNewAccountSharedStrings` | 2 | 3 | 1 | src/main-process/new-account/strict-worksheet-readback.js(2), src/main-process/new-account/generation-core.js(1) |
| `manualBalanceRecoveryPolicy` | 2 | 3 | 1 | src/main-process/manual-balance-seed-settlement.js(2), src/main.js(1) |
| `markCleanupPending` | 2 | 3 | 1 | src/backend/acquiring-bill-currency-db/run-repository.js(2), src/main-process/acquiring-bill-currency-session.js(1) |
| `matchMerchantIds` | 2 | 3 | 1 | src/main-process/big-account-recognition.js(2), src/main.js(1) |
| `mergeAoaRows` | 2 | 3 | 1 | src/main-process/toolbox.js(2), src/main-process/toolbox-stream-io.js(1) |
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
| `preFundMptRecoveryPlanTransitions` | 2 | 3 | 1 | src/main-process/pre-fund-reconciliation/mpt-import/recovery-plan.js(2), src/main.js(1) |
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
| `readBigAccountMode` | 2 | 3 | 2 | src/backend/big-account-mode-store.js(2), src/main.js(1) |
| `readBigAccountOrder` | 2 | 3 | 2 | src/backend/big-account-order-store.js(2), src/main.js(1) |
| `rebuildAdmDerivation` | 2 | 3 | 1 | src/main-process/linked-derive-rebuild.js(2), src/main.js(1) |
| `rebuildBankDepositBocDerivation` | 2 | 3 | 1 | src/main-process/linked-derive-rebuild.js(2), src/main.js(1) |
| `rebuildFundTransferReconDerivation` | 2 | 3 | 1 | src/main-process/linked-derive-rebuild.js(2), src/main.js(1) |
| `rebuildFxBocDerivation` | 2 | 3 | 1 | src/main-process/linked-derive-rebuild.js(2), src/main.js(1) |
| `reconcileVccImportArchiveLineageAtStartup` | 2 | 3 | 1 | src/main-process/vcc-financial-op-archive-lineage.js(2), src/main.js(1) |
| `reconFixJpmRecoveryPlanTransitions` | 2 | 3 | 1 | src/main-process/recon-id-fix-service/jpm-recovery-plan.js(2), src/main.js(1) |
| `recordFromBankStatementRows` | 2 | 3 | 1 | src/backend/database/channel-enum-repository.js(2), src/backend/database.js(1) |
| `recoverPendingRunReceipts` | 2 | 3 | 1 | src/main-process/pending-archive-lineage.js(2), src/main.js(1) |
| `recoverPreFundRunReceipts` | 2 | 3 | 1 | src/main-process/pre-fund-archive-lineage.js(2), src/main.js(1) |
| `recoverVccImportArchiveTasks` | 2 | 3 | 1 | src/main-process/vcc-financial-op-archive-lineage.js(2), src/main.js(1) |
| `REFUND_BACKFILL_FIELD_MAP` | 2 | 3 | 1 | src/constants/refund-backfill-fields.js(2), src/main-process/scenario-engines/r5-refund-order-backfill.js(1) |
| `removeStatementSessionEntriesByFilePath` | 2 | 3 | 1 | src/main-process/statement-session.js(2), src/main.js(1) |
| `reportStartupFailure` | 2 | 3 | 1 | src/backend/startup-failure.js(2), src/main.js(1) |
| `resolveBalanceAdjustment` | 2 | 3 | 1 | src/main-process/statement-generation-business.js(2), src/main.js(1) |
| `resolveManualBalanceSeedFilePlanInputPaths` | 2 | 3 | 1 | src/main-process/manual-balance-seed-preflight.js(2), src/main.js(1) |
| `resolveManualBalanceTargetAlias` | 2 | 3 | 1 | src/main-process/manual-balance-seed-settlement.js(2), src/main.js(1) |
| `resolveRecognizedBigAccount` | 2 | 3 | 1 | src/main-process/big-account-recognition.js(2), src/main.js(1) |
| `RESULT_SHEET_NAME` | 2 | 3 | 1 | src/main-process/vcc-financial-op-output/artifact-evidence.js(2), src/main-process/vcc-financial-op-writer.js(1) |
| `resumeRunCheck` | 2 | 3 | 1 | src/main-process/acquiring-bill-currency-run-data.js(2), src/main-process/background-execution/adapters/acquiring-adapter.js(1) |
| `runCheckViaSideDb` | 2 | 3 | 1 | src/main-process/acquiring-bill-currency-run-data.js(2), src/main-process/background-execution/adapters/acquiring-adapter.js(1) |
| `runCheckWorkerPool` | 2 | 3 | 2 | src/main-process/background-execution/adapters/acquiring-adapter.js(2), src/main.js(1) |
| `runLegacyReconciliation` | 2 | 3 | 2 | src/backend/pending-reconcile/engine.js(2), src/main-process/biz-op-recon-session.js(1) |
| `runOwnAccountsMigration` | 2 | 3 | 2 | src/backend/database/own-accounts-migration.js(2), src/main.js(1) |
| `runPipeline` | 2 | 3 | 1 | src/backend/big-table-import/pipeline.js(2), src/backend/big-table-import/engine.js(1) |
| `runPositionOperationLifecycle` | 2 | 3 | 1 | src/main-process/position-reconciliation/operation-lifecycle.js(2), src/main.js(1) |
| `runWithPreparedResourceCleanup` | 2 | 3 | 1 | src/main-process/position-reconciliation/interactive-task-preflight.js(2), src/main.js(1) |
| `sameExactReceipt` | 2 | 3 | 1 | src/backend/database/recon-fix-operation-receipt-repository.js(2), src/main-process/recon-id-fix-service/jpm-writeback-transaction.js(1) |
| `scanFxGroups` | 2 | 3 | 1 | src/main-process/boc-fx-link-builder.js(2), src/main.js(1) |
| `scanNewAccountWorksheetRows` | 2 | 3 | 1 | src/main-process/new-account/strict-worksheet-readback.js(2), src/main-process/new-account/generation-core.js(1) |
| `selectSuccessfulPathsByResultIndex` | 2 | 3 | 1 | src/main-process/archive-center/operation-tracker.js(2), src/main.js(1) |
| `serializeScenarioBundle` | 2 | 3 | 1 | src/backend/scenarios-bundle-io.js(2), src/main.js(1) |
| `setApplicableChannelIds` | 2 | 3 | 1 | src/backend/database/scenarios-repository.js(2), src/backend/database.js(1) |
| `settlePositionArchiveResult` | 2 | 3 | 1 | src/main-process/position-reconciliation/operation-lifecycle.js(2), src/main.js(1) |
| `settlePositionRecoveredTask` | 2 | 3 | 1 | src/main-process/position-reconciliation/operation-lifecycle.js(2), src/main.js(1) |
| `shouldAcceptInitialRendererMetrics` | 2 | 3 | 1 | src/main-process/startup-window.js(2), src/main.js(1) |
| `shouldUseLargeChannel` | 2 | 3 | 2 | src/main-process/toolbox-large-split-router.js(2), src/main.js(1) |
| `showComingSoon` | 2 | 3 | 1 | src/renderer.js(2), src/renderer-dialogs.js(1) |
| `showReadyWindow` | 2 | 3 | 1 | src/main-process/startup-window.js(2), src/main.js(1) |
| `STAGING_ROW_INSERT_SQL` | 2 | 3 | 1 | src/backend/vcc-financial-op-db/repository.js(2), src/backend/vcc-financial-op/detail-importer.js(1) |
| `streamLinkedRowsToInsert` | 2 | 3 | 2 | src/main-process/linked-table-stream-source.js(2), src/main.js(1) |
| `toBalanceRows` | 2 | 3 | 1 | src/main-process/monthly-balance.js(2), src/main.js(1) |
| `updateRunStats` | 2 | 3 | 1 | src/backend/pending-db/diff-repository.js(2), src/backend/pending-reconcile/engine.js(1) |
| `upsertMonthMeta` | 2 | 3 | 1 | src/backend/pending-db/month-repository.js(2), src/backend/pending-import/worker.js(1) |
| `vccFinancialOpErrorResult` | 2 | 3 | 2 | src/main-process/vcc-financial-op-ipc.js(2), src/main.js(1) |
| `waitForWindowReady` | 2 | 3 | 1 | src/main-process/startup-window.js(2), src/main.js(1) |
| `writeBankStatementOutput` | 2 | 3 | 1 | src/main-process/exceljs-writer.js(2), src/main-process/bank-statement-io.js(1) |
| `writeBigAccountMode` | 2 | 3 | 2 | src/backend/big-account-mode-store.js(2), src/main.js(1) |
| `writeBigAccountOrder` | 2 | 3 | 2 | src/backend/big-account-order-store.js(2), src/main.js(1) |
| `writeManualBalanceSeedPlan` | 2 | 3 | 1 | src/main-process/manual-balance-seed-preflight.js(2), src/main.js(1) |
| `writePendingManagedErrorSource` | 2 | 3 | 1 | src/main-process/read-only-exports/pending/managed-export.js(2), src/main.js(1) |
| `writeRunOutputs` | 2 | 3 | 1 | src/main-process/acquiring-bill-currency-writer.js(2), src/main-process/acquiring-bill-currency-session.js(1) |
| `xmlAttrUnescape` | 2 | 3 | 2 | src/backend/biz-op-recon-import/reader-streamed.js(2), src/backend/big-table-import/zip-reader.js(1) |
| `CELL_OPEN_RE` | 2 | 2 | 2 | src/backend/acquiring-bill-currency-import/reader-handrolled.js(1), src/backend/pending-import/streaming-xlsx-reader.js(1) |
| `CELL_R_RE` | 2 | 2 | 2 | src/backend/acquiring-bill-currency-import/reader-handrolled.js(1), src/backend/pending-import/streaming-xlsx-reader.js(1) |
| `NEW_ACCOUNT_EXPORT_NAME` | 2 | 2 | 1 | src/main-process/new-account/generation-core.js(1), src/main.js(1) |
| `readMeaningfulRowsHead` | 2 | 2 | 1 | src/backend/file-service/readers.js(1), src/main-process/table-type-detector.js(1) |
| `WINDOWS_RESERVED_NAMES` | 2 | 2 | 2 | src/main-process/bank-statement-io.js(1), src/main-process/recon-id-fix-io.js(1) |
