'use strict';

(function installBankBuController(global) {
  // 从 renderer.js 原业务流程迁出；本域状态、DOM 与请求代次只在工厂闭包内保存。
  function createBankBuController({ api, panel, ui }) {
    if (!api || !panel || !ui?.modalHost || !ui.status || !ui.modalBridge) throw new TypeError('BankBu 控制器缺少领域依赖');

    const owner = 'bank-bu-recon';
    const domainApi = api;
    const elements = Object.fromEntries(['bankBuReconImportBtn','bankBuReconRunBtn','bankBuReconExportBtn','bankBuReconStatusBox'].map((id) => [id, panel.querySelector('#' + id)]));
    let active = false;
    let disposed = false;
    let renderGeneration = 0;
    let needsRefresh = true;
    const requests = Object.create(null);
    const modalHandles = new Set();
    const removers = [];
    const subscriptions = new Set();
    const live = (generation = renderGeneration) => active && !disposed && generation === renderGeneration;
    function updateStatusBox(element, message, tone, options) {
      if (!live() || !element) return;
      ui.status(element, message, tone, options);
    }
    function releaseSubscriptions() {
      for (const release of [...subscriptions]) {
        try { release(); } catch (error) { ui.reportError?.(error); }
      }
    }

    function openModal(factory) {
      if (!live()) return { status: 'stale' };
      const opened = ui.modalBridge.openModal(factory, { owner });
      if (opened.status === 'opened') {
        modalHandles.add(opened.handle);
        opened.handle.closed.then(() => modalHandles.delete(opened.handle));
      }
      return opened;
    }
    const createAlertDialog = (...args) => ui.alert(...args);
    function createScopedDialog(factory, options) {
      const generation = renderGeneration;
      const scoped = { ...options };
      for (const [name, callback] of Object.entries(options)) {
        if (name.startsWith('on') && typeof callback === 'function') {
          scoped[name] = (...args) => live(generation) ? callback(...args) : { status: 'stale' };
        }
      }
      return factory(scoped);
    }
    const createBankBuReconMonthPickerDialog = (options) => createScopedDialog(ui.createBankBuReconMonthPickerDialog, options);
    const createBankBuReconFileImportPromptDialog = (options) => createScopedDialog(ui.createBankBuReconFileImportPromptDialog, options);
    const createBankBuReconReconcileDialog = (options) => createScopedDialog(ui.createBankBuReconReconcileDialog, options);
    const createBankBuReconExportDialog = (options) => createScopedDialog(ui.createBankBuReconExportDialog, options);


    const bankBuReconState = {
      readyMonthsCount: 0,    // 两侧都已导入的月份数（决定「开始运行」是否亮）
      successMonthsCount: 0   // 至少 1 个 success run 的月份数（决定「导出差异」是否亮）
    };

    function setBankBuReconStatus(message, tone = 'info') {
      if (!elements.bankBuReconStatusBox) return;
      updateStatusBox(elements.bankBuReconStatusBox, message, tone, {
        idleTitle: '欢迎使用小助手'
      });
    }

    function applyBankBuReconButtonState() {
      if (!live()) return;
      // 「导入文件」永远 enabled（点击后弹月份对话框，PRD §3.2.5 数据流第一步）
      if (elements.bankBuReconImportBtn) elements.bankBuReconImportBtn.disabled = false;
      // 「开始运行」：至少 1 个月份两侧都已导入（OPEN ISSUE Q2 拍板 A）
      if (elements.bankBuReconRunBtn) elements.bankBuReconRunBtn.disabled = bankBuReconState.readyMonthsCount === 0;
      // 「导出差异」：至少 1 个 success run（OPEN ISSUE Q5 拍板 A）
      if (elements.bankBuReconExportBtn) elements.bankBuReconExportBtn.disabled = bankBuReconState.successMonthsCount === 0;
    }

    async function refreshBankBuReconButtonAvailability() {
      const viewGeneration = renderGeneration;
      const request = requests.availability = (requests.availability || 0) + 1;
      if (!live(viewGeneration) || request !== requests.availability) { needsRefresh = true; return { status: 'stale' }; }

      try {
        const [ready, success] = await Promise.all([
          domainApi.listReadyMonths(),
          domainApi.listSuccessMonths()
        ]);
        if (!live(viewGeneration) || request !== requests.availability) { needsRefresh = true; return { status: 'stale' }; }
        bankBuReconState.readyMonthsCount = Array.isArray(ready) ? ready.length : 0;
        bankBuReconState.successMonthsCount = Array.isArray(success) ? success.length : 0;
      } catch (_e) {
        if (!live(viewGeneration) || request !== requests.availability) { needsRefresh = true; return { status: 'stale' }; }

        bankBuReconState.readyMonthsCount = 0;
        bankBuReconState.successMonthsCount = 0;
        applyBankBuReconButtonState();
        setBankBuReconStatus(`状态读取失败：${_e?.message || String(_e)}`, 'error');
        ui.reportError?.(_e);
        return { status: 'error' };
      }
      applyBankBuReconButtonState();
    }


    async function handleBankBuReconImport() {
      const viewGeneration = renderGeneration;
      const request = requests.import = (requests.import || 0) + 1;
      if (!live(viewGeneration) || request !== requests.import) { needsRefresh = true; return { status: 'stale' }; }

      // PRD §3.2.5 数据流第一步：弹月份选择对话框（年+月两下拉，spec v0.3）
      openModal(() => createBankBuReconMonthPickerDialog({
        onConfirm: async (yearMonth) => {
          const viewGeneration = renderGeneration;
          const request = requests.confirmMonth = (requests.confirmMonth || 0) + 1;
          if (!live(viewGeneration) || request !== requests.confirmMonth) { needsRefresh = true; return { status: 'stale' }; }

          await pickFilesAndImport(yearMonth);
          if (!live(viewGeneration) || request !== requests.confirmMonth) { needsRefresh = true; return { status: 'stale' }; }
        },
        onCancel: () => {
          // 用户取消月份选择，状态栏不变
        }
      }));
    }

    async function pickFilesAndImport(yearMonth) {
      const viewGeneration = renderGeneration;
      const request = requests.pickFiles = (requests.pickFiles || 0) + 1;
      if (!live(viewGeneration) || request !== requests.pickFiles) { needsRefresh = true; return { status: 'stale' }; }

      // PRD §3.2.5 数据流第 2-3 步：前端 Clear 风 modal 提示 → 调 IPC 单选文件
      // 流程：[prompt 1] → [pick pending] → [prompt 2] → [pick bank] → [import:run]

      // === 步骤 1：Pending 数据管理文件 ===
      openModal(() => createBankBuReconFileImportPromptDialog({
        title: '请导入 Pending 数据管理文件',
        detail: `接下来弹出的文件选择对话框中，请选择对应的 xlsx 文件（对账月份 ${yearMonth}）。`,
        onConfirm: async () => {
          const viewGeneration = renderGeneration;
          const request = requests.pickPending = (requests.pickPending || 0) + 1;
          if (!live(viewGeneration) || request !== requests.pickPending) { needsRefresh = true; return { status: 'stale' }; }

          const pendingRes = await domainApi.pickPendingFile({ yearMonth });
          if (!live(viewGeneration) || request !== requests.pickPending) { needsRefresh = true; return { status: 'stale' }; }
          if (!pendingRes || pendingRes.status === 'cancelled') {
            setBankBuReconStatus(`${yearMonth}：已取消选择 Pending 数据管理文件`, 'info');
            return;
          }
          if (pendingRes.status === 'error') {
            setBankBuReconStatus(pendingRes.message || '选择 Pending 文件失败', 'error');
            return;
          }
          const pendingPath = pendingRes.filePath;

          // === 步骤 2：银行对账单文件 ===
          openModal(() => createBankBuReconFileImportPromptDialog({
            title: '请导入银行对账单文件',
            detail: `接下来弹出的文件选择对话框中，请选择对应的 xlsx 文件（对账月份 ${yearMonth}）。`,
            onConfirm: async () => {
              const viewGeneration = renderGeneration;
              const request = requests.pickBank = (requests.pickBank || 0) + 1;
              if (!live(viewGeneration) || request !== requests.pickBank) { needsRefresh = true; return { status: 'stale' }; }

              const bankRes = await domainApi.pickBankFile({ yearMonth });
              if (!live(viewGeneration) || request !== requests.pickBank) { needsRefresh = true; return { status: 'stale' }; }
              if (!bankRes || bankRes.status === 'cancelled') {
                setBankBuReconStatus(`${yearMonth}：已取消选择银行对账单文件`, 'info');
                return;
              }
              if (bankRes.status === 'error') {
                setBankBuReconStatus(bankRes.message || '选择银行对账单文件失败', 'error');
                return;
              }
              const bankPath = bankRes.filePath;

              // === 步骤 3：导入 ===
              setBankBuReconStatus(`正在导入 ${yearMonth} 数据...`, 'info');
              const impResult = await domainApi.runImport({
                yearMonth,
                pendingPath,
                bankPath
              });
              if (!live(viewGeneration) || request !== requests.pickBank) { needsRefresh = true; return { status: 'stale' }; }
              if (impResult.status === 'error') {
                const detail = impResult.detailLines && impResult.detailLines.length > 0
                  ? '\n' + impResult.detailLines.join('\n')
                  : '';
                setBankBuReconStatus(`导入失败：${impResult.message}${detail}`, 'error');
                return;
              }

              // 导入成功 → 刷新按钮可用性（readyMonths 可能新增此月）
              setBankBuReconStatus(
                `已导入 ${yearMonth}：Pending ${impResult.pendingCount} 行 / 银行对账单 ${impResult.bankCount} 行 — 点击「开始运行」对账`,
                'success'
              );
              await refreshBankBuReconButtonAvailability();
              if (!live(viewGeneration) || request !== requests.pickBank) { needsRefresh = true; return { status: 'stale' }; }
            },
            onCancel: () => {
              setBankBuReconStatus(`${yearMonth}：已取消导入`, 'info');
            }
          }));
        },
        onCancel: () => {
          setBankBuReconStatus(`${yearMonth}：已取消导入`, 'info');
        }
      }));
    }

    // v0.5: 「开始运行」流程 — 弹月份对话框 → 选月份 → 直接跑（无二次确认）
    async function handleBankBuReconRun() {
      const viewGeneration = renderGeneration;
      const request = requests.run = (requests.run || 0) + 1;
      if (!live(viewGeneration) || request !== requests.run) { needsRefresh = true; return { status: 'stale' }; }

      const readyMonths = await domainApi.listReadyMonths().catch(() => []);
      if (!live(viewGeneration) || request !== requests.run) { needsRefresh = true; return { status: 'stale' }; }
      if (!readyMonths || readyMonths.length === 0) {
        openModal(() => createAlertDialog('暂无可对账的月份。请先用「导入文件」按月份导入 Pending + 银行对账单两份源文件。'));
        return;
      }
      openModal(() => createBankBuReconReconcileDialog({
        readyMonths,
        defaultMonth: readyMonths[0],
        onConfirm: async (yearMonth) => {
          const viewGeneration = renderGeneration;
          const request = requests.confirmRun = (requests.confirmRun || 0) + 1;
          if (!live(viewGeneration) || request !== requests.confirmRun) { needsRefresh = true; return { status: 'stale' }; }

          setBankBuReconStatus(`正在对账 ${yearMonth}...`, 'info');
          const result = await domainApi.run({ yearMonth });
          if (!live(viewGeneration) || request !== requests.confirmRun) { needsRefresh = true; return { status: 'stale' }; }
          if (result.status === 'error') {
            setBankBuReconStatus(`运行失败：${result.message}`, 'error');
            return;
          }
          // v0.8: 永远 status=success（不再有 failed_anomaly 中断分支）
          const s = result.stats;
          const nmTail = s.nmAnomalyCount > 0 ? ` / N:M 异常 ${s.nmAnomalyCount} 组` : '';
          const tone = s.buDiffCount > 0 || s.nmAnomalyCount > 0 ? 'info' : 'success';
          setBankBuReconStatus(
            `${yearMonth} 对账完成：成功 ${s.matchedCount} 行 / BU 差异 ${s.buDiffCount} 行 / Pending 未匹上银行 ${s.pendingUnmatched} 行 / 银行未匹上 Pending ${s.bankUnmatched} 行${nmTail}`,
            tone
          );
          await refreshBankBuReconButtonAvailability();
          if (!live(viewGeneration) || request !== requests.confirmRun) { needsRefresh = true; return { status: 'stale' }; }
        },
        onCancel: () => {}
      }));
    }

    // v0.5: 「导出差异」流程 — 弹 export 弹窗 → radio (single/aggregate) → 弹另存为 → 写文件
    async function handleBankBuReconExport() {
      const viewGeneration = renderGeneration;
      const request = requests.export = (requests.export || 0) + 1;
      if (!live(viewGeneration) || request !== requests.export) { needsRefresh = true; return { status: 'stale' }; }

      const successMonths = await domainApi.listSuccessMonths().catch(() => []);
      if (!live(viewGeneration) || request !== requests.export) { needsRefresh = true; return { status: 'stale' }; }
      if (!successMonths || successMonths.length === 0) {
        openModal(() => createAlertDialog('暂无可导出的成功运行记录。请先用「开始运行」对账。'));
        return;
      }
      openModal(() => createBankBuReconExportDialog({
        successMonths,
        onConfirm: async (choice) => {
          const viewGeneration = renderGeneration;
          const request = requests.confirmExport = (requests.confirmExport || 0) + 1;
          if (!live(viewGeneration) || request !== requests.confirmExport) { needsRefresh = true; return { status: 'stale' }; }

          // 弹另存为对话框拿 savePath
          const ts = formatBbrTimestampForFilename();
          const defaultFileName = choice.scope === 'aggregate'
            ? `月度银行对账单BU回填校验_汇总_${ts}.xlsx`
            : `月度银行对账单BU回填校验_${(choice.yearMonth || '').replace('-', '')}_${ts}.xlsx`;
          const pickRes = await domainApi.pickSavePath({ defaultFileName });
          if (!live(viewGeneration) || request !== requests.confirmExport) { needsRefresh = true; return { status: 'stale' }; }
          if (!pickRes || pickRes.status === 'cancelled') {
            setBankBuReconStatus('已取消导出', 'info');
            return;
          }
          if (pickRes.status === 'error') {
            setBankBuReconStatus(`选择保存路径失败：${pickRes.message}`, 'error');
            return;
          }
          const savePath = pickRes.savePath;

          setBankBuReconStatus('正在导出差异表...', 'info');
          let result;
          if (choice.scope === 'single') {
            result = await domainApi.exportSingle({ runId: choice.runId, savePath });
            if (!live(viewGeneration) || request !== requests.confirmExport) { needsRefresh = true; return { status: 'stale' }; }
          } else {
            result = await domainApi.exportAggregate({ savePath });
            if (!live(viewGeneration) || request !== requests.confirmExport) { needsRefresh = true; return { status: 'stale' }; }
          }

          if (result.status !== 'success') {
            setBankBuReconStatus(`导出失败：${result.message || '未知错误'}`, 'error');
            return;
          }
          setBankBuReconStatus(`差异表已生成：${result.filePath}`, 'success');

          // 汇总场景：若有 skippedMonths，弹 alert 提示（OPEN ISSUE Q7 拍板 A）
          if (choice.scope === 'aggregate' && Array.isArray(result.skippedMonths) && result.skippedMonths.length > 0) {
            openModal(() => createAlertDialog(
              `汇总完成。${result.skippedMonths.length} 个月份因数据异常或未运行成功未包含在汇总中：${result.skippedMonths.join(', ')}`
            ));
          }
        },
        onCancel: () => {}
      }));
    }

    function formatBbrTimestampForFilename() {
      const d = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    }


    function bind(id, action) {
      const button = elements[id];
      if (!button) return;
      const listener = () => {
        if (!live() || button.disabled) return;
        Promise.resolve(action()).catch((error) => {
          if (live()) ui.reportError?.(error);
        });
      };
      button.addEventListener('click', listener);
      removers.push(() => button.removeEventListener('click', listener));
    }
    bind('bankBuReconImportBtn', handleBankBuReconImport);
    bind('bankBuReconRunBtn', handleBankBuReconRun);
    bind('bankBuReconExportBtn', handleBankBuReconExport);
    async function enter() {
      if (disposed) return { status: 'stale' };
      active = true;
      const generation = ++renderGeneration;
      applyBankBuReconButtonState();
      const result = await refreshBankBuReconButtonAvailability();
      if (!live(generation)) return { status: 'stale' };
      needsRefresh = result?.status === 'error' || result?.status === 'stale';
      return needsRefresh ? result : { status: 'ready' };
    }
    function leave() {
      if (disposed) return { status: 'left' };
      const closed = ui.modalHost.closeOwner(owner, 'navigation');
      if (closed?.status === 'blocked') return { status: 'blocked' };
      active = false;
      ++renderGeneration;
      needsRefresh = true;
      releaseSubscriptions();
      return { status: 'left' };
    }
    function invalidate() {
      needsRefresh = true;
      if (live()) return refreshBankBuReconButtonAvailability();
      return Promise.resolve({ status: 'stale' });
    }
    function dispose() {
      if (disposed) return;
      active = false;
      disposed = true;
      ++renderGeneration;
      // 最终销毁允许释放忙碌前端；已提交 Main 操作不被取消。
      for (const handle of modalHandles) if (handle.isOpen()) handle.dispose();
      modalHandles.clear();
      releaseSubscriptions();
      for (const remove of removers.splice(0)) remove();
    }
    return Object.freeze({
      enter, leave, invalidate, dispose,
      commands: Object.freeze({ import: handleBankBuReconImport, run: handleBankBuReconRun, export: handleBankBuReconExport })
    });

  }
  const exports = Object.freeze({ createBankBuController });
  global.__bankBuController = exports;
  if (typeof module !== 'undefined' && module.exports) module.exports = exports;
})(typeof window !== 'undefined' ? window : globalThis);
