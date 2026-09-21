'use strict';

module.exports = async ({ js, load, reset, assert, test }) => {
  async function setup() {
    await reset('<div id="modalRoot"></div><section id="panel"></section><section id="legacy"></section>');
    await load('src/renderer-biz-op-v327.js');
    await js(`if (!crypto.randomUUID) crypto.randomUUID=()=> '00000000-0000-4000-8000-000000000001';
      window.fixture={calls:[],deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};},tick:()=>new Promise(resolve=>setTimeout(resolve,0))};
      fixture.reply={status:{mode:'ACTIVE',recoveryReady:true},months:{status:'ok',months:['2026-09']},list:{status:'ok',rows:[],generation:1},
      runCalendar:{status:'ok',month:'2026-09',dates:['2026-09-11']},preflight:{status:'ok',selectionRef:'run-ref',inputs:[]},
      run:{status:'ok'},pickFiles:{status:'ok',selectionRef:'files-ref'},importFiles:{status:'ok'}};
      fixture.api=Object.fromEntries(Object.keys(fixture.reply).map(name=>[name,async(...args)=>{fixture.calls.push({name,args});const value=fixture.reply[name];return typeof value==='function'?value(...args):value;}]));
      fixture.legacy={enter:async()=>{fixture.calls.push({name:'legacyEnter'});return {status:'ready'};},leave:()=>{fixture.calls.push({name:'legacyLeave'});return {status:'left'};},dispose:()=>fixture.calls.push({name:'legacyDispose'})};
      fixture.controller=window.createBizOpV327Controller({api:fixture.api,panel:document.getElementById('panel'),legacyPanel:document.getElementById('legacy'),legacyController:fixture.legacy,modalHost:window.__rendererModalHost});
      fixture.button=(text,scope=document)=>{const button=[...scope.querySelectorAll('button')].find(button=>button.textContent===text);if(!button)throw new Error('找不到按钮 '+text);return button;}; void 0;`);
  }

  for (const succeeded of [true, false]) {
    await test(`BizOP 实际页面离开后${succeeded ? '成功' : '失败'}结算，返回显示原任务结果且不重复导入`, async () => {
      await setup();
      const result = await js(`(async()=>{
        await fixture.controller.enter();fixture.pending=fixture.deferred();fixture.reply.importFiles=()=>fixture.pending.promise;
        fixture.button('导入文件').click();await fixture.tick();const waiting=document.querySelector('.status-box-text').textContent;
        const left=fixture.controller.leave();
        if(!${succeeded})await fixture.controller.enter();
        fixture.pending.resolve(${succeeded} ? {status:'ok',summary:{scannedDataRows:3,acceptedRows:3}} : {status:'error',message:'导入失败，文件没有保存'});
        await fixture.tick();await fixture.tick();
        const hiddenUnchanged=${succeeded} ? document.querySelector('.status-box-text').textContent===waiting : true;
        if(${succeeded})await fixture.controller.enter();
        return {left:left.status,hiddenUnchanged,text:document.querySelector('.status-box-text').textContent,
          busy:fixture.controller.busy,ariaBusy:document.getElementById('panel').getAttribute('aria-busy'),
          disabled:fixture.button('导入文件').disabled,imports:fixture.calls.filter(call=>call.name==='importFiles').length,
          dialogs:document.getElementById('modalRoot').children.length,errors:window.__testErrors};
      })()`);
      assert.deepEqual(result,{left:'left',hiddenUnchanged:true,text:succeeded?'导入文件完成\n扫描 3 行，接受 3 行':'导入失败，文件没有保存',
        busy:false,ariaBusy:'false',disabled:false,imports:1,dialogs:0,errors:[]});
    });
  }

  await test('BizOP v327 工厂无 IPC；mode DISABLED 委托旧控制器，leave/dispose 统一收尾', async () => {
    await setup();
    const result = await js(`(async()=>{
      const initial=fixture.calls.length;fixture.reply.status={mode:'DISABLED',recoveryReady:true};
      const entered=await fixture.controller.enter();const fallback=!document.getElementById('legacy').hidden&&document.getElementById('panel').hidden;
      const left=fixture.controller.leave();fixture.controller.dispose();fixture.controller.dispose();
      return {initial,entered:entered.status,fallback,left:left.status,calls:fixture.calls.map(call=>call.name)};
    })()`);
    assert.deepEqual(result, { initial: 0, entered: 'ready', fallback: true, left: 'left', calls: ['status', 'legacyEnter', 'legacyLeave', 'legacyDispose'] });
  });

  await test('BizOP v327 运行→日期选择经同一 host push，关闭子页恢复父页', async () => {
    await setup();
    const result = await js(`(async()=>{
      await fixture.controller.enter();fixture.controller.openRun();const parent=document.getElementById('modalRoot').firstElementChild;
      document.querySelector('input[aria-label="起始日期"]').click();await fixture.tick();
      const count=document.getElementById('modalRoot').children.length;const paused=parent.inert;
      document.querySelector('button[data-date="2026-09-11"]').click();await fixture.tick();
      const date=document.querySelector('input[aria-label="起始日期"]').value;
      return {count,paused,date,parentAlive:parent.isConnected,restored:!parent.inert,remaining:document.getElementById('modalRoot').children.length,bodyDialogs:[...document.body.children].filter(n=>n.tagName==='DIALOG').length};
    })()`);
    assert.deepEqual(result, { count: 2, paused: true, date: '2026-09-11', parentAlive: true, restored: true, remaining: 1, bodyDialogs: 0 });
  });

  await test('BizOP v327 执行中现有 busy 拒绝 leave，dispose 后迟到运行结果不写旧 DOM', async () => {
    await setup();
    const result = await js(`(async()=>{
      await fixture.controller.enter();fixture.controller.openRun();
      fixture.button('检查所需数据').click();await fixture.tick();
      fixture.running=fixture.deferred();fixture.reply.run=()=>fixture.running.promise;
      fixture.button('确认运行').click();await fixture.tick();
      const closed=fixture.controller.leave();const old=document.getElementById('modalRoot').firstElementChild;
      fixture.controller.dispose();const html=old.innerHTML;
      fixture.running.resolve({status:'ok'});await fixture.tick();await fixture.tick();
      return {closed:closed.status,connected:old.isConnected,unchanged:html===old.innerHTML,count:document.getElementById('modalRoot').children.length,runs:fixture.calls.filter(c=>c.name==='run').length,errors:window.__testErrors};
    })()`);
    assert.deepEqual(result, { closed: 'blocked', connected: false, unchanged: true, count: 0, runs: 1, errors: [] });
  });

  await test('BizOP v327 管理列表关闭后迟到不修改已释放视图', async () => {
    await setup();
    const result = await js(`(async()=>{
      await fixture.controller.enter();fixture.list=fixture.deferred();fixture.reply.list=()=>fixture.list.promise;
      const pending=fixture.controller.openManager();await fixture.tick();
      const old=document.getElementById('modalRoot').firstElementChild;window.__rendererModalHost.closeTop();const html=old.innerHTML;
      fixture.list.resolve({status:'ok',rows:[],generation:1});await pending;
      return {connected:old.isConnected,unchanged:html===old.innerHTML,count:document.getElementById('modalRoot').children.length,errors:window.__testErrors};
    })()`);
    assert.deepEqual(result, { connected: false, unchanged: true, count: 0, errors: [] });
  });

  await test('BizOP v327 A/B/A 旧 mode 响应不能切回旧界面', async () => {
    await setup();
    const result = await js(`(async()=>{
      fixture.first=fixture.deferred();fixture.second=fixture.deferred();let reads=0;
      fixture.reply.status=()=>++reads===1?fixture.first.promise:fixture.second.promise;
      const old=fixture.controller.enter();fixture.controller.leave();const latest=fixture.controller.enter();
      fixture.second.resolve({mode:'ACTIVE',recoveryReady:true});await latest;
      fixture.first.resolve({mode:'DISABLED',recoveryReady:true});const late=await old;
      return {late:late.status,panel:!document.getElementById('panel').hidden,legacy:document.getElementById('legacy').hidden,legacyCalls:fixture.calls.filter(c=>c.name==='legacyEnter').length};
    })()`);
    assert.deepEqual(result, { late: 'stale', panel: true, legacy: true, legacyCalls: 0 });
  });

  await test('BizOP v327 无 modal 后台导入允许离开，返回早于完成仍接纳任务结算且不复活旧窗', async () => {
    await setup();
    const result = await js(`(async()=>{
      await fixture.controller.enter();fixture.importing=fixture.deferred();fixture.reply.importFiles=()=>fixture.importing.promise;
      fixture.button('导入文件').click();await fixture.tick();const left=fixture.controller.leave();await fixture.controller.enter();
      fixture.importing.resolve({status:'error',message:'旧任务错误'});await fixture.tick();await fixture.tick();
      return {left:left.status,disabled:fixture.button('导入文件').disabled,status:document.querySelector('.bizop-status').textContent,reads:fixture.calls.filter(c=>c.name==='status').length,imports:fixture.calls.filter(c=>c.name==='importFiles').length,dialogs:document.getElementById('modalRoot').children.length,errors:window.__testErrors};
    })()`);
    assert.equal(result.left, 'left');
    assert.equal(result.disabled, false);
    assert.match(result.status, /旧任务错误/);
    assert.equal(result.reads, 3);
    assert.equal(result.imports, 1); assert.equal(result.dialogs, 0);
    assert.deepEqual(result.errors, []);
  });
  await test('BizOP v327 删除预检晚到时不得重开已关闭的管理父层', async () => {
    await setup();
    const result = await js(`(async()=>{
      await fixture.controller.enter();fixture.preview=fixture.deferred();let previews=0;
      fixture.api.deletePreview=()=>{previews++;return fixture.preview.promise;};
      fixture.reply.list={status:'ok',generation:1,rows:[{objectId:'run-1',startDate:'2026-09-01',endDate:'2026-09-11',tableName:'结果1',version:1,updatedAt:'2026-09-11T00:00:00Z'}]};
      await fixture.controller.openManager();fixture.button('删除').click();await fixture.tick();
      const selected=document.querySelector('input[type="checkbox"]');selected.checked=true;selected.dispatchEvent(new Event('change'));
      fixture.button('删除').click();await fixture.tick();window.__rendererModalHost.closeTop();
      fixture.controller.openRun();const replacement=window.__rendererModalHost.getTop();
      fixture.preview.resolve({status:'ok',previewId:'preview-1',datasets:[],runs:[],selection:{runIds:['run-1']},references:{protectedAfterKeep:0,protectedAfterDelete:0,userLockedOriginals:0,sharedBlobOriginals:0}});
      await fixture.tick();await fixture.tick();
      return {previews,count:document.getElementById('modalRoot').children.length,replacementSame:replacement===window.__rendererModalHost.getTop(),deleteDialog:!!document.querySelector('.bizop-delete-dialog'),errors:window.__testErrors};
    })()`);
    assert.deepEqual(result,{previews:1,count:1,replacementSame:true,deleteDialog:false,errors:[]});
  });

  await test('BizOP v327 关闭导出框后迟到输入定位不得继续打开保存选择器或提交导出', async () => {
    await setup();
    const result = await js(`(async()=>{
      await fixture.controller.enter();fixture.input=fixture.deferred();let picked=0,written=0;
      fixture.api.currentInput=()=>fixture.input.promise;
      fixture.api.pickExport=async()=>{picked++;return {status:'ok',selectionRef:'export-ref'};};
      fixture.api.exportWorkbook=async()=>{written++;return {status:'ok'};};
      fixture.controller.openInputExport();fixture.button('导出').click();await fixture.tick();
      window.__rendererModalHost.closeTop();fixture.controller.openRun();const replacement=window.__rendererModalHost.getTop();
      fixture.input.resolve({status:'ok',objectId:'source-1'});await fixture.tick();await fixture.tick();
      return {picked,written,count:document.getElementById('modalRoot').children.length,replacementSame:replacement===window.__rendererModalHost.getTop(),errors:window.__testErrors};
    })()`);
    assert.deepEqual(result,{picked:0,written:0,count:1,replacementSame:true,errors:[]});
  });

  await test('BizOP v327 已关闭导出框的迟到错误不污染新弹窗或状态反馈', async () => {
    await setup();
    const result = await js(`(async()=>{
      await fixture.controller.enter();fixture.input=fixture.deferred();fixture.api.currentInput=()=>fixture.input.promise;
      fixture.controller.openInputExport();fixture.button('导出').click();await fixture.tick();
      window.__rendererModalHost.closeTop();fixture.controller.openRun();
      const before=document.querySelector('.bizop-status').textContent;
      fixture.input.reject(new Error('旧定位读取失败'));await fixture.tick();await fixture.tick();
      return {statusUnchanged:before===document.querySelector('.bizop-status').textContent,dialogError:document.querySelector('.bizop-run-dialog').textContent.includes('旧定位读取失败'),errors:window.__testErrors};
    })()`);
    assert.deepEqual(result,{statusUnchanged:true,dialogError:false,errors:[]});
  });

  await test('BizOP v327 输入原表导出成功后保留成功提示，再返回原管理父层', async () => {
    await setup();
    const result = await js(`(async()=>{
      await fixture.controller.enter();let written=0;
      fixture.api.currentInput=async()=>({status:'ok',objectId:'source-1'});
      fixture.api.pickExport=async()=>({status:'ok',selectionRef:'export-ref'});
      fixture.api.exportWorkbook=async()=>{written++;return {status:'ok'};};
      await fixture.controller.openManager();const parent=window.__rendererModalHost.getTop();
      fixture.button('导出').click();await fixture.tick();
      fixture.button('导出',document.querySelector('.bizop-input-export-dialog')).click();await fixture.tick();await fixture.tick();
      const notice=!!document.querySelector('.bizop-export-success-dialog');
      const inputClosed=!document.querySelector('.bizop-input-export-dialog');
      const count=document.getElementById('modalRoot').children.length;
      fixture.button('确定').click();await fixture.tick();
      return {written,notice,inputClosed,count,parentRestored:parent===window.__rendererModalHost.getTop(),remaining:document.getElementById('modalRoot').children.length,errors:window.__testErrors};
    })()`);
    assert.deepEqual(result,{written:1,notice:true,inputClosed:true,count:2,parentRestored:true,remaining:1,errors:[]});
  });

  await test('BizOP v327 已挂载导出框的定位失败仍展示错误，重试成功后执行一次', async () => {
    await setup();
    const result = await js(`(async()=>{
      await fixture.controller.enter();let reads=0,written=0;
      fixture.api.currentInput=async()=>{if(++reads===1)throw new Error('本次输入读取失败');return {status:'ok',objectId:'source-1'};};
      fixture.api.pickExport=async()=>({status:'ok',selectionRef:'export-ref'});
      fixture.api.exportWorkbook=async()=>{written++;return {status:'ok'};};
      fixture.controller.openInputExport();fixture.button('导出').click();await fixture.tick();await fixture.tick();
      const feedback=document.querySelector('.bizop-input-export-dialog .bizop-feedback').textContent;
      fixture.button('导出').click();await fixture.tick();await fixture.tick();
      return {feedback,reads,written,notice:!!document.querySelector('.bizop-export-success-dialog'),errors:window.__testErrors};
    })()`);
    assert.match(result.feedback,/本次输入读取失败/);
    assert.deepEqual({...result,feedback:undefined},{feedback:undefined,reads:2,written:1,notice:true,errors:[]});
  });

  await test('BizOP v327 保存位置尚未返回时强制销毁，不续发真正导出', async () => {
    await setup();
    const result = await js(`(async()=>{
      await fixture.controller.enter();fixture.picked=fixture.deferred();let written=0;
      fixture.api.currentInput=async()=>({status:'ok',objectId:'source-1'});
      fixture.api.pickExport=()=>fixture.picked.promise;
      fixture.api.exportWorkbook=async()=>{written++;return {status:'ok'};};
      fixture.controller.openInputExport();fixture.button('导出').click();await fixture.tick();
      const blocked=fixture.controller.leave();window.__rendererModalHost.getTop().dispose();
      fixture.picked.resolve({status:'ok',selectionRef:'export-ref'});await fixture.tick();await fixture.tick();
      return {blocked:blocked.status,written,count:document.getElementById('modalRoot').children.length,errors:window.__testErrors};
    })()`);
    assert.deepEqual(result,{blocked:'blocked',written:0,count:0,errors:[]});
  });

};
