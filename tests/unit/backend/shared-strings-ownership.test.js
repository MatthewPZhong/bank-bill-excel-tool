'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const XLSX = require('xlsx');
const JSZip = require('jszip');
const { AdaptiveSharedStringsProvider } = require('../../../src/backend/position-reconciliation-import/shared-strings-provider');
const { openRichWorkbook } = require('../../../src/backend/xlsx-rich-reader');
const { openWorkbookSheets } = require('../../../src/backend/vcc-financial-op/workbook-reader');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sst-ownership-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'source.xlsx');
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['文本'], ['原文😀'], ['第二行']]), '数据');
  XLSX.writeFile(book, file, { bookSST: true });
  return { dir, file };
}

// 回归若再次引入旧缺陷，危险路径也只能运行在探针自己创建的牺牲 cwd 中。
function isolated(t, body) {
  const f = fixture(t), cwd = path.join(f.dir, 'sacrificial-cwd');
  fs.mkdirSync(cwd); fs.writeFileSync(path.join(cwd, 'sentinel'), 'retain');
  const script = `const fs=require('node:fs'); const assert=require('node:assert/strict');
    const {AdaptiveSharedStringsProvider}=require(${JSON.stringify(require.resolve('../../../src/backend/position-reconciliation-import/shared-strings-provider'))});
    const {openRichWorkbook}=require(${JSON.stringify(require.resolve('../../../src/backend/xlsx-rich-reader'))});
    const file=${JSON.stringify(f.file)}; const cwd=process.cwd();
    (async()=>{${body}})().catch(error=>{console.error(error);process.exitCode=1});`;
  execFileSync(process.execPath, ['-e', script], { cwd, encoding: 'utf8', timeout: 30000 });
  assert.equal(fs.readFileSync(path.join(cwd, 'sentinel'), 'utf8'), 'retain');
}

test('缺省/空 SST 目录不能回退到 cwd，溢出时拒绝并保留无关文件', async (t) => {
  for (const value of ['undefined', 'null', "''", "' '"]) await t.test(value, (t) => isolated(t, `
    const provider=new AdaptiveSharedStringsProvider({tempRoot:${value},memoryBudgetBytes:1});
    let error; try {provider.append('spill');} catch(e) {error=e;} finally {await provider.close();}
    assert.equal(fs.readFileSync(cwd+'/sentinel','utf8'),'retain');
    assert.match(error?.message || '', /未提供临时目录/);
  `));
});

test('共享 Rich Reader 缺省目录逐任务独立，关闭一个不破坏另一个或 cwd', (t) => isolated(t, `
  const a=await openRichWorkbook(file,{memoryBudgetBytes:1});
  const b=await openRichWorkbook(file,{memoryBudgetBytes:1});
  const first=a.sharedStrings.tempRoot, second=b.sharedStrings.tempRoot;
  assert.equal(a.sharedStrings.mode,'disk'); assert.notEqual(first,cwd); assert.notEqual(first,second);
  await a.close(); assert.equal(fs.existsSync(first),false);
  const rows=[]; await b.scan(row=>rows.push(row)); assert.equal(rows.length,3);
  await b.close(); assert.equal(fs.existsSync(second),false);
`));

test('已存在的显式 SST 目录及 VCC Reader 失败清理均不得覆盖/删除用户文件', async (t) => {
  const { dir, file } = fixture(t), root = path.join(dir, 'existing'); fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'sst.bin'), 'existing-bin'); fs.writeFileSync(path.join(root, 'sst.idx'), 'existing-index');
  for (const open of [
    () => openRichWorkbook(file, { sstTempRoot: root, memoryBudgetBytes: 1 }),
    () => openWorkbookSheets(file, { sstTempRoot: root, sstMemoryBudgetBytes: 1 })
  ]) {
    await assert.rejects(open(), /EEXIST/);
    assert.equal(fs.readFileSync(path.join(root, 'sst.bin'), 'utf8'), 'existing-bin');
    assert.equal(fs.readFileSync(path.join(root, 'sst.idx'), 'utf8'), 'existing-index');
  }
});

test('同一路径第二个读取任务拒绝接管，首个 SST 仍能读取和清理', async (t) => {
  const { dir, file } = fixture(t), root = path.join(dir, 'same');
  const first = await openRichWorkbook(file, { sstTempRoot: root, memoryBudgetBytes: 1 });
  try {
    await assert.rejects(openRichWorkbook(file, { sstTempRoot: root, memoryBudgetBytes: 1 }), /EEXIST/);
    assert.equal(first.sharedStrings.get(1), '原文😀');
  } finally { await first.close(); }
  assert.equal(fs.existsSync(root), false);
});

test('部分 spill 创建失败也关闭已打开句柄并清理本次目录', async (t) => {
  const { dir } = fixture(t), root = path.join(dir, 'partial');
  const provider = new AdaptiveSharedStringsProvider({ tempRoot: root, memoryBudgetBytes: 1 });
  const original = fs.openSync;
  t.mock.method(fs, 'openSync', (file, ...args) => {
    if (file === path.join(root, 'sst.idx')) throw Object.assign(new Error('injected idx failure'), { code: 'EIO' });
    return original(file, ...args);
  });
  assert.throws(() => provider.append('spill'), { code: 'EIO' });
  const binFd = provider.binFd; await provider.close(); await provider.close();
  assert.throws(() => fs.fstatSync(binFd), { code: 'EBADF' });
  assert.equal(fs.existsSync(root), false);
});

