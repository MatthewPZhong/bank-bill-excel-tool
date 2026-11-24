const path = require('node:path');
const {
  FEATURE_FILTER_FIELD_TOKEN_PREFIX,
  FileValidationError,
  FIXED_FIELD_VALUE_PREFIX,
  MERCHANT_ID_CURRENCY_ONLY_MARKER,
  SUPPORTED_EXTENSIONS,
  buildExpectedHeaderCandidates,
  isUnverifiedLongNumber,
  isWorksheetWritableText,
  normalizeCell
} = require('./file-service/common');
const {
  LEGACY_FEATURE_FILTER_ID,
  buildFeatureFilterToken,
  collectFeatureFilterIds,
  extractFeatureValue,
  getFeatureFilterRef,
  normalizeFeatureFilterList,
  normalizeFeatureFilterRule,
  parseFeatureFilterToken,
  resolveUsedFeatureFilters,
  upgradeLegacyFeatureFilter
} = require('./file-service/feature-filter');
const {
  LOGIC_VALUE_MIN_FIELDS,
  buildLogicValueFeatureCandidate,
  buildLogicValueToken,
  collectLogicValueFeatureFilterIds,
  collectLogicValueFields,
  normalizeLogicValueFields,
  parseLogicValueFeatureFilterRef,
  parseLogicValueToken,
  resolveLogicValue
} = require('./file-service/logic-value');
const {
  buildSourceRowKey,
  describeDuplicateKeeperReplacementConflicts,
  dropDuplicateSourceRows,
  findDuplicateKeeperReplacementConflicts,
  scanDuplicateSourceRows
} = require('./file-service/duplicate-source-rows');
const {
  ensureSupportedFile,
  extractEnumValuesFromImportedFile,
  extractHeaders,
  loadEnumValues,
  readRows,
  readRowsWithMetadata
} = require('./file-service/readers');
const {
  calculateEndingBalanceFromAmounts,
  compileRegexLiteral,
  hasEffectiveAmount,
  isDetailExportAmountRow,
  isZeroOrBlankAmount,
  inferDateCellFormat,
  verifyStatementEndingBalance,
  isRegexLiteral,
  loadCurrencyMappings: loadCurrencyMappingsFromMappings,
  matchAmountSplitConditionValue,
  normalizeDateExportValue,
  parseDateValue,
  parseNumericValue,
  resolveCurrencyValue,
  roundAmount,
  roundAmountHighPrecision,
  sanitizeAmountValue,
  sanitizeSignedAmountValue,
  splitSignedAmountValue,
  sumAmounts,
  toExcelSerial
} = require('./file-service/normalizers');
const {
  FEE_FORMULA_OPERATOR_LABELS,
  evaluateFeeAmountFormula,
  normalizeFeeAmountFormula,
  validateFeeAmountFormula
} = require('./file-service/bill-split-fee-formula');
const {
  isFeeFieldMappingTemplateFieldExcluded,
  normalizeFeeFieldMappings,
  resolveFeeFieldMappingValue,
  assertFeeFieldOutputWritable,
  validateFeeFieldMappings
} = require('./file-service/bill-split-fee-field-mappings');
const {
  ROW_FILTER_OPERATORS,
  collectBillSplitRowFilterFields,
  compileBillSplitRowFilter,
  matchesBillSplitRowFilter,
  normalizeBillSplitRowFilterRules,
  validateBillSplitRowFilterRules
} = require('./file-service/bill-split-row-filter');
const {
  PREPROCESS_ROW_FILTER_MISSING_MESSAGE,
  compileRowFilterRules,
  matchesRowFilterRules,
  normalizeRowFilterRules,
  validateRowFilterRules
} = require('./file-service/row-filter-rules');
const {
  appendCurrencyBigAccountIssues,
  applyCurrencyBigAccountMapping,
  buildCurrencyBigAccountUnmappedError,
  createConfigMissingError: createCurrencyBigAccountConfigMissingError,
  isCurrencyBigAccountUnmappedError,
  mapEachCollectingCurrencyBigAccountIssues
} = require('./file-service/currency-big-account');
const {
  assertBalanceRecordsWritable,
  prepareWorkbookTextForWrite,
  writeBalanceWorkbook: writeBalanceWorkbookInternal,
  writeWorkbookRows: writeWorkbookRowsInternal
} = require('./file-service/writers');

function loadCurrencyMappings(filePath) {
  return loadCurrencyMappingsFromMappings(filePath, { readRows });
}

const INVALID_BILL_DATE_DETAIL_LIMIT = 20;

// 账单自带合计行的识别标签：账单日期列整格等于其中之一时按合计行跳过（如 KBANK-VN 第 73 行「Tổng / Total」，
// 借贷两列是全表总额）。只做整格精确比较（忽略大小写、多余空格和「/」两侧空格），不做包含匹配，
// 交易行的日期列不会是这些文字，因此只影响原本会被判为无效账单日期的行。
const STATEMENT_SUMMARY_DATE_LABELS = new Set([
  'Tổng / Total',
  'Tổng cộng / Total',
  'Tổng',
  'Tổng cộng',
  'Total',
  'Grand Total',
  '合计',
  '总计'
].map(normalizeSummaryDateLabel));

function normalizeSummaryDateLabel(value) {
  return normalizeCell(value)
    .normalize('NFC')
    .toLowerCase()
    .replace(/\s*\/\s*/g, ' / ')
    .replace(/\s+/g, ' ');
}

function isStatementSummaryDateLabel(value) {
  const normalized = normalizeSummaryDateLabel(value);
  return normalized !== '' && STATEMENT_SUMMARY_DATE_LABELS.has(normalized);
}

// 有金额的行 BillDate 有值却不是有效日期时整份拒绝：否则该笔留在明细（日期为空），余额计算却静默跳过。
// 收付金额均为空或 0 的行不进明细（buildDetailExportRows 跳过），不拦。
// 带金额且账单日期列是合计标签的行已在映射时按合计行跳过并记入 issues（summary-row-skipped），不会走到这里。
function assertNoInvalidBillDateRows({ mappedRows, rowMetas, orderedTargetFields, invalidBillDateBySourceRow }) {
  if (!invalidBillDateBySourceRow.size) {
    return;
  }

  const billDateIndex = orderedTargetFields.indexOf('BillDate');
  const creditAmountIndex = orderedTargetFields.indexOf('Credit Amount');
  const debitAmountIndex = orderedTargetFields.indexOf('Debit Amount');
  const amountColumnsMapped = creditAmountIndex >= 0 && debitAmountIndex >= 0;
  const invalidRows = [];
  const reportedRowNumbers = new Set();

  mappedRows.slice(1).forEach((mappedRow, index) => {
    const sourceRowNumber = rowMetas[index] ? rowMetas[index].sourceRowNumber : undefined;

    if (reportedRowNumbers.has(sourceRowNumber) || !invalidBillDateBySourceRow.has(sourceRowNumber)) {
      return;
    }

    if (normalizeCell(mappedRow[billDateIndex]) !== '') {
      return;
    }

    if (
      amountColumnsMapped &&
      !hasEffectiveAmount(mappedRow[creditAmountIndex]) &&
      !hasEffectiveAmount(mappedRow[debitAmountIndex])
    ) {
      return;
    }

    reportedRowNumbers.add(sourceRowNumber);
    invalidRows.push({ sourceRowNumber, rawValue: invalidBillDateBySourceRow.get(sourceRowNumber) });
  });

  if (!invalidRows.length) {
    return;
  }

  const detailLines = invalidRows
    .slice(0, INVALID_BILL_DATE_DETAIL_LIMIT)
    .map((item) => `第 ${item.sourceRowNumber} 行：${item.rawValue}`);

  if (invalidRows.length > INVALID_BILL_DATE_DETAIL_LIMIT) {
    detailLines.push(`另有 ${invalidRows.length - INVALID_BILL_DATE_DETAIL_LIMIT} 行，共 ${invalidRows.length} 行`);
  }

  const [firstRow] = invalidRows;
  throw new FileValidationError(
    'FILE_READ',
    `账单日期存在无效值：第 ${firstRow.sourceRowNumber} 行「${firstRow.rawValue}」${invalidRows.length > 1 ? `等 ${invalidRows.length} 行` : ''}，请修正后重新导入`,
    { detailLines }
  );
}

// 主映射 Balance 选「通过发生额计算」时生成配置保留的映射值（与 main.js BALANCE_CALCULATED_OPTION 相同；「无」不进入生成配置）
const BALANCE_CALCULATED_MAPPING_VALUE = '通过发生额计算';

