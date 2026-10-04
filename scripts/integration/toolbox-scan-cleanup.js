'use strict';
// 扫描临时资源清理补偿：真实 Worker、权限故障、关闭重试、新进程恢复与身份变化保护。
// 用法：node scripts/integration/toolbox-scan-cleanup.js；所有输入、责任记录和故障均为隔离夹具。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const espree = require('espree');
const { createToolboxSplitReadOwner } = require('../../src/main-process/toolbox-split-read-owner');
const { dispatchLargeSplit } = require('../../src/main-process/toolbox-large-split-dispatch');
const { createResourceGovernor } = require('../../src/main-process/background-execution/resource-governor');
const { recoverToolboxScanResources } = require('../../src/main-process/toolbox-scan-resources');
const cases = [];
const test = (name, run) => cases.push({ name, run });
const denied = (code = 'EPERM') => Object.assign(new Error('隔离夹具注入删除权限失败'), { code });
const source = fs.readFileSync(path.join(__dirname, '../../src/main.js'), 'utf8');
const ast = espree.parse(source, { ecmaVersion: 'latest', range: true });
function productionFunction(name, scope) {
  const node = ast.body.find((item) => item.type === 'FunctionDeclaration' && item.id.name === name);
  assert.ok(node, name);
  const context = vm.createContext(scope);
  vm.runInContext(source.slice(...node.range), context);
  return context[name];
}
function fixture(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'toolbox-cleanup-integration-'));
  const temporaryRoot = path.join(root, 'toolbox-scan-temp');
  const filePath = path.join(root, 'input.csv');
  fs.writeFileSync(filePath, 'Account,Currency\nA,USD\n');
  const state = { directory: null, removes: 0, failures: options.failures ?? 1, failSave: false, exited: false };
  const governor = createResourceGovernor({ budgets: { cpuSlots: 1, workerThreadSlots: 1,
    utilityProcessSlots: 0, ioHeavySlots: 1, memoryBytes: 0 } });
  const fsImpl = { ...fs,
    rmdirSync(target) {
      if (target === state.directory) {
        state.removes++;
        if (state.failures-- > 0) throw denied(options.code);
      }
      return fs.rmdirSync(target);
    },
    unlinkSync(target) {
      if (options.failFile && target === path.join(state.directory || root, options.failFile) && state.failures-- > 0) throw denied();
      return fs.unlinkSync(target);
    },
    renameSync(from, to) {
      if (state.failSave && to.endsWith('.json')) throw denied('EACCES');
      return fs.renameSync(from, to);
    }
  };
  const owner = createToolboxSplitReadOwner({ governor, temporaryRoot, fsImpl, dispatch(input) {
    state.directory = input.privateDirectory;
    if (options.files) for (const [name, value] of Object.entries(options.files)) {
      fs.mkdirSync(path.dirname(path.join(input.privateDirectory, name)), { recursive: true });
      fs.writeFileSync(path.join(input.privateDirectory, name), value);
    }
    const carrier = dispatchLargeSplit(input);
    const closed = carrier.closed.then((value) => {
      state.exited = true;
      if (options.failSave) state.failSave = true;
      return value;
    });
    return { ...carrier, closed };
  } });
  const sender = Object.assign(new EventEmitter(), { id: 1, isDestroyed: () => false });
  return { root, temporaryRoot, filePath, owner, state, governor, sender,
    read: () => owner.read(sender, { version: 2, scanKind: 'metadata', requestId: 'read' }, async () => filePath),
    records: () => fs.readdirSync(temporaryRoot).filter((name) => name.startsWith('.toolbox-scan-owner-') && name.endsWith('.json')),
    dispose: () => fs.rmSync(root, { recursive: true, force: true }) };
}
async function withFixture(options, run) {
  const f = fixture(options);
  try { await run(f); }
  finally { assert.equal(f.governor.snapshot().activeLeaseCount, 0); f.dispose(); }
}
function restart(root) {
  const child = spawnSync(process.execPath, [__filename, '--recover', root], { encoding: 'utf8', timeout: 10000 });
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout);
}
function shutdown(f, logFailure = false) {
  const events = [];
  const runtime = {};
  const fn = productionFunction('shutdownBackgroundExecutionRuntimeGracefully', {
    toolboxSplitReadOwners: new WeakMap([[runtime, f.owner]]),
    backgroundExecutionRuntimeManager: { peek: () => runtime,
      async shutdown() { events.push('runtime-closed'); return { leakedTransports: [], errors: [] }; } },
    appendActivityLogEntry(entry) { if (logFailure) throw denied(); events.push(entry); },
    console: { warn: () => events.push('log-warning') }
  });
  return { fn, events };
}

