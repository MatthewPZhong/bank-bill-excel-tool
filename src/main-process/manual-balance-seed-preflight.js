'use strict';

const {
  FileValidationError,
  normalizeCell,
  parseDateValue,
  parseNumericValue
} = require('../backend/file-service');
const {
  BALANCE_SEED_GENERATION_METHODS,
  readBalanceSeedRecords,
  splitTemplateName,
  writeBalanceSeedRecords
} = require('../backend/balance-seed-store');
const {
  getStatementSessionEntries,
  normalizeInputFilePaths
} = require('./statement-session');
const { resolveStatementOutputName } = require('./statement-channel-identity');

function pad(value) {
  return String(value).padStart(2, '0');
}

function formatDateLabel(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function buildManualBalanceInvalidResult(message, prompt, generatedExports = {}) {
  return {
    status: 'manual-balance-invalid',
    message,
    detailReady: Boolean(generatedExports.detail),
    balanceReady: Boolean(generatedExports.balance),
    errorReportReady: false,
    manualBalancePromptReady: true,
    manualBalancePrompt: { ...prompt }
  };
}

function balanceSeedRecordKey(record = {}) {
  return [
    normalizeCell(record.merchantId),
    normalizeCell(record.currency),
    normalizeCell(record.billDate)
  ].join('|');
}

function balanceSeedRecordsEvidence(records = []) {
  return JSON.stringify((Array.isArray(records) ? records : []).map((record) => ({
    merchantId: normalizeCell(record.merchantId),
    currency: normalizeCell(record.currency),
    billDate: normalizeCell(record.billDate),
    endBalance: parseNumericValue(record.endBalance),
    templateName: normalizeCell(record.templateName),
    generationMethod: normalizeCell(record.generationMethod || record['生成方式']),
    updatedAt: normalizeCell(record.updatedAt)
  })));
}

function resolveManualBalanceSeedFilePlanInputPaths({
  prepared = {},
  importContext = {},
  session = null
} = {}) {
  const freshnessInputPaths = normalizeInputFilePaths(prepared && prepared.inputFilePaths);
  if (freshnessInputPaths.length) return freshnessInputPaths;

  // 内存账单会话不会为余额补录重读源文件，但 File Task 仍必须登记真实来源。
  const rememberedInputPaths = normalizeInputFilePaths(
    importContext && importContext.inputFilePaths
  );
  if (rememberedInputPaths.length) return rememberedInputPaths;

  const scope = normalizeCell(importContext && importContext.scope) || 'current';
  const sessionEntries = getStatementSessionEntries(session, scope);
  return normalizeInputFilePaths(sessionEntries.map((entry) => entry && entry.filePath));
}

function buildManualBalanceSeedPlan({
  payload = {},
  pendingPrompt,
  importContext,
  generatedExports = {},
  storageRoot
} = {}) {
  const seedDate = parseDateValue(payload.billDate);
  const targetDate = parseDateValue(pendingPrompt && pendingPrompt.targetBillDate);
  const normalizedSeedDate = seedDate ? formatDateLabel(seedDate) : '';
  const normalizedTargetDate = targetDate ? formatDateLabel(targetDate) : '';
  const endBalance = parseNumericValue(payload.endBalance);

  if (!normalizedSeedDate) {
    return {
      stopResult: buildManualBalanceInvalidResult(
        '请选择上一账单日日期',
        pendingPrompt,
        generatedExports
      )
    };
  }
  if (normalizedTargetDate && normalizedSeedDate >= normalizedTargetDate) {
    return {
      stopResult: buildManualBalanceInvalidResult(
        '上一账单日日期必须早于当前需要校验的账单日期',
        pendingPrompt,
        generatedExports
      )
    };
  }
  // 断档补录早于断档前最后一个账单日时不会被采用，直接拒绝以免反复提示。
  const anchorDate = pendingPrompt && pendingPrompt.reason === 'gap'
    ? normalizeCell(pendingPrompt.anchorDate)
    : '';
  if (anchorDate && normalizedSeedDate <= anchorDate) {
    return {
      stopResult: buildManualBalanceInvalidResult(
        `补录日期必须晚于断档前最后一个账单日 ${anchorDate}`,
        pendingPrompt,
        generatedExports
      )
    };
  }
  if (endBalance === null) {
    return {
      stopResult: buildManualBalanceInvalidResult(
        '请输入有效的上一账单日余额',
        pendingPrompt,
        generatedExports
      )
    };
  }

  const seedTemplateName = normalizeCell(
    pendingPrompt && pendingPrompt.templateName
  ) || normalizeCell(resolveStatementOutputName(importContext && importContext.template));
  const bankName = splitTemplateName(seedTemplateName).bankName;
  const records = readBalanceSeedRecords(storageRoot, bankName);
  const record = {
    merchantId: normalizeCell(pendingPrompt && pendingPrompt.merchantId),
    currency: normalizeCell(pendingPrompt && pendingPrompt.currency),
    billDate: normalizedSeedDate,
    endBalance,
    templateName: seedTemplateName,
    generationMethod: BALANCE_SEED_GENERATION_METHODS.manual
  };
  const recordKey = balanceSeedRecordKey(record);
  const existingIndex = records.findIndex((candidate) => (
    balanceSeedRecordKey(candidate) === recordKey
  ));

  return {
    plan: {
      storageRoot,
      bankName,
      records,
      recordsEvidence: balanceSeedRecordsEvidence(records),
      existingIndex,
      record
    }
  };
}

function materializeManualBalanceSeedPlan(plan, now = new Date()) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan) ||
      typeof plan.storageRoot !== 'string' || typeof plan.bankName !== 'string' ||
      !plan.bankName.trim() || !Array.isArray(plan.records) || !plan.record ||
      typeof plan.record !== 'object' || Array.isArray(plan.record) ||
      typeof plan.recordsEvidence !== 'string' ||
      !Number.isSafeInteger(plan.existingIndex) || plan.existingIndex < -1 ||
      plan.existingIndex >= plan.records.length) {
    throw new TypeError('余额种子写入计划缺失或形状非法');
  }
  if (plan.recordsEvidence !== balanceSeedRecordsEvidence(plan.records)) {
    throw Object.assign(new Error('余额种子写入计划的 records evidence 已变化'), {
      code: 'BALANCE_SEED_PLAN_RECORDS_CHANGED'
    });
  }

  const normalizedRecord = {
    merchantId: normalizeCell(plan.record.merchantId),
    currency: normalizeCell(plan.record.currency),
    billDate: normalizeCell(plan.record.billDate),
    endBalance: parseNumericValue(plan.record.endBalance),
    templateName: normalizeCell(plan.record.templateName),
    generationMethod: normalizeCell(
      plan.record.generationMethod || plan.record['生成方式']
    ) || BALANCE_SEED_GENERATION_METHODS.manual
  };
  const derivedBankName = splitTemplateName(normalizedRecord.templateName).bankName;
  if (!normalizedRecord.merchantId || !normalizedRecord.billDate ||
      normalizedRecord.endBalance === null ||
      normalizedRecord.generationMethod !== BALANCE_SEED_GENERATION_METHODS.manual ||
      derivedBankName !== plan.bankName) {
    throw Object.assign(new Error('余额种子写入计划业务字段或银行目标不匹配'), {
      code: 'BALANCE_SEED_PLAN_BINDING_INVALID'
    });
  }

  const matchingIndex = plan.records.findIndex((candidate) => (
    balanceSeedRecordKey(candidate) === balanceSeedRecordKey(normalizedRecord)
  ));
  if (matchingIndex !== plan.existingIndex) {
    throw Object.assign(new Error('余额种子写入计划 existingIndex 已变化'), {
      code: 'BALANCE_SEED_PLAN_INDEX_CHANGED'
    });
  }
  const commitTime = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(commitTime.getTime())) {
    throw new TypeError('余额种子写入计划 now 必须是有效日期');
  }
  const record = {
    ...normalizedRecord,
    updatedAt: commitTime.toISOString()
  };
  const records = plan.records.map((item) => ({ ...item }));
  if (plan.existingIndex >= 0) records[plan.existingIndex] = record;
  else records.push(record);

  return Object.freeze({
    storageRoot: plan.storageRoot,
    bankName: plan.bankName,
    records: Object.freeze(records.map((item) => Object.freeze({ ...item }))),
    record: Object.freeze(record),
    commitUpdatedAt: record.updatedAt,
    sourceRecordsEvidence: plan.recordsEvidence
  });
}

