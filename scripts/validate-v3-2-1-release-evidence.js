'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');

const {
  TOOLBOX_GENERATION_POLICIES
} = require('../src/main-process/toolbox-background/policies');
const {
  PRE_FUND_MPT_POLICIES
} = require('../src/main-process/pre-fund-reconciliation/mpt-import/policies');

const REPOSITORY_ROOT = path.resolve(__dirname, '..');
const SNAPSHOT_PATH = path.join(
  REPOSITORY_ROOT,
  'changes/background-execution-r3-2-1-release-evidence/release-evidence.json'
);
const CANONICAL_POLICY_SOURCE =
  'changes/background-execution-v3.2.x-contract-baseline/changes/background-execution/validation/' +
  'fixtures/valid/policy-registry.v3.2.x.json';
const E04_NOTES_SOURCE =
  'changes/background-execution-v3.2.x-contract-baseline/changes/3.2.1/implementation-notes.md';
const E05_BENCHMARK_SOURCE =
  'changes/background-execution-e05-c-prefund-parser-pool/benchmark-evidence.json';
const WINDOWS_BUILD_WORKFLOW_SOURCE = '.github/workflows/build-windows.yml';
const PREVIOUS_FINAL_RELEASE_BRANCH = 'codex/v3.2.1-r3-release-evidence';
const FINAL_RELEASE_BRANCH = 'codex/v3.2.1-r4-review-hardening';
const FINAL_RELEASE_BASE = 'codex/v3.2.1-r3-release-evidence';
const EXACT_BASE = '4598b9c67787ef1736831a186a199bd6fe9ae626';
const EXPECTED_CHECKOUT_REF =
  "ref: ${{ github.event_name == 'pull_request' && github.event.pull_request.head.sha || github.sha }}";
const EXPECTED_RELEASE_CHECK_CONDITION =
  "( github.event_name == 'pull_request' && " +
  `github.head_ref == '${FINAL_RELEASE_BRANCH}' && ` +
  `github.base_ref == '${FINAL_RELEASE_BASE}' && ` +
  'github.event.pull_request.head.repo.full_name == github.repository && ' +
  "github.event.action == 'opened' && github.run_attempt == 1 ) || " +
  "( (github.event_name != 'pull_request' || " +
  `github.head_ref != '${FINAL_RELEASE_BRANCH}') && ` +
  "(github.event_name != 'workflow_dispatch' || " +
  `github.ref_name != '${FINAL_RELEASE_BRANCH}') && ` +
  "(github.event_name != 'pull_request' || " +
  'github.event.pull_request.head.repo.full_name != github.repository || ' +
  "!startsWith(github.head_ref, 'codex/v3.2.1-')) )";
const EXPECTED_UNAUTHORIZED_FINAL_CONDITION =
  "( ( github.event_name == 'pull_request' && " +
  `( github.head_ref == '${PREVIOUS_FINAL_RELEASE_BRANCH}' || ` +
  `github.head_ref == '${FINAL_RELEASE_BRANCH}' ) ) || ` +
  "( github.event_name == 'workflow_dispatch' && " +
  `( github.ref_name == '${PREVIOUS_FINAL_RELEASE_BRANCH}' || ` +
  `github.ref_name == '${FINAL_RELEASE_BRANCH}' ) ) ) && ` +
  "!( github.event_name == 'pull_request' && " +
  `github.head_ref == '${FINAL_RELEASE_BRANCH}' && ` +
  `github.base_ref == '${FINAL_RELEASE_BASE}' && ` +
  'github.event.pull_request.head.repo.full_name == github.repository && ' +
  "github.event.action == 'opened' && github.run_attempt == 1 )";

