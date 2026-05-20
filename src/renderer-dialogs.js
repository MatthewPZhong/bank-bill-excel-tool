(function initRendererDialogs(global) {
  function createRendererDialogs(deps) {
    const {
      state,
      elements,
      desktopApi,
      appConstants,
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
      applyManualBalancePromptStatus,
      refreshBankStatementStatus,
      // v2.1.0-beta.1 PR-A（task A9）：场景管理 dialog 任意 CRUD 操作完成后 reload 主面板"场景"下拉
      reloadReconIdFixScenarios
    } = deps;

    // v2.0.0-beta.3 PR #32b：银行对账单处理模块字段常量（preload 暴露 → window.appConstants → deps）
    const BANK_STATEMENT_FIELDS = (appConstants && appConstants.bankStatementFields) || [];
    const BANK_STATEMENT_FIELDS_FOR_C3 = (appConstants && appConstants.bankStatementFieldsForC3) || BANK_STATEMENT_FIELDS;
    const GATEWAY_RECON_FIELDS = (appConstants && appConstants.gatewayReconFields) || [];
    // v2.1.0-beta.1 PR-A：单据对账 ReconID 修复模块字段常量（spec §四，business 子模式）
    const BUSINESS_BILL_FIELDS = (appConstants && appConstants.businessBillFields) || [];
    const OPPONENT_BILL_FIELDS = (appConstants && appConstants.opponentBillFields) || [];
    // v2.1.0-beta.3 T7：网关对账单 ReconID 修复模块字段常量（gateway 子模式）
    const GATEWAY_BILL_FIELDS = (appConstants && appConstants.gatewayBillFields) || [];
    const CHANNEL_BILL_FIELDS = (appConstants && appConstants.channelBillFields) || [];

    // 条件操作枚举（C1 行 3 + C2 行 3 共用）
    const SCENARIO_CONDITION_OPS = ['等于', '不等于', '包含', '不包含', '空值', '非空值', '开头为'];

    // 操作 op 是否需要值输入框（'空值' / '非空值' 不需要）
    function opNeedsValue(op) {
      return op !== '空值' && op !== '非空值';
    }

    // 给 select 渲染 options（用文件已有的 escapeHtml）
    function renderScenarioOptions(values, selected = '') {
      const sel = String(selected ?? '');
      return values
        .map((v) => {
          const s = String(v);
          const safe = escapeHtml(s);
          return `<option value="${safe}"${s === sel ? ' selected' : ''}>${safe}</option>`;
        })
        .join('');
    }

    function clearScenarioDraft() {
      state.scenarioDraft = null;
    }

    // 把 mode 转换为弹窗右下按钮配置
    // create / edit → "取消 / 确认"；view → "返回"
    function getScenarioDialogActions(mode) {
      if (mode === 'view') {
        return [{ kind: 'secondary', action: 'back', text: '返回' }];
      }
      // v2.1.0-beta.2 PR-B（task B6）：[确认 取消] 顺序（互换），4 个 scenario config dialog 都受影响
      return [
        { kind: 'primary', action: 'confirm', text: '确认' },
        { kind: 'secondary', action: 'cancel', text: '取消' }
      ];
    }

    // v2.1.0-beta.3 T6：对账单ReconID修复模块下挂 business（单据）+ gateway（网关）两个子模式 helper
    //   两个 category 共用 C4 dialog 骨架（matchRules/billTypes/reconGroups/output schema 相同）；
    //   仅文案/枚举/SubBizType 显隐/输出列等"表层"按 mode 切换（详见 T7）。
    const RECON_ID_FIX_CATEGORIES = ['recon-id-fix', 'gateway-recon-id-fix'];
    function isReconIdFixCategory(category) {
      return RECON_ID_FIX_CATEGORIES.includes(category);
    }
    function reconIdFixModeFromCategory(category) {
      // 'recon-id-fix' → 'business'（v2.1.0-beta.1 已有单据子模式）
      // 'gateway-recon-id-fix' → 'gateway'（v2.1.0-beta.3 新增网关子模式）
      return category === 'gateway-recon-id-fix' ? 'gateway' : 'business';
    }

    // 4 个 dialog 配置弹窗 + 确认详情弹窗共用：根据 category 进入对应配置弹窗
    function openScenarioConfigByCategory(category) {
      if (category === 'extract-recon-id') return openModal(createScenarioConfigDialogC1());
      if (category === 'offset-bill-mark') return openModal(createScenarioConfigDialogC2());
      if (category === 'gateway-recon-join') return openModal(createScenarioConfigDialogC3());
      // v2.1.0-beta.1 PR-A（task A6 / A7）：C4 类配置弹窗（单据子模式）
      // v2.1.0-beta.3 T6/T7：两个 ReconID 子模式（business/gateway）共用 createScenarioConfigDialogC4；
      //   dialog 内部从 state.scenarioDraft.category 推导 subMode（business/gateway），不依赖参数
      if (isReconIdFixCategory(category)) {
        return openModal(createScenarioConfigDialogC4());
      }
      throw new Error(`unknown scenario category: ${category}`);
    }

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

    function createConfirmDialog({ message, confirmText, cancelText, onConfirm, onCancel, middleText, onMiddle }) {
      const overlay = createOverlay();
      const dialog = document.createElement('div');
      dialog.className = 'modal-card alert-card';
      // PR #33 Codex Finding 1：可选 middleText/onMiddle 支持三按钮（C3 运行点二次提示三选一）
      const middleBtnHtml = middleText
        ? `<button class="secondary-btn small" type="button" data-action="middle">${middleText}</button>`
        : '';
      dialog.innerHTML = `
        <div class="alert-body">
          <div class="alert-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="28" height="28"><defs><linearGradient id="confirmIconG" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#E95EA2"/><stop offset="100%" stop-color="#F6B93B"/></linearGradient></defs><path d="M12 3L2 20h20L12 3z" fill="none" stroke="url(#confirmIconG)" stroke-width="2" stroke-linejoin="round"/><path d="M12 10v4M12 17h.01" stroke="url(#confirmIconG)" stroke-width="2" stroke-linecap="round"/></svg>
          </div>
          <div class="alert-message">${message}</div>
        </div>
        <div class="dialog-actions center">
          <button class="danger-btn small" type="button" data-action="confirm">${confirmText}</button>
          ${middleBtnHtml}
          <button class="secondary-btn small" type="button" data-action="cancel">${cancelText}</button>
        </div>
      `;
      dialog.querySelector('[data-action="confirm"]').addEventListener('click', async () => {
        await onConfirm();
      });
      if (middleText) {
        dialog.querySelector('[data-action="middle"]').addEventListener('click', async () => {
          if (onMiddle) await onMiddle();
        });
      }
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

    // v2.0.0-beta.3：银行对账单处理模块 — 场景管理弹窗
    // 6 列表格：序号 / 功能类别 / 场景名称 / 优先级 / 执行操作 / 是否启动
    // 编辑模式两段式锁（D5）：编辑→完成 切换；查看场景→修改场景 切换
    // 内置场景与用户场景同等地位（D14）：可删除可编辑
    const SCENARIO_CATEGORY_LABELS = {
      'extract-recon-id': '提取ReconId-From Self',
      'offset-bill-mark': '账单打标',
      'gateway-recon-join': '提取ReconId-From 网关',
      // v2.1.0-beta.1 PR-A（task A6）：单据对账修复
      // v2.1.0-beta.3 修订（用户反馈）：'单据对账修复' → '单据对账单修复'
      'recon-id-fix': '单据对账单修复',
      // v2.1.0-beta.3 T7：网关对账修复（C4 gateway 子模式）
      // v2.1.0-beta.3 修订（用户反馈）：'网关对账修复' → '网关对账单修复'
      'gateway-recon-id-fix': '网关对账单修复'
    };

    function getCategoryLabel(category) {
      return SCENARIO_CATEGORY_LABELS[category] || category;
    }

    async function loadScenariosOrAlert() {
      const result = await desktopApi.scenarios.list();
      if (result && result.status === 'ok') {
        return Array.isArray(result.scenarios) ? result.scenarios : [];
      }
      openModal(createAlertDialog(`加载场景列表失败：${result?.message || '未知错误'}`));
      return null;
    }

    function createScenariosManagerDialog(allowedCategories = null) {
      // v2.1.0-beta.2 PR-A：白名单过滤（null = 不过滤，向后兼容）
      // 同时落 state.activeScenarioListFilter，让所有 reopen 链路（reopenScenariosManager helper）
      // 都能回到正确的过滤视图（C1-C4 dialog 取消 / 保存成功 / 删除成功 / 类别选择取消都会 reopen）
      const filter = Array.isArray(allowedCategories) && allowedCategories.length > 0
        ? allowedCategories
        : null;
      state.activeScenarioListFilter = filter;
      // v2.1.0-beta.2 PR-A Round 2（task R2-8）：单类别入口（filter.length === 1）隐藏 优先级 + 是否启动 两列
      // 单类别没有"跨场景调度"语义，优先级和是否启动失去意义；同时让其余列宽度按比例放大填满。
      const isCompactView = Array.isArray(filter) && filter.length === 1;
      const priorityTh = isCompactView ? '' : '<th class="scenarios-col-priority" style="width: 10%; text-align: center;">优先级</th>';
      const enabledTh = isCompactView ? '' : '<th class="scenarios-col-enabled" style="width: 13%;">是否启动</th>';
      const idWidth = isCompactView ? '6%' : '5%';
      const categoryWidth = isCompactView ? '28%' : '22%';
      const nameWidth = isCompactView ? '40%' : '30.94%';
      const actionsWidth = isCompactView ? '26%' : '19.06%';
      const overlay = createOverlay();
      const dialog = document.createElement('div');
      dialog.className = 'modal-card manager-card scenarios-manager-card';
      dialog.innerHTML = `
        <div class="dialog-header">
          <div class="dialog-title">场景管理</div>
          <button class="icon-close" type="button">×</button>
        </div>
        <div class="table-wrapper">
          <table class="data-table scenarios-table">
            <thead>
              <tr>
                <th class="scenarios-col-id" style="width: ${idWidth}; padding-left: 0; padding-right: 0; text-align: left; white-space: nowrap;"><span style="display: inline-block; margin-left: 21px;">序号</span></th>
                <th class="scenarios-col-category" style="width: ${categoryWidth}; padding-left: 0; padding-right: 4px; text-align: left;">功能类别</th>
                <th class="scenarios-col-name" style="width: ${nameWidth}; padding-left: 0; text-align: left;">场景名称</th>
                ${priorityTh}
                <th class="scenarios-col-actions" style="width: ${actionsWidth}; padding-left: 8px; text-align: left;">执行操作</th>
                ${enabledTh}
              </tr>
            </thead>
            <tbody></tbody>
          </table>
        </div>
        <div class="dialog-actions scenarios-manager-footer">
          <button class="primary-btn small" type="button" data-action="add-scenario">新增场景</button>
          <button class="primary-btn small" type="button" data-action="finish">完成</button>
        </div>
      `;

      const tbody = dialog.querySelector('tbody');

      function renderRow(scenario, displayIndex) {
        const tr = document.createElement('tr');
        tr.dataset.id = String(scenario.id);
        tr.dataset.category = scenario.category;
        // v2.1.0-beta.2 PR-A Round 2：
        // - task R2-7：序号 = 列表内 1-based 顺序号（不再用真实 scenarios.id；dataset.id 仍是真实 id 用于 IPC）
        // - task R2-8：compact 模式（单类别入口）隐藏 优先级 + 是否启动 td
        const priorityTd = isCompactView ? '' : `<td class="scenarios-col-priority">${escapeHtml(String(scenario.priority))}</td>`;
        const enabledTd = isCompactView ? '' : `<td class="scenarios-col-enabled"><input type="checkbox" data-row-action="toggle-enabled" ${scenario.enabled ? 'checked' : ''} /></td>`;
        tr.innerHTML = `
          <td class="scenarios-col-id" style="padding-left: 0; padding-right: 0; text-align: left; white-space: nowrap;"><span style="display: inline-block; margin-left: 21px;">${escapeHtml(String(displayIndex))}</span></td>
          <td class="scenarios-col-category">${escapeHtml(getCategoryLabel(scenario.category))}</td>
          <td class="scenarios-col-name">${escapeHtml(scenario.name)}</td>
          ${priorityTd}
          <td class="scenarios-col-actions">
            <button class="text-action" type="button" data-row-action="manage">管理</button>
            <button class="text-action danger-text" type="button" data-row-action="delete">删除</button>
          </td>
          ${enabledTd}
        `;
        return tr;
      }

      async function refreshTable() {
        const scenarios = await loadScenariosOrAlert();
        if (scenarios === null) return;
        // v2.1.0-beta.2 PR-A：按白名单过滤
        const visible = filter ? scenarios.filter((s) => filter.includes(s.category)) : scenarios;
        tbody.innerHTML = '';
        // v2.1.0-beta.2 PR-A Round 2（task R2-7）：传 displayIndex（1-based 列表内顺序）给 renderRow
        visible.forEach((scenario, idx) => {
          tbody.appendChild(renderRow(scenario, idx + 1));
        });
      }

      // 委托：单一 click handler 处理 tbody 内所有 row-action
      tbody.addEventListener('click', async (event) => {
        const button = event.target.closest('[data-row-action]');
        if (!button) return;
        const tr = button.closest('tr');
        if (!tr) return;
        const id = Number(tr.dataset.id);
        const action = button.dataset.rowAction;

        if (action === 'manage') {
          // 直接进入 edit 模式（取消两段式锁，简化为单按钮"管理"）
          const result = await desktopApi.scenarios.get(id);
          if (!result || result.status !== 'ok' || !result.scenario) {
            openModal(createAlertDialog(`加载场景失败：${result?.message || '未知错误'}`));
            return;
          }
          const sc = result.scenario;
          state.scenarioDraft = {
            mode: 'edit',
            category: sc.category,
            scenarioId: sc.id,
            name: sc.name,
            priority: sc.priority,
            config: sc.config
          };
          openScenarioConfigByCategory(sc.category);
          return;
        }

        if (action === 'delete') {
          const name = tr.querySelector('.scenarios-col-name')?.textContent || '';
          openModal(createConfirmDialog({
            message: `确认删除场景「${name}」？此操作不可撤销。`,
            confirmText: '删除',
            cancelText: '取消',
            onConfirm: async () => {
              const result = await desktopApi.scenarios.deleteOne(id);
              if (result && result.status === 'ok') {
                // v2.1.0-beta.2 PR #38 round 2 P2-2：按 category 分流，避免操作 C1/C2/C3 清掉 ReconID 导出态，反之亦然
                // v2.1.0-beta.3 PR #39 Finding 2（P2）：用 isReconIdFixCategory 识别两个 C4 子模式（含 gateway-recon-id-fix）
                //   之前只识别 'recon-id-fix' → 删除 gateway 场景误走 refreshBankStatementStatus
                const deletedCategory = tr.dataset.category;
                if (isReconIdFixCategory(deletedCategory)) {
                  if (typeof reloadReconIdFixScenarios === 'function') await reloadReconIdFixScenarios();
                } else {
                  if (typeof refreshBankStatementStatus === 'function') await refreshBankStatementStatus();
                }
                openModal(reopenScenariosManager());
              } else {
                openModal(createAlertDialog(`删除失败：${result?.message || '未知错误'}`));
              }
            }
          }));
          return;
        }
      });

      // 是否启动 checkbox 用 change 事件单独绑（与 click 区分）
      tbody.addEventListener('change', async (event) => {
        const checkbox = event.target.closest('input[data-row-action="toggle-enabled"]');
        if (!checkbox) return;
        const tr = checkbox.closest('tr');
        if (!tr) return;
        const id = Number(tr.dataset.id);
        const enabled = checkbox.checked;
        const result = await desktopApi.scenarios.toggleEnabled(id, enabled);
        if (!result || result.status !== 'ok') {
          // 失败回滚 + 重渲（容错）
          console.warn('toggle scenario enabled failed:', result);
          checkbox.checked = !enabled;
          await refreshTable();
          openModal(createAlertDialog(`切换启用状态失败：${result?.message || '未知错误'}`));
        } else {
          // v2.1.0-beta.2 PR #38 round 2 P2-2：按 category 分流，避免跨模块互抹状态
          // v2.1.0-beta.3 T6：两个 ReconID 子模式（business/gateway）共用 reloadReconIdFixScenarios
          const toggledCategory = tr.dataset.category;
          if (isReconIdFixCategory(toggledCategory)) {
            if (typeof reloadReconIdFixScenarios === 'function') await reloadReconIdFixScenarios();
          } else {
            if (typeof refreshBankStatementStatus === 'function') await refreshBankStatementStatus();
          }
        }
      });

      // v2.1.0-beta.1 PR-A（task A9）：场景管理 dialog 关闭时（× / 点空白处通用 closeModal 通道也覆盖）
      // v2.1.0-beta.2 PR #38 round 2 P2-2：仅 ReconID 入口（filter 含 'recon-id-fix'）才刷新 ReconID 主面板下拉
      // v2.1.0-beta.2 PR #38 round 3 P2-1：close 不是 CRUD，传 scenariosChanged: false 避免清 state.reconIdFixExport
      //   （真正的 create/update/delete/toggle 路径在上方已分别调用 reloadReconIdFixScenarios() 默认参数清状态）
      function closeAndReloadReconList() {
        closeModal();
        // v2.1.0-beta.3 T6：两个 ReconID 子模式（business/gateway）的白名单都触发 reload
        const shouldReloadReconId = filter
          ? filter.some((c) => isReconIdFixCategory(c))
          : true;
        if (shouldReloadReconId && typeof reloadReconIdFixScenarios === 'function') {
          reloadReconIdFixScenarios({ scenariosChanged: false }).catch((err) => {
            console.warn('reloadReconIdFixScenarios on dialog close failed:', err);
          });
        }
      }
      dialog.querySelector('.icon-close').addEventListener('click', closeAndReloadReconList);
      // v2.1.0-beta.2 PR-A Round 2（task R2-6）：右下"完成"按钮 = 关闭 dialog 并刷新主面板下拉（同 closeAndReloadReconList）
      dialog.querySelector('[data-action="finish"]').addEventListener('click', closeAndReloadReconList);
      dialog.querySelector('[data-action="add-scenario"]').addEventListener('click', () => {
        // v2.1.0-beta.2 PR-A：单类别白名单（如 ReconID 入口）跳过类别选择窗，直接进入对应配置 dialog
        if (filter && filter.length === 1) {
          const onlyCategory = filter[0];
          state.scenarioDraft = {
            mode: 'create',
            category: onlyCategory,
            scenarioId: null,
            name: '',
            priority: 0,
            config: createDefaultScenarioConfig(onlyCategory)
          };
          closeModal();
          openScenarioConfigByCategory(onlyCategory);
          return;
        }
        openModal(createScenarioCategorySelectDialog(filter));
      });

      refreshTable();

      overlay.appendChild(dialog);
      return overlay;
    }

    // v2.1.0-beta.2 PR-A：reopen 场景管理 dialog 的统一入口（透传当前白名单）
    // 用于 C1-C4 dialog 取消 / 删除场景 / 类别选择取消 / 确认弹窗成功 等 11 处 reopen 链路。
    // 不传 allowedCategories 调用 createScenariosManagerDialog 会回到全表，破坏隔离。
    function reopenScenariosManager() {
      return createScenariosManagerDialog(state.activeScenarioListFilter);
    }

    // v2.0.0-beta.3：新增场景流程第 1 步 — 类别选择弹窗
    // v2.1.0-beta.2 PR-A：按 allowedCategories 白名单过滤可见类别
    // v2.1.0-beta.3 T6：新增 'gateway-recon-id-fix' 类别（label "网关对账单 ReconID 修复"）
    //   实际不会暴露给用户：ReconID 模块入口的白名单总是单类别（business 或 gateway），
    //   单类别 → 跳过此弹窗直接进 C4 dialog（参考 L5573 的 add-scenario click handler）
    function createScenarioCategorySelectDialog(allowedCategories = null) {
      const ALL_CATEGORY_OPTIONS = [
        { value: 'extract-recon-id', label: '提取ReconId-From Self' },
        { value: 'offset-bill-mark', label: '账单打标' },
        { value: 'gateway-recon-join', label: '提取ReconId-From 网关' },
        { value: 'recon-id-fix', label: '单据对账 ReconID 修复' },
        { value: 'gateway-recon-id-fix', label: '网关对账单 ReconID 修复' }
      ];
      const visibleOptions = Array.isArray(allowedCategories) && allowedCategories.length > 0
        ? ALL_CATEGORY_OPTIONS.filter((c) => allowedCategories.includes(c.value))
        : ALL_CATEGORY_OPTIONS;
      const optionsHtml = visibleOptions
        .map((c) => `<option value="${c.value}">${escapeHtml(c.label)}</option>`)
        .join('');
      const overlay = createOverlay();
      const dialog = document.createElement('div');
      dialog.className = 'modal-card scenario-category-select-card';
      dialog.innerHTML = `
        <div class="dialog-header">
          <div class="dialog-title">新增场景</div>
          <button class="icon-close" type="button">×</button>
        </div>
        <div class="dialog-body scenario-category-body">
          <label class="scenario-category-row">
            <span class="scenario-category-label">请选择功能类别</span>
            <select class="scenario-category-select">
              ${optionsHtml}
            </select>
          </label>
        </div>
        <div class="dialog-actions right">
          <button class="secondary-btn small" type="button" data-action="cancel">取消</button>
          <button class="primary-btn small" type="button" data-action="continue">继续</button>
        </div>
      `;

      dialog.querySelector('.icon-close').addEventListener('click', () => {
        openModal(reopenScenariosManager());
      });
      dialog.querySelector('[data-action="cancel"]').addEventListener('click', () => {
        openModal(reopenScenariosManager());
      });
      dialog.querySelector('[data-action="continue"]').addEventListener('click', () => {
        const select = dialog.querySelector('.scenario-category-select');
        const category = select?.value || '';
        if (!category) return;
        // 初始化 create 模式的 draft（mode='create'，无预填）
        state.scenarioDraft = {
          mode: 'create',
          category,
          scenarioId: null,
          name: '',
          priority: 0,
          config: createDefaultScenarioConfig(category)
        };
        openScenarioConfigByCategory(category);
      });

      overlay.appendChild(dialog);
      return overlay;
    }

    // v2.0.0-beta.3 PR #32b：默认 config 模板（create 模式无预填时用）
    function createDefaultScenarioConfig(category) {
      if (category === 'extract-recon-id') {
        return {
          conditions: [{ field: '', op: '等于', value: '' }],
          // v2.1.7 F1：新增条件聚合逻辑字段；默认 OR（与 v2.1.6 行为一致）
          conditionsLogic: 'OR',
          extractByFeature: null,
          extractByOtherField: null
        };
      }
      if (category === 'offset-bill-mark') {
        return {
          billTypes: [
            { seq: 1, field: '', op: '等于', value: '' },
            { seq: 2, field: '', op: '等于', value: '' }
          ],
          reconFields: [{ seq: 1, leftType: 1, leftField: '', rightType: 2, rightField: '' }],
          markValue: { type: 2, field: '', value: '' }
        };
      }
      if (category === 'gateway-recon-join') {
        return {
          // v2.1.5 N3：柔性默认 — 空数组（不强制添加首行；区别于 C1 默认 1 行）
          conditions: [],
          reconFields: [{ seq: 1, gwField: '', bankField: '' }],
          assign: { gwField: '', bankField: '' }
        };
      }
      // v2.1.0-beta.1 PR-A（task A7）：C4 类默认 config（spec §8.2）
      // v2.1.0-beta.1 PR-B（Q1=B 决策，2026-04-30）：reconFields[] → reconGroups[]
      //   每个 group 自带 leftTypeSeq/rightTypeSeq + fieldPairs[]（一组内 AND；多组 OR）
      // v2.1.0-beta.1 PR-B Round 3（Decision 4，2026-05-09）：默认 group 带 Amount 锁定字段对
      // v2.1.0-beta.3 T6：两个 ReconID 子模式共用默认 config schema（matchRules/billTypes/reconGroups/output）
      //   gateway 模式与 business 模式默认 config 结构相同；差异在 dialog 渲染（mode-switch，T7）
      // v2.1.0-beta.3 PR #39 review-round-2 Finding 1（P1）：gateway 子模式默认锁定字段 rightField 必须为 'receiveAmount'
      //   （之前 'Amount' 让用户新建 gateway 场景引擎匹配不到渠道账单 — 1v1/1v多/多v1 都 fixedRows=0）
      if (isReconIdFixCategory(category)) {
        const defaultLockedRight = category === 'gateway-recon-id-fix' ? 'receiveAmount' : 'Amount';
        return {
          matchRules: { oneToOne: true, oneToMany: false, manyToOne: false },
          billTypes: [
            { seq: 1, side: 'main', conditions: [{ field: '', op: '等于', value: '' }] }
          ],
          reconGroups: [
            {
              leftTypeSeq: 1,
              rightTypeSeq: 1,
              fieldPairs: [
                { leftField: 'Amount', rightField: defaultLockedRight, locked: true }
              ]
            }
          ],
          output: {
            mode: 'main', // 'main' | 'opp' | 'both'
            commonId: { source: 'main', suffix: '' },
            subBizType: { mode: 'auto', mainValue: '', oppValue: '' } // 'auto' | 'manualMain' | 'manualOpp' | 'manualBoth'
          },
          // v2.1.1 T2-2：BillDate ±N 默认 enabled=false（引擎走 ±1day 缺省，零回归）；days=3（勾选后首次展示值）
          billDateRange: { enabled: false, days: 3 }
        };
      }
      return {};
    }

    // v2.0.0-beta.3 PR #32b：dialog 共用工具
    function buildScenarioActionsHtml(mode) {
      return getScenarioDialogActions(mode)
        .map((a) => `<button class="${a.kind}-btn small" type="button" data-action="${a.action}">${a.text}</button>`)
        .join('');
    }

    function getCategoryDialogTitle(category, mode) {
      const modeLabel = mode === 'view' ? '查看场景' : (mode === 'edit' ? '修改场景' : '新增场景');
      // v2.1.0-beta.2 PR-B（task B5）：仅 C4（recon-id-fix）类别省略 ` — 类别名` 后缀（用户决定 C1/C2/C3 保留）
      // v2.1.0-beta.3 T6：两个 ReconID 子模式都省略后缀（dialog 标题统一"新增/修改场景"）
      if (isReconIdFixCategory(category)) {
        return modeLabel;
      }
      const label = getCategoryLabel(category);
      return `${modeLabel} — ${label}`;
    }

    // 把 draft.name / .priority 同步到 input
    function bindScenarioBasicFields(dialog, draft) {
      const nameInput = dialog.querySelector('input[data-field="name"]');
      const priorityInput = dialog.querySelector('input[data-field="priority"]');
      if (nameInput) {
        nameInput.addEventListener('input', () => {
          draft.name = nameInput.value;
        });
      }
      if (priorityInput) {
        priorityInput.addEventListener('input', () => {
          const v = Number(priorityInput.value);
          draft.priority = Number.isFinite(v) ? v : 0;
        });
      }
    }

    // 校验 + 错误提示（弹 alert）
    function validateScenarioDraft(draft) {
      const errors = [];
      if (!draft.name || draft.name.trim() === '') errors.push('场景名称不能为空');
      const p = Number(draft.priority);
      if (!Number.isInteger(p) || p < 0 || p > 3) errors.push('优先级必须是 0-3 之间的整数');
      if (draft.category === 'extract-recon-id') {
        const c = draft.config || {};
        if (!Array.isArray(c.conditions) || c.conditions.length === 0) errors.push('条件至少需要 1 行');
        else if (c.conditions.some((cd) => !cd.field || (opNeedsValue(cd.op) && (cd.value === '' || cd.value === undefined)))) {
          errors.push('条件每行的字段不能为空；非「空值/非空值」操作的值不能为空');
        }
        const f = c.extractByFeature;
        const o = c.extractByOtherField;
        // 行 4/5 至少勾一个（否则场景没有任何提取规则，运行时无产出）
        const featureChosen = !!(f && f.enabled);
        const otherChosen = !!o;
        if (!featureChosen && !otherChosen) {
          errors.push('「根据特征提取 ReconId」和「根据其他字段提取 ReconId」必须至少勾选一个');
        }
        if (featureChosen) {
          const validSearchFields = Array.isArray(f.searchFields) ? f.searchFields.filter((x) => x && String(x).trim()) : [];
          // 同步清理 draft：去掉空字段（用户加了空行又不选）
          f.searchFields = validSearchFields;
          if (validSearchFields.length === 0) errors.push('"根据特征提取"的筛选字段至少选 1 个');
          if (!/^[A-Z]+$/.test(String(f.featureCode || ''))) errors.push('英文特征必须是大写英文字母（A-Z）');
          if (!Number.isInteger(Number(f.digitCount)) || Number(f.digitCount) < 1) errors.push('数字位数必须 ≥ 1');
          if (!Number.isInteger(Number(f.totalLength)) || Number(f.totalLength) < Number(f.digitCount) + String(f.featureCode || '').length) {
            errors.push('总位数必须 ≥ 数字位数 + 英文特征长度');
          }
        }
        if (otherChosen && (!o.field || o.field === '')) errors.push('"根据其他字段提取"的字段不能为空');
      } else if (draft.category === 'offset-bill-mark') {
        const c = draft.config || {};
        if (!Array.isArray(c.billTypes) || c.billTypes.length < 2) errors.push('账单类型至少需要 2 行');
        else if (c.billTypes.some((b) => !b.field || (opNeedsValue(b.op) && (b.value === '' || b.value === undefined)))) {
          errors.push('账单类型每行的字段不能为空；非「空值/非空值」操作的值不能为空');
        }
        if (!Array.isArray(c.reconFields) || c.reconFields.length === 0) errors.push('对账字段至少需要 1 行');
        else if (c.reconFields.some((r) => !r.leftField || !r.rightField)) errors.push('对账字段每行两端的字段都不能为空');
        const mv = c.markValue || {};
        const billTypeSeqs = (c.billTypes || []).map((b) => b.seq);
        if (!billTypeSeqs.includes(Number(mv.type))) errors.push('打标值的"账单类型"必须存在于上方账单类型列表中');
        if (!mv.field) errors.push('打标值的字段不能为空');
        if (mv.value === '' || mv.value === undefined) errors.push('打标值的写入值不能为空');
      } else if (draft.category === 'gateway-recon-join') {
        const c = draft.config || {};
        if (!Array.isArray(c.reconFields) || c.reconFields.length === 0) errors.push('对账字段至少需要 1 行');
        else if (c.reconFields.some((r) => !r.gwField || !r.bankField)) errors.push('对账字段每行两端都不能为空');
        const a = c.assign || {};
        if (!a.gwField || !a.bankField) errors.push('对账成立后赋值的两端都不能为空');
        // v2.1.5 N3：conditions 柔性校验
        //   - conditions.length === 0 → 通过（视为不过滤）
        //   - ≥ 1 行 → 每行 side / field 必填；非「空值/非空值」op 的 value 必填；side 与 field 一致性校验
        const conds = Array.isArray(c.conditions) ? c.conditions : [];
        if (conds.length > 0) {
          conds.forEach((cd, idx) => {
            const rowLabel = `条件 #${idx + 1}`;
            if (cd.side !== '网关' && cd.side !== '银行') {
              errors.push(`${rowLabel} 的"侧"必填（网关 / 银行）`);
              return;
            }
            if (!cd.field || String(cd.field).trim() === '') {
              errors.push(`${rowLabel} 的"字段"不能为空`);
              return;
            }
            // side 与 field 一致性（防御左一切换未清空 + 手改 DB）
            const validFields = cd.side === '网关' ? GATEWAY_RECON_FIELDS : BANK_STATEMENT_FIELDS_FOR_C3;
            if (!validFields.includes(cd.field)) {
              errors.push(`${rowLabel} 的"字段" ${cd.field} 不在 ${cd.side} 字段列表中`);
              return;
            }
            if (opNeedsValue(cd.op) && (cd.value === '' || cd.value === undefined)) {
              errors.push(`${rowLabel} 非"空值/非空值"操作的"值"不能为空`);
            }
          });
        }
      } else if (isReconIdFixCategory(draft.category)) {
        // v2.1.0-beta.1 PR-A（task A7）：C4 校验
        // v2.1.0-beta.3 T6：两个 ReconID 子模式共用校验（schema 相同）；SubBizType 校验跳过逻辑由 T7 按 mode 实施
        const c = draft.config || {};
        const mr = c.matchRules || {};
        if (!mr.oneToOne && !mr.oneToMany && !mr.manyToOne) {
          errors.push('单据匹配规则至少勾 1 项');
        }
        if (mr.oneToMany && mr.manyToOne) {
          errors.push('"1 v 多"与"多 v 1"互斥，不能同时勾选');
        }
        // v2.1.1 T2-2：BillDate ±N 校验（仅勾选时校验 days；不勾选 → 用默认 ±1day，无需校验）
        const bdr = c.billDateRange || null;
        if (bdr && bdr.enabled) {
          const d = Number(bdr.days);
          if (!Number.isInteger(d) || d < 1 || d > 999) {
            errors.push('BillDate 日期范围必须是 1-999 的正整数');
          }
        }
        const billTypesArr = Array.isArray(c.billTypes) ? c.billTypes : [];
        if (billTypesArr.length === 0) {
          errors.push('对账字段至少需要 1 行');
        } else {
          billTypesArr.forEach((bt, idx) => {
            if (!bt.side || (bt.side !== 'main' && bt.side !== 'opp')) {
              errors.push(`对账字段 #${bt.seq || idx + 1} 的"主/从"必填`);
            }
            const conds = Array.isArray(bt.conditions) ? bt.conditions : [];
            if (conds.length === 0) {
              errors.push(`对账字段 #${bt.seq || idx + 1} 至少需要 1 个条件`);
            } else if (conds.some((cd) => !cd.field || (opNeedsValue(cd.op) && (cd.value === '' || cd.value === undefined)))) {
              errors.push(`对账字段 #${bt.seq || idx + 1} 每行的字段不能为空；非"空值/非空值"操作的值不能为空`);
            }
          });
        }
        // v2.1.0-beta.1 PR-A round 2 P2-2（数据完整性）：必须主从两侧都有账单类型
        // 否则保存出来的 C4 配置在 PR-B 引擎里会跑出空 leftRows / rightRows，相当于无效场景
        const hasMainBillType = billTypesArr.some((bt) => bt.side === 'main');
        const hasOppBillType = billTypesArr.some((bt) => bt.side === 'opp');
        if (billTypesArr.length > 0) {
          if (!hasMainBillType) errors.push('对账字段必须至少包含 1 条"主边"对账字段');
          if (!hasOppBillType) errors.push('对账字段必须至少包含 1 条"从边"对账字段');
        }

        // v2.1.0-beta.1 PR-B（Q1=B 决策，2026-04-30）：对账字段以 reconGroups[] 形式存储
        //   reconGroups[i] = { leftTypeSeq, rightTypeSeq, fieldPairs: [{leftField, rightField}, ...] }
        //   - 一个 group 内部 AND（fieldPair 数 ≥ 1）
        //   - 多个 group 之间 OR（group 数 ≥ 1）
        if (!Array.isArray(c.reconGroups) || c.reconGroups.length === 0) {
          errors.push('对账内容至少需要 1 个分组');
        } else {
          c.reconGroups.forEach((grp, gIdx) => {
            const grpLabel = `对账内容分组 #${gIdx + 1}`;
            if (!grp || typeof grp !== 'object') {
              errors.push(`${grpLabel} 结构错误`);
              return;
            }
            if (!Array.isArray(grp.fieldPairs) || grp.fieldPairs.length === 0) {
              errors.push(`${grpLabel} 至少需要 1 行字段对`);
            } else if (grp.fieldPairs.some((fp) => !fp || !fp.leftField || !fp.rightField)) {
              errors.push(`${grpLabel} 每行字段对的两端字段都不能为空`);
            }
          });
        }
        // v2.1.0-beta.1 PR-A round 2 P2-2（数据完整性，PR-B Q1=B 适配后保留语义）：
        //   每个 reconGroup 的 leftTypeSeq → side === 'main'；rightTypeSeq → side === 'opp'
        //   否则保存的配置语义错误，PR-B 引擎按主/从边过滤行时会丢分组
        if (Array.isArray(c.reconGroups) && c.reconGroups.length > 0 && billTypesArr.length > 0) {
          const sideBySeq = new Map(billTypesArr.map((bt) => [Number(bt.seq), bt.side]));
          c.reconGroups.forEach((grp, gIdx) => {
            if (!grp || typeof grp !== 'object') return;
            const grpLabel = `对账内容分组 #${gIdx + 1}`;
            const leftSeq = Number(grp.leftTypeSeq);
            const rightSeq = Number(grp.rightTypeSeq);
            if (!sideBySeq.has(leftSeq)) {
              errors.push(`${grpLabel} 左侧的对账字段序号 #${grp.leftTypeSeq} 不在对账字段列表中`);
            } else if (sideBySeq.get(leftSeq) !== 'main') {
              errors.push(`${grpLabel} 左侧必须指向"主边"对账字段`);
            }
            if (!sideBySeq.has(rightSeq)) {
              errors.push(`${grpLabel} 右侧的对账字段序号 #${grp.rightTypeSeq} 不在对账字段列表中`);
            } else if (sideBySeq.get(rightSeq) !== 'opp') {
              errors.push(`${grpLabel} 右侧必须指向"从边"对账字段`);
            }
          });
        }
        const out = c.output || {};
        // v2.1.0-beta.3 T7：errors 文案按 subMode 切换；SubBizType 校验在 gateway 模式整段跳过
        const subMode = reconIdFixModeFromCategory(draft.category);
        const isGwSubMode = subMode === 'gateway';
        if (!out.mode || (out.mode !== 'main' && out.mode !== 'opp' && out.mode !== 'both')) {
          errors.push(isGwSubMode
            ? '订单修复ID取值必填（网关账单 / 渠道账单 / 自取值）'
            : '修复结果输出方向必填（主边 / 从边 / 主从都修复）');
        }
        // gateway 模式：勾选 1v多/多v1 时禁止 output.mode='main'
        if (isGwSubMode && out.mode === 'main' && (c.matchRules.oneToMany || c.matchRules.manyToOne)) {
          errors.push('网关 1v多 / 多v1 模式下不能选择"网关账单"作为订单修复ID取值');
        }
        if (out.mode === 'both') {
          const ci = out.commonId || {};
          // v2.1.0-beta.3 修订（用户反馈）：取值来源新增空值选项 ''（用户主动选）；
          //   选择空值时 suffix "加上"输入框必须非空
          if (ci.source !== 'main' && ci.source !== 'opp' && ci.source !== '') {
            errors.push(isGwSubMode
              ? '"自取值"取值来源选项无效'
              : '"主从都修复"取值来源选项无效');
          }
          if (ci.source === '' && (!ci.suffix || String(ci.suffix).trim() === '')) {
            errors.push(isGwSubMode
              ? '"自取值"取值来源选择空值时，右侧"加上"输入框必须填写内容'
              : '"主从都修复"取值来源选择空值时，右侧"加上"输入框必须填写内容');
          }
        }
        // gateway 模式：SubBizType 整段跳过（dialog 内已不渲染该区块）
        if (!isGwSubMode) {
          const sub = out.subBizType || {};
          const validSubModes = ['auto', 'manualMain', 'manualOpp', 'manualBoth'];
          if (!validSubModes.includes(sub.mode)) {
            errors.push('SubBizType 取值方式必填');
          }
          if (sub.mode === 'manualMain' && !sub.mainValue) errors.push('"主边单据 SubBizType 值"不能为空');
          if (sub.mode === 'manualOpp' && !sub.oppValue) errors.push('"从边单据 SubBizType 值"不能为空');
          if (sub.mode === 'manualBoth') {
            if (!sub.mainValue) errors.push('"主边单据 SubBizType 值"不能为空');
            if (!sub.oppValue) errors.push('"从边单据 SubBizType 值"不能为空');
          }
        }
      }
      return errors;
    }

    // ===== F1 — C3 配置弹窗（最简，4 行）=====
    function createScenarioConfigDialogC3() {
      const draft = state.scenarioDraft;
      if (!draft || draft.category !== 'gateway-recon-join') {
        return createAlertDialog('内部错误：state.scenarioDraft 缺失或类别不匹配');
      }
      const mode = draft.mode || 'create';
      const isReadonly = mode === 'view';
      // config 防御：若 draft.config 缺失则补默认
      if (!draft.config) draft.config = createDefaultScenarioConfig('gateway-recon-join');
      const config = draft.config;
      if (!Array.isArray(config.reconFields) || config.reconFields.length === 0) {
        config.reconFields = [{ seq: 1, gwField: '', bankField: '' }];
      }
      if (!config.assign) config.assign = { gwField: '', bankField: '' };
      // v2.1.5 N3：旧 v2.1.4 scenario 无 conditions 字段 → 默认空数组（不过滤）
      if (!Array.isArray(config.conditions)) {
        config.conditions = [];
      }

      const overlay = createOverlay();
      const dialog = document.createElement('div');
      dialog.className = 'modal-card scenario-config-card scenario-config-c3';

      dialog.innerHTML = `
        <div class="dialog-header">
          <div class="dialog-title">${escapeHtml(getCategoryDialogTitle(draft.category, mode))}</div>
          <button class="icon-close" type="button">×</button>
        </div>
        <div class="dialog-body scenario-config-body">
          <div class="scenario-config-row">
            <span class="scenario-config-label">场景名称</span>
            <input class="scenario-config-input" type="text" data-field="name" ${isReadonly ? 'disabled' : ''} value="${escapeHtml(draft.name || '')}" placeholder="非空 + 全局唯一">
          </div>
          <div class="scenario-config-row">
            <span class="scenario-config-label">优先级 <span class="scenario-config-tooltip" title="3 = 最高，0 = 最低">ⓘ</span></span>
            <input class="scenario-config-input scenario-config-input-narrow" type="number" min="0" max="3" data-field="priority" ${isReadonly ? 'disabled' : ''} value="${draft.priority ?? 0}">
          </div>
          <div class="scenario-config-row scenario-config-row-multi">
            <span class="scenario-config-label">条件 <span class="scenario-config-tooltip" title="同时满足全部条件才进入提取（AND）">ⓘ</span></span>
            <div class="scenario-config-multi-wrap">
              <div class="scenario-config-multi-rows" data-multi="c3-conditions"></div>
              ${isReadonly ? '' : '<button class="text-action small" type="button" data-action="add-c3-condition">+ 新增条件</button>'}
            </div>
          </div>
          <div class="scenario-config-row scenario-config-row-multi">
            <span class="scenario-config-label">对账字段</span>
            <div class="scenario-config-multi-wrap">
              <div class="scenario-config-multi-rows" data-multi="reconFields"></div>
              ${isReadonly ? '' : '<button class="text-action small" type="button" data-action="add-recon-field">+ 新增对账字段</button>'}
            </div>
          </div>
          <div class="scenario-config-row">
            <span class="scenario-config-label">对账成立后赋值</span>
            <div class="scenario-config-vs-row">
              <select class="scenario-config-input" data-field="assign-gw" ${isReadonly ? 'disabled' : ''}>
                <option value="">请选择网关账单字段</option>
                ${renderScenarioOptions(GATEWAY_RECON_FIELDS, config.assign.gwField)}
              </select>
              <span class="scenario-config-vs-arrow">赋值给</span>
              <select class="scenario-config-input" data-field="assign-bank" ${isReadonly ? 'disabled' : ''}>
                <option value="">请选择银行对账单字段</option>
                ${renderScenarioOptions(BANK_STATEMENT_FIELDS_FOR_C3, config.assign.bankField)}
              </select>
            </div>
          </div>
        </div>
        <div class="dialog-actions right">
          ${buildScenarioActionsHtml(mode)}
        </div>
      `;

      const reconRowsContainer = dialog.querySelector('[data-multi="reconFields"]');
      const c3CondContainer = dialog.querySelector('[data-multi="c3-conditions"]');

      // ===== v2.1.5 N3：「条件」栏渲染 + 数据流 =====
      // v2.1.5 fix1.1：用 scenario-config-c3-cond-row 专属 class（grid 布局列宽固定）
      //   - 不复用 .scenario-config-multi-row（避免影响 reconFields 行的 flex 布局）
      //   - 左二字段 select 固定 240px，超长字段名（如 GATEWAY_RECON_FIELDS 的 'Type(0:1对1...)'）
      //     由浏览器原生 ellipsis 截断；下拉打开时 option 完整可见
      function renderC3ConditionRow(cd, idx) {
        const fields = cd.side === '银行' ? BANK_STATEMENT_FIELDS_FOR_C3 : GATEWAY_RECON_FIELDS;
        const valueHidden = !opNeedsValue(cd.op);
        return `
          <div class="scenario-config-c3-cond-row" data-c3-cond-row="${idx}">
            <select class="scenario-config-input scenario-config-input-narrow" data-c3-cond-field="side" ${isReadonly ? 'disabled' : ''}>
              <option value="网关"${cd.side === '网关' ? ' selected' : ''}>网关</option>
              <option value="银行"${cd.side === '银行' ? ' selected' : ''}>银行</option>
            </select>
            <select class="scenario-config-input scenario-config-c3-cond-field" data-c3-cond-field="field" ${isReadonly ? 'disabled' : ''}>
              <option value="">请选择字段</option>
              ${renderScenarioOptions(fields, cd.field)}
            </select>
            <select class="scenario-config-input scenario-config-input-narrow" data-c3-cond-field="op" ${isReadonly ? 'disabled' : ''}>
              ${renderScenarioOptions(SCENARIO_CONDITION_OPS, cd.op || '等于')}
            </select>
            <input class="scenario-config-input" type="text" data-c3-cond-field="value" ${isReadonly ? 'disabled' : ''} value="${escapeHtml(cd.value || '')}" placeholder="值" ${valueHidden ? 'style="visibility:hidden"' : ''}>
            ${isReadonly ? '' : '<button class="icon-close-small" type="button" data-c3-cond-action="remove" title="删除">×</button>'}
          </div>
        `;
      }

      function renderC3Conditions() {
        if (!c3CondContainer) return;
        c3CondContainer.innerHTML = config.conditions.map((cd, idx) => renderC3ConditionRow(cd, idx)).join('');
      }
      renderC3Conditions();

      // 「条件」事件绑定（参考 C1 模式 — change / input / click 三层）
      // v2.1.5 fix1.1：closest selector 改为 .scenario-config-c3-cond-row（与 row 的专属 class 一致）
      c3CondContainer?.addEventListener('change', (event) => {
        if (isReadonly) return;
        const ctl = event.target.closest('[data-c3-cond-field]');
        if (!ctl) return;
        const row = ctl.closest('.scenario-config-c3-cond-row');
        const idx = Number(row?.dataset.c3CondRow);
        const f = ctl.dataset.c3CondField;
        if (!Number.isFinite(idx) || !config.conditions[idx]) return;
        config.conditions[idx][f] = ctl.value;
        // side 切换 → 重渲（重新拉字段下拉枚举）+ 清空 field（防御切换后旧字段名残留）
        if (f === 'side') {
          config.conditions[idx].field = '';
          renderC3Conditions();
        } else if (f === 'op') {
          // op 切换 → 重渲（隐藏/显示 value 输入框）
          renderC3Conditions();
        }
      });
      c3CondContainer?.addEventListener('input', (event) => {
        if (isReadonly) return;
        const input = event.target.closest('input[data-c3-cond-field="value"]');
        if (!input) return;
        const row = input.closest('.scenario-config-c3-cond-row');
        const idx = Number(row?.dataset.c3CondRow);
        if (Number.isFinite(idx) && config.conditions[idx]) {
          config.conditions[idx].value = input.value;
        }
      });
      c3CondContainer?.addEventListener('click', (event) => {
        if (isReadonly) return;
        const removeBtn = event.target.closest('button[data-c3-cond-action="remove"]');
        if (!removeBtn) return;
        const row = removeBtn.closest('.scenario-config-c3-cond-row');
        const idx = Number(row?.dataset.c3CondRow);
        if (Number.isFinite(idx)) {
          // v2.1.5 N3 柔性校验：可删完所有条件
          config.conditions.splice(idx, 1);
          renderC3Conditions();
        }
      });
      dialog.querySelector('[data-action="add-c3-condition"]')?.addEventListener('click', () => {
        if (isReadonly) return;
        config.conditions.push({ side: '网关', field: '', op: '等于', value: '' });
        renderC3Conditions();
      });

      function renderReconFields() {
        reconRowsContainer.innerHTML = config.reconFields.map((rf, idx) => `
          <div class="scenario-config-multi-row" data-row-index="${idx}">
            <span class="scenario-config-multi-seq">${idx + 1}</span>
            <select class="scenario-config-input" data-multi-field="gwField" ${isReadonly ? 'disabled' : ''}>
              <option value="">请选择网关账单字段</option>
              ${renderScenarioOptions(GATEWAY_RECON_FIELDS, rf.gwField)}
            </select>
            <span class="scenario-config-vs-arrow">vs</span>
            <select class="scenario-config-input" data-multi-field="bankField" ${isReadonly ? 'disabled' : ''}>
              <option value="">请选择银行对账单字段</option>
              ${renderScenarioOptions(BANK_STATEMENT_FIELDS_FOR_C3, rf.bankField)}
            </select>
            ${isReadonly || config.reconFields.length === 1 ? '' : '<button class="icon-close-small" type="button" data-multi-action="remove" title="删除">×</button>'}
          </div>
        `).join('');
      }
      renderReconFields();

      bindScenarioBasicFields(dialog, draft);

      // 行 4 赋值字段同步
      dialog.querySelector('select[data-field="assign-gw"]')?.addEventListener('change', (e) => {
        config.assign.gwField = e.target.value;
      });
      dialog.querySelector('select[data-field="assign-bank"]')?.addEventListener('change', (e) => {
        config.assign.bankField = e.target.value;
      });

      // 行 3 多行编辑（新增 / 删除 / 字段同步）
      reconRowsContainer.addEventListener('change', (event) => {
        const select = event.target.closest('select[data-multi-field]');
        if (!select) return;
        const row = select.closest('.scenario-config-multi-row');
        const idx = Number(row?.dataset.rowIndex);
        const f = select.dataset.multiField;
        if (Number.isFinite(idx) && config.reconFields[idx]) {
          config.reconFields[idx][f] = select.value;
        }
      });
      reconRowsContainer.addEventListener('click', (event) => {
        const btn = event.target.closest('button[data-multi-action="remove"]');
        if (!btn || isReadonly) return;
        const row = btn.closest('.scenario-config-multi-row');
        const idx = Number(row?.dataset.rowIndex);
        if (Number.isFinite(idx) && config.reconFields.length > 1) {
          config.reconFields.splice(idx, 1);
          // 重排 seq
          config.reconFields.forEach((r, i) => { r.seq = i + 1; });
          renderReconFields();
        }
      });
      const addBtn = dialog.querySelector('[data-action="add-recon-field"]');
      addBtn?.addEventListener('click', () => {
        if (isReadonly) return;
        config.reconFields.push({ seq: config.reconFields.length + 1, gwField: '', bankField: '' });
        renderReconFields();
      });

      // 关闭 / 取消 / 确认 / 返回
      function closeAndClearDraft() {
        clearScenarioDraft();
        openModal(reopenScenariosManager());
      }
      dialog.querySelector('.icon-close').addEventListener('click', closeAndClearDraft);
      dialog.querySelector('[data-action="cancel"]')?.addEventListener('click', closeAndClearDraft);
      dialog.querySelector('[data-action="back"]')?.addEventListener('click', closeAndClearDraft);
      dialog.querySelector('[data-action="confirm"]')?.addEventListener('click', () => {
        const errors = validateScenarioDraft(draft);
        if (errors.length > 0) {
          // 校验失败 → alert 关闭后回到当前配置弹窗（state.scenarioDraft 仍在，input 已保留）
          openModal(createAlertDialog(errors.map((e) => `• ${e}`).join('<br>'), {
            onConfirm: () => openScenarioConfigByCategory(draft.category)
          }));
          return;
        }
        openModal(createScenarioConfirmDetailDialog());
      });

      overlay.appendChild(dialog);
      return overlay;
    }

    // ===== F2 — C1 配置弹窗（5 行 + 行 4/5 互斥）=====
    function createScenarioConfigDialogC1() {
      const draft = state.scenarioDraft;
      if (!draft || draft.category !== 'extract-recon-id') {
        return createAlertDialog('内部错误：state.scenarioDraft 缺失或类别不匹配');
      }
      const mode = draft.mode || 'create';
      const isReadonly = mode === 'view';
      if (!draft.config) draft.config = createDefaultScenarioConfig('extract-recon-id');
      const config = draft.config;
      if (!Array.isArray(config.conditions) || config.conditions.length === 0) {
        config.conditions = [{ field: '', op: '等于', value: '' }];
      }
      // 互斥状态：行 4 vs 行 5 最多勾一个
      const featureChecked = !!(config.extractByFeature && config.extractByFeature.enabled);
      const otherChecked = !!(config.extractByOtherField);
      if (featureChecked && otherChecked) {
        // 修正：默认保留行 4
        config.extractByOtherField = null;
      }

      const overlay = createOverlay();
      const dialog = document.createElement('div');
      dialog.className = 'modal-card scenario-config-card scenario-config-c1';

      const featureCfg = config.extractByFeature || { enabled: false, searchFields: [], featureCode: '', digitCount: '', totalLength: '' };
      const otherCfg = config.extractByOtherField || { field: '' };

      dialog.innerHTML = `
        <div class="dialog-header">
          <div class="dialog-title">${escapeHtml(getCategoryDialogTitle(draft.category, mode))}</div>
          <button class="icon-close" type="button">×</button>
        </div>
        <div class="dialog-body scenario-config-body">
          <div class="scenario-config-row">
            <span class="scenario-config-label">场景名称</span>
            <input class="scenario-config-input" type="text" data-field="name" ${isReadonly ? 'disabled' : ''} value="${escapeHtml(draft.name || '')}" placeholder="非空 + 全局唯一">
          </div>
          <div class="scenario-config-row">
            <span class="scenario-config-label">优先级 <span class="scenario-config-tooltip" title="3 = 最高，0 = 最低">ⓘ</span></span>
            <input class="scenario-config-input scenario-config-input-narrow" type="number" min="0" max="3" data-field="priority" ${isReadonly ? 'disabled' : ''} value="${draft.priority ?? 0}">
          </div>
          <div class="scenario-config-row scenario-config-row-multi">
            <span class="scenario-config-label">条件 <span class="scenario-config-tooltip" title="按下方选择的逻辑聚合条件">ⓘ</span></span>
            <div class="scenario-config-multi-wrap">
              <div class="scenario-config-multi-rows" data-multi="conditions"></div>
              ${isReadonly ? '' : '<button class="text-action small" type="button" data-action="add-condition">+ 新增条件</button>'}
              <!-- v2.1.7 F1：条件聚合逻辑 radio（默认 OR；旧 scenario 无 logic 字段 → fallback OR 选中） -->
              <div class="scenario-config-logic-row">
                <span class="scenario-config-logic-label">条件聚合：</span>
                <label class="scenario-config-logic-option"><input type="radio" name="conditionsLogic" value="OR" ${config.conditionsLogic !== 'AND' ? 'checked' : ''} ${isReadonly ? 'disabled' : ''}> OR（满足任一）</label>
                <label class="scenario-config-logic-option"><input type="radio" name="conditionsLogic" value="AND" ${config.conditionsLogic === 'AND' ? 'checked' : ''} ${isReadonly ? 'disabled' : ''}> AND（同时满足）</label>
              </div>
            </div>
          </div>
          <div class="scenario-config-row scenario-config-row-mutex">
            <label class="scenario-config-mutex-label">
              <input type="checkbox" data-field="extract-feature-enabled" ${featureChecked ? 'checked' : ''} ${isReadonly ? 'disabled' : ''}>
              <span>根据特征提取 ReconId</span>
            </label>
            <div class="scenario-config-mutex-content" data-mutex="feature">
              <div class="scenario-config-feature-grid">
                <label>筛选字段：
                  <button class="new-account-input new-account-currency-dropdown-btn big-account-currency-dropdown-btn scenario-config-feature-search-btn"
                          type="button"
                          ${isReadonly || !featureChecked ? 'disabled' : ''}
                          data-field="feature-search-fields-btn"
                          aria-expanded="false"></button>
                </label>
                <label>英文特征：<input class="scenario-config-input scenario-config-input-narrow" type="text" data-field="feature-code" ${isReadonly || !featureChecked ? 'disabled' : ''} value="${escapeHtml(featureCfg.featureCode || '')}" placeholder="如 FT"></label>
                <label>数字位数：<input class="scenario-config-input scenario-config-input-narrow" type="number" min="1" data-field="feature-digit-count" ${isReadonly || !featureChecked ? 'disabled' : ''} value="${featureCfg.digitCount ?? ''}"></label>
                <label>总位数：<input class="scenario-config-input scenario-config-input-narrow" type="number" min="1" data-field="feature-total-length" ${isReadonly || !featureChecked ? 'disabled' : ''} value="${featureCfg.totalLength ?? ''}"></label>
              </div>
            </div>
          </div>
          <div class="scenario-config-row scenario-config-row-mutex">
            <label class="scenario-config-mutex-label">
              <input type="checkbox" data-field="extract-other-enabled" ${otherChecked ? 'checked' : ''} ${isReadonly ? 'disabled' : ''}>
              <span>根据其他字段提取 ReconId</span>
            </label>
            <div class="scenario-config-mutex-content" data-mutex="other">
              <label>字段：<select class="scenario-config-input" data-field="other-field" ${isReadonly || !otherChecked ? 'disabled' : ''}>
                <option value="">请选择字段</option>
                ${renderScenarioOptions(BANK_STATEMENT_FIELDS, otherCfg.field)}
              </select></label>
            </div>
          </div>
        </div>
        <div class="dialog-actions right">
          ${buildScenarioActionsHtml(mode)}
        </div>
      `;

      const condContainer = dialog.querySelector('[data-multi="conditions"]');

      function renderConditions() {
        condContainer.innerHTML = config.conditions.map((cd, idx) => {
          const valueHidden = !opNeedsValue(cd.op);
          return `
            <div class="scenario-config-multi-row" data-row-index="${idx}">
              <select class="scenario-config-input" data-multi-field="field" ${isReadonly ? 'disabled' : ''}>
                <option value="">请选择字段</option>
                ${renderScenarioOptions(BANK_STATEMENT_FIELDS, cd.field)}
              </select>
              <select class="scenario-config-input scenario-config-input-narrow" data-multi-field="op" ${isReadonly ? 'disabled' : ''}>
                ${renderScenarioOptions(SCENARIO_CONDITION_OPS, cd.op || '等于')}
              </select>
              <input class="scenario-config-input" type="text" data-multi-field="value" ${isReadonly ? 'disabled' : ''} value="${escapeHtml(cd.value || '')}" placeholder="值" ${valueHidden ? 'style="visibility:hidden"' : ''}>
              ${isReadonly || config.conditions.length === 1 ? '' : '<button class="icon-close-small" type="button" data-multi-action="remove" title="删除">×</button>'}
            </div>
          `;
        }).join('');
      }
      renderConditions();

      bindScenarioBasicFields(dialog, draft);

      // 行 3 多行编辑
      condContainer.addEventListener('change', (event) => {
        const ctl = event.target.closest('[data-multi-field]');
        if (!ctl) return;
        const row = ctl.closest('.scenario-config-multi-row');
        const idx = Number(row?.dataset.rowIndex);
        const f = ctl.dataset.multiField;
        if (Number.isFinite(idx) && config.conditions[idx]) {
          config.conditions[idx][f] = ctl.value;
          if (f === 'op') renderConditions();  // 切换"空值/非空值"时重渲（隐藏值输入）
        }
      });
      condContainer.addEventListener('input', (event) => {
        const input = event.target.closest('input[data-multi-field="value"]');
        if (!input) return;
        const row = input.closest('.scenario-config-multi-row');
        const idx = Number(row?.dataset.rowIndex);
        if (Number.isFinite(idx) && config.conditions[idx]) {
          config.conditions[idx].value = input.value;
        }
      });
      condContainer.addEventListener('click', (event) => {
        const btn = event.target.closest('button[data-multi-action="remove"]');
        if (!btn || isReadonly) return;
        const row = btn.closest('.scenario-config-multi-row');
        const idx = Number(row?.dataset.rowIndex);
        if (Number.isFinite(idx) && config.conditions.length > 1) {
          config.conditions.splice(idx, 1);
          renderConditions();
        }
      });
      dialog.querySelector('[data-action="add-condition"]')?.addEventListener('click', () => {
        if (isReadonly) return;
        config.conditions.push({ field: '', op: '等于', value: '' });
        renderConditions();
      });

      // v2.1.7 F1：AND/OR radio 切换 → 直接落 config.conditionsLogic
      //   只读模式 disabled 已在 innerHTML 渲染时设置；这里仍多一层 isReadonly 防御
      dialog.querySelectorAll('input[name="conditionsLogic"]').forEach((radio) => {
        radio.addEventListener('change', () => {
          if (isReadonly) return;
          if (radio.checked) {
            config.conditionsLogic = (radio.value === 'AND') ? 'AND' : 'OR';
          }
        });
      });

      // 行 4/5 互斥 + 启用切换
      const featureCheckbox = dialog.querySelector('input[data-field="extract-feature-enabled"]');
      const otherCheckbox = dialog.querySelector('input[data-field="extract-other-enabled"]');
      function setFeatureEnabled(enabled) {
        if (enabled) {
          if (!config.extractByFeature) config.extractByFeature = { enabled: true, searchFields: [], featureCode: '', digitCount: '', totalLength: '' };
          else config.extractByFeature.enabled = true;
          config.extractByOtherField = null;
        } else if (config.extractByFeature) {
          config.extractByFeature.enabled = false;
        }
        // 重绘整个 dialog 的"特征提取" + "其他字段" 区块（重设 disabled 状态）
        rerender();
      }
      function setOtherEnabled(enabled) {
        if (enabled) {
          config.extractByOtherField = config.extractByOtherField || { field: '' };
          if (config.extractByFeature) config.extractByFeature.enabled = false;
        } else {
          config.extractByOtherField = null;
        }
        rerender();
      }
      featureCheckbox?.addEventListener('change', () => setFeatureEnabled(featureCheckbox.checked));
      otherCheckbox?.addEventListener('change', () => setOtherEnabled(otherCheckbox.checked));

      function rerender() {
        // 简单做法：重新打开 dialog（draft 已经更新到 state）
        openModal(createScenarioConfigDialogC1());
      }

      // 行 4 筛选字段（与"维护大账号"页面币种多选下拉同款 floating panel）
      const searchBtn = dialog.querySelector('button[data-field="feature-search-fields-btn"]');
      const searchPanel = document.createElement('div');
      searchPanel.className = 'new-account-currency-dropdown-panel scenario-config-feature-search-panel';
      searchPanel.hidden = true;
      overlay.appendChild(searchPanel);
      let searchPanelOpen = false;

      function getSearchFieldsList() {
        const f = config.extractByFeature;
        return Array.isArray(f?.searchFields) ? f.searchFields.filter(Boolean) : [];
      }

      function updateSearchBtnLabel() {
        if (!searchBtn) return;
        const list = getSearchFieldsList();
        if (list.length === 0) {
          searchBtn.textContent = '请选择筛选字段';
        } else if (list.length === 1) {
          searchBtn.textContent = list[0];
        } else if (list.length <= 3) {
          searchBtn.textContent = list.join(', ');
        } else {
          searchBtn.textContent = `${list.length} 个字段已选`;
        }
        searchBtn.title = list.join(', ') || '请选择筛选字段';
      }

      function renderSearchPanelOptions() {
        searchPanel.replaceChildren();
        const selected = getSearchFieldsList();
        BANK_STATEMENT_FIELDS.forEach((field) => {
          const option = document.createElement('label');
          option.className = 'new-account-currency-option';
          const text = document.createElement('span');
          text.className = 'new-account-currency-option-text';
          text.textContent = field;
          const cb = document.createElement('input');
          cb.className = 'new-account-checkbox';
          cb.type = 'checkbox';
          cb.value = field;
          cb.checked = selected.includes(field);
          cb.addEventListener('change', () => {
            const all = Array.from(searchPanel.querySelectorAll('input[type="checkbox"]:checked')).map((b) => b.value);
            if (config.extractByFeature) config.extractByFeature.searchFields = all;
            updateSearchBtnLabel();
          });
          option.append(text, cb);
          searchPanel.appendChild(option);
        });
      }

      function positionSearchPanel() {
        if (!searchBtn) return;
        const rect = searchBtn.getBoundingClientRect();
        const margin = 12;
        searchPanel.style.position = 'fixed';
        searchPanel.style.minWidth = `${Math.max(rect.width, 220)}px`;
        searchPanel.style.maxHeight = '320px';
        searchPanel.style.overflowY = 'auto';
        searchPanel.style.visibility = 'hidden';
        searchPanel.hidden = false;
        const panelHeight = searchPanel.offsetHeight || 320;
        const panelWidth = searchPanel.offsetWidth || 220;
        const left = Math.max(margin, Math.min(rect.left, window.innerWidth - panelWidth - margin));
        const top = (rect.bottom + 6 + panelHeight > window.innerHeight - margin)
          ? Math.max(margin, rect.top - panelHeight - 6)
          : rect.bottom + 6;
        searchPanel.style.left = `${left}px`;
        searchPanel.style.top = `${top}px`;
        searchPanel.style.visibility = 'visible';
      }

      function closeSearchPanel() {
        searchPanel.hidden = true;
        searchPanelOpen = false;
        searchBtn?.setAttribute('aria-expanded', 'false');
      }

      searchBtn?.addEventListener('click', (event) => {
        event.stopPropagation();
        if (searchBtn.disabled) return;
        if (searchPanelOpen) {
          closeSearchPanel();
          return;
        }
        renderSearchPanelOptions();
        positionSearchPanel();
        searchPanelOpen = true;
        searchBtn.setAttribute('aria-expanded', 'true');
      });

      // panel 外点击 → 关闭；dialog 关闭后自动 self-detach
      document.addEventListener('click', function searchPanelOutsideClick(event) {
        if (!searchPanel.isConnected) {
          document.removeEventListener('click', searchPanelOutsideClick);
          return;
        }
        if (!searchPanelOpen) return;
        if (!searchPanel.contains(event.target) && event.target !== searchBtn) {
          closeSearchPanel();
        }
      });

      updateSearchBtnLabel();
      dialog.querySelector('input[data-field="feature-code"]')?.addEventListener('input', (e) => {
        if (config.extractByFeature) config.extractByFeature.featureCode = String(e.target.value || '').toUpperCase();
        // 不立即 rerender 避免输入光标跳；用户失焦时如果是非法值会在校验阶段提示
      });
      dialog.querySelector('input[data-field="feature-digit-count"]')?.addEventListener('input', (e) => {
        if (config.extractByFeature) {
          const v = Number(e.target.value);
          config.extractByFeature.digitCount = Number.isFinite(v) ? v : '';
        }
      });
      dialog.querySelector('input[data-field="feature-total-length"]')?.addEventListener('input', (e) => {
        if (config.extractByFeature) {
          const v = Number(e.target.value);
          config.extractByFeature.totalLength = Number.isFinite(v) ? v : '';
        }
      });
      // 行 5
      dialog.querySelector('select[data-field="other-field"]')?.addEventListener('change', (e) => {
        if (config.extractByOtherField) config.extractByOtherField.field = e.target.value;
      });

      // 关闭 / 取消 / 确认 / 返回
      function closeAndClearDraft() {
        clearScenarioDraft();
        openModal(reopenScenariosManager());
      }
      dialog.querySelector('.icon-close').addEventListener('click', closeAndClearDraft);
      dialog.querySelector('[data-action="cancel"]')?.addEventListener('click', closeAndClearDraft);
      dialog.querySelector('[data-action="back"]')?.addEventListener('click', closeAndClearDraft);
      dialog.querySelector('[data-action="confirm"]')?.addEventListener('click', () => {
        const errors = validateScenarioDraft(draft);
        if (errors.length > 0) {
          // 校验失败 → alert 关闭后回到当前配置弹窗（state.scenarioDraft 仍在，input 已保留）
          openModal(createAlertDialog(errors.map((e) => `• ${e}`).join('<br>'), {
            onConfirm: () => openScenarioConfigByCategory(draft.category)
          }));
          return;
        }
        openModal(createScenarioConfirmDetailDialog());
      });

      overlay.appendChild(dialog);
      return overlay;
    }

    // ===== F3 — C2 配置弹窗（5 行 + 序号自动 + 联动）=====
    function createScenarioConfigDialogC2() {
      const draft = state.scenarioDraft;
      if (!draft || draft.category !== 'offset-bill-mark') {
        return createAlertDialog('内部错误：state.scenarioDraft 缺失或类别不匹配');
      }
      const mode = draft.mode || 'create';
      const isReadonly = mode === 'view';
      if (!draft.config) draft.config = createDefaultScenarioConfig('offset-bill-mark');
      const config = draft.config;
      if (!Array.isArray(config.billTypes) || config.billTypes.length < 2) {
        config.billTypes = [
          { seq: 1, field: '', op: '等于', value: '' },
          { seq: 2, field: '', op: '等于', value: '' }
        ];
      }
      if (!Array.isArray(config.reconFields) || config.reconFields.length === 0) {
        config.reconFields = [{ seq: 1, leftType: 1, leftField: '', rightType: 2, rightField: '' }];
      }
      if (!config.markValue) config.markValue = { type: 2, field: '', value: '' };

      const overlay = createOverlay();
      const dialog = document.createElement('div');
      dialog.className = 'modal-card scenario-config-card scenario-config-c2';

      dialog.innerHTML = `
        <div class="dialog-header">
          <div class="dialog-title">${escapeHtml(getCategoryDialogTitle(draft.category, mode))}</div>
          <button class="icon-close" type="button">×</button>
        </div>
        <div class="dialog-body scenario-config-body">
          <div class="scenario-config-row">
            <span class="scenario-config-label">场景名称</span>
            <input class="scenario-config-input" type="text" data-field="name" ${isReadonly ? 'disabled' : ''} value="${escapeHtml(draft.name || '')}" placeholder="非空 + 全局唯一">
          </div>
          <div class="scenario-config-row">
            <span class="scenario-config-label">优先级 <span class="scenario-config-tooltip" title="3 = 最高，0 = 最低">ⓘ</span></span>
            <input class="scenario-config-input scenario-config-input-narrow" type="number" min="0" max="3" data-field="priority" ${isReadonly ? 'disabled' : ''} value="${draft.priority ?? 0}">
          </div>
          <div class="scenario-config-row scenario-config-row-multi">
            <span class="scenario-config-label">账单类型 <span class="scenario-config-tooltip" title="每行 = 一种独立账单类型">ⓘ</span></span>
            <div class="scenario-config-multi-wrap">
              <div class="scenario-config-multi-rows" data-multi="billTypes"></div>
              ${isReadonly ? '' : '<button class="text-action small" type="button" data-action="add-bill-type">+ 新增账单类型</button>'}
            </div>
          </div>
          <div class="scenario-config-row scenario-config-row-multi">
            <span class="scenario-config-label">对账字段</span>
            <div class="scenario-config-multi-wrap">
              <div class="scenario-config-multi-rows" data-multi="reconFields"></div>
              ${isReadonly ? '' : '<button class="text-action small" type="button" data-action="add-recon-field">+ 新增对账字段</button>'}
            </div>
          </div>
          <div class="scenario-config-row">
            <span class="scenario-config-label">打标值</span>
            <div class="scenario-config-vs-row" data-mark-value-row></div>
          </div>
        </div>
        <div class="dialog-actions right">
          ${buildScenarioActionsHtml(mode)}
        </div>
      `;

      const billTypeContainer = dialog.querySelector('[data-multi="billTypes"]');
      const reconContainer = dialog.querySelector('[data-multi="reconFields"]');
      const markRow = dialog.querySelector('[data-mark-value-row]');

      function renderBillTypes() {
        billTypeContainer.innerHTML = config.billTypes.map((bt, idx) => `
          <div class="scenario-config-multi-row" data-row-index="${idx}">
            <span class="scenario-config-multi-seq">#${bt.seq}</span>
            <select class="scenario-config-input" data-multi-field="field" ${isReadonly ? 'disabled' : ''}>
              <option value="">请选择字段</option>
              ${renderScenarioOptions(BANK_STATEMENT_FIELDS, bt.field)}
            </select>
            <select class="scenario-config-input scenario-config-input-narrow" data-multi-field="op" ${isReadonly ? 'disabled' : ''}>
              ${renderScenarioOptions(SCENARIO_CONDITION_OPS, bt.op || '等于')}
            </select>
            <input class="scenario-config-input" type="text" data-multi-field="value" ${isReadonly ? 'disabled' : ''} value="${escapeHtml(bt.value || '')}" placeholder="值" ${!opNeedsValue(bt.op) ? 'style="visibility:hidden"' : ''}>
            ${isReadonly || config.billTypes.length <= 2 ? '' : '<button class="icon-close-small" type="button" data-multi-action="remove" title="删除">×</button>'}
          </div>
        `).join('');
      }
      function renderReconFields() {
        const billTypeSeqs = config.billTypes.map((b) => b.seq);
        reconContainer.innerHTML = config.reconFields.map((rf, idx) => `
          <div class="scenario-config-multi-row" data-row-index="${idx}">
            <span class="scenario-config-multi-seq">#${idx + 1}</span>
            <select class="scenario-config-input scenario-config-input-narrow" data-multi-field="leftType" ${isReadonly ? 'disabled' : ''}>
              ${renderScenarioOptions(billTypeSeqs.map(String), String(rf.leftType))}
            </select>
            <select class="scenario-config-input" data-multi-field="leftField" ${isReadonly ? 'disabled' : ''}>
              <option value="">请选择字段</option>
              ${renderScenarioOptions(BANK_STATEMENT_FIELDS, rf.leftField)}
            </select>
            <span class="scenario-config-vs-arrow">vs</span>
            <select class="scenario-config-input scenario-config-input-narrow" data-multi-field="rightType" ${isReadonly ? 'disabled' : ''}>
              ${renderScenarioOptions(billTypeSeqs.map(String), String(rf.rightType))}
            </select>
            <select class="scenario-config-input" data-multi-field="rightField" ${isReadonly ? 'disabled' : ''}>
              <option value="">请选择字段</option>
              ${renderScenarioOptions(BANK_STATEMENT_FIELDS, rf.rightField)}
            </select>
            ${isReadonly || config.reconFields.length === 1 ? '' : '<button class="icon-close-small" type="button" data-multi-action="remove" title="删除">×</button>'}
          </div>
        `).join('');
      }
      function renderMarkValue() {
        const billTypeSeqs = config.billTypes.map((b) => b.seq);
        markRow.innerHTML = `
          <select class="scenario-config-input scenario-config-input-narrow" data-mark-field="type" ${isReadonly ? 'disabled' : ''}>
            ${renderScenarioOptions(billTypeSeqs.map(String), String(config.markValue.type))}
          </select>
          <span class="scenario-config-vs-arrow">的</span>
          <select class="scenario-config-input" data-mark-field="field" ${isReadonly ? 'disabled' : ''}>
            <option value="">请选择字段</option>
            ${renderScenarioOptions(BANK_STATEMENT_FIELDS, config.markValue.field)}
          </select>
          <span class="scenario-config-vs-arrow">写入值</span>
          <input class="scenario-config-input" type="text" data-mark-field="value" ${isReadonly ? 'disabled' : ''} value="${escapeHtml(config.markValue.value || '')}" placeholder="值">
        `;
      }
      function rerender() {
        renderBillTypes();
        renderReconFields();
        renderMarkValue();
      }
      rerender();

      bindScenarioBasicFields(dialog, draft);

      // 行 3 账单类型多行编辑
      billTypeContainer.addEventListener('change', (event) => {
        const ctl = event.target.closest('[data-multi-field]');
        if (!ctl) return;
        const row = ctl.closest('.scenario-config-multi-row');
        const idx = Number(row?.dataset.rowIndex);
        const f = ctl.dataset.multiField;
        if (Number.isFinite(idx) && config.billTypes[idx]) {
          config.billTypes[idx][f] = ctl.value;
          if (f === 'op') renderBillTypes();
        }
      });
      billTypeContainer.addEventListener('input', (event) => {
        const input = event.target.closest('input[data-multi-field="value"]');
        if (!input) return;
        const row = input.closest('.scenario-config-multi-row');
        const idx = Number(row?.dataset.rowIndex);
        if (Number.isFinite(idx) && config.billTypes[idx]) {
          config.billTypes[idx].value = input.value;
        }
      });
      billTypeContainer.addEventListener('click', (event) => {
        const btn = event.target.closest('button[data-multi-action="remove"]');
        if (!btn || isReadonly) return;
        const row = btn.closest('.scenario-config-multi-row');
        const idx = Number(row?.dataset.rowIndex);
        if (Number.isFinite(idx) && config.billTypes.length > 2) {
          config.billTypes.splice(idx, 1);
          // 重排 seq（关键：行 4/5 引用要更新）
          config.billTypes.forEach((b, i) => { b.seq = i + 1; });
          // 校正行 4 / 行 5 引用，超出范围的回退到 1
          const validSeqs = config.billTypes.map((b) => b.seq);
          config.reconFields.forEach((r) => {
            if (!validSeqs.includes(Number(r.leftType))) r.leftType = validSeqs[0] || 1;
            if (!validSeqs.includes(Number(r.rightType))) r.rightType = validSeqs[1] || validSeqs[0] || 1;
          });
          if (!validSeqs.includes(Number(config.markValue.type))) config.markValue.type = validSeqs[validSeqs.length - 1] || 1;
          rerender();
        }
      });
      dialog.querySelector('[data-action="add-bill-type"]')?.addEventListener('click', () => {
        if (isReadonly) return;
        config.billTypes.push({ seq: config.billTypes.length + 1, field: '', op: '等于', value: '' });
        rerender();
      });

      // 行 4 对账字段多行编辑
      reconContainer.addEventListener('change', (event) => {
        const ctl = event.target.closest('[data-multi-field]');
        if (!ctl) return;
        const row = ctl.closest('.scenario-config-multi-row');
        const idx = Number(row?.dataset.rowIndex);
        const f = ctl.dataset.multiField;
        if (Number.isFinite(idx) && config.reconFields[idx]) {
          if (f === 'leftType' || f === 'rightType') config.reconFields[idx][f] = Number(ctl.value);
          else config.reconFields[idx][f] = ctl.value;
        }
      });
      reconContainer.addEventListener('click', (event) => {
        const btn = event.target.closest('button[data-multi-action="remove"]');
        if (!btn || isReadonly) return;
        const row = btn.closest('.scenario-config-multi-row');
        const idx = Number(row?.dataset.rowIndex);
        if (Number.isFinite(idx) && config.reconFields.length > 1) {
          config.reconFields.splice(idx, 1);
          renderReconFields();
        }
      });
      dialog.querySelector('[data-action="add-recon-field"]')?.addEventListener('click', () => {
        if (isReadonly) return;
        const seqs = config.billTypes.map((b) => b.seq);
        config.reconFields.push({ seq: config.reconFields.length + 1, leftType: seqs[0] || 1, leftField: '', rightType: seqs[1] || seqs[0] || 1, rightField: '' });
        renderReconFields();
      });

      // 行 5 打标值
      markRow.addEventListener('change', (event) => {
        const ctl = event.target.closest('[data-mark-field]');
        if (!ctl) return;
        const f = ctl.dataset.markField;
        if (f === 'type') config.markValue.type = Number(ctl.value);
        else config.markValue[f] = ctl.value;
      });
      markRow.addEventListener('input', (event) => {
        const input = event.target.closest('input[data-mark-field="value"]');
        if (!input) return;
        config.markValue.value = input.value;
      });

      // 关闭 / 取消 / 确认 / 返回
      function closeAndClearDraft() {
        clearScenarioDraft();
        openModal(reopenScenariosManager());
      }
      dialog.querySelector('.icon-close').addEventListener('click', closeAndClearDraft);
      dialog.querySelector('[data-action="cancel"]')?.addEventListener('click', closeAndClearDraft);
      dialog.querySelector('[data-action="back"]')?.addEventListener('click', closeAndClearDraft);
      dialog.querySelector('[data-action="confirm"]')?.addEventListener('click', () => {
        const errors = validateScenarioDraft(draft);
        if (errors.length > 0) {
          // 校验失败 → alert 关闭后回到当前配置弹窗（state.scenarioDraft 仍在，input 已保留）
          openModal(createAlertDialog(errors.map((e) => `• ${e}`).join('<br>'), {
            onConfirm: () => openScenarioConfigByCategory(draft.category)
          }));
          return;
        }
        openModal(createScenarioConfirmDetailDialog());
      });

      overlay.appendChild(dialog);
      return overlay;
    }

    // ===== v2.1.0-beta.1 PR-A — F5 C4 配置弹窗（5 行 + 识读按钮 disabled 占位）=====
    // 主从双下拉枚举：BUSINESS_BILL_FIELDS（主边）/ OPPONENT_BILL_FIELDS（从边）
    // 行结构详见 spec §八.1；互斥逻辑详见 PRD §三 D2 / D5
    // v2.1.0-beta.3 T7：按 subMode 切换枚举源
    //   business → BUSINESS_BILL_FIELDS / OPPONENT_BILL_FIELDS（单据对账，业务/对手部门账单）
    //   gateway  → GATEWAY_BILL_FIELDS  / CHANNEL_BILL_FIELDS（网关对账，网关/渠道账单）
    function getReconIdFixFieldsForSide(side, subMode) {
      if (subMode === 'gateway') {
        return side === 'opp' ? CHANNEL_BILL_FIELDS : GATEWAY_BILL_FIELDS;
      }
      return side === 'opp' ? OPPONENT_BILL_FIELDS : BUSINESS_BILL_FIELDS;
    }

    function createScenarioConfigDialogC4() {
      const draft = state.scenarioDraft;
      // v2.1.0-beta.3 T7：扩 category 校验到两个 ReconID 子模式
      if (!draft || !isReconIdFixCategory(draft.category)) {
        return createAlertDialog('内部错误：state.scenarioDraft 缺失或类别不匹配');
      }
      const mode = draft.mode || 'create';
      const isReadonly = mode === 'view';
      // v2.1.0-beta.3 T7：从 draft.category 推导账单类别子模式（business / gateway）
      //   注意：与上一行的 mode（create/edit/view）正交，subMode 仅影响文案/枚举/SubBizType 显隐/输出列
      const subMode = reconIdFixModeFromCategory(draft.category);
      const isGatewayMode = subMode === 'gateway';
      if (!draft.config) draft.config = createDefaultScenarioConfig(draft.category);
      const config = draft.config;
      // 防御：每行字段补默认
      if (!config.matchRules) config.matchRules = { oneToOne: true, oneToMany: false, manyToOne: false };
      // v2.1.1 T2-2：BillDate ±N 默认初始化（不勾选 → 引擎走 ±1day 缺省，零回归）
      if (!config.billDateRange) config.billDateRange = { enabled: false, days: 3 };
      if (!Array.isArray(config.billTypes) || config.billTypes.length === 0) {
        config.billTypes = [{ seq: 1, side: 'main', conditions: [{ field: '', op: '等于', value: '' }] }];
      }
      // 兼容修正：保证 conditions 字段存在
      config.billTypes.forEach((bt, idx) => {
        if (!bt.seq) bt.seq = idx + 1;
        if (!bt.side) bt.side = 'main';
        if (!Array.isArray(bt.conditions) || bt.conditions.length === 0) {
          bt.conditions = [{ field: '', op: '等于', value: '' }];
        }
      });
      // v2.1.0-beta.1 PR-B（Q1=B 决策，2026-04-30）：reconGroups[] 取代 reconFields[]
      // v2.1.0-beta.1 PR-B Round 3（Decision 4，2026-05-09）：每个 group 强制带 Amount 锁定 fieldPair
      // 兼容老 draft（用户在迁移前保存的草稿） — in-memory 转换
      if (!Array.isArray(config.reconGroups) || config.reconGroups.length === 0) {
        if (Array.isArray(config.reconFields) && config.reconFields.length > 0) {
          // 一次性把老 reconFields[] 按 seq 聚合到 reconGroups[]，并删除 reconFields
          const grouped = new Map();
          for (const rf of config.reconFields) {
            if (!rf || typeof rf !== 'object') continue;
            const seq = rf.seq;
            if (!grouped.has(seq)) {
              grouped.set(seq, {
                leftTypeSeq: rf.leftTypeSeq,
                rightTypeSeq: rf.rightTypeSeq,
                fieldPairs: []
              });
            }
            grouped.get(seq).fieldPairs.push({
              leftField: rf.leftField,
              rightField: rf.rightField,
              // Round 3：恰好 Amount/Amount 的老 fieldPair 自动补 locked
              locked: rf.leftField === 'Amount' && rf.rightField === 'Amount'
            });
          }
          config.reconGroups = Array.from(grouped.values());
          delete config.reconFields;
        } else {
          // v2.1.0-beta.3 T11：gateway 子模式默认 amount-locked 是 Amount/receiveAmount（网关账单 vs 渠道账单字段名）
          const defaultRight = isGatewayMode ? 'receiveAmount' : 'Amount';
          config.reconGroups = [{
            leftTypeSeq: 1,
            rightTypeSeq: 1,
            fieldPairs: [{ leftField: 'Amount', rightField: defaultRight, locked: true }]
          }];
        }
      } else if (Object.prototype.hasOwnProperty.call(config, 'reconFields')) {
        // 用户已是新结构，仅清理残留
        delete config.reconFields;
      }
      // 保证每个 group 自身结构完整 + Round 3：强制带一条 Amount 锁定行
      // v2.1.0-beta.3 T11：gateway 子模式 amount-locked 是 Amount/receiveAmount（渠道账单字段名）
      // v2.1.0-beta.3 PR #39 review-round-2 Finding 1（P1）：归一化必须主动修正 locked 行的 rightField，
      //   防止"老 draft Amount/Amount + locked=true 进 gateway dialog 后引擎匹配不到渠道"
      const lockedRightField = isGatewayMode ? 'receiveAmount' : 'Amount';
      config.reconGroups.forEach((grp) => {
        if (!Array.isArray(grp.fieldPairs) || grp.fieldPairs.length === 0) {
          grp.fieldPairs = [{ leftField: 'Amount', rightField: lockedRightField, locked: true }];
          return;
        }
        // 检查是否已有 amount-locked fieldPair（按 subMode 决定 rightField 名）
        let hasAmountLocked = false;
        grp.fieldPairs.forEach((fp) => {
          if (!fp) return;
          // 已有 locked 行：强制修正 leftField/rightField 为当前 subMode 正确字段（修复跨子模式残留）
          if (fp.locked === true) {
            if (fp.leftField !== 'Amount') fp.leftField = 'Amount';
            if (fp.rightField !== lockedRightField) fp.rightField = lockedRightField;
            hasAmountLocked = true;
            return;
          }
          // 老 draft 未标 locked 但字段对匹配 → 自动补 locked
          if (fp.leftField === 'Amount' && fp.rightField === lockedRightField) {
            fp.locked = true;
            hasAmountLocked = true;
          }
        });
        if (!hasAmountLocked) {
          // 头部插入锁定 Amount/<rightField> 行
          grp.fieldPairs.unshift({ leftField: 'Amount', rightField: lockedRightField, locked: true });
        }
      });
      if (!config.output) {
        config.output = {
          mode: 'main',
          commonId: { source: 'main', suffix: '' },
          subBizType: { mode: 'auto', mainValue: '', oppValue: '' }
        };
      }
      if (!config.output.commonId) config.output.commonId = { source: 'main', suffix: '' };
      if (!config.output.subBizType) config.output.subBizType = { mode: 'auto', mainValue: '', oppValue: '' };

      const overlay = createOverlay();
      const dialog = document.createElement('div');
      dialog.className = 'modal-card scenario-config-card scenario-config-c4';

      dialog.innerHTML = `
        <div class="dialog-header">
          <div class="dialog-title">${escapeHtml(getCategoryDialogTitle(draft.category, mode))}</div>
          <button class="icon-close" type="button">×</button>
        </div>
        <div class="dialog-body scenario-config-body">
          <div class="scenario-config-row">
            <span class="scenario-config-label">场景名称</span>
            <input class="scenario-config-input" type="text" data-field="name" ${isReadonly ? 'disabled' : ''} value="${escapeHtml(draft.name || '')}" placeholder="非空 + 全局唯一">
          </div>
          <div class="scenario-config-row scenario-config-row-mutex">
            <span class="scenario-config-label">匹配模式</span>
            <div class="scenario-config-c4-checkboxes">
              <label class="scenario-config-c4-checkbox-item">
                <input type="checkbox" data-c4-match="oneToOne" ${config.matchRules.oneToOne ? 'checked' : ''} ${isReadonly ? 'disabled' : ''}>
                <span>${isGatewayMode ? '网关 1 v 1 渠道' : '主边 1 v 1 从边'}</span>
              </label>
              <label class="scenario-config-c4-checkbox-item">
                <input type="checkbox" data-c4-match="oneToMany" ${config.matchRules.oneToMany ? 'checked' : ''} ${isReadonly ? 'disabled' : ''}>
                <span>${isGatewayMode ? '网关 1 v 多 渠道' : '主边 1 v 多 从边'}</span>
              </label>
              <label class="scenario-config-c4-checkbox-item">
                <input type="checkbox" data-c4-match="manyToOne" ${config.matchRules.manyToOne ? 'checked' : ''} ${isReadonly ? 'disabled' : ''}>
                <span>${isGatewayMode ? '网关 多 v 1 渠道' : '主边 多 v 1 从边'}</span>
              </label>
            </div>
          </div>
          <div class="scenario-config-row scenario-config-row-mutex">
            <span class="scenario-config-label" style="white-space:nowrap;">
              BillDate 日期范围
              <span class="scenario-config-tooltip" title="默认 BillDate 容错范围 ±1 天（先严格匹配，再 ±1 天容错）。勾选后可调整容错窗口为 ±N 天（N=1-999），用于跨日扎单场景。严格匹配阶段不受影响。">ⓘ</span>
            </span>
            <div class="scenario-config-c4-checkboxes">
              <label class="scenario-config-c4-checkbox-item" style="white-space:nowrap;">
                <input type="checkbox" data-c4-bill-date-range-enabled ${config.billDateRange.enabled ? 'checked' : ''} ${isReadonly ? 'disabled' : ''}>
                <span>BillDate ±</span>
                <input type="number" data-c4-bill-date-range-days min="1" max="999" value="${Number(config.billDateRange.days) > 0 ? Number(config.billDateRange.days) : 3}" ${(!config.billDateRange.enabled || isReadonly) ? 'disabled' : ''} style="width: 3em; margin: 0 4px;">
                <span>Days</span>
              </label>
            </div>
          </div>
          <div class="scenario-config-row scenario-config-row-multi">
            <span class="scenario-config-label">对账字段</span>
            <div class="scenario-config-multi-wrap">
              <div class="scenario-config-multi-rows" data-c4-bill-types></div>
              ${isReadonly ? '' : '<button class="text-action small" type="button" data-c4-action="add-bill-type">+ 新增对账字段</button>'}
            </div>
          </div>
          <div class="scenario-config-row scenario-config-row-multi">
            <span class="scenario-config-label">对账内容</span>
            <div class="scenario-config-multi-wrap">
              <div class="scenario-config-multi-rows" data-c4-recon-groups></div>
              ${isReadonly ? '' : '<button class="text-action small" type="button" data-c4-action="add-recon-group">+ 新增对账内容分组</button>'}
            </div>
          </div>
          <div class="scenario-config-row scenario-config-row-mutex">
            <span class="scenario-config-label" style="width:auto; white-space:nowrap;">${isGatewayMode ? '订单修复ID取值' : '修复结果输出'} <span class="scenario-config-tooltip" title="${isGatewayMode ? '指定订单修复 ID 取值：取自网关 ReconID / 取自渠道 ReconID / 自取值（自定义来源 + 拼接&quot;加上&quot;输入框文本）。' : '指定修复结果写到哪一侧：主边修复 / 从边修复 / 主从都修复。选&quot;主从都修复&quot;会展开取值来源选项，决定共同 ReconID 从哪一侧取。'}">ⓘ</span></span>
            <div class="scenario-config-c4-output" data-c4-output></div>
          </div>
        </div>
        <div class="dialog-actions">
          ${buildScenarioActionsHtml(mode)}
        </div>
      `;

      const billTypesEl = dialog.querySelector('[data-c4-bill-types]');
      const reconGroupsEl = dialog.querySelector('[data-c4-recon-groups]');
      const outputEl = dialog.querySelector('[data-c4-output]');

      function renderBillTypes() {
        billTypesEl.innerHTML = config.billTypes.map((bt, idx) => {
          const fields = getReconIdFixFieldsForSide(bt.side, subMode);
          const conditionsHtml = (bt.conditions || []).map((cd, cIdx) => `
            <div class="scenario-config-c4-condition-row" data-c4-cond-row="${cIdx}">
              <select class="scenario-config-input" data-c4-cond-field="field" ${isReadonly ? 'disabled' : ''}>
                <option value="">请选择字段</option>
                ${renderScenarioOptions(fields, cd.field)}
              </select>
              <select class="scenario-config-input scenario-config-input-narrow" data-c4-cond-field="op" ${isReadonly ? 'disabled' : ''}>
                ${renderScenarioOptions(SCENARIO_CONDITION_OPS, cd.op || '等于')}
              </select>
              <input class="scenario-config-input" type="text" data-c4-cond-field="value" ${isReadonly ? 'disabled' : ''} value="${escapeHtml(cd.value || '')}" placeholder="值" ${!opNeedsValue(cd.op) ? 'style="visibility:hidden"' : ''}>
              ${isReadonly || (bt.conditions || []).length <= 1 ? '' : '<button class="icon-close-small" type="button" data-c4-cond-action="remove" title="删除">×</button>'}
              ${isReadonly || cIdx !== 0 ? '' : `<button class="text-action small" type="button" data-c4-cond-action="add-cond" title="同序号 AND">新增</button>`}
            </div>
          `).join('');
          return `
            <div class="scenario-config-c4-bill-type" data-c4-bt-row="${idx}">
              <div class="scenario-config-c4-bt-header">
                <span class="scenario-config-multi-seq">#${bt.seq}</span>
                <select class="scenario-config-input scenario-config-input-narrow" data-c4-bt-field="side" ${isReadonly ? 'disabled' : ''}>
                  <option value="main"${bt.side === 'main' ? ' selected' : ''}>主边</option>
                  <option value="opp"${bt.side === 'opp' ? ' selected' : ''}>从边</option>
                </select>
                ${isReadonly || config.billTypes.length <= 1 ? '' : '<button class="icon-close-small" type="button" data-c4-bt-action="remove" title="删除该序号">×</button>'}
              </div>
              <div class="scenario-config-c4-conditions">
                ${conditionsHtml}
              </div>
            </div>
          `;
        }).join('');
      }

      // v2.1.0-beta.1 PR-B（Q1=B 决策，2026-04-30）：行 4 渲染 reconGroups[]
      //   每个 group 一个 block：[左类型↓ vs 右类型↓] 头 + 多行字段对（同 group 内 AND）+ "+ 新增字段对" + "❌ 删除分组"
      //   多个 group 之间显示 "OR" 分隔（提示用户：不同 group 之间是 OR）
      //   行底"+ 新增 OR 分组"按钮（在 dialog HTML 直接渲染，事件下方绑定）
      function renderReconGroups() {
        const seqs = config.billTypes.map((b) => b.seq);
        const sideBySeq = new Map(config.billTypes.map((b) => [b.seq, b.side]));
        reconGroupsEl.innerHTML = config.reconGroups.map((grp, gIdx) => {
          const leftSide = sideBySeq.get(Number(grp.leftTypeSeq)) || 'main';
          const rightSide = sideBySeq.get(Number(grp.rightTypeSeq)) || 'opp';
          const leftFields = getReconIdFixFieldsForSide(leftSide, subMode);
          const rightFields = getReconIdFixFieldsForSide(rightSide, subMode);
          // v2.1.0-beta.2 PR-A Round 2（task R2-12）：fieldpair 加 col 1 spacer，让 [leftField][=][rightField] 与
          // group-header 的 [leftTypeSeq][vs右：][rightTypeSeq] 在 grid 上下对齐
          const fieldPairsHtml = (grp.fieldPairs || []).map((fp, fpIdx) => {
            // Round 3（Decision 4）：locked fieldPair 不可改 / 不可删
            const locked = fp && fp.locked === true;
            const fpDisabled = isReadonly || locked;
            // 锁定行：select 显示实际字段名（business 默认 Amount/Amount，gateway 默认 Amount/receiveAmount）
            // v2.1.0-beta.3 T11：按 subMode 取 locked 行的实际字段名（fp.leftField/rightField 由前面 ensure 逻辑写好）
            const lockedLeftLabel = fp && fp.leftField ? fp.leftField : 'Amount';
            const lockedRightLabel = fp && fp.rightField ? fp.rightField : 'Amount';
            const renderLeftSelect = locked
              ? `<select class="scenario-config-input" data-c4-rg-fp-field="leftField" disabled title="Amount 字段对锁定（用于池子 1v多 / 多v1 算法）">
                   <option value="${escapeHtml(lockedLeftLabel)}" selected>${escapeHtml(lockedLeftLabel)}</option>
                 </select>`
              : `<select class="scenario-config-input" data-c4-rg-fp-field="leftField" ${fpDisabled ? 'disabled' : ''}>
                   <option value="">请选择左字段</option>
                   ${renderScenarioOptions(leftFields, fp.leftField)}
                 </select>`;
            const renderRightSelect = locked
              ? `<select class="scenario-config-input" data-c4-rg-fp-field="rightField" disabled title="Amount 字段对锁定（用于池子 1v多 / 多v1 算法）">
                   <option value="${escapeHtml(lockedRightLabel)}" selected>${escapeHtml(lockedRightLabel)}</option>
                 </select>`
              : `<select class="scenario-config-input" data-c4-rg-fp-field="rightField" ${fpDisabled ? 'disabled' : ''}>
                   <option value="">请选择右字段</option>
                   ${renderScenarioOptions(rightFields, fp.rightField)}
                 </select>`;
            // 删除按钮：locked 行永不显示
            const removeBtnHtml = (isReadonly || locked || (grp.fieldPairs || []).length <= 1)
              ? ''
              : '<button class="icon-close-small" type="button" data-c4-rg-fp-action="remove" title="删除字段对">×</button>';
            // v2.1.0-beta.2 PR-A Round 2（task R2-11）："新增"按钮仅每个分组的第一行（fpIdx === 0）保留，其余隐藏
            // 锁定的 Amount 行通常 fpIdx === 0，仍保留"新增"入口；若用户调整顺序使 Amount 不在首位也按 fpIdx === 0 控制
            const addBtnHtml = isReadonly || fpIdx !== 0
              ? ''
              : '<button class="text-action small" type="button" data-c4-rg-fp-action="add" title="同分组内 AND">新增</button>';
            return `
              <div class="scenario-config-c4-recon-fieldpair${locked ? ' scenario-config-c4-recon-fieldpair-locked' : ''}" data-c4-rg-fp-row="${fpIdx}">
                <span class="scenario-config-c4-recon-fieldpair-spacer" aria-hidden="true"></span>
                ${renderLeftSelect}
                <span class="scenario-config-vs-arrow">=</span>
                ${renderRightSelect}
                ${removeBtnHtml}
                ${addBtnHtml}
              </div>
            `;
          }).join('');
          // v2.1.0-beta.2 PR-B（task B4）：分组之间不渲染 "OR" 文字，仅保留 8px 视觉间距（CSS height:8px）
          const orSeparatorHtml = gIdx > 0 ? '<div class="scenario-config-c4-recon-or-sep" aria-hidden="true"></div>' : '';
          return `
            ${orSeparatorHtml}
            <div class="scenario-config-c4-recon-group" data-c4-rg-row="${gIdx}">
              <div class="scenario-config-c4-recon-group-header">
                <!-- v2.1.0-beta.2 PR-A Round 2（task R2-12）：合并"分组 N"+"左："为单 span 占 col 1，让 [leftTypeSeq] 与下方 [leftField] 在 grid col 2 上下对齐 -->
                <span class="scenario-config-multi-seq">分组 ${gIdx + 1} 左：</span>
                <select class="scenario-config-input scenario-config-input-narrow" data-c4-rg-field="leftTypeSeq" ${isReadonly ? 'disabled' : ''}>
                  ${renderScenarioOptions(seqs.map(String), String(grp.leftTypeSeq))}
                </select>
                <span>vs 右：</span>
                <select class="scenario-config-input scenario-config-input-narrow" data-c4-rg-field="rightTypeSeq" ${isReadonly ? 'disabled' : ''}>
                  ${renderScenarioOptions(seqs.map(String), String(grp.rightTypeSeq))}
                </select>
                ${isReadonly || config.reconGroups.length === 1 ? '' : '<button class="icon-close-small" type="button" data-c4-rg-action="remove" title="删除分组">×</button>'}
              </div>
              <div class="scenario-config-c4-recon-fieldpairs">
                ${fieldPairsHtml}
              </div>
            </div>
          `;
        }).join('');
      }

      function renderOutput() {
        const out = config.output;
        const sub = out.subBizType;
        const isBoth = out.mode === 'both';
        // v2.1.0-beta.3 T7：gateway 子模式文案映射
        //   主边单据 → 网关账单 / 从边单据 → 渠道账单 / 主从边都修复 → 自取值
        //   "主边单据 reconId" → "网关账单ReconID" / "从边单据 reconId" → "渠道账单ReconID"
        //   去掉"主从边共同的"字样；SubBizType 取值栏整段不渲染
        const labelMain = isGatewayMode ? '网关账单' : '主边单据';
        const labelOpp = isGatewayMode ? '渠道账单' : '从边单据';
        const labelBoth = isGatewayMode ? '自取值' : '主从边都修复';
        const labelCommonIdMain = isGatewayMode ? '网关账单ReconID' : '主边单据 reconId';
        const labelCommonIdOpp = isGatewayMode ? '渠道账单ReconID' : '从边单据 reconId';
        const labelCommonIdSuffix = isGatewayMode ? '作为修复 ID' : '作为主从边共同的修复 ID';
        // gateway：勾选 1v多 或 多v1 时"网关账单"radio 禁用（参考 PRD §3.4 / spec §2.4.2）
        const lockMainOption = isGatewayMode && (config.matchRules.oneToMany || config.matchRules.manyToOne);
        const mainDisabled = isReadonly || lockMainOption;
        outputEl.innerHTML = `
          <div class="scenario-config-c4-output-modes">
            <label class="scenario-config-c4-checkbox-item${lockMainOption ? ' is-disabled' : ''}">
              <input type="radio" name="c4-output-mode" value="main" ${out.mode === 'main' ? 'checked' : ''} ${mainDisabled ? 'disabled' : ''}>
              <span>${labelMain}</span>
            </label>
            <label class="scenario-config-c4-checkbox-item">
              <input type="radio" name="c4-output-mode" value="opp" ${out.mode === 'opp' ? 'checked' : ''} ${isReadonly ? 'disabled' : ''}>
              <span>${labelOpp}</span>
            </label>
            <label class="scenario-config-c4-checkbox-item">
              <input type="radio" name="c4-output-mode" value="both" ${out.mode === 'both' ? 'checked' : ''} ${isReadonly ? 'disabled' : ''}>
              <span>${labelBoth}</span>
            </label>
          </div>
          ${isBoth ? `
            <div class="scenario-config-c4-common-id">
              <span>取</span>
              <select class="scenario-config-input" data-c4-common-id="source" ${isReadonly ? 'disabled' : ''}>
                <!-- v2.1.0-beta.3 修订（用户反馈）：新增空值 option（人眼看为空白行），选取后右侧"加上"输入框必须有值（校验时强制） -->
                <option value=""${(!out.commonId.source) ? ' selected' : ''}></option>
                <option value="main"${out.commonId.source === 'main' ? ' selected' : ''}>${labelCommonIdMain}</option>
                <option value="opp"${out.commonId.source === 'opp' ? ' selected' : ''}>${labelCommonIdOpp}</option>
              </select>
              <!-- v2.1.0-beta.3 修订（用户反馈）：gateway 模式也加 suffix 输入框（功能同 business 的"加上"输入框） -->
              <span>加上</span>
              <input class="scenario-config-input scenario-config-input-narrow" type="text" data-c4-common-id="suffix" ${isReadonly ? 'disabled' : ''} value="${escapeHtml(out.commonId.suffix || '')}" placeholder="后缀">
              <span>${labelCommonIdSuffix}</span>
            </div>
          ` : ''}
          ${isGatewayMode ? '' : `
          <div class="scenario-config-c4-sub-biz">
            <div class="scenario-config-c4-sub-biz-title">SubBizType 取值</div>
            <label class="scenario-config-c4-checkbox-item">
              <input type="radio" name="c4-sub-mode" value="auto" ${sub.mode === 'auto' ? 'checked' : ''} ${isReadonly ? 'disabled' : ''}>
              <span>订单修复表的 SubBizType 值取对应单据在对账结果表里单据子类型</span>
            </label>
            <label class="scenario-config-c4-checkbox-item">
              <input type="radio" name="c4-sub-mode" value="manualMain" ${sub.mode === 'manualMain' ? 'checked' : ''} ${isReadonly ? 'disabled' : ''}>
              <span>主边单据 SubBizType 值</span>
              <input class="scenario-config-input scenario-config-input-narrow" type="text" data-c4-sub-field="mainValue" ${isReadonly || (sub.mode !== 'manualMain' && sub.mode !== 'manualBoth') ? 'disabled' : ''} value="${escapeHtml(sub.mainValue || '')}" placeholder="主边手填值">
            </label>
            <label class="scenario-config-c4-checkbox-item">
              <input type="radio" name="c4-sub-mode" value="manualOpp" ${sub.mode === 'manualOpp' ? 'checked' : ''} ${isReadonly ? 'disabled' : ''}>
              <span>从边单据 SubBizType 值</span>
              <input class="scenario-config-input scenario-config-input-narrow" type="text" data-c4-sub-field="oppValue" ${isReadonly || (sub.mode !== 'manualOpp' && sub.mode !== 'manualBoth') ? 'disabled' : ''} value="${escapeHtml(sub.oppValue || '')}" placeholder="从边手填值">
            </label>
            <label class="scenario-config-c4-checkbox-item">
              <input type="radio" name="c4-sub-mode" value="manualBoth" ${sub.mode === 'manualBoth' ? 'checked' : ''} ${isReadonly ? 'disabled' : ''}>
              <span>主从边各自手填</span>
            </label>
          </div>
          `}
        `;
      }

      function rerenderAll() {
        renderBillTypes();
        renderReconGroups();
        renderOutput();
      }
      rerenderAll();

      bindScenarioBasicFields(dialog, draft);

      // 行 2：单据匹配规则 — 1v多 / 多v1 互斥；1v1 自由
      // v2.1.0-beta.3 T7：gateway 子模式下勾选 1v多/多v1 时"网关账单"选项被禁用 →
      //   若当前 output.mode === 'main' 自动 fallback 到 'opp'（避免"勾着的禁用项"UX 灾难）+ 重渲染 output
      dialog.querySelectorAll('input[data-c4-match]').forEach((cb) => {
        cb.addEventListener('change', () => {
          if (isReadonly) return;
          const key = cb.dataset.c4Match;
          config.matchRules[key] = cb.checked;
          // 互斥：1v多 与 多v1 不能同时
          if (key === 'oneToMany' && cb.checked) {
            config.matchRules.manyToOne = false;
          } else if (key === 'manyToOne' && cb.checked) {
            config.matchRules.oneToMany = false;
          }
          dialog.querySelectorAll('input[data-c4-match]').forEach((other) => {
            other.checked = !!config.matchRules[other.dataset.c4Match];
          });
          // gateway 子模式：勾选 1v多/多v1 锁定"网关账单"选项；若当前选中是 main 自动切到 'opp'
          if (isGatewayMode && (config.matchRules.oneToMany || config.matchRules.manyToOne)
              && config.output.mode === 'main') {
            config.output.mode = 'opp';
          }
          // 重渲染 output（更新 lockMainOption 视觉态 + radio 选中态）
          renderOutput();
        });
      });

      // v2.1.1 T2-2：BillDate ±N 区事件 — 勾选框控制启用 + 输入框联动
      const billDateEnabledEl = dialog.querySelector('input[data-c4-bill-date-range-enabled]');
      const billDateDaysEl = dialog.querySelector('input[data-c4-bill-date-range-days]');
      if (billDateEnabledEl && billDateDaysEl) {
        billDateEnabledEl.addEventListener('change', () => {
          if (isReadonly) return;
          config.billDateRange.enabled = billDateEnabledEl.checked;
          billDateDaysEl.disabled = !billDateEnabledEl.checked;
        });
        billDateDaysEl.addEventListener('input', () => {
          if (isReadonly) return;
          const v = Number(billDateDaysEl.value);
          // 仅记入 config（校验留给保存时 validateScenarioDraft；range 是 1-999 正整数）
          config.billDateRange.days = Number.isFinite(v) ? v : config.billDateRange.days;
        });
      }

      // 行 3：对账字段动态行（内部变量名 billTypes 保留）
      billTypesEl.addEventListener('change', (event) => {
        if (isReadonly) return;
        const sideSel = event.target.closest('select[data-c4-bt-field="side"]');
        if (sideSel) {
          const row = sideSel.closest('[data-c4-bt-row]');
          const idx = Number(row.dataset.c4BtRow);
          if (Number.isFinite(idx) && config.billTypes[idx]) {
            config.billTypes[idx].side = sideSel.value === 'opp' ? 'opp' : 'main';
            // 切 side → 字段下拉枚举改变 → 清空 conditions[].field
            (config.billTypes[idx].conditions || []).forEach((cd) => { cd.field = ''; });
            renderBillTypes();
            renderReconGroups(); // 联动行 4 字段下拉
          }
          return;
        }
        const condCtl = event.target.closest('[data-c4-cond-field]');
        if (condCtl) {
          const btRow = condCtl.closest('[data-c4-bt-row]');
          const condRow = condCtl.closest('[data-c4-cond-row]');
          if (!btRow || !condRow) return;
          const btIdx = Number(btRow.dataset.c4BtRow);
          const condIdx = Number(condRow.dataset.c4CondRow);
          const f = condCtl.dataset.c4CondField;
          if (Number.isFinite(btIdx) && config.billTypes[btIdx]
              && Number.isFinite(condIdx) && config.billTypes[btIdx].conditions[condIdx]) {
            config.billTypes[btIdx].conditions[condIdx][f] = condCtl.value;
            if (f === 'op') renderBillTypes();
          }
        }
      });
      billTypesEl.addEventListener('input', (event) => {
        if (isReadonly) return;
        const input = event.target.closest('input[data-c4-cond-field="value"]');
        if (!input) return;
        const btRow = input.closest('[data-c4-bt-row]');
        const condRow = input.closest('[data-c4-cond-row]');
        if (!btRow || !condRow) return;
        const btIdx = Number(btRow.dataset.c4BtRow);
        const condIdx = Number(condRow.dataset.c4CondRow);
        if (Number.isFinite(btIdx) && config.billTypes[btIdx]
            && Number.isFinite(condIdx) && config.billTypes[btIdx].conditions[condIdx]) {
          config.billTypes[btIdx].conditions[condIdx].value = input.value;
        }
      });
      billTypesEl.addEventListener('click', (event) => {
        if (isReadonly) return;
        const removeBtBtn = event.target.closest('button[data-c4-bt-action="remove"]');
        if (removeBtBtn) {
          const row = removeBtBtn.closest('[data-c4-bt-row]');
          const idx = Number(row.dataset.c4BtRow);
          if (Number.isFinite(idx) && config.billTypes.length > 1) {
            config.billTypes.splice(idx, 1);
            // 重排 seq + 校正行 4 引用（reconGroups 每组的 leftTypeSeq/rightTypeSeq）
            config.billTypes.forEach((b, i) => { b.seq = i + 1; });
            const validSeqs = config.billTypes.map((b) => b.seq);
            (config.reconGroups || []).forEach((grp) => {
              if (!validSeqs.includes(Number(grp.leftTypeSeq))) grp.leftTypeSeq = validSeqs[0] || 1;
              if (!validSeqs.includes(Number(grp.rightTypeSeq))) grp.rightTypeSeq = validSeqs[0] || 1;
            });
            rerenderAll();
          }
          return;
        }
        const removeCondBtn = event.target.closest('button[data-c4-cond-action="remove"]');
        if (removeCondBtn) {
          const btRow = removeCondBtn.closest('[data-c4-bt-row]');
          const condRow = removeCondBtn.closest('[data-c4-cond-row]');
          if (!btRow || !condRow) return;
          const btIdx = Number(btRow.dataset.c4BtRow);
          const condIdx = Number(condRow.dataset.c4CondRow);
          if (Number.isFinite(btIdx) && config.billTypes[btIdx]
              && Number.isFinite(condIdx) && config.billTypes[btIdx].conditions.length > 1) {
            config.billTypes[btIdx].conditions.splice(condIdx, 1);
            renderBillTypes();
          }
          return;
        }
        const addCondBtn = event.target.closest('button[data-c4-cond-action="add-cond"]');
        if (addCondBtn) {
          const btRow = addCondBtn.closest('[data-c4-bt-row]');
          if (!btRow) return;
          const btIdx = Number(btRow.dataset.c4BtRow);
          if (Number.isFinite(btIdx) && config.billTypes[btIdx]) {
            config.billTypes[btIdx].conditions.push({ field: '', op: '等于', value: '' });
            renderBillTypes();
          }
        }
      });
      dialog.querySelector('[data-c4-action="add-bill-type"]')?.addEventListener('click', () => {
        if (isReadonly) return;
        const nextSeq = config.billTypes.length + 1;
        // 默认新加的下一组从边
        const newSide = config.billTypes.length === 0 ? 'main' : (config.billTypes.length === 1 ? 'opp' : 'main');
        config.billTypes.push({ seq: nextSeq, side: newSide, conditions: [{ field: '', op: '等于', value: '' }] });
        renderBillTypes();
        renderReconGroups();
      });

      // 行 4：对账内容（reconGroups[] — 每个 group 内 AND；多个 group OR；内部变量名 reconGroups 保留）
      // change 事件：处理"分组头的 leftTypeSeq/rightTypeSeq"和"字段对的 leftField/rightField"
      reconGroupsEl.addEventListener('change', (event) => {
        if (isReadonly) return;
        // 分组头的左/右类型下拉
        const headerCtl = event.target.closest('[data-c4-rg-field]');
        if (headerCtl) {
          const grpRow = headerCtl.closest('[data-c4-rg-row]');
          const gIdx = Number(grpRow?.dataset.c4RgRow);
          const f = headerCtl.dataset.c4RgField;
          if (Number.isFinite(gIdx) && config.reconGroups[gIdx]) {
            config.reconGroups[gIdx][f] = Number(headerCtl.value);
            // 切类型 → 字段下拉枚举改变 → 该分组内所有字段对的对应 left/rightField 清空
            // Round 3：locked Amount 行不清空（保持 'Amount' 不变）
            const sideKey = f === 'leftTypeSeq' ? 'leftField' : 'rightField';
            (config.reconGroups[gIdx].fieldPairs || []).forEach((fp) => {
              if (fp && fp.locked === true) return;
              fp[sideKey] = '';
            });
            renderReconGroups();
          }
          return;
        }
        // 字段对的 leftField / rightField 下拉（Round 3：locked 行拒绝改）
        const fpCtl = event.target.closest('[data-c4-rg-fp-field]');
        if (fpCtl) {
          const grpRow = fpCtl.closest('[data-c4-rg-row]');
          const fpRow = fpCtl.closest('[data-c4-rg-fp-row]');
          if (!grpRow || !fpRow) return;
          const gIdx = Number(grpRow.dataset.c4RgRow);
          const fpIdx = Number(fpRow.dataset.c4RgFpRow);
          const f = fpCtl.dataset.c4RgFpField;
          if (Number.isFinite(gIdx) && config.reconGroups[gIdx]
              && Number.isFinite(fpIdx) && config.reconGroups[gIdx].fieldPairs[fpIdx]) {
            const fp = config.reconGroups[gIdx].fieldPairs[fpIdx];
            if (fp && fp.locked === true) return;     // 锁定行不允许改
            fp[f] = fpCtl.value;
          }
        }
      });
      // click 事件：分组级 ❌（删除整个 group）/ 字段对级 ❌（删除单条 fieldPair）/ "+ 新增字段对"按钮
      reconGroupsEl.addEventListener('click', (event) => {
        if (isReadonly) return;
        // 删除整个分组
        const removeGrpBtn = event.target.closest('button[data-c4-rg-action="remove"]');
        if (removeGrpBtn) {
          const grpRow = removeGrpBtn.closest('[data-c4-rg-row]');
          const gIdx = Number(grpRow?.dataset.c4RgRow);
          if (Number.isFinite(gIdx) && config.reconGroups.length > 1) {
            config.reconGroups.splice(gIdx, 1);
            renderReconGroups();
          }
          return;
        }
        // 删除某个字段对（Round 3：locked fieldPair 不可删，防御兜底）
        const removeFpBtn = event.target.closest('button[data-c4-rg-fp-action="remove"]');
        if (removeFpBtn) {
          const grpRow = removeFpBtn.closest('[data-c4-rg-row]');
          const fpRow = removeFpBtn.closest('[data-c4-rg-fp-row]');
          if (!grpRow || !fpRow) return;
          const gIdx = Number(grpRow.dataset.c4RgRow);
          const fpIdx = Number(fpRow.dataset.c4RgFpRow);
          if (Number.isFinite(gIdx) && config.reconGroups[gIdx]
              && Number.isFinite(fpIdx) && config.reconGroups[gIdx].fieldPairs[fpIdx]) {
            const fp = config.reconGroups[gIdx].fieldPairs[fpIdx];
            if (fp && fp.locked === true) return;     // 锁定行拒绝删除
            if (config.reconGroups[gIdx].fieldPairs.length > 1) {
              config.reconGroups[gIdx].fieldPairs.splice(fpIdx, 1);
              renderReconGroups();
            }
          }
          return;
        }
        // 同分组内 "+ 新增字段对"（AND）
        const addFpBtn = event.target.closest('button[data-c4-rg-fp-action="add"]');
        if (addFpBtn) {
          const grpRow = addFpBtn.closest('[data-c4-rg-row]');
          const gIdx = Number(grpRow?.dataset.c4RgRow);
          if (Number.isFinite(gIdx) && config.reconGroups[gIdx]) {
            config.reconGroups[gIdx].fieldPairs.push({ leftField: '', rightField: '' });
            renderReconGroups();
          }
        }
      });
      // "+ 新增 OR 分组"（Round 3：新分组默认带 Amount 锁定 fieldPair）
      // v2.1.0-beta.3 PR #39 review-round-2 Finding 1（P1）：gateway 子模式 rightField 必须为 'receiveAmount'
      dialog.querySelector('[data-c4-action="add-recon-group"]')?.addEventListener('click', () => {
        if (isReadonly) return;
        const seqs = config.billTypes.map((b) => b.seq);
        const newGroupLockedRight = isGatewayMode ? 'receiveAmount' : 'Amount';
        config.reconGroups.push({
          leftTypeSeq: seqs[0] || 1,
          rightTypeSeq: seqs[1] || seqs[0] || 1,
          fieldPairs: [{ leftField: 'Amount', rightField: newGroupLockedRight, locked: true }]
        });
        renderReconGroups();
      });

      // 行 5：修复结果输出
      outputEl.addEventListener('change', (event) => {
        if (isReadonly) return;
        // mode 切换
        const modeRadio = event.target.closest('input[name="c4-output-mode"]');
        if (modeRadio && modeRadio.checked) {
          config.output.mode = modeRadio.value;
          renderOutput();
          return;
        }
        // sub mode 切换
        const subRadio = event.target.closest('input[name="c4-sub-mode"]');
        if (subRadio && subRadio.checked) {
          config.output.subBizType.mode = subRadio.value;
          renderOutput();
          return;
        }
        // commonId.source
        // v2.1.0-beta.3 修订（用户反馈）：支持空值 ''（用户主动选"空白行"），school 输入框校验在 validateScenarioDraft 内
        const ciSource = event.target.closest('[data-c4-common-id="source"]');
        if (ciSource) {
          const v = ciSource.value;
          config.output.commonId.source = (v === 'main' || v === 'opp' || v === '') ? v : 'main';
        }
      });
      outputEl.addEventListener('input', (event) => {
        if (isReadonly) return;
        const ciSuffix = event.target.closest('input[data-c4-common-id="suffix"]');
        if (ciSuffix) {
          config.output.commonId.suffix = ciSuffix.value;
          return;
        }
        const subInput = event.target.closest('input[data-c4-sub-field]');
        if (subInput) {
          const f = subInput.dataset.c4SubField;
          config.output.subBizType[f] = subInput.value;
        }
      });

      // 识读规律按钮（PR-A 占位 disabled，PR-C 实装）
      dialog.querySelector('[data-c4-action="infer-rules"]')?.addEventListener('click', () => {
        // PR-A 仅占位提示
        openModal(createAlertDialog('"识读场景规律"功能将在 PR-C 落地。'));
      });

      // 关闭 / 取消 / 确认 / 返回
      function closeAndClearDraft() {
        clearScenarioDraft();
        openModal(reopenScenariosManager());
      }
      dialog.querySelector('.icon-close').addEventListener('click', closeAndClearDraft);
      dialog.querySelector('[data-action="cancel"]')?.addEventListener('click', closeAndClearDraft);
      dialog.querySelector('[data-action="back"]')?.addEventListener('click', closeAndClearDraft);
      dialog.querySelector('[data-action="confirm"]')?.addEventListener('click', () => {
        const errors = validateScenarioDraft(draft);
        if (errors.length > 0) {
          // v2.1.0-beta.3 修订（用户反馈）：错误文本去掉 "• " 前缀
          openModal(createAlertDialog(errors.join('<br>'), {
            onConfirm: () => openScenarioConfigByCategory(draft.category)
          }));
          return;
        }
        openModal(createScenarioConfirmDetailDialog());
      });

      overlay.appendChild(dialog);
      return overlay;
    }

    // ===== F4 — 确认场景详情弹窗（共用，文本预览 + 完成/返回）=====
    function buildScenarioConfirmDetailHtml(draft) {
      const c = draft.config || {};
      let html = `<div class="scenario-confirm-detail-section"><span class="scenario-confirm-detail-label">类别：</span>${escapeHtml(getCategoryLabel(draft.category))}</div>`;
      html += `<div class="scenario-confirm-detail-section"><span class="scenario-confirm-detail-label">名称：</span>${escapeHtml(draft.name)}</div>`;
      html += `<div class="scenario-confirm-detail-section"><span class="scenario-confirm-detail-label">优先级：</span>${draft.priority}</div>`;
      if (draft.category === 'extract-recon-id') {
        // v2.1.7 F1：条件聚合 label 按 conditionsLogic 切换；旧 scenario 无字段 → OR
        const c1LogicLabel = (c.conditionsLogic === 'AND') ? 'AND' : 'OR';
        html += `<div class="scenario-confirm-detail-section"><span class="scenario-confirm-detail-label">条件（${c1LogicLabel}）：</span><ul>${(c.conditions || []).map((cd) => `<li>${escapeHtml(cd.field)} ${escapeHtml(cd.op)}${opNeedsValue(cd.op) ? ' ' + escapeHtml(String(cd.value || '')) : ''}</li>`).join('')}</ul></div>`;
        if (c.extractByFeature && c.extractByFeature.enabled) {
          const f = c.extractByFeature;
          html += `<div class="scenario-confirm-detail-section"><span class="scenario-confirm-detail-label">根据特征提取：</span>筛选字段 [${(f.searchFields || []).map(escapeHtml).join(', ')}]，特征 ${escapeHtml(f.featureCode)}，数字位 ${f.digitCount}，总位 ${f.totalLength}</div>`;
        }
        if (c.extractByOtherField) {
          html += `<div class="scenario-confirm-detail-section"><span class="scenario-confirm-detail-label">根据其他字段提取：</span>${escapeHtml(c.extractByOtherField.field)}</div>`;
        }
      } else if (draft.category === 'offset-bill-mark') {
        html += `<div class="scenario-confirm-detail-section"><span class="scenario-confirm-detail-label">账单类型：</span><ul>${(c.billTypes || []).map((bt) => `<li>#${bt.seq}：${escapeHtml(bt.field)} ${escapeHtml(bt.op)}${opNeedsValue(bt.op) ? ' ' + escapeHtml(String(bt.value || '')) : ''}</li>`).join('')}</ul></div>`;
        html += `<div class="scenario-confirm-detail-section"><span class="scenario-confirm-detail-label">对账字段：</span><ul>${(c.reconFields || []).map((r) => `<li>类型#${r.leftType} ${escapeHtml(r.leftField)} = 类型#${r.rightType} ${escapeHtml(r.rightField)}</li>`).join('')}</ul></div>`;
        const mv = c.markValue || {};
        html += `<div class="scenario-confirm-detail-section"><span class="scenario-confirm-detail-label">打标：</span>类型#${mv.type} 的 ${escapeHtml(mv.field || '')} 写入 "${escapeHtml(String(mv.value || ''))}"</div>`;
      } else if (draft.category === 'gateway-recon-join') {
        // v2.1.5 N3：conditions 段（仅当 ≥ 1 行时渲染）
        const conds = Array.isArray(c.conditions) ? c.conditions : [];
        if (conds.length > 0) {
          html += `<div class="scenario-confirm-detail-section"><span class="scenario-confirm-detail-label">条件（AND）：</span><ul>${conds.map((cd) => `<li>${escapeHtml(cd.side)} ${escapeHtml(cd.field)} ${escapeHtml(cd.op)}${opNeedsValue(cd.op) ? ' ' + escapeHtml(String(cd.value || '')) : ''}</li>`).join('')}</ul></div>`;
        }
        html += `<div class="scenario-confirm-detail-section"><span class="scenario-confirm-detail-label">对账字段（AND）：</span><ul>${(c.reconFields || []).map((r) => `<li>网关 ${escapeHtml(r.gwField)} = 银行 ${escapeHtml(r.bankField)}</li>`).join('')}</ul></div>`;
        const a = c.assign || {};
        html += `<div class="scenario-confirm-detail-section"><span class="scenario-confirm-detail-label">赋值：</span>网关 ${escapeHtml(a.gwField || '')} → 银行 ${escapeHtml(a.bankField || '')}</div>`;
      } else if (isReconIdFixCategory(draft.category)) {
        // v2.1.0-beta.1 PR-A（task A8）：C4 文本预览（PRD §七.2 模板）
        // v2.1.0-beta.3 T6：两个 ReconID 子模式共用预览模板（文案差异由 T7 按 mode 处理）
        const mr = c.matchRules || {};
        const mrParts = [];
        if (mr.oneToOne) mrParts.push('1 v 1');
        if (mr.oneToMany) mrParts.push('1 v 多');
        if (mr.manyToOne) mrParts.push('多 v 1');
        html += `<div class="scenario-confirm-detail-section"><span class="scenario-confirm-detail-label">匹配规则：</span>${escapeHtml(mrParts.join(' / ') || '（未选）')}</div>`;
        // v2.1.0-beta.3 T7：预览文案按 subMode 切换（主边/从边 ↔ 网关/渠道；SubBizType 在 gateway 模式不预览）
        const previewSubMode = reconIdFixModeFromCategory(draft.category);
        const isGwSubMode = previewSubMode === 'gateway';
        const sideLabel = (s) => isGwSubMode
          ? (s === 'opp' ? '渠道' : '网关')
          : (s === 'opp' ? '从边' : '主边');
        html += `<div class="scenario-confirm-detail-section"><span class="scenario-confirm-detail-label">对账字段：</span><ul>${(c.billTypes || []).map((bt) => {
          const condsHtml = (bt.conditions || []).map((cd) => `${escapeHtml(cd.field)} ${escapeHtml(cd.op)}${opNeedsValue(cd.op) ? ' ' + escapeHtml(String(cd.value || '')) : ''}`).join(' AND ');
          return `<li>类型#${bt.seq} (${sideLabel(bt.side)})：${condsHtml}</li>`;
        }).join('')}</ul></div>`;
        // v2.1.0-beta.1 PR-B（Q1=B 决策，2026-04-30）：reconGroups[] 渲染
        //   每个 group 一个 li，组内字段对 AND 用"&"分隔；多个 group 用"OR"分隔
        const reconGroupsForPreview = Array.isArray(c.reconGroups)
          ? c.reconGroups
          : (Array.isArray(c.reconFields) // 兼容老 draft（理论上 in-memory 已转，仍保留兜底）
              ? Array.from(c.reconFields.reduce((m, rf) => {
                  if (!m.has(rf.seq)) m.set(rf.seq, { leftTypeSeq: rf.leftTypeSeq, rightTypeSeq: rf.rightTypeSeq, fieldPairs: [] });
                  m.get(rf.seq).fieldPairs.push({ leftField: rf.leftField, rightField: rf.rightField });
                  return m;
                }, new Map()).values())
              : []);
        html += `<div class="scenario-confirm-detail-section"><span class="scenario-confirm-detail-label">对账内容：</span><ul>${reconGroupsForPreview.map((grp, gIdx) => {
          const fpStr = (grp.fieldPairs || []).map((fp) => `${escapeHtml(fp.leftField || '')}=${escapeHtml(fp.rightField || '')}`).join(' AND ');
          const orPrefix = gIdx > 0 ? '<span class="scenario-confirm-detail-or">OR</span> ' : '';
          return `<li>${orPrefix}类型#${grp.leftTypeSeq} vs 类型#${grp.rightTypeSeq}：${fpStr}</li>`;
        }).join('')}</ul></div>`;
        const out = c.output || {};
        // v2.1.0-beta.3 T7：修复方向预览文案按 subMode 切换
        const modeLabel = isGwSubMode
          ? (out.mode === 'main' ? '网关账单' : (out.mode === 'opp' ? '渠道账单' : '自取值'))
          : (out.mode === 'main' ? '主边' : (out.mode === 'opp' ? '从边' : '主从都修复'));
        const labelTitle = isGwSubMode ? '订单修复ID取值' : '修复方向';
        html += `<div class="scenario-confirm-detail-section"><span class="scenario-confirm-detail-label">${labelTitle}：</span>${escapeHtml(modeLabel)}</div>`;
        if (out.mode === 'both') {
          // v2.1.0-beta.1 PR-B（Q2=a 决策，2026-04-30）：commonId 取 reconId 不是 OrderId
          // v2.1.0-beta.3 T7：gateway 子模式预览不带 suffix（dialog 中已隐藏）
          const ci = out.commonId || {};
          if (isGwSubMode) {
            const reconIdLabel = ci.source === 'opp' ? '渠道账单ReconID' : '网关账单ReconID';
            html += `<div class="scenario-confirm-detail-section"><span class="scenario-confirm-detail-label">自取值：</span>${escapeHtml(reconIdLabel)}</div>`;
          } else {
            html += `<div class="scenario-confirm-detail-section"><span class="scenario-confirm-detail-label">共同 ID：</span>取${escapeHtml(sideLabel(ci.source))}reconId + "${escapeHtml(ci.suffix || '')}"</div>`;
          }
        }
        // SubBizType 仅 business 子模式预览
        if (!isGwSubMode) {
          const sub = out.subBizType || {};
          let subText;
          if (sub.mode === 'auto') subText = '自动查（对账结果 sheet 单据子类型）';
          else if (sub.mode === 'manualMain') subText = `主边手填 = "${sub.mainValue || ''}"`;
          else if (sub.mode === 'manualOpp') subText = `从边手填 = "${sub.oppValue || ''}"`;
          else if (sub.mode === 'manualBoth') subText = `主边手填 = "${sub.mainValue || ''}"，从边手填 = "${sub.oppValue || ''}"`;
          else subText = '（未选）';
          html += `<div class="scenario-confirm-detail-section"><span class="scenario-confirm-detail-label">SubBizType：</span>${escapeHtml(subText)}</div>`;
        }
      }
      return html;
    }

    function createScenarioConfirmDetailDialog() {
      const draft = state.scenarioDraft;
      if (!draft) {
        return createAlertDialog('内部错误：state.scenarioDraft 缺失');
      }
      const overlay = createOverlay();
      const dialog = document.createElement('div');
      dialog.className = 'modal-card scenario-confirm-detail-card';
      dialog.innerHTML = `
        <div class="dialog-header">
          <div class="dialog-title">确认场景详情</div>
          <button class="icon-close" type="button">×</button>
        </div>
        <div class="dialog-body scenario-confirm-detail-body">
          ${buildScenarioConfirmDetailHtml(draft)}
        </div>
        <div class="dialog-actions right">
          <button class="secondary-btn small" type="button" data-action="back">返回</button>
          <button class="primary-btn small" type="button" data-action="finish">完成</button>
        </div>
      `;

      function backToConfig() {
        // 保留 draft，重新打开对应配置弹窗
        openScenarioConfigByCategory(draft.category);
      }
      function closeAndClearDraft() {
        clearScenarioDraft();
        openModal(reopenScenariosManager());
      }
      dialog.querySelector('.icon-close').addEventListener('click', closeAndClearDraft);
      dialog.querySelector('[data-action="back"]').addEventListener('click', backToConfig);
      dialog.querySelector('[data-action="finish"]').addEventListener('click', async () => {
        try {
          let result;
          if (draft.mode === 'create') {
            result = await desktopApi.scenarios.create({
              category: draft.category,
              name: String(draft.name || '').trim(),
              priority: Number(draft.priority),
              enabled: true,
              config: draft.config
            });
          } else if (draft.mode === 'edit') {
            result = await desktopApi.scenarios.update(draft.scenarioId, {
              name: String(draft.name || '').trim(),
              priority: Number(draft.priority),
              config: draft.config
            });
          } else {
            // view 模式不应到达这里（按钮只显示"返回"）
            closeAndClearDraft();
            return;
          }
          if (!result || result.status !== 'ok') {
            openModal(createAlertDialog(`保存失败：${result?.message || '未知错误'}`, {
              onConfirm: backToConfig
            }));
            return;
          }
          // 成功 → 清空 draft + 刷新场景管理弹窗
          // v2.1.0-beta.2 PR #38 round 2 P2-2：按 draft.category 分流，避免跨模块互抹状态
          // v2.1.0-beta.3 T6：两个 ReconID 子模式（business/gateway）保存后都触发 reloadReconIdFixScenarios
          if (isReconIdFixCategory(draft.category)) {
            if (typeof reloadReconIdFixScenarios === 'function') await reloadReconIdFixScenarios();
          } else {
            if (typeof refreshBankStatementStatus === 'function') await refreshBankStatementStatus();
          }
          clearScenarioDraft();
          openModal(reopenScenariosManager());
        } catch (error) {
          openModal(createAlertDialog(`保存失败：${error.message || error}`, {
            onConfirm: backToConfig
          }));
        }
      });

      overlay.appendChild(dialog);
      return overlay;
    }

    // v2.1.4 T3 + Fix1：小助手功能收纳弹窗（双区域 + ➡️/⬅️ + 启用区行内拖拽排序 + 完成/取消 两阶段提交）
    //   opts.enabledModules : 初始启用列表（ID 数组）— 同时充当"取消"时的还原基准
    //   opts.allModules     : 全集 [{id, name}, ...]（从 renderer 的 MODULES 常量传入，工厂与常量解耦）
    //   opts.onCommit       : async (nextEnabledIds) => Promise<boolean>；true 表示落库成功
    //
    //   Fix1.2：撤回 v2.1.4 v0.1 的 O6 "即时落库" 设计 — 改为两阶段提交：
    //     - 弹窗内所有 ➡️/⬅️/拖拽 仅修改本地 workingEnabled，不调 onCommit
    //     - 「完成」按钮 → 一次性调 onCommit + 关弹窗；「取消」/× / overlay 点外 → 丢 workingEnabled + 关弹窗
    //   Fix1.4：再次点击同一行 → 取消选中（toggle）
    //   Fix1.5：闲置区排序由 String.length 改为视觉宽度（CJK 字符算 2，其他算 1）
    //   round 1 self-review I3：onCommit 失败显示 inline error 行 + 保留弹窗 / workingEnabled，用户可重试
    //   round 1 self-review I4：onCommit 期间 committing flag 锁定 cancel 路径，防 in-flight race
    function createModuleCabinetDialog({ enabledModules, allModules, onCommit }) {
      const originalEnabled = Array.isArray(enabledModules) ? [...enabledModules] : [];
      let workingEnabled = [...originalEnabled];
      const safeAllModules = Array.isArray(allModules) ? allModules : [];
      let committing = false;  // I4 in-flight guard
      const cabinetState = {
        selectedRegion: null,    // 'idle' | 'enabled' | null
        selectedModuleId: null,
        dragSourceId: null
      };

      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      overlay.dataset.previewModal = 'module-cabinet';

      const card = document.createElement('div');
      card.className = 'modal-card module-cabinet-card';
      card.innerHTML = `
        <div class="dialog-header">
          <div class="dialog-title">小助手功能收纳</div>
          <button class="icon-close" type="button" aria-label="关闭">×</button>
        </div>
        <div class="module-cabinet-body">
          <section class="module-cabinet-section">
            <div class="module-cabinet-section-title">闲置功能</div>
            <ul class="module-cabinet-list" data-region="idle" role="listbox"></ul>
          </section>
          <div class="module-cabinet-controls">
            <button class="module-cabinet-control" type="button" data-action="enable" aria-label="移到启用功能">➡️</button>
            <button class="module-cabinet-control" type="button" data-action="disable" aria-label="移到闲置功能">⬅️</button>
          </div>
          <section class="module-cabinet-section">
            <div class="module-cabinet-section-title">启用功能</div>
            <ul class="module-cabinet-list" data-region="enabled" role="listbox"></ul>
          </section>
        </div>
        <div class="module-cabinet-error" role="alert"></div>
        <div class="dialog-actions module-cabinet-footer">
          <button class="primary-btn small" type="button" data-action="confirm">完成</button>
          <button class="secondary-btn small" type="button" data-action="cancel">取消</button>
        </div>
      `;
      overlay.appendChild(card);

      const idleListEl = card.querySelector('[data-region="idle"]');
      const enabledListEl = card.querySelector('[data-region="enabled"]');
      const moveEnableBtn = card.querySelector('[data-action="enable"]');
      const moveDisableBtn = card.querySelector('[data-action="disable"]');
      const confirmBtn = card.querySelector('[data-action="confirm"]');
      const cancelBtn = card.querySelector('[data-action="cancel"]');
      const closeBtn = card.querySelector('.icon-close');
      const errorEl = card.querySelector('.module-cabinet-error');

      // 取消：丢 workingEnabled + 关弹窗（× / overlay 外部 / 取消按钮 三者等价）
      // round 1 self-review I4：committing 期间禁止取消（防 IPC in-flight race）
      function cancelAndClose() {
        if (committing) return;
        closeModal();
      }
      closeBtn.addEventListener('click', cancelAndClose);
      cancelBtn.addEventListener('click', cancelAndClose);
      overlay.addEventListener('click', (ev) => {
        if (ev.target === overlay) cancelAndClose();
      });

      // round 2 self-review I-new-1：committing 期间所有可点击元素同步禁用视觉，
      //   避免用户感知"按钮无反应"（之前仅逻辑 return，按钮 hover/cursor 视觉不变）
      function setCommittingState(active) {
        committing = active;
        confirmBtn.disabled = active;
        cancelBtn.disabled = active;
        closeBtn.disabled = active;
        if (active) {
          overlay.classList.add('is-committing');
        } else {
          overlay.classList.remove('is-committing');
        }
      }

      // 完成：调 onCommit 落库 + 关弹窗
      //   round 1 self-review I3：失败时显示 inline error + 保留弹窗 / workingEnabled，让用户重试
      //   round 1 self-review I4：committing flag 锁定 cancel 路径
      //   round 2 self-review I-new-7：try/finally 重构，committing reset 集中到一处
      confirmBtn.addEventListener('click', async () => {
        setCommittingState(true);
        errorEl.classList.remove('is-visible');
        errorEl.textContent = '';
        try {
          const ok = await onCommit(workingEnabled);
          if (ok) {
            closeModal();
            return;
          }
          errorEl.textContent = '保存模块设置失败，请稍后重试。';
          errorEl.classList.add('is-visible');
        } catch (err) {
          errorEl.textContent = `保存失败：${(err && err.message) || '未知错误'}`;
          errorEl.classList.add('is-visible');
        } finally {
          // 成功路径已 closeModal 销毁 DOM，下面 reset 仍跑但无副作用（disabled 写到已分离 element 不影响 UI）
          setCommittingState(false);
        }
      });

      function getModuleName(id) {
        const m = safeAllModules.find((x) => x.id === id);
        return m ? m.name : id;
      }

      // Fix1.5：视觉宽度（CJK 字符算 2，其它算 1）— 让"月度银行对账单BU回填校验"(24) 排在"月度 Pending 数据核对"(21) 后面
      // round 1 self-review M1：scope 限定 BMP CJK 统一汉字 + CJK 扩展 A + 兼容 + 全角 ASCII + CJK 符号；
      //   未覆盖：Hiragana / Katakana / Hangul / CJK 扩展 B-F（surrogate）/ 半角片假名。
      //   当前 MODULES 7 个模块名全是 中文 + ASCII 字符，未来如增加日韩翻译名或 CJK 扩展字需扩展本范围。
      function visualLength(s) {
        const str = String(s || '');
        let len = 0;
        for (let i = 0; i < str.length; i += 1) {
          const code = str.charCodeAt(i);
          if (
            (code >= 0x4E00 && code <= 0x9FFF) ||   // CJK 统一汉字
            (code >= 0x3400 && code <= 0x4DBF) ||   // CJK 扩展 A
            (code >= 0xF900 && code <= 0xFAFF) ||   // CJK 兼容
            (code >= 0xFF01 && code <= 0xFF60) ||   // 全角 ASCII
            (code >= 0x3000 && code <= 0x303F)      // CJK 符号与标点
          ) {
            len += 2;
          } else {
            len += 1;
          }
        }
        return len;
      }

      // 闲置区按视觉宽度升序（O1 拍板 + Fix1.5，tie-break 用 allModules 声明顺序）
      function buildSortedIdle() {
        const enabledSet = new Set(workingEnabled);
        return safeAllModules
          .filter((m) => !enabledSet.has(m.id))
          .sort((a, b) => {
            const la = visualLength(a.name);
            const lb = visualLength(b.name);
            if (la !== lb) return la - lb;
            return safeAllModules.indexOf(a) - safeAllModules.indexOf(b);
          })
          .map((m) => m.id);
      }

      function renderRegion(ulEl, ids, region) {
        ulEl.innerHTML = '';
        ids.forEach((id) => {
          const li = document.createElement('li');
          li.className = 'module-cabinet-item';
          li.dataset.moduleId = id;
          li.dataset.region = region;
          li.setAttribute('role', 'option');
          li.tabIndex = 0;
          if (id === cabinetState.selectedModuleId && region === cabinetState.selectedRegion) {
            li.classList.add('is-selected');
          }

          const label = document.createElement('span');
          label.className = 'module-cabinet-item-label';
          label.textContent = getModuleName(id);
          li.appendChild(label);

          if (region === 'enabled') {
            const handle = document.createElement('span');
            handle.className = 'module-cabinet-drag-handle';
            handle.textContent = '⋮⋮';
            handle.setAttribute('aria-label', '拖拽排序');
            li.appendChild(handle);
            li.draggable = true;
            li.addEventListener('dragstart', (ev) => {
              cabinetState.dragSourceId = id;
              ev.dataTransfer.effectAllowed = 'move';
              ev.dataTransfer.setData('text/plain', id);
              li.classList.add('is-dragging');
            });
            li.addEventListener('dragover', (ev) => {
              ev.preventDefault();
              ev.dataTransfer.dropEffect = 'move';
              li.classList.add('is-drag-over');
            });
            li.addEventListener('dragleave', () => {
              li.classList.remove('is-drag-over');
            });
            li.addEventListener('drop', (ev) => {
              ev.preventDefault();
              li.classList.remove('is-drag-over');
              const draggedId = cabinetState.dragSourceId;
              if (!draggedId || draggedId === id) return;
              const next = [...workingEnabled];
              const fromIdx = next.indexOf(draggedId);
              const toIdx = next.indexOf(id);
              if (fromIdx === -1 || toIdx === -1) return;
              next.splice(fromIdx, 1);
              next.splice(toIdx, 0, draggedId);
              // Fix1.2：拖拽仅改本地 workingEnabled，不调 onCommit（由「完成」按钮统一提交）
              workingEnabled = next;
              cabinetState.selectedRegion = null;
              cabinetState.selectedModuleId = null;
              renderLists();
            });
            li.addEventListener('dragend', () => {
              li.classList.remove('is-dragging');
              enabledListEl.querySelectorAll('.is-drag-over').forEach((x) => x.classList.remove('is-drag-over'));
              cabinetState.dragSourceId = null;
            });
          }

          li.addEventListener('click', () => {
            // Fix1.4：再次点击同一选中行 → 取消选中（toggle）
            const isSameSelected =
              cabinetState.selectedRegion === region && cabinetState.selectedModuleId === id;
            if (isSameSelected) {
              cabinetState.selectedRegion = null;
              cabinetState.selectedModuleId = null;
            } else {
              cabinetState.selectedRegion = region;
              cabinetState.selectedModuleId = id;
            }
            renderLists();
          });
          ulEl.appendChild(li);
        });
      }

      function renderLists() {
        renderRegion(idleListEl, buildSortedIdle(), 'idle');
        renderRegion(enabledListEl, workingEnabled, 'enabled');
        updateControls();
      }

      function updateControls() {
        moveEnableBtn.disabled =
          cabinetState.selectedRegion !== 'idle' || !cabinetState.selectedModuleId;
        // O3 拍板：启用区至少保留 1 个 → 仅剩 1 时禁用 ⬅️
        moveDisableBtn.disabled =
          cabinetState.selectedRegion !== 'enabled' ||
          !cabinetState.selectedModuleId ||
          workingEnabled.length <= 1;
      }

      // Fix1.2：➡️/⬅️ 仅改本地 workingEnabled，不调 onCommit
      function applyLocal(next) {
        workingEnabled = next;
        cabinetState.selectedRegion = null;
        cabinetState.selectedModuleId = null;
        renderLists();
      }

      moveEnableBtn.addEventListener('click', () => {
        if (cabinetState.selectedRegion !== 'idle' || !cabinetState.selectedModuleId) return;
        applyLocal([...workingEnabled, cabinetState.selectedModuleId]);
      });
      moveDisableBtn.addEventListener('click', () => {
        if (cabinetState.selectedRegion !== 'enabled' || !cabinetState.selectedModuleId) return;
        if (workingEnabled.length <= 1) return;
        applyLocal(workingEnabled.filter((x) => x !== cabinetState.selectedModuleId));
      });

      renderLists();
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
      createBalanceAddonManagerDialog,
      // v2.0.0-beta.3：银行对账单处理模块场景管理
      createScenariosManagerDialog,
      createScenarioCategorySelectDialog,
      // v2.0.0-beta.3 PR #32b：4 dialog factory（C1/C2/C3 配置 + 确认场景详情）
      createScenarioConfigDialogC1,
      createScenarioConfigDialogC2,
      createScenarioConfigDialogC3,
      createScenarioConfirmDetailDialog,
      // v2.1.0-beta.1 PR-A（task A7）：C4 类配置弹窗
      createScenarioConfigDialogC4,
      // v2.1.2 T2：月份选择对话框（PRD §3.2.5 数据流第一步）
      createBankBuReconMonthPickerDialog,
      // v2.1.6 fix5：收单单据币种校验月份选择对话框（spec v0.8 §8.1）
      createAcquiringBillCurrencyMonthPickerDialog,
      // v2.1.2 T2：文件导入提示对话框（取代 Electron showMessageBox，Clear 风前端 modal）
      createBankBuReconFileImportPromptDialog,
      // v2.1.2 T2 (spec v0.5)：开始运行 / 导出差异 弹窗
      createBankBuReconReconcileDialog,
      createBankBuReconExportDialog,
      // v2.1.2 T2：preview state apply 函数 3 个（initial / importing / result）
      // anomaly preview 在 v0.8 已删除（N:M 不中断不弹窗）
      applyBankBuReconPanelInitialPreviewState,
      applyBankBuReconPanelImportingPreviewState,
      applyBankBuReconPanelResultPreviewState,
      // v2.1.3：业务OP数据核对 dialog factory（v2.1.3-fix2 删除 createBizOpReconErrorReportDialog 死代码后剩 4 个）
      createBizOpReconDatePickerDialog,
      createBizOpReconReconcileDialog,
      createBizOpReconExportDialog,
      createBizOpReconSecondImportPromptDialog,
      // v2.1.3：preview state apply 函数 4 个（initial / importing / result / export-dialog）
      applyBizOpReconPanelInitialPreviewState,
      applyBizOpReconPanelImportingPreviewState,
      applyBizOpReconPanelResultPreviewState,
      applyBizOpReconPanelExportDialogPreviewState,
      // v2.1.3-fix1：状态框冒号换行 formatter + 默认日期 helper（renderer.js 复用）
      formatBizOpReconStatusHtml,
      getBizOpReconDefaultDate,
      // v2.1.4 T3：小助手功能收纳弹窗工厂
      createModuleCabinetDialog
    };

    // v2.1.2 T2 (spec v0.4 拍板)：月份选择对话框
    // 前端结构和样式参照月度 Pending 数据核对模块的 buildImportMonthDialog（src/renderer-pending.js:311+）
    // 复用 class：.pending-import-month-dialog / .pending-dialog-title / .monthly-balance-time-picker /
    //            .pending-import-month-picker / .monthly-balance-year-select.mapping-text-input /
    //            .monthly-balance-month-select.mapping-text-input / .dialog-actions.center / .secondary-btn.small / .primary-btn.small
    // 业务差异（与 Pending 不同）：
    //   - 标题文案：「选择对账月份」
    //   - 年份范围：当前年 ± 1（OPEN ISSUE Q1 拍板，不同于 Pending 的 current-9 ~ current+1）
    //   - 默认预选：当前年 + 上个月（OPEN ISSUE Q3 拍板）
    //   - 按钮文案：取消 / 下一步（后续还有 2 步文件选择）
    function createBankBuReconMonthPickerDialog({ onConfirm, onCancel } = {}) {
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      overlay.dataset.previewModal = 'bank-bu-recon-month-picker';

      const dialog = document.createElement('div');
      dialog.className = 'modal-card pending-import-month-dialog';
      overlay.appendChild(dialog);

      const title = document.createElement('div');
      title.className = 'pending-dialog-title';
      title.textContent = '选择对账月份';
      dialog.appendChild(title);

      // 复用 Pending 模块 picker 结构（year + month 两 select 横排）
      const picker = document.createElement('div');
      picker.className = 'monthly-balance-time-picker pending-import-month-picker';

      // 默认预选：当前年 + 上个月（new Date(y, m-1, 1) 跨年初自动回退到上年 12 月）
      const now = new Date();
      const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const defaultYear = lastMonth.getFullYear();
      const defaultMonthNum = lastMonth.getMonth() + 1;

      // 年份范围：当前年 ± 1（用日历年 now.getFullYear() 计算，避免 1 月时漏当前年）
      const curYear = now.getFullYear();
      const yearSelect = document.createElement('select');
      yearSelect.className = 'monthly-balance-year-select mapping-text-input';
      for (let y = curYear - 1; y <= curYear + 1; y += 1) {
        const opt = document.createElement('option');
        opt.value = String(y);
        opt.textContent = `${y} 年`;
        if (y === defaultYear) opt.selected = true;
        yearSelect.appendChild(opt);
      }

      const monthSelect = document.createElement('select');
      monthSelect.className = 'monthly-balance-month-select mapping-text-input';
      for (let m = 1; m <= 12; m += 1) {
        const opt = document.createElement('option');
        opt.value = String(m).padStart(2, '0');
        opt.textContent = `${m} 月`;
        if (m === defaultMonthNum) opt.selected = true;
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
      cancelBtn.addEventListener('click', () => {
        closeModal();
        if (typeof onCancel === 'function') onCancel();
      });

      const confirmBtn = document.createElement('button');
      confirmBtn.className = 'primary-btn small';
      confirmBtn.type = 'button';
      confirmBtn.textContent = '下一步';
      confirmBtn.addEventListener('click', () => {
        const yearMonth = `${yearSelect.value}-${monthSelect.value}`;
        closeModal();
        if (typeof onConfirm === 'function') onConfirm(yearMonth);
      });

      actions.appendChild(cancelBtn);
      actions.appendChild(confirmBtn);
      dialog.appendChild(actions);

      return overlay;
    }

    // v2.1.6 fix5：收单单据币种校验月份选择对话框（spec v0.8 §8.1）
    // 结构 + 样式同 createBankBuReconMonthPickerDialog，按钮文字「下一步」改为 actionLabel（"导入" / "运行" / "导出"）
    function createAcquiringBillCurrencyMonthPickerDialog({ actionLabel = '导入', onConfirm, onCancel } = {}) {
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      overlay.dataset.previewModal = 'acquiring-bill-currency-month-picker';

      const dialog = document.createElement('div');
      dialog.className = 'modal-card pending-import-month-dialog';
      overlay.appendChild(dialog);

      const title = document.createElement('div');
      title.className = 'pending-dialog-title';
      // v2.1.6 fix15：actionLabel 三分支标题文案
      //   - '导入'（流水表/单据表点击）→「请选择导入文件的月份」
      //   - '导出'（导出差异点击）→「选择导出差异的月份」
      //   - 其他（默认含'运行'）→「选择对账月份」
      title.textContent = actionLabel === '导出'
        ? '选择导出差异的月份'
        : actionLabel === '导入'
          ? '请选择导入文件的月份'
          : '选择对账月份';
      dialog.appendChild(title);

      const picker = document.createElement('div');
      picker.className = 'monthly-balance-time-picker pending-import-month-picker';

      const now = new Date();
      const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const defaultYear = lastMonth.getFullYear();
      const defaultMonthNum = lastMonth.getMonth() + 1;

      const curYear = now.getFullYear();
      const yearSelect = document.createElement('select');
      yearSelect.className = 'monthly-balance-year-select mapping-text-input';
      for (let y = curYear - 1; y <= curYear + 1; y += 1) {
        const opt = document.createElement('option');
        opt.value = String(y);
        opt.textContent = `${y} 年`;
        if (y === defaultYear) opt.selected = true;
        yearSelect.appendChild(opt);
      }

      const monthSelect = document.createElement('select');
      monthSelect.className = 'monthly-balance-month-select mapping-text-input';
      for (let m = 1; m <= 12; m += 1) {
        const opt = document.createElement('option');
        opt.value = String(m).padStart(2, '0');
        opt.textContent = `${m} 月`;
        if (m === defaultMonthNum) opt.selected = true;
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
      cancelBtn.addEventListener('click', () => {
        closeModal();
        if (typeof onCancel === 'function') onCancel();
      });

      const confirmBtn = document.createElement('button');
      confirmBtn.className = 'primary-btn small';
      confirmBtn.type = 'button';
      confirmBtn.textContent = actionLabel;
      confirmBtn.addEventListener('click', () => {
        const yearMonth = `${yearSelect.value}-${monthSelect.value}`;
        closeModal();
        if (typeof onConfirm === 'function') onConfirm(yearMonth);
      });

      actions.appendChild(cancelBtn);
      actions.appendChild(confirmBtn);
      dialog.appendChild(actions);

      return overlay;
    }

    // v2.1.2 T2 (spec v0.4 拍板)：文件导入提示对话框（Clear 风前端 modal）
    // 取代 main.js 的 dialog.showMessageBox（macOS 上系统对话框样式割裂 + title 不显示）
    // 复用 .modal-card.alert-card / .alert-body / .alert-icon / .alert-message / .dialog-actions.center 风格
    // 用法：
    //   openModal(createBankBuReconFileImportPromptDialog({
    //     title: '请导入 Pending 数据管理文件',
    //     detail: '接下来弹出的文件选择对话框中，请选择对应的 xlsx 文件（对账月份 2026-04）。',
    //     onConfirm: async () => { /* 触发 IPC pickPendingFile */ },
    //     onCancel: () => {}
    //   }));
    function createBankBuReconFileImportPromptDialog({ title = '', detail = '', onConfirm, onCancel } = {}) {
      const overlay = createOverlay();
      const card = document.createElement('div');
      card.className = 'modal-card alert-card';
      card.dataset.previewModal = 'bank-bu-recon-file-import-prompt';
      card.innerHTML = `
        <div class="alert-body">
          <div class="alert-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="28" height="28"><defs><linearGradient id="bbrFilePromptIconG" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#4285F4"/><stop offset="100%" stop-color="#9B72F2"/></linearGradient></defs><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-6-6z" fill="none" stroke="url(#bbrFilePromptIconG)" stroke-width="2" stroke-linejoin="round"/><path d="M14 3v6h6" fill="none" stroke="url(#bbrFilePromptIconG)" stroke-width="2" stroke-linejoin="round"/></svg>
          </div>
          <div class="alert-message">
            <div style="font-weight:600; font-size:15px; margin-bottom:6px;">${escapeHtmlSafe(title)}</div>
            <div style="font-size:13px; color:#666; line-height:1.55;">${escapeHtmlSafe(detail)}</div>
          </div>
        </div>
        <div class="dialog-actions center">
          <button class="secondary-btn small" type="button" data-action="cancel">取消</button>
          <button class="primary-btn small" type="button" data-action="confirm">继续选择</button>
        </div>
      `;
      card.querySelector('[data-action="cancel"]').addEventListener('click', () => {
        closeModal();
        if (typeof onCancel === 'function') onCancel();
      });
      card.querySelector('[data-action="confirm"]').addEventListener('click', async () => {
        closeModal();
        if (typeof onConfirm === 'function') await onConfirm();
      });
      overlay.appendChild(card);
      return overlay;
    }

    // v2.1.2 T2：preview state apply 函数集 — 由 preview script 通过 APP_PREVIEW_MODAL 触发
    function switchToBankBuReconPanel() {
      // 隐藏其他面板，显示 bankBuReconModulePanel
      ['statementModulePanel','newAccountModulePanel','pendingModulePanel','bankStatementModulePanel','reconIdFixModulePanel'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.hidden = true;
      });
      const panel = document.getElementById('bankBuReconModulePanel');
      if (panel) panel.hidden = false;
      const nameEl = document.getElementById('currentModuleName');
      if (nameEl) nameEl.textContent = '月度银行对账单BU回填校验';
    }

    function applyBankBuReconPanelInitialPreviewState() {
      switchToBankBuReconPanel();
      const importBtn = document.getElementById('bankBuReconImportBtn');
      if (importBtn) importBtn.disabled = false;  // PRD §3.2.5：导入按钮默认可点击
      const statusBox = document.getElementById('bankBuReconStatusBox');
      const statusText = statusBox && statusBox.querySelector('.status-box-text');
      if (statusText) statusText.textContent = '欢迎使用小助手';
    }

    function applyBankBuReconPanelImportingPreviewState() {
      switchToBankBuReconPanel();
      const importBtn = document.getElementById('bankBuReconImportBtn');
      if (importBtn) importBtn.disabled = false;
      const statusBox = document.getElementById('bankBuReconStatusBox');
      const statusText = statusBox && statusBox.querySelector('.status-box-text');
      if (statusText) statusText.textContent = '正在导入 2026-04 数据...';
    }

    function applyBankBuReconPanelResultPreviewState() {
      switchToBankBuReconPanel();
      ['bankBuReconImportBtn','bankBuReconRunBtn','bankBuReconExportBtn'].forEach((id) => {
        const b = document.getElementById(id);
        if (b) b.disabled = false;
      });
      const statusBox = document.getElementById('bankBuReconStatusBox');
      const statusText = statusBox && statusBox.querySelector('.status-box-text');
      if (statusText) statusText.textContent = '2026-04 对账完成：成功 145 行 / BU 差异 7 行 / Pending 未匹上银行 7 行 / 银行未匹上 Pending 3 行';
    }

    // v0.8 已删除 applyBankBuReconPanelAnomalyPreviewState + createBankBuReconAnomalyDialog
    // 原因：N:M 异常不再中断运行 + 不再弹窗，改为写入差异表 Sheet 3「异常」（spec §3.8 v0.8 废弃）

    function escapeHtmlSafe(s) {
      return String(s || '').replace(/[&<>"']/g, (ch) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
      }[ch]));
    }

    // v2.1.2 T2 (spec v0.5)：「开始运行」对账月份选择对话框
    // 参照 src/renderer-pending.js#buildReconcileDialog 但改为单列单月（BU 回填是单月对账）
    function createBankBuReconReconcileDialog({ readyMonths = [], defaultMonth = '', onConfirm, onCancel } = {}) {
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      overlay.dataset.previewModal = 'bank-bu-recon-reconcile';

      const dialog = document.createElement('div');
      dialog.className = 'modal-card pending-reconcile-dialog';
      overlay.appendChild(dialog);

      const title = document.createElement('div');
      title.className = 'pending-dialog-title';
      title.textContent = '选取需要对账的月份';
      dialog.appendChild(title);

      // 单列结构（仍用 .pending-rule-columns，只放 1 个 column）
      const columnsWrap = document.createElement('div');
      columnsWrap.className = 'pending-rule-columns';
      dialog.appendChild(columnsWrap);

      const column = document.createElement('div');
      column.className = 'pending-rule-column';
      const header = document.createElement('div');
      header.className = 'pending-rule-column-header';
      header.textContent = '对账月份';
      column.appendChild(header);

      const select = document.createElement('select');
      select.className = 'mapping-text-input pending-reconcile-month-select';
      const initialMonth = defaultMonth && readyMonths.includes(defaultMonth)
        ? defaultMonth
        : (readyMonths[0] || '');
      readyMonths.forEach((m) => {
        const opt = document.createElement('option');
        opt.value = m;
        opt.textContent = m;
        if (m === initialMonth) opt.selected = true;
        select.appendChild(opt);
      });
      column.appendChild(select);
      columnsWrap.appendChild(column);

      const actions = document.createElement('div');
      actions.className = 'dialog-actions center';

      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'secondary-btn small';
      cancelBtn.type = 'button';
      cancelBtn.textContent = '取消';
      cancelBtn.addEventListener('click', () => {
        closeModal();
        if (typeof onCancel === 'function') onCancel();
      });

      const confirmBtn = document.createElement('button');
      confirmBtn.className = 'primary-btn small';
      confirmBtn.type = 'button';
      confirmBtn.textContent = '完成';
      confirmBtn.addEventListener('click', () => {
        const yearMonth = select.value;
        if (!yearMonth) return;
        closeModal();
        if (typeof onConfirm === 'function') onConfirm(yearMonth);
      });

      actions.appendChild(confirmBtn);
      actions.appendChild(cancelBtn);
      dialog.appendChild(actions);

      return overlay;
    }

    // v2.1.2 T2 (spec v0.5)：「导出差异」弹窗
    // 参照 src/renderer-pending.js#buildExportDialog；但「指定月份」只显示月份下拉（自动用最新 success run）
    function createBankBuReconExportDialog({ successMonths = [], onConfirm, onCancel } = {}) {
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      overlay.dataset.previewModal = 'bank-bu-recon-export';

      const dialog = document.createElement('div');
      dialog.className = 'modal-card pending-export-dialog';
      overlay.appendChild(dialog);

      const title = document.createElement('div');
      title.className = 'pending-dialog-title';
      title.textContent = '导出差异';
      dialog.appendChild(title);

      // Radio 1 + 月份下拉 — singleBlock 包裹 radio row 和 select row
      // select 左边缘 = label「导」字起点（用 padding-left 实现）
      // select 右边缘 = label「份」字末尾（dialog attach 后 JS 测量 label 宽度，强制设 select width）
      // 纯 CSS 不可行：select 自带 min-width:200px (.pending-reconcile-month-select) + native intrinsic 宽度会撑大 inline-block，循环依赖
      const RADIO_WIDTH_PX = 16;     // input[type=radio] 默认 ~13-16px
      const RADIO_GAP_PX = 8;        // radio 与 label 之间的 gap
      const SELECT_LEFT_OFFSET = `${RADIO_WIDTH_PX + RADIO_GAP_PX}px`;

      const singleBlock = document.createElement('div');

      const radioSingle = document.createElement('input');
      radioSingle.type = 'radio';
      radioSingle.name = 'bbr-export-scope';
      radioSingle.id = 'bbr-export-radio-single';
      radioSingle.value = 'single';
      radioSingle.checked = true;
      const radioSingleLabel = document.createElement('label');
      radioSingleLabel.setAttribute('for', 'bbr-export-radio-single');
      radioSingleLabel.textContent = '导出指定月份';
      const radioSingleRow = document.createElement('div');
      radioSingleRow.style.display = 'inline-flex';   // 让 row 自然收缩到内容宽度（用于 align 测量）
      radioSingleRow.style.alignItems = 'center';
      radioSingleRow.style.gap = `${RADIO_GAP_PX}px`;
      radioSingleRow.appendChild(radioSingle);
      radioSingleRow.appendChild(radioSingleLabel);
      singleBlock.appendChild(radioSingleRow);

      // 月份下拉 wrapper — padding-left 让 select 左边缘对齐 label 文字起点
      // marginTop 拉开与上方 radio row 的距离（用户拍板"距离太近"）
      const monthRow = document.createElement('div');
      monthRow.style.marginTop = '14px';
      monthRow.style.paddingLeft = SELECT_LEFT_OFFSET;
      const monthSelect = document.createElement('select');
      monthSelect.className = 'mapping-text-input pending-reconcile-month-select';
      monthSelect.style.minWidth = '0';   // 覆盖 .pending-reconcile-month-select 的 min-width:200px
      monthSelect.style.boxSizing = 'border-box';
      successMonths.forEach((m, idx) => {
        const opt = document.createElement('option');
        opt.value = String(m.latestSuccessRunId);
        opt.textContent = m.yearMonth;
        opt.dataset.yearMonth = m.yearMonth;
        if (idx === 0) opt.selected = true;
        monthSelect.appendChild(opt);
      });
      monthRow.appendChild(monthSelect);
      singleBlock.appendChild(monthRow);

      dialog.appendChild(singleBlock);

      // dialog attach 到 DOM 后测量 label 实际渲染宽度，强制设 select 宽度对齐
      // 用 setTimeout 0 等 openModal 完成 DOM attach；document.fonts.ready 兜底字体延迟加载
      // v0.7b 拍板：select 右侧再拓宽 SELECT_RIGHT_EXTEND px，用户视觉偏好
      const SELECT_RIGHT_EXTEND_PX = 32;
      function alignSelectToLabel() {
        if (!radioSingleLabel.isConnected) return;
        const labelWidth = radioSingleLabel.getBoundingClientRect().width;
        if (labelWidth > 0) {
          const targetWidth = labelWidth + SELECT_RIGHT_EXTEND_PX;
          monthSelect.style.width = targetWidth + 'px';
          monthSelect.style.maxWidth = targetWidth + 'px';
        }
      }
      setTimeout(alignSelectToLabel, 0);
      if (document.fonts && typeof document.fonts.ready === 'object') {
        document.fonts.ready.then(() => alignSelectToLabel()).catch(() => {});
      }

      // Radio 2：所有月份汇总（独立行，宽度自适应 label 内容）
      const radioAggr = document.createElement('input');
      radioAggr.type = 'radio';
      radioAggr.name = 'bbr-export-scope';
      radioAggr.id = 'bbr-export-radio-aggr';
      radioAggr.value = 'aggregate';
      const radioAggrLabel = document.createElement('label');
      radioAggrLabel.setAttribute('for', 'bbr-export-radio-aggr');
      radioAggrLabel.textContent = '导出所有月份汇总（每月取最新 success run）';
      const radioAggrRow = document.createElement('div');
      radioAggrRow.style.display = 'flex';
      radioAggrRow.style.alignItems = 'center';
      radioAggrRow.style.gap = `${RADIO_GAP_PX}px`;
      radioAggrRow.style.marginTop = '14px';   // 与上方 select 拉开
      radioAggrRow.appendChild(radioAggr);
      radioAggrRow.appendChild(radioAggrLabel);
      dialog.appendChild(radioAggrRow);

      function updateMode() {
        monthSelect.disabled = !radioSingle.checked;
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
      cancelBtn.addEventListener('click', () => {
        closeModal();
        if (typeof onCancel === 'function') onCancel();
      });
      const confirmBtn = document.createElement('button');
      confirmBtn.className = 'primary-btn small';
      confirmBtn.type = 'button';
      confirmBtn.textContent = '导出';
      confirmBtn.addEventListener('click', () => {
        if (radioSingle.checked) {
          const runId = Number(monthSelect.value);
          const ym = monthSelect.options[monthSelect.selectedIndex]?.dataset?.yearMonth || '';
          if (!runId) {
            openModal(createAlertDialog('请选择一个月份'));
            return;
          }
          closeModal();
          if (typeof onConfirm === 'function') onConfirm({ scope: 'single', runId, yearMonth: ym });
        } else {
          closeModal();
          if (typeof onConfirm === 'function') onConfirm({ scope: 'aggregate' });
        }
      });
      actions.appendChild(confirmBtn);
      actions.appendChild(cancelBtn);
      dialog.appendChild(actions);

      return overlay;
    }

    // ============================================================
    // v2.1.3：业务OP数据核对 dialog factory（6 个）+ preview state apply（4 个）
    // OPEN ISSUE 拍板固化：#5 错误报告 / #8 年±1 月日不联动 / #9 文件名 / #11 续导确认 / #12 ready 前置 / #13 success 复用
    // ============================================================

    // v2.1.3-fix1.5：状态框冒号换行 formatter（仅本模块用）
    // 规则：所有 ":" 和 "：" 紧跟一个 <br>，其余字符 HTML escape
    function formatBizOpReconStatusHtml(text) {
      const s = String(text == null ? '' : text);
      return escapeHtml(s).replace(/([:：])/g, '$1<br>');
    }

    // v2.1.3-fix1.4：今天 - 1 天（本地时区，按月底/年初滚动）→ "YYYY-MM-DD"
    function getBizOpReconDefaultDate() {
      const d = new Date(Date.now() - 86400000);
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      return `${yyyy}-${mm}-${dd}`;
    }

    // 通用日期选择对话框（业务OP / 流水对账单 / 对账日期 共用结构）
    // #8 拍板 A：年下拉 = currentYear ± 1（如 2025/2026/2027），月 1-12，日 1-31，三个下拉不联动
    // 入参：{ title, defaultDate?, allowedDates?: [{date}], onConfirm(date), onCancel }
    //   - allowedDates 非空：模式 = "下拉只列 allowedDates"（用于对账日期选择，#12 前置 enable）
    //   - allowedDates 空：模式 = "三下拉自由组合（年±1 / 月 1-12 / 日 1-31，不联动）"
    function createBizOpReconDatePickerDialog({ title = '选择日期', defaultDate = '', allowedDates = null, onConfirm, onCancel } = {}) {
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      overlay.dataset.previewModal = 'biz-op-recon-date-picker';

      const dialog = document.createElement('div');
      dialog.className = 'modal-card pending-import-month-dialog';
      overlay.appendChild(dialog);

      const titleEl = document.createElement('div');
      titleEl.className = 'pending-dialog-title';
      titleEl.textContent = title;
      dialog.appendChild(titleEl);

      const picker = document.createElement('div');
      // v2.1.3-fix1.3：自由模式下年月日同行 flex，专用类 .biz-op-recon-date-picker（CSS 控宽度/间距）
      picker.className = 'monthly-balance-time-picker pending-import-month-picker biz-op-recon-date-picker';

      // allowedDates 模式（对账日期选择）：单个 select 列出 ready 日期
      // 自由模式（业务OP / 流水日期选择）：年/月/日三 select 不联动
      let yearSelect, monthSelect, daySelect, allowedSelect;
      let mode;
      if (Array.isArray(allowedDates)) {
        mode = 'allowed';
        allowedSelect = document.createElement('select');
        allowedSelect.className = 'mapping-text-input pending-reconcile-month-select';
        if (allowedDates.length === 0) {
          const opt = document.createElement('option');
          opt.value = '';
          opt.textContent = '— 暂无可对账日期 —';
          allowedSelect.appendChild(opt);
          allowedSelect.disabled = true;
        } else {
          allowedDates.forEach((d, idx) => {
            const opt = document.createElement('option');
            opt.value = d.date;
            opt.textContent = d.date;
            if (idx === 0) opt.selected = true;
            allowedSelect.appendChild(opt);
          });
        }
        picker.appendChild(allowedSelect);
      } else {
        mode = 'free';
        const now = new Date();
        const curYear = now.getFullYear();
        const def = parseDateLike(defaultDate) || now;
        const defYear = def.getFullYear();
        const defMonth = def.getMonth() + 1;
        const defDay = def.getDate();

        yearSelect = document.createElement('select');
        // v2.1.3-fix1.3：年份 select 加专用 class（CSS 控宽 > 月/日）
        yearSelect.className = 'monthly-balance-year-select mapping-text-input biz-op-recon-date-year';
        for (let y = curYear - 1; y <= curYear + 1; y += 1) {
          const opt = document.createElement('option');
          opt.value = String(y);
          opt.textContent = `${y} 年`;
          if (y === defYear) opt.selected = true;
          yearSelect.appendChild(opt);
        }

        monthSelect = document.createElement('select');
        monthSelect.className = 'monthly-balance-month-select mapping-text-input biz-op-recon-date-month';
        for (let m = 1; m <= 12; m += 1) {
          const opt = document.createElement('option');
          opt.value = String(m).padStart(2, '0');
          opt.textContent = `${m} 月`;
          if (m === defMonth) opt.selected = true;
          monthSelect.appendChild(opt);
        }

        daySelect = document.createElement('select');
        daySelect.className = 'monthly-balance-month-select mapping-text-input biz-op-recon-date-day';
        for (let d = 1; d <= 31; d += 1) {
          const opt = document.createElement('option');
          opt.value = String(d).padStart(2, '0');
          opt.textContent = `${d} 日`;
          if (d === defDay) opt.selected = true;
          daySelect.appendChild(opt);
        }

        picker.appendChild(yearSelect);
        picker.appendChild(monthSelect);
        picker.appendChild(daySelect);
      }
      dialog.appendChild(picker);

      const actions = document.createElement('div');
      actions.className = 'dialog-actions center';

      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'secondary-btn small';
      cancelBtn.type = 'button';
      cancelBtn.textContent = '取消';
      cancelBtn.addEventListener('click', () => {
        closeModal();
        if (typeof onCancel === 'function') onCancel();
      });

      const confirmBtn = document.createElement('button');
      confirmBtn.className = 'primary-btn small';
      confirmBtn.type = 'button';
      confirmBtn.textContent = '完成';
      // #12 拍板 A：allowedDates 为空 → 完成按钮 disabled
      if (mode === 'allowed' && allowedDates.length === 0) {
        confirmBtn.disabled = true;
      }
      confirmBtn.addEventListener('click', () => {
        let date;
        if (mode === 'allowed') {
          date = allowedSelect.value;
          if (!date) return;
        } else {
          date = `${yearSelect.value}-${monthSelect.value}-${daySelect.value}`;
        }
        closeModal();
        if (typeof onConfirm === 'function') onConfirm(date);
      });

      actions.appendChild(confirmBtn);
      actions.appendChild(cancelBtn);
      dialog.appendChild(actions);

      return overlay;
    }

    function parseDateLike(s) {
      if (!s) return null;
      const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (!m) return null;
      return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    }

    // 「开始运行」对账日期选择（#12 拍板 A：下拉只列 ready 日期）
    // 入参：{ readyDates: [{date}], onConfirm(date), onCancel }
    function createBizOpReconReconcileDialog({ readyDates = [], onConfirm, onCancel } = {}) {
      return createBizOpReconDatePickerDialog({
        title: '选取需要对账的日期',
        allowedDates: readyDates,
        onConfirm,
        onCancel
      });
    }

    // 「导出差异」对话框 — 两 radio：指定日期 / 区间
    // #9 拍板 A 文件名（前端只构造日期，文件名由 handler 拼装）
    // #13 拍板 A successDates 来源
    function createBizOpReconExportDialog({ successDates = [], onConfirm, onCancel } = {}) {
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      overlay.dataset.previewModal = 'biz-op-recon-export';

      const dialog = document.createElement('div');
      dialog.className = 'modal-card pending-export-dialog';
      overlay.appendChild(dialog);

      const title = document.createElement('div');
      title.className = 'pending-dialog-title';
      title.textContent = '导出差异';
      dialog.appendChild(title);

      const RADIO_GAP_PX = 8;

      // Radio 1：指定日期
      const radioSingle = document.createElement('input');
      radioSingle.type = 'radio';
      radioSingle.name = 'biz-op-recon-export-scope';
      radioSingle.id = 'biz-op-recon-export-radio-single';
      radioSingle.value = 'single';
      radioSingle.checked = true;
      const radioSingleLabel = document.createElement('label');
      radioSingleLabel.setAttribute('for', radioSingle.id);
      radioSingleLabel.textContent = '导出指定日期';
      const radioSingleRow = document.createElement('div');
      radioSingleRow.style.display = 'flex';
      radioSingleRow.style.alignItems = 'center';
      radioSingleRow.style.gap = `${RADIO_GAP_PX}px`;
      radioSingleRow.appendChild(radioSingle);
      radioSingleRow.appendChild(radioSingleLabel);
      dialog.appendChild(radioSingleRow);

      // 单日下拉
      const singleRow = document.createElement('div');
      singleRow.style.marginTop = '10px';
      singleRow.style.paddingLeft = '24px';
      const singleSelect = document.createElement('select');
      singleSelect.className = 'mapping-text-input pending-reconcile-month-select';
      successDates.forEach((d, idx) => {
        const opt = document.createElement('option');
        opt.value = String(d.runId);
        opt.textContent = d.date;
        opt.dataset.date = d.date;
        if (idx === 0) opt.selected = true;
        singleSelect.appendChild(opt);
      });
      singleRow.appendChild(singleSelect);
      dialog.appendChild(singleRow);

      // Radio 2：区间
      const radioRange = document.createElement('input');
      radioRange.type = 'radio';
      radioRange.name = 'biz-op-recon-export-scope';
      radioRange.id = 'biz-op-recon-export-radio-range';
      radioRange.value = 'range';
      const radioRangeLabel = document.createElement('label');
      radioRangeLabel.setAttribute('for', radioRange.id);
      radioRangeLabel.textContent = '导出指定日期区间';
      const radioRangeRow = document.createElement('div');
      radioRangeRow.style.display = 'flex';
      radioRangeRow.style.alignItems = 'center';
      radioRangeRow.style.gap = `${RADIO_GAP_PX}px`;
      radioRangeRow.style.marginTop = '14px';
      radioRangeRow.appendChild(radioRange);
      radioRangeRow.appendChild(radioRangeLabel);
      dialog.appendChild(radioRangeRow);

      // 区间起止下拉
      const rangeRow = document.createElement('div');
      rangeRow.style.marginTop = '10px';
      rangeRow.style.paddingLeft = '24px';
      rangeRow.style.display = 'flex';
      rangeRow.style.gap = '8px';
      rangeRow.style.alignItems = 'center';
      const startSelect = document.createElement('select');
      startSelect.className = 'mapping-text-input pending-reconcile-month-select';
      successDates.forEach((d, idx) => {
        const opt = document.createElement('option');
        opt.value = d.date;
        opt.textContent = d.date;
        if (idx === 0) opt.selected = true;
        startSelect.appendChild(opt);
      });
      const dash = document.createElement('span');
      dash.textContent = '—';
      const endSelect = document.createElement('select');
      endSelect.className = 'mapping-text-input pending-reconcile-month-select';
      successDates.forEach((d, idx) => {
        const opt = document.createElement('option');
        opt.value = d.date;
        opt.textContent = d.date;
        if (idx === 0) opt.selected = true;
        endSelect.appendChild(opt);
      });
      rangeRow.appendChild(startSelect);
      rangeRow.appendChild(dash);
      rangeRow.appendChild(endSelect);
      dialog.appendChild(rangeRow);

      function updateMode() {
        singleSelect.disabled = !radioSingle.checked;
        startSelect.disabled = !radioRange.checked;
        endSelect.disabled = !radioRange.checked;
      }
      radioSingle.addEventListener('change', updateMode);
      radioRange.addEventListener('change', updateMode);
      updateMode();

      const actions = document.createElement('div');
      actions.className = 'dialog-actions center';
      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'secondary-btn small';
      cancelBtn.type = 'button';
      cancelBtn.textContent = '取消';
      cancelBtn.addEventListener('click', () => {
        closeModal();
        if (typeof onCancel === 'function') onCancel();
      });
      const confirmBtn = document.createElement('button');
      confirmBtn.className = 'primary-btn small';
      confirmBtn.type = 'button';
      confirmBtn.textContent = '导出';
      confirmBtn.addEventListener('click', () => {
        if (radioSingle.checked) {
          const runId = Number(singleSelect.value);
          const date = singleSelect.options[singleSelect.selectedIndex]?.dataset?.date || '';
          if (!runId) {
            openModal(createAlertDialog('请选择一个日期'));
            return;
          }
          closeModal();
          if (typeof onConfirm === 'function') onConfirm({ scope: 'single', runId, date });
        } else {
          const startDate = startSelect.value;
          const endDate = endSelect.value;
          if (!startDate || !endDate) {
            openModal(createAlertDialog('请选择起止日期'));
            return;
          }
          if (startDate > endDate) {
            openModal(createAlertDialog('起始日期不能晚于结束日期'));
            return;
          }
          closeModal();
          if (typeof onConfirm === 'function') onConfirm({ scope: 'range', startDate, endDate });
        }
      });
      actions.appendChild(confirmBtn);
      actions.appendChild(cancelBtn);
      dialog.appendChild(actions);

      return overlay;
    }

    // #11 拍板 B：续导确认对话框
    function createBizOpReconSecondImportPromptDialog({ firstDate = '', onConfirm, onCancel } = {}) {
      const overlay = createOverlay();
      const card = document.createElement('div');
      card.className = 'modal-card alert-card';
      card.dataset.previewModal = 'biz-op-recon-second-import-prompt';
      card.innerHTML = `
        <div class="alert-body">
          <div class="alert-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="28" height="28"><defs><linearGradient id="bopSecondPromptIconG" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#4285F4"/><stop offset="100%" stop-color="#9B72F2"/></linearGradient></defs><path d="M12 2 L14.2 9.8 L22 12 L14.2 14.2 L12 22 L9.8 14.2 L2 12 L9.8 9.8 Z" fill="url(#bopSecondPromptIconG)"/></svg>
          </div>
          <div class="alert-message">
            <div style="font-weight:600; font-size:15px; margin-bottom:6px;">已导入第 1 日数据（${escapeHtmlSafe(firstDate)}）</div>
            <div style="font-size:13px; color:#666; line-height:1.55;">是否立即导入第 2 日数据？两日数据齐备后才能进入流水对账单导入。</div>
          </div>
        </div>
        <div class="dialog-actions center">
          <button class="secondary-btn small" type="button" data-action="cancel">否</button>
          <button class="primary-btn small" type="button" data-action="confirm">是</button>
        </div>
      `;
      card.querySelector('[data-action="cancel"]').addEventListener('click', () => {
        closeModal();
        if (typeof onCancel === 'function') onCancel();
      });
      card.querySelector('[data-action="confirm"]').addEventListener('click', () => {
        closeModal();
        if (typeof onConfirm === 'function') onConfirm();
      });
      overlay.appendChild(card);
      return overlay;
    }

    // v2.1.3-fix1.5/fix2：删除 createBizOpReconErrorReportDialog 死代码（导入失败已改为状态框报错 + 失败报告路径，无对话框路径）

    // v2.1.3：preview state apply 函数（4 个 — initial / importing / result / export-dialog）
    function switchToBizOpReconPanel() {
      ['statementModulePanel','newAccountModulePanel','pendingModulePanel','bankStatementModulePanel','reconIdFixModulePanel','bankBuReconModulePanel'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.hidden = true;
      });
      const panel = document.getElementById('bizOpReconModulePanel');
      if (panel) panel.hidden = false;
      const nameEl = document.getElementById('currentModuleName');
      if (nameEl) nameEl.textContent = '业务OP数据核对';
    }

    function applyBizOpReconPanelInitialPreviewState() {
      switchToBizOpReconPanel();
      const importBtn = document.getElementById('bizOpReconImportBtn');
      if (importBtn) importBtn.disabled = false;
      const runBtn = document.getElementById('bizOpReconRunBtn');
      if (runBtn) runBtn.disabled = true;
      const exportBtn = document.getElementById('bizOpReconExportBtn');
      if (exportBtn) exportBtn.disabled = true;
      const buSelect = document.getElementById('bizOpReconBuSelect');
      if (buSelect) {
        // v2.1.3-fix1：永远不 disabled，空白 placeholder（label 完全空白）
        buSelect.disabled = false;
        while (buSelect.firstChild) buSelect.removeChild(buSelect.firstChild);
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = '';
        buSelect.appendChild(opt);
      }
      const statusBox = document.getElementById('bizOpReconStatusBox');
      const statusText = statusBox && statusBox.querySelector('.status-box-text');
      // v2.1.3-fix1.5：状态框统一用 formatBizOpReconStatusHtml 写 innerHTML（冒号换行）
      if (statusText) statusText.innerHTML = formatBizOpReconStatusHtml('欢迎使用小助手');
    }

    function applyBizOpReconPanelImportingPreviewState() {
      switchToBizOpReconPanel();
      const importBtn = document.getElementById('bizOpReconImportBtn');
      if (importBtn) importBtn.disabled = false;
      // BU 下拉已有项（模拟导入了 BU-A）
      const buSelect = document.getElementById('bizOpReconBuSelect');
      if (buSelect) {
        buSelect.disabled = false;
        while (buSelect.firstChild) buSelect.removeChild(buSelect.firstChild);
        // v2.1.3-fix2.2：option label 仅 BU 名（去「（N 行）」）
        // v2.1.3-fix2.3：buList 有数据时不留空白 placeholder
        const opt = document.createElement('option');
        opt.value = 'BU-A';
        opt.textContent = 'BU-A';
        opt.selected = true;
        buSelect.appendChild(opt);
        buSelect.value = 'BU-A';
      }
      const statusBox = document.getElementById('bizOpReconStatusBox');
      const statusText = statusBox && statusBox.querySelector('.status-box-text');
      // v2.1.3-fix1.5：状态框统一用 formatBizOpReconStatusHtml（无冒号时无变化）
      if (statusText) statusText.innerHTML = formatBizOpReconStatusHtml('业务OP（2026-05-12 / BU=BU-A）已导入 120 行');
    }

    function applyBizOpReconPanelResultPreviewState() {
      switchToBizOpReconPanel();
      ['bizOpReconImportBtn','bizOpReconRunBtn','bizOpReconExportBtn'].forEach((id) => {
        const b = document.getElementById(id);
        if (b) b.disabled = false;
      });
      const buSelect = document.getElementById('bizOpReconBuSelect');
      if (buSelect) {
        buSelect.disabled = false;
        while (buSelect.firstChild) buSelect.removeChild(buSelect.firstChild);
        // v2.1.3-fix2.2：option label 仅 BU 名（去「（N 行）」）
        // v2.1.3-fix2.3：buList 有数据时不留空白 placeholder
        const opt = document.createElement('option');
        opt.value = 'BU-A';
        opt.textContent = 'BU-A';
        opt.selected = true;
        buSelect.appendChild(opt);
        buSelect.value = 'BU-A';
      }
      const statusBox = document.getElementById('bizOpReconStatusBox');
      const statusText = statusBox && statusBox.querySelector('.status-box-text');
      if (statusText) {
        // v2.1.3-fix1.5：状态框冒号后换行（仅本模块）
        // v2.1.3 round 2 R2-I1：展示 t2 异常账户尾段（仅 > 0 才显示，preview 模拟 1 个 anomaly 账户场景）
        const raw = '2026-05-12 BU=BU-A 对账完成：测算金额差异 3 笔 / T-1 有 T-2 无 1 笔 / T-2 有 T-1 无 1 笔 / 多 OP 账户 2 个 / T-2 异常账户 1 个';
        statusText.innerHTML = formatBizOpReconStatusHtml(raw);
      }
    }

    function applyBizOpReconPanelExportDialogPreviewState() {
      applyBizOpReconPanelResultPreviewState();
      const successDates = [
        { date: '2026-05-12', runId: 1, runAt: '2026-05-13 09:00:00' },
        { date: '2026-05-13', runId: 2, runAt: '2026-05-13 10:00:00' }
      ];
      openModal(createBizOpReconExportDialog({
        successDates,
        onConfirm: () => {},
        onCancel: () => {}
      }));
    }
  }

  global.__rendererDialogs = {
    createRendererDialogs
  };
}(window));
