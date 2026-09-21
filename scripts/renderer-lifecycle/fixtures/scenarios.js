'use strict';

// 真实 service/router、场景工厂和 Chromium 宿主；API 只操作 fixture 内存。
module.exports = async ({ js, load, reset, assert, test }) => {
  const settle = () => js('scenarioFixture.tick()');
  async function setup() {
    await reset();
    await load('src/renderer/dialogs/toolbox.js');
    await load('src/renderer-dialogs.js');
    await js(`try {
      window.scenarioFixture = {
        calls:[],events:[],alerts:[],holds:{},failure:null,listeners:{channels:0,scenarios:0},
        rows:[{id:7,category:'extract-recon-id',name:'原场景',priority:1,enabled:true,isBuiltin:false,channelId:1,displayIndex:1,
          config:{conditions:[{field:'CustomerRef',op:'包含',value:'X'}],conditionsLogic:'OR',extractByOtherField:{field:'CustomerRef'},extractByFeature:null}}],
        channels:[{id:1,name:'通用',ownerLocation:'',isBuiltin:true},{id:2,name:'测试渠道',ownerLocation:'HK',isBuiltin:false}],
        tick:()=>new Promise(resolve=>setTimeout(resolve,0)),
        root:document.getElementById('modalRoot'),host:__rendererModalHost,bridge:__rendererModalBridge,
        top(){return this.root.lastElementChild;},
        hold(name){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});this.holds[name]={resolve,reject,promise};return this.holds[name];},
        invoke(name,args,result){this.calls.push({name,args});const held=this.holds[name];if(held){delete this.holds[name];held.result=result;return held.promise;}return Promise.resolve(result);},
        edit(){this.manager.querySelector('[data-row-action="manage"]').click();},
        setName(value){const input=this.top().querySelector('[data-field="name"]');input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}));},
        click(action){const button=this.top().querySelector('[data-action="'+action+'"]');if(!button)throw new Error('缺少操作 '+action);button.click();}
      };
      const f=scenarioFixture;
      const api={ scenarios:{
        list:()=>f.invoke('list',[],{status:'ok',scenarios:structuredClone(f.rows)}),
        get:id=>f.invoke('get',[id],{status:'ok',scenario:structuredClone(f.rows.find(row=>row.id===id))}),
        create:payload=>f.invoke('create',[payload],f.failure||{status:'ok',id:8}),
        update:(id,fields)=>{if(!f.failure)Object.assign(f.rows.find(row=>row.id===id),structuredClone(fields));return f.invoke('update',[id,fields],f.failure||{status:'ok',id});},
        deleteOne:id=>{f.rows=f.rows.filter(row=>row.id!==id);return f.invoke('deleteOne',[id],{status:'ok',id,deleted:true});},
        toggleEnabled:(id,enabled)=>f.invoke('toggleEnabled',[id,enabled],{status:'ok',id,enabled}),
        transfer:payload=>f.invoke('transfer',[payload],{status:'ok',transferredCount:payload.scenarioIds.length,targetChannelId:payload.targetChannelId}),
        batchDelete:ids=>f.invoke('batchDelete',[ids],{status:'ok',deletedCount:ids.length}),
        setApplicableChannels:(id,ids)=>f.invoke('setApplicableChannels',[id,ids],{status:'ok',scenarioId:id,channelIds:ids}),
        applyImport:(id,opts)=>f.invoke('applyImport',[id,opts],{status:'ok',importedCount:0,conflicts:[],createdChannels:[]}),
        exportBundle:ids=>f.invoke('exportBundle',[ids],{status:'cancelled'}),
        getFundTypeEnum:async()=>({status:'ok',values:[]}),getGatewayReconHeaders:async()=>({status:'ok',values:[]}),getApplicableChannels:async()=>({status:'ok',channelIds:[]})
      },channels:{
        list:()=>f.invoke('channelList',[],{status:'ok',channels:structuredClone(f.channels)}),
        create:payload=>{const channel={id:3,...payload,isBuiltin:false};f.channels.push(channel);return f.invoke('channelCreate',[payload],{status:'ok',channel});},
        update:(id,fields)=>{Object.assign(f.channels.find(channel=>channel.id===id),fields);return f.invoke('channelUpdate',[id,fields],{status:'ok',channel:{id,...fields,isBuiltin:false}});},
        deleteOne:id=>{f.channels=f.channels.filter(channel=>channel.id!==id);return f.invoke('channelDelete',[id],{status:'ok',id});}
      },app:{reportLog(){}}};
      window.desktopApi=api;
      f.router=ScenarioChangeRouter.createScenarioChangeRouter();
      f.commands=ScenarioCommandService.createScenarioCommandService({scenariosApi:api.scenarios,channelsApi:api.channels,publish:event=>{
        f.events.push({kind:event.kind,managerOpen:!!f.manager?.isConnected,topTitle:f.top()?.querySelector('.dialog-title')?.textContent});f.router.route(event);
      }});
      f.subscriptions=Object.fromEntries([['subscribeScenarios','scenarios'],['subscribeChannels','channels']].map(([method,key])=>[method,listener=>{f.listeners[key]++;const off=f.router[method](listener);let active=true;return ()=>{if(active){active=false;f.listeners[key]--;off();}};}]));
      f.dialogs=__rendererDialogs.createRendererDialogs({modalBridge:f.bridge,configurationServices:ConfigurationServices.createConfigurationServices({templatesApi:{}}),configurationApi:{},dialogApis:{},reportLog:()=>{},
        appConstants:{bankStatementFields:['CustomerRef','Currency']},scenarioCommands:f.commands,scenarioSubscriptions:f.subscriptions});
      f.open=()=>{const opened=f.bridge.openModal(()=>{f.manager=f.dialogs.createScenariosManagerDialog(['extract-recon-id']);return f.manager;});f.managerHandle=opened.handle;};
      f.open(); } catch(error) { window.fixtureSetupError=error.stack || String(error); } void 0;
    `);
    assert.equal(await js('window.fixtureSetupError || null'), null);
    await settle();
    assert.deepEqual(await js('window.__testErrors'), []);
  }
  await test('场景管理 → 编辑 → 确认 → 返回保留同一管理父层和草稿', async () => {
    await setup();
    await js('scenarioFixture.edit()'); await settle();
    await js(`scenarioFixture.setName('未保存草稿');scenarioFixture.click('confirm');`);
    assert.deepEqual(await js(`({count:scenarioFixture.root.children.length,manager:scenarioFixture.managerHandle.isOpen(),title:scenarioFixture.top().querySelector('.dialog-title').textContent})`),
      {count:2,manager:true,title:'确认场景详情'});
    await js(`scenarioFixture.click('back')`);
    assert.equal(await js(`scenarioFixture.top().querySelector('[data-field="name"]').value`), '未保存草稿');
    await js(`scenarioFixture.click('cancel')`);
    assert.deepEqual(await js(`({count:scenarioFixture.root.children.length,top:scenarioFixture.managerHandle.isTop(),writes:scenarioFixture.calls.filter(call=>call.name==='update').length})`), {count:1,top:true,writes:0});
  });
  await test('保存失败告警关闭后保留草稿，重试成功先通知 service 再返回原父层', async () => {
    await setup(); await js('scenarioFixture.edit()'); await settle();
    await js(`scenarioFixture.setName('失败仍保留');scenarioFixture.click('confirm');scenarioFixture.failure={status:'failed',message:'fixture保存失败'};scenarioFixture.click('finish');`); await settle();
    assert.match(await js(`scenarioFixture.top().textContent`), /fixture保存失败/);
    await js(`scenarioFixture.top().querySelector('button').click()`); await settle();
    assert.deepEqual(await js(`({count:scenarioFixture.root.children.length,name:scenarioFixture.top().querySelector('[data-field="name"]').value})`), {count:2,name:'失败仍保留'});
    await js(`scenarioFixture.failure=null;scenarioFixture.click('confirm');scenarioFixture.click('finish');`); await settle();
    assert.deepEqual(await js(`({count:scenarioFixture.root.children.length,top:scenarioFixture.managerHandle.isTop(),events:scenarioFixture.events.filter(event=>event.kind!=='scenarios-closed')})`),
      {count:1,top:true,events:[{kind:'scenarios-resync-required',managerOpen:true,topTitle:'确认场景详情'}]});
  });
  await test('编辑期间渠道选项通知不重建窗口、不丢名称及条件草稿', async () => {
    await setup(); await js('scenarioFixture.edit()'); await settle();
    await js(`scenarioFixture.setName('渠道更新中的草稿');scenarioFixture.editOverlay=scenarioFixture.top();`);
    await js(`scenarioFixture.commands.channels.create({name:'通知渠道',ownerLocation:'US'})`); await settle();
    assert.deepEqual(await js(`({same:scenarioFixture.top()===scenarioFixture.editOverlay,name:scenarioFixture.top().querySelector('[data-field="name"]').value,count:scenarioFixture.root.children.length,events:scenarioFixture.events.map(event=>event.kind)})`),
      {same:true,name:'渠道更新中的草稿',count:2,events:['configuration-changed']});
  });
  await test('关闭管理层后陈旧 get 晚到不能打开旧编辑窗口', async () => {
    await setup();
    await js(`scenarioFixture.oldGet=scenarioFixture.hold('get');scenarioFixture.edit();scenarioFixture.managerHandle.close();scenarioFixture.open();`); await settle();
    await js(`scenarioFixture.oldGet.resolve(scenarioFixture.oldGet.result)`); await settle();
    assert.deepEqual(await js(`({count:scenarioFixture.root.children.length,top:scenarioFixture.managerHandle.isTop(),draft:!!document.querySelector('.scenario-config-c1')})`), {count:1,top:true,draft:false});
  });
  await test('关闭管理层后陈旧 list 失败不能向新窗口挂告警', async () => {
    await setup();
    await js(`scenarioFixture.managerHandle.close();scenarioFixture.oldList=scenarioFixture.hold('list');scenarioFixture.open();`); await settle();
    await js(`scenarioFixture.managerHandle.close();scenarioFixture.open();`); await settle();
    await js(`scenarioFixture.oldList.resolve({status:'failed',message:'过期列表错误'})`); await settle();
    assert.deepEqual(await js(`({count:scenarioFixture.root.children.length,top:scenarioFixture.managerHandle.isTop(),staleAlert:document.body.textContent.includes('过期列表错误')})`), {count:1,top:true,staleAlert:false});
  });
  await test('同一管理窗口已收到场景变更后，旧 get 晚到不能打开陈旧配置', async () => {
    await setup();
    await js(`scenarioFixture.oldGet=scenarioFixture.hold('get');scenarioFixture.edit();`);
    await js(`scenarioFixture.commands.scenarios.update(7,{name:'更新后场景'})`); await settle();
    await js(`scenarioFixture.oldGet.resolve(scenarioFixture.oldGet.result)`); await settle();
    assert.deepEqual(await js(`({count:scenarioFixture.root.children.length,top:scenarioFixture.managerHandle.isTop(),draft:document.querySelector('.scenario-config-c1 [data-field="name"]')?.value || null})`), {count:1,top:true,draft:null});
  });
  await test('保存双击只发一次原 update，处理中不能关闭确认层', async () => {
    await setup(); await js('scenarioFixture.edit()'); await settle();
    await js(`scenarioFixture.setName('双击保存');scenarioFixture.click('confirm');scenarioFixture.pendingSave=scenarioFixture.hold('update');scenarioFixture.click('finish');scenarioFixture.click('finish');`);
    assert.equal(await js(`scenarioFixture.calls.filter(call=>call.name==='update').length`), 1);
    assert.equal(await js(`scenarioFixture.host.getTop().close().status`), 'blocked');
    await js(`scenarioFixture.pendingSave.resolve(scenarioFixture.pendingSave.result)`); await settle();
    assert.equal(await js('scenarioFixture.managerHandle.isTop()'), true);
  });
  async function openCopy() {
    await js(`scenarioFixture.click('add-scenario');scenarioFixture.setName('复制目标草稿');scenarioFixture.click('copy-scenario');`);
    await settle();
    assert.equal(await js(`!!scenarioFixture.top().querySelector('.copy-scenario-card')`), true);
  }
  await test('复制源渠道/场景通知保留合法选择和目标草稿，最终仅发送create原参数', async () => {
    await setup(); await openCopy();
    await js(`scenarioFixture.copyOverlay=scenarioFixture.top();scenarioFixture.copyOverlay.querySelector('[data-role="scenario-select"]').value='7';`);
    await js(`scenarioFixture.commands.channels.update(2,{name:'新渠道名称',ownerLocation:'HK'});`); await settle();
    await js(`scenarioFixture.commands.scenarios.update(7,{name:'更新后复制源'});`); await settle();
    assert.deepEqual(await js(`({same:scenarioFixture.top()===scenarioFixture.copyOverlay,id:scenarioFixture.top().querySelector('[data-role="scenario-select"]').value,sourceName:scenarioFixture.top().querySelector('[data-role="scenario-select"]').selectedOptions[0].textContent,channels:scenarioFixture.top().querySelector('[data-role="channel-select"]').textContent,listeners:scenarioFixture.listeners})`),
      {same:true,id:'7',sourceName:'更新后复制源',channels:'通用新渠道名称',listeners:{channels:2,scenarios:2}});
    await js(`scenarioFixture.click('confirm');`); await settle();
    assert.equal(await js(`scenarioFixture.top().querySelector('[data-field="name"]').value`), '复制目标草稿');
    assert.deepEqual(await js('scenarioFixture.listeners'), {channels:1,scenarios:1});
    await js(`scenarioFixture.click('confirm');scenarioFixture.click('finish');`); await settle();
    assert.deepEqual(await js(`scenarioFixture.calls.filter(call=>call.name==='create').map(call=>call.args[0])`), [{category:'extract-recon-id',name:'复制目标草稿',priority:0,enabled:true,config:{conditions:[{field:'CustomerRef',op:'包含',value:'X'}],conditionsLogic:'OR',extractByOtherField:{field:'CustomerRef'},extractByFeature:null},channelId:1}]);
  });
  await test('复制源get跨场景/渠道通知或关闭后晚到，均不能进入旧配置', async () => {
    for(const invalidate of ['scenario','channel','close']) {
      await setup(); await openCopy();
      await js(`scenarioFixture.copyOverlay=scenarioFixture.top();scenarioFixture.top().querySelector('[data-role="scenario-select"]').value='7';scenarioFixture.copyGet=scenarioFixture.hold('get');scenarioFixture.click('confirm');`);
      if(invalidate==='scenario') { await js(`scenarioFixture.commands.scenarios.deleteOne(7);`); }
      else if(invalidate==='channel') { await js(`scenarioFixture.commands.channels.update(2,{name:'新渠道',ownerLocation:'HK'});`); }
      else { await js(`scenarioFixture.click('cancel');`); }
      await settle();
      await js(`scenarioFixture.copyGet.resolve(scenarioFixture.copyGet.result);`); await settle();
      if(invalidate==='close') {
        assert.equal(await js(`scenarioFixture.top().querySelector('[data-field="name"]').value`), '复制目标草稿');
        assert.equal(await js(`scenarioFixture.top().textContent.includes('X')`), false);
      } else {
        assert.equal(await js('scenarioFixture.top()===scenarioFixture.copyOverlay'), true);
        assert.equal(await js(`scenarioFixture.top().querySelector('[data-role="scenario-select"]').value`), invalidate==='scenario'?'':'7');
      }
    }
  });
  await test('复制源旧list晚到不覆盖通知后的选项，最终销毁退订一次', async () => {
    await setup();
    await js(`scenarioFixture.copyList=scenarioFixture.hold('list');scenarioFixture.click('add-scenario');scenarioFixture.setName('列表草稿');scenarioFixture.click('copy-scenario');`); await settle();
    await js(`scenarioFixture.commands.scenarios.update(7,{name:'通知后源名称'});`); await settle();
    await js(`scenarioFixture.copyList.resolve(scenarioFixture.copyList.result);`); await settle();
    assert.match(await js(`scenarioFixture.top().querySelector('[data-role="scenario-select"]').textContent`), /通知后源名称/);
    await js(`scenarioFixture.managerHandle.dispose();scenarioFixture.managerHandle.dispose();`);
    assert.deepEqual(await js('scenarioFixture.listeners'), {channels:0,scenarios:0});
  });
  await test('导出渠道订阅保留勾选、移除已删除项、旧list晚到无覆盖并退出退订', async () => {
    await setup();
    await js(`scenarioFixture.exportList=scenarioFixture.hold('channelList');scenarioFixture.click('export-scenario-bundle');void 0;`); await settle();
    await js(`scenarioFixture.commands.channels.update(2,{name:'通知后导出渠道',ownerLocation:'HK'});`); await settle();
    await js(`scenarioFixture.exportList.resolve(scenarioFixture.exportList.result);`); await settle();
    assert.match(await js('scenarioFixture.top().textContent'), /通知后导出渠道/);
    await js(`scenarioFixture.top().querySelector('[data-channel-id="2"]').checked=false;scenarioFixture.commands.channels.create({name:'新增导出渠道',ownerLocation:'US'});`); await settle();
    assert.deepEqual(await js(`Array.from(scenarioFixture.top().querySelectorAll('[data-channel-id]'),checkbox=>[checkbox.dataset.channelId,checkbox.checked])`), [['1',true],['2',false],['3',true]]);
    await js(`scenarioFixture.originalChannelList=desktopApi.channels.list;scenarioFixture.channelReadCount=0;scenarioFixture.exportRefresh=scenarioFixture.hold('manualChannels');desktopApi.channels.list=()=>{const response=scenarioFixture.originalChannelList();if(++scenarioFixture.channelReadCount!==2)return response;response.then(result=>{scenarioFixture.exportRefresh.result=result;});return scenarioFixture.exportRefresh.promise;};scenarioFixture.commands.channels.update(2,{name:'再次更新渠道',ownerLocation:'HK'});`); await settle();
    await js(`scenarioFixture.top().querySelector('[data-channel-id="3"]').checked=false;scenarioFixture.exportRefresh.resolve(scenarioFixture.exportRefresh.result);`); await settle();
    assert.equal(await js(`scenarioFixture.top().querySelector('[data-channel-id="3"]').checked`), false, '读请求在途作出的改选也必须保留');
    await js(`desktopApi.channels.list=scenarioFixture.originalChannelList;scenarioFixture.top().querySelector('[data-channel-id="3"]').checked=true;`);
    await js(`scenarioFixture.commands.channels.deleteOne(1);`); await settle();
    assert.deepEqual(await js(`Array.from(scenarioFixture.top().querySelectorAll('[data-channel-id]'),checkbox=>[checkbox.dataset.channelId,checkbox.checked])`), [['2',false],['3',true]]);
    await js(`scenarioFixture.click('confirm-export');`); await settle();
    assert.deepEqual(await js(`scenarioFixture.calls.filter(call=>call.name==='exportBundle').map(call=>call.args[0])`), [[3]]);
    await js(`scenarioFixture.click('cancel-export');`);
    assert.deepEqual(await js('scenarioFixture.listeners'), {channels:1,scenarios:1});
  });

};
