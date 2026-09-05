'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const REPOSITORY_ROOT = path.resolve(__dirname, '..');
const RELEASE = '3.2.5';
const EVIDENCE_DATE = '2026-08-31';
const EXACT_BASE = '7f9644922fde2f521c8e09fb3f856046ff9a3f1d';
const EVIDENCE_DIRECTORY = 'changes/background-execution-r3-2-5-release-evidence';
const SNAPSHOT_RELATIVE_PATH = `${EVIDENCE_DIRECTORY}/release-evidence.json`;
const SNAPSHOT_PATH = path.join(REPOSITORY_ROOT, SNAPSHOT_RELATIVE_PATH);
const PACKAGE_ROOT_RELATIVE_PATH = 'changes/background-execution-v3.2.x-contract-baseline';

const AUTHORITY_PATHS = Object.freeze({
  actionManifest: 'changes/3.2.5/e13-g-action-manifest.json',
  capabilityInventory: 'changes/3.2.5/e13-g-capability-inventory.json',
  productionStrategy: 'changes/3.2.5/e13-g-production-strategy-snapshot.json',
  coverageReport: 'changes/3.2.5/e13-g-coverage-report.json',
  contractValidation: 'changes/background-execution-v3.2.x-contract-baseline/validation-report.json',
  packageChecksums: 'changes/background-execution-v3.2.x-contract-baseline/PACKAGE-SHA256SUMS.txt'
});

const HISTORICAL_RELEASES = Object.freeze([
  ['R3.2.1', 'changes/background-execution-r3-2-1-release-evidence/release-evidence.json'],
  ['R3.2.2', 'changes/background-execution-r3-2-2-release-evidence/release-evidence.json'],
  ['R3.2.3', 'changes/background-execution-r3-2-3-release-evidence/release-evidence.json'],
  ['R3.2.4', 'changes/background-execution-r3-2-4-release-evidence/release-evidence.json']
]);

const WORK_ITEM_ACTIONS = Object.freeze({
  'E13-A': Object.freeze([
    'pending:export-diff',
    'pending:export-summary',
    'pending:export-errors',
    'biz-op:export-day',
    'biz-op:export-range'
  ]),
  'E13-B': Object.freeze([
    'pre-fund:export-channel',
    'pre-fund:export-audit',
    'position:export-run',
    'vcc-financial-op:export-audit'
  ]),
  'E13-C': Object.freeze([
    'acquiring:copy-existing-diff',
    'acquiring:export-diff-workbook'
  ]),
  'E13-D': Object.freeze([
    'pending:import',
    'biz-op:import-flow'
  ]),
  'E13-E': Object.freeze([
    'acquiring:import',
    'acquiring:run-new-eligible',
    'acquiring:run-single-or-resume'
  ]),
  'E13-F': Object.freeze([
    'position:import'
  ]),
  'LEGACY-BASELINE': Object.freeze([
    'pre-fund:bank-import',
    'pre-fund:run',
    'vcc-op:compute-amounts',
    'vcc-op:save-run',
    'vcc-op:scan-and-compute'
  ]),
  'PLATFORM-CANARY': Object.freeze([
    'background-execution:canary',
    'background-execution:pure-compute-canary'
  ])
});

const WORK_ITEM_REFS = Object.freeze({
  'E13-A': Object.freeze([
    'changes/3.2.5/e13-a-implementation-notes.md',
    'tests/unit/main-process/pending-read-only-export-e13-a.test.js',
    'tests/unit/main-process/biz-op-read-only-export-e13-a.test.js',
    'tests/unit/main-process/read-only-export-main-settlement-e13-a.test.js'
  ]),
  'E13-B': Object.freeze([
    'changes/3.2.5/implementation-notes.md',
    'tests/unit/main-process/pre-fund-read-only-export-e13-b.test.js',
    'tests/unit/main-process/position-read-only-export-e13-b.test.js',
    'tests/unit/main-process/vcc-financial-op-read-only-export-e13-b.test.js'
  ]),
  'E13-C': Object.freeze([
    'changes/3.2.5/e13-c-implementation-notes.md',
    'tests/unit/main-process/acquiring-read-only-export-e13-c.test.js'
  ]),
  'E13-D': Object.freeze([
    'changes/3.2.5/e13-d-implementation-notes.md',
    'tests/unit/main-process/background-execution/pending-bizop-adapters-e13-d.test.js'
  ]),
  'E13-E': Object.freeze([
    'changes/3.2.5/e13-e-implementation-notes.md',
    'tests/unit/main-process/background-execution/acquiring-adapters-e13-e.test.js'
  ]),
  'E13-F': Object.freeze([
    'changes/3.2.5/e13-f-implementation-notes.md',
    'tests/unit/main-process/background-execution/position-import-adapter-e13-f.test.js'
  ]),
  'LEGACY-BASELINE': Object.freeze([
    'changes/background-execution-v3.2.x-contract-baseline/changes/background-execution/validation/fixtures/valid/action-manifest.v3.2.x.json',
    'changes/3.2.5/e13-g-implementation-notes.md'
  ]),
  'PLATFORM-CANARY': Object.freeze([
    'changes/background-execution-v3.2.x-contract-baseline/changes/background-execution/platform-contract-v1.md',
    'changes/3.2.5/e13-g-implementation-notes.md'
  ])
});

