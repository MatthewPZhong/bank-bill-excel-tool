'use strict';

(function installScenarioCommandService(root) {
  // 同一 Preload API 的服务重建不能证明旧 Main 请求已经收口。
  const lineages = new WeakMap();
  const BANK_CATEGORIES = new Set(['extract-recon-id', 'offset-bill-mark', 'gateway-recon-join', 'builtin-fixed']);
  const RECON_CATEGORIES = new Set(['recon-id-fix', 'gateway-recon-id-fix']);
  const BOTH = Object.freeze(['bank-statement', 'recon-id-fix']);
  const SCENARIO_WRITES = Object.freeze({
    create: 'scenarios:create', update: 'scenarios:update', deleteOne: 'scenarios:delete',
    toggleEnabled: 'scenarios:toggle-enabled', transfer: 'scenarios:transfer',
    batchDelete: 'scenarios:batch-delete', setApplicableChannels: 'scenarios:set-applicable-channels',
    applyImport: 'scenarios:import-bundle-apply'
  });
  const CHANNEL_WRITES = Object.freeze({ create: 'channels:create', update: 'channels:update', deleteOne: 'channels:delete' });
  const READS = Object.freeze(['exportBundle', 'importBundle', 'getFundTypeEnum', 'getGatewayReconHeaders', 'getApplicableChannels']);
  const CATEGORY_WRITES = new Set(['update', 'deleteOne', 'toggleEnabled']);
  const unique = (values) => Object.freeze([...new Set(values)]);
  const numericId = (value) => {
    if (typeof value !== 'number' && typeof value !== 'string') return null;
    if (typeof value === 'string' && !value.trim()) return null;
    const number = Number(value);
    return Number.isSafeInteger(number) && number > 0 ? number : null;
  };
  const categoryValid = (value) => typeof value === 'string' && value.trim().length > 0;
  const countValid = (value) => Number.isSafeInteger(value) && value >= 0;
  const idsValid = (value) => Array.isArray(value) && value.every((id) => numericId(id) !== null);
  const scopeForCategory = (category) => RECON_CATEGORIES.has(category)
    ? ['recon-id-fix'] : BANK_CATEGORIES.has(category) ? ['bank-statement'] : BOTH;

  function createScenarioCommandService(options = {}) {
    const { scenariosApi, channelsApi, publish = () => {}, reportError = () => {} } = options;
    if (!scenariosApi || !channelsApi) throw new TypeError('场景命令服务需要场景和渠道 API');
    let lineage = lineages.get(scenariosApi);
    if (lineage) {
      lineage.trusted = false;
    } else {
      // 仅首次装配且已证明独占的新 Main 启动边界可显式声明。生产迁移期和窗口重载默认 false。
      // 这不是启动证明生成器；调用方不得以 activeWrites 为空或查询成功作为声明依据。
      const methodsComplete = ['list', 'get', ...Object.keys(SCENARIO_WRITES)].every((key) => typeof scenariosApi[key] === 'function')
        && Object.keys(CHANNEL_WRITES).every((key) => typeof channelsApi[key] === 'function');
      lineage = { trusted: options.writerBoundaryTrusted === true && methodsComplete, revision: 0 };
      lineages.set(scenariosApi, lineage);
    }
    let disposed = false;
    let metadataEpoch = 0;
    const serviceIdentity = {};
    const categoryById = new Map();
    const activeWrites = new Map();

    function assertLive() {
      if (!disposed) return;
      const error = new Error('场景命令服务已经销毁');
      error.code = 'SCENARIO_COMMAND_SERVICE_DISPOSED';
      throw error;
    }
    function report(error) {
      try { reportError(error); } catch (_) { /* 日志异常不得改变已完成的业务结算。 */ }
    }
    function emit(event) {
      if (disposed) return;
      const notification = Object.freeze({ ...event, revision: ++lineage.revision });
      try { publish(notification); } catch (error) { report(error); }
    }
    function resync(command) {
      emit({ kind: 'scenarios-resync-required', command, resyncScope: BOTH });
    }
    function currentEntry(id) {
      const entry = categoryById.get(id);
      return !disposed && lineage.trusted && activeWrites.size === 0 && entry && entry.epoch === metadataEpoch ? entry : null;
    }
    function invalidateMetadata() {
      metadataEpoch += 1;
      categoryById.clear();
    }
    function readStart() {
      return { serviceIdentity, epoch: metadataEpoch, quiescent: activeWrites.size === 0 };
    }
    function canAcceptRead(start) {
      return !disposed && lineage.trusted && start.serviceIdentity === serviceIdentity
        && start.quiescent && activeWrites.size === 0 && start.epoch === metadataEpoch;
    }
    function rowEntry(row) {
      if (!row || numericId(row.id) === null || !categoryValid(row.category)) return null;
      return { id: numericId(row.id), category: row.category, epoch: metadataEpoch };
    }
    async function read(method, args) {
      assertLive();
      const start = readStart();
      const result = await scenariosApi[method](...args);
      let acceptedEntry = null;
      if (!canAcceptRead(start)) return { result, acceptedEntry };
      if (method === 'list' && args.length === 0 && result && result.status === 'ok' && Array.isArray(result.scenarios)) {
        const rows = result.scenarios.map(rowEntry);
        if (rows.every(Boolean) && new Set(rows.map((row) => row.id)).size === rows.length) {
          categoryById.clear();
          rows.forEach(({ id, category, epoch }) => categoryById.set(id, Object.freeze({ category, epoch })));
        }
      } else if (method === 'get') {
        const id = numericId(args[0]);
        if (id !== null && result && result.status === 'ok') {
          const entry = rowEntry(result.scenario);
          if (entry && entry.id === id) {
            acceptedEntry = Object.freeze({ category: entry.category, epoch: entry.epoch });
            categoryById.set(id, acceptedEntry);
          } else if (result.scenario === null) {
            categoryById.delete(id);
          }
        } else if (id !== null && result && result.status === 'failed'
          && result.message === `场景 id=${args[0]} 不存在`) {
          // 当前 Main 的明确不存在响应；其他 failed 不能解释成记录已删除。
          categoryById.delete(id);
        }
      }
      return { result, acceptedEntry };
    }
    function invocationIds(group, method, args) {
      if (group === 'channels' || CATEGORY_WRITES.has(method) || method === 'setApplicableChannels') {
        const id = numericId(args[0]);
        return id === null ? [] : [id];
      }
      const ids = method === 'batchDelete' ? args[0] : method === 'transfer' && args[0] ? args[0].scenarioIds : [];
      return Array.isArray(ids) ? ids.map(numericId).filter((id) => id !== null) : [];
    }
    function successResponseValid(group, method, result, args) {
      if (group === 'channels') {
        const id = method === 'deleteOne' ? numericId(result.id) : result.channel && numericId(result.channel.id);
        return id !== null && id !== undefined && (method === 'create' || id === numericId(args[0]));
      }
      if (method === 'create') return numericId(result.id) !== null;
      if (CATEGORY_WRITES.has(method)) {
        if (numericId(result.id) === null || numericId(result.id) !== numericId(args[0])) return false;
        if (method === 'deleteOne') return typeof result.deleted === 'boolean';
        if (method === 'toggleEnabled') return typeof result.enabled === 'boolean';
        return true;
      }
      if (method === 'transfer') return countValid(result.transferredCount) && numericId(result.targetChannelId) !== null;
      if (method === 'batchDelete') return countValid(result.deletedCount);
      if (method === 'setApplicableChannels') return numericId(result.scenarioId) === numericId(args[0])
        && numericId(result.scenarioId) !== null && idsValid(result.channelIds);
      return countValid(result.importedCount) && Array.isArray(result.createdChannels) && Array.isArray(result.conflicts);
    }
    function dispatch(group, method, args, candidate) {
      assertLive();
      const api = group === 'scenarios' ? scenariosApi : channelsApi;
      const command = (group === 'scenarios' ? SCENARIO_WRITES : CHANNEL_WRITES)[method];
      const scenarioIds = invocationIds(group, method, args);
      const ready = lineage.trusted && activeWrites.size === 0;
      const evidence = ready && candidate && candidate.epoch === metadataEpoch ? candidate : null;
      const submittedCategory = method === 'create' && group === 'scenarios' && args[0] ? args[0].category : null;
      const metadata = ready ? scenarioIds.map(currentEntry) : [];
      const knownCategories = metadata.filter(Boolean).map((entry) => entry.category);
      const categoriesComplete = scenarioIds.length > 0 && metadata.length === scenarioIds.length && metadata.every(Boolean);
      invalidateMetadata();
      const invocation = { dispatchEpoch: metadataEpoch, categoryEvidence: evidence };
      activeWrites.set(invocation, invocation);
      // 从证据校验到调用原 IPC 没有 await；允许下一业务写并发发出，不引入全局写锁。
      let pending;
      try { pending = api[method](...args); } catch (error) { return settle(undefined, error, true); }
      return Promise.resolve(pending).then((result) => settle(result, null, false), (error) => settle(undefined, error, true));

      function settle(result, error, rejected) {
        const uninterrupted = !disposed && lineage.trusted && metadataEpoch === invocation.dispatchEpoch
          && activeWrites.size === 1 && activeWrites.has(invocation);
        const certainFailure = !rejected && result && (result.status === 'failed' || result.status === 'cancelled');
        const successful = !rejected && result && result.status === 'ok' && successResponseValid(group, method, result, args)
          && !(group === 'scenarios' && method === 'create' && !categoryValid(submittedCategory));
        const unknown = !successful && !certainFailure;
        if (unknown) lineage.trusted = false;
        invalidateMetadata();
        activeWrites.delete(invocation);
        if (successful && group === 'scenarios' && uninterrupted) {
          if (method === 'create' && categoryValid(submittedCategory)) {
            categoryById.set(numericId(result.id), Object.freeze({ category: submittedCategory, epoch: metadataEpoch }));
          } else if ((method === 'update' || method === 'toggleEnabled') && evidence) {
            categoryById.set(numericId(args[0]), Object.freeze({ category: evidence.category, epoch: metadataEpoch }));
          }
        }
        if (unknown) {
          resync(command);
        } else if (successful && group === 'channels') {
          emit({ kind: 'configuration-changed', resource: 'channels', command,
            channelIds: unique([numericId(method === 'deleteOne' ? result.id : result.channel.id)]), invalidationScope: Object.freeze([]) });
        } else if (successful) {
          let categories = knownCategories;
          let complete = uninterrupted && categoriesComplete;
          let scope;
          let ids = scenarioIds;
          if (method === 'create') {
            ids = [numericId(result.id)];
            if (categoryValid(submittedCategory)) {
              categories = [submittedCategory];
              complete = true;
              scope = scopeForCategory(submittedCategory);
            }
          } else if (method === 'deleteOne' && result.deleted === false) {
            scope = [];
          } else if (CATEGORY_WRITES.has(method)) {
            if (uninterrupted && evidence) {
              categories = [evidence.category];
              complete = true;
              scope = scopeForCategory(evidence.category);
            }
          } else if (method === 'setApplicableChannels') {
            scope = ['bank-statement'];
          } else {
            scope = BOTH;
          }
          if (scope) {
            emit({ kind: 'scenarios-changed', command, categories: unique(complete ? categories : []),
              categoriesComplete: complete, scenarioIds: unique(ids), invalidationScope: unique(scope) });
          } else {
            resync(command);
          }
        }
        if (rejected) throw error;
        return result;
      }
    }
    function writeScenario(method, args) {
      assertLive();
      if (!CATEGORY_WRITES.has(method)) return dispatch('scenarios', method, args, null);
      const entry = currentEntry(numericId(args[0]));
      if (entry || !lineage.trusted) return dispatch('scenarios', method, args, entry);
      // 补读最多一次。补读自身跨写时不借用后来其他查询/创建播种的缓存。
      return read('get', [args[0]]).then(
        ({ acceptedEntry }) => dispatch('scenarios', method, args, acceptedEntry),
        () => dispatch('scenarios', method, args, null)
      );
    }
    const scenarios = {
      list: (...args) => read('list', args).then(({ result }) => result),
      get: (...args) => read('get', args).then(({ result }) => result)
    };
    Object.keys(SCENARIO_WRITES).forEach((method) => { scenarios[method] = (...args) => writeScenario(method, args); });
    READS.forEach((method) => {
      if (typeof scenariosApi[method] === 'function') scenarios[method] = (...args) => { assertLive(); return scenariosApi[method](...args); };
    });
    const channels = {};
    if (typeof channelsApi.list === 'function') channels.list = (...args) => { assertLive(); return channelsApi.list(...args); };
    Object.keys(CHANNEL_WRITES).forEach((method) => { channels[method] = (...args) => dispatch('channels', method, args, null); });
    return Object.freeze({
      scenarios: Object.freeze(scenarios), channels: Object.freeze(channels),
      closed() { assertLive(); emit({ kind: 'scenarios-closed' }); },
      dispose() {
        if (disposed) return;
        disposed = true;
        lineage.trusted = false;
        invalidateMetadata();
      }
    });
  }
  const exported = Object.freeze({ createScenarioCommandService });
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
  if (root) root.ScenarioCommandService = exported;
})(typeof window !== 'undefined' ? window : null);
