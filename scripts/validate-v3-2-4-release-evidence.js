'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { isDeepStrictEqual } = require('node:util');

const REPOSITORY_ROOT = path.resolve(__dirname, '..');
const EXACT_BASE = 'dc2caebeda3d7b34c9d86e33c10e01bc61f73a5a';
const EXPECTED_BRANCH = 'codex/v3.2.4-r3-release-evidence-restacked';
const EXPECTED_MAIN_REF_OID = 'b7abc2fa00838fc61a94f812c1a14c48d5d4d40f';
const EXPECTED_TAG_REF_COUNT = 25;
const EXPECTED_TAG_REFS_SHA256 =
  '94a09eb7ecd816876a3b2a53c09bd689fcd76d76b56d6c9d3ea83a28e7a8983f';
const SNAPSHOT_PATH = path.join(
  REPOSITORY_ROOT,
  'changes/background-execution-r3-2-4-release-evidence/release-evidence.json'
);
const RELEASE_EVIDENCE_PATHS = Object.freeze([
  'changes/background-execution-r3-2-4-release-evidence/implementation-notes.md',
  'changes/background-execution-r3-2-4-release-evidence/policy-authority.v3.2.4.json',
  'changes/background-execution-r3-2-4-release-evidence/preflight.md',
  'changes/background-execution-r3-2-4-release-evidence/release-evidence.json',
  'scripts/validate-v3-2-4-release-evidence.js',
  'tests/unit/scripts/v3-2-4-release-evidence.test.js'
]);
const MAX_SNAPSHOT_BYTES = 262144;
const MAX_JSON_DEPTH = 128;
const MAX_JSON_NUMBER_TOKEN_LENGTH = 64;
const MAX_CLI_ERRORS = 20;
const MAX_ERROR_CODE_LENGTH = 64;
const MAX_ERROR_PATH_LENGTH = 96;
const MAX_CLI_OUTPUT_BYTES = 4096;
const EXPECTED_TRACKED_ENTRY_COUNT = 1913;
const EXPECTED_AUDIT_TRACKED_ENTRY_COUNT = 656;
const ZERO_OID = '0'.repeat(40);
const AUDIT_ROOTS = Object.freeze([
  'src',
  'scripts',
  'changes/background-execution-r3-2-4-release-evidence'
]);
const AUTHORITY_MODULE_PATHS = Object.freeze([
  'src/main-process/background-execution/runtime.js',
  'src/main-process/recon-id-fix-service/policies.js',
  'src/main-process/vcc-financial-op-output/policies.js'
]);
const POLICY_FIXTURE_SOURCE =
  'changes/background-execution-v3.2.x-contract-baseline/changes/background-execution/' +
  'validation/fixtures/valid/policy-registry.v3.2.x.json';
const VERSIONED_POLICY_AUTHORITY_SOURCE =
  'changes/background-execution-r3-2-4-release-evidence/policy-authority.v3.2.4.json';
const VERSIONED_POLICY_AUTHORITY = Object.freeze({
  actionKey: 'vcc-financial-op:export-subjects',
  blobOid: '372c6cf1cd7e317fb4c126fd23df68869d66310b',
  sha256: '2dfe9d3e8316d5d7ab1db9bfd6ae72c54d0d9852f39f8dfff291cf6d6993befb'
});
const SPEC_SOURCE =
  'changes/background-execution-v3.2.x-contract-baseline/changes/3.2.4/spec.md';

const ACTION_KEYS = Object.freeze([
  'recon-fix:import',
  'recon-fix:run-readonly',
  'recon-fix:run-jpm',
  'recon-fix:export',
  'vcc-financial-op:export-subjects',
  'vcc-financial-op:export-single'
]);

const AUTHORITY_SOURCES = Object.freeze([
  Object.freeze({
    id: 'RECON-DIRECT-POLICY',
    source: 'src/main-process/recon-id-fix-service/policies.js',
    blobOid: '2060400dd2b4898f91fa05d4eac3a00d7fb5a8b8',
    sha256: '0488cdd3f7f420e8615e8f95775fd8107b396264712a1c748f40d2ac2242aa18'
  }),
  Object.freeze({
    id: 'VCC-DIRECT-POLICY',
    source: 'src/main-process/vcc-financial-op-output/policies.js',
    blobOid: '435ca844480a45e6d5083f91960875249934d3b6',
    sha256: '3bf520ac9fc1ae131b4355e5a973c9f111fa6e2e0d4c36ab1f0478586b8c3b80'
  }),
  Object.freeze({
    id: 'COMMON-RUNTIME',
    source: 'src/main-process/background-execution/runtime.js',
    blobOid: '32bfaca2caf418d9116c8bf96fc3a01274a59d14',
    sha256: '43e8b67ba287d7956ce9f3d6d926f55078895e6fdff2ad13ee230e7a710b0e03'
  }),
  Object.freeze({
    id: 'CANONICAL-POLICY-FIXTURE',
    source: POLICY_FIXTURE_SOURCE,
    blobOid: '745b27a50c513c90c25c1b1125e743683439ac90',
    sha256: '8ab98e4b7a7b0c669892f069881c25eaaf1f8241b1e7d71e5b63eed8b2c38a22'
  })
]);

const EXPECTED_EVIDENCE = Object.freeze([
  Object.freeze({
    id: 'V3.2.4-FROZEN-SPEC', actionKey: null, reviewedHead: EXACT_BASE,
    source: SPEC_SOURCE, blobOid: 'a41c8937bfd5177af38d41cabe908ab419f5fb3e',
    sha256: 'dad81f149405281043306f7ce735f672fa20a167b4d8de751d5b254318fac2c7',
    requiredFacts: ACTION_KEYS
  }),
  Object.freeze({
    id: 'E11-A-RECON-IMPORT', actionKey: 'recon-fix:import',
    reviewedHead: 'c6c7ffa5ec195eaca366120d5617e93f558f650f',
    source: 'changes/background-execution-e11-a-recon-fix-service/implementation-notes.md',
    blobOid: '38bcdafeccd46b5f684dcc15635df19916f0ab31',
    sha256: '1d6936f97d18905dcdbb4b68553238e07d8786038d5dcdff417e32dbfb37d892',
    requiredFacts: ['E11-A', 'import', 'production']
  }),
  Object.freeze({
    id: 'E11-A-RECON-READONLY', actionKey: 'recon-fix:run-readonly',
    reviewedHead: 'c6c7ffa5ec195eaca366120d5617e93f558f650f',
    source: 'changes/background-execution-e11-a-recon-fix-service/implementation-notes.md',
    blobOid: '38bcdafeccd46b5f684dcc15635df19916f0ab31',
    sha256: '1d6936f97d18905dcdbb4b68553238e07d8786038d5dcdff417e32dbfb37d892',
    requiredFacts: ['E11-A', 'standard/BOC', 'production']
  }),
  Object.freeze({
    id: 'E11-P0-JPM-PRIMITIVES', actionKey: 'recon-fix:run-jpm',
    reviewedHead: '888688afdeea9a32b8ac0277a027533308a277bb',
    source: 'changes/background-execution-e11-p0-jpm-id-aware-receipt/implementation-notes.md',
    blobOid: '9dc61d0d208282fe8627b28212ca8e6dd9dd71b4',
    sha256: '224be8de60bf7a4ebd8f82678be761ac7926eaeb1df8807ca00ddb164c604fa8',
    requiredFacts: ['E11-P0', 'receipt', 'no-op']
  }),
  Object.freeze({
    id: 'E11-B-JPM-DURABLE', actionKey: 'recon-fix:run-jpm',
    reviewedHead: '1afaf5db8f7a9a406ef037a685586456d106b12c',
    source: 'changes/background-execution-e11-b-jpm-durable-inspector/implementation-notes.md',
    blobOid: '110b0b53e7a0195a3cdd15db96dadef1d4cb7326',
    sha256: '1361a789c62921a74384f138d80c499263bf6e0145c15e2d65cfb31135f86a31',
    requiredFacts: ['E11-B', 'Inspector', 'production']
  }),
  Object.freeze({
    id: 'E11-C-RECON-EXPORT', actionKey: 'recon-fix:export',
    reviewedHead: '50408e612d6775e33eafebd89145de4807a20d3a',
    source: 'changes/background-execution-e11-c-recon-fix-export/implementation-notes.md',
    blobOid: '801037bf02ba7b548619455e8f0b837da2bb0b2f',
    sha256: '262bfb56ff39c9fb342cc1a6a5f013404c585ae5f9a5223257507607de425fbd',
    requiredFacts: ['recon-fix:export', 'Publisher', 'production']
  }),
  Object.freeze({
    id: 'E12-A-VCC-SINGLE', actionKey: 'vcc-financial-op:export-single',
    reviewedHead: '38c319427577671e3e3708b0dd3d4df4a3aff621',
    source: 'changes/background-execution-e12-a-vcc-single-writer/implementation-notes.md',
    blobOid: '735073fbdbd3c2c8e69143a6fc67bfa1b9ccbcea',
    sha256: '54a0f82e49b03a0d1aed5f2ef610af0184431460517029e9c2de150576b10f0d',
    requiredFacts: ['E12-A', 'single Writer', 'production']
  }),
  Object.freeze({
    id: 'E12-B-VCC-SUBJECT-QUERY', actionKey: 'vcc-financial-op:export-subjects',
    reviewedHead: '9c66a7f52b262c5746456667af34abb3c6c1f588',
    source: 'changes/background-execution-e12-b-vcc-subject-query-restacked/implementation-notes.md',
    blobOid: '84660a522e1364e9d1a89255e1b071b7f78aba46',
    sha256: 'c9083e09e3bda19522291fec99ed6760009cad2ec4cd83d332edd4da0ff6a9be',
    requiredFacts: ['E12-B', 'subject', 'production']
  }),
  Object.freeze({
    id: 'E12-C-VCC-DUAL', actionKey: 'vcc-financial-op:export-subjects',
    reviewedHead: EXACT_BASE,
    source: 'changes/background-execution-e12-c-vcc-dual-writer-restacked/implementation-notes.md',
    blobOid: '211db9f8f01413c1f2948d393259bd397190b840',
    sha256: 'dd990e7328f64049f7d4be087e02a731a6150d5a31f03b4e1e5b0f1268524aca',
    requiredFacts: ['E12-C', '50.09%', 'production=false']
  })
]);

