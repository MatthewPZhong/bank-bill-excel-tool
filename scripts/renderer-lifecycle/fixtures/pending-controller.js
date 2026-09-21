'use strict';
module.exports = async ({ js, load, reset, assert, test }) => {
  async function setup() {
    await reset('<section id="pending"><button id="pendingRuleBtn"></button><button id="pendingImportBtn"></button><button id="pendingRunBtn"></button><button id="pendingExportBtn"></button><div id="pendingStatusBox"><div class="status-box-text"></div></div></section><div id="modalRoot"></div>');
    await load('src/renderer-pending.js'); await load('src/renderer/controllers/pending.js');
    await js(`(async () => {
      window.pendingCalls = []; window.pendingUnsubscribes = 0;
      window.pendingHost = __rendererModalHost; window.pendingBridge = __rendererModalBridge;
      window.pendingApi = { getRule: async () => ({matchFields:['ID'],compareFields:['金额']}), getColumns: async () => ['ID','金额'],
        listMonths: async () => ['2026-03','2026-02'], pickFiles: async () => ({files:['/source.xlsx']}),
        startImport: value => { pendingCalls.push(value); return new Promise(resolve => window.finishPendingImport=resolve); },
        onImportProgress: listener => { window.pendingProgress=listener; return () => pendingUnsubscribes++; },
        reconcile: {run: async value => ({runId:81,statNew:1,statMissing:2,statChanged:3,removalMatch:{error:true}})},
        diff:{listAllRuns:async () => [{id:81,lowerMonth:'2026-03',upperMonth:'2026-02',ruleSnapshot:{}}],
          exportSingle: async value => { pendingCalls.push(value); return {status:'success',path:'/difference.xlsx',rowCount:9}; },
          exportAggregate: async () => ({status:'success',path:'/aggregate.xlsx',rowCount:10,removalDataOmitted:true})}
      };
      window.pendingAlert = (message) => {
        const overlay=document.createElement('div'); overlay.className='modal-overlay';
        overlay.innerHTML='<div class="modal-card"><div class="message"></div><button>关闭</button></div>';
        overlay.querySelector('.message').innerHTML=message;
        overlay.querySelector('button').onclick=()=>pendingBridge.closeModal(overlay); return overlay;
      };
      window.pendingConfirm = options => {
        const overlay=document.createElement('div'); overlay.className='modal-overlay';
        overlay.innerHTML='<div class="modal-card"><div class="message"></div><button data-action="confirm">确认</button><button data-action="cancel">取消</button></div>';
        overlay.querySelector('.message').innerHTML=options.message;
        overlay.querySelector('[data-action="confirm"]').onclick=options.onConfirm;
        overlay.querySelector('[data-action="cancel"]').onclick=()=>pendingBridge.closeModal(overlay); return overlay;
      };
      window.pendingController=__pendingController.createPendingController({api:pendingApi,panel:document.getElementById('pending'),ui:{
        modalHost:pendingHost,modalBridge:pendingBridge,createAlertDialog:pendingAlert,createConfirmDialog:pendingConfirm,
        reportError:error=>__testErrors.push(error.message)
      }});
      await pendingController.enter();
    })()`);
  }
  const flush = () => js(`new Promise(resolve => setTimeout(resolve, 5))`);
  await test('Pending 实际月份选择保留原覆盖 contextId，导航后晚到结果不再弹移除流程', async () => {
    await setup();
    await js(`pendingController.importFiles();`); await flush();
    await js(`document.querySelector('.pending-import-month-dialog .primary-btn').click();`); await flush();
    assert.equal((await js(`pendingCalls`)).length, 1);
    assert.deepEqual((await js(`pendingCalls[0].files`)), ['/source.xlsx']);
    await js(`finishPendingImport({status:'need-confirm',contextId:'original-context',existingRowCount:2});`); await flush();
    await js(`document.querySelector('[data-action="confirm"]').click();`); await flush();
    assert.deepEqual(await js(`pendingCalls[1]`), {contextId:'original-context',confirmOverwrite:true});
    await js(`pendingController.leave(); window.other=pendingBridge.openModal(()=>pendingAlert('另一领域')).handle; finishPendingImport({status:'success',rowCount:7,archivePath:'/archive.xlsx'});`); await flush();
    assert.equal(await js(`other.isTop()`), true);
    assert.match(await js(`pendingController.getSnapshot().lastImportSummary`), /7 行.*旧数据已留底/);
    await js(`(async () => {other.close(); await pendingController.enter(); pendingController.dispose(); pendingController.dispose();})()`);
    assert.equal(await js(`pendingUnsubscribes`), 1);
  });
  await test('Pending 实际对账路径保留总差异与移除失败反馈，离页重进不覆盖成功文案', async () => {
    await setup();
    await js(`pendingController.run();`); await flush();
    await js(`document.querySelector('.pending-reconcile-dialog .primary-btn').click();`); await flush();
    await js(`document.querySelector('[data-action="confirm"]').click();`); await flush();
    assert.match(await js(`document.querySelector('.status-box-text').textContent`), /找出 6 条差异.*1 新增 \/ 2 消失 \/ 3 变更.*移除核对执行异常/);
    await js(`(async () => {pendingController.leave(); await pendingController.enter();})()`);
    assert.match(await js(`document.querySelector('.status-box-text').textContent`), /找出 6 条差异/);
  });
  await test('Pending 聚合导出保留行数、changed 配对与移除 sheet 提示', async () => {
    await setup();
    await js(`pendingController.export();`); await flush();
    await js(`var choices=document.querySelectorAll('.pending-export-dialog input[type="radio"]'); choices[1].checked=true; choices[1].dispatchEvent(new Event('change')); document.querySelector('.pending-export-dialog .primary-btn').click();`); await flush();
    assert.match(await js(`document.querySelector('.message').textContent`), /aggregate.xlsx.*10 行.*changed 每对展 2 行.*聚合导出不含移除核对 sheet/);
  });
  await test('Pending 规则和月份确认取消保留父视图与草稿，父取消仍可关闭', async () => {
    await setup();
    await js(`pendingController.editRule();`); await flush();
    await js(`window.ruleParent=document.querySelector('.pending-rule-dialog').parentElement;document.querySelector('.pending-rule-dialog .primary-btn').click();`); await flush();
    assert.equal(await js(`document.getElementById('modalRoot').children.length`), 2);
    await js(`document.querySelector('[data-action="cancel"]').click();`);
    assert.equal(await js(`ruleParent.isConnected`), true);
    await js(`document.querySelector('.pending-rule-dialog .secondary-btn').click();pendingController.run();`); await flush();
    await js(`window.monthParent=document.querySelector('.pending-reconcile-dialog').parentElement;document.querySelector('.pending-reconcile-dialog .primary-btn').click();`); await flush();
    assert.equal(await js(`document.getElementById('modalRoot').children.length`), 2);
    await js(`document.querySelector('[data-action="cancel"]').click();`);
    assert.equal(await js(`monthParent.isConnected`), true);
    await js(`document.querySelector('.pending-reconcile-dialog .secondary-btn').click();`);
    assert.equal(await js(`document.getElementById('modalRoot').children.length`), 0);
  });
  await test('Pending 旧保存完成不能关闭后来窗口', async () => {
    await setup();
    await js(`pendingApi.saveRule = value => new Promise(resolve => window.finishSave=resolve); pendingController.editRule();`); await flush();
    await js(`document.querySelector('.pending-rule-dialog .primary-btn').click();`); await flush();
    await js(`document.querySelector('[data-action="confirm"]').click();`); await flush();
    await js(`pendingController.leave(); window.other=pendingBridge.openModal(()=>pendingAlert('新窗口')).handle; finishSave({matchFields:['ID'],compareFields:['金额']});`); await flush();
    assert.equal(await js(`other.isTop()`), true);
    assert.equal(await js(`document.querySelector('.message').textContent`), '新窗口');
  });
};