function writeManualBalanceSeedPlan(plan, now = new Date()) {
  const materialized = materializeManualBalanceSeedPlan(plan, now);
  // v3.2.16：确认后的 beforeStart 核对与这里之间有异步等待，模板管理【余额管理】等入口可能在其间改写同一文件；
  //   写入前同步重读并核对，变化即拒绝，不用旧计划整文件覆盖他人的修改（核对与写入之间不让出事件循环）。
  const currentEvidence = balanceSeedRecordsEvidence(
    readBalanceSeedRecords(materialized.storageRoot, materialized.bankName)
  );
  if (currentEvidence !== materialized.sourceRecordsEvidence) {
    throw new FileValidationError('BALANCE_SEED_CHANGED_BEFORE_WRITE', '余额种子在确认期间已变化，请重新补录', {
      context: { bankName: materialized.bankName }
    });
  }
  return {
    status: 'success',
    filePath: writeBalanceSeedRecords(
      materialized.storageRoot,
      materialized.bankName,
      materialized.records
    ),
    record: materialized.record
  };
}

function manualBalancePreflightError(message, errorCode) {
  return {
    status: 'error',
    message,
    errorCode,
    detailLines: [],
    errorReportReady: false
  };
}

// “不补录”只能确认当前 prompt 列出的断档；不写种子，交由 execute 登记后重算。
function prepareBalanceGapSkip({
  payload,
  pendingPrompt,
  importContext,
  session,
  createFreshnessGuard
}) {
  const pendingGaps = pendingPrompt.reason === 'gap' && Array.isArray(pendingPrompt.gaps)
    ? pendingPrompt.gaps
    : [];
  const gapByKey = new Map(pendingGaps.map((gap) => [normalizeCell(gap && gap.key), gap]));
  const keys = Array.isArray(payload.skipBalanceGapKeys)
    ? [...new Set(payload.skipBalanceGapKeys.map((key) => normalizeCell(key)))]
    : [];
  if (!pendingGaps.length || !keys.length || keys.some((key) => !key || !gapByKey.has(key))) {
    return {
      nextConfirmation: null,
      prepared: {
        proceed: false,
        result: manualBalancePreflightError(
          '账单日期断档确认已失效，请重新导入文件',
          'BALANCE_GAP_CONFIRMATION_INVALID'
        )
      }
    };
  }
  const freshness = createFreshnessGuard({
    pendingPrompt,
    importContext,
    session,
    plan: null
  });
  freshness.assertFresh();
  return {
    nextConfirmation: null,
    prepared: {
      proceed: true,
      plan: null,
      skipBalanceGapKeys: keys,
      skippedBalanceGaps: keys.map((key) => ({ ...gapByKey.get(key) })),
      pendingPrompt,
      importContext,
      session,
      inputFilePaths: freshness.inputFilePaths,
      assertFresh: freshness.assertFresh,
      confirmedOverwrite: false,
      inputPaths: freshness.inputFilePaths,
      beforeStart: freshness.assertFresh
    }
  };
}

