(function initRendererPreviews(global) {
  function createRendererPreviews(deps) {
    const {
      state,
      elements,
      MODULES,
      ADVANCED_MAPPING_FIELDS,
      BALANCE_CALCULATED_OPTION,
      MERCHANT_ID_SELF_INPUT_OPTION,
      SIGNED_AMOUNT_MAPPING_FIELD,
      AMOUNT_BASED_NAME_MAPPING_FIELD,
      AMOUNT_BASED_ACCOUNT_MAPPING_FIELD,
      setCurrentModule,
      syncNewAccountCurrencyMode,
      updateNewAccountGenerateAvailability,
      setNewAccountExportAvailability,
      setNewAccountStatus,
      setExportAvailability,
      setStatus,
      getNewAccountStatusTitle,
      setNewAccountOpenDateValue,
      openModal,
      createTemplateManagerDialog,
      createMappingDialog,
      createTemplateRenameDialog,
      createBigAccountManagerDialog,
      createBigAccountSelectionDialog,
      // v1.5.3 round 6：补全所有 modal preview 所需 factory
      createMonthlyBalanceExportDialog,
      createManualBalanceSeedDialog,
      createBalanceAddonManagerDialog,
      createExportScopeDialog,
      createAmountSplitRulesDialog,
      createBillSplitRowsDialog,
      createBillSplitMappingsDialog,
      createRememberOrderMismatchDialog,
      createAccountMappingMigrationDialog,
      closeModal,
      openBackgroundPalette,
      // v2.0.0 Pending 模块 preview 所需
      rendererPending,
      createConfirmDialog,
      // 补充的 preview 所需
      openModuleMenu,
      createAccountMappingDialog,
      // v3.0.12 功能2（批A）：账户映射管理弹窗 preview 链路所需 factory
      createFundTransferAccountMappingDialog,
      escapeHtml,
      desktopApi,
      applyStatementResult,
      closeAllNewAccountCurrencyDropdowns,
      // v2.0.0-beta.3 PR #32b：4 类配置弹窗 + 确认详情
      createScenarioConfigDialogC1,
      createScenarioConfigDialogC2,
      createScenarioConfigDialogC3,
      createScenarioConfirmDetailDialog,
      // v2.1.0-beta.1 PR-A（task A7）：C4 类配置弹窗
      createScenarioConfigDialogC4,
      // v2.1.4 T3：小助手功能收纳弹窗工厂
      createModuleCabinetDialog,
      // v3.0.8 需求1：工具箱🧰 主弹框 + 拆表选字段弹框工厂（preview 直接调用）
      createToolboxDialog,
      createSplitFieldPickerDialog,
      // v3.0.1 需求1（D4）：删除网关对账单弹框（🔴 资金红线）preview 直接调用
      createLinkedTableDeleteRangeDialog,
      // v3.0.1 需求3：网关对账单修复场景单选框 preview 直接调用
      createGatewayReconScenarioPickerDialog
    } = deps;

    function applyNewAccountPreviewState() {
      setCurrentModule(MODULES.newAccountGenerator.id);
      elements.newAccountMultiCurrencyCheckbox.checked = false;
      state.selectedNewAccountCurrencies = [];
      syncNewAccountCurrencyMode();
      elements.newAccountBankNameInput.value = '中国银行';
      elements.newAccountLocationInput.value = '香港';
      elements.newAccountCurrencyInput.value = 'USD';
      elements.newAccountBankAccountInput.value = '6222000000000001';
      setNewAccountOpenDateValue('2026-01-01');
      updateNewAccountGenerateAvailability();
      setNewAccountExportAvailability(true);
      setNewAccountStatus('新开账户余额账单可导出', 'success', {
        errorReportReady: false,
        idleTitle: getNewAccountStatusTitle()
      });
    }

    function applyTemplateManagerPreviewState() {
      setCurrentModule(MODULES.statementGenerator.id);
      state.templates = [
        {
          id: 'preview-template-1',
          name: 'LusoBank-MO',
          bigAccountSummary: '来自账单'
        },
        {
          id: 'preview-template-2',
          name: 'BankABC-HK',
          bigAccountSummary: '未设置'
        },
        {
          id: 'preview-template-3',
          name: 'PingPong-US',
          bigAccountSummary: '62220000000000012345'
        },
        {
          id: 'preview-template-4',
          name: 'HSBC-SG',
          bigAccountSummary: '3个'
        }
      ];
      openModal(createTemplateManagerDialog());
    }

    function buildPreviewMappingPayload() {
      return {
        template: {
          id: 'preview-template-4',
          name: 'HSBC-SG',
          headers: [
            '交易日期',
            '起息日期',
            '发生额',
            '余额',
            '对手户名',
            '对手账号',
            '币种',
            '附言'
          ]
        },
        targetFields: [
          'BillDate',
          'ValueDate',
          'Credit Amount',
          'Debit Amount',
          'Balance',
          'MerchantId',
          'Currency',
          'Payee Name',
          'Payee Cardno',
          'Drawee Name',
          'Drawee CardNo',
          SIGNED_AMOUNT_MAPPING_FIELD,
          AMOUNT_BASED_NAME_MAPPING_FIELD,
          AMOUNT_BASED_ACCOUNT_MAPPING_FIELD
        ],
        mappings: [
          { templateField: 'BillDate', mappedField: '交易日期', customValue: '', isMultiBigAccount: false },
          { templateField: 'ValueDate', mappedField: '起息日期', customValue: '', isMultiBigAccount: false },
          { templateField: 'Credit Amount', mappedField: '', customValue: '', isMultiBigAccount: false },
          { templateField: 'Debit Amount', mappedField: '', customValue: '', isMultiBigAccount: false },
          { templateField: 'Balance', mappedField: BALANCE_CALCULATED_OPTION, customValue: '', isMultiBigAccount: false },
          { templateField: 'MerchantId', mappedField: MERCHANT_ID_SELF_INPUT_OPTION, customValue: '', isMultiBigAccount: true },
          { templateField: 'Currency', mappedField: '', customValue: '', isMultiBigAccount: false },
          { templateField: 'Payee Name', mappedField: '', customValue: '', isMultiBigAccount: false },
          { templateField: 'Payee Cardno', mappedField: '', customValue: '', isMultiBigAccount: false },
          { templateField: 'Drawee Name', mappedField: '', customValue: '', isMultiBigAccount: false },
          { templateField: 'Drawee CardNo', mappedField: '', customValue: '', isMultiBigAccount: false },
          { templateField: SIGNED_AMOUNT_MAPPING_FIELD, mappedField: '发生额', customValue: '', isMultiBigAccount: false },
          { templateField: AMOUNT_BASED_NAME_MAPPING_FIELD, mappedField: '对手户名', customValue: '', isMultiBigAccount: false },
          { templateField: AMOUNT_BASED_ACCOUNT_MAPPING_FIELD, mappedField: '对手账号', customValue: '', isMultiBigAccount: false }
        ],
        bigAccounts: [
          {
            merchantId: '6222000000000001',
            currencies: ['USD'],
            isMultiBigAccount: false
          },
          {
            merchantId: '6222000000000001',
            currencies: ['HKD', 'CNY', 'EUR'],
            isMultiBigAccount: true
          }
        ],
        advancedMappingFields: ADVANCED_MAPPING_FIELDS.slice()
      };
    }

    function applyMappingDialogPreviewState() {
      setCurrentModule(MODULES.statementGenerator.id);
      state.currencyOptions = ['USD', 'HKD', 'CNY', 'EUR', 'JPY'];
      openModal(createMappingDialog(buildPreviewMappingPayload()));
    }

    function applyTemplateRenamePreviewState() {
      setCurrentModule(MODULES.statementGenerator.id);
      openModal(createTemplateRenameDialog({
        id: 'preview-template-2',
        name: 'BankABC-HK'
      }));
    }

    function applyBigAccountManagerPreviewState() {
      setCurrentModule(MODULES.statementGenerator.id);
      state.currencyOptions = ['USD', 'HKD', 'CNY', 'EUR', 'JPY'];
      openModal(createBigAccountManagerDialog({
        bigAccounts: [
          {
            merchantId: '6222000000000001',
            currencies: ['USD'],
            isMultiCurrency: false
          },
          {
            merchantId: '6222000000000001',
            currencies: ['HKD', 'CNY', 'EUR', 'JPY'],
            isMultiCurrency: true
          },
          {
            merchantId: '9558800000000008',
            currencies: ['SGD', 'USD'],
            isMultiCurrency: true
          }
        ],
        onDone: () => {},
        onCancel: closeModal
      }));

      setTimeout(() => {
        const addButton = elements.modalRoot.querySelector('.big-account-card [data-action="add"]');
        addButton?.click();
        const rows = Array.from(elements.modalRoot.querySelectorAll('tr[data-big-account-row]'));
        const lastRow = rows[rows.length - 1];
        if (!lastRow) {
          return;
        }

        const merchantInput = lastRow.querySelector('.big-account-merchant-input');
        const currencySelect = lastRow.querySelector('.big-account-currency-select');
        if (merchantInput) {
          merchantInput.value = '8888999900001111';
        }

        if (currencySelect) {
          currencySelect.value = 'USD';
          currencySelect.dispatchEvent(new Event('change'));
        }
      }, 40);
    }

    function applyBigAccountManagerDropdownPreviewState() {
      applyBigAccountManagerPreviewState();

      setTimeout(() => {
        const rows = Array.from(elements.modalRoot.querySelectorAll('tr[data-big-account-row]'));
        const targetRow = rows[1];

        if (!targetRow) {
          return;
        }

        targetRow.querySelector('[data-action="toggle-complete"]')?.click();
        targetRow.querySelector('.big-account-currency-dropdown-btn')?.click();
      }, 160);
    }

    function applyBigAccountSelectionPreviewState() {
      setCurrentModule(MODULES.statementGenerator.id);
      openModal(createBigAccountSelectionDialog([
        {
          label: '6222000000000001 / USD',
          merchantId: '6222000000000001',
          currency: 'USD'
        },
        {
          label: '6222000000000001 / HKD',
          merchantId: '6222000000000001',
          currency: 'HKD'
        },
        {
          label: '9558800000000008 / SGD',
          merchantId: '9558800000000008',
          currency: 'SGD'
        }
      ]));

      setTimeout(() => {
        const firstOption = elements.modalRoot.querySelector('.big-account-selection-list input[type="radio"]');
        if (firstOption) {
          firstOption.checked = true;
        }
      }, 40);
    }

    // v1.5.3 round 6 self-review：补全所有 modal preview（共 9 个）

    // 1. 月度余额账单导出对话框（v1.5.3 R1 新增，资金链路）
    function applyMonthlyBalanceExportDialogPreviewState() {
      setCurrentModule(MODULES.statementGenerator.id);
      // 准备模板下拉数据（实模板列表，下拉显示）
      state.templates = [
        { id: 'preview-template-1', name: 'LusoBank-MO', isParent: false, parentTemplateId: null, bigAccountSummary: '来自账单' },
        { id: 'preview-template-2', name: 'BankABC-HK', isParent: false, parentTemplateId: null, bigAccountSummary: '未设置' },
        { id: 'preview-template-3', name: 'PingPong-US', isParent: false, parentTemplateId: null, bigAccountSummary: '62220000000000012345' },
        { id: 'preview-template-4', name: 'HSBC-SG', isParent: false, parentTemplateId: null, bigAccountSummary: '3个' }
      ];
      openModal(createMonthlyBalanceExportDialog({ onAssembleReady: () => {} }));
    }

    // 2. 余额种子人工录入对话框（v1.5.x，资金链路）
    function applyManualBalanceSeedDialogPreviewState() {
      setCurrentModule(MODULES.statementGenerator.id);
      const prompt = {
        merchantId: '6222000000000001',
        currency: 'USD',
        targetBillDate: '2026-04-01',
        queueIndex: 1,
        queueTotal: 3
      };
      openModal(createManualBalanceSeedDialog(prompt, { billDate: '2026-03-31', endBalance: '12345.67' }));
    }

    // 3. 余额管理（addon manager）对话框（v1.5.x，资金链路）
    function applyBalanceAddonManagerPreviewState() {
      setCurrentModule(MODULES.statementGenerator.id);
      openModal(createBalanceAddonManagerDialog({
        templateName: 'HSBC-SG',
        bigAccounts: [
          { merchantId: '6222000000000001', currencies: ['USD'], isMultiCurrency: false },
          { merchantId: '6222000000000001', currencies: ['HKD'], isMultiCurrency: false },
          { merchantId: '9558800000000008', currencies: ['SGD'], isMultiCurrency: false }
        ],
        onClose: () => {}
      }));
    }

    // 4. 导出范围选择对话框（v1.4.x）
    function applyExportScopeDialogPreviewState() {
      setCurrentModule(MODULES.statementGenerator.id);
      openModal(createExportScopeDialog('detail'));
    }

    // 5. 发生额规则管理对话框（v1.4.9）
    function applyAmountSplitRulesDialogPreviewState() {
      setCurrentModule(MODULES.statementGenerator.id);
      openModal(createAmountSplitRulesDialog({
        template: {
          id: 'preview-template-4',
          name: 'HSBC-SG',
          headers: ['交易日期', '发生额', '余额', '借贷标志', '币种']
        },
        initialRules: [
          { targetField: 'Credit Amount', conditionField: '借贷标志', conditionValue: 'C', mappedField: '发生额', rowIndex: 0 },
          { targetField: 'Debit Amount', conditionField: '借贷标志', conditionValue: 'D', mappedField: '发生额', rowIndex: 1 }
        ],
        context: 'main',
        onDone: () => {},
        onCancel: () => {}
      }));
    }

    // 6. 账单拆分行配置对话框（v1.4.9）
    function applyBillSplitRowsDialogPreviewState() {
      setCurrentModule(MODULES.statementGenerator.id);
      openModal(createBillSplitRowsDialog({
        template: {
          id: 'preview-template-4',
          name: 'HSBC-SG',
          headers: ['交易日期', '币种1', '金额1', '币种2', '金额2', '净额']
        },
        initialRows: [
          {
            seqNo: 1,
            currencySourceField: '币种1',
            creditSourceField: '金额1',
            debitSourceField: '',
            amountSourceField: '',
            rowStatus: 'completed'
          },
          {
            seqNo: 2,
            currencySourceField: '币种2',
            creditSourceField: '金额2',
            debitSourceField: '',
            amountSourceField: '',
            rowStatus: 'completed'
          },
          {
            seqNo: 3,
            currencySourceField: '',
            creditSourceField: '',
            debitSourceField: '',
            amountSourceField: '',
            rowStatus: 'draft'
          }
        ],
        initialAmountRules: [],
        initialBillSplitMeta: { signedAmountSourceField: '净额' },
        onClose: () => {}
      }));
    }

    // 7. 账单拆分映射关系对话框（v1.4.9）
    function applyBillSplitMappingsDialogPreviewState() {
      setCurrentModule(MODULES.statementGenerator.id);
      openModal(createBillSplitMappingsDialog({
        template: {
          id: 'preview-template-4',
          name: 'HSBC-SG',
          headers: ['交易日期', '附言', '发生额', '余额', '对手户名']
        },
        initialMappings: [
          { templateField: 'BillDate', mappedField: '交易日期', mappedFields: [] },
          { templateField: 'Description', mappedField: '附言', mappedFields: [] },
          { templateField: 'Balance', mappedField: BALANCE_CALCULATED_OPTION, mappedFields: [] }
        ],
        mainTemplateMappings: [],
        headers: ['交易日期', '附言', '发生额', '余额', '对手户名'],
        targetFields: [
          'BillDate', 'ValueDate', 'Description', 'Currency',
          'Credit Amount', 'Debit Amount', 'Balance', 'Payee Name', 'Drawee Name',
          ...ADVANCED_MAPPING_FIELDS
        ],
        advancedMappingFields: ADVANCED_MAPPING_FIELDS,
        billSplitGroupFields: ['是否拆分/合并明细账单', '复用模块字段的映射关系'],
        onDone: () => {},
        onCancel: () => {}
      }));
    }

    // 8. 大账号顺序不匹配提示对话框（v1.5.0）
    function applyRememberOrderMismatchDialogPreviewState() {
      setCurrentModule(MODULES.statementGenerator.id);
      openModal(createRememberOrderMismatchDialog({
        message: '已记住的大账号顺序与当前导入文件不匹配（A.xlsx：账户号 6222...01 vs 已记 9558...08），请选择处理方式。',
        bigAccountResult: {
          accounts: [
            { merchantId: '6222000000000001', currency: 'USD' },
            { merchantId: '9558800000000008', currency: 'HKD' }
          ]
        }
      }));
    }

    // 9. 账户映射迁移对话框（v1.5.1）
    function applyAccountMappingMigrationDialogPreviewState() {
      setCurrentModule(MODULES.statementGenerator.id);
      openModal(createAccountMappingMigrationDialog({
        rows: [
          { bankAccountId: '6222000000000001', clearingAccountId: 'CLEAR_001', currency: 'USD' },
          { bankAccountId: '9558800000000008', clearingAccountId: 'CLEAR_002', currency: 'HKD' },
          { bankAccountId: '4567000000000003', clearingAccountId: 'CLEAR_003', currency: 'SGD' }
        ],
        templates: [
          { id: 'preview-template-1', name: 'LusoBank-MO' },
          { id: 'preview-template-2', name: 'BankABC-HK' },
          { id: 'preview-template-4', name: 'HSBC-SG' }
        ],
        onDone: () => {}
      }));
    }

    // ========== v2.0.0 Pending 模块 preview（6 张） ==========

    const PENDING_PREVIEW_COLUMNS = [
      '流水号', '交易日期', '交易时间', '主账户', '子账户', '币种',
      '发生额', '借贷标志', '对方户名', '对方账号', '对方银行',
      '摘要', '凭证号', '交易渠道'
    ];
    const PENDING_PREVIEW_RULE = {
      matchFields: ['交易日期', '主账户', '发生额'],
      compareFields: ['摘要', '对方户名']
    };
    const PENDING_PREVIEW_MONTHS = ['2026-03', '2026-02', '2026-01'];
    const PENDING_PREVIEW_RUNS = [
      {
        id: 2, lowerMonth: '2026-03', upperMonth: '2026-02',
        createdAt: '2026-04-18T14:32:00',
        statNew: 5, statMissing: 3, statChanged: 2,
        ruleSnapshot: PENDING_PREVIEW_RULE
      },
      {
        id: 1, lowerMonth: '2026-02', upperMonth: '2026-01',
        createdAt: '2026-03-15T09:10:00',
        statNew: 8, statMissing: 1, statChanged: 4,
        ruleSnapshot: PENDING_PREVIEW_RULE
      }
    ];

    // 10. Pending 主面板（对账完成态）
    function applyPendingPanelPreviewState() {
      setCurrentModule(MODULES.pendingReconciliation.id);
      state.pending.rule = PENDING_PREVIEW_RULE;
      state.pending.months = PENDING_PREVIEW_MONTHS.slice();
      state.pending.latestRunId = 2;
      state.pending.latestRunResult =
        '对账完成：2026-03 vs 2026-02 找出 10 条差异（5 新增 / 3 消失 / 2 变更），可点击"导出差异"另存。';
      rendererPending.refreshPendingUi();
    }

    // 11. 规则管理对话框
    function applyPendingRuleDialogPreviewState() {
      setCurrentModule(MODULES.pendingReconciliation.id);
      openModal(rendererPending.buildRuleDialogNode({
        columns: PENDING_PREVIEW_COLUMNS,
        currentRule: PENDING_PREVIEW_RULE
      }));
    }

    // 12. 规则确认对话框
    function applyPendingRuleConfirmPreviewState() {
      setCurrentModule(MODULES.pendingReconciliation.id);
      const matchFields = PENDING_PREVIEW_RULE.matchFields;
      const compareFields = PENDING_PREVIEW_RULE.compareFields;
      const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
      const message =
        '<strong>请确认筛选的字段：</strong><br><br>' +
        `<div>对账字段 (${matchFields.length}): ${matchFields.map(esc).join('、')}</div>` +
        `<div>对账内容 (${compareFields.length}): ${compareFields.map(esc).join('、')}</div>`;
      openModal(createConfirmDialog({
        message,
        confirmText: '确认',
        cancelText: '取消',
        onConfirm: () => {}
      }));
    }

    // 13. 导入月份选择
    function applyPendingImportMonthPreviewState() {
      setCurrentModule(MODULES.pendingReconciliation.id);
      openModal(rendererPending.buildImportMonthDialog({
        onConfirm: () => {},
        onCancel: () => {}
      }));
    }

    // 14. 对账月份选择（开始运行）
    function applyPendingReconcilePreviewState() {
      setCurrentModule(MODULES.pendingReconciliation.id);
      openModal(rendererPending.buildReconcileDialog({
        months: PENDING_PREVIEW_MONTHS,
        defaultUpper: '2026-02',
        defaultLower: '2026-03',
        onConfirm: () => {},
        onCancel: () => {}
      }));
    }

    // 15. 导出差异 run 选择
    function applyPendingExportRunsPreviewState() {
      setCurrentModule(MODULES.pendingReconciliation.id);
      openModal(rendererPending.buildExportDialog({
        allRuns: PENDING_PREVIEW_RUNS,
        onConfirm: () => {},
        onCancel: () => {}
      }));
    }

    // ========== 2026-04-24 补：9 张历史遗漏 preview ==========

    // 16. Pending 主面板 · 初始态（未设规则 / 未导入）
    function applyPendingPanelInitialPreviewState() {
      setCurrentModule(MODULES.pendingReconciliation.id);
      state.pending.rule = null;
      state.pending.months = [];
      state.pending.latestRunResult = null;
      state.pending.latestRunId = null;
      rendererPending.refreshPendingUi();
    }

    // 17. Pending 主面板 · 导入中
    function applyPendingPanelImportingPreviewState() {
      setCurrentModule(MODULES.pendingReconciliation.id);
      state.pending.rule = PENDING_PREVIEW_RULE;
      state.pending.months = ['2026-01', '2026-02'];
      state.pending.importing = true;
      state.pending.currentYearMonth = '2026-03';
      state.pending.importingText = '正在导入 2026-03：pending-account-2026-03.xlsx（已处理 123456 行）';
      rendererPending.refreshPendingUi();
    }

    // 18. Pending 主面板 · 报错态（点击导出报错文件）
    function applyPendingPanelErrorPreviewState() {
      setCurrentModule(MODULES.pendingReconciliation.id);
      state.pending.rule = PENDING_PREVIEW_RULE;
      state.pending.errorReportAvailable = true;
      state.pending.errorMessage = '表头字段不一致，请检查并重新导入';
      rendererPending.refreshPendingUi();
    }

    // 19. 顶部模块切换菜单展开态
    function applyModuleSwitcherOpenPreviewState() {
      setCurrentModule(MODULES.statementGenerator.id);
      openModuleMenu();
    }

    // 20. 新开账户 · 多行模式
    function applyNewAccountMultiPreviewState() {
      applyNewAccountPreviewState();
      setTimeout(() => {
        if (!elements.newAccountAddRowBtn) return;
        elements.newAccountAddRowBtn.click();
        setTimeout(() => {
          elements.newAccountAddRowBtn.click();
          setTimeout(() => {
            // 填第 2 行数据以便视觉区分
            const rows = elements.newAccountRows
              ? Array.from(elements.newAccountRows.querySelectorAll('[data-new-account-row="true"]'))
              : [];
            const row2 = rows[1];
            const row3 = rows[2];
            if (row2) {
              const bankInput = row2.querySelector('.new-account-bank-name-input');
              const locInput = row2.querySelector('.new-account-location-input');
              const currencyInput = row2.querySelector('.new-account-currency-input');
              const accountInput = row2.querySelector('.new-account-bank-account-input');
              if (bankInput) bankInput.value = '汇丰银行';
              if (locInput) locInput.value = '新加坡';
              if (currencyInput) currencyInput.value = 'SGD';
              if (accountInput) accountInput.value = '9558800000000008';
            }
            if (row3) {
              const bankInput = row3.querySelector('.new-account-bank-name-input');
              const locInput = row3.querySelector('.new-account-location-input');
              const currencyInput = row3.querySelector('.new-account-currency-input');
              const accountInput = row3.querySelector('.new-account-bank-account-input');
              if (bankInput) bankInput.value = 'PingPong';
              if (locInput) locInput.value = '美国';
              if (currencyInput) currencyInput.value = 'USD';
              if (accountInput) accountInput.value = '4567000000000003';
            }
          }, 40);
        }, 40);
      }, 40);
    }

    // 21. 新开账户 · 币种下拉展开态
    function applyNewAccountCurrencyDropdownPreviewState() {
      applyNewAccountPreviewState();
      setTimeout(() => {
        const dropdownBtn = elements.newAccountCurrencyDropdownBtn;
        if (dropdownBtn) dropdownBtn.click();
      }, 80);
    }

    // 22. 多文件大账号选择对话框（split 双栏模式）
    function applyBigAccountSelectionMultiPreviewState() {
      setCurrentModule(MODULES.statementGenerator.id);
      state.currencyOptions = ['USD', 'HKD', 'CNY', 'EUR', 'JPY', 'SGD'];
      const rows = [
        { index: 0, fileIndex: 0, fileName: 'HSBC-SG-2026-03.xlsx', sourceRowNumber: 1 },
        { index: 1, fileIndex: 1, fileName: 'HSBC-SG-2026-03-block2.xlsx', sourceRowNumber: 1 },
        { index: 2, fileIndex: 2, fileName: 'BankABC-HK-2026-03.xlsx', sourceRowNumber: 1 },
        { index: 3, fileIndex: 3, fileName: 'PingPong-US-2026-03.xlsx', sourceRowNumber: 1 },
        { index: 4, fileIndex: 4, fileName: 'LusoBank-MO-2026-03-verylongfilename-extra.xlsx', sourceRowNumber: 1 }
      ];
      openModal(createBigAccountSelectionDialog({
        rows,
        rowsWithEmptyBlocks: rows,
        expandedBigAccountOptions: [
          { merchantId: '6222000000000001', currency: 'USD' },
          { merchantId: '6222000000000001', currency: 'HKD' },
          { merchantId: '6222000000000001', currency: 'SGD' },
          { merchantId: '9558800000000008', currency: 'SGD' },
          { merchantId: '9558800000000008', currency: 'USD' },
          { merchantId: '4567000000000003', currency: 'USD' }
        ],
        templateId: 'preview-template-4',
        templateName: 'HSBC-SG',
        canRemember: true,
        onDone: () => {},
        onCancel: closeModal
      }));
    }

    // v2.1.7 round 3 B4（spec §9.5.2）：≥20 文件 fixture 复现"滚动条不可用"
    //   构造 20 文件 + 8 大账号；高度链：.ba-scroll-container max-height 52vh
    //   若 R6c B3 之后仍发现 ≥20 文件 无滚动条，dev 阶段在此 preview 上 DevTools 调试
    function applyBigAccountSelectionMultiLargePreviewState() {
      setCurrentModule(MODULES.statementGenerator.id);
      state.currencyOptions = ['USD', 'HKD', 'CNY', 'EUR', 'JPY', 'SGD'];
      const rows = [];
      for (let i = 0; i < 20; i++) {
        rows.push({
          index: i,
          fileIndex: i,
          fileName: `HSBC-SG-2026-03-batch${String(i).padStart(2, '0')}.xlsx`,
          sourceRowNumber: 1
        });
      }
      openModal(createBigAccountSelectionDialog({
        rows,
        rowsWithEmptyBlocks: rows,
        expandedBigAccountOptions: [
          { merchantId: '6222000000000001', currency: 'USD' },
          { merchantId: '6222000000000001', currency: 'HKD' },
          { merchantId: '6222000000000001', currency: 'SGD' },
          { merchantId: '9558800000000008', currency: 'SGD' },
          { merchantId: '9558800000000008', currency: 'USD' },
          { merchantId: '4567000000000003', currency: 'USD' },
          { merchantId: '4567000000000003', currency: 'HKD' },
          { merchantId: '7777000000000007', currency: 'CNY' }
        ],
        templateId: 'preview-template-4',
        templateName: 'HSBC-SG',
        canRemember: true,
        onDone: () => {},
        onCancel: closeModal
      }));
    }

    // 23. "确认大账号顺序" 对话框（extract-order-card）
    //     直接手搓 DOM（showExtractDialog 是 createBigAccountSelectionDialog 内部闭包，
    //     无法从外部调用；视觉 class 名保持与实际实现一致即可）
    function applyExtractOrderPreviewState() {
      // v2.1.7 round 3 B3（spec §9.4.2 方案 A）：preview DOM 同步切到单 grid 范式
      //   - col-header 跨 grid 第 1 / 2 列（sticky）
      //   - max(N, M) 循环，每对 [leftCell, rightCell] append 到 .extract-order-body
      setCurrentModule(MODULES.statementGenerator.id);
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      const dialog = document.createElement('div');
      dialog.className = 'modal-card extract-order-card';
      dialog.innerHTML = `
        <div class="dialog-header">
          <div class="dialog-title">确认大账号顺序</div>
          <button class="icon-close extract-close-btn" type="button" style="margin-left:auto;">×</button>
        </div>
        <div class="extract-order-body">
          <div class="extract-order-col-header">文件顺序</div>
          <div class="extract-order-col-header">大账号信息</div>
          <!-- 每行 = [leftCell, rightCell] 一对，JS 循环 append -->
        </div>
        <div class="dialog-actions right">
          <button class="primary-btn small" type="button" data-action="extract-done">完成</button>
        </div>
      `;
      overlay.appendChild(dialog);

      const body = dialog.querySelector('.extract-order-body');
      const fileRows = [
        'HSBC-SG-2026-03.xlsx',
        'HSBC-SG-2026-03-block2.xlsx',
        'BankABC-HK-2026-03.xlsx',
        'PingPong-US-2026-03.xlsx'
      ];
      const extracted = [
        { merchantId: '6222000000000001', currency: 'USD' },
        { merchantId: '6222000000000001', currency: 'HKD' },
        { merchantId: '9558800000000008', currency: 'SGD' },
        { merchantId: '4567000000000003', currency: 'USD' }
      ];
      const maxRows = Math.max(fileRows.length, extracted.length);
      for (let i = 0; i < maxRows; i++) {
        // 左 cell
        const leftCell = document.createElement('div');
        leftCell.className = 'extract-order-row';
        const fileName = fileRows[i];
        if (fileName) {
          leftCell.innerHTML =
            `<span class="eo-idx">${i + 1}.</span>` +
            `<span class="eo-name" title="${fileName}">${fileName}</span>` +
            `<span></span>`;
        } else {
          leftCell.classList.add('extract-order-row--empty');
        }
        body.appendChild(leftCell);

        // 右 cell
        const rightCell = document.createElement('div');
        rightCell.className = 'extract-order-row';
        const account = extracted[i];
        if (account) {
          const indexSpan = document.createElement('span');
          indexSpan.className = 'eo-idx';
          indexSpan.textContent = `${i + 1}.`;
          const textSpan = document.createElement('span');
          textSpan.className = 'eo-name';
          textSpan.textContent = `${account.merchantId} ${account.currency}`;
          const editBtn = document.createElement('button');
          editBtn.className = 'text-action eo-edit';
          editBtn.type = 'button';
          editBtn.textContent = '编辑';
          rightCell.append(indexSpan, textSpan, editBtn);
        } else {
          rightCell.classList.add('extract-order-row--empty');
        }
        body.appendChild(rightCell);
      }
      openModal(overlay);
    }

    // 24. 账户映射对话框 · 编辑行态
    function applyAccountMappingEditingPreviewState() {
      setCurrentModule(MODULES.statementGenerator.id);
      state.currencyOptions = ['USD', 'HKD', 'CNY', 'EUR'];
      state.templates = [
        { id: 'preview-template-4', name: 'HSBC-SG', isParent: false, parentTemplateId: null, bigAccountSummary: '3个' }
      ];
      openModal(createAccountMappingDialog({
        templates: state.templates,
        selectedTemplateId: 'preview-template-4',
        mappings: [
          { bankAccountId: '6222000000000001', clearingAccountId: 'CLEAR_001', currency: 'USD', noCurrency: false },
          { bankAccountId: '9558800000000008', clearingAccountId: 'CLEAR_002', currency: 'HKD', noCurrency: false },
          { bankAccountId: '4567000000000003', clearingAccountId: 'CLEAR_003', currency: '', noCurrency: true }
        ],
        onDone: () => {},
        onCancel: closeModal
      }));
      setTimeout(() => {
        const editBtn = elements.modalRoot.querySelector('.account-mapping-action-cell .text-action');
        if (editBtn) editBtn.click();
      }, 120);
    }

    // v3.0.12 功能2（批A）：账户映射管理弹窗 preview（「链接表管理」左下角入口打开的全局对照表弹窗）。
    //   弹窗自管 overlay（createOverlay 返回 .modal-overlay）；openModal 先清 modalRoot 再挂这层 overlay = 单层无双壳。
    //   打开即异步拉列表（preview 临时库为空 → 渲染空表 + 末行「新增」+ 三列表头「中台调拨单账户号/清结算系统银行账号/执行操作」）。
    function applyFundTransferAccountMappingPreviewState() {
      setCurrentModule(MODULES.bankStatementProcess.id);
      openModal(createFundTransferAccountMappingDialog());
    }

    // v2.0.0-beta.3：银行对账单处理模块主面板
    function applyBankStatementPanelPreviewState() {
      setCurrentModule(MODULES.bankStatementProcess.id);
    }

    // v2.0.0-beta.3：场景管理弹窗（含 3 内置场景）
    // v3.0.8 需求2（W6）：默认打开即两组三角折叠收纳态（▶ 资金性质校验 / ▶ 中台订单数据处理）+ C3 已退役不显示。
    function applyScenariosManagerPreviewState() {
      setCurrentModule(MODULES.bankStatementProcess.id);
      setTimeout(() => {
        if (elements.bankStatementScenarioBtn) {
          elements.bankStatementScenarioBtn.click();
        }
      }, 120);
    }

    // v2.1.16 A1：自带写死场景「管理」弹窗 preview（含优先级输入框）。
    //   切到资金对账模块 → 打开场景管理 → 点 builtin-fixed 行的「管理」按钮 → 打开适用银行渠道 + 优先级弹窗。
    //   依赖：迁移 seed 的 builtin-fixed 场景（migrations.js 启动幂等 seed），preview 临时库也会有该行。
    function applyBuiltinFixedChannelManagePreviewState() {
      setCurrentModule(MODULES.bankStatementProcess.id);
      setTimeout(() => {
        if (!elements.bankStatementScenarioBtn) return;
        elements.bankStatementScenarioBtn.click();
        setTimeout(() => {
          const manageBtn = elements.modalRoot
            ? elements.modalRoot.querySelector('tr[data-category="builtin-fixed"] [data-row-action="manage"]')
            : null;
          if (manageBtn) manageBtn.click();
        }, 240);
      }, 120);
    }

    // v3.0.4 块 F · F1：「Payment线下调拨订单回填处理」展开态 preview。
    //   切到资金对账模块 → 打开场景管理 → 定位「中台调拨订单对账ID回填」（subCategory=fund-transfer-backfill）行
    //   的「管理」按钮 → 打开适用银行渠道弹窗（gating 显示 payment 勾选行）→ 勾选并填三输入框 → 截图展开态。
    //   依赖：migrations.js seed 的 R5s2 builtin-fixed 场景（preview 临时库幂等 seed 也会有该行）。
    function applyBuiltinFixedChannelManagePaymentPreviewState() {
      setCurrentModule(MODULES.bankStatementProcess.id);
      setTimeout(() => {
        if (!elements.bankStatementScenarioBtn) return;
        elements.bankStatementScenarioBtn.click();
        setTimeout(() => {
          const root = elements.modalRoot;
          if (!root) return;
          // 按场景名称列定位「中台调拨订单对账ID回填」行（builtin-fixed + fund-transfer-backfill）
          let targetManageBtn = null;
          root.querySelectorAll('tr[data-category="builtin-fixed"]').forEach((tr) => {
            const nameCell = tr.querySelector('.scenarios-col-name');
            if (nameCell && nameCell.textContent.includes('中台调拨订单对账ID回填')) {
              targetManageBtn = tr.querySelector('[data-row-action="manage"]');
            }
          });
          if (!targetManageBtn) return;
          targetManageBtn.click();
          // 弹窗加载 config 是异步（scenarios.get）→ 等加载完成（payment 行 gating 显示）后再勾选 + 填值
          setTimeout(() => {
            const dialogRoot = elements.modalRoot;
            if (!dialogRoot) return;
            const check = dialogRoot.querySelector('input[data-field="payment-offline-enabled"]');
            if (check && !check.checked) {
              check.checked = true;
              check.dispatchEvent(new Event('change', { bubbles: true }));
            }
            const bankInput = dialogRoot.querySelector('input[data-field="payment-bank-channel"]');
            const regionInput = dialogRoot.querySelector('input[data-field="payment-region"]');
            const bigAccountInput = dialogRoot.querySelector('input[data-field="payment-big-account"]');
            if (bankInput) bankInput.value = 'BGL';
            if (regionInput) regionInput.value = 'CN';
            if (bigAccountInput) bigAccountInput.value = '202782001';
          }, 360);
        }, 280);
      }, 120);
    }

    // v2.1.14 C：链接表管理弹窗 preview（切到资金对账数据处理模块 → 点「链接表管理」按钮打开弹窗）
    function applyLinkedTableManagerPreviewState() {
      setCurrentModule(MODULES.bankStatementProcess.id);
      setTimeout(() => {
        if (elements.bankStatementLinkedTableBtn) {
          elements.bankStatementLinkedTableBtn.click();
        }
      }, 120);
    }

    // v3.0.14：临时链接表管理首页 preview。复用正式入口，并填入稳定样例日期避免依赖本机临时库。
    function applyPreFundTempManagerPreviewState() {
      setCurrentModule(MODULES.preFundReconciliation.id);
      setTimeout(() => {
        if (!elements.preFundReconciliationTempManagerBtn) return;
        elements.preFundReconciliationTempManagerBtn.click();
        setTimeout(() => {
          const root = elements.modalRoot;
          if (!root) return;
          const rows = root.querySelectorAll('tbody tr[data-source-type]');
          const previewValues = [
            ['2026-07-08 ~ 2026-07-09', '2026-07-10'],
            ['2026-07-07 ~ 2026-07-08', '2026-07-11']
          ];
          rows.forEach((row, index) => {
            const values = previewValues[index];
            if (!values) return;
            const rangeCell = row.querySelector('.linked-table-col-range');
            const updatedCell = row.querySelector('.linked-table-col-updated');
            if (rangeCell) rangeCell.textContent = values[0];
            if (updatedCell) updatedCell.textContent = values[1];
          });
        }, 160);
      }, 120);
    }

    // v3.0.16：临时 MPT 明细错误失败页 preview，验证三操作按钮及长文案布局。
    function applyPreFundTempImportFailurePreviewState() {
      setCurrentModule(MODULES.preFundReconciliation.id);
      setTimeout(() => {
        openModal(createConfirmDialog({
          message: '成功导入 <b>1</b> 张，失败 <b>2</b> 张<br/><br/>'
            + '失败：<br/>• MPT_INBOUND_GATEWAY_20260708_001.gz：包含 3 条可定位明细错误<br/>'
            + '• MPT_OUTBOUND_GATEWAY_20260708_002.gz：包含 1 条可定位明细错误<br/><br/>'
            + '其中 <b>2</b> 张文件可导出错误数据，或逻辑删除错误行后重跑。',
          confirmText: '删除错误数据并重跑',
          middleText: '导出错误数据',
          cancelText: '关闭'
        }));
      }, 120);
    }

    // v3.0.14：临时链接表按日期删除框 preview，使用与既有链接表删除框相同的已填日期状态。
    function applyPreFundTempDeleteRangePreviewState() {
      setCurrentModule(MODULES.preFundReconciliation.id);
      setTimeout(() => {
        if (!elements.preFundReconciliationTempManagerBtn) return;
        elements.preFundReconciliationTempManagerBtn.click();
        setTimeout(() => {
          const deleteBtn = elements.modalRoot && elements.modalRoot.querySelector('[data-action="delete"]');
          if (!deleteBtn) return;
          deleteBtn.click();
          setTimeout(() => {
            const root = elements.modalRoot;
            if (!root) return;
            const startInput = root.querySelector('[data-role="start"]');
            const endInput = root.querySelector('[data-role="end"]');
            const confirmBtn = root.querySelector('[data-action="confirm-delete"]');
            if (startInput) startInput.value = '2026-07-01';
            if (endInput) endInput.value = '2026-07-31';
            if (confirmBtn) confirmBtn.disabled = false;
          }, 120);
        }, 120);
      }, 120);
    }

    // v3.0.1 需求1（D4）：删除网关对账单弹框 preview（🔴 资金红线）。
    //   直接 openModal 删除弹框，填入示例日期范围并启用「删除」，截图体现「已填日期 → 删除可点」交互态。
    //   注：弹框的红色警告框 + 「将删约 N 行」计数显示已按用户 UI 迭代去掉（见 createLinkedTableDeleteRangeDialog），
    //   preview 直接写 DOM 置删除按钮可用态（contextBridge 暴露的 desktopApi 已冻结，无法 mock 计数接口）。
    function applyLinkedTableDeleteRangePreviewState() {
      setCurrentModule(MODULES.bankStatementProcess.id);
      setTimeout(() => {
        openModal(createLinkedTableDeleteRangeDialog());
        setTimeout(() => {
          const root = elements.modalRoot;
          if (!root) return;
          const startInput = root.querySelector('[data-role="start"]');
          const endInput = root.querySelector('[data-role="end"]');
          const confirmBtn = root.querySelector('[data-action="confirm-delete"]');
          if (startInput) startInput.value = '2026-05-01';
          if (endInput) endInput.value = '2026-05-31';
          // v3.0.1（用户调整）：红框 + 「将删约 N 行」计数已去掉，preview 直接置删除按钮可用态。
          if (confirmBtn) confirmBtn.disabled = false;
        }, 120);
      }, 120);
    }

    // v3.0.1 需求3：网关对账单修复场景单选框 preview（多场景示例，便于截图体现单选样式）。
    function applyGatewayReconScenarioPickerPreviewState() {
      setCurrentModule(MODULES.bankStatementProcess.id);
      setTimeout(() => {
        openModal(createGatewayReconScenarioPickerDialog({
          scenarios: [
            { id: 1, name: '场景示例 A' },
            { id: 2, name: '场景示例 B' },
            { id: 3, name: '场景示例 C' }
          ],
          onPick: () => {}
        }));
      }, 120);
    }

    // v2.0.0-beta.3：类别选择弹窗
    function applyScenarioCategorySelectPreviewState() {
      setCurrentModule(MODULES.bankStatementProcess.id);
      setTimeout(() => {
        if (elements.bankStatementScenarioBtn) {
          elements.bankStatementScenarioBtn.click();
          setTimeout(() => {
            const addBtn = elements.modalRoot
              ? elements.modalRoot.querySelector('[data-action="add-scenario"]')
              : null;
            if (addBtn) addBtn.click();
          }, 240);
        }
      }, 120);
    }

    // v2.0.0-beta.3 PR #32b：4 类配置弹窗 + 确认详情 preview
    // v2.1.7 F1：默认无 conditionsLogic 字段 → dialog 渲染 OR radio 默认选中（fallback 行为 baseline）
    function applyScenarioConfigC1PreviewState() {
      setCurrentModule(MODULES.bankStatementProcess.id);
      state.scenarioDraft = {
        mode: 'create',
        category: 'extract-recon-id',
        scenarioId: null,
        name: '从银行对账单的信息里提取调拨订单对账ID',
        priority: 3,
        config: {
          conditions: [
            { field: 'CustomerRef', op: '包含', value: 'AFT' },
            { field: 'Extra Information', op: '包含', value: 'AFT' }
          ],
          extractByFeature: {
            enabled: true,
            searchFields: ['CustomerRef', 'Extra Information'],
            featureCode: 'FT',
            digitCount: 12,
            totalLength: 15
          },
          extractByOtherField: null
        }
      };
      setTimeout(() => {
        openModal(createScenarioConfigDialogC1());
      }, 120);
    }

    // v2.1.7 F1：C1 dialog AND 模式 preview（conditionsLogic='AND' 显式注入，截图验证 AND radio 选中）
    function applyScenarioConfigC1AndPreviewState() {
      setCurrentModule(MODULES.bankStatementProcess.id);
      state.scenarioDraft = {
        mode: 'create',
        category: 'extract-recon-id',
        scenarioId: null,
        name: '从银行对账单的信息里提取调拨订单对账ID（AND）',
        priority: 3,
        config: {
          conditions: [
            { field: 'CustomerRef', op: '包含', value: 'AFT' },
            { field: 'Extra Information', op: '包含', value: 'AFT' }
          ],
          conditionsLogic: 'AND',
          extractByFeature: {
            enabled: true,
            searchFields: ['CustomerRef', 'Extra Information'],
            featureCode: 'FT',
            digitCount: 12,
            totalLength: 15
          },
          extractByOtherField: null
        }
      };
      setTimeout(() => {
        openModal(createScenarioConfigDialogC1());
      }, 120);
    }

    function applyScenarioConfigC2PreviewState() {
      setCurrentModule(MODULES.bankStatementProcess.id);
      // v2.1.11 T3（spec §4.1 D-T3-1a=AND）：billTypes 改多条件 conditions 结构
      //   类型 #1 演示「多条件 AND」（FundType=outbound Fail 且 Currency=USD），类型 #2 单条件
      //   FundType 字段值在弹窗内会渲染为严格枚举下拉（来自 assets/FundType枚举值.xlsx，经 IPC 拉取）
      state.scenarioDraft = {
        mode: 'create',
        category: 'offset-bill-mark',
        scenarioId: null,
        name: 'outbound改标为outbound Fail',
        priority: 2,
        config: {
          billTypes: [
            { seq: 1, conditions: [
              { field: 'FundType', op: '等于', value: 'outbound Fail' },
              { field: 'Currency', op: '等于', value: 'USD' }
            ] },
            { seq: 2, conditions: [
              { field: 'FundType', op: '等于', value: 'outbound' }
            ] }
          ],
          reconFields: [
            { seq: 1, leftType: 1, leftField: 'CustomerRef', rightType: 2, rightField: 'CustomerRef' },
            { seq: 2, leftType: 1, leftField: 'Credit Amount', rightType: 2, rightField: 'Debit Amount' }
          ],
          markValue: { type: 2, field: 'FundType', value: 'outbound Fail' }
        }
      };
      setTimeout(() => {
        openModal(createScenarioConfigDialogC2());
      }, 120);
    }

    function applyScenarioConfigC3PreviewState() {
      setCurrentModule(MODULES.bankStatementProcess.id);
      state.scenarioDraft = {
        mode: 'create',
        category: 'gateway-recon-join',
        scenarioId: null,
        name: '与网关对账单根据金额币种一对一匹配对账ID',
        priority: 1,
        config: {
          // v2.1.5 fix1.1 self-review I1：注入 ≥ 2 行 conditions（含网关 + 银行 + 超长字段 +
          //   '非空值' op 用于验证 value 输入框隐藏），可视化验证 fix1.1 的列宽固定效果
          conditions: [
            { side: '网关', field: 'Type(0:1对1,1:1对多,2:多对1,3:多对1（轧差合并)', op: '等于', value: '0' },
            { side: '银行', field: 'Currency', op: '等于', value: 'USD' },
            { side: '网关', field: 'reconciliationId', op: '非空值', value: '' }
          ],
          reconFields: [
            { seq: 1, gwField: 'Currency', bankField: 'Currency' },
            { seq: 2, gwField: 'Amount', bankField: '发生额绝对值' },
            { seq: 3, gwField: 'MerchantId', bankField: 'MerchantId' },
            { seq: 4, gwField: 'Bank', bankField: 'Channel' }
          ],
          assign: { gwField: 'reconciliationId', bankField: 'ReconciliationId' }
        }
      };
      setTimeout(() => {
        openModal(createScenarioConfigDialogC3());
      }, 120);
    }

    // v2.1.8 N2：C3 dialog mode='custom' 自取值视觉状态
    //   gwField='__CUSTOM__' + customValue 静态字符串 → assign-gw 右侧 input 显示
    function applyScenarioConfigC3CustomPreviewState() {
      setCurrentModule(MODULES.bankStatementProcess.id);
      state.scenarioDraft = {
        mode: 'create',
        category: 'gateway-recon-join',
        scenarioId: null,
        name: 'N2 自取值 demo — 写入静态对账号',
        priority: 1,
        config: {
          conditions: [
            { side: '网关', field: 'Bank', op: '等于', value: 'JPM' }
          ],
          reconFields: [
            { seq: 1, gwField: 'Currency', bankField: 'Currency' },
            { seq: 2, gwField: 'Amount', bankField: '发生额绝对值' }
          ],
          assign: {
            gwField: '__CUSTOM__',
            bankField: 'ReconciliationId',
            mode: 'custom',
            customValue: 'AUTO-GEN-RECON-20260526'
          }
        }
      };
      setTimeout(() => {
        openModal(createScenarioConfigDialogC3());
      }, 120);
    }

    function applyScenarioConfirmDetailPreviewState() {
      setCurrentModule(MODULES.bankStatementProcess.id);
      // 预填 C1 配置然后进入确认详情
      state.scenarioDraft = {
        mode: 'create',
        category: 'extract-recon-id',
        scenarioId: null,
        name: '从银行对账单的信息里提取调拨订单对账ID',
        priority: 3,
        config: {
          conditions: [
            { field: 'CustomerRef', op: '包含', value: 'AFT' },
            { field: 'Extra Information', op: '包含', value: 'BFT' }
          ],
          extractByFeature: {
            enabled: true,
            searchFields: ['CustomerRef', 'Extra Information', 'Payment Detail'],
            featureCode: 'FT',
            digitCount: 12,
            totalLength: 15
          },
          extractByOtherField: null
        }
      };
      setTimeout(() => {
        openModal(createScenarioConfirmDetailDialog());
      }, 120);
    }

    // ===== v2.1.0-beta.1 PR-A：单据对账 ReconID 修复模块 preview =====
    // task A3：主面板 preview（默认空场景态）
    function applyReconIdFixPanelPreviewState() {
      setCurrentModule(MODULES.reconIdFix.id);
    }

    // v2.1.0-beta.3 T11：主面板 preview — 账单类别选定 gateway（行 2 wrapper 显示）
    function applyReconIdFixPanelGatewayPreviewState() {
      setCurrentModule(MODULES.reconIdFix.id);
      state.reconIdFixBillCategory = 'gateway';
      if (elements.reconIdFixBillCategorySelect) {
        elements.reconIdFixBillCategorySelect.value = 'gateway';
      }
      if (typeof updateReconIdFixPanelVisibility === 'function') {
        updateReconIdFixPanelVisibility();
      }
    }

    // v2.1.0-beta.3 T11：主面板 preview — 账单类别选定 business（行 2 wrapper 显示）
    function applyReconIdFixPanelBusinessPreviewState() {
      setCurrentModule(MODULES.reconIdFix.id);
      state.reconIdFixBillCategory = 'business';
      if (elements.reconIdFixBillCategorySelect) {
        elements.reconIdFixBillCategorySelect.value = 'business';
      }
      if (typeof updateReconIdFixPanelVisibility === 'function') {
        updateReconIdFixPanelVisibility();
      }
    }

    // task A7：C4 配置弹窗 preview — create 模式（默认 1 主 1 从两类）
    function applyScenarioConfigC4PreviewState() {
      setCurrentModule(MODULES.reconIdFix.id);
      state.scenarioDraft = {
        mode: 'create',
        category: 'recon-id-fix',
        scenarioId: null,
        name: '示例：业务订单 vs rcpt_inbound（主从一对一）',
        priority: 0,
        config: {
          matchRules: { oneToOne: true, oneToMany: false, manyToOne: false },
          billTypes: [
            { seq: 1, side: 'main', conditions: [{ field: 'BillType', op: '等于', value: '业务订单' }] },
            { seq: 2, side: 'opp', conditions: [{ field: 'OriginBillSource', op: '等于', value: 'rcpt_inbound' }] }
          ],
          reconFields: [
            { seq: 1, leftTypeSeq: 1, leftField: 'Currency', rightTypeSeq: 2, rightField: 'Currency' },
            { seq: 2, leftTypeSeq: 1, leftField: 'Amount', rightTypeSeq: 2, rightField: 'Amount' }
          ],
          output: {
            mode: 'main',
            commonId: { source: 'main', suffix: '' },
            subBizType: { mode: 'auto', mainValue: '', oppValue: '' }
          }
        }
      };
      setTimeout(() => {
        openModal(createScenarioConfigDialogC4());
      }, 120);
    }

    // v2.1.0-beta.3 T11：C4 dialog preview — gateway 子模式 默认态
    function applyScenarioConfigC4GatewayPreviewState() {
      setCurrentModule(MODULES.reconIdFix.id);
      state.reconIdFixBillCategory = 'gateway';
      state.scenarioDraft = {
        mode: 'create',
        category: 'gateway-recon-id-fix',
        scenarioId: null,
        name: '示例：网关 vs 渠道（1v1）',
        priority: 0,
        config: {
          matchRules: { oneToOne: true, oneToMany: false, manyToOne: false },
          billTypes: [
            { seq: 1, side: 'main', conditions: [{ field: 'BillType', op: '等于', value: '网关订单' }] },
            { seq: 2, side: 'opp', conditions: [{ field: 'channelName', op: '等于', value: 'CH001' }] }
          ],
          reconGroups: [
            {
              leftTypeSeq: 1,
              rightTypeSeq: 2,
              fieldPairs: [
                { leftField: 'Amount', rightField: 'receiveAmount', locked: true }
              ]
            }
          ],
          output: {
            mode: 'main',
            commonId: { source: 'main', suffix: '' },
            subBizType: { mode: 'auto', mainValue: '', oppValue: '' }
          }
        }
      };
      setTimeout(() => {
        openModal(createScenarioConfigDialogC4());
      }, 120);
    }

    // v2.1.0-beta.3 T11：C4 dialog preview — gateway 子模式 勾选 1v多 → "网关账单" radio 禁用
    function applyScenarioConfigC4Gateway1vNPreviewState() {
      setCurrentModule(MODULES.reconIdFix.id);
      state.reconIdFixBillCategory = 'gateway';
      state.scenarioDraft = {
        mode: 'create',
        category: 'gateway-recon-id-fix',
        scenarioId: null,
        name: '示例：网关 1 v 多 渠道（"网关账单"选项禁用）',
        priority: 0,
        config: {
          matchRules: { oneToOne: false, oneToMany: true, manyToOne: false },
          billTypes: [
            { seq: 1, side: 'main', conditions: [{ field: 'BillType', op: '等于', value: '网关订单' }] },
            { seq: 2, side: 'opp', conditions: [{ field: 'channelName', op: '等于', value: 'CH001' }] }
          ],
          reconGroups: [
            {
              leftTypeSeq: 1,
              rightTypeSeq: 2,
              fieldPairs: [
                { leftField: 'Amount', rightField: 'receiveAmount', locked: true }
              ]
            }
          ],
          output: {
            // 1v多 时 main 被禁用，默认切到 opp
            mode: 'opp',
            commonId: { source: 'main', suffix: '' },
            subBizType: { mode: 'auto', mainValue: '', oppValue: '' }
          }
        }
      };
      setTimeout(() => {
        openModal(createScenarioConfigDialogC4());
      }, 120);
    }

    // task A7：C4 配置弹窗 preview — 主从都修复 + commonId 拼接
    function applyScenarioConfigC4BothPreviewState() {
      setCurrentModule(MODULES.reconIdFix.id);
      state.scenarioDraft = {
        mode: 'create',
        category: 'recon-id-fix',
        scenarioId: null,
        name: '示例：主从都修复 + 共同 ID 后缀-FIX',
        priority: 0,
        config: {
          matchRules: { oneToOne: true, oneToMany: false, manyToOne: false },
          billTypes: [
            { seq: 1, side: 'main', conditions: [{ field: 'BillType', op: '等于', value: '业务订单' }] },
            { seq: 2, side: 'opp', conditions: [{ field: 'OriginBillSource', op: '等于', value: 'rcpt_inbound' }] }
          ],
          reconFields: [
            { seq: 1, leftTypeSeq: 1, leftField: 'Currency', rightTypeSeq: 2, rightField: 'Currency' },
            { seq: 2, leftTypeSeq: 1, leftField: 'Amount', rightTypeSeq: 2, rightField: 'Amount' }
          ],
          output: {
            mode: 'both',
            commonId: { source: 'main', suffix: '-FIX' },
            subBizType: { mode: 'auto', mainValue: '', oppValue: '' }
          }
        }
      };
      setTimeout(() => {
        openModal(createScenarioConfigDialogC4());
      }, 120);
    }

    // v2.1.4 T3：小助手功能收纳弹窗 preview（默认 3 启用 + 4 闲置，闲置区按视觉宽度升序，详见工厂内 visualLength helper）
    // round 1 self-review M2：原注释 "name.length 升序" stale（Fix1.5 已改视觉宽度），更新口径
    function applyModuleCabinetPreviewState() {
      setCurrentModule(MODULES.statementGenerator.id);
      setTimeout(() => {
        openModal(createModuleCabinetDialog({
          enabledModules: ['statement-generator', 'bank-statement-process', 'recon-id-fix'],
          allModules: Object.values(MODULES),
          onCommit: async () => true  // preview 不真正落库
        }));
      }, 120);
    }

    // v3.0.8 需求1：工具箱🧰 主弹框 preview（合并表格行 + 拆分表格行；拆分行 [导出文件] 默认禁用）
    function applyToolboxPreviewState() {
      setCurrentModule(MODULES.statementGenerator.id);
      setTimeout(() => {
        openModal(createToolboxDialog());
      }, 120);
    }

    // v3.0.8 需求1：拆表选字段弹框 preview（字段单选 + 值多选，演示典型表头与去重值）
    //   onComplete/onCancel preview 不真正回流（仅截图）。
    function applyToolboxSplitFieldPickerPreviewState() {
      setCurrentModule(MODULES.statementGenerator.id);
      setTimeout(() => {
        openModal(createSplitFieldPickerDialog({
          headers: ['交易日期', '币种', '对手账号', '摘要'],
          valuesByField: {
            交易日期: ['2026-06-01', '2026-06-02', '2026-06-03'],
            币种: ['USD', 'HKD', 'CNY'],
            对手账号: ['6222000000000001', '6222000000000002'],
            摘要: []  // 边界①：空值字段 → 多选框空且禁用
          },
          onComplete: () => {},
          onCancel: () => {}
        }));
      }, 120);
    }

    return {
      applyNewAccountPreviewState,
      applyTemplateManagerPreviewState,
      buildPreviewMappingPayload,
      applyMappingDialogPreviewState,
      applyTemplateRenamePreviewState,
      applyBigAccountManagerPreviewState,
      applyBigAccountManagerDropdownPreviewState,
      applyBigAccountSelectionPreviewState,
      // v1.5.3 round 6：补全的 9 个 modal preview
      applyMonthlyBalanceExportDialogPreviewState,
      applyManualBalanceSeedDialogPreviewState,
      applyBalanceAddonManagerPreviewState,
      applyExportScopeDialogPreviewState,
      applyAmountSplitRulesDialogPreviewState,
      applyBillSplitRowsDialogPreviewState,
      applyBillSplitMappingsDialogPreviewState,
      applyRememberOrderMismatchDialogPreviewState,
      applyAccountMappingMigrationDialogPreviewState,
      // v2.0.0 Pending 模块 preview（6 张）
      applyPendingPanelPreviewState,
      applyPendingRuleDialogPreviewState,
      applyPendingRuleConfirmPreviewState,
      applyPendingImportMonthPreviewState,
      applyPendingReconcilePreviewState,
      applyPendingExportRunsPreviewState,
      // 2026-04-24 补：9 张历史遗漏 preview
      applyPendingPanelInitialPreviewState,
      applyPendingPanelImportingPreviewState,
      applyPendingPanelErrorPreviewState,
      applyModuleSwitcherOpenPreviewState,
      applyNewAccountMultiPreviewState,
      applyNewAccountCurrencyDropdownPreviewState,
      applyBigAccountSelectionMultiPreviewState,
      applyBigAccountSelectionMultiLargePreviewState,   // v2.1.7 round 3 B4
      applyExtractOrderPreviewState,
      applyAccountMappingEditingPreviewState,
      // v3.0.12 功能2（批A）：账户映射管理弹窗 preview
      applyFundTransferAccountMappingPreviewState,
      // v2.0.0-beta.3：银行对账单处理模块 preview（3 张）
      applyBankStatementPanelPreviewState,
      applyScenariosManagerPreviewState,
      // v2.1.16 A1：自带写死场景「管理」弹窗（含优先级输入框）preview
      applyBuiltinFixedChannelManagePreviewState,
      // v3.0.4 块 F · F1：Payment 线下调拨订单回填处理展开态 preview
      applyBuiltinFixedChannelManagePaymentPreviewState,
      applyScenarioCategorySelectPreviewState,
      // v2.1.14 C：链接表管理弹窗 preview
      applyLinkedTableManagerPreviewState,
      // v3.0.14：临时链接表管理首页 preview
      applyPreFundTempManagerPreviewState,
      // v3.0.16：临时 MPT 明细错误失败页 preview
      applyPreFundTempImportFailurePreviewState,
      // v3.0.14：临时链接表按日期删除框 preview
      applyPreFundTempDeleteRangePreviewState,
      // v3.0.1 需求1（D4）：删除网关对账单弹框 preview
      applyLinkedTableDeleteRangePreviewState,
      // v3.0.1 需求3：网关对账单修复场景单选框 preview
      applyGatewayReconScenarioPickerPreviewState,
      // v2.0.0-beta.3 PR #32b：4 类配置弹窗 + 确认详情 preview（4 张）
      // v2.1.7 F1：C1 dialog 新增 AND 模式 preview（OR fallback baseline + AND 显式各 1 张）
      applyScenarioConfigC1PreviewState,
      applyScenarioConfigC1AndPreviewState,
      applyScenarioConfigC2PreviewState,
      applyScenarioConfigC3PreviewState,
      applyScenarioConfigC3CustomPreviewState,
      applyScenarioConfirmDetailPreviewState,
      // v2.1.0-beta.1 PR-A：单据对账 ReconID 修复模块 preview（3 张）
      applyReconIdFixPanelPreviewState,
      applyScenarioConfigC4PreviewState,
      applyScenarioConfigC4BothPreviewState,
      // v2.1.0-beta.3 T11：网关子模式 preview（5 张 — 主面板 business/gateway + dialog gateway 默认/1v多 禁用）
      applyReconIdFixPanelBusinessPreviewState,
      applyReconIdFixPanelGatewayPreviewState,
      applyScenarioConfigC4GatewayPreviewState,
      applyScenarioConfigC4Gateway1vNPreviewState,
      // v2.1.4 T3：小助手功能收纳弹窗 preview
      applyModuleCabinetPreviewState,
      // v3.0.8 需求1：工具箱🧰 主弹框 + 拆表选字段弹框 preview
      applyToolboxPreviewState,
      applyToolboxSplitFieldPickerPreviewState
    };
  }

  global.__rendererPreviews = {
    createRendererPreviews
  };
}(window));
