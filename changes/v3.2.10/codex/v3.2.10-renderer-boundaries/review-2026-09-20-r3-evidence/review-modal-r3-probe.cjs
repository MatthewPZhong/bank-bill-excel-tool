'use strict';

const fs = require('node:fs');
const path = require('node:path');
if (process.env.REVIEW_OUTPUT_LOG) { fs.writeFileSync(process.env.REVIEW_OUTPUT_LOG, ''); const originalLog = console.log; console.log = (...args) => { fs.appendFileSync(process.env.REVIEW_OUTPUT_LOG, args.join(' ') + '\n'); originalLog(...args); }; }
const assert = require('node:assert/strict');
const { app, BrowserWindow } = require('electron');
const root = process.env.REVIEW_SOURCE_ROOT || '/private/tmp/renderer-boundaries-r3-qu7nz33r';
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
  })()`);console.log('ROW_DELETE_BUSY '+JSON.stringify(double));assert.equal(double.inflight.calls.length,1);assert.equal(double.inflight.parentClose,'blocked');
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
  })()`);console.log('ROW_DELETE_LATE_PREVIEW '+JSON.stringify(late));assert.equal(late.oldOpen,false);assert.equal(late.deleteCallsAfterClose.length,0);

  await setupLegacy();
  const partial=await js(`(async()=>{
    legacy.storedRules=['existing-credit-rule','existing-debit-rule'];legacy.meta=legacy.deferred();legacy.calls.meta=[];
    desktopApi.templates.saveBillSplitAmountRules=async payload=>{legacy.storedRules=structuredClone(payload.amountSplitRules);return {status:'success'};};
    desktopApi.templates.saveBillSplitMeta=payload=>{legacy.calls.meta.push(payload);return legacy.meta.promise;};
    legacy.openRows();const view=legacy.overlay;const before={rulesVisible:!view.querySelector('.bill-split-amount-rules-manage-btn').hidden,signedDisabled:view.querySelector('.bill-split-signed-select').disabled};
    const select=view.querySelector('.bill-split-by-field-select');select.value='';select.dispatchEvent(new Event('change'));await legacy.tick();
    const busy={close:legacy.handle.close().status};legacy.meta.resolve({status:'failed',message:'元信息保存失败'});await legacy.tick();
    const alert=legacy.top()!==view?legacy.top().textContent:null;if(alert)legacy.host.closeTop();
    const after={rulesVisible:!view.querySelector('.bill-split-amount-rules-manage-btn').hidden,signedDisabled:view.querySelector('.bill-split-signed-select').disabled,selected:select.value,storedRules:legacy.storedRules};
    if(after.rulesVisible)view.querySelector('.bill-split-amount-rules-manage-btn').click();await legacy.tick();
    const staleEditor=legacy.top()!==view?legacy.top().querySelector('.rule-condition-value')?.value:null;
    return {before,busy,alert,after,staleEditor,errors:__testErrors};
  })()`);console.log('PARTIAL_RULES_WRITE '+JSON.stringify(partial));assert.deepEqual(partial.after,{rulesVisible:true,signedDisabled:true,selected:'',storedRules:[]});assert.equal(partial.staleEditor,'入金');
  console.log('2/2 original deletion sequences fixed; partial metadata write recorded');
  win.destroy();
  app.exit(failures.length ? 1 : 0);
})().catch(error => { console.error(error.stack || error); app.exit(1); });
