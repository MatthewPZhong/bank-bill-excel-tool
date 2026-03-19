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

    function createManualBalanceSeedDialog(prompt, draft = {}) {
      const overlay = createOverlay();
      const dialog = document.createElement('div');
      dialog.className = 'modal-card manual-balance-card';
      const queueIndex = Number.isInteger(prompt?.queueIndex) && prompt.queueIndex > 0 ? prompt.queueIndex : 1;
      const queueTotal = Number.isInteger(prompt?.queueTotal) && prompt.queueTotal > 0 ? prompt.queueTotal : 1;
      const merchantId = prompt?.merchantId || 'N/A';
      const currency = prompt?.currency || '(空)';
      const targetBillDate = prompt?.targetBillDate || 'N/A';
      dialog.innerHTML = `
        <div class="dialog-header">
          <div class="dialog-title">补录上一账单日余额</div>
          <button class="icon-close" type="button">×</button>
        </div>
        <div class="manual-balance-context">
          <div class="manual-balance-progress">第 ${queueIndex} 个，共 ${queueTotal} 个</div>
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
      dialog.querySelector('.icon-close').addEventListener('click', closeModal);
      dialog.querySelector('[data-action="done"]').addEventListener('click', async () => {
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
                closeModal();
                applyStatementResult(overwriteResult);
              }
            })
          );
          return;
        }

        closeModal();
        applyStatementResult(result);

        if (result.status === 'error' && !result.manualBalancePromptReady) {
          openModal(createAlertDialog(result.message));
        }
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

        return {
          templateField: row.dataset.templateField,
          mappedField: mappedFields[0] || '',
          mappedFields: mappedFields.length > 1 ? mappedFields : [],
          customValue: '',
          isMultiBigAccount: false
        };
      });
    }

    function createMappingOrderDialog({ mappings, onConfirm, onCancel }) {
      const overlay = createOverlay();
      const dialog = document.createElement('div');
      dialog.className = 'modal-card manager-card mapping-order-card';
      dialog.innerHTML = `
        <div class="dialog-header">
          <div class="dialog-title">多选字段顺序确认</div>
          <button class="icon-close" type="button">×</button>
        </div>
        <div class="mapping-order-intro">已检测到多选映射，请确认各字段的拼接顺序。</div>
        <div class="mapping-order-groups"></div>
        <div class="dialog-actions right">
          <button class="secondary-btn small" type="button" data-action="cancel">取消</button>
          <button class="primary-btn small" type="button" data-action="confirm">确认并保存</button>
        </div>
      `;

      const groups = dialog.querySelector('.mapping-order-groups');
      const drafts = mappings.map((mapping) => ({
        ...mapping,
        mappedFields: Array.isArray(mapping.mappedFields) ? mapping.mappedFields.slice() : []
      }));

      function renderGroups() {
        groups.innerHTML = '';

        drafts.forEach((mapping) => {
          const block = document.createElement('section');
          block.className = 'mapping-order-group';
          const rows = mapping.mappedFields.map((fieldName, index) => `
            <div class="mapping-order-row" data-index="${index}">
              <span class="mapping-order-index">${index + 1}.</span>
              <span class="mapping-order-name">${escapeHtml(fieldName)}</span>
              <div class="mapping-order-actions">
                <button class="text-action" type="button" data-action="up" ${index === 0 ? 'disabled' : ''}>上移</button>
                <button class="text-action" type="button" data-action="down" ${index === mapping.mappedFields.length - 1 ? 'disabled' : ''}>下移</button>
              </div>
            </div>
          `).join('');

          block.innerHTML = `
            <div class="mapping-order-group-title">${escapeHtml(mapping.templateField)}</div>
            <div class="mapping-order-list">${rows}</div>
            <div class="mapping-order-preview">预览结果：${escapeHtml(mapping.mappedFields.join(' + '))}</div>
          `;

          block.querySelectorAll('[data-action]').forEach((button) => {
            button.addEventListener('click', () => {
              const rowIndex = Number(button.closest('.mapping-order-row')?.dataset.index || -1);

              if (rowIndex < 0) {
                return;
              }

              const nextIndex = button.dataset.action === 'up' ? rowIndex - 1 : rowIndex + 1;

              if (nextIndex < 0 || nextIndex >= mapping.mappedFields.length) {
                return;
              }

              const nextFields = mapping.mappedFields.slice();
              const [moved] = nextFields.splice(rowIndex, 1);
              nextFields.splice(nextIndex, 0, moved);
              mapping.mappedFields = nextFields;
              renderGroups();
            });
          });

          groups.appendChild(block);
        });
      }

      dialog.querySelector('.icon-close').addEventListener('click', onCancel);
      dialog.querySelector('[data-action="cancel"]').addEventListener('click', onCancel);
      dialog.querySelector('[data-action="confirm"]').addEventListener('click', () => {
        onConfirm(drafts);
      });

      renderGroups();
      overlay.appendChild(dialog);
      return overlay;
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
          <button class="new-account-input new-account-currency-dropdown-btn big-account-selection-dropdown-btn" type="button" aria-expanded="false"></button>
          <div class="new-account-currency-dropdown-panel big-account-selection-dropdown-panel" hidden></div>
        `;

        const ghostInput = root.querySelector('.enum-ghost-input');
        const input = root.querySelector('.big-account-selection-currency-input');
        const button = root.querySelector('.big-account-selection-dropdown-btn');
        const panel = root.querySelector('.big-account-selection-dropdown-panel');
        let currentAllowedCodes = allowedCodes.slice();
        let isDisabled = disabled;

        function renderSuggestion() {
          const suggestion = isDisabled ? '' : getCurrencySuggestion(input.value, currentAllowedCodes);
          ghostInput.value = suggestion;
          return suggestion;
        }

        function renderPanel() {
          panel.replaceChildren();
          const visibleOptions = currencyOptions.filter((option) => {
            return !currentAllowedCodes.length || currentAllowedCodes.includes(option.code);
          });

          if (!visibleOptions.length) {
            const emptyState = document.createElement('div');
            emptyState.className = 'new-account-currency-option';
            emptyState.innerHTML = '<span class="new-account-currency-option-text">无可选币种</span>';
            panel.appendChild(emptyState);
            return;
          }

          visibleOptions.forEach((option) => {
            const optionButton = document.createElement('button');
            optionButton.className = 'new-account-currency-option big-account-selection-option';
            optionButton.type = 'button';
            optionButton.textContent = option.label;
            optionButton.addEventListener('click', () => {
              input.value = option.code;
              renderSuggestion();
              closePanel();
            });
            panel.appendChild(optionButton);
          });
        }

        function closePanel() {
          panel.hidden = true;
          button.classList.remove('is-open');
          button.setAttribute('aria-expanded', 'false');
        }

        function openPanel() {
          if (isDisabled) {
            return;
          }

          currencyControls.forEach((control) => {
            if (control !== api) {
              control.close();
            }
          });
          renderPanel();
          panel.hidden = false;
          button.classList.add('is-open');
          button.setAttribute('aria-expanded', 'true');
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
          button.disabled = isDisabled;

          if (isDisabled) {
            closePanel();
          }

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
        button.addEventListener('click', () => {
          if (panel.hidden) {
            openPanel();
            return;
          }

          closePanel();
        });

        input.value = value;
        setAllowedCodes(currentAllowedCodes);
        setDisabled(isDisabled);

        const api = {
          root,
          input,
          close: closePanel,
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

    function createBigAccountManagerDialog({ bigAccounts, onDone, onCancel }) {
      const overlay = createOverlay();
      const dialog = document.createElement('div');
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
          <button class="secondary-btn small" type="button" data-action="add">新增</button>
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
              <select class="mapping-select big-account-currency-select">${currencySelectOptions}</select>
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
        const select = row.querySelector('.big-account-currency-select');
        const dropdownWrap = row.querySelector('.big-account-currency-dropdown-wrap');
        const dropdownButton = row.querySelector('.big-account-currency-dropdown-btn');
        const multiCheckbox = row.querySelector('.big-account-multi-checkbox');
        const currencyEditor = row.querySelector('.big-account-currency-editor');
        const currencyView = row.querySelector('.big-account-currency-view');
        const toggleCompleteBtn = row.querySelector('[data-action="toggle-complete"]');
        let selectedCurrencies = Array.isArray(item.currencies) ? item.currencies.slice() : [];

        multiCheckbox.checked = Boolean(item.isMultiCurrency);
        if (!multiCheckbox.checked) {
          select.value = selectedCurrencies[0] || '';
        }

        function getRowDraft() {
          return {
            merchantId: merchantInput.value.trim(),
            isMultiCurrency: multiCheckbox.checked,
            currencies: multiCheckbox.checked
              ? Array.from(new Set(selectedCurrencies.filter((value) => value)))
              : [select.value].filter((value) => value !== '')
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
          select.hidden = isMultiCurrency;
          dropdownWrap.hidden = !isMultiCurrency;

          if (!isMultiCurrency) {
            if (activeFloatingDropdown?.button === dropdownButton) {
              cleanupFloatingDropdown();
            }
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
        select.addEventListener('change', () => {
          if (row.dataset.mode === 'view') {
            return;
          }

          currencyView.textContent = select.value;
          currencyView.title = select.value;
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
            : [row.querySelector('.big-account-currency-select').value].filter((value) => value !== '');

          return {
            merchantId,
            currencies,
            isMultiCurrency
          };
        }).filter((item) => item.merchantId !== '' && item.currencies.length > 0);

        cleanupFloatingDropdown();
        document.removeEventListener('keydown', handleKeydown);
        onDone(nextBigAccounts);
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
          .concat(headerOptions)
          .join('');
        row.innerHTML = `
          <td>${escapeHtml(fieldName)}</td>
          <td>
            <div class="mapping-field-editor">
              <select class="mapping-select${supportsMultiSelect ? ' mapping-multi-select' : ''}" ${supportsMultiSelect ? 'multiple size="6"' : ''}>${selectOptions}</select>
              ${isMerchantIdField ? `
                <button class="secondary-btn small mapping-big-account-manage-btn" type="button" hidden>维护大账号</button>
              ` : ''}
            </div>
          </td>
        `;

        const select = row.querySelector('.mapping-select');
        const manageBigAccountBtn = row.querySelector('.mapping-big-account-manage-btn');
        const savedFields = Array.isArray(savedMapping.mappedFields) && savedMapping.mappedFields.length
          ? savedMapping.mappedFields
          : (savedMapping.mappedField ? [savedMapping.mappedField] : []);

        if (supportsMultiSelect) {
          Array.from(select.options).forEach((option) => {
            option.selected = savedFields.includes(option.value);
          });
        } else {
          select.value = savedMapping.mappedField || (isBalanceField ? BALANCE_DISABLED_OPTION : '');
        }

        function syncEditorState() {
          const isCustomInput = getSelectValues(select)[0] === MERCHANT_ID_SELF_INPUT_OPTION;

          if (manageBigAccountBtn) {
            manageBigAccountBtn.hidden = !isCustomInput;
          }
        }

        if (manageBigAccountBtn) {
          manageBigAccountBtn.addEventListener('click', () => {
            const draftMappings = collectMappingDraftFromTable(tbody);
            openModal(createBigAccountManagerDialog({
              bigAccounts: currentBigAccounts,
              onDone: (nextBigAccounts) => {
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

        const multiSelectMappings = draftMappings.filter((mapping) => Array.isArray(mapping.mappedFields) && mapping.mappedFields.length > 1);

        if (multiSelectMappings.length) {
          openModal(createMappingOrderDialog({
            mappings: multiSelectMappings,
            onConfirm: (orderedMappings) => {
              const orderedMap = new Map(orderedMappings.map((mapping) => [mapping.templateField, mapping.mappedFields.slice()]));
              const nextMappings = draftMappings.map((mapping) => {
                const orderedFields = orderedMap.get(mapping.templateField);

                if (!orderedFields) {
                  return mapping;
                }

                return {
                  ...mapping,
                  mappedField: orderedFields[0] || '',
                  mappedFields: orderedFields
                };
              });
              saveMappings(nextMappings).catch((error) => {
                console.error(error);
                setStatus('模板映射保存失败，请查看控制台', 'error');
              });
            },
            onCancel: () => {
              openModal(createMappingDialog({
                ...payload,
                mappings: draftMappings,
                bigAccounts: draftBigAccounts,
                fixedAssignments: currentFixedAssignments
              }));
            }
          }));
          return;
        }

        saveMappings(draftMappings).catch((error) => {
          console.error(error);
          setStatus('模板映射保存失败，请查看控制台', 'error');
        });
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
                <th>网银大账户ID</th>
                <th>清结算系统大账户ID</th>
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

      function createInputRow(bankAccountId = '', clearingAccountId = '') {
        const row = document.createElement('tr');
        const bankCell = document.createElement('td');
        const clearingCell = document.createElement('td');
        const bankInput = document.createElement('input');
        const clearingInput = document.createElement('input');

        bankInput.className = 'mapping-text-input';
        bankInput.type = 'text';
        bankInput.spellcheck = false;
        bankInput.value = bankAccountId;

        clearingInput.className = 'mapping-text-input';
        clearingInput.type = 'text';
        clearingInput.spellcheck = false;
        clearingInput.value = clearingAccountId;

        bankCell.appendChild(bankInput);
        clearingCell.appendChild(clearingInput);
        row.append(bankCell, clearingCell);
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
        tbody.appendChild(createInputRow(mapping.bankAccountId, mapping.clearingAccountId));
      });
      tbody.appendChild(createAddRow());

      dialog.querySelector('.icon-close').addEventListener('click', closeModal);
      dialog.querySelector('[data-action="done"]').addEventListener('click', async () => {
        const mappings = Array.from(dialog.querySelectorAll('.mapping-text-input'))
          .reduce((accumulator, input, index) => {
            const rowIndex = Math.floor(index / 2);

            if (!accumulator[rowIndex]) {
              accumulator[rowIndex] = {
                bankAccountId: '',
                clearingAccountId: ''
              };
            }

            if (index % 2 === 0) {
              accumulator[rowIndex].bankAccountId = input.value;
            } else {
              accumulator[rowIndex].clearingAccountId = input.value;
            }

            return accumulator;
          }, []);

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
