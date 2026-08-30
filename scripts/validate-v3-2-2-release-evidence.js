'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { isDeepStrictEqual } = require('node:util');

const {
  BACKGROUND_EXECUTION_POLICIES
} = require('../src/main-process/background-execution/runtime');
const {
  FUND_RECON_POLICIES
} = require('../src/main-process/fund-recon-worker/policies');
const {
  DUPLICATE_POLICIES
} = require('../src/main-process/duplicate-inbound-match/policies');
const {
  BANK_BU_POLICIES
} = require('../src/main-process/bank-bu-worker/policies');

const REPOSITORY_ROOT = path.resolve(__dirname, '..');
const SNAPSHOT_PATH = path.join(
  REPOSITORY_ROOT,
  'changes/background-execution-r3-2-2-release-evidence/release-evidence.json'
);
const EXACT_BASE = '5c9495dda46c775babdac9eb1700c459735e5c8b';
const CANONICAL_POLICY_SOURCE =
  'changes/background-execution-v3.2.x-contract-baseline/changes/background-execution/' +
  'validation/fixtures/valid/policy-registry.v3.2.x.json';
const DUPLICATE_BENCHMARK_SOURCE =
  'changes/background-execution-e07-c-duplicate-paired-parser/benchmark-evidence.json';
const BANK_BU_E08B_NOTES_SOURCE =
  'changes/background-execution-e08-b-bank-bu-dual-parser/implementation-notes.md';

const ACTION_KEYS = Object.freeze([
  'fund-recon:import',
  'fund-recon:run',
  'fund-recon:export',
  'duplicate:import',
  'duplicate:run',
  'duplicate:export',
  'bank-bu:import-month',
  'bank-bu:run',
  'bank-bu:export-single',
  'bank-bu:export-aggregate'
]);
const COMMON_RUNTIME_ACTION_KEYS = Object.freeze(ACTION_KEYS.slice(0, 6));
const BANK_BU_ACTION_KEYS = Object.freeze(ACTION_KEYS.slice(6));

const EXPECTED_GLOBAL_DECISION = Object.freeze({
  productionEnablementAuthorized: false,
  actionIndependentEnablementRequired: true,
  policyMutationAuthorized: false,
  runtimeOwnershipMutationAuthorized: false,
  liveRoutingMutationAuthorized: false,
  businessSemanticsChanged: false,
  windowsPackagedEvidence: 'NOT_RUN',
  fundsRecoveryManualEvidence: 'PENDING_HUMAN_REVIEW'
});
const EXPECTED_AUTHORITY_LAYERING = Object.freeze({
  canonicalPolicyFixture: CANONICAL_POLICY_SOURCE,
  commonRuntime: Object.freeze({
    source: 'src/main-process/background-execution/runtime.js',
    registeredActionKeys: COMMON_RUNTIME_ACTION_KEYS,
    bankBuRegistration: 'ABSENT_FAIL_CLOSED'
  }),
  bankBuModule: Object.freeze({
    source: 'src/main-process/bank-bu-worker/policies.js',
    actionKeys: BANK_BU_ACTION_KEYS,
    policyAuthorityStatus: 'SOURCE_PRESENT_ONLY',
    commonRuntimeRegistration: 'ABSENT_FAIL_CLOSED',
    liveRouteStatus: 'NOT_RUN'
  })
});
const EXPECTED_DATA_MINIMIZATION = Object.freeze({
  profile: 'RELEASE_EVIDENCE_METADATA_ONLY_V1',
  prohibitedPayloadClasses: Object.freeze(['RAW_ACCOUNT', 'RAW_AMOUNT', 'BUSINESS_ROW']),
  enforcement: 'RECURSIVE_KEY_VALUE_SCAN'
});

