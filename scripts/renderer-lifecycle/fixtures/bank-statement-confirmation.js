'use strict';

// 真实 BankStatement controller + confirm/picker 工厂 + bridge/host + Electron DOM。
// API 仅记录调用，不加载产品 Main、文件或真实业务数据。
module.exports = async ({ js, load, reset, assert, test }) => {
  const ids = ['bankStatementScenarioBtn', 'bankStatementImportBtn', 'bankStatementRunBtn',
    'bankStatementExportBtn', 'bankStatementStatusBox', 'bankStatementLinkedTableBtn'];
  const routes = [
    ['refund', 'confirm', 'batchImport'], ['refund', 'middle', 'run'],
    ['c3', 'confirm', 'linkedImport'], ['c3', 'middle', 'run']
  ];
  const flush = () => js('new Promise(resolve => setTimeout(resolve, 10))');
  async function setup(kind, afterImport = false) {
    await reset('<div id="modalRoot"></div><div id="panel">'
      + ids.map(id => `<button id="${id}"></button>`).join('') + '</div>');
    await load('src/renderer/dialogs/toolbox.js');
    await load('src/renderer/controllers/bank-statement.js');
    await load('src/renderer-dialogs.js');
    await js(`
      window.probe={errors:[],calls:[],handles:[],allowClose:true,afterImport:${afterImport},kind:${JSON.stringify(kind)}};
      window.addEventListener('error',event=>{probe.errors.push(String(event.error?.stack||event.message));event.preventDefault();});
      window.addEventListener('unhandledrejection',event=>{probe.errors.push(String(event.reason?.stack||event.reason));event.preventDefault();});
      window.host=__rendererModalHost;window.bridge=__rendererModalBridge;
      const services=ConfigurationServices.createConfigurationServices({templatesApi:{list:async()=>[]}});
      const dialogs=__rendererDialogs.createRendererDialogs({modalBridge:bridge,configurationServices:services,
        configurationApi:{},dialogApis:{},appConstants:{},scenarioCommands:{scenarios:{},channels:{}},
        scenarioSubscriptions:{subscribeScenarios:()=>()=>{},subscribeChannels:()=>()=>{}}});
      const scenarios=[];
      if(['refund','both'].includes(probe.kind))scenarios.push({id:1,name:'中台退款订单回填',category:'builtin-fixed',enabled:true});
      if(['c3','both'].includes(probe.kind))scenarios.push({id:2,name:'C3',category:'gateway-recon-join',enabled:true});
      if(probe.kind==='gateway')scenarios.push({id:3,name:'网关A',category:'gateway-recon-id-fix',enabled:true},{id:4,name:'网关B',category:'gateway-recon-id-fix',enabled:true});
      const record=kind=>probe.calls.push({kind,modalOpen:probe.handles.at(-1)?.isOpen()===true});
      window.bank=BankStatementController.createBankStatementController({panel:document.getElementById('panel'),
        api:{sessionStatus:async()=>({status:'ok',hasBankStatement:true,hasRefundOrder:false,bankStatementFileName:'fixture.xlsx'}),
          refundCandidateCount:async()=>({status:'ok',candidateCount:1}),c3CandidateCount:async()=>({status:'ok',candidateCount:1}),
          run:async()=>{record('run');return {status:'ok'};},
          batchImport:async()=>{record('batchImport');if(probe.afterImport){probe.afterImport=false;return {status:'ok',results:[{status:'ok',tableKey:'bank-statement'}]};}return {status:'cancelled'};}},
        config:{scenarios:{list:async()=>({status:'ok',scenarios})},linkedTable:{rowCount:async()=>({status:'ok',rowCount:0}),
          import:async()=>{record('linkedImport');return {status:'ok',results:[]};}}},
        sharedReconSession:{sessionStatus:async()=>({status:'ok',hasFile:true}),subscribe:()=>()=>{},
          run:async()=>{record('gatewayRun');return {status:'ok',stats:{fixedRowCount:1}};}},
        ui:{modalHost:{openRoot:(...args)=>{const result=bridge.openModal(...args);if(result.handle)probe.handles.push(result.handle);return result;},closeOwner:host.closeOwner},
          confirm:options=>bridge.registerModal(dialogs.createConfirmDialog(options),{canClose:()=>probe.allowClose}),
          gatewayScenarioPicker:options=>bridge.registerModal(dialogs.createGatewayReconScenarioPickerDialog(options),{canClose:()=>probe.allowClose}),
          alert:dialogs.createAlertDialog,reportError:error=>probe.errors.push(String(error?.stack||error))}});
      void 0;
    `);
    await js('bank.enter()');
    if (kind === 'gateway') await js("bank.commands.selectRunMode('gateway')");
    await js(afterImport ? 'bank.commands.import()' : 'bank.commands.run()');
    assert.equal(await js('probe.handles.length'), 1, '真实 controller 应打开一个确认框');
    await js('window.originalHandle=probe.handles[0];void 0;');
  }
  async function clean() {
    await flush();
    assert.deepEqual(await js('[...probe.errors,...__testErrors]'), [], '不得出现宿主合同异常或未处理回调错误');
  }
  async function click(choice) {
    await js(`document.querySelector('[data-action="${choice}"]').click();void 0;`);
    await flush();
  }
  async function expectCalls(kinds) {
    assert.deepEqual(await js('probe.calls'), kinds.map(kind => ({ kind, modalOpen: false })), '业务必须在原确认框成功关闭后调用');
  }

  for (const [kind, choice, operation] of routes) {
    const label = `${kind}/${choice}`;
    await test(`银行确认 ${label} 真实点击以 submitted 关闭后仅执行一次业务`, async () => {
      await setup(kind);
      await click(choice);
      await expectCalls([operation]);
      assert.equal(await js('originalHandle.isOpen()'), false);
      assert.equal((await js('originalHandle.closed')).status, 'submitted');
      assert.equal(await js('host.getTop()'), null);
      await clean();
    });
    await test(`银行确认 ${label} busy/canClose 拒绝关闭时保留弹窗且不执行业务`, async () => {
      await setup(kind);
      await js('probe.allowClose=false;void 0;');
      await click(choice);
      await expectCalls([]);
      assert.equal(await js('originalHandle.isOpen() && originalHandle.isTop()'), true);
      await js('probe.allowClose=true;void 0;');
      await click(choice);
      await expectCalls([operation]);
      assert.equal((await js('originalHandle.closed')).status, 'submitted');
      await clean();
    });
    await test(`银行确认 ${label} 被替换的旧按钮不能关闭新弹窗或启动业务`, async () => {
      await setup(kind);
      await js(`window.oldButton=document.querySelector('[data-action="${choice}"]');void 0;`);
      await js('bank.commands.run()');
      assert.equal(await js('probe.handles.length'), 2);
      assert.deepEqual(await js('originalHandle.closed'), { status: 'cancelled', reason: 'replaced' });
      await js('oldButton.click();void 0;');
      await flush();
      await expectCalls([]);
      assert.equal(await js('host.getTop()===probe.handles[1] && probe.handles[1].isOpen()'), true);
      await click(choice);
      await expectCalls([operation]);
      await clean();
    });
    await test(`银行确认 ${label} 旧按钮重复点击不能重复业务`, async () => {
      await setup(kind);
      await js(`window.oldButton=document.querySelector('[data-action="${choice}"]');oldButton.click();oldButton.click();void 0;`);
      await flush();
      await expectCalls([operation]);
      await js('oldButton.click();void 0;');
      await flush();
      await expectCalls([operation]);
      await clean();
    });
    await test(`银行确认 ${label} 导航后的旧按钮不能启动业务`, async () => {
      await setup(kind);
      await js(`window.oldButton=document.querySelector('[data-action="${choice}"]');bank.leave();void 0;`);
      await js('bank.enter()');
      await js('oldButton.click();void 0;');
      await flush();
      await expectCalls([]);
      assert.deepEqual(await js('originalHandle.closed'), { status: 'cancelled', reason: 'navigation' });
      await clean();
    });
  }
  for (const kind of ['refund', 'c3']) {
    await test(`银行确认 ${kind} 取消保持 cancelled 且不执行业务`, async () => {
      await setup(kind);
      await click('cancel');
      await expectCalls([]);
      assert.deepEqual(await js('originalHandle.closed'), { status: 'cancelled', reason: 'cancel' });
      await clean();
    });
    await test(`银行导入后的 ${kind} 提示仍可用真实确认按钮补充文件`, async () => {
      await setup(kind, true);
      await click('confirm');
      await expectCalls(['batchImport', kind === 'refund' ? 'batchImport' : 'linkedImport']);
      assert.equal((await js('originalHandle.closed')).status, 'submitted');
      await clean();
    });
  }
  await test('银行退款直接运行后仍先显示 C3 提示，再确认才运行', async () => {
    await setup('both');
    await click('middle');
    await expectCalls([]);
    assert.equal((await js('originalHandle.closed')).status, 'submitted');
    assert.match(await js('document.getElementById("modalRoot").textContent'), /网关对账单/);
    await click('middle');
    await expectCalls(['run']);
    assert.equal((await js('probe.handles[1].closed')).status, 'submitted');
    await clean();
  });
  await test('网关场景选择使用同一 submitted 合同，busy 拒绝后可重试', async () => {
    await setup('gateway');
    await js('probe.allowClose=false;void 0;');
    await click('confirm');
    await expectCalls([]);
    assert.equal(await js('originalHandle.isOpen()'), true);
    await js('probe.allowClose=true;void 0;');
    await click('confirm');
    await expectCalls(['gatewayRun']);
    assert.deepEqual(await js('originalHandle.closed'), { status: 'submitted', value: 3 });
    await clean();
  });
  await test('网关场景选择旧句柄不能关闭替换后的新弹窗', async () => {
    await setup('gateway');
    await js('window.oldButton=document.querySelector("[data-action=confirm]");void 0;');
    await js('bank.commands.run()');
    await js('oldButton.click();void 0;');
    await flush();
    await expectCalls([]);
    assert.equal(await js('host.getTop()===probe.handles[1] && probe.handles[1].isOpen()'), true);
    await click('confirm');
    await expectCalls(['gatewayRun']);
    await clean();
  });
};