function buildMappedRows({
  inputFilePath,
  orderedTargetFields,
  mappingByField,
  accountMappingByBankId = {},
  currencyMappings = [],
  amountMappingRules = {},
  amountSplitByField = null,
  billSplitMerge = null,
  // v3.2.18：实际生效映射用到的特征值 { [id]: { id, name, ...rule } }（main.js resolveStatementFeatureFilters）
  featureFilters = null,
  expectedSourceHeaders = [],
  selectedBigAccount = null,
  dateParseOrder = 'auto',
  readOptions = {},
  // v3.2.16：MerchantId「原始账单仅有币种无账户号」时为 { templateName, pairs: [{ currency, merchantId }] }
  currencyBigAccountMapping = null,
  // v3.2.19：原始账单预处理「过滤账单」的过滤规则（main.js 只在勾选且规则有效时下发，否则为 null）
  preprocessRowFilterRules = null,
  // v3.2.19：原始账单预处理「重复账单过滤」——为 true 时每个源行的内容指纹写入 rowMetas[i].sourceRowKey，
  //   供导入时跨文件查重（duplicate-source-rows.js）；不开启时不计算。
  duplicateRowKeys = false
}) {
  // 拿不到 币种 → 大账号 配置时直接拒绝，避免 MerchantId 整列留空静默输出。
  const merchantIdUsesCurrencyMapping = normalizeMappingTokens(mappingByField && mappingByField.MerchantId)[0]
    === MERCHANT_ID_CURRENCY_ONLY_MARKER;
  if (merchantIdUsesCurrencyMapping && !currencyBigAccountMapping) {
    throw createCurrencyBigAccountConfigMissingError('');
  }
  const {
    rows: sourceRows,
    rowNumbers: sourceRowNumbers,
    headerBreaks = [],
    fullRows: sourceFullRows = null,
    fullHeaders: sourceFullHeaders = null,
    fullColumnOffset: sourceFullColumnOffset = 0,
    longIntegerReadValues: sourceLongIntegerReadValues = null
  } = readRowsWithMetadata(
    inputFilePath,
    expectedSourceHeaders,
    // v3.2.21 B112：长数字按文件原文读取、CSV 数据行取 Excel 显示值（readers.js exactSourceText）
    duplicateRowKeys ? { ...readOptions, includeFullRows: true, exactSourceText: true } : { ...readOptions, exactSourceText: true }
  );
  const sourceHeaders = sourceRows[0] || [];
  // v3.2.19 重复账单过滤：指纹按整行计算——源行与其所属分段的表头都含模板表头范围以外的列（模板没取的列如流水号
  //   不同、或分段表头不同都不算重复），Excel 错误值与空白不同。
  const fullSourceRowByNumber = new Map();
  if (sourceFullRows) {
    sourceRowNumbers.forEach((rowNumber, index) => {
      if (index > 0) {
        fullSourceRowByNumber.set(rowNumber, {
          headers: (sourceFullHeaders && sourceFullHeaders[index]) || sourceFullRows[0] || sourceHeaders,
          cells: sourceFullRows[index]
        });
      }
    });
  }
  const sourceIndexByField = new Map();
  const issues = [];
  const rowMetas = [];
  // 源行号 → 有值但无法识别为日期的 BillDate 原值（如 2026-11-31），映射完成后按行金额判定是否整份拒绝。
  const invalidBillDateBySourceRow = new Map();
  const nameSourceField = normalizeCell(amountMappingRules.nameSourceField);
  const accountSourceField = normalizeCell(amountMappingRules.accountSourceField);
  const signedAmountSourceField = normalizeCell(amountMappingRules.signedAmountSourceField);
  const selectedMerchantId = normalizeCell(selectedBigAccount?.merchantId);
  const selectedCurrency = normalizeCell(selectedBigAccount?.currency);
  const amountSplitEnabled = Boolean(amountSplitByField && amountSplitByField.enabled);
  const amountSplitRules = amountSplitEnabled && Array.isArray(amountSplitByField.rules)
    ? amountSplitByField.rules
    : [];
  const billSplitEnabled = Boolean(billSplitMerge && billSplitMerge.enabled);
  // 余额只在取账单余额列时用到 Balance 映射：主映射 Balance 为「无」时生成配置已去掉该映射，为「通过发生额计算」时余额按发生额
  //   推导，两种情况下 Balance 映射的源列（含拆分映射的）都不参与计算、作标识时按原文；Balance 列也不写进明细，
  //   这一列读到的长数字不提示（release 审查）
  const mainBalanceTokens = normalizeMappingTokens((mappingByField || {}).Balance);
  const balanceFromStatementColumn = mainBalanceTokens.length > 0
    && !(mainBalanceTokens.length === 1 && mainBalanceTokens[0] === BALANCE_CALCULATED_MAPPING_VALUE);
  const unusedBalanceTargetIndex = balanceFromStatementColumn ? -1 : orderedTargetFields.indexOf('Balance');
  // P1 Fix B (PR #16 review): 双保险，只接受 rowStatus === 'completed' 的拆分行；
  // main.js buildBillSplitMergeConfig 已 filter 过一次，这里再过滤防止未来某个路径绕过。
  const billSplitRows = billSplitEnabled && Array.isArray(billSplitMerge.billSplitRows)
    ? billSplitMerge.billSplitRows.filter((r) => r && r.rowStatus === 'completed')
    : [];
  const billSplitAmountRules = billSplitEnabled && Array.isArray(billSplitMerge.billSplitAmountRules)
    ? billSplitMerge.billSplitAmountRules
    : [];
  const billSplitSignedField = billSplitEnabled
    ? normalizeCell(billSplitMerge.signedAmountSourceField)
    : '';
  const billSplitSignedTargetSeqNos = billSplitEnabled && Array.isArray(billSplitMerge.signedAmountTargetSeqNos)
    ? billSplitMerge.signedAmountTargetSeqNos
    : [];
  const billSplitByFieldTargetSeqNos = billSplitEnabled && Array.isArray(billSplitMerge.byFieldAmountTargetSeqNos)
    ? billSplitMerge.byFieldAmountTargetSeqNos
    : [];
  // v3.2.19：费用账单发生额公式。main.js 只在启用特殊取值且有已完成的费用账单行时下发（已校验）。
  const billSplitFeeFormula = billSplitEnabled
      && Array.isArray(billSplitMerge.feeAmountFormula)
      && billSplitMerge.feeAmountFormula.length > 0
    ? billSplitMerge.feeAmountFormula
    : null;
  // v3.2.21：费用账单「字段映射特殊处理」。main.js 只在勾选且有已完成的费用账单行时下发（已校验）；
  //   这里再挡一次不允许覆盖的字段（账户号、币种、发生额、余额），不在本次导出字段中的项忽略。
  const billSplitFeeFieldMappings = billSplitEnabled
      && Array.isArray(billSplitMerge.feeFieldMappings)
      && billSplitMerge.feeFieldMappings.length > 0
    ? normalizeFeeFieldMappings(billSplitMerge.feeFieldMappings)
      .filter((item) => item.templateField && !isFeeFieldMappingTemplateFieldExcluded(item.templateField))
      .map((item) => ({ ...item, targetIndex: orderedTargetFields.indexOf(item.templateField) }))
      .filter((item) => item.targetIndex >= 0)
    : [];
  // 费用账单行被覆盖的目标列下标：底稿中这些列读到的长数字不随费用账单行提示
  const billSplitFeeFieldTargetIndexes = new Set(billSplitFeeFieldMappings.map((item) => item.targetIndex));
  // 费用行覆盖的 ValueDate 列（写出前按主映射同口径规范化，可能为空）
  const feeValueDateTargetIndexes = billSplitFeeFieldMappings.filter((item) => item.templateField === 'ValueDate').map((item) => item.targetIndex);
  // 费用账单行不取自映射的字段：被覆盖的字段，以及由拆分规则取值的 Credit / Debit Amount（特征值未命中提示用）
  const billSplitFeeRowUnmappedTargets = new Set(['Credit Amount', 'Debit Amount']
    .concat(billSplitFeeFieldMappings.map((item) => item.templateField)));
  // 非 0 ÷ 0 的源行号：整份读完后一次报错列出（合计行不计入）。
  const feeFormulaDivisionByZeroRowNumbers = [];
  let currentRowFeeFormulaDivisionByZero = false;
  // P1 Fix A (PR #16 review): reuseModuleMapping === false 时非金额字段走弹框 1 的独立 lookup
  const billSplitReuseModuleMapping = billSplitEnabled
    ? billSplitMerge.reuseModuleMapping !== false
    : true;
  const billSplitMappingByField = billSplitEnabled
      && billSplitMerge.billSplitMappingByTargetField
      && typeof billSplitMerge.billSplitMappingByTargetField === 'object'
    ? billSplitMerge.billSplitMappingByTargetField
    : {};
  // P2 Fix D (PR #16 review): expandBillSplitForRow 的 Name/CardNo per-row 分配需要
  // 知道"当前应该用哪套 mapping 判定"——reuseModuleMapping=true 时用主模板 mappingByField，
  // false 时用 billSplitMappingByField。每个 source row 在进入拆分前 (见外层 forEach) 更新。
  let billSplitEffectiveMappingByField = null;
  // v3.2.19：根据字段值过滤账单——只有命中过滤规则的源行走拆分/合并，其余行走主映射；不开启时全部源行走拆分。
  //   main.js 只在拆分与过滤都开启、规则有效时下发 rowFilterRules。
  const billSplitRowFilterRules = billSplitEnabled
      && Array.isArray(billSplitMerge.rowFilterRules)
      && billSplitMerge.rowFilterRules.length > 0
    ? billSplitMerge.rowFilterRules
    : null;
  let matchedCreditCount = 0;
  let matchedDebitCount = 0;
  let matchedBillSplitCount = 0;
  let billSplitPathRowCount = 0;

  sourceHeaders.forEach((header, index) => {
    const normalizedHeader = normalizeCell(header);

    if (normalizedHeader && !sourceIndexByField.has(normalizedHeader)) {
      sourceIndexByField.set(normalizedHeader, index);
    }
  });

  // v3.2.21 B112：长整数按原文还原的单元格（读取层只替换数据行）。发生额、余额取值的列仍用读取库的数值：
  //   余额按数值计算，明细与余额须是同一个值（与修改前一致），这类值照常按无法核对原值提示。
  //   其余列记下还原出的原文，诊断内容据此不写完整号码。
  const restoredLongIntegerTexts = new Set();
  let restoredLongIntegerMaxLength = 0;
  // 诊断内容（报错文件、活动日志）中把按原文还原的长数字换成位数，明细中的值不变。
  //   诊断值可能是多列拼接（如两列拼成币种），在每段连续数字里逐位置找最长的还原原文
  const maskRestoredLongIntegers = (text) => {
    if (!restoredLongIntegerTexts.size || typeof text !== 'string' || !text) return text;
    return text.replace(/\d{16,}/g, (digits) => {
      let masked = '';
      let index = 0;
      while (index < digits.length) {
        let matchedLength = 0;
        for (let length = Math.min(restoredLongIntegerMaxLength, digits.length - index); length >= 16; length -= 1) {
          if (restoredLongIntegerTexts.has(digits.slice(index, index + length))) {
            matchedLength = length;
            break;
          }
        }
        if (matchedLength) {
          masked += `（${matchedLength}位数值）`;
          index += matchedLength;
        } else {
          masked += digits[index];
          index += 1;
        }
      }
      return masked;
    });
  };
  const amountSourceFields = collectAmountSourceFields();
  if (Array.isArray(sourceLongIntegerReadValues)) {
    const amountColumns = new Set();
    sourceHeaders.forEach((header, index) => {
      if (amountSourceFields.has(normalizeCell(header))) amountColumns.add(index);
    });
    sourceRows.forEach((row, index) => {
      const readValues = index > 0 ? sourceLongIntegerReadValues[index] : null;
      if (!(readValues instanceof Map) || !Array.isArray(row)) return;
      readValues.forEach((value, columnIndex) => {
        if (amountColumns.has(columnIndex)) {
          row[columnIndex] = value;
          return;
        }
        const restored = normalizeCell(row[columnIndex]);
        restoredLongIntegerTexts.add(restored);
        restoredLongIntegerMaxLength = Math.max(restoredLongIntegerMaxLength, restored.length);
      });
    });
  }

  // 实际参与发生额、余额计算的源字段（与生成时的取值分支一致；只保存供恢复、不参与计算的映射不算，该列按原文）：
  //   - 主映射 Balance；拆分不复用模块映射时拆分映射的 Balance；
  //   - 有行走主映射时（未开拆分，或开了「根据字段值过滤账单」）：按字段区分发生额的规则字段，或按正负号拆分的字段，
  //     或 Credit / Debit 映射（含逻辑取值的候补字段、特征值的源字段），三者按优先级只取生效的一种；
  //   - 拆分：逐行按实际的发生额分支——费用账单公式字段、按正负号拆分的字段、按字段区分发生额的规则字段，
  //     或该行的收入（费用账单行除外）/ 支出字段
  function collectAmountSourceFields() {
    const fields = new Set();
    // 映射 token、按 readSourceCell 读取的拆分设置字段：以固定值前缀开头的是固定值，不是源列
    const addField = (field) => {
      const normalized = normalizeCell(field);
      if (normalized && !normalized.startsWith(FIXED_FIELD_VALUE_PREFIX)) fields.add(normalized);
    };
    // 逻辑取值的候补字段、特征值的源字段、主映射按字段区分发生额的规则字段：读取时按真实表头取，不解释任何前缀
    const addSourceField = (field) => {
      const normalized = normalizeCell(field);
      if (normalized) fields.add(normalized);
    };
    // 特征值（直接映射或逻辑取值的候补）按其规则读取的源列
    const addFeatureFilterSourceField = (featureFilterId) => {
      const featureFilter = featureFilters && featureFilters[featureFilterId];
      if (featureFilter) addSourceField(featureFilter.sourceField);
    };
    const addMapping = (mappingValue) => normalizeMappingTokens(mappingValue).forEach((token) => {
      const logicValueFields = parseLogicValueToken(token);
      if (logicValueFields !== null) {
        logicValueFields.forEach((field) => {
          const featureFilterRef = parseLogicValueFeatureFilterRef(field);
          if (featureFilterRef !== null) addFeatureFilterSourceField(featureFilterRef);
          else addSourceField(field);
        });
        return;
      }
      const featureFilterId = parseFeatureFilterToken(token);
      if (featureFilterId !== null) {
        addFeatureFilterSourceField(featureFilterId);
        return;
      }
      addField(token);
    });
    // 主映射的 Balance 只在有行用它出余额时计入：未开拆分、开了「根据字段值过滤账单」（未命中的行走主映射），或拆分行复用
    //   模块映射；拆分且不复用、不过滤时所有行的余额都取拆分映射，主映射 Balance 的源列作标识时按原文（release 审查）
    if (balanceFromStatementColumn && (!billSplitEnabled || billSplitRowFilterRules || billSplitReuseModuleMapping)) {
      addMapping((mappingByField || {}).Balance);
    }
    if (balanceFromStatementColumn && billSplitEnabled && !billSplitReuseModuleMapping) addMapping(billSplitMappingByField.Balance);
    if (!billSplitEnabled || billSplitRowFilterRules) {
      if (amountSplitEnabled) {
        amountSplitRules.forEach((rule) => addSourceField(rule && rule.mappedField));
      } else if (signedAmountSourceField) {
        addMapping(signedAmountSourceField);
      } else {
        addMapping((mappingByField || {})['Credit Amount']);
        addMapping((mappingByField || {})['Debit Amount']);
      }
    }
    // 拆分行逐行按 expandBillSplitForRow 的发生额分支取字段（两处须同步）；拆分设置的字段都按 readSourceCell 读取
    const hasSignedTargets = billSplitSignedTargetSeqNos.length > 0;
    const hasByFieldTargets = billSplitByFieldTargetSeqNos.length > 0;
    // 与 evaluateBillSplitAmountRulesForRow 同一口径：没有 mappedField 的规则取第一条有 mappedField 的规则的字段；
    //   费用账单行只有支出，只读支出规则（debitOnly）
    const fallbackRule = billSplitAmountRules.find((rule) => rule && rule.mappedField);
    const addBillSplitRuleFields = (debitOnly) => billSplitAmountRules.forEach((rule) => {
      const targetField = normalizeCell(rule && rule.targetField);
      if (targetField !== 'Debit Amount' && (debitOnly || targetField !== 'Credit Amount')) return;
      addField(rule.mappedField || (fallbackRule ? fallbackRule.mappedField : ''));
    });
    billSplitRows.forEach((row) => {
      if (row.isFeeBill && billSplitFeeFormula) {
        billSplitFeeFormula.forEach((item) => addField(item && item.field));
      } else if (hasSignedTargets && billSplitSignedTargetSeqNos.includes(row.seqNo) && billSplitSignedField) {
        addField(billSplitSignedField);
      } else if (hasByFieldTargets && billSplitByFieldTargetSeqNos.includes(row.seqNo) && billSplitAmountRules.length) {
        addBillSplitRuleFields(row.isFeeBill);
      } else if ((billSplitSignedField || billSplitAmountRules.length) && !hasSignedTargets && !hasByFieldTargets) {
        if (billSplitSignedField) addField(billSplitSignedField);
        else addBillSplitRuleFields(row.isFeeBill);
      } else {
        if (!row.isFeeBill) addField(row.creditSourceField);
        addField(row.debitSourceField);
      }
    });
    return fields;
  }

  // v3.2.19：原始账单预处理「过滤账单」——只保留命中过滤规则的源行（原始账单加工表），未命中的行不参与之后的
  //   主映射、拆分/合并、合计行识别与各项统计；保留行的行号仍是源文件物理行号。规则字段不在源文件表头中时拒绝生成。
  const preprocessed = applyPreprocessRowFilter(sourceRows, sourceRowNumbers, preprocessRowFilterRules, sourceIndexByField);
  const { rows, rowNumbers } = preprocessed;

  const compiledBillSplitRowFilter = billSplitRowFilterRules
    ? compileBillSplitRowFilter(billSplitRowFilterRules, sourceIndexByField)
    : null;
  // 主映射的币种与发生额只给未命中的行用：命中行按未开过滤时的口径计算底稿（主映射不取币种），
  // 拆分行币种单元格为空时不回落到主映射币种，也不为命中行记主映射的币种提示。
  const mainMappingForBillSplitRows = compiledBillSplitRowFilter
    ? Object.fromEntries(Object.entries(mappingByField || {}).filter(([targetField]) => targetField !== 'Currency'))
    : mappingByField;
  // v3.2.21：拆分输出行实际沿用映射的字段所用的特征值，按最终输出提示未命中：拆分行的 Credit / Debit 由拆分配置取值，
  //   费用账单行另去掉被字段映射特殊处理覆盖的字段。每条源行按其输出行的种类取并集。
  const billSplitBaseMapping = billSplitEnabled && !billSplitReuseModuleMapping ? billSplitMappingByField : mainMappingForBillSplitRows;
  //   只看本次导出的字段（库中残留、已不导出的映射所用的特征值不参与输出）。
  const exportedTargetFieldSet = new Set(orderedTargetFields);
  const collectFeatureFilterIdSetExcept = (mapping, excludedTargets) => new Set(collectFeatureFilterIds(
    Object.fromEntries(Object.entries(mapping || {}).filter(([targetField]) => (
      exportedTargetFieldSet.has(targetField) && !excludedTargets.has(targetField)
    )))
  ));
  const billSplitRowFeatureFilterIdSet = collectFeatureFilterIdSetExcept(billSplitBaseMapping, new Set(['Credit Amount', 'Debit Amount']));
  const billSplitFeeRowFeatureFilterIdSet = collectFeatureFilterIdSetExcept(billSplitBaseMapping, billSplitFeeRowUnmappedTargets);

  // v3.2.16：字段筛选特征值——实际生效的映射（拆分且不复用时为拆分映射，否则为主映射）用到 token 时启用；
  // v3.2.18：每个用到的特征值每行只计算一次，选同一特征值的目标字段共用同一个结果，再各自走后续规范化（日期、金额等）。
  // 不复用时主映射里残留的该值不输出，不启用、也不记未命中提示。
  // v3.2.19：根据字段值过滤账单时未命中的行走主映射，主映射与拆分映射用到的特征值都启用；未命中提示只记该行所走映射用到的。
  // v3.2.21：逻辑取值候补引用的特征值同样按所在映射启用，但不计入未命中提示（未筛出视为空、取下一个候补）。
  const mainPathFeatureFilterIds = collectFeatureFilterIds(mappingByField);
  const billSplitPathFeatureFilterIds = billSplitEnabled && !billSplitReuseModuleMapping
    ? collectFeatureFilterIds(billSplitMappingByField)
    : mainPathFeatureFilterIds;
  const mainPathLogicValueFeatureFilterIds = collectLogicValueFeatureFilterIds(mappingByField);
  const billSplitPathLogicValueFeatureFilterIds = billSplitEnabled && !billSplitReuseModuleMapping
    ? collectLogicValueFeatureFilterIds(billSplitMappingByField)
    : mainPathLogicValueFeatureFilterIds;
  const mainPathEffective = !billSplitEnabled || billSplitReuseModuleMapping || Boolean(compiledBillSplitRowFilter);
  const activeFeatureFilterIds = [];
  const activateFeatureFilterIds = (ids) => {
    ids.forEach((id) => {
      if (!activeFeatureFilterIds.includes(id)) {
        activeFeatureFilterIds.push(id);
      }
    });
  };
  if (billSplitEnabled) {
    activateFeatureFilterIds(billSplitPathFeatureFilterIds);
    activateFeatureFilterIds(billSplitPathLogicValueFeatureFilterIds);
  }
  if (mainPathEffective) {
    activateFeatureFilterIds(mainPathFeatureFilterIds);
    activateFeatureFilterIds(mainPathLogicValueFeatureFilterIds);
  }
  const mainPathFeatureFilterIdSet = new Set(mainPathFeatureFilterIds);
  const billSplitPathFeatureFilterIdSet = new Set(billSplitPathFeatureFilterIds);
  const activeFeatureFilters = activeFeatureFilterIds.map((id) => {
    const rawRule = featureFilters && Object.prototype.hasOwnProperty.call(featureFilters, id) ? featureFilters[id] : null;
    if (!rawRule) {
      throw new FileValidationError('FILE_READ', '特征值：映射选择的特征值不存在，请在映射关系管理中重新选择');
    }
    const name = normalizeCell(rawRule.name);
    const rule = normalizeFeatureFilterRule(rawRule, { name });
    const sourceIndex = sourceIndexByField.get(rule.sourceField);
    if (sourceIndex === undefined) {
      throw new FileValidationError('FILE_READ', `映射字段不存在：${rule.sourceField}`);
    }
    return { id, name, rule, sourceIndex };
  });
  const activeFeatureFilterById = new Map(activeFeatureFilters.map((item) => [item.id, item]));
  // v3.2.21 B112：读取层按原文还原后仍是超出安全整数范围的数字（文件里只有近似值）时，按源字段记下当前行读到的位数，
  //   该行导出为明细时提示（long-number-unverified）。只在主循环处理一行期间记录（currentRowUnverifiedCells 非空），
  //   只记最终写进明细的取值（拆分行不记主映射的试算，特征值在被映射取用时记）。
  //   不记读到的值：这类列多是卡号、账号，提示会写进报错文件与活动日志
  let currentRowUnverifiedCells = null;
  const inputFileName = path.basename(String(inputFilePath || ''));
  const creditExportIndex = orderedTargetFields.findIndex((field) => normalizeCell(field) === 'Credit Amount');
  const debitExportIndex = orderedTargetFields.findIndex((field) => normalizeCell(field) === 'Debit Amount');
  const isExportedDetailRow = (rowArray) => isDetailExportAmountRow(
    creditExportIndex < 0 ? '' : rowArray[creditExportIndex],
    debitExportIndex < 0 ? '' : rowArray[debitExportIndex],
    { hasCredit: creditExportIndex >= 0, hasDebit: debitExportIndex >= 0 }
  );
  const noteSourceCell = (sourceField, value) => {
    if (currentRowUnverifiedCells && isUnverifiedLongNumber(value) && !currentRowUnverifiedCells.has(sourceField)) {
      currentRowUnverifiedCells.set(sourceField, BigInt(value).toString().replace('-', '').length);
    }
    return value;
  };
  // 一行源数据的特征值 { id → 值 }；主循环逐行更新 currentRowFeatureValues。
  const extractRowFeatureValues = (row) => new Map(activeFeatureFilters.map((item) => (
    [item.id, extractFeatureValue(row[item.sourceIndex], item.rule)]
  )));
  let currentRowFeatureValues = new Map();

  if (amountSplitEnabled) {
    amountSplitRules.forEach((rule) => {
      const conditionField = normalizeCell(rule.conditionField);
      const mappedField = normalizeCell(rule.mappedField);

      if (conditionField && !sourceIndexByField.has(conditionField)) {
        throw new FileValidationError('FILE_READ', `映射字段不存在：${conditionField}`);
      }

      if (mappedField && !sourceIndexByField.has(mappedField)) {
        throw new FileValidationError('FILE_READ', `映射字段不存在：${mappedField}`);
      }
    });
  }

  // v3.2.19：逻辑取值的候补字段须都在源文件表头中（主映射；拆分不复用模块映射时含拆分映射）
  collectLogicValueFields(mappingByField)
    .concat(billSplitEnabled && !billSplitReuseModuleMapping ? collectLogicValueFields(billSplitMappingByField) : [])
    .forEach((field) => {
      if (!sourceIndexByField.has(field)) {
        throw new FileValidationError('FILE_READ', `映射字段不存在：${field}`);
      }
    });
  // v3.2.21：特征值候补以 NUL 开头，正常表头不会与之相同；构造的表头（如 XLSX 以 `_x0000_` 转义写出的 NUL）
  //   与之相同时无法区分源列与特征值，拒绝生成而不是任选其一（不能静默改从另一列取值）。
  [mappingByField, billSplitEnabled && !billSplitReuseModuleMapping ? billSplitMappingByField : {}].forEach((lookup) => {
    Object.values(lookup || {}).forEach((value) => {
      [].concat(value).forEach((item) => {
        (parseLogicValueToken(item) || []).forEach((field) => {
          const featureFilterRef = parseLogicValueFeatureFilterRef(field);
          if (featureFilterRef !== null && sourceIndexByField.has(field)) {
            throw new FileValidationError(
              'FILE_READ',
              '源文件有列名与逻辑取值的特征值候补内部写法相同，无法区分源列与特征值，请修改该列名后重试'
            );
          }
        });
      });
    });
  });

  if (billSplitEnabled) {
    function ensureBillSplitFieldExists(fieldName) {
      const normalized = normalizeCell(fieldName);
      if (!normalized) {
        return;
      }
      if (normalized.startsWith(FIXED_FIELD_VALUE_PREFIX)) {
        return;
      }
      if (!sourceIndexByField.has(normalized)) {
        throw new FileValidationError('FILE_READ', `映射字段不存在：${normalized}`);
      }
    }

    billSplitRows.forEach((row) => {
      ensureBillSplitFieldExists(row.currencySourceField);
      // v3.2.19：费用账单行不读 Credit；有公式时也不读 Debit（映射保留供取消后恢复，不要求列仍存在）
      if (!row.isFeeBill) {
        ensureBillSplitFieldExists(row.creditSourceField);
      }
      if (!(row.isFeeBill && billSplitFeeFormula)) {
        ensureBillSplitFieldExists(row.debitSourceField);
      }
      ensureBillSplitFieldExists(row.amountSourceField);
    });

    billSplitAmountRules.forEach((rule) => {
      ensureBillSplitFieldExists(rule.conditionField);
      ensureBillSplitFieldExists(rule.mappedField);
    });

    if (billSplitSignedField) {
      ensureBillSplitFieldExists(billSplitSignedField);
    }

    (billSplitFeeFormula || []).forEach((item) => {
      ensureBillSplitFieldExists(item.field);
    });

    // 模板文件字段按字面列名查找（列名即使以 __FIXED__: 开头也是真实表头，不当作固定值）
    billSplitFeeFieldMappings.forEach((item) => {
      if (item.valueType === 'field' && !sourceIndexByField.has(item.value)) {
        throw new FileValidationError('FILE_READ', `映射字段不存在：${item.value}`);
      }
    });
  }

  const mappedRows = [orderedTargetFields.slice()];

  function normalizeMappingTokens(mappingValue) {
    if (Array.isArray(mappingValue)) {
      return mappingValue.map((value) => normalizeCell(value)).filter((value) => value !== '');
    }

    const normalizedValue = normalizeCell(mappingValue);
    return normalizedValue ? [normalizedValue] : [];
  }

  // featureValues：该行的特征值；默认取主循环当前行（currentRowFeatureValues），其他行须显式传入。
  function resolveMappedPartsByTokens(mappingTokens, row, featureValues = currentRowFeatureValues) {
    return mappingTokens.map((token) => {
      if (token.startsWith(FIXED_FIELD_VALUE_PREFIX)) {
        return token.slice(FIXED_FIELD_VALUE_PREFIX.length);
      }

      const featureFilterId = parseFeatureFilterToken(token);
      if (featureFilterId !== null) {
        const featureValue = featureValues.get(featureFilterId) ?? '';
        // 未筛出时字段留空（另有未筛出特征值提示），不记源单元格
        const featureFilter = activeFeatureFilterById.get(featureFilterId);
        if (featureFilter && featureValue !== '') noteSourceCell(featureFilter.rule.sourceField, row[featureFilter.sourceIndex]);
        return featureValue;
      }

      // v3.2.19：逻辑取值——按顺序取第一个去首尾空白后非空的候补字段原值（token 以 NUL 开头，不会与真实列名相同）
      // v3.2.21：候补是特征值时取该行筛出的特征值，未筛出为 ''（取下一个候补）
      const logicValueFields = parseLogicValueToken(token);
      if (logicValueFields !== null) {
        return resolveLogicValue(logicValueFields, (field) => {
          const featureFilterRef = parseLogicValueFeatureFilterRef(field);
          if (featureFilterRef !== null) {
            const featureValue = featureValues.get(featureFilterRef) ?? '';
            // 取到值即被采用（resolveLogicValue 取第一个非空候补）：与直接映射特征值一样记其源单元格
            const featureFilter = activeFeatureFilterById.get(featureFilterRef);
            if (featureFilter && normalizeCell(featureValue) !== '') {
              noteSourceCell(featureFilter.rule.sourceField, row[featureFilter.sourceIndex]);
            }
            return featureValue;
          }
          const index = sourceIndexByField.get(field);
          return index === undefined ? '' : noteSourceCell(field, row[index]);
        });
      }

      const sourceIndex = sourceIndexByField.get(token);
      return sourceIndex === undefined ? '' : noteSourceCell(token, row[sourceIndex]);
    });
  }

  function resolveRawValueByMapping(mappingValue, row) {
    const mappingTokens = normalizeMappingTokens(mappingValue);

    if (!mappingTokens.length) {
      return '';
    }

    return resolveMappedPartsByTokens(mappingTokens, row)
      .filter((value) => normalizeCell(value) !== '')
      .join('');
  }

  function resolveDateRawValueByMapping(mappingValue, row, featureValues = currentRowFeatureValues) {
    const mappingTokens = normalizeMappingTokens(mappingValue);

    if (!mappingTokens.length) {
      return '';
    }

    return resolveMappedPartsByTokens(mappingTokens, row, featureValues)
      .map((value) => normalizeCell(value))
      .filter((value) => value !== '')
      .join(' ');
  }

  // BillDate 映射中特征值筛选源单元格的合计标签（合计行识别用），没有时为 ''。
  // - 直接选「字段筛选特征值」：沿用 v3.2.18 口径，只看第一个启用的特征值。
  // - v3.2.21 逻辑取值：按候补顺序查看，特征值候补的源单元格是合计标签即返回；遇到取到值的候补即停止
  //   （其后的候补没有被取用，不据此把真实交易判为合计行）。
  function findBillDateFeatureSummaryLabel(mappingValue, row, featureValues = currentRowFeatureValues) {
    const tokens = normalizeMappingTokens(mappingValue);
    const sourceLabel = (item) => {
      const value = normalizeCell(row[item.sourceIndex]);
      return isStatementSummaryDateLabel(value) ? value : '';
    };
    const directFeatureFilter = tokens
      .map((token) => activeFeatureFilterById.get(parseFeatureFilterToken(token)))
      .find(Boolean);
    if (directFeatureFilter && sourceLabel(directFeatureFilter)) {
      return sourceLabel(directFeatureFilter);
    }
    for (const token of tokens) {
      for (const field of parseLogicValueToken(token) || []) {
        const featureFilterRef = parseLogicValueFeatureFilterRef(field);
        if (featureFilterRef !== null) {
          const item = activeFeatureFilterById.get(featureFilterRef);
          if (item && sourceLabel(item)) {
            return sourceLabel(item);
          }
          if (normalizeCell(featureValues.get(featureFilterRef) ?? '') !== '') break;
          continue;
        }
        const index = sourceIndexByField.get(field);
        if (index !== undefined && normalizeCell(row[index]) !== '') break;
      }
    }
    return '';
  }

  function readSourceCell(row, fieldName) {
    const normalized = normalizeCell(fieldName);
    if (!normalized) {
      return '';
    }
    if (normalized.startsWith(FIXED_FIELD_VALUE_PREFIX)) {
      return normalized.slice(FIXED_FIELD_VALUE_PREFIX.length);
    }
    const sourceIndex = sourceIndexByField.get(normalized);
    return sourceIndex === undefined ? '' : noteSourceCell(normalized, row[sourceIndex]);
  }

  // fallbackField：没有 mappedField 的规则命中时取的字段（第一条有 mappedField 的规则的字段）；命中后才读取，
  //   未命中的规则字段不记长数字提示（v3.2.21 B112）。debitOnly：费用账单行只有支出（收入随后清空），不读收入规则
  function evaluateBillSplitAmountRulesForRow(row, fallbackField, { debitOnly = false } = {}) {
    let credit = '';
    let debit = '';
    let matchedCredit = false;
    let matchedDebit = false;
    billSplitAmountRules.forEach((rule) => {
      const conditionField = normalizeCell(rule.conditionField);
      const targetField = normalizeCell(rule.targetField);
      const conditionValue = String(rule.conditionValue ?? '');
      if (!conditionField || !targetField || (debitOnly && targetField === 'Credit Amount')) {
        return;
      }
      const conditionIndex = sourceIndexByField.get(conditionField);
      if (conditionIndex === undefined) {
        return;
      }
      const sourceCell = row[conditionIndex];
      if (!matchAmountSplitConditionValue(sourceCell, conditionValue)) {
        return;
      }
      // 每条规则用自己的 mappedField 读取金额；无 mappedField 时回退到 fallbackField
      // 同一方向只取第一条命中规则的金额，取用时才读（只记实际取用的列）
      const readRuleAmount = () => readSourceCell(row, rule.mappedField || fallbackField);
      if (targetField === 'Credit Amount' && !matchedCredit) {
        credit = sanitizeAmountValue(readRuleAmount());
        matchedCredit = true;
      } else if (targetField === 'Debit Amount' && !matchedDebit) {
        debit = sanitizeAmountValue(readRuleAmount());
        matchedDebit = true;
      }
    });
    return { credit, debit, matchedCredit, matchedDebit };
  }

  // 「根据发生额做映射」的户名 / 账号：映射值为对应源字段时只在收入或支出单边取值（Drawee 取收入、Payee 取支出）。
  //   返回 true / false 表示该方向是否取值；不按方向取值的字段返回 null
  function takesDirectionalValue(targetField, mappingValue, hasCredit, hasDebit) {
    const creditOnly = hasCredit && !hasDebit;
    const debitOnly = hasDebit && !hasCredit;
    if (nameSourceField && mappingValue === nameSourceField) {
      if (targetField === 'Drawee Name') return creditOnly;
      if (targetField === 'Payee Name') return debitOnly;
    }
    if (accountSourceField && mappingValue === accountSourceField) {
      if (targetField === 'Drawee CardNo') return creditOnly;
      if (targetField === 'Payee Cardno' || targetField === 'Payee CardNo') return debitOnly;
    }
    return null;
  }

  // 拆分子行按自己的收支方向重填的户名 / 账号列下标（与 expandBillSplitForRow 的 Fix D 条件一致，两处须同步）
  function billSplitDirectionalTargetIndexes(effectiveMapping) {
    const indexes = new Set();
    const add = (index, mappingValue, sourceField) => {
      if (index >= 0 && sourceField && mappingValue === sourceField) indexes.add(index);
    };
    add(orderedTargetFields.indexOf('Drawee Name'), effectiveMapping['Drawee Name'], nameSourceField);
    add(orderedTargetFields.indexOf('Payee Name'), effectiveMapping['Payee Name'], nameSourceField);
    add(orderedTargetFields.indexOf('Drawee CardNo'), effectiveMapping['Drawee CardNo'], accountSourceField);
    const payeeCardNoIndex = orderedTargetFields.indexOf('Payee CardNo') >= 0
      ? orderedTargetFields.indexOf('Payee CardNo')
      : orderedTargetFields.indexOf('Payee Cardno');
    add(payeeCardNoIndex, effectiveMapping['Payee CardNo'] || effectiveMapping['Payee Cardno'], accountSourceField);
    return indexes;
  }

  function expandBillSplitForRow(originalRow, baseMappedRow, sourceRowNumber) {
    // Compute the N expanded rows for one source row.
    // baseMappedRow already contains all non-amount fields from main mappings (reuseModule = true default).
    // We override Currency / Credit Amount / Debit Amount per split row.
    const currencyTargetIndex = orderedTargetFields.indexOf('Currency');
    const creditTargetIndex = orderedTargetFields.indexOf('Credit Amount');
    const debitTargetIndex = orderedTargetFields.indexOf('Debit Amount');

    // v1.4.9 PR #16 review P2 Fix D: 预先定位 Name / CardNo 四个 target field 的 index，
    // 在每个拆分行输出前按该行自己的 credit/debit 方向单独分配 Name / CardNo。
    // effectiveMappingByField 由外层 closure (billSplitEffectiveMappingByField) 提供，
    // reuseModuleMapping = true 时指向主模板 mappingByField，false 时指向 billSplitMappingByField。
    const draweeNameIndex = orderedTargetFields.indexOf('Drawee Name');
    const payeeNameIndex = orderedTargetFields.indexOf('Payee Name');
    const draweeCardNoIndex = orderedTargetFields.indexOf('Drawee CardNo');
    const payeeCardNoIndex = orderedTargetFields.indexOf('Payee CardNo') >= 0
      ? orderedTargetFields.indexOf('Payee CardNo')
      : orderedTargetFields.indexOf('Payee Cardno');
    const effectiveMapping = billSplitEffectiveMappingByField || mappingByField;
    const draweeNameMappingValue = effectiveMapping['Drawee Name'];
    const payeeNameMappingValue = effectiveMapping['Payee Name'];
    const draweeCardNoMappingValue = effectiveMapping['Drawee CardNo'];
    const payeeCardNoMappingValue = effectiveMapping['Payee CardNo'] || effectiveMapping['Payee Cardno'];

    const hasSignedAmount = Boolean(billSplitSignedField);
    const hasAmountRules = billSplitAmountRules.length > 0;
    const useAmountSourceField = hasSignedAmount || hasAmountRules;
    // v3.2.19：根据字段值过滤账单时同一份账单里拆分行与主映射行并存，拆分行的币种也按币种映射表规范化
    //   （与主映射同一口径），避免同一币种输出成「人民币」与 CNY 两种写法、余额按币种分组时拆成两组。
    //   未开启过滤的拆分模板保持取原值。同一源行内同一字段同一原值只规范化、只记提示一次。
    const resolvedCurrencyByKey = new Map();
    const resolveSplitRowCurrency = (rawCurrency, sourceField) => {
      if (!compiledBillSplitRowFilter || !rawCurrency) {
        return rawCurrency;
      }
      const key = `${sourceField}\u0000${rawCurrency}`;
      if (!resolvedCurrencyByKey.has(key)) {
        const currencyResult = resolveCurrencyValue(rawCurrency, currencyMappings, {
          allowFuzzy: !merchantIdUsesCurrencyMapping
        });
        if (currencyResult.issue) {
          issues.push({
            ...currencyResult.issue,
            rawValue: maskRestoredLongIntegers(currencyResult.issue.rawValue),
            rowNumber: sourceRowNumber,
            sourceField
          });
        }
        resolvedCurrencyByKey.set(key, normalizeCell(currencyResult.value));
      }
      return resolvedCurrencyByKey.get(key);
    };

    return billSplitRows
      .map((splitRow) => trackSplitRowCells(() => {
        const expandedRow = baseMappedRow.slice();
        // v3.2.21 B112：子行按目标列分别记读到的长数字（cellsByTarget），同时记进子行（trackSplitRowCells）；
        //   改选 / 分配大账号后据此剔除只写进被覆盖列（币种、大账号）的来源（release 审查）
        const cellsByTarget = currentRowUnverifiedCells ? new Map() : null;
        const readForTarget = (targetIndex, compute) => {
          if (!cellsByTarget || targetIndex < 0) return compute();
          const value = captureTargetCells(cellsByTarget, targetIndex, compute);
          mergeCellMap(cellsByTarget.get(targetIndex), currentRowUnverifiedCells);
          return value;
        };
        const rawCurrencyValue = normalizeCell(readForTarget(currencyTargetIndex, () => readSourceCell(originalRow, splitRow.currencySourceField)));
        let creditValue = '';
        let debitValue = '';

        // 指定账单实现功能：判断是否有指定、当前行是否被指定
        const hasSignedTargets = billSplitSignedTargetSeqNos.length > 0;
        const hasByFieldTargets = billSplitByFieldTargetSeqNos.length > 0;
        const isTargetedBySigned = hasSignedTargets && billSplitSignedTargetSeqNos.includes(splitRow.seqNo);
        const isTargetedByField = hasByFieldTargets && billSplitByFieldTargetSeqNos.includes(splitRow.seqNo);

        // v3.2.19：费用账单行只有支出；启用特殊取值时 Debit 取公式结果，优先于副区域规则与行级映射。
        const isFeeBillRow = Boolean(splitRow.isFeeBill);

        // v3.2.21 B112：发生额读到的长数字另记（amountCells），合并行汇总组内各子行的发生额来源
        const amountCells = new Map();
        captureCells(amountCells, () => {
          if (isFeeBillRow && billSplitFeeFormula) {
            const fee = evaluateFeeAmountFormula(billSplitFeeFormula, (field) => readSourceCell(originalRow, field));
            if (fee.divisionByZero) {
              currentRowFeeFormulaDivisionByZero = true;
            }
            debitValue = fee.amount;
          } else if (isTargetedBySigned && hasSignedAmount) {
            // 该行被"按正负号拆分的发生额"指定
            const split = splitSignedAmountValue(readSourceCell(originalRow, billSplitSignedField));
            creditValue = split.creditAmount;
            debitValue = split.debitAmount;
          } else if (isTargetedByField && hasAmountRules) {
            // 该行被"按字段区分发生额"指定，从规则的 mappedField 读取金额
            const firstRule = billSplitAmountRules.find((r) => r.mappedField);
            const result = evaluateBillSplitAmountRulesForRow(originalRow, firstRule ? firstRule.mappedField : '', { debitOnly: isFeeBillRow });
            creditValue = result.credit;
            debitValue = result.debit;
          } else if (useAmountSourceField && !hasSignedTargets && !hasByFieldTargets) {
            // 副区域有值但没有勾选"指定账单"→ 所有行使用副区域逻辑（旧行为）
            if (hasSignedAmount) {
              const split = splitSignedAmountValue(readSourceCell(originalRow, billSplitSignedField));
              creditValue = split.creditAmount;
              debitValue = split.debitAmount;
            } else {
              const firstRule = billSplitAmountRules.find((r) => r.mappedField);
              const result = evaluateBillSplitAmountRulesForRow(originalRow, firstRule ? firstRule.mappedField : '', { debitOnly: isFeeBillRow });
              creditValue = result.credit;
              debitValue = result.debit;
            }
          } else {
            // 未被指定的行（有指定但该行不在列表），使用行级 Credit/Debit 直接映射
            // 费用账单行只有支出（下方清空收入），不读收入字段
            creditValue = isFeeBillRow ? '' : sanitizeAmountValue(readSourceCell(originalRow, splitRow.creditSourceField));
            debitValue = sanitizeAmountValue(readSourceCell(originalRow, splitRow.debitSourceField));
          }
        });
        if (currentRowUnverifiedCells) mergeCellMap(amountCells, currentRowUnverifiedCells);
        if (cellsByTarget && amountCells.size) {
          [creditTargetIndex, debitTargetIndex].filter((index) => index >= 0).forEach((index) => {
            cellsByTarget.set(index, mergeCellMap(amountCells, mergeCellMap(cellsByTarget.get(index), new Map())));
          });
        }
        if (isFeeBillRow) {
          creditValue = '';
        }

        // 静默过滤：credit 和 debit 都为 0（或空）的拆分行直接丢弃，不输出也不报错
        const creditNum = parseNumericValue(creditValue);
        const debitNum = parseNumericValue(debitValue);
        if ((creditNum === 0 || creditNum === null || creditNum === undefined || Number.isNaN(creditNum))
            && (debitNum === 0 || debitNum === null || debitNum === undefined || Number.isNaN(debitNum))) {
          return null;
        }

        // 只为实际输出的拆分行规范化币种并记提示（收付均为 0 的拆分行已丢弃）
        const currencyValue = resolveSplitRowCurrency(rawCurrencyValue, normalizeCell(splitRow.currencySourceField));
        if (currencyTargetIndex >= 0 && currencyValue) {
          expandedRow[currencyTargetIndex] = currencyValue;
        }
        if (creditTargetIndex >= 0) {
          expandedRow[creditTargetIndex] = creditValue;
        }
        if (debitTargetIndex >= 0) {
          expandedRow[debitTargetIndex] = debitValue;
        }

        // v1.4.9 PR #16 review P2 Fix D: 按当前拆分行的 credit/debit 方向单独分配
        // Drawee Name / Payee Name / Drawee CardNo / Payee CardNo 四个字段。
        // 判定 per-row 方向（基于本拆分行的 creditValue / debitValue，不依赖 source row 级别的
        // hasCreditAmount/hasDebitAmount closure 变量）。
        const hasCreditInRow = hasEffectiveAmount(creditValue);
        const hasDebitInRow = hasEffectiveAmount(debitValue);
        // v3.2.21：费用账单行中由「字段映射特殊处理」覆盖的列（见下方）不按收支方向取值：读到的值不写出，其中的长数字也不提示
        const overriddenByFeeField = (targetIndex) => isFeeBillRow && billSplitFeeFieldTargetIndexes.has(targetIndex);

        // Drawee Name: 只有 credit-only 拆分行填值，其它情况置空（与 v1.4.8 的 source-row 级语义对齐，
        // 只是判定维度从 source row 变成拆分行）
        if (draweeNameIndex >= 0 && !overriddenByFeeField(draweeNameIndex) && nameSourceField && draweeNameMappingValue === nameSourceField) {
          const rawName = hasCreditInRow && !hasDebitInRow ? readForTarget(draweeNameIndex, () => readSourceCell(originalRow, nameSourceField)) : '';
          expandedRow[draweeNameIndex] = rawName != null ? rawName : '';
        }
        // Payee Name: 只有 debit-only 拆分行填值
        if (payeeNameIndex >= 0 && !overriddenByFeeField(payeeNameIndex) && nameSourceField && payeeNameMappingValue === nameSourceField) {
          const rawName = hasDebitInRow && !hasCreditInRow ? readForTarget(payeeNameIndex, () => readSourceCell(originalRow, nameSourceField)) : '';
          expandedRow[payeeNameIndex] = rawName != null ? rawName : '';
        }
        // Drawee CardNo: 只有 credit-only 拆分行填值
        if (draweeCardNoIndex >= 0 && !overriddenByFeeField(draweeCardNoIndex) && accountSourceField && draweeCardNoMappingValue === accountSourceField) {
          const rawAcct = hasCreditInRow && !hasDebitInRow ? readForTarget(draweeCardNoIndex, () => readSourceCell(originalRow, accountSourceField)) : '';
          expandedRow[draweeCardNoIndex] = rawAcct != null ? rawAcct : '';
        }
        // Payee CardNo: 只有 debit-only 拆分行填值
        if (payeeCardNoIndex >= 0 && !overriddenByFeeField(payeeCardNoIndex) && accountSourceField && payeeCardNoMappingValue === accountSourceField) {
          const rawAcct = hasDebitInRow && !hasCreditInRow ? readForTarget(payeeCardNoIndex, () => readSourceCell(originalRow, accountSourceField)) : '';
          expandedRow[payeeCardNoIndex] = rawAcct != null ? rawAcct : '';
        }

        // v3.2.21：费用账单行按「字段映射特殊处理」覆盖（在户名 / 卡号按收支方向分配之后，设置了的字段以设置为准）。
        //   BillDate 不允许覆盖（已在 billSplitFeeFieldMappings 中排除）。覆盖原值（feeFieldRawValues，与 billSplitFeeFieldMappings
        //   同序）随行保留：合计行过滤、合并选定代表行后，只对实际写出的行先校验原值、再把 ValueDate 按主映射同口径规范化
        //   （见下方写出循环；不为不输出的行解析日期，超长或含非法字符的源值在解析前拒绝）。
        const feeFieldRawValues = [];
        if (isFeeBillRow) {
          billSplitFeeFieldMappings.forEach((item) => {
            // 取自源列的覆盖值同样记无法核对原值的长数字（随该子行汇总，只在实际导出时提示）
            const rawValue = readForTarget(item.targetIndex, () => resolveFeeFieldMappingValue(item, (field) => {
              const sourceIndex = sourceIndexByField.get(field);
              return sourceIndex === undefined ? '' : noteSourceCell(field, originalRow[sourceIndex]);
            }));
            feeFieldRawValues.push(rawValue);
            expandedRow[item.targetIndex] = rawValue;
          });
        }

        return {
          seqNo: splitRow.seqNo,
          mergedGroupSeq: splitRow.mergedGroupSeq,
          // v3.2.21：费用账单行（带字段映射特殊处理的覆盖）；合并结果取代表行的值
          isFeeBill: isFeeBillRow,
          feeFieldRawValues,
          currency: currencyValue,
          creditAmount: creditValue,
          debitAmount: debitValue,
          rowArray: expandedRow,
          sourceRowNumber,
          amountCells,
          cellsByTarget,
          // v3.2.21 B112：币种取自拆分行（覆盖了底稿的币种）
          currencyFromSplitRow: currencyTargetIndex >= 0 && Boolean(currencyValue)
        };
      }))
      .filter((r) => r !== null);
  }

  // v3.2.21 B112：把记下的长数字（源字段 → 位数）并入 into，先记的优先
  function mergeCellMap(from, into) {
    if (!(from instanceof Map)) return into;
    from.forEach((digitCount, sourceField) => {
      if (!into.has(sourceField)) into.set(sourceField, digitCount);
    });
    return into;
  }

  // v3.2.21 B112：compute 期间读到的长数字记进 cells（不记进当前行）；不在记录期间时直接计算
  function captureCells(cells, compute) {
    if (!currentRowUnverifiedCells) return compute();
    const rowCells = currentRowUnverifiedCells;
    currentRowUnverifiedCells = cells;
    try {
      return compute();
    } finally {
      currentRowUnverifiedCells = rowCells;
    }
  }

  // v3.2.21 B112：按目标列分别记长数字（见 computeMappedRow 的 cellsByTarget）。该列最终写出为空时（如长数字映射到
  //   日期列，规范化后为空）没有近似值写进明细，不记（release 审查）
  function captureTargetCells(cellsByTarget, targetIndex, computeTarget) {
    if (!cellsByTarget || !currentRowUnverifiedCells) return computeTarget();
    const targetCells = new Map();
    const value = captureCells(targetCells, computeTarget);
    if (targetCells.size && normalizeCell(value) !== '') cellsByTarget.set(targetIndex, targetCells);
    return value;
  }

  // v3.2.21 B112：每个拆分子行单独记取值中的长数字（挂在子行的 unverifiedCells 上），合并、过滤后只汇总实际导出的子行
  function trackSplitRowCells(expandOne) {
    const rowCells = currentRowUnverifiedCells;
    const entryCells = rowCells ? new Map() : null;
    currentRowUnverifiedCells = entryCells;
    try {
      const entry = expandOne();
      if (entry && entryCells) entry.unverifiedCells = entryCells;
      return entry;
    } finally {
      currentRowUnverifiedCells = rowCells;
    }
  }

  function applyBillSplitMergeForRow(expandedRows) {
    // Group merged rows by mergedGroupSeq, collapse each group into 1 net-value row.
    // PRD §Q-A3 invariant: mergedGroupSeq = group min seq_no.
    const grouped = new Map();
    const standalone = [];
    expandedRows.forEach((row) => {
      if (row.mergedGroupSeq === null || row.mergedGroupSeq === undefined) {
        standalone.push(row);
        return;
      }
      const key = Number(row.mergedGroupSeq);
      if (!grouped.has(key)) {
        grouped.set(key, []);
      }
      grouped.get(key).push(row);
    });

    // 双保险：独立行里再过滤一次 credit/debit 都为 0 的行（expandBillSplitForRow 已处理，
    // 这里兜底以防其它上游路径没过滤）
    const filteredStandalone = standalone.filter((row) => {
      const creditNum = parseNumericValue(row.creditAmount);
      const debitNum = parseNumericValue(row.debitAmount);
      const creditIsZero = creditNum === 0 || creditNum === null || creditNum === undefined || Number.isNaN(creditNum);
      const debitIsZero = debitNum === 0 || debitNum === null || debitNum === undefined || Number.isNaN(debitNum);
      return !(creditIsZero && debitIsZero);
    });

    const result = [...filteredStandalone];

    grouped.forEach((groupRows) => {
      if (groupRows.length < 2) {
        // Single-member "group" — treat as standalone (双保险：过滤 0 值)
        groupRows.forEach((row) => {
          const creditNum = parseNumericValue(row.creditAmount);
          const debitNum = parseNumericValue(row.debitAmount);
          const creditIsZero = creditNum === 0 || creditNum === null || creditNum === undefined || Number.isNaN(creditNum);
          const debitIsZero = debitNum === 0 || debitNum === null || debitNum === undefined || Number.isNaN(debitNum);
          if (!(creditIsZero && debitIsZero)) {
            result.push(row);
          }
        });
        return;
      }

      // AC1-60 / ACI-6: Currency consistency check (保留)
      const distinctCurrencies = new Set(
        groupRows.map((r) => normalizeCell(r.currency)).filter((c) => c !== '')
      );
      if (distinctCurrencies.size > 1) {
        throw new FileValidationError(
          'BILL_MERGE_CURRENCY_MISMATCH',
          '合并账单的 Currency 不一致，无法合并'
        );
      }

      // Sum
      const sumCredit = groupRows.reduce((acc, r) => acc + (parseNumericValue(r.creditAmount) || 0), 0);
      const sumDebit = groupRows.reduce((acc, r) => acc + (parseNumericValue(r.debitAmount) || 0), 0);
      // v1.5.3 R4（2026-04-22 更正）：浮点求和尾部噪声（如 2377.49 + 178.31 = 2555.7999999999997、
      // 65572.01 + 4917.90 = 70489.90999999999），toFixed(12) 在第二例无法收敛。
      // 资金本就 2 位小数，统一 roundAmount（toFixed(2)）强制 2 位：
      // 使 net===0 判定与 netString 输出均精确。
      const net = roundAmount(sumCredit - sumDebit);

      // 净值为 0 时静默跳过整个合并组，不输出也不报错
      if (net === 0) {
        return;
      }

      // Representative row = the one whose seqNo equals mergedGroupSeq (i.e. min seqNo)
      const representative = groupRows.find((r) => Number(r.seqNo) === Number(r.mergedGroupSeq))
        || groupRows[0];
      const mergedRowArray = representative.rowArray.slice();
      const creditTargetIndex = orderedTargetFields.indexOf('Credit Amount');
      const debitTargetIndex = orderedTargetFields.indexOf('Debit Amount');
      const netString = sanitizeAmountValue(String(Math.abs(net)));
      if (creditTargetIndex >= 0) {
        mergedRowArray[creditTargetIndex] = net > 0 ? netString : '';
      }
      if (debitTargetIndex >= 0) {
        mergedRowArray[debitTargetIndex] = net < 0 ? netString : '';
      }

      result.push({
        seqNo: representative.seqNo,
        mergedGroupSeq: representative.mergedGroupSeq,
        isFeeBill: Boolean(representative.isFeeBill),
        feeFieldRawValues: representative.feeFieldRawValues,
        currency: representative.currency,
        creditAmount: net > 0 ? netString : '',
        debitAmount: net < 0 ? netString : '',
        rowArray: mergedRowArray,
        sourceRowNumber: representative.sourceRowNumber,
        // v3.2.21 B112：合并行的发生额是组内各子行的净额，汇总各子行发生额读到的来源；其余字段沿用代表行
        unverifiedCells: groupRows.reduce(
          (cells, member) => mergeCellMap(member.amountCells, cells),
          mergeCellMap(representative.unverifiedCells, new Map())
        ),
        // 按目标列：代表行各列的来源，发生额两列另加组内各子行发生额的来源
        cellsByTarget: representative.cellsByTarget instanceof Map
          ? [creditTargetIndex, debitTargetIndex].filter((index) => index >= 0).reduce((byTarget, index) => {
            byTarget.set(index, groupRows.reduce(
              (cells, member) => mergeCellMap(member.amountCells, cells),
              mergeCellMap(byTarget.get(index), new Map())
            ));
            return byTarget;
          }, new Map(representative.cellsByTarget))
          : null,
        currencyFromSplitRow: representative.currencyFromSplitRow
      });
    });

    return result.sort((a, b) => (a.seqNo || 0) - (b.seqNo || 0));
  }

  rows.slice(1).forEach((row, rowIndex) => {
    currentRowFeeFormulaDivisionByZero = false;
    // v3.2.21 B112：映射只从本行取值，行内没有无法核对原文的长数字时不跟踪来源（不为各目标列建记录，release 审查）
    const rowHasUnverifiedLongNumber = row.some(isUnverifiedLongNumber);
    currentRowUnverifiedCells = rowHasUnverifiedLongNumber ? new Map() : null;
    // v3.2.19：重复账单过滤的源行指纹（经「过滤账单」保留的行才会进入本循环）
    const fullSourceRow = duplicateRowKeys ? fullSourceRowByNumber.get(rowNumbers[rowIndex + 1]) : null;
    const sourceRowKey = duplicateRowKeys
      ? (fullSourceRow
        ? buildSourceRowKey(fullSourceRow.headers, fullSourceRow.cells, { columnOffset: sourceFullColumnOffset })
        : buildSourceRowKey(sourceHeaders, row))
      : '';
    // 开启查重但该行无法核对原文（含公式、编码有损等）时记下，生成提示据此说明有多少行未参与查重
    const sourceRowKeyMeta = sourceRowKey ? { sourceRowKey } : (duplicateRowKeys ? { sourceRowKeyUnavailable: true } : {});
    const rowUsesBillSplit = billSplitEnabled
      && (!compiledBillSplitRowFilter || matchesBillSplitRowFilter(row, compiledBillSplitRowFilter));
    if (rowUsesBillSplit) {
      billSplitPathRowCount += 1;
    }
    currentRowFeatureValues = extractRowFeatureValues(row);
    // 只读实际生效的发生额取值（按字段区分发生额 > 按正负号拆分 > Credit / Debit 映射；v3.2.21 B112：不记未生效映射的长数字）
    const signedAmountValue = !amountSplitEnabled && signedAmountSourceField
      ? splitSignedAmountValue(resolveRawValueByMapping(signedAmountSourceField, row))
      : null;
    const usesDirectAmountMapping = !amountSplitEnabled && !signedAmountValue;
    const directCreditAmountRaw = usesDirectAmountMapping ? resolveRawValueByMapping(mappingByField['Credit Amount'], row) : '';
    const directDebitAmountRaw = usesDirectAmountMapping ? resolveRawValueByMapping(mappingByField['Debit Amount'], row) : '';

    let creditAmountValue;
    let debitAmountValue;
    let hasCreditAmount;
    let hasDebitAmount;

    if (amountSplitEnabled) {
      let creditRawFromRule = '';
      let debitRawFromRule = '';
      let matchedCreditRule = false;
      let matchedDebitRule = false;

      amountSplitRules.forEach((rule) => {
        const conditionField = normalizeCell(rule.conditionField);
        const mappedField = normalizeCell(rule.mappedField);
        const targetField = normalizeCell(rule.targetField);
        const conditionValue = String(rule.conditionValue ?? '');
        const conditionIndex = sourceIndexByField.get(conditionField);
        const mappedIndex = sourceIndexByField.get(mappedField);

        if (conditionIndex === undefined || mappedIndex === undefined) {
          return;
        }

        const sourceCell = row[conditionIndex];

        if (!matchAmountSplitConditionValue(sourceCell, conditionValue)) {
          return;
        }

        // 同一方向只取第一条命中规则的金额（v3.2.21 B112：只记实际取用的列）
        if (targetField === 'Credit Amount' && !matchedCreditRule) {
          creditRawFromRule = noteSourceCell(mappedField, row[mappedIndex]);
          matchedCreditRule = true;
        } else if (targetField === 'Debit Amount' && !matchedDebitRule) {
          debitRawFromRule = noteSourceCell(mappedField, row[mappedIndex]);
          matchedDebitRule = true;
        }
      });

      creditAmountValue = matchedCreditRule ? sanitizeAmountValue(creditRawFromRule) : '';
      debitAmountValue = matchedDebitRule ? sanitizeAmountValue(debitRawFromRule) : '';
      hasCreditAmount = matchedCreditRule && hasEffectiveAmount(creditRawFromRule);
      hasDebitAmount = matchedDebitRule && hasEffectiveAmount(debitRawFromRule);
    } else {
      creditAmountValue = signedAmountValue
        ? signedAmountValue.creditAmount
        : sanitizeAmountValue(directCreditAmountRaw);
      debitAmountValue = signedAmountValue
        ? signedAmountValue.debitAmount
        : sanitizeAmountValue(directDebitAmountRaw);
      hasCreditAmount = signedAmountValue
        ? signedAmountValue.hasCreditAmount
        : hasEffectiveAmount(directCreditAmountRaw);
      hasDebitAmount = signedAmountValue
        ? signedAmountValue.hasDebitAmount
        : hasEffectiveAmount(directDebitAmountRaw);
    }

    const sourceRowNumber = rowNumbers[rowIndex + 1] || rowIndex + 2;

    // 账单自带的合计行：实际生效的账单日期列是合计标签且带金额（金额是全表总额，原本会被判为无效账单日期而整份拒绝）。
    // 不进明细、不计入拆分统计，记入 issues 供导出报错文件核查。无金额的合计标签行仍按收支为空的行过滤，行为不变。
    // 账单拆分时最终日期取自实际生效的映射（不复用主映射时为拆分映射），金额取自拆分配置，
    // 因此在展开后按拆分结果判定（见下方拆分分支），避免误删真实交易或漏判只在拆分里配金额的合计行。
    const effectiveBillDateMapping = rowUsesBillSplit && !billSplitReuseModuleMapping
      ? billSplitMappingByField.BillDate
      : mappingByField.BillDate;
    const rawEffectiveBillDate = resolveDateRawValueByMapping(effectiveBillDateMapping, row);
    // v3.2.16：BillDate 取「字段筛选特征值」时，合计标签会被筛成空串；改按筛选源单元格原文识别合计行，
    // 否则合计金额会作为普通交易再导出一次。
    // v3.2.18：取 BillDate 所选特征值的筛选源单元格。
    // v3.2.21：BillDate 取「逻辑取值」且候补含特征值时，合计标签同样会被筛成空串、落到下一个候补；
    //   按候补顺序检查实际查看过的特征值候补（到第一个取到值的候补为止）的筛选源单元格。直接选用的口径不变。
    const featureFilterBillDateSource = findBillDateFeatureSummaryLabel(effectiveBillDateMapping, row);
    const summaryDateLabel = isStatementSummaryDateLabel(rawEffectiveBillDate)
      ? normalizeCell(rawEffectiveBillDate)
      : featureFilterBillDateSource;
    const recordSummaryRow = () => {
      issues.push({ type: 'summary-row-skipped', rowNumber: sourceRowNumber, rawValue: summaryDateLabel });
    };
    const countAmountSplitHits = () => {
      if (!amountSplitEnabled) {
        return;
      }
      if (hasCreditAmount) {
        matchedCreditCount += 1;
      }
      if (hasDebitAmount) {
        matchedDebitCount += 1;
      }
    };

    if (!rowUsesBillSplit && summaryDateLabel && (hasCreditAmount || hasDebitAmount)) {
      recordSummaryRow();
      return;
    }

    if (!rowUsesBillSplit) {
      rowMetas.push({ sourceRowNumber, ...sourceRowKeyMeta });
    }

    // P1 Fix A (PR #16 review): 提取单行映射计算为可复用 helper，以便 billSplit 的
    // reuseModuleMapping === false 场景可以用弹框 1 的独立 mapping lookup 重算非金额字段。
    // 行为对 reuseModuleMapping === true（默认）路径保持完全等价——helper 依赖的 closure
    // 变量 (row, rowIndex, hasCreditAmount, hasDebitAmount, creditAmountValue, debitAmountValue,
    // selectedCurrency, selectedMerchantId, nameSourceField, accountSourceField, currencyMappings,
    // accountMappingByBankId, dateParseOrder, rowNumbers, issues) 都已在外层 forEach 作用域内。
    // skipTargetIndexes：拆分底稿中由各子行按自己的收支方向重填的列（billSplitDirectionalTargetIndexes），底稿不读
    // cellsByTarget：拆分底稿按目标列分别记长数字（Map<列下标, Map<源字段, 位数>>），汇总时跳过被子行覆盖的列
    function computeMappedRow(mappingByFieldParam, { skipTargetIndexes = null, cellsByTarget = null } = {}) {
      return orderedTargetFields.map((targetField, targetIndex) => captureTargetCells(cellsByTarget, targetIndex, () => {
        const mappingValue = mappingByFieldParam[targetField];
        // 收入 / 支出已按发生额规则算好（拆分行另取拆分设置），不再读映射的源字段（v3.2.21 B112：不记其中的长数字）
        if (targetField === 'Credit Amount') {
          return creditAmountValue;
        }

        if (targetField === 'Debit Amount') {
          return debitAmountValue;
        }

        // 按收支方向取的户名 / 账号：该方向不取值时留空，不读源字段（输出同下方分支）；拆分底稿中会被子行重填的列不读
        if (skipTargetIndexes && skipTargetIndexes.has(targetIndex)) {
          return '';
        }
        if (takesDirectionalValue(targetField, mappingValue, hasCreditAmount, hasDebitAmount) === false) {
          return '';
        }

        const mappingTokens = normalizeMappingTokens(mappingValue);
        const primaryMappingValue = mappingTokens[0] || '';
        const sourceField = primaryMappingValue;
        // 由所选大账号决定的币种 / 大账号不读源字段（输出同下方分支；v3.2.21 B112：不记其中的长数字）
        if (targetField === 'Currency' && selectedCurrency) {
          return selectedCurrency;
        }
        if (targetField === 'MerchantId' && selectedMerchantId && primaryMappingValue !== MERCHANT_ID_CURRENCY_ONLY_MARKER) {
          return selectedMerchantId;
        }
        const rawValue = resolveRawValueByMapping(mappingValue, row);

        if (targetField === 'Balance') {
          // 余额可为负：保留符号（映射值已拼成字符串，不能依赖数值分支保号）。
          return sanitizeSignedAmountValue(rawValue);
        }

        if (targetField === 'BillDate' || targetField === 'ValueDate') {
          const rawDateValue = resolveDateRawValueByMapping(mappingValue, row);
          const normalizedDateValue = normalizeDateExportValue(rawDateValue, { dateParseOrder }).value;
          if (targetField === 'BillDate' && !normalizedDateValue && rawDateValue) {
            invalidBillDateBySourceRow.set(sourceRowNumber, maskRestoredLongIntegers(rawDateValue));
          }
          return normalizedDateValue;
        }

        if (nameSourceField && mappingValue === nameSourceField) {
          if (targetField === 'Drawee Name') {
            return hasCreditAmount && !hasDebitAmount ? rawValue ?? '' : '';
          }

          if (targetField === 'Payee Name') {
            return hasDebitAmount && !hasCreditAmount ? rawValue ?? '' : '';
          }
        }

        if (accountSourceField && mappingValue === accountSourceField) {
          if (targetField === 'Drawee CardNo') {
            return hasCreditAmount && !hasDebitAmount ? rawValue ?? '' : '';
          }

          if (targetField === 'Payee Cardno' || targetField === 'Payee CardNo') {
            return hasDebitAmount && !hasCreditAmount ? rawValue ?? '' : '';
          }
        }

        if (targetField === 'Currency') {
          if (selectedCurrency) {
            return selectedCurrency;
          }

          if (primaryMappingValue.startsWith(FIXED_FIELD_VALUE_PREFIX)) {
            return primaryMappingValue.slice(FIXED_FIELD_VALUE_PREFIX.length);
          }

          // v3.2.16：按币种取大账号时币种直接决定账号，只认代码与精确名称，模糊命中按未维护阻断
          const currencyResult = resolveCurrencyValue(rawValue, currencyMappings, {
            allowFuzzy: !merchantIdUsesCurrencyMapping
          });

          if (!currencyResult.value || currencyResult.value === '') {
            const merchantIdValue = resolveRawValueByMapping(mappingByFieldParam['MerchantId'], row);
            const merchantIdNormalized = normalizeCell(merchantIdValue);
            if (merchantIdNormalized && Object.prototype.hasOwnProperty.call(accountMappingByBankId, merchantIdNormalized)) {
              const accountMapping = accountMappingByBankId[merchantIdNormalized];
              if (typeof accountMapping === 'object' && accountMapping.noCurrency && accountMapping.currency) {
                return accountMapping.currency;
              }
            }
          }

          if (currencyResult.issue) {
            issues.push({
              ...currencyResult.issue,
              rawValue: maskRestoredLongIntegers(currencyResult.issue.rawValue),
              rowNumber: rowNumbers[rowIndex + 1] || rowIndex + 2,
              sourceField
            });
          }

          return currencyResult.value;
        }

        if (targetField === 'MerchantId') {
          // v3.2.16：按币种取大账号的模板在全部行生成后统一回填（applyCurrencyBigAccountMapping）
          if (primaryMappingValue === MERCHANT_ID_CURRENCY_ONLY_MARKER) {
            return '';
          }

          if (selectedMerchantId) {
            return selectedMerchantId;
          }

          if (primaryMappingValue.startsWith(FIXED_FIELD_VALUE_PREFIX)) {
            const fixedValue = primaryMappingValue.slice(FIXED_FIELD_VALUE_PREFIX.length);
            return fixedValue === '__MULTI_BIG_ACCOUNT__' ? '' : fixedValue;
          }

          const originalValue = normalizeCell(rawValue).replace(/\s+/g, '');

          if (!originalValue) {
            return '';
          }

          if (Object.prototype.hasOwnProperty.call(accountMappingByBankId, originalValue)) {
            const accountMapping = accountMappingByBankId[originalValue];
            return typeof accountMapping === 'object' ? accountMapping.clearingAccountId : String(accountMapping);
          }

          return originalValue;
        }

        if (primaryMappingValue.startsWith(FIXED_FIELD_VALUE_PREFIX)) {
          return primaryMappingValue.slice(FIXED_FIELD_VALUE_PREFIX.length);
        }

        return rawValue ?? '';
      }));
    }

    const issueCountBeforeRow = issues.length;
    // v3.2.16：只为会进入明细的行（有收入或支出）记录未筛出特征值；收支均为空的行另有过滤提示。
    // v3.2.18：每行一条，misses 列出该行未筛出的各特征值。
    const rowFeatureFilterIdSet = rowUsesBillSplit ? billSplitPathFeatureFilterIdSet : mainPathFeatureFilterIdSet;
    // featureIdSet：该行实际用到的特征值；拆分行全部被字段映射特殊处理覆盖时只含未被覆盖的字段所用的特征值（v3.2.21）
    const recordFeatureValueMiss = (hasAmount, featureIdSet = rowFeatureFilterIdSet) => {
      if (!hasAmount) {
        return;
      }
      const misses = activeFeatureFilters
        .filter((item) => featureIdSet.has(item.id) && currentRowFeatureValues.get(item.id) === '')
        .map((item) => ({
          featureName: item.name,
          sourceField: item.rule.sourceField,
          // v3.2.21 B112：按原文还原的长数字多是卡号、账号，提示写进报错文件与活动日志，只写位数
          rawValue: maskRestoredLongIntegers(normalizeCell(row[item.sourceIndex]))
        }));
      if (misses.length) {
        issues.push({ type: 'feature-value-unmatched', rowNumber: sourceRowNumber, misses });
      }
    };
    // v3.2.21 B112：只为会导出为明细的行（与 buildDetailExportRows 同一口径）提示无法核对原值的长数字
    //   targetFieldsBySource：只由映射目标列读取的源字段 → 这些目标列（主映射行与拆分导出的子行），供改选 / 分配大账号后剔除被覆盖的列
    const recordUnverifiedLongNumbers = (exported, targetFieldsBySource = null) => {
      if (!exported || !currentRowUnverifiedCells || !currentRowUnverifiedCells.size) {
        return;
      }
      issues.push({
        type: 'long-number-unverified',
        fileName: inputFileName,
        rowNumber: sourceRowNumber,
        cells: Array.from(currentRowUnverifiedCells, ([sourceField, digitCount]) => {
          const targetFields = targetFieldsBySource && targetFieldsBySource.get(sourceField);
          return targetFields ? { sourceField, digitCount, targetFields: Array.from(targetFields) } : { sourceField, digitCount };
        })
      });
    };
    // 拆分行的发生额取拆分设置：此前按主映射读的发生额（含按字段区分发生额、按正负号拆分）不写进明细，不记
    if (rowUsesBillSplit && rowHasUnverifiedLongNumber) currentRowUnverifiedCells = new Map();
    // 按目标列分别记长数字：拆分底稿汇总时跳过被子行覆盖的列；主映射行记下各源字段写进了哪些目标列
    const preMappedFields = new Set(currentRowUnverifiedCells ? currentRowUnverifiedCells.keys() : []);
    const baseCellsByTarget = new Map();
    const mappedRow = rowUsesBillSplit
      ? computeMappedRow(mainMappingForBillSplitRows, {
        skipTargetIndexes: billSplitDirectionalTargetIndexes(billSplitReuseModuleMapping ? mappingByField : billSplitMappingByField),
        cellsByTarget: billSplitReuseModuleMapping ? baseCellsByTarget : null
      })
      : computeMappedRow(mappingByField, { cellsByTarget: baseCellsByTarget });

    if (rowUsesBillSplit) {
      // P1 Fix A (PR #16 review): 当 reuseModuleMapping === false 时用弹框 1 的独立 lookup
      // 重算非金额字段；否则沿用主模板 mappedRow（原行为）。
      //
      // P2 Fix D (PR #16 review): 移除原"临时清零 hasCreditAmount/hasDebitAmount 再 restore"的
      // hack——该 hack 原本是为了避免 source-row 级别的方向标志污染 reuseModuleMapping=false 路径
      // 的 base row Name/CardNo 值。现在改为在 expandBillSplitForRow 里按每个拆分行自己的
      // credit/debit 方向独立分配 Name/CardNo（详见 expandBillSplitForRow 的 post-process 块），
      // 所以 base row 阶段无需再关心 Name/CardNo 的方向，直接让 computeMappedRow 用原始的
      // closure 变量计算即可。billSplitEffectiveMappingByField 则是透传给 expandBillSplitForRow
      // 的 closure 变量，让它知道应该用哪套 mapping 来判断 Drawee Name 是否等于 nameSourceField。
      let billSplitBaseRow = mappedRow;
      if (!billSplitReuseModuleMapping) {
        // 不复用模块映射时主映射算出的底稿不输出（v3.2.21 B112：其中读到的长数字不提示）
        if (rowHasUnverifiedLongNumber) currentRowUnverifiedCells = new Map();
        billSplitBaseRow = computeMappedRow(billSplitMappingByField, {
          skipTargetIndexes: billSplitDirectionalTargetIndexes(billSplitMappingByField),
          cellsByTarget: baseCellsByTarget
        });
        billSplitEffectiveMappingByField = billSplitMappingByField;
      } else {
        billSplitEffectiveMappingByField = mappingByField;
      }
      const expanded = expandBillSplitForRow(row, billSplitBaseRow, sourceRowNumber);
      // 合计行在合并前按展开后的金额判定：合并会校验组内币种、净额为 0 时整组丢弃，放在合并后会误拒或漏记。
      // v3.2.19：费用账单公式非 0 ÷ 0 时被除数有金额、结果留空，同样视为带金额，合计行不计入除零报错。
      if (summaryDateLabel && (currentRowFeeFormulaDivisionByZero || expanded.some((entry) => (
        hasEffectiveAmount(entry.creditAmount) || hasEffectiveAmount(entry.debitAmount)
      )))) {
        // 合计行不产出明细：撤回本行映射时记下的其他提示（如币种未匹配），只留合计行记录。
        issues.length = issueCountBeforeRow;
        recordSummaryRow();
        return;
      }
      if (currentRowFeeFormulaDivisionByZero) {
        feeFormulaDivisionByZeroRowNumbers.push(sourceRowNumber);
      }
      const merged = applyBillSplitMergeForRow(expanded);
      // v3.2.21：实际写出的费用账单行（合并时为代表行）先校验取自源列的覆盖原值能否原样写入工作表，再规范化 ValueDate；
      //   在归集长数字来源之前完成，按最终写出的值判断（release 审查）
      merged.forEach((entry) => {
        if (!entry.isFeeBill) return;
        billSplitFeeFieldMappings.forEach((item, index) => {
          const rawValue = (entry.feeFieldRawValues || [])[index];
          assertFeeFieldOutputWritable(item, rawValue, { sourceRowNumber: entry.sourceRowNumber });
          // 含无法写入 Excel 的字符的原值不按日期规范化（否则读成空值、不再被拒绝）：原样留在明细行，由生成前的检查列出位置
          if (item.templateField === 'ValueDate' && !(typeof rawValue === 'string' && !isWorksheetWritableText(rawValue))) {
            entry.rowArray[item.targetIndex] = normalizeDateExportValue(normalizeCell(rawValue), { dateParseOrder }).value;
          }
        });
      });
      // v3.2.21：按输出行实际沿用映射的字段统计特征值未命中（被覆盖的字段、拆分配置取值的发生额列不算）；
      //   未启用特征值时不会有未命中提示，跳过逐行金额判断
      if (activeFeatureFilters.length > 0) {
        const outputEntries = merged.filter((entry) => (
          hasEffectiveAmount(entry.creditAmount) || hasEffectiveAmount(entry.debitAmount)
        ));
        const usedFeatureFilterIds = new Set();
        if (outputEntries.some((entry) => !entry.isFeeBill)) {
          billSplitRowFeatureFilterIdSet.forEach((id) => usedFeatureFilterIds.add(id));
        }
        if (outputEntries.some((entry) => entry.isFeeBill)) {
          billSplitFeeRowFeatureFilterIdSet.forEach((id) => usedFeatureFilterIds.add(id));
        }
        recordFeatureValueMiss(outputEntries.length > 0, usedFeatureFilterIds);
      }
      // 实际导出的子行：底稿中沿用的列（子行覆盖了币种时不含底稿币种；费用账单行不含被「字段映射特殊处理」覆盖的列）
      //   加上子行各自的取值
      const exportedEntries = merged.filter((entry) => isExportedDetailRow(entry.rowArray));
      const outputCurrencyIndex = orderedTargetFields.indexOf('Currency');
      // 各源字段写进的目标列（底稿沿用的列与子行各自的列）；有不归到具体目标列的读取时不记目标列（不会因改选大账号被剔除）
      const targetFieldsBySource = new Map();
      if (currentRowUnverifiedCells) {
        const untargeted = new Set(currentRowUnverifiedCells.keys());
        const addTargets = (cells, targetIndex) => cells.forEach((_digitCount, sourceField) => {
          if (!targetFieldsBySource.has(sourceField)) targetFieldsBySource.set(sourceField, new Set());
          targetFieldsBySource.get(sourceField).add(orderedTargetFields[targetIndex]);
        });
        exportedEntries.forEach((entry) => {
          baseCellsByTarget.forEach((cells, targetIndex) => {
            if (targetIndex === unusedBalanceTargetIndex) return;
            if (targetIndex === outputCurrencyIndex && entry.currencyFromSplitRow) return;
            if (entry.isFeeBill && billSplitFeeFieldTargetIndexes.has(targetIndex)) return;
            mergeCellMap(cells, currentRowUnverifiedCells);
            addTargets(cells, targetIndex);
          });
          // 费用行覆盖的 ValueDate 规范化后为空：没有近似值写进明细，只读给这类列的来源不记（同一源列还写进其他列、
          //   或参与发生额时照常记——发生额的来源已按收入 / 支出列记在 cellsByTarget，release 审查）
          const blankFeeTargets = entry.isFeeBill
            ? new Set(feeValueDateTargetIndexes.filter((targetIndex) => normalizeCell(entry.rowArray[targetIndex]) === ''))
            : null;
          const droppedFields = new Set();
          if (blankFeeTargets && blankFeeTargets.size && entry.cellsByTarget instanceof Map) {
            const keptFields = new Set();
            entry.cellsByTarget.forEach((cells, targetIndex) => {
              if (!blankFeeTargets.has(targetIndex)) cells.forEach((_digitCount, sourceField) => keptFields.add(sourceField));
            });
            blankFeeTargets.forEach((targetIndex) => {
              const cells = entry.cellsByTarget.get(targetIndex);
              if (cells) cells.forEach((_digitCount, sourceField) => { if (!keptFields.has(sourceField)) droppedFields.add(sourceField); });
            });
          }
          if (entry.unverifiedCells instanceof Map) {
            entry.unverifiedCells.forEach((digitCount, sourceField) => {
              if (!droppedFields.has(sourceField) && !currentRowUnverifiedCells.has(sourceField)) currentRowUnverifiedCells.set(sourceField, digitCount);
            });
          }
          const attributed = new Set();
          if (entry.cellsByTarget instanceof Map) {
            entry.cellsByTarget.forEach((cells, targetIndex) => {
              if (blankFeeTargets && blankFeeTargets.has(targetIndex)) return;
              addTargets(cells, targetIndex);
              cells.forEach((_digitCount, sourceField) => attributed.add(sourceField));
            });
          }
          if (entry.unverifiedCells instanceof Map) {
            entry.unverifiedCells.forEach((_digitCount, sourceField) => {
              if (!attributed.has(sourceField) && !droppedFields.has(sourceField)) untargeted.add(sourceField);
            });
          }
        });
        untargeted.forEach((sourceField) => targetFieldsBySource.delete(sourceField));
      }
      recordUnverifiedLongNumbers(exportedEntries.length > 0, targetFieldsBySource);
      // 根据字段值过滤账单时主映射的按字段区分发生额只统计走主映射的行
      if (!compiledBillSplitRowFilter) {
        countAmountSplitHits();
      }
      merged.forEach((entry) => {
        rowMetas.push({ sourceRowNumber: entry.sourceRowNumber, ...sourceRowKeyMeta });
        mappedRows.push(entry.rowArray);
      });
      if (merged.length > 0) {
        matchedBillSplitCount += merged.length;
      }
    } else {
      recordFeatureValueMiss(hasCreditAmount || hasDebitAmount);
      // 映射前已读的（发生额、合计行判定读的账单日期）不归到具体目标列
      const targetFieldsBySource = new Map();
      if (currentRowUnverifiedCells) {
        baseCellsByTarget.forEach((cells, targetIndex) => {
          if (targetIndex === unusedBalanceTargetIndex) return;
          mergeCellMap(cells, currentRowUnverifiedCells);
          cells.forEach((_digitCount, sourceField) => {
            if (preMappedFields.has(sourceField)) return;
            if (!targetFieldsBySource.has(sourceField)) targetFieldsBySource.set(sourceField, new Set());
            targetFieldsBySource.get(sourceField).add(orderedTargetFields[targetIndex]);
          });
        });
      }
      recordUnverifiedLongNumbers(isExportedDetailRow(mappedRow), targetFieldsBySource);
      countAmountSplitHits();
      mappedRows.push(mappedRow);
    }
  });
  currentRowUnverifiedCells = null;

  if (feeFormulaDivisionByZeroRowNumbers.length) {
    const shown = feeFormulaDivisionByZeroRowNumbers.slice(0, 20).join('、');
    const more = feeFormulaDivisionByZeroRowNumbers.length > 20
      ? ` 等 ${feeFormulaDivisionByZeroRowNumbers.length} 行`
      : ' 行';
    throw new FileValidationError(
      'BILL_SPLIT_FEE_FORMULA_DIVIDE_BY_ZERO',
      `费用账单发生额公式的除数为 0，请检查原始账单或公式：第 ${shown}${more}`
    );
  }

  assertNoInvalidBillDateRows({
    mappedRows,
    rowMetas,
    orderedTargetFields,
    invalidBillDateBySourceRow
  });

  if (merchantIdUsesCurrencyMapping) {
    applyCurrencyBigAccountMapping({
      mappedRows,
      rowMetas,
      orderedTargetFields,
      mapping: currencyBigAccountMapping,
      inputFilePath,
      maskDiagnosticValue: maskRestoredLongIntegers
    });
  }

  mappedRows.issues = issues;
  mappedRows.rowMetas = rowMetas;
  mappedRows.headerBreaks = headerBreaks;

  const sourceRowCount = rows.length > 0 ? rows.length - 1 : 0;

  if (amountSplitEnabled) {
    // v3.2.19：根据字段值过滤账单时只统计走主映射的行
    mappedRows.amountSplitMatchStats = {
      enabled: true,
      totalRows: sourceRowCount - billSplitPathRowCount,
      hitCredit: matchedCreditCount,
      hitDebit: matchedDebitCount
    };
  }

  if (billSplitEnabled) {
    // v3.2.19：根据字段值过滤账单时只统计命中过滤规则（走拆分）的行；没有命中行时不提示拆分无输出
    mappedRows.billSplitMatchStats = {
      enabled: true,
      totalRows: billSplitPathRowCount,
      outputRows: matchedBillSplitCount
    };
  }

  if (preprocessed.enabled) {
    // 被过滤的行未进入主循环，日期取特征值时按该行单独计算，不能沿用主循环最后一行的特征值。
    // v3.2.19：原始账单预处理——读到的数据行数与保留（命中过滤规则）的行数，过滤后没有账单行时提示检查规则。
    //   droppedTransactionRowNumbers：被过滤掉、但账单日期可识别（即本会作为交易行）的源行号。多账户分段文件识别
    //   下一段表头前的账号时，以上一段最后一笔交易为界（main.js finalizeBigAccountRecognitionBasis），被过滤的交易行
    //   仍算作上一段的交易，避免其中的账号被当成下一段的账号。
    const billDateMappings = [mappingByField && mappingByField.BillDate]
      .concat(billSplitEnabled && !billSplitReuseModuleMapping ? [billSplitMappingByField.BillDate] : []);
    mappedRows.preprocessRowFilterStats = {
      enabled: true,
      totalRows: preprocessed.totalRows,
      keptRows: preprocessed.keptRows,
      droppedTransactionRowNumbers: preprocessed.droppedRows
        // v3.2.21：BillDate 逻辑取值的特征值候补把合计标签筛成空、回落到有效日期的行，这里仍算作上一段的交易行（不套用
        //   保留行的合计判定，保持 v3.2.19 口径）：它充当桥接候选的界线。直接识别不受该界线裁剪，合计行上的账号仍可能
        //   被认作下一段的账号——与既有合计行同一问题，见 knowledge/backlog.md B122。
        .filter(({ row }) => {
          const featureValues = extractRowFeatureValues(row);
          return billDateMappings.some((mappingValue) => Boolean(
            normalizeDateExportValue(resolveDateRawValueByMapping(mappingValue, row, featureValues), { dateParseOrder }).value
          ));
        })
        .map(({ rowNumber }) => rowNumber)
    };
  }

  return mappedRows;
}

