'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const {
  ACTION_KEYS,
  AUTHORITY_MODULE_PATHS,
  EXACT_BASE,
  EXPECTED_BRANCH,
  EXPECTED_MAIN_REF_OID,
  MAX_CLI_ERRORS,
  MAX_JSON_NUMBER_TOKEN_LENGTH,
  MAX_SNAPSHOT_BYTES,
  RELEASE_EVIDENCE_PATHS,
  SNAPSHOT_PATH,
  VERSIONED_POLICY_AUTHORITY_SOURCE,
  bootstrapGitAuthorityGuard,
  inspectGitBackedFile,
  parseStrictJson,
  resolveExactTrackedModule,
  sha256,
  validateReleaseEvidence
} = require('../../../scripts/validate-v3-2-4-release-evidence');

const REPOSITORY_ROOT = path.resolve(__dirname, '../../..');

function loadSnapshot() {
  return JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8'));
}

function actionIndex(actionKey) {
  return ACTION_KEYS.indexOf(actionKey);
}

function findAction(snapshot, actionKey) {
  return snapshot.actions.find((action) => action.actionKey === actionKey);
}

function errorPaths(result) {
  return result.errors.map((error) => error.path);
}

function runGit(repository, args) {
  const result = spawnSync('git', args, { cwd: repository, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function copyReleaseEvidenceFiles(repository, skippedPaths = []) {
  for (const relativePath of RELEASE_EVIDENCE_PATHS) {
    if (skippedPaths.includes(relativePath)) continue;
    const destination = path.join(repository, relativePath);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(REPOSITORY_ROOT, relativePath), destination);
  }
}

function createCandidateRepository(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v324-evidence-git-'));
  const repository = path.join(root, 'repo');
  runGit(root, ['clone', '--quiet', '--shared', '--no-checkout', REPOSITORY_ROOT, repository]);
  runGit(repository, ['checkout', '--quiet', '-B', EXPECTED_BRANCH, options.parent || EXACT_BASE]);
  runGit(repository, ['update-ref', 'refs/heads/main', EXPECTED_MAIN_REF_OID]);
  copyReleaseEvidenceFiles(repository, options.skippedPaths || []);
  if (options.rawSnapshot !== undefined) {
    fs.writeFileSync(path.join(repository,
      'changes/background-execution-r3-2-4-release-evidence/release-evidence.json'),
    options.rawSnapshot);
  }
  if (options.beforeCommit) options.beforeCommit(repository);
  runGit(repository, ['add', '-A']);
  runGit(repository, [
    '-c', 'user.name=R3.2.4 Test', '-c', 'user.email=r324@example.invalid',
    'commit', '--quiet', '-m', 'test: candidate release evidence'
  ]);
  if (options.afterCommit) options.afterCommit(repository);
  return { root, repository };
}

function runCandidateCli(repository) {
  return spawnSync(process.execPath, ['scripts/validate-v3-2-4-release-evidence.js'], {
    cwd: repository,
    encoding: 'utf8'
  });
}

function cleanupCandidate(candidate) {
  fs.rmSync(candidate.root, { recursive: true, force: true });
}

function ignoreCandidatePath(repository, relativePath) {
  fs.appendFileSync(path.join(repository, '.git/info/exclude'), '\n/' + relativePath + '\n');
}

function assertCliFailure(result, expectedCode) {
  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.equal(result.stderr, '');
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.status, 'FAIL');
  assert.ok(summary.errors.some((error) => error.code === expectedCode), result.stdout);
  assert.ok(summary.errors.length <= MAX_CLI_ERRORS);
  for (const error of summary.errors) {
    assert.match(error.code, /^[A-Z0-9_]{1,64}$/);
    assert.match(error.path, /^\/[A-Za-z0-9/_-]{0,95}$/);
  }
  return summary;
}

test('release evidence文本hash不受Windows CRLF checkout影响', () => {
  assert.equal(sha256('line-1\r\nline-2\r\n'), sha256('line-1\nline-2\n'));
});

test('raw JSON lexer在JSON.parse前拒绝所有对象层级的等价重复key', async (t) => {
  const duplicateCases = [
    '{"a":1,"a":2}',
    '{"a":1,"\\u0061":2}',
    '{"é":1,"e\\u0301":2}',
    '{"outer":{"a":1,"\\u0061":2}}',
    '[{"a":1,"a":2}]'
  ];
  for (const [index, raw] of duplicateCases.entries()) {
    await t.test(String(index), () => {
      assert.throws(
        () => parseStrictJson(raw),
        (error) => error.code === 'RAW_JSON_DUPLICATE_KEY' &&
          /^\/json\/offset\/\d+$/.test(error.path)
      );
    });
  }
  assert.deepEqual(parseStrictJson('{"left":{"same":1},"right":{"same":2}}'), {
    left: { same: 1 },
    right: { same: 2 }
  });
});

test('raw JSON lexer对malformed、oversized与过深输入fail closed', () => {
  assert.throws(
    () => parseStrictJson('{"a":'),
    (error) => error.code === 'RAW_JSON_MALFORMED'
  );
  assert.throws(
    () => parseStrictJson('{"a":01}'),
    (error) => error.code === 'RAW_JSON_MALFORMED'
  );
  assert.throws(
    () => parseStrictJson(' '.repeat(MAX_SNAPSHOT_BYTES + 1)),
    (error) => error.code === 'RAW_JSON_TOO_LARGE'
  );
  const tooDeep = '['.repeat(130) + '0' + ']'.repeat(130);
  assert.throws(
    () => parseStrictJson(tooDeep),
    (error) => error.code === 'RAW_JSON_TOO_DEEP'
  );
});

test('raw JSON number token在JSON.parse前拒绝资金数字、指数与非canonical表示', () => {
  assert.deepEqual(parseStrictJson('{"values":[0,1,-1,1.5,-1.5,268435456]}'), {
    values: [0, 1, -1, 1.5, -1.5, 268435456]
  });
  const invalidCases = [
    ['6222021234567890e-999', 'RAW_JSON_FINANCIAL_NUMBER_FORBIDDEN'],
    ['{"nested":[6222021234567890e-999]}', 'RAW_JSON_FINANCIAL_NUMBER_FORBIDDEN'],
    ['1e3', 'RAW_JSON_NUMBER_NON_CANONICAL'],
    ['-0', 'RAW_JSON_NUMBER_NON_CANONICAL'],
    ['1.0', 'RAW_JSON_NUMBER_NON_CANONICAL'],
    ['0.10', 'RAW_JSON_NUMBER_NON_CANONICAL'],
    ['1'.repeat(MAX_JSON_NUMBER_TOKEN_LENGTH + 1), 'RAW_JSON_NUMBER_TOO_LONG']
  ];
  for (const [raw, code] of invalidCases) {
    assert.throws(
      () => parseStrictJson(raw),
      (error) => error.code === code && /^\/json\/offset\/\d+$/.test(error.path)
    );
  }
});

test('bootstrap Git guard锁定single-parent、exact branch/path与clean tracked state', () => {
  const result = bootstrapGitAuthorityGuard();
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.equal(result.facts.parent, EXACT_BASE);
  assert.equal(result.facts.branchName, EXPECTED_BRANCH);
  assert.equal(result.facts.mainRefOid, EXPECTED_MAIN_REF_OID);
  assert.equal(result.facts.trackedEntryCount, 1913);
  assert.equal(result.facts.auditRootTrackedEntryCount, 656);
  assert.equal(result.facts.auditRootState, 'HEAD_EXACT');
  assert.equal(result.facts.indexState, 'HEAD_EXACT_DEFAULT_FLAGS');
  assert.equal(result.facts.worktreeTreeState, 'HEAD_EXACT');
  assert.equal(result.facts.untrackedState, 'CLEAN');
  assert.equal(result.facts.trackedState, 'CLEAN');
  assert.deepEqual(result.facts.changedPaths, RELEASE_EVIDENCE_PATHS);
});

test('Git攻击反例在加载可变runtime前fail closed', async (t) => {
  const cases = [
    {
      name: 'extra src/main.js commit',
      expectedCode: 'GIT_PARENT_SHAPE_INVALID',
      afterCommit(repository) {
        fs.appendFileSync(path.join(repository, 'src/main.js'), '\n// forbidden extra commit\n');
        runGit(repository, ['add', 'src/main.js']);
        runGit(repository, [
          '-c', 'user.name=R3.2.4 Test', '-c', 'user.email=r324@example.invalid',
          'commit', '--quiet', '-m', 'test: forbidden production change'
        ]);
      }
    },
    {
      name: 'dirty selector',
      expectedCode: 'GIT_TRACKED_STATE_DIRTY',
      afterCommit(repository) {
        fs.appendFileSync(
          path.join(repository, 'src/main-process/background-execution/runtime.js'),
          '\nRUNTIME_LOAD_SENTINEL(\n'
        );
      }
    },
    {
      name: 'staged selector',
      expectedCode: 'GIT_TRACKED_STATE_DIRTY',
      afterCommit(repository) {
        const selector = 'src/main-process/background-execution/runtime.js';
        fs.appendFileSync(path.join(repository, selector), '\nRUNTIME_LOAD_SENTINEL(\n');
        runGit(repository, ['add', selector]);
      }
    },
    {
      name: 'assume-unchanged flag',
      expectedCode: 'GIT_INDEX_FLAGS_INVALID',
      afterCommit(repository) {
        runGit(repository, [
          'update-index', '--assume-unchanged',
          'src/main-process/background-execution/runtime.js'
        ]);
      }
    },
    {
      name: 'skip-worktree flag',
      expectedCode: 'GIT_INDEX_FLAGS_INVALID',
      afterCommit(repository) {
        runGit(repository, [
          'update-index', '--skip-worktree',
          'src/main-process/background-execution/runtime.js'
        ]);
      }
    },
    {
      name: 'hidden blob drift',
      expectedCode: 'GIT_WORKTREE_TREE_INVALID',
      afterCommit(repository) {
        const selector = 'src/main-process/background-execution/runtime.js';
        fs.appendFileSync(path.join(repository, selector), '\nRUNTIME_LOAD_SENTINEL(\n');
        runGit(repository, ['update-index', '--assume-unchanged', selector]);
      }
    },
    {
      name: 'hidden mode drift',
      expectedCode: 'GIT_WORKTREE_TREE_INVALID',
      afterCommit(repository) {
        const selector = 'src/main-process/background-execution/runtime.js';
        fs.chmodSync(path.join(repository, selector), 0o755);
        runGit(repository, ['update-index', '--assume-unchanged', selector]);
      }
    },
    {
      name: 'hidden symlink replacement',
      expectedCode: 'GIT_WORKTREE_TREE_INVALID',
      afterCommit(repository) {
        const selector = 'src/main-process/background-execution/runtime.js';
        fs.unlinkSync(path.join(repository, selector));
        fs.symlinkSync('../../main.js', path.join(repository, selector));
        runGit(repository, ['update-index', '--skip-worktree', selector]);
      }
    },
    {
      name: 'staged and hidden selector',
      expectedCode: 'GIT_INDEX_TREE_INVALID',
      afterCommit(repository) {
        const selector = 'src/main-process/background-execution/runtime.js';
        fs.appendFileSync(path.join(repository, selector), '\nRUNTIME_LOAD_SENTINEL(\n');
        runGit(repository, ['add', selector]);
        runGit(repository, ['update-index', '--assume-unchanged', selector]);
      }
    },
    {
      name: 'untracked authority sibling',
      expectedCode: 'GIT_UNTRACKED_STATE_INVALID',
      afterCommit(repository) {
        fs.writeFileSync(
          path.join(repository, 'src/main-process/background-execution/runtime-override.js'),
          'RUNTIME_LOAD_SENTINEL(\n'
        );
      }
    },
    {
      name: 'extra staged index entry',
      expectedCode: 'GIT_INDEX_TREE_INVALID',
      afterCommit(repository) {
        const extra = 'src/main-process/background-execution/runtime-override.js';
        fs.writeFileSync(path.join(repository, extra), 'RUNTIME_LOAD_SENTINEL(\n');
        runGit(repository, ['add', extra]);
      }
    },
    {
      name: 'ignored extensionless top-level runtime shim',
      expectedCode: 'GIT_AUDIT_ROOT_EXTRA_ENTRY',
      afterCommit(repository) {
        const shim = 'src/main-process/background-execution/runtime';
        ignoreCandidatePath(repository, shim);
        fs.writeFileSync(path.join(repository, shim), 'RUNTIME_LOAD_SENTINEL(\n');
      }
    },
    {
      name: 'ignored adjacent js and json files',
      expectedCode: 'GIT_AUDIT_ROOT_EXTRA_ENTRY',
      afterCommit(repository) {
        const jsFile = 'src/main-process/background-execution/runtime.attack.js';
        const jsonFile = 'src/main-process/background-execution/runtime.attack.json';
        ignoreCandidatePath(repository, jsFile);
        ignoreCandidatePath(repository, jsonFile);
        fs.writeFileSync(path.join(repository, jsFile), 'RUNTIME_LOAD_SENTINEL(\n');
        fs.writeFileSync(path.join(repository, jsonFile), '{"sentinel":true}\n');
      }
    },
    {
      name: 'ignored nested extensionless dependency shim',
      expectedCode: 'GIT_AUDIT_ROOT_EXTRA_ENTRY',
      afterCommit(repository) {
        const shim = 'src/main-process/background-execution/execution-policy-registry';
        ignoreCandidatePath(repository, shim);
        fs.writeFileSync(path.join(repository, shim), 'RUNTIME_LOAD_SENTINEL(\n');
      }
    },
    {
      name: 'main ref drift',
      expectedCode: 'GIT_MAIN_REF_INVALID',
      afterCommit(repository) {
        runGit(repository, ['update-ref', 'refs/heads/main', 'HEAD']);
      }
    },
    {
      name: 'tag ref drift',
      expectedCode: 'GIT_TAG_REFS_INVALID',
      afterCommit(repository) {
        runGit(repository, ['tag', 'forbidden-release-tag', EXACT_BASE]);
      }
    },
    {
      name: 'wrong parent',
      parent: EXACT_BASE + '^',
      expectedCode: 'GIT_PARENT_SHAPE_INVALID'
    },
    {
      name: 'same-commit extra path',
      expectedCode: 'GIT_CHANGED_PATHS_INVALID',
      beforeCommit(repository) {
        fs.appendFileSync(path.join(repository, 'src/main.js'), '\n// forbidden same commit\n');
      }
    },
    {
      name: 'rename',
      skippedPaths: [
        'changes/background-execution-r3-2-4-release-evidence/preflight.md'
      ],
      expectedCode: 'GIT_CHANGED_PATHS_INVALID',
      beforeCommit(repository) {
        const target = 'changes/background-execution-r3-2-4-release-evidence/preflight.md';
        fs.mkdirSync(path.dirname(path.join(repository, target)), { recursive: true });
        runGit(repository, ['mv', 'README.md', target]);
      }
    },
    {
      name: 'extra empty commit',
      expectedCode: 'GIT_PARENT_SHAPE_INVALID',
      afterCommit(repository) {
        runGit(repository, [
          '-c', 'user.name=R3.2.4 Test', '-c', 'user.email=r324@example.invalid',
          'commit', '--quiet', '--allow-empty', '-m', 'test: forbidden extra commit'
        ]);
      }
    }
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, () => {
      const candidate = createCandidateRepository(testCase);
      try {
        const result = runCandidateCli(candidate.repository);
        assertCliFailure(result, testCase.expectedCode);
        assert.doesNotMatch(result.stdout + result.stderr, /RUNTIME_LOAD_SENTINEL/);
      } finally {
        cleanupCandidate(candidate);
      }
    });
  }
});

