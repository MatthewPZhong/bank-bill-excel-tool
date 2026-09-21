'use strict';
// 审查 fixture：成功退出表示已复现本轮缺陷及控制组，不表示门禁实现通过审查。
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm'),assert=require('node:assert/strict');
const tooling=process.env.G8_NEW_ROOT||path.join(__dirname,'snapshot');
const {scan}=require(path.join(tooling,'scripts/architecture/scan'));
const {evaluateRules}=require(path.join(tooling,'scripts/architecture/rules'));
const {callableOrigins}=require(path.join(tooling,'scripts/architecture/contracts'));
const policy=require(path.join(tooling,'architecture/boundaries.json'));
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'g8-r5-identity-'));
const imported="const {settlePositionArchiveResult}=require('./main-process/position-reconciliation/operation-lifecycle');";
const factory="function makeSettlement(){return function performSettlement(){calls.push('settled');};}const settlePositionArchiveResult=makeSettlement();";
const simple="function settlePositionArchiveResult(){calls.push('settled');}";
const service="function createService(){return {settle:settlePositionArchiveResult};}const service=createService();function runArchiveAwareOperation(){service.settle();}";
const direct='function runArchiveAwareOperation(){settlePositionArchiveResult();}';
const wrapper='function createService(){return {settle(){settlePositionArchiveResult();}};}const service=createService();function runArchiveAwareOperation(){service.settle();}';
const cases=[
 ['r4-original-closed',simple+service,true,['settled']],
 ['imported-reference-gap',imported+service,false,['settled']],
 ['imported-direct-control',imported+direct,true,['settled']],
 ['imported-wrapper-control',imported+wrapper,true,['settled']],
 ['factory-binding-direct-gap',factory+direct,false,['settled']],
 ['factory-binding-service-gap',factory+service,false,['settled']],
 ['named-expression-control',"const settlePositionArchiveResult=function performSettlement(){calls.push('settled');};"+direct,true,['settled']],
 ['pure-factory-control',"function makePure(){return function performPure(){calls.push('pure');};}const executePure=makePure();function runArchiveAwareOperation(){executePure();}",false,['pure']],
 ['pure-service-control',imported+"function createService(){return {settle:settlePositionArchiveResult,execute(){calls.push('pure');}};}const service=createService();function runArchiveAwareOperation(){service.execute();}",false,['pure']]
];
const results=[];
for(const[name,source,rejected,expectedCalls]of cases){
 const root=path.join(temporary,name);fs.mkdirSync(path.join(root,'src/main-process/position-reconciliation'),{recursive:true});
 fs.writeFileSync(path.join(root,'src/main.js'),source);fs.writeFileSync(path.join(root,'src/main-process/position-reconciliation/operation-lifecycle.js'),'exports.settlePositionArchiveResult=()=>{};');
 const calls=[];vm.runInNewContext(source+';runArchiveAwareOperation();',{calls,require:()=>({settlePositionArchiveResult:()=>{calls.push('settled');}})});assert.deepEqual(calls,expectedCalls);
 const config={...policy,boundaries:policy.boundaries.filter(b=>b.id==='business-task-adapters'),generatedModules:[],dynamicLoads:[],policyChanges:[]};
 const scanned=scan(root,config);const result=evaluateRules(scanned,config,{schemaVersion:1,factBaseline:policy.factBaseline,exceptions:[]},{root});
 const site=scanned.sites.find(s=>s.type==='call'&&s.functionPath==='runArchiveAwareOperation');const origins=callableOrigins(site.reference,scanned.analyses.get('src/main.js'));
 assert.equal(result.violations.some(v=>v.rule==='ARCH-TASK-ADAPTER'),rejected,name);
 if(name.endsWith('-gap')){assert.deepEqual(result.violations,[]);assert.deepEqual(scanned.dynamicSites,[]);}
 results.push({name,source,runtimeCalls:calls,violations:result.violations,dynamicSites:scanned.dynamicSites,origins});
}
console.log(JSON.stringify({meaning:'全部断言通过表示缺陷和控制组已复现',tooling,temporary,results},null,2));