const GLOBAL_EVIDENCE_REFS = Object.freeze([
  AUTHORITY_PATHS.actionManifest,
  AUTHORITY_PATHS.capabilityInventory,
  AUTHORITY_PATHS.productionStrategy,
  AUTHORITY_PATHS.coverageReport
]);

function absolute(relativePath) {
  return path.join(REPOSITORY_ROOT, relativePath);
}

function readText(relativePath) {
  return fs.readFileSync(absolute(relativePath), 'utf8').replace(/\r\n?/g, '\n');
}

function readJson(relativePath) {
  return JSON.parse(readText(relativePath));
}

function sha256(relativePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(absolute(relativePath))).digest('hex');
}

class PackageChecksumError extends Error {
  constructor(code, detail) {
    super(`${code}: ${detail}`);
    this.name = 'PackageChecksumError';
    this.code = code;
    this.detail = detail;
  }
}

function failPackageChecksum(code, detail) {
  throw new PackageChecksumError(code, detail);
}

function compareCanonicalPaths(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function packageChecksumContext(options = {}) {
  const packageRoot = path.resolve(
    options.packageRoot || absolute(PACKAGE_ROOT_RELATIVE_PATH)
  );
  const checksumPath = path.resolve(
    options.checksumPath || absolute(AUTHORITY_PATHS.packageChecksums)
  );
  const checksumRelativePath = path.relative(packageRoot, checksumPath).split(path.sep).join('/');
  if (
    checksumRelativePath === '' ||
    checksumRelativePath === '..' ||
    checksumRelativePath.startsWith('../') ||
    path.posix.isAbsolute(checksumRelativePath)
  ) {
    failPackageChecksum(
      'PACKAGE_CHECKSUM_PATH_OUTSIDE_ROOT',
      `${checksumPath} is outside ${packageRoot}`
    );
  }
  return { packageRoot, checksumPath, checksumRelativePath };
}

function collectPackageFiles(packageRoot, checksumRelativePath) {
  const files = [];

  function visit(directory, prefix = '') {
    const entries = fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => compareCanonicalPaths(left.name, right.name));
    for (const entry of entries) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolutePath, relativePath);
      } else if (entry.isFile()) {
        if (relativePath !== checksumRelativePath) files.push(relativePath);
      } else {
        failPackageChecksum(
          'PACKAGE_ENTRY_UNSUPPORTED',
          `${relativePath} is not a regular file or directory`
        );
      }
    }
  }

  visit(packageRoot);
  return files.sort(compareCanonicalPaths);
}

function generatePackageChecksumContent(options = {}) {
  const { packageRoot, checksumRelativePath } = packageChecksumContext(options);
  return collectPackageFiles(packageRoot, checksumRelativePath)
    .map((relativePath) => {
      const digest = crypto.createHash('sha256')
        .update(fs.readFileSync(path.join(packageRoot, ...relativePath.split('/'))))
        .digest('hex');
      return `${digest}  ./${relativePath}`;
    })
    .join('\n') + '\n';
}

