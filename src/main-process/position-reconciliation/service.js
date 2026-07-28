'use strict';

const crypto = require('node:crypto');
const path = require('node:path');

const {
  SOURCE_TYPES,
  SOURCE_DEFINITIONS,
  BANK_STATUSES,
  MATCH_TYPES,
  FUND_TYPE_PAIRS,
  POSITION_BANK_HEADERS,
  SOURCE_TYPE_BY_FUND_TYPE,
  sourceTypeForFundType
} = require('./constants');
const {
  PositionReconciliationError,
  text,
  normalizeDate,
  stableHash
} = require('./common');
const { readBankFiles, readSourceFiles } = require('./readers');
const {
  writeResultWorkbook,
  writeLinkedWorkbook,
  writeRawWorkbook,
  readResultWorkbook
} = require('./excel-io');
const {
  createPositionReconciliationStore,
  scopeKey
} = require('./store');
const {
  runPositionFundNatureCheck
} = require('./matching-engine');
const {
  stageInputFiles,
  assertStagedInputUnchanged,
  cleanupStagingPaths,
  pruneStagingRoot
} = require('./input-staging');
const {
  parsePositionPendingArchiveFiles
} = require('./operation-lifecycle');

const FUND_TYPE_PAIR_BY_VALUE = new Map();
const SOURCE_BY_FUND_TYPE = new Map(Object.entries(SOURCE_TYPE_BY_FUND_TYPE));
for (const pair of FUND_TYPE_PAIRS) {
  FUND_TYPE_PAIR_BY_VALUE.set(pair[0], pair);
  FUND_TYPE_PAIR_BY_VALUE.set(pair[1], pair);
}

function runScopeOf(bankRows) {
  const channels = [...new Set(bankRows.map((row) => row.channel))];
  const months = [...new Set(bankRows.map((row) => row.month_key))];
  const scopes = [...new Set(bankRows.map((row) => scopeKey(row.channel, row.month_key)))];
  return { channels, months, scopes };
}

function requiredSourceTypes(bankRows) {
  return [...new Set(
    bankRows
      .map((row) => sourceTypeForFundType(row.working_fund_type))
      .filter(Boolean)
  )];
}

function requireScopeSelection(payload, actionLabel) {
  const channels = [...new Set(
    (Array.isArray(payload && payload.channels) ? payload.channels : []).map(text).filter(Boolean)
  )];
  const months = [...new Set(
    (Array.isArray(payload && payload.months) ? payload.months : []).map(text).filter(Boolean)
  )];
  if (channels.length === 0 || months.length === 0) {
    throw new PositionReconciliationError(
      'position-scope-selection-empty',
      `${actionLabel}前请至少选择一个银行渠道和一个月份`
    );
  }
  return { channels, months };
}

function assertEngineResultSet(engineRows, bankRows) {
  const results = Array.isArray(engineRows) ? engineRows : [];
  const expected = new Set(bankRows.map((row) => text(row.biz_id)).filter(Boolean));
  const seen = new Set();
  const duplicates = [];
  const unknown = [];
  for (const result of results) {
    const bizId = text(result && (result.bizId || result.bankRow?._positionBizId));
    if (!expected.has(bizId)) {
      unknown.push(bizId || '(空)');
      continue;
    }
    if (seen.has(bizId)) duplicates.push(bizId);
    seen.add(bizId);
  }
  const missing = [...expected].filter((bizId) => !seen.has(bizId));
  if (
    results.length !== bankRows.length
    || duplicates.length > 0
    || unknown.length > 0
    || missing.length > 0
  ) {
    throw new PositionReconciliationError(
      'position-run-row-conservation',
      '运行结果 BizId 集合不守恒',
      [
        `输入 ${bankRows.length} 行，输出 ${results.length} 行`,
        duplicates.length ? `重复：${duplicates.slice(0, 20).join(' / ')}` : '',
        unknown.length ? `未知：${unknown.slice(0, 20).join(' / ')}` : '',
        missing.length ? `缺少：${missing.slice(0, 20).join(' / ')}` : ''
      ].filter(Boolean)
    );
  }
}

function sourceConsumptionKey(sourceType, businessKey, legIndex) {
  return `${text(sourceType)}\u0000${text(businessKey)}\u0000${Number(legIndex)}`;
}

function priorBankConsumptionConflict(priorConsumption, result) {
  if (!priorConsumption || !result || result.isDifference || result.outcome === 'not-applicable') {
    return null;
  }
  const lineage = result.lineage || {};
  const currentKey = sourceConsumptionKey(
    lineage.sourceType,
    lineage.sourceBusinessKey,
    lineage.sourceLegIndex
  );
  const priorKey = sourceConsumptionKey(
    priorConsumption.sourceType,
    priorConsumption.businessKey,
    priorConsumption.legIndex
  );
  if (currentKey === priorKey) return null;
  return {
    detail:
      `银行BizId已在已确认运行#${priorConsumption.runId}消费链接记录` +
      `${priorConsumption.sourceType}/${priorConsumption.businessKey}/${priorConsumption.legIndex}，` +
      '禁止改配到其他链接记录',
    lineage: {
      pairKey: lineage.pairKey || null,
      sourceType: lineage.sourceType || null,
      reasonCode: 'position-bank-counterparty-reassigned',
      reasons: ['同一银行BizId不能跨已确认运行改配到其他链接记录'],
      priorConsumption: {
        runId: priorConsumption.runId,
        sourceType: priorConsumption.sourceType,
        businessKey: priorConsumption.businessKey,
        legIndex: priorConsumption.legIndex
      }
    }
  };
}

