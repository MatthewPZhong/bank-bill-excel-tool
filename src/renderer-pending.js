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
      return '欢迎使用小助手';
    }

    function setPendingStatus(text) {
      if (!elements.pendingStatusBox) return;
      // v2.0.0-beta.2：只更新 .status-box-text 子节点，保留 .status-spark SVG
      const textEl = elements.pendingStatusBox.querySelector('.status-box-text');
      if (textEl) textEl.textContent = text;
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
      title.className = 'pending-dialog-title';
      title.textContent = 'Pending 数据对账规则';
      dialog.appendChild(title);

      const columnsWrap = document.createElement('div');
      columnsWrap.className = 'pending-rule-columns';
      dialog.appendChild(columnsWrap);

      function buildColumn(labelText, initialValues, opts) {
        const showSerial = !!(opts && opts.showSerial);
        const tooltip = opts && opts.tooltip ? String(opts.tooltip) : '';
        const alignHeaderToSelect = !!(opts && opts.alignHeaderToSelect);

        const column = document.createElement('div');
        column.className = 'pending-rule-column';
        if (alignHeaderToSelect) column.classList.add('pending-rule-column-aligned');

        const header = document.createElement('div');
        header.className = 'pending-rule-column-header';
        header.textContent = labelText;
        if (tooltip) {
          const tip = document.createElement('span');
          tip.className = 'pending-rule-header-tip';
          tip.textContent = '?';
          tip.title = tooltip;
          header.appendChild(tip);
        }
        column.appendChild(header);

        const rowsBox = document.createElement('div');
        rowsBox.className = 'pending-rule-rows';
        column.appendChild(rowsBox);
        columnsWrap.appendChild(column);

        function createFieldRow(initialValue) {
          const fieldRow = document.createElement('div');
          fieldRow.className = 'pending-rule-field-row';

          let serialEl = null;
          if (showSerial) {
            serialEl = document.createElement('span');
            serialEl.className = 'pending-rule-field-serial';
            fieldRow.appendChild(serialEl);
          }

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
              refreshAllRows();
            } else {
              rowsBox.removeChild(fieldRow);
              refreshAllRows();
            }
          });

          fieldRow._updateBtn = updateBtn;
          fieldRow._updateSerial = (idx) => { if (serialEl) serialEl.textContent = `${idx}.`; };
          return fieldRow;
        }

        function refreshAllRows() {
          Array.from(rowsBox.children).forEach((r, i) => {
            if (r._updateBtn) r._updateBtn();
            if (r._updateSerial) r._updateSerial(i + 1);
          });
        }

        // 初始行：有历史值则每个值一行；否则一行空
        const seed = Array.isArray(initialValues) && initialValues.length > 0 ? initialValues : [''];
        seed.forEach((v) => rowsBox.appendChild(createFieldRow(v)));
        refreshAllRows();

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

      const matchTooltip = '序号即匹配优先级：按序号逐轮 fallback，任一字段相等即视为同一笔。';
      const matchCol = buildColumn('对账字段', currentRule ? currentRule.matchFields : [], { showSerial: true, tooltip: matchTooltip });
      const compareCol = buildColumn('对账内容', currentRule ? currentRule.compareFields : [], { alignHeaderToSelect: true });

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
      title.className = 'pending-dialog-title';
      title.textContent = '请选择 Pending 数据所属年月';
      dialog.appendChild(title);

      // 复用月度余额模块的"时间选取器"样式（monthly-balance-time-picker + mapping-text-input）
      const picker = document.createElement('div');
      picker.className = 'monthly-balance-time-picker pending-import-month-picker';
      const yearSelect = document.createElement('select');
      yearSelect.className = 'monthly-balance-year-select mapping-text-input';
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
      monthSelect.className = 'monthly-balance-month-select mapping-text-input';
      const defaultMonth = now.getMonth() + 1;
      for (let m = 1; m <= 12; m += 1) {
        const opt = document.createElement('option');
        opt.value = String(m).padStart(2, '0');
        opt.textContent = `${m} 月`;
        if (m === defaultMonth) opt.selected = true;
        monthSelect.appendChild(opt);
      }
      picker.appendChild(yearSelect);
      picker.appendChild(monthSelect);
      dialog.appendChild(picker);

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
          // v2.1.11 T2（spec §3.3 / D-T2-1）：导入成功后弹"是否核对移除pending数据？"
          //   选否 → 现状不变；选是 → 选移除归档 xlsx → 解析入库（关联本次导入月份 yearMonth，
          //   它将作为后续对账的 upperMonth；对账后自动匹配 missing↔移除）。
          promptRemovalReconcile(yearMonth);
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

    // v2.1.11 T2：导入成功后的"是否核对移除pending数据？"提醒 + 移除文件导入入库
    function promptRemovalReconcile(yearMonth) {
      // 防御：旧 preload 无 removed api → 静默跳过（不影响导入主流程）
      if (!desktopApi || !desktopApi.pending || !desktopApi.pending.removed
          || typeof desktopApi.pending.removed.pickFiles !== 'function') {
        return;
      }
      openModal(createConfirmDialog({
        message:
          `${yearMonth} 数据已导入。<br><br>` +
          '是否核对<strong>移除pending数据</strong>？<br>' +
          '<span style="font-size:12px;color:#888;">' +
          '（导入"移除归档Pending账单"文件，对账时自动标记哪些"消失(missing)"行已被移除归档）</span>',
        confirmText: '是，导入移除文件',
        cancelText: '否，跳过',
        onConfirm: async () => {
          closeModal();
          await importRemovedFile(yearMonth);
        }
        // onCancel 默认 closeModal（createConfirmDialog 内置）；选否 = 现状不变
      }));
    }

    async function importRemovedFile(yearMonth) {
      let pickResult;
      try {
        pickResult = await desktopApi.pending.removed.pickFiles();
      } catch (err) {
        openModal(createAlertDialog('打开文件选择对话框失败：' + (err && err.message ? err.message : String(err))));
        return;
      }
      if (!pickResult || pickResult.cancelled
          || !Array.isArray(pickResult.files) || pickResult.files.length === 0) {
        return; // 用户取消选文件 = 不导入（现状不变）
      }
      try {
        const result = await desktopApi.pending.removed.import({ yearMonth, files: pickResult.files });
        if (!result || result.status === 'cancelled') return;
        if (result.status === 'success') {
          openModal(createAlertDialog(
            `移除归档数据已入库：${yearMonth} 共 ${result.inserted} 行` +
            (result.deleted > 0 ? `（覆盖旧 ${result.deleted} 行）` : '') +
            '。<br>对账后将自动标记 missing 行的移除核对状态。'
          ));
        } else {
          const detail = Array.isArray(result.detailLines) && result.detailLines.length > 0
            ? '<br><span style="font-size:12px;color:#888;">' + result.detailLines.join('<br>') + '</span>'
            : '';
          openModal(createAlertDialog('移除文件导入失败：' + (result.message || '未知错误') + detail));
        }
      } catch (err) {
        openModal(createAlertDialog('移除文件导入异常：' + (err && err.message ? err.message : String(err))));
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
      title.className = 'pending-dialog-title';
      title.textContent = '请选取需要比对 Pending 数据的月份';
      dialog.appendChild(title);

      // 两列 side-by-side（沿中线对称），每列 label + 单选下拉（mapping-text-input 样式）
      const columnsWrap = document.createElement('div');
      columnsWrap.className = 'pending-rule-columns';
      dialog.appendChild(columnsWrap);

      function buildMonthColumn(labelText, preferValue) {
        const column = document.createElement('div');
        column.className = 'pending-rule-column';
        const header = document.createElement('div');
        header.className = 'pending-rule-column-header';
        header.textContent = labelText;
        column.appendChild(header);
        const select = document.createElement('select');
        select.className = 'mapping-text-input pending-reconcile-month-select';
        months.forEach((m) => {
          const opt = document.createElement('option');
          opt.value = m;
          opt.textContent = m;
          if (preferValue && m === preferValue) opt.selected = true;
          select.appendChild(opt);
        });
        column.appendChild(select);
        columnsWrap.appendChild(column);
        return select;
      }

      const upperSelect = buildMonthColumn('上上个月 Pending 文件', defaultUpper);
      const lowerSelect = buildMonthColumn('上个月 Pending 文件', defaultLower);

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
      actions.appendChild(confirmBtn);
      actions.appendChild(cancelBtn);
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
              message: `确认以 "<strong>${upper}</strong>" vs "<strong>${lower}</strong>" 进行对账？`,
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

    // I1 + I2（v2.1.11 SR-FIX Round 1）+ I-R2-1（SR Round 2）：拼接移除核对摘要文案
    //   （纯文本，状态框 textContent 渲染）。reconcile:run 返回 removalMatch 三态：
    //     - { error: true }（matchRemoval 抛错，main.js catch 返回失败标记，I-R2-1）
    //         → "移除核对执行异常，请查看活动日志"
    //         ⚠️ 必须与 null 区分：移除数据确实存在但匹配崩溃时，不能显示"无移除归档数据"（与事实相反，误导对账）
    //     - { matchedCount, missingUnmatched, removedUnmatched }（该上月有移除归档数据，已执行核对）
    //         → "移除核对：已匹配 N / missing 未匹配 M / 移除未匹配 K"
    //     - null（该上月无移除归档数据 countByMonth=0，未触发核对，main.js:10094-10099）
    //         → I2 提示"该上月无移除归档数据，未执行移除核对"，避免用户误判已生效
    function buildRemovalMatchSummary(upperMonth, removalMatch) {
      if (removalMatch && typeof removalMatch === 'object') {
        if (removalMatch.error) {
          return ' 移除核对执行异常，请查看活动日志。';
        }
        const matched = removalMatch.matchedCount || 0;
        const missingUnmatched = removalMatch.missingUnmatched || 0;
        const removedUnmatched = removalMatch.removedUnmatched || 0;
        return ` 移除核对：已匹配 ${matched} / missing 未匹配 ${missingUnmatched} / 移除未匹配 ${removedUnmatched}。`;
      }
      return ` （上月 ${upperMonth} 无移除归档数据，未执行移除核对）`;
    }

    async function runReconciliation(upperMonth, lowerMonth) {
      state.pending.running = true;
      state.pending.latestRunResult = null;
      state.pending.runningText = `正在对账 ${lowerMonth} vs ${upperMonth}...`;
      refreshPendingUi();

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
        // I1 + I2（v2.1.11 SR-FIX Round 1）：移除核对摘要反馈
        //   - result.removalMatch 非 null（该上月有移除归档数据，已执行核对）→ 追加匹配摘要
        //   - result.removalMatch 为 null（该上月无移除归档数据，未触发核对）→ 提示未执行，避免误判已生效
        state.pending.latestRunResult += buildRemovalMatchSummary(upperMonth, result.removalMatch);
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
      title.className = 'pending-dialog-title';
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

      // 指定月份：月份 + Run 两个下拉，side-by-side 一行（沿用对账弹窗的列样式）
      // pending-export-cols 覆盖两列宽度：月份窄（~120px）、Run 撑满剩余空间
      const columnsWrap = document.createElement('div');
      columnsWrap.className = 'pending-rule-columns pending-export-cols';
      dialog.appendChild(columnsWrap);

      const monthColumn = document.createElement('div');
      monthColumn.className = 'pending-rule-column pending-export-month-column';
      // "月份" 文本按需求移除；月份下拉直接作为该列唯一内容
      const monthSelect = document.createElement('select');
      monthSelect.className = 'mapping-text-input pending-reconcile-month-select';
      months.forEach((m, idx) => {
        const opt = document.createElement('option');
        opt.value = m;
        opt.textContent = m;
        if (idx === 0) opt.selected = true;
        monthSelect.appendChild(opt);
      });
      monthColumn.appendChild(monthSelect);
      columnsWrap.appendChild(monthColumn);

      const runColumn = document.createElement('div');
      runColumn.className = 'pending-rule-column pending-export-run-column';
      const runHeader = document.createElement('div');
      runHeader.className = 'pending-rule-column-header';
      runHeader.textContent = 'Run';
      runColumn.appendChild(runHeader);
      const runSelect = document.createElement('select');
      runSelect.className = 'mapping-text-input pending-reconcile-month-select';
      runColumn.appendChild(runSelect);
      columnsWrap.appendChild(runColumn);

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
      // 导出 在左、取消 在右（与其他弹窗相反的本次需求）
      actions.appendChild(confirmBtn);
      actions.appendChild(cancelBtn);
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
              let successMsg = `导出成功：${result.path}（共 ${result.rowCount || 0} 行，changed 每对展 2 行）`;
              // I3（v2.1.11 SR-FIX Round 1）：聚合导出不含移除核对 sheet；若确有移除数据则提示改用「导出指定月份」
              //   createAlertDialog 走 innerHTML 渲染 → 用 <br> 换行（与该弹窗既有 HTML 文案一致）
              if (choice.scope === 'aggregate' && result.removalDataOmitted) {
                successMsg += '<br>注意：聚合导出不含移除核对 sheet，请用"导出指定月份"查看移除核对结果。';
              }
              openModal(createAlertDialog(successMsg));
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
      // 从 DB 拿最新 run 恢复 latestRunId —— 让"导出差异"按钮在历史 run 存在时保持可用
      // （latestRunId 之前只在本会话对账完成时赋值，重开模块或重启后会丢）
      try {
        if (desktopApi && desktopApi.pending && desktopApi.pending.diff
            && typeof desktopApi.pending.diff.listAllRuns === 'function') {
          const allRuns = await desktopApi.pending.diff.listAllRuns();
          if (Array.isArray(allRuns) && allRuns.length > 0) {
            state.pending.latestRunId = allRuns[0].id;
          }
        }
      } catch (err) {
        console.warn('[pending] listAllRuns at init failed:', err);
      }
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
      bindEvents,
      // v2.0.0 preview 钩子：暴露 4 个对话框 builder 给 renderer-previews.js
      buildRuleDialogNode,
      buildImportMonthDialog,
      buildReconcileDialog,
      buildExportDialog
    };
  }

  return { createRendererPending };
})();
