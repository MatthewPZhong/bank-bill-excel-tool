'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),cp=require('node:child_process'),vm=require('node:vm');
const {DatabaseSync}=require('node:sqlite');
const repo=process.cwd();
const historical=fs.mkdtempSync(path.join(os.tmpdir(),'r3-pre-repair-'));
for(const name of ['scan','rules','contracts','schema']){
 const file=path.join(historical,'scripts/architecture',name+'.js');fs.mkdirSync(path.dirname(file),{recursive:true});
 fs.writeFileSync(file,cp.execFileSync('git',['show','HEAD:scripts/architecture/'+name+'.js'],{cwd:repo}));
}
const patch=fs.readFileSync(path.join(repo,'changes/v3.2.10/reviews/2026-09-21-release-r2-repair/input-diff.patch'));
cp.execFileSync('git',['apply',...['scan','rules','contracts','schema'].map(n=>'--include=scripts/architecture/'+n+'.js')],{cwd:historical,input:patch});
fs.copyFileSync(path.join(repo,'scripts/architecture/renderer-contracts.js'),path.join(historical,'scripts/architecture/renderer-contracts.js'));
fs.symlinkSync(path.join(repo,'node_modules'),path.join(historical,'node_modules'),'dir');
const oldManifest=JSON.parse(fs.readFileSync(path.join(repo,'changes/v3.2.10/reviews/2026-09-21-release-r2-repair/input-manifest.json')));
const inputHashes=Object.fromEntries(['scan','rules','contracts','schema'].map(n=>{const f='scripts/architecture/'+n+'.js';const got=require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(historical,f))).digest('hex');return[f,{matchesPriorSnapshot:got===oldManifest.sha256[f],sha256:got}]}));
if(Object.values(inputHashes).some(v=>!v.matchesPriorSnapshot))throw new Error('historical mismatch');
const cases=[
['static-array','const handlers=[query];exports.read=c=>handlers[0](c);'],
['parameter-spread','function invoke(values,c){const handlers=[...values,safe];return handlers[1](c);}exports.read=c=>invoke([safe,query],c);'],
['factory-spread','function get(){return [safe,query];}const handlers=[...get(),safe];exports.read=c=>handlers[1](c);'],
['array-member-write','const handlers=[safe];handlers[0]=query;exports.read=c=>handlers[0](c);'],
['array-call','const handlers=[query];exports.read=c=>handlers[0].call(null,c);'],
['array-apply','const handlers=[query];exports.read=c=>handlers[0].apply(null,[c]);'],
['bound-array-parameter','function invoke(values,c){return values[0](c);}const run=invoke.bind(null,[query]);exports.read=c=>run(c);'],
['spread-array-element','const handlers=[safe,query];exports.read=c=>handlers[1](...[c]);'],
['pure-safe','const handlers=[query,safe];exports.read=c=>handlers[1](c);'],
['known-static-spread','const handlers=[...[safe,query],safe];exports.read=c=>handlers[1](c);']
];
const baseline='1'.repeat(40);const results=[];
try{for(const [name,body]of cases){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'r3-query-'));
 try{
 const source="const query=c=>c.db.prepare('SELECT 1 AS value').all();const safe=()=>[];"+body;
 fs.mkdirSync(path.join(root,'src'));fs.writeFileSync(path.join(root,'src/read.js'),"const h=require('./helper');exports.read=c=>h.read(c);");fs.writeFileSync(path.join(root,'src/helper.js'),source);
 const boundary={id:'probe',governance:'G8',owner:'probe',state:'pending',rules:['ARCH-BIZOP-QUERY'],entrypoints:[],allowedLocal:[],allowedExternal:[],requiredConsumers:[],activationEvidence:[],protectedScopes:[{path:'src/read.js',functionPath:null}],restrictedApis:[],allowedSites:[],compositionEntrypoints:[],globals:[],factory:null,allowedApiFields:{},deprecatedEntrypoints:[],directory:null};
 const config={schemaVersion:1,factBaseline:baseline,bootstrap:{factBaseline:baseline,mode:'first-introduction'},boundaries:[boundary],generatedModules:[],dynamicLoads:[],policyChanges:[]};
 const outputs={};for(const[label,toolsRoot]of [['beforeR2Repair',historical],['current',repo]]){
 const{scan}=require(path.join(toolsRoot,'scripts/architecture/scan'));const{evaluateRules}=require(path.join(toolsRoot,'scripts/architecture/rules'));const s=scan(root,config);outputs[label]=evaluateRules(s,config,{schemaVersion:1,factBaseline:baseline,exceptions:[]},{root}).violations;
 }
 const db=new DatabaseSync(':memory:'),sql=[],ex={};let actual;try{vm.runInNewContext(source,{exports:ex});actual=ex.read({db:{prepare(q){sql.push(q);return db.prepare(q)}}})}finally{db.close()}
 results.push({name,source,sql,actual,...outputs});
 }finally{fs.rmSync(root,{recursive:true,force:true})}
}}finally{fs.rmSync(historical,{recursive:true,force:true})}
console.log(JSON.stringify({inputHashes,results},null,2));
