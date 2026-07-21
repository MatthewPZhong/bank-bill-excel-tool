'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  captureArchiveSourceSnapshots,
  collectArchiveCandidatePaths,
  sourceSnapshotForPath,
  sourceSnapshotMatchesStat
} = require('../../../src/main-process/archive-center/source-snapshot');

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
