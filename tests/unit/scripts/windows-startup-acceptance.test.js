'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  REQUIRED_STARTUP_PHASES,
  assertPrivacyAllowlist,
  bindProcessReceipt,
  captureWindowsEnvironment,
  cleanupInstalledVariants,
  comparison,
  createOwnedWorkRoot,
  createProtectedOutputGuard,
  evaluateAcceptance,
  evidenceDigest,
  estimateDiskBudget,
  finalizeAcceptanceReport,
  finalizeOwnedWorkRoot,
  installWindowsVariants,
  main: acceptanceMain,
  removeExactOwnedTree,
  runControlledAcceptance,
  validateGoldenManualReceipt,
  validatePhaseInventory,
  writeProtectedJson
} = require('../../../scripts/windows-startup-acceptance');

function tempDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
}

function sha256Bytes(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function cleanupTargetIdentity(comparisonId, scenario, label, round) {
  return evidenceDigest({
    schemaVersion: 1,
    kind: 'windows-startup-cleanup-target',
    comparisonId,
    scenario,
    label,
    round
  });
}

function machineEnvironment() {
  const canonical = {
    status: 'recorded', evidenceSource: 'machine', hostIdSha256: 'e'.repeat(64),
    os: { caption: 'windows', version: '10.0', build: '1', arch: 'x64' },
    cpu: { model: sha256Bytes('Controlled CPU'), logicalCores: 8 },
    memory: { totalBytes: 16_000_000_000 },
    localDisk: {
      driveType: 3, fileSystem: 'ntfs', sizeBytes: 1_000_000_000_000,
      freeBytes: 900_000_000_000, mediaType: 'ssd', busType: 'nvme'
    },
    pathClass: 'local-fixed', goldenPathClass: 'local-fixed',
    powerPlan: { guid: '00000000-0000-0000-0000-000000000000' },
    defender: {
      status: 'recorded', realtimeProtectionEnabled: true, engineVersion: '1',
      productVersion: '2', signatureVersion: '3', workRootExcluded: false,
      goldenExcluded: false
    },
    cachePolicy: {
      evidenceSource: 'machine-policy', firstSampleRetained: true,
      explicitCacheFlush: false, order: 'four-variant-rotation',
      comparisonScope: 'single-process-single-host'
    },
    diskBudget: {
      evidenceSource: 'machine-calculated', normalSimultaneousCopies: 5,
      nonNormalPeakEquivalentCopies: 4.25, completedNonNormalSamplesRetained: 0,
      requiredFreeBytes: 20_000_000_000, safetyBytes: 4_294_967_296,
      availableFreeBytes: 900_000_000_000, sufficient: true
    }
  };
  return { ...canonical, digest: evidenceDigest(canonical) };
}

function phases() {
  return REQUIRED_STARTUP_PHASES.map((phase) => ({
    event: 'startup-phase',
    phase,
    state: 'end',
    outcome: phase === 'database-vacuum' ? 'skipped' : 'success',
    durationMs: 1,
    ...(phase === 'archive-outbox'
      ? { counts: { pendingTerminalBatches: 0, pendingTerminalTasks: 0 } }
      : phase === 'vcc-lineage-gate'
        ? { counts: { bound: 3, failed: 0, pending: 0, released: 0 } }
        : {})
  }));
}

function migrationSchemas(label) {
  const column = (cid, name, type) => ({
    cid, name, type, notNull: 0, defaultValue: null, primaryKey: 0
  });
  const before = {
    fingerprint: '6'.repeat(64),
    current: false,
    systemSnapshotColumns: [column(0, 'id', 'INTEGER')],
    archiveBlobColumns: [column(0, 'id', 'INTEGER')],
    archiveArtifactColumns: [column(0, 'id', 'INTEGER')],
    importSourceIndexSql: '',
    expectedImportSourceIndexSql: 'create index expected'
  };
  if (label.startsWith('3.1.11')) return { before, after: structuredClone(before) };
  const after = structuredClone(before);
  after.fingerprint = '7'.repeat(64);
  after.current = true;
  after.systemSnapshotColumns.push(column(1, 'import_source_id', 'INTEGER'));
  after.archiveBlobColumns.push(
    column(1, 'fingerprint_size_bytes', 'INTEGER'),
    column(2, 'fingerprint_mtime_ms', 'REAL'),
    column(3, 'fingerprint_ctime_ms', 'REAL'),
    column(4, 'fingerprint_ino', 'TEXT')
  );
  after.archiveArtifactColumns.push(
    column(1, 'storage_fingerprint_size_bytes', 'INTEGER'),
    column(2, 'storage_fingerprint_mtime_ms', 'REAL'),
    column(3, 'storage_fingerprint_ctime_ms', 'REAL'),
    column(4, 'storage_fingerprint_ino', 'TEXT')
  );
  after.importSourceIndexSql = after.expectedImportSourceIndexSql;
  return { before, after };
}

function samples(values, label, scenario, comparisonId) {
  const pendingRecovery = { activeTaskRuns: 0, activeBatches: 0, pendingArtifacts: 0, flowBindIntents: 0 };
  return values.map((externalFullReadyMs, index) => {
    const phaseRecords = label.startsWith('3.1.12') ? phases() : [];
    const schemas = migrationSchemas(label);
    const steadySchema = migrationSchemas('3.1.12').after;
    const precondition = scenario === 'crash-recovery'
      ? {
        walBytes: 64, walSentinel: { baseValue: null, walVisibleValue: 'value' },
        journalSentinelPresent: true, pendingRecovery, schema: structuredClone(steadySchema)
      }
      : scenario === 'migration-vacuum'
        ? { vacuumFlagBefore: null, pendingRecovery, schema: schemas.before }
        : {
          vacuumFlagBefore: '1', walBytesBefore: 0,
          pendingRecovery, schema: structuredClone(steadySchema)
        };
    const postcondition = scenario === 'migration-vacuum'
      ? {
        vacuumFlagAfter: '1', vacuumOutcome: label.startsWith('3.1.12') ? 'success' : 'legacy-flag-transition',
        pendingRecovery, schema: schemas.after, schemaValid: true,
        columnDeltaValid: label.startsWith('3.1.12'),
        indexDefinitionValid: label.startsWith('3.1.12'), schemaChanged: label.startsWith('3.1.12'),
        schemaDelta: label.startsWith('3.1.12') ? {
          added: [{ type: 'index', name: 'idx_vcc_fin_op_system_snapshots_import_source' }],
          removed: [],
          changed: [
            { type: 'table', name: 'archive_artifacts' },
            { type: 'table', name: 'archive_blobs' },
            { type: 'table', name: 'vcc_fin_op_system_snapshots' }
          ]
        } : { added: [], removed: [], changed: [] }
      }
      : scenario === 'crash-recovery'
        ? {
          walSentinelCheckpointed: true, journalSentinelConsumed: true,
          validWalPending: false, schemaChanged: false, pendingRecovery,
          schema: structuredClone(steadySchema)
        }
        : {
          vacuumFlagAfter: '1', vacuumOutcome: label.startsWith('3.1.12') ? 'skipped' : undefined,
          legacySteady: label.startsWith('3.1.11'), recoveryCountsZero: label.startsWith('3.1.12'),
          validWalPending: false, schemaChanged: false, pendingRecovery,
          schema: structuredClone(steadySchema)
        };
    return {
      round: index + 1,
      status: 'success',
      externalFullReadyMs,
      readyEvidence: {
        mode: label.startsWith('3.1.12') ? 'phase-and-renderer-contract' : 'legacy-renderer-complete',
        rendererInitMs: 1,
        ...(label.startsWith('3.1.12') ? { windowReadyMs: 1, startupTotalMs: 1 } : {})
      },
      gracefulClose: true,
      gracefulCloseEvidence: { livePids: [100], acceptedPids: [100], tokenRevalidated: true },
      processTree: {
        observedProcessCount: 1,
        nonceSha256: sha256Bytes(`nonce:${comparisonId}:${scenario}:${label}:${index + 1}`)
      },
      processExitEvidence: {
        rootExit: { code: 0, signal: null }, treeExited: true, verifiedEmpty: true,
        quiescenceSnapshots: [[], [], []]
      },
      cleanupEvidence: { mode: 'graceful', verifiedEmpty: true, quiescenceSnapshots: [[], [], []] },
      afterSampleCleanupEvidence: scenario === 'normal-clean-shutdown' ? undefined : {
        status: 'success',
        targetIdentitySha256: cleanupTargetIdentity(comparisonId, scenario, label, index + 1),
        verifiedAbsent: true,
        pathRecorded: false
      },
      scenarioEvidence: { precondition, postcondition },
      phases: phaseRecords,
      recoveryCounts: {
        ...Object.fromEntries(phaseRecords.filter((phase) => phase.counts)
          .map((phase) => [phase.phase, phase.counts])),
        actualPostcondition: pendingRecovery
      }
    };
  });
}

function scenarioReport(scenario, valuesByLabel, comparisonId = 'comparison-1') {
  const scenarioHashByte = {
    'normal-clean-shutdown': 'a',
    'migration-vacuum': 'b',
    'crash-recovery': 'c'
  }[scenario];
  const variants = {};
  for (const [label, values] of Object.entries(valuesByLabel)) {
    const index = ['3.1.11-installer', '3.1.11-portable', '3.1.12-installer', '3.1.12-portable'].indexOf(label);
    variants[label] = {
      artifact: {
        label,
        sha256: String(index + 1).repeat(64),
        sizeBytes: 100 + index,
        fileVersion: `${label.slice(0, 6)}.0`,
        pathRecorded: false
      },
      initialSha256: scenarioHashByte.repeat(64),
      initialWalSha256: scenario === 'crash-recovery' ? 'd'.repeat(64) : null,
      initialShmSha256: null,
      samples: samples(values, label, scenario, comparisonId).map((sample) => {
        const bundle = {
          database: { exists: true, size: 2_900_000_000, sha256: scenarioHashByte.repeat(64) },
          wal: scenario === 'crash-recovery'
            ? { exists: true, size: 64, sha256: 'd'.repeat(64), validFrames: true }
            : { exists: false, size: 0, sha256: null, validFrames: false },
          shm: { exists: false, size: 0, sha256: null }
        };
        return { ...sample, before: structuredClone(bundle), after: structuredClone(bundle) };
      })
    };
  }
  return {
    comparisonId,
    environmentDigest: machineEnvironment().digest,
    cleanupEvidence: { verifiedAbsent: true, pathRecorded: false },
    report: {
      schemaVersion: 2,
      scenario,
      run: { status: 'completed', requiresManualCleanup: false },
      contract: {
        runsPerVariant: valuesByLabel['3.1.11-installer'].length,
        firstSampleRetained: true,
        rotatingOrder: Array.from({ length: valuesByLabel['3.1.11-installer'].length }, (_unused, round) => {
          const labels = ['3.1.11-installer', '3.1.11-portable', '3.1.12-installer', '3.1.12-portable'];
          return labels.slice(round % 4).concat(labels.slice(0, round % 4));
        })
      },
      golden: {
        sha256: scenarioHashByte.repeat(64),
        walSha256: scenario === 'crash-recovery' ? 'd'.repeat(64) : null,
        shmSha256: null,
        sizeBytes: 2_900_000_000,
        walSizeBytes: scenario === 'crash-recovery' ? 64 : 0,
        shmSizeBytes: 0,
        sourcePathRecorded: false
      },
      variants
    }
  };
}

function artifactEvidence() {
  return {
    variants: Object.fromEntries([
      '3.1.11-installer', '3.1.11-portable', '3.1.12-installer', '3.1.12-portable'
    ].map((label, index) => [label, {
      artifact: { label, sha256: String(index + 1).repeat(64), sizeBytes: 100 + index, fileVersion: `${label.slice(0, 6)}.0`, pathRecorded: false },
      provenance: label.endsWith('installer')
        ? {
          kind: 'installer-installed',
          source: { sha256: String(index + 5).repeat(64), sizeBytes: 50 + index, fileVersion: `${label.slice(0, 6)}.0`, pathRecorded: false },
          setup: { sha256: String(index + 5).repeat(64), sizeBytes: 50 + index, fileVersion: `${label.slice(0, 6)}.0`, pathRecorded: false },
          installed: { label, sha256: String(index + 1).repeat(64), sizeBytes: 100 + index, fileVersion: `${label.slice(0, 6)}.0`, pathRecorded: false },
          launched: { label, sha256: String(index + 1).repeat(64), sizeBytes: 100 + index, fileVersion: `${label.slice(0, 6)}.0`, pathRecorded: false },
          installMode: 'nsis-silent-explicit-owned-root',
          installedExeResolvedFrom: 'unique-root-product-exe',
          pathRecorded: false
        }
        : {
          kind: 'portable-frozen-copy',
          source: { sha256: String(index + 1).repeat(64), sizeBytes: 100 + index, fileVersion: `${label.slice(0, 6)}.0`, pathRecorded: false },
          frozen: { label, sha256: String(index + 1).repeat(64), sizeBytes: 100 + index, fileVersion: `${label.slice(0, 6)}.0`, pathRecorded: false },
          launched: { label, sha256: String(index + 1).repeat(64), sizeBytes: 100 + index, fileVersion: `${label.slice(0, 6)}.0`, pathRecorded: false },
          pathRecorded: false
        }
    }])),
    cleanup: {
      verified: true, installedApplicationsRemoved: true,
      controlledWorkRootRemoved: true, pathRecorded: false
    }
  };
}

function reportSet() {
  const values = {
    '3.1.11-installer': [1000, 1010, 1020, 1030, 1040, 1050, 1060, 1070],
    '3.1.11-portable': [2000, 2010, 2020, 2030, 2040, 2050, 2060, 2070],
    '3.1.12-installer': [250, 252, 254, 256, 258, 260, 262, 264],
    '3.1.12-portable': [490, 495, 500, 505, 510, 515, 520, 525]
  };
  return Object.fromEntries([
    'normal-clean-shutdown',
    'migration-vacuum',
    'crash-recovery'
  ].map((scenario) => [scenario, scenarioReport(scenario, values)]));
}

function receipts(reports) {
  const goldenReceipts = {};
  for (const [scenario, envelope] of Object.entries(reports)) {
    goldenReceipts[scenario] = {
      schemaVersion: 1,
      kind: 'windows-startup-golden-manual-receipt',
      evidenceSource: 'manual',
      scenario,
      goldenSha256: envelope.report.golden.sha256,
      goldenWalSha256: envelope.report.golden.walSha256,
      goldenShmSha256: envelope.report.golden.shmSha256,
      goldenSizeBytes: envelope.report.golden.sizeBytes,
      goldenWalSizeBytes: envelope.report.golden.walSizeBytes,
      goldenShmSizeBytes: envelope.report.golden.shmSizeBytes,
      sourceClass: 'controlled-windows-local-mounted-anonymized-copy',
      anonymizationConfirmed: true,
      representativenessConfirmed: true,
      dataOwnerConfirmed: true,
      signer: { id: 'owner-1', role: 'data-owner' },
      signedAt: '2026-08-20T08:00:00.000Z'
    };
  }
  return goldenReceipts;
}

function processSeamsReceipt(candidateEvidenceSha256, signedAt = '2026-08-20T08:30:00.000Z') {
  return {
    schemaVersion: 1,
    kind: 'windows-startup-process-seams-manual-receipt',
    evidenceSource: 'manual',
    candidateEvidenceSha256,
    installerAndPortableTreesObserved: true,
    ownedMainWindowObserved: true,
    closeMainWindowReceiptReviewed: true,
    failureCleanupObserved: true,
    noUnownedProcessTouchedConfirmed: true,
    signer: { id: 'windows-reviewer-1', role: 'windows-evidence-reviewer' },
    signedAt
  };
}

function finalReceipt(releaseCandidateSha256, signedAt = '2026-08-20T09:00:00.000Z') {
  return {
    schemaVersion: 1,
    kind: 'windows-startup-final-signoff-manual-receipt',
    evidenceSource: 'manual',
    releaseCandidateSha256,
    reductionsReviewed: true,
    formalReleaseApproved: true,
    signer: { id: 'release-owner-1', role: 'release-owner' },
    signedAt
  };
}

const BIND_CLOCK = Object.freeze({ now: () => '2026-08-20T08:45:00.000Z' });
const FINALIZE_CLOCK = Object.freeze({ now: () => '2026-08-20T09:15:00.000Z' });

test('owner marker 只允许删除 exact direct child，且绝不允许删除根或 source golden', () => {
  const parent = tempDir('startup-owned-root');
  const root = path.join(parent, 'acceptance-work');
  const marker = createOwnedWorkRoot(root, { ownerId: 'owner-1' });
  const scenario = path.join(root, 'scenario-normal');
  fs.mkdirSync(scenario);
  fs.writeFileSync(path.join(scenario, 'copy.sqlite'), 'copy');

  const receipt = removeExactOwnedTree({
    ownerRoot: root,
    target: scenario,
    expectedRelative: 'scenario-normal',
    marker
  });
  assert.equal(receipt.verifiedAbsent, true);
  assert.equal(fs.existsSync(scenario), false);
  assert.throws(() => removeExactOwnedTree({
    ownerRoot: root,
    target: root,
    expectedRelative: '.',
    marker
  }), /root|根目录/i);

  const outside = path.join(parent, 'golden.sqlite');
  fs.writeFileSync(outside, 'golden');
  assert.throws(() => removeExactOwnedTree({
    ownerRoot: root,
    target: outside,
    expectedRelative: '../golden.sqlite',
    marker
  }), /范围|relative|越界/i);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'golden');
});

