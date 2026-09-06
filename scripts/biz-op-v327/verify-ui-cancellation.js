'use strict';
// 真实 Electron 模态与鼠标/键盘输入；后台 API 为可控夹具，真实 IPC/Task 另跑合同测试。
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow } = require('electron');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bizop-ui-cancel-'));
app.setPath('userData', path.join(temp, 'user-data'));
const output = path.resolve(process.argv[2] || 'outputs/pr5-validation/ui-cancellation');
fs.mkdirSync(output, { recursive: true });
const source = path.resolve(__dirname, '../../src');
const link = (file) => pathToFileURL(path.join(source, file)).href;
const html = path.join(temp, 'fixture.html');
fs.writeFileSync(html, `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>业务 OP 取消操作验证</title>
${['fonts.css', 'styles-gemini.css', 'styles-gemini-extra.css', 'styles-vcc-financial-op.css', 'styles-biz-op-v327.css'].map((file) => `<link rel="stylesheet" href="${link(file)}">`).join('')}
<style>body{padding:40px;background:#f3f5ee}.control-board{display:block;width:100%;box-sizing:border-box;background:white;padding:24px}</style>
<h1>业务 OP 数据核对</h1><section id="legacy"></section><section id="panel" class="control-board"></section>
<script src="${link('renderer-biz-op-v327.js')}"></script></html>`);
const checks = [];
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
(async () => {
  await app.whenReady();
  const win = new BrowserWindow({ width: 1200, height: 900, show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
  const js = (code) => win.webContents.executeJavaScript(code, true);
  const until = async (code) => {
    try { await js(`waitUntil(()=>(${code}))`); }
    catch (error) { throw new Error(`等待 ${code} 失败；已通过 ${checks.join(', ')}：${error.message}`); }
  };
  async function mouse(point) {
    for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, ...point, button: 'left', clickCount: 1 });
    await pause(40);
  }
  async function click(text) {
    const state = await js(`(()=>{const b=target(${JSON.stringify(text)});const r=b.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),disabled:b.disabled,hidden:b.hidden}})()`);
    assert.equal(state.disabled, false, text); assert.equal(state.hidden, false, text);
    await mouse({ x: state.x, y: state.y });
  }
  async function key(keyCode) {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode });
    if (keyCode === 'Enter') win.webContents.sendInputEvent({ type: 'char', keyCode: '\r' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode });
    await pause(40);
  }
  async function screenshot(name) {
    await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    fs.writeFileSync(path.join(output, `${name}.png`), (await win.webContents.capturePage()).toPNG());
  }
  for (const scenario of ['import', 'import-keyboard', 'run-mouse', 'run-keyboard', 'result-export', 'raw-export', 'manager-export', 'delete', 'keep-delete', 'publish-protected', 'late-cancel']) {
    const importing = scenario.startsWith('import') || scenario === 'late-cancel';
    const cancelLabel = importing ? '取消导入' : '取消当前操作';
    await win.loadFile(html);
    await js(`(async()=>{
      window.fixture={cancelCalls:[],requests:[],finish:null,cancelFinish:null};
      const run={objectId:'run-1',rowKey:'run-1',startDate:'2026-09-01',endDate:'2026-09-03',version:1,tableName:'业务OP校验结果表_2026-09-01~09-03_v1',updatedAt:'2026-09-06T00:00:00.000Z',operationMonth:'2026-09'};
      const input={objectId:'input-1',kind:'OP',dataDate:'2026-09-01',version:1,originals:[{originalName:'OP_20260901.xlsx'}]};
      const pending=(value)=>{fixture.requests.push(value);return new Promise(resolve=>fixture.finish=resolve);};
      const api={async status(){return {mode:'ACTIVE',recoveryReady:true}},async months(){return {months:['2026-09']}},async list(){return {generation:1,rows:[run],nextCursor:null}},
        async preflight(){return {status:'ok',selectionRef:'selection-run',inputs:[]}},run:pending,
        async pickFiles(){return {status:'ok',selectionRef:'selection-import'}},importFiles:pending,
        async pickExport(){return {status:'ok',selectionRef:'selection-export'}},exportWorkbook(kind,value){return pending(value)},
        async currentInput(){return input},
        async deletePreview(){return {previewId:'preview-1',selection:{runIds:[],datasetIds:['input-1']},datasets:[input],runs:[{...run,originals:input.originals}],references:{protectedAfterKeep:1,protectedAfterDelete:0,userLockedOriginals:0,sharedBlobOriginals:0}}},deleteData:pending,
        async cancel(value){fixture.cancelCalls.push(value);return new Promise(resolve=>fixture.cancelFinish=resolve)}};
      window.controller=createBizOpV327Controller({api,panel:document.querySelector('#panel'),legacyPanel:document.querySelector('#legacy'),restoreLegacy(){}});
      window.target=(text)=>[...document.querySelectorAll('button')].filter(b=>!b.hidden&&b.textContent===text).at(-1);
      window.waitUntil=async(fn)=>{for(let n=0;n<300;n++){if(fn())return;await new Promise(resolve=>setTimeout(resolve,10));}throw new Error('页面条件未收敛');};
      await controller.setSelected(true);
    })()`);
    let importRect;
    if (importing) {
      importRect = await js("(()=>{const r=target('导入文件').getBoundingClientRect();return [r.x,r.y,r.width,r.height]})()");
      await click('导入文件');
    }
    if (scenario.startsWith('run-')) {
      await click('开始运行');
      await js("document.querySelectorAll('dialog input')[0].value='2026-09-01';document.querySelectorAll('dialog input')[1].value='2026-09-03'");
      await click('检查所需数据'); await until("!target('确认运行').disabled"); await click('确认运行');
    }
    if (['result-export', 'publish-protected'].includes(scenario)) {
      await click('导出校验结果表'); await until("document.querySelector('dialog select')?.options.length===2");
      await js("document.querySelector('dialog select').value='run-1'"); await click('另存为差异结果');
    }
    if (scenario === 'raw-export') {
      await click('数据管理'); await until("Boolean(target('导出'))"); await click('导出');
      await js("[...document.querySelectorAll('dialog')].at(-1).querySelector('input[type=date]').value='2026-09-01'"); await click('选择位置并导出');
    }
    if (['manager-export', 'delete', 'keep-delete'].includes(scenario)) {
      await click('数据管理'); await until("document.querySelector('dialog td')");
      if (scenario === 'manager-export') await click('导出原表');
      else {
        await click('删除');
        const point = await js("(()=>{const r=document.querySelector('input[type=checkbox]').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()");
        await mouse(point); await click('删除'); await until("document.querySelectorAll('dialog[open]').length===2");
        await click(scenario === 'keep-delete' ? '删除但保留结果表' : '删除');
      }
    }
    await until('Boolean(fixture.finish)&&controller.busy');
    const before = await js(`(()=>{const b=target(${JSON.stringify(cancelLabel)}),r=b.getBoundingClientRect(),d=[...document.querySelectorAll('dialog[open]')].at(-1);return {
      dialogs:document.querySelectorAll('dialog[open]').length,inside:d?d.contains(b):document.querySelector('#panel').contains(b),
      hit:document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===b,focused:document.activeElement===b,
      rect:[r.x,r.y,r.width,r.height],x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
    assert.equal(before.inside, true, scenario); assert.equal(before.hit, true, scenario); assert.equal(before.focused, true, scenario);
    if (importing) {
      assert.deepEqual(before.rect, importRect, '取消导入精确替换原按钮位置和尺寸');
      assert.equal(await js("document.querySelector('.bizop-secondary').hidden"), true);
    }
    if (scenario === 'manager-export') assert.equal(await js("document.querySelector('dialog .bizop-feedback').checkVisibility()"), false);
    if (['import', 'run-mouse', 'delete', 'manager-export'].includes(scenario)) await screenshot(scenario);
    if (scenario.endsWith('keyboard')) await key('Enter'); else await click(cancelLabel);
    await until('fixture.cancelCalls.length===1');
    // 第二次真实鼠标/键盘输入在取消响应尚未返回时也不能重复提交。
    await mouse({ x: before.x, y: before.y }); await key('Enter'); await key('Escape');
    const held = await js(`({calls:fixture.cancelCalls,requests:fixture.requests,busy:controller.busy,disabled:target(${JSON.stringify(cancelLabel)}).disabled,dialogs:document.querySelectorAll('dialog[open]').length})`);
    assert.equal(held.calls.length, 1); assert.equal(held.calls[0].requestId, held.requests[0].requestId);
    assert.equal(held.busy, true); assert.equal(held.disabled, true); assert.equal(held.dialogs, before.dialogs);
    if (scenario === 'late-cancel') {
      await js("fixture.finish({status:'cancelled'});fixture.oldCancelFinish=fixture.cancelFinish;void 0"); await until('!controller.busy');
      await click('导入文件'); await until('fixture.requests.length===2&&controller.busy');
      await js("fixture.oldCancelFinish({status:'cancelling',message:'旧请求的晚到消息'})"); await pause(40);
      assert.equal(await js("!document.querySelector('.bizop-status').textContent.includes('旧请求')&&!target('取消导入').disabled&&controller.busy"), true);
    } else {
      const protectedPublish = scenario === 'publish-protected';
      const text = protectedPublish ? '文件正在发布与归档，请等待实际完成' : '已请求取消，正在等待后台任务退出';
      await js(`fixture.cancelFinish(${JSON.stringify({ status: protectedPublish ? 'protected' : 'cancelling', message: text })})`);
      await until(`document.querySelector('.bizop-status').textContent===${JSON.stringify(text)}`);
      assert.equal(await js('controller.busy'), true);
      if (before.dialogs) assert.equal(await js(`[...document.querySelectorAll('dialog[open]')].at(-1).querySelector('.bizop-feedback').textContent`), scenario === 'manager-export' ? '' : text);
      if (protectedPublish) await screenshot(scenario);
    }
    await js(`fixture.finish({status:${JSON.stringify(scenario === 'publish-protected' ? 'ok' : 'cancelled')}})`); await until('!controller.busy');
    await js("[...document.querySelectorAll('dialog')].reverse().forEach(dialog=>dialog.close())"); await pause(40);
    assert.equal(await js("[...document.querySelectorAll('#panel button')].some(b=>b.textContent==='取消当前操作'&&b.hidden)&&!target('导入文件').disabled"), true);
    checks.push(scenario);
  }
  fs.writeFileSync(path.join(output, 'validation.json'), JSON.stringify({ pass: checks.length, fail: 0, checks,
    electron: process.versions.electron, realInputEvents: true, fixtureApi: true }, null, 2));
  process.stdout.write(`${checks.length} PASS / 0 FAIL\n${output}\n`); win.destroy(); app.quit();
})().catch((error) => { process.stderr.write(error.stack + '\n'); app.exit(1); })
  .finally(() => fs.rmSync(temp, { recursive: true, force: true }));
