'use strict';

const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { normalizeFilePlanV1 } = require('../archive-center/file-plan');
const { ACTIONS, fail, opaque, snapshot, hash } = require('./contracts');
const { collectInputs } = require('./compute-inputs');
const { outputName } = require('./export-cells');

const PREFIX = 'bizOpReconV327:';
function input(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !keys.includes(key))) fail('BIZOP_IPC_INPUT_INVALID');
  return snapshot(value, { maxBytes: 65536 });
}
function response(value) { return snapshot(value, { maxBytes: 262144 }); }
function failure(error) {
  const code = typeof error?.code === 'string' && /^[A-Z0-9_]{1,100}$/.test(error.code) ? error.code : 'BIZOP_OPERATION_FAILED';
  // 系统错误可能含内部路径；只回传本模块的有界业务文案和完整缺失清单。
  const message = code.startsWith('BIZOP_') ? Array.from(String(error.message || '操作未完成')).slice(0, 1000).join('') : '操作未完成，请查看任务记录并重试';
  try { return response({ status: 'error', code, message, ...(error?.missing ? { missing: error.missing } : {}) }); }
  catch (_error) { return { status: 'error', code: 'BIZOP_IPC_METADATA_LIMIT', message: '完整元数据超过本次响应预算，请缩小选取范围后重试' }; }
}
function compact(result) {
  const keys = ['status', 'code', 'message', 'taskRunId', 'runId', 'version', 'reused', 'publishedAt', 'fullRowCount',
    'diffRowCount', 'dataRowCount', 'noteRowCount', 'sheetCount', 'pendingArchiveHandoff', 'reportRef', 'summary'];
  return Object.fromEntries(keys.filter((key) => result?.[key] !== undefined).map((key) => [key, result[key]]));
}

