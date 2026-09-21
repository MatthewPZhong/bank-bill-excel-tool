(function initRendererDialogs(global) {
  function createRendererDialogs(deps) {
    const {
      modalBridge,
      configurationServices,
      configurationApi,
      dialogApis,
      reportLog,
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
      createFeedbackScope,
      scenarioCommands,
      scenarioSubscriptions,
      // v2.1.14 C：占位 helper（链接表管理弹窗「导入」按钮调用，统一「后续版本开放」提示）
      showComingSoon,
      // v2.1.0-beta.1 PR-A（task A9）：场景管理 dialog 任意 CRUD 操作完成后 reload 主面板"场景"下拉
    } = deps;

    const { openModal, closeModal, pushModal, replaceModal, registerModal, returnToModal } = modalBridge;

    const { createChannelManagerDialog, createExportScenarioBundleDialog, createTransferScenariosDialog, createScenariosManagerDialog, createScenarioCategorySelectDialog, createScenarioConfigDialogC1, createScenarioConfigDialogC2, createScenarioConfigDialogC3, createScenarioConfigDialogC4, createScenarioConfirmDetailDialog, applyPreviewDraft: applyScenarioPreviewDraft } = global.ScenarioDialogs.createScenarioDialogs({
      scenarioCommands, subscriptions: scenarioSubscriptions, appConstants, modalBridge,
      ui: { createOverlay, createAlertDialog, createConfirmDialog, escapeHtml, pushAlert }
    });

    const { looksLikeRegexLiteral, parseRegexLiteral, createExportScopeDialog, createMonthlyBalanceExportDialog, createManualBalanceSeedDialog, cloneBigAccountItems, formatBigAccountCurrencySummary, getBigAccountCurrencyTitle, normalizeCurrencyOptionEntry, getCurrencyOptionEntries, getCurrencyOptionLabel, getCurrencySuggestion, getSelectValues, collectMappingDraftFromTable, createTemplateRenameDialog, createBigAccountSelectionDialog, createBigAccountManagerDialog, renderTemplateTableRows, createTemplateManagerDialog, createMappingDialog, createAmountSplitRulesDialog, createBillSplitMappingsDialog, createBillSplitRowsDialog, createBalanceAddonManagerDialog, createAccountMappingDialog, createRememberOrderMismatchDialog, createAccountMappingMigrationDialog } = global.ConfigurationDialogs.createConfigurationDialogs({
      services: configurationServices, api: configurationApi, modalBridge,
      ui: { createOverlay, escapeHtml, createAlertDialog, createConfirmDialog, pushAlert, setStatus, applyStatementResult, applyManualBalancePromptStatus, createFeedbackScope },
      constants: { BALANCE_DISABLED_OPTION, BALANCE_CALCULATED_OPTION, MERCHANT_ID_SELF_INPUT_OPTION, ADVANCED_MAPPING_FIELDS, CONCAT_FIELDS_MAPPING_FIELD, AMOUNT_SPLIT_BY_FIELD_MAPPING_FIELD, AMOUNT_SPLIT_BY_FIELD_ENABLED_OPTION }
    });

    function pushAlert(parentElement, factory) {
      const parent = modalBridge.host.getHandle(parentElement);
      if (!parent?.isOpen()) return { status: 'stale' };
      // 确认/编辑尚在顶层时，错误属于该子层；确认错误不结束其草稿。
      return pushModal(modalBridge.host.getTop(), factory);
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
      const {
        onConfirm = null,
        confirmText = '确认',
        confirmSecondary = false,
        closeOnConfirm = true
      } = options;
      // v2.1.9 SR-log-1 (T32i)：wrapper hijack — createAlertDialog 默认告警弹框（spec §15.5）
      //   - 所有 createAlertDialog 调用方（误用 / 业务异常 / 校验失败）自动上报 error 级
      //   - try-catch graceful：desktopApi 不存在 → 不阻塞弹框渲染
      //   - 调用方可通过 options.logLevel / options.logDomain / options.logDetails 自定义
      //   - 调用方可 options.skipLogReport=true 显式跳过（如 info 类提示框）
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
          <button type="button"></button>
        </div>
      `;
      const confirmButton = dialog.querySelector('button');
      confirmButton.className = confirmSecondary ? 'secondary-btn small' : 'primary-btn small';
      confirmButton.textContent = String(confirmText || '确认');
      confirmButton.addEventListener('click', () => {
        const result = closeModal(overlay, { status: 'submitted', value: true });
        if (result.status === 'closed') onConfirm?.();
      });
      registerModal(overlay, { onMount() {
      try {
        if (!options.skipLogReport
          && typeof reportLog === 'function'
        ) {
          reportLog({
            level: options.logLevel || 'error',
            source: 'renderer',
            domain: options.logDomain || 'dialog',
            message: String(message || ''),
            details: Array.isArray(options.logDetails) ? options.logDetails : []
          });
        }
      } catch (_error) {
        // graceful
      }
      } });
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
        const closed = closeModal(overlay, { status: 'cancelled', reason: 'cancel' });
        if (closed.status === 'closed' && onCancel) onCancel();
      });
      overlay.appendChild(dialog);
      return overlay;
    }

    function createFundTransferAccountMappingDialog() {
      const overlay = createOverlay();
      const dialog = document.createElement('div');
      dialog.className = 'modal-card manager-card account-card';
      dialog.innerHTML = `
        <div class="dialog-header">
          <div class="dialog-title">账户映射管理</div>
          <button class="icon-close" type="button">×</button>
        </div>
        <div class="table-wrapper">
          <table class="data-table">
            <thead>
              <tr>
                <th>中台调拨单账户号</th>
                <th>清结算系统银行账号</th>
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

      const tbody = dialog.querySelector('tbody');

      // 经宿主关闭本层，保留底层链接表管理会话。
      function closeSelf() {
        closeModal(overlay);
      }

      // 告警通过当前句柄 push/replace，确认后按宿主层级返回。
      let handle = null;
      let saving = false;
      function showNestedAlert(message, { replace = false } = {}) {
        if (!handle?.isOpen() || !handle.isTop()) return;
        const factory = () => createAlertDialog(escapeHtml(message));
        if (replace) replaceModal(handle, factory);
        else pushModal(handle, factory);
      }

      function createReadOnlyRow(midAccountId, clearingAccountId) {
        const row = document.createElement('tr');
        row.dataset.ftAccountMappingRow = 'true';
        let isEditing = false;

        const midCell = document.createElement('td');
        const clearingCell = document.createElement('td');
        const actionCell = document.createElement('td');
        actionCell.className = 'account-mapping-action-cell';

        const midSpan = document.createElement('span');
        midSpan.textContent = midAccountId;
        const clearingSpan = document.createElement('span');
        clearingSpan.textContent = clearingAccountId;

        const midInput = document.createElement('input');
        midInput.className = 'mapping-text-input account-mapping-id-input';
        midInput.type = 'text';
        midInput.spellcheck = false;
        midInput.value = midAccountId;
        midInput.style.display = 'none';

        const clearingInput = document.createElement('input');
        clearingInput.className = 'mapping-text-input account-mapping-id-input';
        clearingInput.type = 'text';
        clearingInput.spellcheck = false;
        clearingInput.value = clearingAccountId;
        clearingInput.style.display = 'none';

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
          midSpan.style.display = isEditing ? 'none' : '';
          clearingSpan.style.display = isEditing ? 'none' : '';
          midInput.style.display = isEditing ? '' : 'none';
          clearingInput.style.display = isEditing ? '' : 'none';
          editBtn.textContent = isEditing ? '完成' : '编辑';

          if (!isEditing) {
            midSpan.textContent = midInput.value;
            clearingSpan.textContent = clearingInput.value;
          }
        }

        editBtn.addEventListener('click', toggleEdit);
        deleteBtn.addEventListener('click', () => { row.remove(); });

        midCell.append(midSpan, midInput);
        clearingCell.append(clearingSpan, clearingInput);
        actionCell.append(editBtn, deleteBtn);
        row.append(midCell, clearingCell, actionCell);

        row.__rowApi = {
          getMidAccountId: () => midInput.value,
          getClearingAccountId: () => clearingInput.value
        };
        return row;
      }

      function createEditableRow(midAccountId = '', clearingAccountId = '') {
        const row = document.createElement('tr');
        row.dataset.ftAccountMappingRow = 'true';

        const midCell = document.createElement('td');
        const clearingCell = document.createElement('td');
        const actionCell = document.createElement('td');
        actionCell.className = 'account-mapping-action-cell';

        const midInput = document.createElement('input');
        midInput.className = 'mapping-text-input account-mapping-id-input';
        midInput.type = 'text';
        midInput.spellcheck = false;
        midInput.value = midAccountId;

        const clearingInput = document.createElement('input');
        clearingInput.className = 'mapping-text-input account-mapping-id-input';
        clearingInput.type = 'text';
        clearingInput.spellcheck = false;
        clearingInput.value = clearingAccountId;

        const doneBtn = document.createElement('button');
        doneBtn.className = 'text-action';
        doneBtn.type = 'button';
        doneBtn.textContent = '完成';

        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'text-action danger';
        deleteBtn.type = 'button';
        deleteBtn.textContent = '删除';

        doneBtn.addEventListener('click', () => {
          const newRow = createReadOnlyRow(midInput.value, clearingInput.value);
          row.parentNode.replaceChild(newRow, row);
        });
        deleteBtn.addEventListener('click', () => { row.remove(); });

        midCell.appendChild(midInput);
        clearingCell.appendChild(clearingInput);
        actionCell.append(doneBtn, deleteBtn);
        row.append(midCell, clearingCell, actionCell);

        row.__rowApi = {
          getMidAccountId: () => midInput.value,
          getClearingAccountId: () => clearingInput.value
        };
        return row;
      }

      function createAddRow() {
        const row = document.createElement('tr');
        row.className = 'add-row';
        row.innerHTML = `
          <td><button class="text-action" type="button" data-action="add">新增</button></td>
          <td></td><td></td>
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
            mapping.midAccountId || '',
            mapping.clearingAccountId || ''
          ));
        });
        tbody.appendChild(createAddRow());
      }

      // v3.0.12 PR#82 codex-P2-3（🔴 数据丢失）：list() 异步回填完成前 / 加载失败时，「完成」必须禁用——
      //   否则点完成读到空表 → save([]) → 仓储 saveMappings 整表删+重插 → **清空用户已配映射**（映射驱动调拨
      //   派生 big_account，污染「中台调拨订单对账ID回填」R5s2-recon + DBS-Charge R3.5 对账）。门控的是
      //   「还没 load 出来就存」，**不是「不让存空」**：成功 load 到 [] 后照常启用、可增行 / 有意存空。
      const doneBtn = dialog.querySelector('[data-action="done"]');
      let loaded = false;
      function setDoneEnabled(enabled) {
        // 原生 disabled：既拦点击、又触发 .primary-btn:disabled 视觉禁用态（styles-gemini.css 全局规则）。
        doneBtn.disabled = !enabled;
      }
      setDoneEnabled(false); // 初始禁用，待 list() 成功回填后启用

      // 打开即异步回填（先挂 overlay 渲染空表占位，list() 成功后填充并启用「完成」）
      loadMappings([]);
      const load = async () => {
        let result;
        try {
          result = await dialogApis.fundTransferAccountMappings.list();
        } catch (_err) {
          result = null;
        }
        if (!handle?.isOpen()) return;
        if (result && result.status === 'success') {
          loadMappings(result.mappings); // 含成功返回 [] 的合法空表
          loaded = true;
          setDoneEnabled(true);
        } else {
          // 失败 / status≠success：不再静默留空表——错误提示 + 「完成」保持禁用（绝不允许 save([]) 清空映射）。
          showNestedAlert('账户映射加载失败，请关闭后重试');
        }
      };

      dialog.querySelector('.icon-close').addEventListener('click', closeSelf);
      doneBtn.addEventListener('click', async () => {
        if (!loaded) return;
        if (saving || !handle?.isTop()) return;
        saving = true;
        setDoneEnabled(false); // 防御纵深：即便禁用态被绕过，未成功 load 绝不 save（杜绝空表覆盖已存映射）。
        const mappings = Array.from(tbody.querySelectorAll('tr[data-ft-account-mapping-row="true"]')).map((row) => ({
          midAccountId: row.__rowApi.getMidAccountId(),
          clearingAccountId: row.__rowApi.getClearingAccountId()
        }));

        let result;
        try {
          result = await dialogApis.fundTransferAccountMappings.save(mappings);
        } catch (err) {
          saving = false;
          if (!handle?.isOpen()) return;
          setDoneEnabled(true);
          showNestedAlert(`保存失败：${err?.message || '未知错误'}`);
          return;
        }

        saving = false;
        if (!handle?.isOpen()) return;
        setDoneEnabled(true);
        showNestedAlert(result?.message || '保存失败', { replace: result?.status === 'success' });
      });

      overlay.appendChild(dialog);
      registerModal(overlay, { canClose: () => !saving, onMount(opened) { handle = opened; return load(); } });
      return overlay;
    }

    const LINKED_DELETE_TABLE_LABELS = {
      'gateway-bill': '网关对账单',
      'fx-settlement': '外汇交割表',
      'bank-deposit': '银行对账单表'
    };

    // ── v3.0.5 OPEN-4（T6c）：以下派生提取/构造纯函数由「链接表管理导入完成框」与「删除联动结果框」共用 ──
    //   提升到 createRendererDialogs 顶层作用域（原在 createLinkedTableManagerDialog 内部，纯函数无副作用，提升零行为变化）；
    //   删除联动重建返回的 admDerive/bocDerive/bocBankDerive 与导入完全同结构（main.js 复用同一 rebuild 函数）→ 复用同一套渲染，禁复制防口径漂移。

    // 从批量导入 results 取「最后一个」有 admDerive/bocDerive/bocBankDerive 者（多选逐次重建 → 最后一次=DB 最终态）。
    function findAdmDerive(results) {
      const list = Array.isArray(results) ? results : [];
      let hit = null;
      for (const r of list) { if (r && r.admDerive) hit = r; }
      return hit ? hit.admDerive : null;
    }
    function findBocDerive(results) {
      const list = Array.isArray(results) ? results : [];
      let hit = null;
      for (const r of list) { if (r && r.bocDerive) hit = r; }
      return hit ? hit.bocDerive : null;
    }
    function findBocBankDerive(results) {
      const list = Array.isArray(results) ? results : [];
      let hit = null;
      for (const r of list) { if (r && r.bocBankDerive) hit = r; }
      return hit ? hit.bocBankDerive : null;
    }

    // ADM 派生未匹配错误码 → 中文说明（PRD §5.3.6）。
    const ADM_UNMATCHED_CODE_LABELS = {
      'no-mid-match': '中台无对应渠道流水号',
      'mid-duplicate': '中台侧渠道流水号重复',
      'adm-duplicate': 'ADM 侧 CustomerRef 重复',
      'empty-customerref': 'ADM 行 CustomerRef 为空'
    };
    // 报错框最多列前 N 条未匹配明细，防 DOM 过载（PRD §5.3.6 / 决策4）。
    const ADM_UNMATCHED_DISPLAY_LIMIT = 50;

    // 构造 ADM 派生结果弹框 HTML（四态：派生失败 / 全匹配成功 / 部分成功未匹配 / 中台空）。
    //   返回 null = 无需弹 ADM 框（admDerive 缺失）。
    function buildAdmDeriveHtml(admDerive) {
      if (!admDerive) return null;
      // 派生失败（异常）：直接提示错误（银行对账单表本身已导入成功，仅 ADM 派生失败）。
      if (!admDerive.created) {
        const err = admDerive.error ? String(admDerive.error) : '未知错误';
        return `<b>ADM 银行对账单链接表派生失败</b><br/><br/>${escapeHtml(err)}`;
      }
      const unmatched = Array.isArray(admDerive.unmatched) ? admDerive.unmatched : [];
      // 全匹配成功（无未匹配）→ Mockup B：「ADM银行对账单链接表已创建」。
      if (unmatched.length === 0) {
        // v3.0.1 需求4：本次未派生出任何 ADM 行（银行表无 Channel='ADM' 调拨行）→ 表为空，不弹「已创建」成功提示（返回 null → 调用链跳过 ADM 框）。
        if (!admDerive.total) return null;
        return 'ADM银行对账单链接表已创建。';
      }
      // 部分成功 → Mockup C：列未匹配行（批次号/CustomerRef/BillDate/ChannelOrderNo + 错误码中文说明）。
      const head = [];
      if (admDerive.midEmpty) {
        // 中台表为空 → 顶部额外提示「请先导入中台调拨订单表」（PRD §5.3.6）。
        head.push('<b style="color:var(--danger);">请先导入中台调拨订单表。</b>');
      }
      head.push('<b>ADM 银行对账单链接表已创建（部分行未匹配中台调拨订单）</b>');
      head.push(`以下 <b>${unmatched.length}</b> 行未匹配，调拨号 / 调拨入金金额留空：`);

      const shown = unmatched.slice(0, ADM_UNMATCHED_DISPLAY_LIMIT);
      const items = shown.map((u) => {
        const codeLabel = ADM_UNMATCHED_CODE_LABELS[u.code] || u.code || '未知原因';
        const batchNo = u.batchNo === undefined || u.batchNo === null ? '' : String(u.batchNo);
        const customerRef = u.customerRef === undefined || u.customerRef === null ? '' : String(u.customerRef);
        const billDate = u.billDate === undefined || u.billDate === null ? '' : String(u.billDate);
        const channelOrderNo = u.channelOrderNo === undefined || u.channelOrderNo === null ? '' : String(u.channelOrderNo);
        return `• 批次号 ${escapeHtml(batchNo || '—')} ｜ CustomerRef=${escapeHtml(customerRef || '—')} ｜ `
          + `BillDate=${escapeHtml(billDate || '—')} ｜ ChannelOrderNo=${escapeHtml(channelOrderNo || '—')}`
          + `<br/>&nbsp;&nbsp;&nbsp;&nbsp;→ ${escapeHtml(codeLabel)}（${escapeHtml(u.code || '')}）`;
      }).join('<br/>');
      const truncatedNote = unmatched.length > ADM_UNMATCHED_DISPLAY_LIMIT
        ? `<br/><br/>……仅显示前 ${ADM_UNMATCHED_DISPLAY_LIMIT} 行（共 ${unmatched.length} 行未匹配）`
        : '';
      return `${head.join('<br/><br/>')}<br/><br/>${items}${truncatedNote}`;
    }

    // 构造 BOC fx 派生结果弹框规格（F2.6 表格五分支前四分支 + bank 失败收敛）。
    //   返回 null = 无需弹框（静默）；否则 { type:'alert'|'confirm', html, isError, missingReason }。
    //   needBankImport 分支用 confirm 框引导导入（复用链接表管理导入流程），其余用 alert。
    function buildBocDeriveSpec(bocDerive) {
      if (!bocDerive) return null;
      // 派生失败（异常）→ 错误弹框（交割表本身已导入成功，仅 BOC 派生失败）。
      if (!bocDerive.created) {
        const err = bocDerive.error ? String(bocDerive.error) : '未知错误';
        return { type: 'alert', isError: true, html: `<b>BOC链接表派生失败</b><br/><br/>${escapeHtml(err)}` };
      }
      // total===0（空交割表 / 仅标题表头）→ 静默（仿 ADM 0 行拍板）。
      if (!bocDerive.total) return null;
      // needBankImport（U2 拍板）→ confirm 引导导入 BOC 银行对账单。
      if (bocDerive.needBankImport) {
        const missingReason = bocDerive.bankMissingReason || '';
        // missing-payment-detail：库内有 BOC 银行行但缺 Payment Detail（旧白名单时代导入）→ 提示重新导入。
        const extraHint = missingReason === 'missing-payment-detail'
          ? '<br/><br/><b style="color:var(--danger);">检测到链接表库中已有 BOC 银行对账单数据但缺少「Payment Detail」字段（早期版本导入），无法提取银行单交易编号，请重新导入 BOC 银行对账单表。</b>'
          : '';
        const html = 'BOC链接表已生成分组与调拨单号，但链接表库无可用的 BOC 银行对账单数据，无法回填资金对账不平表链接ID。'
          + extraHint
          + '<br/><br/>是否现在导入 BOC 银行对账单？';
        return { type: 'confirm', isError: false, html, missingReason };
      }
      // 成功（created && total>0 && !needBankImport）→ 成功提示（skipLogReport）。
      return { type: 'alert', isError: false, html: 'BOC链接表已生成。' };
    }

    // 构造 BOC bank 补回填弹框规格：O1 拍板——成功静默（返回 null），仅失败弹错误框。
    function buildBocBankDeriveSpec(bocBankDerive) {
      if (!bocBankDerive) return null;
      if (!bocBankDerive.created) {
        const err = bocBankDerive.error ? String(bocBankDerive.error) : '未知错误';
        return { type: 'alert', isError: true, html: `<b>BOC调拨银行对账单表派生失败</b><br/><br/>${escapeHtml(err)}` };
      }
      return null; // O1：补回填成功静默
    }

    const PRE_FUND_TEMP_TABLES = Object.freeze([
      Object.freeze({
        sourceType: 'MPT_INBOUND_GATEWAY',
        label: '临时中台入金网关账单',
        tableLabel: '临时中台入金网关账单表库'
      }),
      Object.freeze({
        sourceType: 'MPT_OUTBOUND_GATEWAY',
        label: '临时中台出金网关账单',
        tableLabel: '临时中台出金网关账单表库'
      })
    ]);

    // v3.0.14：前置资金对账临时链接表管理首页。
    // 页面骨架与资金对账数据处理的「链接表管理」保持一致，仅移除不适用的账户映射入口。
    function createPreFundTempManagerDialog({ onChanged, onImport } = {}) {
      const PLACEHOLDER = '—';
      const overlay = createOverlay();
      const dialog = document.createElement('div');
      dialog.className = 'modal-card manager-card linked-table-manager-card';
      dialog.innerHTML = `
        <div class="dialog-header">
          <div class="dialog-title">链接表管理</div>
          <button class="icon-close" type="button">×</button>
        </div>
        <div class="table-wrapper">
          <table class="data-table linked-table-table">
            <thead>
              <tr>
                <th class="linked-table-col-name" style="width: 40%; text-align: left;">表库名</th>
                <th class="linked-table-col-range" style="width: 35%; text-align: left;">数据日期范围</th>
                <th class="linked-table-col-updated" style="width: 25%; text-align: left;">表库更新日期</th>
              </tr>
            </thead>
            <tbody>${PRE_FUND_TEMP_TABLES.map((table) => `
              <tr data-source-type="${table.sourceType}">
                <td class="linked-table-col-name">${table.tableLabel}</td>
                <td class="linked-table-col-range">${PLACEHOLDER}</td>
                <td class="linked-table-col-updated">${PLACEHOLDER}</td>
              </tr>
            `).join('')}</tbody>
          </table>
        </div>
        <div class="dialog-actions linked-table-manager-footer">
          <div class="linked-table-footer-spacer" style="flex: 1 1 auto;"></div>
          <button class="secondary-btn small" type="button" data-action="delete">删除</button>
          <button class="primary-btn small" type="button" data-action="import">导入</button>
          <button class="secondary-btn small" type="button" data-action="exit">退出</button>
        </div>
      `;
      overlay.appendChild(dialog);

      const deleteBtn = dialog.querySelector('[data-action="delete"]');
      const importBtn = dialog.querySelector('[data-action="import"]');

      function formatDateOnly(value) {
        const match = String(value || '').match(/^(\d{4}-\d{2}-\d{2})/);
        return match ? match[1] : '';
      }

      function renderSummary(batches) {
        const list = Array.isArray(batches) ? batches : [];
        for (const table of PRE_FUND_TEMP_TABLES) {
          const row = dialog.querySelector(`tr[data-source-type="${table.sourceType}"]`);
          if (!row) continue;
          const tableBatches = list.filter((batch) => batch && batch.sourceType === table.sourceType);
          const sourceDates = tableBatches
            .map((batch) => formatDateOnly(batch.sourceDate))
            .filter(Boolean)
            .sort();
          const importedDates = tableBatches
            .map((batch) => formatDateOnly(batch.importedAt))
            .filter(Boolean)
            .sort();
          row.querySelector('.linked-table-col-range').textContent = sourceDates.length > 0
            ? `${sourceDates[0]} ~ ${sourceDates[sourceDates.length - 1]}`
            : PLACEHOLDER;
          row.querySelector('.linked-table-col-updated').textContent = importedDates.length > 0
            ? importedDates[importedDates.length - 1]
            : PLACEHOLDER;
        }
      }

      async function refreshList() {
        try {
          const result = await dialogApis.preFundReconciliation.listTempBatches();
        if (!modalBridge.host.getHandle(overlay)?.isOpen()) return;
          renderSummary(result && result.status === 'ok' ? result.batches : []);
        } catch (_error) {
        if (!modalBridge.host.getHandle(overlay)?.isOpen()) return;
          renderSummary([]);
        }
      }

      function reopenManager() {
        openModal(() => createPreFundTempManagerDialog({ onChanged, onImport }));
      }

      function buildImportSummaryHtml(result) {
        const list = result && Array.isArray(result.results) ? result.results : [];
        const ok = list.filter((item) => item && item.status === 'ok');
        const failed = list.filter((item) => !item || item.status !== 'ok');
        const lines = [`成功导入 <b>${ok.length}</b> 张，失败 <b>${failed.length}</b> 张`];
        if (ok.length > 0) {
          lines.push(`成功：<br/>${ok.map((item) => {
            const rowCount = Number(item.rowCount) || 0;
            return `• ${escapeHtml(item.fileName || '文件')}（${rowCount} 行）`;
          }).join('<br/>')}`);
        }
        if (failed.length > 0) {
          lines.push(`失败：<br/>${failed.map((item) => (
            `• ${escapeHtml((item && item.fileName) || '文件')}：${escapeHtml((item && item.message) || '导入失败')}`
          )).join('<br/>')}`);
        }
        return lines.join('<br/><br/>');
      }

      function showImportResult(result) {
        const list = result && Array.isArray(result.results) ? result.results : [];
        const failures = list.filter((item) => !item || item.status !== 'ok');
        const repairable = failures.filter((item) => (
          item && item.canRepair === true && item.repairToken
        ));
        const summaryHtml = buildImportSummaryHtml(result);
        if (repairable.length === 0) {
          pushAlert(overlay, () => createAlertDialog(summaryHtml, {
            skipLogReport: true,
            onConfirm: reopenManager
          }));
          return;
        }

        const repairTokens = repairable.map((item) => item.repairToken);
        const structuralFailures = failures.filter((item) => !repairable.includes(item));
        const actionHint = `<br/><br/>其中 <b>${repairable.length}</b> 张文件可导出错误数据，或逻辑删除错误行后重跑。`
          + (structuralFailures.length > 0
            ? `<br/>另有 <b>${structuralFailures.length}</b> 张属于结构或身份错误，不能自动删除。`
            : '');
        pushModal(overlay, () => createConfirmDialog({
          message: `${summaryHtml}${actionHint}`,
          confirmText: '删除错误数据并重跑',
          middleText: '导出错误数据',
          cancelText: '关闭',
          onConfirm: async () => {
            closeModal();
            let repaired;
            try {
              repaired = await dialogApis.preFundReconciliation.repairMptErrors(repairTokens);
            } catch (error) {
              repaired = { status: 'failed', message: error && error.message ? error.message : String(error) };
            }
            if (!repaired || repaired.status !== 'ok') {
              pushAlert(overlay, () => createAlertDialog(
                `删除错误数据并重跑失败：${escapeHtml((repaired && repaired.message) || '未知错误')}`,
                { onConfirm: () => showImportResult(result) }
              ));
              return;
            }
            if (onChanged) await onChanged(repaired);
            const repairedSummary = `有效导入 <b>${Number(repaired.importedRowCount) || 0}</b> 行，逻辑删除错误数据 <b>${Number(repaired.excludedRowCount) || 0}</b> 行。`;
            const retryFailures = Array.isArray(repaired.results)
              ? repaired.results.filter((item) => !item || item.status !== 'ok')
              : [];
            const remaining = structuralFailures.length + retryFailures.length;
            const remainingHtml = remaining > 0
              ? `<br/><br/>仍有 <b>${remaining}</b> 张文件未导入，请修复源文件后重新导入。`
              : '';
            const retryFailureHtml = retryFailures.length > 0
              ? `<br/><br/>重跑失败：<br/>${retryFailures.map((item) => (
                `• ${escapeHtml((item && item.fileName) || '文件')}：${escapeHtml((item && item.message) || '重跑失败')}`
              )).join('<br/>')}`
              : '';
            const hasRetryableFailure = retryFailures.some((item) => (
              item && item.canRepair === true && item.repairToken
            ));
            pushAlert(overlay, () => createAlertDialog(`${repairedSummary}${remainingHtml}${retryFailureHtml}`, {
              skipLogReport: true,
              onConfirm: hasRetryableFailure ? () => showImportResult(repaired) : reopenManager
            }));
          },
          onMiddle: async () => {
            closeModal();
            let exported;
            try {
              exported = await dialogApis.preFundReconciliation.exportMptErrors(repairTokens);
            } catch (error) {
              exported = { status: 'failed', message: error && error.message ? error.message : String(error) };
            }
            if (exported && exported.status === 'cancelled') {
              showImportResult(result);
              return;
            }
            if (!exported || exported.status !== 'ok') {
              pushAlert(overlay, () => createAlertDialog(
                `导出错误数据失败：${escapeHtml((exported && exported.message) || '未知错误')}`,
                { onConfirm: () => showImportResult(result) }
              ));
              return;
            }
            const warningHtml = Array.isArray(exported.warnings) && exported.warnings.length > 0
              ? `<br/><br/>提醒：<br/>${exported.warnings.map((warning) => `• ${escapeHtml(warning)}`).join('<br/>')}`
              : '';
            pushAlert(overlay, () => createAlertDialog(
              `已导出 <b>${Number(exported.errorRowCount) || 0}</b> 条错误数据：<br/>${escapeHtml(exported.filePath || exported.fileName || '')}${warningHtml}`,
              { skipLogReport: true, onConfirm: () => showImportResult(result) }
            ));
          }
        }));
      }

      dialog.querySelector('.icon-close').addEventListener('click', closeModal);
      dialog.querySelector('[data-action="exit"]').addEventListener('click', closeModal);
      deleteBtn.addEventListener('click', () => {
        openModal(() => createPreFundTempDeleteRangeDialog({ onChanged, onImport }));
      });
      importBtn.addEventListener('click', async () => {
        importBtn.disabled = true;
        deleteBtn.disabled = true;
        let result;
        try {
          result = typeof onImport === 'function'
            ? await onImport({ showFailures: false })
            : await dialogApis.preFundReconciliation.importMpt();
        } catch (error) {
          result = { status: 'failed', message: error && error.message ? error.message : String(error) };
        }
        importBtn.disabled = false;
        deleteBtn.disabled = false;
        if (!result || result.status === 'cancelled') return;
        if (result.status !== 'ok') {
          pushAlert(overlay, () => createAlertDialog(`导入失败：${escapeHtml(result.message || '未知错误')}`, {
            onConfirm: reopenManager
          }));
          return;
        }
        if (onChanged) await onChanged(result);
        showImportResult(result);
      });

      registerModal(overlay, { onMount: () => refreshList() });
      return overlay;
    }

    // 临时网关对账单按来源和日期范围删除。页面骨架与链接表管理的删除框保持一致。
    function createPreFundTempDeleteRangeDialog({ onChanged, onImport } = {}) {
      const defaultTable = PRE_FUND_TEMP_TABLES[0];
      const overlay = createOverlay();
      const dialog = document.createElement('div');
      dialog.className = 'modal-card linked-table-delete-range-card';
      dialog.innerHTML = `
        <div class="dialog-header">
          <div class="dialog-title" data-role="title">删除${defaultTable.label}数据</div>
          <button class="icon-close" type="button">×</button>
        </div>
        <div class="dialog-body" style="padding: 4px 28px 8px;">
          <label style="display: flex; flex-direction: column; gap: 4px; font-size: 13px; margin-bottom: 14px;">
            目标表
            <select data-role="table-key">${PRE_FUND_TEMP_TABLES.map((table) => (
              `<option value="${table.sourceType}">${table.label}</option>`
            )).join('')}</select>
          </label>
          <div style="display: flex; gap: 16px; margin-bottom: 14px;">
            <label style="display: flex; flex-direction: column; gap: 4px; font-size: 13px;">
              起始日期
              <input type="date" data-role="start" />
            </label>
            <label style="display: flex; flex-direction: column; gap: 4px; font-size: 13px;">
              结束日期
              <input type="date" data-role="end" />
            </label>
          </div>
        </div>
        <div class="dialog-actions">
          <div style="flex: 1 1 auto;"></div>
          <button class="danger-btn small" type="button" data-action="confirm-delete" disabled>删除</button>
          <button class="secondary-btn small" type="button" data-action="cancel">取消</button>
        </div>
      `;
      const tableSelect = dialog.querySelector('[data-role="table-key"]');
      const titleEl = dialog.querySelector('[data-role="title"]');
      const startInput = dialog.querySelector('[data-role="start"]');
      const endInput = dialog.querySelector('[data-role="end"]');
      const confirmBtn = dialog.querySelector('[data-action="confirm-delete"]');

      const reopenManager = () => openModal(() => createPreFundTempManagerDialog({ onChanged, onImport }));
      const reopenDelete = () => openModal(() => createPreFundTempDeleteRangeDialog({ onChanged, onImport }));
      const rangeValid = () => Boolean(startInput.value) && Boolean(endInput.value)
        && startInput.value <= endInput.value;
      const selectedTable = () => PRE_FUND_TEMP_TABLES.find(
        (table) => table.sourceType === tableSelect.value
      ) || defaultTable;
      let countToken = 0;

      async function refreshState() {
        if (!rangeValid()) {
          confirmBtn.disabled = true;
          return;
        }
        const token = ++countToken;
        try {
          const result = await dialogApis.preFundReconciliation.countTempByDateRange(
            startInput.value,
            endInput.value,
            selectedTable().sourceType
          );
          if (token !== countToken) return;
          confirmBtn.disabled = !(result && result.status === 'ok');
        } catch (_error) {
          if (token !== countToken) return;
          confirmBtn.disabled = true;
        }
      }

      tableSelect.addEventListener('change', () => {
        titleEl.textContent = `删除${selectedTable().label}数据`;
        confirmBtn.disabled = true;
        countToken += 1;
        refreshState();
      });
      startInput.addEventListener('change', refreshState);
      startInput.addEventListener('input', refreshState);
      endInput.addEventListener('change', refreshState);
      endInput.addEventListener('input', refreshState);
      dialog.querySelector('.icon-close').addEventListener('click', reopenManager);
      dialog.querySelector('[data-action="cancel"]').addEventListener('click', reopenManager);

      confirmBtn.addEventListener('click', async () => {
        if (!rangeValid()) return;
        confirmBtn.disabled = true;
        const targetTable = selectedTable();
        let result;
        try {
          result = await dialogApis.preFundReconciliation.deleteTempByDateRange(
            startInput.value,
            endInput.value,
            targetTable.sourceType
          );
        } catch (error) {
          result = { status: 'failed', message: error && error.message ? error.message : String(error) };
        }
        if (!result || result.status !== 'ok') {
          pushAlert(overlay, () => createAlertDialog(`删除失败：${escapeHtml((result && result.message) || '未知错误')}`, {
            onConfirm: reopenDelete
          }));
          return;
        }
        if (onChanged) await onChanged(result);
        pushAlert(overlay, () => createAlertDialog(`已删除 ${Number(result.deleted) || 0} 行${targetTable.label}数据。`, {
          skipLogReport: true,
          onConfirm: reopenManager
        }));
      });

      overlay.appendChild(dialog);
      return overlay;
    }

    // v2.1.16 A4：链接表管理弹窗（导入 + 列表渲染，前后端联调）
    //   - 复用场景管理弹窗的 header/table/footer class 风格（.manager-card / .dialog-header / .table-wrapper / .dialog-actions）
    //   - 打开后调 dialogApis.linkedTable.list() 渲染 4 行：「数据日期范围」(min~max) + 「表库更新日期」(updatedAt)；空显示「—」
    //   - footer 右下 [导入][退出]：导入 → dialogApis.linkedTable.import() → 批量明细弹窗 → 刷新列表；退出 → closeModal()
    //   - tableKey 用 A3 repository 口径（gateway-bill / mid-allocation / fx-settlement / fx-option）；
    //     展示顺序与 list() 返回顺序一致（A3 ALL_TABLE_KEYS）。
    function createLinkedTableManagerDialog() {
      // tableKey（repository 口径）→ 中文表库名
      const LINKED_TABLE_LABELS = {
        'gateway-bill': '网关对账单表库',
        'mid-allocation': '中台调拨订单表库',
        'fx-settlement': '外汇交割表库',
        'fx-option': '外汇期权表库',
        // v2.1.16-beta.3 ②：链接表管理新增第 5 行；v2.1.16-beta.5 需求2 改名「银行对账单入金表」→「银行对账单表」
        'bank-deposit': '银行对账单表'
      };
      const PLACEHOLDER = '—';
      const overlay = createOverlay();
      const dialog = document.createElement('div');
      dialog.className = 'modal-card manager-card linked-table-manager-card';
      dialog.innerHTML = `
        <div class="dialog-header">
          <div class="dialog-title">链接表管理</div>
          <button class="icon-close" type="button">×</button>
        </div>
        <div class="table-wrapper">
          <table class="data-table linked-table-table">
            <thead>
              <tr>
                <th class="linked-table-col-name" style="width: 40%; text-align: left;">表库名</th>
                <th class="linked-table-col-range" style="width: 35%; text-align: left;">数据日期范围</th>
                <th class="linked-table-col-updated" style="width: 25%; text-align: left;">表库更新日期</th>
              </tr>
            </thead>
            <tbody></tbody>
          </table>
        </div>
        <div class="dialog-actions linked-table-manager-footer">
          <button class="secondary-btn small" type="button" data-action="account-mapping">账户映射管理</button>
          <div class="linked-table-footer-spacer" style="flex: 1 1 auto;"></div>
          <button class="secondary-btn small" type="button" data-action="delete-range">删除</button>
          <button class="primary-btn small" type="button" data-action="import">导入</button>
          <button class="secondary-btn small" type="button" data-action="exit">退出</button>
        </div>
      `;
      const tbody = dialog.querySelector('tbody');
      const importBtn = dialog.querySelector('[data-action="import"]');
      // v3.0.1 需求1（D4）：删除入口 → 关闭管理弹窗、打开「按日期范围删除」弹框（仅网关，🔴 不可逆）。
      const deleteBtn = dialog.querySelector('[data-action="delete-range"]');

      // 单行渲染：数据日期范围（min~max，缺一侧或全空显示「—」）+ 表库更新日期（updatedAt 取日期部分）
      function formatDateRange(meta) {
        const min = meta && meta.dataDateMin ? String(meta.dataDateMin) : '';
        const max = meta && meta.dataDateMax ? String(meta.dataDateMax) : '';
        if (!min && !max) return PLACEHOLDER;
        return `${min || PLACEHOLDER} ~ ${max || PLACEHOLDER}`;
      }
      function formatUpdatedAt(meta) {
        if (!meta || !meta.updatedAt) return PLACEHOLDER;
        // updatedAt 为 ISO 字符串（如 2026-06-07T03:21:00.000Z）→ 仅取日期部分展示
        const s = String(meta.updatedAt);
        const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
        return m ? m[1] : s;
      }

      function renderRows(tables) {
        const list = Array.isArray(tables) ? tables : [];
        tbody.innerHTML = list.map((meta) => {
          const key = meta && meta.tableKey ? String(meta.tableKey) : '';
          const name = LINKED_TABLE_LABELS[key] || key || '';
          return `
            <tr data-table-key="${escapeHtml(key)}">
              <td class="linked-table-col-name">${escapeHtml(name)}</td>
              <td class="linked-table-col-range">${escapeHtml(formatDateRange(meta))}</td>
              <td class="linked-table-col-updated">${escapeHtml(formatUpdatedAt(meta))}</td>
            </tr>
          `;
        }).join('');
      }

      // 占位行（list 未到 / 失败时填充，保证弹窗结构完整、不阻塞使用）。
      //   v2.1.16-beta.3 ②：LINKED_TABLE_LABELS 现 5 项（含入金表），占位渲染 5 行。
      function renderPlaceholderRows() {
        renderRows(Object.keys(LINKED_TABLE_LABELS).map((k) => ({ tableKey: k })));
      }

      // 拉取并渲染列表；失败仅渲染占位 4 行（不弹阻塞告警，避免初次打开陷入「确认→重开→再失败」循环）
      async function refreshList() {
        try {
          const result = await dialogApis.linkedTable.list();
        if (!modalBridge.host.getHandle(overlay)?.isOpen()) return;
          if (result && result.status === 'ok' && Array.isArray(result.tables)) {
            renderRows(result.tables);
            return;
          }
          renderPlaceholderRows();
        } catch (_err) {
        if (!modalBridge.host.getHandle(overlay)?.isOpen()) return;
          renderPlaceholderRows();
        }
      }

      // 导入结果批量明细：成功 N 张 / 失败 M 张 + 每文件原因
      function buildImportSummaryHtml(results) {
        const list = Array.isArray(results) ? results : [];
        const ok = list.filter((r) => r.status === 'ok');
        const failed = list.filter((r) => r.status !== 'ok');
        const statusLabel = {
          'ambiguous': '表头命中多张表，无法判定',
          'unrecognized': '未识别为任何链接表',
          'read-error': '文件读取失败',
          'write-error': '写入失败',
          'unsupported': '外汇期权表已入库，待阶段二接入'
        };
        const lines = [];
        lines.push(`成功导入 <b>${ok.length}</b> 张，失败 <b>${failed.length}</b> 张`);
        if (ok.length > 0) {
          const okList = ok.map((r) => {
            const name = LINKED_TABLE_LABELS[r.tableKey] || r.tableKey || '';
            const cnt = Number(r.rowCount) || 0;
            return `• ${escapeHtml(r.fileName)} → ${escapeHtml(name)}（${cnt} 行）`;
          }).join('<br/>');
          lines.push(`成功：<br/>${okList}`);
        }
        if (failed.length > 0) {
          const failList = failed.map((r) => {
            const reason = r.message || statusLabel[r.status] || r.status || '未知原因';
            return `• ${escapeHtml(r.fileName)}：${escapeHtml(reason)}`;
          }).join('<br/>');
          lines.push(`失败：<br/>${failList}`);
        }
        // v3.0.1 需求1（D3）/ v3.0.5 linked-fx T6：网关 + 银行对账单入金表 + 外汇交割表均为「跨次幂等累加」导入。
        //   逐表聚合本次覆盖/拒入计数，>0 才各自提醒（文案、键名、行为与 gateway v3.0.1 先例一致）。
        const IDEMPOTENT_IMPORT_TIPS = [
          { tableKey: 'gateway-bill', label: '网关对账单累加导入提醒', keyName: 'ReconBillBizId' },
          { tableKey: 'bank-deposit', label: '银行对账单入金表累加导入提醒', keyName: 'BizId' },
          { tableKey: 'fx-settlement', label: '外汇交割表累加导入提醒', keyName: '交易编号' }
        ];
        for (const { tableKey, label, keyName } of IDEMPOTENT_IMPORT_TIPS) {
          const hits = list.filter((r) => r && r.tableKey === tableKey && r.status === 'ok');
          const overwriteTotal = hits.reduce((s, r) => s + (Number(r.overwriteCount) || 0), 0);
          const rejectedEmptyTotal = hits.reduce((s, r) => s + (Number(r.rejectedEmptyCount) || 0), 0);
          if (overwriteTotal > 0 || rejectedEmptyTotal > 0) {
            const tips = [`<b>${label}</b>（按 ${keyName} 幂等，非整表替换）：`];
            if (overwriteTotal > 0) tips.push(`• 有 <b>${overwriteTotal}</b> 条因 ${keyName} 已存在被覆盖更新`);
            if (rejectedEmptyTotal > 0) tips.push(`• 有 <b>${rejectedEmptyTotal}</b> 条因 ${keyName} 为空被拒绝入库`);
            lines.push(tips.join('<br/>'));
          }
        }
        // v3.0.6 需求1（T3 派生 → 本次 T 显示）：中台调拨订单（mid-allocation）导入后，main 侧已派生隐藏的调拨对账单链接表
        //   （linked_fund_transfer_recon，一单按收/付拆 FundTransfer-in/out 两行），结果挂在 okResult.fundTransferReconDerive。
        //   仿上方累加导入提醒：成功且 total>0 才追加一行（total===0 = 空中台表，不显示「已生成 0 条」，对齐 ADM 0 行静默拍板）。
        //   派生失败（created:false）此处不展示（与 ADM 失败弹独立报错框的口径不同：调拨对账单为纯字段重排派生，失败仅静默，不阻断导入）。
        const ftReconHit = list.find((r) => r && r.tableKey === 'mid-allocation' && r.status === 'ok'
          && r.fundTransferReconDerive && r.fundTransferReconDerive.created);
        if (ftReconHit) {
          const derive = ftReconHit.fundTransferReconDerive || {};
          const ftTotal = Number(derive.total) || 0;
          if (ftTotal > 0) {
            lines.push(`已生成 <b>${ftTotal}</b> 条调拨对账单（FundTransfer-in/out）`);
          }
          if (derive.warning) {
            lines.push(`<b>调拨对账单提醒</b>：${escapeHtml(derive.warning)}`);
          }
        }
        return lines.join('<br/><br/>');
      }

      // v3.0.5 OPEN-4（T6c）：findAdmDerive/findBocDerive/findBocBankDerive 与 buildAdmDeriveHtml/buildBocDeriveSpec/
      //   buildBocBankDeriveSpec + ADM_UNMATCHED_* 常量已提升至 createRendererDialogs 顶层作用域（与删除联动结果框共用，
      //   纯函数提升零行为变化）；本弹窗下方导入完成链直接引用顶层版本。

      dialog.querySelector('.icon-close').addEventListener('click', closeModal);
      dialog.querySelector('[data-action="exit"]').addEventListener('click', closeModal);

      // 账户映射作为链接表管理的子层打开，关闭时保留父层及其草稿。
      dialog.querySelector('[data-action="account-mapping"]').addEventListener('click', () => {
        pushModal(overlay, () => createFundTransferAccountMappingDialog());
      });

      // 删除：打开「按日期范围删除」弹框（openModal 替换当前 overlay，无需显式 closeModal，与 importBtn 链式弹窗同范式）
      deleteBtn.addEventListener('click', () => {
        openModal(() => createLinkedTableDeleteRangeDialog());
      });

      // 导入：多选 Excel → main 识别 + 落库 → 批量明细弹窗 → 刷新列表
      //   导入期间禁用按钮防重复触发；cancelled（用户取消文件框）静默不弹明细。
      importBtn.addEventListener('click', async () => {
        importBtn.disabled = true;
        let result;
        try {
          result = await dialogApis.linkedTable.import();
        } catch (err) {
          importBtn.disabled = false;
          pushAlert(overlay, () => createAlertDialog(`导入失败：${err?.message || '未知错误'}`, {
            onConfirm: null
          }));
          return;
        }
        importBtn.disabled = false;
        if (!result || result.status === 'cancelled') {
          return; // 用户取消文件选择 → 不弹明细
        }
        if (result.status !== 'ok') {
          pushAlert(overlay, () => createAlertDialog(`导入失败：${result.message || '未知错误'}`, {
            onConfirm: null
          }));
          return;
        }
        // 弹批量明细；确认后链式弹后置派生结果框，再重开链接表管理弹窗（重开内部重新拉 list → 反映新日期/范围）。
        //   链顺序：导入明细 → ADM 派生框（含）→ BOC fx 派生框（含）→ BOC bank 补回填错误框（含）→ 重开管理弹窗。
        const admDerive = findAdmDerive(result.results);
        const admHtml = buildAdmDeriveHtml(admDerive);
        const bocDerive = findBocDerive(result.results);
        const bocSpec = buildBocDeriveSpec(bocDerive);
        const bocBankDerive = findBocBankDerive(result.results);
        const bocBankSpec = buildBocBankDeriveSpec(bocBankDerive);

        // 重开链接表管理弹窗 = 链尾终点。
        const reopenManager = () => openModal(() => createLinkedTableManagerDialog());

        // BOC bank 补回填错误框（O1：仅失败弹；成功静默 → bocBankSpec 为 null 时直接 reopenManager）。
        const showBocBankStep = (next) => {
          if (!bocBankSpec) { next(); return; }
          pushAlert(overlay, () => createAlertDialog(bocBankSpec.html, {
            skipLogReport: !bocBankSpec.isError, // 失败按 error 级上报
            onConfirm: next
          }));
        };

        // BOC fx 派生框（成功 alert / needBankImport confirm 引导导入 / 失败 error）。
        const showBocFxStep = (next) => {
          if (!bocSpec) { next(); return; }
          if (bocSpec.type === 'confirm') {
            // U2：缺 BOC 银行数据 → 确认即复用链接表管理导入流程（再次走 importBtn 同款 import()），取消则继续链。
            pushModal(overlay, () => createConfirmDialog({
              message: bocSpec.html,
              confirmText: '现在导入',
              cancelText: '稍后',
              onConfirm: () => { reopenManager(); },
              onCancel: () => { next(); }
            }));
            return;
          }
          pushAlert(overlay, () => createAlertDialog(bocSpec.html, {
            skipLogReport: !bocSpec.isError, // 成功提示 info 级不上报；失败 error 上报
            onConfirm: next
          }));
        };

        // ADM 派生框（成功提示 / 部分成功报错）。
        const showAdmStep = (next) => {
          if (!admHtml) { next(); return; }
          const admIsError = admDerive && (!admDerive.created
            || (Array.isArray(admDerive.unmatched) && admDerive.unmatched.length > 0));
          pushAlert(overlay, () => createAlertDialog(admHtml, {
            skipLogReport: !admIsError,
            onConfirm: next
          }));
        };

        pushAlert(overlay, () => createAlertDialog(buildImportSummaryHtml(result.results), {
          // v3.0.4 块 A · A2 #2：保留 skipLogReport（日志由 main 侧 linked-table:import handler 权威落盘，避免双写）。
          skipLogReport: true,
          onConfirm: () => {
            showAdmStep(() => showBocFxStep(() => showBocBankStep(reopenManager)));
          }
        }));
      });

      // 打开即异步拉取列表（先挂 overlay 返回，列表随后填充）
      registerModal(overlay, { onMount: () => refreshList() });

      overlay.appendChild(dialog);
      return overlay;
    }

    // v3.0.1 需求1（D4 / OPEN-6 用户拍板）：🔴 资金红线 — 按日期范围删除链接表数据。
    //   v3.0.5 OPEN-4（T6c）：加「目标表」下拉（三表：网关对账单/外汇交割表/银行对账单表），默认网关；
    //     v3.0.26 起标题固定为「删除数据」，实际目标仍以目标表下拉和成功提示为准。
    //     count/delete 调用带 tableKey；切表后 🔴 必须重新 count 成功才启用删除（防拿旧表 count 删新表）。
    //     删除成功文案随表名；fx/bank-deposit 删除联动重建派生（bocDerive/admDerive/bocBankDerive），结果框复用导入完成框范式。
    //   闭区间（含起止两端）；直接删、无二次确认 → 本弹框即唯一一道确认，警告须做足。
    //   实时计数：两端日期填齐 ∧ start<=end → countByDateRange 预览将删行数，否则禁用「删除」。
    //   删除走 deleteByDateRange（不可逆）；成功后重开管理弹窗自动刷新列表反映新日期范围。
    // @param {string} [initialTableKey] reopen 链（失败重开本框）传入当前选中表，保持目标表选择不丢；缺省 gateway-bill。
    function createLinkedTableDeleteRangeDialog(initialTableKey) {
      // 仅三张可删表（与后端 LINKED_DELETE_ALLOWED_TABLES 同口径）；非法入参回退 gateway-bill（向后兼容 + 防呆）。
      const defaultTableKey = Object.prototype.hasOwnProperty.call(LINKED_DELETE_TABLE_LABELS, initialTableKey)
        ? initialTableKey
        : 'gateway-bill';
      const overlay = createOverlay();
      const dialog = document.createElement('div');
      dialog.className = 'modal-card linked-table-delete-range-card';
      // 目标表下拉选项：保持「网关→fx→bank-deposit」顺序（网关默认在首位）。
      const tableOptionsHtml = ['gateway-bill', 'fx-settlement', 'bank-deposit'].map((k) => {
        const selected = k === defaultTableKey ? ' selected' : '';
        return `<option value="${k}"${selected}>${escapeHtml(LINKED_DELETE_TABLE_LABELS[k])}</option>`;
      }).join('');
      dialog.innerHTML = `
        <div class="dialog-header">
          <div class="dialog-title" data-role="title">删除数据</div>
          <button class="icon-close" type="button">×</button>
        </div>
        <div class="dialog-body" style="padding: 4px 28px 8px;">
          <label style="display: flex; flex-direction: column; gap: 4px; font-size: 13px; margin-bottom: 14px;">
            目标表
            <select data-role="table-key">${tableOptionsHtml}</select>
          </label>
          <div style="display: flex; gap: 16px; margin-bottom: 14px;">
            <label style="display: flex; flex-direction: column; gap: 4px; font-size: 13px;">
              起始日期
              <input type="date" data-role="start" />
            </label>
            <label style="display: flex; flex-direction: column; gap: 4px; font-size: 13px;">
              结束日期
              <input type="date" data-role="end" />
            </label>
          </div>
        </div>
        <div class="dialog-actions">
          <div style="flex: 1 1 auto;"></div>
          <button class="danger-btn small" type="button" data-action="confirm-delete" disabled>删除</button>
          <button class="secondary-btn small" type="button" data-action="cancel">取消</button>
        </div>
      `;
      const tableSelect = dialog.querySelector('[data-role="table-key"]');
      const startInput = dialog.querySelector('[data-role="start"]');
      const endInput = dialog.querySelector('[data-role="end"]');
      const confirmBtn = dialog.querySelector('[data-action="confirm-delete"]');

      // 当前选中目标表 tableKey（始终是三白名单之一）。
      function currentTableKey() {
        return tableSelect.value || 'gateway-bill';
      }
      // 当前目标表中文名（删除文案用）。
      function currentLabel() {
        return LINKED_DELETE_TABLE_LABELS[currentTableKey()] || currentTableKey();
      }

      // 当前输入是否构成有效闭区间（两端非空 ∧ start<=end）。
      function rangeValid() {
        const s = startInput.value;
        const e = endInput.value;
        return Boolean(s) && Boolean(e) && s <= e;
      }

      // 标记最近一次有效计数请求，避免快速改日期 / 切表时旧请求回填覆盖新值（含切表竞态）。
      let countToken = 0;

      // v3.0.1（用户调整）：红色警告框 + 「将删约 N 行」计数显示已按用户要求去掉；
      //   仍后台跑 countByDateRange，仅用于「计数成功才允许删除」的防误删门控（不再在 UI 显示行数）。
      // 重新评估输入：无效 → 禁用删除；有效 → 拉取计数，成功才启用删除（count 失败则保守禁用，避免未知行数下误删）。
      //   🔴 count 带当前选中 tableKey：切表时本函数被重新调用 → 对新表重新计数，成功才解禁，杜绝拿旧表 count 删新表。
      async function refreshState() {
        if (!rangeValid()) {
          confirmBtn.disabled = true;
          return;
        }
        const token = ++countToken;
        const s = startInput.value;
        const e = endInput.value;
        const tableKey = currentTableKey();
        try {
          const ret = await dialogApis.linkedTable.countByDateRange(s, e, tableKey);
          if (token !== countToken) return; // 已被更晚的输入 / 切表覆盖，丢弃本次回填
          confirmBtn.disabled = !(ret && ret.status === 'ok');
        } catch (_err) {
          if (token !== countToken) return;
          confirmBtn.disabled = true;
        }
      }

      // 切表：① 标题保持固定；② 🔴 立即禁用删除（防切表瞬间用旧表 count 结果删新表）；③ 重新对新表 count（成功才解禁）。
      tableSelect.addEventListener('change', () => {
        confirmBtn.disabled = true; // 先禁用：refreshState 异步 count 期间保持禁用，count 成功回填才解禁
        countToken += 1; // 作废可能在途的旧表 count 回填
        refreshState();
      });

      startInput.addEventListener('change', refreshState);
      startInput.addEventListener('input', refreshState);
      endInput.addEventListener('change', refreshState);
      endInput.addEventListener('input', refreshState);

      dialog.querySelector('.icon-close').addEventListener('click', () => {
        openModal(() => createLinkedTableManagerDialog());
      });
      dialog.querySelector('[data-action="cancel"]').addEventListener('click', () => {
        openModal(() => createLinkedTableManagerDialog());
      });

      // 删除成功后链式弹「派生重建结果」框，再重开管理弹窗（仿导入完成框的派生弹框链，复用顶层 build 函数）。
      //   gateway：无派生 → 直接重开管理弹窗。
      //   fx：bocDerive（删后全量重算）→ 复用 buildBocDeriveSpec（needBankImport 在删除场景降级为 alert 提示，不引导导入打断删除流）。
      //   bank-deposit：admDerive + bocBankDerive（删后 ADM/BOC bank 重建）→ 复用 buildAdmDeriveHtml / buildBocBankDeriveSpec。
      function showDeriveChainThenReopen(tableKey, ret) {
        const reopenManager = () => openModal(() => createLinkedTableManagerDialog());

        if (tableKey === 'fx-settlement') {
          const spec = buildBocDeriveSpec(ret && ret.bocDerive);
          if (!spec) { reopenManager(); return; }
          // 删除场景：needBankImport 仅作状态告知（库内无 BOC 银行数据），用 alert 展示，不走 confirm「现在导入」分支。
          pushAlert(overlay, () => createAlertDialog(spec.html, {
            skipLogReport: !spec.isError,
            onConfirm: reopenManager
          }));
          return;
        }

        if (tableKey === 'bank-deposit') {
          const admHtml = buildAdmDeriveHtml(ret && ret.admDerive);
          const bocBankSpec = buildBocBankDeriveSpec(ret && ret.bocBankDerive);
          // BOC bank 步（O1：成功静默，仅失败弹）。
          const showBocBankStep = (next) => {
            if (!bocBankSpec) { next(); return; }
            pushAlert(overlay, () => createAlertDialog(bocBankSpec.html, {
              skipLogReport: !bocBankSpec.isError,
              onConfirm: next
            }));
          };
          // ADM 步（成功提示 / 部分成功或失败报错）。
          if (!admHtml) { showBocBankStep(reopenManager); return; }
          const admDerive = ret && ret.admDerive;
          const admIsError = admDerive && (!admDerive.created
            || (Array.isArray(admDerive.unmatched) && admDerive.unmatched.length > 0));
          pushAlert(overlay, () => createAlertDialog(admHtml, {
            skipLogReport: !admIsError,
            onConfirm: () => showBocBankStep(reopenManager)
          }));
          return;
        }

        // gateway-bill（缺省）：无派生联动。
        reopenManager();
      }

      // 删除：disable 防重复 → deleteByDateRange(带 tableKey)（🔴 不可逆）→ 成功弹文案 + 派生链 / 失败重开本删除弹框（保留选中表）。
      confirmBtn.addEventListener('click', async () => {
        if (!rangeValid()) return;
        confirmBtn.disabled = true;
        const s = startInput.value;
        const e = endInput.value;
        const tableKey = currentTableKey();
        const label = currentLabel();
        let ret;
        try {
          ret = await dialogApis.linkedTable.deleteByDateRange(s, e, tableKey);
        } catch (err) {
          pushAlert(overlay, () => createAlertDialog(`删除失败：${err?.message || '未知错误'}`, {
            onConfirm: null
          }));
          return;
        }
        if (ret && ret.status === 'ok') {
          const deleted = Number(ret.deleted) || 0;
          pushAlert(overlay, () => createAlertDialog(`已删除 ${deleted} 行${label}数据。`, {
            skipLogReport: true,
            onConfirm: () => showDeriveChainThenReopen(tableKey, ret)
          }));
          return;
        }
        const msg = ret && ret.message ? ret.message : '未知错误';
        pushAlert(overlay, () => createAlertDialog(`删除失败：${msg}`, {
          onConfirm: null
        }));
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
    function createModuleCabinetDialog({ enabledModules, allModules, onCommit, onCommitted }) {
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
      registerModal(overlay, { canClose: () => !committing });

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
        closeModal(overlay, { status: 'cancelled', reason: 'cancel' });
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
        idleListEl.inert = active;
        enabledListEl.inert = active;
        updateControls();
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
        const handle = modalBridge.host.getHandle(overlay);
        if (committing || !handle?.isTop()) return;
        const submittedIds = [...workingEnabled];
        setCommittingState(true);
        errorEl.classList.remove('is-visible');
        errorEl.textContent = '';
        let ok = false;
        let failureMessage = '';
        try {
          // 已提交的保存仍由调用方完整完成；其结果不依赖窗口是否继续存在。
          ok = await onCommit([...submittedIds]);
          if (!ok) failureMessage = '保存模块设置失败，请稍后重试。';
        } catch (err) {
          failureMessage = `保存失败：${(err && err.message) || '未知错误'}`;
        } finally {
          committing = false;
          if (handle.isOpen()) setCommittingState(false);
        }
        if (!handle.isOpen() || !handle.isTop()) return;
        if (!ok) {
          errorEl.textContent = failureMessage;
          errorEl.classList.add('is-visible');
          return;
        }
        const closed = closeModal(handle, { status: 'submitted', value: submittedIds });
        // 成功关闭后才执行返回/导航；强制销毁的旧窗口没有后续 UI 授权。
        if (closed.status === 'closed' && typeof onCommitted === 'function') {
          try { await onCommitted([...submittedIds]); } catch (error) {
            const message = `模块设置已保存，但刷新界面失败：${error?.message || '未知错误'}`;
            if (typeof setStatus === 'function') setStatus(message, 'error');
            else console.error(message);
          }
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
              if (committing) { ev.preventDefault(); return; }
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
              if (committing) { ev.preventDefault(); return; }
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
            if (committing) return;
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
        moveEnableBtn.disabled = committing ||
          cabinetState.selectedRegion !== 'idle' || !cabinetState.selectedModuleId;
        // O3 拍板：启用区至少保留 1 个 → 仅剩 1 时禁用 ⬅️
        moveDisableBtn.disabled = committing ||
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
        if (committing) return;
        if (cabinetState.selectedRegion !== 'idle' || !cabinetState.selectedModuleId) return;
        applyLocal([...workingEnabled, cabinetState.selectedModuleId]);
      });
      moveDisableBtn.addEventListener('click', () => {
        if (committing) return;
        if (cabinetState.selectedRegion !== 'enabled' || !cabinetState.selectedModuleId) return;
        if (workingEnabled.length <= 1) return;
        applyLocal(workingEnabled.filter((x) => x !== cabinetState.selectedModuleId));
      });

      renderLists();
      return overlay;
    }

    // v3.0.8 需求1：工具箱🧰 主弹框（合表 / 拆表）。脱离主对账流程的轻量 Excel 行级搬运小工具。
    //   复用 modal-overlay/modal-card/dialog-* + openModal/closeModal（参考 createModuleCabinetDialog）。
    //   IPC 契约（preload dialogApis.toolbox → main.js trackedIpcHandle）：
    //     merge()       → {status:'success',filePath} / {status:'cancelled'} / {status:'failed',message,detailLines}
    //     splitRead()   → {status:'success',sourceFilePath,splitReadToken,headers,valuesByField} / {status:'cancelled'} / {status:'failed',message,detailLines}
    //     splitExport({sourceFilePath,splitReadToken,field,values} | {sourceFilePath,splitReadToken,mode:'multiple',groups}) → 单文件或多文件结果契约
    //   合表「导入文件」一气呵成；拆表在选字段弹框完成后直接进入单文件另存为或多文件目录导出。
    const { createToolboxDialog, createSplitFieldPickerDialog, createMultipleSplitFieldPickerDialog } =
      window.__toolboxDialogs.createToolboxDialogs({
        api: dialogApis?.toolbox, modalBridge, ui: { createAlertDialog, escapeHtml }
      });

    function createGatewayReconScenarioPickerDialog({ scenarios = [], onPick = null } = {}) {
      const overlay = createOverlay();
      const dialog = document.createElement('div');
      dialog.className = 'modal-card gateway-recon-picker-card';
      const list = Array.isArray(scenarios) ? scenarios : [];
      const radioName = `gateway-recon-scenario-pick-${list.length}`;
      const items = list.map((s, i) => `
        <label class="gateway-recon-picker-item">
          <input type="radio" name="${radioName}" value="${escapeHtml(String(s.id))}" ${i === 0 ? 'checked' : ''} />
          <span>${escapeHtml(s.name || `场景 ${s.id}`)}</span>
        </label>
      `).join('');
      dialog.innerHTML = `
        <div class="dialog-header"><div class="dialog-title">选择要运行的网关对账单修复场景</div></div>
        <div class="gateway-recon-picker-body">
          <div class="gateway-recon-picker-hint">检测到多个已启用场景，请选择一个运行：</div>
          <div class="gateway-recon-picker-list">${items}</div>
        </div>
        <div class="dialog-actions center">
          <button class="secondary-btn small" type="button" data-action="cancel">取消</button>
          <button class="primary-btn small" type="button" data-action="confirm">运行</button>
        </div>
      `;
      dialog.querySelector('[data-action="cancel"]').addEventListener('click', () => closeModal());
      dialog.querySelector('[data-action="confirm"]').addEventListener('click', () => {
        const checked = dialog.querySelector(`input[name="${radioName}"]:checked`);
        if (!checked) return;
        const parsed = Number.parseInt(checked.value, 10);
        onPick?.(Number.isFinite(parsed) ? parsed : checked.value);
      });
      overlay.appendChild(dialog);
      return overlay;
    }

    return {
      closeModal,
      openModal,
      createOverlay,
      createGatewayReconScenarioPickerDialog,
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
      // v3.0.12 功能2（批A）：账户映射管理弹窗（链接表管理左下角入口；preview 链路也需此 factory）
      createFundTransferAccountMappingDialog,
      // v1.5.3 round 6：补全 preview 所需 factory（业务代码不直接用，仅 preview 链路调）
      createAmountSplitRulesDialog,
      createBillSplitRowsDialog,
      createBillSplitMappingsDialog,
      createBalanceAddonManagerDialog,
      // v2.0.0-beta.3：银行对账单处理模块场景管理
      applyScenarioPreviewDraft,
      createScenariosManagerDialog,
      createScenarioCategorySelectDialog,
      // v2.1.14 C：链接表管理弹窗（UI 骨架占位）
      createLinkedTableManagerDialog,
      createPreFundTempManagerDialog,
      // v3.0.1 需求1（D4）：按日期范围删除链接表数据弹框（🔴 资金红线，供 preview 调用）
      createLinkedTableDeleteRangeDialog,
      // v2.1.9 N5：银行渠道管理弹框（spec §4.2）
      createChannelManagerDialog,
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
      createModuleCabinetDialog,
      // v3.0.8 需求1：工具箱🧰（合表 / 拆表）主弹框 + 拆表选字段弹框
      createToolboxDialog,
      createSplitFieldPickerDialog,
      createMultipleSplitFieldPickerDialog,
      // v2.1.12 需求1：VCC业务OP计算 dialog factory（F1 确认 / F2 计算 / F3 显示余额）
      createVccOpCalcConfirmDialog,
      createVccOpCalcComputeDialog,
      createVccOpCalcShowBalanceDialog,
      applyVccOpCalcPanelInitialPreviewState,
      applyVccOpCalcPanelResultPreviewState,
      applyVccOpCalcComputeDialogPreviewState,
      applyVccOpCalcShowBalanceDialogPreviewState
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
        closeModal(overlay);
      });

      const confirmBtn = document.createElement('button');
      confirmBtn.className = 'primary-btn small';
      confirmBtn.type = 'button';
      confirmBtn.textContent = actionLabel;
      confirmBtn.addEventListener('click', () => {
        const yearMonth = `${yearSelect.value}-${monthSelect.value}`;
        const closed = closeModal(overlay, { status: 'submitted', value: true });
        if (closed.status === 'closed' && typeof onConfirm === 'function') onConfirm(yearMonth);
      });

      actions.appendChild(cancelBtn);
      actions.appendChild(confirmBtn);
      dialog.appendChild(actions);

      registerModal(overlay, { onClose: (outcome) => {
        if (outcome.status === 'cancelled' && typeof onCancel === 'function') onCancel();
      } });
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
            <div style="font-size:13px; color:var(--muted); line-height:1.55;">${escapeHtmlSafe(detail)}</div>
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
      registerModal(overlay, { onMount(handle, scope) {
        const align = () => { if (handle.isOpen() && handle.isTop()) alignSelectToLabel(); };
        const timer = setTimeout(align, 0);
        scope.onDispose(() => clearTimeout(timer));
        document.fonts?.ready?.then(align).catch(() => {});
      } });

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
            pushAlert(overlay, () => createAlertDialog('请选择一个月份'));
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
    // v2.1.12 需求1：VCC业务OP计算 dialog factory（F1 确认 / F2 计算 / F3 显示余额）
    // 蓝本：F1 仿 createBankBuReconFileImportPromptDialog（alert-card 纯展示）；
    //       F2 结构仿 Reconcile（只读数值 + input + 计算）；F3 仿 Export（去 radio，月份 select + 结果区）。
    // 资金红线🔴（spec §8.3）：F2 点「计算」= onCompute(beginOp) → renderer 调 vccOpCalc.save
    //   （后端整数分算 endOp + 原子落库）；前端绝不自行计算 beginOp+totalAmount，仅展示后端返回的金额字符串。
    // ============================================================

    // F1 月份+条数确认框（选完文件、scan 成功后弹；用户确认 → 后台 computeAmounts）
    function createVccOpCalcConfirmDialog({ yearMonth = '', totalRows = 0, fileCount = 0, onConfirm, onCancel } = {}) {
      const overlay = createOverlay();
      const card = document.createElement('div');
      card.className = 'modal-card alert-card';
      card.dataset.previewModal = 'vcc-op-calc-confirm';
      card.innerHTML = `
        <div class="alert-body">
          <div class="alert-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="28" height="28"><defs><linearGradient id="vccConfirmIconG" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#4285F4"/><stop offset="100%" stop-color="#9B72F2"/></linearGradient></defs><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-6-6z" fill="none" stroke="url(#vccConfirmIconG)" stroke-width="2" stroke-linejoin="round"/><path d="M14 3v6h6" fill="none" stroke="url(#vccConfirmIconG)" stroke-width="2" stroke-linejoin="round"/></svg>
          </div>
          <div class="alert-message">
            <div style="font-weight:600; font-size:15px; margin-bottom:6px;">确认流水信息</div>
            <div style="font-size:13px; color:var(--muted); line-height:1.8;">
              流水月份：<b>${escapeHtmlSafe(String(yearMonth))}</b><br>
              导入文件：<b>${escapeHtmlSafe(String(fileCount))}</b> 个<br>
              总流水条数：<b>${escapeHtmlSafe(String(totalRows))}</b> 条<br>
              <span style="color:var(--muted);">确认后将统计发生额出/入。</span>
            </div>
          </div>
        </div>
        <div class="dialog-actions center">
          <button class="secondary-btn small" type="button" data-action="cancel">取消</button>
          <button class="primary-btn small" type="button" data-action="confirm">确认</button>
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

    // F2 计算框（点「开始运行」弹）：只读发生额出/入/总额 → 输入期初OP → 点「计算」即落库
    //   onCompute(beginOp) 返回 { status:'success', endOp } | { status:'error', message }（resolve，不抛）
    function createVccOpCalcComputeDialog({ totals = {}, yearMonth = '', onCompute, onClose, canClose = () => true } = {}) {
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      overlay.dataset.previewModal = 'vcc-op-calc-compute';
      let handle = null;
      let computing = false;
      let completed = false;
      const events = new AbortController();
      const isCurrent = () => handle?.isOpen() && handle.isTop();
      registerModal(overlay, {
        // 领域来源锁和本视图提交锁共同决定关闭资格，不互相覆盖。
        canClose: (reason) => !computing && canClose(reason),
        onMount(opened) { handle = opened; },
        onDispose() { events.abort(); }
      });

      const dialog = document.createElement('div');
      dialog.className = 'modal-card pending-reconcile-dialog';
      overlay.appendChild(dialog);

      const title = document.createElement('div');
      title.className = 'pending-dialog-title';
      title.textContent = `计算期末OP（${yearMonth}）`;
      dialog.appendChild(title);

      // 只读发生额区（值为后端字符串原值，不二次运算 — 资金红线🔴）
      const amountBox = document.createElement('div');
      amountBox.style.cssText = 'padding:6px 2px 2px; font-size:13px; line-height:2;';
      const cur = totals.currency ? `（${escapeHtml(String(totals.currency))}）` : '';
      amountBox.innerHTML = `
        <div>发生额出：<b>${escapeHtml(String(totals.totalOut == null ? '—' : totals.totalOut))}</b></div>
        <div>发生额入：<b>${escapeHtml(String(totals.totalIn == null ? '—' : totals.totalIn))}</b></div>
        <div>总发生额（入−出）：<b>${escapeHtml(String(totals.totalAmount == null ? '—' : totals.totalAmount))}</b> ${cur}</div>
      `;
      dialog.appendChild(amountBox);

      // 期初OP 输入行（type=text 容忍负号/小数；金额合法性交后端 parseAmountToCents）
      const inputWrap = document.createElement('div');
      inputWrap.style.cssText = 'margin-top:10px; margin-bottom:14px; display:flex; align-items:center; gap:8px;';
      const inputLabel = document.createElement('label');
      inputLabel.textContent = '期初OP（上月OP）';
      inputLabel.style.cssText = 'font-size:13px; white-space:nowrap;';
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'mapping-text-input';
      input.placeholder = '允许负数/小数';
      input.style.flex = '1';
      inputWrap.appendChild(inputLabel);
      inputWrap.appendChild(input);
      dialog.appendChild(inputWrap);

      // 结果行（计算落库后显示期末OP）
      const resultBox = document.createElement('div');
      resultBox.style.cssText = 'margin-top:10px; font-size:14px; font-weight:600; color:var(--success); display:none;';
      dialog.appendChild(resultBox);

      // 错误行（inline，可重试）
      const errBox = document.createElement('div');
      errBox.style.cssText = 'margin-top:8px; font-size:12px; color:var(--danger); display:none;';
      dialog.appendChild(errBox);

      const actions = document.createElement('div');
      actions.className = 'dialog-actions center';

      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'secondary-btn small';
      cancelBtn.type = 'button';
      cancelBtn.textContent = '取消';
      cancelBtn.addEventListener('click', () => {
        if (!isCurrent() || computing) return;
        const closed = closeModal(handle);
        if (closed.status === 'closed' && typeof onClose === 'function') onClose();
      }, { signal: events.signal });

      const computeBtn = document.createElement('button');
      computeBtn.className = 'primary-btn small';
      computeBtn.type = 'button';
      computeBtn.textContent = '计算';
      computeBtn.disabled = true;  // 期初OP 空时禁用（基本前端校验，不解析金额）

      input.addEventListener('input', () => {
        if (!isCurrent() || computing || completed) return;
        computeBtn.disabled = input.value.trim() === '';
        errBox.style.display = 'none';
      }, { signal: events.signal });

      computeBtn.addEventListener('click', async () => {
        if (!isCurrent() || computing || completed) return;
        const beginOp = input.value.trim();
        if (beginOp === '') return;
        computing = true;
        computeBtn.disabled = true;
        input.disabled = true;
        errBox.style.display = 'none';
        let res = null;
        try {
          res = typeof onCompute === 'function' ? await onCompute(beginOp) : null;
        } catch (e) {
          res = { status: 'error', message: e && e.message ? e.message : String(e) };
        } finally {
          computing = false;
        }
        // 已提交的 Main 写照常结算；只有原存活窗口接纳展示结果。
        if (!isCurrent()) return;
        if (res && res.status === 'success') {
          completed = true;
          resultBox.textContent = `期末OP = ${res.endOp}（已保存）`;
          resultBox.style.display = 'block';
          computeBtn.style.display = 'none';   // 落库完成，收起计算按钮
          cancelBtn.textContent = '关闭';
        } else {
          errBox.textContent = (res && res.message) ? res.message : '计算失败';
          errBox.style.display = 'block';
          computeBtn.disabled = false;
          input.disabled = false;
        }
      }, { signal: events.signal });

      actions.appendChild(computeBtn);
      actions.appendChild(cancelBtn);
      dialog.appendChild(actions);

      return overlay;
    }

    // F3 显示余额框（点「显示余额」弹）：月份单选下拉 + 查看 → 展示 输入OP/总发生额/计算OP
    //   onView(yearMonth) 返回 { beginOp, totalAmount, endOp, currency, ... } | null（resolve，不抛）
    function createVccOpCalcShowBalanceDialog({ months = [], onView, onClose } = {}) {
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      overlay.dataset.previewModal = 'vcc-op-calc-show-balance';

      const dialog = document.createElement('div');
      dialog.className = 'modal-card pending-export-dialog';
      dialog.style.width = 'min(100%, 627px)';   // 缩小至 modal-card 默认 940px 的 2/3
      overlay.appendChild(dialog);

      const title = document.createElement('div');
      title.className = 'pending-dialog-title';
      title.textContent = '显示余额';
      dialog.appendChild(title);

      const safeMonths = Array.isArray(months) ? months : [];

      const selectRow = document.createElement('div');
      selectRow.style.cssText = 'display:flex; align-items:center; gap:8px; margin-top:4px;';
      const selectLabel = document.createElement('label');
      selectLabel.textContent = '选择月份';
      selectLabel.style.cssText = 'font-size:13px; white-space:nowrap;';
      const select = document.createElement('select');
      select.className = 'mapping-text-input pending-reconcile-month-select';
      select.style.cssText = 'flex: 0 0 170px;';   // 下拉框宽度缩至原(flex 占满≈510px)的约 1/3（用户要求）
      safeMonths.forEach((m, idx) => {
        const opt = document.createElement('option');
        opt.value = m;
        opt.textContent = m;
        if (idx === 0) opt.selected = true;
        select.appendChild(opt);
      });
      selectRow.appendChild(selectLabel);
      selectRow.appendChild(select);
      dialog.appendChild(selectRow);

      // 结果区（点查看后填充；金额为后端字符串原值）
      const resultBox = document.createElement('div');
      resultBox.style.cssText = 'margin-top:12px; font-size:13px; line-height:2; display:none;';
      dialog.appendChild(resultBox);

      const actions = document.createElement('div');
      actions.className = 'dialog-actions right';   // 查看/关闭 右下角对齐（复用既有 .dialog-actions.right）
      actions.style.marginTop = '12px';   // footer 横线(border-top)向下平移一点点（用户要求）

      const viewBtn = document.createElement('button');
      viewBtn.className = 'primary-btn small';
      viewBtn.type = 'button';
      viewBtn.textContent = '查看';
      viewBtn.disabled = safeMonths.length === 0;
      viewBtn.addEventListener('click', async () => {
        const ym = select.value;
        if (!ym) return;
        viewBtn.disabled = true;
        let bal = null;
        try {
          bal = typeof onView === 'function' ? await onView(ym) : null;
        } catch (_e) {
          bal = null;
        }
        viewBtn.disabled = false;
        if (!bal) {
          resultBox.innerHTML = `<span style="color:var(--danger);">未找到 ${escapeHtml(String(ym))} 的计算记录</span>`;
          resultBox.style.display = 'block';
          return;
        }
        const cur = bal.currency ? `（${escapeHtml(String(bal.currency))}）` : '';
        resultBox.innerHTML = `
          <div>月份：<b>${escapeHtml(String(bal.yearMonth || ym))}</b></div>
          <div>期初OP（输入）：<b>${escapeHtml(String(bal.beginOp == null ? '—' : bal.beginOp))}</b></div>
          <div>总发生额：<b>${escapeHtml(String(bal.totalAmount == null ? '—' : bal.totalAmount))}</b> ${cur}</div>
          <div>期末OP（计算）：<b>${escapeHtml(String(bal.endOp == null ? '—' : bal.endOp))}</b></div>
        `;
        resultBox.style.display = 'block';
      });

      const closeBtn = document.createElement('button');
      closeBtn.className = 'secondary-btn small';
      closeBtn.type = 'button';
      closeBtn.textContent = '关闭';
      closeBtn.addEventListener('click', () => {
        closeModal();
        if (typeof onClose === 'function') onClose();
      });

      actions.appendChild(viewBtn);
      actions.appendChild(closeBtn);
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
        closeModal(overlay);
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
        const closed = closeModal(overlay, { status: 'submitted', value: true });
        if (closed.status === 'closed' && typeof onConfirm === 'function') onConfirm(date);
      });

      actions.appendChild(confirmBtn);
      actions.appendChild(cancelBtn);
      dialog.appendChild(actions);

      registerModal(overlay, { onClose: (outcome) => {
        if (outcome.status === 'cancelled' && typeof onCancel === 'function') onCancel();
      } });
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
            pushAlert(overlay, () => createAlertDialog('请选择一个日期'));
            return;
          }
          closeModal();
          if (typeof onConfirm === 'function') onConfirm({ scope: 'single', runId, date });
        } else {
          const startDate = startSelect.value;
          const endDate = endSelect.value;
          if (!startDate || !endDate) {
            pushAlert(overlay, () => createAlertDialog('请选择起止日期'));
            return;
          }
          if (startDate > endDate) {
            pushAlert(overlay, () => createAlertDialog('起始日期不能晚于结束日期'));
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
            <div style="font-size:13px; color:var(--muted); line-height:1.55;">是否立即导入第 2 日数据？两日数据齐备后才能进入流水对账单导入。</div>
          </div>
        </div>
        <div class="dialog-actions center">
          <button class="secondary-btn small" type="button" data-action="cancel">否</button>
          <button class="primary-btn small" type="button" data-action="confirm">是</button>
        </div>
      `;
      card.querySelector('[data-action="cancel"]').addEventListener('click', () => {
        closeModal(overlay);
      });
      card.querySelector('[data-action="confirm"]').addEventListener('click', () => {
        const closed = closeModal(overlay, { status: 'submitted', value: true });
        if (closed.status === 'closed' && typeof onConfirm === 'function') onConfirm();
      });
      overlay.appendChild(card);
      registerModal(overlay, { onClose: (outcome) => {
        if (outcome.status === 'cancelled' && typeof onCancel === 'function') onCancel();
      } });
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
      openModal(() => createBizOpReconExportDialog({
        successDates,
        onConfirm: () => {},
        onCancel: () => {}
      }));
    }

    // ============================================================
    // v2.1.12 需求1：VCC业务OP计算 preview state apply（仿 biz-op-recon switchTo + panel + dialog）
    // ============================================================
    function switchToVccOpCalcPanel() {
      ['statementModulePanel','newAccountModulePanel','pendingModulePanel','bankStatementModulePanel','reconIdFixModulePanel','bankBuReconModulePanel','bizOpReconModulePanel','acquiringBillCurrencyModulePanel'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.hidden = true;
      });
      const panel = document.getElementById('vccOpCalcModulePanel');
      if (panel) panel.hidden = false;
      const nameEl = document.getElementById('currentModuleName');
      if (nameEl) nameEl.textContent = 'VCC业务OP计算';
    }

    function applyVccOpCalcPanelInitialPreviewState() {
      switchToVccOpCalcPanel();
      const importBtn = document.getElementById('vccOpCalcImportBtn');
      if (importBtn) importBtn.disabled = false;
      const runBtn = document.getElementById('vccOpCalcRunBtn');
      if (runBtn) runBtn.disabled = true;
      const showBtn = document.getElementById('vccOpCalcShowBalanceBtn');
      if (showBtn) showBtn.disabled = true;
      const statusBox = document.getElementById('vccOpCalcStatusBox');
      const statusText = statusBox && statusBox.querySelector('.status-box-text');
      if (statusText) statusText.textContent = '欢迎使用小助手';
    }

    function applyVccOpCalcPanelResultPreviewState() {
      switchToVccOpCalcPanel();
      ['vccOpCalcImportBtn','vccOpCalcRunBtn','vccOpCalcShowBalanceBtn'].forEach((id) => {
        const b = document.getElementById(id);
        if (b) b.disabled = false;
      });
      const statusBox = document.getElementById('vccOpCalcStatusBox');
      const statusText = statusBox && statusBox.querySelector('.status-box-text');
      if (statusText) statusText.textContent = '2026-04 运行完成：期初OP 1000.00 → 期末OP 3500.00（已保存）';
    }

    function applyVccOpCalcComputeDialogPreviewState() {
      applyVccOpCalcPanelResultPreviewState();
      openModal(() => createVccOpCalcComputeDialog({
        yearMonth: '2026-04',
        totals: { totalOut: '1500.00', totalIn: '4000.00', totalAmount: '2500.00', currency: 'CNY' },
        onCompute: async () => ({ status: 'success', endOp: '3500.00' }),
        onClose: () => {}
      }));
    }

    function applyVccOpCalcShowBalanceDialogPreviewState() {
      applyVccOpCalcPanelResultPreviewState();
      openModal(() => createVccOpCalcShowBalanceDialog({
        months: ['2026-04', '2026-03'],
        onView: async (ym) => ({ yearMonth: ym, beginOp: '1000.00', totalAmount: '2500.00', endOp: '3500.00', currency: 'CNY' }),
        onClose: () => {}
      }));
    }
  }

  global.__rendererDialogs = {
    buildBalanceSeedConfirmationRequest: (...args) => global.ConfigurationDialogs.buildBalanceSeedConfirmationRequest(...args),
    createRendererDialogs
  };
}(window));
