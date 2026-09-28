'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const repo=process.argv[2]||'/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10';
const out=fs.mkdtempSync('/tmp/r15-renderer-before-tools-');
const rel='scripts/architecture';
const saved=path.join(repo,'changes/v3.2.10/reviews/2026-09-28-release-r14-repair/before',rel);
const manifest=JSON.parse(fs.readFileSync(path.join(repo,'changes/v3.2.10/reviews/2026-09-28-release-r14-repair/input-manifest.json')));
fs.mkdirSync(path.join(out,rel),{recursive:true});
const files={};
for(const f of ['scan.js','rules.js','contracts.js','renderer-contracts.js','schema.js']){
 const before=path.join(saved,f);const source=fs.existsSync(before)?before:path.join(repo,rel,f);
 fs.copyFileSync(source,path.join(out,rel,f));
 const digest=crypto.createHash('sha256').update(fs.readFileSync(path.join(out,rel,f))).digest('hex');
 const expected=manifest.sha256[path.join(rel,f)];assert.equal(digest,expected,f);
 files[f]={source,sha256:digest,expected,match:true};
}
fs.symlinkSync(path.join(repo,'node_modules'),path.join(out,'node_modules'),'dir');
fs.writeFileSync('/tmp/r15-renderer-before-inputs.json',JSON.stringify({root:out,files},null,2));
process.stdout.write(out+'\n');
