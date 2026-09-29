'use strict';
const assert = require('node:assert/strict');
const root = '/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10';
const { createModalDom } = require(root + '/tests/helpers/modal-dom');
const { createModalHost } = require(root + '/src/renderer/modal-host');
const { createBankStatementController } = require(root + '/src/renderer/controllers/bank-statement');

async function check(kind, choice) {
  const dom = createModalDom();
  const errors = [], confirms = [], calls = [];
  const host = createModalHost({ ...dom, reportError: e => errors.push(e.code) });
  const controls = new Map();
  const panel = { querySelector(id) { if (!controls.has(id)) controls.set(id, { textContent: '', dataset: {}, disabled: false, addEventListener(){}, removeEventListener(){} }); return controls.get(id); } };
  const scenarios = kind === 'refund' ? [{ id:1, name:'中台退款订单回填', category:'builtin-fixed', enabled:true }]
    : kind === 'c3' ? [{id:1,category:'gateway-recon-join',enabled:true}]
    : [{id:1,category:'gateway-recon-id-fix',enabled:true},{id:2,category:'gateway-recon-id-fix',enabled:true}];
  const controller = createBankStatementController({
    panel,
    api: {
      sessionStatus: async () => ({status:'ok',hasBankStatement:true,hasRefundOrder:false,bankStatementFileName:'test.xlsx'}),
      refundCandidateCount: async () => ({status:'ok',candidateCount:1}),
      c3CandidateCount: async () => ({status:'ok',candidateCount:1}),
      batchImport: async () => { calls.push('batchImport'); return {status:'cancelled'}; },
      run: async () => { calls.push('bankRun'); return {status:'ok'}; }
    },
    config: {scenarios:{list:async()=>({status:'ok',scenarios})},linkedTable:{rowCount:async()=>({status:'ok',rowCount:0}), import:async()=>{calls.push('linkedImport');return {status:'ok',results:[]};}}},
    sharedReconSession:{sessionStatus:async()=>({status:'ok',hasFile:true}),subscribe:()=>()=>{},run:async()=>{calls.push('gatewayRun');return {status:'ok'};}},
    ui:{modalHost:host,confirm(options){confirms.push(options);return dom.createDialog();},gatewayScenarioPicker(options){confirms.push(options);return dom.createDialog();},alert(){return dom.createDialog();},reportError(e){errors.push(e.code || e.message);}}
  });
  await controller.enter();
  if (kind === 'gateway') controller.commands.selectRunMode('gateway');
  await controller.commands.run();
  assert.equal(confirms.length,1,'actual controller must open the requested dialog');
  let error;
  try { await confirms[0][choice](1); } catch(e) { error = {code:e.code,message:e.message}; }
  assert.equal(error?.code,'MODAL_OUTCOME_INVALID');
  assert.deepEqual(calls,[]);
  assert.equal(host.getTop().isOpen(),true);
  const result = {kind,choice,error,calls,modalStillOpen:host.getTop().isOpen()};
  host.closeTop();controller.dispose();host.dispose();
  return result;
}
(async()=>{
  const results=[];
  for(const [kind,choice] of [['refund','onConfirm'],['refund','onMiddle'],['c3','onConfirm'],['c3','onMiddle'],['gateway','onPick']]) results.push(await check(kind,choice));
  console.log(JSON.stringify({sourceHead:'9a38b96b1b8006c5851535d0c1e586bbaeb63f10',results},null,2));
})().catch(error=>{console.error(error);process.exitCode=1;});