function registerBizOpV327Handlers({ ipcMain, getModule, businessOperationRegistry, getTaskLifecycle, getRuntime, dialog, getWindow }) {
  const selections = new Map(); const requests = new Map(); const senderCleanup = new Set();
  function sender(event) {
    const web = event?.sender;
    if (!web || !Number.isSafeInteger(web.id) || getWindow && getWindow()?.webContents !== web
        || event.senderFrame && web.mainFrame && event.senderFrame !== web.mainFrame) fail('BIZOP_IPC_SENDER_INVALID');
    if (!senderCleanup.has(web.id)) {
      senderCleanup.add(web.id);
      web.once?.('destroyed', () => {
        for (const [key, item] of selections) if (item.senderId === web.id) selections.delete(key);
        for (const [key, item] of requests) if (item.senderId === web.id) { if (!item.done) item.controller.abort(); else requests.delete(key); }
        senderCleanup.delete(web.id);
      });
    }
    return web.id;
  }
  function prune() {
    const now = Date.now();
    for (const [key, item] of selections) if (item.expires < now) selections.delete(key);
    for (const [key, item] of requests) if (item.done && item.expires < now) requests.delete(key);
  }
  function issue(senderId, kind, value) {
    prune(); if (selections.size >= 64) fail('BIZOP_SELECTION_LIMIT', '待处理选择过多，请稍后重试');
    const selectionRef = `selection-${randomUUID()}`;
    selections.set(selectionRef, { senderId, kind, value, expires: Date.now() + 600000 }); return selectionRef;
  }
  function take(senderId, ref, kind) {
    opaque(ref); prune(); const item = selections.get(ref);
    if (!item || item.senderId !== senderId || item.kind !== kind) fail('BIZOP_SELECTION_EXPIRED', '文件选择或预检已失效，请重新选择');
    selections.delete(ref); return item.value;
  }
  function register(suffix, keys, work) {
    ipcMain.handle(PREFIX + suffix, (event, raw = {}) => {
      getModule().assertBusinessEnabled();
      return Promise.resolve().then(() => work({ event, senderId: sender(event), value: input(raw, keys), module: getModule() })).then(response).catch(failure);
    });
  }
  async function operation(ctx, kind, work) {
    prune(); const requestId = opaque(ctx.value.requestId); const key = `${ctx.senderId}:${requestId}`;
    const digest = hash({ kind, value: ctx.value }); const existing = requests.get(key);
    if (existing) {
      if (existing.digest !== digest) fail('BIZOP_REQUEST_CONFLICT');
      return existing.promise;
    }
    if ([...requests.values()].some((item) => !item.done && item.senderId === ctx.senderId)) fail('BIZOP_REQUEST_BUSY', '当前操作正在执行，请等待完成');
    if (requests.size >= 64) {
      const old = [...requests].find(([, item]) => item.done);
      if (old) requests.delete(old[0]); else fail('BIZOP_REQUEST_LIMIT');
    }
    const entry = { senderId: ctx.senderId, digest, controller: new AbortController(), done: false, control: null };
    requests.set(key, entry);
    entry.promise = Promise.resolve().then(async () => {
      let result;
      try {
        const dependencies = { taskLifecycle: getTaskLifecycle(), runtime: getRuntime(), signal: entry.controller.signal,
          onControl(control) { entry.control = control; } };
        result = compact(await work(dependencies));
      } catch (error) { result = { ...failure(error) }; }
      // 事务已提交后的回收失败只报告未决，不改写原业务结果或重放业务写入。
      try { const recovery = await ctx.module.recovery.run(); result.cleanupPending = !recovery.ready; }
      catch (_error) { result.cleanupPending = true; }
      return result;
    }).then(response).catch(failure).finally(() => { entry.done = true; entry.expires = Date.now() + 600000; });
    return entry.promise;
  }
  register('files:pick', [], async ({ senderId }) => {
    const picked = await dialog.showOpenDialog(getWindow(), { title: '选择业务 OP 与入出金明细文件', properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Excel 工作簿', extensions: ['xlsx'] }] });
    if (picked.canceled || !picked.filePaths?.length) return { status: 'cancelled' };
    if (picked.filePaths.length > 4096 || picked.filePaths.some((file) => path.extname(file).toLowerCase() !== '.xlsx')) fail('BIZOP_INPUT_SELECTION_INVALID', '请选择 XLSX 文件，文件清单须在当前元数据预算内');
    const plan = normalizeFilePlanV1({ version: 1, allocation: 'eager', inputs: picked.filePaths.map((filePath) => ({ filePath,
      role: 'input', sourceOperation: PREFIX + 'import' })), outputs: [] });
    return { status: 'ok', selectionRef: issue(senderId, 'import', plan), files: picked.filePaths.map((file) => path.basename(file)) };
  });
  register('import', ['requestId', 'selectionRef'], (ctx) => operation(ctx, 'import', (deps) => ctx.module.runImport({ ...deps,
    filePlan: take(ctx.senderId, ctx.value.selectionRef, 'import') })));
  register('run:preflight', ['startDate', 'endDate'], (ctx) => ctx.module.admission.read(() => {
    const frozen = collectInputs({ catalog: ctx.module.catalog, payloadStore: ctx.module.payloadStore, ...ctx.value });
    const value = { ...ctx.value, expectedGeneration: frozen.expectedGeneration };
    return response({ status: 'ok', selectionRef: issue(ctx.senderId, 'run', value), generation: value.expectedGeneration,
      inputs: frozen.documents.map((item) => ({ role: item.role, dataDate: item.dataDate, version: item.inputVersion,
        originals: item.sources.map((source) => source.originalName) })) });
  }));
  register('run', ['requestId', 'selectionRef'], (ctx) => operation(ctx, 'run', (deps) => ctx.module.runCompute({ ...deps,
    ...take(ctx.senderId, ctx.value.selectionRef, 'run') })));
  register('metadata:months', ['before', 'limit'], ({ module, value }) => module.metadata.listMonths(value));
  register('metadata:input', ['kind', 'dataDate'], ({ module, value }) => module.metadata.currentInput(value));
  register('metadata:list', ['view', 'kind', 'operationMonth', 'cursor', 'limit', 'generation'], ({ module, value }) => module.metadata.list(value));
  register('delete:preview', ['datasetIds', 'runIds'], ({ module, value }) => module.previews.create(value));
  register('delete', ['requestId', 'previewId', 'mode'], (ctx) => operation(ctx, 'delete', (deps) => ctx.module.runDelete({ ...deps,
    previewId: ctx.value.previewId, mode: ctx.value.mode })));
  register('export:pick', ['outputKind', 'objectId'], async (ctx) => {
    const { outputKind, objectId } = ctx.value; opaque(objectId);
    const suffix = String(outputKind).toLowerCase().replace('_', '-');
    if (!ACTIONS[`biz-op-v327:export-${suffix}`]) fail('BIZOP_EXPORT_KIND_INVALID');
    const name = ctx.module.admission.read(() => {
      const db = ctx.module.catalog.db; let row;
      if (outputKind.startsWith('RESULT_')) {
        row = db.prepare("SELECT start_date AS startDate,end_date AS endDate,result_version AS version FROM biz_op_v327_runs WHERE run_id=? AND state='PUBLISHED'").get(objectId);
      } else if (outputKind === 'ERRORS') {
        row = db.prepare("SELECT report_ref FROM biz_op_v327_diagnostic_reports WHERE report_ref=? AND state='READY'").get(objectId);
        if (row) return '业务OP导入错误报告.xlsx';
      } else row = db.prepare("SELECT data_date AS dataDate,public_version AS version FROM biz_op_v327_datasets WHERE dataset_id=? AND kind=? AND state='ACTIVE'").get(objectId, outputKind.split('_')[0]);
      if (!row) fail('BIZOP_EXPORT_SOURCE_CHANGED', '选取的表已变化，请重新选取');
      return `${outputName(outputKind, row)}.xlsx`;
    });
    const picked = await dialog.showSaveDialog(getWindow(), { title: '导出业务 OP 数据', defaultPath: name, filters: [{ name: 'Excel 工作簿', extensions: ['xlsx'] }] });
    if (picked.canceled || !picked.filePath) return { status: 'cancelled' };
    if (path.extname(picked.filePath).toLowerCase() !== '.xlsx') fail('BIZOP_OUTPUT_EXTENSION_INVALID', '导出文件须使用 .xlsx 扩展名');
    const filePlan = normalizeFilePlanV1({ version: 1, allocation: 'eager', inputs: [], outputs: [{ filePath: picked.filePath,
      role: 'output', sourceOperation: PREFIX + `export:${suffix}` }] });
    return { status: 'ok', selectionRef: issue(ctx.senderId, `export:${suffix}`, { filePlan, outputKind, objectId }), fileName: path.basename(picked.filePath) };
  });
  for (const { taskKey, kind } of Object.values(ACTIONS)) if (kind === 'EXPORT') {
    const suffix = taskKey.slice(PREFIX.length);
    register(suffix, ['requestId', 'selectionRef'], (ctx) => operation(ctx, suffix, (deps) => ctx.module.runExport({ ...deps,
      ...take(ctx.senderId, ctx.value.selectionRef, suffix) })));
  }
  register('task:cancel', ['requestId'], ({ senderId, value, module }) => {
    const entry = requests.get(`${senderId}:${opaque(value.requestId)}`);
    if (!entry || entry.done) return { status: 'idle' };
    const taskRunId = entry.control?.carrierIdentity?.taskRunId;
    const publication = taskRunId && module.publication.record(taskRunId);
    if (publication && publication.state !== 'NOT_STARTED') return { status: 'protected', message: '文件正在发布与归档，请等待实际完成' };
    entry.controller.abort(); return { status: 'cancelling', message: '已请求取消，正在等待后台任务退出' };
  });
  ipcMain.handle(PREFIX + 'status', () => getModule().getStatus());
  ipcMain.handle(PREFIX + 'recovery:retry', async (event) => {
    if (getWindow) sender(event);
    const operation = businessOperationRegistry.begin({ channel: PREFIX + 'recovery:retry', moduleKey: '业务OP数据核对', functionKey: '重试恢复' });
    if (!operation.accepted) return operation;
    try { return await getModule().recovery.run(); }
    finally { businessOperationRegistry.end(operation.token); }
  });
}

module.exports = { registerBizOpV327Handlers, compact };
