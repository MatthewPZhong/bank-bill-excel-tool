'use strict';
const assert=require('node:assert/strict');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const Module=require('node:module');
const snapshot='/private/tmp/execution-descriptors-review-20260921';
const original='/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/v3210-execution-descriptors';
const baseSource=execFileSync('git',['show','8b12a6d5fd71b70ade58b9b6e7a347e29dbe8d05:src/main-process/archive-center/task-policy-registry.js'],{cwd:original,encoding:'utf8'});
const filename=path.join(snapshot,'src/main-process/archive-center/baseline-task-policy-registry.js');
const baseline=new Module(filename);baseline.filename=filename;baseline.paths=Module._nodeModulePaths(path.dirname(filename));baseline._compile(baseSource,filename);
const before=baseline.exports.createTaskPolicyRegistry();
const after=require(path.join(snapshot,'src/main-process/execution-descriptors/composition')).createTaskPolicyRegistry();
const statuses=['','ok','ready','success','warning','completed_with_errors','cancelled','canceled','ambiguous','busy','conflict','disabled','empty','error','failed','invalid','manual-balance-invalid','not-active','not-cancellable','overwrite-required','partial','read-error','rejected','stopping','unrecognized','unsupported','write-error','needs-confirmation','manual-balance-required','blocked','calculated','initialized','all_skipped','archived','recovery-required','invented-status'];
const results=[undefined,null,{},...statuses.map(status=>({status})), {status:'ok',runId:42,mirrorId:'mirror',operationToken:'op',ranAt:'date',targetMonth:'2026-09',resultRevision:4,batchId:'b1',recordId:'r1',records:[{recordId:'r1'},{recordId:'r2'}],auditId:'a',deletionId:'d',deletedRunCount:1,deletedDataCount:8,adjustment:{id:'adj'},initializedSubjects:['s1','s2'],filePaths:['1','2'],filePath:'1',monthKey:'2026-09',source:'side'}, {runId:'  42 ',monthKey:'2026-09',source:'main'}, {mirrorId:8}, {operationToken:'op'}, {ranAt:'d'}];
const invocations=[{}, {args:['42']},{args:[42]},{args:[{runId:42}]},{args:[{recordId:'r1'}]}, {prepared:{runId:42}}, {prepared:{targetType:'result',runIds:['42']}}, {prepared:{targetType:'result',runIds:['42','43']}}, {args:[{monthKey:'2026-09'}]}, {prepared:{monthKey:'2026-09'}}, {args:[{monthKey:'2026-08'}],prepared:{monthKey:'2026-09'}}, {args:[{monthKey:'2026-09'}],prepared:{resumePlan:{monthKey:'2026-09',runId:42,source:'side'}}}, {prepared:{resumePlan:{monthKey:'2026-09',runId:42,source:'main'}}}, {prepared:{exportPlan:{source:'side',monthKey:'2026-09',runId:42,flowIdentity:{type:'business-run-id',value:'acquiring-run:side:2026-09:42'}}}}, {prepared:{exportPlan:{source:'side',monthKey:'2026-09',runId:42,flowIdentity:{type:'business-run-id',value:'acquiring-task:task42'}}}}, {prepared:{inspected:{processingResult:{archiveFlowIdentity:{type:'business-run-id',value:'bank-statement-run:42'}}}}}, {resolveFlowEvidence:async()=>({identity:{type:'bank-bu-import-bundle',value:'bundle42'},hasRun:false})}, {resolveFlowEvidence:async()=>({identity:{type:'bank-bu-import-bundle',value:'bundle42'},hasRun:true})}];
let comparisons=0;
async function run(fn,args){try{return {value:await fn(...args)}}catch(e){return {error:{name:e.name,message:e.message,code:e.code}}}}
(async()=>{
assert.deepEqual(after.channels(),before.channels());
for(const oldPolicy of before.list()){
 const newPolicy=after.require(oldPolicy.channel);
 assert.deepEqual(Object.keys(newPolicy).sort(),Object.keys(oldPolicy).sort(),oldPolicy.channel);
 for(const key of Object.keys(oldPolicy)){
  const lhs=oldPolicy[key],rhs=newPolicy[key];
  if(typeof lhs!=='function'){assert.deepEqual(rhs,lhs,`${oldPolicy.channel}.${key}`);comparisons++;continue;}
  assert.equal(typeof rhs,'function',`${oldPolicy.channel}.${key}`);
  let args=[];
  if(['resultClassifier','resultMetadataResolver'].includes(key))args=results.map(r=>[r]);
  else if(['flowIdentityResolver','flowPlanResolver'].includes(key))args=invocations.map(i=>[i]);
  else if(key==='resultFlowIdentities')args=results.flatMap(r=>invocations.flatMap(i=>[{}, {taskRunId:'t42'}].map(c=>[r,c,i])));
  else args=[[{}],[{prepared:{filePlan:{marker:'plan'},filePlanResolver:()=>({marker:'resolved'})}}]];
  for(const input of args){assert.deepEqual(await run(rhs,input),await run(lhs,input),`${oldPolicy.channel}.${key} ${JSON.stringify(input)}`);comparisons++;}
 }
}
console.log(JSON.stringify({policyCount:before.list().length,recoverablePolicyCount:before.list().filter(p=>p.batchPolicy!=='exclude').length,comparisons,result:'PASS'},null,2));
})().catch(e=>{console.error(e);process.exitCode=1});
