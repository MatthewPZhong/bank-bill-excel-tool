'use strict';

(function installDuplicateInboundController(global) {
  // 从 renderer.js 原业务流程迁出；本域状态、DOM 与请求代次只在工厂闭包内保存。
  function createDuplicateInboundController({ api, panel, ui }) {
    if (!api || !panel || !ui?.modalHost || !ui.status) throw new TypeError('DuplicateInbound 控制器缺少领域依赖');

    const owner = 'duplicate-inbound-match';
    const domainApi = api;
    const elements = Object.fromEntries(['duplicateInboundMatchImportBtn','duplicateInboundMatchRunBtn','duplicateInboundMatchExportBtn','duplicateInboundMatchStatusBox'].map((id) => [id, panel.querySelector('#' + id)]));
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


    const duplicateInboundMatchState = {
      busy: false,
      backend: null
    };

    function setDuplicateInboundMatchStatus(message, tone = 'info') {
      if (!elements.duplicateInboundMatchStatusBox) return;
      updateStatusBox(elements.duplicateInboundMatchStatusBox, message, tone, {
        idleTitle: '欢迎使用小助手'
      });
    }

    function formatDuplicateInboundMatchFailure(prefix, value, fallback = '未知错误') {
      const message = value && value.message ? value.message : fallback;
      const detailLines = value && Array.isArray(value.detailLines)
        ? value.detailLines.map((line) => String(line)).filter(Boolean)
        : [];
      return [`${prefix}：${message}`, ...detailLines].join('\n');
    }

    function formatDuplicateInboundMatchExportSuccess(result) {
      const warnings = Array.isArray(result && result.warnings)
        ? result.warnings.map((warning) => String(warning)).filter(Boolean)
        : [];
      return {
        message: [`文件已生成：${result.filePath}`, ...warnings.map((warning) => `警告：${warning}`)].join('\n'),
        tone: warnings.length > 0 ? 'warning' : 'success'
      };
    }

    function applyDuplicateInboundMatchButtonState() {
      if (!live()) return;
      const status = duplicateInboundMatchState.backend || {};
      if (elements.duplicateInboundMatchImportBtn) {
        elements.duplicateInboundMatchImportBtn.disabled = duplicateInboundMatchState.busy;
      }
      if (elements.duplicateInboundMatchRunBtn) {
        elements.duplicateInboundMatchRunBtn.disabled = duplicateInboundMatchState.busy || !status.canRun;
      }
      if (elements.duplicateInboundMatchExportBtn) {
        elements.duplicateInboundMatchExportBtn.disabled = duplicateInboundMatchState.busy || !status.canExport;
      }
    }

    function renderDuplicateInboundMatchBackendStatus(status) {
      if (!status) {
        setDuplicateInboundMatchStatus('欢迎使用小助手', 'info');
        return;
      }
      if (status.status !== 'ok') {
        setDuplicateInboundMatchStatus(
          formatDuplicateInboundMatchFailure('状态读取失败', status),
          'error'
        );
        return;
      }
      if (status.run) {
        if (status.run.stale || status.run.unavailable) {
          setDuplicateInboundMatchStatus(
            status.run.unavailableMessage || '临时中台入金网关账单已变化，请重新运行',
            'warning'
          );
          return;
        }
        const s = status.run.summary || {};
        const reasonCounts = s.reasonCounts || {};
        const mptZeroCount = Number(reasonCounts['duplicate-inbound-mpt-candidate-count-zero'] || 0);
        const mptMultipleCount = Number(reasonCounts['duplicate-inbound-mpt-candidate-count-multiple'] || 0);
        const mptReuseCount = Number(reasonCounts['duplicate-inbound-mpt-candidate-reused-across-groups'] || 0);
        const mptOppBuCount = Number(reasonCounts['duplicate-inbound-mpt-opp-bu-empty'] || 0)
          + Number(reasonCounts['duplicate-inbound-mpt-opp-bu-conflict'] || 0);
        const mptOrderIdCount = Number(reasonCounts['duplicate-inbound-mpt-order-id-empty'] || 0);
        const documentZeroCount = Number(reasonCounts['duplicate-inbound-document-candidate-count-zero'] || 0);
        const documentMultipleCount = Number(reasonCounts['duplicate-inbound-document-candidate-count-multiple'] || 0);
        const documentIdentityCount = Number(reasonCounts['duplicate-inbound-document-identity-field-empty'] || 0)
          + Number(reasonCounts['duplicate-inbound-document-identity-fields-conflict'] || 0);
        const documentBuMismatchCount = Number(
          reasonCounts['duplicate-inbound-document-business-department-mismatch'] || 0
        );
        setDuplicateInboundMatchStatus(
          `匹配完成：共 ${s.inputRowCount || 0} 行（Reversal ${s.reversalRowCount || 0} / Inbound ${s.inboundRowCount || 0} / 忽略 ${s.ignoredFundTypeRowCount || 0}）；分组 ${s.bankGroupCount || 0} 个（1+2 候选 ${s.bankCandidateGroupCount || 0} / 成功 ${s.finalSuccessGroupCount || 0} / 人工 ${s.manualGroupCount || 0} 组 ${s.manualRowCount || 0} 行 / 纯 Inbound ${s.pureInboundGroupCount || 0} 组 ${s.pureInboundRowCount || 0} 行）；MPT 异常：零候选 ${mptZeroCount} / 多候选 ${mptMultipleCount} / 复用 ${mptReuseCount} / oppBu ${mptOppBuCount} / orderId ${mptOrderIdCount}；单据异常：零候选 ${documentZeroCount} / 多候选 ${documentMultipleCount} / 身份字段 ${documentIdentityCount} / 业务部门 ${documentBuMismatchCount}`,
          (s.manualRowCount || 0) > 0 ? 'info' : 'success'
        );
        return;
      }
      if (status.bank && status.document) {
        setDuplicateInboundMatchStatus(
          `已导入银行对账单 ${status.bank.fileName}：共 ${status.bank.rowCount} 行，Reversal ${status.bank.reversalCount} 行，Inbound ${status.bank.inboundCount} 行；单据对账单 ${status.document.fileName}：共 ${status.document.rowCount} 行，可匹配 ${status.document.matchableRowCount} 行`,
          'success'
        );
        return;
      }
      setDuplicateInboundMatchStatus('欢迎使用小助手', 'info');
    }

    async function refreshDuplicateInboundMatchStatus({ updateStatus = true } = {}) {
      const viewGeneration = renderGeneration;
      const request = requests.status = (requests.status || 0) + 1;
      if (!live(viewGeneration) || request !== requests.status) { needsRefresh = true; return { status: 'stale' }; }

      try {
        const result = await domainApi.sessionStatus();
        if (!live(viewGeneration) || request !== requests.status) { needsRefresh = true; return { status: 'stale' }; }
        duplicateInboundMatchState.backend = result && result.status === 'ok' ? result : null;
        if (updateStatus) renderDuplicateInboundMatchBackendStatus(result);
        if (!result || result.status !== 'ok') { applyDuplicateInboundMatchButtonState(); return { status: 'error' }; }
      } catch (_error) {
        if (!live(viewGeneration) || request !== requests.status) { needsRefresh = true; return { status: 'stale' }; }

        duplicateInboundMatchState.backend = null;
        if (updateStatus) setDuplicateInboundMatchStatus('状态读取失败，请重试', 'error');
        ui.reportError?.(_error);
        applyDuplicateInboundMatchButtonState();
        return { status: 'error' };
      }
      applyDuplicateInboundMatchButtonState();
    }


    function subscribeDuplicateInboundMatchProgress(kind, fallbackText) {
      const api = domainApi;
      const method = kind === 'import'
        ? 'onImportProgress'
        : kind === 'run' ? 'onRunProgress' : 'onExportProgress';
      if (!api || typeof api[method] !== 'function') return () => {};
      return subscribeProgress(method, (progress) => {
        const message = progress && progress.message ? progress.message : fallbackText;
        setDuplicateInboundMatchStatus(message, 'info');
      });
    }

    async function handleDuplicateInboundMatchImport() {
      if (duplicateInboundMatchState.busy) return { status: 'blocked' };
      const viewGeneration = renderGeneration;
      const request = requests.import = (requests.import || 0) + 1;
      if (!live(viewGeneration) || request !== requests.import) { needsRefresh = true; return { status: 'stale' }; }

      duplicateInboundMatchState.busy = true;
      applyDuplicateInboundMatchButtonState();
      setDuplicateInboundMatchStatus('正在导入银行对账单和单据对账单...', 'info');
      const unsubscribe = subscribeDuplicateInboundMatchProgress('import', '正在导入银行对账单和单据对账单...');
      try {
        const result = await domainApi.importFiles();
        if (!live(viewGeneration) || request !== requests.import) { needsRefresh = true; return { status: 'stale' }; }
        if (!result || result.status === 'cancelled') {
          await refreshDuplicateInboundMatchStatus();
          if (!live(viewGeneration) || request !== requests.import) { needsRefresh = true; return { status: 'stale' }; }
          return;
        }
        if (result.status !== 'ok') {
          await refreshDuplicateInboundMatchStatus({ updateStatus: false });
          if (!live(viewGeneration) || request !== requests.import) { needsRefresh = true; return { status: 'stale' }; }
          setDuplicateInboundMatchStatus(formatDuplicateInboundMatchFailure('导入失败', result), 'error');
          return;
        }
        await refreshDuplicateInboundMatchStatus();
        if (!live(viewGeneration) || request !== requests.import) { needsRefresh = true; return { status: 'stale' }; }
      } catch (error) {
        if (!live(viewGeneration) || request !== requests.import) { needsRefresh = true; return { status: 'stale' }; }

        await refreshDuplicateInboundMatchStatus({ updateStatus: false });
        if (!live(viewGeneration) || request !== requests.import) { needsRefresh = true; return { status: 'stale' }; }
        setDuplicateInboundMatchStatus(formatDuplicateInboundMatchFailure('导入失败', error, String(error)), 'error');
      } finally {
        unsubscribe();
        duplicateInboundMatchState.busy = false;
        if (live(viewGeneration)) applyDuplicateInboundMatchButtonState();
        else {
          needsRefresh = true;
          // 返回本域早于旧任务完成时，重新读取 Main，不能拿旧返回填新页面。
          if (live()) await refreshDuplicateInboundMatchStatus();
        }
      }
    }

    async function handleDuplicateInboundMatchRun() {
      if (duplicateInboundMatchState.busy) return { status: 'blocked' };
      const viewGeneration = renderGeneration;
      const request = requests.run = (requests.run || 0) + 1;
      if (!live(viewGeneration) || request !== requests.run) { needsRefresh = true; return { status: 'stale' }; }

      duplicateInboundMatchState.busy = true;
      applyDuplicateInboundMatchButtonState();
      setDuplicateInboundMatchStatus('正在匹配重复入金...', 'info');
      const unsubscribe = subscribeDuplicateInboundMatchProgress('run', '正在匹配重复入金...');
      try {
        const result = await domainApi.run();
        if (!live(viewGeneration) || request !== requests.run) { needsRefresh = true; return { status: 'stale' }; }
        if (!result || result.status !== 'success') {
          await refreshDuplicateInboundMatchStatus({ updateStatus: false });
          if (!live(viewGeneration) || request !== requests.run) { needsRefresh = true; return { status: 'stale' }; }
          setDuplicateInboundMatchStatus(formatDuplicateInboundMatchFailure('运行失败', result), 'error');
          return;
        }
        await refreshDuplicateInboundMatchStatus();
        if (!live(viewGeneration) || request !== requests.run) { needsRefresh = true; return { status: 'stale' }; }
      } catch (error) {
        if (!live(viewGeneration) || request !== requests.run) { needsRefresh = true; return { status: 'stale' }; }

        await refreshDuplicateInboundMatchStatus({ updateStatus: false });
        if (!live(viewGeneration) || request !== requests.run) { needsRefresh = true; return { status: 'stale' }; }
        setDuplicateInboundMatchStatus(formatDuplicateInboundMatchFailure('运行失败', error, String(error)), 'error');
      } finally {
        unsubscribe();
        duplicateInboundMatchState.busy = false;
        if (live(viewGeneration)) applyDuplicateInboundMatchButtonState();
        else {
          needsRefresh = true;
          // 返回本域早于旧任务完成时，重新读取 Main，不能拿旧返回填新页面。
          if (live()) await refreshDuplicateInboundMatchStatus();
        }
      }
    }

    async function handleDuplicateInboundMatchExport() {
      if (duplicateInboundMatchState.busy) return { status: 'blocked' };
      const viewGeneration = renderGeneration;
      const request = requests.export = (requests.export || 0) + 1;
      if (!live(viewGeneration) || request !== requests.export) { needsRefresh = true; return { status: 'stale' }; }

      duplicateInboundMatchState.busy = true;
      applyDuplicateInboundMatchButtonState();
      setDuplicateInboundMatchStatus('正在生成导出文件...', 'info');
      const unsubscribe = subscribeDuplicateInboundMatchProgress('export', '正在生成导出文件...');
      try {
        const result = await domainApi.export();
        if (!live(viewGeneration) || request !== requests.export) { needsRefresh = true; return { status: 'stale' }; }
        if (!result || result.status === 'cancelled') {
          await refreshDuplicateInboundMatchStatus();
          if (!live(viewGeneration) || request !== requests.export) { needsRefresh = true; return { status: 'stale' }; }
          return;
        }
        if (result.status !== 'success') {
          await refreshDuplicateInboundMatchStatus({ updateStatus: false });
          if (!live(viewGeneration) || request !== requests.export) { needsRefresh = true; return { status: 'stale' }; }
          setDuplicateInboundMatchStatus(formatDuplicateInboundMatchFailure('导出失败', result), 'error');
          return;
        }
        const exportStatus = formatDuplicateInboundMatchExportSuccess(result);
        setDuplicateInboundMatchStatus(exportStatus.message, exportStatus.tone);
        await refreshDuplicateInboundMatchStatus({ updateStatus: false });
        if (!live(viewGeneration) || request !== requests.export) { needsRefresh = true; return { status: 'stale' }; }
      } catch (error) {
        if (!live(viewGeneration) || request !== requests.export) { needsRefresh = true; return { status: 'stale' }; }

        await refreshDuplicateInboundMatchStatus({ updateStatus: false });
        if (!live(viewGeneration) || request !== requests.export) { needsRefresh = true; return { status: 'stale' }; }
        setDuplicateInboundMatchStatus(formatDuplicateInboundMatchFailure('导出失败', error, String(error)), 'error');
      } finally {
        unsubscribe();
        duplicateInboundMatchState.busy = false;
        if (live(viewGeneration)) applyDuplicateInboundMatchButtonState();
        else {
          needsRefresh = true;
          // 返回本域早于旧任务完成时，重新读取 Main，不能拿旧返回填新页面。
          if (live()) await refreshDuplicateInboundMatchStatus();
        }
      }
    }


    function applyPreview() {
      if (!live()) return;
      duplicateInboundMatchState.busy = false;
      duplicateInboundMatchState.backend = { canRun: false, canExport: false };
      applyDuplicateInboundMatchButtonState();
      setDuplicateInboundMatchStatus('欢迎使用小助手', 'info');
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
    bind('duplicateInboundMatchImportBtn', handleDuplicateInboundMatchImport);
    bind('duplicateInboundMatchRunBtn', handleDuplicateInboundMatchRun);
    bind('duplicateInboundMatchExportBtn', handleDuplicateInboundMatchExport);
    async function enter() {
      if (disposed) return { status: 'stale' };
      active = true;
      const generation = ++renderGeneration;
      applyDuplicateInboundMatchButtonState();
      const result = await refreshDuplicateInboundMatchStatus();
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
      if (live()) return refreshDuplicateInboundMatchStatus();
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
      commands: Object.freeze({ preview: applyPreview, import: handleDuplicateInboundMatchImport, run: handleDuplicateInboundMatchRun, export: handleDuplicateInboundMatchExport })
    });

  }
  const exports = Object.freeze({ createDuplicateInboundController });
  global.__duplicateInboundController = exports;
  if (typeof module !== 'undefined' && module.exports) module.exports = exports;
})(typeof window !== 'undefined' ? window : globalThis);