const BASE_ANCHOR_SPECS = Object.freeze([
  {
    id: 'FUND-IMPORT-ADOPTION',
    actionKey: 'fund-recon:import',
    categories: ['IDENTITY', 'ORDER', 'OWNERSHIP'],
    source: 'src/main-process/fund-recon-worker/service.js',
    orderedFacts: [
      'await jobContext.adoptCandidate(candidate',
      'state = candidate;',
      'const candidate = buildImportedCandidate(state, input, readers, now);',
      "await publishCandidate(candidate, 'import', jobContext);",
      "return compactResult('import', state);"
    ]
  },
  {
    id: 'FUND-RUN-SNAPSHOT-ADOPTION',
    actionKey: 'fund-recon:run',
    categories: ['IDENTITY', 'OWNERSHIP'],
    source: 'src/main-process/fund-recon-worker/service.js',
    orderedFacts: [
      'const snapshot = evidenceProvider.openRunSnapshot({',
      'const result = await reconcile({',
      'evidenceSignature: snapshot.evidenceSignature,',
      "await publishCandidate(candidate, 'run', jobContext);"
    ]
  },
  {
    id: 'FUND-RUN-STRICT-ORDER',
    actionKey: 'fund-recon:run',
    categories: ['ORDER'],
    source: 'src/main-process/reconciliation-orchestrator.js',
    orderedFacts: [
      "await yieldTick('R1')",
      "await yieldTick('R2')",
      "await yieldTick('R3.5')",
      "await yieldTick('R4')",
      "await yieldTick('R5s2b')",
      "await yieldTick('R5s2')",
      "await yieldTick('R5s3')",
      "await yieldTick('R5s4')",
      "await yieldTick('M2M')",
      'const { modifiedRows, unmatchedRows } = buildOutputRows('
    ]
  },
  {
    id: 'FUND-EXPORT-SNAPSHOT-STAGING',
    actionKey: 'fund-recon:export',
    categories: ['IDENTITY', 'ORDER', 'OWNERSHIP'],
    source: 'src/main-process/fund-recon-worker/service.js',
    orderedFacts: [
      'const current = evidenceProvider.openRunSnapshot({',
      'if (current.evidenceSignature !== state.processingResult.evidenceSignature)',
      'const artifact = await artifactGenerator.generate({',
      'artifacts: Object.freeze([artifact])'
    ]
  },
  {
    id: 'DUPLICATE-IMPORT-STARTUP-OWNER',
    actionKey: 'duplicate:import',
    categories: ['IDENTITY', 'OWNERSHIP'],
    source: 'tests/unit/duplicate-inbound-match-wiring.test.js',
    orderedFacts: [
      "test('startup严格先注册只读inspector并持久扫描，再允许getter构造Service'",
      'const registerInspectorAt =',
      'const freezeAt =',
      'const scanAt =',
      'const readyAt =',
      'assert.ok(registerInspectorAt >= 0 && registerInspectorAt < freezeAt);',
      'assert.ok(freezeAt < scanAt && scanAt < readyAt);'
    ]
  },
  {
    id: 'DUPLICATE-IMPORT-BANK-DOCUMENT-ORDER',
    actionKey: 'duplicate:import',
    categories: ['IDENTITY', 'ORDER'],
    source: 'src/main-process/duplicate-inbound-match/service.js',
    orderedFacts: [
      'const pair = await validateDuplicateSpoolPair(rawPairedImport);',
      'await consumeDuplicateInputSpool(pair.bank',
      'const imported = await this.store.createImportBundle({',
      'beforeCommit: async () => {',
      'validateDuplicateInputSpool(pair.bank),',
      'validateDuplicateInputSpool(pair.document)',
      'writeDocumentRows: (insertRow) => consumeDuplicateInputSpool(pair.document, insertRow)'
    ]
  },
  {
    id: 'DUPLICATE-IMPORT-PAIRED-ACTION-SCOPE',
    actionKey: 'duplicate:import',
    categories: ['ACTION_SCOPE'],
    source: 'src/main-process/duplicate-inbound-match/topology.js',
    orderedFacts: [
      'return function planDuplicateTopology(request) {',
      "request.actionKey !== 'duplicate:import'",
      'return Object.freeze({ effectiveChildCount: 1 });',
      'return Object.freeze({ effectiveChildCount: 2 });'
    ]
  },
  {
    id: 'DUPLICATE-IMPORT-LOCAL-PERFORMANCE',
    actionKey: 'duplicate:import',
    categories: ['PERFORMANCE'],
    source: DUPLICATE_BENCHMARK_SOURCE,
    orderedFacts: [
      '"scope": "Parser-only; two real OS Parser Workers versus the same workers sequentially"',
      '"improvementRatio": 0.4018339921486093',
      '"localGatePassed": true',
      '"productionEnabled": false'
    ]
  },
  {
    id: 'DUPLICATE-RUN-SIDE-MIRROR',
    actionKey: 'duplicate:run',
    categories: ['IDENTITY', 'ORDER', 'OWNERSHIP'],
    source: 'src/main-process/duplicate-inbound-match/service.js',
    orderedFacts: [
      'const finishedRun = this.store.finishRun({',
      "phase: 'run-side-committed',",
      'sideCommitted = true;',
      'const completed = this.completeManagedMirror(managedExpected);',
      'managedMirrorCommitted = true;',
      'this.lastRun = {'
    ]
  },
  {
    id: 'DUPLICATE-EXPORT-CURRENT-RESULT',
    actionKey: 'duplicate:export',
    categories: ['IDENTITY', 'ORDER', 'OWNERSHIP'],
    source: 'src/main-process/duplicate-inbound-match/service.js',
    orderedFacts: [
      'if (this.recoveryLatch) throw recoveryRequiredError();',
      'if (!this.lastRun) {',
      'const availability = this.inspectLastRun();',
      'result = this.store.readResult(this.lastRun.monthKey, this.lastRun.sideRunId);',
      'const written = await writeDuplicateInboundWorkbook({',
      'return written;'
    ]
  },
  {
    id: 'BANK-BU-IMPORT-PARSER-FINALIZATION',
    actionKey: 'bank-bu:import-month',
    categories: ['IDENTITY', 'OWNERSHIP', 'ACTION_SCOPE'],
    source: 'src/main-process/bank-bu-worker/dual-parser-dispatch.js',
    orderedFacts: [
      'registerExternalParserFinalization(options.runtime, BANK_BU_DUAL_PROFILE, {',
      'await control.ready;',
      'const settled = await Promise.allSettled(',
      'settleWorkersTerminal();',
      'if (results[0].role !== BANK_BU_INPUT_ROLES.PENDING ||',
      'results[1].role !== BANK_BU_INPUT_ROLES.BANK)',
      'const execution = await parentWatcher;',
      'await retryCleanup();'
    ]
  },
  {
    id: 'BANK-BU-IMPORT-PENDING-BANK-ORDER',
    actionKey: 'bank-bu:import-month',
    categories: ['IDENTITY', 'ORDER'],
    source: 'src/main-process/bank-bu-worker/spool-reader.js',
    orderedFacts: [
      'const pending = await readBankBuInputSpool(descriptor.spools[0]);',
      'const bank = await readBankBuInputSpool(descriptor.spools[1]);',
      'assertSourceAuthority(pending.manifest),',
      'assertSourceAuthority(bank.manifest)'
    ]
  },
  {
    id: 'BANK-BU-IMPORT-TRANSACTION-ORDER',
    actionKey: 'bank-bu:import-month',
    categories: ['IDENTITY', 'ORDER', 'OWNERSHIP'],
    source: 'src/main-process/bank-bu-worker/side-database.js',
    orderedFacts: [
      "DELETE FROM ${monthRepository.PENDING_TABLE} WHERE year_month = ?",
      "DELETE FROM ${monthRepository.BANK_TABLE} WHERE year_month = ?",
      "DELETE FROM ${monthRepository.RUNS_TABLE} WHERE year_month = ?",
      'DELETE FROM bank_bu_dataset_evidence WHERE year_month = ?',
      'const pendingCount = monthRepository.insertPendingRowsInTxn',
      'const bankCount = monthRepository.insertBankRowsInTxn',
      'INSERT INTO bank_bu_dataset_evidence',
      'const receipt = receiptRepository.insertOperationReceipt(db, {',
      "db.exec('COMMIT');"
    ]
  },
  {
    id: 'BANK-BU-IMPORT-LOCAL-PERFORMANCE',
    actionKey: 'bank-bu:import-month',
    categories: ['PERFORMANCE'],
    source: BANK_BU_E08B_NOTES_SOURCE,
    orderedFacts: [
      '改善35.33%',
      'peak RSS 512,671,744B/预算838,860,800B',
      'production仍false/0',
      '未改main/preload/renderer/background runtime policy集合'
    ]
  },
  {
    id: 'BANK-BU-RUN-SIDE-RECEIPT',
    actionKey: 'bank-bu:run',
    categories: ['IDENTITY', 'ORDER', 'OWNERSHIP'],
    source: 'src/main-process/bank-bu-worker/side-database.js',
    orderedFacts: [
      "db.exec('BEGIN IMMEDIATE');",
      'assertDatasetCurrent(db, yearMonth, inputEvidenceHash);',
      'const sideRunId = runRepository.insertManagedRun(db, {',
      'const receipt = receiptRepository.insertOperationReceipt(db, {',
      "db.exec('COMMIT');"
    ]
  },
  {
    id: 'BANK-BU-RUN-MAIN-CAS',
    actionKey: 'bank-bu:run',
    categories: ['IDENTITY', 'ORDER', 'OWNERSHIP'],
    source: 'src/main-process/bank-bu-worker/main-coordinator.js',
    orderedFacts: [
      'const preimage = captureMirrorPreimage(mainDb, critical.yearMonth);',
      'const persisted = await options.persistCriticalIntent(boundedEvidence, metadata);',
      'preparedEvidence = boundedEvidence;',
      'const side = readSideOperation(identity.userDataDir, preparedEvidence);',
      'const result = commitMirrorCas(mainDb, preparedEvidence.preimage, postImage);'
    ]
  },
  {
    id: 'BANK-BU-EXPORT-SINGLE-SNAPSHOT',
    actionKey: 'bank-bu:export-single',
    categories: ['IDENTITY', 'ORDER', 'OWNERSHIP'],
    source: 'src/main-process/bank-bu-worker/export-operation.js',
    orderedFacts: [
      "db.exec('PRAGMA query_only = ON; BEGIN DEFERRED;');",
      'run = runData.getMirrorRun({ mainDb: db, runId });',
      'const snapshot = await loadManagedSnapshot(',
      'await writeDiffWorkbook({',
      "const manifest = artifact(stagingPath, 'bank-bu-export-single');",
      'assertFreshExportIdentity(db, input.userDataDir, [run], managedStates);'
    ]
  },
  {
    id: 'BANK-BU-EXPORT-AGGREGATE-ORDER',
    actionKey: 'bank-bu:export-aggregate',
    categories: ['IDENTITY', 'ORDER', 'OWNERSHIP'],
    source: 'src/main-process/bank-bu-worker/export-operation.js',
    orderedFacts: [
      'ORDER BY year_month ASC',
      'const latest = latestRuns(db);',
      'const months = [];',
      'const skippedMonths = [];',
      'for (const run of latest) {',
      'months.push({',
      'await writeAggregateDiffWorkbook({ matchedMonths: months, savePath: stagingPath });',
      "const manifest = artifact(stagingPath, 'bank-bu-export-aggregate');",
      'assertFreshExportIdentity(db, input.userDataDir, latest, managedStates);',
      'includedMonths: Object.freeze(months.map((month) => month.yearMonth)),',
      'skippedMonths: Object.freeze(skippedMonths.slice()),',
      'runIds: Object.freeze(months.map((month) => Number(month.runId)))'
    ]
  }
]);