const COMMON_GATES = Object.freeze({
  windowsPackaged: 'NOT_RUN',
  realProcessTermination: 'NOT_RUN',
  realBusinessSamples: 'PENDING_HUMAN_REVIEW',
  funds: 'PENDING_HUMAN_REVIEW',
  recovery: 'PENDING_HUMAN_REVIEW'
});

const ACTION_RELEASE = Object.freeze({
  'recon-fix:import': Object.freeze({
    evidenceRefs: Object.freeze(['E11-A-RECON-IMPORT']),
    reasonCodes: Object.freeze(['WINDOWS_PACKAGED_NOT_RUN', 'BUSINESS_FILE_REVIEW_PENDING',
      'FUNDS_REVIEW_PENDING']),
    gates: Object.freeze({ ...COMMON_GATES, excelWps: 'NOT_APPLICABLE', performance: 'NOT_RUN' }),
    rollbackStrategyKey: 'KEEP_LEGACY_RECON_IMPORT'
  }),
  'recon-fix:run-readonly': Object.freeze({
    evidenceRefs: Object.freeze(['E11-A-RECON-READONLY']),
    reasonCodes: Object.freeze(['WINDOWS_PACKAGED_NOT_RUN', 'BUSINESS_FILE_REVIEW_PENDING',
      'FUNDS_REVIEW_PENDING']),
    gates: Object.freeze({ ...COMMON_GATES, excelWps: 'NOT_APPLICABLE', performance: 'NOT_RUN' }),
    rollbackStrategyKey: 'KEEP_LEGACY_RECON_READONLY'
  }),
  'recon-fix:run-jpm': Object.freeze({
    evidenceRefs: Object.freeze(['E11-P0-JPM-PRIMITIVES', 'E11-B-JPM-DURABLE']),
    reasonCodes: Object.freeze(['WINDOWS_PACKAGED_NOT_RUN', 'REAL_TERMINATION_NOT_RUN',
      'JPM_FUNDS_REVIEW_PENDING', 'RECOVERY_REVIEW_PENDING']),
    gates: Object.freeze({ ...COMMON_GATES, excelWps: 'NOT_APPLICABLE', performance: 'NOT_RUN' }),
    rollbackStrategyKey: 'KEEP_LEGACY_JPM_PRESERVE_RECEIPTS_HOLDS'
  }),
  'recon-fix:export': Object.freeze({
    evidenceRefs: Object.freeze(['E11-C-RECON-EXPORT']),
    reasonCodes: Object.freeze(['WINDOWS_PACKAGED_NOT_RUN', 'EXCEL_WPS_REVIEW_PENDING',
      'BUSINESS_FILE_REVIEW_PENDING', 'RECOVERY_REVIEW_PENDING']),
    gates: Object.freeze({ ...COMMON_GATES, excelWps: 'PENDING_HUMAN_REVIEW', performance: 'NOT_RUN' }),
    rollbackStrategyKey: 'KEEP_LEGACY_RECON_EXPORT_PUBLISHER'
  }),
  'vcc-financial-op:export-subjects': Object.freeze({
    evidenceRefs: Object.freeze(['E12-B-VCC-SUBJECT-QUERY', 'E12-C-VCC-DUAL']),
    reasonCodes: Object.freeze(['WINDOWS_PACKAGED_NOT_RUN', 'REAL_LARGE_SAMPLE_NOT_RUN',
      'RSS_WINDOWS_UNQUALIFIED', 'EXCEL_WPS_REVIEW_PENDING', 'FUNDS_REVIEW_PENDING']),
    gates: Object.freeze({ ...COMMON_GATES, excelWps: 'PENDING_HUMAN_REVIEW',
      performance: 'LOCAL_SYNTHETIC_ONLY' }),
    rollbackStrategyKey: 'KEEP_LEGACY_VCC_SUBJECT_EXPORT'
  }),
  'vcc-financial-op:export-single': Object.freeze({
    evidenceRefs: Object.freeze(['E12-A-VCC-SINGLE']),
    reasonCodes: Object.freeze(['WINDOWS_PACKAGED_NOT_RUN', 'EXCEL_WPS_REVIEW_PENDING',
      'BUSINESS_FILE_REVIEW_PENDING', 'FUNDS_REVIEW_PENDING']),
    gates: Object.freeze({ ...COMMON_GATES, excelWps: 'PENDING_HUMAN_REVIEW', performance: 'NOT_RUN' }),
    rollbackStrategyKey: 'KEEP_LEGACY_VCC_SINGLE_EXPORT'
  })
});

function canonicalText(value) {
  return String(value).replace(/\r\n/g, '\n');
}

function sha256(value) {
  return crypto.createHash('sha256').update(canonicalText(value), 'utf8').digest('hex');
}

function sha256File(filePath) {
  return sha256(fs.readFileSync(filePath, 'utf8'));
}

function runGit(args, encoding = 'utf8') {
  return spawnSync('git', args, { cwd: REPOSITORY_ROOT, encoding });
}

function gitError(code, fieldPath) {
  return { code, path: fieldPath };
}

function parseRawDiffRecords(buffer) {
  const parts = buffer.toString('utf8').split('\0');
  const records = [];
  let index = 0;
  while (index < parts.length && parts[index] !== '') {
    const header = parts[index++];
    const fields = header.split(' ');
    if (fields.length !== 5 || !fields[0].startsWith(':')) {
      return { error: gitError('GIT_DIFF_FORMAT_INVALID', '/git/diff') };
    }
    const status = fields[4];
    const sourcePath = parts[index++];
    if (sourcePath === undefined || sourcePath === '') {
      return { error: gitError('GIT_DIFF_FORMAT_INVALID', '/git/diff') };
    }
    let destinationPath = null;
    if (status.startsWith('R') || status.startsWith('C')) {
      destinationPath = parts[index++];
      if (destinationPath === undefined || destinationPath === '') {
        return { error: gitError('GIT_DIFF_FORMAT_INVALID', '/git/diff') };
      }
    }
    records.push({
      oldMode: fields[0].slice(1),
      newMode: fields[1],
      oldOid: fields[2],
      newOid: fields[3],
      status,
      sourcePath,
      destinationPath
    });
  }
  return { records };
}

function parseHeadTreeEntries(buffer) {
  const entries = [];
  const records = buffer.toString('utf8').split('\0');
  for (const record of records) {
    if (record === '') continue;
    const separator = record.indexOf('\t');
    const metadata = separator >= 0 ? record.slice(0, separator).split(' ') : [];
    const relativePath = separator >= 0 ? record.slice(separator + 1) : '';
    if (metadata.length !== 3 || !/^[0-7]{6}$/.test(metadata[0]) ||
        !/^[a-f0-9]{40}$/.test(metadata[2]) || relativePath === '') {
      return { error: gitError('GIT_HEAD_TREE_FORMAT_INVALID', '/git/head-tree') };
    }
    entries.push({ mode: metadata[0], type: metadata[1], oid: metadata[2], relativePath });
  }
  return { entries };
}

