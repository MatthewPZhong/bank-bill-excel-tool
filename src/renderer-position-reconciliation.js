(function initPositionReconciliationRenderer(global) {
  'use strict';

  const FUND_NATURE_FUNCTION = 'position-fund-nature-check';
  const SOURCE_ACCOUNT = 'bank-account';

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  function formatUpdatedDate(value) {
    const raw = String(value || '').trim();
    if (!raw) return '—';
    const utcLike = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw)
      ? `${raw.replace(' ', 'T')}Z`
      : raw;
    const parsed = new Date(utcLike);
    if (Number.isNaN(parsed.getTime())) {
      const match = raw.match(/^(\d{4}-\d{2}-\d{2})/);
      return match ? match[1] : '—';
    }
    const pad = (number) => String(number).padStart(2, '0');
    return `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())}`;
  }

  function failureDetailsHtml(result, fallbackMessage) {
    const message = escapeHtml(result && result.message ? result.message : fallbackMessage);
    const details = Array.isArray(result && result.detailLines)
      ? result.detailLines.filter(Boolean).map(escapeHtml)
      : [];
    return details.length > 0 ? `${message}<br>${details.join('<br>')}` : message;
  }

  function failureDetailsText(result, fallbackMessage) {
    const message = String(result && result.message ? result.message : fallbackMessage);
    const details = Array.isArray(result && result.detailLines)
      ? result.detailLines.filter(Boolean).map(String)
      : [];
    return details.length > 0 ? `${message}；${details.join('；')}` : message;
  }

  function isImportCancelledResult(result) {
    return Boolean(result && (
      result.status === 'cancelled'
      || result.code === 'position-import-cancelled'
    ));
  }

  function createPositionReconciliationUI({
    api,
    openModal,
    closeModal,
    createAlertDialog,
    createConfirmDialog,
    modalRoot = document.getElementById('modalRoot')
  }) {
    const elements = {
      functionSelect: document.getElementById('positionReconciliationFunctionSelect'),
      runBtn: document.getElementById('positionReconciliationRunBtn'),
      dataManagerBtn: document.getElementById('positionReconciliationTableManagerBtn'),
      linkedManagerBtn: document.getElementById('positionReconciliationLinkedTableManagerBtn'),
      configBtn: document.getElementById('positionReconciliationConfigBtn'),
      exportBtn: document.getElementById('positionReconciliationExportBtn'),
      statusBox: document.getElementById('positionReconciliationStatusBox')
    };
    const state = {
      status: null,
      inflight: false,
      bound: false
    };

    function statusTextElement() {
      return elements.statusBox && elements.statusBox.querySelector('.status-box-text');
    }

    function setStatus(message, tone = 'info') {
      const text = statusTextElement();
      if (text) text.textContent = String(message || '欢迎使用小助手');
      if (elements.statusBox) elements.statusBox.dataset.tone = tone;
    }

    function showAlert(message, { info = false, html = false } = {}) {
      openModal(createAlertDialog(html ? message : escapeHtml(message), info
        ? { skipLogReport: true }
        : { logDomain: 'position-reconciliation' }));
    }

    function showArchiveUnavailable() {
      const overlay = createAlertDialog(escapeHtml('当前没有符合业务归档条件的数据'), {
        skipLogReport: true,
        confirmText: '返回',
        confirmSecondary: true,
        closeOnConfirm: false
      });
      if (modalRoot) modalRoot.appendChild(overlay);
      else openModal(overlay);
    }

    function confirmAction(message, confirmText = '确认') {
      return new Promise((resolve) => {
        openModal(createConfirmDialog({
          message: escapeHtml(message),
          confirmText,
          cancelText: '取消',
          onConfirm: () => {
            closeModal();
            resolve(true);
          },
          onCancel: () => resolve(false)
        }));
      });
    }

    function ensureAvailable() {
      if (!api) {
        showAlert('平盘对账服务暂不可用，请重启软件后重试');
        return false;
      }
      return true;
    }

    function isFundNatureSelected() {
      return !elements.functionSelect || elements.functionSelect.value === FUND_NATURE_FUNCTION;
    }

    function statusSummary(status) {
      const bank = status && status.bank ? status.bank : {};
      const rows = Number(bank.rowCount) || 0;
      const pending = status && status.pendingRun;
      if (pending) {
        if (pending.stale) return `待确认结果已失效，请重新运行（银行数据 ${rows} 行）`;
        const summary = pending.summary || {};
        return `待确认：${Number(summary.inputRows) || 0} 行，修改 ${Number(summary.changedRows) || 0} 行，差异 ${Number(summary.differenceRows) || 0} 行`;
      }
      if (rows > 0) return `已导入 ${rows} 行平盘银行对账单`;
      return '欢迎使用小助手';
    }

    function updateControls() {
      const current = state.status || {};
      const supported = isFundNatureSelected();
      if (elements.runBtn) {
        elements.runBtn.disabled = state.inflight || !supported || !current.canRun;
      }
      if (elements.exportBtn) {
        elements.exportBtn.disabled = state.inflight
          || !supported
          || !current.pendingRun
          || current.pendingRun.stale
          || !current.canExport;
      }
      if (elements.dataManagerBtn) elements.dataManagerBtn.disabled = state.inflight;
      if (elements.linkedManagerBtn) elements.linkedManagerBtn.disabled = state.inflight;
      if (elements.configBtn) elements.configBtn.disabled = state.inflight;
    }

    async function refresh() {
      if (!api) return null;
      const result = await api.status();
      if (!result || result.status !== 'ok') {
        state.status = null;
        setStatus(failureDetailsText(result, '平盘对账状态读取失败'), 'error');
        updateControls();
        return result;
      }
      state.status = result;
      setStatus(statusSummary(result), result.pendingRun && result.pendingRun.stale ? 'warning' : 'info');
      updateControls();
      return result;
    }

    async function withInflight(message, task) {
      if (state.inflight) return null;
      state.inflight = true;
      setStatus(message, 'info');
      updateControls();
      try {
        return await task();
      } finally {
        state.inflight = false;
        await refresh().catch(() => {});
      }
    }

    function createDialogShell(title, className = '', onClose = closeModal) {
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      const card = document.createElement('section');
      card.className = `modal-card position-reconciliation-dialog ${className}`.trim();
      const header = document.createElement('header');
      header.className = 'dialog-header';
      const heading = document.createElement('h2');
      heading.className = 'dialog-title';
      heading.textContent = title;
      const closeButton = document.createElement('button');
      closeButton.className = 'icon-close';
      closeButton.type = 'button';
      closeButton.setAttribute('aria-label', '关闭');
      closeButton.textContent = '×';
      closeButton.addEventListener('click', onClose);
      header.append(heading, closeButton);
      const content = document.createElement('div');
      content.className = 'position-dialog-content';
      const footer = document.createElement('footer');
      footer.className = 'dialog-actions split';
      card.append(header, content, footer);
      overlay.appendChild(card);
      return { overlay, card, content, footer, closeButton };
    }

    function makeButton(label, { primary = false, danger = false } = {}) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = primary
        ? 'primary-btn small'
        : (danger ? 'secondary-btn small position-danger-btn' : 'secondary-btn small');
      button.textContent = label;
      return button;
    }

    function makeTextButton(label, action, danger = false) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `text-action${danger ? ' danger' : ''}`;
      button.textContent = label;
      button.dataset.action = action;
      return button;
    }

    function importStageText(stage) {
      return {
        starting: '正在启动导入任务',
        staging: '正在复制并校验文件',
        preflight: '正在识别和校验数据',
        'awaiting-apply-grant': '正在确认存档与写入凭证',
        'preparing-apply': '正在准备写入索引',
        applying: '正在写入数据',
        deriving: '正在生成链接对账数据',
        summarizing: '正在汇总并提交，无法取消',
        committing: '正在提交，无法取消',
        committed: '当前文件已提交',
        stopping: '正在停止…',
        'force-terminating': '正在终止并核对已提交数据'
      }[String(stage || '')] || '正在处理';
    }

    async function withImportProgress(title, task, previewProgress = null) {
      if (!api || typeof api.onImportProgress !== 'function') {
        return task();
      }
      const shell = createDialogShell(
        title,
        'position-import-progress-dialog',
        () => {}
      );
      shell.closeButton.hidden = true;
      shell.content.innerHTML = `
        <div class="position-import-progress-body">
          <div class="position-import-progress-stage" data-role="stage">正在启动导入任务</div>
          <div class="position-import-progress-file" data-role="file">准备文件…</div>
          <div class="position-import-progress-metrics">
            <div><span>已扫描</span><strong data-role="scanned">0</strong></div>
            <div><span>已接受</span><strong data-role="accepted">0</strong></div>
            <div><span>已提交</span><strong data-role="committed">0</strong></div>
            <div><span>耗时</span><strong data-role="elapsed">0秒</strong></div>
          </div>
        </div>
      `;
      const cancel = makeButton('取消导入');
      const right = document.createElement('div');
      right.className = 'position-footer-right';
      right.append(cancel);
      shell.footer.append(document.createElement('span'), right);
      const nodes = {
        stage: shell.content.querySelector('[data-role="stage"]'),
        file: shell.content.querySelector('[data-role="file"]'),
        scanned: shell.content.querySelector('[data-role="scanned"]'),
        accepted: shell.content.querySelector('[data-role="accepted"]'),
        committed: shell.content.querySelector('[data-role="committed"]'),
        elapsed: shell.content.querySelector('[data-role="elapsed"]')
      };
      let jobId = '';
      let stopping = false;
      const updateProgress = (progress) => {
        if (!progress || typeof progress !== 'object') return;
        if (jobId && progress.jobId && progress.jobId !== jobId) return;
        if (progress.jobId) jobId = progress.jobId;
        const stage = String(progress.stage || '');
        nodes.stage.textContent = importStageText(stage);
        const currentFile = Number(progress.currentFile) || 0;
        const totalFiles = Number(progress.totalFiles) || 0;
        const fileName = String(progress.fileName || '').trim();
        nodes.file.textContent = fileName
          ? `${totalFiles > 0 ? `第 ${currentFile}/${totalFiles} 个文件：` : ''}${fileName}`
          : '准备文件…';
        nodes.scanned.textContent = String(Number(progress.scannedRows) || 0);
        nodes.accepted.textContent = String(Number(progress.acceptedRows) || 0);
        nodes.committed.textContent = String(Number(progress.committedRows) || 0);
        nodes.elapsed.textContent = `${Math.floor((Number(progress.elapsedMs) || 0) / 1000)}秒`;
        if (stage === 'summarizing' || stage === 'committing') {
          cancel.disabled = true;
          cancel.textContent = '正在提交，无法取消';
        } else if (stage === 'stopping' || stage === 'force-terminating') {
          stopping = true;
          cancel.disabled = true;
          cancel.textContent = '正在停止…';
        }
      };
      const unsubscribe = api.onImportProgress(updateProgress);
      cancel.addEventListener('click', async () => {
        if (stopping || cancel.disabled || !jobId) return;
        stopping = true;
        cancel.disabled = true;
        cancel.textContent = '正在停止…';
        nodes.stage.textContent = '正在停止…';
        const result = await api.cancelActiveImport(jobId);
        if (result && result.status === 'not-cancellable') {
          nodes.stage.textContent = '正在提交，无法取消';
          cancel.textContent = '正在提交，无法取消';
          return;
        }
        if (result && result.status === 'not-active') {
          nodes.stage.textContent = '正在核对任务结果';
          cancel.textContent = '任务已结束';
        }
      });
      openModal(shell.overlay);
      if (previewProgress) updateProgress(previewProgress);
      try {
        return await task();
      } finally {
        if (typeof unsubscribe === 'function') unsubscribe();
        shell.overlay.remove();
      }
    }

    function formatDateRange(row) {
      if (!row || (!row.dateMin && !row.dateMax)) return '-';
      if (row.dateMin === row.dateMax) return row.dateMin || '-';
      return `${row.dateMin || '-'} 至 ${row.dateMax || '-'}`;
    }

    function formatMonthRange(row) {
      const monthOf = (value) => {
        const match = String(value || '').match(/^(\d{4}-\d{2})/);
        return match ? match[1] : '';
      };
      const dateMin = monthOf(row && row.dateMin);
      const dateMax = monthOf(row && row.dateMax);
      if (!dateMin && !dateMax) return '—';
      if (dateMin === dateMax) return dateMin || '—';
      return `${dateMin || '—'} ~ ${dateMax || '—'}`;
    }

    function formatStatuses(statuses) {
      const rows = Array.isArray(statuses) ? statuses : [];
      return rows.length
        ? rows.map((item) => `${item.status} ${Number(item.rowCount) || 0}`).join(' / ')
        : '-';
    }

    function createScopeDialog({
      title,
      scopes,
      allowEmpty = false,
      confirmText = '确认',
      onConfirm
    }) {
      const shell = createDialogShell(title, 'position-scope-dialog');
      const scopeRows = Array.isArray(scopes) ? scopes : [];
      const channels = [...new Set(scopeRows.map((row) => row.channel).filter(Boolean))];
      const months = [...new Set(scopeRows.map((row) => row.monthKey).filter(Boolean))];
      shell.content.innerHTML = `
        <div class="position-scope-grid">
          <fieldset>
            <legend>银行渠道</legend>
            <label class="position-check-all"><input type="checkbox" data-all="channel" checked> 全部</label>
            <div class="position-check-list">
              ${channels.map((value) => `<label><input type="checkbox" name="position-channel" value="${escapeHtml(value)}" checked> ${escapeHtml(value)}</label>`).join('')}
            </div>
          </fieldset>
          <fieldset>
            <legend>月份</legend>
            <label class="position-check-all"><input type="checkbox" data-all="month" checked> 全部</label>
            <div class="position-check-list">
              ${months.map((value) => `<label><input type="checkbox" name="position-month" value="${escapeHtml(value)}" checked> ${escapeHtml(value)}</label>`).join('')}
            </div>
          </fieldset>
        </div>
      `;
      const cancel = makeButton('取消');
      const confirm = makeButton(confirmText, { primary: true });
      const right = document.createElement('div');
      right.className = 'position-footer-right';
      right.append(cancel, confirm);
      shell.footer.append(document.createElement('span'), right);
      cancel.addEventListener('click', closeModal);

      function syncAll(kind, name) {
        const all = shell.content.querySelector(`[data-all="${kind}"]`);
        const items = [...shell.content.querySelectorAll(`input[name="${name}"]`)];
        if (!all) return;
        all.checked = items.length > 0 && items.every((item) => item.checked);
        all.indeterminate = items.some((item) => item.checked) && !all.checked;
      }
      [
        ['channel', 'position-channel'],
        ['month', 'position-month']
      ].forEach(([kind, name]) => {
        const all = shell.content.querySelector(`[data-all="${kind}"]`);
        if (all) {
          all.addEventListener('change', () => {
            shell.content.querySelectorAll(`input[name="${name}"]`).forEach((item) => {
              item.checked = all.checked;
            });
          });
        }
        shell.content.querySelectorAll(`input[name="${name}"]`).forEach((item) => {
          item.addEventListener('change', () => syncAll(kind, name));
        });
      });
      confirm.addEventListener('click', async () => {
        const selectedChannels = [...shell.content.querySelectorAll('input[name="position-channel"]:checked')]
          .map((item) => item.value);
        const selectedMonths = [...shell.content.querySelectorAll('input[name="position-month"]:checked')]
          .map((item) => item.value);
        if (!allowEmpty && (selectedChannels.length === 0 || selectedMonths.length === 0)) {
          showAlert('请至少选择一个银行渠道和一个月份');
          return;
        }
        confirm.disabled = true;
        try {
          await onConfirm({ channels: selectedChannels, months: selectedMonths });
        } finally {
          confirm.disabled = false;
        }
      });
      return shell.overlay;
    }

    async function handleBankImport() {
      if (!ensureAvailable()) return;
      const result = await withInflight(
        '正在读取平盘银行对账单…',
        () => withImportProgress(
          '导入平盘银行对账单',
          () => api.prepareBankImport()
        )
      );
      if (!result || isImportCancelledResult(result)) return;
      if (result.status !== 'needs-confirmation') {
        showAlert(failureDetailsHtml(result, '平盘银行对账单导入失败'), { html: true });
        return;
      }
      const existing = Array.isArray(result.existing) ? result.existing : [];
      const replacement = existing.length
        ? `，并替换 ${existing.map((row) => `${row.channel}/${row.monthKey}（${row.rowCount}行）`).join('、')}`
        : '';
      const confirmed = await confirmAction(
        `确认导入 ${result.fileCount} 个文件、${result.rowCount} 行${replacement}？`,
        '确认导入'
      );
      if (!confirmed) {
        await api.cancelBankImport();
        return;
      }
      const applied = await withInflight(
        '正在写入平盘银行对账单…',
        () => withImportProgress(
          '写入平盘银行对账单',
          () => api.applyBankImport(result.token)
        )
      );
      if (isImportCancelledResult(applied)) return;
      if (!applied || applied.status !== 'ok') {
        showAlert(failureDetailsHtml(applied, '平盘银行对账单写入失败'), { html: true });
        return;
      }
      setStatus(applied.message, 'success');
    }

    function sourceImportSummary(result) {
      const rows = Array.isArray(result && result.results) ? result.results : [];
      return rows.map((item) => {
        const label = escapeHtml(item.sourceName || item.fileName || '未识别文件');
        if (item.status === 'ok') {
          const filtered = Number(item.filteredRowCount) || 0;
          const accepted = Number(item.rowCount) || 0;
          if (filtered > 0 && accepted === 0) {
            return `${label}：导入完成，但有效落库数据为 0 行，已过滤 ${filtered} 行`;
          }
          if (filtered > 0) {
            return `${label}：导入完成，已自动过滤异常数据：` +
              `总数据 ${Number(item.physicalRowCount) || 0} 行，` +
              `正常落库 ${accepted} 行，过滤 ${filtered} 行，` +
              `重复折叠 ${Number(item.collapsedDuplicateCount) || 0} 行，` +
              `生成链接 ${Number(item.generatedLinkRowCount) || 0} 行`;
          }
          return `${label}：成功落库 ${accepted} 行`;
        }
        if (item.status === 'needs-confirmation') {
          return `${label}：待确认 ${Number(item.oldValidCount) || 0} → ${Number(item.newValidCount) || 0} 行`;
        }
        const details = Array.isArray(item.detailLines)
          ? item.detailLines.filter(Boolean).map(escapeHtml)
          : [];
        return `${label}：${escapeHtml(item.message || '失败')}` +
          (details.length > 0 ? `<br><span class="muted">${details.join('<br>')}</span>` : '');
      }).join('<br>');
    }

    function showSourceImportCompletion(result, afterClose = null) {
      const report = result && result.anomalyReport
        ? result.anomalyReport
        : (result && Array.isArray(result.results)
          ? result.results.find((item) => item && item.anomalyReport)?.anomalyReport
          : null);
      if (!report || Number(report.filteredRowCount) <= 0) {
        showAlert(sourceImportSummary(result), {
          info: !(result.results || []).some((item) => item.status === 'failed'),
          html: true
        });
        return;
      }
      const shell = createDialogShell('链接原始表导入提醒', 'position-source-anomaly-dialog');
      shell.content.innerHTML = `
        <p class="position-result-note">发现 ${Number(report.filteredRowCount)} 行异常数据，已过滤异常行并继续写入正常数据。</p>
        <div class="position-import-summary">${sourceImportSummary(result)}</div>
        <p class="muted">异常报告已进入存档中心，也可立即导出到本地。</p>
      `;
      const right = document.createElement('div');
      right.className = 'position-footer-right';
      const exportButton = makeButton('导出异常数据');
      const confirmButton = makeButton('关闭', { primary: true });
      right.append(exportButton, confirmButton);
      shell.footer.append(right);
      exportButton.addEventListener('click', async () => {
        const exported = await withInflight(
          '正在导出异常数据…',
          () => api.exportSourceAnomaly(report.reportKey)
        );
        if (!exported || exported.status === 'cancelled') return;
        if (exported.status !== 'ok') {
          showAlert(failureDetailsHtml(exported, '异常数据导出失败'), { html: true });
          return;
        }
        setStatus(`已导出 ${Number(exported.rowCount) || 0} 行异常数据：${exported.fileName}`, 'success');
      });
      confirmButton.addEventListener('click', async () => {
        closeModal();
        if (typeof afterClose === 'function') await afterClose();
      });
      openModal(shell.overlay);
    }

    async function handleSourceImport(afterChanged = null, afterCompletionClose = null) {
      if (!ensureAvailable()) return;
      const result = await withInflight(
        '正在识别链接原始表…',
        () => withImportProgress(
          '导入链接原始表',
          () => api.prepareSourceImport()
        )
      );
      if (!result || isImportCancelledResult(result)) return;
      if (result.status !== 'ok') {
        const summary = sourceImportSummary(result);
        showAlert(summary || failureDetailsHtml(result, '链接原始表导入失败'), {
          html: true
        });
        return;
      }
      const confirmations = (result.results || []).filter((item) => item.status === 'needs-confirmation');
      for (const item of confirmations) {
        const confirmed = await confirmAction(
          `清结算银行账户表将全量替换：${Number(item.oldValidCount) || 0} 行 → ${Number(item.newValidCount) || 0} 行，是否继续？`,
          '确认替换'
        );
        if (!confirmed) {
          await api.cancelSourceImport(item.token);
          item.status = 'cancelled';
          item.message = '已取消替换';
          continue;
        }
        const applied = await withInflight(
          '正在替换清结算银行账户表…',
          () => withImportProgress(
            '替换清结算银行账户表',
            () => api.applySourceImport(item.token)
          )
        );
        if (isImportCancelledResult(applied)) {
          item.status = 'cancelled';
          item.message = '已取消替换';
        } else if (!applied || applied.status !== 'ok') {
          item.status = 'failed';
          item.message = applied && applied.message ? applied.message : '清结算银行账户表写入失败';
          item.detailLines = applied && Array.isArray(applied.detailLines)
            ? applied.detailLines
            : [];
          showAlert(failureDetailsHtml(applied, item.message), { html: true });
        } else {
          item.status = 'ok';
          item.rowCount = applied.rowCount;
          item.sourceName = applied.sourceName || item.sourceName;
        }
      }
      if (typeof afterChanged === 'function') await afterChanged();
      showSourceImportCompletion(result, afterCompletionClose);
    }

    async function openRunScopeDialog() {
      if (!ensureAvailable()) return;
      if (!isFundNatureSelected()) {
        showAlert('当前功能将在后续版本开放', { info: true });
        return;
      }
      const data = await api.dataManager();
      if (!data || data.status !== 'ok') {
        showAlert(failureDetailsHtml(data, '无法读取待运行范围'), { html: true });
        return;
      }
      const scopes = (data.scopes || []).filter((row) => row.status === '未处理');
      if (scopes.length === 0) {
        showAlert('没有状态为“未处理”的平盘银行对账单', { info: true });
        return;
      }
      openModal(createScopeDialog({
        title: '选择平盘资金性质校验范围',
        scopes,
        confirmText: '开始运行',
        onConfirm: async (selection) => {
          closeModal();
          let result = await withInflight('正在执行平盘资金性质校验…', () => api.run(selection));
          if (result && result.status === 'needs-replace-confirmation') {
            const replace = await confirmAction(result.message, '使旧结果失效并运行');
            if (!replace) return;
            result = await withInflight('正在重新执行平盘资金性质校验…', () => api.run({
              ...selection,
              replacePendingRunId: result.pendingRunId
            }));
          }
          if (!result || result.status !== 'ok') {
            showAlert(failureDetailsHtml(result, '平盘资金性质校验失败'), { html: true });
            return;
          }
          openResultDialog(result.runId);
        }
      }));
    }

    async function exportRun(runId, differencesOnly = false, differenceFilter = null) {
      const result = await withInflight(
        differencesOnly ? '正在导出差异数据…' : '正在导出平盘资金性质校验结果…',
        () => api.exportRun({
          runId,
          differencesOnly,
          ...(differenceFilter || {})
        })
      );
      if (!result || result.status === 'cancelled') return false;
      if (result.status !== 'ok') {
        showAlert(failureDetailsHtml(result, '结果导出失败'), { html: true });
        return false;
      }
      setStatus(`已导出 ${result.rowCount} 行：${result.fileName}`, 'success');
      return true;
    }

    async function importRunResult(runId) {
      const result = await withInflight('正在校验修改后的结果文件…', () => api.importRunResult(runId));
      if (!result || result.status === 'cancelled') return false;
      if (result.status !== 'ok') {
        const details = Array.isArray(result.detailLines) && result.detailLines.length
          ? `<br>${result.detailLines.map(escapeHtml).join('<br>')}`
          : '';
        showAlert(`${escapeHtml(result.message || '结果回导失败')}${details}`, { html: true });
        return false;
      }
      setStatus(`已回导 ${result.rowCount} 行，人工修改 ${result.modifiedCount} 行`, 'success');
      return true;
    }

    async function exportRunFiltered(runId) {
      const result = await withInflight(
        '正在导出本次运行的过滤数据…',
        () => api.exportRunFiltered(runId)
      );
      if (!result || result.status === 'cancelled') return false;
      if (result.status !== 'ok') {
        showAlert(failureDetailsHtml(result, '过滤数据导出失败'), { html: true });
        return false;
      }
      setStatus(`已导出 ${Number(result.rowCount) || 0} 行过滤数据：${result.fileName}`, 'success');
      return true;
    }

    async function confirmRun(runId) {
      const accepted = await confirmAction(
        '确认结果后将更新系统表库中的 FundType 和审计信息，并把对应银行数据状态改为“已校验性质”。未解决差异只保留人工结论，不会认领或消费链接来源。',
        '确认结果'
      );
      if (!accepted) return false;
      const result = await withInflight('正在确认平盘资金性质校验结果…', () => api.confirmRun(runId));
      if (!result || result.status !== 'ok') {
        showAlert(failureDetailsHtml(result, '结果确认失败'), { html: true });
        return false;
      }
      setStatus(result.message, 'success');
      closeModal();
      return true;
    }

    async function openResultDialog(runId = null, previewPending = null) {
      const current = previewPending
        ? { pendingRun: previewPending }
        : await refresh();
      const pending = current && current.pendingRun;
      const targetRunId = Number(runId || (pending && pending.id));
      if (!targetRunId || !pending || pending.stale) {
        showAlert(pending && pending.stale ? '当前结果已失效，请重新运行' : '没有待确认的运行结果');
        return;
      }
      const shell = createDialogShell('平盘资金性质校验结果确认', 'position-result-dialog');
      const summary = pending.summary || {};
      shell.content.innerHTML = `
        <div class="position-result-metrics">
          <div><span>参与行数</span><strong>${Number(summary.inputRows) || 0}</strong></div>
          <div><span>FundType修改</span><strong>${Number(summary.changedRows) || 0}</strong></div>
          <div><span>差异数据</span><strong>${Number(summary.differenceRows) || 0}</strong></div>
          <div><span>精准/模糊</span><strong>${Number(summary.preciseRows) || 0} / ${Number(summary.fuzzyRows) || 0}</strong></div>
          <div><span>不适用</span><strong>${Number(summary.notApplicableRows) || 0}</strong></div>
          <div><span>人工修改</span><strong>${Number(summary.manualModifiedRows) || 0}</strong></div>
        </div>
        <p class="position-result-note">未解决差异确认后仅保留人工结论，不会认领或消费链接来源。</p>
      `;
      const left = document.createElement('div');
      left.className = 'position-footer-left';
      const importButton = makeButton('导入修改结果');
      const filteredButton = makeButton('过滤数据导出');
      const hasFilteredRows = Boolean(
        pending.hasFilteredRows || Number(pending.filteredRowCount) > 0
      );
      filteredButton.disabled = !hasFilteredRows;
      if (!hasFilteredRows) filteredButton.title = '本次运行没有过滤数据';
      left.append(importButton, filteredButton);
      const right = document.createElement('div');
      right.className = 'position-footer-right';
      const closeButton = makeButton('稍后');
      const exportButton = makeButton('导出文件');
      const confirmButton = makeButton('确认', { primary: true });
      confirmButton.disabled = !pending.canExport;
      right.append(closeButton, exportButton, confirmButton);
      shell.footer.append(left, right);
      closeButton.addEventListener('click', closeModal);
      exportButton.addEventListener('click', async () => {
        if (await exportRun(targetRunId)) confirmButton.disabled = false;
      });
      importButton.addEventListener('click', async () => {
        if (await importRunResult(targetRunId)) {
          closeModal();
          await openResultDialog(targetRunId);
        }
      });
      filteredButton.addEventListener('click', () => exportRunFiltered(targetRunId));
      confirmButton.addEventListener('click', () => confirmRun(targetRunId));
      openModal(shell.overlay);
    }

    async function openBankScopeAction(action, data, rerender) {
      const scopes = Array.isArray(data.scopes) ? data.scopes : [];
      if (scopes.length === 0) {
        showAlert('平盘银行对账单表库暂无数据', { info: true });
        return;
      }
      openModal(createScopeDialog({
        title: action === 'export' ? '导出平盘银行对账单' : '删除平盘银行对账单',
        scopes,
        confirmText: action === 'export' ? '导出' : '删除',
        onConfirm: async (selection) => {
          if (action === 'export') {
            const result = await withInflight('正在导出平盘银行对账单…', () => api.exportBank(selection));
            if (!result || result.status === 'cancelled') return;
            if (result.status !== 'ok') {
              showAlert(failureDetailsHtml(result, '导出失败'), { html: true });
              return;
            }
            closeModal();
            setStatus(`已导出 ${result.rowCount} 行平盘银行对账单`, 'success');
            return;
          }
          const accepted = await confirmAction('确认删除所选银行渠道和月份的数据？', '确认删除');
          if (!accepted) return;
          const result = await withInflight('正在删除平盘银行对账单…', () => api.deleteBank(selection));
          if (!result || result.status !== 'ok') {
            showAlert(failureDetailsHtml(result, '删除失败'), { html: true });
            return;
          }
          closeModal();
          if (typeof rerender === 'function') await rerender();
          setStatus(result.message, 'success');
        }
      }));
    }

    async function openDataManager(previewData = null, initialTab = 'unarchived') {
      if (!ensureAvailable()) return;
      const result = previewData || await api.dataManager();
      if (!result || result.status !== 'ok') {
        showAlert(failureDetailsHtml(result, '对账数据管理读取失败'), { html: true });
        return;
      }
      const shell = createDialogShell('对账数据管理', 'position-manager-dialog');
      const body = document.createElement('div');
      body.className = 'position-manager-layout';
      const nav = document.createElement('nav');
      nav.className = 'position-manager-nav';
      const pane = document.createElement('div');
      pane.className = 'position-manager-pane';
      body.append(nav, pane);
      shell.content.append(body);
      const tabs = [
        ['unarchived', '未归档'],
        ['archived', '已归档'],
        ['differences', '差异数据']
      ];
      let active = tabs.some(([key]) => key === initialTab) ? initialTab : 'unarchived';
      let differenceMonth = '';

      async function reload() {
        const next = await api.dataManager();
        if (next && next.status === 'ok') Object.assign(result, next);
        renderPane();
      }

      function renderPane() {
        nav.innerHTML = '';
        tabs.forEach(([key, label]) => {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = `position-nav-item${key === active ? ' active' : ''}`;
          button.textContent = label;
          button.addEventListener('click', () => {
            active = key;
            renderPane();
          });
          nav.appendChild(button);
        });
        if (active === 'unarchived') {
          pane.innerHTML = `
            <div class="table-wrapper position-manager-table">
              <table class="data-table">
                <thead><tr><th>表库名</th><th>数据日期范围</th><th>状态</th><th>操作</th></tr></thead>
                <tbody>
                  ${(result.unarchived || []).map((row, index) => `
                    <tr>
                      <td>${escapeHtml(row.tableName)}</td>
                      <td>${escapeHtml(formatDateRange(row))}</td>
                      <td>${row.disabled ? escapeHtml(row.message || '-') : escapeHtml(formatStatuses(row.statuses))}</td>
                      <td class="row-actions">
                        ${row.disabled ? '<span class="muted">-</span>' : `<button class="text-action" data-bank-action="export" data-index="${index}">导出</button><button class="text-action danger" data-bank-action="delete" data-index="${index}">删除</button>`}
                      </td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>
          `;
          pane.querySelectorAll('[data-bank-action]').forEach((button) => {
            button.addEventListener('click', () => {
              openBankScopeAction(button.dataset.bankAction, result, reload);
            });
          });
          return;
        }
        if (active === 'archived') {
          pane.innerHTML = `
            <div class="table-wrapper position-manager-table">
              <table class="data-table">
                <thead><tr><th>表库名</th><th>数据日期范围</th><th>操作</th></tr></thead>
                <tbody>
                  <tr><td>平盘银行对账单</td><td>-</td><td class="muted">暂无已归档数据</td></tr>
                  <tr><td>平盘交易对账单</td><td>-</td><td class="muted">后续版本开放</td></tr>
                </tbody>
              </table>
            </div>
          `;
          return;
        }
        const allRows = Array.isArray(result.differences) ? result.differences : [];
        const months = [...new Set(allRows.map((row) => row.monthKey).filter(Boolean))]
          .sort((leftMonth, rightMonth) => rightMonth.localeCompare(leftMonth));
        if (!months.includes(differenceMonth)) differenceMonth = months[0] || '';
        const rows = differenceMonth
          ? allRows.filter((row) => row.monthKey === differenceMonth)
          : [];
        pane.innerHTML = `
          <div class="position-difference-filters">
            <label class="position-difference-filter position-difference-function-filter">
              <span>功能</span>
              <select id="positionDifferenceFunctionFilter" class="template-select main-panel-select-control">
                <option value="${FUND_NATURE_FUNCTION}">平盘资金性质校验</option>
              </select>
            </label>
            <label class="position-difference-filter position-difference-month-filter">
              <span>月份</span>
              <select
                id="positionDifferenceMonthFilter"
                class="template-select main-panel-select-control"
                ${months.length === 0 ? 'disabled' : ''}
              >
                ${months.length > 0
                  ? months.map((month) => `
                    <option value="${escapeHtml(month)}" ${month === differenceMonth ? 'selected' : ''}>${escapeHtml(month)}</option>
                  `).join('')
                  : '<option value="">暂无月份</option>'}
              </select>
            </label>
          </div>
          <div class="table-wrapper position-manager-table">
            <table class="data-table">
              <thead><tr><th>银行渠道</th><th>运行批次</th><th>状态</th><th>差异数</th><th>操作</th></tr></thead>
              <tbody>
                ${rows.length ? rows.map((row) => `
                  <tr>
                    <td>${escapeHtml(row.bankChannel)}</td>
                    <td>#${Number(row.runId) || 0}</td>
                    <td>${escapeHtml(row.status)}</td>
                    <td>${Number(row.differenceCount) || 0}</td>
                    <td><button
                      class="text-action"
                      data-diff-run="${Number(row.runId) || 0}"
                      data-diff-channel="${escapeHtml(row.channel)}"
                      data-diff-region="${escapeHtml(row.region)}"
                      data-diff-month="${escapeHtml(row.monthKey)}"
                      data-diff-status="${escapeHtml(row.status)}"
                    >导出</button></td>
                  </tr>
                `).join('') : '<tr><td colspan="5" class="empty-cell">暂无差异数据</td></tr>'}
              </tbody>
            </table>
          </div>
        `;
        const monthSelect = pane.querySelector('#positionDifferenceMonthFilter');
        if (monthSelect) {
          monthSelect.addEventListener('change', () => {
            differenceMonth = monthSelect.value;
            renderPane();
          });
        }
        pane.querySelectorAll('[data-diff-run]').forEach((button) => {
          button.addEventListener('click', () => exportRun(Number(button.dataset.diffRun), true, {
            channels: [button.dataset.diffChannel],
            regions: [button.dataset.diffRegion],
            months: [button.dataset.diffMonth],
            differenceStatuses: [button.dataset.diffStatus]
          }));
        });
      }

      const left = document.createElement('div');
      left.className = 'position-footer-left';
      const archive = makeButton('归档');
      left.append(archive);
      const right = document.createElement('div');
      right.className = 'position-footer-right';
      const importButton = makeButton('导入', { primary: true });
      const back = makeButton('返回');
      right.append(importButton, back);
      shell.footer.append(left, right);
      archive.addEventListener('click', showArchiveUnavailable);
      importButton.addEventListener('click', async () => {
        closeModal();
        await handleBankImport();
      });
      back.addEventListener('click', closeModal);
      renderPane();
      openModal(shell.overlay);
    }

    async function openMappingsDialog(onChanged = null, previewResult = null) {
      let result = previewResult;
      if (!result) {
        try {
          result = await api.listMappings();
        } catch (error) {
          showAlert(error && error.message ? error.message : '账户映射读取失败');
          return;
        }
      }
      if (!result || result.status !== 'ok') {
        showAlert(failureDetailsHtml(result, '账户映射读取失败'), { html: true });
        return;
      }
      let shell;
      const closeSelf = () => shell && shell.overlay.remove();
      shell = createDialogShell('账户映射管理', 'position-mapping-dialog manager-card account-card', closeSelf);
      shell.content.innerHTML = `
        <div class="table-wrapper position-mapping-table">
          <table class="data-table">
            <thead>
              <tr>
                <th>中台调拨单账户号</th>
                <th>清结算系统银行账号</th>
                <th>执行操作</th>
              </tr>
            </thead>
            <tbody></tbody>
          </table>
        </div>
      `;
      const tbody = shell.content.querySelector('tbody');

      function showNestedAlert(message) {
        const alertOverlay = document.createElement('div');
        alertOverlay.className = 'modal-overlay';
        const card = document.createElement('section');
        card.className = 'modal-card alert-card';
        const body = document.createElement('div');
        body.className = 'alert-body';
        const textNode = document.createElement('div');
        textNode.className = 'alert-message';
        textNode.textContent = String(message || '操作失败');
        const actions = document.createElement('div');
        actions.className = 'dialog-actions center';
        const acknowledge = makeButton('确认', { primary: true });
        acknowledge.addEventListener('click', () => alertOverlay.remove());
        body.appendChild(textNode);
        actions.appendChild(acknowledge);
        card.append(body, actions);
        alertOverlay.appendChild(card);
        if (modalRoot) modalRoot.appendChild(alertOverlay);
        else openModal(alertOverlay);
      }

      function createReadOnlyRow(midAccountId, clearingAccountId) {
        const row = document.createElement('tr');
        row.dataset.positionMappingRow = 'true';
        const midCell = document.createElement('td');
        const clearingCell = document.createElement('td');
        const actionCell = document.createElement('td');
        actionCell.className = 'account-mapping-action-cell';
        const midText = document.createElement('span');
        const clearingText = document.createElement('span');
        midText.textContent = midAccountId;
        clearingText.textContent = clearingAccountId;
        const midInput = document.createElement('input');
        const clearingInput = document.createElement('input');
        for (const input of [midInput, clearingInput]) {
          input.type = 'text';
          input.spellcheck = false;
          input.className = 'mapping-text-input account-mapping-id-input';
          input.hidden = true;
        }
        midInput.value = midAccountId;
        clearingInput.value = clearingAccountId;
        const edit = makeTextButton('编辑', 'edit');
        const remove = makeTextButton('删除', 'remove', true);
        let editing = false;
        edit.addEventListener('click', () => {
          editing = !editing;
          midText.hidden = editing;
          clearingText.hidden = editing;
          midInput.hidden = !editing;
          clearingInput.hidden = !editing;
          edit.textContent = editing ? '完成' : '编辑';
          if (!editing) {
            midText.textContent = midInput.value;
            clearingText.textContent = clearingInput.value;
          } else {
            midInput.focus();
          }
        });
        remove.addEventListener('click', () => row.remove());
        midCell.append(midText, midInput);
        clearingCell.append(clearingText, clearingInput);
        actionCell.append(edit, remove);
        row.append(midCell, clearingCell, actionCell);
        row.__mapping = {
          midAccountId: () => midInput.value,
          clearingAccountId: () => clearingInput.value
        };
        return row;
      }

      function createEditableRow(midAccountId = '', clearingAccountId = '') {
        const row = document.createElement('tr');
        row.dataset.positionMappingRow = 'true';
        const midCell = document.createElement('td');
        const clearingCell = document.createElement('td');
        const actionCell = document.createElement('td');
        actionCell.className = 'account-mapping-action-cell';
        const midInput = document.createElement('input');
        const clearingInput = document.createElement('input');
        for (const input of [midInput, clearingInput]) {
          input.type = 'text';
          input.spellcheck = false;
          input.className = 'mapping-text-input account-mapping-id-input';
        }
        midInput.value = midAccountId;
        clearingInput.value = clearingAccountId;
        const done = makeTextButton('完成', 'done');
        const remove = makeTextButton('删除', 'remove', true);
        done.addEventListener('click', () => {
          row.replaceWith(createReadOnlyRow(midInput.value, clearingInput.value));
        });
        remove.addEventListener('click', () => row.remove());
        midCell.appendChild(midInput);
        clearingCell.appendChild(clearingInput);
        actionCell.append(done, remove);
        row.append(midCell, clearingCell, actionCell);
        row.__mapping = {
          midAccountId: () => midInput.value,
          clearingAccountId: () => clearingInput.value
        };
        return row;
      }

      function createAddRow() {
        const row = document.createElement('tr');
        row.className = 'add-row';
        const addCell = document.createElement('td');
        addCell.colSpan = 3;
        const add = makeTextButton('新增', 'add');
        add.addEventListener('click', () => {
          tbody.insertBefore(createEditableRow(), row);
        });
        addCell.appendChild(add);
        row.appendChild(addCell);
        return row;
      }

      for (const mapping of result.mappings || []) {
        tbody.appendChild(createReadOnlyRow(
          mapping.midAccountId || '',
          mapping.clearingAccountId || ''
        ));
      }
      tbody.appendChild(createAddRow());

      const save = makeButton('完成', { primary: true });
      const right = document.createElement('div');
      right.className = 'position-footer-right';
      right.appendChild(save);
      shell.footer.className = 'dialog-actions right';
      shell.footer.appendChild(right);
      save.addEventListener('click', async () => {
        const mappings = [...tbody.querySelectorAll('[data-position-mapping-row="true"]')]
          .map((row) => ({
            midAccountId: row.__mapping.midAccountId(),
            clearingAccountId: row.__mapping.clearingAccountId()
          }));
        save.disabled = true;
        let saved;
        try {
          saved = await withInflight('正在保存平盘账户映射…', () => api.saveMappings(mappings));
        } catch (error) {
          showNestedAlert(error && error.message ? error.message : '账户映射保存失败');
          return;
        } finally {
          save.disabled = false;
        }
        if (!saved || saved.status !== 'ok') {
          showNestedAlert(saved && saved.message ? saved.message : '账户映射保存失败');
          return;
        }
        closeSelf();
        if (typeof onChanged === 'function') await onChanged();
        setStatus(saved.message, 'success');
      });
      if (modalRoot) modalRoot.appendChild(shell.overlay);
      else openModal(shell.overlay);
    }

    function openRawExportDialog(rows) {
      const options = Array.isArray(rows) ? rows : [];
      if (options.length === 0) {
        showAlert('当前没有可导出的链接原始表', { info: true });
        return;
      }
      let shell;
      const closeSelf = () => shell && shell.overlay.remove();
      shell = createDialogShell(
        '导出链接原始表',
        'position-raw-export-dialog position-delete-source-dialog',
        closeSelf
      );
      shell.content.innerHTML = `
        <div class="position-form-row">
          <label for="positionExportRawSource">链接原始表</label>
          <select id="positionExportRawSource" class="main-panel-select-control">
            ${options.map((row, index) => `
              <option value="${index}">${escapeHtml(row.tableName)}</option>
            `).join('')}
          </select>
        </div>
      `;
      const select = shell.content.querySelector('#positionExportRawSource');
      const right = document.createElement('div');
      right.className = 'position-footer-right';
      const cancel = makeButton('取消');
      const exportButton = makeButton('导出', { primary: true });
      right.append(cancel, exportButton);
      shell.footer.append(document.createElement('span'), right);
      cancel.addEventListener('click', closeSelf);
      exportButton.addEventListener('click', async () => {
        const selected = options[Number(select.value)];
        if (!selected) {
          showAlert('请选择需要导出的链接原始表');
          return;
        }
        const exported = await withInflight('正在导出链接原始表…', () => (
          api.exportRaw(selected.sourceType, selected.tableName)
        ));
        if (!exported || exported.status === 'cancelled') return;
        if (exported.status !== 'ok') {
          showAlert(failureDetailsHtml(exported, '导出失败'), { html: true });
          return;
        }
        closeSelf();
        setStatus(`已导出 ${Number(exported.rowCount) || 0} 行${selected.tableName}`, 'success');
      });
      if (modalRoot) modalRoot.appendChild(shell.overlay);
      else openModal(shell.overlay);
    }

    async function openRawSourceDialog(previewData = null) {
      const result = previewData || await api.linkedManager();
      if (!result || result.status !== 'ok') {
        showAlert(failureDetailsHtml(result, '链接原始表读取失败'), { html: true });
        return;
      }
      const shell = createDialogShell('链接原始表', 'position-raw-dialog');
      function render() {
        shell.content.innerHTML = `
          <div class="table-wrapper position-manager-table">
            <table class="data-table">
              <thead><tr>
                <th style="width: 45%;">原始表名</th>
                <th style="width: 30%;">日期范围</th>
                <th style="width: 25%;">更新时间</th>
              </tr></thead>
              <tbody>
                ${(result.raw || []).map((row) => `
                  <tr>
                    <td>${escapeHtml(row.tableName)}</td>
                    <td>${escapeHtml(formatDateRange(row))}</td>
                    <td>${escapeHtml(row.updatedAt || '-')}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        `;
      }
      const right = document.createElement('div');
      right.className = 'position-footer-right';
      const exportButton = makeButton('导出', { primary: true });
      const back = makeButton('返回');
      right.append(exportButton, back);
      shell.footer.append(document.createElement('span'), right);
      exportButton.addEventListener('click', () => openRawExportDialog(result.raw));
      back.addEventListener('click', async () => {
        closeModal();
        await openLinkedManager();
      });
      render();
      openModal(shell.overlay);
    }

    async function openSourceDeleteDialog(data, reload) {
      const rows = (data.raw || []).filter((row) => (
        Number(row.rowCount) > 0 || Number(row.filteredRowCount) > 0
      ));
      if (rows.length === 0) {
        showAlert('当前没有可删除的链接原始表或活动过滤记录', { info: true });
        return;
      }
      const shell = createDialogShell('删除链接表数据', 'position-delete-source-dialog');
      shell.content.innerHTML = `
        <div class="position-form-row">
          <label for="positionDeleteSourceType">目标表</label>
          <select id="positionDeleteSourceType" class="main-panel-select-control">
            ${rows.map((row) => `<option value="${escapeHtml(row.sourceType)}">${escapeHtml(row.tableName)}${Number(row.rowCount) === 0 && Number(row.filteredRowCount) > 0 ? '（仅活动过滤记录）' : ''}</option>`).join('')}
          </select>
        </div>
        <div class="position-form-row" data-month-row>
          <label for="positionDeleteMonths">月份</label>
          <select id="positionDeleteMonths" class="main-panel-select-control" multiple></select>
        </div>
      `;
      const sourceSelect = shell.content.querySelector('#positionDeleteSourceType');
      const monthSelect = shell.content.querySelector('#positionDeleteMonths');
      const monthRow = shell.content.querySelector('[data-month-row]');
      function updateMonths() {
        const sourceType = sourceSelect.value;
        const months = data.sourceMonths && Array.isArray(data.sourceMonths[sourceType])
          ? data.sourceMonths[sourceType]
          : [];
        monthSelect.innerHTML = months.map((month) => `<option value="${escapeHtml(month)}" selected>${escapeHtml(month)}</option>`).join('');
        monthRow.hidden = sourceType === SOURCE_ACCOUNT;
      }
      sourceSelect.addEventListener('change', updateMonths);
      updateMonths();
      const right = document.createElement('div');
      right.className = 'position-footer-right';
      const cancel = makeButton('取消');
      const remove = makeButton('删除', { danger: true });
      right.append(cancel, remove);
      shell.footer.append(document.createElement('span'), right);
      cancel.addEventListener('click', closeModal);
      remove.addEventListener('click', async () => {
        const sourceType = sourceSelect.value;
        const selectedMonths = [...monthSelect.selectedOptions].map((option) => option.value);
        const wholeTable = sourceType === SOURCE_ACCOUNT;
        if (!wholeTable && selectedMonths.length === 0) {
          showAlert('请至少选择一个月份');
          return;
        }
        const accepted = await confirmAction(
          wholeTable
            ? '清结算银行账户表将整表清空，且相关草稿会失效。确认继续？'
            : '确认删除所选月份的链接原始表、派生链接及活动过滤记录？',
          wholeTable ? '确认整表删除' : '确认删除'
        );
        if (!accepted) return;
        const deleted = await withInflight('正在删除链接表数据…', () => api.deleteSource({
          sourceType,
          months: selectedMonths,
          wholeTable
        }));
        if (!deleted || deleted.status !== 'ok') {
          showAlert(failureDetailsHtml(deleted, '删除失败'), { html: true });
          return;
        }
        closeModal();
        if (typeof reload === 'function') await reload();
        setStatus(deleted.message, 'success');
      });
      openModal(shell.overlay);
    }

    function openLinkedExportDialog(rows) {
      const options = Array.isArray(rows) ? rows : [];
      if (options.length === 0) {
        showAlert('当前没有可导出的链接对账表', { info: true });
        return;
      }
      let shell;
      const closeSelf = () => shell && shell.overlay.remove();
      shell = createDialogShell(
        '导出链接对账表',
        'position-linked-export-dialog position-delete-source-dialog',
        closeSelf
      );
      shell.content.innerHTML = `
        <div class="position-form-row">
          <label for="positionExportLinkedSource">链接对账表</label>
          <select id="positionExportLinkedSource" class="main-panel-select-control">
            ${options.map((row, index) => `
              <option value="${index}">${escapeHtml(row.tableName)}</option>
            `).join('')}
          </select>
        </div>
      `;
      const select = shell.content.querySelector('#positionExportLinkedSource');
      const right = document.createElement('div');
      right.className = 'position-footer-right';
      const cancel = makeButton('取消');
      const exportButton = makeButton('导出', { primary: true });
      right.append(cancel, exportButton);
      shell.footer.append(document.createElement('span'), right);
      cancel.addEventListener('click', closeSelf);
      exportButton.addEventListener('click', async () => {
        const selected = options[Number(select.value)];
        if (!selected) {
          showAlert('请选择需要导出的链接对账表');
          return;
        }
        const exported = await withInflight('正在导出链接对账表…', () => (
          api.exportLinked(selected.sourceType, selected.tableName)
        ));
        if (!exported || exported.status === 'cancelled') return;
        if (exported.status !== 'ok') {
          showAlert(failureDetailsHtml(exported, '导出失败'), { html: true });
          return;
        }
        closeSelf();
        setStatus(`已导出 ${Number(exported.rowCount) || 0} 行${selected.tableName}`, 'success');
      });
      if (modalRoot) modalRoot.appendChild(shell.overlay);
      else openModal(shell.overlay);
    }

    async function openLinkedManager(previewData = null) {
      if (!ensureAvailable()) return;
      const result = previewData || await api.linkedManager();
      if (!result || result.status !== 'ok') {
        showAlert(failureDetailsHtml(result, '链接表管理读取失败'), { html: true });
        return;
      }
      const shell = createDialogShell('链接表管理', 'position-manager-dialog');
      async function reload() {
        const next = await api.linkedManager();
        if (next && next.status === 'ok') Object.assign(result, next);
        render();
      }
      function render() {
        shell.content.innerHTML = `
          <div class="table-wrapper position-manager-table">
            <table class="data-table">
              <thead><tr>
                <th style="width: 40%;">链接对账单名</th>
                <th style="width: 35%;">数据日期范围</th>
                <th style="width: 25%;">表库更新日期</th>
              </tr></thead>
              <tbody>
                ${(result.linked || []).map((row) => `
                  <tr>
                    <td>${escapeHtml(row.tableName)}</td>
                    <td>${escapeHtml(formatMonthRange(row))}</td>
                    <td>${escapeHtml(formatUpdatedDate(row.updatedAt))}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        `;
      }
      const left = document.createElement('div');
      left.className = 'position-footer-left';
      const raw = makeButton('链接原始表');
      const mappings = makeButton('账户映射管理');
      left.append(raw, mappings);
      const right = document.createElement('div');
      right.className = 'position-footer-right';
      const remove = makeButton('删除');
      const importButton = makeButton('导入', { primary: true });
      const exportButton = makeButton('导出');
      const back = makeButton('返回');
      right.append(remove, importButton, exportButton, back);
      shell.footer.append(left, right);
      raw.addEventListener('click', async () => {
        closeModal();
        await openRawSourceDialog();
      });
      mappings.addEventListener('click', () => openMappingsDialog(reload));
      remove.addEventListener('click', () => openSourceDeleteDialog(result, reload));
      importButton.addEventListener('click', async () => {
        closeModal();
        await handleSourceImport(null, openLinkedManager);
      });
      exportButton.addEventListener('click', () => openLinkedExportDialog(result.linked));
      back.addEventListener('click', closeModal);
      render();
      openModal(shell.overlay);
    }

    function bindEvents() {
      if (state.bound) return;
      state.bound = true;
      if (elements.runBtn) elements.runBtn.addEventListener('click', openRunScopeDialog);
      if (elements.dataManagerBtn) {
        elements.dataManagerBtn.addEventListener('click', () => openDataManager());
      }
      if (elements.linkedManagerBtn) {
        elements.linkedManagerBtn.addEventListener('click', () => openLinkedManager());
      }
      if (elements.configBtn) {
        elements.configBtn.addEventListener('click', () => {
          showAlert('对账配置管理将在后续版本开放', { info: true });
        });
      }
      if (elements.exportBtn) elements.exportBtn.addEventListener('click', () => openResultDialog());
      if (elements.functionSelect) {
        elements.functionSelect.addEventListener('change', () => {
          if (!isFundNatureSelected()) {
            setStatus('当前功能将在后续版本开放', 'info');
          } else {
            setStatus(statusSummary(state.status), 'info');
          }
          updateControls();
        });
      }
    }

    async function initialize() {
      bindEvents();
      await refresh();
    }

    function previewDataManager(initialTab = 'unarchived') {
      return openDataManager({
        status: 'ok',
        unarchived: [
          {
            tableName: '平盘银行对账单',
            rowCount: 1280,
            dateMin: '2026-06-01',
            dateMax: '2026-07-25',
            statuses: [
              { status: '未处理', rowCount: 960 },
              { status: '已校验性质', rowCount: 320 }
            ]
          },
          {
            tableName: '平盘交易对账单',
            rowCount: 0,
            disabled: true,
            message: '后续版本开放'
          }
        ],
        archived: [],
        differences: [
          {
            runId: 12,
            channel: 'DBS',
            region: 'HK',
            bankChannel: 'DBS-HK',
            monthKey: '2026-07',
            status: '待确认',
            differenceCount: 8
          },
          {
            runId: 9,
            channel: 'BOC',
            region: 'CN',
            bankChannel: 'BOC-CN',
            monthKey: '2026-06',
            status: '人工确认保留',
            differenceCount: 3
          }
        ],
        scopes: [
          { channel: 'DBS', monthKey: '2026-07', status: '未处理', rowCount: 960 },
          { channel: 'BOC', monthKey: '2026-06', status: '已校验性质', rowCount: 320 }
        ]
      }, initialTab);
    }

    function previewDifferenceManager() {
      return previewDataManager('differences');
    }

    function previewLinkedManagerData() {
      const linked = [
        ['fund-transfer', '中台调拨平盘对账单', 824, '2026-06-01', '2026-07-25'],
        ['test-payment', '中台测试付款对账单', 48, '2026-07-01', '2026-07-24'],
        ['gateway-inbound', '中台网关入账对账单', 3120, '2026-06-01', '2026-07-25'],
        ['gateway-outbound', '中台网关出账对账单', 2988, '2026-06-01', '2026-07-25'],
        ['bank-account', '清结算银行账户表', 166, '', '']
      ].map(([sourceType, tableName, rowCount, dateMin, dateMax]) => ({
        sourceType,
        tableName,
        rowCount,
        dateMin,
        dateMax,
        updatedAt: '2026-07-26T10:30:00.000Z'
      }));
      return {
        status: 'ok',
        linked,
        raw: linked.map((row) => ({
          ...row,
          tableName: row.sourceType === 'bank-account'
            ? '清结算银行账户表'
            : row.tableName.replace('平盘对账单', '订单表').replace('对账单', '原始订单'),
          updatedAt: '2026-07-26 10:30:00'
        })),
        sourceMonths: {
          'fund-transfer': ['2026-06', '2026-07'],
          'test-payment': ['2026-07'],
          'gateway-inbound': ['2026-06', '2026-07'],
          'gateway-outbound': ['2026-06', '2026-07'],
          'bank-account': []
        }
      };
    }

    function previewLinkedManager() {
      return openLinkedManager(previewLinkedManagerData());
    }

    function previewResultDialog() {
      return openResultDialog(12, {
        id: 12,
        stale: false,
        canExport: true,
        hasFilteredRows: true,
        filteredRowCount: 6,
        summary: {
          inputRows: 960,
          changedRows: 184,
          differenceRows: 8,
          preciseRows: 908,
          fuzzyRows: 44,
          notApplicableRows: 12,
          manualModifiedRows: 3
        }
      });
    }

    function previewMappingDialog() {
      return openMappingsDialog(null, {
        status: 'ok',
        mappings: [
          { midAccountId: 'MPT-DBS-USD', clearingAccountId: '001234567890' },
          { midAccountId: 'MPT-CITI-EUR', clearingAccountId: '009876543210' }
        ]
      });
    }

    function previewRawSourceDialog() {
      const data = previewLinkedManagerData();
      return openRawSourceDialog(data);
    }

    function previewSourceDeleteDialog() {
      const data = previewLinkedManagerData();
      return openSourceDeleteDialog(data, null);
    }

    function previewRunScopeDialog() {
      return openModal(createScopeDialog({
        title: '选择平盘资金性质校验范围',
        scopes: [
          { channel: 'DBS', monthKey: '2026-07', status: '未处理', rowCount: 960 },
          { channel: 'BOC', monthKey: '2026-06', status: '未处理', rowCount: 320 }
        ],
        confirmText: '开始运行',
        onConfirm: async () => {}
      }));
    }

    function previewImportProgress(stage = 'preflight') {
      return withImportProgress(
        '导入平盘银行对账单',
        () => new Promise(() => {}),
        {
          jobId: 'preview-position-import',
          stage,
          fileName: '渠道账单_2026-07.xlsx',
          currentFile: 2,
          totalFiles: 4,
          scannedRows: 1824567,
          acceptedRows: 1824401,
          committedRows: stage === 'committing' ? 1824401 : 960000,
          elapsedMs: 128000
        }
      );
    }

    return {
      initialize,
      refresh,
      bindEvents,
      openDataManager,
      openLinkedManager,
      openResultDialog,
      handleBankImport,
      handleSourceImport,
      previewDataManager,
      previewDifferenceManager,
      previewLinkedManager,
      previewRawSourceDialog,
      previewSourceDeleteDialog,
      previewRunScopeDialog,
      previewResultDialog,
      previewMappingDialog,
      previewImportProgress
    };
  }

  global.__positionReconciliation = {
    createPositionReconciliationUI,
    formatUpdatedDate,
    isImportCancelledResult
  };
}(window));
