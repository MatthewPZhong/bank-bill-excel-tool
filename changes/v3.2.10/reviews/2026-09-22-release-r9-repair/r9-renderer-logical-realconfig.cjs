'use strict';
const fs=require('fs'),path=require('path'),cp=require('child_process'),vm=require('vm');
const root='/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10';
const suites=[['WORKTREE',root]];
const sources=[["logical-and-missing", "const reviewShared={run(){}};const reviewProvided={run(){}};function selectReviewApi(api=reviewShared){return api;}function forwardReviewApi(api){return api;}async function runReviewScenario(){const reviewInfo=await window.desktopApi.app.getInfo();const reviewOther=selectReviewApi(reviewInfo.api && reviewProvided);reviewOther.outsideScope=window.desktopApi.outsideScope;window.BankStatementController.createBankStatementController({api:reviewShared});return reviewOther===reviewShared;}runReviewScenario();"], ["logical-and-provided-safe", "const reviewShared={run(){}};const reviewProvided={run(){}};function selectReviewApi(api=reviewShared){return api;}function forwardReviewApi(api){return api;}async function runReviewScenario(){const reviewInfo=await window.desktopApi.app.getInfo();const reviewOther=selectReviewApi(true && reviewProvided);reviewOther.outsideScope=window.desktopApi.outsideScope;window.BankStatementController.createBankStatementController({api:reviewShared});return reviewOther===reviewShared;}runReviewScenario();"]];
async function main(){const results=[];
for(const [label,toolsRoot] of suites){
 const {scan,parse,createAnalysis}=require(path.join(toolsRoot,'scripts/architecture/scan'));const {evaluateRules}=require(path.join(toolsRoot,'scripts/architecture/rules'));
 const cfg=JSON.parse(label==='HEAD'?cp.execFileSync('git',['show','HEAD:architecture/boundaries.json'],{cwd:root,encoding:'utf8'}):fs.readFileSync(path.join(root,'architecture/boundaries.json')));
 cfg.boundaries=cfg.boundaries.filter(b=>b.id.startsWith('renderer-'));
 const allow=JSON.parse(label==='HEAD'?cp.execFileSync('git',['show','HEAD:architecture/legacy-allowlist.json'],{cwd:root,encoding:'utf8'}):fs.readFileSync(path.join(root,'architecture/legacy-allowlist.json')));
 const base=scan(root,cfg);const text=fs.readFileSync(path.join(root,'src/renderer.js'),'utf8');const baseline=evaluateRules(base,cfg,allow,{root});console.error(JSON.stringify({phase:"baseline",at:new Date().toISOString(),boundaries:cfg.boundaries.length,violations:baseline.violations.length}));
 for(const [name,source] of sources){
  const nextText=text+'\n'+source;const analysis=createAnalysis(parse(nextText,'src/renderer.js'),'src/renderer.js',root);
  const next={...base,analyses:new Map(base.analyses),sites:[...base.sites]};next.analyses.set('src/renderer.js',analysis);
  for(const node of analysis.nodes){if(node.start<text.length||node.type!=='CallExpression')continue;const ref=analysis.describe(node.callee);next.sites.push({from:'src/renderer.js',line:node.loc.start.line,column:node.loc.start.column,functionPath:analysis.functionPath(node),type:'call',reference:ref,chain:ref.chain||[],args:node.arguments.map(a=>analysis.describe(a))});}
  const evaluated=evaluateRules(next,cfg,allow,{root});let received;let ipcReads=0;const desktopApi={outsideScope(){return true;},app:{async getInfo(){ipcReads++;return {version:"3.2.10",backgroundConfig:{}};}}};const ctx={window:{desktopApi,BankStatementController:{createBankStatementController(input){received=input}},StatementController:{createStatementController(input){received=input}}}};const same=await vm.runInNewContext(source,ctx);console.error(JSON.stringify({phase:name,at:new Date().toISOString()}));
  results.push({scanner:label,name,source,baseViolations:baseline.violations.length,probeViolations:evaluated.violations.filter(v=>v.from==='src/renderer.js'&&v.line>text.split('\n').length-1),boundaryCount:cfg.boundaries.length,runtime:{ipcReads,same,keys:Object.keys(received),apiKeys:Object.keys(received.api||{}),whole:received.initialInfo?.api===desktopApi,extraCallable:typeof received.api?.outsideScope==='function',extraResult:received.api?.outsideScope?.()}});
 }
}
console.log(JSON.stringify(results,null,2));

}
main().catch(error=>{console.error(error.stack);process.exitCode=1;});
