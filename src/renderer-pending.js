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

    function isAdjacentMonths(upper, lower) {
      if (typeof upper !== 'string' || typeof lower !== 'string') return false;
      if (!/^\d{4}-\d{2}$/.test(upper) || !/^\d{4}-\d{2}$/.test(lower)) return false;
      const [uY, uM] = upper.split('-').map(Number);
      const [lY, lM] = lower.split('-').map(Number);
      let prevYear = lY;
      let prevMonth = lM - 1;
      if (prevMonth === 0) { prevMonth = 12; prevYear -= 1; }
      return prevYear === uY && prevMonth === uM;
    }

    function formatDurationSec(ms) {
      if (!Number.isFinite(ms) || ms < 0) return '—';
      if (ms < 1000) return '< 1 秒';
      const sec = Math.round(ms / 1000);
      if (sec < 60) return `${sec} 秒`;
      const min = Math.floor(sec / 60);
      const restSec = sec % 60;
      return restSec > 0 ? `${min} 分 ${restSec} 秒` : `${min} 分`;
    }

    function computePendingStatusText() {
      const p = state.pending;
      if (p.importing) return p.importingText || '正在导入...';
      if (p.running) return p.runningText || '正在对账...';
      if (p.errorReportAvailable) {
        return `${p.errorMessage || '导入失败'}，点击导出报错文件。`;
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
      const box = elements.pendingStatusBox;
      if (box) {
        const p = state.pending;
        box.classList.toggle('is-clickable', !!p.errorReportAvailable);
        if (p.errorReportAvailable) {
          box.dataset.tone = 'error';
        } else if (!p.importing && !p.running && (p.lastImportSummary || p.latestRunResult)) {
          box.dataset.tone = 'success';
        } else {
          delete box.dataset.tone;
        }
      }

      const hasRule = !!(state.pending.rule && state.pending.rule.matchFields && state.pending.rule.matchFields.length > 0);
      const hasMonths = state.pending.months && state.pending.months.length > 0;
      elements.pendingImportBtn.disabled = !hasRule || state.pending.importing || state.pending.running;
      elements.pendingRunBtn.disabled = !hasRule || !hasMonths || state.pending.running || state.pending.importing;
      elements.pendingExportBtn.disabled = !state.pending.latestRunId;
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
    // 布局：左上标题 | 两列并排（对账字段 / 对账内容）| 下方取消+完成
    // 每列 N 行单选下拉；第 1 行 "新增"，第 2 行起 "删除"

    function buildRuleDialogNode({ columns, currentRule }) {
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      const dialog = document.createElement('div');
      dialog.className = 'modal-card pending-rule-dialog';
      overlay.appendChild(dialog);

      const title = document.createElement('div');
      title.className = 'pending-rule-title';
      title.textContent = 'Pending 数据对账规则';
      dialog.appendChild(title);

      const columnsWrap = document.createElement('div');
      columnsWrap.className = 'pending-rule-columns';
      dialog.appendChild(columnsWrap);

      function buildColumn(labelText, initialValues) {
        const column = document.createElement('div');
        column.className = 'pending-rule-column';

        const header = document.createElement('div');
        header.className = 'pending-rule-column-header';
        header.textContent = labelText;
        column.appendChild(header);

        const rowsBox = document.createElement('div');
        rowsBox.className = 'pending-rule-rows';
        column.appendChild(rowsBox);
        columnsWrap.appendChild(column);

        function createFieldRow(initialValue) {
          const fieldRow = document.createElement('div');
          fieldRow.className = 'pending-rule-field-row';

          const select = document.createElement('select');
          select.className = 'mapping-select pending-rule-field-select';
          const placeholder = document.createElement('option');
          placeholder.value = '';
          placeholder.textContent = '（请选择）';
          select.appendChild(placeholder);
          columns.forEach((col) => {
            const opt = document.createElement('option');
            opt.value = col;
            opt.textContent = col;
            if (initialValue && initialValue === col) opt.selected = true;
            select.appendChild(opt);
          });
          fieldRow.appendChild(select);

          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'pending-rule-field-btn';
          fieldRow.appendChild(btn);

          function updateBtn() {
            const isFirst = rowsBox.firstChild === fieldRow;
            btn.textContent = isFirst ? '新增' : '删除';
            btn.dataset.role = isFirst ? 'add' : 'remove';
          }
          btn.addEventListener('click', () => {
            if (btn.dataset.role === 'add') {
              const newRow = createFieldRow('');
              rowsBox.appendChild(newRow);
              refreshAllRowButtons();
            } else {
              rowsBox.removeChild(fieldRow);
              refreshAllRowButtons();
            }
          });

          // 初始化按钮状态（由外层 refreshAllRowButtons 调整）
          fieldRow._updateBtn = updateBtn;
          return fieldRow;
        }

        function refreshAllRowButtons() {
          Array.from(rowsBox.children).forEach((r) => r._updateBtn && r._updateBtn());
        }

        // 初始行：有历史值则每个值一行；否则一行空
        const seed = Array.isArray(initialValues) && initialValues.length > 0 ? initialValues : [''];
        seed.forEach((v) => rowsBox.appendChild(createFieldRow(v)));
        refreshAllRowButtons();

        function collectValues() {
          const out = [];
          const seen = new Set();
          Array.from(rowsBox.querySelectorAll('select')).forEach((s) => {
            const v = s.value;
            if (v && !seen.has(v)) { seen.add(v); out.push(v); }
          });
          return out;
        }
        return { collectValues };
      }

      const matchCol = buildColumn('对账字段', currentRule ? currentRule.matchFields : []);
      const compareCol = buildColumn('对账内容', currentRule ? currentRule.compareFields : []);

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
        const matchFields = matchCol.collectValues();
        const compareFields = compareCol.collectValues();
        if (matchFields.length === 0) {
          openModal(createAlertDialog('请至少选择一个"对账字段"（匹配 key）'));
          return;
        }
        handleRuleConfirm({ matchFields, compareFields });
      });
      actions.appendChild(saveBtn);
      actions.appendChild(cancelBtn);
      dialog.appendChild(actions);
      return overlay;
    }

    function handleRuleConfirm({ matchFields, compareFields }) {
      // createConfirmDialog 内部用 innerHTML 塞 message，支持 HTML 标签
      // 31 列表头为受控预定义值（无 HTML 特殊字符），防御性对字段名做 HTML escape
      const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
      const matchText = matchFields.length > 0 ? matchFields.map(esc).join('、') : '(无)';
      const compareText = compareFields.length > 0 ? compareFields.map(esc).join('、') : '(无)';
      const message =
        '<strong>请确认筛选的字段：</strong><br><br>' +
        `<div>对账字段 (${matchFields.length}): ${matchText}</div>` +
        `<div>对账内容 (${compareFields.length}): ${compareText}</div>`;
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
      state.pending.currentYearMonth = yearMonth;
      state.pending.importingText = `正在导入 ${yearMonth}（${files.length} 个文件）...`;
      state.pending.errorReportAvailable = false;
      state.pending.errorMessage = null;
      refreshPendingUi();

      try {
        const result = await desktopApi.pending.startImport({ files, yearMonth, overwriteConfirmed: !!overwriteConfirmed });

        if (result && result.status === 'need-confirm') {
          state.pending.importing = false;
          state.pending.currentYearMonth = null;
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
          state.pending.currentYearMonth = null;
          state.pending.lastImportSummary =
            `${yearMonth} 数据已导入（${result.rowCount} 行）。` +
            (result.archivePath ? '旧数据已留底。' : '');
          await loadMonths();
          refreshPendingUi();
          return;
        }

        // error
        const errors = result && Array.isArray(result.errors) ? result.errors : [];
        const summary = summarizeErrors(errors);
        state.pending.importing = false;
        state.pending.currentYearMonth = null;
        state.pending.errorReportAvailable = errors.length > 0;
        state.pending.errorMessage = summary;
        refreshPendingUi();
      } catch (err) {
        state.pending.importing = false;
        state.pending.currentYearMonth = null;
        state.pending.errorReportAvailable = false;
        state.pending.errorMessage = null;
        refreshPendingUi();
        openModal(createAlertDialog('导入调用失败：' + (err && err.message ? err.message : String(err))));
      }
    }

    function summarizeErrors(errors) {
      if (!errors || errors.length === 0) return '导入失败';
      const fatal = errors.filter((e) => e.severity === 'fatal');
      if (fatal.length > 0) {
        const headerErr = fatal.find((e) => /表头/.test(e.message || ''));
        if (headerErr) return '表头字段不一致，请检查并重新导入';
        return fatal[0].message || '导入失败';
      }
      const row = errors.filter((e) => e.severity === 'row');
      const dup = row.filter((e) => /重复行/.test(e.message || ''));
      if (dup.length > 0 && dup.length === row.length) {
        return `导入失败，发现 ${dup.length} 条重复行`;
      }
      const fundErr = row.filter((e) => /不合法/.test(e.message || ''));
      if (fundErr.length === row.length && fundErr.length > 0) {
        return `导入失败，发现 ${fundErr.length} 条 pending资金类型 值不合法`;
      }
      return `导入失败，发现 ${row.length} 条行级错误`;
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

    // ========== 开始运行（对账）==========

    function buildReconcileDialog({ months, defaultUpper, defaultLower, onConfirm, onCancel }) {
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      const dialog = document.createElement('div');
      dialog.className = 'modal-card pending-reconcile-dialog';
      overlay.appendChild(dialog);

      const title = document.createElement('div');
      title.className = 'alert-message';
      title.textContent = '请选取需要比对 Pending 数据的月份';
      dialog.appendChild(title);

      function buildMonthSelect(labelText, preferValue) {
        const row = document.createElement('div');
        row.className = 'pending-rule-row';
        const label = document.createElement('label');
        label.className = 'pending-rule-label';
        label.textContent = labelText;
        row.appendChild(label);
        const select = document.createElement('select');
        select.className = 'pending-rule-select';
        months.forEach((m) => {
          const opt = document.createElement('option');
          opt.value = m;
          opt.textContent = m;
          if (preferValue && m === preferValue) opt.selected = true;
          select.appendChild(opt);
        });
        row.appendChild(select);
        dialog.appendChild(row);
        return select;
      }

      const upperSelect = buildMonthSelect('上上个月 Pending 文件', defaultUpper);
      const lowerSelect = buildMonthSelect('上个月 Pending 文件', defaultLower);

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
      confirmBtn.textContent = '完成';
      confirmBtn.addEventListener('click', () => {
        const upper = upperSelect.value;
        const lower = lowerSelect.value;
        if (typeof onConfirm === 'function') onConfirm({ upper, lower });
      });
      actions.appendChild(cancelBtn);
      actions.appendChild(confirmBtn);
      dialog.appendChild(actions);
      return overlay;
    }

    async function handlePendingRunClick() {
      await loadMonths();
      const months = state.pending.months.slice();
      if (months.length < 2) {
        openModal(createAlertDialog(`至少需要 2 个月的 Pending 数据才能对账（当前 ${months.length} 个月）。`));
        return;
      }

      const openDialog = (defaultUpper, defaultLower) => {
        openModal(buildReconcileDialog({
          months,
          defaultUpper,
          defaultLower,
          onConfirm: ({ upper, lower }) => {
            // 第一步确认：开始运行？
            openModal(createConfirmDialog({
              message: `确认以 "${upper}" vs "${lower}" 进行对账？`,
              confirmText: '确认',
              cancelText: '取消',
              onConfirm: () => {
                // 第二步：校验相邻
                closeModal();
                if (!isAdjacentMonths(upper, lower)) {
                  openModal(createAlertDialog(
                    `选取的月份不是相邻月份（上上月=${upper}，上月=${lower}），请重新选择。`,
                    { onConfirm: () => { openDialog(upper, lower); } }
                  ));
                  return;
                }
                runReconciliation(upper, lower).catch((err) => {
                  console.error('[pending] runReconciliation error:', err);
                });
              }
            }));
          },
          onCancel: () => closeModal()
        }));
      };

      openDialog(months[1], months[0]);
    }

    async function runReconciliation(upperMonth, lowerMonth) {
      state.pending.running = true;
      state.pending.latestRunResult = null;
      state.pending.runningText = `正在对账 ${lowerMonth} vs ${upperMonth}（预计估算中...）`;
      refreshPendingUi();

      let estimatedMs = null;
      try {
        estimatedMs = await desktopApi.pending.reconcile.benchmark({ upperMonth, lowerMonth });
      } catch (err) {
        console.warn('[pending] benchmark failed:', err);
      }

      if (Number.isFinite(estimatedMs) && estimatedMs > 0) {
        state.pending.runningText = `正在对账 ${lowerMonth} vs ${upperMonth}，预计 ${formatDurationSec(estimatedMs)}...`;
        refreshPendingUi();
      }

      try {
        const result = await desktopApi.pending.reconcile.run({ upperMonth, lowerMonth });
        state.pending.running = false;
        const total = (result.statNew || 0) + (result.statMissing || 0) + (result.statChanged || 0);
        if (total === 0) {
          state.pending.latestRunResult = `对账完成：${lowerMonth} vs ${upperMonth} 无差异。`;
        } else {
          state.pending.latestRunResult =
            `对账完成：${lowerMonth} vs ${upperMonth} 找出 ${total} 条差异` +
            `（${result.statNew || 0} 新增 / ${result.statMissing || 0} 消失 / ${result.statChanged || 0} 变更），` +
            '可点击"导出差异"另存。';
        }
        state.pending.latestRunId = result.runId || null;
        refreshPendingUi();
      } catch (err) {
        state.pending.running = false;
        state.pending.latestRunResult = `对账失败：${err && err.message ? err.message : String(err)}`;
        refreshPendingUi();
      }
    }

    // ========== 导出差异 ==========

    function formatRunOption(run) {
      const createdAt = (run.createdAt || '').replace('T', ' ').slice(0, 19);
      const rs = run.ruleSnapshot || {};
      const mfs = Array.isArray(rs.matchFields) ? rs.matchFields.join(',') : '';
      const cfs = Array.isArray(rs.compareFields) ? rs.compareFields.join(',') : '';
      const total = (run.statNew || 0) + (run.statMissing || 0) + (run.statChanged || 0);
      return `${createdAt}  差异 ${total} 条  规则 {${mfs} × ${cfs}}`;
    }

    function buildExportDialog({ allRuns, onConfirm, onCancel }) {
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      const dialog = document.createElement('div');
      dialog.className = 'modal-card pending-export-dialog';
      overlay.appendChild(dialog);

      const title = document.createElement('div');
      title.className = 'alert-message';
      title.textContent = '导出月份范围';
      dialog.appendChild(title);

      // 收集月份
      const monthsSet = new Set(allRuns.map((r) => r.lowerMonth));
      const months = Array.from(monthsSet).sort((a, b) => (a < b ? 1 : -1)); // desc

      // Radio 组
      const radioSingle = document.createElement('input');
      radioSingle.type = 'radio';
      radioSingle.name = 'pending-export-scope';
      radioSingle.id = 'pending-export-radio-single';
      radioSingle.value = 'single';
      radioSingle.checked = true;
      const radioSingleLabel = document.createElement('label');
      radioSingleLabel.setAttribute('for', 'pending-export-radio-single');
      radioSingleLabel.textContent = '导出指定月份';
      const radioSingleRow = document.createElement('div');
      radioSingleRow.className = 'pending-rule-row';
      radioSingleRow.appendChild(radioSingle);
      radioSingleRow.appendChild(radioSingleLabel);
      dialog.appendChild(radioSingleRow);

      // 指定月份：月份 + run 两个下拉
      const singleMonthRow = document.createElement('div');
      singleMonthRow.className = 'pending-rule-row';
      const singleMonthLabel = document.createElement('label');
      singleMonthLabel.className = 'pending-rule-label';
      singleMonthLabel.textContent = '月份';
      singleMonthRow.appendChild(singleMonthLabel);
      const monthSelect = document.createElement('select');
      monthSelect.className = 'pending-rule-select';
      months.forEach((m, idx) => {
        const opt = document.createElement('option');
        opt.value = m;
        opt.textContent = m;
        if (idx === 0) opt.selected = true;
        monthSelect.appendChild(opt);
      });
      singleMonthRow.appendChild(monthSelect);
      dialog.appendChild(singleMonthRow);

      const runRow = document.createElement('div');
      runRow.className = 'pending-rule-row';
      const runLabel = document.createElement('label');
      runLabel.className = 'pending-rule-label';
      runLabel.textContent = 'Run';
      runRow.appendChild(runLabel);
      const runSelect = document.createElement('select');
      runSelect.className = 'pending-rule-select';
      runRow.appendChild(runSelect);
      dialog.appendChild(runRow);

      function refreshRunOptions() {
        const chosenMonth = monthSelect.value;
        const filtered = allRuns.filter((r) => r.lowerMonth === chosenMonth);
        runSelect.innerHTML = '';
        filtered.forEach((r, idx) => {
          const opt = document.createElement('option');
          opt.value = String(r.id);
          opt.textContent = formatRunOption(r);
          if (idx === 0) opt.selected = true;
          runSelect.appendChild(opt);
        });
      }
      monthSelect.addEventListener('change', refreshRunOptions);
      refreshRunOptions();

      // Radio 汇总
      const radioAggr = document.createElement('input');
      radioAggr.type = 'radio';
      radioAggr.name = 'pending-export-scope';
      radioAggr.id = 'pending-export-radio-aggr';
      radioAggr.value = 'aggregate';
      const radioAggrLabel = document.createElement('label');
      radioAggrLabel.setAttribute('for', 'pending-export-radio-aggr');
      radioAggrLabel.textContent = '导出所有月份汇总（每月取最新 run）';
      const radioAggrRow = document.createElement('div');
      radioAggrRow.className = 'pending-rule-row';
      radioAggrRow.appendChild(radioAggr);
      radioAggrRow.appendChild(radioAggrLabel);
      dialog.appendChild(radioAggrRow);

      function updateMode() {
        const single = radioSingle.checked;
        monthSelect.disabled = !single;
        runSelect.disabled = !single;
      }
      radioSingle.addEventListener('change', updateMode);
      radioAggr.addEventListener('change', updateMode);
      updateMode();

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
      confirmBtn.textContent = '导出';
      confirmBtn.addEventListener('click', () => {
        if (radioSingle.checked) {
          const runId = Number(runSelect.value);
          if (!runId) {
            openModal(createAlertDialog('请选择一个 run'));
            return;
          }
          const chosenMonth = monthSelect.value;
          if (typeof onConfirm === 'function') onConfirm({ scope: 'single', runId, month: chosenMonth });
        } else {
          if (typeof onConfirm === 'function') onConfirm({ scope: 'aggregate' });
        }
      });
      actions.appendChild(cancelBtn);
      actions.appendChild(confirmBtn);
      dialog.appendChild(actions);

      return overlay;
    }

    async function handlePendingExportClick() {
      let allRuns = [];
      try {
        allRuns = await desktopApi.pending.diff.listAllRuns();
      } catch (err) {
        openModal(createAlertDialog('读取运算记录失败：' + (err && err.message ? err.message : String(err))));
        return;
      }
      if (!Array.isArray(allRuns) || allRuns.length === 0) {
        openModal(createAlertDialog('暂无运算记录，请先点击"开始运行"生成差异。'));
        return;
      }

      openModal(buildExportDialog({
        allRuns,
        onConfirm: async (choice) => {
          closeModal();
          try {
            let result;
            if (choice.scope === 'single') {
              result = await desktopApi.pending.diff.exportSingle({
                runId: choice.runId,
                defaultFileName: `月度Pending差异-${choice.month}-run${choice.runId}.xlsx`
              });
            } else {
              result = await desktopApi.pending.diff.exportAggregate();
            }
            if (!result || result.status === 'cancelled') return;
            if (result.status === 'success') {
              openModal(createAlertDialog(`导出成功：${result.path}（${result.rowCount || 0} 条差异）`));
            } else {
              openModal(createAlertDialog('导出失败：' + (result.message || '未知错误')));
            }
          } catch (err) {
            openModal(createAlertDialog('导出异常：' + (err && err.message ? err.message : String(err))));
          }
        },
        onCancel: () => closeModal()
      }));
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
      if (elements.pendingRunBtn) {
        elements.pendingRunBtn.addEventListener('click', () => {
          handlePendingRunClick().catch((err) => console.error('[pending] run click error:', err));
        });
      }
      if (elements.pendingExportBtn) {
        elements.pendingExportBtn.addEventListener('click', () => {
          handlePendingExportClick().catch((err) => console.error('[pending] export click error:', err));
        });
      }
      if (elements.pendingStatusBox) {
        elements.pendingStatusBox.addEventListener('click', handleStatusBoxClick);
      }
      if (desktopApi && desktopApi.pending && typeof desktopApi.pending.onImportProgress === 'function') {
        desktopApi.pending.onImportProgress((ev) => {
          if (!ev || ev.type !== 'progress') return;
          if (!state.pending.importing) return;
          const ym = state.pending.currentYearMonth || '';
          state.pending.importingText =
            `正在导入 ${ym}：${ev.file || ''}（已处理 ${ev.rowsProcessed || 0} 行）`;
          refreshPendingUi();
        });
      }
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
