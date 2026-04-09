const path = require('node:path');

function createStatementGenerationHelpers(deps) {
  const {
    appendActivityLogEntry,
    buildImportWarningDetailLines,
    buildImportWarningMessage,
    buildManualBalanceRequiredResult,
    buildMappedRowsForFile,
    buildStatementGenerationConfig,
    buildStatementOutputFilePath,
    buildDateRangeLabel,
    cloneRowsWithMetadata,
    createErrorResult,
    createWarningResult,
    extractHeaders,
    findPreviousBalanceSeed,
    generateStatementFiles,
    getBalanceTemplatePath,
    getStatementSessionEntries,
    mergeMappedDetailRows,
    normalizeCell,
    normalizeInputFilePaths,
    parseRequiredBillDates,
    resolveSinglePreparedFieldValue,
    splitTemplateName,
    storeGeneratedBalanceSeeds,
    writeBalanceWorkbook,
    writeWorkbookRows,
    buildFieldIndexMap,
    deriveBalanceRecords,
    ensureStorageRoot,
    FileValidationError,
    appendLog
  } = deps;

  function collectUnmatchedAmountSplitFiles(fileEntries) {
    const unmatched = [];

    fileEntries.forEach((entry) => {
      const stats = entry?.detailRows?.amountSplitMatchStats;
      if (!stats || !stats.enabled) {
        return;
      }
      if (stats.totalRows > 0 && stats.hitCredit === 0 && stats.hitDebit === 0) {
        const filePath = entry.filePath || '';
        const displayName = filePath && filePath !== '__cached__'
          ? path.basename(filePath)
          : filePath;
        if (displayName) {
          unmatched.push(displayName);
        }
      }
    });

    return unmatched;
  }

  // v1.4.9 PR #16 review P1 Fix C: 平行于 collectUnmatchedAmountSplitFiles，
  // 收集启用了拆分/合并但所有源行都未产出任何拆分输出行的文件名（PRD ACI-12 / TC-V149-096）。
  // 触发条件: billSplitMatchStats.enabled === true 且 totalRows > 0 且 outputRows === 0。
  // 典型场景: 用户配了 billSplit 但拆分行的 source field 都被 0 值过滤掉 / 或
  // 每行 credit+debit 都为 0 / 或合并组净值都为 0，导致整个文件输出为空。
  function collectUnmatchedBillSplitFiles(fileEntries) {
    const unmatched = [];

    fileEntries.forEach((entry) => {
      const stats = entry?.detailRows?.billSplitMatchStats;
      if (!stats || !stats.enabled) {
        return;
      }
      if (stats.totalRows > 0 && stats.outputRows === 0) {
        const filePath = entry.filePath || '';
        const displayName = filePath && filePath !== '__cached__'
          ? path.basename(filePath)
          : filePath;
        if (displayName) {
          unmatched.push(displayName);
        }
      }
    });

    return unmatched;
  }

  function buildPreparedStatementBatchFromEntries({ config, fileEntries = [] }) {
    const unmatchedFiles = collectUnmatchedAmountSplitFiles(fileEntries);
    const unmatchedBillSplitFiles = collectUnmatchedBillSplitFiles(fileEntries);
    const detailRows = mergeMappedDetailRows(fileEntries.map((entry) => entry.detailRows));
    const selectedMerchantId = config.selectedMerchantId || resolveSinglePreparedFieldValue(detailRows, 'MerchantId', {
      buildFieldIndexMap,
      normalizeCell
    });
    const selectedCurrency = config.selectedCurrency || resolveSinglePreparedFieldValue(detailRows, 'Currency', {
      buildFieldIndexMap,
      normalizeCell
    });

    return {
      detailRows,
      warnings: Array.isArray(detailRows.issues) ? detailRows.issues.slice() : [],
      balanceRequested: Boolean(config.balanceRequested),
      balanceMode: config.balanceMode,
      selectedMerchantId,
      selectedCurrency,
      inputFilePaths: fileEntries.map((entry) => entry.filePath),
      unmatchedAmountSplitFiles: unmatchedFiles,
      unmatchedBillSplitFiles
    };
  }

  function buildPreparedStatementBatchFromFilePaths({ config, inputFilePaths = [] }) {
    const fileEntries = normalizeInputFilePaths(inputFilePaths, { dedupe: false }).map((inputFilePath) => ({
      filePath: inputFilePath,
      detailRows: buildMappedRowsForFile({
        config,
        inputFilePath
      })
    }));

    return {
      fileEntries,
      preparedBatch: buildPreparedStatementBatchFromEntries({
        config,
        fileEntries
      })
    };
  }

  function prepareGeneratedFiles({
    template,
    mappings,
    orderedTargetFields,
    inputFilePath,
    inputFilePaths,
    selectedBigAccount = null,
    scope = 'current'
  }) {
    const config = buildStatementGenerationConfig({
      template,
      mappings,
      orderedTargetFields,
      selectedBigAccount
    });
    const prepared = buildPreparedStatementBatchFromFilePaths({
      config,
      inputFilePaths: inputFilePaths || inputFilePath
    });

    return {
      ...generateStatementFiles({
        config,
        preparedBatch: prepared.preparedBatch,
        scope
      }),
      fileEntries: prepared.fileEntries,
      preparedBatch: prepared.preparedBatch
    };
  }

  function extractManualBalancePromptWarning(warnings = []) {
    return warnings.find((warning) => warning.type === 'balance-seed-required') || null;
  }

  function buildImportResultFromGeneratedFiles({
    generatedFiles,
    templateId,
    templateName,
    inputFilePath,
    inputFilePaths
  }) {
    const manualBalanceWarning = extractManualBalancePromptWarning(generatedFiles.warnings);
    const normalizedInputFilePaths = normalizeInputFilePaths(inputFilePaths || inputFilePath);
    const unmatchedAmountSplitFiles = Array.isArray(generatedFiles.unmatchedAmountSplitFiles)
      ? generatedFiles.unmatchedAmountSplitFiles.slice()
      : [];
    // v1.4.9 PR #16 review P1 Fix C
    const unmatchedBillSplitFiles = Array.isArray(generatedFiles.unmatchedBillSplitFiles)
      ? generatedFiles.unmatchedBillSplitFiles.slice()
      : [];

    if (manualBalanceWarning) {
      const manualResult = buildManualBalanceRequiredResult(manualBalanceWarning.prompt, generatedFiles);
      if (unmatchedAmountSplitFiles.length) {
        manualResult.unmatchedAmountSplitFiles = unmatchedAmountSplitFiles;
      }
      if (unmatchedBillSplitFiles.length) {
        manualResult.unmatchedBillSplitFiles = unmatchedBillSplitFiles;
      }
      return manualResult;
    }

    if (generatedFiles.warnings.length) {
      const detailReady = Boolean(generatedFiles.detail);
      const balanceReady = Boolean(generatedFiles.balance);
      const message = buildImportWarningMessage({
        warnings: generatedFiles.warnings,
        balanceReady,
        balanceRequested: generatedFiles.balanceRequested
      });

      const warningResult = createWarningResult({
        step: '导入网银明细文件',
        message,
        detailReady,
        balanceReady,
        detailLines: buildImportWarningDetailLines(generatedFiles.warnings),
        context: {
          templateId,
          inputFilePath,
          templateName
        },
        errorCode: 'FILE_IMPORT_WARNING',
        templateName
      });

      if (unmatchedAmountSplitFiles.length) {
        warningResult.unmatchedAmountSplitFiles = unmatchedAmountSplitFiles;
      }
      if (unmatchedBillSplitFiles.length) {
        warningResult.unmatchedBillSplitFiles = unmatchedBillSplitFiles;
      }

      return warningResult;
    }

    appendActivityLogEntry({
      level: 'info',
      message: '导入网银明细文件成功',
      details: [
        `模板名：${templateName}`,
        normalizedInputFilePaths.length > 1
          ? `源文件：${normalizedInputFilePaths.join('；')}`
          : `源文件：${normalizedInputFilePaths[0] || inputFilePath || ''}`,
        generatedFiles.balance ? '已生成余额账单' : '仅生成明细账单'
      ]
    });

    return {
      status: 'success',
      message: generatedFiles.message,
      detailReady: Boolean(generatedFiles.detail),
      balanceReady: Boolean(generatedFiles.balance),
      unmatchedAmountSplitFiles,
      unmatchedBillSplitFiles
    };
  }

  function buildPreparedBatchFromStatementSession({
    session,
    config,
    scope = 'all'
  }) {
    return buildPreparedStatementBatchFromEntries({
      config,
      fileEntries: getStatementSessionEntries(session, scope)
    });
  }

  function createGenerationContext({
    templateId,
    template,
    mappings,
    orderedTargetFields,
    inputFilePaths = [],
    selectedBigAccount = null,
    preparedDetailRows = null,
    scope = 'current',
    statementSessionKey = '',
    currentBatchId = ''
  }) {
    return {
      templateId,
      template,
      mappings,
      orderedTargetFields,
      inputFilePaths: normalizeInputFilePaths(inputFilePaths),
      selectedBigAccount,
      preparedDetailRows: preparedDetailRows ? cloneRowsWithMetadata(preparedDetailRows) : null,
      scope,
      statementSessionKey,
      currentBatchId
    };
  }

  function generateFilesFromRememberedContext(context) {
    if (!context) {
      throw new FileValidationError('FILE_READ', '当前没有可重新生成的导入上下文，请重新导入文件');
    }

    const config = buildStatementGenerationConfig({
      template: context.template,
      mappings: context.mappings,
      orderedTargetFields: context.orderedTargetFields,
      selectedBigAccount: context.selectedBigAccount,
      allowManagedMerchantWithoutSelection: Boolean(context.preparedDetailRows)
    });
    const preparedBatch = context.preparedDetailRows
      ? buildPreparedStatementBatchFromEntries({
          config,
          fileEntries: [{
            id: 'cached-context',
            filePath: '__cached__',
            detailRows: context.preparedDetailRows
          }]
        })
      : buildPreparedStatementBatchFromFilePaths({
          config,
          inputFilePaths: context.inputFilePaths
        }).preparedBatch;

    return generateStatementFiles({
      config,
      preparedBatch,
      scope: context.scope || 'current'
    });
  }

  function cacheCurrentStatementExports({
    session,
    generatedFiles,
    lastGeneratedExports
  }) {
    lastGeneratedExports.detail = generatedFiles.detail;
    lastGeneratedExports.balance = generatedFiles.balance;
    lastGeneratedExports.allDetail = null;
    lastGeneratedExports.allBalance = null;
    lastGeneratedExports.statementSessionKey = session?.key || '';
    lastGeneratedExports.currentBatchId = session?.currentBatchId || '';
  }

  function cacheAllStatementExport(lastGeneratedExports, kind, generatedFile) {
    if (kind === 'detail') {
      lastGeneratedExports.allDetail = generatedFile;
      return;
    }

    if (kind === 'balance') {
      lastGeneratedExports.allBalance = generatedFile;
    }
  }

  function updateStatementSessionCache(session, batchId, generatedFiles, lastGeneratedExports) {
    session.currentBatchId = batchId;
    cacheCurrentStatementExports({
      session,
      generatedFiles,
      lastGeneratedExports
    });
  }

  function buildStatementSessionGenerationContext({
    session,
    template,
    mappings,
    orderedTargetFields,
    scope
  }) {
    const config = buildStatementGenerationConfig({
      template,
      mappings,
      orderedTargetFields,
      allowManagedMerchantWithoutSelection: true
    });
    const preparedBatch = buildPreparedBatchFromStatementSession({
      session,
      config,
      scope
    });

    return {
      config,
      preparedBatch
    };
  }

  function getGeneratedStatementExport(lastGeneratedExports, kind, scope = 'current') {
    if (scope === 'all') {
      return kind === 'detail' ? lastGeneratedExports.allDetail : lastGeneratedExports.allBalance;
    }

    return kind === 'detail' ? lastGeneratedExports.detail : lastGeneratedExports.balance;
  }

  function buildScopeSelectionResult(kind) {
    return {
      status: 'select-export-scope',
      kind,
      options: [
        {
          scope: 'current',
          label: `导出当前文件的${kind === 'detail' ? '明细' : '余额'}`
        },
        {
          scope: 'all',
          label: `导出所有${kind === 'detail' ? '明细' : '余额'}`
        }
      ]
    };
  }

  return {
    buildImportResultFromGeneratedFiles,
    buildPreparedBatchFromStatementSession,
    buildPreparedStatementBatchFromEntries,
    buildPreparedStatementBatchFromFilePaths,
    buildScopeSelectionResult,
    buildStatementSessionGenerationContext,
    cacheAllStatementExport,
    cacheCurrentStatementExports,
    createGenerationContext,
    extractManualBalancePromptWarning,
    generateFilesFromRememberedContext,
    getGeneratedStatementExport,
    prepareGeneratedFiles,
    updateStatementSessionCache
  };
}

module.exports = {
  createStatementGenerationHelpers
};