test('finalizeOwnedWorkRoot 用 lstat 识别删除后被替换的 dangling symlink', (t) => {
  const parent = tempDir('startup-finalize-root-race');
  const root = path.join(parent, 'work');
  const marker = createOwnedWorkRoot(root, { ownerId: 'owner-race' });
  const originalRmdir = fs.rmdirSync;
  let linked = false;
  fs.rmdirSync = (target) => {
    originalRmdir(target);
    try {
      fs.symlinkSync(path.join(parent, 'missing-target'), target,
        process.platform === 'win32' ? 'dir' : undefined);
      linked = true;
    } catch (error) {
      if (process.platform === 'win32' && ['EPERM', 'EACCES', 'UNKNOWN'].includes(error.code)) return;
      throw error;
    }
  };
  try {
    if (process.platform === 'win32') {
      try {
        const probe = path.join(parent, 'probe-link');
        fs.symlinkSync(path.join(parent, 'missing-probe'), probe, 'file');
        fs.unlinkSync(probe);
      } catch (error) {
        t.skip(`当前环境不能创建 symlink：${error.code}`);
        return;
      }
    }
    assert.throws(() => finalizeOwnedWorkRoot({ workRoot: root, marker }), /cleanup|删除|仍存在|link/i);
    assert.equal(linked, true);
    assert.equal(fs.lstatSync(root).isSymbolicLink(), true);
  } finally {
    fs.rmdirSync = originalRmdir;
  }
});

test('owner marker 缺失、root symlink 或 target identity 不精确时 fail closed', (t) => {
  const parent = tempDir('startup-owned-guard');
  const root = path.join(parent, 'root');
  fs.mkdirSync(root);
  const target = path.join(root, 'target');
  fs.mkdirSync(target);
  assert.throws(() => removeExactOwnedTree({
    ownerRoot: root,
    target,
    expectedRelative: 'target'
  }), /marker/i);
  fs.rmSync(target, { recursive: true });
  const marker = createOwnedWorkRoot(root, { ownerId: 'owner-2', allowExisting: true });
  fs.mkdirSync(target);
  assert.throws(() => removeExactOwnedTree({
    ownerRoot: root,
    target,
    expectedRelative: 'other',
    marker
  }), /exact|identity|目标/i);

  const dangling = path.join(root, 'dangling-target');
  try {
    fs.symlinkSync(path.join(parent, 'missing-target'), dangling, process.platform === 'win32' ? 'file' : undefined);
    assert.throws(() => removeExactOwnedTree({
      ownerRoot: root,
      target: dangling,
      expectedRelative: 'dangling-target',
      marker
    }), /link|symlink|junction/i);
    assert.equal(fs.lstatSync(dangling).isSymbolicLink(), true);
  } catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES', 'UNKNOWN'].includes(error.code)) {
      t.diagnostic(`symlink unavailable: ${error.code}`);
    } else throw error;
  }

  const link = path.join(parent, 'root-link');
  try {
    fs.symlinkSync(root, link, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    t.skip(`当前环境不能创建目录链接：${error.code}`);
    return;
  }
  assert.throws(() => createOwnedWorkRoot(link, { ownerId: 'owner-3', allowExisting: true }), /link|链接|symlink/i);
});