test('root node_modules与logs的正常ignored内容不扩张审计根', () => {
  const candidate = createCandidateRepository({
    afterCommit(repository) {
      const moduleFile = path.join(repository, 'node_modules/ignored-helper/index.js');
      const logFile = path.join(repository, 'logs/ignored-validator.log');
      fs.mkdirSync(path.dirname(moduleFile), { recursive: true });
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      fs.writeFileSync(moduleFile, 'module.exports = {};\n');
      fs.writeFileSync(logFile, 'ignored log\n');
    }
  });
  try {
    const result = runCandidateCli(candidate.repository);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(JSON.parse(result.stdout).status, 'PASS');
  } finally {
    cleanupCandidate(candidate);
  }
});

test('顶层repo authority modules仅解析到HEAD中的exact .js绝对路径', () => {
  assert.deepEqual(AUTHORITY_MODULE_PATHS, [
    'src/main-process/background-execution/runtime.js',
    'src/main-process/recon-id-fix-service/policies.js',
    'src/main-process/vcc-financial-op-output/policies.js'
  ]);
  for (const relativePath of AUTHORITY_MODULE_PATHS) {
    const result = resolveExactTrackedModule(relativePath);
    assert.equal(result.error, undefined);
    assert.equal(result.resolvedPath, path.join(REPOSITORY_ROOT, relativePath));
  }
  assert.equal(resolveExactTrackedModule(
    'src/main-process/background-execution/runtime'
  ).error.code, 'AUTHORITY_MODULE_PATH_INVALID');
});

