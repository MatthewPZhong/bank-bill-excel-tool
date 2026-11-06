(function initBankAccountsDialogs(global) {
  'use strict';

  // 设置 → 账户管理：清结算系统银行账户表的查看、导入（整份替换）与另存为原表。
  //   视图由设置弹窗挂载到自己的 pane，只管理自身的读取代次、子弹窗与订阅；数据与原文件由 Main 的账户管理服务持有。
  const PAGE_LIMIT = 200;
  const MAX_DETAIL_LINES = 12;

  function errorText(error, fallback) {
    if (error && typeof error === 'object' && error.message) return String(error.message);
    const text = String(error || '').trim();
    return text || fallback;
  }

  function createBankAccountsDialogs({ api, modalBridge, ui }) {
    const { createConfirmDialog } = ui;
    const escapeHtml = (value) => ui.escapeHtml(value === null || value === undefined ? '' : value);

    function mountBankAccounts(pane, { getParentHandle }) {
      const state = {
        overview: null,
        list: null,
        channel: '',
        page: 0,
        loaded: false,
        loading: null,
        overviewRequestId: 0,
        listRequestId: 0,
        busy: false,
        destroyed: false
      };
      const accountApi = api.bankAccounts || null;

      pane.innerHTML = `
        <header class="bank-accounts-toolbar">
          <h3 id="bankAccountsHeading" class="app-settings-pane-heading">清结算系统账户管理</h3>
          <label class="bank-accounts-channel">
            <span>渠道</span>
            <select data-role="bank-accounts-channel" aria-label="渠道"><option value=""></option></select>
          </label>
        </header>
        <div class="template-center-feedback bank-accounts-feedback" data-role="bank-accounts-feedback" role="status" aria-live="polite" hidden></div>
        <div class="bank-accounts-summary" data-role="bank-accounts-summary">切换到账户管理后加载</div>
        <div class="bank-accounts-table-wrap" data-role="bank-accounts-table"></div>
        <div class="bank-accounts-actions">
          <div class="bank-accounts-actions-main">
            <button class="primary-btn small" type="button" data-action="import-bank-accounts">导入银行账户信息</button>
            <button class="secondary-btn small" type="button" data-action="export-bank-accounts" disabled>导出</button>
          </div>
          <div class="bank-accounts-pager" data-role="bank-accounts-pager" hidden>
            <button class="secondary-btn small" type="button" data-action="previous-page">上一页</button>
            <span data-role="bank-accounts-page"></span>
            <button class="secondary-btn small" type="button" data-action="next-page">下一页</button>
          </div>
        </div>`;

      const channelSelect = pane.querySelector('[data-role="bank-accounts-channel"]');
      const feedbackEl = pane.querySelector('[data-role="bank-accounts-feedback"]');
      const summaryEl = pane.querySelector('[data-role="bank-accounts-summary"]');
      const tableEl = pane.querySelector('[data-role="bank-accounts-table"]');
      const importButton = pane.querySelector('[data-action="import-bank-accounts"]');
      const exportButton = pane.querySelector('[data-action="export-bank-accounts"]');
      const pagerEl = pane.querySelector('[data-role="bank-accounts-pager"]');
      const pageEl = pane.querySelector('[data-role="bank-accounts-page"]');
      const previousButton = pane.querySelector('[data-action="previous-page"]');
      const nextButton = pane.querySelector('[data-action="next-page"]');

      const alive = () => !state.destroyed && pane.isConnected;

      function requireApi(method) {
        if (!accountApi || typeof accountApi[method] !== 'function') throw new Error('账户管理服务暂不可用');
        return accountApi;
      }

      // 失败结果的明细逐行显示（最多 MAX_DETAIL_LINES 行）。
      function showFeedback(message, tone = 'info', detailLines = []) {
        const text = String(message || '').trim();
        feedbackEl.hidden = !text;
        feedbackEl.dataset.tone = tone;
        feedbackEl.setAttribute('role', tone === 'error' ? 'alert' : 'status');
        feedbackEl.textContent = '';
        if (!text) return;
        const head = document.createElement('div');
        head.textContent = text;
        feedbackEl.appendChild(head);
        const lines = (Array.isArray(detailLines) ? detailLines : []).map((line) => String(line || '').trim()).filter(Boolean);
        if (!lines.length) return;
        const list = document.createElement('ul');
        list.className = 'bank-accounts-feedback-lines';
        for (const line of lines.slice(0, MAX_DETAIL_LINES)) {
          const item = document.createElement('li');
          item.textContent = line;
          list.appendChild(item);
        }
        if (lines.length > MAX_DETAIL_LINES) {
          const item = document.createElement('li');
          item.textContent = `…另有 ${lines.length - MAX_DETAIL_LINES} 行`;
          list.appendChild(item);
        }
        feedbackEl.appendChild(list);
      }

      function syncButtons() {
        const snapshot = state.overview?.snapshot || null;
        importButton.disabled = state.busy;
        exportButton.disabled = state.busy || !snapshot;
      }

      function setBusy(busy) {
        state.busy = busy;
        syncButtons();
      }

      function renderOverview() {
        const overview = state.overview;
        const snapshot = overview?.snapshot || null;
        const channels = Array.isArray(overview?.channels) ? overview.channels : [];
        if (state.channel && !channels.some((item) => item.channel === state.channel)) state.channel = '';
        channelSelect.innerHTML = '<option value=""></option>' + channels
          .map((item) => `<option value="${escapeHtml(item.channel)}">${escapeHtml(item.channel)}</option>`).join('');
        channelSelect.value = state.channel;
        channelSelect.disabled = !snapshot;
        summaryEl.textContent = snapshot
          ? `当前账户表：${snapshot.fileName} · ${snapshot.rowCount} 行 · ${channels.length} 个渠道 · 导入于 ${snapshot.importedAtText}`
            + (snapshot.structureLabel ? ` · 识别结构 ${snapshot.structureLabel}` : '')
          : '尚未导入银行账户信息';
        syncButtons();
      }

      function renderList() {
        const list = state.list;
        const snapshot = state.overview?.snapshot || null;
        if (!snapshot || !list) {
          tableEl.innerHTML = `<div class="bank-accounts-empty">${snapshot ? '加载中…' : '尚未导入银行账户信息，请点击左下角【导入银行账户信息】'}</div>`;
          pagerEl.hidden = true;
          return;
        }
        if (!list.rows.length) {
          tableEl.innerHTML = `<div class="bank-accounts-empty">${state.channel ? '该渠道没有账户' : '账户表没有账户行'}</div>`;
          pagerEl.hidden = true;
          return;
        }
        const head = `<tr><th class="bank-accounts-row-number">行号</th>${list.headers
          .map((header) => `<th>${escapeHtml(header)}</th>`).join('')}</tr>`;
        const body = list.rows.map((row) => `<tr><td class="bank-accounts-row-number">${escapeHtml(row.excelRowNumber)}</td>${list.headers
          .map((_header, index) => `<td>${escapeHtml(row.values[index] ?? '')}</td>`).join('')}</tr>`).join('');
        tableEl.innerHTML = `<table class="bank-accounts-table" aria-labelledby="bankAccountsHeading"><thead>${head}</thead><tbody>${body}</tbody></table>`;
        tableEl.scrollTop = 0;
        const pages = Math.max(1, Math.ceil(list.total / PAGE_LIMIT));
        pagerEl.hidden = pages <= 1;
        pageEl.textContent = `第 ${state.page + 1} / ${pages} 页（共 ${list.total} 行）`;
        previousButton.disabled = state.page <= 0;
        nextButton.disabled = state.page + 1 >= pages;
      }

      async function loadPage(page) {
        const requestId = ++state.listRequestId;
        state.page = Math.max(0, page);
        const snapshotNo = state.overview?.snapshot?.snapshotNo || 0;
        if (!snapshotNo) {
          state.list = null;
          renderList();
          return;
        }
        const result = await requireApi('list').list({ channel: state.channel, offset: state.page * PAGE_LIMIT, limit: PAGE_LIMIT });
        if (!alive() || requestId !== state.listRequestId) return;
        if (result?.status !== 'success') throw new Error(result?.message || '读取账户失败');
        // 读取期间账户表被替换：重新读取概况，从第 1 页开始。
        if (result.snapshotNo !== snapshotNo) {
          await loadOverview({ keepFeedback: true });
          return;
        }
        state.list = result;
        renderList();
      }

      async function loadOverview({ keepFeedback = false } = {}) {
        const requestId = ++state.overviewRequestId;
        if (!keepFeedback) showFeedback('');
        try {
          const overview = await requireApi('getOverview').getOverview();
          if (!alive() || requestId !== state.overviewRequestId) return;
          if (overview?.status !== 'success') throw new Error(overview?.message || '读取账户表失败');
          state.overview = overview;
          state.loaded = true;
          state.list = null;
          renderOverview();
          await loadPage(0);
        } catch (error) {
          if (!alive() || requestId !== state.overviewRequestId) return;
          showFeedback(errorText(error, '读取账户表失败'), 'error');
          renderOverview();
          renderList();
        }
      }

      function pushChild(overlay) {
        const parent = getParentHandle();
        if (!alive() || !parent?.isOpen() || !parent.isTop()) return false;
        return modalBridge.pushModal(parent, overlay)?.status !== 'stale';
      }

      function discard(importToken) {
        if (!importToken || !accountApi || typeof accountApi.discardImport !== 'function') return;
        Promise.resolve(accountApi.discardImport(importToken)).catch(() => {});
      }

      // 整份替换确认；写入由后端确认后才关闭，失败时在原框内提示并允许重试。关闭而未写入时丢弃本次预检。
      function openReplaceConfirm(prepared) {
        let busy = false;
        let committed = false;
        let overlay = null;
        const detail = [
          `文件：${prepared.fileName}`,
          prepared.sheetName ? `工作表：${prepared.sheetName}` : '',
          prepared.structureLabel ? `识别结构：${prepared.structureLabel}` : ''
        ].filter(Boolean).join('；');
        overlay = createConfirmDialog({
          message: `清结算银行账户表将整份替换：${escapeHtml(prepared.previousRowCount)} 行 → ${escapeHtml(prepared.rowCount)} 行`
            + `（${escapeHtml(prepared.channelCount)} 个渠道）`
            + `<div class="bank-accounts-confirm-detail">${escapeHtml(detail)}</div>`,
          confirmText: '确认替换',
          cancelText: '取消',
          onConfirm: async () => {
            const confirmButton = overlay.querySelector('[data-action="confirm"]');
            const cancelButton = overlay.querySelector('[data-action="cancel"]');
            if (busy || confirmButton.disabled) return;
            busy = true;
            confirmButton.disabled = true;
            cancelButton.disabled = true;
            confirmButton.textContent = '处理中…';
            let result = null;
            let failure = '';
            try {
              result = await requireApi('commitImport').commitImport({ importToken: prepared.importToken });
              if (result?.status !== 'success') failure = result?.message || '导入失败';
            } catch (error) {
              failure = errorText(error, '导入失败');
            }
            busy = false;
            if (!failure) {
              committed = true;
              if (overlay.isConnected) modalBridge.closeModal(overlay, { status: 'submitted', value: null });
              if (!alive()) return;
              showFeedback(`已导入 ${result.rowCount} 行账户（${result.channelCount} 个渠道）：${result.fileName}`, 'success');
              loadOverview({ keepFeedback: true });
              return;
            }
            // 预检已失效或账户表已变化：后端已丢弃本次预检，关闭确认框并提示重新导入。
            committed = true;
            if (overlay.isConnected) modalBridge.closeModal(overlay, { status: 'submitted', value: null });
            if (!alive()) return;
            showFeedback(failure, 'error');
            loadOverview({ keepFeedback: true });
          }
        });
        overlay.querySelector('[data-action="confirm"]')?.classList.replace('danger-btn', 'primary-btn');
        modalBridge.registerModal(overlay, {
          canClose: () => !busy,
          initialFocus: () => overlay.querySelector('[data-action="cancel"]'),
          onDispose: () => { if (!committed) discard(prepared.importToken); }
        });
        if (!pushChild(overlay)) discard(prepared.importToken);
      }

      async function runImport() {
        if (state.busy) return;
        setBusy(true);
        let prepared = null;
        try {
          const picked = await requireApi('pickImportFile').pickImportFile();
          if (!alive() || picked?.status !== 'success') return;
          showFeedback(`正在检查：${picked.fileName}`, 'info');
          prepared = await requireApi('prepareImport').prepareImport({ filePath: picked.filePath });
          if (!alive()) {
            discard(prepared?.importToken);
            return;
          }
          if (prepared?.status !== 'success') {
            showFeedback(prepared?.message || '导入预检未通过', 'error', prepared?.detailLines);
            return;
          }
          showFeedback('');
        } catch (error) {
          if (alive()) showFeedback(errorText(error, '导入失败'), 'error');
          return;
        } finally {
          if (alive()) setBusy(false);
        }
        openReplaceConfirm(prepared);
      }

      async function runExport() {
        if (state.busy) return;
        setBusy(true);
        try {
          const result = await requireApi('saveAs').saveAs();
          if (!alive() || result?.status === 'cancelled') return;
          if (result?.status !== 'success') {
            showFeedback(result?.message || '导出失败', 'error');
            return;
          }
          showFeedback(`已导出：${result.fileName}`, 'success');
        } catch (error) {
          if (alive()) showFeedback(errorText(error, '导出失败'), 'error');
        } finally {
          if (alive()) setBusy(false);
        }
      }

      function goToPage(page) {
        loadPage(page).catch((error) => {
          if (alive()) showFeedback(errorText(error, '读取账户失败'), 'error');
        });
      }

      channelSelect.addEventListener('change', () => {
        state.channel = channelSelect.value;
        goToPage(0);
      });
      importButton.addEventListener('click', () => { runImport(); });
      exportButton.addEventListener('click', () => { runExport(); });
      previousButton.addEventListener('click', () => goToPage(state.page - 1));
      nextButton.addEventListener('click', () => goToPage(state.page + 1));

      const unsubscribe = accountApi && typeof accountApi.onChanged === 'function'
        ? accountApi.onChanged(() => {
          if (!alive() || !state.loaded) return;
          loadOverview({ keepFeedback: true });
        })
        : null;

      return Object.freeze({
        enter() {
          if (state.destroyed || state.loaded || state.loading) return state.loading;
          state.loading = loadOverview().finally(() => { state.loading = null; });
          return state.loading;
        },
        leave() {},
        destroy() {
          if (state.destroyed) return;
          state.destroyed = true;
          state.overviewRequestId += 1;
          state.listRequestId += 1;
          if (typeof unsubscribe === 'function') unsubscribe();
        }
      });
    }

    return Object.freeze({ mountBankAccounts });
  }

  global.__bankAccountsDialogs = Object.freeze({ createBankAccountsDialogs });
  if (typeof module !== 'undefined' && module.exports) module.exports = global.__bankAccountsDialogs;
})(typeof window !== 'undefined' ? window : globalThis);
