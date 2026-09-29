const fs=require('node:fs');const os=require('node:os');const path=require('node:path');const vm=require('node:vm');
const repo=process.cwd();const {scan}=require(path.join(repo,'scripts/architecture/scan'));const {evaluateRules}=require(path.join(repo,'scripts/architecture/rules'));
const actual=JSON.parse(fs.readFileSync(path.join(repo,'architecture/boundaries.json')));const boundary=actual.boundaries.find(b=>b.id==='publication-recovery-entry');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'r7-g1-neighbor-'));const raw='src/main-process/toolbox-output-publication.js';
for(const file of [...boundary.entrypoints,...boundary.activationEvidence,...boundary.protectedScopes.map(s=>s.path)]){fs.mkdirSync(path.dirname(path.join(root,file)),{recursive:true});fs.writeFileSync(path.join(root,file),'');}
fs.writeFileSync(path.join(root,'src/main.js'),"require('./main-process/publication-recovery/coordinator');\n");
const config={...actual,boundaries:[boundary],dynamicLoads:[],generatedModules:[],policyChanges:[]};const allowlist={schemaVersion:1,factBaseline:actual.factBaseline,exceptions:[]};
const variants={
 safe_includes:'const handlers=[recoverPreparingIntent];return handlers.includes(recoverPreparingIntent);',
 safe_last_indexof:'const handlers=[recoverPreparingIntent];return handlers.lastIndexOf(recoverPreparingIntent);',
 direct_array_override:'const handlers=[];handlers.includes=fn=>fn(runtime,entry);return handlers.includes(recoverPreparingIntent);',
 projected_array_override:'function change(box){box.handlers.includes=fn=>fn(runtime,entry);}const handlers=[];change({handlers});return handlers.includes(recoverPreparingIntent);',
 destructured_array_override:'function change({handlers}){handlers.includes=fn=>fn(runtime,entry);}const handlers=[];change({handlers});return handlers.includes(recoverPreparingIntent);',
 direct_prototype_override:'Array.prototype.includes=fn=>fn(runtime,entry);return [].includes(recoverPreparingIntent);',
 parameter_prototype_override:'function change(proto){proto.includes=fn=>fn(runtime,entry);}change(Array.prototype);return [].includes(recoverPreparingIntent);',
 projected_safe_compare:'function contains(box,fn){return box.handlers.includes(fn);}return contains({handlers:[recoverPreparingIntent]},recoverPreparingIntent);'
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
