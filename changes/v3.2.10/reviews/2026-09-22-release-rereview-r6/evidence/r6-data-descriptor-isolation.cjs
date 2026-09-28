'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),crypto=require('node:crypto');
const {parse,createAnalysis}=require(process.cwd()+'/scripts/architecture/scan');
const source='const shared={name:"bank"};const a={p:shared};const b={q:shared};const one=a.p;const two=b.q;const {p:three}=a;const {q:four}=b;one;two;three;four;a.p;b.q;';
function analyze(){return createAnalysis(parse(source,'src/isolation.js'),'src/isolation.js',process.cwd());}
const a=analyze(),b=analyze();
const bindings=['one','two','three','four'];
const data=bindings.map(name=>{const node=a.nodes.filter(n=>n.type==='Identifier'&&n.name===name).at(-1);const value=a.describe(node);const access=a.memberRead(value);assert.ok(access,name);return{name,node,value,access};});
assert.equal(new Set(data.map(x=>x.value)).size,4);
for(const {name,value,access} of data){assert.equal(b.memberRead(value),undefined,name);assert.equal(a.memberRead(value),access);assert.equal(access.property,['one','three'].includes(name)?'p':'q');}
assert.equal(data[0].access.object.chain[0],'a');assert.equal(data[1].access.object.chain[0],'b');
const forward=analyze(),reverse=analyze();
const relevant=x=>x.nodes.filter(n=>['Identifier','MemberExpression'].includes(n.type));
for(const n of relevant(forward))forward.describe(n);
for(const n of relevant(reverse).reverse())reverse.describe(n);
const signature=x=>JSON.stringify(relevant(x).map(n=>[n.start,JSON.stringify(x.describe(n))]));
assert.equal(signature(forward),signature(reverse));
const digest=crypto.createHash('sha256').update(signature(forward)).digest('hex');
console.log(JSON.stringify({status:'PASS',distinctSelectedDescriptors:4,crossAnalysisLookupAbsent:true,selectionProperties:data.map(x=>({name:x.name,property:x.access.property,readStart:x.access.node.start})),forwardReverseDescriptionOrderEqual:true,descriptionDigest:digest},null,2));
