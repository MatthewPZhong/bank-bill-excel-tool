'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const nodeTest = require('node:test');

const {
  ACTION_KEYS,
  AUTHORITY_MODULE_PATHS,
  EXACT_BASE,
  EXPECTED_BRANCH,
  EXPECTED_MAIN_REF_OID,
  MAX_JSON_NUMBER_TOKEN_LENGTH,
  RELEASE_EVIDENCE_PATHS,
  SNAPSHOT_PATH,
  bootstrapGitAuthorityGuard,
  inspectGitBackedFile,
  parseStrictJson,
  resolveExactTrackedModule,
  sha256,
  validateReleaseEvidence
} = require('../../../scripts/validate-v3-2-3-release-evidence');

const REPOSITORY_ROOT = path.resolve(__dirname, '../../..');
const SHARED_NODE_MODULES = path.join(REPOSITORY_ROOT, 'node_modules');
const EXACT_EVIDENCE_HEAD = '57fab04aab44d51d21cbf83e3878de9e87a77ad3';
const HISTORICAL_VALIDATOR_PATH = 'scripts/validate-v3-2-3-release-evidence.js';
const HISTORICAL_TEST_PATH = 'tests/unit/scripts/v3-2-3-release-evidence.test.js';
const HISTORICAL_VALIDATOR_BLOB = '591d6397253edc5878c53e1a735622a98578c507';
const HISTORICAL_TEST_BLOB = '820916a79370dfe26c7fd25893d6bb53c39c50dd';

function normalizeHistoricalGitRelativePath(platform, from, cwd, nativeRelative) {
  if (platform !== 'win32') return nativeRelative;
  const resolvedFrom = path.win32.resolve(from).toLowerCase();
  const resolvedCwd = path.win32.resolve(cwd).toLowerCase();
  if (resolvedFrom !== resolvedCwd || nativeRelative === '..' ||
      nativeRelative.startsWith('..\\') || nativeRelative.startsWith('../') ||
      path.win32.isAbsolute(nativeRelative)) {
    return nativeRelative;
  }
  return nativeRelative.split('\\').join('/');
}

function historicalGitPathPreloadSource() {
  return [
    "'use strict';",
    "const path = require('node:path');",
    normalizeHistoricalGitRelativePath.toString(),
    "if (process.platform === 'win32') {",
    "  const descriptor = Object.getOwnPropertyDescriptor(path, 'relative');",
    "  if (!descriptor || descriptor.writable !== true || descriptor.configurable !== true) {",
    "    throw new Error('HISTORICAL_GIT_PATH_ADAPTER_UNAVAILABLE');",
    "  }",
    "  const nativeRelative = path.relative.bind(path);",
    "  Object.defineProperty(path, 'relative', {",
    "    ...descriptor,",
    "    value(from, to) {",
    "      return normalizeHistoricalGitRelativePath(",
    "        process.platform, from, process.cwd(), nativeRelative(from, to)",
    "      );",
    "    }",
    "  });",
    "}",
    ""
  ].join('\n');
}

function createControlledNodeOptions(preloadPath) {
  assert.doesNotMatch(preloadPath, /[\0\r\n]/);
  return `--require ${JSON.stringify(preloadPath)}`;
}

function createHistoricalGitPathPreload(root, canonicalRepository) {
  const source = historicalGitPathPreloadSource();
  const preloadPath = path.join(root, 'historical git path adapter.cjs');
  const descriptor = fs.openSync(preloadPath, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, source, 'utf8');
  } finally {
    fs.closeSync(descriptor);
  }
  const stat = fs.lstatSync(preloadPath);
  assert.equal(stat.isFile(), true);
  assert.equal(stat.isSymbolicLink(), false);
  assert.equal(fs.readFileSync(preloadPath, 'utf8'), source);
  const canonicalPreloadPath = fs.realpathSync.native(preloadPath);
  const relativeToRepository = path.relative(canonicalRepository, canonicalPreloadPath);
  assert.ok(relativeToRepository === '..' || relativeToRepository.startsWith('..' + path.sep),
    relativeToRepository);
  return canonicalPreloadPath;
}