const EVIDENCE_SPECS = Object.freeze([
  ['CONTRACT-SPEC-3.2.2', null,
    'changes/background-execution-v3.2.x-contract-baseline/changes/3.2.2/spec.md',
    EXACT_BASE, 'SHARED_CONTRACT', []],
  ['CONTRACT-TECHDOC-3.2.2', null,
    'changes/background-execution-v3.2.x-contract-baseline/changes/3.2.2/techdoc.md',
    EXACT_BASE, 'SHARED_CONTRACT', []],
  ['CONTRACT-SEQUENCE-3.2.2', null,
    'changes/background-execution-v3.2.x-contract-baseline/implementation-sequence.md',
    EXACT_BASE, 'SHARED_CONTRACT', []],
  ['POLICY-CANONICAL-V3.2.X', null, CANONICAL_POLICY_SOURCE,
    EXACT_BASE, 'SHARED_POLICY', []],
  ['E06-A-FUND-IMPORT', 'fund-recon:import',
    'changes/background-execution-e06-a-fund-recon-service/implementation-notes.md',
    'ce099b5446b6d18fa41ccf660bd6d55d32f595d4', 'ACTION_CLAIM',
    ['FUND-IMPORT-ADOPTION']],
  ['E06-A-FUND-RUN', 'fund-recon:run',
    'changes/background-execution-e06-a-fund-recon-service/implementation-notes.md',
    'ce099b5446b6d18fa41ccf660bd6d55d32f595d4', 'ACTION_CLAIM',
    ['FUND-RUN-SNAPSHOT-ADOPTION', 'FUND-RUN-STRICT-ORDER']],
  ['E06-A-FUND-EXPORT', 'fund-recon:export',
    'changes/background-execution-e06-a-fund-recon-service/implementation-notes.md',
    'ce099b5446b6d18fa41ccf660bd6d55d32f595d4', 'ACTION_CLAIM',
    ['FUND-EXPORT-SNAPSHOT-STAGING']],
  ['E07-A-DUPLICATE-IMPORT', 'duplicate:import',
    'changes/background-execution-e07-a-duplicate-startup-service/implementation-notes.md',
    'e36dfe33a22d6d821fa3792a70a2580de7af45af', 'ACTION_CLAIM',
    ['DUPLICATE-IMPORT-STARTUP-OWNER']],
  ['E07-B-DUPLICATE-IMPORT', 'duplicate:import',
    'changes/background-execution-e07-b-duplicate-recovery/implementation-notes.md',
    'c60e9d204e45e3bc39d61a3fc224c0bc0eef7d70', 'ACTION_CLAIM',
    ['DUPLICATE-IMPORT-BANK-DOCUMENT-ORDER']],
  ['E07-C-DUPLICATE-IMPORT', 'duplicate:import',
    'changes/background-execution-e07-c-duplicate-paired-parser/implementation-notes.md',
    '2df35fd5ebf51797537de37a58b2563ae64341df', 'ACTION_CLAIM',
    ['DUPLICATE-IMPORT-BANK-DOCUMENT-ORDER']],
  ['E07-C-DUPLICATE-IMPORT-BENCHMARK', 'duplicate:import', DUPLICATE_BENCHMARK_SOURCE,
    '2df35fd5ebf51797537de37a58b2563ae64341df', 'ACTION_PERFORMANCE',
    ['DUPLICATE-IMPORT-PAIRED-ACTION-SCOPE', 'DUPLICATE-IMPORT-LOCAL-PERFORMANCE']],
  ['E07-A-DUPLICATE-RUN', 'duplicate:run',
    'changes/background-execution-e07-a-duplicate-startup-service/implementation-notes.md',
    'e36dfe33a22d6d821fa3792a70a2580de7af45af', 'ACTION_CLAIM',
    ['DUPLICATE-RUN-SIDE-MIRROR']],
  ['E07-B-DUPLICATE-RUN', 'duplicate:run',
    'changes/background-execution-e07-b-duplicate-recovery/implementation-notes.md',
    'c60e9d204e45e3bc39d61a3fc224c0bc0eef7d70', 'ACTION_CLAIM',
    ['DUPLICATE-RUN-SIDE-MIRROR']],
  ['E07-A-DUPLICATE-EXPORT', 'duplicate:export',
    'changes/background-execution-e07-a-duplicate-startup-service/implementation-notes.md',
    'e36dfe33a22d6d821fa3792a70a2580de7af45af', 'ACTION_CLAIM',
    ['DUPLICATE-EXPORT-CURRENT-RESULT']],
  ['E08-A-BANK-BU-IMPORT', 'bank-bu:import-month',
    'changes/background-execution-e08-a-bank-bu-single/implementation-notes.md',
    'a8e7cbdf41487ba0eca3f60e467f5413e4e8fa14', 'ACTION_CLAIM',
    ['BANK-BU-IMPORT-TRANSACTION-ORDER']],
  ['E08-B-BANK-BU-IMPORT', 'bank-bu:import-month', BANK_BU_E08B_NOTES_SOURCE,
    EXACT_BASE, 'ACTION_CLAIM',
    ['BANK-BU-IMPORT-PARSER-FINALIZATION', 'BANK-BU-IMPORT-PENDING-BANK-ORDER']],
  ['E08-B-BANK-BU-IMPORT-PERFORMANCE', 'bank-bu:import-month', BANK_BU_E08B_NOTES_SOURCE,
    EXACT_BASE, 'ACTION_PERFORMANCE',
    ['BANK-BU-IMPORT-PARSER-FINALIZATION', 'BANK-BU-IMPORT-LOCAL-PERFORMANCE']],
  ['E08-A-BANK-BU-RUN', 'bank-bu:run',
    'changes/background-execution-e08-a-bank-bu-single/implementation-notes.md',
    'a8e7cbdf41487ba0eca3f60e467f5413e4e8fa14', 'ACTION_CLAIM',
    ['BANK-BU-RUN-SIDE-RECEIPT', 'BANK-BU-RUN-MAIN-CAS']],
  ['E08-A-BANK-BU-EXPORT-SINGLE', 'bank-bu:export-single',
    'changes/background-execution-e08-a-bank-bu-single/implementation-notes.md',
    'a8e7cbdf41487ba0eca3f60e467f5413e4e8fa14', 'ACTION_CLAIM',
    ['BANK-BU-EXPORT-SINGLE-SNAPSHOT']],
  ['E08-A-BANK-BU-EXPORT-AGGREGATE', 'bank-bu:export-aggregate',
    'changes/background-execution-e08-a-bank-bu-single/implementation-notes.md',
    'a8e7cbdf41487ba0eca3f60e467f5413e4e8fa14', 'ACTION_CLAIM',
    ['BANK-BU-EXPORT-AGGREGATE-ORDER']]
].map(([id, actionKey, source, reviewedHead, kind, anchorRefs]) => Object.freeze({
  id,
  actionKey,
  source,
  reviewedHead,
  kind,
  anchorRefs: Object.freeze(anchorRefs)
})));

