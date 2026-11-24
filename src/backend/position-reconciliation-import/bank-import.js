'use strict';

// 平盘银行对账单单遍导入：暂存复制（顺带算一次 SHA-256，作存档与恢复凭证）后只解析一遍，
// 校验通过的行在同一个侧库事务里直接写入；解析完成后事务保持未提交，等 Main 送来
// 确认授权再提交，被拒绝、取消或进程退出则整体回滚，库内数据不变。
// 不再有预检遍、导入账本、逐行内容摘要和写入前的文件再哈希。
// 每份文件登记一个原始账单版本号；行只保存交互字段，并记下版本号与原始行号。

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const {
  BANK_STATUSES
} = require('../../main-process/position-reconciliation/constants');
const {
  BANK_RAW_FILE_KIND,
  BANK_VALUE_COLUMNS,
  RAW_FILE_STATUSES,
  bankValueColumnsFromFields,
  insertRawFileStatement,
  markSupersededBankRawFiles,
  pickInteractionFields
} = require('../../main-process/position-reconciliation/bank-row-storage');
const {
  PositionReconciliationError,
  normalizeDate,
  text
} = require('../../main-process/position-reconciliation/common');
const {
  STAGING_RELATIVE_PATH,
  stageInputFilesAsync
} = require('../../main-process/position-reconciliation/input-staging');
const {
  normalizePositionCheckpoint,
  positionCheckpointsEqual,
  runPositionSideDbMutation
} = require('../../main-process/position-reconciliation/side-db-mutation');
const {
  POSITION_IMPORT_PROGRESS_ROW_INTERVAL
} = require('./constants');
const {
  assertPositionImportDiskSpace
} = require('./disk-space-gate');
const {
  assertNotCancelled,
  assertPositionSchemaCurrent,
  assertStagedFileUntouched,
  bumpRevision,
  configureImportDatabase,
  truncateWalAfterCommit
} = require('./import-common');
const {
  readerFor
} = require('./reader-select');

const MAX_CONFLICT_DETAIL_LINES = 50;
function bankScopeKey(channel, monthKey) {
  return `${text(channel)}\u0000${text(monthKey)}`;
}

function inputEvidenceFor(file) {
  return {
    role: 'input',
    sourceType: 'position-bank',
    filePath: file.archivePath,
    originalName: file.fileName,
    sourceSnapshot: file.stagedSnapshot,
    expectedSha256: file.stagedSha256,
    sizeBytes: file.stagedSizeBytes
  };
}

function acceptedFileFor(descriptor, stats) {
  return {
    status: 'ok',
    fileIndex: descriptor.fileIndex,
    filePath: descriptor.sourceFilePath,
    archivePath: descriptor.archivePath,
    stagingDir: descriptor.stagingDir,
    fileName: descriptor.sourceFileName,
    sourceType: 'bank',
    sheetName: stats.sheetName,
    rowCount: stats.rowCount,
    physicalRowCount: stats.rowCount,
    dateMin: stats.dateMin,
    dateMax: stats.dateMax,
    sharedStringsMode: stats.sharedStringsMode,
    sharedStringsCount: stats.sharedStringsCount,
    rawVersion: stats.rawVersion,
    stagedSnapshot: descriptor.stagedSnapshot,
    stagedSha256: descriptor.stagedSha256,
    stagedSizeBytes: descriptor.stagedSizeBytes
  };
}

function normalizeApplyGrant(grant, { jobId, baseCheckpoint, fileCount }) {
  const payload = grant && typeof grant === 'object' && !Array.isArray(grant) ? grant : {};
  const operationToken = text(payload.operationToken);
  const grantedCheckpoint = normalizePositionCheckpoint(
    payload.baseCheckpoint,
    '导入确认基准 checkpoint'
  );
  if (text(payload.jobId) !== text(jobId)
      || !operationToken
      || !payload.batchContext
      || !positionCheckpointsEqual(grantedCheckpoint, baseCheckpoint)) {
    throw new PositionReconciliationError(
      'position-import-intent-not-durable',
      '平盘银行导入确认授权与本次导入不一致'
    );
  }
  const archivePaths = Array.isArray(payload.archivePaths) ? payload.archivePaths : [];
  if (archivePaths.length !== 0 && archivePaths.length !== fileCount) {
    throw new PositionReconciliationError(
      'position-import-intent-not-durable',
      '平盘银行导入确认授权的存档路径数量不一致'
    );
  }
  return {
    operationToken,
    archivePaths,
    batchNumber: text(payload.batchContext && payload.batchContext.batchNumber)
  };
}

