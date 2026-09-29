'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),cp=require('node:child_process'),crypto=require('node:crypto');
const repo=process.cwd(),historical=fs.mkdtempSync(path.join(os.tmpdir(),'r4-before-'));
const prior=path.join(repo,'changes/v3.2.10/reviews/2026-09-22-release-r3-repair');
const expected=JSON.parse(fs.readFileSync(path.join(prior,'input-manifest.json'))).sha256;
try{
 const hashes=[];
 for(const name of ['scan','rules','contracts','renderer-contracts','schema']){
  const relative='scripts/architecture/'+name+'.js';
  const archived=path.join(prior,'before',relative);
  const source=fs.existsSync(archived)?archived:path.join(repo,relative);
  const target=path.join(historical,relative);fs.mkdirSync(path.dirname(target),{recursive:true});
  const bytes=fs.readFileSync(source),sha=crypto.createHash('sha256').update(bytes).digest('hex');
  if(sha!==expected[relative])throw new Error('Prior input hash mismatch: '+relative);
  hashes.push({path:relative,sha256:sha,matchesPriorInput:true});fs.writeFileSync(target,bytes);
 }
 fs.symlinkSync(path.join(repo,'node_modules'),path.join(historical,'node_modules'),'dir');
 const probe=path.join(__dirname,'r4-renderer-separate-instances.cjs');
 const execute=scanner=>cp.execFileSync(process.execPath,[probe],{cwd:repo,env:{...process.env,RENDERER_SCANNER_ROOT:scanner},encoding:'utf8'}).trim().split('\n').map(JSON.parse);
 const before=execute(historical),current=execute(repo);
 if(before[0].violations.length!==0||current[0].violations.length!==1||current[0].runtime.aliasReach!==false)throw Error('Expected distinct-instance regression not reproduced');
 console.log(JSON.stringify({hashes,before,current},null,2));
}finally{fs.rmSync(historical,{recursive:true,force:true})}