// v3.2.19：原始账单预处理「过滤账单」。rows[0] 为表头；rowNumbers 与 rows 平行（缺失时按 下标 + 1 回落，同主循环口径）。
// 没有规则时原样返回。
function applyPreprocessRowFilter(sourceRows, sourceRowNumbers, rules, sourceIndexByField) {
  const totalRows = sourceRows.length > 0 ? sourceRows.length - 1 : 0;
  if (!Array.isArray(rules) || rules.length === 0) {
    return { enabled: false, rows: sourceRows, rowNumbers: sourceRowNumbers, totalRows, keptRows: totalRows, droppedRows: [] };
  }
  const compiled = compileRowFilterRules(rules, sourceIndexByField, {
    missingMessage: PREPROCESS_ROW_FILTER_MISSING_MESSAGE
  });
  if (!sourceRows.length) {
    return { enabled: true, rows: sourceRows, rowNumbers: sourceRowNumbers, totalRows: 0, keptRows: 0, droppedRows: [] };
  }
  const rows = [sourceRows[0]];
  const rowNumbers = [sourceRowNumbers[0]];
  const droppedRows = [];
  for (let index = 1; index < sourceRows.length; index += 1) {
    const rowNumber = sourceRowNumbers[index] || index + 1;
    if (matchesRowFilterRules(sourceRows[index], compiled)) {
      rows.push(sourceRows[index]);
      rowNumbers.push(rowNumber);
    } else {
      droppedRows.push({ row: sourceRows[index], rowNumber });
    }
  }
  return { enabled: true, rows, rowNumbers, totalRows, keptRows: rows.length - 1, droppedRows };
}