// 余额不一致“确认继续”、人工补录“确认替换”只能确认当前 prompt 列出的项；不写人工种子，交由 execute 登记后重算。
const BALANCE_CONFIRMATION_KINDS = Object.freeze({
  mismatch: {
    itemsField: 'mismatches',
    payloadField: 'confirmBalanceMismatchKeys',
    preparedItemsField: 'confirmedBalanceMismatches',
    invalidMessage: '余额校验确认已失效，请重新导入文件',
    errorCode: 'BALANCE_MISMATCH_CONFIRMATION_INVALID'
  },
  'seed-replace': {
    itemsField: 'replacements',
    payloadField: 'confirmBalanceSeedReplaceKeys',
    preparedItemsField: 'confirmedBalanceSeedReplacements',
    invalidMessage: '人工补录替换确认已失效，请重新导入文件',
    errorCode: 'BALANCE_SEED_REPLACE_CONFIRMATION_INVALID'
  }
});

function prepareBalanceConfirmation(reason, {
  payload,
  pendingPrompt,
  importContext,
  session,
  createFreshnessGuard
}) {
  const kind = BALANCE_CONFIRMATION_KINDS[reason];
  const pendingItems = pendingPrompt.reason === reason && Array.isArray(pendingPrompt[kind.itemsField])
    ? pendingPrompt[kind.itemsField]
    : [];
  const itemByKey = new Map(pendingItems.map((item) => [normalizeCell(item && item.key), item]));
  const keys = Array.isArray(payload[kind.payloadField])
    ? [...new Set(payload[kind.payloadField].map((key) => normalizeCell(key)))]
    : [];
  if (!pendingItems.length || !keys.length || keys.some((key) => !key || !itemByKey.has(key))) {
    return {
      nextConfirmation: null,
      prepared: {
        proceed: false,
        result: manualBalancePreflightError(kind.invalidMessage, kind.errorCode)
      }
    };
  }
  const freshness = createFreshnessGuard({
    pendingPrompt,
    importContext,
    session,
    plan: null
  });
  freshness.assertFresh();
  return {
    nextConfirmation: null,
    prepared: {
      proceed: true,
      plan: null,
      [kind.payloadField]: keys,
      [kind.preparedItemsField]: keys.map((key) => ({ ...itemByKey.get(key) })),
      pendingPrompt,
      importContext,
      session,
      inputFilePaths: freshness.inputFilePaths,
      assertFresh: freshness.assertFresh,
      confirmedOverwrite: false,
      inputPaths: freshness.inputFilePaths,
      beforeStart: freshness.assertFresh
    }
  };
}