function resultRowForExport(row) {
  return {
    ...row.resultRow,
    命中明细: row.hit_summary || '',
    命中类型: row.hit_type || '',
    匹配命中详情: row.match_detail || ''
  };
}

function formatTimestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    pad(date.getHours()),
    pad(date.getMinutes())
  ].join('');
}

function stagedInputArchiveFile(file, sourceType = '') {
  return {
    filePath: path.resolve(String(file && (file.archivePath || file.filePath) || '')),
    sourceType: text(sourceType || (file && file.sourceType)) || 'position-input',
    sourceSnapshot: file && file.stagedSnapshot,
    expectedSha256: file && file.stagedSha256,
    sizeBytes: file && file.stagedSizeBytes,
    originalName: text(file && (file.fileName || file.sourceFileName))
      || path.basename(String(file && (file.archivePath || file.filePath) || ''))
  };
}

function sameExcelDateTime(left, right) {
  if (!(left instanceof Date) || !(right instanceof Date)) return false;
  const leftTime = left.getTime();
  const rightTime = right.getTime();
  if (Number.isNaN(leftTime) || Number.isNaN(rightTime)) return false;
  if (Math.abs(leftTime - rightTime) <= 2) return true;

  // ExcelJS 写入后由 SheetJS 读取时，日期序列会按本地时区再偏移一次。
  // left 是回导值；只接受消除该固定时区偏移后与原值相同的情况。
  // Excel 浮点日期序列在秒级值上可能产生 1ms 误差，因此仅容忍 2ms。
  return Math.abs(
    leftTime - (left.getTimezoneOffset() * 60 * 1000) - rightTime
  ) <= 2;
}

function pureDateValue(value) {
  if (value instanceof Date) return null;
  if (typeof value === 'number' && (!Number.isFinite(value) || !Number.isInteger(value))) {
    return null;
  }
  const raw = value == null ? '' : String(value).trim();
  if (!raw) return null;
  if (
    /(?:[Tt]|\s|[,，])\d{1,2}[:.]\d{1,2}/.test(raw)
    || /^\d{4}-\d{1,2}-\d{1,2}-\d{1,2}:\d{1,2}/.test(raw)
  ) {
    return null;
  }
  const normalized = normalizeDate(value);
  if (!normalized) return null;
  const [year, month, day] = normalized.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  return Number.isNaN(date.getTime()) ? null : date;
}

function sameExcelDateValue(left, right) {
  if (left instanceof Date || right instanceof Date) {
    if (left instanceof Date && right instanceof Date) {
      return sameExcelDateTime(left, right);
    }
    if (left instanceof Date) {
      const expectedDate = pureDateValue(right);
      return Boolean(expectedDate && sameExcelDateTime(left, expectedDate));
    }
    const importedDate = pureDateValue(left);
    return Boolean(importedDate && sameExcelDateTime(importedDate, right));
  }

  const leftValue = left == null ? '' : String(left);
  const rightValue = right == null ? '' : String(right);
  if (leftValue === rightValue) return true;
  const leftDate = pureDateValue(left);
  const rightDate = pureDateValue(right);
  return Boolean(
    leftDate
    && rightDate
    && normalizeDate(leftDate) === normalizeDate(rightDate)
  );
}

function sameCellValue(left, right, header = '') {
  if (header === 'BillDate' || header === 'ValueDate') {
    return sameExcelDateValue(left, right);
  }
  if (left instanceof Date && right instanceof Date) return sameExcelDateTime(left, right);
  if (left instanceof Date) return left.toISOString() === text(right);
  if (right instanceof Date) return text(left) === right.toISOString();
  const leftValue = left == null ? '' : String(left);
  const rightValue = right == null ? '' : String(right);
  return leftValue === rightValue;
}

