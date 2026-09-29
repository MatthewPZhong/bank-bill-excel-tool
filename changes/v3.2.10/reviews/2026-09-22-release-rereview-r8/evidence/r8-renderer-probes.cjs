'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const repo='/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10';
const root=process.env.RENDERER_SCANNER_ROOT||repo;
const {scan}=require(path.join(root,'scripts/architecture/scan'));
const {evaluateRules}=require(path.join(root,'scripts/architecture/rules'));
const bank=require(path.join(repo,'architecture/boundaries.json')).boundaries.find(b=>b.id==='renderer-bank-statement');
const mount=api=>`window.BankStatementController.createBankStatementController({api:${api}});`;
const original=fs.readFileSync(path.join(repo,'changes/v3.2.10/reviews/2026-09-22-release-rereview-r7/evidence/r7-renderer-neighbors-current.jsonl'),'utf8').trim().split('\n').map(JSON.parse).filter(x=>x.name.startsWith('default-'));
const cases=original.map(x=>({name:'original-'+x.name,safe:x.safe,source:x.source+'shared===alias;'}));
for(const [name,safe,setup,api] of [
 ['previous-parameter-shared',false,'const shared={run(){}};function select(first,api=first){return api;}const alias=select(shared);alias.outsideScope=window.desktopApi.outsideScope;','shared'],
 ['previous-parameter-other',true,'const shared={run(){}};const other={run(){}};function select(first,api=first){return api;}const alias=select(other);alias.outsideScope=window.desktopApi.outsideScope;','shared'],
 ['default-container-after',false,'const envelope={api:{run(){}}};function select({api}=envelope){return api;}envelope.api={run(){}};const alias=select();alias.outsideScope=window.desktopApi.outsideScope;','envelope.api'],
 ['default-container-before',true,'const envelope={api:{run(){}}};function select({api}=envelope){return api;}const alias=select();envelope.api={run(){}};alias.outsideScope=window.desktopApi.outsideScope;','envelope.api']
])cases.push({name,safe,source:setup+mount(api)+`${api}===alias;`});
for(const [name,field,safe] of [['ipc-missing-field','api',false],['ipc-provided-field','backgroundConfig',true]]){
 const source='const shared={run(){}};function select(api=shared){return api;}async function run(){const info=await window.desktopApi.app.getInfo();const alias=select(info.'+field+');alias.outsideScope=window.desktopApi.outsideScope;'+mount('shared')+'return alias===shared;}run();';
 cases.push({name,safe,ipc:true,source});
}
async function main(){for(const {name,safe,ipc,source} of cases){
 const dir=fs.mkdtempSync('/tmp/r8-renderer-fixture-');fs.mkdirSync(path.join(dir,'src'));fs.writeFileSync(path.join(dir,'src/shell.js'),source);
 if(ipc)fs.writeFileSync(path.join(dir,'src/preload.js'),"const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('desktopApi',{app:{getInfo:()=>ipcRenderer.invoke('app:get-info')}});");
 const config={schemaVersion:1,factBaseline:'1'.repeat(40),bootstrap:{factBaseline:'1'.repeat(40),mode:'first-introduction'},boundaries:[{...bank,state:'pending'}],generatedModules:[],dynamicLoads:[],policyChanges:[]};
 let input;let reads=0;const window={desktopApi:{outsideScope(){return true;},app:{async getInfo(){reads++;return {version:'3.2.10',backgroundConfig:{}};}}},BankStatementController:{createBankStatementController(value){input=value;}}};
 const same=await vm.runInNewContext(source,{window});
 const runtime={same,keys:Object.keys(input.api),extraCallable:typeof input.api.outsideScope==='function',extraResult:input.api.outsideScope?.(),ipcReads:reads};
 const evaluated=evaluateRules(scan(dir,config),config,{schemaVersion:1,factBaseline:config.factBaseline,exceptions:[]},{root:dir});
 console.log(JSON.stringify({name,safe,source,runtime,violations:evaluated.violations}));fs.rmSync(dir,{recursive:true,force:true});
}}
main().catch(e=>{console.error(e.stack);process.exitCode=1;});
