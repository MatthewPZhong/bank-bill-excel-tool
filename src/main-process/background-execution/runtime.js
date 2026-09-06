'use strict';

const os = require('node:os');
const path = require('node:path');

const {
  createExecutionPolicyRegistry,
  createStaticRegistry
} = require('./execution-policy-registry');
const { createPlatformResourceBudgets } = require('./resource-budget');
const { createResourceGovernor } = require('./resource-governor');
const { createExecutionSupervisor } = require('./supervisor');
const {
  TOOLBOX_GENERATION_ACTIONS,
  validateToolboxGenerationResult,
  validateToolboxMultiGenerationResult
} = require('../toolbox-background/generation-contract');
const {
  TOOLBOX_GENERATION_POLICIES
} = require('../toolbox-background/policies');
const {
  PRE_FUND_MPT_POLICIES,
  PRE_FUND_MPT_IMPORT_ACTION,
  PRE_FUND_MPT_REPAIR_ACTION,
  validatePreFundMptImportResult,
  validatePreFundMptRepairResult
} = require('../pre-fund-reconciliation/mpt-import/policies');
const {
  createPreFundMptTopologyPlanner
} = require('../pre-fund-reconciliation/mpt-import/topology');
const {
  validateNewAccountGenerationResult
} = require('../new-account/generation-contract');
const {
  NEW_ACCOUNT_GENERATION_POLICY,
  NEW_ACCOUNT_SAVE_AS_POLICY
} = require('../new-account/policies');
const {
  NEW_ACCOUNT_SAVE_AS_ACTION,
  runNewAccountArtifactCopyInline,
  validateNewAccountSaveAsResult
} = require('../new-account/artifact-copy');
const {
  estimateNewAccountGenerationPhaseResources
} = require('../new-account/resource-estimator');
const {
  FUND_RECON_POLICIES,
  FUND_RECON_SERVICE_KEY,
  validateFundReconExportResult,
  validateFundReconImportResult,
  validateFundReconRunResult
} = require('../fund-recon-worker/policies');
const {
  DUPLICATE_ACTIONS,
  DUPLICATE_POLICIES,
  DUPLICATE_SERVICE_KEY,
  validateDuplicateExportResult,
  validateDuplicateImportResult,
  validateDuplicateRunResult
} = require('../duplicate-inbound-match/policies');
const {
  normalizeDuplicateStartupGateDescriptor
} = require('../duplicate-inbound-match/startup-gate');
const {
  createDuplicatePairedTopologyPlanner
} = require('../duplicate-inbound-match/topology');
const {
  beginExternalParserShutdown,
  waitForExternalParserShutdownPhase
} = require('./external-parser-finalization');
const {
  RECON_FIX_EXPORT_ACTION,
  RECON_FIX_JPM_UNIT_ID,
  RECON_FIX_POLICIES,
  RECON_FIX_RUN_JPM_ACTION,
  RECON_FIX_SERVICE_KEY,
  validateReconFixExportResult,
  validateReconFixJpmResult,
  validateReconFixServiceResult
} = require('../recon-id-fix-service/policies');
const {
  createReconFixJpmDatabaseAuthority
} = require('../recon-id-fix-service/jpm-database-authority');
const {
  createReconFixEvidenceSettlementAdmission
} = require('../recon-id-fix-service/evidence-settlement-admission');
const {
  VCC_EXPORT_SINGLE_ACTION,
  VCC_EXPORT_SINGLE_POLICY,
  VCC_EXPORT_SUBJECTS_ACTION,
  VCC_EXPORT_SUBJECTS_POLICY,
  validateVccExportSingleResult,
  validateVccExportSubjectsResult
} = require('../vcc-financial-op-output/policies');
const {
  createVccExportTopologyPlanner
} = require('../vcc-financial-op-output/topology');
const {
  PENDING_READ_ONLY_ACTIONS,
  PENDING_READ_ONLY_POLICIES,
  validatePendingReadOnlyExportResult
} = require('../read-only-exports/pending/policies');
const {
  BIZ_OP_READ_ONLY_ACTION_SET,
  BIZ_OP_READ_ONLY_POLICIES,
  validateBizOpReadOnlyExportResult
} = require('../read-only-exports/biz-op/policies');
const {
  PRE_FUND_READ_ONLY_POLICIES,
  validatePreFundReadOnlyExportResult
} = require('../read-only-exports/pre-fund/policies');
const {
  POSITION_READ_ONLY_POLICY,
  validatePositionReadOnlyExportResult
} = require('../read-only-exports/position/policies');
const {
  VCC_FINANCIAL_OP_READ_ONLY_POLICY,
  validateVccFinancialOpReadOnlyExportResult
} = require('../read-only-exports/vcc-financial-op/policies');
const {
  ACQUIRING_EXPORT_ACTIONS,
  ACQUIRING_EXPORT_ACTION_SET,
  ACQUIRING_EXPORT_POLICIES,
  validateAcquiringExportResult
} = require('../read-only-exports/acquiring/policies');
const {
  runAcquiringExistingDiffCopyInline
} = require('../read-only-exports/acquiring/executor');
const {
  PENDING_BIZOP_ADAPTER_ACTION_SET,
  PENDING_BIZOP_ADAPTER_POLICIES,
  validatePendingBizOpAdapterResult
} = require('./pending-bizop-adapter-policies');
const {
  ACQUIRING_ADAPTER_ACTIONS,
  ACQUIRING_ADAPTER_ACTION_SET,
  ACQUIRING_ADAPTER_POLICIES,
  validateAcquiringImportAdapterResult,
  validateAcquiringRunAdapterResult
} = require('./acquiring-adapter-policies');
const {
  POSITION_IMPORT_ADAPTER_ACTION,
  POSITION_IMPORT_ADAPTER_POLICY,
  validatePositionImportAdapterResult
} = require('./position-import-adapter-policy');
const {
  createMatureActionAdapterBindings
} = require('./mature-action-adapters');
const { BIZ_OP_V327_POLICIES, validateBizOpCandidateResult, validateBizOpExportResult } = require('../biz-op-v327/policies');

