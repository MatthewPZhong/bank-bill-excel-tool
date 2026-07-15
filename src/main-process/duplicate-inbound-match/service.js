'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const XLSX = require('xlsx');

const { readBankStatement, BANK_STATEMENT_SHEET_NAME } = require('../bank-statement-io');
const { BANK_STATEMENT_FIELDS } = require('../../constants/bank-statement-fields');
const { FileValidationError } = require('../../backend/file-service/common');
const {
  createDuplicateInboundMatchStore,
  MODULE
} = require('../../backend/duplicate-inbound-match-store');
const {
  createPreFundReconciliationStore
} = require('../../backend/pre-fund-reconciliation-store');
const {
  SOURCE_TYPE_INBOUND
} = require('../pre-fund-reconciliation/mpt-schema');
const runDataStore = require('../../backend/run-data-store');
const {
  FUND_TYPES,
  buildDuplicateInboundGroups,
  resolveDuplicateInboundMptMatches,
  resolveDuplicateInboundDocumentMatches
} = require('./matching-engine');
const {
  readXlsxSheetNames,
  streamDocumentStatement
} = require('./document-statement-reader');
const {
  buildDefaultFileName,
  writeDuplicateInboundWorkbook
} = require('./excel-writer');

const MAIL_REMARK = '重复入账后被Reverse';

class DuplicateInboundMatchServiceError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'DuplicateInboundMatchServiceError';
    this.code = code;
    Object.assign(this, details);
  }
}

function localMonthKey(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError('重复入金运行日期无效');
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function stableHash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function inspectSheetNames(filePath) {
  if (path.extname(filePath).toLowerCase() === '.xlsx') {
    return readXlsxSheetNames(filePath);
  }
  const workbook = XLSX.readFile(filePath, { bookSheets: true });
  return Array.isArray(workbook.SheetNames) ? workbook.SheetNames.slice() : [];
}

async function identifyInputFiles(filePaths) {
  if (!Array.isArray(filePaths) || filePaths.length !== 2) {
    throw new FileValidationError(
      'duplicate-inbound-input-file-count',
      '请一次选择 1 份银行对账单和 1 份单据对账单（共 2 个文件）'
    );
  }
  const inspected = await Promise.all(filePaths.map(async (filePath) => {
    if (!filePath || !fs.existsSync(filePath)) {
      throw new FileValidationError('file-not-found', `文件不存在：${filePath}`);
    }
    let sheetNames;
    try {
      sheetNames = await inspectSheetNames(filePath);
    } catch (error) {
      if (error instanceof FileValidationError) throw error;
      throw new FileValidationError(
        'duplicate-inbound-input-unreadable',
        `文件无法读取：${path.basename(filePath)}`,
        { detailLines: [error && error.message ? error.message : String(error)] }
      );
    }
    return {
      filePath,
      fileName: path.basename(filePath),
      sheetNames,
      isBank: sheetNames.includes(BANK_STATEMENT_SHEET_NAME)
    };
  }));
  const bankFiles = inspected.filter((file) => file.isBank);
  if (bankFiles.length !== 1) {
    throw new FileValidationError(
      'duplicate-inbound-input-type-ambiguous',
      '无法唯一识别银行对账单：两份文件中必须且只能有一份包含 sheet“渠道对账单”',
      { detailLines: inspected.map((file) => `${file.fileName}：${file.sheetNames.join(' / ') || '无工作表'}`) }
    );
  }
  const bank = bankFiles[0];
  const document = inspected.find((file) => file !== bank);
  if (path.extname(document.filePath).toLowerCase() !== '.xlsx') {
    throw new FileValidationError(
      'duplicate-inbound-document-extension',
      '单据对账单只支持 .xlsx 文件'
    );
  }
  return { bank, document };
}

function yieldToEventLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}

function toText(value) {
  return value === null || value === undefined ? '' : String(value);
}

function trimText(value) {
  return toText(value).trim();
}

function pickBankFields(row) {
  return Object.fromEntries(BANK_STATEMENT_FIELDS.map((field) => [field, row[field] ?? '']));
}

