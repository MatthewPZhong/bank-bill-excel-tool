'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  identityInteger, identityStatView, readHandleIdentityStat, readIdentityStat, readIdentityStatSync
} = require('../../../src/main-process/archive-center/filesystem-identity');
const { sourceSnapshotFromStat } = require('../../../src/main-process/archive-center/source-snapshot');

const { verifyLargeArchiveIdentity } = require('../../fixtures/archive-permanent-delete-high-identity');

const HIGH = 1n << 60n;

test('单次 BigInt stat/fstat 保留相邻高位身份和原小数毫秒，不接受已舍入 Number', async () => {
  const raw = { dev: 123n, ino: HIGH + 1n, size: 12n, mode: 0o100600n, nlink: 1n,
    mtimeMs: 1763597869000n, mtimeNs: 1763597869000123456n,
    ctimeMs: 1763597869000n, ctimeNs: 1763597869000456789n,
    birthtimeMs: 1763597868000n, birthtimeNs: 1763597868000789123n,
    isFile() { return this.mode === 0o100600n; }, isSymbolicLink: () => false };
  let calls = 0;
  const capture = (_target, options) => { calls += 1; assert.deepEqual(options, { bigint: true }); return raw; };
  const fsImpl = { statSync: capture, lstatSync: capture, fstatSync: capture,
    promises: { stat: capture, lstat: capture } };
  const views = [readIdentityStatSync(fsImpl, 'file'), readIdentityStatSync(fsImpl, 12, 'fstatSync'),
    await readIdentityStat(fsImpl, 'file', 'stat'), await readHandleIdentityStat({ stat: (options) => capture(12, options) })];
  assert.equal(calls, 4, '每个快照只读取一次，不拼接两次 stat');
  for (const view of views) {
    assert.equal(view.ino, (HIGH + 1n).toString());
    assert.equal(view.dev, '123');
    assert.equal(view.size, 12); assert.equal(view.mode, 0o100600); assert.equal(view.nlink, 1);
    assert.equal(view.isFile(), true);
    assert.deepEqual(sourceSnapshotFromStat(view), sourceSnapshotFromStat(raw));
    assert.equal(view.birthtimeMs, 1763597868000.789123);
    assert.doesNotThrow(() => JSON.stringify(view));
  }
  assert.equal(Number(HIGH + 1n), Number(HIGH + 2n));
  assert.notEqual(identityStatView(raw).ino, identityStatView({ ...raw, ino: HIGH + 2n }).ino);
  assert.equal(identityInteger(Number(HIGH + 1n)), null);
  assert.equal(identityInteger(42), '42');
  assert.equal(identityInteger(42n), '42');
  assert.equal(identityInteger('42'), '42');
  assert.equal(identityInteger(0), null);
});

test('高位 dev/ino 可持久删除和只读副本；共享 Blob 保留，重启后低位不同的同内容替换仍拒绝', async () => {
  await verifyLargeArchiveIdentity();
});
