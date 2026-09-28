'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {DatabaseSync}=require('node:sqlite');
const repo=process.cwd(),root=fs.mkdtempSync(path.join(os.tmpdir(),'r3-real-query-'));
const {scan}=require(path.join(repo,'scripts/architecture/scan')),{evaluateRules}=require(path.join(repo,'scripts/architecture/rules'));
const config=JSON.parse(fs.readFileSync(path.join(repo,'architecture/boundaries.json'))),allow=JSON.parse(fs.readFileSync(path.join(repo,'architecture/legacy-allowlist.json')));
function evaluate(){const s=scan(root,config);return {coverage:{files:s.analyses.size,parseErrors:s.parseErrors.length,unresolved:s.unresolved.length},violations:evaluateRules(s,config,allow,{root}).violations};}
try{
 fs.cpSync(path.join(repo,'src'),path.join(root,'src'),{recursive:true});
 for(const file of ['index.html','package.json'])fs.copyFileSync(path.join(repo,file),path.join(root,file));
 for(const dir of ['tests','scripts'])fs.symlinkSync(path.join(repo,dir),path.join(root,dir),'dir');
 const baseline=evaluate();
 const entry=path.join(root,'src/main-process/biz-op-v327/compute-inputs.js');
 fs.appendFileSync(entry,"\nconst r3Helper=require('./r3-query-helper');exports.r3Read=c=>r3Helper.read(c);\n");
 const helper=path.join(root,'src/main-process/biz-op-v327/r3-query-helper.js');
 const definitions="const query=c=>c.db.prepare('SELECT 1 AS value').all();const safe=()=>[];";
 const cases=[
 ['opaque-parameter-spread',"function invoke(values,c){const handlers=[...values,safe];return handlers[1](c);}exports.read=c=>invoke([safe,query],c);"],
 ['known-static-spread',"const handlers=[...[safe,query],safe];exports.read=c=>handlers[1](c);"],
 ['safe',"const handlers=[query,safe];exports.read=c=>handlers[1](c);"]
 ],results=[];
 for(const[name,body]of cases){
  fs.writeFileSync(helper,definitions+body);delete require.cache[helper];const sql=[],db=new DatabaseSync(':memory:');let runtimeResult;
  try{const ex={};require('node:vm').runInNewContext(definitions+body,{exports:ex});runtimeResult=ex.read({db:{prepare(q){sql.push(q);return db.prepare(q)}}})}finally{db.close()}
  results.push({name,source:definitions+body,sql,runtimeResult,...evaluate()});
 }
 console.log(JSON.stringify({configuration:'Complete current 31 boundaries and allowlist, copied production src and index; only temporary helper and entry added',baseline,results},null,2));
}finally{fs.rmSync(root,{recursive:true,force:true})}
