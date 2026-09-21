'use strict';
const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');
const root='/private/tmp/execution-descriptors-review-20260921-r2';
const { composeExecutionDescriptors, createBackgroundExecutionRuntime } = require(root+'/src/main-process/execution-descriptors/composition');
const { createExecutionSupervisor } = require(root+'/src/main-process/background-execution/supervisor');
const { createResourceGovernor } = require(root+'/src/main-process/background-execution/resource-governor');
const context=(actionKey, id='probe')=>({actionKey,operationKey:id,jobId:id,production:actionKey==='toolbox:split-rows',input:{},
  context:{kind:'operation',value:{taskRunId:id,taskKey:actionKey,moduleId:'toolbox',parentRunId:id,operationKey:id}}});
const governor=()=>createResourceGovernor({budgets:{cpuSlots:4,workerThreadSlots:4,utilityProcessSlots:0,ioHeavySlots:4,memoryBytes:2*1024**3}});
const opts={availableParallelism:6,totalMemoryBytes:16*1024**3,freeMemoryBytes:12*1024**3};
const evidence=[];
(async()=>{
  // 混合 action 白名单只允许当前 action 的真实 hook，production-null 同步拒绝。
  const compiled=composeExecutionDescriptors(opts), rg=governor();
  let attempts=0, lookups=[], hooks=[];
  const supervisor=createExecutionSupervisor({policyRegistry:compiled.policyRegistry,resourceGovernor:rg,
    carrierClosureActionKeys:['toolbox:merge','toolbox:split-rows'],
    getBeforeCarrierDispatchForAction(actionKey){lookups.push(actionKey);return actionKey==='toolbox:merge' ? ()=>hooks.push(actionKey) : null;},
    workerThreadAdapter:{start(){attempts++; throw Object.assign(new Error('probe'),{code:'PROBE_ADAPTER'});}}
  });
  assert.throws(()=>supervisor.start(context('toolbox:split-rows')), {code:'CARRIER_DISPATCH_BINDING_REQUIRED'});
  assert.equal(attempts,0); assert.equal(rg.snapshot().activeLeaseCount,0); assert.deepEqual(hooks,[]);
  evidence.push({probe:'mixed-production-null-hook',rejected:'CARRIER_DISPATCH_BINDING_REQUIRED',attempts,lookups,activeLeases:rg.snapshot().activeLeaseCount});
  await supervisor.shutdown();

  // 新 getter 在 start 同步固定 hook；等待 Main hook 时取消不可提前声称未创建。
  let resolveHook, resolveStarted;
  const hookDone=new Promise(resolve=>{resolveHook=resolve;});
  const hookStarted=new Promise(resolve=>{resolveStarted=resolve;});
  const rg2=governor(); let getterCount=0, invoked=[], starts=0;
  let selectedHook=()=>{invoked.push('original');resolveStarted();return hookDone;};
  const supervisor2=createExecutionSupervisor({policyRegistry:compiled.policyRegistry,resourceGovernor:rg2,
    carrierClosureActionKeys:['toolbox:merge'],getBeforeCarrierDispatchForAction(){getterCount++;return selectedHook;},
    workerThreadAdapter:{start(){starts++;assert.fail('取消后的待派发 hook 不应创建 worker');}}
  });
  const control=supervisor2.start(context('toolbox:merge','delayed-hook'));
  selectedHook=()=>{invoked.push('replacement');assert.fail('在途任务不能换成后续 hook');};
  await hookStarted;
  assert.equal(control.cancel({reason:'probe cancellation'}),true);
  await delay(0);
  const pending=control.getCarrierObservation();
  assert.notEqual(pending.disposition,'NOT_CREATED');
  assert.equal(starts,0);assert.equal(rg2.snapshot().activeLeaseCount,0);
  resolveHook();
  const result=await control.promise;
  const final=await control.waitForCarrierClosure({timeoutMs:1000});
  assert.equal(result.outcome,'cancelled'); assert.equal(final.disposition,'NOT_CREATED');
  assert.deepEqual(invoked,['original']);assert.equal(getterCount,1);assert.equal(starts,0);
  const report=await supervisor2.shutdown();assert.deepEqual(report.errors,[]);assert.deepEqual(report.leakedTransports,[]);
  evidence.push({probe:'getter-snapshot-cancel-pending-hook',getterCount,invoked,pendingDisposition:pending.disposition,
    finalDisposition:final.disposition,outcome:result.outcome,starts,activeLeases:rg2.snapshot().activeLeaseCount,report});

  // 经真实 Main composition/runtime 重放前轮 P3，无 hook 的 nonprod 恢复到 adapter。
  let adapterStarts=0;
  const runtime=createBackgroundExecutionRuntime({...opts,carrierClosureActionKeys:['toolbox:merge'],workerThreadAdapter:{start(){adapterStarts++;return {
    carrierKind:'thread-single',ready:Promise.reject(Object.assign(new Error('probe'),{code:'PROBE_ADAPTER'})),send(){},close(){},terminate(){return Promise.resolve(0);}
  };}}});
  const replay=await runtime.execute(context('toolbox:merge','replay'));
  assert.equal(replay.error.code,'PROBE_ADAPTER');assert.equal(adapterStarts,1);
  const replayReport=await runtime.shutdown();assert.deepEqual(replayReport.errors,[]);assert.deepEqual(replayReport.leakedTransports,[]);
  evidence.push({probe:'r1-p3-replay',adapterStarts,error:replay.error.code,activeLeases:runtime.resourceGovernor.snapshot().activeLeaseCount});
  console.log(JSON.stringify({status:'PASS',evidence},null,2));
})().catch(error=>{console.error(error);process.exitCode=1;});
