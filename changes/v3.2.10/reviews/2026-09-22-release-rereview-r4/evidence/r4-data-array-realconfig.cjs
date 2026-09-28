'use strict';
const fs=require('fs'),path=require('path');
const root='/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10';
const {scan,parse,createAnalysis}=require(path.join(root,'scripts/architecture/scan'));const {evaluateRules}=require(path.join(root,'scripts/architecture/rules'));
const cfg=JSON.parse(fs.readFileSync(path.join(root,'architecture/boundaries.json')));cfg.boundaries=cfg.boundaries.filter(b=>b.id.startsWith('renderer-'));
const allow=JSON.parse(fs.readFileSync(path.join(root,'architecture/legacy-allowlist.json')));
const base=scan(root,cfg),text=fs.readFileSync(path.join(root,'src/renderer.js'),'utf8');const baseline=evaluateRules(base,cfg,allow,{root});
const cases=[
 ['array_parameter_api','function r4Mount(values){window.StatementController.createStatementController({initialInfo:[...values]});}r4Mount([window.desktopApi]);'],
 ['array_factory_api','function r4Values(){return [window.desktopApi];}window.StatementController.createStatementController({initialInfo:[...r4Values()]});']
];
const results=[];for(const [name,source] of cases){const analysis=createAnalysis(parse(text+'\n'+source,'src/renderer.js'),'src/renderer.js',root);const next={...base,analyses:new Map(base.analyses),sites:[...base.sites]};next.analyses.set('src/renderer.js',analysis);for(const node of analysis.nodes){if(node.start<text.length||node.type!=='CallExpression')continue;const ref=analysis.describe(node.callee);next.sites.push({from:'src/renderer.js',line:node.loc.start.line,column:node.loc.start.column,functionPath:analysis.functionPath(node),type:'call',reference:ref,chain:ref.chain||[],args:node.arguments.map(a=>analysis.describe(a))});}const result=evaluateRules(next,cfg,allow,{root});results.push({name,source,violations:result.violations});}console.log(JSON.stringify({baselineViolations:baseline.violations,results},null,2));
