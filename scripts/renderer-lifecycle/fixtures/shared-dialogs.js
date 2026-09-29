'use strict';

module.exports = async ({ js, load, reset, assert, test }) => {
  async function setup({ failed = false, deferred = false } = {}) {
    await reset();
    await load('src/renderer/dialogs/toolbox.js');
    await load('src/renderer-dialogs.js');
    await js(`
      window.mappingTest={reads:0,saves:[],logs:0};
      window.desktopApi={app:{reportLog(){mappingTest.logs++;}},linkedTable:{list:async()=>({status:'ok',tables:[]})},
        fundTransferAccountMappings:{list:()=>{mappingTest.reads++;return ${deferred ? 'new Promise(resolve=>window.resolveMappings=resolve)' : failed ? "Promise.reject(new Error('加载失败'))" : "Promise.resolve({status:'success',mappings:[]})"};},
          save: rows=>{mappingTest.saves.push(rows);return new Promise(resolve=>window.resolveSaveMappings=resolve);}}};
      window.mappingDialogs=window.__createTestRendererDialogs({modalBridge:__rendererModalBridge,
        state:{},elements:{modalRoot:document.getElementById('modalRoot')},desktopApi:window.desktopApi,appConstants:{}});
      window.linkedOverlay=null;
      window.linkedHandle=__rendererModalBridge.openModal(()=>{linkedOverlay=mappingDialogs.createLinkedTableManagerDialog();return linkedOverlay;}).handle;
      linkedOverlay.dataset.testDraft='parent-draft';
      linkedOverlay.querySelector('[data-action="account-mapping"]').click();
      window.mappingOverlay=document.getElementById('modalRoot').lastElementChild;
      window.mappingHandle=__rendererModalHost.getTop();
      void 0;
    `);
    await js(`new Promise(resolve=>setTimeout(resolve,10))`);
  }
  await test('链接表→映射加载失败→告警返回，保持禁用且零save',async()=>{
    await setup({failed:true});
    assert.equal(await js(`document.getElementById('modalRoot').children.length`),3);
    await js(`document.getElementById('modalRoot').lastElementChild.querySelector('button').click()`);
    assert.equal(await js(`mappingHandle.isTop()`),true);
    assert.equal(await js(`mappingOverlay.querySelector('[data-action="done"]').disabled`),true);
    await js(`mappingOverlay.querySelector('[data-action="done"]').dispatchEvent(new Event('click'))`);
    assert.equal(await js(`mappingTest.saves.length`),0);
    assert.equal(await js(`linkedOverlay.dataset.testDraft`),'parent-draft');
  });
  await test('合法空映射允许保存，busy阻止公共替换，成功告警替换映射并回父层',async()=>{
    await setup();
    assert.equal(await js(`mappingOverlay.querySelector('[data-action="done"]').disabled`),false);
    await js(`mappingOverlay.querySelector('[data-action="done"]').click();mappingOverlay.querySelector('[data-action="done"]').dispatchEvent(new Event('click'));`);
    assert.deepEqual(await js(`mappingTest.saves`),[[]]);
    assert.equal(await js(`__rendererModalBridge.openModal(()=>{throw new Error('不能创建');}).status`),'blocked');
    await js(`resolveSaveMappings({status:'success',message:'保存完成'})`);
    await js(`new Promise(resolve=>setTimeout(resolve,10))`);
    assert.equal(await js(`mappingHandle.isOpen()`),false);
    assert.equal(await js(`document.getElementById('modalRoot').children.length`),2);
    await js(`document.getElementById('modalRoot').lastElementChild.querySelector('button').click()`);
    assert.equal(await js(`linkedHandle.isTop() && linkedOverlay.dataset.testDraft==='parent-draft'`),true);
  });
  await test('映射保存失败只打开子告警，返回后保留可重试编辑层',async()=>{
    await setup();
    await js(`mappingOverlay.querySelector('[data-action="done"]').click();resolveSaveMappings({status:'error',message:'写入失败'});`);
    await js(`new Promise(resolve=>setTimeout(resolve,10))`);
    assert.equal(await js(`document.getElementById('modalRoot').children.length`),3);
    await js(`document.getElementById('modalRoot').lastElementChild.querySelector('button').click()`);
    assert.equal(await js(`mappingHandle.isTop() && !mappingOverlay.querySelector('[data-action="done"]').disabled`),true);
  });
  await test('关闭映射后的晚到读取既不改旧DOM也不复活告警',async()=>{
    await setup({deferred:true});
    await js(`mappingHandle.close(); window.closedMarkup=mappingOverlay.innerHTML;resolveMappings({status:'success',mappings:[{midAccountId:'old',clearingAccountId:'late'}]});`);
    await js(`new Promise(resolve=>setTimeout(resolve,10))`);
    assert.equal(await js(`mappingOverlay.innerHTML===closedMarkup && linkedHandle.isTop()`),true);
  });
  await test('拒绝根替换时工厂未创建且没有映射读取或告警日志',async()=>{
    await reset();
    await load('src/renderer/dialogs/toolbox.js');
    await load('src/renderer-dialogs.js');
    const result=await js(`(()=>{
      const counts={reads:0,logs:0};window.desktopApi={app:{reportLog(){counts.logs++;}},fundTransferAccountMappings:{list(){counts.reads++;return Promise.resolve({status:'success',mappings:[]});}}};
      const dialogs=window.__createTestRendererDialogs({modalBridge:__rendererModalBridge,state:{},elements:{},desktopApi:window.desktopApi});
      __rendererModalHost.openRoot(()=>{const overlay=document.createElement('div');overlay.innerHTML='<section><button>保存中</button></section>';return {overlay,dialog:overlay.firstElementChild,canClose:()=>false};});
      const mapping=__rendererModalBridge.openModal(()=>dialogs.createFundTransferAccountMappingDialog());
      const alert=__rendererModalBridge.openModal(()=>dialogs.createAlertDialog('不可显示'));
      return {...counts,mapping:mapping.status,alert:alert.status};
    })()`);
    assert.deepEqual(result,{reads:0,logs:0,mapping:'blocked',alert:'blocked'});
  });
  async function setupCabinet() {
    await reset();
    await load('src/renderer/dialogs/toolbox.js');await load('src/renderer-dialogs.js');await load('src/renderer/module-router.js');
    await js(`
      window.cab={calls:[],after:[],persisted:[],navigation:[],feedback:[],defer(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}};
      cab.host=__rendererModalHost;cab.bridge=__modalBridge.createModalBridge({host:cab.host,getOwner:()=> 'one'});
      cab.dialogs=__createTestRendererDialogs({modalBridge:cab.bridge,state:{},elements:{},desktopApi:{},setStatus:(...args)=>cab.feedback.push(args)});
      cab.router=ModuleRouter.createModuleRouter({defaultModuleId:'one',persistCurrentModule:id=>cab.navigation.push(id),modules:['one','two'].map(id=>({id,controller:{
        enter:()=>({status:'ready'}),leave:()=>cab.host.closeOwner('one','navigation').status==='blocked'?{status:'blocked'}:{status:'left'},dispose(){}}}))});
      cab.router.navigate('one',{persist:false});
      cab.write=cab.defer();cab.parent=cab.bridge.openModal(()=>cab.dialogs.createAlertDialog('收纳父窗口')).handle;
      cab.handle=cab.bridge.pushModal(cab.parent,()=>cab.dialogs.createModuleCabinetDialog({enabledModules:['one','two'],allModules:[{id:'one',name:'一'},{id:'two',name:'二'}],
        onCommit:ids=>{cab.calls.push([...ids]);return cab.write.promise.then(ok=>{if(ok)cab.persisted.push([...ids]);return ok;});},
        onCommitted:ids=>{cab.after.push({ids:[...ids],closed:!cab.handle.isOpen()});if(cab.failAfter)throw new Error('导航刷新异常');}
      })).handle;cab.overlay=document.getElementById('modalRoot').lastElementChild;cab.button=cab.overlay.querySelector('[data-action="confirm"]');void 0;
    `);
  }
  const cabinetTick=()=>js('new Promise(resolve=>setTimeout(resolve,5))');
  await test('收纳保存中同步拒绝父子关闭、根替换和导航，重复确认仅一次调用',async()=>{
    await setupCabinet();await js('cab.button.click();cab.button.dispatchEvent(new Event("click"));');
    assert.deepEqual(await js(`({calls:cab.calls.length,disabled:cab.button.disabled,root:cab.bridge.openModal(()=>{throw new Error('不能执行工厂');}).status,parent:cab.parent.close().status,child:cab.handle.close().status,navigation:cab.router.navigate('two').status,current:cab.router.getCurrentModuleId(),persist:cab.navigation.length})`),
      {calls:1,disabled:true,root:'blocked',parent:'blocked',child:'blocked',navigation:'blocked',current:'one',persist:0});
    await js('cab.write.resolve(true);');await cabinetTick();
    assert.deepEqual(await js('({after:cab.after,parentTop:cab.parent.isTop(),open:cab.handle.isOpen()})'),{after:[{ids:['one','two'],closed:true}],parentTop:true,open:false});
  });
  await test('收纳强制销毁后后台仍保存事实，但不关闭新窗、不触发旧导航回调',async()=>{
    await setupCabinet();await js(`cab.button.click();cab.handle.dispose();cab.markup=cab.overlay.innerHTML;cab.newHandle=cab.bridge.openModal(()=>cab.dialogs.createAlertDialog('新窗口')).handle;cab.write.resolve(true);`);await cabinetTick();
    assert.deepEqual(await js('({persisted:cab.persisted,after:cab.after,newTop:cab.newHandle.isTop(),unchanged:cab.markup===cab.overlay.innerHTML})'),{persisted:[['one','two']],after:[],newTop:true,unchanged:true});
  });
  await test('收纳调用失败保留草稿和错误，重试成功后仅一次 onCommitted；取消不保存',async()=>{
    await setupCabinet();await js(`cab.button.click();cab.write.reject(new Error('设置服务异常'));`);await cabinetTick();
    assert.equal(await js('cab.handle.isTop()&&!cab.button.disabled'),true);
    assert.match(await js('cab.overlay.querySelector(".module-cabinet-error").textContent'),/设置服务异常/);
    await js(`cab.write=cab.defer();cab.button.click();cab.write.resolve(false);`);await cabinetTick();
    assert.match(await js('cab.overlay.querySelector(".module-cabinet-error").textContent'),/保存模块设置失败/);
    await js(`cab.write=cab.defer();cab.button.click();cab.write.resolve(true);`);await cabinetTick();
    assert.equal(await js('cab.after.length'),1);
    await setupCabinet();await js(`cab.overlay.querySelector('[data-action="cancel"]').click();`);
    assert.deepEqual(await js('({calls:cab.calls.length,parent:cab.parent.isTop(),open:cab.handle.isOpen()})'),{calls:0,parent:true,open:false});
  });

  await test('收纳已保存后的导航回调抛错明确反馈，保留保存成功事实',async()=>{
    await setupCabinet();await js('cab.failAfter=true;cab.button.click();cab.write.resolve(true);');await cabinetTick();
    assert.deepEqual(await js('cab.persisted'),[['one','two']]);
    assert.equal(await js('cab.after.length===1&&!cab.handle.isOpen()&&cab.parent.isTop()'),true);
    assert.match(await js('cab.feedback[0][0]'),/模块设置已保存.*导航刷新异常/);
  });

  async function setupVccCompute({ controlledClose = false } = {}) {
    await reset();
    await load('src/renderer/dialogs/toolbox.js');await load('src/renderer-dialogs.js');
    await js(`
      window.vcc={calls:[],settled:[],closes:0,allowed:${!controlledClose},defer(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}};
      vcc.host=__rendererModalHost;vcc.bridge=__modalBridge.createModalBridge({host:vcc.host,getOwner:()=> 'vcc-op-calc'});
      vcc.dialogs=__createTestRendererDialogs({modalBridge:vcc.bridge,state:{},elements:{},desktopApi:{}});
      vcc.write=vcc.defer();vcc.parent=vcc.bridge.openModal(()=>vcc.dialogs.createAlertDialog('计算父窗口')).handle;
      vcc.handle=vcc.bridge.pushModal(vcc.parent,()=>vcc.dialogs.createVccOpCalcComputeDialog({yearMonth:'2026-07',totals:{totalOut:'0.00',totalIn:'10.00',totalAmount:'10.00',currency:'CNY'},
        canClose:()=>vcc.allowed,onCompute:begin=>{vcc.calls.push(begin);return vcc.write.promise.then(result=>{vcc.settled.push(result);return result;});},onClose:()=>vcc.closes++
      })).handle;vcc.overlay=document.getElementById('modalRoot').lastElementChild;vcc.input=vcc.overlay.querySelector('input');
      [vcc.compute,vcc.cancel]=vcc.overlay.querySelectorAll('button');vcc.input.value='000.0100';vcc.input.dispatchEvent(new Event('input'));void 0;
    `);
  }
  const vccTick=()=>js('new Promise(resolve=>setTimeout(resolve,5))');
  await test('真实 VCC F1 先关闭再确认仍归属原 scan，不被 closed 微任务误取消',async()=>{
    await reset('<section id="vccPanel"><button id="vccOpCalcImportBtn"></button><button id="vccOpCalcRunBtn"></button><button id="vccOpCalcShowBalanceBtn"></button><div id="vccOpCalcStatusBox"></div></section><div id="modalRoot"></div>');
    await load('src/renderer/dialogs/toolbox.js');await load('src/renderer-dialogs.js');await load('src/renderer/controllers/vcc-op-calc.js');
    await js(`
      window.flow={compute:0,saves:[]};flow.dialogs=__createTestRendererDialogs({modalBridge:__rendererModalBridge,state:{},elements:{},desktopApi:{}});
      flow.controller=__vccOpCalcController.createVccOpCalcController({panel:document.getElementById('vccPanel'),api:{
        pickFiles:async()=>({status:'success',filePaths:['/synthetic/A.xlsx']}),scan:async()=>({status:'success',yearMonth:'2026-07',totalRows:1,fileCount:1}),
        computeAmounts:async()=>{flow.compute++;return {status:'success',yearMonth:'2026-07',totals:{totalAmount:'10.00'},perFile:[{fileName:'A.xlsx',rowCount:1}]};},
        save:async payload=>{flow.saves.push(payload);return {status:'success',yearMonth:'2026-07',beginOp:'100.00',endOp:'110.00'};},listBalanceMonths:async()=>[]
      },ui:{modalHost:__rendererModalHost,modalBridge:__rendererModalBridge,status:(node,text)=>node.textContent=text,alert:flow.dialogs.createAlertDialog,
        createVccOpCalcConfirmDialog:flow.dialogs.createVccOpCalcConfirmDialog,createVccOpCalcComputeDialog:flow.dialogs.createVccOpCalcComputeDialog,createVccOpCalcShowBalanceDialog:flow.dialogs.createVccOpCalcShowBalanceDialog}});
      (async()=>{await flow.controller.enter();await flow.controller.commands.import();flow.f1=__rendererModalHost.getTop();document.querySelector('[data-action="confirm"]').click();})();void 0;
    `);await vccTick();
    assert.deepEqual(await js('({compute:flow.compute,open:flow.f1.isOpen(),disabled:document.getElementById("vccOpCalcRunBtn").disabled})'),{compute:1,open:false,disabled:false});
    await js('flow.controller.commands.run().then(()=>undefined)');
    assert.match(await js('document.getElementById("modalRoot").textContent'),/计算期末OP（2026-07）/);
    await js('flow.controller.dispose()');
  });
  await test('真实 VCC F2 提交锁拒绝双击、父子关闭、根替换及离页关闭；期初原样交给回调',async()=>{
    await setupVccCompute();await js('vcc.compute.click();vcc.compute.dispatchEvent(new Event("click"));');
    assert.deepEqual(await js(`({calls:vcc.calls,root:vcc.bridge.openModal(()=>vcc.dialogs.createAlertDialog('错误替换')).status,parent:vcc.parent.close().status,child:vcc.handle.close().status,navigation:vcc.host.closeOwner('vcc-op-calc','navigation').status})`),
      {calls:['000.0100'],root:'blocked',parent:'blocked',child:'blocked',navigation:'blocked'});
    await js('vcc.write.resolve({status:"success",endOp:"10.01"});');await vccTick();
    assert.match(await js('vcc.overlay.textContent'),/期末OP = 10.01（已保存）/);
    await js('vcc.cancel.click();');
    assert.deepEqual(await js('({open:vcc.handle.isOpen(),parent:vcc.parent.isTop(),closes:vcc.closes})'),{open:false,parent:true,closes:1});
  });
  for (const status of ['success','error','cancelled']) {
    await test(`真实 VCC F2 强制销毁后 ${status} 仍完成回调，不改旧 DOM 或新栈`,async()=>{
      await setupVccCompute();
      await js(`vcc.compute.click();vcc.handle.dispose();vcc.markup=vcc.overlay.innerHTML;vcc.next=vcc.bridge.openModal(()=>vcc.dialogs.createAlertDialog('新窗口')).handle;vcc.write.resolve({status:${JSON.stringify(status)},endOp:'10.01',message:'合成结算'});`);await vccTick();
      assert.deepEqual(await js('({calls:vcc.calls.length,settled:vcc.settled.length,unchanged:vcc.markup===vcc.overlay.innerHTML,newTop:vcc.next.isTop(),closes:vcc.closes})'),
        {calls:1,settled:1,unchanged:true,newTop:true,closes:0});
    });
  }
  await test('真实 VCC F2 回调 reject/失败可重试，取消不再次计算',async()=>{
    await setupVccCompute();await js('vcc.compute.click();vcc.write.reject(new Error("保存服务异常"));');await vccTick();
    assert.equal(await js('vcc.handle.isTop()&&!vcc.input.disabled&&!vcc.compute.disabled'),true);
    assert.match(await js('vcc.overlay.textContent'),/保存服务异常/);
    await js('vcc.write=vcc.defer();vcc.compute.click();vcc.write.resolve({status:"error",message:"后端金额校验失败"});');await vccTick();
    assert.match(await js('vcc.overlay.textContent'),/后端金额校验失败/);
    await js('vcc.cancel.click();');
    assert.deepEqual(await js('({calls:vcc.calls.length,closes:vcc.closes,open:vcc.handle.isOpen()})'),{calls:2,closes:1,open:false});
  });
  await test('真实 VCC F2 旧已关闭节点的事件不提交、不关闭新窗口',async()=>{
    await setupVccCompute();
    await js(`vcc.handle.close();vcc.markup=vcc.overlay.innerHTML;vcc.next=vcc.bridge.openModal(()=>vcc.dialogs.createAlertDialog('新窗口')).handle;vcc.compute.dispatchEvent(new Event('click'));vcc.cancel.dispatchEvent(new Event('click'));vcc.input.dispatchEvent(new Event('input'));`);
    assert.deepEqual(await js('({calls:vcc.calls.length,newTop:vcc.next.isTop(),closes:vcc.closes,unchanged:vcc.markup===vcc.overlay.innerHTML})'),{calls:0,newTop:true,closes:0,unchanged:true});
  });
  await test('真实 VCC F2 保留注入的领域关闭资格，并与自身提交锁合成',async()=>{
    await setupVccCompute({controlledClose:true});
    assert.equal(await js('vcc.handle.close().status'),'blocked');
    await js('vcc.allowed=true;vcc.compute.click();');
    assert.equal(await js('vcc.handle.close().status'),'blocked');
    await js('vcc.write.resolve({status:"error",message:"保存失败"});');await vccTick();
    await js('vcc.allowed=false;');assert.equal(await js('vcc.handle.close().status'),'blocked');
    await js('vcc.allowed=true;vcc.cancel.click();');assert.equal(await js('!vcc.handle.isOpen()&&vcc.closes===1'),true);
  });

};
