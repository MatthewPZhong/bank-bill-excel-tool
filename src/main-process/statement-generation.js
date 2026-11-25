const fs = require('node:fs');
const path = require('node:path');
const { getBalanceSeedFileIdentity, getBalanceSeedFilePath } = require('../backend/balance-seed-store');

const { mapEachCollectingCurrencyBigAccountIssues } = require('../backend/file-service/currency-big-account');
const { isZeroOrBlankAmount, parseDateValue } = require('../backend/file-service/normalizers');
const {
  FileValidationError: BillDateValidationError,
  assertNoUnwritableRowText,
  collectUnwritableRowText,
  noteUnwritableRowText,
  normalizeCell: normalizeBillDateCell
} = require('../backend/file-service/common');

// 账单日期的必填口径（parseRequiredBillDates 与写出前的只读校验共用）：表头须有 BillDate 列；
//   单元格为空时跳过，有值但无法解析时报错；整批没有任何有效日期时报错。
function requireBillDateIndex(headerRow) {
  const index = (Array.isArray(headerRow) ? headerRow : []).findIndex((field) => normalizeBillDateCell(field) === 'BillDate');
  if (index < 0) throw new BillDateValidationError('FILE_READ', '当前模板必须映射 BillDate 字段');
  return index;
}

// 返回解析后的日期；空值返回 null；无效值抛错
function parseRequiredBillDateCell(raw) {
  if (!normalizeBillDateCell(raw)) return null;
  const parsed = parseDateValue(raw);
  if (!parsed) throw new BillDateValidationError('FILE_READ', `账单日期存在无效值：${normalizeBillDateCell(raw)}`);
  return parsed;
}

function noValidBillDateError() {
  return new BillDateValidationError('FILE_READ', '导入文件中未找到有效的 BillDate');
}

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

// 余额账户键（MerchantId + 币种原样）：余额分组、种子查找与按账户的余额方式表共用。两部分中的 @ 先转义为 @a 再用 @@ 连接
//   （release 审查：原样拼接时 ('A@@B', 'USD') 与 ('A', 'B@@USD') 得到同一个键）；不含 @ 的账号、币种键与原来相同
function balanceAccountKey(merchantId, currency) {
  const escape = (value) => String(value == null ? '' : value).replace(/@/g, '@a');
  return `${escape(merchantId)}@@${escape(currency)}`;
}

// v3.2.21（D2）：渠道组内子模板余额方式不同时，余额只用出余额账户的行：按 modeByAccount（resolveAccountBalanceModes
//   的结果，同一账户只会有一种方式）取方式不是“不出余额”的账户的行引用与对应 rowMetas，不复制行（release 审查）。
//   MerchantId 为空的行不属于任何账户（出余额条目的这类交易已在生成前拦下），不取
function selectBalanceAccountRows(detailRows, modeByAccount) {
  const rows = Array.isArray(detailRows) ? detailRows : [];
  const header = Array.isArray(rows[0]) ? rows[0] : [];
  const fieldIndex = (name) => {
    const index = header.findIndex((field) => normalizeBillDateCell(field) === name);
    return index < 0 ? undefined : index;
  };
  const merchantIndex = fieldIndex('MerchantId');
  const currencyIndex = fieldIndex('Currency');
  const rowMetas = Array.isArray(rows.rowMetas) ? rows.rowMetas : [];
  const selected = [header];
  const selectedMetas = [];
  if (merchantIndex !== undefined && modeByAccount && typeof modeByAccount === 'object') {
    for (let index = 1; index < rows.length; index += 1) {
      const row = rows[index];
      if (!Array.isArray(row)) continue;
      const merchantId = normalizeBillDateCell(row[merchantIndex]);
      if (!merchantId) continue;
      const currency = currencyIndex === undefined ? '' : normalizeBillDateCell(row[currencyIndex]);
      const key = balanceAccountKey(merchantId, currency);
      if (!Object.prototype.hasOwnProperty.call(modeByAccount, key) || modeByAccount[key] === 'none') continue;
      selected.push(row);
      selectedMetas.push(rowMetas[index - 1] || null);
    }
  }
  selected.rowMetas = selectedMetas;
  return selected;
}

