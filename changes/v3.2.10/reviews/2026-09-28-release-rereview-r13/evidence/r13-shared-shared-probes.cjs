'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm'),crypto=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');
const repo=process.cwd(), old=fs.mkdtempSync('/tmp/r13-shared-before-');
const archive=path.join(repo,'changes/v3.2.10/reviews/2026-09-23-release-r12-repair');
const manifest=JSON.parse(fs.readFileSync(path.join(archive,'input-manifest.json'))), actual=require(path.join(repo,'architecture/boundaries.json'));
const hashes=[];
for(const name of ['scan','contracts','rules','renderer-contracts','schema']){
 const p='scripts/architecture/'+name+'.js', src=['scan','contracts','schema','rules'].includes(name)?path.join(repo,p):path.join(archive,'before',p);
 const value=fs.readFileSync(src); const sha=crypto.createHash('sha256').update(value).digest('hex');
 if(sha!==manifest.sha256[p]) throw new Error('before mismatch '+p);
 const target=path.join(old,p);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,value);hashes.push({path:p,sha256:sha,match:true});
}
fs.symlinkSync(path.join(repo,'node_modules'),path.join(old,'node_modules'),'dir');
const versions=[['beforeR12',old],['current',repo]].map(([name,p])=>({name,scan:require(path.join(p,'scripts/architecture/scan')).scan,evaluate:require(path.join(p,'scripts/architecture/rules')).evaluateRules}));
function evaluate(files,id){
 const root=fs.mkdtempSync('/tmp/r13-shared-fixture-');
 try{
 for(const [p,s]of Object.entries(files)){const target=path.join(root,p);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,s);}
 const cfg={schemaVersion:1,factBaseline:'1'.repeat(40),bootstrap:{factBaseline:'1'.repeat(40),mode:'first-introduction'},boundaries:[{...structuredClone(actual.boundaries.find(b=>b.id===id)),state:'pending'}],generatedModules:[],dynamicLoads:[],policyChanges:[]};
 const out={scanner:{}};for(const v of versions){
 const scanned=v.scan(root,cfg),serialized=JSON.stringify(scanned),digest=x=>crypto.createHash('sha256').update(x).digest('hex');
 const repeated=JSON.stringify(v.scan(root,cfg));
 out[v.name]=v.evaluate(scanned,cfg,{schemaVersion:1,factBaseline:cfg.factBaseline,exceptions:[]},{root}).violations;
 out.scanner[v.name]={digest:digest(serialized),repeatEqual:repeated===serialized,afterRulesEqual:JSON.stringify(scanned)===serialized,siteEvidenceIds:scanned.sites.map(s=>s.evidenceId)};
 }out.scanner.beforeCurrentEqual=out.scanner.beforeR12.digest===out.scanner.current.digest;
 return out;
 }finally{fs.rmSync(root,{recursive:true,force:true});}
}
const stmt=x=>`window.StatementController.createStatementController({initialInfo:${x}});`;
const recon=x=>`window.ReconIdFixController.createReconIdFixController({config:{initialBillCategory:${x}}});`;
const renderer=[
 ['return-data',true,'function provide(value){return {nested:value};}'+stmt('provide("bank")')],
 ['return-api',false,'function provide(value){return {nested:value};}'+stmt('provide(window.desktopApi)')],
 ['bound-return-data',true,'function provide(value){return {nested:value};}const fn=provide.bind(null,"bank");'+stmt('fn()')],
 ['bound-return-api',false,'function provide(value){return {nested:value};}const fn=provide.bind(null,window.desktopApi);'+stmt('fn()')],
 ['closure-data',true,'function outer(value){return ()=>({nested:value});}'+stmt('outer("bank")()')],
 ['closure-api',false,'function outer(value){return ()=>({nested:value});}'+stmt('outer(window.desktopApi)()')],
 ['special-conditional-data',true,stmt('true?{["__proto__"]:"bank"}:{["__proto__"]:"bank"}')],
 ['special-conditional-api',false,stmt('true?{["__proto__"]:window.desktopApi}:{["__proto__"]:window.desktopApi}')],
 ['category-return-allowed-ipc',true,"const {ipcRenderer}=require('electron');function provide(){return ipcRenderer.invoke('app:get-info').reconIdFixBillCategory;}"+recon('provide()'),'renderer-recon-id-fix'],
 ['category-return-other-ipc',false,"const {ipcRenderer}=require('electron');function provide(){return ipcRenderer.invoke('other').reconIdFixBillCategory;}"+recon('provide()'),'renderer-recon-id-fix'],
 ['mount-parameter-allowed-ipc',true,"const {ipcRenderer}=require('electron');function mount(info){"+stmt('info')+"}mount(ipcRenderer.invoke('app:get-info'));"],
 ['mount-parameter-other-ipc',false,"const {ipcRenderer}=require('electron');function mount(info){"+stmt('info')+"}mount(ipcRenderer.invoke('other'));"],
];
const renderResults=renderer.map(([name,expectedClean,source,id='renderer-statement'])=>({name,expectedClean,source,...evaluate({'src/shell.js':source},id)}));
const query=[
 ['direct-callback',false,'exports.read=c=>[c].map(query);'],
 ['returned-callback',false,'function identity(fn){return fn;}exports.read=c=>[c].map(identity(query));'],
 ['helper-param-callback',false,'function apply(fn,c){return [c].map(fn);}exports.read=c=>apply(query,c);'],
 ['unused-helper-param',true,'function ignore(fn,c){return [];}exports.read=c=>ignore(query,c);'],
 ['selected-safe-return',true,'function provider(){return {read:safe,unused:query};}exports.read=c=>provider().read(c);'],
 ['selected-query-return',false,'function provider(){return {read:query,unused:safe};}exports.read=c=>provider().read(c);'],
 ['array-parameter-query',false,'function dispatch(list,index,c){return list[index](c);}exports.read=c=>dispatch([safe,query],1,c);'],
 ['array-parameter-safe',true,'function dispatch(list,index,c){return list[index](c);}exports.read=c=>dispatch([safe,query],0,c);'],
];
const queryResults=query.map(([name,expectedClean,body])=>{
 const source="const query=c=>c.db.prepare('SELECT 1 AS value').all();const safe=()=>[];"+body;
 const output=evaluate({'src/main-process/biz-op-v327/import-main.js':"const h=require('./r5-query');exports.read=c=>h.read(c);",'src/main-process/biz-op-v327/r5-query.js':source},'bizop-query-q3');
 const db=new DatabaseSync(':memory:'),sql=[],exports={};let actual;
 try{vm.runInNewContext(source,{exports});actual=exports.read({db:{prepare(q){sql.push(q);return db.prepare(q);}}});}finally{db.close();}
 return {name,expectedClean,source,sql,actual,...output};
});
const policy=['architecture/boundaries.json','architecture/legacy-allowlist.json','scripts/architecture/schema.js','scripts/architecture/policy-history.js'].map(p=>{const current=crypto.createHash('sha256').update(fs.readFileSync(path.join(repo,p))).digest('hex');return{path:p,before:manifest.sha256[p],current,same:current===manifest.sha256[p]};});
const currentInputHashes=hashes.map(({path:p})=>({path:p,sha256:crypto.createHash('sha256').update(fs.readFileSync(path.join(repo,p))).digest('hex')}));
const results={beforeInputHashes:hashes,currentInputHashes,policy,renderer:renderResults,query:queryResults};
console.log(JSON.stringify(results,null,2));
fs.rmSync(old,{recursive:true,force:true});
