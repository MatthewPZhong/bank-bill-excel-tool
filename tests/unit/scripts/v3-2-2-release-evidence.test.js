'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createRequire } = require('node:module');
const test = require('node:test');
const vm = require('node:vm');

const {
  ACTION_KEYS,
  EXACT_BASE,
  SNAPSHOT_PATH,
  inspectGitBackedFile,
  sha256File,
  validateReleaseEvidence
} = require('../../../scripts/validate-v3-2-2-release-evidence');

const REPOSITORY_ROOT = path.resolve(__dirname, '../../..');
const VALIDATOR_PATH = path.join(
  REPOSITORY_ROOT,
  'scripts/validate-v3-2-2-release-evidence.js'
);

function loadSnapshot() {
  return JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8'));
}

function findAction(snapshot, actionKey) {
  return snapshot.actions.find((action) => action.actionKey === actionKey);
}

function findEvidence(snapshot, evidenceId) {
  return snapshot.evidenceCatalog.find((evidence) => evidence.id === evidenceId);
}

function actionIndex(actionKey) {
  return ACTION_KEYS.indexOf(actionKey);
}

function errorPaths(result) {
  return result.errors.map((error) => error.path);
}

function hasPrivacyPath(result, kind) {
  return errorPaths(result).some((fieldPath) => fieldPath.startsWith('/privacy/' + kind));
}

function replaceExactlyOnce(source, before, after) {
  assert.equal(source.split(before).length - 1, 1, 'validator mutation target must be unique');
  return source.replace(before, after);
}

function loadSynchronouslyRetaggedValidator() {
  let source = fs.readFileSync(VALIDATOR_PATH, 'utf8').replace(/\r\n?/g, '\n');
  source = replaceExactlyOnce(
    source,
    "    id: 'DUPLICATE-IMPORT-PAIRED-ACTION-SCOPE',\n    actionKey: 'duplicate:import',",
    "    id: 'DUPLICATE-IMPORT-PAIRED-ACTION-SCOPE',\n    actionKey: 'duplicate:export',"
  );
  source = replaceExactlyOnce(
    source,
    "    id: 'DUPLICATE-IMPORT-LOCAL-PERFORMANCE',\n    actionKey: 'duplicate:import',",
    "    id: 'DUPLICATE-IMPORT-LOCAL-PERFORMANCE',\n    actionKey: 'duplicate:export',"
  );
  source = replaceExactlyOnce(
    source,
    "['E07-C-DUPLICATE-IMPORT-BENCHMARK', 'duplicate:import', DUPLICATE_BENCHMARK_SOURCE,",
    "['E07-C-DUPLICATE-IMPORT-BENCHMARK', 'duplicate:export', DUPLICATE_BENCHMARK_SOURCE,"
  );
  const replacementModule = { exports: {} };
  const wrapper = new vm.Script(
    '(function (exports, require, module, __filename, __dirname) {\n' + source + '\n})',
    { filename: VALIDATOR_PATH }
  ).runInThisContext();
  wrapper(
    replacementModule.exports,
    createRequire(VALIDATOR_PATH),
    replacementModule,
    VALIDATOR_PATH,
    path.dirname(VALIDATOR_PATH)
  );
  return replacementModule.exports;
}

test('release evidence文本hash不受Windows CRLF checkout影响', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v322-evidence-eol-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const lfPath = path.join(dir, 'lf.md');
  const crlfPath = path.join(dir, 'crlf.md');
  fs.writeFileSync(lfPath, 'line-1\nline-2\n', 'utf8');
  fs.writeFileSync(crlfPath, 'line-1\r\nline-2\r\n', 'utf8');
  assert.equal(sha256File(crlfPath), sha256File(lfPath));
});

test('Git anchor只接受冻结base祖先中的真实reviewedHead:path blob', () => {
  const valid = inspectGitBackedFile(
    REPOSITORY_ROOT,
    EXACT_BASE,
    'src/main-process/bank-bu-worker/side-database.js'
  );
  assert.match(valid.blobOid, /^[a-f0-9]{40}$/);
  assert.match(valid.sha256, /^[a-f0-9]{64}$/);

  assert.match(
    inspectGitBackedFile(
      REPOSITORY_ROOT,
      '0'.repeat(40),
      'src/main-process/bank-bu-worker/side-database.js'
    ).error,
    /real commit/
  );
  assert.match(
    inspectGitBackedFile(REPOSITORY_ROOT, EXACT_BASE, 'missing/release-evidence.js').error,
    /does not resolve/
  );
  const currentHead = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8'
  }).stdout.trim();
  assert.match(
    inspectGitBackedFile(
      REPOSITORY_ROOT,
      currentHead,
      'src/main-process/bank-bu-worker/side-database.js'
    ).error,
    /not an ancestor/
  );
});

