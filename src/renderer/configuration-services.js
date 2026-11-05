'use strict';

(function installConfigurationServices(root) {
  // v3.2.15：渠道列表随模板一起刷新；未提供 channelsApi 时按模板上的 channelId / channelName 推导（不含空渠道）。
  function deriveChannelsFromTemplates(list) {
    const byId = new Map();
    for (const template of Array.isArray(list) ? list : []) {
      const channelId = Number(template && template.channelId || 0);
      if (!channelId) continue;
      if (!byId.has(channelId)) byId.set(channelId, { id: channelId, name: String(template.channelName || ''), templateCount: 0 });
      byId.get(channelId).templateCount += 1;
    }
    return Array.from(byId.values()).sort((left, right) => left.name.localeCompare(right.name, 'zh-Hans-CN'));
  }
  function createConfigurationServices({ templatesApi, channelsApi = null, reportError = () => {} }) {
    let templates = [];
    let channels = [];
    let currencyOptions = [];
    let accountMappingCount = 0;
    let requestGeneration = 0;
    let disposed = false;
    const listeners = new Set();
    const copy = (value) => structuredClone(value);
    function notify(resource) {
      if (disposed) return;
      for (const listener of [...listeners]) {
        try { listener(Object.freeze({ resource })); } catch (error) { reportError(error); }
      }
    }
    return Object.freeze({
      getTemplates: () => copy(templates),
      getStatementChannels: () => copy(channels),
      getCurrencyOptions: () => copy(currencyOptions),
      getAccountMappingCount: () => accountMappingCount,
      acceptBootstrap(info) {
        if (disposed) return;
        currencyOptions = Array.isArray(info.currencyOptions) ? copy(info.currencyOptions) : [];
        accountMappingCount = Number(info.accountMappingCount) || 0;
        notify('configuration');
      },
      acceptAccountMappingCount(value) {
        if (disposed) return;
        accountMappingCount = Number(value) || 0;
        notify('account-mappings');
      },
      async refreshTemplates() {
        const generation = ++requestGeneration;
        const [result, channelResult] = await Promise.all([
          templatesApi.list(),
          channelsApi && typeof channelsApi.list === 'function' ? channelsApi.list() : Promise.resolve(null)
        ]);
        if (!disposed && generation === requestGeneration) {
          if (!Array.isArray(result)) throw new TypeError('模板列表返回格式无效');
          templates = copy(result);
          channels = Array.isArray(channelResult) ? copy(channelResult) : deriveChannelsFromTemplates(result);
          notify('templates');
        }
        return result;
      },
      subscribe(listener) {
        if (disposed) return () => {};
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      applyPreviewTemplates(value) {
        if (disposed) return;
        ++requestGeneration;
        templates = copy(value);
        channels = deriveChannelsFromTemplates(value);
        notify('templates');
      },
      dispose() { disposed = true; ++requestGeneration; listeners.clear(); }
    });
  }
  const exported = Object.freeze({ createConfigurationServices });
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
  if (root) root.ConfigurationServices = exported;
})(typeof window !== 'undefined' ? window : null);
