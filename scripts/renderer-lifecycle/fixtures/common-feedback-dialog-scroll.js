'use strict';

// 真实公共工厂、宿主、生产 CSS 与业务反馈链；所有文件和 API 均为虚构夹具。
module.exports = async ({ js, load, reset, assert, test, layout }) => {
  const top = '#modalRoot > .modal-overlay:last-child';
  const card = `${top} .feedback-dialog-card`;
  const body = `${card} > .alert-body`;
  const button = `${card} > .dialog-actions > button`;
  async function setup(options = {}, extraHtml = '') {
    await reset(`<button id="background">背景操作</button><div id="modalRoot"></div>${extraHtml}`, { layout: options });
    await load('src/renderer/dialogs/toolbox.js');
    await load('src/renderer-dialogs.js');
    await js(`window.f = {
      calls: { confirm: 0, middle: 0, cancel: 0, background: 0, repair: [], exported: [], changed: 0, imports: 0, logs: [] },
      bridge: window.__rendererModalBridge, host: window.__rendererModalHost,
      lines: n => Array.from({length:n}, (_,i) => '<div data-row="'+i+'">文件-'+i+'-'+ 'long_name_'.repeat(8)+'.xlsx：字段异常 /fixture/'+ 'directory/'.repeat(8)+'</div>').join(''),
      tick: () => new Promise(resolve => setTimeout(resolve, 0)),
      api: { app: { reportLog: item => f.calls.logs.push(item) } },
      change(selector, value, property = 'checked') { const e=document.querySelector(selector); e[property]=value; e.dispatchEvent(new Event(property==='checked'?'change':'input',{bubbles:true})); }
    };
    document.getElementById('background').onclick=()=>f.calls.background++;
    f.make = () => window.__createTestRendererDialogs({ state: {}, elements: {modalRoot: document.getElementById('modalRoot')}, desktopApi:f.api, modalBridge:f.bridge });
    f.dialogs=f.make();
    f.open = (kind, n, extra={}) => {
      const message=f.lines(n);
      f.overlay=kind===1 ? f.dialogs.createAlertDialog(message, {onConfirm:()=>f.calls.confirm++, ...extra})
        : f.dialogs.createConfirmDialog({message,confirmText:'删除错误数据并重跑',cancelText:'关闭',
          onConfirm:()=>f.calls.confirm++,onCancel:()=>f.calls.cancel++,
          ...(kind===3?{middleText:'导出错误数据',onMiddle:()=>f.calls.middle++}:{}), ...extra});
      return f.bridge.openModal(()=>f.overlay, {owner:'fixture'}).status;
    }; void 0;`);
  }
  async function waitFor(expression) {
    return js(`new Promise((resolve, reject) => {
      const until=Date.now()+3000;
      const check=()=>{try { if (${expression}) return resolve(true); } catch(error) {return reject(error);}
        if(Date.now()>until)return reject(new Error('等待条件超时：'+${JSON.stringify(expression)})); setTimeout(check,20);}; check();
    })`);
  }
  async function geometry(selector = card) {
    return js(`(() => {
      const card=document.querySelector(${JSON.stringify(selector)}), body=card.querySelector('.alert-body'), footer=card.querySelector('.dialog-actions');
      const rect=e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom};};
      return { viewport:{width:innerWidth,height:innerHeight},card:rect(card),body:rect(body),footer:rect(footer),
        bodyHeight:body.clientHeight,bodyScroll:body.scrollHeight,bodyWidth:body.clientWidth,bodyScrollWidth:body.scrollWidth,
        cardHeight:card.clientHeight,cardScroll:card.scrollHeight,overflow:getComputedStyle(body).overflowY,
        buttons:[...footer.querySelectorAll('button')].map(e=>{const r=rect(e);return {...r,text:e.textContent,
          hit:e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))};}),
        focus:document.activeElement.className,errors:window.__testErrors };
    })()`);
  }
  function assertGeometry(g, count, long = true) {
    assert.equal(g.buttons.length, count);
    assert.ok(g.card.x >= -1 && g.card.y >= -1 && g.card.right <= g.viewport.width + 1 && g.card.bottom <= g.viewport.height + 1, '卡片在视口内');
    assert.ok(g.bodyHeight > 0 && g.body.bottom <= g.footer.y + 1, '正文有可用高度且不覆盖 footer');
    assert.equal(g.overflow, 'auto');
    assert.ok(g.cardScroll <= g.cardHeight + 1, '卡片无第二个主要滚动区');
    assert.ok(g.bodyScrollWidth <= g.bodyWidth + 1, '长路径可换行');
    if (long) assert.ok(g.bodyScroll > g.bodyHeight, '长正文确实溢出');
    for (const b of g.buttons) {
      assert.ok(b.x >= g.card.x - 1 && b.right <= g.card.right + 1 && b.y >= g.footer.y - 1 && b.bottom <= g.card.bottom + 1 && b.height >= 36, `完整按钮：${b.text}`);
      assert.equal(b.hit, true, `按钮命中：${b.text}`);
    }
    assert.deepEqual(g.errors, []);
  }
  async function scrollChecks(count, selector = card, finalSelector = '[data-row]:last-child') {
    const before = await geometry(selector);
    assertGeometry(before, count);
    for (const fraction of [0.5, 1, 0]) {
      await js(`document.querySelector(${JSON.stringify(selector+' > .alert-body')}).scrollTop = ${fraction} * document.querySelector(${JSON.stringify(selector+' > .alert-body')}).scrollHeight; void 0`);
      await layout.settle();
      const after = await geometry(selector);
      assert.equal(after.footer.y, before.footer.y, '正文滚动时 footer 稳定');
      assert.deepEqual(after.buttons, before.buttons);
      if (fraction === 1 && finalSelector) {
        assert.equal(await js(`(() => {const b=document.querySelector(${JSON.stringify(selector+' > .alert-body')});const last=b.querySelector(${JSON.stringify(finalSelector)});const r=last.getBoundingClientRect(),br=b.getBoundingClientRect();return r.bottom<=br.bottom+1 && r.bottom>br.y;})()`), true, '末项可达');
      }
    }
    return before;
  }

  for (const kind of [1, 2, 3]) for (const count of [1, 10, 50, 100]) {
    await test(`公共默认 ${kind} 按钮／${count} 文件：真实布局、全文和 footer`, async () => {
      await setup();
      await js(`f.open(${kind},${count}); void 0`);
      const g=await geometry();
      assertGeometry(g,kind,count>1);
      assert.equal(await js(`document.querySelectorAll('${card} [data-row]').length`),count);
      assert.equal(await js(`document.activeElement === document.querySelector('${button}')`),true,'初始焦点仍为原按钮');
      if(count>1) await scrollChecks(kind);
      else assert.ok(g.card.height<g.viewport.height-150,'短文自然高度');
      if(kind===3&&count===100) {
        await layout.evidence('public-three-top',{geometry:g});
        await js(`document.querySelector('${body}').scrollTop=1e8; void 0`);
        await layout.evidence('public-three-bottom',{geometry:await geometry()});
      }
    });
  }

  for (const [name, options] of [
    ['pressure-1280-720',{productionMinimum:false,width:1280,height:720}],
    ['pressure-1024-640',{productionMinimum:false,width:1024,height:640}],
    ['pressure-800-480',{productionMinimum:false,width:800,height:480}],
    ['minimum-dark',{theme:'dark'}],['minimum-zoom-150',{zoom:1.5}]
  ]) await test(`布局环境 ${name}：长标签、滚轮与真实鼠标`,async()=>{
    await setup(options);
    await js(`f.open(3,100,{confirmText:'删除错误数据并重新处理这些文件',middleText:'导出所选文件中的全部错误数据',cancelText:'关闭当前反馈窗口'});void 0`);
    const g=await scrollChecks(3);
    const environment=await layout.inspect();
    if(options.productionMinimum===false) assert.deepEqual([environment.page.width,environment.page.height],[options.width,options.height]);
    else assert.deepEqual(environment.minimumSize,[1080,760]);
    assert.equal(environment.zoom,options.zoom||1);
    await layout.wheel(body);
    await waitFor(`document.querySelector('${body}').scrollTop>0`);
    await layout.click(`${button}[data-action=confirm]`);
    await layout.click(`${button}[data-action=middle]`);
    assert.deepEqual(await js('[f.calls.confirm,f.calls.middle,f.calls.cancel,f.calls.background]'),[1,1,0,0]);
    await layout.evidence(name,{geometry:g,input:{mouseConfirm:1,mouseMiddle:1,wheelScrolled:true}});
    await layout.click(`${button}[data-action=cancel]`);
    assert.deepEqual(await js('[f.calls.confirm,f.calls.middle,f.calls.cancel,f.calls.background]'),[1,1,1,0]);
  });

  await test('真实键盘：正文 PageDown／Space、Tab 环、按钮 Enter 与焦点恢复',async()=>{
    await setup();
    await js("document.getElementById('background').focus();f.open(3,100);void 0");
    await layout.key('Tab',['shift']);
    assert.equal(await js(`document.activeElement===document.querySelector('${body}')`),true);
    assert.deepEqual(await js(`({role:document.activeElement.getAttribute('role'),label:document.activeElement.getAttribute('aria-label'),outline:getComputedStyle(document.activeElement).outlineStyle})`),{role:'region',label:'弹窗内容',outline:'solid'});
    await layout.key('PageDown');
    await waitFor(`document.querySelector('${body}').scrollTop>0`);
    await js(`document.querySelector('${body}').scrollTop=0;void 0`);
    await layout.key('Space');
    await waitFor(`document.querySelector('${body}').scrollTop>0`);
    assert.deepEqual(await js('[f.calls.confirm,f.calls.middle,f.calls.cancel,f.calls.background]'),[0,0,0,0]);
    await layout.key('Tab');
    await layout.key('Enter');
    assert.equal(await js('f.calls.confirm'),1);
    await layout.key('Tab');
    await layout.key('Tab');
    await layout.key('Tab');
    assert.equal(await js(`document.activeElement===document.querySelector('${body}')`),true,'循环回正文而非背景');
    await layout.key('Tab',['shift']);
    await layout.key('Enter');
    assert.equal(await js("document.activeElement.id"),'background');
    assert.deepEqual(await js('[f.calls.confirm,f.calls.middle,f.calls.cancel,f.calls.background]'),[1,0,1,0]);
  });

  await test('生命周期：输入初始焦点、注册合并、busy 拒关和日志只报一次',async()=>{
    await setup();
    await js(`f.busy=true;f.mounts=0;f.overlay=f.dialogs.createAlertDialog('<input id="originalInput" value="原输入">'+f.lines(100),{
      confirmText:'已知悉',confirmSecondary:true,logLevel:'warn',logDomain:'fixture',logDetails:['detail'],onConfirm:()=>f.calls.confirm++});
      f.bridge.registerModal(f.overlay,{canClose:()=>!f.busy,onMount:()=>f.mounts++});f.bridge.openModal(()=>f.overlay);void 0`);
    assert.equal(await js('document.activeElement.id'),'originalInput');
    await layout.click(button);
    assert.deepEqual(await js('[f.calls.confirm,f.calls.logs.length,f.mounts,f.host.getTop().isOpen()]'),[0,1,1,true]);
    const log=await js('f.calls.logs[0]');
    assert.equal(log.level,'warn');assert.equal(log.domain,'fixture');assert.deepEqual(log.details,['detail']);
    await layout.resize(1280,900);await scrollChecks(1);
    await layout.resize(1080,760);assertGeometry(await geometry(),1);
    await js('f.busy=false;void 0');await layout.click(button);
    assert.deepEqual(await js('[f.calls.confirm,f.calls.logs.length,f.mounts]'),[1,1,1]);
    await js('f.open(1,10,{skipLogReport:true});void 0');
    assert.equal(await js('f.calls.logs.length'),1);
  });

  for (const localClass of ['toolbox-split-rows-result','big-account-unmaintained-alert']) {
    await test(`旧局部类 ${localClass} 与公共规则共存`,async()=>{
      await setup();await js(`f.open(1,100);f.overlay.querySelector('.alert-card').classList.add('${localClass}');void 0`);
      await scrollChecks(1);
      assert.equal(await js(`document.querySelectorAll('${card} > .alert-body').length`),1);
      await layout.click(button);assert.equal(await js('f.calls.confirm'),1);
    });
  }

  async function preFund({repairable=true,exportStatus='cancelled',repairStatus='failed'}={}) {
    await setup();
    await js(`f.results=Array.from({length:100},(_,i)=>({fileName:'FILE-'+String(i).padStart(3,'0')+'-<escaped>.xlsx',
      status:i%4===0?'ok':'failed',rowCount:3,message:'字段异常与长路径'.repeat(12),
      canRepair:${repairable} && i%4!==1,...(i%4===2?{repairToken:'token-'+i}:{})}));
      f.expected=f.results.filter(x=>x.status!=='ok'&&x.canRepair&&x.repairToken).map(x=>x.repairToken);
      f.api.preFundReconciliation={listTempBatches:async()=>({status:'ok',batches:[]}),
        importMpt:async()=>{f.calls.imports++;return {status:'ok',results:f.results};},
        exportMptErrors:async tokens=>{f.calls.exported.push(tokens);return {status:'${exportStatus}',errorRowCount:99,filePath:'/fixture/export.xlsx',warnings:Array.from({length:50},(_,i)=>'WARNING-'+i),message:'导出失败'};},
        repairMptErrors:async tokens=>{f.calls.repair.push(tokens);return {status:'${repairStatus}',message:'修复失败',importedRowCount:3,excludedRowCount:2,
          results:[{status:'failed',fileName:'retry.xlsx',message:'仍需修复',canRepair:true,repairToken:'retry-token'}]};}};
      f.dialogs=f.make();f.bridge.openModal(()=>f.dialogs.createPreFundTempManagerDialog({onChanged:()=>f.calls.changed++}));void 0`);
    await layout.click(`${top} [data-action=import]`);
    await waitFor(`document.querySelector('${card}')`);
    assertGeometry(await geometry(),repairable?3:1);
    assert.equal(await js(`(document.querySelector('${card} .alert-message').textContent.match(/FILE-[0-9]{3}/g)||[]).length`),100);
    assert.equal(await js(`document.querySelector('${card} escaped')===null`),true,'文件名仍转义');
  }
  await test('前置资金 100 混合结果：关闭／滚动／resize 不修复或导出',async()=>{
    await preFund();
    await scrollChecks(3,card,null);
    await layout.resize(1280,900);assertGeometry(await geometry(),3);
    await layout.evidence('prefund-mixed',{geometry:await geometry(),fileCount:100});
    await layout.click(`${button}[data-action=cancel]`);
    assert.deepEqual(await js('[f.calls.imports,f.calls.repair,f.calls.exported]'),[1,[],[]]);
    assert.equal(await js(`document.querySelector('${top} .manager-card')!==null`),true);
  });
  await test('前置资金无可修复项：单按钮反馈返回管理页',async()=>{
    await preFund({repairable:false});await layout.click(button);
    assert.equal(await js(`document.querySelector('${top} .manager-card')!==null`),true);
    assert.deepEqual(await js('[f.calls.repair,f.calls.exported]'),[[],[]]);
  });
  for (const exportStatus of ['cancelled','ok','failed']) await test(`前置资金导出 ${exportStatus}：原 tokens 与反馈返回链`,async()=>{
    await preFund({exportStatus});
    await layout.click(`${button}[data-action=middle]`);
    if(exportStatus!=='cancelled') {
      await waitFor(`document.querySelectorAll('${button}').length===1`);
      assertGeometry(await geometry(),1,exportStatus==='ok');
      await layout.click(button);
    }
    await waitFor(`document.querySelectorAll('${button}').length===3`);
    assertGeometry(await geometry(),3);
    assert.deepEqual(await js('f.calls.exported'),[await js('f.expected')]);
    assert.deepEqual(await js('f.calls.repair'),[]);
    assert.equal(await js('f.calls.imports'),1);
  });
  for (const repairStatus of ['failed','ok']) await test(`前置资金修复 ${repairStatus}：失败／部分失败重试资格与 tokens`,async()=>{
    await preFund({repairStatus});await layout.click(`${button}[data-action=confirm]`);
    await waitFor(`document.querySelectorAll('${button}').length===1`);
    assertGeometry(await geometry(),1,false);
    await layout.click(button);
    await waitFor(`document.querySelectorAll('${button}').length===3`);
    assertGeometry(await geometry(),3,repairStatus==='failed');
    assert.deepEqual(await js('f.calls.repair'),[await js('f.expected')]);
    assert.equal(await js('f.calls.changed'),repairStatus==='ok'?2:1);
    if(repairStatus==='ok') {
      await layout.click(`${button}[data-action=middle]`);
      assert.deepEqual(await js('f.calls.exported'),[['retry-token']]);
    }
  });

  async function linked(bocConfirm=false) {
    await setup();
    await js(`f.api.linkedTable={list:async()=>({status:'ok',tables:[]}),import:async()=>{f.calls.imports++;return {status:'ok',results:Array.from({length:100},(_,i)=>({status:'ok',fileName:'LINKED-'+i+'.xlsx',rowCount:1,
      ...(i===99?{admDerive:{created:true,total:100,unmatched:Array.from({length:60},(_,i)=>({batchNo:'ADM-'+i,code:'no-mid-match',customerRef:'customer-'+i}))},
        bocDerive:${bocConfirm?"{created:true,total:1,needBankImport:true}":"{created:false,error:'BOC错误 '.repeat(500)}"},bocBankDerive:{created:false,error:'银行错误 '.repeat(500)}}:{})}))};}};
      f.dialogs=f.make();f.bridge.openModal(()=>f.dialogs.createLinkedTableManagerDialog());void 0`);
    await layout.click(`${top} [data-action=import]`);await waitFor(`document.querySelector('${card}')`);
  }
  await test('资金对账汇总 → ADM → BOC → 银行反馈：长文、采样和原返回顺序',async()=>{
    await linked();
    for(const title of ['成功导入','ADM 银行对账单链接表已创建','BOC链接表派生失败','BOC调拨银行对账单表派生失败']) {
      await waitFor(`document.querySelector('${card} .alert-message')?.textContent.includes(${JSON.stringify(title)})`);
      assertGeometry(await geometry(),1);
      if(title.startsWith('ADM ')) assert.equal(await js(`document.querySelector('${card} .alert-message').textContent.includes('ADM-49')&&!document.querySelector('${card} .alert-message').textContent.includes('ADM-50')`),true,'保留 ADM 50 条采样上限');
      await layout.click(button);
    }
    assert.equal(await js(`document.querySelector('${top} .manager-card')!==null`),true);
    assert.equal(await js('f.calls.imports'),1);
  });
  for(const action of ['confirm','cancel']) await test(`BOC 引导 ${action}：二按钮原动作`,async()=>{
    await linked(true);await layout.click(button);await layout.click(button);
    await waitFor(`document.querySelectorAll('${button}').length===2`);
    assertGeometry(await geometry(),2,false);
    await layout.click(`${button}[data-action=${action}]`);
    if(action==='cancel') {await waitFor(`document.querySelectorAll('${button}').length===1`);await layout.click(button);}
    assert.equal(await js(`document.querySelector('${top} .manager-card')!==null`),true);
    assert.equal(await js('f.calls.imports'),1);
  });

  async function toolbox(mode) {
    await setup();
    await js(`f.toolCalls={merge:0,read:0,exports:[]};f.failure={status:'failed',message:'文件处理失败',detailLines:Array.from({length:100},(_,i)=>'DETAIL-'+i+' 路径异常'.repeat(10))};
      f.api.toolbox={merge:async()=>{f.toolCalls.merge++;return f.failure;},
        splitRead:async()=>{f.toolCalls.read++;return ${mode==='read-failed'?'f.failure':"{status:'success',sourceFilePath:'/fixture/source.xlsx',splitReadToken:'original-token',headers:['Currency'],valuesByField:{Currency:['USD','EUR']},dataRowCount:1000,maxRowSplitFiles:1000}"};},
        splitExport:async payload=>{f.toolCalls.exports.push(payload);return ${mode==='split-failed'?'f.failure':"{status:'success',fileCount:100,outputDataRowCount:1000,files:Array.from({length:100},(_,i)=>({fileName:'OUT-'+i+'.xlsx',dataRowCount:10,matchedCount:10,filePath:'/fixture/'+('directory/').repeat(8)+i+'.xlsx'})),warningSummary:{warningCount:30,warningSamples:Array.from({length:30},(_,i)=>({message:'SAMPLE-'+String(i).padStart(3,'0')}))}}"};}};
      f.dialogs=f.make();f.bridge.openModal(()=>f.dialogs.createToolboxDialog());void 0`);
    await layout.click(`${top} [data-action=${mode==='merge-failed'?'merge-import':'split-import'}]`);
    if(!['merge-failed','read-failed'].includes(mode)) {
      await waitFor("document.querySelector('[data-field=split-by-rows]')");
      if(mode==='multiple') {
        await js(`f.change('[data-field=multiple-files-enabled]',true);void 0`);
        await js(`f.change('.toolbox-split-file-name-input','output.xlsx','value');document.querySelector('.toolbox-split-values-dropdown-btn').click();f.change('.new-account-checkbox',true);void 0`);
      } else await js(`f.change('[data-field=split-by-rows]',true);f.change('[data-field=rows-per-file]','10','value');void 0`);
      await js(`document.querySelector('[data-action=complete]').click();void 0`);
    }
    await waitFor(`document.querySelector('${card}')`);
  }
  for(const mode of ['merge-failed','read-failed','split-failed','multiple','rows']) await test(`工具箱 ${mode}：真实包装、长反馈和原业务参数`,async()=>{
    await toolbox(mode);await scrollChecks(1,card,null);
    const content=await js(`document.querySelector('${card} .alert-message').textContent`);
    if(mode.endsWith('failed')) assert.ok(content.includes('DETAIL-99'));
    else {
      assert.ok(content.includes('OUT-99.xlsx'));
      assert.ok(content.includes('SAMPLE-019')&&!content.includes('SAMPLE-020'),'保留 20 条 warning 上限');
      assert.equal(await js(`document.querySelector('${card}').classList.contains('toolbox-split-rows-result')`),mode==='rows');
    }
    const calls=await js('f.toolCalls');
    if(calls.exports.length) {
      assert.equal(calls.exports.length,1);assert.equal(calls.exports[0].splitReadToken,'original-token');
      assert.equal(calls.exports[0].mode,mode==='multiple'?'multiple':'rows');
    }
    if(mode==='multiple'||mode==='merge-failed') await layout.evidence('toolbox-'+mode,{geometry:await geometry(),calls});
    await layout.click(button);
    assert.deepEqual(await js('f.toolCalls'),calls);
  });

  await test('公共反馈正文追加错误节点后仍保护 footer；管理与日期删除表单不误命中',async()=>{
    await setup();await js(`f.open(2,100);const error=document.createElement('div');error.className='archive-delete-confirm-error';error.textContent='删除未完成';f.overlay.querySelector('.alert-body').appendChild(error);void 0`);
    await scrollChecks(2);
    await js(`f.api.preFundReconciliation={listTempBatches:async()=>({status:'ok',batches:[]})};f.dialogs=f.make();f.bridge.openModal(()=>f.dialogs.createPreFundTempManagerDialog());document.querySelector('[data-action=delete]').click();void 0`);
    assert.equal(await js(`document.querySelectorAll('.feedback-dialog-card').length`),0);
    assert.equal(await js(`document.querySelector('[data-action=confirm-delete]').disabled`),true);
  });

  await test('独立同名 alert-card 不误命中公共标记和正文焦点',async()=>{
    await setup();await js(`const overlay=document.createElement('div');overlay.className='modal-overlay';overlay.innerHTML='<div class="modal-card alert-card"><div class="alert-body">独立正文</div><div class="dialog-actions"><button>关闭</button></div></div>';f.bridge.openModal(()=>overlay);void 0`);
    assert.equal(await js(`document.querySelectorAll('.feedback-dialog-card').length`),0);
    assert.equal(await js(`document.querySelector('.alert-body').hasAttribute('tabindex')`),false);
    assert.equal(await js(`getComputedStyle(document.querySelector('.alert-body')).overflowY`),'visible');
  });

  await test('平盘账户映射保存失败 OOS-01：实际独立构造仍可按原回调关闭',async()=>{
    await setup({},`<section id="position"><select id="positionReconciliationFunctionSelect"><option value="position-fund-nature-check">性质</option></select><button id="positionReconciliationRunBtn"></button><button id="positionReconciliationTableManagerBtn"></button><button id="positionReconciliationLinkedTableManagerBtn"></button><button id="positionReconciliationConfigBtn"></button><button id="positionReconciliationExportBtn"></button><div id="positionReconciliationStatusBox"><span class="status-box-text"></span></div></section>`);
    await load('src/renderer-position-reconciliation.js');
    await js(`f.mappingSaves=0;f.position=window.__positionReconciliation.createPositionReconciliationUI({
      api:{status:async()=>({status:'ok',canRun:true}),listMappings:async()=>({status:'ok',mappings:[]}),saveMappings:async()=>{f.mappingSaves++;return {status:'failed',message:'独立映射错误'.repeat(500)};}},
      panel:document.getElementById('position'),modalHost:f.host,modalBridge:f.bridge,createAlertDialog:f.dialogs.createAlertDialog,createConfirmDialog:f.dialogs.createConfirmDialog});
      (async()=>{await f.position.enter();await f.position.previewMappingDialog();document.querySelector('.position-mapping-dialog .dialog-actions button').click();await f.tick();})()`);
    await waitFor(`document.querySelector('${top} .alert-card')`);
    assert.equal(await js(`document.querySelectorAll('.feedback-dialog-card').length`),0);
    assert.equal(await js('f.mappingSaves'),1);
    await layout.evidence('position-oos-01',{scope:'独立构造；不宣称本分支修复，不断言已知缺陷必须存在'});
    // 独立已知问题不以真实点击／几何通过冒充修复验收；此处仅核对原关闭回调。
    await js(`document.querySelector('${top} .dialog-actions button').click();void 0`);
    assert.equal(await js(`document.querySelector('.position-mapping-dialog')!==null`),true);
  });

  await test('VCC 独立消息框：原滚动结构及按钮未被公共规则改造',async()=>{
    await setup({},'<section id="vcc"><button id="vccFinancialOpImportBtn"></button><button id="vccFinancialOpRunBtn"></button><button id="vccFinancialOpExportBtn"></button><button id="vccFinancialOpDataManagerBtn"></button><div id="vccFinancialOpStatusBox"><span class="status-box-text"></span></div></section>');
    await load('src/shared/vcc-review-projection.js');await load('src/shared/vcc-financial-op-difference.js');await load('src/renderer-vcc-financial-op.js');
    await js(`f.vcc=window.__vccFinancialOpController.createVccFinancialOpController({api:{listArchivedResultMonths:async()=>[],listImportMonths:async()=>[],listImportRecords:async()=>[],listOverview:async()=>[],listRunOverview:async()=>[]},panel:document.getElementById('vcc'),modalHost:f.host,differenceApi:window.__vccFinancialOpDifference,reviewProjection:window.__vccReviewProjection,previewEnabled:true});
      (async()=>{await f.vcc.enter();f.vcc.preview.openRunPreflightError();})()`);
    await waitFor("document.querySelector('.vcc-fin-op-message-dialog')");
    assert.equal(await js(`document.querySelectorAll('.feedback-dialog-card').length`),0);
    assert.equal(await js(`getComputedStyle(document.querySelector('.vcc-fin-op-dialog-body')).overflowY`),'auto');
    await layout.evidence('vcc-independent',{scope:'真实控制器的独立消息结构不受公共样式影响'});
    await layout.click('.vcc-fin-op-message-dialog button');
    assert.equal(await js(`document.querySelector('.vcc-fin-op-message-dialog')===null`),true);
  });
  await reset();
};