// v3.2.21：日期（YYYY-MM-DD）的首末两个边界（只有一个日期时一个），buildDateRangeLabel 得到的范围不变
function dateRangeBounds(dates) {
  let first = '';
  let last = '';
  for (const date of Array.isArray(dates) ? dates : []) {
    if (!date) continue;
    if (!first || date < first) first = date;
    if (!last || date > last) last = date;
  }
  if (!first) return [];
  return first === last ? [first] : [first, last];
}

// v3.2.22 B45：分组生成（传 writeOutput）时包住余额文件 / 种子的写出异常，穿过余额的业务告警分支原样抛给调用方
class StatementOutputWriteFailure {
  constructor(cause) {
    this.cause = cause;
  }
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
  function buildSimultaneousAmountError(simultaneousAmountRows, { config, inputFilePaths = [] }) {
    return new FileValidationError(
      'FILE_READ',
      `存在${simultaneousAmountRows.length}条明细的 Credit Amount 与 Debit Amount 同时有值`,
      {
        detailLines: simultaneousAmountRows.map((row) => {
          return `第${row.sourceRowNumber}行，Credit Amount="${row.creditAmount || '(空)'}"，Debit Amount="${row.debitAmount || '(空)'}"`;
        }),
        context: {
          inputFilePath: inputFilePaths.join(';'),
          templateName: statementOutputName(config)
        }
      }
    );
  }

  function balanceMerchantIdMappingError() {
    return new FileValidationError('FILE_READ', '当前模板启用 Balance 时必须映射 MerchantId 字段');
  }

