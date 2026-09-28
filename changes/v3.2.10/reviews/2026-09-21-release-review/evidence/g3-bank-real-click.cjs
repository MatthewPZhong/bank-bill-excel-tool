'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = '/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10';
const { app, BrowserWindow } = require('electron');
const temporary = fs.mkdtempSync('/tmp/release-g3-bank-real-click-');
app.setPath('userData', path.join(temporary, 'userData'));
app.setPath('documents', path.join(temporary, 'Documents'));
fs.mkdirSync(app.getPath('documents'), { recursive:true });
app.disableHardwareAcceleration();
(async()=>{
  await app.whenReady();
  const win = new BrowserWindow({show:false,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true}});
  await win.loadURL('data:text/html,'+encodeURIComponent('<div id="modalRoot"></div><div id="panel">'+[
    'bankStatementScenarioBtn','bankStatementImportBtn','bankStatementRunBtn','bankStatementExportBtn','bankStatementStatusBox','bankStatementLinkedTableBtn'
  ].map(id=>'<button id="'+id+'"></button>').join('')+'</div>'));
  const js = text => win.webContents.executeJavaScript(text, true);
  for (const file of ['modal-host.js','modal-bridge.js','configuration-services.js','dialogs/scenarios.js','dialogs/configuration.js','dialogs/toolbox.js','controllers/bank-statement.js'])
    await js(fs.readFileSync(path.join(root,'src/renderer',file),'utf8')+'\n;void 0;');
  await js(fs.readFileSync(path.join(root,'src/renderer-dialogs.js'),'utf8')+'\n;void 0;');
  await js(`
    window.probe={errors:[],calls:[]};
    window.addEventListener('unhandledrejection',event=>{probe.errors.push({code:event.reason.code,message:event.reason.message});event.preventDefault();});
    window.host=__modalHost.createModalHost({root:document.getElementById('modalRoot'),document});
    window.bridge=__modalBridge.createModalBridge({host});
    const services=ConfigurationServices.createConfigurationServices({templatesApi:{list:async()=>[]}});
    const dialogs=__rendererDialogs.createRendererDialogs({modalBridge:bridge,configurationServices:services,configurationApi:{},dialogApis:{},appConstants:{},
      scenarioCommands:{scenarios:{},channels:{}},scenarioSubscriptions:{subscribeScenarios:()=>()=>{},subscribeChannels:()=>()=>{}}});
    window.bank=BankStatementController.createBankStatementController({panel:document.getElementById('panel'),
      api:{sessionStatus:async()=>({status:'ok',hasBankStatement:true,hasRefundOrder:false,bankStatementFileName:'fixture.xlsx'}),
        refundCandidateCount:async()=>({status:'ok',candidateCount:1}),run:async()=>{probe.calls.push('run');return {status:'ok'};},batchImport:async()=>{probe.calls.push('batchImport');return {status:'cancelled'};}},
      config:{scenarios:{list:async()=>({status:'ok',scenarios:[{id:1,name:'中台退款订单回填',category:'builtin-fixed',enabled:true}]})},linkedTable:{}},
      sharedReconSession:{sessionStatus:async()=>({status:'ok',hasFile:false}),subscribe:()=>()=>{}},
      ui:{modalHost:{openRoot:bridge.openModal,closeOwner:host.closeOwner},alert:dialogs.createAlertDialog,confirm:dialogs.createConfirmDialog}});
    void 0;
  `);
  await js('bank.enter()');
  await js('bank.commands.run()');
  const before = await js('document.getElementById("modalRoot").textContent');
  assert.match(before,/中台退款订单表/);
  await js('document.querySelector("[data-action=middle]").click();void 0;');
  await js('new Promise(resolve=>setTimeout(resolve,20))');
  const actual = await js('({errors:probe.errors,calls:probe.calls,modalStillOpen:host.getTop()?.isOpen()===true,button:document.querySelector("[data-action=middle]").textContent})');
  assert.equal(actual.errors[0]?.code,'MODAL_OUTCOME_INVALID');
  assert.deepEqual(actual.calls,[]);
  assert.equal(actual.modalStillOpen,true);
  console.log(JSON.stringify({sourceHead:'9a38b96b1b8006c5851535d0c1e586bbaeb63f10',kind:'real Electron DOM + real BankStatement controller + real confirm factory + real modal bridge/host; controlled API',...actual},null,2));
  win.destroy();
  fs.rmSync(temporary,{recursive:true,force:true});
  app.exit(0);
})().catch(error=>{console.error(error);fs.rmSync(temporary,{recursive:true,force:true});app.exit(1);});
