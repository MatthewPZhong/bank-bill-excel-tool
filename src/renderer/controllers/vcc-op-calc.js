'use strict';

(function installVccOpCalcController(global) {
  // 从 renderer.js 原业务流程迁出；本域状态、DOM 与请求代次只在工厂闭包内保存。
  function createVccOpCalcController({ api, panel, ui }) {
    if (!api || !panel || !ui?.modalHost || !ui.status || !ui.modalBridge) throw new TypeError('VccOpCalc 控制器缺少领域依赖');

    const owner = 'vcc-op-calc';
    const domainApi = api;
    const elements = Object.fromEntries(['vccOpCalcImportBtn','vccOpCalcRunBtn','vccOpCalcShowBalanceBtn','vccOpCalcStatusBox'].map((id) => [id, panel.querySelector('#' + id)]));
    let active = false;
    let disposed = false;
    let renderGeneration = 0;
    let needsRefresh = true;
    // scan 会替换 Main 的唯一 compute snapshot。来源归属不能随导航 generation 丢失。
    let currentSource = null;
    let sourceOperation = null;
    let feedback = null;
    let pendingErrorReport = null;
    const requests = Object.create(null);
    const modalHandles = new Set();
    const removers = [];
    const subscriptions = new Set();
    const live = (generation = renderGeneration) => active && !disposed && generation === renderGeneration;
    function updateStatusBox(element, message, tone, options) {
      if (!live() || !element) return;
      ui.status(element, message, tone, options);
    }
    function subscribeProgress(method, listener) {
      const generation = renderGeneration;
      if (!live(generation) || typeof domainApi[method] !== 'function') return () => {};
      const unsubscribe = domainApi[method]((...args) => { if (live(generation)) listener(...args); });
      let ended = false;
      const release = () => {
        if (ended) return;
        ended = true;
        subscriptions.delete(release);
        if (typeof unsubscribe === 'function') unsubscribe();
      };
      subscriptions.add(release);
      return release;
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
    const createVccOpCalcConfirmDialog = (options) => createScopedDialog(ui.createVccOpCalcConfirmDialog, options);
    const createVccOpCalcComputeDialog = (options) => createScopedDialog(ui.createVccOpCalcComputeDialog, options);
    const createVccOpCalcShowBalanceDialog = (options) => createScopedDialog(ui.createVccOpCalcShowBalanceDialog, options);


    const vccOpCalcState = {
      scanned: false,          // scan + computeAmounts 成功（已统计完成但未落库）→「开始运行」亮
      balanceMonthsCount: 0,   // 已落库月份数（后端 listBalanceMonths().length）→「显示余额」亮
      yearMonth: '',           // F1/F2 展示用
      totalRows: 0,
      fileCount: 0,
      totals: null             // computeAmounts 返回的 totals（供 F2 展示）
    };

    function setVccOpCalcStatus(message, tone = 'info', generation = renderGeneration) {
      feedback = { message, tone };
      if (!live(generation) || !elements.vccOpCalcStatusBox) return;
      updateStatusBox(elements.vccOpCalcStatusBox, message, tone, {
        idleTitle: '欢迎使用小助手'
      });
    }

    function applyVccOpCalcButtonState() {
      if (!live()) return;
      if (elements.vccOpCalcImportBtn) elements.vccOpCalcImportBtn.disabled = !!sourceOperation;
      // 「开始运行」：已统计完成但未落库的当前会话才亮（spec §2.3）
      if (elements.vccOpCalcRunBtn) elements.vccOpCalcRunBtn.disabled = !!sourceOperation || !vccOpCalcState.scanned;
      // 「显示余额」：后端至少 1 条已计算月份
      if (elements.vccOpCalcShowBalanceBtn) elements.vccOpCalcShowBalanceBtn.disabled = vccOpCalcState.balanceMonthsCount === 0;
    }

    function clearSaveableSource() {
      currentSource = null;
      Object.assign(vccOpCalcState, { scanned: false, yearMonth: '', totalRows: 0, fileCount: 0, totals: null });
    }

    function snapshotKey(result) {
      const entries = (value) => Object.entries(value || {}).sort(([left], [right]) => left.localeCompare(right));
      // 这是现有 IPC 可见事实的核对值，不是文件身份。身份由本域独占的 scan 对象与操作锁维护。
      return JSON.stringify([result.yearMonth, entries(result.totals), (result.perFile || []).map(entries)]);
    }

    function startSourceOperation(kind) {
      if (!live() || sourceOperation) return null;
      const operation = { kind, generation: renderGeneration };
      sourceOperation = operation;
      applyVccOpCalcButtonState();
      return operation;
    }

    function renderSettledFeedback() {
      if (!live()) return;
      if (feedback) setVccOpCalcStatus(feedback.message, feedback.tone);
      if (pendingErrorReport) {
        const report = pendingErrorReport;
        pendingErrorReport = null;
        showVccOpCalcErrorReport(report.errorRows, report.errorCount);
      }
      applyVccOpCalcButtonState();
    }

    async function finishSourceOperation(operation) {
      if (sourceOperation !== operation) return;
      sourceOperation = null;
      needsRefresh = true;
      if (!live()) return;
      // A/B/A 中旧回调只结算领域事实；当前访问重新读取 Main，不能直接采用旧页面回包。
      if (!live(operation.generation)) {
        await refreshCurrentFacts();
      } else {
        renderSettledFeedback();
      }
    }

    async function readConfirmedSource(source) {
      const result = await domainApi.computeAmounts()
        .catch((error) => ({ status: 'error', message: error?.message || String(error) }));
      if (currentSource !== source || !source?.confirmed) return { status: 'stale' };
      if (result?.status !== 'success' || snapshotKey(result) !== source.key) {
        clearSaveableSource();
        const message = result?.status !== 'success'
          ? `统计状态读取失败：${result?.message || '无统计结果'}。请重新导入文件并确认。`
          : '统计来源已变化，请重新导入文件并确认。';
        return { status: 'error', message };
      }
      return { status: 'success' };
    }

    async function refreshCurrentFacts() {
      const generation = renderGeneration;
      const source = currentSource;
      let sourceResult;
      if (source?.confirmed && !sourceOperation) {
        const operation = startSourceOperation('verify');
        if (operation) {
          try {
            sourceResult = await readConfirmedSource(source);
            if (sourceResult.status === 'error') setVccOpCalcStatus(sourceResult.message, 'error', generation);
          } finally {
            await finishSourceOperation(operation);
          }
        }
      }
      if (!live(generation)) return { status: 'stale' };
      renderSettledFeedback();
      const balances = await refreshVccOpCalcButtonAvailability();
      return balances || (sourceResult?.status === 'error' ? sourceResult : undefined);
    }

    async function refreshVccOpCalcButtonAvailability() {
      const viewGeneration = renderGeneration;
      const request = requests.balances = (requests.balances || 0) + 1;
      if (!live(viewGeneration) || request !== requests.balances) { needsRefresh = true; return { status: 'stale' }; }

      try {
        const months = await domainApi.listBalanceMonths();
        if (!live(viewGeneration) || request !== requests.balances) { needsRefresh = true; return { status: 'stale' }; }
        vccOpCalcState.balanceMonthsCount = Array.isArray(months) ? months.length : 0;
      } catch (_e) {
        if (!live(viewGeneration) || request !== requests.balances) { needsRefresh = true; return { status: 'stale' }; }

        vccOpCalcState.balanceMonthsCount = 0;
        applyVccOpCalcButtonState();
        setVccOpCalcStatus(`状态读取失败：${_e?.message || String(_e)}`, 'error');
        ui.reportError?.(_e);
        return { status: 'error' };
      }
      applyVccOpCalcButtonState();
    }


    // 「导入文件」：pickFiles → scan → F1 确认 → computeAmounts（统计发生额）
    async function handleVccOpCalcImport() {
      if (!live()) return { status: 'stale' };
      if (sourceOperation) return { status: 'blocked', message: '当前流水操作尚未完成' };
      // 已打开的 F2 不得在重扫后继续提交旧期初；busy 写入仍由同一 host 拒绝关闭。
      if (ui.modalHost.closeOwner(owner, 'replaced')?.status === 'blocked') return { status: 'blocked' };
      const operation = startSourceOperation('import');
      if (!operation) return { status: 'blocked' };
      const generation = operation.generation;
      try {
        const pickRes = await domainApi.pickFiles().catch(() => null);
        if (!live(generation)) return { status: 'stale' };
        if (!pickRes || pickRes.status === 'cancelled') {
          // 尚未发送 scan，Main 来源没有改变，保留已经确认的当前流水。
          setVccOpCalcStatus('已取消选择文件', 'info', generation);
          return { status: 'cancelled' };
        }
        if (pickRes.status !== 'success' || !Array.isArray(pickRes.filePaths) || pickRes.filePaths.length === 0) {
          setVccOpCalcStatus(pickRes.message || '选择文件失败', 'error', generation);
          return { status: 'error' };
        }

        // 必须先撤销旧保存资格，再发送会替换 Main snapshot 的 scan；失败或取消也不能复活旧 F2。
        clearSaveableSource();
        pendingErrorReport = null;
        const source = { confirmed: false, key: null,
          fileNames: pickRes.filePaths.map((filePath) => String(filePath).split(/[\\/]/).at(-1)) };
        currentSource = source;
        applyVccOpCalcButtonState();
        setVccOpCalcStatus(`正在读取 ${pickRes.filePaths.length} 个文件...`, 'info', generation);
        const unsubscribeProgress = subscribeProgress('onScanProgress', (data) => {
          const rows = (data && data.rows) || 0;
          setVccOpCalcStatus(`正在读取大文件… 已处理 ${(rows / 10000).toFixed(1)} 万行`, 'info', generation);
        });
        let scanRes;
        try {
          scanRes = await domainApi.scan({ filePaths: pickRes.filePaths })
            .catch((error) => ({ status: 'error', message: error?.message || String(error) }));
        } finally {
          unsubscribeProgress();
        }
        if (currentSource !== source) return { status: 'stale' };
        if (scanRes?.status !== 'success') {
          clearSaveableSource();
          if (scanRes?.status === 'rejected') {
            pendingErrorReport = { errorRows: scanRes.errorRows, errorCount: scanRes.errorCount };
            setVccOpCalcStatus('导入被拒绝：数据存在异常（见错误报告）', 'error', generation);
          } else if (scanRes?.status === 'cancelled') {
            setVccOpCalcStatus('已取消导入，请重新选择文件。', 'info', generation);
          } else {
            const detail = scanRes?.detailLines?.length ? '\n' + scanRes.detailLines.join('\n') : '';
            setVccOpCalcStatus(`导入失败：${scanRes?.message || '未知错误'}${detail}`, 'error', generation);
          }
          return scanRes || { status: 'error' };
        }

        if (!live(generation)) {
          // scan 已完成，但 F1 尚未确认。保存真实结算反馈，重入要求重新导入，绝不恢复旧 ready。
          clearSaveableSource();
          setVccOpCalcStatus(`${scanRes.yearMonth} 读取完成，尚未确认流水信息。请重新导入文件并确认。`, 'info', generation);
          return scanRes;
        }
        let decided = false;
        const cancelConfirmation = () => {
          if (decided || currentSource !== source) return;
          decided = true;
          clearSaveableSource();
          setVccOpCalcStatus('已取消导入', 'info', generation);
          applyVccOpCalcButtonState();
        };
        const opened = openModal(() => createVccOpCalcConfirmDialog({
          yearMonth: scanRes.yearMonth,
          totalRows: scanRes.totalRows,
          fileCount: scanRes.fileCount,
          onConfirm: async () => {
            if (decided || currentSource !== source || !live(generation)) return { status: 'stale' };
            const computing = startSourceOperation('compute');
            if (!computing) return { status: 'blocked' };
            decided = true;
            try {
              setVccOpCalcStatus('正在统计发生额...', 'info', generation);
              const compRes = await domainApi.computeAmounts()
                .catch((error) => ({ status: 'error', message: error?.message || String(error) }));
              if (currentSource !== source) return { status: 'stale' };
              const filesMatch = !Array.isArray(compRes?.perFile) || (
                compRes.perFile.length === scanRes.fileCount
                && compRes.perFile.every((file, index) => file.fileName === source.fileNames[index])
                && compRes.perFile.reduce((count, file) => count + file.rowCount, 0) === scanRes.totalRows
              );
              if (compRes?.status !== 'success' || compRes.yearMonth !== scanRes.yearMonth || !compRes.totals || !filesMatch) {
                clearSaveableSource();
                if (compRes?.status === 'rejected') {
                  pendingErrorReport = { errorRows: compRes.errorRows, errorCount: compRes.errorCount };
                  setVccOpCalcStatus('统计被拒绝：数据存在异常（见错误报告）', 'error', generation);
                } else if (compRes?.status === 'cancelled') {
                  setVccOpCalcStatus('已取消统计，请重新导入文件并确认。', 'info', generation);
                } else {
                  setVccOpCalcStatus(`统计失败：${compRes?.message || '流水来源已变化，请重新导入文件并确认。'}`, 'error', generation);
                }
                return compRes?.status === 'success' ? { status: 'error' } : compRes;
              }
              // 业务确认归属于这一次 scan，即使离页也保存结算，DOM 则服从原页面 generation。
              source.confirmed = true;
              source.key = snapshotKey(compRes);
              Object.assign(vccOpCalcState, {
                scanned: true, yearMonth: compRes.yearMonth, totals: compRes.totals,
                fileCount: scanRes.fileCount, totalRows: scanRes.totalRows
              });
              const t = compRes.totals;
              setVccOpCalcStatus(`统计完成：${compRes.yearMonth}：发生额出 ${t.totalOut}：发生额入 ${t.totalIn}：总发生额 ${t.totalAmount} — 点「开始运行」输入期初OP`, 'success', generation);
              return compRes;
            } finally {
              await finishSourceOperation(computing);
            }
          },
          onCancel: cancelConfirmation
        }));
        if (opened.status === 'opened') opened.handle.closed.then(cancelConfirmation);
        else cancelConfirmation();
        return opened;
      } finally {
        await finishSourceOperation(operation);
      }
    }

    // 「开始运行」：F2 绑定当前已确认 scan；只将用户输入的 beginOp 传给 Main。
    async function handleVccOpCalcRun() {
      if (!live()) return { status: 'stale' };
      if (sourceOperation) return { status: 'blocked', message: '当前流水操作尚未完成' };
      const source = currentSource;
      const generation = renderGeneration;
      if (!source?.confirmed || !vccOpCalcState.scanned || !vccOpCalcState.totals) {
        openModal(() => createAlertDialog('请先用「导入文件」选择流水并完成统计。'));
        return { status: 'error' };
      }
      const checking = startSourceOperation('verify');
      let checked;
      try {
        checked = await readConfirmedSource(source);
        if (checked.status === 'error') setVccOpCalcStatus(checked.message, 'error', generation);
      } finally {
        await finishSourceOperation(checking);
      }
      if (!live(generation) || currentSource !== source) return checked;
      let handle = null;
      const opened = openModal(() => {
        const overlay = createVccOpCalcComputeDialog({
          totals: vccOpCalcState.totals,
          yearMonth: vccOpCalcState.yearMonth,
          canClose: () => sourceOperation?.kind !== 'save',
          onCompute: async (beginOp) => {
            if (!handle?.isOpen() || !live(generation) || currentSource !== source || !source.confirmed) {
              return { status: 'error', message: '统计来源已失效，请重新导入文件并确认。' };
            }
            const saving = startSourceOperation('save');
            if (!saving) return { status: 'blocked', message: '当前流水操作尚未完成' };
            try {
              const verified = await readConfirmedSource(source);
              if (verified.status !== 'success') {
                if (verified.message) setVccOpCalcStatus(verified.message, 'error', generation);
                return verified;
              }
              // 核对等待中若 handle 被最终销毁，只放弃尚未发出的写；已经发出的 save 必须记录真实结算。
              if (!handle.isOpen() || !live(generation)) return { status: 'stale' };
              const saveRes = await domainApi.save({ beginOp })
                .catch((error) => ({ status: 'error', message: error?.message || String(error) }));
              if (saveRes?.status === 'success') {
                clearSaveableSource();
                setVccOpCalcStatus(`${saveRes.yearMonth} 运行完成：期初OP ${saveRes.beginOp} → 期末OP ${saveRes.endOp}（已保存）`, 'success', generation);
                if (live(generation)) await refreshVccOpCalcButtonAvailability();
                return { status: 'success', endOp: saveRes.endOp };
              }
              const message = saveRes?.message || (saveRes?.status === 'cancelled' ? '已取消保存' : '保存失败');
              setVccOpCalcStatus(message, saveRes?.status === 'cancelled' ? 'info' : 'error', generation);
              // 失败保持重试入口；每次重试仍先读取 Main 核对来源，不能重放未知的旧快照。
              return { status: saveRes?.status === 'cancelled' ? 'cancelled' : 'error', message };
            } finally {
              await finishSourceOperation(saving);
            }
          },
          onClose: () => {}
        });
        return overlay;
      });
      if (opened.status === 'opened') handle = opened.handle;
      return opened;
    }

    // 「显示余额」：弹 F3（月份下拉 + 查看），查看调 getBalance
    async function handleVccOpCalcShowBalance() {
      const viewGeneration = renderGeneration;
      const request = requests.showBalance = (requests.showBalance || 0) + 1;
      if (!live(viewGeneration) || request !== requests.showBalance) { needsRefresh = true; return { status: 'stale' }; }

      const months = await domainApi.listBalanceMonths().catch(() => []);
      if (!live(viewGeneration) || request !== requests.showBalance) { needsRefresh = true; return { status: 'stale' }; }
      if (!Array.isArray(months) || months.length === 0) {
        openModal(() => createAlertDialog('暂无已计算的月份。请先用「导入文件」+「开始运行」计算期末OP。'));
        return;
      }
      openModal(() => createVccOpCalcShowBalanceDialog({
        months,
        onView: async (yearMonth) => {
          const viewGeneration = renderGeneration;
          const request = requests.viewBalance = (requests.viewBalance || 0) + 1;
          if (!live(viewGeneration) || request !== requests.viewBalance) { needsRefresh = true; return { status: 'stale' }; }

          const result = await domainApi.getBalance({ yearMonth }).catch(() => null);
          if (!live(viewGeneration) || request !== requests.viewBalance) return null;
          return result;
        },
        onClose: () => {}
      }));
    }

    // 整批拒绝错误报告（资金红线🔴 不静默跳过）：errorRows = [{ fileName, rowIndex, reason }]
    // 用 createAlertDialog 多行展示（前 N 条 + 总数），与第5模块「整批拒绝」口径一致
    function showVccOpCalcErrorReport(errorRows, errorCount) {
      const rows = Array.isArray(errorRows) ? errorRows : [];
      // 流式改造（spec §9）：errorRows 有上限（前 100 条），errorCount 是真实总数（百万行场景）
      const total = (typeof errorCount === 'number' && errorCount > rows.length) ? errorCount : rows.length;
      const MAX_SHOW = 20;
      const lines = rows.slice(0, MAX_SHOW).map((r) => {
        const fn = r && r.fileName ? `[${r.fileName}] ` : '';
        const ri = r && r.rowIndex ? `第 ${r.rowIndex} 行：` : '';
        return `${fn}${ri}${(r && r.reason) || ''}`;
      });
      let msg = `导入被拒绝，共 ${total} 处异常（资金计算不容静默跳过）：\n\n${lines.join('\n')}`;
      if (total > MAX_SHOW) msg += `\n\n... 其余 ${total - MAX_SHOW} 处略`;
      openModal(() => createAlertDialog(msg));
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
    bind('vccOpCalcImportBtn', handleVccOpCalcImport);
    bind('vccOpCalcRunBtn', handleVccOpCalcRun);
    bind('vccOpCalcShowBalanceBtn', handleVccOpCalcShowBalance);
    async function enter() {
      if (disposed) return { status: 'stale' };
      active = true;
      const generation = ++renderGeneration;
      applyVccOpCalcButtonState();
      const result = await refreshCurrentFacts();
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
      if (live()) return refreshCurrentFacts();
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
      commands: Object.freeze({ import: handleVccOpCalcImport, run: handleVccOpCalcRun, showBalance: handleVccOpCalcShowBalance })
    });

  }
  const exports = Object.freeze({ createVccOpCalcController });
  global.__vccOpCalcController = exports;
  if (typeof module !== 'undefined' && module.exports) module.exports = exports;
})(typeof window !== 'undefined' ? window : globalThis);
