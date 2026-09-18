'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const root='/private/tmp/toolbox-rows-review-r3-f8ouloqk';
const req=(p)=>require(path.join(root,p));
const { sourceSnapshotFromStat }=req('src/main-process/archive-center/source-snapshot');
const { assertFilePlanFresh }=req('src/main-process/archive-center/file-plan');
const { prepareIpcTaskInvocation }=req('src/main-process/archive-center/ipc-task-contract');
const { prepareRows,generateValidateAndPublishRows }=req('src/main-process/toolbox-row-split/service');
const {executeRowsGeneration}=req('src/main-process/toolbox-row-split/executor');
const {publishToolboxPublicationAsync}=req('src/main-process/toolbox-output-publication-dispatch');
const {randomUUID}=require('node:crypto');
const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'rows-parent-identity-')));
const source=path.join(dir,'source.csv');fs.writeFileSync(source,'A\n1\n2\n');
const output=path.join(dir,'chosen');fs.mkdirSync(output);
const moved=path.join(dir,'chosen-moved');
const userDataDir=path.join(dir,'user-data');fs.mkdirSync(userDataDir);
const readContext={sourceFilePath:source,dataRowCount:2,snapshot:sourceSnapshotFromStat(fs.statSync(source))};
const payload={sourceFilePath:source,splitReadToken:'t',mode:'rows',rowsPerFile:1};
const main=fs.readFileSync(path.join(root,'src/main.js'),'utf8');
const start=main.indexOf("trackedIpcHandle('toolbox:split:export'");
const end=main.indexOf('\n}\n\n// v2.0.0-beta.4',start);
const publishStart=main.indexOf('async function publishToolboxArtifacts(');
const publishEnd=main.indexOf('\nasync function acknowledgeToolboxPublicationReceipts',publishStart);
let contract;
const batchContext={batchId:1,batchNumber:'ROWS-PARENT',taskRunId:'rows-parent-run',taskKey:'toolbox:split:export',moduleId:'toolbox',parentRunId:'rows-parent',operationKey:'rows-operation'};
const scope={fs,path,randomUUID,trackedIpcHandle:(_a,_b,_c,x)=>{contract=x;},
requireToolboxSplitReadContext:()=>readContext,prepareToolboxRows:prepareRows,
app:{getPath:()=>userDataDir},mainWindow:null,showImportOpenDialog:async()=>({canceled:false,filePaths:[output]}),
dialog:{showMessageBox:async()=>({response:1})},
assertToolboxTargetsDoNotAliasSources:()=>{},toolboxFailureResult:(e)=>({status:'failed',code:e.code,message:e.message}),
generateValidateAndPublishRows,publishToolboxPublicationAsync,
backgroundExecutionRuntimeManager:{get:()=>({execute:async request=>({outcome:'completed',terminalSource:'job:done',result:await executeRowsGeneration(request.input)})})},
clearToolboxSplitReadContext:()=>{},appendActivityLogEntry:()=>{},buildToolboxAuditDetailLines:()=>[],
toolboxFinalOutputFiles:files=>files,toolboxRowsPublicResult:(_counts,files)=>({status:'success',files}),
shouldPreserveToolboxTemporaryFiles:()=>true,cleanupToolboxTemporaryDirectory:()=>{},
assertToolboxSplitSourceFresh:()=>{}};
Function(...Object.keys(scope),main.slice(publishStart,publishEnd)+'\n'+main.slice(start,end))(...Object.values(scope));
(async()=>{
const prepared=await prepareIpcTaskInvocation(contract,{},[payload]);assert.equal(prepared.proceed,true);
const plan=prepared.filePlan;assertFilePlanFresh(plan);
const before=plan.outputs[0].targetParentIdentity;
// Represents an external rename/recreate while TaskLifecycle awaits startFileTask after freshness check.
fs.renameSync(output,moved);fs.mkdirSync(output);
assert.throws(()=>assertFilePlanFresh(plan),{code:'ARCHIVE_TARGET_PARENT_CHANGED'});
const result=await contract.execute({},prepared,{batchContext,fileEvidence:{filePlan:plan,inputFiles:plan.inputs,targetSnapshots:plan.outputs.map(x=>x.targetSnapshot)},settleArtifacts:async()=>({durable:true})});
console.log(JSON.stringify({status:result.status,code:result.code,message:result.message,expectedParentInode:before.inode,actualParentInode:String(fs.statSync(output,{bigint:true}).ino),files:result.files?.map(x=>({filePath:x.filePath,exists:fs.existsSync(x.filePath)})),movedDirectoryFiles:fs.readdirSync(moved),fixture:dir},null,2));
})().catch(e=>{console.error(e);process.exitCode=1;});
