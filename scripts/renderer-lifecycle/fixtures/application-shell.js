'use strict';
// Renderer 装配证据：使用实际 DOM、Preload 公开表面和 classic 脚本顺序。
// Main、ArchiveCenter 激活恢复、真实文件及平台验收不在此 fixture 内。
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const espree = require('espree');
module.exports = async ({ js, load, reset, assert, test }) => {
  const root = path.resolve(__dirname, '../../..');
  const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const renderer = fs.readFileSync(path.join(root, 'src/renderer.js'), 'utf8');
  const ast = espree.parse(renderer, { ecmaVersion: 'latest', range: true });
  const declaration = ast.body.flatMap(node => node.declarations || []).find(node => node.id.name === 'MODULES');
  const modules = vm.runInNewContext('(' + renderer.slice(...declaration.init.arguments[0].range) + ')');
  const moduleIds = Object.values(modules).map(item => item.id);
  const scripts = [...index.matchAll(/<script\b[^>]*\bsrc="\.\/([^"]+)"[^>]*><\/script>/g)].map(match => match[1]);
  const body = index.match(/<body[^>]*>([\s\S]*)<\/body>/i)[1].replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '');
  const preload = fs.readFileSync(path.join(root, 'src/preload.js'), 'utf8');
  async function setup() {
    await reset(body);
    await js(`
      window.shellErrors=[]; window.shellWarnings=[]; window.shellCalls=[]; window.shellSends=[];
      window.shellSubscriptions=new Map(); window.shellRemoved=[];
      window.addEventListener('error',event=>shellErrors.push(String(event.error?.stack||event.message)));
      window.addEventListener('unhandledrejection',event=>shellErrors.push(String(event.reason?.stack||event.reason)));
      console.error=(...args)=>shellErrors.push(args.map(value=>String(value?.stack||value)).join(' '));
      console.warn=(...args)=>shellWarnings.push(args.map(value=>String(value?.stack||value)).join(' '));
      window.shellResponses={
        'app:get-info':{version:'3.2.9-fixture',previewModal:'',hasEnum:true,enumFileName:'COMMON.xlsx',currencyOptions:['USD','HKD'],accountMappingCount:0,
          currentModule:'statement-generator',enabledModules:${JSON.stringify(moduleIds)},reconIdFixBillCategory:'gateway'},
        'app-update:get-status':{status:'idle',enabled:false},
        'settings:set-current-module':{status:'success'},'settings:set-recon-id-fix-bill-category':{status:'success'},
        'template:list':[], 'account-mapping:list':[],
        'scenarios:list':{status:'ok',scenarios:[]}, 'channels:list':{status:'ok',channels:[]},
        'bank-statement:session-status':{status:'ok',hasFile:false,hasResult:false},
        'recon-id-fix:session-status':{status:'ok',hasFile:false,hasResult:false},
        'pending:rule:get':{matchFields:['ID'],compareFields:[]},'pending:months:list':[], 'pending:diff:runs-list':[],
        'pre-fund-reconciliation:session-status':{status:'ok',hasBank:false,hasMpt:false,hasResult:false},
        'bankBuRecon:run:list-ready-months':[], 'bankBuRecon:run:list-success-months':[],
        'duplicate-inbound-match:session-status':{status:'ok',hasBank:false,hasBill:false,hasResult:false},
        'vccOpCalc:balance:list-months':[],
        'acquiringBillCurrency:listMonths':[], 'acquiringBillCurrency:sessionStatus':{monthKey:null,flowReady:false,billReady:false},
        'bizOpReconV327:status':{mode:'DISABLED',recoveryReady:true},'bizOpRecon:bu:list':[],
        'position-reconciliation:status':{status:'ok',bank:{rowCount:0},canRun:false,canExport:false,pendingRun:null},
        'vccFinancialOp:run:archived-months':[], 'vccFinancialOp:run:latest-archived':null,
        'linked-table:list':{status:'ok',tables:[]},
        'pending:columns':['ID'], 'toolbox:merge':{status:'cancelled'},
        'toolbox:split:read':{status:'success',sourceFilePath:'/fixture/source.xlsx',splitReadToken:'fixture-token',headers:['Currency'],valuesByField:{Currency:['USD','HKD']},dataRowCount:8,maxRowSplitFiles:1000},
        'archive-center:get-settings':{status:'success',retentionDays:30},'archive-center:list-batches':{status:'success',batches:[]},
        'archive-center:get-stats':{status:'success',batchCount:0},'archive-center:list-delete-cleanup-jobs':[],
        'archive-center:start-entry-maintenance':{status:'success'}
      };
      window.shellInvoke=(channel,...args)=>{
        shellCalls.push({channel,args});
        if (!Object.hasOwn(shellResponses,channel)) { const error=new Error('未声明的 fixture IPC：'+channel);shellErrors.push(error.message);return Promise.reject(error); }
        const response=shellResponses[channel]; return Promise.resolve(typeof response==='function'?response(...args):structuredClone(response));
      };
      window.shellStrict=(value,path='desktopApi')=>new Proxy(value,{get(target,key){
        if(typeof key==='symbol')return target[key];
        if(!Object.hasOwn(target,key))throw new Error('未知 Preload 方法：'+path+'.'+key);
        const item=target[key];return item&&typeof item==='object'&&!Array.isArray(item)?shellStrict(item,path+'.'+key):item;
      }});
      void 0;
    `);
    // 实际 preload 只允许 require('electron')，所有 IPC 交给上面的显式替身字典。
    await js(`(function(){const process={platform:'darwin',env:{}};
      const require=name=>{if(name!=='electron')throw new Error('未声明的 Preload require：'+name);return {
        contextBridge:{exposeInMainWorld:(name,value)=>window[name]=name==='desktopApi'?shellStrict(value):value},
        ipcRenderer:{invoke:shellInvoke,send:(channel,...args)=>shellSends.push({channel,args}),
          on:(channel,listener)=>{if(!shellSubscriptions.has(channel))shellSubscriptions.set(channel,new Set());shellSubscriptions.get(channel).add(listener);},
          removeListener:(channel,listener)=>{shellSubscriptions.get(channel)?.delete(listener);shellRemoved.push(channel);}}
      };};
      ${preload}
    })(); void 0;`);
    for (const script of scripts) await load(script);
    await js(`new Promise(resolve=>setTimeout(resolve,50))`);
  }
  const flush = () => js(`new Promise(resolve=>setTimeout(resolve,10))`);
  async function clean() {
    const errors = await js(`shellErrors`);
    assert.deepEqual(errors, [], errors.join('\n'));
    const warnings = await js(`shellWarnings.filter(value=>/ReferenceError|TypeError|SyntaxError/.test(value))`);
    assert.deepEqual(warnings, [], warnings.join('\n'));
  }
  await test('应用壳按实际 index 顺序加载，初始化完整完成且 Preload 未知方法立即失败', async () => {
    await setup();
    await clean();
    assert.equal(await js(`shellSends.some(call=>call.channel==='app:report-startup-metrics')`), true,
      JSON.stringify(await js(`({calls:shellCalls,warnings:shellWarnings})`)));
    assert.deepEqual((await js(`getModuleRouter().moduleIds`)).slice().sort(), moduleIds.slice().sort());
    assert.equal(moduleIds.length, 13);
    assert.equal(await js(`(()=>{try{desktopApi.notDeclared.anything();return false;}catch(error){return /未知 Preload/.test(error.message);}})()`), true);
  });
  await test('应用壳 13 域反复导航及同模块导航不重复订阅或静态点击绑定', async () => {
    const ids = await js(`getModuleRouter().moduleIds`);
    for (const id of ids) {
      const result = await js(`(async()=>{const route=setCurrentModule(${JSON.stringify(id)},{persist:false});await route.ready;return {status:route.status,current:getModuleRouter().getCurrentModuleId()};})()`);
      assert.equal(result.current, id);
    }
    const before = await js(`Object.fromEntries([...shellSubscriptions].map(([key,value])=>[key,value.size]))`);
    for (const id of ids) await js(`(async()=>{await setCurrentModule(${JSON.stringify(id)},{persist:false}).ready;await setCurrentModule(${JSON.stringify(id)},{persist:false}).ready;})()`);
    assert.deepEqual(await js(`Object.fromEntries([...shellSubscriptions].map(([key,value])=>[key,value.size]))`), before);
    await js(`(async()=>{await setCurrentModule('pending-reconciliation',{persist:false}).ready;})()`);
    const columnsBefore = await js(`shellCalls.filter(call=>call.channel==='pending:columns').length`);
    await js(`document.getElementById('pendingRuleBtn').click();`); await flush();
    assert.equal(await js(`shellCalls.filter(call=>call.channel==='pending:columns').length`), columnsBefore + 1);
    assert.equal(await js(`document.getElementById('modalRoot').children.length`), 1);
    await js(`modalHost.closeTop(); void 0;`);
    await clean();
  });
  await test('应用壳 busy 弹窗拒绝导航，当前域/面板/持久化均保持', async () => {
    await js(`(async()=>{await setCurrentModule('statement-generator',{persist:false}).ready;window.shellBusy=modalHost.openRoot(()=>{
      const overlay=document.createElement('div');const dialog=document.createElement('section');overlay.append(dialog);return {overlay,dialog,canClose:()=>false};
    },{owner:'statement-generator'}).handle;})()`);
    const persistBefore = await js(`shellCalls.filter(call=>call.channel==='settings:set-current-module').length`);
    assert.equal(await js(`setCurrentModule('new-account-generator').status`), 'blocked');
    assert.equal(await js(`getModuleRouter().getCurrentModuleId()`), 'statement-generator');
    assert.equal(await js(`document.getElementById('statementModulePanel').hidden`), false);
    assert.equal(await js(`shellCalls.filter(call=>call.channel==='settings:set-current-module').length`), persistBefore);
    await js(`shellBusy.dispose(); void 0;`);
    await clean();
  });
  await test('应用壳菜单接通工具箱、场景管理和配置父子返回', async () => {
    await js(`document.getElementById('toolboxBtn').click();`); await flush();
    assert.equal(await js(`!!document.querySelector('.toolbox-card')`), true);
    await js(`window.shellToolbox=modalHost.getTop();document.querySelector('[data-action="split-import"]').click();`); await flush();
    assert.equal(await js(`document.getElementById('modalRoot').children.length`), 2);
    await js(`document.getElementById('modalRoot').lastElementChild.querySelector('[data-action="cancel"]').click();`); await flush();
    assert.equal(await js(`shellToolbox.isTop()`), true);
    await js(`modalHost.closeTop();document.getElementById('manageTemplateBtn').click();`); await flush();
    assert.equal(await js(`document.getElementById('modalRoot').children.length`), 1);
    assert.match(await js(`document.getElementById('modalRoot').textContent`), /模板/);
    await js(`modalHost.closeTop();`);
    await js(`(async()=>{await setCurrentModule('bank-statement-process',{persist:false}).ready;document.getElementById('bankStatementScenarioBtn').click();})()`); await flush();
    assert.match(await js(`document.getElementById('modalRoot').textContent`), /场景/);
    assert.equal(await js(`shellCalls.some(call=>call.channel==='scenarios:list')`), true);
    await js(`modalHost.closeTop(); void 0;`);
    await clean();
  });
  await test('实际大账号提取未维护错误：原上下文取消失败可重试，成功后父子整栈结束', async () => {
    await js(`(async()=>{
      await setCurrentModule('statement-generator',{persist:false}).ready;
      shellResponses['big-account-mode:load']={mode:'unfixed'};
      shellResponses['big-account-order:load']={order:null};
      shellResponses['file:extract-big-account-order']={status:'error',errorCode:'BIG_ACCOUNT_NOT_MAINTAINED',unmaintainedAccounts:[
        {merchantId:'M<002>',fileName:'<账单>.xlsx',fileOrdinal:0,blockOrdinal:1,sourceRowNumber:8},
        {merchantId:'M<002>',fileName:'另一份.xlsx',fileOrdinal:1,blockOrdinal:0,sourceRowNumber:3}]};
      window.shellCancelAttempts=0;
      shellResponses['file:cancel-big-account-selection']=()=>++shellCancelAttempts===1?{status:'error',message:'临时断开'}:{status:'not-active'};
      window.shellSelection=modalBridge.openModal(()=>createBigAccountSelectionDialog({contextId:'exact-context',templateId:'fixture-template',
        rows:[{index:0,fileIndex:0,fileName:'账单.xlsx',sourceRowNumber:1}],expandedBigAccountOptions:[{merchantId:'M001',currency:'USD'}]
      }),{owner:'statement-generator'}).handle;
    })()`); await flush();
    await js(`document.querySelector('[data-action="extract-order"]').click();`); await flush();
    assert.match(await js(`document.querySelector('.big-account-unmaintained-alert').textContent`), /M<002>.*<账单>.xlsx.*另一份.xlsx/);
    assert.equal(await js(`document.querySelector('.big-account-unmaintained-alert').querySelector('账单')===null`), true);
    assert.equal(await js(`shellSelection.close().status`), 'blocked');
    await js(`document.querySelector('.big-account-unmaintained-alert button').click();`); await flush();
    assert.match(await js(`document.querySelector('.big-account-unmaintained-alert').textContent`), /临时断开.*重试取消/);
    assert.equal(await js(`document.querySelector('[data-action="done"]').disabled`), true);
    await js(`document.querySelector('.big-account-unmaintained-alert button').click();`); await flush();
    assert.deepEqual(await js(`shellCalls.filter(call=>call.channel==='file:cancel-big-account-selection').map(call=>call.args)`), [['exact-context'],['exact-context']]);
    assert.equal(await js(`document.getElementById('modalRoot').children.length`), 0);
    assert.equal(await js(`shellCalls.some(call=>call.channel==='file:complete-big-account-selection')`), false);
    await clean();
  });

  await test('正式 VCC F1/F2：B重扫离页后不能用A确认保存，重新确认B后期初与显示来源一致', async () => {
    await js(`(async()=>{
      window.shellVccSelected='A';window.shellVccDelay=false;window.shellVccSaved=[];window.shellVccCache=null;
      shellResponses['vccOpCalc:import:pick-files']=()=>({status:'success',filePaths:['/fixture/'+shellVccSelected+'.xlsx']});
      shellResponses['vccOpCalc:import:scan']=()=>{
        const b=shellVccSelected==='B';const yearMonth=b?'2026-08':'2026-07';const amount=b?'900.00':'10.00';
        shellVccCache={yearMonth,totals:{totalOut:'0.00',totalIn:amount,totalAmount:amount,currency:'CNY'},
          perFile:[{fileName:shellVccSelected+'.xlsx',rowCount:1,totalOut:'0.00',totalIn:amount,totalAmount:amount,currency:'CNY'}]};
        const reply={status:'success',yearMonth,totalRows:1,fileCount:1};
        return shellVccDelay?new Promise(resolve=>window.shellVccFinish=()=>resolve(reply)):reply;
      };
      shellResponses['vccOpCalc:run:compute-amounts']=()=>shellVccCache?{status:'success',...structuredClone(shellVccCache)}:{status:'error',message:'无统计结果'};
      shellResponses['vccOpCalc:run:save']=({beginOp})=>{
        const saved={yearMonth:shellVccCache.yearMonth,fileName:shellVccCache.perFile[0].fileName,beginOp,totalAmount:shellVccCache.totals.totalAmount};
        shellVccSaved.push(saved);shellVccCache=null;
        return {status:'success',yearMonth:saved.yearMonth,beginOp,endOp:'1000.00'};
      };
      shellResponses['vccOpCalc:balance:list-months']=()=>shellVccSaved.map(item=>item.yearMonth);
      await setCurrentModule('vcc-op-calc',{persist:false}).ready;
      document.getElementById('vccOpCalcImportBtn').click();
    })()`); await flush();
    assert.match(await js(`document.querySelector('[data-preview-modal="vcc-op-calc-confirm"]').textContent`),/2026-07/);
    await js(`document.querySelector('[data-preview-modal="vcc-op-calc-confirm"] [data-action="confirm"]').click();`); await flush();
    await js(`document.getElementById('vccOpCalcRunBtn').click();`); await flush();
    assert.match(await js(`document.querySelector('[data-preview-modal="vcc-op-calc-compute"]').textContent`),/2026-07[\s\S]*10\.00/);
    await js(`
      [...document.querySelectorAll('[data-preview-modal="vcc-op-calc-compute"] button')].find(button=>button.textContent==='取消').click();
      shellVccSelected='B';shellVccDelay=true;document.getElementById('vccOpCalcImportBtn').click();
    `); await flush();
    await js(`(async()=>{await setCurrentModule('statement-generator',{persist:false}).ready;shellVccFinish();})()`); await flush();
    await js(`(async()=>{await setCurrentModule('vcc-op-calc',{persist:false}).ready;})()`); await flush();
    assert.equal(await js(`document.getElementById('vccOpCalcRunBtn').disabled`),true);
    assert.equal(await js(`document.getElementById('modalRoot').children.length`),0);
    assert.equal(await js(`shellVccSaved.length`),0);
    assert.match(await js(`document.getElementById('vccOpCalcStatusBox').textContent`),/2026-08[\s\S]*尚未确认/);
    await js(`shellVccDelay=false;document.getElementById('vccOpCalcImportBtn').click();`); await flush();
    assert.match(await js(`document.querySelector('[data-preview-modal="vcc-op-calc-confirm"]').textContent`),/2026-08/);
    await js(`document.querySelector('[data-preview-modal="vcc-op-calc-confirm"] [data-action="confirm"]').click();`); await flush();
    await js(`document.getElementById('vccOpCalcRunBtn').click();`); await flush();
    assert.match(await js(`document.querySelector('[data-preview-modal="vcc-op-calc-compute"]').textContent`),/2026-08[\s\S]*900\.00/);
    await js(`(()=>{
      const dialog=document.querySelector('[data-preview-modal="vcc-op-calc-compute"]');const input=dialog.querySelector('input');
      input.value='100.00';input.dispatchEvent(new Event('input',{bubbles:true}));
      [...dialog.querySelectorAll('button')].find(button=>button.textContent==='计算').click();
    })()`); await flush();
    assert.deepEqual(await js(`shellVccSaved`),[{yearMonth:'2026-08',fileName:'B.xlsx',beginOp:'100.00',totalAmount:'900.00'}]);
    assert.deepEqual(await js(`shellCalls.filter(call=>call.channel==='vccOpCalc:run:save').map(call=>call.args)`),[[{beginOp:'100.00'}]]);
    assert.match(await js(`document.querySelector('[data-preview-modal="vcc-op-calc-compute"]').textContent`),/期末OP = 1000\.00（已保存）/);
    await js(`modalHost.closeTop();void 0;`); await clean();
  });

  await test('正式设置默认入口点击存档，使用实际 Preload 依赖读取列表', async () => {
    const before = await js(`shellCalls.filter(call=>call.channel==='archive-center:list-batches').length`);
    await js(`document.getElementById('settingsBtn').click();`); await flush();
    await js(`document.querySelector('[data-tab="archive"]').click();`); await flush();
    assert.equal(await js(`shellCalls.filter(call=>call.channel==='archive-center:list-batches').length`),before+1);
    assert.doesNotMatch(await js(`document.getElementById('archiveCenterPane').textContent`),/加载失败|before initialization/);
    await js(`modalHost.closeTop();void 0;`); await clean();
  });

  await test('正式收纳保存时拒绝导航，正常关闭后按 Main 启用列表切换被停用模块', async () => {
    await js(`(async()=>{
      await setCurrentModule('statement-generator',{persist:false}).ready;
      window.shellCabinetWrite=new Promise(resolve=>window.shellCabinetFinish=resolve);
      shellResponses['settings:set-enabled-modules']=()=>shellCabinetWrite;
      document.getElementById('moduleCabinetBtn').click();
      document.querySelector('.module-cabinet-item[data-module-id="statement-generator"]').click();
      document.querySelector('.module-cabinet-card [data-action="disable"]').click();
      document.querySelector('.module-cabinet-card [data-action="confirm"]').click();
    })()`); await flush();
    assert.equal(await js(`setCurrentModule('new-account-generator').status`),'blocked');
    assert.equal(await js(`getModuleRouter().getCurrentModuleId()`),'statement-generator');
    assert.equal(await js(`shellCalls.filter(call=>call.channel==='settings:set-enabled-modules').length`),1);
    await js(`shellCabinetFinish({status:'ok',enabledModules:['new-account-generator','pending-reconciliation']});`); await flush();
    assert.equal(await js(`getModuleRouter().getCurrentModuleId()`),'new-account-generator');
    assert.equal(await js(`document.getElementById('modalRoot').children.length`),0);
    assert.equal(await js(`document.getElementById('newAccountModulePanel').hidden`),false);
    assert.deepEqual(await js(`state.enabledModules`),['new-account-generator','pending-reconciliation']);
    assert.deepEqual(await js(`shellCalls.filter(call=>call.channel==='settings:set-current-module').at(-1).args`),['new-account-generator']);
    await clean();
  });

  await test('应用销毁只清理一次：订阅取消、静态事件停用、旧通知不再写界面', async () => {
    await js(`(async()=>{
      await setCurrentModule('new-account-generator',{persist:false}).ready;
      window.shellSavedUpdateListeners=[...(shellSubscriptions.get('app-update:status-changed')||[])];
      window.shellSavedMaxListeners=[...(shellSubscriptions.get('window:maximized-state')||[])];
      window.shellSavedPendingListeners=[...(shellSubscriptions.get('pending:import:progress')||[])];
      rendererPending.applyPreviewState({importing:true,importingText:'销毁前任务',currentYearMonth:'2026-09'});
      window.shellRowCount=document.querySelectorAll('[data-new-account-row]').length;
      window.shellDisposeCount=0;
      window.shellDisposeHandle=modalHost.openRoot(scope=>{
        scope.onDispose(()=>shellDisposeCount++);
        const overlay=document.createElement('div');overlay.innerHTML='<section><button>测试清理</button></section>';
        return {overlay,dialog:overlay.firstElementChild};
      },{owner:'new-account-generator'}).handle;
      window.dispatchEvent(new Event('beforeunload'));
      window.dispatchEvent(new Event('unload'));
      disposeApplication();
    })()`); await flush();
    assert.equal(await js('shellDisposeCount'), 1);
    assert.deepEqual(await js('shellDisposeHandle.closed'), {status:'cancelled',reason:'disposed'});
    assert.equal(await js(`shellRemoved.filter(channel=>channel==='app-update:status-changed').length`), 1);
    // Preload 所有订阅均返回清理函数；已排队的旧回调仍须通过 disposed 隔离。
    assert.deepEqual(await js(`Object.fromEntries([...shellSubscriptions].filter(([,listeners])=>listeners.size).map(([channel,listeners])=>[channel,listeners.size]))`), {});
    const before = await js(`({calls:shellCalls.length,sends:shellSends.length,markup:document.body.innerHTML,pending:rendererPending.getSnapshot()})`);
    await js(`
      for(const listener of shellSavedUpdateListeners)listener({}, {status:'downloaded',availableVersion:'99.0.0',version:'99.0.0'});
      for(const listener of shellSavedMaxListeners)listener({}, true);
      for(const listener of shellSavedPendingListeners)listener({}, {type:'progress',file:'迟到.xlsx',rowsProcessed:999});
      document.getElementById('newAccountAddRowBtn').click();
      document.getElementById('pendingRuleBtn').click();
      document.getElementById('manageTemplateBtn').click();
      document.getElementById('toolboxBtn').click();
      document.getElementById('saveUserGuideBtn').click();
      document.getElementById('minimizeBtn').click();
      document.getElementById('moduleSwitcherBtn').click();
      document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
      document.dispatchEvent(new Event('pointerdown',{bubbles:true}));
      configurationServices.acceptAccountMappingCount(999);
    `); await flush();
    assert.deepEqual(await js(`({calls:shellCalls.length,sends:shellSends.length,markup:document.body.innerHTML,pending:rendererPending.getSnapshot()})`), before);
    assert.equal(await js(`document.querySelectorAll('[data-new-account-row]').length===shellRowCount`), true);
    assert.equal(await js(`setCurrentModule('statement-generator').status`), 'disposed');
    assert.equal(await js(`document.getElementById('modalRoot').children.length`), 0);
    await clean();
  });

};