test('runtime authority加载后发生tracked漂移时二次guard阻止PASS', () => {
  const runtimePath = path.join(
    REPOSITORY_ROOT,
    'src/main-process/background-execution/runtime.js'
  );
  const original = fs.readFileSync(runtimePath);
  try {
    const result = validateReleaseEvidence(loadSnapshot(), {
      afterPolicyLoadForTest() {
        fs.appendFileSync(runtimePath, '\nRUNTIME_LOAD_SENTINEL(\n');
      }
    });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((error) => error.code === 'GIT_POST_LOAD_AUTHORITY_DRIFT'));
    assert.ok(result.errors.some((error) => error.code === 'GIT_WORKTREE_TREE_INVALID'));
  } finally {
    fs.writeFileSync(runtimePath, original);
  }
  assert.equal(bootstrapGitAuthorityGuard().valid, true);
});

test('Git evidence只接受冻结base祖先中的真实reviewedHead:path blob', () => {
  const valid = inspectGitBackedFile(
    EXACT_BASE,
    'changes/background-execution-e12-c-vcc-dual-writer-restacked/implementation-notes.md'
  );
  assert.match(valid.blobOid, /^[a-f0-9]{40}$/);
  assert.match(valid.sha256, /^[a-f0-9]{64}$/);
  assert.match(inspectGitBackedFile('0'.repeat(40), 'package.json').error, /real commit/);
  assert.match(inspectGitBackedFile(EXACT_BASE, 'missing/evidence.md').error, /does not resolve/);
});

