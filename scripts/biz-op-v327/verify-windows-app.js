'use strict';

// 使用正常应用入口、真实单实例锁、生产门禁与 renderer IPC；仅替代原生文件选择。
// 所有文件、数据库和进程均由本脚本创建，运行结果不代表目标用户设备人工验收。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { randomUUID, createHash } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { writeXlsx, opRow, flowRow } = require('../../tests/helpers/biz-op-v327-xlsx');
const { seedLegacy } = require('../../tests/helpers/biz-op-v327-upgrade');
const { RELEASE_GATES } = require('../../src/main-process/biz-op-v327/release-gates');

const project = path.resolve(__dirname, '../..');
const output = path.join(project, 'outputs/windows-bizop-acceptance');
const root = fs.mkdtempSync(path.join(os.tmpdir(), '业务OP 正常应用验收-'));
const userData = path.join(root, 'userData');
const documents = path.join(root, 'documents');
const exportsDir = path.join(root, 'exports');
for (const directory of [output, userData, documents, exportsDir]) fs.mkdirSync(directory, { recursive: true });
const evidence = { schemaVersion: 1, platform: process.platform, releaseGates: RELEASE_GATES,
  startedAt: new Date().toISOString(), steps: [], root, status: 'RUNNING' };
const sha = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function record(name, value) { evidence.steps.push({ name, value }); console.log(`[bizop-app] ${name}: ${JSON.stringify(value)}`); }
function query(sql) {
  const db = new DatabaseSync(path.join(userData, 'tool-data.sqlite'), { readOnly: true });
  try { return JSON.parse(JSON.stringify(db.prepare(sql).all())); } finally { db.close(); }
}
async function until(work, label, timeout = 120000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const result = await work(); if (result) return result; await delay(200); }
  throw new Error(`${label} 超时`);
}

