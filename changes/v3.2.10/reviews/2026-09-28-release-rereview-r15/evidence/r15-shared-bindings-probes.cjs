'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm'),crypto=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');
const repo=process.cwd(), old=fs.mkdtempSync('/tmp/r15-shared-bindings-before-');
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
 const root=fs.mkdtempSync('/tmp/r15-shared-bindings-fixture-');
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
const prefix = 'function provide(){return {api:{run(){}}};}const old=provide();const current=provide();';
const suffix = 'const alias=list[0].api;alias.outsideScope=window.desktopApi.outsideScope;window.BankStatementController.createBankStatementController({api:current.api});({sameCurrent:alias===current.api,sameOld:alias===old.api});';
const cases = [
  ['shared-helper-independent-safe', false, 'function put(target,value){target.push(value);}function make(value){const args=[];put(args,value);return args;}const first=make(old);const second=make(current);const list=[...first];'],
  ['shared-helper-independent-unsafe', true, 'function put(target,value){target.push(value);}function make(value){const args=[];put(args,value);return args;}const first=make(old);const second=make(current);const list=[...second];'],
  ['lexical-capture-shadow-safe', false, 'function make(value){function retain(){return value;}function helper(value){return retain();}const args=[];args.push(helper(current));return args;}const list=[...make(old)];'],
  ['lexical-capture-shadow-unsafe', true, 'function make(value){function retain(){return value;}function helper(value){return retain();}const args=[];args.push(helper(old));return args;}const list=[...make(current)];'],
  ['sibling-factory-local-helper-safe', false, 'function first(value){function put(target,value){target[0]=value;}const args=[];put(args,value);return args;}function second(value){function put(target,value){target.push(value);}const args=[];put(args,value);return args;}const one=first(old);const two=second(current);const list=[...one];'],
  ['sibling-factory-local-helper-unsafe', true, 'function first(value){function put(target,value){target[0]=value;}const args=[];put(args,value);return args;}function second(value){function put(target,value){target.push(value);}const args=[];put(args,value);return args;}const one=first(old);const two=second(current);const list=[...two];'],
];

const rows=cases.map(([name,unsafe,body])=>{
 const source=prefix+body+suffix;
 let injected;
 const window={desktopApi:{outsideScope(){return true;}},BankStatementController:{createBankStatementController(value){injected=value;}}};
 const runtime=vm.runInNewContext(source,{window});
 return {name,unsafe,source,runtime:{...runtime,injectedKeys:Object.keys(injected.api),outsideScope:typeof injected.api.outsideScope==='function',outsideScopeResult:typeof injected.api.outsideScope==='function'?injected.api.outsideScope():null},...evaluate({'src/shell.js':source},'renderer-bank-statement')};
});
const currentInputHashes=hashes.map(({path:p})=>({path:p,sha256:crypto.createHash('sha256').update(fs.readFileSync(path.join(repo,p))).digest('hex')}));
console.log(JSON.stringify({beforeInputHashes:hashes,currentInputHashes,total:rows.length,rows},null,2));
fs.rmSync(old,{recursive:true,force:true});
