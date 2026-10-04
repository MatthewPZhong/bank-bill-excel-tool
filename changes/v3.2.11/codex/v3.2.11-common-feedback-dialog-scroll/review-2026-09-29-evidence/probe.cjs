'use strict';

// 方案审查实验：仅在隔离页面内套用附件示意，不写入生产源码或真实业务数据。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow } = require('electron');
const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-design-review-'));
app.setPath('userData', path.join(temp, 'userData'));
app.setPath('documents', path.join(temp, 'Documents'));
app.setPath('logs', path.join(temp, 'logs'));
fs.mkdirSync(app.getPath('documents'), { recursive: true });
app.disableHardwareAcceleration();
const techPath = '/Users/pzhong/Downloads/v3.2.11-common-feedback-dialog-scroll-techdoc.md';
const tech = fs.readFileSync(techPath, 'utf8');
const proposalCss = tech.match(/```css\n([\s\S]*?)```/)[1];
const proposalHelper = tech.match(/```javascript\n([\s\S]*?)```/)[1];
const original = fs.readFileSync(path.join(root, 'src/renderer-dialogs.js'), 'utf8');
let proposed = original.replace('    function createAlertDialog(', proposalHelper + '\n    function createAlertDialog(');
for (const next of ['createConfirmDialog', 'createFundTransferAccountMappingDialog']) {
  const old = `overlay.appendChild(dialog);\n      return overlay;\n    }\n\n    function ${next}`;
  if (!proposed.includes(old)) throw new Error('工厂接入位置已变化：' + next);
  proposed = proposed.replace(old, `overlay.appendChild(dialog);\n      return applyCommonFeedbackLayout(overlay, dialog);\n    }\n\n    function ${next}`);
}
const styles = Array.from(fs.readFileSync(path.join(root, 'index.html'), 'utf8')
  .matchAll(/<link[^>]+href="([^"]+\.css)"/g), match => match[1]);
const result = { baseline: '18b82b4328cf5e00c1b2549d373a5b2f2677215c', platform: process.platform,
  electron: process.versions.electron, chromium: process.versions.chrome, styles, cases: [] };