function countFundTypes(rows) {
  let reversalCount = 0;
  let inboundCount = 0;
  for (const row of rows) {
    const fundType = trimText(row.FundType);
    if (fundType === FUND_TYPES.REVERSAL) reversalCount += 1;
    if (fundType === FUND_TYPES.INBOUND) inboundCount += 1;
  }
  return { reversalCount, inboundCount };
}

function validateBizIds(rows) {
  const firstRowByBizId = new Map();
  const detailLines = [];
  for (let index = 0; index < rows.length; index += 1) {
    const excelRowNumber = index + 2;
    const bizId = trimText(rows[index].BizId);
    if (bizId === '') {
      detailLines.push(`第 ${excelRowNumber} 行：BizId 为空`);
      continue;
    }
    if (firstRowByBizId.has(bizId)) {
      detailLines.push(
        `第 ${excelRowNumber} 行：BizId「${bizId}」与第 ${firstRowByBizId.get(bizId)} 行重复`
      );
      continue;
    }
    firstRowByBizId.set(bizId, excelRowNumber);
  }
  if (detailLines.length > 0) {
    throw new FileValidationError(
      'duplicate-inbound-invalid-biz-id',
      `BizId 必须非空且全文件唯一（发现 ${detailLines.length} 处异常）`,
      { detailLines }
    );
  }
}

function batchSnapshotEntry(batch) {
  return {
    batchId: Number(batch.id),
    monthKey: batch.monthKey,
    sourceType: batch.sourceType,
    sourceBatch: batch.sourceBatch,
    sourceDate: batch.sourceDate,
    sourceFileName: batch.sourceFileName,
    sourceFileSequence: Number(batch.sourceFileSequence) || 0,
    contentHash: batch.contentHash,
    declaredRowCount: Number(batch.declaredRowCount) || 0,
    rowCount: Number(batch.rowCount) || 0,
    importedAt: batch.importedAt
  };
}

function compareSnapshotEntries(left, right) {
  return String(left.monthKey).localeCompare(String(right.monthKey))
    || String(left.sourceBatch).localeCompare(String(right.sourceBatch))
    || String(left.sourceFileName).localeCompare(String(right.sourceFileName))
    || left.sourceFileSequence - right.sourceFileSequence;
}

function reasonText(group) {
  const messages = Array.isArray(group.reasons)
    ? group.reasons.map((reason) => trimText(reason && reason.message)).filter(Boolean)
    : [];
  return [...new Set(messages)].join('；') || '未满足自动匹配条件';
}

function mirrorSafeError(error) {
  const code = error && error.code ? String(error.code) : 'duplicate-inbound-match-failed';
  return new Error(`重复入金匹配运行失败（${code}）`);
}

function countManualReversals(groups) {
  return groups.reduce(
    (sum, group) => sum + group.relatedRows.filter((record) => record.fundType === FUND_TYPES.REVERSAL).length,
    0
  );
}

function toMptLineage(inboundRow, candidate) {
  const source = candidate && candidate.sourceCandidate ? candidate.sourceCandidate : {};
  return {
    bankBizId: inboundRow.bizId,
    bankSourceOrdinal: inboundRow.sourceOrdinal,
    candidateKey: candidate ? candidate.candidateKey : '',
    candidateId: source.candidateId ?? candidate.candidateId ?? '',
    monthKey: source.monthKey ?? '',
    rowId: source.id ?? '',
    sourceType: source.sourceType ?? '',
    sourceBatch: source.sourceBatch ?? '',
    sourceFileName: source.sourceFileName ?? '',
    sourceRowNumber: source.sourceRowNumber ?? ''
  };
}

function toDocumentLineage(orderId, candidate, candidateCount) {
  return {
    orderId,
    candidateCount: Number(candidateCount) || 0,
    documentRowKey: candidate ? candidate.documentRowKey : '',
    rowId: candidate ? candidate.rowId : '',
    fileName: candidate ? candidate.fileName : '',
    sourceOrdinal: candidate ? candidate.sourceOrdinal : null,
    excelRowNumber: candidate ? candidate.excelRowNumber : null,
    businessOrderKey: candidate ? candidate.businessOrderKey : ''
  };
}

