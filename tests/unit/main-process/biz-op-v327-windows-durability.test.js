'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fsyncDirectory, writeFileAtomicDurable } = require('../../../src/main-process/background-execution/durable-file');
const { createBizOpPayloadStore, readVerifiedManifest } = require('../../../src/main-process/biz-op-v327/payload-store');
const { legacyRoot, reclaimFiles } = require('../../../src/main-process/biz-op-v327/upgrade-legacy');

for (const platform of ['win32', 'darwin', 'linux']) {
  test(`${platform} 目录同步使用平台要求的句柄并关闭`, () => {
    const calls = [];
    const result = fsyncDirectory('/controlled', { platform, fs: {
      openSync(target, flags) { calls.push(['open', target, flags]); return 17; },
      fsyncSync(fd) { calls.push(['sync', fd]); },
      closeSync(fd) { calls.push(['close', fd]); }
    } });
    assert.equal(result.capability, 'supported');
    assert.deepEqual(calls, [['open', '/controlled', platform === 'win32' ? 'r+' : 'r'], ['sync', 17], ['close', 17]]);
  });
}

for (const stage of ['open', 'sync']) for (const code of ['EPERM', 'ENOTSUP', 'EIO']) {
  test(`Windows ${stage} ${code} 保持失败保护并释放已有句柄`, () => {
    let closed = 0;
    const fail = () => { throw Object.assign(new Error(code), { code }); };
    const invoke = () => fsyncDirectory('/controlled', { platform: 'win32', fs: {
      openSync() { if (stage === 'open') fail(); return 17; },
      fsyncSync: fail,
      closeSync(fd) { assert.equal(fd, 17); closed += 1; }
    } });
    if (code === 'EIO') assert.throws(invoke, { code: 'DURABILITY_DIRECTORY_FSYNC_FAILED' });
    else assert.deepEqual(invoke(), { capability: 'unsupported', errorCode: code });
    assert.equal(closed, stage === 'sync' ? 1 : 0);
  });
}

test('真实宿主中文目录原子落盘、候选封存与旧目录回收均成功，不跳过 Windows', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), '业务OP 落盘回归-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.equal(fsyncDirectory(root).capability, 'supported');
  const target = path.join(root, '原子文件.json');
  assert.equal(writeFileAtomicDurable(target, 'unchanged').status, 'committed');
  assert.equal(fs.readFileSync(target, 'utf8'), 'unchanged');
  const store = createBizOpPayloadStore({ userDataDir: root }); store.initialize();
  const candidate = store.prepareCandidate('task-windows', 'candidate-windows');
  const partName = 'part-000001.jsonl';
  const bytes = Buffer.from('{"message":"合成诊断"}\n');
  fs.writeFileSync(path.join(candidate.directory, partName), bytes);
  const originalOpen = fs.promises.open.bind(fs.promises);
  let syncedParts = 0;
  let syncedLegacyDirectories = 0;
  t.mock.method(fs.promises, 'open', async (file, flags, ...args) => {
    const handle = await originalOpen(file, flags, ...args);
    const sync = handle.sync.bind(handle);
    handle.sync = async () => {
      if (String(file).endsWith(partName)) {
        assert.equal(flags & fs.constants.O_RDWR, fs.constants.O_RDWR);
        syncedParts += 1;
      }
      if (file === legacyRoot(root)) {
        assert.equal(flags, process.platform === 'win32' ? fs.constants.O_RDWR : fs.constants.O_RDONLY);
        syncedLegacyDirectories += 1;
      }
      return sync();
    };
    return handle;
  });
  const token = await store.sealCandidate({ taskRunId: 'task-windows', objectId: 'candidate-windows',
    objectKind: 'DIAGNOSTIC', intentDigest: 'a'.repeat(64), catalog: {}, parts: [{ name: partName, rowCount: 1 }] });
  assert.equal(syncedParts, 1);
  assert.equal(readVerifiedManifest(token).rowCount, 1);
  assert.deepEqual(fs.readFileSync(store.resolve(`diagnostics/candidate-windows/${partName}`)), bytes);
  // 即使文件已被上次尝试回收，重试也必须实际同步旧目录。
  fs.mkdirSync(legacyRoot(root), { recursive: true });
  await reclaimFiles(root, [], () => {});
  assert.equal(syncedLegacyDirectories, 1);
});
