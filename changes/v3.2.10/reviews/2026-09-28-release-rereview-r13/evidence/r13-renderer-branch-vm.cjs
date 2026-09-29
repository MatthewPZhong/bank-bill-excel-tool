'use strict';
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path'),assert=require('node:assert/strict');
const cases=JSON.parse(fs.readFileSync(process.argv[2]||path.join(__dirname,'r13-renderer-conditional-realconfig.json'),'utf8'));
async function main(){const results=[];
for(const item of cases)for(const hasEnum of [false,true]){
 let input;let ipcReads=0;
 const window={desktopApi:{outsideScope(){return true;},app:{async getInfo(){ipcReads++;return {version:'3.2.10',backgroundConfig:{},hasEnum};}}},BankStatementController:{createBankStatementController(value){input=value;}}};
 const same=await vm.runInNewContext(item.source,{window});
 const unsafe=item.name==='conditional-call-skipped'&&!hasEnum;
 assert.equal(same,unsafe);assert.equal(typeof input.api.outsideScope==='function',unsafe);
 results.push({name:item.name,hasEnum,source:item.source,ipcReads,same,apiKeys:Object.keys(input.api),extraCallable:typeof input.api.outsideScope==='function',extraResult:input.api.outsideScope?.()});
}
console.log(JSON.stringify(results,null,2));}
main().catch(error=>{console.error(error.stack);process.exitCode=1;});
