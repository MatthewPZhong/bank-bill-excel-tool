'use strict';
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const root='/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10';
const cases=fs.readFileSync(path.join(__dirname,'r14-renderer-probes-current.jsonl'),'utf8').trim().split('\n').map(JSON.parse).filter(item=>['do-break-before-write','do-write-before-break-safe'].includes(item.name));
const results=cases.map(item=>{
 const argv=[path.join(root,'node_modules/eslint/bin/eslint.js'),'--stdin','--stdin-filename','src/renderer.js','--format','json'];
 const result=cp.spawnSync(process.execPath,argv,{cwd:root,input:item.source,encoding:'utf8'});
 return {name:item.name,command:[process.execPath,...argv],cwd:root,status:result.status,stderr:result.stderr,output:JSON.parse(result.stdout||'null')};
});console.log(JSON.stringify(results,null,2));
