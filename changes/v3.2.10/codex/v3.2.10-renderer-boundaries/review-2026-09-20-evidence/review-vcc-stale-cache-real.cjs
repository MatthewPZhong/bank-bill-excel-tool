const REVIEW_SOURCE_ROOT = process.env.REVIEW_SOURCE_ROOT || '/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/v3210-renderer-boundaries';
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createModalDom } = require(REVIEW_SOURCE_ROOT + '/tests/helpers/modal-dom');
const { createModalHost } = require(REVIEW_SOURCE_ROOT + '/src/renderer/modal-host');
const { createModalBridge } = require(REVIEW_SOURCE_ROOT + '/src/renderer/modal-bridge');
const { createPreFundController } = require(REVIEW_SOURCE_ROOT + '/src/renderer/controllers/pre-fund');
const { createBankBuController } = require(REVIEW_SOURCE_ROOT + '/src/renderer/controllers/bank-bu');
const { createDuplicateInboundController } = require(REVIEW_SOURCE_ROOT + '/src/renderer/controllers/duplicate-inbound');
const { createVccOpCalcController } = require(REVIEW_SOURCE_ROOT + '/src/renderer/controllers/vcc-op-calc');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const domains = [
  { key: 'preFund', factory: createPreFundController, prefix: 'preFundReconciliation', owner: 'pre-fund-reconciliation',
    statusMethod: 'sessionStatus', ready: { status: 'ok', canRun: true, canExport: true }, empty: { status: 'ok', canRun: false, canExport: false }, command: 'importBank', operation: 'importBank' },
  { key: 'bankBu', factory: createBankBuController, prefix: 'bankBuRecon', owner: 'bank-bu-recon',
    statusMethod: 'listReadyMonths', ready: ['2026-08'], empty: [], command: 'run', operation: 'listReadyMonths' },
  { key: 'duplicateInbound', factory: createDuplicateInboundController, prefix: 'duplicateInboundMatch', owner: 'duplicate-inbound-match',
    statusMethod: 'sessionStatus', ready: { status: 'ok', canRun: true, canExport: true }, empty: { status: 'ok', canRun: false, canExport: false }, command: 'import', operation: 'importFiles' },
  { key: 'vccOpCalc', factory: createVccOpCalcController, prefix: 'vccOpCalc', owner: 'vcc-op-calc',
    statusMethod: 'listBalanceMonths', ready: ['2026-08'], empty: [], command: 'import', operation: 'pickFiles' }
];

function harness(domain, overrides = {}) {
  const dom = createModalDom();
  const nodes = new Map();
  const calls = [];
  const views = [];
  const errors = [];
  const progress = new Map();
  let releases = 0;
  const panel = {
    querySelector(selector) {
      assert.ok(selector.startsWith('#' + domain.prefix), '只能查询本域 panel');
      if (!nodes.has(selector)) {
        const element = dom.document.createElement(selector.endsWith('Select') ? 'select' : 'button');
        element.value = 'withdraw';
        element.textContent = '';
        nodes.set(selector, element);
      }
      return nodes.get(selector);
    }
  };
  const api = {
    sessionStatus: async () => ({ status: 'ok', canRun: true, canExport: true }),
    listReadyMonths: async () => ['2026-08'],
    listSuccessMonths: async () => [{ yearMonth: '2026-08', runId: 1 }],
    listBalanceMonths: async () => ['2026-08'],
    importBank: async () => ({ status: 'cancelled' }),
    importMpt: async () => ({ status: 'cancelled' }),
    importFiles: async () => ({ status: 'cancelled' }),
    pickFiles: async () => ({ status: 'cancelled' }),
    pickPendingFile: async () => ({ status: 'success', filePath: '/test/pending.xlsx' }),
    pickBankFile: async () => ({ status: 'success', filePath: '/test/bank.xlsx' }),
    runImport: async () => ({ status: 'success', pendingCount: 20, bankCount: 30 }),
    run: async () => ({ status: 'success', stats: { matchedCount: 12, buDiffCount: 1, pendingUnmatched: 2, bankUnmatched: 3, nmAnomalyCount: 4 } }),
    pickSavePath: async () => ({ status: 'success', savePath: '/test/result.xlsx' }),
    exportSingle: async () => ({ status: 'success', filePath: '/test/result.xlsx' }),
    exportAggregate: async () => ({ status: 'success', filePath: '/test/result.xlsx', skippedMonths: ['2026-07'] }),
    export: async () => ({ status: 'success', filePath: '/test/result.xlsx' }),
    scan: async () => ({ status: 'success', yearMonth: '2026-08', totalRows: 30, fileCount: 1 }),
    computeAmounts: async () => ({ status: 'success', yearMonth: '2026-08', totals: { totalOut: '1.01', totalIn: '2.03', totalAmount: '1.02' } }),
    save: async () => ({ status: 'success', yearMonth: '2026-08', beginOp: '0.01', endOp: '1.03' }),
    getBalance: async ({ yearMonth }) => ({ yearMonth, endOp: '1.03' }),
    ...overrides
  };
  for (const [name, fn] of Object.entries(api)) api[name] = (...args) => { calls.push({ name, args }); return fn(...args); };
  for (const name of ['onImportProgress', 'onRunProgress', 'onExportProgress', 'onScanProgress']) {
    api[name] = (listener) => {
      progress.set(name, listener);
      return () => { releases += 1; progress.delete(name); };
    };
  }
  const host = createModalHost({ root: dom.root, document: dom.document });
  const bridge = createModalBridge({ host });
  const ui = {
    modalHost: host, modalBridge: bridge,
    status(element, text, tone) { element.textContent = text; element.tone = tone; },
    reportError: (error) => errors.push(error),
    escapeHtml: (text) => String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'),
    alert: (message) => dialog('alert', { message })
  };
  function dialog(name, options) {
    const view = dom.createDialog();
    view.name = name;
    view.options = options;
    view.busy = false;
    bridge.registerModal(view.overlay, { dialog: view.dialog, canClose: () => !view.busy });
    views.push(view);
    return view.overlay;
  }
  for (const name of [
    'createPreFundTempManagerDialog', 'createBankBuReconMonthPickerDialog', 'createBankBuReconFileImportPromptDialog',
    'createBankBuReconReconcileDialog', 'createBankBuReconExportDialog', 'createVccOpCalcConfirmDialog',
    'createVccOpCalcComputeDialog', 'createVccOpCalcShowBalanceDialog'
  ]) ui[name] = (options) => dialog(name, options);
  const controller = domain.factory({ api, panel, ui });
  return {
    controller, api, ui, dom, host, bridge, nodes, calls, views, errors, progress,
    get releases() { return releases; },
    node(suffix) { return nodes.get('#' + domain.prefix + suffix); },
    status() { return nodes.get('#' + domain.prefix + 'StatusBox').textContent; },
    snapshot() { return [...nodes.values()].map((node) => [node.disabled, node.textContent]); },
    async confirm(view, value, action = 'onConfirm') {
      // 月份/F1 这类工厂在开始业务回调前提交并关闭；F2 onCompute 保持当前视图。
      if (action === 'onConfirm') bridge.closeModal(view.overlay, { status: 'submitted', value });
      return await view.options[action](value);
    }
  };
}



