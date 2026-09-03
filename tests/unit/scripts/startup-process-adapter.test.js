'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const {
  DEFAULT_EXTERNAL_TIMEOUT_MS,
  createProcessAdapter,
  windowsProcessSnapshot
} = require('../../../scripts/startup-process-adapter');

const TEST_NONCE = 'test-nonce-123456';
const TEST_NONCE_ARG = `--startup-measure-nonce=${TEST_NONCE}`;
const WINDOWS_REAL_PROBE_WARMUP_TIMEOUT_MS = 30000;
function createWindowsAdapter(options) {
  const originalSnapshot = options.windowsProcessSnapshot;
  return createProcessAdapter({
    ...options,
    nonceFactory: () => TEST_NONCE,
    windowsProcessSnapshot: originalSnapshot && (async (...args) => (
      (await originalSnapshot(...args)).map((item) => (
        item.commandLine === undefined ? { ...item, commandLine: TEST_NONCE_ARG } : item
      ))
    ))
  });
}

test('Windows adapter 排除 baseline CIM 耗时并追踪 installer/app/renderer 后代', async () => {
  let clock = 0;
  let live = true;
  let snapshotCalls = 0;
  const commands = [];
  const adapter = createWindowsAdapter({
    platform: 'win32',
    now: () => clock,
    delay: async () => {},
    windowsProcessSnapshot: async () => {
      snapshotCalls += 1;
      if (snapshotCalls === 1) {
        clock += 750;
        return [{ pid: 1, parentPid: 0 }];
      }
      return live ? [
        // ExecWait wrapper 持续存活，沿可证明 parent 链捕获 app/renderer。
        { pid: 100, parentPid: 1, executablePath: 'C:\\Setup\\wrapper.exe' },
        { pid: 101, parentPid: 100, executablePath: 'C:\\Program Files\\Tool\\app.exe' },
        { pid: 102, parentPid: 101, executablePath: 'C:\\Program Files\\Tool\\app.exe' },
        { pid: 999, parentPid: 1, commandLine: 'unrelated' }
      ] : [];
    },
    spawn: () => {
      const child = new EventEmitter();
      child.pid = 100;
      child.exitCode = null;
      child.signalCode = null;
      process.nextTick(() => child.emit('spawn'));
      return child;
    },
    execFileAsync: async (file, args) => {
      commands.push([file, args]);
      if (file === 'powershell.exe') live = false;
      return file === 'powershell.exe' ? '101' : '';
    }
  });
  const handle = await adapter.launch({ executable: 'wrapper.exe', cwd: '.', env: {} });
  assert.equal(handle.processCreatedAt, 750, 'baseline 的 750ms 不得计入进程创建后指标');
  assert.deepEqual((await adapter.refreshTree(handle)).sort((a, b) => a - b), [100, 101, 102]);
  await adapter.gracefulClose(handle);
  assert.equal((await adapter.waitForExit(handle, 1000)).exited, true);
  assert.match(commands[0][1].at(-1), /foreach\(\$e in \$expected\)/);
});

test('Windows adapter cleanup 在同一 PowerShell 动作重验 token 并证明最终零存活', async () => {
  const commands = [];
  let snapshotCall = 0;
  let live = true;
  const child = new EventEmitter();
  child.pid = 200;
  child.exitCode = null;
  child.signalCode = null;
  const adapter = createWindowsAdapter({
    platform: 'win32',
    windowsProcessSnapshot: async () => {
      snapshotCall += 1;
      return snapshotCall === 1 || !live ? [] : [
        { pid: 200, parentPid: 1, executablePath: 'app.exe' },
        { pid: 201, parentPid: 200, executablePath: 'helper.exe' }
      ];
    },
    spawn: () => {
      process.nextTick(() => child.emit('spawn'));
      return child;
    },
    execFileAsync: async (file, args) => {
      commands.push([file, args]);
      live = false;
      return '[201,200]';
    }
  });
  const handle = await adapter.launch({ executable: 'app.exe', cwd: '.', env: {} });
  await adapter.refreshTree(handle);
  const receipt = await adapter.forceCleanup(handle);
  assert.equal(receipt.verifiedEmpty, true);
  assert.equal(commands.some(([file]) => file === 'taskkill.exe'), false);
  assert.match(commands[0][1].at(-1), /CreationDate/);
  assert.match(commands[0][1].at(-1), /Stop-Process/);
});