class PositionReconciliationService {
  constructor({
    userDataDir,
    templatePath,
    now = () => new Date(),
    store = null,
    requireExistingSideDb = false,
    expectedSideDbCheckpoint = null,
    expectedPendingOperation = null,
    initialSideDbCheckpoint = null,
    operationTokenProvider = null,
    recordArchiveIntent = null,
    protectedStagingPaths = null,
    beforeStagedInputCommit = null
  }) {
    if (!userDataDir) throw new TypeError('平盘对账 service 需要 userDataDir');
    if (!templatePath) throw new TypeError('平盘对账 service 需要 templatePath');
    this.userDataDir = path.resolve(userDataDir);
    this.templatePath = path.resolve(templatePath);
    this.now = now;
    this.recordArchiveIntent = typeof recordArchiveIntent === 'function'
      ? recordArchiveIntent
      : null;
    this.beforeStagedInputCommit = typeof beforeStagedInputCommit === 'function'
      ? beforeStagedInputCommit
      : null;
    this.store = store || createPositionReconciliationStore(this.userDataDir, {
      requireExisting: requireExistingSideDb,
      expectedCheckpoint: expectedSideDbCheckpoint,
      expectedPendingOperation,
      initialCheckpoint: initialSideDbCheckpoint,
      operationTokenProvider
    });
    this.bankImportTokens = new Map();
    this.sourceImportTokens = new Map();
    const pendingArchiveFiles = parsePositionPendingArchiveFiles(expectedPendingOperation);
    const protectedPaths = pendingArchiveFiles
      ? pendingArchiveFiles.map((file) => file.filePath)
      : [];
    let stagingProtectionComplete = pendingArchiveFiles !== null;
    if (typeof protectedStagingPaths === 'function') {
      try {
        const archiveProtectedPaths = protectedStagingPaths();
        if (Array.isArray(archiveProtectedPaths)) {
          protectedPaths.push(...archiveProtectedPaths);
        } else {
          stagingProtectionComplete = false;
        }
      } catch (_error) {
        // 无法读取存档引用时宁可保留旧暂存，避免破坏失败批次的重试能力。
        stagingProtectionComplete = false;
      }
    }
    if (stagingProtectionComplete) {
      pruneStagingRoot(this.userDataDir, { protectedPaths });
    }
  }

  close() {
    this.clearBankImportTokens();
    this.clearSourceImportTokens();
    this.store.close();
  }

  clearBankImportTokens() {
    const paths = [];
    for (const parsed of this.bankImportTokens.values()) {
      paths.push(...(parsed.stagingDirs || []));
    }
    this.bankImportTokens.clear();
    cleanupStagingPaths(paths);
  }

  clearSourceImportTokens() {
    const paths = [];
    for (const parsed of this.sourceImportTokens.values()) {
      if (parsed.stagingDir) paths.push(parsed.stagingDir);
    }
    this.sourceImportTokens.clear();
    cleanupStagingPaths(paths);
  }

  assertStagedInputs(files, phase, { beforeCommit = false } = {}) {
    const inputs = Array.isArray(files) ? files : [];
    if (beforeCommit && this.beforeStagedInputCommit) {
      this.beforeStagedInputCommit({
        phase,
        files: inputs.map((file) => stagedInputArchiveFile(file))
      });
    }
    try {
      for (const file of inputs) assertStagedInputUnchanged(file);
    } catch (error) {
      const invalidEvidence = error && error.code === 'position-staged-input-evidence-invalid';
      throw new PositionReconciliationError(
        invalidEvidence
          ? 'position-staged-input-evidence-invalid'
          : 'position-staged-input-changed',
        invalidEvidence
          ? '导入暂存文件缺少完整内容证据，请重新选择文件'
          : '导入暂存文件在确认前发生变化，请重新选择文件',
        [error && error.message ? error.message : String(error)]
      );
    }
  }

  status() {
    const pending = this.store.latestPendingRun();
    return {
      status: 'ok',
      bank: this.store.getBankSummary(),
      linked: this.store.listLinkedSummary(),
      pendingRun: pending ? {
        id: pending.id,
        scope: pending.scope,
        summary: pending.summary,
        stale: !this.store.snapshotIsCurrent(pending.snapshot),
        canExport: Boolean(pending.exported_at || pending.reimported_at),
        createdAt: pending.created_at
      } : null,
      canRun: this.store.listBankScopes({ statuses: [BANK_STATUSES.UNPROCESSED] }).length > 0,
      canExport: Boolean(pending && this.store.snapshotIsCurrent(pending.snapshot))
    };
  }

  prepareBankImport(filePaths) {
    const token = crypto.randomUUID();
    this.clearBankImportTokens();
    const staged = stageInputFiles(this.userDataDir, filePaths, `bank-${token}`);
    let parsed;
    try {
      parsed = readBankFiles(staged);
      this.assertStagedInputs(parsed.files, 'bank-prepare');
    } catch (error) {
      cleanupStagingPaths(staged.map((item) => item.stagingDir));
      throw error;
    }
    parsed.stagingDirs = staged.map((item) => item.stagingDir);
    this.bankImportTokens.set(token, parsed);
    const existing = parsed.scopes.map((key) => {
      const [channel, monthKey] = key.split('\u0000');
      const rowCount = this.store.getBankRows({ channels: [channel], months: [monthKey] }).length;
      return { channel, monthKey, rowCount };
    }).filter((scope) => scope.rowCount > 0);
    return {
      status: 'needs-confirmation',
      token,
      fileCount: parsed.files.length,
      rowCount: parsed.records.length,
      scopes: parsed.scopes.map((key) => {
        const [channel, monthKey] = key.split('\u0000');
        return { channel, monthKey };
      }),
      existing
    };
  }