function verifyPackageChecksums(options = {}) {
  const { packageRoot, checksumPath, checksumRelativePath } = packageChecksumContext(options);
  const content = fs.readFileSync(checksumPath, 'utf8');
  if (content.includes('\r') || !content.endsWith('\n')) {
    failPackageChecksum(
      'PACKAGE_CHECKSUM_FORMAT_INVALID',
      'checksum file must use LF line endings and end with exactly one newline'
    );
  }
  const lines = content.slice(0, -1).split('\n');
  if (lines.length === 0 || lines.some((line) => line.length === 0)) {
    failPackageChecksum('PACKAGE_CHECKSUM_FORMAT_INVALID', 'blank checksum entry');
  }

  const entries = [];
  const seen = new Set();
  for (const [index, line] of lines.entries()) {
    const match = /^([0-9a-f]{64})  \.\/(.+)$/.exec(line);
    if (!match) {
      failPackageChecksum(
        'PACKAGE_CHECKSUM_FORMAT_INVALID',
        `line ${index + 1} is not canonical SHA-256 syntax`
      );
    }
    const relativePath = match[2];
    if (
      relativePath.includes('\\') ||
      relativePath === '.' ||
      relativePath.startsWith('/') ||
      relativePath.startsWith('../') ||
      path.posix.normalize(relativePath) !== relativePath
    ) {
      failPackageChecksum(
        'PACKAGE_CHECKSUM_PATH_INVALID',
        `line ${index + 1} contains unsafe or non-canonical path ${relativePath}`
      );
    }
    if (seen.has(relativePath)) {
      failPackageChecksum('PACKAGE_CHECKSUM_ENTRY_DUPLICATE', relativePath);
    }
    seen.add(relativePath);
    entries.push({ digest: match[1], relativePath });
  }

  const listedPaths = entries.map((entry) => entry.relativePath);
  const sortedListedPaths = [...listedPaths].sort(compareCanonicalPaths);
  if (listedPaths.some((relativePath, index) => relativePath !== sortedListedPaths[index])) {
    failPackageChecksum(
      'PACKAGE_CHECKSUM_ORDER_INVALID',
      'entries must use deterministic ascending path order'
    );
  }

  const actualPaths = collectPackageFiles(packageRoot, checksumRelativePath);
  const actualSet = new Set(actualPaths);
  for (const relativePath of listedPaths) {
    if (!actualSet.has(relativePath)) {
      failPackageChecksum('PACKAGE_CHECKSUM_ENTRY_UNEXPECTED', relativePath);
    }
  }
  for (const relativePath of actualPaths) {
    if (!seen.has(relativePath)) {
      failPackageChecksum('PACKAGE_CHECKSUM_ENTRY_MISSING', relativePath);
    }
  }

  for (const entry of entries) {
    const actualDigest = crypto.createHash('sha256')
      .update(fs.readFileSync(path.join(packageRoot, ...entry.relativePath.split('/'))))
      .digest('hex');
    if (actualDigest !== entry.digest) {
      failPackageChecksum(
        'PACKAGE_CHECKSUM_HASH_MISMATCH',
        `${entry.relativePath}: expected ${entry.digest}, got ${actualDigest}`
      );
    }
  }

  return {
    status: 'PASS',
    passed: entries.length,
    total: actualPaths.length
  };
}

function writePackageChecksums(options = {}) {
  const { checksumPath } = packageChecksumContext(options);
  fs.writeFileSync(checksumPath, generatePackageChecksumContent(options));
}

function indexByAction(actions, label) {
  const index = new Map();
  for (const action of actions || []) {
    if (!action || typeof action.actionKey !== 'string' || index.has(action.actionKey)) {
      throw new Error(`${label} contains an invalid or duplicate actionKey`);
    }
    index.set(action.actionKey, action);
  }
  return index;
}

function buildAssignmentIndex() {
  const assignments = new Map();
  for (const [workItem, actionKeys] of Object.entries(WORK_ITEM_ACTIONS)) {
    for (const actionKey of actionKeys) {
      if (assignments.has(actionKey)) throw new Error(`duplicate assignment for ${actionKey}`);
      assignments.set(actionKey, {
        evidenceKind: workItem === 'LEGACY-BASELINE'
          ? 'legacy-unchanged'
          : workItem === 'PLATFORM-CANARY'
            ? 'platform-canary'
            : 'v3.2.5-implementation',
        workItem,
        evidenceRefs: WORK_ITEM_REFS[workItem]
      });
    }
  }
  for (const [workItem, relativePath] of HISTORICAL_RELEASES) {
    for (const action of readJson(relativePath).actions || []) {
      if (assignments.has(action.actionKey)) {
        throw new Error(`historical assignment collides for ${action.actionKey}`);
      }
      assignments.set(action.actionKey, {
        evidenceKind: 'historical-release-evidence',
        workItem,
        evidenceRefs: [relativePath]
      });
    }
  }
  return assignments;
}

