'use strict';

// 真实设置/公共确认工厂；仅使用可控 API，不删除真实数据。
module.exports = async ({ js, load, reset, assert, test }) => {
  async function setup({ useOverride = false, selectBatch = true } = {}) {
    await reset();
    await load('src/renderer/dialogs/toolbox.js');
    await load('src/renderer-dialogs.js');
    await load('src/renderer/dialogs/app-settings.js');
    await js(`
      window.__settingsTest = { subscriptions: 0, disposals: 0, prepares: [], deletes: [], lists: 0, stats: 0, settings: 0 };
      window.desktopApi = {};
      window.fixtureSettingsApi = {};
      window.fixtureHost = window.__rendererModalHost;
      window.fixtureBridge = window.__rendererModalBridge;
      window.fixtureDialogs = window.__createTestRendererDialogs({ modalBridge: fixtureBridge, state: {}, elements: {}, desktopApi: window.desktopApi, appConstants: {} });
      window.fixtureSettings = window.__appSettingsDialogs.createAppSettingsDialogs({
        api: fixtureSettingsApi, modalBridge: fixtureBridge,
        modules: { bankStatementProcess: {id:'bank-statement-process',name:'资金对账'}, vccFinancialOp:{id:'vcc-financial-op',name:'VCC'} },
        ui: { escapeHtml: value => String(value), createConfirmDialog: fixtureDialogs.createConfirmDialog,
          getDarkModeController: () => null, mountAppearanceSettings: () => null,
          applyAppUpdateActionResult() {}, applyAppUpdateStatus() {}, getAppUpdateStatus:()=>({}),
          refreshOpenAppUpdateDialog() {}, restartAndInstallAppUpdate() {} }
      });
      window.fixtureApi = fixtureSettings.createArchiveCenterPreviewApi();
      fixtureSettingsApi.archiveCenter = fixtureApi;
      const originalList = fixtureApi.listBatches;
      fixtureApi.listBatches = async (...args) => { __settingsTest.lists++; return originalList(...args); };
      for (const [name,counter] of [['getSettings','settings'],['getStats','stats']]) {
        const original = fixtureApi[name];
        fixtureApi[name] = async (...args) => { __settingsTest[counter]++; return original.apply(fixtureApi,args); };
      }
      for (const name of ['onStorageMigrationProgress','onEntryMaintenanceCompleted','onEntryMaintenanceFailed']) {
        fixtureApi[name] = () => { __settingsTest.subscriptions++; return () => __settingsTest.disposals++; };
      }
      fixtureApi.prepareDeleteBatch = async id => { __settingsTest.prepares.push(id); return {ok:true,status:'success',confirmationToken:'exact-token',summary:{fileCount:2}}; };
      fixtureApi.deleteBatch = (id, token) => { __settingsTest.deletes.push([id, token]); return new Promise(resolve => window.resolveDelete = resolve); };
      window.settingsOverlay = null;
      window.settingsHandle = fixtureBridge.openModal(() => {
        settingsOverlay = fixtureSettings.createAppUpdateSettingsDialog(${useOverride ? '{archiveCenterApi:fixtureApi}' : ''});
        return settingsOverlay;
      }).handle;
      settingsOverlay.querySelector('[data-tab="archive"]').click();
    `);
    await js(`new Promise(resolve => setTimeout(resolve, 20))`);
    if (selectBatch) await js(`settingsOverlay.querySelector('[data-batch-id="902"]').click()`);
    await js(`new Promise(resolve => setTimeout(resolve, 10))`);
  }

  await test('正式默认设置依赖无需 override 即可读取存档列表、统计和保留期', async () => {
    await setup({selectBatch:false});
    assert.equal(await js('__settingsTest.lists'),1);
    assert.equal(await js('__settingsTest.stats>0'),true);
    assert.doesNotMatch(await js(`settingsOverlay.querySelector('[data-role="archive-feedback"]').textContent`),/Cannot access|加载失败/);
    assert.equal(await js(`!!settingsOverlay.querySelector('[data-batch-id="902"]')`),true);
    await js(`settingsOverlay.querySelector('[data-action="open-archive-settings"]').click()`);
    await js('new Promise(resolve=>setTimeout(resolve,10))');
    assert.equal(await js(`settingsOverlay.querySelector('[data-role="archive-retention-days"]').disabled`),false);
    assert.equal(await js('__settingsTest.settings>0'),true);
    assert.deepEqual(await js('__testErrors'),[]);
  });
  await test('显式存档 API override 仍兼容', async () => {
    await setup({useOverride:true});
    assert.equal(await js('__settingsTest.lists'),1);
    assert.equal(await js('settingsHandle.isTop()'),true);
  });

  await test('设置父会话在删除确认取消后保留，零删除且最终退订一次', async () => {
    await setup();
    await js(`settingsOverlay.querySelector('[data-action="delete-archive-batch"]').click()`);
    await js(`new Promise(resolve => setTimeout(resolve, 10))`);
    assert.deepEqual(await js(`({count:document.getElementById('modalRoot').children.length, mounted:settingsOverlay.isConnected, disposed:__settingsTest.disposals})`), {count:2,mounted:true,disposed:0});
    await js(`fixtureHost.getTop(); document.querySelector('[data-action="cancel"]').click()`);
    assert.deepEqual(await js(`({count:document.getElementById('modalRoot').children.length,deletes:__settingsTest.deletes.length,open:settingsHandle.isOpen()})`), {count:1,deletes:0,open:true});
    await js(`settingsHandle.close(); fixtureHost.dispose()`);
    assert.equal(await js(`__settingsTest.disposals`), 3);
  });

  for (const fullyDeleted of [true,false]) {
    await test(`删除双击仅发原 token 一次，${fullyDeleted?'完整':'待清理'}成功刷新同一父会话`, async () => {
      await setup();
      await js(`settingsOverlay.querySelector('[data-action="delete-archive-batch"]').click()`);
      await js(`new Promise(resolve => setTimeout(resolve, 10))`);
      await js(`const button=document.querySelector('[data-action="confirm"]'); button.click(); button.click();`);
      assert.equal(await js(`fixtureBridge.openModal(() => { throw new Error('blocked factory'); }).status`), 'blocked');
      assert.deepEqual(await js(`__settingsTest.deletes`), [['902','exact-token']]);
      await js(`resolveDelete({ok:true,status:'success',metadataDeleted:true,fullyDeleted:${fullyDeleted}})`);
      await js(`new Promise(resolve => setTimeout(resolve, 10))`);
      assert.deepEqual(await js(`({count:document.getElementById('modalRoot').children.length,open:settingsHandle.isOpen(),disposed:__settingsTest.disposals,refreshed:__settingsTest.lists>1})`), {count:1,open:true,disposed:0,refreshed:true});
      assert.match(await js(`settingsOverlay.querySelector('[data-role="archive-feedback"]').textContent`), fullyDeleted ? /已永久删除/ : /文件清理尚未完成/);
    });
  }

  await test('删除失败保留确认层及原 token，强制销毁后晚到结果不复活', async () => {
    await setup();
    await js(`settingsOverlay.querySelector('[data-action="delete-archive-batch"]').click()`);
    await js(`new Promise(resolve => setTimeout(resolve, 10))`);
    await js(`document.querySelector('[data-action="confirm"]').click(); resolveDelete({ok:false,metadataDeleted:false,message:'失败'})`);
    await js(`new Promise(resolve => setTimeout(resolve, 10))`);
    assert.equal(await js(`document.getElementById('modalRoot').children.length`), 2);
    assert.match(await js(`document.querySelector('[data-role="archive-delete-error"]').textContent`), /失败/);
    await js(`document.querySelector('[data-action="confirm"]').click(); fixtureHost.dispose(); resolveDelete({ok:true,metadataDeleted:true,fullyDeleted:true})`);
    await js(`new Promise(resolve => setTimeout(resolve, 10))`);
    assert.equal(await js(`document.getElementById('modalRoot').children.length`), 0);
    assert.equal(await js(`__settingsTest.disposals`), 3);
    assert.deepEqual(await js(`__settingsTest.deletes`), [['902','exact-token'],['902','exact-token']]);
  });

  await test('期限保存中阻止预检，预检期间新增保存也不能进入确认', async () => {
    await setup();
    await js(`
      window.deferredRetention = [];
      fixtureApi.setRetentionDays = value => new Promise(resolve => deferredRetention.push(() => resolve({status:'success',settings:{retentionDays:value}})));
      settingsOverlay.querySelector('[data-action="open-archive-settings"]').click();
    `);
    await js(`new Promise(resolve => setTimeout(resolve, 10))`);
    await js(`var select=settingsOverlay.querySelector('[data-role="archive-retention-days"]'); select.value='90'; select.dispatchEvent(new Event('change')); settingsOverlay.querySelector('[data-action="delete-archive-batch"]').click();`);
    assert.equal(await js(`__settingsTest.prepares.length`), 0);
    assert.equal(await js(`settingsHandle.close().status`), 'blocked');
    await js(`deferredRetention.shift()()`);
    await js(`new Promise(resolve => setTimeout(resolve, 10))`);
    await js(`fixtureApi.prepareDeleteBatch = id => new Promise(resolve => window.resolvePrepare=resolve); settingsOverlay.querySelector('[data-action="delete-archive-batch"]').click(); var select=settingsOverlay.querySelector('[data-role="archive-retention-days"]'); select.value='180'; select.dispatchEvent(new Event('change')); resolvePrepare({ok:true,status:'success',confirmationToken:'late-token'});`);
    await js(`new Promise(resolve => setTimeout(resolve, 10))`);
    assert.equal(await js(`document.getElementById('modalRoot').children.length`), 1);
    await js(`deferredRetention.shift()(); fixtureHost.dispose()`);
  });

  await test('首次载入以永久占位，成功读取后继承永久，返回重进不写入设置', async () => {
    await setup({ selectBatch: false });
    await js(`
      window.retentionWrites = [];
      fixtureApi.setRetentionDays = async value => { retentionWrites.push(value); return {status:'success'}; };
      fixtureApi.setModuleRetentionDays = async value => { retentionWrites.push(value); return {status:'success'}; };
      fixtureApi.getSettings = () => new Promise(resolve => window.resolveSettings = resolve);
      settingsOverlay.querySelector('[data-action="open-archive-settings"]').click();
    `);
    assert.deepEqual(await js(`(() => { const el=settingsOverlay.querySelector('[data-role="archive-retention-days"]'); return [el.value,el.disabled]; })()`), ['permanent', true]);
    await js(`
      window.savedSettings = {retentionDays:null,retentionDaysByModule:{}};
      resolveSettings({status:'success',settings:savedSettings});
    `);
    await js('new Promise(resolve=>setTimeout(resolve,10))');
    assert.deepEqual(await js(`(() => { const el=settingsOverlay.querySelector('[data-role="archive-retention-days"]'); return [el.value,el.disabled]; })()`), ['permanent', false]);
    await js(`var moduleSelect=settingsOverlay.querySelector('[data-role="archive-retention-module"]'); moduleSelect.value='bank-statement-process'; moduleSelect.dispatchEvent(new Event('change'));`);
    assert.equal(await js(`settingsOverlay.querySelector('[data-role="archive-retention-days"]').value`), 'inherit');
    assert.equal(await js(`settingsOverlay.querySelector('[data-role="archive-retention-days"] [value="inherit"]').textContent`), '跟随默认（永久）');
    await js(`
      settingsOverlay.querySelector('[data-action="back-to-archive"]').click();
      fixtureApi.getSettings=async()=>({status:'success',settings:savedSettings});
      settingsOverlay.querySelector('[data-action="open-archive-settings"]').click();
    `);
    await js('new Promise(resolve=>setTimeout(resolve,10))');
    assert.equal(await js(`settingsOverlay.querySelector('[data-role="archive-retention-days"]').value`), 'inherit');
    assert.deepEqual(await js('retentionWrites'), []);
    assert.deepEqual(await js('savedSettings.retentionDaysByModule'), {});
  });

  await test('已保存全局 60 天和模块永久均按回包展示，切换模块不触发保存', async () => {
    await setup({ selectBatch: false });
    await js(`
      window.retentionWrites = [];
      fixtureApi.getSettings = async()=>({status:'success',settings:{retentionDays:60,retentionDaysByModule:{'vcc-financial-op':null}}});
      fixtureApi.setRetentionDays=async value=>retentionWrites.push(value);
      fixtureApi.setModuleRetentionDays=async value=>retentionWrites.push(value);
      settingsOverlay.querySelector('[data-action="open-archive-settings"]').click();
    `);
    await js('new Promise(resolve=>setTimeout(resolve,10))');
    for (const [moduleId, expected] of [['', '60'], ['bank-statement-process', 'inherit'], ['vcc-financial-op', 'permanent'], ['', '60']]) {
      await js(`var el=settingsOverlay.querySelector('[data-role="archive-retention-module"]'); el.value=${JSON.stringify(moduleId)}; el.dispatchEvent(new Event('change'));`);
      assert.equal(await js(`settingsOverlay.querySelector('[data-role="archive-retention-days"]').value`), expected);
    }
    assert.deepEqual(await js('retentionWrites'), []);
  });

  for (const invalid of ['rejected', 'failed', 'empty-payload']) {
    await test(`首次设置读取 ${invalid} 不允许保存，返回重试成功后恢复旧值`, async () => {
      await setup({ selectBatch: false });
      await js(`
        window.retentionWrites=[];
        fixtureApi.setRetentionDays=async value=>retentionWrites.push(value);
        fixtureApi.getSettings=async()=>{
          if (${JSON.stringify(invalid)}==='rejected') throw new Error('模拟读取失败');
          return ${JSON.stringify(invalid)}==='failed' ? {status:'failed',message:'模拟读取失败'} : {status:'success',settings:null};
        };
        settingsOverlay.querySelector('[data-action="open-archive-settings"]').click();
      `);
      await js('new Promise(resolve=>setTimeout(resolve,10))');
      assert.equal(await js(`settingsOverlay.querySelector('[data-role="archive-retention-days"]').disabled`), true);
      assert.equal(await js(`settingsOverlay.querySelector('[data-role="archive-retention-module"]').disabled`), true);
      assert.match(await js(`settingsOverlay.querySelector('[data-role="archive-feedback"]').textContent`), /加载失败/);
      await js(`var el=settingsOverlay.querySelector('[data-role="archive-retention-days"]'); el.value='60'; el.dispatchEvent(new Event('change'));`);
      assert.deepEqual(await js('retentionWrites'), []);
      await js(`
        settingsOverlay.querySelector('[data-action="back-to-archive"]').click();
        fixtureApi.getSettings=async()=>({status:'success',settings:{retentionDays:60,retentionDaysByModule:{}}});
        settingsOverlay.querySelector('[data-action="open-archive-settings"]').click();
      `);
      await js('new Promise(resolve=>setTimeout(resolve,10))');
      assert.deepEqual(await js(`(() => { const el=settingsOverlay.querySelector('[data-role="archive-retention-days"]'); return [el.value,el.disabled]; })()`), ['60', false]);
      assert.deepEqual(await js('retentionWrites'), []);
      assert.doesNotMatch(await js(`settingsOverlay.querySelector('[data-role="archive-feedback"]').textContent`), /已保存/);
      assert.equal(await js('settingsHandle.close().status'), 'closed');
    });
  }

  await test('永久默认下快速保存仍串行，失败回显已保存值且不串模块', async () => {
    await setup({ selectBatch: false });
    await js(`
      window.retentionWrites=[]; window.retentionResolvers=[];
      fixtureApi.getSettings=async()=>({status:'success',settings:{retentionDays:null,retentionDaysByModule:{}}});
      fixtureApi.setRetentionDays=value=>new Promise(resolve=>{retentionWrites.push(value);retentionResolvers.push(resolve);});
      fixtureApi.setModuleRetentionDays=async value=>{retentionWrites.push(value);return {status:'success'};};
      settingsOverlay.querySelector('[data-action="open-archive-settings"]').click();
    `);
    await js('new Promise(resolve=>setTimeout(resolve,10))');
    await js(`
      var days=settingsOverlay.querySelector('[data-role="archive-retention-days"]');
      var modules=settingsOverlay.querySelector('[data-role="archive-retention-module"]');
      days.value='90';days.dispatchEvent(new Event('change'));
      modules.value='bank-statement-process';modules.dispatchEvent(new Event('change'));
      days.value='60';days.dispatchEvent(new Event('change'));
      days.value='permanent';days.dispatchEvent(new Event('change'));
    `);
    assert.equal(await js('modules.value'), '');
    assert.deepEqual(await js('retentionWrites'), [90]);
    await js(`retentionResolvers.shift()({status:'success'});`);
    await js('new Promise(resolve=>setTimeout(resolve,10))');
    assert.deepEqual(await js('retentionWrites'), [90, null]);
    await js(`retentionResolvers.shift()({status:'failed',message:'模拟保存失败'});`);
    await js('new Promise(resolve=>setTimeout(resolve,10))');
    assert.equal(await js('days.value'), '90');
    assert.match(await js(`settingsOverlay.querySelector('[data-role="archive-feedback"]').textContent`), /保存失败/);
    await js(`days.value='permanent';days.dispatchEvent(new Event('change'));retentionResolvers.shift()({status:'success'});`);
    await js('new Promise(resolve=>setTimeout(resolve,10))');
    assert.equal(await js('days.value'), 'permanent');
    await js(`modules.value='bank-statement-process';modules.dispatchEvent(new Event('change'));`);
    assert.equal(await js('days.value'), 'inherit');
    await js(`days.value='30';days.dispatchEvent(new Event('change'));`);
    await js('new Promise(resolve=>setTimeout(resolve,10))');
    assert.deepEqual(await js('retentionWrites'), [90, null, null, {moduleId:'bank-statement-process',retentionDays:30}]);
    assert.equal(await js('days.value'), '30');
    assert.deepEqual(await js('__testErrors'), []);
  });


  await test('缺省回包与兼容 defaultRetentionDays 的展示回退一致，读取不保存', async () => {
    await setup({ selectBatch: false });
    await js(`window.retentionWrites=[]; fixtureApi.setRetentionDays=async value=>retentionWrites.push(value); void 0;`);
    for (const [payload, value, label] of [
      ['{}','permanent','永久'], ['{retentionDays:undefined}','permanent','永久'],
      ['{defaultRetentionDays:null}','permanent','永久'], ['{defaultRetentionDays:60}','60','60 天']
    ]) {
      await js(`
        fixtureApi.getSettings=async()=>({status:'success',settings:${payload}});
        settingsOverlay.querySelector('[data-action="open-archive-settings"]').click();
      `);
      await js('new Promise(resolve=>setTimeout(resolve,10))');
      await js(`var modules=settingsOverlay.querySelector('[data-role="archive-retention-module"]');modules.value='';modules.dispatchEvent(new Event('change'));`);
      assert.equal(await js(`settingsOverlay.querySelector('[data-role="archive-retention-days"]').value`),value);
      await js(`modules.value='bank-statement-process';modules.dispatchEvent(new Event('change'));`);
      assert.equal(await js(`settingsOverlay.querySelector('[data-role="archive-retention-days"] [value="inherit"]').textContent`),`跟随默认（${label}）`);
      await js(`settingsOverlay.querySelector('[data-action="back-to-archive"]').click();`);
    }
    assert.deepEqual(await js('retentionWrites'),[]);
  });
};