  applyBankImport(token) {
    const parsed = this.bankImportTokens.get(text(token));
    if (!parsed) {
      throw new PositionReconciliationError(
        'position-bank-import-token-expired',
        '银行导入确认已失效，请重新选择文件'
      );
    }
    this.bankImportTokens.delete(text(token));
    let result;
    try {
      this.assertStagedInputs(parsed.files, 'bank-apply', { beforeCommit: true });
      result = this.store.replaceBankScopes(parsed, {
        inputEvidence: parsed.files.map((file) => stagedInputArchiveFile(file, 'position-bank'))
      });
    } catch (error) {
      cleanupStagingPaths(parsed.stagingDirs);
      throw error;
    }
    const scopeInputs = result.scopes.map((scope) => {
      const key = scopeKey(scope.channel, scope.monthKey);
      return {
        ...scope,
        inputPaths: parsed.files
          .filter((file) => Array.isArray(file.scopes) && file.scopes.includes(key))
          .map((file) => file.archivePath),
        inputFiles: parsed.files
          .filter((file) => Array.isArray(file.scopes) && file.scopes.includes(key))
          .map((file) => stagedInputArchiveFile(file, 'position-bank'))
      };
    });
    return {
      status: 'ok',
      message: `已导入 ${result.rowCount} 行平盘银行对账单`,
      inputPaths: parsed.files.map((file) => file.archivePath),
      inputFiles: parsed.files.map((file) => stagedInputArchiveFile(file, 'position-bank')),
      originalInputPaths: parsed.files.map((file) => file.filePath),
      cleanupPaths: parsed.stagingDirs,
      scopeInputs,
      ...result
    };
  }

  bankImportArchiveIntent(token) {
    const parsed = this.bankImportTokens.get(text(token));
    if (!parsed) {
      throw new PositionReconciliationError(
        'position-bank-import-token-expired',
        '银行导入确认已失效，请重新选择文件'
      );
    }
    return parsed.files.map((file) => stagedInputArchiveFile(file, 'position-bank'));
  }

  cancelBankImport() {
    this.clearBankImportTokens();
    return { status: 'cancelled' };
  }

  prepareSourceImport(filePaths) {
    this.clearSourceImportTokens();
    const batchToken = crypto.randomUUID();
    const staged = stageInputFiles(this.userDataDir, filePaths, `source-${batchToken}`);
    const results = readSourceFiles(staged);
    const output = [];
    for (const result of results) {
      if (result.status !== 'ok') {
        cleanupStagingPaths([result.stagingDir]);
        output.push(result);
        continue;
      }
      try {
        this.assertStagedInputs([result], 'source-prepare');
      } catch (error) {
        cleanupStagingPaths([result.stagingDir]);
        output.push({
          status: 'failed',
          filePath: result.filePath,
          fileName: result.fileName,
          code: error.code || 'position-staged-input-changed',
          message: error.message || String(error),
          detailLines: error.detailLines || []
        });
        continue;
      }
      if (result.sourceType === SOURCE_TYPES.BANK_ACCOUNT) {
        const token = crypto.randomUUID();
        this.sourceImportTokens.set(token, result);
        const current = this.store.listRawSummary().find((row) => row.sourceType === SOURCE_TYPES.BANK_ACCOUNT);
        output.push({
          status: 'needs-confirmation',
          token,
          sourceType: result.sourceType,
          sourceName: result.sourceName,
          fileName: result.fileName,
          oldValidCount: current ? current.rowCount : 0,
          newValidCount: result.records.filter((record) => text(record.row['账户状态']) === '正常').length
        });
      } else {
        try {
          const inputEvidence = stagedInputArchiveFile(result, result.sourceType);
          if (this.recordArchiveIntent) {
            this.recordArchiveIntent([inputEvidence], 'input');
          }
          this.assertStagedInputs([result], 'source-auto-apply', { beforeCommit: true });
          const applied = this.store.applySourceImport(result, {
            inputEvidence: [inputEvidence]
          });
          output.push({
            status: 'ok',
            filePath: result.filePath,
            fileName: result.fileName,
            archivePath: result.archivePath,
            stagingDir: result.stagingDir,
            inputPaths: [result.archivePath],
            inputFiles: [inputEvidence],
            originalInputPaths: [result.filePath],
            cleanupPaths: [result.stagingDir],
            ...applied
          });
        } catch (error) {
          cleanupStagingPaths([result.stagingDir]);
          output.push({
            status: 'failed',
            filePath: result.filePath,
            fileName: result.fileName,
            code: error.code || 'position-source-write-failed',
            message: error.message || String(error),
            detailLines: error.detailLines || []
          });
        }
      }
    }
    const successCount = output.filter((result) => result.status === 'ok').length;
    const failedCount = output.filter((result) => result.status === 'failed').length;
    const confirmationCount = output.filter((result) => result.status === 'needs-confirmation').length;
    const archiveDeferred = successCount === 0 && confirmationCount > 0;
    return {
      status: successCount > 0 || confirmationCount > 0 ? 'ok' : 'failed',
      message: successCount > 0 || confirmationCount > 0
        ? `链接原始表导入完成：成功 ${successCount}，待确认 ${confirmationCount}，失败 ${failedCount}`
        : '所选链接原始表全部导入失败',
      results: output,
      successCount,
      failedCount,
      confirmationCount,
      archiveDeferred,
      inputPaths: output
        .filter((item) => item.status === 'ok')
        .flatMap((item) => item.inputPaths || []),
      inputFiles: output
        .filter((item) => item.status === 'ok')
        .flatMap((item) => item.inputFiles || []),
      cleanupPaths: output
        .filter((item) => item.status === 'ok')
        .flatMap((item) => item.cleanupPaths || [])
    };
  }