function comparisonStatus(assignment) {
  if (assignment.evidenceKind === 'v3.2.5-implementation') return 'LOCAL_AUTOMATED_PASS';
  if (assignment.evidenceKind === 'historical-release-evidence') return 'HISTORICAL_RELEASE_EVIDENCE';
  if (assignment.evidenceKind === 'legacy-unchanged') return 'LEGACY_UNCHANGED';
  return 'NOT_APPLICABLE_PLATFORM_CANARY';
}

function buildActionEvidence(manifest, capability, strategy, assignment) {
  const comparison = comparisonStatus(assignment);
  const hasWorkbook = capability.artifactKind === 'single' || capability.artifactKind === 'all-or-none';
  const legacyOnly = capability.capabilityStatus === 'legacy-only';
  const platformCanary = capability.capabilityStatus === 'platform-canary';
  const workbookStatus = platformCanary
    ? 'NOT_APPLICABLE_PLATFORM_CANARY'
    : legacyOnly
      ? 'LEGACY_UNCHANGED'
      : hasWorkbook
        ? comparison
        : 'NOT_APPLICABLE_NO_WORKBOOK';
  const evidenceRefs = [...new Set([...assignment.evidenceRefs, ...GLOBAL_EVIDENCE_REFS])];

  return {
    actionKey: capability.actionKey,
    baselineFixtureId: `${assignment.workItem}:${capability.actionKey}`,
    evidenceKind: assignment.evidenceKind,
    workItem: assignment.workItem,
    capability: {
      status: capability.capabilityStatus,
      disposition: capability.disposition,
      mode: capability.capabilityMode,
      adapterKind: capability.adapterKind,
      commitKind: capability.commitKind,
      artifactKind: capability.artifactKind,
      runtimeRegistered: capability.runtimeRegistered,
      handlerRoute: capability.handlerRoute
    },
    effectiveStrategy: {
      mode: strategy.effectiveMode,
      workerCount: strategy.effectiveWorkerCount,
      featureFlag: strategy.featureFlag,
      downgradeReason: strategy.downgradeReason,
      recoveryStatus: strategy.recoveryStatus,
      legacyAvailable: strategy.legacyAvailable
    },
    semanticComparison: {
      status: comparison,
      authority: 'ACTION_SPECIFIC_EVIDENCE_REFS'
    },
    dbReadEvidence: {
      status: platformCanary
        ? 'NOT_APPLICABLE_PLATFORM_CANARY'
        : legacyOnly
          ? 'LEGACY_UNCHANGED'
          : comparison,
      sourceAuthority: manifest.capabilityStatus
    },
    workbookComparison: {
      status: workbookStatus,
      artifactKind: capability.artifactKind
    },
    faultInjection: {
      status: platformCanary
        ? 'NOT_APPLICABLE_PLATFORM_CANARY'
        : legacyOnly
          ? 'NOT_APPLICABLE_NO_NEW_CAPABILITY'
          : comparison
    },
    resourceMetrics: {
      status: platformCanary
        ? 'BLOCKED_CANARY'
        : legacyOnly
          ? 'LEGACY_NO_MANAGED_RESOURCE'
          : assignment.evidenceKind === 'historical-release-evidence'
            ? 'HISTORICAL_RELEASE_EVIDENCE'
            : 'LOCAL_POLICY_TOPOLOGY_PASS',
      profile: capability.resourceProfile
    },
    externalGates: {
      windowsPackaged: 'NOT_RUN',
      realBusinessSamples: 'PENDING_HUMAN_REVIEW',
      excelWps: hasWorkbook ? 'NOT_RUN' : 'NOT_APPLICABLE',
      rssObservation: capability.runtimeRegistered ? 'NOT_RUN' : 'NOT_APPLICABLE',
      stabilityWindow: 'NOT_STARTED',
      funds: 'PENDING_HUMAN_REVIEW',
      recovery: 'PENDING_HUMAN_REVIEW'
    },
    productionDecision: {
      kind: 'KEEP_LEGACY',
      enabled: false,
      reasonCodes: [
        'WINDOWS_PACKAGED_NOT_RUN',
        'REAL_BUSINESS_SAMPLE_REVIEW_PENDING',
        'FUNDS_REVIEW_PENDING',
        'RECOVERY_REVIEW_PENDING',
        'STABILITY_WINDOW_NOT_STARTED'
      ]
    },
    evidenceRefs
  };
}