function buildDetailExportRows(rows) {
  const sourceHeaderRow = Array.isArray(rows[0]) ? rows[0].slice() : [];
  const fieldIndexMap = new Map();
  const rowMetas = Array.isArray(rows.rowMetas) ? rows.rowMetas : [];
  const balanceIndex = sourceHeaderRow.findIndex((fieldName) => normalizeCell(fieldName) === 'Balance');
  const headerRow = balanceIndex < 0
    ? sourceHeaderRow.slice()
    : sourceHeaderRow.filter((_fieldName, index) => index !== balanceIndex);
  const exportRows = [headerRow];
  const sourceRows = [sourceHeaderRow.slice()];
  const skippedRows = [];
  const simultaneousRows = [];
  const sourceRowMetas = [];

  sourceHeaderRow.forEach((fieldName, index) => {
    const normalizedField = normalizeCell(fieldName);

    if (normalizedField && !fieldIndexMap.has(normalizedField)) {
      fieldIndexMap.set(normalizedField, index);
    }
  });

  const creditAmountIndex = fieldIndexMap.get('Credit Amount');
  const debitAmountIndex = fieldIndexMap.get('Debit Amount');

  rows.slice(1).forEach((row, index) => {
    const sourceRow = Array.isArray(row) ? row.slice() : [];
    const exportRow = sourceRow.slice();
    const creditAmountValue = creditAmountIndex === undefined ? '' : sourceRow[creditAmountIndex];
    const debitAmountValue = debitAmountIndex === undefined ? '' : sourceRow[debitAmountIndex];
    const isCreditAmountZeroOrBlank = isZeroOrBlankAmount(creditAmountValue);
    const isDebitAmountZeroOrBlank = isZeroOrBlankAmount(debitAmountValue);

    if (
      creditAmountIndex !== undefined &&
      debitAmountIndex !== undefined &&
      !isCreditAmountZeroOrBlank &&
      !isDebitAmountZeroOrBlank
    ) {
      simultaneousRows.push({
        sourceRowNumber: rowMetas[index]?.sourceRowNumber || index + 2,
        creditAmount: normalizeCell(creditAmountValue),
        debitAmount: normalizeCell(debitAmountValue)
      });
      return;
    }

    if (
      creditAmountIndex !== undefined &&
      debitAmountIndex !== undefined &&
      isCreditAmountZeroOrBlank &&
      isDebitAmountZeroOrBlank
    ) {
      skippedRows.push({
        sourceRowNumber: rowMetas[index]?.sourceRowNumber || index + 2,
        creditAmount: normalizeCell(creditAmountValue),
        debitAmount: normalizeCell(debitAmountValue)
      });
      return;
    }

    sourceRows.push(sourceRow);
    sourceRowMetas.push(rowMetas[index] || null);

    if (balanceIndex >= 0) {
      exportRow.splice(balanceIndex, 1);
    }

    exportRows.push(exportRow);
  });

  sourceRows.rowMetas = sourceRowMetas;
  exportRows.skippedRows = skippedRows;
  exportRows.simultaneousRows = simultaneousRows;
  exportRows.sourceRows = sourceRows;
  return exportRows;
}

