'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  JOURNAL_INDEX_NAME,
  ToolboxPublicationCrashError,
  ToolboxPublicationManualRecoveryError,
  disposeToolboxGeneration,
  prepareToolboxPublication,
  publishPreparedToolboxPublication,
  recoverPendingToolboxPublications
} = require('../../src/main-process/toolbox-output-publication');
const {
  normalizeFilePlanV1
} = require('../../src/main-process/archive-center/file-plan');

const tmpDirs = [];
const BATCH_CONTEXT = Object.freeze({
  batchId: 91,
  batchNumber: '2026-08-12-001',
  taskRunId: 'toolbox-publication-91',
  taskKey: 'toolbox:merge',
  moduleId: 'toolbox',
  parentRunId: 'toolbox-parent-91',
  operationKey: 'toolbox:merge:toolbox-publication-91'
});

test.after(() => {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_error) { /* ignore */ }
  }
});

function makeContext() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'toolbox-publication-'));
  tmpDirs.push(root);
  const userDataDir = path.join(root, 'user-data');
  const outputDir = path.join(root, 'outputs');
  const generationDir = path.join(root, 'generation');
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.mkdirSync(outputDir, { recursive: true });
  fs.mkdirSync(generationDir, { recursive: true });
  return { root, userDataDir, outputDir, generationDir };
}

function writeFile(filePath, content) {
  fs.writeFileSync(filePath, content);
  return filePath;
}

function statWithIdentity(stat, dev, ino) {
  return {
    ...stat,
    dev,
    ino,
    isFile: () => stat.isFile()
  };
}

function validatedArtifact(sourcePath, metadata = {}) {
  const content = fs.readFileSync(sourcePath);
  return {
    sourcePath,
    byteSize: content.length,
    sha256: crypto.createHash('sha256').update(content).digest('hex'),
    ...metadata
  };
}

function indexValue(ctx) {
  const indexPath = path.join(ctx.userDataDir, JOURNAL_INDEX_NAME);
  return JSON.parse(fs.readFileSync(indexPath, 'utf8'));
}

function taskFiles(ctx) {
  return fs.readdirSync(ctx.outputDir)
    .filter((name) => name.startsWith('.toolbox-publish-'))
    .sort();
}

function recoverInFreshProcess(userDataDir, options = {}) {
  const modulePath = require.resolve('../../src/main-process/toolbox-output-publication');
  const recoveryOptions = { ...options, userDataDir };
  const script = [
    `const publication = require(${JSON.stringify(modulePath)});`,
    `const result = publication.recoverPendingToolboxPublications(${JSON.stringify(recoveryOptions)});`,
    'process.stdout.write(JSON.stringify(result));'
  ].join('');
  const child = spawnSync(process.execPath, ['-e', script], {
    cwd: path.resolve(__dirname, '../..'),
    encoding: 'utf8'
  });
  assert.equal(child.status, 0, child.stderr || child.stdout);
  return JSON.parse(child.stdout);
}

function targetParentIdentityFor(targetPath) {
  return normalizeFilePlanV1({
    version: 1,
    allocation: 'eager',
    inputs: [],
    outputs: [{
      filePath: targetPath,
      role: 'publisher-output',
      sourceOperation: 'new-account:save-as'
    }]
  }).outputs[0].targetParentIdentity;
}

function replaceParentDirectory(parentPath, suffix = 'moved') {
  const movedPath = `${parentPath}.${suffix}`;
  fs.renameSync(parentPath, movedPath);
  fs.mkdirSync(parentPath);
  return movedPath;
}

function publicationStateFilesUnder(rootPath) {
  if (!fs.existsSync(rootPath)) return [];
  const found = [];
  const visit = (directoryPath) => {
    for (const entry of fs.readdirSync(directoryPath, { withFileTypes: true })) {
      const entryPath = path.join(directoryPath, entry.name);
      if (entry.name === JOURNAL_INDEX_NAME || entry.name.startsWith('.toolbox-publish-')) {
        found.push(path.relative(rootPath, entryPath));
      }
      if (entry.isDirectory()) visit(entryPath);
    }
  };
  visit(rootPath);
  return found.sort();
}

function assertRecoveryRootConflict(callback) {
  assert.throws(callback, (error) => {
    assert.equal(
      error && error.code,
      'TOOLBOX_PUBLICATION_RECOVERY_ROOT_TARGET_PARENT_CONFLICT'
    );
    assert.match(String(error && error.message), /恢复根目录.*目标父目录|目标父目录.*恢复根目录/);
    return true;
  });
}

