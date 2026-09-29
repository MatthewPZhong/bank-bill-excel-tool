'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),cp=require('node:child_process'),crypto=require('node:crypto');
const repo=process.cwd(),historical=fs.mkdtempSync(path.join(os.tmpdir(),'r5-native-before-'));
const prior=path.join(repo,'changes/v3.2.10/reviews/2026-09-22-release-r4-repair');
const expected=JSON.parse(fs.readFileSync(path.join(prior,'input-manifest.json'))).sha256;
try{
 const hashes=[];
 const paths=['scripts/architecture/scan.js','scripts/architecture/rules.js','scripts/architecture/contracts.js','scripts/architecture/renderer-contracts.js','scripts/architecture/schema.js','architecture/boundaries.json','architecture/legacy-allowlist.json'];
 for(const relative of paths){
  const archived=path.join(prior,'before',relative),source=fs.existsSync(archived)?archived:path.join(repo,relative);
  const target=path.join(historical,relative);fs.mkdirSync(path.dirname(target),{recursive:true});
  const bytes=fs.readFileSync(source),sha=crypto.createHash('sha256').update(bytes).digest('hex');
  if(sha!==expected[relative])throw new Error('Prior input hash mismatch: '+relative);
  hashes.push({path:relative,sha256:sha,matchesPriorInput:true});fs.writeFileSync(target,bytes);
 }
 fs.symlinkSync(path.join(repo,'node_modules'),path.join(historical,'node_modules'),'dir');
 const probe=path.join(__dirname,'r5-g1-native-data-probe.cjs');
 const execute=cwd=>JSON.parse(cp.execFileSync(process.execPath,[probe],{cwd,encoding:'utf8'}));
 const before=execute(historical),current=execute(repo);
 for(const name of ['native_includes','native_indexof']){
  const b=before.outputs.find(x=>x.name===name),c=current.outputs.find(x=>x.name===name);
  if(b.violations.length!==0||c.violations.length!==1||c.writes!==0)throw Error('Expected false positive not reproduced: '+name);
 }
 const safe=current.outputs.find(x=>x.name==='source_helper_compare'),unsafe=current.outputs.find(x=>x.name==='reduce_execution');
 if(safe.violations.length||safe.writes||unsafe.writes!==1||unsafe.violations.length!==1)throw Error('Control mismatch');
 console.log(JSON.stringify({hashes,before,current},null,2));
}finally{fs.rmSync(historical,{recursive:true,force:true})}
