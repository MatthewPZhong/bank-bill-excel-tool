'use strict';
const fs = require('node:fs');
const path = require('node:path');
const index = fs.readFileSync(path.resolve(__dirname, '../../../index.html'), 'utf8');
const panelHtml = index.match(/<section id="statementModulePanel"[\s\S]*?<\/section>/)[0];

// 实际 index 面板 + Statement/配置服务/公共工厂/宿主；只注入可控 API，不创建业务文件。
module.exports = async ({ js, load, reset, assert, test }) => {
  const tick = () => js('statementFixture.tick()');
  async function setup() {
    await reset(`<div id="modalRoot"></div>${panelHtml}`);
    await load('src/renderer/dialogs/toolbox.js');
    await load('src/renderer-dialogs.js');
    await load('src/renderer/controllers/statement.js');
    await js(`
      window.statementFixture={calls:[],next:{},alerts:[],feedback:[],errors:[],
        tick:()=>new Promise(resolve=>setTimeout(resolve,0)),
        root:document.getElementById('modalRoot'),panel:document.getElementById('statementModulePanel'),
        host:__rendererModalHost,bridge:__rendererModalBridge,
        defer(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};},
        invoke(name,args,fallback){this.calls.push({name,args});const value=this.next[name];delete this.next[name];return value?.promise || Promise.resolve(value===undefined?fallback:value);},
        text(){return document.querySelector('#statusBox .status-box-text').textContent;},
        top(){return this.root.lastElementChild;},
        modal(title){const overlay=document.createElement('div');overlay.className='modal-overlay';overlay.innerHTML='<div class="modal-card"><div class="dialog-title">'+title+'</div><button>关闭</button></div>';return overlay;}
      };
      const f=statementFixture;
      f.api={templates:{list:()=>f.invoke('templatesList',[],[{id:21,name:'测试模板',headers:['Currency']}]),importTemplate:()=>f.invoke('templateImport',[],{status:'success',message:'模板已导入'})},
        files:{importFile:id=>f.invoke('import',[id],{status:'success',message:'导入成功',detailReady:true,balanceReady:true}),
          exportDetail:scope=>f.invoke('detail',[scope],{status:'success',message:'明细已导出'}),exportBalance:scope=>f.invoke('balance',[scope],{status:'success',message:'余额已导出'}),
          completeBigAccountSelection:payload=>f.invoke('completeAccount',[payload],{status:'success',message:'已确认大账号',detailReady:true,balanceReady:true}),
          cancelBigAccountSelection:id=>f.invoke('cancelAccount',[id],{status:'cancelled'})},
        monthlyBalance:{assemble:payload=>f.invoke('assemble',[payload],{status:'ready',summary:{count:6}}),export:()=>f.invoke('monthly',[],{status:'success',message:'月度导出成功'})},
        errors:{exportLast:()=>f.invoke('error',[],{status:'success',message:'错误报告已导出'})},
        accountMappings:{checkMigrationPending:()=>f.invoke('migration',[],{pending:false}),list:id=>f.invoke('mappingList',[id],{status:'success',rows:[]})},
        bigAccount:{loadMode:async()=>({mode:'unfixed'}),loadOrder:async()=>({order:null})}};
      f.config=ConfigurationServices.createConfigurationServices({templatesApi:f.api.templates});
      f.config.acceptBootstrap({currencyOptions:['USD'],accountMappingCount:2});
      f.config.applyPreviewTemplates([{id:21,name:'测试模板',headers:['Currency']}]);
      const commands=ScenarioCommandService.createScenarioCommandService({scenariosApi:{},channelsApi:{}});
      const subscriptions=ScenarioChangeRouter.createScenarioChangeRouter();
      f.dialogs=__rendererDialogs.createRendererDialogs({modalBridge:f.bridge,configurationServices:f.config,configurationApi:f.api,dialogApis:{},reportLog:()=>{},
        scenarioCommands:commands,scenarioSubscriptions:subscriptions,appConstants:{},
        createFeedbackScope:()=>f.controller.createFeedbackScope(),
        setStatus:(...args)=>f.controller.createFeedbackScope().setStatus(...args),applyStatementResult:value=>f.controller.createFeedbackScope().applyStatementResult(value),
        applyManualBalancePromptStatus:value=>f.controller.createFeedbackScope().applyManualBalancePromptStatus(value)});
      const ui={modalHost:f.host,modalBridge:f.bridge,status(element,message,tone,options){element.querySelector('.status-box-text').textContent=message;element.dataset.tone=tone;f.feedback.push({message,tone,options});},
        alertNative:message=>f.alerts.push(message),reportError:error=>f.errors.push(String(error.message||error))};
      for(const name of ['createAlertDialog','createTemplateManagerDialog','createBigAccountSelectionDialog','createRememberOrderMismatchDialog','createExportScopeDialog','createMonthlyBalanceExportDialog','createManualBalanceSeedDialog','createAccountMappingDialog','createAccountMappingMigrationDialog'])ui[name]=f.dialogs[name];
      f.controller=StatementController.createStatementController({api:f.api,panel:f.panel,config:f.config,ui,initialInfo:{hasEnum:true}});
      f.controller.enter(); void 0;
    `);
    await tick();
  }
  async function openMonthly() {
    await js(`statementFixture.controller.commands.changeMode('export-monthly-balance');statementFixture.controller.commands.exportBalance();void 0;`);
    await tick();
    await js(`const monthlyElement=statementFixture.top();monthlyElement.querySelector('[data-role="year"]').value=String(new Date().getFullYear());monthlyElement.querySelector('[data-role="month"]').value='8';`);
  }
  await test('Statement 使用实际模式面板，导入原样传虚拟模板ID，成功/取消保持原结果', async () => {
    await setup();
    await js(`statementFixture.controller.commands.importFile()`);
    assert.deepEqual(await js(`({args:statementFixture.calls.find(call=>call.name==='import').args,text:statementFixture.text(),detail:document.getElementById('exportDetailBtn').disabled,balance:document.getElementById('exportBalanceBtn').disabled})`),
      {args:['__FILENAME_MAPPING__'],text:'导入成功',detail:false,balance:false});
    await js(`statementFixture.next.import={status:'cancelled'};statementFixture.controller.commands.importFile()`);
    assert.equal(await js('statementFixture.text()'), '导入成功');
    await js(`statementFixture.controller.commands.changeMode('export-monthly-balance');statementFixture.controller.commands.changeMode('create-statement');`);
    assert.equal(await js(`document.getElementById('exportDetailBtn').disabled`), false);
  });
  for (const code of ['MONTHLY_BALANCE_NO_PENDING','MONTHLY_BALANCE_FILE_MISSING']) {
    await test(`真实月度装配后导出 ${code}，下一次重新打开装配层`, async () => {
      await setup(); await openMonthly();
      await js(`statementFixture.top().querySelector('[data-action="done"]').click()`); await tick();
      assert.match(await js('statementFixture.text()'), /共 6 条记录/);
      await js(`statementFixture.next.monthly={status:'error',errorCode:'${code}',message:'月度缓存失效'};statementFixture.controller.commands.exportBalance();void 0;`);
      assert.equal(await js('statementFixture.text()'), '月度缓存失效');
      await js(`statementFixture.controller.commands.exportBalance();void 0;`);
      assert.equal(await js(`!!document.querySelector('.monthly-balance-export-card')`), true);
      assert.deepEqual(await js(`statementFixture.calls.find(call=>call.name==='assemble').args[0]`), {templateScope:'all',templateName:'',year:new Date().getFullYear(),month:8});
    });
  }
  await test('导入分流真实大账号选择/记忆顺序异常窗口，手工余额提示按原结果进入', async () => {
    await setup();
    await js(`statementFixture.next.import={status:'select-big-account',contextId:'fixture-selection',templateId:21,templateName:'测试模板',rows:[{index:0,fileIndex:0,fileName:'fixture.xlsx',sourceRowNumber:1}],expandedBigAccountOptions:[{merchantId:'FIXTURE',currency:'USD'}],canRemember:false};statementFixture.controller.commands.importFile()`); await tick();
    assert.equal(await js(`!!document.querySelector('.big-account-selection-card')`), true);
    await js(`statementFixture.host.dispose();`);
    await setup();
    await js(`statementFixture.next.import={status:'remember-order-mismatch',failedFileNames:['fixture.xlsx'],contextId:'fixture-order',rows:[]};statementFixture.controller.commands.importFile()`); await tick();
    assert.match(await js(`statementFixture.top().textContent`), /fixture.xlsx的账户个数或账户号匹配不上/);
    await js(`statementFixture.host.dispose();`);
    await setup();
    await js(`statementFixture.next.import={status:'manual-balance-required',message:'需要上一账单余额',manualBalancePromptReady:true,manualBalancePrompt:{merchantId:'FIXTURE',currency:'USD',targetBillDate:'2026-08-01'},detailReady:false,balanceReady:false};statementFixture.controller.commands.importFile();`); await tick();
    await js(`document.getElementById('statusBox').click()`); await tick();
    assert.match(await js(`statementFixture.top().textContent`), /FIXTURE/);
    assert.equal(await js(`statementFixture.calls.filter(call=>call.name==='error').length`), 0);
  });
  await test('导出范围公共工厂准确传 current/all，错误报告成功后仍可再次导出', async () => {
    await setup(); await js(`statementFixture.controller.commands.importFile()`);
    await js(`statementFixture.next.detail={status:'select-export-scope'};statementFixture.controller.commands.exportDetail()`);
    await js(`statementFixture.top().querySelector('[data-scope="all"]').click()`); await tick();
    assert.deepEqual(await js(`statementFixture.calls.filter(call=>call.name==='detail').map(call=>call.args[0]??null)`), [null,'all']);
    assert.equal(await js('statementFixture.text()'), '明细已导出');
    await js(`statementFixture.next.import={status:'error',message:'测试错误',errorReportReady:true};statementFixture.controller.commands.importFile()`);
    await js(`statementFixture.controller.commands.exportError();`); await tick();
    await js(`statementFixture.controller.commands.exportError();`); await tick();
    assert.equal(await js(`statementFixture.calls.filter(call=>call.name==='error').length`), 2);
  });
  await test('导入双击只有一个IPC，离页期间不渲染；重进消费真实在途结果且不新增sessionStatus', async () => {
    await setup();
    await js(`statementFixture.pending=statementFixture.defer();statementFixture.next.import=statementFixture.pending;document.getElementById('importFileBtn').click();document.getElementById('importFileBtn').click();statementFixture.controller.leave();`);
    assert.equal(await js(`statementFixture.calls.filter(call=>call.name==='import').length`), 1);
    await js(`statementFixture.pending.resolve({status:'success',message:'后台完成',detailReady:true,balanceReady:true});`); await tick();
    assert.notEqual(await js('statementFixture.text()'), '后台完成');
    await js(`statementFixture.controller.enter();`);
    assert.equal(await js('statementFixture.text()'), '后台完成');
    assert.equal(await js(`document.getElementById('exportDetailBtn').disabled`), false);
  });
  await test('离页/重进先发生、导入随后成功时正确恢复按钮；旧feedbackScope不得修改新页', async () => {
    await setup();
    await js(`statementFixture.oldScope=statementFixture.controller.createFeedbackScope();statementFixture.pending=statementFixture.defer();statementFixture.next.import=statementFixture.pending;statementFixture.controller.commands.importFile();statementFixture.controller.leave();statementFixture.controller.enter();`);
    await js(`statementFixture.pending.resolve({status:'success',message:'重进后完成',detailReady:true,balanceReady:false});`); await tick();
    await js(`statementFixture.oldScope.setStatus('过期窗口错误','error');`);
    assert.equal(await js('statementFixture.text()'), '重进后完成');
    assert.equal(await js(`document.getElementById('exportDetailBtn').disabled`), false);
  });
  await test('真实月度装配双击只发送一次assemble且busy时不能关闭', async () => {
    await setup(); await openMonthly();
    await js(`statementFixture.pending=statementFixture.defer();statementFixture.next.assemble=statementFixture.pending;const done=statementFixture.top().querySelector('[data-action="done"]');done.click();done.click();`);
    assert.equal(await js(`statementFixture.calls.filter(call=>call.name==='assemble').length`), 1);
    assert.equal(await js(`statementFixture.host.getTop().close().status`), 'blocked');
    await js(`statementFixture.pending.resolve({status:'ready',summary:{count:2}})`); await tick();
  });
  await test('月度装配窗口最终销毁后晚到ready不能关闭新窗口或写旧反馈', async () => {
    await setup(); await openMonthly();
    await js(`statementFixture.pending=statementFixture.defer();statementFixture.next.assemble=statementFixture.pending;statementFixture.top().querySelector('[data-action="done"]').click();statementFixture.host.getTop().dispose();statementFixture.controller.leave();`);
    // handle.dispose 为宿主正式强制收尾；旧请求不能关闭同宿主的新owner弹窗。
    await js(`statementFixture.bridge.openModal(()=>statementFixture.modal('新模块窗口'),{owner:'another-module'});statementFixture.pending.resolve({status:'ready',summary:{count:9}});`); await tick();
    assert.match(await js(`statementFixture.root.textContent`), /新模块窗口/);
    assert.notEqual(await js('statementFixture.text()'), '月度余额账单已生成（共 9 条记录），可点击"导出余额"另存为文件');
  });
  await test('迟到导入等待大账号确认时不复活旧窗口，再次点击继续原 context 且不重复导入', async () => {
    await setup();
    await js(`statementFixture.pending=statementFixture.defer();statementFixture.next.import=statementFixture.pending;
      statementFixture.controller.commands.importFile();statementFixture.controller.leave();statementFixture.controller.enter();
      statementFixture.pending.resolve({status:'select-big-account',contextId:'late-context',templateId:21,rows:[],expandedBigAccountOptions:[]});`);
    await tick();
    assert.equal(await js(`statementFixture.root.childElementCount`), 0);
    assert.match(await js('statementFixture.text()'), /导入等待确认/);
    await js(`statementFixture.controller.commands.importFile()`);
    assert.equal(await js(`!!document.querySelector('.big-account-selection-card')`), true);
    assert.equal(await js(`statementFixture.calls.filter(call=>call.name==='import').length`), 1);
  });
  await test('导出范围忙碌时拒绝双击及关闭，最终销毁后的旧回应不接管新窗口', async () => {
    await setup();
    await js(`statementFixture.next.detail={status:'select-export-scope'};statementFixture.controller.commands.exportDetail()`);
    await js(`statementFixture.pending=statementFixture.defer();statementFixture.next.detail=statementFixture.pending;
      statementFixture.top().querySelector('[data-scope="all"]').click();statementFixture.top().querySelector('[data-scope="current"]').click();`);
    assert.equal(await js(`statementFixture.calls.filter(call=>call.name==='detail').length`), 2);
    assert.equal(await js(`statementFixture.host.getTop().close().status`), 'blocked');
    await js(`statementFixture.host.getTop().dispose();statementFixture.bridge.openModal(()=>statementFixture.modal('保留新窗口'),{owner:'new'});
      statementFixture.pending.resolve({status:'select-export-scope'});`);
    await tick();
    assert.match(await js(`statementFixture.root.textContent`), /保留新窗口/);
  });
};