test('Windows adapter 不会对 PID 复用后的无关进程执行 close 或 taskkill', async () => {
  let snapshotCall = 0;
  const commands = [];
  const child = new EventEmitter();
  child.pid = 300;
  child.exitCode = null;
  child.signalCode = null;
  const adapter = createWindowsAdapter({
    platform: 'win32',
    windowsProcessSnapshot: async () => {
      snapshotCall += 1;
      if (snapshotCall === 1) return [];
      if (snapshotCall === 2) return [{
        pid: 300, parentPid: 1, creationDate: 'A', executablePath: 'app.exe'
      }];
      return [{
        pid: 300, parentPid: 1, creationDate: 'B', executablePath: 'unrelated.exe', commandLine: 'unrelated'
      }];
    },
    spawn: () => {
      process.nextTick(() => child.emit('spawn'));
      return child;
    },
    execFileAsync: async (file, args) => { commands.push([file, args]); return ''; }
  });
  const handle = await adapter.launch({ executable: 'app.exe', cwd: '.', env: {} });
  await adapter.refreshTree(handle);
  await adapter.forceCleanup(handle);
  assert.deepEqual(commands, []);
});

test('Windows adapter 不从 token 已由 A 复用为 B 的 parent 扩展或清理无关 child', async () => {
  let snapshotCall = 0;
  const commands = [];
  const child = new EventEmitter();
  child.pid = 300;
  child.exitCode = null;
  child.signalCode = null;
  const adapter = createWindowsAdapter({
    platform: 'win32',
    windowsProcessSnapshot: async () => {
      snapshotCall += 1;
      if (snapshotCall === 1) return [];
      if (snapshotCall === 2) return [{
        pid: 300, parentPid: 1, creationDate: 'A', executablePath: 'app.exe'
      }];
      return [
        { pid: 300, parentPid: 1, creationDate: 'B', executablePath: 'unrelated.exe', commandLine: 'unrelated' },
        { pid: 400, parentPid: 300, creationDate: 'C', executablePath: 'helper.exe', commandLine: 'unrelated' }
      ];
    },
    spawn: () => {
      process.nextTick(() => child.emit('spawn'));
      return child;
    },
    execFileAsync: async (file, args) => { commands.push([file, args]); return ''; }
  });
  const handle = await adapter.launch({ executable: 'app.exe', cwd: '.', env: {} });
  await adapter.refreshTree(handle);
  await assert.rejects(adapter.gracefulClose(handle), (error) => error.code === 'PROCESS_LINEAGE_AMBIGUOUS');
  await assert.rejects(adapter.forceCleanup(handle), (error) => error.code === 'PROCESS_CLEANUP_UNVERIFIED');
  assert.deepEqual(commands, [], '复用 parent 的新 child 不得 CloseMainWindow 或 taskkill');
  assert.equal(handle.knownPids.has(400), false);
});

test('Windows adapter root 首次 token snapshot 前退出时 fail closed，不猜 parent ownership', async () => {
  let snapshotCall = 0;
  const commands = [];
  const child = new EventEmitter();
  child.pid = 500;
  child.exitCode = null;
  child.signalCode = null;
  const adapter = createWindowsAdapter({
    platform: 'win32',
    delay: async () => {},
    windowsProcessSnapshot: async () => {
      snapshotCall += 1;
      if (snapshotCall === 1) return [];
      return [
        { pid: 501, parentPid: 500, creationDate: 'app-A', executablePath: 'C:\\Tool\\app.exe', commandLine: 'missing-nonce' },
        { pid: 502, parentPid: 501, creationDate: 'renderer-A', executablePath: 'C:\\Tool\\app.exe', commandLine: 'missing-nonce' }
      ];
    },
    spawn: () => {
      process.nextTick(() => child.emit('spawn'));
      return child;
    },
    execFileAsync: async (file, args) => {
      commands.push([file, args]);
      return file === 'powershell.exe' ? '501' : '';
    }
  });
  const handle = await adapter.launch({ executable: 'C:\\Tool\\app.exe', cwd: '.', env: {} });
  child.emit('exit', 0, null);
  await assert.rejects(adapter.refreshTree(handle),
    (error) => error.code === 'PROCESS_OWNERSHIP_UNESTABLISHED');
  assert.equal(handle.processTokens.has(500), false, 'root 已在首次 snapshot 前退出');
  await assert.rejects(adapter.forceCleanup(handle),
    (error) => error.code === 'PROCESS_CLEANUP_OWNERSHIP_UNESTABLISHED');
  assert.deepEqual(commands, []);
});

