'use strict';

const {
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
  ) || normalizeCell(importContext && importContext.template && importContext.template.name);
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
