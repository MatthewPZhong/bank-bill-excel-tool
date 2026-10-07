'use strict';
// BizOP 启动升级复现钩子：通过 NODE_OPTIONS=--require 加载，仅在 Electron 主进程生效。
// 只观察与记录，不改变准入判定；模拟开关仅用于非 Windows 机器复现 Windows x64 资格路径。
const { isMainThread } = require('node:worker_threads');
if (process.type !== 'browser' || !isMainThread) return;

const fs = require('node:fs');
const os = require('node:os');
const Module = require('node:module');
const TRACE = process.env.BIZOP_TRACE_FILE;
const GiB = 1024 ** 3; const MiB = 1024 ** 2;
const t0 = Date.now();
function log(ev, data = {}) {
  try { fs.appendFileSync(TRACE, JSON.stringify({ t: Date.now() - t0, ev, ...data }) + '\n'); } catch (_e) {}
}
// 只保留仓库 src/ 下的调用帧，并去掉本机目录前缀。
function stack() {
  return String(new Error().stack).replace(/\\/g, '/').split('\n').slice(2)
    .filter((line) => line.includes('/src/') && !line.includes('/node_modules/'))
    .map((line) => line.trim().replace(/^at /, '').replace(/\(?[^(]*\/src\//, '(src/')).slice(0, 12);
}

// 1) 非 Windows 机器复现时模拟用户机器（16 GB 总内存、5 GB 可用）并视为 win32/x64 资格身份；
//    Windows 真机诊断不开启，记录真实采样。
const SIMULATE = process.env.BIZOP_SIMULATE_WIN_X64 === '1';
if (SIMULATE) {
  os.totalmem = () => 16 * GiB;
  os.freemem = () => 5 * GiB;
}

// 2) 启动失败弹窗不阻塞进程；窗口出现后自动退出（在应用首次加载 electron 模块时打补丁）
let electronPatched = false;
function patchElectron(electron) {
  if (electronPatched) return; electronPatched = true;
  try {
    const { app, dialog } = electron;
    try {
      dialog.showErrorBox = (title, message) => log('showErrorBox', { title,
        message: String(message).replace(/日志文件：.*$/m, '日志文件：<已省略本机路径>') });
    } catch (e) { log('dialog-patch-failed', { message: e.message }); }
    app.on('browser-window-created', () => {
      log('window-created');
      setTimeout(() => { log('auto-quit'); app.quit(); setTimeout(() => { log('auto-exit-fallback'); app.exit(0); }, 8000); }, 4000);
    });
    app.on('will-quit', () => log('will-quit'));
  } catch (e) { log('electron-patch-failed', { message: e.message }); }
}

const carriers = new Map(); let carrierSeq = 0;
const activities = new Map(); let activitySeq = 0;
function track(carrier, via) {
  const id = ++carrierSeq;
  const kind = carrier && carrier.constructor ? carrier.constructor.name : typeof carrier;
  const entry = { id, via, kind, threadId: carrier && carrier.threadId, createdAt: Date.now() - t0, stack: stack() };
  carriers.set(id, entry);
  log('carrier-created', entry);
  const done = (code) => { carriers.delete(id); log('carrier-exit', { id, kind, code, aliveMs: Date.now() - t0 - entry.createdAt }); };
  if (carrier && typeof carrier.once === 'function') carrier.once('exit', done);
  return carrier;
}
let activityModule = null;
let governorSeq = 0;
const originals = new WeakMap();

function summarizeGovernor(gov) {
  const s = gov.snapshot();
  return { available: { ...s.available, memoryMiB: s.available.memoryBytes / MiB }, budgets: { ...s.budgets, memoryMiB: s.budgets.memoryBytes / MiB },
    activeLeases: s.activeLeases.map((l) => ({ kind: l.kind, actionKey: l.actionKey, memoryMode: l.memoryMode, resources: l.resources })),
    queued: s.queued.entries.length, diagnostics: s.diagnostics };
}

function patch(filename, exp) {
  filename = filename.replace(/\\/g, '/');
  if (filename.endsWith('/execution-descriptors/memory-evidence.js')) {
    if (!SIMULATE) return;
    const orig = exp.qualifiedProfile;
    exp.qualifiedProfile = (manifest, config, identity) => orig(manifest, config, { ...identity, platform: 'win32', arch: 'x64' });
    log('patched', { file: 'memory-evidence', note: '资格身份视为 win32/x64' });
  } else if (filename.endsWith('/background-execution/memory-activity.js')) {
    activityModule = exp;
    const origAdmission = exp.memoryCarrierAdmission;
    exp.memoryCarrierAdmission = function (memoryConfig) {
      const admission = origAdmission(memoryConfig);
      return { observe: (carrier) => admission.observe(track(carrier, 'memoryCarrierAdmission')) };
    };
    const origObserve = exp.observeMemoryCarrier;
    exp.observeMemoryCarrier = (create, memoryConfig) => origObserve(() => track(create(), 'observeMemoryCarrier'), memoryConfig);
    const origRun = exp.runMemoryActivity;
    exp.runMemoryActivity = (work, options) => origRun(async () => {
      const id = ++activitySeq; const entry = { id, startedAt: Date.now() - t0, stack: stack() };
      activities.set(id, entry); log('activity-enter', entry);
      try { return await work(); } finally { activities.delete(id); log('activity-exit', { id }); }
    }, options);
    log('patched', { file: 'memory-activity' });
  } else if (filename.endsWith('/background-execution/resource-governor.js')) {
    const origCreate = exp.createResourceGovernor; const origClose = exp.closeResourceGovernor; const origRelease = exp.releaseResourceWhenUnreferenced;
    exp.createResourceGovernor = (options) => {
      const gov = origCreate(options); const gid = ++governorSeq;
      log('governor-created', { gid, budgets: options && options.budgets, memoryAdmission: Boolean(options && options.memoryAdmission), stack: stack() });
      const wrap = (name) => (request) => {
        const isPrecheck = request && request.actionKey === 'biz-op-v327:upgrade-preflight' && String(request.ownerKey).startsWith('biz-op-v327:precheck:');
        const base = { gid, method: name, actionKey: request && request.actionKey,
          lowMemoryBehavior: request && request.lowMemoryBehavior, timeoutMs: request && request.timeoutMs };
        if (isPrecheck) {
          log('PRECHECK-SNAPSHOT', { ...base, governor: summarizeGovernor(gov),
            inventory: activityModule ? activityModule.memoryActivitySnapshot() : null,
            liveCarriers: [...carriers.values()], liveActivities: [...activities.values()], freeMemMiB: os.freemem() / MiB, stack: stack() });
        } else log('acquire', base);
        const promise = gov[name](request);
        promise.then((lease) => log(isPrecheck ? 'PRECHECK-GRANTED' : 'granted', { ...base, memMiB: lease && lease.resources && lease.resources.memoryBytes / MiB }),
          (error) => log(isPrecheck ? 'PRECHECK-REJECTED' : 'rejected', { ...base, code: error && error.code, message: error && error.message, details: error && error.details }));
        return promise;
      };
      const wrapped = Object.freeze({ ...gov, acquireBaseLease: wrap('acquireBaseLease'), acquirePhaseLease: wrap('acquirePhaseLease'),
        acquireCompoundLease: wrap('acquireCompoundLease'), acquirePersistentReservation: wrap('acquirePersistentReservation'),
        acquirePendingInteractionReservation: wrap('acquirePendingInteractionReservation') });
      originals.set(wrapped, gov);
      return wrapped;
    };
    exp.closeResourceGovernor = (g, reason) => origClose(originals.get(g) || g, reason);
    exp.releaseResourceWhenUnreferenced = (g, id, reason) => origRelease(originals.get(g) || g, id, reason);
    log('patched', { file: 'resource-governor' });
  } else if (filename.endsWith('/biz-op-v327/upgrade-main.js')) {
    const origCreate = exp.createBizOpUpgrade;
    exp.createBizOpUpgrade = (deps) => {
      const upgrade = origCreate(deps);
      return Object.freeze({ ...upgrade, run(options) {
        log('activation-run', { options, phaseBefore: upgrade.status().phase, stack: stack() });
        const p = upgrade.run(options);
        p.then((r) => log('activation-run-result', { result: { status: r && r.status, phase: r && r.phase } }),
          (e) => log('activation-run-error', { code: e && e.code, message: e && e.message, detailLines: e && e.detailLines }));
        return p;
      } });
    };
    log('patched', { file: 'upgrade-main' });
  }
}

const targets = ['memory-evidence', 'memory-activity', 'resource-governor', 'upgrade-main'];
const patched = new Set();
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  const exp = origLoad.apply(this, arguments);
  if (request === 'electron' && !electronPatched) patchElectron(exp);
  if (typeof request === 'string' && targets.some((name) => request.endsWith(name) || request.endsWith(`${name}.js`))) {
    try {
      const filename = Module._resolveFilename(request, parent, isMain);
      if (!patched.has(filename)) { patched.add(filename); patch(filename, exp); }
    } catch (e) { log('patch-error', { request, message: e.message }); }
  }
  return exp;
};
log('hook-loaded', { electron: process.versions.electron, platform: process.platform, arch: process.arch, simulate: SIMULATE });
