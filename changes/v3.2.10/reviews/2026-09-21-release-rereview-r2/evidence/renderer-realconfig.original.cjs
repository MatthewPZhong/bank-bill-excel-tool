'use strict';
const fs=require('fs'),path=require('path'),cp=require('child_process'),vm=require('vm');
const root='/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10';
const suites=[['HEAD','/tmp/release-v3210-renderer-head-scanner'],['WORKTREE',root]];
const sources=[['bound_factory',`function provideBoundReviewApi(api){return api;}const reviewBound=provideBoundReviewApi.bind(null,window.desktopApi);window.BankStatementController.createBankStatementController({api:reviewBound({run(){}})});`],['factory_alias',`function provideReviewApi(){const api={run(){}};const alias=api;alias.outsideScope=window.desktopApi.outsideScope;return api;}window.BankStatementController.createBankStatementController({api:provideReviewApi()});`],['spread_alias',`const reviewApi={run(){}};const reviewAlias=reviewApi;reviewAlias.outsideScope=window.desktopApi.outsideScope;window.BankStatementController.createBankStatementController({api:{...reviewApi}});`],['initial_info_nested',`window.StatementController.createStatementController({initialInfo:{api:window.desktopApi}});`]];
const results=[];
for(const [label,toolsRoot] of suites){
 const {scan,parse,createAnalysis}=require(path.join(toolsRoot,'scripts/architecture/scan'));const {evaluateRules}=require(path.join(toolsRoot,'scripts/architecture/rules'));
 const cfg=JSON.parse(label==='HEAD'?cp.execFileSync('git',['show','HEAD:architecture/boundaries.json'],{cwd:root,encoding:'utf8'}):fs.readFileSync(path.join(root,'architecture/boundaries.json')));
 cfg.boundaries=cfg.boundaries.filter(b=>b.id.startsWith('renderer-'));
 const allow=JSON.parse(label==='HEAD'?cp.execFileSync('git',['show','HEAD:architecture/legacy-allowlist.json'],{cwd:root,encoding:'utf8'}):fs.readFileSync(path.join(root,'architecture/legacy-allowlist.json')));
 const base=scan(root,cfg);const text=fs.readFileSync(path.join(root,'src/renderer.js'),'utf8');const baseline=evaluateRules(base,cfg,allow,{root});
 for(const [name,source] of sources){
  const nextText=text+'\n'+source;const analysis=createAnalysis(parse(nextText,'src/renderer.js'),'src/renderer.js',root);
  const next={...base,analyses:new Map(base.analyses),sites:[...base.sites]};next.analyses.set('src/renderer.js',analysis);
  for(const node of analysis.nodes){if(node.start<text.length||node.type!=='CallExpression')continue;const ref=analysis.describe(node.callee);next.sites.push({from:'src/renderer.js',line:node.loc.start.line,column:node.loc.start.column,functionPath:analysis.functionPath(node),type:'call',reference:ref,chain:ref.chain||[],args:node.arguments.map(a=>analysis.describe(a))});}
  const evaluated=evaluateRules(next,cfg,allow,{root});let received;const desktopApi={outsideScope(){return true;}};const ctx={window:{desktopApi,BankStatementController:{createBankStatementController(input){received=input}},StatementController:{createStatementController(input){received=input}}}};vm.runInNewContext(source,ctx);
  results.push({scanner:label,name,source,baseViolations:baseline.violations.length,probeViolations:evaluated.violations.filter(v=>v.from==='src/renderer.js'&&v.line>text.split('\n').length-1),runtime:{keys:Object.keys(received),apiKeys:Object.keys(received.api||{}),whole:received.initialInfo?.api===desktopApi,extraCallable:typeof received.api?.outsideScope==='function'}});
 }
}
console.log(JSON.stringify(results,null,2));