test('Windows adapter 不接纳 baseline stale child 或首次 token 前复用 root PID 的 child', async () => {
  for (const mode of ['baseline-stale-child', 'reused-root']) {
    let snapshotCall = 0;
    const commands = [];
    const child = new EventEmitter();
    child.pid = 700;
    child.exitCode = null;
    child.signalCode = null;
    const stale = { pid: 701, parentPid: 700, creationDate: 'stale-A', executablePath: 'helper.exe' };
    const adapter = createWindowsAdapter({
      platform: 'win32',
      windowsProcessSnapshot: async () => {
        snapshotCall += 1;
        if (snapshotCall === 1) return mode === 'baseline-stale-child' ? [stale] : [];
        if (mode === 'baseline-stale-child') return [stale];
        return [
          { pid: 700, parentPid: 1, creationDate: 'unrelated-B', executablePath: 'other.exe', commandLine: 'unrelated' },
          { pid: 702, parentPid: 700, creationDate: 'child-B', executablePath: 'helper.exe', commandLine: 'unrelated' }
        ];
      },
      spawn: () => { process.nextTick(() => child.emit('spawn')); return child; },
      execFileAsync: async (file, args) => { commands.push([file, args]); return '701'; }
    });
    const handle = await adapter.launch({ executable: 'app.exe', cwd: '.', env: {} });
    child.emit('exit', 0, null);
    await assert.rejects(adapter.refreshTree(handle),
      (error) => error.code === 'PROCESS_OWNERSHIP_UNESTABLISHED', mode);
    await assert.rejects(adapter.forceCleanup(handle),
      (error) => error.code === 'PROCESS_CLEANUP_OWNERSHIP_UNESTABLISHED');
    assert.deepEqual(commands, [], mode);
  }
});

test('Windows adapter 不以 baseline 后新出现的同 basename 程序作为 ownership seed', async () => {
  const commands = [];
  const child = new EventEmitter();
  child.pid = 600;
  child.exitCode = null;
  child.signalCode = null;
  let snapshotCall = 0;
  const adapter = createWindowsAdapter({
    platform: 'win32',
    windowsProcessSnapshot: async () => {
      snapshotCall += 1;
      if (snapshotCall === 1) return [];
      return [{ pid: 601, parentPid: 1, creationDate: 'other', executablePath: 'C:\\Other\\app.exe', commandLine: 'unrelated' }];
    },
    spawn: () => { process.nextTick(() => child.emit('spawn')); return child; },
    execFileAsync: async (file, args) => { commands.push([file, args]); return '601'; }
  });
  const handle = await adapter.launch({ executable: 'C:\\Tool\\app.exe', cwd: '.', env: {} });
  child.emit('exit', 0, null);
  await assert.rejects(adapter.refreshTree(handle),
    (error) => error.code === 'PROCESS_OWNERSHIP_UNESTABLISHED');
  await assert.rejects(adapter.gracefulClose(handle), (error) => error.code === 'PROCESS_OWNERSHIP_UNESTABLISHED');
  await assert.rejects(adapter.forceCleanup(handle),
    (error) => error.code === 'PROCESS_CLEANUP_OWNERSHIP_UNESTABLISHED');
  assert.deepEqual(commands, []);
});

