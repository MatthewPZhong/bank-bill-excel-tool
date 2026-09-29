'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),vm=require('node:vm');
const root=path.resolve(__dirname,'../../../../..');
const inspected=process.env.ARCHITECTURE_PROBE_ROOT||root;
const {scan}=require(path.join(inspected,'scripts/architecture/scan'));const {evaluateRules}=require(path.join(inspected,'scripts/architecture/rules'));
const sources=['scripts/architecture/scan.js','scripts/architecture/rules.js','scripts/architecture/contracts.js','scripts/architecture/renderer-contracts.js'].filter(file=>fs.existsSync(path.join(inspected,file)));
const hashes=()=>Object.fromEntries(sources.map(file=>[file,crypto.createHash('sha256').update(fs.readFileSync(path.join(inspected,file))).digest('hex')]));
const before=hashes(),baseline='1'.repeat(40);
function boundary(rule,extra={}){return {id:'probe',owner:'probe',governance:'G8',state:'pending',rules:[rule],entrypoints:[],allowedLocal:[],allowedExternal:[],requiredConsumers:[],activationEvidence:[],protectedScopes:[],restrictedApis:[],allowedSites:[],compositionEntrypoints:[],globals:[],factory:null,allowedApiFields:{},deprecatedEntrypoints:[],directory:null,...extra};}
function inspect(name,files,b){
 const fixture=fs.mkdtempSync(path.join(os.tmpdir(),'independent-renderer-'));
 try{
 for(const [file,text]of Object.entries(files)){fs.mkdirSync(path.dirname(path.join(fixture,file)),{recursive:true});fs.writeFileSync(path.join(fixture,file),text);}
 const config={schemaVersion:1,factBaseline:baseline,bootstrap:{factBaseline:baseline,mode:'first-introduction'},boundaries:[b],generatedModules:[],dynamicLoads:[],policyChanges:[]};
 const s=scan(fixture,config),r=evaluateRules(s,config,{schemaVersion:1,factBaseline:baseline,exceptions:[]},{root:fixture});
 return {name,files,violations:r.violations.map(v=>({rule:v.rule,from:v.from,line:v.line,message:v.message})),edges:s.edges};
 }finally{fs.rmSync(fixture,{recursive:true,force:true});}
}
const renderer=()=>boundary('ARCH-RENDERER-SCOPE',{entrypoints:['src/controller.js'],allowedLocal:['src/controller.js'],factory:{path:'src/controller.js',name:'createProbe',parameters:['api']},allowedApiFields:{api:['read']}});
const results=[];
for(const[name,source]of[
 ['full-spread','function provide(){return {...window.desktopApi};}createProbe({api:provide()});'],
 ['assign-returned-api','function provide(){const api={read:window.desktopApi.read};Object.assign(api,window.desktopApi);return api;}createProbe({api:provide()});'],
 ['define-property-returned-api',"function provide(){const api={read:window.desktopApi.read};Object.defineProperty(api,'outsideScope',{value:window.desktopApi.outsideScope});return api;}createProbe({api:provide()});"],
 ['umd-full','(function(root){root.Provider={provide(){return root.desktopApi;}};})(window);createProbe({api:Provider.provide()});'],
 ['umd-scoped','(function(root){root.Provider={provide(){return {read:root.desktopApi.read};}};})(window);createProbe({api:Provider.provide()});'],
 ['provider-late-write','window.Provider={provide(){return window.desktopApi;}};createProbe({api:Provider.provide()});window.Provider={provide(){return {read:window.desktopApi.read};}};']
]){
 const result=inspect(name,{'src/controller.js':'function createProbe({api}) {return api;}window.createProbe=createProbe;','src/app.js':source},renderer());
 const context={desktopApi:{read(){},outsideScope(){return true;}},received:null};context.window=context;context.createProbe=({api})=>context.received=api;
 vm.runInNewContext(source,context);
 result.runtime={wholeApi:context.received===context.desktopApi,wholeApiAsRead:context.received?.read===context.desktopApi,outsideScopeViaRead:context.received?.read===context.desktopApi?context.received.read.outsideScope():false,outsideScopeDirect:typeof context.received?.outsideScope==='function'?context.received.outsideScope():false};results.push(result);
}
console.log(JSON.stringify({before,after:hashes(),stable:JSON.stringify(before)===JSON.stringify(hashes()),results},null,2));