  applySourceImport(token) {
    const parsed = this.sourceImportTokens.get(text(token));
    if (!parsed) {
      throw new PositionReconciliationError(
        'position-source-import-token-expired',
        '账户表导入确认已失效，请重新选择文件'
      );
    }
    this.sourceImportTokens.delete(text(token));
    let result;
    try {
      this.assertStagedInputs([parsed], 'source-apply', { beforeCommit: true });
      result = this.store.applySourceImport(parsed, {
        inputEvidence: [stagedInputArchiveFile(parsed, parsed.sourceType)]
      });
    } catch (error) {
      cleanupStagingPaths([parsed.stagingDir]);
      throw error;
    }
    return {
      status: 'ok',
      message: `已导入 ${result.rowCount} 行${result.sourceName}`,
      inputPaths: [parsed.archivePath],
      inputFiles: [stagedInputArchiveFile(parsed, parsed.sourceType)],
      originalInputPaths: [parsed.filePath],
      cleanupPaths: [parsed.stagingDir],
      ...result
    };
  }

  sourceImportArchiveIntent(token) {
    const parsed = this.sourceImportTokens.get(text(token));
    if (!parsed) {
      throw new PositionReconciliationError(
        'position-source-import-token-expired',
        '账户表导入确认已失效，请重新选择文件'
      );
    }
    return [stagedInputArchiveFile(parsed, parsed.sourceType)];
  }

  cancelSourceImport(token) {
    const normalizedToken = text(token);
    if (normalizedToken) {
      const parsed = this.sourceImportTokens.get(normalizedToken);
      this.sourceImportTokens.delete(normalizedToken);
      cleanupStagingPaths(parsed && parsed.stagingDir ? [parsed.stagingDir] : []);
    }
    return { status: 'cancelled' };
  }

  dataManager() {
    return {
      status: 'ok',
      unarchived: [
        this.store.getBankSummary(),
        {
          tableName: '平盘交易对账单',
          rowCount: 0,
          dateMin: '',
          dateMax: '',
          statuses: [],
          disabled: true,
          message: '后续版本开放'
        }
      ],
      archived: [],
      differences: this.store.listDifferenceSummary(),
      scopes: this.store.listBankScopes()
    };
  }

  linkedManager() {
    return {
      status: 'ok',
      linked: this.store.listLinkedSummary(),
      raw: this.store.listRawSummary(),
      sourceMonths: this.store.listSourceMonths()
    };
  }

  listMappings() {
    return { status: 'ok', mappings: this.store.listMappings() };
  }

  saveMappings(mappings) {
    const result = this.store.saveMappings(mappings);
    return {
      status: 'ok',
      message: `已保存 ${result.count} 条平盘账户映射`,
      ...result
    };
  }

  deleteBank(payload) {
    const selection = requireScopeSelection(payload, '删除');
    const result = this.store.deleteBankScopes(selection);
    if (result.deletedCount === 0) {
      throw new PositionReconciliationError(
        'position-bank-delete-empty',
        '所选 Channel 和月份下没有可删除的银行数据'
      );
    }
    return { status: 'ok', message: `已删除 ${result.deletedCount} 行银行数据`, ...result };
  }

  deleteSource(payload) {
    const sourceType = text(payload && payload.sourceType);
    const wholeTable = payload && payload.wholeTable === true;
    const months = [...new Set(
      (Array.isArray(payload && payload.months) ? payload.months : []).map(text).filter(Boolean)
    )];
    const result = this.store.deleteSource({ sourceType, wholeTable, months });
    return { status: 'ok', message: `已删除 ${result.deletedCount} 行原始数据`, ...result };
  }

  async exportBank(payload, outputPath) {
    const selection = requireScopeSelection(payload, '导出');
    const rows = this.store.getBankRows(selection);
    if (rows.length === 0) {
      throw new PositionReconciliationError(
        'position-bank-export-empty',
        '所选 Channel 和月份下没有可导出的银行数据'
      );
    }
    const exportRows = rows.map((row) => ({
      resultRow: row.workingRow,
      hit_summary: row.hit_summary,
      hit_type: row.hit_type,
      match_detail: row.match_detail,
      changed: false
    }));
    await writeResultWorkbook({
      templatePath: this.templatePath,
      outputPath,
      rows: exportRows,
      highlightChanged: false
    });
    return { status: 'ok', filePath: outputPath, rowCount: rows.length };
  }

  async exportLinked(sourceType, outputPath) {
    const rows = this.store.listLinkRows(sourceType).map((item) => item.row);
    await writeLinkedWorkbook({ outputPath, sourceType, rows });
    return { status: 'ok', filePath: outputPath, rowCount: rows.length };
  }

