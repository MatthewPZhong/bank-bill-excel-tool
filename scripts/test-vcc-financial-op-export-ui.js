'use strict';

// VCC 结果导出弹窗：用固定基线与当前工厂/真实样式对比尺寸，验证状态和交互。
// 仅加载 Renderer、modal host 和合成内存 API；不加载产品 Main、不访问业务数据。
// 用法：node scripts/test-vcc-financial-op-export-ui.js [证据目录]
// 可用 VCC_EXPORT_UI_BASELINE 指定基线提交；默认取本功能的 v3.2.10 固定基线。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { createHash } = require('node:crypto');
const ROOT = path.resolve(__dirname, '..');
const BASELINE = process.env.VCC_EXPORT_UI_BASELINE || '18b82b4328cf5e00c1b2549d373a5b2f2677215c';

async function verify() {
  const { app, BrowserWindow } = require('electron');
  const temporary = process.env.VCC_EXPORT_UI_TEMP;
  if (!temporary) throw new Error('请通过 Node 入口运行隔离 UI 验证');
  app.setPath('userData', path.join(temporary, 'userData'));
  app.setPath('documents', path.join(temporary, 'Documents'));
  fs.mkdirSync(app.getPath('documents'), { recursive: true });
  app.disableHardwareAcceleration();
  app.on('window-all-closed', () => {});
  await app.whenReady();
  const output = path.resolve(process.argv[2] || path.join(ROOT, 'outputs/vcc-financial-op-export-ui'));
  fs.mkdirSync(output, { recursive: true });
  const baselineCommit = execFileSync('git', ['rev-parse', BASELINE], { cwd: ROOT, encoding: 'utf8' }).trim();
  const read = (file, baseline) => baseline
    ? execFileSync('git', ['show', `${baselineCommit}:${file}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
    : fs.readFileSync(path.join(ROOT, file), 'utf8');
  const evidence = { baselineCommit, platform: process.platform, versions: process.versions, measurements: [], cases: [], sourceHashes: {},
    notVerified: ['macOS 原生下拉菜单的方向键/Enter 选择提交无法由 webContents 注入稳定驱动，待人工验证；未为测试修改控件行为。', 'Windows 及其他操作系统的原生控件表现待对应平台验收。'] };
  for (const file of ['src/renderer-vcc-financial-op.js', 'src/styles-vcc-financial-op.css']) {
    evidence.sourceHashes[file] = createHash('sha256').update(read(file, false)).digest('hex');
  }
  let win;
  let serial = 0;
  let passed = 0;
  let total = 0;
  const failures = [];
  const js = (source) => win.webContents.executeJavaScript(source, true);
  async function check(label, run) {
    total += 1;
    try { await run(); passed += 1; evidence.cases.push({ label, passed: true }); console.log(`PASS ${label}`); }
    catch (error) { failures.push({ label, error: error.stack }); evidence.cases.push({ label, passed: false, error: error.stack }); console.error(`FAIL ${label}: ${error.stack}`); }
  }
  async function setup({ baseline = false, width = 1080, height = 760, theme = 'light', zoom = 1 } = {}) {
    if (win) win.destroy();
    win = new BrowserWindow({ show: false, frame: false, width, height,
      webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false, zoomFactor: zoom }
    });
    const folder = path.join(temporary, `fixture-${++serial}`);
    fs.mkdirSync(folder, { recursive: true });
    const styles = [...read('index.html', baseline).matchAll(/<link\b[^>]*href="([^\"]+\.css)"[^>]*>/g)].map(match => match[1]);
    const links = styles.map((relative, index) => {
      const source = read(relative.replace(/^\.\//, ''), baseline).replace(/url\(["']?(\.\.\/[^)'"\s]+)["']?\)/g, (_match, asset) => {
        return `url("${pathToFileURL(path.resolve(ROOT, path.dirname(relative), asset)).href}")`;
      });
      const css = path.join(folder, `${index}.css`);
      fs.writeFileSync(css, source);
      return `<link rel="stylesheet" href="${pathToFileURL(css).href}">`;
    }).join('\n');
    const file = path.join(folder, 'fixture.html');
    fs.writeFileSync(file, `<!doctype html><html lang="zh-CN" data-theme="${theme}"><head><meta charset="utf-8">${links}</head>
      <body data-style="clear" data-platform="${process.platform}"><section id="fixturePanel" style="margin:24px">
      <button id="vccFinancialOpImportBtn">导入文件</button><button id="vccFinancialOpRunBtn">开始运行</button>
      <button id="vccFinancialOpExportBtn">导出校验结果表</button><button id="vccFinancialOpDataManagerBtn">数据管理</button>
      <div id="vccFinancialOpStatusBox" class="status-box"><span class="status-box-text"></span></div></section><div id="modalRoot"></div></body></html>`);
    await win.loadFile(file);
    for (const source of ['src/renderer/modal-host.js', 'src/shared/vcc-review-projection.js', 'src/shared/vcc-financial-op-difference.js', 'src/renderer-vcc-financial-op.js']) {
      await js(read(source, baseline) + '\n;void 0;');
    }
    await js(`(async () => {
      window.fixture = {
        rows: [{ targetMonth:'2026-06' }, { targetMonth:'2026-05' }, { targetMonth:'2025-12' }], calls: [], errors: [],
        deferred() { let resolve, reject; const promise = new Promise((yes,no)=>{resolve=yes;reject=no;}); return {promise,resolve,reject}; },
        tick: () => new Promise(resolve => setTimeout(resolve, 0))
      };
      fixture.months = async () => fixture.rows;
      fixture.export = async payload => { fixture.calls.push(payload); return {status:'success',filePaths:['/synthetic/2026-06.xlsx']}; };
      fixture.host = window.__modalHost.createModalHost({root:document.getElementById('modalRoot'),document,reportError:error=>fixture.errors.push(String(error))});
      fixture.controller = window.__vccFinancialOpController.createVccFinancialOpController({
        api:{listArchivedResultMonths:()=>fixture.months(),exportResult:payload=>fixture.export(payload)},
        panel:document.getElementById('fixturePanel'),modalHost:fixture.host,
        differenceApi:window.__vccFinancialOpDifference,reviewProjection:window.__vccReviewProjection,previewEnabled:true
      });
      await fixture.controller.enter();
      fixture.open = async () => { fixture.host.closeOwner('vcc-financial-op','navigation'); fixture.modal=await fixture.controller.commands.export(); return fixture.modal?.waitForPreviewState(); };
      fixture.select = async (field,value) => { const node=document.querySelector('[data-field="'+field+'"]'); node.value=value; node.dispatchEvent(new Event('change',{bubbles:true})); return fixture.modal.waitForPreviewState(); };
      fixture.snapshot = () => {
        const state=document.querySelector('[data-role="archive-picker-state"]');
        return { message:state?.textContent, hidden:state?.hidden, height:state?.getBoundingClientRect().height,
          disabled:document.querySelector('[data-action="archive-picker-confirm"]')?.disabled,
          selected:document.querySelector('[data-field="archive-month"]')?.value,
          tone:state?.dataset.tone,
          status:document.querySelector('.status-box-text').textContent,
          statusTone:document.getElementById('vccFinancialOpStatusBox').dataset.tone,
          modalCount:document.getElementById('modalRoot').children.length, errors:fixture.errors };
      };
      await document.fonts.ready;
    })()`);
  }
  async function paint() {
    await js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    await js('Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => {})))');
  }
  async function screenshot(name) { await paint(); fs.writeFileSync(path.join(output, `${name}.png`), (await win.webContents.capturePage()).toPNG()); }
  async function metrics() {
    await paint();
    return js(`(() => {
      const dialog=document.querySelector('.vcc-fin-op-archive-picker-dialog');
      const fields=dialog.querySelector('.vcc-fin-op-archive-picker-fields');
      const controls=[...fields.querySelectorAll('select')].map(node => {
        const rect=node.getBoundingClientRect(), style=getComputedStyle(node), canvas=document.createElement('canvas');
        const context=canvas.getContext('2d'); context.font=style.font;
        return { width:rect.width,height:rect.height,left:rect.left-dialog.getBoundingClientRect().left,
          font:style.font,fontSize:style.fontSize,paddingLeft:parseFloat(style.paddingLeft),paddingRight:parseFloat(style.paddingRight),
          textWidth:context.measureText(node.selectedOptions[0].textContent).width,label:node.selectedOptions[0].textContent,
          hit:document.elementFromPoint(rect.left+rect.width/2,rect.top+rect.height/2)===node,
          appearance:style.appearance, value:node.value };
      });
      return {viewport:{width:innerWidth,height:innerHeight,ratio:devicePixelRatio},dialogWidth:dialog.getBoundingClientRect().width,
        grid:getComputedStyle(fields).gridTemplateColumns,controls,...fixture.snapshot()};
    })()`);
  }
  try {
    const windows = process.env.VCC_EXPORT_UI_BEHAVIOR_ONLY === '1' ? [] : [[1080, 760], [1240, 860]];
    for (const [width, height] of windows) {
      for (const theme of ['light', 'dark']) {
        for (const zoom of [1, 1.25]) {
          await check(`真实尺寸 ${width}×${height} ${theme} zoom=${zoom}`, async () => {
            await setup({ baseline: true, width, height, theme, zoom });
            await js('fixture.open()');
            const before = await metrics();
            if (width === 1080 && zoom === 1) await screenshot(`baseline-export-${theme}`);
            await js('fixture.host.closeTop(); fixture.controller.preview.openUnarchive();');
            const unarchiveBefore = await metrics();
            await setup({ width, height, theme, zoom });
            await js('fixture.open()');
            const after = await metrics();
            assert.equal(after.hidden, true); assert.equal(after.height, 0); assert.equal(after.message, ''); assert.equal(after.disabled, false);
            assert.equal(after.dialogWidth, before.dialogWidth); assert.equal(after.grid, before.grid);
            for (let index = 0; index < 2; index += 1) {
              const oldControl = before.controls[index], control = after.controls[index];
              assert.ok(Math.abs(control.width - oldControl.width * 0.4) <= 1, JSON.stringify({ oldControl, control }));
              assert.equal(control.height, oldControl.height); assert.equal(control.font, oldControl.font); assert.equal(control.left, oldControl.left);
              assert.equal(control.hit, true); assert.equal(control.appearance, oldControl.appearance);
              assert.ok(control.width - control.paddingLeft - control.paddingRight - 2 - 18 >= control.textWidth,
                `文字与原生箭头空间不足：${JSON.stringify(control)}`);
            }
            await screenshot(`export-${width}-${theme}-${zoom}`);
            await js('fixture.host.closeTop(); fixture.controller.preview.openUnarchive();');
            const unarchiveAfter = await metrics();
            assert.deepEqual(unarchiveAfter.controls, unarchiveBefore.controls);
            assert.equal(unarchiveAfter.message, unarchiveBefore.message); assert.equal(unarchiveAfter.hidden, false); assert.ok(unarchiveAfter.height > 0);
            evidence.measurements.push({width,height,theme,zoom,before,after,unarchiveBefore,unarchiveAfter});
          });
        }
      }
    }
    await setup();
    await check('首次进入、切换年月、重开与预览入口隐藏就绪提示且保留资格', async () => {
      await js('fixture.open()');
      for (const [field, value] of [['archive-year','2025'],['archive-year','2026'],['archive-month','2026-05']]) {
        const snapshot=await js(`fixture.select(${JSON.stringify(field)},${JSON.stringify(value)})`);
        assert.equal(snapshot.stateHidden,true); assert.equal(snapshot.stateMessage,''); assert.equal(snapshot.confirmDisabled,false);
      }
      await js('fixture.open()');
      assert.equal((await js('fixture.snapshot()')).hidden,true);
      await js('fixture.host.closeTop(); fixture.controller.preview.openResultExportMonth()');
      assert.equal((await js('fixture.snapshot()')).hidden,true);
    });
    await check('真实键盘 Tab 可从年份移动至月份控件', async () => {
      await js('fixture.open();'); await paint();
      win.show(); win.focus(); win.webContents.focus();
      await new Promise(resolve => setTimeout(resolve, 100));
      await js('document.querySelector(\'[data-field="archive-year"]\').focus()');
      const key = async keyCode => {
        win.webContents.sendInputEvent({type:'keyDown',keyCode});
        win.webContents.sendInputEvent({type:'keyUp',keyCode});
        await new Promise(resolve => setTimeout(resolve, 40));
      };
      await key('Tab');
      assert.equal(await js('document.activeElement.dataset.field'),'archive-month');
      win.hide();
    });
    await check('资格加载、失败和失败恢复可见性正确', async () => {
      await js(`fixture.open();`);
      await js(`fixture.pending=fixture.deferred();fixture.months=()=>fixture.pending.promise;void fixture.select('archive-month','2026-05');`);
      let snapshot=await js('fixture.snapshot()');
      assert.equal(snapshot.hidden,false); assert.equal(snapshot.disabled,true); assert.match(snapshot.message,/正在核对/);
      await js(`fixture.pending.reject(new Error('合成月份读取失败'));fixture.tick()`);
      snapshot=await js('fixture.snapshot()');
      assert.equal(snapshot.hidden,false); assert.equal(snapshot.tone,'error'); assert.match(snapshot.message,/合成月份读取失败/);
      await js(`fixture.months=async()=>fixture.rows;fixture.select('archive-month','2026-06')`);
      snapshot=await js('fixture.snapshot()');
      assert.equal(snapshot.hidden,true); assert.equal(snapshot.message,''); assert.equal(snapshot.disabled,false);
    });
    await check('迟到的失败响应不能覆盖新月份就绪状态', async () => {
      await js(`fixture.first=fixture.deferred();fixture.second=fixture.deferred();let requests=0;fixture.months=()=>++requests===1?fixture.first.promise:fixture.second.promise;
        void fixture.select('archive-month','2026-05');void fixture.select('archive-year','2025');
        fixture.second.resolve(fixture.rows);fixture.tick();`);
      await js(`fixture.first.reject(new Error('旧请求失败'));fixture.tick();`);
      const snapshot=await js('fixture.snapshot()');
      assert.equal(snapshot.selected,'2025-12');assert.equal(snapshot.hidden,true);assert.equal(snapshot.disabled,false);
      await js('fixture.months=async()=>fixture.rows;void 0;');
    });
    await check('月份资格失效阻止执行并显示空态，重新打开可恢复', async () => {
      await js(`fixture.months=async()=>[];fixture.select('archive-month','2025-12')`);
      const snapshot=await js('fixture.snapshot()');
      assert.equal(snapshot.hidden,false);assert.equal(snapshot.disabled,true);assert.match(snapshot.message,/暂无已归档/);
      await js(`document.querySelector('[data-action="archive-picker-confirm"]').click();fixture.tick();`);
      assert.equal(await js('fixture.calls.length'),0);
      await js(`fixture.months=async()=>fixture.rows;fixture.open()`);
      assert.equal((await js('fixture.snapshot()')).hidden,true);
    });
    await check('执行锁、关闭保护、取消及导出失败反馈可见', async () => {
      await js(`fixture.pending=fixture.deferred();fixture.export=()=>fixture.pending.promise;document.querySelector('[data-action="archive-picker-confirm"]').click();fixture.tick();`);
      let snapshot=await js('fixture.snapshot()');
      assert.equal(snapshot.hidden,false);assert.match(snapshot.message,/正在导出/);assert.equal(snapshot.disabled,true);
      assert.deepEqual(await js(`({year:document.querySelector('[data-field="archive-year"]').disabled,month:document.querySelector('[data-field="archive-month"]').disabled,
        close:document.querySelector('[data-action="close"]').disabled,status:fixture.host.closeTop().status})`),{year:true,month:true,close:true,status:'blocked'});
      await js(`fixture.pending.resolve({status:'cancelled'});fixture.tick();`);
      snapshot=await js('fixture.snapshot()');assert.equal(snapshot.hidden,false);assert.match(snapshot.message,/已取消导出/);assert.equal(snapshot.disabled,false);
      await js(`fixture.export=async()=>{throw new Error('合成导出失败')};document.querySelector('[data-action="archive-picker-confirm"]').click();fixture.tick();`);
      snapshot=await js('fixture.snapshot()');assert.equal(snapshot.hidden,false);assert.equal(snapshot.tone,'error');assert.match(snapshot.message,/合成导出失败/);
      await js(`fixture.select('archive-month','2026-05')`);
      assert.equal((await js('fixture.snapshot()')).hidden,true);
    });
    await check('正式文件已保存且接管待重试在主状态区明确告警', async () => {
      await js(`fixture.export=async(payload)=>{fixture.calls.push(payload);return {status:'success',filePaths:['/synthetic/month.xlsx'],subjectCount:2,
        pendingArchiveHandoff:true,warnings:['恢复凭据已保留，启动时重试。']};};
        document.querySelector('[data-action="archive-picker-confirm"]').click();fixture.tick();`);
      const snapshot=await js('fixture.snapshot()');
      assert.equal(snapshot.modalCount,0);assert.equal(snapshot.statusTone,'warning');assert.match(snapshot.status,/已保存（1 个文件）/);
      assert.match(snapshot.status,/存档接管待重试/);assert.match(snapshot.status,/恢复凭据已保留/);assert.doesNotMatch(snapshot.status,/导出失败/);
      assert.deepEqual(await js('fixture.calls'),[{targetMonth:'2026-05'}]);
      await screenshot('archive-handoff-warning');
    });
    await check('其他发布告警保留；正常完成按实际单文件显示', async () => {
      await js(`fixture.open()`);
      await js(`fixture.export=async()=>({status:'success',filePaths:['/synthetic/month.xlsx'],warnings:['合成后续处理告警']});
        document.querySelector('[data-action="archive-picker-confirm"]').click();fixture.tick();`);
      let snapshot=await js('fixture.snapshot()');assert.equal(snapshot.statusTone,'warning');assert.match(snapshot.status,/已导出（1 个文件）.*合成后续处理告警/);
      await js(`fixture.open()`);
      await js(`fixture.export=async()=>({status:'success',filePaths:['/synthetic/month.xlsx'],subjectCount:2});
        document.querySelector('[data-action="archive-picker-confirm"]').click();fixture.tick();`);
      snapshot=await js('fixture.snapshot()');assert.equal(snapshot.statusTone,'success');assert.equal(snapshot.status,'2026-06 校验结果已导出（1 个文件）');
      assert.deepEqual(snapshot.errors,[]);
    });
    await check('无 code 的 IPC 未知提交错误在月份漂移后只提示待确认并保留恢复说明', async () => {
      await js('fixture.open()');
      const recoveryExplanation = '结果文件的提交状态尚未确认，已保留文件与恢复凭据，请完成恢复后重试。';
      const recoveryMessage = "Error invoking remote method 'vccFinancialOp:export:result': Error: " + recoveryExplanation;
      await js(`fixture.export=async()=>{fixture.months=async()=>[{targetMonth:'2026-05'}];throw new Error(${JSON.stringify(recoveryMessage)})};
        document.querySelector('[data-action="archive-picker-confirm"]').click();fixture.tick();`);
      const snapshot=await js('fixture.snapshot()');
      assert.equal(snapshot.selected,'2026-05');assert.equal(snapshot.modalCount,1);assert.equal(snapshot.hidden,false);
      assert.equal(snapshot.tone,'warning');assert.equal(snapshot.statusTone,'warning');
      for (const text of [snapshot.message,snapshot.status]) {
        assert.match(text,/^2026-06 提交状态待确认：结果文件的提交状态尚未确认/);assert.ok(text.includes(recoveryExplanation));
        assert.doesNotMatch(text,/Error invoking|vccFinancialOp:export:result/);
        assert.doesNotMatch(text,/导出失败|已导出|已保存|请确认后重试/);
      }
      assert.match(snapshot.message,/切至 2026-05，请先完成恢复后再操作/);
      evidence.publicationUncertainFeedback=snapshot;
      await screenshot('publication-uncertain-warning');
    });
    await check('无可导出月份和初始列表读取失败仍有可见反馈', async () => {
      await js('fixture.months=async()=>[];fixture.open()');
      let snapshot=await js('fixture.snapshot()');assert.match(snapshot.status,/暂无已归档/);assert.equal(snapshot.modalCount,1);
      assert.equal(await js('document.getElementById("vccFinancialOpExportBtn").disabled'),true);
      await js(`fixture.months=async()=>{throw new Error('合成初始读取失败')};fixture.open()`);
      snapshot=await js('fixture.snapshot()');assert.match(snapshot.status,/导出失败.*合成初始读取失败/);assert.equal(snapshot.statusTone,'error');assert.equal(snapshot.modalCount,1);
    });
  } finally {
    evidence.passed=passed;evidence.total=total;evidence.failures=failures;
    fs.writeFileSync(path.join(output,'evidence.json'),JSON.stringify(evidence,null,2)+'\n');
    if(win)win.destroy();
    console.log(`==== ${passed}/${total} PASS ====`);
    app.exit(failures.length ? 1 : 0);
  }
}

if (process.versions.electron) {
  verify().catch(error => { console.error(error.stack); require('electron').app.exit(1); });
} else {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'vcc-export-ui-'));
  const env = {...process.env,VCC_EXPORT_UI_TEMP:temporary};
  delete env.ELECTRON_RUN_AS_NODE;
  try {
    const result=spawnSync(require('electron'),[__filename,...process.argv.slice(2)],{cwd:ROOT,env,stdio:'inherit',timeout:120000});
    if(result.error)console.error(result.error.message);
    process.exitCode=result.status===0?0:1;
  } finally { fs.rmSync(temporary,{recursive:true,force:true}); }
}
