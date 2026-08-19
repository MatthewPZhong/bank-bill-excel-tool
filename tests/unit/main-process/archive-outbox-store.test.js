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

test('同 operation 的文件 outbox 原子合并同批次终态且稳定拒绝冲突', (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-outbox-terminal-'));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const store = createArchiveOutboxStore(rootDir);
  const created = store.enqueue({
    operationKey: 'position:terminal-merge:run',
    targetBatchId: 71,
    files: [{ filePath: path.join(rootDir, 'input.xlsx'), role: 'input' }]
  });
  const terminalOutcome = {
    taskStatus: 'succeeded',
    code: '',
    message: '',
    metadata: { recovered: true }
  };

  store.merge(created.id, {
    targetBatchId: 71,
    terminalOutcome,
    files: [{ filePath: path.join(rootDir, 'output.xlsx'), role: 'output' }]
  });
  store.merge(created.id, { targetBatchId: 71, terminalOutcome, files: [] });
  const [merged] = store.list();
  assert.equal(merged.payload.targetBatchId, 71);
  assert.deepEqual(merged.payload.terminalOutcome, terminalOutcome);
  assert.equal(merged.payload.files.length, 2);

  assert.throws(
    () => store.merge(created.id, { targetBatchId: 72, terminalOutcome }),
    (error) => error.code === 'ARCHIVE_OUTBOX_TARGET_BATCH_CONFLICT'
  );
  assert.throws(
    () => store.merge(created.id, {
      targetBatchId: 71,
      terminalOutcome: { ...terminalOutcome, taskStatus: 'failed' }
    }),
    (error) => error.code === 'ARCHIVE_OUTBOX_TERMINAL_CONFLICT'
  );
});

test('磁盘 record v1 与 owner terminal payload v2 是独立版本层', (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-outbox-version-layers-'));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const store = createArchiveOutboxStore(rootDir);
  const created = store.enqueue({
    version: 2,
    owner: {
      version: 1,
      kind: 'operation',
      operationContext: {
        taskRunId: 'task-version-layers',
        taskKey: 'pending:reconcile:run',
        moduleId: 'pending-reconciliation',
        parentRunId: 'parent-version-layers',
        operationKey: 'operation-version-layers'
      }
    },
    terminalOutcome: { taskStatus: 'failed', code: 'TEST', message: 'test', metadata: {} },
    files: []
  });
  const diskRecord = JSON.parse(
    fs.readFileSync(path.join(rootDir, `${created.id}.json`), 'utf8')
  );
  assert.equal(diskRecord.version, 1);
  assert.equal(diskRecord.payload.version, 2);
  assert.equal(store.list()[0].payload.owner.kind, 'operation');
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

test('存档 outbox 拒绝非字符串及空白文件路径', (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-outbox-invalid-path-'));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const store = createArchiveOutboxStore(rootDir);

  for (const filePath of [undefined, null, 123, '   ']) {
    assert.throws(
      () => store.enqueue({
        operationKey: 'position:invalid-path',
        files: [{ filePath, role: 'input' }]
      }),
      /文件路径为空或格式非法/
    );
  }
  assert.deepEqual(store.list(), []);
});
