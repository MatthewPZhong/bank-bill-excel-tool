'use strict';
const fs=require('node:fs');const path=require('node:path');const os=require('node:os');const crypto=require('node:crypto');const cp=require('node:child_process');
const repo=process.cwd();const repair=path.join(repo,'changes/v3.2.10/reviews/2026-09-22-release-r5-repair');
const manifest=JSON.parse(fs.readFileSync(path.join(repair,'input-manifest.json'),'utf8')).sha256;
const root=fs.mkdtempSync(path.join(os.tmpdir(),'r6-g1-before-checker-'));const hashes=[];
try {
  for(const name of ['scan.js','contracts.js','renderer-contracts.js','rules.js','schema.js']) {
    const rel='scripts/architecture/'+name;const source=path.join(['rules.js','schema.js'].includes(name)?repo:path.join(repair,'before'),rel);
    const bytes=fs.readFileSync(source);const sha256=crypto.createHash('sha256').update(bytes).digest('hex');
    if(sha256!==manifest[rel])throw Error('before hash mismatch: '+rel);
    const target=path.join(root,rel);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,bytes);hashes.push({path:rel,source,sha256,matchesInputManifest:true});
  }
  for(const rel of ['architecture/boundaries.json','architecture/legacy-allowlist.json']) {
    const bytes=fs.readFileSync(path.join(repo,rel));const sha256=crypto.createHash('sha256').update(bytes).digest('hex');
    if(sha256!==manifest[rel])throw Error('configuration hash mismatch: '+rel);
    const target=path.join(root,rel);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,bytes);hashes.push({path:rel,sha256,matchesInputManifest:true});
  }
  fs.symlinkSync(path.join(repo,'node_modules'),path.join(root,'node_modules'),'dir');
  const probe=path.join(__dirname,'r6-g1-neighbor-probe.cjs');const probeSha256=crypto.createHash('sha256').update(fs.readFileSync(probe)).digest('hex');
  const run=cwd=>JSON.parse(cp.execFileSync(process.execPath,[probe],{cwd,encoding:'utf8',maxBuffer:2*1024*1024}));
  const before=run(root);const current=run(repo);const currentHashes=Object.fromEntries(['scan.js','contracts.js','renderer-contracts.js','rules.js','schema.js'].map(name=>{const rel='scripts/architecture/'+name;return [rel,crypto.createHash('sha256').update(fs.readFileSync(path.join(repo,rel))).digest('hex')];}));
  console.log(JSON.stringify({repo,head:cp.execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim(),repair:'changes/v3.2.10/reviews/2026-09-22-release-r5-repair',probeSha256,hashes,currentHashes,before,current},null,2));
} finally {fs.rmSync(root,{recursive:true,force:true});}
