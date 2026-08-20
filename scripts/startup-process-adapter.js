'use strict';

const { execFile, spawn } = require('node:child_process');
const crypto = require('node:crypto');
const path = require('node:path');

const DEFAULT_EXTERNAL_TIMEOUT_MS = 15000;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function codedError(code, message, evidence = {}) {
  const error = new Error(message);
  error.code = code;
  error.evidence = evidence;
  return error;
}

function withHardTimeout(promise, timeoutMs, code, message) {
  const bounded = Math.max(1, Number(timeoutMs) || 1);
  let timer = null;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(codedError(code, message, { timeoutMs: bounded })), bounded);
    })
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function execFileAsync(file, args, options = {}) {
  const timeoutMs = Math.max(1, Number(options.timeoutMs) || DEFAULT_EXTERNAL_TIMEOUT_MS);
  return new Promise((resolve, reject) => {
    execFile(file, args, {
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
      timeout: timeoutMs,
      killSignal: 'SIGKILL'
    }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

async function windowsProcessSnapshot(options = {}) {
  const stdout = await execFileAsync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate,ExecutablePath,CommandLine | ForEach-Object {
      [PSCustomObject]@{
        ProcessId = $_.ProcessId
        ParentProcessId = $_.ParentProcessId
        CreationDate = $_.CreationDate.ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture)
        ExecutablePath = [string]$_.ExecutablePath
        CommandLine = [string]$_.CommandLine
      }
    } | ConvertTo-Json -Compress`
  ], options);
  if (!String(stdout).trim()) return [];
  const parsed = JSON.parse(stdout);
  return (Array.isArray(parsed) ? parsed : [parsed]).map((item) => ({
    pid: Number(item.ProcessId),
    parentPid: Number(item.ParentProcessId),
    creationDate: String(item.CreationDate || ''),
    executablePath: String(item.ExecutablePath || ''),
    commandLine: String(item.CommandLine || '')
  }));
}

function createProcessAdapter(options = {}) {
  const platform = options.platform || process.platform;
  const spawnImpl = options.spawn || spawn;
  const snapshot = options.windowsProcessSnapshot || windowsProcessSnapshot;
  const runFile = options.execFileAsync || execFileAsync;
  const now = options.now || (() => Number(process.hrtime.bigint()) / 1e6);
  const wait = options.delay || delay;
  const externalTimeoutMs = Math.max(
    1,
    Number(options.externalTimeoutMs) || DEFAULT_EXTERNAL_TIMEOUT_MS
  );
  const cleanupTimeoutMs = Math.max(1, Number(options.cleanupTimeoutMs) || 15000);
  const nonceFactory = options.nonceFactory || (() => crypto.randomUUID());
  const tokenOf = (item) => [
    String(item.creationDate || ''),
    String(item.executablePath || '').toLocaleLowerCase('en-US'),
    String(item.commandLine || '')
  ].join('\u0000');
  const operationTimeout = (requested, fallback = externalTimeoutMs) => (
    Math.max(1, Math.min(Number(requested) || fallback, fallback))
  );
  const snapshotWithTimeout = (timeoutMs = externalTimeoutMs) => withHardTimeout(
    snapshot({ timeoutMs }),
    timeoutMs,
    'PROCESS_SNAPSHOT_TIMEOUT',
    'Windows process snapshot 超时'
  );
  const runFileWithTimeout = (file, args, timeoutMs, code, message) => withHardTimeout(
    runFile(file, args, { timeoutMs }),
    timeoutMs,
    code,
    message
  );
  const nonceArgument = (nonce) => `--startup-measure-nonce=${nonce}`;
  const hasNonce = (item, nonce) => {
    const argument = nonceArgument(nonce).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?:^|[\\s"])+${argument}(?=$|[\\s"])`).test(String(item.commandLine || ''));
  };
  const expectedPayload = (handle, livePids) => livePids.map((pid) => {
    const item = handle.processRecords.get(pid) || {};
    return {
      pid,
      creationDate: String(item.creationDate || ''),
      executablePath: String(item.executablePath || ''),
      commandLine: String(item.commandLine || ''),
      requiresNonce: Boolean(item.nonceSeeded)
    };
  });
  const powershellJson = (value) => JSON.stringify(value).replace(/'/g, "''");
  const powershellSingleQuotedScalar = (value) => String(value).replace(/'/g, "''");
  const tokenMatchScript = (expected, nonce, action) => `
$expected = ConvertFrom-Json '${powershellJson(expected)}'
$nonceArgument = '${powershellSingleQuotedScalar(nonceArgument(nonce))}'
$receipts = @()
foreach($e in $expected) {
  $processId = [int]$e.pid
  $cim = Get-CimInstance Win32_Process -Filter "ProcessId=$processId" -ErrorAction SilentlyContinue
  if(-not $cim) { continue }
  $currentCreation = $cim.CreationDate.ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture)
  if($currentCreation -ne [string]$e.creationDate) { continue }
  if(([string]$cim.ExecutablePath).ToLowerInvariant() -ne ([string]$e.executablePath).ToLowerInvariant()) { continue }
  if([string]$cim.CommandLine -ne [string]$e.commandLine) { continue }
  if($e.requiresNonce -and ([string]$cim.CommandLine).IndexOf($nonceArgument, [StringComparison]::Ordinal) -lt 0) { continue }
  $p = Get-Process -Id $processId -ErrorAction SilentlyContinue
  if(-not $p) { continue }
  try {
    $heldHandle = $p.Handle
    if($e.executablePath -and ([string]$p.Path).ToLowerInvariant() -ne ([string]$e.executablePath).ToLowerInvariant()) { continue }
    $verify = Get-CimInstance Win32_Process -Filter "ProcessId=$processId" -ErrorAction SilentlyContinue
    if(-not $verify) { continue }
    $verifyCreation = $verify.CreationDate.ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture)
    if($verifyCreation -ne [string]$e.creationDate) { continue }
    if(([string]$verify.ExecutablePath).ToLowerInvariant() -ne ([string]$e.executablePath).ToLowerInvariant()) { continue }
    if([string]$verify.CommandLine -ne [string]$e.commandLine) { continue }
    if($e.requiresNonce -and ([string]$verify.CommandLine).IndexOf($nonceArgument, [StringComparison]::Ordinal) -lt 0) { continue }
    ${action}
  } catch { continue }
}
$receipts | ConvertTo-Json -Compress
`.trim();

  const adapter = {
    async launch({ executable, cwd, env, timeoutMs, nonce, args = [] }) {
      const bounded = operationTimeout(timeoutMs);
      const baseline = platform === 'win32' ? await snapshotWithTimeout(bounded) : [];
      // TechDoc 的外部指标从“进程创建”起算；baseline CIM 取证不属于启动耗时。
      const processCreatedAt = now();
      const measurementNonce = String(nonce || nonceFactory());
      if (!/^[A-Za-z0-9-]{16,128}$/.test(measurementNonce)) {
        throw codedError('PROCESS_NONCE_INVALID', 'startup measurement nonce 非法');
      }
      const child = spawnImpl(executable, [...args, nonceArgument(measurementNonce)], {
        cwd,
        env,
        windowsHide: false,
        stdio: 'ignore'
      });
      let resolveRootExit;
      const exitPromise = new Promise((resolve) => { resolveRootExit = resolve; });
      const handle = {
        child,
        processCreatedAt,
        rootPid: Number(child.pid),
        rootExecutableBasename: path.win32.basename(String(executable)).toLocaleLowerCase('en-US'),
        nonce: measurementNonce,
        knownPids: new Set([Number(child.pid)]),
        processTokens: new Map(),
        processRecords: new Map(),
        baselineTokens: new Map(baseline.map((item) => [item.pid, tokenOf(item)])),
        lastLivePids: new Set(),
        lastSnapshot: baseline,
        suspiciousPids: new Set(),
        rootExit: null,
        exitPromise
      };
      child.once('exit', (code, signal) => {
        handle.rootExit = { code, signal };
        resolveRootExit(handle.rootExit);
      });
      await new Promise((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
      });
      return handle;
    },

    async refreshTree(handle, request = {}) {
      if (platform !== 'win32') return [...handle.knownPids];
      const timeoutMs = operationTimeout(typeof request === 'number' ? request : request.timeoutMs);
      const processes = await snapshotWithTimeout(timeoutMs);
      const remember = (item, livePids) => {
        handle.knownPids.add(item.pid);
        if (!handle.processTokens.has(item.pid)) {
          handle.processTokens.set(item.pid, tokenOf(item));
          handle.processRecords.set(item.pid, { ...item, nonceSeeded: hasNonce(item, handle.nonce) });
        }
        if (handle.processTokens.get(item.pid) === tokenOf(item)) livePids.add(item.pid);
      };
      const livePids = new Set();
      const byPid = new Map(processes.map((item) => [item.pid, item]));
      for (const item of processes) {
        if (handle.processTokens.has(item.pid)
            && handle.processTokens.get(item.pid) === tokenOf(item)) {
          livePids.add(item.pid);
        }
      }
      const currentRoot = byPid.get(handle.rootPid);
      const currentRootImageMatches = Boolean(currentRoot
        && path.win32.basename(String(currentRoot.executablePath || '')).toLocaleLowerCase('en-US')
          === handle.rootExecutableBasename);
      if (!handle.processTokens.has(handle.rootPid)
          && (handle.rootExit || !currentRoot || !currentRootImageMatches
            || !hasNonce(currentRoot, handle.nonce))) {
        handle.lastLivePids = new Set();
        throw codedError(
          'PROCESS_OWNERSHIP_UNESTABLISHED',
          'spawn root 在取得权威 process token 前已退出',
          { rootPid: handle.rootPid, requiresManualCleanup: true }
        );
      }
      if (currentRoot && !handle.processTokens.has(handle.rootPid)
          && currentRootImageMatches && hasNonce(currentRoot, handle.nonce)) {
        remember(currentRoot, livePids);
      }
      let changed = true;
      while (changed) {
        changed = false;
        for (const item of processes) {
          const isUnchangedBaselineProcess = handle.baselineTokens.get(item.pid) === tokenOf(item);
          if (!isUnchangedBaselineProcess
              && !handle.processTokens.has(item.pid) && livePids.has(item.parentPid)) {
            remember(item, livePids);
            changed = true;
          }
        }
      }
      const suspiciousPids = new Set();
      for (const item of processes) {
        const isUnchangedBaselineProcess = handle.baselineTokens.get(item.pid) === tokenOf(item);
        if (!isUnchangedBaselineProcess && !handle.processTokens.has(item.pid)
            && handle.knownPids.has(item.parentPid) && !livePids.has(item.parentPid)
            && !hasNonce(item, handle.nonce)) {
          suspiciousPids.add(item.pid);
        }
      }
      handle.lastSnapshot = processes;
      handle.lastLivePids = livePids;
      handle.suspiciousPids = suspiciousPids;
      return [...livePids];
    },

    async gracefulClose(handle, request = {}) {
      const timeoutMs = operationTimeout(typeof request === 'number' ? request : request.timeoutMs);
      const deadline = Date.now() + timeoutMs;
      const remaining = () => Math.max(1, deadline - Date.now());
      await this.refreshTree(handle, { timeoutMs: remaining() });
      if (platform === 'win32') {
        if (handle.suspiciousPids.size > 0) {
          throw codedError('PROCESS_LINEAGE_AMBIGUOUS', '发现 parent 曾 owned 但无 nonce 的可疑 child，禁止操作', {
            suspiciousPids: [...handle.suspiciousPids], requiresManualCleanup: true
          });
        }
        const livePids = [...handle.lastLivePids].filter(Number.isSafeInteger);
        if (livePids.length === 0) {
          throw codedError('PROCESS_TREE_CLOSE_TARGET_MISSING', 'ready 后没有 token-matched owned live process 可关闭');
        }
        const expected = expectedPayload(handle, livePids);
        const stdout = await runFileWithTimeout('powershell.exe', [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          tokenMatchScript(expected, handle.nonce,
            'if($p.MainWindowHandle -ne 0 -and $p.CloseMainWindow()){ $receipts += $processId }')
        ], remaining(), 'PROCESS_CLOSE_TIMEOUT', 'CloseMainWindow 动作超时');
        const normalized = String(stdout || '').trim();
        const parsed = normalized ? JSON.parse(normalized) : [];
        const acceptedPids = (Array.isArray(parsed) ? parsed : [parsed])
          .map(Number).filter((pid) => livePids.includes(pid));
        if (acceptedPids.length === 0) {
          throw codedError('PROCESS_TREE_CLOSE_NOT_ACCEPTED', 'owned process tree 没有 token-matched 主窗口接受 CloseMainWindow', { livePids });
        }
        return { livePids, acceptedPids, tokenRevalidated: true };
      }
      if (handle.child.exitCode === null && handle.child.signalCode === null) {
        handle.child.kill('SIGTERM');
        return { livePids: [handle.rootPid], acceptedPids: [handle.rootPid], tokenRevalidated: true };
      }
      throw codedError('PROCESS_TREE_CLOSE_TARGET_MISSING', 'ready 后进程已提前退出，无法 graceful close');
    },

    async waitForExit(handle, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      const quiescenceSnapshots = [];
      while (Date.now() < deadline) {
        if (platform === 'win32') {
          const remaining = Math.max(1, deadline - Date.now());
          await this.refreshTree(handle, { timeoutMs: Math.min(externalTimeoutMs, remaining) });
          if (handle.suspiciousPids.size > 0) {
            throw codedError(
              'PROCESS_LINEAGE_AMBIGUOUS',
              'graceful close 后发现 parent 曾 owned 的可疑 child，无法证明进程树退出',
              {
                suspiciousPids: [...handle.suspiciousPids],
                quiescenceSnapshots,
                requiresManualCleanup: true
              }
            );
          }
          const observed = [...handle.lastLivePids];
          if (observed.length === 0) {
            quiescenceSnapshots.push(observed);
            if (quiescenceSnapshots.length >= 3) {
              return {
                exited: true,
                verifiedEmpty: true,
                rootExit: handle.rootExit,
                quiescenceSnapshots
              };
            }
          } else {
            quiescenceSnapshots.length = 0;
          }
        } else if (handle.child.exitCode !== null || handle.child.signalCode !== null) {
          return { exited: true, verifiedEmpty: true, rootExit: handle.rootExit };
        }
        await wait(Math.min(100, Math.max(1, deadline - Date.now())));
      }
      return {
        exited: false,
        verifiedEmpty: false,
        rootExit: handle.rootExit,
        quiescenceSnapshots
      };
    },

    async waitForRootExit(handle, timeoutMs) {
      if (handle.rootExit) return handle.rootExit;
      return withHardTimeout(handle.exitPromise, timeoutMs,
        'PROCESS_ROOT_EXIT_TIMEOUT', 'root process exitPromise 超时').catch((error) => {
        if (error.code === 'PROCESS_ROOT_EXIT_TIMEOUT') return null;
        throw error;
      });
    },

    async forceCleanup(handle, request = {}) {
      const timeoutMs = Math.max(1, Math.min(
        Number(typeof request === 'number' ? request : request.timeoutMs) || cleanupTimeoutMs,
        cleanupTimeoutMs
      ));
      const deadline = Date.now() + timeoutMs;
      const remaining = () => Math.max(1, deadline - Date.now());
      if (platform === 'win32') {
        try {
          await this.refreshTree(handle, { timeoutMs: Math.min(remaining(), externalTimeoutMs) });
        } catch (error) {
          if (error && error.code === 'PROCESS_OWNERSHIP_UNESTABLISHED') {
            throw codedError(
              'PROCESS_CLEANUP_OWNERSHIP_UNESTABLISHED',
              '无法建立 process ownership，禁止猜测或强杀；需要人工清理',
              { requiresManualCleanup: true, rootPid: handle.rootPid }
            );
          }
          throw error;
        }
        const livePids = [...handle.lastLivePids].filter(Number.isSafeInteger);
        let stoppedPids = [];
        if (livePids.length > 0) {
          const expected = expectedPayload(handle, livePids.reverse());
          const stdout = await runFileWithTimeout('powershell.exe', [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            tokenMatchScript(expected, handle.nonce,
              'Stop-Process -InputObject $p -Force -PassThru -ErrorAction Stop | Out-Null; $p.WaitForExit(2000) | Out-Null; $receipts += $processId')
          ], Math.min(remaining(), externalTimeoutMs),
          'PROCESS_FORCE_CLEANUP_TIMEOUT', 'force cleanup 动作超时');
          const normalized = String(stdout || '').trim();
          const parsed = normalized ? JSON.parse(normalized) : [];
          stoppedPids = (Array.isArray(parsed) ? parsed : [parsed]).map(Number)
            .filter((pid) => livePids.includes(pid));
        }
        const quiescenceSnapshots = [];
        for (let index = 0; index < 3; index += 1) {
          await this.refreshTree(handle, { timeoutMs: Math.min(remaining(), externalTimeoutMs) });
          const observed = [...handle.lastLivePids];
          quiescenceSnapshots.push(observed);
          if (observed.length > 0 || handle.suspiciousPids.size > 0) break;
          if (index < 2) await wait(Math.min(100, remaining()));
        }
        const remainingPids = quiescenceSnapshots.at(-1) || [];
        if (remainingPids.length > 0 || handle.suspiciousPids.size > 0) {
          throw codedError('PROCESS_CLEANUP_UNVERIFIED', 'force cleanup 后 owned process tree 仍存活', {
            attemptedPids: livePids,
            stoppedPids,
            remainingPids,
            suspiciousPids: [...handle.suspiciousPids],
            requiresManualCleanup: true
          });
        }
        return { attemptedPids: livePids, stoppedPids, remainingPids: [], verifiedEmpty: true, quiescenceSnapshots };
      }
      if (handle.child.exitCode === null && handle.child.signalCode === null) handle.child.kill('SIGKILL');
      const exited = handle.child.exitCode !== null || handle.child.signalCode !== null;
      if (!exited) throw codedError('PROCESS_CLEANUP_UNVERIFIED', 'SIGKILL 后 root process 退出无法证明', { requiresManualCleanup: true });
      return { attemptedPids: [handle.rootPid], stoppedPids: [handle.rootPid], remainingPids: [], verifiedEmpty: true };
    },

    delay: wait
  };
  return adapter;
}

module.exports = {
  DEFAULT_EXTERNAL_TIMEOUT_MS,
  createProcessAdapter,
  execFileAsync,
  windowsProcessSnapshot,
  withHardTimeout
};
