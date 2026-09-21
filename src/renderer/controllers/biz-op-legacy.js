(function installBizOpLegacyController(root) {
  'use strict';
  function formatTimestamp() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  }
  function createBizOpLegacyController({ api = {}, panel, ui = {} } = {}) {
    if (!panel || !ui.modalHost || !ui.modalBridge) throw new TypeError('业务 OP 控制器缺少领域依赖');
    const owner = 'biz-op-recon';
    const elements = Object.fromEntries(['bizOpReconStatusBox', 'bizOpReconBuSelect', 'bizOpReconImportBtn',
      'bizOpReconRunBtn', 'bizOpReconExportBtn'].map((id) => [id, panel.querySelector(`#${id}`)]));
    const bizOpReconState = { buList: [], selectedBu: '', readyDates: [], successDates: [] };
    let active = false;
    let disposed = false;
    let generation = 0;
    let availabilityRequest = 0;
    let runDatesRequest = 0;
    let exportDatesRequest = 0;
    let needsRefresh = true;
    let feedback = { text: '欢迎使用小助手', tone: 'info' };
    const removers = [];
    const modalHandles = new Set();
    const live = (version = generation) => active && !disposed && version === generation;
    const reportError = (error) => ui.reportError?.(error);
    function render() {
      if (!live()) return;
      const box = elements.bizOpReconStatusBox;
      if (box) {
        if (ui.status) ui.status(box, feedback.text, feedback.tone, { idleTitle: '欢迎使用小助手' });
        else { box.textContent = feedback.text; box.dataset.tone = feedback.tone; }
      }
      if (elements.bizOpReconImportBtn) elements.bizOpReconImportBtn.disabled = false;
      if (elements.bizOpReconBuSelect) elements.bizOpReconBuSelect.disabled = false;
      if (elements.bizOpReconRunBtn) elements.bizOpReconRunBtn.disabled = !(bizOpReconState.selectedBu && bizOpReconState.readyDates.length);
      if (elements.bizOpReconExportBtn) elements.bizOpReconExportBtn.disabled = !(bizOpReconState.selectedBu && bizOpReconState.successDates.length);
    }
    function status(text, tone = 'info', version = generation) {
      if (disposed) return;
      feedback = { text, tone };
      if (live(version)) render(); else needsRefresh = true;
    }
    function alert(text, version) {
      if (live(version)) {
        const result = ui.modalBridge.openModal(() => ui.createAlertDialog(text), { owner });
        if (result.status === 'opened') { modalHandles.add(result.handle); result.handle.closed.then(() => modalHandles.delete(result.handle)); }
        return result;
      }
    }
function renderBizOpReconBuSelect() {
  const sel = elements.bizOpReconBuSelect;
  if (!sel) return;
  // 清空旧 options
  while (sel.firstChild) sel.removeChild(sel.firstChild);
  if (bizOpReconState.buList.length === 0) {
    // v2.1.3-fix1：buList 为空时仅 1 项空白 placeholder（option label 完全空白）
    const opt = panel.ownerDocument.createElement('option');
    opt.value = '';
    opt.textContent = '';
    sel.appendChild(opt);
    bizOpReconState.selectedBu = '';
    sel.value = '';
    return;
  }
  // v2.1.3-fix2.2：option label 仅 BU 名（去掉「（N 行）」附加值）
  // v2.1.3-fix2.3：buList 有数据时不再追加空白 placeholder（避免下拉空值项）
  for (const bu of bizOpReconState.buList) {
    const opt = panel.ownerDocument.createElement('option');
    opt.value = bu.buName;
    opt.textContent = bu.buName;
    sel.appendChild(opt);
  }
  // v2.1.3-fix2.3 smart preserve：
  //   - 若上次 selectedBu 仍在新 buList → 保留
  //   - 否则回到第一项（buList[0]）
  const stillExists = bizOpReconState.selectedBu
    && bizOpReconState.buList.some(b => b.buName === bizOpReconState.selectedBu);
  if (!stillExists) {
    bizOpReconState.selectedBu = bizOpReconState.buList[0].buName;
  }
  sel.value = bizOpReconState.selectedBu;
}


    async function refresh(version = generation) {
      if (!live(version)) { needsRefresh = true; return false; }
      const request = ++availabilityRequest;
      const selectedAtStart = bizOpReconState.selectedBu;
      try {
        const bus = await api.listBu();
        if (!live(version) || request !== availabilityRequest || selectedAtStart !== bizOpReconState.selectedBu) return false;
        bizOpReconState.buList = Array.isArray(bus) ? bus : [];
        renderBizOpReconBuSelect();
        const buName = bizOpReconState.selectedBu;
        const [ready, success] = buName ? await Promise.all([
          api.listReadyDates({ buName }), api.listSuccessDates({ buName })
        ]) : [[], []];
        if (!live(version) || request !== availabilityRequest || buName !== bizOpReconState.selectedBu) return false;
        bizOpReconState.readyDates = Array.isArray(ready) ? ready : [];
        bizOpReconState.successDates = Array.isArray(success) ? success : [];
        needsRefresh = false;
        render();
        return true;
      } catch (error) {
        if (!live(version) || request !== availabilityRequest) return false;
        bizOpReconState.readyDates = [];
        bizOpReconState.successDates = [];
        needsRefresh = true;
        status(`业务 OP 状态读取失败：${error.message || error}`, 'error', version);
        reportError(error);
        return false;
      }
    }
    function prompt(factory, options, version) {
      return new Promise((resolve) => {
        if (!live(version)) { resolve(null); return; }
        let settled = false;
        const settle = (value) => { if (!settled) { settled = true; resolve(value); } };
        try {
          const result = ui.modalBridge.openModal(() => factory({ ...options,
            onConfirm: (value = true) => settle(value), onCancel: () => settle(null)
          }), { owner });
          if (result.status !== 'opened') settle(null);
          else { modalHandles.add(result.handle); result.handle.closed.then(() => { modalHandles.delete(result.handle); settle(null); }); }
        } catch (error) { reportError(error); settle(null); }
      });
    }
    function failedImport(result, label, version) {
      if (result.status === 'error') {
        const detail = result.detailLines?.length ? '\n' + result.detailLines.join('\n') : '';
        status(`${label} 导入失败：${result.message}${detail}`, 'error', version);
        return true;
      }
      if (result.status === 'rejected') {
        const pathPart = result.errorReportPath ? `；失败报告：${result.errorReportPath}` : '';
        status(`${label} 校验失败：${result.errorRows.length} 行（整批拒绝）${pathPart}`, 'error', version);
        return true;
      }
      return false;
    }
    async function importFlowStage(version) {
      const date = await prompt(ui.createBizOpReconDatePickerDialog,
        { title: '选择流水对账单所属日期', defaultDate: ui.getBizOpReconDefaultDate() }, version);
      if (!date || !live(version)) return;
      const pickRes = await api.pickFlowFile({ date });
      if (!live(version)) return;
      if (!pickRes || pickRes.status === 'cancelled') { status(`${date}：已取消选择流水对账单文件`, 'info', version); return; }
      if (pickRes.status === 'error') { status(pickRes.message || '选择流水对账单文件失败', 'error', version); return; }
      const flowFiles = Array.isArray(pickRes.filePaths) && pickRes.filePaths.length > 0
        ? pickRes.filePaths : (pickRes.filePath ? [pickRes.filePath] : []);
      if (!flowFiles.length) { status(`${date}：未选择流水对账单文件`, 'info', version); return; }
      const fileCount = flowFiles.length;
      status(`正在导入流水对账单 ${date} 数据（${fileCount} 个文件，将替换该日期已有流水）...`, 'info', version);
      const result = await api.runFlowImport({ date, filePaths: flowFiles });
      if (failedImport(result, '流水对账单', version)) return;
      status(`流水对账单（${date}）已导入 ${fileCount} 个文件共 ${result.totalCount} 行`, 'success', version);
      await refresh(version);
    }
    async function importBizOpStage(version) {
      const date = await prompt(ui.createBizOpReconDatePickerDialog,
        { title: '选择业务OP所属日期', defaultDate: ui.getBizOpReconDefaultDate() }, version);
      if (!date || !live(version)) return;
      const pickRes = await api.pickBizOpFile({ date });
      if (!live(version)) return;
      if (!pickRes || pickRes.status === 'cancelled') { status(`${date}：已取消选择业务OP文件`, 'info', version); return; }
      if (pickRes.status === 'error') { status(pickRes.message || '选择业务OP文件失败', 'error', version); return; }
      status(`正在导入业务OP ${date} 数据...`, 'info', version);
      const result = await api.runBizOpImport({ date, filePath: pickRes.filePath });
      if (failedImport(result, '业务OP', version)) return;
      status(`业务OP（${date} / BU=${result.buName}）已导入 ${result.validCount} 行`, 'success', version);
      await refresh(version);
      if (!live(version)) return;
      const single = await api.checkSingleDay({ buName: result.buName });
      if (!live(version)) return;
      if (single?.onlyOneDay) {
        const confirmed = await prompt(ui.createBizOpReconSecondImportPromptDialog, { firstDate: date }, version);
        if (!live(version)) return;
        if (confirmed) return importBizOpStage(version);
        status(`已导入第 1 日数据（${date} / BU=${result.buName}），待手动再次点击导入。`, 'info', version);
        return;
      }
      return importFlowStage(version);
    }
    async function importFiles() {
      if (!live()) return { status: 'stale' };
      const version = generation;
      try { await importBizOpStage(version); }
      catch (error) { status(`导入异常：${error.message || error}`, 'error', version); reportError(error); }
      return { status: live(version) ? 'completed' : 'stale' };
    }
    async function run() {
      if (!live()) return;
      const version = generation;
      const request = ++runDatesRequest;
      const buName = bizOpReconState.selectedBu;
      if (!buName) { alert('请先在下拉框中选择 BU。', version); return; }
      try {
        const readyDates = await api.listReadyDates({ buName });
        if (!live(version) || request !== runDatesRequest || buName !== bizOpReconState.selectedBu) return;
        if (!readyDates?.length) {
          alert(`BU=${buName} 暂无可对账日期。需要同时导入：T-1 业务OP + T-2 业务OP + T-1 流水对账单（同 BU），三件齐才会显示在此处。`, version);
          return;
        }
        const date = await prompt(ui.createBizOpReconReconcileDialog, { readyDates }, version);
        if (!date || !live(version)) return;
        status(`正在对账 ${buName} / ${date}...`, 'info', version);
        const result = await api.run({ date, buName });
        if (result.status === 'error') { status(`运行失败：${result.message}`, 'error', version); return; }
        const s = result.stats;
        const tone = (s.amountDiffCount > 0 || s.t1NotT2Count > 0 || s.t2NotT1Count > 0) ? 'info' : 'success';
        status(`${date} BU=${buName} 对账完成：测算金额差异 ${s.amountDiffCount} 笔 / T-1 有 T-2 无 ${s.t1NotT2Count} 笔 / T-2 有 T-1 无 ${s.t2NotT1Count} 笔 / 多 OP 账户 ${s.multiOpAccountCount} 个`
          + (s.t2AnomalyAccountCount > 0 ? ` / T-2 异常账户 ${s.t2AnomalyAccountCount} 个` : ''), tone, version);
        await refresh(version);
      } catch (error) { status(`运行失败：${error.message || error}`, 'error', version); reportError(error); }
    }
    async function exportFile() {
      if (!live()) return;
      const version = generation;
      const request = ++exportDatesRequest;
      const buName = bizOpReconState.selectedBu;
      if (!buName) { alert('请先在下拉框中选择 BU。', version); return; }
      try {
        const successDates = await api.listSuccessDates({ buName });
        if (!live(version) || request !== exportDatesRequest || buName !== bizOpReconState.selectedBu) return;
        if (!successDates?.length) { alert(`BU=${buName} 暂无可导出的成功运行记录。请先用「开始运行」对账。`, version); return; }
        const choice = await prompt(ui.createBizOpReconExportDialog, { successDates }, version);
        if (!choice || !live(version)) return;
        const ts = formatTimestamp();
        const compact = (value) => (value || '').replace(/-/g, '');
        const defaultFileName = choice.scope === 'single'
          ? `业务OP数据核对_${buName}_${compact(choice.date)}_${ts}.xlsx`
          : `业务OP数据核对_${buName}_${compact(choice.startDate)}-${compact(choice.endDate)}_${ts}.xlsx`;
        const pickRes = await api.pickSavePath({ defaultFileName });
        if (!live(version)) return;
        if (!pickRes || pickRes.status === 'cancelled') { status('已取消导出', 'info', version); return; }
        if (pickRes.status === 'error') { status(`选择保存路径失败：${pickRes.message}`, 'error', version); return; }
        const savePath = pickRes.savePath;
        status('正在导出差异表...', 'info', version);
        const result = choice.scope === 'single'
          ? await api.exportDate({ runId: choice.runId, savePath })
          : await api.exportDateRange({ buName, startDate: choice.startDate, endDate: choice.endDate, savePath });
        if (result.status !== 'success') { status(`导出失败：${result.message || '未知错误'}`, 'error', version); return; }
        status(`差异表已生成：${result.filePath}`, 'success', version);
        if (choice.scope === 'range' && Array.isArray(result.skippedDates) && result.skippedDates.length) {
          alert(`区间导出完成。${result.skippedDates.length} 个日期因未对账成功未包含在文件中：${result.skippedDates.join(', ')}`, version);
        }
      } catch (error) { status(`导出异常：${error.message || error}`, 'error', version); reportError(error); }
    }
    async function enter() {
      if (disposed) return { status: 'stale' };
      active = true;
      const version = ++generation;
      render();
      const refreshed = await refresh(version);
      return { status: !live(version) ? 'stale' : refreshed ? 'ready' : 'error' };
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
    }
    function selectBu(value) {
      if (!live()) return;
      bizOpReconState.selectedBu = String(value || '');
      bizOpReconState.readyDates = [];
      bizOpReconState.successDates = [];
      ++runDatesRequest;
      ++exportDatesRequest;
      render();
      return refresh();
    }
    for (const [id, event, handler] of [['bizOpReconImportBtn', 'click', importFiles], ['bizOpReconRunBtn', 'click', run],
      ['bizOpReconExportBtn', 'click', exportFile], ['bizOpReconBuSelect', 'change', (event) => selectBu(event.target.value)]]) {
      const element = elements[id];
      const listener = (event) => Promise.resolve(handler(event)).catch(reportError);
      element?.addEventListener(event, listener);
      removers.push(() => element?.removeEventListener(event, listener));
    }
    return Object.freeze({ enter, leave, dispose, importFiles, run, export: exportFile, selectBu,
      invalidate() { needsRefresh = true; ++availabilityRequest; ++runDatesRequest; ++exportDatesRequest; },
      applyPreviewState({ text, tone = 'info' } = {}) { if (text !== undefined) status(text, tone); },
      getSnapshot: () => Object.freeze({ selectedBu: bizOpReconState.selectedBu, needsRefresh }) });
  }
  root.__bizOpLegacyController = Object.freeze({ createBizOpLegacyController });
  if (typeof module !== 'undefined' && module.exports) module.exports = root.__bizOpLegacyController;
})(typeof window !== 'undefined' ? window : globalThis);
