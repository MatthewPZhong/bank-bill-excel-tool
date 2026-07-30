'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  JOURNAL_INDEX_NAME,
  ToolboxPublicationCrashError,
  ToolboxPublicationManualRecoveryError,
  disposeToolboxGeneration,
  prepareToolboxPublication,
  publishPreparedToolboxPublication,
  recoverPendingToolboxPublications
} = require('../../src/main-process/toolbox-output-publication');

const tmpDirs = [];

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

function indexValue(ctx) {
  const indexPath = path.join(ctx.userDataDir, JOURNAL_INDEX_NAME);
  return JSON.parse(fs.readFileSync(indexPath, 'utf8'));
}

function taskFiles(ctx) {
  return fs.readdirSync(ctx.outputDir)
    .filter((name) => name.startsWith('.toolbox-publish-'))
    .sort();
}

test.describe('toolbox output publication', () => {
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

  test('崩溃在 staged rename 与 journal 更新之间，按文件 hash 识别并回滚', () => {
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

  test('committed journal 已落盘后崩溃只做收尾，不回滚新文件', () => {
    const ctx = makeContext();
    const source = writeFile(path.join(ctx.generationDir, 'source.xlsx'), 'new');
    const target = writeFile(path.join(ctx.outputDir, 'target.xlsx'), 'old');
    const prepared = prepareToolboxPublication({
      taskId: 'crash-after-commit',
      artifacts: [source],
      targets: [target],
      userDataDir: ctx.userDataDir,
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
    assert.equal(fs.readFileSync(target, 'utf8'), 'new');
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