function parseIndexEntries(buffer) {
  const entries = [];
  const records = buffer.toString('utf8').split('\0');
  for (const record of records) {
    if (record === '') continue;
    const separator = record.indexOf('\t');
    const metadata = separator >= 0 ? record.slice(0, separator) : '';
    const relativePath = separator >= 0 ? record.slice(separator + 1) : '';
    const match = /^(.?) ([0-7]{6}) ([a-f0-9]{40}) ([0-3])$/.exec(metadata);
    if (!match || relativePath === '') {
      return { error: gitError('GIT_INDEX_FORMAT_INVALID', '/git/index') };
    }
    entries.push({
      tag: match[1],
      mode: match[2],
      oid: match[3],
      stage: Number(match[4]),
      relativePath
    });
  }
  return { entries };
}

function safeRepositoryPath(relativePath, realRepositoryRoot) {
  if (path.isAbsolute(relativePath) || relativePath.includes('\0')) return null;
  const absolutePath = path.resolve(REPOSITORY_ROOT, relativePath);
  const relative = path.relative(REPOSITORY_ROOT, absolutePath);
  if (relative !== relativePath || relative === '..' || relative.startsWith('..' + path.sep)) {
    return null;
  }
  const expectedRealPath = path.join(realRepositoryRoot, relativePath);
  return { absolutePath, expectedRealPath };
}

function hashRegularWorktreeEntries(entries) {
  const oids = new Map();
  const chunkSize = 128;
  for (let offset = 0; offset < entries.length; offset += chunkSize) {
    const chunk = entries.slice(offset, offset + chunkSize);
    const result = runGit(['hash-object', '--', ...chunk.map((entry) => entry.relativePath)]);
    const values = result.status === 0
      ? result.stdout.trim().split('\n').filter(Boolean)
      : [];
    if (values.length !== chunk.length || values.some((oid) => !/^[a-f0-9]{40}$/.test(oid))) {
      return { error: gitError('GIT_WORKTREE_HASH_INVALID', '/git/worktree-tree') };
    }
    chunk.forEach((entry, index) => oids.set(entry.relativePath, values[index]));
  }
  return { oids };
}

function hashSymlinkTarget(absolutePath) {
  let target;
  try {
    target = fs.readlinkSync(absolutePath, { encoding: 'buffer' });
  } catch {
    return null;
  }
  const result = spawnSync('git', ['hash-object', '--stdin'], {
    cwd: REPOSITORY_ROOT,
    input: target,
    encoding: 'utf8'
  });
  const oid = result.status === 0 ? result.stdout.trim() : '';
  return /^[a-f0-9]{40}$/.test(oid) ? oid : null;
}

function verifyWorktreeTree(headEntries) {
  let realRepositoryRoot;
  try {
    realRepositoryRoot = fs.realpathSync.native(REPOSITORY_ROOT);
  } catch {
    return { error: gitError('GIT_WORKTREE_TREE_INVALID', '/git/worktree-tree') };
  }

  const regularEntries = [];
  for (const entry of headEntries) {
    if (entry.type !== 'blob' || !['100644', '100755', '120000'].includes(entry.mode)) {
      return { error: gitError('GIT_HEAD_ENTRY_TYPE_INVALID', '/git/head-tree') };
    }
    const safePath = safeRepositoryPath(entry.relativePath, realRepositoryRoot);
    if (!safePath) {
      return { error: gitError('GIT_HEAD_ENTRY_PATH_INVALID', '/git/head-tree') };
    }

    let stat;
    let realParent;
    try {
      stat = fs.lstatSync(safePath.absolutePath);
      realParent = fs.realpathSync.native(path.dirname(safePath.absolutePath));
    } catch {
      return { error: gitError('GIT_WORKTREE_TREE_INVALID', '/git/worktree-tree') };
    }
    if (realParent !== path.dirname(safePath.expectedRealPath)) {
      return { error: gitError('GIT_WORKTREE_TREE_INVALID', '/git/worktree-tree') };
    }

    if (entry.mode === '120000') {
      if (!stat.isSymbolicLink() || hashSymlinkTarget(safePath.absolutePath) !== entry.oid) {
        return { error: gitError('GIT_WORKTREE_TREE_INVALID', '/git/worktree-tree') };
      }
      continue;
    }

    const expectedPermissions = entry.mode === '100755' ? 0o755 : 0o644;
    let realPath;
    try {
      realPath = fs.realpathSync.native(safePath.absolutePath);
    } catch {
      return { error: gitError('GIT_WORKTREE_TREE_INVALID', '/git/worktree-tree') };
    }
    if (!stat.isFile() || (stat.mode & 0o777) !== expectedPermissions ||
        realPath !== safePath.expectedRealPath) {
      return { error: gitError('GIT_WORKTREE_TREE_INVALID', '/git/worktree-tree') };
    }
    regularEntries.push(entry);
  }

  const hashed = hashRegularWorktreeEntries(regularEntries);
  if (hashed.error || regularEntries.some((entry) => hashed.oids.get(entry.relativePath) !== entry.oid)) {
    return { error: gitError('GIT_WORKTREE_TREE_INVALID', '/git/worktree-tree') };
  }
  return { valid: true };
}

function auditRootForPath(relativePath) {
  return AUDIT_ROOTS.find((root) => relativePath === root || relativePath.startsWith(root + '/')) || null;
}

function verifyAuditRootClosure(headEntries) {
  let realRepositoryRoot;
  try {
    realRepositoryRoot = fs.realpathSync.native(REPOSITORY_ROOT);
  } catch {
    return { error: gitError('GIT_AUDIT_ROOT_INVALID', '/git/audit-roots') };
  }

  const trackedPaths = new Set();
  const expectedDirectories = new Set(AUDIT_ROOTS);
  for (const entry of headEntries) {
    const root = auditRootForPath(entry.relativePath);
    if (!root) continue;
    trackedPaths.add(entry.relativePath);
    let directory = path.posix.dirname(entry.relativePath);
    while (directory !== '.' && auditRootForPath(directory) === root) {
      expectedDirectories.add(directory);
      if (directory === root) break;
      directory = path.posix.dirname(directory);
    }
  }
  if (trackedPaths.size !== EXPECTED_AUDIT_TRACKED_ENTRY_COUNT) {
    return { error: gitError('GIT_AUDIT_ROOT_TREE_INVALID', '/git/audit-roots') };
  }

  const actualPaths = new Set();
  const visit = (relativeDirectory) => {
    const safeDirectory = safeRepositoryPath(relativeDirectory, realRepositoryRoot);
    if (!safeDirectory || !expectedDirectories.has(relativeDirectory)) {
      throw new Error('audit-root-directory');
    }
    const directoryStat = fs.lstatSync(safeDirectory.absolutePath);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() ||
        fs.realpathSync.native(safeDirectory.absolutePath) !== safeDirectory.expectedRealPath) {
      throw new Error('audit-root-directory');
    }
    const names = fs.readdirSync(safeDirectory.absolutePath).sort();
    for (const name of names) {
      const relativePath = relativeDirectory + '/' + name;
      const safePath = safeRepositoryPath(relativePath, realRepositoryRoot);
      if (!safePath) throw new Error('audit-root-path');
      const stat = fs.lstatSync(safePath.absolutePath);
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        if (!expectedDirectories.has(relativePath) ||
            fs.realpathSync.native(safePath.absolutePath) !== safePath.expectedRealPath) {
          throw new Error('audit-root-extra-directory');
        }
        visit(relativePath);
        continue;
      }
      if (!trackedPaths.has(relativePath) || (!stat.isFile() && !stat.isSymbolicLink())) {
        throw new Error('audit-root-extra-entry');
      }
      actualPaths.add(relativePath);
    }
  };

  try {
    for (const root of AUDIT_ROOTS) visit(root);
  } catch {
    return { error: gitError('GIT_AUDIT_ROOT_EXTRA_ENTRY', '/git/audit-roots') };
  }
  if (!isDeepStrictEqual([...actualPaths].sort(), [...trackedPaths].sort())) {
    return { error: gitError('GIT_AUDIT_ROOT_TREE_INVALID', '/git/audit-roots') };
  }
  return { valid: true, trackedEntryCount: trackedPaths.size };
}

