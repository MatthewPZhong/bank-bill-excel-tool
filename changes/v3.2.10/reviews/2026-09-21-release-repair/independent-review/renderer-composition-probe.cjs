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
 ['full-direct','createProbe({api:window.desktopApi});'],
 ['full-helper','function forward(api){return api;}createProbe({api:forward(window.desktopApi)});'],
 ['full-helper-nested','function wrap(api){return {nested:api};}createProbe({api:wrap(window.desktopApi).nested});'],
 ['full-helper-return-member','function wrap(api){return {read:api};}createProbe({api:wrap(window.desktopApi)});'],
 ['full-helper-argument','function mount(api){createProbe({api});}mount(window.desktopApi);'],
 ['full-as-method-argument','function mount(read){createProbe({api:{read}});}mount(window.desktopApi);'],
 ['full-through-static-namespace','window.Helpers={forward(api){return api;}};createProbe({api:Helpers.forward(window.desktopApi)});'],
 ['full-through-wrapper-parameter','function forward(api){return {read:api};}function mount(api){createProbe({api:forward(api)});}mount(window.desktopApi);'],
 ['scoped-helper','function forward(api){return {read:api.read};}createProbe({api:forward(window.desktopApi)});']
]){
 const result=inspect(name,{'src/controller.js':'function createProbe({api}) {return api;}window.createProbe=createProbe;','src/app.js':source},renderer());
 const context={desktopApi:{read(){},outsideScope(){return true;}},received:null};context.window=context;context.createProbe=({api})=>context.received=api;
 vm.runInNewContext(source,context);
 result.runtime={wholeApi:context.received===context.desktopApi,wholeApiAsRead:context.received?.read===context.desktopApi,outsideScopeViaRead:context.received?.read===context.desktopApi?context.received.read.outsideScope():false};results.push(result);
}
const composition=()=>boundary('ARCH-DESCRIPTOR-COMPOSITION',{compositionEntrypoints:[{path:'src/composition.js',allowedTargets:['src/main-process/position/task-adapter.js'],importedNames:['createAdapter']}]});
for(const[name,source]of[
 ['namespace-static',"const mod=require('./main-process/position/task-adapter');const adapter=mod.createAdapter();"],
 ['namespace-forward',"const mod=require('./main-process/position/task-adapter');function forward(value){return value;}forward(mod).createAdapter();"],
 ['namespace-object-forward',"const mod=require('./main-process/position/task-adapter');function forward(value){return value.value;}forward({value:mod}).createAdapter();"],
 ['namespace-dynamic',"const mod=require('./main-process/position/task-adapter');const name=process.env.METHOD;mod[name]();"],
 ['namespace-extra-member',"const mod=require('./main-process/position/task-adapter');mod.createAdapter();mod.forbidden();"]
])results.push(inspect(name,{'src/composition.js':source,'src/main-process/position/task-adapter.js':'exports.createAdapter=()=>({});exports.forbidden=()=>({});'},composition()));
console.log(JSON.stringify({before,after:hashes(),stable:JSON.stringify(before)===JSON.stringify(hashes()),results},null,2));
