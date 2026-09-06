/* 业务 OP 区间页面：仅由 Main 返回的版本化 mode 决定显示；页面不持有文件路径或业务行。 */
(function initBizOpV327Page(root) {
  'use strict';
  function createController({ api, panel, legacyPanel, restoreLegacy, document: doc = root.document }) {
    let selected = false; let routeVersion = 0; let busy = false; let activeRequest = null; let cancelRequested = false;
    let reportRef = null; let recoveryReady = false; let enabled = false; const dialogs = new Set();
    let taskDialog = null; let taskFocus = null; let showDialogProgress = true;
    const oldDisabled = new Map();
    function node(tag, text, className) { const item = doc.createElement(tag); if (text !== undefined) item.textContent = text;
      if (className) item.className = className; return item; }
    function button(text, work, className = 'secondary-btn') { const item = node('button', text, className); item.type = 'button';
      item.addEventListener('click', () => { if (busy && item !== cancelButton) return; Promise.resolve().then(work).catch(showError); }); return item; }
    function field(label, control) { const wrap = node('label', undefined, 'bizop-field'); wrap.append(node('span', label), control); return wrap; }
    function select(options) { const item = node('select', undefined, 'vcc-fin-op-input'); for (const [value, text] of options) { const option = node('option', text); option.value = value; item.append(option); } return item; }
    function dateField() { const item = node('input', undefined, 'vcc-fin-op-input'); item.type = 'date'; return item; }
    function message(text, tone = 'info') {
      statusText.textContent = text; status.dataset.tone = tone;
      if (taskDialog && showDialogProgress) { taskDialog.feedback.textContent = text; taskDialog.feedback.dataset.tone = tone; }
    }
    function updateFooter() { footer.hidden = ![...footer.children].some((item) => !item.hidden); }
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
    function setBusy(value, importing = false) {
      busy = value;
      if (value) {
        taskDialog = [...dialogs].filter((dialog) => dialog.open).at(-1) || null;
        taskFocus = doc.activeElement;
        if (!showDialogProgress && taskDialog) taskDialog.feedback.textContent = '';
        if (importing && !taskDialog) {
          importButton.hidden = true; cancelButton.textContent = '取消导入';
          actionPair.insertBefore(cancelButton, importButton);
        } else {
          // showModal 会让弹窗外的控件失去交互能力；取消必须在当前最上层弹窗中。
          cancelButton.textContent = taskDialog ? '取消' : '取消当前操作';
          cancelButton.classList.toggle('small', Boolean(taskDialog));
          (taskDialog?.footer.querySelector('.bizop-cancel-slot') || taskDialog?.footer.querySelector('.bizop-modal-actions') || taskDialog?.footer || footer).append(cancelButton);
        }
      }
      for (const element of [panel, ...dialogs].flatMap((scope) => [...scope.querySelectorAll('button,input,select')])) {
        if (element === cancelButton) continue;
        if (value) { if (!oldDisabled.has(element)) oldDisabled.set(element, element.disabled); element.disabled = true; }
        else if (oldDisabled.has(element)) { element.disabled = oldDisabled.get(element); oldDisabled.delete(element); }
      }
      cancelButton.hidden = !value; cancelButton.disabled = false;
      cancelButton.setAttribute('aria-label', value && importing ? '取消导入' : '取消当前操作');
      if (value) { updateFooter(); cancelButton.focus(); }
      else {
        footer.append(cancelButton); cancelButton.textContent = '取消当前操作'; cancelButton.classList.remove('small'); importButton.hidden = false; taskDialog = null;
        if (taskFocus?.isConnected && !taskFocus.disabled) taskFocus.focus();
        taskFocus = null;
      }
      updateFooter();
    }
    async function perform(label, work, { dialogProgress = true } = {}) {
      if (busy) return null;
      showDialogProgress = dialogProgress;
      activeRequest = `ui-${root.crypto.randomUUID()}`; cancelRequested = false;
      setBusy(true, label === '导入文件'); message(`${label}，正在等待后台处理…`);
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
    function modal(title, className = '') {
      const dialog = node('dialog', undefined, `bizop-v327-dialog vcc-fin-op-dialog ${className}`.trim());
      dialog.setAttribute('aria-label', title);
      const header = node('div', undefined, 'dialog-header'); const heading = node('h2', title, 'dialog-title');
      const dismiss = button('×', () => dialog.close(), 'icon-close'); dismiss.setAttribute('aria-label', '关闭'); header.append(heading, dismiss);
      const body = node('div', undefined, 'bizop-modal-body vcc-fin-op-dialog-body'); const feedback = node('p', '', 'bizop-feedback'); feedback.setAttribute('role', 'status');
      const footer = node('div', undefined, 'bizop-modal-footer dialog-actions right'); const close = button('关闭', () => dialog.close());
      footer.append(close); dialog.append(header, body, feedback, footer); dialog.feedback = feedback; dialog.body = body; dialog.footer = footer;
      dialog.addEventListener('cancel', (event) => { if (busy) event.preventDefault(); });
      dialog.addEventListener('close', () => { dialogs.delete(dialog); dialog.remove(); }); dialogs.add(dialog);
      doc.body.append(dialog); dialog.showModal(); return dialog;
    }
    function table(headers, rows, className = '') {
      const scroll = node('div', undefined, 'bizop-table-scroll vcc-fin-op-table-wrap'); const table = node('table', undefined, `vcc-fin-op-table ${className}`.trim()); const thead = node('thead'); const tr = node('tr');
      headers.forEach((name) => tr.append(node('th', name))); thead.append(tr); const tbody = node('tbody');
      for (const values of rows) { const row = node('tr'); for (const value of values) { const cell = node('td'); cell.append(value?.nodeType ? value : node('span', value ?? '')); row.append(cell); } tbody.append(row); }
      if (!rows.length) { const row = node('tr'); const cell = node('td', '该操作月份没有可用数据'); cell.colSpan = headers.length; row.append(cell); tbody.append(row); }
      table.append(thead, tbody); scroll.append(table); return scroll;
    }
    async function exportObject(outputKind, objectId) {
      const result = await perform('导出文件', async (requestId, cancelled) => {
        const picked = checked(await api.pickExport({ outputKind, objectId }));
        if (picked.status === 'cancelled' || cancelled()) return { status: 'cancelled' };
        return checked(await api.exportWorkbook(outputKind, { requestId, selectionRef: picked.selectionRef }));
      }, { dialogProgress: outputKind !== 'RESULT_FULL' });
      const originalNames = { RESULT_FULL: '结果原表', OP_RAW: 'OP 校验原表', FLOW_RAW: '流水校验原表' };
      if (result?.status === 'ok' && originalNames[outputKind]) {
        const notice = modal('导出成功', 'vcc-fin-op-message-dialog bizop-export-success-dialog');
        notice.body.append(node('p', `${originalNames[outputKind]}导出成功。`));
        if (result.pendingArchiveHandoff || result.cleanupPending) notice.body.append(node('p', '文件已导出，仍有归档或收尾待完成，请查看任务记录。'));
        notice.footer.firstChild.textContent = '确定'; notice.footer.firstChild.focus();
      }
      return result;
    }
    async function importFiles() {
      await perform('导入文件', async (requestId, cancelled) => {
        const picked = checked(await api.pickFiles());
        if (picked.status === 'cancelled' || cancelled()) return { status: 'cancelled' };
        return await api.importFiles({ requestId, selectionRef: picked.selectionRef });
      });
    }
    function openRun() {
      const dialog = modal('开始运行', 'bizop-run-dialog'); const start = dateField(); const end = dateField();
      const fields = node('div', undefined, 'bizop-run-fields'); fields.append(field('起始日期', start), field('终止日期', end));
      async function openCalendar(input, label) {
        const picker = modal(`选择${label}`, 'bizop-calendar-dialog'); picker.footer.firstChild.textContent = '取消';
        let version = 0;
        async function load(selectedMonth) {
          const ownVersion = ++version; picker.body.replaceChildren(node('p', '正在读取可选日期…'));
          try {
            const data = checked(await api.runCalendar(selectedMonth ? { month: selectedMonth } : {}));
            if (!picker.open || version !== ownVersion) return;
            picker.feedback.textContent = '';
            if (!data.month) { picker.body.replaceChildren(node('p', '暂无可用 OP 数据，请先导入文件。')); return; }
            const [year, month] = data.month.split('-').map(Number);
            const caption = node('strong', `${year} 年 ${month} 月`); const nav = node('div', undefined, 'bizop-calendar-nav');
            const previous = button('‹', () => load(data.previousMonth)); previous.setAttribute('aria-label', '上个有数据月份'); previous.disabled = !data.previousMonth;
            const next = button('›', () => load(data.nextMonth)); next.setAttribute('aria-label', '下个有数据月份'); next.disabled = !data.nextMonth;
            nav.append(previous, caption, next);
            const grid = node('div', undefined, 'bizop-calendar-grid'); grid.setAttribute('role', 'group'); grid.setAttribute('aria-label', caption.textContent);
            for (const weekday of ['日', '一', '二', '三', '四', '五', '六']) grid.append(node('span', weekday, 'bizop-calendar-weekday'));
            const first = new Date(`${data.month}-01T00:00:00Z`); const last = new Date(first); last.setUTCMonth(last.getUTCMonth() + 1); last.setUTCDate(0);
            for (let offset = 0; offset < first.getUTCDay(); offset += 1) grid.append(node('span'));
            const allowed = new Set(data.dates);
            for (let day = 1; day <= last.getUTCDate(); day += 1) {
              const date = `${data.month}-${String(day).padStart(2, '0')}`;
              const choose = button(String(day), () => {
                if (!allowed.has(date)) return;
                input.value = date; input.dispatchEvent(new root.Event('change')); picker.close(); input.focus();
              }, 'bizop-calendar-day');
              choose.dataset.date = date; choose.setAttribute('aria-label', date); choose.setAttribute('aria-pressed', String(input.value === date));
              choose.disabled = !allowed.has(date); grid.append(choose);
            }
            picker.body.replaceChildren(nav, grid);
            grid.querySelector('button[aria-pressed="true"]:not(:disabled),button:not(:disabled)')?.focus();
          } catch (error) {
            if (!picker.open || version !== ownVersion) return;
            picker.body.replaceChildren(button('重新读取日期', () => load(selectedMonth))); showError(error);
          }
        }
        await load();
      }
      for (const [input, label] of [[start, '起始日期'], [end, '终止日期']]) {
        input.readOnly = true; input.setAttribute('aria-label', label); input.setAttribute('aria-haspopup', 'dialog');
        input.addEventListener('click', () => { if (!busy) openCalendar(input, label).catch(showError); });
        input.addEventListener('keydown', (event) => {
          if (['Enter', ' ', 'ArrowDown'].includes(event.key) && !busy) { event.preventDefault(); openCalendar(input, label).catch(showError); }
        });
      }
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
          dialog.feedback.textContent = ''; run.disabled = false;
        } finally { precheck.disabled = false; }
      });
      for (const item of [start, end]) item.addEventListener('change', () => { preflightVersion += 1; preflight = null; run.disabled = true; details.replaceChildren(); });
      dialog.body.append(fields, details);
      const actions = node('div', undefined, 'bizop-modal-actions'); actions.append(run, dialog.footer.firstChild);
      const checks = node('div', undefined, 'bizop-modal-actions'); checks.append(precheck, node('div', undefined, 'bizop-cancel-slot'));
      dialog.footer.replaceChildren(checks, actions);
    }
    async function latestMonth() { const result = checked(await api.months({ limit: 1 })); return result.months[0] || new Date().toISOString().slice(0, 7); }
    async function openResults() {
      const dialog = modal('导出校验结果表', 'vcc-fin-op-export-dialog bizop-results-dialog'); const month = node('input', undefined, 'vcc-fin-op-input'); month.type = 'month'; month.value = await latestMonth();
      const choice = select([['', '请选择结果表']]); const next = button('下一页', () => load(cursor)); let cursor = null; let generation; let loadVersion = 0;
      const exportBtn = button('导出', async () => { if (!choice.value) throw new Error('请先选择结果表');
        if ((await exportObject('RESULT_DIFF', choice.value))?.status === 'ok') dialog.close(); }, 'primary-btn');
      async function load(after = null) {
        const version = ++loadVersion;
        choice.replaceChildren(); exportBtn.disabled = true; next.disabled = true;
        const data = checked(await api.list({ view: 'RESULT', operationMonth: month.value, limit: 200,
          ...(after ? { cursor: after, generation } : {}) }));
        if (version !== loadVersion) return;
        choice.replaceChildren(); choice.append(Object.assign(node('option', data.rows.length ? '请选择结果表' : '该月份没有结果表'), { value: '' }));
        for (const row of data.rows) choice.append(Object.assign(node('option', row.tableName), { value: row.objectId }));
        generation = data.generation; cursor = data.nextCursor; next.hidden = !cursor; next.disabled = !cursor; exportBtn.disabled = !data.rows.length;
      }
      month.addEventListener('change', () => load().catch(showError));
      const fields = node('div', undefined, 'bizop-result-fields'); fields.append(field('操作月份', month), field('结果表表名', choice));
      const actions = node('div', undefined, 'bizop-modal-actions'); actions.append(exportBtn, dialog.footer.firstChild);
      dialog.body.append(fields, next); dialog.footer.replaceChildren(node('div', undefined, 'bizop-cancel-slot'), actions); await load();
    }
    function openInputExport({ initialKind = 'OP_RAW' } = {}) {
      const dialog = modal('导出数据', 'vcc-fin-op-export-dialog bizop-results-dialog bizop-input-export-dialog'); const kind = select([['OP_RAW', 'OP 原表'], ['OP_CHECK', 'OP 校验表'], ['FLOW_RAW', '流水原表'], ['FLOW_CHECK', '流水校验表']]);
      kind.value = initialKind;
      const date = dateField(); const fields = node('div', undefined, 'bizop-result-fields bizop-input-export-fields'); fields.append(field('账期', date), field('导出目标', kind));
      dialog.body.append(fields);
      const back = dialog.footer.firstChild; back.textContent = '返回';
      const actions = node('div', undefined, 'bizop-modal-actions'); actions.append(button('导出', async () => {
        const current = checked(await api.currentInput({ kind: kind.value.split('_')[0], dataDate: date.value }));
        if ((await exportObject(kind.value, current.objectId))?.status === 'ok') dialog.close();
      }, 'primary-btn'), back);
      dialog.footer.replaceChildren(node('div', undefined, 'bizop-cancel-slot'), actions);
    }
    async function showDelete(selection, refresh) {
      const preview = checked(await api.deletePreview(selection)); const dialog = modal('确认删除影响', 'bizop-delete-dialog');
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
      const dialog = modal('数据管理', 'vcc-fin-op-manager-dialog bizop-manager-dialog');
      const month = node('input', undefined, 'vcc-fin-op-input'); month.type = 'month'; month.value = await latestMonth();
      let view = 'RESULT'; const titles = { RESULT: '结果表', CHECK: '校验表', RAW: '校验原表' };
      const kind = select([['OP', 'OP'], ['FLOW', '流水']]);
      const layout = node('div', undefined, 'position-manager-layout vcc-fin-op-manager-layout');
      const nav = node('nav', undefined, 'position-manager-nav vcc-fin-op-manager-nav'); nav.setAttribute('aria-label', '数据分类');
      const pane = node('section', undefined, 'position-manager-pane vcc-fin-op-manager-pane');
      const toolbar = node('div', undefined, 'vcc-fin-op-manager-toolbar'); const title = node('h3', titles[view]);
      const filters = node('div', undefined, 'bizop-manager-filters');
      const monthField = node('label'); monthField.append(node('span', '操作月份'), month);
      const kindField = node('label'); kindField.append(node('span', '输入类型'), kind);
      filters.append(kindField, monthField); toolbar.append(title, filters);
      let rows = []; let generation; let loadVersion = 0; let selecting = false; let loading = false;
      let pageCursors = [null]; let currentPage = 0; const selection = new Set(); const content = node('div');
      content.className = 'vcc-fin-op-manager-content';
      const choose = button('删除', () => { selecting = !selecting; selection.clear(); render(); }, 'secondary-btn small');
      const pageChoice = select([]); pageChoice.setAttribute('aria-label', '数据页码');
      const pageField = field('页码', pageChoice); pageField.classList.add('bizop-page-choice');
      pageChoice.addEventListener('change', () => { if (!busy) load(Number(pageChoice.value)).catch(showError); });
      const del = button('删除', () => { if (!selection.size) throw new Error('请先选取要删除的数据'); return showDelete(
        view === 'RESULT' ? { runIds: [...selection] } : { datasetIds: [...selection] }, () => load()); }, 'primary-btn small bizop-danger');
      for (const [value, label] of Object.entries(titles)) {
        const item = button(label, () => {
          if (view === value) return;
          view = value; selecting = false; return load();
        }, 'position-nav-item'); item.dataset.view = value; nav.append(item);
      }
      function render() {
        const isResult = view === 'RESULT'; const raw = view === 'RAW'; kind.disabled = isResult; kindField.hidden = isResult; del.hidden = !selecting;
        choose.textContent = selecting ? '取消选取' : '删除'; choose.disabled = loading;
        title.textContent = titles[view];
        for (const item of nav.children) { const active = item.dataset.view === view; item.classList.toggle('active', active); item.setAttribute('aria-current', active ? 'page' : 'false'); }
        const headers = isResult ? ['起始日期', '终止日期', '表名', '结果版本', '更新时间', '操作'] : raw ? ['账期', '原表类型', '来源文件', '导入时间', '版本'] : ['账期', '表名', '版本', '生成时间'];
        const cells = rows.map((row) => {
          const values = isResult ? [row.startDate, row.endDate, row.tableName, `v${row.version}`, row.updatedAt.replace('T', ' ').replace('Z', ' UTC'), button('导出原表', () => exportObject('RESULT_FULL', row.objectId), 'vcc-fin-op-link-btn')]
            : raw ? [row.dataDate, row.kind === 'OP' ? 'OP 原表' : '流水原表', row.originalName, row.updatedAt.replace('T', ' ').replace('Z', ' UTC'), `v${row.version}`]
              : [row.dataDate, row.tableName, `v${row.version}`, row.updatedAt.replace('T', ' ').replace('Z', ' UTC')];
          if (selecting) { const check = node('input'); check.type = 'checkbox'; check.checked = selection.has(row.objectId);
            check.setAttribute('aria-label', `选取 ${row.tableName}`); check.addEventListener('change', () => { if (check.checked) selection.add(row.objectId); else selection.delete(row.objectId); render(); }); values.unshift(check); }
          return values;
        });
        if (selecting) headers.unshift('选取'); content.replaceChildren(table(headers, cells, isResult ? 'vcc-fin-op-manager-result-table' : ''));
        pageChoice.replaceChildren(...pageCursors.map((_, index) => Object.assign(node('option', `第 ${index + 1} 页`), { value: String(index) })));
        pageChoice.value = String(currentPage); pageChoice.disabled = loading; pageField.hidden = pageCursors.length <= 1;
        del.disabled = !selection.size;
      }
      async function load(pageIndex = null) {
        const version = ++loadVersion;
        if (pageIndex === null) { pageCursors = [null]; currentPage = 0; generation = undefined; }
        const requestedPage = pageIndex ?? 0;
        rows = []; selection.clear(); loading = true; render();
        try {
          const data = checked(await api.list({ view, kind: kind.value, operationMonth: month.value, limit: 200,
            ...(pageIndex !== null ? { cursor: pageCursors[requestedPage], generation } : {}) }));
          if (version !== loadVersion) return;
          rows = data.rows; generation = data.generation; currentPage = requestedPage;
          if (data.nextCursor) pageCursors[requestedPage + 1] = data.nextCursor;
          else pageCursors.length = requestedPage + 1;
        } catch (error) {
          if (version !== loadVersion) return;
          if (pageIndex !== null && error.result?.code === 'BIZOP_GENERATION_CHANGED') {
            await load(); dialog.feedback.textContent = '数据已变化，已重新载入第一页，请重新选取。'; return;
          }
          throw error;
        } finally { if (version === loadVersion) { loading = false; render(); } }
      }
      for (const item of [month, kind]) item.addEventListener('change', () => load().catch(showError));
      pane.append(toolbar, content); layout.append(nav, pane); dialog.body.append(layout);
      const paging = node('div', undefined, 'vcc-fin-op-manager-footer-left'); paging.append(pageField, node('div', undefined, 'bizop-cancel-slot'));
      const actions = node('div', undefined, 'vcc-fin-op-manager-footer-right');
      actions.append(choose, del, button('导出', () => openInputExport({ initialKind: view === 'RESULT' ? 'OP_RAW' : `${kind.value}_${view}` }), 'secondary-btn small'), button('返回', () => dialog.close(), 'secondary-btn small'));
      dialog.footer.classList.add('vcc-fin-op-manager-footer'); dialog.footer.replaceChildren(paging, actions);
      await load();
    }
    panel.classList.remove('pending-board'); panel.classList.add('acquiring-bill-currency-board', 'bizop-v327-board');
    const status = node('div', undefined, 'status-box bizop-status'); status.setAttribute('role', 'status');
    const statusContent = node('span', undefined, 'status-box-content'); const statusText = node('span', '欢迎使用小助手', 'status-box-text'); statusContent.append(statusText); status.append(statusContent);
    const importButton = button('导入文件', importFiles); const runButton = button('开始运行', openRun, 'primary-btn');
    const resultButton = button('导出校验结果表', openResults); const managerButton = button('数据管理', openManager);
    const reportButton = button('导出错误报告', () => exportObject('ERRORS', reportRef)); reportButton.hidden = true;
    const retry = button('重试恢复', async () => {
      const result = await perform('恢复检查', async () => { const state = await api.retryRecovery(); return { status: state.ready ? 'ok' : 'error', message: state.ready ? '恢复已完成' : '仍有未决任务或文件，请查看任务详情后重试' }; });
      if (result?.status === 'ok') await refreshStatus(true);
    });
    const cancelButton = button('取消当前操作', async () => {
      if (!activeRequest || cancelRequested) return;
      const requestId = activeRequest; cancelRequested = true; cancelButton.disabled = true;
      try {
        const result = checked(await api.cancel({ requestId }));
        if (activeRequest !== requestId) return;
        message(result.message || '已请求取消，正在等待后台任务退出', 'warning');
      } catch (error) {
        if (activeRequest !== requestId) return;
        cancelRequested = false; cancelButton.disabled = false; throw error;
      }
    }); cancelButton.hidden = true; cancelButton.setAttribute('aria-label', '取消当前操作');
    const actionPair = node('div', undefined, 'pending-action-pair'); actionPair.append(importButton, runButton);
    for (const [left, right] of [[actionPair, resultButton], [status, managerButton]]) {
      const row = node('div', undefined, 'control-row'); const leftCell = node('div', undefined, 'cell left'); const rightCell = node('div', undefined, 'cell right');
      leftCell.append(left); rightCell.append(right); row.append(leftCell, rightCell); panel.append(row);
    }
    const footer = node('div', undefined, 'bizop-toolbar bizop-secondary'); footer.append(reportButton, retry, cancelButton);
    panel.append(footer);
    async function refreshStatus(show = true) {
      if (!api) return;
      try {
        const info = await api.status(); enabled = info.mode === 'ACTIVE'; recoveryReady = info.recoveryReady === true;
        if (!busy) for (const btn of [importButton, runButton, resultButton, managerButton, reportButton]) btn.disabled = !enabled || !recoveryReady;
        retry.hidden = recoveryReady; retry.disabled = !enabled || busy;
        updateFooter();
        if (show && !enabled) message('新区间功能正在准备，完成恢复与升级后开放入口', 'warning');
        else if (show && !recoveryReady) message('存在未决任务或文件，完成恢复后可继续操作', 'warning');
        else if (show) message('欢迎使用小助手');
        return info;
      } catch (error) { enabled = false; for (const btn of [importButton, runButton, resultButton, managerButton, reportButton]) btn.disabled = true; showError(error); return null; }
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