function bootstrapGitAuthorityGuard() {
  const errors = [];
  const facts = {
    branchName: null,
    head: null,
    parent: null,
    mainRefOid: null,
    tagRefCount: null,
    tagRefsSha256: null,
    tagsPointingAtHead: null,
    trackedEntryCount: null,
    auditRootTrackedEntryCount: null,
    auditRootState: 'UNKNOWN',
    indexState: 'UNKNOWN',
    worktreeTreeState: 'UNKNOWN',
    untrackedState: 'UNKNOWN',
    trackedState: 'UNKNOWN',
    changedPaths: []
  };

  const repository = runGit(['rev-parse', '--show-toplevel']);
  if (repository.status !== 0 ||
      path.resolve(String(repository.stdout || '').trim()) !== REPOSITORY_ROOT) {
    errors.push(gitError('GIT_REPOSITORY_IDENTITY_INVALID', '/git/repository'));
    return { valid: false, errors, facts };
  }

  const head = runGit(['rev-parse', '--verify', 'HEAD^{commit}']);
  if (head.status !== 0) {
    errors.push(gitError('GIT_HEAD_INVALID', '/git/head'));
    return { valid: false, errors, facts };
  }
  facts.head = head.stdout.trim();

  const parents = runGit(['rev-list', '--parents', '-n', '1', 'HEAD']);
  const parentFields = parents.status === 0 ? parents.stdout.trim().split(/\s+/) : [];
  if (parentFields.length !== 2 || parentFields[0] !== facts.head ||
      parentFields[1] !== EXACT_BASE) {
    errors.push(gitError('GIT_PARENT_SHAPE_INVALID', '/git/parent'));
  } else {
    facts.parent = parentFields[1];
  }

  const branch = runGit(['symbolic-ref', '--quiet', '--short', 'HEAD']);
  facts.branchName = branch.status === 0 ? branch.stdout.trim() : null;
  if (facts.branchName !== EXPECTED_BRANCH) {
    errors.push(gitError('GIT_BRANCH_INVALID', '/git/branch'));
  }

  let indexExact = false;
  let worktreeExact = false;
  let auditRootExact = false;
  let trackedStatusClean = false;
  const headTree = runGit(['ls-tree', '-r', '-z', '--full-tree', 'HEAD'], null);
  const parsedHeadTree = headTree.status === 0
    ? parseHeadTreeEntries(headTree.stdout)
    : { error: gitError('GIT_HEAD_TREE_UNAVAILABLE', '/git/head-tree') };
  let headEntries = [];
  if (parsedHeadTree.error) {
    errors.push(parsedHeadTree.error);
  } else {
    headEntries = parsedHeadTree.entries;
    facts.trackedEntryCount = headEntries.length;
    if (headEntries.length !== EXPECTED_TRACKED_ENTRY_COUNT) {
      errors.push(gitError('GIT_HEAD_TREE_INVALID', '/git/head-tree'));
    }
  }

  const index = runGit(['ls-files', '--stage', '-v', '-f', '-z'], null);
  const parsedIndex = index.status === 0
    ? parseIndexEntries(index.stdout)
    : { error: gitError('GIT_INDEX_UNAVAILABLE', '/git/index') };
  if (parsedIndex.error) {
    errors.push(parsedIndex.error);
  } else {
    const hasNonDefaultFlags = parsedIndex.entries.some((entry) => entry.tag !== 'H');
    const hasNonZeroStage = parsedIndex.entries.some((entry) => entry.stage !== 0);
    if (hasNonDefaultFlags) {
      errors.push(gitError('GIT_INDEX_FLAGS_INVALID', '/git/index-flags'));
    }
    if (hasNonZeroStage) {
      errors.push(gitError('GIT_INDEX_UNMERGED', '/git/index-stage'));
    }
    const projectedIndex = parsedIndex.entries.map(({ mode, oid, relativePath }) => ({
      mode, oid, relativePath
    }));
    const projectedHead = headEntries.map(({ mode, oid, relativePath }) => ({
      mode, oid, relativePath
    }));
    indexExact = !hasNonDefaultFlags && !hasNonZeroStage &&
      isDeepStrictEqual(projectedIndex, projectedHead);
    if (!isDeepStrictEqual(projectedIndex, projectedHead)) {
      errors.push(gitError('GIT_INDEX_TREE_INVALID', '/git/index-tree'));
    }
    if (indexExact) facts.indexState = 'HEAD_EXACT_DEFAULT_FLAGS';
  }

  if (!parsedHeadTree.error) {
    const verifiedWorktree = verifyWorktreeTree(headEntries);
    if (verifiedWorktree.error) {
      errors.push(verifiedWorktree.error);
    } else {
      worktreeExact = true;
      facts.worktreeTreeState = 'HEAD_EXACT';
    }
    const verifiedAuditRoots = verifyAuditRootClosure(headEntries);
    if (verifiedAuditRoots.error) {
      errors.push(verifiedAuditRoots.error);
    } else {
      auditRootExact = true;
      facts.auditRootTrackedEntryCount = verifiedAuditRoots.trackedEntryCount;
      facts.auditRootState = 'HEAD_EXACT';
    }
  }

  const status = runGit(['status', '--porcelain=v1', '-z', '--untracked-files=all'], null);
  if (status.status !== 0) {
    errors.push(gitError('GIT_STATUS_UNAVAILABLE', '/git/status'));
  } else {
    const records = status.stdout.toString('utf8').split('\0').filter(Boolean);
    const hasUntracked = records.some((record) => record.startsWith('?? '));
    const hasTrackedStatus = records.some((record) => !record.startsWith('?? '));
    if (hasUntracked) {
      errors.push(gitError('GIT_UNTRACKED_STATE_INVALID', '/git/untracked-state'));
    } else {
      facts.untrackedState = 'CLEAN';
    }
    if (hasTrackedStatus) {
      errors.push(gitError('GIT_TRACKED_STATE_DIRTY', '/git/tracked-state'));
    } else {
      trackedStatusClean = true;
    }
  }
  if (indexExact && worktreeExact && auditRootExact && trackedStatusClean &&
      facts.untrackedState === 'CLEAN') {
    facts.trackedState = 'CLEAN';
  }

  const diff = runGit([
    'diff-tree', '--raw', '-r', '-z', '--no-commit-id', '--find-renames=50%',
    '--find-copies=50%', EXACT_BASE, 'HEAD'
  ], null);
  if (diff.status !== 0) {
    errors.push(gitError('GIT_DIFF_UNAVAILABLE', '/git/diff'));
  } else {
    const parsed = parseRawDiffRecords(diff.stdout);
    if (parsed.error) {
      errors.push(parsed.error);
    } else {
      facts.changedPaths = parsed.records.map((record) => record.destinationPath || record.sourcePath);
      const exactAdditions = parsed.records.every((record) =>
        record.status === 'A' &&
        record.oldMode === '000000' &&
        record.newMode === '100644' &&
        record.oldOid === ZERO_OID &&
        record.destinationPath === null
      );
      if (!exactAdditions || !isDeepStrictEqual(facts.changedPaths, RELEASE_EVIDENCE_PATHS)) {
        errors.push(gitError('GIT_CHANGED_PATHS_INVALID', '/git/diff'));
      }
    }
  }

  const mainRef = runGit(['rev-parse', '--verify', 'refs/heads/main^{commit}']);
  facts.mainRefOid = mainRef.status === 0 ? mainRef.stdout.trim() : null;
  if (facts.mainRefOid !== EXPECTED_MAIN_REF_OID || facts.head === facts.mainRefOid) {
    errors.push(gitError('GIT_MAIN_REF_INVALID', '/git/main-ref'));
  }

  const headTags = runGit(['tag', '--points-at', 'HEAD']);
  const tags = headTags.status === 0
    ? headTags.stdout.split('\n').map((value) => value.trim()).filter(Boolean)
    : [];
  facts.tagsPointingAtHead = headTags.status === 0 ? tags.length : null;
  if (headTags.status !== 0 || tags.length !== 0) {
    errors.push(gitError('GIT_HEAD_TAGGED', '/git/tags'));
  }

  const tagRefs = runGit([
    'for-each-ref', '--sort=refname', '--format=%(refname)%00%(objectname)', 'refs/tags'
  ], null);
  if (tagRefs.status === 0) {
    facts.tagRefCount = tagRefs.stdout.toString('utf8').split('\n').filter(Boolean).length;
    facts.tagRefsSha256 = crypto.createHash('sha256').update(tagRefs.stdout).digest('hex');
  }
  if (tagRefs.status !== 0 || facts.tagRefCount !== EXPECTED_TAG_REF_COUNT ||
      facts.tagRefsSha256 !== EXPECTED_TAG_REFS_SHA256) {
    errors.push(gitError('GIT_TAG_REFS_INVALID', '/git/tag-refs'));
  }

  return { valid: errors.length === 0, errors, facts };
}

