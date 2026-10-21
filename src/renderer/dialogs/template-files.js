(function initTemplateFilesDialogs(global) {
  'use strict';

  const TYPE_LABELS = Object.freeze({ output: '输出模板', enum: '枚举字典', input: '输入原表', link: '链接表', reference: '示例参考' });
  const TYPE_ORDER = Object.freeze(['output', 'enum', 'input', 'link', 'reference']);
  const READ_MODES = Object.freeze({
    runtime: { label: '运行时读取', tone: 'active', order: 0 },
    cached: { label: '缓存读取', tone: 'active', order: 1 },
    locked: { label: '哈希锁定', tone: 'locked', order: 2 },
    disabled: { label: '未启用', tone: 'off', order: 3 },
    sample: { label: '结构样例', tone: 'neutral', order: 4 },
    generated: { label: '程序生成', tone: 'neutral', order: 5 },
    reference: { label: '参考文件', tone: 'neutral', order: 6 }
  });
  const UNKNOWN_READ_MODE = Object.freeze({ label: '未知', tone: 'neutral', order: 99 });
  const BINDING_READ = Object.freeze({ runtime: '运行时读取', cached: '缓存读取', locked: '哈希锁定', none: '不读取' });
  const CHECK_ICONS = Object.freeze({ pass: '✓', fail: '✕', warn: '!', info: '·' });
  const CHECK_TEXT = Object.freeze({ pass: '通过', fail: '未通过', warn: '提示', info: '说明' });

  function formatBytes(value) {
    const bytes = Number(value);
    if (value === null || value === undefined || !Number.isFinite(bytes) || bytes < 0) return '-';
    if (bytes < 1024) return `${bytes.toFixed(0)} B`;
    const units = ['KB', 'MB', 'GB'];
    let size = bytes / 1024;
    let unitIndex = 0;
    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex += 1;
    }
    return `${size >= 10 ? size.toFixed(1) : size.toFixed(2)} ${units[unitIndex]}`;
  }

  function columnLetter(index) {
    let value = index + 1;
    let text = '';
    while (value > 0) {
      const remainder = (value - 1) % 26;
      text = String.fromCharCode(65 + remainder) + text;
      value = Math.floor((value - 1) / 26);
    }
    return text;
  }

  const extensionOf = (fileName) => (String(fileName || '').split('.').pop() || '').toLowerCase();
  const readModeOf = (resource) => READ_MODES[resource?.readMode] || UNKNOWN_READ_MODE;
  const errorText = (error, fallback) => (error && error.message ? String(error.message) : fallback);
  // 用户版本在当前程序下不可用的两种情形：不兼容（契约不符、文件缺失或被改动，需恢复默认或重新导入）；
  // 暂不可用（运行环境异常导致复核未完成，稍后会重新复核）。可用时返回 null。
  const UNAVAILABLE = Object.freeze({
    failed: { label: '不兼容', tone: 'danger', fallback: '与本版程序不兼容', alert: '不可用', advice: '请恢复默认或导入兼容的新版本' },
    unverified: { label: '暂不可用', tone: 'locked', fallback: '兼容复核未完成，请稍后重试', alert: '暂不可用', advice: '请稍后重试' }
  });
  function availabilityOf(version) {
    const kind = UNAVAILABLE[version?.validation];
    return kind ? { state: version.validation, ...kind, title: version.validationMessage || kind.fallback } : null;
  }

  function createTemplateFilesDialogs({ api, modalBridge, modules: MODULES, ui }) {
    const { createConfirmDialog } = ui;
    const escapeHtml = (value) => ui.escapeHtml(value === null || value === undefined ? '' : value);
    const moduleEntries = Object.values(MODULES || {}).map((module) => [module.id, module.name]);
    const moduleNames = new Map(moduleEntries);
    const moduleName = (moduleId) => moduleNames.get(moduleId) || moduleId;

    // pane 由设置弹窗持有；本视图只管理自身的读取代次、子弹窗与订阅。
    function mountTemplateFiles(pane, { getParentHandle }) {
      const state = {
        resources: [],
        excluded: [],
        loaded: false,
        loading: null,
        query: '',
        moduleId: '',
        type: '',
        status: '',
        selectedId: '',
        detail: null,
        tab: 'fields',
        sheetIndex: 0,
        view: 'browser',
        listRequestId: 0,
        detailRequestId: 0,
        historyRequestId: 0,
        destroyed: false,
        queryTimer: null
      };
      const resourceApi = api.templateResources || null;
      const canListChanges = typeof resourceApi?.listChanges === 'function';

      pane.innerHTML = `
        <div class="template-center-feedback" data-role="template-feedback" role="status" aria-live="polite" hidden></div>
        <div class="template-center-browser" data-template-view="browser">
          <header class="template-center-header">
            <div class="template-center-header-copy">
              <h3 id="templateCenterHeading" class="app-settings-pane-heading">模板文件</h3>
              ${canListChanges ? '<button class="template-center-icon-button" type="button" data-action="open-history" title="变更记录" aria-label="变更记录">☰</button>' : ''}
            </div>
          </header>
          <div class="template-center-filters" aria-label="模板筛选">
            <label class="template-center-field">
              <span>搜索</span>
              <input type="search" data-filter="query" autocomplete="off" placeholder="名称或字段" />
            </label>
            <label class="template-center-field">
              <span>模块</span>
              <select data-filter="module"><option value="">全部模块</option></select>
            </label>
            <label class="template-center-field">
              <span>类型</span>
              <select data-filter="type">
                <option value="">全部类型</option>
                ${TYPE_ORDER.map((type) => `<option value="${type}">${TYPE_LABELS[type]}</option>`).join('')}
              </select>
            </label>
            <label class="template-center-field">
              <span>状态</span>
              <select data-filter="status"><option value="">全部状态</option></select>
            </label>
          </div>
          <div class="template-center-workspace">
            <aside class="template-center-list-panel" aria-label="模板列表">
              <div class="template-center-panel-caption">
                <span>模板列表</span>
                <span data-role="template-count">0 个</span>
              </div>
              <div class="template-center-list" data-role="template-list">
                <div class="template-center-empty">切换到模板文件后加载</div>
              </div>
            </aside>
            <section class="template-center-detail" data-role="template-detail" aria-live="polite">
              <div class="template-center-detail-empty">请选择一个模板</div>
            </section>
          </div>
        </div>
        <section class="template-center-history" data-template-view="history" aria-labelledby="templateHistoryHeading" hidden>
          <header class="template-center-subview-header">
            <button class="template-center-icon-button" type="button" data-action="back-to-templates" title="返回模板列表" aria-label="返回模板列表">←</button>
            <h3 id="templateHistoryHeading" class="app-settings-pane-heading">变更记录</h3>
          </header>
          <div data-role="template-history"></div>
        </section>`;

      const feedbackEl = pane.querySelector('[data-role="template-feedback"]');
      const browserEl = pane.querySelector('[data-template-view="browser"]');
      const historyView = pane.querySelector('[data-template-view="history"]');
      const historyEl = pane.querySelector('[data-role="template-history"]');
      const listEl = pane.querySelector('[data-role="template-list"]');
      const countEl = pane.querySelector('[data-role="template-count"]');
      const detailEl = pane.querySelector('[data-role="template-detail"]');
      const queryInput = pane.querySelector('[data-filter="query"]');
      const moduleSelect = pane.querySelector('[data-filter="module"]');
      const typeSelect = pane.querySelector('[data-filter="type"]');
      const statusSelect = pane.querySelector('[data-filter="status"]');

      const alive = () => !state.destroyed && pane.isConnected;

      function requireApi(method) {
        if (!resourceApi || typeof resourceApi[method] !== 'function') throw new Error('模板文件服务暂不可用');
        return resourceApi;
      }

      function showFeedback(message, tone = 'info') {
        const text = String(message || '').trim();
        feedbackEl.hidden = !text;
        feedbackEl.textContent = text;
        feedbackEl.dataset.tone = tone;
        feedbackEl.setAttribute('role', tone === 'error' ? 'alert' : 'status');
      }

      // 版本可自带结构（用户版本）；内置版本使用资源本身读取到的结构。
      function structureOf(resource) {
        return {
          sheets: resource?.current?.sheets || resource?.sheets || [],
          enumValues: resource?.current?.enumValues || resource?.enumValues || null
        };
      }

      function modulesOf(resource) {
        return [...new Set((resource.bindings || []).map((binding) => binding.moduleId))];
      }

      // 当前版本不可用时详情顶部的提示：不兼容引导恢复默认或重新导入；复核未完成只提示稍后重试。
      function currentAlertHtml(current) {
        const unavailable = availabilityOf(current);
        if (!unavailable) return '';
        return `<div class="template-center-feedback template-center-inline-alert" data-tone="error" role="alert">当前版本 ${escapeHtml(current.label || '')} ${unavailable.alert}：${escapeHtml(unavailable.title)}。相关导出会中止，${unavailable.advice}。</div>`;
      }

      function highlight(text) {
        const value = String(text ?? '');
        const index = state.query ? value.toLowerCase().indexOf(state.query.toLowerCase()) : -1;
        if (index < 0) return escapeHtml(value);
        const end = index + state.query.length;
        return `${escapeHtml(value.slice(0, index))}<mark>${escapeHtml(value.slice(index, end))}</mark>${escapeHtml(value.slice(end))}`;
      }

      function matchingSheetIndex(resource) {
        if (!state.query || !resource) return 0;
        const query = state.query.toLowerCase();
        const index = structureOf(resource).sheets.findIndex((sheet) => (
          sheet.name.toLowerCase().includes(query) || sheet.headers.some((header) => header.toLowerCase().includes(query))
        ));
        return Math.max(0, index);
      }

      function matches(resource) {
        if (state.moduleId && !resource.bindings.some((binding) => binding.moduleId === state.moduleId)) return false;
        if (state.type && resource.type !== state.type) return false;
        if (state.status === 'replaceable' && !resource.capabilities?.importVersion) return false;
        if (state.status === 'user' && resource.current?.source !== 'user') return false;
        if (READ_MODES[state.status] && resource.readMode !== state.status) return false;
        if (state.query) {
          const structure = structureOf(resource);
          const haystack = [
            resource.name,
            resource.fileName,
            TYPE_LABELS[resource.type] || '',
            ...resource.bindings.flatMap((binding) => [moduleName(binding.moduleId), binding.use]),
            ...structure.sheets.flatMap((sheet) => [sheet.name, ...sheet.headers]),
            ...(structure.enumValues || [])
          ].join('\n').toLowerCase();
          if (!haystack.includes(state.query.toLowerCase())) return false;
        }
        return true;
      }

      function sortedVisible() {
        return state.resources
          .filter(matches)
          .sort((a, b) => (
            TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type)
            || readModeOf(a).order - readModeOf(b).order
            || a.name.localeCompare(b.name, 'zh-Hans-CN')
          ));
      }

      // 筛选项只列出当前清单中存在的模块与状态，避免选中后必然为空。
      function renderFilterOptions() {
        const usedModules = new Set(state.resources.flatMap(modulesOf));
        const moduleOptions = [
          ...moduleEntries.filter(([id]) => usedModules.has(id)),
          ...[...usedModules].filter((id) => !moduleNames.has(id)).map((id) => [id, id])
        ];
        moduleSelect.innerHTML = '<option value="">全部模块</option>' + moduleOptions
          .map(([id, name]) => `<option value="${escapeHtml(id)}">${escapeHtml(name)}</option>`).join('');
        moduleSelect.value = moduleOptions.some(([id]) => id === state.moduleId) ? state.moduleId : '';
        state.moduleId = moduleSelect.value;

        const versionOptions = [
          state.resources.some((resource) => resource.capabilities?.importVersion) ? '<option value="replaceable">可替换</option>' : '',
          state.resources.some((resource) => resource.current?.source === 'user') ? '<option value="user">用户版本</option>' : ''
        ].join('');
        const usedModes = new Set(state.resources.map((resource) => resource.readMode));
        const modeOptions = Object.entries(READ_MODES)
          .filter(([key]) => usedModes.has(key))
          .sort((a, b) => a[1].order - b[1].order)
          .map(([key, mode]) => `<option value="${key}">${mode.label}</option>`)
          .join('');
        statusSelect.innerHTML = '<option value="">全部状态</option>'
          + (versionOptions ? `<optgroup label="版本">${versionOptions}</optgroup>` : '')
          + (modeOptions ? `<optgroup label="读取方式">${modeOptions}</optgroup>` : '');
        statusSelect.value = statusSelect.querySelector(`option[value="${CSS.escape(state.status || '')}"]`) ? state.status : '';
        state.status = statusSelect.value;
      }

      function itemHtml(resource) {
        const active = resource.id === state.selectedId;
        const mode = readModeOf(resource);
        const modules = modulesOf(resource);
        const moduleText = modules.length === 1 ? moduleName(modules[0]) : `${modules.length} 个模块`;
        const user = resource.current?.source === 'user';
        // 当前用户版本不可用时在列表中直接标出，原因放在悬停提示中。
        const unavailable = user ? availabilityOf(resource.current) : null;
        const tagState = unavailable
          ? ` data-state="${unavailable.state}" title="${escapeHtml(unavailable.title)}"`
          : '';
        const tagText = user ? `${resource.current.label}${unavailable ? ` · ${unavailable.label}` : ''}` : '内置';
        return `
          <button class="template-center-item${active ? ' is-active' : ''}" type="button" data-resource-id="${escapeHtml(resource.id)}" aria-current="${active ? 'true' : 'false'}">
            <span class="template-center-item-row">
              <strong title="${escapeHtml(resource.fileName)}">${escapeHtml(resource.name)}</strong>
              <span class="template-center-version-tag" data-source="${user ? 'user' : 'builtin'}"${tagState}>${escapeHtml(tagText)}</span>
            </span>
            <span class="template-center-item-row">
              <span class="template-center-status" data-tone="${mode.tone}">${escapeHtml(mode.label)}</span>
              <span class="template-center-item-module" title="${escapeHtml(modules.map(moduleName).join('、'))}">${escapeHtml(moduleText)}</span>
            </span>
          </button>`;
      }

      function renderList(visible = sortedVisible()) {
        countEl.textContent = `${visible.length} 个`;
        const foot = state.excluded.length
          ? `<div class="template-center-list-foot"><button class="template-center-link" type="button" data-action="show-excluded">另有 ${state.excluded.length} 个文件未纳入</button></div>`
          : '';
        if (!visible.length) {
          listEl.innerHTML = `<div class="template-center-empty">没有符合条件的模板</div>${foot}`;
          return;
        }
        let html = '';
        let group = '';
        for (const resource of visible) {
          if (resource.type !== group) {
            group = resource.type;
            const count = visible.filter((item) => item.type === group).length;
            html += `<div class="template-center-group" aria-hidden="true"><span>${escapeHtml(TYPE_LABELS[group] || group)}</span><span>${count}</span></div>`;
          }
          html += itemHtml(resource);
        }
        listEl.innerHTML = html + foot;
      }

      function markSelected() {
        for (const item of listEl.querySelectorAll('.template-center-item')) {
          const active = item.dataset.resourceId === state.selectedId;
          item.classList.toggle('is-active', active);
          item.setAttribute('aria-current', active ? 'true' : 'false');
        }
      }

      function selectResource(resourceId, { revealInList = false } = {}) {
        if (!resourceId) return;
        if (resourceId !== state.selectedId) {
          state.selectedId = resourceId;
          state.tab = 'fields';
          state.sheetIndex = matchingSheetIndex(state.resources.find((resource) => resource.id === resourceId));
          state.detail = null;
          showFeedback('');
        }
        // 只更新选中标记，保留列表按钮及键盘焦点；目标不在当前列表（跳转时重置了筛选）才重建。
        if (listEl.querySelector(`[data-resource-id="${CSS.escape(resourceId)}"]`)) markSelected();
        else renderList();
        if (revealInList) {
          listEl.querySelector(`[data-resource-id="${CSS.escape(resourceId)}"]`)?.scrollIntoView({ block: 'nearest' });
        }
        loadDetail(resourceId);
      }

      function applyFilters() {
        // 列表返回前只记下条件，由 loadList 按条件选中，避免以空列表替换加载提示。
        if (!state.loaded) return;
        showFeedback('');
        const visible = sortedVisible();
        if (!visible.some((resource) => resource.id === state.selectedId)) {
          state.selectedId = visible[0]?.id || '';
          state.tab = 'fields';
          state.sheetIndex = matchingSheetIndex(visible[0]);
          state.detail = null;
          renderList(visible);
          loadDetail(state.selectedId);
          return;
        }
        if (state.query) state.sheetIndex = matchingSheetIndex(state.resources.find((resource) => resource.id === state.selectedId));
        renderList(visible);
        if (state.detail) renderDetail({ keepScroll: true });
      }

      async function loadList({ keepFeedback = false } = {}) {
        const requestId = ++state.listRequestId;
        if (!keepFeedback) showFeedback('');
        listEl.setAttribute('aria-busy', 'true');
        if (!state.loaded) listEl.innerHTML = '<div class="template-center-empty">正在加载模板…</div>';
        try {
          const result = await requireApi('list').list();
          if (requestId !== state.listRequestId || !alive()) return false;
          if (result?.status !== 'success' || !Array.isArray(result.resources)) {
            throw new Error(result?.message || '模板列表格式无效');
          }
          state.resources = result.resources;
          state.excluded = Array.isArray(result.excluded) ? result.excluded : [];
          state.loaded = true;
          renderFilterOptions();
          const visible = sortedVisible();
          if (!visible.some((resource) => resource.id === state.selectedId)) {
            state.selectedId = visible[0]?.id || '';
            state.tab = 'fields';
            state.sheetIndex = matchingSheetIndex(visible[0]);
            state.detail = null;
          }
          renderList(visible);
          await loadDetail(state.selectedId, { quiet: true });
          return true;
        } catch (error) {
          if (requestId !== state.listRequestId || !alive()) return false;
          const message = errorText(error, '模板列表加载失败');
          if (!state.loaded) listEl.innerHTML = `<div class="template-center-empty">${escapeHtml(message)}</div>`;
          showFeedback(`模板列表加载失败：${message}`, 'error');
          return false;
        } finally {
          if (requestId === state.listRequestId) listEl.removeAttribute('aria-busy');
        }
      }

      async function loadDetail(resourceId, { quiet = false } = {}) {
        const requestId = ++state.detailRequestId;
        if (!resourceId) {
          state.detail = null;
          renderDetail();
          return false;
        }
        const sameResource = state.detail?.id === resourceId;
        if (!quiet || !sameResource) detailEl.innerHTML = '<div class="template-center-detail-empty">正在加载模板详情…</div>';
        try {
          const result = await requireApi('get').get(resourceId);
          if (requestId !== state.detailRequestId || !alive()) return false;
          if (result?.status !== 'success' || !result.resource) throw new Error(result?.message || '模板详情加载失败');
          state.detail = result.resource;
          renderDetail({ keepScroll: sameResource });
          return true;
        } catch (error) {
          if (requestId !== state.detailRequestId || !alive()) return false;
          state.detail = null;
          detailEl.innerHTML = `<div class="template-center-detail-empty template-center-detail-error">${escapeHtml(errorText(error, '模板详情加载失败'))}</div>`;
          return false;
        }
      }

      function versionTimeText(version) {
        if (version.source === 'builtin') return version.appVersion ? `随 v${version.appVersion}` : '内置';
        return version.createdAt || '-';
      }

      function fieldsHtml(resource) {
        if (resource.readError) {
          return `<div class="template-center-empty template-center-detail-error">${escapeHtml(resource.readError)}</div>`;
        }
        const structure = structureOf(resource);
        if (structure.enumValues) {
          const rows = structure.enumValues.map((value, index) => (
            `<tr><td class="is-muted">${index + 1}</td><td>${highlight(value)}</td></tr>`
          )).join('');
          return `
            <p class="template-center-subhead">第 1 个 Sheet · 第 1 列 · ${structure.enumValues.length} 个值</p>
            <div class="template-center-table-wrap">
              <table class="template-center-table">
                <colgroup><col style="width: 64px" /><col /></colgroup>
                <thead><tr><th>序号</th><th>值</th></tr></thead>
                <tbody>${rows || '<tr><td colspan="2" class="is-muted">没有取值</td></tr>'}</tbody>
              </table>
            </div>`;
        }
        const sheets = structure.sheets;
        if (!sheets.length) return '<div class="template-center-empty">没有工作表</div>';
        const index = Math.min(state.sheetIndex, sheets.length - 1);
        const sheet = sheets[index];
        const chips = sheets.length > 1
          ? `<div class="template-center-chips" role="group" aria-label="工作表">${sheets.map((item, itemIndex) => (
            `<button class="template-center-chip" type="button" data-action="select-sheet" data-sheet-index="${itemIndex}" aria-pressed="${itemIndex === index}">${escapeHtml(item.name)} · ${item.headers.length}</button>`
          )).join('')}</div>`
          : '';
        const notes = [
          sheets.length === 1 ? `Sheet「${sheet.name}」` : '',
          `${sheet.headers.length} 列`,
          sheet.headerRow > 1 ? `表头在第 ${sheet.headerRow} 行` : '',
          sheet.dataRows ? `另有 ${sheet.dataRows} 行内容` : ''
        ].filter(Boolean).join(' · ');
        const rows = sheet.headers.length
          ? sheet.headers.map((header, column) => (
            `<tr><td class="template-center-col-letter">${columnLetter(column)}</td><td${header ? '' : ' class="is-muted"'}>${header ? highlight(header) : '（空列）'}</td></tr>`
          )).join('')
          : '<tr><td colspan="2" class="is-muted">没有表头</td></tr>';
        return `${chips}
          <p class="template-center-subhead">${escapeHtml(notes)}</p>
          <div class="template-center-table-wrap">
            <table class="template-center-table">
              <colgroup><col style="width: 64px" /><col /></colgroup>
              <thead><tr><th>列</th><th>字段</th></tr></thead>
              <tbody>${rows}</tbody>
            </table>
          </div>`;
      }

      function versionsHtml(resource) {
        const caps = resource.capabilities || {};
        const rows = (resource.versions || []).map((version) => {
          const builtin = version.source === 'builtin';
          const tasks = Array.isArray(version.tasks) ? version.tasks : [];
          const taskTitle = tasks.map((task) => `${task.id} ${task.state}`).join('、');
          // 用户版本不再符合当前程序契约（升级后或文件被改动）：保留为当前版本但标出原因，导出时由 Main 中止。
          // 复核未完成（运行环境异常）单独标为暂不可用，仍可点“启用”重试。
          const unavailable = availabilityOf(version);
          const incompatible = unavailable?.state === 'failed';
          const unavailableTitle = unavailable ? escapeHtml(unavailable.title) : '';
          let status;
          if (version.current && unavailable) status = `<span class="template-center-status" data-tone="${unavailable.tone}" title="${unavailableTitle}">当前 · ${unavailable.label}</span>`;
          else if (version.current) status = '<span class="template-center-status" data-tone="active">当前</span>';
          else if (unavailable) status = `<span class="template-center-status" data-tone="${unavailable.tone}" title="${unavailableTitle}">${unavailable.label}</span>`;
          else if (tasks.length) status = `<span class="template-center-status" data-tone="locked" title="${escapeHtml(taskTitle)}">任务使用中</span>`;
          else if (builtin) status = '<span class="template-center-status" data-tone="neutral">默认</span>';
          else status = '<span class="template-center-status" data-tone="off">可启用</span>';
          const statusSub = tasks.length
            ? `<div class="template-center-cell-sub" title="${escapeHtml(taskTitle)}">${tasks.length} 个任务</div>`
            : '';
          const deleteReason = version.current
            ? '当前版本不能删除'
            : (tasks.length ? `${tasks.length} 个任务正在使用` : `删除 ${version.label}`);
          const canDelete = !version.current && !tasks.length;
          const actions = [
            `<button class="template-center-icon-button" type="button" data-action="save-as" data-version-id="${escapeHtml(version.id)}" title="另存为" aria-label="另存为 ${escapeHtml(version.label)}"${caps.saveAs === false ? ' disabled' : ''}>💾</button>`,
            caps.setCurrent && !version.current
              ? `<button class="template-center-icon-button template-center-text-button" type="button" data-action="set-current" data-version-id="${escapeHtml(version.id)}" title="${unavailable ? unavailableTitle : (builtin ? '恢复为内置版本' : '设为当前版本')}"${incompatible ? ' disabled' : ''}>启用</button>`
              : '',
            caps.deleteVersion && !builtin
              ? `<button class="template-center-icon-button template-center-icon-button-danger" type="button" data-action="delete-version" data-version-id="${escapeHtml(version.id)}" title="${escapeHtml(deleteReason)}" aria-label="${escapeHtml(deleteReason)}"${canDelete ? '' : ' disabled'}>×</button>`
              : ''
          ].join('');
          return `
            <tr>
              <td><strong>${escapeHtml(version.label)}</strong><div class="template-center-cell-sub">${builtin ? '内置' : '用户'}</div></td>
              <td>
                <div class="template-center-file-name" title="${escapeHtml(version.fileName)}">${escapeHtml(version.fileName)}</div>
                <div class="template-center-cell-sub">${escapeHtml(formatBytes(version.size))}${version.validation === 'warning' ? ' · 有提示项' : ''}${unavailable ? ` · <span title="${unavailableTitle}">${escapeHtml(unavailable.title)}</span>` : ''}</div>
              </td>
              <td>${escapeHtml(versionTimeText(version))}</td>
              <td>${status}${statusSub}</td>
              <td><div class="template-center-row-actions">${actions}</div></td>
            </tr>`;
        }).join('');
        const note = !caps.importVersion && caps.importReason
          ? `<p class="template-center-note">${escapeHtml(caps.importReason)}</p>`
          : '';
        return `
          <div class="template-center-table-wrap">
            <table class="template-center-table is-wide">
              <colgroup><col style="width: 54px" /><col /><col style="width: 128px" /><col style="width: 100px" /><col style="width: 108px" /></colgroup>
              <thead><tr><th>版本</th><th>文件</th><th>时间</th><th>状态</th><th>操作</th></tr></thead>
              <tbody>${rows}</tbody>
            </table>
          </div>${note}`;
      }

      function usageHtml(resource) {
        const current = resource.current || {};
        const tasks = Array.isArray(resource.tasks) ? resource.tasks : [];
        const labelOfVersion = (versionId) => (resource.versions || []).find((version) => version.id === versionId)?.label || versionId;
        const currentLabel = `${current.label || '-'}${current.source === 'builtin' ? ' · 内置' : ''}`;
        const rows = resource.bindings.map((binding) => {
          const reads = binding.read !== 'none';
          const tone = !reads ? 'neutral' : (binding.read === 'locked' ? 'locked' : 'active');
          const pinned = reads
            ? tasks.filter((task) => task.moduleId === binding.moduleId && task.versionId !== current.id)
            : [];
          const effective = reads
            ? `<div>${escapeHtml(pinned.length ? `${currentLabel} · 新任务` : currentLabel)}</div>${pinned.map((task) => (
              `<div class="template-center-cell-sub" title="运行中的任务继续使用原版本">${escapeHtml(task.id)} ${escapeHtml(task.state)} · ${escapeHtml(labelOfVersion(task.versionId))}</div>`
            )).join('')}`
            : '<span class="is-muted">—</span>';
          return `
            <tr>
              <td>${escapeHtml(moduleName(binding.moduleId))}</td>
              <td>${escapeHtml(binding.use)}</td>
              <td><span class="template-center-status" data-tone="${tone}">${escapeHtml(BINDING_READ[binding.read] || binding.read)}</span></td>
              <td>${effective}</td>
            </tr>`;
        }).join('');
        return `
          <div class="template-center-table-wrap">
            <table class="template-center-table is-wide">
              <colgroup><col style="width: 24%" /><col /><col style="width: 98px" /><col style="width: 30%" /></colgroup>
              <thead><tr><th>模块</th><th>用途</th><th>读取</th><th>使用版本</th></tr></thead>
              <tbody>${rows}</tbody>
            </table>
          </div>`;
      }

      function infoHtml(resource) {
        const current = resource.current || {};
        const reads = ['runtime', 'cached', 'locked'].includes(resource.readMode);
        const nameOf = (resourceId) => state.resources.find((item) => item.id === resourceId)?.name || resourceId;
        const items = [
          ['文件名', escapeHtml(current.fileName || resource.fileName)],
          ['存放位置', `<span class="template-center-mono">${escapeHtml(current.location || resource.path)}</span>`],
          ['SHA-256', `<span class="template-center-mono">${escapeHtml(current.sha256 || '-')}</span>${current.sha256 ? `<button class="template-center-icon-button" type="button" data-action="copy" data-copy="${escapeHtml(current.sha256)}" title="复制" aria-label="复制 SHA-256">📋</button>` : ''}`]
        ];
        if (reads) {
          if (resource.cache) items.push(['缓存', escapeHtml(resource.cache)]);
          if (resource.failure) items.push(['读取失败', escapeHtml(resource.failure)]);
          if (resource.effect) items.push(['生效时机', escapeHtml(`${resource.effect}；运行中的任务不切换`)]);
        }
        if (resource.twin) {
          items.push(['内容相同', `<button class="template-center-link" type="button" data-action="goto" data-resource-id="${escapeHtml(resource.twin)}">${escapeHtml(nameOf(resource.twin))}</button>`]);
        }
        if (resource.currentTemplate) {
          items.push(['当前模板', `<button class="template-center-link" type="button" data-action="goto" data-resource-id="${escapeHtml(resource.currentTemplate)}">${escapeHtml(nameOf(resource.currentTemplate))}</button>`]);
        }
        items.push(['资源标识', `<span class="template-center-mono">${escapeHtml(resource.id)}</span>`]);
        return `<dl class="template-center-kv">${items.map(([label, value]) => `<dt>${escapeHtml(label)}</dt><dd>${value}</dd>`).join('')}</dl>`;
      }

      function tabContentHtml(resource) {
        if (state.tab === 'versions') return versionsHtml(resource);
        if (state.tab === 'usage') return usageHtml(resource);
        if (state.tab === 'info') return infoHtml(resource);
        return fieldsHtml(resource);
      }

      function renderDetail({ keepScroll = false } = {}) {
        const resource = state.detail;
        if (!resource || resource.id !== state.selectedId) {
          detailEl.innerHTML = `<div class="template-center-detail-empty">${state.loaded && !state.selectedId ? '没有可显示的模板' : '请选择一个模板'}</div>`;
          return;
        }
        const scrollTop = detailEl.scrollTop;
        const mode = readModeOf(resource);
        const caps = resource.capabilities || {};
        const current = resource.current || {};
        const modules = modulesOf(resource).map(moduleName).join('、');
        const tabs = [
          ['fields', structureOf(resource).enumValues ? '枚举值' : '字段', null],
          ['versions', '版本', (resource.versions || []).length],
          ['usage', '使用方', resource.bindings.length],
          ['info', '信息', null]
        ];
        const importTitle = caps.importVersion ? '导入新版本' : (caps.importReason || '不支持替换');
        detailEl.innerHTML = `
          <div class="template-center-detail-heading">
            <div>
              <h4 title="${escapeHtml(resource.fileName)}">${escapeHtml(resource.name)}</h4>
              <p>${escapeHtml(TYPE_LABELS[resource.type] || resource.type)} · ${escapeHtml(extensionOf(current.fileName || resource.fileName).toUpperCase())} · ${escapeHtml(formatBytes(current.size))}</p>
            </div>
            <div class="template-center-detail-actions">
              <button class="template-center-action" type="button" data-action="save-as" data-version-id="${escapeHtml(current.id || '')}" title="另存为当前版本"${caps.saveAs === false ? ' disabled' : ''}><span class="template-center-action-icon" aria-hidden="true">💾</span>另存为</button>
              <button class="template-center-action" type="button" data-action="import" title="${escapeHtml(importTitle)}"${caps.importVersion ? '' : ' disabled'}><span class="template-center-action-icon" aria-hidden="true">⤒</span>导入新版本</button>
              ${caps.restoreDefault ? '<button class="template-center-action" type="button" data-action="restore-default" title="恢复为内置版本"><span class="template-center-action-icon" aria-hidden="true">↺</span>恢复默认</button>' : ''}
            </div>
          </div>
          ${currentAlertHtml(current)}
          <div class="template-center-metadata">
            <div><span>读取方式</span><strong class="template-center-status" data-tone="${mode.tone}">${escapeHtml(mode.label)}</strong></div>
            <div><span>当前版本</span><strong>${escapeHtml(current.label || '-')} · ${current.source === 'user' ? '用户版本' : '内置'}</strong></div>
            <div><span>使用模块</span><strong title="${escapeHtml(modules)}">${escapeHtml(modules || '-')}</strong></div>
            <div><span>更新时间</span><strong>${escapeHtml(versionTimeText(current))}</strong></div>
          </div>
          <div class="template-center-tabs" role="tablist" aria-label="模板详情">
            ${tabs.map(([key, label, count]) => (
              `<button type="button" role="tab" id="templateTab-${key}" data-detail-tab="${key}" aria-selected="${state.tab === key}" aria-controls="templateTabPanel" tabindex="${state.tab === key ? '0' : '-1'}">${escapeHtml(label)}${count ? `<span class="template-center-tab-count">${count}</span>` : ''}</button>`
            )).join('')}
          </div>
          <div class="template-center-tab-panel" id="templateTabPanel" role="tabpanel" aria-labelledby="templateTab-${state.tab}">${tabContentHtml(resource)}</div>`;
        if (keepScroll) detailEl.scrollTop = scrollTop;
        const match = state.query && state.tab === 'fields' ? detailEl.querySelector('mark') : null;
        if (match) match.scrollIntoView({ block: 'center' });
      }

      function setView(view) {
        state.view = view === 'history' && canListChanges ? 'history' : 'browser';
        browserEl.hidden = state.view !== 'browser';
        historyView.hidden = state.view !== 'history';
        if (state.view === 'history') loadHistory();
        else state.historyRequestId += 1;
      }

      async function loadHistory() {
        const requestId = ++state.historyRequestId;
        historyEl.innerHTML = '<div class="template-center-empty">正在加载变更记录…</div>';
        try {
          const result = await requireApi('listChanges').listChanges();
          if (requestId !== state.historyRequestId || !alive()) return;
          if (result?.status !== 'success') throw new Error(result?.message || '变更记录加载失败');
          const changes = Array.isArray(result.changes) ? result.changes : [];
          if (!changes.length) {
            historyEl.innerHTML = '<div class="template-center-empty">暂无变更</div>';
            return;
          }
          historyEl.innerHTML = `
            <div class="template-center-table-wrap">
              <table class="template-center-table is-wide">
                <colgroup><col style="width: 136px" /><col /><col style="width: 104px" /><col style="width: 104px" /><col style="width: 72px" /></colgroup>
                <thead><tr><th>时间</th><th>模板</th><th>操作</th><th>版本</th><th>结果</th></tr></thead>
                <tbody>${changes.map((change) => `
                  <tr>
                    <td>${escapeHtml(change.at)}</td>
                    <td><button class="template-center-link" type="button" data-action="goto" data-resource-id="${escapeHtml(change.resourceId)}">${escapeHtml(change.resourceName || change.resourceId)}</button></td>
                    <td>${escapeHtml(change.action)}</td>
                    <td>${escapeHtml(change.from && change.to ? `${change.from} → ${change.to}` : (change.to || change.from || '-'))}</td>
                    <td><span class="template-center-status" data-tone="${change.result === 'success' ? 'success' : 'danger'}">${change.result === 'success' ? '成功' : '失败'}</span></td>
                  </tr>`).join('')}
                </tbody>
              </table>
            </div>`;
        } catch (error) {
          if (requestId !== state.historyRequestId || !alive()) return;
          historyEl.innerHTML = `<div class="template-center-empty">${escapeHtml(errorText(error, '变更记录加载失败'))}</div>`;
        }
      }

      function gotoResource(resourceId) {
        const target = state.resources.find((resource) => resource.id === resourceId);
        if (!target) return;
        setView('browser');
        if (!matches(target)) {
          Object.assign(state, { query: '', moduleId: '', type: '', status: '' });
          queryInput.value = '';
          moduleSelect.value = '';
          typeSelect.value = '';
          statusSelect.value = '';
        }
        selectResource(resourceId, { revealInList: true });
        // 跳转来源（详情链接、变更记录）会随重绘移除或被隐藏，焦点移到目标模板，可继续用方向键浏览。
        listEl.querySelector(`[data-resource-id="${CSS.escape(resourceId)}"]`)?.focus({ preventScroll: true });
      }

      async function saveAs(button) {
        const resource = state.detail;
        if (!resource || button.disabled) return;
        button.disabled = true;
        showFeedback('');
        try {
          const result = await requireApi('saveAs').saveAs({ resourceId: resource.id, versionId: button.dataset.versionId });
          if (!alive() || result?.status === 'cancelled') return;
          if (result?.status !== 'success') throw new Error(result?.message || '另存为失败');
          showFeedback(`已另存为「${result.fileName}」`, 'success');
        } catch (error) {
          if (alive()) showFeedback(`另存为失败：${errorText(error, '未知错误')}`, 'error');
        } finally {
          if (button.isConnected) button.disabled = false;
        }
      }

      function pushChild(overlay) {
        const parent = getParentHandle();
        if (!alive() || !parent?.isOpen() || !parent.isTop()) return false;
        return modalBridge.pushModal(parent, overlay)?.status !== 'stale';
      }

      // 共享确认框；结果须由后端确认后才关闭，失败时在原框内提示并允许重试。
      function openConfirm({ message, detail = '', confirmText, tone = 'danger', run }) {
        let busy = false;
        let overlay = null;
        overlay = createConfirmDialog({
          message: `${message}${detail ? `<div class="template-confirm-detail">${escapeHtml(detail)}</div>` : ''}`,
          confirmText: escapeHtml(confirmText),
          cancelText: '取消',
          onConfirm: async () => {
            const confirmButton = overlay.querySelector('[data-action="confirm"]');
            const cancelButton = overlay.querySelector('[data-action="cancel"]');
            if (busy || confirmButton.disabled) return;
            busy = true;
            confirmButton.disabled = true;
            cancelButton.disabled = true;
            confirmButton.textContent = '处理中…';
            try {
              const success = await run();
              busy = false;
              if (overlay.isConnected) modalBridge.closeModal(overlay, { status: 'submitted', value: null });
              if (alive() && success) success();
            } catch (error) {
              busy = false;
              if (!overlay.isConnected) return;
              confirmButton.disabled = false;
              cancelButton.disabled = false;
              confirmButton.textContent = confirmText;
              let feedback = overlay.querySelector('.template-confirm-error');
              if (!feedback) {
                feedback = document.createElement('div');
                feedback.className = 'template-confirm-error';
                feedback.setAttribute('role', 'alert');
                overlay.querySelector('.alert-message')?.appendChild(feedback);
              }
              feedback.textContent = errorText(error, '操作失败');
            }
          }
        });
        if (tone !== 'danger') {
          overlay.querySelector('[data-action="confirm"]')?.classList.replace('danger-btn', 'primary-btn');
        }
        modalBridge.registerModal(overlay, {
          canClose: () => !busy,
          initialFocus: () => overlay.querySelector('[data-action="cancel"]')
        });
        pushChild(overlay);
      }

      function versionAction({ versionId, restore = false }) {
        const resource = state.detail;
        const version = resource?.versions?.find((item) => item.id === versionId);
        if (!resource || !version) return;
        const toBuiltin = restore || version.source === 'builtin';
        const expectedVersionId = resource.current?.id;
        openConfirm({
          message: toBuiltin
            ? `将 <strong>${escapeHtml(resource.name)}</strong> 恢复为内置版本？`
            : `启用 <strong>${escapeHtml(resource.name)}</strong> 的 ${escapeHtml(version.label)}？`,
          detail: '新任务开始使用，运行中的任务不切换。',
          confirmText: toBuiltin ? '恢复默认' : '启用',
          tone: 'primary',
          run: async () => {
            const result = await requireApi('setCurrentVersion').setCurrentVersion({ resourceId: resource.id, versionId, expectedVersionId });
            if (result?.status === 'conflict') {
              if (alive()) loadList({ keepFeedback: true });
              throw new Error(result.message || '模板已更新，请确认后重试');
            }
            if (result?.status !== 'success') throw new Error(result?.message || '操作失败');
            return () => {
              showFeedback(toBuiltin ? '已恢复为内置版本' : `已启用 ${version.label}`, 'success');
              loadList({ keepFeedback: true });
            };
          }
        });
      }

      function deleteVersion(versionId) {
        const resource = state.detail;
        const version = resource?.versions?.find((item) => item.id === versionId);
        if (!resource || !version) return;
        openConfirm({
          message: `永久删除 <strong>${escapeHtml(resource.name)}</strong> 的 ${escapeHtml(version.label)}？`,
          detail: version.fileName,
          confirmText: '永久删除',
          run: async () => {
            const result = await requireApi('deleteVersion').deleteVersion({ resourceId: resource.id, versionId });
            if (result?.status !== 'success') throw new Error(result?.message || '删除失败');
            return () => {
              showFeedback(`已删除 ${version.label}`, 'success');
              loadList({ keepFeedback: true });
            };
          }
        });
      }

      function createDialogShell({ className, titleId, title, bodyHtml, footerHtml }) {
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        const card = document.createElement('section');
        card.className = `modal-card ${className}`;
        card.setAttribute('role', 'dialog');
        card.setAttribute('aria-modal', 'true');
        card.setAttribute('aria-labelledby', titleId);
        card.innerHTML = `
          <div class="dialog-header">
            <div id="${titleId}" class="dialog-title">${escapeHtml(title)}</div>
            <button class="icon-close" type="button" data-action="close" title="关闭" aria-label="关闭">×</button>
          </div>
          ${bodyHtml}
          <footer class="dialog-actions right">${footerHtml}</footer>`;
        overlay.appendChild(card);
        return { overlay, card };
      }

      function showExcluded() {
        const { overlay, card } = createDialogShell({
          className: 'template-excluded-card',
          titleId: 'templateExcludedTitle',
          title: '未纳入的文件',
          bodyHtml: `
            <div class="template-excluded-body">
              <ul class="template-excluded-list">${state.excluded.map((item) => (
                `<li><strong>${escapeHtml(item.fileName)}</strong><span>${escapeHtml((item.modules || []).map(moduleName).join('、'))}</span></li>`
              )).join('')}</ul>
              <p class="template-center-note">由原模块维护，不在此替换。</p>
            </div>`,
          footerHtml: '<button class="secondary-btn small" type="button" data-action="close">知道了</button>'
        });
        card.addEventListener('click', (event) => {
          if (event.target.closest('[data-action="close"]')) modalBridge.closeModal(overlay, { status: 'cancelled', reason: 'cancel' });
        });
        modalBridge.registerModal(overlay, {
          dialog: card,
          dismiss: { escape: true, backdrop: true },
          initialFocus: () => card.querySelector('.dialog-actions [data-action="close"]')
        });
        pushChild(overlay);
      }

      function checksHtml(prepared) {
        const checks = Array.isArray(prepared.checks) ? prepared.checks : [];
        const group = (key, title) => {
          const items = checks.filter((check) => check.group === key);
          if (!items.length) return '';
          return `<div class="template-import-group">${title}</div>${items.map((check) => `
            <div class="template-import-check">
              <span class="template-import-check-icon" data-status="${escapeHtml(check.status)}" aria-label="${CHECK_TEXT[check.status] || ''}">${CHECK_ICONS[check.status] || '·'}</span>
              <span class="template-import-check-label" title="${escapeHtml(check.label)}">${escapeHtml(check.label)}</span>
              <span class="template-import-check-detail">${escapeHtml(check.detail)}</span>
            </div>`).join('')}`;
        };
        const added = prepared.diff?.added || [];
        const removed = prepared.diff?.removed || [];
        const diff = added.length || removed.length
          ? `<div><div class="template-import-group">取值变化</div><div class="template-import-diff">${added.map((value) => `<span class="is-added">+ ${escapeHtml(value)}</span>`).join('')}${removed.map((value) => `<span class="is-removed">− ${escapeHtml(value)}</span>`).join('')}</div></div>`
          : '';
        return `<div>${group('file', '文件检查')}${group('usage', '使用方')}</div>${diff}`;
      }

      // 导入分两步：Main 选择文件，再由 Main 暂存并预检；确认时按预检时的当前版本提交，版本已变化则要求重新校验。
      function openImportDialog() {
        const resource = state.detail;
        if (!resource?.capabilities?.importVersion) return;
        const versionLabel = (version) => `${version?.label || '-'}${version?.source === 'builtin' ? '（内置）' : ''}`;
        const { overlay, card } = createDialogShell({
          className: 'template-import-card',
          titleId: 'templateImportTitle',
          title: '导入新版本',
          bodyHtml: '<div class="template-import-body" data-role="import-body"></div>',
          footerHtml: `
            <button class="secondary-btn small" type="button" data-action="cancel">取消</button>
            <button class="secondary-btn small" type="button" data-action="save-only" disabled>仅保存</button>
            <button class="primary-btn small" type="button" data-action="save-enable" disabled>保存并启用</button>`
        });
        const body = card.querySelector('[data-role="import-body"]');
        const saveOnlyButton = card.querySelector('[data-action="save-only"]');
        const saveEnableButton = card.querySelector('[data-action="save-enable"]');
        const exitButtons = card.querySelectorAll('[data-action="cancel"], [data-action="close"]');
        const flow = {
          phase: 'select',
          file: null,
          prepared: null,
          message: '',
          picking: false,
          committing: false,
          closed: false,
          prepareId: 0,
          currentLabel: versionLabel(resource.current)
        };

        const discard = (prepared) => {
          if (!prepared?.importToken || typeof resourceApi?.discardImport !== 'function') return;
          Promise.resolve(resourceApi.discardImport(prepared.importToken)).catch(() => {});
        };

        function render() {
          if (flow.closed) return;
          const target = `<p class="template-import-target"><strong>${escapeHtml(resource.name)}</strong> · 当前 ${escapeHtml(flow.currentLabel)}</p>`;
          const busy = flow.picking || flow.committing || flow.phase === 'checking';
          if (!flow.file) {
            body.innerHTML = `${target}
              <div class="template-import-pick">
                <span>选择要导入的 .xlsx 文件</span>
                <button class="secondary-btn small" type="button" data-action="choose"${busy ? ' disabled' : ''}>选择文件</button>
              </div>
              ${flow.message ? `<div class="template-import-verdict" data-tone="error" role="alert">${escapeHtml(flow.message)}</div>` : ''}`;
          } else {
            const prepared = flow.prepared;
            const meta = [formatBytes(flow.file.size), flow.file.sha256 ? `SHA-256 ${flow.file.sha256.slice(0, 12)}…` : ''].filter(Boolean).join(' · ');
            let verdict = '';
            if (flow.phase === 'checking') {
              verdict = '<div class="template-import-verdict" data-tone="info" role="status">正在校验…</div>';
            } else if (flow.phase === 'conflict') {
              verdict = `<div class="template-import-verdict" data-tone="error" role="alert">${escapeHtml(flow.message)} <button class="template-center-link" type="button" data-action="recheck">重新校验</button></div>`;
            } else if (flow.phase === 'error') {
              verdict = `<div class="template-import-verdict" data-tone="error" role="alert">${escapeHtml(flow.message)}</div>`;
            } else if (prepared) {
              const tone = { pass: 'success', warn: 'warning', fail: 'error' }[prepared.verdict] || 'error';
              const text = { pass: '校验通过，可以导入', warn: '校验通过，请确认提示项' }[prepared.verdict] || '未通过，不能导入';
              verdict = `<div class="template-import-verdict" data-tone="${tone}" role="${tone === 'error' ? 'alert' : 'status'}">${text}${flow.committing ? ' · 正在保存…' : ''}</div>`;
            }
            body.innerHTML = `${target}
              <div class="template-import-file">
                <span class="template-import-file-icon" aria-hidden="true">${escapeHtml(extensionOf(flow.file.name).toUpperCase().slice(0, 4) || 'FILE')}</span>
                <span class="template-import-file-copy"><strong title="${escapeHtml(flow.file.name)}">${escapeHtml(flow.file.name)}</strong><span>${escapeHtml(meta)}</span></span>
                <button class="secondary-btn small" type="button" data-action="choose"${busy ? ' disabled' : ''}>重新选择</button>
              </div>
              ${verdict}
              ${prepared && flow.phase === 'result' ? checksHtml(prepared) : ''}`;
          }
          const canCommit = flow.phase === 'result' && flow.prepared && ['pass', 'warn'].includes(flow.prepared.verdict) && !busy;
          saveOnlyButton.disabled = !canCommit;
          saveEnableButton.disabled = !canCommit;
          exitButtons.forEach((button) => { button.disabled = flow.committing; });
        }

        async function prepare(file) {
          if (!file?.path || flow.committing) return;
          const prepareId = ++flow.prepareId;
          const previous = flow.prepared;
          flow.file = file;
          flow.prepared = null;
          flow.message = '';
          flow.phase = 'checking';
          render();
          discard(previous);
          try {
            const result = await requireApi('prepareImport').prepareImport({ resourceId: resource.id, filePath: file.path });
            if (flow.closed || prepareId !== flow.prepareId) {
              discard(result);
              return;
            }
            if (result?.status !== 'success') throw new Error(result?.message || '校验失败');
            flow.file = { ...file, ...(result.file || {}) };
            flow.currentLabel = versionLabel({ label: result.expectedVersionLabel, source: result.expectedVersionSource });
            flow.prepared = result;
            flow.phase = 'result';
            render();
            if (!saveEnableButton.disabled) saveEnableButton.focus({ preventScroll: true });
          } catch (error) {
            if (flow.closed || prepareId !== flow.prepareId) return;
            flow.phase = 'error';
            flow.message = `校验失败：${errorText(error, '未知错误')}`;
            render();
          }
        }

        async function choose() {
          if (flow.picking || flow.committing) return;
          flow.picking = true;
          render();
          try {
            const picked = await requireApi('pickImportFile').pickImportFile({ resourceId: resource.id });
            if (flow.closed) return;
            flow.picking = false;
            if (picked?.status === 'cancelled') {
              render();
              return;
            }
            if (picked?.status !== 'success' || !picked.filePath) throw new Error(picked?.message || '选择文件失败');
            await prepare({ path: picked.filePath, name: picked.fileName || picked.filePath, size: picked.size });
          } catch (error) {
            if (flow.closed) return;
            flow.picking = false;
            flow.message = errorText(error, '选择文件失败');
            if (flow.file) flow.phase = 'error';
            render();
          }
        }

        async function commit(enable) {
          const prepared = flow.prepared;
          if (!prepared || flow.committing) return;
          flow.committing = true;
          render();
          try {
            const result = await requireApi('commitImport').commitImport({ importToken: prepared.importToken, enable });
            if (flow.closed) return;
            if (result?.status === 'conflict') {
              discard(prepared);
              flow.prepared = null;
              flow.phase = 'conflict';
              flow.message = result.message || '模板已更新，请重新校验';
              return;
            }
            if (result?.status !== 'success') throw new Error(result?.message || '保存失败');
            flow.prepared = null;
            flow.committing = false;
            modalBridge.closeModal(overlay, { status: 'submitted', value: result });
            if (!alive()) return;
            if (!enable) state.tab = 'versions';
            const label = result.version?.label || '';
            showFeedback(enable ? `已启用 ${label}，新任务开始使用` : `已保存 ${label}，可在“版本”中启用`, 'success');
            loadList({ keepFeedback: true });
          } catch (error) {
            if (flow.closed) return;
            flow.phase = 'error';
            flow.message = `保存失败：${errorText(error, '未知错误')}`;
          } finally {
            flow.committing = false;
            render();
          }
        }

        card.addEventListener('click', (event) => {
          const button = event.target.closest('button[data-action]');
          if (!button || button.disabled) return;
          const action = button.dataset.action;
          if (action === 'choose') choose();
          else if (action === 'recheck') prepare(flow.file);
          else if (action === 'save-only') commit(false);
          else if (action === 'save-enable') commit(true);
          else if (action === 'cancel' || action === 'close') modalBridge.closeModal(overlay, { status: 'cancelled', reason: 'cancel' });
        });

        render();
        modalBridge.registerModal(overlay, {
          dialog: card,
          canClose: () => !flow.committing,
          dismiss: { escape: true },
          initialFocus: () => card.querySelector('[data-action="choose"]'),
          onClose: () => {
            flow.closed = true;
            discard(flow.prepared);
            flow.prepared = null;
          }
        });
        pushChild(overlay);
      }

      async function copyText(text) {
        let copied = false;
        try {
          await navigator.clipboard.writeText(text);
          copied = true;
        } catch (_error) {
          const area = document.createElement('textarea');
          area.value = text;
          area.style.cssText = 'position:fixed;left:-1000px;opacity:0';
          pane.appendChild(area);
          area.select();
          try {
            copied = document.execCommand('copy');
          } catch (_copyError) {
            copied = false;
          }
          area.remove();
        }
        if (alive()) showFeedback(copied ? '已复制' : '复制失败', copied ? 'success' : 'error');
      }

      queryInput.addEventListener('input', () => {
        clearTimeout(state.queryTimer);
        state.queryTimer = setTimeout(() => {
          state.query = queryInput.value.trim();
          applyFilters();
        }, 160);
      });
      moduleSelect.addEventListener('change', () => { state.moduleId = moduleSelect.value; applyFilters(); });
      typeSelect.addEventListener('change', () => { state.type = typeSelect.value; applyFilters(); });
      statusSelect.addEventListener('change', () => { state.status = statusSelect.value; applyFilters(); });

      listEl.addEventListener('click', (event) => {
        const item = event.target.closest('[data-resource-id]');
        if (item) selectResource(item.dataset.resourceId);
      });
      listEl.addEventListener('keydown', (event) => {
        if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
        const items = Array.from(listEl.querySelectorAll('.template-center-item'));
        const index = items.indexOf(document.activeElement);
        if (index < 0) return;
        event.preventDefault();
        const next = items[Math.max(0, Math.min(items.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))];
        const resourceId = next.dataset.resourceId;
        selectResource(resourceId);
        listEl.querySelector(`[data-resource-id="${CSS.escape(resourceId)}"]`)?.focus();
      });

      detailEl.addEventListener('keydown', (event) => {
        const tab = event.target.closest('[role="tab"]');
        if (!tab || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        const tabs = Array.from(detailEl.querySelectorAll('[role="tab"]'));
        const index = tabs.indexOf(tab);
        let next = index;
        if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
        if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
        if (event.key === 'Home') next = 0;
        if (event.key === 'End') next = tabs.length - 1;
        event.preventDefault();
        state.tab = tabs[next].dataset.detailTab;
        renderDetail({ keepScroll: true });
        detailEl.querySelector(`[data-detail-tab="${state.tab}"]`)?.focus();
      });

      pane.addEventListener('click', (event) => {
        const tab = event.target.closest('[data-detail-tab]');
        if (tab) {
          state.tab = tab.dataset.detailTab;
          renderDetail({ keepScroll: true });
          detailEl.querySelector(`[data-detail-tab="${state.tab}"]`)?.focus();
          return;
        }
        const button = event.target.closest('button[data-action]');
        if (!button || button.disabled) return;
        const action = button.dataset.action;
        if (action === 'open-history') setView('history');
        else if (action === 'back-to-templates') setView('browser');
        else if (action === 'goto') gotoResource(button.dataset.resourceId);
        else if (action === 'show-excluded') showExcluded();
        else if (action === 'select-sheet') {
          state.sheetIndex = Number(button.dataset.sheetIndex) || 0;
          renderDetail({ keepScroll: true });
          detailEl.querySelector(`[data-action="select-sheet"][data-sheet-index="${state.sheetIndex}"]`)?.focus({ preventScroll: true });
        } else if (action === 'save-as') saveAs(button);
        else if (action === 'import') openImportDialog();
        else if (action === 'restore-default') {
          const builtin = state.detail?.versions?.find((version) => version.source === 'builtin');
          if (builtin) versionAction({ versionId: builtin.id, restore: true });
        } else if (action === 'set-current') versionAction({ versionId: button.dataset.versionId });
        else if (action === 'delete-version') deleteVersion(button.dataset.versionId);
        else if (action === 'copy') copyText(button.dataset.copy || '');
      });

      const unsubscribe = typeof resourceApi?.onChanged === 'function'
        ? resourceApi.onChanged(() => {
          if (!alive() || !state.loaded) return;
          loadList({ keepFeedback: true });
          if (state.view === 'history') loadHistory();
        })
        : null;

      return Object.freeze({
        enter() {
          if (state.destroyed || state.loaded || state.loading) return state.loading;
          state.loading = loadList().finally(() => { state.loading = null; });
          return state.loading;
        },
        leave() {
          if (state.view !== 'browser') setView('browser');
        },
        destroy() {
          if (state.destroyed) return;
          state.destroyed = true;
          clearTimeout(state.queryTimer);
          state.listRequestId += 1;
          state.detailRequestId += 1;
          state.historyRequestId += 1;
          if (typeof unsubscribe === 'function') unsubscribe();
        }
      });
    }

    return Object.freeze({ mountTemplateFiles });
  }

  global.__templateFilesDialogs = Object.freeze({ createTemplateFilesDialogs });
  if (typeof module !== 'undefined' && module.exports) module.exports = global.__templateFilesDialogs;
})(typeof window !== 'undefined' ? window : globalThis);
