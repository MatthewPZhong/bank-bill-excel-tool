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
check('alias-member-write','const api={read(){}};const alias=api;alias.outsideScope=window.desktopApi.outsideScope;window.createController({api});');
check('alias-object-assign','const api={read(){}};const alias=api;Object.assign(alias,window.desktopApi);window.createController({api});');
check('nested-data-api','window.createController({initialInfo:{api:window.desktopApi}});',{params:['api','ui','panel','initialInfo']});
check('factory-call','window.createController.call(null,{api:window.desktopApi});');
check('factory-apply','window.createController.apply(null,[{api:window.desktopApi}]);');
check('factory-bind','const mount=window.createController.bind(null);mount({api:window.desktopApi});');
check('mutation-after-spread','const original={read(){}};const alias=original;alias.outsideScope=window.desktopApi.outsideScope;window.createController({api:{...original}});');
check('same-field-cross-namespace','window.createController({api:{read:window.desktopApi.other.read}});',{preload:"const {contextBridge}=require('electron');contextBridge.exposeInMainWorld('desktopApi',{own:{read(){}},other:{read(){}}});"});
check('logical-left-object','window.createController({api:window.desktopApi&&{read(){}}});');
check('factory-default-param','function mount(api=window.desktopApi){window.createController({api});}mount();');
check('nested-mutation','const envelope={api:{read(){}}};envelope.api.outsideScope=window.desktopApi.outsideScope;window.createController(envelope);');
check('nested-object-assign','const envelope={api:{read(){}}};Object.assign(envelope.api,window.desktopApi);window.createController(envelope);');
check('alias-stale-reassign','const api={read(){}};api.outsideScope=window.desktopApi.outsideScope;const alias=api;window.createController({api:alias});');

check('factory-alias-member-write','function provide(){const api={read(){}};const alias=api;alias.outsideScope=window.desktopApi.outsideScope;return api;}window.createController({api:provide()});');
check('factory-alias-object-assign','function provide(){const api={read(){}};const alias=api;Object.assign(alias,window.desktopApi);return api;}window.createController({api:provide()});');
check('provider-global-alias-member-write','window.Service={provide(){const api={read(){}};const alias=api;alias.outsideScope=window.desktopApi.outsideScope;return api;}};window.createController({api:window.Service.provide()});');
check('bound-factory-prebound','function provide(api){return api;}const bound=provide.bind(null,window.desktopApi);window.createController({api:bound({read(){}})});');
check('later-safe-member-write','const api={read:window.desktopApi};window.createController({api});api.read=()=>true;');
check('factory-later-safe-member-write','function provide(){const api={read:window.desktopApi};window.createController({api});api.read=()=>true;}provide();');
