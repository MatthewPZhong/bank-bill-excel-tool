'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  captureArchiveSourceSnapshots,
  collectArchiveCandidatePaths,
  normalizeSourceSnapshot,
  sourceSnapshotFromStat,
  sourceSnapshotForPath,
  sourceSnapshotMatchesStat
} = require('../../../src/main-process/archive-center/source-snapshot');

test('inode 使用无损十进制 token，并兼容旧数字型快照', () => {
  const largeInode = 9007199254740993123n;
  const stat = {
    size: 12n,
    mtimeMs: 34n,
    mtimeNs: 34123456789n,
    ctimeMs: 56n,
    ctimeNs: 56987654321n,
    ino: largeInode,
    isFile: () => true
  };
  assert.deepEqual(sourceSnapshotFromStat(stat), {
    sizeBytes: 12,
    mtimeMs: 34123.456789,
    ctimeMs: 56987.654321,
    ino: largeInode.toString(10)
  });
  assert.equal(normalizeSourceSnapshot({
    sizeBytes: 12,
    mtimeMs: 34123.456789,
    ctimeMs: 56987.654321,
    ino: 42
  }).ino, '42');
  const unsafeNumberSnapshot = normalizeSourceSnapshot({
    sizeBytes: 12,
    mtimeMs: 34123.456789,
    ctimeMs: 56987.654321,
    ino: Number.MAX_SAFE_INTEGER + 2
  });
  assert.equal(Object.hasOwn(unsafeNumberSnapshot, 'ino'), false);
  assert.equal(sourceSnapshotMatchesStat({
    sizeBytes: 12,
    mtimeMs: 34123.456789,
    ctimeMs: 56987.654321,
    ino: largeInode.toString(10)
  }, stat), true);
});

test('bigint Stats 与普通 Stats 严格等价，允许普通 Stats 省略不可靠 inode', (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-source-stat-time-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const filePath = path.join(tempDir, 'source.xlsx');
  fs.writeFileSync(filePath, 'source');

  const regularStat = fs.statSync(filePath);
  const bigintStat = fs.statSync(filePath, { bigint: true });
  const regularSnapshot = sourceSnapshotFromStat(regularStat);
  const bigintSnapshot = sourceSnapshotFromStat(bigintStat);

  assert.deepEqual({
    sizeBytes: bigintSnapshot.sizeBytes,
    mtimeMs: bigintSnapshot.mtimeMs,
    ctimeMs: bigintSnapshot.ctimeMs
  }, {
    sizeBytes: regularSnapshot.sizeBytes,
    mtimeMs: regularSnapshot.mtimeMs,
    ctimeMs: regularSnapshot.ctimeMs
  });
  if (regularSnapshot.ino === undefined) {
    assert.equal(Object.hasOwn(regularSnapshot, 'ino'), false);
  } else {
    assert.equal(bigintSnapshot.ino, regularSnapshot.ino);
  }
  assert.equal(sourceSnapshotMatchesStat(bigintSnapshot, regularStat), true);
  assert.equal(sourceSnapshotMatchesStat(regularSnapshot, bigintStat), true);
});

test('大 epoch 纳秒以商余数转换，且严格比较不引入容差', () => {
  const mtimeNs = 1763597869000000123n;
  const ctimeNs = 1763597869000000456n;
  const toMilliseconds = (nanoseconds) => (
    Number(nanoseconds / 1000000n) + Number(nanoseconds % 1000000n) / 1e6
  );
  const ordinaryStat = {
    size: 12,
    mtimeMs: toMilliseconds(mtimeNs),
    ctimeMs: toMilliseconds(ctimeNs),
    ino: 42,
    isFile: () => true
  };
  const bigintStat = {
    size: 12n,
    mtimeNs,
    ctimeNs,
    ino: 42n,
    isFile: () => true
  };

  assert.deepEqual(sourceSnapshotFromStat(bigintStat), sourceSnapshotFromStat(ordinaryStat));
  assert.equal(sourceSnapshotMatchesStat(sourceSnapshotFromStat(bigintStat), ordinaryStat), true);
  assert.equal(sourceSnapshotMatchesStat({
    ...sourceSnapshotFromStat(bigintStat),
    mtimeMs: ordinaryStat.mtimeMs + 0.001
  }, ordinaryStat), false);
});

test('收集业务输入与结果路径，并在返回业务结果时记录文件身份', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-source-snapshot-'));
  try {
    const inputPath = path.join(tempDir, 'input.xlsx');
    const outputPath = path.join(tempDir, 'output.xlsx');
    const repairedPath = path.join(tempDir, 'repaired.gz');
    fs.writeFileSync(inputPath, 'input');
    fs.writeFileSync(outputPath, 'output');
    fs.writeFileSync(repairedPath, 'repaired');
    const result = { status: 'success', filePath: outputPath };
    Object.defineProperty(result, 'archivedSourcePaths', {
      value: [repairedPath],
      enumerable: false
    });

    const candidates = collectArchiveCandidatePaths({
      args: [{ filePath: inputPath }],
      result
    });
    assert.deepEqual(new Set(candidates), new Set([inputPath, outputPath, repairedPath]));

    const snapshots = captureArchiveSourceSnapshots({
      args: [{ filePath: inputPath }],
      result
    });
    const inputSnapshot = sourceSnapshotForPath(snapshots, inputPath);
    assert.equal(inputSnapshot.sizeBytes, 5);
    assert.equal(sourceSnapshotMatchesStat(inputSnapshot, fs.statSync(inputPath)), true);

    fs.appendFileSync(inputPath, '-changed');
    assert.equal(sourceSnapshotMatchesStat(inputSnapshot, fs.statSync(inputPath)), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