test.describe('toolbox output publication', () => {
  for (const scenario of [
    {
      name: 'required target parent等于fixed recovery root',
      targetDirectory(ctx) {
        return ctx.userDataDir;
      }
    },
    {
      name: 'required target parent位于fixed recovery root内部',
      targetDirectory(ctx) {
        const targetDirectory = path.join(ctx.userDataDir, 'guarded-output');
        fs.mkdirSync(targetDirectory);
        return targetDirectory;
      }
    },
    {
      name: 'required target parent是fixed recovery root祖先',
      targetDirectory(ctx) {
        return ctx.root;
      }
    }
  ]) {
    test(`${scenario.name}时在journal/index/target写入前稳定拒绝`, () => {
      const ctx = makeContext();
      const source = writeFile(path.join(ctx.generationDir, 'source.xlsx'), 'generated');
      const targetDirectory = scenario.targetDirectory(ctx);
      const target = path.join(targetDirectory, 'target.xlsx');
      const expectedTargetParentIdentity = targetParentIdentityFor(target);
      assert.deepEqual(publicationStateFilesUnder(ctx.root), []);

      assertRecoveryRootConflict(() => prepareToolboxPublication({
        taskId: `recovery-root-conflict-${scenario.name}`,
        artifacts: [validatedArtifact(source)],
        targets: [{ targetPath: target, expectedTargetParentIdentity }],
        userDataDir: ctx.userDataDir,
        requireValidatedArtifacts: true,
        requireTargetParentIdentity: true
      }));

      assert.equal(fs.existsSync(target), false);
      assert.deepEqual(publicationStateFilesUnder(ctx.root), []);
      assert.equal(fs.readFileSync(source, 'utf8'), 'generated');
    });
  }

  test('multi-target任一required parent与recovery root冲突时全批Publisher=0', () => {
    const ctx = makeContext();
    const nestedUserDataOutput = path.join(ctx.userDataDir, 'guarded-output');
    fs.mkdirSync(nestedUserDataOutput);
    const sourceA = writeFile(path.join(ctx.generationDir, 'a.xlsx'), 'generated-a');
    const sourceB = writeFile(path.join(ctx.generationDir, 'b.xlsx'), 'generated-b');
    const targetA = path.join(ctx.outputDir, 'a.xlsx');
    const targetB = path.join(nestedUserDataOutput, 'b.xlsx');

    assertRecoveryRootConflict(() => prepareToolboxPublication({
      taskId: 'recovery-root-conflict-multi-target',
      artifacts: [validatedArtifact(sourceA), validatedArtifact(sourceB)],
      targets: [targetA, targetB].map((targetPath) => ({
        targetPath,
        expectedTargetParentIdentity: targetParentIdentityFor(targetPath)
      })),
      userDataDir: ctx.userDataDir,
      requireValidatedArtifacts: true,
      requireTargetParentIdentity: true
    }));

    assert.equal(fs.existsSync(targetA), false);
    assert.equal(fs.existsSync(targetB), false);
    assert.deepEqual(publicationStateFilesUnder(ctx.root), []);
    assert.equal(fs.readFileSync(sourceA, 'utf8'), 'generated-a');
    assert.equal(fs.readFileSync(sourceB, 'utf8'), 'generated-b');
  });

  for (const scenario of [
    {
      name: 'fixed recovery root的普通sibling',
      makeTargetDirectory(ctx) {
        return ctx.outputDir;
      }
    },
    {
      name: 'fixed recovery root之外的独立目录',
      makeTargetDirectory() {
        const directoryPath = fs.mkdtempSync(path.join(os.tmpdir(), 'toolbox-external-output-'));
        tmpDirs.push(directoryPath);
        return directoryPath;
      }
    }
  ]) {
    test(`${scenario.name}仍可正常guarded publication`, () => {
      const ctx = makeContext();
      const source = writeFile(path.join(ctx.generationDir, 'source.xlsx'), 'generated');
      const target = path.join(scenario.makeTargetDirectory(ctx), 'target.xlsx');
      const prepared = prepareToolboxPublication({
        taskId: `recovery-root-non-conflict-${scenario.name}`,
        artifacts: [validatedArtifact(source)],
        targets: [{
          targetPath: target,
          expectedTargetParentIdentity: targetParentIdentityFor(target)
        }],
        userDataDir: ctx.userDataDir,
        requireValidatedArtifacts: true,
        requireTargetParentIdentity: true
      });

      const result = publishPreparedToolboxPublication(prepared);
      assert.equal(result.committed, true);
      assert.equal(fs.readFileSync(target, 'utf8'), 'generated');
      assert.deepEqual(indexValue(ctx).entries, []);
    });
  }

  test('guarded committed-before-settle由fresh recovery唯一接管且不二次发布', () => {
    const ctx = makeContext();
    const source = writeFile(path.join(ctx.generationDir, 'source.xlsx'), 'generated');
    const target = path.join(ctx.outputDir, 'target.xlsx');
    const taskId = 'guarded-commit-before-settle-restart';
    const prepared = prepareToolboxPublication({
      taskId,
      artifacts: [validatedArtifact(source)],
      targets: [{
        targetPath: target,
        expectedTargetParentIdentity: targetParentIdentityFor(target)
      }],
      userDataDir: ctx.userDataDir,
      batchContext: BATCH_CONTEXT,
      requireValidatedArtifacts: true,
      requireTargetParentIdentity: true,
      requireArchiveHandoff: true,
      allowEmptyArchiveInputs: true
    });
    const published = publishPreparedToolboxPublication(prepared);
    assert.equal(published.committed, true);
    assert.equal(published.pendingArchiveHandoff, true);
    const committedIdentity = fs.statSync(target, { bigint: true });
    assert.equal(indexValue(ctx).entries.length, 1);

    const deferred = recoverInFreshProcess(ctx.userDataDir, {
      deferCommittedRecovery: true
    });
    assert.deepEqual(deferred.recovered.map((item) => item.action), [
      'commit-handoff-pending'
    ]);
    assert.equal(indexValue(ctx).entries.length, 1);
    assert.equal(fs.readFileSync(target, 'utf8'), 'generated');

    const acknowledged = recoverInFreshProcess(ctx.userDataDir, {
      deferCommittedRecovery: true,
      acknowledgedCommittedTaskIds: [taskId]
    });
    assert.deepEqual(acknowledged.recovered.map((item) => item.action), ['commit-cleanup']);
    const settledIdentity = fs.statSync(target, { bigint: true });
    assert.equal(settledIdentity.dev, committedIdentity.dev);
    assert.equal(settledIdentity.ino, committedIdentity.ino);
    assert.equal(fs.readFileSync(target, 'utf8'), 'generated');
    assert.deepEqual(indexValue(ctx).entries, []);
    assert.deepEqual(taskFiles(ctx), []);
  });

  test('required direct-parent evidence在preflight前已漂移时不创建journal或target', () => {
    const ctx = makeContext();
    const source = writeFile(path.join(ctx.generationDir, 'source.xlsx'), 'generated');
    const target = path.join(ctx.outputDir, 'target.xlsx');
    const expectedTargetParentIdentity = targetParentIdentityFor(target);
    replaceParentDirectory(ctx.outputDir, 'preflight-moved');

    assert.throws(
      () => prepareToolboxPublication({
        taskId: 'parent-changed-before-preflight',
        artifacts: [validatedArtifact(source)],
        targets: [{ targetPath: target, expectedTargetParentIdentity }],
        userDataDir: ctx.userDataDir,
        requireValidatedArtifacts: true,
        requireTargetParentIdentity: true
      }),
      (error) => error && error.code === 'TOOLBOX_PUBLICATION_TARGET_PARENT_CHANGED'
    );
    assert.equal(fs.existsSync(target), false);
    assert.deepEqual(taskFiles(ctx), []);
  });

  for (const checkpointName of [
    'prepare:before-generation-inspect',
    'prepare:after-staged',
    'publish:before-target-mutation',
    'publish:before-publish',
    'publish:after-final-target-verify-before-commit'
  ]) {
    test(`direct parent在${checkpointName}被ordinary replacement后绝不发布`, () => {
      const ctx = makeContext();
      const source = writeFile(path.join(ctx.generationDir, 'source.xlsx'), 'generated');
      const target = path.join(ctx.outputDir, 'target.xlsx');
      const expectedTargetParentIdentity = targetParentIdentityFor(target);
      let replaced = false;
      const options = {
        taskId: `parent-changed-${checkpointName.replace(/[^a-z]+/g, '-')}`,
        artifacts: [validatedArtifact(source)],
        targets: [{ targetPath: target, expectedTargetParentIdentity }],
        userDataDir: ctx.userDataDir,
        requireValidatedArtifacts: true,
        requireTargetParentIdentity: true,
        checkpoint(name) {
          if (!replaced && name === checkpointName) {
            replaced = true;
            replaceParentDirectory(ctx.outputDir, checkpointName.replace(/[^a-z]+/g, '-'));
          }
        }
      };
      if (checkpointName.startsWith('prepare:')) {
        assert.throws(
          () => prepareToolboxPublication(options),
          (error) => error && [
            'TOOLBOX_PUBLICATION_TARGET_PARENT_CHANGED',
            'TOOLBOX_PUBLICATION_MANUAL_RECOVERY'
          ].includes(error.code)
        );
      } else {
        const prepared = prepareToolboxPublication(options);
        assert.throws(
          () => publishPreparedToolboxPublication(prepared),
          (error) => error && error.code === 'TOOLBOX_PUBLICATION_MANUAL_RECOVERY'
        );
      }
      assert.equal(replaced, true);
      assert.equal(fs.existsSync(target), false);
      if (checkpointName === 'prepare:after-staged') {
        assert.throws(
          () => recoverPendingToolboxPublications({ userDataDir: ctx.userDataDir }),
          (error) => error && error.code === 'TOOLBOX_PUBLICATION_MANUAL_RECOVERY'
        );
        assert.equal(indexValue(ctx).entries.length, 1);
      }
    });
  }

  test('每个existing target backup rename紧前复核direct parent identity', () => {
    const ctx = makeContext();
    const source = writeFile(path.join(ctx.generationDir, 'source.xlsx'), 'generated');
    const target = writeFile(path.join(ctx.outputDir, 'target.xlsx'), 'original');
    const expectedTargetParentIdentity = targetParentIdentityFor(target);
    let movedPath = null;
    const prepared = prepareToolboxPublication({
      taskId: 'parent-changed-before-backup',
      artifacts: [validatedArtifact(source)],
      targets: [{ targetPath: target, expectedTargetParentIdentity }],
      userDataDir: ctx.userDataDir,
      requireValidatedArtifacts: true,
      requireTargetParentIdentity: true,
      checkpoint(name) {
        if (!movedPath && name === 'publish:before-backup') {
          movedPath = replaceParentDirectory(ctx.outputDir, 'before-backup-moved');
        }
      }
    });
    assert.throws(
      () => publishPreparedToolboxPublication(prepared),
      (error) => error && error.code === 'TOOLBOX_PUBLICATION_MANUAL_RECOVERY'
    );
    assert.equal(fs.existsSync(target), false);
    assert.equal(fs.readFileSync(path.join(movedPath, 'target.xlsx'), 'utf8'), 'original');
  });

  test('prepare返回后、publish读journal前parent replacement仍由index evidence进入Hold', () => {
    const ctx = makeContext();
    const source = writeFile(path.join(ctx.generationDir, 'source.xlsx'), 'generated');
    const target = path.join(ctx.outputDir, 'target.xlsx');
    const expectedTargetParentIdentity = targetParentIdentityFor(target);
    const prepared = prepareToolboxPublication({
      taskId: 'parent-changed-before-publish-journal-read',
      artifacts: [validatedArtifact(source)],
      targets: [{ targetPath: target, expectedTargetParentIdentity }],
      userDataDir: ctx.userDataDir,
      requireValidatedArtifacts: true,
      requireTargetParentIdentity: true
    });
    replaceParentDirectory(ctx.outputDir, 'before-publish-journal-read');

    assert.throws(
      () => publishPreparedToolboxPublication(prepared),
      (error) => error && error.code === 'TOOLBOX_PUBLICATION_MANUAL_RECOVERY'
    );
    assert.throws(
      () => recoverPendingToolboxPublications({ userDataDir: ctx.userDataDir }),
      (error) => error && error.code === 'TOOLBOX_PUBLICATION_MANUAL_RECOVERY'
    );
    assert.equal(indexValue(ctx).entries.length, 1);
    assert.equal(fs.existsSync(target), false);
  });

  test('journal持久exact parent identity；恢复漂移进入manual且旧journal仍兼容', () => {
    const guarded = makeContext();
    const guardedSource = writeFile(
      path.join(guarded.generationDir, 'source.xlsx'),
      'generated'
    );
    const guardedTarget = path.join(guarded.outputDir, 'target.xlsx');
    const expectedTargetParentIdentity = targetParentIdentityFor(guardedTarget);
    assert.throws(() => prepareToolboxPublication({
      taskId: 'parent-identity-recovery-guard',
      artifacts: [validatedArtifact(guardedSource)],
      targets: [{ targetPath: guardedTarget, expectedTargetParentIdentity }],
      userDataDir: guarded.userDataDir,
      requireValidatedArtifacts: true,
      requireTargetParentIdentity: true,
      checkpoint(name) {
        if (name === 'prepare:after-index') throw new ToolboxPublicationCrashError(name);
      }
    }), ToolboxPublicationCrashError);
    const guardedJournalPath = indexValue(guarded).entries[0].journalAbsolutePath;
    const journal = JSON.parse(fs.readFileSync(guardedJournalPath, 'utf8'));
    assert.deepEqual(
      journal.entries[0].expectedTargetParentIdentity,
      expectedTargetParentIdentity
    );
    const moved = replaceParentDirectory(guarded.outputDir, 'recovery-moved');
    for (const name of fs.readdirSync(moved).filter((item) => item.startsWith('.toolbox-publish-'))) {
      fs.copyFileSync(path.join(moved, name), path.join(guarded.outputDir, name));
    }
    assert.throws(
      () => recoverPendingToolboxPublications({ userDataDir: guarded.userDataDir }),
      (error) => error && error.code === 'TOOLBOX_PUBLICATION_MANUAL_RECOVERY'
    );
    assert.equal(fs.existsSync(guardedTarget), false);
    assert.equal(indexValue(guarded).entries.length, 1);

    const legacy = makeContext();
    const legacySource = writeFile(path.join(legacy.generationDir, 'source.xlsx'), 'generated');
    const legacyTarget = path.join(legacy.outputDir, 'target.xlsx');
    assert.throws(() => prepareToolboxPublication({
      taskId: 'old-journal-without-parent-identity',
      artifacts: [validatedArtifact(legacySource)],
      targets: [{ targetPath: legacyTarget }],
      userDataDir: legacy.userDataDir,
      requireValidatedArtifacts: true,
      checkpoint(name) {
        if (name === 'prepare:after-index') throw new ToolboxPublicationCrashError(name);
      }
    }), ToolboxPublicationCrashError);
    const legacyJournalPath = indexValue(legacy).entries[0].journalAbsolutePath;
    const legacyJournal = JSON.parse(fs.readFileSync(legacyJournalPath, 'utf8'));
    assert.equal(Object.hasOwn(legacyJournal.entries[0], 'expectedTargetParentIdentity'), false);
    const recovered = recoverPendingToolboxPublications({ userDataDir: legacy.userDataDir });
    assert.deepEqual(recovered.recovered.map((item) => item.action), ['cancelled-prepared']);
    assert.equal(fs.existsSync(legacyTarget), false);
  });

  test('direct parent原对象移走再移回后prepared recovery合法', () => {
    const ctx = makeContext();
    const source = writeFile(path.join(ctx.generationDir, 'source.xlsx'), 'generated');
    const target = path.join(ctx.outputDir, 'target.xlsx');
    const expectedTargetParentIdentity = targetParentIdentityFor(target);
    assert.throws(() => prepareToolboxPublication({
      taskId: 'parent-object-restored',
      artifacts: [validatedArtifact(source)],
      targets: [{ targetPath: target, expectedTargetParentIdentity }],
      userDataDir: ctx.userDataDir,
      requireValidatedArtifacts: true,
      requireTargetParentIdentity: true,
      checkpoint(name) {
        if (name === 'prepare:after-index') throw new ToolboxPublicationCrashError(name);
      }
    }), ToolboxPublicationCrashError);
    const moved = replaceParentDirectory(ctx.outputDir, 'temporarily-moved');
    fs.rmdirSync(ctx.outputDir);
    fs.renameSync(moved, ctx.outputDir);
    const recovered = recoverPendingToolboxPublications({ userDataDir: ctx.userDataDir });
    assert.deepEqual(recovered.recovered.map((item) => item.action), ['cancelled-prepared']);
    assert.equal(fs.existsSync(target), false);
  });

  test('journal parent identity被删改时index anchor阻断恢复且不触碰target', () => {
    const ctx = makeContext();
    const source = writeFile(path.join(ctx.generationDir, 'source.xlsx'), 'generated');
    const target = path.join(ctx.outputDir, 'target.xlsx');
    const expectedTargetParentIdentity = targetParentIdentityFor(target);
    assert.throws(() => prepareToolboxPublication({
      taskId: 'tampered-parent-identity-journal',
      artifacts: [validatedArtifact(source)],
      targets: [{ targetPath: target, expectedTargetParentIdentity }],
      userDataDir: ctx.userDataDir,
      requireValidatedArtifacts: true,
      requireTargetParentIdentity: true,
      checkpoint(name) {
        if (name === 'prepare:after-index') throw new ToolboxPublicationCrashError(name);
      }
    }), ToolboxPublicationCrashError);
    const journalPath = indexValue(ctx).entries[0].journalAbsolutePath;
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
    delete journal.entries[0].expectedTargetParentIdentity;
    delete journal.targetParentIdentityRequired;
    fs.writeFileSync(journalPath, JSON.stringify(journal));

    assert.throws(
      () => recoverPendingToolboxPublications({ userDataDir: ctx.userDataDir }),
      (error) => error && error.code === 'TOOLBOX_PUBLICATION_MANUAL_RECOVERY'
    );
    assert.equal(fs.existsSync(target), false);
    assert.equal(indexValue(ctx).entries.length, 1);
    assert.ok(fs.existsSync(journalPath));
  });

  test('输出目标别名输入源时在任何正式覆盖前 fail-closed', () => {
    const ctx = makeContext();
    const source = writeFile(path.join(ctx.outputDir, 'source.xlsx'), 'source');
    const generated = writeFile(path.join(ctx.generationDir, 'result.xlsx'), 'result');
    const sourceLink = path.join(ctx.outputDir, 'source-link.xlsx');
    fs.symlinkSync(source, sourceLink);

    assert.throws(
      () => prepareToolboxPublication({
        taskId: 'target-aliases-source',
        artifacts: [validatedArtifact(generated)],
        targets: [{ targetPath: source }],
        protectedSourcePaths: [sourceLink],
        batchContext: BATCH_CONTEXT,
        userDataDir: ctx.userDataDir,
        requireValidatedArtifacts: true
      }),
      (error) => error && error.code === 'TOOLBOX_PUBLICATION_TARGET_ALIASES_SOURCE'
    );
    assert.equal(fs.readFileSync(source, 'utf8'), 'source');
    assert.deepEqual(taskFiles(ctx), []);
  });

  test('覆盖确认后的 absent→created 与 existing→changed 均在 publication 快照前拒绝', () => {
    for (const initiallyExists of [false, true]) {
      const ctx = makeContext();
      const source = writeFile(path.join(ctx.generationDir, 'source.xlsx'), 'generated');
      const target = path.join(ctx.outputDir, 'target.xlsx');
      let expectedTargetSnapshot = { exists: false };
      if (initiallyExists) {
        fs.writeFileSync(target, 'confirmed');
        const stat = fs.lstatSync(target);
        expectedTargetSnapshot = {
          exists: true,
          snapshot: {
            sizeBytes: stat.size,
            mtimeMs: stat.mtimeMs,
            ctimeMs: stat.ctimeMs,
            ino: stat.ino
          }
        };
        fs.appendFileSync(target, '-changed');
      } else {
        fs.writeFileSync(target, 'created-after-confirmation');
      }

      assert.throws(
        () => prepareToolboxPublication({
          taskId: `target-changed-${initiallyExists}`,
          artifacts: [validatedArtifact(source)],
          targets: [{ targetPath: target, expectedTargetSnapshot }],
          batchContext: BATCH_CONTEXT,
          userDataDir: ctx.userDataDir,
          requireValidatedArtifacts: true
        }),
        (error) => (
          error && error.code === 'TOOLBOX_PUBLICATION_TARGET_CHANGED_SINCE_CONFIRMATION'
        )
      );
      assert.deepEqual(taskFiles(ctx), []);
    }
  });

  test('staging 文件使用 Windows 可执行 fsync 的可写句柄', () => {
    const ctx = makeContext();
    const source = writeFile(path.join(ctx.generationDir, 'source.xlsx'), 'generated');
    const target = path.join(ctx.outputDir, 'target.xlsx');
    const fsImpl = Object.create(fs);
    const stagedFdModes = new Map();
    const syncedStageModes = [];

    fsImpl.openSync = (filePath, flags, ...args) => {
      const fd = fs.openSync(filePath, flags, ...args);
      if (String(filePath).endsWith('.stage')) stagedFdModes.set(fd, flags);
      return fd;
    };
    fsImpl.fsyncSync = (fd) => {
      const mode = stagedFdModes.get(fd);
      if (mode) {
        syncedStageModes.push(mode);
        if (mode === 'r') {
          const error = new Error('EPERM: operation not permitted, fsync');
          error.code = 'EPERM';
          throw error;
        }
      }
      return fs.fsyncSync(fd);
    };
    fsImpl.closeSync = (fd) => {
      stagedFdModes.delete(fd);
      return fs.closeSync(fd);
    };

    const prepared = prepareToolboxPublication({
      taskId: 'windows-staging-fsync-writable-handle',
      artifacts: [validatedArtifact(source)],
      targets: [target],
      userDataDir: ctx.userDataDir,
      requireValidatedArtifacts: true,
      fsImpl
    });
    const result = publishPreparedToolboxPublication(prepared);

    assert.deepEqual(syncedStageModes, ['r+']);
    assert.equal(result.committed, true);
    assert.equal(fs.readFileSync(target, 'utf8'), 'generated');
  });

  test('生产发布要求写后校验摘要，并拒绝校验后发生变化的 generation', () => {
    const ctx = makeContext();
    const source = writeFile(path.join(ctx.generationDir, 'source.xlsx'), 'validated-v1');
    const target = writeFile(path.join(ctx.outputDir, 'target.xlsx'), 'original');

    assert.throws(
      () => prepareToolboxPublication({
        taskId: 'missing-validation',
        artifacts: [{ sourcePath: source }],
        targets: [{ targetPath: target }],
        userDataDir: ctx.userDataDir,
        requireValidatedArtifacts: true
      }),
      (error) => error && error.code === 'TOOLBOX_PUBLICATION_VALIDATION_REQUIRED'
    );

    const artifact = validatedArtifact(source);
    fs.writeFileSync(source, 'mutated-v100');
    assert.equal(fs.statSync(source).size, artifact.byteSize, '故障注入保持相同文件大小');
    assert.throws(
      () => prepareToolboxPublication({
        taskId: 'generation-mutated',
        artifacts: [artifact],
        targets: [{ targetPath: target }],
        userDataDir: ctx.userDataDir,
        requireValidatedArtifacts: true
      }),
      (error) => error && error.code === 'TOOLBOX_PUBLICATION_GENERATION_CHANGED'
    );

    assert.equal(fs.readFileSync(target, 'utf8'), 'original');
    const indexPath = path.join(ctx.userDataDir, JOURNAL_INDEX_NAME);
    if (fs.existsSync(indexPath)) assert.deepEqual(indexValue(ctx).entries, []);
    assert.deepEqual(taskFiles(ctx), []);
  });

  test('staging 发布后正式目标摘要漂移不得报告 committed', () => {
    const ctx = makeContext();
    const source = writeFile(path.join(ctx.generationDir, 'source.xlsx'), 'new-good');
    const target = writeFile(path.join(ctx.outputDir, 'target.xlsx'), 'original');
    const prepared = prepareToolboxPublication({
      taskId: 'target-mutated-after-rename',
      artifacts: [validatedArtifact(source)],
      targets: [target],
      userDataDir: ctx.userDataDir,
      requireValidatedArtifacts: true,
      checkpoint(name) {
        if (name === 'publish:after-publish-rename-before-journal') {
          fs.writeFileSync(target, 'bad-data');
        }
      }
    });

    assert.throws(
      () => publishPreparedToolboxPublication(prepared),
      (error) => {
        assert.ok(error instanceof ToolboxPublicationManualRecoveryError);
        assert.equal(error.preserveTemporaryFiles, true);
        assert.ok(error.recoveryPaths.includes(source));
        assert.ok(error.recoveryPaths.includes(target));
        assert.match(error.detailLines.join('\n'), /外部改写/);
        return true;
      }
    );
    assert.equal(fs.readFileSync(target, 'utf8'), 'bad-data');
    assert.equal(indexValue(ctx).entries.length, 1);
    assert.ok(taskFiles(ctx).some((name) => name.endsWith('.backup')));
    assert.ok(taskFiles(ctx).some((name) => name.endsWith('.journal.json')));
  });

  test('单目标在 after-publish 被无异常改写时，整批最终复核阻止 committed', () => {
    const ctx = makeContext();
    const source = writeFile(path.join(ctx.generationDir, 'source.xlsx'), 'new-good');
    const target = writeFile(path.join(ctx.outputDir, 'target.xlsx'), 'original');
    const prepared = prepareToolboxPublication({
      taskId: 'single-target-mutated-after-published',
      artifacts: [validatedArtifact(source)],
      targets: [target],
      userDataDir: ctx.userDataDir,
      requireValidatedArtifacts: true,
      checkpoint(name) {
        if (name === 'publish:after-publish') {
          fs.writeFileSync(target, 'external');
        }
      }
    });

    assert.throws(
      () => publishPreparedToolboxPublication(prepared),
      (error) => {
        assert.ok(error instanceof ToolboxPublicationManualRecoveryError);
        assert.match(error.detailLines.join('\n'), /外部改写/);
        assert.ok(error.recoveryPaths.includes(target));
        return true;
      }
    );
    assert.equal(fs.readFileSync(target, 'utf8'), 'external');
    assert.equal(indexValue(ctx).entries.length, 1);
    assert.ok(taskFiles(ctx).some((name) => name.endsWith('.backup')));
    assert.ok(taskFiles(ctx).some((name) => name.endsWith('.journal.json')));
  });

  test('多目标后续发布期间改写已发布目标时，最终复核回滚已知目标并保留未知文件', () => {
    const ctx = makeContext();
    const sourceA = writeFile(path.join(ctx.generationDir, 'a.xlsx'), 'new-a');
    const sourceB = writeFile(path.join(ctx.generationDir, 'b.xlsx'), 'new-b');
    const targetA = writeFile(path.join(ctx.outputDir, 'a.xlsx'), 'old-a');
    const targetB = writeFile(path.join(ctx.outputDir, 'b.xlsx'), 'old-b');
    const prepared = prepareToolboxPublication({
      taskId: 'multi-target-mutated-after-published',
      artifacts: [validatedArtifact(sourceA), validatedArtifact(sourceB)],
      targets: [targetA, targetB],
      userDataDir: ctx.userDataDir,
      requireValidatedArtifacts: true,
      checkpoint(name, context) {
        if (name === 'publish:after-publish' && context.index === 1) {
          fs.writeFileSync(targetA, 'external-a');
        }
      }
    });

    assert.throws(
      () => publishPreparedToolboxPublication(prepared),
      (error) => {
        assert.ok(error instanceof ToolboxPublicationManualRecoveryError);
        assert.match(error.detailLines.join('\n'), /外部改写/);
        assert.ok(error.recoveryPaths.includes(targetA));
        return true;
      }
    );
    assert.equal(fs.readFileSync(targetA, 'utf8'), 'external-a');
    assert.equal(fs.readFileSync(targetB, 'utf8'), 'old-b');
    assert.equal(indexValue(ctx).entries.length, 1);
    assert.ok(taskFiles(ctx).some((name) => name.endsWith('.backup')));
    assert.ok(taskFiles(ctx).some((name) => name.endsWith('.journal.json')));
  });

  test('staged 发布紧前并发新建正式目标时拒绝覆盖且保留未知文件', () => {
    const ctx = makeContext();
    const source = writeFile(path.join(ctx.generationDir, 'source.xlsx'), 'generated');
    const target = path.join(ctx.outputDir, 'target.xlsx');
    const prepared = prepareToolboxPublication({
      taskId: 'target-created-immediately-before-publish',
      artifacts: [validatedArtifact(source)],
      targets: [target],
      userDataDir: ctx.userDataDir,
      requireValidatedArtifacts: true,
      checkpoint(name) {
        if (name === 'publish:before-publish') {
          fs.writeFileSync(target, 'external');
        }
      }
    });

    assert.throws(
      () => publishPreparedToolboxPublication(prepared),
      (error) => {
        assert.ok(error instanceof ToolboxPublicationManualRecoveryError);
        assert.match(error.detailLines.join('\n'), /外部改写/);
        assert.ok(error.recoveryPaths.includes(target));
        return true;
      }
    );
    assert.equal(fs.readFileSync(target, 'utf8'), 'external');
    assert.equal(indexValue(ctx).entries.length, 1);
    assert.ok(taskFiles(ctx).some((name) => name.endsWith('.journal.json')));
  });

  test('原子 stage link 内并发新建正式目标时拒绝覆盖未知文件', () => {
    const ctx = makeContext();
    const source = writeFile(path.join(ctx.generationDir, 'source.xlsx'), 'generated');
    const target = path.join(ctx.outputDir, 'target.xlsx');
    const fsImpl = Object.create(fs);
    let injected = false;
    fsImpl.linkSync = (from, to) => {
      if (!injected && from.endsWith('.stage') && to === target) {
        injected = true;
        fs.writeFileSync(target, 'external');
      }
      return fs.linkSync(from, to);
    };
    const prepared = prepareToolboxPublication({
      taskId: 'target-created-inside-link',
      artifacts: [validatedArtifact(source)],
      targets: [target],
      userDataDir: ctx.userDataDir,
      requireValidatedArtifacts: true,
      fsImpl
    });

    assert.throws(
      () => publishPreparedToolboxPublication(prepared),
      (error) => {
        assert.ok(error instanceof ToolboxPublicationManualRecoveryError);
        assert.ok(error.recoveryPaths.includes(source));
        assert.ok(error.recoveryPaths.includes(prepared.journalPath));
        return true;
      }
    );
    assert.equal(injected, true);
    assert.equal(fs.readFileSync(target, 'utf8'), 'external');
    assert.equal(indexValue(ctx).entries.length, 1);
    assert.ok(taskFiles(ctx).some((name) => name.endsWith('.journal.json')));
  });

  test('原子 backup link 内并发新建备份路径时拒绝覆盖两端未知文件', () => {
    const ctx = makeContext();
    const source = writeFile(path.join(ctx.generationDir, 'source.xlsx'), 'generated');
    const target = writeFile(path.join(ctx.outputDir, 'target.xlsx'), 'original');
    const fsImpl = Object.create(fs);
    let injectedBackup = '';
    fsImpl.linkSync = (from, to) => {
      if (!injectedBackup && from === target && to.endsWith('.backup')) {
        injectedBackup = to;
        fs.writeFileSync(to, 'external-backup');
      }
      return fs.linkSync(from, to);
    };
    const prepared = prepareToolboxPublication({
      taskId: 'backup-created-inside-link',
      artifacts: [validatedArtifact(source)],
      targets: [target],
      userDataDir: ctx.userDataDir,
      requireValidatedArtifacts: true,
      fsImpl
    });

    assert.throws(
      () => publishPreparedToolboxPublication(prepared),
      ToolboxPublicationManualRecoveryError
    );
    assert.equal(fs.readFileSync(target, 'utf8'), 'original');
    assert.equal(fs.readFileSync(injectedBackup, 'utf8'), 'external-backup');
    assert.equal(indexValue(ctx).entries.length, 1);
  });

  test('rollback 的 backup restore link 内并发新建 target 时保留未知 target 与原备份', () => {
    const ctx = makeContext();
    const source = writeFile(path.join(ctx.generationDir, 'source.xlsx'), 'generated');
    const target = writeFile(path.join(ctx.outputDir, 'target.xlsx'), 'original');
    const fsImpl = Object.create(fs);
    let backupPath = '';
    fsImpl.linkSync = (from, to) => {
      if (from.endsWith('.backup') && to === target) {
        backupPath = from;
        fs.writeFileSync(target, 'external-target');
      }
      return fs.linkSync(from, to);
    };
    const prepared = prepareToolboxPublication({
      taskId: 'restore-target-created-inside-link',
      artifacts: [validatedArtifact(source)],
      targets: [target],
      userDataDir: ctx.userDataDir,
      requireValidatedArtifacts: true,
      fsImpl,
      checkpoint(name) {
        if (name === 'publish:before-publish') {
          throw new Error('trigger rollback before stage publish');
        }
      }
    });

    assert.throws(
      () => publishPreparedToolboxPublication(prepared),
      ToolboxPublicationManualRecoveryError
    );
    assert.equal(fs.readFileSync(target, 'utf8'), 'external-target');
    assert.equal(fs.readFileSync(backupPath, 'utf8'), 'original');
    assert.equal(indexValue(ctx).entries.length, 1);
  });

  test('backup 建链后源路径被替换时不 unlink 未知 target', () => {
    const ctx = makeContext();
    const source = writeFile(path.join(ctx.generationDir, 'source.xlsx'), 'generated');
    const target = writeFile(path.join(ctx.outputDir, 'target.xlsx'), 'original');
    let backupPath = '';
    const prepared = prepareToolboxPublication({
      taskId: 'backup-source-replaced-before-unlink',
      artifacts: [validatedArtifact(source)],
      targets: [target],
      userDataDir: ctx.userDataDir,
      requireValidatedArtifacts: true,
      checkpoint(name, context) {
        if (name === 'publish:after-backup-link-before-target-unlink') {
          backupPath = context.backupPath;
          fs.rmSync(target);
          fs.writeFileSync(target, 'external-target');
        }
      }
    });

    assert.throws(
      () => publishPreparedToolboxPublication(prepared),
      ToolboxPublicationManualRecoveryError
    );
    assert.equal(fs.readFileSync(target, 'utf8'), 'external-target');
    assert.equal(fs.readFileSync(backupPath, 'utf8'), 'original');
    assert.equal(indexValue(ctx).entries.length, 1);
  });

  test('stage 建链后源路径被替换时不 unlink 未知 staging 且回滚正式目标', () => {
    const ctx = makeContext();
    const source = writeFile(path.join(ctx.generationDir, 'source.xlsx'), 'generated');
    const target = writeFile(path.join(ctx.outputDir, 'target.xlsx'), 'original');
    let stagedPath = '';
    const prepared = prepareToolboxPublication({
      taskId: 'stage-source-replaced-before-unlink',
      artifacts: [validatedArtifact(source)],
      targets: [target],
      userDataDir: ctx.userDataDir,
      requireValidatedArtifacts: true,
      checkpoint(name, context) {
        if (name === 'publish:after-stage-link-before-staging-unlink') {
          stagedPath = context.stagedPath;
          fs.rmSync(stagedPath);
          fs.writeFileSync(stagedPath, 'external-stage');
        }
      }
    });

    assert.throws(
      () => publishPreparedToolboxPublication(prepared),
      ToolboxPublicationManualRecoveryError
    );
    assert.equal(fs.readFileSync(target, 'utf8'), 'original');
    assert.equal(fs.readFileSync(stagedPath, 'utf8'), 'external-stage');
    assert.equal(indexValue(ctx).entries.length, 1);
  });

  test('hardlink 身份的 ino=0 时 fail-closed 且不 unlink 任一端', () => {
    const ctx = makeContext();
    const source = writeFile(path.join(ctx.generationDir, 'source.xlsx'), 'generated');
    const target = path.join(ctx.outputDir, 'target.xlsx');
    const fsImpl = Object.create(fs);
    let identityPaths = new Set();
    const originalLstatSync = fs.lstatSync;
    fsImpl.lstatSync = (filePath, options) => {
      const stat = originalLstatSync(filePath, options);
      if (!identityPaths.has(filePath)) return stat;
      const useBigInt = Boolean(options && options.bigint === true);
      return statWithIdentity(stat, useBigInt ? 0n : 0, useBigInt ? 0n : 0);
    };
    const prepared = prepareToolboxPublication({
      taskId: 'zero-inode-fail-closed',
      artifacts: [validatedArtifact(source)],
      targets: [target],
      userDataDir: ctx.userDataDir,
      requireValidatedArtifacts: true,
      fsImpl,
      checkpoint(name, context) {
        if (name === 'publish:after-stage-link-before-staging-unlink') {
          identityPaths = new Set([context.stagedPath, context.targetPath]);
        }
      }
    });

    assert.throws(
      () => publishPreparedToolboxPublication(prepared),
      (error) => {
        assert.equal(error.code, 'TOOLBOX_PUBLICATION_FAILED');
        assert.equal(
          error.cause && error.cause.code,
          'TOOLBOX_PUBLICATION_NO_REPLACE_IDENTITY_UNAVAILABLE'
        );
        return true;
      }
    );
    assert.equal(fs.existsSync(target), false);
    assert.deepEqual(indexValue(ctx).entries, []);
    assert.deepEqual(taskFiles(ctx), []);
  });

  test('超过安全整数的相邻 inode 保持精确，源替换后不误 unlink 外部文件', () => {
    const ctx = makeContext();
    const source = writeFile(path.join(ctx.generationDir, 'source.xlsx'), 'generated');
    const target = writeFile(path.join(ctx.outputDir, 'target.xlsx'), 'original');
    const fsImpl = Object.create(fs);
    const originalLstatSync = fs.lstatSync;
    const baseInode = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
    let backupPath = '';
    let identityPhase = false;
    fsImpl.lstatSync = (filePath, options) => {
      const stat = originalLstatSync(filePath, options);
      if (!identityPhase || ![target, backupPath].includes(filePath)) return stat;
      const exactInode = filePath === target ? baseInode + 1n : baseInode;
      const useBigInt = Boolean(options && options.bigint === true);
      return statWithIdentity(
        stat,
        useBigInt ? 1n : 1,
        useBigInt ? exactInode : Number(exactInode)
      );
    };
    const prepared = prepareToolboxPublication({
      taskId: 'bigint-inode-source-replaced',
      artifacts: [validatedArtifact(source)],
      targets: [target],
      userDataDir: ctx.userDataDir,
      requireValidatedArtifacts: true,
      fsImpl,
      checkpoint(name, context) {
        if (name === 'publish:after-backup-link-before-target-unlink') {
          backupPath = context.backupPath;
          fs.rmSync(target);
          fs.writeFileSync(target, 'external-target');
          identityPhase = true;
        }
      }
    });

    assert.throws(
      () => publishPreparedToolboxPublication(prepared),
      ToolboxPublicationManualRecoveryError
    );
    assert.equal(fs.readFileSync(target, 'utf8'), 'external-target');
    assert.equal(fs.readFileSync(backupPath, 'utf8'), 'original');
    assert.equal(indexValue(ctx).entries.length, 1);
  });

  test('backup 建链后、源 unlink 前崩溃可由新进程清掉重复 link 并保留原目标', () => {
    const ctx = makeContext();
    const source = writeFile(path.join(ctx.generationDir, 'source.xlsx'), 'generated');
    const target = writeFile(path.join(ctx.outputDir, 'target.xlsx'), 'original');
    const prepared = prepareToolboxPublication({
      taskId: 'crash-after-backup-link',
      artifacts: [validatedArtifact(source)],
      targets: [target],
      userDataDir: ctx.userDataDir,
      requireValidatedArtifacts: true,
      checkpoint(name) {
        if (name === 'publish:after-backup-link-before-target-unlink') {
          throw new ToolboxPublicationCrashError(name);
        }
      }
    });

    assert.throws(
      () => publishPreparedToolboxPublication(prepared),
      ToolboxPublicationCrashError
    );
    const index = indexValue(ctx);
    assert.equal(fs.readFileSync(target, 'utf8'), 'original');
    assert.equal(fs.readFileSync(index.entries[0].backupAbsolutePaths[0], 'utf8'), 'original');

    const recovered = recoverInFreshProcess(ctx.userDataDir);
    assert.deepEqual(recovered.recovered.map((item) => item.action), ['rolled-back']);
    assert.equal(fs.readFileSync(target, 'utf8'), 'original');
    assert.deepEqual(indexValue(ctx).entries, []);
    assert.deepEqual(taskFiles(ctx), []);
  });

  test('stage 建链后、源 unlink 前崩溃可由新进程回滚 target 与重复 staging', () => {
    const ctx = makeContext();
    const source = writeFile(path.join(ctx.generationDir, 'source.xlsx'), 'generated');
    const target = writeFile(path.join(ctx.outputDir, 'target.xlsx'), 'original');
    const prepared = prepareToolboxPublication({
      taskId: 'crash-after-stage-link',
      artifacts: [validatedArtifact(source)],
      targets: [target],
      userDataDir: ctx.userDataDir,
      requireValidatedArtifacts: true,
      checkpoint(name) {
        if (name === 'publish:after-stage-link-before-staging-unlink') {
          throw new ToolboxPublicationCrashError(name);
        }
      }
    });

    assert.throws(
      () => publishPreparedToolboxPublication(prepared),
      ToolboxPublicationCrashError
    );
    const index = indexValue(ctx);
    assert.equal(fs.readFileSync(target, 'utf8'), 'generated');
    assert.equal(
      fs.readFileSync(index.entries[0].stagedAbsolutePaths[0], 'utf8'),
      'generated'
    );

    const recovered = recoverInFreshProcess(ctx.userDataDir);
    assert.deepEqual(recovered.recovered.map((item) => item.action), ['rolled-back']);
    assert.equal(fs.readFileSync(target, 'utf8'), 'original');
    assert.deepEqual(indexValue(ctx).entries, []);
    assert.deepEqual(taskFiles(ctx), []);
  });

  test('文件系统不支持 hardlink 时 fail-closed 且不回退覆盖型 rename', () => {
    const ctx = makeContext();
    const source = writeFile(path.join(ctx.generationDir, 'source.xlsx'), 'generated');
    const target = path.join(ctx.outputDir, 'target.xlsx');
    const fsImpl = Object.create(fs);
    fsImpl.linkSync = (from, to) => {
      if (from.endsWith('.stage') && to === target) {
        const error = new Error('hardlink unsupported');
        error.code = 'ENOTSUP';
        throw error;
      }
      return fs.linkSync(from, to);
    };
    const prepared = prepareToolboxPublication({
      taskId: 'hardlink-unsupported',
      artifacts: [validatedArtifact(source)],
      targets: [target],
      userDataDir: ctx.userDataDir,
      requireValidatedArtifacts: true,
      fsImpl
    });

    assert.throws(
      () => publishPreparedToolboxPublication(prepared),
      (error) => {
        assert.equal(error.code, 'TOOLBOX_PUBLICATION_FAILED');
        assert.match(error.detailLines.join('\n'), /原子不覆盖/);
        return true;
      }
    );
    assert.equal(fs.existsSync(target), false);
    assert.deepEqual(indexValue(ctx).entries, []);
    assert.deepEqual(taskFiles(ctx), []);
  });

  test('多输出先完整 prepare，再统一发布并保留结果 metadata', () => {
    const ctx = makeContext();
    const sourceA = writeFile(path.join(ctx.generationDir, 'a.xlsx'), 'new-a');
    const sourceB = writeFile(path.join(ctx.generationDir, 'b.xlsx'), 'new-b');
    const targetA = writeFile(path.join(ctx.outputDir, 'a.xlsx'), 'old-a');
    const targetB = path.join(ctx.outputDir, 'b.xlsx');

    const prepared = prepareToolboxPublication({
      taskId: 'multi-success',
      artifacts: [
        {
          sourcePath: sourceA,
          outputId: 'A',
          matchedCount: 2,
          warningSummary: ['A warning'],
          styleStats: { cellXfs: 3 }
        },
        { sourcePath: sourceB, outputId: 'B', matchedCount: 1 }
      ],
      targets: [
        { targetPath: targetA, fileName: '结果A.xlsx' },
        { targetPath: targetB, fileName: '结果B.xlsx' }
      ],
      userDataDir: ctx.userDataDir
    });

    assert.equal(fs.readFileSync(targetA, 'utf8'), 'old-a', 'prepare 不得触碰已有正式目标');
    assert.equal(fs.existsSync(targetB), false, 'prepare 不得提前创建正式目标');
    assert.equal(prepared.artifacts.length, 2);
    assert.ok(prepared.artifacts.every((item) => path.dirname(item.stagedPath) === ctx.outputDir));
    assert.ok(prepared.artifacts.every((item) => fs.existsSync(item.stagedPath)));
    assert.equal(indexValue(ctx).entries.length, 1);
    assert.equal(indexValue(ctx).entries[0].discoveryState, 'prepared');

    const result = publishPreparedToolboxPublication(prepared);

    assert.equal(result.committed, true);
    assert.equal(result.pendingCleanup, false);
    assert.deepEqual(result.files.map((file) => ({
      filePath: file.filePath,
      fileName: file.fileName,
      matchedCount: file.matchedCount,
      outputId: file.outputId
    })), [
      { filePath: targetA, fileName: '结果A.xlsx', matchedCount: 2, outputId: 'A' },
      { filePath: targetB, fileName: '结果B.xlsx', matchedCount: 1, outputId: 'B' }
    ]);
    assert.deepEqual(result.files[0].styleStats, { cellXfs: 3 });
    assert.deepEqual(result.warnings, ['A warning']);
    assert.equal(fs.readFileSync(targetA, 'utf8'), 'new-a');
    assert.equal(fs.readFileSync(targetB, 'utf8'), 'new-b');
    assert.deepEqual(indexValue(ctx).entries, []);
    assert.deepEqual(taskFiles(ctx), []);
  });

  test('prepare 的 staging 校验失败时不修改正式目标且清掉任务文件', () => {
    const ctx = makeContext();
    const source = writeFile(path.join(ctx.generationDir, 'source.xlsx'), 'generated');
    const target = writeFile(path.join(ctx.outputDir, 'target.xlsx'), 'original');
    const fsImpl = Object.create(fs);
    fsImpl.copyFileSync = (_from, to) => fs.writeFileSync(to, 'corrupt-copy');

    assert.throws(
      () => prepareToolboxPublication({
        taskId: 'bad-stage',
        artifacts: [source],
        targets: [target],
        userDataDir: ctx.userDataDir,
        fsImpl
      }),
      /暂存文件校验失败/
    );
    assert.equal(fs.readFileSync(target, 'utf8'), 'original');
    assert.deepEqual(taskFiles(ctx), []);
    const indexPath = path.join(ctx.userDataDir, JOURNAL_INDEX_NAME);
    assert.equal(fs.existsSync(indexPath) ? indexValue(ctx).entries.length : 0, 0);
  });

  test('固定 index、journal 与所有 target/staging/backup 跨项 alias 碰撞在 preflight 拒绝', () => {
    const indexTargetCtx = makeContext();
    const indexSource = writeFile(
      path.join(indexTargetCtx.generationDir, 'source.xlsx'),
      'generated'
    );
    const indexPath = path.join(indexTargetCtx.userDataDir, JOURNAL_INDEX_NAME);
    assert.throws(
      () => prepareToolboxPublication({
        taskId: 'target-collides-with-index',
        artifacts: [validatedArtifact(indexSource)],
        targets: [indexPath],
        userDataDir: indexTargetCtx.userDataDir,
        requireValidatedArtifacts: true
      }),
      (error) => {
        assert.equal(error.code, 'TOOLBOX_PUBLICATION_PATH_COLLISION');
        return true;
      }
    );
    assert.equal(fs.existsSync(indexPath), false);
    assert.equal(fs.readFileSync(indexSource, 'utf8'), 'generated');
    assert.deepEqual(taskFiles(indexTargetCtx), []);

    const crossItemCtx = makeContext();
    const sourceA = writeFile(path.join(crossItemCtx.generationDir, 'a.xlsx'), 'a');
    const sourceB = writeFile(path.join(crossItemCtx.generationDir, 'b.xlsx'), 'b');
    const nonce = 'fixed-cross-item-nonce';
    const targetA = path.join(crossItemCtx.outputDir, 'a.xlsx');
    const targetB = path.join(
      crossItemCtx.outputDir,
      `.toolbox-publish-${nonce}-1.stage`
    );
    assert.throws(
      () => prepareToolboxPublication({
        taskId: 'target-collides-with-other-stage',
        artifacts: [validatedArtifact(sourceA), validatedArtifact(sourceB)],
        targets: [targetA, targetB],
        userDataDir: crossItemCtx.userDataDir,
        requireValidatedArtifacts: true,
        randomUUID: () => nonce
      }),
      (error) => {
        assert.equal(error.code, 'TOOLBOX_PUBLICATION_PATH_COLLISION');
        return true;
      }
    );
    assert.equal(
      fs.existsSync(path.join(crossItemCtx.userDataDir, JOURNAL_INDEX_NAME)),
      false
    );
    assert.equal(fs.existsSync(targetA), false);
    assert.equal(fs.existsSync(targetB), false);
    assert.deepEqual(taskFiles(crossItemCtx), []);
  });

  test('artifact 与 target 相同或 target 位于 generation 目录时均在 preflight 拒绝', () => {
    const samePathCtx = makeContext();
    const source = writeFile(path.join(samePathCtx.generationDir, 'source.xlsx'), 'source');
    assert.throws(
      () => prepareToolboxPublication({
        taskId: 'artifact-is-target',
        artifacts: [validatedArtifact(source)],
        targets: [source],
        userDataDir: samePathCtx.userDataDir,
        requireValidatedArtifacts: true
      }),
      (error) => {
        assert.equal(error.code, 'TOOLBOX_PUBLICATION_ARTIFACT_PATH_COLLISION');
        return true;
      }
    );
    assert.equal(fs.readFileSync(source, 'utf8'), 'source');
    assert.equal(
      fs.existsSync(path.join(samePathCtx.userDataDir, JOURNAL_INDEX_NAME)),
      false
    );

    const siblingCtx = makeContext();
    const siblingSource = writeFile(
      path.join(siblingCtx.generationDir, 'source.xlsx'),
      'source'
    );
    const siblingTarget = path.join(siblingCtx.generationDir, 'result.xlsx');
    assert.throws(
      () => prepareToolboxPublication({
        taskId: 'target-inside-generation-dir',
        artifacts: [validatedArtifact(siblingSource)],
        targets: [siblingTarget],
        userDataDir: siblingCtx.userDataDir,
        requireValidatedArtifacts: true
      }),
      (error) => {
        assert.equal(error.code, 'TOOLBOX_PUBLICATION_TARGET_IN_GENERATION_DIR');
        return true;
      }
    );
    assert.equal(fs.existsSync(siblingTarget), false);
    assert.equal(
      fs.existsSync(path.join(siblingCtx.userDataDir, JOURNAL_INDEX_NAME)),
      false
    );
  });

  test('Unicode NFC 与 NFD 等价目标在 prepare 触碰任何目标前被拒绝', () => {
    const ctx = makeContext();
    const sourceA = writeFile(path.join(ctx.generationDir, 'source-a.xlsx'), 'new-a');
    const sourceB = writeFile(path.join(ctx.generationDir, 'source-b.xlsx'), 'new-b');
    const targetNfc = writeFile(path.join(ctx.outputDir, '\u00e9.xlsx'), 'old-target');
    const targetNfd = path.join(ctx.outputDir, 'e\u0301.xlsx');

    assert.throws(
      () => prepareToolboxPublication({
        taskId: 'unicode-target-alias',
        artifacts: [sourceA, sourceB],
        targets: [targetNfc, targetNfd],
        userDataDir: ctx.userDataDir
      }),
      (error) => {
        assert.equal(error.code, 'TOOLBOX_PUBLICATION_DUPLICATE_TARGET');
        return true;
      }
    );

    assert.equal(fs.readFileSync(targetNfc, 'utf8'), 'old-target');
    assert.equal(fs.readFileSync(sourceA, 'utf8'), 'new-a');
    assert.equal(fs.readFileSync(sourceB, 'utf8'), 'new-b');
    assert.deepEqual(taskFiles(ctx), []);
    assert.equal(
      fs.existsSync(path.join(ctx.userDataDir, JOURNAL_INDEX_NAME)),
      false,
      '重复目标必须在 journal/index 创建前失败'
    );
  });

  test('macOS 完整 case-fold 等价目标在 prepare 前被拒绝', {
    skip: process.platform !== 'darwin'
  }, () => {
    for (const [leftName, rightName] of [
      ['straße.xlsx', 'STRASSE.xlsx'],
      ['οσ.xlsx', 'ος.xlsx']
    ]) {
      const ctx = makeContext();
      const sourceA = writeFile(path.join(ctx.generationDir, 'source-a.xlsx'), 'new-a');
      const sourceB = writeFile(path.join(ctx.generationDir, 'source-b.xlsx'), 'new-b');
      const targetA = path.join(ctx.outputDir, leftName);
      const targetB = path.join(ctx.outputDir, rightName);

      assert.throws(
        () => prepareToolboxPublication({
          taskId: `unicode-full-fold-${ctx.root.length}`,
          artifacts: [sourceA, sourceB],
          targets: [targetA, targetB],
          userDataDir: ctx.userDataDir
        }),
        (error) => {
          assert.equal(error.code, 'TOOLBOX_PUBLICATION_DUPLICATE_TARGET');
          return true;
        }
      );
      assert.deepEqual(fs.readdirSync(ctx.outputDir), []);
      assert.deepEqual(taskFiles(ctx), []);
    }
  });

  test('index rename 已发生但耐久化调用报错时，prepare 能识别登记结果并完整取消', () => {
    const ctx = makeContext();
    const source = writeFile(path.join(ctx.generationDir, 'source.xlsx'), 'generated');
    const target = writeFile(path.join(ctx.outputDir, 'target.xlsx'), 'original');
    const indexPath = path.join(ctx.userDataDir, JOURNAL_INDEX_NAME);
    const fsImpl = Object.create(fs);
    let injected = false;
    fsImpl.renameSync = (from, to) => {
      const result = fs.renameSync(from, to);
      if (!injected && to === indexPath) {
        injected = true;
        throw new Error('injected post-index-rename failure');
      }
      return result;
    };

    assert.throws(
      () => prepareToolboxPublication({
        taskId: 'ambiguous-index-add',
        artifacts: [source],
        targets: [target],
        userDataDir: ctx.userDataDir,
        fsImpl
      }),
      /post-index-rename failure/
    );
    assert.equal(fs.readFileSync(target, 'utf8'), 'original');
    assert.deepEqual(indexValue(ctx).entries, []);
    assert.deepEqual(taskFiles(ctx), []);
  });

  test('preparing intent 在各 prepare 崩溃点均由新进程发现并只清任务文件', () => {
    for (const checkpointName of [
      'prepare:after-index-before-journal',
      'prepare:after-preparing-journal',
      'prepare:after-staged',
      'prepare:after-journal'
    ]) {
      const ctx = makeContext();
      const source = writeFile(path.join(ctx.generationDir, 'source.xlsx'), 'generated');
      const target = writeFile(path.join(ctx.outputDir, 'target.xlsx'), 'original');

      assert.throws(
        () => prepareToolboxPublication({
          taskId: `crash-${checkpointName}`,
          artifacts: [source],
          targets: [target],
          userDataDir: ctx.userDataDir,
          checkpoint(name) {
            if (name === checkpointName) throw new ToolboxPublicationCrashError(name);
          }
        }),
        ToolboxPublicationCrashError
      );

      const entry = indexValue(ctx).entries[0];
      assert.equal(entry.discoveryState, 'preparing');
      assert.equal(fs.readFileSync(target, 'utf8'), 'original');
      if (checkpointName === 'prepare:after-index-before-journal') {
        assert.deepEqual(taskFiles(ctx), [], 'index intent 之后、journal 之前尚无输出目录任务文件');
      } else {
        assert.ok(taskFiles(ctx).some((name) => name.endsWith('.journal.json')));
      }
      if (['prepare:after-staged', 'prepare:after-journal'].includes(checkpointName)) {
        assert.ok(taskFiles(ctx).some((name) => name.endsWith('.stage')));
      }

      const recovered = recoverInFreshProcess(ctx.userDataDir);
      assert.deepEqual(
        recovered.recovered.map((item) => item.action),
        ['cancelled-preparing']
      );
      assert.equal(fs.readFileSync(target, 'utf8'), 'original');
      assert.deepEqual(indexValue(ctx).entries, []);
      assert.deepEqual(taskFiles(ctx), []);
    }
  });

  test('copy 中途崩溃产生的 partial staging 可由新进程清理且不触碰 target', () => {
    const ctx = makeContext();
    const source = writeFile(
      path.join(ctx.generationDir, 'source.xlsx'),
      'generated-content'
    );
    const target = writeFile(path.join(ctx.outputDir, 'target.xlsx'), 'original');
    const fsImpl = Object.create(fs);
    fsImpl.copyFileSync = (from, to) => {
      const content = fs.readFileSync(from);
      fs.writeFileSync(to, content.subarray(0, 4));
      throw new ToolboxPublicationCrashError('prepare:during-stage-copy');
    };

    assert.throws(
      () => prepareToolboxPublication({
        taskId: 'crash-partial-stage',
        artifacts: [source],
        targets: [target],
        userDataDir: ctx.userDataDir,
        fsImpl
      }),
      ToolboxPublicationCrashError
    );

    const intent = indexValue(ctx).entries[0];
    assert.equal(intent.discoveryState, 'preparing');
    assert.equal(fs.readFileSync(intent.stagedAbsolutePaths[0], 'utf8'), 'gene');
    assert.equal(fs.readFileSync(target, 'utf8'), 'original');

    const recovered = recoverInFreshProcess(ctx.userDataDir);
    assert.deepEqual(
      recovered.recovered.map((item) => item.action),
      ['cancelled-preparing']
    );
    assert.equal(fs.readFileSync(target, 'utf8'), 'original');
    assert.deepEqual(indexValue(ctx).entries, []);
    assert.deepEqual(taskFiles(ctx), []);
  });

  test('preparing index 的 staging 路径被篡改时 fail-closed，不删除其它目录文件', () => {
    const ctx = makeContext();
    const source = writeFile(path.join(ctx.generationDir, 'source.xlsx'), 'generated');
    const target = writeFile(path.join(ctx.outputDir, 'target.xlsx'), 'original');
    assert.throws(
      () => prepareToolboxPublication({
        taskId: 'tampered-preparing-index',
        artifacts: [source],
        targets: [target],
        userDataDir: ctx.userDataDir,
        checkpoint(name) {
          if (name === 'prepare:after-index-before-journal') {
            throw new ToolboxPublicationCrashError(name);
          }
        }
      }),
      ToolboxPublicationCrashError
    );

    const indexPath = path.join(ctx.userDataDir, JOURNAL_INDEX_NAME);
    const index = indexValue(ctx);
    const victimDir = path.join(ctx.root, 'victim');
    fs.mkdirSync(victimDir);
    const victim = writeFile(
      path.join(victimDir, path.basename(index.entries[0].stagedAbsolutePaths[0])),
      'keep-me'
    );
    index.entries[0].stagedAbsolutePaths[0] = victim;
    fs.writeFileSync(indexPath, JSON.stringify(index));

    assert.throws(
      () => recoverPendingToolboxPublications({ userDataDir: ctx.userDataDir }),
      ToolboxPublicationManualRecoveryError
    );
    assert.equal(fs.readFileSync(victim, 'utf8'), 'keep-me');
    assert.equal(fs.readFileSync(target, 'utf8'), 'original');
    assert.equal(indexValue(ctx).entries.length, 1);
  });

  test('publish 只接受 journal 与 index 均完整 prepared，preparing intent 不触碰 target', () => {
    const ctx = makeContext();
    const source = writeFile(path.join(ctx.generationDir, 'source.xlsx'), 'generated');
    const target = writeFile(path.join(ctx.outputDir, 'target.xlsx'), 'original');
    const prepared = prepareToolboxPublication({
      taskId: 'publish-rejects-preparing-index',
      artifacts: [source],
      targets: [target],
      userDataDir: ctx.userDataDir
    });
    const indexPath = path.join(ctx.userDataDir, JOURNAL_INDEX_NAME);
    const index = indexValue(ctx);
    index.entries[0].discoveryState = 'preparing';
    fs.writeFileSync(indexPath, JSON.stringify(index));

    assert.throws(
      () => publishPreparedToolboxPublication(prepared),
      (error) => {
        assert.equal(error.code, 'TOOLBOX_PUBLICATION_MANUAL_RECOVERY');
        assert.match(error.message, /尚未完整 prepared/);
        return true;
      }
    );
    assert.equal(fs.readFileSync(target, 'utf8'), 'original');

    const recovered = recoverInFreshProcess(ctx.userDataDir);
    assert.deepEqual(
      recovered.recovered.map((item) => item.action),
      ['cancelled-preparing']
    );
    assert.equal(fs.readFileSync(target, 'utf8'), 'original');
    assert.deepEqual(taskFiles(ctx), []);
  });

  test('没有 discoveryState 的存量 v1 prepared index 只允许人工恢复且不触碰文件', () => {
    const ctx = makeContext();
    const source = writeFile(path.join(ctx.generationDir, 'source.xlsx'), 'generated');
    const target = writeFile(path.join(ctx.outputDir, 'target.xlsx'), 'original');
    const prepared = prepareToolboxPublication({
      taskId: 'legacy-v1-prepared-index',
      artifacts: [source],
      targets: [target],
      userDataDir: ctx.userDataDir
    });
    const indexPath = path.join(ctx.userDataDir, JOURNAL_INDEX_NAME);
    const index = indexValue(ctx);
    delete index.entries[0].discoveryState;
    delete index.entries[0].nonce;
    delete index.entries[0].stagedAbsolutePaths;
    delete index.entries[0].targetAbsolutePaths;
    delete index.entries[0].backupAbsolutePaths;
    fs.writeFileSync(indexPath, JSON.stringify(index));

    assert.throws(
      () => publishPreparedToolboxPublication(prepared),
      (error) => {
        assert.ok(error instanceof ToolboxPublicationManualRecoveryError);
        assert.match(error.message, /存量 v1/);
        assert.ok(error.recoveryPaths.includes(indexPath));
        assert.ok(error.recoveryPaths.includes(prepared.journalPath));
        return true;
      }
    );
    assert.equal(fs.readFileSync(target, 'utf8'), 'original');
    assert.equal(fs.readFileSync(prepared.artifacts[0].stagedPath, 'utf8'), 'generated');
    assert.ok(fs.existsSync(prepared.journalPath));
    assert.deepEqual(indexValue(ctx), index);

    assert.throws(
      () => recoverPendingToolboxPublications({ userDataDir: ctx.userDataDir }),
      ToolboxPublicationManualRecoveryError
    );
    assert.equal(fs.readFileSync(target, 'utf8'), 'original');
    assert.equal(fs.readFileSync(prepared.artifacts[0].stagedPath, 'utf8'), 'generated');
    assert.ok(fs.existsSync(prepared.journalPath));
    assert.deepEqual(indexValue(ctx), index);
  });

  test('在线发布中途失败会逆序回滚全部目标', () => {
    const ctx = makeContext();
    const sourceA = writeFile(path.join(ctx.generationDir, 'a.xlsx'), 'new-a');
    const sourceB = writeFile(path.join(ctx.generationDir, 'b.xlsx'), 'new-b');
    const targetA = writeFile(path.join(ctx.outputDir, 'a.xlsx'), 'old-a');
    const targetB = writeFile(path.join(ctx.outputDir, 'b.xlsx'), 'old-b');
    let injected = false;
    const prepared = prepareToolboxPublication({
      taskId: 'online-rollback',
      artifacts: [sourceA, sourceB],
      targets: [targetA, targetB],
      userDataDir: ctx.userDataDir,
      checkpoint(name, context) {
        if (!injected && name === 'publish:after-publish' && context.index === 0) {
          injected = true;
          throw new Error('injected publish failure');
        }
      }
    });

    assert.throws(
      () => publishPreparedToolboxPublication(prepared),
      /已恢复发布前文件/
    );
    assert.equal(fs.readFileSync(targetA, 'utf8'), 'old-a');
    assert.equal(fs.readFileSync(targetB, 'utf8'), 'old-b');
    assert.deepEqual(indexValue(ctx).entries, []);
    assert.deepEqual(taskFiles(ctx), []);
  });

  test('rollback 后 journal 删除失败保留 rollback-finalizing index 并可独立收尾', () => {
    const ctx = makeContext();
    const source = writeFile(path.join(ctx.generationDir, 'source.xlsx'), 'new');
    const target = writeFile(path.join(ctx.outputDir, 'target.xlsx'), 'old');
    const fsImpl = Object.create(fs);
    const originalRmSync = fs.rmSync;
    let failJournalRemoval = false;
    fsImpl.rmSync = (filePath, options) => {
      if (failJournalRemoval && filePath.endsWith('.journal.json')) {
        throw new Error('injected rollback journal removal failure');
      }
      return originalRmSync(filePath, options);
    };
    const prepared = prepareToolboxPublication({
      taskId: 'rollback-journal-removal-retry',
      artifacts: [validatedArtifact(source)],
      targets: [target],
      userDataDir: ctx.userDataDir,
      requireValidatedArtifacts: true,
      fsImpl,
      checkpoint(name) {
        if (name === 'publish:after-publish') {
          failJournalRemoval = true;
          throw new Error('trigger rollback');
        }
      }
    });

    assert.throws(
      () => publishPreparedToolboxPublication(prepared),
      (error) => {
        assert.ok(error instanceof ToolboxPublicationManualRecoveryError);
        assert.ok(error.recoveryPaths.includes(source));
        assert.ok(error.recoveryPaths.includes(prepared.journalPath));
        assert.ok(
          error.recoveryPaths.includes(path.join(ctx.userDataDir, JOURNAL_INDEX_NAME))
        );
        return true;
      }
    );
    assert.equal(fs.readFileSync(target, 'utf8'), 'old');
    assert.equal(indexValue(ctx).entries[0].discoveryState, 'rollback-finalizing');
    assert.ok(fs.existsSync(prepared.journalPath));

    failJournalRemoval = false;
    const recovered = recoverPendingToolboxPublications({
      userDataDir: ctx.userDataDir,
      fsImpl
    });
    assert.deepEqual(recovered.recovered.map((item) => item.action), ['rolled-back']);
    assert.equal(fs.readFileSync(target, 'utf8'), 'old');
    assert.deepEqual(indexValue(ctx).entries, []);
    assert.deepEqual(taskFiles(ctx), []);
  });

  test('rollback 两个 index 收尾失败窗口都向用户展示 generation 恢复路径', () => {
    for (const failurePoint of ['mark-rollback-finalizing', 'remove-index']) {
      const ctx = makeContext();
      const source = writeFile(path.join(ctx.generationDir, 'source.xlsx'), 'new');
      const target = writeFile(path.join(ctx.outputDir, 'target.xlsx'), 'old');
      const indexPath = path.join(ctx.userDataDir, JOURNAL_INDEX_NAME);
      const fsImpl = Object.create(fs);
      let rollbackStarted = false;
      let journalRemoved = false;
      fsImpl.rmSync = (filePath, options) => {
        const result = fs.rmSync(filePath, options);
        if (filePath.endsWith('.journal.json')) journalRemoved = true;
        return result;
      };
      fsImpl.renameSync = (from, to) => {
        const failMark = (
          failurePoint === 'mark-rollback-finalizing'
          && rollbackStarted
          && !journalRemoved
          && to === indexPath
        );
        const failRemove = (
          failurePoint === 'remove-index'
          && journalRemoved
          && to === indexPath
        );
        if (failMark || failRemove) {
          throw new Error(`injected ${failurePoint} failure`);
        }
        return fs.renameSync(from, to);
      };
      const prepared = prepareToolboxPublication({
        taskId: `rollback-recovery-path-${failurePoint}`,
        artifacts: [validatedArtifact(source)],
        targets: [target],
        userDataDir: ctx.userDataDir,
        requireValidatedArtifacts: true,
        fsImpl,
        checkpoint(name) {
          if (name === 'publish:after-publish') {
            rollbackStarted = true;
            throw new Error('trigger rollback');
          }
        }
      });

      assert.throws(
        () => publishPreparedToolboxPublication(prepared),
        (error) => {
          assert.ok(error instanceof ToolboxPublicationManualRecoveryError);
          assert.ok(error.recoveryPaths.includes(source));
          assert.ok(error.recoveryPaths.includes(indexPath));
          assert.ok(error.recoveryPaths.includes(prepared.journalPath));
          return true;
        }
      );
      assert.equal(fs.readFileSync(target, 'utf8'), 'old');
    }
  });

  test('崩溃在 backup rename 与 journal 更新之间，下次恢复仍找回旧文件', () => {
    const ctx = makeContext();
    const source = writeFile(path.join(ctx.generationDir, 'source.xlsx'), 'new');
    const target = writeFile(path.join(ctx.outputDir, 'target.xlsx'), 'old');
    const prepared = prepareToolboxPublication({
      taskId: 'crash-after-backup',
      artifacts: [source],
      targets: [target],
      userDataDir: ctx.userDataDir,
      checkpoint(name) {
        if (name === 'publish:after-backup-rename-before-journal') {
          throw new ToolboxPublicationCrashError(name);
        }
      }
    });

    assert.throws(
      () => publishPreparedToolboxPublication(prepared),
      ToolboxPublicationCrashError
    );
    assert.equal(fs.existsSync(target), false);
    assert.equal(indexValue(ctx).entries.length, 1);

    const recovered = recoverPendingToolboxPublications({ userDataDir: ctx.userDataDir });
    assert.deepEqual(recovered.recovered.map((item) => item.action), ['rolled-back']);
    assert.equal(fs.readFileSync(target, 'utf8'), 'old');
    assert.deepEqual(indexValue(ctx).entries, []);
    assert.deepEqual(taskFiles(ctx), []);
  });

  test('崩溃在 staged 发布与 journal 更新之间，按文件 hash 识别并回滚', () => {
    const ctx = makeContext();
    const sourceA = writeFile(path.join(ctx.generationDir, 'a.xlsx'), 'new-a');
    const sourceB = writeFile(path.join(ctx.generationDir, 'b.xlsx'), 'new-b');
    const targetA = writeFile(path.join(ctx.outputDir, 'a.xlsx'), 'old-a');
    const targetB = path.join(ctx.outputDir, 'b.xlsx');
    const prepared = prepareToolboxPublication({
      taskId: 'crash-after-publish',
      artifacts: [sourceA, sourceB],
      targets: [targetA, targetB],
      userDataDir: ctx.userDataDir,
      checkpoint(name, context) {
        if (name === 'publish:after-publish-rename-before-journal' && context.index === 1) {
          throw new ToolboxPublicationCrashError(name);
        }
      }
    });

    assert.throws(
      () => publishPreparedToolboxPublication(prepared),
      ToolboxPublicationCrashError
    );
    assert.equal(fs.readFileSync(targetA, 'utf8'), 'new-a');
    assert.equal(fs.readFileSync(targetB, 'utf8'), 'new-b');

    recoverPendingToolboxPublications({ userDataDir: ctx.userDataDir });
    assert.equal(fs.readFileSync(targetA, 'utf8'), 'old-a');
    assert.equal(fs.existsSync(targetB), false);
    assert.deepEqual(indexValue(ctx).entries, []);
    assert.deepEqual(taskFiles(ctx), []);
  });

  test('最后一项 published 后及整批最终复核前崩溃均保持未 committed，并由新进程回滚', () => {
    for (const checkpointName of [
      'publish:after-publish',
      'publish:before-final-target-verify'
    ]) {
      const ctx = makeContext();
      const source = writeFile(path.join(ctx.generationDir, 'source.xlsx'), 'new');
      const target = writeFile(path.join(ctx.outputDir, 'target.xlsx'), 'old');
      const prepared = prepareToolboxPublication({
        taskId: `crash-${checkpointName}`,
        artifacts: [validatedArtifact(source)],
        targets: [target],
        userDataDir: ctx.userDataDir,
        requireValidatedArtifacts: true,
        checkpoint(name) {
          if (name === checkpointName) {
            throw new ToolboxPublicationCrashError(name);
          }
        }
      });

      assert.throws(
        () => publishPreparedToolboxPublication(prepared),
        ToolboxPublicationCrashError
      );
      assert.equal(fs.readFileSync(target, 'utf8'), 'new');
      const journalPath = indexValue(ctx).entries[0].journalAbsolutePath;
      assert.equal(JSON.parse(fs.readFileSync(journalPath, 'utf8')).status, 'publishing');

      const recovered = recoverInFreshProcess(ctx.userDataDir);
      assert.deepEqual(recovered.recovered.map((item) => item.action), ['rolled-back']);
      assert.equal(fs.readFileSync(target, 'utf8'), 'old');
      assert.deepEqual(indexValue(ctx).entries, []);
      assert.deepEqual(taskFiles(ctx), []);
    }
  });

  test('committed journal 已落盘后崩溃只做收尾，不回滚新文件', () => {
    const ctx = makeContext();
    const source = writeFile(path.join(ctx.generationDir, 'source.xlsx'), 'new');
    const target = writeFile(path.join(ctx.outputDir, 'target.xlsx'), 'old');
    const prepared = prepareToolboxPublication({
      taskId: 'crash-after-commit',
      artifacts: [source],
      targets: [target],
      userDataDir: ctx.userDataDir,
      batchContext: BATCH_CONTEXT,
      checkpoint(name) {
        if (name === 'publish:after-committed') {
          throw new ToolboxPublicationCrashError(name);
        }
      }
    });

    assert.throws(
      () => publishPreparedToolboxPublication(prepared),
      ToolboxPublicationCrashError
    );
    assert.equal(fs.readFileSync(target, 'utf8'), 'new');

    const recovered = recoverPendingToolboxPublications({ userDataDir: ctx.userDataDir });
    assert.deepEqual(recovered.recovered.map((item) => item.action), ['commit-cleanup']);
    assert.deepEqual(recovered.recovered[0].batchContext, BATCH_CONTEXT);
    assert.equal(recovered.recovered[0].files[0].role, 'output');
    assert.equal(recovered.recovered[0].files[0].filePath, target);
    assert.equal(fs.readFileSync(target, 'utf8'), 'new');
    assert.deepEqual(indexValue(ctx).entries, []);
    assert.deepEqual(taskFiles(ctx), []);
  });

  test('committed owner 未确认耐久接管时保留 journal，确认后才释放', () => {
    const ctx = makeContext();
    const source = writeFile(path.join(ctx.generationDir, 'source.xlsx'), 'new');
    const target = writeFile(path.join(ctx.outputDir, 'target.xlsx'), 'old');
    const prepared = prepareToolboxPublication({
      taskId: 'commit-owner-handoff',
      artifacts: [validatedArtifact(source)],
      targets: [target],
      userDataDir: ctx.userDataDir,
      batchContext: BATCH_CONTEXT,
      requireValidatedArtifacts: true,
      checkpoint(name) {
        if (name === 'publish:after-committed') {
          throw new ToolboxPublicationCrashError(name);
        }
      }
    });
    assert.throws(
      () => publishPreparedToolboxPublication(prepared),
      ToolboxPublicationCrashError
    );

    const deferred = recoverPendingToolboxPublications({
      userDataDir: ctx.userDataDir,
      deferCommittedRecovery: true
    });
    assert.deepEqual(
      deferred.recovered.map((item) => item.action),
      ['commit-handoff-pending']
    );
    assert.equal(indexValue(ctx).entries.length, 1);
    assert.ok(fs.existsSync(prepared.journalPath));
    assert.equal(fs.readFileSync(target, 'utf8'), 'new');

    const recovered = recoverPendingToolboxPublications({
      userDataDir: ctx.userDataDir,
      deferCommittedRecovery: true,
      acknowledgedCommittedTaskIds: ['commit-owner-handoff']
    });
    assert.deepEqual(recovered.recovered.map((item) => item.action), ['commit-cleanup']);
    assert.deepEqual(indexValue(ctx).entries, []);
    assert.deepEqual(taskFiles(ctx), []);
  });

  test('committed 后普通检查点异常仍返回成功，不能把已提交文件回滚', () => {
    const ctx = makeContext();
    const source = writeFile(path.join(ctx.generationDir, 'source.xlsx'), 'new');
    const target = writeFile(path.join(ctx.outputDir, 'target.xlsx'), 'old');
    const prepared = prepareToolboxPublication({
      taskId: 'error-after-commit',
      artifacts: [source],
      targets: [target],
      userDataDir: ctx.userDataDir,
      checkpoint(name) {
        if (name === 'publish:after-committed') throw new Error('post-commit hook failed');
      }
    });

    const result = publishPreparedToolboxPublication(prepared);
    assert.equal(result.committed, true);
    assert.equal(fs.readFileSync(target, 'utf8'), 'new');
    assert.ok(result.warnings.some((warning) => warning.includes('post-commit hook failed')));
    assert.deepEqual(indexValue(ctx).entries, []);
  });

  test('committed 后 index 原子更新失败时返回成功并保留恢复职责供下次收尾', () => {
    const ctx = makeContext();
    const source = writeFile(path.join(ctx.generationDir, 'source.xlsx'), 'new');
    const target = writeFile(path.join(ctx.outputDir, 'target.xlsx'), 'old');
    const indexPath = path.join(ctx.userDataDir, JOURNAL_INDEX_NAME);
    const fsImpl = Object.create(fs);
    let failNextIndexRename = false;
    fsImpl.renameSync = (from, to) => {
      if (failNextIndexRename && to === indexPath) {
        failNextIndexRename = false;
        throw new Error('injected index cleanup failure');
      }
      return fs.renameSync(from, to);
    };
    const prepared = prepareToolboxPublication({
      taskId: 'commit-cleanup-retry',
      artifacts: [source],
      targets: [target],
      userDataDir: ctx.userDataDir,
      fsImpl,
      checkpoint(name) {
        if (name === 'publish:after-committed') failNextIndexRename = true;
      }
    });

    const result = publishPreparedToolboxPublication(prepared);
    assert.equal(result.committed, true);
    assert.equal(result.pendingCleanup, true);
    assert.equal(fs.readFileSync(target, 'utf8'), 'new');
    assert.equal(indexValue(ctx).entries.length, 1);

    const recovered = recoverPendingToolboxPublications({ userDataDir: ctx.userDataDir });
    assert.deepEqual(recovered.recovered.map((item) => item.action), ['commit-cleanup']);
    assert.equal(fs.readFileSync(target, 'utf8'), 'new');
    assert.deepEqual(indexValue(ctx).entries, []);
  });

  test('committed 后 journal 删除失败时固定 finalizing index 保留恢复职责', () => {
    const ctx = makeContext();
    const source = writeFile(path.join(ctx.generationDir, 'source.xlsx'), 'new');
    const target = writeFile(path.join(ctx.outputDir, 'target.xlsx'), 'old');
    const fsImpl = Object.create(fs);
    let failJournalRemoval = false;
    fsImpl.rmSync = (targetPath, options) => {
      if (failJournalRemoval && targetPath.endsWith('.journal.json')) {
        failJournalRemoval = false;
        throw new Error('injected journal cleanup failure');
      }
      return fs.rmSync(targetPath, options);
    };
    const prepared = prepareToolboxPublication({
      taskId: 'commit-journal-cleanup-retry',
      artifacts: [source],
      targets: [target],
      userDataDir: ctx.userDataDir,
      fsImpl,
      checkpoint(name) {
        if (name === 'publish:after-committed') failJournalRemoval = true;
      }
    });

    const result = publishPreparedToolboxPublication(prepared);
    assert.equal(result.committed, true);
    assert.equal(result.pendingCleanup, true);
    assert.equal(fs.readFileSync(target, 'utf8'), 'new');
    assert.equal(indexValue(ctx).entries[0].discoveryState, 'finalizing');
    assert.ok(taskFiles(ctx).some((name) => name.endsWith('.journal.json')));

    const recovered = recoverPendingToolboxPublications({ userDataDir: ctx.userDataDir });
    assert.deepEqual(recovered.recovered.map((item) => item.action), ['commit-cleanup']);
    assert.equal(fs.readFileSync(target, 'utf8'), 'new');
    assert.deepEqual(indexValue(ctx).entries, []);
    assert.deepEqual(taskFiles(ctx), []);
  });

  test('committed journal 已删除但 index 删除失败时 finalizing intent 可独立收尾', () => {
    const ctx = makeContext();
    const source = writeFile(path.join(ctx.generationDir, 'source.xlsx'), 'new');
    const target = writeFile(path.join(ctx.outputDir, 'target.xlsx'), 'old');
    const indexPath = path.join(ctx.userDataDir, JOURNAL_INDEX_NAME);
    const fsImpl = Object.create(fs);
    let indexRenamesAfterCommit = 0;
    let committed = false;
    fsImpl.renameSync = (from, to) => {
      if (committed && to === indexPath) {
        indexRenamesAfterCommit += 1;
        if (indexRenamesAfterCommit === 2) {
          throw new Error('injected final index cleanup failure');
        }
      }
      return fs.renameSync(from, to);
    };
    const prepared = prepareToolboxPublication({
      taskId: 'commit-index-finalizing-retry',
      artifacts: [source],
      targets: [target],
      userDataDir: ctx.userDataDir,
      fsImpl,
      checkpoint(name) {
        if (name === 'publish:after-committed') committed = true;
      }
    });

    const result = publishPreparedToolboxPublication(prepared);
    assert.equal(result.committed, true);
    assert.equal(result.pendingCleanup, true);
    assert.equal(fs.readFileSync(target, 'utf8'), 'new');
    assert.equal(indexValue(ctx).entries[0].discoveryState, 'finalizing');
    assert.deepEqual(taskFiles(ctx), [], 'journal/backup/staging 均已删除');

    const recovered = recoverPendingToolboxPublications({ userDataDir: ctx.userDataDir });
    assert.deepEqual(recovered.recovered.map((item) => item.action), ['commit-cleanup']);
    assert.equal(fs.readFileSync(target, 'utf8'), 'new');
    assert.deepEqual(indexValue(ctx).entries, []);
  });

  test('崩溃后正式目标被外部改写时进入 manual-recovery，绝不删除外部文件', () => {
    const ctx = makeContext();
    const source = writeFile(path.join(ctx.generationDir, 'source.xlsx'), 'new');
    const target = writeFile(path.join(ctx.outputDir, 'target.xlsx'), 'old');
    const prepared = prepareToolboxPublication({
      taskId: 'external-rewrite',
      artifacts: [source],
      targets: [target],
      userDataDir: ctx.userDataDir,
      checkpoint(name) {
        if (name === 'publish:after-publish-rename-before-journal') {
          throw new ToolboxPublicationCrashError(name);
        }
      }
    });

    assert.throws(
      () => publishPreparedToolboxPublication(prepared),
      ToolboxPublicationCrashError
    );
    fs.writeFileSync(target, 'external-change');

    assert.throws(
      () => recoverPendingToolboxPublications({ userDataDir: ctx.userDataDir }),
      (error) => {
        assert.ok(error instanceof ToolboxPublicationManualRecoveryError);
        assert.match(error.detailLines.join('\n'), /外部改写/);
        assert.ok(error.recoveryPaths.includes(target));
        return true;
      }
    );
    assert.equal(fs.readFileSync(target, 'utf8'), 'external-change');
    assert.equal(indexValue(ctx).entries.length, 1);
    assert.ok(taskFiles(ctx).some((name) => name.endsWith('.backup')));
    assert.ok(taskFiles(ctx).some((name) => name.endsWith('.journal.json')));
  });

  test('index 指向缺失 journal 时保留 index 并阻断恢复和新任务', () => {
    const ctx = makeContext();
    const missingJournal = path.join(ctx.outputDir, '.missing.journal.json');
    fs.writeFileSync(path.join(ctx.userDataDir, JOURNAL_INDEX_NAME), JSON.stringify({
      version: 1,
      entries: [{
        taskId: 'missing-journal',
        journalAbsolutePath: missingJournal,
        createdAt: '2026-07-29T00:00:00.000Z'
      }]
    }));

    assert.throws(
      () => recoverPendingToolboxPublications({ userDataDir: ctx.userDataDir }),
      ToolboxPublicationManualRecoveryError
    );
    assert.equal(indexValue(ctx).entries.length, 1);

    const source = writeFile(path.join(ctx.generationDir, 'source.xlsx'), 'new');
    const target = path.join(ctx.outputDir, 'target.xlsx');
    assert.throws(
      () => prepareToolboxPublication({
        taskId: 'blocked-by-recovery',
        artifacts: [source],
        targets: [target],
        userDataDir: ctx.userDataDir
      }),
      ToolboxPublicationManualRecoveryError
    );
    assert.equal(fs.existsSync(target), false);
  });

  test('journal 路径结构被篡改时 fail-closed，不按篡改路径删除文件', () => {
    const ctx = makeContext();
    const source = writeFile(path.join(ctx.generationDir, 'source.xlsx'), 'new');
    const target = path.join(ctx.outputDir, 'target.xlsx');
    const victim = writeFile(path.join(ctx.outputDir, 'victim.xlsx'), 'keep-me');
    assert.throws(
      () => prepareToolboxPublication({
        taskId: 'corrupt-journal',
        artifacts: [source],
        targets: [target],
        userDataDir: ctx.userDataDir,
        checkpoint(name) {
          if (name === 'prepare:after-index') throw new ToolboxPublicationCrashError(name);
        }
      }),
      ToolboxPublicationCrashError
    );
    const journalPath = indexValue(ctx).entries[0].journalAbsolutePath;
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
    journal.entries[0].stagedPath = victim;
    fs.writeFileSync(journalPath, JSON.stringify(journal));

    assert.throws(
      () => recoverPendingToolboxPublications({ userDataDir: ctx.userDataDir }),
      ToolboxPublicationManualRecoveryError
    );
    assert.equal(fs.readFileSync(victim, 'utf8'), 'keep-me');
    assert.equal(indexValue(ctx).entries.length, 1);
  });

  test('新式 prepared index 与崩溃 journal 的 target 锚点不一致时绝不删除同 hash victim', () => {
    const ctx = makeContext();
    const source = writeFile(path.join(ctx.generationDir, 'source.xlsx'), 'new');
    const target = writeFile(path.join(ctx.outputDir, 'target.xlsx'), 'old');
    const victim = writeFile(path.join(ctx.outputDir, 'victim.xlsx'), 'new');
    const prepared = prepareToolboxPublication({
      taskId: 'tampered-recovery-target-anchor',
      artifacts: [validatedArtifact(source)],
      targets: [target],
      userDataDir: ctx.userDataDir,
      requireValidatedArtifacts: true,
      checkpoint(name) {
        if (name === 'publish:after-publish-rename-before-journal') {
          throw new ToolboxPublicationCrashError(name);
        }
      }
    });

    assert.throws(
      () => publishPreparedToolboxPublication(prepared),
      ToolboxPublicationCrashError
    );
    const index = indexValue(ctx);
    assert.equal(index.entries[0].discoveryState, 'prepared');
    assert.equal(index.entries[0].targetAbsolutePaths[0], target);
    assert.equal(index.entries[0].backupAbsolutePaths.length, 1);
    const journalPath = index.entries[0].journalAbsolutePath;
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
    journal.entries[0].targetPath = victim;
    fs.writeFileSync(journalPath, JSON.stringify(journal));

    assert.throws(
      () => recoverPendingToolboxPublications({ userDataDir: ctx.userDataDir }),
      (error) => {
        assert.ok(error instanceof ToolboxPublicationManualRecoveryError);
        assert.match(error.message, /锚点不一致/);
        assert.ok(error.recoveryPaths.includes(target));
        assert.ok(!error.recoveryPaths.includes(victim));
        return true;
      }
    );
    assert.equal(fs.readFileSync(victim, 'utf8'), 'new');
    assert.equal(fs.readFileSync(target, 'utf8'), 'new');
    assert.equal(fs.readFileSync(index.entries[0].backupAbsolutePaths[0], 'utf8'), 'old');
    assert.equal(indexValue(ctx).entries.length, 1);
    assert.ok(fs.existsSync(journalPath));
  });

  test('存量 v1 崩溃 journal 重定向到同 hash victim 时 manual-only 且零文件改动', () => {
    const ctx = makeContext();
    const source = writeFile(path.join(ctx.generationDir, 'source.xlsx'), 'new');
    const target = writeFile(path.join(ctx.outputDir, 'target.xlsx'), 'old');
    const victim = writeFile(path.join(ctx.outputDir, 'victim.xlsx'), 'new');
    const prepared = prepareToolboxPublication({
      taskId: 'legacy-v1-tampered-target',
      artifacts: [validatedArtifact(source)],
      targets: [target],
      userDataDir: ctx.userDataDir,
      requireValidatedArtifacts: true,
      checkpoint(name) {
        if (name === 'publish:after-publish-rename-before-journal') {
          throw new ToolboxPublicationCrashError(name);
        }
      }
    });

    assert.throws(
      () => publishPreparedToolboxPublication(prepared),
      ToolboxPublicationCrashError
    );
    const indexPath = path.join(ctx.userDataDir, JOURNAL_INDEX_NAME);
    const index = indexValue(ctx);
    const backupPath = index.entries[0].backupAbsolutePaths[0];
    for (const key of [
      'discoveryState',
      'nonce',
      'stagedAbsolutePaths',
      'targetAbsolutePaths',
      'backupAbsolutePaths'
    ]) {
      delete index.entries[0][key];
    }
    fs.writeFileSync(indexPath, JSON.stringify(index));
    const journalPath = index.entries[0].journalAbsolutePath;
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
    journal.entries[0].targetPath = victim;
    fs.writeFileSync(journalPath, JSON.stringify(journal));

    assert.throws(
      () => recoverPendingToolboxPublications({ userDataDir: ctx.userDataDir }),
      (error) => {
        assert.ok(error instanceof ToolboxPublicationManualRecoveryError);
        assert.match(error.message, /存量 v1/);
        return true;
      }
    );
    assert.equal(fs.readFileSync(target, 'utf8'), 'new');
    assert.equal(fs.readFileSync(victim, 'utf8'), 'new');
    assert.equal(fs.readFileSync(backupPath, 'utf8'), 'old');
    assert.ok(fs.existsSync(journalPath));
    assert.deepEqual(indexValue(ctx), index);
  });

  test('journal 中 NFC/NFD 目标别名碰撞时恢复入口 fail-closed', () => {
    const ctx = makeContext();
    const sourceA = writeFile(path.join(ctx.generationDir, 'unicode-a.xlsx'), 'new-a');
    const sourceB = writeFile(path.join(ctx.generationDir, 'unicode-b.xlsx'), 'new-b');
    const targetNfc = writeFile(path.join(ctx.outputDir, '\u00e9.xlsx'), 'old-a');
    const targetB = writeFile(path.join(ctx.outputDir, 'other.xlsx'), 'old-b');
    assert.throws(
      () => prepareToolboxPublication({
        taskId: 'unicode-journal-collision',
        artifacts: [sourceA, sourceB],
        targets: [targetNfc, targetB],
        userDataDir: ctx.userDataDir,
        checkpoint(name) {
          if (name === 'prepare:after-index') throw new ToolboxPublicationCrashError(name);
        }
      }),
      ToolboxPublicationCrashError
    );
    const journalPath = indexValue(ctx).entries[0].journalAbsolutePath;
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
    journal.entries[1].targetPath = path.join(ctx.outputDir, 'e\u0301.xlsx');
    fs.writeFileSync(journalPath, JSON.stringify(journal));

    assert.throws(
      () => recoverPendingToolboxPublications({ userDataDir: ctx.userDataDir }),
      ToolboxPublicationManualRecoveryError
    );
    assert.equal(fs.readFileSync(targetNfc, 'utf8'), 'old-a');
    assert.equal(fs.readFileSync(targetB, 'utf8'), 'old-b');
  });

  test('恢复索引中的 NFC/NFD journal 别名碰撞会阻断恢复', () => {
    const ctx = makeContext();
    fs.writeFileSync(path.join(ctx.userDataDir, JOURNAL_INDEX_NAME), JSON.stringify({
      version: 1,
      entries: [
        {
          taskId: 'unicode-index-a',
          journalAbsolutePath: path.join(ctx.outputDir, '.\u00e9.journal.json')
        },
        {
          taskId: 'unicode-index-b',
          journalAbsolutePath: path.join(ctx.outputDir, '.e\u0301.journal.json')
        }
      ]
    }));

    assert.throws(
      () => recoverPendingToolboxPublications({ userDataDir: ctx.userDataDir }),
      ToolboxPublicationManualRecoveryError
    );
  });

  test('恢复索引把 target/stage/backup/journal 锚到固定 indexPath 时在读取阶段 fail-closed', () => {
    const ctx = makeContext();
    const nonce = 'index-self-alias';
    const indexPath = path.join(ctx.userDataDir, JOURNAL_INDEX_NAME);
    const index = {
      version: 1,
      entries: [{
        taskId: 'index-self-alias',
        journalAbsolutePath: path.join(
          ctx.userDataDir,
          `.toolbox-publish-index-self-alias-${nonce}.journal.json`
        ),
        createdAt: '2026-07-30T00:00:00.000Z',
        discoveryState: 'prepared',
        nonce,
        stagedAbsolutePaths: [
          path.join(ctx.userDataDir, `.toolbox-publish-${nonce}-1.stage`)
        ],
        targetAbsolutePaths: [indexPath],
        backupAbsolutePaths: [
          path.join(ctx.userDataDir, `.toolbox-publish-${nonce}-1.backup`)
        ]
      }]
    };
    fs.writeFileSync(indexPath, JSON.stringify(index));

    assert.throws(
      () => recoverPendingToolboxPublications({ userDataDir: ctx.userDataDir }),
      (error) => {
        assert.ok(error instanceof ToolboxPublicationManualRecoveryError);
        assert.match(error.message, /恢复索引结构无效/);
        return true;
      }
    );
    assert.deepEqual(indexValue(ctx), index);
    assert.deepEqual(taskFiles(ctx), []);
  });

  test('prepare 后目标被外部创建时取消任务并保留外部目标', () => {
    const ctx = makeContext();
    const source = writeFile(path.join(ctx.generationDir, 'source.xlsx'), 'new');
    const target = path.join(ctx.outputDir, 'target.xlsx');
    const prepared = prepareToolboxPublication({
      taskId: 'changed-before-publish',
      artifacts: [source],
      targets: [target],
      userDataDir: ctx.userDataDir
    });
    fs.writeFileSync(target, 'external');

    assert.throws(
      () => publishPreparedToolboxPublication(prepared),
      /准备完成后被创建/
    );
    assert.equal(fs.readFileSync(target, 'utf8'), 'external');
    assert.deepEqual(indexValue(ctx).entries, []);
    assert.deepEqual(taskFiles(ctx), []);
  });

  test('prepared 取消时 journal 删除失败保留 cancelling index 并可由下次恢复收尾', () => {
    const ctx = makeContext();
    const source = writeFile(path.join(ctx.generationDir, 'source.xlsx'), 'new');
    const target = path.join(ctx.outputDir, 'target.xlsx');
    const fsImpl = Object.create(fs);
    const originalRmSync = fs.rmSync;
    let failJournalRemoval = false;
    fsImpl.rmSync = (filePath, options) => {
      if (failJournalRemoval && filePath.endsWith('.journal.json')) {
        throw new Error('injected cancel journal removal failure');
      }
      return originalRmSync(filePath, options);
    };
    const prepared = prepareToolboxPublication({
      taskId: 'cancel-journal-removal-retry',
      artifacts: [validatedArtifact(source)],
      targets: [target],
      userDataDir: ctx.userDataDir,
      requireValidatedArtifacts: true,
      fsImpl
    });
    fs.writeFileSync(target, 'external');
    failJournalRemoval = true;

    assert.throws(
      () => publishPreparedToolboxPublication(prepared),
      ToolboxPublicationManualRecoveryError
    );
    assert.equal(fs.readFileSync(target, 'utf8'), 'external');
    assert.equal(indexValue(ctx).entries[0].discoveryState, 'cancelling');
    assert.ok(fs.existsSync(prepared.journalPath));

    failJournalRemoval = false;
    const recovered = recoverPendingToolboxPublications({
      userDataDir: ctx.userDataDir,
      fsImpl
    });
    assert.deepEqual(recovered.recovered.map((item) => item.action), ['cancelled']);
    assert.equal(fs.readFileSync(target, 'utf8'), 'external');
    assert.deepEqual(indexValue(ctx).entries, []);
    assert.deepEqual(taskFiles(ctx), []);
  });

  test('prepared 取消会在移除固定 index 前 fsync 每个 staging 所在目录', () => {
    const ctx = makeContext();
    const sourceA = writeFile(path.join(ctx.generationDir, 'a.xlsx'), 'a');
    const sourceB = writeFile(path.join(ctx.generationDir, 'b.xlsx'), 'b');
    const outputDirA = path.join(ctx.outputDir, 'a');
    const outputDirB = path.join(ctx.outputDir, 'b');
    fs.mkdirSync(outputDirA);
    fs.mkdirSync(outputDirB);
    const targetA = path.join(outputDirA, 'a.xlsx');
    const targetB = path.join(outputDirB, 'b.xlsx');
    const fsImpl = Object.create(fs);
    const openedPaths = new Map();
    const fsyncedPaths = [];
    let recordFsync = false;
    fsImpl.openSync = (filePath, ...args) => {
      const fd = fs.openSync(filePath, ...args);
      openedPaths.set(fd, path.resolve(String(filePath)));
      return fd;
    };
    fsImpl.fsyncSync = (fd) => {
      if (recordFsync && openedPaths.has(fd)) {
        fsyncedPaths.push(openedPaths.get(fd));
      }
      return fs.fsyncSync(fd);
    };
    fsImpl.closeSync = (fd) => {
      try {
        return fs.closeSync(fd);
      } finally {
        openedPaths.delete(fd);
      }
    };
    const prepared = prepareToolboxPublication({
      taskId: 'cancel-fsync-every-staging-directory',
      artifacts: [validatedArtifact(sourceA), validatedArtifact(sourceB)],
      targets: [targetA, targetB],
      userDataDir: ctx.userDataDir,
      requireValidatedArtifacts: true,
      fsImpl
    });
    fs.writeFileSync(targetA, 'external');
    recordFsync = true;

    assert.throws(
      () => publishPreparedToolboxPublication(prepared),
      /准备完成后被创建/
    );
    assert.ok(
      fsyncedPaths.includes(path.resolve(outputDirB)),
      '第二个 target 目录只承载 staging，取消时也必须持久化其删除'
    );
    assert.equal(fs.existsSync(prepared.artifacts[0].stagedPath), false);
    assert.equal(fs.existsSync(prepared.artifacts[1].stagedPath), false);
    assert.deepEqual(indexValue(ctx).entries, []);
  });

  test('进程内 active task 会保留恢复资格并阻止相同 target 被二次 reserve', () => {
    const ctx = makeContext();
    const sourceA = writeFile(path.join(ctx.generationDir, 'a.xlsx'), 'a');
    const sourceB = writeFile(path.join(ctx.generationDir, 'b.xlsx'), 'b');
    const target = path.join(ctx.outputDir, 'target.xlsx');
    const prepared = prepareToolboxPublication({
      taskId: 'active-a',
      artifacts: [sourceA],
      targets: [target],
      userDataDir: ctx.userDataDir
    });

    assert.throws(
      () => prepareToolboxPublication({
        taskId: 'active-b',
        artifacts: [sourceB],
        targets: [target],
        userDataDir: ctx.userDataDir
      }),
      /正被任务 active-a 使用/
    );
    assert.equal(indexValue(ctx).entries.length, 1);

    publishPreparedToolboxPublication(prepared);
    assert.equal(fs.readFileSync(target, 'utf8'), 'a');
  });

  test('进程内 reservation 会阻止 NFC/NFD 目标别名被另一任务占用', () => {
    const ctx = makeContext();
    const sourceA = writeFile(path.join(ctx.generationDir, 'unicode-a.xlsx'), 'a');
    const sourceB = writeFile(path.join(ctx.generationDir, 'unicode-b.xlsx'), 'b');
    const targetNfc = path.join(ctx.outputDir, '\u00e9.xlsx');
    const targetNfd = path.join(ctx.outputDir, 'e\u0301.xlsx');
    const prepared = prepareToolboxPublication({
      taskId: 'unicode-reservation-a',
      artifacts: [sourceA],
      targets: [targetNfc],
      userDataDir: ctx.userDataDir
    });

    assert.throws(
      () => prepareToolboxPublication({
        taskId: 'unicode-reservation-b',
        artifacts: [sourceB],
        targets: [targetNfd],
        userDataDir: ctx.userDataDir
      }),
      (error) => {
        assert.equal(error.code, 'TOOLBOX_PUBLICATION_TARGET_RESERVED');
        return true;
      }
    );

    publishPreparedToolboxPublication(prepared);
    assert.equal(fs.readFileSync(targetNfc, 'utf8'), 'a');
  });

  test('下一次 prepare 自动恢复上次崩溃任务，再准备新目标', () => {
    const ctx = makeContext();
    const oldSource = writeFile(path.join(ctx.generationDir, 'old-source.xlsx'), 'new-old');
    const oldTarget = writeFile(path.join(ctx.outputDir, 'old-target.xlsx'), 'old');
    const crashed = prepareToolboxPublication({
      taskId: 'auto-recover-old',
      artifacts: [oldSource],
      targets: [oldTarget],
      userDataDir: ctx.userDataDir,
      checkpoint(name) {
        if (name === 'publish:after-publish-rename-before-journal') {
          throw new ToolboxPublicationCrashError(name);
        }
      }
    });
    assert.throws(
      () => publishPreparedToolboxPublication(crashed),
      ToolboxPublicationCrashError
    );

    const newSource = writeFile(path.join(ctx.generationDir, 'new-source.xlsx'), 'new');
    const newTarget = path.join(ctx.outputDir, 'new-target.xlsx');
    const next = prepareToolboxPublication({
      taskId: 'after-auto-recovery',
      artifacts: [newSource],
      targets: [newTarget],
      userDataDir: ctx.userDataDir
    });

    assert.equal(fs.readFileSync(oldTarget, 'utf8'), 'old');
    assert.equal(indexValue(ctx).entries.length, 1);
    assert.equal(indexValue(ctx).entries[0].taskId, 'after-auto-recovery');
    publishPreparedToolboxPublication(next);
  });

  test('prepare 已登记 index 但尚未发布时崩溃，只清任务 staging，不检查或修改目标', () => {
    const ctx = makeContext();
    const source = writeFile(path.join(ctx.generationDir, 'source.xlsx'), 'new');
    const target = path.join(ctx.outputDir, 'target.xlsx');
    assert.throws(
      () => prepareToolboxPublication({
        taskId: 'crash-after-prepare-index',
        artifacts: [source],
        targets: [target],
        userDataDir: ctx.userDataDir,
        checkpoint(name) {
          if (name === 'prepare:after-index') throw new ToolboxPublicationCrashError(name);
        }
      }),
      ToolboxPublicationCrashError
    );
    fs.writeFileSync(target, 'created-by-user-after-crash');

    const recovered = recoverPendingToolboxPublications({ userDataDir: ctx.userDataDir });
    assert.deepEqual(recovered.recovered.map((item) => item.action), ['cancelled-prepared']);
    assert.equal(fs.readFileSync(target, 'utf8'), 'created-by-user-after-crash');
    assert.deepEqual(indexValue(ctx).entries, []);
    assert.deepEqual(taskFiles(ctx), []);
  });

  test('dispose 只清理 generation 源文件，不删除正式目标', () => {
    const ctx = makeContext();
    const source = writeFile(path.join(ctx.generationDir, 'source.xlsx'), 'new');
    const target = writeFile(path.join(ctx.outputDir, 'target.xlsx'), 'target');
    const result = disposeToolboxGeneration({
      artifacts: [{ sourcePath: source, targetPath: target }]
    });

    assert.deepEqual(result.disposed, [source]);
    assert.equal(fs.existsSync(source), false);
    assert.equal(fs.readFileSync(target, 'utf8'), 'target');
  });
});
