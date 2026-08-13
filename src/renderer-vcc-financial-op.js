'use strict';

(() => {
  const api = window.desktopApi && window.desktopApi.vccFinancialOp;
  if (!api) return;
  const differenceApi = window.__vccFinancialOpDifference;

  const CURRENCIES = Object.freeze(['AUD', 'CAD', 'CNY', 'EUR', 'GBP', 'HKD', 'JPY', 'SGD', 'USD']);
  const SOURCE_LABELS = Object.freeze({
    recharge_refund: 'VCC充值清退明细',
    fee_fx: 'VCC费用及换汇明细',
    channel: 'VCC通道明细',
    pending_archive_removal: 'VCC_移除归档Pending账单',
    system_op: '系统财务OP'
  });
  const CHECK_TABLE_LABELS = Object.freeze({
    recharge_refund: 'VCC充值清退明细_校验表',
    fee_fx: 'VCC费用及换汇明细_校验表',
    channel: 'VCC通道明细_校验表',
    pending_archive_removal: '移除归档Pending账单_校验表',
    system_op: '系统财务OP'
  });
  const DELETE_TARGET_LABELS = Object.freeze({
    ...SOURCE_LABELS,
    opening_initialization: '首月期初初始化数据',
    result: '财务OP校验结果表'
  });
  const DISPOSITION_LABELS = Object.freeze({
    idempotent_skip: '幂等跳过',
    idempotent_conflict: '幂等冲突',
    invalid_key: '幂等键为空',
    format_error: '格式异常',
    rolled_back: '整表回滚'
  });
  const elements = {
    importBtn: document.getElementById('vccFinancialOpImportBtn'),
    runBtn: document.getElementById('vccFinancialOpRunBtn'),
    exportBtn: document.getElementById('vccFinancialOpExportBtn'),
    dataManagerBtn: document.getElementById('vccFinancialOpDataManagerBtn'),
    statusBox: document.getElementById('vccFinancialOpStatusBox'),
    modalRoot: document.getElementById('modalRoot')
  };
  if (!elements.importBtn || !elements.modalRoot) return;

  const state = {
    busy: false,
    busyKind: '',
    cancelRequested: false,
    lastMonth: '',
    latestArchivedRun: null
  };

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function formatDateTime(value) {
    if (!value) return '-';
    return String(value).replace('T', ' ').replace(/\.\d{3}Z$/, '');
  }

  function formatInteger(value) {
    return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 }).format(Number(value) || 0);
  }

  function requireImportCompletionResult(result) {
    const status = String(result && result.status || '').trim();
    const detailLines = result && Array.isArray(result.detailLines)
      ? result.detailLines.filter((line) => String(line || '').trim())
      : [];
    if (!result || !['success', 'completed_with_errors'].includes(status)) {
      const message = result && result.message
        ? result.message
        : `导入未开始或未完成（状态：${status || 'unknown'}）`;
      throw new Error([message, ...detailLines].join('\n'));
    }
    if (!Array.isArray(result.records)
        || result.records.length === 0
        || result.records.some((record) => !record || typeof record !== 'object')) {
      throw new Error('导入未生成任何导入记录，业务数据未写入');
    }
    return result;
  }

  function selectCachedDeletePreview(targets, targetType) {
    return (Array.isArray(targets) ? targets : [])
      .find((target) => target.targetType === targetType) || null;
  }

  function formatAmount(value) {
    const text = String(value == null ? '0' : value);
    const match = text.match(/^(-?)(\d+)(\.\d+)?$/);
    if (!match) return text;
    return `${match[1]}${match[2].replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${match[3] || ''}`;
  }

  function formatSystemOpSnapshotCount(value, compact = false) {
    const snapshots = Math.max(0, Number(value) || 0);
    const sourceRows = snapshots * CURRENCIES.length;
    return compact
      ? `${formatInteger(sourceRows)} 行 / ${formatInteger(snapshots)} 快照`
      : `${formatInteger(sourceRows)} 行币种数据（${formatInteger(snapshots)} 个主体快照）`;
  }

  function buildImportCompletionStatus(result, fallbackMonth = '') {
    const completed = requireImportCompletionResult(result);
    const records = completed.records;
    const systemRecords = records.filter((record) => record.sourceType === 'system_op');
    const detailRecords = records.filter((record) => record.sourceType !== 'system_op');
    const detailTotals = detailRecords.reduce((summary, record) => ({
      inserted: summary.inserted + (Number(record.insertedCount) || 0),
      skipped: summary.skipped + (Number(record.skippedCount) || 0),
      filtered: summary.filtered
        + (Number(record.invalidKeyCount) || 0)
        + (Number(record.conflictCount) || 0)
        + (Number(record.formatErrorCount) || 0)
    }), { inserted: 0, skipped: 0, filtered: 0 });
    const systemTotals = systemRecords.reduce((summary, record) => ({
      inserted: summary.inserted + (Number(record.insertedCount) || 0),
      skipped: summary.skipped + (Number(record.skippedCount) || 0),
      filtered: summary.filtered
        + (Number(record.invalidKeyCount) || 0)
        + (Number(record.conflictCount) || 0)
        + (Number(record.formatErrorCount) || 0)
    }), { inserted: 0, skipped: 0, filtered: 0 });
    const failedRecordCount = records.filter((record) => String(record.status).startsWith('failed')).length;
    const filteredCount = detailTotals.filtered + systemTotals.filtered;
    const month = String(completed.targetMonth || fallbackMonth || '当前账期');
    const details = [];
    if (detailRecords.length > 0) {
      const prefix = systemRecords.length > 0 ? '明细' : '';
      details.push(`${prefix}新增 ${formatInteger(detailTotals.inserted)} 行`);
      details.push(`${prefix}幂等跳过 ${formatInteger(detailTotals.skipped)} 行`);
      if (detailTotals.filtered > 0) {
        details.push(`${prefix}过滤异常 ${formatInteger(detailTotals.filtered)} 行`);
      }
    }
    if (systemRecords.length > 0) {
      details.push(`系统财务OP新增 ${formatSystemOpSnapshotCount(systemTotals.inserted)}`);
      const prefix = detailRecords.length > 0 ? '系统财务OP' : '';
      details.push(`${prefix}幂等跳过 ${formatSystemOpSnapshotCount(systemTotals.skipped)}`);
      if (systemTotals.filtered > 0) {
        details.push(`${prefix}过滤异常 ${formatInteger(systemTotals.filtered)} 个主体快照`);
      }
    }
    if (failedRecordCount > 0 || filteredCount > 0) {
      if (failedRecordCount > 0) {
        details.push(`待处理异常 ${formatInteger(failedRecordCount)} 条导入记录`);
      }
      details.push('详情见数据管理 → 校验原表');
    }
    return {
      message: `${month} 导入完成：${details.join('，')}`,
      tone: failedRecordCount > 0 || filteredCount > 0 ? 'warning' : 'success'
    };
  }

  function setStatus(message, tone = 'info') {
    const text = elements.statusBox && elements.statusBox.querySelector('.status-box-text');
    if (text) text.textContent = String(message || '');
    if (elements.statusBox) elements.statusBox.dataset.tone = tone;
  }

  function setBusy(busy, kind = '') {
    state.busy = Boolean(busy);
    state.busyKind = state.busy ? kind : '';
    elements.importBtn.disabled = state.busy && state.busyKind !== 'import';
    elements.importBtn.textContent = state.busyKind === 'import' ? '取消导入' : '导入文件';
    elements.runBtn.disabled = state.busy;
    elements.dataManagerBtn.disabled = state.busy;
    elements.exportBtn.disabled = state.busy || !state.latestArchivedRun;
  }

  function mountDialog({ title, className = '', bodyHtml = '', initialFocusSelector = '', onClose, canClose }) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay vcc-fin-op-overlay';
    const dialog = document.createElement('section');
    dialog.className = `modal-card vcc-fin-op-dialog ${className}`.trim();
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-label', title);
    dialog.innerHTML = `
      <div class="dialog-header">
        <div class="dialog-title">${escapeHtml(title)}</div>
        <button class="icon-close" type="button" data-action="close" aria-label="关闭">×</button>
      </div>
      <div class="vcc-fin-op-dialog-body">${bodyHtml}</div>
    `;
    overlay.appendChild(dialog);
    elements.modalRoot.appendChild(overlay);
    let closed = false;
    const close = () => {
      if (closed) return;
      if (typeof canClose === 'function' && !canClose()) return;
      closed = true;
      document.removeEventListener('keydown', onKeyDown);
      overlay.remove();
      if (typeof onClose === 'function') onClose();
    };
    const onKeyDown = (event) => {
      if (event.key === 'Escape') close();
    };
    document.addEventListener('keydown', onKeyDown);
    dialog.querySelector('[data-action="close"]').addEventListener('click', close);
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) close();
    });
    requestAnimationFrame(() => {
      const focusTarget = (initialFocusSelector && dialog.querySelector(initialFocusSelector))
        || dialog.querySelector('[aria-current="page"], input:not(:disabled), select:not(:disabled), button:not([data-action="close"]):not(:disabled)');
      if (focusTarget) focusTarget.focus();
    });
    return { overlay, dialog, body: dialog.querySelector('.vcc-fin-op-dialog-body'), close };
  }

  function attachPreviewStateTracker(modal, readSnapshot) {
    let pendingPreview = null;
    let previewPending = false;

    function trackPreviewState(task) {
      const pending = Promise.resolve(task);
      pendingPreview = pending;
      previewPending = true;
      pending.then(
        () => {
          if (pendingPreview === pending) previewPending = false;
        },
        () => {
          if (pendingPreview === pending) previewPending = false;
        }
      );
      pending.catch(() => {});
      return pending;
    }

    async function waitForPreviewState() {
      let observed = pendingPreview;
      while (observed) {
        await observed;
        if (observed === pendingPreview) break;
        observed = pendingPreview;
      }
      return {
        ...readSnapshot(),
        previewPending
      };
    }

    Object.defineProperties(modal, {
      trackPreviewState: {
        configurable: false,
        enumerable: false,
        writable: false,
        value: trackPreviewState
      },
      waitForPreviewState: {
        configurable: false,
        enumerable: false,
        writable: false,
        value: waitForPreviewState
      }
    });
    return modal;
  }

  function showMessage(title, message, tone = 'info') {
    const modal = mountDialog({
      title,
      className: 'vcc-fin-op-message-dialog',
      bodyHtml: `
        <p class="vcc-fin-op-message" data-tone="${escapeHtml(tone)}">${escapeHtml(message)}</p>
        <div class="dialog-actions right">
          <button class="primary-btn small" type="button" data-action="confirm">确定</button>
        </div>
      `
    });
    modal.dialog.querySelector('[data-action="confirm"]').addEventListener('click', modal.close);
  }

  function chooseImportMonth({ title, initial = '' }) {
    return new Promise((resolve) => {
      let value = null;
      const initialMatch = String(initial || '').match(/^(\d{4})-(0[1-9]|1[0-2])$/);
      const currentYear = new Date().getFullYear();
      const availableYears = [currentYear - 1, currentYear, currentYear + 1];
      const canReuseInitial = Boolean(initialMatch && availableYears.includes(Number(initialMatch[1])));
      const selectedYear = canReuseInitial ? initialMatch[1] : '';
      const selectedMonth = canReuseInitial ? initialMatch[2] : '';
      const yearOptions = availableYears
        .map((year) => `<option value="${year}"${String(year) === selectedYear ? ' selected' : ''}>${year} 年</option>`)
        .join('');
      const monthOptions = Array.from({ length: 12 }, (_, index) => {
        const month = String(index + 1).padStart(2, '0');
        return `<option value="${month}"${month === selectedMonth ? ' selected' : ''}>${index + 1} 月</option>`;
      }).join('');
      const modal = mountDialog({
        title,
        className: 'vcc-fin-op-import-month-dialog',
        initialFocusSelector: '[data-field="import-year"]',
        onClose: () => resolve(value),
        bodyHtml: `
          <div class="monthly-balance-time-picker pending-import-month-picker biz-op-recon-date-picker vcc-fin-op-import-month-picker">
            <select class="monthly-balance-year-select mapping-text-input biz-op-recon-date-year" data-field="import-year" aria-label="年份">
              ${selectedYear ? '' : '<option value="" selected disabled>年份</option>'}
              ${yearOptions}
            </select>
            <select class="monthly-balance-month-select mapping-text-input biz-op-recon-date-month" data-field="import-month" aria-label="月份">
              ${selectedMonth ? '' : '<option value="" selected disabled>月份</option>'}
              ${monthOptions}
            </select>
          </div>
          <p class="vcc-fin-op-field-error" data-role="error" hidden></p>
          <div class="dialog-actions center vcc-fin-op-import-month-actions">
            <button class="primary-btn small" type="button" data-action="confirm">确定</button>
            <button class="secondary-btn small" type="button" data-action="cancel">取消</button>
          </div>
        `
      });
      const yearSelect = modal.dialog.querySelector('[data-field="import-year"]');
      const monthSelect = modal.dialog.querySelector('[data-field="import-month"]');
      const error = modal.dialog.querySelector('[data-role="error"]');
      const confirm = () => {
        const selected = `${yearSelect && yearSelect.value || ''}-${monthSelect && monthSelect.value || ''}`;
        if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(selected)) {
          error.textContent = '请选择有效的月份账期';
          error.hidden = false;
          return;
        }
        value = selected;
        modal.close();
      };
      modal.dialog.querySelector('[data-action="cancel"]').addEventListener('click', modal.close);
      modal.dialog.querySelector('[data-action="confirm"]').addEventListener('click', confirm);
      [yearSelect, monthSelect].forEach((select) => {
        select.addEventListener('change', () => { error.hidden = true; });
        select.addEventListener('keydown', (event) => {
          if (event.key === 'Enter') confirm();
        });
      });
    });
  }

  function chooseMonth({ title, months = [], initial = '' }) {
    return new Promise((resolve) => {
      let value = null;
      const options = months.length > 0
        ? months.map((month) => `<option value="${escapeHtml(month)}"${month === initial ? ' selected' : ''}>${escapeHtml(month)}</option>`).join('')
        : '<option value="">暂无账期</option>';
      const modal = mountDialog({
        title,
        className: 'vcc-fin-op-compact-dialog',
        onClose: () => resolve(value),
        bodyHtml: `
          <select class="vcc-fin-op-input vcc-fin-op-run-month-input" data-field="month" aria-label="月份账期"${months.length === 0 ? ' disabled' : ''}>${options}</select>
          <p class="vcc-fin-op-field-error" data-role="error" hidden></p>
          <div class="dialog-actions right vcc-fin-op-run-month-actions">
            <button class="secondary-btn small" type="button" data-action="cancel">取消</button>
            <button class="primary-btn small" type="button" data-action="confirm"${months.length === 0 ? ' disabled' : ''}>确定</button>
          </div>
        `
      });
      const input = modal.dialog.querySelector('[data-field="month"]');
      const error = modal.dialog.querySelector('[data-role="error"]');
      const confirm = () => {
        const selected = String(input && input.value || '').trim();
        if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(selected)) {
          error.textContent = '请选择有效的月份账期';
          error.hidden = false;
          return;
        }
        value = selected;
        modal.close();
      };
      modal.dialog.querySelector('[data-action="cancel"]').addEventListener('click', modal.close);
      modal.dialog.querySelector('[data-action="confirm"]').addEventListener('click', confirm);
      if (input) input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') confirm();
      });
    });
  }

  function assignSubjects(files) {
    const pending = files.filter((file) => file.requiresSubject);
    if (pending.length === 0) return Promise.resolve(files.map((file) => ({ ...file, subject: '' })));
    return new Promise((resolve) => {
      let result = null;
      const rows = files.map((file, index) => `
        <div class="vcc-fin-op-file-row">
          <div class="vcc-fin-op-file-meta">
            <strong>${escapeHtml(file.fileName)}</strong>
            <span>${escapeHtml(SOURCE_LABELS[file.sourceType] || file.sourceType)} · ${escapeHtml(file.sheetName)}</span>
          </div>
          ${file.requiresSubject
            ? `<label class="vcc-fin-op-inline-field"><span>公司主体</span><input class="vcc-fin-op-input" data-subject-index="${index}" type="text" autocomplete="off"></label>`
            : '<span class="vcc-fin-op-subject-from-file">主体取自原表</span>'}
        </div>
      `).join('');
      const modal = mountDialog({
        title: '确认原表与公司主体',
        className: 'vcc-fin-op-subject-dialog',
        onClose: () => resolve(result),
        bodyHtml: `
          <div class="vcc-fin-op-file-list">${rows}</div>
          <p class="vcc-fin-op-field-error" data-role="error" hidden></p>
          <div class="dialog-actions right">
            <button class="secondary-btn small" type="button" data-action="cancel">取消</button>
            <button class="primary-btn small" type="button" data-action="confirm">继续导入</button>
          </div>
        `
      });
      const error = modal.dialog.querySelector('[data-role="error"]');
      modal.dialog.querySelector('[data-action="cancel"]').addEventListener('click', modal.close);
      modal.dialog.querySelector('[data-action="confirm"]').addEventListener('click', () => {
        const prepared = files.map((file, index) => {
          const input = modal.dialog.querySelector(`[data-subject-index="${index}"]`);
          return { ...file, subject: input ? input.value.trim() : '' };
        });
        const missing = prepared.filter((file) => file.requiresSubject && !file.subject);
        if (missing.length > 0) {
          error.textContent = 'VCC通道明细必须填写公司主体';
          error.hidden = false;
          return;
        }
        result = prepared;
        modal.close();
      });
    });
  }

  async function handleImport() {
    if (state.busy) return;
    setBusy(true, 'prepare-import');
    try {
      const month = await chooseImportMonth({ title: '选择导入账期', initial: state.lastMonth });
      if (!month) return;
      setBusy(true, 'import');
      setStatus('正在识别原表…', 'info');
      const picked = await api.pickFiles();
      if (!picked || picked.status === 'cancelled') {
        setStatus('已取消导入', 'info');
        return;
      }
      if (picked.status !== 'success') {
        const detailLines = Array.isArray(picked.detailLines)
          ? picked.detailLines.filter((line) => String(line || '').trim())
          : [];
        throw new Error([picked.message || '原表识别失败', ...detailLines].join('\n'));
      }
      const files = await assignSubjects(Array.isArray(picked.files) ? picked.files : []);
      if (!files) {
        setStatus('已取消导入', 'info');
        return;
      }
      const unsubscribe = api.onImportProgress((progress) => {
        const label = SOURCE_LABELS[progress.sourceType] || '原表';
        setStatus(`正在导入 ${label}：${formatInteger(progress.rows)} 行`, 'info');
      });
      let result;
      try {
        setBusy(true, 'import');
        setStatus('正在导入并校验幂等数据…', 'info');
        result = await api.importFiles({ targetMonth: month, files });
      } finally {
        if (typeof unsubscribe === 'function') unsubscribe();
      }
      const completion = buildImportCompletionStatus(result, month);
      state.lastMonth = month;
      setStatus(completion.message, completion.tone);
    } catch (error) {
      if (state.cancelRequested) {
        setStatus('导入已取消，未完成数据未进入有效数据集', 'warning');
        return;
      }
      setStatus(`导入失败：${error.message || error}`, 'error');
      showMessage('导入失败', error.message || String(error), 'error');
    } finally {
      state.cancelRequested = false;
      setBusy(false);
    }
  }

  async function handleCancelImport() {
    if (state.busyKind !== 'import' || state.cancelRequested) return;
    state.cancelRequested = true;
    elements.importBtn.disabled = true;
    elements.importBtn.textContent = '正在取消';
    setStatus('正在取消导入并回滚本次未完成数据…', 'warning');
    const result = await api.cancelTask();
    if (result && result.status === 'idle') state.cancelRequested = false;
    if (result && result.status === 'error') {
      state.cancelRequested = false;
      throw new Error(result.message || '取消导入失败');
    }
  }

  function blockedCalculationMessage(result) {
    const issueMessages = Array.isArray(result.issues)
      ? result.issues
        .map((issue) => String(issue && issue.message || '').trim())
        .filter(Boolean)
      : [];
    if (issueMessages.length > 0) return issueMessages.join('\n');
    if (result.code === 'active-imports') {
      return `账期内仍有 ${Array.isArray(result.activeImports) ? result.activeImports.length : 0} 个导入批次未结束。请等待导入完成后重新运行。`;
    }
    if (result.code === 'missing-datasets') {
      return `缺少必需原表：${(result.missing || []).join('、') || '未知'}。请补齐后重新运行。`;
    }
    if (result.code === 'unresolved-imports') {
      return `账期内仍有 ${Array.isArray(result.unresolved) ? result.unresolved.length : 0} 条未处理的失败导入记录。请在数据管理的“导入记录”中处理后重新运行。`;
    }
    if (result.code === 'month-already-archived') {
      return `${result.targetMonth} 已归档，原表和结果均不可再次计算或改写。`;
    }
    if (result.code === 'missing-opening-balance') {
      return `缺少上月 ${result.previousMonth || ''} 的归档财务OP余额，涉及主体：${(result.missingOpeningSubjects || []).join('、')}。需要人工初始化首月期初余额，系统不会按 0 或系统财务OP代替。`;
    }
    if (result.code === 'missing-system-subject') {
      return `缺少主体对应的系统财务OP：${(result.missingSystemSubjects || []).join('、')}。`;
    }
    if (result.code === 'subject-mismatch') {
      const missing = (result.missingSystemSubjects || []).join('、');
      const extra = (result.unexpectedSystemSubjects || []).join('、');
      return `参与运算主体不一致${missing ? `；缺少系统财务OP主体：${missing}` : ''}${extra ? `；系统财务OP多出主体：${extra}` : ''}。`;
    }
    if (result.code === 'active-vcc-task') return result.message || '已有 VCC 财务OP任务正在运行。';
    if (result.code === 'preflight-required') {
      return result.message || '缺少有效的运行前检查凭证，请刷新数据并重新确认后再运行。';
    }
    if (result.code === 'state-changed') return result.message || '数据状态已变化，请刷新并重新确认。';
    return result.message || '当前数据不满足计算条件。';
  }

  function requestOpeningInitialization(result) {
    return new Promise((resolve) => {
      let payload = null;
      const subjects = Array.isArray(result.missingOpeningSubjects)
        ? result.missingOpeningSubjects
        : [];
      const sections = subjects.map((subject) => `
        <section class="vcc-fin-op-opening-section">
          <h3>${escapeHtml(subject)}</h3>
          <div class="vcc-fin-op-opening-grid">
            ${CURRENCIES.map((currency) => `
              <label class="vcc-fin-op-field">
                <span>${currency}</span>
                <input class="vcc-fin-op-input" type="text" inputmode="decimal"
                  autocomplete="off" data-opening-subject="${escapeHtml(subject)}"
                  data-opening-currency="${currency}" placeholder="必填">
              </label>
            `).join('')}
          </div>
        </section>
      `).join('');
      const modal = mountDialog({
        title: `初始化 ${result.targetMonth} 期初财务OP`,
        className: 'vcc-fin-op-opening-dialog',
        onClose: () => resolve(payload),
        bodyHtml: `
          <p class="vcc-fin-op-message" data-tone="warning">${escapeHtml(result.previousMonth || '上月')} 没有已归档余额。请按已核对的账务依据填写固定九币种期初余额；保存后不可修改。</p>
          <div class="vcc-fin-op-opening-scroll">${sections}</div>
          <label class="vcc-fin-op-field vcc-fin-op-opening-note">
            <span>核对说明</span>
            <textarea class="vcc-fin-op-input vcc-fin-op-textarea" data-field="opening-note" rows="3" maxlength="500" placeholder="填写余额来源和核对结论"></textarea>
          </label>
          <label class="vcc-fin-op-confirm-check"><input type="checkbox" data-field="opening-confirm">已逐主体核对九币种期初余额，确认一次性初始化</label>
          <p class="vcc-fin-op-field-error" data-role="error" hidden></p>
          <div class="dialog-actions right">
            <button class="secondary-btn small" type="button" data-action="cancel">取消</button>
            <button class="primary-btn small" type="button" data-action="initialize" disabled>确认初始化</button>
          </div>
        `
      });
      const checkbox = modal.dialog.querySelector('[data-field="opening-confirm"]');
      const confirmButton = modal.dialog.querySelector('[data-action="initialize"]');
      const error = modal.dialog.querySelector('[data-role="error"]');
      checkbox.addEventListener('change', () => { confirmButton.disabled = !checkbox.checked; });
      modal.dialog.querySelector('[data-action="cancel"]').addEventListener('click', modal.close);
      confirmButton.addEventListener('click', () => {
        const note = modal.dialog.querySelector('[data-field="opening-note"]').value.trim();
        const entries = subjects.map((subject) => {
          const balances = {};
          for (const currency of CURRENCIES) {
            const input = modal.dialog.querySelector(
              `[data-opening-subject="${CSS.escape(subject)}"][data-opening-currency="${currency}"]`
            );
            balances[currency] = input ? input.value.trim() : '';
          }
          return { subject, balances };
        });
        const hasBlank = entries.some((entry) => CURRENCIES.some((currency) => entry.balances[currency] === ''));
        if (hasBlank || !note) {
          error.textContent = hasBlank ? '九个币种余额均需填写，零余额请填写 0' : '请填写核对说明';
          error.hidden = false;
          return;
        }
        payload = { targetMonth: result.targetMonth, entries, note };
        modal.close();
      });
    });
  }

  function runStatusOf(result) {
    return String(result && (result.runStatus || result.status) || '');
  }

  function normalizeRunResponse(response) {
    if (!response || response.status !== 'success') {
      const error = new Error(response && response.message || '读取完整结果失败');
      error.code = response && response.code || null;
      throw error;
    }
    return { ...response, status: response.runStatus };
  }

  function isZeroAmount(value) {
    if (!differenceApi || typeof differenceApi.isEffectiveDifferenceZero !== 'function') {
      throw new Error('生效差异共享判定组件缺失，已禁止核对和导出。');
    }
    return differenceApi.isEffectiveDifferenceZero(value);
  }

  function isCanonicalReviewAmount(value) {
    if (typeof value !== 'string' || value === '-0') return false;
    if (!/^-?(?:0|[1-9]\d*)(?:\.\d*[1-9])?$/.test(value)) return false;
    const fraction = value.includes('.') ? value.slice(value.indexOf('.') + 1) : '';
    if (fraction.length > 2) return false;
    return value.replace(/[-.]/g, '').length <= 15;
  }

  function validateResultReview(result) {
    const currencies = result && result.review && Array.isArray(result.review.currencies)
      ? result.review.currencies
      : null;
    if (!currencies || JSON.stringify(currencies) !== JSON.stringify(CURRENCIES)) {
      throw new Error('完整结果币种契约异常，已禁止核对和归档。');
    }
    const subjects = Array.isArray(result.review.subjects) ? result.review.subjects : [];
    if (subjects.length === 0) throw new Error('完整结果缺少主体，已禁止核对和归档。');
    for (const subjectResult of subjects) {
      if (!subjectResult || !String(subjectResult.subject || '').trim()) {
        throw new Error('完整结果包含空主体，已禁止核对和归档。');
      }
      const summaries = subjectResult.summaries;
      for (const summaryKey of [
        'openingBalance',
        'effectiveCalculatedBalance',
        'systemBalance',
        'effectiveDifference'
      ]) {
        if (!summaries || !summaries[summaryKey] || typeof summaries[summaryKey] !== 'object') {
          throw new Error(`${subjectResult.subject} 缺少 ${summaryKey} 汇总，已禁止核对和归档。`);
        }
        for (const currency of currencies) {
          if (!Object.hasOwn(summaries[summaryKey], currency)) {
            throw new Error(`${subjectResult.subject} ${summaryKey} 缺少 ${currency}，已禁止核对和归档。`);
          }
          if (!isCanonicalReviewAmount(summaries[summaryKey][currency])) {
            throw new Error(`${subjectResult.subject} ${currency} ${summaryKey} 金额契约异常，已禁止核对和归档。`);
          }
        }
      }
    }
    return { currencies, subjects };
  }

  function resultReviewHtml(result) {
    const { currencies, subjects } = validateResultReview(result);
    const summaryLabels = [
      ['openingBalance', '期初财务OP'],
      ['effectiveCalculatedBalance', '当月计算财务OP'],
      ['systemBalance', '系统财务OP'],
      ['effectiveDifference', '差异']
    ];
    return subjects.map((subjectResult) => {
      const subject = subjectResult.subject || '';
      const rows = Array.isArray(subjectResult.rows) ? subjectResult.rows : [];
      const summaries = subjectResult.summaries || {};
      const detailRows = rows.map((row) => {
        const adjustment = row.type === 'adjustment';
        const currencyAmounts = row.currencyAmounts || {};
        return `
          <tr class="${adjustment ? 'vcc-fin-op-adjustment-row' : 'vcc-fin-op-base-row'}">
            <td>${escapeHtml(row.subject || subject)}</td>
            <td>${escapeHtml(row.categoryMajor || '-')}</td>
            <td>
              <span>${escapeHtml(row.categoryMinor || '-')}</span>
              <small class="vcc-fin-op-source-label">${escapeHtml(row.sourceLabel || SOURCE_LABELS[row.sourceType] || row.sourceType || '-')}</small>
              ${adjustment ? '<span class="vcc-fin-op-adjustment-badge">人工调整</span>' : ''}
            </td>
            ${currencies.map((currency) => {
              const amount = currencyAmounts[currency];
              return `<td class="number vcc-fin-op-stat-cell">${amount === null || amount === undefined ? '-' : escapeHtml(formatAmount(amount))}</td>`;
            }).join('')}
            <td class="number vcc-fin-op-stat-cell">${adjustment ? escapeHtml(formatAmount(row.adjustmentAmount)) : '-'}</td>
            <td class="vcc-fin-op-adjustment-reason">${adjustment ? escapeHtml(row.reason) : '-'}</td>
          </tr>
        `;
      }).join('');
      const summaryRows = summaryLabels.map(([key, label]) => {
        const amounts = summaries[key] || {};
        const differenceRow = key === 'effectiveDifference';
        return `
          <tr class="vcc-fin-op-summary-row${differenceRow ? ' difference-row' : ''}">
            <td>${escapeHtml(subject)}</td>
            <th colspan="2">${label}</th>
            ${currencies.map((currency) => {
              const amount = amounts[currency];
              const balanced = differenceRow && isZeroAmount(amount);
              const display = balanced ? '-' : formatAmount(amount);
              return `<td class="number vcc-fin-op-stat-cell">${escapeHtml(display)}</td>`;
            }).join('')}
            <td class="vcc-fin-op-stat-cell">-</td><td>-</td>
          </tr>
        `;
      }).join('');
      return `
        <section class="vcc-fin-op-result-section" data-subject="${escapeHtml(subject)}">
          <h3>${escapeHtml(subject)}</h3>
          <div class="vcc-fin-op-table-wrap">
            <table class="vcc-fin-op-table vcc-fin-op-full-result-table">
              <thead><tr>
                <th>主体</th><th>大类</th><th>分类</th>
                ${currencies.map((currency) => {
                  const balanced = isZeroAmount(summaries.effectiveDifference[currency]);
                  return `<th class="vcc-fin-op-stat-heading ${balanced ? 'balanced' : 'unbalanced'}">${currency}</th>`;
                }).join('')}
                <th class="vcc-fin-op-stat-heading">调整值</th><th>调整原因</th>
              </tr></thead>
              <tbody>${detailRows}${summaryRows}</tbody>
            </table>
          </div>
        </section>
      `;
    }).join('');
  }

  function reviewFailureDisposition(action, code) {
    const normalizedAction = String(action || '');
    const normalizedCode = String(code || '');
    if (normalizedCode === 'result-recalculation-required') {
      return Object.freeze({ refetch: false, poisonReview: true, disableModify: true });
    }
    if (normalizedCode === 'result-revision-changed') {
      return Object.freeze({ refetch: true, poisonReview: false, disableModify: false });
    }
    if (normalizedAction === 'modify') {
      return Object.freeze({
        refetch: normalizedCode === 'adjustment-locked',
        poisonReview: false,
        disableModify: normalizedCode === 'adjustment-options-empty'
      });
    }
    return Object.freeze({
      refetch: false,
      poisonReview: normalizedCode !== 'active-vcc-task',
      disableModify: false
    });
  }

  function normalizeResponseDetailLines(detailLines) {
    return (Array.isArray(detailLines) ? detailLines : [])
      .filter((line) => typeof line === 'string')
      .map((line) => line.trim())
      .filter(Boolean);
  }

  function responseFailure(response, fallbackMessage) {
    const error = new Error(response && response.message || fallbackMessage);
    error.code = response && response.code || null;
    error.detailLines = normalizeResponseDetailLines(response && response.detailLines);
    return error;
  }

  function responseFailureDisplayMessage(error) {
    const message = error && error.message ? error.message : String(error);
    const detailLines = normalizeResponseDetailLines(error && error.detailLines);
    return [message, ...detailLines].join('；');
  }

  function resultOperationProgressMessage(progress) {
    const actionLabels = {
      adjustment: '修改结果',
      archive: '确认归档',
      unarchive: '解归档',
      delete: '删除数据'
    };
    const action = actionLabels[progress && progress.action] || '处理数据';
    const phase = String(progress && progress.phase || '');
    const phaseLabels = {
      validating: '正在校验锁定证据',
      applying: '正在写入受保护事务',
      verifying: '正在核对写后状态',
      'preserving-audit': '正在保全审计证据',
      committed: '操作完成',
      completed: '操作完成'
    };
    return `${action}：${phaseLabels[phase] || '正在处理'}`;
  }

  async function requestRunAdjustment(result, previewResponse = null) {
    const response = previewResponse || await api.listAdjustmentOptions({ runId: result.runId });
    if (!response || response.status !== 'success') {
      const error = new Error(response && response.message || '读取可调整结果行失败');
      error.code = response && response.code || null;
      throw error;
    }
    if (response.runStatus !== 'calculated') {
      const error = new Error('已归档结果不能修改，请先解归档。');
      error.code = 'adjustment-locked';
      throw error;
    }
    if (response.resultRevision !== result.resultRevision) {
      const error = new Error('结果已发生变化，请重新核对后归档。');
      error.code = 'result-revision-changed';
      throw error;
    }
    const options = Array.isArray(response.options)
      ? response.options.map((row, index) => ({ ...row, optionToken: String(index) }))
      : [];
    if (options.length === 0) {
      const error = new Error('当前结果没有尚未调整的业务发生额坐标。');
      error.code = 'adjustment-options-empty';
      throw error;
    }

    return new Promise((resolve) => {
      let outcome = null;
      let saving = false;
      let operationCancellable = false;
      const modal = mountDialog({
        title: '修改结果',
        className: 'vcc-fin-op-adjustment-dialog',
        initialFocusSelector: '[data-field="adjustment-subject"]',
        canClose: () => !saving,
        onClose: () => resolve(outcome),
        bodyHtml: `
          <p class="vcc-fin-op-summary-line">调整作为独立审计行保存，不覆盖基础结果；同一结果行的同一币种只能调整一次。</p>
          <div class="vcc-fin-op-adjustment-form">
            <label class="vcc-fin-op-field"><span>主体</span><select class="vcc-fin-op-input" data-field="adjustment-subject"></select></label>
            <label class="vcc-fin-op-field"><span>大类</span><select class="vcc-fin-op-input" data-field="adjustment-major" disabled></select></label>
            <label class="vcc-fin-op-field"><span>分类</span><select class="vcc-fin-op-input" data-field="adjustment-minor" disabled></select></label>
            <label class="vcc-fin-op-field"><span>币种</span><select class="vcc-fin-op-input" data-field="adjustment-currency" disabled></select></label>
            <label class="vcc-fin-op-field"><span>调整值</span><input class="vcc-fin-op-input" data-field="adjustment-amount" type="text" inputmode="decimal" autocomplete="off" placeholder="例如 1,234.56 或 (1234.56)"></label>
            <label class="vcc-fin-op-field vcc-fin-op-adjustment-reason-field"><span>调整原因</span><textarea class="vcc-fin-op-input vcc-fin-op-textarea" data-field="adjustment-reason" rows="3" placeholder="必填，1～500 字"></textarea></label>
          </div>
          <p class="vcc-fin-op-field-error" data-role="adjustment-error" hidden></p>
          <div class="dialog-actions right">
            <button class="secondary-btn small" type="button" data-action="cancel-adjustment">取消</button>
            <button class="primary-btn small" type="button" data-action="confirm-adjustment" disabled>确认</button>
          </div>
        `
      });
      const subjectSelect = modal.dialog.querySelector('[data-field="adjustment-subject"]');
      const majorSelect = modal.dialog.querySelector('[data-field="adjustment-major"]');
      const minorSelect = modal.dialog.querySelector('[data-field="adjustment-minor"]');
      const currencySelect = modal.dialog.querySelector('[data-field="adjustment-currency"]');
      const amountInput = modal.dialog.querySelector('[data-field="adjustment-amount"]');
      const reasonInput = modal.dialog.querySelector('[data-field="adjustment-reason"]');
      const errorText = modal.dialog.querySelector('[data-role="adjustment-error"]');
      const confirmBtn = modal.dialog.querySelector('[data-action="confirm-adjustment"]');
      const cancelBtn = modal.dialog.querySelector('[data-action="cancel-adjustment"]');
      const closeBtn = modal.dialog.querySelector('[data-action="close"]');

      function resetSelect(select, placeholder, disabled = true) {
        select.innerHTML = `<option value="" selected disabled>${escapeHtml(placeholder)}</option>`;
        select.disabled = disabled;
      }

      function addSelectOption(select, value, label, rowKey = '') {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = label;
        if (rowKey) option.dataset.rowKey = rowKey;
        select.appendChild(option);
      }

      function selectedTarget() {
        const selectedOption = minorSelect.selectedOptions && minorSelect.selectedOptions[0];
        const token = selectedOption && selectedOption.value;
        return options.find((row) => row.optionToken === token) || null;
      }

      function updateConfirmState() {
        const complete = Boolean(
          selectedTarget()
          && currencySelect.value
          && amountInput.value.trim()
          && reasonInput.value.trim()
        );
        confirmBtn.disabled = saving || !complete;
      }

      function renderSubjects() {
        resetSelect(subjectSelect, '请选择主体', false);
        for (const subject of [...new Set(options.map((row) => row.subject))]) {
          addSelectOption(subjectSelect, subject, subject);
        }
        resetSelect(majorSelect, '请先选择主体');
        resetSelect(minorSelect, '请先选择大类');
        resetSelect(currencySelect, '请先选择分类');
      }

      function renderMajors() {
        const subjectRows = options.filter((row) => row.subject === subjectSelect.value);
        resetSelect(majorSelect, '请选择大类', subjectRows.length === 0);
        for (const major of [...new Set(subjectRows.map((row) => row.categoryMajor))]) {
          addSelectOption(majorSelect, major, major || '（空）');
        }
        resetSelect(minorSelect, '请先选择大类');
        resetSelect(currencySelect, '请先选择分类');
        updateConfirmState();
      }

      function renderMinors() {
        const rows = options.filter((row) => (
          row.subject === subjectSelect.value && row.categoryMajor === majorSelect.value
        ));
        const duplicateCounts = new Map();
        for (const row of rows) {
          const key = String(row.categoryMinor || '');
          duplicateCounts.set(key, (duplicateCounts.get(key) || 0) + 1);
        }
        resetSelect(minorSelect, '请选择分类', rows.length === 0);
        for (const row of rows) {
          const minorLabel = row.categoryMinor || '（空）';
          const label = duplicateCounts.get(String(row.categoryMinor || '')) > 1
            ? `${minorLabel}（${row.sourceLabel || SOURCE_LABELS[row.sourceType] || row.sourceType}）`
            : minorLabel;
          addSelectOption(minorSelect, row.optionToken, label, row.rowKey);
        }
        resetSelect(currencySelect, '请先选择分类');
        updateConfirmState();
      }

      function renderCurrencies() {
        const target = selectedTarget();
        const available = target && Array.isArray(target.availableCurrencies)
          ? target.availableCurrencies
          : [];
        resetSelect(currencySelect, '请选择币种', available.length === 0);
        for (const currency of CURRENCIES) {
          if (available.includes(currency)) addSelectOption(currencySelect, currency, currency);
        }
        updateConfirmState();
      }

      function setAdjustmentLocked(locked) {
        if (!locked) operationCancellable = false;
        saving = locked;
        for (const control of [
          subjectSelect, majorSelect, minorSelect, currencySelect,
          amountInput, reasonInput, confirmBtn, closeBtn
        ]) control.disabled = locked;
        cancelBtn.disabled = locked && !operationCancellable;
        cancelBtn.textContent = locked && operationCancellable ? '取消操作' : '取消';
        if (!locked) {
          subjectSelect.disabled = false;
          majorSelect.disabled = !subjectSelect.value;
          minorSelect.disabled = !majorSelect.value;
          currencySelect.disabled = !selectedTarget();
          updateConfirmState();
        }
      }

      function setAdjustmentCancellable(cancellable) {
        operationCancellable = saving && cancellable === true;
        cancelBtn.disabled = saving && !operationCancellable;
        cancelBtn.textContent = operationCancellable ? '取消操作' : '取消';
      }

      subjectSelect.addEventListener('change', renderMajors);
      majorSelect.addEventListener('change', renderMinors);
      minorSelect.addEventListener('change', renderCurrencies);
      currencySelect.addEventListener('change', updateConfirmState);
      amountInput.addEventListener('input', updateConfirmState);
      reasonInput.addEventListener('input', updateConfirmState);
      cancelBtn.addEventListener('click', async () => {
        if (!saving) {
          modal.close();
          return;
        }
        if (!operationCancellable) return;
        setAdjustmentCancellable(false);
        errorText.textContent = '正在取消修改结果…';
        errorText.hidden = false;
        try {
          await api.cancelTask();
        } catch (error) {
          errorText.textContent = `取消失败：${error.message || String(error)}`;
        }
      });
      confirmBtn.addEventListener('click', async () => {
        const target = selectedTarget();
        const reason = reasonInput.value.trim();
        if (!target || !currencySelect.value || !amountInput.value.trim() || !reason) return;
        if (Array.from(reason).length > 500) {
          errorText.textContent = '调整原因不能超过 500 个字符';
          errorText.hidden = false;
          return;
        }
        const selectedOption = minorSelect.selectedOptions[0];
        const rowKey = selectedOption && selectedOption.dataset.rowKey;
        const previousBusy = { busy: state.busy, kind: state.busyKind };
        setAdjustmentLocked(true);
        setBusy(true, 'adjustment');
        errorText.hidden = true;
        const stopProgress = typeof api.onOperationProgress === 'function'
          ? api.onOperationProgress((progress) => {
            if (!progress || progress.action !== 'adjustment') return;
            setAdjustmentCancellable(progress.cancellable === true);
            errorText.textContent = resultOperationProgressMessage(progress);
            errorText.hidden = false;
          })
          : null;
        try {
          const saved = await api.addRunAdjustment({
            runId: result.runId,
            rowKey,
            currency: currencySelect.value,
            adjustmentAmount: amountInput.value.trim(),
            reason,
            expectedResultRevision: result.resultRevision,
            expectedPreviewToken: result.previewTokens && result.previewTokens.adjustment,
            taskGeneration: result.taskGeneration
          });
          if (!saved || saved.status !== 'success') {
            if (saved && ['result-revision-changed', 'adjustment-locked'].includes(saved.code)) {
              outcome = {
                status: saved.code === 'adjustment-locked' ? 'locked' : 'stale',
                message: saved.message
              };
              saving = false;
              modal.close();
              return;
            }
            throw responseFailure(saved, '保存调整失败');
          }
          outcome = { status: 'saved', result: saved };
          saving = false;
          modal.close();
        } catch (error) {
          if (['result-revision-changed', 'adjustment-locked'].includes(error.code)) {
            outcome = {
              status: error.code === 'adjustment-locked' ? 'locked' : 'stale',
              message: error.message
            };
            saving = false;
            modal.close();
            return;
          }
          errorText.textContent = error.code === 'operation-cancelled'
            ? '修改结果已取消，未写入任何调整。'
            : (error.message || String(error));
          errorText.hidden = false;
        } finally {
          if (typeof stopProgress === 'function') stopProgress();
          setBusy(previousBusy.busy, previousBusy.kind);
          if (!outcome) setAdjustmentLocked(false);
        }
      });
      renderSubjects();
      updateConfirmState();
    });
  }

  function confirmArchive(initialResult) {
    return new Promise((resolve) => {
      let currentResult = initialResult;
      let completion = null;
      let operating = false;
      let operationCancellable = false;
      let reviewHealthy = true;
      let adjustmentAvailable = true;
      const modal = mountDialog({
        title: `${initialResult.targetMonth} 财务OP校验结果确认`,
        className: 'vcc-fin-op-review-dialog',
        canClose: () => !operating,
        onClose: () => resolve(completion || { status: 'closed', run: currentResult }),
        bodyHtml: `
          <p class="vcc-fin-op-summary-line">确认归档后，该账期的原表与结果不可改写；本月生效计算余额将成为下月期初余额。</p>
          <p class="vcc-fin-op-review-state" data-role="review-state" data-tone="neutral"></p>
          <div class="vcc-fin-op-result-scroll" data-role="review-result"></div>
          <label class="vcc-fin-op-confirm-check" data-role="archive-confirm-row"><input type="checkbox" data-field="archive-confirm">已核对当前完整结果，确认归档</label>
          <div class="dialog-actions split vcc-fin-op-review-actions">
            <div class="vcc-fin-op-review-actions-left"><button class="secondary-btn small" type="button" data-action="modify-result">修改结果</button></div>
            <div class="vcc-fin-op-review-actions-right">
              <button class="secondary-btn small" type="button" data-action="cancel">关闭</button>
              <button class="primary-btn small" type="button" data-action="archive" disabled>确认归档</button>
            </div>
          </div>
        `
      });
      const resultHost = modal.dialog.querySelector('[data-role="review-result"]');
      const reviewState = modal.dialog.querySelector('[data-role="review-state"]');
      const confirmRow = modal.dialog.querySelector('[data-role="archive-confirm-row"]');
      const checkbox = modal.dialog.querySelector('[data-field="archive-confirm"]');
      const archiveBtn = modal.dialog.querySelector('[data-action="archive"]');
      const modifyBtn = modal.dialog.querySelector('[data-action="modify-result"]');
      const cancelBtn = modal.dialog.querySelector('[data-action="cancel"]');
      const closeBtn = modal.dialog.querySelector('[data-action="close"]');

      function setReviewState(message, tone = 'neutral') {
        reviewState.textContent = String(message || '');
        reviewState.dataset.tone = tone;
      }

      function renderCurrentResult(message = '', tone = 'neutral') {
        const status = runStatusOf(currentResult);
        checkbox.checked = false;
        try {
          resultHost.innerHTML = resultReviewHtml(currentResult);
        } catch (error) {
          resultHost.innerHTML = `<div class="vcc-fin-op-empty">${escapeHtml(error.message || String(error))}</div>`;
          confirmRow.hidden = true;
          archiveBtn.hidden = true;
          modifyBtn.hidden = true;
          reviewHealthy = false;
          setReviewState(error.message || String(error), 'error');
          return false;
        }
        const editable = status === 'calculated';
        confirmRow.hidden = !editable;
        archiveBtn.hidden = !editable;
        modifyBtn.hidden = !editable;
        archiveBtn.disabled = true;
        reviewHealthy = true;
        adjustmentAvailable = editable;
        setReviewState(
          message || (editable
            ? `当前结果版本 ${currentResult.resultRevision}，请核对后归档。`
            : '该结果已归档，当前为只读查看。'),
          message ? tone : (editable ? 'neutral' : 'success')
        );
        return true;
      }

      function setReviewLocked(locked) {
        if (!locked) operationCancellable = false;
        operating = locked;
        closeBtn.disabled = locked;
        cancelBtn.disabled = locked && !operationCancellable;
        cancelBtn.textContent = locked && operationCancellable ? '取消操作' : '关闭';
        modifyBtn.disabled = locked || !reviewHealthy || !adjustmentAvailable
          || runStatusOf(currentResult) !== 'calculated';
        checkbox.disabled = locked || !reviewHealthy || runStatusOf(currentResult) !== 'calculated';
        archiveBtn.disabled = locked || !reviewHealthy || !checkbox.checked;
      }

      function setReviewCancellable(cancellable) {
        operationCancellable = operating && cancellable === true;
        cancelBtn.disabled = operating && !operationCancellable;
        cancelBtn.textContent = operationCancellable ? '取消操作' : '关闭';
      }

      async function refetchCurrentResult(message, tone) {
        try {
          const response = await api.getRun({ runId: currentResult.runId });
          currentResult = normalizeRunResponse(response);
          renderCurrentResult(message, tone);
        } catch (error) {
          if (error && typeof error === 'object') error.reviewRefetchFailed = true;
          throw error;
        }
      }

      checkbox.addEventListener('change', () => {
        archiveBtn.disabled = operating || !reviewHealthy || !checkbox.checked;
      });
      cancelBtn.addEventListener('click', async () => {
        if (!operating) {
          modal.close();
          return;
        }
        if (!operationCancellable) return;
        setReviewCancellable(false);
        setReviewState('正在取消归档…', 'warning');
        try {
          await api.cancelTask();
        } catch (error) {
          setReviewState(`取消失败：${error.message || String(error)}`, 'error');
        }
      });
      modifyBtn.addEventListener('click', async () => {
        if (modifyBtn.disabled || runStatusOf(currentResult) !== 'calculated') return;
        setReviewLocked(true);
        setReviewState('正在读取当前 run 的可调整坐标…', 'warning');
        try {
          const adjustmentOutcome = await requestRunAdjustment(currentResult);
          if (adjustmentOutcome && adjustmentOutcome.status === 'saved') {
            await refetchCurrentResult('调整已保存，请重新核对完整结果后归档。', 'success');
          } else if (adjustmentOutcome && ['stale', 'locked'].includes(adjustmentOutcome.status)) {
            await refetchCurrentResult(
              adjustmentOutcome.message || (adjustmentOutcome.status === 'locked'
                ? '已归档结果不能修改，请先解归档。'
                : '结果已发生变化，请重新核对后归档。'),
              'error'
            );
          } else {
            setReviewState(`当前结果版本 ${currentResult.resultRevision}，请核对后归档。`);
          }
        } catch (error) {
          checkbox.checked = false;
          if (error && error.reviewRefetchFailed) {
            reviewHealthy = false;
            setReviewState(error.message || String(error), 'error');
          } else {
            const disposition = reviewFailureDisposition('modify', error.code);
            if (disposition.refetch) {
              try {
                await refetchCurrentResult(error.message, 'error');
              } catch (refreshError) {
                reviewHealthy = false;
                setReviewState(refreshError.message || String(refreshError), 'error');
              }
            } else {
              if (disposition.disableModify) adjustmentAvailable = false;
              if (disposition.poisonReview) reviewHealthy = false;
              setReviewState(error.message || String(error), 'error');
            }
          }
        } finally {
          setReviewLocked(false);
        }
      });
      archiveBtn.addEventListener('click', async () => {
        if (archiveBtn.disabled || runStatusOf(currentResult) !== 'calculated') return;
        setReviewLocked(true);
        setReviewState('正在按当前结果版本重新核对并归档…', 'warning');
        const stopProgress = typeof api.onOperationProgress === 'function'
          ? api.onOperationProgress((progress) => {
            if (!progress || progress.action !== 'archive') return;
            setReviewCancellable(progress.cancellable === true);
            setReviewState(resultOperationProgressMessage(progress), 'warning');
          })
          : null;
        try {
          const archived = await api.archive({
            runId: currentResult.runId,
            expectedResultRevision: currentResult.resultRevision,
            expectedPreviewToken: currentResult.previewTokens && currentResult.previewTokens.archive,
            taskGeneration: currentResult.taskGeneration
          });
          if (!archived || archived.status === 'error') {
            throw responseFailure(archived, '归档失败');
          }
          completion = archived;
          operating = false;
          modal.close();
        } catch (error) {
          checkbox.checked = false;
          if (error.code === 'operation-cancelled') {
            setReviewState('归档已取消，当前结果未发生变化。', 'neutral');
            return;
          }
          const disposition = reviewFailureDisposition('archive', error.code);
          if (disposition.refetch) {
            try {
              await refetchCurrentResult(
                error.message || '结果已发生变化，请重新核对后归档。',
                'error'
              );
            } catch (refreshError) {
              reviewHealthy = false;
              setReviewState(refreshError.message || String(refreshError), 'error');
            }
          } else {
            if (disposition.poisonReview) reviewHealthy = false;
            setReviewState(error.message || String(error), 'error');
          }
        } finally {
          if (typeof stopProgress === 'function') stopProgress();
          if (!completion) setReviewLocked(false);
        }
      });
      renderCurrentResult();
    });
  }

  async function chooseExistingMonth(title) {
    const months = await api.listImportMonths();
    const initial = months.includes(state.lastMonth) ? state.lastMonth : (months[0] || '');
    return chooseMonth({ title, months, initial });
  }

  async function handleRun() {
    if (state.busy) return;
    setBusy(true, 'run');
    try {
      const month = await chooseExistingMonth('选择运行账期');
      if (!month) return;
      state.lastMonth = month;
      let preflight = await api.preflightRun({ targetMonth: month });
      if (!preflight || preflight.status === 'error') {
        throw new Error(preflight && preflight.message || '运行前检查失败');
      }
      if (!preflight.ok) {
        const message = blockedCalculationMessage(preflight);
        setStatus(`无法运行：${message}`, 'warning');
        showMessage('无法开始运行', message, 'warning');
        return;
      }
      setStatus(`正在计算 ${month} 财务OP…`, 'info');
      let result = await api.calculate({
        targetMonth: month,
        expectedInputFingerprint: preflight.inputFingerprint
      });
      if (!result || result.status === 'error') throw new Error(result && result.message || '计算失败');
      if (result.status === 'blocked' && result.code === 'missing-opening-balance') {
        setStatus(blockedCalculationMessage(result), 'warning');
        const openingPayload = await requestOpeningInitialization(result);
        if (!openingPayload) {
          setStatus(`${month} 期初财务OP未初始化`, 'warning');
          return;
        }
        setStatus(`正在初始化 ${month} 期初财务OP…`, 'info');
        const initialized = await api.initializeOpening(openingPayload);
        if (!initialized || initialized.status === 'error') {
          throw new Error(initialized && initialized.message || '期初财务OP初始化失败');
        }
        const initializedMessage = `${month} 期初财务OP已保存，请再次点击【开始运行】进行计算。`;
        setStatus(initializedMessage, 'success');
        showMessage('期初初始化完成', initializedMessage, 'success');
        return;
      }
      if (result.status === 'blocked') {
        const message = blockedCalculationMessage(result);
        setStatus(`无法运行：${message}`, 'warning');
        showMessage('暂不能运行', message, 'warning');
        return;
      }
      if (result.status !== 'calculated') throw new Error('计算返回了未知状态');
      setStatus(`${month} 计算完成，等待确认归档`, 'info');
      const fullResult = normalizeRunResponse(await api.getRun({ runId: result.runId }));
      const reviewOutcome = await confirmArchive(fullResult);
      if (!reviewOutcome || reviewOutcome.status !== 'archived') {
        setStatus(`${month} 结果未归档`, 'warning');
        return;
      }
      state.latestArchivedRun = {
        runId: reviewOutcome.runId,
        targetMonth: reviewOutcome.targetMonth,
        status: reviewOutcome.status
      };
      setStatus(`${reviewOutcome.targetMonth} 已确认归档，可导出结果`, 'success');
      showMessage('归档完成', `${reviewOutcome.targetMonth} 已归档，可导出校验结果表。`, 'success');
    } catch (error) {
      setStatus(`运行失败：${error.message || error}`, 'error');
      showMessage('运行失败', error.message || String(error), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function loadArchivedResultMonths() {
    const response = await api.listArchivedResultMonths();
    if (Array.isArray(response)) return response;
    if (!response || response.status !== 'success') {
      throw new Error(response && response.message || '读取已归档月份失败');
    }
    return Array.isArray(response.months) ? response.months : [];
  }

  async function refreshArchivedState() {
    const months = await loadArchivedResultMonths();
    applyArchivedMonthsState(months);
    return months;
  }

  function applyArchivedMonthsState(months) {
    state.latestArchivedRun = months[0] || null;
    if (state.latestArchivedRun) state.lastMonth = state.latestArchivedRun.targetMonth || state.lastMonth;
    elements.exportBtn.disabled = state.busy || !state.latestArchivedRun;
    elements.exportBtn.title = state.latestArchivedRun ? '' : '暂无已归档财务OP校验结果';
  }

  async function settleArchivedPickerCompletion(onCompleted, result, entry) {
    if (typeof onCompleted !== 'function') return null;
    try {
      await onCompleted(result, entry);
      return null;
    } catch (error) {
      return error;
    }
  }

  function normalizeArchivedPickerEntries(rows) {
    return (Array.isArray(rows) ? rows : [])
      .filter((item) => item && /^\d{4}-\d{2}$/.test(item.targetMonth || ''))
      .sort((left, right) => right.targetMonth.localeCompare(left.targetMonth));
  }

  async function runArchivedPickerExecution({
    entry,
    preview,
    actionLabel,
    executeSelection,
    refreshPreview
  }) {
    async function refreshAfterExecution() {
      try {
        const refreshResult = await refreshPreview();
        if (refreshResult && refreshResult.ok === false) {
          const refreshError = refreshResult.error instanceof Error
            ? refreshResult.error
            : new Error(refreshResult.error && refreshResult.error.message || '月份刷新失败');
          return { refreshError, refreshResult };
        }
        return { refreshError: null, refreshResult: refreshResult || null };
      } catch (error) {
        return { refreshError: error, refreshResult: null };
      }
    }
    try {
      const result = await executeSelection(entry, preview);
      if (!result || result.status === 'error') {
        throw responseFailure(result, `${actionLabel}失败`);
      }
      if (result.status === 'cancelled') {
        const refresh = await refreshAfterExecution();
        return { outcome: 'cancelled', result, ...refresh };
      }
      return { outcome: 'success', result, refreshError: null, refreshResult: null };
    } catch (error) {
      const refresh = await refreshAfterExecution();
      if (error && error.code === 'operation-cancelled') {
        return { outcome: 'cancelled', result: null, ...refresh };
      }
      return { outcome: 'error', error, ...refresh };
    }
  }

  function archivedPickerExecutionErrorMessage({
    entry,
    actionLabel,
    error,
    refreshError,
    refreshResult,
    currentMonth
  }) {
    const errorMessage = responseFailureDisplayMessage(error);
    const refreshSuffix = refreshError
      ? `；月份刷新失败：${refreshError.message || String(refreshError)}`
      : (refreshResult && (refreshResult.empty || refreshResult.canExecute === false)
        ? `；刷新后${refreshResult.message || '当前月份不可操作'}`
        : '');
    if (currentMonth && currentMonth !== entry.targetMonth) {
      return `${entry.targetMonth} ${actionLabel}失败：${errorMessage}；月份列表已刷新并切至 ${currentMonth}，请确认后重试${refreshSuffix}`;
    }
    return `${errorMessage}${refreshSuffix}`;
  }

  function createArchivedMonthPickerDialog({
    months,
    actionLabel,
    danger = false,
    previewSelection = null,
    executeSelection,
    onCompleted = null,
    runningText = '正在处理…',
    confirmationLabel = '',
    allowOperationCancel = false
  }) {
    const normalizeEntries = normalizeArchivedPickerEntries;
    const groupEntries = (rows) => {
      const grouped = new Map();
      for (const entry of rows) {
        const year = entry.targetMonth.slice(0, 4);
        if (!grouped.has(year)) grouped.set(year, []);
        grouped.get(year).push(entry);
      }
      return grouped;
    };
    let entries = normalizeEntries(months);
    if (entries.length === 0) {
      showMessage('请选择月份', '暂无已归档结果', 'info');
      return null;
    }
    let byYear = groupEntries(entries);
    let years = [...byYear.keys()].sort().reverse();
    let executing = false;
    let latestPreview = null;
    let currentSelectionCanExecute = false;
    let previewVersion = 0;
    let pendingPreview = null;
    let previewPending = false;
    let operationCancellable = false;
    const modal = mountDialog({
      title: actionLabel === '导出' ? '请选择要导出的月份' : '请选择月份',
      className: 'vcc-fin-op-archive-picker-dialog',
      initialFocusSelector: '[data-field="archive-year"]',
      canClose: () => !executing,
      bodyHtml: `
        <div class="vcc-fin-op-archive-picker-fields">
          <span>月份</span>
          <select class="vcc-fin-op-input" data-field="archive-year">
            ${years.map((year) => `<option value="${escapeHtml(year)}">${escapeHtml(year)}年</option>`).join('')}
          </select>
          <select class="vcc-fin-op-input" data-field="archive-month"></select>
        </div>
        <p class="vcc-fin-op-delete-state" data-role="archive-picker-state" data-tone="neutral"></p>
        ${confirmationLabel ? `
          <label class="vcc-fin-op-confirm-check" data-role="archive-picker-confirm-row">
            <input type="checkbox" data-field="archive-picker-confirm">${escapeHtml(confirmationLabel)}
          </label>
        ` : ''}
        <div class="dialog-actions right">
          <button class="${danger ? 'danger-btn' : 'primary-btn'} small" type="button" data-action="archive-picker-confirm" disabled>${escapeHtml(actionLabel)}</button>
          <button class="secondary-btn small" type="button" data-action="cancel">取消</button>
        </div>
      `
    });
    const yearSelect = modal.dialog.querySelector('[data-field="archive-year"]');
    const monthSelect = modal.dialog.querySelector('[data-field="archive-month"]');
    const actionButton = modal.dialog.querySelector('[data-action="archive-picker-confirm"]');
    const cancelButton = modal.dialog.querySelector('[data-action="cancel"]');
    const closeButton = modal.dialog.querySelector('[data-action="close"]');
    const stateText = modal.dialog.querySelector('[data-role="archive-picker-state"]');
    const confirmation = modal.dialog.querySelector('[data-field="archive-picker-confirm"]');

    function confirmationSatisfied() {
      return !confirmation || confirmation.checked === true;
    }

    function setPickerState(message, tone = 'neutral') {
      stateText.textContent = String(message || '');
      stateText.dataset.tone = tone;
    }

    function selectedEntry() {
      return entries.find((item) => item.targetMonth === monthSelect.value) || null;
    }

    function replaceEntries(nextEntries, preferredMonth = '') {
      entries = normalizeEntries(nextEntries);
      byYear = groupEntries(entries);
      years = [...byYear.keys()].sort().reverse();
      const preferredYear = preferredMonth.slice(0, 4);
      const selectedYear = byYear.has(preferredYear) ? preferredYear : (years[0] || '');
      yearSelect.innerHTML = years.map((year) => (
        `<option value="${escapeHtml(year)}">${escapeHtml(year)}年</option>`
      )).join('');
      yearSelect.value = selectedYear;
      renderMonths(preferredMonth);
    }

    function renderMonths(preferredMonth = '') {
      const yearEntries = byYear.get(yearSelect.value) || [];
      const selected = yearEntries.some((item) => item.targetMonth === preferredMonth)
        ? preferredMonth
        : (yearEntries[0] && yearEntries[0].targetMonth || '');
      monthSelect.innerHTML = yearEntries.map((item) => `
        <option value="${escapeHtml(item.targetMonth)}"${item.targetMonth === selected ? ' selected' : ''}>${escapeHtml(item.targetMonth.slice(5))}月</option>
      `).join('');
    }

    async function refreshPreview() {
      const currentVersion = ++previewVersion;
      latestPreview = null;
      currentSelectionCanExecute = false;
      if (confirmation) confirmation.checked = false;
      actionButton.disabled = true;
      const entry = selectedEntry();
      if (!entry) {
        const message = '暂无已归档结果';
        setPickerState(message);
        return { ok: true, empty: true, message };
      }
      if (typeof previewSelection !== 'function') {
        setPickerState(`${entry.targetMonth} 已归档，可导出`, 'success');
        currentSelectionCanExecute = true;
        actionButton.disabled = !confirmationSatisfied();
        return { ok: true };
      }
      setPickerState('正在核对归档状态…');
      try {
        const result = await previewSelection(entry);
        if (currentVersion !== previewVersion) return { ok: true, stale: true };
        if (!result || result.status !== 'success') {
          const error = responseFailure(result, '归档状态核对失败');
          setPickerState(error.message, 'error');
          return { ok: false, error };
        }
        if (Array.isArray(result.months)) {
          const before = entries.map((item) => item.targetMonth).join(',');
          const after = normalizeEntries(result.months).map((item) => item.targetMonth).join(',');
          if (before !== after) {
            replaceEntries(result.months, entry.targetMonth);
            const replacement = selectedEntry();
            if (!replacement) {
              const message = '暂无已归档结果';
              setPickerState(message, 'error');
              return { ok: true, empty: true, message };
            }
            if (replacement.targetMonth !== entry.targetMonth) {
              return refreshPreview();
            }
          }
        }
        latestPreview = result;
        const canExecute = Object.hasOwn(result, 'canExecute')
          ? Boolean(result.canExecute)
          : Boolean(result.canUnarchive);
        if (!canExecute) {
          const dependencies = Array.isArray(result.dependentMonths) && result.dependentMonths.length
            ? ` 后续依赖月份：${result.dependentMonths.join('、')}。`
            : '';
          const message = `${result.message || '当前月份不可操作'}${dependencies}`;
          setPickerState(message, 'error');
          return { ok: true, canExecute: false, message };
        }
        const successMessage = result.message || (
          Object.hasOwn(result, 'canExecute')
            ? `${entry.targetMonth} 已归档，可${actionLabel}`
            : `${entry.targetMonth} 可解归档；基础结果和调整记录将保留。`
        );
        setPickerState(successMessage, result.tone || (
          Object.hasOwn(result, 'canExecute') ? 'success' : 'warning'
        ));
        currentSelectionCanExecute = true;
        actionButton.disabled = !confirmationSatisfied();
        return { ok: true, canExecute: true };
      } catch (error) {
        if (currentVersion === previewVersion) setPickerState(error.message || String(error), 'error');
        return { ok: false, error };
      }
    }

    function requestPreviewRefresh() {
      previewPending = true;
      const pending = refreshPreview();
      pendingPreview = pending;
      pending.then(
        () => {
          if (pendingPreview === pending) previewPending = false;
        },
        () => {
          if (pendingPreview === pending) previewPending = false;
        }
      );
      return pending;
    }

    async function waitForPreviewState() {
      let observed = pendingPreview;
      while (observed) {
        await observed;
        if (observed === pendingPreview) break;
        observed = pendingPreview;
      }
      return {
        modalPresent: Boolean(modal.dialog && modal.dialog.isConnected),
        selectedYear: yearSelect.value,
        selectedMonth: monthSelect.value,
        previewPending,
        confirmDisabled: actionButton.disabled === true,
        stateMessage: stateText.textContent,
        stateTone: stateText.dataset.tone || 'neutral'
      };
    }

    Object.defineProperty(modal, 'waitForPreviewState', {
      configurable: false,
      enumerable: false,
      writable: false,
      value: waitForPreviewState
    });

    function setExecutionLocked(locked) {
      yearSelect.disabled = locked;
      monthSelect.disabled = locked;
      if (confirmation) confirmation.disabled = locked;
      cancelButton.disabled = locked && !operationCancellable;
      cancelButton.textContent = locked && operationCancellable ? '取消操作' : '取消';
      closeButton.disabled = locked;
      actionButton.disabled = locked || !currentSelectionCanExecute || !confirmationSatisfied();
    }

    function setOperationCancellable(cancellable) {
      operationCancellable = executing && allowOperationCancel && cancellable === true;
      cancelButton.disabled = executing && !operationCancellable;
      cancelButton.textContent = operationCancellable ? '取消操作' : '取消';
    }

    yearSelect.addEventListener('change', () => {
      renderMonths();
      requestPreviewRefresh();
    });
    monthSelect.addEventListener('change', requestPreviewRefresh);
    if (confirmation) {
      confirmation.addEventListener('change', () => {
        actionButton.disabled = executing || !currentSelectionCanExecute || !confirmationSatisfied();
      });
    }
    cancelButton.addEventListener('click', async () => {
      if (!executing) {
        modal.close();
        return;
      }
      if (!operationCancellable) return;
      setOperationCancellable(false);
      setPickerState(`正在取消${actionLabel}…`, 'warning');
      try {
        await api.cancelTask();
      } catch (error) {
        setPickerState(`取消失败：${error.message || String(error)}`, 'error');
      }
    });
    actionButton.addEventListener('click', async () => {
      const entry = selectedEntry();
      if (!entry || actionButton.disabled || typeof executeSelection !== 'function') return;
      executing = true;
      operationCancellable = false;
      setExecutionLocked(true);
      setPickerState(runningText, 'warning');
      const execution = await runArchivedPickerExecution({
        entry,
        preview: latestPreview,
        actionLabel,
        executeSelection: (selectedEntry, preview) => executeSelection(
          selectedEntry,
          preview,
          { setCancellable: setOperationCancellable }
        ),
        refreshPreview: requestPreviewRefresh
      });
      if (execution.outcome === 'cancelled') {
        executing = false;
        setExecutionLocked(false);
        const refreshedUnavailable = execution.refreshResult
          && (execution.refreshResult.empty || execution.refreshResult.canExecute === false);
        setPickerState(
          execution.refreshError
            ? `已取消${actionLabel}；月份刷新失败：${execution.refreshError.message || String(execution.refreshError)}`
            : (refreshedUnavailable
              ? `已取消${actionLabel}；${execution.refreshResult.message}`
              : `已取消${actionLabel}`),
          execution.refreshError || refreshedUnavailable ? 'warning' : 'neutral'
        );
        return;
      }
      if (execution.outcome === 'error') {
        executing = false;
        setExecutionLocked(false);
        setPickerState(
          archivedPickerExecutionErrorMessage({
            entry,
            actionLabel,
            error: execution.error,
            refreshError: execution.refreshError,
            refreshResult: execution.refreshResult,
            currentMonth: monthSelect.value
          }),
          'error'
        );
        return;
      }

      const completionError = await settleArchivedPickerCompletion(
        onCompleted,
        execution.result,
        entry
      );
      executing = false;
      modal.close();
      if (completionError) {
        showMessage(
          '操作已成功但刷新失败',
          `${entry.targetMonth} ${actionLabel}已完成，但界面刷新失败：${completionError.message || String(completionError)}`,
          'warning'
        );
      }
    });
    renderMonths(entries[0].targetMonth);
    requestPreviewRefresh();
    return modal;
  }

  async function openUnarchiveDialog({ archivedMonths = null, onUnarchived = null } = {}) {
    try {
      const months = archivedMonths || await loadArchivedResultMonths();
      return createArchivedMonthPickerDialog({
        months,
        actionLabel: '解归档',
        previewSelection: (entry) => api.previewUnarchive({ targetMonth: entry.targetMonth }),
        runningText: '正在解归档…',
        confirmationLabel: '我已确认：解归档后只能由 v3.1.9 及以上版本继续维护；降级前必须恢复完整数据库备份',
        allowOperationCancel: true,
        executeSelection: async (entry, preview, controls) => {
          setBusy(true, 'unarchive');
          setStatus(`正在解归档 ${entry.targetMonth}…`, 'info');
          const stopProgress = typeof api.onOperationProgress === 'function'
            ? api.onOperationProgress((progress) => {
              if (!progress || progress.action !== 'unarchive') return;
              controls.setCancellable(progress.cancellable === true);
              setStatus(`${entry.targetMonth} ${resultOperationProgressMessage(progress)}`, 'info');
            })
            : () => {};
          try {
            return await api.unarchiveMonth({
              targetMonth: entry.targetMonth,
              expectedPreviewToken: preview && preview.previewToken,
              taskGeneration: preview && preview.taskGeneration
            });
          } catch (error) {
            setStatus(`${entry.targetMonth} 解归档失败：${error.message || String(error)}`, 'error');
            throw error;
          } finally {
            stopProgress();
            setBusy(false);
          }
        },
        onCompleted: async (result, entry) => {
          await refreshArchivedState();
          setStatus(`${entry.targetMonth} 已解归档，结果恢复为未处理`, 'success');
          if (typeof onUnarchived === 'function') await onUnarchived(result, entry);
          showMessage('解归档完成', `${entry.targetMonth} 已恢复为未处理；基础结果和调整记录均已保留。`, 'success');
        }
      });
    } catch (error) {
      showMessage('解归档', error.message || String(error), 'error');
      return null;
    }
  }

  async function handleExport() {
    if (state.busy) return;
    let months = null;
    setBusy(true, 'export-months');
    try {
      months = await loadArchivedResultMonths();
      applyArchivedMonthsState(months);
    } catch (error) {
      setStatus(`导出失败：${error.message || error}`, 'error');
      showMessage('导出失败', error.message || String(error), 'error');
      return null;
    } finally {
      setBusy(false);
    }
    if (!months.length) {
      const message = '暂无已归档财务OP校验结果';
      setStatus(message, 'info');
      showMessage('导出结果', message, 'info');
      return null;
    }
    return createArchivedMonthPickerDialog({
      months,
      actionLabel: '导出',
      previewSelection: async (entry) => {
        const freshMonths = await loadArchivedResultMonths();
        applyArchivedMonthsState(freshMonths);
        const stillArchived = freshMonths.some((item) => item.targetMonth === entry.targetMonth);
        return {
          status: 'success',
          months: freshMonths,
          canExecute: stillArchived,
          message: stillArchived
            ? `${entry.targetMonth} 已归档，可导出`
            : `${entry.targetMonth} 已不在可导出月份中，请重新选择。`,
          tone: stillArchived ? 'success' : 'error'
        };
      },
      runningText: '正在导出，请勿关闭窗口…',
      executeSelection: async (entry) => {
        setBusy(true, 'export');
        setStatus(`正在导出 ${entry.targetMonth} 校验结果…`, 'info');
        try {
          const result = await api.exportResult({ targetMonth: entry.targetMonth });
          if (!result || result.status === 'error') {
            throw responseFailure(result, '导出失败');
          }
          if (result.status === 'cancelled') setStatus('已取消导出', 'info');
          return result;
        } catch (error) {
          setStatus(`${entry.targetMonth} 导出失败：${responseFailureDisplayMessage(error)}`, 'error');
          throw error;
        } finally {
          setBusy(false);
        }
      },
      onCompleted: async (result, entry) => {
        const count = Array.isArray(result.filePaths) ? result.filePaths.length : 1;
        setStatus(`${entry.targetMonth} 校验结果已导出（${count} 个文件）`, 'success');
      }
    });
  }

  function statusTone(status) {
    if (String(status).startsWith('failed')) return 'error';
    if (status === 'success_with_skips' || status === 'all_skipped') return 'warning';
    if (status === 'deleted') return 'deleted';
    return 'success';
  }

  function renderOverviewTable(rows, emptyText) {
    if (!Array.isArray(rows) || rows.length === 0) {
      return `<div class="vcc-fin-op-empty">${escapeHtml(emptyText)}</div>`;
    }
    return `
      <div class="vcc-fin-op-table-wrap">
        <table class="vcc-fin-op-table">
          <thead><tr><th>表名</th><th>处理状态</th><th>生成时间</th></tr></thead>
          <tbody>${rows.map((row) => `
            <tr>
              <td>${escapeHtml(row.tableName)}</td>
              <td><span class="vcc-fin-op-state" data-state="${escapeHtml(row.dataStatus)}">${escapeHtml(row.dataStatusText)}</span></td>
              <td>${escapeHtml(formatDateTime(row.generatedAt || row.createdAt || row.archivedAt))}</td>
            </tr>
          `).join('')}</tbody>
        </table>
      </div>
    `;
  }

  function renderResultOverviewTable(rows) {
    if (!Array.isArray(rows) || rows.length === 0) {
      return '<div class="vcc-fin-op-empty">当前账期还没有校验结果</div>';
    }
    return `
      <div class="vcc-fin-op-table-wrap">
        <table class="vcc-fin-op-table vcc-fin-op-manager-result-table">
          <thead><tr><th>表名</th><th>处理状态</th><th>结果版本</th><th>更新时间</th><th>操作</th></tr></thead>
          <tbody>${rows.map((row) => `
            <tr>
              <td>${escapeHtml(row.tableName)}</td>
              <td><span class="vcc-fin-op-state" data-state="${escapeHtml(row.dataStatus)}">${escapeHtml(row.dataStatusText)}</span></td>
              <td>${escapeHtml(row.resultRevision == null ? '0' : row.resultRevision)}</td>
              <td>${escapeHtml(formatDateTime(row.updatedAt || row.archivedAt || row.createdAt))}</td>
              <td><button class="vcc-fin-op-link-btn" type="button" data-result-run-id="${escapeHtml(row.runId)}">查看结果</button></td>
            </tr>
          `).join('')}</tbody>
        </table>
      </div>
    `;
  }

  function rawRecordsTable(records) {
    if (!records.length) return '<div class="vcc-fin-op-empty">当前账期暂无导入记录</div>';
    return `
      <div class="vcc-fin-op-table-wrap vcc-fin-op-record-table-wrap">
        <table class="vcc-fin-op-table">
          <thead>
            <tr><th>账期</th><th>导入批次</th><th>原表类型</th><th>来源文件</th><th>导入时间</th><th>导入状态</th><th>操作</th></tr>
          </thead>
          <tbody>${records.map((record) => {
            const batchDisplay = String(record.batchId || '').slice(0, 8) || '-';
            return `
              <tr>
                <td>${escapeHtml(record.targetMonth)}</td>
                <td title="${escapeHtml(record.batchId || '')}">${escapeHtml(batchDisplay)}</td>
                <td>${escapeHtml(record.sourceLabel)}</td>
                <td title="${escapeHtml((record.sourceFiles || []).join('\n'))}">${escapeHtml(record.sourceFileDisplay || '-')}</td>
                <td>${escapeHtml(formatDateTime(record.finishedAt || record.startedAt))}</td>
                <td><span class="vcc-fin-op-state" data-state="${statusTone(record.status)}">${escapeHtml(record.statusText)}</span></td>
                <td><button class="vcc-fin-op-link-btn" type="button" data-record-id="${record.id}">查看导入明细</button></td>
              </tr>
            `;
          }).join('')}</tbody>
        </table>
      </div>
    `;
  }

  function rowDetailHtml(row) {
    const incoming = escapeHtml(JSON.stringify(row.incoming || {}, null, 2));
    const existing = row.existing ? escapeHtml(JSON.stringify(row.existing, null, 2)) : '';
    const source = row.existingSource
      ? `${row.existingSource.sourceFile || '-'} / ${row.existingSource.sheetName || '-'} / 第 ${row.existingSource.sourceRow || '-'} 行`
      : '';
    return `
      <details class="vcc-fin-op-row-details">
        <summary>展开原始数据${row.diffFields && row.diffFields.length ? `（差异字段：${escapeHtml(row.diffFields.join('、'))}）` : ''}</summary>
        <div class="vcc-fin-op-compare-grid${existing ? '' : ' is-single'}">
          <section><h4>本次导入</h4><pre>${incoming}</pre></section>
          ${existing ? `<section><h4>已存在记录</h4><p>${escapeHtml(source)}</p><pre>${existing}</pre></section>` : ''}
        </div>
      </details>
    `;
  }

  function importRowsTable(rows) {
    if (!rows.length) return '<div class="vcc-fin-op-empty">当前分类没有数据</div>';
    return `
      <div class="vcc-fin-op-table-wrap vcc-fin-op-detail-table-wrap">
        <table class="vcc-fin-op-table">
          <thead><tr><th>幂等键</th><th>文件</th><th>sheet</th><th>原表行号</th><th>分类</th><th>异常字段</th><th>说明</th></tr></thead>
          <tbody>${rows.map((row) => `
            <tr>
              <td>${escapeHtml(row.idempotencyKey || '-')}</td>
              <td>${escapeHtml(row.sourceFile || '-')}</td>
              <td>${escapeHtml(row.sheetName || '-')}</td>
              <td class="number">${escapeHtml(row.sourceRow || '-')}</td>
              <td>${escapeHtml(DISPOSITION_LABELS[row.disposition] || row.disposition)}</td>
              <td>${escapeHtml(row.validationField || '-')}</td>
              <td>${escapeHtml(row.message || '-')}</td>
            </tr>
            <tr class="vcc-fin-op-expanded-row"><td colspan="7">${rowDetailHtml(row)}</td></tr>
          `).join('')}</tbody>
        </table>
      </div>
    `;
  }

  function importErrorsTable(errors) {
    if (!Array.isArray(errors) || errors.length === 0) return '';
    return `
      <div class="vcc-fin-op-table-wrap vcc-fin-op-error-list">
        <table class="vcc-fin-op-table">
          <thead><tr><th>文件</th><th>sheet</th><th>原表行号</th><th>异常字段</th><th>错误码</th><th>说明</th></tr></thead>
          <tbody>${errors.map((error) => `
            <tr>
              <td>${escapeHtml(error.source_file || '-')}</td>
              <td>${escapeHtml(error.sheet_name || '-')}</td>
              <td class="number">${escapeHtml(error.source_row || '-')}</td>
              <td>${escapeHtml(error.field_name || '-')}</td>
              <td>${escapeHtml(error.error_code || '-')}</td>
              <td>${escapeHtml(error.message || '导入异常')}</td>
            </tr>
          `).join('')}</tbody>
        </table>
      </div>
    `;
  }

  function openImportRecordDetail(recordId, onChanged) {
    const detailState = { tab: 'summary', page: 1, pageSize: 100, key: '', fileName: '' };
    const modal = mountDialog({
      title: '导入记录详情',
      className: 'vcc-fin-op-detail-dialog',
      bodyHtml: '<div class="vcc-fin-op-loading">正在读取导入记录…</div>'
    });

    async function load() {
      const payload = { recordId, ...detailState };
      const result = await api.getImportDetail(payload);
      if (!result || result.status !== 'success') {
        modal.body.innerHTML = `<div class="vcc-fin-op-empty">${escapeHtml(result && result.message || '读取失败')}</div>`;
        return;
      }
      const summary = result.summary;
      const isSystemOpSummary = summary.sourceType === 'system_op';
      const countValue = (value) => (
        isSystemOpSummary ? formatSystemOpSnapshotCount(value, true) : formatInteger(value)
      );
      const summaryStatusText = summary.status === 'deleted'
        ? `已删除（原导入状态：${summary.originalStatusText || '-'}）`
        : summary.statusText;
      const tabs = [
        ['summary', `概览`],
        ['skips', `幂等跳过 ${isSystemOpSummary ? `${formatInteger(summary.skippedCount)} 快照` : formatInteger(summary.skippedCount)}`],
        ['conflicts', `幂等冲突 ${isSystemOpSummary ? `${formatInteger(summary.conflictCount)} 快照` : formatInteger(summary.conflictCount)}`],
        ['other', `其他异常 ${formatInteger(summary.invalidKeyCount + summary.formatErrorCount + summary.rolledBackCount)}`]
      ];
      const summaryHtml = `
        <div class="vcc-fin-op-metric-grid">
          <div><span>${isSystemOpSummary ? '原始输入单元' : '原始行'}</span><strong>${formatInteger(summary.rawCount)}</strong></div>
          <div><span>${isSystemOpSummary ? '新增币种数据' : '新增'}</span><strong>${countValue(summary.insertedCount)}</strong></div>
          <div><span>${isSystemOpSummary ? '幂等跳过数据' : '幂等跳过'}</span><strong>${countValue(summary.skippedCount)}</strong></div>
          <div><span>${isSystemOpSummary ? '幂等冲突数据' : '幂等冲突'}</span><strong>${countValue(summary.conflictCount)}</strong></div>
          <div><span>幂等键为空</span><strong>${formatInteger(summary.invalidKeyCount)}</strong></div>
          <div><span>格式异常</span><strong>${formatInteger(summary.formatErrorCount)}</strong></div>
          <div><span>${isSystemOpSummary ? '回滚币种数据' : '回滚行'}</span><strong>${countValue(summary.rolledBackCount)}</strong></div>
        </div>
        ${summary.errorMessage ? `<p class="vcc-fin-op-message" data-tone="error">${escapeHtml(summary.errorMessage)}</p>` : ''}
        ${summary.status === 'deleted' ? `<p class="vcc-fin-op-message">关联有效原表已于 ${escapeHtml(formatDateTime(summary.datasetDeletedAt))} 删除；原导入统计与审计明细继续保留。</p>` : ''}
        ${importErrorsTable(result.errors || [])}
        ${summary.resolutionStatus === 'resolved' ? `<p class="vcc-fin-op-resolution">已处理：保留当前有效数据集，本次失败导入不参与计算。${escapeHtml(summary.resolutionNote || '-')}（${escapeHtml(formatDateTime(summary.resolvedAt))}）</p>` : ''}
      `;
      const pages = Math.max(1, Math.ceil((result.total || 0) / result.pageSize));
      const rowsHtml = detailState.tab === 'summary'
        ? summaryHtml
        : `
          <div class="vcc-fin-op-detail-toolbar">
            <input class="vcc-fin-op-input" type="search" data-filter="key" value="${escapeHtml(detailState.key)}" placeholder="筛选幂等键">
            <input class="vcc-fin-op-input" type="search" data-filter="file" value="${escapeHtml(detailState.fileName)}" placeholder="筛选文件名">
            <button class="secondary-btn small" type="button" data-action="search">筛选</button>
            <button class="secondary-btn small" type="button" data-action="audit">导出当前分类</button>
          </div>
          ${detailState.tab === 'other' ? importErrorsTable(result.errors || []) : ''}
          ${importRowsTable(result.rows || [])}
          <div class="vcc-fin-op-pagination">
            <button class="secondary-btn small" type="button" data-page="prev"${result.page <= 1 ? ' disabled' : ''}>上一页</button>
            <span>第 ${result.page} / ${pages} 页，共 ${formatInteger(result.total)} 行</span>
            <button class="secondary-btn small" type="button" data-page="next"${result.page >= pages ? ' disabled' : ''}>下一页</button>
          </div>
        `;
      modal.body.innerHTML = `
        <div class="vcc-fin-op-record-heading">
          <div><strong>${escapeHtml(summary.sourceLabel)}</strong><span>${escapeHtml(summary.targetMonth)} · ${escapeHtml(summaryStatusText)}</span></div>
          ${summary.resolutionStatus === 'unresolved' ? '<button class="secondary-btn small" type="button" data-action="resolve">标记异常已处理</button>' : ''}
        </div>
        <div class="vcc-fin-op-tabs" role="tablist">
          ${tabs.map(([tab, label]) => `<button type="button" role="tab" data-tab="${tab}" aria-selected="${detailState.tab === tab}">${escapeHtml(label)}</button>`).join('')}
        </div>
        <div class="vcc-fin-op-detail-content">${rowsHtml}</div>
      `;
      modal.body.querySelectorAll('[data-tab]').forEach((button) => {
        button.addEventListener('click', () => {
          detailState.tab = button.dataset.tab;
          detailState.page = 1;
          load();
        });
      });
      const searchBtn = modal.body.querySelector('[data-action="search"]');
      if (searchBtn) searchBtn.addEventListener('click', () => {
        detailState.key = modal.body.querySelector('[data-filter="key"]').value.trim();
        detailState.fileName = modal.body.querySelector('[data-filter="file"]').value.trim();
        detailState.page = 1;
        load();
      });
      const auditBtn = modal.body.querySelector('[data-action="audit"]');
      if (auditBtn) auditBtn.addEventListener('click', async () => {
        auditBtn.disabled = true;
        try {
          const exported = await api.exportImportAudit({ recordId, tab: detailState.tab, key: detailState.key, fileName: detailState.fileName });
          if (exported && exported.status === 'error') showMessage('导出失败', exported.message || '导出失败', 'error');
        } finally {
          auditBtn.disabled = false;
        }
      });
      modal.body.querySelectorAll('[data-page]').forEach((button) => {
        button.addEventListener('click', () => {
          detailState.page += button.dataset.page === 'next' ? 1 : -1;
          load();
        });
      });
      const resolveBtn = modal.body.querySelector('[data-action="resolve"]');
      if (resolveBtn) resolveBtn.addEventListener('click', () => openResolutionDialog(summary, async () => {
        if (typeof onChanged === 'function') await onChanged();
        await load();
      }));
    }

    load().catch((error) => {
      modal.body.innerHTML = `<div class="vcc-fin-op-empty">${escapeHtml(error.message || String(error))}</div>`;
    });
  }

  function openResolutionDialog(summary, onResolved) {
    const modal = mountDialog({
      title: '标记导入异常已处理',
      className: 'vcc-fin-op-compact-dialog',
      bodyHtml: `
        <p class="vcc-fin-op-message" data-tone="warning">本次失败导入的数据未生效。标记已处理后，计算将继续使用此前已生效的数据；请写明核对结论。</p>
        <label class="vcc-fin-op-field"><span>处理说明</span><textarea class="vcc-fin-op-input vcc-fin-op-textarea" data-field="note" rows="4" maxlength="500"></textarea></label>
        <label class="vcc-fin-op-confirm-check"><input type="checkbox" data-field="resolution-confirm">已确认保留当前有效数据集，本次失败导入不参与计算</label>
        <p class="vcc-fin-op-field-error" data-role="error" hidden></p>
        <div class="dialog-actions right">
          <button class="secondary-btn small" type="button" data-action="cancel">取消</button>
          <button class="primary-btn small" type="button" data-action="confirm">确认已处理</button>
        </div>
      `
    });
    modal.dialog.querySelector('[data-action="cancel"]').addEventListener('click', modal.close);
    modal.dialog.querySelector('[data-action="confirm"]').addEventListener('click', async () => {
      const button = modal.dialog.querySelector('[data-action="confirm"]');
      const note = modal.dialog.querySelector('[data-field="note"]').value.trim();
      const confirmed = modal.dialog.querySelector('[data-field="resolution-confirm"]').checked;
      const error = modal.dialog.querySelector('[data-role="error"]');
      if (!note || !confirmed) {
        error.textContent = !note ? '请填写处理说明' : '请确认本次失败导入不参与计算';
        error.hidden = false;
        return;
      }
      button.disabled = true;
      try {
        const result = await api.resolveImportRecord({
          recordId: summary.id,
          note,
          action: 'keep_current_effective_dataset'
        });
        if (!result || result.status !== 'success') throw new Error(result && result.message || '处理失败');
        modal.close();
        if (typeof onResolved === 'function') await onResolved();
      } catch (cause) {
        error.textContent = cause.message || String(cause);
        error.hidden = false;
      } finally {
        button.disabled = false;
      }
    });
  }

  function openDatasetDeleteDialog({ months, initialMonth = '', onDeleted, previewResult = null }) {
    const availableMonths = Array.isArray(months) ? months : [];
    const selectedMonth = availableMonths.includes(initialMonth) ? initialMonth : (availableMonths[0] || '');
    const monthOptions = availableMonths.length
      ? availableMonths.map((month) => `<option value="${escapeHtml(month)}"${month === selectedMonth ? ' selected' : ''}>${escapeHtml(month)}</option>`).join('')
      : '<option value="">暂无已导入账期</option>';
    let deleting = false;
    let operationCancellable = false;
    const modal = mountDialog({
      title: '删除数据',
      className: 'vcc-fin-op-delete-dialog',
      initialFocusSelector: '[data-field="delete-month"]:not(:disabled)',
      canClose: () => !deleting,
      bodyHtml: `
        <div class="vcc-fin-op-delete-form">
          <div class="vcc-fin-op-delete-fields">
            <label class="vcc-fin-op-field">
              <span>月份账期</span>
              <select class="vcc-fin-op-input" data-field="delete-month"${availableMonths.length ? '' : ' disabled'}>${monthOptions}</select>
            </label>
            <label class="vcc-fin-op-field">
              <span>目标表</span>
              <select class="vcc-fin-op-input" data-field="delete-target" disabled><option value="">正在读取…</option></select>
            </label>
          </div>
          <p class="vcc-fin-op-delete-state" data-role="delete-state" data-tone="neutral"></p>
        </div>
        <div class="dialog-actions right">
          <button class="danger-btn small" type="button" data-action="confirm-delete" disabled>删除</button>
          <button class="secondary-btn small" type="button" data-action="cancel">取消</button>
        </div>
      `
    });
    const targetSelect = modal.dialog.querySelector('[data-field="delete-target"]');
    const monthSelect = modal.dialog.querySelector('[data-field="delete-month"]');
    const deleteButton = modal.dialog.querySelector('[data-action="confirm-delete"]');
    const cancelButton = modal.dialog.querySelector('[data-action="cancel"]');
    const closeButton = modal.dialog.querySelector('[data-action="close"]');
    const stateText = modal.dialog.querySelector('[data-role="delete-state"]');
    let previewVersion = 0;
    let latestPreview = null;
    let currentTargets = [];

    attachPreviewStateTracker(modal, () => ({
      modalPresent: Boolean(modal.dialog && modal.dialog.isConnected),
      selectedMonth: monthSelect.value,
      selectedTarget: targetSelect.value,
      confirmDisabled: deleteButton.disabled === true,
      stateMessage: stateText.textContent,
      stateTone: stateText.dataset.tone || 'neutral'
    }));

    function setDeleteState(message, tone = 'neutral') {
      stateText.textContent = String(message || '');
      stateText.dataset.tone = tone;
    }

    function previewSummary(result) {
      const targetType = result.targetType || targetSelect.value;
      if (Object.hasOwn(SOURCE_LABELS, targetType)) {
        const invalidated = Number(result.calculatedRunCount) || 0;
        return `当前有效数据 ${formatInteger(result.dataCount || result.count)} 条${invalidated > 0 ? `，将同步作废 ${formatInteger(invalidated)} 份未归档结果` : ''}`;
      }
      if (targetType === 'opening_initialization') {
        return `将删除 ${formatInteger(result.count)} 条主体期初初始化数据，并删除 ${formatInteger(result.calculatedRunCount)} 份未归档结果；导入事实保留。`;
      }
      return `将删除该月全部 ${formatInteger(result.calculatedRunCount || result.count)} 份未归档财务OP校验结果；原表和导入审计保留。`;
    }

    function applyCachedPreview() {
      const currentVersion = ++previewVersion;
      latestPreview = null;
      deleteButton.disabled = true;
      const targetMonth = monthSelect.value;
      const targetType = targetSelect.value;
      if (!targetMonth || !targetType) {
        setDeleteState('当前没有可删除的有效数据');
        return;
      }
      const result = selectCachedDeletePreview(currentTargets, targetType);
      if (currentVersion !== previewVersion) return;
      if (!result) {
        setDeleteState('当前选择没有可删除的有效数据', 'error');
        return;
      }
      latestPreview = result;
      if (!(result.deletable || result.available)) {
        setDeleteState(result.disabledReason || result.message || '当前选择没有可删除的有效数据', 'error');
        return;
      }
      setDeleteState(previewSummary(result), 'warning');
      deleteButton.disabled = false;
    }

    async function loadTargets() {
      const currentVersion = ++previewVersion;
      latestPreview = null;
      deleteButton.disabled = true;
      targetSelect.disabled = true;
      const targetMonth = monthSelect.value;
      if (!targetMonth) {
        targetSelect.innerHTML = '<option value="">暂无删除目标</option>';
        setDeleteState('当前没有可删除的数据');
        return;
      }
      setDeleteState('正在读取删除目标…');
      try {
        let response;
        if (previewResult) {
          response = {
            status: 'success',
            targets: Object.entries(DELETE_TARGET_LABELS).map(([targetType, targetLabel]) => ({
              status: 'success',
              targetType,
              targetLabel,
              ...(typeof previewResult === 'function'
                ? previewResult({ targetMonth, targetType })
                : previewResult)
            }))
          };
        } else {
          response = await api.listDeleteTargets({ targetMonth });
        }
        if (currentVersion !== previewVersion) return;
        if (!response || response.status !== 'success') {
          throw new Error(response && response.message || '读取删除目标失败');
        }
        currentTargets = Array.isArray(response.targets) ? response.targets : [];
        const previousTarget = targetSelect.value;
        targetSelect.innerHTML = currentTargets.length
          ? currentTargets.map((target) => `
            <option value="${escapeHtml(target.targetType)}"${target.targetType === previousTarget ? ' selected' : ''}>${escapeHtml(target.targetLabel || DELETE_TARGET_LABELS[target.targetType] || target.targetType)}</option>
          `).join('')
          : '<option value="">暂无删除目标</option>';
        targetSelect.disabled = currentTargets.length === 0;
        applyCachedPreview();
      } catch (error) {
        if (currentVersion !== previewVersion) return;
        currentTargets = [];
        targetSelect.innerHTML = '<option value="">读取失败</option>';
        setDeleteState(error.message || String(error), 'error');
      }
    }

    targetSelect.addEventListener('change', () => modal.trackPreviewState(applyCachedPreview()));
    monthSelect.addEventListener('change', () => modal.trackPreviewState(loadTargets()));
    function setDeleteCancellable(cancellable) {
      operationCancellable = deleting && cancellable === true;
      cancelButton.disabled = deleting && !operationCancellable;
      cancelButton.textContent = operationCancellable ? '取消操作' : '取消';
    }

    cancelButton.addEventListener('click', async () => {
      if (!deleting) {
        modal.close();
        return;
      }
      if (!operationCancellable) return;
      setDeleteCancellable(false);
      setDeleteState('正在取消删除…', 'warning');
      try {
        await api.cancelTask();
      } catch (error) {
        setDeleteState(`取消失败：${error.message || String(error)}`, 'error');
      }
    });
    deleteButton.addEventListener('click', async () => {
      const targetMonth = monthSelect.value;
      const targetType = targetSelect.value;
      if (!targetMonth || !targetType || deleteButton.disabled || !latestPreview) return;
      previewVersion += 1;
      deleting = true;
      operationCancellable = false;
      setBusy(true, 'delete');
      deleteButton.disabled = true;
      cancelButton.disabled = true;
      closeButton.disabled = true;
      targetSelect.disabled = true;
      monthSelect.disabled = true;
      setDeleteState('正在删除数据…', 'warning');
      const targetLabel = latestPreview.targetLabel || DELETE_TARGET_LABELS[targetType] || targetType;
      setStatus(`正在删除 ${targetMonth} ${targetLabel}…`, 'info');
      const stopProgress = typeof api.onOperationProgress === 'function'
        ? api.onOperationProgress((progress) => {
          if (!progress || progress.action !== 'delete') return;
          setDeleteCancellable(progress.cancellable === true);
          setDeleteState(resultOperationProgressMessage(progress), 'warning');
        })
        : () => {};
      let result;
      try {
        result = await api.deleteDataTarget({
          targetMonth,
          targetType,
          expectedPreviewToken: latestPreview.previewToken,
          taskGeneration: latestPreview.taskGeneration
        });
        if (!result || result.status !== 'success') {
          throw responseFailure(result, '删除失败');
        }
      } catch (error) {
        deleting = false;
        operationCancellable = false;
        setBusy(false);
        if (error.code === 'operation-cancelled') {
          setStatus('删除已取消，数据未发生变化', 'info');
          setDeleteState('删除已取消，数据未发生变化。', 'neutral');
        } else {
          setStatus(`删除失败：${error.message || error}`, 'error');
          showMessage('删除失败', error.message || String(error), 'error');
        }
        cancelButton.disabled = false;
        closeButton.disabled = false;
        targetSelect.disabled = false;
        monthSelect.disabled = false;
        modal.trackPreviewState(loadTargets());
        return;
      } finally {
        stopProgress();
      }

      deleting = false;
      setBusy(false);
      modal.close();
      let successMessage;
      if (targetType === 'opening_initialization') {
        successMessage = `已删除 ${result.targetMonth} 首月期初初始化数据 ${formatInteger(result.deletedOpeningCount)} 条，并删除 ${formatInteger(result.deletedRunCount)} 份未归档结果。`;
      } else if (targetType === 'result') {
        successMessage = `已删除 ${result.targetMonth} 全部 ${formatInteger(result.deletedRunCount)} 份未归档财务OP校验结果；原表和导入审计均已保留。`;
      } else {
        const invalidated = Number(result.invalidatedRunCount) || 0;
        successMessage = `已删除 ${result.targetMonth} ${result.sourceLabel || targetLabel}有效数据 ${formatInteger(result.deletedDataCount)} 条${invalidated > 0 ? `，并作废 ${formatInteger(invalidated)} 份未归档结果` : ''}。`;
      }
      setStatus(`${result.targetMonth} ${targetLabel}已删除`, 'success');
      try {
        if (typeof onDeleted === 'function') await onDeleted(result);
      } catch (error) {
        showMessage('删除完成', `${successMessage} 数据管理刷新失败：${error.message || error}`, 'warning');
        return;
      }
      showMessage('删除完成', successMessage, 'success');
    });
    modal.trackPreviewState(loadTargets());
    return modal;
  }

  function openDatasetExportDialog({ months, initialMonth = '', initialSection = 'raw', previewResult = null }) {
    const availableMonths = Array.isArray(months) ? months : [];
    const selectedMonth = availableMonths.includes(initialMonth) ? initialMonth : (availableMonths[0] || '');
    const preferredKind = initialSection === 'checks' ? 'check' : 'raw';
    const targetOptions = [
      ['raw', '校验原表', SOURCE_LABELS],
      ['check', '校验表', CHECK_TABLE_LABELS]
    ].map(([kind, groupLabel, labels]) => `
      <optgroup label="${groupLabel}">
        ${Object.entries(labels).map(([sourceType, label], index) => `
          <option value="${kind}:${escapeHtml(sourceType)}"${kind === preferredKind && index === 0 ? ' selected' : ''}>${escapeHtml(label)}</option>
        `).join('')}
      </optgroup>
    `).join('');
    const monthOptions = availableMonths.length
      ? availableMonths.map((month) => `<option value="${escapeHtml(month)}"${month === selectedMonth ? ' selected' : ''}>${escapeHtml(month)}</option>`).join('')
      : '<option value="">暂无已导入账期</option>';
    let exporting = false;
    const modal = mountDialog({
      title: '导出数据',
      className: 'vcc-fin-op-delete-dialog vcc-fin-op-export-dialog',
      initialFocusSelector: '[data-field="export-month"]:not(:disabled)',
      canClose: () => !exporting,
      bodyHtml: `
        <div class="vcc-fin-op-delete-form">
          <div class="vcc-fin-op-delete-fields">
            <label class="vcc-fin-op-field">
              <span>月份账期</span>
              <select class="vcc-fin-op-input" data-field="export-month"${availableMonths.length ? '' : ' disabled'}>${monthOptions}</select>
            </label>
            <label class="vcc-fin-op-field">
              <span>目标表</span>
              <select class="vcc-fin-op-input" data-field="export-target"${availableMonths.length ? '' : ' disabled'}>${targetOptions}</select>
            </label>
          </div>
          <p class="vcc-fin-op-delete-state" data-role="export-state" data-tone="neutral"></p>
        </div>
        <div class="dialog-actions right">
          <button class="primary-btn small" type="button" data-action="confirm-export" disabled>导出</button>
          <button class="secondary-btn small" type="button" data-action="cancel">取消</button>
        </div>
      `
    });
    const monthSelect = modal.dialog.querySelector('[data-field="export-month"]');
    const targetSelect = modal.dialog.querySelector('[data-field="export-target"]');
    const exportButton = modal.dialog.querySelector('[data-action="confirm-export"]');
    const cancelButton = modal.dialog.querySelector('[data-action="cancel"]');
    const closeButton = modal.dialog.querySelector('[data-action="close"]');
    const stateText = modal.dialog.querySelector('[data-role="export-state"]');
    let previewVersion = 0;

    attachPreviewStateTracker(modal, () => ({
      modalPresent: Boolean(modal.dialog && modal.dialog.isConnected),
      selectedMonth: monthSelect.value,
      selectedTarget: targetSelect.value,
      confirmDisabled: exportButton.disabled === true,
      stateMessage: stateText.textContent,
      stateTone: stateText.dataset.tone || 'neutral'
    }));

    function selectedTarget() {
      const [targetKind, sourceType] = String(targetSelect.value || '').split(':');
      return { targetKind, sourceType };
    }

    function setExportState(message, tone = 'neutral') {
      stateText.textContent = String(message || '');
      stateText.dataset.tone = tone;
    }

    async function refreshPreview() {
      const currentVersion = ++previewVersion;
      exportButton.disabled = true;
      const targetMonth = monthSelect.value;
      const { targetKind, sourceType } = selectedTarget();
      if (!targetMonth || !targetKind || !sourceType) {
        setExportState('当前没有可导出的有效数据');
        return;
      }
      setExportState('正在核对可导出数据…');
      try {
        const result = previewResult
          ? { status: 'success', ...(typeof previewResult === 'function'
            ? previewResult({ targetMonth, sourceType, targetKind })
            : previewResult) }
          : await api.previewDatasetExport({ targetMonth, sourceType, targetKind });
        if (currentVersion !== previewVersion) return;
        if (!result || result.status !== 'success') {
          setExportState(result && result.message || '导出范围核对失败', 'error');
          return;
        }
        if (!result.exportable) {
          setExportState(result.message || '当前选择没有可导出的有效数据', 'error');
          return;
        }
        setExportState(`当前可导出有效数据 ${formatInteger(result.dataCount)} 条`, 'success');
        exportButton.disabled = false;
      } catch (error) {
        if (currentVersion !== previewVersion) return;
        setExportState(error.message || String(error), 'error');
      }
    }

    monthSelect.addEventListener('change', () => modal.trackPreviewState(refreshPreview()));
    targetSelect.addEventListener('change', () => modal.trackPreviewState(refreshPreview()));
    cancelButton.addEventListener('click', modal.close);
    exportButton.addEventListener('click', async () => {
      const targetMonth = monthSelect.value;
      const { targetKind, sourceType } = selectedTarget();
      if (!targetMonth || !targetKind || !sourceType || exportButton.disabled) return;
      previewVersion += 1;
      exporting = true;
      setBusy(true, 'export-data');
      exportButton.disabled = true;
      cancelButton.disabled = true;
      closeButton.disabled = true;
      monthSelect.disabled = true;
      targetSelect.disabled = true;
      setExportState('正在导出数据…', 'warning');
      setStatus(`正在导出 ${targetMonth} 数据…`, 'info');
      try {
        const result = await api.exportDataset({ targetMonth, sourceType, targetKind });
        if (!result || result.status === 'cancelled') {
          exporting = false;
          setBusy(false);
          cancelButton.disabled = false;
          closeButton.disabled = false;
          monthSelect.disabled = false;
          targetSelect.disabled = false;
          setStatus('已取消导出', 'info');
          modal.trackPreviewState(refreshPreview());
          return;
        }
        if (result.status !== 'success') throw new Error(result.message || '导出失败');
        exporting = false;
        setBusy(false);
        modal.close();
        const successMessage = `已导出 ${result.targetMonth} ${result.tableName}有效数据 ${formatInteger(result.dataCount)} 条。`;
        setStatus(`${result.targetMonth} ${result.tableName}已导出`, 'success');
        showMessage('导出完成', successMessage, 'success');
      } catch (error) {
        exporting = false;
        setBusy(false);
        setStatus(`导出失败：${error.message || error}`, 'error');
        showMessage('导出失败', error.message || String(error), 'error');
        cancelButton.disabled = false;
        closeButton.disabled = false;
        monthSelect.disabled = false;
        targetSelect.disabled = false;
        modal.trackPreviewState(refreshPreview());
      }
    });
    modal.trackPreviewState(refreshPreview());
    return modal;
  }

  function openDataManager({ initialMonth = '', initialSection = 'results', previewData = null } = {}) {
    let months = [];
    let archivedMonths = [];
    const titles = { results: '结果表', checks: '校验表', raw: '导入记录' };
    const managerState = {
      month: '',
      section: Object.hasOwn(titles, initialSection) ? initialSection : 'results'
    };
    const modal = mountDialog({
      title: '数据管理',
      className: 'vcc-fin-op-manager-dialog',
      initialFocusSelector: '[data-field="manager-month"]:not(:disabled)',
      bodyHtml: `
        <div class="vcc-fin-op-manager-shell">
          <div class="position-manager-layout vcc-fin-op-manager-layout">
            <nav class="position-manager-nav vcc-fin-op-manager-nav" aria-label="数据分类">
              <button class="position-nav-item" type="button" data-section="results">结果表</button>
              <button class="position-nav-item" type="button" data-section="checks">校验表</button>
              <button class="position-nav-item" type="button" data-section="raw">校验原表</button>
            </nav>
            <section class="position-manager-pane vcc-fin-op-manager-pane">
              <div class="vcc-fin-op-manager-toolbar">
                <h3 data-role="manager-title">${escapeHtml(titles[managerState.section])}</h3>
                <label><span>月份账期</span><select class="vcc-fin-op-input" data-field="manager-month" disabled><option value="">正在读取…</option></select></label>
              </div>
              <div class="vcc-fin-op-manager-content" data-role="manager-content" aria-busy="true">
                <div class="vcc-fin-op-manager-skeleton" aria-label="正在读取数据管理内容">
                  <span></span><span></span><span></span>
                </div>
              </div>
            </section>
          </div>
          <div class="dialog-actions split vcc-fin-op-manager-footer">
            <div class="vcc-fin-op-manager-footer-left">
              <button class="secondary-btn small is-loading" type="button" data-action="unarchive" disabled title="正在读取已归档结果">正在读取归档…</button>
            </div>
            <div class="vcc-fin-op-manager-footer-right">
              <button class="secondary-btn small" type="button" data-action="delete-dataset" disabled>删除</button>
              <button class="secondary-btn small" type="button" data-action="export-dataset" disabled>导出</button>
              <button class="secondary-btn small" type="button" data-action="return">返回</button>
            </div>
          </div>
        </div>
      `
    });
    const content = modal.dialog.querySelector('[data-role="manager-content"]');
    const managerTitle = modal.dialog.querySelector('[data-role="manager-title"]');
    const monthSelect = modal.dialog.querySelector('[data-field="manager-month"]');
    const unarchiveButton = modal.dialog.querySelector('[data-action="unarchive"]');
    const deleteButton = modal.dialog.querySelector('[data-action="delete-dataset"]');
    const exportButton = modal.dialog.querySelector('[data-action="export-dataset"]');
    const returnButton = modal.dialog.querySelector('[data-action="return"]');
    let renderVersion = 0;
    let loadVersion = 0;
    let loadingManagerData = true;

    attachPreviewStateTracker(modal, () => ({
      modalPresent: Boolean(modal.dialog && modal.dialog.isConnected),
      selectedMonth: monthSelect.value,
      selectedSection: managerState.section,
      contentText: content.textContent,
      unarchiveDisabled: unarchiveButton.disabled === true,
      monthDisabled: monthSelect.disabled === true,
      contentBusy: content.getAttribute('aria-busy') === 'true'
    }));

    function updateActionButtons() {
      const hasMonths = months.length > 0;
      monthSelect.disabled = loadingManagerData || !hasMonths;
      deleteButton.disabled = loadingManagerData || !hasMonths;
      exportButton.disabled = loadingManagerData || !hasMonths;
      const hasArchives = archivedMonths.length > 0;
      unarchiveButton.disabled = loadingManagerData || !hasArchives;
      unarchiveButton.textContent = loadingManagerData ? '正在读取归档…' : '解归档';
      unarchiveButton.classList.toggle('is-loading', loadingManagerData);
      unarchiveButton.title = loadingManagerData
        ? '正在读取已归档结果'
        : (hasArchives ? '解归档已归档结果' : '暂无已归档结果');
    }

    function renderManagerSkeleton() {
      content.setAttribute('aria-busy', 'true');
      content.innerHTML = `
        <div class="vcc-fin-op-manager-skeleton" aria-label="正在读取数据管理内容">
          <span></span><span></span><span></span>
        </div>
      `;
    }

    function populateMonthSelect(preferredMonth = '') {
      managerState.month = months.includes(preferredMonth)
        ? preferredMonth
        : (months.includes(managerState.month) ? managerState.month : (months[0] || ''));
      monthSelect.innerHTML = months.length
        ? months.map((month) => `<option value="${escapeHtml(month)}"${month === managerState.month ? ' selected' : ''}>${escapeHtml(month)}</option>`).join('')
        : '<option value="">暂无已导入账期</option>';
      monthSelect.value = managerState.month;
    }

    async function reopenManagedResult(runId, triggerButton) {
      if (triggerButton) triggerButton.disabled = true;
      try {
        const fullResult = normalizeRunResponse(await api.getRun({ runId }));
        const outcome = await confirmArchive(fullResult);
        if (outcome && outcome.status === 'archived') {
          setStatus(`${outcome.targetMonth} 已确认归档，可导出结果`, 'success');
        }
        await refreshManagerData({ preferredMonth: managerState.month });
      } catch (error) {
        showMessage('查看结果失败', error.message || String(error), 'error');
      } finally {
        if (triggerButton && triggerButton.isConnected) triggerButton.disabled = false;
      }
    }

    async function render() {
      const currentVersion = ++renderVersion;
      const section = managerState.section;
      const month = managerState.month;
      modal.dialog.querySelectorAll('[data-section]').forEach((button) => {
        const selected = button.dataset.section === section;
        button.classList.toggle('active', selected);
        button.setAttribute('aria-current', selected ? 'page' : 'false');
      });
      managerTitle.textContent = titles[section];
      content.innerHTML = '<div class="vcc-fin-op-loading">正在读取…</div>';
      content.setAttribute('aria-busy', 'true');
      if (!month) {
        content.innerHTML = '<div class="vcc-fin-op-empty">暂无已导入账期</div>';
        content.setAttribute('aria-busy', 'false');
        return;
      }
      state.lastMonth = month;
      try {
        if (section === 'raw') {
          const records = previewData
            ? previewData.records
            : await api.listImportRecords({ yearMonth: month });
          if (currentVersion !== renderVersion) return;
          content.innerHTML = rawRecordsTable(records || []);
          content.setAttribute('aria-busy', 'false');
          content.querySelectorAll('[data-record-id]').forEach((button) => {
            button.addEventListener('click', () => openImportRecordDetail(Number(button.dataset.recordId), render));
          });
          return;
        }
        const overview = previewData
          ? { status: 'success', ...previewData.overview }
          : await api.dataManagerOverview({ yearMonth: month });
        if (currentVersion !== renderVersion) return;
        if (!overview || overview.status !== 'success') throw new Error(overview && overview.message || '读取数据管理状态失败');
        if (section === 'results') {
          content.innerHTML = renderResultOverviewTable(overview.results);
          content.setAttribute('aria-busy', 'false');
          content.querySelectorAll('[data-result-run-id]').forEach((button) => {
            button.addEventListener('click', () => (
              reopenManagedResult(Number(button.dataset.resultRunId), button)
            ));
          });
          return;
        }
        content.innerHTML = renderOverviewTable(
          overview.checks,
          '当前账期还没有校验表数据'
        );
        content.setAttribute('aria-busy', 'false');
      } catch (error) {
        if (currentVersion === renderVersion) {
          content.innerHTML = `<div class="vcc-fin-op-empty">${escapeHtml(error.message || String(error))}</div>`;
          content.setAttribute('aria-busy', 'false');
        }
      }
    }

    async function refreshManagerData({ preferredMonth = initialMonth } = {}) {
      const currentVersion = ++loadVersion;
      loadingManagerData = true;
      updateActionButtons();
      renderManagerSkeleton();
      try {
        const nextData = previewData
          ? [previewData.months || [], previewData.archivedMonths || []]
          : await Promise.all([api.listImportMonths(), loadArchivedResultMonths()]);
        if (currentVersion !== loadVersion) return;
        months = Array.isArray(nextData[0]) ? nextData[0] : [];
        archivedMonths = Array.isArray(nextData[1]) ? nextData[1] : [];
        populateMonthSelect(preferredMonth);
        applyArchivedMonthsState(archivedMonths);
        loadingManagerData = false;
        updateActionButtons();
        await render();
      } catch (error) {
        if (currentVersion !== loadVersion) return;
        months = [];
        archivedMonths = [];
        populateMonthSelect('');
        loadingManagerData = false;
        updateActionButtons();
        content.setAttribute('aria-busy', 'false');
        content.innerHTML = `
          <div class="vcc-fin-op-manager-load-error">
            <p>${escapeHtml(error.message || String(error))}</p>
            <button class="secondary-btn small" type="button" data-action="retry-manager-load">重试</button>
          </div>
        `;
        content.querySelector('[data-action="retry-manager-load"]').addEventListener('click', () => {
          modal.trackPreviewState(refreshManagerData({ preferredMonth }));
        });
      }
    }

    modal.dialog.querySelectorAll('[data-section]').forEach((button) => {
      button.addEventListener('click', () => {
        managerState.section = button.dataset.section;
        modal.trackPreviewState(render());
      });
    });
    monthSelect.addEventListener('change', () => {
      managerState.month = monthSelect.value;
      modal.trackPreviewState(render());
    });
    unarchiveButton.addEventListener('click', () => {
      openUnarchiveDialog({
        archivedMonths,
        onUnarchived: async (_result, entry) => {
          managerState.section = 'results';
          await refreshManagerData({ preferredMonth: entry.targetMonth });
          monthSelect.focus();
        }
      });
    });
    deleteButton.addEventListener('click', () => {
      openDatasetDeleteDialog({
        months,
        initialMonth: managerState.month,
        onDeleted: async (result) => {
          managerState.month = result.targetMonth || managerState.month;
          if (result.targetType === 'result' || result.targetType === 'opening_initialization') {
            managerState.section = 'results';
          }
          await refreshManagerData({ preferredMonth: managerState.month });
          monthSelect.focus();
        }
      });
    });
    exportButton.addEventListener('click', () => {
      openDatasetExportDialog({
        months,
        initialMonth: managerState.month,
        initialSection: managerState.section
      });
    });
    returnButton.addEventListener('click', modal.close);
    updateActionButtons();
    modal.trackPreviewState(refreshManagerData({ preferredMonth: initialMonth }));
    return modal;
  }

  async function initialize() {
    try {
      await refreshArchivedState();
      setStatus('欢迎使用小助手', 'info');
    } catch (_error) {
      // 启动时读取历史状态失败不阻断模块使用。
    } finally {
      setBusy(false);
    }
  }

  elements.importBtn.addEventListener('click', () => {
    if (state.busyKind === 'import') {
      handleCancelImport().catch((error) => {
        setStatus(`取消失败：${error.message || error}`, 'error');
        showMessage('取消失败', error.message || String(error), 'error');
      });
      return;
    }
    handleImport();
  });
  elements.runBtn.addEventListener('click', handleRun);
  elements.exportBtn.addEventListener('click', handleExport);
  elements.dataManagerBtn.addEventListener('click', () => openDataManager());

  function exposePreviewHooks(previewHooks) {
    if (!previewHooks) return false;
    Object.defineProperty(window, '__vccFinancialOpPreview', {
      value: Object.freeze(previewHooks),
      configurable: true,
      enumerable: false,
      writable: false
    });
    return true;
  }

  const PREVIEW_ARCHIVED_MONTHS = [
    { targetMonth: '2026-06', runId: 316, archivedAt: '2026-07-02 11:15:00', subjects: ['PPHK'] },
    { targetMonth: '2026-05', runId: 305, archivedAt: '2026-06-03 10:20:00', subjects: ['PPHK'] },
    { targetMonth: '2025-12', runId: 288, archivedAt: '2026-01-05 09:30:00', subjects: ['PPHK'] }
  ];

  function previewAmounts(values = {}) {
    return Object.fromEntries(CURRENCIES.map((currency) => [
      currency,
      Object.hasOwn(values, currency) ? values[currency] : null
    ]));
  }

  function previewSummary(defaultValue, values = {}) {
    return Object.fromEntries(CURRENCIES.map((currency) => [
      currency,
      Object.hasOwn(values, currency) ? values[currency] : defaultValue
    ]));
  }

  function buildResultPreview({ status = 'calculated', adjustmentCount = 0 } = {}) {
    const baseRows = [{
      type: 'base',
      rowKey: 'v1:preview-recharge-ops',
      subject: 'PPHK',
      sourceType: 'recharge_refund',
      sourceLabel: 'VCC充值清退明细',
      categoryMajor: '充值',
      categoryMinor: 'OPS',
      currencyAmounts: previewAmounts({ USD: '15208345.72' })
    }, {
      type: 'base',
      rowKey: 'v1:preview-fee-ops',
      subject: 'PPHK',
      sourceType: 'fee_fx',
      sourceLabel: 'VCC费用及换汇明细',
      categoryMajor: '费用',
      categoryMinor: 'OPS',
      currencyAmounts: previewAmounts({ EUR: '-2500.5' })
    }, {
      type: 'base',
      rowKey: 'v1:preview-channel',
      subject: 'PPHK',
      sourceType: 'channel',
      sourceLabel: 'VCC通道明细',
      categoryMajor: '通道',
      categoryMinor: 'CARD',
      currencyAmounts: previewAmounts({ JPY: '135886024.59' })
    }, {
      type: 'base',
      rowKey: 'v1:preview-pending',
      subject: 'PPHK',
      sourceType: 'pending_archive_removal',
      sourceLabel: 'VCC_移除归档Pending账单',
      categoryMajor: '移除归档Pending',
      categoryMinor: 'VCC_clearing_credit',
      currencyAmounts: previewAmounts({ CAD: '-1200' })
    }];
    const adjustmentCatalog = [{
      type: 'adjustment',
      rowKey: 'v1:preview-recharge-ops',
      subject: 'PPHK',
      sourceType: 'recharge_refund',
      sourceLabel: 'VCC充值清退明细',
      categoryMajor: '充值',
      categoryMinor: 'OPS',
      currency: 'USD',
      currencyAmounts: previewAmounts({ USD: '-5' }),
      adjustmentAmount: '-5',
      reason: '按银行回单核对调整'
    }, {
      type: 'adjustment',
      rowKey: 'v1:preview-fee-ops',
      subject: 'PPHK',
      sourceType: 'fee_fx',
      sourceLabel: 'VCC费用及换汇明细',
      categoryMajor: '费用',
      categoryMinor: 'OPS',
      currency: 'EUR',
      currencyAmounts: previewAmounts({ EUR: '12.5' }),
      adjustmentAmount: '12.5',
      reason: '补录已复核手续费差额'
    }, {
      type: 'adjustment',
      rowKey: 'v1:preview-pending',
      subject: 'PPHK',
      sourceType: 'pending_archive_removal',
      sourceLabel: 'VCC_移除归档Pending账单',
      categoryMajor: '移除归档Pending',
      categoryMinor: 'VCC_clearing_credit',
      currency: 'CAD',
      currencyAmounts: previewAmounts({ CAD: '-100' }),
      adjustmentAmount: '-100',
      reason: '依据复核记录修正 Pending 发生额'
    }];
    const adjustments = adjustmentCatalog.slice(0, adjustmentCount);
    const rows = [];
    for (const baseRow of baseRows) {
      rows.push(baseRow);
      rows.push(...adjustments.filter((row) => row.rowKey === baseRow.rowKey));
    }
    const hasUsdAdjustment = adjustmentCount >= 1;
    const hasEurAdjustment = adjustmentCount >= 2;
    const hasCadAdjustment = adjustmentCount >= 3;
    return {
      status,
      runId: 316,
      targetMonth: '2026-06',
      resultRevision: adjustmentCount,
      review: {
        currencies: CURRENCIES,
        subjects: [{
          subject: 'PPHK',
          rows,
          summaries: {
            openingBalance: previewSummary('1000000'),
            effectiveCalculatedBalance: previewSummary('1000000', {
              CAD: hasCadAdjustment ? '998700' : '998800',
              EUR: hasEurAdjustment ? '997512' : '997499.5',
              JPY: '136886024.59',
              USD: hasUsdAdjustment ? '16208340.72' : '16208345.72'
            }),
            systemBalance: previewSummary('1000000', {
              CAD: '998787.66',
              EUR: hasEurAdjustment ? '997512' : '997499.5',
              JPY: '136886024.59',
              USD: hasUsdAdjustment ? '16208340.72' : '16208345.72'
            }),
            effectiveDifference: previewSummary('0', {
              CAD: hasCadAdjustment ? '87.66' : '-12.34'
            })
          }
        }]
      }
    };
  }

  function previewDataManagerPayload({ hasArchive }) {
    return {
      months: ['2026-06', '2026-05'],
      archivedMonths: hasArchive ? [PREVIEW_ARCHIVED_MONTHS[0]] : [],
      records: [{
        id: 42,
        batchId: 'f91d2d4e-c2dd-4acd-a2c0-420000000001',
        targetMonth: '2026-06',
        sourceLabel: 'VCC充值清退明细',
        sourceFiles: ['VCC充值清退明细_01.xlsx', 'VCC充值清退明细_02.xlsx'],
        sourceFileDisplay: '2 个文件',
        finishedAt: '2026-07-02 10:28:41',
        status: 'deleted',
        statusText: '已删除'
      }, {
        id: 41,
        batchId: '2cc18056-e037-463a-8ed2-410000000001',
        targetMonth: '2026-06',
        sourceLabel: 'VCC通道明细',
        sourceFiles: ['VCC通道明细_01.xlsx'],
        sourceFileDisplay: 'VCC通道明细_01.xlsx',
        finishedAt: '2026-07-02 09:46:03',
        status: 'failed_conflict',
        statusText: '失败（幂等冲突）'
      }, {
        id: 40,
        batchId: '62850680-950d-4abd-babb-400000000001',
        targetMonth: '2026-06',
        sourceLabel: 'VCC_移除归档Pending账单',
        sourceFiles: ['VCC_移除归档Pending账单.xlsx'],
        sourceFileDisplay: 'VCC_移除归档Pending账单.xlsx',
        finishedAt: '2026-07-02 09:21:18',
        status: 'success',
        statusText: '导入成功'
      }],
      overview: {
        results: [{
          runId: 316,
          tableName: '财务OP校验结果表',
          dataStatus: hasArchive ? 'archived' : 'unprocessed',
          dataStatusText: hasArchive ? '已归档' : '未处理',
          resultRevision: 1,
          createdAt: '2026-07-02 11:00:00',
          updatedAt: '2026-07-02 11:08:00',
          archivedAt: hasArchive ? '2026-07-02 11:15:00' : null
        }],
        checks: [],
        raw: []
      }
    };
  }

  async function waitForArchivedPickerPreview(modal, {
    expectedYear,
    expectedMonth,
    expectedConfirmDisabled,
    stateMessageIncludes = ''
  } = {}) {
    if (!modal || !modal.dialog || typeof modal.waitForPreviewState !== 'function') {
      throw new Error('归档月份预览弹框未创建或不支持状态等待');
    }
    const snapshot = await modal.waitForPreviewState();
    const confirmButton = modal.dialog.querySelector('[data-action="archive-picker-confirm"]');
    const liveSnapshot = {
      ...snapshot,
      modalPresent: Boolean(
        modal.dialog.isConnected
        && modal.dialog.classList.contains('vcc-fin-op-archive-picker-dialog')
      ),
      confirmDisabled: Boolean(confirmButton && confirmButton.disabled === true)
    };
    if (!liveSnapshot.modalPresent) throw new Error('归档月份预览弹框未挂载');
    if (liveSnapshot.previewPending) throw new Error('归档月份预览仍在核对状态');
    if (expectedYear !== undefined && liveSnapshot.selectedYear !== expectedYear) {
      throw new Error(`归档月份预览年份不一致：${liveSnapshot.selectedYear} != ${expectedYear}`);
    }
    if (expectedMonth !== undefined && liveSnapshot.selectedMonth !== expectedMonth) {
      throw new Error(`归档月份预览月份不一致：${liveSnapshot.selectedMonth} != ${expectedMonth}`);
    }
    if (expectedConfirmDisabled !== undefined
      && liveSnapshot.confirmDisabled !== expectedConfirmDisabled) {
      throw new Error(
        `归档月份预览按钮禁用状态不一致：${liveSnapshot.confirmDisabled} != ${expectedConfirmDisabled}`
      );
    }
    if (stateMessageIncludes && !liveSnapshot.stateMessage.includes(stateMessageIncludes)) {
      throw new Error(`归档月份预览状态文案缺少：${stateMessageIncludes}`);
    }
    return liveSnapshot;
  }

  async function waitForTrackedPreview(modal, {
    expectedMonth,
    expectedTarget,
    expectedSection,
    expectedConfirmDisabled,
    stateMessageIncludes = '',
    contentIncludes = ''
  } = {}) {
    if (!modal || !modal.dialog || typeof modal.waitForPreviewState !== 'function') {
      throw new Error('VCC 预览弹框未创建或不支持状态等待');
    }
    const snapshot = await modal.waitForPreviewState();
    const liveSnapshot = {
      ...snapshot,
      modalPresent: Boolean(modal.dialog.isConnected)
    };
    if (!liveSnapshot.modalPresent) throw new Error('VCC 预览弹框未挂载');
    if (liveSnapshot.previewPending) throw new Error('VCC 预览仍在构建状态');
    if (expectedMonth !== undefined && liveSnapshot.selectedMonth !== expectedMonth) {
      throw new Error(`VCC 预览月份不一致：${liveSnapshot.selectedMonth} != ${expectedMonth}`);
    }
    if (expectedTarget !== undefined && liveSnapshot.selectedTarget !== expectedTarget) {
      throw new Error(`VCC 预览目标不一致：${liveSnapshot.selectedTarget} != ${expectedTarget}`);
    }
    if (expectedSection !== undefined && liveSnapshot.selectedSection !== expectedSection) {
      throw new Error(`VCC 预览分区不一致：${liveSnapshot.selectedSection} != ${expectedSection}`);
    }
    if (expectedConfirmDisabled !== undefined
      && liveSnapshot.confirmDisabled !== expectedConfirmDisabled) {
      throw new Error(
        `VCC 预览按钮禁用状态不一致：${liveSnapshot.confirmDisabled} != ${expectedConfirmDisabled}`
      );
    }
    if (stateMessageIncludes
      && !String(liveSnapshot.stateMessage || '').includes(stateMessageIncludes)) {
      throw new Error(
        `VCC 预览状态文案缺少：${stateMessageIncludes}；当前：${liveSnapshot.stateMessage || ''}`
      );
    }
    if (contentIncludes && !String(liveSnapshot.contentText || '').includes(contentIncludes)) {
      throw new Error(`VCC 预览内容缺少：${contentIncludes}`);
    }
    return liveSnapshot;
  }

  function selectPreviewControl(modal, selector, value, options = {}) {
    const normalizedOptions = typeof options === 'number' ? { delay: options } : options;
    const delay = normalizedOptions.delay == null ? 180 : normalizedOptions.delay;
    return new Promise((resolve, reject) => {
      setTimeout(async () => {
        try {
          const control = modal && modal.dialog && modal.dialog.querySelector(selector);
          if (!control) throw new Error(`预览控件不存在：${selector}`);
          control.value = value;
          control.dispatchEvent(new Event('change', { bubbles: true }));
          if (control.value !== value) throw new Error(`预览控件未稳定到目标值：${value}`);
          if (typeof modal.waitForPreviewState === 'function') {
            if (modal.dialog.classList.contains('vcc-fin-op-archive-picker-dialog')) {
              resolve(await waitForArchivedPickerPreview(modal, normalizedOptions));
              return;
            }
            resolve(await waitForTrackedPreview(modal, {
              ...normalizedOptions,
              expectedTarget: normalizedOptions.expectedTarget === undefined
                ? value
                : normalizedOptions.expectedTarget
            }));
            return;
          }
          resolve({ modalPresent: Boolean(modal.dialog.isConnected), selectedValue: control.value });
        } catch (error) {
          reject(error);
        }
      }, delay);
    });
  }

  function createUnarchivePreviewDialog() {
    return createArchivedMonthPickerDialog({
      months: PREVIEW_ARCHIVED_MONTHS,
      actionLabel: '解归档',
      confirmationLabel: '我已确认：解归档后只能由 v3.1.9 及以上版本继续维护；降级前必须恢复完整数据库备份',
      previewSelection: async (entry) => ({
        status: 'success',
        canUnarchive: entry.targetMonth === '2026-06',
        dependentMonths: entry.targetMonth === '2026-06' ? [] : ['2026-06'],
        message: entry.targetMonth === '2026-06'
          ? '2026-06 可解归档；基础结果和调整记录将保留。'
          : '该月之后仍存在已归档月份，请先从最新月份开始解归档。',
        previewToken: 'preview-token',
        taskGeneration: 0
      }),
      executeSelection: async (entry) => ({ status: 'success', targetMonth: entry.targetMonth })
    });
  }

  const previewHooks = window.desktopApi.previewCapture === true ? {
    openPanel() {
      return null;
    },
    openImportMonth() {
      return chooseImportMonth({ title: '选择导入账期' });
    },
    openRunMonth() {
      return chooseMonth({
        title: '选择运行账期',
        months: ['2026-06', '2026-05'],
        initial: '2026-06'
      });
    },
    async openDataManager() {
      const modal = await openDataManager({
        initialMonth: '2026-06',
        initialSection: 'raw',
        previewData: previewDataManagerPayload({ hasArchive: true })
      });
      return waitForTrackedPreview(modal, {
        expectedMonth: '2026-06',
        expectedSection: 'raw',
        contentIncludes: 'VCC充值清退明细'
      });
    },
    async openDataManagerNoArchive() {
      const modal = await openDataManager({
        initialMonth: '2026-06',
        initialSection: 'results',
        previewData: previewDataManagerPayload({ hasArchive: false })
      });
      return waitForTrackedPreview(modal, {
        expectedMonth: '2026-06',
        expectedSection: 'results',
        contentIncludes: '财务OP校验结果表'
      });
    },
    openDelete() {
      const modal = openDatasetDeleteDialog({
        months: ['2026-06', '2026-05'],
        initialMonth: '2026-06',
        previewResult: {
          deletable: true,
          dataCount: 36932,
          calculatedRunCount: 1
        }
      });
      return waitForTrackedPreview(modal, {
        expectedMonth: '2026-06',
        expectedTarget: 'recharge_refund',
        expectedConfirmDisabled: false,
        stateMessageIncludes: '36,932'
      });
    },
    openDeleteFirstMonth() {
      const modal = openDatasetDeleteDialog({
        months: ['2026-06'],
        initialMonth: '2026-06',
        previewResult: ({ targetType }) => targetType === 'opening_initialization'
          ? {
            targetType,
            targetLabel: '首月期初初始化数据',
            deletable: true,
            count: 1,
            calculatedRunCount: 1,
            previewToken: 'opening-preview-token',
            taskGeneration: 0
          }
          : { targetType, deletable: true, dataCount: 36932, calculatedRunCount: 1 }
      });
      return selectPreviewControl(modal, '[data-field="delete-target"]', 'opening_initialization', {
        expectedMonth: '2026-06',
        expectedConfirmDisabled: false,
        stateMessageIncludes: '主体期初初始化数据'
      });
    },
    openDeleteFirstMonthArchived() {
      const modal = openDatasetDeleteDialog({
        months: ['2026-06'],
        initialMonth: '2026-06',
        previewResult: ({ targetType }) => targetType === 'opening_initialization'
          ? {
            targetType,
            targetLabel: '首月期初初始化数据',
            deletable: false,
            disabledReason: '该月财务OP校验结果已归档，请先解归档后再删除首月期初初始化数据'
          }
          : { targetType, deletable: true, dataCount: 36932, calculatedRunCount: 0 }
      });
      return selectPreviewControl(modal, '[data-field="delete-target"]', 'opening_initialization', {
        expectedMonth: '2026-06',
        expectedConfirmDisabled: true,
        stateMessageIncludes: '已归档'
      });
    },
    openDeleteResult() {
      const modal = openDatasetDeleteDialog({
        months: ['2026-06'],
        initialMonth: '2026-06',
        previewResult: ({ targetType }) => targetType === 'result'
          ? {
            targetType,
            targetLabel: '财务OP校验结果表',
            deletable: true,
            count: 2,
            calculatedRunCount: 2,
            previewToken: 'result-preview-token',
            taskGeneration: 0
          }
          : { targetType, deletable: true, dataCount: 36932, calculatedRunCount: 2 }
      });
      return selectPreviewControl(modal, '[data-field="delete-target"]', 'result', {
        expectedMonth: '2026-06',
        expectedConfirmDisabled: false,
        stateMessageIncludes: '2 份未归档'
      });
    },
    openUnarchive() {
      const modal = createUnarchivePreviewDialog();
      return waitForArchivedPickerPreview(modal, {
        expectedYear: '2026',
        expectedMonth: '2026-06',
        expectedConfirmDisabled: true,
        stateMessageIncludes: '可解归档'
      });
    },
    openUnarchiveYearSwitch() {
      const modal = createUnarchivePreviewDialog();
      return selectPreviewControl(modal, '[data-field="archive-year"]', '2025', {
        expectedYear: '2025',
        expectedMonth: '2025-12',
        expectedConfirmDisabled: true,
        stateMessageIncludes: '2026-06'
      });
    },
    openUnarchiveNonTail() {
      const modal = createUnarchivePreviewDialog();
      return selectPreviewControl(modal, '[data-field="archive-month"]', '2026-05', {
        expectedYear: '2026',
        expectedMonth: '2026-05',
        expectedConfirmDisabled: true,
        stateMessageIncludes: '2026-06'
      });
    },
    openUnarchiveExecuting() {
      const modal = createArchivedMonthPickerDialog({
        months: PREVIEW_ARCHIVED_MONTHS,
        actionLabel: '解归档',
        confirmationLabel: '我已确认：解归档后只能由 v3.1.9 及以上版本继续维护；降级前必须恢复完整数据库备份',
        previewSelection: async () => ({
          status: 'success', canUnarchive: true, previewToken: 'preview-token', taskGeneration: 0
        }),
        runningText: '正在解归档…',
        executeSelection: () => new Promise(() => {})
      });
      return waitForArchivedPickerPreview(modal, {
        expectedYear: '2026',
        expectedMonth: '2026-06',
        expectedConfirmDisabled: true
      }).then(() => {
        const confirmation = modal && modal.dialog.querySelector('[data-field="archive-picker-confirm"]');
        if (!confirmation) throw new Error('解归档确认警示缺失');
        confirmation.checked = true;
        confirmation.dispatchEvent(new Event('change', { bubbles: true }));
        const button = modal && modal.dialog.querySelector('[data-action="archive-picker-confirm"]');
        if (!button || button.disabled) throw new Error('执行中预览无法启动解归档');
        button.click();
        return waitForArchivedPickerPreview(modal, {
          expectedYear: '2026',
          expectedMonth: '2026-06',
          expectedConfirmDisabled: true,
          stateMessageIncludes: '正在解归档'
        });
      });
    },
    openResultExportMonth() {
      const modal = createArchivedMonthPickerDialog({
        months: PREVIEW_ARCHIVED_MONTHS,
        actionLabel: '导出',
        previewSelection: async (entry) => ({
          status: 'success',
          months: PREVIEW_ARCHIVED_MONTHS,
          canExecute: true,
          message: `${entry.targetMonth} 已归档，可导出`,
          tone: 'success'
        }),
        executeSelection: async (entry) => ({ status: 'success', targetMonth: entry.targetMonth })
      });
      return waitForArchivedPickerPreview(modal, {
        expectedYear: '2026',
        expectedMonth: '2026-06',
        expectedConfirmDisabled: false,
        stateMessageIncludes: '可导出'
      });
    },
    openResultExportMonthEmpty() {
      applyArchivedMonthsState([]);
      setStatus('暂无已归档财务OP校验结果', 'info');
      return null;
    },
    openExport() {
      const modal = openDatasetExportDialog({
        months: ['2026-06', '2026-05'],
        initialMonth: '2026-06',
        initialSection: 'checks',
        previewResult: {
          exportable: true,
          dataCount: 4003645
        }
      });
      return waitForTrackedPreview(modal, {
        expectedMonth: '2026-06',
        expectedTarget: 'check:recharge_refund',
        expectedConfirmDisabled: false,
        stateMessageIncludes: '4,003,645'
      });
    },
    openResult() {
      return confirmArchive(buildResultPreview());
    },
    openResultSingleAdjustment() {
      return confirmArchive(buildResultPreview({ adjustmentCount: 1 }));
    },
    openResultMultipleAdjustments() {
      return confirmArchive(buildResultPreview({ adjustmentCount: 3 }));
    },
    openResultArchived() {
      return confirmArchive(buildResultPreview({ status: 'archived', adjustmentCount: 1 }));
    },
    openRunPreflightError() {
      const result = {
        code: 'missing-datasets',
        missing: ['VCC_移除归档Pending账单_校验表']
      };
      const message = blockedCalculationMessage(result);
      setStatus(`无法运行：${message}`, 'warning');
      showMessage('无法开始运行', message, 'warning');
      return null;
    },
    openAdjustment() {
      return requestRunAdjustment({
        runId: 316,
        targetMonth: '2026-06',
        resultRevision: 1,
        status: 'calculated'
      }, {
        status: 'success',
        runStatus: 'calculated',
        runId: 316,
        targetMonth: '2026-06',
        resultRevision: 1,
        currencies: CURRENCIES,
        options: [{
          rowKey: 'v1:preview-recharge-ops',
          subject: 'PPHK',
          sourceType: 'recharge_refund',
          sourceLabel: 'VCC充值清退明细',
          categoryMajor: '充值',
          categoryMinor: 'OPS',
          availableCurrencies: CURRENCIES,
          adjustedCurrencies: []
        }, {
          rowKey: 'v1:preview-fee-ops',
          subject: 'PPHK',
          sourceType: 'fee_fx',
          sourceLabel: 'VCC费用及换汇明细',
          categoryMajor: '费用',
          categoryMinor: 'OPS',
          availableCurrencies: ['EUR', 'USD'],
          adjustedCurrencies: []
        }]
      });
    },
    openOpening() {
      return requestOpeningInitialization({
        status: 'blocked',
        code: 'missing-opening-balance',
        targetMonth: '2026-06',
        previousMonth: '2026-05',
        missingOpeningSubjects: ['PPHK']
      });
    }
  } : null;
  exposePreviewHooks(previewHooks);
  initialize();
})();
