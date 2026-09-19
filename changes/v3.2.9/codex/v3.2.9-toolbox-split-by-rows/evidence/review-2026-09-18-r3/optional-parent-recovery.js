'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const snapshot = process.argv[2] || '/private/tmp/toolbox-rows-review-r3-f8ouloqk';
const pub = require(path.join(snapshot, 'src/main-process/toolbox-output-publication'));
const { captureTargetParentIdentity } = require(path.join(snapshot, 'src/main-process/archive-center/target-parent-identity'));
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'r3-parent-recovery-')));
try {
  const userDataDir = path.join(root, 'userData');
  const output = path.join(root, 'output');
  const moved = path.join(root, 'moved');
  const generation = path.join(root, 'generation');
  for (const directory of [userDataDir, output, generation]) fs.mkdirSync(directory);
  const artifact = path.join(generation, 'generated.xlsx');
  const target = path.join(output, 'out.xlsx');
  fs.writeFileSync(artifact, 'generated');
  const expectedTargetParentIdentity = captureTargetParentIdentity(fs, target);
  // Publisher-only probe: opaque bytes exercise filesystem recovery, not XLSX validation.
  // Omit requireTargetParentIdentity to match the current rows wrapper behavior.
  assert.throws(() => pub.prepareToolboxPublication({
    taskId: 'rows-optional-parent-recovery', userDataDir,
    targets: [{ targetPath: target, expectedTargetParentIdentity }],
    artifacts: [{ sourcePath: artifact, byteSize: 9,
      sha256: crypto.createHash('sha256').update('generated').digest('hex') }],
    requireValidatedArtifacts: true,
    checkpoint(name) {
      if (name === 'prepare:after-index') throw new pub.ToolboxPublicationCrashError(name);
    }
  }), pub.ToolboxPublicationCrashError);
  const indexPath = path.join(userDataDir, pub.JOURNAL_INDEX_NAME);
  const before = fs.readFileSync(indexPath, 'utf8');
  const entry = JSON.parse(before).entries[0];
  assert.equal(entry.targetParentIdentityRequired, undefined);
  assert.deepEqual(entry.expectedTargetParentIdentities, [expectedTargetParentIdentity]);
  fs.renameSync(output, moved);
  fs.mkdirSync(output);
  fs.writeFileSync(path.join(output, 'new-owner.txt'), 'keep');
  assert.throws(() => pub.recoverPendingToolboxPublications({ userDataDir }),
    { code: 'TOOLBOX_PUBLICATION_MANUAL_RECOVERY' });
  assert.equal(fs.readFileSync(indexPath, 'utf8'), before);
  assert.deepEqual(fs.readdirSync(output), ['new-owner.txt']);
  assert.equal(fs.readFileSync(path.join(output, 'new-owner.txt'), 'utf8'), 'keep');
  fs.rmSync(path.join(output, 'new-owner.txt'));
  fs.rmdirSync(output);
  fs.renameSync(moved, output);
  const restored = pub.recoverPendingToolboxPublications({ userDataDir });
  assert.deepEqual(restored.recovered.map(item => item.action), ['cancelled-prepared']);
  assert.equal(JSON.parse(fs.readFileSync(indexPath, 'utf8')).entries.length, 0);
  assert.deepEqual(fs.readdirSync(output), []);
  process.stdout.write(JSON.stringify({ status: 'PASS', runtime: process.version,
    optionalIdentityPersisted: true,
    replacedParentRecovery: 'TOOLBOX_PUBLICATION_MANUAL_RECOVERY',
    unknownDirectoryUntouched: true,
    restoredParentRecovery: 'cancelled-prepared' }) + '\n');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
