const fs=require('node:fs');const os=require('node:os');const path=require('node:path');const vm=require('node:vm');
const repo=process.cwd();const {scan}=require(path.join(repo,'scripts/architecture/scan'));const {evaluateRules}=require(path.join(repo,'scripts/architecture/rules'));
const actual=JSON.parse(fs.readFileSync(path.join(repo,'architecture/boundaries.json')));const boundary=actual.boundaries.find(b=>b.id==='publication-recovery-entry');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'r5-g1-native-data-'));const raw='src/main-process/toolbox-output-publication.js';
for(const file of [...boundary.entrypoints,...boundary.activationEvidence,...boundary.protectedScopes.map(s=>s.path)]){fs.mkdirSync(path.dirname(path.join(root,file)),{recursive:true});fs.writeFileSync(path.join(root,file),'');}
fs.writeFileSync(path.join(root,'src/main.js'),"require('./main-process/publication-recovery/coordinator');\n");
const config={...actual,boundaries:[boundary],dynamicLoads:[],generatedModules:[],policyChanges:[]};const allowlist={schemaVersion:1,factBaseline:actual.factBaseline,exceptions:[]};
const variants={
 native_includes:'const handlers=[recoverPreparingIntent];return handlers.includes(recoverPreparingIntent);',
 native_indexof:'const handlers=[recoverPreparingIntent];return handlers.indexOf(recoverPreparingIntent);',
 source_helper_compare:'function has(list,fn){return list[0]===fn;}return has([recoverPreparingIntent],recoverPreparingIntent);',
 reduce_execution:'return [entry].reduce(recoverPreparingIntent,runtime);'
};
fs.writeFileSync(path.join(root,'src/main-process/invoke-helper.js'),'exports.invoke=(fn,r,e)=>fn(r,e,{});');
const outputs=[];
for(const [name,body] of Object.entries(variants)){
 const source=`function recoverPreparingIntent(runtime,entry,options){return runtime.remove(entry);}\nfunction prepareToolboxPublication(runtime,entry){${body}}\nmodule.exports={prepareToolboxPublication};`;
 fs.writeFileSync(path.join(root,raw),source);const scanned=scan(root,config);const result=evaluateRules(scanned,config,allowlist,{root});
 let writes=0;const sandbox={module:{exports:{}},require:()=>({invoke:(fn,r,e)=>fn(r,e,{})})};vm.runInNewContext(source,sandbox);const value=sandbox.module.exports.prepareToolboxPublication({remove(){writes++;}},{});
 outputs.push({name,value,writes,violations:result.violations,parseErrors:scanned.parseErrors.length,unresolved:scanned.unresolved.length});
}
console.log(JSON.stringify({boundaryState:boundary.state,outputs},null,2));fs.rmSync(root,{recursive:true,force:true});