class StrictJsonError extends Error {
  constructor(code, offset = 0) {
    super(code);
    this.name = 'StrictJsonError';
    this.code = code;
    this.path = '/json/offset/' + Math.min(Number.isSafeInteger(offset) ? offset : 0, 999999);
  }
}

function parseStrictJson(raw) {
  if (typeof raw !== 'string') throw new StrictJsonError('RAW_JSON_TYPE_INVALID');
  if (Buffer.byteLength(raw, 'utf8') > MAX_SNAPSHOT_BYTES) {
    throw new StrictJsonError('RAW_JSON_TOO_LARGE');
  }

  let cursor = 0;
  const isDigit = (character) => character >= '0' && character <= '9';
  const isHex = (character) => isDigit(character) ||
    (character >= 'a' && character <= 'f') ||
    (character >= 'A' && character <= 'F');
  const skipWhitespace = () => {
    while (cursor < raw.length &&
      (raw[cursor] === ' ' || raw[cursor] === '\t' || raw[cursor] === '\r' || raw[cursor] === '\n')) {
      cursor += 1;
    }
  };
  const malformed = () => { throw new StrictJsonError('RAW_JSON_MALFORMED', cursor); };

  const parseString = () => {
    if (raw[cursor] !== '"') malformed();
    const start = cursor;
    cursor += 1;
    while (cursor < raw.length) {
      const code = raw.charCodeAt(cursor);
      const character = raw[cursor++];
      if (character === '"') {
        try {
          return JSON.parse(raw.slice(start, cursor));
        } catch {
          malformed();
        }
      }
      if (code <= 0x1f) malformed();
      if (character !== '\\') continue;
      if (cursor >= raw.length) malformed();
      const escape = raw[cursor++];
      if ('"\\/bfnrt'.includes(escape)) continue;
      if (escape !== 'u' || cursor + 4 > raw.length) malformed();
      for (let index = 0; index < 4; index += 1) {
        if (!isHex(raw[cursor + index])) malformed();
      }
      cursor += 4;
    }
    malformed();
  };

  const parseNumber = () => {
    const start = cursor;
    if (raw[cursor] === '-') cursor += 1;
    if (raw[cursor] === '0') {
      cursor += 1;
      if (isDigit(raw[cursor])) malformed();
    } else {
      if (!isDigit(raw[cursor]) || raw[cursor] === '0') malformed();
      while (isDigit(raw[cursor])) cursor += 1;
    }
    if (raw[cursor] === '.') {
      cursor += 1;
      if (!isDigit(raw[cursor])) malformed();
      while (isDigit(raw[cursor])) cursor += 1;
    }
    if (raw[cursor] === 'e' || raw[cursor] === 'E') {
      cursor += 1;
      if (raw[cursor] === '+' || raw[cursor] === '-') cursor += 1;
      if (!isDigit(raw[cursor])) malformed();
      while (isDigit(raw[cursor])) cursor += 1;
    }

    const lexeme = raw.slice(start, cursor);
    if (lexeme.length > MAX_JSON_NUMBER_TOKEN_LENGTH) {
      throw new StrictJsonError('RAW_JSON_NUMBER_TOO_LONG', start);
    }
    const significandDigits = lexeme.split(/[eE]/, 1)[0].replace(/[-.]/g, '');
    if (/\d{12,}/.test(significandDigits)) {
      throw new StrictJsonError('RAW_JSON_FINANCIAL_NUMBER_FORBIDDEN', start);
    }
    if (/[eE]/.test(lexeme)) {
      throw new StrictJsonError('RAW_JSON_NUMBER_NON_CANONICAL', start);
    }
    const numericValue = Number(lexeme);
    if (!Number.isFinite(numericValue) ||
        (Number.isInteger(numericValue) && !Number.isSafeInteger(numericValue))) {
      throw new StrictJsonError('RAW_JSON_NUMBER_UNSAFE', start);
    }
    if (Object.is(numericValue, -0) || JSON.stringify(numericValue) !== lexeme) {
      throw new StrictJsonError('RAW_JSON_NUMBER_NON_CANONICAL', start);
    }
  };

  const parseLiteral = (literal) => {
    if (raw.slice(cursor, cursor + literal.length) !== literal) malformed();
    cursor += literal.length;
  };

  const parseValue = (depth) => {
    if (depth > MAX_JSON_DEPTH) throw new StrictJsonError('RAW_JSON_TOO_DEEP', cursor);
    skipWhitespace();
    const character = raw[cursor];
    if (character === '"') {
      parseString();
      return;
    }
    if (character === '{') {
      cursor += 1;
      skipWhitespace();
      const keys = new Set();
      if (raw[cursor] === '}') {
        cursor += 1;
        return;
      }
      while (cursor < raw.length) {
        skipWhitespace();
        const keyOffset = cursor;
        const key = parseString().normalize('NFKC');
        if (keys.has(key)) throw new StrictJsonError('RAW_JSON_DUPLICATE_KEY', keyOffset);
        keys.add(key);
        skipWhitespace();
        if (raw[cursor++] !== ':') malformed();
        parseValue(depth + 1);
        skipWhitespace();
        const delimiter = raw[cursor++];
        if (delimiter === '}') return;
        if (delimiter !== ',') malformed();
      }
      malformed();
    }
    if (character === '[') {
      cursor += 1;
      skipWhitespace();
      if (raw[cursor] === ']') {
        cursor += 1;
        return;
      }
      while (cursor < raw.length) {
        parseValue(depth + 1);
        skipWhitespace();
        const delimiter = raw[cursor++];
        if (delimiter === ']') return;
        if (delimiter !== ',') malformed();
      }
      malformed();
    }
    if (character === 't') return parseLiteral('true');
    if (character === 'f') return parseLiteral('false');
    if (character === 'n') return parseLiteral('null');
    if (character === '-' || isDigit(character)) return parseNumber();
    malformed();
  };

  parseValue(0);
  skipWhitespace();
  if (cursor !== raw.length) malformed();
  try {
    return JSON.parse(raw);
  } catch {
    malformed();
  }
}

let policyAuthorities = null;

function resolveExactTrackedModule(relativePath) {
  if (!AUTHORITY_MODULE_PATHS.includes(relativePath) || !relativePath.endsWith('.js')) {
    return { error: gitError('AUTHORITY_MODULE_PATH_INVALID', '/authority/module') };
  }
  let realRepositoryRoot;
  try {
    realRepositoryRoot = fs.realpathSync.native(REPOSITORY_ROOT);
  } catch {
    return { error: gitError('AUTHORITY_MODULE_PATH_INVALID', '/authority/module') };
  }
  const safePath = safeRepositoryPath(relativePath, realRepositoryRoot);
  if (!safePath) {
    return { error: gitError('AUTHORITY_MODULE_PATH_INVALID', '/authority/module') };
  }

  let resolvedPath;
  let realResolvedPath;
  try {
    resolvedPath = require.resolve(safePath.absolutePath);
    realResolvedPath = fs.realpathSync.native(resolvedPath);
  } catch {
    return { error: gitError('AUTHORITY_MODULE_PATH_INVALID', '/authority/module') };
  }
  if (resolvedPath !== safePath.absolutePath || realResolvedPath !== safePath.expectedRealPath) {
    return { error: gitError('AUTHORITY_MODULE_PATH_INVALID', '/authority/module') };
  }

  const tree = runGit(['ls-tree', '-r', '-z', '--full-tree', 'HEAD', '--', relativePath], null);
  const parsed = tree.status === 0
    ? parseHeadTreeEntries(tree.stdout)
    : { error: gitError('AUTHORITY_MODULE_PATH_INVALID', '/authority/module') };
  if (parsed.error || parsed.entries.length !== 1 ||
      parsed.entries[0].relativePath !== relativePath ||
      parsed.entries[0].type !== 'blob' ||
      !['100644', '100755'].includes(parsed.entries[0].mode)) {
    return { error: gitError('AUTHORITY_MODULE_PATH_INVALID', '/authority/module') };
  }
  return { resolvedPath };
}

function requireExactTrackedModule(relativePath) {
  const resolved = resolveExactTrackedModule(relativePath);
  if (resolved.error) throw new Error('authority-module-path');
  return require(resolved.resolvedPath);
}

