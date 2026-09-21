'use strict';

(function installBankStatementController(root) {
  function createBankStatementController({ api, panel, config = {}, sharedReconSession, ui = {} } = {}) {
    if (!api || !panel || !config.scenarios || !sharedReconSession) throw new TypeError('银行对账控制器缺少领域依赖');
    const elements = Object.fromEntries([
      'bankStatementScenarioBtn', 'bankStatementImportBtn', 'bankStatementRunBtn', 'bankStatementExportBtn',
      'bankStatementStatusBox', 'bankStatementLinkedTableBtn'
    ].map((id) => [id, panel.querySelector(`#${id}`)]));
    const state = {
      bankStatementSession: null, gatewayReconSession: null, refundOrderSession: null,
      processingResult: null, bankStatementExport: null, bankStatementImportIssues: null,
      bankStatementInflight: false, bankStatementProcessRunMode: config.initialRunMode === 'gateway' ? 'gateway' : 'bank'
    };
    // 这是共享 Main 会话的展示缓存；不持有引擎明细，也不读取其他控制器的 state。
    const gatewayView = { session: null, result: null, stale: true };
    const owner = 'bank-statement-process';
    const removers = [];
    const progressRemovers = new Set();
    let active = false;
    let disposed = false;
    let renderGeneration = 0;
    let statusGeneration = 0;
    let gatewayGeneration = 0;
    let resultEpoch = 0;
    let uncertain = true;
    let needsRefresh = true;
    // 结果清空与DOM重绘可能分属不同页面代次；隐藏时保留待重绘事实。
    let resultFeedbackInvalidated = false;
    let lastStatusFeedback = { text: '欢迎使用小助手', tone: 'neutral' };
    let statusReadFeedback = null;
    let lastRevision = 0;
    let flowBusy = false;
    const live = (generation = renderGeneration) => !disposed && active && generation === renderGeneration;
    const reportError = (error) => { if (ui.reportError) ui.reportError(error); };
    function writeStatusBox(element, text, tone) {
      if (!live() || !element) return;
      if (ui.status) ui.status(element, text, tone);
      else { element.textContent = text; element.dataset.tone = tone; }
    }
    function updateStatusBox(element, text, tone) {
      if (!live() || !element) return;
      // 业务、进度或其他读取反馈已接替状态框，旧session错误不再拥有恢复资格。
      statusReadFeedback = null;
      lastStatusFeedback = { text, tone };
      writeStatusBox(element, text, tone);
    }
    function alert(message, options, generation = renderGeneration) {
      if (!live(generation) || !ui.alert || !ui.modalHost) return;
      return ui.modalHost.openRoot(() => ui.alert(message, options), { owner });
    }
    function confirm(options, generation = renderGeneration) {
      if (!live(generation) || !ui.confirm || !ui.modalHost) return false;
      const wrapped = { ...options };
      // 回调绑定创建弹窗时的页面代次；离页后旧回调不能重新启动业务。
      for (const key of ['onConfirm', 'onMiddle', 'onCancel']) {
        if (typeof options[key] === 'function') wrapped[key] = (...args) => live(generation) ? options[key](...args) : undefined;
      }
      const result = ui.modalHost.openRoot(() => ui.confirm(wrapped), { owner });
      return result?.status !== 'blocked';
    }
    function closeModal() { return ui.modalHost?.closeOwner(owner, 'completed'); }
    function render(updateStatus = true) {
      if (!live()) return;
      updateBankStatementUi({ updateStatus });
      if (updateStatus) resultFeedbackInvalidated = false;
    }
    function updateBankStatementRunBtnDisabled() {
      if (!live() || !elements.bankStatementRunBtn) return;
      const gateway = state.bankStatementProcessRunMode === 'gateway';
      const ready = gateway ? !!gatewayView.session : !!state.bankStatementSession;
      elements.bankStatementRunBtn.disabled = !ready || state.bankStatementInflight || flowBusy || (gateway ? gatewayView.stale : uncertain || needsRefresh);
    }
    function updateBankStatementExportButtonsDisabled() {
      if (!live() || !elements.bankStatementExportBtn) return;
      elements.bankStatementExportBtn.disabled = state.bankStatementProcessRunMode === 'gateway'
        || !state.processingResult || state.bankStatementInflight || uncertain || needsRefresh || flowBusy;
    }
    async function refreshBankStatementStatus({ updateStatus = true } = {}) {
      if (!live()) { needsRefresh = true; return false; }
      const generation = renderGeneration;
      const request = ++statusGeneration;
      try {
        const status = await api.sessionStatus();
        if (!live(generation) || request !== statusGeneration) return false;
        if (!status || status.status !== 'ok') throw new Error(status?.message || '');
        const lostResult = !status.hasProcessingResult && !!(state.processingResult || state.bankStatementExport);
        state.bankStatementSession = status.hasBankStatement ? {
          fileName: status.bankStatementFileName, rowCount: status.bankStatementRowCount,
          sourceFileCount: Number(status.bankStatementSourceFileCount) || 1,
          channelRegions: Array.isArray(status.bankStatementChannelRegions) ? status.bankStatementChannelRegions : []
        } : null;
        state.gatewayReconSession = status.hasGatewayRecon ? { fileName: status.gatewayReconFileName, rowCount: status.gatewayReconRowCount } : null;
        state.refundOrderSession = status.hasRefundOrder ? { ready: true } : null;
        state.processingResult = status.hasProcessingResult ? {
          hitRowCount: status.processingStats?.hitRowCount || 0,
          scenarioHitCount: status.processingStats?.scenarioHitCount || 0,
          hitScenarios: Array.isArray(status.processingStats?.hitScenarios) ? status.processingStats.hitScenarios.slice() : [],
          channelRegionHits: Array.isArray(status.processingStats?.channelRegionHits) ? status.processingStats.channelRegionHits.slice() : [],
          r5s3Enabled: status.processingStats?.r5s3Enabled === true,
          r5s4Enabled: status.processingStats?.r5s4Enabled === true,
          r5s3CleanupCount: status.processingStats?.r5s3CleanupCount || 0,
          r5s4BackfilledCount: status.processingStats?.r5s4BackfilledCount || 0,
          warningCount: status.processingStats?.warningCount || 0,
          skippedC3Count: status.processingStats?.skippedC3Count || 0
        } : null;
        if (!status.hasProcessingResult) state.bankStatementExport = null;
        uncertain = false;
        needsRefresh = false;
        const replaceFeedback = updateStatus || lostResult || resultFeedbackInvalidated;
        const previousFeedback = statusReadFeedback;
        render(replaceFeedback);
        if (!replaceFeedback && previousFeedback) {
          updateStatusBox(elements.bankStatementStatusBox, previousFeedback.text, previousFeedback.tone);
        }
        return true;
      } catch (error) {
        if (!live(generation) || request !== statusGeneration) return false;
        uncertain = true;
        needsRefresh = true;
        render(false);
        // 读取错误只暂时占据状态框；有效成功后恢复原反馈，确定失效则按Main事实重绘。
        statusReadFeedback = lastStatusFeedback;
        writeStatusBox(elements.bankStatementStatusBox, error.message ? `资金对账状态读取失败：${error.message}` : '资金对账状态读取失败', 'error');
        reportError(error);
        return false;
      }
    }
    async function refreshGatewayStatus() {
      if (!live()) { gatewayView.stale = true; return false; }
      const generation = renderGeneration;
      const request = ++gatewayGeneration;
      try {
        const status = await sharedReconSession.sessionStatus();
        if (!live(generation) || request !== gatewayGeneration) return false;
        if (!status || status.status !== 'ok') throw new Error(status?.message || '共享网关状态读取失败');
        gatewayView.session = status.hasFile ? { fileName: status.fileName, sheetCounts: status.sheetCounts || null } : null;
        gatewayView.result = status.hasResult ? { ...(status.resultStats || {}) } : null;
        gatewayView.stale = false;
        render(false);
        return true;
      } catch (error) {
        if (!live(generation) || request !== gatewayGeneration) return false;
        gatewayView.stale = true;
        render(false);
        if (state.bankStatementProcessRunMode === 'gateway') updateStatusBox(elements.bankStatementStatusBox, `共享网关状态读取失败：${error.message}`, 'error');
        reportError(error);
        return false;
      }
    }
    function subscribeProgress(method, formatter, generation) {
      if (typeof api[method] !== 'function') return () => {};
      let remove;
      try {
        remove = api[method]((event) => {
          const text = formatter(event);
          if (live(generation) && text) updateStatusBox(elements.bankStatementStatusBox, text, 'info');
        });
      } catch (error) { reportError(error); }
      let removed = false;
      const cleanup = () => {
        if (removed) return;
        removed = true;
        progressRemovers.delete(cleanup);
        if (typeof remove === 'function') { try { remove(); } catch (error) { reportError(error); } }
      };
      progressRemovers.add(cleanup);
      return cleanup;
    }
    async function action(kind, operation, progressMethod, formatter) {
      if (!live() || state.bankStatementInflight) return { status: 'blocked' };
      const generation = renderGeneration;
      state.bankStatementInflight = true;
      render(false);
      const remove = progressMethod ? subscribeProgress(progressMethod, formatter, generation) : () => {};
      try { return await operation(generation); }
      catch (error) { alert(`${kind}失败：${error?.message || error}`, undefined, generation); reportError(error); }
      finally {
        remove();
        state.bankStatementInflight = false;
        if (!live(generation)) {
          needsRefresh = true;
          if (live()) void refreshBankStatementStatus({ updateStatus: false });
        }
        if (live()) render(false);
      }
    }
    function handleBankStatementBatchImport() {
      if (flowBusy) return { status: 'blocked' };
      return action('导入', async (generation) => {
        state.bankStatementImportIssues = null;
        const result = await api.batchImport();
        if (!live(generation) || !result || result.status === 'cancelled') return result;
        if (result.status !== 'ok') { alert(`导入失败：${result.message || '未知错误'}`, undefined, generation); return result; }
        const results = Array.isArray(result.results) ? result.results : [];
        const issues = buildImportIssuesSummary(results);
        const linkedFailure = buildAlsoLinkedFailureSummary(results);
        if (linkedFailure) { issues.text = [issues.text, linkedFailure].filter(Boolean).join('\n'); issues.hasFailed = true; }
        issues.text = [issues.text, buildLinkedImportSummary(results), buildAlsoLinkedSummary(results)].filter(Boolean).join('\n');
        state.bankStatementImportIssues = issues;
        const bankImported = results.some((item) => item.status === 'ok' && item.tableKey === 'bank-statement');
        if (bankImported || results.some((item) => item?.status === 'ok' && item.outcome === 'linked')) {
          ++resultEpoch;
          state.bankStatementExport = null;
          if (bankImported) state.bankStatementProcessRunMode = 'bank';
          await refreshBankStatementStatus();
        } else render();
        if (live(generation) && bankImported) {
          const refundPrompted = await maybePromptRefundOrderImport(results, generation);
          if (live(generation) && !refundPrompted) await maybePromptGatewayReconImport(generation);
        }
        return result;
      }, 'onImportProgress', formatBankStatementImportProgress);
    }
    async function isGatewayBillReady() {
      try {
        const result = await config.linkedTable.rowCount('gateway-bill');
        return !!(result && result.status === 'ok' && Number.isFinite(result.rowCount) && result.rowCount > 0);
      } catch (error) { reportError(error); return false; }
    }
    async function isRefundOrderReady() {
      try { const result = await api.sessionStatus(); return !!(result?.status === 'ok' && result.hasRefundOrder); }
      catch (error) { reportError(error); return false; }
    }
    async function readScenarios() {
      const result = await config.scenarios.list();
      return result?.status === 'ok' && Array.isArray(result.scenarios) ? result.scenarios : [];
    }
    const enabled = (scenario) => scenario.enabled === 1 || scenario.enabled === true;
    async function shouldPromptRefundAtRun(generation) {
      try {
        if (await isRefundOrderReady()) return false;
        if (!live(generation)) return false;
        const scenarios = await readScenarios();
        if (!live(generation) || !scenarios.some((scenario) => scenario.name === '中台退款订单回填' && enabled(scenario))) return false;
        const result = await api.refundCandidateCount();
        return live(generation) && result?.status === 'ok' && result.candidateCount > 0;
      } catch (error) { reportError(error); return false; }
    }
    async function shouldPromptGatewayReconAtRun(generation) {
      try {
        if (await isGatewayBillReady()) return false;
        if (!live(generation)) return false;
        const scenarios = await readScenarios();
        if (!live(generation) || !scenarios.some((scenario) => scenario.category === 'gateway-recon-join' && enabled(scenario))) return false;
        const result = await api.c3CandidateCount();
        return live(generation) && result?.status === 'ok' && result.candidateCount > 0;
      } catch (error) { reportError(error); return false; }
    }
    function notifyLinkedTableImportFailures(result, generation) {
      if (result?.status !== 'ok' || !Array.isArray(result.results)) return;
      const failed = result.results.filter((item) => ['read-error', 'write-error', 'ambiguous', 'unrecognized'].includes(item.status));
      if (!failed.length) return;
      const lines = failed.map((item) => `${escapeHtml(item.fileName || '')}：${escapeHtml(item.message || item.status || '')}`).join('<br>');
      alert(`链接表导入有 ${failed.length}/${result.results.length} 个文件失败：<br>${lines}`, { skipLogReport: true }, generation);
    }
    function importLinked(generation) {
      if (!live(generation)) return;
      closeModal();
      return action('导入', async (current) => {
        const result = await config.linkedTable.import();
        if (!live(current)) return result;
        notifyLinkedTableImportFailures(result, current);
        await refreshBankStatementStatus();
        return result;
      });
    }
    async function maybePromptRefundOrderImport(results, generation) {
      try {
        const scenarios = await readScenarios();
        if (!live(generation) || !scenarios.some((scenario) => scenario.name === '中台退款订单回填' && enabled(scenario))) return false;
        if (results.some((item) => item.tableKey === 'zhongtai-refund-order' && item.status === 'ok')) return false;
        const result = await api.refundCandidateCount();
        if (!live(generation) || result?.status !== 'ok' || !(result.candidateCount > 0)) return false;
        return confirm({
          message: '已启用「中台退款订单回填」场景，但本次未导入「中台退款订单表」。<br>继续运行将跳过退款回填。',
          confirmText: '导入文件', cancelText: '稍后再说',
          onConfirm: () => { closeModal(); return handleBankStatementBatchImport(); }
        }, generation);
      } catch (error) { reportError(error); return false; }
    }
    async function maybePromptGatewayReconImport(generation) {
      try {
        const scenarios = await readScenarios();
        if (!live(generation) || !scenarios.some((scenario) => scenario.category === 'gateway-recon-join' && enabled(scenario))) return;
        if (await isGatewayBillReady()) return;
        if (!live(generation)) return;
        const result = await api.c3CandidateCount();
        if (!live(generation) || result?.status !== 'ok' || !(result.candidateCount > 0)) return;
        confirm({
          message: '已启用「资金对账不平」类场景，C3 需要网关对账单。<br>请在「链接表管理」导入网关对账单。',
          confirmText: '导入文件', cancelText: '稍后再说', onConfirm: () => importLinked(generation)
        }, generation);
      } catch (error) { reportError(error); }
    }
    async function proceedToGwCheck(generation = renderGeneration) {
      const needed = await shouldPromptGatewayReconAtRun(generation);
      if (!live(generation)) return;
      if (needed) {
        confirm({
          message: '已启用「资金对账不平」类场景但未导入网关对账单（链接表）。<br>继续运行将跳过该类场景。',
          confirmText: '导入文件', middleText: '直接运行', cancelText: '取消',
          onConfirm: () => importLinked(generation),
          onMiddle: () => { closeModal(); return runBankStatementInternal(); }
        }, generation);
        return;
      }
      return runBankStatementInternal();
    }
    async function handleBankStatementRun() {
      const generation = renderGeneration;
      if (!state.bankStatementSession) { alert('请先导入银行对账单'); return; }
      if (uncertain || needsRefresh) return { status: 'blocked' };
      if (await shouldPromptRefundAtRun(generation)) {
        if (!live(generation)) return;
        confirm({
          message: '已启用「中台退款订单回填」场景但未导入「中台退款订单表」。<br>继续运行将跳过退款回填。',
          confirmText: '导入文件', middleText: '直接运行', cancelText: '取消',
          onConfirm: () => { closeModal(); return handleBankStatementBatchImport(); },
          onMiddle: () => { closeModal(); return proceedToGwCheck(generation); }
        }, generation);
        return;
      }
      if (live(generation)) return proceedToGwCheck(generation);
    }
    async function handleBankStatementRunRouted() {
      if (!live() || state.bankStatementInflight || flowBusy) return { status: 'blocked' };
      const generation = renderGeneration;
      flowBusy = true;
      render(false);
      try {
        return state.bankStatementProcessRunMode === 'gateway' ? await handleBankStatementGatewayReconRun() : await handleBankStatementRun();
      } catch (error) { alert(`运行失败：${error.message || error}`, undefined, generation); reportError(error); }
      finally { flowBusy = false; if (live()) render(false); }
    }
    function runBankStatementInternal() {
      return action('运行', async (generation) => {
        const result = await api.run();
        if (!live(generation)) return result;
        if (result?.status !== 'ok') {
          const details = Array.isArray(result?.detailLines) && result.detailLines.length
            ? `<br/><br/>${result.detailLines.slice(0, 20).map(escapeHtml).join('<br/>')}` : '';
          await refreshBankStatementStatus();
          alert(`运行失败：${escapeHtml(result?.message || '未知错误')}${details}`, undefined, generation);
          return result;
        }
        ++resultEpoch;
        state.bankStatementExport = null;
        state.bankStatementImportIssues = null;
        await refreshBankStatementStatus();
        return result;
      }, 'onRunProgress', formatBankStatementRunProgress);
    }
    function handleBankStatementExport() {
      if (flowBusy) return { status: 'blocked' };
      if (uncertain || needsRefresh || state.bankStatementProcessRunMode === 'gateway') return { status: 'blocked' };
      if (!state.processingResult) { alert('请先点击"开始运行"处理对账单'); return; }
      return action('导出', async (generation) => {
        const epoch = resultEpoch;
        const result = await api.export();
        if (!live(generation) || epoch !== resultEpoch || !result || result.status === 'cancelled') return result;
        if (result.status === 'failed') { alert(`导出失败：${result.message || '未知错误'}`, undefined, generation); return result; }
        if (result.status === 'empty' || result.status === 'ok') {
          state.bankStatementExport = {
            mainFileName: result.status === 'empty' ? result.message || '无修改记录，未生成主输出文件' : result.mainFileName || result.mainFilePath,
            errorReportName: result.errorReportName || null,
            platformCleanupName: result.platformCleanupName || null,
            refundBackfillName: result.refundBackfillName || null
          };
          state.bankStatementImportIssues = null;
          render();
        } else alert(`未知导出状态：${JSON.stringify(result)}`, undefined, generation);
        return result;
      });
    }
    async function handleBankStatementGatewayReconRun() {
      const generation = renderGeneration;
      const status = await sharedReconSession.sessionStatus();
      if (!live(generation)) return;
      if (status?.status !== 'ok' || !status.hasFile) { alert('请先点击"导入不平表"导入资金对账不平结果表'); return; }
      const scenarios = await readScenarios();
      if (!live(generation)) return;
      const choices = scenarios.filter((scenario) => scenario.category === 'gateway-recon-id-fix' && enabled(scenario));
      if (!choices.length) { alert('请先在网关对账单修复-场景管理启用场景'); return; }
      if (choices.length === 1) return runGatewayReconScenario(choices[0].id);
      if (ui.gatewayScenarioPicker && ui.modalHost) ui.modalHost.openRoot(() => ui.gatewayScenarioPicker({
        scenarios: choices, onPick: (id) => { if (!live(generation)) return; closeModal(); return runGatewayReconScenario(id); }
      }), { owner });
    }
    function runGatewayReconScenario(scenarioId) {
      return action('运行', async (generation) => {
        const result = await sharedReconSession.run({ scenarioId, originModuleId: owner });
        if (!live(generation)) return result;
        await refreshGatewayStatus();
        if (result?.status !== 'ok') { alert(`运行失败：${result?.message || '未知错误'}`, undefined, generation); return result; }
        const count = Number(result.stats?.fixedRowCount || 0);
        const warnings = Array.isArray(result.warnings) ? result.warnings : [];
        const message = count > 0 ? `运行完成，命中 ${count} 行网关修复。<br>请点击"导出文件"导出网关对账单修复文件。`
          : '运行完成，本次无网关修复行。<br>（请核对场景渠道行与链接表/网关账单是否匹配，详见下方警告或操作日志。）';
        const lines = warnings.slice(0, 5).map((warning) => `• ${escapeHtml(warning?.message || warning?.code || '')}`);
        const tail = warnings.length > 5 ? `<br>等 ${warnings.length} 条，详见操作日志` : '';
        const details = warnings.length ? `<br><br>另有 ${warnings.length} 条警告：<br>${lines.join('<br>')}${tail}` : '';
        alert(message + details, warnings.length ? { logLevel: 'warning', logDomain: 'gateway-recon-id-fix' } : { logLevel: 'info', skipLogReport: true }, generation);
        return result;
      });
    }
    function updateBankStatementUi({ updateStatus = true } = {}) {
      if (!live()) return;
      if (!elements.bankStatementStatusBox) return;
      const bs = state.bankStatementSession;
      const gw = state.gatewayReconSession;
      const pr = state.processingResult;
      const ex = state.bankStatementExport;

      // 文案：5 状态优先级（初始 / 已导入 / 已处理 / 已导出）+ tone
      // 多行用 \n 分隔（CSS .status-box-text { white-space: pre-line } 渲染换行）
      let text;
      let tone = 'info';
      if (!bs) {
        text = '欢迎使用小助手';
        tone = 'neutral';
      } else if (ex) {
        // v2.1.9 N6 (T31, D18=a)：删冒号后冗余 \n
        //   updateStatusBox 内层 (`renderer.js:542-566` `String(message).replace(/：/g, '：\n')`) 已统一处理「：」后换行，
        //   外层不能再重复加 \n（否则双换行）。行间产物用 \n 续行（见下方加款单剔除 / 中台回填）。
        // v3.0.11 需求2：导出成功框不再显示 error-report（文件仍照常生成，仅去掉此处提示行）。
        text = `已导出：${ex.mainFileName}`;
        // v3.0.7 需求1b：导出附带产物（加款单剔除文件 / 中台回填文件）按存在性追加各占一行。
        //   行间用 \n 续行 + 全角「：」（与 error-report 同款，updateStatusBox 在「：」后补 \n → 文件名落下一行）。
        if (ex.platformCleanupName) text += `\n加款单剔除文件：${ex.platformCleanupName}`;
        if (ex.refundBackfillName) text += `\n中台回填文件：${ex.refundBackfillName}`;
        tone = 'success';
      } else if (pr) {
        // v3.0.7 需求1a：「已处理」分支改用 pr.channelRegionHits 按「渠道-地区」分组多行展示——
        //   每个 hit 一行 `渠道-地区:n条（场景名1、场景名2）`，组间 \n，整体接在「已处理：」后。
        //   数据契约（reconciliation-orchestrator stats.channelRegionHits）：
        //     Array<{ channelRegion:string, rowCount:number, scenarioNames:string[] }>，数组本身已按 channelRegion 升序、scenarioNames 已去重升序。
        //   🔴 换行陷阱（updateStatusBox 对全角「：」自动补 \n）：分组冒号一律半角 ':'、场景名间一律顿号 '、'，绝不用全角「：」（否则被打断换行）。
        //   向后兼容（pr.channelRegionHits 为空数组 / 字段缺失：旧持久化 processingResult / 旧 main）→ 完全回退下方 hitScenarios 旧格式，不抛错。
        const crHits = Array.isArray(pr.channelRegionHits) ? pr.channelRegionHits : [];
        if (crHits.length > 0) {
          const hitLines = crHits.map((h) => {
            const names = Array.isArray(h.scenarioNames) ? h.scenarioNames.filter((n) => n) : [];
            const namePart = names.length > 0 ? `（${names.join('、')}）` : '';
            return `${h.channelRegion}:${Number(h.rowCount) || 0}条${namePart}`;
          });
          // 「已处理：」后全角冒号已触发一次 \n（updateStatusBox），各分组再以 \n 续行。
          text = `已处理：${hitLines.join('\n')}`;
        } else {
          // v2.1.8 N3-1：hitScenarios.displayIndex 与场景管理 UI 列表序号统一（spec.md §五 N3-D1）
          const arr = Array.isArray(pr.hitScenarios) ? pr.hitScenarios : [];
          // v3.0.3 PR-E：状态框命中明细按「银行渠道枚举值:场景序号」分组换行展示。
          //   新数据（双维路径）每条 hitScenarios 带非空 channelName → 按 channelName 分组（保持首次出现顺序），
          //     每组一行 `渠道名:序号1、序号2`，组间 \n，包进括号：`（场景\nJPM:1、3\nCITI:2）`。
          //   🔴 换行陷阱（updateStatusBox 对全角「：」自动补 \n）：分组分隔必须用半角 ':'，绝不用全角「：」。
          //   fallback：旧 processingResult 持久化数据 / legacy 单维路径无 channelName → 保持原格式 `（场景 1、3）` 零变化。
          let idsText = '';
          if (arr.length > 0 && arr.every((s) => s.channelName)) {
            const groups = new Map(); // channelName → [displayIndex...]（保持首次出现顺序）
            arr.forEach((s) => {
              if (!groups.has(s.channelName)) groups.set(s.channelName, []);
              groups.get(s.channelName).push(s.displayIndex);
            });
            const lines = [];
            groups.forEach((indexes, channelName) => {
              lines.push(`${channelName}:${indexes.join('、')}`);
            });
            idsText = `（场景\n${lines.join('\n')}）`;
          } else if (arr.length > 0) {
            idsText = `（场景 ${arr.map((s) => s.displayIndex).join('、')}）`;
          }
          // v3.0.7 需求1c：「已处理」分支移除「，N 警告」尾巴（警告仍写 error-report 不动）。
          text = `已处理：${pr.hitRowCount} 行命中${idsText}`;
        }
        // v3.0.7 需求A：「已处理」命中展示之后追加 R5 场景3/4 命中行——「场景启用就显示该行（含 0 条命中）」。
        //   每行格式 `场景名:N 条命中`，行前 \n 续行。对新（channelRegionHits）/旧（hitScenarios）两种命中格式统一生效（在 if/else 汇合后追加）。
        //   🔴 换行陷阱（updateStatusBox 第 614 行对全角「：」自动补 \n）：分隔冒号一律半角 ':'，绝不用全角「：」——
        //      否则「场景名」与「N 条命中」会被强制打断成两行（每场景 2 行 / 共 4 行），违背「每行独立成行、两行」诉求。
        //      与本分支既有 channelRegionHits / hitScenarios 多行展示的半角冒号防换行约定完全一致。
        //   🔴 纯展示：r5s3Enabled/r5s4Enabled/r5s3CleanupCount/r5s4BackfilledCount 均为 orchestrator 只读统计字段，不改任何对账值。
        //   向后兼容：字段缺失（旧持久化 / 旧 main）→ refreshBankStatementStatus 兜底为 false / 0 → enabled=false 不渲染该行（与 channelRegionHits 回退风格一致）。
        if (pr.r5s3Enabled) text += `\n中台加款单脏数据处理:${Number(pr.r5s3CleanupCount) || 0} 条命中`;
        if (pr.r5s4Enabled) text += `\n中台退款订单回填:${Number(pr.r5s4BackfilledCount) || 0} 条命中`;
        if (pr.skippedC3Count > 0) {
          text += ` · 跳过 ${pr.skippedC3Count} 个对账不平场景`;
        }
        // v3.0.7 需求1c：tone 不再因警告转 error，固定 success（警告不再进状态框文案，仍写 error-report）。
        tone = 'success';
      } else {
        // v2.1.9 N6 (T31, D18=a)：删冒号后冗余 \n（同上）；`\n不平账结果表：` 是行间换行保留
        // v2.1.16 A5：批量合并多文件 → 显示「N 个文件合并 M 行」；单文件沿用「文件名（M 行）」
        const fileCount = Number(bs.sourceFileCount) || 1;
        // v3.0.0 需求1：状态框「渠道-地区」前缀。
        //   🔴 换行陷阱（renderer.js:596 updateStatusBox 对全角「：」自动补 \n）：
        //      前缀分隔必须用半角 ':'、组合间用顿号 '、'，绝不用全角「：」，否则前缀被换行打断。
        //   组合数：0 个 → 无前缀（兜底原文案）；1 个 → `CITI-HK:`；多个 → `CITI-HK、JPM-US:`（全列出、已去重+排序）。
        const combos = Array.isArray(bs.channelRegions) ? bs.channelRegions : [];
        const channelRegionPrefix = combos.length === 0 ? '' : `${combos.join('、')}:`;
        text = fileCount > 1
          ? `已导入：${channelRegionPrefix}${fileCount} 个文件合并（${bs.rowCount} 行）`
          : `已导入：${channelRegionPrefix}${bs.fileName}（${bs.rowCount} 行）`;
        if (gw) text += `\n不平账结果表：${gw.fileName}（${gw.rowCount} 行）`;
        tone = 'info';
      }
      // v3.0.0 需求2a：导入失败/跳过摘要并入状态框（去明细确认框后的信息落点）。
      //   追加在「主文案算完之后、updateStatusBox 之前」，对全部分支统一生效——
      //   尤其纯失败批次（无 bank ok，bs 为 null 走「欢迎使用」分支）也能渲染 issues。
      //   摘要为纯文本（buildImportIssuesSummary，半角冒号防换行打断），用 \n 接在主文案下方；
      //   含失败时 tone 升 'error'（覆盖原 tone，触发 updateStatusBox 的 error 视觉 + 日志上报）。
      const issues = state.bankStatementImportIssues;
      if (issues && issues.text) {
        text = `${text}\n${issues.text}`;
        if (issues.hasFailed) tone = 'error';
      }
      // v2.1.7 round 3 B5：走 updateStatusBox 入口（R3 wiring — 自动获中文「：」换行 + null 兜底）
      //   原现状：直写 textEl.textContent = text + dataset.tone = tone（漏 R3 replace 处理）
      //   spec §9.6.2
      if (updateStatus) updateStatusBox(elements.bankStatementStatusBox, text, tone);

      // 按钮 disabled 控制
      // v3.0.11 codex-P3 修复：导入按钮也受 inflight 闸约束——否则运行/导出期间的 UI 刷新（如切回本模块）会无条件复活导入按钮，
      //   用户点导入被主进程 op-lock 拒后其 finally 清掉共享 bankStatementInflight，导致运行/导出按钮中途复活。
      if (elements.bankStatementImportBtn) elements.bankStatementImportBtn.disabled = state.bankStatementInflight || flowBusy;
      updateBankStatementRunBtnDisabled();
      updateBankStatementExportButtonsDisabled();
    }

    function escapeHtml(value) {
      return String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;');
    }

    function buildImportIssuesSummary(results) {
      const list = Array.isArray(results) ? results : [];
      // 与 buildBatchImportSummaryHtml 完全一致的失败原因口径
      const statusLabel = {
        'ambiguous': '表头命中多张表，无法判定',
        'unrecognized': '未识别为预处理表',
        'read-error': '文件读取失败',
        'invalid': '文件校验失败'
      };
      const skipped = list.filter((r) => r && r.status === 'disabled');
      const failed = list.filter((r) => r && r.status !== 'ok' && r.status !== 'disabled');
      const parts = [];
      if (skipped.length > 0) {
        const names = skipped.map((r) => String(r.fileName || '')).join('、');
        parts.push(`跳过 ${skipped.length} 个: ${names}`);
      }
      if (failed.length > 0) {
        // 每文件「文件名: 失败原因」（半角冒号），原因取 message > statusLabel > status
        const items = failed.map((r) => {
          const reason = r.message || statusLabel[r.status] || r.status || '未知原因';
          return `${String(r.fileName || '')}: ${reason}`;
        }).join('、');
        parts.push(`失败 ${failed.length} 个: ${items}`);
      }
      // 跳过/失败两段各占一行（\n，CSS white-space: pre-wrap 渲染）；
      // 段内一律半角冒号，避开 updateStatusBox 对全角「：」的强制换行。
      return { text: parts.join('\n'), hasFailed: failed.length > 0 };
    }

    function buildLinkedImportSummary(results) {
      const list = Array.isArray(results) ? results : [];
      // 链接表 tableKey → 中文表库名（与 renderer-dialogs.js LINKED_TABLE_LABELS 同口径，避免漂移）。
      const LINKED_TABLE_LABELS = {
        'bank-deposit': '银行对账单表',
        'gateway-bill': '网关对账单表库',
        'mid-allocation': '中台调拨订单表库',
        'fx-settlement': '外汇交割表库',
        'fx-option': '外汇期权表库'
      };
      const linkedOks = list.filter((r) => r && r.status === 'ok' && r.outcome === 'linked');
      if (linkedOks.length === 0) return '';
      // 每文件一行「文件名 → 表库名（N 行）」；行间 \n，段内半角字符（无全角「：」，避开 updateStatusBox 强制换行）。
      const lines = linkedOks.map((r) => {
        const label = LINKED_TABLE_LABELS[r.tableKey] || r.tableKey || '';
        const cnt = Number(r.rowCount) || 0;
        return `${String(r.fileName || '')} → ${label}（${cnt} 行）`;
      });
      return `已存入链接表 ${linkedOks.length} 个:\n${lines.join('\n')}`;
    }

    function buildAlsoLinkedSummary(results) {
      const list = Array.isArray(results) ? results : [];
      const alsoLinkedOks = list.filter((r) =>
        r && r.status === 'ok' && r.outcome === 'processed'
        && r.alsoLinked && !r.alsoLinked.error);
      if (alsoLinkedOks.length === 0) return '';
      const lines = alsoLinkedOks.map((r) => {
        const cnt = Number(r.alsoLinked.rowCount) || 0;
        return `${String(r.fileName || '')}:${cnt} 行已同时存入银行对账单表链接表`;
      });
      return lines.join('\n');
    }

    function buildAlsoLinkedFailureSummary(results) {
      const list = Array.isArray(results) ? results : [];
      const fails = list.filter((r) =>
        r && r.status === 'ok' && r.outcome === 'processed' && r.alsoLinked && r.alsoLinked.error);
      if (fails.length === 0) return '';
      return fails.map((r) =>
        `${String(r.fileName || '')}:已对账，但银行对账单表链接表落库失败:${r.alsoLinked.error}（请重新导入该文件）`
      ).join('\n');
    }

    function formatBankStatementImportProgress(ev) {
      if (!ev || typeof ev !== 'object') return null;
      if (ev.stage === 'reading') {
        const idx = Number.isFinite(ev.fileIndex) ? ev.fileIndex + 1 : null;
        const total = Number.isFinite(ev.fileCount) ? ev.fileCount : null;
        if (idx && total && total > 1) return `正在导入第 ${idx}/${total} 个文件…`;
        return '正在导入文件…';
      }
      return null;
    }

    function formatBankStatementRunProgress(ev) {
      if (!ev || typeof ev !== 'object') return null;
      const STAGE_LABELS = {
        prepare: '正在准备数据…',
        // v3.0.11 需求3（批2 · run 数据准备让出）：准备阶段细分文案（与 main.js yieldRun stage key 一一对应）。
        //   （codex-P2 补强：linked-table 写入已纳入 op-lock → run 持锁期间并发改表被挡 → 读取间让出仍快照一致，故三处让出齐备。）
        'prepare-clone-bank': '正在准备数据（银行流水）…',
        'prepare-gw': '正在准备数据（网关账单）…',
        'prepare-linked': '正在准备数据（关联表）…',
        reconcile: '正在执行对账…'
      };
      const ROUND_LABELS = {
        R1: '正在匹配对账号（R1）…',
        R2: '正在执行场景调度（R2）…',
        'R3.5': '正在校验 DBS-Charge 资金（R3.5）…',
        R4: '正在校验资金性质（R4）…',
        R5s2: '正在回填资金划转（R5）…',
        R5s2b: '正在回填线下调拨（R5）…',
        R5s3: '正在生成剔除清单（R5）…',
        // v3.0.12：R5 退款回填后、M2M 异常-人工判断检测后各补一次让出（编排器 yieldTick），对应进度文案。
        R5s4: '正在回填退款订单（R5）…',
        M2M: '正在排查多对多异常（人工复核）…'
      };
      if (ev.stage && STAGE_LABELS[ev.stage]) return STAGE_LABELS[ev.stage];
      if (ev.round && ROUND_LABELS[ev.round]) return ROUND_LABELS[ev.round];
      return null;
    }
    function bind(id, handler) {
      const element = elements[id];
      if (!element) return;
      element.addEventListener('click', handler);
      removers.push(() => element.removeEventListener('click', handler));
    }
    bind('bankStatementImportBtn', handleBankStatementBatchImport);
    bind('bankStatementRunBtn', handleBankStatementRunRouted);
    bind('bankStatementExportBtn', handleBankStatementExport);
    bind('bankStatementScenarioBtn', () => { if (live() && ui.openScenarios) ui.openScenarios({ owner }); });
    bind('bankStatementLinkedTableBtn', () => { if (live() && ui.openLinkedTables) ui.openLinkedTables({ owner }); });
    removers.push(sharedReconSession.subscribe((event) => {
      if (disposed || event.outcome === 'cancelled') return;
      ++gatewayGeneration;
      gatewayView.stale = true;
      if (event.outcome === 'succeeded') gatewayView.result = null;
      render(false);
      if (live()) void refreshGatewayStatus();
    }));
    return Object.freeze({
      async enter() {
        if (disposed) return { status: 'stale' };
        active = true;
        const generation = ++renderGeneration;
        render(false);
        const results = await Promise.all([refreshBankStatementStatus({ updateStatus: false }), refreshGatewayStatus()]);
        if (!live(generation)) return { status: 'stale' };
        return { status: results.every(Boolean) ? 'ready' : 'error' };
      },
      leave({ reason = 'navigation' } = {}) {
        if (disposed) return { status: 'left' };
        const result = ui.modalHost?.closeOwner(owner, reason);
        if (result?.status === 'blocked') return { status: 'blocked' };
        active = false;
        ++renderGeneration;
        ++statusGeneration;
        ++gatewayGeneration;
        needsRefresh = true;
        gatewayView.stale = true;
        return { status: 'left' };
      },
      invalidate(event) {
        if (disposed || !event || (event.revision && event.revision <= lastRevision)) return;
        if (event.revision) lastRevision = event.revision;
        const scope = event.kind === 'scenarios-resync-required' ? event.resyncScope : event.invalidationScope;
        if (!Array.isArray(scope)) return;
        const definite = event.kind === 'scenarios-changed';
        if (scope.includes('bank-statement')) {
          ++resultEpoch;
          ++statusGeneration;
          uncertain = true;
          needsRefresh = true;
          if (definite) {
            resultFeedbackInvalidated = true;
            state.processingResult = null;
            state.bankStatementExport = null;
          }
          render(definite);
          if (live()) void refreshBankStatementStatus({ updateStatus: definite });
        }
        if (scope.includes('recon-id-fix')) {
          ++gatewayGeneration;
          gatewayView.stale = true;
          if (definite) gatewayView.result = null;
          render(false);
          if (live()) void refreshGatewayStatus();
        }
      },
      refreshStatus: refreshBankStatementStatus,
      refreshGatewayStatus,
      commands: Object.freeze({
        import: handleBankStatementBatchImport, run: handleBankStatementRunRouted, export: handleBankStatementExport,
        runGateway: handleBankStatementGatewayReconRun,
        selectRunMode(mode) {
          if (!live() || state.bankStatementInflight || flowBusy || !['bank', 'gateway'].includes(mode)) return { status: 'blocked' };
          state.bankStatementProcessRunMode = mode;
          render(false);
          return { status: 'ok' };
        }
      }),
      dispose() {
        if (disposed) return;
        disposed = true;
        active = false;
        ++renderGeneration;
        ++statusGeneration;
        ++gatewayGeneration;
        ++resultEpoch;
        [...progressRemovers].forEach((remove) => remove());
        removers.splice(0).forEach((remove) => { try { remove(); } catch (error) { reportError(error); } });
        ui.modalHost?.closeOwner(owner, 'dispose');
      }
    });
  }
  const exported = Object.freeze({ createBankStatementController });
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
  if (root) root.BankStatementController = exported;
})(typeof window !== 'undefined' ? window : null);
