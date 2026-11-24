'use strict';
const fs = require('node:fs');
const path = require('node:path');
const index = fs.readFileSync(path.resolve(__dirname, '../../../index.html'), 'utf8');
const panelHtml = index.match(/<section id="statementModulePanel"[\s\S]*?<\/section>/)[0];

// 实际 index 面板 + Statement/配置服务/公共工厂/宿主；只注入可控 API，不创建业务文件。
module.exports = async ({ js, load, reset, assert, test, layout }) => {
  const tick = () => js('statementFixture.tick()');
  // layoutOptions：加载生产样式的真实窗口，用于检查布局。
  async function setup(layoutOptions = null) {
    await reset(`<div id="modalRoot"></div>${panelHtml}`, layoutOptions ? { layout: layoutOptions } : undefined);
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
      f.api={templates:{list:()=>f.invoke('templatesList',[],[{id:21,name:'测试模板',headers:['Currency']}]),prepareImport:()=>f.invoke('prepareImport',[],{status:'ready',importToken:'tok-1',sourceFileName:'样本.xlsx'}),
          discardImport:token=>f.invoke('discardImport',[token],{status:'success'}),
          importTemplate:payload=>f.invoke('templateImport',[payload],{status:'success',message:'模板已导入'})},
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
      for(const name of ['createAlertDialog','createTemplateManagerDialog','createBigAccountSelectionDialog','createRememberOrderMismatchDialog','createDuplicateRowsReviewDialog','createExportScopeDialog','createMonthlyBalanceExportDialog','createManualBalanceSeedDialog','createAccountMappingDialog','createAccountMappingMigrationDialog','createTemplateImportNameDialog'])ui[name]=f.dialogs[name];
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

  // v3.2.18【导入模板】命名：预检识别新模板 → 命名弹框（只保留英文字母、数字、空格）→ 名称类错误保留弹框，其他结果关闭。
  await test('导入模板：取消选文件与预检报错不弹框；命名弹框过滤输入、按钮顺序与蓝色确认、重名保留弹框、成功后刷新模板', async () => {
    await setup();
    await js(`statementFixture.next.prepareImport={status:'cancelled'};statementFixture.controller.commands.importTemplate()`);
    await tick();
    assert.deepEqual(await js(`({count:statementFixture.root.childElementCount,calls:statementFixture.calls.filter(call=>call.name==='templateImport').length})`), { count: 0, calls: 0 });
    await js(`statementFixture.next.prepareImport={status:'error',message:'该文件的表头与已有模板「X」完全相同',errorReportReady:true};statementFixture.controller.commands.importTemplate()`);
    await tick();
    assert.deepEqual(await js(`({count:statementFixture.root.childElementCount,text:statementFixture.text(),tone:document.getElementById('statusBox').dataset.tone})`),
      { count: 0, text: '该文件的表头与已有模板「X」完全相同', tone: 'error' });

    await js(`statementFixture.controller.commands.importTemplate()`);
    await tick();
    assert.deepEqual(await js(`(()=>{const top=statementFixture.top();const buttons=[...top.querySelectorAll('.dialog-actions button')];
      return {title:top.querySelector('.dialog-title').firstChild.textContent,file:top.querySelector('[data-role="template-import-file"]').value,
        buttons:buttons.map(button=>button.textContent),primary:buttons.map(button=>button.classList.contains('primary-btn')),
        rightAligned:top.querySelector('.dialog-actions').classList.contains('right'),focused:document.activeElement?.dataset.field||''};})()`),
      { title: '导入模板', file: '样本.xlsx', buttons: ['取消', '确认'], primary: [false, true], rightAligned: true, focused: 'bankName' });
    await js(`{const top=statementFixture.top();const bank=top.querySelector('[data-field="bankName"]');
      bank.value='meta-中文comp!';bank.dispatchEvent(new InputEvent('input',{bubbles:true}));
      const region=top.querySelector('[data-field="region"]');region.value='ＳＧ';region.dispatchEvent(new InputEvent('input',{bubbles:true}));}void 0;`);
    assert.deepEqual(await js(`({bank:statementFixture.top().querySelector('[data-field="bankName"]').value,region:statementFixture.top().querySelector('[data-field="region"]').value})`),
      { bank: 'metacomp', region: '' }, '中文、「-」、符号与全角字母即时去掉');
    await js(`statementFixture.top().querySelector('[data-action="confirm"]').click()`);
    await tick();
    assert.match(await js(`statementFixture.top().textContent`), /请填写地区/);
    assert.equal(await js(`statementFixture.calls.filter(call=>call.name==='templateImport').length`), 0);
    await js(`statementFixture.host.closeTop();void 0;`);
    await tick();

    await js(`{const f=statementFixture;const region=f.top().querySelector('[data-field="region"]');region.value='sg';region.dispatchEvent(new InputEvent('input',{bubbles:true}));
      f.pending=f.defer();f.next.templateImport=f.pending;f.top().querySelector('[data-action="confirm"]').click();}void 0;`);
    assert.deepEqual(await js(`({disabled:statementFixture.top().querySelector('[data-action="confirm"]').disabled,closed:statementFixture.host.getTop().close().status})`),
      { disabled: true, closed: 'blocked' }, '提交期间锁定');
    await js(`statementFixture.pending.resolve({status:'error',errorCode:'TEMPLATE_NAME_DUPLICATED',message:'已有同名模板「METACOMP-SG」'});void 0;`);
    await tick(); await tick();
    assert.deepEqual(await js(`({count:statementFixture.root.childElementCount,alert:statementFixture.top().textContent.includes('已有同名模板「METACOMP-SG」'),
      args:statementFixture.calls.find(call=>call.name==='templateImport').args[0]})`),
      { count: 2, alert: true, args: { importToken: 'tok-1', bankName: 'metacomp', region: 'sg' } }, '重名时弹框保留并提示');
    await js(`statementFixture.host.closeTop();void 0;`);
    await tick();
    await js(`{const f=statementFixture;const region=f.top().querySelector('[data-field="region"]');region.value='hk';region.dispatchEvent(new InputEvent('input',{bubbles:true}));
      f.next.templateImport={status:'success',message:'已导入模板「METACOMP-HK」，请在模板管理中维护映射关系'};f.top().querySelector('[data-action="confirm"]').click();}void 0;`);
    await tick(); await tick();
    assert.deepEqual(await js(`({count:statementFixture.root.childElementCount,text:statementFixture.text(),
      refreshed:statementFixture.calls.some(call=>call.name==='templatesList'),discards:statementFixture.calls.filter(call=>call.name==='discardImport').length})`),
      { count: 0, text: '已导入模板「METACOMP-HK」，请在模板管理中维护映射关系', refreshed: true, discards: 0 });
    assert.deepEqual(await js('statementFixture.errors'), []);
  });

  await test('导入模板：取消、× 与非名称类失败都会丢弃待确认文件，Enter 等同确认', async () => {
    await setup();
    await js(`statementFixture.next.prepareImport={status:'ready',importToken:'tok-cancel',sourceFileName:'a.xlsx'};statementFixture.controller.commands.importTemplate()`);
    await tick();
    await js(`statementFixture.top().querySelector('[data-action="cancel"]').click()`);
    await tick();
    await js(`statementFixture.next.prepareImport={status:'ready',importToken:'tok-x',sourceFileName:'b.xlsx'};statementFixture.controller.commands.importTemplate()`);
    await tick();
    await js(`statementFixture.top().querySelector('.icon-close').click()`);
    await tick();
    await js(`statementFixture.next.prepareImport={status:'ready',importToken:'tok-fail',sourceFileName:'c.xlsx'};statementFixture.controller.commands.importTemplate()`);
    await tick();
    // 输入法组合期间不过滤（否则打断拼音输入），组合结束后去掉中文。
    assert.deepEqual(await js(`(()=>{const input=statementFixture.top().querySelector('[data-field="bankName"]');
      input.value='db中';input.dispatchEvent(new InputEvent('input',{bubbles:true,isComposing:true}));const composing=input.value;
      input.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'中'}));return {composing,ended:input.value};})()`),
      { composing: 'db中', ended: 'db' });
    await js(`{const f=statementFixture;const top=f.top();for(const [field,value] of [['bankName','dbs'],['region','sg']]){const input=top.querySelector('[data-field="'+field+'"]');input.value=value;input.dispatchEvent(new InputEvent('input',{bubbles:true}));}
      f.next.templateImport={status:'error',message:'模板文件在确认期间已变化，请重新点击【导入模板】选择文件',errorReportReady:true};
      top.querySelector('[data-field="region"]').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));}void 0;`);
    await tick(); await tick();
    assert.deepEqual(await js(`({count:statementFixture.root.childElementCount,text:statementFixture.text(),
      discards:statementFixture.calls.filter(call=>call.name==='discardImport').map(call=>call.args[0]),
      imports:statementFixture.calls.filter(call=>call.name==='templateImport').map(call=>call.args[0].importToken)})`),
      { count: 0, text: '模板文件在确认期间已变化，请重新点击【导入模板】选择文件', discards: ['tok-cancel', 'tok-x', 'tok-fail'], imports: ['tok-fail'] });
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
    // v3.2.19：重复账单过滤发现重复 → 打开真实的重复账单提醒
    await setup();
    await js(`statementFixture.next.import={status:'duplicate-review',contextId:'fixture-review',reviewKind:'file-import',totalGroups:1,droppedRowCount:1,truncated:false,
      groups:[{seq:1,accountLabel:'FIXTURE（USD）',billDate:'2026-08-01',rows:[{fileName:'fixture.xlsx',sourceRowNumber:2,kept:true},{fileName:'fixture.xlsx',sourceRowNumber:3,kept:false}]}]};
      statementFixture.controller.commands.importFile()`); await tick();
    assert.equal(await js(`!!document.querySelector('.duplicate-rows-review-card')`), true);
    assert.match(await js(`statementFixture.top().textContent`), /重复账单提醒[\s\S]*fixture.xlsx[\s\S]*FIXTURE（USD）/);
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
    // v3.2.18：导出明细只导出当前批次，直接另存（不弹范围选择）。
    await js(`statementFixture.next.detail={status:'success',message:'当前批次明细已导出'};statementFixture.controller.commands.exportDetail()`); await tick();
    assert.deepEqual(await js(`statementFixture.calls.filter(call=>call.name==='detail').map(call=>call.args)`), [['current']]);
    assert.equal(await js(`Boolean(document.querySelector('.export-scope-card'))`), false);
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
  await test('导出余额范围公共工厂准确传 current/all；导出明细固定 current 不弹范围；错误报告成功后仍可再次导出', async () => {
    await setup(); await js(`statementFixture.controller.commands.importFile()`);
    await js(`statementFixture.next.balance={status:'select-export-scope'};statementFixture.controller.commands.exportBalance()`); await tick();
    assert.deepEqual(await js(`Array.from(statementFixture.top().querySelectorAll('.dialog-actions [data-scope]')).map(button=>[button.dataset.scope,button.textContent])`),
      [['current','导出当前批次文件的余额'],['all','导出所有批次文件的余额']]);
    await js(`statementFixture.top().querySelector('[data-scope="all"]').click()`); await tick();
    assert.deepEqual(await js(`statementFixture.calls.filter(call=>call.name==='balance').map(call=>call.args[0]??null)`), [null,'all']);
    assert.equal(await js('statementFixture.text()'), '余额已导出');
    await js(`statementFixture.controller.commands.exportDetail()`); await tick();
    assert.deepEqual(await js(`statementFixture.calls.filter(call=>call.name==='detail').map(call=>call.args[0])`), ['current']);
    assert.equal(await js(`statementFixture.root.childElementCount`), 0);
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
  // v3.2.21：渠道同一账户命中余额方式不同的子模板时整批阻断：导入、未开始的拒绝（完成大账号选择时发现）与「导出全部」都逐账户列出
  await test('渠道同一账户命中不同余额方式时，导入、未开始的拒绝与导出都列出逐账户明细', async () => {
    await setup();
    const message = '渠道「招商银行-上海」下同一账户命中了余额方式不同的子模板，无法生成余额，请在映射关系管理中统一这些子模板的余额方式后整批重新导入';
    const lines = ['账户 M201（USD）：CMB-SH（取账单余额列）、招商银行-上海（通过发生额计算）'];
    const result = (extra) => JSON.stringify({ status: 'error', message, errorCode: 'CHANNEL_BALANCE_MODE_MISMATCH', detailLines: lines, errorReportReady: false, ...extra });
    await js(`statementFixture.next.import=${result({})};statementFixture.controller.commands.importFile()`); await tick();
    assert.deepEqual(await js('statementFixture.alerts'), [`${message}\n${lines[0]}`]);
    await js(`statementFixture.next.import=${result({ preservesSession: true })};statementFixture.controller.commands.importFile()`); await tick();
    assert.match(await js('statementFixture.top().textContent'), /账户 M201（USD）：CMB-SH（取账单余额列）/);
    await js(`statementFixture.host.closeTop();`); await tick();
    await js(`statementFixture.next.balance=${result({})};statementFixture.controller.commands.exportBalance()`); await tick();
    assert.deepEqual(await js('statementFixture.alerts.slice(1)'), [`${message}\n${lines[0]}`]);
    // 出余额的子模板有交易缺账单日期或 MerchantId：同样逐行列出
    const missing = { status: 'error', errorCode: 'CHANNEL_BALANCE_ROWS_INCOMPLETE', message: '渠道「招商银行-上海」出余额的子模板有交易缺少账单日期或 MerchantId', detailLines: ['文件「b.xlsx」（子模板「CMB-SH」）第2行：缺少 MerchantId（账单日期：2026-09-01）'], errorReportReady: false };
    await js(`statementFixture.next.balance=${JSON.stringify(missing)};statementFixture.controller.commands.exportBalance()`); await tick();
    assert.deepEqual(await js('statementFixture.alerts.slice(2)'), [`${missing.message}\n${missing.detailLines[0]}`]);
    // 离开账单页期间导入失败返回：回到本页时仍弹窗列出明细
    await js(`statementFixture.pending=statementFixture.defer();statementFixture.next.import=statementFixture.pending;
      statementFixture.controller.commands.importFile();statementFixture.controller.leave();`); await tick();
    await js(`statementFixture.pending.resolve(${JSON.stringify({ ...missing, errorReportReady: true })});`); await tick();
    assert.equal(await js('statementFixture.alerts.length'), 3, '离页期间不弹窗');
    await js(`statementFixture.controller.enter();`); await tick();
    assert.deepEqual(await js('statementFixture.alerts.slice(3)'), [`${missing.message}\n${missing.detailLines[0]}`]);
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
  // v3.2.22 B113（Codex 第六轮）：装配失败（如记录含无法写入 Excel 的字符）→ 关闭弹窗 → 点击状态框导出报错文件
  await test('月度装配失败后状态框可导出报错文件', async () => {
    await setup(); await openMonthly();
    await js(`statementFixture.next.assemble={status:'error',message:'第 3 行「银行账号」列的值含无法写入 Excel 的字符',detailLines:['第 3 行「银行账号」列'],errorCode:'FILE_READ',errorReportReady:true};statementFixture.top().querySelector('[data-action="done"]').click();`);
    await tick(); await tick();
    assert.match(await js('statementFixture.text()'), /含无法写入 Excel 的字符/);
    await js(`while(statementFixture.host.getTop())statementFixture.host.getTop().dispose();`);
    await js(`statementFixture.controller.commands.exportError();void 0;`); await tick();
    assert.equal(await js(`statementFixture.calls.filter(call=>call.name==='error').length`), 1);
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
  await test('上一批待补录余额时，迟到的重复账单提醒不丢补录入口；继续时恢复原反馈，取消后仍可点击状态框补录', async () => {
    await setup();
    await js(`statementFixture.next.import={status:'manual-balance-required',message:'需要上一账单余额',manualBalancePromptReady:true,manualBalancePrompt:{merchantId:'FIXTURE',currency:'USD',targetBillDate:'2026-08-01'},detailReady:false,balanceReady:false};statementFixture.controller.commands.importFile();`); await tick();
    await js(`statementFixture.host.closeTop();`); await tick();
    await js(`statementFixture.pending=statementFixture.defer();statementFixture.next.import=statementFixture.pending;
      statementFixture.controller.commands.importFile();statementFixture.controller.leave();statementFixture.controller.enter();
      statementFixture.pending.resolve({status:'duplicate-review',contextId:'late-review',reviewKind:'file-import',totalGroups:1,droppedRowCount:1,truncated:false,
        groups:[{seq:1,accountLabel:'FIXTURE（USD）',billDate:'2026-08-01',rows:[{fileName:'fixture.xlsx',sourceRowNumber:2,kept:true},{fileName:'fixture.xlsx',sourceRowNumber:3,kept:false}]}]});`);
    await tick();
    assert.match(await js('statementFixture.text()'), /导入等待确认/);
    // 等待确认期间补录入口仍在
    await js(`document.getElementById('statusBox').click()`); await tick();
    assert.match(await js(`statementFixture.top().textContent`), /FIXTURE/);
    await js(`statementFixture.host.closeTop();`); await tick();
    // 继续：恢复上一批的反馈，再打开重复账单提醒
    await js(`statementFixture.controller.commands.importFile()`); await tick();
    assert.equal(await js(`!!document.querySelector('.duplicate-rows-review-card')`), true);
    assert.equal(await js('statementFixture.text()'), '需要上一账单余额');
    await js(`statementFixture.top().querySelector('[data-action=cancel]').click()`); await tick();
    assert.deepEqual(await js(`statementFixture.calls.filter(call=>call.name==='cancelAccount').map(call=>call.args[0])`), ['late-review']);
    assert.equal(await js('statementFixture.text()'), '需要上一账单余额');
    await js(`document.getElementById('statusBox').click()`); await tick();
    assert.match(await js(`statementFixture.top().textContent`), /FIXTURE/);
    assert.equal(await js(`statementFixture.calls.filter(call=>call.name==='import').length`), 2);

    // 等待期间状态框已有新反馈（如完成了补录）：继续时保留新反馈，不回放等待前的旧提示
    await js(`statementFixture.host.closeTop();`); await tick();
    await js(`statementFixture.pending=statementFixture.defer();statementFixture.next.import=statementFixture.pending;
      statementFixture.controller.commands.importFile();statementFixture.controller.leave();statementFixture.controller.enter();
      statementFixture.pending.resolve({status:'duplicate-review',contextId:'late-review-2',reviewKind:'file-import',totalGroups:1,droppedRowCount:1,truncated:false,
        groups:[{seq:1,accountLabel:'FIXTURE（USD）',billDate:'2026-08-01',rows:[{fileName:'fixture.xlsx',sourceRowNumber:2,kept:true},{fileName:'fixture.xlsx',sourceRowNumber:3,kept:false}]}]});`);
    await tick();
    assert.match(await js('statementFixture.text()'), /导入等待确认/);
    await js(`statementFixture.controller.createFeedbackScope().setStatus('上一账单日余额已补录','success');void 0;`);
    await js(`statementFixture.controller.commands.importFile()`); await tick();
    assert.equal(await js(`!!document.querySelector('.duplicate-rows-review-card')`), true);
    assert.equal(await js('statementFixture.text()'), '上一账单日余额已补录');
  });
  await test('重复账单提醒被正在提交的弹窗阻止打开时保留结果：提示等待确认，再点「导入文件」打开原提醒且不重新导入', async () => {
    await setup();
    await js(`{const fx=statementFixture;fx.busy=true;const overlay=fx.modal('提交中的窗口');fx.bridge.registerModal(overlay,{canClose:()=>!fx.busy});
      fx.bridge.openModal(()=>overlay,{owner:'statement-generator'});
      fx.next.import={status:'duplicate-review',contextId:'blocked-review',reviewKind:'file-import',totalGroups:1,droppedRowCount:1,truncated:false,
        groups:[{seq:1,accountLabel:'FIXTURE（USD）',billDate:'2026-08-01',rows:[{fileName:'fixture.xlsx',sourceRowNumber:2,kept:true},{fileName:'fixture.xlsx',sourceRowNumber:3,kept:false}]}]};
      fx.controller.commands.importFile();}void 0;`); await tick();
    assert.equal(await js(`!!document.querySelector('.duplicate-rows-review-card')`), false);
    assert.match(await js('statementFixture.text()'), /导入等待确认/);
    assert.deepEqual(await js(`statementFixture.calls.filter(call=>call.name==='cancelAccount').length`), 0, '不释放主进程上下文');
    await js(`statementFixture.busy=false;statementFixture.host.closeTop();`); await tick();
    await js(`statementFixture.controller.commands.importFile()`); await tick();
    assert.equal(await js(`!!document.querySelector('.duplicate-rows-review-card')`), true);
    assert.equal(await js(`statementFixture.calls.filter(call=>call.name==='import').length`), 1);
  });
  await test('大账号顺序不匹配的提示被正在提交的弹窗阻止打开时保留结果：提示等待确认，再点「导入文件」打开原提示且不重新导入', async () => {
    await setup();
    await js(`{const fx=statementFixture;fx.busy=true;const overlay=fx.modal('提交中的窗口');fx.bridge.registerModal(overlay,{canClose:()=>!fx.busy});
      fx.bridge.openModal(()=>overlay,{owner:'statement-generator'});
      fx.next.import={status:'remember-order-mismatch',contextId:'order-context',failedFileNames:['fixture.xlsx'],rows:[],rowsWithEmptyBlocks:[],expandedBigAccountOptions:[]};
      fx.controller.commands.importFile();}void 0;`); await tick();
    assert.match(await js('statementFixture.text()'), /导入等待确认/);
    await js(`statementFixture.busy=false;statementFixture.host.closeTop();`); await tick();
    await js(`statementFixture.controller.commands.importFile()`); await tick();
    assert.match(await js('statementFixture.top().textContent'), /fixture\.xlsx的账户个数或账户号匹配不上/);
    assert.equal(await js(`statementFixture.calls.filter(call=>call.name==='import').length`), 1, '不重新导入');
  });
  await test('待继续的导入确认与导出选择分别保存：离页期间的导出选择不覆盖待确认的重复账单提醒', async () => {
    await setup();
    await js(`statementFixture.pending=statementFixture.defer();statementFixture.next.import=statementFixture.pending;
      statementFixture.controller.commands.importFile();statementFixture.controller.leave();statementFixture.controller.enter();
      statementFixture.pending.resolve({status:'duplicate-review',contextId:'kept-review',reviewKind:'file-import',totalGroups:1,droppedRowCount:1,truncated:false,
        groups:[{seq:1,accountLabel:'FIXTURE（USD）',billDate:'2026-08-01',rows:[{fileName:'fixture.xlsx',sourceRowNumber:2,kept:true},{fileName:'fixture.xlsx',sourceRowNumber:3,kept:false}]}]});`);
    await tick();
    await js(`statementFixture.pending=statementFixture.defer();statementFixture.next.balance=statementFixture.pending;
      statementFixture.controller.commands.exportBalance();statementFixture.controller.leave();statementFixture.controller.enter();
      statementFixture.pending.resolve({status:'select-export-scope'});`);
    await tick();
    await js(`statementFixture.controller.commands.importFile()`); await tick();
    assert.equal(await js(`!!document.querySelector('.duplicate-rows-review-card')`), true);
    assert.equal(await js(`statementFixture.calls.filter(call=>call.name==='import').length`), 1, '不重新导入');
  });
  await test('未开始导入的拒绝（只覆盖跨文件去重的一端）：只弹提示，不改状态框与导出按钮，上一批补录入口仍可用', async () => {
    await setup();
    await js(`statementFixture.next.import={status:'manual-balance-required',message:'需要上一账单余额',manualBalancePromptReady:true,manualBalancePrompt:{merchantId:'FIXTURE',currency:'USD',targetBillDate:'2026-08-01'},detailReady:true,balanceReady:false};statementFixture.controller.commands.importFile();`); await tick();
    await js(`statementFixture.host.closeTop();`); await tick();
    const before = await js(`({text:statementFixture.text(),detail:document.getElementById('exportDetailBtn').disabled})`);
    await js(`statementFixture.next.import={status:'error',message:'上次导入时「a.xlsx」、「b.xlsx」之间去除过重复账单，只覆盖其中一部分会让交易丢失或重复入账，请把「a.xlsx」、「b.xlsx」一起重新导入',errorCode:'DUPLICATE_KEEPER_REPLACEMENT',preservesSession:true,errorReportReady:false};
      statementFixture.controller.commands.importFile();`); await tick();
    assert.match(await js('statementFixture.top().textContent'), /只覆盖其中一部分会让交易丢失或重复入账/);
    assert.deepEqual(await js(`({text:statementFixture.text(),detail:document.getElementById('exportDetailBtn').disabled})`), before);
    await js(`statementFixture.host.closeTop();`); await tick();
    await js(`document.getElementById('statusBox').click()`); await tick();
    assert.match(await js(`statementFixture.top().textContent`), /FIXTURE/);
  });
  await test('未开始导入的拒绝在弹窗宿主忙时保留：提示点击「导入文件」查看原因，再点时弹出原提示且不重新导入', async () => {
    await setup();
    await js(`statementFixture.controller.createFeedbackScope().setStatus('上一批已生成','success');void 0;`);
    await js(`{const fx=statementFixture;fx.busy=true;const overlay=fx.modal('提交中的窗口');fx.bridge.registerModal(overlay,{canClose:()=>!fx.busy});
      fx.bridge.openModal(()=>overlay,{owner:'statement-generator'});
      fx.next.import={status:'error',message:'请把「a.xlsx」、「b.xlsx」一起重新导入',errorCode:'DUPLICATE_KEEPER_REPLACEMENT',preservesSession:true,errorReportReady:false};
      fx.controller.commands.importFile();}void 0;`); await tick();
    assert.doesNotMatch(await js(`statementFixture.root.textContent`), /一起重新导入/);
    assert.match(await js('statementFixture.text()'), /本次导入未开始，请点击“导入文件”查看原因/);
    await js(`statementFixture.busy=false;statementFixture.host.closeTop();`); await tick();
    await js(`statementFixture.controller.commands.importFile()`); await tick();
    assert.match(await js('statementFixture.top().textContent'), /一起重新导入/);
    assert.equal(await js('statementFixture.text()'), '上一批已生成', '恢复原反馈');
    assert.equal(await js(`statementFixture.calls.filter(call=>call.name==='import').length`), 1, '不重新导入');
  });
  await test('离页期间返回的未开始导入拒绝：状态框只显示不含文件名的提示（状态框写入日志），再点「导入文件」弹出原提示且不重新导入', async () => {
    await setup();
    await js(`statementFixture.controller.createFeedbackScope().setStatus('上一批已生成','success');void 0;`);
    await js(`statementFixture.pending=statementFixture.defer();statementFixture.next.import=statementFixture.pending;
      statementFixture.controller.commands.importFile();statementFixture.controller.leave();statementFixture.controller.enter();
      statementFixture.pending.resolve({status:'error',message:'请把「a-6222.xlsx」、「b-6222.xlsx」一起重新导入',errorCode:'DUPLICATE_KEEPER_REPLACEMENT',preservesSession:true,errorReportReady:false});`);
    await tick();
    assert.match(await js('statementFixture.text()'), /本次导入未开始，请点击“导入文件”查看原因/);
    assert.equal(await js(`statementFixture.feedback.some(item=>/6222/.test(item.message))`), false, '状态框（会写入日志）不含文件名');
    await js(`statementFixture.controller.commands.importFile()`); await tick();
    assert.match(await js('statementFixture.top().textContent'), /a-6222\.xlsx/);
    assert.equal(await js('statementFixture.text()'), '上一批已生成');
    assert.equal(await js(`statementFixture.calls.filter(call=>call.name==='import').length`), 1, '不重新导入');
  });
  await test('两项等待操作先后继续：仍有效的等待提示保留，最后恢复的是等待前的原反馈，不回放已失效的导入提示', async () => {
    await setup();
    await js(`statementFixture.controller.createFeedbackScope().setStatus('上一批已生成','success');void 0;`);
    await js(`statementFixture.pending=statementFixture.defer();statementFixture.next.import=statementFixture.pending;
      statementFixture.controller.commands.importFile();statementFixture.controller.leave();statementFixture.controller.enter();
      statementFixture.pending.resolve({status:'duplicate-review',contextId:'two-review',reviewKind:'file-import',totalGroups:1,droppedRowCount:1,truncated:false,
        groups:[{seq:1,accountLabel:'FIXTURE（USD）',billDate:'2026-08-01',rows:[{fileName:'fixture.xlsx',sourceRowNumber:2,kept:true},{fileName:'fixture.xlsx',sourceRowNumber:3,kept:false}]}]});`);
    await tick();
    await js(`statementFixture.pending=statementFixture.defer();statementFixture.next.balance=statementFixture.pending;
      statementFixture.controller.commands.exportBalance();statementFixture.controller.leave();statementFixture.controller.enter();
      statementFixture.pending.resolve({status:'select-export-scope'});`);
    await tick();
    assert.match(await js('statementFixture.text()'), /导出等待选择/);
    // 继续并取消导入：导出仍在等待，保留导出的等待提示
    await js(`statementFixture.controller.commands.importFile()`); await tick();
    await js(`statementFixture.top().querySelector('[data-action=cancel]').click()`); await tick();
    assert.match(await js('statementFixture.text()'), /导出等待选择/);
    // 继续导出：恢复等待前的原反馈（不是「导入等待确认」）
    await js(`statementFixture.controller.commands.exportBalance()`); await tick();
    assert.equal(await js('statementFixture.text()'), '上一批已生成');
  });
  await test('两项等待操作先继续较晚的一项：状态框换成另一项仍有效的等待提示，最后才恢复原反馈', async () => {
    await setup();
    await js(`statementFixture.controller.createFeedbackScope().setStatus('上一批已生成','success');void 0;`);
    await js(`statementFixture.pending=statementFixture.defer();statementFixture.next.import=statementFixture.pending;
      statementFixture.controller.commands.importFile();statementFixture.controller.leave();statementFixture.controller.enter();
      statementFixture.pending.resolve({status:'duplicate-review',contextId:'order-review',reviewKind:'file-import',totalGroups:1,droppedRowCount:1,truncated:false,
        groups:[{seq:1,accountLabel:'FIXTURE（USD）',billDate:'2026-08-01',rows:[{fileName:'fixture.xlsx',sourceRowNumber:2,kept:true},{fileName:'fixture.xlsx',sourceRowNumber:3,kept:false}]}]});`);
    await tick();
    await js(`statementFixture.pending=statementFixture.defer();statementFixture.next.balance=statementFixture.pending;
      statementFixture.controller.commands.exportBalance();statementFixture.controller.leave();statementFixture.controller.enter();
      statementFixture.pending.resolve({status:'select-export-scope'});`);
    await tick();
    // 先继续导出并关闭选择：导入仍在等待，状态框显示导入的等待提示
    await js(`statementFixture.controller.commands.exportBalance()`); await tick();
    assert.match(await js('statementFixture.text()'), /导入等待确认/);
    await js(`statementFixture.host.closeTop();`); await tick();
    assert.match(await js('statementFixture.text()'), /导入等待确认/);
    // 再继续导入：没有其他待办，恢复原反馈
    await js(`statementFixture.controller.commands.importFile()`); await tick();
    assert.equal(await js('statementFixture.text()'), '上一批已生成');
    assert.equal(await js(`!!document.querySelector('.duplicate-rows-review-card')`), true);
  });
  await test('两项等待之间已有新反馈（如完成了补录）：先继续较晚的一项后，剩余一项继续时恢复的是新反馈，不回放已完成的补录提示', async () => {
    await setup();
    await js(`statementFixture.next.import={status:'manual-balance-required',message:'需要上一账单余额',manualBalancePromptReady:true,manualBalancePrompt:{merchantId:'FIXTURE',currency:'USD',targetBillDate:'2026-08-01'},detailReady:false,balanceReady:false};statementFixture.controller.commands.importFile();`); await tick();
    await js(`statementFixture.host.closeTop();`); await tick();
    await js(`statementFixture.pending=statementFixture.defer();statementFixture.next.import=statementFixture.pending;
      statementFixture.controller.commands.importFile();statementFixture.controller.leave();statementFixture.controller.enter();
      statementFixture.pending.resolve({status:'duplicate-review',contextId:'stale-review',reviewKind:'file-import',totalGroups:1,droppedRowCount:1,truncated:false,
        groups:[{seq:1,accountLabel:'FIXTURE（USD）',billDate:'2026-08-01',rows:[{fileName:'fixture.xlsx',sourceRowNumber:2,kept:true},{fileName:'fixture.xlsx',sourceRowNumber:3,kept:false}]}]});`);
    await tick();
    assert.match(await js('statementFixture.text()'), /导入等待确认/);
    // 等待期间完成了上一批的补录
    await js(`statementFixture.controller.createFeedbackScope().setStatus('上一账单日余额已补录','success');void 0;`);
    await js(`statementFixture.pending=statementFixture.defer();statementFixture.next.balance=statementFixture.pending;
      statementFixture.controller.commands.exportBalance();statementFixture.controller.leave();statementFixture.controller.enter();
      statementFixture.pending.resolve({status:'select-export-scope'});`);
    await tick();
    assert.match(await js('statementFixture.text()'), /导出等待选择/);
    await js(`statementFixture.controller.commands.exportBalance()`); await tick();
    assert.match(await js('statementFixture.text()'), /导入等待确认/);
    await js(`statementFixture.host.closeTop();`); await tick();
    await js(`statementFixture.controller.commands.importFile()`); await tick();
    assert.equal(await js('statementFixture.text()'), '上一账单日余额已补录');
    assert.equal(await js(`!!document.querySelector('.duplicate-rows-review-card')`), true);
  });
  await test('导出范围忙碌时拒绝双击及关闭，最终销毁后的旧回应不接管新窗口', async () => {
    await setup();
    await js(`statementFixture.next.balance={status:'select-export-scope'};statementFixture.controller.commands.exportBalance()`);
    await js(`statementFixture.pending=statementFixture.defer();statementFixture.next.balance=statementFixture.pending;
      statementFixture.top().querySelector('[data-scope="all"]').click();statementFixture.top().querySelector('[data-scope="current"]').click();`);
    assert.equal(await js(`statementFixture.calls.filter(call=>call.name==='balance').length`), 2);
    assert.equal(await js(`statementFixture.host.getTop().close().status`), 'blocked');
    // 右上角 × 同样被导出中的 canClose 拦截
    await js(`statementFixture.top().querySelector('.export-scope-close').click()`);
    assert.equal(await js(`Boolean(statementFixture.top()?.querySelector('.export-scope-card'))`), true);
    await js(`statementFixture.host.getTop().dispose();statementFixture.bridge.openModal(()=>statementFixture.modal('保留新窗口'),{owner:'new'});
      statementFixture.pending.resolve({status:'select-export-scope'});`);
    await tick();
    assert.match(await js(`statementFixture.root.textContent`), /保留新窗口/);
  });
  // v3.2.18：导出余额范围弹窗右上角 ×：空闲时关闭不导出、不改状态栏；导出中不能关闭，结束后按结果关闭。
  await test('导出余额范围弹窗 × 关闭：空闲关闭不导出，导出进行中不能关闭', async () => {
    await setup(); await js(`statementFixture.controller.commands.importFile()`); await tick();
    const before = await js('statementFixture.text()');
    await js(`statementFixture.next.balance={status:'select-export-scope'};statementFixture.controller.commands.exportBalance()`); await tick();
    assert.deepEqual(await js(`{const close=statementFixture.top().querySelector('.export-scope-close');[close.title,close.getAttribute('aria-label'),close.textContent];}`), ['关闭','关闭','×']);
    assert.equal(await js(`document.activeElement?.dataset.scope`), 'current');
    await js(`statementFixture.top().querySelector('.export-scope-close').click()`); await tick();
    assert.equal(await js(`statementFixture.root.childElementCount`), 0);
    assert.equal(await js(`statementFixture.calls.filter(call=>call.name==='balance').length`), 1);
    assert.equal(await js('statementFixture.text()'), before);
    await js(`statementFixture.next.balance={status:'select-export-scope'};statementFixture.controller.commands.exportBalance()`); await tick();
    await js(`statementFixture.pending=statementFixture.defer();statementFixture.next.balance=statementFixture.pending;statementFixture.top().querySelector('[data-scope="current"]').click();
      statementFixture.top().querySelector('.export-scope-close').click();`); await tick();
    assert.equal(await js(`Boolean(statementFixture.top()?.querySelector('.export-scope-card'))`), true);
    await js(`statementFixture.pending.resolve({status:'success',message:'当前批次余额已导出'})`); await tick();
    assert.equal(await js(`statementFixture.root.childElementCount`), 0);
    assert.equal(await js('statementFixture.text()'), '当前批次余额已导出');
    assert.deepEqual(await js(`statementFixture.calls.filter(call=>call.name==='balance').map(call=>call.args[0]??null)`), [null,null,'current']);
  });
  // v3.2.18：范围弹窗版式（生产样式）：提示文字与图标中线对齐；两个按钮同行居中、按文字收紧，当前批次在左；× 在右上角。
  for (const theme of ['light', 'dark']) await test(`导出余额范围弹窗版式（${theme}）`, async () => {
    await setup({ width: 1080, height: 760, theme });
    await js(`statementFixture.next.balance={status:'select-export-scope'};statementFixture.controller.commands.exportBalance()`); await tick();
    await layout.settle();
    const metrics = await js(`(() => {
      const card=document.querySelector('.export-scope-card'), rect=element=>element.getBoundingClientRect();
      const icon=rect(card.querySelector('.alert-icon')), message=rect(card.querySelector('.alert-message'));
      const footer=rect(card.querySelector('.dialog-actions')), close=rect(card.querySelector('.export-scope-close')), box=rect(card);
      const [current,all]=['current','all'].map(scope=>rect(card.querySelector('[data-scope="'+scope+'"]')));
      const lineHeight=parseFloat(getComputedStyle(card.querySelector('[data-scope="current"]')).lineHeight)||20;
      return { iconCenter: icon.top+icon.height/2, messageCenter: message.top+message.height/2,
        sameRow: Math.abs(current.top-all.top), currentLeft: current.left<all.left,
        pairOffset: Math.abs((current.left+all.right)/2-(footer.left+footer.width/2)),
        narrow: current.width<footer.width/2 && all.width<footer.width/2,
        singleLine: current.height<=lineHeight*2 && all.height<=lineHeight*2,
        closeInset: [box.right-close.right, close.top-box.top], closeAboveMessage: close.bottom<=message.top+message.height };
    })()`);
    assert.ok(Math.abs(metrics.iconCenter - metrics.messageCenter) <= 1, JSON.stringify(metrics));
    assert.ok(metrics.sameRow <= 1 && metrics.currentLeft && metrics.pairOffset <= 1, JSON.stringify(metrics));
    assert.ok(metrics.narrow && metrics.singleLine, JSON.stringify(metrics));
    assert.ok(metrics.closeInset.every(value => value >= 0 && value <= 16), JSON.stringify(metrics));
    await layout.evidence(`export-scope-balance-${theme}`, metrics);
  });
};