const fs=require('node:fs'); const path=require('node:path'); const {DatabaseSync}=require('node:sqlite');
const source=REVIEW_SOURCE_ROOT + '/';
const ExcelJS=require(source+'node_modules/exceljs');
const {FLOW_HEADERS}=require(source+'src/backend/vcc-op-calc-db/columns');
const {createVccOpCalcSession}=require(source+'src/main-process/vcc-op-calc-session');
const {ensureVccOpCalcTablesSupport}=require(source+'src/backend/database/migrations');
(async()=>{
 const tmp=fs.mkdtempSync('/private/tmp/review-vcc-real-');
 const db=new DatabaseSync(':memory:');ensureVccOpCalcTablesSupport(db);
 const session=createVccOpCalcSession({getDb:()=>db});
 const files=[];
 for(const [name,month,amount] of [['A','2026-07','10.00'],['B','2026-08','900.00']]) {
   const wb=new ExcelJS.Workbook();const ws=wb.addWorksheet('Flow');ws.addRow(FLOW_HEADERS.slice());
   const row=new Array(FLOW_HEADERS.length).fill(''); row[1]=month+'-15';row[8]='入';row[13]=amount;row[14]='CNY';ws.addRow(row);
   const file=path.join(tmp,name+'.xlsx');await wb.xlsx.writeFile(file);files.push(file);
 }
 const secondScan=deferred();const releaseResponse=deferred();let picks=0;
 const h=harness(domains[3], {
   pickFiles:async()=>({status:'success',filePaths:[files[picks++]]}),
   scan:async({filePaths})=>{
     const res=await session.streamScanAndCompute(filePaths);assert.equal(res.ok,true);
     if(filePaths[0]===files[1]) {secondScan.resolve();await releaseResponse.promise;}
     return {status:'success',yearMonth:res.yearMonth,totalRows:res.totalRows,fileCount:filePaths.length};
   },
   computeAmounts:async()=>({status:'success',...session.getComputeCache()}),
   save:async({beginOp})=>({status:'success',...session.saveRun({beginOp,operationOwner:{
     taskRunId:'review-vcc-task',taskKey:'vccOpCalc:run:save',moduleId:'vcc-op-calc',parentRunId:'review-vcc-parent',operationKey:'review-vcc-operation'
   }})})
 });
 try {
   await h.controller.enter();await h.controller.commands.import();await h.confirm(h.views.at(-1));
   const background=h.controller.commands.import();await secondScan.promise;
   const leave=h.controller.leave();releaseResponse.resolve();await background;await h.controller.enter();
   await h.controller.commands.run();const f2=h.views.at(-1);
   const result={leave,runEnabled:!h.node('RunBtn').disabled,displayed:{yearMonth:f2.options.yearMonth,totals:f2.options.totals},mainCache:session.getComputeCache()};
   result.saveResult=await h.confirm(f2,'100.00','onCompute');
   result.storedRows=db.prepare('SELECT year_month,begin_op,total_amount,end_op FROM vcc_op_calc_runs').all();
   console.log(JSON.stringify(result,null,2));
 } finally {h.controller.dispose();db.close();fs.rmSync(tmp,{recursive:true,force:true});}
})();
