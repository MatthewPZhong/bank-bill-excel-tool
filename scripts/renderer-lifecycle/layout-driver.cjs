'use strict';

// 隔离生命周期测试的可选真实样式／输入能力，不加载应用 Main 或业务数据。
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { screen } = require('electron');

module.exports = function createLayoutDriver({ root, temporary, getWindow }) {
  const js = source => getWindow().webContents.executeJavaScript(source, true);
  const settle = () => js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const prepare = async (html, options) => {
    const win = getWindow();
    const productionMinimum = options.productionMinimum !== false;
    win.setMinimumSize(productionMinimum ? 1080 : 0, productionMinimum ? 760 : 0);
    win.setSize(options.width || 1080, options.height || 760);
    const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
    const styles = [...index.matchAll(/<link\b[^>]*href="([^"]+\.css)"[^>]*>/g)].map(match => match[1]);
    if (styles.length < 5) throw new Error('未读取到 index.html 的完整生产样式顺序');
    const links = styles.map(file => `<link rel="stylesheet" href="${pathToFileURL(path.resolve(root, file)).href}">`).join('\n');
    const page = path.join(temporary, 'layout-fixture.html');
    fs.writeFileSync(page, `<!doctype html><html><head><meta charset="utf-8">${links}</head><body>${html}</body></html>`);
    await win.loadFile(page);
    win.webContents.setZoomFactor(options.zoom || 1);
    await js(`document.documentElement.dataset.theme = ${JSON.stringify(options.theme || 'light')}; document.fonts.ready.then(() => void 0)`);
    const loaded = await js('[...document.querySelectorAll("link[rel=stylesheet]")].map(link => ({ href: link.href, loaded: !!link.sheet, rules: link.sheet?.cssRules.length || 0 }))');
    if (loaded.some(link => !link.loaded || !link.rules)) throw new Error(`生产样式加载失败：${JSON.stringify(loaded)}`);
    win.show();
    win.focus();
    win.webContents.focus();
    await settle();
  };
  const point = async selector => {
    const win = getWindow();
    const result = await js(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element) throw new Error('输入目标不存在');
      const rect = element.getBoundingClientRect();
      const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
      return { x, y, hit: element.contains(document.elementFromPoint(x, y)) };
    })()`);
    if (!result.hit) throw new Error(`输入目标被遮挡：${selector}`);
    const zoom = win.webContents.getZoomFactor();
    return { x: Math.round(result.x * zoom), y: Math.round(result.y * zoom) };
  };
  const click = async selector => {
    const win = getWindow();
    win.focus();
    win.webContents.focus();
    const position = await point(selector);
    win.webContents.sendInputEvent({ type: 'mouseMove', ...position });
    win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...position });
    win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...position });
    await settle();
  };
  const key = async (keyCode, modifiers = []) => {
    const win = getWindow();
    const contents = win.webContents;
    win.focus();
    contents.focus();
    contents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    // 可打印空格需要 char 事件，才能触发 keypress 及浏览器的原生滚动。
    const character = keyCode === 'Enter' ? '\r' : keyCode === 'Space' ? ' ' : null;
    if (character !== null) contents.sendInputEvent({ type: 'char', keyCode: character, modifiers });
    contents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    await settle();
  };
  const wheel = async (selector, deltaY = -450) => {
    const contents = getWindow().webContents;
    const position = await point(selector);
    contents.sendInputEvent({ type: 'mouseMove', ...position });
    contents.sendInputEvent({ type: 'mouseWheel', ...position, deltaX: 0, deltaY });
    await settle();
  };
  const resize = async (width, height, zoom = 1) => {
    getWindow().setSize(width, height);
    getWindow().webContents.setZoomFactor(zoom);
    await settle();
  };
  const inspect = async () => {
    const win = getWindow();
    return { platform: process.platform, versions: { electron: process.versions.electron, chrome: process.versions.chrome },
      displayScaleFactor: screen.getDisplayMatching(win.getBounds()).scaleFactor,
      minimumSize: win.getMinimumSize(), frame: false, windowBounds: win.getBounds(), contentBounds: win.getContentBounds(),
      zoom: win.webContents.getZoomFactor(),
      page: await js('({ width: innerWidth, height: innerHeight, devicePixelRatio, theme: document.documentElement.dataset.theme })') };
  };
  const evidence = async (name, details) => {
    const directory = process.env.RENDERER_LIFECYCLE_EVIDENCE_DIR;
    if (!directory) return;
    if (!/^[a-z0-9-]+$/.test(name)) throw new Error('证据名称非法');
    fs.mkdirSync(directory, { recursive: true });
    const screenshot = await getWindow().webContents.capturePage();
    fs.writeFileSync(path.join(directory, `${name}.png`), screenshot.toPNG());
    fs.writeFileSync(path.join(directory, `${name}.json`), JSON.stringify({ environment: await inspect(), screenshotPixels: screenshot.getSize(), ...details }, null, 2) + '\n');
  };
  return { prepare, click, key, wheel, resize, inspect, evidence, settle };
};
