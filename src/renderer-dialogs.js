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
      refreshTemplates,
      setStatus,
      applyStatementResult,
      applyManualBalancePromptStatus
    } = deps;

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
        const isConcatMode = mappedFields[0] === CONCAT_FIELDS_MAPPING_FIELD;

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

        return {
          templateField: row.dataset.templateField,
          mappedField: mappedFields[0] || '',
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
      const groupedBigAccounts = Array.from(
        (Array.isArray(payload?.bigAccounts) ? payload.bigAccounts : []).reduce((accumulator, item) => {
          const merchantId = String(item?.merchantId || '').trim();

          if (!merchantId) {
            return accumulator;
          }

          const existing = accumulator.get(merchantId) || {
            merchantId,
            currencies: [],
            isMultiCurrency: false
          };
          const nextCurrencies = Array.from(
            new Set([
              ...existing.currencies,
              ...(Array.isArray(item.currencies) ? item.currencies.map((value) => String(value || '').trim()).filter(Boolean) : [])
            ])
          );

          accumulator.set(merchantId, {
            merchantId,
            currencies: nextCurrencies,
            isMultiCurrency: Boolean(item.isMultiCurrency) || nextCurrencies.length > 1
          });
          return accumulator;
        }, new Map()).values()
      );
      const fixedAssignmentsByRowIndex = new Map(
        (Array.isArray(payload?.fixedAssignments) ? payload.fixedAssignments : [])
          .map((item) => ({
            rowIndex: Number(item?.rowIndex || 0),
            merchantId: String(item?.merchantId || '').trim(),
            currency: String(item?.currency || '').trim()
          }))
          .filter((item) => item.merchantId)
          .map((item) => [item.rowIndex, item])
      );
      const currencyOptions = getCurrencyOptionEntries();
      const overlay = createOverlay();
      const dialog = document.createElement('div');
      let fixedEnabled = fixedAssignmentsByRowIndex.size > 0;
      const currencyControls = [];
      const rowControls = [];

      function createCurrencyControl({ value = '', allowedCodes = [], disabled = false } = {}) {
        const root = document.createElement('div');
        root.className = 'enum-input-control big-account-selection-currency-control';
        root.innerHTML = `
          <div class="enum-input-shell">
            <input class="new-account-input enum-ghost-input" type="text" tabindex="-1" disabled />
            <input class="new-account-input enum-active-input big-account-selection-currency-input" type="text" spellcheck="false" />
          </div>
        `;

        const ghostInput = root.querySelector('.enum-ghost-input');
        const input = root.querySelector('.big-account-selection-currency-input');
        let currentAllowedCodes = allowedCodes.slice();
        let isDisabled = disabled;

        function renderSuggestion() {
          const suggestion = isDisabled ? '' : getCurrencySuggestion(input.value, currentAllowedCodes);
          ghostInput.value = suggestion;
          return suggestion;
        }

        function setAllowedCodes(nextAllowedCodes = []) {
          currentAllowedCodes = nextAllowedCodes.slice();

          if (input.value && currentAllowedCodes.length && !currentAllowedCodes.includes(input.value)) {
            input.value = '';
          }

          renderSuggestion();
        }

        function setDisabled(nextDisabled) {
          isDisabled = Boolean(nextDisabled);
          input.disabled = isDisabled;
          renderSuggestion();
        }

        input.addEventListener('input', () => {
          renderSuggestion();
        });
        input.addEventListener('keydown', (event) => {
          if (event.key === 'ArrowRight') {
            const suggestion = renderSuggestion();
            const currentValue = String(input.value || '');

            if (suggestion && suggestion !== currentValue && suggestion.toUpperCase().startsWith(currentValue.trim().toUpperCase())) {
              input.value = suggestion;
              renderSuggestion();
              event.preventDefault();
            }
          }
        });

        input.value = value;
        setAllowedCodes(currentAllowedCodes);
        setDisabled(isDisabled);

        const api = {
          root,
          input,
          close: () => {},
          getValue: () => String(input.value || '').trim(),
          setValue: (nextValue) => {
            input.value = String(nextValue || '').trim();
            renderSuggestion();
          },
          setAllowedCodes,
          setDisabled
        };

        renderSuggestion();
        return api;
      }

      dialog.className = 'modal-card big-account-selection-card';
      dialog.innerHTML = `
        <div class="dialog-header">
          <div class="dialog-title">请选择本次使用的大账号 / 币种</div>
          <div class="big-account-selection-toolbar">
            <button class="big-account-fixed-toggle${fixedEnabled ? ' is-active' : ''}" type="button" data-action="toggle-fixed" aria-pressed="${fixedEnabled ? 'true' : 'false'}">
              <span class="big-account-fixed-toggle-dot"></span>
              <span class="big-account-fixed-toggle-text">固定</span>
            </button>
            <button class="icon-close" type="button">×</button>
          </div>
        </div>
        <div class="big-account-selection-intro">从上到下的大账号依次为：</div>
        <div class="big-account-selection-rows"></div>
        <div class="dialog-actions right">
          <button class="primary-btn small" type="button" data-action="done">完成</button>
        </div>
      `;

      const rowsContainer = dialog.querySelector('.big-account-selection-rows');
      const fixedToggleBtn = dialog.querySelector('[data-action="toggle-fixed"]');

      function syncFixedToggle() {
        fixedToggleBtn.classList.toggle('is-active', fixedEnabled);
        fixedToggleBtn.setAttribute('aria-pressed', fixedEnabled ? 'true' : 'false');
      }

      rows.forEach((row, displayIndex) => {
        const rowIndex = Number.isInteger(row.index) ? row.index : displayIndex;
        const prefilledAssignment = fixedAssignmentsByRowIndex.get(rowIndex) || null;
        const wrapper = document.createElement('div');
        wrapper.className = 'big-account-selection-row-card';
        const accountSelect = document.createElement('select');
        accountSelect.className = 'mapping-select big-account-selection-account-select';
        accountSelect.innerHTML = [
          '<option value=""></option>',
          ...groupedBigAccounts.map((item) => `<option value="${escapeHtml(item.merchantId)}">${escapeHtml(item.merchantId)}</option>`)
        ].join('');
        const currencyControl = createCurrencyControl({
          value: prefilledAssignment?.currency || '',
          allowedCodes: [],
          disabled: false
        });

        wrapper.innerHTML = `
          <div class="big-account-selection-row-head">
            <span class="big-account-selection-index">${escapeHtml(row.label || `${displayIndex + 1}.`)}</span>
            <span class="big-account-selection-meta">${escapeHtml(row.fileName || '')}${row.sourceRowNumber ? ` 第${row.sourceRowNumber}行` : ''}</span>
          </div>
          <div class="big-account-selection-row-fields">
            <div class="big-account-selection-field">
              <span class="manual-balance-label">大账号</span>
            </div>
            <div class="big-account-selection-field">
              <span class="manual-balance-label">币种</span>
            </div>
          </div>
        `;

        const fields = wrapper.querySelector('.big-account-selection-row-fields');
        const accountField = fields.children[0];
        const currencyField = fields.children[1];
        accountField.appendChild(accountSelect);
        currencyField.appendChild(currencyControl.root);

        function syncAccountSelection() {
          const selectedAccount = groupedBigAccounts.find((item) => item.merchantId === accountSelect.value);
          const allowedCodes = selectedAccount?.currencies?.slice() || [];
          const isSingleCurrencyAccount = Boolean(selectedAccount) && !selectedAccount.isMultiCurrency && allowedCodes.length === 1;

          currencyControl.setAllowedCodes(allowedCodes);

          if (!selectedAccount) {
            currencyControl.setValue('');
            currencyControl.setDisabled(false);
            return;
          }

          if (isSingleCurrencyAccount) {
            currencyControl.setValue(allowedCodes[0]);
            currencyControl.setDisabled(true);
            return;
          }

          currencyControl.setDisabled(false);

          if (prefilledAssignment?.merchantId === selectedAccount.merchantId && prefilledAssignment.currency) {
            currencyControl.setValue(
              !allowedCodes.length || allowedCodes.includes(prefilledAssignment.currency)
                ? prefilledAssignment.currency
                : ''
            );
            return;
          }

          if (allowedCodes.length === 1 && !currencyControl.getValue()) {
            currencyControl.setValue(allowedCodes[0]);
          }
        }

        accountSelect.addEventListener('change', syncAccountSelection);
        accountSelect.value = prefilledAssignment?.merchantId || '';
        syncAccountSelection();

        rowControls.push({
          rowIndex,
          accountSelect,
          currencyControl
        });
        currencyControls.push(currencyControl);
        rowsContainer.appendChild(wrapper);
      });

      fixedToggleBtn.addEventListener('click', () => {
        fixedEnabled = !fixedEnabled;
        syncFixedToggle();
      });
      syncFixedToggle();

      dialog.querySelector('.icon-close').addEventListener('click', closeModal);
      dialog.querySelector('[data-action="done"]').addEventListener('click', async () => {
        const assignments = rowControls.map((control) => ({
          rowIndex: control.rowIndex,
          merchantId: String(control.accountSelect.value || '').trim(),
          currency: control.currencyControl.getValue()
        }));
        const invalidAssignment = assignments.find((item) => !item.merchantId || !item.currency);

        if (invalidAssignment) {
          setStatus('请先为每一行选择大账号和币种', 'error');
          return;
        }

        const result = await desktopApi.files.completeBigAccountSelection({
          assignments,
          fixed: fixedEnabled
        });

        closeModal();
        applyStatementResult(result);

        if (result.status === 'error' && !result.manualBalancePromptReady) {
          openModal(createAlertDialog(result.message));
        }
      });

      overlay.addEventListener('mousedown', (event) => {
        currencyControls.forEach((control) => {
          if (!control.root.contains(event.target)) {
            control.close();
          }
        });
      });

      overlay.appendChild(dialog);
      return overlay;
    }

    function createBigAccountManagerDialog({ bigAccounts, templateId, templateName, onDone, onCancel }) {
      const overlay = createOverlay();
      const dialog = document.createElement('div');
      let pendingOwnAccounts = null;
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
        if (!templateName) {
          setStatus('请先选择模板', 'error');
          return;
        }
        const bigAccountSnapshot = Array.from(tbody.querySelectorAll('tr[data-big-account-row]'))
          .filter((row) => row.dataset.mode === 'view')
          .map((row) => {
            const merchantId = row.querySelector('.big-account-merchant-view')?.textContent?.trim() || '';
            const isMultiCurrency = row.querySelector('.big-account-multi-checkbox')?.checked || false;
            const currencyText = row.querySelector('.big-account-currency-view')?.title || '';
            const currencies = isMultiCurrency
              ? currencyText.split('、').filter(Boolean)
              : [currencyText].filter(Boolean);
            return { merchantId, currencies, isMultiCurrency };
          })
          .filter((item) => item.merchantId);
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
      const currentBigAccounts = cloneBigAccountItems(payload.bigAccounts || []);
      const currentFixedAssignments = Array.isArray(payload.fixedAssignments)
        ? payload.fixedAssignments.map((item) => ({
            merchantId: String(item.merchantId || ''),
            currency: String(item.currency || ''),
            rowIndex: Number(item.rowIndex || 0)
          }))
        : [];
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

        const row = document.createElement('tr');
        row.dataset.templateField = fieldName;
        const isBalanceField = fieldName === 'Balance';
        const isMerchantIdField = fieldName === 'MerchantId';
        const isAdvancedField = advancedMappingFields.includes(fieldName);
        const supportsSelfInputOption = isMerchantIdField;
        const supportsMultiSelect = !isBalanceField && !supportsSelfInputOption && !isAdvancedField;
        const savedMapping = savedMap.get(fieldName) || {
          mappedField: isBalanceField ? BALANCE_DISABLED_OPTION : '',
          mappedFields: [],
          customValue: '',
          isMultiBigAccount: false
        };
        const selectOptions = [isBalanceField ? `<option value="${BALANCE_DISABLED_OPTION}">${BALANCE_DISABLED_OPTION}</option>` : '<option value=""></option>']
          .concat(isBalanceField ? [`<option value="${BALANCE_CALCULATED_OPTION}">${BALANCE_CALCULATED_OPTION}</option>`] : [])
          .concat(supportsSelfInputOption ? [`<option value="${MERCHANT_ID_SELF_INPUT_OPTION}">${MERCHANT_ID_SELF_INPUT_OPTION}</option>`] : [])
          .concat(supportsMultiSelect ? [`<option value="${CONCAT_FIELDS_MAPPING_FIELD}">${CONCAT_FIELDS_MAPPING_FIELD}</option>`] : [])
          .concat(headerOptions)
          .join('');
        row.innerHTML = `
          <td>${escapeHtml(fieldName)}</td>
          <td>
            <div class="mapping-field-editor">
              <select class="mapping-select">${selectOptions}</select>
              ${isMerchantIdField ? `
                <button class="secondary-btn small mapping-big-account-manage-btn" type="button" hidden>维护大账号</button>
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
        const concatFieldPicker = row.querySelector('.concat-field-picker');
        const concatPickerTrigger = row.querySelector('.concat-picker-trigger');
        const concatPickerPanel = row.querySelector('.concat-picker-panel');
        const concatPreview = row.querySelector('.concat-preview');
        let concatSelectedFields = [];
        const savedFields = Array.isArray(savedMapping.mappedFields) && savedMapping.mappedFields.length
          ? savedMapping.mappedFields
          : (savedMapping.mappedField ? [savedMapping.mappedField] : []);
        const isSavedConcatMode = savedMapping.mappedField === CONCAT_FIELDS_MAPPING_FIELD;

        if (isSavedConcatMode) {
          select.value = CONCAT_FIELDS_MAPPING_FIELD;
          concatSelectedFields = Array.isArray(savedMapping.mappedFields) ? savedMapping.mappedFields.slice() : [];
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

          if (manageBigAccountBtn) {
            manageBigAccountBtn.hidden = !isCustomInput;
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
                  await window.desktopApi.bigAccount.saveOwnAccounts({
                    templateId: payload.template.id,
                    accounts: extra.ownAccounts
                  });
                }
                openModal(createMappingDialog({
                  ...payload,
                  mappings: draftMappings.map((mapping) => {
                    return mapping.templateField === 'MerchantId'
                      ? { ...mapping, mappedField: MERCHANT_ID_SELF_INPUT_OPTION, mappedFields: [] }
                      : mapping;
                  }),
                  bigAccounts: nextBigAccounts,
                  fixedAssignments: currentFixedAssignments
                }));
              },
              onCancel: () => {
                openModal(createMappingDialog({
                  ...payload,
                  mappings: draftMappings,
                  bigAccounts: currentBigAccounts,
                  fixedAssignments: currentFixedAssignments
                }));
              }
            }));
          });
        }

        select.addEventListener('change', syncEditorState);
        syncEditorState();
        rowByField.set(fieldName, row);
        tbody.appendChild(row);
      });

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
                fixedAssignments: currentFixedAssignments
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
          if (record.currency) currencySelect.value = record.currency;
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
