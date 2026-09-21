'use strict';

(function installConfigurationServices(root) {
  function createConfigurationServices({ templatesApi, reportError = () => {} }) {
    let templates = [];
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
        const result = await templatesApi.list();
        if (!disposed && generation === requestGeneration) {
          if (!Array.isArray(result)) throw new TypeError('模板列表返回格式无效');
          templates = copy(result);
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
        notify('templates');
      },
      dispose() { disposed = true; ++requestGeneration; listeners.clear(); }
    });
  }
  const exported = Object.freeze({ createConfigurationServices });
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
  if (root) root.ConfigurationServices = exported;
})(typeof window !== 'undefined' ? window : null);