const ACTION_FIELDS = Object.freeze([
  'actionKey', 'currentPolicy', 'decision', 'evidenceRefs', 'gates', 'live',
  'policyAuthority', 'rollback', 'runtimeOwnership'
]);
const HASH_VALUE_KEYS = new Set(['baseCommit', 'reviewedHead', 'blobOid', 'sha256']);
const RAW_LIKE_KEYS = new Set([
  'raw', 'rawaccount', 'rawaccounts', 'rawamount', 'rawamounts', 'rawrow', 'rawrows',
  'account', 'accountno', 'amount', 'row', 'rows', 'businessrow', 'businessrows',
  'payload', 'record', 'records', 'credit', 'debit', 'currency', 'merchantid',
  '原始账号', '原始账户', '原始金额', '原始业务行', '账号', '账户', '银行账号', '银行账户',
  '金额', '交易金额', '借方', '贷方', '业务行', '币种', '大账号', '财务bu'
]);
const PRIVACY_KEY_SEPARATORS = /[\s._/\\\-:;=,，、·]+/gu;

function parseJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function canonicalText(value) {
  return String(value).replace(/\r\n/g, '\n');
}

function sha256Text(value) {
  return crypto.createHash('sha256').update(canonicalText(value), 'utf8').digest('hex');
}

function sha256File(filePath) {
  return sha256Text(fs.readFileSync(filePath, 'utf8'));
}

function projectPolicy(policy) {
  return {
    disposition: policy.disposition,
    mode: policy.mode,
    lifetime: policy.lifetime,
    adapterKind: policy.adapterKind,
    commitKind: policy.commit.kind,
    criticalIntent: policy.commit.criticalIntent,
    receiptKind: policy.commit.receiptKind,
    production: structuredClone(policy.production)
  };
}

function actionAnchorIds(actionKey, category) {
  return BASE_ANCHOR_SPECS
    .filter((anchor) => anchor.actionKey === actionKey && anchor.categories.includes(category))
    .map((anchor) => anchor.id);
}

