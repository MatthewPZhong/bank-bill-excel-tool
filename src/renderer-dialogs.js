(function initRendererDialogs(global) {
  function createRendererDialogs(deps) {
    const {
      state,
      elements,
      desktopApi,
      BALANCE_DISABLED_OPTION,
      BALANCE_CALCULATED_OPTION,
      MERCHANT_ID_SELF_INPUT_OPTION,
      ADVANCED_MAPPING_FIELDS,
      CONCAT_FIELDS_MAPPING_FIELD,
      AMOUNT_SPLIT_BY_FIELD_MAPPING_FIELD,
      AMOUNT_SPLIT_BY_FIELD_ENABLED_OPTION,
      refreshTemplates,
      setStatus,
      applyStatementResult,
      applyManualBalancePromptStatus
    } = deps;

    // 同步修改：main 侧的另一份实现位于 src/backend/file-service/normalizers.js 内
    // REGEX_LITERAL_PATTERN / isRegexLiteral / compileRegexLiteral / matchAmountSplitConditionValue。
    // 两份必须保持行为一致。按团队约定不引入 src/shared/ 公共模块。
    const REGEX_LITERAL_PATTERN_RENDERER = /^\/(.+)\/([gimsu]*)$/;

    function looksLikeRegexLiteral(input) {
      if (typeof input !== 'string') {
        return false;
      }
      return REGEX_LITERAL_PATTERN_RENDERER.test(input);
    }

    function parseRegexLiteral(input) {
      const match = REGEX_LITERAL_PATTERN_RENDERER.exec(String(input || ''));
      if (!match) {
        return null;
      }
      try {
        return new RegExp(match[1], match[2]);
      } catch (_error) {
        return null;
      }
    }

    function closeModal() {
      elements.modalRoot.innerHTML = '';
    }

    function openModal(modalElement) {
      elements.modalRoot.innerHTML = '';
      elements.modalRoot.appendChild(modalElement);
    }

    function createOverlay() {
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      return overlay;
    }

    function escapeHtml(value) {
      return String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;');
    }

    function createAlertDialog(message, options = {}) {
      const { onConfirm = null } = options;
      const overlay = createOverlay();
      const dialog = document.createElement('div');
      dialog.className = 'modal-card alert-card';
      dialog.innerHTML = `
        <div class="alert-message">${message}</div>
        <div class="dialog-actions center">
          <button class="primary-btn small" type="button">确认</button>
        </div>
      `;
      dialog.querySelector('button').addEventListener('click', () => {
        closeModal();
        onConfirm?.();
      });
      overlay.appendChild(dialog);
      return overlay;
    }

    function createConfirmDialog({ message, confirmText, cancelText, onConfirm }) {
      const overlay = createOverlay();
      const dialog = document.createElement('div');
      dialog.className = 'modal-card alert-card';
      dialog.innerHTML = `
        <div class="alert-message">${message}</div>
        <div class="dialog-actions center">
          <button class="danger-btn small" type="button" data-action="confirm">${confirmText}</button>
          <button class="secondary-btn small" type="button" data-action="cancel">${cancelText}</button>
        </div>
      `;
      dialog.querySelector('[data-action="confirm"]').addEventListener('click', async () => {
        await onConfirm();
      });
      dialog.querySelector('[data-action="cancel"]').addEventListener('click', closeModal);
      overlay.appendChild(dialog);
      return overlay;
    }

    function createExportScopeDialog(kind) {
      const overlay = createOverlay();
      const dialog = document.createElement('div');
      const fieldLabel = kind === 'detail' ? '明细' : '余额';
      dialog.className = 'modal-card alert-card export-scope-card';
      dialog.innerHTML = `
        <div class="alert-message">请选择要导出的范围</div>
        <div class="dialog-actions vertical">
          <button class="secondary-btn small export-scope-btn" type="button" data-scope="current">导出当前文件的${fieldLabel}</button>
          <button class="secondary-btn small export-scope-btn" type="button" data-scope="all">导出所有${fieldLabel}</button>
        </div>
      `;

      async function runExport(scope) {
        closeModal();
        const result = kind === 'detail'
          ? await desktopApi.files.exportDetail(scope)
          : await desktopApi.files.exportBalance(scope);

        if (result.status === 'cancelled') {
          return;
        }

        if (result.status === 'select-export-scope') {
          openModal(createExportScopeDialog(kind));
          return;
        }

        if (kind === 'balance' && (result.manualBalancePromptReady || result.status === 'manual-balance-required')) {
          applyManualBalancePromptStatus(result);
          return;
        }

        setStatus(result.message, result.status === 'success' ? 'success' : 'error', {
          errorReportReady: Boolean(result.errorReportReady)
        });
      }

      dialog.querySelector('[data-scope="current"]').addEventListener('click', () => {
        runExport('current').catch((error) => {
          console.error(error);
          setStatus(`导出${fieldLabel}账单失败，请查看控制台`, 'error');
        });
      });
      dialog.querySelector('[data-scope="all"]').addEventListener('click', () => {
        runExport('all').catch((error) => {
          console.error(error);
          setStatus(`导出${fieldLabel}账单失败，请查看控制台`, 'error');
        });
      });
      overlay.appendChild(dialog);
      return overlay;
    }

    function createManualBalanceSeedDialog(prompt, draft = {}, queueState = null) {
      const overlay = createOverlay();
      const dialog = document.createElement('div');
      dialog.className = 'modal-card manual-balance-card';
      const promptQueueIndex = Number.isInteger(prompt?.queueIndex) && prompt.queueIndex > 0 ? prompt.queueIndex : 0;
      const promptQueueTotal = Number.isInteger(prompt?.queueTotal) && prompt.queueTotal > 0 ? prompt.queueTotal : 0;
      const currentQueue = queueState || { index: promptQueueIndex || 1, total: promptQueueTotal || 0 };
      const queueIndex = promptQueueIndex || currentQueue.index;
      const queueTotal = promptQueueTotal || currentQueue.total;
      const merchantId = prompt?.merchantId || 'N/A';
      const currency = prompt?.currency || '(空)';
      const targetBillDate = prompt?.targetBillDate || 'N/A';
      dialog.innerHTML = `
        <div class="dialog-header">
          <div class="dialog-title">补录上一账单日余额</div>
          <button class="icon-close" type="button">×</button>
        </div>
        <div class="manual-balance-context">
          <div class="manual-balance-progress">第 ${queueIndex} 个账号${queueTotal ? `，共 ${queueTotal} 个` : ''}</div>
          <div class="manual-balance-context-grid">
            <div class="manual-balance-context-row">
              <span class="manual-balance-context-label">银行账号</span>
              <span class="manual-balance-context-value manual-balance-context-account" title="${escapeHtml(merchantId)}">${escapeHtml(merchantId)}</span>
            </div>
            <div class="manual-balance-context-row">
              <span class="manual-balance-context-label">币种</span>
              <span class="manual-balance-context-tag" title="${escapeHtml(currency)}">${escapeHtml(currency)}</span>
            </div>
            <div class="manual-balance-context-row">
              <span class="manual-balance-context-label">当前账单日期</span>
              <span class="manual-balance-context-value" title="${escapeHtml(targetBillDate)}">${escapeHtml(targetBillDate)}</span>
            </div>
          </div>
        </div>
        <div class="manual-balance-form">
          <label class="manual-balance-row">
            <span class="manual-balance-label">请选择上一账单日日期</span>
            <input class="mapping-text-input manual-balance-input manual-balance-date-input" type="text" value="" />
          </label>
          <label class="manual-balance-row">
            <span class="manual-balance-label">请输入上一账单日余额</span>
            <input class="mapping-text-input manual-balance-input manual-balance-amount-input" type="text" spellcheck="false" value="" />
          </label>
        </div>
        <div class="dialog-actions right">
          <button class="primary-btn small" type="button" data-action="done">完成</button>
        </div>
      `;

      const dateInput = dialog.querySelector('.manual-balance-date-input');
      const amountInput = dialog.querySelector('.manual-balance-amount-input');
      dateInput.value = draft.billDate || '';
      dateInput.type = dateInput.value ? 'date' : 'text';
      amountInput.value = draft.endBalance || '';

      dateInput.addEventListener('focus', () => {
        if (dateInput.type !== 'date') {
          dateInput.type = 'date';
        }

        dateInput.showPicker?.();
      });
      dateInput.addEventListener('blur', () => {
        if (!dateInput.value) {
          dateInput.type = 'text';
        }
      });
      const doneBtn = dialog.querySelector('[data-action="done"]');

      function handleSaveResult(result) {
        if (result.status === 'manual-balance-invalid') {
          applyManualBalancePromptStatus(result);
          openModal(createManualBalanceSeedDialog(
            result.manualBalancePrompt,
            { billDate: dateInput.value, endBalance: amountInput.value },
            currentQueue
          ));
          return;
        }

        applyStatementResult(result);

        if (result.manualBalancePromptReady && result.manualBalancePrompt) {
          openModal(createManualBalanceSeedDialog(
            result.manualBalancePrompt,
            {},
            { index: queueIndex + 1, total: queueTotal }
          ));
          return;
        }

        closeModal();

        if (result.status === 'error' && !result.manualBalancePromptReady) {
          openModal(createAlertDialog(result.message));
        }
      }

      dialog.querySelector('.icon-close').addEventListener('click', closeModal);
      doneBtn.addEventListener('click', async () => {
        const payload = {
          billDate: dateInput.value,
          endBalance: amountInput.value
        };
        const result = await desktopApi.files.saveBalanceSeed(payload);

        if (result.status === 'confirm-overwrite') {
          openModal(
            createConfirmDialog({
              message: '该日期的余额已存在，确认覆盖吗？',
              confirmText: '确认覆盖',
              cancelText: '取消',
              onConfirm: async () => {
                const overwriteResult = await desktopApi.files.saveBalanceSeed({
                  ...payload,
                  overwrite: true
                });
                handleSaveResult(overwriteResult);
              }
            })
          );
          return;
        }

        handleSaveResult(result);
      });

      overlay.appendChild(dialog);
      return overlay;
    }

    function cloneBigAccountItems(bigAccounts = []) {
      return bigAccounts.map((item) => ({
        merchantId: String(item.merchantId || ''),
        currencies: Array.isArray(item.currencies) ? item.currencies.slice() : [],
        isMultiCurrency: Boolean(item.isMultiCurrency)
      }));
    }

    function formatBigAccountCurrencySummary(currencies) {
      const uniqueCurrencies = Array.from(new Set((currencies || []).filter((value) => value)));

      if (!uniqueCurrencies.length) {
        return '';
      }

      if (uniqueCurrencies.length === 1) {
        return uniqueCurrencies[0];
      }

      if (uniqueCurrencies.length <= 3) {
        return uniqueCurrencies.join('、');
      }

      return `${uniqueCurrencies.length}个币种`;
    }

    function getBigAccountCurrencyTitle(currencies) {
      return Array.from(new Set((currencies || []).filter((value) => value))).join('、');
    }

    function normalizeCurrencyOptionEntry(option) {
      if (typeof option === 'string') {
        const code = option.trim();
        return code
          ? {
              code,
              name: '',
              label: code
            }
          : null;
      }

      if (!option || typeof option !== 'object') {
        return null;
      }

      const code = String(option.code || option.englishCode || '').trim();

      if (!code) {
        return null;
      }

      const name = String(option.name || option.displayName || option.chineseName || '').trim();
      return {
        code,
        name,
        label: String(option.label || '').trim() || (name ? `${code} ${name}` : code)
      };
    }

    function getCurrencyOptionEntries() {
      const optionMap = new Map();

      (state.currencyOptions || []).forEach((option) => {
        const normalized = normalizeCurrencyOptionEntry(option);

        if (!normalized || optionMap.has(normalized.code)) {
          return;
        }

        optionMap.set(normalized.code, normalized);
      });

      return Array.from(optionMap.values());
    }

    function getCurrencyOptionLabel(code) {
      const normalizedCode = String(code || '').trim();
      const matchedOption = getCurrencyOptionEntries().find((option) => option.code === normalizedCode);
      return matchedOption?.label || normalizedCode;
    }

    function getCurrencySuggestion(value, allowedCodes = []) {
      const query = String(value || '').trim().toUpperCase();

      if (!query) {
        return '';
      }

      const allowedCodeSet = allowedCodes.length
        ? new Set(allowedCodes.map((code) => String(code || '').trim()).filter(Boolean))
        : null;
      const matchedOption = getCurrencyOptionEntries().find((option) => {
        if (allowedCodeSet && !allowedCodeSet.has(option.code)) {
          return false;
        }

        return option.code.toUpperCase().startsWith(query);
      });

      return matchedOption?.code || '';
    }

    function getSelectValues(selectElement) {
      if (!selectElement) {
        return [];
      }

      if (selectElement.multiple) {
        return Array.from(selectElement.selectedOptions)
          .map((option) => option.value)
          .filter((value) => value !== '');
      }

      return selectElement.value ? [selectElement.value] : [];
    }

    function collectMappingDraftFromTable(tableBody) {
      return Array.from(tableBody.querySelectorAll('tr[data-template-field]')).map((row) => {
        const select = row.querySelector('.mapping-select');
        const mappedFields = getSelectValues(select);
        const firstValue = mappedFields[0] || '';
        const isConcatMode = firstValue === CONCAT_FIELDS_MAPPING_FIELD;

        if (isConcatMode) {
          const concatFields = row.dataset.concatFields ? JSON.parse(row.dataset.concatFields) : [];
          return {
            templateField: row.dataset.templateField,
            mappedField: CONCAT_FIELDS_MAPPING_FIELD,
            mappedFields: concatFields,
            customValue: '',
            isMultiBigAccount: false
          };
        }

        // Preserve legacy concat config on fields that no longer support concat
        // UI (e.g. Currency). If the user hasn't explicitly picked a new value
        // (select is empty), restore the original concat mapping instead of
        // silently wiping it.
        if (!firstValue && row.dataset.legacyConcatMode === 'true') {
          const legacyFields = row.dataset.legacyConcatFields
            ? JSON.parse(row.dataset.legacyConcatFields)
            : [];
          return {
            templateField: row.dataset.templateField,
            mappedField: CONCAT_FIELDS_MAPPING_FIELD,
            mappedFields: legacyFields,
            customValue: '',
            isMultiBigAccount: false
          };
        }

        return {
          templateField: row.dataset.templateField,
          mappedField: firstValue,
          mappedFields: [],
          customValue: '',
          isMultiBigAccount: false
        };
      });
    }

    function createTemplateRenameDialog(template) {
      const overlay = createOverlay();
      const dialog = document.createElement('div');
      dialog.className = 'modal-card manual-balance-card';
      dialog.innerHTML = `
        <div class="dialog-header">
          <div class="dialog-title">重命名模板</div>
          <button class="icon-close" type="button">×</button>
        </div>
        <div class="manual-balance-form">
          <label class="manual-balance-row">
            <span class="manual-balance-label">当前模板名称</span>
            <input class="mapping-text-input manual-balance-input" type="text" value="${escapeHtml(template.name)}" disabled />
          </label>
          <label class="manual-balance-row">
            <span class="manual-balance-label">新模板名称</span>
            <input class="mapping-text-input manual-balance-input rename-template-input" type="text" spellcheck="false" value="${escapeHtml(template.name)}" />
          </label>
        </div>
        <div class="dialog-actions right">
          <button class="primary-btn small" type="button" data-action="done">完成</button>
        </div>
      `;

      const input = dialog.querySelector('.rename-template-input');
      dialog.querySelector('.icon-close').addEventListener('click', () => {
        openModal(createTemplateManagerDialog());
      });
      dialog.querySelector('[data-action="done"]').addEventListener('click', async () => {
        const result = await desktopApi.templates.rename({
          templateId: template.id,
          name: input.value
        });

        setStatus(result.message, result.status === 'success' ? 'success' : 'error', {
          errorReportReady: Boolean(result.errorReportReady)
        });

        if (result.status === 'success') {
          await refreshTemplates();
          openModal(createTemplateManagerDialog());
          return;
        }

        openModal(createAlertDialog(result.message));
      });

      overlay.appendChild(dialog);
      return overlay;
    }

    function createBigAccountSelectionDialog(payload) {
      if (Array.isArray(payload)) {
        const overlay = createOverlay();
        const dialog = document.createElement('div');
        dialog.className = 'modal-card manual-balance-card';
        dialog.innerHTML = `
          <div class="dialog-header">
            <div class="dialog-title">请选择本次使用的大账号 / 币种</div>
            <button class="icon-close" type="button">×</button>
          </div>
          <div class="big-account-selection-list"></div>
          <div class="dialog-actions right">
            <button class="primary-btn small" type="button" data-action="done">完成</button>
          </div>
        `;

        const list = dialog.querySelector('.big-account-selection-list');
        const radioName = `big-account-selection-${Date.now()}`;

        payload.forEach((option, index) => {
          const label = document.createElement('label');
          label.className = 'big-account-selection-item';
          label.innerHTML = `
            <input class="new-account-checkbox" type="radio" name="${radioName}" value="${index}" />
            <span>${escapeHtml(option.label)}</span>
          `;
          list.appendChild(label);
        });

        dialog.querySelector('.icon-close').addEventListener('click', closeModal);
        dialog.querySelector('[data-action="done"]').addEventListener('click', async () => {
          const checked = list.querySelector(`input[name="${radioName}"]:checked`);

          if (!checked) {
            setStatus('请选择本次使用的大账号 / 币种', 'error');
            return;
          }

          const selectedOption = payload[Number(checked.value)];
          const result = await desktopApi.files.completeBigAccountSelection({
            assignments: [
              {
                rowIndex: 0,
                merchantId: selectedOption.merchantId,
                currency: selectedOption.currency
              }
            ],
            fixed: false
          });

          closeModal();
          applyStatementResult(result);

          if (result.status === 'error' && !result.manualBalancePromptReady) {
            openModal(createAlertDialog(result.message));
          }
        });

        overlay.appendChild(dialog);
        return overlay;
      }

      const rows = Array.isArray(payload?.rows) ? payload.rows : [];
      const rowsWithEmptyBlocks = Array.isArray(payload?.rowsWithEmptyBlocks) ? payload.rowsWithEmptyBlocks : rows;
      const expandedOptions = Array.isArray(payload?.expandedBigAccountOptions) ? payload.expandedBigAccountOptions : [];
      const templateId = payload?.templateId;

      const overlay = createOverlay();
      const dialog = document.createElement('div');
      dialog.className = 'modal-card big-account-selection-card big-account-selection-split';

      let currentMode = 'unfixed';
      let currentFileRows = rows;
      let checkedOrder = [];
      let searchMatchIndex = -1;
      let searchMatches = [];
      let lastSearchQuery = '';

      dialog.innerHTML = `
        <div class="dialog-header">
          <div class="dialog-title">请选择本次使用的大账号 / 币种</div>
          <div class="big-account-selection-toolbar">
            <span class="big-account-mode-label">多账号账单导入解析模式</span>
            <select class="mapping-select big-account-mode-select">
              <option value="unfixed">账号顺序不固定</option>
              <option value="fixed">账号顺序固定</option>
            </select>
            <button class="icon-close" type="button">×</button>
          </div>
        </div>
        <div class="big-account-split-body">
          <div class="big-account-split-left">
            <div class="big-account-split-header">文件顺序：</div>
            <div class="big-account-file-list"></div>
          </div>
          <div class="big-account-split-right">
            <div class="big-account-split-header">大账号顺序：</div>
            <div class="big-account-order-list"></div>
          </div>
        </div>
        <div class="dialog-actions big-account-selection-footer">
          <span class="big-account-search-label">定位大账号</span>
          <input class="mapping-text-input big-account-search-input" type="text" spellcheck="false" />
          <label class="big-account-remember-label is-disabled">
            <input class="new-account-checkbox big-account-remember-checkbox" type="checkbox" />
            <span>记住大账号选择顺序</span>
          </label>
          <button class="primary-btn small" type="button" data-action="done">完成</button>
        </div>
      `;

      const modeSelect = dialog.querySelector('.big-account-mode-select');
      const fileListContainer = dialog.querySelector('.big-account-file-list');
      const orderListContainer = dialog.querySelector('.big-account-order-list');
      const searchInput = dialog.querySelector('.big-account-search-input');
      const rememberLabel = dialog.querySelector('.big-account-remember-label');
      const rememberCheckbox = dialog.querySelector('.big-account-remember-checkbox');
      const doneBtn = dialog.querySelector('[data-action="done"]');

      function truncateFileName(fileName, maxLen) {
        if (!fileName || fileName.length <= maxLen) return fileName || '';
        const keepStart = 6;
        const keepEnd = 10;
        if (fileName.length <= keepStart + keepEnd + 3) return fileName;
        return fileName.slice(0, keepStart) + '...' + fileName.slice(-keepEnd);
      }

      function renderFileList() {
        fileListContainer.innerHTML = '';
        currentFileRows.forEach((row, index) => {
          const item = document.createElement('div');
          item.className = 'big-account-file-item';
          const fullName = row.fileName || '';
          const rowSuffix = row.sourceRowNumber ? ` 第${row.sourceRowNumber}行` : '';
          const displayName = truncateFileName(fullName, 20) + rowSuffix;
          const fullMeta = fullName + rowSuffix;
          item.innerHTML = `<span class="big-account-file-index">${index + 1}.</span><span class="big-account-file-meta" title="${escapeHtml(fullMeta)}">${escapeHtml(displayName)}</span>`;
          fileListContainer.appendChild(item);
        });
      }

      function renderOrderList() {
        orderListContainer.innerHTML = '';
        if (!expandedOptions.length) {
          orderListContainer.innerHTML = '<div class="big-account-order-empty">暂无可选大账号，请先在映射管理中维护大账号</div>';
          return;
        }
        expandedOptions.forEach((option, index) => {
          const item = document.createElement('div');
          item.className = 'big-account-order-item';
          item.dataset.merchantId = option.merchantId;
          item.dataset.currency = option.currency;
          const label = `${option.merchantId} ${option.currency}`;
          const checkbox = document.createElement('input');
          checkbox.type = 'checkbox';
          checkbox.className = 'new-account-checkbox big-account-order-checkbox';
          const indexSpan = document.createElement('span');
          indexSpan.className = 'concat-picker-index big-account-order-index';
          indexSpan.textContent = '';
          const textSpan = document.createElement('span');
          textSpan.className = 'big-account-order-text';
          textSpan.title = label;
          textSpan.textContent = label;

          checkbox.addEventListener('change', () => {
            const key = `${option.merchantId}@@${option.currency}`;
            if (checkbox.checked) {
              if (checkedOrder.length >= currentFileRows.length) {
                checkbox.checked = false;
                return;
              }
              checkedOrder.push({ merchantId: option.merchantId, currency: option.currency, key });
            } else {
              checkedOrder = checkedOrder.filter((item) => item.key !== key);
            }
            syncOrderIndices();
            syncCheckboxDisabled();
          });

          item.append(checkbox, indexSpan, textSpan);
          orderListContainer.appendChild(item);
        });
        syncOrderIndices();
        syncCheckboxDisabled();
      }

      function syncOrderIndices() {
        orderListContainer.querySelectorAll('.big-account-order-item').forEach((item) => {
          const key = `${item.dataset.merchantId}@@${item.dataset.currency}`;
          const orderIdx = checkedOrder.findIndex((o) => o.key === key);
          const indexSpan = item.querySelector('.big-account-order-index');
          indexSpan.textContent = orderIdx >= 0 ? `${orderIdx + 1}.` : '';
        });
      }

      function syncCheckboxDisabled() {
        const maxReached = checkedOrder.length >= currentFileRows.length;
        orderListContainer.querySelectorAll('.big-account-order-checkbox').forEach((cb) => {
          cb.disabled = maxReached && !cb.checked;
        });
      }

      function syncModeUI() {
        currentFileRows = currentMode === 'fixed' ? rowsWithEmptyBlocks : rows;
        if (currentMode !== 'fixed') {
          rememberCheckbox.checked = false;
          rememberCheckbox.disabled = true;
          rememberLabel.classList.add('is-disabled');
        } else {
          rememberCheckbox.disabled = false;
          rememberLabel.classList.remove('is-disabled');
        }
        checkedOrder = [];
        searchInput.value = '';
        searchMatchIndex = -1;
        searchMatches = [];
        lastSearchQuery = '';
        renderFileList();
        renderOrderList();

        if (currentMode === 'fixed' && savedOrder && Array.isArray(savedOrder.assignments) && savedOrder.assignments.length) {
          rememberCheckbox.checked = true;
          applyPrefilledOrder(savedOrder.assignments);
        }
      }

      let savedOrder = null;

      function applyPrefilledOrder(assignments) {
        checkedOrder = [];
        assignments.forEach((a) => {
          const key = `${a.merchantId}@@${a.currency}`;
          const exists = expandedOptions.some((o) => o.merchantId === a.merchantId && o.currency === a.currency);
          if (exists && checkedOrder.length < currentFileRows.length) {
            checkedOrder.push({ merchantId: a.merchantId, currency: a.currency, key });
            const item = Array.from(orderListContainer.querySelectorAll('.big-account-order-item')).find(
              (el) => el.dataset.merchantId === a.merchantId && el.dataset.currency === a.currency
            );
            if (item) {
              item.querySelector('.big-account-order-checkbox').checked = true;
            }
          }
        });
        syncOrderIndices();
        syncCheckboxDisabled();
      }

      function setInteractive(enabled) {
        const interactiveElements = [modeSelect, searchInput, doneBtn];
        interactiveElements.forEach((el) => { el.disabled = !enabled; });
        orderListContainer.style.pointerEvents = enabled ? '' : 'none';
        orderListContainer.style.opacity = enabled ? '' : '0.5';
      }

      async function initializeState() {
        setInteractive(false);
        try {
          const modeResult = await desktopApi.bigAccount.loadMode(templateId);
          currentMode = modeResult.mode || 'unfixed';
          modeSelect.value = currentMode;

          const orderResult = await desktopApi.bigAccount.loadOrder(templateId);
          savedOrder = orderResult.order;
        } catch (_error) {}
        syncModeUI();
        setInteractive(true);
      }

      modeSelect.addEventListener('change', async () => {
        currentMode = modeSelect.value;
        await desktopApi.bigAccount.saveMode({ templateId, mode: currentMode });
        syncModeUI();
      });

      searchInput.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        const query = searchInput.value.trim().toLowerCase();
        if (!query) return;

        orderListContainer.querySelectorAll('.big-account-order-item.is-search-highlight').forEach((el) => {
          el.classList.remove('is-search-highlight');
        });

        searchMatches = Array.from(orderListContainer.querySelectorAll('.big-account-order-item')).filter((item) => {
          const text = (item.dataset.merchantId || '').toLowerCase();
          return text.includes(query);
        });

        if (!searchMatches.length) {
          searchInput.classList.add('is-flash-error');
          setTimeout(() => searchInput.classList.remove('is-flash-error'), 500);
          lastSearchQuery = query;
          return;
        }

        if (query !== lastSearchQuery) {
          searchMatchIndex = 0;
          lastSearchQuery = query;
        } else {
          searchMatchIndex = (searchMatchIndex + 1) % searchMatches.length;
        }
        const target = searchMatches[searchMatchIndex];
        target.classList.add('is-search-highlight');
        target.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      });

      dialog.querySelector('.icon-close').addEventListener('click', closeModal);
      doneBtn.addEventListener('click', async () => {
        if (checkedOrder.length !== currentFileRows.length) {
          setStatus(`请勾选 ${currentFileRows.length} 个大账号（当前已选 ${checkedOrder.length} 个）`, 'error');
          return;
        }

        const assignments = checkedOrder.map((item, index) => ({
          rowIndex: index,
          merchantId: item.merchantId,
          currency: item.currency
        }));

        if (currentMode === 'fixed' && rememberCheckbox.checked) {
          await desktopApi.bigAccount.saveOrder({ templateId, assignments });
        } else if (currentMode === 'fixed' && !rememberCheckbox.checked) {
          await desktopApi.bigAccount.saveOrder({ templateId, assignments: [] });
        }

        const result = await desktopApi.files.completeBigAccountSelection({
          assignments,
          mode: currentMode
        });

        if (result.status === 'error' && !result.manualBalancePromptReady) {
          if (result.errorCode === 'BIG_ACCOUNT_SELECTION_INVALID') {
            setStatus(result.message || '选择大账号失败，请重新设定', 'error');
            return;
          }
          closeModal();
          applyStatementResult(result);
          openModal(createAlertDialog(result.message));
          return;
        }

        closeModal();
        applyStatementResult(result);
      });

      initializeState();

      overlay.appendChild(dialog);
      return overlay;
    }

    function createBigAccountManagerDialog({ bigAccounts, templateId, templateName, initialOwnAccounts, onDone, onCancel }) {
      const overlay = createOverlay();
      const dialog = document.createElement('div');
      let pendingOwnAccounts = initialOwnAccounts || null;
      dialog.className = 'modal-card manager-card big-account-card';
      dialog.innerHTML = `
        <div class="dialog-header">
          <div class="dialog-title">维护大账号</div>
          <button class="icon-close" type="button">×</button>
        </div>
        <div class="table-wrapper">
          <table class="data-table">
            <thead>
              <tr>
                <th>大账号</th>
                <th>币种</th>
                <th class="manager-action-header"><span class="manager-action-header-label">执行操作</span></th>
              </tr>
            </thead>
            <tbody></tbody>
          </table>
        </div>
        <div class="dialog-actions split big-account-footer-actions">
          <div class="big-account-footer-left">
            <button class="secondary-btn small" type="button" data-action="add">新增</button>
            <button class="secondary-btn small" type="button" data-action="import-bank-info">导入银行账号信息</button>
            <button class="secondary-btn small" type="button" data-action="balance-management">余额管理</button>
          </div>
          <button class="primary-btn small" type="button" data-action="done">完成</button>
        </div>
      `;

      const tbody = dialog.querySelector('tbody');
      const tableWrapper = dialog.querySelector('.table-wrapper');
      const floatingPanel = document.createElement('div');
      floatingPanel.className = 'new-account-currency-dropdown-panel big-account-currency-floating-panel';
      floatingPanel.hidden = true;
      const currencyOptionEntries = getCurrencyOptionEntries();
      const currencySelectOptions = [
        '<option value=""></option>',
        ...currencyOptionEntries.map((currencyOption) => (
          `<option value="${escapeHtml(currencyOption.code)}">${escapeHtml(currencyOption.label)}</option>`
        ))
      ].join('');
      let activeFloatingDropdown = null;

      function cleanupFloatingDropdown() {
        if (activeFloatingDropdown?.button) {
          activeFloatingDropdown.button.classList.remove('is-open');
          activeFloatingDropdown.button.setAttribute('aria-expanded', 'false');
        }

        activeFloatingDropdown = null;
        floatingPanel.hidden = true;
        floatingPanel.replaceChildren();
      }

      function updateCurrencyDropdownLabel(button, currencies) {
        const selectedCurrencies = Array.from(new Set((currencies || []).filter((value) => value)));
        button.textContent = formatBigAccountCurrencySummary(selectedCurrencies) || '\u00A0';
        button.title = getBigAccountCurrencyTitle(selectedCurrencies);
        button.disabled = currencyOptionEntries.length === 0;
      }

      function renderCurrencyDropdownOptions(selectedCurrencies, onChange) {
        floatingPanel.replaceChildren();
        if (!currencyOptionEntries.length) {
          const emptyState = document.createElement('div');
          emptyState.className = 'new-account-currency-option';
          emptyState.innerHTML = '<span class="new-account-currency-option-text">未读取到币种选项</span>';
          floatingPanel.appendChild(emptyState);
          return;
        }

        currencyOptionEntries.forEach((currencyOption) => {
          const option = document.createElement('label');
          option.className = 'new-account-currency-option';

          const text = document.createElement('span');
          text.className = 'new-account-currency-option-text';
          text.textContent = currencyOption.label;

          const checkbox = document.createElement('input');
          checkbox.className = 'new-account-checkbox';
          checkbox.type = 'checkbox';
          checkbox.value = currencyOption.code;
          checkbox.checked = selectedCurrencies.includes(currencyOption.code);
          checkbox.addEventListener('change', () => {
            onChange(
              Array.from(floatingPanel.querySelectorAll('input[type="checkbox"]:checked')).map((selectedCheckbox) => selectedCheckbox.value)
            );
          });

          option.append(text, checkbox);
          floatingPanel.appendChild(option);
        });
      }

      function positionFloatingDropdown(button) {
        const buttonRect = button.getBoundingClientRect();
        const margin = 12;
        const availableWidth = Math.max(220, Math.min(260, window.innerWidth - margin * 2));

        floatingPanel.style.position = 'fixed';
        floatingPanel.style.minWidth = `${Math.max(buttonRect.width, 188)}px`;
        floatingPanel.style.maxWidth = `${availableWidth}px`;
        floatingPanel.style.visibility = 'hidden';
        floatingPanel.hidden = false;

        const panelWidth = floatingPanel.offsetWidth || Math.max(buttonRect.width, 188);
        const panelHeight = floatingPanel.offsetHeight || 216;
        const left = Math.min(
          Math.max(margin, buttonRect.left),
          Math.max(margin, window.innerWidth - panelWidth - margin)
        );
        const top = buttonRect.bottom + 6 + panelHeight > window.innerHeight - margin
          ? Math.max(margin, buttonRect.top - panelHeight - 6)
          : buttonRect.bottom + 6;

        floatingPanel.style.left = `${left}px`;
        floatingPanel.style.top = `${top}px`;
        floatingPanel.style.visibility = 'visible';
      }

      function openFloatingDropdown({ button, selectedCurrencies, onChange }) {
        const sameButton = activeFloatingDropdown?.button === button;
        cleanupFloatingDropdown();

        if (sameButton) {
          return;
        }

        renderCurrencyDropdownOptions(selectedCurrencies, onChange);
        activeFloatingDropdown = { button };
        button.classList.add('is-open');
        button.setAttribute('aria-expanded', 'true');
        positionFloatingDropdown(button);
      }

      function createBigAccountRow(item = {}, initialMode = 'view') {
        const row = document.createElement('tr');
        row.dataset.bigAccountRow = 'true';
        row.dataset.mode = initialMode;
        row.innerHTML = `
          <td>
            <input class="mapping-text-input big-account-merchant-input" type="text" spellcheck="false" value="${escapeHtml(item.merchantId || '')}" />
            <span class="big-account-view-text big-account-merchant-view" hidden></span>
          </td>
          <td>
            <div class="big-account-currency-editor">
              <div class="enum-input-shell big-account-currency-input-shell">
                <input class="new-account-input enum-ghost-input big-account-currency-ghost" type="text" tabindex="-1" disabled />
                <input class="new-account-input enum-active-input big-account-currency-input" type="text" spellcheck="false" />
              </div>
              <div class="new-account-currency-dropdown-wrap big-account-currency-dropdown-wrap" hidden>
                <button class="new-account-input new-account-currency-dropdown-btn big-account-currency-dropdown-btn" type="button" aria-expanded="false"></button>
              </div>
              <label class="new-account-checkbox-label big-account-multi-label">
                <input class="new-account-checkbox big-account-multi-checkbox" type="checkbox" />
                <span>多币种</span>
              </label>
            </div>
            <span class="big-account-view-text big-account-currency-view" hidden></span>
          </td>
          <td class="manager-action-cell big-account-action-cell">
            <div class="big-account-row-actions">
              <button class="text-action" type="button" data-action="toggle-complete"></button>
              <button class="text-action danger" type="button" data-action="delete">删除</button>
            </div>
          </td>
        `;

        const merchantInput = row.querySelector('.big-account-merchant-input');
        const merchantView = row.querySelector('.big-account-merchant-view');
        const currencyInput = row.querySelector('.big-account-currency-input');
        const currencyGhost = row.querySelector('.big-account-currency-ghost');
        const currencyInputShell = row.querySelector('.big-account-currency-input-shell');
        const dropdownWrap = row.querySelector('.big-account-currency-dropdown-wrap');
        const dropdownButton = row.querySelector('.big-account-currency-dropdown-btn');
        const multiCheckbox = row.querySelector('.big-account-multi-checkbox');
        const currencyEditor = row.querySelector('.big-account-currency-editor');
        const currencyView = row.querySelector('.big-account-currency-view');
        const toggleCompleteBtn = row.querySelector('[data-action="toggle-complete"]');
        let selectedCurrencies = Array.isArray(item.currencies) ? item.currencies.slice() : [];

        function renderCurrencyInputSuggestion() {
          const suggestion = getCurrencySuggestion(currencyInput.value);
          currencyGhost.value = suggestion;
          return suggestion;
        }

        multiCheckbox.checked = Boolean(item.isMultiCurrency);
        if (!multiCheckbox.checked) {
          currencyInput.value = selectedCurrencies[0] || '';
          renderCurrencyInputSuggestion();
        }

        function getRowDraft() {
          return {
            merchantId: merchantInput.value.trim(),
            isMultiCurrency: multiCheckbox.checked,
            currencies: multiCheckbox.checked
              ? Array.from(new Set(selectedCurrencies.filter((value) => value)))
              : [currencyInput.value.trim()].filter((value) => value !== '')
          };
        }

        function validateRowDraft() {
          const draft = getRowDraft();

          if (!draft.merchantId) {
            return '请填写大账号';
          }

          if (!draft.currencies.length) {
            return '请选择币种';
          }

          return '';
        }

        function syncCurrencyMode() {
          const isMultiCurrency = multiCheckbox.checked;
          currencyInputShell.hidden = isMultiCurrency;
          dropdownWrap.hidden = !isMultiCurrency;

          if (!isMultiCurrency) {
            if (activeFloatingDropdown?.button === dropdownButton) {
              cleanupFloatingDropdown();
            }
            renderCurrencyInputSuggestion();
            return;
          }

          updateCurrencyDropdownLabel(dropdownButton, selectedCurrencies);
        }

        dropdownButton.addEventListener('click', () => {
          if (dropdownWrap.hidden) {
            return;
          }

          openFloatingDropdown({
            button: dropdownButton,
            selectedCurrencies,
            onChange: (nextSelectedCurrencies) => {
              selectedCurrencies = nextSelectedCurrencies;
              updateCurrencyDropdownLabel(dropdownButton, selectedCurrencies);
            }
          });
        });
        multiCheckbox.addEventListener('change', syncCurrencyMode);
        currencyInput.addEventListener('input', () => {
          renderCurrencyInputSuggestion();
          if (row.dataset.mode === 'view') {
            return;
          }
          currencyView.textContent = currencyInput.value.trim();
          currencyView.title = currencyInput.value.trim();
        });
        currencyInput.addEventListener('keydown', (event) => {
          if (event.key === 'ArrowRight') {
            const suggestion = renderCurrencyInputSuggestion();
            const currentValue = String(currencyInput.value || '');
            if (suggestion && suggestion !== currentValue && suggestion.toUpperCase().startsWith(currentValue.trim().toUpperCase())) {
              currencyInput.value = suggestion;
              renderCurrencyInputSuggestion();
              event.preventDefault();
            }
          }
        });
        merchantInput.addEventListener('input', () => {
          if (row.dataset.mode === 'view') {
            return;
          }

          merchantView.textContent = merchantInput.value.trim();
          merchantView.title = merchantInput.value.trim();
        });
        toggleCompleteBtn.addEventListener('click', () => {
          if (row.dataset.mode === 'edit') {
            if (!multiCheckbox.checked && currencyInput) {
              currencyInput.value = currencyInput.value.trim().toUpperCase();
              renderCurrencyInputSuggestion();
            }
            const validationMessage = validateRowDraft();

            if (validationMessage) {
              setStatus(validationMessage, 'error');
              return;
            }

            const draft = getRowDraft();
            merchantView.textContent = draft.merchantId;
            merchantView.title = draft.merchantId;
            currencyView.textContent = formatBigAccountCurrencySummary(draft.currencies);
            currencyView.title = getBigAccountCurrencyTitle(draft.currencies);
            merchantInput.hidden = true;
            currencyEditor.hidden = true;
            merchantView.hidden = false;
            currencyView.hidden = false;
            row.dataset.mode = 'view';
            toggleCompleteBtn.textContent = '修改';
            if (activeFloatingDropdown?.button === dropdownButton) {
              cleanupFloatingDropdown();
            }
            return;
          }

          row.dataset.mode = 'edit';
          merchantInput.hidden = false;
          currencyEditor.hidden = false;
          merchantView.hidden = true;
          currencyView.hidden = true;
          toggleCompleteBtn.textContent = '完成';
          syncCurrencyMode();
        });
        row.querySelector('[data-action="delete"]').addEventListener('click', () => {
          if (activeFloatingDropdown?.button === dropdownButton) {
            cleanupFloatingDropdown();
          }
          row.remove();
        });

        syncCurrencyMode();

        if (initialMode === 'view') {
          const initialDraft = getRowDraft();
          merchantView.textContent = initialDraft.merchantId;
          merchantView.title = initialDraft.merchantId;
          currencyView.textContent = formatBigAccountCurrencySummary(initialDraft.currencies);
          currencyView.title = getBigAccountCurrencyTitle(initialDraft.currencies);
          merchantInput.hidden = true;
          currencyEditor.hidden = true;
          merchantView.hidden = false;
          currencyView.hidden = false;
          toggleCompleteBtn.textContent = '修改';
        } else {
          merchantInput.hidden = false;
          currencyEditor.hidden = false;
          merchantView.hidden = true;
          currencyView.hidden = true;
          toggleCompleteBtn.textContent = '完成';
        }

        return row;
      }

      const initialBigAccounts = bigAccounts.length
        ? bigAccounts
        : [{ merchantId: '', currencies: [], isMultiCurrency: false }];
      initialBigAccounts.forEach((item) => {
        tbody.appendChild(createBigAccountRow(item, bigAccounts.length ? 'view' : 'edit'));
      });

      const handleKeydown = (event) => {
        if (event.key === 'Escape' && !floatingPanel.hidden) {
          cleanupFloatingDropdown();
        }
      };

      document.addEventListener('keydown', handleKeydown);
      overlay.addEventListener('mousedown', (event) => {
        if (
          activeFloatingDropdown &&
          !floatingPanel.contains(event.target) &&
          !activeFloatingDropdown.button.contains(event.target)
        ) {
          cleanupFloatingDropdown();
        }
      });
      tableWrapper.addEventListener('scroll', cleanupFloatingDropdown);

      function cleanupAndCancel() {
        cleanupFloatingDropdown();
        document.removeEventListener('keydown', handleKeydown);
        onCancel();
      }

      dialog.querySelector('.icon-close').addEventListener('click', cleanupAndCancel);
      dialog.querySelector('[data-action="add"]').addEventListener('click', () => {
        cleanupFloatingDropdown();
        tbody.appendChild(createBigAccountRow({}, 'edit'));
      });
      dialog.querySelector('[data-action="import-bank-info"]').addEventListener('click', async () => {
        cleanupFloatingDropdown();
        if (!templateId) {
          setStatus('请先选择模板', 'error');
          return;
        }
        const result = await window.desktopApi.bigAccount.importBankInfo(templateId);
        if (result.status === 'cancelled') return;
        if (result.status === 'error') {
          setStatus(result.message, 'error');
          return;
        }
        pendingOwnAccounts = result.ownAccounts || [];
        tbody.innerHTML = '';
        const clientAccounts = result.clientAccounts || [];
        if (clientAccounts.length === 0) {
          tbody.appendChild(createBigAccountRow({}, 'edit'));
        } else {
          clientAccounts.forEach((item) => {
            tbody.appendChild(createBigAccountRow(item, 'view'));
          });
        }
        setStatus(result.message, 'success');
      });
      dialog.querySelector('[data-action="balance-management"]').addEventListener('click', async () => {
        cleanupFloatingDropdown();
        if (!templateName || !templateId) {
          setStatus('请先选择模板', 'error');
          return;
        }
        let bigAccountSnapshot;
        try {
          const mappingResult = await desktopApi.templates.getMappings(templateId);
          bigAccountSnapshot = Array.isArray(mappingResult?.bigAccounts) ? mappingResult.bigAccounts : [];
        } catch (_error) {
          bigAccountSnapshot = [];
        }
        if (!bigAccountSnapshot.length) {
          setStatus('请先保存大账号配置后再使用余额管理', 'error');
          return;
        }
        openModal(createBalanceAddonManagerDialog({
          templateName,
          bigAccounts: bigAccountSnapshot,
          onClose: () => {
            openModal(createBigAccountManagerDialog({
              bigAccounts: cloneBigAccountItems(
                Array.from(tbody.querySelectorAll('tr[data-big-account-row]'))
                  .filter((r) => r.dataset.mode === 'view')
                  .map((r) => {
                    const mid = r.querySelector('.big-account-merchant-view')?.textContent?.trim() || '';
                    const isMC = r.querySelector('.big-account-multi-checkbox')?.checked || false;
                    const cText = r.querySelector('.big-account-currency-view')?.title || '';
                    const cs = isMC ? cText.split('、').filter(Boolean) : [cText].filter(Boolean);
                    return { merchantId: mid, currencies: cs, isMultiCurrency: isMC };
                  })
                  .filter((i) => i.merchantId)
              ),
              templateId,
              templateName,
              initialOwnAccounts: pendingOwnAccounts,
              onDone,
              onCancel
            }));
          }
        }));
      });
      dialog.querySelector('[data-action="done"]').addEventListener('click', () => {
        const rows = Array.from(tbody.querySelectorAll('tr[data-big-account-row]'));

        if (rows.some((row) => row.dataset.mode === 'edit')) {
          setStatus('请先完成或删除当前编辑行', 'error');
          return;
        }

        const nextBigAccounts = rows.map((row) => {
          const merchantId = row.querySelector('.big-account-merchant-input').value.trim();
          const isMultiCurrency = row.querySelector('.big-account-multi-checkbox').checked;
          const currencies = isMultiCurrency
            ? Array.from(new Set(row.querySelector('.big-account-currency-view').title.split('、').filter((value) => value)))
            : [row.querySelector('.big-account-currency-input').value.trim()].filter((value) => value !== '');

          return {
            merchantId,
            currencies,
            isMultiCurrency
          };
        }).filter((item) => item.merchantId !== '' && item.currencies.length > 0);

        cleanupFloatingDropdown();
        document.removeEventListener('keydown', handleKeydown);
        onDone(nextBigAccounts, { ownAccounts: pendingOwnAccounts });
      });

      overlay.appendChild(dialog);
      overlay.appendChild(floatingPanel);
      return overlay;
    }

    function renderTemplateTableRows(tableBody) {
      tableBody.innerHTML = '';

      if (!state.templates.length) {
        const emptyRow = document.createElement('tr');
        emptyRow.innerHTML = `
          <td class="empty-cell">暂无模板</td>
          <td class="empty-cell">-</td>
          <td class="empty-cell">-</td>
        `;
        tableBody.appendChild(emptyRow);
        return;
      }

      state.templates.forEach((template) => {
        const bigAccountSummary = template.bigAccountSummary || '未设置';
        const row = document.createElement('tr');
        row.innerHTML = `
          <td>${template.name}</td>
          <td class="manager-big-account-cell">
            <span class="manager-big-account-summary" title="${escapeHtml(bigAccountSummary)}">${escapeHtml(bigAccountSummary)}</span>
          </td>
          <td class="manager-action-cell">
            <div class="manager-row-actions">
              <button class="text-action" type="button" data-action="manage">修改</button>
              <button class="text-action" type="button" data-action="rename">重命名</button>
              <button class="text-action danger" type="button" data-action="delete">删除</button>
            </div>
          </td>
        `;

        row.querySelector('[data-action="manage"]').addEventListener('click', async () => {
          const result = await desktopApi.templates.getMappings(template.id);

          if (result.status !== 'success') {
            setStatus(result.message, 'error', {
              errorReportReady: Boolean(result.errorReportReady)
            });
            openModal(createAlertDialog(result.message));
            return;
          }

          openModal(createMappingDialog(result));
        });
        row.querySelector('[data-action="rename"]').addEventListener('click', () => {
          openModal(createTemplateRenameDialog(template));
        });
        row.querySelector('[data-action="delete"]').addEventListener('click', () => {
          openModal(
            createConfirmDialog({
              message: '确认删除',
              confirmText: '确认删除',
              cancelText: '否',
              onConfirm: async () => {
                await desktopApi.templates.deleteTemplate(template.id);
                await refreshTemplates();
                openModal(createTemplateManagerDialog());
              }
            })
          );
        });

        tableBody.appendChild(row);
      });
    }

    function createTemplateManagerDialog() {
      const overlay = createOverlay();
      const dialog = document.createElement('div');
      dialog.className = 'modal-card manager-card';
      dialog.innerHTML = `
        <div class="dialog-header compact">
          <button class="icon-close" type="button">×</button>
        </div>
        <div class="table-wrapper">
          <table class="data-table">
            <thead>
              <tr>
                <th>模板名称</th>
                <th>大账号</th>
                <th class="manager-action-header"><span class="manager-action-header-label">执行操作</span></th>
              </tr>
            </thead>
            <tbody></tbody>
          </table>
        </div>
        <div class="dialog-actions right template-manager-bundle-actions">
          <button class="secondary-btn small" type="button" data-action="import-bundle">导入模板文件</button>
          <button class="secondary-btn small" type="button" data-action="export-bundle">导出模板文件</button>
        </div>
      `;

      dialog.querySelector('.icon-close').addEventListener('click', closeModal);
      dialog.querySelector('[data-action="import-bundle"]').addEventListener('click', async () => {
        const result = await desktopApi.templates.importBundle();

        if (result.status === 'cancelled') {
          return;
        }

        setStatus(result.message, result.status === 'success' ? 'success' : 'error', {
          errorReportReady: Boolean(result.errorReportReady)
        });

        if (result.status === 'success') {
          await refreshTemplates();
          openModal(createTemplateManagerDialog());
          return;
        }

        openModal(createAlertDialog(result.message));
      });
      dialog.querySelector('[data-action="export-bundle"]').addEventListener('click', async () => {
        const result = await desktopApi.templates.exportBundle();

        if (result.status === 'cancelled') {
          return;
        }

        setStatus(result.message, result.status === 'success' ? 'success' : 'error', {
          errorReportReady: Boolean(result.errorReportReady)
        });

        if (result.status !== 'success') {
          openModal(createAlertDialog(result.message));
        }
      });
      renderTemplateTableRows(dialog.querySelector('tbody'));
      overlay.appendChild(dialog);
      return overlay;
    }

    function createMappingDialog(payload) {
      const overlay = createOverlay();
      const dialog = document.createElement('div');
      const advancedMappingFields = Array.isArray(payload.advancedMappingFields) && payload.advancedMappingFields.length
        ? payload.advancedMappingFields
        : ADVANCED_MAPPING_FIELDS;
      const billSplitGroupFields = Array.isArray(payload.billSplitGroupFields) && payload.billSplitGroupFields.length
        ? payload.billSplitGroupFields
        : ['是否拆分/合并明细账单', '复用模块字段的映射关系'];
      const BILL_SPLIT_MERGE_FIELD = '是否拆分/合并明细账单';
      const REUSE_MODULE_FIELD = '复用模块字段的映射关系';
      const currentBigAccounts = cloneBigAccountItems(payload.bigAccounts || []);
      const currentFixedAssignments = Array.isArray(payload.fixedAssignments)
        ? payload.fixedAssignments.map((item) => ({
            merchantId: String(item.merchantId || ''),
            currency: String(item.currency || ''),
            rowIndex: Number(item.rowIndex || 0)
          }))
        : [];
      let currentAmountSplitRules = Array.isArray(payload.amountSplitRules)
        ? payload.amountSplitRules.map((rule) => ({
            targetField: String(rule.targetField || ''),
            conditionField: String(rule.conditionField || ''),
            conditionValue: String(rule.conditionValue || ''),
            mappedField: String(rule.mappedField || ''),
            rowIndex: Number(rule.rowIndex || 0)
          }))
        : [];
      let currentBillSplitMappings = Array.isArray(payload.billSplitMappings)
        ? payload.billSplitMappings.map((m) => ({
            templateField: String(m.templateField || ''),
            mappedField: String(m.mappedField || ''),
            mappedFields: Array.isArray(m.mappedFields) ? m.mappedFields.slice() : [],
            rowIndex: Number(m.rowIndex || 0)
          }))
        : [];
      let currentBillSplitRows = Array.isArray(payload.billSplitRows)
        ? payload.billSplitRows.map((r) => ({ ...r }))
        : [];
      let currentBillSplitAmountRules = Array.isArray(payload.billSplitAmountRules)
        ? payload.billSplitAmountRules.map((rule) => ({ ...rule }))
        : [];
      let currentBillSplitMeta = payload.billSplitMeta && typeof payload.billSplitMeta === 'object'
        ? { signedAmountSourceField: String(payload.billSplitMeta.signedAmountSourceField || '') }
        : { signedAmountSourceField: '' };
      dialog.className = 'modal-card mapping-card';
      dialog.innerHTML = `
        <div class="dialog-header">
          <div class="dialog-title">映射关系管理</div>
          <button class="icon-close" type="button">×</button>
        </div>
        <div class="table-wrapper mapping-wrapper">
          <table class="data-table">
            <thead>
              <tr>
                <th>模板字段</th>
                <th>映射字段</th>
              </tr>
            </thead>
            <tbody></tbody>
          </table>
        </div>
        <div class="dialog-actions right">
          <button class="primary-btn small" type="button" data-action="done">完成</button>
        </div>
      `;

      const tbody = dialog.querySelector('tbody');
      const rowByField = new Map();
      const savedMap = new Map(payload.mappings.map((item) => [item.templateField, item]));
      const headerOptions = payload.template.headers.map((header) => {
        const escapedHeader = escapeHtml(header || '(空白字段)');
        const value = escapeHtml(header);
        return `<option value="${value}">${escapedHeader}</option>`;
      });

      payload.targetFields.forEach((fieldName) => {
        if (fieldName === advancedMappingFields[0]) {
          const sectionRow = document.createElement('tr');
          sectionRow.className = 'mapping-section-row';
          sectionRow.innerHTML = '<td colspan="2"><strong>映射关系设置</strong></td>';
          tbody.appendChild(sectionRow);
        }

        if (fieldName === billSplitGroupFields[0]) {
          const sectionRow = document.createElement('tr');
          sectionRow.className = 'mapping-section-row';
          sectionRow.innerHTML = '<td colspan="2"><strong>账单拆分合并管理</strong></td>';
          tbody.appendChild(sectionRow);
        }

        if (billSplitGroupFields.includes(fieldName)) {
          renderBillSplitGroupRow(fieldName);
          return;
        }

        const row = document.createElement('tr');
        row.dataset.templateField = fieldName;
        const isBalanceField = fieldName === 'Balance';
        const isMerchantIdField = fieldName === 'MerchantId';
        const isAdvancedField = advancedMappingFields.includes(fieldName);
        const isAmountSplitByFieldField = fieldName === AMOUNT_SPLIT_BY_FIELD_MAPPING_FIELD;
        const supportsSelfInputOption = isMerchantIdField;
        const isCurrencyField = fieldName === 'Currency';
        const supportsMultiSelect = !isBalanceField && !supportsSelfInputOption && !isAdvancedField && !isCurrencyField;
        const savedMapping = savedMap.get(fieldName) || {
          mappedField: isBalanceField ? BALANCE_DISABLED_OPTION : '',
          mappedFields: [],
          customValue: '',
          isMultiBigAccount: false
        };
        let selectOptions;
        if (isAmountSplitByFieldField) {
          selectOptions = `<option value=""></option><option value="${AMOUNT_SPLIT_BY_FIELD_ENABLED_OPTION}">${AMOUNT_SPLIT_BY_FIELD_ENABLED_OPTION}</option>`;
        } else {
          selectOptions = [isBalanceField ? `<option value="${BALANCE_DISABLED_OPTION}">${BALANCE_DISABLED_OPTION}</option>` : '<option value=""></option>']
            .concat(isBalanceField ? [`<option value="${BALANCE_CALCULATED_OPTION}">${BALANCE_CALCULATED_OPTION}</option>`] : [])
            .concat(supportsSelfInputOption ? [`<option value="${MERCHANT_ID_SELF_INPUT_OPTION}">${MERCHANT_ID_SELF_INPUT_OPTION}</option>`] : [])
            .concat(supportsMultiSelect ? [`<option value="${CONCAT_FIELDS_MAPPING_FIELD}">${CONCAT_FIELDS_MAPPING_FIELD}</option>`] : [])
            .concat(headerOptions)
            .join('');
        }
        row.innerHTML = `
          <td>${escapeHtml(fieldName)}</td>
          <td>
            <div class="mapping-field-editor">
              <select class="mapping-select">${selectOptions}</select>
              ${isMerchantIdField ? `
                <button class="secondary-btn small mapping-big-account-manage-btn" type="button" hidden>维护大账号</button>
              ` : ''}
              ${isAmountSplitByFieldField ? `
                <button class="secondary-btn small mapping-amount-split-manage-btn" type="button" hidden>维护发生额映射关系</button>
              ` : ''}
              ${supportsMultiSelect ? `
                <div class="concat-field-picker" hidden>
                  <button class="concat-picker-trigger secondary-btn small" type="button">选择字段</button>
                  <div class="concat-picker-panel" hidden></div>
                  <div class="concat-preview-wrapper">
                    <span class="concat-order-label">当前拼接顺序：</span>
                    <span class="concat-preview" title=""></span>
                  </div>
                </div>
              ` : ''}
            </div>
          </td>
        `;

        const select = row.querySelector('.mapping-select');
        const manageBigAccountBtn = row.querySelector('.mapping-big-account-manage-btn');
        const manageAmountSplitBtn = row.querySelector('.mapping-amount-split-manage-btn');
        const concatFieldPicker = row.querySelector('.concat-field-picker');
        const concatPickerTrigger = row.querySelector('.concat-picker-trigger');
        const concatPickerPanel = row.querySelector('.concat-picker-panel');
        const concatPreview = row.querySelector('.concat-preview');
        let concatSelectedFields = [];
        const savedFields = Array.isArray(savedMapping.mappedFields) && savedMapping.mappedFields.length
          ? savedMapping.mappedFields
          : (savedMapping.mappedField ? [savedMapping.mappedField] : []);
        const isSavedConcatMode = savedMapping.mappedField === CONCAT_FIELDS_MAPPING_FIELD;

        if (isSavedConcatMode && supportsMultiSelect) {
          select.value = CONCAT_FIELDS_MAPPING_FIELD;
          concatSelectedFields = Array.isArray(savedMapping.mappedFields) ? savedMapping.mappedFields.slice() : [];
        } else if (isSavedConcatMode && !supportsMultiSelect) {
          // Legacy concat config on a field that no longer supports concat UI
          // (e.g. Currency after 1.4.7 removed concat support). Preserve the
          // original mappedFields in dataset so collectMappingDraftFromTable
          // can restore them unless the user explicitly picks a new value.
          row.dataset.legacyConcatMode = 'true';
          row.dataset.legacyConcatFields = JSON.stringify(
            Array.isArray(savedMapping.mappedFields) ? savedMapping.mappedFields : []
          );
          select.value = '';
        } else {
          select.value = savedMapping.mappedField || (isBalanceField ? BALANCE_DISABLED_OPTION : '');
        }

        function updateConcatPreview() {
          if (!concatPreview) return;
          const previewText = concatSelectedFields.join(' ');
          concatPreview.textContent = previewText.length > 40 ? previewText.slice(0, 40) + '......' : previewText;
          concatPreview.title = concatSelectedFields.join(' ');
          row.dataset.concatFields = JSON.stringify(concatSelectedFields);
        }

        function renderConcatPanel() {
          if (!concatPickerPanel) return;
          concatPickerPanel.replaceChildren();
          const headers = payload.template.headers || [];
          headers.forEach((header) => {
            const option = document.createElement('div');
            option.className = 'concat-picker-option';
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.checked = concatSelectedFields.includes(header);
            const indexSpan = document.createElement('span');
            indexSpan.className = 'concat-picker-index';
            const selectedIdx = concatSelectedFields.indexOf(header);
            indexSpan.textContent = selectedIdx >= 0 ? `${selectedIdx + 1}.` : '';
            const nameSpan = document.createElement('span');
            nameSpan.textContent = header;
            option.append(checkbox, indexSpan, nameSpan);
            option.addEventListener('click', (event) => {
              if (event.target === checkbox) return;
              checkbox.checked = !checkbox.checked;
              checkbox.dispatchEvent(new Event('change'));
            });
            checkbox.addEventListener('change', () => {
              if (checkbox.checked) {
                if (!concatSelectedFields.includes(header)) {
                  concatSelectedFields.push(header);
                }
              } else {
                concatSelectedFields = concatSelectedFields.filter((f) => f !== header);
              }
              renderConcatPanel();
              updateConcatPreview();
            });
            concatPickerPanel.appendChild(option);
          });
        }

        if (concatPickerTrigger) {
          concatPickerTrigger.addEventListener('click', () => {
            const isOpen = !concatPickerPanel.hidden;
            concatPickerPanel.hidden = isOpen;
            if (!isOpen) {
              renderConcatPanel();
            }
          });
        }

        if (isSavedConcatMode) {
          row.dataset.concatFields = JSON.stringify(concatSelectedFields);
          updateConcatPreview();
        }

        function syncEditorState() {
          const selectedValue = getSelectValues(select)[0];
          const isCustomInput = selectedValue === MERCHANT_ID_SELF_INPUT_OPTION;
          const isConcatMode = selectedValue === CONCAT_FIELDS_MAPPING_FIELD;
          const isAmountSplitEnabled = isAmountSplitByFieldField
            && selectedValue === AMOUNT_SPLIT_BY_FIELD_ENABLED_OPTION;

          if (manageBigAccountBtn) {
            manageBigAccountBtn.hidden = !isCustomInput;
          }
          if (manageAmountSplitBtn) {
            manageAmountSplitBtn.hidden = !isAmountSplitEnabled;
          }
          if (concatFieldPicker) {
            concatFieldPicker.hidden = !isConcatMode;
            if (!isConcatMode) {
              concatSelectedFields = [];
              updateConcatPreview();
              if (concatPickerPanel) concatPickerPanel.hidden = true;
            }
          }
        }

        if (manageBigAccountBtn) {
          manageBigAccountBtn.addEventListener('click', () => {
            const draftMappings = collectMappingDraftFromTable(tbody);
            openModal(createBigAccountManagerDialog({
              bigAccounts: currentBigAccounts,
              templateId: payload.template.id,
              templateName: payload.template.name,
              onDone: async (nextBigAccounts, extra) => {
                if (extra && extra.ownAccounts) {
                  const ownResult = await window.desktopApi.bigAccount.saveOwnAccounts({
                    templateId: payload.template.id,
                    accounts: extra.ownAccounts
                  });
                  if (ownResult.status === 'error') {
                    setStatus(ownResult.message || '自有账号保存失败', 'error');
                    return;
                  }
                }
                openModal(createMappingDialog({
                  ...payload,
                  mappings: draftMappings.map((mapping) => {
                    return mapping.templateField === 'MerchantId'
                      ? { ...mapping, mappedField: MERCHANT_ID_SELF_INPUT_OPTION, mappedFields: [] }
                      : mapping;
                  }),
                  bigAccounts: nextBigAccounts,
                  fixedAssignments: currentFixedAssignments,
                  amountSplitRules: currentAmountSplitRules
                }));
              },
              onCancel: () => {
                openModal(createMappingDialog({
                  ...payload,
                  mappings: draftMappings,
                  bigAccounts: currentBigAccounts,
                  fixedAssignments: currentFixedAssignments,
                  amountSplitRules: currentAmountSplitRules
                }));
              }
            }));
          });
        }

        if (manageAmountSplitBtn) {
          manageAmountSplitBtn.addEventListener('click', async () => {
            await openAmountSplitRulesDialog();
          });
        }

        select.addEventListener('change', () => {
          // User explicitly changed the mapping — drop any legacy concat
          // preservation so the new selection (including an empty one) wins.
          delete row.dataset.legacyConcatMode;
          delete row.dataset.legacyConcatFields;
          syncEditorState();
          applyAmountSplitMutualExclusion();
        });
        syncEditorState();
        rowByField.set(fieldName, row);
        tbody.appendChild(row);
      });

      function renderBillSplitGroupRow(fieldName) {
        const row = document.createElement('tr');
        row.dataset.templateField = fieldName;
        row.dataset.billSplitGroupField = 'true';

        // 默认值：BILL_SPLIT_MERGE_FIELD 默认 '否'（存为空字符串 ''），REUSE_MODULE_FIELD 默认 '是'
        const savedMapping = savedMap.get(fieldName) || {
          mappedField: fieldName === REUSE_MODULE_FIELD ? '是' : '',
          mappedFields: []
        };
        let savedValue = String(savedMapping.mappedField || '');
        if (fieldName === BILL_SPLIT_MERGE_FIELD) {
          // 存为 '是' 或 ''，UI 显示为 '是' 或 '否'
          savedValue = savedValue === '是' ? '是' : '';
        } else if (fieldName === REUSE_MODULE_FIELD) {
          savedValue = savedValue === '否' ? '否' : '是';
        }

        let buttonLabel = '';
        if (fieldName === BILL_SPLIT_MERGE_FIELD && savedValue === '是') {
          buttonLabel = '拆分/合并账单映射关系管理';
        } else if (fieldName === REUSE_MODULE_FIELD && savedValue === '否') {
          buttonLabel = '拆分/合并账单映射关系设置';
        }

        const selectOptions = fieldName === BILL_SPLIT_MERGE_FIELD
          ? '<option value="">否</option><option value="是">是</option>'
          : '<option value="是">是</option><option value="否">否</option>';

        row.innerHTML = `
          <td>${escapeHtml(fieldName)}</td>
          <td>
            <div class="mapping-field-editor">
              <select class="mapping-select bill-split-group-select">${selectOptions}</select>
              <button class="secondary-btn small bill-split-group-btn" type="button" ${buttonLabel ? '' : 'hidden'}>${buttonLabel || ''}</button>
            </div>
          </td>
        `;

        const select = row.querySelector('.mapping-select');
        const button = row.querySelector('.bill-split-group-btn');
        select.value = savedValue;

        select.addEventListener('change', () => {
          const newValue = select.value;
          if (fieldName === BILL_SPLIT_MERGE_FIELD) {
            if (newValue === '是') {
              button.hidden = false;
              button.textContent = '拆分/合并账单映射关系管理';
              applyBillSplitMergeMutualExclusion(true);
            } else {
              button.hidden = true;
              button.textContent = '';
              applyBillSplitMergeMutualExclusion(false);
            }
          } else if (fieldName === REUSE_MODULE_FIELD) {
            if (newValue === '否') {
              button.hidden = false;
              button.textContent = '拆分/合并账单映射关系设置';
            } else {
              button.hidden = true;
              button.textContent = '';
            }
          }
        });

        button.addEventListener('click', () => {
          if (fieldName === BILL_SPLIT_MERGE_FIELD) {
            openBillSplitRowsDialogFromMain();
          } else if (fieldName === REUSE_MODULE_FIELD) {
            openBillSplitMappingsDialogFromMain();
          }
        });

        rowByField.set(fieldName, row);
        tbody.appendChild(row);
      }

      function openBillSplitRowsDialogFromMain() {
        const draftBigAccounts = cloneBigAccountItems(currentBigAccounts);
        const draftMappings = collectMappingDraftFromTable(tbody);
        openModal(createBillSplitRowsDialog({
          template: payload.template,
          initialRows: currentBillSplitRows,
          initialAmountRules: currentBillSplitAmountRules,
          initialBillSplitMeta: currentBillSplitMeta,
          onClose: async () => {
            // Re-read the latest bill-split config from DB (行级落库保证一致)
            try {
              const latest = await desktopApi.templates.getBillSplitConfig(payload.template.id);
              if (latest && latest.status === 'success') {
                currentBillSplitRows = latest.billSplitRows || [];
                currentBillSplitAmountRules = latest.billSplitAmountRules || [];
                currentBillSplitMeta = latest.billSplitMeta || { signedAmountSourceField: '' };
              }
            } catch (_error) { /* ignore */ }
            openModal(createMappingDialog({
              ...payload,
              mappings: draftMappings,
              bigAccounts: draftBigAccounts,
              fixedAssignments: currentFixedAssignments,
              amountSplitRules: currentAmountSplitRules,
              billSplitMappings: currentBillSplitMappings,
              billSplitRows: currentBillSplitRows,
              billSplitAmountRules: currentBillSplitAmountRules,
              billSplitMeta: currentBillSplitMeta
            }));
          }
        }));
      }

      function openBillSplitMappingsDialogFromMain() {
        const draftBigAccounts = cloneBigAccountItems(currentBigAccounts);
        const draftMappings = collectMappingDraftFromTable(tbody);
        openModal(createBillSplitMappingsDialog({
          template: payload.template,
          initialMappings: currentBillSplitMappings,
          mainTemplateMappings: draftMappings,
          headers: payload.template.headers || [],
          targetFields: (payload.targetFields || []).slice(),
          advancedMappingFields: advancedMappingFields.slice(),
          billSplitGroupFields: billSplitGroupFields.slice(),
          onDone: (nextMappings) => {
            currentBillSplitMappings = nextMappings.map((m) => ({ ...m }));
            openModal(createMappingDialog({
              ...payload,
              mappings: draftMappings,
              bigAccounts: draftBigAccounts,
              fixedAssignments: currentFixedAssignments,
              amountSplitRules: currentAmountSplitRules,
              billSplitMappings: currentBillSplitMappings,
              billSplitRows: currentBillSplitRows,
              billSplitAmountRules: currentBillSplitAmountRules,
              billSplitMeta: currentBillSplitMeta
            }));
          },
          onCancel: () => {
            openModal(createMappingDialog({
              ...payload,
              mappings: draftMappings,
              bigAccounts: draftBigAccounts,
              fixedAssignments: currentFixedAssignments,
              amountSplitRules: currentAmountSplitRules,
              billSplitMappings: currentBillSplitMappings,
              billSplitRows: currentBillSplitRows,
              billSplitAmountRules: currentBillSplitAmountRules,
              billSplitMeta: currentBillSplitMeta
            }));
          }
        }));
      }

      function applyAmountSplitMutualExclusion() {
        const amountSplitRow = rowByField.get(AMOUNT_SPLIT_BY_FIELD_MAPPING_FIELD);
        const amountSplitSelect = amountSplitRow?.querySelector('.mapping-select');
        const amountSplitEnabled = amountSplitSelect
          && getSelectValues(amountSplitSelect)[0] === AMOUNT_SPLIT_BY_FIELD_ENABLED_OPTION;

        const mutexTargetFields = ['Credit Amount', 'Debit Amount', '按正负号拆分的发生额'];

        mutexTargetFields.forEach((targetField) => {
          const targetRow = rowByField.get(targetField);
          if (!targetRow) return;
          const targetSelect = targetRow.querySelector('.mapping-select');
          if (!targetSelect) return;

          if (amountSplitEnabled) {
            targetRow.classList.add('mapping-row-mutex-disabled');
            targetSelect.value = '';
            targetSelect.disabled = true;
          } else {
            targetRow.classList.remove('mapping-row-mutex-disabled');
            targetSelect.disabled = false;
          }
        });

        // 「按字段区分发生额」字段始终可点击。当用户选「是」时，上面的 forward
        // 互斥逻辑会自动清空 + disable 另外三行（Credit Amount / Debit Amount /
        // 按正负号拆分的发生额）。不应根据"另外三行已配置"反向锁定本字段，
        // 否则会让旧模板用户根本无法切换到新功能。
        if (amountSplitRow) {
          amountSplitRow.classList.remove('mapping-row-mutex-disabled');
          if (amountSplitSelect) {
            amountSplitSelect.disabled = false;
          }
        }
      }

      // v1.4.9: 4 方互斥 UI 侧 — 开启「是否拆分/合并明细账单」时 disabled + 清空其它 5 行
      // Currency / Credit Amount / Debit Amount / 按正负号拆分的发生额 / 按字段区分发生额
      function applyBillSplitMergeMutualExclusion(enabled) {
        const mutexFields = [
          'Currency',
          'Credit Amount',
          'Debit Amount',
          '按正负号拆分的发生额',
          '按字段区分发生额'
        ];
        mutexFields.forEach((targetField) => {
          const targetRow = rowByField.get(targetField);
          if (!targetRow) return;
          const targetSelect = targetRow.querySelector('.mapping-select');
          if (!targetSelect) return;

          if (enabled) {
            targetSelect.value = '';
            targetSelect.disabled = true;
            targetRow.classList.add('mapping-row-mutex-disabled', 'bill-split-merge-disabled');
            targetRow.setAttribute('title', '已开启拆分/合并明细账单，本字段不可用');
          } else {
            targetSelect.disabled = false;
            targetRow.classList.remove('bill-split-merge-disabled');
            targetRow.removeAttribute('title');
            // 若 amount split 仍启用，保留 mutex-disabled class（由 applyAmountSplitMutualExclusion 管理）
            if (!targetRow.classList.contains('bill-split-merge-disabled')) {
              // re-evaluate amount split mutex
            }
          }
        });
        // 重新评估 amount split 互斥，保证 disabled 状态正确
        applyAmountSplitMutualExclusion();
      }

      async function openAmountSplitRulesDialog() {
        const draftBigAccounts = cloneBigAccountItems(currentBigAccounts);
        const draftMappings = collectMappingDraftFromTable(tbody);
        openModal(createAmountSplitRulesDialog({
          template: payload.template,
          initialRules: currentAmountSplitRules,
          onDone: (nextRules) => {
            currentAmountSplitRules = nextRules.map((rule) => ({ ...rule }));
            openModal(createMappingDialog({
              ...payload,
              mappings: draftMappings,
              bigAccounts: draftBigAccounts,
              fixedAssignments: currentFixedAssignments,
              amountSplitRules: currentAmountSplitRules
            }));
          },
          onCancel: () => {
            openModal(createMappingDialog({
              ...payload,
              mappings: draftMappings,
              bigAccounts: draftBigAccounts,
              fixedAssignments: currentFixedAssignments,
              amountSplitRules: currentAmountSplitRules
            }));
          }
        }));
      }

      applyAmountSplitMutualExclusion();

      // 初始化：若模板当前已启用「是否拆分/合并明细账单 = 是」，立即应用 4 方互斥（disabled + 清空）
      {
        const billSplitMergeRow = rowByField.get(BILL_SPLIT_MERGE_FIELD);
        const billSplitMergeSelect = billSplitMergeRow?.querySelector('.mapping-select');
        const billSplitMergeEnabledInitial = billSplitMergeSelect && billSplitMergeSelect.value === '是';
        if (billSplitMergeEnabledInitial) {
          applyBillSplitMergeMutualExclusion(true);
        }
      }

      function syncMerchantIdDependentRows() {
        const merchantRow = rowByField.get('MerchantId');
        const currencyRow = rowByField.get('Currency');
        const merchantSelect = merchantRow?.querySelector('.mapping-select');
        const isManagedByBigAccount = getSelectValues(merchantSelect)[0] === MERCHANT_ID_SELF_INPUT_OPTION;

        if (currencyRow) {
          currencyRow.hidden = Boolean(isManagedByBigAccount);
        }
      }

      const merchantSelect = rowByField.get('MerchantId')?.querySelector('.mapping-select');
      merchantSelect?.addEventListener('change', syncMerchantIdDependentRows);
      syncMerchantIdDependentRows();

      dialog.querySelector('.icon-close').addEventListener('click', () => {
        openModal(createTemplateManagerDialog());
      });

      dialog.querySelector('[data-action="done"]').addEventListener('click', async () => {
        const draftBigAccounts = cloneBigAccountItems(currentBigAccounts);
        const draftMappings = collectMappingDraftFromTable(tbody);

        const saveMappings = async (mappings) => {
          const result = await desktopApi.templates.saveMappings({
            templateId: payload.template.id,
            mappings,
            bigAccounts: draftBigAccounts,
            fixedAssignments: currentFixedAssignments
          });

          setStatus(result.message, result.status === 'success' ? 'success' : 'error', {
            errorReportReady: Boolean(result.errorReportReady)
          });

          if (result.status === 'success') {
            await refreshTemplates();
            openModal(createTemplateManagerDialog());
            return;
          }

          openModal(createAlertDialog(result.message, {
            onConfirm: () => {
              openModal(createMappingDialog({
                ...payload,
                mappings,
                bigAccounts: draftBigAccounts,
                fixedAssignments: currentFixedAssignments,
                amountSplitRules: currentAmountSplitRules
              }));
            }
          }));
        };

        saveMappings(draftMappings).catch((error) => {
          console.error(error);
          setStatus('模板映射保存失败，请查看控制台', 'error');
        });
      });

      dialog.addEventListener('mousedown', (event) => {
        if (!event.target.closest('.concat-field-picker')) {
          dialog.querySelectorAll('.concat-picker-panel:not([hidden])').forEach((panel) => {
            panel.hidden = true;
          });
        }
      });

      overlay.appendChild(dialog);
      return overlay;
    }

    function createAmountSplitRulesDialog({ template, initialRules = [], context = 'main', onDone, onCancel }) {
      const overlay = createOverlay();
      const dialog = document.createElement('div');
      dialog.className = 'modal-card amount-split-rules-card';

      const fallbackRules = [
        { targetField: 'Credit Amount', conditionField: '', conditionValue: '', mappedField: '', rowIndex: 0 },
        { targetField: 'Debit Amount', conditionField: '', conditionValue: '', mappedField: '', rowIndex: 1 }
      ];
      const seededRules = initialRules && initialRules.length
        ? initialRules
        : fallbackRules;
      const creditRule = seededRules.find((rule) => rule.targetField === 'Credit Amount') || fallbackRules[0];
      const debitRule = seededRules.find((rule) => rule.targetField === 'Debit Amount') || fallbackRules[1];

      const headers = Array.isArray(template.headers) ? template.headers : [];
      const headerOptions = ['<option value=""></option>']
        .concat(headers.map((header) => `<option value="${escapeHtml(header)}">${escapeHtml(header || '(空白字段)')}</option>`))
        .join('');

      dialog.innerHTML = `
        <div class="dialog-header">
          <div class="dialog-title">发生额映射关系管理</div>
          <button class="icon-close" type="button">×</button>
        </div>
        <div class="amount-split-rules-body">
          <table class="data-table">
            <thead>
              <tr>
                <th>目标字段</th>
                <th>判断字段</th>
                <th>判断字段值</th>
                <th>发生额字段</th>
              </tr>
            </thead>
            <tbody>
              <tr class="amount-split-rule-row" data-target-field="Credit Amount">
                <td>Credit Amount</td>
                <td><select class="mapping-select rule-condition-field">${headerOptions}</select></td>
                <td><input class="mapping-text-input rule-condition-value" type="text" spellcheck="false" /></td>
                <td><select class="mapping-select rule-mapped-field">${headerOptions}</select></td>
              </tr>
              <tr class="amount-split-rule-row" data-target-field="Debit Amount">
                <td>Debit Amount</td>
                <td><select class="mapping-select rule-condition-field">${headerOptions}</select></td>
                <td><input class="mapping-text-input rule-condition-value" type="text" spellcheck="false" /></td>
                <td><select class="mapping-select rule-mapped-field">${headerOptions}</select></td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="dialog-actions right">
          <button class="secondary-btn small" type="button" data-action="cancel">取消</button>
          <button class="primary-btn small" type="button" data-action="done">保存</button>
        </div>
      `;

      const rowByTarget = new Map();
      dialog.querySelectorAll('tr[data-target-field]').forEach((row) => {
        rowByTarget.set(row.dataset.targetField, row);
      });

      function applyRuleToRow(targetField, rule) {
        const row = rowByTarget.get(targetField);
        if (!row) return;
        row.querySelector('.rule-condition-field').value = rule.conditionField || '';
        row.querySelector('.rule-condition-value').value = rule.conditionValue || '';
        row.querySelector('.rule-mapped-field').value = rule.mappedField || '';
      }

      applyRuleToRow('Credit Amount', creditRule);
      applyRuleToRow('Debit Amount', debitRule);

      function collectRules() {
        const collected = [];
        ['Credit Amount', 'Debit Amount'].forEach((targetField, index) => {
          const row = rowByTarget.get(targetField);
          if (!row) return;
          collected.push({
            targetField,
            conditionField: String(row.querySelector('.rule-condition-field').value || '').trim(),
            conditionValue: String(row.querySelector('.rule-condition-value').value || '').trim(),
            mappedField: String(row.querySelector('.rule-mapped-field').value || '').trim(),
            rowIndex: index
          });
        });
        return collected;
      }

      function validateCollectedRulesClientSide(rules) {
        const errors = [];
        rules.forEach((rule) => {
          if (!rule.conditionField) {
            errors.push(`${rule.targetField}：请选择判断字段`);
          }
          if (rule.conditionValue === '') {
            errors.push(`${rule.targetField}：请填写判断字段值`);
          } else if (looksLikeRegexLiteral(rule.conditionValue) && !parseRegexLiteral(rule.conditionValue)) {
            errors.push(`${rule.targetField}：正则表达式语法错误 ${rule.conditionValue}`);
          }
          if (!rule.mappedField) {
            errors.push(`${rule.targetField}：请选择发生额字段`);
          }
          if (rule.conditionField && rule.mappedField && rule.conditionField === rule.mappedField) {
            errors.push(`${rule.targetField}：条件字段与目标字段不能相同`);
          }
        });
        return errors;
      }

      dialog.querySelector('.icon-close').addEventListener('click', () => {
        if (typeof onCancel === 'function') {
          onCancel();
        } else {
          closeModal();
        }
      });

      dialog.querySelector('[data-action="cancel"]').addEventListener('click', () => {
        if (typeof onCancel === 'function') {
          onCancel();
        } else {
          closeModal();
        }
      });

      dialog.querySelector('[data-action="done"]').addEventListener('click', async () => {
        const rules = collectRules();
        const errors = validateCollectedRulesClientSide(rules);
        if (errors.length) {
          openModal(createAlertDialog(errors.join('<br/>'), {
            onConfirm: () => {
              openModal(createAmountSplitRulesDialog({
                template,
                initialRules: rules,
                context,
                onDone,
                onCancel
              }));
            }
          }));
          return;
        }

        // bill-split 上下文：IPC 分流由 onDone 回调完成（见 createBillSplitRowsDialog），
        // 本对话框不直接写入，避免落到主 template_amount_split_rules 表。
        if (context === 'bill-split') {
          if (typeof onDone === 'function') {
            onDone(rules);
          } else {
            closeModal();
          }
          return;
        }

        try {
          const result = await desktopApi.templates.saveAmountSplitRules({
            templateId: template.id,
            rules
          });

          if (result.status === 'success') {
            if (typeof onDone === 'function') {
              onDone(rules);
            } else {
              closeModal();
            }
            return;
          }

          openModal(createAlertDialog(result.message || '保存失败', {
            onConfirm: () => {
              openModal(createAmountSplitRulesDialog({
                template,
                initialRules: rules,
                context,
                onDone,
                onCancel
              }));
            }
          }));
        } catch (error) {
          console.error(error);
          openModal(createAlertDialog('保存失败，请查看控制台', {
            onConfirm: () => {
              openModal(createAmountSplitRulesDialog({
                template,
                initialRules: rules,
                context,
                onDone,
                onCancel
              }));
            }
          }));
        }
      });

      overlay.appendChild(dialog);
      return overlay;
    }

    // ==================== v1.4.9 弹框 1: 拆分/合并账单映射关系设置 ====================
    // TechDoc §7.2 / PRD §4.2
    function createBillSplitMappingsDialog({
      template,
      initialMappings = [],
      mainTemplateMappings = [],
      headers = [],
      targetFields = [],
      advancedMappingFields = [],
      billSplitGroupFields = [],
      onDone,
      onCancel
    }) {
      const overlay = createOverlay();
      const dialog = document.createElement('div');
      dialog.className = 'modal-card bill-split-mappings-card';

      // 模板字段列表 = targetFields 排除 Currency / Credit Amount / Debit Amount + 高级字段 + bill-split group 字段
      const excludeFields = new Set([
        'Currency',
        'Credit Amount',
        'Debit Amount',
        ...advancedMappingFields,
        ...billSplitGroupFields
      ]);
      const displayTargetFields = (targetFields || []).filter((f) => !excludeFields.has(f));

      // 可变 state: 每个模板字段对应的 mappedField / mappedFields
      let currentDialogMappings = displayTargetFields.map((f) => {
        const existing = (initialMappings || []).find((m) => m.templateField === f);
        return {
          templateField: f,
          mappedField: existing ? String(existing.mappedField || '') : '',
          mappedFields: existing && Array.isArray(existing.mappedFields) ? existing.mappedFields.slice() : []
        };
      });

      const headerOptions = (headers || []).map((header) => {
        const escapedHeader = escapeHtml(header || '(空白字段)');
        const value = escapeHtml(header);
        return `<option value="${value}">${escapedHeader}</option>`;
      });

      dialog.innerHTML = `
        <div class="dialog-header">
          <div class="dialog-title">拆分/合并账单映射关系设置</div>
          <div class="bill-split-mappings-header-actions">
            <button class="secondary-btn small" type="button" data-action="import-main">导入当前映射关系</button>
            <button class="icon-close" type="button">×</button>
          </div>
        </div>
        <div class="table-wrapper bill-split-mappings-wrapper">
          <table class="data-table">
            <thead>
              <tr>
                <th>模板字段</th>
                <th>映射字段</th>
              </tr>
            </thead>
            <tbody></tbody>
          </table>
        </div>
        <div class="dialog-actions right">
          <button class="primary-btn small" type="button" data-action="done">完成</button>
        </div>
      `;

      const tbody = dialog.querySelector('tbody');

      function rerenderTable() {
        tbody.replaceChildren();
        currentDialogMappings.forEach((entry) => {
          const row = document.createElement('tr');
          row.dataset.templateField = entry.templateField;

          const isCurrencyLike = entry.templateField === 'Currency';
          const supportsMultiSelect = !isCurrencyLike;
          const selectOptions = ['<option value=""></option>']
            .concat(supportsMultiSelect ? [`<option value="${CONCAT_FIELDS_MAPPING_FIELD}">${CONCAT_FIELDS_MAPPING_FIELD}</option>`] : [])
            .concat(headerOptions)
            .join('');

          row.innerHTML = `
            <td>${escapeHtml(entry.templateField)}</td>
            <td>
              <div class="mapping-field-editor">
                <select class="mapping-select bill-split-mapping-select">${selectOptions}</select>
                <div class="concat-field-picker" hidden>
                  <button class="concat-picker-trigger secondary-btn small" type="button">选择字段</button>
                  <div class="concat-picker-panel" hidden></div>
                  <div class="concat-preview-wrapper">
                    <span class="concat-order-label">当前拼接顺序：</span>
                    <span class="concat-preview" title=""></span>
                  </div>
                </div>
              </div>
            </td>
          `;

          const select = row.querySelector('.bill-split-mapping-select');
          const concatPicker = row.querySelector('.concat-field-picker');
          const concatTrigger = row.querySelector('.concat-picker-trigger');
          const concatPanel = row.querySelector('.concat-picker-panel');
          const concatPreview = row.querySelector('.concat-preview');
          let concatSelectedFields = Array.isArray(entry.mappedFields) ? entry.mappedFields.slice() : [];
          const isConcatInitial = entry.mappedField === CONCAT_FIELDS_MAPPING_FIELD && concatSelectedFields.length > 0;

          select.value = isConcatInitial ? CONCAT_FIELDS_MAPPING_FIELD : (entry.mappedField || '');

          function updateConcatPreviewText() {
            if (!concatPreview) return;
            const previewText = concatSelectedFields.join(' ');
            concatPreview.textContent = previewText.length > 40 ? previewText.slice(0, 40) + '......' : previewText;
            concatPreview.title = concatSelectedFields.join(' ');
          }

          function renderConcatOptions() {
            if (!concatPanel) return;
            concatPanel.replaceChildren();
            (headers || []).forEach((header) => {
              const option = document.createElement('div');
              option.className = 'concat-picker-option';
              const checkbox = document.createElement('input');
              checkbox.type = 'checkbox';
              checkbox.checked = concatSelectedFields.includes(header);
              const indexSpan = document.createElement('span');
              indexSpan.className = 'concat-picker-index';
              const selectedIdx = concatSelectedFields.indexOf(header);
              indexSpan.textContent = selectedIdx >= 0 ? `${selectedIdx + 1}.` : '';
              const nameSpan = document.createElement('span');
              nameSpan.textContent = header || '(空白字段)';
              option.append(checkbox, indexSpan, nameSpan);
              option.addEventListener('click', (event) => {
                if (event.target === checkbox) return;
                checkbox.checked = !checkbox.checked;
                checkbox.dispatchEvent(new Event('change'));
              });
              checkbox.addEventListener('change', () => {
                if (checkbox.checked) {
                  if (!concatSelectedFields.includes(header)) concatSelectedFields.push(header);
                } else {
                  concatSelectedFields = concatSelectedFields.filter((h) => h !== header);
                }
                entry.mappedFields = concatSelectedFields.slice();
                renderConcatOptions();
                updateConcatPreviewText();
              });
              concatPanel.appendChild(option);
            });
          }

          if (concatTrigger) {
            concatTrigger.addEventListener('click', () => {
              const isOpen = !concatPanel.hidden;
              concatPanel.hidden = isOpen;
              if (!isOpen) renderConcatOptions();
            });
          }

          function syncEditorState() {
            const isConcatMode = select.value === CONCAT_FIELDS_MAPPING_FIELD;
            if (concatPicker) concatPicker.hidden = !isConcatMode;
            if (!isConcatMode) {
              concatSelectedFields = [];
              entry.mappedFields = [];
              updateConcatPreviewText();
              if (concatPanel) concatPanel.hidden = true;
            }
          }

          select.addEventListener('change', () => {
            entry.mappedField = select.value;
            syncEditorState();
          });

          if (isConcatInitial) {
            updateConcatPreviewText();
          }
          syncEditorState();
          tbody.appendChild(row);
        });
      }

      function validateLocalMappings() {
        // 校验：同字段不可重复（已通过结构保证），空字段会被后端丢弃，无需前端报错
        return true;
      }

      function doImportFromMain() {
        // 从主模板映射复制，排除 Currency/Credit/Debit/advanced/bill-split group
        const imported = (mainTemplateMappings || [])
          .filter((m) => !excludeFields.has(m.templateField))
          .map((m) => ({
            templateField: m.templateField,
            mappedField: String(m.mappedField || ''),
            mappedFields: Array.isArray(m.mappedFields) ? m.mappedFields.slice() : []
          }));
        const importMap = new Map(imported.map((m) => [m.templateField, m]));
        currentDialogMappings = displayTargetFields.map((f) => {
          const hit = importMap.get(f);
          return hit
            ? { templateField: f, mappedField: hit.mappedField, mappedFields: hit.mappedFields }
            : { templateField: f, mappedField: '', mappedFields: [] };
        });
        rerenderTable();
      }

      dialog.querySelector('[data-action="import-main"]').addEventListener('click', () => {
        // 检查弹框当前是否已有任意行非空
        const hasExistingData = currentDialogMappings.some(
          (m) => m.mappedField || (Array.isArray(m.mappedFields) && m.mappedFields.length > 0)
        );
        if (hasExistingData) {
          openModal(createConfirmDialog({
            message: '确认覆盖弹框中已有的配置？',
            confirmText: '确认',
            cancelText: '取消',
            onConfirm: () => {
              doImportFromMain();
              openModal(overlay);
            }
          }));
        } else {
          doImportFromMain();
        }
      });

      dialog.querySelector('.icon-close').addEventListener('click', () => {
        if (typeof onCancel === 'function') onCancel();
        else closeModal();
      });

      dialog.querySelector('[data-action="done"]').addEventListener('click', async () => {
        if (!validateLocalMappings()) return;
        // 只发送非空的 mappings（后端 validate 会丢弃空行）
        const toSave = currentDialogMappings.filter(
          (m) => m.mappedField || (Array.isArray(m.mappedFields) && m.mappedFields.length > 0)
        );
        try {
          const result = await desktopApi.templates.saveBillSplitMappings({
            templateId: template.id,
            mappings: toSave
          });
          if (result && result.status === 'success') {
            if (typeof onDone === 'function') onDone(toSave);
            else closeModal();
          } else {
            openModal(createAlertDialog(result?.message || '保存失败', {
              onConfirm: () => { openModal(overlay); }
            }));
          }
        } catch (error) {
          console.error(error);
          openModal(createAlertDialog('保存失败，请查看控制台', {
            onConfirm: () => { openModal(overlay); }
          }));
        }
      });

      dialog.addEventListener('mousedown', (event) => {
        if (!event.target.closest('.concat-field-picker')) {
          dialog.querySelectorAll('.concat-picker-panel:not([hidden])').forEach((panel) => {
            panel.hidden = true;
          });
        }
      });

      rerenderTable();
      overlay.appendChild(dialog);
      return overlay;
    }

    // ==================== v1.4.9 弹框 2: 拆分/合并账单映射关系管理 ====================
    // TechDoc §7.3 / PRD §4.3
    function createBillSplitRowsDialog({
      template,
      initialRows = [],
      initialAmountRules = [],
      initialBillSplitMeta = { signedAmountSourceField: '' },
      onClose
    }) {
      const overlay = createOverlay();
      const dialog = document.createElement('div');
      dialog.className = 'modal-card bill-split-rows-card';

      let currentRows = (initialRows || []).map((r) => ({ ...r }));
      let currentAmountRules = (initialAmountRules || []).map((r) => ({ ...r }));
      let currentBillSplitMeta = {
        signedAmountSourceField: String((initialBillSplitMeta && initialBillSplitMeta.signedAmountSourceField) || '')
      };

      const headers = Array.isArray(template.headers) ? template.headers : [];
      // 排除特殊枚举，仅剩 template.headers 本身（AC1-31）
      const headerOptionsHtml = ['<option value=""></option>']
        .concat(headers.map((h) => `<option value="${escapeHtml(h)}">${escapeHtml(h || '(空白字段)')}</option>`))
        .join('');

      dialog.innerHTML = `
        <div class="dialog-header">
          <div class="dialog-title">拆分/合并账单映射关系管理</div>
          <div class="bill-split-rows-header-actions">
            <label class="bill-split-merge-checkbox-label">
              <input type="checkbox" class="bill-split-merge-checkbox" />
              <span>合并账单</span>
            </label>
            <select class="mapping-select bill-split-merge-dropdown" multiple hidden></select>
            <button class="secondary-btn small bill-split-merge-done-btn" type="button" hidden>完成</button>
            <button class="icon-close" type="button">×</button>
          </div>
        </div>
        <div class="bill-split-rows-body">
          <div class="bill-split-row-count-line">
            <label>需要拆分成几份账单</label>
            <input type="number" class="bill-split-row-count-input" min="1" max="99" />
            <button class="secondary-btn small bill-split-row-count-done-btn" type="button">完成</button>
          </div>
          <div class="table-wrapper bill-split-rows-table-wrapper">
            <table class="data-table bill-split-rows-table">
              <thead>
                <tr>
                  <th>账单序号</th>
                  <th>Currency</th>
                  <th>Credit Amount</th>
                  <th>Debit Amount</th>
                  <th>发生额</th>
                  <th>执行操作</th>
                </tr>
              </thead>
              <tbody></tbody>
            </table>
          </div>
          <hr class="bill-split-sub-section-divider" />
          <div class="bill-split-sub-section">
            <h3>拆分/合并账单——发生额映射关系管理</h3>
            <div class="bill-split-sub-row">
              <label>按正负号拆分的发生额</label>
              <select class="mapping-select bill-split-signed-select">${headerOptionsHtml}</select>
            </div>
            <div class="bill-split-sub-row">
              <label>按字段区分发生额</label>
              <select class="mapping-select bill-split-by-field-select">
                <option value=""></option>
                <option value="是">是</option>
              </select>
              <button class="secondary-btn small bill-split-amount-rules-manage-btn" type="button" hidden>发生额映射关系管理</button>
            </div>
          </div>
        </div>
      `;

      const tableBody = dialog.querySelector('.bill-split-rows-table tbody');
      const nInput = dialog.querySelector('.bill-split-row-count-input');
      const nDoneBtn = dialog.querySelector('.bill-split-row-count-done-btn');
      const mergeCheckbox = dialog.querySelector('.bill-split-merge-checkbox');
      const mergeDropdown = dialog.querySelector('.bill-split-merge-dropdown');
      const mergeDoneBtn = dialog.querySelector('.bill-split-merge-done-btn');
      const signedSelect = dialog.querySelector('.bill-split-signed-select');
      const byFieldSelect = dialog.querySelector('.bill-split-by-field-select');
      const amountRulesManageBtn = dialog.querySelector('.bill-split-amount-rules-manage-btn');

      // 初始化副区域 UI
      signedSelect.value = currentBillSplitMeta.signedAmountSourceField || '';
      byFieldSelect.value = currentAmountRules.length > 0 ? '是' : '';
      amountRulesManageBtn.hidden = currentAmountRules.length === 0;

      nInput.value = String(currentRows.length || 1);

      function isAmountSourceColumnEnabled() {
        return Boolean(currentBillSplitMeta.signedAmountSourceField) || currentAmountRules.length > 0;
      }

      function applyBillSplit2WayExclusion() {
        const enabled = isAmountSourceColumnEnabled();
        // 副区域状态
        if (currentBillSplitMeta.signedAmountSourceField) {
          byFieldSelect.disabled = true;
        } else if (currentAmountRules.length > 0) {
          signedSelect.disabled = true;
        } else {
          signedSelect.disabled = false;
          byFieldSelect.disabled = false;
        }
        // Credit/Debit 列禁用 + 清空
        if (enabled) {
          currentRows.forEach((row) => {
            row.creditSourceField = '';
            row.debitSourceField = '';
          });
        }
      }

      function renderTableRow(row) {
        const tr = document.createElement('tr');
        const seqDisplay = (row.mergedGroupSeq !== null && row.mergedGroupSeq !== undefined)
          ? String(row.mergedGroupSeq)
          : String(row.seqNo);
        const isMerged = row.mergedGroupSeq !== null && row.mergedGroupSeq !== undefined;
        const isCompleted = row.rowStatus === 'completed';
        const amountEnabled = isAmountSourceColumnEnabled();

        if (isMerged) tr.classList.add('bill-split-merged-row');

        tr.innerHTML = `
          <td>${escapeHtml(seqDisplay)}</td>
          <td><select class="mapping-select bill-split-currency-select">${headerOptionsHtml}</select></td>
          <td><select class="mapping-select bill-split-credit-select">${headerOptionsHtml}</select></td>
          <td><select class="mapping-select bill-split-debit-select">${headerOptionsHtml}</select></td>
          <td><select class="mapping-select bill-split-amount-select">${headerOptionsHtml}</select></td>
          <td class="bill-split-row-actions">
            <button class="text-action bill-split-row-complete-btn" type="button">${isCompleted ? '编辑' : '完成'}</button>
            <button class="text-action danger bill-split-row-delete-btn" type="button">删除</button>
          </td>
        `;

        const currencySel = tr.querySelector('.bill-split-currency-select');
        const creditSel = tr.querySelector('.bill-split-credit-select');
        const debitSel = tr.querySelector('.bill-split-debit-select');
        const amountSel = tr.querySelector('.bill-split-amount-select');
        const completeBtn = tr.querySelector('.bill-split-row-complete-btn');
        const deleteBtn = tr.querySelector('.bill-split-row-delete-btn');

        currencySel.value = row.currencySourceField || '';
        creditSel.value = row.creditSourceField || '';
        debitSel.value = row.debitSourceField || '';
        amountSel.value = row.amountSourceField || '';

        // 禁用规则
        if (isMerged || isCompleted) {
          currencySel.disabled = true;
          creditSel.disabled = true;
          debitSel.disabled = true;
          amountSel.disabled = true;
        } else {
          currencySel.disabled = false;
          if (amountEnabled) {
            creditSel.disabled = true;
            debitSel.disabled = true;
            amountSel.disabled = false;
          } else {
            creditSel.disabled = false;
            debitSel.disabled = false;
            amountSel.disabled = true;
          }
        }

        completeBtn.disabled = isMerged;
        deleteBtn.disabled = isMerged;

        // 同行 Credit !== Debit 校验
        function onCreditDebitChange(which, sel) {
          const newValue = sel.value;
          const otherValue = which === 'credit' ? row.debitSourceField : row.creditSourceField;
          if (newValue && otherValue && newValue === otherValue) {
            openModal(createAlertDialog('同一份拆分账单的 Credit Amount 和 Debit Amount 不能是同一列', {
              onConfirm: () => { openModal(overlay); }
            }));
            sel.value = which === 'credit' ? (row.creditSourceField || '') : (row.debitSourceField || '');
            return;
          }
          if (which === 'credit') row.creditSourceField = newValue;
          else row.debitSourceField = newValue;
        }

        currencySel.addEventListener('change', () => { row.currencySourceField = currencySel.value; });
        creditSel.addEventListener('change', () => { onCreditDebitChange('credit', creditSel); });
        debitSel.addEventListener('change', () => { onCreditDebitChange('debit', debitSel); });
        amountSel.addEventListener('change', () => { row.amountSourceField = amountSel.value; });

        completeBtn.addEventListener('click', async () => {
          const nextStatus = isCompleted ? 'draft' : 'completed';
          try {
            const result = await desktopApi.templates.saveBillSplitRow({
              templateId: template.id,
              row: { ...row, rowStatus: nextStatus }
            });
            if (result && result.status === 'success') {
              row.rowStatus = nextStatus;
              rerenderTable();
            } else {
              openModal(createAlertDialog(result?.message || '保存失败', {
                onConfirm: () => { openModal(overlay); }
              }));
            }
          } catch (error) {
            console.error(error);
          }
        });

        deleteBtn.addEventListener('click', async () => {
          // 先 preview 受影响的合并组（Q-OT6=C）
          let dissolvedGroups = [];
          try {
            const preview = await desktopApi.templates.previewDeleteBillSplitRow({
              templateId: template.id,
              seqNo: row.seqNo
            });
            if (preview && Array.isArray(preview.dissolvedGroups)) {
              dissolvedGroups = preview.dissolvedGroups;
            }
          } catch (_error) { /* ignore */ }

          async function performDelete() {
            try {
              const result = await desktopApi.templates.deleteBillSplitRow({
                templateId: template.id,
                seqNo: row.seqNo
              });
              if (result && result.status === 'success') {
                currentRows = result.currentRows || [];
                nInput.value = String(currentRows.length);
                rerenderTable();
              } else {
                openModal(createAlertDialog(result?.message || '删除失败', {
                  onConfirm: () => { openModal(overlay); }
                }));
              }
            } catch (error) {
              console.error(error);
            }
          }

          if (dissolvedGroups.length > 0) {
            const listText = dissolvedGroups.map((s) => `合并组 ${s}`).join('、');
            openModal(createConfirmDialog({
              message: `删除账单序号 ${row.seqNo} 将解散以下合并组：${listText}。确认继续？`,
              confirmText: '确认',
              cancelText: '取消',
              onConfirm: async () => {
                await performDelete();
                openModal(overlay);
              }
            }));
          } else {
            await performDelete();
          }
        });

        return tr;
      }

      function rerenderTable() {
        applyBillSplit2WayExclusion();
        tableBody.replaceChildren();
        currentRows.forEach((r) => {
          tableBody.appendChild(renderTableRow(r));
        });
      }

      async function refreshFromServer() {
        try {
          const result = await desktopApi.templates.getBillSplitConfig(template.id);
          if (result && result.status === 'success') {
            currentRows = result.billSplitRows || [];
            currentAmountRules = result.billSplitAmountRules || [];
            currentBillSplitMeta = result.billSplitMeta || { signedAmountSourceField: '' };
            signedSelect.value = currentBillSplitMeta.signedAmountSourceField || '';
            byFieldSelect.value = currentAmountRules.length > 0 ? '是' : '';
            amountRulesManageBtn.hidden = currentAmountRules.length === 0;
            nInput.value = String(currentRows.length);
            rerenderTable();
          }
        } catch (_error) { /* ignore */ }
      }

      // N 完成按钮
      nDoneBtn.addEventListener('click', async () => {
        const nextN = Number(nInput.value);
        if (!Number.isInteger(nextN) || nextN < 1 || nextN > 99) {
          openModal(createAlertDialog('拆分账单份数必须为 1 ~ 99 之间的整数', {
            onConfirm: () => { openModal(overlay); }
          }));
          return;
        }
        const currentM = currentRows.length;

        async function doPersist(finalN) {
          try {
            const result = await desktopApi.templates.saveBillSplitRowCount({
              templateId: template.id,
              nextN: finalN
            });
            if (result && result.status === 'success') {
              currentRows = result.currentRows || [];
              rerenderTable();
            } else {
              openModal(createAlertDialog(result?.message || '保存失败', {
                onConfirm: () => { openModal(overlay); }
              }));
            }
          } catch (error) {
            console.error(error);
          }
        }

        if (nextN < currentM) {
          openModal(createConfirmDialog({
            message: `确认删除最下方的 ${currentM - nextN} 行？已填数据会丢失`,
            confirmText: '确认',
            cancelText: '取消',
            onConfirm: async () => {
              await doPersist(nextN);
              openModal(overlay);
            }
          }));
        } else if (nextN > currentM) {
          await doPersist(nextN);
        }
      });

      // 合并账单勾选框
      mergeCheckbox.addEventListener('change', async () => {
        if (mergeCheckbox.checked) {
          // 显示多选下拉框 + 完成按钮
          mergeDropdown.hidden = false;
          mergeDoneBtn.hidden = false;
          // 填充候选值（completed 且未合并的行）
          const candidates = currentRows.filter(
            (r) => r.rowStatus === 'completed' && (r.mergedGroupSeq === null || r.mergedGroupSeq === undefined)
          );
          mergeDropdown.replaceChildren();
          candidates.forEach((r) => {
            const opt = document.createElement('option');
            opt.value = String(r.seqNo);
            opt.textContent = String(r.seqNo);
            mergeDropdown.appendChild(opt);
          });
        } else {
          mergeDropdown.hidden = true;
          mergeDoneBtn.hidden = true;
          // 清空所有合并组
          try {
            await desktopApi.templates.clearBillSplitMergeGroups({ templateId: template.id });
            await refreshFromServer();
          } catch (error) {
            console.error(error);
          }
        }
      });

      mergeDoneBtn.addEventListener('click', async () => {
        const selectedSeqNos = Array.from(mergeDropdown.selectedOptions).map((opt) => Number(opt.value));
        if (selectedSeqNos.length < 2) {
          openModal(createAlertDialog('合并账单至少需要选择 2 个账单序号', {
            onConfirm: () => { openModal(overlay); }
          }));
          return;
        }
        try {
          const result = await desktopApi.templates.saveBillSplitMergeGroup({
            templateId: template.id,
            seqNos: selectedSeqNos
          });
          if (result && result.status === 'success') {
            await refreshFromServer();
            // 刷新后重建候选列表
            const candidates = currentRows.filter(
              (r) => r.rowStatus === 'completed' && (r.mergedGroupSeq === null || r.mergedGroupSeq === undefined)
            );
            mergeDropdown.replaceChildren();
            candidates.forEach((r) => {
              const opt = document.createElement('option');
              opt.value = String(r.seqNo);
              opt.textContent = String(r.seqNo);
              mergeDropdown.appendChild(opt);
            });
          } else {
            openModal(createAlertDialog(result?.message || '合并失败', {
              onConfirm: () => { openModal(overlay); }
            }));
          }
        } catch (error) {
          console.error(error);
        }
      });

      // 副区域：按正负号拆分的发生额 onChange
      signedSelect.addEventListener('change', async () => {
        const newValue = signedSelect.value;
        try {
          // 互斥：若 amount rules 非空且 next 非空 → 先清空对侧
          if (newValue && currentAmountRules.length > 0) {
            await desktopApi.templates.saveBillSplitAmountRules({
              templateId: template.id,
              amountSplitRules: []
            });
            currentAmountRules = [];
            byFieldSelect.value = '';
            amountRulesManageBtn.hidden = true;
          }
          await desktopApi.templates.saveBillSplitMeta({
            templateId: template.id,
            signedAmountSourceField: newValue
          });
          currentBillSplitMeta.signedAmountSourceField = newValue;
          rerenderTable();
        } catch (error) {
          console.error(error);
        }
      });

      // 副区域：按字段区分发生额 onChange
      byFieldSelect.addEventListener('change', async () => {
        const newValue = byFieldSelect.value;
        if (newValue === '是') {
          // 打开子弹框配置规则
          if (currentBillSplitMeta.signedAmountSourceField) {
            // 互斥：先清空对侧
            try {
              await desktopApi.templates.saveBillSplitMeta({
                templateId: template.id,
                signedAmountSourceField: ''
              });
              currentBillSplitMeta.signedAmountSourceField = '';
              signedSelect.value = '';
            } catch (_error) { /* ignore */ }
          }
          openBillSplitAmountRulesSubDialog();
        } else {
          // 清空规则
          try {
            await desktopApi.templates.saveBillSplitAmountRules({
              templateId: template.id,
              amountSplitRules: []
            });
            currentAmountRules = [];
            amountRulesManageBtn.hidden = true;
            rerenderTable();
          } catch (error) {
            console.error(error);
          }
        }
      });

      amountRulesManageBtn.addEventListener('click', () => {
        openBillSplitAmountRulesSubDialog();
      });

      function openBillSplitAmountRulesSubDialog() {
        openModal(createAmountSplitRulesDialog({
          template,
          initialRules: currentAmountRules,
          context: 'bill-split',
          onDone: async (nextRules) => {
            try {
              const result = await desktopApi.templates.saveBillSplitAmountRules({
                templateId: template.id,
                amountSplitRules: nextRules
              });
              if (result && result.status === 'success') {
                currentAmountRules = nextRules.map((r) => ({ ...r }));
                byFieldSelect.value = '是';
                amountRulesManageBtn.hidden = false;
                rerenderTable();
                openModal(overlay);
              } else {
                openModal(createAlertDialog(result?.message || '保存失败', {
                  onConfirm: () => { openModal(overlay); }
                }));
              }
            } catch (error) {
              console.error(error);
              openModal(createAlertDialog('保存失败，请查看控制台', {
                onConfirm: () => { openModal(overlay); }
              }));
            }
          },
          onCancel: () => {
            byFieldSelect.value = currentAmountRules.length > 0 ? '是' : '';
            openModal(overlay);
          }
        }));
      }

      dialog.querySelector('.icon-close').addEventListener('click', () => {
        if (typeof onClose === 'function') onClose();
        else closeModal();
      });

      rerenderTable();
      overlay.appendChild(dialog);
      return overlay;
    }

    function createBalanceAddonManagerDialog({ templateName, bigAccounts, onClose }) {
      const overlay = createOverlay();
      const dialog = document.createElement('div');
      dialog.className = 'modal-card manager-card balance-addon-card';
      dialog.innerHTML = `
        <div class="dialog-header">
          <div class="dialog-title">余额管理</div>
          <button class="icon-close" type="button">×</button>
        </div>
        <div class="table-wrapper">
          <table class="data-table">
            <thead>
              <tr>
                <th>大账号</th>
                <th>币种</th>
                <th>日期</th>
                <th>余额附加值</th>
                <th>备注</th>
              </tr>
            </thead>
            <tbody></tbody>
          </table>
        </div>
        <div class="dialog-actions split">
          <button class="secondary-btn small" type="button" data-action="add-row">新增</button>
          <button class="primary-btn small" type="button" data-action="done">完成</button>
        </div>
      `;

      const tbody = dialog.querySelector('tbody');
      const groupedBigAccounts = bigAccounts || [];

      function createAddonRow(record = {}) {
        const row = document.createElement('tr');
        row.innerHTML = `
          <td>
            <select class="mapping-select balance-addon-merchant-select">
              <option value=""></option>
              ${groupedBigAccounts.map((item) => `<option value="${escapeHtml(item.merchantId)}">${escapeHtml(item.merchantId)}</option>`).join('')}
            </select>
          </td>
          <td>
            <select class="mapping-select balance-addon-currency-select">
              <option value=""></option>
            </select>
          </td>
          <td><input class="mapping-text-input balance-addon-date-input" type="text" value="" /></td>
          <td><input class="mapping-text-input balance-addon-value-input" type="text" spellcheck="false" value="" /></td>
          <td>
            <div class="balance-addon-remark-cell">
              <input class="mapping-text-input balance-addon-remark-input" type="text" spellcheck="false" value="" />
              <button class="text-action danger" type="button" data-action="delete-row">删除</button>
            </div>
          </td>
        `;

        const merchantSelect = row.querySelector('.balance-addon-merchant-select');
        const currencySelect = row.querySelector('.balance-addon-currency-select');
        const dateInput = row.querySelector('.balance-addon-date-input');
        const valueInput = row.querySelector('.balance-addon-value-input');
        const remarkInput = row.querySelector('.balance-addon-remark-input');

        if (record.merchantId && !Array.from(merchantSelect.options).some((opt) => opt.value === record.merchantId)) {
          const extraOpt = document.createElement('option');
          extraOpt.value = record.merchantId;
          extraOpt.textContent = record.merchantId;
          merchantSelect.appendChild(extraOpt);
        }

        function syncCurrencyOptions() {
          const selectedAccount = groupedBigAccounts.find((item) => item.merchantId === merchantSelect.value);
          currencySelect.innerHTML = '<option value=""></option>';
          if (selectedAccount) {
            selectedAccount.currencies.forEach((currency) => {
              const opt = document.createElement('option');
              opt.value = currency;
              opt.textContent = currency;
              currencySelect.appendChild(opt);
            });
            if (!selectedAccount.isMultiCurrency && selectedAccount.currencies.length === 1) {
              currencySelect.value = selectedAccount.currencies[0];
              currencySelect.disabled = true;
            } else {
              currencySelect.disabled = false;
            }
          }
        }

        merchantSelect.addEventListener('change', syncCurrencyOptions);
        dateInput.addEventListener('focus', () => {
          if (dateInput.type !== 'date') dateInput.type = 'date';
          dateInput.showPicker?.();
        });
        dateInput.addEventListener('blur', () => {
          if (!dateInput.value) dateInput.type = 'text';
        });
        row.querySelector('[data-action="delete-row"]').addEventListener('click', () => {
          row.remove();
        });

        if (record.merchantId) {
          merchantSelect.value = record.merchantId;
          syncCurrencyOptions();
          if (record.currency) {
            if (!Array.from(currencySelect.options).some((opt) => opt.value === record.currency)) {
              const extraCurrOpt = document.createElement('option');
              extraCurrOpt.value = record.currency;
              extraCurrOpt.textContent = record.currency;
              currencySelect.appendChild(extraCurrOpt);
            }
            currencySelect.value = record.currency;
          }
        }
        if (record.effectiveDate) {
          dateInput.value = record.effectiveDate;
          dateInput.type = 'date';
        }
        if (record.adjustmentValue !== undefined && record.adjustmentValue !== null) {
          valueInput.value = String(record.adjustmentValue);
        }
        if (record.remark) remarkInput.value = record.remark;

        return row;
      }

      dialog.querySelector('.icon-close').addEventListener('click', () => {
        if (onClose) onClose();
        else closeModal();
      });
      dialog.querySelector('[data-action="add-row"]').addEventListener('click', () => {
        tbody.appendChild(createAddonRow());
      });
      dialog.querySelector('[data-action="done"]').addEventListener('click', async () => {
        const records = Array.from(tbody.querySelectorAll('tr')).map((row) => ({
          merchantId: row.querySelector('.balance-addon-merchant-select')?.value?.trim() || '',
          currency: row.querySelector('.balance-addon-currency-select')?.value?.trim() || '',
          effectiveDate: row.querySelector('.balance-addon-date-input')?.value?.trim() || '',
          adjustmentValue: row.querySelector('.balance-addon-value-input')?.value?.trim() || '',
          remark: row.querySelector('.balance-addon-remark-input')?.value?.trim() || ''
        })).filter((r) => r.merchantId || r.effectiveDate || r.adjustmentValue);

        for (let i = 0; i < records.length; i++) {
          const r = records[i];
          if (!r.merchantId) {
            setStatus(`第 ${i + 1} 行：请选择大账号`, 'error');
            return;
          }
          if (!r.currency) {
            setStatus(`第 ${i + 1} 行：请选择币种`, 'error');
            return;
          }
          if (!r.effectiveDate) {
            setStatus(`第 ${i + 1} 行：请填写日期`, 'error');
            return;
          }
          if (!r.adjustmentValue || isNaN(Number(r.adjustmentValue))) {
            setStatus(`第 ${i + 1} 行：余额附加值必须是有效数字`, 'error');
            return;
          }
        }

        const result = await window.desktopApi.balanceAdjustment.save({
          templateName,
          records
        });

        if (result.status === 'success') {
          setStatus(result.message, 'success');
          if (onClose) onClose();
          else closeModal();
        } else {
          setStatus(result.message, 'error');
        }
      });

      // Load existing records
      window.desktopApi.balanceAdjustment.list(templateName).then((result) => {
        const adjustments = result.adjustments || [];
        if (adjustments.length) {
          adjustments.forEach((record) => tbody.appendChild(createAddonRow(record)));
        } else {
          tbody.appendChild(createAddonRow());
        }
      }).catch(() => {
        tbody.appendChild(createAddonRow());
      });

      overlay.appendChild(dialog);
      return overlay;
    }

    function createAccountMappingDialog(payload) {
      const overlay = createOverlay();
      const dialog = document.createElement('div');
      dialog.className = 'modal-card manager-card account-card';
      dialog.innerHTML = `
        <div class="dialog-header compact">
          <button class="icon-close" type="button">×</button>
        </div>
        <div class="table-wrapper">
          <table class="data-table">
            <thead>
              <tr>
                <th>网银大账号ID</th>
                <th>清结算系统大账号ID</th>
              </tr>
            </thead>
            <tbody></tbody>
          </table>
        </div>
        <div class="dialog-actions right">
          <button class="primary-btn small" type="button" data-action="done">完成</button>
        </div>
      `;

      const tbody = dialog.querySelector('tbody');

      function createInputRow(bankAccountId = '', clearingAccountId = '', noCurrency = false, currency = '') {
        const row = document.createElement('tr');
        row.dataset.accountMappingRow = 'true';
        const bankCell = document.createElement('td');
        const clearingCell = document.createElement('td');
        clearingCell.className = 'account-mapping-clearing-cell';
        const bankInput = document.createElement('input');
        const clearingInput = document.createElement('input');
        const deleteBtn = document.createElement('button');

        bankInput.className = 'mapping-text-input account-mapping-id-input';
        bankInput.type = 'text';
        bankInput.spellcheck = false;
        bankInput.value = bankAccountId;

        clearingInput.className = 'mapping-text-input account-mapping-id-input';
        clearingInput.type = 'text';
        clearingInput.spellcheck = false;
        clearingInput.value = clearingAccountId;

        deleteBtn.className = 'text-action danger account-mapping-delete-btn';
        deleteBtn.type = 'button';
        deleteBtn.textContent = '删除';
        deleteBtn.addEventListener('click', () => {
          row.remove();
        });

        const checkboxLabel = document.createElement('label');
        checkboxLabel.className = 'no-currency-checkbox-label';
        const checkbox = document.createElement('input');
        checkbox.className = 'no-currency-checkbox';
        checkbox.type = 'checkbox';
        checkbox.checked = noCurrency;
        const checkboxText = document.createElement('span');
        checkboxText.textContent = '有账户号无币种';
        checkboxLabel.append(checkbox, checkboxText);

        const currencyShell = document.createElement('div');
        currencyShell.className = 'enum-input-shell account-currency-input-shell';
        currencyShell.hidden = !noCurrency;
        const ghostInput = document.createElement('input');
        ghostInput.className = 'new-account-input enum-ghost-input';
        ghostInput.type = 'text';
        ghostInput.tabIndex = -1;
        ghostInput.disabled = true;
        const currencyInput = document.createElement('input');
        currencyInput.className = 'new-account-input enum-active-input account-currency-input';
        currencyInput.type = 'text';
        currencyInput.spellcheck = false;
        currencyInput.value = currency;
        currencyShell.append(ghostInput, currencyInput);

        function renderSuggestion() {
          const suggestion = getCurrencySuggestion(currencyInput.value);
          ghostInput.value = suggestion;
          return suggestion;
        }

        checkbox.addEventListener('change', () => {
          currencyShell.hidden = !checkbox.checked;
          if (!checkbox.checked) {
            currencyInput.value = '';
            ghostInput.value = '';
          }
        });

        currencyInput.addEventListener('input', renderSuggestion);
        currencyInput.addEventListener('keydown', (event) => {
          if (event.key === 'ArrowRight') {
            const suggestion = renderSuggestion();
            const currentValue = String(currencyInput.value || '');
            if (suggestion && suggestion !== currentValue && suggestion.toUpperCase().startsWith(currentValue.trim().toUpperCase())) {
              currencyInput.value = suggestion;
              renderSuggestion();
              event.preventDefault();
            }
          }
        });

        renderSuggestion();

        bankCell.appendChild(bankInput);
        clearingCell.append(clearingInput, deleteBtn, checkboxLabel, currencyShell);
        row.append(bankCell, clearingCell);
        row.__rowApi = {
          getBankAccountId: () => bankInput.value,
          getClearingAccountId: () => clearingInput.value,
          getNoCurrency: () => checkbox.checked,
          getCurrency: () => currencyInput.value.trim()
        };
        return row;
      }

      function createAddRow() {
        const row = document.createElement('tr');
        row.className = 'add-row';
        row.innerHTML = `
          <td><button class="text-action" type="button" data-action="add">新增</button></td>
          <td></td>
        `;

        row.querySelector('[data-action="add"]').addEventListener('click', () => {
          tbody.insertBefore(createInputRow('', ''), row);
        });

        return row;
      }

      payload.mappings.forEach((mapping) => {
        tbody.appendChild(createInputRow(
          mapping.bankAccountId,
          mapping.clearingAccountId,
          Boolean(mapping.noCurrency),
          mapping.currency || ''
        ));
      });
      tbody.appendChild(createAddRow());

      dialog.querySelector('.icon-close').addEventListener('click', closeModal);
      dialog.querySelector('[data-action="done"]').addEventListener('click', async () => {
        const mappings = Array.from(tbody.querySelectorAll('tr[data-account-mapping-row="true"]')).map((row) => ({
          bankAccountId: row.__rowApi.getBankAccountId(),
          clearingAccountId: row.__rowApi.getClearingAccountId(),
          noCurrency: row.__rowApi.getNoCurrency(),
          currency: row.__rowApi.getCurrency()
        }));

        const result = await desktopApi.accountMappings.save(mappings);

        openModal(createAlertDialog(result.message));
        if (result.status === 'success') {
          const info = await desktopApi.app.getInfo();
          state.accountMappingCount = info.accountMappingCount;
          setStatus(result.message, 'success');
        } else {
          setStatus(result.message, 'error', {
            errorReportReady: Boolean(result.errorReportReady)
          });
        }
      });

      overlay.appendChild(dialog);
      return overlay;
    }

    return {
      closeModal,
      openModal,
      createOverlay,
      createAlertDialog,
      createConfirmDialog,
      createExportScopeDialog,
      createManualBalanceSeedDialog,
      escapeHtml,
      cloneBigAccountItems,
      formatBigAccountCurrencySummary,
      getBigAccountCurrencyTitle,
      collectMappingDraftFromTable,
      createTemplateRenameDialog,
      createBigAccountSelectionDialog,
      createBigAccountManagerDialog,
      renderTemplateTableRows,
      createTemplateManagerDialog,
      createMappingDialog,
      createAccountMappingDialog
    };
  }

  global.__rendererDialogs = {
    createRendererDialogs
  };
}(window));