  // v3.2.21：写出前的只读校验，与 generateStatementFiles 写出任何文件之前会抛出的检查同口径、同顺序（收支同时有值，
  //   账单日期，出余额时组配置须映射 MerchantId），只扫描、不复制明细行。多组生成（导入、补录重算、「导出全部」）在写出
  //   任何组、移除旧会话条目之前逐组调用，避免前几组的明细、余额与当日种子已落盘，后一组才失败。
  //   detailRowsList 按 mergeMappedDetailRows 的口径合并（首段表头为准，行号取合并后的 rowMetas）。
  //   unwritableText 可选（v3.2.22 B113，Codex 第六轮）：多组校验共用的计数，传入时只记下无法写入的字符、不在本组抛出，
  //   由调用方在各组校验完后一并拒绝（列出全批前 20 处与总数，修完一组才看到下一组的问题）
  function assertStatementRowsWritable({
    config,
    detailRowsList = [],
    inputFilePaths = [],
    balanceRequested = false,
    balanceModeByAccount = null,
    includeBalance = null,
    unwritableText: sharedUnwritableText = null
  }) {
    const segments = detailRowsList.filter((rows) => Array.isArray(rows) && rows.length > 0);
    const headerRow = segments.length && Array.isArray(segments[0][0]) ? segments[0][0] : [];
    const fieldIndexMap = buildFieldIndexMap(headerRow);
    const creditAmountIndex = fieldIndexMap.get('Credit Amount');
    const debitAmountIndex = fieldIndexMap.get('Debit Amount');
    const billDateIndex = fieldIndexMap.get('BillDate');
    const filtersAmountRows = creditAmountIndex !== undefined && debitAmountIndex !== undefined;
    // 一次遍历，只记结论、不收集行或日期：导出的行（收支恰有一个不为空或 0）是否存在、其中是否有有效日期及首个无效日期；
    //   没有导出的行时生成按全部行核对日期，这里同样记下全部行的结论
    // 收支同时有值的行只记诊断（行号与收支值，生成时报错列出的也是这些），不保留原行
    const simultaneousAmountRows = [];
    // 合并后的 rowMetas 是各段 rowMetas 依次拼接（mergeMappedDetailRows）：按各段起点定位，不展平
    const metaSegments = [];
    let metaOffset = 0;
    for (const rows of segments) {
      if (!Array.isArray(rows.rowMetas)) continue;
      metaSegments.push({ start: metaOffset, metas: rows.rowMetas });
      metaOffset += rows.rowMetas.length;
    }
    // 调用方按递增的合并下标查询（下方逐行遍历），沿段游标前进，不必每行从第一段找起（每条导出行都要取行号核对字符）
    let metaCursor = 0;
    const mergedRowMeta = (mergedIndex) => {
      while (metaCursor < metaSegments.length
        && mergedIndex >= metaSegments[metaCursor].start + metaSegments[metaCursor].metas.length) metaCursor += 1;
      const segment = metaSegments[metaCursor];
      return segment && mergedIndex >= segment.start ? segment.metas[mergedIndex - segment.start] : undefined;
    };
    const exported = { hasRow: false, hasValidDate: false, dateError: null };
    // v3.2.22 B113：导出行里无法原样写入工作表的文本（按最终明细，含回填的大账号），与 generateStatementFiles 写出前同口径
    const unwritableText = sharedUnwritableText || { total: 0, labels: [] };
    const all = { hasValidDate: false, dateError: null };
    const checkDate = (state, raw) => {
      if (state.dateError || billDateIndex === undefined) return;
      try {
        if (parseRequiredBillDateCell(raw)) state.hasValidDate = true;
      } catch (error) {
        state.dateError = error;
      }
    };
    let rowIndex = 0;
    for (const rows of segments) {
      for (let index = 1; index < rows.length; index += 1, rowIndex += 1) {
        const row = Array.isArray(rows[index]) ? rows[index] : [];
        const billDate = billDateIndex === undefined ? undefined : row[billDateIndex];
        if (!exported.hasRow) checkDate(all, billDate);
        if (filtersAmountRows) {
          const creditBlank = isZeroOrBlankAmount(row[creditAmountIndex]);
          const debitBlank = isZeroOrBlankAmount(row[debitAmountIndex]);
          if (!creditBlank && !debitBlank) {
            simultaneousAmountRows.push({
              sourceRowNumber: mergedRowMeta(rowIndex)?.sourceRowNumber || rowIndex + 2,
              creditAmount: normalizeCell(row[creditAmountIndex]),
              debitAmount: normalizeCell(row[debitAmountIndex])
            });
          }
          if (creditBlank === debitBlank) continue;
        }
        exported.hasRow = true;
        checkDate(exported, billDate);
        noteUnwritableRowText(unwritableText, row, headerRow, mergedRowMeta(rowIndex));
      }
    }
    if (simultaneousAmountRows.length) {
      throw buildSimultaneousAmountError(simultaneousAmountRows, { config, inputFilePaths });
    }
    requireBillDateIndex(headerRow);
    const dateState = exported.hasRow ? exported : all;
    if (dateState.dateError) throw dateState.dateError;
    if (!dateState.hasValidDate) throw noValidBillDateError();
    if (!sharedUnwritableText) assertNoUnwritableRowText(unwritableText);
    const shouldGenerateBalance = includeBalance === null
      ? Boolean(balanceRequested)
      : Boolean(includeBalance) && Boolean(balanceRequested);
    if (shouldGenerateBalance && !balanceModeByAccount && !config.mappingByTargetField.MerchantId) {
      throw balanceMerchantIdMappingError();
    }
  }

  // 已构建的批次（导入多组生成、补录重算）
  function assertStatementBatchWritable({ config, preparedBatch, includeBalance = null, unwritableText = null }) {
    assertStatementRowsWritable({
      config,
      detailRowsList: [preparedBatch.detailRows],
      inputFilePaths: preparedBatch.inputFilePaths || [],
      balanceRequested: preparedBatch.balanceRequested,
      balanceModeByAccount: preparedBatch.balanceModeByAccount || null,
      includeBalance,
      unwritableText
    });
  }

