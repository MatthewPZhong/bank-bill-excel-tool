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
const SHARED_NODE_MODULES = path.join(REPOSITORY_ROOT, 'node_modules');
const EXACT_EVIDENCE_HEAD = '5f9ee049fc4a4daf7089fa99d98b769b3d69540f';
const HISTORICAL_VALIDATOR_PATH = 'scripts/validate-v3-2-4-release-evidence.js';
const HISTORICAL_TEST_PATH = 'tests/unit/scripts/v3-2-4-release-evidence.test.js';
const HISTORICAL_VALIDATOR_BLOB = '22ac0b65f0bdf2be328cab42ed2f580d483faac3';
const HISTORICAL_TEST_BLOB = 'b29f7c204849349fc8308c38cd347581e1ffa416';
const HISTORICAL_EXACT_BASE = 'd5c6242d9e3a11591a998cf02fe11c27fb01d8d1';
const HISTORICAL_EXPECTED_BRANCH = 'codex/v3.2.4-r3-release-evidence-restacked';
const HISTORICAL_EXPECTED_MAIN_REF_OID = 'b7abc2fa00838fc61a94f812c1a14c48d5d4d40f';
const HISTORICAL_EXPECTED_TRACKED_ENTRY_COUNT = 2088;
const HISTORICAL_CANDIDATE_ROOT_PREFIX = 'v324-evidence-git-';
const HISTORICAL_OUTER_ROOT_PREFIX = 'r4-';
const HISTORICAL_PREVIOUS_OUTER_ROOT_PREFIX = 'v324-exact-evidence-';
const HISTORICAL_MKDTEMP_SUFFIX_SAMPLE = 'ABCDEF';
const HISTORICAL_WINDOWS_TEMP_ROOT = 'C:\\Users\\runneradmin\\AppData\\Local\\Temp';
const WINDOWS_CLASSIC_MAX_PATH_CHARACTERS = 259;
const HISTORICAL_CHMOD_MAP_ENV = 'V324_HISTORICAL_CHMOD_MAP';
const HISTORICAL_CHMOD_ENTRY_LIMIT = 20;
const HISTORICAL_LONGEST_TRACKED_PATHS = Object.freeze([
  'changes/background-execution-v3.2.x-contract-baseline/changes/' +
    'background-execution/validation/fixtures/invalid/' +
    'policy-publisher-journal-with-critical-intent.json',
  'changes/background-execution-v3.2.x-contract-baseline/changes/' +
    'background-execution/validation/fixtures/invalid/' +
    'policy-target-post-image-without-main-intent.json'
]);
const HISTORICAL_RELEASE_EVIDENCE_PATHS = Object.freeze([
  'changes/background-execution-r3-2-4-release-evidence/implementation-notes.md',
  'changes/background-execution-r3-2-4-release-evidence/policy-authority.v3.2.4.json',
  'changes/background-execution-r3-2-4-release-evidence/preflight.md',
  'changes/background-execution-r3-2-4-release-evidence/release-evidence.json',
  HISTORICAL_VALIDATOR_PATH,
  HISTORICAL_TEST_PATH
]);

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

function parseHistoricalChmodMap(rawValue) {
  if (rawValue === undefined || rawValue === '') return new Map();
  let entries;
  try {
    entries = JSON.parse(rawValue);
  } catch {
    throw new Error('HISTORICAL_CHMOD_MAP_INVALID');
  }
  if (!Array.isArray(entries) || entries.length > HISTORICAL_CHMOD_ENTRY_LIMIT) {
    throw new Error('HISTORICAL_CHMOD_MAP_INVALID');
  }
  const modes = new Map();
  for (const entry of entries) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' ||
        entry[0] === '' || !path.win32.isAbsolute(entry[0]) || /[\0\r\n]/.test(entry[0]) ||
        !Number.isInteger(entry[1]) || entry[1] < 0 || entry[1] > 0o777 ||
        modes.has(entry[0].toLowerCase())) {
      throw new Error('HISTORICAL_CHMOD_MAP_INVALID');
    }
    modes.set(entry[0].toLowerCase(), entry[1]);
  }
  return modes;
}