function buildExpectedReleaseEvidence() {
  const manifest = readJson(AUTHORITY_PATHS.actionManifest);
  const inventory = readJson(AUTHORITY_PATHS.capabilityInventory);
  const strategy = readJson(AUTHORITY_PATHS.productionStrategy);
  const coverage = readJson(AUTHORITY_PATHS.coverageReport);
  const contractValidation = readJson(AUTHORITY_PATHS.contractValidation);
  const packageChecksums = verifyPackageChecksums();
  const manifestIndex = indexByAction(manifest.actions, 'action manifest');
  const inventoryIndex = indexByAction(inventory.actions, 'capability inventory');
  const strategyIndex = indexByAction(strategy.actions, 'production strategy');
  const assignments = buildAssignmentIndex();
  const actionKeys = [...inventoryIndex.keys()].sort();

  if (actionKeys.length !== 54 || manifestIndex.size !== 54 || strategyIndex.size !== 54) {
    throw new Error('R3.2.5 requires exact 54-action authorities');
  }
  if (assignments.size !== 54) throw new Error(`expected 54 evidence assignments, got ${assignments.size}`);
  for (const actionKey of actionKeys) {
    if (!manifestIndex.has(actionKey) || !strategyIndex.has(actionKey) || !assignments.has(actionKey)) {
      throw new Error(`missing authority or evidence assignment for ${actionKey}`);
    }
  }

  const actions = actionKeys.map((actionKey) => buildActionEvidence(
    manifestIndex.get(actionKey),
    inventoryIndex.get(actionKey),
    strategyIndex.get(actionKey),
    assignments.get(actionKey)
  ));

  return {
    schemaVersion: 1,
    release: RELEASE,
    evidenceDate: EVIDENCE_DATE,
    exactBase: EXACT_BASE,
    packageVersion: RELEASE,
    authority: {
      actionManifest: {
        path: AUTHORITY_PATHS.actionManifest,
        sha256: sha256(AUTHORITY_PATHS.actionManifest),
        actionCount: manifest.counts.actionCount,
        legacyPairCount: manifest.counts.legacyPairCount,
        runtimePolicyCount: manifest.counts.runtimePolicyCount,
        legacyOnlyCount: manifest.counts.legacyOnlyCount,
        platformCanaryCount: manifest.counts.platformCanaryCount
      },
      capabilityInventory: {
        path: AUTHORITY_PATHS.capabilityInventory,
        sha256: sha256(AUTHORITY_PATHS.capabilityInventory),
        actionCount: inventory.counts.actionCount,
        implementedCount: inventory.counts.implementedCount,
        legacyOnlyCount: inventory.counts.legacyOnlyCount,
        platformCanaryCount: inventory.counts.platformCanaryCount
      },
      productionStrategy: {
        path: AUTHORITY_PATHS.productionStrategy,
        sha256: sha256(AUTHORITY_PATHS.productionStrategy),
        actionCount: strategy.counts.actionCount,
        productionEnabledCount: strategy.counts.productionEnabledCount,
        legacyEffectiveCount: strategy.counts.legacyEffectiveCount
      },
      coverage: {
        path: AUTHORITY_PATHS.coverageReport,
        sha256: sha256(AUTHORITY_PATHS.coverageReport),
        coveredActionSurfaceCount: coverage.coverage.coveredActionSurfaceCount,
        expectedActionSurfaceCount: coverage.coverage.expectedActionSurfaceCount,
        coveragePercent: coverage.coverage.coveragePercent,
        productionEnablementAllowed: coverage.productionEnablementAllowed,
        humanRedlineReviewStatus: coverage.humanRedlineReviewStatus
      }
    },
    validationEvidence: {
      contractPackage: {
        path: AUTHORITY_PATHS.contractValidation,
        status: contractValidation.status,
        passed: contractValidation.summary.passed,
        total: contractValidation.summary.checkCount,
        inputCount: contractValidation.summary.validationReadInputCount
      },
      packageChecksums: {
        path: AUTHORITY_PATHS.packageChecksums,
        status: packageChecksums.status,
        passed: packageChecksums.passed,
        total: packageChecksums.total
      },
      localTests: {
        e13GBase: {
          targeted: '27/27 PASS',
          unit: '6857/6860 PASS; 0 FAIL; 3 SKIP',
          integration: '53 scripts; 2488/2488 PASS',
          smoke: 'PASS'
        },
        r3Closeout: {
          lint: 'PASS',
          targeted: '118/118 PASS',
          unit: '6887/6890 PASS; 0 FAIL; 3 SKIP',
          integration: '53 scripts; 2488/2488 PASS',
          smoke: 'PASS'
        }
      },
      externalAndHuman: {
        windowsPackaged: 'NOT_RUN',
        realBusinessSamples: 'PENDING_HUMAN_REVIEW',
        excelWps: 'NOT_RUN',
        rssObservation: 'NOT_RUN',
        stabilityWindow: 'NOT_STARTED',
        funds: 'PENDING_HUMAN_REVIEW',
        recovery: 'PENDING_HUMAN_REVIEW'
      },
      explicitlySkippedByUserInstruction: {
        releaseCheck: 'SKIPPED_USER_INSTRUCTION',
        checkVars: 'SKIPPED_USER_INSTRUCTION',
        scanVars: 'SKIPPED_USER_INSTRUCTION'
      }
    },
    globalDecision: {
      kind: 'MERGE_DORMANT_CAPABILITY_KEEP_LEGACY',
      productionEnabledCount: 0,
      legacyEffectiveCount: 54,
      legacySeamPreserved: true,
      mainMergeAuthorized: false,
      tagCreationAuthorized: false,
      productionPublishAuthorized: false
    },
    actions
  };
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function addError(errors, code, pathValue, detail) {
  errors.push({ code, path: pathValue, detail });
}

function releaseSection(document, heading) {
  const start = document.indexOf(heading);
  if (start === -1) return '';
  const next = document.indexOf('\n## ', start + heading.length);
  return document.slice(start, next === -1 ? document.length : next);
}

function validateReleaseEvidence(candidate, options = {}) {
  const errors = [];
  let expected;
  try {
    expected = buildExpectedReleaseEvidence();
  } catch (error) {
    addError(
      errors,
      error instanceof PackageChecksumError ? 'PACKAGE_CHECKSUM_INVALID' : 'AUTHORITY_BUILD_FAILED',
      error instanceof PackageChecksumError ? '/validationEvidence/packageChecksums' : '/authority',
      error.message
    );
    return { valid: false, errors, facts: {} };
  }

  if (JSON.stringify(candidate) !== JSON.stringify(expected)) {
    addError(errors, 'RELEASE_EVIDENCE_MISMATCH', '/release-evidence', 'candidate differs from deterministic authority model');
  }

  const actionKeys = new Set();
  const fixtureIds = new Set();
  for (const [index, action] of (candidate.actions || []).entries()) {
    const prefix = `/actions/${index}`;
    if (actionKeys.has(action.actionKey)) addError(errors, 'ACTION_DUPLICATE', `${prefix}/actionKey`, action.actionKey);
    actionKeys.add(action.actionKey);
    if (fixtureIds.has(action.baselineFixtureId)) addError(errors, 'FIXTURE_DUPLICATE', `${prefix}/baselineFixtureId`, action.baselineFixtureId);
    fixtureIds.add(action.baselineFixtureId);
    if (action.effectiveStrategy?.mode !== 'legacy' || action.effectiveStrategy?.workerCount !== 0 || action.effectiveStrategy?.featureFlag !== false) {
      addError(errors, 'EFFECTIVE_STRATEGY_UNSAFE', `${prefix}/effectiveStrategy`, action.actionKey);
    }
    if (action.productionDecision?.enabled !== false || action.productionDecision?.kind !== 'KEEP_LEGACY') {
      addError(errors, 'PRODUCTION_DECISION_UNSAFE', `${prefix}/productionDecision`, action.actionKey);
    }
    if (action.externalGates?.windowsPackaged !== 'NOT_RUN') {
      addError(errors, 'WINDOWS_GATE_FORGED', `${prefix}/externalGates/windowsPackaged`, action.actionKey);
    }
    if (action.externalGates?.funds !== 'PENDING_HUMAN_REVIEW' || action.externalGates?.recovery !== 'PENDING_HUMAN_REVIEW') {
      addError(errors, 'HUMAN_GATE_FORGED', `${prefix}/externalGates`, action.actionKey);
    }
    if (action.externalGates?.stabilityWindow !== 'NOT_STARTED') {
      addError(errors, 'OBSERVATION_GATE_FORGED', `${prefix}/externalGates/stabilityWindow`, action.actionKey);
    }
    for (const [refIndex, relativePath] of (action.evidenceRefs || []).entries()) {
      if (!fs.existsSync(absolute(relativePath))) {
        addError(errors, 'EVIDENCE_REF_MISSING', `${prefix}/evidenceRefs/${refIndex}`, relativePath);
      }
    }
  }
  if (actionKeys.size !== 54) addError(errors, 'ACTION_COUNT_INVALID', '/actions', String(actionKeys.size));

  const packageJson = options.packageJson || readJson('package.json');
  const packageLock = options.packageLock || readJson('package-lock.json');
  if (packageJson.version !== RELEASE || packageLock.version !== RELEASE || packageLock.packages?.['']?.version !== RELEASE) {
    addError(errors, 'PACKAGE_VERSION_MISMATCH', '/package-version', `${packageJson.version}/${packageLock.version}/${packageLock.packages?.['']?.version}`);
  }

  const documents = options.documents || {
    changelog: releaseSection(
      readText('CHANGELOG.md'),
      '## 3.2.5 - 2026-09-05（正式发布候选）'
    ),
    history: releaseSection(
      readText('docs/VERSION_FEATURE_HISTORY.md'),
      '## v3.2.5（2026-09-05，正式发布候选）'
    ),
    guide: readText('docs/USER_GUIDE.md').split('\n---', 1)[0]
  };
  const requiredDocumentPatterns = [
    /v?3\.2\.5/,
    /54[^\n]{0,40}action/i,
    /production[^\n]{0,40}(?:关闭|未启用)/i,
    /Windows[^\n]{0,80}(?:NOT_RUN|未执行|未运行)/i,
    /资金[^\n]{0,80}(?:PENDING_HUMAN_REVIEW|人工复核)/i
  ];
  for (const [name, content] of Object.entries(documents)) {
    for (const pattern of requiredDocumentPatterns) {
      if (!pattern.test(content)) addError(errors, 'RELEASE_DOCUMENT_INCOMPLETE', `/documents/${name}`, String(pattern));
    }
    if (/production(?:\s|`)已启用|资金[^\n]{0,40}(?:人工复核|门禁)：?\s*PASS/i.test(content)) {
      addError(errors, 'RELEASE_DOCUMENT_UNSAFE_CLAIM', `/documents/${name}`, 'forged production or human gate claim');
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    facts: {
      release: candidate.release,
      actionCount: actionKeys.size,
      productionEnabledCount: candidate.globalDecision?.productionEnabledCount,
      legacyEffectiveCount: candidate.globalDecision?.legacyEffectiveCount,
      contractChecks: candidate.validationEvidence?.contractPackage?.total,
      checksumEntries: candidate.validationEvidence?.packageChecksums?.total
    }
  };
}

function writeSnapshot() {
  fs.mkdirSync(path.dirname(SNAPSHOT_PATH), { recursive: true });
  fs.writeFileSync(SNAPSHOT_PATH, `${JSON.stringify(buildExpectedReleaseEvidence(), null, 2)}\n`);
}

function main() {
  if (process.argv.includes('--write-package-checksums')) writePackageChecksums();
  if (process.argv.includes('--write')) writeSnapshot();
  const candidate = readJson(SNAPSHOT_RELATIVE_PATH);
  const result = validateReleaseEvidence(candidate);
  process.stdout.write(`${JSON.stringify({
    status: result.valid ? 'PASS' : 'FAIL',
    ...result.facts,
    errors: result.errors
  }, null, 2)}\n`);
  process.exitCode = result.valid ? 0 : 1;
}

module.exports = {
  AUTHORITY_PATHS,
  EVIDENCE_DIRECTORY,
  EXACT_BASE,
  HISTORICAL_RELEASES,
  PACKAGE_ROOT_RELATIVE_PATH,
  PackageChecksumError,
  RELEASE,
  SNAPSHOT_PATH,
  SNAPSHOT_RELATIVE_PATH,
  WORK_ITEM_ACTIONS,
  buildExpectedReleaseEvidence,
  deepClone,
  generatePackageChecksumContent,
  validateReleaseEvidence,
  verifyPackageChecksums,
  writePackageChecksums
};

if (require.main === module) main();