const BACKGROUND_EXECUTION_POLICIES = Object.freeze([
  ...BIZ_OP_V327_POLICIES,
  ...TOOLBOX_GENERATION_POLICIES,
  ...PRE_FUND_MPT_POLICIES,
  NEW_ACCOUNT_GENERATION_POLICY,
  NEW_ACCOUNT_SAVE_AS_POLICY,
  ...FUND_RECON_POLICIES,
  ...DUPLICATE_POLICIES,
  ...RECON_FIX_POLICIES,
  VCC_EXPORT_SINGLE_POLICY,
  VCC_EXPORT_SUBJECTS_POLICY,
  ...PENDING_READ_ONLY_POLICIES,
  ...BIZ_OP_READ_ONLY_POLICIES,
  ...PRE_FUND_READ_ONLY_POLICIES,
  POSITION_READ_ONLY_POLICY,
  VCC_FINANCIAL_OP_READ_ONLY_POLICY,
  ...ACQUIRING_EXPORT_POLICIES,
  ...PENDING_BIZOP_ADAPTER_POLICIES,
  ...ACQUIRING_ADAPTER_POLICIES,
  POSITION_IMPORT_ADAPTER_POLICY
]);

function isBackgroundExecutionProductionEnabled(actionKey) {
  const policy = BACKGROUND_EXECUTION_POLICIES.find((item) => item.actionKey === actionKey);
  return Boolean(policy && policy.production.enabled === true);
}

function deadlineAfter(timeoutMs) {
  const timestamp = Date.now();
  return timeoutMs > Number.MAX_SAFE_INTEGER - timestamp
    ? Number.POSITIVE_INFINITY
    : timestamp + timeoutMs;
}

function remainingTimeout(deadline) {
  return deadline === Number.POSITIVE_INFINITY
    ? Number.POSITIVE_INFINITY
    : Math.max(0, deadline - Date.now());
}

function mergeShutdownReports(report, ...pairedReports) {
  return Object.freeze({
    ...report,
    leakedTransports: Object.freeze([...new Set([
      ...report.leakedTransports,
      ...pairedReports.flatMap((item) => item.leakedTransports)
    ])]),
    errors: Object.freeze([
      ...report.errors,
      ...pairedReports.flatMap((item) => item.errors)
    ])
  });
}

