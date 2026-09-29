'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm');
const root=process.env.RENDERER_SCANNER_ROOT||'/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10';
const {scan}=require(path.join(root,'scripts/architecture/scan'));
const {evaluateRules}=require(path.join(root,'scripts/architecture/rules'));
const baseline='1'.repeat(40);
function check(name,source,{fields={},params=['api','ui','panel'],preload=null}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'renderer-rereview-'));
 const b={id:'renderer-fixture',governance:'G8',owner:'fixture',state:'pending',rules:['ARCH-RENDERER-SCOPE'],entrypoints:['src/controller.js'],allowedLocal:[],allowedExternal:[],requiredConsumers:[],activationEvidence:[],protectedScopes:[],restrictedApis:[],allowedSites:[],compositionEntrypoints:[],globals:[],factory:{path:'src/controller.js',name:'createController',parameters:params},allowedApiFields:{api:['read'],ui:['confirm'],...fields},deprecatedEntrypoints:[],directory:null};
 const files={'src/controller.js':'window.createController = function createController({api, ui, panel}) { return {enter(){return api.read();}}; };','src/shell.js':source,...(preload?{'src/preload.js':preload}:{})};
 for(const [f,text] of Object.entries(files)){fs.mkdirSync(path.dirname(path.join(dir,f)),{recursive:true});fs.writeFileSync(path.join(dir,f),text)}
 const config={schemaVersion:1,factBaseline:baseline,bootstrap:{factBaseline:baseline,mode:'first-introduction'},boundaries:[b],generatedModules:[],dynamicLoads:[],policyChanges:[]};
 let received;const desktopApi={read(){return 'own';},outsideScope(){return 'outside';}};const ctx={desktopApi,createController(input){received=input;},document:{getElementById(id){return {id}}}};ctx.window=ctx;ctx.globalThis=ctx;
 let runtime;try{vm.runInNewContext(source,ctx);runtime={keys:Object.keys(received||{}),apiKeys:Object.keys(received?.api||{}),uiKeys:Object.keys(received?.ui||{}),whole:received?.api===desktopApi||received?.initialInfo?.api===desktopApi,aliasReach:!!received?.api?.outsideScope}}catch(e){runtime={error:e.message}}
 const result=evaluateRules(scan(dir,config),config,{schemaVersion:1,factBaseline:baseline,exceptions:[]},{root:dir});
 const out={name,source,runtime,violations:result.violations};console.log(JSON.stringify(out));fs.rmSync(dir,{recursive:true,force:true});return out;
}


check('bound-factory-alias','function provide(){return {read(){}};}const factory=provide.bind(null);const api=factory();const alias=api;alias.outsideScope=window.desktopApi.outsideScope;window.createController({api});');
check('bound-factory-escape','function provide(){return {read(){}};}const factory=provide.bind(null);const api=factory();Object.assign(api,window.desktopApi);window.createController({api});');
check('factory-nested-alias','function provide(){return {api:{read(){}}};}const envelope=provide();const alias=envelope.api;alias.outsideScope=window.desktopApi.outsideScope;window.createController({api:envelope.api});');
check('factory-nested-escape','function provide(){return {api:{read(){}}};}const envelope=provide();Object.assign(envelope.api,window.desktopApi);window.createController({api:envelope.api});');
check('safe-bound-factory','function provide(){return {read(){}};}const factory=provide.bind(null);const api=factory();window.createController({api});');
check('safe-factory-nested','function provide(){return {api:{read(){}}};}const envelope=provide();window.createController({api:envelope.api});');
