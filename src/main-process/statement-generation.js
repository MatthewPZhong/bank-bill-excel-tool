const fs = require('node:fs');
const path = require('node:path');
const { getBalanceSeedFileIdentity } = require('../backend/balance-seed-store');

const { mapEachCollectingCurrencyBigAccountIssues } = require('../backend/file-service/currency-big-account');

// v3.2.15（T3）：输出身份（文件名、余额银行名、种子、余额调整、补录提示）取配置上的 outputName：
//   属于渠道的模板为渠道名，普通模板为模板名；缺省时回退模板名（兼容未带 outputName 的旧配置）。
function statementOutputName(config) {
  const outputName = config && typeof config.outputName === 'string' ? config.outputName.trim() : '';
  return outputName || String(config && config.template && config.template.name || '');
}

// v3.2.17：缺种子补录提示附带本组全部待补录账号（scanBalanceSeedStatus 的 missingAccounts；
//   不含“已有种子但对不上”的账号），供补录弹窗「导入余额文件」按银行账号 + 币种匹配。
function pendingBalanceSeedAccounts(balanceSeedStatus) {
  const accounts = balanceSeedStatus && Array.isArray(balanceSeedStatus.missingAccounts)
    ? balanceSeedStatus.missingAccounts
    : [];
  return accounts.map((account) => ({
    merchantId: account.merchantId,
    currency: account.currency,
    targetBillDate: account.targetBillDate
  }));
}