function loadPolicyAuthorities() {
  if (policyAuthorities) return policyAuthorities;
  const { BACKGROUND_EXECUTION_POLICIES } =
    requireExactTrackedModule('src/main-process/background-execution/runtime.js');
  const { RECON_FIX_POLICIES } =
    requireExactTrackedModule('src/main-process/recon-id-fix-service/policies.js');
  const {
    VCC_EXPORT_SINGLE_POLICY,
    VCC_EXPORT_SUBJECTS_POLICY
  } = requireExactTrackedModule('src/main-process/vcc-financial-op-output/policies.js');
  policyAuthorities = {
    BACKGROUND_EXECUTION_POLICIES,
    RECON_FIX_POLICIES,
    VCC_EXPORT_SINGLE_POLICY,
    VCC_EXPORT_SUBJECTS_POLICY
  };
  return policyAuthorities;
}

function inspectGitBackedFile(reviewedHead, source) {
  const commit = runGit(['cat-file', '-e', reviewedHead + '^{commit}']);
  if (commit.status !== 0) return { error: 'reviewedHead is not a real commit' };
  const ancestor = runGit(['merge-base', '--is-ancestor', reviewedHead, EXACT_BASE]);
  if (ancestor.status !== 0) return { error: 'reviewedHead is not an exact-base ancestor' };
  const oid = runGit(['rev-parse', reviewedHead + ':' + source]);
  if (oid.status !== 0) return { error: 'reviewedHead:source does not resolve' };
  const content = runGit(['show', reviewedHead + ':' + source], null);
  if (content.status !== 0) return { error: 'reviewedHead:source cannot be read' };
  const text = content.stdout.toString('utf8');
  return { blobOid: oid.stdout.trim(), sha256: sha256(text), text };
}

function inspectHeadBackedFile(source) {
  const oid = runGit(['rev-parse', 'HEAD:' + source]);
  if (oid.status !== 0) return { error: 'HEAD:source does not resolve' };
  const content = runGit(['show', 'HEAD:' + source], null);
  if (content.status !== 0) return { error: 'HEAD:source cannot be read' };
  const text = content.stdout.toString('utf8');
  return { blobOid: oid.stdout.trim(), sha256: sha256(text), text };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function policyProjection(policy) {
  return clone({
    actionKey: policy.actionKey,
    disposition: policy.disposition,
    mode: policy.mode,
    adapterKind: policy.adapterKind,
    lifetime: policy.lifetime,
    commitKind: policy.commit.kind,
    production: policy.production,
    topology: policy.actionKey === 'vcc-financial-op:export-subjects'
      ? {
          phase: policy.resources.phase,
          compound: policy.resources.compound,
          workUnits: policy.workUnits
        }
      : null
  });
}

function pushError(errors, fieldPath, code) {
  errors.push({ code, path: fieldPath });
}

function exactKeys(value, expectedKeys) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) &&
    isDeepStrictEqual(Object.keys(value).sort(), [...expectedKeys].sort());
}

