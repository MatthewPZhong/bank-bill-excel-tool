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

function writeManualBalanceSeedPlan(plan, now = new Date()) {
  if (!plan || !Array.isArray(plan.records) || !plan.record) {
    throw new TypeError('余额种子写入计划缺失');
  }
  const record = {
    ...plan.record,
    updatedAt: now.toISOString()
  };
  const records = plan.records.map((item) => ({ ...item }));
  if (plan.existingIndex >= 0) {
    records[plan.existingIndex] = record;
  } else {
    records.push(record);
  }
  return {
    status: 'success',
    filePath: writeBalanceSeedRecords(plan.storageRoot, plan.bankName, records),
    record
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
  prepareManualBalanceSeedSubmission,
  resolveManualBalanceSeedFilePlanInputPaths,
  writeManualBalanceSeedPlan
};
