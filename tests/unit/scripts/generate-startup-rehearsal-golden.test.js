'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  generateRehearsalGolden,
  readLogicalFingerprint
} = require('../../../scripts/generate-startup-rehearsal-golden');

test('small deterministic rehearsal golden 只生成 current 小库且 manifest 强制 not-evaluated', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'startup-rehearsal-golden-'));
  const first = generateRehearsalGolden(path.join(root, 'first'));
  const second = generateRehearsalGolden(path.join(root, 'second'));
  assert.equal(first.manifest.mode, 'rehearsal');
  assert.equal(first.manifest.evaluation.status, 'not-evaluated');
  assert.equal(first.manifest.formalUseAllowed, false);
  assert.equal(first.manifest.synthetic, true);
  assert.ok(first.manifest.sizeBytes < 10 * 1024 * 1024);
  assert.deepEqual(readLogicalFingerprint(first.databasePath), readLogicalFingerprint(second.databasePath));
  assert.equal(JSON.stringify(first.manifest).includes(root), false);
});