  // 尚未构建批次的条目（「导出全部」执行时的校验）：与 buildPreparedStatementBatchFromEntries 加
  //   balancePlan（resolveEntryBalancePlan 的结果，null 表示不按账户分方式）构建出的批次同口径
  function assertStatementEntriesWritable({ config, fileEntries = [], balancePlan = null, includeBalance = null, unwritableText = null }) {
    assertStatementRowsWritable({
      config,
      detailRowsList: fileEntries.map((entry) => entry.detailRows),
      inputFilePaths: fileEntries.map((entry) => entry.filePath),
      balanceRequested: balancePlan ? balancePlan.hasEffectiveRow : config.balanceRequested,
      balanceModeByAccount: balancePlan ? balancePlan.modeByAccount : null,
      includeBalance,
      unwritableText
    });
  }

  // writeOutput(filePath, write)：v3.2.22 B45，写出明细 / 余额文件、写余额种子文件都经它执行（多模板分组生成据此记下
  //   原状态与写后身份，失败时回滚）。传入时，余额文件与种子的写出失败原样抛出、由调用方整批回滚，不再转成
  //   「余额生成失败」告警（否则前组已写的种子留在盘上、余额汇总缺组）；补录、断档等待确认等业务告警不变。
  //   checkOutputTarget(filePath)：同时传入，首次读取余额种子前检查种子路径是否为普通文件。
  function generateStatementFiles({
    config,
    preparedBatch,
    scope = 'current',
    includeDetail = true,
    includeBalance = null,
    writeOutput = null,
    checkOutputTarget = null
  }) {
    const journaled = typeof writeOutput === 'function';
    const writeThrough = (filePath, write) => (journaled ? writeOutput(filePath, write) : write());
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
      throw buildSimultaneousAmountError(simultaneousAmountRows, { config, inputFilePaths: preparedBatch.inputFilePaths });
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
        : [],
      emptyPreprocessedFiles: Array.isArray(preparedBatch.emptyPreprocessedFiles)
        ? preparedBatch.emptyPreprocessedFiles.slice()
        : []
    };

    const shouldGenerateBalance = includeBalance === null
      ? Boolean(preparedBatch.balanceRequested)
      : Boolean(includeBalance) && Boolean(preparedBatch.balanceRequested);

    // v3.2.22 B113：写出任何文件前按最终明细（已回填或选择的大账号）核对文本能否原样写入，报源行号。余额记录的取值来自明细行；
    //   余额账单模板随程序发布（assets），其文字可原样写出由单测确认，不在运行时读取核对
    assertNoUnwritableRowText(collectUnwritableRowText(effectiveDetailRows, { rowMetas: effectiveDetailRows.rowMetas || [] }));

    if (includeDetail) {
      const detailOutput = buildStatementOutputFilePath({
        kind: 'detail',
        templateName: statementOutputName(config),
        merchantId: outputMerchantId,
        outputTag: 'COMMON',
        dateRangeLabel,
        internalSuffix
      });

      writeThrough(detailOutput.outputFilePath, () => writeWorkbookRows({
        rows: detailExportRows,
        outputFilePath: detailOutput.outputFilePath
      }));

      result.detail = {
        filePath: detailOutput.outputFilePath,
        fileName: detailOutput.outputFileName,
        templateName: statementOutputName(config),
        // v3.2.21：明细文件名日期范围的首末日期（写出的明细行；只写出表头时为全部行），多组汇总时按它命名明细文件；
        //   只留边界，不缓存逐笔日期
        billDates: dateRangeBounds(billDates)
      };
    }