test('真实 Worker 退出后首次删除失败，close 保留输入并重试成功', () => withFixture({}, async (f) => {
  await assert.rejects(f.read(), AggregateError);
  assert.equal(f.state.exited, true);
  assert.equal(f.owner.snapshot().activeCount, 0);
  assert.equal(f.owner.snapshot().cleanupPendingCount, 1);
  assert.equal(f.governor.snapshot().activeLeaseCount, 0);
  const record = JSON.parse(fs.readFileSync(path.join(f.temporaryRoot, f.records()[0]), 'utf8'));
  assert.equal(record.owner, 'toolbox-split-read'); assert.equal(record.state, 'cleanup-pending');
  assert.equal(record.lastError.code, 'EPERM');
  assert.deepEqual(await f.owner.close(), { closed: true, unclosedCount: 0, cleanupPendingCount: 0 });
  assert.equal(f.state.removes, 2); assert.equal(fs.existsSync(f.state.directory), false);
  assert.deepEqual(f.records(), []); assert.equal(fs.readFileSync(f.filePath, 'utf8'), 'Account,Currency\nA,USD\n');
}));
test('持续 EACCES 分开报告待清理数量，执行配额不再被占用', () => withFixture({ failures: Infinity, code: 'EACCES' }, async (f) => {
  await assert.rejects(f.read(), AggregateError);
  assert.deepEqual(await f.owner.close(), { closed: false, unclosedCount: 0, cleanupPendingCount: 1 });
  assert.equal(f.state.removes, 2); assert.equal(f.owner.snapshot().cleanupUnpersistedCount, 0);
  assert.equal(f.owner.snapshot().cleanupFailures[0].code, 'EACCES'); assert.equal(f.records().length, 1);
}));
test('新进程按持久责任和身份完成补偿，完成后移除记录', () => withFixture({ failures: Infinity }, async (f) => {
  await assert.rejects(f.read(), AggregateError);
  const report = restart(f.temporaryRoot);
  assert.equal(report.cleanupPendingCount, 0); assert.equal(fs.existsSync(f.state.directory), false);
  assert.deepEqual(f.records(), []); assert.equal(fs.existsSync(f.filePath), true);
}));
test('目录被替换后当前 owner 与新进程都拒绝删除替代目录', () => withFixture({ failures: Infinity }, async (f) => {
  await assert.rejects(f.read(), AggregateError);
  fs.renameSync(f.state.directory, path.join(f.root, 'original'));
  fs.mkdirSync(f.state.directory); fs.writeFileSync(path.join(f.state.directory, 'foreign.txt'), '保留');
  await f.owner.close();
  assert.equal(f.owner.snapshot().cleanupFailures[0].code, 'TOOLBOX_SCAN_IDENTITY_CHANGED');
  const report = restart(f.temporaryRoot);
  assert.equal(report.cleanupPendingCount, 1);
  assert.equal(fs.readFileSync(path.join(f.state.directory, 'foreign.txt'), 'utf8'), '保留');
  assert.equal(fs.existsSync(path.join(f.root, 'original')), true);
}));
test('文件身份变化后拒绝清理，不能把同名替代文件当成原缓存', () => withFixture({
  failures: Infinity, failFile: 'cache.bin', files: { 'cache.bin': '原缓存' }
}, async (f) => {
  await assert.rejects(f.read(), AggregateError);
  fs.renameSync(path.join(f.state.directory, 'cache.bin'), path.join(f.root, 'original.bin'));
  fs.writeFileSync(path.join(f.state.directory, 'cache.bin'), '新内容');
  const report = restart(f.temporaryRoot);
  assert.equal(report.cleanupFailures[0].code, 'TOOLBOX_SCAN_IDENTITY_CHANGED');
  assert.equal(fs.readFileSync(path.join(f.state.directory, 'cache.bin'), 'utf8'), '新内容');
}));
test('部分删除后重试允许原文件已缺失，剩余对象仍按原身份删除', () => withFixture({
  failures: 1, failFile: 'sst/b.bin', files: { 'sst/a.bin': 'A', 'sst/b.bin': 'B' }
}, async (f) => {
  await assert.rejects(f.read(), AggregateError);
  assert.equal(fs.existsSync(path.join(f.state.directory, 'sst/a.bin')), false);
  assert.equal(fs.existsSync(path.join(f.state.directory, 'sst/b.bin')), true);
  assert.equal((await f.owner.close()).cleanupPendingCount, 0);
  assert.equal(fs.existsSync(f.state.directory), false);
}));
test('清理失败后新增未知文件，重启补偿保留目录与未知内容', () => withFixture({}, async (f) => {
  await assert.rejects(f.read(), AggregateError);
  fs.writeFileSync(path.join(f.state.directory, 'new.txt'), '未知内容');
  assert.equal(restart(f.temporaryRoot).cleanupFailures[0].code, 'TOOLBOX_SCAN_IDENTITY_CHANGED');
  assert.equal(fs.readFileSync(path.join(f.state.directory, 'new.txt'), 'utf8'), '未知内容');
}));
test('目录替换成符号链接时保留链接目标内容', () => withFixture({}, async (f) => {
  await assert.rejects(f.read(), AggregateError);
  fs.renameSync(f.state.directory, path.join(f.root, 'original'));
  const foreign = path.join(f.root, 'foreign'); fs.mkdirSync(foreign); fs.writeFileSync(path.join(foreign, 'keep.txt'), '保留');
  fs.symlinkSync(foreign, f.state.directory, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(restart(f.temporaryRoot).cleanupPendingCount, 1);
  assert.equal(fs.readFileSync(path.join(foreign, 'keep.txt'), 'utf8'), '保留');
}));
test('未登记的 toolbox-scan 目录不因名称匹配被删除，损坏记录保留并诊断', () => withFixture({ failures: 0 }, async (f) => {
  fs.mkdirSync(f.temporaryRoot, { recursive: true });
  const unknown = path.join(f.temporaryRoot, 'toolbox-scan-unknown'); fs.mkdirSync(unknown);
  const bad = path.join(f.temporaryRoot, '.toolbox-scan-owner-00000000-0000-0000-0000-000000000000.json');
  fs.writeFileSync(bad, '{');
  const report = restart(f.temporaryRoot);
  assert.equal(report.cleanupPendingCount, 1); assert.equal(fs.existsSync(unknown), true); assert.equal(fs.readFileSync(bad, 'utf8'), '{');
}));
test('关闭事实尚未写入的运行记录不会在恢复时被删', () => withFixture({ failSave: true, failures: 0 }, async (f) => {
  await assert.rejects(f.read(), AggregateError);
  const record = JSON.parse(fs.readFileSync(path.join(f.temporaryRoot, f.records()[0]), 'utf8'));
  assert.equal(record.state, 'running'); assert.equal(f.owner.snapshot().cleanupUnpersistedCount, 1);
  const report = restart(f.temporaryRoot);
  assert.equal(report.cleanupFailures[0].code, 'RESOURCE_PREPARE_CLOSE_UNCONFIRMED');
  assert.equal(fs.existsSync(f.state.directory), true);
}));
test('Main 退出继续关闭 runtime，并记录持久补偿诊断', () => withFixture({ failures: Infinity }, async (f) => {
  await assert.rejects(f.read(), AggregateError);
  const h = shutdown(f); await h.fn();
  assert.equal(h.events.at(-1), 'runtime-closed'); assert.equal(h.events[0].domain, 'toolbox');
  assert.match(h.events[0].message, /下次启动重试/); assert.equal(f.records().length, 1);
}));
test('Main 退出不丢弃尚未持久保存的补偿责任，写入恢复后可重试', () => withFixture({ failSave: true, failures: 0 }, async (f) => {
  await assert.rejects(f.read(), AggregateError);
  const h = shutdown(f);
  await assert.rejects(h.fn(), { code: 'TOOLBOX_SPLIT_READ_CLEANUP_UNPERSISTED' });
  assert.deepEqual(h.events, []); assert.equal(f.governor.snapshot().activeLeaseCount, 0);
  f.state.failSave = false; await h.fn(); assert.deepEqual(h.events, ['runtime-closed']);
}));
test('Main 启动入口使用同一个固定受控根，真实补偿可独立完成', () => withFixture({ failures: Infinity }, async (f) => {
  await assert.rejects(f.read(), AggregateError);
  const events = [];
  const recover = productionFunction('recoverToolboxScansAtStartup', {
    path, app: { getPath(name) { assert.equal(name, 'userData'); return f.root; } },
    recoverToolboxScanResources, appendActivityLogEntry: (entry) => events.push(entry)
  });
  assert.equal(recover().cleanupPendingCount, 0); assert.deepEqual(events, []);
  assert.equal(fs.existsSync(f.state.directory), false);
}));
test('补偿记录已保存时活动日志写入失败不阻断 runtime 关闭', () => withFixture({ failures: Infinity }, async (f) => {
  await assert.rejects(f.read(), AggregateError);
  const h = shutdown(f, true); await h.fn();
  assert.deepEqual(h.events, ['log-warning', 'runtime-closed']); assert.equal(f.records().length, 1);
}));
test('启动时日志失败仍保留身份异常的责任记录，不删除替代目录', () => withFixture({}, async (f) => {
  await assert.rejects(f.read(), AggregateError);
  fs.renameSync(f.state.directory, path.join(f.root, 'original')); fs.mkdirSync(f.state.directory);
  const events = [];
  const recover = productionFunction('recoverToolboxScansAtStartup', {
    path, app: { getPath: () => f.root }, recoverToolboxScanResources,
    appendActivityLogEntry() { throw denied(); }, console: { warn: () => events.push('log-warning') }
  });
  assert.equal(recover().cleanupPendingCount, 1); assert.deepEqual(events, ['log-warning']);
  assert.equal(fs.existsSync(f.state.directory), true); assert.equal(f.records().length, 1);
}));
test('窗口取消后的真实 Worker 退出仍保留失败清理，关闭可重试', () => withFixture({}, async (f) => {
  const reading = f.read();
  const rejected = assert.rejects(reading, AggregateError);
  while (!f.state.directory) await new Promise((resolve) => setImmediate(resolve));
  f.sender.emit('destroyed'); await rejected;
  assert.equal(f.state.exited, true); assert.equal(f.owner.snapshot().cleanupPendingCount, 1);
  assert.equal((await f.owner.close()).closed, true);
}));

async function main() {
  let passed = 0;
  for (const item of cases) {
    try { await item.run(); passed++; console.log(`PASS ${item.name}`); }
    catch (error) { console.error(`FAIL ${item.name}`, error); }
  }
  console.log(`==== ${passed}/${cases.length} PASS ====`);
  if (passed !== cases.length) process.exitCode = 1;
}
if (process.argv[2] === '--recover') {
  process.stdout.write(JSON.stringify(recoverToolboxScanResources({ temporaryRoot: process.argv[3] })));
} else main().catch((error) => { console.error(error); process.exitCode = 1; });
