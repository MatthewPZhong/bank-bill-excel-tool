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
const fixturesDirectory = path.join(root, 'scripts/renderer-lifecycle/fixtures');
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

  await require(path.join(fixturesDirectory,'legacy-dialogs.js'))({js,load:loadFixture,reset,assert,test:async(label,work)=>{if(label.startsWith('公共告警'))await work();}});
  const result=await js(`(async()=>{
    legacy.write=legacy.deferred();legacy.calls.rowCounts=[];
    desktopApi.templates.saveBillSplitRowCount=payload=>{legacy.calls.rowCounts.push(payload);return legacy.write.promise;};
    legacy.openRows();legacy.overlay.querySelector('.bill-split-row-count-input').value='1';legacy.overlay.querySelector('.bill-split-row-count-done-btn').click();
    const confirm=legacy.top();const button=confirm.querySelector('[data-action="confirm"]');button.click();button.click();
    const inflight={calls:legacy.calls.rowCounts.length,buttonDisabled:button.disabled,rootClose:legacy.parentHandle.close().status};
    legacy.write.resolve({status:'success',currentRows:[]});await legacy.tick();
    return {inflight,count:legacy.root.children.length,errors:__testErrors};
  })()`);console.log('BILL_SPLIT_PROBE '+JSON.stringify(result));assert.equal(result.inflight.calls,2);assert.equal(result.inflight.rootClose,'closed');passed++;total++;
  const cabinet=await js(`(async()=>{
    legacy.commit=legacy.deferred();const cabinet=legacy.dialogs.createModuleCabinetDialog({enabledModules:['one'],allModules:[{id:'one',label:'测试'}],onCommit:()=>legacy.commit.promise});
    const original=legacy.bridge.openModal(()=>cabinet).handle;cabinet.querySelector('[data-action="confirm"]').click();
    const other=legacy.bridge.openModal(()=>legacy.dialogs.createAlertDialog('新打开的告警'));const opened=other.status;
    legacy.commit.resolve(true);await legacy.tick();
    return {opened,originalOpen:original.isOpen(),otherOpen:other.handle?.isOpen(),count:legacy.root.children.length,errors:__testErrors};
  })()`);console.log('CABINET_PROBE '+JSON.stringify(cabinet));assert.equal(cabinet.opened,'opened');assert.equal(cabinet.otherOpen,false);passed++;total++;

  await load('src/renderer/dialogs/app-settings.js');
  const archive=await js(`(async()=>{
    const ui={escapeHtml:String,createConfirmDialog:legacy.dialogs.createConfirmDialog,getDarkModeController:()=>null,mountAppearanceSettings:()=>null,applyAppUpdateActionResult(){},applyAppUpdateStatus(){},getAppUpdateStatus:()=>({}),refreshOpenAppUpdateDialog(){},restartAndInstallAppUpdate(){}};
    const api={};const factory=__appSettingsDialogs.createAppSettingsDialogs({api,modalBridge:legacy.bridge,modules:{bankStatementProcess:{id:'bank-statement-process',name:'资金对账'},vccFinancialOp:{id:'vcc-financial-op',name:'VCC'}},ui});
    api.archiveCenter=factory.createArchiveCenterPreviewApi();let calls=0;const list=api.archiveCenter.listBatches;
    api.archiveCenter.listBatches=async(...args)=>{calls++;return list(...args);};
    const defaultOverlay=factory.createAppUpdateSettingsDialog();legacy.bridge.openModal(()=>defaultOverlay);
    defaultOverlay.querySelector('[data-tab="archive"]').click();await legacy.tick();
    const result={calls,feedback:defaultOverlay.querySelector('[data-role="archive-feedback"]').textContent};
    legacy.host.closeTop();
    const overrideOverlay=factory.createAppUpdateSettingsDialog({archiveCenterApi:api.archiveCenter});legacy.bridge.openModal(()=>overrideOverlay);
    overrideOverlay.querySelector('[data-tab="archive"]').click();await legacy.tick();
    return {default:result,override:{calls,feedback:overrideOverlay.querySelector('[data-role="archive-feedback"]').textContent},errors:__testErrors};
  })()`);console.log('ARCHIVE_DEFAULT_PROBE '+JSON.stringify(archive));assert.equal(archive.default.calls,0);assert.match(archive.default.feedback,/Cannot access 'api' before initialization/);assert.equal(archive.override.calls,1);passed++;total++;
  console.log(`${passed}/${total} defect reproductions confirmed`);
  win.destroy();
  app.exit(failures.length ? 1 : 0);
})().catch(error => { console.error(error.stack || error); app.exit(1); });
