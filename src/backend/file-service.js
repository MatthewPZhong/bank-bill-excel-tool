const {
  FileValidationError,
  FIXED_FIELD_VALUE_PREFIX,
  SUPPORTED_EXTENSIONS,
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
  sanitizeAmountValue,
  splitSignedAmountValue,
  toExcelSerial
} = require('./file-service/normalizers');
const {
  writeBalanceWorkbook: writeBalanceWorkbookInternal,
  writeWorkbookRows: writeWorkbookRowsInternal
} = require('./file-service/writers');

function loadCurrencyMappings(filePath) {
  return loadCurrencyMappingsFromMappings(filePath, { readRows });
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
  dateParseOrder = 'auto'
}) {
  const { rows, rowNumbers, headerBreaks = [] } = readRowsWithMetadata(inputFilePath, expectedSourceHeaders);
  const sourceHeaders = rows[0] || [];
  const sourceIndexByField = new Map();
  const issues = [];
  const rowMetas = [];
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
      const net = sumCredit - sumDebit;

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

      if (hasCreditAmount) {
        matchedCreditCount += 1;
      }
      if (hasDebitAmount) {
        matchedDebitCount += 1;
      }
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
          return sanitizeAmountValue(rawValue);
        }

        if (targetField === 'Credit Amount') {
          return creditAmountValue;
        }

        if (targetField === 'Debit Amount') {
          return debitAmountValue;
        }

        if (targetField === 'BillDate' || targetField === 'ValueDate') {
          return normalizeDateExportValue(resolveDateRawValueByMapping(mappingValue, row), { dateParseOrder }).value;
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

          const currencyResult = resolveCurrencyValue(rawValue, currencyMappings);

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
      const merged = applyBillSplitMergeForRow(expanded);
      merged.forEach((entry) => {
        rowMetas.push({ sourceRowNumber: entry.sourceRowNumber });
        mappedRows.push(entry.rowArray);
      });
      if (merged.length > 0) {
        matchedBillSplitCount += merged.length;
      }
    } else {
      mappedRows.push(mappedRow);
    }
  });

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
  calculateEndingBalanceFromAmounts,
  buildMappedRows,
  buildDetailExportRows,
  compileRegexLiteral,
  FileValidationError,
  FIXED_FIELD_VALUE_PREFIX,
  inferEndingBalance,
  isRegexLiteral,
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
  transformFileToWorkbook,
  writeBalanceWorkbook,
  writeWorkbookRows
};