function registerHistoricalChmodRequest(
  platform,
  requestedPath,
  canonicalRequestedPath,
  requestedMode,
  controlledTempRoot,
  modeByPath,
  requestedModes
) {
  if (platform !== 'win32' || typeof requestedPath !== 'string' ||
      canonicalRequestedPath !== requestedPath || !path.win32.isAbsolute(requestedPath) ||
      path.win32.resolve(requestedPath) !== requestedPath ||
      !Number.isInteger(requestedMode) || requestedMode < 0 || requestedMode > 0o777 ||
      typeof controlledTempRoot !== 'string' || !path.win32.isAbsolute(controlledTempRoot)) {
    return false;
  }
  const relative = path.win32.relative(path.win32.resolve(controlledTempRoot), requestedPath);
  if (relative === '' || relative === '..' || relative.startsWith('..\\') ||
      path.win32.isAbsolute(relative)) {
    return false;
  }
  const components = relative.split('\\');
  if (components.length < 3 || !components[0].startsWith(HISTORICAL_CANDIDATE_ROOT_PREFIX) ||
      components[1] !== 'repo') {
    return false;
  }
  const gitRelative = components.slice(2).join('/');
  if (!['100644', '100755'].includes(modeByPath.get(gitRelative))) return false;
  const key = path.win32.resolve(canonicalRequestedPath).toLowerCase();
  if (!requestedModes.has(key) && requestedModes.size >= HISTORICAL_CHMOD_ENTRY_LIMIT) {
    throw new Error('HISTORICAL_CHMOD_MAP_INVALID');
  }
  requestedModes.set(key, requestedMode & 0o777);
  return true;
}