function scanPrivacy(value, errors, fieldPath = '') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanPrivacy(item, errors, fieldPath + '/a' + index));
    return;
  }
  if (value && typeof value === 'object') {
    Object.entries(value).forEach(([key, child], index) => {
      const normalizedKey = key.normalize('NFKC').toLowerCase().replace(/[\s._/\\:：-]+/g, '');
      if (/(raw(account|amount|row|payload|record)|账号|账户|金额|原始行|业务行)/i.test(normalizedKey)) {
        pushError(errors, '/privacy/key' + fieldPath + '/o' + index, 'PRIVACY_RAW_KEY_FORBIDDEN');
      }
      scanPrivacy(child, errors, fieldPath + '/o' + index);
    });
    return;
  }
  if (typeof value !== 'string') return;
  const text = value.normalize('NFKC');
  if (/\b\d{12,24}\b/.test(text)) {
    pushError(errors, '/privacy/value' + fieldPath, 'PRIVACY_ACCOUNT_VALUE_FORBIDDEN');
  }
  if (/(?:账号|账户|account)\s*[:=：]\s*\d+/i.test(text) ||
      /(?:金额|amount)\s*[:=：]\s*-?\d+(?:\.\d+)?/i.test(text)) {
    pushError(errors, '/privacy/value' + fieldPath, 'PRIVACY_FINANCIAL_VALUE_FORBIDDEN');
  }
  if (/^\s*[\[{].*(?:"(?:account|amount|currency|账号|金额)"|(?:账号|金额)\s*[:：])/is.test(text)) {
    pushError(errors, '/privacy/value' + fieldPath, 'PRIVACY_BUSINESS_ROW_FORBIDDEN');
  }
}

function validateReleaseEvidenceWithGuard(snapshot, gitGuard, options = null) {
  const errors = [...gitGuard.errors];
  if (!gitGuard.valid) {
    return {
      valid: false,
      errors,
      actionCount: ACTION_KEYS.length,
      productionEnabledCount: null,
      versionedPolicyAuthorityCount: 1
    };
  }

  scanPrivacy(snapshot, errors);

  if (!exactKeys(snapshot, [
    'schemaVersion', 'release', 'exactBase', 'packageVersion', 'packageVersionBumped',
    'authority', 'evidenceCatalog', 'actions', 'globalDecision'
  ])) pushError(errors, '/snapshot/keys', 'SNAPSHOT_SCHEMA_DRIFT');

  if (!snapshot || snapshot.schemaVersion !== 1 || snapshot.release !== '3.2.4' ||
      snapshot.exactBase !== EXACT_BASE || snapshot.packageVersion !== '3.1.14' ||
      snapshot.packageVersionBumped !== false) {
    pushError(errors, '/release', 'RELEASE_IDENTITY_DRIFT');
  }

  const packageJson = JSON.parse(fs.readFileSync(path.join(REPOSITORY_ROOT, 'package.json'), 'utf8'));
  if (packageJson.version !== '3.1.14') {
    pushError(errors, '/packageVersion', 'PACKAGE_VERSION_DRIFT');
  }

  let authorities;
  try {
    authorities = loadPolicyAuthorities();
  } catch {
    pushError(errors, '/authority/module', 'AUTHORITY_MODULE_PATH_INVALID');
    return {
      valid: false,
      errors,
      actionCount: ACTION_KEYS.length,
      productionEnabledCount: null,
      versionedPolicyAuthorityCount: 1
    };
  }

  if (options && typeof options.afterPolicyLoadForTest === 'function') {
    try {
      options.afterPolicyLoadForTest();
    } catch {
      pushError(errors, '/authority/post-load-hook', 'AUTHORITY_POST_LOAD_HOOK_FAILED');
    }
  }
  const postLoadGitGuard = bootstrapGitAuthorityGuard();
  if (!postLoadGitGuard.valid) errors.push(...postLoadGitGuard.errors);
  if (!postLoadGitGuard.valid || !isDeepStrictEqual(postLoadGitGuard.facts, gitGuard.facts)) {
    pushError(errors, '/authority/post-load', 'GIT_POST_LOAD_AUTHORITY_DRIFT');
    return {
      valid: false,
      errors,
      actionCount: ACTION_KEYS.length,
      productionEnabledCount: null,
      versionedPolicyAuthorityCount: 1
    };
  }

  const {
    BACKGROUND_EXECUTION_POLICIES,
    RECON_FIX_POLICIES,
    VCC_EXPORT_SINGLE_POLICY,
    VCC_EXPORT_SUBJECTS_POLICY
  } = authorities;

  for (const [index, authority] of AUTHORITY_SOURCES.entries()) {
    const inspected = inspectGitBackedFile(EXACT_BASE, authority.source);
    if (inspected.error || inspected.blobOid !== authority.blobOid ||
        inspected.sha256 !== authority.sha256 ||
        sha256File(path.join(REPOSITORY_ROOT, authority.source)) !== authority.sha256) {
      pushError(errors, '/authority/sourceAnchors/' + index, 'AUTHORITY_SOURCE_DRIFT');
    }
  }

  const specEvidence = inspectGitBackedFile(EXACT_BASE, SPEC_SOURCE);
  if (specEvidence.error || ACTION_KEYS.some((actionKey) => !specEvidence.text.includes('`' + actionKey + '`'))) {
    pushError(errors, '/authority/specActionScope', 'SPEC_ACTION_SCOPE_INVALID');
  }

  const directPolicies = [...RECON_FIX_POLICIES, VCC_EXPORT_SUBJECTS_POLICY, VCC_EXPORT_SINGLE_POLICY];
  const directByAction = new Map(directPolicies.map((policy) => [policy.actionKey, policy]));
  const runtimeByAction = new Map(BACKGROUND_EXECUTION_POLICIES.map((policy) => [policy.actionKey, policy]));
  const runtimeKeys = ACTION_KEYS.filter((actionKey) => runtimeByAction.has(actionKey));
  if (!isDeepStrictEqual(runtimeKeys, ACTION_KEYS)) {
    pushError(errors, '/authority/runtimeActionKeys', 'RUNTIME_ACTION_SET_DRIFT');
  }
  for (const [index, actionKey] of ACTION_KEYS.entries()) {
    if (!directByAction.has(actionKey) || !runtimeByAction.has(actionKey) ||
        directByAction.get(actionKey) !== runtimeByAction.get(actionKey)) {
      pushError(errors, '/authority/runtimeIdentity/' + index, 'RUNTIME_POLICY_IDENTITY_DRIFT');
    }
  }

  const fixture = JSON.parse(fs.readFileSync(path.join(REPOSITORY_ROOT, POLICY_FIXTURE_SOURCE), 'utf8'));
  let versionedPolicyAuthority = null;
  try {
    versionedPolicyAuthority = parseStrictJson(fs.readFileSync(
      path.join(REPOSITORY_ROOT, VERSIONED_POLICY_AUTHORITY_SOURCE),
      'utf8'
    ));
  } catch {
    pushError(errors, '/authority/versionedPolicy', 'VERSIONED_POLICY_AUTHORITY_INVALID');
  }
  const versionedPolicyEvidence = inspectHeadBackedFile(VERSIONED_POLICY_AUTHORITY_SOURCE);
  if (versionedPolicyEvidence.error ||
      versionedPolicyEvidence.blobOid !== VERSIONED_POLICY_AUTHORITY.blobOid ||
      versionedPolicyEvidence.sha256 !== VERSIONED_POLICY_AUTHORITY.sha256 ||
      sha256File(path.join(REPOSITORY_ROOT, VERSIONED_POLICY_AUTHORITY_SOURCE)) !==
        VERSIONED_POLICY_AUTHORITY.sha256) {
    pushError(errors, '/authority/versionedPolicy/source', 'VERSIONED_POLICY_AUTHORITY_DRIFT');
  }
  if (!exactKeys(versionedPolicyAuthority, [
    'schemaVersion', 'release', 'authorityKind', 'actionKey', 'baseFixture',
    'frozenSpec', 'policy'
  ]) || versionedPolicyAuthority.schemaVersion !== 1 ||
      versionedPolicyAuthority.release !== '3.2.4' ||
      versionedPolicyAuthority.authorityKind !== 'versioned-action-policy' ||
      versionedPolicyAuthority.actionKey !== VERSIONED_POLICY_AUTHORITY.actionKey ||
      !isDeepStrictEqual(versionedPolicyAuthority.baseFixture, {
        source: POLICY_FIXTURE_SOURCE,
        sha256: AUTHORITY_SOURCES.find(({ id }) => id === 'CANONICAL-POLICY-FIXTURE').sha256
      }) || !isDeepStrictEqual(versionedPolicyAuthority.frozenSpec, {
        source: SPEC_SOURCE,
        reviewedHead: EXACT_BASE,
        sha256: EXPECTED_EVIDENCE[0].sha256
      })) {
    pushError(errors, '/authority/versionedPolicy/metadata', 'VERSIONED_POLICY_METADATA_DRIFT');
  }
  scanPrivacy(versionedPolicyAuthority, errors, '/versioned-policy');
  for (const [index, actionKey] of ACTION_KEYS.entries()) {
    const current = directByAction.get(actionKey);
    const baseline = actionKey === VERSIONED_POLICY_AUTHORITY.actionKey
      ? versionedPolicyAuthority && versionedPolicyAuthority.policy
      : fixture.actions[actionKey];
    if (!current || !baseline) {
      pushError(errors, '/authority/policyFixture/' + index, 'POLICY_AUTHORITY_MISSING');
      continue;
    }
    if (!isDeepStrictEqual(current, baseline)) {
      pushError(errors, '/authority/policyFixture/' + index, 'CANONICAL_POLICY_DRIFT');
    }
  }

  const expectedAuthority = {
    gitState: {
      branchName: EXPECTED_BRANCH,
      parent: EXACT_BASE,
      mainRefOid: EXPECTED_MAIN_REF_OID,
      tagRefCount: EXPECTED_TAG_REF_COUNT,
      tagRefsSha256: EXPECTED_TAG_REFS_SHA256,
      tagsPointingAtHead: 0,
      trackedEntryCount: EXPECTED_TRACKED_ENTRY_COUNT,
      auditRootTrackedEntryCount: EXPECTED_AUDIT_TRACKED_ENTRY_COUNT,
      auditRootState: 'HEAD_EXACT',
      indexState: 'HEAD_EXACT_DEFAULT_FLAGS',
      worktreeTreeState: 'HEAD_EXACT',
      untrackedState: 'CLEAN',
      trackedState: 'CLEAN',
      changedPaths: RELEASE_EVIDENCE_PATHS
    },
    runtimeRegistration: 'REGISTERED',
    registeredActionKeys: ACTION_KEYS,
    policyFixtureStatus: 'VERSIONED_CANONICAL_EXACT',
    versionedPolicyActionKey: VERSIONED_POLICY_AUTHORITY.actionKey,
    versionedPolicyAuthority: {
      source: VERSIONED_POLICY_AUTHORITY_SOURCE,
      blobOid: VERSIONED_POLICY_AUTHORITY.blobOid,
      sha256: VERSIONED_POLICY_AUTHORITY.sha256
    },
    productionEnabledCount: 0,
    sourceAnchors: AUTHORITY_SOURCES.map(({ id, source, blobOid, sha256: digest }) => ({
      id, source, blobOid, sha256: digest
    }))
  };
  if (!isDeepStrictEqual(snapshot.authority, expectedAuthority)) {
    pushError(errors, '/authority', 'SNAPSHOT_AUTHORITY_DRIFT');
  }
  if (!isDeepStrictEqual(gitGuard.facts, {
    branchName: EXPECTED_BRANCH,
    head: gitGuard.facts.head,
    parent: EXACT_BASE,
    mainRefOid: EXPECTED_MAIN_REF_OID,
    tagRefCount: EXPECTED_TAG_REF_COUNT,
    tagRefsSha256: EXPECTED_TAG_REFS_SHA256,
    tagsPointingAtHead: 0,
    trackedEntryCount: EXPECTED_TRACKED_ENTRY_COUNT,
    auditRootTrackedEntryCount: EXPECTED_AUDIT_TRACKED_ENTRY_COUNT,
    auditRootState: 'HEAD_EXACT',
    indexState: 'HEAD_EXACT_DEFAULT_FLAGS',
    worktreeTreeState: 'HEAD_EXACT',
    untrackedState: 'CLEAN',
    trackedState: 'CLEAN',
    changedPaths: RELEASE_EVIDENCE_PATHS
  })) {
    pushError(errors, '/authority/gitState', 'GIT_AUTHORITY_FACT_DRIFT');
  }

  if (!Array.isArray(snapshot.evidenceCatalog) ||
      snapshot.evidenceCatalog.length !== EXPECTED_EVIDENCE.length) {
    pushError(errors, '/evidenceCatalog', 'EVIDENCE_CATALOG_LENGTH_DRIFT');
  } else {
    snapshot.evidenceCatalog.forEach((evidence, index) => {
      const expected = EXPECTED_EVIDENCE[index];
      const expectedShape = {
        id: expected.id,
        actionKey: expected.actionKey,
        reviewedHead: expected.reviewedHead,
        source: expected.source,
        blobOid: expected.blobOid,
        sha256: expected.sha256
      };
      if (!isDeepStrictEqual(evidence, expectedShape)) {
        pushError(errors, '/evidenceCatalog/' + index, 'EVIDENCE_METADATA_DRIFT');
      }
      const inspected = inspectGitBackedFile(expected.reviewedHead, expected.source);
      if (inspected.error || inspected.blobOid !== expected.blobOid ||
          inspected.sha256 !== expected.sha256) {
        pushError(errors, '/evidenceCatalog/' + index + '/git', 'EVIDENCE_GIT_BLOB_DRIFT');
      } else if (expected.requiredFacts.some((fact) => !inspected.text.includes(fact))) {
        pushError(errors, '/evidenceCatalog/' + index + '/actionScope', 'EVIDENCE_FACT_MISSING');
      }
    });
  }

  const actionKeys = Array.isArray(snapshot.actions)
    ? snapshot.actions.map((action) => action.actionKey)
    : [];
  if (!isDeepStrictEqual(actionKeys, ACTION_KEYS)) {
    pushError(errors, '/actions/actionKeys', 'ACTION_SET_DRIFT');
  }
  if (Array.isArray(snapshot.actions)) {
    snapshot.actions.forEach((action, index) => {
      const actionKey = ACTION_KEYS[index];
      const expected = ACTION_RELEASE[actionKey];
      const currentPolicy = directByAction.get(actionKey);
      if (!expected || !currentPolicy) return;
      if (!exactKeys(action, [
        'actionKey', 'currentPolicy', 'runtimeOwnership', 'decision', 'rollback',
        'evidenceRefs', 'gates'
      ])) pushError(errors, '/actions/' + index + '/keys', 'ACTION_SCHEMA_DRIFT');
      if (!isDeepStrictEqual(action.currentPolicy, policyProjection(currentPolicy))) {
        pushError(errors, '/actions/' + index + '/currentPolicy', 'CURRENT_POLICY_DRIFT');
      }
      const expectedRuntime = {
        registrationStatus: 'REGISTERED',
        policyIdentity: 'DIRECT_EQUALS_COMMON_RUNTIME',
        liveDisposition: 'legacy-preserved',
        effectiveMode: 'legacy',
        effectiveWorkerCount: 0
      };
      if (!isDeepStrictEqual(action.runtimeOwnership, expectedRuntime)) {
        pushError(errors, '/actions/' + index + '/runtimeOwnership', 'RUNTIME_OWNERSHIP_DRIFT');
      }
      if (!isDeepStrictEqual(action.decision, {
        kind: 'KEEP_DISABLED', enabled: false, independent: true,
        reasonCodes: expected.reasonCodes
      })) pushError(errors, '/actions/' + index + '/decision', 'ACTION_DECISION_DRIFT');
      if (!isDeepStrictEqual(action.rollback, {
        strategyKey: expected.rollbackStrategyKey,
        preserveLegacySelector: true,
        preserveReceiptsAndRecoveryHolds: true,
        productionMutationAllowed: false
      })) pushError(errors, '/actions/' + index + '/rollback', 'ROLLBACK_CONTRACT_DRIFT');
      if (!isDeepStrictEqual(action.evidenceRefs, expected.evidenceRefs)) {
        pushError(errors, '/actions/' + index + '/evidenceRefs', 'ACTION_EVIDENCE_SCOPE_DRIFT');
      }
      if (!isDeepStrictEqual(action.gates, expected.gates)) {
        pushError(errors, '/actions/' + index + '/gates', 'ACTION_GATE_DRIFT');
      }
      if (action.currentPolicy.production.enabled !== false ||
          action.currentPolicy.production.effectiveMode !== 'legacy' ||
          action.currentPolicy.production.effectiveWorkerCount !== 0) {
        pushError(errors, '/actions/' + index + '/production', 'PRODUCTION_STATE_ENABLED');
      }
    });
  }

  const expectedGlobal = {
    kind: 'KEEP_ALL_DISABLED',
    actionIndependent: true,
    productionEnabledCount: 0,
    windowsPackagedEvidence: 'NOT_RUN',
    realBusinessEvidence: 'PENDING_HUMAN_REVIEW',
    fundsRecoveryEvidence: 'PENDING_HUMAN_REVIEW',
    e12cPerformanceEvidence: 'LOCAL_SYNTHETIC_ONLY',
    mainModified: false,
    tagsModified: false,
    productionEnablementModified: false
  };
  if (!isDeepStrictEqual(snapshot.globalDecision, expectedGlobal)) {
    pushError(errors, '/globalDecision', 'GLOBAL_DECISION_DRIFT');
  }

  const auditedGlobalFacts = {
    mainModified: gitGuard.facts.branchName === 'main' ||
      gitGuard.facts.mainRefOid !== EXPECTED_MAIN_REF_OID,
    tagsModified: gitGuard.facts.tagsPointingAtHead !== 0 ||
      gitGuard.facts.tagRefCount !== EXPECTED_TAG_REF_COUNT ||
      gitGuard.facts.tagRefsSha256 !== EXPECTED_TAG_REFS_SHA256,
    productionEnablementModified: directPolicies.some((policy) =>
      policy.production.enabled !== false ||
      policy.production.effectiveMode !== 'legacy' ||
      policy.production.effectiveWorkerCount !== 0
    ) || gitGuard.facts.changedPaths.some((changedPath) => changedPath.startsWith('src/'))
  };
  if (auditedGlobalFacts.mainModified !== false ||
      auditedGlobalFacts.tagsModified !== false ||
      auditedGlobalFacts.productionEnablementModified !== false) {
    pushError(errors, '/globalDecision/auditedFacts', 'GLOBAL_GIT_RUNTIME_FACT_DRIFT');
  }

  return {
    valid: errors.length === 0,
    errors,
    actionCount: ACTION_KEYS.length,
    productionEnabledCount: directPolicies.filter((policy) => policy.production.enabled).length,
    versionedPolicyAuthorityCount: 1
  };
}

function validateReleaseEvidence(snapshot, options = null) {
  return validateReleaseEvidenceWithGuard(snapshot, bootstrapGitAuthorityGuard(), options);
}

function safeCliErrors(errors) {
  return (Array.isArray(errors) ? errors : [])
    .slice(0, MAX_CLI_ERRORS)
    .map((error, index) => {
      const code = typeof error.code === 'string' && /^[A-Z0-9_]+$/.test(error.code)
        ? error.code.slice(0, MAX_ERROR_CODE_LENGTH)
        : 'VALIDATION_ERROR';
      const opaquePath = typeof error.path === 'string' &&
        /^\/[A-Za-z0-9/_-]*$/.test(error.path)
        ? error.path.slice(0, MAX_ERROR_PATH_LENGTH)
        : '/error/' + index;
      return { code, path: opaquePath };
    });
}

function writeCliSummary(summary) {
  let serialized = JSON.stringify(summary);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_CLI_OUTPUT_BYTES) {
    serialized = JSON.stringify({
      status: 'FAIL',
      release: '3.2.4',
      errors: [{ code: 'CLI_OUTPUT_LIMIT_EXCEEDED', path: '/output' }]
    });
  }
  process.stdout.write(serialized + '\n');
}

