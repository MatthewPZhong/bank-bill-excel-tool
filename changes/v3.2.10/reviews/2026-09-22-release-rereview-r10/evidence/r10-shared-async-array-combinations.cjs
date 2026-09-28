'use strict';
(async()=>{
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm'),crypto=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');
const repo=process.cwd(), old=fs.mkdtempSync('/tmp/r10-shared-before-');
const archive=path.join(repo,'changes/v3.2.10/reviews/2026-09-22-release-r9-repair');
const manifest=JSON.parse(fs.readFileSync(path.join(archive,'input-manifest.json'))), actual=require(path.join(repo,'architecture/boundaries.json'));
const hashes=[];
for(const name of ['scan','contracts','rules','renderer-contracts','schema']){
 const p='scripts/architecture/'+name+'.js', src=['scan','contracts','schema','rules'].includes(name)?path.join(repo,p):path.join(archive,'before',p);
 const value=fs.readFileSync(src); const sha=crypto.createHash('sha256').update(value).digest('hex');
 if(sha!==manifest.sha256[p]) throw new Error('before mismatch '+p);
 const target=path.join(old,p);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,value);hashes.push({path:p,sha256:sha,match:true});
}
fs.symlinkSync(path.join(repo,'node_modules'),path.join(old,'node_modules'),'dir');
const versions=[['beforeR9',old],['current',repo]].map(([name,p])=>({name,scan:require(path.join(p,'scripts/architecture/scan')).scan,evaluate:require(path.join(p,'scripts/architecture/rules')).evaluateRules}));
function evaluate(files,id){
 const root=fs.mkdtempSync('/tmp/r10-shared-fixture-');
 try{
 for(const [p,s]of Object.entries(files)){const target=path.join(root,p);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,s);}
 const cfg={schemaVersion:1,factBaseline:'1'.repeat(40),bootstrap:{factBaseline:'1'.repeat(40),mode:'first-introduction'},boundaries:[{...structuredClone(actual.boundaries.find(b=>b.id===id)),state:'pending'}],generatedModules:[],dynamicLoads:[],policyChanges:[]};
 const out={scanner:{}};for(const v of versions){
 const scanned=v.scan(root,cfg),serialized=JSON.stringify(scanned),digest=x=>crypto.createHash('sha256').update(x).digest('hex');
 const repeated=JSON.stringify(v.scan(root,cfg));
 out[v.name]=v.evaluate(scanned,cfg,{schemaVersion:1,factBaseline:cfg.factBaseline,exceptions:[]},{root}).violations;
 out.scanner[v.name]={digest:digest(serialized),repeatEqual:repeated===serialized,afterRulesEqual:JSON.stringify(scanned)===serialized,siteEvidenceIds:scanned.sites.map(s=>s.evidenceId)};
 }out.scanner.beforeCurrentEqual=out.scanner.beforeR9.digest===out.scanner.current.digest;
 return out;
 }finally{fs.rmSync(root,{recursive:true,force:true});}
}
const stmt=x=>`window.StatementController.createStatementController({initialInfo:${x}});`;
const recon=x=>`window.ReconIdFixController.createReconIdFixController({config:{initialBillCategory:${x}}});`;
const renderer=[
 ['whole-array-pure-write',true,'const data=[{name:"bank"}];data[0]={name:"updated"};'+stmt('data')],
 ['whole-array-capability-write',false,'const data=[{name:"bank"}];data[0]=window.desktopApi;'+stmt('data')],
 ['awaited-ipc-pure-array-default',true,"(async()=>{const {ipcRenderer}=require('electron');const info=await ipcRenderer.invoke('app:get-info');function select(value=[{name:'bank'}]){return value;}"+stmt('select(info.missingList)')+"})();"],
 ['awaited-ipc-capability-array-default',false,"(async()=>{const {ipcRenderer}=require('electron');const info=await ipcRenderer.invoke('app:get-info');function select(value=[window.desktopApi]){return value;}"+stmt('select(info.missingList)')+"})();"],
 ['awaited-category-other-default-conservative',false,"(async()=>{const {ipcRenderer}=require('electron');const info=await ipcRenderer.invoke('app:get-info');function mount(category=ipcRenderer.invoke('other')){"+recon('category')+"}mount(info.reconIdFixBillCategory);})();",'renderer-recon-id-fix'],
 ['awaited-category-data-default',true,"(async()=>{const {ipcRenderer}=require('electron');const info=await ipcRenderer.invoke('app:get-info');function mount(category='gateway'){"+recon('category')+"}mount(info.reconIdFixBillCategory);})();",'renderer-recon-id-fix'],
];
const renderResults=await Promise.all(renderer.map(async ([name,expectedClean,source,id='renderer-statement'])=>{
 let received;const calls=[];const api={run(){},outsideScope(){return true;}},state={allDomains:true};
 const capture=input=>{received=input;};
 const window={desktopApi:api,state,StatementController:{createStatementController:capture},ReconIdFixController:{createReconIdFixController:capture},BankStatementController:{createBankStatementController:capture}};
 await vm.runInNewContext(source,{window,require(name){if(name!=='electron')throw new Error(name);return{ipcRenderer:{async invoke(channel){calls.push(channel);return {reconIdFixBillCategory:'business',channel};}}};}});
 const hasWhole=(value,seen=new Set())=>value===api||(value&&typeof value==='object'&&!seen.has(value)&&(seen.add(value),Object.values(value).some(item=>hasWhole(item,seen))));
 const runtime={initialContainsWholeApi:Boolean(hasWhole(received?.initialInfo)),calledIpc:calls,category:await received?.config?.initialBillCategory,categoryWasThenable:typeof received?.config?.initialBillCategory?.then==='function',initialInfo:received?.initialInfo,initialNestedIsState:received?.initialInfo?.nested===state,apiIsWhole:received?.api===api,apiKeys:Object.keys(received?.api||{})};
 return{name,expectedClean,historicalExpectedClean:name==='single-mount-category-explicit-ipc'?true:expectedClean,source,runtime,...evaluate({'src/shell.js':source},id)};
}));
const query=[];
const queryResults=query.map(([name,expectedClean,body])=>{
 const source="const query=c=>c.db.prepare('SELECT 1 AS value').all();const safe=()=>[];"+body;
 const output=evaluate({'src/main-process/biz-op-v327/import-main.js':"const h=require('./r5-query');exports.read=c=>h.read(c);",'src/main-process/biz-op-v327/r5-query.js':source},'bizop-query-q3');
 const db=new DatabaseSync(':memory:'),sql=[],exports={};let actual;
 try{vm.runInNewContext(source,{exports});actual=exports.read({db:{prepare(q){sql.push(q);return db.prepare(q);}}});}finally{db.close();}
 return {name,expectedClean,source,sql,actual,...output};
});
const policy=['architecture/boundaries.json','architecture/legacy-allowlist.json','scripts/architecture/schema.js','scripts/architecture/policy-history.js'].map(p=>{const current=crypto.createHash('sha256').update(fs.readFileSync(path.join(repo,p))).digest('hex');return{path:p,before:manifest.sha256[p],current,same:current===manifest.sha256[p]};});
const results={beforeInputHashes:hashes,policy,renderer:renderResults,query:queryResults};
console.log(JSON.stringify(results,null,2));
fs.rmSync(old,{recursive:true,force:true});

})().catch(error=>{console.error(error);process.exitCode=1;});
