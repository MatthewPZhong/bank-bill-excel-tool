'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const result=JSON.parse(fs.readFileSync(path.join(__dirname,'r15-flow-before-current.json')));
const cases=require('./r15-flow-cases.cjs'),rows=[];
for(const side of ['before','current']){
 assert.equal(result[side].results.length,cases.length);
 for(let i=0;i<cases.length;i++){
  const fixture=cases[i],actual=result[side].results[i];assert.equal(actual.name,fixture.name);assert.equal(actual.scanError,undefined,fixture.name);
  assert.equal(actual.violations.length,side==='before'?fixture.expectedBefore:fixture.expectedCurrent,fixture.name);
  assert.deepEqual(actual.runtime.map(x=>x.flag),[false,true]);
  for(let k=0;k<2;k++){const vm=actual.runtime[k];assert.equal(vm.same,fixture.expectedSame[k],fixture.name);assert.equal(vm.extraCallable,fixture.expectedSame[k],fixture.name);assert.deepEqual(vm.keys,fixture.expectedSame[k]?['run','outsideScope']:['run'],fixture.name);if(vm.extraCallable)assert.equal(vm.extraResult,true,fixture.name);}
 }
}
for(let i=0;i<cases.length;i++)rows.push({name:cases[i].name,expectedBefore:cases[i].expectedBefore,expectedCurrent:cases[i].expectedCurrent,beforeDiagnostics:result.before.results[i].violations.length,currentDiagnostics:result.current.results[i].violations.length,vm:result.current.results[i].runtime});
assert.deepEqual(result.sourceMismatches,[]);
const scripts=fs.readdirSync(__dirname).filter(n=>n.startsWith('r15-flow-')&&n.endsWith('.cjs')).map(name=>({name,sha256:crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname,name))).digest('hex')}));
console.log(JSON.stringify({status:'PASS',fixtureCount:cases.length,vmInputsPerFixture:2,beforeScanErrors:0,currentScanErrors:0,currentAllowed:rows.filter(r=>r.currentDiagnostics===0).length,currentRejected:rows.filter(r=>r.currentDiagnostics>0).length,beforeCurrentDifferenceCount:rows.filter(r=>r.beforeDiagnostics!==r.currentDiagnostics).length,hashes:result.hashes,sourceFileCount:result.sourceFileCount,sourceMismatches:result.sourceMismatches,scripts,rows},null,2));