function main() {
  let gitGuard;
  try {
    gitGuard = bootstrapGitAuthorityGuard();
  } catch {
    writeCliSummary({
      status: 'FAIL', release: '3.2.4',
      errors: [{ code: 'GIT_GUARD_INTERNAL_ERROR', path: '/git' }]
    });
    process.exitCode = 1;
    return;
  }
  if (!gitGuard.valid) {
    writeCliSummary({
      status: 'FAIL', release: '3.2.4', errors: safeCliErrors(gitGuard.errors)
    });
    process.exitCode = 1;
    return;
  }

  let snapshot;
  try {
    const rawSnapshot = fs.readFileSync(SNAPSHOT_PATH, 'utf8');
    snapshot = parseStrictJson(rawSnapshot);
  } catch (error) {
    const safeError = error instanceof StrictJsonError
      ? { code: error.code, path: error.path }
      : { code: 'SNAPSHOT_READ_ERROR', path: '/snapshot' };
    writeCliSummary({
      status: 'FAIL', release: '3.2.4', errors: safeCliErrors([safeError])
    });
    process.exitCode = 1;
    return;
  }

  let result;
  try {
    result = validateReleaseEvidenceWithGuard(snapshot, gitGuard);
  } catch {
    writeCliSummary({
      status: 'FAIL', release: '3.2.4',
      errors: [{ code: 'VALIDATOR_INTERNAL_ERROR', path: '/validator' }]
    });
    process.exitCode = 1;
    return;
  }
  const summary = result.valid
    ? {
        status: 'PASS', release: '3.2.4', baseCommit: EXACT_BASE,
        actionCount: result.actionCount,
        productionEnabledCount: result.productionEnabledCount,
        runtimeRegistration: 'REGISTERED',
        policyFixtureStatus: 'VERSIONED_CANONICAL_EXACT',
        versionedPolicyAuthorityCount: result.versionedPolicyAuthorityCount,
        windowsPackagedEvidence: 'NOT_RUN',
        fundsRecoveryManualEvidence: 'PENDING_HUMAN_REVIEW',
        e12cPerformanceEvidence: 'LOCAL_SYNTHETIC_ONLY'
      }
    : { status: 'FAIL', release: '3.2.4', errors: safeCliErrors(result.errors) };
  writeCliSummary(summary);
  process.exitCode = result.valid ? 0 : 1;
}

if (require.main === module) main();

module.exports = {
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
  policyProjection,
  resolveExactTrackedModule,
  safeCliErrors,
  sha256,
  sha256File,
  validateReleaseEvidence
};
