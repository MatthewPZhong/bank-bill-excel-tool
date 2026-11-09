const {
  FileValidationError,
  FIXED_FIELD_VALUE_PREFIX,
  MERCHANT_ID_CURRENCY_ONLY_MARKER,
  SUPPORTED_EXTENSIONS,
  buildExpectedHeaderCandidates,
  normalizeCell
} = require('./file-service/common');
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
  inferDateCellFormat,
  inferEndingBalance,
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
  toExcelSerial
} = require('./file-service/normalizers');
const {
  appendCurrencyBigAccountIssues,
  applyCurrencyBigAccountMapping,
  buildCurrencyBigAccountUnmappedError,
  createConfigMissingError: createCurrencyBigAccountConfigMissingError,
  isCurrencyBigAccountUnmappedError,
  mapEachCollectingCurrencyBigAccountIssues
} = require('./file-service/currency-big-account');
const {
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

function buildMappedRows({
  inputFilePath,
  orderedTargetFields,
  mappingByField,
  accountMappingByBankId = {},
  currencyMappings = [],
  amountMappingRules = {},
  amountSplitByField = null,
  billSplitMerge = null,
  expectedSourceHeaders = [],
  selectedBigAccount = null,
  dateParseOrder = 'auto',
  readOptions = {},
  // v3.2.16：MerchantId「原始账单仅有币种无账户号」时为 { templateName, pairs: [{ currency, merchantId }] }
  currencyBigAccountMapping = null
}) {
  // 拿不到 币种 → 大账号 配置时直接拒绝，避免 MerchantId 整列留空静默输出。
  const merchantIdUsesCurrencyMapping = normalizeMappingTokens(mappingByField && mappingByField.MerchantId)[0]
    === MERCHANT_ID_CURRENCY_ONLY_MARKER;
  if (merchantIdUsesCurrencyMapping && !currencyBigAccountMapping) {
    throw createCurrencyBigAccountConfigMissingError('');
  }
  const { rows, rowNumbers, headerBreaks = [] } = readRowsWithMetadata(
    inputFilePath,
    expectedSourceHeaders,
    readOptions
  );
  const sourceHeaders = rows[0] || [];
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
  let matchedCreditCount = 0;
  let matchedDebitCount = 0;
  let matchedBillSplitCount = 0;

  sourceHeaders.forEach((header, index) => {
    const normalizedHeader = normalizeCell(header);

    if (normalizedHeader && !sourceIndexByField.has(normalizedHeader)) {
      sourceIndexByField.set(normalizedHeader, index);
    }
  });

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
      ensureBillSplitFieldExists(row.creditSourceField);
      ensureBillSplitFieldExists(row.debitSourceField);
      ensureBillSplitFieldExists(row.amountSourceField);
    });

    billSplitAmountRules.forEach((rule) => {
      ensureBillSplitFieldExists(rule.conditionField);
      ensureBillSplitFieldExists(rule.mappedField);
    });

    if (billSplitSignedField) {
      ensureBillSplitFieldExists(billSplitSignedField);
    }
  }

  const mappedRows = [orderedTargetFields.slice()];

  function normalizeMappingTokens(mappingValue) {
    if (Array.isArray(mappingValue)) {
      return mappingValue.map((value) => normalizeCell(value)).filter((value) => value !== '');
    }

    const normalizedValue = normalizeCell(mappingValue);
    return normalizedValue ? [normalizedValue] : [];
  }

  function resolveMappedPartsByTokens(mappingTokens, row) {
    return mappingTokens.map((token) => {
      if (token.startsWith(FIXED_FIELD_VALUE_PREFIX)) {
        return token.slice(FIXED_FIELD_VALUE_PREFIX.length);
      }

      const sourceIndex = sourceIndexByField.get(token);
      return sourceIndex === undefined ? '' : row[sourceIndex];
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

  function resolveDateRawValueByMapping(mappingValue, row) {
    const mappingTokens = normalizeMappingTokens(mappingValue);

    if (!mappingTokens.length) {
      return '';
    }

    return resolveMappedPartsByTokens(mappingTokens, row)
      .map((value) => normalizeCell(value))
      .filter((value) => value !== '')
      .join(' ');
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
    return sourceIndex === undefined ? '' : row[sourceIndex];
  }

  function evaluateBillSplitAmountRulesForRow(row, amountValueRaw) {
    let credit = '';
    let debit = '';
    let matchedCredit = false;
    let matchedDebit = false;
    billSplitAmountRules.forEach((rule) => {
      const conditionField = normalizeCell(rule.conditionField);
      const targetField = normalizeCell(rule.targetField);
      const conditionValue = String(rule.conditionValue ?? '');
      if (!conditionField || !targetField) {
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
      // 每条规则用自己的 mappedField 读取金额；无 mappedField 时回退到外部传入值
      const ruleAmountRaw = rule.mappedField ? readSourceCell(row, rule.mappedField) : amountValueRaw;
      if (targetField === 'Credit Amount' && !matchedCredit) {
        credit = sanitizeAmountValue(ruleAmountRaw);
        matchedCredit = true;
      } else if (targetField === 'Debit Amount' && !matchedDebit) {
        debit = sanitizeAmountValue(ruleAmountRaw);
        matchedDebit = true;
      }
    });
    return { credit, debit, matchedCredit, matchedDebit };
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

    return billSplitRows
      .map((splitRow) => {
        const expandedRow = baseMappedRow.slice();
        const currencyValue = normalizeCell(readSourceCell(originalRow, splitRow.currencySourceField));
        let creditValue = '';
        let debitValue = '';

        // 指定账单实现功能：判断是否有指定、当前行是否被指定
        const hasSignedTargets = billSplitSignedTargetSeqNos.length > 0;
        const hasByFieldTargets = billSplitByFieldTargetSeqNos.length > 0;
        const isTargetedBySigned = hasSignedTargets && billSplitSignedTargetSeqNos.includes(splitRow.seqNo);
        const isTargetedByField = hasByFieldTargets && billSplitByFieldTargetSeqNos.includes(splitRow.seqNo);

        if (isTargetedBySigned && hasSignedAmount) {
          // 该行被"按正负号拆分的发生额"指定
          const split = splitSignedAmountValue(readSourceCell(originalRow, billSplitSignedField));
          creditValue = split.creditAmount;
          debitValue = split.debitAmount;
        } else if (isTargetedByField && hasAmountRules) {
          // 该行被"按字段区分发生额"指定，从规则的 mappedField 读取金额
          const firstRule = billSplitAmountRules.find((r) => r.mappedField);
          const amountRaw = firstRule ? readSourceCell(originalRow, firstRule.mappedField) : '';
          const result = evaluateBillSplitAmountRulesForRow(originalRow, amountRaw);
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
            const amountRaw = firstRule ? readSourceCell(originalRow, firstRule.mappedField) : '';
            const result = evaluateBillSplitAmountRulesForRow(originalRow, amountRaw);
            creditValue = result.credit;
            debitValue = result.debit;
          }
        } else {
          // 未被指定的行（有指定但该行不在列表），使用行级 Credit/Debit 直接映射
          creditValue = sanitizeAmountValue(readSourceCell(originalRow, splitRow.creditSourceField));
          debitValue = sanitizeAmountValue(readSourceCell(originalRow, splitRow.debitSourceField));
        }

        // 静默过滤：credit 和 debit 都为 0（或空）的拆分行直接丢弃，不输出也不报错
        const creditNum = parseNumericValue(creditValue);
        const debitNum = parseNumericValue(debitValue);
        if ((creditNum === 0 || creditNum === null || creditNum === undefined || Number.isNaN(creditNum))
            && (debitNum === 0 || debitNum === null || debitNum === undefined || Number.isNaN(debitNum))) {
          return null;
        }

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

        // Drawee Name: 只有 credit-only 拆分行填值，其它情况置空（与 v1.4.8 的 source-row 级语义对齐，
        // 只是判定维度从 source row 变成拆分行）
        if (draweeNameIndex >= 0 && nameSourceField && draweeNameMappingValue === nameSourceField) {
          const rawName = readSourceCell(originalRow, nameSourceField);
          expandedRow[draweeNameIndex] = hasCreditInRow && !hasDebitInRow ? (rawName != null ? rawName : '') : '';
        }
        // Payee Name: 只有 debit-only 拆分行填值
        if (payeeNameIndex >= 0 && nameSourceField && payeeNameMappingValue === nameSourceField) {
          const rawName = readSourceCell(originalRow, nameSourceField);
          expandedRow[payeeNameIndex] = hasDebitInRow && !hasCreditInRow ? (rawName != null ? rawName : '') : '';
        }
        // Drawee CardNo: 只有 credit-only 拆分行填值
        if (draweeCardNoIndex >= 0 && accountSourceField && draweeCardNoMappingValue === accountSourceField) {
          const rawAcct = readSourceCell(originalRow, accountSourceField);
          expandedRow[draweeCardNoIndex] = hasCreditInRow && !hasDebitInRow ? (rawAcct != null ? rawAcct : '') : '';
        }
        // Payee CardNo: 只有 debit-only 拆分行填值
        if (payeeCardNoIndex >= 0 && accountSourceField && payeeCardNoMappingValue === accountSourceField) {
          const rawAcct = readSourceCell(originalRow, accountSourceField);
          expandedRow[payeeCardNoIndex] = hasDebitInRow && !hasCreditInRow ? (rawAcct != null ? rawAcct : '') : '';
        }

        return {
          seqNo: splitRow.seqNo,
          mergedGroupSeq: splitRow.mergedGroupSeq,
          currency: currencyValue,
          creditAmount: creditValue,
          debitAmount: debitValue,
          rowArray: expandedRow,
          sourceRowNumber
        };
      })
      .filter((r) => r !== null);
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
        currency: representative.currency,
        creditAmount: net > 0 ? netString : '',
        debitAmount: net < 0 ? netString : '',
        rowArray: mergedRowArray,
        sourceRowNumber: representative.sourceRowNumber
      });
    });

    return result.sort((a, b) => (a.seqNo || 0) - (b.seqNo || 0));
  }

  rows.slice(1).forEach((row, rowIndex) => {
    const directCreditAmountRaw = resolveRawValueByMapping(mappingByField['Credit Amount'], row);
    const directDebitAmountRaw = resolveRawValueByMapping(mappingByField['Debit Amount'], row);
    const signedAmountValue = signedAmountSourceField
      ? splitSignedAmountValue(resolveRawValueByMapping(signedAmountSourceField, row))
      : null;

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

        const amountRaw = row[mappedIndex];

        if (targetField === 'Credit Amount' && !matchedCreditRule) {
          creditRawFromRule = amountRaw;
          matchedCreditRule = true;
        } else if (targetField === 'Debit Amount' && !matchedDebitRule) {
          debitRawFromRule = amountRaw;
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
    const effectiveBillDateMapping = billSplitEnabled && !billSplitReuseModuleMapping
      ? billSplitMappingByField.BillDate
      : mappingByField.BillDate;
    const rawEffectiveBillDate = resolveDateRawValueByMapping(effectiveBillDateMapping, row);
    const summaryDateLabel = isStatementSummaryDateLabel(rawEffectiveBillDate)
      ? normalizeCell(rawEffectiveBillDate)
      : '';
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

    if (!billSplitEnabled && summaryDateLabel && (hasCreditAmount || hasDebitAmount)) {
      recordSummaryRow();
      return;
    }

    if (!billSplitEnabled) {
      rowMetas.push({ sourceRowNumber });
    }

    // P1 Fix A (PR #16 review): 提取单行映射计算为可复用 helper，以便 billSplit 的
    // reuseModuleMapping === false 场景可以用弹框 1 的独立 mapping lookup 重算非金额字段。
    // 行为对 reuseModuleMapping === true（默认）路径保持完全等价——helper 依赖的 closure
    // 变量 (row, rowIndex, hasCreditAmount, hasDebitAmount, creditAmountValue, debitAmountValue,
    // selectedCurrency, selectedMerchantId, nameSourceField, accountSourceField, currencyMappings,
    // accountMappingByBankId, dateParseOrder, rowNumbers, issues) 都已在外层 forEach 作用域内。
    function computeMappedRow(mappingByFieldParam) {
      return orderedTargetFields.map((targetField) => {
        const mappingValue = mappingByFieldParam[targetField];
        const mappingTokens = normalizeMappingTokens(mappingValue);
        const primaryMappingValue = mappingTokens[0] || '';
        const sourceField = primaryMappingValue;
        const rawValue = resolveRawValueByMapping(mappingValue, row);

        if (targetField === 'Balance') {
          // 余额可为负：保留符号（映射值已拼成字符串，不能依赖数值分支保号）。
          return sanitizeSignedAmountValue(rawValue);
        }

        if (targetField === 'Credit Amount') {
          return creditAmountValue;
        }

        if (targetField === 'Debit Amount') {
          return debitAmountValue;
        }

        if (targetField === 'BillDate' || targetField === 'ValueDate') {
          const rawDateValue = resolveDateRawValueByMapping(mappingValue, row);
          const normalizedDateValue = normalizeDateExportValue(rawDateValue, { dateParseOrder }).value;
          if (targetField === 'BillDate' && !normalizedDateValue && rawDateValue) {
            invalidBillDateBySourceRow.set(sourceRowNumber, rawDateValue);
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
      });
    }

    const issueCountBeforeRow = issues.length;
    const mappedRow = computeMappedRow(mappingByField);

    if (billSplitEnabled) {
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
        billSplitBaseRow = computeMappedRow(billSplitMappingByField);
        billSplitEffectiveMappingByField = billSplitMappingByField;
      } else {
        billSplitEffectiveMappingByField = mappingByField;
      }
      const expanded = expandBillSplitForRow(row, billSplitBaseRow, sourceRowNumber);
      // 合计行在合并前按展开后的金额判定：合并会校验组内币种、净额为 0 时整组丢弃，放在合并后会误拒或漏记。
      if (summaryDateLabel && expanded.some((entry) => (
        hasEffectiveAmount(entry.creditAmount) || hasEffectiveAmount(entry.debitAmount)
      ))) {
        // 合计行不产出明细：撤回本行映射时记下的其他提示（如币种未匹配），只留合计行记录。
        issues.length = issueCountBeforeRow;
        recordSummaryRow();
        return;
      }
      const merged = applyBillSplitMergeForRow(expanded);
      countAmountSplitHits();
      merged.forEach((entry) => {
        rowMetas.push({ sourceRowNumber: entry.sourceRowNumber });
        mappedRows.push(entry.rowArray);
      });
      if (merged.length > 0) {
        matchedBillSplitCount += merged.length;
      }
    } else {
      countAmountSplitHits();
      mappedRows.push(mappedRow);
    }
  });

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
      inputFilePath
    });
  }

  mappedRows.issues = issues;
  mappedRows.rowMetas = rowMetas;
  mappedRows.headerBreaks = headerBreaks;

  if (amountSplitEnabled) {
    mappedRows.amountSplitMatchStats = {
      enabled: true,
      totalRows: rows.length > 0 ? rows.length - 1 : 0,
      hitCredit: matchedCreditCount,
      hitDebit: matchedDebitCount
    };
  }

  if (billSplitEnabled) {
    mappedRows.billSplitMatchStats = {
      enabled: true,
      totalRows: rows.length > 0 ? rows.length - 1 : 0,
      outputRows: matchedBillSplitCount
    };
  }

  return mappedRows;
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
    const creditAmountNumeric = parseNumericValue(creditAmountValue);
    const debitAmountNumeric = parseNumericValue(debitAmountValue);
    const isCreditAmountZeroOrBlank = normalizeCell(creditAmountValue) === '' || creditAmountNumeric === 0;
    const isDebitAmountZeroOrBlank = normalizeCell(debitAmountValue) === '' || debitAmountNumeric === 0;

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
  FileValidationError,
  FIXED_FIELD_VALUE_PREFIX,
  MERCHANT_ID_CURRENCY_ONLY_MARKER,
  inferEndingBalance,
  isCurrencyBigAccountUnmappedError,
  isRegexLiteral,
  mapEachCollectingCurrencyBigAccountIssues,
  matchAmountSplitConditionValue,
  SUPPORTED_EXTENSIONS,
  ensureSupportedFile,
  extractEnumValuesFromImportedFile,
  extractHeaders,
  loadCurrencyMappings,
  loadEnumValues,
  normalizeCell,
  normalizeDateExportValue,
  parseDateValue,
  parseNumericValue,
  readRows,
  readRowsWithMetadata,
  roundAmountHighPrecision,
  transformFileToWorkbook,
  writeBalanceWorkbook,
  writeWorkbookRows
};
