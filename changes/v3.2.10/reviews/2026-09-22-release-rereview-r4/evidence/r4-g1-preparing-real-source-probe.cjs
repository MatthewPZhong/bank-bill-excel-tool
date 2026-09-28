const fs=require('node:fs');const path=require('node:path');const os=require('node:os');
const repo=process.cwd();const {scan}=require(path.join(repo,'scripts/architecture/scan'));const {evaluateRules}=require(path.join(repo,'scripts/architecture/rules'));const {executionScopes}=require(path.join(repo,'scripts/architecture/contracts'));
const config=JSON.parse(fs.readFileSync(path.join(repo,'architecture/boundaries.json')));const boundary=config.boundaries.find(b=>b.id==='publication-recovery-entry');const selected={...config,boundaries:[boundary]};const allowlist=JSON.parse(fs.readFileSync(path.join(repo,'architecture/legacy-allowlist.json')));
const root=fs.mkdtempSync(path.join(os.tmpdir(),'r4-g1-real-source-'));
fs.cpSync(path.join(repo,'src'),path.join(root,'src'),{recursive:true});fs.copyFileSync(path.join(repo,'index.html'),path.join(root,'index.html'));fs.copyFileSync(path.join(repo,'package.json'),path.join(root,'package.json'));for(const file of new Set(config.generatedModules.map(g=>g.generator))){fs.mkdirSync(path.dirname(path.join(root,file)),{recursive:true});fs.copyFileSync(path.join(repo,file),path.join(root,file));}
for(const file of boundary.activationEvidence){const target=path.join(root,file);fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(path.join(repo,file),target);}
const raw='src/main-process/toolbox-output-publication.js';const target=path.join(root,raw);const original=fs.readFileSync(target,'utf8');const needle='function prepareToolboxPublication(options = {}) {';
if(!original.includes(needle))throw Error('prepare function not found');
const injected='  [options.entry].reduce(recoverPreparingIntent, options.runtime);';
fs.writeFileSync(target,original.replace(needle,needle+'\n'+injected));
const scanned=scan(root,config);const result=evaluateRules(scanned,selected,allowlist,{root});
const allowed=site=>boundary.allowedSites.some(s=>s.rule==='ARCH-PUBLICATION-RECOVERY-ENTRY'&&s.from===site.from&&s.functionPath===site.functionPath&&s.callee===(site.callee||site.method)&&s.evidenceId===site.evidenceId);
const reached=executionScopes(scanned,boundary.protectedScopes,{skipSite:allowed});
const site=scanned.sites.find(s=>s.from===raw&&s.functionPath==='prepareToolboxPublication'&&s.method==='reduce');
console.log(JSON.stringify({boundaryState:boundary.state,injected,coverage:scanned.coverage,violations:result.violations,activeBoundaries:result.activeBoundaries,callbackCall:site&&{line:site.line,column:site.column,callee:site.callee,method:site.method,targets:reached.calledTargets(site).map(t=>({path:t.analysis.from,functionPath:t.node&&t.analysis.functionPath(t.node)}))},recoveryScopeReached:reached.scopes.filter(s=>s.path===raw&&s.functionPath==='recoverPreparingIntent'),nestedAllowedSites:reached.sites.filter(s=>s.from===raw&&s.functionPath==='recoverPreparingIntent'&&allowed(s)).map(s=>({callee:s.callee,line:s.line,evidenceId:s.evidenceId}))},null,2));
fs.rmSync(root,{recursive:true,force:true});
