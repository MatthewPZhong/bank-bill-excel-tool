'use strict';
const fs=require('node:fs'),cp=require('node:child_process'),path=require('node:path');
const start=Date.now();const probe=path.join(__dirname,'r13-array-raw-helper-probe.cjs');
const child=cp.spawnSync(process.execPath,[probe,'minimal'],{cwd:process.cwd(),encoding:'utf8',timeout:20000});
fs.writeFileSync(path.join(__dirname,'r13-array-raw-helper.stdout'),child.stdout||'');
fs.writeFileSync(path.join(__dirname,'r13-array-raw-helper.stderr'),child.stderr||'');
fs.writeFileSync(path.join(__dirname,'r13-array-raw-helper-exit.json'),JSON.stringify({cmd:[process.execPath,probe,'minimal'],cwd:process.cwd(),status:child.status,signal:child.signal,error:child.error?.message,elapsedMs:Date.now()-start},null,2));
console.log(JSON.stringify({status:child.status,signal:child.signal,error:child.error?.message}));