const EXPECTED_EVIDENCE = Object.freeze([
  ['POLICY-CANONICAL-V3.2.X', CANONICAL_POLICY_SOURCE,
    '8ab98e4b7a7b0c669892f069881c25eaaf1f8241b1e7d71e5b63eed8b2c38a22', null],
  ['E02-D-MATURE-ADAPTERS',
    'changes/background-execution-e02-d-mature-adapters/implementation-notes.md',
    '5172caea8e2b035658c680202331279d0c5468cb57f41cd159cf9e95b29140b4',
    'a9fb43cf97a089510baa440ee020c8247d66266e'],
  ['E04-A-ONE-SHOT-WORKER', E04_NOTES_SOURCE,
    'be132fe2d901631559531d0ba44a2141bd7304f7acd4a8a49d67022c07dbfbe6',
    '89fc52dba479edb4a641f6638c5879c847ecb36d'],
  ['E04-B-SEALED-ROUTE-DB-ONE-WRITER', E04_NOTES_SOURCE,
    'be132fe2d901631559531d0ba44a2141bd7304f7acd4a8a49d67022c07dbfbe6',
    '5008eef12316910cb5c487382c18d7d191bac2b1'],
  ['E04-C-SECOND-WRITER-REJECTED', E04_NOTES_SOURCE,
    'be132fe2d901631559531d0ba44a2141bd7304f7acd4a8a49d67022c07dbfbe6',
    '3cc967d7343305b7292cf7efc1f97d14c4a6a1c1'],
  ['E05-A-PARSER-SPOOL',
    'changes/background-execution-e05-a-prefund-parser-spool/implementation-notes.md',
    '8f6e393d90612783c7690040c5c5c993a23e90fe55a8d50381ea3e22d73db89d',
    '5da07fc3b9d73a39aa7864fb42576a0583ec5500'],
  ['E05-P0-RECEIPT-LIFECYCLE',
    'changes/background-execution-e05-p0-receipt-lifecycle/implementation-notes.md',
    'f497b25c38ba8dd78470d4d84d9eaf664acca83ab019e4d8cb5612fd1a00f344',
    'aef27d36a985b13ff745b21625ae24105c6952f4'],
  ['E05-B-DURABLE-SINGLE-WRITER',
    'changes/background-execution-e05-b-prefund-single-writer/implementation-notes.md',
    'b1a29a47727df61852c0c8fbd8e9a443ff15134115c7f4848f340195ded65305',
    'ed936addb7e97960a004ce739c35695afccbf01a'],
  ['E05-C-PARSER-POOL-DOWNGRADE',
    'changes/background-execution-e05-c-prefund-parser-pool/implementation-notes.md',
    'a73055e7de74842b5ca8c9629b95eeaccb8f165d6553222232d41eeed47fd5e1',
    EXACT_BASE],
  ['E05-C-BENCHMARK-88E6D5AA', E05_BENCHMARK_SOURCE,
    '88e6d5aa340710dfd77ccb31c96b1e8629e263453ce66f957f495d06a67d3cdf',
    EXACT_BASE]
].map(([id, source, sha256, reviewedHead]) => Object.freeze({
  id,
  source,
  sha256,
  reviewedHead
})));

const TOOLBOX_GATES = Object.freeze({
  windowsPackaged: 'NOT_RUN',
  excelWps: 'PENDING_HUMAN_REVIEW',
  realProcessTermination: 'NOT_RUN',
  businessFile: 'PENDING_HUMAN_REVIEW',
  funds: 'NOT_APPLICABLE',
  recovery: 'PENDING_HUMAN_REVIEW'
});
const PRE_FUND_GATES = Object.freeze({
  windowsPackaged: 'NOT_RUN',
  excelWps: 'NOT_APPLICABLE',
  realProcessTermination: 'NOT_RUN',
  businessFile: 'PENDING_HUMAN_REVIEW',
  funds: 'PENDING_HUMAN_REVIEW',
  recovery: 'PENDING_HUMAN_REVIEW'
});

