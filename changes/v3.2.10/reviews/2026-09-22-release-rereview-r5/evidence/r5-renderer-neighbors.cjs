'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm');
const repo='/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10';
const root=process.env.RENDERER_SCANNER_ROOT||repo;
const {scan}=require(path.join(root,'scripts/architecture/scan'));
const {evaluateRules}=require(path.join(root,'scripts/architecture/rules'));
const actual=require(path.join(repo,'architecture/boundaries.json'));
const bank=actual.boundaries.find(b=>b.id==='renderer-bank-statement');
const cases=[
 ['shallow-copies-share-nested',false,'function provide(){return {api:{run(){}}};}const original=provide();const clean={...original};const other={...original};other.api.outsideScope=window.desktopApi.outsideScope;','clean.api','other.api'],
 ['shallow-copies-distinct-nested',true,'function provide(){return {api:{run(){}}};}const clean={...provide()};const other={...provide()};other.api.outsideScope=window.desktopApi.outsideScope;','clean.api','other.api'],
 ['closure-method-shared',false,'function make(){const api={run(){}};return {get(){return api;}};}const provider=make();const clean=provider.get();const other=provider.get();other.outsideScope=window.desktopApi.outsideScope;','clean','other'],
 ['closure-method-distinct',true,'function make(){const api={run(){}};return {get(){return api;}};}const clean=make().get();const other=make().get();other.outsideScope=window.desktopApi.outsideScope;','clean','other'],
 ['parameter-wrapping-shared',false,'const shared={run(){}};function wrap(api){return {api};}const clean=wrap(shared);const other=wrap(shared);other.api.outsideScope=window.desktopApi.outsideScope;','clean.api','other.api'],
 ['parameter-wrapping-distinct',true,'function wrap(api){return {api};}const clean=wrap({run(){}});const other=wrap({run(){}});other.api.outsideScope=window.desktopApi.outsideScope;','clean.api','other.api'],
 ['nested-member-replacement',false,'function provide(){return {api:{run(){}}};}const envelope=provide();const clean={run(){}};envelope.api=clean;const other=envelope.api;other.outsideScope=window.desktopApi.outsideScope;','envelope.api','clean'],
 ['nested-member-detached',true,'function provide(){return {api:{run(){}}};}const envelope=provide();const other=envelope.api;envelope.api={run(){}};other.outsideScope=window.desktopApi.outsideScope;','envelope.api','other']
];
for(const [name,safe,setup,api,other] of cases){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'r5-renderer-fixture-'));
 const source=setup+`window.BankStatementController.createBankStatementController({api:${api}});`;
 fs.mkdirSync(path.join(dir,'src'));fs.writeFileSync(path.join(dir,'src/shell.js'),source);
 const config={schemaVersion:1,factBaseline:'1'.repeat(40),bootstrap:{factBaseline:'1'.repeat(40),mode:'first-introduction'},boundaries:[{...bank,state:'pending'}],generatedModules:[],dynamicLoads:[],policyChanges:[]};
 let input;const window={desktopApi:{outsideScope(){return true;}},BankStatementController:{createBankStatementController(value){input=value;}}};
 const ctx=vm.createContext({window});vm.runInContext(source,ctx);
 const runtime={keys:Object.keys(input.api),extraCallable:typeof input.api.outsideScope==='function',extraResult:input.api.outsideScope?.(),same:vm.runInContext(`${api}===${other}`,ctx)};
 let result;try{result=evaluateRules(scan(dir,config),config,{schemaVersion:1,factBaseline:config.factBaseline,exceptions:[]},{root:dir});}catch(error){result={error:error.stack};}
 console.log(JSON.stringify({name,safe,source,runtime,violations:result.violations,error:result.error}));
 fs.rmSync(dir,{recursive:true,force:true});
}
