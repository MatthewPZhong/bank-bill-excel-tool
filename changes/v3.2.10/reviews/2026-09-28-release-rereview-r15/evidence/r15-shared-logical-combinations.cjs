'use strict';
(async()=>{
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm'),crypto=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');
const repo=process.cwd(), old=fs.mkdtempSync('/tmp/r15-shared-before-');
const archive=path.join(repo,'changes/v3.2.10/reviews/2026-09-28-release-r14-repair');
const manifest=JSON.parse(fs.readFileSync(path.join(archive,'input-manifest.json'))), actual=require(path.join(repo,'architecture/boundaries.json'));
const hashes=[];
for(const name of ['scan','contracts','rules','renderer-contracts','schema']){
 const p='scripts/architecture/'+name+'.js', src=['scan','contracts','schema','rules'].includes(name)?path.join(repo,p):path.join(archive,'before',p);
 const value=fs.readFileSync(src); const sha=crypto.createHash('sha256').update(value).digest('hex');
 if(sha!==manifest.sha256[p]) throw new Error('before mismatch '+p);
 const target=path.join(old,p);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,value);hashes.push({path:p,sha256:sha,match:true});
}
fs.symlinkSync(path.join(repo,'node_modules'),path.join(old,'node_modules'),'dir');
const versions=[['beforeR14',old],['current',repo]].map(([name,p])=>({name,scan:require(path.join(p,'scripts/architecture/scan')).scan,evaluate:require(path.join(p,'scripts/architecture/rules')).evaluateRules}));
function evaluate(files,id){
 const root=fs.mkdtempSync('/tmp/r15-shared-fixture-');
 try{
 for(const [p,s]of Object.entries(files)){const target=path.join(root,p);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,s);}
 const cfg={schemaVersion:1,factBaseline:'1'.repeat(40),bootstrap:{factBaseline:'1'.repeat(40),mode:'first-introduction'},boundaries:[{...structuredClone(actual.boundaries.find(b=>b.id===id)),state:'pending'}],generatedModules:[],dynamicLoads:[],policyChanges:[]};
 const out={scanner:{}};for(const v of versions){
 const scanned=v.scan(root,cfg),serialized=JSON.stringify(scanned),digest=x=>crypto.createHash('sha256').update(x).digest('hex');
 const repeated=JSON.stringify(v.scan(root,cfg));
 out[v.name]=v.evaluate(scanned,cfg,{schemaVersion:1,factBaseline:cfg.factBaseline,exceptions:[]},{root}).violations;
 out.scanner[v.name]={digest:digest(serialized),repeatEqual:repeated===serialized,afterRulesEqual:JSON.stringify(scanned)===serialized,siteEvidenceIds:scanned.sites.map(s=>s.evidenceId)};
 }out.scanner.beforeCurrentEqual=out.scanner.beforeR14.digest===out.scanner.current.digest;
 return out;
 }finally{fs.rmSync(root,{recursive:true,force:true});}
}
const stmt=x=>`window.StatementController.createStatementController({initialInfo:${x}});`;
const recon=x=>`window.ReconIdFixController.createReconIdFixController({config:{initialBillCategory:${x}}});`;
const ipcHead="(async()=>{const {ipcRenderer}=require('electron');const info=await ipcRenderer.invoke('app:get-info');";
const renderer=[
 ['ipc-and-pure-data',true,ipcHead+stmt('info.enabled && ["bank",1]')+'})();'],
 ['ipc-and-whole-api',false,ipcHead+stmt('info.enabled && window.desktopApi')+'})();'],
 ['category-falsy-and-api',true,recon('0 && window.desktopApi'),'renderer-recon-id-fix'],
 ['category-truthy-and-data',true,recon('({}) && "business"'),'renderer-recon-id-fix'],
 ['conditional-distinct-pure-values',false,recon('flag ? "business" : "gateway"'),'renderer-recon-id-fix'],
 ['conditional-pure-or-api',false,recon('flag ? "business" : window.desktopApi'),'renderer-recon-id-fix'],
];
const renderResults=[];
for(const [name,expectedClean,source,id='renderer-statement']of renderer){
 const runtime=[];
 for(const flag of [false,true]){
  let received;const calls=[],api={outsideScope(){return true;}};
  const capture=input=>{received=input;};
  const window={desktopApi:api,StatementController:{createStatementController:capture},ReconIdFixController:{createReconIdFixController:capture}};
  await vm.runInNewContext(source,{flag,window,require(name){if(name!=='electron')throw new Error(name);return{ipcRenderer:{async invoke(channel){calls.push(channel);return{enabled:flag,reconIdFixBillCategory:'business',channel};}}};}});
  const payload=received?.initialInfo??received?.config?.initialBillCategory;
  runtime.push({flag,calledIpc:calls,value:payload,valueType:typeof payload,isWholeApi:payload===api});
 }
 renderResults.push({name,expectedClean,source,knownConservative:name==='conditional-distinct-pure-values'?'both branches are pure strings but current and prior reject ambiguous value':null,runtime,...evaluate({'src/shell.js':source},id)});
}
const query=[];
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

})().catch(error=>{console.error(error);process.exitCode=1;});
