'use strict';

// 运行真实旧向导工厂及宿主；所有 API 为内存替身，不读取/修改真实账户、场景或模板数据。
module.exports = async ({ js, load, reset, assert, test }) => {
  async function setup() {
    await reset();
    await load('src/renderer/dialogs/toolbox.js');
    await load('src/renderer-dialogs.js');
    await js(`
      window.legacy = {
        calls: {channelLists:0,channelDeletes:[],rowDeletes:[],rowCounts:[],rules:[],complete:[],cancel:[],extract:[],applied:[],statuses:[]},
        channels:[{id:2,name:'测试渠道',ownerLocation:'测试地区',isBuiltin:false}],
        deferred() { let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {resolve,reject,promise}; },
        tick:()=>new Promise(resolve=>setTimeout(resolve,0)),
        root:document.getElementById('modalRoot'),host:window.__rendererModalHost,bridge:window.__rendererModalBridge,
        top(){return this.root.lastElementChild;},
        click(text,within=this.top()){const button=[...within.querySelectorAll('button')].find(item=>item.textContent.trim()===text);if(!button)throw new Error('缺少按钮 '+text);button.click();},
        createParent(){const node=document.createElement('div');node.className='modal-overlay';node.innerHTML='<section class="modal-card"><input value="父层草稿"><button>父层</button></section>';return node;},
        open(factory){this.parent=this.createParent();this.parentHandle=this.bridge.openModal(()=>this.parent).handle;const opened=this.bridge.pushModal(this.parent,()=>{this.overlay=factory();return this.overlay;});if(opened.status!=='opened')throw new Error('未打开工厂: '+opened.status);this.handle=opened.handle;}
      };
      window.desktopApi={app:{reportLog(){}},toolbox:{},channels:{
        list:async()=>{legacy.calls.channelLists++;return {status:'ok',channels:legacy.channels.map(row=>({...row}))};},
        deleteOne:async(id)=>{legacy.calls.channelDeletes.push(id);if(legacy.channelDeleteFailure)return {status:'failed',message:'渠道删除测试失败'};legacy.channels=legacy.channels.filter(row=>row.id!==id);return {status:'ok',id};}
      },templates:{
        previewDeleteBillSplitRow:async()=>({status:'success',dissolvedGroups:[9]}),
        deleteBillSplitRow:async payload=>{legacy.calls.rowDeletes.push(payload);return {status:'failed',message:'账单删行测试失败'};},
        saveBillSplitRowCount:async payload=>{legacy.calls.rowCounts.push(payload);return {status:'failed',message:'账单数量测试失败'};},
        saveBillSplitAmountRules:async payload=>{legacy.calls.rules.push(payload);return {status:'failed',message:'规则保存测试失败'};}
      },bigAccount:{loadMode:async()=>({mode:'unfixed'}),loadOrder:async()=>({order:null})},files:{
        completeBigAccountSelection:payload=>{legacy.calls.complete.push(payload);return legacy.complete.promise;},
        extractBigAccountOrder:async payload=>{legacy.calls.extract.push(payload);return {status:'error',errorCode:'BIG_ACCOUNT_NOT_MAINTAINED',message:'未维护测试账号',unmaintainedAccounts:[{merchantId:'TEST-ACCOUNT',fileOrdinal:0,fileName:'fixture.xlsx',blockOrdinal:0,sourceRowNumber:1}]};},
        cancelBigAccountSelection:contextId=>{legacy.calls.cancel.push(contextId);return legacy.cancellation.promise;}
      }};
      legacy.dialogs=window.__createTestRendererDialogs({modalBridge:legacy.bridge,state:{currencyOptions:['USD']},
        elements:{modalRoot:legacy.root},desktopApi:window.desktopApi,appConstants:{},
        setStatus:(...args)=>legacy.calls.statuses.push(args),applyStatementResult:result=>legacy.calls.applied.push(result),
        refreshTemplates:async()=>{},applyManualBalancePromptStatus:()=>{},refreshBankStatementStatus:async()=>{},reloadReconIdFixScenarios:async()=>{}
      });
      legacy.openRows=()=>legacy.open(()=>legacy.dialogs.createBillSplitRowsDialog({
        template:{id:7,name:'测试模板',headers:['Currency','Condition','Amount']},
        initialRows:[{seqNo:1,rowStatus:'draft',currencySourceField:'Currency',creditSourceField:'',debitSourceField:''},
          {seqNo:2,rowStatus:'draft',currencySourceField:'Currency',creditSourceField:'',debitSourceField:''}],
        initialAmountRules:[{targetField:'Credit Amount',conditionField:'Condition',conditionValue:'入金',mappedField:'Amount',rowIndex:0},
          {targetField:'Debit Amount',conditionField:'Condition',conditionValue:'出金',mappedField:'Amount',rowIndex:1}]
      }));
      legacy.openBigAccount=()=>legacy.open(()=>legacy.dialogs.createBigAccountSelectionDialog({contextId:'selection-fixture-token',templateId:7,templateName:'测试模板',
        rows:[{index:0,fileIndex:0,fileName:'fixture.xlsx',sourceRowNumber:1}],
        expandedBigAccountOptions:[{merchantId:'TEST-ACCOUNT',currency:'USD'}],canRemember:false
      }));
      void 0;
    `);
  }
  const settle = () => js('legacy.tick()');

  await test('公共告警按钮重复触发只回调一次，保留原父层', async () => {
    await setup();
    const result = await js(`(async()=>{
      let callbacks=0;
      legacy.open(()=>legacy.dialogs.createAlertDialog('测试告警',{onConfirm:()=>callbacks++}));
      const button=legacy.overlay.querySelector('button');button.click();button.click();await legacy.tick();
      return {callbacks,count:legacy.root.children.length,parentMounted:legacy.parent.isConnected,parentTop:legacy.parentHandle.isTop(),errors:window.__testErrors};
    })()`);
    assert.deepEqual(result, {callbacks:1,count:1,parentMounted:true,parentTop:true,errors:[]});
  });

  await test('渠道删除成功重读列表并保留同一个渠道管理父层', async () => {
    await setup();
    await js(`legacy.open(()=>legacy.dialogs.createChannelManagerDialog());`); await settle();
    await js(`legacy.click('删除',legacy.overlay);legacy.confirm=legacy.top();legacy.click('删除');`); await settle();
    assert.deepEqual(await js(`({calls:legacy.calls.channelDeletes,lists:legacy.calls.channelLists,rowExists:!!legacy.overlay.querySelector('[data-channel-id="2"]'),
      count:legacy.root.children.length,parentMounted:legacy.parent.isConnected,managerMounted:legacy.overlay.isConnected,managerTop:legacy.handle.isTop(),errors:window.__testErrors})`),
    {calls:[2],lists:2,rowExists:false,count:2,parentMounted:true,managerMounted:true,managerTop:true,errors:[]});
  });

  await test('渠道删除失败保留确认层，错误确认后仍能回到原确认', async () => {
    await setup();
    await js(`legacy.channelDeleteFailure=true;legacy.open(()=>legacy.dialogs.createChannelManagerDialog());`); await settle();
    await js(`legacy.click('删除',legacy.overlay);legacy.confirm=legacy.top();legacy.click('删除');`); await settle();
    assert.match(await js(`legacy.top().textContent`), /渠道删除测试失败/);
    assert.deepEqual(await js(`({count:legacy.root.children.length,confirmationMounted:legacy.confirm.isConnected,managerMounted:legacy.overlay.isConnected,calls:legacy.calls.channelDeletes})`),
      {count:4,confirmationMounted:true,managerMounted:true,calls:[2]});
    await js(`legacy.top().querySelector('button').click();`);
    assert.deepEqual(await js(`({count:legacy.root.children.length,sameConfirm:legacy.top()===legacy.confirm,parentMounted:legacy.parent.isConnected,errors:window.__testErrors})`),
      {count:3,sameConfirm:true,parentMounted:true,errors:[]});
    await js(`legacy.click('取消');`);
    assert.deepEqual(await js(`({count:legacy.root.children.length,sameManager:legacy.top()===legacy.overlay,calls:legacy.calls.channelDeletes})`),
      {count:2,sameManager:true,calls:[2]});
  });

  for (const action of ['delete','count']) {
    await test(`拆分账单${action==='delete'?'确认删行':'确认减少行数'}失败告警不被吞掉，确认后保留待重试层`, async () => {
      await setup();
      await js(`legacy.openRows();`);
      if (action === 'delete') await js(`legacy.overlay.querySelector('.bill-split-row-delete-btn').click();`);
      else await js(`legacy.overlay.querySelector('.bill-split-row-count-input').value='1';legacy.overlay.querySelector('.bill-split-row-count-done-btn').click();`);
      await settle();
      await js(`legacy.confirm=legacy.top();legacy.click('确认');`); await settle();
      assert.match(await js(`legacy.top().textContent`), action === 'delete' ? /账单删行测试失败/ : /账单数量测试失败/);
      assert.deepEqual(await js(`({count:legacy.root.children.length,confirmMounted:legacy.confirm.isConnected,parentMounted:legacy.overlay.isConnected,
        deletes:legacy.calls.rowDeletes.length,counts:legacy.calls.rowCounts.length,rows:legacy.overlay.querySelectorAll('.bill-split-rows-table tbody tr').length})`),
      {count:4,confirmMounted:true,parentMounted:true,deletes:action==='delete'?1:0,counts:action==='count'?1:0,rows:2});
      await js(`legacy.top().querySelector('button').click();`);
      assert.deepEqual(await js(`({count:legacy.root.children.length,sameConfirm:legacy.top()===legacy.confirm,errors:window.__testErrors})`),
        {count:3,sameConfirm:true,errors:[]});
      await js(`legacy.click('取消');`);
      assert.deepEqual(await js(`({count:legacy.root.children.length,sameRows:legacy.top()===legacy.overlay})`), {count:2,sameRows:true});
    });
  }

  await test('拆分账单规则保存失败后保留规则编辑层与未保存输入', async () => {
    await setup();
    await js(`legacy.openRows();legacy.overlay.querySelector('.bill-split-amount-rules-manage-btn').click();legacy.rulesOverlay=legacy.top();
      legacy.rulesOverlay.querySelector('[data-target-field="Credit Amount"] .rule-condition-value').value='未保存测试草稿';
      legacy.rulesOverlay.querySelector('[data-action="done"]').click();`);
    await settle();
    assert.match(await js(`legacy.top().textContent`), /规则保存测试失败/);
    assert.equal(await js(`legacy.calls.rules.length`), 1);
    await js(`legacy.top().querySelector('button').click();`);
    assert.deepEqual(await js(`({count:legacy.root.children.length,sameRules:legacy.top()===legacy.rulesOverlay,rulesMounted:legacy.rulesOverlay.isConnected,
      draft:legacy.rulesOverlay.querySelector('[data-target-field="Credit Amount"] .rule-condition-value').value,parentMounted:legacy.overlay.isConnected,errors:window.__testErrors})`),
    {count:3,sameRules:true,rulesMounted:true,draft:'未保存测试草稿',parentMounted:true,errors:[]});
    assert.equal(await js(`legacy.calls.rules[0].amountSplitRules[0].conditionValue`), '未保存测试草稿');
  });

  await test('大账号选择成功先解除 busy 后提交关闭，双击只提交原 context 一次', async () => {
    await setup();
    await js(`legacy.complete=legacy.deferred();legacy.openBigAccount();`); await settle();
    await js(`legacy.overlay.querySelector('.big-account-order-checkbox').click();const button=legacy.overlay.querySelector('[data-action="done"]');button.click();button.click();`);
    assert.deepEqual(await js(`({count:legacy.calls.complete.length,context:legacy.calls.complete[0]?.contextId,close:legacy.handle.close().status,
      replace:legacy.bridge.openModal(()=>{throw new Error('busy 不应创建');}).status})`),
      {count:1,context:'selection-fixture-token',close:'blocked',replace:'blocked'});
    await js(`legacy.complete.resolve({status:'success',message:'测试选择已完成'});`); await settle();
    assert.deepEqual(await js(`({count:legacy.root.children.length,selectionOpen:legacy.handle.isOpen(),parentTop:legacy.parentHandle.isTop(),applied:legacy.calls.applied.length,
      assignments:legacy.calls.complete[0].assignments,errors:window.__testErrors})`),
    {count:1,selectionOpen:false,parentTop:true,applied:1,assignments:[{rowIndex:0,merchantId:'TEST-ACCOUNT',currency:'USD'}],errors:[]});
  });

  await test('未维护大账号确认与取消进度为子流程，取消失败可重试且成功结束原会话', async () => {
    await setup();
    await js(`legacy.cancellation=legacy.deferred();legacy.openBigAccount();`); await settle();
    await js(`legacy.overlay.querySelector('[data-action="extract-order"]').click();`); await settle();
    assert.match(await js(`legacy.top().textContent`), /未维护/);
    assert.deepEqual(await js(`({count:legacy.root.children.length,open:legacy.handle.isOpen(),close:legacy.handle.close().status})`), {count:3,open:true,close:'blocked'});
    await js(`legacy.top().querySelector('button').click();`);
    assert.match(await js(`legacy.top().textContent`), /正在取消/);
    assert.deepEqual(await js(`legacy.calls.cancel`), ['selection-fixture-token']);
    await js(`legacy.cancellation.resolve({status:'failed',message:'取消测试失败'});`); await settle();
    assert.match(await js(`legacy.top().textContent`), /取消测试失败/);
    assert.equal(await js(`legacy.root.children.length`), 3);
    await js(`legacy.cancellation=legacy.deferred();legacy.top().querySelector('button').click();legacy.cancellation.resolve({status:'success'});`); await settle();
    assert.deepEqual(await js(`({count:legacy.root.children.length,selectionOpen:legacy.handle.isOpen(),parentTop:legacy.parentHandle.isTop(),calls:legacy.calls.cancel,errors:window.__testErrors})`),
      {count:1,selectionOpen:false,parentTop:true,calls:['selection-fixture-token','selection-fixture-token'],errors:[]});
  });

  await test('大账号数组兼容入口提交失败仍显示错误告警', async () => {
    await setup();
    await js(`legacy.complete=legacy.deferred();legacy.open(()=>legacy.dialogs.createBigAccountSelectionDialog([{label:'测试账号 USD',merchantId:'TEST-ACCOUNT',currency:'USD'}]));
      legacy.overlay.querySelector('input[type="radio"]').click();legacy.overlay.querySelector('[data-action="done"]').click();
      legacy.complete.resolve({status:'error',message:'数组入口选择测试失败',manualBalancePromptReady:false});`);
    await settle();
    assert.match(await js(`legacy.root.textContent`), /数组入口选择测试失败/);
    assert.equal(await js(`legacy.calls.complete.length`), 1);
    assert.equal(await js(`legacy.calls.applied.length`), 1);
  });

  await test('大账号工厂被根关闭资格拒绝时不运行初始化读取', async () => {
    await setup();
    const result = await js(`(async()=>{
      let reads=0;desktopApi.bigAccount.loadMode=async()=>{reads++;return {mode:'unfixed'};};
      const node=legacy.createParent();legacy.bridge.registerModal(node,{canClose:()=>false});legacy.bridge.openModal(()=>node);
      const opened=legacy.bridge.openModal(()=>legacy.dialogs.createBigAccountSelectionDialog({rows:[],expandedBigAccountOptions:[],templateId:7}));
      await legacy.tick();return {status:opened.status,reads,count:legacy.root.children.length,errors:window.__testErrors};
    })()`);
    assert.deepEqual(result, {status:'blocked',reads:0,count:1,errors:[]});
  });
};
