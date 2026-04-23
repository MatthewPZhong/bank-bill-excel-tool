// v2.0.0 Pending 模块渲染层
// T1-T6 范围：DB / 顶部下拉 / 骨架 / 规则 / import worker / 导入入口 UI + 覆盖留底 + 进度 + 报错链路

window.__rendererPending = (function () {
  'use strict';

  function createRendererPending(deps) {
    const {
      state,
      elements,
      desktopApi,
      openModal,
      closeModal,
      createAlertDialog,
      createConfirmDialog
    } = deps;

    let columnsCache = null;

    function computePendingStatusText() {
      const p = state.pending;
      if (p.importing) return p.importingText || '正在导入...';
      if (p.running) return p.runningText || '正在对账...';
      if (p.errorReportAvailable) {
        return `${p.errorMessage || '导入失败'}（点击导出报错文件）`;
      }
      if (!p.rule || !p.rule.matchFields || p.rule.matchFields.length === 0) {
        return '初次使用请确认用来筛选的字段~';
      }
      if (!p.months || p.months.length === 0) {
        return '请导入 Pending 数据。';
      }
      if (p.latestRunResult) return p.latestRunResult;
      if (p.lastImportSummary) return p.lastImportSummary;
      return `已导入 ${p.months.join(' / ')}。请点击"开始运行"选取对账月份。`;
    }

    function setPendingStatus(text) {
      if (elements.pendingStatusBox) {
        elements.pendingStatusBox.textContent = text;
      }
    }

    function refreshPendingUi() {
      setPendingStatus(computePendingStatusText());
      elements.pendingStatusBox.classList.toggle('pending-status-clickable', !!state.pending.errorReportAvailable);

      const hasRule = !!(state.pending.rule && state.pending.rule.matchFields && state.pending.rule.matchFields.length > 0);
      const hasMonths = state.pending.months && state.pending.months.length > 0;
      elements.pendingImportBtn.disabled = !hasRule || state.pending.importing || state.pending.running;
      elements.pendingRunBtn.disabled = !hasRule || !hasMonths || state.pending.running || state.pending.importing;
      elements.pendingExportBtn.disabled = !state.pending.latestRunResult;
    }

    async function loadRule() {
      if (!desktopApi || !desktopApi.pending || typeof desktopApi.pending.getRule !== 'function') {
        state.pending.rule = null;
        return;
      }
      try {
        state.pending.rule = (await desktopApi.pending.getRule()) || null;
      } catch (err) {
        console.error('[pending] loadRule failed:', err);
        state.pending.rule = null;
      }
    }

    async function loadColumns() {
      if (columnsCache) return columnsCache;
      if (!desktopApi || !desktopApi.pending || typeof desktopApi.pending.getColumns !== 'function') {
        columnsCache = [];
        return columnsCache;
      }
      try {
        const cols = await desktopApi.pending.getColumns();
        columnsCache = Array.isArray(cols) ? cols.slice() : [];
      } catch (err) {
        console.error('[pending] loadColumns failed:', err);
        columnsCache = [];
      }
      return columnsCache;
    }

    async function loadMonths() {
      if (!desktopApi || !desktopApi.pending || typeof desktopApi.pending.listMonths !== 'function') {
        state.pending.months = [];
        return;
      }
      try {
        const months = await desktopApi.pending.listMonths();
        state.pending.months = Array.isArray(months) ? months : [];
      } catch (err) {
        console.error('[pending] loadMonths failed:', err);
        state.pending.months = [];
      }
    }

    // ========== 规则管理对话框 ==========

    function buildRuleDialogNode({ columns, currentRule }) {
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      const dialog = document.createElement('div');
      dialog.className = 'modal-card pending-rule-dialog';
      overlay.appendChild(dialog);

      const title = document.createElement('div');
      title.className = 'alert-message';
      title.textContent = 'Pending 数据筛选规则';
      dialog.appendChild(title);

      function buildSection(labelText, selectedValues) {
        const row = document.createElement('div');
        row.className = 'pending-rule-row';
        const label = document.createElement('label');
        label.textContent = labelText;
        label.className = 'pending-rule-label';
        row.appendChild(label);
        const select = document.createElement('select');
        select.multiple = true;
        select.size = Math.min(10, columns.length);
        select.className = 'pending-rule-select';
        columns.forEach((col) => {
          const option = document.createElement('option');
          option.value = col;
          option.textContent = col;
          if (selectedValues && selectedValues.includes(col)) option.selected = true;
          select.appendChild(option);
        });
        row.appendChild(select);
        dialog.appendChild(row);
        return select;
      }

      const matchSelect = buildSection('对账字段', currentRule ? currentRule.matchFields : []);
      const compareSelect = buildSection('对账内容', currentRule ? currentRule.compareFields : []);

      const actions = document.createElement('div');
      actions.className = 'dialog-actions center';
      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'secondary-btn small';
      cancelBtn.type = 'button';
      cancelBtn.textContent = '取消';
      cancelBtn.addEventListener('click', () => closeModal());
      const saveBtn = document.createElement('button');
      saveBtn.className = 'primary-btn small';
      saveBtn.type = 'button';
      saveBtn.textContent = '完成';
      saveBtn.addEventListener('click', () => {
        const matchFields = Array.from(matchSelect.selectedOptions).map((o) => o.value);
        const compareFields = Array.from(compareSelect.selectedOptions).map((o) => o.value);
        if (matchFields.length === 0) {
          openModal(createAlertDialog('请至少选择一个"对账字段"（匹配 key）'));
          return;
        }
        handleRuleConfirm({ matchFields, compareFields });
      });
      actions.appendChild(cancelBtn);
      actions.appendChild(saveBtn);
      dialog.appendChild(actions);
      return overlay;
    }

    function handleRuleConfirm({ matchFields, compareFields }) {
      const message = [
        '请确认筛选的字段：',
        `对账字段 (${matchFields.length}): ${matchFields.join('、') || '(无)'}`,
        `对账内容 (${compareFields.length}): ${compareFields.join('、') || '(无)'}`
      ].join('\n');
      openModal(createConfirmDialog({
        message,
        confirmText: '确认',
        cancelText: '取消',
        onConfirm: async () => {
          try {
            const saved = await desktopApi.pending.saveRule({ matchFields, compareFields });
            state.pending.rule = saved;
            closeModal();
            refreshPendingUi();
          } catch (err) {
            openModal(createAlertDialog('保存规则失败：' + (err && err.message ? err.message : String(err))));
          }
        }
      }));
    }

    async function handlePendingRuleClick() {
      const columns = await loadColumns();
      if (!columns || columns.length === 0) {
        openModal(createAlertDialog('无法加载 Pending 模板表头，请检查 assets/Pending.xlsx 或 Pending DB 初始化。'));
        return;
      }
      openModal(buildRuleDialogNode({ columns, currentRule: state.pending.rule }));
    }

    // ========== 年月选择对话框 ==========

    function buildImportMonthDialog({ onConfirm, onCancel }) {
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      const dialog = document.createElement('div');
      dialog.className = 'modal-card pending-import-month-dialog';
      overlay.appendChild(dialog);

      const title = document.createElement('div');
      title.className = 'alert-message';
      title.textContent = '请选择 Pending 数据所属年月';
      dialog.appendChild(title);

      const row = document.createElement('div');
      row.className = 'pending-rule-row';
      const yearSelect = document.createElement('select');
      yearSelect.className = 'pending-rule-select';
      const now = new Date();
      const currentYear = now.getFullYear();
      for (let y = currentYear - 9; y <= currentYear + 1; y += 1) {
        const opt = document.createElement('option');
        opt.value = String(y);
        opt.textContent = `${y} 年`;
        if (y === currentYear) opt.selected = true;
        yearSelect.appendChild(opt);
      }
      const monthSelect = document.createElement('select');
      monthSelect.className = 'pending-rule-select';
      const defaultMonth = now.getMonth() + 1;
      for (let m = 1; m <= 12; m += 1) {
        const opt = document.createElement('option');
        opt.value = String(m).padStart(2, '0');
        opt.textContent = `${m} 月`;
        if (m === defaultMonth) opt.selected = true;
        monthSelect.appendChild(opt);
      }
      row.appendChild(yearSelect);
      row.appendChild(monthSelect);
      dialog.appendChild(row);

      const actions = document.createElement('div');
      actions.className = 'dialog-actions center';
      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'secondary-btn small';
      cancelBtn.type = 'button';
      cancelBtn.textContent = '取消';
      cancelBtn.addEventListener('click', () => { if (typeof onCancel === 'function') onCancel(); });
      const confirmBtn = document.createElement('button');
      confirmBtn.className = 'primary-btn small';
      confirmBtn.type = 'button';
      confirmBtn.textContent = '确认';
      confirmBtn.addEventListener('click', () => {
        const yearMonth = `${yearSelect.value}-${monthSelect.value}`;
        if (typeof onConfirm === 'function') onConfirm(yearMonth);
      });
      actions.appendChild(cancelBtn);
      actions.appendChild(confirmBtn);
      dialog.appendChild(actions);
      return overlay;
    }

    // ========== 导入主流程 ==========

    async function handlePendingImportClick() {
      let pickResult;
      try {
        pickResult = await desktopApi.pending.pickFiles();
      } catch (err) {
        openModal(createAlertDialog('打开文件选择对话框失败：' + (err && err.message ? err.message : String(err))));
        return;
      }
      if (!pickResult || pickResult.cancelled || !Array.isArray(pickResult.files) || pickResult.files.length === 0) {
        return;
      }
      const files = pickResult.files.slice();
      openModal(buildImportMonthDialog({
        onConfirm: (yearMonth) => {
          closeModal();
          startImport(files, yearMonth, false).catch((err) => {
            console.error('[pending] startImport error:', err);
          });
        },
        onCancel: () => closeModal()
      }));
    }

    async function startImport(files, yearMonth, overwriteConfirmed) {
      state.pending.importing = true;
      state.pending.importingText = `正在导入 ${yearMonth}（${files.length} 个文件）...`;
      state.pending.errorReportAvailable = false;
      state.pending.errorMessage = null;
      refreshPendingUi();

      try {
        const result = await desktopApi.pending.startImport({ files, yearMonth, overwriteConfirmed: !!overwriteConfirmed });

        if (result && result.status === 'need-confirm') {
          state.pending.importing = false;
          refreshPendingUi();
          openModal(createConfirmDialog({
            message: `${yearMonth} 已有 ${result.existingRowCount} 行 Pending 数据${result.existingImportedAt ? `（导入时间 ${result.existingImportedAt}）` : ''}。\n\n继续将留底旧数据到 pending-archives/ 并覆盖。`,
            confirmText: '确认覆盖',
            cancelText: '取消',
            onConfirm: () => {
              closeModal();
              startImport(files, yearMonth, true).catch((err) => {
                console.error('[pending] overwrite import error:', err);
              });
            }
          }));
          return;
        }

        if (result && result.status === 'success') {
          state.pending.importing = false;
          state.pending.lastImportSummary = `${yearMonth} 导入成功（${result.rowCount} 行，来源 ${Array.isArray(result.sourceFiles) ? result.sourceFiles.length : 1} 个文件）${result.archivePath ? '。旧数据已留底' : ''}。`;
          await loadMonths();
          refreshPendingUi();
          return;
        }

        // error
        const errors = result && Array.isArray(result.errors) ? result.errors : [];
        const summary = summarizeErrors(errors);
        state.pending.importing = false;
        state.pending.errorReportAvailable = errors.length > 0;
        state.pending.errorMessage = summary;
        refreshPendingUi();
      } catch (err) {
        state.pending.importing = false;
        state.pending.errorReportAvailable = false;
        state.pending.errorMessage = null;
        refreshPendingUi();
        openModal(createAlertDialog('导入调用失败：' + (err && err.message ? err.message : String(err))));
      }
    }

    function summarizeErrors(errors) {
      if (!errors || errors.length === 0) return '导入失败';
      const fatal = errors.filter((e) => e.severity === 'fatal');
      const row = errors.filter((e) => e.severity === 'row');
      if (fatal.length > 0) {
        const first = fatal[0];
        return `${first.message}${fatal.length > 1 ? `（还有 ${fatal.length - 1} 条同级错误）` : ''}`;
      }
      return `发现 ${row.length} 条行级错误`;
    }

    async function handleStatusBoxClick() {
      if (!state.pending.errorReportAvailable) return;
      try {
        const result = await desktopApi.pending.exportErrorReport();
        if (!result) return;
        if (result.status === 'success') {
          openModal(createAlertDialog(`报错文件已导出：${result.path}（${result.errorCount} 条错误）`));
        } else if (result.status === 'cancelled') {
          // 无动作
        } else if (result.status === 'error') {
          openModal(createAlertDialog('导出报错文件失败：' + (result.message || '未知错误')));
        }
      } catch (err) {
        openModal(createAlertDialog('导出报错文件异常：' + (err && err.message ? err.message : String(err))));
      }
    }

    // ========== 初始化 + 事件绑定 ==========

    async function initialize() {
      await loadRule();
      await loadMonths();
      refreshPendingUi();
    }

    function bindEvents() {
      if (elements.pendingRuleBtn) {
        elements.pendingRuleBtn.addEventListener('click', () => {
          handlePendingRuleClick().catch((err) => console.error('[pending] rule click error:', err));
        });
      }
      if (elements.pendingImportBtn) {
        elements.pendingImportBtn.addEventListener('click', () => {
          handlePendingImportClick().catch((err) => console.error('[pending] import click error:', err));
        });
      }
      if (elements.pendingStatusBox) {
        elements.pendingStatusBox.addEventListener('click', handleStatusBoxClick);
      }
      if (desktopApi && desktopApi.pending && typeof desktopApi.pending.onImportProgress === 'function') {
        desktopApi.pending.onImportProgress((ev) => {
          if (!ev || ev.type !== 'progress') return;
          state.pending.importingText = `正在导入 ${state.pending.importing ? '' : ''}：${ev.file || ''}（${ev.rowsProcessed || 0} 行）`;
          if (state.pending.importing) refreshPendingUi();
        });
      }
      // T7 / T8 / T9 绑定对账 / 导出按钮
    }

    return {
      initialize,
      refreshPendingUi,
      setPendingStatus,
      computePendingStatusText,
      bindEvents
    };
  }

  return { createRendererPending };
})();