class DuplicateInboundMatchService {
  constructor({
    userDataDir,
    database,
    mailTemplatePath,
    bankTemplatePath,
    now = () => new Date()
  }) {
    if (!userDataDir || typeof userDataDir !== 'string') {
      throw new TypeError('重复入金匹配 service 需要 userDataDir');
    }
    if (!database) throw new TypeError('重复入金匹配 service 需要 database');
    const mirrorMethods = [
      'createDuplicateInboundMatchRunMirror',
      'finishDuplicateInboundMatchRunMirror',
      'failDuplicateInboundMatchRunMirror',
      'markDuplicateInboundMatchRunMirrorUnavailable',
      'listDuplicateInboundMatchRunMirrors'
    ];
    for (const method of mirrorMethods) {
      if (typeof database[method] !== 'function') {
        throw new TypeError(`重复入金匹配 database 缺少 ${method}`);
      }
    }
    this.userDataDir = path.resolve(userDataDir);
    this.database = database;
    this.mailTemplatePath = mailTemplatePath;
    this.bankTemplatePath = bankTemplatePath;
    this.now = now;
    this.store = createDuplicateInboundMatchStore(this.userDataDir);
    this.tempStore = createPreFundReconciliationStore(this.userDataDir);
    this.bankSession = null;
    this.documentSession = null;
    this.lastRun = null;
    this.reconcilePersistedRunMirrors();
  }

  reconcilePersistedRunMirrors() {
    for (const mirror of this.database.listDuplicateInboundMatchRunMirrors()) {
      if (mirror.status === 'running') {
        this.database.markDuplicateInboundMatchRunMirrorUnavailable(
          mirror.id,
          'interrupted',
          '应用已重启，上一轮重复入金匹配未完整结束'
        );
      } else if (mirror.status === 'success') {
        this.database.markDuplicateInboundMatchRunMirrorUnavailable(
          mirror.id,
          'expired',
          '应用已重启，银行与单据导入会话和运行结果已回收'
        );
      }
    }
    this.store.clearAll();
  }

  revokeSuccessfulMirrors(message) {
    for (const mirror of this.database.listDuplicateInboundMatchRunMirrors()) {
      if (mirror.status !== 'success') continue;
      this.database.markDuplicateInboundMatchRunMirrorUnavailable(
        mirror.id,
        'superseded',
        message
      );
    }
  }

  invalidateForNewImport() {
    // 先撤销内存资格，再做可能失败的镜像/文件清理；清理失败也不得恢复旧输入或旧导出。
    this.bankSession = null;
    this.documentSession = null;
    this.lastRun = null;
    this.revokeSuccessfulMirrors('已选择新的银行与单据对账单，旧运行结果已失效');
    this.store.clearAll();
  }

  buildMptSnapshot() {
    const batches = this.tempStore.listBatches({ sourceType: SOURCE_TYPE_INBOUND })
      .map(batchSnapshotEntry)
      .sort(compareSnapshotEntries);
    return {
      sourceType: SOURCE_TYPE_INBOUND,
      batchCount: batches.length,
      batches
    };
  }

  currentMptSnapshot() {
    const snapshot = this.buildMptSnapshot();
    return { snapshot, snapshotHash: stableHash(snapshot) };
  }

  inspectLastRun() {
    if (!this.lastRun) return { available: false, unavailable: false, stale: false };
    const sidePath = runDataStore.sideDbPath(this.userDataDir, MODULE, this.lastRun.monthKey);
    if (!fs.existsSync(sidePath)) {
      try {
        this.database.markDuplicateInboundMatchRunMirrorUnavailable(
          this.lastRun.mirrorRunId,
          'missing-side-db',
          '重复入金运行结果侧库不存在'
        );
      } catch (_error) { /* 状态展示仍以侧库事实为准 */ }
      return {
        available: false,
        unavailable: true,
        stale: false,
        message: '重复入金运行结果侧库不存在，请重新导入并运行'
      };
    }
    const run = this.store.getRun(this.lastRun.monthKey, this.lastRun.sideRunId);
    if (!run || run.status !== 'success') {
      return {
        available: false,
        unavailable: true,
        stale: false,
        message: '重复入金运行结果不可用，请重新运行'
      };
    }
    const current = this.currentMptSnapshot();
    const stale = current.snapshotHash !== this.lastRun.snapshotHash;
    return {
      available: !stale,
      unavailable: false,
      stale,
      message: stale ? '临时中台入金网关账单已变化，请重新运行' : '',
      run
    };
  }

