'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const repo=process.cwd();const before=JSON.parse(fs.readFileSync(path.join(repo,'changes/v3.2.10/reviews/2026-09-22-release-r8-repair/input-manifest.json'))).sha256;const current=JSON.parse(fs.readFileSync(path.join(repo,'changes/v3.2.10/reviews/2026-09-22-release-rereview-r9/evidence/input-manifest.json'))).sha256;
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const sourcePaths=Object.keys(current).filter(p=>p.startsWith('src/')||p==='index.html');const sourceMismatches=sourcePaths.filter(p=>hash(fs.readFileSync(path.join(repo,p)))!==current[p]||current[p]!==before[p]);
const scriptPaths=['r9-array-cases.cjs','r9-array-probe.cjs','r9-array-neighbor-cases.cjs','r9-array-neighbor-probe.cjs','r9-array-selected-cases.cjs','r9-array-selected-probe.cjs','r9-array-compare.cjs','r9-array-input-hashes.cjs'];
console.log(JSON.stringify({sourceFileCount:sourcePaths.length,sourceMismatches,renderer:{before:before['src/renderer.js'],current:current['src/renderer.js']},scripts:scriptPaths.map(name=>({name,sha256:hash(fs.readFileSync(path.join(__dirname,name)))}))},null,2));if(sourceMismatches.length)process.exitCode=1;
