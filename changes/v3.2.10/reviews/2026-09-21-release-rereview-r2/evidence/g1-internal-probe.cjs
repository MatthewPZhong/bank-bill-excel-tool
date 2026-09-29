const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const repo=process.cwd();
const {scan}=require(path.join(repo,'scripts/architecture/scan'));
const {evaluateRules}=require(path.join(repo,'scripts/architecture/rules'));
const actual=JSON.parse(fs.readFileSync(path.join(repo,'architecture/boundaries.json')));
const original=actual.boundaries.find(b=>b.id==='publication-recovery-entry');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'g1-internal-recovery-probe-'));
const raw='src/main-process/toolbox-output-publication.js';
fs.mkdirSync(path.dirname(path.join(root,raw)),{recursive:true});
const boundary=structuredClone(original);
for (const file of [...boundary.entrypoints, ...boundary.activationEvidence, ...boundary.protectedScopes.map(s=>s.path)]) { fs.mkdirSync(path.dirname(path.join(root,file)),{recursive:true}); fs.writeFileSync(path.join(root,file),''); }
fs.writeFileSync(path.join(root,'src/main.js'),"require('./main-process/publication-recovery/coordinator');\n");
const config={...actual,boundaries:[boundary],dynamicLoads:[],generatedModules:[],policyChanges:[]};
const allowlist={schemaVersion:1,factBaseline:actual.factBaseline,exceptions:[]};
const outputs=[];
for (const callee of ['recoverPendingInternal','recoverOneJournal','recoverPreparingIntent','recoverFinalizingIntent']) {
  fs.writeFileSync(path.join(root,raw),`function ${callee}(runtime, entry, options) { return runtime.remove(entry); }\nfunction prepareToolboxPublication(runtime, entry) { return ${callee}(runtime, entry, {}); }\nmodule.exports={prepareToolboxPublication};\n`);
  const scanned=scan(root,config);const result=evaluateRules(scanned,config,allowlist,{root});
  outputs.push({callee,violations:result.violations,parseErrors:scanned.parseErrors.length,unresolved:scanned.unresolved.length});
}
console.log(JSON.stringify({boundaryState:boundary.state,configurationRestrictedApis:original.restrictedApis,outputs},null,2));
fs.rmSync(root,{recursive:true,force:true});
