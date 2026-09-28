'use strict';
const assert = require('node:assert/strict');
const root = '/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10';
const { createModalDom } = require(root + '/tests/helpers/modal-dom');
const { createModalHost } = require(root + '/src/renderer/modal-host');
const { createBankStatementController } = require(root + '/src/renderer/controllers/bank-statement');

async function check(kind, choice, expected) {
  const dom = createModalDom();
  const errors = [], confirms = [], calls = [];
  let canClose = true;
  const host = createModalHost({ ...dom, reportError: e => errors.push(e.code || e.message) });
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
    sharedReconSession:{sessionStatus:async()=>({status:'ok',hasFile:true}),subscribe:()=>()=>{},run:async(payload)=>{calls.push('gatewayRun:' + payload.scenarioId);return {status:'ok'};}},
    ui:{modalHost:host,confirm(options){confirms.push(options);return dom.createDialog({canClose:()=>canClose});},gatewayScenarioPicker(options){confirms.push(options);return dom.createDialog({canClose:()=>canClose});},alert(){return dom.createDialog();},reportError(e){errors.push(e.code || e.message);}}
  });
  await controller.enter();
  if (kind === 'gateway') controller.commands.selectRunMode('gateway');
  await controller.commands.run();
  const original = host.getTop();
  const callback = confirms[0][choice];
  assert.equal(original.isTop(),true);
  canClose=false;
  await callback(2);
  assert.deepEqual(calls,[]);
  assert.equal(original.isTop(),true);
  canClose=true;
  const child = host.push(original,()=>dom.createDialog()).handle;
  assert.equal(original.isOpen(),true);
  assert.equal(original.isTop(),false);
  await callback(2);
  assert.deepEqual(calls,[],'mounted non-top parent must not close child or perform business');
  assert.equal(child.isTop(),true);
  child.close();
  await callback(2);
  assert.equal(original.isOpen(),false);
  assert.deepEqual(await original.closed,{status:'submitted',value:kind==='gateway'?2:undefined});
  assert.deepEqual(calls,[expected]);
  await callback(2);
  assert.deepEqual(calls,[expected],'same callback after submission must not duplicate operation');
  await controller.commands.run();
  const next = host.getTop();
  await callback(2);
  assert.equal(next.isTop(),true,'old submitted callback must not close replacement');
  assert.deepEqual(calls,[expected]);
  controller.leave();
  await controller.enter();
  await confirms.at(-1)[choice](2);
  assert.deepEqual(calls,[expected],'navigation must invalidate preceding callback');
  assert.deepEqual(errors,[]);
  controller.dispose();host.dispose();
  return {kind,choice,passed:['blocked-close','mounted-non-top','submitted-once','repeat','new-window-preserved','navigation-stale'],calls};
}
(async()=>{
  const results=[];
  for(const [kind,choice,expected] of [['refund','onConfirm','batchImport'],['refund','onMiddle','bankRun'],['c3','onConfirm','linkedImport'],['c3','onMiddle','bankRun'],['gateway','onPick','gatewayRun:2']]) results.push(await check(kind,choice,expected));
  console.log(JSON.stringify({head:'9a38b96b1b8006c5851535d0c1e586bbaeb63f10',candidate:'current uncommitted repair',results},null,2));
})().catch(error=>{console.error(error);process.exitCode=1;});
