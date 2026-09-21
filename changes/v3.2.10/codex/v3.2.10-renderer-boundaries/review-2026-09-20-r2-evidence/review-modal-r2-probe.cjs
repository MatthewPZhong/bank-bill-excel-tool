'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { app, BrowserWindow } = require('electron');
const root = process.env.REVIEW_SOURCE_ROOT || '/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/v3210-renderer-boundaries';
const temporary = process.env.RENDERER_LIFECYCLE_TEMP;
if (!temporary) throw new Error('必须通过 test-renderer-lifecycle.js 运行隔离工厂测试');
app.setPath('userData', path.join(temporary, 'userData'));
app.setPath('documents', path.join(temporary, 'Documents'));
fs.mkdirSync(app.getPath('documents'), { recursive: true });
app.disableHardwareAcceleration();
const fixturesDirectory = path.join(root,'scripts/renderer-lifecycle/fixtures');
let passed = 0;
let total = 0;
const failures = [];

(async () => {
  await app.whenReady();
  const win = new BrowserWindow({ show: false, width: 1080, height: 800,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false }
  });
  const js = (source) => win.webContents.executeJavaScript(source, true);
  const load = (file) => js(fs.readFileSync(path.join(root, file), 'utf8') + '\n;void 0;');
  const reset = async (html = '<div id="modalRoot"></div>') => {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent('<!doctype html><html><head><meta charset="utf-8"></head><body>' + html + '</body></html>')}`);
    await load('src/renderer/modal-host.js');
    await load('src/renderer/modal-bridge.js');
    await load('src/renderer/scenario-command-service.js');
    await load('src/renderer/scenario-change-router.js');
    await load('src/renderer/dialogs/scenarios.js');
    await load('src/renderer/configuration-services.js');
    await load('src/renderer/dialogs/configuration.js');
    await js(`window.__testErrors = []; window.__rendererModalHost = window.__modalHost.createModalHost({
      root: document.getElementById('modalRoot'), document, reportError: error => window.__testErrors.push(String(error?.message || error))
    }); window.__rendererModalBridge = window.__modalBridge.createModalBridge({ host: window.__rendererModalHost }); void 0;`);
  };
  const originalLoad = load;
  const loadFixture = async (file) => {
    await originalLoad(file);
    if (file === 'src/renderer-dialogs.js') await js(`window.__createTestRendererDialogs = (deps) => {
      const router = window.ScenarioChangeRouter.createScenarioChangeRouter();
      const commands = window.ScenarioCommandService.createScenarioCommandService({
        scenariosApi: deps.desktopApi?.scenarios || {}, channelsApi: deps.desktopApi?.channels || {}, publish: event => router.route(event)
      });
      const configurationServices = window.ConfigurationServices.createConfigurationServices({ templatesApi: deps.desktopApi?.templates || {} });
      configurationServices.acceptBootstrap(deps.state || {});
      configurationServices.applyPreviewTemplates(deps.state?.templates || []);
      return window.__rendererDialogs.createRendererDialogs({...deps, scenarioCommands: commands, scenarioSubscriptions: router,
        configurationServices, configurationApi: deps.desktopApi || {}, dialogApis: deps.desktopApi || {}, reportLog: deps.desktopApi?.app?.reportLog });
    }; void 0;`);
  };
  const test = async (label, work) => {
    total += 1;
    try { await work(); passed += 1; console.log(`PASS ${label}`); }
    catch (error) { failures.push({ label, error }); console.error(`FAIL ${label}: ${error.stack || error}`); }
  };
  const requested = process.argv.slice(2);
  const files = [];
  for (const name of files) {
    if (path.basename(name) !== name) throw new Error('fixture 名称不能包含路径');
    const fixture = require(path.join(fixturesDirectory, name));
    await fixture({ js, load: loadFixture, reset, assert, test });
  }

  const setupLegacy=async()=>require(path.join(fixturesDirectory,'legacy-dialogs.js'))({js,load:loadFixture,reset,assert,test:async(label,work)=>{if(label.startsWith('公共告警'))await work();}});
  await setupLegacy();
  const double=await js(`(async()=>{
    legacy.write=legacy.deferred();legacy.calls.rowDeletes=[];
    desktopApi.templates.deleteBillSplitRow=payload=>{legacy.calls.rowDeletes.push(payload);return legacy.write.promise;};
    legacy.openRows();legacy.overlay.querySelector('.bill-split-row-delete-btn').click();await legacy.tick();
    const confirm=legacy.top();const button=confirm.querySelector('[data-action="confirm"]');button.click();button.click();
    const inflight={calls:legacy.calls.rowDeletes,buttonDisabled:button.disabled,parentClose:legacy.handle.close().status};
    legacy.write.resolve({status:'success',currentRows:[]});await legacy.tick();
    return {inflight,count:legacy.root.children.length,errors:__testErrors};
  })()`);console.log('ROW_DELETE_BUSY '+JSON.stringify(double));assert.equal(double.inflight.calls.length,2);assert.equal(double.inflight.parentClose,'closed');
  await setupLegacy();
  const late=await js(`(async()=>{
    legacy.preview=legacy.deferred();legacy.calls.rowDeletes=[];
    desktopApi.templates.previewDeleteBillSplitRow=()=>legacy.preview.promise;
    desktopApi.templates.deleteBillSplitRow=async payload=>{legacy.calls.rowDeletes.push(payload);return {status:'success',currentRows:[]};};
    legacy.openRows();legacy.overlay.querySelector('.bill-split-row-delete-btn').click();
    legacy.overlay.querySelector('.icon-close').click();const oldOpen=legacy.handle.isOpen();
    const next=legacy.bridge.openModal(()=>legacy.dialogs.createAlertDialog('后来打开的新窗口')).handle;
    legacy.preview.resolve({status:'success',dissolvedGroups:[]});await legacy.tick();
    return {oldOpen,deleteCallsAfterClose:legacy.calls.rowDeletes,newTop:next.isTop(),errors:__testErrors};
  })()`);console.log('ROW_DELETE_LATE_PREVIEW '+JSON.stringify(late));assert.equal(late.oldOpen,false);assert.equal(late.deleteCallsAfterClose.length,1);
  await setupLegacy();
  const draft=await js(`(async()=>{
    desktopApi.templates.saveBillSplitRowCount=async payload=>({status:'success',currentRows:[{seqNo:1,rowStatus:'draft',currencySourceField:'Currency',creditSourceField:'',debitSourceField:''}]});
    legacy.openRows();const firstRow=legacy.overlay.querySelector('tbody tr');const sel=firstRow.querySelector('.bill-split-row-credit-select');
    const selectors=[...firstRow.querySelectorAll('select')].map(x=>({className:x.className,value:x.value}));
    const credit=sel||firstRow.querySelectorAll('select')[1];credit.value='Amount';credit.dispatchEvent(new Event('change'));
    const before=credit.value;legacy.overlay.querySelector('.bill-split-row-count-input').value='1';legacy.overlay.querySelector('.bill-split-row-count-done-btn').click();
    legacy.top().querySelector('[data-action="confirm"]').click();await legacy.tick();
    return {before,after:legacy.overlay.querySelector('tbody tr').querySelectorAll('select')[1].value,selectors,parentTop:legacy.handle.isTop(),errors:__testErrors};
  })()`);console.log('ROW_COUNT_EXISTING_DRAFT '+JSON.stringify(draft));
  console.log('2/2 remaining delete-path defects reproduced; row-count draft behavior recorded');
  win.destroy();
  app.exit(failures.length ? 1 : 0);
})().catch(error => { console.error(error.stack || error); app.exit(1); });