const EXPECTED_ACTION_RELEASE = Object.freeze({
  'toolbox:merge': Object.freeze({
    policyAuthority: 'native-runtime',
    live: {
      disposition: 'legacy-preserved', effectiveMode: 'legacy', effectiveWorkerCount: 0,
      path: 'legacy-main-generation'
    },
    decision: {
      kind: 'KEEP_DISABLED', enabled: false, independent: true,
      reasonCodes: ['WINDOWS_PACKAGED_NOT_RUN', 'EXCEL_WPS_REVIEW_PENDING',
        'BUSINESS_FILE_REVIEW_PENDING']
    },
    rollback: {
      strategy: 'KEEP_LEGACY_SELECTOR',
      steps: ['keep production.enabled=false', 'continue legacy Main generation',
        'preserve existing FIFO Publisher and journal recovery']
    },
    evidenceRefs: ['POLICY-CANONICAL-V3.2.X', 'E04-A-ONE-SHOT-WORKER'],
    gates: TOOLBOX_GATES
  }),
  'toolbox:split-single': Object.freeze({
    policyAuthority: 'native-runtime',
    live: {
      disposition: 'legacy-preserved', effectiveMode: 'legacy', effectiveWorkerCount: 0,
      path: 'legacy-main-generation'
    },
    decision: {
      kind: 'KEEP_DISABLED', enabled: false, independent: true,
      reasonCodes: ['WINDOWS_PACKAGED_NOT_RUN', 'EXCEL_WPS_REVIEW_PENDING',
        'BUSINESS_FILE_REVIEW_PENDING']
    },
    rollback: {
      strategy: 'KEEP_LEGACY_SELECTOR',
      steps: ['keep production.enabled=false', 'continue legacy Main generation',
        'preserve existing FIFO Publisher and journal recovery']
    },
    evidenceRefs: ['POLICY-CANONICAL-V3.2.X', 'E04-A-ONE-SHOT-WORKER'],
    gates: TOOLBOX_GATES
  }),
  'toolbox:split-multi-output': Object.freeze({
    policyAuthority: 'native-runtime',
    live: {
      disposition: 'legacy-preserved', effectiveMode: 'legacy', effectiveWorkerCount: 0,
      path: 'legacy-main-generation'
    },
    decision: {
      kind: 'KEEP_DISABLED', enabled: false, independent: true,
      reasonCodes: ['E04_C_COMBINED_GATE_FAILED',
        'LEGACY_RELATIVE_IMPROVEMENT_BELOW_15_PERCENT', 'RSS_INCREASE_UNQUALIFIED',
        'DISK_FOOTPRINT_UNQUALIFIED', 'PHASE_LEASE_MISSING', 'JOB_START_QUOTA_MISSING',
        'WINDOWS_PACKAGED_NOT_RUN', 'EXCEL_WPS_REVIEW_PENDING',
        'BUSINESS_FILE_REVIEW_PENDING']
    },
    rollback: {
      strategy: 'KEEP_LEGACY_SELECTOR',
      steps: ['keep production.enabled=false',
        'retain the one-Writer capability as non-production evidence only',
        'do not create a second Writer production path',
        'preserve existing FIFO Publisher and journal recovery']
    },
    evidenceRefs: ['POLICY-CANONICAL-V3.2.X', 'E04-B-SEALED-ROUTE-DB-ONE-WRITER',
      'E04-C-SECOND-WRITER-REJECTED'],
    gates: TOOLBOX_GATES
  }),
  'toolbox:split-large': Object.freeze({
    policyAuthority: 'canonical-inherited',
    live: {
      disposition: 'managed', effectiveMode: 'thread-single', effectiveWorkerCount: 1,
      path: 'inherited-existing-dispatch'
    },
    decision: {
      kind: 'KEEP_INHERITED_ENABLED', enabled: true, independent: true,
      reasonCodes: ['INHERITED_STATE_UNCHANGED', 'NO_WRAPPER_WORKER']
    },
    rollback: {
      strategy: 'NO_R3_2_1_CHANGE',
      steps: ['do not change the inherited selector or adapter',
        'use the existing large-split cancel and staging cleanup path',
        'leave publication to the independent toolbox:publish action']
    },
    evidenceRefs: ['POLICY-CANONICAL-V3.2.X', 'E02-D-MATURE-ADAPTERS'],
    gates: TOOLBOX_GATES
  }),
  'toolbox:publish': Object.freeze({
    policyAuthority: 'canonical-inherited',
    live: {
      disposition: 'managed', effectiveMode: 'thread-single', effectiveWorkerCount: 1,
      path: 'inherited-existing-dispatch'
    },
    decision: {
      kind: 'KEEP_INHERITED_ENABLED', enabled: true, independent: true,
      reasonCodes: ['INHERITED_STATE_UNCHANGED', 'EXISTING_DURABLE_JOURNAL_IS_AUTHORITY']
    },
    rollback: {
      strategy: 'NO_R3_2_1_CHANGE',
      steps: ['do not change the inherited selector or adapter',
        'recover only through the existing durable publication journal',
        'do not rerun generation from publication recovery']
    },
    evidenceRefs: ['POLICY-CANONICAL-V3.2.X', 'E02-D-MATURE-ADAPTERS'],
    gates: TOOLBOX_GATES
  }),
  'pre-fund:mpt-import': Object.freeze({
    policyAuthority: 'native-runtime',
    live: {
      disposition: 'legacy-preserved', effectiveMode: 'legacy', effectiveWorkerCount: 0,
      path: 'legacy-import-service'
    },
    decision: {
      kind: 'KEEP_DISABLED', enabled: false, independent: true,
      reasonCodes: ['E05_C_REPRESENTATIVE_IMPROVEMENT_0_57_PERCENT',
        'NATIVE_ADMISSION_EFFECTIVE_PARSER_COUNT_1', 'RSS_DISK_EVENT_LOOP_UNQUALIFIED',
        'WINDOWS_PACKAGED_NOT_RUN', 'REAL_PROCESS_TERMINATION_NOT_RUN',
        'FUNDS_REVIEW_PENDING', 'RECOVERY_REVIEW_PENDING']
    },
    rollback: {
      strategy: 'KEEP_LEGACY_SELECTOR_PRESERVE_DURABLE_EVIDENCE',
      steps: ['keep production.enabled=false',
        'continue the legacy import service behind the existing Recovery Hold gate',
        'preserve committed receipts and do not down-migrate or auto-rerun unknown outcomes']
    },
    evidenceRefs: ['POLICY-CANONICAL-V3.2.X', 'E05-A-PARSER-SPOOL',
      'E05-P0-RECEIPT-LIFECYCLE', 'E05-B-DURABLE-SINGLE-WRITER',
      'E05-C-PARSER-POOL-DOWNGRADE', 'E05-C-BENCHMARK-88E6D5AA'],
    gates: PRE_FUND_GATES
  }),
  'pre-fund:mpt-repair-import': Object.freeze({
    policyAuthority: 'native-runtime',
    live: {
      disposition: 'legacy-preserved', effectiveMode: 'legacy', effectiveWorkerCount: 0,
      path: 'legacy-repair-service'
    },
    decision: {
      kind: 'KEEP_DISABLED', enabled: false, independent: true,
      reasonCodes: ['REPAIR_REMAINS_EXACTLY_ONE_PARSER', 'WINDOWS_PACKAGED_NOT_RUN',
        'REAL_PROCESS_TERMINATION_NOT_RUN', 'FUNDS_REVIEW_PENDING',
        'RECOVERY_REVIEW_PENDING']
    },
    rollback: {
      strategy: 'KEEP_LEGACY_SELECTOR_PRESERVE_DURABLE_EVIDENCE',
      steps: ['keep production.enabled=false',
        'continue the legacy repair service behind the existing Recovery Hold gate',
        'preserve committed receipts and repair evidence; do not auto-rerun unknown outcomes']
    },
    evidenceRefs: ['POLICY-CANONICAL-V3.2.X', 'E05-A-PARSER-SPOOL',
      'E05-P0-RECEIPT-LIFECYCLE', 'E05-B-DURABLE-SINGLE-WRITER',
      'E05-C-PARSER-POOL-DOWNGRADE'],
    gates: PRE_FUND_GATES
  })
});

