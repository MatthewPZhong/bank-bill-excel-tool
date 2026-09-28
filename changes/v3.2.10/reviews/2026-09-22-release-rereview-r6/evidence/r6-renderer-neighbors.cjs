'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm');
const repo='/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10';
const root=process.env.RENDERER_SCANNER_ROOT||repo;
const {scan}=require(path.join(root,'scripts/architecture/scan'));
const {evaluateRules}=require(path.join(root,'scripts/architecture/rules'));
const actual=require(path.join(repo,'architecture/boundaries.json'));
const bank=actual.boundaries.find(b=>b.id==='renderer-bank-statement');
const cases=[["destructured-parameter-after", false, "function provide(){return {api:{run(){}}};}const envelope=provide();function select({api}){return api;}envelope.api={run(){}};const alias=select(envelope);alias.outsideScope=window.desktopApi.outsideScope;", "envelope.api", "alias"], ["destructured-parameter-before", true, "function provide(){return {api:{run(){}}};}const envelope=provide();function select({api}){return api;}const alias=select(envelope);envelope.api={run(){}};alias.outsideScope=window.desktopApi.outsideScope;", "envelope.api", "alias"], ["explicit-parameter-after", false, "function provide(){return {api:{run(){}}};}const envelope=provide();function select(value){return value.api;}envelope.api={run(){}};const alias=select(envelope);alias.outsideScope=window.desktopApi.outsideScope;", "envelope.api", "alias"], ["explicit-parameter-before", true, "function provide(){return {api:{run(){}}};}const envelope=provide();function select(value){return value.api;}const alias=select(envelope);envelope.api={run(){}};alias.outsideScope=window.desktopApi.outsideScope;", "envelope.api", "alias"], ["shared-replacement", false, "function provide(){return {api:{run(){}}};}const envelope=provide();const other=provide();const shared={run(){}};envelope.api=shared;other.api=shared;other.api.outsideScope=window.desktopApi.outsideScope;", "envelope.api", "other.api"], ["distinct-replacement", true, "function provide(){return {api:{run(){}}};}const envelope=provide();const other=provide();envelope.api={run(){}};other.api={run(){}};other.api.outsideScope=window.desktopApi.outsideScope;", "envelope.api", "other.api"], ["helper-replacement-after", false, "function provide(){return {api:{run(){}}};}const envelope=provide();function replace(){envelope.api={run(){}};}replace();const alias=envelope.api;alias.outsideScope=window.desktopApi.outsideScope;", "envelope.api", "alias"], ["helper-replacement-before", true, "function provide(){return {api:{run(){}}};}const envelope=provide();function replace(){envelope.api={run(){}};}const alias=envelope.api;replace();alias.outsideScope=window.desktopApi.outsideScope;", "envelope.api", "alias"]];
for(const [name,safe,setup,api,other] of cases){
 const dir=fs.mkdtempSync(path.join('/tmp','r6-renderer-fixture-'));
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