test('R3.2.2 snapshot锁定10 action、18 base anchors与独立证据闭环', () => {
  const snapshot = loadSnapshot();
  const result = validateReleaseEvidence(snapshot);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.equal(result.actionCount, 10);
  assert.equal(result.commonRuntimeActionCount, 6);
  assert.equal(result.bankBuCommonRuntimeActionCount, 0);
  assert.equal(snapshot.baseAnchors.length, 18);
});

test('validator CLI只读并输出有界machine-readable摘要', () => {
  const before = fs.readFileSync(SNAPSHOT_PATH, 'utf8');
  const beforeMtime = fs.statSync(SNAPSHOT_PATH).mtimeMs;
  const result = spawnSync(
    process.execPath,
    ['scripts/validate-v3-2-2-release-evidence.js'],
    { cwd: REPOSITORY_ROOT, encoding: 'utf8' }
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    status: 'PASS',
    release: '3.2.2',
    baseCommit: EXACT_BASE,
    actionCount: 10,
    productionEnabledCount: 0,
    commonRuntimeActionCount: 6,
    bankBuCommonRuntimeActionCount: 0,
    bankBuCommonRuntimeRegistration: 'ABSENT_FAIL_CLOSED',
    windowsPackagedEvidence: 'NOT_RUN',
    fundsRecoveryManualEvidence: 'PENDING_HUMAN_REVIEW'
  });
  assert.equal(fs.readFileSync(SNAPSHOT_PATH, 'utf8'), before);
  assert.equal(fs.statSync(SNAPSHOT_PATH).mtimeMs, beforeMtime);
});

test('任一action的policy或production状态漂移均fail closed', () => {
  const snapshot = loadSnapshot();
  const action = findAction(snapshot, 'fund-recon:run');
  action.currentPolicy.mode = 'thread-pool';
  action.currentPolicy.production.enabled = true;
  action.currentPolicy.production.effectiveMode = 'thread-single';
  action.currentPolicy.production.effectiveWorkerCount = 1;
  action.decision.enabled = true;
  action.live.effectiveMode = 'thread-single';
  action.live.effectiveWorkerCount = 1;
  const result = validateReleaseEvidence(snapshot);
  const index = actionIndex('fund-recon:run');
  assert.equal(result.valid, false);
  assert.ok(errorPaths(result).includes('/actions/' + index + '/currentPolicy'));
  assert.ok(errorPaths(result).includes('/actions/' + index + '/decision'));
  assert.ok(errorPaths(result).includes('/actions/' + index + '/live'));
});

test('BankBU module policy不能伪装成公共runtime registration或production enable', () => {
  const snapshot = loadSnapshot();
  snapshot.authorityLayering.commonRuntime.registeredActionKeys.push('bank-bu:import-month');
  snapshot.authorityLayering.commonRuntime.bankBuRegistration = 'REGISTERED';
  snapshot.authorityLayering.bankBuModule.commonRuntimeRegistration = 'REGISTERED';
  const action = findAction(snapshot, 'bank-bu:import-month');
  action.policyAuthority = 'common-runtime';
  action.runtimeOwnership.policyLayer = 'COMMON_BACKGROUND_RUNTIME';
  action.runtimeOwnership.registrationStatus = 'REGISTERED';
  action.decision.enabled = true;
  const result = validateReleaseEvidence(snapshot);
  const index = actionIndex('bank-bu:import-month');
  assert.equal(result.valid, false);
  assert.ok(errorPaths(result).includes('/authorityLayering'));
  assert.ok(errorPaths(result).includes('/actions/' + index + '/policyAuthority'));
  assert.ok(errorPaths(result).includes('/actions/' + index + '/runtimeOwnership'));
  assert.ok(errorPaths(result).includes('/actions/' + index + '/decision'));
});