function entryBindingForPolicy(policy, workerRoot, duplicateStartupGate) {
  if (policy.moduleId === 'biz-op-v327') return path.resolve(__dirname, '..', 'biz-op-v327', 'worker-entry.js');
  if (policy.actionKey === NEW_ACCOUNT_SAVE_AS_ACTION) {
    return runNewAccountArtifactCopyInline;
  }
  if (policy.actionKey === ACQUIRING_EXPORT_ACTIONS.COPY) {
    return runAcquiringExistingDiffCopyInline;
  }
  if (policy.actionKey === ACQUIRING_EXPORT_ACTIONS.REGENERATE) {
    return Object.freeze({
      path: path.resolve(
        __dirname,
        '..',
        'read-only-exports',
        'acquiring',
        'worker-entry.js'
      ),
      cancellationTerminalErrorCodes: Object.freeze(['ACQUIRING_EXPORT_CANCELLED'])
    });
  }
  if (policy.moduleId === 'duplicate') {
    return Object.freeze({
      path: path.resolve(__dirname, '..', 'duplicate-inbound-match', 'worker-entry.js'),
      cancellationTerminalErrorCodes: Object.freeze(['DUPLICATE_SHUTDOWN']),
      workerData: Object.freeze({ startupGate: duplicateStartupGate })
    });
  }
  if (policy.moduleId === 'fund-recon') {
    return Object.freeze({
      path: path.resolve(__dirname, '..', 'fund-recon-worker', 'worker-entry.js'),
      cancellationTerminalErrorCodes: Object.freeze(['FUND_RECON_SHUTDOWN'])
    });
  }
  if (policy.moduleId === 'new-account') {
    return Object.freeze({
      path: path.resolve(__dirname, '..', 'new-account', 'worker-entry.js'),
      cancellationTerminalErrorCodes: Object.freeze(['NEW_ACCOUNT_GENERATION_CANCELLED'])
    });
  }
  if (policy.moduleId === 'recon-fix') {
    return Object.freeze({
      path: path.resolve(__dirname, '..', 'recon-id-fix-service', 'worker-entry.js'),
      cancellationTerminalErrorCodes: Object.freeze(['RECON_FIX_CANCELLED'])
    });
  }
  if (policy.moduleId === 'pending-read-only-export') {
    return Object.freeze({
      path: path.resolve(__dirname, '..', 'read-only-exports', 'pending', 'worker-entry.js'),
      cancellationTerminalErrorCodes: Object.freeze(['PENDING_EXPORT_CANCELLED'])
    });
  }
  if (policy.moduleId === 'biz-op-read-only-export') {
    return Object.freeze({
      path: path.resolve(__dirname, '..', 'read-only-exports', 'biz-op', 'worker-entry.js'),
      cancellationTerminalErrorCodes: Object.freeze(['BIZ_OP_EXPORT_CANCELLED'])
    });
  }
  if (policy.moduleId === 'pre-fund-read-only-export') {
    return Object.freeze({
      path: path.resolve(__dirname, '..', 'read-only-exports', 'pre-fund', 'worker-entry.js'),
      cancellationTerminalErrorCodes: Object.freeze(['PRE_FUND_EXPORT_CANCELLED'])
    });
  }
  if (policy.moduleId === 'position-read-only-export') {
    return Object.freeze({
      path: path.resolve(__dirname, '..', 'read-only-exports', 'position', 'worker-entry.js'),
      cancellationTerminalErrorCodes: Object.freeze(['POSITION_EXPORT_CANCELLED'])
    });
  }
  if (policy.moduleId === 'vcc-financial-op-read-only-export') {
    return Object.freeze({
      path: path.resolve(
        __dirname,
        '..',
        'read-only-exports',
        'vcc-financial-op',
        'worker-entry.js'
      ),
      cancellationTerminalErrorCodes: Object.freeze([
        'VCC_FINANCIAL_OP_EXPORT_CANCELLED'
      ])
    });
  }
  if (policy.actionKey === VCC_EXPORT_SUBJECTS_ACTION) {
    return Object.freeze({
      path: path.resolve(
        __dirname,
        '..',
        'vcc-financial-op-output',
        'writer-worker-entry.js'
      ),
      cancellationTerminalErrorCodes: Object.freeze(['VCC_EXPORT_CANCELLED']),
      admittedTopologyWorkerData: true
    });
  }
  if (policy.actionKey === VCC_EXPORT_SINGLE_ACTION) {
    return Object.freeze({
      path: path.resolve(
        __dirname,
        '..',
        'vcc-financial-op-output',
        'single-writer-worker-entry.js'
      ),
      cancellationTerminalErrorCodes: Object.freeze(['VCC_EXPORT_CANCELLED'])
    });
  }
  const preFund = policy.moduleId === 'pre-fund';
  return Object.freeze({
    path: path.join(
      preFund
        ? path.resolve(__dirname, '..', 'pre-fund-reconciliation', 'mpt-import')
        : workerRoot,
      preFund
        ? 'writer-worker-entry.js'
        : (policy.actionKey === TOOLBOX_GENERATION_ACTIONS.MERGE
            ? 'merge-worker-entry.js'
            : (policy.actionKey === TOOLBOX_GENERATION_ACTIONS.SPLIT_MULTI_OUTPUT
                ? 'route-scanner-worker-entry.js'
                : 'split-worker-entry.js'))
    ),
    cancellationTerminalErrorCodes: Object.freeze(preFund
      ? ['PREFUND_WRITER_CANCELLED']
      : ['TOOLBOX_GENERATION_CANCELLED'])
  });
}