  async exportRaw(sourceType, outputPath) {
    const rows = this.store.sourceRecords(sourceType).map((item) => item.row);
    await writeRawWorkbook({ outputPath, sourceType, rows });
    return { status: 'ok', filePath: outputPath, rowCount: rows.length };
  }

  run(payload = {}) {
    const selection = requireScopeSelection(payload, '运行');
    const bankRows = this.store.getBankRows({
      ...selection,
      statuses: [BANK_STATUSES.UNPROCESSED]
    });
    if (bankRows.length === 0) {
      throw new PositionReconciliationError('position-run-empty', '所选范围没有状态为“未处理”的银行数据');
    }
    const existing = this.store.latestPendingRun();
    if (existing && Number(payload.replacePendingRunId) !== existing.id) {
      return {
        status: 'needs-replace-confirmation',
        pendingRunId: existing.id,
        pendingScope: existing.scope,
        message: '存在待确认运行结果，继续运行将使旧草稿失效'
      };
    }
    const scope = runScopeOf(bankRows);
    const sources = requiredSourceTypes(bankRows);
    const missing = sources.filter((sourceType) => this.store.countSourceRows(sourceType) === 0);
    if (missing.length > 0) {
      throw new PositionReconciliationError(
        'position-run-source-missing',
        '运行所需链接原始表尚未导入',
        missing.map((sourceType) => SOURCE_DEFINITIONS[sourceType].sourceName)
      );
    }
    const snapshot = this.store.currentSnapshot({
      scopes: scope.scopes,
      sourceTypes: sources,
      includeMapping: sources.includes(SOURCE_TYPES.FUND_TRANSFER)
    });
    const consumedSourceRows = this.store.listConsumedSources();
    const consumedSources = new Map(consumedSourceRows.map((item) => [
      sourceConsumptionKey(item.sourceType, item.businessKey, item.legIndex),
      item
    ]));
    const consumedBanks = new Map(consumedSourceRows.map((item) => [item.bankBizId, item]));
    const linkedRows = Object.fromEntries(
      sources.map((sourceType) => [
        sourceType,
        this.store.listLinkRows(sourceType, { includeHidden: true }).map((item) => {
          const consumed = consumedSources.get(
            sourceConsumptionKey(sourceType, item.business_key, item.leg_index)
          );
          return {
            ...item.row,
            _linkRowId: item.id,
            _sourceBusinessKey: item.business_key,
            _sourceRowNumber: item.source_row_number,
            _sourceLegIndex: Number(item.leg_index),
            _consumedByRunId: consumed ? consumed.runId : null,
            _consumedByBankBizId: consumed ? consumed.bankBizId : ''
          };
        })
      ])
    );
    const preparedBankRows = bankRows.map((item) => ({
      ...item.workingRow,
      _positionBankId: item.id,
      _positionBizId: item.biz_id,
      _positionChannel: item.channel,
      _positionMonthKey: item.month_key,
      _positionSourceOrder: item.import_order
    }));
    const allBankRows = sources.includes(SOURCE_TYPES.FUND_TRANSFER)
      ? this.store.getBankRows().map((item) => ({
          ...item.workingRow,
          _positionBankId: item.id,
          _positionBizId: item.biz_id,
          _positionChannel: item.channel,
          _positionMonthKey: item.month_key,
          _positionSourceOrder: item.import_order,
          _positionStatus: item.status
        }))
      : [];
    const engineResult = runPositionFundNatureCheck({
      bankRows: preparedBankRows,
      linkedRows,
      allBankRows
    });
    assertEngineResultSet(engineResult.rows, bankRows);
    const bankByBizId = new Map(bankRows.map((row) => [row.biz_id, row]));
    const resultRows = engineResult.rows.map((result, index) => {
      const bizId = text(result.bizId || result.bankRow?._positionBizId);
      const original = bankByBizId.get(bizId);
      if (!original) throw new Error(`引擎返回未知 BizId：${bizId}`);
      const priorConflict = priorBankConsumptionConflict(consumedBanks.get(bizId), result);
      const resultFundType = priorConflict
        ? text(original.working_fund_type)
        : text(result.resultFundType ?? result.bankRow?.FundType ?? original.working_fund_type);
      const resultRow = { ...original.workingRow, FundType: resultFundType };
      const changed = text(original.working_fund_type) !== resultFundType;
      return {
        bizId,
        channel: original.channel,
        monthKey: original.month_key,
        sourceOrder: original.import_order,
        originalFundType: text(original.working_fund_type),
        resultFundType,
        hitSummary: changed ? `${text(original.working_fund_type)} → ${resultFundType}` : '',
        hitType: priorConflict ? MATCH_TYPES.MANUAL : (result.hitType || MATCH_TYPES.UNMATCHED),
        matchDetail: priorConflict ? priorConflict.detail : (result.detail || ''),
        outcome: priorConflict
          ? 'difference'
          : (result.outcome || (result.isDifference ? 'difference' : 'matched')),
        changed,
        isDifference: Boolean(priorConflict || result.isDifference),
        originalRow: original.originalRow,
        resultRow,
        lineage: priorConflict ? priorConflict.lineage : (result.lineage || {}),
        sourceOrderFallback: index
      };
    });
    const confirmedConsumptionConflicts = resultRows.filter(
      (row) => row.lineage && row.lineage.reasonCode === 'position-bank-counterparty-reassigned'
    ).length;
    const summary = {
      inputRows: bankRows.length,
      changedRows: resultRows.filter((row) => row.changed).length,
      differenceRows: resultRows.filter((row) => row.isDifference).length,
      preciseRows: resultRows.filter((row) => row.hitType === MATCH_TYPES.PRECISE).length,
      fuzzyRows: resultRows.filter((row) => row.hitType === MATCH_TYPES.FUZZY).length,
      notApplicableRows: resultRows.filter((row) => row.hitType === MATCH_TYPES.NOT_APPLICABLE).length,
      manualModifiedRows: 0,
      sourceTypes: sources,
      engine: {
        ...(engineResult.summary || {}),
        matched: resultRows.filter((row) => (
          !row.isDifference && row.hitType !== MATCH_TYPES.NOT_APPLICABLE
        )).length,
        changed: resultRows.filter((row) => row.changed).length,
        differences: resultRows.filter((row) => row.isDifference).length,
        notApplicable: resultRows.filter(
          (row) => row.hitType === MATCH_TYPES.NOT_APPLICABLE
        ).length,
        confirmedConsumptionConflicts
      }
    };
    const run = this.store.createRun({
      runUuid: crypto.randomUUID(),
      scope,
      snapshot,
      summary,
      rows: resultRows,
      supersedeRunId: existing ? existing.id : null
    });
    return {
      status: 'ok',
      runId: run.id,
      scope,
      summary,
      canExport: true
    };
  }

