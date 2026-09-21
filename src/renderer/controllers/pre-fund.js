'use strict';

(function installPreFundController(global) {
  // 从 renderer.js 原业务流程迁出；本域状态、DOM 与请求代次只在工厂闭包内保存。
  function createPreFundController({ api, panel, ui }) {
    if (!api || !panel || !ui?.modalHost || !ui.status || !ui.modalBridge) throw new TypeError('PreFund 控制器缺少领域依赖');

    const owner = 'pre-fund-reconciliation';
    const domainApi = api;
    const elements = Object.fromEntries(['preFundReconciliationImportBankBtn','preFundReconciliationExportBtn','preFundReconciliationRunBtn','preFundReconciliationScenarioSelect','preFundReconciliationTempManagerBtn','preFundReconciliationStatusBox'].map((id) => [id, panel.querySelector('#' + id)]));
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
    const createPreFundTempManagerDialog = (options) => createScopedDialog(ui.createPreFundTempManagerDialog, options);
    const escapeHtml = ui.escapeHtml;

    const preFundState = { session: null, inflight: false };
    function updatePreFundReconciliationUi({ updateStatus = true } = {}) {
      if (!live()) return;
      const uiState = preFundState;
      const status = uiState.session;
      const busy = uiState.inflight;
      const bank = status && status.bank;
      const temp = status && status.temporaryGateway;
      const linked = status && status.linkedGateway;
      const run = status && status.run;

      if (elements.preFundReconciliationImportBankBtn) elements.preFundReconciliationImportBankBtn.disabled = busy;
      if (elements.preFundReconciliationTempManagerBtn) elements.preFundReconciliationTempManagerBtn.disabled = busy;
      if (elements.preFundReconciliationScenarioSelect) elements.preFundReconciliationScenarioSelect.disabled = busy;
      if (elements.preFundReconciliationRunBtn) {
        elements.preFundReconciliationRunBtn.disabled = busy || !(status && status.canRun);
      }
      if (elements.preFundReconciliationExportBtn) {
        elements.preFundReconciliationExportBtn.disabled = busy || !(status && status.canExport);
      }
      if (!elements.preFundReconciliationStatusBox || busy || !updateStatus) return;

      const tempBatchCount = Number(temp && temp.batchCount) || 0;
      const tempRowCount = Number(temp && temp.rowCount) || 0;
      const linkedRowCount = Number(linked && linked.rowCount) || 0;
      let text = '欢迎使用小助手';
      let tone = 'neutral';
      if (bank) {
        text = `已导入：${bank.fileName}（${Number(bank.inputRows) || 0} 行，可参与 ${Number(bank.participatingRows) || 0} 行）\n`
          + `网关数据：临时 ${tempBatchCount} 批/${tempRowCount} 行，链接表 ${linkedRowCount} 行`;
        tone = 'info';
      }
      if (run) {
        if (run.unavailable) {
          text = `结果已失效：${run.unavailableMessage || '运行结果不可用，请重新运行'}`;
          tone = 'error';
        } else if (run.stale) {
          text = '结果已失效：数据来源发生变化，请重新运行';
          tone = 'error';
        } else {
          const summary = run.summary || {};
          text = `已完成：平账 ${Number(summary.matchedPairs) || 0} 行，不平 ${Number(summary.unmatchedBankRows) || 0} 行\n`
            + `银行排除：空ID ${Number(summary.bankExcludedEmptyIdRows) || 0} 行、零金额 ${Number(summary.bankSkippedZeroRows) || 0} 行、空渠道 ${Number(summary.bankEmptyChannelRows) || 0} 行\n`
            + `规则不匹配：未配置 ${Number(summary.bankRuleUnmappedRows) || 0} 行、方向不符 ${Number(summary.bankRuleDirectionMismatchRows) || 0} 行、无网关类型 ${Number(summary.bankRuleNoGatewayTradeTypeRows) || 0} 行\n`
            + `网关排除：空ID ${Number(summary.gatewayExcludedEmptyIdRows) || 0} 行、无效 ${Number(summary.gatewayInvalidRows) || 0} 行、重复折叠 ${Number(summary.gatewayCollapsedDuplicateRows) || 0} 行；未使用 ${Number(summary.unusedGatewayRows) || 0} 行、多候选ID组 ${Number(summary.gatewayConflictingSameIdGroups) || 0} 组`;
          tone = 'success';
        }
      }
      updateStatusBox(elements.preFundReconciliationStatusBox, text, tone);
    }

    async function refreshPreFundReconciliationStatus() {
      const viewGeneration = renderGeneration;
      const request = requests.status = (requests.status || 0) + 1;
      if (!live(viewGeneration) || request !== requests.status) { needsRefresh = true; return { status: 'stale' }; }

      try {
        const status = await domainApi.sessionStatus();
        if (!live(viewGeneration) || request !== requests.status) { needsRefresh = true; return { status: 'stale' }; }
        if (!status || status.status !== 'ok') {
          preFundState.session = null;
          updatePreFundReconciliationUi();
          if (elements.preFundReconciliationStatusBox) {
            updateStatusBox(
              elements.preFundReconciliationStatusBox,
              status && status.message ? status.message : '状态读取失败',
              'error'
            );
          }
          return { status: 'error' };
        }
        preFundState.session = status;
      } catch (error) {
        if (!live(viewGeneration) || request !== requests.status) { needsRefresh = true; return { status: 'stale' }; }

        preFundState.session = null;
        if (elements.preFundReconciliationStatusBox) {
          updateStatusBox(elements.preFundReconciliationStatusBox, error.message || String(error), 'error');
        }
        ui.reportError?.(error);
        updatePreFundReconciliationUi({ updateStatus: false });
        return { status: 'error' };
      }
      updatePreFundReconciliationUi();
    }

    function beginPreFundReconciliationAction(message) {
      preFundState.inflight = true;
      updatePreFundReconciliationUi();
      if (elements.preFundReconciliationStatusBox) {
        updateStatusBox(elements.preFundReconciliationStatusBox, message, 'info');
      }
    }

    async function finishPreFundReconciliationAction() {
      const viewGeneration = renderGeneration;
      const request = requests.finish = (requests.finish || 0) + 1;
      if (!live(viewGeneration) || request !== requests.finish) { needsRefresh = true; return { status: 'stale' }; }

      preFundState.inflight = false;
      await refreshPreFundReconciliationStatus();
      if (!live(viewGeneration) || request !== requests.finish) { needsRefresh = true; return { status: 'stale' }; }
    }

    function showPreFundFailure(action, result) {
      const message = result && result.message ? result.message : '未知错误';
      const detailLines = result && Array.isArray(result.detailLines) ? result.detailLines : [];
      const details = detailLines.length > 0
        ? `<br/><br/>${detailLines.slice(0, 10).map((line) => escapeHtml(line)).join('<br/>')}`
        : '';
      openModal(() => createAlertDialog(`${escapeHtml(action)}失败：${escapeHtml(message)}${details}`));
    }

    async function handlePreFundImportBank() {
      if (preFundState.inflight) return { status: 'blocked' };
      const viewGeneration = renderGeneration;
      const request = requests.importBank = (requests.importBank || 0) + 1;
      if (!live(viewGeneration) || request !== requests.importBank) { needsRefresh = true; return { status: 'stale' }; }

      beginPreFundReconciliationAction('正在导入银行对账单…');
      try {
        const result = await domainApi.importBank();
        if (!live(viewGeneration) || request !== requests.importBank) { needsRefresh = true; return { status: 'stale' }; }
        if (!result || result.status === 'cancelled') return;
        if (result.status !== 'ok') showPreFundFailure('导入', result);
      } catch (error) {
        if (!live(viewGeneration) || request !== requests.importBank) { needsRefresh = true; return { status: 'stale' }; }

        showPreFundFailure('导入', error);
      } finally {
        if (!live(viewGeneration)) {
          preFundState.inflight = false;
          needsRefresh = true;
          if (live()) await refreshPreFundReconciliationStatus();
          return { status: 'stale' };
        }
        await finishPreFundReconciliationAction();
        if (!live(viewGeneration) || request !== requests.importBank) { needsRefresh = true; return { status: 'stale' }; }
      }
    }

    async function handlePreFundImportMpt({ showFailures = true } = {}) {
      if (preFundState.inflight) return { status: 'blocked' };
      const viewGeneration = renderGeneration;
      const request = requests.importMpt = (requests.importMpt || 0) + 1;
      if (!live(viewGeneration) || request !== requests.importMpt) { needsRefresh = true; return { status: 'stale' }; }

      beginPreFundReconciliationAction('正在导入 MPT 网关账单…');
      let unsubscribe = null;
      try {
        const api = domainApi;
        if (typeof api.onImportProgress === 'function') {
          unsubscribe = subscribeProgress('onImportProgress', (progress) => {
            const current = Number(progress && progress.current) || 0;
            const total = Number(progress && progress.total) || 0;
            const fileName = progress && progress.fileName ? `：${progress.fileName}` : '';
            updateStatusBox(elements.preFundReconciliationStatusBox, `正在导入账单 ${current}/${total}${fileName}`, 'info');
          });
        }
        const result = await api.importMpt();
        if (!live(viewGeneration) || request !== requests.importMpt) { needsRefresh = true; return { status: 'stale' }; }
        if (!result || result.status === 'cancelled') return result;
        if (result.status !== 'ok') {
          if (showFailures) showPreFundFailure('导入账单', result);
          return result;
        }
        const failures = Array.isArray(result.results)
          ? result.results.filter((item) => item.status !== 'ok')
          : [];
        if (showFailures && failures.length > 0) {
          const details = failures.map((item) => (
            `${escapeHtml(item.fileName || '文件')}：${escapeHtml(item.message || '导入失败')}`
          )).join('<br/>');
          openModal(() => createAlertDialog(`部分文件导入失败（${failures.length} 个）：<br/>${details}`));
        }
        return result;
      } catch (error) {
        if (!live(viewGeneration) || request !== requests.importMpt) { needsRefresh = true; return { status: 'stale' }; }

        if (showFailures) showPreFundFailure('导入账单', error);
        return { status: 'failed', message: error && error.message ? error.message : String(error) };
      } finally {
        if (typeof unsubscribe === 'function') unsubscribe();
        if (!live(viewGeneration)) {
          preFundState.inflight = false;
          needsRefresh = true;
          if (live()) await refreshPreFundReconciliationStatus();
          return { status: 'stale' };
        }
        await finishPreFundReconciliationAction();
        if (!live(viewGeneration) || request !== requests.importMpt) { needsRefresh = true; return { status: 'stale' }; }
      }
    }

    async function handlePreFundRun() {
      if (preFundState.inflight) return { status: 'blocked' };
      const viewGeneration = renderGeneration;
      const request = requests.run = (requests.run || 0) + 1;
      if (!live(viewGeneration) || request !== requests.run) { needsRefresh = true; return { status: 'stale' }; }

      beginPreFundReconciliationAction('正在构建网关候选池…');
      let unsubscribe = null;
      try {
        const api = domainApi;
        if (typeof api.onRunProgress === 'function') {
          unsubscribe = subscribeProgress('onRunProgress', (progress) => {
            let text = '正在运行前置资金对账…';
            if (progress && progress.stage === 'gateway-pool') text = `正在构建网关候选池：${Number(progress.current) || 0} 行`;
            if (progress && progress.stage === 'bank-match') text = `正在匹配银行账单：${Number(progress.current) || 0}/${Number(progress.total) || 0}`;
            if (progress && progress.stage === 'done') text = '正在汇总对账结果…';
            updateStatusBox(elements.preFundReconciliationStatusBox, text, 'info');
          });
        }
        const result = await api.run({ scenario: elements.preFundReconciliationScenarioSelect.value });
        if (!live(viewGeneration) || request !== requests.run) { needsRefresh = true; return { status: 'stale' }; }
        if (!result || result.status !== 'ok') showPreFundFailure('运行', result);
      } catch (error) {
        if (!live(viewGeneration) || request !== requests.run) { needsRefresh = true; return { status: 'stale' }; }

        showPreFundFailure('运行', error);
      } finally {
        if (typeof unsubscribe === 'function') unsubscribe();
        if (!live(viewGeneration)) {
          preFundState.inflight = false;
          needsRefresh = true;
          if (live()) await refreshPreFundReconciliationStatus();
          return { status: 'stale' };
        }
        await finishPreFundReconciliationAction();
        if (!live(viewGeneration) || request !== requests.run) { needsRefresh = true; return { status: 'stale' }; }
      }
    }

    async function handlePreFundExport() {
      if (preFundState.inflight) return { status: 'blocked' };
      const viewGeneration = renderGeneration;
      const request = requests.export = (requests.export || 0) + 1;
      if (!live(viewGeneration) || request !== requests.export) { needsRefresh = true; return { status: 'stale' }; }

      beginPreFundReconciliationAction('正在准备导出…');
      let unsubscribe = null;
      try {
        const api = domainApi;
        if (typeof api.onExportProgress === 'function') {
          unsubscribe = subscribeProgress('onExportProgress', (progress) => {
            const text = progress && progress.stage === 'export-done'
              ? '正在校验导出文件…'
              : '正在按渠道导出文件…';
            updateStatusBox(elements.preFundReconciliationStatusBox, text, 'info');
          });
        }
        const result = await api.export();
        if (!live(viewGeneration) || request !== requests.export) { needsRefresh = true; return { status: 'stale' }; }
        if (!result || result.status === 'cancelled') return;
        if (result.status !== 'ok') {
          showPreFundFailure('导出', result);
          return;
        }
        if (!live(viewGeneration)) {
          preFundState.inflight = false;
          needsRefresh = true;
          if (live()) await refreshPreFundReconciliationStatus();
          return { status: 'stale' };
        }
        await finishPreFundReconciliationAction();
        if (!live(viewGeneration) || request !== requests.export) { needsRefresh = true; return { status: 'stale' }; }
        const names = (result.files || []).map((file) => file.fileName).join('\n');
        const warnings = Array.isArray(result.warnings) ? result.warnings.filter(Boolean) : [];
        updateStatusBox(
          elements.preFundReconciliationStatusBox,
          `已导出 ${Number(result.files && result.files.length) || 0} 个文件${names ? `\n${names}` : ''}`
            + `${warnings.length ? `\n提醒：${warnings.join('\n')}` : ''}`,
          warnings.length ? 'info' : 'success'
        );
        return;
      } catch (error) {
        if (!live(viewGeneration) || request !== requests.export) { needsRefresh = true; return { status: 'stale' }; }

        showPreFundFailure('导出', error);
      } finally {
        if (typeof unsubscribe === 'function') unsubscribe();
        if (preFundState.inflight) {
          if (!live(viewGeneration)) {
            preFundState.inflight = false;
            needsRefresh = true;
            if (live()) await refreshPreFundReconciliationStatus();
          }
          else await finishPreFundReconciliationAction();
        }
      }
    }
    function openTempManager() {
      if (preFundState.inflight) return { status: 'blocked' };
      return openModal(() => createPreFundTempManagerDialog({
        onChanged: refreshPreFundReconciliationStatus, onImport: handlePreFundImportMpt
      }));
    }

    function applyPreview() {
      if (!live()) return;
      preFundState.session = {
        status: 'ok',
        bank: {
          fileName: '渠道账单_2026-07-15_160000.xlsx',
          inputRows: 128604,
          participatingRows: 127998
        },
        temporaryGateway: { batchCount: 3, rowCount: 142202 },
        linkedGateway: { rowCount: 978430 },
        run: {
          stale: false,
          unavailable: false,
          summary: {
            matchedPairs: 126789,
            unmatchedBankRows: 1209,
            bankExcludedEmptyIdRows: 314,
            bankSkippedZeroRows: 292,
            bankEmptyChannelRows: 7,
            bankRuleUnmappedRows: 21,
            bankRuleDirectionMismatchRows: 8,
            bankRuleNoGatewayTradeTypeRows: 5,
            gatewayExcludedEmptyIdRows: 16,
            gatewayInvalidRows: 0,
            gatewayCollapsedDuplicateRows: 37,
            unusedGatewayRows: 993806,
            gatewayConflictingSameIdGroups: 12
          }
        },
        canRun: true,
        canExport: true
      };
      updatePreFundReconciliationUi();
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
    bind('preFundReconciliationImportBankBtn', handlePreFundImportBank);
    bind('preFundReconciliationRunBtn', handlePreFundRun);
    bind('preFundReconciliationExportBtn', handlePreFundExport);
    bind('preFundReconciliationTempManagerBtn', openTempManager);
    async function enter() {
      if (disposed) return { status: 'stale' };
      active = true;
      const generation = ++renderGeneration;
      updatePreFundReconciliationUi();
      const result = await refreshPreFundReconciliationStatus();
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
      if (live()) return refreshPreFundReconciliationStatus();
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
      commands: Object.freeze({ preview: applyPreview, importBank: handlePreFundImportBank, importMpt: handlePreFundImportMpt, run: handlePreFundRun, export: handlePreFundExport, openTempManager: openTempManager })
    });

  }
  const exports = Object.freeze({ createPreFundController });
  global.__preFundController = exports;
  if (typeof module !== 'undefined' && module.exports) module.exports = exports;
})(typeof window !== 'undefined' ? window : globalThis);
