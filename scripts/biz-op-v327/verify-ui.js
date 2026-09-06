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
const html = path.join(temp, 'preview.html');
fs.writeFileSync(html, `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>业务 OP 页面验证</title>
<link rel="stylesheet" href="${link('fonts.css')}"><link rel="stylesheet" href="${link('styles-gemini.css')}">
<link rel="stylesheet" href="${link('styles-gemini-extra.css')}"><link rel="stylesheet" href="${link('styles-biz-op-v327.css')}">
<style>body{margin:0;padding:44px;background:#f3f5ee}h1{font-size:24px;margin-bottom:28px}.control-board{display:block;width:100%;box-sizing:border-box;background:#fff;padding:26px;border-radius:14px}</style>
<h1>业务 OP 数据核对</h1><section id="legacy" hidden>旧版页面</section><section id="modern" class="control-board" hidden></section>
<script src="${link('renderer-biz-op-v327.js')}"></script></html>`);
const checks = [];
(async () => {
  await app.whenReady();
  const win = new BrowserWindow({ width: 1200, height: 900, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
  await win.loadFile(html);
  const js = (code) => win.webContents.executeJavaScript(code, true);
  await js(`(() => {
    const state = { mode:'ACTIVE', calls:[], legacy:0, preflightMode:'ok', pendingPreflight:null, importResolve:null };
    window.fixture = state;
    const originals = [{originalName:'BU_A_OP_20260901.xlsx'},{originalName:'BU_B_OP_20260901.xlsx'}];
    const run = {objectId:'run-1',rowKey:'run-1',startDate:'2026-09-01',endDate:'2026-09-03',version:2,tableName:'业务OP校验结果表_2026-09-01~09-03_v2',updatedAt:'2026-09-06T08:12:00.000Z',operationMonth:'2026-09'};
    const input = {objectId:'input-1',rowKey:'input-1:0',kind:'OP',dataDate:'2026-09-01',version:3,tableName:'OP校验表_2026-09-01_v3',updatedAt:'2026-09-06T08:00:00.000Z',originalName:'<img src=x onerror=alert(1)>.xlsx'};
    const api = {
      async status(){return {mode:state.mode,recoveryReady:true};}, async months(){return {months:['2026-09'],nextBefore:null};},
      async list(value){state.calls.push(['list',value]);return {generation:7,rows:value.view==='RESULT'?[run]:[input],nextCursor:null};},
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
    window.button=(name)=>[...document.querySelectorAll('dialog[open] button')].filter(x=>x.textContent===name).at(-1)||[...document.querySelectorAll('#modern button')].find(x=>x.textContent===name);
    window.closeDialogs=()=>[...document.querySelectorAll('dialog')].reverse().forEach(x=>x.close());
    window.waitUntil=async(fn)=>{for(let i=0;i<200;i++){if(fn())return;await new Promise(r=>setTimeout(r,10));}throw new Error('页面条件未收敛');};
  })()`);
  async function check(name, code) { const result = await js(code); if (result !== true) throw new Error(`${name}: ${JSON.stringify(result)}`); checks.push(name); }
  async function shot(name) { await js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))'); fs.writeFileSync(path.join(output, name + '.png'), (await win.webContents.capturePage()).toPNG()); }
  await check('Main mode 路由，ACTIVE 隐藏旧页面', `(async()=>{await controller.setSelected(true);return !document.querySelector('#modern').hidden&&document.querySelector('#legacy').hidden;})()`);
  await shot('01-main');
  await check('数据管理列顺序，主结果导出为全量原表', `(async()=>{await controller.openManager();button('导出原表').click();await waitUntil(()=>fixture.calls.some(x=>x[0]==='export'));return fixture.calls.find(x=>x[0]==='export')[1]==='RESULT_FULL'&&[...document.querySelectorAll('th')].map(x=>x.textContent).join('|')==='起始日期|终止日期|表名|结果版本|更新时间|操作';})()`);
  await check('原表文件名作为文本，选取阶段不删除', `(async()=>{const s=document.querySelectorAll('dialog select')[0];s.value='RAW';s.dispatchEvent(new Event('change'));await waitUntil(()=>document.querySelector('td')?.textContent==='2026-09-01');button('选取').click();await waitUntil(()=>document.querySelector('input[type=checkbox]'));const c=document.querySelector('input[type=checkbox]');c.checked=true;c.dispatchEvent(new Event('change'));return !document.querySelector('dialog img')&&document.querySelector('dialog').textContent.includes('<img src=x onerror=alert(1)>.xlsx')&&!fixture.calls.some(x=>x[0]==='delete');})()`);
  await shot('02-manager-select');
  await check('删除先完整跨月份预览，精确三个按钮', `(async()=>{button('删除').click();await waitUntil(()=>document.querySelectorAll('dialog').length===2);const d=[...document.querySelectorAll('dialog')].at(-1);return d.textContent.includes('2026-08')&&[...d.querySelectorAll('footer button,.bizop-modal-footer button')].map(x=>x.textContent).join('|')==='删除但保留结果表|删除|取消'&&!fixture.calls.some(x=>x[0]==='delete');})()`);
  await shot('03-delete-impact');
  await check('保留结果选择按 mode 提交，成功后刷新', `(async()=>{button('删除但保留结果表').click();await waitUntil(()=>fixture.calls.some(x=>x[0]==='delete'));await waitUntil(()=>!controller.busy);return fixture.calls.find(x=>x[0]==='delete')[1].mode==='KEEP_RESULTS';})()`);
  await js('closeDialogs()');
  await check('运行缺失输入可见，保留日期且不执行', `(async()=>{controller.openRun();const dates=document.querySelectorAll('dialog input[type=date]');dates[0].value='2026-09-01';dates[1].value='2026-09-03';fixture.preflightMode='missing';button('检查所需数据').click();await waitUntil(()=>document.querySelector('.bizop-feedback').textContent.includes('2026-09-02'));return dates[0].value==='2026-09-01'&&dates[1].value==='2026-09-03'&&button('确认运行').disabled&&!fixture.calls.some(x=>x[0]==='run');})()`);
  await shot('04-run-missing');
  await check('晚到预检不会覆盖用户已修改日期', `(async()=>{fixture.preflightMode='pending';button('检查所需数据').click();await waitUntil(()=>fixture.pendingPreflight);const end=document.querySelectorAll('dialog input[type=date]')[1];end.value='2026-09-04';end.dispatchEvent(new Event('change'));fixture.pendingPreflight({status:'ok',selectionRef:'old',inputs:[]});await waitUntil(()=>!button('检查所需数据').disabled);return button('确认运行').disabled;})()`);
  await check('失败保留草稿并要求重新预检', `(async()=>{fixture.preflightMode='ok';button('检查所需数据').click();await waitUntil(()=>!button('确认运行').disabled);button('确认运行').click();await waitUntil(()=>fixture.calls.some(x=>x[0]==='run'));await waitUntil(()=>!controller.busy);return document.querySelectorAll('dialog input[type=date]')[1].value==='2026-09-04'&&document.querySelector('.bizop-feedback').textContent.includes('输入已变化');})()`);
  await js('closeDialogs()');
  await check('主导出只按操作月份和结果表选择差异', `(async()=>{await controller.openResults();const select=document.querySelector('dialog select');select.value='run-1';button('另存为差异结果').click();await waitUntil(()=>fixture.calls.some(x=>x[0]==='export'&&x[1]==='RESULT_DIFF'));await waitUntil(()=>!controller.busy);return fixture.calls.some(x=>x[0]==='export'&&x[1]==='RESULT_DIFF');})()`);
  await js('closeDialogs()');
  await check('双击只发一次导入，取消等待实际结果后才解除 busy', `(async()=>{button('导入文件').click();button('导入文件').click();await waitUntil(()=>fixture.importResolve);button('取消当前操作').click();await waitUntil(()=>fixture.calls.some(x=>x[0]==='cancel'));const held=controller.busy&&button('开始运行').disabled;fixture.importResolve({status:'cancelled'});await waitUntil(()=>!controller.busy);return held&&fixture.calls.filter(x=>x[0]==='import').length===1&&!button('开始运行').disabled;})()`);
  await check('DISABLED 恢复旧路由，退出模块不出现晚到新页面', `(async()=>{fixture.mode='DISABLED';await controller.setSelected(true);const old=!document.querySelector('#legacy').hidden&&document.querySelector('#modern').hidden&&fixture.legacy===1;await controller.setSelected(false);return old&&document.querySelector('#modern').hidden;})()`);
  fs.writeFileSync(path.join(output, 'validation.json'), JSON.stringify({ pass: checks.length, fail: 0, checks, electron: process.versions.electron, fixtureApi: true }, null, 2));
  process.stdout.write(`${checks.length} PASS / 0 FAIL\n${output}\n`); win.destroy(); app.quit();
})().catch((error) => { process.stderr.write(error.stack + '\n'); app.exit(1); }).finally(() => { fs.rmSync(temp, { recursive: true, force: true }); });
