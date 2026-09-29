'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),cp=require('node:child_process');
const repo='/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10';
const historical=fs.mkdtempSync(path.join(os.tmpdir(),'g8-r2-baseline-'));
for(const name of ['scan','rules','contracts','schema']) {const dest=path.join(historical,'scripts/architecture',name+'.js');fs.mkdirSync(path.dirname(dest),{recursive:true});fs.writeFileSync(dest,cp.execFileSync('git',['show','HEAD:scripts/architecture/'+name+'.js'],{cwd:repo}));}
fs.symlinkSync(path.join(repo,'node_modules'),path.join(historical,'node_modules'),'dir');
const { DatabaseSync }=require('node:sqlite');
const baseline='1'.repeat(40);
function boundary(rule,extra={}){return {id:'probe',owner:'probe',governance:'G8',state:'pending',rules:[rule],entrypoints:[],allowedLocal:[],allowedExternal:[],requiredConsumers:[],activationEvidence:[],protectedScopes:[],restrictedApis:[],allowedSites:[],compositionEntrypoints:[],globals:[],factory:null,allowedApiFields:{},deprecatedEntrypoints:[],directory:null,...extra};}
const cases=[
 ['direct',"const h=require('./helper');exports.read=c=>h.query(c);", "exports.query=c=>c.db.prepare('SELECT 1').all();"],
 ['class-this',"const h=require('./helper');exports.read=c=>h.make().read(c);", "class Reader{query(c){return c.db.prepare('SELECT 1').all();}read(c){return this.query(c);}}exports.make=()=>new Reader();"],
 ['object-this',"const h=require('./helper');exports.read=c=>h.make().read(c);", "exports.make=()=>({query(c){return c.db.prepare('SELECT 1').all();},read(c){return this.query(c);}});"],
 ['static-array',"const h=require('./helper');exports.read=c=>h.read(c);", "const query=c=>c.db.prepare('SELECT 1').all();const handlers=[query];exports.read=c=>handlers[0](c);"],
 ['array-destructuring',"const h=require('./helper');exports.read=c=>h.read(c);", "const query=c=>c.db.prepare('SELECT 1').all();const [run]=[query];exports.read=c=>run(c);"],
 ['default-callback',"const h=require('./helper');exports.read=c=>h.read(c);", "const query=c=>c.db.prepare('SELECT 1').all();exports.read=(c,fn=query)=>fn(c);"],
 ['safe',"const h=require('./helper');exports.read=c=>h.safe(c);", "exports.query=c=>c.db.prepare('SELECT 1').all();exports.safe=()=>[];"]
];
const results=[];
try {for(const [name,read,helper] of cases){const root=fs.mkdtempSync(path.join(os.tmpdir(),'g8-r2-query-'));try {
 fs.mkdirSync(path.join(root,'src'));fs.writeFileSync(path.join(root,'src/read.js'),read);fs.writeFileSync(path.join(root,'src/helper.js'),helper);
 const config={schemaVersion:1,factBaseline:baseline,bootstrap:{factBaseline:baseline,mode:'first-introduction'},boundaries:[boundary('ARCH-BIZOP-QUERY',{protectedScopes:[{path:'src/read.js',functionPath:null}]})],generatedModules:[],dynamicLoads:[],policyChanges:[]};
 const outputs={};for(const [version,toolsRoot] of [['before',historical],['current',repo]]){const {scan}=require(path.join(toolsRoot,'scripts/architecture/scan'));const {evaluateRules}=require(path.join(toolsRoot,'scripts/architecture/rules'));const s=scan(root,config);outputs[version]=evaluateRules(s,config,{schemaVersion:1,factBaseline:baseline,exceptions:[]},{root}).violations.map(({rule,from,line,functionPath,message})=>({rule,from,line,functionPath,message}));}
 const sql=[];const db=new DatabaseSync(':memory:');let runtimeResult;try{runtimeResult=require(path.join(root,'src/read.js')).read({db:{prepare(q){sql.push(q);return db.prepare(q);}}});}finally{db.close();}results.push({name,read,helper,runtimeSql:sql,runtimeResult,...outputs});
 }finally{fs.rmSync(root,{recursive:true,force:true});}}}finally{fs.rmSync(historical,{recursive:true,force:true});}
console.log(JSON.stringify(results,null,2));
