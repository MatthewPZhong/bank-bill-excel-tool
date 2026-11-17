(function initLinkedTableRetentionDialogs(global) {
  'use strict';

  // v3.2.18 设置 → 数据管理 → 链接表保留期限。
  //   左「链接表名称」、右「保留期限」，样式同输入/输出文件保留期限；下拉变更自动保存。
  //   保存为最新意图串行：连续修改按顺序保存最终选择；失败恢复最近一次成功值；保存期间不能切换表或关闭设置。
  //   期限按数据日期计算，软件空闲时由 Main 自动删除过期行（见 src/main-process/linked-table-retention/）。
  const RETENTION_OPTIONS = Object.freeze([
    ['15', '15 天'],
    ['30', '30 天'],
    ['60', '60 天'],
    ['90', '90 天'],
    ['180', '180 天'],
    ['365', '365 天'],
    ['permanent', '永久']
  ]);
  const ALLOWED_VALUES = new Set(RETENTION_OPTIONS.map(([value]) => value));

  function errorText(error, fallback) {
    if (error && typeof error === 'object' && error.message) return String(error.message);
    const text = String(error || '').trim();
    return text || fallback;
  }

  function toOptionValue(days) {
    if (days === null || days === undefined) return 'permanent';
    const text = String(days);
    return ALLOWED_VALUES.has(text) ? text : 'permanent';
  }

  function toApiValue(value) {
    return value === 'permanent' ? null : Number(value);
  }

  function assertOk(result, fallback) {
    if (!result || typeof result !== 'object' || result.status !== 'ok') {
      throw new Error((result && result.message) || fallback);
    }
    return result;
  }

  // 链接表保留期限 API 由本工厂持有（窄 API：getRetentionSettings / setRetentionDays），设置弹窗只拿挂载函数。
  function createLinkedTableRetentionDialogs({ api: factoryApi = {}, ui }) {
    const escapeHtml = (value) => ui.escapeHtml(value === null || value === undefined ? '' : value);

    // previewApi 仅供预览模式替换内存 API；正式装配使用工厂持有的 linkedTable。
    function mountLinkedTableRetention(container, { previewApi = null, showFeedback = () => {}, onBusyChange = () => {} } = {}) {
      const api = previewApi || factoryApi.linkedTable || null;
      const state = {
        tables: [],
        retention: {},
        selectedTableKey: '',
        savedValue: '',
        ready: false,
        loading: false,
        requestId: 0,
        saving: false,
        pendingIntent: null,
        intentToken: 0,
        savePromise: null,
        destroyed: false
      };

      container.innerHTML = `
        <h4>链接表保留期限</h4>
        <div class="archive-center-retention-fields">
          <label class="archive-center-field archive-center-retention-module-field">
            <span>链接表名称</span>
            <select data-role="linked-retention-table" aria-label="链接表名称" disabled></select>
          </label>
          <label class="archive-center-field archive-center-retention-field">
            <span>保留期限</span>
            <select data-role="linked-retention-days" aria-label="链接表保留期限" disabled>
              ${RETENTION_OPTIONS.map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}
            </select>
          </label>
        </div>
        <p class="archive-center-settings-note">按数据日期计算；软件空闲时自动删除过期行，删除后不可恢复。</p>
      `;
      const tableSelect = container.querySelector('[data-role="linked-retention-table"]');
      const daysSelect = container.querySelector('[data-role="linked-retention-days"]');

      const alive = () => !state.destroyed && container.isConnected;
      const isBusy = () => state.saving || Boolean(state.pendingIntent);

      function updateControls() {
        tableSelect.disabled = !state.ready || state.loading || isBusy();
        daysSelect.disabled = !state.ready || state.loading;
        container.toggleAttribute('aria-busy', state.loading);
        onBusyChange(isBusy());
      }

      function currentValue() {
        return toOptionValue(state.retention[state.selectedTableKey]);
      }

      function render() {
        if (!isBusy()) {
          tableSelect.innerHTML = state.tables.map(({ tableKey, name }) => (
            `<option value="${escapeHtml(tableKey)}">${escapeHtml(name)}</option>`
          )).join('');
          tableSelect.value = state.selectedTableKey;
          state.savedValue = currentValue();
          daysSelect.value = state.savedValue;
        }
        updateControls();
      }

      async function load() {
        if (!api || typeof api.getRetentionSettings !== 'function') {
          showFeedback('链接表保留期限加载失败：服务暂不可用');
          return false;
        }
        const requestId = ++state.requestId;
        state.loading = true;
        updateControls();
        try {
          // 保存队列未结束时先等待，避免旧快照覆盖刚保存的期限。
          if (state.savePromise) await state.savePromise;
          if (requestId !== state.requestId || !alive()) return false;
          const result = assertOk(await api.getRetentionSettings(), '链接表保留期限加载失败');
          if (requestId !== state.requestId || !alive()) return false;
          state.tables = Array.isArray(result.tables) ? result.tables : [];
          state.retention = result.retentionDaysByTable && typeof result.retentionDaysByTable === 'object'
            ? { ...result.retentionDaysByTable }
            : {};
          if (!state.tables.some((table) => table.tableKey === state.selectedTableKey)) {
            state.selectedTableKey = state.tables[0] ? state.tables[0].tableKey : '';
          }
          state.ready = state.tables.length > 0;
          return true;
        } catch (error) {
          if (requestId === state.requestId && alive()) {
            showFeedback(`链接表保留期限加载失败：${errorText(error, '未知错误')}`);
          }
          return false;
        } finally {
          if (requestId === state.requestId) {
            state.loading = false;
            if (alive()) render();
          }
        }
      }

      function setSaving(saving) {
        state.saving = saving === true;
        if (alive()) updateControls();
      }

      async function drainIntents() {
        setSaving(true);
        try {
          while (state.pendingIntent && alive()) {
            const intent = state.pendingIntent;
            state.pendingIntent = null;
            if (intent.value === state.savedValue) {
              showFeedback('链接表保留期限已保存', 'success');
              continue;
            }
            let failure = null;
            try {
              const result = assertOk(await api.setRetentionDays({
                tableKey: intent.tableKey,
                retentionDays: toApiValue(intent.value)
              }), '链接表保留期限保存失败');
              state.retention = result.retentionDaysByTable && typeof result.retentionDaysByTable === 'object'
                ? { ...result.retentionDaysByTable }
                : { ...state.retention, [intent.tableKey]: toApiValue(intent.value) };
              state.savedValue = intent.value;
            } catch (error) {
              failure = error;
            }
            const isLatest = intent.token === state.intentToken && !state.pendingIntent;
            if (!isLatest || !alive()) continue;
            daysSelect.value = state.savedValue;
            if (failure) {
              showFeedback(`链接表保留期限保存失败：${errorText(failure, '未知错误')}`);
            } else {
              showFeedback('链接表保留期限已保存', 'success');
            }
          }
        } finally {
          state.savePromise = null;
          setSaving(false);
          if (alive()) render();
          if (state.pendingIntent && alive()) state.savePromise = drainIntents();
        }
      }

      function saveSelection() {
        if (!state.ready || state.loading || state.destroyed) return;
        const value = daysSelect.value;
        if (!state.saving && value === state.savedValue) return;
        state.intentToken += 1;
        state.pendingIntent = { token: state.intentToken, tableKey: state.selectedTableKey, value };
        showFeedback('正在保存链接表保留期限…', 'info');
        if (!state.savePromise) state.savePromise = drainIntents();
        else updateControls();
      }

      daysSelect.addEventListener('change', saveSelection);
      tableSelect.addEventListener('change', () => {
        if (!state.ready || state.loading || isBusy()) {
          tableSelect.value = state.selectedTableKey;
          return;
        }
        state.selectedTableKey = tableSelect.value;
        state.savedValue = currentValue();
        daysSelect.value = state.savedValue;
        showFeedback('', 'info');
      });

      return Object.freeze({
        enter() {
          if (state.destroyed) return Promise.resolve(false);
          return load();
        },
        leave() {
          // 取消未完成的读取；保存队列继续完成，未保存的显示值恢复为最近一次成功值。
          state.requestId += 1;
          state.loading = false;
          if (!isBusy()) daysSelect.value = state.savedValue;
          if (alive()) updateControls();
        },
        isBusy,
        destroy() {
          if (state.destroyed) return;
          state.destroyed = true;
          state.requestId += 1;
          state.intentToken += 1;
          state.pendingIntent = null;
        }
      });
    }

    // 预览模式（npm run preview）用的内存 API。
    function createLinkedTableRetentionPreviewApi() {
      const tables = [
        { tableKey: 'gateway-bill', name: '网关对账单表库', defaultRetentionDays: 15 },
        { tableKey: 'fx-settlement', name: '外汇交割表库', defaultRetentionDays: null },
        { tableKey: 'bank-deposit', name: '银行对账单表', defaultRetentionDays: 60 }
      ];
      const retention = { 'gateway-bill': 15, 'fx-settlement': null, 'bank-deposit': 60 };
      return {
        async getRetentionSettings() {
          return { status: 'ok', tables, retentionDaysByTable: { ...retention } };
        },
        async setRetentionDays({ tableKey, retentionDays }) {
          retention[tableKey] = retentionDays;
          return { status: 'ok', retentionDaysByTable: { ...retention } };
        }
      };
    }

    return Object.freeze({ mountLinkedTableRetention, createLinkedTableRetentionPreviewApi });
  }

  global.__linkedTableRetentionDialogs = Object.freeze({ createLinkedTableRetentionDialogs });
  if (typeof module !== 'undefined' && module.exports) module.exports = global.__linkedTableRetentionDialogs;
})(typeof window !== 'undefined' ? window : globalThis);
