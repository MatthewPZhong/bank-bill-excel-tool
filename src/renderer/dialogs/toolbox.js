(function exposeToolboxDialogs(global) {
  'use strict';

  function createToolboxDialogs({ api, modalBridge, ui }) {
    const { createAlertDialog, escapeHtml } = ui;
    const { host, registerModal, pushModal, replaceModal } = modalBridge;
    const document = global.document;
    const window = global;

    // 选择视图只持有自身交互资源；父工具箱持有读表 token 和提交资格。
    function bindPicker(overlay, dialog, { onComplete, onCancel, beforeSubmit }, cleanup) {
      let destroyed = false;
      let settled = false;
      const activeHandle = () => {
        const handle = host.getHandle(overlay);
        return !destroyed && !settled && handle?.isOpen() && handle.isTop() ? handle : null;
      };
      registerModal(overlay, {
        dialog,
        dismiss: { escape: false, backdrop: false },
        onDispose() { destroyed = true; cleanup(); },
        onClose(result) {
          if (!settled && result.status === 'cancelled' && ['cancel', 'escape', 'backdrop'].includes(result.reason)) {
            settled = true;
            onCancel?.();
          }
        }
      });
      return {
        isActive: () => !!activeHandle(),
        cancel() {
          const handle = activeHandle();
          if (!handle) return;
          settled = true;
          handle.close({ status: 'cancelled', reason: 'cancel' });
          onCancel?.();
        },
        submit(value) {
          const handle = activeHandle();
          if (!handle || (beforeSubmit && !beforeSubmit(value))) return false;
          settled = true;
          handle.close({ status: 'submitted', value });
          onComplete?.(value);
          return true;
        },
        replace(factory) {
          const handle = activeHandle();
          if (!handle) return { status: 'stale' };
          return replaceModal(handle, factory);
        }
      };
    }

    function createToolboxDialog() {
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      overlay.dataset.previewModal = 'toolbox';

      const card = document.createElement('div');
      card.className = 'modal-card toolbox-card';
      card.innerHTML = `
        <div class="dialog-header">
          <div class="dialog-title">工具箱</div>
          <button class="icon-close" type="button" aria-label="关闭">×</button>
        </div>
        <div class="dialog-body toolbox-body">
          <div class="status-box toolbox-status-box" data-tone="neutral" role="status" aria-live="polite">
            <span class="status-box-content">
              <span class="status-box-text">等待操作</span>
            </span>
          </div>
          <div class="toolbox-row toolbox-merge-row">
            <span class="toolbox-row-label">合并表格</span>
            <div class="toolbox-row-actions">
              <button class="primary-btn small" type="button" data-action="merge-import">导入文件</button>
            </div>
          </div>
          <div class="toolbox-row toolbox-split-row">
            <span class="toolbox-row-label">拆分表格</span>
            <div class="toolbox-row-actions">
              <button class="primary-btn small" type="button" data-action="split-import">导入文件</button>
            </div>
          </div>
        </div>
      `;
      overlay.appendChild(card);

      const closeBtn = card.querySelector('.icon-close');
      const statusBox = card.querySelector('.toolbox-status-box');
      const statusText = statusBox.querySelector('.status-box-text');
      const mergeImportBtn = card.querySelector('[data-action="merge-import"]');
      const splitImportBtn = card.querySelector('[data-action="split-import"]');

      // v3.0.8：拆表一气呵成——选字段弹框「完成」即直接过滤命中行另存为（去掉独立「导出文件」按钮）。
      let mergeInFlight = false;
      let splitImportInFlight = false;
      let splitExportInFlight = false;
      let handle = null;
      let destroyed = false;
      let requestGeneration = 0;
      let splitSession = null;

      function live(generation = requestGeneration) {
        return !destroyed && handle?.isOpen() && generation === requestGeneration;
      }

      function releaseSession(session) {
        if (!session) return;
        session.headers = [];
        session.valuesByField = {};
        session.draft = null;
        session.payload = null;
        session.prepareSubmit = null;
        session.splitReadToken = null;
        if (splitSession === session) splitSession = null;
      }

      registerModal(overlay, {
        dialog: card,
        dismiss: { escape: false, backdrop: true },
        canClose: () => !isToolboxRunning(),
        onMount(current) { handle = current; },
        onDispose() {
          destroyed = true;
          requestGeneration += 1;
          releaseSession(splitSession);
        }
      });

      function isToolboxRunning() {
        return mergeInFlight || splitImportInFlight || splitExportInFlight;
      }

      function setToolboxStatus(message, tone = 'neutral') {
        if (!live()) return;
        statusText.textContent = String(message || '');
        statusBox.dataset.tone = tone;
      }

      function syncToolboxRunningUi() {
        if (!live()) return;
        const running = isToolboxRunning();
        closeBtn.hidden = running;
        mergeImportBtn.disabled = running;
        splitImportBtn.disabled = running;
        overlay.setAttribute('aria-busy', running ? 'true' : 'false');
        card.classList.toggle('is-running', running);
      }

      // v3.0.8（用户要求）：工具箱反馈改用应用内弹框 createAlertDialog（有前端页面 + 统一 Clear 风格 + 可预览），
      //   取代原生 window.alert（无前端页面、无法预览、样式不一致）。
      //   createAlertDialog 按 innerHTML 渲染 → message/明细经 escapeHtml + <br> 拼装防注入/正确换行；
      //   成功/提示 skipLogReport（不报 error 日志），失败默认 error 上报；点「确认」后回到工具箱主弹框。
      function showToolboxAlert(message, { isError = false, lines = [], scrollable = false } = {}) {
        if (!live() || !handle.isTop()) return;
        const safeLines = Array.isArray(lines) ? lines.filter((line) => line != null && String(line) !== '') : [];
        const html = [escapeHtml(String(message || ''))]
          .concat(safeLines.map((line) => escapeHtml(String(line))))
          .join('<br>');
        return pushModal(handle, () => {
          const alert = createAlertDialog(html, { skipLogReport: !isError, logDomain: 'toolbox' });
          if (scrollable) alert.querySelector('.alert-card').classList.add('toolbox-split-rows-result');
          return alert;
        });
      }

      function buildToolboxNoticeLines(result) {
        const lines = [];
        const summary = result && result.warningSummary && typeof result.warningSummary === 'object'
          ? result.warningSummary
          : {};
        const warningCount = Number(summary.warningCount) || 0;
        const samples = Array.isArray(summary.warningSamples) ? summary.warningSamples : [];
        if (warningCount > 0) {
          lines.push(`处理提示：${warningCount} 个单元格无法安全转换为 Excel 日期，已按原文本保留。`);
          const visibleSamples = samples.slice(0, 20);
          for (const sample of visibleSamples) {
            const location = [
              sample && sample.sourceFileName,
              sample && sample.sourceSheet,
              sample && sample.cellRef
            ].filter(Boolean).join(' / ');
            lines.push(`${location ? `${location}：` : ''}${(sample && sample.message) || '已按文本保留'}`);
          }
          if (warningCount > visibleSamples.length) {
            lines.push(`其余 ${warningCount - visibleSamples.length} 个同类提示未展开；活动日志保留本批同样的最多 20 条样例。`);
          }
        }
        for (const warning of Array.isArray(result && result.warnings) ? result.warnings : []) {
          if (warning != null && String(warning) !== '') lines.push(`发布提示：${warning}`);
        }
        return lines;
      }

      closeBtn.addEventListener('click', () => {
        if (live() && handle.isTop()) handle.close();
      });

      mergeImportBtn.addEventListener('click', async () => {
        if (!live() || !handle.isTop() || isToolboxRunning()) return;
        const generation = ++requestGeneration;
        mergeInFlight = true;
        setToolboxStatus('正在合并表格');
        syncToolboxRunningUi();
        try {
          const result = await api.merge();
          if (!live(generation)) return;
          if (!result || result.status === 'cancelled') {
            setToolboxStatus('已取消合并');
            return;
          }
          if (result.status === 'success') {
            setToolboxStatus('合并完成', 'success');
            showToolboxAlert('合并完成，已保存到：', {
              lines: [result.filePath, ...buildToolboxNoticeLines(result)]
            });
            return;
          }
          setToolboxStatus('合并失败', 'error');
          showToolboxAlert(result.message || '合并失败', { isError: true, lines: result.detailLines });
        } catch (error) {
          if (!live(generation)) return;
          setToolboxStatus('合并失败', 'error');
          showToolboxAlert(`合并失败：${error?.message || '未知错误'}`, { isError: true });
        } finally {
          mergeInFlight = false;
          if (live(generation)) syncToolboxRunningUi();
        }
      });

      function prepareSplit(session, { field, values, mode, groups, rowsPerFile } = {}) {
        if (!live(session.generation) || splitSession !== session || session.submitted || isToolboxRunning()) return false;
        const selectedValues = Array.isArray(values) ? [...values] : [];
        const multipleGroups = Array.isArray(groups) ? groups.map((group) => Object.freeze({
          fileName: group.fileName, field: group.field, values: Object.freeze([...group.values])
        })) : [];
        const isMultiple = mode === 'multiple';
        const isRows = mode === 'rows';
        if (!session.sourceFilePath || !session.splitReadToken || (!isMultiple && !isRows && (!field || !selectedValues.length))
          || (isMultiple && !multipleGroups.length)
          || (isRows && (!Number.isSafeInteger(rowsPerFile) || rowsPerFile <= 0))) {
          setToolboxStatus('拆分失败', 'error');
          showToolboxAlert('请选择拆分字段与至少一个值', { isError: true });
          return false;
        }
        session.submitted = true;
        splitExportInFlight = true;
        session.payload = Object.freeze({
          sourceFilePath: session.sourceFilePath,
          splitReadToken: session.splitReadToken,
          ...(isRows ? { mode: 'rows', rowsPerFile }
            : isMultiple ? { mode: 'multiple', groups: Object.freeze(multipleGroups) }
            : { field, values: Object.freeze(selectedValues) })
        });
        setToolboxStatus('正在拆分表格');
        syncToolboxRunningUi();
        return true;
      }

      async function submitSplit(session) {
        if (!live(session.generation) || splitSession !== session || !session.submitted || session.exportStarted) return;
        session.exportStarted = true;
        const payload = session.payload;
        const isRows = payload.mode === 'rows';
        const isMultiple = payload.mode === 'multiple';
        try {
          const result = await api.splitExport(payload);
          if (!live(session.generation) || splitSession !== session) return;
          if (!result || result.status === 'cancelled') {
            setToolboxStatus('已取消拆分');
            return;
          }
          if (result.status !== 'success') {
            setToolboxStatus('拆分失败', 'error');
            showToolboxAlert(result.message || '拆分失败', { isError: true, lines: result.detailLines });
            return;
          }
          setToolboxStatus('拆分完成', 'success');
          const files = Array.isArray(result.files) ? result.files : [];
          if (isRows) {
            showToolboxAlert(`拆分完成，共 ${result.fileCount} 个文件、${result.outputDataRowCount} 行：`, {
              scrollable: true,
              lines: [...files.map((file) => `${file.fileName}（${file.dataRowCount} 行）：${file.filePath}`), ...buildToolboxNoticeLines(result)]
            });
          } else if (isMultiple) {
            showToolboxAlert('拆分完成：', {
              lines: [...files.map((file) => `${file.fileName}（${Number(file.matchedCount) || 0} 行）：${file.filePath}`), ...buildToolboxNoticeLines(result)]
            });
          } else {
            showToolboxAlert('拆分完成，已保存到：', { lines: [result.filePath, ...buildToolboxNoticeLines(result)] });
          }
        } catch (error) {
          if (!live(session.generation) || splitSession !== session) return;
          setToolboxStatus('拆分失败', 'error');
          showToolboxAlert(`拆分失败：${error?.message || '未知错误'}`, { isError: true });
        } finally {
          splitExportInFlight = false;
          if (live(session.generation)) syncToolboxRunningUi();
          releaseSession(session);
        }
      }

      splitImportBtn.addEventListener('click', async () => {
        if (!live() || !handle.isTop() || isToolboxRunning()) return;
        releaseSession(splitSession);
        const generation = ++requestGeneration;
        splitImportInFlight = true;
        setToolboxStatus('正在读取表格');
        syncToolboxRunningUi();
        try {
          const result = await api.splitRead();
          if (!live(generation) || !handle.isTop()) return;
          if (!result || result.status === 'cancelled') {
            setToolboxStatus('已取消拆分');
            return;
          }
          if (result.status !== 'success') {
            setToolboxStatus('读取失败', 'error');
            showToolboxAlert(result.message || '读取文件失败', { isError: true, lines: result.detailLines });
            return;
          }
          if (typeof result.sourceFilePath !== 'string' || !result.sourceFilePath.trim()
            || typeof result.splitReadToken !== 'string' || !result.splitReadToken) {
            setToolboxStatus('读取失败', 'error');
            showToolboxAlert('读取文件失败', { isError: true,
              lines: ['缺少本次读取的来源或有效标识，请重新导入文件'] });
            return;
          }
          const session = {
            generation,
            sourceFilePath: result.sourceFilePath,
            splitReadToken: result.splitReadToken,
            headers: Array.isArray(result.headers) ? result.headers : [],
            valuesByField: result.valuesByField && typeof result.valuesByField === 'object' ? result.valuesByField : {},
            dataRowCount: result.dataRowCount,
            maxRowSplitFiles: result.maxRowSplitFiles,
            draft: null,
            submitted: false
          };
          session.prepareSubmit = (value) => prepareSplit(session, value);
          splitSession = session;
          splitImportInFlight = false;
          setToolboxStatus('等待拆分设置');
          syncToolboxRunningUi();
          pushModal(handle, () => createSplitFieldPickerDialog({
            ...session,
            _session: session,
            onComplete: () => submitSplit(session),
            onCancel: () => { if (splitSession === session) releaseSession(session); }
          }));
        } catch (error) {
          if (!live(generation)) return;
          releaseSession(splitSession);
          setToolboxStatus('读取失败', 'error');
          showToolboxAlert(`读取文件失败：${error?.message || '未知错误'}`, { isError: true });
        } finally {
          splitImportInFlight = false;
          if (live(generation)) syncToolboxRunningUi();
        }
      });

      return overlay;
    }

    // v3.0.8 需求1：拆表选字段弹框。单选字段下拉（= 表头列名）+ 多选值下拉（= 该字段去重值，随字段切换刷新）+ [完成][取消]。
    //   入参 { headers:string[], valuesByField:{[field]:string[]}, onComplete({field,values[]}), onCancel() }。
    //   边界：① 某字段无去重值（valuesByField[f] 空）→ 多选框为空且 disabled；
    //         ② 未选任何值（values=[]）→ [完成] 禁用（不允许空选导出，否则过滤命中 0 行产空 sheet）。
    function validateRowsInput(text) {
      const value = String(text).trim();
      if (!value) return { valid: false, message: '请输入每份文件的数据行数' };
      if (!/^[0-9]+$/.test(value)) return { valid: false, message: '请输入大于 0 的整数' };
      const number = Number(value);
      if (number <= 0) return { valid: false, message: '请输入大于 0 的整数' };
      if (!Number.isSafeInteger(number)) return { valid: false, message: '行数过大，请输入有效范围内的整数' };
      return { valid: true, value: number };
    }

    function createSplitFieldPickerDialog({ headers = [], valuesByField = {}, splitReadToken = '',
      dataRowCount, maxRowSplitFiles, onComplete = null, onCancel = null, _session = { draft: null } } = {}) {
      let safeHeaders = Array.isArray(headers) ? headers : [];
      let safeValuesByField = (valuesByField && typeof valuesByField === 'object') ? valuesByField : {};

      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      overlay.dataset.previewModal = 'toolbox-split-field-picker';

      const dialog = document.createElement('div');
      dialog.className = 'modal-card toolbox-split-picker-card';

      const fieldOptionsHtml = safeHeaders
        .map((h, idx) => `<option value="${idx}">${escapeHtml(h)}</option>`)
        .join('');

      dialog.innerHTML = `
        <div class="dialog-header">
          <div class="dialog-title">选择拆分字段</div>
          <button class="icon-close" type="button" aria-label="关闭">×</button>
        </div>
        <div class="dialog-body toolbox-split-picker-body">
          <label class="toolbox-split-picker-row">
            <span class="toolbox-split-picker-label">字段</span>
            <select class="toolbox-split-picker-field">${fieldOptionsHtml}</select>
          </label>
          <div class="toolbox-split-picker-row toolbox-split-picker-row-values">
            <span class="toolbox-split-picker-label">值</span>
            <div class="new-account-currency-dropdown-wrap toolbox-split-values-dropdown-wrap">
              <button class="new-account-currency-dropdown-btn toolbox-split-values-dropdown-btn" type="button" aria-expanded="false"> </button>
            </div>
          </div>
          <div class="toolbox-split-by-rows-row">
            <label class="toolbox-split-by-rows-toggle">
              <input type="checkbox" data-field="split-by-rows">
              <span>按行拆分</span>
            </label>
            <span class="toolbox-split-row-count-wrap" hidden>
              <input type="text" inputmode="numeric" data-field="rows-per-file"
                aria-label="每份文件数据行数" placeholder="请输入行数" disabled>
              <span>行</span>
            </span>
          </div>
          <div class="toolbox-split-picker-hint" aria-live="polite"></div>
        </div>
        <div class="dialog-actions toolbox-split-picker-actions">
          <label class="toolbox-split-multiple-toggle">
            <input type="checkbox" data-field="multiple-files-enabled">
            需要拆分成多个文件
          </label>
          <div class="toolbox-split-picker-action-buttons">
            <button class="secondary-btn small" type="button" data-action="cancel">取消</button>
            <button class="primary-btn small" type="button" data-action="complete" disabled>完成</button>
          </div>
        </div>
      `;
      overlay.appendChild(dialog);

      const closeBtn = dialog.querySelector('.icon-close');
      const fieldSelect = dialog.querySelector('.toolbox-split-picker-field');
      const valuesDropdownBtn = dialog.querySelector('.toolbox-split-values-dropdown-btn');
      const hintEl = dialog.querySelector('.toolbox-split-picker-hint');
      const cancelBtn = dialog.querySelector('[data-action="cancel"]');
      const completeBtn = dialog.querySelector('[data-action="complete"]');
      const multipleFilesCheck = dialog.querySelector('input[data-field="multiple-files-enabled"]');

      const rowsCheck = dialog.querySelector('[data-field="split-by-rows"]');
      const rowsInput = dialog.querySelector('[data-field="rows-per-file"]');
      const rowsWrap = dialog.querySelector('.toolbox-split-row-count-wrap');
      let rowsTouched = false;
      let busy = false;

      // v3.0.8（用户要求）：值多选框改用「按钮 + 浮动勾选面板」控件，与场景管理「资金性质校验」管理页的
      //   「适用银行渠道」多选下拉同款（复用 new-account-currency-* class）。面板挂本弹框 overlay、position:fixed 定位。
      const valuesPanel = document.createElement('div');
      valuesPanel.className = 'new-account-currency-dropdown-panel toolbox-split-values-floating-panel';
      valuesPanel.hidden = true;
      overlay.appendChild(valuesPanel);

      let currentValuesList = [];      // 当前字段的去重值列表
      let selectedValues = new Set();  // 当前已勾选的值
      let panelOpen = false;
      const lifecycle = bindPicker(overlay, dialog, { onComplete, onCancel, beforeSubmit: _session.prepareSubmit }, () => {
        closeValuesPanel();
        currentValuesList = [];
        selectedValues.clear();
        safeHeaders = [];
        safeValuesByField = {};
      });

      // 用 fieldSelect.value（= headers 索引）取 headers[idx] 再查 valuesByField（索引而非列名，避免重名/特殊字符表头歧义）。
      function currentFieldName() {
        const idx = Number.parseInt(fieldSelect.value, 10);
        return Number.isFinite(idx) && idx >= 0 && idx < safeHeaders.length ? safeHeaders[idx] : '';
      }

      // 按钮文案：未选→占位空格；全选→「全部」；部分→顿号拼接（与渠道下拉 updateLabel 同口径）。
      function updateValuesLabel() {
        if (selectedValues.size === 0) {
          valuesDropdownBtn.textContent = ' ';
        } else if (currentValuesList.length > 0 && selectedValues.size === currentValuesList.length) {
          valuesDropdownBtn.textContent = '全部';
        } else {
          valuesDropdownBtn.textContent = currentValuesList.filter((v) => selectedValues.has(v)).join('、') || ' ';
        }
        valuesDropdownBtn.title = valuesDropdownBtn.textContent;
      }

      function renderValueOptions() {
        valuesPanel.replaceChildren();
        currentValuesList.forEach((v) => {
          const option = document.createElement('label');
          option.className = 'new-account-currency-option';
          const text = document.createElement('span');
          text.className = 'new-account-currency-option-text';
          text.textContent = v;
          const checkbox = document.createElement('input');
          checkbox.className = 'new-account-checkbox';
          checkbox.type = 'checkbox';
          checkbox.checked = selectedValues.has(v);
          checkbox.addEventListener('change', () => {
            if (!lifecycle.isActive() || rowsCheck.checked || busy) return;
            if (checkbox.checked) selectedValues.add(v);
            else selectedValues.delete(v);
            updateValuesLabel();
            updateCompleteState();
          });
          option.append(text, checkbox);
          valuesPanel.appendChild(option);
        });
      }

      function positionValuesPanel() {
        const rect = valuesDropdownBtn.getBoundingClientRect();
        const margin = 12;
        valuesPanel.style.position = 'fixed';
        valuesPanel.style.minWidth = `${Math.max(rect.width, 188)}px`;
        valuesPanel.style.maxWidth = `${Math.max(220, Math.min(280, window.innerWidth - margin * 2))}px`;
        valuesPanel.hidden = false;
        const panelHeight = valuesPanel.offsetHeight || 216;
        const panelWidth = valuesPanel.offsetWidth || 200;
        const left = Math.min(Math.max(margin, rect.left), Math.max(margin, window.innerWidth - panelWidth - margin));
        const top = rect.bottom + 6 + panelHeight > window.innerHeight - margin
          ? Math.max(margin, rect.top - panelHeight - 6)
          : rect.bottom + 6;
        valuesPanel.style.left = `${left}px`;
        valuesPanel.style.top = `${top}px`;
      }

      function closeValuesPanel() {
        panelOpen = false;
        valuesPanel.hidden = true;
        valuesDropdownBtn.classList.remove('is-open');
        valuesDropdownBtn.setAttribute('aria-expanded', 'false');
      }
      function openValuesPanel() {
        if (valuesDropdownBtn.disabled) return;
        renderValueOptions();
        panelOpen = true;
        valuesDropdownBtn.classList.add('is-open');
        valuesDropdownBtn.setAttribute('aria-expanded', 'true');
        positionValuesPanel();
      }
      valuesDropdownBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!lifecycle.isActive()) return;
        if (panelOpen) closeValuesPanel(); else openValuesPanel();
      });

      // 切换字段 → 重置值列表 + 清空已选（新字段值集不同）+ 关面板 + 边界提示（字段无值则禁用下拉）。
      function refreshValues() {
        if (rowsCheck.checked || busy) return;
        const fieldName = currentFieldName();
        currentValuesList = Array.isArray(safeValuesByField[fieldName]) ? safeValuesByField[fieldName] : [];
        selectedValues = new Set();
        closeValuesPanel();
        valuesDropdownBtn.disabled = currentValuesList.length === 0; // 边界①：字段无去重值 → 下拉禁用
        hintEl.textContent = currentValuesList.length === 0 ? '该字段无可选值（该列为空），请改选其他字段' : '';
        updateValuesLabel();
        updateCompleteState();
      }

      // 边界②：选中值数为 0 → [完成] 禁用（不允许空选导出，否则过滤命中 0 行产空 sheet）。
      function getSelectedValues() {
        return currentValuesList.filter((v) => selectedValues.has(v));
      }
      function rowsPreview() {
        const checked = validateRowsInput(rowsInput.value);
        if (!checked.valid) return checked;
        if (!splitReadToken || !Number.isSafeInteger(dataRowCount) || dataRowCount < 0 ||
            !Number.isSafeInteger(maxRowSplitFiles) || maxRowSplitFiles <= 0) {
          return { valid: false, message: '导入计数不可用，请重新导入文件' };
        }
        if (dataRowCount === 0) return { valid: false, message: '文件中没有可拆分的数据行' };
        const count = (BigInt(dataRowCount) - 1n) / BigInt(checked.value) + 1n;
        if (count > BigInt(maxRowSplitFiles)) {
          const minimum = (BigInt(dataRowCount) - 1n) / BigInt(maxRowSplitFiles) + 1n;
          return { valid: false, message: `预计生成 ${count} 个文件，最多支持 ${maxRowSplitFiles} 个，请将每份行数调整为至少 ${minimum} 行。` };
        }
        return { valid: true, value: checked.value, fileCount: Number(count) };
      }

      function updateCompleteState() {
        _session.draft = {
          mode: rowsCheck.checked ? 'rows' : 'single',
          fieldIndex: fieldSelect.value,
          values: getSelectedValues(),
          rowsPerFile: rowsInput.value
        };
        const byRows = rowsCheck.checked;
        const checked = byRows ? rowsPreview() : null;
        fieldSelect.disabled = byRows || busy || safeHeaders.length === 0;
        valuesDropdownBtn.disabled = byRows || busy || currentValuesList.length === 0;
        multipleFilesCheck.disabled = byRows || busy;
        rowsCheck.disabled = busy;
        rowsWrap.hidden = !byRows;
        rowsInput.disabled = !byRows || busy;
        hintEl.textContent = byRows
          ? ((!checked.valid && (rowsTouched || rowsInput.value.trim())) ? checked.message : '')
          : (currentValuesList.length === 0 ? '该字段无可选值（该列为空），请改选其他字段' : '');
        rowsInput.setAttribute('aria-invalid', String(byRows && rowsTouched && !checked.valid));
        completeBtn.disabled = busy || (byRows ? !checked.valid : selectedValues.size === 0);
      }

      rowsCheck.addEventListener('change', () => {
        if (!lifecycle.isActive() || busy) return;
        closeValuesPanel();
        if (rowsCheck.checked) multipleFilesCheck.checked = false;
        updateCompleteState();
        if (rowsCheck.checked && !rowsInput.disabled) rowsInput.focus();
      });
      rowsInput.addEventListener('input', () => { if (!lifecycle.isActive()) return; rowsTouched = true; updateCompleteState(); });
      rowsInput.addEventListener('blur', () => {
        if (!lifecycle.isActive()) return;
        rowsTouched = true;
        const checked = validateRowsInput(rowsInput.value);
        if (checked.valid) rowsInput.value = String(checked.value);
        updateCompleteState();
      });

      fieldSelect.addEventListener('change', () => { if (lifecycle.isActive()) refreshValues(); });
      multipleFilesCheck.addEventListener('change', () => {
        if (!lifecycle.isActive() || rowsCheck.checked || busy || !multipleFilesCheck.checked) return;
        closeValuesPanel();
        lifecycle.replace(() => createMultipleSplitFieldPickerDialog({
          headers: safeHeaders,
          valuesByField: safeValuesByField,
          splitReadToken, dataRowCount, maxRowSplitFiles,
          initialGroup: { field: currentFieldName(), values: getSelectedValues() },
          _session,
          onComplete,
          onCancel
        }));
      });

      function cancelAndClose() {
        if (!lifecycle.isActive()) return;
        closeValuesPanel();
        lifecycle.cancel();
      }
      closeBtn.addEventListener('click', cancelAndClose);
      cancelBtn.addEventListener('click', cancelAndClose);
      overlay.addEventListener('click', (ev) => {
        if (ev.target === overlay) {
          if (panelOpen) { closeValuesPanel(); return; } // 面板开时点遮罩仅收起面板，不关弹框
          cancelAndClose();
        }
      });

      completeBtn.addEventListener('click', () => {
        if (!lifecycle.isActive() || busy) return;
        if (rowsCheck.checked) {
          rowsTouched = true;
          const checked = rowsPreview();
          updateCompleteState();
          if (!checked.valid) return;
          closeValuesPanel();
          rowsInput.value = String(checked.value);
          busy = true;
          updateCompleteState();
          if (!lifecycle.submit({ mode: 'rows', rowsPerFile: checked.value })) {
            busy = false;
            updateCompleteState();
          }
          return;
        }
        const values = getSelectedValues();
        if (values.length === 0) {
          hintEl.textContent = '请至少选择一个值';
          return;
        }
        closeValuesPanel();
        busy = true;
        updateCompleteState();
        if (!lifecycle.submit({ field: currentFieldName(), values })) {
          busy = false;
          updateCompleteState();
        }
      });

      // 初始渲染：默认选中首个字段并刷新其值列表。
      refreshValues();
      return overlay;
    }

    function createMultipleSplitFieldPickerDialog({
      headers = [],
      valuesByField = {},
      initialGroup = null,
      splitReadToken = '', dataRowCount, maxRowSplitFiles,
      onComplete = null,
      onCancel = null,
      _session = { draft: null }
    } = {}) {
      let safeHeaders = Array.isArray(headers) ? headers : [];
      let safeValuesByField = (valuesByField && typeof valuesByField === 'object') ? valuesByField : {};
      const initialFieldIndex = initialGroup && safeHeaders.includes(initialGroup.field)
        ? safeHeaders.indexOf(initialGroup.field)
        : 0;

      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      overlay.dataset.previewModal = 'toolbox-split-field-picker-multiple';

      const dialog = document.createElement('div');
      dialog.className = 'modal-card toolbox-split-picker-card toolbox-split-multiple-card';
      dialog.innerHTML = `
        <div class="dialog-header">
          <div class="dialog-title">选择拆分字段</div>
          <button class="icon-close" type="button" aria-label="关闭">×</button>
        </div>
        <div class="dialog-body toolbox-split-picker-body toolbox-split-multiple-body">
          <div class="toolbox-split-groups" data-role="split-groups"></div>
          <button class="text-action toolbox-split-add-btn" type="button" data-action="add-group">新增</button>
          <div class="toolbox-split-picker-hint" data-role="multiple-hint"></div>
        </div>
        <div class="dialog-actions toolbox-split-picker-actions">
          <label class="toolbox-split-multiple-toggle">
            <input type="checkbox" data-field="multiple-files-enabled" checked>
            需要拆分成多个文件
          </label>
          <div class="toolbox-split-picker-action-buttons">
            <button class="secondary-btn small" type="button" data-action="cancel">取消</button>
            <button class="primary-btn small" type="button" data-action="complete" disabled>完成</button>
          </div>
        </div>
      `;
      overlay.appendChild(dialog);

      const groupsRoot = dialog.querySelector('[data-role="split-groups"]');
      const addButton = dialog.querySelector('[data-action="add-group"]');
      const hintEl = dialog.querySelector('[data-role="multiple-hint"]');
      const completeButton = dialog.querySelector('[data-action="complete"]');
      const cancelButton = dialog.querySelector('[data-action="cancel"]');
      const multiCheck = dialog.querySelector('input[data-field="multiple-files-enabled"]');
      const valuesPanel = document.createElement('div');
      valuesPanel.className = 'new-account-currency-dropdown-panel toolbox-split-values-floating-panel';
      valuesPanel.hidden = true;
      overlay.appendChild(valuesPanel);

      let nextGroupId = 1;
      let panelGroupId = null;
      let panelOpen = false;
      let busy = false;
      const initialValues = new Set(
        (initialGroup && Array.isArray(initialGroup.values) ? initialGroup.values : [])
          .filter((value) => (safeValuesByField[safeHeaders[initialFieldIndex]] || []).includes(value))
      );
      const groups = [{
        id: nextGroupId++,
        fileName: '',
        fieldIndex: initialFieldIndex,
        selectedValues: initialValues
      }];

      _session.draft = { mode: 'multiple', groups };
      const lifecycle = bindPicker(overlay, dialog, { onComplete, onCancel, beforeSubmit: _session.prepareSubmit }, () => {
        closeValuesPanel();
        groups.length = 0;
        safeHeaders = [];
        safeValuesByField = {};
      });

      function fieldNameOf(group) {
        return Number.isInteger(group.fieldIndex) && group.fieldIndex >= 0 && group.fieldIndex < safeHeaders.length
          ? safeHeaders[group.fieldIndex]
          : '';
      }

      function valuesOf(group) {
        const field = fieldNameOf(group);
        return Array.isArray(safeValuesByField[field]) ? safeValuesByField[field] : [];
      }

      function selectedValuesOf(group) {
        return valuesOf(group).filter((value) => group.selectedValues.has(value));
      }

      function valuesLabelOf(group) {
        const values = valuesOf(group);
        const selected = selectedValuesOf(group);
        if (selected.length === 0) return ' ';
        if (values.length > 0 && selected.length === values.length) return '全部';
        return selected.join('、') || ' ';
      }

      function normalizeFileName(rawValue) {
        let value = String(rawValue || '');
        if (!value.trim()) return { valid: false, message: '文件名不能为空' };
        if (value !== value.trim()) return { valid: false, message: '文件名不能以空格开头或结尾' };
        if (/[<>:"/\\|?*\u0000-\u001f]/.test(value)) {
          return { valid: false, message: '文件名包含系统不允许的字符' };
        }
        while (/\.xlsx$/i.test(value)) value = value.slice(0, -5);
        if (!value || /[.\s]$/.test(value)) return { valid: false, message: '文件名不能以空格或句点结尾' };
        if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(value)) {
          return { valid: false, message: '文件名是系统保留名称' };
        }
        return { valid: true, fileName: `${value}.xlsx` };
      }

      function closeValuesPanel() {
        panelOpen = false;
        panelGroupId = null;
        valuesPanel.hidden = true;
        dialog.querySelectorAll('.toolbox-split-values-dropdown-btn').forEach((button) => {
          button.classList.remove('is-open');
          button.setAttribute('aria-expanded', 'false');
        });
      }

      function updateCompleteState() {
        completeButton.disabled = busy || groups.some((group) => (
          String(group.fileName || '').trim() === ''
          || fieldNameOf(group) === ''
          || selectedValuesOf(group).length === 0
        ));
      }

      function positionValuesPanel(button) {
        const rect = button.getBoundingClientRect();
        const margin = 12;
        valuesPanel.style.position = 'fixed';
        valuesPanel.style.minWidth = `${Math.max(rect.width, 188)}px`;
        valuesPanel.style.maxWidth = `${Math.max(220, Math.min(280, window.innerWidth - margin * 2))}px`;
        valuesPanel.hidden = false;
        const panelHeight = valuesPanel.offsetHeight || 216;
        const panelWidth = valuesPanel.offsetWidth || 200;
        valuesPanel.style.left = `${Math.min(Math.max(margin, rect.left), Math.max(margin, window.innerWidth - panelWidth - margin))}px`;
        valuesPanel.style.top = `${rect.bottom + 6 + panelHeight > window.innerHeight - margin
          ? Math.max(margin, rect.top - panelHeight - 6)
          : rect.bottom + 6}px`;
      }

      function refreshGroupValuesButton(group) {
        const section = groupsRoot.querySelector(`[data-group-id="${group.id}"]`);
        const button = section && section.querySelector('[data-role="values-button"]');
        if (!button) return;
        button.textContent = valuesLabelOf(group);
        button.title = button.textContent;
        button.disabled = valuesOf(group).length === 0;
      }

      function openValuesPanel(group, button) {
        closeValuesPanel();
        panelGroupId = group.id;
        valuesPanel.replaceChildren();
        for (const value of valuesOf(group)) {
          const option = document.createElement('label');
          option.className = 'new-account-currency-option';
          const text = document.createElement('span');
          text.className = 'new-account-currency-option-text';
          text.textContent = value;
          const checkbox = document.createElement('input');
          checkbox.className = 'new-account-checkbox';
          checkbox.type = 'checkbox';
          checkbox.checked = group.selectedValues.has(value);
          checkbox.addEventListener('change', () => {
            if (!lifecycle.isActive() || busy) return;
            if (checkbox.checked) group.selectedValues.add(value);
            else group.selectedValues.delete(value);
            refreshGroupValuesButton(group);
            updateCompleteState();
          });
          option.append(text, checkbox);
          valuesPanel.appendChild(option);
        }
        panelOpen = true;
        button.classList.add('is-open');
        button.setAttribute('aria-expanded', 'true');
        positionValuesPanel(button);
      }

      function renderGroups() {
        closeValuesPanel();
        groupsRoot.replaceChildren();
        groups.forEach((group, index) => {
          const section = document.createElement('section');
          section.className = 'toolbox-split-group';
          section.dataset.groupId = String(group.id);

          const sequence = document.createElement('span');
          sequence.className = 'toolbox-split-group-sequence';
          sequence.textContent = `文件${index + 1}`;

          const fileLabel = document.createElement('span');
          fileLabel.className = 'toolbox-split-group-label';
          fileLabel.textContent = '文件名';
          const fileInput = document.createElement('input');
          fileInput.className = 'scenario-config-input toolbox-split-file-name-input';
          fileInput.type = 'text';
          fileInput.value = group.fileName;
          fileInput.addEventListener('input', () => {
            if (!lifecycle.isActive() || busy) return;
            group.fileName = fileInput.value;
            hintEl.textContent = '';
            updateCompleteState();
          });

          const fieldLabel = document.createElement('span');
          fieldLabel.className = 'toolbox-split-group-label';
          fieldLabel.textContent = '字段';
          const fieldSelect = document.createElement('select');
          fieldSelect.className = 'toolbox-split-picker-field';
          safeHeaders.forEach((header, headerIndex) => {
            const option = document.createElement('option');
            option.value = String(headerIndex);
            option.textContent = header;
            fieldSelect.appendChild(option);
          });
          fieldSelect.value = String(group.fieldIndex);
          fieldSelect.addEventListener('change', () => {
            if (!lifecycle.isActive() || busy) return;
            group.fieldIndex = Number.parseInt(fieldSelect.value, 10);
            group.selectedValues = new Set();
            hintEl.textContent = valuesOf(group).length === 0
              ? `文件${index + 1}所选字段无可选值，请改选其他字段`
              : '';
            renderGroups();
          });

          const valuesLabel = document.createElement('span');
          valuesLabel.className = 'toolbox-split-group-label';
          valuesLabel.textContent = '值';
          const valuesWrap = document.createElement('div');
          valuesWrap.className = 'new-account-currency-dropdown-wrap toolbox-split-values-dropdown-wrap';
          const valuesButton = document.createElement('button');
          valuesButton.className = 'new-account-currency-dropdown-btn toolbox-split-values-dropdown-btn';
          valuesButton.type = 'button';
          valuesButton.dataset.role = 'values-button';
          valuesButton.setAttribute('aria-expanded', 'false');
          valuesButton.textContent = valuesLabelOf(group);
          valuesButton.title = valuesButton.textContent;
          valuesButton.disabled = valuesOf(group).length === 0;
          valuesButton.addEventListener('click', (event) => {
            event.stopPropagation();
            if (!lifecycle.isActive() || busy) return;
            if (panelOpen && panelGroupId === group.id) closeValuesPanel();
            else openValuesPanel(group, valuesButton);
          });
          valuesWrap.appendChild(valuesButton);

          const deleteButton = document.createElement('button');
          deleteButton.className = 'icon-close toolbox-split-delete-group';
          deleteButton.type = 'button';
          deleteButton.textContent = '×';
          deleteButton.title = `删除文件${index + 1}`;
          deleteButton.setAttribute('aria-label', deleteButton.title);
          deleteButton.disabled = groups.length === 1;
          deleteButton.addEventListener('click', () => {
            if (!lifecycle.isActive() || busy || groups.length === 1) return;
            groups.splice(index, 1);
            hintEl.textContent = '';
            renderGroups();
          });

          sequence.style.gridRow = '1 / 4';
          deleteButton.style.gridRow = '1 / 4';
          section.append(
            sequence,
            fileLabel, fileInput, deleteButton,
            fieldLabel, fieldSelect,
            valuesLabel, valuesWrap
          );
          groupsRoot.appendChild(section);
        });
        addButton.disabled = groups.length >= 8;
        addButton.hidden = groups.length >= 8;
        updateCompleteState();
      }

      addButton.addEventListener('click', () => {
        if (!lifecycle.isActive() || busy || groups.length >= 8) return;
        const previous = groups[groups.length - 1];
        groups.push({
          id: nextGroupId++,
          fileName: '',
          fieldIndex: previous ? previous.fieldIndex : 0,
          selectedValues: new Set()
        });
        hintEl.textContent = '';
        renderGroups();
      });

      function cancelAndClose() {
        if (!lifecycle.isActive()) return;
        closeValuesPanel();
        lifecycle.cancel();
      }
      dialog.querySelector('.icon-close').addEventListener('click', cancelAndClose);
      cancelButton.addEventListener('click', cancelAndClose);
      multiCheck.addEventListener('change', () => {
        if (!lifecycle.isActive() || busy || multiCheck.checked) return;
        closeValuesPanel();
        lifecycle.replace(() => createSplitFieldPickerDialog({
          splitReadToken, dataRowCount, maxRowSplitFiles, _session,
          headers: safeHeaders,
          valuesByField: safeValuesByField,
          onComplete,
          onCancel
        }));
      });
      overlay.addEventListener('click', (event) => {
        if (event.target !== overlay) return;
        if (panelOpen) { closeValuesPanel(); return; }
        cancelAndClose();
      });

      completeButton.addEventListener('click', () => {
        if (!lifecycle.isActive() || busy) return;
        const normalizedGroups = [];
        const seenNames = new Set();
        for (let index = 0; index < groups.length; index += 1) {
          const group = groups[index];
          const normalizedName = normalizeFileName(group.fileName);
          if (!normalizedName.valid) {
            hintEl.textContent = `文件${index + 1}：${normalizedName.message}`;
            return;
          }
          const duplicateKey = normalizedName.fileName.toLocaleLowerCase('en-US');
          if (seenNames.has(duplicateKey)) {
            hintEl.textContent = `文件${index + 1}：文件名与其他分组重复`;
            return;
          }
          seenNames.add(duplicateKey);
          const field = fieldNameOf(group);
          const selectedValues = selectedValuesOf(group);
          if (!field || selectedValues.length === 0) {
            hintEl.textContent = `文件${index + 1}：请选择字段和至少一个值`;
            return;
          }
          normalizedGroups.push({ fileName: normalizedName.fileName, field, values: selectedValues });
        }
        closeValuesPanel();
        busy = true;
        updateCompleteState();
        if (!lifecycle.submit({ mode: 'multiple', groups: normalizedGroups })) {
          busy = false;
          updateCompleteState();
        }
      });

      renderGroups();
      return overlay;
    }


    return Object.freeze({ createToolboxDialog, createSplitFieldPickerDialog,
      createMultipleSplitFieldPickerDialog, validateRowsInput });
  }

  global.__toolboxDialogs = Object.freeze({ createToolboxDialogs });
  if (typeof module !== 'undefined' && module.exports) module.exports = global.__toolboxDialogs;
})(typeof window !== 'undefined' ? window : globalThis);
