'use strict';
const fs=require('node:fs');const path=require('node:path');const os=require('node:os');const crypto=require('node:crypto');
const root=path.resolve(__dirname,'../../../../..');
const inspected=process.env.ARCHITECTURE_PROBE_ROOT||root;
const {scan}=require(path.join(inspected,'scripts/architecture/scan'));
const {evaluateRules}=require(path.join(inspected,'scripts/architecture/rules'));
const sha=file=>crypto.createHash('sha256').update(fs.readFileSync(path.join(inspected,file))).digest('hex');
const reviewed=['scripts/architecture/contracts.js','scripts/architecture/rules.js','scripts/architecture/scan.js','scripts/architecture/renderer-contracts.js'].filter(file=>fs.existsSync(path.join(inspected,file)));
const before=Object.fromEntries(reviewed.map(file=>[file,sha(file)]));
const baseline='1'.repeat(40);
function boundary(rule,extra={}){return {id:'probe',owner:'probe',governance:'G8',state:'pending',rules:[rule],entrypoints:[],allowedLocal:[],allowedExternal:[],requiredConsumers:[],activationEvidence:[],protectedScopes:[],restrictedApis:[],allowedSites:[],compositionEntrypoints:[],globals:[],factory:null,allowedApiFields:{},deprecatedEntrypoints:[],directory:null,...extra};}
const probes=[
 ['direct',"function read(catalog){return catalog.db.prepare('SELECT 1').all();}module.exports={read};",{}],
 ['helper',"const {query}=require('./helper');function read(catalog){return query(catalog);}module.exports={read};",{'src/helper.js':"exports.query=catalog=>catalog.db.prepare('SELECT 1').all();"}],
 ['factory-member',"const {create}=require('./helper');function read(catalog){return create(catalog).query();}module.exports={read};",{'src/helper.js':"exports.create=catalog=>({query(){return catalog.db.prepare('SELECT 1').all();}});"}],
 ['local-callback',"function invoke(fn,catalog){return fn(catalog);}function query(catalog){return catalog.db.prepare('SELECT 1').all();}function read(catalog){return invoke(query,catalog);}module.exports={read};",{}],
 ['imported-callback',"const {query}=require('./helper');function invoke(fn,catalog){return fn(catalog);}function read(catalog){return invoke(query,catalog);}module.exports={read};",{'src/helper.js':"exports.query=catalog=>catalog.db.prepare('SELECT 1').all();"}],
 ['object-callback',"function invoke(service,catalog){return service.query(catalog);}function query(catalog){return catalog.db.prepare('SELECT 1').all();}function read(catalog){return invoke({query},catalog);}module.exports={read};",{}],
 ['returned-callback',"const {create}=require('./helper');function invoke(fn,catalog){return fn(catalog);}function read(catalog){return invoke(create(),catalog);}module.exports={read};",{'src/helper.js':"exports.create=()=>catalog=>catalog.db.prepare('SELECT 1').all();"}],
];
const results=[];
for(const [name,source,extra] of probes){
 const fixture=fs.mkdtempSync(path.join(os.tmpdir(),'independent-execution-'));
 try{
 const files={'src/query.js':source,...extra};for(const [file,text] of Object.entries(files)){fs.mkdirSync(path.dirname(path.join(fixture,file)),{recursive:true});fs.writeFileSync(path.join(fixture,file),text);}
 const b=boundary('ARCH-BIZOP-QUERY',{protectedScopes:[{path:'src/query.js',functionPath:'read'}]});
 const config={schemaVersion:1,factBaseline:baseline,bootstrap:{factBaseline:baseline,mode:'first-introduction'},boundaries:[b],generatedModules:[],dynamicLoads:[],policyChanges:[]};
 const s=scan(fixture,config);const result=evaluateRules(s,config,{schemaVersion:1,factBaseline:baseline,exceptions:[]},{root:fixture});
 const calls=[];require(path.join(fixture,'src/query.js')).read({db:{prepare(sql){calls.push(sql);return {all(){return [];}};}}});
 results.push({name,source,extra,runtimeSql:calls,violations:result.violations.map(v=>({rule:v.rule,from:v.from,line:v.line,message:v.message,functionPath:v.functionPath})),dynamicSites:s.dynamicSites});
 }finally{fs.rmSync(fixture,{recursive:true,force:true});}
}
const after=Object.fromEntries(reviewed.map(file=>[file,sha(file)]));
console.log(JSON.stringify({before,after,stable:JSON.stringify(before)===JSON.stringify(after),results},null,2));
