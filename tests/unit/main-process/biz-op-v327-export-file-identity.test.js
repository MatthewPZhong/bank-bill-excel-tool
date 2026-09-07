'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { exportFileIdentity, matchesExportFileIdentity } = require('../../../src/main-process/biz-op-v327/export-file-identity');
const { hashClosedFile } = require('../../../src/main-process/biz-op-v327/export-validator');
const { snapshot, hash } = require('../../../src/main-process/biz-op-v327/contracts');

test('超过安全整数的相邻 Windows 文件身份不会合并，凭据可无损序列化', () => {
  const before = { dev: 100n, ino: 9007199254740992n, size: 100n, mtimeNs: 1790000000123456789n, ctimeNs: 1790000000123456789n };
  const left = exportFileIdentity(before);
  const right = exportFileIdentity({ ...before, ino: before.ino + 1n });
  assert.notEqual(hash(left), hash(right));
  assert.equal(left.ino, '9007199254740992'); assert.equal(right.ino, '9007199254740993');
  assert.deepEqual(snapshot(left), left); assert.equal(left.mtimeNs, '1790000000123456789');
});

test('真实文件的新版身份、旧版安全身份与内容变更拒绝保持一致', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bizop-export-identity-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'output.xlsx'); fs.writeFileSync(file, 'frozen-output');
  const measured = await hashClosedFile(file);
  assert.equal(measured.fileIdentity.version, 2); assert.equal(measured.byteSize, 13);
  assert.equal(matchesExportFileIdentity(file, measured.fileIdentity), true);
  const stat = fs.lstatSync(file);
  const legacy = Object.fromEntries(['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].map(key => [key, stat[key]]));
  assert.equal(matchesExportFileIdentity(file, legacy), Number.isSafeInteger(stat.ino));
  assert.equal(matchesExportFileIdentity(file, { ...legacy, ino: Number.MAX_SAFE_INTEGER + 1 }), false);
  fs.appendFileSync(file, '-changed');
  assert.equal(matchesExportFileIdentity(file, measured.fileIdentity), false);
  assert.equal(matchesExportFileIdentity(file, legacy), false);
});