  requireCurrentPendingRun(runId = null) {
    const run = runId ? this.store.getRun(Number(runId)) : this.store.latestPendingRun();
    if (!run || run.status !== 'pending') {
      throw new PositionReconciliationError('position-run-missing', '没有待确认的平盘资金性质校验结果');
    }
    if (!this.store.snapshotIsCurrent(run.snapshot)) {
      throw new PositionReconciliationError(
        'position-run-stale',
        '银行、链接表或账户映射已变化，旧结果不可继续使用，请重新运行'
      );
    }
    return run;
  }

  requireDifferenceRun(runId) {
    const run = this.store.getRun(Number(runId));
    if (!run || (run.status !== 'pending' && run.status !== 'confirmed')) {
      throw new PositionReconciliationError(
        'position-difference-run-missing',
        '差异数据所属运行批次不存在或已被替换'
      );
    }
    if (run.status === 'pending' && !this.store.snapshotIsCurrent(run.snapshot)) {
      throw new PositionReconciliationError(
        'position-run-stale',
        '银行、链接表或账户映射已变化，旧结果不可继续使用，请重新运行'
      );
    }
    return run;
  }

  async exportRun(runId, outputPath, {
    differencesOnly = false,
    channels = [],
    regions = [],
    months = [],
    differenceStatuses = []
  } = {}) {
    const run = differencesOnly
      ? this.requireDifferenceRun(runId)
      : this.requireCurrentPendingRun(runId);
    const rows = this.store.listRunRows(run.id, {
      differencesOnly,
      channels,
      regions,
      months,
      differenceStatuses
    });
    if (differencesOnly && rows.length === 0) {
      throw new PositionReconciliationError(
        'position-difference-export-empty',
        '所选银行渠道、月份和状态下没有可导出的差异数据'
      );
    }
    await writeResultWorkbook({
      templatePath: this.templatePath,
      outputPath,
      rows,
      highlightChanged: true
    });
    if (!differencesOnly) this.store.markRunExported(run.id);
    return {
      status: 'ok',
      filePath: outputPath,
      runId: run.id,
      rowCount: rows.length,
      fileName: path.basename(outputPath)
    };
  }