function projectHistoricalGitWorktreeMode(
  platform,
  requestedPath,
  canonicalRequestedPath,
  cwd,
  modeByPath,
  requestedModes,
  stat
) {
  if (platform !== 'win32' || typeof requestedPath !== 'string' ||
      canonicalRequestedPath !== requestedPath || !path.win32.isAbsolute(requestedPath) ||
      path.win32.resolve(requestedPath) !== requestedPath || !stat ||
      typeof stat.mode !== 'number' || !stat.isFile() || stat.isSymbolicLink() ||
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
  const requestedMode = requestedModes.get(path.win32.resolve(requestedPath).toLowerCase());
  const effectivePermissions = requestedMode === undefined
    ? (gitMode === '100755' ? 0o755 : 0o644)
    : requestedMode;
  const descriptors = Object.getOwnPropertyDescriptors(stat);
  descriptors.mode = {
    ...descriptors.mode,
    value: (stat.mode & ~0o777) | effectivePermissions
  };
  return Object.create(Object.getPrototypeOf(stat), descriptors);
}

function historicalGitPathPreloadSource() {
  return [
    "'use strict';",
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const { spawnSync } = require('node:child_process');",
    `const HISTORICAL_CANDIDATE_ROOT_PREFIX = ${JSON.stringify(HISTORICAL_CANDIDATE_ROOT_PREFIX)};`,
    `const HISTORICAL_CHMOD_MAP_ENV = ${JSON.stringify(HISTORICAL_CHMOD_MAP_ENV)};`,
    `const HISTORICAL_CHMOD_ENTRY_LIMIT = ${HISTORICAL_CHMOD_ENTRY_LIMIT};`,
    normalizeHistoricalGitRelativePath.toString(),
    parseHistoricalGitTreeModes.toString(),
    readHistoricalGitTreeModes.toString(),
    parseHistoricalChmodMap.toString(),
    registerHistoricalChmodRequest.toString(),
    projectHistoricalGitWorktreeMode.toString(),
    "if (process.platform === 'win32') {",
    "  const relativeDescriptor = Object.getOwnPropertyDescriptor(path, 'relative');",
    "  const lstatDescriptor = Object.getOwnPropertyDescriptor(fs, 'lstatSync');",
    "  const chmodDescriptor = Object.getOwnPropertyDescriptor(fs, 'chmodSync');",
    "  if (!relativeDescriptor || relativeDescriptor.writable !== true ||",
    "      relativeDescriptor.configurable !== true || !lstatDescriptor ||",
    "      lstatDescriptor.writable !== true || lstatDescriptor.configurable !== true ||",
    "      !chmodDescriptor || chmodDescriptor.writable !== true ||",
    "      chmodDescriptor.configurable !== true) {",
    "    throw new Error('HISTORICAL_GIT_WORKTREE_ADAPTER_UNAVAILABLE');",
    "  }",
    "  const nativeRelative = path.relative.bind(path);",
    "  const nativeLstatSync = fs.lstatSync.bind(fs);",
    "  const nativeChmodSync = fs.chmodSync.bind(fs);",
    "  const canonicalRoot = fs.realpathSync.native(process.cwd());",
    "  const controlledTempRoot = fs.realpathSync.native(process.env.TMP);",
    "  const modeByPath = readHistoricalGitTreeModes(canonicalRoot);",
    "  const requestedModes = parseHistoricalChmodMap(process.env[HISTORICAL_CHMOD_MAP_ENV]);",
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
    "        process.platform, requestedPath, canonicalRequestedPath, canonicalRoot,",
    "        modeByPath, requestedModes, stat",
    "      );",
    "    }",
    "  });",
    "  Object.defineProperty(fs, 'chmodSync', {",
    "    ...chmodDescriptor,",
    "    value(requestedPath, requestedMode, ...args) {",
    "      const result = nativeChmodSync(requestedPath, requestedMode, ...args);",
    "      let canonicalRequestedPath;",
    "      try {",
    "        canonicalRequestedPath = fs.realpathSync.native(requestedPath);",
    "      } catch {",
    "        return result;",
    "      }",
    "      if (registerHistoricalChmodRequest(",
    "        process.platform, requestedPath, canonicalRequestedPath, requestedMode,",
    "        controlledTempRoot, modeByPath, requestedModes",
    "      )) {",
    "        process.env[HISTORICAL_CHMOD_MAP_ENV] = JSON.stringify([...requestedModes]);",
    "      }",
    "      return result;",
    "    }",
    "  });",
    "}",
    ""
  ].join('\n');
}

function createControlledNodeOptions(preloadPath) {
  assert.doesNotMatch(preloadPath, /[\0\r\n]/);
  return [
    `--require ${JSON.stringify(preloadPath)}`,
    '--disable-warning=ExperimentalWarning'
  ].join(' ');
}

function createControlledHistoricalEnvironment(baseEnvironment, options) {
  const environment = { ...baseEnvironment };
  for (const key of Object.keys(environment)) {
    const normalizedKey = key.toUpperCase();
    if (['NODE_OPTIONS', 'NODE_PATH', 'TMP', 'TEMP', 'TMPDIR',
      HISTORICAL_CHMOD_MAP_ENV].includes(normalizedKey) ||
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

function readHistoricalGit(repository, args) {
  const result = spawnSync('git', args, {
    cwd: repository,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stderr, '');
  return result.stdout;
}

function assertHistoricalGitLineEndingContract(root) {
  const source = path.join(root, 'line-ending-source');
  const crlfClone = path.join(root, 'line-ending-crlf');
  const lfClone = path.join(root, 'line-ending-lf');
  fs.mkdirSync(source);
  runGit(source, ['init', '--quiet']);
  runGit(source, ['config', 'user.name', 'R3.2.4 Line Ending Probe']);
  runGit(source, ['config', 'user.email', 'r324-eol@example.invalid']);
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

function historicalCandidatePathLengths(outerPrefix) {
  return HISTORICAL_LONGEST_TRACKED_PATHS.map((relativePath) => path.win32.join(
    HISTORICAL_WINDOWS_TEMP_ROOT,
    `${outerPrefix}${HISTORICAL_MKDTEMP_SUFFIX_SAMPLE}`,
    `${HISTORICAL_CANDIDATE_ROOT_PREFIX}${HISTORICAL_MKDTEMP_SUFFIX_SAMPLE}`,
    'repo',
    relativePath
  ).length);
}

function assertHistoricalCandidatePathBudget(repository, historicalTestSource) {
  const exactCandidateConstruction =
    "fs.mkdtempSync(path.join(os.tmpdir(), 'v324-evidence-git-'))";
  assert.equal(historicalTestSource.split(exactCandidateConstruction).length - 1, 1);

  for (const reference of [HISTORICAL_EXACT_BASE, EXACT_EVIDENCE_HEAD]) {
    const tree = parseHistoricalGitTreeModes(readHistoricalGit(repository, [
      'ls-tree', '-rz', '--full-tree', reference
    ]));
    const longestPaths = [...tree.keys()]
      .sort((left, right) => right.length - left.length || left.localeCompare(right))
      .slice(0, HISTORICAL_LONGEST_TRACKED_PATHS.length);
    assert.deepEqual(longestPaths, HISTORICAL_LONGEST_TRACKED_PATHS);
    for (const relativePath of HISTORICAL_LONGEST_TRACKED_PATHS) {
      assert.equal(tree.get(relativePath), '100644');
    }
  }

  const previousLengths = historicalCandidatePathLengths(
    HISTORICAL_PREVIOUS_OUTER_ROOT_PREFIX
  );
  const currentLengths = historicalCandidatePathLengths(HISTORICAL_OUTER_ROOT_PREFIX);
  assert.deepEqual(previousLengths, [258, 257]);
  assert.deepEqual(currentLengths, [241, 240]);
  assert.equal(WINDOWS_CLASSIC_MAX_PATH_CHARACTERS - Math.max(...previousLengths), 1);
  assert.equal(currentLengths.every((length) =>
    length <= WINDOWS_CLASSIC_MAX_PATH_CHARACTERS), true);
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

  const validatorSource = readHistoricalGit(repository, [
    'show', `${EXACT_EVIDENCE_HEAD}:${HISTORICAL_VALIDATOR_PATH}`
  ]);
  const testSource = readHistoricalGit(repository, [
    'show', `${EXACT_EVIDENCE_HEAD}:${HISTORICAL_TEST_PATH}`
  ]);
  assert.equal((validatorSource.match(/\bpath\.relative\s*\(/g) || []).length, 1);
  assert.equal((validatorSource.match(/\bfs\.lstatSync\s*\(/g) || []).length, 3);
  assert.equal((validatorSource.match(/\(stat\.mode & 0o777\) !== expectedPermissions/g) || [])
    .length, 1);
  assert.match(validatorSource,
    /const relative = path\.relative\(REPOSITORY_ROOT, absolutePath\);/);
  assert.match(validatorSource,
    /path\.resolve\(String\(repository\.stdout \|\| ''\)\.trim\(\)\) !== REPOSITORY_ROOT/);
  assert.match(testSource,
    /fs\.chmodSync\(path\.join\(repository, selector\), 0o755\);/);
  assertHistoricalCandidatePathBudget(repository, testSource);

  const exactModes = parseHistoricalGitTreeModes(readHistoricalGit(repository, [
    'ls-tree', '-rz', '--full-tree', EXACT_EVIDENCE_HEAD
  ]));
  assert.deepEqual([...readHistoricalGitTreeModes(repository).entries()],
    [...exactModes.entries()]);
  assert.equal(exactModes.size, HISTORICAL_EXPECTED_TRACKED_ENTRY_COUNT);
  assert.equal([...exactModes.values()].filter((mode) => mode === '100644').length, 2086);
  assert.equal([...exactModes.values()].filter((mode) => mode === '100755').length, 2);
  assert.equal([...exactModes.values()].filter((mode) => mode === '120000').length, 0);
}

function assertHistoricalGitPathAdapterContract() {
  const tempRoot = 'C:\\Users\\runneradmin\\AppData\\Local\\Temp\\r4-ABCDEF';
  const cwd = path.win32.join(tempRoot, 'repo');
  const trackedRelative = 'src/main-process/background-execution/runtime.js';
  const tracked = path.win32.join(cwd, ...trackedRelative.split('/'));
  const nestedNative = path.win32.relative(cwd, tracked);
  assert.equal(nestedNative, 'src\\main-process\\background-execution\\runtime.js');
  assert.equal(normalizeHistoricalGitRelativePath('win32', cwd, cwd, nestedNative),
    trackedRelative);
  assert.equal(normalizeHistoricalGitRelativePath('darwin', cwd, cwd, nestedNative),
    nestedNative);
  const outsideNative = path.win32.relative(cwd, path.win32.join(cwd, '..', 'outside'));
  assert.equal(normalizeHistoricalGitRelativePath('win32', cwd, cwd, outsideNative),
    outsideNative);
  assert.equal(normalizeHistoricalGitRelativePath(
    'win32', path.win32.join(cwd, 'nested'), cwd, nestedNative
  ), nestedNative);

  const oid = 'a'.repeat(40);
  const executablePath =
    'changes/background-execution-v3.2.x-contract-baseline/changes/' +
    'background-execution/validation/run-validation.sh';
  const rawTree = [
    `100644 blob ${oid}\t${trackedRelative}`,
    `100755 blob ${oid}\t${executablePath}`,
    `120000 blob ${oid}\tlinked-entry`,
    ''
  ].join('\0');
  const modeByPath = parseHistoricalGitTreeModes(rawTree);
  for (const invalidTree of [
    rawTree.slice(0, -1),
    `100664 blob ${oid}\tsrc/a.js\0`,
    `040000 tree ${oid}\tsrc\0`,
    [`100644 blob ${oid}\tsrc/a.js`, `100644 blob ${oid}\tsrc/a.js`, ''].join('\0'),
    `100644 blob ${oid}\t../outside\0`,
    `100644 blob ${oid}\tsrc\\a.js\0`,
    `100644 blob ${oid}\tsrc/a\n.js\0`
  ]) {
    assert.throws(() => parseHistoricalGitTreeModes(invalidTree),
      /HISTORICAL_GIT_MODE_TREE_INVALID/);
  }

  const candidateRepository = path.win32.join(
    tempRoot, `${HISTORICAL_CANDIDATE_ROOT_PREFIX}ABCDEF`, 'repo'
  );
  const candidateTracked = path.win32.join(
    candidateRepository, ...trackedRelative.split('/')
  );
  const candidateModes = new Map([[trackedRelative, '100644']]);
  const requestedModes = new Map();
  assert.equal(registerHistoricalChmodRequest(
    'win32', candidateTracked, candidateTracked, 0o755,
    tempRoot, candidateModes, requestedModes
  ), true);
  assert.deepEqual([...requestedModes.entries()], [[candidateTracked.toLowerCase(), 0o755]]);
  assert.equal(registerHistoricalChmodRequest(
    'darwin', candidateTracked, candidateTracked, 0o644,
    tempRoot, candidateModes, requestedModes
  ), false);
  assert.equal(registerHistoricalChmodRequest(
    'win32', path.win32.join(tempRoot, '..', 'outside.js'),
    path.win32.join(tempRoot, '..', 'outside.js'), 0o755,
    tempRoot, candidateModes, requestedModes
  ), false);
  assert.deepEqual([...parseHistoricalChmodMap(JSON.stringify([...requestedModes])).entries()],
    [...requestedModes.entries()]);
  assert.throws(() => parseHistoricalChmodMap('{'), /HISTORICAL_CHMOD_MAP_INVALID/);
  assert.throws(() => parseHistoricalChmodMap(JSON.stringify([
    ['relative.js', 0o755]
  ])), /HISTORICAL_CHMOD_MAP_INVALID/);
  assert.throws(() => parseHistoricalChmodMap(JSON.stringify(Array.from(
    { length: HISTORICAL_CHMOD_ENTRY_LIMIT + 1 },
    (_, index) => [`C:\\bounded\\file-${index}.js`, 0o644]
  ))), /HISTORICAL_CHMOD_MAP_INVALID/);

  const makeStat = (mode, kind = 'file') => ({
    mode,
    isFile: () => kind === 'file',
    isSymbolicLink: () => kind === 'symlink'
  });
  const nativeFile = makeStat(0o100666);
  const projectedFile = projectHistoricalGitWorktreeMode(
    'win32', candidateTracked, candidateTracked, candidateRepository,
    candidateModes, requestedModes, nativeFile
  );
  assert.notEqual(projectedFile, nativeFile);
  assert.equal(projectedFile.mode & 0o170000, nativeFile.mode & 0o170000);
  assert.equal(projectedFile.mode & 0o777, 0o755);
  assert.equal(projectHistoricalGitWorktreeMode(
    'win32', tracked, tracked, cwd, modeByPath, new Map(), nativeFile
  ).mode & 0o777, 0o644);
  const executable = path.win32.join(cwd, ...executablePath.split('/'));
  assert.equal(projectHistoricalGitWorktreeMode(
    'win32', executable, executable, cwd, modeByPath, new Map(), nativeFile
  ).mode & 0o777, 0o755);

  const noOpCases = [
    ['darwin', tracked, tracked, cwd, nativeFile],
    ['win32', tracked, path.win32.join(cwd, 'SRC', 'main-process',
      'background-execution', 'runtime.js'), cwd, nativeFile],
    ['win32', 'src\\main-process\\runtime.js', 'src\\main-process\\runtime.js', cwd,
      nativeFile],
    ['win32', path.win32.join(cwd, 'untracked.js'), path.win32.join(cwd, 'untracked.js'),
      cwd, nativeFile],
    ['win32', path.win32.join(cwd, '..', 'outside.js'),
      path.win32.join(cwd, '..', 'outside.js'), cwd, nativeFile],
    ['win32', tracked, tracked, cwd, makeStat(0o100444)],
    ['win32', tracked, tracked, cwd, makeStat(0o120777, 'symlink')]
  ];
  for (const [platform, requestedPath, canonicalRequestedPath, root, stat] of noOpCases) {
    assert.equal(projectHistoricalGitWorktreeMode(
      platform, requestedPath, canonicalRequestedPath, root,
      modeByPath, new Map(), stat
    ), stat);
  }
}

function assertControlledPreloadInheritance(environment, cwd, preloadPath, tempRoot) {
  const cacheProbeSource = [
    "'use strict';",
    "const assert = require('node:assert/strict');",
    "const fs = require('node:fs');",
    "const os = require('node:os');",
    "const { spawnSync } = require('node:child_process');",
    "const preload = process.env.V324_HISTORICAL_PRELOAD_PATH;",
    "assert.ok(require.cache[require.resolve(preload)]);",
    "assert.equal(fs.realpathSync.native(os.tmpdir()), process.env.V324_HISTORICAL_TEMP_ROOT);",
    "assert.equal(process.env.V324_HISTORICAL_CHMOD_MAP, undefined);",
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
      V324_HISTORICAL_PRELOAD_PATH: preloadPath,
      V324_HISTORICAL_TEMP_ROOT: tempRoot
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
    encoding: 'utf8',
    env: {
      ...process.env,
      // 临时 Git authority clone 只复制 tracked tree；最终 v3.2.3 runtime 已经接线
      // NewAccount，而其只读 policy load 会解析 xlsx。依赖仍取自当前受测 checkout
      // 的安装树，候选 repo 内的 ignored shim 不能通过 NODE_PATH 覆盖相对源码模块。
      NODE_PATH: path.join(REPOSITORY_ROOT, 'node_modules')
    }
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

if (!RUN_EXACT_SUITE) {
  nodeTest('R3.2.4 历史 exact evidence 在原提交和 PR 分支上完整复验', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), HISTORICAL_OUTER_ROOT_PREFIX));
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
      runGit(canonicalRepository,
        ['checkout', '--quiet', '-B', EXPECTED_BRANCH, EXACT_EVIDENCE_HEAD]);
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
        V324_HISTORICAL_CHMOD_MAP: 'ambient-forbidden',
        v324_historical_chmod_map: 'ambient-case-forbidden',
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
      assert.equal(nestedEnvironment[HISTORICAL_CHMOD_MAP_ENV], undefined);
      assert.equal(nestedEnvironment.v324_historical_chmod_map, undefined);
      assert.equal(nestedEnvironment.GIT_CONFIG_COUNT, '1');
      assert.equal(nestedEnvironment.GIT_CONFIG_KEY_0, 'core.autocrlf');
      assert.equal(nestedEnvironment.GIT_CONFIG_VALUE_0, 'false');
      assert.equal(nestedEnvironment.GIT_CONFIG_KEY_1, undefined);
      assert.equal(nestedEnvironment.GIT_CONFIG_VALUE_1, undefined);
      assert.equal(nestedEnvironment.GIT_CONFIG_PARAMETERS, undefined);
      assertControlledPreloadInheritance(
        nestedEnvironment, canonicalRepository, preloadPath, canonicalTempRoot
      );
      // 历史 checkout 只包含 tracked tree；原 exact suite 的 nested candidate
      // 会从 outer root 的 node_modules junction 读取安装依赖。preload 只把 Win32
      // path/mode 观测投影为 Git 的跨平台语义；relative source module 仍由每个
      // 候选自己的受审计 HEAD 解析，validator 与 Git 子进程均未被拦截。
      const result = spawnSync(
        process.execPath,
        [
          '--test',
          '--test-reporter=tap',
          'tests/unit/scripts/v3-2-4-release-evidence.test.js'
        ],
        {
          cwd: canonicalRepository,
          encoding: 'utf8',
          env: nestedEnvironment
        }
      );
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.match(result.stdout, /# tests 62\b/);
      assert.match(result.stdout, /# pass 62\b/);
      assert.match(result.stdout, /# fail 0\b/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      assert.equal(fs.existsSync(root), false);
      assert.equal(fs.statSync(SHARED_NODE_MODULES).isDirectory(), true);
    }
  });
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
  assert.equal(result.facts.trackedEntryCount, 2088);
  assert.equal(result.facts.auditRootTrackedEntryCount, 748);
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