test('SST 解析失败和取消在溢出后清理私有目录', async (t) => {
  for (const failure of ['parse', 'cancel']) await t.test(failure, async (t) => {
    const { dir, file } = fixture(t), root = path.join(dir, 'failed');
    const zip = await JSZip.loadAsync(fs.readFileSync(file));
    const token = { cancelled: false };
    if (failure === 'parse') {
      zip.file('xl/sharedStrings.xml', '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>spill</t></si><si><t>unclosed');
      fs.writeFileSync(file, await zip.generateAsync({ type: 'nodebuffer' }));
    } else {
      zip.file('xl/sharedStrings.xml', '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        + Array.from({ length: 128 }, (_, i) => `<si><t>${'x'.repeat(3000)}${i}</t></si>`).join('') + '</sst>');
      fs.writeFileSync(file, await zip.generateAsync({ type: 'nodebuffer' }));
      const original = fs.writeSync;
      t.mock.method(fs, 'writeSync', (...args) => { const result = original(...args); token.cancelled = true; return result; });
    }
    await assert.rejects(openRichWorkbook(file, { sstTempRoot: root, memoryBudgetBytes: 1, cancelToken: token }));
    assert.equal(fs.existsSync(root), false);
    assert.equal(fs.existsSync(file), true);
  });
});

test('SST 目录出现无关文件时不递归删除，清理失败重复 close 仍报错', async (t) => {
  const { dir } = fixture(t), root = path.join(dir, 'owned');
  const provider = new AdaptiveSharedStringsProvider({ tempRoot: root, memoryBudgetBytes: 1 });
  provider.append('spill'); fs.writeFileSync(path.join(root, 'foreign'), 'retain');
  await assert.rejects(provider.close(), { code: 'ENOTEMPTY' });
  await assert.rejects(provider.close(), { code: 'ENOTEMPTY' });
  assert.equal(fs.readFileSync(path.join(root, 'foreign'), 'utf8'), 'retain');
});

test('SST 目录被替换时停止清理，显式保留模式仍保留自己的缓存', async (t) => {
  const { dir } = fixture(t), root = path.join(dir, 'owned');
  const provider = new AdaptiveSharedStringsProvider({ tempRoot: root, memoryBudgetBytes: 1 });
  // 模拟 NTFS 的高位文件 ID：不同整数转成 Number 后相同，不能据此认领替换文件。
  const base = 9007199254740992n;
  assert.equal(Number(base), Number(base + 1n));
  const identity = (stat, ino, options) => {
    stat.ino = options?.bigint ? ino : Number(ino);
    return stat;
  };
  const originalLstatSync = fs.lstatSync.bind(fs);
  const originalFstatSync = fs.fstatSync.bind(fs);
  t.mock.method(fs, 'lstatSync', (file, options) => {
    const stat = originalLstatSync(file, options);
    return file === root ? identity(stat, base, options) : stat;
  });
  t.mock.method(fs, 'fstatSync', (fd, options) => {
    const stat = originalFstatSync(fd, options);
    if (fd === provider.binFd) return identity(stat, base + 4n, options);
    if (fd === provider.idxFd) return identity(stat, base + 8n, options);
    return stat;
  });
  provider.append('spill');
  const originalLstat = fs.promises.lstat.bind(fs.promises);
  let replaced = false;
  t.mock.method(fs.promises, 'lstat', async (file, options) => {
    if (file === root && !replaced) {
      // Windows 不允许移动仍有打开文件的目录；在真实 close 已关句柄、
      // 尚未核验归属时替换，仍覆盖清理最关键的路径竞争。
      assert.equal(provider.binFd, null); assert.equal(provider.idxFd, null);
      fs.renameSync(root, root + '-original'); fs.mkdirSync(root);
      fs.writeFileSync(path.join(root, 'sst.bin'), 'retain');
      fs.writeFileSync(path.join(root, 'sst.idx'), 'retain-index'); replaced = true;
    }
    const stat = await originalLstat(file, options);
    if (file === root) return identity(stat, base + 1n, options);
    if (file === path.join(root, 'sst.bin')) return identity(stat, base + 5n, options);
    if (file === path.join(root, 'sst.idx')) return identity(stat, base + 9n, options);
    return stat;
  });
  await assert.rejects(provider.close(), /临时目录身份已变化/);
  assert.equal(replaced, true);
  assert.equal(fs.readFileSync(path.join(root, 'sst.bin'), 'utf8'), 'retain');
  assert.equal(fs.readFileSync(path.join(root, 'sst.idx'), 'utf8'), 'retain-index');
  const preserved = new AdaptiveSharedStringsProvider({ tempRoot: path.join(dir, 'preserved'), memoryBudgetBytes: 1, preserveOnClose: true });
  preserved.append('spill'); await preserved.close();
  assert.equal(fs.existsSync(path.join(preserved.tempRoot, 'sst.bin')), true);
});
