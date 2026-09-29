'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm');
const repo=process.cwd(),toolsRoot=process.env.R9_ARRAY_TOOLS_ROOT||repo;
const {scan,parse,createAnalysis}=require(path.join(toolsRoot,'scripts/architecture/scan'));
const {evaluateRules}=require(path.join(toolsRoot,'scripts/architecture/rules'));
const actual=JSON.parse(fs.readFileSync(path.join(repo,'architecture/boundaries.json')));
const mode=process.argv[2]||'minimal';const cases=require(path.join(__dirname,'r9-array-neighbor-cases.cjs'));
function runtime(source,api){let input;const window={desktopApi:{outsideScope(){return true;}},BankStatementController:{createBankStatementController(value){input=value;}}};const ctx=vm.createContext({window});vm.runInContext(source,ctx);return {keys:Object.keys(input.api),extraCallable:typeof input.api.outsideScope==='function',extraResult:input.api.outsideScope?.(),same:vm.runInContext(`${api}===alias`,ctx)};}
const cfg={...actual,boundaries:actual.boundaries.filter(b=>b.id.startsWith('renderer-'))};
const allow=JSON.parse(fs.readFileSync(path.join(repo,'architecture/legacy-allowlist.json')));
let base,text,baseline;
if(mode==='real') {base=scan(repo,cfg);text=fs.readFileSync(path.join(repo,'src/renderer.js'),'utf8');baseline=evaluateRules(base,cfg,allow,{root:repo});console.error(JSON.stringify({phase:'baseline',at:new Date().toISOString(),boundaries:cfg.boundaries.length,violations:baseline.violations.length}));}
const results=[];
for(const item of cases){const source=item.setup+`window.BankStatementController.createBankStatementController({api:${item.api}});`;let evaluated,coverage;
 if(mode==='real'){
  const added='\n{\n'+source+'\n}\n';const nextText=text+added;const analysis=createAnalysis(parse(nextText,'src/renderer.js'),'src/renderer.js',repo);
  const next={...base,analyses:new Map(base.analyses),sites:[...base.sites]};next.analyses.set('src/renderer.js',analysis);
  for(const node of analysis.nodes){if(node.start<text.length||node.type!=='CallExpression')continue;const ref=analysis.describe(node.callee);next.sites.push({from:'src/renderer.js',line:node.loc.start.line,column:node.loc.start.column,functionPath:analysis.functionPath(node),type:'call',reference:ref,chain:ref.chain||[],args:node.arguments.map(a=>analysis.describe(a)),callStart:node.start});}
  evaluated=evaluateRules(next,cfg,allow,{root:repo});coverage=base.coverage;
 } else {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'r9-array-minimal-'));try{fs.mkdirSync(path.join(root,'src'));fs.writeFileSync(path.join(root,'src/shell.js'),source);const bank=actual.boundaries.find(b=>b.id==='renderer-bank-statement');const config={...actual,boundaries:[{...bank,state:'pending'}],generatedModules:[],dynamicLoads:[],policyChanges:[]};const scanned=scan(root,config);evaluated=evaluateRules(scanned,config,{schemaVersion:1,factBaseline:config.factBaseline,exceptions:[]},{root});coverage=scanned.coverage;}finally{fs.rmSync(root,{recursive:true,force:true});}
 }
 results.push({name:item.name,safe:item.safe,source,runtime:runtime(source,item.api),violations:evaluated.violations,coverage});console.error(JSON.stringify({phase:item.name,at:new Date().toISOString(),violations:evaluated.violations.length}));
}
console.log(JSON.stringify({mode,boundaryCount:mode==='real'?cfg.boundaries.length:1,boundaries:mode==='real'?cfg.boundaries.map(b=>({id:b.id,state:b.state})):[],baseline:baseline?{violations:baseline.violations,coverage:base.coverage}:null,results},null,2));
