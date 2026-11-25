'use strict';
(function installStatementController(root) {
  function createStatementController({ api, panel, config, ui, initialInfo = {} }) {
    const owner = 'statement-generator';
    const FILENAME_MAPPING_TEMPLATE_ID = '__FILENAME_MAPPING__';
    const STATEMENT_MODES = Object.freeze({ createStatement: 'create-statement', exportMonthlyBalance: 'export-monthly-balance' });
    const elements = Object.fromEntries(['statusBox','templateSelect','importTemplateBtn','manageTemplateBtn','accountMappingBtn','importFileBtn','exportDetailBtn','exportBalanceBtn'].map(id => [id,panel.querySelector('#'+id)]));
    const state = { selectedTemplateId: FILENAME_MAPPING_TEMPLATE_ID, mode: STATEMENT_MODES.createStatement,
      monthlyBalanceReady:false,monthlyBalancePreview:null,canExportDetail:false,canExportBalance:false,
      hasEnum:!!initialInfo.hasEnum,enumFileName:initialInfo.enumFileName||'',hasErrorReport:!!initialInfo.hasErrorReport,
      manualBalancePromptReady:false,manualBalancePrompt:null,detailAlertText:'' };
    // pendingInteractions：按操作类型（import / balance / …）分别保存待继续的选择 / 确认，导出选择不会覆盖待确认的导入
    let active=false, disposed=false, generation=0, actionSequence=0, busy=false, pending=null, deferSequence=0;
    const pendingInteractions=new Map();
    let feedback={message:initialInfo.ownAccountsMigrationError || (state.hasEnum ? '欢迎使用小助手' : '内置网银账单枚举表缺失，请检查安装包'),tone:initialInfo.ownAccountsMigrationError || !state.hasEnum ? 'error' : 'info',options:{}};
    const removers=[];
    const live=(version=generation)=>active&&!disposed&&version===generation;
    const reportError=error=>ui.reportError?.(error);
    const updateStatusBox=(...args)=>{if(live())ui.status(...args);};
    function openModal(factory) { return live() ? ui.modalBridge.openModal(factory,{owner}) : {status:'stale'}; }
    const {createAlertDialog,createTemplateManagerDialog,createBigAccountSelectionDialog,createRememberOrderMismatchDialog,createDuplicateRowsReviewDialog,
      createExportScopeDialog,createMonthlyBalanceExportDialog,createManualBalanceSeedDialog,createAccountMappingDialog,createAccountMappingMigrationDialog,
      createChannelAccountMappingConflictDialog,createTemplateImportNameDialog}=ui;
    const getStatementChannels=()=>typeof config.getStatementChannels==='function'?config.getStatementChannels():[];
    // v3.2.15（D8）：升级后渠道账户映射冲突在进入网银账单时提示一次；关闭后本次运行不再自动弹出，打开账户映射时仍会提示。
    let channelConflictPromptShown=false;
    const refreshTemplates=config.refreshTemplates;
function isFilenameMappingMode(templateId) {
  return templateId === FILENAME_MAPPING_TEMPLATE_ID;
}

function setStatus(message, tone = 'info', options = {}) {
  state.hasErrorReport = Boolean(options.errorReportReady);
  state.manualBalancePromptReady = Boolean(options.manualBalancePromptReady);
  state.manualBalancePrompt = state.manualBalancePromptReady && options.manualBalancePrompt
    ? { ...options.manualBalancePrompt }
    : null;
  // v3.2.21：没有报错文件的逐行明细（导入预检的「跨 Sheet 回填」跳过原因），点击状态框查看；随反馈保存，离页返回后仍可查看
  state.detailAlertText = typeof options.detailAlertText === 'string' ? options.detailAlertText : '';
  feedback = { message, tone, options };
  updateStatusBox(elements.statusBox, message, tone, {
    errorReportReady: state.hasErrorReport,
    detailAlertReady: Boolean(state.detailAlertText),
    manualBalancePromptReady: state.manualBalancePromptReady,
    manualBalancePromptTitle: ({ gap: '点击处理账单日期断档', mismatch: '点击处理余额校验不一致', 'seed-replace': '点击处理人工补录余额替换' })[state.manualBalancePrompt?.reason]
      || (state.manualBalancePrompt?.seedMismatch ? '点击核对上一账单日余额' : ''),
    idleTitle: options.idleTitle ?? getStatusBoxTitle(config.getAccountMappingCount()),
    logMessage: options.logMessage
  });
}

function applyManualBalancePromptStatus(result) {
  setStatus(result.message, 'info', {
    errorReportReady: Boolean(result.errorReportReady),
    manualBalancePromptReady: Boolean(result.manualBalancePromptReady),
    manualBalancePrompt: result.manualBalancePrompt || null
  });
}

function getEnumStatusMessage() {
  return state.hasEnum
    ? '欢迎使用小助手'
    : '内置网银账单枚举表缺失，请检查安装包';
}

function getStatusBoxTitle(accountMappingCount) {
  const mappingSummary = accountMappingCount
    ? `当前账户映射条数：${accountMappingCount}`
    : '当前未设置账户映射';

  return `${mappingSummary}；应用已内置 COMMON 枚举表`;
}

// v3.2.16：「原始账单仅有币种无账户号」币种未维护大账号；v3.2.21：渠道同一账户命中余额方式不同的子模板、渠道出余额的
//   子模板有交易缺账单日期或 MerchantId。这几类整批阻断须逐项处理，弹窗列出明细
function hasAlertableErrorDetails(result) {
  const code = String(result && result.errorCode || '');
  return (code.startsWith('CURRENCY_BIG_ACCOUNT_') || code === 'CHANNEL_BALANCE_MODE_MISMATCH' || code === 'CHANNEL_BALANCE_ROWS_INCOMPLETE')
    && Array.isArray(result.detailLines)
    && result.detailLines.length > 0;
}

function applyStatementResult(result, { allowAlerts = true } = {}) {
  if (result.status === 'cancelled') {
    return false;
  }

  const tone = result.status === 'success'
    ? 'success'
    : result.manualBalancePromptReady
      ? 'info'
      : 'error';
  // v3.2.21：交易行全部因「跨 Sheet 回填」未配上而被移除、在导入预检即返回（没有报错文件）时的逐行跳过原因
  const detailAlertText = result.errorCode === 'NO_TRANSACTION_DATA'
    && !result.errorReportReady
    && Array.isArray(result.detailLines)
    && result.detailLines.length
    ? [result.message, ...result.detailLines].join('\n')
    : '';

  setStatus(result.message, tone, {
    errorReportReady: Boolean(result.errorReportReady),
    manualBalancePromptReady: Boolean(result.manualBalancePromptReady),
    manualBalancePrompt: result.manualBalancePrompt || null,
    // 结果另给的日志摘要（渠道名可能以账号命名，release 审查）
    logMessage: result.logMessage,
    ...(detailAlertText ? { detailAlertText } : {})
  });

  if (allowAlerts && Array.isArray(result.unmatchedAmountSplitFiles) && result.unmatchedAmountSplitFiles.length) {
    ui.alertNative(`以下文件全部未命中收支规则，请检查规则配置：\n${result.unmatchedAmountSplitFiles.join('\n')}`);
  }

  // v3.2.16：「原始账单仅有币种无账户号」币种未维护大账号时整批阻断，弹窗列出文件、币种和行号；
  //   v3.2.21：渠道同一账户命中余额方式不同的子模板时同样弹窗，逐账户列出
  if (allowAlerts && hasAlertableErrorDetails(result)) {
    ui.alertNative([result.message, ...result.detailLines].join('\n'));
  }

  // 当场弹窗逐行列出；离页期间返回的（allowAlerts 为 false）不弹窗，回到页面后点击状态框查看
  if (allowAlerts && detailAlertText) {
    ui.alertNative(detailAlertText);
  }

  // v1.4.9 PR #16 review P1 Fix C: ACI-12 — 拆分/合并账单全部未命中聚合告警
  if (allowAlerts && Array.isArray(result.unmatchedBillSplitFiles) && result.unmatchedBillSplitFiles.length) {
    ui.alertNative(`以下文件全部未命中拆分/合并规则，请检查规则配置：\n${result.unmatchedBillSplitFiles.join('\n')}`);
  }

  // v3.2.19：原始账单预处理「过滤账单」过滤后没有账单行的文件
  if (allowAlerts && Array.isArray(result.emptyPreprocessedFiles) && result.emptyPreprocessedFiles.length) {
    ui.alertNative(`以下文件经原始账单预处理过滤后没有账单行，请检查过滤规则：\n${result.emptyPreprocessedFiles.join('\n')}`);
  }

  if (
    result.status === 'success' ||
    result.status === 'warning' ||
    result.status === 'manual-balance-required' ||
    result.status === 'manual-balance-invalid'
  ) {
    setExportAvailability({
      detailEnabled: Boolean(result.detailReady),
      balanceEnabled: Boolean(result.balanceReady)
    });
    return true;
  }

  setExportAvailability({
    detailEnabled: false,
    balanceEnabled: false
  });
  return true;
}

function setExportAvailability({ detailEnabled = state.canExportDetail, balanceEnabled = state.canExportBalance }) {
  state.canExportDetail = detailEnabled;
  state.canExportBalance = balanceEnabled;
  if (!active || disposed) return;
  // v1.5.3 R1 (T1.6)：月度余额模式下由 applyStatementModeSideEffects 统一控制按钮；此处不覆盖
  if (state.mode === STATEMENT_MODES.exportMonthlyBalance) {
    return;
  }
  elements.exportDetailBtn.disabled = !detailEnabled;
  elements.exportBalanceBtn.disabled = !balanceEnabled;
}

function updateTemplateSelect() {
  // HTML 已静态声明两个 option（见 index.html），这里只负责同步 selectedIndex 到 state.mode
  if (elements.templateSelect.value !== state.mode) {
    elements.templateSelect.value = state.mode;
  }

  // 制作网银账单模式下 selectedTemplateId 永远是虚拟 ID（继承 v1.5.2）
  if (state.mode === STATEMENT_MODES.createStatement) {
    state.selectedTemplateId = FILENAME_MAPPING_TEMPLATE_ID;
  }

  applyStatementModeSideEffects();
}

function applyStatementModeSideEffects() {
  if (!active || disposed) return;
  const isMonthly = state.mode === STATEMENT_MODES.exportMonthlyBalance;

  // 两模式都可用的按钮：importTemplateBtn / manageTemplateBtn（无需改动 disabled）
  // 月度余额模式禁用：导入文件 / 导出明细 / 账户映射
  if (elements.importFileBtn) {
    elements.importFileBtn.disabled = isMonthly || busy;
  }
  if (elements.accountMappingBtn) {
    elements.accountMappingBtn.disabled = isMonthly || busy;
  }
  elements.templateSelect.disabled = busy;

  if (isMonthly) {
    // 月度余额模式：导出明细一律禁用；导出余额始终可点（装配/另存为走弹窗链路）
    if (elements.exportDetailBtn) {
      elements.exportDetailBtn.disabled = true;
    }
    if (elements.exportBalanceBtn) {
      elements.exportBalanceBtn.disabled = busy;
    }
    // 注：不清 state.canExportDetail / canExportBalance（PRD §1.7 P1-1：切回 statement 模式要恢复原状态）
  } else {
    // 制作网银账单模式：按 state.canExport* 恢复
    if (elements.exportDetailBtn) {
      elements.exportDetailBtn.disabled = busy || !state.canExportDetail;
    }
    if (elements.exportBalanceBtn) {
      elements.exportBalanceBtn.disabled = busy || !state.canExportBalance;
    }
  }
}

// v3.2.18【导入模板】（spec：changes/v3.2.18/feat/template-import-naming/spec.md）：先选文件识别为新模板，
// 再弹框输入银行渠道名、地区，模板名 = 银行渠道名-地区。名称类错误保留弹框改名重试；取消或弹框被关闭时丢弃待确认文件。
const TEMPLATE_IMPORT_NAME_ERROR_CODES = new Set(['TEMPLATE_IMPORT_NAME_INVALID', 'TEMPLATE_NAME_DUPLICATED', 'TEMPLATE_NAME_CHANNEL_CONFLICT']);

async function handleImportTemplate() {
  const version = generation;
  const prepared = await api.templates.prepareImport();

  if (prepared.status === 'cancelled') {
    return;
  }

  if (prepared.status !== 'ready') {
    if (live(version)) setStatus(prepared.message, 'error', { errorReportReady: Boolean(prepared.errorReportReady) });
    return;
  }

  const { importToken, sourceFileName } = prepared;
  const discard = () => { Promise.resolve(api.templates.discardImport(importToken)).catch(reportError); };
  if (!live(version)) {
    discard();
    return;
  }
  const opened = openModal(() => createTemplateImportNameDialog({
    sourceFileName,
    onCancel: discard,
    async onSubmit({ bankName, region }) {
      const result = await api.templates.importTemplate({ importToken, bankName, region });
      if (result.status !== 'success' && TEMPLATE_IMPORT_NAME_ERROR_CODES.has(result.errorCode)) {
        return { close: false, message: result.message };
      }
      if (live(version)) setStatus(result.message, result.status === 'success' ? 'success' : 'error', {
        errorReportReady: Boolean(result.errorReportReady)
      });
      if (result.status === 'success') {
        await refreshTemplates();
      } else {
        discard();
      }
      return { close: true };
    }
  }));
  if (opened && opened.status === 'stale') discard();
}

function openChannelConflictDialog(channels, version = generation) {
  if (!live(version) || typeof createChannelAccountMappingConflictDialog !== 'function') return;
  openModal(() => createChannelAccountMappingConflictDialog({ channels }));
}

async function listChannelConflicts() {
  if (typeof api.accountMappings?.listChannelConflicts !== 'function') return [];
  const result = await api.accountMappings.listChannelConflicts();
  return result && result.status === 'success' && Array.isArray(result.channels) ? result.channels : [];
}

// 已有弹窗（启动时的更新说明、用户刚打开的配置弹窗等）时，逐个等顶层弹窗关闭，直到没有弹窗再提示；
//   不用 openModal 替换别人的弹窗（v3.2.15 PR #246 审查）。期间离开本模块则不再提示。
async function waitUntilNoModalOpen(version) {
  for (let top = ui.modalBridge.host.getTop(); top; top = ui.modalBridge.host.getTop()) {
    await top.closed;
    if (!live(version)) return false;
  }
  return live(version);
}

async function promptChannelConflictsOnce() {
  if (channelConflictPromptShown) return;
  const version = generation;
  const channels = await listChannelConflicts();
  if (!live(version) || channelConflictPromptShown || channels.length === 0) return;
  if (!(await waitUntilNoModalOpen(version)) || channelConflictPromptShown) return;
  channelConflictPromptShown = true;
  const names = channels.map((item) => item.channelName).join('、');
  openModal(() => createAlertDialog(`升级后，渠道「${names}」的账户映射有设置不一致的账户号，需要为每个账户号选定一条。处理前这些渠道无法生成账单。`, {
    confirmText: '去处理',
    onConfirm: () => openChannelConflictDialog(channels, version)
  }));
}

async function handleOpenAccountMappings() {
  const version = generation;
  // v1.5.2 需求 3（G3-0）：虚拟 ID 不对应真实模板，这里当无选中处理，回落到第一个真实模板
  const hasRealSelection = state.selectedTemplateId && !isFilenameMappingMode(state.selectedTemplateId);
  const currentTemplateId = hasRealSelection ? Number(state.selectedTemplateId) : null;
  const templates = config.getTemplates();
  const channels = getStatementChannels();
  const templateId = currentTemplateId || (templates.length > 0 ? templates[0].id : null);

  if (!templateId && channels.length === 0) {
    setStatus('请先创建模板', 'error');
    return;
  }
  // v3.2.15（D7）：属于渠道的模板在渠道层设置账户映射。
  const selectedTemplate = templates.find((template) => Number(template.id) === Number(templateId));
  const currentScope = selectedTemplate && selectedTemplate.channelId
    ? { channelId: Number(selectedTemplate.channelId) }
    : (templateId ? { templateId } : { channelId: Number(channels[0].id) });

  // 检查是否有待分配的迁移数据
  const migrationCheck = await api.accountMappings.checkMigrationPending();
  if (!live(version)) return;
  if (migrationCheck.pending) {
    openModal(() => createAlertDialog('检测到旧版本数据，请为每个模板配置正确的账户映射', {
      onConfirm: async () => {
        const migrationData = await api.accountMappings.getMigrationData();
        if (!live(version)) return;
        if (migrationData.status !== 'success') {
          setStatus(migrationData.message || '获取迁移数据失败', 'error');
          return;
        }
        openModal(() => createAccountMappingMigrationDialog({
          rows: migrationData.rows,
          // v3.2.15（D7）：渠道子模板的账户映射在渠道层设置，迁移分配只列普通模板。
          templates: config.getTemplates().filter((template) => !template.channelId),
          onDone: () => {
            handleOpenAccountMappings();
          }
        }));
      }
    }));
    return;
  }

  const result = await api.accountMappings.list(currentScope);
  if (!live(version)) return;

  if (result.status !== 'success') {
    setStatus(result.message, 'error', {
      errorReportReady: Boolean(result.errorReportReady)
    });
    openModal(() => createAlertDialog(result.message));
    return;
  }

  openModal(() => createAccountMappingDialog({
    ...result,
    currentScope,
    templates,
    channels,
    currencyOptions: config.getCurrencyOptions() || []
  }));
  const conflictChannels = await listChannelConflicts();
  if (live(version) && conflictChannels.length > 0) {
    setStatus(`渠道「${conflictChannels.map((item) => item.channelName).join('、')}」的账户映射有待处理的冲突，请在账户映射中选择该渠道后点击【处理冲突】`, 'info');
  }
}
    function present(kind,result) {
      if (!result || result.status==='cancelled' || result.status==='empty') return;
      if(kind==='import') {
        if(result.status==='select-big-account') { openInteraction(kind,result,()=>createBigAccountSelectionDialog(result)); return; }
        // v3.2.19：重复账单过滤发现重复，确认后才生成（取消返回主页面）
        if(result.status==='duplicate-review') { openInteraction(kind,result,()=>createDuplicateRowsReviewDialog(result)); return; }
        // v3.2.19：未开始导入的拒绝（如只覆盖跨文件去重的一端）：会话、导出与补录入口都没变，只弹提示，不改状态框与导出按钮
        if(result.status==='error'&&result.preservesSession) {
          // v3.2.21：完成大账号选择时才发现的余额方式冲突，弹窗一并逐账户列出
          const lines=[result.message||''].concat(hasAlertableErrorDetails(result)?result.detailLines:[]);
          const text=lines.map(line=>String(line).replace(/[&<>"]/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[ch])).join('<br/>');
          // 消息含文件名（可能含账户号）：只在弹窗显示，不写入活动日志。宿主拒绝打开（如另一个弹窗正在提交）时保留这条提示，
          //   用户再点「导入文件」时弹出（不重新导入）
          openInteraction(kind,result,()=>createAlertDialog(text,{skipLogReport:true})); return;
        }
        if(result.status==='remember-order-mismatch') {
          const failedLines=(result.failedFileNames||[]).map(name=>name+'的账户个数或账户号匹配不上（账户个数和账户号都匹配不上），请检查。').join('<br/>');
          // 与大账号选择一样持有主进程待选择的上下文：宿主拒绝打开时保留结果，用户再点「导入文件」继续
          openInteraction(kind,result,()=>createRememberOrderMismatchDialog({message:failedLines,bigAccountResult:result}));return;
        }
        applyStatementResult(result);
        // 账单日期断档、余额校验不一致、人工补录替换直接弹出确认；关闭后仍可点击状态框重新打开。
        if(['gap','mismatch','seed-replace'].includes(result.manualBalancePrompt?.reason)) openModal(()=>createManualBalanceSeedDialog(result.manualBalancePrompt));
        return;
      }
      if(result.status==='select-export-scope') {
        // 选完范围后的导出结果与直接导出同样处理，未处理的补录或断档入口不因导出明细丢失。
        const version=generation;
        openModal(()=>createExportScopeDialog(kind==='detail'?'detail':'balance',{onResult:scoped=>{if(live(version))present(kind,scoped);}}));
        return;
      }
      if(kind==='balance'&&(result.manualBalancePromptReady||result.status==='manual-balance-required')) {
        applyManualBalancePromptStatus(result);
        if(['gap','mismatch','seed-replace'].includes(result.manualBalancePrompt?.reason)) openModal(()=>createManualBalanceSeedDialog(result.manualBalancePrompt));
        return;
      }
      if(kind==='monthly'&&['MONTHLY_BALANCE_NO_PENDING','MONTHLY_BALANCE_FILE_MISSING'].includes(result.errorCode)) {
        state.monthlyBalanceReady=false;state.monthlyBalancePreview=null;
      }
      // 导出明细不处理余额：尚未处理的补录或断档提示保留在状态框，否则只能重新导入才能继续。
      const keepBalancePrompt=kind==='detail'&&!result.errorReportReady&&state.manualBalancePromptReady&&state.manualBalancePrompt;
      setStatus(result.message || (kind==='monthly'?(result.status==='success'?'月度余额账单导出成功':'月度余额账单导出失败'):''),result.status==='success'?'success':'error',{
        errorReportReady:kind==='error'&&result.status==='success'?true:Boolean(result.errorReportReady),
        manualBalancePromptReady:Boolean(keepBalancePrompt),
        manualBalancePrompt:keepBalancePrompt?state.manualBalancePrompt:null,
        logMessage:result.logMessage
      });
      // v3.2.21：「导出全部」前发现渠道同一账户命中余额方式不同的子模板，弹窗逐账户列出
      if(hasAlertableErrorDetails(result))ui.alertNative([result.message,...result.detailLines].join('\n'));
    }
    // 等待用户继续的选择 / 确认：另存此前的状态框反馈（含上一批待补录余额的入口），提示期间保留补录入口；用户继续时若状态框
    //   仍是这条等待提示则恢复原反馈，之后取消选择 / 确认也不会丢掉上一批的可用操作；期间已有新反馈（如完成了补录）则保留新反馈。
    function deferInteraction(kind, result) {
      // 状态框正显示另一项操作的等待提示时，沿用那一项保存的原反馈，不把等待提示当作原反馈（之后不会回放已失效的提示）
      const waitingOwner = Array.from(pendingInteractions.values())
        .find((item) => item.waitingFeedback && feedback && item.waitingFeedback.message === feedback.message);
      const previousFeedbackBeforeWait = waitingOwner ? waitingOwner.previousFeedback : feedback;
      const waitingMessage = kind !== 'import'
        ? '导出等待选择，请点击原导出按钮继续'
        : (result && result.status === 'error' ? '本次导入未开始，请点击“导入文件”查看原因' : '导入等待确认，请点击“导入文件”继续');
      setStatus(waitingMessage, 'info', {
        manualBalancePromptReady: state.manualBalancePromptReady,
        manualBalancePrompt: state.manualBalancePrompt
      });
      // sequence：后保存的待办记下的原反馈更新（期间可能已有新反馈，如完成了补录）
      pendingInteractions.set(kind, { kind, result, previousFeedback: previousFeedbackBeforeWait, waitingFeedback: feedback, sequence: ++deferSequence });
    }
    // 打开选择 / 确认窗口；宿主拒绝打开（如另一个弹窗正在提交）时保留结果与主进程上下文，用户再点原按钮继续
    function openInteraction(kind, result, factory) {
      const opened = openModal(factory);
      if (!opened || opened.status !== 'opened') deferInteraction(kind, result);
    }
    function acceptBackgroundOutcome({ kind, result }) {
      if (!result || result.status === 'cancelled' || result.status === 'empty') return;
      // 后台 IPC 已执行，保留返回事实；旧页面的选择窗口不在新一轮 enter 中自动复活。
      if (['select-big-account', 'remember-order-mismatch', 'select-export-scope', 'duplicate-review'].includes(result.status)) {
        deferInteraction(kind, result);
        return;
      }
      if (kind === 'import' && result.status === 'error' && result.preservesSession) {
        // 离页期间被拒绝、未开始的导入：保留这条提示与上一批的导出、补录入口。提示可能含文件名（可能含账户号），
        //   状态框只显示不含文件名的等待文案（状态框会写入活动日志），用户再点「导入文件」时以不写日志的弹窗显示原提示
        deferInteraction(kind, result);
        return;
      }
      if (kind === 'import') {
        applyStatementResult(result, { allowAlerts: false });
        // v3.2.21：离页期间失败、须逐项处理的明细（如渠道出余额的交易缺账单日期或 MerchantId）回到本页时仍弹窗列出；
        //   错误报告与状态框不含文件名，不弹就看不到是哪份文件哪一行
        if (hasAlertableErrorDetails(result)) ui.alertNative([result.message, ...result.detailLines].join('\n'));
      } else present(kind, result);
    }
    async function perform(kind,work) {
      if(!live()||busy)return;
      if (pendingInteractions.has(kind)) {
        const outcome = pendingInteractions.get(kind);
        pendingInteractions.delete(kind);
        const previous = outcome.previousFeedback;
        const remaining = Array.from(pendingInteractions.values()).at(-1);
        if (remaining && feedback && outcome.waitingFeedback && feedback.message === outcome.waitingFeedback.message) {
          // 另一项仍在等待：状态框换成它的等待提示（保留补录入口），不回放等待前的反馈
          setStatus(remaining.waitingFeedback.message, 'info', {
            manualBalancePromptReady: state.manualBalancePromptReady,
            manualBalancePrompt: state.manualBalancePrompt
          });
          remaining.waitingFeedback = feedback;
          // 一并交接最近的原反馈：继续的这一项保存得更晚时，它记下的原反馈比剩余一项的更新
          if (outcome.sequence > remaining.sequence) {
            remaining.previousFeedback = previous;
            remaining.sequence = outcome.sequence;
          }
        } else if (previous && feedback && outcome.waitingFeedback && feedback.message === outcome.waitingFeedback.message) {
          setStatus(previous.message, previous.tone, previous.options);
        }
        present(kind, outcome.result);
        return outcome.result;
      }
      const version=generation,sequence=++actionSequence;
      busy=true;
      applyStatementModeSideEffects();
      try {
        const result=await work();
        if(disposed||sequence!==actionSequence)return result;
        if(!live(version)){pending={kind,result};return result;}
        present(kind,result);return result;
      } catch(error) {
        if(live(version))setStatus(error.message||'操作失败，请查看控制台','error');
        else if(!disposed)pending={kind,result:{status:'error',message:error.message||'操作失败'}};
        reportError(error);
      } finally {
        busy=false;
        if(live()&&pending) {const outcome=pending;pending=null;acceptBackgroundOutcome(outcome);}
        if(live())applyStatementModeSideEffects();
      }
    }
    function importFile() {
      if(!state.hasEnum){setStatus(getEnumStatusMessage(),'error');return;}
      if(!state.selectedTemplateId){setStatus('请先选择模板','error');return;}
      const id=isFilenameMappingMode(state.selectedTemplateId)?state.selectedTemplateId:Number(state.selectedTemplateId);
      return perform('import',()=>api.files.importFile(id));
    }
    // v3.2.18：导出明细只导出当前批次，直接弹出另存为框，不再弹范围选择。
    const exportDetail=()=>perform('detail',()=>api.files.exportDetail('current'));
    function exportBalance() {
      if(state.mode!==STATEMENT_MODES.exportMonthlyBalance)return perform('balance',()=>api.files.exportBalance());
      if(!state.monthlyBalanceReady) {
        const version=generation;
        return openModal(()=>createMonthlyBalanceExportDialog({onAssembleReady(summary){
          if(!live(version))return;
          state.monthlyBalanceReady=true;state.monthlyBalancePreview=structuredClone(summary);
          setStatus('月度余额账单已生成（共 '+summary.count+' 条记录），可点击"导出余额"另存为文件','success',{errorReportReady:false});
        },onAssembleFailed(result){
          // v3.2.22 B113：装配未成功时状态框同步结果：出错且已生成报错文件时可从状态框导出；无数据或其他失败时关闭报错导出，
          //   不留上一次尝试的报错状态（Codex 第六、十轮）
          if(!live(version))return;
          state.monthlyBalanceReady=false;state.monthlyBalancePreview=null;
          if(result.status==='empty'||result.status==='invalid')setStatus(result.message||'该模板 / 月份范围内无余额数据','info',{errorReportReady:false});
          else setStatus(result.message||'装配月度余额账单失败','error',{errorReportReady:result.status==='error'&&Boolean(result.errorReportReady)});
        }}));
      }
      return perform('monthly',()=>api.monthlyBalance.export());
    }
    function exportError() {if(state.hasErrorReport)return perform('error',()=>api.errors.exportLast());}
    function changeMode(value) {
      if (busy) { updateTemplateSelect(); return; }
      const nextMode=value===STATEMENT_MODES.exportMonthlyBalance?STATEMENT_MODES.exportMonthlyBalance:STATEMENT_MODES.createStatement;
      if(state.mode===nextMode)return;
      state.mode=nextMode;state.monthlyBalanceReady=false;state.monthlyBalancePreview=null;
      if(nextMode===STATEMENT_MODES.createStatement)state.selectedTemplateId=FILENAME_MAPPING_TEMPLATE_ID;
      updateTemplateSelect();
      if(nextMode===STATEMENT_MODES.exportMonthlyBalance)setStatus('点击"导出余额"选择模板和年月','info',{errorReportReady:false});
    }
    function bind(id,event,action){const node=elements[id];if(!node)return;const listener=e=>{if(live())Promise.resolve(action(e)).catch(reportError);};node.addEventListener(event,listener);removers.push(()=>node.removeEventListener(event,listener));}
    bind('importTemplateBtn','click',handleImportTemplate);
    bind('manageTemplateBtn','click',()=>openModal(()=>createTemplateManagerDialog()));
    bind('accountMappingBtn','click',handleOpenAccountMappings);
    bind('importFileBtn','click',importFile);bind('exportDetailBtn','click',exportDetail);bind('exportBalanceBtn','click',exportBalance);
    bind('templateSelect','change',event=>changeMode(event.target.value));
    bind('statusBox','click',()=>{
      if(state.manualBalancePromptReady&&state.manualBalancePrompt)return openModal(()=>createManualBalanceSeedDialog(state.manualBalancePrompt));
      if(!state.hasErrorReport&&state.detailAlertText){ui.alertNative(state.detailAlertText);return undefined;}
      return exportError();
    });
    removers.push(config.subscribe(()=>{if(live())updateTemplateSelect();}));
    return Object.freeze({
      async enter(){if(disposed)return{status:'stale'};active=true;++generation;updateTemplateSelect();
        // Statement 无公开 sessionStatus；保留本窗口已确认结果，消费既有 Main 命令返回，绝不把离页伪装为取消。
        if(pending){const outcome=pending;pending=null;acceptBackgroundOutcome(outcome);}
        else setStatus(feedback.message,feedback.tone,feedback.options);
        promptChannelConflictsOnce().catch(reportError);
        return{status:'ready'};},
      leave({reason='navigation'}={}){if(ui.modalHost.closeOwner(owner,reason).status==='blocked')return{status:'blocked'};active=false;++generation;return{status:'left'};},
      invalidate(){++generation;},
      dispose(){if(disposed)return;disposed=true;active=false;++generation;++actionSequence;removers.splice(0).forEach(remove=>remove());},
      createFeedbackScope(){const version=generation;return Object.freeze({
        setStatus:(...args)=>{if(live(version))setStatus(...args);},applyStatementResult:result=>{if(live(version))return applyStatementResult(result);},
        applyManualBalancePromptStatus:result=>{if(live(version))return applyManualBalancePromptStatus(result);}
      });},
      commands:Object.freeze({importFile,exportDetail,exportBalance,exportError,changeMode,importTemplate:handleImportTemplate,openAccountMappings:handleOpenAccountMappings}),
      preview:Object.freeze({setStatus,applyStatementResult,applyManualBalancePromptStatus,setExportAvailability,changeMode})
    });
  }
  const exported=Object.freeze({createStatementController});
  if(typeof module!=='undefined'&&module.exports)module.exports=exported;
  if(root)root.StatementController=exported;
})(typeof window!=='undefined'?window:null);
