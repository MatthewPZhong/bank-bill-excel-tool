'use strict';

// 真实配置工厂/宿主/桥接，API 仅用可控 Promise，不读写真实账户或配置。
module.exports = async ({ js, load, reset, assert, test }) => {
  const tick = () => js('new Promise(resolve=>setTimeout(resolve,5))');
  async function setup() {
    await reset();
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
          saveMappings:payload=>cfg.invoke('mappingSave',[payload],{status:'success',message:'映射保存完成'}),listChildren:id=>cfg.invoke('children',[id],[]),
          setParentStatus:(...args)=>cfg.invoke('parent',args,{status:'success'}),setChildParent:(...args)=>cfg.invoke('child',args,{status:'success'}),
          saveAmountSplitRules:payload=>cfg.invoke('amount',[payload],{status:'success'}),saveBillSplitMappings:payload=>cfg.invoke('splitMapping',[payload],{status:'success'}),
          saveBillSplitAmountRules:payload=>cfg.invoke('splitAmount',[payload],{status:'success'}),
          getMappings:id=>cfg.invoke('templateRead',[id],{status:'success',template:cfg.templates[0],targetFields:[],mappings:[]})},
        accountMappings:{list:id=>cfg.invoke('list',[id],{status:'success',mappings:[]}),
          save:(id,mappings)=>cfg.invoke('save',[id,mappings],{status:'success',message:'保存完成'}),
          distributeMigration:assignments=>cfg.invoke('migration',[assignments],{status:'success'})}};
      cfg.api.balanceAdjustment={list:async()=>({adjustments:[{merchantId:'M001',currency:'USD',effectiveDate:'2026-09-01',adjustmentValue:'10',remark:'原备注'}]}),save:payload=>cfg.invoke('addon',[payload],{status:'success',message:'余额保存完成'})};
      cfg.api.files={saveBalanceSeed:payload=>cfg.invoke('seed',[payload],{status:'success'}),completeBigAccountSelection:payload=>cfg.invoke('simpleSelection',[payload],{status:'success'})};
      cfg.rules=[{targetField:'Credit Amount',conditionField:'Currency',conditionValue:'C',mappedField:'Amount',rowIndex:0},{targetField:'Debit Amount',conditionField:'Currency',conditionValue:'D',mappedField:'Amount',rowIndex:1}];
      cfg.services=ConfigurationServices.createConfigurationServices({templatesApi:cfg.api.templates});
      cfg.services.acceptBootstrap({currencyOptions:['USD','HKD']});cfg.services.applyPreviewTemplates(cfg.templates);
      cfg.dialogs=__rendererDialogs.createRendererDialogs({modalBridge:cfg.bridge,configurationServices:cfg.services,configurationApi:cfg.api,dialogApis:{},reportLog:()=>{},
        scenarioCommands:ScenarioCommandService.createScenarioCommandService({scenariosApi:{},channelsApi:{}}),scenarioSubscriptions:ScenarioChangeRouter.createScenarioChangeRouter(),
        appConstants:{},ADVANCED_MAPPING_FIELDS:[],setStatus:(...args)=>cfg.feedback.push(args),applyStatementResult:()=>cfg.applied++,applyManualBalancePromptStatus:()=>cfg.applied++});
      cfg.openMapping=()=>{cfg.handle=cfg.bridge.openModal(()=>cfg.dialogs.createAccountMappingDialog({currentTemplateId:1,templates:cfg.templates,mappings:cfg.mappings('A')})).handle;
        cfg.overlay=cfg.top();cfg.select=cfg.overlay.querySelector('[data-role="template-select"]');cfg.save=cfg.overlay.querySelector('[data-action="done"]');};
      cfg.choose=id=>{cfg.select.value=String(id);cfg.select.dispatchEvent(new Event('change'));};
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
    assert.deepEqual(await js(`cfg.calls.filter(call=>call.name==='save').map(call=>call.args)`), [[2,[{bankAccountId:'B-ACCOUNT',clearingAccountId:'B-CLEARING',noCurrency:true,currency:'HKD'}]]]);
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
    assert.deepEqual(await js(`cfg.calls.find(call=>call.name==='save').args`), [2,[]]);
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
  await test('映射主/子关系后续写入使用提交时快照，原窗结束也完成已确定关系链', async () => {
    await setup();
    await js(`cfg.templates[1].name='模板 A 的主模板';cfg.templates[0].name='模板 A 的主模板-子';cfg.templates[1].isParent=true;cfg.services.applyPreviewTemplates(cfg.templates);
      cfg.handle=cfg.bridge.openModal(()=>cfg.dialogs.createMappingDialog({template:cfg.templates[0],targetFields:[],mappings:[]})).handle;
      cfg.overlay=cfg.top();cfg.child=cfg.overlay.querySelector('[data-role="is-child"]');cfg.parent=cfg.overlay.querySelector('[data-role="parent-select"]');
      cfg.child.checked=true;cfg.parent.value='2';cfg.write=cfg.defer();cfg.next.mappingSave=cfg.write;cfg.overlay.querySelector('[data-action="done"]').click();
      cfg.child.checked=false;cfg.parent.value='';cfg.handle.dispose();cfg.newHandle=cfg.other();cfg.write.resolve({status:'success',message:'映射已保存'});`); await tick();
    assert.deepEqual(await js(`cfg.calls.filter(call=>call.name==='child').map(call=>call.args)`), [[1,2]]);
    assert.equal(await js('cfg.newHandle.isTop()'), true);
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

  await test('主模板身份确认未结束不提交中间态，窗口结束后不弹迟到原生确认', async () => {
    await setup();
    await js(`cfg.templates[0].isParent=true;cfg.prompts=0;window.confirm=()=>{cfg.prompts++;return true;};
      cfg.handle=cfg.bridge.openModal(()=>cfg.dialogs.createMappingDialog({template:cfg.templates[0],targetFields:[],mappings:[]})).handle;cfg.overlay=cfg.top();
      cfg.read=cfg.defer();cfg.next.children=cfg.read;cfg.checkbox=cfg.overlay.querySelector('[data-role="is-parent"]');cfg.checkbox.checked=false;cfg.checkbox.dispatchEvent(new Event('change'));
      cfg.overlay.querySelector('[data-action="done"]').dispatchEvent(new Event('click'));`);
    assert.equal(await js(`cfg.calls.filter(call=>call.name==='mappingSave').length`),0);
    assert.equal(await js('cfg.handle.close().status'),'blocked');
    await js(`cfg.handle.dispose();cfg.newHandle=cfg.other();cfg.read.resolve([{id:2}]);`);await tick();
    assert.equal(await js('cfg.newHandle.isTop()&&cfg.prompts===0'),true);
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

  async function setupRowWrites({ groups=[9], completed=false, rules=false, signed=false, signedTargets=null }={}) {
    await setup();
    await js(`
      cfg.rowTemplate={id:7,name:'删行测试模板',headers:['Currency','Amount']};
      cfg.rows=[{seqNo:1,rowStatus:${JSON.stringify(completed?'completed':'draft')},currencySourceField:'Currency',creditSourceField:'',debitSourceField:''},{seqNo:2,rowStatus:${JSON.stringify(completed?'completed':'draft')},currencySourceField:'Currency',creditSourceField:'',debitSourceField:''}];
      cfg.groups=${JSON.stringify(groups)};cfg.settled=[];cfg.initialRules=${rules?'cfg.rules':'[]'};
      cfg.meta={signedAmountSourceField:${JSON.stringify(signed?'Amount':'')},signedAmountTargetSeqNos:${signedTargets===null?(signed?'[1]':'[]'):JSON.stringify(signedTargets)},byFieldAmountTargetSeqNos:${rules?'[1]':'[]'}};
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
    {name:'指定字段账单清空',method:'rowMeta',rules:true,action:`cfg.select=cfg.overlay.querySelector('.bill-split-by-field-target-seq-checkbox');cfg.select.checked=false;cfg.select.dispatchEvent(new Event('change'));`,payload:{templateId:7,signedAmountSourceField:'',signedAmountTargetSeqNos:[],byFieldAmountTargetSeqNos:[]}}
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
    await js(`cfg.rowsHandle.close();cfg.late=cfg.defer();cfg.next.rowRefresh=cfg.late;cfg.openRowsButton.click();cfg.toggle=cfg.mappingOverlay.querySelector('.bill-split-group-select');cfg.toggle.value='';cfg.toggle.dispatchEvent(new Event('change'));${enableAgain?"cfg.toggle.value='是';cfg.toggle.dispatchEvent(new Event('change'));":''}cfg.late.resolve({status:'success',billSplitRows:[]});`);await tick();
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

};