test('同步改snapshot ownership与rollback order仍被base anchor击穿', () => {
  const snapshot = loadSnapshot();
  const action = findAction(snapshot, 'bank-bu:import-month');
  action.runtimeOwnership.commitKind = 'none';
  action.runtimeOwnership.anchorIds = ['BANK-BU-EXPORT-AGGREGATE-ORDER'];
  action.rollback.identityAnchorIds = ['BANK-BU-EXPORT-SINGLE-SNAPSHOT'];
  action.rollback.orderAnchorIds = ['DUPLICATE-IMPORT-BANK-DOCUMENT-ORDER'];
  const result = validateReleaseEvidence(snapshot);
  const index = actionIndex('bank-bu:import-month');
  assert.equal(result.valid, false);
  assert.ok(errorPaths(result).includes('/actions/' + index + '/runtimeOwnership'));
  assert.ok(errorPaths(result).includes('/actions/' + index + '/rollback'));
});

test('base anchor换成另一真实blob且同步OID/hash仍不能改写action事实', () => {
  const snapshot = loadSnapshot();
  const anchor = snapshot.baseAnchors.find(
    (item) => item.id === 'BANK-BU-IMPORT-TRANSACTION-ORDER'
  );
  const index = snapshot.baseAnchors.indexOf(anchor);
  anchor.source = 'src/main-process/bank-bu-worker/export-operation.js';
  const synchronized = inspectGitBackedFile(REPOSITORY_ROOT, EXACT_BASE, anchor.source);
  anchor.blobOid = synchronized.blobOid;
  anchor.sha256 = synchronized.sha256;
  const result = validateReleaseEvidence(snapshot);
  assert.equal(result.valid, false);
  assert.ok(errorPaths(result).includes('/baseAnchors/' + index + '/source'));
  assert.ok(errorPaths(result).includes('/baseAnchors/' + index + '/orderedFacts'));
});

test('全零不存在reviewedHead即使同步blob/hash也不能自证', () => {
  const snapshot = loadSnapshot();
  const evidence = findEvidence(snapshot, 'E08-B-BANK-BU-IMPORT');
  const index = snapshot.evidenceCatalog.indexOf(evidence);
  evidence.reviewedHead = '0'.repeat(40);
  evidence.blobOid = '0'.repeat(40);
  evidence.sha256 = '0'.repeat(64);
  const result = validateReleaseEvidence(snapshot);
  assert.equal(result.valid, false);
  assert.ok(errorPaths(result).includes('/evidenceCatalog/' + index + '/reviewedHead'));
  assert.equal(hasPrivacyPath(result, 'raw-account'), false);
});

test('Duplicate import benchmark不能通过同步scope改名借给export', () => {
  const snapshot = loadSnapshot();
  const benchmark = findEvidence(snapshot, 'E07-C-DUPLICATE-IMPORT-BENCHMARK');
  const evidenceIndex = snapshot.evidenceCatalog.indexOf(benchmark);
  benchmark.actionKey = 'duplicate:export';
  benchmark.anchorRefs = ['DUPLICATE-EXPORT-CURRENT-RESULT'];
  const duplicateImport = findAction(snapshot, 'duplicate:import');
  duplicateImport.evidenceRefs = duplicateImport.evidenceRefs.filter(
    (evidenceRef) => evidenceRef !== benchmark.id
  );
  findAction(snapshot, 'duplicate:export').evidenceRefs.push(benchmark.id);
  const result = validateReleaseEvidence(snapshot);
  assert.equal(result.valid, false);
  assert.ok(errorPaths(result).includes('/evidenceCatalog/' + evidenceIndex + '/actionKey'));
  assert.ok(errorPaths(result).includes('/evidenceCatalog/' + evidenceIndex + '/anchorRefs'));
  assert.ok(errorPaths(result).includes(
    '/actions/' + actionIndex('duplicate:export') + '/evidenceRefs'
  ));
});

