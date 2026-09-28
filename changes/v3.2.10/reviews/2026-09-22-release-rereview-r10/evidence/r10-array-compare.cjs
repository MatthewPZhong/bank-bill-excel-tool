'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),cp=require('node:child_process');
const repo=process.cwd();const repair=path.join(repo,'changes/v3.2.10/reviews/2026-09-22-release-r9-repair');
const beforeManifest=JSON.parse(fs.readFileSync(path.join(repair,'input-manifest.json'))).sha256;
const currentManifest=JSON.parse(fs.readFileSync(path.join(repo,'changes/v3.2.10/reviews/2026-09-22-release-rereview-r10/evidence/input-manifest.json'))).sha256;
const root=fs.mkdtempSync(path.join(os.tmpdir(),'r10-array-before-checker-'));const hashes=[];
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
try{
 for(const name of ['scan.js','contracts.js','renderer-contracts.js','rules.js','schema.js']){
  const rel='scripts/architecture/'+name;const src=path.join(name==='renderer-contracts.js'?path.join(repair,'before'):repo,rel);const bytes=fs.readFileSync(src);const beforeSha256=hash(bytes);if(beforeSha256!==beforeManifest[rel])throw Error('before mismatch '+rel);
  const currentSha256=hash(fs.readFileSync(path.join(repo,rel)));if(currentSha256!==currentManifest[rel])throw Error('current mismatch '+rel);
  const target=path.join(root,rel);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,bytes);hashes.push({path:rel,beforeSha256,currentSha256,beforeMatchesR9Input:true,currentMatchesR10Input:true});
 }
 for(const rel of ['architecture/boundaries.json','architecture/legacy-allowlist.json']){const sha256=hash(fs.readFileSync(path.join(repo,rel)));if(sha256!==beforeManifest[rel]||sha256!==currentManifest[rel])throw Error('config mismatch '+rel);hashes.push({path:rel,sha256,beforeMatchesR9Input:true,currentMatchesR10Input:true});}
 fs.symlinkSync(path.join(repo,'node_modules'),path.join(root,'node_modules'),'dir');
 const probe=path.join(__dirname,process.argv[2]||'r10-array-probe.cjs');const mode=process.argv[3]||'minimal';const run=tools=>JSON.parse(cp.execFileSync(process.execPath,[probe,mode],{cwd:repo,env:{...process.env,R10_ARRAY_TOOLS_ROOT:tools},encoding:'utf8',stdio:['ignore','pipe','pipe'],maxBuffer:2*1024*1024}));
 console.log(JSON.stringify({repo,head:cp.execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim(),hashes,probeSha256:hash(fs.readFileSync(probe)),caseHashes:Object.fromEntries(['r10-array-cases.cjs','r10-array-neighbor-cases.cjs','r10-array-selected-cases.cjs','r10-array-original-neighbor-cases.cjs','r10-array-real-neighbor-cases.cjs'].map(name=>[name,hash(fs.readFileSync(path.join(__dirname,name)))])),before:run(root),current:run(repo)},null,2));
}finally{fs.rmSync(root,{recursive:true,force:true});}
