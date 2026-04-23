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
      openBackgroundPalette
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
      applyAccountMappingMigrationDialogPreviewState
    };
  }

  global.__rendererPreviews = {
    createRendererPreviews
  };
}(window));
