'use strict';

// 由 Electron 执行的隔离 DOM 验收，不启动业务 Main 或读取用户业务目录。
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'toolbox-rows-ui-'));
app.setPath('userData', path.join(root, 'user-data'));
app.disableHardwareAcceleration();
const project = path.resolve(__dirname, '..');

const watchdog = setTimeout(() => { console.error('隔离 UI 验收超时'); app.exit(1); }, 45000);

async function run() {
  await app.whenReady();
  const win = new BrowserWindow({ show: false, width: 1080, height: 760, frame: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, backgroundThrottling: false } });
  // 使用正式入口的页面、字体和完整样式链，避免手选 CSS 误用旧 General 主题。
  // 仅移除业务脚本；测试只执行真实弹窗工厂，并继续使用隔离的 mock API。
  const previewHtml = fs.readFileSync(path.join(project, 'index.html'), 'utf8')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
    .replace('<head>', `<head><base href="${pathToFileURL(project + path.sep).href}">`);
  const previewPath = path.join(root, 'index-preview.html');
  fs.writeFileSync(previewPath, previewHtml);
  await win.loadFile(previewPath);
  await win.webContents.executeJavaScript(`document.body.dataset.platform = ${JSON.stringify(process.platform)}`);
  await win.webContents.executeJavaScript(fs.readFileSync(path.join(project, 'src/renderer-dialogs.js'), 'utf8'));
  const result = await win.webContents.executeJavaScript(`(async () => {
    const check = (value, message) => { if (!value) throw new Error(message); };
    const root = document.getElementById('modalRoot');
    const requests = [];
    const deps = { state: {}, elements: { modalRoot: root }, appConstants: {}, desktopApi: {
      toolbox: {
        splitRead: async () => ({ status: 'success', sourceFilePath: '/fixture.csv', splitReadToken: 'import-token',
          dataRowCount: 5, maxRowSplitFiles: 1000, headers: ['字段A', '空列'], valuesByField: { 字段A: ['甲', '乙'], 空列: [] } }),
        splitExport: async (payload) => { requests.push(payload); return { status: 'success', mode: 'rows',
          fileCount: 3, outputDataRowCount: 5, files: [{ fileName: 'part1.xlsx', filePath: '/part1.xlsx', dataRowCount: 2 }] }; }
      }
    } };
    const dialogs = window.__rendererDialogs.createRendererDialogs(deps);
    const open = (extra = {}) => {
      const modal = dialogs.createSplitFieldPickerDialog({ headers: ['字段A', '空列'],
        valuesByField: { 字段A: ['甲', '乙'], 空列: [] }, splitReadToken: 'import-token',
        dataRowCount: 5, maxRowSplitFiles: 1000, ...extra });
      root.replaceChildren(modal); return modal;
    };
    const q = (selector) => root.querySelector(selector);
    const rowToggle = () => q('[data-field="split-by-rows"]');
    const rowInput = () => q('[data-field="rows-per-file"]');
    const done = () => q('[data-action="complete"]');
    const input = (value) => { rowInput().value = value; rowInput().dispatchEvent(new Event('input', { bubbles: true })); };
    let completed = [];
    open({ onComplete: (request) => completed.push(request) });
    check(!rowToggle().checked && rowInput().value === '', '初始状态');
    check(getComputedStyle(q('.toolbox-split-row-count-wrap')).display === 'none', '未勾选输入占位');
    q('.toolbox-split-values-dropdown-btn').click();
    q('.toolbox-split-values-floating-panel input').click();
    check(!done().disabled, '原字段模式选择失败');
    rowToggle().click();
    check(document.activeElement === rowInput(), '勾选后未聚焦行数输入框');
    check(q('.toolbox-split-values-floating-panel').hidden, '切换后浮层未关闭');
    check(q('.toolbox-split-picker-field').disabled && q('.toolbox-split-values-dropdown-btn').disabled, '字段和值没有禁用');
    check(q('[data-field="multiple-files-enabled"]').disabled, '旧多文件入口没有禁用');
    check(done().disabled && !rowInput().disabled, '空行数错误启用完成');
    const invalidInputs = ['', '   ', '0', '00', '-1', '1.5', '1e3', '+1', '1,000', 'NaN', 'Infinity', '9007199254740992', '9'.repeat(400)];
    for (const value of invalidInputs) {
      input(value); check(done().disabled, '错误接受非法行数 ' + value);
      check(!root.textContent.includes('预计生成'), '非法输入仍显示预估提示');
      const expected = !value.trim() ? '请输入每份文件的数据行数'
        : (value === '9007199254740992' || value.length === 400) ? '行数过大，请输入有效范围内的整数' : '请输入大于 0 的整数';
      check(q('.toolbox-split-picker-hint').textContent === expected, '行数错误文案不符合 Spec：' + value);
    }
    input('00010'); rowInput().dispatchEvent(new Event('blur'));
    check(rowInput().value === '10' && !done().disabled, '00010 未规范化');
    input(' 0002 ');
    rowInput().dispatchEvent(new Event('blur'));
    check(rowInput().value === '2' && !done().disabled, '合法输入未规范化');
    check(!root.textContent.includes('预计生成'), '合法输入仍显示预估提示');
    rowToggle().click();
    check(!done().disabled && q('.toolbox-split-values-dropdown-btn').textContent === '甲', '字段草稿丢失');
    rowToggle().click(); check(rowInput().value === '2', '行数草稿丢失');
    done().click(); done().click();
    check(completed.length === 1 && JSON.stringify(completed[0]) === '{"mode":"rows","rowsPerFile":2}', 'rows 提交或防重复失败');
    for (const dataRowCount of [undefined, 0, 1001]) {
      open({ dataRowCount }); rowToggle().click(); input('1');
      check(done().disabled, '无有效计数或超限仍可提交');
    }
    open(); const field = q('.toolbox-split-picker-field'); field.value = '1'; field.dispatchEvent(new Event('change'));
    rowToggle().click(); input('2'); check(!done().disabled, 'rows 错误依赖旧字段可选值');
    rowToggle().click(); check(q('.toolbox-split-values-dropdown-btn').disabled && done().disabled, '退出 rows 错误启用空字段');
    open(); check(!rowToggle().checked && rowInput().value === '', '跨弹窗草稿未重置');
    root.replaceChildren(dialogs.createToolboxDialog());
    q('[data-action="split-import"]').click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    rowToggle().click(); input('2'); done().click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    check(requests.length === 1 && requests[0].rowsPerFile === 2 && requests[0].mode === 'rows'
      && !('field' in requests[0]) && !('values' in requests[0]), '父级发出错误请求');
    check(root.textContent.includes('3 个文件、5 行') && root.textContent.includes('/part1.xlsx'), '结果展示错误');
    window.__rowsReviewUi = { open, q, rowToggle, rowInput, input, check,
      async showResult(count) {
        const files = Array.from({ length: count }, (_, i) => {
          const fileName = '流水明细_按行拆分_' + String(i + 1).padStart(4, '0') + '.xlsx';
          return { fileName, filePath: '/Users/test/Downloads/' + '很长的目录名称用于核对换行/'.repeat(4) + fileName, dataRowCount: 1 };
        });
        deps.desktopApi.toolbox.splitRead = async () => ({ status: 'success', sourceFilePath: '/fixture.csv',
          splitReadToken: 't', dataRowCount: count, maxRowSplitFiles: 1000,
          headers: ['字段A'], valuesByField: { 字段A: ['甲'] } });
        deps.desktopApi.toolbox.splitExport = async () => ({ status: 'success', mode: 'rows', fileCount: count,
          outputDataRowCount: count, files, warningSummary: { warningCount: 1,
            warningSamples: [{ sourceFileName: '日期.csv', sourceSheet: 'Sheet1', cellRef: 'A2', message: '保留原文本' }] },
          warnings: ['末尾发布提示已完整保留'] });
        root.replaceChildren(dialogs.createToolboxDialog());
        q('[data-action="split-import"]').click();
        await new Promise((resolve) => setTimeout(resolve, 20));
        rowToggle().click(); input('1'); done().click();
        await new Promise((resolve) => setTimeout(resolve, 20));
        const text = q('.alert-message').textContent;
        check(files.every((file) => text.includes(file.filePath)), '文件列表被截断');
        check(text.includes('日期.csv / Sheet1 / A2') && text.includes('末尾发布提示已完整保留'), '警告被截断');
      },
      geometry() {
        const card = q('.alert-card'), body = q('.alert-body'), button = q('.alert-card button');
        const c = card.getBoundingClientRect(), b = body.getBoundingClientRect(), r = button.getBoundingClientRect();
        const x = Math.round(r.x + r.width / 2), y = Math.round(r.y + r.height / 2);
        const tail = document.createRange(); tail.selectNodeContents(q('.alert-message').lastChild);
        return { x, y, footerVisible: r.top >= c.top && r.bottom <= c.bottom && r.bottom <= innerHeight,
          hitConfirm: document.elementFromPoint(x, y) === button,
          canScroll: body.scrollHeight > body.clientHeight && getComputedStyle(body).overflowY === 'auto',
          tailVisible: tail.getBoundingClientRect().top >= b.top && tail.getBoundingClientRect().bottom <= b.bottom,
          clientHeight: body.clientHeight, scrollHeight: body.scrollHeight };
      }
    };
    open(); rowToggle().click(); input('2');
    await document.fonts.ready;
    await new Promise((resolve) => setTimeout(resolve, 250));
    const stylesheets = [...document.querySelectorAll('link[rel="stylesheet"]')];
    check(document.body.dataset.style === 'clear' && stylesheets.every((link) => !!link.sheet)
      && document.getElementById('cssClear').href.endsWith('/src/styles-gemini.css')
      && !stylesheets.some((link) => link.href.endsWith('/src/styles.css')), '未加载正式 Clear 主题');
    const primary = getComputedStyle(done());
    const referencePrimary = getComputedStyle(document.getElementById('importFileBtn'));
    const secondary = getComputedStyle(q('[data-action="cancel"]'));
    const referenceSecondary = getComputedStyle(document.getElementById('manageTemplateBtn'));
    check(primary.backgroundColor === referencePrimary.backgroundColor && primary.color === referencePrimary.color,
      '完成按钮颜色与正式主按钮不一致');
    check(primary.borderRadius === referencePrimary.borderRadius
      && getComputedStyle(q('.modal-card')).borderRadius === getComputedStyle(document.documentElement).getPropertyValue('--radius-lg').trim(),
      '按钮或弹窗圆角与正式主题不一致');
    check(secondary.backgroundColor === referenceSecondary.backgroundColor && secondary.color === referenceSecondary.color
      && secondary.borderColor === referenceSecondary.borderColor, '取消按钮与正式次级按钮不一致');
    return { status: 'passed', scenarios: 21, invalidInputCopyChecks: invalidInputs.length, themeChecks: 4,
      theme: { name: document.body.dataset.style, primaryButton: primary.backgroundColor,
        secondaryButton: secondary.backgroundColor, buttonRadius: primary.borderRadius,
        cardRadius: getComputedStyle(q('.modal-card')).borderRadius,
        stylesheets: stylesheets.map((link) => link.getAttribute('href')) },
      dimensions: { width: innerWidth, height: innerHeight } };
  })()`);
  const js = (code) => win.webContents.executeJavaScript(code);
  const pause = () => new Promise((resolve) => setTimeout(resolve, 40));
  const mouse = async (point) => {
    for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, x: point.x, y: point.y, button: 'left', clickCount: 1 });
    await pause();
  };
  await js('window.__rowsReviewUi.open()');
  const togglePoint = await js(`(() => { const r = window.__rowsReviewUi.rowToggle().getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
  await mouse(togglePoint);
  await js(`(() => { const h = window.__rowsReviewUi; h.check(h.rowToggle().checked && document.activeElement === h.rowInput(), '鼠标勾选未聚焦'); })()`);
  await mouse(togglePoint);
  await js(`(() => { const h = window.__rowsReviewUi; h.check(!h.rowToggle().checked && document.activeElement !== h.rowInput(), '取消勾选聚焦了隐藏输入框'); h.rowToggle().focus(); })()`);
  for (const type of ['keyDown', 'keyUp']) win.webContents.sendInputEvent({ type, keyCode: 'Space' });
  await pause();
  win.webContents.sendInputEvent({ type: 'char', keyCode: '2' });
  await pause();
  await js(`(() => { const h = window.__rowsReviewUi; h.check(h.rowToggle().checked && document.activeElement === h.rowInput() && h.rowInput().value === '2', '键盘勾选后不能立即输入'); })()`);
  result.nativeFocusChecks = 3;
  result.resultLayouts = [];
  for (const count of [1, 8, 9, 30, 1000]) {
    await js('window.__rowsReviewUi.showResult(' + count + ')');
    const top = await js('window.__rowsReviewUi.geometry()');
    if (!top.footerVisible || !top.hitConfirm) throw new Error(count + ' 份结果确认按钮被裁切');
    let nativeWheelScrolled = null;
    if (count > 1) {
      const pointer = await js(`(() => { const r = window.__rowsReviewUi.q('.alert-body').getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
      win.webContents.sendInputEvent({ type: 'mouseMove', ...pointer });
      await new Promise((resolve) => setTimeout(resolve, 700));
      win.webContents.sendInputEvent({ type: 'mouseWheel', ...pointer, deltaY: -450, canScroll: true });
      await new Promise((resolve) => setTimeout(resolve, 180));
      nativeWheelScrolled = await js(`window.__rowsReviewUi.q('.alert-body').scrollTop > 0`);
      if (!nativeWheelScrolled) { console.error(JSON.stringify({ count, pointer, geometry: await js('window.__rowsReviewUi.geometry()'), scrollTop: await js("window.__rowsReviewUi.q('.alert-body').scrollTop") })); throw new Error(count + ' 份结果未响应原生鼠标滚轮'); }
    }
    await js(`(() => { const body = window.__rowsReviewUi.q('.alert-body'); body.scrollTop = body.scrollHeight; })()`);
    await pause();
    const bottom = await js('window.__rowsReviewUi.geometry()');
    if (!bottom.tailVisible || !bottom.footerVisible || !bottom.hitConfirm) throw new Error(count + ' 份末尾提示或确认按钮不可见');
    if (count > 1 && !bottom.canScroll) throw new Error(count + ' 份长路径结果不可滚动');
    if (count === 1000 && process.argv[2]) {
      const resultCapture = path.resolve(process.argv[2]).replace(/\.png$/, '-result-1000.png');
      fs.writeFileSync(resultCapture, (await win.webContents.capturePage()).toPNG());
    }
    await mouse(bottom);
    await js(`window.__rowsReviewUi.check(!!window.__rowsReviewUi.q('[data-action="split-import"]') && !window.__rowsReviewUi.q('.alert-card'), '点击确认未返回工具箱')`);
    result.resultLayouts.push({ count, ...bottom, nativeWheelScrolled, returnedToToolbox: true });
  }
  await js(`(() => { const h = window.__rowsReviewUi; h.open(); h.rowToggle().click(); h.input('2'); })()`);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const capturePath = process.argv[2];
  if (capturePath) fs.writeFileSync(path.resolve(capturePath), (await win.webContents.capturePage()).toPNG());
  console.log(JSON.stringify(result));
  win.destroy();
}

run().then(() => { clearTimeout(watchdog); app.quit(); }).catch((error) => { console.error(error); app.exit(1); });
app.on('will-quit', () => fs.rmSync(root, { recursive: true, force: true }));
