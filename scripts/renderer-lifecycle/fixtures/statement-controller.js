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
        accountMappings:{checkMigrationPending:()=>f.invoke('migration',[],{pending:false}),list:id=>f.invoke('mappingList',[id],{status:'success',rows:[]}),
          listChannelConflicts:()=>f.invoke('conflicts',[],{status:'success',channels:[]})},
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
  // v3.2.15 PR #246 审查：进入网银账单时的渠道冲突提示不替换已有弹窗（如启动时的更新说明），等其关闭后再弹；期间离开模块则不弹。
  await test('渠道冲突提示等已有弹窗关闭后再弹，不替换应用级弹窗；等待期间离开模块则不弹', async () => {
    await setup();
    const conflicts = "({status:'success',channels:[{channelId:3,channelName:'招商银行-上海',conflicts:[{bankAccountId:'111',candidates:[]}]}]})";
    await js(`{const f=statementFixture;f.controller.leave();f.conflicts=f.defer();f.next.conflicts=f.conflicts;
      f.other=f.bridge.openModal(()=>f.modal('更新说明'),{owner:'application'}).handle;f.controller.enter();}void 0;`);
    await tick();
    await js(`statementFixture.conflicts.resolve(${conflicts});void 0;`);
    await tick(); await tick();
    assert.deepEqual(await js(`({count:statementFixture.root.children.length,title:statementFixture.top()?.querySelector('.dialog-title')?.textContent||statementFixture.top()?.textContent.trim().slice(0,20),otherOpen:statementFixture.other.isOpen()})`),
      { count: 1, title: '更新说明', otherOpen: true }, '冲突提示不替换已有弹窗');
    await js(`statementFixture.other.close({status:'submitted'});void 0;`);
    await tick(); await tick();
    assert.match(await js(`statementFixture.top()?.textContent||''`), /升级后，渠道「招商银行-上海」的账户映射有设置不一致的账户号/);
    await js(`statementFixture.host.closeTop();void 0;`);
    await tick();

    await setup();
    await js(`{const f=statementFixture;f.controller.leave();f.conflicts=f.defer();f.next.conflicts=f.conflicts;
      f.other=f.bridge.openModal(()=>f.modal('更新说明'),{owner:'application'}).handle;f.controller.enter();}void 0;`);
    await tick();
    await js(`statementFixture.conflicts.resolve(${conflicts});void 0;`);
    await tick();
    await js(`statementFixture.controller.leave();statementFixture.other.close({status:'submitted'});void 0;`);
    await tick(); await tick();
    assert.equal(await js('statementFixture.root.children.length'), 0, '离开模块后不再弹出冲突提示');
    assert.deepEqual(await js('statementFixture.errors'), []);
  });

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
    await js(`statementFixture.host.dispose();`);
    await setup();
    // v3.2.16 D7：已有上一账单日余额但首日对不上，状态框标题与补录弹窗写明是“核对”，不是缺余额。
    await js(`statementFixture.next.import={status:'manual-balance-required',message:'上一账单日余额与账单对不上，请核对后重新补录',manualBalancePromptReady:true,
      manualBalancePrompt:{merchantId:'SEED',currency:'VND',targetBillDate:'2026-10-01',queueIndex:1,queueTotal:1,
        seedMismatch:{seedDate:'2026-09-30',seedBalance:0,seedGenerationMethod:'人工录入',anchorBalance:0,billDate:'2026-10-01',
          creditAmount:0,debitAmount:201500,expectedBalance:-201500,statementBalances:[800000,798500]}},detailReady:true,balanceReady:false};
      statementFixture.controller.commands.importFile();`); await tick();
    assert.equal(await js(`statementFixture.feedback.at(-1).options.manualBalancePromptTitle`), '点击核对上一账单日余额');
    await js(`document.getElementById('statusBox').click()`); await tick();
    assert.deepEqual(await js(`({warning:Boolean(statementFixture.top()?.querySelector('.manual-balance-seed-mismatch')),
      date:statementFixture.top()?.querySelector('.manual-balance-date-input')?.value})`), {warning:true,date:'2026-09-30'});
    await js(`statementFixture.host.dispose();`);
    await setup();
    // 账单日期断档：导入后直接弹确认；关闭后状态框可重新打开同一确认。
    await js(`statementFixture.next.import={status:'manual-balance-required',message:'账单日期不连续（1 处），请确认是否补录断档前一日的期末余额',manualBalancePromptReady:true,
      manualBalancePrompt:{reason:'gap',merchantId:'GAP',currency:'USD',anchorDate:'2026-08-01',targetBillDate:'2026-08-04',missingFrom:'2026-08-02',missingTo:'2026-08-03',suggestedSeedDate:'2026-08-03',gapKey:'G1',
        gaps:[{key:'G1',merchantId:'GAP',currency:'USD',anchorDate:'2026-08-01',targetBillDate:'2026-08-04',missingFrom:'2026-08-02',missingTo:'2026-08-03'}]},detailReady:true,balanceReady:false};
      statementFixture.controller.commands.importFile();`); await tick();
    assert.equal(await js(`Boolean(statementFixture.top()?.querySelector('.balance-gap-card'))`), true);
    assert.equal(await js(`statementFixture.feedback.at(-1).options.manualBalancePromptTitle`), '点击处理账单日期断档');
    await js(`statementFixture.top().querySelector('.icon-close').click()`); await tick();
    await js(`document.getElementById('statusBox').click()`); await tick();
    assert.equal(await js(`Boolean(statementFixture.top()?.querySelector('.balance-gap-card'))`), true);
    // 导出明细不处理余额：断档提示仍留在状态框，可再次打开。
    await js(`statementFixture.top().querySelector('.icon-close').click()`); await tick();
    await js(`statementFixture.controller.commands.exportDetail()`); await tick();
    assert.equal(await js('statementFixture.text()'), '明细已导出');
    assert.equal(await js(`statementFixture.feedback.at(-1).options.manualBalancePromptTitle`), '点击处理账单日期断档');
    await js(`document.getElementById('statusBox').click()`); await tick();
    assert.equal(await js(`Boolean(statementFixture.top()?.querySelector('.balance-gap-card'))`), true);
    // 多批次时导出明细先选范围：选完范围导出后同样保留断档入口。
    await js(`statementFixture.top().querySelector('.icon-close').click()`); await tick();
    await js(`statementFixture.next.detail={status:'select-export-scope'};statementFixture.controller.commands.exportDetail()`); await tick();
    await js(`statementFixture.next.detail={status:'success',message:'当前批次明细已导出'};statementFixture.top().querySelector('[data-scope="current"]').click()`); await tick();
    assert.equal(await js('statementFixture.text()'), '当前批次明细已导出');
    assert.equal(await js(`statementFixture.feedback.at(-1).options.manualBalancePromptTitle`), '点击处理账单日期断档');
    await js(`document.getElementById('statusBox').click()`); await tick();
    assert.equal(await js(`Boolean(statementFixture.top()?.querySelector('.balance-gap-card'))`), true);
    assert.equal(await js(`statementFixture.calls.filter(call=>call.name==='error').length`), 0);
    await js(`statementFixture.host.dispose();`);
    await setup();
    // v3.2.16 余额校验不一致：导入后直接弹确认；关闭后状态框可重新打开同一确认。
    await js(`statementFixture.next.import={status:'manual-balance-required',message:'账单余额校验不一致（1 处），请核查或确认按账单余额生成',manualBalancePromptReady:true,
      manualBalancePrompt:{reason:'mismatch',merchantId:'MIS',currency:'USD',targetBillDate:'2026-08-04',
        mismatches:[{key:'X1',merchantId:'MIS',currency:'USD',billDate:'2026-08-04',anchorDate:'2026-08-03',anchorSource:'statement',anchorBalance:100,
          creditAmount:10,debitAmount:0,expectedBalance:110,statementBalance:120,difference:10,missingFrom:'',missingTo:''}]},detailReady:true,balanceReady:false};
      statementFixture.controller.commands.importFile();`); await tick();
    assert.equal(await js(`Boolean(statementFixture.top()?.querySelector('.balance-mismatch-card'))`), true);
    assert.equal(await js(`statementFixture.feedback.at(-1).options.manualBalancePromptTitle`), '点击处理余额校验不一致');
    await js(`statementFixture.top().querySelector('.icon-close').click()`); await tick();
    await js(`document.getElementById('statusBox').click()`); await tick();
    assert.equal(await js(`Boolean(statementFixture.top()?.querySelector('.balance-mismatch-card'))`), true);
    assert.equal(await js(`statementFixture.calls.filter(call=>call.name==='error').length`), 0);
    await js(`statementFixture.host.dispose();`);
    await setup();
    // v3.2.16 人工补录替换：导入后直接弹确认；关闭后状态框可重新打开同一确认。
    await js(`statementFixture.next.import={status:'manual-balance-required',message:'人工补录的期末余额与本次余额不一致（1 处），请核查或确认替换',manualBalancePromptReady:true,
      manualBalancePrompt:{reason:'seed-replace',merchantId:'REP',currency:'USD',targetBillDate:'2026-08-04',
        replacements:[{key:'R1',merchantId:'REP',currency:'USD',billDate:'2026-08-04',balanceSource:'statement',manualBalance:500,balance:120,difference:-380,adjustment:0,writtenBalance:120}]},
      detailReady:true,balanceReady:false};
      statementFixture.controller.commands.importFile();`); await tick();
    assert.equal(await js(`Boolean(statementFixture.top()?.querySelector('.balance-seed-replace-card'))`), true);
    assert.equal(await js(`statementFixture.feedback.at(-1).options.manualBalancePromptTitle`), '点击处理人工补录余额替换');
    await js(`statementFixture.top().querySelector('.icon-close').click()`); await tick();
    await js(`document.getElementById('statusBox').click()`); await tick();
    assert.equal(await js(`Boolean(statementFixture.top()?.querySelector('.balance-seed-replace-card'))`), true);
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
  // v3.2.16：「原始账单仅有币种无账户号」币种未维护大账号时整批阻断，弹窗列出文件、币种和行号（spec D1）
  await test('导入因币种未维护大账号被阻断时，弹窗列出明细并禁用导出', async () => {
    await setup();
    await js(`statementFixture.next.import={status:'error',message:'有 2 行明细的币种为空或未在【映射管理】中维护大账号',errorCode:'CURRENCY_BIG_ACCOUNT_UNMAPPED',
      detailLines:['模板「招商银行-上海」文件「a.xlsx」币种「GBP」：第 3 行','模板「招商银行-上海」文件「a.xlsx」币种「（空）」：第 5 行'],errorReportReady:true};
      statementFixture.controller.commands.importFile()`); await tick();
    assert.deepEqual(await js('statementFixture.alerts'), [
      '有 2 行明细的币种为空或未在【映射管理】中维护大账号\n模板「招商银行-上海」文件「a.xlsx」币种「GBP」：第 3 行\n模板「招商银行-上海」文件「a.xlsx」币种「（空）」：第 5 行'
    ]);
    assert.equal(await js(`document.getElementById('exportDetailBtn').disabled&&document.getElementById('exportBalanceBtn').disabled`), true);
    await js(`statementFixture.next.import={status:'error',message:'测试错误',errorCode:'FILE_READ',detailLines:['不弹窗'],errorReportReady:true};statementFixture.controller.commands.importFile()`); await tick();
    assert.equal(await js('statementFixture.alerts.length'), 1);
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
