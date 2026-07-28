'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  createArchiveOutboxStore,
  outboxBatchId,
  parseOutboxBatchId
} = require('../../../src/main-process/archive-center/outbox-store');

test('存档 outbox 跨实例保留文件并支持幂等追加和删除', (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-outbox-'));
  const inputPath = path.join(rootDir, 'input.xlsx');
  const outputPath = path.join(rootDir, 'output.xlsx');
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));

  const store = createArchiveOutboxStore(rootDir, {
    now: () => new Date('2026-07-27T00:00:00.000Z')
  });
  const created = store.enqueue({
    operationKey: 'position:operation-1:import',
    files: [{ filePath: inputPath, direction: 'input', role: 'input' }]
  });
  const syntheticBatchId = outboxBatchId(created.id);
  assert.equal(parseOutboxBatchId(syntheticBatchId), created.id);

  const reopened = createArchiveOutboxStore(rootDir);
  reopened.append(created.id, [
    { filePath: inputPath, direction: 'input', role: 'input' },
    { filePath: outputPath, direction: 'output', role: 'output' }
  ]);
  const [record] = reopened.list();
  assert.deepEqual(
    record.payload.files.map((file) => [file.direction, file.filePath]),
    [['input', inputPath], ['output', outputPath]]
  );
  assert.deepEqual(reopened.listSourcePaths().sort(), [inputPath, outputPath].sort());

  reopened.remove(created.id);
  assert.deepEqual(reopened.list(), []);
});

test('存档 outbox 内容被改写但未同步完整性哈希时必须 fail-closed', (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-outbox-tamper-'));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const store = createArchiveOutboxStore(rootDir);
  const created = store.enqueue({
    operationKey: 'position:operation-2:export',
    files: [{ filePath: path.join(rootDir, 'result.xlsx'), role: 'output' }]
  });
  const recordPath = path.join(rootDir, `${created.id}.json`);
  const payload = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
  payload.payload.operationKey = 'tampered-operation';
  fs.writeFileSync(recordPath, JSON.stringify(payload), 'utf8');

  assert.throws(
    () => store.list(),
    /存档 outbox 完整性校验失败/
  );
});