function createBackgroundExecutionRuntimeInternal(options, resourceGovernorOverride = null) {
  const reconFixJpmDatabaseAuthority = options.reconFixJpmDatabasePath === undefined ||
    options.reconFixJpmDatabasePath === null
    ? null
    : createReconFixJpmDatabaseAuthority(options.reconFixJpmDatabasePath);
  const availableParallelism = options.availableParallelism === undefined
    ? (typeof os.availableParallelism === 'function'
        ? os.availableParallelism()
        : Math.max(1, os.cpus().length))
    : options.availableParallelism;
  const platformBudgets = createPlatformResourceBudgets({
    availableParallelism,
    ...(options.freeMemoryBytes === undefined ? {} : { freeMemoryBytes: options.freeMemoryBytes }),
    ...(options.totalMemoryBytes === undefined ? {} : { totalMemoryBytes: options.totalMemoryBytes }),
    ...(options.memoryHardCeilingBytes === undefined
      ? {}
      : { memoryHardCeilingBytes: options.memoryHardCeilingBytes }),
    ...(options.systemReserveBytes === undefined
      ? {}
      : { systemReserveBytes: options.systemReserveBytes })
  });
  const workerRoot = path.resolve(__dirname, '..', 'toolbox-background');
  const duplicateStartupGate = normalizeDuplicateStartupGateDescriptor(
    options.duplicateStartupGate
  );
  const matureActionBindings = createMatureActionAdapterBindings({
    acquiring: {
      userDataDir: options.userDataDir,
      mainDb: options.acquiringMainDb,
      mainDbProvider: options.acquiringMainDbProvider,
      mainDatabasePath: options.mainDatabasePath,
      onLog: options.acquiringLog
    },
    position: options.positionImport || {}
  });
  const entryRegistry = createStaticRegistry(Object.fromEntries(
    BACKGROUND_EXECUTION_POLICIES.filter((policy) => policy.entryKey !== null).map((policy) => [
      policy.entryKey,
      entryBindingForPolicy(policy, workerRoot, duplicateStartupGate)
    ])
  ));
  const adapterRegistry = createStaticRegistry(Object.fromEntries(
    [
      ...PENDING_BIZOP_ADAPTER_POLICIES,
      ...ACQUIRING_ADAPTER_POLICIES,
      POSITION_IMPORT_ADAPTER_POLICY
    ].map((policy) => [
      policy.adapterKey,
      matureActionBindings[policy.actionKey]
    ])
  ));
  const validatorEntries = {};
  for (const policy of BACKGROUND_EXECUTION_POLICIES) {
    let resultValidator;
    if (policy.moduleId === 'biz-op-v327') {
      resultValidator = policy.commit.kind === 'none' ? validateBizOpCandidateResult : validateBizOpExportResult;
    } else if (policy.actionKey === POSITION_IMPORT_ADAPTER_ACTION) {
      resultValidator = validatePositionImportAdapterResult;
    } else if (PENDING_BIZOP_ADAPTER_ACTION_SET.has(policy.actionKey)) {
      resultValidator = validatePendingBizOpAdapterResult;
    } else if (ACQUIRING_ADAPTER_ACTION_SET.has(policy.actionKey)) {
      resultValidator = policy.actionKey === ACQUIRING_ADAPTER_ACTIONS.IMPORT
        ? validateAcquiringImportAdapterResult
        : validateAcquiringRunAdapterResult;
    } else if (policy.actionKey === VCC_EXPORT_SUBJECTS_ACTION) {
      resultValidator = validateVccExportSubjectsResult;
    } else if (policy.actionKey === VCC_EXPORT_SINGLE_ACTION) {
      resultValidator = validateVccExportSingleResult;
    } else if (ACQUIRING_EXPORT_ACTION_SET.has(policy.actionKey)) {
      resultValidator = validateAcquiringExportResult;
    } else if (policy.moduleId === 'pending-read-only-export') {
      resultValidator = validatePendingReadOnlyExportResult;
    } else if (policy.moduleId === 'biz-op-read-only-export') {
      resultValidator = validateBizOpReadOnlyExportResult;
    } else if (policy.moduleId === 'pre-fund-read-only-export') {
      resultValidator = validatePreFundReadOnlyExportResult;
    } else if (policy.moduleId === 'position-read-only-export') {
      resultValidator = validatePositionReadOnlyExportResult;
    } else if (policy.moduleId === 'vcc-financial-op-read-only-export') {
      resultValidator = validateVccFinancialOpReadOnlyExportResult;
    } else if (policy.moduleId === 'recon-fix') {
      resultValidator = policy.actionKey === RECON_FIX_EXPORT_ACTION
        ? validateReconFixExportResult
        : (policy.actionKey === RECON_FIX_RUN_JPM_ACTION
            ? validateReconFixJpmResult
            : validateReconFixServiceResult);
    } else if (policy.moduleId === 'duplicate') {
      resultValidator = policy.actionKey === DUPLICATE_ACTIONS.IMPORT
        ? validateDuplicateImportResult
        : (policy.actionKey === DUPLICATE_ACTIONS.RUN
            ? validateDuplicateRunResult
            : validateDuplicateExportResult);
    } else if (policy.moduleId === 'fund-recon') {
      resultValidator = policy.actionKey === 'fund-recon:import'
        ? validateFundReconImportResult
        : (policy.actionKey === 'fund-recon:run'
            ? validateFundReconRunResult
            : validateFundReconExportResult);
    } else if (policy.moduleId === 'pre-fund') {
      resultValidator = policy.actionKey === PRE_FUND_MPT_REPAIR_ACTION
        ? validatePreFundMptRepairResult
        : validatePreFundMptImportResult;
    } else if (policy.moduleId === 'new-account') {
      resultValidator = policy.actionKey === NEW_ACCOUNT_SAVE_AS_ACTION
        ? validateNewAccountSaveAsResult
        : validateNewAccountGenerationResult;
    } else {
      resultValidator = policy.actionKey === TOOLBOX_GENERATION_ACTIONS.SPLIT_MULTI_OUTPUT
        ? validateToolboxMultiGenerationResult
        : (value) => validateToolboxGenerationResult(value, policy.actionKey);
    }
    validatorEntries[policy.result.validatorKey] = resultValidator;
    // Main explicitly executes the asynchronous technical/business validators before Publisher.
    // Registry bindings remain synchronous capability declarations for static contract coverage.
    if (policy.artifacts.technicalValidatorKey !== null) {
      validatorEntries[policy.artifacts.technicalValidatorKey] = resultValidator;
    }
    if (policy.artifacts.businessValidatorKey !== null) {
      validatorEntries[policy.artifacts.businessValidatorKey] = resultValidator;
    }
  }
  const validatorRegistry = createStaticRegistry(validatorEntries);
  const resourceProfileRegistry = createStaticRegistry({
    [NEW_ACCOUNT_GENERATION_POLICY.resources.profile]: estimateNewAccountGenerationPhaseResources
  });
  const preFundTopologyPlanner = createPreFundMptTopologyPlanner({ availableParallelism });
  const duplicateTopologyPlanner = createDuplicatePairedTopologyPlanner({ availableParallelism });
  const vccExportTopologyPlanner = createVccExportTopologyPlanner();
  const topologyRegistry = createStaticRegistry(Object.fromEntries(
    BACKGROUND_EXECUTION_POLICIES
      .filter((policy) => policy.resources.compound)
      .map((policy) => [policy.resources.compound.topologyKey,
        policy.actionKey === PRE_FUND_MPT_IMPORT_ACTION || policy.actionKey === PRE_FUND_MPT_REPAIR_ACTION
          ? preFundTopologyPlanner
          : (policy.actionKey === DUPLICATE_ACTIONS.IMPORT
              ? duplicateTopologyPlanner
              : (policy.actionKey === VCC_EXPORT_SUBJECTS_ACTION
                  ? vccExportTopologyPlanner
                  : (PENDING_BIZOP_ADAPTER_ACTION_SET.has(policy.actionKey) ||
                      ACQUIRING_ADAPTER_ACTION_SET.has(policy.actionKey) ||
                      policy.actionKey === POSITION_IMPORT_ADAPTER_ACTION
                      ? matureActionBindings[policy.actionKey].inspectTopology
                      : () => Object.freeze({ effectiveChildCount: 1 }))))])
  ));
  entryRegistry.freeze();
  adapterRegistry.freeze();
  validatorRegistry.freeze();
  resourceProfileRegistry.freeze();
  topologyRegistry.freeze();

  const staticKeys = {
    resourceProfileKeys: BACKGROUND_EXECUTION_POLICIES.map((policy) => policy.resources.profile),
    topologyKeys: BACKGROUND_EXECUTION_POLICIES
      .map((policy) => policy.resources.compound && policy.resources.compound.topologyKey)
      .filter(Boolean),
    inspectorKeys: BACKGROUND_EXECUTION_POLICIES.map((policy) => policy.commit.inspectorKey),
    conflictScopeResolverKeys: BACKGROUND_EXECUTION_POLICIES.map(
      (policy) => policy.commit.conflictScopeResolverKey
    ),
    settlementKeys: BACKGROUND_EXECUTION_POLICIES.map((policy) => policy.commit.settlementKey),
    publisherKeys: BACKGROUND_EXECUTION_POLICIES.map((policy) => policy.artifacts.publisherKey),
    serviceKeys: [FUND_RECON_SERVICE_KEY, DUPLICATE_SERVICE_KEY, RECON_FIX_SERVICE_KEY],
    plannerKeys: [
      'planner.pre-fund:mpt-import',
      'planner.duplicate:import',
      'planner.vcc-financial-op:export-subjects',
      ...[
        ...PENDING_BIZOP_ADAPTER_POLICIES,
        ...ACQUIRING_ADAPTER_POLICIES,
        POSITION_IMPORT_ADAPTER_POLICY
      ]
        .filter((policy) => policy.workUnits)
        .map((policy) => policy.workUnits.plannerKey)
    ],
    reducerKeys: [
      'reducer.pre-fund:mpt-import',
      'reducer.duplicate:import',
      'reducer.vcc-financial-op:export-subjects',
      ...[
        ...PENDING_BIZOP_ADAPTER_POLICIES,
        ...ACQUIRING_ADAPTER_POLICIES,
        POSITION_IMPORT_ADAPTER_POLICY
      ]
        .filter((policy) => policy.workUnits)
        .map((policy) => policy.workUnits.reducerKey)
    ]
  };
  const policyRegistry = createExecutionPolicyRegistry({
    policies: BACKGROUND_EXECUTION_POLICIES,
    entryRegistry,
    adapterRegistry,
    validatorRegistry,
    resourceProfileRegistry,
    topologyRegistry,
    staticKeys,
    generatedAt: '2026-08-25T00:00:00+08:00'
  });
  policyRegistry.freeze();
  // PreFund topology可以请求false-gated Pool，但不得扩大全局E00预算；
  // Governor是native admission的唯一资源权威。
  const resourceGovernor = resourceGovernorOverride || createResourceGovernor({
    budgets: platformBudgets,
    diagnostics: options.diagnostics
  });
  const supervisorShutdownTimeoutMs = options.shutdownTimeoutMs || 5000;
  const supervisor = createExecutionSupervisor({
    policyRegistry,
    resourceGovernor,
    diagnostics: options.diagnostics,
    executionTimeoutMs: options.executionTimeoutMs,
    shutdownTimeoutMs: supervisorShutdownTimeoutMs,
    workerDurableCoordinator: options.workerDurableCoordinator,
    carrierClosureActionKeys: [...new Set([...(options.carrierClosureActionKeys || []),
      ...(options.bizOpV327 ? options.bizOpV327.actionKeys : [])])],
    beforeCarrierDispatch: options.bizOpV327 || options.beforeCarrierDispatch ? function beforeCarrierDispatch(identity) {
      if (identity.actionKey.startsWith('biz-op-v327:')) {
        if (!options.bizOpV327) throw Object.assign(new Error('业务 OP 缺少 Main 运行授权'), { code: 'BIZOP_RUNTIME_AUTHORITY_REQUIRED' });
        return options.bizOpV327.beforeDispatch(identity);
      }
      if (!options.beforeCarrierDispatch) {
        throw Object.assign(new Error('关闭观察缺少该模块自己的 Main 派发绑定'), { code: 'CARRIER_DISPATCH_BINDING_REQUIRED' });
      }
      return options.beforeCarrierDispatch(identity);
    } : undefined,
    bindInputForAction({ actionKey, operationKey, input }) {
      if (actionKey.startsWith('biz-op-v327:')) {
        if (!options.bizOpV327) throw Object.assign(new Error('业务 OP 缺少 Main 输入授权'), { code: 'BIZOP_RUNTIME_AUTHORITY_REQUIRED' });
        return options.bizOpV327.bindInput({ actionKey, operationKey, input });
      }
      if ([PENDING_READ_ONLY_ACTIONS.DIFF, PENDING_READ_ONLY_ACTIONS.SUMMARY]
        .includes(actionKey)) {
        if (!options.pendingDatabasePath) {
          const error = new Error('Pending export runtime 缺少 Main database authority');
          error.code = 'PENDING_EXPORT_RUNTIME_AUTHORITY_UNAVAILABLE';
          throw error;
        }
        if (Object.hasOwn(input, 'dbPathOrManagedSource')) {
          const error = new Error('Pending export database authority 不接受 caller override');
          error.code = 'PENDING_EXPORT_RUNTIME_AUTHORITY_OVERRIDE_FORBIDDEN';
          throw error;
        }
        return Object.freeze({
          ...input,
          dbPathOrManagedSource: Object.freeze({
            kind: 'sqlite',
            databasePath: path.resolve(options.pendingDatabasePath)
          })
        });
      }
      if (BIZ_OP_READ_ONLY_ACTION_SET.has(actionKey)) {
        if (!options.mainDatabasePath || !options.userDataDir) {
          const error = new Error('BizOP export runtime 缺少 Main database/userData authority');
          error.code = 'BIZ_OP_EXPORT_RUNTIME_AUTHORITY_UNAVAILABLE';
          throw error;
        }
        if (Object.hasOwn(input, 'dbPathOrManagedSource')) {
          const error = new Error('BizOP export database authority 不接受 caller override');
          error.code = 'BIZ_OP_EXPORT_RUNTIME_AUTHORITY_OVERRIDE_FORBIDDEN';
          throw error;
        }
        return Object.freeze({
          ...input,
          dbPathOrManagedSource: Object.freeze({
            kind: 'biz-op-sqlite',
            mainDatabasePath: path.resolve(options.mainDatabasePath),
            userDataDir: path.resolve(options.userDataDir)
          })
        });
      }
      if ([VCC_EXPORT_SINGLE_ACTION, VCC_EXPORT_SUBJECTS_ACTION].includes(actionKey)) {
        if (!options.vccFinancialOpDatabasePath || !options.vccFinancialOpAssetsDir) {
          const error = new Error('VCC export runtime generation 缺少 Main database/assets authority');
          error.code = 'VCC_EXPORT_RUNTIME_AUTHORITY_UNAVAILABLE';
          throw error;
        }
        if (Object.hasOwn(input, 'databasePath') || Object.hasOwn(input, 'assetsDir')) {
          const error = new Error('VCC export database/assets authority 不接受 caller override');
          error.code = 'VCC_EXPORT_RUNTIME_AUTHORITY_OVERRIDE_FORBIDDEN';
          throw error;
        }
        return Object.freeze({
          ...input,
          databasePath: path.resolve(options.vccFinancialOpDatabasePath),
          assetsDir: path.resolve(options.vccFinancialOpAssetsDir)
        });
      }
      if (actionKey !== RECON_FIX_RUN_JPM_ACTION) return input;
      if (!reconFixJpmDatabaseAuthority) {
        const error = new Error('ReconFix JPM runtime generation 缺少 Main database authority');
        error.code = 'RECON_FIX_JPM_DATABASE_AUTHORITY_UNAVAILABLE';
        throw error;
      }
      if (Object.hasOwn(input, 'databasePath') || Object.hasOwn(input, 'databaseIdentity')) {
        const error = new Error('ReconFix JPM database authority 不接受 caller override');
        error.code = 'RECON_FIX_JPM_DATABASE_AUTHORITY_OVERRIDE_FORBIDDEN';
        throw error;
      }
      return Object.freeze({
        ...input,
        databasePath: reconFixJpmDatabaseAuthority.databasePath
      });
    },
    defaultUnitsForAction(actionKey) {
      return actionKey === RECON_FIX_RUN_JPM_ACTION
        ? Object.freeze([Object.freeze({ unitId: RECON_FIX_JPM_UNIT_ID, input: Object.freeze({}) })])
        : Object.freeze([]);
    },
    ...(options.workerThreadAdapter ? { workerThreadAdapter: options.workerThreadAdapter } : {})
  });
  const activeServiceOperations = new Map();
  const serviceOperationReservations = new Map();
  const reconFixEvidenceSettlementAdmission = createReconFixEvidenceSettlementAdmission();

  function serviceOperationError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
  }

  function serviceKeyForAction(actionKey) {
    const policy = policyRegistry.get(actionKey);
    return policy && policy.lifetime === 'service' && policy.service
      ? policy.service.serviceKey
      : null;
  }

  function enterUnreservedServiceOperation(request) {
    const serviceKey = serviceKeyForAction(request && request.actionKey);
    if (!serviceKey) return () => {};
    if (serviceOperationReservations.has(serviceKey)) {
      throw serviceOperationError(
        'SERVICE_BUSY',
        `Service operation 已被 Main settlement reservation 占用：${serviceKey}`
      );
    }
    activeServiceOperations.set(serviceKey, (activeServiceOperations.get(serviceKey) || 0) + 1);
    let released = false;
    return () => {
      if (released) return false;
      released = true;
      const next = (activeServiceOperations.get(serviceKey) || 1) - 1;
      if (next > 0) activeServiceOperations.set(serviceKey, next);
      else activeServiceOperations.delete(serviceKey);
      return true;
    };
  }

  function executeUnreserved(request) {
    const leave = enterUnreservedServiceOperation(request);
    try {
      return Promise.resolve(supervisor.execute(request)).finally(leave);
    } catch (error) {
      leave();
      throw error;
    }
  }

  function startUnreserved(request) {
    const leave = enterUnreservedServiceOperation(request);
    try {
      const control = supervisor.start(request);
      Promise.resolve(control.promise).finally(leave).catch(() => undefined);
      return control;
    } catch (error) {
      leave();
      throw error;
    }
  }

  function reserveServiceOperation(authority) {
    if (!authority || typeof authority !== 'object' || Array.isArray(authority) ||
        Object.keys(authority).sort().join(',') !== 'actionKey,operationKey' ||
        typeof authority.actionKey !== 'string' || !authority.actionKey ||
        typeof authority.operationKey !== 'string' || !authority.operationKey) {
      throw serviceOperationError(
        'SERVICE_OPERATION_RESERVATION_INVALID',
        'Service operation reservation authority 必须是 exact actionKey/operationKey'
      );
    }
    const policy = policyRegistry.get(authority.actionKey);
    const serviceKey = serviceKeyForAction(authority.actionKey);
    if (!policy || !serviceKey) {
      throw serviceOperationError(
        'SERVICE_OPERATION_RESERVATION_INVALID',
        'Service operation reservation 只接受已注册 service action'
      );
    }
    if (serviceOperationReservations.has(serviceKey) ||
        (activeServiceOperations.get(serviceKey) || 0) > 0) {
      throw serviceOperationError('SERVICE_BUSY', `Service 已有 active operation/reservation：${serviceKey}`);
    }
    const identity = Object.freeze({
      actionKey: authority.actionKey,
      operationKey: authority.operationKey,
      serviceKey
    });
    const token = Object.freeze({});
    serviceOperationReservations.set(serviceKey, token);
    let executionStarted = false;
    let executionSettled = true;
    let released = false;
    return Object.freeze({
      identity,
      execute(request) {
        if (released || serviceOperationReservations.get(serviceKey) !== token) {
          throw serviceOperationError(
            'SERVICE_OPERATION_RESERVATION_STALE',
            'Service operation reservation 已释放或失效'
          );
        }
        if (executionStarted) {
          throw serviceOperationError(
            'SERVICE_OPERATION_RESERVATION_REUSED',
            'Service operation reservation 只能执行一次'
          );
        }
        if (!request || request.actionKey !== identity.actionKey ||
            request.operationKey !== identity.operationKey) {
          throw serviceOperationError(
            'SERVICE_OPERATION_RESERVATION_IDENTITY_MISMATCH',
            'Service operation request 与 reservation identity 不一致'
          );
        }
        if (resourceGovernorOverride) assertNonProductionGovernorRequest(request);
        executionStarted = true;
        executionSettled = false;
        try {
          return Promise.resolve(supervisor.execute(request)).finally(() => {
            executionSettled = true;
          });
        } catch (error) {
          executionSettled = true;
          throw error;
        }
      },
      release() {
        if (released) return false;
        if (!executionSettled) {
          throw serviceOperationError(
            'SERVICE_OPERATION_RESERVATION_ACTIVE',
            'Service operation execution 未结算，不能提前释放 reservation'
          );
        }
        if (serviceOperationReservations.get(serviceKey) !== token) {
          throw serviceOperationError(
            'SERVICE_OPERATION_RESERVATION_STALE',
            'Service operation reservation owner 已变化'
          );
        }
        released = true;
        serviceOperationReservations.delete(serviceKey);
        return true;
      }
    });
  }
  let shutdownPromise = null;
  const runtime = Object.freeze({
    start(request) {
      if (resourceGovernorOverride) assertNonProductionGovernorRequest(request);
      return startUnreserved(request);
    },
    execute(request) {
      if (resourceGovernorOverride) assertNonProductionGovernorRequest(request);
      return executeUnreserved(request);
    },
    inspect(jobId) {
      return supervisor.inspect(jobId);
    },
    closeService(serviceKey) {
      if (serviceOperationReservations.has(serviceKey)) {
        throw serviceOperationError(
          'SERVICE_BUSY',
          `Service settlement reservation 尚未释放：${serviceKey}`
        );
      }
      return supervisor.closeService(serviceKey);
    },
    policyRegistry,
    reconFixEvidenceSettlementAdmission,
    resourceGovernor,
    reserveServiceOperation,
    shutdown(shutdownOptions = {}) {
      if (shutdownPromise) return shutdownPromise;
      const fallbackTimeoutMs = Number.isFinite(supervisorShutdownTimeoutMs) &&
        supervisorShutdownTimeoutMs >= 0
        ? supervisorShutdownTimeoutMs
        : 5000;
      let timeoutMs;
      try {
        timeoutMs = Number.isFinite(shutdownOptions.timeoutMs) && shutdownOptions.timeoutMs >= 0
          ? shutdownOptions.timeoutMs
          : fallbackTimeoutMs;
      } catch (error) {
        return Promise.reject(error);
      }
      supervisor.stopAcceptingNewJobs();
      const deadline = deadlineAfter(timeoutMs);
      const parserSession = beginExternalParserShutdown(runtime);
      shutdownPromise = Promise.resolve().then(async () => {
        const workerReport = await waitForExternalParserShutdownPhase(
          parserSession,
          'workersTerminal',
          remainingTimeout(deadline)
        );
        const supervisorReport = await supervisor.shutdown({
          ...shutdownOptions,
          timeoutMs: remainingTimeout(deadline)
        });
        const finalizationReport = await waitForExternalParserShutdownPhase(
          parserSession,
          'finalized',
          remainingTimeout(deadline)
        );
        return mergeShutdownReports(
          supervisorReport,
          Object.freeze({
            leakedTransports: Object.freeze([]),
            errors: parserSession.errors
          }),
          workerReport,
          finalizationReport
        );
      }).finally(() => {
        shutdownPromise = null;
      });
      return shutdownPromise;
    },
    stopAcceptingNewJobs() {
      supervisor.stopAcceptingNewJobs();
    }
  });
  return runtime;
}