function readGit(repository, args) {
  const result = spawnSync('git', args, { cwd: repository, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

function assertHistoricalGitPathContract(repository) {
  assert.equal(runGit(repository, [
    'rev-parse', `${EXACT_EVIDENCE_HEAD}:${HISTORICAL_VALIDATOR_PATH}`
  ]), HISTORICAL_VALIDATOR_BLOB);
  assert.equal(runGit(repository, [
    'rev-parse', `${EXACT_EVIDENCE_HEAD}:${HISTORICAL_TEST_PATH}`
  ]), HISTORICAL_TEST_BLOB);
  const validatorSource = readGit(repository, [
    'show', `${EXACT_EVIDENCE_HEAD}:${HISTORICAL_VALIDATOR_PATH}`
  ]);
  const testSource = readGit(repository, [
    'show', `${EXACT_EVIDENCE_HEAD}:${HISTORICAL_TEST_PATH}`
  ]);
  assert.equal((validatorSource.match(/\bpath\.relative\s*\(/g) || []).length, 1);
  assert.equal((testSource.match(/\bpath\.relative\s*\(/g) || []).length, 0);
  assert.match(validatorSource,
    /const relative = path\.relative\(REPOSITORY_ROOT, absolutePath\);/);
  assert.match(validatorSource, /relative !== relativePath/);
  assert.match(testSource,
    /env: \{ \.\.\.process\.env, NODE_PATH: SHARED_NODE_MODULES \}/);
}

function assertHistoricalGitPathAdapterContract() {
  const cwd = 'C:\\Users\\runneradmin\\AppData\\Local\\Temp\\exact\\repo';
  const nested = path.win32.join(cwd, 'src', 'main-process', 'runtime.js');
  const nestedNative = path.win32.relative(cwd, nested);
  assert.equal(nestedNative, 'src\\main-process\\runtime.js');
  assert.equal(normalizeHistoricalGitRelativePath('win32', cwd, cwd, nestedNative),
    'src/main-process/runtime.js');

  const topLevelNative = path.win32.relative(cwd, path.win32.join(cwd, 'package.json'));
  assert.equal(normalizeHistoricalGitRelativePath('win32', cwd, cwd, topLevelNative),
    'package.json');

  const outsideNative = path.win32.relative(cwd, path.win32.join(cwd, '..', 'outside'));
  assert.equal(normalizeHistoricalGitRelativePath('win32', cwd, cwd, outsideNative),
    outsideNative);
  assert.equal(normalizeHistoricalGitRelativePath('win32', cwd, cwd, 'D:\\outside'),
    'D:\\outside');

  const offCwd = path.win32.join(cwd, 'nested');
  assert.equal(normalizeHistoricalGitRelativePath('win32', offCwd, cwd, nestedNative),
    nestedNative);
  assert.equal(normalizeHistoricalGitRelativePath('darwin', cwd, cwd, nestedNative),
    nestedNative);
}

function assertControlledPreloadInheritance(environment, cwd, preloadPath) {
  const cacheProbeSource = [
    "'use strict';",
    "const assert = require('node:assert/strict');",
    "const preload = process.env.V323_HISTORICAL_PRELOAD_PATH;",
    "assert.ok(require.cache[require.resolve(preload)]);"
  ].join('\n');
  const parentProbeSource = [
    cacheProbeSource,
    "const { spawnSync } = require('node:child_process');",
    `const childSource = ${JSON.stringify(cacheProbeSource)};`,
    "const child = spawnSync(process.execPath, ['-e', childSource], {",
    "  encoding: 'utf8',",
    "  env: { ...process.env }",
    "});",
    "assert.equal(child.status, 0, child.stderr || child.stdout);"
  ].join('\n');
  const result = spawnSync(process.execPath, ['-e', parentProbeSource], {
    cwd,
    encoding: 'utf8',
    env: {
      ...environment,
      V323_HISTORICAL_PRELOAD_PATH: preloadPath
    }
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function currentGitValue(args) {
  const result = spawnSync('git', args, { cwd: REPOSITORY_ROOT, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

const RUN_EXACT_SUITE = currentGitValue(['rev-parse', 'HEAD']) === EXACT_EVIDENCE_HEAD &&
  currentGitValue(['branch', '--show-current']) === EXPECTED_BRANCH;
const test = RUN_EXACT_SUITE ? nodeTest : () => {};

function loadSnapshot() {
  return JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8'));
}

function findAction(snapshot, actionKey) {
  return snapshot.actions.find((action) => action.actionKey === actionKey);
}

function errorCodes(result) {
  return result.errors.map((error) => error.code);
}

function runGit(repository, args) {
  const result = spawnSync('git', args, { cwd: repository, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function createCandidateRepository(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v323-release-evidence-'));
  const repository = path.join(root, 'repo');
  runGit(root, ['clone', '--quiet', '--shared', '--no-checkout', REPOSITORY_ROOT, repository]);
  runGit(repository, ['checkout', '--quiet', '-B', EXPECTED_BRANCH, options.parent || EXACT_BASE]);
  runGit(repository, ['update-ref', 'refs/heads/main', EXPECTED_MAIN_REF_OID]);
  for (const relativePath of RELEASE_EVIDENCE_PATHS) {
    const destination = path.join(repository, relativePath);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(REPOSITORY_ROOT, relativePath), destination);
  }
  if (options.rawSnapshot !== undefined) {
    fs.writeFileSync(path.join(repository,
      'changes/background-execution-r3-2-3-release-evidence/release-evidence.json'),
    options.rawSnapshot);
  }
  if (options.beforeCommit) options.beforeCommit(repository);
  runGit(repository, ['add', '-A']);
  runGit(repository, [
    '-c', 'user.name=R3.2.3 Test', '-c', 'user.email=r323@example.invalid',
    'commit', '--quiet', '-m', 'test: candidate release evidence'
  ]);
  if (options.afterCommit) options.afterCommit(repository);
  return { root, repository };
}

function runCandidateCli(repository) {
  return spawnSync(process.execPath, ['scripts/validate-v3-2-3-release-evidence.js'], {
    cwd: repository,
    encoding: 'utf8',
    env: { ...process.env, NODE_PATH: SHARED_NODE_MODULES }
  });
}

function cleanupCandidate(candidate) {
  fs.rmSync(candidate.root, { recursive: true, force: true });
}

function assertCliFailure(result, expectedCode) {
  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.equal(result.stderr, '');
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.status, 'FAIL');
  assert.ok(summary.errors.some((error) => error.code === expectedCode), result.stdout);
  assert.doesNotMatch(result.stdout, /6222021234567890/);
}

if (!RUN_EXACT_SUITE) {
  nodeTest('R3.2.3 历史 exact evidence 在原提交和原分支上完整复验', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v323-exact-evidence-'));
    try {
      const canonicalTempRoot = fs.realpathSync.native(root);
      const repository = path.join(canonicalTempRoot, 'repo');
      const sharedNodeModules = fs.realpathSync.native(SHARED_NODE_MODULES);
      assert.equal(fs.statSync(sharedNodeModules).isDirectory(), true);
      const nestedNodeModules = path.join(canonicalTempRoot, 'node_modules');
      fs.symlinkSync(sharedNodeModules, nestedNodeModules,
        process.platform === 'win32' ? 'junction' : 'dir');
      assert.equal(fs.lstatSync(nestedNodeModules).isSymbolicLink(), true);
      assert.equal(fs.realpathSync.native(nestedNodeModules), sharedNodeModules);

      runGit(canonicalTempRoot,
        ['clone', '--quiet', '--shared', '--no-checkout', REPOSITORY_ROOT, repository]);
      const canonicalRepository = fs.realpathSync.native(repository);
      runGit(canonicalRepository, ['checkout', '--quiet', '-B', EXPECTED_BRANCH, EXACT_EVIDENCE_HEAD]);
      runGit(canonicalRepository, ['update-ref', 'refs/heads/main', EXPECTED_MAIN_REF_OID]);
      assertHistoricalGitPathContract(canonicalRepository);
      assertHistoricalGitPathAdapterContract();
      const preloadPath = createHistoricalGitPathPreload(
        canonicalTempRoot, canonicalRepository
      );
      const controlledNodeOptions = createControlledNodeOptions(preloadPath);
      const nestedEnvironment = {
        ...process.env,
        NODE_OPTIONS: controlledNodeOptions,
        NODE_PATH: sharedNodeModules,
        TMP: canonicalTempRoot,
        TEMP: canonicalTempRoot,
        TMPDIR: canonicalTempRoot
      };
      delete nestedEnvironment.NODE_TEST_CONTEXT;
      assert.equal(nestedEnvironment.NODE_OPTIONS, controlledNodeOptions);
      assertControlledPreloadInheritance(
        nestedEnvironment, canonicalRepository, preloadPath
      );
      const result = spawnSync(
        process.execPath,
        [
          '--test',
          '--test-reporter=tap',
          'tests/unit/scripts/v3-2-3-release-evidence.test.js'
        ],
        {
          cwd: canonicalRepository,
          encoding: 'utf8',
          env: nestedEnvironment
        }
      );
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.match(result.stdout, /# tests 22\b/);
      assert.match(result.stdout, /# pass 22\b/);
      assert.match(result.stdout, /# fail 0\b/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      assert.equal(fs.existsSync(root), false);
      assert.equal(fs.statSync(SHARED_NODE_MODULES).isDirectory(), true);
    }
  });
}

test('文本hash不受Windows CRLF checkout影响', () => {
  assert.equal(sha256('a\r\nb\r\n'), sha256('a\nb\n'));
});

test('raw JSON在JSON.parse前拒绝所有scope的等价duplicate key', () => {
  for (const raw of [
    '{"a":1,"a":2}',
    '{"a":1,"\\u0061":2}',
    '{"é":1,"e\\u0301":2}',
    '{"outer":{"a":1,"\\u0061":2}}',
    '[{"a":1,"a":2}]'
  ]) {
    assert.throws(() => parseStrictJson(raw),
      (error) => error.code === 'RAW_JSON_DUPLICATE_KEY');
  }
  assert.deepEqual(parseStrictJson('{"left":{"same":1},"right":{"same":2}}'), {
    left: { same: 1 }, right: { same: 2 }
  });
});

test('raw JSON number token拒绝指数下溢、资金数字与非canonical表示', () => {
  assert.deepEqual(parseStrictJson('{"v":[0,1,-1,1.5,268435456]}'), {
    v: [0, 1, -1, 1.5, 268435456]
  });
  for (const [raw, code] of [
    ['6222021234567890e-999', 'RAW_JSON_FINANCIAL_NUMBER_FORBIDDEN'],
    ['{"nested":[6222021234567890e-999]}', 'RAW_JSON_FINANCIAL_NUMBER_FORBIDDEN'],
    ['1e3', 'RAW_JSON_NUMBER_NON_CANONICAL'],
    ['-0', 'RAW_JSON_NUMBER_NON_CANONICAL'],
    ['1.0', 'RAW_JSON_NUMBER_NON_CANONICAL'],
    ['1'.repeat(MAX_JSON_NUMBER_TOKEN_LENGTH + 1), 'RAW_JSON_NUMBER_TOO_LONG']
  ]) {
    assert.throws(() => parseStrictJson(raw), (error) => error.code === code);
  }
});

test('bootstrap Git authority锁定exact parent/branch/blob/type/mode/audit roots', () => {
  const result = bootstrapGitAuthorityGuard();
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.equal(result.facts.parent, EXACT_BASE);
  assert.equal(result.facts.branchName, EXPECTED_BRANCH);
  assert.equal(result.facts.mainRefOid, EXPECTED_MAIN_REF_OID);
  assert.equal(result.facts.trackedEntryCount, 2018);
  assert.equal(result.facts.auditRootTrackedEntryCount, 525);
  assert.equal(result.facts.indexState, 'HEAD_EXACT_DEFAULT_FLAGS');
  assert.equal(result.facts.worktreeTreeState, 'HEAD_EXACT');
  assert.equal(result.facts.auditRootState, 'HEAD_EXACT');
  assert.deepEqual(result.facts.changedPaths, RELEASE_EVIDENCE_PATHS);
});

test('authority modules只解析到HEAD中的exact .js路径', () => {
  assert.deepEqual(AUTHORITY_MODULE_PATHS, [
    'src/main-process/background-execution/runtime.js',
    'src/main-process/new-account/policies.js',
    'src/main-process/statement-worker/runtime-bindings.js'
  ]);
  for (const relativePath of AUTHORITY_MODULE_PATHS) {
    const resolved = resolveExactTrackedModule(relativePath);
    assert.equal(resolved.error, undefined);
    assert.equal(resolved.resolvedPath, path.join(REPOSITORY_ROOT, relativePath));
  }
  assert.equal(resolveExactTrackedModule(
    'src/main-process/background-execution/runtime'
  ).error.code, 'AUTHORITY_MODULE_PATH_INVALID');
});

test('Git reviewed evidence绑定真实ancestor head:path blob', () => {
  const valid = inspectGitBackedFile(
    EXACT_BASE,
    'changes/background-execution-v3.2.x-contract-baseline/changes/3.2.3/e10-b-implementation-notes.md'
  );
  assert.match(valid.blobOid, /^[a-f0-9]{40}$/);
  assert.match(valid.sha256, /^[a-f0-9]{64}$/);
  assert.match(inspectGitBackedFile('0'.repeat(40), 'package.json').error, /real commit/);
});

test('R3.2.3 snapshot锁定7 action、current disposition与runtime ownership', () => {
  const result = validateReleaseEvidence(loadSnapshot());
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.equal(result.actionCount, 7);
  assert.equal(result.productionEnabledCount, 0);
  const snapshot = loadSnapshot();
  assert.equal(snapshot.authority.statementCommonRuntime, 'ABSENT');
  assert.equal(snapshot.authority.newAccountRuntimeRegistration, 'REGISTERED');
  assert.deepEqual(Object.fromEntries(snapshot.actions.map((action) => [
    action.actionKey,
    action.runtimeOwnership.liveDisposition
  ])), {
    'statement:import': 'legacy-preserved',
    'statement:resolve-big-account': 'legacy-preserved',
    'statement:resolve-manual-balance': 'legacy-preserved',
    'statement:generate-current': 'legacy-preserved',
    'statement:generate-all': 'legacy-preserved',
    'new-account:generate': 'legacy-preserved',
    'new-account:save-as': 'inline-excluded'
  });
  assert.equal(snapshot.globalDecision.localMergeReady, true);
  assert.equal(snapshot.globalDecision.productionReady, false);

  const wrongSaveAsDisposition = loadSnapshot();
  findAction(wrongSaveAsDisposition, 'new-account:save-as')
    .runtimeOwnership.liveDisposition = 'legacy-preserved';
  assert.ok(errorCodes(validateReleaseEvidence(wrongSaveAsDisposition))
    .includes('RUNTIME_OWNERSHIP_DRIFT'));
});

test('validator CLI只读输出NOT READY人工门禁摘要', () => {
  const before = fs.readFileSync(SNAPSHOT_PATH, 'utf8');
  const result = spawnSync(process.execPath, ['scripts/validate-v3-2-3-release-evidence.js'], {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
    env: { ...process.env, NODE_PATH: SHARED_NODE_MODULES }
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(JSON.parse(result.stdout), {
    status: 'PASS',
    release: '3.2.3',
    baseCommit: EXACT_BASE,
    actionCount: 7,
    productionEnabledCount: 0,
    statementRegistration: 'DORMANT_MODULE_ENTRY_ONLY',
    statementCommonRuntime: 'ABSENT',
    newAccountRuntimeRegistration: 'REGISTERED',
    fixtureOverlayStatus: 'STATEMENT_EXACT_NEW_ACCOUNT_REVIEWED_OVERLAY',
    fixtureOverlayPathCount: 10,
    windowsPackagedEvidence: 'NOT_RUN',
    fundsRecoveryManualEvidence: 'PENDING_HUMAN_REVIEW',
    rssEvidence: 'LOCAL_DIRECTIONAL_ONLY',
    productionReady: false
  });
  assert.equal(fs.readFileSync(SNAPSHOT_PATH, 'utf8'), before);
});

test('Statement不能被snapshot伪报为common runtime REGISTERED', () => {
  const snapshot = loadSnapshot();
  snapshot.authority.statementRegistration = 'REGISTERED';
  snapshot.authority.statementCommonRuntime = 'REGISTERED';
  const action = findAction(snapshot, 'statement:import');
  action.runtimeOwnership.registrationStatus = 'REGISTERED';
  action.runtimeOwnership.commonRuntimeRegistration = 'REGISTERED';
  const result = validateReleaseEvidence(snapshot);
  assert.equal(result.valid, false);
  assert.ok(errorCodes(result).includes('SNAPSHOT_AUTHORITY_DRIFT'));
  assert.ok(errorCodes(result).includes('RUNTIME_OWNERSHIP_DRIFT'));
});

test('任一action production/live状态与global production-ready不能升级', () => {
  const snapshot = loadSnapshot();
  const action = findAction(snapshot, 'new-account:save-as');
  action.currentPolicy.production.enabled = true;
  action.currentPolicy.production.effectiveMode = 'inline-async';
  action.currentPolicy.production.effectiveWorkerCount = 1;
  action.runtimeOwnership.liveDisposition = 'managed';
  action.decision.enabled = true;
  snapshot.globalDecision.productionReady = true;
  const result = validateReleaseEvidence(snapshot);
  assert.equal(result.valid, false);
  for (const code of ['CURRENT_POLICY_DRIFT', 'RUNTIME_OWNERSHIP_DRIFT',
    'ACTION_DECISION_DRIFT', 'PRODUCTION_STATE_ENABLED', 'GLOBAL_DECISION_DRIFT']) {
    assert.ok(errorCodes(result).includes(code), code);
  }
});

test('7 action缺项/重复与跨action借证均fail closed', () => {
  const missing = loadSnapshot();
  missing.actions.splice(1, 1);
  missing.actions.push(missing.actions[0]);
  assert.ok(errorCodes(validateReleaseEvidence(missing)).includes('ACTION_SET_DRIFT'));

  const borrowed = loadSnapshot();
  findAction(borrowed, 'new-account:generate').evidenceRefs = ['E10-B-NEW-ACCOUNT-SAVE-AS'];
  const result = validateReleaseEvidence(borrowed);
  assert.equal(result.valid, false);
  assert.ok(errorCodes(result).includes('ACTION_EVIDENCE_SCOPE_DRIFT'));
});

test('E09-P0/A/B/C/D、E10-A/B、RSS/cancel/recovery coverage不能删除或代换', () => {
  const snapshot = loadSnapshot();
  assert.deepEqual(snapshot.automatedCoverage.map((item) => item.gate), [
    'E09-P0', 'E09-A', 'E09-B', 'E09-C', 'E09-D', 'E10-A', 'E10-B',
    'RSS', 'CANCEL', 'RECOVERY'
  ]);
  snapshot.automatedCoverage.pop();
  snapshot.automatedCoverage[7].evidenceRefs = ['E10-B-NEW-ACCOUNT-SAVE-AS'];
  assert.ok(errorCodes(validateReleaseEvidence(snapshot)).includes('AUTOMATED_COVERAGE_DRIFT'));
});

test('snapshot reviewed head/source/blob/hash任一漂移fail closed', () => {
  const snapshot = loadSnapshot();
  Object.assign(snapshot.evidenceCatalog[5], {
    reviewedHead: '0'.repeat(40), source: 'package.json',
    blobOid: '1'.repeat(40), sha256: '2'.repeat(64)
  });
  const result = validateReleaseEvidence(snapshot);
  assert.equal(result.valid, false);
  assert.ok(errorCodes(result).includes('EVIDENCE_METADATA_DRIFT'));
});

test('Windows/资金/恢复/Excel-WPS gate保持PENDING或NOT RUN', () => {
  const snapshot = loadSnapshot();
  const action = findAction(snapshot, 'statement:resolve-manual-balance');
  for (const key of ['windowsPackaged', 'realBusinessSamples', 'funds', 'recovery', 'excelWps']) {
    action.gates[key] = 'PASS';
  }
  snapshot.globalDecision.windowsPackagedEvidence = 'PASS';
  snapshot.globalDecision.fundsRecoveryEvidence = 'PASS';
  const result = validateReleaseEvidence(snapshot);
  assert.equal(result.valid, false);
  assert.ok(errorCodes(result).includes('ACTION_GATE_DRIFT'));
  assert.ok(errorCodes(result).includes('GLOBAL_DECISION_DRIFT'));
});

test('rollback不能允许production mutation或丢失legacy/receipt hold保护', () => {
  const snapshot = loadSnapshot();
  const action = findAction(snapshot, 'new-account:save-as');
  action.rollback.preserveLegacySelector = false;
  action.rollback.preserveReceiptsAndRecoveryHolds = false;
  action.rollback.productionMutationAllowed = true;
  assert.ok(errorCodes(validateReleaseEvidence(snapshot)).includes('ROLLBACK_CONTRACT_DRIFT'));
});

test('metadata snapshot拒绝raw账号/金额/business row', () => {
  const snapshot = loadSnapshot();
  findAction(snapshot, 'statement:import').rollback.rawAccount = '6222021234567890';
  findAction(snapshot, 'new-account:generate').rollback.note = '金额：12.34';
  const result = validateReleaseEvidence(snapshot);
  assert.equal(result.valid, false);
  assert.ok(errorCodes(result).some((code) => code.startsWith('PRIVACY_')));
  assert.doesNotMatch(JSON.stringify(result), /6222021234567890/);
});

test('CLI duplicate key与指数下溢固定code且不回显sentinel', () => {
  for (const [rawSnapshot, code] of [
    ['{"ACCOUNT_6222021234567890":1,"\\u0041CCOUNT_6222021234567890":2}',
      'RAW_JSON_DUPLICATE_KEY'],
    ['{"nested":[6222021234567890e-999]}', 'RAW_JSON_FINANCIAL_NUMBER_FORBIDDEN']
  ]) {
    const candidate = createCandidateRepository({ rawSnapshot });
    try {
      assertCliFailure(runCandidateCli(candidate.repository), code);
    } finally {
      cleanupCandidate(candidate);
    }
  }
});

test('真实Git反例：wrong parent、extra path、hidden index flag、ignored audit shim', async (t) => {
  const cases = [
    {
      name: 'wrong parent', expected: 'GIT_PARENT_SHAPE_INVALID',
      parent: EXPECTED_MAIN_REF_OID
    },
    {
      name: 'extra committed path', expected: 'GIT_CHANGED_PATHS_INVALID',
      beforeCommit(repository) {
        fs.writeFileSync(path.join(repository, 'EXTRA_RELEASE_FILE'), 'forbidden\n');
      }
    },
    {
      name: 'assume unchanged hidden drift', expected: 'GIT_INDEX_FLAGS_INVALID',
      afterCommit(repository) {
        const target = 'src/main-process/background-execution/runtime.js';
        runGit(repository, ['update-index', '--assume-unchanged', target]);
        fs.appendFileSync(path.join(repository, target), '\nRUNTIME_SENTINEL(\n');
      }
    },
    {
      name: 'ignored src/backend extensionless shim', expected: 'GIT_AUDIT_ROOT_EXTRA_ENTRY',
      afterCommit(repository) {
        const relative = 'src/backend/big-table-import/zip-reader';
        fs.appendFileSync(path.join(repository, '.git/info/exclude'), '\n/' + relative + '\n');
        fs.writeFileSync(path.join(repository, relative), 'module.exports = {};\n');
      }
    }
  ];
  for (const item of cases) {
    await t.test(item.name, () => {
      const candidate = createCandidateRepository(item);
      try {
        assertCliFailure(runCandidateCli(candidate.repository), item.expected);
      } finally {
        cleanupCandidate(candidate);
      }
    });
  }
});
