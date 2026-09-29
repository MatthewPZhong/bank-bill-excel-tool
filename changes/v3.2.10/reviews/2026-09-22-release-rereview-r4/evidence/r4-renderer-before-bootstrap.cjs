'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const repo=process.argv[2]||'/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10';
const out=fs.mkdtempSync(path.join(os.tmpdir(),'r4-renderer-before-tools-'));
const relative='scripts/architecture';
const saved=path.join(repo,'changes/v3.2.10/reviews/2026-09-22-release-r3-repair/before',relative);
fs.mkdirSync(path.join(out,relative),{recursive:true});
for(const file of ['scan.js','rules.js','contracts.js','renderer-contracts.js'])fs.copyFileSync(path.join(saved,file),path.join(out,relative,file));
// schema.js is unchanged by this repair and is absent from the archived before snapshot.
fs.copyFileSync(path.join(repo,relative,'schema.js'),path.join(out,relative,'schema.js'));
fs.symlinkSync(path.join(repo,'node_modules'),path.join(out,'node_modules'),'dir');
process.stdout.write(out+'\n');