function assertNonProductionGovernorRequest(request) {
  const descriptor = request && typeof request === 'object'
    ? Object.getOwnPropertyDescriptor(request, 'production')
    : null;
  if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.value !== true) return;
  const error = new Error('隔离ResourceGovernor不得执行production request');
  error.code = 'BACKGROUND_EXECUTION_RESOURCE_GOVERNOR_OVERRIDE_FORBIDDEN';
  throw error;
}

function createBackgroundExecutionRuntime(options = {}) {
  if (options && Object.hasOwn(options, 'resourceGovernor')) {
    throw new TypeError('resourceGovernor override只允许显式non-production runtime');
  }
  return createBackgroundExecutionRuntimeInternal(options);
}

// 仅供false-gated测试/benchmark注入隔离Governor；不从production barrel导出，
// 且production request在Supervisor/admission前拒绝。
function createNonProductionBackgroundExecutionRuntime(options = {}) {
  if (!options || !Object.hasOwn(options, 'resourceGovernor') || !options.resourceGovernor) {
    throw new TypeError('non-production runtime需要显式resourceGovernor');
  }
  const { resourceGovernor, ...runtimeOptions } = options;
  return createBackgroundExecutionRuntimeInternal(runtimeOptions, resourceGovernor);
}

function createBackgroundExecutionRuntimeManager(options = {}) {
  const runtimeFactory = options.runtimeFactory || (() => {
    const duplicateStartupGate = typeof options.duplicateStartupGateProvider === 'function'
      ? options.duplicateStartupGateProvider()
      : options.duplicateStartupGate;
    return createBackgroundExecutionRuntime({
      ...options,
      bizOpV327: typeof options.bizOpV327Provider === 'function' ? options.bizOpV327Provider() : options.bizOpV327,
      duplicateStartupGate,
      workerDurableCoordinator: typeof options.workerDurableCoordinatorProvider === 'function'
        ? options.workerDurableCoordinatorProvider()
        : options.workerDurableCoordinator,
      reconFixJpmDatabasePath: typeof options.reconFixJpmDatabasePathProvider === 'function'
        ? options.reconFixJpmDatabasePathProvider()
        : options.reconFixJpmDatabasePath,
      pendingDatabasePath: typeof options.pendingDatabasePathProvider === 'function'
        ? options.pendingDatabasePathProvider()
        : options.pendingDatabasePath,
      mainDatabasePath: typeof options.mainDatabasePathProvider === 'function'
        ? options.mainDatabasePathProvider()
        : options.mainDatabasePath,
      userDataDir: typeof options.userDataDirProvider === 'function'
        ? options.userDataDirProvider()
        : options.userDataDir
    });
  });
  let runtime = null;
  let shutdownOwner = null;
  let closing = false;
  let shutdownPromise = null;
  let shutdownReport = null;
  let shutdownOutcome = 'none';

  function isCleanShutdownReport(report) {
    return Array.isArray(report && report.leakedTransports)
      && report.leakedTransports.length === 0
      && Array.isArray(report && report.errors)
      && report.errors.length === 0;
  }

  return Object.freeze({
    get() {
      if (closing) {
        const error = new Error('后台执行 runtime 正在关闭');
        error.code = 'BACKGROUND_EXECUTION_RUNTIME_CLOSING';
        throw error;
      }
      if (!runtime) runtime = runtimeFactory();
      return runtime;
    },
    isProductionEnabled(actionKey) {
      return isBackgroundExecutionProductionEnabled(actionKey);
    },
    peek() {
      return runtime;
    },
    resume() {
      if (shutdownPromise) throw new Error('后台执行 runtime 尚未完成关闭');
      if (!closing) return;
      if (shutdownOwner || shutdownOutcome !== 'clean') {
        const error = new Error('后台执行 runtime 存在未解决的关闭失败');
        error.code = 'BACKGROUND_EXECUTION_RUNTIME_SHUTDOWN_UNRESOLVED';
        throw error;
      }
      closing = false;
      shutdownReport = null;
      shutdownOutcome = 'none';
    },
    shutdown(shutdownOptions = {}) {
      if (shutdownPromise) return shutdownPromise;
      closing = true;
      if (!shutdownOwner && runtime) {
        shutdownOwner = runtime;
        runtime = null;
        shutdownOutcome = 'unresolved';
        try {
          shutdownOwner.stopAcceptingNewJobs();
        } catch (error) {
          return Promise.reject(error);
        }
      }
      if (!shutdownOwner) {
        shutdownOutcome = 'clean';
        shutdownReport = shutdownReport || Object.freeze({
          closedServices: Object.freeze([]),
          cancelledJobs: Object.freeze([]),
          protectedJobs: Object.freeze([]),
          interruptedTasks: Object.freeze([]),
          activeHolds: Object.freeze([]),
          leakedTransports: Object.freeze([]),
          errors: Object.freeze([])
        });
        return Promise.resolve(shutdownReport);
      }
      const ownedRuntime = shutdownOwner;
      let ownedShutdown;
      try {
        ownedShutdown = ownedRuntime.shutdown(shutdownOptions);
      } catch (error) {
        shutdownOutcome = 'unresolved';
        return Promise.reject(error);
      }
      shutdownPromise = Promise.resolve(ownedShutdown)
        .then((report) => {
          shutdownReport = report;
          if (isCleanShutdownReport(report)) {
            shutdownOwner = null;
            shutdownOutcome = 'clean';
          } else {
            shutdownOutcome = 'unresolved';
          }
          return report;
        }, (error) => {
          shutdownOutcome = 'unresolved';
          throw error;
        })
        .finally(() => {
          shutdownPromise = null;
        });
      return shutdownPromise;
    },
    snapshot() {
      return Object.freeze({
        active: Boolean(runtime),
        closing,
        shutdownPending: Boolean(shutdownPromise)
      });
    }
  });
}

module.exports = {
  BACKGROUND_EXECUTION_POLICIES,
  createBackgroundExecutionRuntime,
  createBackgroundExecutionRuntimeManager,
  createNonProductionBackgroundExecutionRuntime,
  isBackgroundExecutionProductionEnabled
};
