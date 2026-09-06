'use strict';
// 在独立 Electron 临时配置目录运行真实页面组件；API 为合成夹具，真实 IPC 另有集成合同测试。
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow } = require('electron');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bizop-ui-'));
app.setPath('userData', path.join(temp, 'user-data'));
const output = path.resolve(process.argv[2] || 'outputs/pr5-validation/ui');
fs.mkdirSync(output, { recursive: true });
const source = path.resolve(__dirname, '../../src');
const link = (name) => pathToFileURL(path.join(source, name)).href;
const index = fs.readFileSync(path.resolve(source, '../index.html'), 'utf8');
const vccPanel = index.match(/<section id="vccFinancialOpModulePanel"[\s\S]*?<\/section>/)?.[0];
if (!vccPanel) throw new Error('缺少 VCC 财务 OP 主面板参考');
const html = path.join(temp, 'preview.html');
fs.writeFileSync(html, `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>业务 OP 页面验证</title>
<link rel="stylesheet" href="${link('fonts.css')}"><link rel="stylesheet" href="${link('styles-gemini.css')}">
<link rel="stylesheet" href="${link('styles-gemini-extra.css')}"><link rel="stylesheet" href="${link('styles-vcc-financial-op.css')}"><link rel="stylesheet" href="${link('styles-biz-op-v327.css')}">
<style>body{margin:0;padding:44px;background:#f8f9fa}h1{font-size:24px;margin-bottom:28px}.control-board{width:100%;box-sizing:border-box}</style>
<h1>业务 OP 数据核对</h1><section id="legacy" hidden>旧版页面</section><section id="modern" class="control-board module-panel" hidden></section>${vccPanel}<div id="modalRoot" class="modal-root" hidden></div>
<script src="${link('renderer-biz-op-v327.js')}"></script></html>`);
const checks = [];
(async () => {
  await app.whenReady();
  const win = new BrowserWindow({ width: 1200, height: 900, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
  await win.loadFile(html);
  const js = (code) => win.webContents.executeJavaScript(code, true);
  await js(`(() => {
    const state = { mode:'ACTIVE', calls:[], legacy:0, preflightMode:'ok', pendingPreflight:null, importResolve:null, paged:false, generation:7, pendingList:null };
    window.fixture = state;
    const originals = [{originalName:'BU_A_OP_20260901.xlsx'},{originalName:'BU_B_OP_20260901.xlsx'}];
    const run = {objectId:'run-1',rowKey:'run-1',startDate:'2026-09-01',endDate:'2026-09-03',version:2,tableName:'业务OP校验结果表_2026-09-01~09-03_v2',updatedAt:'2026-09-06T08:12:00.000Z',operationMonth:'2026-09'};
    const input = {objectId:'input-1',rowKey:'input-1:0',kind:'OP',dataDate:'2026-09-01',version:3,tableName:'OP校验表_2026-09-01_v3',updatedAt:'2026-09-06T08:00:00.000Z',originalName:'<img src=x onerror=alert(1)>.xlsx'};
    const api = {
      async status(){return {mode:state.mode,recoveryReady:true};}, async months(){return {months:['2026-09'],nextBefore:null};},
      async runCalendar(value={}){state.calls.push(['calendar',value]);if(state.holdCalendar)return new Promise(resolve=>state.pendingCalendar=resolve);
        if(state.emptyCalendar)return {month:null,dates:[]};
        const month=value.month||'2026-07';return {month,dates:month==='2026-07'?['2026-07-15']:['2026-09-01','2026-09-03'],previousMonth:month==='2026-07'?null:'2026-07',nextMonth:month==='2026-07'?'2026-09':null};},
      async list(value){state.calls.push(['list',value]);
        if(state.holdList) return new Promise(resolve=>state.pendingList=resolve);
        if(value.generation!==undefined&&value.generation!==state.generation)return {status:'error',code:'BIZOP_GENERATION_CHANGED',message:'数据已变化，请刷新列表'};
        if(state.paged&&value.view==='RESULT'){const start=Number(value.cursor||0);return {generation:state.generation,rows:Array.from({length:Math.min(200,401-start)},(_,i)=>({...run,objectId:'run-'+(start+i+1),tableName:'结果表 '+(start+i+1)})),nextCursor:start+200<401?String(start+200):null};}
        return {generation:state.generation,rows:value.view==='RESULT'?[run]:[input],nextCursor:null};},
      async preflight(value){state.calls.push(['preflight',value]);if(state.preflightMode==='pending') return new Promise(resolve=>state.pendingPreflight=resolve);
        if(state.preflightMode==='missing')return {status:'error',code:'BIZOP_RUN_INPUT_MISSING',message:'所选区间缺少必需的校验表',missing:[{kind:'FLOW',dataDate:'2026-09-02'},{kind:'OP',dataDate:'2026-09-03'}]};
        return {status:'ok',selectionRef:'selection-run',inputs:[{role:'START_OP',dataDate:value.startDate,version:3,originals:originals.map(x=>x.originalName)},{role:'END_OP',dataDate:value.endDate,version:1,originals:['BU_A_OP_20260903.xlsx']},{role:'FLOW',dataDate:'2026-09-02',version:1,originals:['流水20260902.xlsx']},{role:'FLOW',dataDate:'2026-09-03',version:1,originals:['流水20260903.xlsx']}]};},
      async run(value){state.calls.push(['run',value]);return {status:'error',code:'BIZOP_GENERATION_CHANGED',message:'输入已变化，请重新检查运行区间'};},
      async pickFiles(){return {status:'ok',selectionRef:'selection-import',files:['测试.xlsx']};},
      async importFiles(value){state.calls.push(['import',value]);return new Promise(resolve=>state.importResolve=resolve);},
      async cancel(value){state.calls.push(['cancel',value]);return {status:'cancelling',message:'已请求取消，正在等待后台任务退出'};},
      async pickExport(value){state.calls.push(['pickExport',value]);return {status:'ok',selectionRef:'selection-export'};},
      async exportWorkbook(kind,value){state.calls.push(['export',kind,value]);return {status:'ok'};},
      async currentInput(value){state.calls.push(['currentInput',value]);return input;},
      async deletePreview(value){state.calls.push(['deletePreview',value]);return {previewId:'preview-1',selection:{datasetIds:value.datasetIds||[],runIds:value.runIds||[]},datasets:value.datasetIds?[{...input,originals}]:[],runs:[{...run,originals},{...run,objectId:'run-2',operationMonth:'2026-08',version:1,tableName:'业务OP校验结果表_2026-09-01~09-03_v1',originals}],references:{protectedAfterKeep:4,protectedAfterDelete:2,userLockedOriginals:1,sharedBlobOriginals:2}};},
      async deleteData(value){state.calls.push(['delete',value]);return {status:'ok'};}, async retryRecovery(){return {ready:true};}
    };
    window.controller=window.createBizOpV327Controller({api,panel:document.querySelector('#modern'),legacyPanel:document.querySelector('#legacy'),restoreLegacy(){state.legacy+=1;}});
    window.button=(name)=>[...document.querySelectorAll('dialog[open] button')].filter(x=>!x.hidden&&x.textContent===name).at(-1)||[...document.querySelectorAll('#modern button')].find(x=>!x.hidden&&x.textContent===name);
    window.closeDialogs=async()=>{[...document.querySelectorAll('dialog')].reverse().forEach(x=>x.close());await waitUntil(()=>!document.querySelector('dialog'));};
    window.waitUntil=async(fn)=>{for(let i=0;i<200;i++){if(fn())return;await new Promise(r=>setTimeout(r,10));}throw new Error('页面条件未收敛');};
    window.panelMetrics=(panel)=>{const outer=panel.getBoundingClientRect();return {
      height:outer.height,items:[...panel.querySelectorAll('.control-row button'),panel.querySelector('.status-box')].map(item=>{
        const r=item.getBoundingClientRect();return [r.x-outer.x,r.y-outer.y,r.width,r.height];})};};
    window.textLeft=(element)=>{const range=document.createRange();range.selectNodeContents(element);return range.getBoundingClientRect().left;};
    window.operationAlignment=(scope)=>{const table=scope.querySelector('.vcc-fin-op-manager-result-table'),link=table.querySelector('.vcc-fin-op-link-btn');return Math.abs(textLeft(table.querySelector('th:last-child'))-textLeft(link))<1&&getComputedStyle(link).backgroundColor==='rgba(0, 0, 0, 0)'&&getComputedStyle(link).borderTopWidth==='0px';};
  })()`);
  async function check(name, code) {
    try { const result = await js(code); if (result !== true) throw new Error(JSON.stringify(result)); checks.push(name); }
    catch (error) {
      const snapshot = await js(`({busy:controller.busy,buttons:[...document.querySelectorAll('dialog[open] button')].map(b=>({text:b.textContent,disabled:b.disabled,hidden:b.hidden})),firstCell:document.querySelector('td')?.textContent,calls:fixture.calls.slice(-5)})`);
      throw new Error(`${name}: ${error.message}; ${JSON.stringify(snapshot)}`);
    }
  }
  async function shot(name) { await js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))'); fs.writeFileSync(path.join(output, name + '.png'), (await win.webContents.capturePage()).toPNG()); }
  await check('Main mode 路由，ACTIVE 隐藏旧页面', `(async()=>{await controller.setSelected(true);return !document.querySelector('#modern').hidden&&document.querySelector('#legacy').hidden;})()`);
  await check('初始状态欢迎语与 VCC 一致', `document.querySelector('#modern .status-box-text').textContent==='欢迎使用小助手'`);
  await check('主面板只保留 VCC 两行四个动作，输入导出不在主页面', `(()=>{const p=document.querySelector('#modern');return [...p.querySelectorAll('.control-row')].map(row=>[...row.querySelectorAll('button')].map(b=>b.textContent).join('|')).join('/')==='导入文件|开始运行|导出校验结果表/数据管理'&&p.querySelectorAll('.control-row')[1].querySelector('.cell.left .status-box')!==null&&!p.textContent.includes('导出数据')&&p.querySelector('.bizop-secondary').hidden;})()`);
  for (const [width, height] of [[1200, 900], [1080, 760]]) {
    win.setSize(width, height);
    await js(`document.querySelector('#modern').hidden=true;document.querySelector('#vccFinancialOpModulePanel').hidden=false`);
    await shot(`00-vcc-reference-${width}`);
    await js(`window.referenceMetrics=panelMetrics(document.querySelector('#vccFinancialOpModulePanel'));document.querySelector('#vccFinancialOpModulePanel').hidden=true;document.querySelector('#modern').hidden=false`);
    await shot(`01-main-${width}`);
    await check(`${width} 窗口与实际 VCC 主面板的按钮及状态框位置尺寸一致`, `(()=>{const actual=panelMetrics(document.querySelector('#modern'));const a=[actual.height,...actual.items.flat()],b=[referenceMetrics.height,...referenceMetrics.items.flat()];return a.length===b.length&&a.every((n,i)=>Math.abs(n-b[i])<1)||{actual,referenceMetrics};})()`);
  }
  win.setSize(1200, 900);
  await shot('01-main');
  await check('数据管理沿用左导航右列表，导出数据位于底部操作区', `(async()=>{await controller.openManager();const d=document.querySelector('dialog');const nav=d.querySelector('nav');const pane=d.querySelector('.position-manager-pane');return [...nav.querySelectorAll('button')].map(b=>b.textContent).join('|')==='结果表|校验表|校验原表'&&nav.getBoundingClientRect().right<=pane.getBoundingClientRect().left+1&&d.querySelector('.vcc-fin-op-manager-footer-right').textContent.includes('导出')&&d.querySelector('.vcc-fin-op-manager-toolbar').textContent.includes('操作月份')&&!d.textContent.includes('解归档');})()`);
  await shot('02-manager');
  await check('管理页移除刷新和下一页，底部为删除、导出、返回，单页不显示页码', `(()=>{const d=document.querySelector('dialog');return [...d.querySelectorAll('.bizop-modal-footer button')].filter(b=>!b.hidden).map(b=>b.textContent).join('|')==='删除|导出|返回'&&!d.querySelector('.bizop-page-choice').checkVisibility();})()`);
  await check('业务 OP 操作标题与导出原表文字左侧对齐', `operationAlignment(document.querySelector('dialog'))`);
  await check('导出数据的日期和目标横排缩窄，标题对齐分割线', `(()=>{
    controller.openInputExport();const d=[...document.querySelectorAll('dialog[open]')].at(-1),a=d.querySelector('input[type=date]').getBoundingClientRect(),b=d.querySelector('select').getBoundingClientRect();
    return Math.abs(a.top-b.top)<1&&a.right<b.left&&a.width>=180&&a.width<=200&&b.width>=280&&b.width<=360&&Math.abs(textLeft(d.querySelector('.dialog-title'))-d.querySelector('.dialog-header').getBoundingClientRect().left)<1;
  })()`);
  await shot('02-input-export');
  await js(`(async()=>{[...document.querySelectorAll('dialog')].at(-1).close();await waitUntil(()=>document.querySelectorAll('dialog').length===1);})()`);
  for (const outputKind of ['OP_RAW', 'OP_CHECK', 'FLOW_RAW', 'FLOW_CHECK']) {
    await check(`管理内 ${outputKind} 导出保留对应输入类型和账期`, `(async()=>{button('导出').click();await waitUntil(()=>document.querySelectorAll('dialog').length===2);const d=[...document.querySelectorAll('dialog')].at(-1);d.querySelector('select').value=${JSON.stringify(outputKind)};d.querySelector('input[type=date]').value='2026-09-01';button('选择位置并导出').click();await waitUntil(()=>!controller.busy&&fixture.calls.some(x=>x[0]==='export'&&x[1]===${JSON.stringify(outputKind)}));await waitUntil(()=>document.querySelectorAll('dialog').length===1);const current=fixture.calls.filter(x=>x[0]==='currentInput').at(-1);return current[1].kind===${JSON.stringify(outputKind.split('_')[0])}&&current[1].dataDate==='2026-09-01';})()`);
  }
  await js('closeDialogs()');
  await check('移除翻页按钮后 401 条结果分三页可达，换页清空删除选择并绑定 generation', `(async()=>{
    fixture.paged=true;await controller.openManager();const pager=document.querySelector('[aria-label="数据页码"]');
    if(document.querySelectorAll('tbody tr').length!==200||pager.options.length!==2)return {stage:'first',rows:document.querySelectorAll('tbody tr').length,pages:pager.options.length,dialogs:document.querySelectorAll('dialog').length};
    button('删除').click();await waitUntil(()=>document.querySelector('input[type=checkbox]'));
    const first=document.querySelector('input[type=checkbox]');first.checked=true;first.dispatchEvent(new Event('change'));
    pager.value='1';pager.dispatchEvent(new Event('change'));await waitUntil(()=>!pager.disabled);
    if(document.querySelectorAll('tbody tr').length!==200||!document.querySelector('tbody').textContent.includes('结果表 201')||document.querySelectorAll('input:checked').length||!button('删除').disabled)return {stage:'second',rows:document.querySelectorAll('tbody tr').length,text:document.querySelector('tbody').textContent.slice(0,180),checked:document.querySelectorAll('input:checked').length,delDisabled:button('删除').disabled};
    pager.value='2';pager.dispatchEvent(new Event('change'));await waitUntil(()=>!pager.disabled);
    if(document.querySelectorAll('tbody tr').length!==1||!document.querySelector('tbody').textContent.includes('结果表 401')||pager.options.length!==3)return {stage:'third',rows:document.querySelectorAll('tbody tr').length,pages:pager.options.length,text:document.querySelector('tbody').textContent.slice(0,180)};
    pager.value='0';pager.dispatchEvent(new Event('change'));await waitUntil(()=>!pager.disabled);
    const last=fixture.calls.filter(x=>x[0]==='list').at(-1)[1];
    return document.querySelectorAll('tbody tr').length===200&&last.cursor===null&&last.generation===7&&last.limit===200||{stage:'return',last,rows:document.querySelectorAll('tbody tr').length};
  })()`);
  await check('页码遇到版本变化只重载一次第一页，清空旧删除选择', `(async()=>{
    fixture.generation=8;const before=fixture.calls.filter(x=>x[0]==='list').length;
    const pager=document.querySelector('[aria-label="数据页码"]');pager.value='1';pager.dispatchEvent(new Event('change'));
    await waitUntil(()=>document.querySelector('.bizop-feedback').textContent.includes('已重新载入第一页'));
    return pager.value==='0'&&document.querySelectorAll('input:checked').length===0&&button('删除').disabled&&fixture.calls.filter(x=>x[0]==='list').length-before===2;
  })()`);
  await check('换分类后晚到的旧页不能覆盖当前列表', `(async()=>{
    fixture.holdList=true;const pager=document.querySelector('[aria-label="数据页码"]');pager.value='1';pager.dispatchEvent(new Event('change'));
    await waitUntil(()=>fixture.pendingList);fixture.holdList=false;button('校验原表').click();
    await waitUntil(()=>document.querySelector('td')?.textContent==='2026-09-01');
    fixture.pendingList({generation:8,rows:[],nextCursor:null});await new Promise(r=>setTimeout(r,20));
    return document.querySelector('td')?.textContent==='2026-09-01'&&document.querySelector('.bizop-page-choice').hidden;
  })()`);
  await js('(async()=>{await closeDialogs();fixture.paged=false;})()');
  await check('数据管理列顺序，主结果导出为全量原表', `(async()=>{await controller.openManager();button('导出原表').click();await waitUntil(()=>!controller.busy&&fixture.calls.some(x=>x[0]==='export'&&x[1]==='RESULT_FULL'));return [...document.querySelectorAll('th')].map(x=>x.textContent).join('|')==='起始日期|终止日期|表名|结果版本|更新时间|操作';})()`);
  await check('原表文件名作为文本，点击删除先进入选取且不执行删除', `(async()=>{button('校验原表').click();await waitUntil(()=>document.querySelector('th:nth-child(3)')?.textContent==='来源文件'&&document.querySelector('td')?.textContent==='2026-09-01'&&!button('删除').disabled);button('删除').click();await waitUntil(()=>document.querySelector('input[type=checkbox]'));const c=document.querySelector('input[type=checkbox]');c.checked=true;c.dispatchEvent(new Event('change'));return !document.querySelector('dialog img')&&!document.querySelector('dialog').textContent.includes('选取任一来源文件')&&document.querySelector('dialog').textContent.includes('<img src=x onerror=alert(1)>.xlsx')&&!fixture.calls.some(x=>x[0]==='delete');})()`);
  await shot('02-manager-select');
  await check('删除先完整跨月份预览，精确三个按钮', `(async()=>{button('删除').click();await waitUntil(()=>document.querySelectorAll('dialog').length===2);const d=[...document.querySelectorAll('dialog')].at(-1);return d.textContent.includes('2026-08')&&[...d.querySelectorAll('footer button,.bizop-modal-footer button')].map(x=>x.textContent).join('|')==='删除但保留结果表|删除|取消'&&!fixture.calls.some(x=>x[0]==='delete');})()`);
  await shot('03-delete-impact');
  await check('保留结果选择按 mode 提交，成功后刷新', `(async()=>{button('删除但保留结果表').click();await waitUntil(()=>fixture.calls.some(x=>x[0]==='delete'));await waitUntil(()=>!controller.busy);return fixture.calls.find(x=>x[0]==='delete')[1].mode==='KEEP_RESULTS';})()`);
  await js('closeDialogs()');
  await check('运行标题对齐分割线、日期框为原宽 2/3，检查按钮位于左下角且不显示旧说明', `(()=>{
    controller.openRun();const d=document.querySelector('dialog'),fields=d.querySelector('.bizop-run-fields'),inputs=[...fields.querySelectorAll('input')];
    const expected=(fields.getBoundingClientRect().width-18)/2*2/3,footer=d.querySelector('.bizop-modal-footer'),check=button('检查所需数据');
    return inputs.every(x=>x.readOnly&&Math.abs(x.getBoundingClientRect().width-expected)<1)&&Math.abs(textLeft(d.querySelector('.dialog-title'))-d.querySelector('.dialog-header').getBoundingClientRect().left)<1
      &&footer.contains(check)&&check.getBoundingClientRect().left<footer.getBoundingClientRect().left+30&&!d.textContent.includes('OP 需要起始、终止两日');
  })()`);
  await shot('07-run');
  await check('月历默认最近导入月份，缺数据日期禁用，前后月份只跳到有数据月份', `(async()=>{
    document.querySelector('dialog input').click();await waitUntil(()=>document.querySelector('.bizop-calendar-grid'));
    const picker=document.querySelector('.bizop-calendar-dialog');
    if(picker.querySelector('strong').textContent!=='2026 年 7 月'||!picker.querySelector('[data-date="2026-07-14"]').disabled)return false;
    picker.querySelector('[data-date="2026-07-14"]').click();if(document.querySelector('.bizop-run-dialog input').value)return false;
    picker.querySelector('[aria-label="下个有数据月份"]').click();await waitUntil(()=>picker.querySelector('strong')?.textContent==='2026 年 9 月');
    return [...picker.querySelectorAll('[data-date]:not(:disabled)')].map(x=>x.dataset.date).join('|')==='2026-09-01|2026-09-03';
  })()`);
  await shot('08-run-calendar');
  await check('只选择可用日期并回填原字段，已有字段再次打开仍定位最新导入月份', `(async()=>{
    document.querySelector('[data-date="2026-09-01"]').click();await waitUntil(()=>document.querySelectorAll('dialog').length===1);
    const input=document.querySelector('dialog input');if(input.value!=='2026-09-01')return false;
    input.click();await waitUntil(()=>document.querySelector('.bizop-calendar-grid'));return document.querySelector('.bizop-calendar-dialog strong').textContent==='2026 年 7 月';
  })()`);
  await js('closeDialogs()');
  await check('关闭月历后晚到日期响应不复活窗口或回填字段', `(async()=>{
    fixture.holdCalendar=true;controller.openRun();document.querySelector('dialog input').click();await waitUntil(()=>fixture.pendingCalendar);
    document.querySelector('.bizop-calendar-dialog').close();await waitUntil(()=>document.querySelectorAll('dialog').length===1);
    fixture.pendingCalendar({month:'2026-07',dates:['2026-07-15']});await new Promise(r=>setTimeout(r,20));fixture.holdCalendar=false;
    return !document.querySelector('.bizop-calendar-dialog')&&document.querySelector('dialog input').value==='';
  })()`);
  await js('closeDialogs()');
  await check('无可用 OP 时月历显示空态且没有可选日期', `(async()=>{
    fixture.emptyCalendar=true;controller.openRun();document.querySelector('dialog input').click();await waitUntil(()=>document.querySelector('.bizop-calendar-dialog')?.textContent.includes('暂无可用 OP'));
    fixture.emptyCalendar=false;return !document.querySelector('.bizop-calendar-dialog [data-date]');
  })()`);
  await js('closeDialogs()');
  await check('运行缺失输入可见，保留日期且不执行', `(async()=>{controller.openRun();const dates=document.querySelectorAll('dialog input[type=date]');dates[0].value='2026-09-01';dates[1].value='2026-09-03';fixture.preflightMode='missing';button('检查所需数据').click();await waitUntil(()=>document.querySelector('.bizop-feedback').textContent.includes('2026-09-02'));return dates[0].value==='2026-09-01'&&dates[1].value==='2026-09-03'&&button('确认运行').disabled&&!fixture.calls.some(x=>x[0]==='run');})()`);
  await shot('04-run-missing');
  await check('晚到预检不会覆盖用户已修改日期', `(async()=>{fixture.preflightMode='pending';button('检查所需数据').click();await waitUntil(()=>fixture.pendingPreflight);const end=document.querySelectorAll('dialog input[type=date]')[1];end.value='2026-09-04';end.dispatchEvent(new Event('change'));fixture.pendingPreflight({status:'ok',selectionRef:'old',inputs:[]});await waitUntil(()=>!button('检查所需数据').disabled);return button('确认运行').disabled;})()`);
  await check('失败保留草稿并要求重新预检', `(async()=>{fixture.preflightMode='ok';button('检查所需数据').click();await waitUntil(()=>!button('确认运行').disabled);button('确认运行').click();await waitUntil(()=>fixture.calls.some(x=>x[0]==='run'));await waitUntil(()=>!controller.busy);return document.querySelectorAll('dialog input[type=date]')[1].value==='2026-09-04'&&document.querySelector('.bizop-feedback').textContent.includes('输入已变化');})()`);
  await js('closeDialogs()');
  await check('导出结果的月份和单选框横排缩窄，标题左侧与分割线对齐', `(async()=>{
    await controller.setSelected(true);await controller.openResults();const d=document.querySelector('dialog'),m=d.querySelector('input[type=month]').getBoundingClientRect(),s=d.querySelector('select').getBoundingClientRect(),h=d.querySelector('.dialog-header');
    return Math.abs(m.top-s.top)<1&&m.right<s.left&&m.width>=180&&m.width<=200&&s.width>=280&&s.width<=360&&Math.abs(textLeft(d.querySelector('.dialog-title'))-h.getBoundingClientRect().left)<1;
  })()`);
  await shot('05-result-export');
  await js('closeDialogs()');
  await check('主导出只按操作月份和结果表选择差异', `(async()=>{await controller.openResults();const select=document.querySelector('dialog select');select.value='run-1';button('另存为差异结果').click();await waitUntil(()=>fixture.calls.some(x=>x[0]==='export'&&x[1]==='RESULT_DIFF'));await waitUntil(()=>!controller.busy);return fixture.calls.some(x=>x[0]==='export'&&x[1]==='RESULT_DIFF');})()`);
  await js('closeDialogs()');
  await check('双击只发一次导入，取消等待实际结果后才解除 busy', `(async()=>{button('导入文件').click();button('导入文件').click();await waitUntil(()=>fixture.importResolve);button('取消导入').click();await waitUntil(()=>fixture.calls.some(x=>x[0]==='cancel'));const held=controller.busy&&button('开始运行').disabled;fixture.importResolve({status:'cancelled'});await waitUntil(()=>!controller.busy);return held&&fixture.calls.filter(x=>x[0]==='import').length===1&&!button('开始运行').disabled;})()`);
  await js(`window.desktopApi={previewCapture:true,vccFinancialOp:{async listArchivedResultMonths(){return [];}}};document.querySelector('#modalRoot').hidden=false;`);
  await js(fs.readFileSync(path.join(source, 'renderer-vcc-financial-op.js'), 'utf8'));
  await check('实际 VCC 数据管理中操作标题与查看结果文字左侧对齐', `(async()=>{await __vccFinancialOpPreview.openDataManagerNoArchive();return operationAlignment(document.querySelector('#modalRoot'));})()`);
  await shot('06-vcc-manager');
  await js(`document.querySelector('#modalRoot [data-action=close]').click()`);
  await check('DISABLED 恢复旧路由，退出模块不出现晚到新页面', `(async()=>{fixture.mode='DISABLED';await controller.setSelected(true);const old=!document.querySelector('#legacy').hidden&&document.querySelector('#modern').hidden&&fixture.legacy===1;await controller.setSelected(false);return old&&document.querySelector('#modern').hidden;})()`);
  fs.writeFileSync(path.join(output, 'validation.json'), JSON.stringify({ pass: checks.length, fail: 0, checks, electron: process.versions.electron, fixtureApi: true }, null, 2));
  process.stdout.write(`${checks.length} PASS / 0 FAIL\n${output}\n`); win.destroy(); app.quit();
})().catch((error) => {
  fs.writeFileSync(path.join(output, 'validation.json'), JSON.stringify({ pass: checks.length, fail: 1, checks, error: error.message }, null, 2));
  process.stderr.write(error.stack + '\n'); app.exit(1);
}).finally(() => { fs.rmSync(temp, { recursive: true, force: true }); });