  importRunResult(runId, filePath) {
    const run = this.requireCurrentPendingRun(runId);
    const storedRows = this.store.listRunRows(run.id);
    const staged = stageInputFiles(
      this.userDataDir,
      [filePath],
      `result-${crypto.randomUUID()}`
    )[0];
    const inputEvidence = stagedInputArchiveFile(staged, 'position-result-reimport');
    if (this.recordArchiveIntent) this.recordArchiveIntent([inputEvidence], 'input');
    let imported;
    try {
      imported = readResultWorkbook(staged.filePath);
      this.assertStagedInputs([staged], 'result-prepare');
    } catch (error) {
      cleanupStagingPaths([staged.stagingDir]);
      throw error;
    }
    try {
      const storedByBizId = new Map(storedRows.map((row) => [row.biz_id, row]));
      const importedByBizId = new Map();
      for (const item of imported.rows) {
        const bizId = text(item.row.BizId);
        if (!bizId || importedByBizId.has(bizId)) {
          throw new PositionReconciliationError(
            'position-result-bizid-invalid',
            `回导文件 BizId 为空或重复：第 ${item.excelRowNumber} 行`
          );
        }
        importedByBizId.set(bizId, item);
      }
      const missing = [...storedByBizId.keys()].filter((bizId) => !importedByBizId.has(bizId));
      const extra = [...importedByBizId.keys()].filter((bizId) => !storedByBizId.has(bizId));
      if (missing.length || extra.length) {
        throw new PositionReconciliationError(
          'position-result-row-set-mismatch',
          '回导文件的 BizId 集合与运行草稿不一致',
          [
            missing.length ? `缺少：${missing.slice(0, 20).join(' / ')}` : '',
            extra.length ? `多出：${extra.slice(0, 20).join(' / ')}` : ''
          ].filter(Boolean)
        );
      }
      const updates = [];
      for (const stored of storedRows) {
        const importedRow = importedByBizId.get(stored.biz_id).row;
        const expected = resultRowForExport(stored);
        for (const header of POSITION_BANK_HEADERS) {
          if (header === 'FundType' || header === '匹配命中详情') continue;
          if (!sameCellValue(importedRow[header], expected[header], header)) {
            throw new PositionReconciliationError(
              'position-result-field-tampered',
              `回导文件修改了不允许修改的字段：BizId=${stored.biz_id}，字段=${header}`
            );
          }
        }
        const nextFundType = text(importedRow.FundType);
        const currentFundType = text(stored.result_fund_type);
        const detailChanged = text(importedRow['匹配命中详情']) !== text(stored.match_detail);
        const fundTypeChanged = nextFundType !== currentFundType;
        if (detailChanged && !fundTypeChanged) {
          throw new PositionReconciliationError(
            'position-result-detail-only-change',
            `仅修改匹配命中详情不允许：BizId=${stored.biz_id}`
          );
        }
        if (fundTypeChanged) {
          const pair = FUND_TYPE_PAIR_BY_VALUE.get(text(stored.original_fund_type));
          if (!pair || !pair.includes(nextFundType)) {
            throw new PositionReconciliationError(
              'position-result-fund-type-out-of-pair',
              `FundType 只能在原基础/FX二元组内修改：BizId=${stored.biz_id}`
            );
          }
        }
        const matchDetail = fundTypeChanged
          ? (text(importedRow['匹配命中详情']) || `${text(stored.match_detail)}；用户回导修改`.replace(/^；/, ''))
          : text(stored.match_detail);
        const finalChanged = text(stored.original_fund_type) !== nextFundType;
        const manualModified = Boolean(stored.manual_modified) || fundTypeChanged;
        updates.push({
          bizId: stored.biz_id,
          resultFundType: nextFundType,
          hitSummary: fundTypeChanged
            ? (finalChanged ? `${text(stored.original_fund_type)} → ${nextFundType}` : '')
            : text(stored.hit_summary),
          hitType: fundTypeChanged ? MATCH_TYPES.USER_MODIFIED : text(stored.hit_type),
          matchDetail,
          outcome: manualModified ? 'difference' : text(stored.outcome),
          changed: finalChanged,
          manualModified,
          resultRow: { ...stored.resultRow, FundType: nextFundType }
        });
      }
      this.assertStagedInputs([staged], 'result-apply', { beforeCommit: true });
      this.store.replaceRunRowsFromReimport(run.id, updates, {
        inputEvidence: [inputEvidence]
      });
      return {
        status: 'ok',
        runId: run.id,
        rowCount: updates.length,
        modifiedCount: updates.filter((item) => item.manualModified).length,
        inputPaths: [staged.archivePath],
        inputFiles: [inputEvidence],
        originalInputPaths: [staged.sourceFilePath],
        cleanupPaths: [staged.stagingDir]
      };
    } catch (error) {
      cleanupStagingPaths([staged.stagingDir]);
      throw error;
    }
  }

  confirmRun(runId) {
    const run = this.requireCurrentPendingRun(runId);
    if (!run.exported_at && !run.reimported_at) {
      throw new PositionReconciliationError(
        'position-run-confirm-gate',
        '请先成功导出结果或回导修改后的合法结果，再点击确认'
      );
    }
    const result = this.store.confirmRun(run.id);
    return {
      status: 'ok',
      message: `已确认 ${result.confirmedRows} 行，银行批次状态已更新为“已校验性质”`,
      ...result
    };
  }

  defaultResultFileName() {
    return `${formatTimestamp(this.now())}_平盘资金性质校验结果.xlsx`;
  }

  diagnostics() {
    return { status: 'ok', ...this.store.diagnosticSummary() };
  }

  persistenceCheckpoint() {
    return this.store.persistenceCheckpoint();
  }

  listCommittedOperationInputs(operationToken) {
    return this.store.listCommittedOperationInputs(operationToken);
  }
}

function createPositionReconciliationService(options) {
  return new PositionReconciliationService(options);
}

module.exports = {
  PositionReconciliationService,
  createPositionReconciliationService,
  requiredSourceTypes,
  SOURCE_BY_FUND_TYPE,
  assertEngineResultSet,
  sourceConsumptionKey,
  priorBankConsumptionConflict
};
