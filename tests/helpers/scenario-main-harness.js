'use strict';

// 直接执行 src/main.js 当前 AST 中的真实 handler，不复制类别或失效逻辑。
// SQLite 只用 :memory:；导出响应只用于前置已导出反馈，不触碰用户文件。
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const acorn = require('acorn');
const { DatabaseSync } = require('node:sqlite');
const scenarios = require('../../src/backend/database/scenarios-repository');
const channels = require('../../src/backend/database/channels-repository');
const migrations = require('../../src/backend/database/migrations');
const { extractChannelRegionCombos } = require('../../src/backend/database/channel-enum-repository');
const preloadSource = fs.readFileSync(path.join(__dirname, '../../src/preload.js'), 'utf8');
const preloadGroups = {};
function findPreloadGroups(node) {
  if (!node || typeof node !== 'object') return;
  if (node.type === 'Property' && ['scenarios', 'channels'].includes(node.key.name) && node.value.type === 'ObjectExpression') preloadGroups[node.key.name] = preloadSource.slice(node.value.start, node.value.end);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach(findPreloadGroups);
    else if (value && typeof value === 'object') findPreloadGroups(value);
  }
}
findPreloadGroups(acorn.parse(preloadSource, { ecmaVersion: 'latest' }));
const source = fs.readFileSync(path.join(__dirname, '../../src/main.js'), 'utf8');
const ast = acorn.parse(source, { ecmaVersion: 'latest' });
const scenarioMethods = {
  list: 'scenarios:list', get: 'scenarios:get', create: 'scenarios:create', update: 'scenarios:update',
  deleteOne: 'scenarios:delete', toggleEnabled: 'scenarios:toggle-enabled', transfer: 'scenarios:transfer',
  batchDelete: 'scenarios:batch-delete', setApplicableChannels: 'scenarios:set-applicable-channels',
  applyImport: 'scenarios:import-bundle-apply'
};
const channelMethods = { list: 'channels:list', create: 'channels:create', update: 'channels:update', deleteOne: 'channels:delete' };
const required = new Set([...Object.values(scenarioMethods), ...Object.values(channelMethods), 'bank-statement:session-status', 'recon-id-fix:session-status']);
const declarations = [];
const registrations = new Map();
function visit(node) {
  if (!node || typeof node !== 'object') return;
  if (node.type === 'VariableDeclaration' && node.declarations.some((decl) => ['BANK_STATEMENT_CATEGORIES', 'RECON_ID_FIX_CATEGORIES'].includes(decl.id.name))) {
    declarations.push(source.slice(node.start, node.end));
  }
  if (node.type === 'FunctionDeclaration' && ['clearResultCacheForCategory', 'applyScenarioBundleImport'].includes(node.id.name)) declarations.push(source.slice(node.start, node.end));
  if (node.type === 'ExpressionStatement' && node.expression.type === 'CallExpression') {
    const call = node.expression;
    const name = call.arguments[0]?.value;
    if (required.has(name) && (call.callee.name === 'trackedIpcHandle' || call.callee.property?.name === 'handle')) registrations.set(name, source.slice(node.start, node.end));
  }
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object') visit(value);
  }
}
visit(ast);
for (const name of required) if (!registrations.has(name)) throw new Error(`未找到真实 Main handler ${name}`);
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function createMainHarness() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON; CREATE TABLE app_settings (setting_key TEXT PRIMARY KEY, setting_value TEXT NOT NULL, updated_at TEXT NOT NULL)');
  [migrations.ensureScenariosSupport, migrations.ensureScenariosCategoryReconIdFix,
    migrations.ensureScenariosCategoryGatewayReconIdFix, migrations.ensureChannelsTable,
    migrations.ensureScenariosChannelIdColumn, migrations.ensureScenariosCategoryBuiltinFixed,
    migrations.ensureScenarioApplicableChannelsTable].forEach((migrate) => migrate(db));
  const database = { db, extractChannelRegionCombos };
  const scenarioMap = {
    createScenario: 'createScenario', updateScenario: 'updateScenario', deleteScenario: 'deleteScenario',
    getScenario: 'getScenario', listScenarios: 'listScenarios', toggleScenarioEnabled: 'toggleScenarioEnabled',
    transferScenarios: 'transferScenarios', batchDeleteScenarios: 'batchDelete',
    getScenarioApplicableChannels: 'getApplicableChannelIds', setScenarioApplicableChannels: 'setApplicableChannelIds',
    setScenarioApplicableChannelsInTx: 'applyApplicableChannelIdsInTx', findScenarioByChannelAndName: 'findByChannelAndName'
  };
  const channelMap = { listChannels: 'listChannels', createChannel: 'createChannel', updateChannel: 'updateChannel',
    deleteChannel: 'deleteChannel', getBuiltinGeneralChannel: 'getBuiltinGeneral', findChannelByNameAndLocation: 'findByNameAndLocation' };
  for (const [target, method] of Object.entries(scenarioMap)) database[target] = (...args) => scenarios[method](db, ...args);
  for (const [target, method] of Object.entries(channelMap)) database[target] = (...args) => channels[method](db, ...args);
  const handlers = new Map();
  const importContexts = new Map();
  const context = vm.createContext({
    database, appendActivityLogEntry() {},
    processingResult: null, reconIdFixResult: null,
    bankStatementSession: { fileName: 'bank.xlsx', rows: [] }, gatewayReconSession: null, refundOrderSession: null,
    reconIdFixSession: { fileName: 'recon.xlsx', sheets: { reconResult: [], businessBills: [], opponentBills: [] } },
    applyScenarioBundleImportImpl: require('../../src/main-process/scenarios-bundle-import').applyScenarioBundleImport,
    scenarioImportContextStore: {
      require(id) { if (!importContexts.has(id)) throw new Error('导入上下文不存在'); return importContexts.get(id); },
      assertUnchanged() {},
      consume(id) { const value = this.require(id); importContexts.delete(id); return value; }
    },
    ipcMain: { handle(name, handler) { handlers.set(name, handler); } },
    trackedIpcHandle(name, _domain, _action, handler) {
      handlers.set(name, typeof handler === 'function' ? handler : (event, payload) => {
        const prepared = handler.prepare(event, payload);
        if (!prepared.proceed) return prepared.result;
        return handler.execute(event, prepared, { fileEvidence: { filePlan: prepared.filePlan } }, payload);
      });
    }
  });
  vm.runInContext([...declarations, ...registrations.values()].join('\n'), context, { filename: 'main-scenario-handlers.fixture.js' });
  const calls = [];
  const holds = new Map();
  function invoke(name, args = []) {
    calls.push({ name, args });
    // handler 先真实读/写 SQLite，再可控延迟这次已生成响应的交付。
    const value = handlers.get(name)({}, ...args);
    const held = holds.get(name)?.shift();
    if (held) { held.result = value; return held.promise; }
    return Promise.resolve(value);
  }
  // 使用真实 Preload 分组，包含 batchDelete(array)、applyImport(id,opts) 的原适配。
  const facade = (group) => vm.runInNewContext(`(${preloadGroups[group]})`, { ipcRenderer: { invoke: (channel, ...args) => invoke(channel, args) } });
  const bankApi = {
    sessionStatus: () => invoke('bank-statement:session-status'),
    export: () => Promise.resolve({ status: 'ok', mainFileName: 'bank-output.xlsx' }),
    c3CandidateCount: () => Promise.resolve({ status: 'ok', candidateCount: 0 }),
    refundCandidateCount: () => Promise.resolve({ status: 'ok', candidateCount: 0 })
  };
  const reconApi = {
    sessionStatus: () => invoke('recon-id-fix:session-status'),
    export: () => Promise.resolve({ status: 'ok', mainFileName: 'recon-output.xlsx' }),
    import: () => Promise.resolve({ status: 'cancelled' }),
    run: () => Promise.resolve({ status: 'failed', message: '此测试不运行对账算法' }),
    clearSession: () => { context.reconIdFixSession = null; context.reconIdFixResult = null; return Promise.resolve({ status: 'ok' }); }
  };
  return {
    database, bankApi, reconApi, scenariosApi: facade('scenarios'), channelsApi: facade('channels'), calls,
    hold(channel) {
      const held = deferred();
      if (!holds.has(channel)) holds.set(channel, []);
      holds.get(channel).push(held);
      held.deliver = () => held.resolve(held.result);
      return held;
    },
    setResults(bank = true, recon = true) {
      context.processingResult = bank ? { stats: { hitRowCount: 3, scenarioHitCount: 1 } } : null;
      context.reconIdFixResult = recon ? { fixedRows: [{ id: 'result-fixture' }], warnings: [], unmatchedRows: [] } : null;
    },
    results() { return { bank: context.processingResult !== null, recon: context.reconIdFixResult !== null }; },
    prepareImport(bundle) {
      const id = `import-${importContexts.size}`;
      importContexts.set(id, { bundle, filePath: '/fixture/scenarios.json' });
      return [id, { confirmCreateMissingChannels: true }];
    },
    dispose() { db.close(); }
  };
}
module.exports = { createMainHarness, deferred };