  status() {
    const availability = this.inspectLastRun();
    const run = this.lastRun
      ? {
        id: this.lastRun.mirrorRunId,
        summary: { ...this.lastRun.summary },
        stale: availability.stale,
        unavailable: availability.unavailable,
        unavailableMessage: availability.message || ''
      }
      : null;
    const resultCount = run
      ? Number(run.summary.mailRowCount || 0) + Number(run.summary.manualRowCount || 0)
      : 0;
    return {
      status: 'ok',
      bank: this.bankSession
        ? {
          fileName: this.bankSession.fileName,
          rowCount: this.bankSession.rowCount,
          reversalCount: this.bankSession.reversalCount,
          inboundCount: this.bankSession.inboundCount,
          importedAt: this.bankSession.importedAt
        }
        : null,
      document: this.documentSession
        ? {
          fileName: this.documentSession.fileName,
          rowCount: this.documentSession.rowCount,
          matchableRowCount: this.documentSession.matchableRowCount,
          emptyBusinessOrderCount: this.documentSession.emptyBusinessOrderCount,
          importedAt: this.documentSession.importedAt
        }
        : null,
      run,
      canRun: Boolean(this.bankSession && this.documentSession),
      canExport: Boolean(this.lastRun && availability.available && resultCount > 0)
    };
  }

  async importFiles(filePaths, onProgress) {
    this.invalidateForNewImport();
    if (onProgress) onProgress({ stage: 'classify', message: '正在识别银行对账单和单据对账单...' });
    await yieldToEventLoop();

    const inputs = await identifyInputFiles(filePaths);
    if (onProgress) onProgress({ stage: 'read-bank', message: '正在校验银行对账单...' });
    await yieldToEventLoop();
    const parsed = readBankStatement(inputs.bank.filePath);
    validateBizIds(parsed.rows);
    const [bankFileHash, documentFileHash] = await Promise.all([
      hashFile(inputs.bank.filePath),
      hashFile(inputs.document.filePath)
    ]);
    const { reversalCount, inboundCount } = countFundTypes(parsed.rows);
    const monthKey = localMonthKey(this.now());
    const storedRows = parsed.rows.map((row, index) => ({
      sourceOrdinal: index,
      excelRowNumber: index + 2,
      bizId: trimText(row.BizId),
      fundType: trimText(row.FundType),
      raw: pickBankFields(row)
    }));
    if (onProgress) onProgress({ stage: 'persist', message: '正在保存银行与单据导入会话...' });
    await yieldToEventLoop();
    const imported = await this.store.createImportBundle({
      monthKey,
      bank: {
        fileName: parsed.fileName,
        contentHash: bankFileHash,
        rows: storedRows
      },
      document: {
        fileName: inputs.document.fileName,
        contentHash: documentFileHash
      },
      writeDocumentRows: (insertRow) => streamDocumentStatement(inputs.document.filePath, {
        onRow: insertRow,
        onProgress: (progress) => {
          if (onProgress) onProgress({ stage: 'read-document', ...progress });
        }
      })
    });
    const [bankHashAfter, documentHashAfter] = await Promise.all([
      hashFile(inputs.bank.filePath),
      hashFile(inputs.document.filePath)
    ]);
    if (bankHashAfter !== bankFileHash || documentHashAfter !== documentFileHash) {
      this.store.clearAll();
      throw new DuplicateInboundMatchServiceError(
        'duplicate-inbound-input-changed-during-import',
        '导入期间输入文件发生变化，请重新选择文件'
      );
    }
    const importedAt = this.now().toISOString();
    this.bankSession = {
      monthKey,
      importId: imported.id,
      fileName: parsed.fileName,
      fileHash: bankFileHash,
      rowCount: parsed.rows.length,
      reversalCount,
      inboundCount,
      importedAt
    };
    this.documentSession = {
      monthKey,
      importId: imported.id,
      fileName: imported.document.fileName,
      fileHash: documentFileHash,
      rowCount: imported.document.rowCount,
      matchableRowCount: imported.document.matchableRowCount,
      emptyBusinessOrderCount: imported.document.emptyBusinessOrderCount,
      importedAt
    };
    if (onProgress) onProgress({ stage: 'done', message: '银行对账单和单据对账单导入完成' });
    return {
      status: 'ok',
      bank: {
        fileName: parsed.fileName,
        rowCount: parsed.rows.length,
        reversalCount,
        inboundCount
      },
      document: {
        fileName: imported.document.fileName,
        rowCount: imported.document.rowCount,
        matchableRowCount: imported.document.matchableRowCount,
        emptyBusinessOrderCount: imported.document.emptyBusinessOrderCount
      }
    };
  }

