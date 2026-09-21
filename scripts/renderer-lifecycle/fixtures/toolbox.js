'use strict';

// 真实工具箱工厂与宿主，API 使用可控替身，不读取或导出真实业务文件。
async function runBrowserCase(caseIndex) {
  const { createModalHost } = window.__modalHost;
  const { createModalBridge } = window.__modalBridge;
  const { createToolboxDialogs } = window.__toolboxDialogs;
  const passed = [];
  const assert = (condition, label) => { if (!condition) throw new Error(label); };
  const equal = (a, b, label) => assert(JSON.stringify(a) === JSON.stringify(b), `${label}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { resolve, promise }; };
  const click = (element) => element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  const change = (element, value) => { element.checked = value; element.dispatchEvent(new Event('change', { bubbles: true })); };
  const input = (element, value) => { element.value = value; element.dispatchEvent(new Event('input', { bubbles: true })); };
  const query = (element, selector) => { const found = element.querySelector(selector); assert(found, `缺少 ${selector}`); return found; };
  const readResult = (extra = {}) => ({ status: 'success', sourceFilePath: '/fixture/source.xlsx', splitReadToken: 'original-token',
    headers: ['Currency', 'Account'], valuesByField: { Currency: ['USD', 'EUR'], Account: ['A', 'B'] }, dataRowCount: 23, maxRowSplitFiles: 1000, ...extra });

  function setup(overrides = {}) {
    const root = document.createElement('div'); document.body.appendChild(root);
    const errors = [];
    const calls = { read: 0, exports: [], merge: 0, alerts: [] };
    const host = createModalHost({ root, document, reportError: (error) => errors.push(String(error)) });
    const bridge = createModalBridge({ host });
    const api = {
      merge: async () => { calls.merge += 1; return { status: 'cancelled' }; },
      splitRead: async () => { calls.read += 1; return readResult(); },
      splitExport: async (payload) => { calls.exports.push(payload); return { status: 'cancelled' }; },
      ...overrides
    };
    function createAlertDialog(html, options = {}) {
      calls.alerts.push({ html, options });
      const overlay = document.createElement('div'); overlay.className = 'modal-overlay';
      const dialog = document.createElement('div'); dialog.className = 'modal-card alert-card';
      dialog.innerHTML = `<div>${html}</div><button data-action="confirm">确认</button>`;
      overlay.appendChild(dialog);
      query(dialog, 'button').addEventListener('click', () => bridge.closeModal(overlay, { status: 'submitted', value: true }));
      bridge.registerModal(overlay, { dialog });
      return overlay;
    }
    const dialogs = createToolboxDialogs({ api, modalBridge: bridge, ui: { createAlertDialog, escapeHtml: (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;') } });
    const parent = dialogs.createToolboxDialog();
    const handle = bridge.openModal(() => parent, { owner: 'toolbox' }).handle;
    return { root, host, bridge, calls, errors, parent, handle, dialogs, dispose() { host.dispose(); root.remove(); } };
  }

  if (caseIndex === 0) {
    const pendingRead = deferred();
    let reads = 0;
    const env = setup({ splitRead: () => { reads += 1; return pendingRead.promise; } });
    click(query(env.parent, '[data-action="split-import"]'));
    click(query(env.parent, '[data-action="split-import"]'));
    equal(reads, 1, '读取 busy 拒绝双击');
    equal(env.handle.close().status, 'blocked', '读取期间禁止全部普通关闭');
    equal(env.host.openRoot(() => { throw new Error('不应构建'); }).status, 'blocked', '读取期间禁止根替换');
    pendingRead.resolve(readResult()); await tick();
    assert(env.root.children.length === 2 && env.handle.isOpen() && !env.handle.signal.aborted, 'picker 保留父会话');
    const first = env.host.getTop();
    const picker = env.root.lastElementChild;
    query(picker, '.toolbox-split-values-dropdown-btn').click();
    change(query(picker, '.new-account-checkbox'), true);
    change(query(picker, '[data-field="multiple-files-enabled"]'), true);
    equal((await first.closed).reason, 'replaced', '单字段切多文件销毁旧视图');
    const multiple = env.root.lastElementChild;
    assert(multiple.dataset.previewModal.endsWith('multiple'), '打开多文件模式');
    assert(query(multiple, '.toolbox-split-values-dropdown-btn').textContent === 'USD', '单字段草稿传入第一组');
    change(query(multiple, '[data-field="multiple-files-enabled"]'), false);
    const single = env.root.lastElementChild;
    assert(query(single, '[data-action="complete"]').disabled, '多文件返回单字段沿用原清空行为');
    equal(reads, 1, '切模式不重新读表');
    click(query(single, '[data-action="cancel"]'));
    assert(env.handle.isTop() && env.root.firstElementChild === env.parent, '取消回原父 DOM');
    equal(env.calls.exports.length, 0, '取消不导出');
    env.dispose(); passed.push('读取锁、父子会话、单多模式替换、草稿转换、取消');
  }

  if (caseIndex === 1) {
    const pendingExport = deferred();
    const payloads = [];
    const env = setup({ splitExport: (payload) => { payloads.push(payload); return pendingExport.promise; } });
    let parentAborts = 0;
    env.handle.signal.addEventListener('abort', () => { parentAborts += 1; });
    click(query(env.parent, '[data-action="split-import"]')); await tick();
    const picker = env.root.lastElementChild;
    const child = env.host.getTop();
    change(query(picker, '[data-field="split-by-rows"]'), true);
    input(query(picker, '[data-field="rows-per-file"]'), '10');
    assert(query(picker, '[data-field="multiple-files-enabled"]').disabled, '按行与多文件互斥');
    const complete = query(picker, '[data-action="complete"]');
    let busyAtChildAbort = null;
    child.signal.addEventListener('abort', () => { busyAtChildAbort = env.parent.getAttribute('aria-busy'); });
    click(complete); click(complete);
    equal(busyAtChildAbort, 'true', '关闭选择层前已经设置保存锁');
    equal(payloads.length, 1, '导出只执行一次');
    equal(payloads[0], { sourceFilePath: '/fixture/source.xlsx', splitReadToken: 'original-token', mode: 'rows', rowsPerFile: 10 }, '原 token 和按行 payload');
    assert(Object.isFrozen(payloads[0]), '提交快照不可变');
    equal((await child.closed).status, 'submitted', 'picker 提交先关闭');
    assert(env.handle.isTop() && env.root.children.length === 1, '保存期间显露父窗口');
    equal(env.handle.close().status, 'blocked', '保存期间不能关闭父窗口');
    pendingExport.resolve({ status: 'success', fileCount: 3, outputDataRowCount: 23, files: [{ fileName: '1.xlsx', dataRowCount: 10, filePath: '/fixture/1.xlsx' }] });
    await tick();
    assert(env.root.children.length === 2 && env.parent.inert && parentAborts === 0, '结果告警保留父会话');
    click(query(env.root.lastElementChild, '[data-action="confirm"]'));
    assert(env.handle.isTop() && env.root.firstElementChild === env.parent, '结果告警返回原父窗口');
    equal(query(env.parent, '.status-box-text').textContent, '拆分完成', '保留完成反馈');
    env.handle.close(); env.handle.dispose();
    equal(parentAborts, 1, '父最终清理一次');
    env.dispose(); passed.push('按行拆分、原 token、重复提交拒绝、busy、结果告警返回');
  }

  if (caseIndex === 2) {
    const env = setup();
    click(query(env.parent, '[data-action="split-import"]')); await tick();
    const picker = env.root.lastElementChild;
    const dropdown = query(picker, '.toolbox-split-values-dropdown-btn'); dropdown.click();
    const checkbox = query(picker, '.new-account-checkbox');
    change(checkbox, true);
    click(query(picker, '[data-action="complete"]')); await tick();
    equal(env.calls.exports, [{ sourceFilePath: '/fixture/source.xlsx', splitReadToken: 'original-token', field: 'Currency', values: ['USD'] }], '单字段 payload 保持');
    assert(env.handle.isTop(), '保存取消仍在父窗口');
    equal(query(env.parent, '.status-box-text').textContent, '已取消拆分', '保存取消提示保持');
    env.dispose(); passed.push('单字段选值导出与保存取消');
  }

  if (caseIndex === 3) {
    const env = setup();
    click(query(env.parent, '[data-action="split-import"]')); await tick();
    change(query(env.root.lastElementChild, '[data-field="multiple-files-enabled"]'), true);
    const picker = env.root.lastElementChild;
    input(query(picker, '.toolbox-split-file-name-input'), 'report.xlsx.xlsx');
    query(picker, '.toolbox-split-values-dropdown-btn').click();
    change(query(picker, '.new-account-checkbox'), true);
    const complete = query(picker, '[data-action="complete"]'); click(complete); click(complete); await tick();
    equal(env.calls.exports, [{ sourceFilePath: '/fixture/source.xlsx', splitReadToken: 'original-token', mode: 'multiple', groups: [{ fileName: 'report.xlsx', field: 'Currency', values: ['USD'] }] }], '多文件 payload 与扩展名归一保持');
    env.dispose(); passed.push('多文件合法命名、token 与重复提交拒绝');
  }

  if (caseIndex === 4) {
    const env = setup({ splitRead: async () => readResult({ maxRowSplitFiles: 2 }) });
    click(query(env.parent, '[data-action="split-import"]')); await tick();
    const picker = env.root.lastElementChild;
    change(query(picker, '[data-field="split-by-rows"]'), true);
    input(query(picker, '[data-field="rows-per-file"]'), '10');
    assert(query(picker, '[data-action="complete"]').disabled, '超过最多文件数禁止提交');
    click(query(picker, '[data-action="complete"]'));
    equal(env.calls.exports.length, 0, '合成点击不绕过数量验证');
    input(query(picker, '[data-field="rows-per-file"]'), '12');
    assert(!query(picker, '[data-action="complete"]').disabled, '计数沿用原读取快照');
    env.dispose(); passed.push('按行计数与最大文件数校验');
  }

  if (caseIndex === 5) {
    const pending = deferred();
    const env = setup({ splitRead: () => pending.promise });
    click(query(env.parent, '[data-action="split-import"]'));
    const before = query(env.parent, '.status-box-text').textContent;
    env.handle.dispose('renderer-dispose');
    pending.resolve(readResult()); await tick();
    equal(env.root.children.length, 0, '晚到读取不得复活 picker');
    equal(query(env.parent, '.status-box-text').textContent, before, '晚到读取不写已销毁 DOM');
    equal(env.calls.exports.length, 0, '销毁不伪造提交');
    env.dispose(); passed.push('强制销毁后的读取晚到无效');
  }

  if (caseIndex === 6) {
    const pending = deferred();
    let exports = 0;
    const env = setup({ splitExport: () => { exports += 1; return pending.promise; } });
    click(query(env.parent, '[data-action="split-import"]')); await tick();
    const picker = env.root.lastElementChild;
    change(query(picker, '[data-field="split-by-rows"]'), true);
    input(query(picker, '[data-field="rows-per-file"]'), '20');
    click(query(picker, '[data-action="complete"]'));
    const before = query(env.parent, '.status-box-text').textContent;
    env.handle.dispose('renderer-dispose');
    pending.resolve({ status: 'success', fileCount: 2, outputDataRowCount: 23 }); await tick();
    equal(exports, 1, '后台操作仍只执行一次');
    equal(env.root.children.length, 0, '晚到导出不复活告警');
    equal(query(env.parent, '.status-box-text').textContent, before, '晚到导出不写旧 UI');
    env.dispose(); passed.push('强制销毁后的导出晚到无效');
  }

  if (caseIndex === 7) {
    const env = setup({ splitExport: async (payload) => {
      env.calls.exports.push(payload);
      return { status: 'failed', code: 'TOOLBOX_SPLIT_READ_CONTEXT_STALE', message: '来源已变化，请重新读取', detailLines: ['stale-token'] };
    } });
    click(query(env.parent, '[data-action="split-import"]')); await tick();
    const picker = env.root.lastElementChild;
    change(query(picker, '[data-field="split-by-rows"]'), true);
    input(query(picker, '[data-field="rows-per-file"]'), '20');
    click(query(picker, '[data-action="complete"]')); await tick();
    assert(env.root.lastElementChild.textContent.includes('来源已变化，请重新读取'), '保留 Main stale 拒绝');
    equal(env.calls.exports.length, 1, '不自动重试旧 token');
    click(query(env.root.lastElementChild, '[data-action="confirm"]'));
    assert(env.handle.isTop(), '错误告警返回父窗口');
    env.dispose(); passed.push('Main stale 错误原样反馈、不重试旧 token');
  }

  if (caseIndex === 8) {
    const env = setup({ splitRead: async () => readResult({ headers: ['Empty', 'Currency'], valuesByField: { Empty: [], Currency: ['USD', 'EUR'] } }) });
    click(query(env.parent, '[data-action="split-import"]')); await tick();
    const picker = env.root.lastElementChild;
    const field = query(picker, '.toolbox-split-picker-field');
    assert(query(picker, '.toolbox-split-values-dropdown-btn').disabled, '空值字段禁用下拉');
    click(query(picker, '[data-action="complete"]'));
    equal(env.calls.exports.length, 0, '无值不得导出');
    field.value = '1'; field.dispatchEvent(new Event('change'));
    query(picker, '.toolbox-split-values-dropdown-btn').click();
    change(query(picker, '.new-account-checkbox'), true);
    assert(!query(picker, '[data-action="complete"]').disabled, '合法值可提交');
    field.value = '0'; field.dispatchEvent(new Event('change'));
    assert(query(picker, '[data-action="complete"]').disabled, '切换字段清空旧值');
    env.dispose(); passed.push('空字段、空选、切字段重置不发导出');
  }

  if (caseIndex === 9) {
    const env = setup();
    click(query(env.parent, '[data-action="split-import"]')); await tick();
    change(query(env.root.lastElementChild, '[data-field="multiple-files-enabled"]'), true);
    const picker = env.root.lastElementChild;
    query(picker, '.toolbox-split-values-dropdown-btn').click();
    change(query(picker, '.new-account-checkbox'), true);
    for (const invalid of ['bad/name', 'CON', 'Report.', ' Report']) {
      input(query(picker, '.toolbox-split-file-name-input'), invalid);
      click(query(picker, '[data-action="complete"]'));
      equal(env.calls.exports.length, 0, `非法名 ${invalid} 不得导出`);
      assert(query(picker, '[data-role="multiple-hint"]').textContent.includes('文件1'), '提供分组定位');
    }
    input(query(picker, '.toolbox-split-file-name-input'), 'Report');
    click(query(picker, '[data-action="add-group"]'));
    let sections = picker.querySelectorAll('.toolbox-split-group');
    equal(sections.length, 2, '新增第二组');
    equal(query(sections[1], '.toolbox-split-file-name-input').value, '', '新组文件名为空');
    equal(query(sections[1], '.toolbox-split-values-dropdown-btn').textContent, ' ', '新组值为空');
    equal(query(sections[1], '.toolbox-split-picker-field').value, query(sections[0], '.toolbox-split-picker-field').value, '新组继承前组字段');
    input(query(sections[1], '.toolbox-split-file-name-input'), 'report.XLSX');
    query(sections[1], '.toolbox-split-values-dropdown-btn').click();
    change(query(picker, '.new-account-checkbox'), true);
    click(query(picker, '[data-action="complete"]'));
    assert(query(picker, '[data-role="multiple-hint"]').textContent.includes('重复'), '文件名重复大小写不敏感');
    equal(env.calls.exports.length, 0, '重复文件名不得导出');
    const add = query(picker, '[data-action="add-group"]');
    for (let index = 0; index < 8; index += 1) click(add);
    equal(picker.querySelectorAll('.toolbox-split-group').length, 8, '最多8组不能合成点击绕过');
    assert(add.hidden && add.disabled, '最大组数隐藏并禁用新增');
    while (picker.querySelectorAll('.toolbox-split-group').length > 1) click(query(picker, '.toolbox-split-delete-group'));
    assert(query(picker, '.toolbox-split-delete-group').disabled, '至少保留一组');
    env.dispose(); passed.push('多文件非法名、重复名、字段继承和一至八组边界');
  }

  if (caseIndex === 10) {
    for (const missing of [{ sourceFilePath: '' }, { splitReadToken: '' }]) {
      const env = setup({ splitRead: async () => readResult(missing) });
      click(query(env.parent, '[data-action="split-import"]')); await tick();
      assert(!env.root.querySelector('.toolbox-split-picker-card'), '缺读取身份不打开不可提交的选择层');
      assert(env.root.lastElementChild.textContent.includes('缺少本次读取的来源或有效标识'), '缺身份明确显示读取失败');
      equal(env.calls.exports.length, 0, '缺身份不能导出');
      click(query(env.root.lastElementChild, '[data-action="confirm"]'));
      assert(env.handle.isTop() && !query(env.parent, '[data-action="split-import"]').disabled, '错误返回可重新读取的父层');
      env.dispose();
    }
    const env = setup();
    let prepares = 0;
    const session = { prepareSubmit() { prepares += 1; return false; }, draft: null };
    env.bridge.openModal(() => env.dialogs.createSplitFieldPickerDialog({ ...readResult(), _session: session }));
    const picker = env.root.lastElementChild;
    change(query(picker, '[data-field="split-by-rows"]'), true);
    input(query(picker, '[data-field="rows-per-file"]'), '10');
    click(query(picker, '[data-action="complete"]')); click(query(picker, '[data-action="complete"]'));
    equal(prepares, 2, '拒绝预提交后恢复控件，允许用户更正');
    assert(!query(picker, '[data-action="complete"]').disabled, '拒绝预提交不能锁死选择层');
    equal(env.calls.exports.length, 0, '预提交拒绝不发业务IPC');
    env.dispose(); passed.push('缺读取身份先失败，预提交拒绝恢复可操作态');
  }

  if (caseIndex === 11) {
    const samples = Array.from({ length: 22 }, (_, index) => ({ sourceFileName: 'source.xlsx', sourceSheet: 'Sheet1', cellRef: `A${index + 1}`, message: `warning-${index}` }));
    const env = setup({ merge: async () => ({ status: 'success', filePath: '/fixture/<report>.xlsx', warningSummary: { warningCount: 22, warningSamples: samples }, warnings: ['published'] }) });
    click(query(env.parent, '[data-action="merge-import"]')); await tick();
    const alert = env.root.lastElementChild;
    assert(alert.textContent.includes('/fixture/<report>.xlsx'), '合并显示正确转义后的保存路径');
    assert(alert.textContent.includes('warning-19') && !alert.textContent.includes('warning-20'), '格式转换提示保留最多20样例');
    assert(alert.textContent.includes('其余 2') && alert.textContent.includes('发布提示：published'), '超量汇总与发布提示保留');
    equal(env.calls.alerts[0].options.skipLogReport, true, '成功告警不报告error');
    click(query(alert, '[data-action="confirm"]'));
    assert(env.handle.isTop(), '合并成功返回同一父层');
    env.dispose();
    const failed = setup({ merge: async () => ({ status: 'failed', message: '表头不一致', detailLines: ['<bad-column>'] }) });
    click(query(failed.parent, '[data-action="merge-import"]')); await tick();
    assert(failed.root.lastElementChild.textContent.includes('表头不一致') && failed.root.lastElementChild.textContent.includes('<bad-column>'), '失败展示message与明细且转义');
    equal(failed.calls.alerts[0].options.skipLogReport, false, '失败保留error报告');
    failed.dispose();
    const cancelled = setup();
    click(query(cancelled.parent, '[data-action="merge-import"]')); await tick();
    equal(cancelled.root.children.length, 1, '合并取消不弹告警');
    equal(query(cancelled.parent, '.status-box-text').textContent, '已取消合并', '取消保留文字状态');
    cancelled.dispose(); passed.push('合并成功取消失败、路径转义和二十条格式提示');
  }

  return passed;
}

module.exports = async ({ js, load, reset, assert, test }) => {
  const labels = ["读取锁、父子会话、单多模式替换、草稿转换、取消", "按行拆分、原 token、重复提交拒绝、busy、结果告警返回", "单字段选值导出与保存取消", "多文件合法命名、token 与重复提交拒绝", "按行计数与最大文件数校验", "强制销毁后的读取晚到无效", "强制销毁后的导出晚到无效", "Main stale 错误原样反馈、不重试旧 token", "空字段、空选、切字段重置不发导出", "多文件非法名、重复名、字段继承和一至八组边界", "缺读取身份先失败，预提交拒绝恢复可操作态", "合并成功取消失败、路径转义和二十条格式提示"];
  for (let index = 0; index < labels.length; index += 1) {
    await test(labels[index], async () => {
      await reset();
      await load('src/renderer/dialogs/toolbox.js');
      const passed = await js(`(${runBrowserCase.toString()})(${index})`);
      assert.deepEqual(passed, [labels[index]]);
    });
  }
};
