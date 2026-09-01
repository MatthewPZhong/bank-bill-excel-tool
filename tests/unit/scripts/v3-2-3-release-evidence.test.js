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
const HISTORICAL_EXACT_BASE = 'd54f97cecddef992069d867eedc227681ed562d4';
const HISTORICAL_EXPECTED_BRANCH = 'codex/v3.2.3-r3-final-evidence-chain-20260830';
const HISTORICAL_EXPECTED_MAIN_REF_OID = 'b7abc2fa00838fc61a94f812c1a14c48d5d4d40f';
const HISTORICAL_EXPECTED_TRACKED_ENTRY_COUNT = 2018;
const HISTORICAL_RELEASE_EVIDENCE_PATHS = Object.freeze([
  'changes/background-execution-r3-2-3-release-evidence/implementation-notes.md',
  'changes/background-execution-r3-2-3-release-evidence/preflight.md',
  'changes/background-execution-r3-2-3-release-evidence/release-evidence.json',
  'scripts/validate-v3-2-3-release-evidence.js',
  'tests/unit/scripts/v3-2-3-release-evidence.test.js'
]);
const HISTORICAL_RAW_DUPLICATE_SNAPSHOT =
  '{"ACCOUNT_6222021234567890":1,"\\u0041CCOUNT_6222021234567890":2}';
const CANDIDATE_DIAGNOSTIC_ITEM_LIMIT = 20;

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

function parseHistoricalGitTreeModes(rawTree) {
  const text = Buffer.isBuffer(rawTree) ? rawTree.toString('utf8') : String(rawTree);
  if (text === '' || !text.endsWith('\0')) {
    throw new Error('HISTORICAL_GIT_MODE_TREE_INVALID');
  }
  const modes = new Map();
  for (const record of text.slice(0, -1).split('\0')) {
    const match = /^(100644|100755|120000) blob ([a-f0-9]{40})\t([\s\S]+)$/.exec(record);
    if (!match) throw new Error('HISTORICAL_GIT_MODE_TREE_INVALID');
    const relativePath = match[3];
    const components = relativePath.split('/');
    if (relativePath.startsWith('/') || relativePath.includes('\\') ||
        /[\r\n]/.test(relativePath) || components.some((part) =>
          part === '' || part === '.' || part === '..') || modes.has(relativePath)) {
      throw new Error('HISTORICAL_GIT_MODE_TREE_INVALID');
    }
    modes.set(relativePath, match[1]);
  }
  if (modes.size === 0) throw new Error('HISTORICAL_GIT_MODE_TREE_INVALID');
  return modes;
}

function readHistoricalGitTreeModes(repositoryRoot) {
  const canonicalRoot = fs.realpathSync.native(repositoryRoot);
  const topLevel = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: canonicalRoot,
    encoding: 'utf8'
  });
  if (topLevel.status !== 0 || topLevel.stderr !== '' ||
      fs.realpathSync.native(topLevel.stdout.trim()) !== canonicalRoot) {
    throw new Error('HISTORICAL_GIT_MODE_REPOSITORY_INVALID');
  }
  const tree = spawnSync('git', ['ls-tree', '-rz', '--full-tree', 'HEAD'], {
    cwd: canonicalRoot,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024
  });
  if (tree.status !== 0 || tree.stderr !== '') {
    throw new Error('HISTORICAL_GIT_MODE_TREE_INVALID');
  }
  return parseHistoricalGitTreeModes(tree.stdout);
}

function projectHistoricalGitWorktreeMode(
  platform,
  requestedPath,
  canonicalRequestedPath,
  cwd,
  modeByPath,
  stat
) {
  if (platform !== 'win32' || typeof requestedPath !== 'string' ||
      canonicalRequestedPath !== requestedPath ||
      !path.win32.isAbsolute(requestedPath) || path.win32.resolve(requestedPath) !== requestedPath ||
      !stat || typeof stat.mode !== 'number' || !stat.isFile() || stat.isSymbolicLink() ||
      (stat.mode & 0o222) === 0) {
    return stat;
  }
  const relative = path.win32.relative(path.win32.resolve(cwd), requestedPath);
  if (relative === '' || relative === '..' || relative.startsWith('..\\') ||
      path.win32.isAbsolute(relative)) {
    return stat;
  }
  const gitRelative = relative.split('\\').join('/');
  const gitMode = modeByPath.get(gitRelative);
  if (gitMode !== '100644' && gitMode !== '100755') return stat;
  const descriptors = Object.getOwnPropertyDescriptors(stat);
  descriptors.mode = {
    ...descriptors.mode,
    value: (stat.mode & ~0o777) | (gitMode === '100755' ? 0o755 : 0o644)
  };
  return Object.create(Object.getPrototypeOf(stat), descriptors);
}