  clearPreviousRun() {
    // 新 run 一经请求，旧结果立即失效；即使侧库删除失败也不能继续导出旧结果。
    this.lastRun = null;
    this.revokeSuccessfulMirrors('已开始新的重复入金匹配运行，旧结果已回收');
    if (this.bankSession) this.store.clearRuns(this.bankSession.monthKey);
  }

  buildMailRows(successGroups) {
    return successGroups.map((group) => {
      const reversal = group.reversalRows[0];
      const orderIds = group.inboundMatches
        .slice()
        .sort((left, right) => left.inboundRow.sourceOrdinal - right.inboundRow.sourceOrdinal)
        .map((match) => trimText(match.mptCandidate.orderId))
        .filter(Boolean);
      return {
        sourceOrdinal: reversal.sourceOrdinal,
        output: {
          BillDate: reversal.row.BillDate ?? '',
          Channel: reversal.row.Channel ?? '',
          MerchantId: reversal.row.MerchantId ?? '',
          Currency: reversal.row.Currency ?? '',
          'Debit Amount': reversal.row['Debit Amount'] ?? '',
          '加款单号': orderIds.join('、'),
          '业务来源': group.commonMptFields.oppBu,
          '客户号': group.commonDocumentFields.userNo,
          '账户号': group.commonDocumentFields.accountNo,
          '备注': MAIL_REMARK
        }
      };
    }).sort((left, right) => left.sourceOrdinal - right.sourceOrdinal);
  }

  buildManualRows(manualGroups) {
    return manualGroups.flatMap((group, groupOrder) => {
      const reason = reasonText(group);
      return group.relatedRows
        .slice()
        .sort((left, right) => left.sourceOrdinal - right.sourceOrdinal)
        .map((record) => ({
          groupOrder,
          rowOrder: record.sourceOrdinal,
          reason,
          raw: pickBankFields(record.row)
        }));
    });
  }

  buildAuditRows(successGroups, manualGroups) {
    const groups = [
      ...successGroups.map((group) => ({ group, disposition: 'success' })),
      ...manualGroups.map((group) => ({ group, disposition: 'manual' }))
    ].sort((left, right) => (
      left.group.firstSourceOrdinal - right.group.firstSourceOrdinal
      || left.group.firstInputIndex - right.group.firstInputIndex
      || String(left.group.groupKey).localeCompare(String(right.group.groupKey))
    ));
    return groups.map(({ group, disposition }, groupOrder) => {
      const bankLineage = group.relatedRows.map((record) => ({
        bizId: record.bizId,
        fundType: record.fundType,
        sourceOrdinal: record.sourceOrdinal,
        excelRowNumber: record.excelRowNumber
      }));
      const mptLineage = Array.isArray(group.inboundMatches)
        ? group.inboundMatches.map((match) => toMptLineage(match.inboundRow, match.mptCandidate))
        : (group.inboundCandidateSets || []).flatMap((set) => (
          set.candidates.map((candidate) => toMptLineage(set.inboundRow, candidate))
        ));
      const documentLineage = Array.isArray(group.documentMatches)
        ? group.documentMatches.map((match) => toDocumentLineage(
          match.orderId,
          match.documentCandidate,
          1
        ))
        : (group.documentCandidateSets || []).flatMap((set) => (
          set.candidates.length > 0
            ? set.candidates.map((candidate) => toDocumentLineage(
              set.orderId,
              candidate,
              set.candidateCount
            ))
            : [toDocumentLineage(set.orderId, null, set.candidateCount)]
        ));
      return {
        groupOrder,
        disposition,
        reasonCodes: group.reasonCodes || [],
        bankLineage,
        mptLineage,
        documentLineage
      };
    });
  }