function prepareManualBalanceSeedSubmission({
  payload = {},
  confirmation = null,
  pendingPrompt = null,
  importContext = null,
  generatedExports = {},
  storageRoot = '',
  session = null,
  createContextId,
  createFreshnessGuard
} = {}) {
  if (payload && payload.confirmOverwrite === true) {
    const contextId = normalizeCell(payload.contextId);
    if (!contextId || !confirmation || confirmation.contextId !== contextId) {
      return {
        nextConfirmation: confirmation,
        prepared: {
          proceed: false,
          result: manualBalancePreflightError(
            '余额覆盖确认上下文已失效，请重新补录',
            'BALANCE_SEED_CONFIRMATION_MISSING'
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
          result: manualBalancePreflightError(
            error && error.message ? error.message : '余额补录确认证据已变化',
            'BALANCE_SEED_CONFIRMATION_CHANGED'
          )
        }
      };
    }
    return {
      nextConfirmation: confirmation,
      prepared: {
        proceed: true,
        ...confirmation,
        confirmedOverwrite: true,
        inputPaths: confirmation.inputFilePaths,
        beforeStart: confirmation.assertFresh
      }
    };
  }

  if (!pendingPrompt || !importContext) {
    return {
      nextConfirmation: null,
      prepared: {
        proceed: false,
        result: manualBalancePreflightError(
          '当前没有待补录的余额校验任务，请重新导入文件',
          'BALANCE_SEED_CONTEXT_MISSING'
        )
      }
    };
  }

  if (payload && payload.skipBalanceGapKeys !== undefined) {
    return prepareBalanceGapSkip({
      payload,
      pendingPrompt,
      importContext,
      session,
      createFreshnessGuard
    });
  }

  for (const reason of Object.keys(BALANCE_CONFIRMATION_KINDS)) {
    if (payload && payload[BALANCE_CONFIRMATION_KINDS[reason].payloadField] !== undefined) {
      return prepareBalanceConfirmation(reason, {
        payload,
        pendingPrompt,
        importContext,
        session,
        createFreshnessGuard
      });
    }
  }

  // 余额不一致、人工补录替换的 prompt 只接受确认，不接受人工补录（spec §4 非目标）。
  if (Object.prototype.hasOwnProperty.call(BALANCE_CONFIRMATION_KINDS, pendingPrompt.reason)) {
    const kind = BALANCE_CONFIRMATION_KINDS[pendingPrompt.reason];
    return {
      nextConfirmation: null,
      prepared: {
        proceed: false,
        result: manualBalancePreflightError(
          pendingPrompt.reason === 'mismatch'
            ? '当前是余额校验不一致的确认，请核查账单或确认按账单余额生成'
            : '当前是人工补录余额替换的确认，请核查或确认替换',
          kind.errorCode
        )
      }
    };
  }

  const planResult = buildManualBalanceSeedPlan({
    payload,
    pendingPrompt,
    importContext,
    generatedExports,
    storageRoot
  });
  if (planResult.stopResult) {
    return {
      nextConfirmation: null,
      prepared: { proceed: false, result: planResult.stopResult }
    };
  }

  const plan = planResult.plan;
  const freshness = createFreshnessGuard({
    pendingPrompt,
    importContext,
    session,
    plan
  });
  freshness.assertFresh();
  const preparedPlan = {
    plan,
    pendingPrompt,
    importContext,
    session,
    inputFilePaths: freshness.inputFilePaths,
    assertFresh: freshness.assertFresh
  };
  if (plan.existingIndex >= 0) {
    const contextId = createContextId();
    const nextConfirmation = { contextId, ...preparedPlan };
    return {
      nextConfirmation,
      prepared: {
        proceed: false,
        result: {
          status: 'confirm-overwrite',
          message: '该日期的余额已存在，确认覆盖吗？',
          contextId
        }
      }
    };
  }

  return {
    nextConfirmation: null,
    prepared: {
      proceed: true,
      ...preparedPlan,
      confirmedOverwrite: false,
      inputPaths: preparedPlan.inputFilePaths,
      beforeStart: preparedPlan.assertFresh
    }
  };
}

module.exports = {
  balanceSeedRecordsEvidence,
  buildManualBalanceInvalidResult,
  buildManualBalanceSeedPlan,
  materializeManualBalanceSeedPlan,
  prepareManualBalanceSeedSubmission,
  resolveManualBalanceSeedFilePlanInputPaths,
  writeManualBalanceSeedPlan
};