test('Windows adapter action-time PID A→B race 不 close/kill 复用后的无关进程', async () => {
  const child = new EventEmitter();
  child.pid = 812;
  child.exitCode = null;
  child.signalCode = null;
  let snapshotCall = 0;
  let actionCommands = 0;
  const processA = {
    pid: 812, parentPid: 1, creationDate: 'token-A',
    executablePath: 'C:\\Tool\\app.exe', commandLine: `${TEST_NONCE_ARG} --owned`
  };
  const processB = {
    pid: 812, parentPid: 1, creationDate: 'token-B',
    executablePath: 'C:\\Other\\app.exe', commandLine: '--unrelated'
  };
  const adapter = createWindowsAdapter({
    platform: 'win32',
    windowsProcessSnapshot: async () => {
      snapshotCall += 1;
      if (snapshotCall === 1) return [];
      return snapshotCall <= 3 ? [processA] : [processB];
    },
    spawn: () => { process.nextTick(() => child.emit('spawn')); return child; },
    execFileAsync: async (file, args) => {
      actionCommands += 1;
      assert.equal(file, 'powershell.exe');
      assert.match(args.at(-1), /CreationDate/);
      assert.match(args.at(-1), /token-A/);
      return '[]';
    }
  });
  const handle = await adapter.launch({ executable: 'app.exe', cwd: '.', env: {} });
  await adapter.refreshTree(handle);
  await assert.rejects(adapter.gracefulClose(handle),
    (error) => error.code === 'PROCESS_TREE_CLOSE_NOT_ACCEPTED');
  const cleanup = await adapter.forceCleanup(handle);
  assert.equal(cleanup.verifiedEmpty, true);
  assert.equal(actionCommands, 1, 'PID 已复用后 cleanup 不得再发送裸 PID 动作');
});

test('Windows adapter 外部 CIM/Close/force 均受硬 timeout 约束', async () => {
  const never = () => new Promise(() => {});
  const child = new EventEmitter();
  child.pid = 900;
  child.exitCode = null;
  child.signalCode = null;
  const baselineAdapter = createWindowsAdapter({
    platform: 'win32', externalTimeoutMs: 20,
    windowsProcessSnapshot: never,
    spawn: () => { process.nextTick(() => child.emit('spawn')); return child; }
  });
  await assert.rejects(
    baselineAdapter.launch({ executable: 'app.exe', cwd: '.', env: {} }),
    (error) => error.code === 'PROCESS_SNAPSHOT_TIMEOUT'
  );

  let snapshotCall = 0;
  const adapter = createWindowsAdapter({
    platform: 'win32', externalTimeoutMs: 20,
    windowsProcessSnapshot: async () => {
      snapshotCall += 1;
      return snapshotCall === 1 ? [] : [{
        pid: 900, parentPid: 1, creationDate: 'owned', executablePath: 'app.exe'
      }];
    },
    spawn: () => { process.nextTick(() => child.emit('spawn')); return child; },
    execFileAsync: never
  });
  const handle = await adapter.launch({ executable: 'app.exe', cwd: '.', env: {} });
  await adapter.refreshTree(handle);
  await assert.rejects(adapter.gracefulClose(handle),
    (error) => error.code === 'PROCESS_CLOSE_TIMEOUT');
  await assert.rejects(adapter.forceCleanup(handle),
    (error) => error.code === 'PROCESS_FORCE_CLEANUP_TIMEOUT');
});

test('Windows adapter force cleanup 无 receipt 或最终仍 live 必须 fail closed', async () => {
  const child = new EventEmitter();
  child.pid = 950;
  child.exitCode = null;
  child.signalCode = null;
  let snapshotCall = 0;
  const adapter = createWindowsAdapter({
    platform: 'win32',
    windowsProcessSnapshot: async () => {
      snapshotCall += 1;
      return snapshotCall === 1 ? [] : [{
        pid: 950, parentPid: 1, creationDate: 'owned', executablePath: 'app.exe'
      }];
    },
    spawn: () => { process.nextTick(() => child.emit('spawn')); return child; },
    execFileAsync: async () => '[]'
  });
  const handle = await adapter.launch({ executable: 'app.exe', cwd: '.', env: {} });
  await adapter.refreshTree(handle);
  await assert.rejects(adapter.forceCleanup(handle),
    (error) => error.code === 'PROCESS_CLEANUP_UNVERIFIED'
      && error.evidence.remainingPids.includes(950));
});