test('R3.2.4 snapshot锁定6 action、runtime与reviewed evidence', () => {
  const result = validateReleaseEvidence(loadSnapshot());
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.equal(result.actionCount, 6);
  assert.equal(result.productionEnabledCount, 0);
  assert.equal(result.versionedPolicyAuthorityCount, 1);
});

test('validator CLI只读并输出有界machine-readable摘要', () => {
  const before = fs.readFileSync(SNAPSHOT_PATH, 'utf8');
  const beforeMtime = fs.statSync(SNAPSHOT_PATH).mtimeMs;
  const result = spawnSync(
    process.execPath,
    ['scripts/validate-v3-2-4-release-evidence.js'],
    { cwd: REPOSITORY_ROOT, encoding: 'utf8' }
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(JSON.parse(result.stdout), {
    status: 'PASS',
    release: '3.2.4',
    baseCommit: EXACT_BASE,
    actionCount: 6,
    productionEnabledCount: 0,
    runtimeRegistration: 'REGISTERED',
    policyFixtureStatus: 'VERSIONED_CANONICAL_EXACT',
    versionedPolicyAuthorityCount: 1,
    windowsPackagedEvidence: 'NOT_RUN',
    fundsRecoveryManualEvidence: 'PENDING_HUMAN_REVIEW',
    e12cPerformanceEvidence: 'LOCAL_SYNTHETIC_ONLY'
  });
  assert.equal(fs.readFileSync(SNAPSHOT_PATH, 'utf8'), before);
  assert.equal(fs.statSync(SNAPSHOT_PATH).mtimeMs, beforeMtime);
});

test('CLI对duplicate raw JSON只输出固定code且不回显敏感sentinel', () => {
  const sentinel = 'ACCOUNT_SENTINEL_6222021234567890';
  const rawSnapshot = '{"' + sentinel + '":1,"\\u0041CCOUNT_SENTINEL_6222021234567890":2}';
  const candidate = createCandidateRepository({ rawSnapshot });
  try {
    const result = runCandidateCli(candidate.repository);
    const summary = assertCliFailure(result, 'RAW_JSON_DUPLICATE_KEY');
    assert.doesNotMatch(result.stdout + result.stderr + JSON.stringify(summary), new RegExp(sentinel));
  } finally {
    cleanupCandidate(candidate);
  }
});

test('CLI对敏感指数下溢与nested number只输出固定脱敏code', () => {
  const sensitiveNumber = '6222021234567890e-999';
  const candidate = createCandidateRepository({
    rawSnapshot: '{"nested":[' + sensitiveNumber + ']}'
  });
  try {
    const result = runCandidateCli(candidate.repository);
    const summary = assertCliFailure(result, 'RAW_JSON_FINANCIAL_NUMBER_FORBIDDEN');
    const combined = result.stdout + result.stderr + JSON.stringify(summary);
    assert.doesNotMatch(combined, /6222021234567890/);
    assert.doesNotMatch(combined, /e-999/);
  } finally {
    cleanupCandidate(candidate);
  }
});

test('CLI文件级拒绝指数与超长token，canonical负数/小数留给schema fail closed', async (t) => {
  const cases = [
    { name: 'negative canonical', token: '-1', expectedCode: 'RELEASE_IDENTITY_DRIFT' },
    { name: 'decimal canonical', token: '1.5', expectedCode: 'RELEASE_IDENTITY_DRIFT' },
    { name: 'exponent', token: '1e0', expectedCode: 'RAW_JSON_NUMBER_NON_CANONICAL' },
    {
      name: 'overlong',
      token: '1'.repeat(MAX_JSON_NUMBER_TOKEN_LENGTH + 1),
      expectedCode: 'RAW_JSON_NUMBER_TOO_LONG'
    }
  ];
  for (const testCase of cases) {
    await t.test(testCase.name, () => {
      const rawSnapshot = fs.readFileSync(SNAPSHOT_PATH, 'utf8').replace(
        '"schemaVersion": 1',
        '"schemaVersion": ' + testCase.token
      );
      const candidate = createCandidateRepository({ rawSnapshot });
      try {
        const result = runCandidateCli(candidate.repository);
        assertCliFailure(result, testCase.expectedCode);
        assert.doesNotMatch(result.stdout + result.stderr, new RegExp(testCase.token.replace(
          /[.*+?^${}()|[\]\\]/g,
          '\\$&'
        )));
      } finally {
        cleanupCandidate(candidate);
      }
    });
  }
});

test('CLI多隐私错误与超长key按数量/长度限流且绝不回显输入', () => {
  const sentinel = 'PRIVATE_SENTINEL_6222021234567890';
  const snapshot = loadSnapshot();
  snapshot.auditMetadata = {};
  for (let index = 0; index < 64; index += 1) {
    snapshot.auditMetadata['rawAccount' + sentinel + 'X'.repeat(2048) + index] =
      'account: 6222021234567890';
  }
  const candidate = createCandidateRepository({ rawSnapshot: JSON.stringify(snapshot) });
  try {
    const result = runCandidateCli(candidate.repository);
    const summary = assertCliFailure(result, 'PRIVACY_RAW_KEY_FORBIDDEN');
    assert.equal(summary.errors.length, MAX_CLI_ERRORS);
    const combined = result.stdout + result.stderr + JSON.stringify(summary);
    assert.doesNotMatch(combined, new RegExp(sentinel));
    assert.doesNotMatch(combined, /6222021234567890/);
    assert.ok(Buffer.byteLength(result.stdout, 'utf8') <= 4097);
  } finally {
    cleanupCandidate(candidate);
  }
});

test('任一action production或live状态不能被release snapshot误启用', () => {
  const snapshot = loadSnapshot();
  const action = findAction(snapshot, 'recon-fix:run-jpm');
  action.currentPolicy.production.enabled = true;
  action.currentPolicy.production.effectiveMode = 'thread-single';
  action.currentPolicy.production.effectiveWorkerCount = 1;
  action.runtimeOwnership.liveDisposition = 'managed';
  action.runtimeOwnership.effectiveMode = 'thread-single';
  action.runtimeOwnership.effectiveWorkerCount = 1;
  action.decision.enabled = true;
  const result = validateReleaseEvidence(snapshot);
  const index = actionIndex(action.actionKey);
  assert.equal(result.valid, false);
  assert.ok(errorPaths(result).includes('/actions/' + index + '/currentPolicy'));
  assert.ok(errorPaths(result).includes('/actions/' + index + '/runtimeOwnership'));
  assert.ok(errorPaths(result).includes('/actions/' + index + '/decision'));
  assert.ok(errorPaths(result).includes('/actions/' + index + '/production'));
});

test('E12-C topology不能在snapshot回退到stale fixture的4 Writer', () => {
  const snapshot = loadSnapshot();
  const action = findAction(snapshot, 'vcc-financial-op:export-subjects');
  action.currentPolicy.topology.phase.cpuSlots = 1;
  action.currentPolicy.topology.phase.workerThreadSlots = 1;
  action.currentPolicy.topology.phase.ioHeavySlots = 1;
  action.currentPolicy.topology.phase.memoryBytes = 268435456;
  action.currentPolicy.topology.compound.childrenMax = 4;
  action.currentPolicy.topology.workUnits.requestedMaxWorkers = 4;
  const result = validateReleaseEvidence(snapshot);
  assert.equal(result.valid, false);
  assert.ok(errorPaths(result).includes(
    '/actions/' + actionIndex(action.actionKey) + '/currentPolicy'
  ));
});

test('版本级canonical authority不能退化为字段overlay', () => {
  const snapshot = loadSnapshot();
  snapshot.authority.versionedPolicyAuthority.sha256 = '0'.repeat(64);
  snapshot.authority.policyFixtureStatus = 'REVIEWED_IMPLEMENTATION_OVERLAY';
  const result = validateReleaseEvidence(snapshot);
  assert.equal(result.valid, false);
  assert.ok(errorPaths(result).includes('/authority'));
});

test('版本级canonical authority回退到4 Writer时CLI fail closed', () => {
  const candidate = createCandidateRepository({
    beforeCommit(repository) {
      const authorityPath = path.join(repository, VERSIONED_POLICY_AUTHORITY_SOURCE);
      const authority = JSON.parse(fs.readFileSync(authorityPath, 'utf8'));
      authority.policy.resources.compound.childrenMax = 4;
      authority.policy.workUnits.requestedMaxWorkers = 4;
      fs.writeFileSync(authorityPath, JSON.stringify(authority, null, 2) + '\n');
    }
  });
  try {
    const result = runCandidateCli(candidate.repository);
    assertCliFailure(result, 'VERSIONED_POLICY_AUTHORITY_DRIFT');
  } finally {
    cleanupCandidate(candidate);
  }
});

test('action顺序、缺项或重复不能由其它action证据代偿', () => {
  const snapshot = loadSnapshot();
  snapshot.actions.splice(1, 1);
  snapshot.actions.push(snapshot.actions[0]);
  const result = validateReleaseEvidence(snapshot);
  assert.equal(result.valid, false);
  assert.ok(errorPaths(result).includes('/actions/actionKeys'));
});

test('action-scoped evidence不能被另一action借用', () => {
  const snapshot = loadSnapshot();
  findAction(snapshot, 'recon-fix:export').evidenceRefs = ['E12-A-VCC-SINGLE'];
  const result = validateReleaseEvidence(snapshot);
  assert.equal(result.valid, false);
  assert.ok(errorPaths(result).includes(
    '/actions/' + actionIndex('recon-fix:export') + '/evidenceRefs'
  ));
});

test('reviewed head、source、blob OID与hash任一漂移均fail closed', () => {
  const snapshot = loadSnapshot();
  const evidence = snapshot.evidenceCatalog[4];
  evidence.reviewedHead = '0'.repeat(40);
  evidence.source = 'package.json';
  evidence.blobOid = '1'.repeat(40);
  evidence.sha256 = '2'.repeat(64);
  const result = validateReleaseEvidence(snapshot);
  assert.equal(result.valid, false);
  assert.ok(errorPaths(result).includes('/evidenceCatalog/4'));
});

test('Windows、真实样本、资金与恢复gate不能自动升级为PASS', () => {
  const snapshot = loadSnapshot();
  const action = findAction(snapshot, 'vcc-financial-op:export-subjects');
  action.gates.windowsPackaged = 'PASS';
  action.gates.realBusinessSamples = 'PASS';
  action.gates.funds = 'PASS';
  action.gates.recovery = 'PASS';
  action.gates.performance = 'PASS';
  snapshot.globalDecision.windowsPackagedEvidence = 'PASS';
  snapshot.globalDecision.fundsRecoveryEvidence = 'PASS';
  const result = validateReleaseEvidence(snapshot);
  assert.equal(result.valid, false);
  assert.ok(errorPaths(result).includes('/actions/' + actionIndex(action.actionKey) + '/gates'));
  assert.ok(errorPaths(result).includes('/globalDecision'));
});

test('缺失或UNKNOWN gate不能作为release evidence通过', () => {
  const snapshot = loadSnapshot();
  const action = findAction(snapshot, 'recon-fix:import');
  delete action.gates.funds;
  action.gates.windowsPackaged = 'UNKNOWN';
  const result = validateReleaseEvidence(snapshot);
  assert.equal(result.valid, false);
  assert.ok(errorPaths(result).includes('/actions/' + actionIndex(action.actionKey) + '/gates'));
});

test('rollback不能允许production mutation或丢失legacy/receipt hold保护', () => {
  const snapshot = loadSnapshot();
  const action = findAction(snapshot, 'recon-fix:run-jpm');
  action.rollback.preserveLegacySelector = false;
  action.rollback.preserveReceiptsAndRecoveryHolds = false;
  action.rollback.productionMutationAllowed = true;
  const result = validateReleaseEvidence(snapshot);
  assert.equal(result.valid, false);
  assert.ok(errorPaths(result).includes('/actions/' + actionIndex(action.actionKey) + '/rollback'));
});

test('metadata snapshot拒绝raw-like key、账号、金额与序列化business row', async (t) => {
  const sentinel = 'RETURN_SENTINEL account: 6222021234567890';
  const cases = [
    (snapshot) => { findAction(snapshot, 'recon-fix:import').rollback['账号'] = 'REDACTED'; },
    (snapshot) => { findAction(snapshot, 'recon-fix:run-jpm').rollback.note = sentinel; },
    (snapshot) => { findAction(snapshot, 'recon-fix:export').rollback.note = '金额：12.34'; },
    (snapshot) => {
      findAction(snapshot, 'vcc-financial-op:export-single').rollback.note =
        '{"account":"6222021234567890","currency":"USD","amount":"12.34"}';
    }
  ];
  for (const [index, mutate] of cases.entries()) {
    await t.test(String(index), () => {
      const snapshot = loadSnapshot();
      mutate(snapshot);
      const result = validateReleaseEvidence(snapshot);
      assert.equal(result.valid, false);
      assert.ok(errorPaths(result).some((fieldPath) => fieldPath.startsWith('/privacy/')));
      assert.doesNotMatch(JSON.stringify(result), new RegExp(sentinel));
    });
  }
});

test('普通hash、OID、版本号和说明不会被privacy误判但未知字段仍fail closed', () => {
  const snapshot = loadSnapshot();
  snapshot.auditMetadata = {
    digest: 'a'.repeat(64),
    oid: 'b'.repeat(40),
    version: '3.2.4',
    note: '仅记录本地能力，人工门禁保持未完成'
  };
  const result = validateReleaseEvidence(snapshot);
  assert.equal(errorPaths(result).some((fieldPath) => fieldPath.startsWith('/privacy/')), false);
  assert.equal(result.valid, false);
  assert.ok(errorPaths(result).includes('/snapshot/keys'));
});

test('snapshot validator不会创建临时文件或修改证据', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v324-evidence-readonly-'));
  try {
    const before = fs.readFileSync(SNAPSHOT_PATH, 'utf8');
    const result = validateReleaseEvidence(JSON.parse(before));
    assert.equal(result.valid, true, JSON.stringify(result.errors));
    assert.deepEqual(fs.readdirSync(dir), []);
    assert.equal(fs.readFileSync(SNAPSHOT_PATH, 'utf8'), before);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
