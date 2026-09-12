'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');
const source = fs.readFileSync(path.resolve(__dirname, '../../../src/renderer-biz-op-v327.js'), 'utf8');

// 默认单测无需图形环境；同一组交互场景另由隔离 Electron 脚本验证真实 DOM 行为。
function createDocument() {
  const doc = { activeElement: null, createElement: (tag) => new Element(tag) };
  class Element extends EventTarget {
    constructor(tag) {
      super(); this.tagName = tag.toUpperCase(); this.nodeType = 1; this.children = []; this.parentNode = null;
      this.dataset = {}; this.attributes = {}; this.disabled = false; this.hidden = false; this.open = false; this.className = '';
      this.classList = {
        contains: (name) => this.className.split(/\s+/).includes(name),
        add: (...names) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...names])].join(' '); },
        remove: (...names) => { this.className = this.className.split(/\s+/).filter((name) => !names.includes(name)).join(' '); },
        toggle: (name, force) => { if (force ?? !this.classList.contains(name)) this.classList.add(name); else this.classList.remove(name); }
      };
    }
    set textContent(value) { this.replaceChildren(); this.text = String(value); }
    get textContent() { return (this.text || '') + this.children.map((child) => child.textContent).join(''); }
    set innerHTML(_value) { throw new Error('本控制器应使用 textContent 创建用户文本'); }
    set value(value) { this.selectedValue = String(value); }
    get value() { return this.selectedValue ?? (this.tagName === 'SELECT' ? this.children[0]?.value || '' : ''); }
    get firstChild() { return this.children[0] || null; }
    get isConnected() { return this === doc.body || Boolean(this.parentNode?.isConnected); }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    getAttribute(name) { return this.attributes[name] ?? (name.startsWith('data-') ? this.dataset[name.slice(5)] : this[name]) ?? null; }
    append(...items) { for (const item of items) { item.remove(); item.parentNode = this; this.children.push(item); } }
    remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((item) => item !== this); this.parentNode = null; }
    replaceChildren(...items) { this.children.forEach((item) => { item.parentNode = null; }); this.children = []; this.text = ''; delete this.selectedValue; this.append(...items); }
    matches(selector) {
      const excluded = [...selector.matchAll(/:not\(([^)]+)\)/g)];
      if (excluded.some((match) => this.matches(match[1]))) return false;
      selector = selector.replace(/:not\([^)]+\)/g, '');
      if (selector.includes(':disabled') && !this.disabled) return false;
      selector = selector.replaceAll(':disabled', '');
      const tag = selector.match(/^[a-z]+/i)?.[0]; if (tag && this.tagName !== tag.toUpperCase()) return false;
      for (const match of selector.matchAll(/\.([\w-]+)/g)) if (!this.classList.contains(match[1])) return false;
      for (const match of selector.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)) {
        const actual = this.getAttribute(match[1]);
        if (match[2] === undefined ? !actual : String(actual) !== match[2]) return false;
      }
      return true;
    }
    querySelectorAll(selector) {
      const selectors = selector.split(',').map((value) => value.trim()); const result = [];
      const visit = (parent) => { for (const child of parent.children) { if (selectors.some((value) => child.matches(value))) result.push(child); visit(child); } };
      visit(this); return result;
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    click() { if (!this.disabled) this.dispatchEvent(new Event('click')); }
    focus() { if (!this.disabled && this.isConnected) doc.activeElement = this; }
    showModal() { this.open = true; this.querySelector('button:not(:disabled)')?.focus(); }
    close() { this.open = false; this.dispatchEvent(new Event('close')); }
  }
  doc.body = new Element('body'); doc.activeElement = doc.body;
  doc.querySelectorAll = (selector) => doc.body.querySelectorAll(selector);
  doc.querySelector = (selector) => doc.body.querySelector(selector);
  return doc;
}

