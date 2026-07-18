'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { stageUpdateArtifacts } = require('../../scripts/stage-update-artifacts');

function createFixture(t, {
  metadataPath = 'bank-bill-excel-tool-setup-3.0.18.exe',
  metadataVersion = '3.0.18',
  badHash = false
} = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-update-artifacts-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const sourceName = '清结算小助手-3.0.18-setup.exe';
  const sourcePath = path.join(directory, sourceName);
  const setupBytes = Buffer.from('setup fixture');
  fs.writeFileSync(sourcePath, setupBytes);
  fs.writeFileSync(`${sourcePath}.blockmap`, 'blockmap fixture');
  const sourcePortablePath = path.join(directory, '清结算小助手-3.0.18-portable.exe');
  fs.writeFileSync(sourcePortablePath, 'portable fixture');
  const sha512 = crypto.createHash('sha512').update(setupBytes).digest('base64');
  fs.writeFileSync(path.join(directory, 'latest.yml'), [
    `version: ${metadataVersion}`,
    `path: ${metadataPath}`,
    `sha512: ${badHash ? 'invalid' : sha512}`,
    ''
  ].join('\n'));
  return { directory, sourcePath, sourcePortablePath, metadataPath };
}

test('按发布安全名称复制 setup、blockmap 和 portable，并校验 SHA512', (t) => {
  const fixture = createFixture(t);

  const result = stageUpdateArtifacts(fixture.directory);

  assert.equal(result.releaseSetupName, fixture.metadataPath);
  assert.deepEqual(
    fs.readFileSync(result.releaseSetupPath),
    fs.readFileSync(fixture.sourcePath)
  );
  assert.equal(fs.readFileSync(result.releaseBlockmapPath, 'utf8'), 'blockmap fixture');
  assert.equal(result.releasePortableName, 'bank-bill-excel-tool-portable-3.0.18.exe');
  assert.deepEqual(
    fs.readFileSync(result.releasePortablePath),
    fs.readFileSync(fixture.sourcePortablePath)
  );
});

test('拒绝哈希不匹配、非法版本和包含目录穿越的 metadata', (t) => {
  const badHash = createFixture(t, { badHash: true });
  assert.throws(() => stageUpdateArtifacts(badHash.directory), /SHA512/);

  const traversal = createFixture(t, { metadataPath: '..\\update.exe' });
  assert.throws(() => stageUpdateArtifacts(traversal.directory), /path 非法/);

  const invalidVersion = createFixture(t, { metadataVersion: '../3.0.18' });
  assert.throws(() => stageUpdateArtifacts(invalidVersion.directory), /version 非法/);
});

test('拒绝缺失或重复的原始 portable，避免发布资产选择歧义', (t) => {
  const missing = createFixture(t);
  fs.rmSync(missing.sourcePortablePath);
  assert.throws(() => stageUpdateArtifacts(missing.directory), /原始 portable.*0 个/);

  const duplicate = createFixture(t);
  fs.writeFileSync(path.join(duplicate.directory, '另一个-3.0.18-portable.exe'), 'duplicate');
  assert.throws(() => stageUpdateArtifacts(duplicate.directory), /原始 portable.*2 个/);
});
