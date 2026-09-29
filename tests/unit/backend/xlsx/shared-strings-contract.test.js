'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const current = require('../../../../src/backend/xlsx/shared-strings-provider');
const legacy = require('../../../../src/backend/position-reconciliation-import/shared-strings-provider');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xlsx-sst-contract-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return path.join(root, 'spill');
}

test('旧入口的导出和错误 constructor 均指向唯一实现', () => {
  assert.strictEqual(legacy, current);
  const lines = ['原始证据'];
  const error = new current.PositionSharedStringsError('读取失败', lines);
  lines.push('后加');
  assert.ok(error instanceof legacy.PositionSharedStringsError);
  assert.equal(error.name, 'PositionSharedStringsError');
  assert.equal(error.code, 'position-import-parser-parity-unproven');
  assert.deepEqual(error.detailLines, ['原始证据']);
  assert.equal(current.INDEX_RECORD_BYTES, 12);
  assert.equal(current.LENGTH_PREFIX_BYTES, 4);
});

test('缺 entry 不分配磁盘；Memory close 清空原数组', async (t) => {
  const tempRoot = fixture(t);
  const empty = await current.loadSharedStringsProvider(null, null, { tempRoot, memoryBudgetBytes: 1 });
  assert.ok(empty instanceof current.MemorySharedStringsProvider);
  assert.equal(empty.get(0), undefined);
  await empty.close();
  assert.equal(fs.existsSync(tempRoot), false);
  const values = ['文本'];
  const memory = new current.MemorySharedStringsProvider(values);
  await memory.close();
  assert.deepEqual(values, []);
  assert.throws(() => memory.get(0), current.PositionSharedStringsError);
});

test('公共缺省预算保持 64 MiB/8192；覆盖的 Number 转换与 cache 校验保持', async () => {
  const defaults = new current.AdaptiveSharedStringsProvider();
  assert.equal(defaults.memoryBudgetBytes, 64 * 1024 * 1024);
  assert.equal(defaults.lruMaxEntries, 8192);
  assert.equal(defaults.cacheMaxBytes, undefined);
  assert.equal(defaults.strictClose, false);
  assert.equal(defaults.tempRoot, '');
  await defaults.close();
  const converted = new current.AdaptiveSharedStringsProvider({ memoryBudgetBytes: '128', lruMaxEntries: '2' });
  assert.equal(converted.memoryBudgetBytes, 128);
  assert.equal(converted.lruMaxEntries, 2);
  await converted.close();
  for (const options of [{ memoryBudgetBytes: null }, { lruMaxEntries: null }, { cacheMaxBytes: '32' }, { cacheMaxBytes: null }]) {
    assert.throws(() => new current.AdaptiveSharedStringsProvider(options), TypeError);
  }
});

test('跨预算才独占落盘，缓存受 entry/字节预算约束，重复 close 保持成功', async (t) => {
  const tempRoot = fixture(t);
  const provider = new current.AdaptiveSharedStringsProvider({ tempRoot, memoryBudgetBytes: 100, lruMaxEntries: 1, cacheMaxBytes: 64 });
  provider.append('a');
  assert.equal(fs.existsSync(tempRoot), false);
  provider.append('第二条'.repeat(20));
  provider.append('b');
  assert.equal(provider.mode, 'disk');
  assert.equal(provider.get(0), 'a');
  assert.equal(provider.get(1), '第二条'.repeat(20));
  assert.equal(provider.get(2), 'b');
  assert.ok(provider.cache.size <= 1);
  assert.ok(provider.cacheBytes <= 64);
  assert.equal(provider.get(-1), undefined);
  await provider.close();
  await provider.close();
  assert.equal(fs.existsSync(tempRoot), false);
});

test('替换 spill 文件后只保留替换文件并持续报告原错误', async (t) => {
  const tempRoot = fixture(t);
  const provider = new current.AdaptiveSharedStringsProvider({ tempRoot, memoryBudgetBytes: 1 });
  provider.append('溢出');
  const original = fs.promises.lstat.bind(fs.promises);
  let replaced = false;
  t.mock.method(fs.promises, 'lstat', async (file, ...args) => {
    if (file === provider.binPath && !replaced) {
      assert.equal(provider.binFd, null);
      fs.renameSync(file, file + '.original');
      fs.writeFileSync(file, '外部替换内容');
      replaced = true;
    }
    return original(file, ...args);
  });
  let failure;
  await assert.rejects(provider.close(), (error) => {
    failure = error;
    return /临时文件身份已变化/.test(error.message);
  });
  await assert.rejects(provider.close(), (error) => error === failure);
  assert.equal(fs.readFileSync(provider.binPath, 'utf8'), '外部替换内容');
});

for (const strictClose of [false, true]) test(`句柄关闭失败 strictClose=${strictClose} 保留原分支`, async (t) => {
  const tempRoot = fixture(t);
  const provider = new current.AdaptiveSharedStringsProvider({ tempRoot, memoryBudgetBytes: 1, strictClose });
  provider.append('溢出');
  const binFd = provider.binFd;
  const original = fs.closeSync.bind(fs);
  const injected = Object.assign(new Error('测试关闭失败'), { code: 'EIO' });
  let unclosed = true;
  t.after(() => { if (unclosed) original(binFd); });
  t.mock.method(fs, 'closeSync', (fd) => {
    if (fd === binFd) throw injected;
    return original(fd);
  });
  if (strictClose) {
    let failure;
    await assert.rejects(provider.close(), (error) => {
      failure = error;
      assert.deepEqual(error.errors, [injected]);
      return error instanceof AggregateError;
    });
    assert.equal(fs.existsSync(provider.binPath), true);
    await assert.rejects(provider.close(), (error) => error === failure);
  } else {
    // 非 strict 分支仍尝试身份清理；释放真实句柄，使成功路径不依赖平台删除共享模式。
    const unlink = fs.promises.unlink.bind(fs.promises);
    let cleanupAttempted = false;
    t.mock.method(fs.promises, 'unlink', async (file, ...args) => {
      if (file === provider.binPath) {
        cleanupAttempted = true;
        original(binFd); unclosed = false;
      }
      return unlink(file, ...args);
    });
    await provider.close();
    assert.equal(cleanupAttempted, true);
    assert.equal(fs.existsSync(tempRoot), false);
  }
  if (unclosed) { original(binFd); unclosed = false; }
});

test('非 strict 关闭失败后，清理被拒绝时保留文件并重复报告清理错误', async (t) => {
  const provider = new current.AdaptiveSharedStringsProvider({ tempRoot: fixture(t), memoryBudgetBytes: 1 });
  provider.append('溢出');
  const binFd = provider.binFd;
  const originalClose = fs.closeSync.bind(fs);
  const originalUnlink = fs.promises.unlink.bind(fs.promises);
  const closeFailure = Object.assign(new Error('测试关闭失败'), { code: 'EIO' });
  const cleanupFailure = Object.assign(new Error('测试文件占用'), { code: 'EPERM' });
  t.mock.method(fs, 'closeSync', (fd) => {
    if (fd === binFd) throw closeFailure;
    return originalClose(fd);
  });
  t.mock.method(fs.promises, 'unlink', async (file, ...args) => {
    if (file === provider.binPath) throw cleanupFailure;
    return originalUnlink(file, ...args);
  });
  try {
    await assert.rejects(provider.close(), (error) => error === cleanupFailure);
    await assert.rejects(provider.close(), (error) => error === cleanupFailure);
    assert.equal(fs.existsSync(provider.binPath), true);
  } finally { originalClose(binFd); }
});