test('snapshot与validator specs同步retag仍被exact-base import action scope击穿', () => {
  const retaggedValidator = loadSynchronouslyRetaggedValidator();
  const snapshot = loadSnapshot();
  for (const anchorId of [
    'DUPLICATE-IMPORT-PAIRED-ACTION-SCOPE',
    'DUPLICATE-IMPORT-LOCAL-PERFORMANCE'
  ]) {
    snapshot.baseAnchors.find((anchor) => anchor.id === anchorId).actionKey = 'duplicate:export';
  }
  findEvidence(snapshot, 'E07-C-DUPLICATE-IMPORT-BENCHMARK').actionKey = 'duplicate:export';
  for (const actionKey of ['duplicate:import', 'duplicate:export']) {
    const action = findAction(snapshot, actionKey);
    action.evidenceRefs = retaggedValidator.expectedEvidenceRefs(actionKey);
    action.gates = retaggedValidator.expectedGates(actionKey);
  }

  const result = retaggedValidator.validateReleaseEvidence(snapshot);
  const scopeAnchorIndex = snapshot.baseAnchors.findIndex(
    (anchor) => anchor.id === 'DUPLICATE-IMPORT-PAIRED-ACTION-SCOPE'
  );
  const benchmarkIndex = snapshot.evidenceCatalog.findIndex(
    (evidence) => evidence.id === 'E07-C-DUPLICATE-IMPORT-BENCHMARK'
  );
  assert.equal(result.valid, false);
  assert.ok(errorPaths(result).includes('/baseAnchors/' + scopeAnchorIndex + '/actionScope'));
  assert.ok(errorPaths(result).includes('/evidenceCatalog/' + benchmarkIndex + '/actionScope'));
  assert.equal(result.errors.every((error) => error.path.endsWith('/actionScope')), true);
});

test('action-scoped evidence不能被另一个action直接借用', () => {
  const snapshot = loadSnapshot();
  const action = findAction(snapshot, 'duplicate:export');
  action.evidenceRefs.push('E07-B-DUPLICATE-RUN');
  const result = validateReleaseEvidence(snapshot);
  const index = actionIndex('duplicate:export');
  assert.equal(result.valid, false);
  assert.ok(errorPaths(result).includes('/actions/' + index + '/evidenceRefs'));
});

test('Windows、真实进程、业务样本、资金与恢复gate不能被自动升级为PASS', () => {
  const snapshot = loadSnapshot();
  const action = findAction(snapshot, 'duplicate:import');
  for (const gate of [
    'windowsPackaged', 'windowsNativeSqlite', 'realProcessTermination',
    'realBusinessSamples', 'funds', 'recovery'
  ]) {
    action.gates[gate] = 'PASS';
  }
  snapshot.globalDecision.windowsPackagedEvidence = 'PASS';
  snapshot.globalDecision.fundsRecoveryManualEvidence = 'PASS';
  const result = validateReleaseEvidence(snapshot);
  const index = actionIndex('duplicate:import');
  assert.equal(result.valid, false);
  assert.ok(errorPaths(result).includes('/globalDecision'));
  assert.ok(errorPaths(result).includes('/actions/' + index + '/gates'));
});

test('缺失或UNKNOWN gate不能作为release PASS', () => {
  const snapshot = loadSnapshot();
  const action = findAction(snapshot, 'bank-bu:run');
  delete action.gates.recovery;
  action.gates.windowsPackaged = 'UNKNOWN';
  const result = validateReleaseEvidence(snapshot);
  const index = actionIndex('bank-bu:run');
  assert.equal(result.valid, false);
  assert.ok(errorPaths(result).includes('/actions/' + index + '/gates'));
});

test('action顺序或缺项不能由其余action证据补偿', () => {
  const snapshot = loadSnapshot();
  snapshot.actions.splice(1, 1);
  const result = validateReleaseEvidence(snapshot);
  assert.equal(result.valid, false);
  assert.ok(errorPaths(result).includes('/actions/actionKeys'));
});

test('Git blob OID与source hash任一漂移均不能静默通过', () => {
  const snapshot = loadSnapshot();
  const evidence = findEvidence(snapshot, 'E08-B-BANK-BU-IMPORT');
  const index = snapshot.evidenceCatalog.indexOf(evidence);
  evidence.blobOid = '1'.repeat(40);
  evidence.sha256 = '2'.repeat(64);
  const result = validateReleaseEvidence(snapshot);
  assert.equal(result.valid, false);
  assert.ok(errorPaths(result).includes('/evidenceCatalog/' + index + '/blobOid'));
  assert.ok(errorPaths(result).includes('/evidenceCatalog/' + index + '/sha256'));
});

test('本地parser benchmark只授权所属import的LOCAL_CAPABILITY_ONLY', () => {
  const snapshot = loadSnapshot();
  findAction(snapshot, 'duplicate:run').gates.performance = 'LOCAL_CAPABILITY_ONLY';
  findAction(snapshot, 'duplicate:import').gates.performance = 'PASS';
  findAction(snapshot, 'bank-bu:import-month').currentPolicy.production.enabled = true;
  const result = validateReleaseEvidence(snapshot);
  assert.equal(result.valid, false);
  assert.ok(errorPaths(result).includes(
    '/actions/' + actionIndex('duplicate:run') + '/gates'
  ));
  assert.ok(errorPaths(result).includes(
    '/actions/' + actionIndex('duplicate:import') + '/gates'
  ));
  assert.ok(errorPaths(result).includes(
    '/actions/' + actionIndex('bank-bu:import-month') + '/currentPolicy'
  ));
});