test('Windows adapter nonce 透传 spawn，reparent/late child 仅凭 exact nonce 纳入并多轮静默确认', async () => {
  const child = new EventEmitter();
  child.pid = 1000;
  child.exitCode = null;
  child.signalCode = null;
  let calls = 0;
  let spawnedArgs = null;
  let stopped = false;
  const nonceArg = '--startup-measure-nonce=fixed-nonce-123456';
  const adapter = createProcessAdapter({
    platform: 'win32', nonceFactory: () => 'fixed-nonce-123456', delay: async () => {},
    windowsProcessSnapshot: async () => {
      calls += 1;
      if (calls === 1) return [];
      if (stopped) return [];
      if (calls <= 3) return [{
        pid: 1000, parentPid: 1, creationDate: '1', executablePath: 'portable.exe', commandLine: nonceArg
      }, {
        pid: 1001, parentPid: 1000, creationDate: '2', executablePath: 'app.exe', commandLine: 'renderer-without-nonce'
      }];
    },
    spawn: (_exe, args) => {
      spawnedArgs = args;
      process.nextTick(() => child.emit('spawn'));
      return child;
    },
    execFileAsync: async () => { stopped = true; return '[1001]'; }
  });
  const handle = await adapter.launch({ executable: 'portable.exe', cwd: '.', env: {} });
  assert.deepEqual(spawnedArgs, [nonceArg]);
  await adapter.refreshTree(handle);
  const receipt = await adapter.forceCleanup(handle);
  assert.equal(receipt.verifiedEmpty, true);
  assert.ok(calls >= 5, 'cleanup 至少三轮零存活 snapshot 才能证明 quiescence');
});

test('已记录无nonce renderer在祖先退出后仍是remaining，cleanup必须fatal', async () => {
  const child = new EventEmitter();
  child.pid = 1100;
  child.exitCode = null;
  child.signalCode = null;
  let calls = 0;
  let ancestorsStopped = false;
  const adapter = createWindowsAdapter({
    platform: 'win32', delay: async () => {},
    windowsProcessSnapshot: async () => {
      calls += 1;
      if (calls === 1) return [];
      if (ancestorsStopped) return [{
        pid: 1102, parentPid: 1101, creationDate: 'renderer',
        executablePath: 'renderer.exe', commandLine: 'no-nonce-renderer'
      }];
      return [{
        pid: 1100, parentPid: 1, creationDate: 'wrapper', executablePath: 'portable.exe'
      }, {
        pid: 1101, parentPid: 1100, creationDate: 'browser', executablePath: 'app.exe', commandLine: 'no-nonce-browser'
      }, {
        pid: 1102, parentPid: 1101, creationDate: 'renderer', executablePath: 'renderer.exe', commandLine: 'no-nonce-renderer'
      }];
    },
    spawn: () => { process.nextTick(() => child.emit('spawn')); return child; },
    execFileAsync: async () => { ancestorsStopped = true; return '[1101,1100]'; }
  });
  const handle = await adapter.launch({ executable: 'portable.exe', cwd: '.', env: {} });
  await adapter.refreshTree(handle);
  await assert.rejects(adapter.forceCleanup(handle), (error) => (
    error.code === 'PROCESS_CLEANUP_UNVERIFIED'
    && error.evidence.remainingPids.includes(1102)
  ));
});

test('graceful wait 对 root 退出后 late suspicious child fail closed，不把瞬时空树当 success', async () => {
  const child = new EventEmitter();
  child.pid = 1200;
  child.exitCode = null;
  child.signalCode = null;
  let calls = 0;
  const adapter = createWindowsAdapter({
    platform: 'win32', delay: async () => {},
    windowsProcessSnapshot: async () => {
      calls += 1;
      if (calls === 1) return [];
      if (calls <= 3) return [{
        pid: 1200, parentPid: 1, creationDate: 'root-token', executablePath: 'app.exe'
      }];
      return [{
        pid: 1201, parentPid: 1200, creationDate: 'late-child',
        executablePath: 'renderer.exe', commandLine: 'renderer-without-nonce'
      }];
    },
    spawn: () => { process.nextTick(() => child.emit('spawn')); return child; },
    execFileAsync: async () => '[1200]'
  });
  const handle = await adapter.launch({ executable: 'app.exe', cwd: '.', env: {} });
  await adapter.refreshTree(handle);
  await adapter.gracefulClose(handle);
  child.exitCode = 0;
  child.emit('exit', 0, null);
  await assert.rejects(adapter.waitForExit(handle, 1000), (error) => (
    error.code === 'PROCESS_LINEAGE_AMBIGUOUS'
    && error.evidence.suspiciousPids.includes(1201)
    && error.evidence.requiresManualCleanup === true
  ));
});

