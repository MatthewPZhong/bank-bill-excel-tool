'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm');
const repo='/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10';
const root=process.env.RENDERER_SCANNER_ROOT||repo;
const {scan}=require(path.join(root,'scripts/architecture/scan'));
const {evaluateRules}=require(path.join(root,'scripts/architecture/rules'));
const actual=require(path.join(repo,'architecture/boundaries.json'));
const bank=actual.boundaries.find(b=>b.id==='renderer-bank-statement');
const cases=[["default-missing-member", false, "const shared={run(){}};function select({api=shared}){return api;}const alias=select({});alias.outsideScope=window.desktopApi.outsideScope;", "shared", "alias"], ["default-undefined-member", false, "const shared={run(){}};function select({api=shared}){return api;}const alias=select({api:undefined});alias.outsideScope=window.desktopApi.outsideScope;", "shared", "alias"], ["default-provided-other", true, "const shared={run(){}};function select({api=shared}){return api;}const provided={run(){}};const alias=select({api:provided});alias.outsideScope=window.desktopApi.outsideScope;", "shared", "alias"], ["default-missing-parameter", false, "const shared={run(){}};function select(api=shared){return api;}const alias=select();alias.outsideScope=window.desktopApi.outsideScope;", "shared", "alias"], ["bound-captured-member", true, "function provide(){return {api:{run(){}}};}const envelope=provide();function select({api}){return api;}const bound=select.bind(null,{api:envelope.api});envelope.api={run(){}};const alias=bound();alias.outsideScope=window.desktopApi.outsideScope;", "envelope.api", "alias"], ["bound-live-container", false, "function provide(){return {api:{run(){}}};}const envelope=provide();function select({api}){return api;}const bound=select.bind(null,envelope);envelope.api={run(){}};const alias=bound();alias.outsideScope=window.desktopApi.outsideScope;", "envelope.api", "alias"], ["array-replaced-element", false, "function provide(){return {api:{run(){}}};}const envelope=provide();function select([{api}]){return api;}const list=[envelope];const clean=provide();list[0]=clean;const alias=select(list);alias.outsideScope=window.desktopApi.outsideScope;", "clean.api", "alias"], ["array-captured-before", true, "function provide(){return {api:{run(){}}};}const envelope=provide();function select([{api}]){return api;}const list=[envelope];const clean=provide();const alias=select(list);list[0]=clean;alias.outsideScope=window.desktopApi.outsideScope;", "clean.api", "alias"]];
for(const [name,safe,setup,api,other] of cases){
 const dir=fs.mkdtempSync(path.join('/tmp','r7-renderer-fixture-'));
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