function expectedRuntimeOwnership(policy, common) {
  return {
    policyLayer: common ? 'COMMON_BACKGROUND_RUNTIME' : 'MODULE_LOCAL_ONLY',
    registrationStatus: common ? 'REGISTERED' : 'ABSENT_FAIL_CLOSED',
    lifetime: policy.lifetime,
    serviceKey: policy.service ? policy.service.serviceKey : null,
    commitKind: policy.commit.kind,
    inspectorKey: policy.commit.inspectorKey,
    settlementKey: policy.commit.settlementKey,
    legacyStrategyKey: policy.legacyStrategyKey,
    anchorIds: actionAnchorIds(policy.actionKey, 'OWNERSHIP')
  };
}

function expectedGates(actionKey) {
  return {
    windowsPackaged: 'NOT_RUN',
    windowsNativeSqlite: 'NOT_RUN',
    realProcessTermination: 'NOT_RUN',
    realBusinessSamples: 'PENDING_HUMAN_REVIEW',
    funds: 'PENDING_HUMAN_REVIEW',
    recovery: 'PENDING_HUMAN_REVIEW',
    liveWiring: 'NOT_RUN',
    performance: actionAnchorIds(actionKey, 'PERFORMANCE').length > 0
      ? 'LOCAL_CAPABILITY_ONLY'
      : 'NOT_RUN'
  };
}

function expectedEvidenceRefs(actionKey) {
  return EVIDENCE_SPECS
    .filter((evidence) => evidence.actionKey === null || evidence.actionKey === actionKey)
    .map((evidence) => evidence.id);
}

function runGit(repositoryRoot, args, binary = false) {
  return spawnSync('git', ['-C', repositoryRoot, ...args], {
    encoding: binary ? null : 'utf8',
    maxBuffer: 32 * 1024 * 1024
  });
}

function isRepositoryRelative(source) {
  return typeof source === 'string' && source.length > 0 && !path.isAbsolute(source) &&
    !source.split(/[\\/]/).includes('..');
}

function inspectGitBackedFile(repositoryRoot, reviewedHead, source) {
  if (typeof reviewedHead !== 'string' || !/^[a-f0-9]{40}$/.test(reviewedHead)) {
    return Object.freeze({ error: 'reviewedHead must be a full lowercase commit hash' });
  }
  if (!isRepositoryRelative(source)) {
    return Object.freeze({ error: 'source must be repository-relative' });
  }
  const commit = runGit(repositoryRoot, ['cat-file', '-e', reviewedHead + '^{commit}']);
  if (commit.status !== 0) {
    return Object.freeze({ error: 'reviewedHead is not a real commit' });
  }
  const ancestor = runGit(
    repositoryRoot,
    ['merge-base', '--is-ancestor', reviewedHead, EXACT_BASE]
  );
  if (ancestor.status !== 0) {
    return Object.freeze({ error: 'reviewedHead is not an ancestor of the frozen base' });
  }
  const resolved = runGit(repositoryRoot, ['rev-parse', reviewedHead + ':' + source]);
  if (resolved.status !== 0 || !/^[a-f0-9]{40}$/.test(String(resolved.stdout).trim())) {
    return Object.freeze({ error: 'reviewedHead:path does not resolve to a Git blob' });
  }
  const blobOid = String(resolved.stdout).trim();
  const blob = runGit(repositoryRoot, ['cat-file', 'blob', blobOid], true);
  if (blob.status !== 0 || !Buffer.isBuffer(blob.stdout)) {
    return Object.freeze({ error: 'Git blob cannot be read' });
  }
  return Object.freeze({
    blobOid,
    sha256: sha256Text(blob.stdout.toString('utf8'))
  });
}

