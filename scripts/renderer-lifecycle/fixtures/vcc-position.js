'use strict';

module.exports = async ({ js, load, reset, assert, test }) => {
  async function setup() {
    await reset(`<div id="modalRoot"></div>
      <section id="fixtureVccPanel"><button id="vccFinancialOpImportBtn"></button><button id="vccFinancialOpRunBtn"></button>
      <button id="vccFinancialOpExportBtn"></button><button id="vccFinancialOpDataManagerBtn"></button>
      <div id="vccFinancialOpStatusBox"><span class="status-box-text"></span></div>
      </section><section id="fixturePositionPanel"><select id="positionReconciliationFunctionSelect"><option value="position-fund-nature-check">性质</option></select>
      <button id="positionReconciliationRunBtn"></button><button id="positionReconciliationTableManagerBtn"></button>
      <button id="positionReconciliationLinkedTableManagerBtn"></button><button id="positionReconciliationConfigBtn"></button>
      <button id="positionReconciliationExportBtn"></button><div id="positionReconciliationStatusBox"><span class="status-box-text"></span></div></section>`);
    await js(`window.fixture = {
      counts: { months: 0, imports: 0, archived: 0, mapping: 0, delete: 0, subscription: 0, unsubscribe: 0 },
      deferred() { let resolve, reject; const promise = new Promise((yes, no) => {resolve=yes; reject=no;}); return {promise, resolve, reject}; },
      node() { const overlay=document.createElement('div'); overlay.className='modal-overlay'; overlay.innerHTML='<section class="modal-card"><button>替代页</button></section>'; return overlay; },
      tick: () => new Promise(resolve => setTimeout(resolve, 0)),
      clickText(text, root=document.getElementById('modalRoot')) { const button=[...root.querySelectorAll('button')].find(item=>item.textContent===text); if(!button)throw new Error('Missing button '+text); button.click(); }
    };
    window.desktopApi = { previewCapture: true, app: { reportLog(){} }, vccFinancialOp: {
      listArchivedResultMonths: async()=>{fixture.counts.archived++;return [];},
      listImportMonths: async()=>{fixture.counts.months++;return fixture.months?.promise || [];},
      listImportRecords: async()=>[], listOverview: async()=>[], listRunOverview: async()=>[],
      listDeleteTargets: async()=>({status:'success',targets:[]}),
      previewDatasetExport: async()=>({status:'success',exportable:true,dataCount:10})
    }};
    fixture.api={ status: async()=>({status:'ok',canRun:true}),
      dataManager: async()=>({status:'ok',unarchived:[],archived:[],differences:[]}),
      linkedManager: async()=>({status:'ok',linked:[],raw:[],sourceMonths:{}}),
      listMappings: async()=>{fixture.counts.mapping++;return fixture.mapping?.promise || {status:'ok',mappings:[]};},
      saveMappings: async()=>({status:'ok',message:'已保存'}),
      deleteSource: async()=>{fixture.counts.delete++;return {status:'ok',message:'已删除'};},
      onImportProgress: fn=>{fixture.counts.subscription++;fixture.progress=fn;return ()=>fixture.counts.unsubscribe++;}
    }; void 0;`);
    await load('src/renderer/dialogs/toolbox.js');
    await load('src/renderer-dialogs.js');
    await load('src/renderer-position-reconciliation.js');
    await js(`fixture.dialogs = window.__createTestRendererDialogs({ state:{}, elements:{ modalRoot:document.getElementById('modalRoot') },
      desktopApi:window.desktopApi, modalBridge:window.__rendererModalBridge });
      fixture.ui=window.__positionReconciliation.createPositionReconciliationUI({api:fixture.api,panel:document.getElementById("fixturePositionPanel"),
        modalHost:window.__rendererModalHost,modalBridge:window.__rendererModalBridge,
        createAlertDialog:fixture.dialogs.createAlertDialog,createConfirmDialog:fixture.dialogs.createConfirmDialog}); void 0;`);
    await load('src/shared/vcc-review-projection.js');
    await load('src/shared/vcc-financial-op-difference.js');
    await load('src/renderer-vcc-financial-op.js');
    await js(`fixture.vcc=window.__vccFinancialOpController.createVccFinancialOpController({
      api:window.desktopApi.vccFinancialOp,panel:document.getElementById('fixtureVccPanel'),
      modalHost:window.__rendererModalHost,differenceApi:window.__vccFinancialOpDifference,
      reviewProjection:window.__vccReviewProjection,previewEnabled:true});
      fixture.beforeEnter={...fixture.counts}; Promise.all([fixture.ui.enter(),fixture.vcc.enter()]);`);
  }

  await test('VCC 月份 Promise 在公共替换后恰好以取消收尾', async () => {
    await setup();
    const result = await js(`(async()=>{
      let settlements=0; const pending=window.__vccFinancialOpPreview.openRunMonth().then(value=>{settlements++;return value;});
      const old=window.__rendererModalHost.getTop();
      const opened=window.__rendererModalBridge.openModal(()=>fixture.node(),{owner:'another-domain'});
      const value=await pending;
      old.close(); await fixture.tick();
      return {value,settlements,status:opened.status,count:document.getElementById('modalRoot').children.length};
    })()`);
    assert.deepEqual(result, { value: null, settlements: 1, status: 'opened', count: 1 });
  });

  await test('VCC 根入口被忙碌窗口拒绝时不发列表 IPC、不构建窗口', async () => {
    await setup();
    const result = await js(`(async()=>{
      const busy=window.__rendererModalHost.openRoot(()=>{const overlay=fixture.node();return {overlay,dialog:overlay.firstElementChild,canClose:()=>false};},{owner:'busy'});
      document.getElementById('vccFinancialOpDataManagerBtn').click();
      document.getElementById('vccFinancialOpRunBtn').click();
      await fixture.tick();
      return {months:fixture.counts.months,owner:window.__rendererModalHost.getTop().owner,count:document.getElementById('modalRoot').children.length};
    })()`);
    assert.deepEqual(result, { months: 0, owner: 'busy', count: 1 });
  });

  await test('VCC 管理读取晚到后不更新旧节点或重开弹窗', async () => {
    await setup();
    const result = await js(`(async()=>{
      fixture.months=fixture.deferred(); document.getElementById('vccFinancialOpDataManagerBtn').click();
      const old=document.getElementById('modalRoot').firstElementChild;
      const before=old.innerHTML;
      window.__rendererModalBridge.openModal(()=>fixture.node(),{owner:'another-domain'});
      fixture.months.resolve(['2026-06']); await fixture.tick(); await fixture.tick();
      return {unchanged:old.innerHTML===before,connected:old.isConnected,owner:window.__rendererModalHost.getTop().owner,errors:window.__testErrors};
    })()`);
    assert.deepEqual(result, { unchanged: true, connected: false, owner: 'another-domain', errors: [] });
  });

  await test('VCC 真实结果导出忙碌时拒绝根替换，强制销毁退订一次', async () => {
    await setup();
    const result = await js(`(async()=>{
      fixture.export=fixture.deferred();let subscribe=0,unsubscribe=0;
      window.desktopApi.vccFinancialOp.exportReviewTable=()=>fixture.export.promise;
      window.desktopApi.vccFinancialOp.onOperationProgress=()=>{subscribe++;return ()=>unsubscribe++;};
      fixture.review=window.__vccFinancialOpPreview.openResult();
      document.querySelector('[data-action="export-review"]').click();await fixture.tick();
      const blocked=window.__rendererModalBridge.openModal(()=>fixture.node(),{owner:'another-domain'});
      window.__rendererModalHost.dispose();await fixture.review;
      fixture.export.resolve({status:'cancelled'});await fixture.tick();await fixture.tick();
      return {blocked:blocked.status,subscribe,unsubscribe,count:document.getElementById('modalRoot').children.length,errors:window.__testErrors};
    })()`);
    assert.deepEqual(result, { blocked: 'blocked', subscribe: 1, unsubscribe: 1, count: 0, errors: [] });
  });

  await test('VCC 预览定时选项在弹窗关闭时停止且只返回快照', async () => {
    await setup();
    const result = await js(`(async()=>{
      const pending=window.__vccFinancialOpPreview.openDeleteFirstMonth();
      const old=document.getElementById('modalRoot').firstElementChild;
      const before=old.innerHTML;
      window.__rendererModalHost.closeTop();
      const snapshot=await pending;await fixture.tick();
      return {snapshot,unchanged:before===old.innerHTML,count:document.getElementById('modalRoot').children.length};
    })()`);
    assert.deepEqual(result, { snapshot: { modalPresent: false }, unchanged: true, count: 0 });
  });

  await test('VCC 解归档成功后的父窗刷新晚到不能复活告警', async () => {
    await setup();
    const result = await js(`(async()=>{
      await window.__vccFinancialOpPreview.openDataManager();
      window.desktopApi.vccFinancialOp.previewUnarchive=async()=>({status:'success',canUnarchive:true,previewToken:'token',taskGeneration:2});
      window.desktopApi.vccFinancialOp.unarchiveMonth=async()=>({status:'success',targetMonth:'2026-06'});
      fixture.archives=fixture.deferred();window.desktopApi.vccFinancialOp.listArchivedResultMonths=()=>fixture.archives.promise;
      document.querySelector('[data-action="unarchive"]').click();await fixture.tick();await fixture.tick();
      const checkbox=document.querySelector('[data-field="archive-picker-confirm"]');checkbox.checked=true;checkbox.dispatchEvent(new Event('change'));
      document.querySelector('[data-action="archive-picker-confirm"]').click();await fixture.tick();
      window.__rendererModalBridge.openModal(()=>fixture.node(),{owner:'another-domain'});
      fixture.archives.resolve([]);await fixture.tick();await fixture.tick();
      return {owner:window.__rendererModalHost.getTop().owner,count:document.getElementById('modalRoot').children.length,errors:window.__testErrors};
    })()`);
    assert.deepEqual(result, { owner: 'another-domain', count: 1, errors: [] });
  });

  await test('Position 归档空提示确认后保留原管理父窗', async () => {
    await setup();
    const result = await js(`(async()=>{
      await fixture.ui.previewDataManager();const parent=document.getElementById('modalRoot').firstElementChild;
      fixture.clickText('归档',parent);await fixture.tick();
      const count=document.getElementById('modalRoot').children.length;
      fixture.clickText('返回',document.getElementById('modalRoot').lastElementChild);await fixture.tick();
      return {count,parentPresent:parent.isConnected,restored:!parent.inert,remaining:document.getElementById('modalRoot').children.length};
    })()`);
    assert.deepEqual(result, { count: 2, parentPresent: true, restored: true, remaining: 1 });
  });

  await test('Position 链接管理→账户映射→关闭直接返回原父层', async () => {
    await setup();
    const result = await js(`(async()=>{
      await fixture.ui.previewLinkedManager(); const parent=document.getElementById('modalRoot').firstElementChild;
      fixture.clickText('账户映射管理',parent); await fixture.tick(); await fixture.tick();
      const child=window.__rendererModalHost.getTop(); const during={count:document.getElementById('modalRoot').children.length,inert:parent.inert};
      child.close(); await fixture.tick();
      return {during,stillMounted:parent.isConnected,restored:!parent.inert,count:document.getElementById('modalRoot').children.length,errors:window.__testErrors};
    })()`);
    assert.deepEqual(result, { during: { count: 2, inert: true }, stillMounted: true, restored: true, count: 1, errors: [] });
  });

  await test('Position 读取未返回时替换父域，迟到映射不能弹回', async () => {
    await setup();
    const result = await js(`(async()=>{
      await fixture.ui.previewLinkedManager(); fixture.mapping=fixture.deferred();
      fixture.clickText('账户映射管理'); await fixture.tick();
      window.__rendererModalBridge.openModal(()=>fixture.node(),{owner:'another-domain'});
      fixture.mapping.resolve({status:'ok',mappings:[]}); await fixture.tick();await fixture.tick();
      return {owner:window.__rendererModalHost.getTop().owner,count:document.getElementById('modalRoot').children.length,errors:window.__testErrors};
    })()`);
    assert.deepEqual(result, { owner: 'another-domain', count: 1, errors: [] });
  });

  await test('Position confirmAction 在 navigation 取消后不执行删除', async () => {
    await setup();
    const result = await js(`(async()=>{
      await fixture.ui.previewLinkedManager(); fixture.clickText('删除');await fixture.tick();
      const picker=document.getElementById('modalRoot').lastElementChild;
      fixture.clickText('删除',picker); await fixture.tick();
      const before=document.getElementById('modalRoot').children.length;
      window.__rendererModalHost.closeOwner('position-reconciliation-process','navigation');await fixture.tick();
      return {before,deletes:fixture.counts.delete,count:document.getElementById('modalRoot').children.length,errors:window.__testErrors};
    })()`);
    assert.deepEqual(result, { before: 3, deletes: 0, count: 0, errors: [] });
  });

  await test('Position 确认删除只提交一次并保留原管理父窗', async () => {
    await setup();
    const result = await js(`(async()=>{
      await fixture.ui.previewLinkedManager(); const parent=document.getElementById('modalRoot').firstElementChild;
      fixture.clickText('删除');await fixture.tick();
      fixture.clickText('删除',document.getElementById('modalRoot').lastElementChild);await fixture.tick();
      fixture.clickText('确认删除',document.getElementById('modalRoot').lastElementChild);await fixture.tick();await fixture.tick();
      return {deletes:fixture.counts.delete,parentPresent:parent.isConnected,count:document.getElementById('modalRoot').children.length,errors:window.__testErrors};
    })()`);
    assert.deepEqual(result, { deletes: 1, parentPresent: true, count: 1, errors: [] });
  });

  await test('Position 进度订阅随强制销毁仅清理一次，晚到进度不改旧 DOM', async () => {
    await setup();
    const result = await js(`(async()=>{
      fixture.ui.previewImportProgress(); await fixture.tick();
      const old=document.getElementById('modalRoot').firstElementChild, before=old.innerHTML;
      const blocked=window.__rendererModalBridge.openModal(()=>fixture.node(),{owner:'another-domain'});
      window.__rendererModalHost.dispose();window.__rendererModalHost.dispose();
      fixture.progress({stage:'committing',scannedRows:99});
      return {blocked:blocked.status,subscriptions:fixture.counts.subscription,unsubscribes:fixture.counts.unsubscribe,unchanged:old.innerHTML===before,count:document.getElementById('modalRoot').children.length};
    })()`);
    assert.deepEqual(result, { blocked: 'blocked', subscriptions: 1, unsubscribes: 1, unchanged: true, count: 0 });
  });
  await test('Position 与 VCC 工厂构造不读 Main，重复 enter 不累积按钮监听，dispose 后按钮无效', async () => {
    await setup();
    const result = await js(`(async()=>{
      const initial=fixture.beforeEnter.archived;
      await fixture.ui.enter();await fixture.vcc.enter();
      fixture.ui.dispose();fixture.vcc.dispose();
      const before=JSON.stringify(fixture.counts);
      document.getElementById('vccFinancialOpDataManagerBtn').click();document.getElementById('positionReconciliationTableManagerBtn').click();
      await fixture.tick();
      return {initial,noCalls:before===JSON.stringify(fixture.counts),count:document.getElementById('modalRoot').children.length,position:(await fixture.ui.enter()).status,vcc:(await fixture.vcc.enter()).status,errors:window.__testErrors};
    })()`);
    assert.deepEqual(result,{initial:0,noCalls:true,count:0,position:'stale',vcc:'stale',errors:[]});
  });

  await test('Position A/B/A 旧状态不覆盖新结果与按钮', async () => {
    await setup();
    const result = await js(`(async()=>{
      fixture.first=fixture.deferred();fixture.second=fixture.deferred();let reads=0;
      fixture.api.status=()=>++reads===1?fixture.first.promise:fixture.second.promise;
      const old=fixture.ui.enter();fixture.ui.leave();const latest=fixture.ui.enter();
      fixture.second.resolve({status:'ok',canRun:true,canExport:true,pendingRun:{id:1}});await latest;
      fixture.first.resolve({status:'ok',canRun:false,canExport:false});const late=await old;
      return {late:late.status,run:document.getElementById('positionReconciliationRunBtn').disabled,export:document.getElementById('positionReconciliationExportBtn').disabled};
    })()`);
    assert.deepEqual(result,{late:'stale',run:false,export:false});
  });

  await test('VCC A/B/A 旧归档状态不关闭新的导出入口；busy 月份执行阻止导航', async () => {
    await setup();
    const result = await js(`(async()=>{
      fixture.first=fixture.deferred();fixture.second=fixture.deferred();let reads=0;
      window.desktopApi.vccFinancialOp.listArchivedResultMonths=()=>++reads===1?fixture.first.promise:fixture.second.promise;
      const old=fixture.vcc.enter();fixture.vcc.leave();const latest=fixture.vcc.enter();
      fixture.second.resolve([{targetMonth:'2026-08',runId:11}]);await latest;
      fixture.first.resolve([]);const late=await old;
      const exportDisabled=document.getElementById('vccFinancialOpExportBtn').disabled;
      await fixture.vcc.preview.openUnarchiveExecuting();const left=fixture.vcc.leave();fixture.vcc.dispose();
      return {late:late.status,exportDisabled,left:left.status,count:document.getElementById('modalRoot').children.length,errors:window.__testErrors};
    })()`);
    assert.deepEqual(result,{late:'stale',exportDisabled:false,left:'blocked',count:0,errors:[]});
  });

  await test('VCC 新访问早于后台文件识别完成，只重读当前归档状态，不续开旧导入确认', async () => {
    await setup();
    const result = await js(`(async()=>{
      fixture.picking=fixture.deferred();window.desktopApi.vccFinancialOp.pickFiles=()=>fixture.picking.promise;
      let stop=0;window.desktopApi.vccFinancialOp.onImportProgress=()=>()=>stop++;
      const importing=fixture.vcc.commands.import();document.querySelector('[data-field="import-year"]').value=String(new Date().getFullYear());document.querySelector('[data-field="import-month"]').value='09';document.querySelector('[data-action="confirm"]').click();await fixture.tick();
      const left=fixture.vcc.leave();await fixture.vcc.enter();
      fixture.picking.resolve({status:'error',message:'旧识别失败'});await importing;await fixture.tick();
      return {left:left.status,stop,archived:fixture.counts.archived,disabled:document.getElementById('vccFinancialOpImportBtn').disabled,label:document.getElementById('vccFinancialOpImportBtn').textContent,count:document.getElementById('modalRoot').children.length,status:document.getElementById('vccFinancialOpStatusBox').textContent,errors:window.__testErrors};
    })()`);
    assert.equal(result.left,'left');assert.equal(result.stop,1);assert.equal(result.archived,3);
    assert.equal(result.disabled,false);assert.equal(result.label,'导入文件');assert.equal(result.count,0);
    assert.doesNotMatch(result.status,/旧识别失败/);assert.deepEqual(result.errors,[]);
  });

  await test('Position 导入确认被导航取消时释放银行预备 token', async () => {
    await setup();
    const result = await js(`(async()=>{
      let cancelled=0,applied=0;
      fixture.api.prepareBankImport=async()=>({status:'needs-confirmation',token:'bank-prepared',fileCount:1,rowCount:12});
      fixture.api.cancelBankImport=async()=>{cancelled++;return {status:'cancelled'};};
      fixture.api.applyBankImport=async()=>{applied++;return {status:'ok'};};
      const task=fixture.ui.handleBankImport();await fixture.tick();await fixture.tick();
      const confirmation=document.getElementById('modalRoot').textContent.includes('确认导入 1 个文件');
      const left=fixture.ui.leave();await task;
      return {confirmation,left:left.status,cancelled,applied,count:document.getElementById('modalRoot').children.length};
    })()`);
    assert.deepEqual(result,{confirmation:true,left:'left',cancelled:1,applied:0,count:0});
  });

  await test('Position 导航取消源表确认时释放本批全部尚未提交 token', async () => {
    await setup();
    const result = await js(`(async()=>{
      const cancelled=[];let applied=0;
      fixture.api.prepareSourceImport=async()=>({status:'ok',results:[
        {status:'needs-confirmation',token:'source-a',oldValidCount:5,newValidCount:10},
        {status:'needs-confirmation',token:'source-b',oldValidCount:8,newValidCount:12}]});
      fixture.api.cancelSourceImport=async token=>{cancelled.push(token);return {status:'cancelled'};};
      fixture.api.applySourceImport=async()=>{applied++;return {status:'ok'};};
      const task=fixture.ui.handleSourceImport();await fixture.tick();await fixture.tick();
      const confirmation=document.getElementById('modalRoot').textContent.includes('清结算银行账户表将全量替换');
      const left=fixture.ui.leave();await task;
      return {confirmation,left:left.status,cancelled,applied,count:document.getElementById('modalRoot').children.length};
    })()`);
    assert.deepEqual(result,{confirmation:true,left:'left',cancelled:['source-a','source-b'],applied:0,count:0});
  });

  await test('Position 已提交银行写入仍拒绝导航，不把提交当作取消', async () => {
    await setup();
    const result = await js(`(async()=>{
      let cancelled=0,applied=0;fixture.write=fixture.deferred();
      fixture.api.prepareBankImport=async()=>({status:'needs-confirmation',token:'bank-prepared',fileCount:1,rowCount:12});
      fixture.api.cancelBankImport=async()=>{cancelled++;return {status:'cancelled'};};
      fixture.api.applyBankImport=()=>{applied++;return fixture.write.promise;};
      const task=fixture.ui.handleBankImport();await fixture.tick();await fixture.tick();
      fixture.clickText('确认导入');await fixture.tick();
      const left=fixture.ui.leave();fixture.write.resolve({status:'ok',message:'已写入'});await task;
      return {left:left.status,cancelled,applied,count:document.getElementById('modalRoot').children.length};
    })()`);
    assert.deepEqual(result,{left:'blocked',cancelled:0,applied:1,count:0});
  });

  for (const [label,hook,method,selector] of [
    ['删除','openDeleteResult','deleteDataTarget','confirm-delete'],
    ['数据导出','openExport','exportDataset','confirm-export']
  ]) {
    await test(`VCC ${label}窗口强制销毁并重进后，后台完成释放busy且不续开旧弹窗`, async () => {
      await setup();
      const result = await js(`(async()=>{
        fixture.work=fixture.deferred();let submitted=0,cancelled=0;
        window.desktopApi.vccFinancialOp['${method}']=()=>{submitted++;return fixture.work.promise;};
        window.desktopApi.vccFinancialOp.cancelTask=async()=>{cancelled++;return {status:'cancelled'};};
        await fixture.vcc.preview['${hook}']();document.querySelector('[data-action="${selector}"]').click();await fixture.tick();
        const blocked=fixture.vcc.leave();window.__rendererModalHost.getTop().dispose();
        const left=fixture.vcc.leave();await fixture.vcc.enter();
        fixture.work.resolve({status:'success',targetMonth:'2026-06'});await fixture.tick();await fixture.tick();
        return {blocked:blocked.status,left:left.status,submitted,cancelled,importDisabled:document.getElementById('vccFinancialOpImportBtn').disabled,runDisabled:document.getElementById('vccFinancialOpRunBtn').disabled,count:document.getElementById('modalRoot').children.length,errors:window.__testErrors};
      })()`);
      assert.deepEqual(result,{blocked:'blocked',left:'left',submitted:1,cancelled:0,importDisabled:false,runDisabled:false,count:0,errors:[]});
    });
  }

};