const EXPECTED_E04C = Object.freeze({
  productionImplementationAuthorized: false,
  representativeImprovementVsOneWriterPercent: 21.096,
  representativeImprovementVsLiveLegacyPercent: 8.581,
  representativeRssIncreaseVsOneWriterPercent: 31.682,
  representativeRssIncreaseVsLegacyPercent: 105.931,
  representativeDiskMultipleVsLegacy: 11.706,
  externalRawEvidenceSha256: 'f3fc31c02ef0ef5e85ab4c29ed8c1031db9d5a20b54f065a76f6ee29b10774a0'
});
const EXPECTED_E05C = Object.freeze({
  productionEligible: false,
  conclusion: 'DOWNGRADE / KEEP PRODUCTION DISABLED',
  representativeImprovementPercent: 0.57,
  smallImprovementPercent: 33.04,
  requestedParserCount: 4,
  nativeEffectiveParserCount: 1,
  smallCanSubstituteRepresentativeGate: false
});
const EXPECTED_RELEASE_CHECK = Object.freeze({
  id: 'R3.2.1-RELEASE-CHECK-C9E89DB7-FAILED',
  attemptNumber: 1,
  authority: 'lead',
  executionMode: 'LOCAL',
  reviewedHead: 'c9e89db7a700f27460a264a1c6bf4d1b7a02136f',
  status: 'FAIL',
  exitCode: 1,
  phases: {
    lint: { status: 'PASS' },
    smoke: { status: 'PASS' },
    unit: {
      status: 'FAIL',
      passed: 6166,
      total: 6171,
      failed: 2,
      skipped: 3,
      cancelled: 0
    },
    integration: {
      status: 'NOT_RUN',
      reason: 'npm && short-circuited after unit exit 1'
    }
  },
  failures: [{
    id: 'renderer-prefund-delete-range-static-contract',
    test: 'tests/unit/renderer-pre-fund-reconciliation.test.js:113',
    rootCause: 'static regex expected deleteTempByDateRange(payload) after the handler added Hold-gate normalization',
    productionSourceCorrect: true,
    remediation: 'lock the handler-local operation lock, assertDeleteDateRange(service, payload), and ' +
      'deleteTempByDateRange(normalizedRange) order',
    resolutionStatus: 'RESOLVED_TEST_CONTRACT',
    postFixTargetedStatus: 'PASS_8_OF_8'
  }, {
    id: 'windows-builder-installed-dependency-drift',
    test: 'tests/unit/windows-build-contract.test.js:181',
    rootCause: 'worktree node_modules resolved electron-builder/app-builder-lib 26.8.1 while ' +
      'package-lock requires 26.15.7',
    productionSourceCorrect: true,
    remediation: 'rebuild isolated worktree dependencies from package-lock without changing package.json or ' +
      'package-lock.json',
    resolutionStatus: 'RESOLVED_ENVIRONMENT_DRIFT',
    postFixTargetedStatus: 'PASS_5_OF_7_WITH_2_SKIPPED'
  }],
  postFixVerification: {
    status: 'COMPONENTS_PASS_LOCAL_ATTEMPT_REMAINS_FAIL',
    rendererContract: { status: 'PASS', passed: 8, total: 8, failed: 0 },
    windowsBuildContract: {
      status: 'PASS',
      exitCode: 0,
      passed: 5,
      total: 7,
      failed: 0,
      skipped: 2,
      installedElectronBuilderVersion: '26.15.7',
      installedAppBuilderLibVersion: '26.15.7',
      lockedElectronBuilderVersion: '26.15.7',
      lockedAppBuilderLibVersion: '26.15.7'
    },
    standaloneUnit: {
      status: 'PASS',
      relationship: 'POST_FAILURE_COMPONENT_NOT_RELEASE_CHECK_RERUN',
      command: 'npm run test:unit',
      reviewedHead: '634671bbe66c7d66782e528825105b7534db8971',
      exitCode: 0,
      tests: 6172,
      passed: 6169,
      failed: 0,
      skipped: 3,
      unitFiles: 377,
      log: 'logs/unit-tests/unit-20260826-122322.log',
      durationMs: 25275
    },
    standaloneIntegration: {
      status: 'PASS',
      relationship: 'POST_FAILURE_COMPONENT_NOT_RELEASE_CHECK_RERUN',
      command: 'npm run test:integration',
      exitCode: 0,
      scriptsPassed: 51,
      scriptsTotal: 51,
      assertionsPassed: 2455,
      assertionsTotal: 2455,
      durationMs: 278953,
      generatedPolicyUpdate: 'rules/integration-test-policy.md'
    }
  },
  manualRerunAllowed: false,
  workflowDispatchRerunAllowed: false,
  automaticRequiredCi: {
    attemptNumber: 3,
    status: 'PENDING_REMOTE_REQUIRED_CI',
    authorization: 'PR_OPENING_ONLY_WAIVER',
    workflowSource: WINDOWS_BUILD_WORKFLOW_SOURCE,
    trigger: 'PULL_REQUEST_OPENED_REQUIRED_CI',
    sameRepositoryOnly: true,
    runAttempt: 1,
    command: 'npm run release-check',
    branch: FINAL_RELEASE_BRANCH,
    baseRef: FINAL_RELEASE_BASE,
    headBinding: 'github.event.pull_request.head.sha',
    nonPullRequestHeadBinding: 'github.sha',
    invocationLimit: 1,
    completedInvocations: 0,
    passRequiredToCloseHardGate: true
  },
  hardGateClosed: false,
  mergeAuthorized: false,
  mainUpdateAuthorized: false,
  tagAuthorized: false,
  productionEnablementAuthorized: false
});

function parseJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function projectPolicy(policy) {
  return {
    disposition: policy.disposition,
    mode: policy.mode,
    lifetime: policy.lifetime,
    adapterKind: policy.adapterKind,
    commitKind: policy.commit.kind,
    production: structuredClone(policy.production)
  };
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function normalizeYamlCondition(source) {
  return source.split(/\r?\n/).map((line) => line.trim()).join(' ');
}

function validateReleaseEvidence(snapshot, options = {}) {
  const repositoryRoot = options.repositoryRoot || REPOSITORY_ROOT;
  const errors = [];
  const add = (at, message) => errors.push(Object.freeze({ path: at, message }));
  const expectEqual = (at, actual, expected) => {
    if (!isDeepStrictEqual(actual, expected)) add(at, 'value does not match frozen release evidence');
  };

  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    add('/', 'snapshot must be an object');
    return Object.freeze({ valid: false, errors: Object.freeze(errors) });
  }

  expectEqual('/', Object.keys(snapshot).sort(), [
    'actions', 'baseCommit', 'evidenceCatalog', 'globalDecision', 'rejectedProbeEvidence',
    'release', 'releaseCheckEvidence', 'releaseStep', 'schemaVersion', 'scope'
  ]);
  expectEqual('/schemaVersion', snapshot.schemaVersion, 1);
  expectEqual('/release', snapshot.release, '3.2.1');
  expectEqual('/releaseStep', snapshot.releaseStep, 'R3.2.1');
  expectEqual('/baseCommit', snapshot.baseCommit, EXACT_BASE);
  expectEqual('/scope', snapshot.scope, 'release-evidence-only');
  expectEqual('/globalDecision', snapshot.globalDecision, {
    newNativeProductionEnablement: 'REJECTED',
    secondWriterProductionImplementationAuthorized: false,
    policyMutationAuthorized: false,
    businessSemanticsChanged: false,
    releaseCheck: 'LOCAL_ATTEMPT_FAILED_REMOTE_REQUIRED_CI_PENDING'
  });
  expectEqual('/releaseCheckEvidence', snapshot.releaseCheckEvidence, EXPECTED_RELEASE_CHECK);

  const windowsWorkflowPath = path.join(repositoryRoot, WINDOWS_BUILD_WORKFLOW_SOURCE);
  if (!fs.existsSync(windowsWorkflowPath)) {
    add('/authority/windowsWorkflow', 'Windows build workflow is missing');
  } else {
    const workflow = fs.readFileSync(windowsWorkflowPath, 'utf8');
    const smokeStart = workflow.indexOf('\n  smoke-test:');
    const buildStart = workflow.indexOf('\n  build:');
    if (smokeStart === -1 || buildStart === -1 || smokeStart >= buildStart) {
      add('/authority/windowsWorkflow/jobs', 'smoke-test/build job boundary is missing');
    } else {
      const smokeJob = workflow.slice(smokeStart, buildStart);
      const buildJob = workflow.slice(buildStart);
      expectEqual('/authority/windowsWorkflow/smokeCheckoutRef',
        smokeJob.includes(EXPECTED_CHECKOUT_REF), true);
      expectEqual('/authority/windowsWorkflow/buildCheckoutRef',
        buildJob.includes(EXPECTED_CHECKOUT_REF), true);
      const guardStart = smokeJob.indexOf(
        '- name: Reject unauthorized v3.2.1 final-gate invocation'
      );
      const checkoutStart = smokeJob.indexOf('- name: Checkout');
      if (guardStart === -1 || checkoutStart === -1 || guardStart >= checkoutStart) {
        add('/authority/windowsWorkflow/unauthorizedFinalGuard',
          'unauthorized final-gate guard must fail before checkout');
      } else {
        const guardStep = smokeJob.slice(guardStart, checkoutStart);
        const guardConditionMatch = guardStep.match(/if: >-\s*\n([\s\S]*?)\n\s*run: \|/);
        if (!guardConditionMatch || !guardStep.includes('exit 1')) {
          add('/authority/windowsWorkflow/unauthorizedFinalGuard',
            'unauthorized final-gate condition or explicit failure is missing');
        } else {
          expectEqual('/authority/windowsWorkflow/unauthorizedFinalGuard',
            normalizeYamlCondition(guardConditionMatch[1]),
            EXPECTED_UNAUTHORIZED_FINAL_CONDITION);
        }
      }
      const releaseChecksStep = smokeJob.slice(
        smokeJob.indexOf('- name: Run release checks'),
        smokeJob.indexOf('- name: Verify Windows startup process adapter semantics')
      );
      const conditionMatch = releaseChecksStep.match(
        /if: >-\s*\n([\s\S]*?)\n\s*run: npm run release-check/
      );
      if (!conditionMatch) {
        add('/authority/windowsWorkflow/releaseCheckCondition',
          'release-check condition or command is missing');
      } else {
        expectEqual('/authority/windowsWorkflow/releaseCheckCondition',
          normalizeYamlCondition(conditionMatch[1]), EXPECTED_RELEASE_CHECK_CONDITION);
      }
    }
  }

  expectEqual('/evidenceCatalog', snapshot.evidenceCatalog, EXPECTED_EVIDENCE);
  const evidenceIds = new Set();
  if (Array.isArray(snapshot.evidenceCatalog)) {
    for (const [index, evidence] of snapshot.evidenceCatalog.entries()) {
      if (!evidence || evidenceIds.has(evidence.id)) {
        add(`/evidenceCatalog/${index}/id`, 'evidence id must be unique');
        continue;
      }
      evidenceIds.add(evidence.id);
      if (typeof evidence.source !== 'string' || path.isAbsolute(evidence.source) || evidence.source.includes('..')) {
        add(`/evidenceCatalog/${index}/source`, 'evidence source must stay repository-relative');
        continue;
      }
      const sourcePath = path.join(repositoryRoot, evidence.source);
      if (!fs.existsSync(sourcePath)) {
        add(`/evidenceCatalog/${index}/source`, 'evidence source is missing');
      } else if (sha256File(sourcePath) !== evidence.sha256) {
        add(`/evidenceCatalog/${index}/sha256`, 'evidence source hash drifted');
      }
    }
  }

  const canonical = parseJsonFile(path.join(repositoryRoot, CANONICAL_POLICY_SOURCE));
  const nativePolicies = new Map([...TOOLBOX_GENERATION_POLICIES, ...PRE_FUND_MPT_POLICIES]
    .map((policy) => [policy.actionKey, policy]));
  const expectedActionKeys = Object.keys(EXPECTED_ACTION_RELEASE);
  const actualActionKeys = Array.isArray(snapshot.actions)
    ? snapshot.actions.map((action) => action && action.actionKey)
    : [];
  expectEqual('/actions/actionKeys', actualActionKeys, expectedActionKeys);

  if (Array.isArray(snapshot.actions)) {
    snapshot.actions.forEach((action, index) => {
      const actionPath = `/actions/${index}`;
      const expected = action && EXPECTED_ACTION_RELEASE[action.actionKey];
      if (!expected) {
        add(`${actionPath}/actionKey`, 'unexpected or duplicate action');
        return;
      }
      expectEqual(actionPath, Object.keys(action).sort(), [
        'actionKey', 'currentPolicy', 'decision', 'evidenceRefs', 'gates', 'live',
        'policyAuthority', 'rollback'
      ]);
      for (const field of ['policyAuthority', 'live', 'decision', 'rollback', 'evidenceRefs', 'gates']) {
        expectEqual(`${actionPath}/${field}`, action[field], expected[field]);
      }
      const sourcePolicy = expected.policyAuthority === 'native-runtime'
        ? nativePolicies.get(action.actionKey)
        : canonical.actions[action.actionKey];
      if (!sourcePolicy) {
        add(`${actionPath}/currentPolicy`, 'authoritative policy is missing');
      } else {
        expectEqual(`${actionPath}/currentPolicy`, action.currentPolicy, projectPolicy(sourcePolicy));
      }
      if (action.decision && action.currentPolicy && action.currentPolicy.production &&
          action.decision.enabled !== action.currentPolicy.production.enabled) {
        add(`${actionPath}/decision/enabled`, 'decision must equal this action current production state');
      }
      if (Array.isArray(action.evidenceRefs)) {
        for (const evidenceRef of action.evidenceRefs) {
          if (!evidenceIds.has(evidenceRef)) {
            add(`${actionPath}/evidenceRefs`, `unknown evidence ref: ${evidenceRef}`);
          }
        }
      }
    });
  }

  expectEqual('/rejectedProbeEvidence/e04c',
    snapshot.rejectedProbeEvidence && snapshot.rejectedProbeEvidence.e04c, EXPECTED_E04C);
  expectEqual('/rejectedProbeEvidence/e05c',
    snapshot.rejectedProbeEvidence && snapshot.rejectedProbeEvidence.e05c, EXPECTED_E05C);

  const multiPolicy = nativePolicies.get('toolbox:split-multi-output');
  expectEqual('/authority/toolbox:split-multi-output/requestedMaxWorkers',
    multiPolicy && multiPolicy.workUnits.requestedMaxWorkers, 1);
  expectEqual('/authority/toolbox:split-multi-output/childrenMax',
    multiPolicy && multiPolicy.resources.compound.childrenMax, 1);
  const repairPolicy = nativePolicies.get('pre-fund:mpt-repair-import');
  expectEqual('/authority/pre-fund:mpt-repair-import/childrenMax',
    repairPolicy && repairPolicy.resources.compound.childrenMax, 1);

  const e04Notes = fs.readFileSync(path.join(repositoryRoot, E04_NOTES_SOURCE), 'utf8');
  for (const evidenceText of ['21.096%', '8.581%', '31.682%', '105.931%', '11.706×',
    EXPECTED_E04C.externalRawEvidenceSha256, 'productionImplementationAuthorized=false']) {
    if (!e04Notes.includes(evidenceText)) {
      add('/rejectedProbeEvidence/e04c', `E04-C source no longer contains ${evidenceText}`);
    }
  }

  const benchmark = parseJsonFile(path.join(repositoryRoot, E05_BENCHMARK_SOURCE));
  expectEqual('/benchmark/gate/productionEligible', benchmark.gate.productionEligible, false);
  expectEqual('/benchmark/gate/conclusion', benchmark.gate.conclusion, EXPECTED_E05C.conclusion);
  expectEqual('/benchmark/representative/improvementPercent',
    benchmark.cases.representative.summary.improvementPercent, 0.57);
  expectEqual('/benchmark/small/improvementPercent', benchmark.cases.small.summary.improvementPercent, 33.04);
  expectEqual('/benchmark/representative/qualified',
    benchmark.gate.checks.representativePerformance.qualified, false);
  expectEqual('/benchmark/small/qualified', benchmark.gate.checks.smallRegression.qualified, true);
  expectEqual('/benchmark/nativeResourceAdmission/status',
    benchmark.gate.checks.nativeResourceAdmission.status, 'canonical-e00-effective-parser-count-1');
  expectEqual('/benchmark/windowsPackaged/status', benchmark.gate.checks.windowsPackaged.status, 'not-run');
  expectEqual('/benchmark/fundsManualReview/status', benchmark.gate.checks.fundsManualReview.status, 'not-run');

  return Object.freeze({
    valid: errors.length === 0,
    errors: Object.freeze(errors),
    actionCount: actualActionKeys.length
  });
}

function runCli() {
  const snapshot = parseJsonFile(SNAPSHOT_PATH);
  const result = validateReleaseEvidence(snapshot);
  if (!result.valid) {
    process.stderr.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`${JSON.stringify({
    status: 'PASS',
    release: snapshot.release,
    baseCommit: snapshot.baseCommit,
    actionCount: result.actionCount,
    nativeProductionEnabledCount: snapshot.actions.filter((action) =>
      action.policyAuthority === 'native-runtime' && action.decision.enabled).length,
    inheritedProductionStateChanges: 0,
    releaseCheckStatus: snapshot.releaseCheckEvidence.automaticRequiredCi.status,
    releaseCheckLocalAttemptStatus: snapshot.releaseCheckEvidence.status,
    releaseCheckManualRerunAllowed: snapshot.releaseCheckEvidence.manualRerunAllowed,
    releaseCheckAutomaticCiInvocationLimit: snapshot.releaseCheckEvidence.automaticRequiredCi.invocationLimit,
    releaseCheckHardGateClosed: snapshot.releaseCheckEvidence.hardGateClosed
  })}\n`);
}

if (require.main === module) runCli();

module.exports = {
  SNAPSHOT_PATH,
  validateReleaseEvidence
};