async function runPositionBankImport(input = {}) {
  const jobId = String(input.jobId || '').trim();
  const files = Array.isArray(input.files) ? input.files : [];
  const userDataDir = path.resolve(String(input.userDataDir || ''));
  const sideDbPath = String(input.sideDbPath || '').trim();
  const baseCheckpoint = normalizePositionCheckpoint(
    input.expectedCheckpoint,
    '导入基准 checkpoint'
  );
  if (!jobId || !String(input.userDataDir || '').trim() || files.length === 0) {
    throw new TypeError('银行导入需要 jobId、userDataDir 和 files');
  }
  if (!sideDbPath || !baseCheckpoint) {
    throw new PositionReconciliationError(
      'position-side-db-mismatch',
      '平盘银行导入缺少侧库路径或基准 checkpoint'
    );
  }
  if (typeof input.awaitApplyGrant !== 'function') {
    throw new TypeError('银行导入缺少确认授权通道');
  }
  const cancelToken = input.cancelToken && typeof input.cancelToken === 'object'
    ? input.cancelToken
    : { cancelled: false };
  const onProgress = typeof input.onProgress === 'function' ? input.onProgress : null;
  const startedAt = Date.now();
  const jobRoot = path.join(userDataDir, STAGING_RELATIVE_PATH, jobId);
  let committed = false;
  let handedOff = false;
  let db = null;

  try {
    const staged = await stageInputFilesAsync(userDataDir, files, jobId, {
      cancelToken,
      onProgress: onProgress ? (progress) => onProgress({
        stage: 'staging',
        currentFile: progress.fileIndex + 1,
        totalFiles: files.length,
        fileName: progress.fileName,
        scannedRows: 0,
        acceptedRows: 0,
        committedRows: 0,
        copiedBytes: progress.copiedBytes,
        totalBytes: progress.totalBytes,
        elapsedMs: Date.now() - startedAt
      }) : null
    });
    assertNotCancelled(cancelToken);
    assertPositionImportDiskSpace({
      kind: 'bank',
      sideDbPath,
      rowCount: 0,
      stagedBytes: staged.reduce((sum, file) => sum + Number(file.stagedSizeBytes || 0), 0),
      // 行数要读完才知道：按暂存文件大小估算行数据与 WAL 的增长，在改动旧数据之前拦住空间不足。
      estimateGrowthFromStagedBytes: true,
      availableBytes: input.availableBytes
    });

    db = new DatabaseSync(path.resolve(sideDbPath));
    configureImportDatabase(db);
    assertPositionSchemaCurrent(db);
    let acceptedFiles = [];
    let grant = null;

    const mutation = await runPositionSideDbMutation({
      db,
      expectedCheckpoint: baseCheckpoint,
      operationToken: () => (grant ? grant.operationToken : ''),
      inputEvidence: () => acceptedFiles.map(inputEvidenceFor),
      fallbackSourceType: 'position-bank',
      requireExternalOperationToken: true,
      mutate: async () => {
        // 自增主键不会回退：本次写入的行 id 一定大于此前出现过的最大 id，据此区分新旧行。
        const sequence = db.prepare(
          "SELECT seq FROM sqlite_sequence WHERE name = 'position_bank_rows'"
        ).get();
        const previousMaxId = Number(sequence && sequence.seq || 0);
        const deleteOldScope = db.prepare(`
          DELETE FROM position_bank_rows
          WHERE channel = ? AND month_key = ? AND id <= ?
        `);
        const insert = db.prepare(`
          INSERT INTO position_bank_rows(
            biz_id, channel, month_key, bill_date, status,
            raw_version, raw_row_number, import_order,
            original_fund_type, working_fund_type, hit_summary, hit_type, match_detail,
            ${BANK_VALUE_COLUMNS.join(', ')}
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', '', '', ${BANK_VALUE_COLUMNS.map(() => '?').join(', ')})
        `);
        const findByBizId = db.prepare(`
          SELECT id, channel, month_key AS monthKey,
                 raw_version AS rawVersion, raw_row_number AS rowNumber
          FROM position_bank_rows
          WHERE biz_id = ?
        `);
        const insertRawFile = insertRawFileStatement(db);
        const finishRawFile = db.prepare(
          'UPDATE position_raw_files SET sheet_name = ?, row_count = ? WHERE version = ?'
        );
        const fileIndexByVersion = new Map();
        const scopes = new Map();
        // 与旧数据撞 BizId 的行先挂起：旧行所在的渠道 + 月份可能在后面才出现并被整体替换，
        // 全部读完后再补写一次，仍冲突才是真冲突。挂起的行放事务内的临时表，不随行数占用进程内存。
        db.exec(`
          CREATE TEMP TABLE IF NOT EXISTS position_import_deferred_bank (
            seq INTEGER PRIMARY KEY,
            file_name TEXT NOT NULL,
            row_number INTEGER NOT NULL,
            values_json TEXT NOT NULL
          );
          DELETE FROM position_import_deferred_bank;
        `);
        const deferRow = db.prepare(`
          INSERT INTO position_import_deferred_bank(file_name, row_number, values_json)
          VALUES (?, ?, ?)
        `);
        let deferredRows = 0;
        let importOrder = 0;
        let insertedRows = 0;

        const reportProgress = (stage, filePosition, descriptor, scannedRows) => {
          if (!onProgress) return;
          onProgress({
            stage,
            currentFile: filePosition + 1,
            totalFiles: staged.length,
            fileName: descriptor.sourceFileName,
            scannedRows,
            acceptedRows: insertedRows + deferredRows,
            committedRows: 0,
            elapsedMs: Date.now() - startedAt
          });
        };

        const collected = [];
        for (let filePosition = 0; filePosition < staged.length; filePosition += 1) {
          assertNotCancelled(cancelToken);
          const descriptor = staged[filePosition];
          const stats = {
            sheetName: '',
            rowCount: 0,
            dateMin: null,
            dateMax: null,
            sharedStringsMode: null,
            sharedStringsCount: null
          };
          const read = readerFor(descriptor.filePath);
          // 版本号在文件开始时分配；本批任何文件失败都会随事务一起回滚。
          const rawVersion = Number(insertRawFile.run(
            BANK_RAW_FILE_KIND,
            descriptor.sourceFileName,
            path.resolve(descriptor.sourceFilePath),
            '',
            Number(descriptor.stagedSizeBytes || 0),
            String(descriptor.stagedSha256 || ''),
            RAW_FILE_STATUSES.ACTIVE,
            '',
            ''
          ).lastInsertRowid);
          fileIndexByVersion.set(rawVersion, descriptor.fileIndex);
          stats.rawVersion = rawVersion;
          reportProgress('importing', filePosition, descriptor, 0);
          const summary = await read(descriptor.filePath, {
            kind: 'bank',
            cancelToken,
            allowMainThread: false,
            sstTempRoot: path.join(descriptor.stagingDir, 'sst'),
            ...(input.sstOptions || {}),
            // 银行对账单导入识别结构当前用户版本（D17，Main 在导入开始时冻结）；行已对应回内置 46 列名。
            bankSourceHeaders: input.bankSourceHeaders || null,
            onRow: ({ row, excelRowNumber, sheetName: detectedSheet }) => {
              stats.sheetName = detectedSheet;
              const bankRow = pickInteractionFields(row);
              const bizId = text(bankRow.BizId);
              const channel = text(bankRow.Channel);
              const billDate = normalizeDate(bankRow.BillDate);
              const monthKey = billDate ? billDate.slice(0, 7) : '';
              const errors = [];
              if (!bizId) errors.push('BizId 为空');
              if (!channel) errors.push('Channel 为空');
              if (!billDate || !monthKey) {
                errors.push(`BillDate 无法解析：${text(bankRow.BillDate) || '(空)'}`);
              }
              if (errors.length > 0) {
                throw new PositionReconciliationError(
                  'position-bank-row-invalid',
                  `银行对账单存在非法行：${descriptor.sourceFileName} 第 ${excelRowNumber} 行`,
                  errors
                );
              }
              const key = bankScopeKey(channel, monthKey);
              let scope = scopes.get(key);
              if (!scope) {
                const removed = deleteOldScope.run(channel, monthKey, previousMaxId);
                scope = {
                  channel,
                  monthKey,
                  rowCount: 0,
                  replacedRowCount: Number(removed.changes || 0),
                  fileIndexes: new Set()
                };
                scopes.set(key, scope);
              }
              scope.fileIndexes.add(descriptor.fileIndex);
              const fundType = text(bankRow.FundType);
              const values = [
                bizId,
                channel,
                monthKey,
                billDate,
                BANK_STATUSES.UNPROCESSED,
                rawVersion,
                excelRowNumber,
                importOrder,
                fundType,
                fundType,
                ...bankValueColumnsFromFields(bankRow)
              ];
              try {
                insert.run(...values);
                insertedRows += 1;
              } catch (insertError) {
                const existing = findByBizId.get(bizId);
                if (!existing) throw insertError;
                if (Number(existing.id) > previousMaxId) {
                  const firstFileIndex = fileIndexByVersion.get(Number(existing.rawVersion));
                  throw new PositionReconciliationError(
                    'position-bank-row-invalid',
                    `银行对账单存在非法行：${descriptor.sourceFileName} 第 ${excelRowNumber} 行`,
                    [
                      `BizId 与第 ${Number(firstFileIndex ?? descriptor.fileIndex) + 1} 个文件` +
                      `第 ${Number(existing.rowNumber)} 行重复`
                    ]
                  );
                }
                deferRow.run(descriptor.sourceFileName, excelRowNumber, JSON.stringify(values));
                deferredRows += 1;
              }
              importOrder += 1;
              scope.rowCount += 1;
              stats.rowCount += 1;
              if (!stats.dateMin || billDate < stats.dateMin) stats.dateMin = billDate;
              if (!stats.dateMax || billDate > stats.dateMax) stats.dateMax = billDate;
              if (stats.rowCount % POSITION_IMPORT_PROGRESS_ROW_INTERVAL === 0) {
                assertNotCancelled(cancelToken);
                reportProgress('importing', filePosition, descriptor, stats.rowCount);
              }
            }
          });
          stats.sheetName = stats.sheetName || summary.sheetName;
          stats.sharedStringsMode = summary.sharedStringsMode;
          stats.sharedStringsCount = summary.sharedStringsCount;
          if (stats.rowCount === 0) {
            throw new PositionReconciliationError(
              'position-bank-empty',
              `银行对账单没有可导入的数据行：${descriptor.sourceFileName}`
            );
          }
          finishRawFile.run(stats.sheetName, stats.rowCount, rawVersion);
          reportProgress('importing', filePosition, descriptor, stats.rowCount);
          collected.push(acceptedFileFor(descriptor, stats));
        }

        const conflicts = [];
        if (deferredRows > 0) {
          const pendingRows = db.prepare(`
            SELECT file_name AS fileName, row_number AS rowNumber, values_json AS valuesJson
            FROM position_import_deferred_bank
            ORDER BY seq
          `).iterate();
          for (const item of pendingRows) {
            const values = JSON.parse(item.valuesJson);
            try {
              insert.run(...values);
              insertedRows += 1;
            } catch (insertError) {
              const existing = findByBizId.get(values[0]);
              if (!existing) throw insertError;
              if (Number(existing.id) > previousMaxId) {
                throw new PositionReconciliationError(
                  'position-bank-row-invalid',
                  `银行对账单存在非法行：${item.fileName} 第 ${Number(item.rowNumber)} 行`,
                  [`BizId 与本次导入的第 ${Number(existing.rowNumber)} 行重复`]
                );
              }
              if (conflicts.length < MAX_CONFLICT_DETAIL_LINES) {
                conflicts.push(
                  `BizId=${values[0]}：已存在于 ${existing.channel}/${existing.monthKey}，` +
                  `本次文件位于 ${values[1]}/${values[2]}`
                );
              }
            }
          }
          db.exec('DELETE FROM position_import_deferred_bank');
        }
        if (conflicts.length > 0) {
          throw new PositionReconciliationError(
            'position-bank-existing-bizid-conflict',
            '导入文件的 BizId 与其他 Channel 或月份中的银行数据冲突',
            conflicts
          );
        }
        if (insertedRows !== importOrder) {
          throw new PositionReconciliationError(
            'position-import-preflight-apply-mismatch',
            '银行对账单整批写入行数不守恒',
            [`读取 ${importOrder} 行，写入 ${insertedRows} 行`]
          );
        }

        const orderedScopes = [...scopes.values()].sort((left, right) => (
          left.channel < right.channel ? -1
            : left.channel > right.channel ? 1
              : left.monthKey < right.monthKey ? -1
                : left.monthKey > right.monthKey ? 1 : 0
        ));
        // 行已全部被本次导入替换掉的旧版本标为「已被替换」。
        markSupersededBankRawFiles(db);
        for (const scope of orderedScopes) {
          bumpRevision(db, 'bank', bankScopeKey(scope.channel, scope.monthKey));
        }
        bumpRevision(db, 'bank-global', 'all');

        acceptedFiles = collected;
        const bankScopes = orderedScopes.map((scope) => ({
          channel: scope.channel,
          monthKey: scope.monthKey,
          rowCount: scope.rowCount,
          replacedRowCount: scope.replacedRowCount
        }));
        const fileScopes = orderedScopes.flatMap((scope) => (
          [...scope.fileIndexes].sort((left, right) => left - right).map((fileIndex) => ({
            fileIndex,
            channel: scope.channel,
            monthKey: scope.monthKey
          }))
        )).sort((left, right) => left.fileIndex - right.fileIndex);

        const ready = {
          jobId,
          kind: 'bank',
          singlePass: true,
          jobRoot,
          rowCount: importOrder,
          bankScopes,
          fileScopes,
          acceptedBankFiles: acceptedFiles,
          orderedFileResults: acceptedFiles
        };
        // 事务保持未提交：等待确认期间其他连接看到的仍是旧数据。
        assertNotCancelled(cancelToken);
        grant = normalizeApplyGrant(await input.awaitApplyGrant(ready), {
          jobId,
          baseCheckpoint,
          fileCount: acceptedFiles.length
        });
        if (grant.archivePaths.length > 0) {
          acceptedFiles = acceptedFiles.map((file, index) => ({
            ...file,
            archivePath: path.resolve(String(grant.archivePaths[index] || file.archivePath))
          }));
        }
        // 拿到写入授权即表示 Main 已把这些暂存文件登记进待完成操作与存档清单：
        // 此后无论提交成败，暂存目录都由 Main 按存档状态回收，导入进程不再删除。
        handedOff = true;
        for (const file of acceptedFiles) await assertStagedFileUntouched(file);
        // 授权后导入进程已进入不可取消阶段；这里再核一次，防止取消与授权同时到达时仍然提交。
        assertNotCancelled(cancelToken);
        // 版本记录补上本次操作凭证与存档批次号，便于从版本号找到存档中心里的原件。
        const bindRawFile = db.prepare(`
          UPDATE position_raw_files
          SET operation_token = ?, archive_batch_number = ?
          WHERE version = ?
        `);
        for (const file of acceptedFiles) {
          bindRawFile.run(grant.operationToken, grant.batchNumber, Number(file.rawVersion));
        }
        if (onProgress) {
          onProgress({
            stage: 'committing',
            currentFile: staged.length,
            totalFiles: staged.length,
            fileName: staged[staged.length - 1].sourceFileName,
            scannedRows: importOrder,
            acceptedRows: importOrder,
            committedRows: importOrder,
            elapsedMs: Date.now() - startedAt
          });
        }
        return {
          rowCount: importOrder,
          scopes: bankScopes.map(({ channel, monthKey }) => ({ channel, monthKey })),
          bankScopes,
          fileScopes,
          rawVersions: acceptedFiles.map((file) => ({
            fileIndex: file.fileIndex,
            fileName: file.fileName,
            version: Number(file.rawVersion)
          }))
        };
      }
    });
    committed = true;
    truncateWalAfterCommit(db);
    const evidence = acceptedFiles.map(inputEvidenceFor);
    return {
      ...mutation.result,
      inputEvidence: evidence,
      nextCheckpoint: mutation.nextCheckpoint,
      inputPaths: acceptedFiles.map((file) => file.archivePath),
      inputFiles: evidence,
      originalInputPaths: acceptedFiles.map((file) => file.filePath),
      cleanupPaths: [jobRoot],
      jobId
    };
  } catch (error) {
    if (!committed && !handedOff) {
      if (db) {
        try { db.close(); } catch (_closeError) { /* 保留原始错误 */ }
        db = null;
      }
      await fs.promises.rm(jobRoot, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100
      }).catch(() => undefined);
    }
    throw error;
  } finally {
    if (db) {
      try { db.close(); } catch (_closeError) { /* 关闭失败不覆盖结果 */ }
    }
  }
}

module.exports = {
  runPositionBankImport,
  bankScopeKey,
  inputEvidenceFor
};