async function connect(url) {
  const socket = new WebSocket(url); const pending = new Map(); const events = new Map(); let id = 0;
  socket.addEventListener('close', () => {
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('自有应用调试连接已关闭')); }
    pending.clear();
  });
  socket.addEventListener('message', ({ data }) => {
    const value = JSON.parse(data);
    if (value.id) { const item = pending.get(value.id); if (!item) return; pending.delete(value.id);
      clearTimeout(item.timer); if (value.error) item.reject(new Error(`${item.method}: ${JSON.stringify(value.error)}`)); else item.resolve(value.result); }
    else if (events.has(value.method)) { events.get(value.method)(value.params); events.delete(value.method); }
  });
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  function send(method, params = {}) {
    return new Promise((resolve, reject) => { const key = ++id;
      const timer = setTimeout(() => { pending.delete(key); reject(new Error(`调试控制超时: ${method}`)); }, 120000);
      pending.set(key, { resolve, reject, timer, method }); socket.send(JSON.stringify({ id: key, method, params })); });
  }
  return { send, event: method => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { events.delete(method); reject(new Error(`调试事件超时: ${method}`)); }, 15000);
    events.set(method, value => { clearTimeout(timer); resolve(value); });
  }), close: () => socket.close() };
}
async function launch(label) {
  const env = { ...process.env, APP_USER_DATA_DIR: userData, APP_DOCUMENTS_DIR: documents,
    APP_STARTUP_METRICS_PATH: path.join(output, `${label}-startup.json`), ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' };
  // 禁止测量/预览/打包 canary 的启动捷径进入本项验收。
  for (const key of Object.keys(env)) if (key.startsWith('APP_CAPTURE') || key.startsWith('APP_PACKAGED_RUNTIME')
      || ['ELECTRON_RUN_AS_NODE', 'APP_STARTUP_MEASURE_AUTO_QUIT'].includes(key)) delete env[key];
  const child = spawn(require('electron'), ['--inspect=127.0.0.1:0', '.'], { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let transcript = ''; let exited = false; const stopped = once(child, 'exit').then(([code, signal]) => { exited = true; return { code, signal }; });
  child.stdout.on('data', chunk => { transcript += chunk; }); child.stderr.on('data', chunk => { transcript += chunk; });
  let cdp;
  async function stop(force = false) {
    if (!exited) {
      if (force || !cdp) child.kill('SIGKILL');
      else {
        await cdp.send('Runtime.evaluate', { expression: 'setTimeout(() => globalThis.__acceptElectron.app.quit(), 100); true', returnByValue: true }).catch(() => {});
        cdp.close();
      }
      await Promise.race([stopped, delay(10000).then(() => { if (!exited) child.kill('SIGKILL'); })]);
    }
    cdp?.close(); fs.writeFileSync(path.join(output, `${label}-process.log`), transcript);
    return stopped;
  }
  async function evaluate(expression) {
    async function direct(source) {
      const result = await cdp.send('Runtime.evaluate', { expression: source, returnByValue: true });
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    }
    // Electron 启动上下文切换时 inspector awaitPromise 可能报告 Promise was collected。
    // 在主进程持有结果并显式观察完成，避免调试协议替业务 Promise 决定生存期。
    await direct(`globalThis.__acceptPending = {done:false}; globalThis.__acceptPromise = Promise.resolve().then(() => (${expression}))
      .then(value => {globalThis.__acceptPending = {done:true,value};}, error => {globalThis.__acceptPending = {done:true,error:String(error.stack || error)};}); true`);
    const result = await until(() => direct('globalThis.__acceptPending?.done ? globalThis.__acceptPending : null'), '主进程求值');
    if (result.error) throw new Error(result.error);
    return result.value;
  }
  try {
    const url = await until(() => { if (exited) throw new Error(`应用提前退出: ${transcript}`);
      return transcript.match(/Debugger listening on (ws:\/\/\S+)/)?.[1]; }, '主进程调试端口', 15000);
    cdp = await connect(url);
    // 等待正常启动器完成装载再接入，不暂停应用或改变启动顺序。
    await delay(2000);
    if (transcript.includes('[startup failure]')) throw new Error(transcript);
    await evaluate(`(globalThis.__acceptElectron = process.getBuiltinModule('module').createRequire(${JSON.stringify(path.join(project, 'package.json'))})('electron'), true)`);
    await until(async () => {
      if (exited) throw new Error(`应用启动失败: ${transcript}`);
      if (transcript.includes('[startup failure]')) throw new Error(transcript);
      return evaluate("globalThis.__acceptElectron.BrowserWindow.getAllWindows().some(w => w.webContents.getURL().endsWith('index.html') && !w.webContents.isLoading())");
    }, '正常主窗口');
    const renderer = expression => evaluate(`globalThis.__acceptElectron.BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('index.html')).webContents.executeJavaScript(${JSON.stringify(expression)})`);
    const api = (method, ...args) => renderer(`window.desktopApi.bizOpReconV327[${JSON.stringify(method)}](...${JSON.stringify(args)})`);
    const runtime = await evaluate("({versions:process.versions,lock:globalThis.__acceptElectron.app.hasSingleInstanceLock(),appPath:globalThis.__acceptElectron.app.getAppPath(),userData:globalThis.__acceptElectron.app.getPath('userData')})");
    assert.equal(runtime.lock, true); assert.equal(path.resolve(runtime.appPath), project); assert.equal(runtime.userData, userData);
    const status = await api('status'); assert.equal(status.mode, 'ACTIVE'); assert.equal(status.recoveryReady, true);
    record(label, { runtime, status });
    return { api, evaluate, renderer, stop };
  } catch (error) { await stop(true); throw error; }
}

async function main() {
  const seedDb = new DatabaseSync(path.join(userData, 'tool-data.sqlite'));
  const old = seedLegacy({ root: userData, db: seedDb }); seedDb.close();
  const externalSha = sha(old.external); let app;
  try {
    app = await launch('first-activation');
    assert.equal(fs.existsSync(old.oldFile), false);
    assert.equal(sha(old.external), externalSha);
    assert.equal(query('SELECT value FROM preserve_settings')[0].value, 'unchanged');
    const activation = query('SELECT * FROM biz_op_v327_activation');
    assert.equal(activation[0].phase, 'ACTIVE');
    await app.stop(); app = await launch('active-restart');
    assert.deepEqual(query('SELECT * FROM biz_op_v327_activation'), activation);
    assert.equal(query("SELECT COUNT(*) AS n FROM archive_task_runs WHERE task_key='bizOpReconV327:maintenance:upgrade'")[0].n, 1);
    const files = ['期初.xlsx', '期末.xlsx', '入出金.xlsx'].map(name => path.join(root, name));
    await writeXlsx(files[0], { kind: 'OP', rowCount: 1, row: () => opRow({ amount: '0', incoming: '0', end: '100' }) });
    await writeXlsx(files[1], { kind: 'OP', rowCount: 1, row: () => opRow({ date: '2026-09-03', begin: '120', amount: '0', incoming: '0', end: '120' }) });
    await writeXlsx(files[2], { rowCount: 3, row: i => flowRow({ date: i === 2 ? '2026-09-03' : '2026-09-02', amount: i === 0 ? '15' : i === 1 ? '5' : '0', direction: i === 1 ? '出' : '入' }) });
    const hashes = files.map(sha);
    async function importFiles(selected) {
      await app.evaluate(`globalThis.__acceptElectron.dialog.showOpenDialog = async () => ({canceled:false,filePaths:${JSON.stringify(selected)}})`);
      const pick = await app.api('pickFiles'); assert.equal(pick.status, 'ok');
      return app.api('importFiles', { requestId: randomUUID(), selectionRef: pick.selectionRef });
    }
    const imported = await importFiles(files); assert.equal(imported.status, 'ok', JSON.stringify(imported));
    assert.equal(imported.cleanupPending, false); record('import', imported);
    const month = (await app.api('months', {})).months[0];
    for (const view of ['RAW', 'CHECK']) for (const kind of ['OP', 'FLOW']) {
      const list = await app.api('list', { view, kind, operationMonth: month });
      assert.equal(list.rows.length, 2, JSON.stringify(list)); record(`list-${kind}-${view}`, list.rows);
    }
    const preflight = await app.api('preflight', { startDate: '2026-09-01', endDate: '2026-09-03' }); assert.equal(preflight.status, 'ok', JSON.stringify(preflight));
    const run = await app.api('run', { requestId: randomUUID(), selectionRef: preflight.selectionRef });
    assert.equal(run.status, 'ok', JSON.stringify(run)); assert.equal(run.cleanupPending, false); assert.equal(run.diffRowCount, 1); record('compute', run);
    const op = await app.api('currentInput', { kind: 'OP', dataDate: '2026-09-01' });
    const flow = await app.api('currentInput', { kind: 'FLOW', dataDate: '2026-09-02' });
    const kinds = ['OP_RAW', 'FLOW_RAW', 'OP_CHECK', 'FLOW_CHECK', 'RESULT_FULL', 'RESULT_DIFF'];
    async function exportOne(kind, objectId) {
      const target = path.join(exportsDir, `${kind}.xlsx`);
      await app.evaluate(`globalThis.__acceptElectron.dialog.showSaveDialog = async () => ({canceled:false,filePath:${JSON.stringify(target)}})`);
      const pick = await app.api('pickExport', { outputKind: kind, objectId }); assert.equal(pick.status, 'ok', JSON.stringify(pick));
      const result = await app.api('exportWorkbook', kind, { requestId: randomUUID(), selectionRef: pick.selectionRef });
      assert.equal(result.status, 'ok', JSON.stringify(result)); assert.equal(result.cleanupPending, false); assert.ok(fs.statSync(target).size > 0);
      const xlsx = require('xlsx');
      const workbook = xlsx.readFile(target);
      const rows = xlsx.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { header: 1, defval: null });
      const columnCounts = { OP_RAW: 23, FLOW_RAW: 28, OP_CHECK: 12, FLOW_CHECK: 9, RESULT_FULL: 19, RESULT_DIFF: 19, ERRORS: 7 };
      assert.equal(rows[0].length, columnCounts[kind]); assert.ok(rows.length > 1);
      if (kind.startsWith('RESULT')) assert.deepEqual(rows[1].slice(10, 15), [15, 5, 10, 110, -10]);
      record(`export-${kind}`, { ...result, sha256: sha(target), bytes: fs.statSync(target).size });
    }
    for (const kind of kinds) await exportOne(kind, kind.startsWith('RESULT') ? run.runId : kind.startsWith('OP') ? op.objectId : flow.objectId);
    const bad = path.join(root, '错误金额.xlsx'); await writeXlsx(bad, { kind: 'OP', rowCount: 1, row: () => opRow({ end: '999' }) });
    const failed = await importFiles([bad]); assert.notEqual(failed.status, 'ok'); assert.ok(failed.reportRef, JSON.stringify(failed)); record('failed-import', failed);
    await exportOne('ERRORS', failed.reportRef);
    const preview = await app.api('deletePreview', { datasetIds: [op.objectId] }); assert.ok(preview.previewId); assert.equal(preview.runs.length, 1);
    const deleted = await app.api('deleteData', { requestId: randomUUID(), previewId: preview.previewId, mode: 'DELETE_ASSOCIATED' });
    assert.equal(deleted.status, 'ok', JSON.stringify(deleted)); assert.equal(deleted.cleanupPending, false); record('delete', deleted);
    assert.equal((await app.api('list', { view: 'RESULT', operationMonth: month })).rows.length, 0);
    assert.deepEqual(files.map(sha), hashes); assert.equal(sha(old.external), externalSha);
    const png = await app.evaluate("globalThis.__acceptElectron.BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('index.html')).webContents.capturePage().then(image => image.toPNG().toString('base64'))");
    fs.writeFileSync(path.join(output, 'normal-window.png'), Buffer.from(png, 'base64'));
    await app.stop(); app = await launch('after-operations-restart');
    assert.deepEqual(query('SELECT * FROM biz_op_v327_activation'), activation);
    assert.equal(query('SELECT COUNT(*) AS n FROM biz_op_v327_read_pins')[0].n, 0);
    record('preserved-files-and-restart', { originalHashes: hashes, activationTaskCount: 1 });
    const headsBeforeCrash = query('SELECT * FROM biz_op_v327_input_heads ORDER BY kind,data_date');
    const interruptedFile = path.join(root, '中断恢复.xlsx');
    await writeXlsx(interruptedFile, { rowCount: 20000, row: () => flowRow({ date: '2026-09-04' }) });
    const interruptedSha = sha(interruptedFile);
    await app.evaluate(`globalThis.__acceptElectron.dialog.showOpenDialog = async () => ({canceled:false,filePaths:[${JSON.stringify(interruptedFile)}]})`);
    const picked = await app.api('pickFiles'); assert.equal(picked.status, 'ok');
    await app.renderer(`(() => {window.__acceptImport = window.desktopApi.bizOpReconV327.importFiles(${JSON.stringify({ requestId: randomUUID(), selectionRef: picked.selectionRef })}); return true;})()`);
    const interruptedTask = await until(() => query("SELECT task_run_id FROM archive_task_runs WHERE task_key='bizOpReconV327:import' AND status='running'")[0], '真实导入进入运行态');
    await app.stop(true); app = await launch('interrupted-import-restart');
    assert.deepEqual(query('SELECT * FROM biz_op_v327_input_heads ORDER BY kind,data_date'), headsBeforeCrash);
    const task = query(`SELECT task_run_id,status,failure_code FROM archive_task_runs WHERE task_run_id='${interruptedTask.task_run_id}'`)[0];
    assert.ok(['failed', 'cancelled'].includes(task.status), JSON.stringify(task));
    assert.equal(sha(interruptedFile), interruptedSha); assert.deepEqual(files.map(sha), hashes);
    assert.equal(query('SELECT COUNT(*) AS n FROM biz_op_v327_read_pins')[0].n, 0);
    record('interrupted-import-recovery', task);
    evidence.status = 'PASS';
  } finally { if (app) await app.stop(); }
}
main().catch(error => { evidence.status = 'FAIL'; evidence.error = error.stack; console.error(error); process.exitCode = 1; })
  .finally(() => { evidence.completedAt = new Date().toISOString(); fs.writeFileSync(path.join(output, 'app-acceptance.json'), JSON.stringify(evidence, null, 2)); });