    if (shouldGenerateBalance) {
      // v3.2.21（D2）：渠道组内余额方式不同（带 balanceModeByAccount）时，组配置模板可能不出余额，
      //   参与余额的各子模板是否映射 MerchantId 已在批次构建时按子模板核对
      if (!preparedBatch.balanceModeByAccount && !config.mappingByTargetField.MerchantId) {
        throw balanceMerchantIdMappingError();
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

        // v3.2.21（D2）：渠道组内子模板余额方式不同、有不出余额的条目时（balanceRowsByAccountMode），余额只用出余额账户的行：
        //   从已复制、已剔除收支都为空的行的 effectiveDetailRows 中按 balanceModeByAccount 取行引用（不复制余额子集、
        //   不构造导出行，release 审查），各账户按 balanceModeByAccount 取自己的方式；否则沿用明细的全部行与单一方式。
        let balanceDetailRows = effectiveDetailRows;
        if (preparedBatch.balanceRowsByAccountMode && preparedBatch.balanceModeByAccount) {
          balanceDetailRows = selectBalanceAccountRows(effectiveDetailRows, preparedBatch.balanceModeByAccount);
        }

        const templateBankName = splitTemplateName(statementOutputName(config)).bankName;
        // v3.2.22 B45：分组生成时先检查本组的余额种子路径（下面首次读取种子）：是文件夹等非普通文件时整批回滚，
        //   不转成「余额生成失败」告警（否则前组的新种子与缺组的余额汇总会提交）
        if (journaled && typeof checkOutputTarget === 'function') {
          try {
            checkOutputTarget(getBalanceSeedFilePath(ensureStorageRoot(), templateBankName));
          } catch (targetError) {
            // 已确认的不安全目标（文件夹、快捷方式等）才整批回滚；检查本身失败（如目录没有遍历权限 EACCES，此时尚未写种子）
            //   与原流程一样按「余额生成失败」处理本组余额、保留明细（Codex 第十一轮）
            if (targetError && targetError.code === 'STATEMENT_OUTPUT_TARGET_UNSAFE') throw new StatementOutputWriteFailure(targetError);
            // 系统错误的消息带种子文件路径（文件名可能是完整账号），只保留错误码再交给下面写日志（Codex 第十二轮）
            const code = targetError && targetError.code ? String(targetError.code) : '';
            throw Object.assign(new Error(`余额种子路径检查失败${code ? `（${code}）` : ''}`), { code });
          }
        }

        balanceSeedStatus = scanBalanceSeedStatus({
          detailRows: balanceDetailRows,
          templateName: statementOutputName(config)
        });

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
          detailRows: balanceDetailRows,
          templateName: statementOutputName(config),
          balanceTemplateFields,
          mode: preparedBatch.balanceMode,
          modeByAccount: preparedBatch.balanceModeByAccount || null,
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
        let balanceOutput;
        try {
          // 路径准备会建导出目录（ensureStorageRoot），与写出同样经下面的异常处理：分组生成时失败整批回滚，
          //   不转成「余额生成失败」告警提交前组的种子（spec D3，Codex 第十七轮 P1）
          balanceOutput = buildStatementOutputFilePath({
            kind: 'balance',
            templateName: statementOutputName(config),
            merchantId: outputMerchantId,
            outputTag: 'BALANCE',
            dateRangeLabel: buildDateRangeLabel(balanceResult.billDates),
            internalSuffix
          });
          // 读余额模板失败按模板不可读报出（spec D3；只在账单生成这里归类，见 writers.js）
          writeThrough(balanceOutput.outputFilePath, () => writeBalanceWorkbook({
            templateFilePath: balanceTemplatePath,
            records: balanceResult.records,
            templateFields: balanceTemplateFields,
            outputFilePath: balanceOutput.outputFilePath,
            reportTemplateReadFailure: true
          }));
          const seedRecords = Array.isArray(balanceResult.seedRecords) ? balanceResult.seedRecords : [];
          if (journaled && seedRecords.length) {
            // 逐笔写种子（每笔都重读、重写同一份 JSON）：每笔都经写出记录，写前核对身份、写后记下，
            //   前一笔写成后种子被其他程序替换时不再写入（spec D5）
            const seedFilePath = getBalanceSeedFilePath(seedStorageRoot, templateBankName);
            seedRecords.forEach((record) => writeThrough(seedFilePath, () => storeGeneratedBalanceSeeds({
              templateName: statementOutputName(config),
              seedRecords: [record]
            })));
          } else {
            storeGeneratedBalanceSeeds({
              templateName: statementOutputName(config),
              seedRecords
            });
          }
        } catch (writeError) {
          // 读取失败（FILE_READ：余额模板不可读、逐笔写种子前重读种子失败）发生在本次写入之前，与初次读取种子失败一样
          //   按「余额生成失败」告警处理，不整批回滚（spec D3，Codex 第六轮）
          const readFailure = writeError instanceof FileValidationError && writeError.code === 'FILE_READ';
          if (journaled && !readFailure) throw new StatementOutputWriteFailure(writeError);
          throw writeError;
        }
        // 已确认替换的人工补录写入后不再按它比对：用户已同意替换（D11）。
        (balanceResult.confirmedBalanceSeedReplacementKeys || []).forEach((key) => seenManualBalanceSeeds.delete(key));

        result.balance = {
          filePath: balanceOutput.outputFilePath,
          fileName: balanceOutput.outputFileName,
          templateName: statementOutputName(config),
          // v3.2.21：余额记录账单日期的首末日期（文件名的日期范围同此），多组汇总时按它命名余额文件
          billDates: dateRangeBounds(balanceResult.billDates)
        };
        result.message = includeDetail ? '明细账单可导出，余额账单可导出' : '余额账单可导出';
      } catch (error) {
        if (error instanceof StatementOutputWriteFailure) throw error.cause;
        if (error instanceof FileValidationError) {
          if (error.code === 'BALANCE_SEED_REQUIRED') {
            const promptMerchantId = normalizeCell(error.context?.merchantId);
            const promptCurrency = normalizeCell(error.context?.currency);
            const promptKey = balanceAccountKey(promptMerchantId, promptCurrency);
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

  // v3.2.19：收集勾选了原始账单预处理「过滤账单」、读到数据行但没有一行命中过滤规则的文件名
  //   （preprocessRowFilterStats.totalRows > 0 且 keptRows === 0），生成后提示检查过滤规则。
  function collectEmptyPreprocessedFiles(fileEntries) {
    const emptyFiles = [];

    fileEntries.forEach((entry) => {
      const stats = entry?.detailRows?.preprocessRowFilterStats;
      if (!stats || !stats.enabled) {
        return;
      }
      if (stats.totalRows > 0 && stats.keptRows === 0) {
        const filePath = entry.filePath || '';
        const displayName = filePath && filePath !== '__cached__'
          ? path.basename(filePath)
          : filePath;
        if (displayName) {
          emptyFiles.push(displayName);
        }
      }
    });

    return emptyFiles;
  }

  function buildPreparedStatementBatchFromEntries({ config, fileEntries = [] }) {
    const unmatchedFiles = collectUnmatchedAmountSplitFiles(fileEntries);
    const unmatchedBillSplitFiles = collectUnmatchedBillSplitFiles(fileEntries);
    const emptyPreprocessedFiles = collectEmptyPreprocessedFiles(fileEntries);
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
      unmatchedBillSplitFiles,
      emptyPreprocessedFiles
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

  // v3.2.19：重复账单过滤确认后去除的源行数（各文件 duplicateRowFilterStats 合计）
  function countDuplicateDroppedRows(fileEntries) {
    return (Array.isArray(fileEntries) ? fileEntries : []).reduce((sum, entry) => {
      const stats = entry && entry.detailRows && entry.detailRows.duplicateRowFilterStats;
      return sum + (stats && Number.isInteger(stats.droppedRowCount) ? stats.droppedRowCount : 0);
    }, 0);
  }

  // v3.2.19：开启重复账单过滤但无法核对原文、未参与查重的源行数（含公式、编码有损、格式无法核对等，保留不删）。
  //   拆分出的多行按源行计一次。
  function countDuplicateUncheckedRows(fileEntries) {
    return (Array.isArray(fileEntries) ? fileEntries : []).reduce((sum, entry) => {
      const metas = entry && entry.detailRows && Array.isArray(entry.detailRows.rowMetas) ? entry.detailRows.rowMetas : [];
      const rowNumbers = new Set(metas.filter((meta) => meta && meta.sourceRowKeyUnavailable === true)
        .map((meta) => meta.sourceRowNumber));
      return sum + rowNumbers.size;
    }, 0);
  }

  function withDuplicateDroppedMessage(message, droppedRowCount, uncheckedRowCount = 0) {
    const parts = [];
    if (droppedRowCount) parts.push(`已去除重复账单行 ${droppedRowCount} 行`);
    if (uncheckedRowCount) parts.push(`${uncheckedRowCount} 行无法核对原文，未参与重复账单过滤`);
    if (!parts.length) return message;
    const suffix = parts.join('；');
    return message ? `${message}；${suffix}` : suffix;
  }

  // 等待余额处理（补录、断档、不一致、替换）的结果同样带上去重行数，保留原余额操作提示
  function attachDuplicateDropped(result, droppedRowCount, uncheckedRowCount = 0) {
    if ((!droppedRowCount && !uncheckedRowCount) || !result || typeof result !== 'object') return result;
    if (droppedRowCount) result.duplicateDroppedRowCount = droppedRowCount;
    if (uncheckedRowCount) {
      result.duplicateUncheckedRowCount = uncheckedRowCount;
      // 等待余额处理的结果由余额结果构造时写日志，不含查重情况：另记一条，审计记录与界面提示一致
      if (typeof appendActivityLogEntry === 'function') appendActivityLogEntry({
        level: 'info',
        message: '重复账单过滤：部分账单行未参与查重',
        details: [`无法核对原文、未参与重复账单过滤：${uncheckedRowCount} 行`]
      });
    }
    result.message = withDuplicateDroppedMessage(result.message, droppedRowCount, uncheckedRowCount);
    return result;
  }

  function buildImportResultFromGeneratedFiles({
    generatedFiles,
    templateId,
    templateName,
    inputFilePath,
    inputFilePaths
  }) {
    // 补录余额后重新生成时 generatedFiles 不带 fileEntries，由调用方按会话条目算好传入 duplicateDroppedRowCount
    const duplicateDroppedRowCount = Number.isInteger(generatedFiles.duplicateDroppedRowCount)
      ? generatedFiles.duplicateDroppedRowCount
      : countDuplicateDroppedRows(generatedFiles.fileEntries);
    const duplicateUncheckedRowCount = Number.isInteger(generatedFiles.duplicateUncheckedRowCount)
      ? generatedFiles.duplicateUncheckedRowCount
      : countDuplicateUncheckedRows(generatedFiles.fileEntries);
    const manualBalanceWarning = extractManualBalancePromptWarning(generatedFiles.warnings);
    const normalizedInputFilePaths = normalizeInputFilePaths(inputFilePaths || inputFilePath);
    const unmatchedAmountSplitFiles = Array.isArray(generatedFiles.unmatchedAmountSplitFiles)
      ? generatedFiles.unmatchedAmountSplitFiles.slice()
      : [];
    // v1.4.9 PR #16 review P1 Fix C
    const unmatchedBillSplitFiles = Array.isArray(generatedFiles.unmatchedBillSplitFiles)
      ? generatedFiles.unmatchedBillSplitFiles.slice()
      : [];
    // v3.2.19：原始账单预处理过滤后没有账单行的文件
    const emptyPreprocessedFiles = Array.isArray(generatedFiles.emptyPreprocessedFiles)
      ? generatedFiles.emptyPreprocessedFiles.slice()
      : [];

    if (manualBalanceWarning) {
      const manualResult = buildManualBalanceRequiredResult(manualBalanceWarning.prompt, generatedFiles);
      if (unmatchedAmountSplitFiles.length) {
        manualResult.unmatchedAmountSplitFiles = unmatchedAmountSplitFiles;
      }
      if (unmatchedBillSplitFiles.length) {
        manualResult.unmatchedBillSplitFiles = unmatchedBillSplitFiles;
      }
      if (emptyPreprocessedFiles.length) {
        manualResult.emptyPreprocessedFiles = emptyPreprocessedFiles;
      }
      return attachDuplicateDropped(manualResult, duplicateDroppedRowCount, duplicateUncheckedRowCount);
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
      if (emptyPreprocessedFiles.length) {
        gapResult.emptyPreprocessedFiles = emptyPreprocessedFiles;
      }
      return attachDuplicateDropped(gapResult, duplicateDroppedRowCount, duplicateUncheckedRowCount);
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
      if (emptyPreprocessedFiles.length) {
        mismatchResult.emptyPreprocessedFiles = emptyPreprocessedFiles;
      }
      return attachDuplicateDropped(mismatchResult, duplicateDroppedRowCount, duplicateUncheckedRowCount);
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
      if (emptyPreprocessedFiles.length) {
        replaceResult.emptyPreprocessedFiles = emptyPreprocessedFiles;
      }
      return attachDuplicateDropped(replaceResult, duplicateDroppedRowCount, duplicateUncheckedRowCount);
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
        message: withDuplicateDroppedMessage(message, duplicateDroppedRowCount, duplicateUncheckedRowCount),
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
      if (emptyPreprocessedFiles.length) {
        warningResult.emptyPreprocessedFiles = emptyPreprocessedFiles;
      }

      if (duplicateUncheckedRowCount) warningResult.duplicateUncheckedRowCount = duplicateUncheckedRowCount;
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
        generatedFiles.balance ? '已生成余额账单' : '仅生成明细账单',
        ...(duplicateDroppedRowCount ? [`已去除重复账单行：${duplicateDroppedRowCount} 行`] : []),
        ...(duplicateUncheckedRowCount ? [`无法核对原文、未参与重复账单过滤：${duplicateUncheckedRowCount} 行`] : [])
      ]
    });

    return {
      status: 'success',
      message: withDuplicateDroppedMessage(generatedFiles.message, duplicateDroppedRowCount, duplicateUncheckedRowCount),
      duplicateDroppedRowCount,
      ...(duplicateUncheckedRowCount ? { duplicateUncheckedRowCount } : {}),
      detailReady: Boolean(generatedFiles.detail),
      balanceReady: Boolean(generatedFiles.balance),
      unmatchedAmountSplitFiles,
      unmatchedBillSplitFiles,
      emptyPreprocessedFiles
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
    // v3.2.19：重复账单过滤只在导入时经用户确认后去重；从源文件重新映射会把已去除的重复行带回来，拒绝。
    if (!context.preparedDetailRows && config.duplicateRowFilterEnabled) {
      throw new FileValidationError('FILE_READ', '模板已勾选「重复账单过滤」，无法从源文件重新生成，请重新导入文件');
    }
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
    assertStatementBatchWritable,
    assertStatementEntriesWritable,
    assertNoUnwritableRowText,
    attachDuplicateDropped,
    buildImportResultFromGeneratedFiles,
    buildPreparedBatchFromStatementSession,
    buildPreparedStatementBatchFromEntries,
    buildPreparedStatementBatchFromFilePaths,
    buildScopeSelectionResult,
    buildStatementSessionGenerationContext,
    cacheAllStatementExport,
    cacheCurrentStatementExports,
    countDuplicateDroppedRows,
    countDuplicateUncheckedRows,
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
  balanceAccountKey,
  createStatementGenerationHelpers,
  noValidBillDateError,
  parseRequiredBillDateCell,
  pendingBalanceSeedAccounts,
  requireBillDateIndex,
  selectBalanceAccountRows,
  statementOutputName
};
