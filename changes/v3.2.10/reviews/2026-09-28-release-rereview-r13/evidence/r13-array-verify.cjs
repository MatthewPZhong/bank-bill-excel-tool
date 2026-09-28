'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const get=name=>JSON.parse(fs.readFileSync(path.join(__dirname,name)));
const original=get('r13-array-original-before-current.json'),finite=get('r13-array-finite-before-current.json');
const rows=[];
for(const [group,result] of [['original',original],['finite',finite]]) for(let i=0;i<result.current.results.length;i++) {
 const current=result.current.results[i],before=result.before.results[i],conservative=current.name==='overwritten-before-reorder-safe';
 assert.equal(current.scanError,undefined,current.name);
 assert.equal(current.runtime.same,!current.safe,current.name);
 assert.equal(current.runtime.extraCallable,!current.safe,current.name);
 assert.equal(current.violations.length,current.safe&&!conservative?0:1,current.name);
 const originalCrash=['helper-reorder-after-write','helper-write-and-reorder','helper-reorder-before-write-safe','helper-write-after-reorder-safe'].includes(current.name);
 if(group==='finite'||originalCrash)assert.equal(before.scanError?.name,'RangeError',current.name);else assert.equal(before.violations.length,current.violations.length,current.name);
 rows.push({group,name:current.name,safe:current.safe,conservative,before:before.scanError?{scanError:before.scanError.name}:{diagnostics:before.violations.length},current:{diagnostics:current.violations.length,same:current.runtime.same,extraCallable:current.runtime.extraCallable}});
}
const src=fs.readFileSync(path.join(process.cwd(),'tests/unit/architecture/release-rereview-r12.test.js'),'utf8');
const setups=require('./r13-array-finite-cases.cjs').map(c=>({name:c.name,exactSetupInExistingTest:src.includes(c.setup.slice(c.setup.indexOf('const list='),c.setup.lastIndexOf('alias.outsideScope')))}));
assert.ok(setups.every(s=>s.exactSetupInExistingTest));
const raw=get('r13-array-raw-helper-exit.json');assert.equal(raw.status,0);assert.equal(raw.signal,null);
const rawResult=get('r13-array-raw-helper.stdout');assert.equal(rawResult.results[0].scanError,undefined);assert.equal(rawResult.results[0].violations.length,1);
assert.deepEqual(original.sourceMismatches,[]);assert.deepEqual(finite.sourceMismatches,[]);
console.log(JSON.stringify({status:'PASS',fixtureCount:rows.length,beforeScanErrors:rows.filter(r=>r.before.scanError).length,currentScanErrors:0,currentRejected:rows.filter(r=>r.current.diagnostics===1).length,currentAllowed:rows.filter(r=>r.current.diagnostics===0).length,conservativeRejections:rows.filter(r=>r.conservative).length,raw,setups,rows},null,2));