function writeWorkbookRows({ rows, outputFilePath, sheetName = 'COMMON' }) {
  return writeWorkbookRowsInternal(
    { rows, outputFilePath, sheetName },
    { inferDateCellFormat, parseDateValue, parseNumericValue, toExcelSerial }
  );
}

function writeBalanceWorkbook({
  templateFilePath,
  records,
  templateFields = [],
  outputFilePath
}) {
  return writeBalanceWorkbookInternal(
    { templateFilePath, records, templateFields, outputFilePath },
    { inferDateCellFormat, parseDateValue, parseNumericValue, toExcelSerial }
  );
}

function transformFileToWorkbook({
  inputFilePath,
  mappingByField,
  merchantSourceFields = [],
  accountMappingByBankId = {},
  outputFilePath
}) {
  const orderedTargetFields = [];

  Object.entries(mappingByField).forEach(([sourceField, targetField]) => {
    if (!targetField) {
      return;
    }

    orderedTargetFields.push(targetField);
  });

  const normalizedMappingByField = Object.entries(mappingByField).reduce((accumulator, [sourceField, targetField]) => {
    if (!targetField) {
      return accumulator;
    }

    accumulator[targetField] = sourceField;
    return accumulator;
  }, {});

  if (!orderedTargetFields.includes('MerchantId') && merchantSourceFields.length) {
    orderedTargetFields.push('MerchantId');
  }

  const rows = buildMappedRows({
    inputFilePath,
    orderedTargetFields,
    mappingByField: normalizedMappingByField,
    accountMappingByBankId
  });

  return writeWorkbookRows({
    rows,
    outputFilePath
  });
}

