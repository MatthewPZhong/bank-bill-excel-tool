'use strict';

function pendingImportError(message) {
  return {
    status: 'error',
    errors: [{ severity: 'fatal', message }]
  };
}

function validatePendingImportPayload(payload = {}) {
  const files = Array.isArray(payload.files)
    ? payload.files.map((filePath) => String(filePath || '').trim()).filter(Boolean)
    : [];
  const yearMonth = String(payload.yearMonth || '').trim();
  if (files.length === 0) {
    return { stopResult: pendingImportError('未选择文件') };
  }
  if (!/^\d{4}-\d{2}$/.test(yearMonth)) {
    return { stopResult: pendingImportError('yearMonth 格式错误（应为 YYYY-MM）') };
  }
  return { files, yearMonth };
}

function readPendingMonthEvidence(db, monthRepository, yearMonth) {
  const existingCount = monthRepository.countRowsInMonth(db, yearMonth);
  const meta = monthRepository.getMonthMeta(db, yearMonth);
  return {
    existingCount,
    meta: meta ? {
      yearMonth: meta.yearMonth,
      importedAt: meta.importedAt,
      rowCount: meta.rowCount,
      sourceFiles: Array.isArray(meta.sourceFiles) ? meta.sourceFiles.slice() : [],
      archivePath: meta.archivePath || null
    } : null
  };
}

function pendingMonthEvidenceValue(evidence = {}) {
  return JSON.stringify({
    existingCount: Number(evidence.existingCount || 0),
    meta: evidence.meta || null
  });
}

function buildPendingImportConfirmationResult(yearMonth, evidence, contextId) {
  return {
    status: 'need-confirm',
    yearMonth,
    existingRowCount: evidence.existingCount,
    existingImportedAt: evidence.meta ? evidence.meta.importedAt : null,
    contextId
  };
}

function preparePendingImportSubmission({
  payload = {},
  confirmation = null,
  db = null,
  monthRepository,
  dbPath = '',
  createContextId,
  createFreshnessGuard
} = {}) {
  if (payload && payload.confirmOverwrite === true) {
    const contextId = String(payload.contextId || '').trim();
    if (!contextId || !confirmation || confirmation.contextId !== contextId) {
      return {
        nextConfirmation: confirmation,
        prepared: {
          proceed: false,
          result: pendingImportError(
            'Pending 覆盖确认上下文已失效，请重新选择文件'
          )
        }
      };
    }
    try {
      confirmation.assertFresh();
    } catch (error) {
      return {
        nextConfirmation: confirmation,
        prepared: {
          proceed: false,
          result: pendingImportError(
            error && error.message ? error.message : 'Pending 覆盖确认证据已变化'
          )
        }
      };
    }
    return {
      nextConfirmation: confirmation,
      prepared: {
        proceed: true,
        ...confirmation,
        overwriteConfirmed: true,
        inputPaths: confirmation.files,
        beforeStart: confirmation.assertFresh
      }
    };
  }

  const validated = validatePendingImportPayload(payload);
  if (validated.stopResult) {
    return {
      nextConfirmation: null,
      prepared: { proceed: false, result: validated.stopResult }
    };
  }
  if (!db) {
    return {
      nextConfirmation: null,
      prepared: {
        proceed: false,
        result: pendingImportError('Pending DB 未初始化')
      }
    };
  }

  const { files, yearMonth } = validated;
  const evidence = readPendingMonthEvidence(db, monthRepository, yearMonth);
  const assertFresh = createFreshnessGuard({ db, yearMonth, files, evidence });
  assertFresh();
  const preparedPlan = { files, yearMonth, evidence, dbPath, assertFresh };
  if (evidence.existingCount > 0) {
    const contextId = createContextId();
    const nextConfirmation = { contextId, ...preparedPlan };
    return {
      nextConfirmation,
      prepared: {
        proceed: false,
        result: buildPendingImportConfirmationResult(yearMonth, evidence, contextId)
      }
    };
  }

  return {
    nextConfirmation: null,
    prepared: {
      proceed: true,
      ...preparedPlan,
      overwriteConfirmed: false,
      inputPaths: files,
      beforeStart: assertFresh
    }
  };
}

function executePendingImportSubmission({
  pendingSession,
  prepared,
  onProgress,
  batchContext
} = {}) {
  if (!prepared || !Array.isArray(prepared.files) || !prepared.yearMonth
      || (prepared.evidence && prepared.evidence.existingCount > 0
        && prepared.overwriteConfirmed !== true)) {
    throw new TypeError('Pending 导入 execute 缺少已确认的准备计划');
  }
  if (!pendingSession || typeof pendingSession.runImport !== 'function') {
    throw new TypeError('Pending 导入 session 缺失');
  }
  return pendingSession.runImport({
    yearMonth: prepared.yearMonth,
    files: prepared.files,
    overwriteConfirmed: prepared.overwriteConfirmed === true,
    dbPath: prepared.dbPath,
    onProgress,
    batchContext
  });
}

module.exports = {
  buildPendingImportConfirmationResult,
  executePendingImportSubmission,
  pendingImportError,
  pendingMonthEvidenceValue,
  preparePendingImportSubmission,
  readPendingMonthEvidence,
  validatePendingImportPayload
};