function createHarness(window) {
  const doc = window.document;
  const calls = []; const api = {};
  const defaults = {
    status: { mode: 'ACTIVE', recoveryReady: true },
    pickFiles: { status: 'ok', selectionRef: 'picked-input' },
    importFiles: { status: 'ok', summary: { scannedDataRows: 2, acceptedRows: 2 } },
    months: { status: 'ok', months: ['2026-09'] },
    preflight: { status: 'ok', selectionRef: 'run-input', inputs: [] },
    run: { status: 'ok' },
    runCalendar: { status: 'ok', month: '2026-09', dates: ['2026-09-11'], previousMonth: null, nextMonth: null },
    list: { status: 'ok', generation: 1, nextCursor: null, rows: [{ objectId: 'run-1', startDate: '2026-09-01', endDate: '2026-09-11', tableName: '核对结果', version: 1, updatedAt: '2026-09-11T12:00:00Z' }] },
    pickExport: { status: 'ok', selectionRef: 'output-1' },
    exportWorkbook: { status: 'ok' },
    currentInput: { status: 'ok', objectId: 'input-1' },
    deletePreview: { status: 'ok', previewId: 'delete-1', datasets: [], runs: [], selection: { runIds: ['run-1'] }, references: { protectedAfterKeep: 1, protectedAfterDelete: 0, userLockedOriginals: 0, sharedBlobOriginals: 0 } },
    deleteData: { status: 'ok' },
    cancel: { status: 'ok' }
  };
  const reply = { ...defaults };
  for (const name of Object.keys(defaults)) api[name] = async (...args) => { calls.push({ name, args }); return typeof reply[name] === 'function' ? reply[name](...args) : reply[name]; };
  const panel = doc.createElement('section'); panel.id = 'bizOpV327ModulePanel'; panel.className = 'control-board module-panel';
  const legacyPanel = doc.createElement('section'); doc.body.append(panel, legacyPanel);
  const controller = window.createBizOpV327Controller({ api, panel, legacyPanel, document: doc, restoreLegacy: () => calls.push({ name: 'restoreLegacy' }) });
  const find = (text, scope = doc) => [...scope.querySelectorAll('button')].find((item) => item.textContent === text);
  const flush = async () => {
    for (let i = 0; i < 30; i += 1) await Promise.resolve();
    // Chromium 的 close 事件排在渲染任务中；等待真实事件，避免把固定延时当作关闭完成。
    await Promise.all([...doc.querySelectorAll('dialog')].filter((dialog) => !dialog.open && dialog.isConnected)
      .map((dialog) => new Promise((resolve) => dialog.addEventListener('close', resolve, { once: true }))));
  };
  const click = async (text, scope = doc) => { const item = find(text, scope); if (!item) throw new Error(`未找到按钮：${text}`); item.click(); await flush(); return item; };
  const count = (name) => calls.filter((call) => call.name === name).length;
  const deferred = () => { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
  return { window, doc, panel, legacyPanel, controller, calls, reply, find, click, flush, count, deferred,
    status: () => panel.querySelector('.bizop-status'), text: () => panel.querySelector('.status-box-text').textContent,
    close: () => { for (const dialog of [...doc.querySelectorAll('dialog')]) { dialog.close(); dialog.remove(); } panel.remove(); legacyPanel.remove(); } };
}

function rendererCases(test, assert, environment) {
  function noTaskButtons(h) {
    assert.equal([...h.doc.querySelectorAll('button')].some((item) => /导出错误报告|取消当前操作|取消操作|取消导入/.test(item.textContent)), false);
    assert.equal(h.doc.querySelectorAll('.bizop-cancel-slot').length, 0);
    assert.equal(h.count('cancel'), 0);
  }
  async function setup() { const h = await environment(); await h.controller.setSelected(true); return h; }
  test('初始和重新进入 ACTIVE 页面无手动报告或任务取消节点，保留模式路由', async () => {
    const h = await setup();
    try {
      noTaskButtons(h); assert.equal(h.panel.querySelector('.bizop-secondary').hidden, true);
      assert.equal(h.legacyPanel.hidden, true); assert.equal(h.panel.hidden, false);
      await h.controller.setSelected(false); await h.controller.setSelected(true); noTaskButtons(h);
      h.reply.status = { mode: 'DISABLED', recoveryReady: false }; await h.controller.setSelected(true);
      assert.equal(h.legacyPanel.hidden, false); assert.equal(h.panel.hidden, true); assert.equal(h.count('restoreLegacy'), 1);
    } finally { h.close(); }
  });
  test('导入保持原位、busy 防重复与焦点恢复，失败及长报告路径一起显示并跨刷新保留', async () => {
    const h = await setup();
    try {
      const pending = h.deferred(); h.reply.importFiles = () => pending.promise;
      const button = h.find('导入文件'); const parent = button.parentNode; const initial = [...parent.children]; button.focus();
      button.click(); button.click(); await h.flush(); noTaskButtons(h);
      assert.equal(h.controller.busy, true); assert.equal(button.hidden, false); assert.equal(button.disabled, true);
      assert.equal(button.parentNode, parent); assert.deepEqual([...parent.children], initial); assert.equal(h.count('importFiles'), 1);
      assert.equal(h.panel.getAttribute('aria-busy'), 'true'); assert.equal(h.doc.activeElement, h.status());
      button.dispatchEvent(new h.window.Event('click')); await h.flush(); assert.equal(h.count('pickFiles'), 1);
      const relativePath = `error-reports/2026-09-11/${'异常文件'.repeat(35)}<img onerror=evil>.xlsx`;
      pending.resolve({ status: 'error', code: 'BIZOP_IMPORT_REJECTED', message: '本次导入未通过校验', summary: { scannedDataRows: 10, acceptedRows: 9 }, reportRef: 'legacy-ref', errorReport: { status: 'saved', relativePath } }); await h.flush();
      assert.equal(h.controller.busy, false); assert.equal(button.disabled, false); assert.equal(h.doc.activeElement, button);
      assert.equal(h.status().dataset.tone, 'error'); assert.ok(h.text().includes('本次导入未通过校验')); assert.ok(h.text().includes('扫描 10 行，接受 9 行'));
      assert.ok(h.text().includes(`错误报告已保存：${relativePath}`)); assert.equal(h.doc.querySelectorAll('img').length, 0); assert.equal(h.text().includes('导入文件完成'), false);
      await h.controller.setSelected(false); await h.controller.setSelected(true); assert.ok(h.text().includes(relativePath)); noTaskButtons(h);
      const oldRequestId = h.calls.find((call) => call.name === 'importFiles').args[0].requestId;
      const next = h.deferred(); h.reply.pickFiles = () => next.promise; button.click(); await h.flush();
      assert.equal(h.text().includes(relativePath), false); next.resolve({ status: 'cancelled' }); await h.flush();
      assert.equal(h.text(), '操作已取消'); assert.equal(h.count('importFiles'), 1); assert.ok(oldRequestId.startsWith('ui-'));
      h.reply.pickFiles = { status: 'ok', selectionRef: 'new-input' }; h.reply.importFiles = { status: 'ok' };
      await h.click('导入文件'); const requests = h.calls.filter((call) => call.name === 'importFiles');
      assert.notEqual(requests[1].args[0].requestId, oldRequestId);
    } finally { h.close(); }
  });
  test('报告 failed、pending、unavailable、归档未决不改变原业务失败且不展示未确认路径', async () => {
    const h = await setup();
    try {
      for (const [status, expected] of [['failed', '错误报告保存失败'], ['pending', '错误报告发布状态待核验'], ['unavailable', '本次无可用的结构化错误报告'], ['saved', '文件已保存，归档仍待完成']]) {
        h.reply.importFiles = { status: 'error', message: '原始校验失败', errorReport: { status, message: '附加报告状态', relativePath: 'error-reports/2026-09-11/report.xlsx', pendingArchiveHandoff: true } };
        await h.click('导入文件'); assert.equal(h.status().dataset.tone, 'error'); assert.ok(h.text().includes('原始校验失败')); assert.ok(h.text().includes(expected));
        assert.equal(h.text().includes('error-reports/'), status === 'saved'); noTaskButtons(h);
      }
    } finally { h.close(); }
  });
  test('状态读取失败与导入连接错误同时展示，异常退出仍清 busy 并锁定未就绪入口', async () => {
    const h = await setup();
    try {
      h.reply.importFiles = () => { h.reply.status = () => { throw new Error('状态读取失败'); }; throw new Error('导入连接失败'); };
      await h.click('导入文件'); assert.equal(h.controller.busy, false);
      assert.ok(h.text().includes('导入连接失败')); assert.ok(h.text().includes('状态读取失败'));
      assert.equal(h.find('导入文件').disabled, true); assert.equal(h.status().dataset.tone, 'error'); noTaskButtons(h);
    } finally { h.close(); }
  });
  test('成功任务后状态读取失败可见且不重复累积，状态恢复及新任务清除过期故障', async () => {
    const h = await setup();
    try {
      await h.click('导入文件'); const taskText = h.text();
      assert.ok(taskText.includes('导入文件完成')); assert.ok(taskText.includes('扫描 2 行，接受 2 行'));
      assert.equal(h.status().dataset.tone, 'success');
      const stateError = '模块状态接口暂不可用'; h.reply.status = () => { throw new Error(stateError); };
      await h.controller.setSelected(false); await h.controller.setSelected(true);
      assert.ok(h.text().includes(taskText)); assert.ok(h.text().includes(stateError));
      assert.equal(h.status().dataset.tone, 'error');
      for (const text of ['导入文件', '开始运行', '导出校验结果表', '数据管理']) assert.equal(h.find(text).disabled, true);
      const combinedText = h.text();
      for (let i = 0; i < 2; i += 1) {
        await h.controller.setSelected(false); await h.controller.setSelected(true);
        assert.equal(h.text(), combinedText);
      }
      h.reply.status = { mode: 'ACTIVE', recoveryReady: true };
      await h.controller.setSelected(false); await h.controller.setSelected(true);
      assert.equal(h.text(), taskText); assert.equal(h.status().dataset.tone, 'success');
      for (const text of ['导入文件', '开始运行', '导出校验结果表', '数据管理']) assert.equal(h.find(text).disabled, false);
      const pending = h.deferred(); h.reply.importFiles = () => pending.promise;
      await h.click('导入文件'); assert.equal(h.controller.busy, true); assert.equal(h.text().includes(stateError), false);
      pending.resolve({ status: 'ok', summary: { scannedDataRows: 3, acceptedRows: 3 } }); await h.flush();
      assert.ok(h.text().includes('扫描 3 行，接受 3 行')); assert.equal(h.text().includes(stateError), false);
      assert.equal(h.status().dataset.tone, 'success'); noTaskButtons(h);
    } finally { h.close(); }
  });
  test('失败任务与已保存报告叠加状态读取故障，恢复状态后保留原业务错误和报告', async () => {
    const h = await setup();
    try {
      const stateError = '模块状态读取连接中断'; const relativePath = 'error-reports/2026-09-11/本次导入错误报告.xlsx';
      h.reply.importFiles = () => {
        h.reply.status = () => { throw new Error(stateError); };
        return { status: 'error', code: 'BIZOP_IMPORT_REJECTED', message: '本次导入未通过校验',
          summary: { scannedDataRows: 10, acceptedRows: 9 }, errorReport: { status: 'saved', relativePath } };
      };
      await h.click('导入文件'); assert.equal(h.controller.busy, false);
      assert.ok(h.text().includes('本次导入未通过校验')); assert.ok(h.text().includes('BIZOP_IMPORT_REJECTED'));
      assert.ok(h.text().includes('扫描 10 行，接受 9 行')); assert.ok(h.text().includes(relativePath));
      assert.ok(h.text().includes(stateError)); assert.equal(h.status().dataset.tone, 'error');
      for (const text of ['导入文件', '开始运行', '导出校验结果表', '数据管理']) assert.equal(h.find(text).disabled, true);
      const combinedText = h.text();
      await h.controller.setSelected(false); await h.controller.setSelected(true); assert.equal(h.text(), combinedText);
      h.reply.status = { mode: 'ACTIVE', recoveryReady: true };
      await h.controller.setSelected(false); await h.controller.setSelected(true);
      assert.ok(h.text().includes('本次导入未通过校验')); assert.ok(h.text().includes('BIZOP_IMPORT_REJECTED'));
      assert.ok(h.text().includes('扫描 10 行，接受 9 行')); assert.ok(h.text().includes(relativePath));
      assert.equal(h.text().includes(stateError), false); assert.equal(h.status().dataset.tone, 'error');
      for (const text of ['导入文件', '开始运行', '导出校验结果表', '数据管理']) assert.equal(h.find(text).disabled, false);
      noTaskButtons(h);
    } finally { h.close(); }
  });
  test('运行保留原 disabled、忙碌时阻止关闭弹窗，后端 cancelled 正常恢复且不提供中止入口', async () => {
    const h = await setup();
    try {
      await h.click('开始运行'); const dialog = h.doc.querySelector('.bizop-run-dialog'); const run = h.find('确认运行', dialog);
      assert.equal(run.disabled, true); await h.click('检查所需数据', dialog); assert.equal(run.disabled, false);
      const pending = h.deferred(); h.reply.run = () => pending.promise; run.focus(); await h.click('确认运行', dialog); noTaskButtons(h);
      assert.equal(h.controller.busy, true); assert.equal(dialog.getAttribute('aria-busy'), 'true'); assert.equal(h.doc.activeElement, dialog.feedback);
      const cancel = new h.window.Event('cancel', { cancelable: true }); assert.equal(dialog.dispatchEvent(cancel), false); assert.equal(dialog.open, true);
      assert.ok([...dialog.querySelectorAll('button,input,select')].every((item) => item.disabled));
      pending.resolve({ status: 'cancelled' }); await h.flush();
      assert.equal(h.controller.busy, false); assert.equal(h.text(), '操作已取消'); assert.equal(h.status().dataset.tone, 'info'); assert.equal(run.disabled, true);
      assert.equal(h.find('检查所需数据', dialog).disabled, false); assert.equal(h.doc.activeElement, h.find('检查所需数据', dialog)); assert.equal(h.find('关闭', dialog).disabled, false);
      assert.equal(dialog.dispatchEvent(new h.window.Event('cancel', { cancelable: true })), true);
      await h.click('关闭', dialog); await h.flush(); assert.equal(dialog.isConnected, false);
    } finally { h.close(); }
  });
  test('文件选择、日期选择与普通另存为取消不提交后端任务，导出 busy 期间无任务取消入口', async () => {
    const h = await setup();
    try {
      h.reply.pickFiles = { status: 'cancelled' }; await h.click('导入文件'); assert.equal(h.count('importFiles'), 0);
      await h.click('开始运行'); const run = h.doc.querySelector('.bizop-run-dialog'); const start = run.querySelector('input'); start.click(); await h.flush();
      const calendar = h.doc.querySelector('.bizop-calendar-dialog'); await h.click('取消', calendar); await h.flush();
      assert.equal(start.value, ''); assert.equal(h.count('run'), 0); await h.click('关闭', run); await h.flush();
      await h.controller.openResults(); const dialog = h.doc.querySelector('.bizop-results-dialog'); dialog.querySelector('select').value = 'run-1';
      h.reply.pickExport = { status: 'cancelled' }; await h.click('导出', dialog); assert.equal(h.count('exportWorkbook'), 0); assert.equal(dialog.open, true);
      const pending = h.deferred(); h.reply.pickExport = { status: 'ok', selectionRef: 'output-2' }; h.reply.exportWorkbook = () => pending.promise;
      await h.click('导出', dialog); assert.equal(h.controller.busy, true); noTaskButtons(h);
      pending.resolve({ status: 'cancelled' }); await h.flush(); assert.equal(h.controller.busy, false); assert.equal(h.find('导出', dialog).disabled, false);
      assert.equal(h.calls.find((call) => call.name === 'exportWorkbook').args[0], 'RESULT_DIFF');
    } finally { h.close(); }
  });
  test('取消选取、删除确认取消仍有效，删除执行时普通取消禁用并保留关闭保护', async () => {
    const h = await setup();
    try {
      await h.controller.openManager(); const manager = h.doc.querySelector('.bizop-manager-dialog');
      await h.click('删除', manager); assert.equal(manager.querySelectorAll('input[type="checkbox"]').length, 1);
      await h.click('取消选取', manager); assert.equal(manager.querySelectorAll('input[type="checkbox"]').length, 0); assert.equal(h.count('deletePreview'), 0);
      await h.click('删除', manager); const checkbox = manager.querySelector('input[type="checkbox"]'); checkbox.checked = true; checkbox.dispatchEvent(new h.window.Event('change'));
      await h.click('删除', manager); const confirmation = h.doc.querySelector('.bizop-delete-dialog'); await h.click('取消', confirmation); await h.flush(); assert.equal(h.count('deleteData'), 0);
      await h.click('删除', manager); const executing = h.doc.querySelector('.bizop-delete-dialog'); const pending = h.deferred(); h.reply.deleteData = () => pending.promise;
      await h.click('删除', executing); noTaskButtons(h); assert.equal(h.find('取消', executing).disabled, true);
      assert.equal(executing.dispatchEvent(new h.window.Event('cancel', { cancelable: true })), false);
      pending.resolve({ status: 'error', message: '删除未完成' }); await h.flush();
      assert.equal(h.find('取消', executing).disabled, false); assert.equal(h.controller.busy, false); assert.ok(executing.feedback.textContent.includes('删除未完成'), `删除反馈：${executing.feedback.textContent}`);
      await h.click('取消', executing); await h.flush(); assert.equal(h.count('deleteData'), 1);
    } finally { h.close(); }
  });
  test('输入与结果原表导出仍使用普通保存选择且没有任务取消占位', async () => {
    const h = await setup();
    try {
      h.controller.openInputExport(); const dialog = h.doc.querySelector('.bizop-input-export-dialog'); noTaskButtons(h);
      h.reply.pickExport = { status: 'cancelled' }; await h.click('导出', dialog);
      assert.equal(h.calls.find((call) => call.name === 'pickExport').args[0].outputKind, 'OP_RAW'); assert.equal(h.count('exportWorkbook'), 0);
      await h.click('返回', dialog); await h.flush(); await h.controller.openManager();
      const manager = h.doc.querySelector('.bizop-manager-dialog'); const pending = h.deferred(); h.reply.pickExport = { status: 'ok', selectionRef: 'raw-output' }; h.reply.exportWorkbook = () => pending.promise;
      await h.click('导出原表', manager); assert.equal(h.controller.busy, true); assert.equal(h.doc.activeElement, manager); noTaskButtons(h);
      pending.resolve({ status: 'ok' }); await h.flush(); assert.equal(h.count('exportWorkbook'), 1);
      assert.equal(h.calls.find((call) => call.name === 'exportWorkbook').args[0], 'RESULT_FULL'); assert.ok(h.doc.querySelector('.bizop-export-success-dialog'));
    } finally { h.close(); }
  });
}

function virtualEnvironment() {
  const window = { document: createDocument(), crypto: { randomUUID }, Event };
  vm.runInNewContext(source, { window }); return createHarness(window);
}
if (require.main === module) rendererCases(require('node:test'), require('node:assert/strict'), virtualEnvironment);
module.exports = { createHarness, rendererCases };