function historicalGitPathPreloadSource() {
  return [
    "'use strict';",
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const { spawnSync } = require('node:child_process');",
    normalizeHistoricalGitRelativePath.toString(),
    parseHistoricalGitTreeModes.toString(),
    readHistoricalGitTreeModes.toString(),
    projectHistoricalGitWorktreeMode.toString(),
    "if (process.platform === 'win32') {",
    "  const relativeDescriptor = Object.getOwnPropertyDescriptor(path, 'relative');",
    "  const lstatDescriptor = Object.getOwnPropertyDescriptor(fs, 'lstatSync');",
    "  if (!relativeDescriptor || relativeDescriptor.writable !== true ||",
    "      relativeDescriptor.configurable !== true || !lstatDescriptor ||",
    "      lstatDescriptor.writable !== true || lstatDescriptor.configurable !== true) {",
    "    throw new Error('HISTORICAL_GIT_WORKTREE_ADAPTER_UNAVAILABLE');",
    "  }",
    "  const nativeRelative = path.relative.bind(path);",
    "  const nativeLstatSync = fs.lstatSync.bind(fs);",
    "  const canonicalRoot = fs.realpathSync.native(process.cwd());",
    "  const modeByPath = readHistoricalGitTreeModes(canonicalRoot);",
    "  Object.defineProperty(path, 'relative', {",
    "    ...relativeDescriptor,",
    "    value(from, to) {",
    "      return normalizeHistoricalGitRelativePath(",
    "        process.platform, from, process.cwd(), nativeRelative(from, to)",
    "      );",
    "    }",
    "  });",
    "  Object.defineProperty(fs, 'lstatSync', {",
    "    ...lstatDescriptor,",
    "    value(requestedPath, ...args) {",
    "      const stat = nativeLstatSync(requestedPath, ...args);",
    "      let canonicalRequestedPath;",
    "      try {",
    "        canonicalRequestedPath = fs.realpathSync.native(requestedPath);",
    "      } catch {",
    "        return stat;",
    "      }",
    "      return projectHistoricalGitWorktreeMode(",
    "        process.platform, requestedPath, canonicalRequestedPath,",
    "        canonicalRoot, modeByPath, stat",
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

function createControlledHistoricalEnvironment(baseEnvironment, options) {
  const environment = { ...baseEnvironment };
  for (const key of Object.keys(environment)) {
    const normalizedKey = key.toUpperCase();
    if (['NODE_OPTIONS', 'NODE_PATH', 'TMP', 'TEMP', 'TMPDIR'].includes(normalizedKey) ||
        normalizedKey === 'GIT_CONFIG_COUNT' || normalizedKey === 'GIT_CONFIG_PARAMETERS' ||
        /^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(normalizedKey)) {
      delete environment[key];
    }
  }
  Object.assign(environment, {
    NODE_OPTIONS: options.nodeOptions,
    NODE_PATH: options.nodePath,
    TMP: options.tempRoot,
    TEMP: options.tempRoot,
    TMPDIR: options.tempRoot,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.autocrlf',
    GIT_CONFIG_VALUE_0: 'false'
  });
  delete environment.NODE_TEST_CONTEXT;
  return environment;
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

function assertCanonicalGitRelativePath(relativePath, errorCode) {
  const components = relativePath.split('/');
  if (relativePath === '' || relativePath.startsWith('/') || relativePath.includes('\\') ||
      relativePath.includes('\0') || /[\r\n]/.test(relativePath) ||
      components.some((component) => component === '' || component === '.' || component === '..')) {
    throw new Error(errorCode);
  }
}

function parseCandidateGitTree(rawTree) {
  const text = Buffer.isBuffer(rawTree) ? rawTree.toString('utf8') : String(rawTree);
  if (text === '' || !text.endsWith('\0')) {
    throw new Error('HISTORICAL_CANDIDATE_TREE_INVALID');
  }
  const entries = new Map();
  for (const record of text.slice(0, -1).split('\0')) {
    const match = /^([0-7]{6}) (blob|commit) ([a-f0-9]{40})\t([\s\S]+)$/.exec(record);
    if (!match) throw new Error('HISTORICAL_CANDIDATE_TREE_INVALID');
    const relativePath = match[4];
    assertCanonicalGitRelativePath(relativePath, 'HISTORICAL_CANDIDATE_TREE_INVALID');
    if (entries.has(relativePath)) throw new Error('HISTORICAL_CANDIDATE_TREE_INVALID');
    entries.set(relativePath, {
      mode: match[1],
      type: match[2],
      oid: match[3]
    });
  }
  return entries;
}

function parseCandidateRawDiff(rawDiff) {
  const text = Buffer.isBuffer(rawDiff) ? rawDiff.toString('utf8') : String(rawDiff);
  if (text === '') return [];
  if (!text.endsWith('\0')) throw new Error('HISTORICAL_CANDIDATE_DIFF_INVALID');
  const parts = text.slice(0, -1).split('\0');
  if (parts.length % 2 !== 0) throw new Error('HISTORICAL_CANDIDATE_DIFF_INVALID');
  const records = [];
  for (let index = 0; index < parts.length; index += 2) {
    const match = /^:([0-7]{6}) ([0-7]{6}) ([a-f0-9]{40}) ([a-f0-9]{40}) ([A-Z])$/.exec(
      parts[index]
    );
    if (!match) throw new Error('HISTORICAL_CANDIDATE_DIFF_INVALID');
    const relativePath = parts[index + 1];
    assertCanonicalGitRelativePath(relativePath, 'HISTORICAL_CANDIDATE_DIFF_INVALID');
    records.push({
      oldMode: match[1],
      newMode: match[2],
      oldOid: match[3],
      newOid: match[4],
      status: match[5],
      relativePath
    });
  }
  return records;
}

function parseCandidateIndex(rawIndex) {
  const text = Buffer.isBuffer(rawIndex) ? rawIndex.toString('utf8') : String(rawIndex);
  if (text === '' || !text.endsWith('\0')) {
    throw new Error('HISTORICAL_CANDIDATE_INDEX_INVALID');
  }
  return text.slice(0, -1).split('\0').map((record) => {
    const match = /^([A-Za-z]) ([0-7]{6}) ([a-f0-9]{40}) ([0-3])\t([\s\S]+)$/.exec(record);
    if (!match) throw new Error('HISTORICAL_CANDIDATE_INDEX_INVALID');
    const relativePath = match[5];
    assertCanonicalGitRelativePath(relativePath, 'HISTORICAL_CANDIDATE_INDEX_INVALID');
    return {
      tag: match[1],
      mode: match[2],
      oid: match[3],
      stage: Number(match[4]),
      relativePath
    };
  });
}

function runControlledCandidateGit(repository, args, environment, label) {
  const result = spawnSync('git', args, {
    cwd: repository,
    encoding: 'utf8',
    env: environment,
    maxBuffer: 16 * 1024 * 1024
  });
  assert.equal(result.status, 0, `HISTORICAL_CANDIDATE_GIT_${label}_FAILED`);
  return result.stdout;
}

function readCandidateLocalGitConfig(repository, key, environment) {
  const result = spawnSync('git', ['config', '--local', '--get', key], {
    cwd: repository,
    encoding: 'utf8',
    env: environment
  });
  if (result.status === 1 && result.stdout === '' && result.stderr === '') return null;
  assert.equal(result.status, 0, 'HISTORICAL_CANDIDATE_GIT_CONFIG_FAILED');
  const value = result.stdout.trim();
  assert.match(value, /^[A-Za-z0-9._-]{1,32}$/);
  return value;
}

function sanitizeCandidateDiagnosticPath(relativePath) {
  const safe = relativePath.length <= 240 &&
    /^[A-Za-z0-9._@+/-]+$/.test(relativePath) &&
    !/\d{12,24}/.test(relativePath);
  return safe ? relativePath : `sha256:${sha256(relativePath)}`;
}

function limitCandidateDiagnosticPaths(relativePaths) {
  return relativePaths.slice(0, CANDIDATE_DIAGNOSTIC_ITEM_LIMIT)
    .map(sanitizeCandidateDiagnosticPath);
}

function assertHistoricalCandidateGitBaseline(root, repository, environment) {
  let candidateRoot = null;
  try {
    candidateRoot = fs.mkdtempSync(path.join(root, 'candidate-baseline-'));
    const candidateRepository = path.join(candidateRoot, 'repo');
    runControlledCandidateGit(candidateRoot, [
      'clone', '--quiet', '--shared', '--no-checkout', repository, candidateRepository
    ], environment, 'CLONE');
    const canonicalCandidateRepository = fs.realpathSync.native(candidateRepository);
    runControlledCandidateGit(canonicalCandidateRepository, [
      'checkout', '--quiet', '-B', HISTORICAL_EXPECTED_BRANCH, HISTORICAL_EXACT_BASE
    ], environment, 'CHECKOUT');
    runControlledCandidateGit(canonicalCandidateRepository, [
      'update-ref', 'refs/heads/main', HISTORICAL_EXPECTED_MAIN_REF_OID
    ], environment, 'MAIN_REF');
    for (const relativePath of HISTORICAL_RELEASE_EVIDENCE_PATHS) {
      const destination = path.join(canonicalCandidateRepository, relativePath);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(path.join(repository, relativePath), destination);
    }
    fs.writeFileSync(path.join(
      canonicalCandidateRepository,
      'changes/background-execution-r3-2-3-release-evidence/release-evidence.json'
    ), HISTORICAL_RAW_DUPLICATE_SNAPSHOT);
    runControlledCandidateGit(canonicalCandidateRepository, ['add', '-A'], environment, 'ADD');
    runControlledCandidateGit(canonicalCandidateRepository, [
      '-c', 'user.name=R3.2.3 Test', '-c', 'user.email=r323@example.invalid',
      'commit', '--quiet', '-m', 'test: candidate release evidence'
    ], environment, 'COMMIT');

    const expectedTree = parseCandidateGitTree(runControlledCandidateGit(repository, [
      'ls-tree', '-rz', '--full-tree', EXACT_EVIDENCE_HEAD
    ], environment, 'EXPECTED_TREE'));
    assert.equal(expectedTree.size, HISTORICAL_EXPECTED_TRACKED_ENTRY_COUNT);
    const candidateTree = parseCandidateGitTree(runControlledCandidateGit(
      canonicalCandidateRepository,
      ['ls-tree', '-rz', '--full-tree', 'HEAD'],
      environment,
      'HEAD_TREE'
    ));
    const missingPaths = [...expectedTree.keys()].filter((relativePath) =>
      !candidateTree.has(relativePath));
    const extraPaths = [...candidateTree.keys()].filter((relativePath) =>
      !expectedTree.has(relativePath));
    const modeMismatches = [...expectedTree.entries()].flatMap(([relativePath, expected]) => {
      const actual = candidateTree.get(relativePath);
      return actual && actual.mode !== expected.mode
        ? [{ relativePath, expectedMode: expected.mode, actualMode: actual.mode }]
        : [];
    });
    const typeMismatches = [...expectedTree.entries()].flatMap(([relativePath, expected]) => {
      const actual = candidateTree.get(relativePath);
      return actual && actual.type !== expected.type
        ? [{ relativePath, expectedType: expected.type, actualType: actual.type }]
        : [];
    });

    const parents = runControlledCandidateGit(canonicalCandidateRepository, [
      'rev-list', '--parents', '-n', '1', 'HEAD'
    ], environment, 'PARENTS').trim().split(/\s+/).slice(1);
    const branch = runControlledCandidateGit(canonicalCandidateRepository, [
      'branch', '--show-current'
    ], environment, 'BRANCH').trim();
    const mainRef = runControlledCandidateGit(canonicalCandidateRepository, [
      'rev-parse', '--verify', 'refs/heads/main^{commit}'
    ], environment, 'MAIN_REF_READ').trim();
    const diffRecords = parseCandidateRawDiff(runControlledCandidateGit(
      canonicalCandidateRepository,
      [
        'diff-tree', '--no-commit-id', '--raw', '-r', '-z', '--no-renames', '--no-abbrev',
        HISTORICAL_EXACT_BASE, 'HEAD'
      ],
      environment,
      'RAW_DIFF'
    ));
    const zeroOid = '0'.repeat(40);
    const diffExact = diffRecords.length === HISTORICAL_RELEASE_EVIDENCE_PATHS.length &&
      diffRecords.every((record, index) =>
        record.status === 'A' && record.oldMode === '000000' &&
        record.newMode === '100644' && record.oldOid === zeroOid &&
        record.relativePath === HISTORICAL_RELEASE_EVIDENCE_PATHS[index]);
    const indexEntries = parseCandidateIndex(runControlledCandidateGit(
      canonicalCandidateRepository,
      ['ls-files', '--stage', '-v', '-f', '-z'],
      environment,
      'INDEX'
    ));
    const nonDefaultIndexFlagCount = indexEntries.filter((entry) => entry.tag !== 'H').length;
    const nonZeroIndexStageCount = indexEntries.filter((entry) => entry.stage !== 0).length;
    const status = runControlledCandidateGit(canonicalCandidateRepository, [
      'status', '--porcelain=v2', '-z', '--untracked-files=all'
    ], environment, 'STATUS');
    const statusRecordCount = status === '' ? 0 : status.split('\0').filter(Boolean).length;
    const worktreeDiff = spawnSync('git', ['diff', '--quiet', '--exit-code'], {
      cwd: canonicalCandidateRepository,
      env: environment
    });
    const indexDiff = spawnSync('git', ['diff', '--cached', '--quiet', '--exit-code', 'HEAD'], {
      cwd: canonicalCandidateRepository,
      env: environment
    });
    assert.ok([0, 1].includes(worktreeDiff.status), 'HISTORICAL_CANDIDATE_WORKTREE_DIFF_FAILED');
    assert.ok([0, 1].includes(indexDiff.status), 'HISTORICAL_CANDIDATE_INDEX_DIFF_FAILED');

    const baselineExact = parents.length === 1 && parents[0] === HISTORICAL_EXACT_BASE &&
      branch === HISTORICAL_EXPECTED_BRANCH && mainRef === HISTORICAL_EXPECTED_MAIN_REF_OID &&
      candidateTree.size === HISTORICAL_EXPECTED_TRACKED_ENTRY_COUNT &&
      missingPaths.length === 0 && extraPaths.length === 0 && modeMismatches.length === 0 &&
      typeMismatches.length === 0 && diffExact &&
      indexEntries.length === HISTORICAL_EXPECTED_TRACKED_ENTRY_COUNT &&
      nonDefaultIndexFlagCount === 0 && nonZeroIndexStageCount === 0 &&
      statusRecordCount === 0 && worktreeDiff.status === 0 && indexDiff.status === 0;
    if (!baselineExact) {
      const diagnostic = {
        kind: 'candidate-baseline',
        parentExact: parents.length === 1 && parents[0] === HISTORICAL_EXACT_BASE,
        parentOids: parents.slice(0, 3),
        branchExact: branch === HISTORICAL_EXPECTED_BRANCH,
        mainRefExact: mainRef === HISTORICAL_EXPECTED_MAIN_REF_OID,
        trackedEntryCount: candidateTree.size,
        expectedTrackedEntryCount: HISTORICAL_EXPECTED_TRACKED_ENTRY_COUNT,
        missingPathCount: missingPaths.length,
        missingPaths: limitCandidateDiagnosticPaths(missingPaths),
        extraPathCount: extraPaths.length,
        extraPaths: limitCandidateDiagnosticPaths(extraPaths),
        modeMismatchCount: modeMismatches.length,
        modeMismatches: modeMismatches.slice(0, CANDIDATE_DIAGNOSTIC_ITEM_LIMIT).map((item) => ({
          path: sanitizeCandidateDiagnosticPath(item.relativePath),
          expectedMode: item.expectedMode,
          actualMode: item.actualMode
        })),
        typeMismatchCount: typeMismatches.length,
        typeMismatches: typeMismatches.slice(0, CANDIDATE_DIAGNOSTIC_ITEM_LIMIT).map((item) => ({
          path: sanitizeCandidateDiagnosticPath(item.relativePath),
          expectedType: item.expectedType,
          actualType: item.actualType
        })),
        diffRecordCount: diffRecords.length,
        diffRecords: diffRecords.slice(0, CANDIDATE_DIAGNOSTIC_ITEM_LIMIT).map((record) => ({
          path: sanitizeCandidateDiagnosticPath(record.relativePath),
          status: record.status,
          oldMode: record.oldMode,
          newMode: record.newMode
        })),
        indexEntryCount: indexEntries.length,
        nonDefaultIndexFlagCount,
        nonZeroIndexStageCount,
        statusRecordCount,
        worktreeDiffClean: worktreeDiff.status === 0,
        indexDiffClean: indexDiff.status === 0,
        localGitConfig: {
          autocrlf: readCandidateLocalGitConfig(
            canonicalCandidateRepository, 'core.autocrlf', environment
          ),
          filemode: readCandidateLocalGitConfig(
            canonicalCandidateRepository, 'core.filemode', environment
          ),
          ignorecase: readCandidateLocalGitConfig(
            canonicalCandidateRepository, 'core.ignorecase', environment
          )
        }
      };
      assert.fail(JSON.stringify(diagnostic));
    }

    const cli = spawnSync(process.execPath, [
      'scripts/validate-v3-2-3-release-evidence.js'
    ], {
      cwd: canonicalCandidateRepository,
      encoding: 'utf8',
      env: environment,
      maxBuffer: 16 * 1024 * 1024
    });
    assert.doesNotMatch(`${cli.stdout || ''}${cli.stderr || ''}`, /6222021234567890/);
    assert.equal(cli.status, 1, 'HISTORICAL_CANDIDATE_CLI_STATUS_INVALID');
    assert.equal(cli.stderr, '', 'HISTORICAL_CANDIDATE_CLI_STDERR_INVALID');
    const summary = JSON.parse(cli.stdout);
    assert.equal(summary.status, 'FAIL');
    assert.deepEqual(summary.errors.map((error) => error.code), ['RAW_JSON_DUPLICATE_KEY']);
    assert.equal(summary.errors.length, 1);
    assert.match(summary.errors[0].path, /^\/json\/offset\/\d{1,6}$/);
  } finally {
    if (candidateRoot !== null) {
      fs.rmSync(candidateRoot, { recursive: true, force: true });
      assert.equal(fs.existsSync(candidateRoot), false);
    }
  }
}

function assertHistoricalGitLineEndingContract(root) {
  const source = path.join(root, 'line-ending-source');
  const crlfClone = path.join(root, 'line-ending-crlf');
  const lfClone = path.join(root, 'line-ending-lf');
  fs.mkdirSync(source);
  runGit(source, ['init', '--quiet']);
  runGit(source, ['config', 'user.name', 'R3.2.3 Line Ending Probe']);
  runGit(source, ['config', 'user.email', 'r323-eol@example.invalid']);
  fs.writeFileSync(path.join(source, 'probe.txt'), 'alpha\nbeta\n', 'utf8');
  runGit(source, ['add', 'probe.txt']);
  runGit(source, ['commit', '--quiet', '-m', 'test: line ending probe']);
  const reviewedOid = runGit(source, ['rev-parse', 'HEAD:probe.txt']);

  runGit(root, ['-c', 'core.autocrlf=true', 'clone', '--quiet', source, crlfClone]);
  assert.equal(fs.readFileSync(path.join(crlfClone, 'probe.txt')).includes(Buffer.from('\r\n')),
    true);
  assert.notEqual(runGit(crlfClone,
    ['hash-object', '--no-filters', '--', 'probe.txt']), reviewedOid);

  runGit(root, ['clone', '--quiet', '--no-checkout', source, lfClone]);
  runGit(lfClone, ['config', '--local', 'core.autocrlf', 'false']);
  assert.equal(runGit(lfClone, ['config', '--local', '--get', 'core.autocrlf']), 'false');
  runGit(lfClone, ['checkout', '--quiet', '--detach', 'HEAD']);
  assert.equal(fs.readFileSync(path.join(lfClone, 'probe.txt')).includes(Buffer.from('\r\n')),
    false);
  assert.equal(runGit(lfClone,
    ['hash-object', '--no-filters', '--', 'probe.txt']), reviewedOid);
}

function assertHistoricalGitPathContract(repository) {
  assert.equal(EXACT_BASE, HISTORICAL_EXACT_BASE);
  assert.equal(EXPECTED_BRANCH, HISTORICAL_EXPECTED_BRANCH);
  assert.equal(EXPECTED_MAIN_REF_OID, HISTORICAL_EXPECTED_MAIN_REF_OID);
  assert.deepEqual(RELEASE_EVIDENCE_PATHS, HISTORICAL_RELEASE_EVIDENCE_PATHS);
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
  assert.equal((validatorSource.match(/\bfs\.lstatSync\s*\(/g) || []).length, 3);
  assert.equal((validatorSource.match(/\(stat\.mode & 0o777\) !== expectedPermissions/g) || [])
    .length, 1);
  assert.equal((testSource.match(/\bpath\.relative\s*\(/g) || []).length, 0);
  assert.match(validatorSource,
    /const relative = path\.relative\(REPOSITORY_ROOT, absolutePath\);/);
  assert.match(validatorSource, /relative !== relativePath/);
  assert.match(validatorSource,
    /const expectedPermissions = entry\.mode === '100755' \? 0o755 : 0o644;/);
  assert.match(testSource,
    /env: \{ \.\.\.process\.env, NODE_PATH: SHARED_NODE_MODULES \}/);
  const exactModes = parseHistoricalGitTreeModes(readGit(repository, [
    'ls-tree', '-rz', '--full-tree', EXACT_EVIDENCE_HEAD
  ]));
  assert.deepEqual([...readHistoricalGitTreeModes(repository).entries()],
    [...exactModes.entries()]);
  assert.equal(exactModes.size, 2018);
  assert.equal([...exactModes.values()].filter((mode) => mode === '100644').length, 2016);
  assert.equal([...exactModes.values()].filter((mode) => mode === '100755').length, 2);
  assert.equal([...exactModes.values()].filter((mode) => mode === '120000').length, 0);
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

  const oid = 'a'.repeat(40);
  const executablePath =
    'changes/background-execution-v3.2.x-contract-baseline/changes/' +
    'background-execution/validation/run-validation.sh';
  const rawTree = [
    `100644 blob ${oid}\tsrc/main-process/runtime.js`,
    `100755 blob ${oid}\t${executablePath}`,
    `120000 blob ${oid}\tlinked-entry`,
    ''
  ].join('\0');
  const modeByPath = parseHistoricalGitTreeModes(rawTree);
  assert.deepEqual([...modeByPath.entries()], [
    ['src/main-process/runtime.js', '100644'],
    [executablePath, '100755'],
    ['linked-entry', '120000']
  ]);
  for (const invalidTree of [
    rawTree.slice(0, -1),
    `100664 blob ${oid}\tsrc/a.js\0`,
    `040000 tree ${oid}\tsrc\0`,
    [
      `100644 blob ${oid}\tsrc/a.js`,
      `100644 blob ${oid}\tsrc/a.js`,
      ''
    ].join('\0'),
    `100644 blob ${oid}\t../outside\0`,
    `100644 blob ${oid}\tsrc\\a.js\0`,
    `100644 blob ${oid}\tsrc/a\n.js\0`
  ]) {
    assert.throws(() => parseHistoricalGitTreeModes(invalidTree),
      /HISTORICAL_GIT_MODE_TREE_INVALID/);
  }

  const makeStat = (mode, kind = 'file') => ({
    mode,
    isFile: () => kind === 'file',
    isSymbolicLink: () => kind === 'symlink',
    isDirectory: () => kind === 'directory'
  });
  const nativeFile = makeStat(0o100666);
  const tracked = path.win32.join(cwd, 'src', 'main-process', 'runtime.js');
  const projectedFile = projectHistoricalGitWorktreeMode(
    'win32', tracked, tracked, cwd, modeByPath, nativeFile
  );
  assert.notEqual(projectedFile, nativeFile);
  assert.equal(projectedFile.mode & 0o170000, nativeFile.mode & 0o170000);
  assert.equal(projectedFile.mode & 0o777, 0o644);
  const executable = path.win32.join(cwd, ...executablePath.split('/'));
  assert.equal(projectHistoricalGitWorktreeMode(
    'win32', executable, executable, cwd, modeByPath, nativeFile
  ).mode & 0o777, 0o755);

  const noOpCases = [
    ['darwin', tracked, tracked, cwd, nativeFile],
    ['win32', tracked, path.win32.join(cwd, 'SRC', 'main-process', 'runtime.js'), cwd,
      nativeFile],
    ['win32', 'src\\main-process\\runtime.js', 'src\\main-process\\runtime.js', cwd,
      nativeFile],
    ['win32', path.win32.join(cwd, 'untracked.js'), path.win32.join(cwd, 'untracked.js'),
      cwd, nativeFile],
    ['win32', path.win32.join(cwd, '..', 'outside.js'),
      path.win32.join(cwd, '..', 'outside.js'), cwd, nativeFile],
    ['win32', 'D:\\outside.js', 'D:\\outside.js', cwd, nativeFile],
    ['win32', tracked, tracked, cwd, makeStat(0o100444)],
    ['win32', tracked, tracked, cwd, makeStat(0o040777, 'directory')],
    ['win32', tracked, tracked, cwd, makeStat(0o120777, 'symlink')]
  ];
  for (const [platform, requestedPath, canonicalRequestedPath, root, stat] of noOpCases) {
    assert.equal(projectHistoricalGitWorktreeMode(
      platform, requestedPath, canonicalRequestedPath, root, modeByPath, stat
    ), stat);
  }
}

function assertControlledPreloadInheritance(environment, cwd, preloadPath) {
  const cacheProbeSource = [
    "'use strict';",
    "const assert = require('node:assert/strict');",
    "const preload = process.env.V323_HISTORICAL_PRELOAD_PATH;",
    "assert.ok(require.cache[require.resolve(preload)]);",
    "const { spawnSync } = require('node:child_process');",
    "const gitConfig = spawnSync('git', ['config', '--get', 'core.autocrlf'], {",
    "  encoding: 'utf8'",
    "});",
    "assert.equal(gitConfig.status, 0, gitConfig.stderr || gitConfig.stdout);",
    "assert.equal(gitConfig.stdout.trim(), 'false');"
  ].join('\n');
  const parentProbeSource = [
    cacheProbeSource,
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
      assertHistoricalGitLineEndingContract(canonicalTempRoot);

      runGit(canonicalTempRoot,
        ['clone', '--quiet', '--shared', '--no-checkout', REPOSITORY_ROOT, repository]);
      const canonicalRepository = fs.realpathSync.native(repository);
      runGit(canonicalRepository, ['config', '--local', 'core.autocrlf', 'false']);
      assert.equal(runGit(canonicalRepository, [
        'config', '--local', '--get', 'core.autocrlf'
      ]), 'false');
      runGit(canonicalRepository, ['checkout', '--quiet', '-B', EXPECTED_BRANCH, EXACT_EVIDENCE_HEAD]);
      runGit(canonicalRepository, ['update-ref', 'refs/heads/main', EXPECTED_MAIN_REF_OID]);
      assertHistoricalGitPathContract(canonicalRepository);
      assertHistoricalGitPathAdapterContract();
      const preloadPath = createHistoricalGitPathPreload(
        canonicalTempRoot, canonicalRepository
      );
      const controlledNodeOptions = createControlledNodeOptions(preloadPath);
      const nestedEnvironment = createControlledHistoricalEnvironment({
        ...process.env,
        NODE_OPTIONS: '--require ambient-forbidden.cjs',
        node_options: '--require ambient-case-forbidden.cjs',
        GIT_CONFIG_COUNT: '2',
        GIT_CONFIG_KEY_0: 'core.autocrlf',
        GIT_CONFIG_VALUE_0: 'true',
        GIT_CONFIG_KEY_1: 'core.filemode',
        GIT_CONFIG_VALUE_1: 'true',
        GIT_CONFIG_PARAMETERS: "'core.autocrlf'='true'"
      }, {
        nodeOptions: controlledNodeOptions,
        nodePath: sharedNodeModules,
        tempRoot: canonicalTempRoot
      });
      assert.equal(nestedEnvironment.NODE_OPTIONS, controlledNodeOptions);
      assert.equal(nestedEnvironment.node_options, undefined);
      assert.equal(nestedEnvironment.GIT_CONFIG_COUNT, '1');
      assert.equal(nestedEnvironment.GIT_CONFIG_KEY_0, 'core.autocrlf');
      assert.equal(nestedEnvironment.GIT_CONFIG_VALUE_0, 'false');
      assert.equal(nestedEnvironment.GIT_CONFIG_KEY_1, undefined);
      assert.equal(nestedEnvironment.GIT_CONFIG_VALUE_1, undefined);
      assert.equal(nestedEnvironment.GIT_CONFIG_PARAMETERS, undefined);
      assertControlledPreloadInheritance(
        nestedEnvironment, canonicalRepository, preloadPath
      );
      assertHistoricalCandidateGitBaseline(
        canonicalTempRoot, canonicalRepository, nestedEnvironment
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
