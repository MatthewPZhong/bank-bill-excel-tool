'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { stageUpdateArtifacts } = require('../../scripts/stage-update-artifacts');

function createFixture(t, { metadataPath = 'bank-bill-excel-tool-setup-3.0.18.exe', badHash = false } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-update-artifacts-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const sourceName = '清结算小助手-3.0.18-setup.exe';
  const sourcePath = path.join(directory, sourceName);
  const setupBytes = Buffer.from('setup fixture');
  fs.writeFileSync(sourcePath, setupBytes);
  fs.writeFileSync(`${sourcePath}.blockmap`, 'blockmap fixture');
  const sha512 = crypto.createHash('sha512').update(setupBytes).digest('base64');
  fs.writeFileSync(path.join(directory, 'latest.yml'), [
    'version: 3.0.18',
    `path: ${metadataPath}`,
    `sha512: ${badHash ? 'invalid' : sha512}`,
    ''
  ].join('\n'));
  return { directory, sourcePath, metadataPath };
}

test('按 latest.yml 名称复制 setup 和 blockmap，并校验 SHA512', (t) => {
  const fixture = createFixture(t);

  const result = stageUpdateArtifacts(fixture.directory);

  assert.equal(result.releaseSetupName, fixture.metadataPath);
  assert.deepEqual(
    fs.readFileSync(result.releaseSetupPath),
    fs.readFileSync(fixture.sourcePath)
  );
  assert.equal(fs.readFileSync(result.releaseBlockmapPath, 'utf8'), 'blockmap fixture');
});

test('拒绝哈希不匹配和包含目录穿越的 metadata path', (t) => {
  const badHash = createFixture(t, { badHash: true });
  assert.throws(() => stageUpdateArtifacts(badHash.directory), /SHA512/);

  const traversal = createFixture(t, { metadataPath: '..\\update.exe' });
  assert.throws(() => stageUpdateArtifacts(traversal.directory), /path 非法/);
});
