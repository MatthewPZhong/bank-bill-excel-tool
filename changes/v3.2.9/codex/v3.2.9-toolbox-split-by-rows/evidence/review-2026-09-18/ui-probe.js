'use strict';
const project = '/private/tmp/toolbox-rows-review-w5qxlh5q';
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'toolbox-rows-ui-review-'));
app.setPath('userData', path.join(root, 'user-data'));
app.disableHardwareAcceleration();
const timer = setTimeout(() => app.exit(1), 30000);
(async () => {
  await app.whenReady();
  const win = new BrowserWindow({show:false,width:1080,height:800,webPreferences:{nodeIntegration:false,contextIsolation:true,backgroundThrottling:false}});
  const html = fs.readFileSync(path.join(project, 'index.html'),'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi,'').replace('<head>',`<head><base href="${pathToFileURL(project + path.sep).href}">`);
  const preview = path.join(root,'index.html'); fs.writeFileSync(preview,html);
  await win.loadFile(preview);
  await win.webContents.executeJavaScript(fs.readFileSync(path.join(project,'src/renderer-dialogs.js'),'utf8'));
  const result = await win.webContents.executeJavaScript(`(async () => {
    const root = document.getElementById('modalRoot');
    let total = 1;
    const api = {toolbox:{splitRead:async () => ({status:'success',sourceFilePath:'/fixture.csv',splitReadToken:'token',dataRowCount:total,maxRowSplitFiles:1000,headers:['A'],valuesByField:{A:['x']}}),splitExport:async () => ({status:'success',mode:'rows',fileCount:total,outputDataRowCount:total,files:Array.from({length:total},(_,i)=>({fileName:'流水明细_按行拆分_'+String(i+1).padStart(4,'0')+'.xlsx',filePath:'/Users/test/Downloads/流水明细_按行拆分_'+String(i+1).padStart(4,'0')+'.xlsx',dataRowCount:1}))})}};
    const dialogs = window.__rendererDialogs.createRendererDialogs({state:{},elements:{modalRoot:root},appConstants:{},desktopApi:api});
    const q = sel => root.querySelector(sel);
    const tick = () => new Promise(resolve=>setTimeout(resolve,20));
    const rect = el => {const r=el.getBoundingClientRect();return {top:r.top,bottom:r.bottom,left:r.left,right:r.right,height:r.height,clientHeight:el.clientHeight,scrollHeight:el.scrollHeight,overflowY:getComputedStyle(el).overflowY,minHeight:getComputedStyle(el).minHeight};};
    const results=[];
    for (const count of [1,8,9,30,1000]) {
      total=count; root.replaceChildren(dialogs.createToolboxDialog());
      q('[data-action="split-import"]').click(); await tick();
      const checkbox=q('[data-field="split-by-rows"]');checkbox.focus();checkbox.click();
      const focusedAfterToggle = document.activeElement.getAttribute('data-field');
      const input=q('[data-field="rows-per-file"]');input.value='1';input.dispatchEvent(new Event('input',{bubbles:true}));
      q('[data-action="complete"]').click(); await tick(); await document.fonts.ready;
      const card=q('.alert-card'),body=q('.alert-body'),button=q('.alert-card button'),message=q('.alert-message');
      const buttonRect=button.getBoundingClientRect();
      const hit=document.elementFromPoint(buttonRect.left+buttonRect.width/2,buttonRect.top+buttonRect.height/2);
      results.push({count,focusedAfterToggle,viewport:innerHeight,card:rect(card),body:rect(body),button:rect(button),message:rect(message),buttonVisibleAtCenter:hit===button||button.contains(hit)});
    }
    return results;
  })()`);
  fs.writeFileSync('/private/tmp/toolbox-rows-ui-review-result.json',JSON.stringify(result,null,2));
  fs.writeFileSync('/private/tmp/toolbox-rows-ui-review-1000.png',(await win.webContents.capturePage()).toPNG());
  console.log(JSON.stringify(result));win.destroy();clearTimeout(timer);app.quit();
})().catch(error=>{console.error(error);app.exit(1)});
app.on('will-quit',()=>fs.rmSync(root,{recursive:true,force:true}));