module.exports = {
  appendCurrencyBigAccountIssues,
  calculateEndingBalanceFromAmounts,
  buildCurrencyBigAccountUnmappedError,
  buildExpectedHeaderCandidates,
  buildMappedRows,
  buildDetailExportRows,
  compileRegexLiteral,
  FEATURE_FILTER_FIELD_TOKEN_PREFIX,
  FileValidationError,
  FIXED_FIELD_VALUE_PREFIX,
  MERCHANT_ID_CURRENCY_ONLY_MARKER,
  verifyStatementEndingBalance,
  isCurrencyBigAccountUnmappedError,
  isRegexLiteral,
  mapEachCollectingCurrencyBigAccountIssues,
  matchAmountSplitConditionValue,
  SUPPORTED_EXTENSIONS,
  ensureSupportedFile,
  extractEnumValuesFromImportedFile,
  extractHeaders,
  FEE_FORMULA_OPERATOR_LABELS,
  loadCurrencyMappings,
  loadEnumValues,
  normalizeCell,
  normalizeFeeAmountFormula,
  validateFeeAmountFormula,
  normalizeFeeFieldMappings,
  validateFeeFieldMappings,
  isFeeFieldMappingTemplateFieldExcluded,
  ROW_FILTER_OPERATORS,
  collectBillSplitRowFilterFields,
  normalizeBillSplitRowFilterRules,
  validateBillSplitRowFilterRules,
  PREPROCESS_ROW_FILTER_MISSING_MESSAGE,
  normalizeRowFilterRules,
  validateRowFilterRules,
  normalizeDateExportValue,
  describeDuplicateKeeperReplacementConflicts,
  dropDuplicateSourceRows,
  findDuplicateKeeperReplacementConflicts,
  scanDuplicateSourceRows,
  buildFeatureFilterToken,
  buildLogicValueToken,
  getFeatureFilterRef,
  normalizeFeatureFilterList,
  normalizeFeatureFilterRule,
  normalizeLogicValueFields,
  LOGIC_VALUE_MIN_FIELDS,
  LEGACY_FEATURE_FILTER_ID,
  buildLogicValueFeatureCandidate,
  parseFeatureFilterToken,
  parseLogicValueFeatureFilterRef,
  parseLogicValueToken,
  resolveUsedFeatureFilters,
  upgradeLegacyFeatureFilter,
  parseDateValue,
  parseNumericValue,
  readRows,
  readRowsWithMetadata,
  roundAmountHighPrecision,
  sumAmounts,
  transformFileToWorkbook,
  assertBalanceRecordsWritable,
  prepareWorkbookTextForWrite,
  writeBalanceWorkbook,
  writeWorkbookRows
};
