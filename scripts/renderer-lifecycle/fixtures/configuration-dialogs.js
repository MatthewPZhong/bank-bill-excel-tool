'use strict';

// 真实配置工厂/宿主/桥接，API 仅用可控 Promise，不读写真实账户或配置。
module.exports = async ({ js, load, reset, assert, test, layout }) => {
  const tick = () => js('new Promise(resolve=>setTimeout(resolve,5))');
  // layoutOptions：加载生产样式的真实窗口，用于检查布局。
  async function setup(layoutOptions = null) {
    await reset(undefined, layoutOptions ? { layout: layoutOptions } : undefined);
    await load('src/renderer/dialogs/toolbox.js');
    await load('src/renderer/module-router.js');
    await load('src/renderer-dialogs.js');
    await js(`
      window.cfg={calls:[],feedback:[],next:{},done:0,applied:0,errors:[],
        defer(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};},
        invoke(name,args,fallback){this.calls.push({name,args});const next=this.next[name];delete this.next[name];return next?.promise||Promise.resolve(next===undefined?fallback:next);},
        top(){return document.getElementById('modalRoot').lastElementChild;},
        other(){return this.bridge.openModal(()=>this.dialogs.createAlertDialog('后来打开的窗口')).handle;},
        mappings(id){return [{bankAccountId:id+'-ACCOUNT',clearingAccountId:id+'-CLEARING',noCurrency:false,currency:id==='A'?'USD':'HKD'}];}
      };
      cfg.templates=[{id:1,name:'模板 A',headers:['Currency']},{id:2,name:'模板 B',headers:['Currency']}];
      cfg.host=__rendererModalHost;cfg.bridge=__rendererModalBridge;
      cfg.api={app:{getInfo:()=>cfg.invoke('info',[],{accountMappingCount:1})},
        templates:{list:()=>cfg.invoke('refresh',[],cfg.templates),rename:payload=>cfg.invoke('rename',[payload],{status:'success',message:'重命名完成'}),
          importBundle:()=>cfg.invoke('import',[],{status:'success',message:'导入完成'}),deleteTemplate:id=>cfg.invoke('delete',[id],{status:'success'}),
          saveMappings:payload=>cfg.invoke('mappingSave',[payload],{status:'success',message:'映射保存完成'}),
          importChild:id=>cfg.invoke('importChild',[id],{status:'success',message:'已导入子模板「渠道 A-子模板-1」'}),
          saveAmountSplitRules:payload=>cfg.invoke('amount',[payload],{status:'success'}),saveBillSplitMappings:payload=>cfg.invoke('splitMapping',[payload],{status:'success'}),
          saveFeatureFilters:payload=>cfg.invoke('featureSave',[payload],(()=>{let max=0;payload.featureFilters.forEach(item=>{if(/^\\d+$/.test(item.id||''))max=Math.max(max,Number(item.id));});
            return {status:'success',featureFilters:payload.featureFilters.map(item=>item.id?{...item}:{...item,id:String(++max)})};})()),
          saveBillSplitAmountRules:payload=>cfg.invoke('splitAmount',[payload],{status:'success'}),
          getMappings:id=>cfg.invoke('templateRead',[id],{status:'success',template:cfg.templates[0],targetFields:[],mappings:[]}),
          previewHeaderUpdate:id=>cfg.invoke('headerPreview',[id],{status:'cancelled'}),
          updateHeaders:payload=>cfg.invoke('headerUpdate',[payload],{status:'success',message:'模板「模板 A」已更新，映射关系已保留',staleMappings:[],activeStaleCount:0})},
        accountMappings:{list:id=>cfg.invoke('list',[id],{status:'success',mappings:[]}),
          save:(id,mappings)=>cfg.invoke('save',[id,mappings],{status:'success',message:'保存完成'}),
          listChannelConflicts:()=>cfg.invoke('conflicts',[],{status:'success',channels:[]}),
          resolveChannelConflicts:payload=>cfg.invoke('resolveConflicts',[payload],{status:'success',remaining:0}),
          distributeMigration:assignments=>cfg.invoke('migration',[assignments],{status:'success'})},
        statementChannels:{list:()=>cfg.invoke('channels',[],[]),rename:payload=>cfg.invoke('channelRename',[payload],{status:'success',message:'渠道名称修改成功'}),
          delete:id=>cfg.invoke('channelDelete',[id],{status:'success',message:'渠道已删除'})}};
      cfg.api.balanceAdjustment={list:async()=>({adjustments:[{merchantId:'M001',currency:'USD',effectiveDate:'2026-09-01',adjustmentValue:'10',remark:'原备注'}]}),save:payload=>cfg.invoke('addon',[payload],{status:'success',message:'余额保存完成'})};
      cfg.api.balanceSeeds={list:owner=>cfg.invoke('seedList',[owner],cfg.seedList?cfg.seedList(owner):{status:'success',records:[]}),
        update:payload=>cfg.invoke('seedUpdate',[payload],{status:'success',changed:true,message:'余额种子已修改'}),
        delete:payload=>cfg.invoke('seedDelete',[payload],{status:'success',message:'余额种子已删除'})};
      cfg.api.files={saveBalanceSeed:payload=>cfg.invoke('seed',[payload],{status:'success'}),completeBigAccountSelection:payload=>cfg.invoke('simpleSelection',[payload],{status:'success'}),
        importBalanceSeedFile:()=>cfg.invoke('balanceImport',[],{status:'cancelled'})};
      cfg.rules=[{targetField:'Credit Amount',conditionField:'Currency',conditionValue:'C',mappedField:'Amount',rowIndex:0},{targetField:'Debit Amount',conditionField:'Currency',conditionValue:'D',mappedField:'Amount',rowIndex:1}];
      cfg.services=ConfigurationServices.createConfigurationServices({templatesApi:cfg.api.templates});
      cfg.services.acceptBootstrap({currencyOptions:['USD','HKD']});cfg.services.applyPreviewTemplates(cfg.templates);
      cfg.dialogs=__rendererDialogs.createRendererDialogs({modalBridge:cfg.bridge,configurationServices:cfg.services,configurationApi:cfg.api,dialogApis:{},reportLog:()=>{},
        scenarioCommands:ScenarioCommandService.createScenarioCommandService({scenariosApi:{},channelsApi:{}}),scenarioSubscriptions:ScenarioChangeRouter.createScenarioChangeRouter(),
        appConstants:{},ADVANCED_MAPPING_FIELDS:[],CONCAT_FIELDS_MAPPING_FIELD:'需要拼接字段',FEATURE_FILTER_MAPPING_FIELD:'字段筛选特征值',MERCHANT_ID_SELF_INPUT_OPTION:'自己输入',MERCHANT_ID_CURRENCY_ONLY_OPTION:'原始账单仅有币种无账户号',AMOUNT_SPLIT_BY_FIELD_MAPPING_FIELD:'按字段区分发生额',AMOUNT_SPLIT_BY_FIELD_ENABLED_OPTION:'是',setStatus:(...args)=>cfg.feedback.push(args),applyStatementResult:()=>cfg.applied++,applyManualBalancePromptStatus:()=>cfg.applied++});
      cfg.openMapping=()=>{cfg.handle=cfg.bridge.openModal(()=>cfg.dialogs.createAccountMappingDialog({currentTemplateId:1,templates:cfg.templates,mappings:cfg.mappings('A')})).handle;
        cfg.overlay=cfg.top();cfg.select=cfg.overlay.querySelector('[data-role="template-select"]');cfg.save=cfg.overlay.querySelector('[data-action="done"]');};
      cfg.choose=id=>{cfg.select.value='template:'+id;cfg.select.dispatchEvent(new Event('change'));};
      cfg.openMigration=()=>{cfg.handle=cfg.bridge.openModal(()=>cfg.dialogs.createAccountMappingMigrationDialog({rows:cfg.mappings('A'),templates:cfg.templates,onDone:()=>cfg.done++})).handle;
        cfg.overlay=cfg.top();cfg.overlay.querySelector('.migration-template-select').value='2';cfg.save=cfg.overlay.querySelector('[data-action="done"]');};
      window.addEventListener('unhandledrejection',event=>cfg.errors.push(String(event.reason?.message||event.reason)));
      void 0;
    `);
  }
  await test('账户映射 A/B 交错读取只显示并保存 B 的账户身份', async () => {
    await setup();
    await js(`cfg.openMapping();cfg.readA=cfg.defer();cfg.next.list=cfg.readA;cfg.choose(1);cfg.readB=cfg.defer();cfg.next.list=cfg.readB;cfg.choose(2);
      cfg.readB.resolve({status:'success',mappings:cfg.mappings('B')});`); await tick();
    await js(`cfg.readA.resolve({status:'success',mappings:cfg.mappings('A')});`); await tick();
    assert.match(await js(`cfg.overlay.querySelector('tbody').textContent`), /B-ACCOUNT/);
    assert.doesNotMatch(await js(`cfg.overlay.querySelector('tbody').textContent`), /A-ACCOUNT/);
    await js('cfg.save.click()'); await tick();
    assert.deepEqual(await js(`cfg.calls.filter(call=>call.name==='save').map(call=>call.args)`), [[{templateId:2},[{bankAccountId:'B-ACCOUNT',clearingAccountId:'B-CLEARING',noCurrency:true,currency:'HKD'}]]]);
  });
  await test('账户映射加载中及失败不保存旧模板行，重读合法空映射后可保存', async () => {
    await setup();
    await js(`cfg.openMapping();cfg.read=cfg.defer();cfg.next.list=cfg.read;cfg.choose(2);cfg.save.dispatchEvent(new Event('click'));`);
    assert.equal(await js(`cfg.calls.filter(call=>call.name==='save').length`), 0);
    assert.equal(await js('cfg.save.disabled'), true);
    await js(`cfg.read.resolve({status:'error',message:'模板 B 加载失败',errorReportReady:true});`); await tick();
    assert.match(await js('cfg.top().textContent'), /模板 B 加载失败/);
    await js(`cfg.host.closeTop();cfg.save.dispatchEvent(new Event('click'));`);
    assert.equal(await js(`cfg.calls.filter(call=>call.name==='save').length`), 0);
    await js(`cfg.choose(2);`); await tick();
    assert.equal(await js('cfg.save.disabled'), false);
    await js(`cfg.save.click();`); await tick();
    assert.deepEqual(await js(`cfg.calls.find(call=>call.name==='save').args`), [{templateId:2},[]]);
  });
  await test('账户映射保存冻结模板身份且只发一次，失败告警返回原稿可重试', async () => {
    await setup();
    await js(`cfg.openMapping();cfg.write=cfg.defer();cfg.next.save=cfg.write;cfg.save.click();cfg.save.dispatchEvent(new Event('click'));`);
    assert.equal(await js(`cfg.calls.filter(call=>call.name==='save').length`), 1);
    assert.equal(await js('cfg.select.disabled'), true);
    assert.equal(await js('cfg.handle.close().status'), 'blocked');
    await js(`cfg.write.resolve({status:'error',message:'保存失败',errorReportReady:true});`); await tick();
    assert.match(await js('cfg.top().textContent'), /保存失败/);
    await js('cfg.host.closeTop();');
    assert.equal(await js('cfg.handle.isTop()&&!cfg.save.disabled&&!cfg.select.disabled'), true);
    assert.match(await js('cfg.overlay.textContent'), /A-ACCOUNT/);
    await js('cfg.save.click();'); await tick();
    assert.equal(await js(`cfg.calls.filter(call=>call.name==='save').length`), 2);
    assert.equal(await js('cfg.services.getAccountMappingCount()'), 1);
  });
  await test('账户映射结束后的迟到读取不修改旧 DOM 或新窗口', async () => {
    await setup();
    await js(`cfg.openMapping();cfg.read=cfg.defer();cfg.next.list=cfg.read;cfg.choose(2);cfg.handle.close();cfg.markup=cfg.overlay.innerHTML;cfg.newHandle=cfg.other();cfg.read.resolve({status:'success',mappings:cfg.mappings('B')});`); await tick();
    assert.equal(await js('cfg.markup===cfg.overlay.innerHTML&&cfg.newHandle.isTop()'), true);
  });
  for (const status of ['success','error']) await test('模板管理关闭后迟到 '+status+' 不替换新弹窗', async () => {
    await setup();
    await js(`cfg.read=cfg.defer();cfg.next.templateRead=cfg.read;cfg.handle=cfg.bridge.openModal(()=>cfg.dialogs.createTemplateManagerDialog()).handle;
      cfg.top().querySelector('[data-action="manage"]').click();cfg.handle.close();cfg.newHandle=cfg.other();
      cfg.read.resolve({status:${JSON.stringify(status)},message:'迟到错误',template:cfg.templates[0],targetFields:[],mappings:[]});`); await tick();
    assert.equal(await js('cfg.newHandle.isTop()'), true);
    assert.equal(await js('document.getElementById("modalRoot").children.length'), 1);
  });
  await test('模板管理正常读取仍进入实际映射编辑窗', async () => {
    await setup();
    await js(`cfg.bridge.openModal(()=>cfg.dialogs.createTemplateManagerDialog());cfg.top().querySelector('[data-action="manage"]').click();`); await tick();
    assert.match(await js('cfg.top().textContent'), /映射关系管理/);
  });
  await test('迁移分配保存 busy 阻止关闭及重复提交，失败返回可重试，成功一次完成', async () => {
    await setup();
    await js(`cfg.openMigration();cfg.write=cfg.defer();cfg.next.migration=cfg.write;cfg.save.click();cfg.save.dispatchEvent(new Event('click'));`);
    assert.equal(await js(`cfg.calls.filter(call=>call.name==='migration').length`), 1);
    assert.equal(await js('cfg.handle.close().status'), 'blocked');
    await js(`cfg.write.resolve({status:'error',message:'分配失败'});`); await tick();
    await js('cfg.host.closeTop();');
    assert.equal(await js('cfg.handle.isTop()&&!cfg.save.disabled'), true);
    assert.equal(await js('cfg.overlay.querySelector(".migration-template-select").value'), '2');
    await js('cfg.save.click();'); await tick();
    assert.equal(await js('cfg.handle.isOpen()'), false);
    assert.equal(await js('cfg.done'), 1);
    assert.deepEqual(await js(`cfg.calls.filter(call=>call.name==='migration').map(call=>call.args[0][0].templateId)`), [2,2]);
  });
  await test('迁移强制结束后后台成功保留反馈，不关闭新窗或重新触发配置入口', async () => {
    await setup();
    await js(`cfg.openMigration();cfg.write=cfg.defer();cfg.next.migration=cfg.write;cfg.save.click();cfg.handle.dispose();cfg.newHandle=cfg.other();cfg.write.resolve({status:'success'});`); await tick();
    assert.equal(await js('cfg.newHandle.isTop()'), true);
    assert.equal(await js('cfg.done'), 0);
    assert.equal(await js(`cfg.feedback.some(entry=>entry[0]==='账户映射分配完成')`), true);
  });
  await test('模板管理最新修改请求胜出，错误告警关闭返回同一管理层', async () => {
    await setup();
    await js(`cfg.handle=cfg.bridge.openModal(()=>cfg.dialogs.createTemplateManagerDialog()).handle;cfg.overlay=cfg.top();
      cfg.readA=cfg.defer();cfg.next.templateRead=cfg.readA;cfg.overlay.querySelectorAll('[data-action="manage"]')[0].click();
      cfg.readB=cfg.defer();cfg.next.templateRead=cfg.readB;cfg.overlay.querySelectorAll('[data-action="manage"]')[1].click();
      cfg.readA.resolve({status:'success',template:cfg.templates[0],targetFields:[],mappings:[]});`); await tick();
    assert.equal(await js('cfg.handle.isTop()'), true);
    await js(`cfg.readB.resolve({status:'error',message:'当前模板读取失败'});`); await tick();
    assert.equal(await js('cfg.handle.isOpen()'), true);
    assert.match(await js('cfg.top().textContent'), /当前模板读取失败/);
    await js('cfg.host.closeTop();');
    assert.equal(await js('cfg.handle.isTop()&&cfg.top()===cfg.overlay'), true);
  });
  await test('账户映射和迁移 IPC reject 解除 busy，错误留在原层且不自动重试', async () => {
    for (const [open, method] of [['openMapping','save'],['openMigration','migration']]) {
      await setup();
      await js(`cfg.${open}();cfg.write=cfg.defer();cfg.next.${method}=cfg.write;cfg.save.click();cfg.write.reject(new Error('IPC 断开'));`); await tick();
      assert.equal(await js(`cfg.calls.filter(call=>call.name===${JSON.stringify(method)}).length`), 1);
      assert.match(await js('cfg.top().textContent'), /IPC 断开/);
      await js('cfg.host.closeTop();');
      assert.equal(await js('cfg.handle.isTop()&&!cfg.save.disabled'), true);
      assert.deepEqual(await js('cfg.errors'), []);
    }
  });

  for (const operation of ['rename','import','delete','mappingSave']) await test('模板 '+operation+' 写后返回只属于原窗口，busy/重复门控不截断后台刷新', async () => {
    await setup();
    await js(`cfg.write=cfg.defer();cfg.next.${operation}=cfg.write;void 0;`);
    if (operation==='rename') await js(`cfg.handle=cfg.bridge.openModal(()=>cfg.dialogs.createTemplateRenameDialog(cfg.templates[0])).handle;cfg.action=cfg.top().querySelector('[data-action="done"]');void 0;`);
    if (operation==='import') await js(`cfg.handle=cfg.bridge.openModal(()=>cfg.dialogs.createTemplateManagerDialog()).handle;cfg.action=cfg.top().querySelector('[data-action="import-bundle"]');void 0;`);
    if (operation==='delete') await js(`cfg.manager=cfg.bridge.openModal(()=>cfg.dialogs.createTemplateManagerDialog()).handle;cfg.top().querySelector('[data-action="delete"]').click();cfg.handle=cfg.host.getTop();cfg.action=cfg.top().querySelector('[data-action="confirm"]');void 0;`);
    if (operation==='mappingSave') await js(`cfg.handle=cfg.bridge.openModal(()=>cfg.dialogs.createMappingDialog({template:cfg.templates[0],targetFields:[],mappings:[]})).handle;cfg.action=cfg.top().querySelector('[data-action="done"]');void 0;`);
    await js('cfg.action.click();cfg.action.dispatchEvent(new Event("click"));');
    assert.equal(await js(`cfg.calls.filter(call=>call.name===${JSON.stringify(operation)}).length`), 1);
    assert.equal(await js('cfg.handle.close().status'), 'blocked');
    await js(`cfg.handle.dispose();cfg.manager?.dispose();cfg.newHandle=cfg.other();cfg.write.resolve({status:'success',message:'后台写入完成'});`); await tick();
    assert.equal(await js('cfg.newHandle.isTop()'), true);
    assert.equal(await js(`cfg.calls.filter(call=>call.name==='refresh').length`), 1);
  });
  await test('渠道归属随映射一次提交，使用提交时快照；原窗结束后的成功不接管新窗', async () => {
    await setup();
    await js(`cfg.templates[1].name='渠道 A';cfg.templates[1].channelId=7;cfg.templates[1].channelName='渠道 A';cfg.templates[0].name='任意名称';cfg.services.applyPreviewTemplates(cfg.templates);
      cfg.handle=cfg.bridge.openModal(()=>cfg.dialogs.createMappingDialog({template:cfg.templates[0],targetFields:[],mappings:[]})).handle;
      cfg.overlay=cfg.top();cfg.child=cfg.overlay.querySelector('[data-role="is-child"]');cfg.channel=cfg.overlay.querySelector('[data-role="channel-select"]');
      cfg.child.checked=true;cfg.child.dispatchEvent(new Event('change'));cfg.channel.value='7';cfg.write=cfg.defer();cfg.next.mappingSave=cfg.write;cfg.overlay.querySelector('[data-action="done"]').click();
      cfg.child.checked=false;cfg.channel.value='';cfg.handle.dispose();cfg.newHandle=cfg.other();cfg.write.resolve({status:'success',message:'映射已保存'});`); await tick();
    assert.deepEqual(await js(`cfg.calls.filter(call=>call.name==='mappingSave').map(call=>call.args[0].channel)`), [{mode:'join',channelId:7}]);
    assert.equal(await js(`cfg.overlay.textContent.includes('主模板')`), false);
    assert.equal(await js('cfg.newHandle.isTop()'), true);
  });
  await test('渠道两个勾选互斥：新建渠道提交 create，渠道子模板取消勾选提交 none，未改归属不带 channel', async () => {
    const open = (templateIndex) => js(`cfg.handle=cfg.bridge.openModal(()=>cfg.dialogs.createMappingDialog({template:cfg.templates[${templateIndex}],targetFields:[],mappings:[]})).handle;
      cfg.overlay=cfg.top();cfg.create=cfg.overlay.querySelector('[data-role="create-channel"]');cfg.child=cfg.overlay.querySelector('[data-role="is-child"]');void 0;`);
    await setup();
    await js(`cfg.templates[1].channelId=7;cfg.templates[1].channelName='渠道 A';cfg.services.applyPreviewTemplates(cfg.templates);`);
    await open(1);
    assert.equal(await js(`cfg.child.checked&&cfg.overlay.querySelector('[data-role="channel-select"]').value==='7'`), true);
    await js(`cfg.create.checked=true;cfg.create.dispatchEvent(new Event('change'));`);
    assert.equal(await js('cfg.child.checked'), false);
    await js(`cfg.child.checked=true;cfg.child.dispatchEvent(new Event('change'));`);
    assert.equal(await js('cfg.create.checked'), false);
    await js(`cfg.child.checked=false;cfg.child.dispatchEvent(new Event('change'));cfg.overlay.querySelector('[data-action="done"]').click();`); await tick();
    await js('cfg.host.closeAll?.();');
    await open(0);
    await js(`cfg.create.checked=true;cfg.create.dispatchEvent(new Event('change'));cfg.overlay.querySelector('[data-action="done"]').click();`); await tick();
    await open(0);
    await js(`cfg.overlay.querySelector('[data-action="done"]').click();`); await tick();
    assert.deepEqual(await js(`cfg.calls.filter(call=>call.name==='mappingSave').map(call=>call.args[0].channel||null)`), [{mode:'none'},{mode:'create'},null]);
  });
  // 标题右侧 Tips：说明在标题内的气泡里，标题文字节点保持原标题，正文不再保留原说明元素。
  const titleTips = (bodyHintSelector) => js(`{const title=cfg.top().querySelector('.dialog-header .dialog-title'),tips=title.querySelector('.title-tips');
    ({title:title.firstChild.textContent,hidden:tips.hidden,mark:tips.querySelector('svg.title-tips-mark text').textContent,
      bubble:tips.querySelector('.title-tips-bubble').textContent,bodyHint:Boolean(cfg.top().querySelector('${bodyHintSelector}'))});}`);

  await test('重命名渠道：改名影响说明收进标题 Tips，表单下不再保留说明', async () => {
    await setup();
    await js(`cfg.templates.push({id:3,name:'渠道 A',channelId:7,channelName:'渠道 A',bigAccountSummary:'来自账单'});
      cfg.services.applyPreviewTemplates(cfg.templates);cfg.manager=cfg.bridge.openModal(()=>cfg.dialogs.createTemplateManagerDialog()).handle;
      cfg.top().querySelector('.template-channel-row [data-action="rename"]').click();void 0;`);
    assert.deepEqual(await titleTips('.channel-rename-hint'), { title: '重命名渠道', hidden: false, mark: 'Tips',
      bubble: '渠道下子模板的账单按渠道名输出。改名后，Channel 列、余额账单的银行名称与所在地、导出文件名随之改变，余额种子与余额附加值改按新名称的银行段读取。已有子模板不会随之改名。',
      bodyHint: false });
  });
  await test('模板管理渠道行：子模板默认折叠，导入子模板后刷新并展开该渠道；删除渠道先确认', async () => {
    await setup();
    await js(`cfg.templates.push({id:3,name:'渠道 A',channelId:7,channelName:'渠道 A',bigAccountSummary:'来自账单'},{id:4,name:'渠道 A-子模板-1',channelId:7,channelName:'渠道 A',bigAccountSummary:'未设置'});
      cfg.services.applyPreviewTemplates(cfg.templates);cfg.manager=cfg.bridge.openModal(()=>cfg.dialogs.createTemplateManagerDialog()).handle;void 0;`);
    const rowState = () => js(`Array.from(cfg.top().querySelectorAll('tbody tr')).map(row=>[row.className,row.querySelector('td').textContent.replace(/\s+/g,' ').trim(),row.style.display])`);
    const collapsed = await rowState();
    assert.deepEqual(collapsed.map(([cls, , display]) => [cls, display]).slice(0, 3), [['template-channel-row',''],['template-child-row','none'],['template-child-row','none']]);
    assert.match(collapsed[0][1], /渠道 A/);
    assert.equal(await js(`cfg.top().querySelector('.template-channel-row').textContent.includes('导入子模板')`), true);
    await js(`cfg.top().querySelector('.template-channel-row [data-action="import-child"]').click();`); await tick(); await tick();
    assert.deepEqual(await js(`cfg.calls.filter(call=>call.name==='importChild').map(call=>call.args)`), [[7]]);
    const expanded = await rowState();
    assert.deepEqual(expanded.slice(1, 3).map(([cls, , display]) => [cls, display]), [['template-child-row',''],['template-child-row','']]);
    await js(`cfg.top().querySelector('.template-channel-row [data-action="delete"]').click();`);
    assert.match(await js('cfg.top().textContent'), /子模板恢复为普通模板/);
    await js(`cfg.top().querySelector('[data-action="confirm"]').click();`); await tick();
    assert.deepEqual(await js(`cfg.calls.filter(call=>call.name==='channelDelete').map(call=>call.args)`), [[7]]);
    assert.match(await js('cfg.top().textContent'), /模板管理/);
  });
  await test('模板管理【余额管理】：左下角入口，下拉分渠道与普通模板，切换时丢弃迟到列表', async () => {
    await setup();
    await js(`cfg.templates.push({id:3,name:'渠道 A',channelId:7,channelName:'渠道 A'},{id:4,name:'渠道 A-子模板-1',channelId:7,channelName:'渠道 A'});
      cfg.services.applyPreviewTemplates(cfg.templates);
      cfg.seedRecords=[{merchantId:'M001',currency:'USD',billDate:'2026-09-02',endBalance:1010,generationMethod:'通过发生额计算',templateName:'渠道 A',updatedAt:'u2'},
        {merchantId:'M001',currency:'USD',billDate:'2026-09-01',endBalance:1000,generationMethod:'人工录入',templateName:'渠道 A',updatedAt:'u1'}];
      cfg.seedList=owner=>({status:'success',owner:{kind:owner.kind,id:owner.id,seedFileName:'渠道.json'},records:owner.kind==='channel'?cfg.seedRecords:[]});
      cfg.manager=cfg.bridge.openModal(()=>cfg.dialogs.createTemplateManagerDialog()).handle;cfg.managerOverlay=cfg.top();void 0;`);
    assert.deepEqual(await js(`Array.from(cfg.managerOverlay.querySelector('.template-manager-bundle-actions').children).map(item=>item.dataset.action||item.className)`),
      ['balance-seed-management', 'template-manager-bundle-right']);
    await js(`cfg.managerOverlay.querySelector('[data-action="balance-seed-management"]').click();cfg.overlay=cfg.top();cfg.select=cfg.overlay.querySelector('[data-role="balance-seed-owner"]');void 0;`); await tick();
    assert.deepEqual(await js(`{const title=cfg.overlay.querySelector('.dialog-header .dialog-title');[title.firstChild.textContent,title.nextElementSibling.firstChild.textContent.trim(),title.nextElementSibling.lastElementChild===cfg.select];}`),
      ['余额管理', '渠道', true]);
    assert.deepEqual(await js(`Array.from(cfg.select.querySelectorAll('optgroup')).map(group=>[group.label,Array.from(group.children).map(option=>[option.value,option.textContent])])`),
      [['渠道', [['channel:7', '渠道 A']]], ['普通模板', [['template:1', '模板 A'], ['template:2', '模板 B']]]]);
    assert.equal(await js('cfg.select.value'), 'channel:7');
    assert.deepEqual(await js(`cfg.calls.filter(call=>call.name==='seedList').map(call=>call.args[0])`), [{kind:'channel',id:7}]);
    assert.deepEqual(await js(`Array.from(cfg.overlay.querySelectorAll('tbody tr')).map(row=>Array.from(row.cells).slice(0,5).map(cell=>cell.textContent.trim()))`),
      [['2026-09-02', 'M001', 'USD', '1010', '通过发生额计算'], ['2026-09-01', 'M001', 'USD', '1000', '人工录入']]);
    assert.deepEqual(await js(`Array.from(cfg.overlay.querySelectorAll('thead th')).map(cell=>cell.textContent.trim())`),
      ['日期', '账户号', '币种', '余额', '生成方式', '执行操作']);
    assert.equal(await js(`cfg.overlay.querySelector('[data-role="balance-seed-hint"]').textContent`), '共 2 条');
    assert.deepEqual(await js(`{const tips=cfg.overlay.querySelector('.dialog-title .title-tips');[tips.hidden,tips.querySelector('.title-tips-bubble').textContent];}`),
      [false, '种子文件 balance-seeds/渠道.json 按名称的银行段存放，生成账单时按账户号与币种读取；修改后的余额按「人工录入」处理。']);
    await js(`cfg.readA=cfg.defer();cfg.next.seedList=cfg.readA;cfg.select.value='template:1';cfg.select.dispatchEvent(new Event('change'));
      cfg.readB=cfg.defer();cfg.next.seedList=cfg.readB;cfg.select.value='channel:7';cfg.select.dispatchEvent(new Event('change'));void 0;`);
    assert.deepEqual(await js(`[cfg.overlay.querySelector('[data-role="balance-seed-hint"]').textContent,cfg.overlay.querySelector('.dialog-title .title-tips').hidden]`),
      ['正在读取余额种子…', true]);
    await js(`cfg.readB.resolve(cfg.seedList({kind:'channel',id:7}));`); await tick();
    await js(`cfg.readA.resolve({status:'success',owner:{seedFileName:'模板.json'},records:[{merchantId:'T-STALE',currency:'USD',billDate:'2026-09-01',endBalance:1,generationMethod:'人工录入',templateName:'模板 A',updatedAt:''}]});`); await tick();
    assert.doesNotMatch(await js(`cfg.overlay.querySelector('tbody').textContent`), /T-STALE/);
    assert.match(await js(`cfg.overlay.querySelector('tbody').textContent`), /1010/);
    assert.equal(await js(`cfg.overlay.querySelector('.dialog-actions [data-action="back"]').textContent`), '返回');
    assert.equal(await js(`Boolean(cfg.overlay.querySelector('[data-action="done"]'))`), false);
    await js(`cfg.overlay.querySelector('[data-action="back"]').click();`);
    assert.equal(await js('cfg.manager.isTop()&&cfg.top()===cfg.managerOverlay'), true);
  });
  await test('余额管理表格：日期在首列，列名与数据单行；100%/150% 均无横向滚动，三列等宽且编辑态不改列宽', async () => {
    await setup({ zoom: 1 });
    await js(`cfg.templates.push({id:3,name:'渠道 A',channelId:7,channelName:'渠道 A'});cfg.services.applyPreviewTemplates(cfg.templates);
      cfg.seedRecords=[['2026-09-30','622202100112345678901','USD',1250000,'通过发生额计算'],['2026-09-30','622202100112345678901','HKD',98765.43,'人工录入'],
        ['2026-09-29','6217000010012345','CNY',15320.8,'通过发生额计算'],['2026-09-28','NRA0123456789012345678','EUR',4500.25,'人工录入']]
        .map(([billDate,merchantId,currency,endBalance,generationMethod])=>({billDate,merchantId,currency,endBalance,generationMethod,templateName:'渠道 A',updatedAt:'u'}));
      cfg.seedList=owner=>({status:'success',owner:{kind:owner.kind,id:owner.id,seedFileName:'渠道.json'},records:cfg.seedRecords});
      cfg.manager=cfg.bridge.openModal(()=>cfg.dialogs.createTemplateManagerDialog()).handle;
      cfg.top().querySelector('[data-action="balance-seed-management"]').click();cfg.overlay=cfg.top();void 0;`); await tick();
    // 单元格内各文本节点都在同一行；编辑输入框的值完整可见；表格不横向溢出。
    const measure = () => js(`(() => {
      const wrapper=cfg.overlay.querySelector('.table-wrapper'), table=wrapper.querySelector('table');
      const singleLine=cell=>{const tops=[];const walker=document.createTreeWalker(cell,NodeFilter.SHOW_TEXT);
        for(let node=walker.nextNode();node;node=walker.nextNode()){if(!node.textContent.trim())continue;const range=document.createRange();range.selectNodeContents(node);
          for(const rect of range.getClientRects())tops.push(Math.round(rect.top));}
        return tops.length===0||Math.max(...tops)-Math.min(...tops)<=1;};
      const input=table.querySelector('.balance-seed-balance-input');
      // v3.2.18 头部：渠道、账户号、币种不溢出卡片，× 留在右上角且不与其他控件重叠。
      const card=cfg.overlay.querySelector('.balance-seed-card').getBoundingClientRect();
      const header=cfg.overlay.querySelector('.dialog-header');
      const rect=element=>element.getBoundingClientRect();
      const close=rect(header.querySelector('.icon-close'));
      const controls=['.dialog-title','.balance-seed-owner-wrapper','[data-role="balance-seed-account"]','.balance-seed-currency-wrapper'].map(selector=>rect(header.querySelector(selector)));
      return { overflow: wrapper.scrollWidth>wrapper.clientWidth+1,
        wrapped: [...table.querySelectorAll('th,td')].filter(cell=>!singleLine(cell)).map(cell=>cell.textContent.trim()),
        widths: [...table.rows[0].cells].map(cell=>Math.round(cell.getBoundingClientRect().width)),
        // 与 overflow 同样留 1px：Windows 150% 下输入框宽度为小数，scrollWidth 取整后会比 clientWidth 大 1（文字 50.6px、可用约 54px 时也是 75/74）
        inputFits: !input||input.scrollWidth<=input.clientWidth+1,
        // 失败时随断言输出，便于对照 Windows 与本机的实际宽度
        inputMetrics: input&&(()=>{const cs=getComputedStyle(input);const ctx=document.createElement('canvas').getContext('2d');ctx.font=cs.font;
          return {value:input.value,client:input.clientWidth,scroll:input.scrollWidth,padding:cs.paddingLeft,font:cs.font,
            text:Math.round(ctx.measureText(input.value).width*10)/10,cell:Math.round(input.closest('td').getBoundingClientRect().width),
            cols:[...table.rows[0].cells].map(cell=>Math.round(cell.getBoundingClientRect().width)),table:Math.round(table.getBoundingClientRect().width),
            wrapper:wrapper.clientWidth,viewport:window.innerWidth,dpr:window.devicePixelRatio,narrow:matchMedia('(max-width: 1021px)').matches};})(),
        headerFits: header.scrollWidth<=header.clientWidth+1&&controls.every(item=>item.right<=card.right+1),
        closeTopRight: close.right<=card.right+1&&close.top-card.top<40&&controls.every(item=>item.right<=close.left||item.top>=close.bottom),
        filtersOnFirstRow: Math.abs(controls[2].top-controls[1].top)<=2 };
    })()`);
    await layout.settle();
    const normal = await measure();
    assert.deepEqual([normal.overflow, normal.wrapped], [false, []]);
    assert.deepEqual([normal.headerFits, normal.closeTopRight, normal.filtersOnFirstRow], [true, true, true], '100% 时头部一行放下');
    const [, , , balanceWidth, methodWidth, actionWidth] = normal.widths;
    assert.ok(Math.max(balanceWidth, methodWidth, actionWidth) - Math.min(balanceWidth, methodWidth, actionWidth) <= 1, JSON.stringify(normal.widths));
    await js(`cfg.overlay.querySelectorAll('[data-action="edit-seed"]')[2].click();void 0;`); await layout.settle();
    const editing = await measure();
    assert.deepEqual([editing.overflow, editing.wrapped, editing.inputFits], [false, [], true], JSON.stringify(editing.inputMetrics));
    assert.ok(editing.widths.every((width, index) => Math.abs(width - normal.widths[index]) <= 1), JSON.stringify([normal.widths, editing.widths]));
    await layout.evidence('balance-seed-table-100', { normal, editing });
    // v3.2.18：选账户号后打开浮层，浮层在卡片内可见、不超出窗口。
    await js(`cfg.overlay.querySelector('[data-action="cancel-edit"]').click();const account=cfg.overlay.querySelector('[data-role="balance-seed-account"]');
      account.click();cfg.overlay.querySelector('.balance-seed-account-option[data-value="622202100112345678901"]').click();account.click();void 0;`);
    await layout.settle();
    const panel = await js(`(()=>{const rect=cfg.overlay.querySelector('.balance-seed-account-panel').getBoundingClientRect();
      return {visible:rect.height>0,inWindow:rect.left>=0&&rect.right<=window.innerWidth&&rect.bottom<=window.innerHeight,
        options:cfg.overlay.querySelectorAll('.balance-seed-account-option').length,rows:cfg.overlay.querySelectorAll('tbody tr').length};})()`);
    assert.deepEqual(panel, { visible: true, inWindow: true, options: 4, rows: 2 });
    await layout.evidence('balance-seed-filter-panel-100', { panel });
    await js(`cfg.overlay.querySelector('[data-role="balance-seed-account"]').click();cfg.overlay.querySelectorAll('[data-action="edit-seed"]')[0].click();void 0;`);
    await layout.resize(1080, 760, 1.5);
    const zoomed = await measure();
    // 150% 时编辑 7 位金额 1250000（筛选后第一行）
    assert.equal(await js(`cfg.overlay.querySelector('.balance-seed-balance-input').value`), '1250000');
    assert.deepEqual([zoomed.overflow, zoomed.wrapped, zoomed.inputFits], [false, [], true], JSON.stringify(zoomed.inputMetrics));
    assert.deepEqual([zoomed.headerFits, zoomed.closeTopRight], [true, true], '150% 时头部可换行但不溢出，× 仍在右上角');
    await layout.evidence('balance-seed-table-150', { zoomed });
  });
  // v3.2.18【导入模板】命名弹框版式：右下角【取消】【确认】，【确认】为蓝色主按钮；100%/150% 均不溢出。
  await test('导入模板命名弹框：右下角取消 / 确认，确认为蓝色主按钮，100% 与 150% 不溢出', async () => {
    await setup({ zoom: 1 });
    await js(`cfg.bridge.openModal(()=>cfg.dialogs.createTemplateImportNameDialog({sourceFileName:'METACOMP 新加坡 2026-11 网银明细.xlsx',onSubmit:async()=>({close:true}),onCancel:()=>{}}));void 0;`);
    const measure = () => js(`(()=>{const card=cfg.top().querySelector('.template-import-name-card');const cardRect=card.getBoundingClientRect();
      const buttons=[...card.querySelectorAll('.dialog-actions button')];const rects=buttons.map(button=>button.getBoundingClientRect());
      const primary=getComputedStyle(document.documentElement).getPropertyValue('--primary').trim();
      const toRgb=value=>{const probe=document.createElement('span');probe.style.color=value;document.body.appendChild(probe);const rgb=getComputedStyle(probe).color;probe.remove();return rgb;};
      return {labels:buttons.map(button=>button.textContent),confirmBlue:getComputedStyle(buttons[1]).backgroundColor===toRgb(primary),
        rightmost:rects[1].left>rects[0].right&&cardRect.right-rects[1].right<60&&cardRect.bottom-rects[1].bottom<60,
        fits:card.scrollWidth<=card.clientWidth+1&&[...card.querySelectorAll('input')].every(input=>input.getBoundingClientRect().right<=cardRect.right)};})()`);
    await layout.settle();
    const normal = await measure();
    assert.deepEqual(normal, { labels: ['取消', '确认'], confirmBlue: true, rightmost: true, fits: true });
    await layout.evidence('template-import-name-100', { normal });
    await layout.resize(1080, 760, 1.5);
    const zoomed = await measure();
    assert.deepEqual(zoomed, { labels: ['取消', '确认'], confirmBlue: true, rightmost: true, fits: true });
    await layout.evidence('template-import-name-150', { zoomed });
  });
  // v3.2.18（spec：changes/v3.2.18/feat/template-import-naming/spec.md §3.2）：账户号可搜索单选 + 币种联动单选，只在渲染层筛选。
  await test('余额管理账户号 / 币种筛选：头部顺序与默认空白，部分搜索、选「全部」复位，币种联动与禁用，按收到顺序显示', async () => {
    await setup();
    await js(`cfg.templates.push({id:3,name:'渠道 A',channelId:7,channelName:'渠道 A'});cfg.services.applyPreviewTemplates(cfg.templates);
      cfg.seedRecords=[['2026-09-03','M002','USD'],['2026-09-02','M001','HKD'],['2026-09-02','M001','USD'],['2026-09-01','M001','USD'],['2026-09-01','X9','EUR']]
        .map(([billDate,merchantId,currency],index)=>({billDate,merchantId,currency,endBalance:index+1,generationMethod:'人工录入',templateName:'渠道 A',updatedAt:'u'+index,fileIdentity:'渠道.json'}));
      cfg.seedList=owner=>({status:'success',owner:{kind:owner.kind,id:owner.id,seedFileName:'渠道.json'},records:owner.kind==='channel'?cfg.seedRecords:[]});
      cfg.manager=cfg.bridge.openModal(()=>cfg.dialogs.createTemplateManagerDialog()).handle;cfg.top().querySelector('[data-action="balance-seed-management"]').click();
      cfg.overlay=cfg.top();cfg.handle=cfg.host.getHandle(cfg.overlay);cfg.account=cfg.overlay.querySelector('[data-role="balance-seed-account"]');
      cfg.currency=cfg.overlay.querySelector('[data-role="balance-seed-currency"]');cfg.panel=cfg.overlay.querySelector('.balance-seed-account-panel');
      cfg.rows=()=>Array.from(cfg.overlay.querySelectorAll('tbody tr')).map(row=>Array.from(row.cells).slice(0,3).map(cell=>cell.textContent.trim()).join(' '));
      cfg.options=()=>Array.from(cfg.panel.querySelectorAll('.balance-seed-account-option')).map(option=>option.textContent.trim());
      cfg.search=value=>{const input=cfg.panel.querySelector('[data-role="balance-seed-account-search"]');input.value=value;input.dispatchEvent(new Event('input'));};
      cfg.pick=value=>cfg.panel.querySelector('.balance-seed-account-option[data-value="'+value+'"]').click();
      cfg.hint=()=>cfg.overlay.querySelector('[data-role="balance-seed-hint"]').textContent;void 0;`); await tick();
    assert.deepEqual(await js(`{const header=cfg.overlay.querySelector('.dialog-header');
      [Array.from(header.children).map(item=>item.className.split(' ').find(name=>['dialog-title','balance-seed-owner-wrapper','balance-seed-filters','icon-close'].includes(name))),
       Array.from(header.querySelector('.balance-seed-filters').children).map(item=>item.firstChild.textContent.trim()||item.dataset.role),
       cfg.account.textContent.trim(),cfg.currency.value,cfg.currency.disabled,Array.from(cfg.currency.options).map(option=>option.value),cfg.panel.hidden];}`),
      [['dialog-title', 'balance-seed-owner-wrapper', 'balance-seed-filters', 'icon-close'], ['账户号', 'balance-seed-account', '币种'], '', '', true, [''], true]);
    assert.deepEqual(await js('cfg.rows()'), ['2026-09-03 M002 USD', '2026-09-02 M001 HKD', '2026-09-02 M001 USD', '2026-09-01 M001 USD', '2026-09-01 X9 EUR']);

    await js(`cfg.account.click();`);
    assert.deepEqual(await js(`[cfg.panel.hidden,cfg.account.getAttribute('aria-expanded'),cfg.options(),document.activeElement?.dataset.role]`),
      [false, 'true', ['全部', 'M001', 'M002', 'X9'], 'balance-seed-account-search']);
    await js(`cfg.search('m00');`);
    assert.deepEqual(await js('cfg.options()'), ['全部', 'M001', 'M002']);
    await js(`cfg.search('zzz');`);
    assert.deepEqual(await js(`[cfg.options(),cfg.panel.textContent.includes('无匹配账户号')]`), [['全部'], true]);
    await js(`cfg.search('001');cfg.pick('M001');`);
    assert.deepEqual(await js(`[cfg.panel.hidden,cfg.account.textContent,cfg.rows(),cfg.hint(),cfg.currency.disabled,Array.from(cfg.currency.options).map(option=>option.value)]`),
      [true, 'M001', ['2026-09-02 M001 HKD', '2026-09-02 M001 USD', '2026-09-01 M001 USD'], '共 3 条', false, ['', 'HKD', 'USD']]);
    await js(`cfg.currency.value='USD';cfg.currency.dispatchEvent(new Event('change'));`);
    assert.deepEqual(await js(`[cfg.rows(),cfg.hint()]`), [['2026-09-02 M001 USD', '2026-09-01 M001 USD'], '共 2 条']);
    await js(`cfg.account.click();cfg.pick('M002');`);
    assert.deepEqual(await js(`[cfg.account.textContent,cfg.currency.value,Array.from(cfg.currency.options).map(option=>option.value),cfg.rows()]`),
      ['M002', '', ['', 'USD'], ['2026-09-03 M002 USD']], '换账户号时币种清空');
    await js(`cfg.account.click();cfg.pick('');`);
    assert.deepEqual(await js(`[cfg.account.textContent.trim(),cfg.currency.disabled,cfg.rows().length,cfg.hint()]`), ['', true, 5, '共 5 条'], '选「全部」回到空白');

    await js(`cfg.account.click();document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));`);
    assert.deepEqual(await js(`[cfg.panel.hidden,cfg.handle.isTop(),cfg.handle.isOpen()]`), [true, true, true], 'Esc 只关面板');
    await js(`cfg.account.click();cfg.overlay.querySelector('tbody').dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));`);
    assert.equal(await js('cfg.panel.hidden'), true, '点击面板外关闭');
    await js(`cfg.account.click();cfg.search('x');cfg.panel.querySelector('[data-role="balance-seed-account-search"]').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));`);
    assert.deepEqual(await js(`[cfg.panel.hidden,cfg.account.textContent]`), [true, 'X9'], 'Enter 选第一个匹配');

    await js(`cfg.select=cfg.overlay.querySelector('[data-role="balance-seed-owner"]');cfg.account.click();cfg.select.value='template:1';cfg.select.dispatchEvent(new Event('change'));`); await tick();
    assert.deepEqual(await js(`[cfg.panel.hidden,cfg.account.textContent.trim(),cfg.currency.disabled,cfg.rows()]`), [true, '', true, ['暂无余额种子']], '切换渠道清空筛选');
    assert.deepEqual(await js('cfg.errors'), []);
  });
  await test('余额管理筛选与写入、分页：重读后账户号或币种仍在则保留、消失则复位；筛选后分页与条数按筛选结果', async () => {
    await setup();
    await js(`cfg.templates.push({id:3,name:'渠道 A',channelId:7,channelName:'渠道 A'});cfg.services.applyPreviewTemplates(cfg.templates);
      const seed=(billDate,merchantId,currency,endBalance)=>({billDate,merchantId,currency,endBalance,generationMethod:'通过发生额计算',templateName:'渠道 A',updatedAt:'u',fileIdentity:'渠道.json'});
      cfg.seedRecords=[seed('2026-09-02','M001','USD',10),seed('2026-09-02','M002','HKD',20),seed('2026-09-01','M001','USD',30)];
      cfg.seedList=owner=>({status:'success',owner:{kind:owner.kind,id:owner.id,seedFileName:'渠道.json'},records:cfg.seedRecords});
      cfg.manager=cfg.bridge.openModal(()=>cfg.dialogs.createTemplateManagerDialog()).handle;cfg.top().querySelector('[data-action="balance-seed-management"]').click();
      cfg.overlay=cfg.top();cfg.account=cfg.overlay.querySelector('[data-role="balance-seed-account"]');cfg.currency=cfg.overlay.querySelector('[data-role="balance-seed-currency"]');
      cfg.panel=cfg.overlay.querySelector('.balance-seed-account-panel');
      cfg.pick=value=>{cfg.account.click();cfg.panel.querySelector('.balance-seed-account-option[data-value="'+value+'"]').click();};
      cfg.rows=()=>Array.from(cfg.overlay.querySelectorAll('tbody tr')).map(row=>Array.from(row.cells).slice(0,4).map(cell=>cell.textContent.trim()).join(' '));void 0;`); await tick();
    await js(`cfg.pick('M001');cfg.currency.value='USD';cfg.currency.dispatchEvent(new Event('change'));
      cfg.overlay.querySelector('[data-action="edit-seed"]').click();cfg.overlay.querySelector('.balance-seed-balance-input').value='11';
      cfg.seedRecords=[{...cfg.seedRecords[0],endBalance:11,generationMethod:'人工录入'},...cfg.seedRecords.slice(1)];
      cfg.overlay.querySelector('[data-action="save-seed"]').click();`); await tick(); await tick();
    assert.deepEqual(await js(`[cfg.account.textContent,cfg.currency.value,cfg.rows()]`),
      ['M001', 'USD', ['2026-09-02 M001 USD 11', '2026-09-01 M001 USD 30']], '修改后筛选保留');
    assert.equal(await js(`cfg.calls.find(call=>call.name==='seedUpdate').args[0].key.merchantId`), 'M001');
    await js(`cfg.pick('M002');cfg.overlay.querySelector('[data-action="delete-seed"]').click();
      cfg.seedRecords=cfg.seedRecords.filter(record=>record.merchantId!=='M002');
      Array.from(cfg.top().querySelectorAll('button')).find(button=>button.textContent==='确认删除').click();`); await tick(); await tick();
    assert.deepEqual(await js(`[cfg.account.textContent.trim(),cfg.currency.disabled,cfg.rows().length]`), ['', true, 2], '删除后账户号消失则复位');

    await js(`cfg.seedRecords=Array.from({length:205},(_,index)=>({billDate:'2026-08-'+String(31-index%31).padStart(2,'0'),merchantId:'BIG'+String(index).padStart(3,'0'),currency:'USD',endBalance:index,
        generationMethod:'通过发生额计算',templateName:'渠道 A',updatedAt:'u',fileIdentity:'渠道.json'})).concat([{billDate:'2026-07-01',merchantId:'SMALL',currency:'CNY',endBalance:1,generationMethod:'人工录入',templateName:'渠道 A',updatedAt:'u',fileIdentity:'渠道.json'}]);
      cfg.select=cfg.overlay.querySelector('[data-role="balance-seed-owner"]');cfg.select.dispatchEvent(new Event('change'));`); await tick();
    await js(`cfg.overlay.querySelector('[data-action="next-page"]').click();`);
    assert.deepEqual(await js(`[cfg.overlay.querySelector('[data-role="balance-seed-pager"]').hidden,cfg.overlay.querySelector('[data-role="balance-seed-page"]').textContent,cfg.overlay.querySelectorAll('tbody tr').length]`),
      [false, '第 2 / 2 页', 6]);
    await js(`cfg.pick('SMALL');`);
    assert.deepEqual(await js(`[cfg.overlay.querySelector('[data-role="balance-seed-pager"]').hidden,cfg.rows(),cfg.overlay.querySelector('[data-role="balance-seed-hint"]').textContent]`),
      [true, ['2026-07-01 SMALL CNY 1'], '共 1 条'], '筛选后回到第 1 页、分页按筛选结果');
    assert.deepEqual(await js('cfg.errors'), []);
  });
  await test('余额管理修改只改余额并带回原值，写入中禁止关闭；非法数字不提交；conflict 提示后重读', async () => {
    await setup();
    await js(`cfg.templates.push({id:3,name:'渠道 A',channelId:7,channelName:'渠道 A'});cfg.services.applyPreviewTemplates(cfg.templates);
      cfg.seedRecords=[{merchantId:'M001',currency:'USD',billDate:'2026-09-02',endBalance:1010,generationMethod:'通过发生额计算',templateName:'渠道 A',updatedAt:'u2',fileIdentity:'渠道.json'}];
      cfg.seedList=owner=>({status:'success',owner:{kind:owner.kind,id:owner.id,seedFileName:'渠道.json'},records:cfg.seedRecords});
      cfg.manager=cfg.bridge.openModal(()=>cfg.dialogs.createTemplateManagerDialog()).handle;cfg.top().querySelector('[data-action="balance-seed-management"]').click();
      cfg.overlay=cfg.top();cfg.handle=cfg.host.getHandle(cfg.overlay);void 0;`); await tick();
    const edit = (value) => js(`cfg.overlay.querySelector('[data-action="edit-seed"]').click();cfg.input=cfg.overlay.querySelector('.balance-seed-balance-input');cfg.input.value='${value}';void 0;`);
    await edit('abc');
    assert.equal(await js('cfg.overlay.querySelector(".balance-seed-balance-input").value'), 'abc');
    await js(`cfg.overlay.querySelector('[data-action="save-seed"]').click();`); await tick();
    assert.match(await js('cfg.top().textContent'), /余额必须是有效数字/);
    assert.equal(await js(`cfg.calls.filter(call=>call.name==='seedUpdate').length`), 0);
    await js('cfg.host.closeTop();');
    await js(`cfg.input.value='1,005.5';cfg.write=cfg.defer();cfg.next.seedUpdate=cfg.write;cfg.save=cfg.overlay.querySelector('[data-action="save-seed"]');cfg.save.click();cfg.save.dispatchEvent(new Event('click'));`);
    assert.equal(await js(`cfg.calls.filter(call=>call.name==='seedUpdate').length`), 1);
    assert.equal(await js('cfg.handle.close().status'), 'blocked');
    assert.deepEqual(await js(`cfg.calls.find(call=>call.name==='seedUpdate').args[0]`), {
      owner: { kind: 'channel', id: 7 },
      key: { merchantId: 'M001', currency: 'USD', billDate: '2026-09-02' },
      expected: { merchantId: 'M001', currency: 'USD', billDate: '2026-09-02', endBalance: 1010, generationMethod: '通过发生额计算', templateName: '渠道 A', updatedAt: 'u2', fileIdentity: '渠道.json' },
      endBalance: '1005.5'
    });
    await js(`cfg.seedRecords=[{...cfg.seedRecords[0],endBalance:1005.5,generationMethod:'人工录入',updatedAt:'u3'}];cfg.write.resolve({status:'success',changed:true,message:'余额种子已修改'});`); await tick(); await tick();
    assert.equal(await js('cfg.handle.isTop()'), true);
    assert.deepEqual(await js(`Array.from(cfg.overlay.querySelector('tbody tr').cells).slice(3,5).map(cell=>cell.textContent.trim())`), ['1005.5', '人工录入']);
    assert.equal(await js(`cfg.calls.filter(call=>call.name==='seedList').length`), 2);
    await edit('7');
    await js(`cfg.next.seedUpdate={status:'conflict',message:'余额种子已变化，请刷新后重试'};cfg.overlay.querySelector('[data-action="save-seed"]').click();`); await tick(); await tick();
    assert.match(await js('cfg.top().textContent'), /余额种子已变化，请刷新后重试/);
    assert.equal(await js(`cfg.calls.filter(call=>call.name==='seedList').length`), 3);
    await js('cfg.host.closeTop();');
    assert.equal(await js('cfg.handle.isTop()&&!cfg.overlay.querySelector(".balance-seed-balance-input")'), true);
  });
  await test('余额管理删除先确认，取消不提交；确认按原值删除后重读；维护大账号入口改名为余额附加值', async () => {
    await setup();
    await js(`cfg.templates.push({id:3,name:'渠道 A',channelId:7,channelName:'渠道 A'});cfg.services.applyPreviewTemplates(cfg.templates);
      cfg.seedRecords=[{merchantId:'M001',currency:'USD',billDate:'2026-09-02',endBalance:1010,generationMethod:'通过发生额计算',templateName:'渠道 A',updatedAt:'u2',fileIdentity:'渠道.json'}];
      cfg.seedList=owner=>({status:'success',owner:{kind:owner.kind,id:owner.id,seedFileName:'渠道.json'},records:cfg.seedRecords});
      cfg.manager=cfg.bridge.openModal(()=>cfg.dialogs.createTemplateManagerDialog()).handle;cfg.top().querySelector('[data-action="balance-seed-management"]').click();
      cfg.overlay=cfg.top();cfg.handle=cfg.host.getHandle(cfg.overlay);void 0;`); await tick();
    await js(`cfg.overlay.querySelector('[data-action="delete-seed"]').click();`);
    assert.match(await js('cfg.top().textContent'), /账户号：M001[\s\S]*日期：2026-09-02[\s\S]*余额：1010/);
    await js(`cfg.top().querySelector('[data-action="cancel"]').click();`);
    assert.equal(await js(`cfg.handle.isTop()&&cfg.calls.filter(call=>call.name==='seedDelete').length===0`), true);
    await js(`cfg.overlay.querySelector('[data-action="delete-seed"]').click();cfg.seedRecords=[];cfg.top().querySelector('[data-action="confirm"]').click();`); await tick(); await tick();
    assert.deepEqual(await js(`cfg.calls.filter(call=>call.name==='seedDelete').map(call=>call.args[0])`), [{
      owner: { kind: 'channel', id: 7 },
      key: { merchantId: 'M001', currency: 'USD', billDate: '2026-09-02' },
      expected: { merchantId: 'M001', currency: 'USD', billDate: '2026-09-02', endBalance: 1010, generationMethod: '通过发生额计算', templateName: '渠道 A', updatedAt: 'u2', fileIdentity: '渠道.json' }
    }]);
    assert.equal(await js('cfg.handle.isTop()'), true);
    assert.match(await js(`cfg.overlay.querySelector('tbody').textContent`), /暂无余额种子/);
    await js('cfg.host.closeTop();cfg.host.closeTop();');
    await js(`cfg.bridge.openModal(()=>cfg.dialogs.createBigAccountManagerDialog({bigAccounts:[],templateId:1,templateName:'模板 A'}));void 0;`);
    assert.equal(await js(`cfg.top().querySelector('[data-action="balance-management"]').textContent`), '余额附加值');
  });
  await test('账户映射下拉为渠道与普通模板，从子模板进入默认选中渠道，保存按渠道范围', async () => {
    await setup();
    await js(`cfg.templates.push({id:3,name:'渠道 A-子模板-1',channelId:7,channelName:'渠道 A'});cfg.services.applyPreviewTemplates(cfg.templates);
      cfg.handle=cfg.bridge.openModal(()=>cfg.dialogs.createAccountMappingDialog({currentScope:{templateId:3},templates:cfg.templates,mappings:cfg.mappings('A'),conflictCount:2})).handle;
      cfg.overlay=cfg.top();cfg.select=cfg.overlay.querySelector('[data-role="template-select"]');void 0;`);
    assert.deepEqual(await js(`Array.from(cfg.select.options).map(option=>[option.value,option.textContent])`), [['channel:7','渠道 A（渠道）'],['template:1','模板 A'],['template:2','模板 B']]);
    assert.equal(await js('cfg.select.value'), 'channel:7');
    assert.equal(await js(`cfg.overlay.querySelector('[data-role="conflict-notice"]').hidden`), false);
    await js(`cfg.overlay.querySelector('[data-action="done"]').click();`); await tick();
    assert.deepEqual(await js(`cfg.calls.filter(call=>call.name==='save').map(call=>call.args[0])`), [{channelId:7}]);
  });
  await test('渠道账户映射冲突：全部选定才能确认，确认按渠道提交选中的候选', async () => {
    await setup();
    await js(`cfg.handle=cfg.bridge.openModal(()=>cfg.dialogs.createChannelAccountMappingConflictDialog({channels:[{channelId:7,channelName:'渠道 A',conflicts:[
        {bankAccountId:'111',candidates:[{clearingAccountId:'C1',noCurrency:false,currency:'',sourceTemplateNames:['子模板一']},{clearingAccountId:'C2',noCurrency:true,currency:'USD',sourceTemplateNames:['子模板二']}]},
        {bankAccountId:'222',candidates:[{clearingAccountId:'C3',noCurrency:false,currency:'',sourceTemplateNames:['子模板一']},{clearingAccountId:'C4',noCurrency:false,currency:'',sourceTemplateNames:['子模板二']}]}]}],
      onDone:()=>cfg.done++})).handle;cfg.overlay=cfg.top();cfg.ok=cfg.overlay.querySelector('[data-action="done"]');void 0;`);
    assert.deepEqual(await titleTips('.channel-conflict-hint'), { title: '处理渠道账户映射冲突', hidden: false, mark: 'Tips',
      bubble: '升级时，同一渠道下的子模板对同一账户号设置了不同的清结算账号或币种。请为每个账户号选定一条，处理前该渠道无法生成账单。',
      bodyHint: false });
    assert.equal(await js('cfg.ok.disabled'), true);
    await js(`{const radios=cfg.overlay.querySelectorAll('input[type="radio"]');radios[1].checked=true;radios[1].dispatchEvent(new Event('change'));}`);
    assert.equal(await js('cfg.ok.disabled'), true);
    await js(`{const radios=cfg.overlay.querySelectorAll('input[type="radio"]');radios[2].checked=true;radios[2].dispatchEvent(new Event('change'));}`);
    assert.equal(await js('cfg.ok.disabled'), false);
    await js('cfg.ok.click();'); await tick(); await tick();
    assert.deepEqual(await js(`cfg.calls.filter(call=>call.name==='resolveConflicts').map(call=>call.args[0])`), [{channelId:7,choices:[{bankAccountId:'111',candidateIndex:1},{bankAccountId:'222',candidateIndex:0}]}]);
    assert.equal(await js('cfg.done===1&&!cfg.handle.isOpen()'), true);
  });
  await test('模板删除取消返回原管理层，成功后刷新管理层且不重挂旧确认', async () => {
    await setup();
    await js(`cfg.manager=cfg.bridge.openModal(()=>cfg.dialogs.createTemplateManagerDialog()).handle;cfg.overlay=cfg.top();cfg.overlay.querySelector('[data-action="delete"]').click();cfg.top().querySelector('[data-action="cancel"]').click();`);
    assert.equal(await js('cfg.manager.isTop()&&cfg.top()===cfg.overlay'), true);
    await js(`cfg.overlay.querySelector('[data-action="delete"]').click();cfg.top().querySelector('[data-action="confirm"]').click();`); await tick();
    assert.match(await js('cfg.top().textContent'), /模板管理/);
    assert.equal(await js(`cfg.calls.filter(call=>call.name==='delete').length`), 1);
  });

  for (const operation of ['amount','splitMapping','addon']) await test('配置子窗 '+operation+' 保存失败可重试，busy 禁止返回，结束后的成功不调用旧父回调', async () => {
    await setup();
    await js(`cfg.parentHandle=cfg.other();cfg.parentOverlay=cfg.top();cfg.callback=()=>{cfg.done++;cfg.bridge.returnToModal(cfg.parentOverlay);};void 0;`);
    if (operation==='amount') await js(`cfg.handle=cfg.bridge.pushModal(cfg.parentHandle,()=>cfg.dialogs.createAmountSplitRulesDialog({template:{id:1,headers:['Currency','Amount']},initialRules:cfg.rules,onDone:cfg.callback,onCancel:cfg.callback})).handle;void 0;`);
    if (operation==='splitMapping') await js(`cfg.handle=cfg.bridge.pushModal(cfg.parentHandle,()=>cfg.dialogs.createBillSplitMappingsDialog({template:{id:1},onDone:cfg.callback,onCancel:cfg.callback})).handle;void 0;`);
    if (operation==='addon') await js(`cfg.handle=cfg.bridge.pushModal(cfg.parentHandle,()=>cfg.dialogs.createBalanceAddonManagerDialog({templateName:'模板 A',bigAccounts:[{merchantId:'M001',currencies:['USD']}],onClose:cfg.callback})).handle;void 0;`);
    if (operation==='addon') assert.equal(await js(`cfg.top().querySelector('.dialog-title').textContent`), '余额附加值');
    await tick();
    await js(`cfg.overlay=cfg.top();cfg.action=cfg.overlay.querySelector('[data-action="done"]');cfg.write=cfg.defer();cfg.next.${operation}=cfg.write;cfg.action.click();cfg.action.dispatchEvent(new Event('click'));`);
    assert.equal(await js(`cfg.calls.filter(call=>call.name===${JSON.stringify(operation)}).length`), 1);
    assert.equal(await js('cfg.parentHandle.close().status'), 'blocked');
    assert.equal(await js('cfg.handle.close().status'), 'blocked');
    await js(`cfg.write.resolve({status:'error',message:'保存失败'});`); await tick();
    if (operation!=='addon') await js('cfg.host.closeTop();');
    assert.equal(await js('cfg.handle.isTop()&&!cfg.action.disabled&&cfg.done===0'), true);
    await js(`cfg.write=cfg.defer();cfg.next.${operation}=cfg.write;cfg.action.click();cfg.handle.dispose();cfg.later=cfg.bridge.pushModal(cfg.parentHandle,()=>cfg.dialogs.createAlertDialog('新子窗')).handle;cfg.write.resolve({status:'success',message:'后台成功'});`); await tick();
    assert.equal(await js('cfg.later.isTop()&&cfg.done===0'), true);
  });
  await test('拆分账单规则写入原 split 表，成功后回到原行管理父层且保持规则', async () => {
    await setup();
    await js(`cfg.parentHandle=cfg.bridge.openModal(()=>cfg.dialogs.createBillSplitRowsDialog({template:{id:1,headers:['Currency','Amount']},initialAmountRules:cfg.rules})).handle;
      cfg.parentOverlay=cfg.top();cfg.parentOverlay.querySelector('.bill-split-amount-rules-manage-btn').click();cfg.handle=cfg.host.getTop();cfg.overlay=cfg.top();
      cfg.write=cfg.defer();cfg.next.splitAmount=cfg.write;cfg.overlay.querySelector('[data-action="done"]').click();cfg.overlay.querySelector('[data-action="done"]').dispatchEvent(new Event('click'));`);
    assert.equal(await js(`cfg.calls.filter(call=>call.name==='splitAmount').length`), 1);
    assert.equal(await js(`cfg.calls.filter(call=>call.name==='amount').length`), 0);
    assert.equal(await js('cfg.parentHandle.close().status'), 'blocked');
    await js(`cfg.write.resolve({status:'success'});`); await tick();
    assert.equal(await js('cfg.parentHandle.isTop()&&!cfg.handle.isOpen()'), true);
    assert.equal(await js('cfg.parentOverlay.querySelector(".bill-split-by-field-select").value'), '是');
    assert.deepEqual(await js(`cfg.calls.find(call=>call.name==='splitAmount').args[0]`), {templateId:1,amountSplitRules:[
      {targetField:'Credit Amount',conditionField:'Currency',conditionValue:'C',mappedField:'Amount',rowIndex:0},
      {targetField:'Debit Amount',conditionField:'Currency',conditionValue:'D',mappedField:'Amount',rowIndex:1}
    ]});
  });
  await test('手工余额后续队列和旧简单选择的后台完成不接管新窗，仍处理原结果', async () => {
    for(const operation of ['seed','simpleSelection']) {
      await setup();
      if(operation==='seed')await js(`cfg.handle=cfg.bridge.openModal(()=>cfg.dialogs.createManualBalanceSeedDialog({merchantId:'M001',currency:'USD'})).handle;void 0;`);
      else await js(`cfg.handle=cfg.bridge.openModal(()=>cfg.dialogs.createBigAccountSelectionDialog([{label:'M001 USD',merchantId:'M001',currency:'USD'}])).handle;cfg.top().querySelector('input[type="radio"]').checked=true;void 0;`);
      await js(`cfg.write=cfg.defer();cfg.next.${operation}=cfg.write;cfg.action=cfg.top().querySelector('[data-action="done"]');cfg.action.click();cfg.action.dispatchEvent(new Event('click'));`);
      assert.equal(await js(`cfg.calls.filter(call=>call.name===${JSON.stringify(operation)}).length`),1);
      assert.equal(await js('cfg.handle.close().status'),'blocked');
      await js(`cfg.handle.dispose();cfg.newHandle=cfg.other();cfg.write.resolve({status:'success',manualBalancePromptReady:true,manualBalancePrompt:{merchantId:'M002',currency:'HKD'}});`);await tick();
      assert.equal(await js('cfg.newHandle.isTop()&&cfg.applied===1'),true);
    }
  });

  await test('手工余额覆盖确认成功后父子一起结束，下一补录项继续原队列', async () => {
    await setup();
    await js(`cfg.next.seed={status:'confirm-overwrite',contextId:'seed-context'};cfg.handle=cfg.bridge.openModal(()=>cfg.dialogs.createManualBalanceSeedDialog({merchantId:'M001',currency:'USD'}, {billDate:'2026-09-01',endBalance:'10'}, {index:1,total:2})).handle;
      cfg.top().querySelector('[data-action="done"]').click();`);await tick();
    assert.equal(await js('document.getElementById("modalRoot").children.length'),2);
    await js(`cfg.next.seed={status:'success',manualBalancePromptReady:true,manualBalancePrompt:{merchantId:'M002',currency:'HKD'}};cfg.top().querySelector('[data-action="confirm"]').click();`);await tick();
    assert.equal(await js('cfg.handle.isOpen()'),false);
    assert.equal(await js('document.getElementById("modalRoot").children.length'),1);
    assert.match(await js('cfg.top().textContent'),/M002/);
    assert.deepEqual(await js(`cfg.calls.filter(call=>call.name==='seed')[1].args`),[{contextId:'seed-context',confirmOverwrite:true}]);
  });

  // v3.2.16 D7（用户反馈 KBANK-VN）：已有上一账单日余额但首日对不上时，补录弹窗写明原因并预填已有种子，不再像关不掉的同一个空白框。
  const SEED_MISMATCH_JS = `cfg.seedMismatchPrompt={templateName:'模板 A',bankName:'模板',merchantId:'M001',currency:'VND',targetBillDate:'2026-10-01',queueIndex:1,queueTotal:1,
    seedMismatch:{seedDate:'2026-09-30',seedBalance:0,seedGenerationMethod:'人工录入',anchorBalance:0,billDate:'2026-10-01',
      creditAmount:0,debitAmount:201500,expectedBalance:-201500,statementBalances:[800000,798500]}};`;
  // v3.2.18：说明遇「。」换行、金额单独标黑；按行与金额片段取文字。
  const SEED_MISMATCH_SHAPE_JS = `(() => { const box=cfg.top().querySelector('.manual-balance-seed-mismatch');
    return { lines:[...box.querySelectorAll('.manual-balance-seed-mismatch-line')].map(node=>node.textContent),
      amounts:[...box.querySelectorAll('.manual-balance-seed-mismatch-amount')].map(node=>node.textContent) }; })()`;
  await test('已有余额对不上：补录完成后转入的弹窗写明原因并预填已有种子；改对后提交修改后的值', async () => {
    await setup();
    await js(`${SEED_MISMATCH_JS}
      cfg.handle=cfg.bridge.openModal(()=>cfg.dialogs.createManualBalanceSeedDialog({merchantId:'M001',currency:'VND',targetBillDate:'2026-10-01'})).handle;
      cfg.top().querySelector('.manual-balance-date-input').value='2026-09-30';cfg.top().querySelector('.manual-balance-amount-input').value='0';
      cfg.next.seed={status:'manual-balance-required',manualBalancePromptReady:true,manualBalancePrompt:cfg.seedMismatchPrompt};
      cfg.top().querySelector('[data-action="done"]').click();`); await tick();
    assert.deepEqual(await js(`({title:cfg.top().querySelector('.dialog-title').textContent,
      warning:Boolean(cfg.top().querySelector('.manual-balance-seed-mismatch')),
      date:cfg.top().querySelector('.manual-balance-date-input').value,amount:cfg.top().querySelector('.manual-balance-amount-input').value,
      count:document.getElementById('modalRoot').children.length})`),
    {title:'核对上一账单日余额',warning:true,date:'2026-09-30',amount:'0',count:1});
    assert.match(await js(`cfg.top().querySelector('.manual-balance-seed-mismatch').textContent`),
      /已有 2026-09-30 的余额 0\.00（人工录入），加上 2026-10-01 收入 0\.00、支出 201,500\.00 后应为 -201,500\.00，与账单当日余额 800,000\.00、798,500\.00 都对不上/);
    assert.deepEqual(await js(SEED_MISMATCH_SHAPE_JS), {
      lines: ['已有 2026-09-30 的余额 0.00（人工录入），加上 2026-10-01 收入 0.00、支出 201,500.00 后应为 -201,500.00，与账单当日余额 800,000.00、798,500.00 都对不上。',
        '请核对上一账单日余额（可参考账单上的期初余额）后重新填写。'],
      amounts: ['0.00', '0.00', '201,500.00', '-201,500.00', '800,000.00', '798,500.00'] });
    await js(`cfg.next.seed={status:'success',message:'余额账单可导出'};cfg.top().querySelector('.manual-balance-amount-input').value='1000000';
      cfg.top().querySelector('[data-action="done"]').click();`); await tick();
    // v3.2.17：补录请求带上界面所示的账号（与输出名称），主进程核对
    assert.deepEqual(await js(`cfg.calls.filter(call=>call.name==='seed').map(call=>call.args[0])`),
      [{billDate:'2026-09-30',endBalance:'0',merchantId:'M001',currency:'VND'},
        {billDate:'2026-09-30',endBalance:'1000000',merchantId:'M001',currency:'VND',templateName:'模板 A'}]);
    assert.equal(await js('document.getElementById("modalRoot").children.length'), 0);
  });
  // v3.2.17（用户反馈 SCB-SG）：首日每笔交易一个余额（上百个）且种子日期与首日之间缺日期。
  // D1：余额只列前后各 3 个并注明总数；D3：写明缺的日期，预填首日前一天、金额留空。金额为合成数据。
  const SEED_MISMATCH_GAP_JS = `cfg.seedMismatchGapPrompt={templateName:'模板 A',bankName:'模板',merchantId:'M001',currency:'SGD',targetBillDate:'2026-11-02',queueIndex:1,queueTotal:1,
    seedMismatch:{seedDate:'2026-10-27',seedBalance:2000000.11,seedGenerationMethod:'账单里的余额',anchorBalance:2000000.11,billDate:'2026-11-02',
      creditAmount:5126.1,debitAmount:0,expectedBalance:2005126.21,
      statementBalances:Array.from({length:150},(_,i)=>2003500+i+0.05),
      missingFrom:'2026-10-28',missingTo:'2026-11-01',suggestedSeedDate:'2026-11-01'}};`;
  await test('已有余额对不上且缺日期：说明写明缺的日期、余额只列前后几个；预填首日前一天、金额留空', async () => {
    await setup();
    await js(`${SEED_MISMATCH_GAP_JS}cfg.handle=cfg.bridge.openModal(()=>cfg.dialogs.createManualBalanceSeedDialog(cfg.seedMismatchGapPrompt)).handle;void 0;`);
    assert.equal(await js(`cfg.top().querySelector('.manual-balance-seed-mismatch').textContent.trim()`),
      '已有 2026-10-27 的余额 2,000,000.11（账单里的余额），加上 2026-11-02 收入 5,126.10、支出 0.00 后应为 2,005,126.21，'
      + '与账单当日余额（共 150 个）2,003,500.05、2,003,501.05、2,003,502.05 … 2,003,647.05、2,003,648.05、2,003,649.05 都对不上。'
      + '2026-10-27 与 2026-11-02 之间缺 2026-10-28 ~ 2026-11-01 的账单，请先核对是否漏导了这几天的账单；'
      + '也可以直接填写 2026-11-01 的期末余额（可参考账单上的期初余额）。');
    // 日期、「（共 150 个）」不算金额；分号不换行。
    assert.deepEqual(await js(SEED_MISMATCH_SHAPE_JS), {
      lines: ['已有 2026-10-27 的余额 2,000,000.11（账单里的余额），加上 2026-11-02 收入 5,126.10、支出 0.00 后应为 2,005,126.21，'
        + '与账单当日余额（共 150 个）2,003,500.05、2,003,501.05、2,003,502.05 … 2,003,647.05、2,003,648.05、2,003,649.05 都对不上。',
      '2026-10-27 与 2026-11-02 之间缺 2026-10-28 ~ 2026-11-01 的账单，请先核对是否漏导了这几天的账单；'
        + '也可以直接填写 2026-11-01 的期末余额（可参考账单上的期初余额）。'],
      amounts: ['2,000,000.11', '5,126.10', '0.00', '2,005,126.21', '2,003,500.05', '2,003,501.05', '2,003,502.05',
        '2,003,647.05', '2,003,648.05', '2,003,649.05'] });
    assert.deepEqual(await js(`({date:cfg.top().querySelector('.manual-balance-date-input').value,amount:cfg.top().querySelector('.manual-balance-amount-input').value})`),
      {date:'2026-11-01',amount:''});
    await js(`cfg.next.seed={status:'success',message:'余额账单可导出'};cfg.top().querySelector('.manual-balance-amount-input').value='2003456.78';
      cfg.top().querySelector('[data-action="done"]').click();`); await tick();
    assert.deepEqual(await js(`cfg.calls.filter(call=>call.name==='seed').map(call=>call.args[0])`), [{billDate:'2026-11-01',endBalance:'2003456.78',merchantId:'M001',currency:'SGD',templateName:'模板 A'}]);

    // 只缺一天：写该日与“这天”；不超过 6 个余额时全部列出。
    // 扣回余额附加值后的金额同样标黑。
    await js(`${SEED_MISMATCH_GAP_JS}Object.assign(cfg.seedMismatchGapPrompt.seedMismatch,{seedDate:'2026-10-31',missingFrom:'2026-11-01',missingTo:'2026-11-01',
      anchorBalance:1999990.11,statementBalances:[1,2,3,4,5,6]});cfg.handle=cfg.bridge.openModal(()=>cfg.dialogs.createManualBalanceSeedDialog(cfg.seedMismatchGapPrompt)).handle;void 0;`);
    const oneDay = await js(`cfg.top().querySelector('.manual-balance-seed-mismatch').textContent`);
    assert.match(oneDay, /与账单当日余额 1\.00、2\.00、3\.00、4\.00、5\.00、6\.00 都对不上。2026-10-31 与 2026-11-02 之间缺 2026-11-01 的账单，请先核对是否漏导了这天的账单/);
    const oneDayShape = await js(SEED_MISMATCH_SHAPE_JS);
    assert.equal(oneDayShape.lines.length, 2);
    assert.match(oneDayShape.lines[0], /^已有 2026-10-31 的余额 2,000,000\.11（账单里的余额）（扣回余额附加值后为 1,999,990\.11），/);
    assert.deepEqual(oneDayShape.amounts, ['2,000,000.11', '1,999,990.11', '5,126.10', '0.00', '2,005,126.21',
      '1.00', '2.00', '3.00', '4.00', '5.00', '6.00']);
  });
  await test('已有余额对不上、余额很多且最小窗口放大到 150% 时，说明区滚动，日期、金额与完成可见可点', async () => {
    await setup({ zoom: 1.5 });
    await js(`${SEED_MISMATCH_GAP_JS}cfg.seedMismatchGapPrompt.seedMismatch.missingFrom='';cfg.seedMismatchGapPrompt.seedMismatch.missingTo='';
      cfg.seedMismatchGapPrompt.seedMismatch.suggestedSeedDate='2026-10-27';
      cfg.handle=cfg.bridge.openModal(()=>cfg.dialogs.createManualBalanceSeedDialog(cfg.seedMismatchGapPrompt)).handle;void 0;`);
    await layout.settle();
    const geometry = await js(`(() => {
      const card=cfg.top().querySelector('.manual-balance-card'), context=card.querySelector('.manual-balance-context'), rect=card.getBoundingClientRect();
      const visible = (selector) => { const r=card.querySelector(selector).getBoundingClientRect();
        return r.height>0 && r.top>=rect.top && r.bottom<=rect.bottom && r.bottom<=innerHeight; };
      return { fits: rect.bottom<=innerHeight, contextScrolls: context.scrollHeight>context.clientHeight, cardScrolls: card.scrollHeight>card.clientHeight+1,
        date: visible('.manual-balance-date-input'), amount: visible('.manual-balance-amount-input'), done: visible('[data-action="done"]') };
    })()`);
    assert.deepEqual(geometry, { fits: true, contextScrolls: true, cardScrolls: false, date: true, amount: true, done: true });
    // v3.2.18：说明与「第 X 个账号」同为 14px；每句一行；金额为正文色（与进度行同色），其余文字保持提示棕色。
    const styleJs = `(() => { const card=cfg.top().querySelector('.manual-balance-card'), cs=(selector)=>getComputedStyle(card.querySelector(selector));
      const progress=cs('.manual-balance-progress'), warning=cs('.manual-balance-seed-mismatch'), line=cs('.manual-balance-seed-mismatch-line'), amount=cs('.manual-balance-seed-mismatch-amount');
      return { progressSize: progress.fontSize, warningSize: warning.fontSize, lineDisplay: line.display,
        amountIsText: amount.color===progress.color, lineIsWarning: line.color===warning.color && line.color!==progress.color }; })()`;
    const style = await js(styleJs);
    assert.deepEqual(style, { progressSize: '14px', warningSize: '14px', lineDisplay: 'block', amountIsText: true, lineIsWarning: true });
    await layout.evidence('manual-balance-seed-mismatch-150', { geometry, style });
    await js(`cfg.next.seed={status:'success',message:'余额账单可导出'};void 0;`);
    await layout.click('.manual-balance-card [data-action="done"]'); await tick();
    assert.deepEqual(await js(`cfg.calls.filter(call=>call.name==='seed').map(call=>call.args[0])`), [{billDate:'2026-10-27',endBalance:'2000000.11',merchantId:'M001',currency:'SGD',templateName:'模板 A'}]);

    // 100% 浅色 / 深色：深色模式下金额随正文色变浅，仍与提示文字区分。
    for (const theme of ['light', 'dark']) {
      await setup({ theme });
      await js(`${SEED_MISMATCH_GAP_JS}cfg.handle=cfg.bridge.openModal(()=>cfg.dialogs.createManualBalanceSeedDialog(cfg.seedMismatchGapPrompt)).handle;void 0;`);
      await layout.settle();
      const themeStyle = await js(styleJs);
      assert.deepEqual(themeStyle, { progressSize: '14px', warningSize: '14px', lineDisplay: 'block', amountIsText: true, lineIsWarning: true }, theme);
      await layout.evidence(`manual-balance-seed-mismatch-${theme}`, { style: themeStyle });
    }
  });
  await test('缺余额的普通补录弹窗不显示对不上说明，输入为空', async () => {
    await setup();
    await js(`cfg.handle=cfg.bridge.openModal(()=>cfg.dialogs.createManualBalanceSeedDialog({merchantId:'M001',currency:'VND',targetBillDate:'2026-10-01'})).handle;void 0;`);
    assert.deepEqual(await js(`({title:cfg.top().querySelector('.dialog-title').textContent,
      warning:Boolean(cfg.top().querySelector('.manual-balance-seed-mismatch')),
      date:cfg.top().querySelector('.manual-balance-date-input').value,amount:cfg.top().querySelector('.manual-balance-amount-input').value})`),
    {title:'补录上一账单日余额',warning:false,date:'',amount:''});
  });

  // v3.2.17：补录余额「导入余额文件」→ 余额确认 → 逐个账号沿用补录保存
  const IMPORT_PROMPT_JS = `cfg.importPrompt={templateName:'模板 A',merchantId:'M001',currency:'USD',targetBillDate:'2026-10-01',queueIndex:1,queueTotal:2,
      pendingAccounts:[{merchantId:'M001',currency:'USD',targetBillDate:'2026-10-01'},{merchantId:'M002',currency:'EUR',targetBillDate:'2026-10-02'}]};
    cfg.secondPrompt={...cfg.importPrompt,merchantId:'M002',currency:'EUR',targetBillDate:'2026-10-02',queueIndex:2};
    cfg.importResult={status:'success',fileName:'余额.xlsx',skippedRowCount:1,matchedCount:1,manualCount:1,accounts:[
      {merchantId:'M001',currency:'USD',targetBillDate:'2026-10-01',billDate:'2026-09-30',endBalance:1234.5,source:'file',reason:''},
      {merchantId:'M002',currency:'EUR',targetBillDate:'2026-10-02',billDate:'',endBalance:null,source:'manual',reason:'文件中没有该账号'}]};
    cfg.view=()=>({title:cfg.top().querySelector('.dialog-title').textContent,
      manualHidden:cfg.top().querySelector('[data-view="manual"]').hidden,confirmHidden:cfg.top().querySelector('[data-view="confirm"]').hidden});
    cfg.rows=()=>[...cfg.top().querySelectorAll('.manual-balance-confirm-table tbody tr')];
    cfg.fillRow=(index,date,amount)=>{const row=cfg.rows()[index];row.querySelector('.manual-balance-confirm-date').value=date;row.querySelector('.manual-balance-confirm-amount').value=amount;};
    cfg.openImport=()=>{cfg.handle=cfg.bridge.openModal(()=>cfg.dialogs.createManualBalanceSeedDialog(cfg.importPrompt)).handle;};
    cfg.importFile=()=>{cfg.next.balanceImport=cfg.importResult;cfg.top().querySelector('[data-action="import-balance-file"]').click();};
    cfg.seedQueue=[];cfg.api.files.saveBalanceSeed=payload=>cfg.invoke('seed',[payload],cfg.seedQueue.length?cfg.seedQueue.shift():{status:'success'});
    void 0;`;
  await test('导入余额文件只出现在带待补录清单的普通补录弹窗；断档、核对、无清单时不出现', async () => {
    await setup();
    await js(`${IMPORT_PROMPT_JS}cfg.openImport();void 0;`);
    assert.deepEqual(await js(`({import:Boolean(cfg.top().querySelector('[data-action="import-balance-file"]')),
      footer:cfg.top().querySelector('[data-view="manual"] .dialog-actions').className,confirmHidden:cfg.view().confirmHidden})`),
    {import:true,footer:'dialog-actions left-right',confirmHidden:true});
    for (const variant of [
      `{...cfg.importPrompt,seedMismatch:{seedDate:'2026-09-30',anchorBalance:0,statementBalances:[]}}`,
      `{...cfg.importPrompt,pendingAccounts:[]}`,
      `{templateName:'模板 A',merchantId:'M001',currency:'USD',targetBillDate:'2026-10-01'}`
    ]) {
      await js(`cfg.host.closeTop();cfg.bridge.openModal(()=>cfg.dialogs.createManualBalanceSeedDialog(${variant}));void 0;`);
      assert.equal(await js(`Boolean(cfg.top().querySelector('[data-action="import-balance-file"]'))||Boolean(cfg.top().querySelector('[data-view="confirm"]'))`), false);
    }
    await js(`cfg.host.closeTop();cfg.bridge.openModal(()=>cfg.dialogs.createManualBalanceSeedDialog({...cfg.importPrompt,reason:'gap',gapKey:'K1',gaps:[]},{}, {gapConfirmed:true}));void 0;`);
    assert.equal(await js(`Boolean(cfg.top().querySelector('[data-action="import-balance-file"]'))`), false);
    assert.equal(await js(`Boolean(cfg.top().querySelector('[data-action="skip-gap"]'))`), true);
  });
  await test('导入后转为余额确认：提取到的预填、提取不到的标为需手工录入；返回保留手工草稿；取消选择不切换', async () => {
    await setup();
    await js(`${IMPORT_PROMPT_JS}cfg.openImport();cfg.top().querySelector('.manual-balance-date-input').value='2026-09-29';
      cfg.top().querySelector('.manual-balance-amount-input').value='7';cfg.top().querySelector('[data-action="import-balance-file"]').click();`); await tick();
    assert.deepEqual(await js('cfg.view()'), {title:'补录上一账单日余额',manualHidden:false,confirmHidden:true});
    await js('cfg.importFile();'); await tick();
    assert.deepEqual(await js('cfg.view()'), {title:'余额确认',manualHidden:true,confirmHidden:false});
    assert.deepEqual(await js(`cfg.rows().map(row=>({manual:row.classList.contains('is-manual'),cells:[...row.cells].slice(0,3).map(cell=>cell.textContent.trim()),
      date:row.querySelector('.manual-balance-confirm-date').value,amount:row.querySelector('.manual-balance-confirm-amount').value,source:row.cells[5].textContent.replace(/\\s+/g,'')}))`), [
      {manual:false,cells:['M001','USD','2026-10-01'],date:'2026-09-30',amount:'1234.5',source:'来自文件'},
      {manual:true,cells:['M002','EUR','2026-10-02'],date:'',amount:'',source:'需手工录入文件中没有该账号'}
    ]);
    assert.match(await js(`cfg.top().querySelector('[data-role="confirm-summary"]').textContent`), /已从 余额\.xlsx 提取 1 个账号的余额，1 个需手工录入；文件中 1 行/);
    assert.equal(await js(`cfg.top().querySelector('.manual-balance-card').classList.contains('manual-balance-card--confirm')`), true);
    await js(`cfg.top().querySelector('[data-action="confirm-back"]').click();`);
    assert.deepEqual(await js('cfg.view()'), {title:'补录上一账单日余额',manualHidden:false,confirmHidden:true});
    assert.deepEqual(await js(`[cfg.top().querySelector('.manual-balance-date-input').value,cfg.top().querySelector('.manual-balance-amount-input').value]`), ['2026-09-29','7']);
    assert.equal(await js(`cfg.top().querySelector('.manual-balance-card').classList.contains('manual-balance-card--confirm')`), false);
    assert.equal(await js(`cfg.calls.filter(call=>call.name==='seed').length`), 0);
  });
  await test('余额确认：日期或余额未填、日期不早于当前账单日期时标红不提交', async () => {
    await setup();
    await js(`${IMPORT_PROMPT_JS}cfg.openImport();cfg.importFile();`); await tick();
    await js(`cfg.top().querySelector('[data-action="confirm-save"]').click();`); await tick();
    assert.deepEqual(await js(`cfg.rows().map(row=>row.classList.contains('is-invalid'))`), [false,true]);
    assert.match(await js(`cfg.top().querySelector('[data-role="confirm-message"]').textContent`), /有 1 个账号/);
    await js(`cfg.fillRow(1,'2026-10-02','88');cfg.top().querySelector('[data-action="confirm-save"]').click();`); await tick();
    assert.equal(await js(`cfg.rows()[1].title`), '上一账单日日期必须早于当前账单日期');
    assert.equal(await js(`cfg.calls.filter(call=>call.name==='seed').length`), 0);
  });
  await test('余额确认后按主进程提示逐个保存清单内账号并带上账号；保存中不能关闭；全部完成后关闭', async () => {
    await setup();
    await js(`${IMPORT_PROMPT_JS}cfg.openImport();cfg.importFile();`); await tick();
    await js(`cfg.fillRow(1,'2026-10-01','88');cfg.first=cfg.defer();cfg.seedQueue=[cfg.first.promise,{status:'success',message:'余额账单可导出'}];
      cfg.top().querySelector('[data-action="confirm-save"]').click();`); await tick();
    assert.equal(await js('cfg.handle.close().status'), 'blocked');
    assert.deepEqual(await js(`[...cfg.top().querySelectorAll('[data-action]')].map(button=>button.disabled)`), [true,true,true,true]);
    assert.match(await js(`cfg.top().querySelector('[data-role="confirm-message"]').textContent`), /正在保存第 1 \/ 2 个账号/);
    await js(`cfg.first.resolve({status:'manual-balance-required',manualBalancePromptReady:true,manualBalancePrompt:cfg.secondPrompt});`); await tick(); await tick();
    assert.deepEqual(await js(`cfg.calls.filter(call=>call.name==='seed').map(call=>call.args[0])`), [
      {billDate:'2026-09-30',endBalance:'1234.5',merchantId:'M001',currency:'USD',templateName:'模板 A'},
      {billDate:'2026-10-01',endBalance:'88',merchantId:'M002',currency:'EUR',templateName:'模板 A'}
    ]);
    assert.equal(await js('cfg.handle.isOpen()'), false);
    assert.equal(await js('document.getElementById("modalRoot").children.length'), 0);
    assert.equal(await js('cfg.applied'), 2);
  });
  await test('余额确认后遇到清单外账号、断档或校验失败即停下，交回原补录流程', async () => {
    for (const [label, firstResult, expectedText, expectedDraft] of [
      ['清单外账号', `{status:'manual-balance-required',manualBalancePromptReady:true,manualBalancePrompt:{...cfg.importPrompt,merchantId:'M003',currency:'JPY',queueIndex:3}}`, /M003/, ['','']],
      ['校验失败', `{status:'manual-balance-invalid',message:'请输入有效的上一账单日余额',manualBalancePromptReady:true,manualBalancePrompt:cfg.importPrompt}`, /M001/, ['2026-09-30','1234.5']]
    ]) {
      await setup();
      await js(`${IMPORT_PROMPT_JS}cfg.openImport();cfg.importFile();`); await tick();
      await js(`cfg.fillRow(1,'2026-10-01','88');cfg.seedQueue=[${firstResult}];cfg.top().querySelector('[data-action="confirm-save"]').click();`); await tick(); await tick();
      assert.equal(await js(`cfg.calls.filter(call=>call.name==='seed').length`), 1, label);
      assert.equal(await js('document.getElementById("modalRoot").children.length'), 1, label);
      assert.equal(await js(`cfg.top().querySelector('.dialog-title').textContent`), '补录上一账单日余额', label);
      assert.match(await js(`cfg.top().querySelector('[data-view="manual"]').textContent`), expectedText, label);
      assert.deepEqual(await js(`[cfg.top().querySelector('.manual-balance-date-input').value,cfg.top().querySelector('.manual-balance-amount-input').value]`), expectedDraft, label);
    }
  });
  await test('余额确认账号较多且最小窗口放大到 150% 时，表格滚动、卡片不出窗口，返回与确认可见可点', async () => {
    await setup({ zoom: 1.5 });
    await js(`${IMPORT_PROMPT_JS}
      cfg.importResult.accounts=Array.from({length:20},(_,i)=>({merchantId:'62220000000000'+String(i).padStart(2,'0'),currency:'USD',targetBillDate:'2026-10-01',
        billDate:i%3?'2026-09-30':'',endBalance:i%3?123456789.12:null,source:i%3?'file':'manual',reason:i%3?'':'文件中 2026-09-30 有多个不同余额'}));
      cfg.openImport();cfg.importFile();`);
    await tick();
    await layout.settle();
    const geometry = await js(`(() => {
      const card=cfg.top().querySelector('.manual-balance-card'), wrap=card.querySelector('.manual-balance-confirm-table-wrap'),
        body=card.querySelector('.manual-balance-confirm-body'), rect=card.getBoundingClientRect();
      return { fits: rect.bottom<=innerHeight && rect.right<=innerWidth && rect.left>=0,
        scrolls: wrap.scrollHeight>wrap.clientHeight || body.scrollHeight>body.clientHeight,
        buttons: [...card.querySelectorAll('[data-view="confirm"] .dialog-actions button')].map(button => {
          const r=button.getBoundingClientRect(); return r.top>=rect.top && r.bottom<=rect.bottom && r.right<=rect.right; }) };
    })()`);
    assert.deepEqual(geometry, { fits: true, scrolls: true, buttons: [true, true] });
    await layout.click('.manual-balance-card [data-action="confirm-back"]');
    assert.equal(await js(`cfg.top().querySelector('.dialog-title').textContent`), '补录上一账单日余额');
  });
  await test('余额确认连续保存中途 IPC 异常：提示失败、解除锁定；再点确认从已确认的下一个账号接着保存', async () => {
    await setup();
    await js(`${IMPORT_PROMPT_JS}cfg.openImport();cfg.importFile();`); await tick();
    await js(`cfg.fillRow(1,'2026-10-01','88');
      cfg.seedQueue=[{status:'manual-balance-required',manualBalancePromptReady:true,manualBalancePrompt:cfg.secondPrompt},Promise.reject(new Error('IPC 中断'))];
      cfg.top().querySelector('[data-action="confirm-save"]').click();`); await tick(); await tick();
    assert.match(await js('cfg.top().textContent'), /余额补录失败：IPC 中断/);
    await js('cfg.host.closeTop();');
    assert.deepEqual(await js(`[...cfg.top().querySelectorAll('[data-view="confirm"] [data-action]')].map(button=>button.disabled)`), [false,false]);
    await js(`cfg.seedQueue=[{status:'success',message:'余额账单可导出'}];cfg.top().querySelector('[data-action="confirm-save"]').click();`); await tick(); await tick();
    assert.deepEqual(await js(`cfg.calls.filter(call=>call.name==='seed').map(call=>call.args[0].merchantId)`), ['M001','M002','M002']);
    assert.equal(await js('document.getElementById("modalRoot").children.length'), 0);
  });
  // Codex 审查 P1-1：部分保存成功后失败，【返回】不能回到旧账号的表单（否则旧账号的值会写到主进程当前账号）。
  await test('余额确认部分保存成功后中途失败，返回时按主进程当前提示重建补录弹窗，完成带当前账号', async () => {
    await setup();
    await js(`${IMPORT_PROMPT_JS}cfg.openImport();cfg.importFile();`); await tick();
    await js(`cfg.fillRow(1,'2026-10-01','88');
      cfg.seedQueue=[{status:'manual-balance-required',manualBalancePromptReady:true,manualBalancePrompt:cfg.secondPrompt},Promise.reject(new Error('IPC 中断'))];
      cfg.top().querySelector('[data-action="confirm-save"]').click();`); await tick(); await tick();
    await js('cfg.host.closeTop();');
    await js(`cfg.top().querySelector('[data-action="confirm-back"]').click();`); await tick();
    assert.equal(await js('document.getElementById("modalRoot").children.length'), 1);
    assert.equal(await js(`cfg.top().querySelector('.dialog-title').textContent`), '补录上一账单日余额');
    assert.match(await js(`cfg.top().querySelector('.manual-balance-context-account').textContent`), /M002/);
    assert.deepEqual(await js(`[cfg.top().querySelector('.manual-balance-date-input').value,cfg.top().querySelector('.manual-balance-amount-input').value]`), ['','']);
    await js(`cfg.top().querySelector('.manual-balance-date-input').value='2026-10-01';cfg.top().querySelector('.manual-balance-amount-input').value='5';
      cfg.seedQueue=[{status:'success'}];cfg.top().querySelector('[data-action="done"]').click();`); await tick();
    assert.deepEqual(await js(`cfg.calls.filter(call=>call.name==='seed').at(-1).args[0]`),
      {billDate:'2026-10-01',endBalance:'5',merchantId:'M002',currency:'EUR',templateName:'模板 A'});
  });
  // Codex 审查 P1-2：重试不重提已保存账号；下一分组（输出名称不同）的同号账号不自动保存。
  await test('余额确认重试不重提已保存账号；下一分组同号账号停下交回手工补录', async () => {
    await setup();
    await js(`${IMPORT_PROMPT_JS}cfg.openImport();cfg.importFile();`); await tick();
    await js(`cfg.fillRow(1,'2026-10-01','88');
      cfg.seedQueue=[{status:'manual-balance-required',manualBalancePromptReady:true,manualBalancePrompt:cfg.secondPrompt},Promise.reject(new Error('IPC 中断'))];
      cfg.top().querySelector('[data-action="confirm-save"]').click();`); await tick(); await tick();
    await js('cfg.host.closeTop();');
    await js(`cfg.otherGroupPrompt={...cfg.importPrompt,templateName:'模板 B',queueIndex:1,queueTotal:1,pendingAccounts:[{merchantId:'M001',currency:'USD',targetBillDate:'2026-10-01'}]};
      cfg.seedQueue=[{status:'manual-balance-required',manualBalancePromptReady:true,manualBalancePrompt:cfg.otherGroupPrompt}];
      cfg.top().querySelector('[data-action="confirm-save"]').click();`); await tick(); await tick();
    assert.deepEqual(await js(`cfg.calls.filter(call=>call.name==='seed').map(call=>call.args[0].merchantId+'/'+call.args[0].templateName)`),
      ['M001/模板 A','M002/模板 A','M002/模板 A']);
    assert.equal(await js('document.getElementById("modalRoot").children.length'), 1);
    assert.equal(await js(`cfg.top().querySelector('.dialog-title').textContent`), '补录上一账单日余额');
    assert.deepEqual(await js(`[cfg.top().querySelector('.manual-balance-date-input').value,cfg.top().querySelector('.manual-balance-amount-input').value]`), ['','']);
  });
  // Codex 审查 P2-4：主进程按账号核对拒绝时带回当前提示，按当前账号重新打开且不带入原账号草稿。
  await test('待补录账号已变化：按主进程带回的当前提示重新打开补录，不预填原账号的值', async () => {
    await setup();
    await js(`${IMPORT_PROMPT_JS}cfg.openImport();cfg.importFile();`); await tick();
    await js(`cfg.fillRow(1,'2026-10-01','88');
      cfg.seedQueue=[{status:'manual-balance-invalid',errorCode:'BALANCE_SEED_ACCOUNT_CHANGED',message:'待补录账号已变化',manualBalancePromptReady:true,manualBalancePrompt:cfg.secondPrompt}];
      cfg.top().querySelector('[data-action="confirm-save"]').click();`); await tick(); await tick();
    assert.equal(await js('document.getElementById("modalRoot").children.length'), 1);
    assert.match(await js(`cfg.top().querySelector('.manual-balance-context-account').textContent`), /M002/);
    assert.deepEqual(await js(`[cfg.top().querySelector('.manual-balance-date-input').value,cfg.top().querySelector('.manual-balance-amount-input').value]`), ['','']);
  });
  // Codex 审查 P2-5：小额余额预填为普通小数，不写成指数。
  await test('余额确认预填小额余额为普通小数', async () => {
    await setup();
    await js(`${IMPORT_PROMPT_JS}cfg.importResult.accounts[0].endBalance=0.0000001;cfg.importResult.accounts[1]={...cfg.importResult.accounts[1],billDate:'2026-09-30',endBalance:-2.5e-8,source:'file',reason:''};
      cfg.openImport();cfg.importFile();`); await tick();
    assert.deepEqual(await js(`cfg.rows().map(row=>row.querySelector('.manual-balance-confirm-amount').value)`), ['0.0000001','-0.000000025']);
  });
  // Codex 审查第四轮 P2：部分保存失败后，已保存行只读并标「已保存」，重试只提交其余账号。
  await test('余额确认部分保存后失败：已保存行只读并标为已保存，未保存行可改，重试只提交未保存账号', async () => {
    await setup();
    await js(`${IMPORT_PROMPT_JS}cfg.openImport();cfg.importFile();`); await tick();
    await js(`cfg.fillRow(1,'2026-10-01','88');
      cfg.seedQueue=[{status:'manual-balance-required',manualBalancePromptReady:true,manualBalancePrompt:cfg.secondPrompt},Promise.reject(new Error('IPC 中断'))];
      cfg.top().querySelector('[data-action="confirm-save"]').click();`); await tick(); await tick();
    await js('cfg.host.closeTop();');
    assert.deepEqual(await js(`cfg.rows().map(row=>({saved:row.classList.contains('is-saved'),
      disabled:[...row.querySelectorAll('input')].map(input=>input.disabled)}))`), [
      {saved:true,disabled:[true,true]},
      {saved:false,disabled:[false,false]}
    ]);
    assert.equal(await js(`cfg.rows()[0].cells[5].textContent.trim()`), '已保存');
    await js(`cfg.fillRow(1,'2026-10-01','99');cfg.seedQueue=[{status:'success'}];cfg.top().querySelector('[data-action="confirm-save"]').click();`); await tick(); await tick();
    assert.deepEqual(await js(`cfg.calls.filter(call=>call.name==='seed').map(call=>call.args[0].merchantId+':'+call.args[0].endBalance)`),
      ['M001:1234.5','M002:88','M002:99']);
    assert.equal(await js('document.getElementById("modalRoot").children.length'), 0);
  });
  // release/v3.2.17 Codex 审查 P2：保存被准入拒绝（busy，如数据库空闲整理尚未退出）时种子未写入，
  //   不能标为已保存，也不能清状态、关弹窗；保留确认视图与未保存行，稍后重试接着保存。
  await test('余额确认连续保存遇到 busy：该账号不标已保存，保留确认视图与草稿；重试接着保存', async () => {
    await setup();
    await js(`${IMPORT_PROMPT_JS}cfg.openImport();cfg.importFile();`); await tick();
    await js(`cfg.fillRow(1,'2026-10-01','88');
      cfg.seedQueue=[{status:'manual-balance-required',manualBalancePromptReady:true,manualBalancePrompt:cfg.secondPrompt},{status:'busy',message:'数据库正在整理'}];
      cfg.top().querySelector('[data-action="confirm-save"]').click();`); await tick(); await tick();
    assert.equal(await js('document.getElementById("modalRoot").children.length'), 2);
    assert.match(await js('cfg.top().textContent'), /余额尚未保存：数据库正在整理/);
    await js('cfg.host.closeTop();');
    assert.equal(await js('cfg.handle.isOpen()'), true);
    assert.deepEqual(await js('cfg.view()'), {title:'余额确认',manualHidden:true,confirmHidden:false});
    assert.deepEqual(await js(`cfg.rows().map(row=>({saved:row.classList.contains('is-saved'),
      values:[...row.querySelectorAll('input')].map(input=>[input.value,input.disabled])}))`), [
      {saved:true,values:[['2026-09-30',true],['1234.5',true]]},
      {saved:false,values:[['2026-10-01',false],['88',false]]}
    ]);
    assert.match(await js(`cfg.top().querySelector('[data-role="confirm-message"]').textContent`), /余额尚未保存/);
    assert.equal(await js('cfg.applied'), 1);
    await js(`cfg.seedQueue=[{status:'success'}];cfg.top().querySelector('[data-action="confirm-save"]').click();`); await tick(); await tick();
    assert.deepEqual(await js(`cfg.calls.filter(call=>call.name==='seed').map(call=>call.args[0].merchantId+':'+call.args[0].endBalance)`),
      ['M001:1234.5','M002:88','M002:88']);
    assert.equal(await js('document.getElementById("modalRoot").children.length'), 0);
  });
  await test('手工补录完成遇到 busy：保留弹窗与已填日期、余额，不清状态；重试成功后关闭', async () => {
    await setup();
    await js(`cfg.handle=cfg.bridge.openModal(()=>cfg.dialogs.createManualBalanceSeedDialog({templateName:'模板 A',merchantId:'M001',currency:'VND',targetBillDate:'2026-10-01'})).handle;
      cfg.top().querySelector('.manual-balance-date-input').value='2026-09-30';cfg.top().querySelector('.manual-balance-amount-input').value='1000';
      cfg.next.seed={status:'busy',message:'数据库正在整理'};cfg.top().querySelector('[data-action="done"]').click();`); await tick();
    assert.equal(await js('document.getElementById("modalRoot").children.length'), 2);
    assert.match(await js('cfg.top().textContent'), /余额尚未保存：数据库正在整理/);
    await js('cfg.host.closeTop();');
    assert.deepEqual(await js(`({open:cfg.handle.isOpen(),applied:cfg.applied,date:cfg.top().querySelector('.manual-balance-date-input').value,
      amount:cfg.top().querySelector('.manual-balance-amount-input').value,doneDisabled:cfg.top().querySelector('[data-action="done"]').disabled})`),
    {open:true,applied:0,date:'2026-09-30',amount:'1000',doneDisabled:false});
    await js(`cfg.next.seed={status:'success'};cfg.top().querySelector('[data-action="done"]').click();`); await tick();
    assert.equal(await js('cfg.handle.isOpen()'), false);
    assert.equal(await js(`cfg.calls.filter(call=>call.name==='seed').length`), 2);
  });
  await test('导入余额文件失败时提示原因，停留在手工补录视图', async () => {
    await setup();
    await js(`${IMPORT_PROMPT_JS}cfg.openImport();cfg.next.balanceImport={status:'error',message:'余额文件缺少列：期末余额',detailLines:['需要表头']};
      cfg.top().querySelector('[data-action="import-balance-file"]').click();`); await tick();
    assert.equal(await js('document.getElementById("modalRoot").children.length'), 2);
    assert.match(await js('cfg.top().textContent'), /导入余额文件失败：余额文件缺少列：期末余额/);
    await js('cfg.host.closeTop();');
    assert.deepEqual(await js('cfg.view()'), {title:'补录上一账单日余额',manualHidden:false,confirmHidden:true});
  });

  const GAP_PROMPT_JS = `cfg.gapPrompt={reason:'gap',templateName:'模板 A',merchantId:'M001',currency:'USD',anchorDate:'2026-09-01',targetBillDate:'2026-09-04',
    missingFrom:'2026-09-02',missingTo:'2026-09-03',suggestedSeedDate:'2026-09-03',gapKey:'K1',
    gaps:[{key:'K1',merchantId:'M001',currency:'USD',anchorDate:'2026-09-01',targetBillDate:'2026-09-04',missingFrom:'2026-09-02',missingTo:'2026-09-03'},
      {key:'K2',merchantId:'M002',currency:'EUR',anchorDate:'2026-09-01',targetBillDate:'2026-09-03',missingFrom:'2026-09-02',missingTo:'2026-09-02'}]};
    cfg.handle=cfg.bridge.openModal(()=>cfg.dialogs.createManualBalanceSeedDialog(cfg.gapPrompt)).handle;void 0;`;
  await test('账单日期断档先确认；补录进入预填日期的补录弹窗，不补录此处只提交该处并直接进入下一处', async () => {
    await setup();
    await js(GAP_PROMPT_JS);
    assert.equal(await js(`Boolean(cfg.top().querySelector('.balance-gap-card'))`), true);
    assert.match(await js('cfg.top().textContent'), /共 2 处/);
    assert.match(await js('cfg.top().textContent'), /缺 2026-09-02 ~ 2026-09-03/);
    await js(`cfg.top().querySelector('[data-action="fill"]').click();`); await tick();
    assert.deepEqual(await js(`({gap:Boolean(cfg.top().querySelector('.balance-gap-card')),date:cfg.top().querySelector('.manual-balance-date-input').value,
      skip:Boolean(cfg.top().querySelector('[data-action="skip-gap"]')),count:document.getElementById('modalRoot').children.length})`),
    {gap:false,date:'2026-09-03',skip:true,count:1});
    await js(`cfg.next.seed={status:'manual-balance-required',manualBalancePromptReady:true,
      manualBalancePrompt:{...cfg.gapPrompt,merchantId:'M002',currency:'EUR',gapKey:'K2',suggestedSeedDate:'2026-09-02',gaps:[cfg.gapPrompt.gaps[1]]}};
      cfg.top().querySelector('[data-action="skip-gap"]').click();`); await tick();
    assert.deepEqual(await js(`cfg.calls.filter(call=>call.name==='seed').map(call=>call.args[0])`), [{skipBalanceGapKeys:['K1']}]);
    assert.deepEqual(await js(`({gap:Boolean(cfg.top().querySelector('.balance-gap-card')),date:cfg.top().querySelector('.manual-balance-date-input').value,
      remaining:/还有 1 处待处理/.test(cfg.top().textContent),count:document.getElementById('modalRoot').children.length})`),
    {gap:false,date:'2026-09-02',remaining:true,count:1});
  });
  await test('账单日期断档全部不补录：一次提交全部断档键，提交期间锁定窗口，完成后关闭', async () => {
    await setup();
    await js(GAP_PROMPT_JS);
    await js(`cfg.write=cfg.defer();cfg.next.seed=cfg.write;cfg.action=cfg.top().querySelector('[data-action="skip-all"]');
      cfg.action.click();cfg.action.dispatchEvent(new Event('click'));`);
    assert.deepEqual(await js(`cfg.calls.filter(call=>call.name==='seed').map(call=>call.args[0])`), [{skipBalanceGapKeys:['K1','K2']}]);
    assert.equal(await js('cfg.handle.close().status'), 'blocked');
    await js(`cfg.write.resolve({status:'warning',message:'余额账单可导出'});`); await tick();
    assert.equal(await js('cfg.handle.isOpen()'), false);
    assert.equal(await js('cfg.applied'), 1);
  });
  await test('账单日期断档全部不补录遇到 busy：保留断档确认框、不清状态，可重试', async () => {
    await setup();
    await js(GAP_PROMPT_JS);
    await js(`cfg.next.seed={status:'busy',message:'数据库正在整理'};cfg.top().querySelector('[data-action="skip-all"]').click();`); await tick();
    assert.match(await js('cfg.top().textContent'), /余额尚未保存：数据库正在整理/);
    await js('cfg.host.closeTop();');
    assert.deepEqual(await js(`({open:cfg.handle.isOpen(),applied:cfg.applied,gap:Boolean(cfg.top().querySelector('.balance-gap-card')),
      disabled:cfg.top().querySelector('[data-action="skip-all"]').disabled})`), {open:true,applied:0,gap:true,disabled:false});
    await js(`cfg.next.seed={status:'warning',message:'余额账单可导出'};cfg.top().querySelector('[data-action="skip-all"]').click();`); await tick();
    assert.equal(await js('cfg.handle.isOpen()'), false);
    assert.equal(await js('cfg.applied'), 1);
  });
  await test('首次补录上一账单日余额后转入断档：先弹统一断档确认框，可一键全部不补录', async () => {
    await setup();
    await js(`${GAP_PROMPT_JS.replace(/cfg\.handle=[\s\S]*$/, '')}
      cfg.handle=cfg.bridge.openModal(()=>cfg.dialogs.createManualBalanceSeedDialog({merchantId:'M009',currency:'CNY',targetBillDate:'2026-09-01'},{billDate:'2026-08-31',endBalance:'10'})).handle;
      cfg.next.seed={status:'manual-balance-required',manualBalancePromptReady:true,manualBalancePrompt:cfg.gapPrompt};
      cfg.top().querySelector('[data-action="done"]').click();`); await tick();
    assert.deepEqual(await js(`({confirm:Boolean(cfg.top().querySelector('.balance-gap-card')),skipAll:Boolean(cfg.top().querySelector('[data-action="skip-all"]')),
      count:document.getElementById('modalRoot').children.length})`), {confirm:true,skipAll:true,count:1});
    assert.match(await js('cfg.top().textContent'), /共 2 处/);
  });
  await test('账单日期断档较多且最小窗口放大到 150% 时，正文滚动，两个操作按钮可见可点', async () => {
    await setup({ zoom: 1.5 });
    await js(`${GAP_PROMPT_JS.replace(/cfg\.handle=[\s\S]*$/, '')}
      cfg.gapPrompt.gaps=Array.from({length:12},(_,i)=>({...cfg.gapPrompt.gaps[0],key:'K'+i,merchantId:'M'+String(i).padStart(3,'0')}));
      cfg.handle=cfg.bridge.openModal(()=>cfg.dialogs.createManualBalanceSeedDialog(cfg.gapPrompt)).handle;void 0;`);
    await layout.settle();
    const geometry = await js(`(() => {
      const card=cfg.top().querySelector('.balance-gap-card'), body=card.querySelector('.balance-gap-body'), rect=card.getBoundingClientRect();
      return { fits: rect.bottom<=innerHeight, scrolls: body.scrollHeight>body.clientHeight,
        buttons: [...card.querySelectorAll('.dialog-actions button')].map(button => {
          const r=button.getBoundingClientRect(); return r.top>=rect.top && r.bottom<=rect.bottom; }) };
    })()`);
    assert.deepEqual(geometry, { fits: true, scrolls: true, buttons: [true, true] });
    await layout.click('.balance-gap-card [data-action="skip-all"]');
    assert.deepEqual(await js(`cfg.calls.filter(call=>call.name==='seed').map(call=>call.args[0].skipBalanceGapKeys.length)`), [12]);
  });

  // v3.2.16：账单里的余额逐日校验不一致确认。
  const MISMATCH_PROMPT_JS = `cfg.mismatchPrompt={reason:'mismatch',templateName:'模板 A',merchantId:'M001',currency:'USD',targetBillDate:'2026-09-01',
    mismatches:[{key:'X1',merchantId:'M001',currency:'USD',billDate:'2026-09-01',anchorDate:'2026-08-31',anchorSource:'seed',anchorBalance:1000,
        creditAmount:100,debitAmount:0,expectedBalance:1100,statementBalance:9999,difference:8899,missingFrom:'',missingTo:''},
      {key:'X2',merchantId:'M002',currency:'EUR',billDate:'2026-09-07',anchorDate:'2026-09-04',anchorSource:'statement',anchorBalance:500,
        creditAmount:0,debitAmount:20,expectedBalance:480,statementBalance:470,difference:-10,missingFrom:'2026-09-05',missingTo:'2026-09-06'}]};
    cfg.handle=cfg.bridge.openModal(()=>cfg.dialogs.createManualBalanceSeedDialog(cfg.mismatchPrompt)).handle;void 0;`;
  await test('余额校验不一致：列出差异与缺的日期；返回核查不提交；确认继续一次提交全部键，提交期间锁定，完成后关闭', async () => {
    await setup();
    await js(MISMATCH_PROMPT_JS);
    assert.equal(await js(`Boolean(cfg.top().querySelector('.balance-mismatch-card'))`), true);
    assert.equal(await js(`Boolean(cfg.top().querySelector('.manual-balance-date-input'))`), false);
    const text = await js('cfg.top().textContent');
    assert.match(text, /共 2 处/);
    assert.match(text, /上一日余额 1,000\.00（余额种子 2026-08-31） \+ 收入 100\.00 − 支出 0\.00 = 预期 1,100\.00，账单余额 9,999\.00，差额 \+8,899\.00/);
    assert.match(text, /差额 -10\.00；中间缺 2026-09-05 ~ 2026-09-06/);
    await js(`cfg.top().querySelector('[data-action="review"]').click();`); await tick();
    assert.equal(await js('cfg.handle.isOpen()'), false);
    assert.equal(await js(`cfg.calls.filter(call=>call.name==='seed').length`), 0);

    await js(MISMATCH_PROMPT_JS);
    await js(`cfg.write=cfg.defer();cfg.next.seed=cfg.write;cfg.action=cfg.top().querySelector('[data-action="confirm"]');
      cfg.action.click();cfg.action.dispatchEvent(new Event('click'));`);
    assert.deepEqual(await js(`cfg.calls.filter(call=>call.name==='seed').map(call=>call.args[0])`), [{confirmBalanceMismatchKeys:['X1','X2']}]);
    assert.equal(await js('cfg.handle.close().status'), 'blocked');
    await js(`cfg.write.resolve({status:'warning',message:'余额账单可导出'});`); await tick();
    assert.equal(await js('cfg.handle.isOpen()'), false);
    assert.equal(await js('cfg.applied'), 1);
  });
  await test('余额校验不一致较多且最小窗口放大到 150% 时，正文滚动，两个操作按钮可见可点', async () => {
    await setup({ zoom: 1.5 });
    await js(`${MISMATCH_PROMPT_JS.replace(/cfg\.handle=[\s\S]*$/, '')}
      cfg.mismatchPrompt.mismatches=Array.from({length:12},(_,i)=>({...cfg.mismatchPrompt.mismatches[1],key:'X'+i,merchantId:'M'+String(i).padStart(3,'0')}));
      cfg.handle=cfg.bridge.openModal(()=>cfg.dialogs.createManualBalanceSeedDialog(cfg.mismatchPrompt)).handle;void 0;`);
    await layout.settle();
    const geometry = await js(`(() => {
      const card=cfg.top().querySelector('.balance-mismatch-card'), body=card.querySelector('.balance-gap-body'), rect=card.getBoundingClientRect();
      return { fits: rect.bottom<=innerHeight, scrolls: body.scrollHeight>body.clientHeight,
        buttons: [...card.querySelectorAll('.dialog-actions button')].map(button => {
          const r=button.getBoundingClientRect(); return r.top>=rect.top && r.bottom<=rect.bottom; }) };
    })()`);
    assert.deepEqual(geometry, { fits: true, scrolls: true, buttons: [true, true] });
    await layout.click('.balance-mismatch-card [data-action="confirm"]');
    assert.deepEqual(await js(`cfg.calls.filter(call=>call.name==='seed').map(call=>call.args[0].confirmBalanceMismatchKeys.length)`), [12]);
  });

  // v3.2.16：同一账单日人工补录余额将被替换的确认，列出人工补录值与账单值。
  const REPLACE_PROMPT_JS = `cfg.replacePrompt={reason:'seed-replace',templateName:'模板 A',merchantId:'M001',currency:'USD',targetBillDate:'2026-09-01',
    replacements:[{key:'R1',merchantId:'M001',currency:'USD',billDate:'2026-09-01',balanceSource:'statement',manualBalance:5000,balance:1100,difference:-3900,adjustment:0,writtenBalance:1100},
      {key:'R2',merchantId:'M002',currency:'EUR',billDate:'2026-09-03',balanceSource:'calculated',manualBalance:480,balance:470,difference:-10,adjustment:10,writtenBalance:480}]};
    cfg.handle=cfg.bridge.openModal(()=>cfg.dialogs.createManualBalanceSeedDialog(cfg.replacePrompt)).handle;void 0;`;
  await test('人工补录替换：列出人工补录值与账单值；返回核查不提交；确认替换一次提交全部键，提交期间锁定，完成后关闭', async () => {
    await setup();
    await js(REPLACE_PROMPT_JS);
    assert.equal(await js(`Boolean(cfg.top().querySelector('.balance-seed-replace-card'))`), true);
    assert.equal(await js(`Boolean(cfg.top().querySelector('.manual-balance-date-input'))`), false);
    const text = await js('cfg.top().textContent');
    assert.match(text, /人工补录余额将被替换/);
    assert.match(text, /2026-09-01：人工补录余额 5,000\.00，账单余额 1,100\.00，差额 -3,900\.00/);
    assert.match(text, /2026-09-03：人工补录余额 480\.00，计算余额 470\.00（另加余额附加值 10\.00 后写入 480\.00），差额 -10\.00/);
    await js(`cfg.top().querySelector('[data-action="review"]').click();`); await tick();
    assert.equal(await js('cfg.handle.isOpen()'), false);
    assert.equal(await js(`cfg.calls.filter(call=>call.name==='seed').length`), 0);

    await js(REPLACE_PROMPT_JS);
    await js(`cfg.write=cfg.defer();cfg.next.seed=cfg.write;cfg.action=cfg.top().querySelector('[data-action="confirm"]');
      cfg.action.click();cfg.action.dispatchEvent(new Event('click'));`);
    assert.deepEqual(await js(`cfg.calls.filter(call=>call.name==='seed').map(call=>call.args[0])`), [{confirmBalanceSeedReplaceKeys:['R1','R2']}]);
    assert.equal(await js('cfg.handle.close().status'), 'blocked');
    await js(`cfg.write.resolve({status:'warning',message:'余额账单可导出'});`); await tick();
    assert.equal(await js('cfg.handle.isOpen()'), false);
    assert.equal(await js('cfg.applied'), 1);
  });
  await test('余额不一致确认后转入人工补录替换：确认框换成替换确认', async () => {
    await setup();
    await js(`${MISMATCH_PROMPT_JS}${REPLACE_PROMPT_JS.replace(/cfg\.handle=[\s\S]*$/, '')}
      cfg.next.seed={status:'manual-balance-required',manualBalancePromptReady:true,manualBalancePrompt:cfg.replacePrompt};
      cfg.top().querySelector('[data-action="confirm"]').click();`); await tick();
    assert.deepEqual(await js(`({replace:Boolean(cfg.top().querySelector('.balance-seed-replace-card')),
      count:document.getElementById('modalRoot').children.length})`), {replace:true,count:1});
  });

  async function setupRowCount(nextN=1) {
    await setup();
    await js(`
      cfg.rows=[{seqNo:1,rowStatus:'draft',currencySourceField:'Currency'},{seqNo:2,rowStatus:'draft',currencySourceField:'Currency'}];
      cfg.rowWrite=cfg.defer();cfg.rowSettled=0;cfg.api.templates.saveBillSplitRowCount=payload=>{cfg.calls.push({name:'rowCount',args:[payload]});return cfg.rowWrite.promise.then(result=>{cfg.rowSettled++;return result;});};
      cfg.router=ModuleRouter.createModuleRouter({defaultModuleId:'application',modules:['application','other'].map(id=>({id,controller:{enter:()=>({status:'ready'}),leave:()=>cfg.host.closeOwner('application','navigation').status==='blocked'?{status:'blocked'}:{status:'left'},dispose(){}}}))});cfg.router.navigate('application',{persist:false});
      cfg.parent=cfg.other();cfg.handle=cfg.bridge.pushModal(cfg.parent,()=>cfg.dialogs.createBillSplitRowsDialog({template:{id:7,name:'模板',headers:['Currency']},initialRows:cfg.rows})).handle;
      cfg.overlay=cfg.top();cfg.input=cfg.overlay.querySelector('.bill-split-row-count-input');cfg.button=cfg.overlay.querySelector('.bill-split-row-count-done-btn');
      cfg.input.value=${JSON.stringify(String(nextN))};cfg.button.click();cfg.confirm=cfg.host.getTop();cfg.confirmOverlay=cfg.top();void 0;
    `);
  }
  await test('减少拆分份数的确认保存同步锁住父子、根替换和导航，重复确认一次写',async()=>{
    await setupRowCount();await js(`cfg.confirmButton=cfg.confirmOverlay.querySelector('[data-action="confirm"]');cfg.confirmButton.click();cfg.confirmButton.dispatchEvent(new Event('click'));`);
    assert.deepEqual(await js(`({calls:cfg.calls.filter(call=>call.name==='rowCount').length,disabled:cfg.confirmButton.disabled,root:cfg.bridge.openModal(()=>{throw new Error('不能创建');}).status,parent:cfg.parent.close().status,rows:cfg.handle.close().status,confirm:cfg.confirm.close().status,navigate:cfg.router.navigate('other').status})`),
      {calls:1,disabled:true,root:'blocked',parent:'blocked',rows:'blocked',confirm:'blocked',navigate:'blocked'});
    await js(`cfg.rowWrite.resolve({status:'success',currentRows:cfg.rows.slice(0,1)});`);await tick();
    assert.deepEqual(await js(`({args:cfg.calls.find(call=>call.name==='rowCount').args,rows:cfg.overlay.querySelectorAll('.bill-split-rows-table tbody tr').length,rowsTop:cfg.handle.isTop(),confirmOpen:cfg.confirm.isOpen(),settled:cfg.rowSettled})`),
      {args:[{templateId:7,nextN:1}],rows:1,rowsTop:true,confirmOpen:false,settled:1});
  });
  await test('增加拆分份数的直接保存同样拒绝重复点击和父层关闭',async()=>{
    await setupRowCount(3);await js(`cfg.button.dispatchEvent(new Event('click'));`);
    assert.equal(await js(`cfg.calls.filter(call=>call.name==='rowCount').length`),1);
    assert.equal(await js('cfg.handle.close().status'),'blocked');
    await js(`cfg.rowWrite.resolve({status:'success',currentRows:[...cfg.rows,{seqNo:3,rowStatus:'draft'}]});`);await tick();
    assert.equal(await js(`cfg.handle.isTop()&&!cfg.button.disabled&&cfg.overlay.querySelectorAll('.bill-split-rows-table tbody tr').length===3`),true);
  });
  await test('拆分份数写入失败保留确认及父稿可重试，取消零额外写入',async()=>{
    await setupRowCount();await js(`cfg.confirmOverlay.querySelector('[data-action="confirm"]').click();cfg.rowWrite.resolve({status:'failed',message:'保存份数失败'});`);await tick();
    assert.match(await js('cfg.top().textContent'),/保存份数失败/);
    await js('cfg.host.closeTop();');
    assert.equal(await js(`cfg.confirm.isTop()&&!cfg.confirmOverlay.querySelector('[data-action="confirm"]').disabled`),true);
    await js(`cfg.rowWrite=cfg.defer();cfg.confirmOverlay.querySelector('[data-action="confirm"]').click();cfg.rowWrite.reject(new Error('连接失败'));`);await tick();
    assert.match(await js('cfg.top().textContent'),/连接失败/);
    await js(`cfg.host.closeTop();cfg.confirmOverlay.querySelector('[data-action="cancel"]').click();`);
    assert.equal(await js(`cfg.handle.isTop()&&cfg.overlay.querySelectorAll('.bill-split-rows-table tbody tr').length===2`),true);
    assert.equal(await js(`cfg.calls.filter(call=>call.name==='rowCount').length`),2);
    await setupRowCount();await js(`cfg.confirmOverlay.querySelector('[data-action="cancel"]').click();`);
    assert.equal(await js(`cfg.handle.isTop()&&cfg.calls.filter(call=>call.name==='rowCount').length===0`),true);
  });
  await test('拆分份数强制销毁后的后台结算不写旧 DOM、不关闭新窗口',async()=>{
    await setupRowCount();await js(`cfg.confirmOverlay.querySelector('[data-action="confirm"]').click();cfg.handle.dispose();cfg.oldMarkup=cfg.overlay.innerHTML;cfg.newHandle=cfg.bridge.openModal(()=>cfg.dialogs.createAlertDialog('新窗口')).handle;cfg.rowWrite.resolve({status:'success',currentRows:[]});`);await tick();
    assert.deepEqual(await js('({settled:cfg.rowSettled,newTop:cfg.newHandle.isTop(),unchanged:cfg.oldMarkup===cfg.overlay.innerHTML})'),{settled:1,newTop:true,unchanged:true});
  });

  async function setupRowWrites({ groups=[9], completed=false, rules=false, signed=false, signedTargets=null, feeBill=null, feeFormula=null, layoutOptions=null }={}) {
    await setup(layoutOptions);
    await js(`
      cfg.rowTemplate={id:7,name:'删行测试模板',headers:['Currency','Amount']};
      cfg.rows=[{seqNo:1,rowStatus:${JSON.stringify(completed?'completed':'draft')},currencySourceField:'Currency',creditSourceField:'',debitSourceField:''},{seqNo:2,rowStatus:${JSON.stringify(completed?'completed':'draft')},currencySourceField:'Currency',creditSourceField:'',debitSourceField:''}];
      cfg.groups=${JSON.stringify(groups)};cfg.settled=[];cfg.initialRules=${rules?'cfg.rules':'[]'};
      cfg.meta={signedAmountSourceField:${JSON.stringify(signed?'Amount':'')},signedAmountTargetSeqNos:${signedTargets===null?(signed?'[1]':'[]'):JSON.stringify(signedTargets)},byFieldAmountTargetSeqNos:${rules?'[1]':'[]'}};
      ${feeBill===null?'':`cfg.rows.forEach(row=>{row.isFeeBill=row.seqNo===${Number(feeBill)};});`}
      ${feeFormula===null?'':`cfg.meta.feeAmountFormulaEnabled=true;cfg.meta.feeAmountFormula=${JSON.stringify(feeFormula)};`}
      const methodNames={previewDeleteBillSplitRow:'preview',deleteBillSplitRow:'deleteRow',saveBillSplitRow:'saveRow',saveBillSplitRowCount:'rowCount',clearBillSplitMergeGroups:'clearMerge',saveBillSplitMergeGroup:'saveMerge',saveBillSplitMeta:'rowMeta',saveBillSplitAmountRules:'rowRules'};
      for(const [method,name] of Object.entries(methodNames)) cfg.api.templates[method]=payload=>cfg.invoke(name,[structuredClone(payload)],name==='preview'?{status:'success',dissolvedGroups:cfg.groups}:name==='deleteRow'||name==='rowCount'?{status:'success',currentRows:cfg.rows.slice(0,1)}:{status:'success'}).then(result=>{cfg.settled.push(name);return result;});
      cfg.api.templates.getBillSplitConfig=id=>cfg.invoke('rowRefresh',[id],{status:'success',billSplitRows:cfg.rows,billSplitAmountRules:cfg.initialRules,billSplitMeta:cfg.meta});
      cfg.openRows=()=>{cfg.parent=cfg.other();cfg.handle=cfg.bridge.pushModal(cfg.parent,()=>cfg.dialogs.createBillSplitRowsDialog({template:cfg.rowTemplate,initialRows:cfg.rows,initialAmountRules:cfg.initialRules,initialBillSplitMeta:cfg.meta})).handle;
        cfg.overlay=cfg.top();cfg.deleteButton=cfg.overlay.querySelector('.bill-split-row-delete-btn');};
      cfg.openRows();cfg.writeCount=()=>cfg.calls.filter(call=>['deleteRow','saveRow','rowCount','clearMerge','saveMerge','rowMeta','rowRules'].includes(call.name)).length;
      cfg.beginDelete=()=>cfg.deleteButton.click();cfg.captureConfirm=()=>{cfg.confirm=cfg.host.getTop();cfg.confirmOverlay=cfg.top();cfg.confirmButton=cfg.confirmOverlay.querySelector('[data-action="confirm"]');};void 0;
    `);
  }
  await test('RR01 有合并组删行只发一次原参数，写中父子及根替换/导航均拒绝',async()=>{
    await setupRowWrites();await js('cfg.beginDelete();');await tick();
    assert.match(await js('cfg.top().textContent'),/账单序号 1.*合并组 9/);
    await js('cfg.captureConfirm();cfg.write=cfg.defer();cfg.next.deleteRow=cfg.write;cfg.confirmButton.click();cfg.confirmButton.click();cfg.confirmButton.dispatchEvent(new Event("click"));');
    assert.deepEqual(await js(`({calls:cfg.calls.filter(x=>x.name==='deleteRow').map(x=>x.args),disabled:cfg.confirmButton.disabled,parent:cfg.parent.close().status,rows:cfg.handle.close().status,child:cfg.confirm.close().status,navigation:cfg.host.closeOwner('application','navigation').status,root:cfg.bridge.openModal(()=>cfg.dialogs.createAlertDialog('错误替换')).status})`),
      {calls:[[{templateId:7,seqNo:1}]],disabled:true,parent:'blocked',rows:'blocked',child:'blocked',navigation:'blocked',root:'blocked'});
    await js('cfg.write.resolve({status:"success",currentRows:[{seqNo:1,rowStatus:"draft",currencySourceField:"Currency"}]});');await tick();
    assert.deepEqual(await js('({top:cfg.handle.isTop(),confirmOpen:cfg.confirm.isOpen(),count:cfg.overlay.querySelectorAll("tbody tr").length,n:cfg.overlay.querySelector(".bill-split-row-count-input").value})'),{top:true,confirmOpen:false,count:1,n:'1'});
  });
  await test('RR01 无组有效预检直接删除，重复预检只启动一次删除并锁父层',async()=>{
    await setupRowWrites({groups:[]});await js('cfg.write=cfg.defer();cfg.next.deleteRow=cfg.write;cfg.beginDelete();cfg.beginDelete();');await tick();
    assert.equal(await js('cfg.calls.filter(x=>x.name==="deleteRow").length'),1);
    assert.equal(await js('cfg.handle.close().status'),'blocked');
    await js('cfg.write.resolve({status:"success",currentRows:[]});');await tick();
    assert.equal(await js('cfg.handle.isTop()&&cfg.overlay.querySelectorAll("tbody tr").length===0'),true);
  });
  for (const kind of ['close','replace']) for (const groups of [[],[9]]) {
    await test(`RR01 ${kind}后旧预检${groups.length?'有组':'无组'}晚到，零删除且不操作新栈`,async()=>{
      await setupRowWrites({groups});await js('cfg.read=cfg.defer();cfg.next.preview=cfg.read;cfg.beginDelete();');
      const closed=await js(kind==='close'?'cfg.handle.close().status':'cfg.bridge.openModal(()=>cfg.dialogs.createAlertDialog("替换窗口")).status');
      assert.equal(closed,kind==='close'?'closed':'opened');
      await js(`cfg.nextHandle=cfg.other();cfg.markup=cfg.overlay.innerHTML;cfg.read.resolve({status:'success',dissolvedGroups:${JSON.stringify(groups)}});`);await tick();
      assert.deepEqual(await js('({writes:cfg.writeCount(),newTop:cfg.nextHandle.isTop(),unchanged:cfg.markup===cfg.overlay.innerHTML})'),{writes:0,newTop:true,unchanged:true});
    });
  }
  await test('RR01 不同行预检逆序返回只保留最新预检，旧结果不确认或删除错位序号',async()=>{
    await setupRowWrites();await js('cfg.readA=cfg.defer();cfg.next.preview=cfg.readA;cfg.beginDelete();cfg.readB=cfg.defer();cfg.next.preview=cfg.readB;cfg.overlay.querySelectorAll(".bill-split-row-delete-btn")[1].click();cfg.readB.resolve({status:"success",dissolvedGroups:[8]});');await tick();
    await js('cfg.readA.resolve({status:"success",dissolvedGroups:[]});');await tick();
    assert.equal(await js('cfg.writeCount()'),0);
    assert.match(await js('cfg.top().textContent'),/账单序号 2.*合并组 8/);
    await js('cfg.top().querySelector("[data-action=confirm]").click();');await tick();
    assert.deepEqual(await js('cfg.calls.filter(x=>x.name==="deleteRow").map(x=>x.args)'),[[{templateId:7,seqNo:2}]]);
  });
  await test('RR01 其他行写入开始并结算后，早先未发送删除的预检仍永久失效',async()=>{
    await setupRowWrites({groups:[]});await js('cfg.read=cfg.defer();cfg.next.preview=cfg.read;cfg.beginDelete();cfg.overlay.querySelector(".bill-split-row-complete-btn").click();');await tick();
    await js('cfg.read.resolve({status:"success",dissolvedGroups:[]});');await tick();
    assert.equal(await js('cfg.calls.filter(x=>x.name==="saveRow").length'),1);
    assert.equal(await js('cfg.calls.filter(x=>x.name==="deleteRow").length'),0);
  });
  await test('RR01 预检失败/reject不当作无组合，反馈后允许重新预检并取消',async()=>{
    await setupRowWrites();await js('cfg.next.preview={status:"failed",message:"预检服务失败"};cfg.beginDelete();');await tick();
    assert.equal(await js('cfg.writeCount()'),0);assert.match(await js('cfg.top().textContent'),/预检服务失败/);
    await js('cfg.host.closeTop();cfg.read=cfg.defer();cfg.next.preview=cfg.read;cfg.beginDelete();cfg.read.reject(new Error("预检连接失败"));');await tick();
    assert.equal(await js('cfg.writeCount()'),0);assert.match(await js('cfg.top().textContent'),/预检连接失败/);
    await js('cfg.host.closeTop();cfg.beginDelete();');await tick();
    await js('cfg.top().querySelector("[data-action=cancel]").click();');assert.equal(await js('cfg.handle.isTop()&&cfg.writeCount()===0'),true);
  });
  await test('RR01 删除失败和reject保留父/确认草稿供重试，取消不额外写',async()=>{
    await setupRowWrites();await js('cfg.beginDelete();');await tick();
    await js('cfg.captureConfirm();cfg.next.deleteRow={status:"failed",message:"删除服务失败"};cfg.confirmButton.click();');await tick();
    assert.match(await js('cfg.top().textContent'),/删除服务失败/);
    await js('cfg.host.closeTop();cfg.write=cfg.defer();cfg.next.deleteRow=cfg.write;cfg.confirmButton.click();cfg.write.reject(new Error("删除连接失败"));');await tick();
    assert.match(await js('cfg.top().textContent'),/删除连接失败/);
    await js('cfg.host.closeTop();cfg.confirmOverlay.querySelector("[data-action=cancel]").click();');
    assert.deepEqual(await js('({count:cfg.writeCount(),top:cfg.handle.isTop(),rows:cfg.overlay.querySelectorAll("tbody tr").length})'),{count:2,top:true,rows:2});
  });
  for(const status of ['success','failed','cancelled']) await test(`RR01 已发送删除${status}在force dispose后结算，旧DOM/新窗不续接`,async()=>{
    await setupRowWrites();await js('cfg.beginDelete();');await tick();
    await js(`cfg.captureConfirm();cfg.write=cfg.defer();cfg.next.deleteRow=cfg.write;cfg.confirmButton.click();cfg.handle.dispose();cfg.markup=cfg.overlay.innerHTML;cfg.nextHandle=cfg.other();cfg.write.resolve({status:${JSON.stringify(status)},message:'合成结果',currentRows:[]});`);await tick();
    assert.deepEqual(await js('({settled:cfg.settled.filter(x=>x==="deleteRow").length,writes:cfg.writeCount(),unchanged:cfg.overlay.innerHTML===cfg.markup,newTop:cfg.nextHandle.isTop()})'),{settled:1,writes:1,unchanged:true,newTop:true});
  });
  await test('RR01 行重绘/序号重排后旧行节点事件不再写入或预检',async()=>{
    await setupRowWrites({groups:[]});await js('cfg.oldRow=cfg.overlay.querySelector("tbody tr");cfg.beginDelete();');await tick();
    await js('cfg.callCount=cfg.calls.length;cfg.oldRow.querySelector(".bill-split-row-delete-btn").dispatchEvent(new Event("click"));cfg.oldRow.querySelector(".bill-split-row-complete-btn").dispatchEvent(new Event("click"));');await tick();
    assert.equal(await js('cfg.calls.length===cfg.callCount'),true);
  });
  const rowEntrances=[
    {name:'单行完成',method:'saveRow',action:`cfg.overlay.querySelector('.bill-split-row-complete-btn').click();`,payload:{templateId:7,row:{seqNo:1,rowStatus:'completed',currencySourceField:'Currency',creditSourceField:'',debitSourceField:''}}},
    {name:'取消全部合并组',method:'clearMerge',action:`cfg.merge=cfg.overlay.querySelector('.bill-split-merge-checkbox');cfg.merge.checked=false;cfg.merge.dispatchEvent(new Event('change'));`,payload:{templateId:7}},
    {name:'保存合并组',method:'saveMerge',completed:true,action:`cfg.merge=cfg.overlay.querySelector('.bill-split-merge-checkbox');cfg.merge.checked=true;cfg.merge.dispatchEvent(new Event('change'));cfg.overlay.querySelector('.bill-split-merge-picker-trigger').click();cfg.overlay.querySelectorAll('.bill-split-merge-picker-panel input').forEach(node=>{node.checked=true;node.dispatchEvent(new Event('change'));});cfg.overlay.querySelector('.bill-split-merge-done-btn').click();`,payload:{templateId:7,seqNos:[1,2]}},
    {name:'正负号元信息',method:'rowMeta',action:`cfg.select=cfg.overlay.querySelector('.bill-split-signed-select');cfg.select.value='Amount';cfg.select.dispatchEvent(new Event('change'));`,payload:{templateId:7,signedAmountSourceField:'Amount',signedAmountTargetSeqNos:[],byFieldAmountTargetSeqNos:[]}},
    {name:'指定正负号账单清空',method:'rowMeta',signed:true,action:`cfg.select=cfg.overlay.querySelector('.bill-split-signed-target-seq-checkbox');cfg.select.checked=false;cfg.select.dispatchEvent(new Event('change'));`,payload:{templateId:7,signedAmountSourceField:'Amount',signedAmountTargetSeqNos:[],byFieldAmountTargetSeqNos:[]}},
    {name:'指定字段账单清空',method:'rowMeta',rules:true,action:`cfg.select=cfg.overlay.querySelector('.bill-split-by-field-target-seq-checkbox');cfg.select.checked=false;cfg.select.dispatchEvent(new Event('change'));`,payload:{templateId:7,signedAmountSourceField:'',signedAmountTargetSeqNos:[],byFieldAmountTargetSeqNos:[]}},
    // v3.2.19：费用账单勾选与特殊取值勾选同样共用父写锁
    {name:'费用账单勾选',method:'rowMeta',action:`cfg.fee=cfg.overlay.querySelectorAll('.bill-split-fee-bill-checkbox')[1];cfg.fee.checked=true;cfg.fee.dispatchEvent(new Event('change'));`,payload:{templateId:7,feeBillSeqNo:2}},
    {name:'费用账单特殊取值勾选',method:'rowMeta',feeBill:2,action:`cfg.select=cfg.overlay.querySelector('.bill-split-fee-formula-checkbox');cfg.select.checked=true;cfg.select.dispatchEvent(new Event('change'));`,payload:{templateId:7,feeAmountFormulaEnabled:true}}
  ];
  for(const entry of rowEntrances) await test(`RR01 ${entry.name}共用父写锁，跨类型写入口受阻且旧DOM不接纳迟到结果`,async()=>{
    await setupRowWrites(entry);await js(`cfg.write=cfg.defer();cfg.next.${entry.method}=cfg.write;${entry.action}`);
    assert.equal(await js('cfg.handle.close().status'),'blocked');
    await js(`cfg.overlay.querySelector('.bill-split-row-delete-btn').dispatchEvent(new Event('click'));cfg.overlay.querySelector('.bill-split-row-complete-btn').dispatchEvent(new Event('click'));cfg.overlay.querySelector('.bill-split-row-count-input').value='3';cfg.overlay.querySelector('.bill-split-row-count-done-btn').dispatchEvent(new Event('click'));`);await tick();
    assert.equal(await js('cfg.writeCount()'),1);assert.equal(await js('cfg.calls.some(x=>x.name==="preview")'),false);
    assert.deepEqual(await js(`cfg.calls.find(x=>x.name===${JSON.stringify(entry.method)}).args`),[entry.payload]);
    await js('cfg.handle.dispose();cfg.markup=cfg.overlay.innerHTML;cfg.nextHandle=cfg.other();cfg.write.resolve({status:"success"});');await tick();
    assert.deepEqual(await js('({unchanged:cfg.markup===cfg.overlay.innerHTML,newTop:cfg.nextHandle.isTop(),refresh:cfg.calls.filter(x=>x.name==="rowRefresh").length})'),{unchanged:true,newTop:true,refresh:0});
  });
  await test('RR01 按字段规则子层保存共享父锁，失败重试成功后返回同一父层',async()=>{
    await setupRowWrites({rules:true});await js('cfg.overlay.querySelector(".bill-split-amount-rules-manage-btn").click();cfg.rulesOverlay=cfg.top();cfg.rulesHandle=cfg.host.getTop();cfg.write=cfg.defer();cfg.next.rowRules=cfg.write;cfg.rulesOverlay.querySelector("[data-action=done]").click();');
    assert.equal(await js('cfg.handle.close().status'),'blocked');assert.equal(await js('cfg.rulesHandle.close().status'),'blocked');
    await js('cfg.write.resolve({status:"failed",message:"规则保存失败"});');await tick();assert.match(await js('cfg.top().textContent'),/规则保存失败/);
    await js('cfg.host.closeTop();cfg.rulesOverlay.querySelector("[data-action=done]").click();');await tick();
    assert.equal(await js('cfg.handle.isTop()&&!cfg.rulesHandle.isOpen()'),true);
    assert.equal(await js('cfg.calls.filter(x=>x.name==="rowRules").length'),2);
  });
  for(const mode of ['signed','clear-rules']) await test(`RR01 ${mode}已发送互斥写链在force dispose后完成配套写，撤销UI续接`,async()=>{
    await setupRowWrites({rules:true});await js(`cfg.write=cfg.defer();cfg.next.rowRules=cfg.write;cfg.select=cfg.overlay.querySelector(${JSON.stringify(mode==='signed'?'.bill-split-signed-select':'.bill-split-by-field-select')});cfg.select.value=${JSON.stringify(mode==='signed'?'Amount':'')};cfg.select.dispatchEvent(new Event('change'));`);
    assert.equal(await js('cfg.handle.close().status'),'blocked');
    await js('cfg.handle.dispose();cfg.markup=cfg.overlay.innerHTML;cfg.nextHandle=cfg.other();cfg.write.resolve({status:"success"});');await tick();
    assert.deepEqual(await js('cfg.calls.filter(x=>["rowRules","rowMeta"].includes(x.name)).map(x=>x.name)'),['rowRules','rowMeta']);
    assert.deepEqual(await js('({unchanged:cfg.markup===cfg.overlay.innerHTML,newTop:cfg.nextHandle.isTop()})'),{unchanged:true,newTop:true});
  });
  await test('RR01 清空正负号后准备打开规则窗，force dispose后不新建子层',async()=>{
    await setupRowWrites({signed:true});await js('cfg.write=cfg.defer();cfg.next.rowMeta=cfg.write;cfg.select=cfg.overlay.querySelector(".bill-split-by-field-select");cfg.select.value="是";cfg.select.dispatchEvent(new Event("change"));');
    assert.equal(await js('cfg.handle.close().status'),'blocked');
    await js('cfg.handle.dispose();cfg.markup=cfg.overlay.innerHTML;cfg.nextHandle=cfg.other();cfg.write.resolve({status:"success"});');await tick();
    assert.deepEqual(await js('({writes:cfg.writeCount(),unchanged:cfg.markup===cfg.overlay.innerHTML,newTop:cfg.nextHandle.isTop()})'),{writes:1,unchanged:true,newTop:true});
  });

  // ==================== v3.2.19 发生额取值设置 · 费用账单 ====================
  const FEE_ROW_STATE_JS = `[...cfg.overlay.querySelectorAll('.bill-split-rows-table tbody tr')].map(tr=>({
    fee:tr.querySelector('.bill-split-fee-bill-checkbox').checked,
    credit:tr.querySelector('.bill-split-credit-select').disabled,
    debit:tr.querySelector('.bill-split-debit-select').disabled}))`;
  const FEE_FORMULA_UI_JS = `({checked:cfg.overlay.querySelector('.bill-split-fee-formula-checkbox').checked,
    disabled:cfg.overlay.querySelector('.bill-split-fee-formula-checkbox').disabled,
    settings:!cfg.overlay.querySelector('.bill-split-fee-formula-settings-btn').hidden,
    hint:!cfg.overlay.querySelector('.bill-split-fee-formula-hint').hidden})`;
  await test('FB01 发生额取值设置文案与费用账单列', async () => {
    await setupRowWrites();
    assert.deepEqual(await js(`({title:cfg.overlay.querySelector('.bill-split-sub-section h3').textContent,
      labels:[...cfg.overlay.querySelectorAll('.bill-split-sub-row > label:first-child')].map(node=>node.textContent),
      heads:[...cfg.overlay.querySelectorAll('.bill-split-rows-table thead th')].map(node=>node.textContent),
      manage:cfg.overlay.querySelector('.bill-split-amount-rules-manage-btn').textContent})`),
    {title:'发生额取值设置',labels:['按正负号取发生额','按字段取发生额','费用账单发生额特殊取值逻辑'],
      heads:['账单序号','Currency','Credit Amount','Debit Amount','执行操作','费用账单'],manage:'发生额映射关系管理'});
    assert.deepEqual(await js(FEE_FORMULA_UI_JS),{checked:false,disabled:true,settings:false,hint:true});
  });
  await test('FB02 费用账单勾选唯一：立即写入，勾选行 Credit 置灰，以主进程返回的标记为准；失败时按重读的已保存配置显示', async () => {
    await setupRowWrites();
    await js(`cfg.next.rowMeta={status:'success',currentRows:[{seqNo:1,isFeeBill:false},{seqNo:2,isFeeBill:true}]};
      cfg.fee=cfg.overlay.querySelectorAll('.bill-split-fee-bill-checkbox')[1];cfg.fee.checked=true;cfg.fee.dispatchEvent(new Event('change'));`);await tick();
    assert.deepEqual(await js('cfg.calls.filter(x=>x.name==="rowMeta").map(x=>x.args[0])'),[{templateId:7,feeBillSeqNo:2}]);
    assert.deepEqual(await js(FEE_ROW_STATE_JS),[{fee:false,credit:false,debit:false},{fee:true,credit:true,debit:false}]);
    assert.deepEqual(await js(FEE_FORMULA_UI_JS),{checked:false,disabled:false,settings:false,hint:false});
    await js(`cfg.next.rowMeta={status:'success',currentRows:[{seqNo:1,isFeeBill:true},{seqNo:2,isFeeBill:false}]};
      cfg.fee=cfg.overlay.querySelectorAll('.bill-split-fee-bill-checkbox')[0];cfg.fee.checked=true;cfg.fee.dispatchEvent(new Event('change'));`);await tick();
    assert.deepEqual(await js(FEE_ROW_STATE_JS),[{fee:true,credit:true,debit:false},{fee:false,credit:false,debit:false}]);
    // 落库后同步阶段失败：不当作回滚，按重读到的已保存配置（库里已取消）显示，保留失败提示
    await js(`cfg.next.rowMeta={status:'failed',message:'费用账单保存失败'};
      cfg.fee=cfg.overlay.querySelectorAll('.bill-split-fee-bill-checkbox')[0];cfg.fee.checked=false;cfg.fee.dispatchEvent(new Event('change'));`);await tick();
    assert.match(await js('cfg.top().textContent'),/费用账单保存失败/);
    assert.deepEqual(await js('cfg.calls.filter(x=>x.name==="rowMeta").map(x=>x.args[0].feeBillSeqNo)'),[2,1,null]);
    assert.equal(await js('cfg.calls.filter(x=>x.name==="rowRefresh").length'),1);
    assert.deepEqual(await js(FEE_ROW_STATE_JS),[{fee:false,credit:false,debit:false},{fee:false,credit:false,debit:false}]);
  });
  await test('FB07 费用配置保存失败且重读失败：提示关闭重开，暂停本窗口配置写入，关闭与完成仍可用', async () => {
    await setupRowWrites({feeBill:2});
    await js(`cfg.api.templates.getBillSplitConfig=id=>{cfg.calls.push({name:'rowRefresh',args:[id]});return Promise.reject(new Error('读不到'));};
      cfg.next.rowMeta={status:'failed',message:'模板库同步失败'};
      cfg.select=cfg.overlay.querySelector('.bill-split-fee-formula-checkbox');cfg.select.checked=true;cfg.select.dispatchEvent(new Event('change'));`);await tick();
    assert.match(await js('cfg.top().textContent'),/模板库同步失败[\s\S]*请关闭后重新打开以确认/);
    await js('cfg.host.closeTop();void 0;');
    assert.deepEqual(await js(`({locked:[...cfg.overlay.querySelectorAll('button, input, select')].filter(node=>!node.matches('.icon-close, .bill-split-rows-done-btn')).every(node=>node.disabled),
      close:!cfg.overlay.querySelector('.icon-close').disabled,done:!cfg.overlay.querySelector('.bill-split-rows-done-btn').disabled})`),{locked:true,close:true,done:true});
    await js(`cfg.fee=cfg.overlay.querySelectorAll('.bill-split-fee-bill-checkbox')[0];cfg.fee.disabled=false;cfg.fee.checked=true;cfg.fee.dispatchEvent(new Event('change'));`);await tick();
    assert.equal(await js('cfg.calls.filter(x=>x.name==="rowMeta").length'),1);
  });
  await test('FB08 费用行的 Debit 可与停用的 Credit 同列；取消费用账单后按主进程保存的 Credit 显示', async () => {
    await setupRowWrites({feeBill:1});
    await js(`cfg.rows[0].creditSourceField='Amount';cfg.handle.dispose();cfg.openRows();
      cfg.debit=cfg.overlay.querySelector('.bill-split-debit-select');cfg.debit.value='Amount';cfg.debit.dispatchEvent(new Event('change'));void 0;`);await tick();
    assert.equal(await js('cfg.handle.isTop()'),true);
    await js(`cfg.overlay.querySelector('.bill-split-row-complete-btn').click();`);await tick();
    assert.deepEqual(await js('cfg.calls.filter(x=>x.name==="saveRow").map(x=>[x.args[0].row.creditSourceField,x.args[0].row.debitSourceField])'),[['Amount','Amount']]);
    // 主进程取消费用账单时清掉与 Debit 同列的 Credit
    await js(`cfg.next.rowMeta={status:'success',currentRows:[{seqNo:1,isFeeBill:false,creditSourceField:''},{seqNo:2,isFeeBill:false,creditSourceField:''}]};
      cfg.fee=cfg.overlay.querySelectorAll('.bill-split-fee-bill-checkbox')[0];cfg.fee.checked=false;cfg.fee.dispatchEvent(new Event('change'));`);await tick();
    assert.deepEqual(await js(`[...cfg.overlay.querySelectorAll('.bill-split-rows-table tbody tr')][0].querySelectorAll('.bill-split-row-view-text')[1].textContent`),'');
    assert.deepEqual(await js(`[...cfg.overlay.querySelectorAll('.bill-split-rows-table tbody tr')][0].querySelectorAll('.bill-split-row-view-text')[2].textContent`),'Amount');
  });
  await test('FB06 费用行的 Credit / Debit 只在界面置灰显示为空：关闭特殊取值、取消费用账单后原映射恢复，【完成】按原映射保存', async () => {
    await setupRowWrites({feeBill:1,feeFormula:[{field:'Amount',op:'end'}]});
    await js(`cfg.rows[0].creditSourceField='Amount';cfg.rows[0].debitSourceField='Currency';cfg.handle.dispose();cfg.openRows();void 0;`);
    const cells = `[...cfg.overlay.querySelectorAll('.bill-split-rows-table tbody tr')][0]`;
    const view = `({credit:[${cells}.querySelector('.bill-split-credit-select').value,${cells}.querySelector('.bill-split-credit-select').disabled],
      debit:[${cells}.querySelector('.bill-split-debit-select').value,${cells}.querySelector('.bill-split-debit-select').disabled]})`;
    assert.deepEqual(await js(view),{credit:['',true],debit:['',true]});
    await js(`cfg.select=cfg.overlay.querySelector('.bill-split-fee-formula-checkbox');cfg.select.checked=false;cfg.select.dispatchEvent(new Event('change'));`);await tick();
    assert.deepEqual(await js(view),{credit:['',true],debit:['Currency',false]});
    await js(`cfg.next.rowMeta={status:'success',currentRows:[{seqNo:1,isFeeBill:false,creditSourceField:'Amount',debitSourceField:'Currency'},{seqNo:2,isFeeBill:false,creditSourceField:''}]};
      cfg.fee=cfg.overlay.querySelectorAll('.bill-split-fee-bill-checkbox')[0];cfg.fee.checked=false;cfg.fee.dispatchEvent(new Event('change'));`);await tick();
    assert.deepEqual(await js(view),{credit:['Amount',false],debit:['Currency',false]});
    // 重新勾选后再点【完成】：载荷按原映射保存，不把置灰显示的空值写回
    await js(`cfg.next.rowMeta={status:'success',currentRows:[{seqNo:1,isFeeBill:true},{seqNo:2,isFeeBill:false}]};
      cfg.fee=cfg.overlay.querySelectorAll('.bill-split-fee-bill-checkbox')[0];cfg.fee.checked=true;cfg.fee.dispatchEvent(new Event('change'));`);await tick();
    await js(`cfg.overlay.querySelector('.bill-split-row-complete-btn').click();`);await tick();
    assert.deepEqual(await js('cfg.calls.filter(x=>x.name==="saveRow").map(x=>[x.args[0].row.creditSourceField,x.args[0].row.debitSourceField,x.args[0].row.rowStatus])'),
      [['Amount','Currency','completed']]);
    assert.deepEqual(await js(`[...cfg.overlay.querySelectorAll('.bill-split-rows-table tbody tr')][0].querySelectorAll('.bill-split-row-view-text')[1].textContent`),'');
  });
  await test('FB03 特殊取值勾选即写入，勾选后显示【设置】且费用账单行 Debit 置灰；合并行的费用勾选框禁用', async () => {
    await setupRowWrites({feeBill:2});
    assert.deepEqual(await js(FEE_FORMULA_UI_JS),{checked:false,disabled:false,settings:false,hint:false});
    await js(`cfg.select=cfg.overlay.querySelector('.bill-split-fee-formula-checkbox');cfg.select.checked=true;cfg.select.dispatchEvent(new Event('change'));`);await tick();
    assert.deepEqual(await js('cfg.calls.filter(x=>x.name==="rowMeta").map(x=>x.args[0])'),[{templateId:7,feeAmountFormulaEnabled:true}]);
    assert.deepEqual(await js(FEE_FORMULA_UI_JS),{checked:true,disabled:false,settings:true,hint:false});
    assert.deepEqual(await js(FEE_ROW_STATE_JS),[{fee:false,credit:false,debit:false},{fee:true,credit:true,debit:true}]);
    await js(`cfg.select.checked=false;cfg.select.dispatchEvent(new Event('change'));`);await tick();
    assert.deepEqual(await js(FEE_FORMULA_UI_JS),{checked:false,disabled:false,settings:false,hint:false});
    assert.deepEqual((await js(FEE_ROW_STATE_JS))[1],{fee:true,credit:true,debit:false});

    await setupRowWrites({completed:true,feeBill:1});
    await js(`cfg.rows[0].mergedGroupSeq=1;cfg.rows[1].mergedGroupSeq=1;cfg.handle.dispose();cfg.openRows();void 0;`);
    assert.deepEqual(await js(`[...cfg.overlay.querySelectorAll('.bill-split-fee-bill-checkbox')].map(node=>[node.checked,node.disabled])`),[[true,true],[false,true]]);
  });
  await test('FB04 公式弹窗：新增运算字段每次追加一对下拉框，保存校验与载荷，取消不写入', async () => {
    await setupRowWrites({feeBill:2,feeFormula:[]});
    await js(`cfg.overlay.querySelector('.bill-split-fee-formula-settings-btn').click();cfg.formula=cfg.top();cfg.formulaHandle=cfg.host.getTop();void 0;`);
    assert.deepEqual(await js(`({title:cfg.formula.querySelector('.dialog-title').textContent,
      order:[...cfg.formula.querySelector('.bill-split-fee-formula-editor').children].map(node=>node.textContent.trim()),
      actions:[...cfg.formula.querySelectorAll('.dialog-actions button')].map(node=>node.textContent),selects:cfg.formula.querySelectorAll('select').length})`),
    {title:'费用账单发生额设置',order:['新增运算字段','发生额=',''],actions:['保存','取消'],selects:0});
    await js(`cfg.add=()=>cfg.formula.querySelector('.bill-split-fee-formula-add-btn').click();cfg.add();cfg.add();cfg.add();
      cfg.fields=()=>[...cfg.formula.querySelectorAll('.bill-split-fee-formula-field')];cfg.ops=()=>[...cfg.formula.querySelectorAll('.bill-split-fee-formula-operator')];void 0;`);
    assert.deepEqual(await js(`({fields:cfg.fields().length,ops:cfg.ops().length,options:[...cfg.ops()[0].options].map(node=>node.textContent),
      headers:[...cfg.fields()[0].options].map(node=>node.value)})`),
    {fields:3,ops:3,options:['','加','减','乘','除','运算结束'],headers:['','Currency','Amount']});
    // 「运算结束」不在最后一组 → 提示，不写入
    await js(`cfg.fields()[0].value='Amount';cfg.ops()[0].value='end';cfg.fields()[1].value='Currency';cfg.ops()[1].value='end';
      cfg.formula.querySelector('[data-action="save"]').click();`);await tick();
    assert.match(await js('cfg.top().textContent'),/「运算结束」只能用在最后一组，第 1 组之后还有运算字段/);
    assert.equal(await js('cfg.calls.filter(x=>x.name==="rowMeta").length'),0);
    // 第 3 组两项空白时忽略
    await js(`cfg.host.closeTop();cfg.ops()[0].value='*';cfg.formula.querySelector('[data-action="save"]').click();`);await tick();
    assert.deepEqual(await js('cfg.calls.filter(x=>x.name==="rowMeta").map(x=>x.args[0])'),
      [{templateId:7,feeAmountFormulaEnabled:true,feeAmountFormula:[{field:'Amount',op:'*'},{field:'Currency',op:'end'}]}]);
    assert.equal(await js('cfg.formulaHandle.isOpen()||!cfg.handle.isTop()'),false);
    // 重开回显已保存的公式；取消不写入
    await js(`cfg.overlay.querySelector('.bill-split-fee-formula-settings-btn').click();cfg.formula=cfg.top();void 0;`);
    assert.deepEqual(await js(`[...cfg.formula.querySelectorAll('select')].map(node=>node.value)`),['Amount','*','Currency','end']);
    await js(`cfg.formula.querySelector('.bill-split-fee-formula-add-btn').click();cfg.formula.querySelector('[data-action="cancel"]').click();`);await tick();
    assert.deepEqual(await js('({calls:cfg.calls.filter(x=>x.name==="rowMeta").length,top:cfg.handle.isTop()})'),{calls:1,top:true});
  });
  await test('FB05 公式弹窗布局：一行 6 个下拉框，第 7 个换行并与首个左对齐，间距一致', async () => {
    await setupRowWrites({feeBill:2,feeFormula:[],layoutOptions:{zoom:1}});
    await js(`cfg.overlay.querySelector('.bill-split-fee-formula-settings-btn').click();cfg.formula=cfg.top();
      for(let i=0;i<4;i+=1) cfg.formula.querySelector('.bill-split-fee-formula-add-btn').click();void 0;`);
    await layout.settle();
    const geometry = await js(`(()=>{const rects=[...cfg.formula.querySelectorAll('.bill-split-fee-formula-grid select')].map(node=>node.getBoundingClientRect());
      const label=cfg.formula.querySelector('.bill-split-fee-formula-label').getBoundingClientRect();
      const card=cfg.formula.querySelector('.modal-card').getBoundingClientRect();
      return {count:rects.length,firstRowTops:new Set(rects.slice(0,6).map(r=>Math.round(r.top))).size,
        wrapped:rects[6].top>rects[0].bottom,alignedLeft:Math.abs(rects[6].left-rects[0].left)<1,
        gap:Math.round(rects[1].left-rects[0].right),labelBeforeGrid:label.right<=rects[0].left,
        insideCard:rects.every(r=>r.right<=card.right&&r.left>=card.left),minWidth:Math.round(Math.min(...rects.map(r=>r.width)))};})()`);
    assert.deepEqual({ ...geometry, minWidth: geometry.minWidth >= 90 }, {count:8,firstRowTops:1,wrapped:true,alignedLeft:true,gap:6,labelBeforeGrid:true,insideCard:true,minWidth:true});
    await js('new Promise(resolve=>setTimeout(resolve,400))');await layout.settle();
    await layout.evidence('bill-split-fee-formula-100', { geometry });
    await js(`cfg.host.closeTop();void 0;`);await layout.settle();
    await layout.evidence('bill-split-rows-fee-bill-100', {});
  });

  async function openMappingRows() {
    await setupRowWrites();
    await js(`cfg.mappingHandle=cfg.bridge.openModal(()=>cfg.dialogs.createMappingDialog({template:cfg.rowTemplate,targetFields:['是否拆分/合并明细账单'],mappings:[{templateField:'是否拆分/合并明细账单',mappedField:'是'}],billSplitRows:cfg.rows})).handle;
      cfg.mappingOverlay=cfg.top();cfg.openRowsButton=cfg.mappingOverlay.querySelector('.bill-split-group-btn');cfg.openRowsButton.click();void 0;`);
    await tick();
    await js('cfg.rowsHandle=cfg.host.getTop();cfg.rowsOverlay=cfg.top();void 0;');
  }
  async function setupMappingRowsReturn() {
    await openMappingRows();
    await js(`cfg.calls=[];cfg.returnRead=cfg.defer();cfg.next.rowRefresh=cfg.returnRead;cfg.rowsOverlay.querySelector('.icon-close').click();void 0;`);
  }
  await test('RR01 实际映射→行管理异步返回保持原子层，禁止重复返回及普通关闭旁路',async()=>{
    await setupMappingRowsReturn();
    assert.equal(await js('cfg.rowsHandle.isTop()&&cfg.mappingOverlay.inert'),true);
    await js('cfg.rowsOverlay.querySelector(".icon-close").dispatchEvent(new Event("click"));cfg.rowsOverlay.querySelector(".bill-split-row-complete-btn").dispatchEvent(new Event("click"));');
    assert.deepEqual(await js(`({reads:cfg.calls.filter(x=>x.name==='rowRefresh').length,writes:cfg.writeCount(),rows:cfg.rowsHandle.close().status,submitted:cfg.rowsHandle.close({status:'submitted'}).status,owner:cfg.host.closeOwner('application','navigation').status,parent:cfg.mappingHandle.close().status,escape:cfg.rowsHandle.close({status:'cancelled',reason:'escape'}).status,root:cfg.bridge.openModal(()=>cfg.dialogs.createAlertDialog('错误替换')).status})`),
      {reads:1,writes:0,rows:'blocked',submitted:'blocked',owner:'blocked',parent:'blocked',escape:'blocked',root:'blocked'});
    await js('cfg.returnRead.resolve({status:"success",billSplitRows:cfg.rows});');await tick();
    assert.equal(await js('cfg.mappingHandle.isTop()&&!cfg.rowsHandle.isOpen()'),true);
    await js('cfg.openRowsButton.click();');await tick();await js('cfg.newRows=cfg.host.getTop();void 0;');
    assert.equal(await js('cfg.newRows.isTop()'),true);
  });
  await test('RR01 实际行管理返回读取期间强制销毁，旧回调不能关父层后来新开的行管理',async()=>{
    await setupMappingRowsReturn();
    await js('cfg.rowsHandle.dispose();cfg.openRowsButton.click();');await tick();
    await js('cfg.newRows=cfg.host.getTop();cfg.newMarkup=cfg.top().innerHTML;cfg.returnRead.resolve({status:"success",billSplitRows:[]});');await tick();
    assert.equal(await js('cfg.newRows.isTop()&&cfg.newMarkup===cfg.top().innerHTML'),true);
    await js('cfg.newRows.close();cfg.openRowsButton.click();');await tick();
    assert.equal(await js('cfg.top().querySelectorAll(".bill-split-rows-table tbody tr").length'),2);
  });
  await test('RR01 mousedown收起指定账单面板触发同一meta写锁，结束后旧事件不再写',async()=>{
    await setupRowWrites({signed:true});
    await js(`cfg.trigger=cfg.overlay.querySelector('.bill-split-signed-target-seq-picker .bill-split-target-seq-trigger');cfg.trigger.click();cfg.overlay.querySelectorAll('.bill-split-signed-target-seq-panel input').forEach(node=>{node.checked=node.value==='2';});
      cfg.write=cfg.defer();cfg.next.rowMeta=cfg.write;cfg.outside=cfg.overlay.querySelector('.bill-split-row-count-input');cfg.outside.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));`);
    assert.deepEqual(await js('cfg.calls.find(x=>x.name==="rowMeta").args'),[{templateId:7,signedAmountSourceField:'Amount',signedAmountTargetSeqNos:[2],byFieldAmountTargetSeqNos:[]}]);
    assert.equal(await js('cfg.handle.close().status'),'blocked');
    await js('cfg.write.resolve({status:"success"});');await tick();
    assert.match(await js('cfg.trigger.textContent'),/2/);
    await js('cfg.handle.dispose();cfg.callCount=cfg.calls.length;cfg.markup=cfg.overlay.innerHTML;cfg.outside.dispatchEvent(new MouseEvent("mousedown",{bubbles:true}));');
    assert.equal(await js('cfg.calls.length===cfg.callCount&&cfg.markup===cfg.overlay.innerHTML'),true);
  });

  await test('RR01 返回回调失败解锁并显示错误，原窗口可重试且旧忽略参数回调兼容',async()=>{
    await setupRowWrites();
    await js(`cfg.returnCalls=0;cfg.returnWait=cfg.defer();cfg.handle=cfg.bridge.openModal(()=>cfg.dialogs.createBillSplitRowsDialog({template:cfg.rowTemplate,initialRows:cfg.rows,onClose:()=>{cfg.returnCalls++;return cfg.returnWait.promise;}})).handle;
      cfg.overlay=cfg.top();cfg.closeBtn=cfg.overlay.querySelector('.icon-close');cfg.closeBtn.click();cfg.closeBtn.dispatchEvent(new Event('click'));cfg.returnWait.reject(new Error('返回读取失败'));`);await tick();
    assert.match(await js('cfg.top().textContent'),/返回读取失败/);
    await js('cfg.host.closeTop();');assert.equal(await js('cfg.handle.isTop()&&!cfg.closeBtn.disabled&&cfg.returnCalls===1'),true);
    await js('cfg.returnWait=cfg.defer();cfg.closeBtn.click();cfg.returnWait.resolve();');await tick();
    assert.equal(await js('!cfg.handle.isOpen()&&cfg.returnCalls===2'),true);
  });

  await test('RR01 公共关闭后重开行管理先读Main最新行数，读取失败不复用旧缓存',async()=>{
    await openMappingRows();
    await js('cfg.api.templates.saveBillSplitRowCount=async payload=>{cfg.calls.push({name:"rowCount",args:[payload]});cfg.rows=[...cfg.rows,{seqNo:3,rowStatus:"draft"}];return {status:"success",currentRows:cfg.rows};};cfg.rowsOverlay.querySelector(".bill-split-row-count-input").value="3";cfg.rowsOverlay.querySelector(".bill-split-row-count-done-btn").click();');await tick();
    await js('cfg.rowsHandle.close();cfg.openRowsButton.click();');await tick();
    assert.equal(await js('cfg.top().querySelectorAll(".bill-split-rows-table tbody tr").length'),3);
    await js('cfg.host.closeTop();cfg.next.rowRefresh={status:"failed",message:"配置重读失败"};cfg.openRowsButton.click();');await tick();
    assert.match(await js('cfg.top().textContent'),/配置重读失败/);assert.equal(await js('document.querySelectorAll(".bill-split-rows-card").length'),0);
    await js('cfg.host.closeTop();cfg.openRowsButton.click();');await tick();assert.equal(await js('cfg.top().querySelectorAll(".bill-split-rows-table tbody tr").length'),3);
  });
  await test('RR01 打开行管理的读取乱序/父层结束只接纳当前请求，不打开幽灵子层',async()=>{
    await openMappingRows();await js('cfg.rowsHandle.close();cfg.first=cfg.defer();cfg.next.rowRefresh=cfg.first;cfg.openRowsButton.click();cfg.second=cfg.defer();cfg.next.rowRefresh=cfg.second;cfg.openRowsButton.click();cfg.second.resolve({status:"success",billSplitRows:[...cfg.rows,{seqNo:3,rowStatus:"draft"}]});');await tick();
    await js('cfg.first.resolve({status:"success",billSplitRows:[]});');await tick();assert.equal(await js('cfg.top().querySelectorAll(".bill-split-rows-table tbody tr").length'),3);
    await js('cfg.host.closeTop();cfg.late=cfg.defer();cfg.next.rowRefresh=cfg.late;cfg.openRowsButton.click();cfg.mappingHandle.close();cfg.nextHandle=cfg.other();cfg.late.resolve({status:"success",billSplitRows:[]});');await tick();
    assert.equal(await js('cfg.nextHandle.isTop()&&document.querySelectorAll(".bill-split-rows-card").length===0'),true);
  });
  await test('RR01 父映射写开始且已结束后旧打开读取仍失效，不仅检查回包时busy',async()=>{
    await openMappingRows();await js('cfg.rowsHandle.close();cfg.late=cfg.defer();cfg.next.rowRefresh=cfg.late;cfg.openRowsButton.click();cfg.next.mappingSave={status:"failed",message:"父映射保存失败"};cfg.mappingOverlay.querySelector("[data-action=done]").click();');await tick();
    assert.match(await js('cfg.top().textContent'),/父映射保存失败/);
    await js('cfg.host.closeTop();cfg.late.resolve({status:"success",billSplitRows:[{seqNo:99,rowStatus:"draft"}]});');await tick();
    assert.equal(await js('cfg.mappingHandle.isTop()&&document.querySelectorAll(".bill-split-rows-card").length===0'),true);
    await js('cfg.openRowsButton.click();');await tick();assert.equal(await js('cfg.top().querySelectorAll(".bill-split-rows-table tbody tr").length'),2);
  });

  for (const enableAgain of [false,true]) await test(`RR01 打开读取中入口取消${enableAgain?'再启用':''}使旧请求失效，不能复活旧打开意图`,async()=>{
    await openMappingRows();
    await js(`cfg.rowsHandle.close();cfg.late=cfg.defer();cfg.next.rowRefresh=cfg.late;cfg.openRowsButton.click();cfg.toggle=cfg.mappingOverlay.querySelector('[data-template-field="是否拆分/合并明细账单"] .mapping-toggle-checkbox');cfg.toggle.checked=false;cfg.toggle.dispatchEvent(new Event('change'));${enableAgain?"cfg.toggle.checked=true;cfg.toggle.dispatchEvent(new Event('change'));":''}cfg.late.resolve({status:'success',billSplitRows:[]});`);await tick();
    assert.equal(await js('cfg.mappingHandle.isTop()&&document.querySelectorAll(".bill-split-rows-card").length===0'),true);
    if(enableAgain) {await js('cfg.openRowsButton.click();');await tick();assert.equal(await js('cfg.top().querySelectorAll(".bill-split-rows-table tbody tr").length'),2);}
  });

  // R3-01：规则与元信息是两个独立提交；成功阶段改变真实测试存储，失败不回滚前一步。
  async function setupPartialRuleWrite(kind, signedTargets=null) {
    await setupRowWrites({rules:true,signedTargets});
    await js(`
      cfg.calls=[];cfg.commits=[];cfg.readCalls=0;cfg.commitBeforeReply={};
      cfg.store={rules:structuredClone(cfg.initialRules),meta:structuredClone(cfg.meta)};
      cfg.first=cfg.defer();cfg.second=cfg.defer();cfg.gates={rowRules:[cfg.first],rowMeta:[cfg.second]};
      cfg.persist=async(name,payload)=>{
        const frozen=structuredClone(payload);cfg.calls.push({name,args:[frozen]});
        const commit=()=>{
          if(name==='rowRules')cfg.store.rules=structuredClone(frozen.amountSplitRules);
          else {const {templateId,...meta}=frozen;cfg.store.meta=meta;}
          cfg.commits.push({name,payload:frozen});
        };
        // 模拟数据库已提交、后续模板库同步失败；接口返回失败不代表回滚。
        const earlyCommit=cfg.commitBeforeReply[name];if(earlyCommit)commit();
        const gate=cfg.gates[name].shift();const result=gate?await gate.promise:{status:'success'};
        if(result?.status==='success'&&!earlyCommit)commit();
        return result;
      };
      cfg.api.templates.saveBillSplitAmountRules=payload=>cfg.persist('rowRules',payload);
      cfg.api.templates.saveBillSplitMeta=payload=>cfg.persist('rowMeta',payload);
      cfg.api.templates.getBillSplitConfig=async()=>{cfg.readCalls++;if(cfg.configReadGate)await cfg.configReadGate.promise;if(cfg.configReadFailure)throw new Error('配置重读连接失败');return {status:'success',billSplitRows:structuredClone(cfg.rows),billSplitAmountRules:structuredClone(cfg.store.rules),billSplitMeta:structuredClone(cfg.store.meta)};};
      cfg.byField=cfg.overlay.querySelector('.bill-split-by-field-select');
      cfg.signed=cfg.overlay.querySelector('.bill-split-signed-select');
      cfg.manage=cfg.overlay.querySelector('.bill-split-amount-rules-manage-btn');
      // signed 入口在规则存在时通常 disabled；合成 change 覆盖它仍须遵守的相邻写链合同。
      cfg.beginChain=()=>{const select=${kind==='signed'?'cfg.signed':'cfg.byField'};select.value=${JSON.stringify(kind==='signed'?'Amount':'')};select.dispatchEvent(new Event('change'));};
      cfg.chainState=()=>({rules:structuredClone(cfg.store.rules),meta:structuredClone(cfg.store.meta),manageHidden:cfg.manage.hidden,byField:cfg.byField.value,signed:cfg.signed.value,signedDisabled:cfg.signed.disabled,byFieldDisabled:cfg.byField.disabled});
      void 0;
    `);
  }
  const originalRuleMeta={signedAmountSourceField:'',signedAmountTargetSeqNos:[],byFieldAmountTargetSeqNos:[1]};
  async function assertRuleChainSucceeded(kind, signedTargets=[]) {
    const finalMeta={signedAmountSourceField:kind==='signed'?'Amount':'',signedAmountTargetSeqNos:signedTargets,byFieldAmountTargetSeqNos:[]};
    assert.deepEqual(await js('cfg.chainState()'),{rules:[],meta:finalMeta,manageHidden:true,byField:'',signed:finalMeta.signedAmountSourceField,signedDisabled:false,byFieldDisabled:kind==='signed'});
    assert.equal(await js('cfg.handle.isTop()'),true);
    assert.deepEqual(await js('cfg.errors'),[]);
  }
  for(const kind of ['byField','signed']) for(const status of ['failed','reject']) await test(`R3-01 ${kind}首步${status}不提交元信息，独立存储保留原规则并可重试成功`,async()=>{
    await setupPartialRuleWrite(kind);
    await js(`cfg.beginChain();${status==='reject'?"cfg.first.reject(new Error('规则提交连接失败'));":"cfg.first.resolve({status:'failed',message:'规则提交失败'});"}`);await tick();
    assert.match(await js('cfg.top().textContent'),/规则提交.*失败/);
    assert.deepEqual(await js('cfg.store.rules'),await js('cfg.initialRules'));
    assert.deepEqual(await js('cfg.store.meta'),originalRuleMeta);
    assert.equal(await js('cfg.calls.filter(call=>call.name==="rowMeta").length'),0);
    assert.deepEqual(await js('cfg.commits'),[]);
    await js('cfg.host.closeTop();cfg.manage.click();');await tick();
    assert.deepEqual(await js('Array.from(cfg.top().querySelectorAll(".rule-condition-value"),node=>node.value)'),['C','D']);
    await js('cfg.host.closeTop();cfg.beginChain();cfg.second.resolve({status:"success"});');await tick();
    await assertRuleChainSucceeded(kind);
    assert.deepEqual(await js('cfg.commits.map(entry=>entry.name)'),['rowRules','rowMeta']);
  });
  for(const kind of ['byField','signed']) for(const status of ['failed','reject','cancelled']) await test(`R3-01 ${kind}清规则成功后元信息${status}接纳已提交事实，旧规则不复活且能重试`,async()=>{
    const initialMeta={...originalRuleMeta,signedAmountTargetSeqNos:kind==='signed'?[2]:[]};
    await setupPartialRuleWrite(kind,initialMeta.signedAmountTargetSeqNos);
    await js('cfg.beginChain();cfg.first.resolve({status:"success"});');await tick();
    assert.deepEqual(await js('cfg.store'),{rules:[],meta:initialMeta});
    assert.deepEqual(await js('({close:cfg.handle.close().status,parent:cfg.parent.close().status,metaCalls:cfg.calls.filter(call=>call.name==="rowMeta").length})'),{close:'blocked',parent:'blocked',metaCalls:1});
    await js('cfg.beginChain();');
    assert.equal(await js('cfg.calls.filter(call=>call.name==="rowMeta").length'),1);
    await js(status==='reject'?"cfg.second.reject(new Error('元信息提交连接失败'));":`cfg.second.resolve({status:${JSON.stringify(status)},message:'元信息提交${status}'});`);await tick();
    assert.match(await js('cfg.top().textContent'),/元信息提交/);
    await js('cfg.host.closeTop();');
    assert.deepEqual(await js('cfg.chainState()'),{rules:[],meta:initialMeta,manageHidden:true,byField:'',signed:'',signedDisabled:false,byFieldDisabled:false});
    assert.deepEqual(await js('Array.from(cfg.overlay.querySelectorAll(".bill-split-credit-select,.bill-split-debit-select"),node=>node.disabled)'),[false,false,false,false]);
    assert.equal(await js('cfg.overlay.querySelector(".bill-split-by-field-target-seq-label").hidden&&cfg.overlay.querySelector(".bill-split-by-field-target-seq-picker").hidden'),true);
    await js('cfg.byField.value="是";cfg.byField.dispatchEvent(new Event("change"));');await tick();
    assert.deepEqual(await js('Array.from(cfg.top().querySelectorAll(".rule-condition-value"),node=>node.value)'),['','']);
    await js('cfg.top().querySelector("[data-action=cancel]").click();cfg.beginChain();');await tick();
    await assertRuleChainSucceeded(kind,initialMeta.signedAmountTargetSeqNos);
    if(kind==='signed') assert.deepEqual(await js('Array.from(cfg.overlay.querySelectorAll(".bill-split-credit-select,.bill-split-debit-select"),node=>node.disabled)'),[false,false,true,true]);
    assert.deepEqual(await js('cfg.commits.map(entry=>entry.name)'),kind==='signed'?['rowRules','rowMeta']:['rowRules','rowRules','rowMeta']);
    assert.equal(await js('cfg.calls.filter(call=>call.name==="rowMeta").length'),2);
  });
  for(const kind of ['byField','signed']) for(const stage of ['rules','meta']) await test(`R3-01 ${kind}在${stage}在途销毁仍完成两次独立提交，旧DOM和新栈不续接`,async()=>{
    await setupPartialRuleWrite(kind);
    await js('cfg.beginChain();');
    if(stage==='meta'){await js('cfg.first.resolve({status:"success"});');await tick();}
    await js('cfg.handle.dispose();cfg.detachedMarkup=cfg.overlay.innerHTML;cfg.detachedState=cfg.chainState();cfg.nextHandle=cfg.other();void 0;');
    if(stage==='rules'){await js('cfg.first.resolve({status:"success"});');await tick();}
    assert.equal(await js('cfg.calls.filter(call=>call.name==="rowMeta").length'),1);
    await js('cfg.second.resolve({status:"success"});');await tick();
    const expectedMeta={signedAmountSourceField:kind==='signed'?'Amount':'',signedAmountTargetSeqNos:[],byFieldAmountTargetSeqNos:[]};
    assert.deepEqual(await js('cfg.store'),{rules:[],meta:expectedMeta});
    assert.deepEqual(await js('cfg.commits.map(entry=>entry.name)'),['rowRules','rowMeta']);
    assert.equal(await js('cfg.readCalls'),0);
    assert.deepEqual(await js('({unchanged:cfg.detachedMarkup===cfg.overlay.innerHTML,newTop:cfg.nextHandle.isTop(),oldOpen:cfg.handle.isOpen(),calls:cfg.calls.map(entry=>entry.name),errors:cfg.errors})'),{unchanged:true,newTop:true,oldOpen:false,calls:['rowRules','rowMeta'],errors:[]});
    assert.deepEqual(await js('({manageHidden:cfg.manage.hidden,byField:cfg.byField.value,signed:cfg.signed.value,signedDisabled:cfg.signed.disabled,byFieldDisabled:cfg.byField.disabled})'),await js('(({manageHidden,byField,signed,signedDisabled,byFieldDisabled})=>({manageHidden,byField,signed,signedDisabled,byFieldDisabled}))(cfg.detachedState)'));
  });

  for(const [kind,status] of [['byField','failed'],['signed','reject']]) await test(`R3-01 ${kind}元信息已落地但返回${status}时重读持久化事实，同时保留原失败`,async()=>{
    await setupPartialRuleWrite(kind);
    await js('cfg.commitBeforeReply.rowMeta=true;cfg.beginChain();cfg.first.resolve({status:"success"});');await tick();
    await js(status==='reject'?"cfg.second.reject(new Error('元信息提交后模板库同步失败'));":"cfg.second.resolve({status:'failed',message:'元信息提交后模板库同步失败'});");await tick();
    assert.match(await js('cfg.top().textContent'),/元信息提交后模板库同步失败/);
    assert.equal(await js('cfg.readCalls'),1);
    await js('cfg.host.closeTop();');
    await assertRuleChainSucceeded(kind);
    assert.deepEqual(await js('cfg.commits.map(entry=>entry.name)'),['rowRules','rowMeta']);
  });
  await test('R3-01 首步已落地但reject不发第二步，重读接受规则已清的真实状态',async()=>{
    await setupPartialRuleWrite('byField');
    await js('cfg.commitBeforeReply.rowRules=true;cfg.beginChain();cfg.first.reject(new Error("规则提交后模板库同步失败"));');await tick();
    assert.match(await js('cfg.top().textContent'),/规则提交后模板库同步失败/);
    assert.deepEqual(await js('cfg.commits.map(entry=>entry.name)'),['rowRules']);
    assert.equal(await js('cfg.calls.filter(entry=>entry.name==="rowMeta").length'),0);
    assert.equal(await js('cfg.readCalls'),1);
    await js('cfg.host.closeTop();');
    assert.deepEqual(await js('cfg.chainState()'),{rules:[],meta:originalRuleMeta,manageHidden:true,byField:'',signed:'',signedDisabled:false,byFieldDisabled:false});
  });
  await test('R3-01 部分成功后重读失败保留已确认清规则及原错误，行内未提交草稿不丢失',async()=>{
    await setupPartialRuleWrite('byField');
    await js('cfg.draftCurrency=cfg.overlay.querySelector(".bill-split-currency-select");cfg.draftCurrency.value="Amount";cfg.draftCurrency.dispatchEvent(new Event("change"));cfg.configReadFailure=true;cfg.beginChain();cfg.first.resolve({status:"success"});');await tick();
    await js('cfg.second.resolve({status:"failed",message:"元信息提交失败"});');await tick();
    assert.match(await js('cfg.top().textContent'),/元信息提交失败/);
    assert.match(await js('cfg.top().textContent'),/重读|重新打开/);
    await js('cfg.host.closeTop();');
    assert.deepEqual(await js('cfg.chainState()'),{rules:[],meta:originalRuleMeta,manageHidden:true,byField:'',signed:'',signedDisabled:true,byFieldDisabled:true});
    assert.equal(await js('cfg.overlay.querySelector(".bill-split-currency-select").value'),'Amount');
    assert.equal(await js('cfg.readCalls'),1);
    assert.deepEqual(await js('cfg.commits.map(entry=>entry.name)'),['rowRules']);
    assert.equal(await js('Array.from(cfg.overlay.querySelectorAll("button,input,select,textarea")).filter(node=>!node.matches(".icon-close,.bill-split-rows-done-btn")).every(node=>node.disabled)'),true);
    assert.equal(await js('!cfg.overlay.querySelector(".icon-close").disabled&&!cfg.overlay.querySelector(".bill-split-rows-done-btn").disabled'),true);
    await js('cfg.beginChain();cfg.overlay.querySelector(".bill-split-row-complete-btn").dispatchEvent(new Event("click"));');await tick();
    assert.equal(await js('cfg.calls.length'),2);
    await js('cfg.overlay.querySelector(".bill-split-rows-done-btn").click();');
    assert.equal(await js('!cfg.handle.isOpen()&&cfg.parent.isTop()'),true);
  });

  await test('R3-01 失败后的配置重读仍持父写锁，force dispose后旧回包不恢复原UI',async()=>{
    await setupPartialRuleWrite('byField');
    await js('cfg.configReadGate=cfg.defer();cfg.beginChain();cfg.first.resolve({status:"success"});');await tick();
    await js('cfg.second.resolve({status:"failed",message:"元信息提交失败"});');await tick();
    assert.equal(await js('cfg.readCalls'),1);
    assert.deepEqual(await js('({own:cfg.handle.close().status,parent:cfg.parent.close().status})'),{own:'blocked',parent:'blocked'});
    await js('cfg.beginChain();');assert.equal(await js('cfg.calls.length'),2);
    await js('cfg.handle.dispose();cfg.detachedMarkup=cfg.overlay.innerHTML;cfg.nextHandle=cfg.other();cfg.configReadGate.resolve();void 0;');await tick();
    assert.deepEqual(await js('({unchanged:cfg.detachedMarkup===cfg.overlay.innerHTML,newTop:cfg.nextHandle.isTop(),oldOpen:cfg.handle.isOpen(),errors:cfg.errors})'),{unchanged:true,newTop:true,oldOpen:false,errors:[]});
    assert.deepEqual(await js('cfg.store'),{rules:[],meta:originalRuleMeta});
  });

  // v3.2.16「字段筛选特征值」；v3.2.18 多特征值：映射行「选择特征值」+【特征值管理】
  const FEATURE = '字段筛选特征值';
  const SERIAL = { id: '1', name: '流水号', sourceField: '附言', separator: 'space', length: 10, letterPrefixCount: 2, digitsOnly: true, sample: 'FT24123456' };
  const ORDER = { id: '2', name: '订单号', sourceField: '附言', separator: 'slash', length: 6, letterPrefixCount: null, digitsOnly: true, sample: '123456' };
  const FEATURE_SETUP_JS = `cfg.tpl={id:9,name:'模板 F',headers:['交易日期','附言','']};
    cfg.row=field=>cfg.top().querySelector('tr[data-template-field="'+field+'"]');
    cfg.pick=(field,value)=>{const select=cfg.row(field).querySelector('select');select.value=value;select.dispatchEvent(new Event('change'));};
    cfg.fv=field=>cfg.row(field).querySelector('.mapping-feature-value-select');
    cfg.fvLabel=field=>cfg.row(field).querySelector('.mapping-feature-value-label');
    cfg.choose=(field,id)=>{const select=cfg.fv(field);select.value=id;select.dispatchEvent(new Event('change'));};
    cfg.fvOptions=field=>Array.from(cfg.fv(field).options).map(option=>[option.value,option.textContent]);
    cfg.btn=field=>cfg.row(field).querySelector('.mapping-feature-filter-btn');
    cfg.ff=()=>{const card=cfg.top().querySelector('.feature-filter-card');return card&&{card,pick:card.querySelector('.feature-filter-pick'),
      add:card.querySelector('[data-action="add"]'),del:card.querySelector('[data-action="delete"]'),body:card.querySelector('.feature-filter-body'),
      name:card.querySelector('.feature-filter-name'),source:card.querySelector('.feature-filter-source'),separator:card.querySelector('.feature-filter-separator'),
      length:card.querySelector('.feature-filter-length'),prefix:card.querySelector('.feature-filter-prefix'),digits:card.querySelector('.feature-filter-digits'),
      digitsLabel:card.querySelector('.feature-filter-digits-label'),sample:card.querySelector('.feature-filter-sample'),
      save:card.querySelector('[data-action="save"]'),cancel:card.querySelector('[data-action="cancel"]')};};
    cfg.pickFeature=id=>{const pick=cfg.ff().pick;pick.value=id;pick.dispatchEvent(new Event('change'));};
    cfg.type=(input,value)=>{input.value=value;input.dispatchEvent(new Event('input'));};
    cfg.featureSaves=()=>cfg.calls.filter(call=>call.name==='featureSave').map(call=>call.args[0]);void 0;`;
  const openFeatureMapping = (extra = '') => js(`${FEATURE_SETUP_JS}
    cfg.handle=cfg.bridge.openModal(()=>cfg.dialogs.createMappingDialog({template:{...cfg.tpl${extra}},targetFields:['BillDate','Remark','Reference','Currency','Balance'],mappings:cfg.featureMappings||[]})).handle;
    cfg.overlay=cfg.top();void 0;`);

  await test('字段筛选特征值：选中后出现「选择特征值」（默认空白）与【特征值管理】，未选时不保存，选定后随映射提交', async () => {
    await setup();
    await openFeatureMapping(`,featureFilters:${JSON.stringify([SERIAL, ORDER])}`);
    const options = await js(`['Remark','Currency','Balance'].map(field=>Array.from(cfg.row(field).querySelector('select').options).map(option=>option.value))`);
    assert.equal(options[0].indexOf(FEATURE), options[0].indexOf('需要拼接字段') + 1);
    assert.equal(options[1].includes(FEATURE), false);
    assert.equal(options[2].includes(FEATURE), false);
    assert.deepEqual(await js(`[cfg.btn('Remark').hidden,cfg.fv('Remark').hidden,cfg.fvLabel('Remark').hidden]`), [true, true, true]);
    await js(`cfg.pick('Remark','${FEATURE}');cfg.pick('Reference','${FEATURE}');`);
    assert.deepEqual(await js(`[cfg.btn('Remark').hidden,cfg.fv('Remark').hidden,cfg.fvLabel('Remark').hidden,cfg.btn('Reference').hidden]`), [false, false, false, false]);
    assert.deepEqual(await js(`[cfg.fvLabel('Remark').textContent,cfg.btn('Remark').textContent.trim(),cfg.fv('Remark').value]`), ['选择特征值', '特征值管理', '']);
    assert.deepEqual(await js(`cfg.fvOptions('Remark')`), [['', ''], ['1', '流水号'], ['2', '订单号']]);
    // 映射字段下拉框 → 文本 → 特征值下拉框 →【特征值管理】
    assert.deepEqual(await js(`Array.from(cfg.row('Remark').querySelectorAll('.mapping-field-editor > *, .mapping-feature-value-group > *')).filter(el=>!el.hidden).map(el=>el.className.split(' ').pop())`),
      ['mapping-select', 'mapping-feature-value-group', 'mapping-feature-value-label', 'mapping-feature-value-select', 'mapping-feature-filter-btn']);

    await js(`cfg.overlay.querySelector('[data-action="done"]').click();`); await tick();
    assert.match(await js('cfg.top().textContent'), /Remark、Reference 选择了「字段筛选特征值」，请选择特征值/);
    assert.equal(await js(`cfg.calls.filter(call=>call.name==='mappingSave').length`), 0);
    await js('cfg.host.closeTop();');

    await js(`cfg.choose('Remark','1');cfg.choose('Reference','2');`);
    assert.match(await js(`cfg.fv('Reference').title`), /筛选字段：附言；分隔符：\/；长度 6；纯数字/);
    // 切走再切回保留此前的选择
    await js(`cfg.pick('Reference','附言');`);
    assert.deepEqual(await js(`[cfg.fv('Reference').hidden,cfg.btn('Reference').hidden]`), [true, true]);
    await js(`cfg.pick('Reference','${FEATURE}');`);
    assert.equal(await js(`cfg.fv('Reference').value`), '2');

    await js(`cfg.overlay.querySelector('[data-action="done"]').click();`); await tick();
    const payload = await js(`(()=>{const args=cfg.calls.filter(call=>call.name==='mappingSave')[0].args[0];
      return {hasFeatureFilter:'featureFilter' in args||'featureFilters' in args,feature:args.mappings.filter(m=>m.mappedField==='${FEATURE}').map(m=>[m.templateField,m.mappedFields])};})()`);
    assert.deepEqual(payload, { hasFeatureFilter: false, feature: [['Remark', ['1']], ['Reference', ['2']]] });
    assert.deepEqual(await js('cfg.errors'), []);
  });

  await test('特征值管理：工具栏与设置区顺序，【新增】样例推导后保存立即落库并刷新映射行，【保存】在【取消】左侧', async () => {
    await setup();
    await js(`cfg.featureMappings=[{templateField:'Remark',mappedField:'${FEATURE}',mappedFields:['1']}];void 0;`);
    await openFeatureMapping(`,featureFilters:${JSON.stringify([SERIAL])}`);
    assert.equal(await js(`cfg.fv('Remark').value`), '1');
    await js(`cfg.btn('Remark').click();`);
    assert.deepEqual(await titleTips('.feature-filter-hint'), { title: '特征值管理', hidden: false, mark: 'Tips',
      bubble: `每个特征值是一套筛选条件：按分隔符把筛选字段拆成多段，取第一个满足条件的片段，筛不出时留空。选择「${FEATURE}」的字段在「选择特征值」中选用；保存与删除立即生效。`,
      bodyHint: false });
    assert.deepEqual(await js(`Array.from(cfg.ff().card.querySelector('.feature-filter-toolbar').children).map(el=>el.tagName==='SELECT'?'SELECT':el.textContent.trim())`),
      ['新增', '特征值', 'SELECT', '删除']);
    assert.deepEqual(await js(`[cfg.ff().pick.value,Array.from(cfg.ff().pick.options).map(o=>o.textContent),cfg.ff().body.hidden]`), ['', ['', '流水号'], true]);
    assert.deepEqual(await js(`Array.from(cfg.ff().card.querySelectorAll('.dialog-actions button')).map(b=>b.textContent.trim())`), ['保存', '取消']);

    await js('cfg.ff().add.click();');
    assert.deepEqual(await js(`[cfg.ff().body.hidden,cfg.ff().pick.value,cfg.ff().name.value,cfg.ff().separator.value]`), [false, '', '', 'space']);
    assert.deepEqual(await js(`Array.from(cfg.ff().card.querySelectorAll('.feature-filter-grid .feature-filter-label')).map(el=>el.textContent.trim())`),
      ['特征值名', '筛选字段', '输入特征值', '分隔符', '特征长度', '前几位是英文字母', '纯数字']);
    assert.deepEqual(await js(`Array.from(cfg.ff().source.options).map(option=>option.value)`), ['', '交易日期', '附言']);
    await js(`cfg.ff().name.value='订单号';cfg.ff().source.value='附言';cfg.type(cfg.ff().sample,'INV001');`);
    assert.deepEqual(await js(`[cfg.ff().length.value,cfg.ff().prefix.value,cfg.ff().digits.checked,cfg.ff().digitsLabel.textContent]`),
      ['6', '3', true, '前 3 位之后全是数字']);
    await js('cfg.ff().save.click();'); await tick();
    assert.deepEqual(await js('cfg.featureSaves()'), [{ templateId: 9, featureFilters: [SERIAL,
      { name: '订单号', sourceField: '附言', separator: 'space', length: 6, letterPrefixCount: 3, digitsOnly: true, sample: 'INV001' }] }]);
    assert.equal(await js('cfg.top()===cfg.overlay'), true);
    assert.deepEqual(await js(`cfg.fvOptions('Remark')`), [['', ''], ['1', '流水号'], ['2', '订单号']]);
    assert.equal(await js(`cfg.fv('Remark').value`), '1');
    assert.deepEqual(await js('cfg.errors'), []);
  });

  await test('特征值管理：选中已有特征值回显并可改名保存；校验不关闭弹窗；保存失败保留；取消不写库', async () => {
    await setup();
    await js(`cfg.featureMappings=[{templateField:'Remark',mappedField:'${FEATURE}',mappedFields:['2']}];void 0;`);
    await openFeatureMapping(`,featureFilters:${JSON.stringify([SERIAL, ORDER])}`);
    await js(`cfg.btn('Remark').click();cfg.pickFeature('2');`);
    assert.deepEqual(await js(`[cfg.ff().body.hidden,cfg.ff().name.value,cfg.ff().source.value,cfg.ff().separator.value,cfg.ff().length.value,cfg.ff().prefix.value,cfg.ff().digits.checked,cfg.ff().sample.value,cfg.ff().digitsLabel.textContent]`),
      [false, '订单号', '附言', 'slash', '6', '', true, '123456', '整段都是数字']);
    await js(`cfg.pickFeature('');`);
    assert.equal(await js('cfg.ff().body.hidden'), true);
    await js(`cfg.pickFeature('2');`);

    const expectAlert = async (script, pattern) => {
      await js(`${script};cfg.ff().save.click();`); await tick();
      assert.match(await js('cfg.top().textContent'), pattern);
      await js('cfg.host.closeTop();');
    };
    await expectAlert(`cfg.ff().name.value='流水号'`, /特征值名「流水号」已存在/);
    await expectAlert(`cfg.ff().name.value=' '`, /请输入特征值名/);
    await expectAlert(`cfg.ff().name.value='订单编号';cfg.ff().sample.value='12/3456'`, /输入特征值「12\/3456」不能包含所选分隔符/);
    await expectAlert(`cfg.ff().sample.value='AB1234'`, /输入特征值「AB1234」不符合当前筛选条件/);
    await expectAlert(`cfg.ff().sample.value='';cfg.ff().length.value='';cfg.ff().digits.checked=false`, /特征长度、前几位英文、纯数字至少设置一项/);
    await expectAlert(`cfg.ff().source.value='';cfg.ff().length.value='3'`, /请选择筛选字段/);
    assert.equal(await js('cfg.featureSaves().length'), 0);

    await js(`cfg.ff().source.value='附言';cfg.ff().length.value='6';cfg.ff().digits.checked=true;cfg.next.featureSave={status:'error',message:'特征值保存失败（测试）'};cfg.ff().save.click();`); await tick();
    assert.match(await js('cfg.top().textContent'), /特征值保存失败（测试）/);
    await js('cfg.host.closeTop();');
    assert.equal(await js('Boolean(cfg.ff())'), true);

    await js('cfg.ff().save.click();'); await tick();
    assert.deepEqual(await js('cfg.featureSaves()[1].featureFilters.map(item=>[item.id,item.name])'), [['1', '流水号'], ['2', '订单编号']]);
    assert.equal(await js('cfg.top()===cfg.overlay'), true);
    assert.deepEqual(await js(`[cfg.fv('Remark').value,cfg.fv('Remark').selectedOptions[0].textContent]`), ['2', '订单编号']);

    await js(`cfg.btn('Remark').click();cfg.ff().add.click();cfg.ff().name.value='不保存';cfg.ff().cancel.click();`); await tick();
    assert.equal(await js('cfg.top()===cfg.overlay'), true);
    assert.equal(await js('cfg.featureSaves().length'), 2);
    await js(`cfg.btn('Remark').click();cfg.ff().save.click();`); await tick();
    assert.equal(await js('cfg.top()===cfg.overlay'), true, '设置区隐藏时【保存】直接关闭');
    assert.equal(await js('cfg.featureSaves().length'), 2);
    assert.deepEqual(await js('cfg.errors'), []);
  });

  await test('特征值管理：筛选字段已不在模板字段中时显示「（已删除）」并标红，重新选择后才能保存', async () => {
    await setup();
    await openFeatureMapping(`,featureFilters:${JSON.stringify([{ ...SERIAL, sourceField: '摘要' }, ORDER])}`);
    await js(`cfg.pick('Remark','${FEATURE}');cfg.btn('Remark').click();cfg.pickFeature('1');`);
    assert.deepEqual(await js(`(()=>{const s=cfg.ff().source;return [s.value,s.selectedOptions[0].textContent,s.classList.contains('is-stale')];})()`),
      ['摘要', '摘要（已删除）', true]);
    await js(`cfg.ff().save.click();`); await tick();
    assert.match(await js('cfg.top().textContent'), /筛选字段不存在：摘要/);
    assert.equal(await js('cfg.featureSaves().length'), 0);
    await js('cfg.host.closeTop();');
    // 切到另一个特征值不残留「（已删除）」选项与标红；回到原特征值时重新标出
    await js(`cfg.pickFeature('2');`);
    assert.deepEqual(await js(`[cfg.ff().source.value,[...cfg.ff().source.options].some(o=>o.dataset.stale==='true'),cfg.ff().source.classList.contains('is-stale')]`),
      ['附言', false, false]);
    await js(`cfg.pickFeature('1');const s=cfg.ff().source;s.value='附言';s.dispatchEvent(new Event('change'));`);
    assert.equal(await js(`cfg.ff().source.classList.contains('is-stale')`), false);
    await js(`cfg.ff().save.click();`); await tick();
    assert.deepEqual(await js(`cfg.featureSaves().map(payload=>payload.featureFilters.map(item=>[item.id,item.sourceField]))`),
      [[['1', '附言'], ['2', '附言']]]);
    assert.deepEqual(await js('cfg.errors'), []);
  });

  await test('特征值管理：删除须先选目标；被映射草稿或拆分映射使用时拒绝；未使用时确认后立即落库', async () => {
    await setup();
    await js(`cfg.featureMappings=[{templateField:'Remark',mappedField:'${FEATURE}',mappedFields:['1']}];void 0;`);
    await openFeatureMapping(`,featureFilters:${JSON.stringify([SERIAL, ORDER, { ...ORDER, id: '3', name: '备用' }])}`);
    await js(`cfg.btn('Remark').click();cfg.ff().del.click();`); await tick();
    assert.match(await js('cfg.top().textContent'), /请选择要删除的特征值/);
    await js('cfg.host.closeTop();');

    await js(`cfg.pickFeature('1');cfg.ff().del.click();`); await tick();
    assert.match(await js('cfg.top().textContent'), /特征值「流水号」正被 Remark 使用，请先改选其他特征值后再删除/);
    await js('cfg.host.closeTop();');

    // 映射草稿（未保存）新选用的特征值同样拒绝删除
    await js(`cfg.ff().cancel.click();`); await tick();
    await js(`cfg.pick('Reference','${FEATURE}');cfg.choose('Reference','2');cfg.btn('Reference').click();cfg.pickFeature('2');cfg.ff().del.click();`); await tick();
    assert.match(await js('cfg.top().textContent'), /特征值「订单号」正被 Reference 使用/);
    await js('cfg.host.closeTop();');
    assert.equal(await js('cfg.featureSaves().length'), 0);

    await js(`cfg.pickFeature('3');cfg.ff().del.click();`); await tick();
    assert.match(await js('cfg.top().textContent'), /确定删除特征值「备用」？/);
    await js(`cfg.top().querySelector('[data-action="cancel"]').click();`); await tick();
    assert.equal(await js('cfg.featureSaves().length'), 0);
    await js(`cfg.ff().del.click();`); await tick();
    await js(`cfg.next.featureSave={status:'error',message:'特征值「备用」正被 Name 使用，请先改选其他特征值后再删除'};cfg.top().querySelector('[data-action="confirm"]').click();`); await tick();
    assert.match(await js('cfg.top().textContent'), /正被 Name 使用/);
    await js('cfg.host.closeTop();');
    assert.match(await js('cfg.top().textContent'), /确定删除特征值「备用」？/, '失败时确认框保留');
    await js(`cfg.top().querySelector('[data-action="confirm"]').click();`); await tick();
    assert.deepEqual(await js('cfg.featureSaves().map(payload=>payload.featureFilters.map(item=>item.id))'), [['1', '2'], ['1', '2']]);
    assert.deepEqual(await js(`[Boolean(cfg.ff()),cfg.ff().pick.value,cfg.ff().body.hidden,Array.from(cfg.ff().pick.options).map(o=>o.value)]`),
      [true, '', true, ['', '1', '2']]);
    await js('cfg.ff().cancel.click();'); await tick();
    assert.deepEqual(await js(`cfg.fvOptions('Remark').map(option=>option[0])`), ['', '1', '2']);
    assert.deepEqual(await js('cfg.errors'), []);
  });

  await test('字段筛选特征值：拆分/合并且不复用时主映射残留该值不阻止保存，复用时仍要求选特征值', async () => {
    await setup();
    const open = (reuse) => js(`${FEATURE_SETUP_JS}
      cfg.handle=cfg.bridge.openModal(()=>cfg.dialogs.createMappingDialog({template:cfg.tpl,targetFields:['BillDate','Remark','是否拆分/合并明细账单','复用模块字段的映射关系'],
        mappings:[{templateField:'Remark',mappedField:'${FEATURE}',mappedFields:[]},{templateField:'是否拆分/合并明细账单',mappedField:'是',mappedFields:[]},{templateField:'复用模块字段的映射关系',mappedField:'${reuse}',mappedFields:[]}]})).handle;
      cfg.overlay=cfg.top();cfg.overlay.querySelector('[data-action="done"]').click();void 0;`);
    await open('否'); await tick();
    assert.equal(await js(`cfg.calls.filter(call=>call.name==='mappingSave').length`), 1);
    await js('cfg.host.closeAll?.();');
    await open('是'); await tick();
    assert.match(await js('cfg.top().textContent'), /Remark 选择了「字段筛选特征值」，请选择特征值/);
    assert.equal(await js(`cfg.calls.filter(call=>call.name==='mappingSave').length`), 1);
  });

  await test('字段筛选特征值：拆分/合并映射弹窗共用特征值列表，在其中新增后回写主映射，选择随拆分映射提交', async () => {
    await setup();
    await js(`${FEATURE_SETUP_JS}cfg.splitDone=[];cfg.listChanges=[];
      cfg.handle=cfg.bridge.openModal(()=>cfg.dialogs.createBillSplitMappingsDialog({template:cfg.tpl,headers:cfg.tpl.headers,targetFields:['BillDate','MerchantId','Reference','Remark','Balance','Currency'],
        initialMappings:[{templateField:'Remark',mappedField:'${FEATURE}',mappedFields:['1']}],featureFilters:${JSON.stringify([SERIAL])},
        getMainFeatureFilterUsage:()=>new Map([['1',['Remark']]]),onFeatureFiltersChange:list=>cfg.listChanges.push(list.map(item=>item.name)),
        onDone:mappings=>cfg.splitDone.push(mappings)})).handle;
      cfg.overlay=cfg.top();void 0;`);
    assert.equal(await js(`Array.from(cfg.row('Balance').querySelectorAll('option')).some(option=>option.value==='${FEATURE}')`), false);
    assert.deepEqual(await js(`[cfg.fv('Remark').hidden,cfg.fv('Remark').value,cfg.btn('Remark').textContent.trim()]`), [false, '1', '特征值管理']);
    await js(`cfg.pick('Reference','${FEATURE}');cfg.overlay.querySelector('[data-action="done"]').click();`); await tick();
    assert.match(await js('cfg.top().textContent'), /Reference 选择了「字段筛选特征值」，请选择特征值/);
    assert.equal(await js(`cfg.calls.filter(call=>call.name==='splitMapping').length`), 0);
    await js('cfg.host.closeTop();');

    await js(`cfg.btn('Reference').click();cfg.pickFeature('1');cfg.ff().del.click();`); await tick();
    assert.match(await js('cfg.top().textContent'), /特征值「流水号」正被 Remark、Remark（拆分\/合并映射） 使用/);
    await js('cfg.host.closeTop();');
    await js(`cfg.ff().add.click();cfg.ff().name.value='发票号';cfg.ff().source.value='附言';cfg.ff().separator.value='comma';cfg.type(cfg.ff().sample,'INV001');cfg.ff().save.click();`); await tick();
    assert.deepEqual(await js('cfg.listChanges'), [['流水号', '发票号']]);
    assert.deepEqual(await js(`cfg.fvOptions('Reference').map(option=>option[1])`), ['', '流水号', '发票号']);
    // 切到拼接再切回：特征值选择保留，拼接字段不混入特征值 id
    await js(`cfg.choose('Reference','2');cfg.pick('Reference','需要拼接字段');cfg.pick('Reference','${FEATURE}');`);
    assert.equal(await js(`cfg.fv('Reference').value`), '2');
    await js(`cfg.overlay.querySelector('[data-action="done"]').click();`); await tick();
    const saved = await js(`(()=>{const args=cfg.calls.filter(call=>call.name==='splitMapping')[0].args[0];
      return {keys:Object.keys(args).sort(),feature:args.mappings.filter(m=>m.mappedField==='${FEATURE}').map(m=>[m.templateField,m.mappedFields,'featureFilterRef' in m])};})()`);
    assert.deepEqual(saved, { keys: ['mappings', 'templateId'], feature: [['Reference', ['2'], false], ['Remark', ['1'], false]] });
    assert.equal(await js('cfg.splitDone.length'), 1);
    assert.deepEqual(await js('cfg.errors'), []);
  });

  await test('字段筛选特征值：拆分/合并映射行切走后其特征值被删，再新增沿用同一 id，切回时仍为空白且不得保存', async () => {
    await setup();
    await js(`${FEATURE_SETUP_JS}
      cfg.handle=cfg.bridge.openModal(()=>cfg.dialogs.createBillSplitMappingsDialog({template:cfg.tpl,headers:cfg.tpl.headers,targetFields:['BillDate','Reference','Remark'],
        initialMappings:[{templateField:'Remark',mappedField:'${FEATURE}',mappedFields:['1']}],featureFilters:${JSON.stringify([SERIAL, ORDER])},
        getMainFeatureFilterUsage:()=>new Map(),onFeatureFiltersChange:()=>{},onDone:()=>{}})).handle;
      cfg.overlay=cfg.top();void 0;`);
    await js(`cfg.pick('Reference','${FEATURE}');cfg.choose('Reference','2');cfg.pick('Reference','附言');`);
    // Reference 已切走，「订单号」未被使用，可删除
    await js(`cfg.btn('Remark').click();cfg.pickFeature('2');cfg.ff().del.click();`); await tick();
    await js(`cfg.top().querySelector('[data-action="confirm"]').click();`); await tick();
    assert.deepEqual(await js('cfg.featureSaves().map(payload=>payload.featureFilters.map(item=>item.id))'), [['1']]);
    await js(`cfg.ff().add.click();cfg.ff().name.value='发票号';cfg.ff().source.value='附言';cfg.ff().separator.value='comma';cfg.type(cfg.ff().sample,'INV001');cfg.ff().save.click();`); await tick();
    assert.deepEqual(await js(`cfg.fvOptions('Reference')`), [['', ''], ['1', '流水号'], ['2', '发票号']], '新增的特征值沿用 id 2');
    await js(`cfg.pick('Reference','${FEATURE}');`);
    assert.equal(await js(`cfg.fv('Reference').value`), '');
    await js(`cfg.overlay.querySelector('[data-action="done"]').click();`); await tick();
    assert.match(await js('cfg.top().textContent'), /Reference 选择了「字段筛选特征值」，请选择特征值/);
    assert.equal(await js(`cfg.calls.filter(call=>call.name==='splitMapping').length`), 0);
    assert.deepEqual(await js('cfg.errors'), []);
  });

  await test('特征值管理：映射行与弹窗在最小窗口内完整可见、可点保存', async () => {
    await setup({ zoom: 1 });
    await openFeatureMapping(`,featureFilters:${JSON.stringify([SERIAL])}`);
    await js(`cfg.pick('Remark','${FEATURE}');cfg.choose('Remark','1');`);
    await layout.settle();
    const rowGeometry = await js(`(() => {
      const editor=cfg.row('Remark').querySelector('.mapping-field-editor').getBoundingClientRect();
      const [select,label,value,button]=[cfg.row('Remark').querySelector('select'),cfg.fvLabel('Remark'),cfg.fv('Remark'),cfg.btn('Remark')].map(el=>el.getBoundingClientRect());
      const mid=r=>(r.top+r.bottom)/2;
      return { order: select.right<=label.left&&label.right<=value.left&&value.right<=button.left,
        sameLine: [label,value,button].every(r=>Math.abs(mid(r)-mid(select))<4), inside: button.right<=editor.right+1 };
    })()`);
    assert.deepEqual(rowGeometry, { order: true, sameLine: true, inside: true });
    await js('new Promise((resolve) => setTimeout(resolve, 250))');
    await layout.evidence('feature-filter-mapping-row', { geometry: rowGeometry });
    await js(`cfg.btn('Remark').click();cfg.ff().add.click();`);
    await layout.settle();
    const geometry = await js(`(() => {
      const card=cfg.top().querySelector('.feature-filter-card'), rect=card.getBoundingClientRect();
      const inside=element=>{const r=element.getBoundingClientRect();return r.left>=rect.left&&r.right<=rect.right&&r.top>=rect.top&&r.bottom<=rect.bottom;};
      const toolbar=[...card.querySelectorAll('.feature-filter-toolbar > *')].map(el=>el.getBoundingClientRect());
      const title=card.querySelector('.dialog-title').getBoundingClientRect();
      return { fits: rect.top>=0&&rect.bottom<=innerHeight&&rect.left>=0&&rect.right<=innerWidth,
        toolbarRightOfTitle: toolbar.every(r=>r.left>=title.right), toolbarOneLine: toolbar.every(r=>Math.abs((r.top+r.bottom)/2-(toolbar[0].top+toolbar[0].bottom)/2)<4),
        controls: [...card.querySelectorAll('.feature-filter-toolbar button, .feature-filter-toolbar select, .feature-filter-grid select, .feature-filter-grid input, .dialog-actions button')].map(inside) };
    })()`);
    assert.deepEqual(geometry, { fits: true, toolbarRightOfTitle: true, toolbarOneLine: true, controls: Array(12).fill(true) });
    await js('new Promise((resolve) => setTimeout(resolve, 250))');
    await layout.evidence('feature-filter-dialog', { geometry });
    await layout.click('.feature-filter-card [data-action="save"]');
    assert.match(await js('cfg.top().textContent'), /请输入特征值名/);
  });

  // v3.2.16：MerchantId「原始账单仅有币种无账户号」+【映射管理】（spec §4.1、§4.2、D2）
  const CURRENCY_ONLY = '原始账单仅有币种无账户号';
  async function openCurrencyOnlyMapping(layoutOptions = null) {
    await setup(layoutOptions);
    await js(`
      cfg.currencyTemplate={id:9,name:'招商银行-上海',headers:['日期','币种','收入']};
      cfg.handle=cfg.bridge.openModal(()=>cfg.dialogs.createMappingDialog({template:cfg.currencyTemplate,targetFields:['MerchantId','Currency'],
        mappings:[{templateField:'MerchantId',mappedField:${JSON.stringify(CURRENCY_ONLY)},mappedFields:[]},{templateField:'Currency',mappedField:'币种',mappedFields:[]}],
        currencyBigAccounts:[{currency:'USD',merchantId:'NET1'}]})).handle;
      cfg.mappingOverlay=cfg.top();
      cfg.row=field=>[...cfg.mappingOverlay.querySelectorAll('tr')].find(row=>row.firstElementChild&&row.firstElementChild.textContent.trim()===field);
      cfg.merchantSelect=cfg.row('MerchantId').querySelector('.mapping-select');
      cfg.manageBtn=cfg.row('MerchantId').querySelector('.mapping-currency-big-account-manage-btn');
      cfg.pairRows=()=>[...cfg.top().querySelectorAll('tr[data-currency-big-account-row]')];
      cfg.pairs=()=>cfg.pairRows().map(row=>[row.querySelector('.currency-big-account-currency-input').value,row.querySelector('.currency-big-account-merchant-input').value]);
      cfg.fill=(index,currency,merchantId)=>{const row=cfg.pairRows()[index];const c=row.querySelector('.currency-big-account-currency-input');c.value=currency;c.dispatchEvent(new Event('input'));row.querySelector('.currency-big-account-merchant-input').value=merchantId;};
      void 0;`);
  }

  await test('MerchantId 新选项：显示【映射管理】且 Currency 行可见；改选「自己输入」隐藏按钮与 Currency 行', async () => {
    await openCurrencyOnlyMapping();
    assert.equal(await js('[...cfg.merchantSelect.options].map(option=>option.value).includes("原始账单仅有币种无账户号")'), true);
    assert.deepEqual(await js('({value:cfg.merchantSelect.value,button:cfg.manageBtn.hidden,text:cfg.manageBtn.textContent.trim(),currencyHidden:cfg.row("Currency").hidden,selfInputHidden:cfg.row("MerchantId").querySelector(".mapping-big-account-manage-btn").hidden})'),
      { value: CURRENCY_ONLY, button: false, text: '映射管理', currencyHidden: false, selfInputHidden: true });
    await js('cfg.merchantSelect.value="自己输入";cfg.merchantSelect.dispatchEvent(new Event("change"));');
    assert.deepEqual(await js('({button:cfg.manageBtn.hidden,currencyHidden:cfg.row("Currency").hidden})'), { button: true, currencyHidden: true });
  });

  await test('【映射管理】打开「币种映射账号管理」：新增在当前行下方插入、删除最后一行改为清空；保存带回草稿，映射关系管理【保存】时提交大写配置', async () => {
    await openCurrencyOnlyMapping();
    await js('cfg.manageBtn.click();');
    assert.equal(await js('cfg.top().querySelector(".dialog-title").textContent.trim()'), '币种映射账号管理');
    assert.deepEqual(await js('cfg.pairs()'), [['USD', 'NET1']]);
    await js('cfg.pairRows()[0].querySelector("[data-action=insert-below]").click();cfg.fill(1,"hkd","NET1");cfg.pairRows()[0].querySelector("[data-action=insert-below]").click();');
    assert.deepEqual(await js('cfg.pairs()'), [['USD', 'NET1'], ['', ''], ['hkd', 'NET1']]);
    await js('cfg.pairRows()[1].querySelector("[data-action=delete]").click();');
    assert.deepEqual(await js('cfg.pairs()'), [['USD', 'NET1'], ['hkd', 'NET1']]);
    await js('cfg.top().querySelector("[data-action=save]").click();');
    assert.equal(await js('cfg.handle.isTop()&&cfg.top()===cfg.mappingOverlay'), true);
    assert.equal(await js('cfg.feedback.some(entry=>/点击【保存】后保存到模板/.test(entry[0]))'), true);
    await js('cfg.mappingOverlay.querySelector("[data-action=done]").click();'); await tick();
    assert.deepEqual(await js('cfg.calls.find(call=>call.name==="mappingSave").args[0].currencyBigAccounts'),
      [{ currency: 'USD', merchantId: 'NET1' }, { currency: 'HKD', merchantId: 'NET1' }]);
    assert.equal(await js('cfg.calls.find(call=>call.name==="mappingSave").args[0].mappings.find(m=>m.templateField==="MerchantId").mappedField'), CURRENCY_ONLY);

    await openCurrencyOnlyMapping();
    await js('cfg.manageBtn.click();cfg.pairRows()[0].querySelector("[data-action=delete]").click();');
    assert.deepEqual(await js('cfg.pairs()'), [['', '']]);
  });

  await test('【映射管理】校验一次列出全部问题；【返回】与 × 放弃本次编辑', async () => {
    await openCurrencyOnlyMapping();
    await js('cfg.manageBtn.click();cfg.dialog=cfg.host.getTop();cfg.pairOverlay=cfg.top();cfg.fill(0,"","");cfg.pairOverlay.querySelector("[data-action=save]").click();');
    assert.match(await js('cfg.top().textContent'), /请至少维护 1 组币种与大账号/);
    await js('cfg.host.closeTop();');
    await js('cfg.fill(0,"usd","");cfg.pairRows()[0].querySelector("[data-action=insert-below]").click();cfg.fill(1,"XYZ","N2");cfg.pairRows()[1].querySelector("[data-action=insert-below]").click();cfg.fill(2,"USD","N3");cfg.pairOverlay.querySelector("[data-action=save]").click();');
    const alertText = await js('cfg.top().textContent');
    assert.match(alertText, /第 1 行：请填写大账号/);
    assert.match(alertText, /第 2 行：币种「XYZ」不在币种映射表中/);
    assert.match(alertText, /币种「USD」重复（第 1、3 行），一个币种只能对应一个大账号/);
    await js('cfg.host.closeTop();');
    assert.equal(await js('cfg.top()===cfg.pairOverlay'), true);
    await js('cfg.pairOverlay.querySelector("[data-action=back]").click();');
    assert.equal(await js('cfg.top()===cfg.mappingOverlay'), true);
    await js('cfg.manageBtn.click();');
    assert.deepEqual(await js('cfg.pairs()'), [['USD', 'NET1']]);
    await js('cfg.fill(0,"EUR","X");cfg.top().querySelector(".icon-close").click();cfg.manageBtn.click();');
    assert.deepEqual(await js('cfg.pairs()'), [['USD', 'NET1']]);
  });

  await test('【映射管理】布局：【新增】在每行最左侧，右下角【保存】在【返回】左侧，币种与大账号各占一半', async () => {
    await openCurrencyOnlyMapping({ zoom: 1 });
    await layout.settle();
    await layout.evidence('currency-big-account-mapping-row', { button: await js('!cfg.manageBtn.hidden') });
    await js('cfg.manageBtn.click();cfg.pairRows()[0].querySelector("[data-action=insert-below]").click();cfg.fill(1,"EUR","NET2");');
    await layout.settle();
    const geometry = await js(`(() => {
      const card=cfg.top().querySelector('.currency-big-account-card'),rect=card.getBoundingClientRect();
      const save=card.querySelector('[data-action=save]').getBoundingClientRect(),back=card.querySelector('[data-action=back]').getBoundingClientRect();
      const row=cfg.pairRows()[0],cells=[...row.children].map(cell=>cell.getBoundingClientRect());
      return { saveLeftOfBack: save.right<=back.left, footerRight: rect.right-back.right<48, footerBottom: save.top>row.getBoundingClientRect().bottom,
        insertFirst: row.children[0].querySelector('[data-action=insert-below]')!==null, deleteLast: row.lastElementChild.querySelector('[data-action=delete]')!==null,
        halves: Math.abs(cells[1].width-cells[2].width)<=1, fits: rect.right<=innerWidth&&rect.bottom<=innerHeight };
    })()`);
    assert.deepEqual(geometry, { saveLeftOfBack: true, footerRight: true, footerBottom: true, insertFirst: true, deleteLast: true, halves: true, fits: true });
    await layout.evidence('currency-big-account-dialog', { geometry });
  });

  // v3.2.18 模板管理【更新】：首槽等宽，渠道行 / 子模板行 / 普通模板行【重命名】左缘对齐；普通模板与子模板有【更新】。
  await test('模板管理执行操作：【更新】在【修改】右侧，各类行【重命名】左缘对齐（100%/125%/150%）', async () => {
    await setup({ zoom: 1 });
    await js(`cfg.templates.push({id:3,name:'渠道 A',channelId:7,channelName:'渠道 A',bigAccountSummary:'来自账单'});
      cfg.services.applyPreviewTemplates(cfg.templates);cfg.manager=cfg.bridge.openModal(()=>cfg.dialogs.createTemplateManagerDialog({expandChannelId:7})).handle;void 0;`);
    assert.deepEqual(await js(`Array.from(cfg.top().querySelectorAll('tbody tr')).map(row=>[row.className,Array.from(row.querySelectorAll('.manager-row-actions button')).map(button=>button.textContent)])`), [
      ['template-channel-row', ['导入子模板', '重命名', '删除']],
      ['template-child-row', ['修改', '更新', '重命名', '删除']],
      ['', ['修改', '更新', '重命名', '删除']],
      ['', ['修改', '更新', '重命名', '删除']]
    ]);
    const measure = () => js(`(() => {
      const rows=[...cfg.top().querySelectorAll('tbody tr')].filter(row=>row.style.display!=='none');
      const wrapper=cfg.top().querySelector('.table-wrapper');
      return { renameLefts: rows.map(row=>row.querySelector('[data-action="rename"]').getBoundingClientRect().left),
        oneLine: rows.map(row=>{const tops=[...row.querySelectorAll('.manager-row-actions button')].map(button=>Math.round(button.getBoundingClientRect().top));return Math.max(...tops)-Math.min(...tops)<=1;}),
        overflow: wrapper.scrollWidth>wrapper.clientWidth+1 };
    })()`);
    for (const zoom of [1, 1.25, 1.5]) {
      await layout.resize(1080, 760, zoom);
      const metrics = await measure();
      const lefts = metrics.renameLefts;
      assert.ok(Math.max(...lefts) - Math.min(...lefts) <= 0.5, JSON.stringify({ zoom, metrics }));
      assert.equal(metrics.overflow, false, JSON.stringify({ zoom, metrics }));
      if (zoom < 1.5) assert.ok(metrics.oneLine.every(Boolean), JSON.stringify({ zoom, metrics }));
      await layout.evidence(`template-manager-actions-${Math.round(zoom * 100)}`, metrics);
    }
  });
  await test('模板【更新】：取消选择不弹窗；字段变更分组汇总，返回不写入；字段无变化时禁用更新模板', async () => {
    await setup();
    await js(`cfg.manager=cfg.bridge.openModal(()=>cfg.dialogs.createTemplateManagerDialog()).handle;cfg.managerOverlay=cfg.top();
      cfg.managerOverlay.querySelector('[data-action="update-headers"]').click();void 0;`); await tick();
    assert.deepEqual(await js(`cfg.calls.filter(call=>call.name==='headerPreview').map(call=>call.args)`), [[1]]);
    assert.equal(await js('cfg.manager.isTop()&&cfg.top()===cfg.managerOverlay'), true);
    await js(`cfg.next.headerPreview={status:'success',templateId:1,templateName:'模板 A',channelId:null,sourceFileName:'模板 A-新版.xlsx',
      expectedHeaders:['日期','金额'],headers:['日期','金额(元)','附言'],diff:{identical:false,added:['金额(元)','附言'],removed:['金额'],orderChanged:false},
      affectedMappings:['Credit Amount ← 金额'],activeStaleCount:1};
      cfg.managerOverlay.querySelector('[data-action="update-headers"]').click();void 0;`); await tick();
    const view = await js(`(() => {const card=cfg.top().querySelector('.template-header-update-card');return {
      title: card.querySelector('.dialog-title').textContent,
      source: card.querySelector('.template-header-update-source').textContent,
      added: [...card.querySelectorAll('[data-role="added"] .is-added')].map(item=>item.textContent),
      removed: [...card.querySelectorAll('[data-role="removed"] .is-removed')].map(item=>item.textContent),
      order: card.querySelector('[data-role="order"] span:last-child').textContent,
      affected: [...card.querySelectorAll('[data-role="affected"] li')].map(item=>item.textContent),
      buttons: [...card.querySelectorAll('.dialog-actions button')].map(button=>[button.textContent,button.disabled])};})()`);
    assert.deepEqual(view, {
      title: '字段变更', source: '模板「模板 A」← 文件「模板 A-新版.xlsx」',
      added: ['+ 金额(元)', '+ 附言'], removed: ['− 金额'], order: '无变化', affected: ['Credit Amount ← 金额'],
      buttons: [['更新模板', false], ['返回', false]]
    });
    await js(`cfg.top().querySelector('[data-action="back"]').click();`);
    assert.equal(await js('cfg.manager.isTop()&&cfg.top()===cfg.managerOverlay'), true);
    assert.equal(await js(`cfg.calls.filter(call=>call.name==='headerUpdate').length`), 0);
    await js(`cfg.next.headerPreview={status:'success',templateId:1,templateName:'模板 A',sourceFileName:'same.xlsx',expectedHeaders:['日期'],headers:['日期'],
      diff:{identical:true,added:[],removed:[],orderChanged:false},affectedMappings:[],activeStaleCount:0};
      cfg.managerOverlay.querySelector('[data-action="update-headers"]').click();void 0;`); await tick();
    assert.match(await js(`cfg.top().textContent`), /字段无变化/);
    assert.equal(await js(`cfg.top().querySelector('[data-action="submit"]').disabled`), true);
    await js(`cfg.top().querySelector('[data-action="close"]').click();`);
    assert.equal(await js('cfg.manager.isTop()'), true);
  });
  await test('模板【更新】预览失败：结果弹窗只有【返回】，返回到刷新后的模板管理', async () => {
    await setup();
    await js(`cfg.manager=cfg.bridge.openModal(()=>cfg.dialogs.createTemplateManagerDialog()).handle;
      cfg.next.headerPreview={status:'error',message:'该文件的表头与已有模板「模板 B」完全相同，无法更新为重复表头的模板。',errorReportReady:true};
      cfg.top().querySelector('[data-action="update-headers"]').click();void 0;`); await tick();
    assert.match(await js('cfg.top().textContent'), /模板 B/);
    assert.deepEqual(await js(`[...cfg.top().querySelectorAll('.dialog-actions button')].map(button=>button.textContent)`), ['返回']);
    assert.equal(await js(`cfg.feedback.at(-1)[1]`), 'error');
    await js(`cfg.top().querySelector('[data-action="back"]').click();`);
    assert.match(await js('cfg.top().textContent'), /模板管理/);
    assert.equal(await js('document.getElementById("modalRoot").children.length'), 1);
  });
  await test('模板【更新模板】：提交表头快照，忙碌时不能关闭或重复提交；成功页【修改映射关系】在【返回】左侧并打开映射弹窗', async () => {
    await setup();
    await js(`cfg.manager=cfg.bridge.openModal(()=>cfg.dialogs.createTemplateManagerDialog()).handle;
      cfg.next.headerPreview={status:'success',templateId:2,templateName:'模板 B',sourceFileName:'b2.xlsx',expectedHeaders:['日期','金额'],headers:['日期','金额(元)'],
        diff:{identical:false,added:['金额(元)'],removed:['金额'],orderChanged:false},affectedMappings:['Credit Amount ← 金额'],activeStaleCount:1};
      cfg.top().querySelectorAll('[data-action="update-headers"]')[1].click();void 0;`); await tick();
    await js(`cfg.write=cfg.defer();cfg.next.headerUpdate=cfg.write;cfg.submit=cfg.top().querySelector('[data-action="submit"]');cfg.handle=cfg.host.getTop();
      cfg.submit.click();cfg.submit.dispatchEvent(new Event('click'));void 0;`);
    assert.deepEqual(await js(`cfg.calls.filter(call=>call.name==='headerUpdate').map(call=>call.args[0])`), [
      { templateId: 2, expectedHeaders: ['日期', '金额'], headers: ['日期', '金额(元)'], sourceFileName: 'b2.xlsx' }
    ]);
    assert.equal(await js('cfg.handle.close().status'), 'blocked');
    await js(`cfg.write.resolve({status:'success',message:'模板「模板 B」已更新，有 1 处映射引用的字段已删除，修改映射关系前无法用该模板生成账单',
      staleMappings:['Credit Amount ← 金额'],activeStaleCount:1});`); await tick();
    assert.equal(await js(`cfg.calls.filter(call=>call.name==='refresh').length`), 1);
    const result = await js(`(() => {const card=cfg.top().querySelector('.template-header-update-result-card');return {
      message: card.querySelector('[data-role="message"]').textContent,
      stale: [...card.querySelectorAll('li')].map(item=>item.textContent),
      buttons: [...card.querySelectorAll('.dialog-actions button')].map(button=>button.textContent)};})()`);
    assert.deepEqual(result, {
      message: '模板「模板 B」已更新，有 1 处映射引用的字段已删除，修改映射关系前无法用该模板生成账单',
      stale: ['Credit Amount ← 金额'], buttons: ['修改映射关系', '返回']
    });
    assert.equal(await js('cfg.manager.isOpen()'), true);
    await js(`cfg.top().querySelector('[data-action="edit-mappings"]').click();`); await tick();
    assert.deepEqual(await js(`cfg.calls.filter(call=>call.name==='templateRead').map(call=>call.args)`), [[2]]);
    assert.match(await js('cfg.top().textContent'), /映射关系管理/);
    assert.equal(await js('document.getElementById("modalRoot").children.length'), 1);
  });
  await test('模板【更新】：管理窗关闭后迟到的预览不弹窗；提交后窗口被强制结束，迟到成功不接管新窗', async () => {
    await setup();
    await js(`cfg.read=cfg.defer();cfg.next.headerPreview=cfg.read;cfg.manager=cfg.bridge.openModal(()=>cfg.dialogs.createTemplateManagerDialog()).handle;
      cfg.top().querySelector('[data-action="update-headers"]').click();cfg.manager.close();cfg.newHandle=cfg.other();
      cfg.read.resolve({status:'success',templateId:1,templateName:'模板 A',sourceFileName:'a.xlsx',expectedHeaders:['日期'],headers:['日期','金额'],
        diff:{identical:false,added:['金额'],removed:[],orderChanged:false},affectedMappings:[],activeStaleCount:0});`); await tick();
    assert.equal(await js('cfg.newHandle.isTop()'), true);
    assert.equal(await js('document.getElementById("modalRoot").children.length'), 1);
    await setup();
    await js(`cfg.manager=cfg.bridge.openModal(()=>cfg.dialogs.createTemplateManagerDialog()).handle;
      cfg.next.headerPreview={status:'success',templateId:1,templateName:'模板 A',sourceFileName:'a.xlsx',expectedHeaders:['日期'],headers:['日期','金额'],
        diff:{identical:false,added:['金额'],removed:[],orderChanged:false},affectedMappings:[],activeStaleCount:0};
      cfg.top().querySelector('[data-action="update-headers"]').click();void 0;`); await tick();
    await js(`cfg.write=cfg.defer();cfg.next.headerUpdate=cfg.write;cfg.top().querySelector('[data-action="submit"]').click();
      cfg.host.getTop().dispose();cfg.manager.dispose();cfg.newHandle=cfg.other();cfg.write.resolve({status:'success',message:'后台更新完成',staleMappings:[]});`); await tick();
    assert.equal(await js('cfg.newHandle.isTop()'), true);
    assert.equal(await js(`cfg.calls.filter(call=>call.name==='refresh').length`), 1);
    assert.deepEqual(await js('cfg.errors'), []);
  });
  await test('映射关系管理：引用已删除字段的映射显示「（已删除）」并保持选中，保存时原值提交由主进程校验拒绝', async () => {
    await setup();
    await js(`cfg.handle=cfg.bridge.openModal(()=>cfg.dialogs.createMappingDialog({template:{id:1,name:'模板 A',headers:['日期','金额(元)']},
      targetFields:['BillDate','Credit Amount','Remark'],
      mappings:[{templateField:'BillDate',mappedField:'日期',mappedFields:[]},{templateField:'Credit Amount',mappedField:'金额',mappedFields:[]},
        {templateField:'Remark',mappedField:'需要拼接字段',mappedFields:['日期','附言']}]})).handle;cfg.overlay=cfg.top();void 0;`);
    const state = await js(`(() => {const row=field=>cfg.overlay.querySelector('tr[data-template-field="'+field+'"]');const select=row('Credit Amount').querySelector('.mapping-select');
      return { value: select.value, label: select.selectedOptions[0].textContent, stale: select.classList.contains('is-stale'),
        billDateStale: row('BillDate').querySelector('.mapping-select').classList.contains('is-stale') };})()`);
    assert.deepEqual(state, { value: '金额', label: '金额（已删除）', stale: true, billDateStale: false });
    await js(`cfg.overlay.querySelector('tr[data-template-field="Remark"] .concat-picker-trigger').click();void 0;`);
    assert.deepEqual(await js(`[...cfg.overlay.querySelectorAll('tr[data-template-field="Remark"] .concat-picker-option')].map(option=>[option.textContent,option.classList.contains('is-stale'),option.querySelector('input').checked])`),
      [['1.日期', false, true], ['金额(元)', false, false], ['2.附言（已删除）', true, true]]);
    await js(`cfg.next.mappingSave={status:'error',message:'映射字段不存在：金额'};cfg.overlay.querySelector('[data-action="done"]').click();void 0;`); await tick();
    const saved = await js(`cfg.calls.filter(call=>call.name==='mappingSave').map(call=>call.args[0].mappings.filter(item=>['Credit Amount','Remark'].includes(item.templateField)).map(item=>[item.templateField,item.mappedField,item.mappedFields]))`);
    assert.deepEqual(saved, [[['Credit Amount', '金额', []], ['Remark', '需要拼接字段', ['日期', '附言']]]]);
    assert.match(await js('cfg.top().textContent'), /映射字段不存在：金额/);
    await js(`cfg.host.closeTop();const select=cfg.overlay.querySelector('tr[data-template-field="Credit Amount"] .mapping-select');select.value='金额(元)';select.dispatchEvent(new Event('change'));void 0;`);
    assert.equal(await js(`cfg.overlay.querySelector('tr[data-template-field="Credit Amount"] .mapping-select').classList.contains('is-stale')`), false);
  });

  // 回归（review P3）：确认期间模板被删除等失败时，【返回】先重新读取模板列表，不显示已删除的模板。
  await test('模板【更新模板】失败：【返回】重新读取模板列表后回到模板管理', async () => {
    await setup();
    await js(`cfg.manager=cfg.bridge.openModal(()=>cfg.dialogs.createTemplateManagerDialog()).handle;
      cfg.next.headerPreview={status:'success',templateId:2,templateName:'模板 B',sourceFileName:'b2.xlsx',expectedHeaders:['日期'],headers:['日期','金额'],
        diff:{identical:false,added:['金额'],removed:[],orderChanged:false},affectedMappings:[],activeStaleCount:0};
      cfg.top().querySelectorAll('[data-action="update-headers"]')[1].click();void 0;`); await tick();
    await js(`cfg.templates=cfg.templates.filter(template=>template.id!==2);
      cfg.next.headerUpdate={status:'error',errorCode:'TEMPLATE_NOT_FOUND',message:'模板已被删除，请刷新后重试',errorReportReady:true};
      cfg.top().querySelector('[data-action="submit"]').click();void 0;`); await tick();
    assert.deepEqual(await js(`[...cfg.top().querySelectorAll('.template-header-update-result-card .dialog-actions button')].map(button=>button.textContent)`), ['返回']);
    assert.equal(await js(`cfg.calls.filter(call=>call.name==='refresh').length`), 0);
    await js(`cfg.top().querySelector('[data-action="back"]').click();`); await tick();
    assert.equal(await js(`cfg.calls.filter(call=>call.name==='refresh').length`), 1);
    assert.match(await js('cfg.top().textContent'), /模板管理/);
    assert.deepEqual(await js(`[...cfg.top().querySelectorAll('tbody tr td:first-child')].map(cell=>cell.textContent.trim())`), ['模板 A']);
  });
  // 回归（review P2）：以 __ 开头的普通列名失效后同样显示「（已删除）」并回传原值，不被当作内部标记静默清空。
  await test('映射关系管理：__ 开头的普通列名失效后显示（已删除）并保留原值', async () => {
    await setup();
    await js(`cfg.handle=cfg.bridge.openModal(()=>cfg.dialogs.createMappingDialog({template:{id:1,name:'模板 A',headers:['日期']},
      targetFields:['BillDate','Credit Amount'],
      mappings:[{templateField:'BillDate',mappedField:'日期',mappedFields:[]},{templateField:'Credit Amount',mappedField:'__金额',mappedFields:[]}]})).handle;cfg.overlay=cfg.top();void 0;`);
    assert.deepEqual(await js(`{const select=cfg.overlay.querySelector('tr[data-template-field="Credit Amount"] .mapping-select');[select.value,select.selectedOptions[0].textContent,select.classList.contains('is-stale')];}`),
      ['__金额', '__金额（已删除）', true]);
    await js(`cfg.overlay.querySelector('[data-action="done"]').click();void 0;`); await tick();
    assert.deepEqual(await js(`cfg.calls.filter(call=>call.name==='mappingSave').map(call=>call.args[0].mappings.find(item=>item.templateField==='Credit Amount').mappedField)`), ['__金额']);
  });

  // 回归（第二轮 review P2）：按币种取大账号标记只在 MerchantId 上是内部值，其他字段上同名的真实列失效后照常标出。
  await test('映射关系管理：非 MerchantId 字段上与币种大账号标记同名的列失效后显示（已删除）并保留原值', async () => {
    await setup();
    await js(`cfg.handle=cfg.bridge.openModal(()=>cfg.dialogs.createMappingDialog({template:{id:1,name:'模板 A',headers:['日期']},
      targetFields:['BillDate','Credit Amount'],
      mappings:[{templateField:'BillDate',mappedField:'日期',mappedFields:[]},{templateField:'Credit Amount',mappedField:'__CURRENCY_ONLY_BIG_ACCOUNT__',mappedFields:[]}]})).handle;cfg.overlay=cfg.top();void 0;`);
    assert.deepEqual(await js(`{const select=cfg.overlay.querySelector('tr[data-template-field="Credit Amount"] .mapping-select');[select.value,select.classList.contains('is-stale')];}`),
      ['__CURRENCY_ONLY_BIG_ACCOUNT__', true]);
    await js(`cfg.overlay.querySelector('[data-action="done"]').click();void 0;`); await tick();
    assert.deepEqual(await js(`cfg.calls.filter(call=>call.name==='mappingSave').map(call=>call.args[0].mappings.find(item=>item.templateField==='Credit Amount').mappedField)`), ['__CURRENCY_ONLY_BIG_ACCOUNT__']);
  });
  // 回归（第二轮 review P3）：结果弹窗关闭后，迟到的刷新失败不改写新会话的状态反馈，也不替换新弹窗。
  await test('模板【更新】结果弹窗：关闭后迟到的刷新失败不反馈、不接管新窗', async () => {
    await setup();
    await js(`cfg.manager=cfg.bridge.openModal(()=>cfg.dialogs.createTemplateManagerDialog()).handle;
      cfg.next.headerPreview={status:'error',message:'模板已被删除，请刷新后重试'};
      cfg.top().querySelector('[data-action="update-headers"]').click();void 0;`); await tick();
    await js(`cfg.read=cfg.defer();cfg.next.refresh=cfg.read;cfg.feedbackBefore=cfg.feedback.length;cfg.top().querySelector('[data-action="back"]').click();
      cfg.host.getTop().dispose();cfg.manager.dispose();cfg.newHandle=cfg.other();cfg.read.reject(new Error('旧请求刷新失败'));void 0;`); await tick();
    assert.equal(await js('cfg.newHandle.isTop()'), true);
    assert.equal(await js('cfg.feedback.length===cfg.feedbackBefore'), true);
    assert.deepEqual(await js('cfg.errors'), []);
  });

  // 回归（第四轮 review P2）：更新已成功、模板列表刷新失败时，结果页仍显示「已更新」、失效映射与【修改映射关系】，返回前重新读取列表。
  await test('模板【更新模板】成功后刷新列表失败：保留成功结果，返回时重新读取', async () => {
    await setup();
    await js(`cfg.manager=cfg.bridge.openModal(()=>cfg.dialogs.createTemplateManagerDialog()).handle;
      cfg.next.headerPreview={status:'success',templateId:1,templateName:'模板 A',sourceFileName:'a.xlsx',expectedHeaders:['日期'],headers:['日期','金额'],
        diff:{identical:false,added:['金额'],removed:[],orderChanged:false},affectedMappings:[],activeStaleCount:0};
      cfg.top().querySelector('[data-action="update-headers"]').click();void 0;`); await tick();
    await js(`cfg.next.headerUpdate={status:'success',message:'模板「模板 A」已更新，有 1 处映射引用的字段已删除，修改映射关系前无法用该模板生成账单',staleMappings:['Credit Amount ← 金额'],activeStaleCount:1};
      cfg.failRead=cfg.defer();cfg.next.refresh=cfg.failRead;cfg.top().querySelector('[data-action="submit"]').click();cfg.failRead.reject(new Error('列表读取失败'));void 0;`); await tick();
    const view = await js(`(() => {const card=cfg.top().querySelector('.template-header-update-result-card');return {
      message: card.querySelector('[data-role="message"]').textContent, note: Boolean(card.querySelector('[data-role="refresh-failed"]')),
      stale: [...card.querySelectorAll('li')].map(item=>item.textContent), buttons: [...card.querySelectorAll('.dialog-actions button')].map(button=>button.textContent)};})()`);
    assert.deepEqual(view, { message: '模板「模板 A」已更新，有 1 处映射引用的字段已删除，修改映射关系前无法用该模板生成账单', note: true,
      stale: ['Credit Amount ← 金额'], buttons: ['修改映射关系', '返回'] });
    await js(`cfg.top().querySelector('[data-action="back"]').click();`); await tick();
    assert.equal(await js(`cfg.calls.filter(call=>call.name==='refresh').length`), 2);
    assert.match(await js('cfg.top().textContent'), /模板管理/);
  });


  // v3.2.19 映射关系管理：【保存】/【返回】、是/否 类映射行改勾选框、「个性化映射设置」、映射字段下拉框减半与弹窗收窄；
  // 币种补全输入（维护大账号、币种映射账号管理）夜间重叠修复。
  const ADVANCED_FIELDS = ['按正负号拆分的发生额', '根据发生额做映射的户名', '根据发生额做映射的账户号', '按字段区分发生额'];
  const SPLIT_FIELDS = ['是否拆分/合并明细账单', '复用模块字段的映射关系'];
  const TOGGLE_FIELDS = ['按字段区分发生额', ...SPLIT_FIELDS];
  async function openToggleMapping(mappings = [], layoutOptions = null, extraTemplate = '') {
    await setup(layoutOptions);
    await js(`cfg.tpl={id:9,name:'招商银行-上海',headers:['交易日期','金额','币种','附言','对手户名']${extraTemplate}};
      cfg.handle=cfg.bridge.openModal(()=>cfg.dialogs.createMappingDialog({template:cfg.tpl,
        targetFields:['BillDate','Credit Amount','Debit Amount','Balance','MerchantId','Currency','Remark',...${JSON.stringify(ADVANCED_FIELDS)},...${JSON.stringify(SPLIT_FIELDS)}],
        advancedMappingFields:${JSON.stringify(ADVANCED_FIELDS)},billSplitGroupFields:${JSON.stringify(SPLIT_FIELDS)},mappings:${JSON.stringify(mappings)}})).handle;
      cfg.overlay=cfg.top();
      cfg.row=field=>cfg.overlay.querySelector('tr[data-template-field="'+field+'"]');
      cfg.toggle=field=>cfg.row(field).querySelector('.mapping-toggle-checkbox');
      cfg.setToggle=(field,checked)=>{const box=cfg.toggle(field);box.checked=checked;box.dispatchEvent(new Event('change'));};
      cfg.toggleBtn=field=>cfg.row(field).querySelector('.mapping-field-editor button');
      cfg.sel=field=>cfg.row(field).querySelector('.mapping-select');
      cfg.saved=()=>cfg.calls.filter(call=>call.name==='mappingSave').map(call=>Object.fromEntries(call.args[0].mappings
        .filter(m=>${JSON.stringify(TOGGLE_FIELDS)}.includes(m.templateField)).map(m=>[m.templateField,m.mappedField])));
      void 0;`);
  }

  await test('映射关系管理：右下角【保存】右侧为【返回】；【返回】放弃编辑回到模板管理，【保存】照常保存', async () => {
    await openToggleMapping();
    assert.deepEqual(await js(`[...cfg.overlay.querySelectorAll('.dialog-actions button')].map(button=>[button.dataset.action,button.textContent.trim()])`),
      [['done', '保存'], ['back', '返回']]);
    await js(`cfg.setToggle('是否拆分/合并明细账单',true);cfg.overlay.querySelector('[data-action="back"]').click();`); await tick();
    assert.equal(await js(`cfg.calls.filter(call=>call.name==='mappingSave').length`), 0);
    assert.equal(await js(`!document.querySelector('.mapping-card')`), true);
    assert.match(await js('cfg.top().textContent'), /模板管理/);
    await openToggleMapping();
    await js(`cfg.overlay.querySelector('[data-action="done"]').click();`); await tick();
    assert.equal(await js(`cfg.calls.filter(call=>call.name==='mappingSave').length`), 1);
    assert.match(await js('cfg.top().textContent'), /模板管理/);
  });

  await test('映射关系管理：是/否 类映射行为勾选框（文字在左），按钮随勾选显示，存储值与互斥规则不变', async () => {
    await openToggleMapping();
    assert.deepEqual(await js(`[...cfg.overlay.querySelectorAll('.mapping-section-row strong')].map(item=>item.textContent)`), ['个性化映射设置', '账单拆分合并管理']);
    const rowsJs = `${JSON.stringify(TOGGLE_FIELDS)}.map(field=>({text:cfg.row(field).cells[0].textContent.trim(),select:Boolean(cfg.row(field).querySelector('select')),
      checked:cfg.toggle(field).checked,button:cfg.toggleBtn(field).textContent.trim(),hidden:cfg.toggleBtn(field).hidden}))`;
    assert.deepEqual(await js(rowsJs), [
      { text: '按字段区分发生额', select: false, checked: false, button: '维护发生额映射关系', hidden: true },
      { text: '拆分/合并明细账单', select: false, checked: false, button: '拆分/合并账单映射关系管理', hidden: true },
      { text: '复用模块字段的映射关系', select: false, checked: true, button: '拆分/合并账单映射关系设置', hidden: true }]);
    // 勾选按字段区分发生额 → 显示【维护发生额映射关系】，Credit / Debit / 按正负号 禁用；不复用 → 显示【拆分/合并账单映射关系设置】
    await js(`cfg.setToggle('按字段区分发生额',true);cfg.setToggle('复用模块字段的映射关系',false);`);
    assert.deepEqual(await js(`({amountBtn:cfg.toggleBtn('按字段区分发生额').hidden,reuseBtn:cfg.toggleBtn('复用模块字段的映射关系').hidden,
      disabled:['Credit Amount','Debit Amount','按正负号拆分的发生额'].map(field=>cfg.sel(field).disabled)})`), { amountBtn: false, reuseBtn: false, disabled: [true, true, true] });
    // 勾选拆分/合并 → 按字段区分发生额取消勾选、禁用并隐藏按钮；Currency / Credit / Debit / 按正负号 禁用
    await js(`cfg.setToggle('是否拆分/合并明细账单',true);`);
    assert.deepEqual(await js(`({splitBtn:cfg.toggleBtn('是否拆分/合并明细账单').hidden,
      amount:[cfg.toggle('按字段区分发生额').checked,cfg.toggle('按字段区分发生额').disabled,cfg.toggleBtn('按字段区分发生额').hidden],
      disabled:['Currency','Credit Amount','Debit Amount','按正负号拆分的发生额'].map(field=>cfg.sel(field).disabled)})`),
      { splitBtn: false, amount: [false, true, true], disabled: [true, true, true, true] });
    await js(`cfg.overlay.querySelector('[data-action="done"]').click();`); await tick();
    assert.deepEqual(await js('cfg.saved()'), [{ '按字段区分发生额': '', '是否拆分/合并明细账单': '是', '复用模块字段的映射关系': '否' }]);

    // 回显已保存的值；取消拆分/合并后按字段区分发生额恢复可用（保持未勾选），其余行解除禁用
    await openToggleMapping([{ templateField: '按字段区分发生额', mappedField: '是', mappedFields: [] }, { templateField: '复用模块字段的映射关系', mappedField: '否', mappedFields: [] }]);
    assert.deepEqual(await js(`${JSON.stringify(TOGGLE_FIELDS)}.map(field=>[cfg.toggle(field).checked,cfg.toggleBtn(field).hidden])`), [[true, false], [false, true], [false, false]]);
    assert.deepEqual(await js(`['Credit Amount','Debit Amount','按正负号拆分的发生额'].map(field=>cfg.sel(field).disabled)`), [true, true, true]);
    await js(`cfg.setToggle('是否拆分/合并明细账单',true);cfg.setToggle('是否拆分/合并明细账单',false);`);
    assert.deepEqual(await js(`({amount:[cfg.toggle('按字段区分发生额').checked,cfg.toggle('按字段区分发生额').disabled],
      disabled:['Currency','Credit Amount','Debit Amount','按正负号拆分的发生额'].map(field=>cfg.sel(field).disabled)})`), { amount: [false, false], disabled: [false, false, false, false] });
    await js(`cfg.setToggle('复用模块字段的映射关系',true);cfg.overlay.querySelector('[data-action="done"]').click();`); await tick();
    assert.deepEqual(await js('cfg.saved()'), [{ '按字段区分发生额': '', '是否拆分/合并明细账单': '', '复用模块字段的映射关系': '是' }]);

    // 已开启拆分/合并的模板：打开即应用互斥
    await openToggleMapping([{ templateField: '是否拆分/合并明细账单', mappedField: '是', mappedFields: [] }]);
    assert.deepEqual(await js(`({split:[cfg.toggle('是否拆分/合并明细账单').checked,cfg.toggleBtn('是否拆分/合并明细账单').hidden],amountDisabled:cfg.toggle('按字段区分发生额').disabled,
      disabled:['Currency','Credit Amount','Debit Amount','按正负号拆分的发生额'].map(field=>cfg.sel(field).disabled)})`), { split: [true, false], amountDisabled: true, disabled: [true, true, true, true] });
  });

  for (const theme of ['light', 'dark']) await test(`映射关系管理布局（${theme}）：映射字段下拉框减半、弹窗收窄，勾选框在文字右侧，标题栏与按钮不换行`, async () => {
    await openToggleMapping([{ templateField: 'MerchantId', mappedField: '自己输入', mappedFields: [] }, { templateField: 'Remark', mappedField: '字段筛选特征值', mappedFields: [] },
      { templateField: '按字段区分发生额', mappedField: '是', mappedFields: [] }], { width: 1440, height: 900, theme, zoom: 1 }, ",channelId:7,channelName:'渠道 A'");
    await layout.settle();
    const geometry = await js(`(() => {
      const card=cfg.overlay.querySelector('.mapping-card'),rect=element=>element.getBoundingClientRect();
      const header=card.querySelector('.dialog-header'),wrapper=card.querySelector('.mapping-wrapper');
      const mainSelects=[...card.querySelectorAll('.mapping-field-editor > .mapping-select')].filter(element=>rect(element).width>0&&!element.closest('[data-template-field="Remark"]'));
      const merchant=cfg.row('MerchantId'),merchantSelect=rect(merchant.querySelector('.mapping-select')),merchantButton=rect(merchant.querySelector('.mapping-big-account-manage-btn'));
      const headerItems=[card.querySelector('.dialog-title'),...card.querySelectorAll('.dialog-checkbox-label'),card.querySelector('[data-role=channel-select]'),card.querySelector('.icon-close')].map(rect);
      const middle=item=>(item.top+item.bottom)/2;
      const gaps=${JSON.stringify(TOGGLE_FIELDS)}.map(field=>rect(cfg.toggle(field)).left-rect(cfg.row(field).querySelector('.mapping-toggle-text')).right);
      const save=rect(card.querySelector('[data-action=done]')),back=rect(card.querySelector('[data-action=back]'));
      const group=rect(cfg.row('Remark').querySelector('.mapping-feature-value-group')),remarkSelect=rect(cfg.row('Remark').querySelector('.mapping-select'));
      const remarkEditor=rect(cfg.row('Remark').querySelector('.mapping-field-editor'));
      return { card: Math.round(rect(card).width), mainSelects: [...new Set(mainSelects.map(element=>Math.round(rect(element).width)))],
        featureValue: Math.round(rect(cfg.row('Remark').querySelector('.mapping-feature-value-select')).width),
        channelKept: rect(card.querySelector('[data-role=channel-select]')).width>=160,
        headerOneLine: headerItems.every(item=>Math.abs(middle(item)-middle(headerItems[0]))<=6)&&header.scrollWidth<=header.clientWidth,
        noHorizontalOverflow: wrapper.scrollWidth<=wrapper.clientWidth,
        merchantButtonSameLine: Math.abs(middle(merchantButton)-middle(merchantSelect))<=2&&merchantButton.left>merchantSelect.right,
        // 特征值一组与主下拉框同行；特征值下拉框右边界对齐上方下拉框右边界，【特征值管理】对齐上方【维护大账号】
        featureGroupSameLine: Math.abs(middle(group)-middle(remarkSelect))<=2&&group.left>remarkSelect.right&&group.right<=remarkEditor.right+1,
        featureAligned: Math.abs(rect(cfg.row('Remark').querySelector('.mapping-feature-value-select')).right-merchantSelect.right)<=1
          &&Math.abs(rect(cfg.row('Remark').querySelector('.mapping-feature-filter-btn')).left-merchantButton.left)<=1,
        togglesRightOfText: gaps.every(gap=>gap>0&&gap<=12),
        backRightOfSave: back.left>=save.right };
    })()`);
    assert.deepEqual(geometry, { card: 780, mainSelects: [362], featureValue: 90, channelKept: true, headerOneLine: true, noHorizontalOverflow: true,
      merchantButtonSameLine: true, featureGroupSameLine: true, featureAligned: true, togglesRightOfText: true, backRightOfSave: true });
    await layout.evidence(`mapping-dialog-compact-${theme}`, { geometry });
    await js(`cfg.overlay.querySelector('.mapping-wrapper').scrollTop=1e6;void 0;`); await layout.settle();
    await layout.evidence(`mapping-dialog-compact-${theme}-toggles`, { geometry });
  });

  for (const theme of ['light', 'dark']) await test(`币种补全输入（${theme}）：维护大账号、币种映射账号管理中补全层与输入框完全重合，无底色/边框外露，补全提示可见`, async () => {
    const probe = `(() => {
      const shell=cfg.top().querySelector('.big-account-currency-input-shell');
      const ghost=shell.querySelector('.big-account-currency-ghost'),input=shell.querySelector('.big-account-currency-input');
      const g=ghost.getBoundingClientRect(),a=input.getBoundingClientRect(),gs=getComputedStyle(ghost),as=getComputedStyle(input),ss=getComputedStyle(shell);
      const clear=value=>value==='rgba(0, 0, 0, 0)'||value==='transparent';
      return { overlap: ['left','top','width','height'].every(key=>Math.abs(g[key]-a[key])<=0.5),
        sameText: gs.fontSize===as.fontSize&&gs.fontFamily===as.fontFamily&&gs.paddingLeft===as.paddingLeft,
        ghostClear: clear(gs.backgroundColor)&&clear(gs.borderTopColor), inputClear: clear(as.backgroundColor),
        shellFilled: !clear(ss.backgroundColor), uppercase: as.textTransform==='uppercase', hint: ghost.value };
    })()`;
    const expected = { overlap: true, sameText: true, ghostClear: true, inputClear: true, shellFilled: true, uppercase: true, hint: 'USD' };
    const typeUs = `{const input=cfg.top().querySelector('.big-account-currency-input');input.value='us';input.dispatchEvent(new Event('input'));}void 0;`;
    await setup({ theme, zoom: 1 });
    await js(`cfg.bridge.openModal(()=>cfg.dialogs.createCurrencyBigAccountMappingDialog({pairs:[],onDone(){},onCancel(){}}));${typeUs}`);
    await layout.settle();
    assert.deepEqual(await js(probe), expected);
    await layout.evidence(`currency-big-account-input-${theme}`, {});
    await js('cfg.host.closeTop();');
    await js(`cfg.bridge.openModal(()=>cfg.dialogs.createBigAccountManagerDialog({bigAccounts:[],templateId:1,templateName:'模板 A'}));${typeUs}`);
    await layout.settle();
    assert.deepEqual(await js(probe), expected);
    await layout.evidence(`big-account-currency-input-${theme}`, {});
  });

};
