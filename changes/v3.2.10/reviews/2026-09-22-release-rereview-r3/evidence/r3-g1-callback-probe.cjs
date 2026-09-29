const fs=require('node:fs');const os=require('node:os');const path=require('node:path');const vm=require('node:vm');
const repo=process.cwd();const {scan}=require(path.join(repo,'scripts/architecture/scan'));const {evaluateRules}=require(path.join(repo,'scripts/architecture/rules'));
const actual=JSON.parse(fs.readFileSync(path.join(repo,'architecture/boundaries.json')));const boundary=actual.boundaries.find(b=>b.id==='publication-recovery-entry');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'r3-g1-callback-'));const raw='src/main-process/toolbox-output-publication.js';
for(const file of [...boundary.entrypoints,...boundary.activationEvidence,...boundary.protectedScopes.map(s=>s.path)]){fs.mkdirSync(path.dirname(path.join(root,file)),{recursive:true});fs.writeFileSync(path.join(root,file),'');}
fs.writeFileSync(path.join(root,'src/main.js'),"require('./main-process/publication-recovery/coordinator');\n");
const config={...actual,boundaries:[boundary],dynamicLoads:[],generatedModules:[],policyChanges:[]};const allowlist={schemaVersion:1,factBaseline:actual.factBaseline,exceptions:[]};
const variants={
 direct:'return recoverOneJournal(runtime,entry,{});',
 alias:'const run=recoverOneJournal; return run(runtime,entry,{});',
 bind:'const run=recoverOneJournal.bind(null,runtime,entry,{}); return run();',
 call:'return recoverOneJournal.call(null,runtime,entry,{});',
 apply:'return recoverOneJournal.apply(null,[runtime,entry,{}]);',
 object:'const o={run:recoverOneJournal}; return o.run(runtime,entry,{});',
 array:'const list=[recoverOneJournal]; return list[0](runtime,entry,{});',
 helper_direct:'function helper(){return recoverOneJournal(runtime,entry,{});} return helper();',
 helper_parameter:'function invoke(fn,r,e){return fn(r,e,{});} return invoke(recoverOneJournal,runtime,entry);',
 identity_return:'function identity(fn){return fn;} const run=identity(recoverOneJournal); return run(runtime,entry,{});',
 static_factory:'function factory(){return recoverOneJournal;} return factory()(runtime,entry,{});',
 external_helper:"const {invoke}=require('./invoke-helper'); return invoke(recoverOneJournal,runtime,entry);"
};
fs.writeFileSync(path.join(root,'src/main-process/invoke-helper.js'),'exports.invoke=(fn,r,e)=>fn(r,e,{});');
const outputs=[];
for(const [name,body] of Object.entries(variants)){
 const source=`function recoverOneJournal(runtime,entry,options){return runtime.remove(entry);}\nfunction prepareToolboxPublication(runtime,entry){${body}}\nmodule.exports={prepareToolboxPublication};`;
 fs.writeFileSync(path.join(root,raw),source);const scanned=scan(root,config);const result=evaluateRules(scanned,config,allowlist,{root});
 let writes=0;const sandbox={module:{exports:{}},require:()=>({invoke:(fn,r,e)=>fn(r,e,{})})};vm.runInNewContext(source,sandbox);sandbox.module.exports.prepareToolboxPublication({remove(){writes++;}},{});
 outputs.push({name,writes,violations:result.violations,parseErrors:scanned.parseErrors.length,unresolved:scanned.unresolved.length});
}
console.log(JSON.stringify({boundaryState:boundary.state,outputs},null,2));fs.rmSync(root,{recursive:true,force:true});
