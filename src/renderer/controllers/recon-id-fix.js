'use strict';

(function installReconIdFixController(root) {
  // api 仅接设置写方法；结果及会话始终从 sharedReconSession 读取。
  function createReconIdFixController({ api = {}, panel, config = {}, sharedReconSession, ui = {} } = {}) {
    if (!panel || !sharedReconSession || !config.scenarios) throw new TypeError('ReconID 控制器缺少领域依赖');
    const elements = Object.fromEntries([
      'reconIdFixBillCategorySelect', 'reconIdFixScenarioRow', 'reconIdFixManageScenariosBtn',
      'reconIdFixImportBtn', 'reconIdFixScenarioSelect', 'reconIdFixRunBtn', 'reconIdFixExportBtn', 'reconIdFixStatusBox'
    ].map((id) => [id, panel.querySelector(`#${id}`)]));
    const state = {
      reconIdFixSession: null, reconIdFixResult: null, reconIdFixExport: null,
      reconIdFixSelectedScenarioId: null, reconIdFixScenarios: [],
      reconIdFixBillCategory: config.initialBillCategory === 'business' ? 'business' : 'gateway'
    };
    const owner = 'recon-id-fix';
    const removers = [];
    let active = false;
    let disposed = false;
    let renderGeneration = 0;
    let statusGeneration = 0;
    let scenariosGeneration = 0;
    let resultEpoch = 0;
    let uncertain = true;
    let busy = false;
    let needsRefresh = true;
    // 结果清空与DOM重绘可能分属不同页面代次；隐藏时保留待重绘事实。
    let resultFeedbackInvalidated = false;
    let lastStatusFeedback = { text: '欢迎使用小助手', tone: 'neutral' };
    let statusReadFeedback = null;
    let lastRevision = 0;
    const live = (generation = renderGeneration) => !disposed && active && generation === renderGeneration;
    const reportError = (error) => { if (ui.reportError) ui.reportError(error); };
    function writeStatusBox(element, text, tone) {
      if (!live() || !element) return;
      if (ui.status) ui.status(element, text, tone);
      else { element.textContent = text; element.dataset.tone = tone; }
    }
    function updateStatusBox(element, text, tone) {
      if (!live() || !element) return;
      // 业务或场景读取反馈已接替状态框，旧session错误不再拥有恢复资格。
      statusReadFeedback = null;
      lastStatusFeedback = { text, tone };
      writeStatusBox(element, text, tone);
    }
    function alert(message, options, generation = renderGeneration) {
      if (!live(generation) || !ui.alert || !ui.modalHost) return;
      return ui.modalHost.openRoot(() => ui.alert(message, options), { owner });
    }
    function render(updateStatus = true) {
      if (!live()) return;
      updateReconIdFixUi({ updateStatus });
      if (updateStatus) resultFeedbackInvalidated = false;
      if (elements.reconIdFixImportBtn) elements.reconIdFixImportBtn.disabled ||= busy;
      if (elements.reconIdFixRunBtn) elements.reconIdFixRunBtn.disabled ||= busy || uncertain || needsRefresh;
      if (elements.reconIdFixExportBtn) elements.reconIdFixExportBtn.disabled ||= busy || uncertain || needsRefresh;
      if (elements.reconIdFixBillCategorySelect) {
        elements.reconIdFixBillCategorySelect.value = state.reconIdFixBillCategory || '';
        elements.reconIdFixBillCategorySelect.disabled = busy;
      }
      if (elements.reconIdFixScenarioSelect) {
        const category = state.reconIdFixBillCategory === 'gateway' ? 'gateway-recon-id-fix'
          : state.reconIdFixBillCategory === 'business' ? 'recon-id-fix' : null;
        const hasChoices = !!category && state.reconIdFixScenarios.some(scenario => scenario.category === category);
        elements.reconIdFixScenarioSelect.disabled = busy || !hasChoices;
      }
    }
    function markStale(definite) {
      ++resultEpoch;
      ++statusGeneration;
      uncertain = true;
      needsRefresh = true;
      if (definite) {
        resultFeedbackInvalidated = true;
        state.reconIdFixResult = null;
        state.reconIdFixExport = null;
      }
      render(definite);
    }
    async function refreshReconIdFixStatus({ updateStatus = true } = {}) {
      if (!live()) { needsRefresh = true; return false; }
      const generation = renderGeneration;
      const request = ++statusGeneration;
      try {
        const status = await sharedReconSession.sessionStatus();
        if (!live(generation) || request !== statusGeneration) return false;
        if (!status || status.status !== 'ok') throw new Error(status?.message || '');
        const lostResult = !status.hasResult && !!(state.reconIdFixResult || state.reconIdFixExport);
        state.reconIdFixSession = status.hasFile ? { fileName: status.fileName, sheetCounts: status.sheetCounts || null } : null;
        state.reconIdFixResult = status.hasResult ? {
          fixedRowCount: Number(status.resultStats?.fixedRowCount || 0),
          warningCount: Number(status.resultStats?.warningCount || 0),
          unmatchedRowCount: Number(status.resultStats?.unmatchedRowCount || 0)
        } : null;
        // 不确定通知并不表示 Main 已清结果；保留仍有效的 renderer-only 导出反馈。
        if (!status.hasResult) state.reconIdFixExport = null;
        uncertain = false;
        needsRefresh = false;
        const replaceFeedback = updateStatus || lostResult || resultFeedbackInvalidated;
        const previousFeedback = statusReadFeedback;
        render(replaceFeedback);
        if (!replaceFeedback && previousFeedback) {
          updateStatusBox(elements.reconIdFixStatusBox, previousFeedback.text, previousFeedback.tone);
        }
        return true;
      } catch (error) {
        if (!live(generation) || request !== statusGeneration) return false;
        uncertain = true;
        needsRefresh = true;
        render(false);
        // 读取错误只暂时占据状态框；有效成功后恢复原反馈，确定失效则按Main事实重绘。
        statusReadFeedback = lastStatusFeedback;
        writeStatusBox(elements.reconIdFixStatusBox,
          error.message ? `对账单修复状态读取失败：${error.message}` : '对账单修复状态读取失败', 'error');
        reportError(error);
        return false;
      }
    }
    async function reloadReconIdFixScenarios({ updateStatus = false } = {}) {
      if (!live()) { needsRefresh = true; return false; }
      const generation = renderGeneration;
      const request = ++scenariosGeneration;
      const category = state.reconIdFixBillCategory === 'gateway' ? 'gateway-recon-id-fix'
        : state.reconIdFixBillCategory === 'business' ? 'recon-id-fix' : null;
      try {
        const result = category ? await config.scenarios.list() : { status: 'ok', scenarios: [] };
        if (!live(generation) || request !== scenariosGeneration) return false;
        if (!result || result.status !== 'ok' || !Array.isArray(result.scenarios)) throw new Error(result?.message || '');
        state.reconIdFixScenarios = result.scenarios.filter((scenario) => scenario.category === category);
        if (!state.reconIdFixScenarios.some((scenario) => scenario.id === state.reconIdFixSelectedScenarioId)) {
          state.reconIdFixSelectedScenarioId = state.reconIdFixScenarios[0]?.id ?? null;
        }
        renderReconIdFixScenarioSelect();
        render(updateStatus);
        return true;
      } catch (error) {
        if (!live(generation) || request !== scenariosGeneration) return false;
        state.reconIdFixScenarios = [];
        state.reconIdFixSelectedScenarioId = null;
        renderReconIdFixScenarioSelect();
        render(false);
        updateStatusBox(elements.reconIdFixStatusBox,
          error.message ? `对账单修复场景读取失败：${error.message}` : '对账单修复场景读取失败', 'error');
        reportError(error);
        return false;
      }
    }
    async function action(kind, operation) {
      if (!live() || busy) return { status: 'blocked' };
      const generation = renderGeneration;
      busy = true;
      render(false);
      try { return await operation(generation); }
      catch (error) { alert(`${kind}失败：${error?.message || error}`, undefined, generation); reportError(error); }
      finally {
        busy = false;
        // 离页只结束前端 busy；后台操作不被伪装成取消。
        if (!live(generation)) {
          needsRefresh = true;
          if (live()) void refreshReconIdFixStatus({ updateStatus: false });
        }
        if (live()) render(false);
      }
    }
    function handleReconIdFixImport() {
      return action('导入', async (generation) => {
        const subMode = state.reconIdFixBillCategory === 'gateway' ? 'gateway' : 'business';
        const result = await sharedReconSession.import({ subMode });
        if (!live(generation) || !result || result.status === 'cancelled') return result;
        if (result.status !== 'ok') {
          const detail = result.status === 'invalid' && Array.isArray(result.detailLines) && result.detailLines.length
            ? `\n\n${result.detailLines.slice(0, 5).join('\n')}` : '';
          alert(`导入失败：${result.message || (result.status === 'invalid' ? '文件校验未通过' : '未知错误')}${detail}`, undefined, generation);
          return result;
        }
        await refreshReconIdFixStatus();
        return result;
      });
    }
    function handleReconIdFixRun() {
      if (state.reconIdFixSelectedScenarioId === null) { alert('请先选择场景'); return; }
      if (!state.reconIdFixSession) { alert('请先点击"导入文件"'); return; }
      if (uncertain) return { status: 'blocked' };
      return action('运行', async (generation) => {
        const result = await sharedReconSession.run({ scenarioId: state.reconIdFixSelectedScenarioId, originModuleId: owner });
        if (!live(generation)) return result;
        if (!result || result.status !== 'ok') alert(`运行失败：${result?.message || '未知错误'}`, undefined, generation);
        await refreshReconIdFixStatus();
        return result;
      });
    }
    function handleReconIdFixExport() {
      if (uncertain || !state.reconIdFixResult) return { status: 'blocked' };
      return action('导出', async (generation) => {
        const epoch = resultEpoch;
        const result = await sharedReconSession.export();
        if (!live(generation) || epoch !== resultEpoch) return result;
        if (!result) { alert('导出失败：未知错误', undefined, generation); return; }
        if (result.status === 'cancelled') return result;
        if (result.status === 'empty') { alert(result.message || '本次运行无修复记录，未生成文件', undefined, generation); return result; }
        if (result.status !== 'ok') {
          alert(`导出失败：${result.message || '未知错误'}`, undefined, generation);
          await refreshReconIdFixStatus();
          return result;
        }
        state.reconIdFixExport = {
          mainFileName: result.mainFileName || '', mainFilePath: result.mainFilePath || '',
          unmatchedFileName: result.unmatchedFileName || '', unmatchedFilePath: result.unmatchedFilePath || ''
        };
        render();
        return result;
      });
    }
    function handleReconIdFixBillCategoryChange(event) {
      const raw = event?.target?.value;
      const category = raw === 'business' || raw === 'gateway' ? raw : null;
      if (category === state.reconIdFixBillCategory) return;
      return action('切换账单类别', async (generation) => {
        state.reconIdFixBillCategory = category;
        state.reconIdFixSelectedScenarioId = null;
        state.reconIdFixSession = null;
        ++scenariosGeneration;
        markStale(true);
        try { await sharedReconSession.clearSession(); } catch (error) { reportError(error); }
        // 顺序保持：clear Main 后才持久化；离页不取消已开始的设置写入。
        try { await api.setReconIdFixBillCategory(category); } catch (error) { reportError(error); }
        if (!live(generation)) return;
        await reloadReconIdFixScenarios({ updateStatus: true });
        await refreshReconIdFixStatus();
      });
    }
    function renderReconIdFixScenarioSelect() {
      const select = elements.reconIdFixScenarioSelect;
      if (!select) return;
      // v2.1.0-beta.3 修订（用户反馈）：账单类别为空时场景下拉显示真空白（不显示 "请先在场景管理中创建" placeholder）
      const hasCategory = state.reconIdFixBillCategory === 'business' || state.reconIdFixBillCategory === 'gateway';
      if (!hasCategory) {
        // 档 1：账单类别为空 → 真空白（不变）
        select.innerHTML = '<option value=""></option>';
        select.disabled = true;
        select.value = '';
        return;
      }
      const scenarios = Array.isArray(state.reconIdFixScenarios) ? state.reconIdFixScenarios : [];
      if (scenarios.length === 0) {
        // 档 2：v2.1.5 N2 改 — 真空白（去掉"请先在场景管理中创建场景"提示）
        select.innerHTML = '<option value=""></option>';
        select.disabled = true;
        select.value = '';
        return;
      }
      // 档 3：v2.1.5 N2 改 — 直接列 scenarios（去掉"请选择场景"占位项）
      const opts = scenarios.map((s) => {
        const idStr = String(s.id);
        const name = String(s.name || '');
        // 简单 escape：避免 < / > / & / "
        const escapedName = name
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;');
        return `<option value="${idStr}">${escapedName}</option>`;
      }).join('');
      select.innerHTML = opts;
      select.disabled = false;
      // 同步 select.value 与 state（reloadReconIdFixScenarios fix1.2 已保证 scenarios 非空时
      // state.reconIdFixSelectedScenarioId 必有值，此处直接 select.value = desired 即可）
      const desired = state.reconIdFixSelectedScenarioId !== null
        ? String(state.reconIdFixSelectedScenarioId)
        : '';
      select.value = desired;
    }

    function updateReconIdFixUi({ updateStatus = true } = {}) {
      if (!elements.reconIdFixStatusBox) return;
      const session = state.reconIdFixSession;
      const result = state.reconIdFixResult;
      const exp = state.reconIdFixExport;
      const selectedId = state.reconIdFixSelectedScenarioId;
      const selectedScenario = selectedId !== null
        ? (state.reconIdFixScenarios || []).find((s) => s.id === selectedId)
        : null;
      const scenarioName = selectedScenario ? selectedScenario.name : '';

      let text;
      let tone = 'info';
      if (exp) {
        // Round 3：双文件导出时同时显示主+unmatched 文件名
        const parts = [];
        if (exp.mainFileName) parts.push(`主文件 ${exp.mainFileName}`);
        if (exp.unmatchedFileName) parts.push(`未匹配 ${exp.unmatchedFileName}`);
        text = parts.length > 0 ? `已导出 — ${parts.join(' / ')}` : '已导出';
        tone = 'success';
      } else if (result) {
        // Round 3：加 K 行未匹配档
        const unm = Number(result.unmatchedRowCount || 0);
        const baseText = `场景"${scenarioName}"运行完成；命中 ${result.fixedRowCount} 行修复，${result.warningCount} 行警告`;
        text = unm > 0 ? `${baseText}，${unm} 行未匹配` : baseText;
        tone = result.warningCount > 0 ? 'error' : 'success';
      } else if (session) {
        const counts = session.sheetCounts || {};
        text = `已导入 ${session.fileName}（${counts.business || 0} 行业务账单 / ${counts.opp || 0} 行对手账单）；请点击"开始运行"`;
        tone = 'info';
      } else if (selectedScenario) {
        text = `已选场景"${scenarioName}"，请点击"导入文件"`;
        tone = 'neutral';
      } else {
        text = '欢迎使用小助手';
        tone = 'neutral';
      }
      // v2.1.7 round 3 B5：走 updateStatusBox 入口（R3 wiring — spec §9.6.2）
      if (updateStatus) updateStatusBox(elements.reconIdFixStatusBox, text, tone);

      // 按钮可用性（spec §七 + Q4 决策）
      if (elements.reconIdFixImportBtn) elements.reconIdFixImportBtn.disabled = false;
      if (elements.reconIdFixRunBtn) {
        elements.reconIdFixRunBtn.disabled = !(session && selectedId !== null);
      }
      if (elements.reconIdFixExportBtn) {
        elements.reconIdFixExportBtn.disabled = !result;
      }
      // v2.1.0-beta.3 T4：账单类别为空时强制 disable 所有动作按钮 + 隐藏场景行
      // updateReconIdFixPanelVisibility 是最后一道 override（覆盖上面默认逻辑）
      updateReconIdFixPanelVisibility();
    }

    function updateReconIdFixPanelVisibility() {
      // v2.1.0-beta.3 T11 修订（按用户反馈）：账单类别为空时也保持所有按钮显示（按 beta.2 结构），仅 disabled，
      //   不再隐藏行 2 wrapper；行 2 始终 visible。
      const cat = state.reconIdFixBillCategory;
      const hasCategory = cat === 'business' || cat === 'gateway';

      // 账单类别为空时强制禁用所有按钮（覆盖 updateReconIdFixUi 的默认 enable 逻辑）
      if (!hasCategory) {
        if (elements.reconIdFixImportBtn) elements.reconIdFixImportBtn.disabled = true;
        if (elements.reconIdFixRunBtn) elements.reconIdFixRunBtn.disabled = true;
        if (elements.reconIdFixExportBtn) elements.reconIdFixExportBtn.disabled = true;
        if (elements.reconIdFixManageScenariosBtn) elements.reconIdFixManageScenariosBtn.disabled = true;
      } else {
        // 类别选定 → 场景管理按钮 enable；其他按钮（导入/运行/导出）由 updateReconIdFixUi 已设的状态决定
        if (elements.reconIdFixManageScenariosBtn) elements.reconIdFixManageScenariosBtn.disabled = false;
      }
    }    function bind(id, event, handler) {
      const element = elements[id];
      if (!element) return;
      element.addEventListener(event, handler);
      removers.push(() => element.removeEventListener(event, handler));
    }
    bind('reconIdFixImportBtn', 'click', handleReconIdFixImport);
    bind('reconIdFixRunBtn', 'click', handleReconIdFixRun);
    bind('reconIdFixExportBtn', 'click', handleReconIdFixExport);
    bind('reconIdFixBillCategorySelect', 'change', handleReconIdFixBillCategoryChange);
    bind('reconIdFixScenarioSelect', 'change', (event) => {
      if (!live() || busy) return;
      const id = Number.parseInt(event.target.value, 10);
      state.reconIdFixSelectedScenarioId = Number.isFinite(id) ? id : null;
      render();
    });
    bind('reconIdFixManageScenariosBtn', 'click', () => {
      if (live() && ui.openScenarios) ui.openScenarios({ owner, category: state.reconIdFixBillCategory === 'gateway' ? 'gateway-recon-id-fix' : 'recon-id-fix' });
    });
    removers.push(sharedReconSession.subscribe((event) => {
      if (disposed || event.outcome === 'cancelled') return;
      markStale(event.outcome === 'succeeded');
      if (live()) void refreshReconIdFixStatus({ updateStatus: true });
    }));
    return Object.freeze({
      async enter() {
        if (disposed) return { status: 'stale' };
        active = true;
        const generation = ++renderGeneration;
        render(false);
        const results = await Promise.all([reloadReconIdFixScenarios(), refreshReconIdFixStatus({ updateStatus: false })]);
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
        ++scenariosGeneration;
        needsRefresh = true;
        return { status: 'left' };
      },
      invalidate(event) {
        if (disposed || !event || (event.revision && event.revision <= lastRevision)) return;
        if (event.revision) lastRevision = event.revision;
        const scope = event.kind === 'scenarios-resync-required' ? event.resyncScope : event.invalidationScope;
        if (!Array.isArray(scope) || !scope.includes('recon-id-fix')) return;
        markStale(event.kind === 'scenarios-changed');
        if (live()) void refreshReconIdFixStatus({ updateStatus: event.kind === 'scenarios-changed' });
      },
      reloadScenarios: reloadReconIdFixScenarios,
      refreshStatus: refreshReconIdFixStatus,
      commands: Object.freeze({ import: handleReconIdFixImport, run: handleReconIdFixRun, export: handleReconIdFixExport, changeBillCategory: handleReconIdFixBillCategoryChange }),
      applyPreviewCategory(category) {
        if (!live() || !['business', 'gateway'].includes(category)) return;
        ++statusGeneration;
        ++scenariosGeneration;
        state.reconIdFixBillCategory = category;
        render(false);
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        active = false;
        ++renderGeneration;
        ++statusGeneration;
        ++scenariosGeneration;
        ++resultEpoch;
        removers.splice(0).forEach((remove) => { try { remove(); } catch (error) { reportError(error); } });
        ui.modalHost?.closeOwner(owner, 'dispose');
      }
    });
  }
  const exported = Object.freeze({ createReconIdFixController });
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
  if (root) root.ReconIdFixController = exported;
})(typeof window !== 'undefined' ? window : null);