  async run({ onProgress } = {}) {
    if (!this.bankSession || !this.documentSession) {
      throw new DuplicateInboundMatchServiceError(
        'duplicate-inbound-input-missing',
        '请先同时导入银行对账单和单据对账单'
      );
    }
    this.clearPreviousRun();
    let sideRunId = null;
    let mirrorRunId = null;
    const before = this.currentMptSnapshot();
    try {
      sideRunId = this.store.createRun({
        monthKey: this.bankSession.monthKey,
        importId: this.bankSession.importId,
        snapshot: before.snapshot,
        snapshotHash: before.snapshotHash
      });
      mirrorRunId = this.database.createDuplicateInboundMatchRunMirror({
        monthKey: this.bankSession.monthKey,
        sideRunId,
        snapshotHash: before.snapshotHash,
        bankFileName: this.bankSession.fileName,
        bankFileHash: this.bankSession.fileHash,
        documentFileName: this.documentSession.fileName,
        documentFileHash: this.documentSession.fileHash,
        sideDbRelPath: runDataStore.sideDbRelPath(MODULE, this.bankSession.monthKey)
      });

      if (onProgress) onProgress({ stage: 'bank-group', message: '正在分组银行 Reversal 与 Inbound...' });
      await yieldToEventLoop();
      const bankRows = this.store.readBankRows(this.bankSession.monthKey, this.bankSession.importId);
      const grouping = buildDuplicateInboundGroups(bankRows);
      const lookupCriteria = grouping.candidateGroups.flatMap((group) => group.inboundRows.map((row) => ({
        lookupId: row.bankRowKey,
        channel: row.row.Channel,
        merchantId: row.row.MerchantId,
        reconciliationId: row.row.ReconciliationId
      })));

      if (onProgress) onProgress({ stage: 'mpt-match', message: '正在匹配临时中台入金网关账单...' });
      await yieldToEventLoop();
      const candidatesByInbound = this.tempStore.lookupInboundRows(lookupCriteria);
      const mptResolved = resolveDuplicateInboundMptMatches({
        groupingResult: grouping,
        mptCandidatesByInbound: candidatesByInbound
      });

      if (onProgress) onProgress({ stage: 'document-match', message: '正在匹配单据对账单并校验身份字段...' });
      await yieldToEventLoop();
      const orderIds = mptResolved.finalSuccessGroups.flatMap((group) => (
        group.inboundMatches.map((match) => match.mptCandidate.orderId)
      ));
      const documentCandidatesByOrderId = this.store.lookupDocumentRows(
        this.documentSession.monthKey,
        this.documentSession.importId,
        orderIds
      );
      const resolved = resolveDuplicateInboundDocumentMatches({
        mptResult: mptResolved,
        documentCandidatesByOrderId,
        bankStats: grouping.stats
      });

      const after = this.currentMptSnapshot();
      if (after.snapshotHash !== before.snapshotHash) {
        throw new DuplicateInboundMatchServiceError(
          'duplicate-inbound-mpt-changed-during-run',
          '运行期间临时中台入金网关账单发生变化，请重新运行'
        );
      }

      const successReversals = resolved.finalSuccessGroups.length;
      const manualReversals = countManualReversals(resolved.manualGroups);
      if (grouping.stats.reversalRowCount !== successReversals + manualReversals) {
        throw new DuplicateInboundMatchServiceError(
          'duplicate-inbound-reversal-conservation-failed',
          `Reversal 行数不守恒：输入 ${grouping.stats.reversalRowCount}，成功 ${successReversals}，人工 ${manualReversals}`
        );
      }

      const mailRows = this.buildMailRows(resolved.finalSuccessGroups);
      const manualRows = this.buildManualRows(resolved.manualGroups);
      const auditRows = this.buildAuditRows(resolved.finalSuccessGroups, resolved.manualGroups);
      const summary = {
        inputRowCount: grouping.stats.inputRowCount,
        relevantRowCount: grouping.stats.relevantRowCount,
        ignoredFundTypeRowCount: grouping.stats.ignoredFundTypeRowCount,
        reversalRowCount: grouping.stats.reversalRowCount,
        inboundRowCount: grouping.stats.inboundRowCount,
        bankGroupCount: grouping.stats.groupCount,
        bankCandidateGroupCount: grouping.stats.candidateGroupCount,
        mptSuccessGroupCount: resolved.stats.mptSuccessGroupCount,
        finalSuccessGroupCount: resolved.stats.finalSuccessGroupCount,
        bankManualGroupCount: resolved.stats.bankManualGroupCount,
        mptManualGroupCount: resolved.stats.mptManualGroupCount,
        documentManualGroupCount: resolved.stats.documentManualGroupCount,
        manualGroupCount: resolved.stats.manualGroupCount,
        mailRowCount: mailRows.length,
        manualRowCount: manualRows.length,
        auditGroupCount: auditRows.length,
        pureInboundGroupCount: grouping.stats.pureInboundGroupCount,
        pureInboundRowCount: grouping.stats.pureInboundRowCount,
        documentRowCount: this.documentSession.rowCount,
        documentMatchableRowCount: this.documentSession.matchableRowCount,
        documentEmptyBusinessOrderCount: this.documentSession.emptyBusinessOrderCount,
        reasonCounts: resolved.stats.reasonCounts,
        reversalConservation: {
          input: grouping.stats.reversalRowCount,
          success: successReversals,
          manual: manualReversals,
          isBalanced: true
        }
      };

      this.store.finishRun({
        monthKey: this.bankSession.monthKey,
        runId: sideRunId,
        summary,
        mailRows,
        manualRows,
        auditRows
      });
      this.database.finishDuplicateInboundMatchRunMirror(mirrorRunId, summary);
      this.lastRun = {
        monthKey: this.bankSession.monthKey,
        sideRunId,
        mirrorRunId,
        snapshotHash: before.snapshotHash,
        summary
      };
      if (onProgress) onProgress({ stage: 'done', message: '重复入金匹配完成' });
      return { status: 'success', runId: mirrorRunId, summary: { ...summary } };
    } catch (error) {
      if (sideRunId !== null) {
        try { this.store.failRun(this.bankSession.monthKey, sideRunId, error); } catch (_sideError) { /* 原错误优先 */ }
      }
      if (mirrorRunId !== null) {
        try {
          this.database.failDuplicateInboundMatchRunMirror(mirrorRunId, mirrorSafeError(error));
        } catch (_mirrorError) { /* 原错误优先 */ }
      }
      this.lastRun = null;
      throw error;
    }
  }