test('PowerShell CreationDate 使用显式 invariant ticks，action 持有 Handle 并二次 exact CIM', () => {
  assert.equal(DEFAULT_EXTERNAL_TIMEOUT_MS, 15000, '生产 adapter 必须保留 15 秒 fail-closed 上限');
  const source = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '../../../scripts/startup-process-adapter.js'), 'utf8'
  );
  assert.match(source, /ToUniversalTime\(\)\.Ticks\.ToString\(\[Globalization\.CultureInfo\]::InvariantCulture\)/);
  assert.match(source, /\$heldHandle = \$p\.Handle/);
  assert.ok((source.match(/Get-CimInstance Win32_Process -Filter/g) || []).length >= 2);
  assert.match(source, /\$nonceArgument = '\$\{powershellSingleQuotedScalar\(nonceArgument\(nonce\)\)\}'/);
  assert.doesNotMatch(source, /\$nonceArgument = '\$\{powershellJson\(nonceArgument\(nonce\)\)\}'/);
  assert.doesNotMatch(source, /TotalSeconds|ManagementDateTimeConverter/);
});

test('Windows CI 真实 PowerShell snapshot→token cleanup 语义', {
  skip: process.platform !== 'win32'
    || process.env.WINDOWS_STARTUP_PROCESS_ADAPTER_REAL_TEST !== '1',
  timeout: 120000
}, async () => {
  // GitHub hosted Windows 在长时间 release-check 后偶发唤醒 CIM 超过生产 15 秒上限。
  // 预热只作用于专用 CI probe；随后 adapter 仍使用生产默认 15 秒完成整条语义验证。
  let phase = 'bounded CIM warmup';
  let adapter = null;
  let handle = null;
  let cleanupVerified = false;
  try {
    await windowsProcessSnapshot({ timeoutMs: WINDOWS_REAL_PROBE_WARMUP_TIMEOUT_MS });
    adapter = createProcessAdapter({ platform: 'win32' });
    phase = 'adapter launch baseline snapshot';
    handle = await adapter.launch({
      executable: process.execPath,
      cwd: '.',
      env: process.env,
      args: ['-e', 'setTimeout(() => {}, 180000)', '--']
    });
    assert.equal(handle.child.exitCode, null, 'nonce 必须位于 -- 后，不能作为 unknown Node runtime option 令 child exit 9');
    assert.equal(handle.child.signalCode, null);
    phase = 'independent live-root snapshot';
    const rows = await windowsProcessSnapshot();
    const root = rows.find((item) => item.pid === handle.rootPid);
    assert.ok(root, '仍存活的 Node child 必须出现在真实 snapshot');
    assert.match(root.creationDate, /^\d+$/);
    assert.match(root.commandLine, new RegExp(handle.nonce));
    phase = 'graceful-close receipt';
    await assert.rejects(adapter.gracefulClose(handle),
      (error) => error.code === 'PROCESS_TREE_CLOSE_NOT_ACCEPTED',
      'console Node 没有主窗口，但 held-handle graceful action 必须安全返回无 receipt');
    assert.equal(handle.child.exitCode, null, '无主窗 graceful action 不得误杀 child');
    phase = 'force-cleanup receipt';
    const cleanup = await adapter.forceCleanup(handle);
    assert.equal(cleanup.verifiedEmpty, true);
    assert.ok(cleanup.attemptedPids.includes(handle.rootPid));
    assert.ok(cleanup.stoppedPids.includes(handle.rootPid), 'held-handle force action 必须形成 root receipt');
    cleanupVerified = true;
  } catch (error) {
    error.message = `[${phase}] ${error.message}`;
    error.evidence = { ...(error.evidence || {}), testPhase: phase };
    throw error;
  } finally {
    if (adapter && handle && !cleanupVerified
        && handle.child.exitCode === null && handle.child.signalCode === null) {
      try {
        await adapter.forceCleanup(handle);
      } catch {
        handle.child.kill('SIGKILL');
      }
    }
  }
});
