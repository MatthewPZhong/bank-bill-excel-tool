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
      manualBalancePromptReady:false,manualBalancePrompt:null };
    let active=false, disposed=false, generation=0, actionSequence=0, busy=false, pending=null, pendingInteraction=null;
    let feedback={message:initialInfo.ownAccountsMigrationError || (state.hasEnum ? '欢迎使用小助手' : '内置网银账单枚举表缺失，请检查安装包'),tone:initialInfo.ownAccountsMigrationError || !state.hasEnum ? 'error' : 'info',options:{}};
    const removers=[];
    const live=(version=generation)=>active&&!disposed&&version===generation;
    const reportError=error=>ui.reportError?.(error);
    const updateStatusBox=(...args)=>{if(live())ui.status(...args);};
    function openModal(factory) { return live() ? ui.modalBridge.openModal(factory,{owner}) : {status:'stale'}; }
    const {createAlertDialog,createTemplateManagerDialog,createBigAccountSelectionDialog,createRememberOrderMismatchDialog,
      createExportScopeDialog,createMonthlyBalanceExportDialog,createManualBalanceSeedDialog,createAccountMappingDialog,createAccountMappingMigrationDialog}=ui;
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
  feedback = { message, tone, options };
  updateStatusBox(elements.statusBox, message, tone, {
    errorReportReady: state.hasErrorReport,
    manualBalancePromptReady: state.manualBalancePromptReady,
    idleTitle: options.idleTitle ?? getStatusBoxTitle(config.getAccountMappingCount())
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

function applyStatementResult(result, { allowAlerts = true } = {}) {
  if (result.status === 'cancelled') {
    return false;
  }

  const tone = result.status === 'success'
    ? 'success'
    : result.manualBalancePromptReady
      ? 'info'
      : 'error';

  setStatus(result.message, tone, {
    errorReportReady: Boolean(result.errorReportReady),
    manualBalancePromptReady: Boolean(result.manualBalancePromptReady),
    manualBalancePrompt: result.manualBalancePrompt || null
  });

  if (allowAlerts && Array.isArray(result.unmatchedAmountSplitFiles) && result.unmatchedAmountSplitFiles.length) {
    ui.alertNative(`以下文件全部未命中收支规则，请检查规则配置：\n${result.unmatchedAmountSplitFiles.join('\n')}`);
  }

  // v1.4.9 PR #16 review P1 Fix C: ACI-12 — 拆分/合并账单全部未命中聚合告警
  if (allowAlerts && Array.isArray(result.unmatchedBillSplitFiles) && result.unmatchedBillSplitFiles.length) {
    ui.alertNative(`以下文件全部未命中拆分/合并规则，请检查规则配置：\n${result.unmatchedBillSplitFiles.join('\n')}`);
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

async function handleImportTemplate() {
  const version = generation;
  const result = await api.templates.importTemplate();

  if (result.status === 'cancelled') {
    return;
  }

  if (live(version)) setStatus(result.message, result.status === 'success' ? 'success' : 'error', {
    errorReportReady: Boolean(result.errorReportReady)
  });

  if (result.status === 'success') {
    await refreshTemplates();
  }
}

async function handleOpenAccountMappings() {
  const version = generation;
  // v1.5.2 需求 3（G3-0）：虚拟 ID 不对应真实模板，这里当无选中处理，回落到第一个真实模板
  const hasRealSelection = state.selectedTemplateId && !isFilenameMappingMode(state.selectedTemplateId);
  const currentTemplateId = hasRealSelection ? Number(state.selectedTemplateId) : null;
  const templateId = currentTemplateId || (config.getTemplates().length > 0 ? config.getTemplates()[0].id : null);

  if (!templateId) {
    setStatus('请先创建模板', 'error');
    return;
  }

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
          templates: config.getTemplates(),
          onDone: () => {
            handleOpenAccountMappings();
          }
        }));
      }
    }));
    return;
  }

  const result = await api.accountMappings.list(templateId);
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
    currentTemplateId: templateId,
    templates: config.getTemplates(),
    currencyOptions: config.getCurrencyOptions() || []
  }));
}
    function present(kind,result) {
      if (!result || result.status==='cancelled' || result.status==='empty') return;
      if(kind==='import') {
        if(result.status==='select-big-account') { openModal(()=>createBigAccountSelectionDialog(result)); return; }
        if(result.status==='remember-order-mismatch') {
          const failedLines=(result.failedFileNames||[]).map(name=>name+'的账户个数或账户号匹配不上（账户个数和账户号都匹配不上），请检查。').join('<br/>');
          openModal(()=>createRememberOrderMismatchDialog({message:failedLines,bigAccountResult:result}));return;
        }
        applyStatementResult(result);return;
      }
      if(result.status==='select-export-scope') {openModal(()=>createExportScopeDialog(kind==='detail'?'detail':'balance'));return;}
      if(kind==='balance'&&(result.manualBalancePromptReady||result.status==='manual-balance-required')) {applyManualBalancePromptStatus(result);return;}
      if(kind==='monthly'&&['MONTHLY_BALANCE_NO_PENDING','MONTHLY_BALANCE_FILE_MISSING'].includes(result.errorCode)) {
        state.monthlyBalanceReady=false;state.monthlyBalancePreview=null;
      }
      setStatus(result.message || (kind==='monthly'?(result.status==='success'?'月度余额账单导出成功':'月度余额账单导出失败'):''),result.status==='success'?'success':'error',{
        errorReportReady:kind==='error'&&result.status==='success'?true:Boolean(result.errorReportReady)
      });
    }
    function acceptBackgroundOutcome({ kind, result }) {
      if (!result || result.status === 'cancelled' || result.status === 'empty') return;
      // 后台 IPC 已执行，保留返回事实；旧页面的选择窗口不在新一轮 enter 中自动复活。
      if (['select-big-account', 'remember-order-mismatch', 'select-export-scope'].includes(result.status)) {
        pendingInteraction = { kind, result };
        setStatus(kind === 'import' ? '导入等待确认，请点击“导入文件”继续' : '导出等待选择，请点击原导出按钮继续', 'info');
        return;
      }
      if (kind === 'import') applyStatementResult(result, { allowAlerts: false });
      else present(kind, result);
    }
    async function perform(kind,work) {
      if(!live()||busy)return;
      if (pendingInteraction?.kind === kind) {
        const outcome = pendingInteraction;
        pendingInteraction = null;
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
    const exportDetail=()=>perform('detail',()=>api.files.exportDetail());
    function exportBalance() {
      if(state.mode!==STATEMENT_MODES.exportMonthlyBalance)return perform('balance',()=>api.files.exportBalance());
      if(!state.monthlyBalanceReady) {
        const version=generation;
        return openModal(()=>createMonthlyBalanceExportDialog({onAssembleReady(summary){
          if(!live(version))return;
          state.monthlyBalanceReady=true;state.monthlyBalancePreview=structuredClone(summary);
          setStatus('月度余额账单已生成（共 '+summary.count+' 条记录），可点击"导出余额"另存为文件','success',{errorReportReady:false});
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
    bind('statusBox','click',()=>state.manualBalancePromptReady&&state.manualBalancePrompt?openModal(()=>createManualBalanceSeedDialog(state.manualBalancePrompt)):exportError());
    removers.push(config.subscribe(()=>{if(live())updateTemplateSelect();}));
    return Object.freeze({
      async enter(){if(disposed)return{status:'stale'};active=true;++generation;updateTemplateSelect();
        // Statement 无公开 sessionStatus；保留本窗口已确认结果，消费既有 Main 命令返回，绝不把离页伪装为取消。
        if(pending){const outcome=pending;pending=null;acceptBackgroundOutcome(outcome);}
        else setStatus(feedback.message,feedback.tone,feedback.options);
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
