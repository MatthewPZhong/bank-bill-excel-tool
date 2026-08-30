const fs = require('node:fs');
const path = require('node:path');

function createStatementGenerationHelpers(deps) {
  const {
    appendActivityLogEntry,
    buildImportWarningDetailLines,
    buildImportWarningMessage,
    buildManualBalanceRequiredResult,
    buildDetailExportRows,
    buildMappedRowsForFile,
    buildStatementGenerationConfig,
    buildStatementOutputFilePath,
    buildDateRangeLabel,
    cloneRowsWithMetadata,
    createErrorResult,
    createWarningResult,
    extractHeaders,
    findPreviousBalanceSeed,
    getBalanceTemplatePath,
    getStatementSessionEntries,
    mergeMappedDetailRows,
    normalizeCell,
    normalizeInputFilePaths,
    parseRequiredBillDates,
    resolveSinglePreparedFieldValue,
    splitTemplateName,
    scanBalanceSeedStatus,
    readBalanceAdjustments,
    storeGeneratedBalanceSeeds,
    writeBalanceWorkbook,
    writeWorkbookRows,
    buildFieldIndexMap,
    deriveBalanceRecords,
    ensureStorageRoot,
    FileValidationError,
    appendLog
  } = deps;

  // E09-P0 现状取证接缝：production Main 委托到此同一函数；依赖注入不改变
  // 现有 storage、writer 与 balance 的所有权。
  function generateStatementFiles({
    config,
    preparedBatch,
    scope = 'current',
    includeDetail = true,
    includeBalance = null
  }) {
    const warnings = Array.isArray(preparedBatch.warnings) ? preparedBatch.warnings.slice() : [];
    const detailRows = cloneRowsWithMetadata(preparedBatch.detailRows);
    const detailExportRows = buildDetailExportRows(detailRows);
    const effectiveDetailRows = Array.isArray(detailExportRows.sourceRows)
      ? detailExportRows.sourceRows
      : detailRows;
    const skippedDetailRows = Array.isArray(detailExportRows.skippedRows)
      ? detailExportRows.skippedRows
      : [];
    const simultaneousAmountRows = Array.isArray(detailExportRows.simultaneousRows)
      ? detailExportRows.simultaneousRows
      : [];

    if (simultaneousAmountRows.length) {
      throw new FileValidationError(
        'FILE_READ',
        `存在${simultaneousAmountRows.length}条明细的 Credit Amount 与 Debit Amount 同时有值`,
        {
          detailLines: simultaneousAmountRows.map((row) => {
            return `第${row.sourceRowNumber}行，Credit Amount="${row.creditAmount || '(空)'}"，Debit Amount="${row.debitAmount || '(空)'}"`;
          }),
          context: {
            inputFilePath: preparedBatch.inputFilePaths.join(';'),
            templateName: config.template.name
          }
        }
      );
    }

    skippedDetailRows.forEach((row) => {
      warnings.push({
        type: 'detail-row-skipped',
        rowNumber: row.sourceRowNumber,
        creditAmount: row.creditAmount,
        debitAmount: row.debitAmount
      });
    });

    const billDates = detailExportRows.length > 1
      ? parseRequiredBillDates(detailExportRows)
      : parseRequiredBillDates(detailRows);
    const dateRangeLabel = buildDateRangeLabel(billDates);
    const internalSuffix = scope === 'all' ? 'all' : '';
    const outputMerchantId = scope === 'all' ? '' : preparedBatch.selectedMerchantId;

    const result = {
      detail: null,
      balance: null,
      message: includeDetail && includeBalance !== true ? '明细账单可导出' : '',
      warnings,
      balanceRequested: Boolean(preparedBatch.balanceRequested),
      unmatchedAmountSplitFiles: Array.isArray(preparedBatch.unmatchedAmountSplitFiles)
        ? preparedBatch.unmatchedAmountSplitFiles.slice()
        : [],
      unmatchedBillSplitFiles: Array.isArray(preparedBatch.unmatchedBillSplitFiles)
        ? preparedBatch.unmatchedBillSplitFiles.slice()
        : []
    };

    if (includeDetail) {
      const detailOutput = buildStatementOutputFilePath({
        kind: 'detail',
        templateName: config.template.name,
        merchantId: outputMerchantId,
        outputTag: 'COMMON',
        dateRangeLabel,
        internalSuffix
      });

      writeWorkbookRows({
        rows: detailExportRows,
        outputFilePath: detailOutput.outputFilePath
      });

      result.detail = {
        filePath: detailOutput.outputFilePath,
        fileName: detailOutput.outputFileName,
        templateName: config.template.name
      };
    }

    const shouldGenerateBalance = includeBalance === null
      ? Boolean(preparedBatch.balanceRequested)
      : Boolean(includeBalance) && Boolean(preparedBatch.balanceRequested);

    if (shouldGenerateBalance) {
      if (!config.mappingByTargetField.MerchantId) {
        throw new FileValidationError('FILE_READ', '当前模板启用 Balance 时必须映射 MerchantId 字段');
      }

      let balanceSeedStatus = {
        missing: 0,
        missingIndexByKey: new Map()
      };

      try {
        const balanceTemplatePath = getBalanceTemplatePath();

        if (!fs.existsSync(balanceTemplatePath)) {
          throw new FileValidationError('FILE_READ', '未找到余额账单模板，请确认文件已放入 assets 目录');
        }

        const balanceTemplateFields = extractHeaders(balanceTemplatePath);

        if (!balanceTemplateFields.length) {
          throw new FileValidationError('FILE_READ', '余额账单模板为空或不可读，请重新确认');
        }

        balanceSeedStatus = scanBalanceSeedStatus({
          detailRows: effectiveDetailRows,
          templateName: config.template.name
        });

        const templateBankName = splitTemplateName(config.template.name).bankName;
        const balanceAdjustments = readBalanceAdjustments(
          ensureStorageRoot(),
          templateBankName
        );

        const balanceResult = deriveBalanceRecords({
          detailRows: effectiveDetailRows,
          templateName: config.template.name,
          balanceTemplateFields,
          mode: preparedBatch.balanceMode,
          balanceAdjustments,
          resolvePreviousEndBalance: ({ bankName, merchantId, currency, targetBillDate }) => {
            const seedRecord = findPreviousBalanceSeed(ensureStorageRoot(), {
              bankName,
              merchantId,
              currency,
              beforeBillDate: targetBillDate
            });

            return seedRecord ? seedRecord.endBalance : null;
          }
        });
        const balanceOutput = buildStatementOutputFilePath({
          kind: 'balance',
          templateName: config.template.name,
          merchantId: outputMerchantId,
          outputTag: 'BALANCE',
          dateRangeLabel: buildDateRangeLabel(balanceResult.billDates),
          internalSuffix
        });

        writeBalanceWorkbook({
          templateFilePath: balanceTemplatePath,
          records: balanceResult.records,
          templateFields: balanceTemplateFields,
          outputFilePath: balanceOutput.outputFilePath
        });
        storeGeneratedBalanceSeeds({
          templateName: config.template.name,
          seedRecords: balanceResult.seedRecords
        });

        result.balance = {
          filePath: balanceOutput.outputFilePath,
          fileName: balanceOutput.outputFileName,
          templateName: config.template.name
        };
        result.message = includeDetail ? '明细账单可导出，余额账单可导出' : '余额账单可导出';
      } catch (error) {
        if (error instanceof FileValidationError) {
          if (error.code === 'BALANCE_SEED_REQUIRED') {
            const promptMerchantId = normalizeCell(error.context?.merchantId);
            const promptCurrency = normalizeCell(error.context?.currency);
            const promptKey = `${promptMerchantId}@@${promptCurrency}`;
            const queueIndex = balanceSeedStatus.missingIndexByKey?.get(promptKey) || 1;
            const queueTotal = balanceSeedStatus.missing || 1;

            warnings.push({
              type: 'balance-seed-required',
              message: error.message,
              prompt: {
                templateName: config.template.name,
                bankName: error.context?.bankName || splitTemplateName(config.template.name).bankName,
                merchantId: promptMerchantId,
                currency: promptCurrency,
                targetBillDate: normalizeCell(error.context?.targetBillDate),
                queueIndex,
                queueTotal
              }
            });
          } else {
            warnings.push({
              type: 'balance-generate-failed',
              message: error.message
            });
          }
        } else {
          const logPath = appendLog(ensureStorageRoot(), error);
          warnings.push({
            type: 'balance-generate-failed',
            message: '余额账单生成失败，系统异常已写入日志文件',
            logPath
          });
        }
      }
    }

    return result;
  }

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
          label: `导出当前批次文件的${kind === 'detail' ? '明细' : '余额'}`
        },
        {
          scope: 'all',
          label: `导出所有批次文件的${kind === 'detail' ? '明细' : '余额'}`
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
    generateStatementFiles,
    generateFilesFromRememberedContext,
    getGeneratedStatementExport,
    prepareGeneratedFiles,
    updateStatementSessionCache
  };
}

module.exports = {
  createStatementGenerationHelpers
};
