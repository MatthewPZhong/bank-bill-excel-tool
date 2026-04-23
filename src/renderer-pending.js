// v2.0.0 Pending 模块渲染层
// T1-T4 范围：独立 DB / 顶部下拉 / 模块骨架 / 规则管理（UI + IPC + repo）
// 后续 T5-T10 扩展：导入、对账、导出、状态框完整流

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
      if (!p.rule || !p.rule.matchFields || p.rule.matchFields.length === 0) {
        return '初次使用请确认用来筛选的字段~';
      }
      if (!p.months || p.months.length === 0) {
        return '请导入 Pending 数据。';
      }
      if (p.importing) {
        return '正在导入...';
      }
      if (p.running) {
        return '正在对账...';
      }
      if (p.latestRunResult) {
        return p.latestRunResult;
      }
      return `已导入 ${p.months.join(' / ')}。请点击"开始运行"选取对账月份。`;
    }

    function setPendingStatus(text) {
      if (elements.pendingStatusBox) {
        elements.pendingStatusBox.textContent = text;
      }
    }

    function refreshPendingUi() {
      setPendingStatus(computePendingStatusText());
      const hasRule = !!(state.pending.rule && state.pending.rule.matchFields && state.pending.rule.matchFields.length > 0);
      const hasMonths = state.pending.months && state.pending.months.length > 0;
      elements.pendingImportBtn.disabled = !hasRule || state.pending.importing;
      elements.pendingRunBtn.disabled = !hasRule || !hasMonths || state.pending.running;
      elements.pendingExportBtn.disabled = !state.pending.latestRunResult;
    }

    async function loadRule() {
      if (!desktopApi || !desktopApi.pending || typeof desktopApi.pending.getRule !== 'function') {
        state.pending.rule = null;
        return;
      }
      try {
        const rule = await desktopApi.pending.getRule();
        state.pending.rule = rule || null;
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
          if (selectedValues && selectedValues.includes(col)) {
            option.selected = true;
          }
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
        openModal(createAlertDialog('无法加载 Pending 模板表头，请检查 assets/Pending.xlsx 或 Pending DB 是否正常初始化。'));
        return;
      }
      openModal(buildRuleDialogNode({ columns, currentRule: state.pending.rule }));
    }

    async function initialize() {
      await loadRule();
      refreshPendingUi();
    }

    function bindEvents() {
      if (elements.pendingRuleBtn) {
        elements.pendingRuleBtn.addEventListener('click', () => {
          handlePendingRuleClick().catch((err) => {
            console.error('[pending] rule click error:', err);
          });
        });
      }
      // T5 / T6 / T8 / T9 逐步绑定：import / run / export 按钮
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
