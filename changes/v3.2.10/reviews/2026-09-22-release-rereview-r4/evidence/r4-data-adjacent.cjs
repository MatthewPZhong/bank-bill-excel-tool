'use strict';
const fs=require('fs'),path=require('path'),os=require('os'),vm=require('vm');
const root='/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10';
const {scan}=require(path.join(root,'scripts/architecture/scan'));const {evaluateRules}=require(path.join(root,'scripts/architecture/rules'));
const config=require(path.join(root,'architecture/boundaries.json'));const baseline='1'.repeat(40);
function probe(name,source,boundaryId='renderer-statement'){
 const b=structuredClone(config.boundaries.find(b=>b.id===boundaryId));b.state='pending';
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'r4-data-fixture-'));fs.mkdirSync(path.join(dir,'src'));fs.writeFileSync(path.join(dir,'src/shell.js'),source);
 const cfg={schemaVersion:1,factBaseline:baseline,bootstrap:{factBaseline:baseline,mode:'first-introduction'},boundaries:[b],generatedModules:[],dynamicLoads:[],policyChanges:[]};
 const result=evaluateRules(scan(dir,cfg),cfg,{schemaVersion:1,factBaseline:baseline,exceptions:[]},{root:dir});
 let received; const desktopApi={outsideScope(){return true;}};const accept=input=>{received=input};
 const context={window:{desktopApi,StatementController:{createStatementController:accept},ReconIdFixController:{createReconIdFixController:accept}},require(name){if(name==='electron')return {ipcRenderer:{invoke(channel){return {channel}}}};throw new Error(name)}};
 let runtime;try{vm.runInNewContext(source,context);runtime={keys:Object.keys(received||{}),initialInherited:received?.initialInfo?.outsideScope?.(),protoOwn:Object.hasOwn(received?.initialInfo||{},'__proto__'),protoExtra:received?.initialInfo?.__proto__?.outsideScope?.(),categoryType:typeof received?.config?.initialBillCategory,categoryChannel:received?.config?.initialBillCategory?.channel};}catch(e){runtime={error:e.message}}
 const out={name,boundaryId,source,runtime,violations:result.violations};console.log(JSON.stringify(out));fs.rmSync(dir,{recursive:true,force:true});
}

probe('own_shorthand_api','const __proto__=window.desktopApi;window.StatementController.createStatementController({initialInfo:{__proto__}});');
probe('own_static_key_api','const key="__proto__";window.StatementController.createStatementController({initialInfo:{[key]:window.desktopApi}});');
probe('own_accessor_api','window.StatementController.createStatementController({initialInfo:{get ["__proto__"](){return window.desktopApi;}}});');
probe('own_other_key_api','window.StatementController.createStatementController({initialInfo:{constructor:window.desktopApi}});');
probe('pure_special_keys','window.StatementController.createStatementController({initialInfo:{["__proto__"]:{constructor:"bank"},toString:"text",hasOwnProperty:true}});');
probe('pure_null_proto_alias','const nil=null;window.StatementController.createStatementController({initialInfo:{__proto__:nil,name:"bank"}});');
probe('config_computed_key_callable','window.ReconIdFixController.createReconIdFixController({config:{["initialBillCategory"]:()=>window.desktopApi}});','renderer-recon-id-fix');
probe('config_nested_special_api','window.ReconIdFixController.createReconIdFixController({config:{initialBillCategory:{nested:{["__proto__"]:window.desktopApi}}}});','renderer-recon-id-fix');
probe('config_nested_wrong_ipc',"const {ipcRenderer}=require('electron');window.ReconIdFixController.createReconIdFixController({config:{initialBillCategory:{nested:ipcRenderer.invoke('other')}}});",'renderer-recon-id-fix');
probe('config_nested_valid_ipc',"const {ipcRenderer}=require('electron');window.ReconIdFixController.createReconIdFixController({config:{initialBillCategory:{nested:ipcRenderer.invoke('app:get-info').reconIdFixBillCategory}}});",'renderer-recon-id-fix');