test('output parent identity 冻结后若被 rename→symlink 重定向，写前失败且攻击目录无输出', (t) => {
  const root = tempDir('startup-output-parent-redirect');
  const outputParent = path.join(root, 'evidence');
  const movedParent = path.join(root, 'evidence-original');
  const attackParent = path.join(root, 'attacker');
  fs.mkdirSync(outputParent);
  fs.mkdirSync(attackParent);
  const config = { output: path.join(outputParent, 'report.json'), scenarios: {} };
  const guard = createProtectedOutputGuard(config);
  fs.renameSync(outputParent, movedParent);
  try {
    fs.symlinkSync(attackParent, outputParent, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    t.skip(`当前环境不能创建目录链接：${error.code}`);
    return;
  }
  assert.throws(() => writeProtectedJson(guard, config, { protected: true }), /parent|identity|link|输出/i);
  assert.equal(fs.existsSync(path.join(attackParent, 'report.json')), false);
  assert.equal(fs.existsSync(path.join(movedParent, 'report.json')), false);
});

test('output guard 拒绝任一 protected input 自身为 symlink/reparse alias', (t) => {
  const parent = tempDir('startup-protected-input-link');
  const source = path.join(parent, 'draft-source.json');
  const linked = path.join(parent, 'draft-link.json');
  fs.writeFileSync(source, '{}\n');
  try { fs.symlinkSync(source, linked); } catch (error) {
    if (process.platform === 'win32') return t.skip(`symlink unavailable: ${error.code}`);
    throw error;
  }
  assert.throws(() => createProtectedOutputGuard({
    output: path.join(parent, 'new-report.json'), draftReport: linked
  }), /symlink|reparse|link|alias/i);
});

test('3.1.12 phase inventory 必须 TechDoc 12 项 exact once/closed/finite/legal，3.1.11 明确 unavailable', () => {
  assert.deepEqual(validatePhaseInventory('3.1.11-installer', []), {
    status: 'unavailable-legacy',
    required: false,
    records: []
  });
  assert.equal(validatePhaseInventory('3.1.12-installer', phases()).status, 'complete');
  assert.throws(() => validatePhaseInventory('3.1.12-portable', phases().slice(1)), /missing|缺失/i);
  assert.throws(() => validatePhaseInventory('3.1.12-portable', phases().concat(phases()[0])), /duplicate|重复/i);
  assert.throws(() => validatePhaseInventory('3.1.12-portable', phases().map((item, index) => (
    index === 0 ? { ...item, durationMs: Number.NaN } : item
  ))), /finite|duration/i);
  assert.throws(() => validatePhaseInventory('3.1.12-portable', phases().map((item) => (
    item.phase === 'database-open' ? { ...item, outcome: 'skipped' } : item
  ))), /outcome|结果/i);
});

test('formal evaluator 分别计算 installer/portable raw median，process/final 只能走后两阶段', () => {
  const reports = reportSet();
  const goldenReceipts = receipts(reports);
  const draft = evaluateAcceptance({
    mode: 'formal', reports, goldenReceipts,
    environment: machineEnvironment(), artifacts: artifactEvidence(),
    generatedAt: '2026-08-20T08:00:00.000Z'
  });
  assert.equal(draft.evaluation.status, 'not-evaluated');
  assert.deepEqual(draft.evaluation.reasonCodes, [
    'FINAL_MANUAL_SIGNOFF_REQUIRED', 'PROCESS_SEAMS_MANUAL_RECEIPT_REQUIRED'
  ]);
  assert.equal(draft.evaluation.comparisons.installer.reductionPercent >= 70, true);
  assert.equal(draft.evaluation.comparisons.portable.reductionPercent >= 70, true);
  assert.match(draft.candidateEvidenceSha256, /^[0-9a-f]{64}$/);

  const bypassAttempt = evaluateAcceptance({
    mode: 'formal', reports, goldenReceipts,
    environment: machineEnvironment(),
    artifacts: artifactEvidence(),
    processSeamsReceipt: processSeamsReceipt(draft.candidateEvidenceSha256),
    generatedAt: draft.generatedAt
  });
  assert.deepEqual(bypassAttempt.evaluation.reasonCodes, [
    'FINAL_MANUAL_SIGNOFF_REQUIRED', 'PROCESS_SEAMS_MANUAL_RECEIPT_REQUIRED'
  ]);
  assert.equal(bypassAttempt.releaseCandidateSha256, null);
  assert.equal(bypassAttempt.evaluation.formal, false);

  const bound = bindProcessReceipt(
    draft, processSeamsReceipt(draft.candidateEvidenceSha256), BIND_CLOCK
  );
  const finalized = finalizeAcceptanceReport(bound,
    processSeamsReceipt(draft.candidateEvidenceSha256),
    finalReceipt(bound.releaseCandidateSha256), FINALIZE_CLOCK);
  assert.equal(finalized.evaluation.status, 'pass');
  assert.equal(finalized.manualReceipts.finalSignoff.evidenceSource, 'manual');
});

test('formal 禁止三字段 environment，并从 canonical machine fields 重算 digest 绑定 candidate/privacy', () => {
  const reports = reportSet();
  assert.throws(() => evaluateAcceptance({
    mode: 'formal', reports, goldenReceipts: receipts(reports), artifacts: artifactEvidence(),
    environment: { status: 'recorded', evidenceSource: 'machine', digest: 'e'.repeat(64) },
    generatedAt: '2026-08-20T08:00:00.000Z'
  }), /environment|machine|环境/i);

  const draft = evaluateAcceptance({
    mode: 'formal', reports, goldenReceipts: receipts(reports), artifacts: artifactEvidence(),
    environment: machineEnvironment(), generatedAt: '2026-08-20T08:00:00.000Z'
  });
  const cpuTampered = structuredClone(draft);
  cpuTampered.environment.cpu.model = 'tampered CPU';
  assert.throws(() => bindProcessReceipt(cpuTampered,
    processSeamsReceipt(draft.candidateEvidenceSha256)), /environment|digest|candidate|draft/i);
  const privacyTampered = structuredClone(draft);
  privacyTampered.privacy.rawLogsIncluded = true;
  assert.throws(() => bindProcessReceipt(privacyTampered,
    processSeamsReceipt(draft.candidateEvidenceSha256)), /privacy|隐私/i);
});

test('MANUAL receipt 使用 M→process→R→final 非自引用时序链，拒绝预签和倒序时间', () => {
  const reports = reportSet();
  const draft = evaluateAcceptance({
    mode: 'formal', reports, goldenReceipts: receipts(reports), artifacts: artifactEvidence(),
    environment: machineEnvironment(), generatedAt: '2026-08-20T08:00:00.000Z'
  });
  assert.equal(draft.releaseCandidateSha256, null);
  assert.throws(() => bindProcessReceipt(draft,
    processSeamsReceipt(draft.candidateEvidenceSha256, '1999-01-01T00:00:00.000Z'),
    BIND_CLOCK), /receipt|时序/i);
  const processReceipt = processSeamsReceipt(draft.candidateEvidenceSha256, '2026-08-20T08:30:00.000Z');
  const bound = bindProcessReceipt(draft, processReceipt, BIND_CLOCK);
  assert.match(bound.releaseCandidateSha256, /^[0-9a-f]{64}$/);
  assert.notEqual(bound.releaseCandidateSha256, draft.candidateEvidenceSha256);
  assert.throws(() => bindProcessReceipt(bound, processReceipt), /release candidate|already bound|已绑定/i);
  assert.throws(() => finalizeAcceptanceReport(bound, processReceipt,
    finalReceipt(bound.releaseCandidateSha256, '2000-01-01T00:00:00.000Z'),
    FINALIZE_CLOCK), /receipt|时序/i);
  assert.equal(finalizeAcceptanceReport(bound, processReceipt,
    finalReceipt(bound.releaseCandidateSha256, '2026-08-20T09:00:00.000Z'),
    FINALIZE_CLOCK).evaluation.status, 'pass');
});

test('receipt chronology 使用 canonical ISO 与可注入 now，拒绝未来、非 canonical 和倒序', () => {
  const reports = reportSet();
  const goldenReceipts = receipts(reports);
  const draft = evaluateAcceptance({
    mode: 'formal', reports, goldenReceipts, artifacts: artifactEvidence(),
    environment: machineEnvironment(), generatedAt: '2026-08-20T08:00:00.000Z'
  });
  assert.throws(() => bindProcessReceipt(draft,
    processSeamsReceipt(draft.candidateEvidenceSha256, '2026-08-20T08:30:00Z'),
    { now: () => '2026-08-20T08:45:00.000Z' }), /canonical|receipt|时间|时序/i);
  assert.throws(() => bindProcessReceipt(draft,
    processSeamsReceipt(draft.candidateEvidenceSha256, '2026-08-20T09:00:00.000Z'),
    { now: () => '2026-08-20T08:45:00.000Z' }), /future|receipt|时间|时序/i);

  const processReceipt = processSeamsReceipt(
    draft.candidateEvidenceSha256, '2026-08-20T08:30:00.000Z'
  );
  const bound = bindProcessReceipt(draft, processReceipt, {
    now: () => '2026-08-20T08:45:00.000Z'
  });
  assert.equal(bound.releaseBoundAt, '2026-08-20T08:45:00.000Z');
  assert.throws(() => finalizeAcceptanceReport(bound, processReceipt,
    finalReceipt(bound.releaseCandidateSha256, '2026-08-20T09:30:00.000Z'),
    { now: () => '2026-08-20T09:00:00.000Z' }), /future|receipt|时间|时序/i);
  assert.throws(() => finalizeAcceptanceReport(bound, processReceipt,
    finalReceipt(bound.releaseCandidateSha256, '2026-08-20T08:40:00.000Z'),
    { now: () => '2026-08-20T09:00:00.000Z' }), /receipt|时间|时序/i);
  assert.equal(finalizeAcceptanceReport(bound, processReceipt,
    finalReceipt(bound.releaseCandidateSha256, '2026-08-20T09:00:00.000Z'),
    { now: () => '2026-08-20T09:15:00.000Z' }).evaluation.status, 'pass');

  const futureGolden = receipts(reports);
  futureGolden['normal-clean-shutdown'].signedAt = '2026-08-20T08:00:00.001Z';
  const invalidGolden = evaluateAcceptance({
    mode: 'formal', reports, goldenReceipts: futureGolden, artifacts: artifactEvidence(),
    environment: machineEnvironment(), generatedAt: '2026-08-20T08:00:00.000Z'
  });
  assert.ok(invalidGolden.evaluation.reasonCodes.includes('GOLDEN_MANUAL_RECEIPT_INVALID'));
  assert.throws(() => evaluateAcceptance({
    mode: 'formal', reports, goldenReceipts, artifacts: artifactEvidence(),
    environment: machineEnvironment(), generatedAt: '2026-08-20T08:00:00Z'
  }), /canonical|generatedAt|时间/i);
});

test('70% threshold 使用未 round 的完整 Number median，展示值只在裁决后 round', () => {
  assert.equal(comparison(Array(8).fill(100), Array(8).fill(30.0004)).reductionPercent, 70);
  assert.equal(comparison(Array(8).fill(100), Array(8).fill(30.0004)).passed, false);
  assert.equal(comparison(Array(8).fill(100), Array(8).fill(30)).passed, true);
  assert.equal(comparison(Array(8).fill(100), Array(8).fill(29.9996)).passed, true);
});

test('finalize 重跑 canonical sample/median gates，不信 cached comparison 或 candidate SHA', () => {
  const reports = reportSet();
  const first = evaluateAcceptance({
    mode: 'formal', reports, goldenReceipts: receipts(reports),
    environment: machineEnvironment(),
    artifacts: artifactEvidence(), generatedAt: '2026-08-20T08:00:00.000Z'
  });
  const bound = bindProcessReceipt(
    first, processSeamsReceipt(first.candidateEvidenceSha256), BIND_CLOCK
  );
  const tampered = structuredClone(bound);
  tampered.scenarios['normal-clean-shutdown'].variants['3.1.12-installer'].samples
    .forEach((sample) => { sample.externalFullReadyMs = 999; });
  assert.throws(() => finalizeAcceptanceReport(tampered,
    processSeamsReceipt(first.candidateEvidenceSha256),
    finalReceipt(bound.releaseCandidateSha256), FINALIZE_CLOCK), /70%|threshold|candidate/i);
});

test('bind/finalize output exact/symlink/hardlink alias draft 时在读取/写入前拒绝且 draft 不变', async (t) => {
  const parent = tempDir('startup-finalize-output-protection');
  const draftPath = path.join(parent, 'draft.json');
  const processPath = path.join(parent, 'process.json');
  const finalPath = path.join(parent, 'final.json');
  fs.writeFileSync(draftPath, '{"protected":true}\n');
  fs.writeFileSync(processPath, '{}\n');
  fs.writeFileSync(finalPath, '{}\n');
  const before = fs.readFileSync(draftPath);
  const outputs = [draftPath, path.join(parent, 'draft-hardlink.json'), path.join(parent, 'draft-symlink.json')];
  fs.linkSync(draftPath, outputs[1]);
  try { fs.symlinkSync(draftPath, outputs[2]); } catch (error) {
    if (process.platform === 'win32') { t.diagnostic(`symlink unavailable: ${error.code}`); outputs.pop(); }
    else throw error;
  }
  for (const action of ['bind-process', 'finalize']) {
    for (const [index, output] of outputs.entries()) {
      const configPath = path.join(parent, `${action}-config-${index}.json`);
      fs.writeFileSync(configPath, JSON.stringify({
        schemaVersion: 1, action, draftReport: draftPath,
        processSeamsReceipt: processPath, finalSignoffReceipt: finalPath, output
      }));
      await assert.rejects(() => acceptanceMain(['--config', configPath]), /output|覆盖|exist/i);
      assert.deepEqual(fs.readFileSync(draftPath), before);
    }
  }
});

test('evaluator 不过滤 failed/missing 样本、不合池；任一完整配对低于70%即 fail', () => {
  const reports = reportSet();
  reports['normal-clean-shutdown'].report.variants['3.1.12-installer'].samples[2] = {
    round: 3, status: 'failed', evidenceCode: 'FAIL'
  };
  const incomplete = evaluateAcceptance({
    mode: 'formal', reports, goldenReceipts: receipts(reports),
    environment: machineEnvironment(),
    artifacts: artifactEvidence()
  });
  assert.equal(incomplete.evaluation.status, 'not-evaluated');
  assert.ok(incomplete.evaluation.reasonCodes.includes('FAILED_OR_MISSING_SAMPLE'));
  assert.equal(incomplete.evaluation.comparisons, null);

  const below = reportSet();
  below['normal-clean-shutdown'].report.variants['3.1.12-portable'].samples
    .forEach((sample, index) => { sample.externalFullReadyMs = 700 + index * 10; });
  const failed = evaluateAcceptance({
    mode: 'formal', reports: below, goldenReceipts: receipts(below),
    environment: machineEnvironment(),
    artifacts: artifactEvidence()
  });
  assert.equal(failed.evaluation.status, 'fail');
  assert.equal(failed.evaluation.comparisons.installer.passed, true);
  assert.equal(failed.evaluation.comparisons.portable.passed, false);
});

test('rehearsal 永远 not-evaluated，不能被 receipt 或高收益升级为 formal pass', () => {
  const reports = reportSet();
  const result = evaluateAcceptance({
    mode: 'rehearsal', reports, goldenReceipts: receipts(reports),
    environment: machineEnvironment(),
    artifacts: artifactEvidence(),
    finalSignoffReceipt: { formalReleaseApproved: true }
  });
  assert.equal(result.evaluation.status, 'not-evaluated');
  assert.equal(result.evaluation.formal, false);
  assert.ok(result.evaluation.reasonCodes.includes('REHEARSAL_NEVER_FORMAL'));
});

test('formal 任一 scenario/workRoot cleanup 未证实即 not-evaluated', () => {
  const reports = reportSet();
  reports['migration-vacuum'].cleanupEvidence = { verifiedAbsent: false };
  const artifacts = artifactEvidence();
  artifacts.cleanup.verified = false;
  const result = evaluateAcceptance({
    mode: 'formal', reports, goldenReceipts: receipts(reports), artifacts,
    environment: machineEnvironment()
  });
  assert.equal(result.evaluation.status, 'not-evaluated');
  assert.ok(result.evaluation.reasonCodes.includes('HOST_OR_CLEANUP_EVIDENCE_INVALID'));
  assert.equal(result.evaluation.comparisons, null);
});

test('formal exact-8/rotation/首样本/process cleanup/synthetic origin 任一破坏都 fail-closed', () => {
  const mutations = [
    (reports) => { reports['normal-clean-shutdown'].report.contract.firstSampleRetained = false; },
    (reports) => {
      reports['normal-clean-shutdown'].report.variants['3.1.12-installer']
        .samples[0].scenarioEvidence.precondition.vacuumFlagBefore = '0';
    },
    (reports) => { reports['normal-clean-shutdown'].report.contract.rotatingOrder[0].reverse(); },
    (reports) => { reports['normal-clean-shutdown'].report.variants['3.1.12-portable'].samples[0].processExitEvidence.quiescenceSnapshots = [[], []]; },
    (reports) => { reports['normal-clean-shutdown'].report.golden.synthetic = true; },
    (reports) => {
      reports['migration-vacuum'].report.variants['3.1.12-installer']
        .samples[0].scenarioEvidence.postcondition.schemaDelta.added[0].name = 'unexpected_index';
    },
    (reports) => {
      reports['migration-vacuum'].report.variants['3.1.12-installer']
        .samples[0].scenarioEvidence.precondition.vacuumFlagBefore = '1';
    },
    (reports) => {
      reports['crash-recovery'].report.variants['3.1.12-installer']
        .samples[0].scenarioEvidence.postcondition.journalSentinelConsumed = false;
    }
  ];
  for (const mutate of mutations) {
    const reports = reportSet();
    mutate(reports);
    const result = evaluateAcceptance({
      mode: 'formal', reports, goldenReceipts: receipts(reports),
      environment: machineEnvironment(),
      artifacts: artifactEvidence()
    });
    assert.equal(result.evaluation.status, 'not-evaluated');
    assert.equal(result.evaluation.comparisons, null);
  }
});

test('public projection 保留完整 phase/before-after/recovery/migration/cleanup 证据且不携带 SQL/raw path', () => {
  const reports = reportSet();
  const draft = evaluateAcceptance({
    mode: 'formal', reports, goldenReceipts: receipts(reports),
    environment: machineEnvironment(), artifacts: artifactEvidence(),
    generatedAt: '2026-08-20T08:00:00.000Z'
  });
  const normal = draft.scenarios['normal-clean-shutdown'].variants['3.1.12-installer'].samples[0];
  assert.equal(normal.phaseEvidence.records.length, REQUIRED_STARTUP_PHASES.length);
  assert.deepEqual(Object.keys(normal.bundleEvidence), ['before', 'after']);
  assert.equal(normal.scenarioEvidence.vacuumFlagBefore, '1');
  assert.equal(normal.scenarioEvidence.walBytesBefore, 0);
  assert.equal(normal.scenarioEvidence.schemaFingerprintBefore,
    normal.scenarioEvidence.schemaFingerprintAfter);
  assert.equal(normal.recoveryEvidence.records.some((item) => item.source === 'actualPostcondition'), true);
  assert.equal(normal.cleanupReceipt.processTree.verifiedEmpty, true);
  const migration = draft.scenarios['migration-vacuum'].variants['3.1.12-installer'].samples[0];
  assert.equal(migration.scenarioEvidence.vacuumFlagBefore, null);
  assert.equal(migration.scenarioEvidence.columnDefinitions.archive_blobs.length, 4);
  assert.match(migration.scenarioEvidence.schemaFingerprintBefore, /^[0-9a-f]{64}$/);
  assert.match(migration.scenarioEvidence.indexEvidence.actualDefinitionSha256, /^[0-9a-f]{64}$/);
  assert.equal(migration.cleanupReceipt.workingCopy.verifiedAbsent, true);
  const crash = draft.scenarios['crash-recovery'].variants['3.1.12-installer'].samples[0];
  assert.equal(crash.scenarioEvidence.journalSentinelPresentBefore, true);
  assert.equal(crash.scenarioEvidence.journalSentinelConsumedAfter, true);
  assert.equal(JSON.stringify(draft).includes('create index expected'), false);
  assert.equal(JSON.stringify(draft).includes('/Users/'), false);
});

test('finalize 从结构化 projection 重验 phase/bundle/recovery/migration/cleanup，不以 fullReport digest 替代', () => {
  const reports = reportSet();
  const draft = evaluateAcceptance({
    mode: 'formal', reports, goldenReceipts: receipts(reports),
    environment: machineEnvironment(), artifacts: artifactEvidence(),
    generatedAt: '2026-08-20T08:00:00.000Z'
  });
  const processReceipt = processSeamsReceipt(draft.candidateEvidenceSha256);
  const bound = bindProcessReceipt(draft, processReceipt, BIND_CLOCK);
  const mutations = [
    (report) => { report.scenarios['normal-clean-shutdown'].variants['3.1.12-installer'].samples[0].phaseEvidence.records.at(-2).durationMs = 2; },
    (report) => { report.scenarios['normal-clean-shutdown'].variants['3.1.12-installer'].samples[0].scenarioEvidence.vacuumFlagBefore = '0'; },
    (report) => { report.scenarios['normal-clean-shutdown'].variants['3.1.12-installer'].samples[0].scenarioEvidence.schemaFingerprintAfter = 'a'.repeat(64); },
    (report) => { report.scenarios['normal-clean-shutdown'].variants['3.1.12-installer'].samples[0].bundleEvidence.after.main.sha256 = 'bad'; },
    (report) => { report.scenarios['normal-clean-shutdown'].variants['3.1.12-installer'].samples[0].recoveryEvidence.records.pop(); },
    (report) => {
      const counts = report.scenarios['normal-clean-shutdown'].variants['3.1.12-installer']
        .samples[0].recoveryEvidence.records.find((record) => record.source === 'actualPostcondition').counts;
      counts.push({ ...counts[0] });
    },
    (report) => { report.scenarios['migration-vacuum'].variants['3.1.12-installer'].samples[0].scenarioEvidence.columnDefinitions.archive_blobs[0].name = 'wrong'; },
    (report) => { report.scenarios['migration-vacuum'].variants['3.1.12-installer'].samples[0].scenarioEvidence.vacuumFlagBefore = '1'; },
    (report) => { report.scenarios['crash-recovery'].variants['3.1.12-installer'].samples[0].scenarioEvidence.journalSentinelConsumedAfter = false; },
    (report) => { report.scenarios['crash-recovery'].variants['3.1.12-installer'].samples[0].cleanupReceipt.workingCopy.verifiedAbsent = false; },
    (report) => { report.scenarios['crash-recovery'].variants['3.1.12-installer'].samples[0].cleanupReceipt.workingCopy.targetIdentitySha256 = 'f'.repeat(64); },
    (report) => {
      const samples = report.scenarios['normal-clean-shutdown'].variants['3.1.12-installer'].samples;
      samples[1].processEvidence.nonceSha256 = samples[0].processEvidence.nonceSha256;
    },
    (report) => { report.scenarios['normal-clean-shutdown'].variants['3.1.12-installer'].samples[0].externalFullReadyMs = 0.5; }
  ];
  for (const mutate of mutations) {
    const tampered = structuredClone(bound);
    mutate(tampered);
    assert.throws(() => finalizeAcceptanceReport(tampered, processReceipt,
      finalReceipt(bound.releaseCandidateSha256), FINALIZE_CLOCK), /phase|bundle|recovery|migration|normal|sentinel|cleanup|candidate|main|hash|column|nonce|timing|ready/i);
  }
});

test('main/WAL/SHM non-null identity 必须 64hex，ready mode/duration 必须与 phase records 交叉绑定', () => {
  const mutations = [
    (reports) => { reports['crash-recovery'].report.golden.walSha256 = 'not-hex'; },
    (reports) => { reports['normal-clean-shutdown'].report.golden.sha256 = 'short'; },
    (reports) => { reports['normal-clean-shutdown'].report.variants['3.1.12-installer'].samples[0].after.shm = { exists: true, size: 1, sha256: 'bad' }; },
    (reports) => { reports['normal-clean-shutdown'].report.variants['3.1.11-installer'].samples[0].readyEvidence.mode = 'legacy-renderer-contract'; },
    (reports) => { reports['normal-clean-shutdown'].report.variants['3.1.12-installer'].samples[0].readyEvidence.rendererInitMs = -1; },
    (reports) => { reports['normal-clean-shutdown'].report.variants['3.1.12-installer'].samples[0].readyEvidence.windowReadyMs = 2; }
  ];
  for (const mutate of mutations) {
    const reports = reportSet();
    mutate(reports);
    const result = evaluateAcceptance({
      mode: 'formal', reports, goldenReceipts: receipts(reports),
      environment: machineEnvironment(), artifacts: artifactEvidence(),
      generatedAt: '2026-08-20T08:00:00.000Z'
    });
    assert.equal(result.evaluation.status, 'not-evaluated');
    assert.equal(result.evaluation.comparisons, null);
  }
  const reports = reportSet();
  const receipt = receipts(reports)['crash-recovery'];
  assert.throws(() => validateGoldenManualReceipt({ ...receipt, goldenWalSha256: 'bad' },
    reports['crash-recovery'].report), /WAL|bundle|hash/i);
});

test('raw/projected timing 必须满足 external>=renderer/window/startupTotal 且 startupTotal>=windowReady', () => {
  const impossible = reportSet();
  const sample = impossible['normal-clean-shutdown'].report
    .variants['3.1.12-installer'].samples[0];
  sample.externalFullReadyMs = 1;
  sample.readyEvidence.rendererInitMs = 5000;
  sample.readyEvidence.windowReadyMs = 6000;
  sample.readyEvidence.startupTotalMs = 7000;
  sample.phases.find((record) => record.phase === 'window-ready').durationMs = 6000;
  sample.phases.find((record) => record.phase === 'startup-total').durationMs = 7000;
  const rejected = evaluateAcceptance({
    mode: 'formal', reports: impossible, goldenReceipts: receipts(impossible),
    environment: machineEnvironment(), artifacts: artifactEvidence(),
    generatedAt: '2026-08-20T08:00:00.000Z'
  });
  assert.equal(rejected.evaluation.status, 'not-evaluated');
  assert.equal(rejected.evaluation.comparisons, null);
  assert.ok(rejected.evaluation.reasonCodes.includes('READY_EVIDENCE_INVALID'));

  const equalBoundary = reportSet();
  const equal = equalBoundary['normal-clean-shutdown'].report
    .variants['3.1.12-installer'].samples[0];
  equal.externalFullReadyMs = 1;
  equal.readyEvidence.rendererInitMs = 1;
  equal.readyEvidence.windowReadyMs = 1;
  equal.readyEvidence.startupTotalMs = 1;
  const accepted = evaluateAcceptance({
    mode: 'formal', reports: equalBoundary, goldenReceipts: receipts(equalBoundary),
    environment: machineEnvironment(), artifacts: artifactEvidence(),
    generatedAt: '2026-08-20T08:00:00.000Z'
  });
  assert.notEqual(accepted.evaluation.comparisons, null);
});

test('整个 comparison 的 nonce 与 non-normal cleanup token 必须唯一且精确绑定坐标', () => {
  for (const mutate of [
    (reports) => {
      const reused = reports['normal-clean-shutdown'].report.variants['3.1.11-installer']
        .samples[0].processTree.nonceSha256;
      for (const envelope of Object.values(reports)) {
        for (const variant of Object.values(envelope.report.variants)) {
          for (const sample of variant.samples) sample.processTree.nonceSha256 = reused;
        }
      }
    },
    (reports) => {
      const reused = reports['migration-vacuum'].report.variants['3.1.11-installer']
        .samples[0].afterSampleCleanupEvidence.targetIdentitySha256;
      for (const scenario of ['migration-vacuum', 'crash-recovery']) {
        for (const variant of Object.values(reports[scenario].report.variants)) {
          for (const sample of variant.samples) {
            sample.afterSampleCleanupEvidence.targetIdentitySha256 = reused;
          }
        }
      }
    },
    (reports) => {
      reports['migration-vacuum'].report.variants['3.1.12-installer']
        .samples[0].afterSampleCleanupEvidence.targetIdentitySha256 = 'f'.repeat(64);
    }
  ]) {
    const reports = reportSet();
    mutate(reports);
    const result = evaluateAcceptance({
      mode: 'formal', reports, goldenReceipts: receipts(reports),
      environment: machineEnvironment(), artifacts: artifactEvidence(),
      generatedAt: '2026-08-20T08:00:00.000Z'
    });
    assert.equal(result.evaluation.status, 'not-evaluated');
    assert.equal(result.evaluation.comparisons, null);
  }
});

test('failed sample 仍保留每场景安全 projection 与 explicit unavailable，不清空全部 scenarios', () => {
  const reports = reportSet();
  const failed = reports['normal-clean-shutdown'].report.variants['3.1.12-installer'].samples[2];
  reports['normal-clean-shutdown'].report.variants['3.1.12-installer'].samples[2] = {
    round: 3,
    status: 'failed',
    evidenceCode: 'READY_TIMEOUT',
    before: failed.before,
    phases: failed.phases,
    evidence: { rawLogs: 'customer account 6222020202020202' }
  };
  const result = evaluateAcceptance({
    mode: 'formal', reports, goldenReceipts: receipts(reports),
    environment: machineEnvironment(), artifacts: artifactEvidence(),
    generatedAt: '2026-08-20T08:00:00.000Z'
  });
  assert.equal(result.evaluation.status, 'not-evaluated');
  assert.equal(result.evaluation.comparisons, null);
  assert.deepEqual(Object.keys(result.scenarios).sort(), [
    'crash-recovery', 'migration-vacuum', 'normal-clean-shutdown'
  ]);
  const projected = result.scenarios['normal-clean-shutdown']
    .variants['3.1.12-installer'].samples[2];
  assert.equal(projected.round, 3);
  assert.equal(projected.status, 'failed');
  assert.equal(projected.evidenceCode, 'READY_TIMEOUT');
  assert.equal(projected.bundleEvidence.before.main.sha256, failed.before.database.sha256);
  assert.equal(projected.bundleEvidence.after, null);
  assert.equal(projected.readyEvidence.status, 'unavailable');
  assert.equal(JSON.stringify(result).includes('6222020202020202'), false);

  const missingReports = reportSet();
  missingReports['crash-recovery'].report.variants['3.1.11-portable'].samples.splice(3, 1);
  const missing = evaluateAcceptance({
    mode: 'formal', reports: missingReports, goldenReceipts: receipts(missingReports),
    environment: machineEnvironment(), artifacts: artifactEvidence(),
    generatedAt: '2026-08-20T08:00:00.000Z'
  });
  const missingProjection = missing.scenarios['crash-recovery']
    .variants['3.1.11-portable'].samples.find((sample) => sample.round === 4);
  assert.equal(missingProjection.status, 'failed');
  assert.equal(missingProjection.evidenceCode, 'MISSING_SAMPLE');
  assert.equal(missingProjection.bundleEvidence.status, 'unavailable');

  const missingScenarioReports = reportSet();
  delete missingScenarioReports['migration-vacuum'];
  const missingScenario = evaluateAcceptance({
    mode: 'formal', reports: missingScenarioReports,
    goldenReceipts: receipts(missingScenarioReports),
    environment: machineEnvironment(), artifacts: artifactEvidence(),
    generatedAt: '2026-08-20T08:00:00.000Z'
  });
  assert.deepEqual(Object.keys(missingScenario.scenarios).sort(), [
    'crash-recovery', 'migration-vacuum', 'normal-clean-shutdown'
  ]);
  assert.equal(missingScenario.scenarios['migration-vacuum'].run.status, 'unavailable');
  assert.equal(missingScenario.scenarios['migration-vacuum'].variants['3.1.12-installer'].sampleCount, 0);
});

test('缺单 variant、缺 samples 或缺 variants 都生成 strict unavailable projection', () => {
  const cases = [
    ['missing variant', (report) => { delete report.variants['3.1.12-installer']; }, ['3.1.12-installer']],
    ['missing samples', (report) => { delete report.variants['3.1.12-installer'].samples; }, ['3.1.12-installer']],
    ['missing variants', (report) => { delete report.variants; }, [
      '3.1.11-installer', '3.1.11-portable', '3.1.12-installer', '3.1.12-portable'
    ]]
  ];
  for (const [name, mutate, missingLabels] of cases) {
    const reports = reportSet();
    mutate(reports['normal-clean-shutdown'].report);
    const result = evaluateAcceptance({
      mode: 'formal', reports, goldenReceipts: receipts(reports),
      environment: machineEnvironment(), artifacts: artifactEvidence(),
      generatedAt: '2026-08-20T08:00:00.000Z'
    });
    assert.equal(result.evaluation.status, 'not-evaluated', name);
    assert.equal(result.evaluation.comparisons, null, name);
    assert.equal(result.scenarios['crash-recovery'].variants['3.1.11-installer'].sampleCount, 8, name);
    for (const label of missingLabels) {
      const projection = result.scenarios['normal-clean-shutdown'].variants[label];
      assert.deepEqual(Object.keys(projection).sort(), [
        'evidenceCode', 'label', 'sampleCount', 'samples', 'status'
      ], name);
      assert.equal(projection.label, label, name);
      assert.equal(projection.status, 'unavailable', name);
      assert.equal(projection.evidenceCode, name === 'missing samples'
        ? 'MISSING_VARIANT_SAMPLES' : 'MISSING_VARIANT', name);
      assert.equal(projection.sampleCount, 0, name);
      assert.deepEqual(projection.samples, [], name);
    }
  }
});

test('normal 仅首轮绑定 approved golden，后续严格 previous.after→next.before 连续', () => {
  const reports = reportSet();
  const normal = reports['normal-clean-shutdown'].report;
  for (const label of Object.keys(normal.variants)) {
    const sampleList = normal.variants[label].samples;
    for (let index = 0; index < sampleList.length; index += 1) {
      const nextHash = (index + 1).toString(16).repeat(64);
      sampleList[index].after.database.sha256 = nextHash;
      if (index + 1 < sampleList.length) sampleList[index + 1].before.database.sha256 = nextHash;
    }
  }
  const continuous = evaluateAcceptance({
    mode: 'formal', reports, goldenReceipts: receipts(reports),
    environment: machineEnvironment(), artifacts: artifactEvidence(),
    generatedAt: '2026-08-20T08:00:00.000Z'
  });
  assert.notEqual(continuous.evaluation.comparisons, null);

  reports['normal-clean-shutdown'].report.variants['3.1.12-installer'].samples[3]
    .before.database.sha256 = 'f'.repeat(64);
  const broken = evaluateAcceptance({
    mode: 'formal', reports, goldenReceipts: receipts(reports),
    environment: machineEnvironment(), artifacts: artifactEvidence(),
    generatedAt: '2026-08-20T08:00:00.000Z'
  });
  assert.equal(broken.evaluation.status, 'not-evaluated');
  assert.ok(broken.evaluation.reasonCodes.includes('NORMAL_BUNDLE_CONTINUITY_INVALID'));
});

test('formal evaluator 必须把三份 runner artifact identity 绑定到 installer-installed/portable freeze provenance', () => {
  const reports = reportSet();
  const evidence = artifactEvidence();
  reports['migration-vacuum'].report.variants['3.1.12-installer'].artifact.sha256 = 'f'.repeat(64);
  const result = evaluateAcceptance({
    mode: 'formal', reports, goldenReceipts: receipts(reports),
    environment: machineEnvironment(),
    artifacts: evidence, comparisonId: 'comparison-1'
  });
  assert.equal(result.evaluation.status, 'not-evaluated');
  assert.ok(result.evaluation.reasonCodes.includes('ARTIFACT_RUN_IDENTITY_MISMATCH'));

  const missingVersion = artifactEvidence();
  for (const identity of [
    missingVersion.variants['3.1.11-portable'].artifact,
    missingVersion.variants['3.1.11-portable'].provenance.source,
    missingVersion.variants['3.1.11-portable'].provenance.frozen,
    missingVersion.variants['3.1.11-portable'].provenance.launched
  ]) delete identity.fileVersion;
  const versionless = evaluateAcceptance({
    mode: 'formal', reports: reportSet(), goldenReceipts: receipts(reportSet()),
    environment: machineEnvironment(), artifacts: missingVersion, comparisonId: 'comparison-1'
  });
  assert.equal(versionless.evaluation.status, 'not-evaluated');
  assert.ok(versionless.evaluation.reasonCodes.includes('ARTIFACT_EVIDENCE_INVALID'));

  const freeTextVersion = artifactEvidence();
  for (const identity of [
    freeTextVersion.variants['3.1.12-portable'].artifact,
    freeTextVersion.variants['3.1.12-portable'].provenance.source,
    freeTextVersion.variants['3.1.12-portable'].provenance.frozen,
    freeTextVersion.variants['3.1.12-portable'].provenance.launched
  ]) identity.fileVersion = '3.1.12 customer account 6222020202020202';
  const privacySafe = evaluateAcceptance({
    mode: 'formal', reports: reportSet(), goldenReceipts: receipts(reportSet()),
    environment: machineEnvironment(), artifacts: freeTextVersion,
    comparisonId: 'comparison-1', generatedAt: '2026-08-20T08:00:00.000Z'
  });
  assert.equal(privacySafe.evaluation.status, 'not-evaluated');
  assert.ok(privacySafe.evaluation.reasonCodes.includes('ARTIFACT_EVIDENCE_INVALID'));
  assert.equal(JSON.stringify(privacySafe).includes('customer account'), false);
});

test('golden manual receipt 必须结构化绑定 hash/size/scenario，不能用自由字符串冒充机器证据', () => {
  const report = reportSet()['normal-clean-shutdown'].report;
  const receipt = receipts({ 'normal-clean-shutdown': { report } })['normal-clean-shutdown'];
  assert.equal(validateGoldenManualReceipt(receipt, report).status, 'confirmed');
  assert.throws(() => validateGoldenManualReceipt({
    confirmation: 'already anonymized by owner'
  }, report), /kind|schema|receipt/i);
  assert.throws(() => validateGoldenManualReceipt({
    ...receipt, goldenSha256: '0'.repeat(64)
  }, report), /SHA|hash/i);
  assert.throws(() => validateGoldenManualReceipt({
    ...receipt, goldenShmSha256: 'f'.repeat(64)
  }, report), /WAL|size|bundle/i);
});

test('NSIS setup 必须真实安装到受控根并形成 setup→installed exe provenance；portable 只冻结复制', () => {
  const parent = tempDir('startup-install-provenance');
  const inputRoot = path.join(parent, 'inputs');
  const root = path.join(parent, 'work');
  fs.mkdirSync(inputRoot);
  const inputs = {};
  for (const version of ['3.1.11', '3.1.12']) {
    for (const kind of ['setup', 'portable']) {
      const filePath = path.join(inputRoot, `${version}-${kind}.exe`);
      fs.writeFileSync(filePath, `${version}-${kind}`);
      inputs[`${version}-${kind}`] = filePath;
    }
  }
  const calls = [];
  const result = installWindowsVariants({ workRoot: root, inputs }, {
    platform: 'win32',
    readFileVersion: (filePath) => filePath.includes('3.1.11') ? '3.1.11.0' : '3.1.12.0',
    runInstaller: (setupPath, args, installRoot) => {
      calls.push({ setupPath, args, installRoot });
      fs.mkdirSync(installRoot, { recursive: true });
      fs.writeFileSync(path.join(installRoot, '清结算小助手.exe'), path.basename(setupPath));
      fs.writeFileSync(path.join(installRoot, 'Uninstall 清结算小助手.exe'), 'uninstall');
    }
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].args.slice(0, 1), ['/S']);
  assert.equal(calls[0].args.at(-1).startsWith('/D='), true);
  assert.equal(result.variants['3.1.11-installer'].provenance.kind, 'installer-installed');
  assert.equal(result.variants['3.1.11-installer'].provenance.setup.sha256, sha256Bytes('3.1.11-setup'));
  assert.equal(result.variants['3.1.11-installer'].artifact.fileVersion, '3.1.11.0');
  assert.equal(result.variants['3.1.12-portable'].provenance.kind, 'portable-frozen-copy');
  assert.equal(JSON.stringify(result).includes(root), false, 'provenance 不得记录绝对 workRoot');

  const marker = createOwnedWorkRoot(root, { allowExisting: true });
  const cleanup = cleanupInstalledVariants({ workRoot: root, marker, install: result }, {
    runUninstaller: (_uninstaller, _args, installRoot) => fs.rmSync(installRoot, { recursive: true })
  });
  assert.equal(cleanup.verified, true);
  assert.equal(fs.existsSync(inputs['3.1.11-setup']), true, 'cleanup 绝不能删除 source setup');
  const rootCleanup = finalizeOwnedWorkRoot({ workRoot: root, marker });
  assert.equal(rootCleanup.controlledWorkRootRemoved, true);
});

test('磁盘预算按 normal 五份同时副本与 non-normal 逐样本峰值计算，不按累计72.5GB保留', () => {
  const root = tempDir('startup-disk-budget');
  const file = (name, bytes) => {
    const filePath = path.join(root, name);
    fs.writeFileSync(filePath, Buffer.alloc(bytes));
    return filePath;
  };
  const golden = file('golden.sqlite', 1000);
  const setup = file('setup.exe', 100);
  const budget = estimateDiskBudget({
    scenarios: {
      'normal-clean-shutdown': { goldenDb: golden },
      'migration-vacuum': { goldenDb: golden },
      'crash-recovery': { goldenDb: golden, goldenWal: file('golden.sqlite-wal', 200) }
    },
    inputs: { a: setup, b: setup, c: setup, d: setup }
  });
  assert.equal(budget.normalSimultaneousCopies, 5);
  assert.equal(budget.nonNormalPeakEquivalentCopies, 4.25);
  assert.equal(budget.completedNonNormalSamplesRetained, 0);
  assert.ok(budget.requiredFreeBytes >= 4 * 1024 * 1024 * 1024);
});

test('Windows 环境证据由机器采集且 Defender exclusion 只记录命中布尔，不泄露原始路径', () => {
  const rawExclusion = 'C:\\Sensitive\\Golden';
  const evidence = captureWindowsEnvironment({ workRoot: 'C:\\Controlled\\Work', goldenPath: `${rawExclusion}\\tool-data.sqlite` }, {
    platform: 'win32',
    collect: () => ({
      hostIdSha256: 'a'.repeat(64),
      os: { caption: 'Windows Server', version: '10.0', build: '1', arch: '64-bit' },
      cpu: { model: 'CPU', logicalCores: 4 },
      memory: { totalBytes: 16_000_000_000 },
      localDisk: { driveType: 3, fileSystem: 'NTFS', sizeBytes: 100, freeBytes: 80, mediaType: 'SSD', busType: 'NVMe' },
      pathClass: 'local-fixed',
      goldenPathClass: 'local-fixed',
      powerPlan: { guid: '00000000-0000-0000-0000-000000000000' },
      defender: {
        status: 'recorded', realtimeProtectionEnabled: true,
        engineVersion: '1', productVersion: '2', signatureVersion: '3',
        workRootExcluded: false, goldenExcluded: true,
        rawExclusions: [rawExclusion]
      }
    })
  });
  assert.equal(evidence.evidenceSource, 'machine');
  assert.equal(evidence.cachePolicy.firstSampleRetained, true);
  assert.equal(evidence.cachePolicy.order, 'four-variant-rotation');
  assert.equal(JSON.stringify(evidence).includes(rawExclusion), false);
});

test('机器环境不发布 WMI/PE 自由原文，Defender 三布尔缺失不得伪造成 false', () => {
  const sensitiveCaption = 'Windows customer account 6222020202020202';
  const sensitiveCpu = 'CPU for customer account 6217000012345678';
  const evidence = captureWindowsEnvironment({ workRoot: 'C:\\Controlled', goldenPath: 'D:\\Golden\\db' }, {
    platform: 'win32',
    collect: () => ({
      hostIdSha256: 'a'.repeat(64),
      os: { caption: sensitiveCaption, version: '10.0', build: '22631', arch: '64-bit' },
      cpu: { model: sensitiveCpu, logicalCores: 8 },
      memory: { totalBytes: 16_000_000_000 },
      localDisk: {
        driveType: 3, fileSystem: 'NTFS customer account', sizeBytes: 100,
        freeBytes: 80, mediaType: 'SSD customer account', busType: 'NVMe customer account'
      },
      pathClass: 'local-fixed', goldenPathClass: 'local-fixed',
      powerPlan: { guid: '00000000-0000-0000-0000-000000000000' },
      defender: {
        status: 'recorded', engineVersion: '1', productVersion: '2', signatureVersion: '3'
      }
    })
  });
  const serialized = JSON.stringify(evidence);
  assert.equal(serialized.includes(sensitiveCaption), false);
  assert.equal(serialized.includes(sensitiveCpu), false);
  assert.equal(serialized.includes('customer account'), false);
  assert.equal(evidence.status, 'not-evaluated');
  assert.equal(evidence.defender.realtimeProtectionEnabled, null);
  assert.equal(evidence.defender.workRootExcluded, null);
  assert.equal(evidence.defender.goldenExcluded, null);
});

test('power plan GUID 仅接受 canonical UUID shape，公开前规范为 lowercase', () => {
  const collectEnvironment = (guid) => captureWindowsEnvironment({
    workRoot: 'C:\\Controlled', goldenPath: 'D:\\Golden\\db'
  }, {
    platform: 'win32',
    collect: () => ({
      hostIdSha256: 'a'.repeat(64),
      os: { caption: 'Windows', version: '10.0', build: '22631', arch: '64-bit' },
      cpu: { model: 'CPU', logicalCores: 8 },
      memory: { totalBytes: 16_000_000_000 },
      localDisk: {
        driveType: 3, fileSystem: 'NTFS', sizeBytes: 100,
        freeBytes: 80, mediaType: 'SSD', busType: 'NVMe'
      },
      pathClass: 'local-fixed', goldenPathClass: 'local-fixed',
      powerPlan: { guid },
      defender: {
        status: 'recorded', realtimeProtectionEnabled: true,
        engineVersion: '1', productVersion: '2', signatureVersion: '3',
        workRootExcluded: false, goldenExcluded: false
      }
    })
  });

  const canonical = collectEnvironment('AABBCCDD-EEFF-0011-2233-445566778899');
  assert.equal(canonical.status, 'recorded');
  assert.equal(canonical.powerPlan.guid, 'aabbccdd-eeff-0011-2233-445566778899');

  for (const invalidGuid of [
    '123456789012345678901234567890123456',
    'aabbccddeeff00112233445566778899',
    'aabbccdd-eeff-0011-2233-44556677889g'
  ]) {
    const collected = collectEnvironment(invalidGuid);
    assert.equal(collected.status, 'not-evaluated');
    assert.equal(JSON.stringify(collected).includes(invalidGuid.toLowerCase()), false);

    const environment = machineEnvironment();
    environment.powerPlan.guid = invalidGuid;
    const { digest: _oldDigest, ...body } = environment;
    environment.digest = evidenceDigest(body);
    const reports = reportSet();
    assert.throws(() => evaluateAcceptance({
      mode: 'formal', reports, goldenReceipts: receipts(reports),
      environment, artifacts: artifactEvidence(), generatedAt: '2026-08-20T08:00:00.000Z'
    }), /environment|machine|机器|环境/i);
  }

  const reports = reportSet();
  const draft = evaluateAcceptance({
    mode: 'formal', reports, goldenReceipts: receipts(reports),
    environment: machineEnvironment(), artifacts: artifactEvidence(),
    generatedAt: '2026-08-20T08:00:00.000Z'
  });
  draft.environment.powerPlan.guid = '123456789012345678901234567890123456';
  const { digest: _digest, ...environmentBody } = draft.environment;
  draft.environment.digest = evidenceDigest(environmentBody);
  assert.throws(() => assertPrivacyAllowlist(draft), /guid|privacy|environment|机器/i);
});

test('privacy allowlist 拒绝绝对路径、raw/log/userData/Documents 字段和未知顶层字段', () => {
  const minimalEnvironment = { status: 'not-evaluated', evidenceSource: 'machine' };
  const minimalReport = {
    schemaVersion: 1,
    kind: 'windows-startup-acceptance-public-report',
    mode: 'rehearsal',
    generatedAt: '2026-08-20T00:00:00.000Z',
    comparisonId: 'comparison-1',
    candidateEvidenceSha256: 'a'.repeat(64),
    releaseCandidateSha256: null,
    releaseBoundAt: null,
    environment: { ...minimalEnvironment, digest: evidenceDigest(minimalEnvironment) },
    artifacts: {},
    scenarios: {},
    manualReceipts: {},
    evaluation: { status: 'not-evaluated', formal: false, reasonCodes: [], comparisons: null },
    privacy: {
      allowlistVersion: 1, publishable: true, pathsRecorded: false,
      rawReportsIncluded: false, rawLogsIncluded: false, databaseFilesIncluded: false
    }
  };
  assert.doesNotThrow(() => assertPrivacyAllowlist(minimalReport));
  assert.doesNotThrow(() => assertPrivacyAllowlist({
    ...minimalReport,
    comparisonId: '00000000-0000-4000-8000-000000000000'
  }));
  for (const comparisonId of ['/Volumes/private/golden.sqlite', 'relative/evidence.json']) {
    assert.throws(() => assertPrivacyAllowlist({ ...minimalReport, comparisonId }), /path|隐私/i);
  }
  for (const comparisonId of ['customer account', '6222020202020202']) {
    assert.throws(() => assertPrivacyAllowlist({ ...minimalReport, comparisonId }), /privacy|敏感|账号|account/i);
  }
  assert.throws(() => assertPrivacyAllowlist({
    ...minimalReport,
    evaluation: {
      ...minimalReport.evaluation,
      comparisons: {
        installer: {
          baselineMedianMs: 100,
          currentMedianMs: 20,
          reductionPercent: 80,
          thresholdPercent: 70,
          passed: true,
          metric: 'raw-externalFullReadyMs-median',
          status: 'misplaced-but-allowlisted-key'
        },
        portable: null
      }
    }
  }), /comparison|必须且只能/i);
  assert.throws(() => assertPrivacyAllowlist({
    schemaVersion: 1,
    kind: 'windows-startup-acceptance-public-report',
    mode: 'formal',
    sourcePath: 'C:\\Users\\owner\\golden.sqlite'
  }), /allowlist|path|隐私/i);
  for (const payload of [
    { customerAccount: 'secret' },
    { amount: 100 },
    { sqlParams: ['secret'] },
    { databasePath: 'relative/tool-data.sqlite' },
    { unknownNestedKey: true }
  ]) {
    assert.throws(() => assertPrivacyAllowlist({
      schemaVersion: 1,
      kind: 'windows-startup-acceptance-public-report',
      mode: 'rehearsal',
      generatedAt: '2026-08-20T00:00:00.000Z',
      comparisonId: 'comparison-1',
      candidateEvidenceSha256: 'a'.repeat(64),
      releaseCandidateSha256: null,
      releaseBoundAt: null,
      environment: { evidenceSource: 'machine', ...payload },
      artifacts: {}, scenarios: {}, manualReceipts: {},
      evaluation: { status: 'not-evaluated', formal: false, reasonCodes: [], comparisons: null },
      privacy: {
        allowlistVersion: 1, publishable: true, pathsRecorded: false,
        rawReportsIncluded: false, rawLogsIncluded: false, databaseFilesIncluded: false
      }
    }), /allowlist|敏感|未知/i);
  }
});

test('controlled rehearsal 同一 host 串行三场景、non-normal 每样本清理且最终只留下 allowlist 报告', async () => {
  const parent = tempDir('startup-controlled-rehearsal');
  const inputRoot = path.join(parent, 'inputs');
  const workRoot = path.join(parent, 'work');
  const output = path.join(parent, 'public-report.json');
  fs.mkdirSync(inputRoot);
  const inputs = {};
  for (const version of ['3.1.11', '3.1.12']) {
    for (const kind of ['setup', 'portable']) {
      const filePath = path.join(inputRoot, `${version}-${kind}.exe`);
      fs.writeFileSync(filePath, `${version}-${kind}`);
      inputs[`${version}-${kind}`] = filePath;
    }
  }
  const golden = path.join(inputRoot, 'golden.sqlite');
  const wal = path.join(inputRoot, 'golden.sqlite-wal');
  fs.writeFileSync(golden, 'small-rehearsal-golden');
  fs.writeFileSync(wal, 'small-rehearsal-wal');
  const scenarioRuns = [];
  const cleanupCalls = [];
  const result = await runControlledAcceptance({
    schemaVersion: 1,
    mode: 'rehearsal',
    workRoot,
    output,
    runs: 5,
    inputs,
    scenarios: {
      'normal-clean-shutdown': { goldenDb: golden },
      'migration-vacuum': { goldenDb: golden },
      'crash-recovery': { goldenDb: golden, goldenWal: wal, walSentinel: 'sentinel=value' }
    }
  }, {
    platform: 'win32',
    readFileVersion: (filePath) => filePath.includes('3.1.11') ? '3.1.11.0' : '3.1.12.0',
    runInstaller: (setupPath, _args, installRoot) => {
      fs.mkdirSync(installRoot, { recursive: true });
      fs.writeFileSync(path.join(installRoot, '清结算小助手.exe'), path.basename(setupPath));
      fs.writeFileSync(path.join(installRoot, 'Uninstall 清结算小助手.exe'), 'uninstall');
    },
    runUninstaller: (_uninstaller, _args, installRoot) => fs.rmSync(installRoot, { recursive: true }),
    collect: () => ({
      hostIdSha256: 'a'.repeat(64),
      os: { caption: 'Windows', version: '10', build: '1', arch: '64-bit' },
      cpu: { model: 'CPU', logicalCores: 4 },
      memory: { totalBytes: 16_000_000_000 },
      localDisk: { driveType: 3, fileSystem: 'NTFS', sizeBytes: 1e12, freeBytes: 9e11, mediaType: 'SSD', busType: 'NVMe' },
      pathClass: 'local-fixed',
      goldenPathClass: 'local-fixed',
      powerPlan: { guid: '00000000-0000-0000-0000-000000000000' },
      defender: { status: 'recorded', realtimeProtectionEnabled: true, engineVersion: '1', productVersion: '2', signatureVersion: '3' }
    }),
    runPackagedMeasurement: async (args, runnerDependencies) => {
      const scenario = args[args.indexOf('--scenario') + 1];
      const scenarioRoot = args[args.indexOf('--work-root') + 1];
      scenarioRuns.push(scenario);
      if (scenario !== 'normal-clean-shutdown') {
        for (const label of ['3.1.11-installer', '3.1.11-portable', '3.1.12-installer', '3.1.12-portable']) {
          const sampleRoot = path.join(scenarioRoot, label, 'samples', '01');
          fs.mkdirSync(sampleRoot, { recursive: true });
          fs.writeFileSync(path.join(sampleRoot, 'tool-data.sqlite'), 'copy');
          const receipt = runnerDependencies.afterSampleCleanup({
            label, round: 1, sampleRoot, status: 'success', cleanupVerified: true
          });
          cleanupCalls.push({ scenario, label, round: 1, receipt });
        }
      }
      return reportSet()[scenario].report;
    }
  });
  assert.deepEqual(scenarioRuns, ['normal-clean-shutdown', 'migration-vacuum', 'crash-recovery']);
  assert.equal(cleanupCalls.length, 8);
  assert.equal(cleanupCalls.every(({ receipt }) => receipt.verifiedAbsent), true);
  assert.equal(cleanupCalls.every(({ scenario, label, round, receipt }) => (
    receipt.targetIdentitySha256 === cleanupTargetIdentity(result.comparisonId, scenario, label, round)
  )), true);
  assert.equal(result.evaluation.status, 'not-evaluated');
  assert.ok(result.evaluation.reasonCodes.includes('REHEARSAL_NEVER_FORMAL'));
  assert.equal(fs.existsSync(workRoot), false);
  assert.equal(fs.existsSync(golden), true);
  const persisted = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.equal(persisted.privacy.rawReportsIncluded, false);
  assert.equal(JSON.stringify(persisted).includes(parent), false);
});

test('controlled orchestration 在任何写入前拒绝不完整场景、非精确 inputs 与 workRoot 内 receipt', async () => {
  const parent = tempDir('startup-controlled-preflight');
  const inputRoot = path.join(parent, 'inputs');
  const workRoot = path.join(parent, 'work');
  fs.mkdirSync(inputRoot);
  const file = (name) => {
    const filePath = path.join(inputRoot, name);
    fs.writeFileSync(filePath, name);
    return filePath;
  };
  const inputs = {
    '3.1.11-setup': file('3.1.11-setup.exe'),
    '3.1.11-portable': file('3.1.11-portable.exe'),
    '3.1.12-setup': file('3.1.12-setup.exe'),
    '3.1.12-portable': file('3.1.12-portable.exe')
  };
  const golden = file('golden.sqlite');
  const base = {
    schemaVersion: 1,
    mode: 'formal',
    workRoot,
    output: path.join(parent, 'report.json'),
    inputs,
    scenarios: {
      'normal-clean-shutdown': { goldenDb: golden },
      'migration-vacuum': { goldenDb: golden },
      'crash-recovery': { goldenDb: golden, goldenWal: file('golden.sqlite-wal'), walSentinel: 'sentinel=value' }
    }
  };
  const dependencies = { platform: 'win32' };

  const missingScenario = structuredClone(base);
  delete missingScenario.scenarios['migration-vacuum'];
  await assert.rejects(() => runControlledAcceptance(missingScenario, dependencies), /场景|scenario/i);
  assert.equal(fs.existsSync(workRoot), false);

  const extraInput = structuredClone(base);
  extraInput.inputs.extra = file('extra.exe');
  await assert.rejects(() => runControlledAcceptance(extraInput, dependencies), /inputs|制品/i);
  assert.equal(fs.existsSync(workRoot), false);

  const receiptInsideWork = structuredClone(base);
  receiptInsideWork.scenarios['normal-clean-shutdown'].manualReceipt = path.join(workRoot, 'receipt.json');
  await assert.rejects(() => runControlledAcceptance(receiptInsideWork, dependencies), /receipt|workRoot/i);
  assert.equal(fs.existsSync(workRoot), false);

  const formalFive = structuredClone(base);
  formalFive.runs = 5;
  await assert.rejects(() => runControlledAcceptance(formalFive, dependencies), /formal.*8|8.*formal/i);
  assert.equal(fs.existsSync(workRoot), false);
});

test('formal 在创建 workRoot/安装/runner 前强制校验三份 golden manual receipt 与 source bundle', async (t) => {
  const runCase = async (name, mutate) => {
    const parent = tempDir(`startup-formal-receipt-preflight-${name}`);
    const inputRoot = path.join(parent, 'inputs');
    const workRoot = path.join(parent, 'work');
    fs.mkdirSync(inputRoot);
    const file = (filename, contents = filename) => {
      const filePath = path.join(inputRoot, filename);
      fs.writeFileSync(filePath, contents);
      return filePath;
    };
    const inputs = {
      '3.1.11-setup': file('3.1.11-setup.exe'),
      '3.1.11-portable': file('3.1.11-portable.exe'),
      '3.1.12-setup': file('3.1.12-setup.exe'),
      '3.1.12-portable': file('3.1.12-portable.exe')
    };
    const golden = file('golden.sqlite', 'controlled-anonymized-golden');
    const wal = file('golden.sqlite-wal', 'controlled-recovery-wal');
    const scenarios = {
      'normal-clean-shutdown': { goldenDb: golden },
      'migration-vacuum': { goldenDb: golden },
      'crash-recovery': { goldenDb: golden, goldenWal: wal, walSentinel: 'sentinel=value' }
    };
    for (const [scenario, value] of Object.entries(scenarios)) {
      const receipt = {
        schemaVersion: 1,
        kind: 'windows-startup-golden-manual-receipt',
        evidenceSource: 'manual',
        scenario,
        goldenSha256: sha256Bytes(fs.readFileSync(value.goldenDb)),
        goldenWalSha256: value.goldenWal ? sha256Bytes(fs.readFileSync(value.goldenWal)) : null,
        goldenShmSha256: null,
        goldenSizeBytes: fs.statSync(value.goldenDb).size,
        goldenWalSizeBytes: value.goldenWal ? fs.statSync(value.goldenWal).size : 0,
        goldenShmSizeBytes: 0,
        sourceClass: 'controlled-windows-local-mounted-anonymized-copy',
        anonymizationConfirmed: true,
        representativenessConfirmed: true,
        dataOwnerConfirmed: true,
        signer: { id: 'owner-1', role: 'data-owner' },
        signedAt: '2026-08-20T07:00:00.000Z'
      };
      const receiptPath = file(`${scenario}-receipt.json`, `${JSON.stringify(receipt)}\n`);
      value.manualReceipt = receiptPath;
    }
    const config = {
      schemaVersion: 1, mode: 'formal', runs: 8, workRoot,
      output: path.join(parent, 'report.json'), inputs, scenarios
    };
    mutate(config);
    let installs = 0;
    let runners = 0;
    await assert.rejects(() => runControlledAcceptance(config, {
      platform: 'win32',
      now: () => '2026-08-20T08:00:00.000Z',
      readFileVersion: (filePath) => filePath.includes('3.1.11') ? '3.1.11.0' : '3.1.12.0',
      collect: () => ({
        hostIdSha256: 'a'.repeat(64),
        os: { caption: 'Windows', version: '10.0', build: '22631', arch: '64-bit' },
        cpu: { model: 'CPU', logicalCores: 8 },
        memory: { totalBytes: 16_000_000_000 },
        localDisk: {
          driveType: 3, fileSystem: 'NTFS', sizeBytes: 1e12,
          freeBytes: 9e11, mediaType: 'SSD', busType: 'NVMe'
        },
        pathClass: 'local-fixed', goldenPathClass: 'local-fixed',
        powerPlan: { guid: '00000000-0000-0000-0000-000000000000' },
        defender: {
          status: 'recorded', realtimeProtectionEnabled: true,
          engineVersion: '1', productVersion: '2', signatureVersion: '3',
          workRootExcluded: false, goldenExcluded: false
        }
      }),
      runInstaller: () => { installs += 1; throw new Error('installer must not run'); },
      runPackagedMeasurement: async () => { runners += 1; throw new Error('runner must not run'); }
    }), /golden|receipt|manual|回执/i);
    assert.equal(installs, 0);
    assert.equal(runners, 0);
    assert.equal(fs.existsSync(workRoot), false);
  };

  await t.test('missing receipt', () => runCase('missing', (config) => {
    delete config.scenarios['migration-vacuum'].manualReceipt;
  }));
  await t.test('source hash mismatch', () => runCase('hash', (config) => {
    const receiptPath = config.scenarios['crash-recovery'].manualReceipt;
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    receipt.goldenWalSha256 = 'f'.repeat(64);
    fs.writeFileSync(receiptPath, `${JSON.stringify(receipt)}\n`);
  }));
  await t.test('invalid signer and extra schema key', () => runCase('schema', (config) => {
    const receiptPath = config.scenarios['normal-clean-shutdown'].manualReceipt;
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    receipt.signer.role = 'free-form';
    receipt.rawNote = 'trusted';
    fs.writeFileSync(receiptPath, `${JSON.stringify(receipt)}\n`);
  }));
  await t.test('tiny exact matching golden', () => runCase('tiny', () => {}));
});

test('output exact/symlink/hardlink alias 在任何安装或 runner mutation 前拒绝且源身份不变', async (t) => {
  const parent = tempDir('startup-output-protection');
  const inputs = {};
  for (const version of ['3.1.11', '3.1.12']) {
    for (const kind of ['setup', 'portable']) {
      const filePath = path.join(parent, `${version}-${kind}.exe`);
      fs.writeFileSync(filePath, `${version}-${kind}`);
      inputs[`${version}-${kind}`] = filePath;
    }
  }
  const golden = path.join(parent, 'golden.sqlite');
  const wal = `${golden}-wal`;
  fs.writeFileSync(golden, 'protected-golden');
  fs.writeFileSync(wal, 'protected-wal');
  const original = fs.readFileSync(golden);
  const base = {
    schemaVersion: 1, mode: 'rehearsal', workRoot: path.join(parent, 'work'), runs: 5, inputs,
    scenarios: {
      'normal-clean-shutdown': { goldenDb: golden },
      'migration-vacuum': { goldenDb: golden },
      'crash-recovery': { goldenDb: golden, goldenWal: wal, walSentinel: 'sentinel=value' }
    }
  };
  let mutations = 0;
  const dependencies = { platform: 'win32', collect: () => { mutations += 1; throw new Error('must not run'); } };
  for (const output of [golden, path.join(parent, 'hardlink-report.json'), path.join(parent, 'symlink-report.json')]) {
    if (output.includes('hardlink')) fs.linkSync(golden, output);
    if (output.includes('symlink')) {
      try { fs.symlinkSync(golden, output); } catch (error) {
        if (process.platform === 'win32') { t.diagnostic(`symlink unavailable: ${error.code}`); continue; }
        throw error;
      }
    }
    await assert.rejects(() => runControlledAcceptance({ ...base, output }, dependencies), /output|覆盖|alias|exist/i);
    assert.deepEqual(fs.readFileSync(golden), original);
    assert.equal(fs.existsSync(base.workRoot), false);
  }
  assert.equal(mutations, 0);
});