function createStatementGenerationHelpers(deps) {
  const {
    appendActivityLogEntry,
    buildImportWarningDetailLines,
    buildImportWarningMessage,
    buildManualBalanceRequiredResult,
    buildBalanceGapConfirmResult,
    buildBalanceMismatchConfirmResult,
    buildBalanceSeedReplaceConfirmResult,
    getAcknowledgedBalanceGapKeys,
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
    readBalanceSeedRecords,
    storeGeneratedBalanceSeeds,
    writeBalanceWorkbook,
    writeWorkbookRows,
    buildFieldIndexMap,
    deriveBalanceRecords,
    ensureStorageRoot,
    FileValidationError,
    // 可注入：测试用它模拟区分大小写等文件系统；缺省按磁盘上的实际文件取身份。
    resolveBalanceSeedFileIdentity = getBalanceSeedFileIdentity,
    appendLog
  } = deps;

  // 本次运行里见过的人工补录（v3.2.16 Codex 审查 P1）：种子文件身份 → 账号@@币种@@日期 → 最近一次读到的人工补录。
  // 按磁盘上的实际种子文件分组（getBalanceSeedFileIdentity）：银行名写法不同但是同一个文件时共用一份记录，
  // 不同文件互不影响（不会把另一个文件里没有的日期当成删除，也不会用另一个文件的人工值比对）。
  // 每次生成读种子时由 deriveBalanceRecords 同步（新补录、改值记下，种子已删的去掉）。工具按同值回写会把人工补录
  // 改成工具生成；之后不论哪个模板、哪个入口（同批后续组、返回核查后的重算、分批导入、导出全部）与该日余额不同，
  // 仍按这里的人工补录提醒替换。确认替换并写入后去掉该日。只存内存，重启失效（与确认键同一口径）。
  const seenManualBalanceSeedsByFile = new Map();

  // 与读取种子用同一个 storageRoot + 银行名、同一时刻解析。文件还不存在时没有可保护的记录，用一次性的空记录。
  function seenManualBalanceSeedsFor(storageRoot, bankName) {
    const fileIdentity = resolveBalanceSeedFileIdentity(storageRoot, bankName);
    if (!fileIdentity) return new Map();
    if (!seenManualBalanceSeedsByFile.has(fileIdentity)) seenManualBalanceSeedsByFile.set(fileIdentity, new Map());
    return seenManualBalanceSeedsByFile.get(fileIdentity);
  }

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
            templateName: statementOutputName(config)
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
        templateName: statementOutputName(config),
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
        templateName: statementOutputName(config)
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
          templateName: statementOutputName(config)
        });

        const templateBankName = splitTemplateName(statementOutputName(config)).bankName;
        const balanceAdjustments = readBalanceAdjustments(
          ensureStorageRoot(),
          templateBankName
        );

        // 断档“不补录”与余额不一致“确认继续”共用会话确认集合（键以类型前缀区分）。
        const acknowledgedBalanceKeys = typeof getAcknowledgedBalanceGapKeys === 'function'
          ? getAcknowledgedBalanceGapKeys()
          : null;
        const seedStorageRoot = ensureStorageRoot();
        const seenManualBalanceSeeds = seenManualBalanceSeedsFor(seedStorageRoot, templateBankName);
        const balanceResult = deriveBalanceRecords({
          detailRows: effectiveDetailRows,
          templateName: statementOutputName(config),
          balanceTemplateFields,
          mode: preparedBatch.balanceMode,
          balanceAdjustments,
          acknowledgedBalanceGapKeys: acknowledgedBalanceKeys,
          acknowledgedBalanceMismatchKeys: acknowledgedBalanceKeys,
          acknowledgedBalanceSeedReplaceKeys: acknowledgedBalanceKeys,
          // 同一账单日的人工补录种子：回写前与本次余额比对，不一致须确认替换。
          existingBalanceSeeds: typeof readBalanceSeedRecords === 'function'
            ? readBalanceSeedRecords(seedStorageRoot, templateBankName)
            : [],
          seenManualBalanceSeeds,
          resolvePreviousBalanceSeed: ({ bankName, merchantId, currency, targetBillDate, generationMethod }) => (
            findPreviousBalanceSeed(ensureStorageRoot(), {
              bankName,
              merchantId,
              currency,
              beforeBillDate: targetBillDate,
              generationMethod
            })
          )
        });
        if (balanceResult.skippedBalanceGaps.length) {
          warnings.push({ type: 'balance-gap-skipped', gaps: balanceResult.skippedBalanceGaps });
        }
        if (Array.isArray(balanceResult.confirmedBalanceMismatches) && balanceResult.confirmedBalanceMismatches.length) {
          warnings.push({ type: 'balance-mismatch-confirmed', mismatches: balanceResult.confirmedBalanceMismatches });
        }
        if (Array.isArray(balanceResult.confirmedBalanceSeedReplacements) && balanceResult.confirmedBalanceSeedReplacements.length) {
          warnings.push({ type: 'balance-seed-replace-confirmed', replacements: balanceResult.confirmedBalanceSeedReplacements });
        }
        const balanceOutput = buildStatementOutputFilePath({
          kind: 'balance',
          templateName: statementOutputName(config),
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
          templateName: statementOutputName(config),
          seedRecords: balanceResult.seedRecords
        });
        // 已确认替换的人工补录写入后不再按它比对：用户已同意替换（D11）。
        (balanceResult.confirmedBalanceSeedReplacementKeys || []).forEach((key) => seenManualBalanceSeeds.delete(key));

        result.balance = {
          filePath: balanceOutput.outputFilePath,
          fileName: balanceOutput.outputFileName,
          templateName: statementOutputName(config)
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
                templateName: statementOutputName(config),
                bankName: error.context?.bankName || splitTemplateName(statementOutputName(config)).bankName,
                merchantId: promptMerchantId,
                currency: promptCurrency,
                targetBillDate: normalizeCell(error.context?.targetBillDate),
                queueIndex,
                queueTotal,
                pendingAccounts: pendingBalanceSeedAccounts(balanceSeedStatus),
                // 已有种子但首日对不上时附上明细，补录弹窗据此说明原因（v3.2.16 D7）。
                ...(error.context?.seedMismatch
                  ? {
                      seedMismatch: {
                        ...error.context.seedMismatch,
                        statementBalances: [...(error.context.seedMismatch.statementBalances || [])]
                      }
                    }
                  : {})
              }
            });
          } else if (error.code === 'BALANCE_GAP_CONFIRM_REQUIRED') {
            warnings.push({
              type: 'balance-gap-confirm',
              message: error.message,
              gaps: Array.isArray(error.context?.gaps) ? error.context.gaps : []
            });
          } else if (error.code === 'BALANCE_MISMATCH_CONFIRM_REQUIRED') {
            warnings.push({
              type: 'balance-mismatch-confirm',
              message: error.message,
              mismatches: Array.isArray(error.context?.mismatches) ? error.context.mismatches : []
            });
          } else if (error.code === 'BALANCE_SEED_REPLACE_CONFIRM_REQUIRED') {
            warnings.push({
              type: 'balance-seed-replace-confirm',
              message: error.message,
              replacements: Array.isArray(error.context?.replacements) ? error.context.replacements : []
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
    // v3.2.16：币种未维护大账号的问题跨文件汇总后一次报错（spec D1）
    const fileEntries = mapEachCollectingCurrencyBigAccountIssues(
      normalizeInputFilePaths(inputFilePaths, { dedupe: false }),
      (inputFilePath) => ({
        filePath: inputFilePath,
        detailRows: buildMappedRowsForFile({
          config,
          inputFilePath
        })
      })
    );

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

  // 多个模板组各自返回的断档合并成一次确认。
  function extractBalanceGapConfirmGaps(warnings = []) {
    return warnings
      .filter((warning) => warning.type === 'balance-gap-confirm')
      .flatMap((warning) => (Array.isArray(warning.gaps) ? warning.gaps : []));
  }

  // 多个模板组各自返回的余额不一致合并成一次确认（在补录、断档之后处理）。
  function extractBalanceMismatchConfirmItems(warnings = []) {
    return warnings
      .filter((warning) => warning.type === 'balance-mismatch-confirm')
      .flatMap((warning) => (Array.isArray(warning.mismatches) ? warning.mismatches : []));
  }

  // 多个模板组各自返回的人工补录替换合并成一次确认（最后处理）。
  function extractBalanceSeedReplaceConfirmItems(warnings = []) {
    return warnings
      .filter((warning) => warning.type === 'balance-seed-replace-confirm')
      .flatMap((warning) => (Array.isArray(warning.replacements) ? warning.replacements : []));
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

    const balanceGaps = extractBalanceGapConfirmGaps(generatedFiles.warnings);
    if (balanceGaps.length && typeof buildBalanceGapConfirmResult === 'function') {
      const gapResult = buildBalanceGapConfirmResult(balanceGaps, generatedFiles);
      if (unmatchedAmountSplitFiles.length) {
        gapResult.unmatchedAmountSplitFiles = unmatchedAmountSplitFiles;
      }
      if (unmatchedBillSplitFiles.length) {
        gapResult.unmatchedBillSplitFiles = unmatchedBillSplitFiles;
      }
      return gapResult;
    }

    const balanceMismatches = extractBalanceMismatchConfirmItems(generatedFiles.warnings);
    if (balanceMismatches.length && typeof buildBalanceMismatchConfirmResult === 'function') {
      const mismatchResult = buildBalanceMismatchConfirmResult(balanceMismatches, generatedFiles);
      if (unmatchedAmountSplitFiles.length) {
        mismatchResult.unmatchedAmountSplitFiles = unmatchedAmountSplitFiles;
      }
      if (unmatchedBillSplitFiles.length) {
        mismatchResult.unmatchedBillSplitFiles = unmatchedBillSplitFiles;
      }
      return mismatchResult;
    }

    const balanceSeedReplacements = extractBalanceSeedReplaceConfirmItems(generatedFiles.warnings);
    if (balanceSeedReplacements.length && typeof buildBalanceSeedReplaceConfirmResult === 'function') {
      const replaceResult = buildBalanceSeedReplaceConfirmResult(balanceSeedReplacements, generatedFiles);
      if (unmatchedAmountSplitFiles.length) {
        replaceResult.unmatchedAmountSplitFiles = unmatchedAmountSplitFiles;
      }
      if (unmatchedBillSplitFiles.length) {
        replaceResult.unmatchedBillSplitFiles = unmatchedBillSplitFiles;
      }
      return replaceResult;
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

  function cacheAllStatementExport(lastGeneratedExports, kind, generatedFile, balanceWarnings = []) {
    if (kind === 'detail') {
      lastGeneratedExports.allDetail = generatedFile;
      return;
    }

    if (kind === 'balance') {
      // 生成该文件时的告警随文件一起缓存：命中缓存再导出时仍带出已接受的风险（v3.2.16 D12）。
      lastGeneratedExports.allBalance = generatedFile
        ? { ...generatedFile, balanceWarnings: Array.isArray(balanceWarnings) ? balanceWarnings.slice() : [] }
        : generatedFile;
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
    extractBalanceGapConfirmGaps,
    extractBalanceMismatchConfirmItems,
    extractBalanceSeedReplaceConfirmItems,
    generateStatementFiles,
    generateFilesFromRememberedContext,
    getGeneratedStatementExport,
    prepareGeneratedFiles,
    updateStatementSessionCache
  };
}

module.exports = {
  createStatementGenerationHelpers,
  pendingBalanceSeedAccounts,
  statementOutputName
};
