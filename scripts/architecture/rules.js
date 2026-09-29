'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const { scopeContains, valueCandidates, factoryCalls, factoryPresent, callableOrigins, executionScopes } = require('./contracts');
const { RULES, validateBoundaries, validateAllowlist } = require('./schema');
const PURE_FORBIDDEN = /(?:^node:(?:fs(?:\/promises)?|sqlite|worker_threads|child_process)|^(?:electron|xlsx|exceljs)(?:\/|$)|(?:^|\/)(?:[^/]*writer[^/]*|row-mapper)\.[cm]?js$)/;
const DOMAIN = /(?:^src\/backend\/(?!file-service\/common\.js)|^src\/main-process\/(?:biz-op|position|acquiring|vcc|pending|bank-bu|new-account|pre-fund|recon-id|toolbox-|fund-recon|duplicate-inbound|read-only-exports))/;
const pos = value => value.source || { line: value.line || 0, column: value.column || 0 };
const fp = value => value.functionPath === undefined ? null : value.functionPath;
const sorted = values => [...values].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
function scopeMatches(site, scope) {
  return scopeContains(scope, { path: site.from, functionPath: fp(site) });
}
function siteAllowed(boundary, rule, site) {
  return boundary.allowedSites.some(s => s.rule === rule && s.from === site.from
    && s.functionPath === fp(site) && s.callee === (site.callee || site.method) && s.evidenceId === site.evidenceId);
}
function cycles(edges) {
  const graph = new Map();
  for (const e of edges) {
    if (e.external || !/\.[cm]?js$/.test(e.to)) continue;
    if (!graph.has(e.from)) graph.set(e.from, []);
    graph.get(e.from).push(e);
  }
  for (const list of graph.values()) list.sort((a, b) => a.to.localeCompare(b.to));
  const index = new Map(); const low = new Map(); const stack = []; const active = new Set(); const result = []; let next = 0;
  function visit(node) {
    index.set(node, next); low.set(node, next++); stack.push(node); active.add(node);
    for (const edge of graph.get(node) || []) {
      if (!index.has(edge.to)) { visit(edge.to); low.set(node, Math.min(low.get(node), low.get(edge.to))); }
      else if (active.has(edge.to)) low.set(node, Math.min(low.get(node), index.get(edge.to)));
    }
    if (low.get(node) !== index.get(node)) return;
    const component = []; let member;
    do { member = stack.pop(); active.delete(member); component.push(member); } while (member !== node);
    const group = new Set(component);
    if (component.length === 1 && !(graph.get(node) || []).some(e => e.to === node)) return;
    // 每个 SCC 输出一条最短可复现环，而不是文件计数。
    let shortest = null;
    for (const start of component.sort()) {
      const queue = [{ node: start, edges: [], seen: new Set([start]) }];
      while (queue.length) {
        const current = queue.shift();
        if (shortest && current.edges.length >= shortest.length) continue;
        for (const edge of graph.get(current.node) || []) {
          if (!group.has(edge.to)) continue;
          const route = [...current.edges, edge];
          if (edge.to === start) { if (!shortest || route.length < shortest.length) shortest = route; continue; }
          if (!current.seen.has(edge.to)) queue.push({ node: edge.to, edges: route, seen: new Set([...current.seen, edge.to]) });
        }
      }
    }
    shortest.componentEdges = [...new Map(component.flatMap(n => (graph.get(n) || []).filter(e => group.has(e.to))).map(e => [JSON.stringify([e.from,e.to,e.kind]), {from:e.from,to:e.to,kind:e.kind}])).values()].sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
    result.push(shortest);
  }
  for (const node of [...graph.keys()].sort()) if (!index.has(node)) visit(node);
  return result;
}
function evaluateRules(scan, config, allowlist, { root = process.cwd() } = {}) {
  validateBoundaries(config); validateAllowlist(allowlist);
  if (config.factBaseline !== allowlist.factBaseline) throw new Error('边界与历史例外的固定事实基线不一致');
  const violations = []; const files = new Set(scan.files || []); const edges = [...(scan.edges || [])];
  const sites = (scan.sites || []).flatMap(site => site.invocations ? site.invocations.map(invocation => ({ ...site, ...invocation })) : [site]); const allBoundaries = config.boundaries;
  const byFrom = new Map();
  for (const e of edges) { if (!byFrom.has(e.from)) byFrom.set(e.from, []); byFrom.get(e.from).push(e); }
  function emit(rule, boundary, value, message, dependencyPath) {
    const at = pos(value); violations.push({ rule, boundaryId: boundary && boundary.id || null,
      from: value.from || value.path || 'architecture/boundaries.json', to: value.to || null,
      line: at.line, column: at.column, message, ...(dependencyPath ? { dependencyPath } : {}),
      ...(value.evidenceId ? { evidenceId: value.evidenceId } : {}), functionPath: fp(value),
      ...(value.kind ? { kind: value.kind } : {}), ...(value.importedNames ? { importedNames: value.importedNames } : {}) });
  }
  const exists = relative => { try { const st = fs.lstatSync(path.join(root, relative)); return st.isFile() && !st.isSymbolicLink(); } catch { return false; } };
  const activeBoundaries = []; const pendingBoundaries = []; const partialBoundaries = [];
  function inspectExports(file) {
    const analysis = scan.analyses && scan.analyses.get(file); const exported = new Map(); const functions = new Map();
    if (!analysis) return { exported, functions };
    const readValue = node => { let value = analysis.describe(node); if (value.kind === 'call-result' && (value.callee.chain || []).join('.') === 'Object.freeze') value = value.args[0]; return value; };
    analysis.walk(node => {
      if (/Function(?:Declaration|Expression)$/.test(node.type) || node.type === 'ArrowFunctionExpression') functions.set(analysis.functionPath(node.body), node.body.type !== 'BlockStatement' || node.body.body.length > 0);
      if (node.type !== 'AssignmentExpression') return;
      const target = analysis.describe(node.left); const chain = target.chain || [];
      if (chain.join('.') === 'module.exports') { const value = readValue(node.right); if (value && value.kind === 'object') for (const [name, binding] of Object.entries(value.properties)) exported.set(name, binding); }
      else if (chain[0] === 'exports' && chain.length === 2) exported.set(chain[1], readValue(node.right));
      else if (chain[0] === 'module' && chain[1] === 'exports' && chain.length === 3) exported.set(chain[2], readValue(node.right));
    });
    return { exported, functions };
  }

  function closure(starts, visitor, stop = () => false) {
    const queue = starts.map(from => ({ from, route: [from] })); const visited = new Set();
    while (queue.length) {
      const { from, route } = queue.shift(); if (visited.has(from)) continue; visited.add(from);
      for (const edge of byFrom.get(from) || []) {
        const next = [...route, edge.to]; const descend = visitor(edge, next);
        if (descend !== false && !edge.external && !stop(edge.to)) queue.push({ from: edge.to, route: next });
      }
    }
    return visited;
  }
  for (const cycle of cycles(edges)) {
    emit('ARCH-CYCLE', null, cycle[0], `生产依赖形成循环：${[cycle[0].from, ...cycle.map(e => e.to)].join(' → ')}`, [cycle[0].from, ...cycle.map(e => e.to)]);
    const v = violations.at(-1); v.cycleEdges = cycle.componentEdges; v.edgeKinds = [...new Set(v.cycleEdges.map(e => e.kind))].sort();
    v.evidenceId = crypto.createHash('sha256').update(JSON.stringify(v.cycleEdges)).digest('hex');
    v.literalCycle = cycles(edges.filter(e => !['worker', 'classic-global'].includes(e.kind) && v.cycleEdges.some(c => c.from === e.from && c.to === e.to && c.kind === e.kind))).length > 0;
  }
  for (const error of scan.parseErrors || []) emit('ARCH-STATIC-COVERAGE', null, error, `源码解析失败：${error.message || error.error}`);
  for (const unresolved of scan.unresolved || []) {
    const generated = config.generatedModules.find(g => g.from === unresolved.from && g.specifier === unresolved.specifier
      && !exists(g.target) && path.posix.normalize(path.posix.join(path.posix.dirname(g.from), g.specifier + (path.posix.extname(g.specifier) ? '' : '.js'))) === g.target
      && /missing|not.found|unresolved/i.test(unresolved.reason || unresolved.message || '') && exists(g.generator));
    if (!generated) emit('ARCH-STATIC-COVERAGE', null, unresolved, `本地依赖无法解析：${unresolved.specifier || unresolved.message}`);
  }
  for (const dynamic of scan.dynamicSites || []) {
    const explained = config.dynamicLoads.find(d => d.from === dynamic.from && d.functionPath === fp(dynamic) && d.evidenceId === dynamic.evidenceId);
    if (!explained) emit('ARCH-STATIC-COVERAGE', null, dynamic, '动态加载未登记准确 AST 指纹及完整目标集合');
  }
  if (allBoundaries.some(b => b.rules.includes('ARCH-RENDERER-SCOPE'))) for (const file of files) {
    if (/^src\/renderer\/(?:controllers|dialogs)\//.test(file) && !allBoundaries.some(b => b.rules.includes('ARCH-RENDERER-SCOPE') && (b.entrypoints.includes(file) || b.allowedLocal.includes(file)))) emit('ARCH-STATIC-COVERAGE', null, { from: file }, '新控制器或领域弹窗必须登记稳定子边界及注入合同');
  }
  for (const boundary of allBoundaries) {
    const starts = boundary.entrypoints.filter(p => files.has(p));
    if (boundary.directory) for (const file of files) if (file.startsWith(`${boundary.directory}/`) && !starts.includes(file)) starts.push(file);
    const present = boundary.entrypoints.filter(p => files.has(p)).length;
    if (boundary.state === 'active') activeBoundaries.push(boundary.id);
    else if (present || starts.length) partialBoundaries.push(boundary.id);
    else pendingBoundaries.push(boundary.id);
    if (boundary.state === 'active') {
      for (const entry of boundary.entrypoints) if (!files.has(entry)) emit('ARCH-STATIC-COVERAGE', boundary, { from: entry }, '已激活边界缺少必需入口');
      for (const scope of boundary.protectedScopes) {
        const analysis = scan.analyses && scan.analyses.get(scope.path);
        if (!analysis || (scope.functionPath !== null && !analysis.functionNodes.has(scope.functionPath))) {
          emit('ARCH-STATIC-COVERAGE', boundary, { from: scope.path, functionPath: scope.functionPath }, '已激活边界的保护文件或具名函数不存在，请同步迁移登记');
        }
      }
      if (boundary.factory && (!factoryPresent(scan, boundary.factory) || !factoryCalls(scan, boundary.factory).length)) {
        emit('ARCH-STATIC-COVERAGE', boundary, { from: boundary.factory.path }, '已激活工厂缺少实际定义或生产调用，请同步迁移登记');
      }
      for (const evidence of boundary.activationEvidence) if (!exists(evidence)) emit('ARCH-STATIC-COVERAGE', boundary, { from: evidence }, '已激活边界缺少行为验证入口');
      if (boundary.governance !== 'G8' && !boundary.requiredConsumers.length) emit('ARCH-STATIC-COVERAGE', boundary, {}, '治理边界激活必须登记真实生产消费者');
      if (boundary.governance !== 'G8' && !boundary.activationEvidence.length) emit('ARCH-STATIC-COVERAGE', boundary, {}, '治理边界激活必须登记行为验证入口');
      if (boundary.id === 'vcc-mapped-lineage') {
        const contracts = [['mapped-lineage-contract.js', ['assertMappedLineage', 'mappedContentHashForStoredVersion']], ['content-hash-contract.js', ['HASH_VERSION', 'PENDING_HASH_VERSION', 'contentHash', 'pendingCanonicalValues', 'pendingContentHash']]];
        for (const [suffix, names] of contracts) {
          const file = boundary.entrypoints.find(p => p.endsWith(suffix)); const exports = inspectExports(file);
          for (const name of names) { const value = exports.exported.get(name);
            if (!value || ((value.kind === 'function' || value.functionPath) && !exports.functions.get(value.functionPath))) emit('ARCH-STATIC-COVERAGE', boundary, { from: file }, `纯合同缺少实际非空导出 ${name}`);
          }
        }
      }
      for (const consumer of boundary.requiredConsumers) if (!edges.some(e => e.from === consumer.from && (!consumer.to || consumer.to === e.to)
          && e.kind === consumer.kind && consumer.importedNames.every(n => (e.importedNames || []).includes(n)))) emit('ARCH-STATIC-COVERAGE', boundary, { from: consumer.from, to: consumer.to }, '已激活边界缺少约定生产消费者');
    }
    const rules = boundary.rules;
    for (const site of sites.filter(s => s.type === 'reflection' &&
      (starts.includes(s.from) || boundary.protectedScopes.some(scope => scopeMatches(s, scope))))) {
      emit('ARCH-STATIC-COVERAGE', boundary, site, '受保护模块或具名作用域禁止动态代码与不透明全局反射');
    }
    const checkClosure = (rule, permitted) => closure(starts, (edge, route) => { if (!permitted(edge)) emit(rule, boundary, edge, '依赖超出登记的模块职责与允许能力', route); });
    for (const rule of ['ARCH-PLATFORM-CORE', 'ARCH-PURE-LINEAGE']) if (rules.includes(rule)) {
      checkClosure(rule, edge => !PURE_FORBIDDEN.test(edge.to) && edge.kind !== 'worker'
        && (edge.external ? edge.to === 'node:crypto' && boundary.allowedExternal.includes(edge.to) : boundary.allowedLocal.includes(edge.to)));
      const pureFiles = closure(starts, () => {});
      for (const site of sites.filter(s => pureFiles.has(s.from) && (s.type === 'reflection' || (s.type === 'call' && ['module.require', 'globalThis.require', 'window.require', 'require.bind', 'require.call', 'require.apply'].includes(s.callee))))) emit('ARCH-STATIC-COVERAGE', boundary, site, '纯模块闭包禁止动态代码和不透明反射');
    }
    if (rules.includes('ARCH-XLSX-INFRA')) checkClosure('ARCH-XLSX-INFRA', edge => edge.external
      ? (edge.to.startsWith('node:') || ['yauzl', 'sax', 'jszip'].includes(edge.to.split('/')[0]))
      : ((boundary.directory && edge.to.startsWith(`${boundary.directory}/`)) || edge.to === 'src/backend/file-service/common.js'));
    if (rules.includes('ARCH-DESCRIPTOR-COMPOSITION')) {
      const forbidden = target => DOMAIN.test(target) || boundary.compositionEntrypoints.some(c => c.path === target) || boundary.restrictedApis.some(api => api.path === target);
      closure(starts, (edge, route) => {
        const authorizedCarrier = edge.kind === 'worker' && siteAllowed(boundary, 'ARCH-DESCRIPTOR-COMPOSITION', { ...edge, callee: 'worker' })
          && config.dynamicLoads.some(d => d.from === edge.from && d.evidenceId === edge.evidenceId && d.functionPath === fp(edge) && d.allowedTargets.includes(edge.to));
        if (authorizedCarrier) return false;
        if (!edge.external && forbidden(edge.to)) emit('ARCH-DESCRIPTOR-COMPOSITION', boundary, edge, '公共机制不能反向装配领域或 catalog', route);
        return undefined;
      }, forbidden);
      for (const from of new Set(boundary.compositionEntrypoints.map(entry => entry.path))) for (const edge of byFrom.get(from) || []) {
        const contracts = boundary.compositionEntrypoints.filter(entry => entry.path === from && entry.allowedTargets.includes(edge.to));
        const allowed = contracts.some(entry => (edge.importedNames || []).length && edge.importedNames.every(name => entry.importedNames.includes(name)));
        if (!edge.external && DOMAIN.test(edge.to) && !allowed) emit('ARCH-DESCRIPTOR-COMPOSITION', boundary, edge, '显式装配只能加载登记的领域入口及具名导出');
      }
    }
    if (rules.includes('ARCH-TASK-ADAPTER')) {
      // 配置与调用共用绑定解析；最终能力身份不能与工厂/helper 的依赖闭包混为一谈。
      const localOperations = boundary.restrictedApis.flatMap(api => api.operations.map(operation => {
        const analysis = scan.analyses.get(api.path);
        const binding = analysis?.lookup(operation, analysis.ast);
        const resolved = binding && callableOrigins(analysis.describeBinding(binding), analysis);
        if (binding && (!resolved.known || !resolved.targets.length)) {
          const location = binding.init ? analysis.site(binding.init) : { from: api.path };
          emit('ARCH-STATIC-COVERAGE', boundary, location, `受限操作 ${operation} 的配置绑定无法完整解释`);
        }
        return { path: api.path, operation, targets: resolved?.targets || [], hasBinding: Boolean(binding) };
      }));
      const full = boundary.protectedScopes.filter(s => s.functionPath === null && files.has(s.path)).map(s => s.path);
      const denied = e => boundary.restrictedApis.some(a => a.path === e.to && (a.exportNames === null || a.exportNames.length));
      closure(full, (edge, route) => { if (denied(edge)) emit('ARCH-TASK-ADAPTER', boundary, edge, '通用任务机制不能依赖 Position 私有状态机', route); });
      const reached = executionScopes(scan, boundary.protectedScopes, {
        skipSite: site => siteAllowed(boundary, 'ARCH-TASK-ADAPTER', site)
      });
      for (const site of reached.unresolvedCalls) if (!siteAllowed(boundary, 'ARCH-TASK-ADAPTER', site)) emit('ARCH-STATIC-COVERAGE', boundary, site, '通用编排 helper 的动态执行目标无法完整解释');
      for (const site of reached.sites.filter(s => ['call', 'new'].includes(s.type))) {
        if (siteAllowed(boundary, 'ARCH-TASK-ADAPTER', site)) continue;
        const candidates = valueCandidates(site.reference);
        const origins = callableOrigins(site.reference, scan.analyses.get(site.from));
        for (const target of reached.calledTargets(site)) {
          if (denied({ to: target.analysis.from })) emit('ARCH-TASK-ADAPTER', boundary, site,
            '通用具名编排经实际调用取得 Position 私有能力', [site.from, target.analysis.from]);
        }
        const restrictedOperation = localOperations.some(api => api.path === site.from &&
          (api.targets.some(target => origins.targets.includes(target)) || (!api.hasBinding && candidates.some(value =>
            !value.functionPath && value.bindingKind !== 'parameter' && (value.chain || []).join('.') === api.operation))));
        if (restrictedOperation) emit('ARCH-TASK-ADAPTER', boundary, site, '通用编排不得直接调用本文件 Position 私有状态操作');
        if (!origins.known && (origins.unresolvedReturn || candidates.some(value => value.opaque || ['call-result', 'bound-function'].includes(value.kind)))) emit('ARCH-STATIC-COVERAGE', boundary, site, '受保护编排的调用别名无法完整解释');
      }
    }
    if (rules.includes('ARCH-BIZOP-RECOVERY-PRIVATE')) {
      for (const incoming of edges.filter(e => !e.from.startsWith('src/main-process/biz-op-v327/') && e.to.startsWith('src/main-process/biz-op-v327/'))) {
        const composition = boundary.compositionEntrypoints.some(c => c.path === incoming.from && c.allowedTargets.includes(incoming.to)
          && (incoming.importedNames || []).every(n => c.importedNames.includes(n)));
        if (composition) continue;
        closure([incoming.to], (edge, route) => {
          if (boundary.restrictedApis.some(a => a.path === edge.to)) emit('ARCH-BIZOP-RECOVERY-PRIVATE', boundary, incoming, '跨域 helper 间接取得 BizOP 私有恢复能力', [incoming.from, ...route]);
        });
      }
      for (const edge of edges) {
        const restricted = boundary.restrictedApis.find(a => a.path === edge.to
          && (a.exportNames === null || !(edge.importedNames || []).length || (edge.importedNames || []).some(n => a.exportNames.includes(n))));
        if (!restricted || edge.from.startsWith('src/main-process/biz-op-v327/')) continue;
        const composition = boundary.compositionEntrypoints.some(c => c.path === edge.from && c.allowedTargets.includes(edge.to)
          && (edge.importedNames || []).length && edge.importedNames.every(n => c.importedNames.includes(n)));
        if (!composition) emit('ARCH-BIZOP-RECOVERY-PRIVATE', boundary, edge, '跨域调用 BizOP 私有恢复或发布 API，须改走 owner gateway');
      }
    }
    if (rules.includes('ARCH-PUBLICATION-RECOVERY-ENTRY')) {
      const localOperations = boundary.restrictedApis.flatMap(api => api.operations.map(operation => {
        const analysis = scan.analyses.get(api.path);
        const binding = analysis?.lookup(operation, analysis.ast);
        const origins = binding && callableOrigins(analysis.describeBinding(binding), analysis);
        if (binding && (!origins.known || !origins.targets.length)) emit('ARCH-STATIC-COVERAGE', boundary,
          { from: api.path }, `受限恢复操作 ${operation} 的配置绑定无法完整解释`);
        return { path: api.path, operation, targets: origins?.targets || [], hasBinding: Boolean(binding) };
      }));
      const reached = executionScopes(scan, boundary.protectedScopes, {
        skipSite: site => siteAllowed(boundary, 'ARCH-PUBLICATION-RECOVERY-ENTRY', site)
      });
      for (const site of reached.unresolvedCalls) if (!siteAllowed(boundary, 'ARCH-PUBLICATION-RECOVERY-ENTRY', site))
        emit('ARCH-STATIC-COVERAGE', boundary, site, '受保护恢复 helper 的执行目标或实参无法完整解释');
      for (const site of reached.sites.filter(s => ['call', 'new'].includes(s.type))) {
        if (siteAllowed(boundary, 'ARCH-PUBLICATION-RECOVERY-ENTRY', site)) continue;
        const targets = [...reached.calledTargets(site), ...reached.callbackTargets(site)];
        if (targets.some(target => target.node && localOperations.some(api => api.targets.includes(
          JSON.stringify(['local', target.analysis.from, target.node.start])))))
          emit('ARCH-PUBLICATION-RECOVERY-ENTRY', boundary, site, '受保护 prepare/worker 经静态容器、helper 或回调入口执行了受限恢复能力');
      }
      // 恢复命令随真实 worker 合同登记；旧命令与新授权命令均不能从旁路发起。
      const recoveryOperations = new Set(['recover', ...boundary.restrictedApis.flatMap(api => api.operations)]);
      for (const edge of edges) {
        const api = boundary.restrictedApis.find(a => a.path === edge.to && a.exportNames !== null && (!(edge.importedNames || []).length || edge.importedNames.some(n => a.exportNames.includes(n))));
        if (api && !siteAllowed(boundary, 'ARCH-PUBLICATION-RECOVERY-ENTRY', { ...edge, callee: edge.kind })) emit('ARCH-PUBLICATION-RECOVERY-ENTRY', boundary, edge, '受限恢复 API 的引入/透传必须登记准确授权装配位置');
      }
      for (const site of sites.filter(s => s.type === 'call' || s.type === 'new')) {
        const module = site.binding && site.binding.from; const names = site.binding && site.binding.importedNames || [];
        const restricted = boundary.restrictedApis.find(a => a.path === module && (a.exportNames === null || names.some(n => a.exportNames.includes(n))));
        const origins = callableOrigins(site.reference, scan.analyses.get(site.from));
        const internal = localOperations.some(api => api.path === site.from &&
          (api.targets.some(target => origins.targets.includes(target)) || (!api.hasBinding &&
            valueCandidates(site.reference).some(value => !value.functionPath && value.bindingKind !== 'parameter' &&
              (value.chain || []).join('.') === api.operation))));
        const method = site.method || (site.chain || []).at(-1);
        const governed = boundary.protectedScopes.some(s => scopeMatches(site, s));
        const messageCall = ['postMessage', 'dispatch'].includes(method);
        const operations = [];
        let unknownOperation = false;
        const inspectMessage = value => {
          if (!value) { unknownOperation = true; return; }
          if (value.kind === 'candidates') { value.values.forEach(inspectMessage); return; }
          if (value.kind !== 'object') { unknownOperation = true; return; }
          if (messageCall && (value.spreads || []).length) unknownOperation = true;
          for (const key of ['op', 'operation', 'lifecycleOperation']) if (value.properties[key]) operations.push(value.properties[key]);
        };
        if (governed || messageCall) {
          for (const arg of site.args || []) {
            if (arg.kind === 'object') inspectMessage(arg);
            if (arg.kind === 'literal' || (arg.kind === 'candidates' && valueCandidates(arg).some(value => value.kind === 'literal' && recoveryOperations.has(value.value)))) operations.push(arg);
          }
          if (messageCall) inspectMessage(site.args?.[0]);
          if (method === 'runWorkerJob') operations.push(site.args?.[1]);
        }
        const values = operations.flatMap(value => valueCandidates(value));
        if (operations.some(value => !value) || values.some(value => value.opaque || !['literal', 'candidates'].includes(value.kind))) unknownOperation = true;
        const workerRecover = values.some(value => value.kind === 'literal' && recoveryOperations.has(value.value));
        if (siteAllowed(boundary, 'ARCH-PUBLICATION-RECOVERY-ENTRY', site)) continue;
        if (unknownOperation && governed) emit('ARCH-STATIC-COVERAGE', boundary, site, '受保护 worker operation 无法完整解释，须登记准确授权调用或使用可解析操作');
        if (!restricted && !internal && !workerRecover) continue;
        emit('ARCH-PUBLICATION-RECOVERY-ENTRY', boundary, site, '恢复副作用仅允许准确登记的授权 dispatcher 事务调用');
      }
    }
    if (rules.includes('ARCH-BIZOP-QUERY')) {
      const reached = executionScopes(scan, boundary.protectedScopes, { stop: target => boundary.allowedLocal.includes(target) });
      for (const site of reached.unresolvedCalls) if (!siteAllowed(boundary, 'ARCH-BIZOP-QUERY', site)) emit('ARCH-STATIC-COVERAGE', boundary, site, '读取 helper 的动态执行目标无法完整解释');
      for (const site of reached.sites) {
        if (siteAllowed(boundary, 'ARCH-BIZOP-QUERY', site)) continue;
        if (site.type === 'call' && ['prepare', 'exec'].includes(site.method || (site.chain || []).at(-1)) && !(site.method === 'exec' && site.reference?.object?.kind === 'regexp') && valueCandidates(site.reference).some(value => value.opaque || ['unknown', 'call-result'].includes(value.kind))) emit('ARCH-STATIC-COVERAGE', boundary, site, '受保护读取作用域的 DB alias 来源无法解释');
        if (site.type === 'db-operation') {
          const sql = site.args && site.args[0];
          const query = sql && sql.kind === 'literal' && typeof sql.value === 'string' ? sql.value : null;
          if (boundary.id.endsWith('-q1') && query && !/\barchive_[a-z_]+\b/i.test(query)) continue;
          emit(query ? 'ARCH-BIZOP-QUERY' : 'ARCH-STATIC-COVERAGE', boundary, site,
            query ? '读取协调器不得通过原始 DB 读取事实；使用 query facade / Archive repository' : '受保护读取作用域存在不透明 DB 调用或动态 SQL');
        }
        if (site.type === 'call' && (site.args || []).some(a => a.kind === 'reference' && (a.chain || []).includes('db'))
          && !/\.(?:prepare|exec)$/.test(site.callee || '')) emit('ARCH-BIZOP-QUERY', boundary, site, '原始 DB 句柄不能透传到读取 helper');
        if (site.type === 'new' && site.binding && /sqlite/.test(site.binding.from || '')) emit('ARCH-BIZOP-QUERY', boundary, site, '读取协调器不能新建数据库连接');
      }
    }
    if (rules.includes('ARCH-MODAL-OWNER')) for (const site of sites.filter(s => s.type === 'modal-write')) {
      if (!boundary.entrypoints.includes(site.from)) emit('ARCH-MODAL-OWNER', boundary, site, 'modalRoot 的挂载、移除和清空必须经 modalHost');
    }
    if (rules.includes('ARCH-RENDERER-SCOPE')) {
      const protectedFiles = new Set(starts);
      for (const site of sites.filter(s => protectedFiles.has(s.from))) {
        if (site.type === 'reflection') emit('ARCH-STATIC-COVERAGE', boundary, site, '受保护 Renderer 禁止 eval、Function 或动态全局属性访问');
        if (site.type === 'global-read' && (site.chain || []).includes('desktopApi')) emit('ARCH-RENDERER-SCOPE', boundary, site, '控制器只能消费显式 scoped API，不能读取完整 desktopApi');
      }
      checkClosure('ARCH-RENDERER-SCOPE', edge => edge.external === false && (boundary.allowedLocal.includes(edge.to) || starts.includes(edge.to)));
      const { createRendererContracts, rendererDataLiteral } = require('./renderer-contracts');
      const contracts = createRendererContracts(scan);
      for (const site of boundary.factory ? factoryCalls(scan, boundary.factory) : []) {
        const analysis = scan.analyses.get(site.from);
        const input = contracts.resolve(site.args && site.args[0], analysis);
        if (input.kind !== 'object') { emit('ARCH-STATIC-COVERAGE', boundary, site, '工厂入参必须是可解释的具名依赖对象'); continue; }
        for (const [name, value] of Object.entries(input.properties)) {
          if (!boundary.factory.parameters.includes(name) || ['state', 'elements', 'desktopApi'].includes(name)) {
            emit('ARCH-RENDERER-SCOPE', boundary, site, `工厂注入了未授权字段 ${name}`); continue;
          }
          if (['panel', 'legacyPanel'].includes(name)) {
            if (value.kind !== 'panel-node') emit('ARCH-RENDERER-SCOPE', boundary, site, `工厂字段 ${name} 必须是明确的领域面板节点`);
            continue;
          }
          if (['initialInfo', 'initialBillCategory'].includes(name)) {
            if (!rendererDataLiteral(value, 'app:get-info')) emit('ARCH-RENDERER-SCOPE', boundary, site,
              `工厂字段 ${name} 必须是递归纯数据或明确的 app:get-info IPC 数据`);
            continue;
          }
          const allowed = boundary.allowedApiFields[name];
          if (allowed) {
            const inspect = (object, prefix = '') => {
              if (object.kind !== 'object') {
                emit(['whole-desktop-api', 'whole-application-state'].includes(object.reason) ? 'ARCH-RENDERER-SCOPE' : 'ARCH-STATIC-COVERAGE', boundary, site, `scoped ${name}${prefix ? '.' + prefix : ''} 未提供可解释方法集合`); return;
              }
              for (const [key, member] of Object.entries(object.properties)) {
                const field = prefix ? `${prefix}.${key}` : key;
                if (allowed.some(method => method.startsWith(`${field}.`))) inspect(member, field);
                else if (!allowed.includes(field)) emit('ARCH-RENDERER-SCOPE', boundary, site, `scoped ${name} 未授权字段 ${field}`);
                else if (name === 'config' && field === 'initialBillCategory') {
                  if (!rendererDataLiteral(member, 'app:get-info')) emit('ARCH-RENDERER-SCOPE', boundary, site,
                    '工厂字段 config.initialBillCategory 必须是递归纯数据或明确的 app:get-info IPC 数据');
                }
                else if (!['function', 'native-function', 'literal'].includes(member.kind) && !rendererDataLiteral(member) && !(name === 'config' && member.kind === 'ipc-data') && !(member.kind === 'reference' && member.rootFree &&
                  ((['window', 'globalThis'].includes(member.chain?.[0]) && member.chain[1] === 'desktopApi' && member.chain.length >= field.split('.').length + 2) ||
                    (member.chain?.[0] === 'desktopApi' && member.chain.length >= field.split('.').length + 1)) &&
                  member.chain.slice(-field.split('.').length).join('.') === field)) {
                  emit('ARCH-STATIC-COVERAGE', boundary, site, `scoped ${name}.${field} 的方法来源无法解释`);
                }
              }
            };
            inspect(value);
          } else if (['unknown', 'call-result', 'candidates'].includes(value.kind) || value.opaque ||
            (value.chain || []).some(part => ['state', 'elements', 'desktopApi'].includes(part))) {
            // 普通布尔比较是值配置，不承载 API/应用状态引用。
            if (value.kind === 'unknown' && value.reason === 'BinaryExpression') continue;
            emit('ARCH-RENDERER-SCOPE', boundary, site, `工厂字段 ${name} 不能注入完整可变对象或不透明 alias`);
          }
        }
      }
    }
    const scripts = scan.scripts || [];
    const loads = file => scripts.filter(script => script.path === file);
    const guaranteedBefore = (provider, consumer) => {
      // module 可能含顶层 await，async 没有可保证的先行关系。
      if (provider.async || provider.type === 'module') return false;
      if (consumer.async) return !provider.defer && provider.order < consumer.order;
      const consumerDeferred = consumer.defer || consumer.type === 'module';
      if (!provider.defer && consumerDeferred) return true;
      if (provider.defer && !consumerDeferred) return false;
      return provider.order < consumer.order;
    };
    for (const global of boundary.globals) if (files.has(global.path)) {
      if (!loads(global.path).length) emit('ARCH-STATIC-COVERAGE', boundary, { from: global.path }, '经典脚本入口尚未被 index.html 生产装配');
      if (boundary.state === 'active' || global.path.startsWith('src/renderer/')) for (const name of global.exportsGlobal) {
        if (!(scan.globals || []).some(s => s.from === global.path && s.type === 'global-write' && ((s.chain || []).slice(1).join('.') === name || s.name === name))) emit('ARCH-STATIC-COVERAGE', boundary, { from: global.path }, `登记的全局工厂 ${name} 没有实际导出`);
      }
      for (const name of global.consumesGlobals) {
        const provider = allBoundaries.flatMap(b => b.globals).find(g => g.exportsGlobal.includes(name));
        if (!provider || !loads(global.path).length || !loads(global.path).every(consumer => loads(provider.path).some(producer => guaranteedBefore(producer, consumer)))) emit('ARCH-RENDERER-SCOPE', boundary, { from: global.path, to: provider && provider.path }, `全局服务 ${name} 未在消费者之前加载`);
      }
    }
    for (const old of boundary.deprecatedEntrypoints) {
      const incoming = edges.filter(e => e.to === old.path && (old.exportNames === null || !(e.importedNames || []).length || e.importedNames.some(n => old.exportNames.includes(n))));
      for (const edge of incoming) {
        const known = old.existingConsumers.some(c => c.from === edge.from && c.kind === edge.kind
          && JSON.stringify([...c.importedNames].sort()) === JSON.stringify([...(edge.importedNames || [])].sort()));
        if (old.state === 'retired' || boundary.state === 'active' || !known) emit('ARCH-XLSX-INFRA', boundary, edge,
          old.state === 'retired' ? '已退役入口恢复了生产消费者' : '生产消费者须迁往中性 XLSX 入口，旧 API 不得增加消费方');
      }
      if (old.state === 'retired') for (const evidence of old.retirementEvidence) if (!exists(evidence)) emit('ARCH-STATIC-COVERAGE', boundary, { from: evidence }, '缺少兼容验证及全仓引用清点证据');
    }
  }
  const matchedExceptions = []; const hits = new Set(); const remaining = [];
  for (const violation of violations) {
    const match = allowlist.exceptions.find(e => e.rule === violation.rule && e.from === violation.from
      && (e.rule !== 'ARCH-CYCLE' || (!violation.literalCycle && JSON.stringify(e.cycleEdges) === JSON.stringify(violation.cycleEdges) && JSON.stringify(e.edgeKinds) === JSON.stringify(violation.edgeKinds)))
      && (e.to === undefined || (e.to === violation.to && e.kind === violation.kind))
      && (e.evidenceId === undefined || (e.evidenceId === violation.evidenceId && e.functionPath === violation.functionPath))
      && (e.importedNames === undefined || JSON.stringify([...e.importedNames].sort()) === JSON.stringify([...(violation.importedNames || [])].sort())));
    const active = allBoundaries.find(b => b.id === violation.boundaryId && b.state === 'active');
    if (match && !(active && active.governance !== 'G8')) { hits.add(match.id); matchedExceptions.push({ ...violation, exceptionId: match.id }); }
    else remaining.push(violation);
  }
  const unique = values => sorted([...new Map(values.map(v => [JSON.stringify(v), v])).values()]);
  return { violations: unique(remaining), matchedExceptions: unique(matchedExceptions),
    staleExceptions: sorted(allowlist.exceptions.filter(e => !hits.has(e.id)).map(e => ({ id: e.id, rule: e.rule, from: e.from, message: '旧位置已无匹配，请在同一治理变更删除例外' }))),
    activeBoundaries: activeBoundaries.sort(), pendingBoundaries: pendingBoundaries.sort(), partialBoundaries: partialBoundaries.sort() };
}
module.exports = { RULES, evaluateRules, cycles, validateBoundaries, validateAllowlist };