  async export({ savePath, onProgress } = {}) {
    if (!this.lastRun) {
      throw new DuplicateInboundMatchServiceError(
        'duplicate-inbound-run-missing',
        '请先运行重复入金匹配'
      );
    }
    const availability = this.inspectLastRun();
    if (!availability.available) {
      throw new DuplicateInboundMatchServiceError(
        availability.stale ? 'duplicate-inbound-run-stale' : 'duplicate-inbound-run-unavailable',
        availability.message || '运行结果不可用，请重新运行'
      );
    }
    const result = this.store.readResult(this.lastRun.monthKey, this.lastRun.sideRunId);
    if (!result) {
      throw new DuplicateInboundMatchServiceError(
        'duplicate-inbound-run-unavailable',
        '运行结果不可用，请重新运行'
      );
    }
    if (result.mailRows.length + result.manualRows.length === 0) {
      throw new DuplicateInboundMatchServiceError(
        'duplicate-inbound-export-empty',
        '本次运行没有成功邮件行或人工判定行，无法导出'
      );
    }
    if (onProgress) onProgress({ stage: 'write', message: '正在写入重复入金结果文件...' });
    await yieldToEventLoop();
    const written = await writeDuplicateInboundWorkbook({
      mailTemplatePath: this.mailTemplatePath,
      bankTemplatePath: this.bankTemplatePath,
      savePath,
      mailRows: result.mailRows,
      manualRows: result.manualRows
    });
    if (onProgress) onProgress({ stage: 'done', message: '重复入金结果文件已生成' });
    return written;
  }

  buildDefaultFileName(value = this.now()) {
    return buildDefaultFileName(value);
  }
}

function createDuplicateInboundMatchService(options) {
  return new DuplicateInboundMatchService(options);
}

module.exports = {
  MAIL_REMARK,
  DuplicateInboundMatchServiceError,
  DuplicateInboundMatchService,
  createDuplicateInboundMatchService,
  identifyInputFiles,
  localMonthKey,
  stableHash,
  validateBizIds,
  mirrorSafeError
};
