(function installAcquiringController(root) {
  'use strict';
function formatAcquiringBillCurrencyProgress(ev) {
  if (!ev || !ev.phase) return '';
  if (ev.phase === 'import') {
    if (ev.stage === 'reading') {
      const i = (typeof ev.fileIndex === 'number') ? ev.fileIndex + 1 : '?';
      const n = ev.fileCount || '?';
      const file = ev.filePath ? String(ev.filePath).split(/[\\/]/).pop() : '?';
      return `正在导入 ${file} 文件 (${i}/${n} 个文件)`;
    }
    if (ev.stage === 'inserting') {
      const i = (typeof ev.fileIndex === 'number') ? ev.fileIndex + 1 : '?';
      const n = ev.fileCount || '?';
      const file = ev.sourceFile || '?';
      const c = (ev.importedCount || 0).toLocaleString();
      return `正在写入 ${file}：已读取 ${c} 行 (${i}/${n} 个文件)`;
    }
    return '';
  }
  if (ev.phase === 'run') {
    switch (ev.stage) {
      case 'clearing-old-runs': return '正在清理该月历史结果...';
      case 'computing-stats':   return '正在统计数据量...';
      case 'inserting-run':     return '正在初始化对账批次...';
      case 'sql-joining':       return '正在比对币种（耗时较长，请稍候）...';
      case 'writing-xlsx':      return '正在写入差异 Excel 文件...';
      case 'updating-paths':    return '正在收尾结果文件...';
      default: return `运行中：${ev.stage}`;
    }
  }
  return '';
}


  function createAcquiringController({ api = {}, panel, ui = {} } = {}) {
    if (!panel || !ui.modalHost || !ui.modalBridge) throw new TypeError('收单币种控制器缺少领域依赖');
    const owner = 'acquiring-bill-currency';
    const elements = Object.fromEntries(['acquiringBillCurrencyStatusBox', 'acquiringBillCurrencyImportFlowBtn',
      'acquiringBillCurrencyImportBillBtn', 'acquiringBillCurrencyRunBtn', 'acquiringBillCurrencyExportBtn']
      .map((id) => [id, panel.querySelector(`#${id}`)]));
    const state = { latestMonth: null, inflightOperation: null, months: [], session: null };
    let active = false;
    let disposed = false;
    let generation = 0;
    let monthsRequest = 0;
    let statusRequest = 0;
    let choosing = false;
    let needsRefresh = true;
    let feedback = { text: '欢迎使用小助手', tone: 'info' };
    const removers = [];
    const modalHandles = new Set();
    const subscriptions = new Set();
    const live = (version = generation) => active && !disposed && version === generation;
    const reportError = (error) => ui.reportError?.(error);
    function render() {
      if (!live()) return;
      const box = elements.acquiringBillCurrencyStatusBox;
      if (box) {
        if (ui.status) ui.status(box, feedback.text, feedback.tone);
        else { box.textContent = feedback.text; box.dataset.tone = feedback.tone; }
      }
      for (const [id, element] of Object.entries(elements)) {
        if (id.endsWith('Btn') && element) element.disabled = !!state.inflightOperation || choosing;
      }
    }
    function status(text, tone = 'info', version = generation) {
      if (disposed) return;
      feedback = { text, tone };
      if (live(version)) render(); else needsRefresh = true;
    }
    function subscribe(method, version) {
      let cancel;
      try {
        cancel = api[method]?.((event) => {
          const text = formatAcquiringBillCurrencyProgress(event);
          if (text && live(version)) status(text, 'info', version);
        });
      } catch (error) { reportError(error); }
      let removed = false;
      const remove = () => {
        if (removed) return;
        removed = true;
        subscriptions.delete(remove);
        try { if (typeof cancel === 'function') cancel(); } catch (error) { reportError(error); }
      };
      subscriptions.add(remove);
      return remove;
    }
    function pickMonth(actionLabel, version) {
      return new Promise((resolve) => {
        if (!live(version)) { resolve(null); return; }
        let settled = false;
        const settle = (value) => { if (!settled) { settled = true; resolve(value); } };
        try {
          const opened = ui.modalBridge.openModal(() => ui.createAcquiringBillCurrencyMonthPickerDialog({
            actionLabel, onConfirm: (value) => settle(value), onCancel: () => settle(null)
          }), { owner });
          if (opened.status !== 'opened') settle(null);
          else { modalHandles.add(opened.handle); opened.handle.closed.then(() => { modalHandles.delete(opened.handle); settle(null); }); }
        } catch (error) { reportError(error); settle(null); }
      });
    }
    async function action(kind, label, operation) {
      if (!live() || choosing || state.inflightOperation) return { status: 'blocked' };
      const version = generation;
      choosing = true;
      render();
      const monthKey = await pickMonth(label, version);
      choosing = false;
      if (!live(version)) { render(); return { status: 'stale' }; }
      if (!monthKey) { status(`已取消${label}`, 'info', version); return { status: 'cancelled' }; }
      state.inflightOperation = kind;
      render();
      try { await operation(monthKey, version); }
      finally {
        state.inflightOperation = null;
        if (!live(version)) needsRefresh = true;
        // 新一次 enter 自己读取事实，旧操作只保存完成反馈，不能写新一轮视图。
        if (live(version)) render();
        else if (live()) await enter();
      }
      return { status: 'completed' };
    }
    function importFile(kind) {
      const labelTable = kind === 'flow' ? '流水表' : '单据表';
      const apiCall = kind === 'flow' ? api.importFlow : api.importBill;
      return action('import', '导入', async (monthKey, version) => {
        status(`正在导入${labelTable}（${monthKey}）...`, 'info', version);
        const unsubscribe = subscribe('onImportProgress', version);
        try {
          const first = await apiCall({ monthKey });
          if (first.status === 'cancelled') { status('已取消导入', 'info', version); return; }
          if (first.status === 'error') {
            const detail = (first.detailLines || []).slice(0, 3).join('；');
            status(`${labelTable}导入失败：${first.message}${detail ? '（' + detail + '）' : ''}`, 'error', version);
            return;
          }
          let result = first;
          if (first.status === 'overwrite-required') {
            // 用户已离页时不弹确认，也不自动提交第二次覆盖 IPC。
            if (!live(version)) { status('已取消导入', 'info', version); return; }
            const ok = ui.confirmNative(
              `检测到月份 ${first.monthKey} 已有 ${first.existingCount} 行${labelTable}数据。\n` +
              `点击「确定」将先清空该月份的${labelTable}数据，再导入本次选择的 ${first.fileCount} 个文件。\n` +
              `（仅清单侧数据，不影响该月份对账历史 / 差异结果）\n\n继续？`
            );
            if (!ok) { status(`已取消覆盖导入（月份 ${first.monthKey} 数据保留）`, 'info', version); return; }
            status(`正在覆盖导入${labelTable}（${monthKey}）...`, 'info', version);
            result = await apiCall({ monthKey, preparedContextId: first.preparedContextId, confirmOverwrite: true });
            if (result.status === 'cancelled') { status('已取消导入', 'info', version); return; }
            if (result.status === 'error') {
              const detail = (result.detailLines || []).slice(0, 3).join('；');
              status(`${labelTable}覆盖导入失败：${result.message}${detail ? '（' + detail + '）' : ''}`, 'error', version);
              return;
            }
          }
          state.latestMonth = result.monthKey;
          const overwriteNote = result.overwritten ? `（已清旧 ${result.deletedCount} 行）` : '';
          status(`${labelTable}导入成功：月份 ${result.monthKey}，共 ${result.totalImported} 行${overwriteNote}`, 'success', version);
        } catch (error) { status(`${labelTable}导入异常：${error.message || error}`, 'error', version); }
        finally { unsubscribe(); }
      });
    }
    function run() {
      return action('run', '运行', async (monthKey, version) => {
        status(`正在对账（${monthKey}）...`, 'info', version);
        const unsubscribe = subscribe('onRunProgress', version);
        try {
          const result = await api.run({ monthKey });
          if (result.status !== 'success') { status(`对账失败：${result.message || ''}`, 'error', version); return; }
          state.latestMonth = monthKey;
          const diffNote = result.diffFilePath ? `\n差异表：${result.diffFilePath}` : '';
          const reportNote = result.reportFilePath ? `\n结果表：${result.reportFilePath}` : '';
          status(`对账完成（${monthKey}）：共 ${result.totalBillRows} 条，币种差异 ${result.mismatchRows} 条，未匹配 ${result.unmatchedRows} 条${diffNote}${reportNote}`, 'success', version);
        } catch (error) { status(`对账异常：${error.message || error}`, 'error', version); }
        finally { unsubscribe(); }
      });
    }
    function exportFile() {
      return action('export', '导出', async (monthKey, version) => {
        status(`正在导出差异表（${monthKey}）...`, 'info', version);
        try {
          const result = await api.export({ monthKey });
          if (result.status === 'cancelled') { status('已取消导出', 'info', version); return; }
          if (result.status !== 'success') { status(`导出失败：${result.message || ''}`, 'error', version); return; }
          status(`差异表已导出：${result.savedPath}`, 'success', version);
        } catch (error) { status(`导出异常：${error.message || error}`, 'error', version); }
      });
    }
    async function enter() {
      if (disposed) return { status: 'stale' };
      active = true;
      const version = ++generation;
      const monthsEpoch = ++monthsRequest;
      const statusEpoch = ++statusRequest;
      render();
      try {
        const [months, session] = await Promise.all([api.listMonths?.(), api.sessionStatus?.({ monthKey: state.latestMonth })]);
        if (!live(version) || monthsEpoch !== monthsRequest || statusEpoch !== statusRequest) return { status: 'stale' };
        state.months = Array.isArray(months) ? months : [];
        state.session = session || null;
        needsRefresh = false;
        render();
        return { status: 'ready' };
      } catch (error) {
        if (!live(version)) return { status: 'stale' };
        needsRefresh = true;
        status(`收单币种状态读取失败：${error.message || error}`, 'error', version);
        reportError(error);
        return { status: 'error' };
      }
    }
    function leave({ reason = 'navigation' } = {}) {
      if (ui.modalHost.closeOwner(owner, reason).status === 'blocked') return { status: 'blocked' };
      active = false;
      ++generation;
      return { status: 'left' };
    }
    function dispose() {
      if (disposed) return;
      disposed = true;
      active = false;
      ++generation;
      [...modalHandles].forEach((handle) => handle.dispose());
      removers.splice(0).forEach((remove) => remove());
      [...subscriptions].forEach((remove) => remove());
    }
    for (const [id, handler] of [['acquiringBillCurrencyImportFlowBtn', () => importFile('flow')],
      ['acquiringBillCurrencyImportBillBtn', () => importFile('bill')], ['acquiringBillCurrencyRunBtn', run],
      ['acquiringBillCurrencyExportBtn', exportFile]]) {
      const element = elements[id];
      const listener = () => { handler().catch(reportError); };
      element?.addEventListener('click', listener);
      removers.push(() => element?.removeEventListener('click', listener));
    }
    return Object.freeze({ enter, leave, dispose, importFlow: () => importFile('flow'), importBill: () => importFile('bill'),
      run, export: exportFile, invalidate() { needsRefresh = true; ++monthsRequest; ++statusRequest; },
      applyPreviewState({ text, tone = 'info' } = {}) { if (text !== undefined) status(text, tone); },
      getSnapshot: () => Object.freeze({ latestMonth: state.latestMonth, inflightOperation: state.inflightOperation, needsRefresh }) });
  }
  root.__acquiringController = Object.freeze({ createAcquiringController, formatAcquiringBillCurrencyProgress });
  if (typeof module !== 'undefined' && module.exports) module.exports = root.__acquiringController;
})(typeof window !== 'undefined' ? window : globalThis);