let win;
const js = source => win.webContents.executeJavaScript(source, true);
const tick = () => js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
async function setup(proposal, width, height, zoom = 1, dark = false) {
  win.webContents.setZoomFactor(1);
  win.setContentSize(width, height);
  const links = styles.map(file => '<link rel="stylesheet" href="' + pathToFileURL(path.resolve(root, file)).href + '">'
    + (proposal && file.endsWith('styles-gemini-extra.css') ? '<style>' + proposalCss + '</style>' : '')).join('\n');
  const page = path.join(temp, 'fixture.html');
  fs.writeFileSync(page, `<!doctype html><html data-theme="${dark ? 'dark' : 'light'}"><head><meta charset="utf-8">${links}</head><body><div id="modalRoot"></div></body></html>`);
  await win.loadFile(page);
  win.webContents.setZoomFactor(zoom);
  for (const file of ['src/renderer/modal-host.js', 'src/renderer/modal-bridge.js',
    'src/renderer/scenario-command-service.js', 'src/renderer/scenario-change-router.js',
    'src/renderer/dialogs/scenarios.js', 'src/renderer/configuration-services.js',
    'src/renderer/dialogs/configuration.js', 'src/renderer/dialogs/toolbox.js']) {
    await js(fs.readFileSync(path.join(root, file), 'utf8') + '\n;void 0;');
  }
  await js((proposal ? proposed : original) + '\n;void 0;');
  await js(`
    window.errors = []; window.calls = {logs:0,confirm:0,middle:0,cancel:0,repair:0,export:0};
    window.host = __modalHost.createModalHost({root:document.getElementById('modalRoot'),document,reportError:e=>errors.push(String(e))});
    window.bridge = __modalBridge.createModalBridge({host});
    window.router = ScenarioChangeRouter.createScenarioChangeRouter();
    window.commands = ScenarioCommandService.createScenarioCommandService({scenariosApi:{},channelsApi:{},publish:e=>router.route(e)});
    window.services = ConfigurationServices.createConfigurationServices({templatesApi:{}}); services.acceptBootstrap({});
    window.fakeResults = Array.from({length:100},(_,i)=>({status:'failed',fileName:'虚构链接文件_'+i+'.xlsx',message:'虚构长错误原因'.repeat(4),canRepair:true,repairToken:'fake-token-'+i}));
    window.dialogs = __rendererDialogs.createRendererDialogs({modalBridge:bridge,configurationServices:services,
      configurationApi:{},appConstants:{},scenarioCommands:commands,scenarioSubscriptions:router,reportLog:()=>calls.logs++,
      dialogApis:{preFundReconciliation:{listTempBatches:async()=>({status:'ok',batches:[]}),importMpt:async()=>({status:'ok',results:fakeResults}),
        repairMptErrors:async()=>{calls.repair++;return {status:'failed',message:'虚构修复失败'};},
        exportMptErrors:async()=>{calls.export++;return {status:'cancelled'};}}}});
    void 0;
  `);
  await js('document.fonts.ready.then(()=>undefined)');
}
async function measure(name, proposal) {
  await tick();
  const data = await js(`(async()=>{
    const overlay=document.getElementById('modalRoot').lastElementChild;
    const card=overlay.querySelector('.modal-card'),body=card.querySelector('.alert-body'),footer=card.querySelector('.dialog-actions');
    const rect=e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom}};
    const b=rect(body),c=rect(card),f=rect(footer);
    const buttons=Array.from(footer.querySelectorAll('button')).map(e=>{const r=rect(e);const hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return {text:e.textContent,rect:r,hit:hit===e||e.contains(hit)}});
    const active=()=>({tag:document.activeElement.tagName,className:document.activeElement.className,action:document.activeElement.dataset.action||null});
    const initial=active();const computed=getComputedStyle(body);
    body.scrollTop=body.scrollHeight;await new Promise(resolve=>requestAnimationFrame(resolve));
    const end=body.querySelector('[data-last]');
    const afterFooter=rect(footer);
    document.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',shiftKey:true,bubbles:true,cancelable:true}));
    const afterShiftTab=active();
    return {viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio},card:c,body:b,footer:f,
      scroll:{height:body.scrollHeight,client:body.clientHeight,top:body.scrollTop,overflowY:computed.overflowY},
      last:end?rect(end):null,footerShift:afterFooter.y-f.y,buttons,initial,afterShiftTab,
      bodyTabIndex:body.tabIndex,bodyRole:body.getAttribute('role'),logs:calls.logs,calls:{...calls},errors,
      visible:buttons.every(x=>x.hit && x.rect.x>=c.x && x.rect.right<=c.right+1 && x.rect.y>=c.y && x.rect.bottom<=c.bottom+1 && x.rect.bottom<=innerHeight+1)};
  })()`);
  result.cases.push({name, proposal, ...data});
}
async function generic({name, proposal, count=100, width=1080, height=760, zoom=1, dark=false, kind='confirm', localClass='', longLabels=false}) {
  await setup(proposal,width,height,zoom,dark);
  await js(`
    window.message = ${count} === 1 ? '短提示' : Array.from({length:${count}},(_,i)=>'<span '+(i===${count}-1?'data-last':'')+'>虚构文件名_'+i+'_连续长文本ABCDEFGHIJKLMNOPQRSTUVWXYZ_文件.xlsx：多行报错原因</span>').join('<br>');
    window.overlay = ${kind==='alert' ? "dialogs.createAlertDialog(message,{skipLogReport:false})" : `dialogs.createConfirmDialog({message,confirmText:${JSON.stringify(longLabels?'长操作文案'.repeat(10):'删除错误数据并重跑')},middleText:'导出错误数据',cancelText:'关闭',onConfirm:()=>calls.confirm++,onMiddle:()=>calls.middle++,onCancel:()=>calls.cancel++})`};
    if (${JSON.stringify(localClass)}) overlay.querySelector('.modal-card').classList.add(${JSON.stringify(localClass)});
    bridge.openModal(overlay); void 0;
  `);
  await measure(name,proposal);
}
(async()=>{
  await app.whenReady();
  win=new BrowserWindow({show:false,width:1080,height:760,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});
  for (const c of [
    {name:'baseline-confirm-long',proposal:false},
    {name:'proposal-confirm-long',proposal:true},
    {name:'baseline-alert-long',proposal:false,kind:'alert'},
    {name:'proposal-alert-long',proposal:true,kind:'alert'},
    {name:'baseline-short',proposal:false,count:1},
    {name:'proposal-short',proposal:true,count:1},
    {name:'proposal-compact',proposal:true,width:800,height:480},
    {name:'proposal-content1080x732-zoom150',proposal:true,width:1080,height:732,zoom:1.5},
    {name:'proposal-dark',proposal:true,dark:true},
    {name:'proposal-old-toolbox-class',proposal:true,kind:'alert',localClass:'toolbox-split-rows-result'},
    {name:'proposal-old-big-account-class',proposal:true,kind:'alert',localClass:'big-account-unmaintained-alert'},
    {name:'proposal-long-label',proposal:true,longLabels:true},
  ]) await generic(c);
  for (const proposal of [false,true]) {
    await setup(proposal,1080,760);
    await js(`window.manager=dialogs.createPreFundTempManagerDialog();bridge.openModal(manager);manager.querySelector('[data-action="import"]').click();void 0;`);
    await tick();
    await measure('prefund-real-factory-'+(proposal?'proposal':'baseline'),proposal);
  }
  // 新发现的范围外自建消息框：运行实际 Position 保存失败回调，API 完全为替身。
  await setup(true,1080,760);
  await js(fs.readFileSync(path.join(root,'src/renderer-position-reconciliation.js'),'utf8')+'\n;void 0;');
  await js(`(async()=>{
    const panel=document.createElement('section');panel.id='positionProbe';document.body.appendChild(panel);
    panel.innerHTML='<select id="positionReconciliationFunctionSelect"><option value="position-fund-nature-check">性质</option></select>'
      +'<button id="positionReconciliationRunBtn"></button><button id="positionReconciliationTableManagerBtn"></button>'
      +'<button id="positionReconciliationLinkedTableManagerBtn"></button><button id="positionReconciliationConfigBtn"></button>'
      +'<button id="positionReconciliationExportBtn"></button><div id="positionReconciliationStatusBox"><span class="status-box-text"></span></div>';
    window.position=__positionReconciliation.createPositionReconciliationUI({panel,modalHost:host,modalBridge:bridge,
      createAlertDialog:dialogs.createAlertDialog,createConfirmDialog:dialogs.createConfirmDialog,
      api:{status:async()=>({status:'ok',canRun:true}),listMappings:async()=>({status:'ok',mappings:[]}),
        saveMappings:async()=>({status:'failed',message:'虚构的平盘账户映射保存错误，请检查导入文件及路径。'.repeat(100)}),
        onImportProgress:()=>()=>{}}});
    await position.enter();await position.previewMappingDialog();
    document.querySelector('.position-mapping-dialog .dialog-actions button').click();
  })()`);
  await tick();
  await measure('position-independent-save-error-proposal-excluded',true);
  for (const c of result.cases) {
    const independent=c.name.startsWith('position-independent-');
    const expectedVisible=c.proposal&&!independent||c.name==='baseline-short';
    assert.equal(c.visible,expectedVisible,c.name+' 按钮可见性');
    assert.deepEqual(c.errors,[],c.name+' 宿主错误');
    assert.equal(c.footerShift,0,c.name+' 滚动时操作区位置');
    if(c.proposal&&!independent) {
      assert.equal(c.initial.tag,'BUTTON',c.name+' 首次按钮焦点');
      assert.equal(c.afterShiftTab.className,'alert-body',c.name+' 正文 Tab 入口');
      assert.equal(c.calls.repair+c.calls.export,0,c.name+' 零真实业务调用');
      if(!c.name.includes('short'))assert.ok(c.scroll.height>c.scroll.client&&c.scroll.top>0,c.name+' 正文可滚动');
      if(c.last)assert.ok(c.last.y>=c.body.y-1&&c.last.bottom<=c.body.bottom+1,c.name+' 最后一项完整可见');
    }
  }
  assert.deepEqual(result.cases.find(c=>c.name==='baseline-short').card,result.cases.find(c=>c.name==='proposal-short').card,'短文卡片尺寸不变');
  assert.equal(result.cases.find(c=>c.name==='baseline-alert-long').logs,result.cases.find(c=>c.name==='proposal-alert-long').logs,'告警日志次数不变');
  result.assertions='PASS：15 个受控案例符合预期，包括基线缺陷和范围外风险的复现；不代表功能已实施或正式验收通过。';
  fs.writeFileSync(path.join(__dirname,'probe-result.json'),JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify(result.cases.map(c=>({name:c.name,visible:c.visible,scrollable:c.scroll.height>c.scroll.client&&c.scroll.top>0,footerShift:c.footerShift,initial:c.initial,errors:c.errors})),null,2));
  win.destroy();
  fs.rmSync(temp,{recursive:true,force:true});
  app.exit(0);
})().catch(error=>{
  console.error(error.stack||error);
  if(win&&!win.isDestroyed())win.destroy();
  fs.rmSync(temp,{recursive:true,force:true});
  app.exit(1);
});
