const REVIEW_SOURCE_ROOT = process.env.REVIEW_SOURCE_ROOT || '/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/v3210-renderer-boundaries';
const fs=require('node:fs');const Module=require('node:module');const path=require('node:path');const assert=require('node:assert/strict');
const filename=REVIEW_SOURCE_ROOT + '/tests/unit/renderer/vcc-op-calc-source-binding.test.js';
const loaded=new Module(filename,module);loaded.filename=filename;loaded.paths=Module._nodeModulePaths(path.dirname(filename));
loaded._compile(fs.readFileSync(filename,'utf8').split("test('R01：")[0]+'\nmodule.exports={harness};',filename);
(async()=>{
 const cleanup=[];const h=await loaded.exports.harness({after:fn=>cleanup.push(fn)});
 try{
   await h.ready('A');const delayed=h.hold('scan');const pending=h.import('B');await delayed.started;
   const leave=h.controller.leave();delayed.release();await pending;await h.controller.enter();
   const original={leave,runDisabled:h.node('RunBtn').disabled,feedback:h.status(),mainMonth:h.session.getComputeCache().yearMonth,saves:h.count('save'),rows:h.rows()};
   assert.equal(original.runDisabled,true);assert.equal(original.saves,0);
   await h.controller.commands.run();assert.equal(h.views.at(-1).name,'alert');assert.equal(h.count('save'),0);
   delete h.controls.scan;
   const continuous=[];
   for(const [file,beginOp] of [['B','100.00'],['A','20.00'],['B','-10.00']]){
     await h.ready(file);h.controller.leave();await h.controller.enter();
     const f2=await h.f2();const displayed={month:f2.options.yearMonth,total:f2.options.totals.totalAmount};
     const saved=await f2.options.onCompute(beginOp);assert.equal(saved.status,'success');
     continuous.push({file,beginOp,displayed,saved,stored:h.rows().at(-1)});
   }
   console.log(JSON.stringify({original,continuous,saves:h.count('save'),rows:h.rows()},null,2));
 }finally{for(const fn of cleanup)fn();}
})().catch(error=>{console.error(error);process.exitCode=1;});
