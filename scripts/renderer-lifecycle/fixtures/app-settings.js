'use strict';

const fs = require('node:fs');
const path = require('node:path');
const acorn = require('acorn');

// 真实设置/公共确认工厂；仅使用可控 API，不删除真实数据。
module.exports = async ({ js, load, reset, assert, test }) => {
  const root = path.resolve(__dirname, '../../..');
  const renderer = fs.readFileSync(path.join(root, 'src/renderer.js'), 'utf8');
  // 只提取生产转义函数，不启动应用壳或加载用户数据。
  const escapeHtmlNode = acorn.parse(renderer, { ecmaVersion: 'latest' }).body
    .find(node => node.type === 'FunctionDeclaration' && node.id.name === 'escapeHtml');
  assert.ok(escapeHtmlNode, '生产 escapeHtml 函数应存在');
  const escapeHtmlSource = renderer.slice(escapeHtmlNode.start, escapeHtmlNode.end);
  const dialogStyles = ['styles-gemini.css', 'styles-gemini-extra.css', 'styles-dark-mode.css']
    .map(name => fs.readFileSync(path.join(root, 'src', name), 'utf8')).join('\n');
  async function setup({ useOverride = false, selectBatch = true } = {}) {
    await reset();
    await js(escapeHtmlSource + '\n;void 0;');
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
        ui: { escapeHtml, createConfirmDialog: fixtureDialogs.createConfirmDialog,
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

  async function openDeleteConfirmation() {
    await js(`settingsOverlay.querySelector('[data-action="delete-archive-batch"]').click()`);
    await js('new Promise(resolve => setTimeout(resolve, 10))');
  }

  for (const [label, summary] of [
    ['0', { fileCount: 0 }], ['1', { fileCount: 1 }], ['多份', { fileCount: 7 }],
    ['缺失 fileCount', {}], ['缺失 summary', undefined]
  ]) {
    await test(`删除确认在数量 ${label} 时只显示目标批次与操作按钮`, async () => {
      await setup();
      const prepared = { ok: true, status: 'success', confirmationToken: 'exact-token', summary };
      await js(`fixtureApi.prepareDeleteBatch = async id => {
        __settingsTest.prepares.push(id); return ${JSON.stringify(prepared)};
      }; void 0;`);
      await openDeleteConfirmation();
      const content = await js(`(() => {
        const overlay = document.getElementById('modalRoot').lastElementChild;
        const message = overlay.querySelector('.alert-message');
        return { text: message.textContent, batchNumber: message.querySelector('strong').textContent,
          breaks: message.querySelectorAll('br').length,
          buttons: Array.from(overlay.querySelectorAll('button')).map(button => button.textContent) };
      })()`);
      assert.deepEqual(content, { text: '确定永久删除批次 2026-08-11-001 吗？',
        batchNumber: '2026-08-11-001', breaks: 0, buttons: ['永久删除', '取消'] });
      assert.deepEqual(await js('__settingsTest.prepares'), ['902']);
      assert.deepEqual(await js('__settingsTest.deletes'), []);
    });
  }

  await test('删除确认使用生产转义函数安全显示含特殊字符的批次号', async () => {
    await setup();
    const batchNumber = '<em data-injected="yes">合成&批次</em> "测试"';
    await js(`settingsOverlay.querySelector('[data-action="delete-archive-batch"]').dataset.batchNumber = ${JSON.stringify(batchNumber)}`);
    await openDeleteConfirmation();
    assert.equal(await js(`document.querySelector('.alert-message').textContent`), `确定永久删除批次 ${batchNumber} 吗？`);
    assert.equal(await js(`document.querySelector('.alert-message strong').textContent`), batchNumber);
    assert.equal(await js(`document.querySelector('.alert-message em')`), null);
  });

  for (const failure of ['返回失败', '抛出异常', '缺少令牌']) {
    await test(`删除预检${failure}时不打开确认层且不提交删除`, async () => {
      await setup();
      await js(`fixtureApi.prepareDeleteBatch = async id => {
        __settingsTest.prepares.push(id);
        if (${JSON.stringify(failure)} === '抛出异常') throw new Error('预检测试失败');
        return ${JSON.stringify(failure)} === '返回失败'
          ? { ok: false, status: 'failed', message: '预检测试失败' }
          : { ok: true, status: 'success' };
      }; void 0;`);
      await openDeleteConfirmation();
      assert.equal(await js(`document.getElementById('modalRoot').children.length`), 1);
      assert.equal(await js(`settingsOverlay.querySelector('[data-action="delete-archive-batch"]').disabled`), false);
      assert.deepEqual(await js('__settingsTest.prepares'), ['902']);
      assert.deepEqual(await js('__settingsTest.deletes'), []);
      if (failure !== '缺少令牌') {
        assert.match(await js(`settingsOverlay.querySelector('[data-role="archive-feedback"]').textContent`), /预检测试失败/);
      }
    });
  }

  for (const theme of ['light', 'dark']) {
    await test(`删除确认在 ${theme} 主题下按钮可见且取消后可重新打开`, async () => {
      await setup();
      await js(`const style = document.createElement('style'); style.textContent = ${JSON.stringify(dialogStyles)};
        document.head.appendChild(style); document.documentElement.dataset.theme = ${JSON.stringify(theme)};`);
      await openDeleteConfirmation();
      await js(`document.querySelector('[data-action="cancel"]').click()`);
      assert.deepEqual(await js('__settingsTest.deletes'), []);
      await openDeleteConfirmation();
      const display = await js(`(() => {
        const overlay = document.getElementById('modalRoot').lastElementChild;
        const message = overlay.querySelector('.alert-message');
        const visible = element => {
          const box = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return box.width > 0 && box.height > 0 && box.left >= 0 && box.top >= 0
            && box.right <= innerWidth && box.bottom <= innerHeight
            && style.visibility !== 'hidden' && style.display !== 'none';
        };
        return { text: message.textContent, messageVisible: visible(message),
          overflow: message.scrollWidth > message.clientWidth + 1,
          buttons: Array.from(overlay.querySelectorAll('button')).map(button => ({
            text: button.textContent, visible: visible(button), disabled: button.disabled })) };
      })()`);
      assert.deepEqual(display, { text: '确定永久删除批次 2026-08-11-001 吗？',
        messageVisible: true, overflow: false, buttons: [
          { text: '永久删除', visible: true, disabled: false },
          { text: '取消', visible: true, disabled: false }
        ] });
      assert.deepEqual(await js('__testErrors'), []);
    });
  }

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
};