test('rollback字符串中的raw account与amount先命中privacy语义', () => {
  const snapshot = loadSnapshot();
  findAction(snapshot, 'bank-bu:run').rollback.strategyKey =
    'raw account 6222021234567890 amount 999999.99';
  const result = validateReleaseEvidence(snapshot);
  assert.equal(result.valid, false);
  assert.equal(hasPrivacyPath(result, 'raw-account'), true);
  assert.equal(hasPrivacyPath(result, 'raw-amount'), true);
});

test('递归privacy检查拒绝raw-like key与序列化business row', () => {
  const snapshot = loadSnapshot();
  findAction(snapshot, 'fund-recon:import').rollback.businessRow =
    '{"account":"6222021234567890","currency":"USD","amount":"999999.99"}';
  findAction(snapshot, 'fund-recon:run').rollback.strategyKey = '999999.99';
  const result = validateReleaseEvidence(snapshot);
  assert.equal(result.valid, false);
  assert.equal(hasPrivacyPath(result, 'raw-like-key'), true);
  assert.equal(hasPrivacyPath(result, 'business-row'), true);
  assert.equal(hasPrivacyPath(result, 'raw-account'), true);
  assert.equal(hasPrivacyPath(result, 'raw-amount'), true);
});

test('Unicode NFKC与常见分隔符下的中英文raw payload均优先命中privacy', async (t) => {
  const cases = [
    {
      name: '中文账号key',
      mutate(snapshot) { findAction(snapshot, 'bank-bu:run').rollback['账号'] = 'REDACTED'; },
      kind: 'raw-like-key'
    },
    {
      name: '中文金额key与小整数',
      mutate(snapshot) { findAction(snapshot, 'bank-bu:run').rollback['金额'] = 12; },
      kind: 'raw-like-key'
    },
    {
      name: '空格分隔raw account key',
      mutate(snapshot) {
        findAction(snapshot, 'bank-bu:run').rollback['raw account'] = 'REDACTED';
      },
      kind: 'raw-like-key'
    },
    {
      name: '全角冒号金额value',
      mutate(snapshot) {
        findAction(snapshot, 'bank-bu:run').rollback.strategyKey = '金额：12.34';
      },
      kind: 'raw-amount'
    },
    {
      name: '中文全角业务行value',
      mutate(snapshot) {
        findAction(snapshot, 'bank-bu:run').rollback.strategyKey =
          '业务行 ／ ｛脱敏内容｝';
      },
      kind: 'business-row'
    }
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, () => {
      const snapshot = loadSnapshot();
      scenario.mutate(snapshot);
      const result = validateReleaseEvidence(snapshot);
      assert.equal(result.valid, false);
      assert.match(result.errors[0].path, /^\/privacy\//);
      assert.equal(hasPrivacyPath(result, scenario.kind), true);
    });
  }
});

test('hash OID version与普通中文说明不被privacy误报', () => {
  const snapshot = loadSnapshot();
  findAction(snapshot, 'bank-bu:run').rollback.strategyKey =
    '保留旧版策略，金额字段仅作说明；版本 3.1.14';
  const result = validateReleaseEvidence(snapshot);
  assert.equal(result.valid, false);
  assert.equal(errorPaths(result).some((fieldPath) => fieldPath.startsWith('/privacy/')), false);
  assert.ok(errorPaths(result).includes('/actions/' + actionIndex('bank-bu:run') + '/rollback'));
});

test('snapshot不得伪造版本bump或放宽data minimization profile', () => {
  const snapshot = loadSnapshot();
  snapshot.packageVersion = { value: '3.2.2', bumped: true };
  snapshot.dataMinimization.enforcement = 'DECLARATION_ONLY';
  snapshot.globalDecision.productionEnablementAuthorized = true;
  const result = validateReleaseEvidence(snapshot);
  assert.equal(result.valid, false);
  assert.ok(errorPaths(result).includes('/packageVersion'));
  assert.ok(errorPaths(result).includes('/dataMinimization'));
  assert.ok(errorPaths(result).includes('/globalDecision'));
});