function extractBaseOwnedActionKey(sourceText) {
  const actionKeys = new Set();
  const patterns = [
    /\bactionKey\s*:\s*(['"])([^'"]+)\1/g,
    /\.actionKey\s*(?:===|!==)\s*(['"])([^'"]+)\1/g
  ];
  for (const pattern of patterns) {
    for (const match of sourceText.matchAll(pattern)) {
      if (ACTION_KEYS.includes(match[2])) actionKeys.add(match[2]);
    }
  }
  if (actionKeys.size !== 1) {
    return Object.freeze({
      error: 'base-owned action scope must resolve exactly one known actionKey'
    });
  }
  return Object.freeze({ actionKey: [...actionKeys][0] });
}

function normalizePrivacyText(value) {
  return String(value).normalize('NFKC');
}

function normalizePrivacyKey(value) {
  return normalizePrivacyText(value).toLowerCase().replace(PRIVACY_KEY_SEPARATORS, '');
}

function scanPrivacy(value, add, fieldPath = '', key = null) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanPrivacy(item, add, fieldPath + '/' + index, null));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [childKey, childValue] of Object.entries(value)) {
      const childPath = fieldPath + '/' + childKey;
      const normalizedKey = normalizePrivacyKey(childKey);
      if (RAW_LIKE_KEYS.has(normalizedKey)) {
        add(
          '/privacy/raw-like-key' + childPath,
          'raw account, amount or business-row keys are forbidden'
        );
      }
      scanPrivacy(childValue, add, childPath, childKey);
    }
    return;
  }
  if (typeof value === 'number') {
    if (Math.abs(value) >= 1e11) {
      add('/privacy/raw-account' + fieldPath, 'raw account-like numeric value is forbidden');
    }
    if (Number.isFinite(value) && !Number.isInteger(value)) {
      add('/privacy/raw-amount' + fieldPath, 'raw amount-like numeric value is forbidden');
    }
    return;
  }
  if (typeof value !== 'string' || HASH_VALUE_KEYS.has(key)) return;
  const normalizedValue = normalizePrivacyText(value);
  if (/(?:^|[^0-9])\d{12,24}(?:[^0-9]|$)/.test(normalizedValue)) {
    add('/privacy/raw-account' + fieldPath, 'raw account-like digits are forbidden');
  }
  if (/(?:raw[\s._/\\-]*)?(?:amount|金额|借方|贷方)[\s._/\\-]*(?::|=|;|,)?[\s._/\\-]*[-+]?\d{1,18}(?:,\d{3})*(?:\.\d{1,8})?/iu.test(normalizedValue)) {
    add('/privacy/raw-amount' + fieldPath, 'raw amount-like values are forbidden');
  }
  if (/(?:^|[^0-9])[-+]?\d{4,}(?:,\d{3})*(?:\.\d+)(?:[^0-9]|$)/.test(normalizedValue)) {
    add('/privacy/raw-amount' + fieldPath, 'bare raw amount-like value is forbidden');
  }
  const businessRowLabel = /(?:^|[,{;\s]["']?)(?:raw[\s._/\\-]*row|business[\s._/\\-]*row|业务行)["']?(?:(?:[\s._/\\-]+)|(?::|=|;|,)[\s._/\\-]*)(?=\S)/iu;
  const structuredFieldLabel = /(?:^|[,{;\s]["']?)(?:raw[\s._/\\-]*(?:account|amount)|account(?:[\s._/\\-]*(?:no|number))?|amount|credit|debit|merchant[\s._/\\-]*id|currency|账号|账户|金额|借方|贷方|币种|大账号|财务bu)["']?[\s._/\\-]*(?::|=|;|,)/iu;
  if (businessRowLabel.test(normalizedValue) || structuredFieldLabel.test(normalizedValue)) {
    add('/privacy/business-row' + fieldPath, 'serialized business-row payload is forbidden');
  }
}

function validateGitRecord(record, recordPath, repositoryRoot, add, expectEqual) {
  const gitFile = inspectGitBackedFile(repositoryRoot, record.reviewedHead, record.source);
  if (gitFile.error) {
    add(recordPath + '/reviewedHead', gitFile.error);
    return null;
  }
  expectEqual(recordPath + '/blobOid', record.blobOid, gitFile.blobOid);
  expectEqual(recordPath + '/sha256', record.sha256, gitFile.sha256);
  const currentPath = path.join(repositoryRoot, record.source);
  let currentText;
  try {
    currentText = fs.readFileSync(currentPath, 'utf8');
  } catch (_error) {
    add(recordPath + '/source', 'current canonical file is missing or unreadable');
    return null;
  }
  if (sha256Text(currentText) !== gitFile.sha256) {
    add(recordPath + '/source', 'current canonical file drifted from the reviewed Git blob');
    return null;
  }
  return Object.freeze({ ...gitFile, currentText: canonicalText(currentText) });
}

function validateReleaseEvidence(snapshot, options = {}) {
  const repositoryRoot = options.repositoryRoot || REPOSITORY_ROOT;
  const errors = [];
  const add = (fieldPath, message) => {
    errors.push(Object.freeze({ path: fieldPath, message }));
  };
  const expectEqual = (fieldPath, actual, expected) => {
    if (!isDeepStrictEqual(actual, expected)) {
      add(
        fieldPath,
        'expected ' + JSON.stringify(expected) + ', received ' + JSON.stringify(actual)
      );
    }
  };

  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    add('/', 'snapshot must be an object');
    return Object.freeze({ valid: false, errors: Object.freeze(errors), actionCount: 0 });
  }

  // Run before structural checks so synchronized metadata tampering reports the privacy breach.
  scanPrivacy(snapshot, add);

  expectEqual('/keys', Object.keys(snapshot).sort(), [
    'actions', 'authorityLayering', 'baseAnchors', 'baseCommit', 'dataMinimization',
    'evidenceCatalog', 'globalDecision', 'packageVersion', 'release', 'releaseStep',
    'schemaVersion', 'scope'
  ]);
  expectEqual('/schemaVersion', snapshot.schemaVersion, 2);
  expectEqual('/release', snapshot.release, '3.2.2');
  expectEqual('/releaseStep', snapshot.releaseStep, 'R3.2.2');
  expectEqual('/baseCommit', snapshot.baseCommit, EXACT_BASE);
  expectEqual('/scope', snapshot.scope, 'release-evidence-only');
  expectEqual('/packageVersion', snapshot.packageVersion, { value: '3.1.14', bumped: false });
  expectEqual('/globalDecision', snapshot.globalDecision, EXPECTED_GLOBAL_DECISION);
  expectEqual('/authorityLayering', snapshot.authorityLayering, EXPECTED_AUTHORITY_LAYERING);
  expectEqual('/dataMinimization', snapshot.dataMinimization, EXPECTED_DATA_MINIMIZATION);

  const packageJson = parseJsonFile(path.join(repositoryRoot, 'package.json'));
  expectEqual('/authority/packageVersion', packageJson.version, '3.1.14');

  const anchorById = new Map();
  const baseOwnedActionScopeById = new Map();
  const actualAnchorIds = Array.isArray(snapshot.baseAnchors)
    ? snapshot.baseAnchors.map((anchor) => anchor && anchor.id)
    : [];
  expectEqual('/baseAnchors/ids', actualAnchorIds, BASE_ANCHOR_SPECS.map((anchor) => anchor.id));
  if (Array.isArray(snapshot.baseAnchors)) {
    snapshot.baseAnchors.forEach((anchor, index) => {
      const anchorPath = '/baseAnchors/' + index;
      const spec = BASE_ANCHOR_SPECS[index];
      if (!anchor || typeof anchor !== 'object' || Array.isArray(anchor) || !spec) {
        add(anchorPath, 'unexpected or invalid base anchor');
        return;
      }
      expectEqual(anchorPath + '/keys', Object.keys(anchor).sort(), [
        'actionKey', 'blobOid', 'categories', 'id', 'reviewedHead', 'sha256', 'source'
      ]);
      expectEqual(anchorPath + '/id', anchor.id, spec.id);
      expectEqual(anchorPath + '/actionKey', anchor.actionKey, spec.actionKey);
      expectEqual(anchorPath + '/categories', anchor.categories, spec.categories);
      expectEqual(anchorPath + '/source', anchor.source, spec.source);
      expectEqual(anchorPath + '/reviewedHead', anchor.reviewedHead, EXACT_BASE);
      const gitFile = validateGitRecord(
        anchor,
        anchorPath,
        repositoryRoot,
        add,
        expectEqual
      );
      if (gitFile) {
        let cursor = 0;
        for (const fact of spec.orderedFacts) {
          const foundAt = gitFile.currentText.indexOf(fact, cursor);
          if (foundAt < 0) {
            add(anchorPath + '/orderedFacts', 'frozen source lacks ordered fact: ' + fact);
            break;
          }
          cursor = foundAt + fact.length;
        }
        if (spec.categories.includes('ACTION_SCOPE')) {
          const actionScope = extractBaseOwnedActionKey(gitFile.currentText);
          if (actionScope.error) {
            add(anchorPath + '/actionScope', actionScope.error);
          } else {
            baseOwnedActionScopeById.set(anchor.id, actionScope.actionKey);
            if (anchor.actionKey !== actionScope.actionKey) {
              add(
                anchorPath + '/actionScope',
                'base-owned action scope is ' + actionScope.actionKey +
                  ', received ' + String(anchor.actionKey)
              );
            }
          }
        }
      }
      if (anchorById.has(anchor.id)) {
        add(anchorPath + '/id', 'base anchor id must be unique');
      } else {
        anchorById.set(anchor.id, anchor);
      }
    });
  }

  const evidenceById = new Map();
  const actualEvidenceIds = Array.isArray(snapshot.evidenceCatalog)
    ? snapshot.evidenceCatalog.map((evidence) => evidence && evidence.id)
    : [];
  expectEqual(
    '/evidenceCatalog/ids',
    actualEvidenceIds,
    EVIDENCE_SPECS.map((evidence) => evidence.id)
  );
  if (Array.isArray(snapshot.evidenceCatalog)) {
    snapshot.evidenceCatalog.forEach((evidence, index) => {
      const evidencePath = '/evidenceCatalog/' + index;
      const spec = EVIDENCE_SPECS[index];
      if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence) || !spec) {
        add(evidencePath, 'unexpected or invalid evidence entry');
        return;
      }
      expectEqual(evidencePath + '/keys', Object.keys(evidence).sort(), [
        'actionKey', 'anchorRefs', 'blobOid', 'id', 'kind', 'reviewedHead', 'sha256', 'source'
      ]);
      expectEqual(evidencePath + '/id', evidence.id, spec.id);
      expectEqual(evidencePath + '/actionKey', evidence.actionKey, spec.actionKey);
      expectEqual(evidencePath + '/kind', evidence.kind, spec.kind);
      expectEqual(evidencePath + '/source', evidence.source, spec.source);
      expectEqual(evidencePath + '/reviewedHead', evidence.reviewedHead, spec.reviewedHead);
      expectEqual(evidencePath + '/anchorRefs', evidence.anchorRefs, spec.anchorRefs);
      validateGitRecord(evidence, evidencePath, repositoryRoot, add, expectEqual);
      let hasPerformanceAnchor = false;
      let hasMatchingActionScopeAnchor = false;
      for (const anchorRef of Array.isArray(evidence.anchorRefs) ? evidence.anchorRefs : []) {
        const anchor = anchorById.get(anchorRef);
        if (!anchor) {
          add(evidencePath + '/anchorRefs', 'unknown base anchor: ' + String(anchorRef));
        } else if (evidence.actionKey === null || anchor.actionKey !== evidence.actionKey) {
          add(
            evidencePath + '/anchorRefs',
            'evidence cannot borrow a base anchor from another action'
          );
        } else if (evidence.kind === 'ACTION_PERFORMANCE') {
          hasPerformanceAnchor ||= anchor.categories.includes('PERFORMANCE');
          hasMatchingActionScopeAnchor ||= anchor.categories.includes('ACTION_SCOPE') &&
            baseOwnedActionScopeById.get(anchorRef) === evidence.actionKey;
        }
      }
      if (evidence.kind === 'ACTION_PERFORMANCE' && !hasPerformanceAnchor) {
        add(evidencePath + '/anchorRefs', 'performance evidence requires a performance anchor');
      }
      if (evidence.kind === 'ACTION_PERFORMANCE' && !hasMatchingActionScopeAnchor) {
        add(
          evidencePath + '/actionScope',
          'performance evidence requires a matching base-owned action scope anchor'
        );
      }
      if (evidenceById.has(evidence.id)) {
        add(evidencePath + '/id', 'evidence id must be unique');
      } else {
        evidenceById.set(evidence.id, evidence);
      }
    });
  }

  const directPolicies = new Map([
    ...FUND_RECON_POLICIES,
    ...DUPLICATE_POLICIES,
    ...BANK_BU_POLICIES
  ].map((policy) => [policy.actionKey, policy]));
  const commonRuntimePolicies = new Map(
    BACKGROUND_EXECUTION_POLICIES.map((policy) => [policy.actionKey, policy])
  );
  const actualCommonKeys = BACKGROUND_EXECUTION_POLICIES
    .map((policy) => policy.actionKey)
    .filter((actionKey) => ACTION_KEYS.includes(actionKey));
  expectEqual('/authority/commonRuntime/actionKeys', actualCommonKeys, COMMON_RUNTIME_ACTION_KEYS);
  for (const actionKey of BANK_BU_ACTION_KEYS) {
    if (commonRuntimePolicies.has(actionKey)) {
      add(
        '/authority/commonRuntime/bankBuRegistration',
        'BankBU action unexpectedly entered common runtime: ' + actionKey
      );
    }
  }

  const canonical = parseJsonFile(path.join(repositoryRoot, CANONICAL_POLICY_SOURCE));
  const actualActionKeys = Array.isArray(snapshot.actions)
    ? snapshot.actions.map((action) => action && action.actionKey)
    : [];
  expectEqual('/actions/actionKeys', actualActionKeys, ACTION_KEYS);

  if (Array.isArray(snapshot.actions)) {
    snapshot.actions.forEach((action, index) => {
      const actionPath = '/actions/' + index;
      if (!action || typeof action !== 'object' || Array.isArray(action) ||
          !ACTION_KEYS.includes(action.actionKey)) {
        add(actionPath + '/actionKey', 'unexpected or invalid action');
        return;
      }
      expectEqual(actionPath + '/keys', Object.keys(action).sort(), ACTION_FIELDS);
      const directPolicy = directPolicies.get(action.actionKey);
      const canonicalPolicy = canonical.actions && canonical.actions[action.actionKey];
      if (!directPolicy || !canonicalPolicy) {
        add(actionPath + '/currentPolicy', 'direct or canonical policy is missing');
        return;
      }
      const directProjection = projectPolicy(directPolicy);
      expectEqual(actionPath + '/currentPolicy', action.currentPolicy, directProjection);
      expectEqual(
        '/authority/canonicalPolicy/' + action.actionKey,
        directProjection,
        projectPolicy(canonicalPolicy)
      );
      expectEqual(
        '/authority/canonicalPolicyFull/' + action.actionKey,
        structuredClone(directPolicy),
        canonicalPolicy
      );

      const common = COMMON_RUNTIME_ACTION_KEYS.includes(action.actionKey);
      expectEqual(
        actionPath + '/policyAuthority',
        action.policyAuthority,
        common ? 'common-runtime' : 'module-policy-only'
      );
      expectEqual(
        actionPath + '/runtimeOwnership',
        action.runtimeOwnership,
        expectedRuntimeOwnership(directPolicy, common)
      );
      if (common) {
        const commonPolicy = commonRuntimePolicies.get(action.actionKey);
        if (!commonPolicy) {
          add(actionPath + '/runtimeOwnership', 'common runtime policy is missing');
        } else {
          expectEqual(
            '/authority/commonRuntime/' + action.actionKey,
            projectPolicy(commonPolicy),
            directProjection
          );
        }
      }

      expectEqual(actionPath + '/decision', action.decision, {
        kind: 'KEEP_DISABLED',
        enabled: false,
        independent: true
      });
      expectEqual(actionPath + '/live', action.live, {
        disposition: 'legacy-preserved',
        effectiveMode: directPolicy.production.effectiveMode,
        effectiveWorkerCount: directPolicy.production.effectiveWorkerCount,
        strategyKey: directPolicy.legacyStrategyKey
      });
      expectEqual(actionPath + '/gates', action.gates, expectedGates(action.actionKey));
      expectEqual(actionPath + '/rollback', action.rollback, {
        strategyKey: directPolicy.legacyStrategyKey,
        identityAnchorIds: actionAnchorIds(action.actionKey, 'IDENTITY'),
        orderAnchorIds: actionAnchorIds(action.actionKey, 'ORDER')
      });
      expectEqual(
        actionPath + '/evidenceRefs',
        action.evidenceRefs,
        expectedEvidenceRefs(action.actionKey)
      );

      const coveredAnchors = new Set();
      for (const evidenceRef of Array.isArray(action.evidenceRefs) ? action.evidenceRefs : []) {
        const evidence = evidenceById.get(evidenceRef);
        if (!evidence) {
          add(actionPath + '/evidenceRefs', 'unknown evidence ref: ' + String(evidenceRef));
          continue;
        }
        if (evidence.actionKey !== null && evidence.actionKey !== action.actionKey) {
          add(
            actionPath + '/evidenceRefs',
            'cross-action evidence borrowing is forbidden: ' + evidenceRef
          );
          continue;
        }
        for (const anchorRef of evidence.anchorRefs || []) coveredAnchors.add(anchorRef);
      }
      const requiredAnchors = BASE_ANCHOR_SPECS
        .filter((anchor) => anchor.actionKey === action.actionKey)
        .map((anchor) => anchor.id);
      expectEqual(
        actionPath + '/evidenceAnchorCoverage',
        requiredAnchors.filter((anchorId) => coveredAnchors.has(anchorId)),
        requiredAnchors
      );
    });
  }

  const duplicateBenchmark = parseJsonFile(path.join(repositoryRoot, DUPLICATE_BENCHMARK_SOURCE));
  expectEqual('/authority/duplicateBenchmark', {
    improvementRatio: duplicateBenchmark.summary.improvementRatio,
    peakRssBytes: duplicateBenchmark.summary.pairedPeakRssBytes,
    rssBudgetBytes: duplicateBenchmark.summary.rssBudgetBytes,
    localGatePassed: duplicateBenchmark.summary.localGatePassed,
    productionEnabled: duplicateBenchmark.productionEnabled
  }, {
    improvementRatio: 0.4018339921486093,
    peakRssBytes: 507150336,
    rssBudgetBytes: 838860800,
    localGatePassed: true,
    productionEnabled: false
  });

  const liveSource = [
    'src/main.js',
    'src/preload.js',
    'src/renderer.js',
    'src/renderer-dialogs.js'
  ].map((source) => fs.readFileSync(path.join(repositoryRoot, source), 'utf8')).join('\n');
  for (const actionKey of ACTION_KEYS) {
    if (liveSource.includes(actionKey)) {
      add(
        '/authority/liveRouting',
        'release action unexpectedly appears in a live UI source: ' + actionKey
      );
    }
  }

  return Object.freeze({
    valid: errors.length === 0,
    errors: Object.freeze(errors),
    actionCount: actualActionKeys.length,
    commonRuntimeActionCount: actualCommonKeys.length,
    bankBuCommonRuntimeActionCount: actualCommonKeys.filter(
      (actionKey) => BANK_BU_ACTION_KEYS.includes(actionKey)
    ).length
  });
}

function runCli() {
  const snapshot = parseJsonFile(SNAPSHOT_PATH);
  const result = validateReleaseEvidence(snapshot);
  if (!result.valid) {
    process.stderr.write(JSON.stringify(result, null, 2) + '\n');
    process.exitCode = 1;
    return;
  }
  process.stdout.write(JSON.stringify({
    status: 'PASS',
    release: snapshot.release,
    baseCommit: snapshot.baseCommit,
    actionCount: result.actionCount,
    productionEnabledCount: snapshot.actions.filter((action) => action.decision.enabled).length,
    commonRuntimeActionCount: result.commonRuntimeActionCount,
    bankBuCommonRuntimeActionCount: result.bankBuCommonRuntimeActionCount,
    bankBuCommonRuntimeRegistration:
      snapshot.authorityLayering.bankBuModule.commonRuntimeRegistration,
    windowsPackagedEvidence: snapshot.globalDecision.windowsPackagedEvidence,
    fundsRecoveryManualEvidence: snapshot.globalDecision.fundsRecoveryManualEvidence
  }) + '\n');
}

if (require.main === module) runCli();

module.exports = {
  ACTION_KEYS,
  BASE_ANCHOR_SPECS,
  EVIDENCE_SPECS,
  EXACT_BASE,
  SNAPSHOT_PATH,
  actionAnchorIds,
  expectedEvidenceRefs,
  expectedGates,
  expectedRuntimeOwnership,
  inspectGitBackedFile,
  sha256File,
  validateReleaseEvidence
};
