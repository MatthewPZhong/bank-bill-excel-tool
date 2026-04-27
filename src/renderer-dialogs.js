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
        <div class="alert-body">
          <div class="alert-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="28" height="28"><defs><linearGradient id="alertIconG" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#4285F4"/><stop offset="100%" stop-color="#9B72F2"/></linearGradient></defs><circle cx="12" cy="12" r="10" fill="none" stroke="url(#alertIconG)" stroke-width="2"/><path d="M12 7v6M12 16v1" stroke="url(#alertIconG)" stroke-width="2" stroke-linecap="round"/></svg>
          </div>
          <div class="alert-message">${message}</div>
        </div>
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

    function createConfirmDialog({ message, confirmText, cancelText, onConfirm, onCancel }) {
      const overlay = createOverlay();
      const dialog = document.createElement('div');
      dialog.className = 'modal-card alert-card';
      dialog.innerHTML = `
        <div class="alert-body">
          <div class="alert-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="28" height="28"><defs><linearGradient id="confirmIconG" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#E95EA2"/><stop offset="100%" stop-color="#F6B93B"/></linearGradient></defs><path d="M12 3L2 20h20L12 3z" fill="none" stroke="url(#confirmIconG)" stroke-width="2" stroke-linejoin="round"/><path d="M12 10v4M12 17h.01" stroke="url(#confirmIconG)" stroke-width="2" stroke-linecap="round"/></svg>
          </div>
          <div class="alert-message">${message}</div>
        </div>
        <div class="dialog-actions center">
          <button class="danger-btn small" type="button" data-action="confirm">${confirmText}</button>
          <button class="secondary-btn small" type="button" data-action="cancel">${cancelText}</button>
        </div>
      `;
      dialog.querySelector('[data-action="confirm"]').addEventListener('click', async () => {
        await onConfirm();
      });
      dialog.querySelector('[data-action="cancel"]').addEventListener('click', () => {
        if (onCancel) onCancel();
        closeModal();
      });
      overlay.appendChild(dialog);
      return overlay;
    }

    function createExportScopeDialog(kind) {
      const overlay = createOverlay();
      const dialog = document.createElement('div');
      const fieldLabel = kind === 'detail' ? '明细' : '余额';
      dialog.className = 'modal-card alert-card export-scope-card';
      dialog.innerHTML = `
        <div class="alert-body">
          <div class="alert-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="28" height="28"><defs><linearGradient id="exportScopeIconG" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#4285F4"/><stop offset="100%" stop-color="#9B72F2"/></linearGradient></defs><circle cx="12" cy="12" r="10" fill="none" stroke="url(#exportScopeIconG)" stroke-width="2"/><path d="M12 7v6M12 16v1" stroke="url(#exportScopeIconG)" stroke-width="2" stroke-linecap="round"/></svg>
          </div>
          <div class="alert-message">请选择要导出的范围</div>
        </div>
        <div class="dialog-actions vertical">
          <button class="secondary-btn small export-scope-btn" type="button" data-scope="current">导出当前批次文件的${fieldLabel}</button>
          <button class="secondary-btn small export-scope-btn" type="button" data-scope="all">导出所有批次文件的${fieldLabel}</button>
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

    // v1.5.3 R1 (T1.7)：导出月度余额账单模式下点"导出余额"弹出的模板 + 年月选择对话框（PRD §5.1.2）
    // 完成按钮调 desktopApi.monthlyBalance.assemble → ready 关窗 + 主页面状态栏提示；
    // empty/error 保留弹窗等用户修改（createAlertDialog 弹错后通过 onConfirm 重开本弹窗）
    //
    // 参数：
    //   onAssembleReady(summary) —— 装配成功后由调用方（handleExportBalance 分流）接收 summary 更新 state
    function createMonthlyBalanceExportDialog({ onAssembleReady } = {}) {
      const overlay = createOverlay();
      const dialog = document.createElement('div');
      dialog.className = 'modal-card alert-card monthly-balance-export-card';

      const now = new Date();
      const currentYear = now.getFullYear();
      // PRD Q13：近 10 年 ~ 今年+1（2026 当下可选 2016~2027）
      const yearOptions = [];
      for (let y = currentYear - 9; y <= currentYear + 1; y += 1) {
        yearOptions.push(y);
      }

      // PRD Q5 "普通模板"：排除子模板、主模板、虚拟 ID（虚拟 ID 本就不在 state.templates 里）
      const regularTemplates = (state.templates || []).filter((template) => {
        if (!template) return false;
        if (template.isParent) return false;
        if (template.parentTemplateId) return false;
        return true;
      });

      const templateOptionsHtml = [
        '<option value="__ALL_BANKS__" selected>全部银行渠道</option>',
        ...regularTemplates.map((template) => {
          const label = escapeHtml(String(template.name || ''));
          return `<option value="${label}">${label}</option>`;
        })
      ].join('');

      const yearOptionsHtml = yearOptions
        .map((y) => `<option value="${y}">${y} 年</option>`)
        .join('');
      const monthOptionsHtml = Array.from({ length: 12 }, (_, i) => i + 1)
        .map((m) => `<option value="${m}">${m} 月</option>`)
        .join('');

      dialog.innerHTML = `
        <div class="dialog-header">
          <div class="dialog-title">请选择需要导出月度余额账单的银行渠道</div>
          <button class="icon-close" type="button" data-action="close">×</button>
        </div>
        <div class="monthly-balance-form">
          <label class="monthly-balance-row">
            <span class="monthly-balance-label">模板</span>
            <select class="monthly-balance-template-select mapping-text-input" data-role="template">
              ${templateOptionsHtml}
            </select>
          </label>
          <label class="monthly-balance-row">
            <span class="monthly-balance-label">时间</span>
            <div class="monthly-balance-time-picker">
              <select class="monthly-balance-year-select mapping-text-input" data-role="year">
                <option value="" selected>-- 选择年份 --</option>
                ${yearOptionsHtml}
              </select>
              <select class="monthly-balance-month-select mapping-text-input" data-role="month">
                <option value="" selected>-- 选择月份 --</option>
                ${monthOptionsHtml}
              </select>
            </div>
          </label>
        </div>
        <div class="dialog-actions right">
          <button class="primary-btn small" type="button" data-action="done">完成</button>
        </div>
      `;

      const templateSel = dialog.querySelector('[data-role="template"]');
      const yearSel = dialog.querySelector('[data-role="year"]');
      const monthSel = dialog.querySelector('[data-role="month"]');

      function currentDraft() {
        return {
          templateValue: templateSel.value || '',
          year: yearSel.value ? Number(yearSel.value) : null,
          month: monthSel.value ? Number(monthSel.value) : null
        };
      }

      function reopenWith(draft) {
        const next = createMonthlyBalanceExportDialog({ onAssembleReady });
        const nextTemplateSel = next.querySelector('[data-role="template"]');
        const nextYearSel = next.querySelector('[data-role="year"]');
        const nextMonthSel = next.querySelector('[data-role="month"]');
        if (nextTemplateSel) nextTemplateSel.value = draft.templateValue || '__ALL_BANKS__';
        if (nextYearSel) nextYearSel.value = draft.year ? String(draft.year) : '';
        if (nextMonthSel) nextMonthSel.value = draft.month ? String(draft.month) : '';
        openModal(next);
      }

      dialog.querySelector('[data-action="close"]').addEventListener('click', () => {
        closeModal();
      });

      dialog.querySelector('[data-action="done"]').addEventListener('click', async () => {
        const draft = currentDraft();
        const hasTemplate = draft.templateValue !== '' && draft.templateValue !== null && draft.templateValue !== undefined;
        const hasTime = Number.isInteger(draft.year) && Number.isInteger(draft.month);

        // E1 / E2 / E3：本地校验，弹 createAlertDialog 后重开本弹窗保留已填值
        if (!hasTemplate && !hasTime) {
          closeModal();
          openModal(createAlertDialog('请选择模板和时间', {
            onConfirm: () => reopenWith(draft)
          }));
          return;
        }
        if (!hasTemplate) {
          closeModal();
          openModal(createAlertDialog('请选择模板', {
            onConfirm: () => reopenWith(draft)
          }));
          return;
        }
        if (!hasTime) {
          closeModal();
          openModal(createAlertDialog('请选择时间', {
            onConfirm: () => reopenWith(draft)
          }));
          return;
        }

        // 后端装配
        const useAll = draft.templateValue === '__ALL_BANKS__';
        const payload = {
          templateScope: useAll ? 'all' : 'single',
          templateName: useAll ? '' : draft.templateValue,
          year: draft.year,
          month: draft.month
        };

        let result;
        try {
          result = await desktopApi.monthlyBalance.assemble(payload);
        } catch (error) {
          closeModal();
          openModal(createAlertDialog(`装配月度余额账单失败：${error?.message || error}`, {
            onConfirm: () => reopenWith(draft)
          }));
          return;
        }

        if (result && result.status === 'ready') {
          closeModal();
          if (typeof onAssembleReady === 'function') {
            onAssembleReady(result.summary);
          }
          return;
        }
        if (result && result.status === 'empty') {
          closeModal();
          openModal(createAlertDialog(result.message || '该模板 / 月份范围内无余额数据', {
            onConfirm: () => reopenWith(draft)
          }));
          return;
        }
        // status === 'error' 或其它失败
        closeModal();
        openModal(createAlertDialog(result?.message || '装配月度余额账单失败', {
          onConfirm: () => reopenWith(draft)
        }));
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
      return bigAccounts.map((item) => {
        // v1.5.3 R2：保留 accountNature（'client' / 'own'），缺省 'client'
        const rawNature = typeof item.accountNature === 'string' ? item.accountNature.trim() : '';
        return {
          merchantId: String(item.merchantId || ''),
          currencies: Array.isArray(item.currencies) ? item.currencies.slice() : [],
          isMultiCurrency: Boolean(item.isMultiCurrency),
          accountNature: rawNature === 'own' ? 'own' : 'client'
        };
      });
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
          <div class="dialog-title">网银账单解析大账号确认</div>
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
          <div class="ba-scroll-container">
            <div class="big-account-split-left">
              <div class="big-account-split-header">文件顺序：</div>
              <div class="big-account-file-list"></div>
            </div>
            <div class="big-account-split-right">
              <div class="big-account-split-header">大账号顺序：</div>
              <div class="big-account-order-list"></div>
            </div>
          </div>
        </div>
        <div class="dialog-actions big-account-selection-footer">
          <button class="secondary-btn small extract-order-btn" type="button" data-action="extract-order">提取大账号顺序</button>
          <!-- v1.5.2 需求 2：多对一工具条（block 粒度，决策 ①B）-->
          <label class="ba-multi-mode-label">
            <input class="new-account-checkbox ba-multi-mode-checkbox" type="checkbox" />
            <span>单个账号匹多个文件</span>
          </label>
          <button class="secondary-btn small ba-multi-toggle-btn is-hidden" type="button">编辑</button>
          <span class="big-account-search-label">定位大账号</span>
          <input class="mapping-text-input big-account-search-input" type="text" spellcheck="false" />
          <label class="big-account-remember-label is-disabled">
            <input class="new-account-checkbox big-account-remember-checkbox" type="checkbox" />
            <span>记住顺序</span>
          </label>
          <button class="primary-btn small" type="button" data-action="done">完成</button>
        </div>
      `;

      const modeSelect = dialog.querySelector('.big-account-mode-select');
      const scrollContainer = dialog.querySelector('.ba-scroll-container');
      const fileListContainer = dialog.querySelector('.big-account-file-list');
      const orderListContainer = dialog.querySelector('.big-account-order-list');
      const searchInput = dialog.querySelector('.big-account-search-input');
      const extractOrderBtn = dialog.querySelector('[data-action="extract-order"]');
      const rememberLabel = dialog.querySelector('.big-account-remember-label');
      const rememberCheckbox = dialog.querySelector('.big-account-remember-checkbox');
      const doneBtn = dialog.querySelector('[data-action="done"]');
      // v1.5.2 需求 2：多对一工具条 DOM 引用
      const multiModeCheckbox = dialog.querySelector('.ba-multi-mode-checkbox');
      const multiToggleBtn = dialog.querySelector('.ba-multi-toggle-btn');

      // v1.5.2 需求 2（决策 ①B）：多对一状态机
      //   - multiMode：是否启用"单个账号匹多个文件"；默认 false（不勾选）
      //   - multiEditing：是否处于编辑态；默认 false
      let multiMode = false;
      let multiEditing = false;
      let multiGroups = [];
      let pendingGroup = null;

      let isRememberMode = false;

      // 左右面板同步滚动（仅在非记住顺序模式下生效）
      let mainSyncingScroll = false;
      fileListContainer.addEventListener('scroll', () => {
        if (isRememberMode || mainSyncingScroll) return;
        mainSyncingScroll = true;
        orderListContainer.scrollTop = fileListContainer.scrollTop;
        mainSyncingScroll = false;
      });
      orderListContainer.addEventListener('scroll', () => {
        if (isRememberMode || mainSyncingScroll) return;
        mainSyncingScroll = true;
        fileListContainer.scrollTop = orderListContainer.scrollTop;
        mainSyncingScroll = false;
      });

      function truncateFileName(fileName, maxLen) {
        if (!fileName || fileName.length <= maxLen) return fileName || '';
        const keepStart = 6;
        const keepEnd = 10;
        if (fileName.length <= keepStart + keepEnd + 3) return fileName;
        return fileName.slice(0, keepStart) + '...' + fileName.slice(-keepEnd);
      }

      // 获取某 rowIndex 对应的组字母；无组则返回空串
      function getGroupLetter(rowIndex) {
        const closedIdx = multiGroups.findIndex((g) => g.leftBlockRowIndices.includes(rowIndex));
        if (closedIdx >= 0) return String.fromCharCode(97 + closedIdx);
        if (pendingGroup && pendingGroup.leftBlockRowIndices.includes(rowIndex)) {
          return String.fromCharCode(97 + multiGroups.length);
        }
        return '';
      }

      function renderFileList() {
        fileListContainer.innerHTML = '';

        // v1.5.2：构建显示行列表
        let displayRows = currentFileRows.map((row, index) => ({
          row,
          originalIndex: index,
          rowIndex: Number.isInteger(row.index) ? row.index : index,
          covered: multiMode && isRowIndexCovered(Number.isInteger(row.index) ? row.index : index)
        }));
        // 编辑态：保持原始顺序，不移动 block
        // 完成态：uncovered 在前（原序），covered 在后（按组 a→z 排，组内按原文件顺序）
        if (multiMode && !multiEditing && multiGroups.length > 0) {
          const uncovered = displayRows.filter((r) => !r.covered);
          const covered = displayRows.filter((r) => r.covered);
          covered.sort((a, b) => {
            const gA = multiGroups.findIndex((g) => g.leftBlockRowIndices.includes(a.rowIndex));
            const gB = multiGroups.findIndex((g) => g.leftBlockRowIndices.includes(b.rowIndex));
            if (gA !== gB) return gA - gB; // 组间 a→z
            return a.originalIndex - b.originalIndex; // 组内原文件顺序
          });
          displayRows = uncovered.concat(covered);
        }

        let uncoveredSeq = 0;
        displayRows.forEach((entry) => {
          const { row, rowIndex, covered } = entry;
          const item = document.createElement('div');
          item.className = 'big-account-file-item ba-file-row';
          item.dataset.rowIndex = String(rowIndex);
          if (Number.isInteger(row.fileIndex)) {
            item.dataset.fileIndex = String(row.fileIndex);
          }
          const fullName = row.fileName || '';
          const rowSuffix = row.sourceRowNumber ? ` 第${row.sourceRowNumber}行` : '';
          const displayName = truncateFileName(fullName, 20) + rowSuffix;
          const fullMeta = fullName + rowSuffix;

          if (multiMode && multiEditing) {
            // 编辑态：勾选框 + 字母列 + 文件名
            item.classList.add('ba-multi-editing');
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.className = 'ba-left-block-checkbox';
            checkbox.dataset.rowIndex = String(rowIndex);
            checkbox.checked = isRowIndexCovered(rowIndex);
            checkbox.addEventListener('change', () => {
              onLeftBlockChecked(rowIndex, checkbox.checked);
            });
            const letterSpan = document.createElement('span');
            letterSpan.className = 'big-account-order-index ba-left-letter';
            const letter = getGroupLetter(rowIndex);
            letterSpan.textContent = letter ? `${letter}.` : '';
            if (letter) letterSpan.classList.add('big-account-order-index--alpha');
            const meta = document.createElement('span');
            meta.className = 'big-account-file-meta ba-file-name';
            meta.title = fullMeta;
            meta.textContent = displayName;
            item.append(checkbox, letterSpan, meta);
          } else if (multiMode && !multiEditing && covered) {
            // 闭合态已入组 block��显示 "✓ a. 文件名 → 大账号"
            item.classList.add('ba-multi-grouped');
            const groupInfo = findGroupByRowIndex(rowIndex);
            const group = groupInfo ? multiGroups[groupInfo.groupIndex] : null;
            const markerSpan = document.createElement('span');
            markerSpan.className = 'ba-multi-group-marker';
            markerSpan.textContent = '✓';
            const letterSpan = document.createElement('span');
            letterSpan.className = 'big-account-order-index ba-left-letter big-account-order-index--alpha';
            letterSpan.textContent = group ? `${String.fromCharCode(97 + groupInfo.groupIndex)}.` : '';
            const meta = document.createElement('span');
            meta.className = 'big-account-file-meta ba-file-name';
            meta.title = fullMeta;
            meta.textContent = group ? `${displayName} → ${group.rightAccount.merchantId} ${group.rightAccount.currency}` : displayName;
            item.append(markerSpan, letterSpan, meta);
          } else if (multiMode) {
            // multiMode 但未入组：字母列留空 + 数字序号
            uncoveredSeq += 1;
            const letterSpan = document.createElement('span');
            letterSpan.className = 'big-account-order-index ba-left-letter';
            letterSpan.textContent = '';
            item.innerHTML = '';
            const indexSpan = document.createElement('span');
            indexSpan.className = 'big-account-file-index ba-file-idx';
            indexSpan.textContent = `${uncoveredSeq}.`;
            const meta = document.createElement('span');
            meta.className = 'big-account-file-meta ba-file-name';
            meta.title = fullMeta;
            meta.textContent = escapeHtml(displayName);
            item.append(letterSpan, indexSpan, meta);
          } else {
            uncoveredSeq += 1;
            item.innerHTML = `<span class="big-account-file-index ba-file-idx">${uncoveredSeq}.</span><span class="big-account-file-meta ba-file-name" title="${escapeHtml(fullMeta)}">${escapeHtml(displayName)}</span>`;
          }
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
          item.className = 'big-account-order-item ba-order-row';
          item.dataset.merchantId = option.merchantId;
          item.dataset.currency = option.currency;
          const label = `${option.merchantId} ${option.currency}`;
          const checkbox = document.createElement('input');
          checkbox.type = 'checkbox';
          checkbox.className = 'new-account-checkbox big-account-order-checkbox';
          const indexSpan = document.createElement('span');
          indexSpan.className = 'concat-picker-index big-account-order-index ba-order-badge';
          indexSpan.textContent = '';
          const textSpan = document.createElement('span');
          textSpan.className = 'big-account-order-text ba-order-content';
          textSpan.title = label;
          textSpan.textContent = label;

          checkbox.addEventListener('change', () => {
            const key = `${option.merchantId}@@${option.currency}`;
            // v1.5.2 需求 2：编辑态下走多对一状态机，非编辑态走原 1:1 逻辑
            if (multiMode && multiEditing) {
              onRightAccountChecked({ merchantId: option.merchantId, currency: option.currency }, checkbox.checked);
              return;
            }
            if (checkbox.checked) {
              if (checkedOrder.length >= getUncoveredBlockCount()) {
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
        // v1.5.2 需求 2：编辑态下右侧序号渲染为字母（a.b.c...），按组在 multiGroups 中的位置 + pendingGroup
        if (multiMode && multiEditing) {
          renderAlphaIndex();
          return;
        }
        orderListContainer.querySelectorAll('.big-account-order-item').forEach((item) => {
          const key = `${item.dataset.merchantId}@@${item.dataset.currency}`;
          const orderIdx = checkedOrder.findIndex((o) => o.key === key);
          const indexSpan = item.querySelector('.big-account-order-index');
          if (!indexSpan) return;
          indexSpan.classList.remove('big-account-order-index--alpha');
          indexSpan.textContent = orderIdx >= 0 ? `${orderIdx + 1}.` : '';
        });
      }

      // M:1 完成后还需要 1:1 分配的 block 数量
      function getUncoveredBlockCount() {
        if (!multiMode || !multiGroups.length) return currentFileRows.length;
        let covered = 0;
        for (const g of multiGroups) {
          covered += g.leftBlockRowIndices.length;
        }
        return Math.max(0, currentFileRows.length - covered);
      }

      function syncCheckboxDisabled() {
        // v1.5.2 需求 2：编辑态下不限制勾选上限
        if (multiMode && multiEditing) {
          orderListContainer.querySelectorAll('.big-account-order-checkbox').forEach((cb) => {
            cb.disabled = false;
          });
          return;
        }
        // 上限 = 未被 M:1 覆盖的 block 数量（非 multiMode 时 = currentFileRows.length）
        const maxSlots = getUncoveredBlockCount();
        const maxReached = checkedOrder.length >= maxSlots;
        orderListContainer.querySelectorAll('.big-account-order-item').forEach((item) => {
          const cb = item.querySelector('.big-account-order-checkbox');
          if (!cb) return;
          // v1.5.2：非编辑态下，已入组大账号保持 disabled（只能点"编辑"才能解绑）
          if (multiMode && !multiEditing) {
            const account = { merchantId: item.dataset.merchantId, currency: item.dataset.currency };
            const isGrouped = multiGroups.some((g) => sameAccount(g.rightAccount, account));
            if (isGrouped) {
              cb.disabled = true;
              return;
            }
          }
          cb.disabled = maxReached && !cb.checked;
        });
      }

      // ===== v1.5.2 需求 2：多对一状态机 helper =====
      function sameAccount(a, b) {
        return a && b && a.merchantId === b.merchantId && a.currency === b.currency;
      }
      function accountKey(acc) {
        return `${acc.merchantId}@@${acc.currency}`;
      }
      // 判断某 rowIndex 是否已被 pendingGroup 或任何已闭合组覆盖（仅供 renderFileList 初始化勾选态使用）
      function isRowIndexCovered(rowIndex) {
        if (pendingGroup && pendingGroup.leftBlockRowIndices.includes(rowIndex)) return true;
        return multiGroups.some((g) => g.leftBlockRowIndices.includes(rowIndex));
      }
      // 查找某大账号属于 pendingGroup 或哪个已闭合组；返回 {source:'pending'|'closed', index}
      function findGroupByAccount(account) {
        if (pendingGroup && pendingGroup.rightAccount && sameAccount(pendingGroup.rightAccount, account)) {
          return { source: 'pending', index: -1 };
        }
        const idx = multiGroups.findIndex((g) => sameAccount(g.rightAccount, account));
        if (idx >= 0) return { source: 'closed', index: idx };
        return null;
      }
      // 查找某 rowIndex 属于 pendingGroup 或哪个已闭合组；返回 {source, groupIndex}
      function findGroupByRowIndex(rowIndex) {
        if (pendingGroup && pendingGroup.leftBlockRowIndices.includes(rowIndex)) {
          return { source: 'pending', groupIndex: -1 };
        }
        const idx = multiGroups.findIndex((g) => g.leftBlockRowIndices.includes(rowIndex));
        if (idx >= 0) return { source: 'closed', groupIndex: idx };
        return null;
      }
      // 左侧 block 勾选/取消
      function onLeftBlockChecked(rowIndex, checked) {
        if (!multiMode || !multiEditing) return;
        if (checked) {
          // 已在任一组内 → 保持原状（不允许同一 block 属于多组）
          if (findGroupByRowIndex(rowIndex)) return;
          if (!pendingGroup) {
            pendingGroup = { leftBlockRowIndices: [rowIndex], rightAccount: null, startedBy: 'left' };
          } else {
            // 若 pendingGroup 已有右侧大账号且也有左侧 → 追加本 block 到当前组
            // （决策 §6.2.1：同组内 N 个 block 共享一个大账号，可随时追加）
            if (!pendingGroup.leftBlockRowIndices.includes(rowIndex)) {
              pendingGroup.leftBlockRowIndices.push(rowIndex);
            }
          }
        } else {
          // 取消：若在 pendingGroup 中 → 移除；若 pendingGroup 因此变空（无 left 无 right）→ 置 null
          // 若在已闭合组中 → 从该组移除；若该组变空 → 整组移除
          if (pendingGroup && pendingGroup.leftBlockRowIndices.includes(rowIndex)) {
            pendingGroup.leftBlockRowIndices = pendingGroup.leftBlockRowIndices.filter((r) => r !== rowIndex);
            if (pendingGroup.leftBlockRowIndices.length === 0 && !pendingGroup.rightAccount) {
              pendingGroup = null;
            }
          } else {
            for (let i = multiGroups.length - 1; i >= 0; i -= 1) {
              const g = multiGroups[i];
              if (g.leftBlockRowIndices.includes(rowIndex)) {
                g.leftBlockRowIndices = g.leftBlockRowIndices.filter((r) => r !== rowIndex);
                if (g.leftBlockRowIndices.length === 0) {
                  multiGroups.splice(i, 1);
                }
                break;
              }
            }
          }
        }
        // 渲染：刷新左侧（勾选态/字母位置）+ 右侧字母
        renderFileList();
        renderAlphaIndex();
      }
      // 右侧大账号勾选/取消
      function onRightAccountChecked(account, checked) {
        if (!multiMode || !multiEditing) return;
        if (checked) {
          // 同一大账号最多只能属于一组；若已在某组 → 忽略（checkbox 让 DOM 自动保持勾选态）
          if (findGroupByAccount(account)) return;
          if (!pendingGroup) {
            pendingGroup = { leftBlockRowIndices: [], rightAccount: { ...account }, startedBy: 'right' };
          } else if (!pendingGroup.rightAccount) {
            pendingGroup.rightAccount = { ...account };
          } else {
            // pendingGroup 已绑右侧 → 触发闭合，开始新组
            closeCurrentGroup();
            pendingGroup = { leftBlockRowIndices: [], rightAccount: { ...account }, startedBy: 'right' };
          }
        } else {
          // 取消：若在 pendingGroup → 清 rightAccount；若因此变空 → 置 null
          // 若在已闭合组 → 整组移除
          if (pendingGroup && pendingGroup.rightAccount && sameAccount(pendingGroup.rightAccount, account)) {
            pendingGroup.rightAccount = null;
            if (pendingGroup.leftBlockRowIndices.length === 0) {
              pendingGroup = null;
            }
          } else {
            const idx = multiGroups.findIndex((g) => sameAccount(g.rightAccount, account));
            if (idx >= 0) {
              multiGroups.splice(idx, 1);
            }
          }
        }
        // 渲染：左侧（勾选态/标记）+ 右侧字母
        renderFileList();
        renderAlphaIndex();
      }
      // 闭合当前 pendingGroup（若有效：同时存在至少 1 个 left 且 1 个 right）
      function closeCurrentGroup() {
        if (!pendingGroup) return;
        if (pendingGroup.leftBlockRowIndices.length > 0 && pendingGroup.rightAccount) {
          multiGroups.push({
            leftBlockRowIndices: pendingGroup.leftBlockRowIndices.slice(),
            rightAccount: { ...pendingGroup.rightAccount }
          });
        }
        pendingGroup = null;
      }
      // 字母序号渲染：按 (multiGroups index) 作为字母基位；pendingGroup 追加在尾部
      function renderAlphaIndex() {
        orderListContainer.querySelectorAll('.big-account-order-item').forEach((item) => {
          const account = { merchantId: item.dataset.merchantId, currency: item.dataset.currency };
          const indexSpan = item.querySelector('.big-account-order-index');
          if (!indexSpan) return;
          let letter = '';
          const closedIdx = multiGroups.findIndex((g) => sameAccount(g.rightAccount, account));
          if (closedIdx >= 0) {
            letter = String.fromCharCode(97 + closedIdx);
          } else if (pendingGroup && pendingGroup.rightAccount && sameAccount(pendingGroup.rightAccount, account)) {
            // pendingGroup 使用"下一个可用字母"：= multiGroups.length
            letter = String.fromCharCode(97 + multiGroups.length);
          }
          if (letter) {
            indexSpan.classList.add('big-account-order-index--alpha');
            indexSpan.textContent = `${letter}.`;
          } else {
            indexSpan.classList.remove('big-account-order-index--alpha');
            indexSpan.textContent = '';
          }
          // 同步 checkbox 勾选态（保证取消/闭合/编辑切换后视觉一致）
          const cb = item.querySelector('.big-account-order-checkbox');
          if (cb) {
            const coveredByClosed = closedIdx >= 0;
            const coveredByPending = pendingGroup && pendingGroup.rightAccount && sameAccount(pendingGroup.rightAccount, account);
            cb.checked = Boolean(coveredByClosed || coveredByPending);
          }
        });
      }
      // 退出编辑态时恢复显示（左侧数字序号 + 右侧数字序号 + checkedOrder 由 closeCurrentGroup 后的 multiGroups 展开不负责回填，交给主 doneBtn 的展开逻辑）
      // 本函数主要保证 UI 回到"非编辑态"：左侧恢复数字序号（含已入组 block 的"已配对"标记）+ 右侧已入组的 checkbox 保留勾选且 disabled（不允许取消，除非"编辑"重开）；未入组的 checkbox 开放 1:1 勾选
      function rerenderAfterMultiDone() {
        renderFileList();
        orderListContainer.querySelectorAll('.big-account-order-item').forEach((item) => {
          const indexSpan = item.querySelector('.big-account-order-index');
          if (indexSpan) {
            indexSpan.classList.remove('big-account-order-index--alpha');
            indexSpan.textContent = '';
          }
          const cb = item.querySelector('.big-account-order-checkbox');
          if (!cb) return;
          const account = { merchantId: item.dataset.merchantId, currency: item.dataset.currency };
          const isGrouped = multiGroups.some((g) => sameAccount(g.rightAccount, account));
          if (isGrouped) {
            cb.checked = true;
            cb.disabled = true;
          } else {
            cb.checked = false;
            cb.disabled = false;
          }
        });
        // 同步 1:1 数字序号（checkedOrder 目前为空）+ disable 上限检查
        syncOrderIndices();
        syncCheckboxDisabled();
      }
      // toggle 按钮同步（编辑↔完成）；用 visibility 而非 hidden 避免文本平移
      function syncMultiToolbar() {
        if (!multiMode) {
          multiToggleBtn.classList.add('is-hidden');
          return;
        }
        multiToggleBtn.classList.remove('is-hidden');
        multiToggleBtn.textContent = multiEditing ? '完成' : '编辑';
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
        // v1.5.2 需求 2：mode 切换导致 currentFileRows / rowIndex 空间变化 → 清空多对一状态避免对不上
        multiGroups = [];
        pendingGroup = null;
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
          switchToRememberMode();
        } else {
          switchToNormalMode();
        }
      }

      function switchToRememberMode() {
        isRememberMode = true;
        scrollContainer.style.overflowY = 'auto';
        fileListContainer.parentElement.style.overflowY = 'visible';
        orderListContainer.parentElement.style.overflowY = 'visible';
        scrollContainer.classList.add('ba-single-scroll-active');
        renderOrderListAsText();
      }

      function switchToNormalMode() {
        isRememberMode = false;
        scrollContainer.style.overflowY = '';
        fileListContainer.parentElement.style.overflowY = '';
        orderListContainer.parentElement.style.overflowY = '';
        scrollContainer.classList.remove('ba-single-scroll-active');
        renderOrderListAsCheckbox();
      }

      function renderOrderListAsText() {
        orderListContainer.innerHTML = '';
        orderListContainer.classList.add('text-readonly');
        if (!checkedOrder.length) {
          orderListContainer.innerHTML = '<div class="big-account-order-empty">暂无已选大账号</div>';
          return;
        }
        checkedOrder.forEach((item, index) => {
          const div = document.createElement('div');
          div.className = 'big-account-order-item big-account-order-text-item ba-order-row';
          const indexSpan = document.createElement('span');
          indexSpan.className = 'concat-picker-index big-account-order-index ba-order-badge';
          indexSpan.textContent = `${index + 1}.`;
          const textSpan = document.createElement('span');
          textSpan.className = 'big-account-order-text ba-order-content';
          textSpan.textContent = `${item.merchantId} ${item.currency}`;
          div.append(indexSpan, textSpan);
          orderListContainer.appendChild(div);
        });
      }

      function renderOrderListAsCheckbox() {
        orderListContainer.classList.remove('text-readonly');
        renderOrderList();
        // Restore checked state
        checkedOrder.forEach((co) => {
          const item = Array.from(orderListContainer.querySelectorAll('.big-account-order-item')).find(
            (el) => el.dataset.merchantId === co.merchantId && el.dataset.currency === co.currency
          );
          if (item) {
            item.querySelector('.big-account-order-checkbox').checked = true;
          }
        });
        syncOrderIndices();
        syncCheckboxDisabled();
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

          // forceMode 优先：文件个数不匹配时后端强制指定模式
          if (payload?.forceMode === 'unfixed' || payload?.forceMode === 'fixed') {
            currentMode = payload.forceMode;
          }

          modeSelect.value = currentMode;

          const orderResult = await desktopApi.bigAccount.loadOrder(templateId);
          savedOrder = orderResult.order;
        } catch (_error) {}
        syncModeUI();
        // v1.5.2 需求 2：初始同步多对一工具条状态 + 互斥
        syncMultiToolbar();
        syncMultiModeMutualDisabled();
        setInteractive(true);
      }

      modeSelect.addEventListener('change', async () => {
        currentMode = modeSelect.value;
        await desktopApi.bigAccount.saveMode({ templateId, mode: currentMode });
        syncModeUI();
        syncMultiModeMutualDisabled();
      });

      rememberCheckbox.addEventListener('change', () => {
        if (rememberCheckbox.checked) {
          switchToRememberMode();
        } else {
          switchToNormalMode();
        }
        syncMultiModeMutualDisabled();
      });

      // ===== v1.5.2 需求 2：多对一工具条事件 =====
      // "单个账号匹多个文件" 勾选框：开/关切换
      multiModeCheckbox.addEventListener('change', () => {
        multiMode = multiModeCheckbox.checked;
        if (multiMode) {
          // 进入多对一模式：默认编辑态；清空 checkedOrder 避免旧 1:1 选择错配给未覆盖 block
          multiEditing = true;
          multiGroups = [];
          pendingGroup = null;
          checkedOrder = [];
          orderListContainer.querySelectorAll('.big-account-order-checkbox').forEach((cb) => {
            cb.checked = false;
          });
        } else {
          // 关闭多对一模式：清空 multiGroups + pendingGroup；回到旧 1:1 UI（数字序号 + checkedOrder）
          multiGroups = [];
          pendingGroup = null;
          multiEditing = false;
          // 已勾选的大账号勾选态需回到 checkedOrder 语义，此处简单重置为空以避免跨模式脏数据
          checkedOrder = [];
          orderListContainer.querySelectorAll('.big-account-order-checkbox').forEach((cb) => {
            cb.checked = false;
          });
        }
        renderFileList();
        syncOrderIndices();
        syncCheckboxDisabled();
        syncMultiToolbar();
        syncMultiModeMutualDisabled();
      });

      // toggle 按钮：编辑↔完成 切换
      multiToggleBtn.addEventListener('click', () => {
        if (!multiMode) return;
        if (multiEditing) {
          // 完成：闭合 pendingGroup + 退出编辑态
          closeCurrentGroup();
          multiEditing = false;
          rerenderAfterMultiDone();
        } else {
          // 编辑：重新进入编辑态；保留已有 multiGroups 供用户修改
          // 清空 checkedOrder（重编辑可能改变覆盖范围，旧 1:1 选择不再有效）
          multiEditing = true;
          pendingGroup = null;
          checkedOrder = [];
          renderFileList();
          syncOrderIndices();
          syncCheckboxDisabled();
        }
        syncMultiToolbar();
      });

      // "单个账号匹多个文件" 与 "记住顺序" 互斥
      function syncMultiModeMutualDisabled() {
        // 记住顺序勾上 → 多对一模式勾选框 disabled 并取消；立即重渲染左侧避免遗留勾选框
        if (rememberCheckbox.checked) {
          multiModeCheckbox.disabled = true;
          if (multiModeCheckbox.checked) {
            multiModeCheckbox.checked = false;
            multiMode = false;
            multiEditing = false;
            multiGroups = [];
            pendingGroup = null;
            renderFileList();
          }
          syncMultiToolbar();
          return;
        }
        // 多对一模式勾上 → 记住顺序 disabled
        if (multiModeCheckbox.checked) {
          rememberCheckbox.disabled = true;
          rememberLabel.classList.add('is-disabled');
        } else {
          // 仅在 fixed 模式才允许启用记住顺序；unfixed 下 syncModeUI 已强制 disable
          if (currentMode === 'fixed') {
            rememberCheckbox.disabled = false;
            rememberLabel.classList.remove('is-disabled');
          }
        }
        multiModeCheckbox.disabled = false;
      }

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

      extractOrderBtn.addEventListener('click', async () => {
        // v1.5.2：已被"单个账号匹多个文件"映射的 block 不参与提取
        const extractableRows = multiMode
          ? currentFileRows.filter((row, i) => {
              const ri = Number.isInteger(row.index) ? row.index : i;
              return !isRowIndexCovered(ri);
            })
          : currentFileRows;
        const result = await desktopApi.files.extractBigAccountOrder({
          mode: currentMode,
          fileRows: extractableRows.map((row) => ({
            sourceRowNumber: row.sourceRowNumber,
            fileName: row.fileName,
            filePath: row.filePath || ''
          }))
        });

        if (result.status === 'error') {
          const failedLines = (result.failedRows || [])
            .map((r) => `第 ${r.index + 1} 行（${escapeHtml(r.fileName || '')}）提取不到大账号信息`)
            .join('<br/>');
          openModal(createAlertDialog(failedLines || '提取大账号信息失败', {
            onConfirm: () => { openModal(overlay); }
          }));
          return;
        }

        const extractedAccounts = result.accounts || [];
        const ambiguousFiles = result.ambiguousCurrencyFiles || [];

        function applyExtractedOrder() {
          checkedOrder = [];
          orderListContainer.querySelectorAll('.big-account-order-checkbox').forEach((cb) => { cb.checked = false; });

          extractedAccounts.forEach((account) => {
            const key = `${account.merchantId}@@${account.currency}`;
            const item = Array.from(orderListContainer.querySelectorAll('.big-account-order-item')).find(
              (el) => el.dataset.merchantId === account.merchantId && el.dataset.currency === account.currency
            );
            if (item && checkedOrder.length < currentFileRows.length) {
              item.querySelector('.big-account-order-checkbox').checked = true;
              checkedOrder.push({ merchantId: account.merchantId, currency: account.currency, key });
            }
          });
          syncOrderIndices();
          syncCheckboxDisabled();

          // 右侧大账号顺序按数字序号从小到大排序（已勾选排前面，未勾选排后面）
          const allItems = Array.from(orderListContainer.querySelectorAll('.big-account-order-item'));
          const checkedItems = [];
          const uncheckedItems = [];
          allItems.forEach((item) => {
            const key = `${item.dataset.merchantId}@@${item.dataset.currency}`;
            const orderIdx = checkedOrder.findIndex((o) => o.key === key);
            if (orderIdx >= 0) {
              checkedItems.push({ item, order: orderIdx });
            } else {
              uncheckedItems.push(item);
            }
          });
          checkedItems.sort((a, b) => a.order - b.order);
          orderListContainer.innerHTML = '';
          checkedItems.forEach(({ item }) => orderListContainer.appendChild(item));
          uncheckedItems.forEach((item) => orderListContainer.appendChild(item));
        }

        function showExtractDialog() {
          const extractOverlay = createOverlay();
          const extractDialog = document.createElement('div');
          extractDialog.className = 'modal-card extract-order-card';
          extractDialog.innerHTML = `
            <div class="dialog-header">
              <div class="dialog-title">确认大账号顺序</div>
              <button class="icon-close extract-close-btn" type="button" style="margin-left:auto;">×</button>
            </div>
            <div class="extract-order-body">
              <div>
                <div class="extract-order-col-header">文件顺序：</div>
                <div class="extract-order-list extract-file-list"></div>
              </div>
              <div>
                <div class="extract-order-col-header">大账号信息：</div>
                <div class="extract-order-list extract-account-list"></div>
              </div>
            </div>
            <div class="dialog-actions right">
              <button class="primary-btn small" type="button" data-action="extract-done">完成</button>
            </div>
          `;

          const extractFileList = extractDialog.querySelector('.extract-file-list');
          const extractOrderList = extractDialog.querySelector('.extract-account-list');




          // v1.5.2：确认大账号顺序弹窗只显示未被"单个账号匹多个文件"映射的 block
          extractableRows.forEach((row, index) => {
            const item = document.createElement('div');
            item.className = 'extract-order-row';
            const fullName = row.fileName || '';
            const rowSuffix = row.sourceRowNumber ? ` 第${row.sourceRowNumber}行` : '';
            const displayName = truncateFileName(fullName, 20) + rowSuffix;
            const fullMeta = fullName + rowSuffix;
            item.innerHTML = `<span class="eo-idx">${index + 1}.</span><span class="eo-name" title="${escapeHtml(fullMeta)}">${escapeHtml(displayName)}</span><span></span>`;
            extractFileList.appendChild(item);
          });

          extractedAccounts.forEach((account, index) => {
            const item = document.createElement('div');
            item.className = 'extract-order-row';
            item.dataset.index = index;
            item.dataset.merchantId = account.merchantId;
            item.dataset.currency = account.currency;

            const indexSpan = document.createElement('span');
            indexSpan.className = 'eo-idx';
            indexSpan.textContent = `${index + 1}.`;

            const textSpan = document.createElement('span');
            textSpan.className = 'eo-name';
            textSpan.textContent = `${account.merchantId} ${account.currency}`;

            const editBtn = document.createElement('button');
            editBtn.className = 'text-action eo-edit';
            editBtn.type = 'button';
            editBtn.textContent = '编辑';

            const editContainer = document.createElement('div');
            editContainer.className = 'extract-edit-container';
            editContainer.hidden = true;
            editContainer.innerHTML = `
              <input class="mapping-text-input extract-edit-input extract-edit-merchant" type="text" placeholder="账户号" value="${escapeHtml(account.merchantId)}" />
              <input class="mapping-text-input extract-edit-input extract-edit-currency" type="text" placeholder="币种" value="${escapeHtml(account.currency)}" />
              <button class="secondary-btn small extract-edit-done" type="button">完成</button>
            `;

            editBtn.addEventListener('click', () => {
              textSpan.hidden = true;
              editBtn.hidden = true;
              editContainer.hidden = false;
            });

            editContainer.querySelector('.extract-edit-done').addEventListener('click', () => {
              const newMerchantId = editContainer.querySelector('.extract-edit-merchant').value.trim();
              const newCurrency = editContainer.querySelector('.extract-edit-currency').value.trim();
              const matched = expandedOptions.find(
                (o) => o.merchantId === newMerchantId && o.currency === newCurrency
              );
              if (!matched) {
                openModal(createAlertDialog('大账号信息不存在，请重新输入。', {
                  onConfirm: () => { openModal(extractOverlay); }
                }));
                return;
              }
              item.dataset.merchantId = newMerchantId;
              item.dataset.currency = newCurrency;
              extractedAccounts[index] = { merchantId: newMerchantId, currency: newCurrency, matchType: 'exact' };
              textSpan.textContent = `${newMerchantId} ${newCurrency}`;
              textSpan.hidden = false;
              editBtn.hidden = false;
              editContainer.hidden = true;
            });

            item.append(indexSpan, textSpan, editBtn, editContainer);
            extractOrderList.appendChild(item);
          });

          extractDialog.querySelector('.extract-close-btn').addEventListener('click', () => {
            openModal(overlay);
          });

          extractDialog.querySelector('[data-action="extract-done"]').addEventListener('click', () => {
            if (checkedOrder.length > 0) {
              openModal(createConfirmDialog({
                message: '当前已有已勾选的大账号，确认覆盖吗？',
                confirmText: '确认覆盖',
                cancelText: '取消',
                onConfirm: () => {
                  applyExtractedOrder();
                  openModal(overlay);
                }
              }));
            } else {
              applyExtractedOrder();
              openModal(overlay);
            }
          });

          extractOverlay.appendChild(extractDialog);
          openModal(extractOverlay);
        }

        if (ambiguousFiles.length > 0) {
          const fileList = ambiguousFiles.map((f) => escapeHtml(f)).join('<br/>');
          openModal(createAlertDialog(`以下文件的大账号币种可能不准确，请检查并编辑：<br/>${fileList}`, {
            onConfirm: () => { showExtractDialog(); }
          }));
        } else {
          showExtractDialog();
        }
      });

      dialog.querySelector('.icon-close').addEventListener('click', () => {
        desktopApi.files.cancelBigAccountSelection();
        closeModal();
      });
      doneBtn.addEventListener('click', async () => {
        // v1.5.2 需求 2（决策 ①B）：按 block 粒度展开 assignments
        //   - multiMode 下：
        //     1) 若处于编辑态（用户未点"完成"组闭合按钮），尝试闭合最后一组；这样单组用户直接点主完成也能生效
        //     2) 展开 multiGroups：每个被勾选的 block 产生 1 条 assignment，key = rowIndex（row.index）
        //     3) coveredRowIndices 记录已被 M:1 覆盖的 rowIndex
        //     4) 未入组的 block 按 currentFileRows 顺序，用 checkedOrder 依次补齐 1:1（决策 D4）
        //   - 非 multiMode 下：沿用 v1.5.1 1:1 逻辑
        let finalAssignments;
        if (multiMode) {
          // 编辑态下主完成 → 尝试闭合当前组（P0-4 单组场景不强制用户先点组"完成"再点主"完成"）
          if (multiEditing) {
            closeCurrentGroup();
            multiEditing = false;
          }
          finalAssignments = [];
          const coveredRowIndices = new Set();
          multiGroups.forEach((group) => {
            group.leftBlockRowIndices.forEach((rowIndex) => {
              finalAssignments.push({
                rowIndex,
                merchantId: group.rightAccount.merchantId,
                currency: group.rightAccount.currency
              });
              coveredRowIndices.add(rowIndex);
            });
          });
          // 未入组 block 按 checkedOrder 顺序补齐（checkedOrder 只在非编辑态累积）
          // 按 currentFileRows 顺序，跳过已被 M:1 覆盖的 rowIndex
          let orderCursor = 0;
          for (const row of currentFileRows) {
            const rowIdx = Number.isInteger(row.index) ? row.index : null;
            if (rowIdx === null) continue;
            if (coveredRowIndices.has(rowIdx)) continue;
            const item = checkedOrder[orderCursor];
            if (!item) break; // checkedOrder 不够 → 交给长度校验
            finalAssignments.push({
              rowIndex: rowIdx,
              merchantId: item.merchantId,
              currency: item.currency
            });
            orderCursor += 1;
          }
          // 按 rowIndex 升序排序（后端按 rowIndex 匹配 globalBlockIndex）
          finalAssignments.sort((a, b) => a.rowIndex - b.rowIndex);
        } else {
          // 非多对一模式：保持 v1.5.1 1:1 行为（rowIndex = 数组下标）
          finalAssignments = checkedOrder.map((item, index) => ({
            rowIndex: index,
            merchantId: item.merchantId,
            currency: item.currency
          }));
        }

        if (finalAssignments.length !== currentFileRows.length) {
          setStatus(`请勾选 ${currentFileRows.length} 个大账号（当前已选 ${finalAssignments.length} 个）`, 'error');
          return;
        }

        if (currentMode === 'fixed' && rememberCheckbox.checked) {
          await desktopApi.bigAccount.saveOrder({ templateId, assignments: finalAssignments, includeFileInfo: true });
        } else if (currentMode === 'fixed' && !rememberCheckbox.checked) {
          await desktopApi.bigAccount.saveOrder({ templateId, assignments: [] });
        }

        const result = await desktopApi.files.completeBigAccountSelection({
          assignments: finalAssignments,
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

    function createBigAccountManagerDialog({ bigAccounts, templateId, templateName, onDone, onCancel }) {
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
        // v1.5.3 R2：记录账号性质（'client' / 'own'），缺省 'client'；完成按钮收集 nextBigAccounts 时读取
        // view 模式下自有行在大账号前缀显示 [自有]；编辑态不显示（避免写进输入框值）
        const rawNature = typeof item.accountNature === 'string' ? item.accountNature.trim() : '';
        row.dataset.accountNature = rawNature === 'own' ? 'own' : 'client';
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
              <div class="new-account-currency-dropdown-wrap big-account-currency-dropdown-wrap">
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
        // v1.5.3 R2：自有行 view 态在大账号前加 [自有] 前缀，便于用户区分（不写进输入框值）
        function setMerchantViewText(merchantId) {
          const prefix = row.dataset.accountNature === 'own' ? '[自有] ' : '';
          const textValue = String(merchantId || '');
          merchantView.textContent = prefix + textValue;
          merchantView.title = prefix + textValue;
        }
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

          const knownCurrencyCodes = new Set(getCurrencyOptionEntries().map((entry) => entry.code));
          const invalidCurrency = draft.currencies.find((code) => !knownCurrencyCodes.has(code));
          if (invalidCurrency) {
            return `币种「${invalidCurrency}」不是有效的币种代码`;
          }

          return '';
        }

        function syncCurrencyMode() {
          const isMultiCurrency = multiCheckbox.checked;
          // v2.0.0-beta.2 阶段 5 收尾：input shell + dropdown wrap 始终并排可见，
          // 通过 .is-inactive 视觉禁用非当前态（pointer-events:none + opacity）
          currencyInputShell.classList.toggle('is-inactive', isMultiCurrency);
          dropdownWrap.classList.toggle('is-inactive', !isMultiCurrency);

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
          // v2.0.0-beta.2 阶段 5 收尾：dropdown 始终可见，但单币种态下不能点开
          if (!multiCheckbox.checked) {
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

          setMerchantViewText(merchantInput.value.trim());
        });
        toggleCompleteBtn.addEventListener('click', () => {
          if (row.dataset.mode === 'edit') {
            if (!multiCheckbox.checked && currencyInput) {
              currencyInput.value = currencyInput.value.trim().toUpperCase();
              renderCurrencyInputSuggestion();
            }
            const validationMessage = validateRowDraft();

            if (validationMessage) {
              openModal(createAlertDialog(validationMessage, {
                onConfirm: () => { openModal(overlay); }
              }));
              return;
            }

            const draft = getRowDraft();
            setMerchantViewText(draft.merchantId);
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
          setMerchantViewText(initialDraft.merchantId);
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
        // v1.5.3 R2：客资 + 自有账号统一进 tbody（行带 accountNature 区分），由 saveMappings 统一写回
        tbody.innerHTML = '';
        const clientAccounts = result.clientAccounts || [];
        const ownAccounts = result.ownAccounts || [];
        // v1.5.3 R2 round 5 (Codex Finding 8)：dedupe by (merchantId, currency)
        // 脏 Excel 可能在 client + own 同时含同 merchantId+currency；直接 concat → saveMappings 撞 UNIQUE 约束 (template_id, merchant_id, currency) → 整个 save 报错
        // 冲突规则：保留 client（与 PRD §3.1 一致：自有账户仅在 R1 月度余额放行；UI 默认按 client 行为对齐）；丢弃的 own 行打 warn 让用户感知
        const mergedAccounts = [];
        const seenByPair = new Set();
        const droppedOwnPairs = [];
        clientAccounts.forEach((item) => {
          const merchantId = String(item.merchantId || '').trim();
          const currencies = Array.isArray(item.currencies) ? item.currencies : [];
          mergedAccounts.push({ ...item, accountNature: 'client' });
          currencies.forEach((c) => {
            const key = `${merchantId}::${String(c || '').trim()}`;
            seenByPair.add(key);
          });
        });
        ownAccounts.forEach((item) => {
          const merchantId = String(item.merchantId || '').trim();
          const currencies = Array.isArray(item.currencies) ? item.currencies : [];
          // 整体冲突 = own 行的所有 currency 都已被 client 占用 → 丢弃
          // 部分冲突 = 混合（部分 currency 被占用，部分未占用）→ 仅保留未占用的 currency；如剩 0 则丢弃
          const remainingCurrencies = currencies.filter((c) => !seenByPair.has(`${merchantId}::${String(c || '').trim()}`));
          if (remainingCurrencies.length === 0) {
            droppedOwnPairs.push(`${merchantId}（${currencies.join('/')}）`);
            return;
          }
          if (remainingCurrencies.length < currencies.length) {
            const droppedCurrencies = currencies.filter((c) => seenByPair.has(`${merchantId}::${String(c || '').trim()}`));
            droppedOwnPairs.push(`${merchantId}（${droppedCurrencies.join('/')}, 部分冲突）`);
          }
          mergedAccounts.push({
            ...item,
            currencies: remainingCurrencies,
            isMultiCurrency: remainingCurrencies.length > 1,
            accountNature: 'own'
          });
          remainingCurrencies.forEach((c) => seenByPair.add(`${merchantId}::${String(c || '').trim()}`));
        });
        // v1.5.3 R2 round 6 self-review (C1)：dedupe 丢弃的 own 升级为状态栏 warning（含具体丢失明细），
        // 避免 console.warn 静默 — 让用户在保存前能感知并修正 Excel 源
        if (droppedOwnPairs.length > 0) {
          console.warn(`[v1.5.3] import-bank-info dedupe: 自有账号与客资重复，已保留客资，丢弃 own 项: ${droppedOwnPairs.join('; ')}`);
        }
        if (mergedAccounts.length === 0) {
          tbody.appendChild(createBigAccountRow({}, 'edit'));
        } else {
          mergedAccounts.forEach((item) => {
            tbody.appendChild(createBigAccountRow(item, 'view'));
          });
        }
        if (droppedOwnPairs.length > 0) {
          // 状态栏告警：保留 import-bank-info 的 success message + 追加 dedupe 提示
          // 用户在 DevTools / 状态栏都能感知（控制台不行就靠 toast）
          setStatus(
            `${result.message}；⚠ 检测到 ${droppedOwnPairs.length} 个自有账号与客资重复，已保留客资并丢弃 own：${droppedOwnPairs.join('；')}。请核对 Excel 源数据是否分类正确`,
            'error'
          );
        } else {
          setStatus(result.message, 'success');
        }
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
                    // v1.5.3 R2：大账号输入框的 .value 是裸 merchantId（不含 [自有] 前缀），读取它避免剥离问题
                    const mid = r.querySelector('.big-account-merchant-input')?.value?.trim() || '';
                    const isMC = r.querySelector('.big-account-multi-checkbox')?.checked || false;
                    const cText = r.querySelector('.big-account-currency-view')?.title || '';
                    const cs = isMC ? cText.split('、').filter(Boolean) : [cText].filter(Boolean);
                    const nature = r.dataset.accountNature === 'own' ? 'own' : 'client';
                    return { merchantId: mid, currencies: cs, isMultiCurrency: isMC, accountNature: nature };
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
            isMultiCurrency,
            // v1.5.3 R2：从 row.dataset 读取账号性质（import-bank-info / initialBigAccounts 回显时已设置）
            accountNature: row.dataset.accountNature === 'own' ? 'own' : 'client'
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

      function createTemplateRow(template, options = {}) {
        const { isChild = false } = options;
        const bigAccountSummary = template.bigAccountSummary || '未设置';
        const row = document.createElement('tr');
        if (isChild) {
          row.className = 'template-child-row';
        }
        const namePrefix = isChild ? '<span class="child-indent">\u00A0\u00A0└ </span>' : '';
        row.innerHTML = `
          <td>${namePrefix}${escapeHtml(template.name)}</td>
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
            setStatus(result.message, 'error', { errorReportReady: Boolean(result.errorReportReady) });
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

        return row;
      }

      // 分类：主模板、子模板（按 parentTemplateId 分组）、普通模板
      const parentTemplates = state.templates.filter((t) => t.isParent);
      const childByParent = new Map();
      const childTemplateIds = new Set();
      state.templates.forEach((t) => {
        if (t.parentTemplateId) {
          childTemplateIds.add(t.id);
          if (!childByParent.has(t.parentTemplateId)) {
            childByParent.set(t.parentTemplateId, []);
          }
          childByParent.get(t.parentTemplateId).push(t);
        }
      });
      const normalTemplates = state.templates.filter((t) => !t.isParent && !t.parentTemplateId);

      // 先渲染主模板（带展开/折叠）
      parentTemplates.forEach((parent) => {
        const children = childByParent.get(parent.id) || [];
        const parentRow = createTemplateRow(parent);

        if (children.length > 0) {
          const nameCell = parentRow.querySelector('td');
          const toggleBtn = document.createElement('span');
          toggleBtn.className = 'template-toggle-btn';
          toggleBtn.textContent = '▶ ';
          toggleBtn.style.cursor = 'pointer';
          nameCell.insertBefore(toggleBtn, nameCell.firstChild);

          const childRows = children.map((child) => createTemplateRow(child, { isChild: true }));

          let expanded = false;
          toggleBtn.addEventListener('click', () => {
            expanded = !expanded;
            toggleBtn.textContent = expanded ? '▼ ' : '▶ ';
            childRows.forEach((cr) => {
              cr.style.display = expanded ? '' : 'none';
            });
          });

          tableBody.appendChild(parentRow);
          childRows.forEach((cr) => {
            cr.style.display = 'none';
            tableBody.appendChild(cr);
          });
        } else {
          const nameCell = parentRow.querySelector('td');
          const toggleBtn = document.createElement('span');
          toggleBtn.className = 'template-toggle-btn';
          toggleBtn.textContent = '▶ ';
          toggleBtn.style.cursor = 'pointer';
          toggleBtn.style.opacity = '0.3';
          nameCell.insertBefore(toggleBtn, nameCell.firstChild);
          tableBody.appendChild(parentRow);
        }
      });

      // 渲染普通模板
      normalTemplates.forEach((template) => {
        tableBody.appendChild(createTemplateRow(template));
      });
    }

    function createTemplateManagerDialog() {
      const overlay = createOverlay();
      const dialog = document.createElement('div');
      dialog.className = 'modal-card manager-card';
      dialog.innerHTML = `
        <div class="dialog-header">
          <div class="dialog-title">模板管理</div>
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
      let currentBigAccounts = cloneBigAccountItems(payload.bigAccounts || []);
      // v1.5.3 R2 round 2 修复 (Codex Finding 3)：
      // 标记 currentBigAccounts 是否已含 own。第一次从模板管理 / get-mappings 进入时不含 own（§3.1 过滤），
      // 维护大账号 click handler 才去 await getWithOwn 拉数据库版；第二次重开 mapping dialog 时
      // payload.bigAccounts 已是上次维护大账号 onDone 的内存版（含 own + 用户编辑），透传 loadedWithOwn=true 跳过 getWithOwn，
      // 避免静默覆盖用户的内存编辑（包括主动删除的 own 行）。
      let bigAccountsLoadedWithOwn = Boolean(payload.bigAccountsLoadedWithOwn);
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
      const templateIsParent = Boolean(payload.template.isParent);
      const templateParentId = payload.template.parentTemplateId || null;
      let unparentConfirmed = false;
      dialog.innerHTML = `
        <div class="dialog-header">
          <div class="dialog-title">映射关系管理</div>
          <div class="dialog-header-checkboxes">
            <label class="dialog-checkbox-label"><input type="checkbox" data-role="is-parent" ${templateIsParent ? 'checked' : ''}>设为主模板</label>
            <label class="dialog-checkbox-label"><input type="checkbox" data-role="is-child" ${templateParentId ? 'checked' : ''}>设为子模板</label>
            <span class="dialog-child-parent-select-wrapper" ${templateParentId ? '' : 'style="display:none"'}>
              主模板 <select data-role="parent-select"></select>
            </span>
          </div>
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

      const isParentCheckbox = dialog.querySelector('[data-role="is-parent"]');
      const isChildCheckbox = dialog.querySelector('[data-role="is-child"]');
      const parentSelectWrapper = dialog.querySelector('.dialog-child-parent-select-wrapper');
      const parentSelect = dialog.querySelector('[data-role="parent-select"]');

      // 填充主模板下拉框
      const allTemplates = state.templates || [];
      const parentTemplates = allTemplates.filter((t) => t.isParent && t.id !== payload.template.id);
      parentTemplates.forEach((t) => {
        const opt = document.createElement('option');
        opt.value = String(t.id);
        opt.textContent = t.name;
        if (templateParentId && String(t.id) === String(templateParentId)) {
          opt.selected = true;
        }
        parentSelect.appendChild(opt);
      });

      // 取消主模板身份时的确认（有子模板的主模板才需要）
      async function confirmUnparentIfNeeded() {
        if (!templateIsParent || unparentConfirmed) return true;
        const children = await desktopApi.templates.listChildren(payload.template.id);
        if (children && children.length > 0) {
          const confirmed = confirm(`该模板下有 ${children.length} 个子模板，取消主模板身份后子模板将恢复为普通模板，是否继续？`);
          if (!confirmed) return false;
        }
        unparentConfirmed = true;
        return true;
      }

      // 互斥逻辑
      isParentCheckbox.addEventListener('change', async () => {
        if (isParentCheckbox.checked) {
          isChildCheckbox.checked = false;
          parentSelectWrapper.style.display = 'none';
        } else {
          const ok = await confirmUnparentIfNeeded();
          if (!ok) {
            isParentCheckbox.checked = true;
            return;
          }
        }
      });

      isChildCheckbox.addEventListener('change', async () => {
        if (isChildCheckbox.checked) {
          const ok = await confirmUnparentIfNeeded();
          if (!ok) {
            isChildCheckbox.checked = false;
            return;
          }
          isParentCheckbox.checked = false;
          parentSelectWrapper.style.display = '';
        } else {
          parentSelectWrapper.style.display = 'none';
        }
      });

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
          concatPreview.textContent = previewText.length > 120 ? previewText.slice(0, 120) + '......' : previewText;
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
          manageBigAccountBtn.addEventListener('click', async () => {
            const draftMappings = collectMappingDraftFromTable(tbody);
            // v1.5.3 R2 fix：拉含自有账号的完整大账号列表作为弹窗初始数据
            // 直接用 payload.bigAccounts（来自 template:get-mappings，§3.1 过滤自有）会在
            // saveMappings DELETE+INSERT 写回时静默删除 own 账号；首次进入 dialog 时 loadedWithOwn=false，
            // 此时去 await getWithOwn；后续重开（透传 loadedWithOwn=true）直接用 currentBigAccounts，
            // 避免覆盖用户在内存里的编辑（Codex Round 2 Finding 3）
            let bigAccountsForDialog = currentBigAccounts;
            if (!bigAccountsLoadedWithOwn) {
              try {
                const withOwnResult = await window.desktopApi.bigAccount.getWithOwn(payload.template.id);
                if (withOwnResult && withOwnResult.status === 'success' && Array.isArray(withOwnResult.bigAccounts)) {
                  bigAccountsForDialog = withOwnResult.bigAccounts;
                  currentBigAccounts = bigAccountsForDialog;
                  bigAccountsLoadedWithOwn = true;
                } else if (withOwnResult && withOwnResult.status === 'error') {
                  setStatus(withOwnResult.message || '获取大账号（含自有）失败', 'error');
                  return;
                }
              } catch (error) {
                setStatus('获取大账号（含自有）失败，请重试', 'error');
                return;
              }
            }
            openModal(createBigAccountManagerDialog({
              bigAccounts: bigAccountsForDialog,
              templateId: payload.template.id,
              templateName: payload.template.name,
              onDone: (nextBigAccounts) => {
                openModal(createMappingDialog({
                  ...payload,
                  mappings: draftMappings.map((mapping) => {
                    return mapping.templateField === 'MerchantId'
                      ? { ...mapping, mappedField: MERCHANT_ID_SELF_INPUT_OPTION, mappedFields: [] }
                      : mapping;
                  }),
                  bigAccounts: nextBigAccounts,
                  bigAccountsLoadedWithOwn: true,
                  fixedAssignments: currentFixedAssignments,
                  amountSplitRules: currentAmountSplitRules
                }));
              },
              onCancel: () => {
                openModal(createMappingDialog({
                  ...payload,
                  mappings: draftMappings,
                  bigAccounts: bigAccountsForDialog,
                  bigAccountsLoadedWithOwn: true,
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

        // 按钮文本始终填充（hidden 时靠 visibility:hidden 占位，避免列平移）
        const buttonLabel = fieldName === BILL_SPLIT_MERGE_FIELD
          ? '拆分/合并账单映射关系管理'
          : '拆分/合并账单映射关系设置';
        const buttonHidden = fieldName === BILL_SPLIT_MERGE_FIELD
          ? savedValue !== '是'
          : savedValue !== '否';

        const selectOptions = fieldName === BILL_SPLIT_MERGE_FIELD
          ? '<option value="">否</option><option value="是">是</option>'
          : '<option value="是">是</option><option value="否">否</option>';

        row.innerHTML = `
          <td>${escapeHtml(fieldName)}</td>
          <td>
            <div class="mapping-field-editor">
              <select class="mapping-select bill-split-group-select">${selectOptions}</select>
              <button class="secondary-btn small bill-split-group-btn" type="button" ${buttonHidden ? 'hidden' : ''}>${buttonLabel}</button>
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
              applyBillSplitMergeMutualExclusion(true);
            } else {
              button.hidden = true;
              applyBillSplitMergeMutualExclusion(false);
            }
          } else if (fieldName === REUSE_MODULE_FIELD) {
            button.hidden = newValue !== '否';
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
            // v1.5.3 R2 round 4 (Codex defensive)：显式透传 bigAccountsLoadedWithOwn
            // 虽然 ...payload spread 会自动带过来，显式声明可防未来 spread 漏写 / payload 形状重构
            openModal(createMappingDialog({
              ...payload,
              mappings: draftMappings,
              bigAccounts: draftBigAccounts,
              bigAccountsLoadedWithOwn,
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
            // v1.5.3 R2 round 4 (Codex defensive)：显式透传 bigAccountsLoadedWithOwn
            openModal(createMappingDialog({
              ...payload,
              mappings: draftMappings,
              bigAccounts: draftBigAccounts,
              bigAccountsLoadedWithOwn,
              fixedAssignments: currentFixedAssignments,
              amountSplitRules: currentAmountSplitRules,
              billSplitMappings: currentBillSplitMappings,
              billSplitRows: currentBillSplitRows,
              billSplitAmountRules: currentBillSplitAmountRules,
              billSplitMeta: currentBillSplitMeta
            }));
          },
          onCancel: () => {
            // v1.5.3 R2 round 4 (Codex defensive)：显式透传 bigAccountsLoadedWithOwn
            openModal(createMappingDialog({
              ...payload,
              mappings: draftMappings,
              bigAccounts: draftBigAccounts,
              bigAccountsLoadedWithOwn,
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

      function isBillSplitMergeEnabledInTable() {
        const row = rowByField.get(BILL_SPLIT_MERGE_FIELD);
        const select = row?.querySelector('.mapping-select');
        return select && select.value === '是';
      }

      function applyAmountSplitMutualExclusion() {
        // 若 bill-split-merge 已启用，4 方互斥由 applyBillSplitMergeMutualExclusion 全权管理，
        // 此处跳过，避免覆盖其设置的 disabled 状态（Fix #3）
        if (isBillSplitMergeEnabledInTable()) {
          return;
        }

        const amountSplitRow = rowByField.get(AMOUNT_SPLIT_BY_FIELD_MAPPING_FIELD);
        const amountSplitSelect = amountSplitRow?.querySelector('.mapping-select');
        const amountSplitEnabled = amountSplitSelect
          && getSelectValues(amountSplitSelect)[0] === AMOUNT_SPLIT_BY_FIELD_ENABLED_OPTION;

        const signedAmountRow = rowByField.get('按正负号拆分的发生额');
        const signedAmountSelect = signedAmountRow?.querySelector('.mapping-select');
        const signedAmountEnabled = signedAmountSelect
          && signedAmountSelect.value !== '';

        const creditRow = rowByField.get('Credit Amount');
        const creditSelect = creditRow?.querySelector('.mapping-select');

        const debitRow = rowByField.get('Debit Amount');
        const debitSelect = debitRow?.querySelector('.mapping-select');

        // 判定当前哪个模式被激活（3 选 1：按字段区分 / 按正负号 / 无）
        // Credit/Debit 直接映射是默认状态，不算独立模式，不触发互斥锁
        const activeMode = amountSplitEnabled ? 'amountSplit'
          : signedAmountEnabled ? 'signed'
          : 'none';

        // 按字段区分发生额 = 是 → 禁用 Credit / Debit / 按正负号
        // 按正负号拆分有值 → 禁用 Credit / Debit / 按字段区分
        // 无 → 全部启用

        function setRowDisabled(row, select, disabled) {
          if (!row || !select) return;
          if (disabled) {
            row.classList.add('mapping-row-mutex-disabled');
            select.disabled = true;
          } else {
            row.classList.remove('mapping-row-mutex-disabled');
            select.disabled = false;
          }
        }

        if (activeMode === 'amountSplit') {
          setRowDisabled(creditRow, creditSelect, true);
          setRowDisabled(debitRow, debitSelect, true);
          setRowDisabled(signedAmountRow, signedAmountSelect, true);
          setRowDisabled(amountSplitRow, amountSplitSelect, false);
        } else if (activeMode === 'signed') {
          setRowDisabled(creditRow, creditSelect, true);
          setRowDisabled(debitRow, debitSelect, true);
          setRowDisabled(signedAmountRow, signedAmountSelect, false);
          setRowDisabled(amountSplitRow, amountSplitSelect, true);
        } else {
          // none — 全部启用
          setRowDisabled(creditRow, creditSelect, false);
          setRowDisabled(debitRow, debitSelect, false);
          setRowDisabled(signedAmountRow, signedAmountSelect, false);
          setRowDisabled(amountSplitRow, amountSplitSelect, false);
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
            // 显式禁用该行的所有按钮（big-account 维护 / 发生额规则管理 / concat trigger 等）
            targetRow.querySelectorAll('button').forEach((btn) => {
              btn.disabled = true;
              btn.dataset.billSplitMergeDisabled = 'true';
            });
          } else {
            targetSelect.disabled = false;
            targetRow.classList.remove('bill-split-merge-disabled', 'mapping-row-mutex-disabled');
            targetRow.removeAttribute('title');
            // 恢复按钮状态（只恢复被 bill-split-merge 禁用的按钮）
            targetRow.querySelectorAll('button[data-bill-split-merge-disabled="true"]').forEach((btn) => {
              btn.disabled = false;
              delete btn.dataset.billSplitMergeDisabled;
            });
          }
        });
        // 禁用时不重新调用 amount-split mutex（它会在 isBillSplitMergeEnabledInTable 返回 true 时 noop）；
        // 解除时重新评估 amount-split mutex，保证 Credit/Debit/按正负号的禁用状态与「按字段区分发生额」一致
        if (!enabled) {
          applyAmountSplitMutualExclusion();
        }
      }

      async function openAmountSplitRulesDialog() {
        const draftBigAccounts = cloneBigAccountItems(currentBigAccounts);
        const draftMappings = collectMappingDraftFromTable(tbody);
        openModal(createAmountSplitRulesDialog({
          template: payload.template,
          initialRules: currentAmountSplitRules,
          onDone: (nextRules) => {
            currentAmountSplitRules = nextRules.map((rule) => ({ ...rule }));
            // v1.5.3 R2 round 4 (Codex defensive)：显式透传 bigAccountsLoadedWithOwn
            openModal(createMappingDialog({
              ...payload,
              mappings: draftMappings,
              bigAccounts: draftBigAccounts,
              bigAccountsLoadedWithOwn,
              fixedAssignments: currentFixedAssignments,
              amountSplitRules: currentAmountSplitRules
            }));
          },
          onCancel: () => {
            // v1.5.3 R2 round 4 (Codex defensive)：显式透传 bigAccountsLoadedWithOwn
            openModal(createMappingDialog({
              ...payload,
              mappings: draftMappings,
              bigAccounts: draftBigAccounts,
              bigAccountsLoadedWithOwn,
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
        // v1.5.2 需求 1：子/主模板名校验（必须在 saveMappings 之前）
        // 规则 D1：子模板名需包含主模板名字符串（含相等）；未勾子模板或未选主模板均跳过校验
        if (isChildCheckbox.checked && parentSelect.value) {
          const parentId = parentSelect.value;
          const parentTemplate = (state.templates || []).find((t) => String(t.id) === String(parentId));
          const currentName = String(payload.template.name || '');
          const parentName = String(parentTemplate?.name || '');
          if (!parentName || !currentName.includes(parentName)) {
            openModal(createAlertDialog('子模板与主模板模板名匹配不上，请检查。', {
              onConfirm: () => {
                openModal(createMappingDialog(payload));
              }
            }));
            return;
          }
        }

        const draftBigAccounts = cloneBigAccountItems(currentBigAccounts);
        const draftMappings = collectMappingDraftFromTable(tbody);

        const saveMappings = async (mappings) => {
          // v1.5.3 R2 round 3 (Codex Finding 5)：透传 preserveOwn
          // bigAccountsLoadedWithOwn=false（用户没打开维护大账号）→ draftBigAccounts 是 client-only → preserveOwn=true 保留 own
          // bigAccountsLoadedWithOwn=true（已 await getWithOwn 含 own 全集）→ preserveOwn=false 让 caller 全权（含主动删除 own）
          const result = await desktopApi.templates.saveMappings({
            templateId: payload.template.id,
            mappings,
            bigAccounts: draftBigAccounts,
            fixedAssignments: currentFixedAssignments,
            preserveOwn: !bigAccountsLoadedWithOwn
          });

          setStatus(result.message, result.status === 'success' ? 'success' : 'error', {
            errorReportReady: Boolean(result.errorReportReady)
          });

          if (result.status === 'success') {
            // 保存主/子模板状态
            const wantParent = isParentCheckbox.checked;
            const wantChild = isChildCheckbox.checked;
            const wasParent = templateIsParent;
            const wasChild = Boolean(templateParentId);

            if (wantParent !== wasParent) {
              if (!wantParent && wasParent && !unparentConfirmed) {
                // 取消主模板 — 检查是否有子模板（checkbox 层已确认则跳过）
                const children = await desktopApi.templates.listChildren(payload.template.id);
                if (children && children.length > 0) {
                  const confirmed = confirm(`该主模板下有 ${children.length} 个子模板，取消主模板身份后，子模板将恢复为普通模板。是否确认？`);
                  if (!confirmed) {
                    await refreshTemplates();
                    openModal(createTemplateManagerDialog());
                    return;
                  }
                }
              }
              await desktopApi.templates.setParentStatus(payload.template.id, wantParent);
            }

            if (wantChild) {
              const selectedParentId = parentSelect.value ? Number(parentSelect.value) : null;
              if (selectedParentId !== templateParentId) {
                await desktopApi.templates.setChildParent(payload.template.id, selectedParentId);
              }
            } else if (wasChild && !wantChild) {
              await desktopApi.templates.setChildParent(payload.template.id, null);
            }

            await refreshTemplates();
            openModal(createTemplateManagerDialog());
            return;
          }

          openModal(createAlertDialog(result.message, {
            onConfirm: () => {
              // v1.5.3 R2 round 4 (Codex defensive)：显式透传 bigAccountsLoadedWithOwn
              openModal(createMappingDialog({
                ...payload,
                mappings,
                bigAccounts: draftBigAccounts,
                bigAccountsLoadedWithOwn,
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
      // Balance 字段默认值为 BALANCE_DISABLED_OPTION（与主表格一致）
      let currentDialogMappings = displayTargetFields.map((f) => {
        const existing = (initialMappings || []).find((m) => m.templateField === f);
        const defaultMappedField = f === 'Balance' ? BALANCE_DISABLED_OPTION : '';
        return {
          templateField: f,
          mappedField: existing ? String(existing.mappedField || '') : defaultMappedField,
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

          const isBalanceField = entry.templateField === 'Balance';
          const isCurrencyLike = entry.templateField === 'Currency';
          const supportsMultiSelect = !isCurrencyLike && !isBalanceField;

          let selectOptions;
          if (isBalanceField) {
            // Balance 字段选项与主表格一致：禁用 / 通过发生额计算 / headers
            selectOptions = [
              `<option value="${BALANCE_DISABLED_OPTION}">${BALANCE_DISABLED_OPTION}</option>`,
              `<option value="${BALANCE_CALCULATED_OPTION}">${BALANCE_CALCULATED_OPTION}</option>`
            ].concat(headerOptions).join('');
          } else {
            selectOptions = ['<option value=""></option>']
              .concat(supportsMultiSelect ? [`<option value="${CONCAT_FIELDS_MAPPING_FIELD}">${CONCAT_FIELDS_MAPPING_FIELD}</option>`] : [])
              .concat(headerOptions)
              .join('');
          }

          row.innerHTML = `
            <td>${escapeHtml(entry.templateField)}</td>
            <td>
              <div class="mapping-field-editor">
                <select class="mapping-select bill-split-mapping-select">${selectOptions}</select>
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
            concatPreview.textContent = previewText.length > 120 ? previewText.slice(0, 120) + '......' : previewText;
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
          const defaultMappedField = f === 'Balance' ? BALANCE_DISABLED_OPTION : '';
          return hit
            ? { templateField: f, mappedField: hit.mappedField, mappedFields: hit.mappedFields }
            : { templateField: f, mappedField: defaultMappedField, mappedFields: [] };
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
        signedAmountSourceField: String((initialBillSplitMeta && initialBillSplitMeta.signedAmountSourceField) || ''),
        signedAmountTargetSeqNos: Array.isArray(initialBillSplitMeta?.signedAmountTargetSeqNos)
          ? initialBillSplitMeta.signedAmountTargetSeqNos.slice()
          : [],
        byFieldAmountTargetSeqNos: Array.isArray(initialBillSplitMeta?.byFieldAmountTargetSeqNos)
          ? initialBillSplitMeta.byFieldAmountTargetSeqNos.slice()
          : []
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
            <div class="bill-split-merge-picker" hidden>
              <button class="bill-split-merge-picker-trigger secondary-btn small" type="button">请选择账单序号</button>
              <div class="bill-split-merge-picker-panel" hidden></div>
            </div>
            <button class="secondary-btn small bill-split-merge-done-btn" type="button" hidden>完成</button>
            <button class="icon-close" type="button">×</button>
          </div>
        </div>
        <div class="bill-split-rows-body">
          <div class="bill-split-row-count-line">
            <label>需要拆分成几份账单</label>
            <input type="number" class="bill-split-row-count-input" min="1" max="99" />
            <button class="secondary-btn small bill-split-row-count-done-btn" type="button">拆</button>
          </div>
          <div class="table-wrapper bill-split-rows-table-wrapper">
            <table class="data-table bill-split-rows-table">
              <thead>
                <tr>
                  <th>账单序号</th>
                  <th>Currency</th>
                  <th>Credit Amount</th>
                  <th>Debit Amount</th>
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
              <label class="bill-split-target-seq-label bill-split-signed-target-seq-label" hidden>
                <input type="checkbox" class="bill-split-target-seq-checkbox bill-split-signed-target-seq-checkbox" />
                <span>指定账单实现功能</span>
              </label>
              <div class="bill-split-target-seq-picker bill-split-signed-target-seq-picker" hidden>
                <button class="bill-split-target-seq-trigger secondary-btn small" type="button">选择账单序号</button>
                <div class="bill-split-target-seq-panel bill-split-signed-target-seq-panel" hidden></div>
              </div>
            </div>
            <div class="bill-split-sub-row">
              <label>按字段区分发生额</label>
              <select class="mapping-select bill-split-by-field-select">
                <option value=""></option>
                <option value="是">是</option>
              </select>
              <button class="secondary-btn small bill-split-amount-rules-manage-btn" type="button" hidden>发生额映射关系管理</button>
              <label class="bill-split-target-seq-label bill-split-by-field-target-seq-label" hidden>
                <input type="checkbox" class="bill-split-target-seq-checkbox bill-split-by-field-target-seq-checkbox" />
                <span>指定账单实现功能</span>
              </label>
              <div class="bill-split-target-seq-picker bill-split-by-field-target-seq-picker" hidden>
                <button class="bill-split-target-seq-trigger secondary-btn small" type="button">选择账单序号</button>
                <div class="bill-split-target-seq-panel bill-split-by-field-target-seq-panel" hidden></div>
              </div>
            </div>
          </div>
        </div>
        <div class="dialog-actions right bill-split-rows-footer">
          <button class="primary-btn small bill-split-rows-done-btn" type="button">完成</button>
        </div>
      `;

      const tableBody = dialog.querySelector('.bill-split-rows-table tbody');
      const nInput = dialog.querySelector('.bill-split-row-count-input');
      const nDoneBtn = dialog.querySelector('.bill-split-row-count-done-btn');
      const mergeCheckbox = dialog.querySelector('.bill-split-merge-checkbox');
      const mergePicker = dialog.querySelector('.bill-split-merge-picker');
      const mergePickerTrigger = dialog.querySelector('.bill-split-merge-picker-trigger');
      const mergePickerPanel = dialog.querySelector('.bill-split-merge-picker-panel');
      const mergeDoneBtn = dialog.querySelector('.bill-split-merge-done-btn');
      let mergeSelectedSeqNos = [];
      const signedSelect = dialog.querySelector('.bill-split-signed-select');
      const byFieldSelect = dialog.querySelector('.bill-split-by-field-select');
      const amountRulesManageBtn = dialog.querySelector('.bill-split-amount-rules-manage-btn');

      // 指定账单实现功能 UI elements
      const signedTargetSeqLabel = dialog.querySelector('.bill-split-signed-target-seq-label');
      const signedTargetSeqCheckbox = dialog.querySelector('.bill-split-signed-target-seq-checkbox');
      const signedTargetSeqPicker = dialog.querySelector('.bill-split-signed-target-seq-picker');
      const signedTargetSeqTrigger = signedTargetSeqPicker.querySelector('.bill-split-target-seq-trigger');
      const signedTargetSeqPanel = dialog.querySelector('.bill-split-signed-target-seq-panel');

      const byFieldTargetSeqLabel = dialog.querySelector('.bill-split-by-field-target-seq-label');
      const byFieldTargetSeqCheckbox = dialog.querySelector('.bill-split-by-field-target-seq-checkbox');
      const byFieldTargetSeqPicker = dialog.querySelector('.bill-split-by-field-target-seq-picker');
      const byFieldTargetSeqTrigger = byFieldTargetSeqPicker.querySelector('.bill-split-target-seq-trigger');
      const byFieldTargetSeqPanel = dialog.querySelector('.bill-split-by-field-target-seq-panel');

      // 初始化副区域 UI
      signedSelect.value = currentBillSplitMeta.signedAmountSourceField || '';
      byFieldSelect.value = currentAmountRules.length > 0 ? '是' : '';
      amountRulesManageBtn.hidden = currentAmountRules.length === 0;

      // 指定账单实现功能：初始化
      function initTargetSeqUI() {
        const hasSignedValue = Boolean(signedSelect.value);
        signedTargetSeqLabel.hidden = !hasSignedValue;
        if (hasSignedValue && currentBillSplitMeta.signedAmountTargetSeqNos.length > 0) {
          signedTargetSeqCheckbox.checked = true;
          signedTargetSeqPicker.hidden = false;
          updateTargetSeqTriggerLabel(signedTargetSeqTrigger, currentBillSplitMeta.signedAmountTargetSeqNos);
        } else {
          signedTargetSeqCheckbox.checked = false;
          signedTargetSeqPicker.hidden = true;
        }

        const hasByFieldValue = byFieldSelect.value === '是';
        byFieldTargetSeqLabel.hidden = !hasByFieldValue;
        if (hasByFieldValue && currentBillSplitMeta.byFieldAmountTargetSeqNos.length > 0) {
          byFieldTargetSeqCheckbox.checked = true;
          byFieldTargetSeqPicker.hidden = false;
          updateTargetSeqTriggerLabel(byFieldTargetSeqTrigger, currentBillSplitMeta.byFieldAmountTargetSeqNos);
        } else {
          byFieldTargetSeqCheckbox.checked = false;
          byFieldTargetSeqPicker.hidden = true;
        }
      }

      function updateTargetSeqTriggerLabel(trigger, seqNos) {
        if (seqNos.length === 0) {
          trigger.textContent = '选择账单序号';
        } else if (seqNos.length <= 5) {
          trigger.textContent = `已选: ${seqNos.join(', ')}`;
        } else {
          trigger.textContent = `已选: ${seqNos.length} 项`;
        }
      }

      function getCurrentSeqNos() {
        return currentRows.map((r) => r.seqNo);
      }

      function renderTargetSeqPanel(panel, selectedSeqNos) {
        panel.innerHTML = '';
        const currentSeqNos = getCurrentSeqNos();
        currentSeqNos.forEach((seqNo) => {
          const option = document.createElement('div');
          option.className = 'bill-split-target-seq-option';
          const checkbox = document.createElement('input');
          checkbox.type = 'checkbox';
          checkbox.value = String(seqNo);
          checkbox.checked = selectedSeqNos.includes(seqNo);
          const label = document.createElement('span');
          label.textContent = `账单 ${seqNo}`;
          option.append(checkbox, label);
          option.addEventListener('click', (event) => {
            if (event.target === checkbox) return;
            checkbox.checked = !checkbox.checked;
            checkbox.dispatchEvent(new Event('change'));
          });
          panel.appendChild(option);
        });
      }

      function collectSelectedSeqNos(panel) {
        return Array.from(panel.querySelectorAll('input[type="checkbox"]:checked'))
          .map((cb) => Number(cb.value))
          .sort((a, b) => a - b);
      }

      function updateTargetSeqNos(type, seqNos) {
        if (type === 'signed') {
          currentBillSplitMeta.signedAmountTargetSeqNos = seqNos;
        } else {
          currentBillSplitMeta.byFieldAmountTargetSeqNos = seqNos;
        }
        desktopApi.templates.saveBillSplitMeta({
          templateId: template.id,
          signedAmountSourceField: currentBillSplitMeta.signedAmountSourceField,
          signedAmountTargetSeqNos: currentBillSplitMeta.signedAmountTargetSeqNos,
          byFieldAmountTargetSeqNos: currentBillSplitMeta.byFieldAmountTargetSeqNos
        });
        rerenderTable();
      }

      // 按正负号：指定账单 checkbox
      signedTargetSeqCheckbox.addEventListener('change', () => {
        if (signedTargetSeqCheckbox.checked) {
          signedTargetSeqPicker.hidden = false;
          renderTargetSeqPanel(signedTargetSeqPanel, currentBillSplitMeta.signedAmountTargetSeqNos);
        } else {
          signedTargetSeqPicker.hidden = true;
          signedTargetSeqPanel.hidden = true;
          updateTargetSeqNos('signed', []);
          updateTargetSeqTriggerLabel(signedTargetSeqTrigger, []);
        }
      });

      signedTargetSeqTrigger.addEventListener('click', () => {
        renderTargetSeqPanel(signedTargetSeqPanel, currentBillSplitMeta.signedAmountTargetSeqNos);
        signedTargetSeqPanel.hidden = !signedTargetSeqPanel.hidden;
      });

      // 按字段区分：指定账单 checkbox
      byFieldTargetSeqCheckbox.addEventListener('change', () => {
        if (byFieldTargetSeqCheckbox.checked) {
          byFieldTargetSeqPicker.hidden = false;
          renderTargetSeqPanel(byFieldTargetSeqPanel, currentBillSplitMeta.byFieldAmountTargetSeqNos);
        } else {
          byFieldTargetSeqPicker.hidden = true;
          byFieldTargetSeqPanel.hidden = true;
          updateTargetSeqNos('byField', []);
          updateTargetSeqTriggerLabel(byFieldTargetSeqTrigger, []);
        }
      });

      byFieldTargetSeqTrigger.addEventListener('click', () => {
        renderTargetSeqPanel(byFieldTargetSeqPanel, currentBillSplitMeta.byFieldAmountTargetSeqNos);
        byFieldTargetSeqPanel.hidden = !byFieldTargetSeqPanel.hidden;
      });

      initTargetSeqUI();

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
        // Credit/Debit 列清空（仅被指定的行，或没勾选指定功能时全部清空）
        if (enabled) {
          const hasTargetSeq = signedTargetSeqCheckbox.checked || byFieldTargetSeqCheckbox.checked;
          currentRows.forEach((row) => {
            const isTargeted = currentBillSplitMeta.signedAmountTargetSeqNos.includes(row.seqNo)
              || currentBillSplitMeta.byFieldAmountTargetSeqNos.includes(row.seqNo);
            if (!hasTargetSeq || isTargeted) {
              row.creditSourceField = '';
              row.debitSourceField = '';
            }
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
          <td>
            <select class="mapping-select bill-split-currency-select" ${isCompleted ? 'hidden' : ''}>${headerOptionsHtml}</select>
            <span class="bill-split-row-view-text" ${isCompleted ? '' : 'hidden'}></span>
          </td>
          <td>
            <select class="mapping-select bill-split-credit-select" ${isCompleted ? 'hidden' : ''}>${headerOptionsHtml}</select>
            <span class="bill-split-row-view-text" ${isCompleted ? '' : 'hidden'}></span>
          </td>
          <td>
            <select class="mapping-select bill-split-debit-select" ${isCompleted ? 'hidden' : ''}>${headerOptionsHtml}</select>
            <span class="bill-split-row-view-text" ${isCompleted ? '' : 'hidden'}></span>
          </td>
          <td class="bill-split-row-actions">
            <button class="text-action bill-split-row-complete-btn" type="button">${isCompleted ? '编辑' : '完成'}</button>
            <button class="text-action danger bill-split-row-delete-btn" type="button">删除</button>
          </td>
        `;

        const currencySel = tr.querySelector('.bill-split-currency-select');
        const creditSel = tr.querySelector('.bill-split-credit-select');
        const debitSel = tr.querySelector('.bill-split-debit-select');
        const viewTexts = tr.querySelectorAll('.bill-split-row-view-text');
        const completeBtn = tr.querySelector('.bill-split-row-complete-btn');
        const deleteBtn = tr.querySelector('.bill-split-row-delete-btn');

        currencySel.value = row.currencySourceField || '';
        creditSel.value = row.creditSourceField || '';
        debitSel.value = row.debitSourceField || '';

        // 完成态：显示纯文本
        if (isCompleted) {
          viewTexts[0].textContent = row.currencySourceField || '';
          viewTexts[1].textContent = row.creditSourceField || '';
          viewTexts[2].textContent = row.debitSourceField || '';
        }

        // 指定账单实现功能：检查是否启用 + 当前行是否被指定
        const hasTargetSeqChecked = signedTargetSeqCheckbox.checked || byFieldTargetSeqCheckbox.checked;
        const isTargetedBySigned = currentBillSplitMeta.signedAmountTargetSeqNos.includes(row.seqNo);
        const isTargetedByField = currentBillSplitMeta.byFieldAmountTargetSeqNos.includes(row.seqNo);
        const isTargetedByAny = isTargetedBySigned || isTargetedByField;


        // 禁用规则（仅编辑态生效）
        if (isMerged) {
          currencySel.disabled = true;
          creditSel.disabled = true;
          debitSel.disabled = true;
        } else if (!isCompleted) {
          currencySel.disabled = false;
          if (amountEnabled && hasTargetSeqChecked) {
            // 副区域有值 + 勾选了指定账单：被指定行禁用，未指定行可选
            creditSel.disabled = isTargetedByAny;
            debitSel.disabled = isTargetedByAny;
          } else if (amountEnabled) {
            // 副区域有值 + 没勾选指定账单：所有行 Credit/Debit 禁用
            creditSel.disabled = true;
            debitSel.disabled = true;
          } else {
            creditSel.disabled = false;
            debitSel.disabled = false;
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
            currentBillSplitMeta = {
              signedAmountSourceField: String((result.billSplitMeta && result.billSplitMeta.signedAmountSourceField) || ''),
              signedAmountTargetSeqNos: Array.isArray(result.billSplitMeta?.signedAmountTargetSeqNos)
                ? result.billSplitMeta.signedAmountTargetSeqNos.slice()
                : [],
              byFieldAmountTargetSeqNos: Array.isArray(result.billSplitMeta?.byFieldAmountTargetSeqNos)
                ? result.billSplitMeta.byFieldAmountTargetSeqNos.slice()
                : []
            };
            signedSelect.value = currentBillSplitMeta.signedAmountSourceField || '';
            byFieldSelect.value = currentAmountRules.length > 0 ? '是' : '';
            amountRulesManageBtn.hidden = currentAmountRules.length === 0;
            initTargetSeqUI();
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

      function getMergeCandidateSeqNos() {
        return currentRows
          .filter((r) => r.rowStatus === 'completed' && (r.mergedGroupSeq === null || r.mergedGroupSeq === undefined))
          .map((r) => Number(r.seqNo));
      }

      function updateMergePickerTriggerLabel() {
        if (!mergePickerTrigger) return;
        if (mergeSelectedSeqNos.length === 0) {
          mergePickerTrigger.textContent = '请选择账单序号';
        } else if (mergeSelectedSeqNos.length <= 5) {
          mergePickerTrigger.textContent = `已选: ${mergeSelectedSeqNos.join(', ')}`;
        } else {
          mergePickerTrigger.textContent = `已选: ${mergeSelectedSeqNos.length} 项`;
        }
      }

      function renderMergePickerPanel() {
        if (!mergePickerPanel) return;
        mergePickerPanel.replaceChildren();
        const candidates = getMergeCandidateSeqNos();
        if (candidates.length === 0) {
          const empty = document.createElement('div');
          empty.className = 'bill-split-merge-picker-empty';
          empty.textContent = '暂无可合并的已完成账单';
          mergePickerPanel.appendChild(empty);
          return;
        }
        candidates.forEach((seqNo) => {
          const option = document.createElement('div');
          option.className = 'bill-split-merge-picker-option';
          const checkbox = document.createElement('input');
          checkbox.type = 'checkbox';
          checkbox.checked = mergeSelectedSeqNos.includes(seqNo);
          const label = document.createElement('span');
          label.textContent = String(seqNo);
          option.append(checkbox, label);
          option.addEventListener('click', (event) => {
            if (event.target === checkbox) return;
            checkbox.checked = !checkbox.checked;
            checkbox.dispatchEvent(new Event('change'));
          });
          checkbox.addEventListener('change', () => {
            if (checkbox.checked) {
              if (!mergeSelectedSeqNos.includes(seqNo)) {
                mergeSelectedSeqNos.push(seqNo);
                mergeSelectedSeqNos.sort((a, b) => a - b);
              }
            } else {
              mergeSelectedSeqNos = mergeSelectedSeqNos.filter((s) => s !== seqNo);
            }
            updateMergePickerTriggerLabel();
          });
          mergePickerPanel.appendChild(option);
        });
      }

      if (mergePickerTrigger && mergePickerPanel) {
        mergePickerTrigger.addEventListener('click', () => {
          const isOpen = !mergePickerPanel.hidden;
          mergePickerPanel.hidden = isOpen;
          if (!isOpen) {
            renderMergePickerPanel();
          }
        });
      }

      // 合并账单勾选框
      mergeCheckbox.addEventListener('change', async () => {
        if (mergeCheckbox.checked) {
          // 显示 picker + 完成按钮
          mergeSelectedSeqNos = [];
          mergePicker.hidden = false;
          mergeDoneBtn.hidden = false;
          updateMergePickerTriggerLabel();
          renderMergePickerPanel();
        } else {
          mergePicker.hidden = true;
          mergeDoneBtn.hidden = true;
          if (mergePickerPanel) mergePickerPanel.hidden = true;
          mergeSelectedSeqNos = [];
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
        const selectedSeqNos = mergeSelectedSeqNos.slice();
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
            mergeSelectedSeqNos = [];
            updateMergePickerTriggerLabel();
            if (mergePickerPanel) {
              mergePickerPanel.hidden = true;
            }
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
        const hasValue = Boolean(newValue);
        signedTargetSeqLabel.hidden = !hasValue;
        if (!hasValue) {
          signedTargetSeqCheckbox.checked = false;
          signedTargetSeqPicker.hidden = true;
          signedTargetSeqPanel.hidden = true;
          currentBillSplitMeta.signedAmountTargetSeqNos = [];
        }
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
            byFieldTargetSeqLabel.hidden = true;
            byFieldTargetSeqCheckbox.checked = false;
            byFieldTargetSeqPicker.hidden = true;
            byFieldTargetSeqPanel.hidden = true;
            currentBillSplitMeta.byFieldAmountTargetSeqNos = [];
          }
          await desktopApi.templates.saveBillSplitMeta({
            templateId: template.id,
            signedAmountSourceField: newValue,
            signedAmountTargetSeqNos: currentBillSplitMeta.signedAmountTargetSeqNos,
            byFieldAmountTargetSeqNos: currentBillSplitMeta.byFieldAmountTargetSeqNos
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
        const hasValue = newValue === '是';
        byFieldTargetSeqLabel.hidden = !hasValue;
        if (!hasValue) {
          byFieldTargetSeqCheckbox.checked = false;
          byFieldTargetSeqPicker.hidden = true;
          byFieldTargetSeqPanel.hidden = true;
          currentBillSplitMeta.byFieldAmountTargetSeqNos = [];
        }
        if (newValue === '是') {
          // 打开子弹框配置规则
          if (currentBillSplitMeta.signedAmountSourceField) {
            // 互斥：先清空对侧
            try {
              await desktopApi.templates.saveBillSplitMeta({
                templateId: template.id,
                signedAmountSourceField: '',
                signedAmountTargetSeqNos: [],
                byFieldAmountTargetSeqNos: currentBillSplitMeta.byFieldAmountTargetSeqNos
              });
              currentBillSplitMeta.signedAmountSourceField = '';
              currentBillSplitMeta.signedAmountTargetSeqNos = [];
              signedSelect.value = '';
              signedTargetSeqLabel.hidden = true;
              signedTargetSeqCheckbox.checked = false;
              signedTargetSeqPicker.hidden = true;
              signedTargetSeqPanel.hidden = true;
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
            updateTargetSeqNos('byField', []);
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

      // 弹框 2 底部完成按钮：语义等同 × 关闭（一切已行级落库，无需额外 save 动作）
      dialog.querySelector('.bill-split-rows-done-btn').addEventListener('click', () => {
        if (typeof onClose === 'function') onClose();
        else closeModal();
      });

      dialog.addEventListener('mousedown', (event) => {
        if (!event.target.closest('.bill-split-merge-picker')) {
          if (mergePickerPanel && !mergePickerPanel.hidden) {
            mergePickerPanel.hidden = true;
          }
        }
        if (!event.target.closest('.bill-split-target-seq-picker')) {
          if (!signedTargetSeqPanel.hidden) {
            signedTargetSeqPanel.hidden = true;
            const selected = collectSelectedSeqNos(signedTargetSeqPanel);
            updateTargetSeqNos('signed', selected);
            updateTargetSeqTriggerLabel(signedTargetSeqTrigger, selected);
          }
          if (!byFieldTargetSeqPanel.hidden) {
            byFieldTargetSeqPanel.hidden = true;
            const selected = collectSelectedSeqNos(byFieldTargetSeqPanel);
            updateTargetSeqNos('byField', selected);
            updateTargetSeqTriggerLabel(byFieldTargetSeqTrigger, selected);
          }
        }
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
      let activeTemplateId = payload.currentTemplateId || null;
      dialog.innerHTML = `
        <div class="dialog-header">
          <div class="account-mapping-template-select-wrapper">
            模板 <select data-role="template-select"></select>
          </div>
          <button class="icon-close" type="button">×</button>
        </div>
        <div class="table-wrapper">
          <table class="data-table">
            <thead>
              <tr>
                <th>网银账单账户号</th>
                <th>清结算系统银行账号</th>
                <th>币种 <span class="currency-tooltip-wrap"><span class="currency-tooltip-icon">&#9432;</span><span class="currency-tooltip-text">当账户映射中填写了币种时，导出账单时会自动使用此币种覆盖文件中缺失的币种信息。适用于网银文件中有账户号但无币种列的场景。</span></span></th>
                <th>执行操作</th>
              </tr>
            </thead>
            <tbody></tbody>
          </table>
        </div>
        <div class="dialog-actions right">
          <button class="primary-btn small" type="button" data-action="done">完成</button>
        </div>
      `;

      const templateSelect = dialog.querySelector('[data-role="template-select"]');
      const tbody = dialog.querySelector('tbody');

      // 填充模板下拉框
      (payload.templates || []).forEach((t) => {
        const opt = document.createElement('option');
        opt.value = String(t.id);
        opt.textContent = t.name;
        if (String(t.id) === String(activeTemplateId)) {
          opt.selected = true;
        }
        templateSelect.appendChild(opt);
      });

      function createReadOnlyRow(bankAccountId, clearingAccountId, noCurrency, currency) {
        const row = document.createElement('tr');
        row.dataset.accountMappingRow = 'true';
        let isEditing = false;

        const bankCell = document.createElement('td');
        const clearingCell = document.createElement('td');
        const currencyCell = document.createElement('td');
        const actionCell = document.createElement('td');
        actionCell.className = 'account-mapping-action-cell';

        const bankSpan = document.createElement('span');
        bankSpan.textContent = bankAccountId;
        const clearingSpan = document.createElement('span');
        clearingSpan.textContent = clearingAccountId;
        const currencySpan = document.createElement('span');
        currencySpan.textContent = currency;

        const bankInput = document.createElement('input');
        bankInput.className = 'mapping-text-input account-mapping-id-input';
        bankInput.type = 'text';
        bankInput.spellcheck = false;
        bankInput.value = bankAccountId;
        bankInput.style.display = 'none';

        const clearingInput = document.createElement('input');
        clearingInput.className = 'mapping-text-input account-mapping-id-input';
        clearingInput.type = 'text';
        clearingInput.spellcheck = false;
        clearingInput.value = clearingAccountId;
        clearingInput.style.display = 'none';

        const currencyInput = document.createElement('input');
        currencyInput.className = 'mapping-text-input';
        currencyInput.type = 'text';
        currencyInput.spellcheck = false;
        currencyInput.value = currency;
        currencyInput.style.display = 'none';

        const editBtn = document.createElement('button');
        editBtn.className = 'text-action';
        editBtn.type = 'button';
        editBtn.textContent = '编辑';

        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'text-action danger';
        deleteBtn.type = 'button';
        deleteBtn.textContent = '删除';

        function toggleEdit() {
          isEditing = !isEditing;
          bankSpan.style.display = isEditing ? 'none' : '';
          clearingSpan.style.display = isEditing ? 'none' : '';
          currencySpan.style.display = isEditing ? 'none' : '';
          bankInput.style.display = isEditing ? '' : 'none';
          clearingInput.style.display = isEditing ? '' : 'none';
          currencyInput.style.display = isEditing ? '' : 'none';
          editBtn.textContent = isEditing ? '完成' : '编辑';

          if (!isEditing) {
            bankSpan.textContent = bankInput.value;
            clearingSpan.textContent = clearingInput.value;
            currencySpan.textContent = currencyInput.value;
          }
        }

        editBtn.addEventListener('click', toggleEdit);
        deleteBtn.addEventListener('click', () => { row.remove(); });

        bankCell.append(bankSpan, bankInput);
        clearingCell.append(clearingSpan, clearingInput);
        currencyCell.append(currencySpan, currencyInput);
        actionCell.append(editBtn, deleteBtn);
        row.append(bankCell, clearingCell, currencyCell, actionCell);

        row.__rowApi = {
          getBankAccountId: () => bankInput.value,
          getClearingAccountId: () => clearingInput.value,
          getNoCurrency: () => currencyInput.value.trim() !== '',
          getCurrency: () => currencyInput.value.trim()
        };
        return row;
      }

      function createEditableRow(bankAccountId = '', clearingAccountId = '', noCurrency = false, currency = '') {
        const row = document.createElement('tr');
        row.dataset.accountMappingRow = 'true';

        const bankCell = document.createElement('td');
        const clearingCell = document.createElement('td');
        const currencyCell = document.createElement('td');
        const actionCell = document.createElement('td');
        actionCell.className = 'account-mapping-action-cell';

        const bankInput = document.createElement('input');
        bankInput.className = 'mapping-text-input account-mapping-id-input';
        bankInput.type = 'text';
        bankInput.spellcheck = false;
        bankInput.value = bankAccountId;

        const clearingInput = document.createElement('input');
        clearingInput.className = 'mapping-text-input account-mapping-id-input';
        clearingInput.type = 'text';
        clearingInput.spellcheck = false;
        clearingInput.value = clearingAccountId;

        const currencyInput = document.createElement('input');
        currencyInput.className = 'mapping-text-input';
        currencyInput.type = 'text';
        currencyInput.spellcheck = false;
        currencyInput.value = currency;

        const doneBtn = document.createElement('button');
        doneBtn.className = 'text-action';
        doneBtn.type = 'button';
        doneBtn.textContent = '完成';

        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'text-action danger';
        deleteBtn.type = 'button';
        deleteBtn.textContent = '删除';

        doneBtn.addEventListener('click', () => {
          const newRow = createReadOnlyRow(bankInput.value, clearingInput.value, currencyInput.value.trim() !== '', currencyInput.value.trim());
          row.parentNode.replaceChild(newRow, row);
        });
        deleteBtn.addEventListener('click', () => { row.remove(); });

        bankCell.appendChild(bankInput);
        clearingCell.appendChild(clearingInput);
        currencyCell.appendChild(currencyInput);
        actionCell.append(doneBtn, deleteBtn);
        row.append(bankCell, clearingCell, currencyCell, actionCell);

        row.__rowApi = {
          getBankAccountId: () => bankInput.value,
          getClearingAccountId: () => clearingInput.value,
          getNoCurrency: () => currencyInput.value.trim() !== '',
          getCurrency: () => currencyInput.value.trim()
        };
        return row;
      }

      function createAddRow() {
        const row = document.createElement('tr');
        row.className = 'add-row';
        row.innerHTML = `
          <td><button class="text-action" type="button" data-action="add">新增</button></td>
          <td></td><td></td><td></td>
        `;

        row.querySelector('[data-action="add"]').addEventListener('click', () => {
          tbody.insertBefore(createEditableRow('', ''), row);
        });

        return row;
      }

      function loadMappings(mappings) {
        tbody.innerHTML = '';
        (mappings || []).forEach((mapping) => {
          tbody.appendChild(createReadOnlyRow(
            mapping.bankAccountId,
            mapping.clearingAccountId,
            Boolean(mapping.noCurrency),
            mapping.currency || ''
          ));
        });
        tbody.appendChild(createAddRow());
      }

      loadMappings(payload.mappings);

      templateSelect.addEventListener('change', async () => {
        activeTemplateId = Number(templateSelect.value);
        const result = await desktopApi.accountMappings.list(activeTemplateId);
        if (result.status === 'success') {
          loadMappings(result.mappings);
        }
      });

      dialog.querySelector('.icon-close').addEventListener('click', closeModal);
      dialog.querySelector('[data-action="done"]').addEventListener('click', async () => {
        const mappings = Array.from(tbody.querySelectorAll('tr[data-account-mapping-row="true"]')).map((row) => ({
          bankAccountId: row.__rowApi.getBankAccountId(),
          clearingAccountId: row.__rowApi.getClearingAccountId(),
          noCurrency: row.__rowApi.getNoCurrency(),
          currency: row.__rowApi.getCurrency()
        }));

        const result = await desktopApi.accountMappings.save(activeTemplateId, mappings);

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

    function createRememberOrderMismatchDialog({ message, bigAccountResult }) {
      const overlay = createOverlay();
      const dialog = document.createElement('div');
      dialog.className = 'modal-card alert-card';
      dialog.innerHTML = `
        <div class="alert-body">
          <div class="alert-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="28" height="28"><defs><linearGradient id="rememberMismatchIconG" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#E95EA2"/><stop offset="100%" stop-color="#F6B93B"/></linearGradient></defs><path d="M12 3L2 20h20L12 3z" fill="none" stroke="url(#rememberMismatchIconG)" stroke-width="2" stroke-linejoin="round"/><path d="M12 10v4M12 17h.01" stroke="url(#rememberMismatchIconG)" stroke-width="2" stroke-linecap="round"/></svg>
          </div>
          <div class="alert-message">${message}</div>
        </div>
        <div class="dialog-actions center">
          <button class="secondary-btn small" type="button" data-action="change-config">变更配置</button>
          <button class="primary-btn small" type="button" data-action="confirm">确认</button>
        </div>
      `;

      dialog.querySelector('[data-action="change-config"]').addEventListener('click', () => {
        closeModal();
        const selectionPayload = {
          ...bigAccountResult,
          status: 'select-big-account'
        };
        openModal(createBigAccountSelectionDialog(selectionPayload));
      });

      dialog.querySelector('[data-action="confirm"]').addEventListener('click', () => {
        closeModal();
      });

      overlay.appendChild(dialog);
      return overlay;
    }

    function createAccountMappingMigrationDialog({ rows = [], templates = [], onDone }) {
      const overlay = createOverlay();
      const dialog = document.createElement('div');
      dialog.className = 'modal-card manager-card';
      dialog.innerHTML = `
        <div class="dialog-header">
          <div class="dialog-title">账户映射分配</div>
          <button class="icon-close" type="button">×</button>
        </div>
        <div class="table-wrapper">
          <table class="data-table">
            <thead>
              <tr>
                <th>网银账单账户号</th>
                <th>清结算系统银行账号</th>
                <th>币种</th>
                <th>分配到模板</th>
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
      const templateOptions = templates.map((t) => {
        return `<option value="${t.id}">${escapeHtml(t.name)}</option>`;
      }).join('');

      rows.forEach((row, index) => {
        const tr = document.createElement('tr');
        tr.dataset.migrationRow = String(index);
        tr.innerHTML = `
          <td class="account-mapping-text-cell">${escapeHtml(row.bankAccountId)}</td>
          <td class="account-mapping-text-cell">${escapeHtml(row.clearingAccountId)}</td>
          <td>${escapeHtml(row.currency || '—')}</td>
          <td><select class="mapping-select migration-template-select"><option value="">请选择模板</option>${templateOptions}</select></td>
        `;
        tbody.appendChild(tr);
      });

      dialog.querySelector('.icon-close').addEventListener('click', closeModal);

      dialog.querySelector('[data-action="done"]').addEventListener('click', async () => {
        const allRows = Array.from(tbody.querySelectorAll('tr[data-migration-row]'));
        const assignments = [];
        let hasEmpty = false;

        allRows.forEach((tr, index) => {
          const select = tr.querySelector('.migration-template-select');
          const templateId = select.value;
          if (!templateId) {
            hasEmpty = true;
            return;
          }
          assignments.push({
            bankAccountId: rows[index].bankAccountId,
            clearingAccountId: rows[index].clearingAccountId,
            noCurrency: rows[index].noCurrency,
            currency: rows[index].currency,
            templateId: Number(templateId)
          });
        });

        if (hasEmpty) {
          openModal(createAlertDialog('请为所有行选择对应的模板', {
            onConfirm: () => {
              openModal(createAccountMappingMigrationDialog({ rows, templates, onDone }));
            }
          }));
          return;
        }

        const result = await window.desktopApi.accountMappings.distributeMigration(assignments);
        if (result.status === 'success') {
          setStatus('账户映射分配完成', 'success');
          closeModal();
          if (onDone) onDone();
        } else {
          setStatus(result.message || '分配失败', 'error');
          openModal(createAlertDialog(result.message || '分配失败'));
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
      createMonthlyBalanceExportDialog,
      createManualBalanceSeedDialog,
      escapeHtml,
      cloneBigAccountItems,
      formatBigAccountCurrencySummary,
      getBigAccountCurrencyTitle,
      collectMappingDraftFromTable,
      createTemplateRenameDialog,
      createBigAccountSelectionDialog,
      createBigAccountManagerDialog,
      createRememberOrderMismatchDialog,
      renderTemplateTableRows,
      createTemplateManagerDialog,
      createMappingDialog,
      createAccountMappingDialog,
      createAccountMappingMigrationDialog,
      // v1.5.3 round 6：补全 preview 所需 factory（业务代码不直接用，仅 preview 链路调）
      createAmountSplitRulesDialog,
      createBillSplitRowsDialog,
      createBillSplitMappingsDialog,
      createBalanceAddonManagerDialog
    };
  }

  global.__rendererDialogs = {
    createRendererDialogs
  };
}(window));
