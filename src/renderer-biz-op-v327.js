/* 业务 OP 区间页面：仅由 Main 返回的版本化 mode 决定显示；页面不持有文件路径或业务行。 */
(function initBizOpV327Page(root) {
  'use strict';
  function createController({ api, panel, legacyPanel, restoreLegacy, document: doc = root.document }) {
    let selected = false; let routeVersion = 0; let busy = false; let activeRequest = null; let cancelRequested = false;
    let reportRef = null; let recoveryReady = false; let enabled = false; const dialogs = new Set();
    const oldDisabled = new Map();
    function node(tag, text, className) { const item = doc.createElement(tag); if (text !== undefined) item.textContent = text;
      if (className) item.className = className; return item; }
    function button(text, work, className = 'secondary-btn') { const item = node('button', text, className); item.type = 'button';
      item.addEventListener('click', () => { if (busy && item !== cancelButton) return; Promise.resolve().then(work).catch(showError); }); return item; }
    function field(label, control) { const wrap = node('label', undefined, 'bizop-field'); wrap.append(node('span', label), control); return wrap; }
    function select(options) { const item = node('select'); for (const [value, text] of options) { const option = node('option', text); option.value = value; item.append(option); } return item; }
    function dateField() { const item = node('input'); item.type = 'date'; return item; }
    function message(text, tone = 'info') { status.textContent = text; status.dataset.tone = tone; }
    function checked(result) {
      if (!result || ['error', 'busy', 'blocked'].includes(result.status) || result.accepted === false) {
        const detail = result?.missing?.map((item) => `${item.kind === 'OP' ? 'OP 校验表' : '流水校验表'} ${item.dataDate}`).join('、');
        const error = new Error(`${result?.message || '操作未完成，请刷新后重试'}${detail ? `；缺少：${detail}` : ''}${result?.code ? `（${result.code}）` : ''}`);
        error.result = result; throw error;
      }
      return result;
    }
    function showError(error) {
      const text = error?.message || '操作未完成，请重试'; message(text, 'error');
      const dialog = [...dialogs].at(-1); if (dialog) { dialog.feedback.textContent = text; dialog.feedback.dataset.tone = 'error'; }
    }
    function setBusy(value) {
      busy = value;
      for (const element of [panel, ...dialogs].flatMap((scope) => [...scope.querySelectorAll('button,input,select')])) {
        if (element === cancelButton) continue;
        if (value) { if (!oldDisabled.has(element)) oldDisabled.set(element, element.disabled); element.disabled = true; }
        else if (oldDisabled.has(element)) { element.disabled = oldDisabled.get(element); oldDisabled.delete(element); }
      }
      cancelButton.hidden = !value; cancelButton.disabled = false;
    }
    async function perform(label, work) {
      if (busy) return null;
      activeRequest = `ui-${root.crypto.randomUUID()}`; cancelRequested = false;
      setBusy(true); message(`${label}，正在等待后台处理…`);
      try {
        const result = await work(activeRequest, () => cancelRequested);
        if (result?.reportRef) { reportRef = result.reportRef; reportButton.hidden = false; }
        checked(result);
        message(result.status === 'cancelled' ? '操作已取消' : `${label}完成${result.reused ? '，使用已存在的相同结果' : ''}${result.cleanupPending ? '；仍有收尾未决，请重试恢复' : ''}`, result.cleanupPending ? 'warning' : 'success');
        if (result.summary) message(`${label}${result.status === 'ok' ? '完成' : '未完成'}：扫描 ${result.summary.scannedDataRows} 行，接受 ${result.summary.acceptedRows} 行`, result.status === 'ok' ? 'success' : 'warning');
        return result;
      } catch (error) {
        if (error.result?.reportRef) { reportRef = error.result.reportRef; reportButton.hidden = false; }
        showError(error); return null;
      } finally { activeRequest = null; setBusy(false); await refreshStatus(false); }
    }
    function modal(title) {
      const dialog = node('dialog', undefined, 'bizop-v327-dialog'); const heading = node('h2', title);
      const body = node('div', undefined, 'bizop-modal-body'); const feedback = node('p', '', 'bizop-feedback'); feedback.setAttribute('role', 'status');
      const footer = node('div', undefined, 'bizop-modal-footer'); const close = button('关闭', () => dialog.close());
      footer.append(close); dialog.append(heading, body, feedback, footer); dialog.feedback = feedback; dialog.body = body; dialog.footer = footer;
      dialog.addEventListener('cancel', (event) => { if (busy) event.preventDefault(); });
      dialog.addEventListener('close', () => { dialogs.delete(dialog); dialog.remove(); }); dialogs.add(dialog);
      doc.body.append(dialog); dialog.showModal(); return dialog;
    }
    function table(headers, rows) {
      const scroll = node('div', undefined, 'bizop-table-scroll'); const table = node('table'); const thead = node('thead'); const tr = node('tr');
      headers.forEach((name) => tr.append(node('th', name))); thead.append(tr); const tbody = node('tbody');
      for (const values of rows) { const row = node('tr'); for (const value of values) { const cell = node('td'); cell.append(value?.nodeType ? value : node('span', value ?? '')); row.append(cell); } tbody.append(row); }
      if (!rows.length) { const row = node('tr'); const cell = node('td', '该操作月份没有可用数据'); cell.colSpan = headers.length; row.append(cell); tbody.append(row); }
      table.append(thead, tbody); scroll.append(table); return scroll;
    }
    async function exportObject(outputKind, objectId) {
      return perform('导出文件', async (requestId, cancelled) => {
        const picked = checked(await api.pickExport({ outputKind, objectId }));
        if (picked.status === 'cancelled' || cancelled()) return { status: 'cancelled' };
        return checked(await api.exportWorkbook(outputKind, { requestId, selectionRef: picked.selectionRef }));
      });
    }
    async function importFiles() {
      await perform('导入文件', async (requestId, cancelled) => {
        const picked = checked(await api.pickFiles());
        if (picked.status === 'cancelled' || cancelled()) return { status: 'cancelled' };
        return await api.importFiles({ requestId, selectionRef: picked.selectionRef });
      });
    }
    function openRun() {
      const dialog = modal('开始运行'); const start = dateField(); const end = dateField();
      const fields = node('div', undefined, 'bizop-field-row'); fields.append(field('起始日期', start), field('终止日期', end));
      const details = node('div'); const run = button('确认运行', async () => {
        const result = await perform('区间核对', (requestId) => api.run({ requestId, selectionRef: preflight.selectionRef }));
        if (result?.status === 'ok') dialog.close(); else { preflight = null; run.disabled = true; }
      }, 'primary-btn'); let preflight = null; let preflightVersion = 0; run.disabled = true;
      const precheck = button('检查所需数据', async () => {
        preflight = null; run.disabled = true; details.replaceChildren(); precheck.disabled = true; const version = ++preflightVersion;
        try {
          const result = checked(await api.preflight({ startDate: start.value, endDate: end.value }));
          if (version !== preflightVersion) return; preflight = result;
          details.append(table(['所需校验表', '账期', '当前版本', '来源文件'], preflight.inputs.map((item) => [item.role === 'FLOW' ? '流水校验表' : 'OP 校验表', item.dataDate, `v${item.version}`, item.originals.join('、')])));
          dialog.feedback.textContent = '所需输入齐全。确认后使用这些当前版本核对全部 BU。'; run.disabled = false;
        } finally { precheck.disabled = false; }
      });
      for (const item of [start, end]) item.addEventListener('change', () => { preflightVersion += 1; preflight = null; run.disabled = true; details.replaceChildren(); });
      dialog.body.append(node('p', 'OP 需要起始、终止两日；流水需要起始日之后至终止日的每一天。'), fields, precheck, details); dialog.footer.prepend(run);
    }
    async function latestMonth() { const result = checked(await api.months({ limit: 1 })); return result.months[0] || new Date().toISOString().slice(0, 7); }
    async function openResults() {
      const dialog = modal('导出校验结果表'); const month = node('input'); month.type = 'month'; month.value = await latestMonth();
      const choice = select([['', '请选择结果表']]); const next = button('下一页', () => load(cursor)); let cursor = null; let generation; let loadVersion = 0;
      const exportBtn = button('另存为差异结果', async () => { if (!choice.value) throw new Error('请先选择结果表');
        if ((await exportObject('RESULT_DIFF', choice.value))?.status === 'ok') dialog.close(); }, 'primary-btn');
      async function load(after = null) {
        const version = ++loadVersion;
        choice.replaceChildren(); exportBtn.disabled = true; next.disabled = true;
        const data = checked(await api.list({ view: 'RESULT', operationMonth: month.value, limit: 200,
          ...(after ? { cursor: after, generation } : {}) }));
        if (version !== loadVersion) return;
        choice.replaceChildren(); choice.append(Object.assign(node('option', data.rows.length ? '请选择结果表' : '该月份没有结果表'), { value: '' }));
        for (const row of data.rows) choice.append(Object.assign(node('option', row.tableName), { value: row.objectId }));
        generation = data.generation; cursor = data.nextCursor; next.disabled = !cursor; exportBtn.disabled = !data.rows.length;
      }
      month.addEventListener('change', () => load().catch(showError));
      dialog.body.append(field('操作月份', month), field('结果表表名', choice), next); dialog.footer.prepend(exportBtn); await load();
    }
    function openInputExport() {
      const dialog = modal('导出数据'); const kind = select([['OP_RAW', 'OP 原表'], ['OP_CHECK', 'OP 校验表'], ['FLOW_RAW', '流水原表'], ['FLOW_CHECK', '流水校验表']]);
      const date = dateField(); const target = field('导出目标', kind); target.classList.add('bizop-half');
      dialog.body.append(target, field('账期', date), node('p', '只导出该类型、该账期当前可用的版本。'));
      dialog.footer.prepend(button('选择位置并导出', async () => {
        const current = checked(await api.currentInput({ kind: kind.value.split('_')[0], dataDate: date.value }));
        if ((await exportObject(kind.value, current.objectId))?.status === 'ok') dialog.close();
      }, 'primary-btn'));
    }
    async function showDelete(selection, refresh) {
      const preview = checked(await api.deletePreview(selection)); const dialog = modal('确认删除影响');
      dialog.body.append(node('p', `将处理 ${preview.datasets.length} 个当前输入版本；关联 ${preview.runs.length} 对历史结果（全量表与差异表一起处理）。`));
      if (preview.datasets.length) dialog.body.append(table(['输入类型', '账期', '版本', '来源文件'], preview.datasets.map((item) => [item.kind, item.dataDate, `v${item.version}`, item.originals.map((file) => file.originalName).join('、')])));
      if (preview.runs.length) dialog.body.append(table(['操作月份', '起始日期', '终止日期', '关联结果表', '原件引用'], preview.runs.map((item) => {
        const originals = node('details'); originals.append(node('summary', `${item.originals.length} 个原件`));
        originals.append(node('p', item.originals.map((file) => file.originalName).join('、')));
        return [item.operationMonth, item.startDate, item.endDate, item.tableName, originals];
      })));
      const ref = preview.references;
      dialog.body.append(node('p', `保留结果时仍受保护的原件：${ref.protectedAfterKeep}；删除所列结果后仍受保护：${ref.protectedAfterDelete}。其中用户锁定 ${ref.userLockedOriginals} 个，存在其他归档引用 ${ref.sharedBlobOriginals} 个。`));
      dialog.body.append(node('p', '删除输入会同时删除该类型、该账期的原表与校验表，不恢复旧版本。其他输入、用户原文件和已另存的结果不受影响。归档原件继续按存档中心的引用、锁和保留期处理。'));
      dialog.footer.replaceChildren();
      async function confirm(mode) {
        const result = await perform('删除数据', (requestId) => api.deleteData({ requestId, previewId: preview.previewId, mode }));
        if (result?.status === 'ok') { dialog.close(); await refresh(); }
      }
      if (!preview.selection.runIds.length) dialog.footer.append(button('删除但保留结果表', () => confirm('KEEP_RESULTS')));
      dialog.footer.append(button('删除', () => confirm('DELETE_ASSOCIATED'), 'primary-btn bizop-danger'), button('取消', () => dialog.close()));
    }
    async function openManager() {
      const dialog = modal('数据管理'); const month = node('input'); month.type = 'month'; month.value = await latestMonth();
      const view = select([['RESULT', '结果表'], ['CHECK', '校验表'], ['RAW', '校验原表']]); const kind = select([['OP', 'OP'], ['FLOW', '流水']]);
      const controls = node('div', undefined, 'bizop-field-row'); controls.append(field('操作月份', month), field('数据页', view), field('输入类型', kind));
      let rows = []; let cursor = null; let generation; let loadVersion = 0; let selecting = false; const selection = new Set(); const content = node('div');
      const choose = button('选取', () => { selecting = !selecting; choose.textContent = selecting ? '结束选取' : '选取'; selection.clear(); render(); });
      const next = button('下一页', () => load(cursor)); const first = button('第一页 / 刷新', () => load());
      const del = button('删除', () => { if (!selection.size) throw new Error('请先选取要删除的数据'); return showDelete(
        view.value === 'RESULT' ? { runIds: [...selection] } : { datasetIds: [...selection] }, () => load()); }, 'primary-btn bizop-danger');
      function render() {
        const isResult = view.value === 'RESULT'; const raw = view.value === 'RAW'; kind.disabled = isResult; del.hidden = !selecting;
        const headers = isResult ? ['起始日期', '终止日期', '表名', '结果版本', '更新时间', '操作'] : raw ? ['账期', '原表类型', '来源文件', '导入时间', '版本'] : ['账期', '表名', '版本', '生成时间'];
        const cells = rows.map((row) => {
          const values = isResult ? [row.startDate, row.endDate, row.tableName, `v${row.version}`, row.updatedAt.replace('T', ' ').replace('Z', ' UTC'), button('导出原表', () => exportObject('RESULT_FULL', row.objectId))]
            : raw ? [row.dataDate, row.kind === 'OP' ? 'OP 原表' : '流水原表', row.originalName, row.updatedAt.replace('T', ' ').replace('Z', ' UTC'), `v${row.version}`]
              : [row.dataDate, row.tableName, `v${row.version}`, row.updatedAt.replace('T', ' ').replace('Z', ' UTC')];
          if (selecting) { const check = node('input'); check.type = 'checkbox'; check.checked = selection.has(row.objectId);
            check.setAttribute('aria-label', `选取 ${row.tableName}`); check.addEventListener('change', () => { if (check.checked) selection.add(row.objectId); else selection.delete(row.objectId); render(); }); values.unshift(check); }
          return values;
        });
        if (selecting) headers.unshift('选取'); content.replaceChildren(table(headers, cells));
        next.disabled = !cursor; del.disabled = !selection.size;
      }
      async function load(after = null) {
        const version = ++loadVersion;
        rows = []; selection.clear(); cursor = null; render();
        const data = checked(await api.list({ view: view.value, kind: kind.value, operationMonth: month.value, limit: 200,
          ...(after ? { cursor: after, generation } : {}) }));
        if (version !== loadVersion) return;
        rows = data.rows; cursor = data.nextCursor; generation = data.generation; selection.clear(); render();
      }
      for (const item of [month, view, kind]) item.addEventListener('change', () => load().catch(showError));
      dialog.body.append(controls, node('p', '每页最多 200 条。选取原表中的任一来源文件，将处理该类型、账期的整个当前版本及其配对校验表。'), content);
      dialog.footer.prepend(first, next, choose, del); await load();
    }
    const toolbar = node('div', undefined, 'bizop-toolbar'); const status = node('div', '正在读取模块状态…', 'status-box bizop-status'); status.setAttribute('role', 'status');
    const importButton = button('导入文件', importFiles, 'primary-btn'); const runButton = button('开始运行', openRun, 'primary-btn');
    const resultButton = button('导出校验结果表', openResults); const inputButton = button('导出数据', openInputExport); const managerButton = button('数据管理', openManager);
    const reportButton = button('导出错误报告', () => exportObject('ERRORS', reportRef)); reportButton.hidden = true;
    const retry = button('重试恢复', async () => {
      const result = await perform('恢复检查', async () => { const state = await api.retryRecovery(); return { status: state.ready ? 'ok' : 'error', message: state.ready ? '恢复已完成' : '仍有未决任务或文件，请查看任务详情后重试' }; });
      if (result?.status === 'ok') await refreshStatus(true);
    });
    const cancelButton = button('取消当前操作', async () => {
      if (!activeRequest) return; cancelRequested = true; const result = checked(await api.cancel({ requestId: activeRequest }));
      message(result.message || '已请求取消，正在等待后台任务退出', 'warning'); cancelButton.disabled = true;
    }); cancelButton.hidden = true;
    toolbar.append(importButton, runButton, resultButton, inputButton, managerButton);
    const footer = node('div', undefined, 'bizop-toolbar bizop-secondary'); footer.append(reportButton, retry, cancelButton);
    panel.append(toolbar, status, footer);
    async function refreshStatus(show = true) {
      if (!api) return;
      try {
        const info = await api.status(); enabled = info.mode === 'ACTIVE'; recoveryReady = info.recoveryReady === true;
        if (!busy) for (const btn of [importButton, runButton, resultButton, inputButton, managerButton, reportButton]) btn.disabled = !enabled || !recoveryReady;
        retry.hidden = recoveryReady; retry.disabled = !enabled || busy;
        if (show && !enabled) message('新区间功能正在准备，完成恢复与升级后开放入口', 'warning');
        else if (show && !recoveryReady) message('存在未决任务或文件，完成恢复后可继续操作', 'warning');
        else if (show) message('已就绪：导入文件后选择起止日期，核对全部 BU。');
        return info;
      } catch (error) { enabled = false; for (const btn of [importButton, runButton, resultButton, inputButton, managerButton, reportButton]) btn.disabled = true; showError(error); return null; }
    }
    async function setSelected(value) {
      selected = value; const version = ++routeVersion; panel.hidden = true;
      if (!value) { for (const dialog of dialogs) if (!busy) dialog.close(); return; }
      legacyPanel.hidden = true;
      if (!api) { legacyPanel.hidden = false; restoreLegacy(); return; }
      const info = await refreshStatus(); if (version !== routeVersion || !selected) return;
      if (info?.mode === 'DISABLED') { legacyPanel.hidden = false; restoreLegacy(); }
      else panel.hidden = false;
    }
    return { setSelected, openRun, openManager, openResults, openInputExport, get busy() { return busy; } };
  }
  root.createBizOpV327Controller = createController;
})(typeof window === 'object' ? window : globalThis);
