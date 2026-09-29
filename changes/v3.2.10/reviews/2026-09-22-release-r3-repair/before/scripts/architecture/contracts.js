'use strict';

// 执行规则和历史防倒退必须使用相同的词法包含关系。
function scopeContains(outer, inner) {
  return outer.path === inner.path && (outer.functionPath === null || outer.functionPath === inner.functionPath ||
    (inner.functionPath !== null && inner.functionPath.startsWith(`${outer.functionPath}.`)));
}

function valueCandidates(value, seen = new Set()) {
  if (!value || seen.has(value)) return [];
  const next = new Set([...seen, value]);
  return [value, ...(value.alternatives || value.values || []).flatMap(item => valueCandidates(item, next))];
}

function factoryCalls(scan, factory) {
  return scan.sites.filter(site => site.type === 'call' && valueCandidates(site.reference).some(value =>
    (value.chain || []).at(-1) === factory.name || value.functionPath?.split('.').at(-1) === factory.name));
}

function factoryPresent(scan, factory) {
  const analysis = scan.analyses.get(factory.path);
  if (!analysis) return false;
  const actualFunction = value => Boolean(value && !value.opaque && value.functionPath && analysis.functionNodes.has(value.functionPath));
  const exportedValue = value => {
    if (value?.kind !== 'call-result' || value.args.length || !value.callee?.functionPath) return value;
    const fn = analysis.functionNodesByStart.get(value.callee.functionStart);
    const invocation = fn && analysis.parents.get(fn);
    if (!fn || fn.params.length || invocation?.type !== 'CallExpression' || invocation.callee !== fn) return value;
    const returned = fn.body.type === 'BlockStatement' ? fn.body.body.at(-1) : null;
    const expression = fn.body.type === 'BlockStatement' ? returned?.type === 'ReturnStatement' && returned.argument : fn.body;
    return expression ? analysis.describe(expression) : value;
  };

  const exportedMember = (value, name) => value?.kind === 'object' && !(value.spreads || []).length &&
    Object.entries(value.properties).some(([key, member]) => (key === name && actualFunction(member)) || exportedMember(member, name));
  return analysis.nodes.some(node => {
    if (node.type === 'AssignmentExpression' && node.operator === '=') {
      const target = analysis.describe(node.left); const chain = target.chain || [];
      const publicTarget = target.rootFree && (['window', 'globalThis', 'exports'].includes(chain[0]) || chain.slice(0, 2).join('.') === 'module.exports');
      if (!publicTarget) return false;
      const value = exportedValue(analysis.describe(node.right));
      return (chain.at(-1) === factory.name && actualFunction(value)) || exportedMember(value, factory.name);
    }
    if (node.type === 'ExportNamedDeclaration') {
      if (node.declaration?.type === 'FunctionDeclaration') return node.declaration.id?.name === factory.name;
      if (node.declaration?.type === 'VariableDeclaration') return node.declaration.declarations.some(item => item.id.name === factory.name && actualFunction(analysis.describe(item.init)));
      return node.specifiers.some(item => item.exported.name === factory.name && actualFunction(analysis.describe(item.local)));
    }
    return false;
  });
}

// 参数代表显式注入合同；本地返回值只读取 AST，不执行 helper 或 getter。
function callableOrigins(value, analysis, seen = new Set(), members = []) {
  const unknown = () => ({ known: false, modules: [], functions: [], targets: [] });
  const combine = origins => ({ known: origins.length > 0 && origins.every(item => item.known),
    modules: origins.flatMap(item => item.modules), functions: origins.flatMap(item => item.functions),
    targets: origins.flatMap(item => item.targets),
    unresolvedReturn: origins.some(item => item.unresolvedReturn) });
  if (!value || seen.has(value)) return unknown();
  const next = new Set([...seen, value]);
  const choices = value.alternatives || value.values;
  if (choices) return combine(choices.map(item => callableOrigins(item, analysis, next, members)));
  // service.group.settle 在本地工厂返回值上逐层选择，不能丢掉具体成员。
  if (['member-base', 'computed-member'].includes(value.reason)) return callableOrigins(value.object, analysis, next, [value.property, ...members]);
  if (value.kind === 'object') {
    if (!members.length || value.opaque || (value.spreads || []).length || !Object.hasOwn(value.properties, members[0])) return unknown();
    return callableOrigins(value.properties[members[0]], analysis, next, members.slice(1));
  }
  if (value.kind === 'array' && members.length === 1 && ['map', 'filter', 'flatMap', 'slice', 'concat', 'reverse', 'forEach', 'some', 'every', 'find', 'includes', 'join'].includes(members[0])) return { known: true, modules: [], functions: [], targets: [] };
  if (value.kind === 'bound-function') return members.length ? unknown() : callableOrigins(value.target, analysis, next);
  if (value.kind === 'call-result') {
    // 无 reviver 的原生 JSON.parse 只产生数据；其数组读取方法不携带领域函数。
    if (value.callee?.rootFree && value.callee.chain?.join('.') === 'JSON.parse' && value.args.length === 1 &&
      ['map', 'slice'].includes(members.at(-1))) return { known: true, modules: [], functions: [], targets: [] };
    if (value.callee?.module) return { known: true, modules: [value.callee.module], functions: [], targets: [] };
    const name = value.callee?.functionPath;
    const fn = analysis?.functionNodesByStart?.get(value.callee?.functionStart) || analysis?.functionNodes.get(name);
    if (!fn) return unknown();
    if (next.has(fn)) return { ...unknown(), unresolvedReturn: true };
    next.add(fn);
    const returns = fn.type === 'ArrowFunctionExpression' && fn.body.type !== 'BlockStatement' ? [fn.body] :
      analysis.nodes.filter(node => node.type === 'ReturnStatement' && node.start >= fn.start && node.end <= fn.end && analysis.functionPath(node) === name).map(node => node.argument);
    const result = combine(returns.map(node => callableOrigins(analysis.describe(node), analysis, next, members)));
    result.unresolvedReturn ||= !result.known;
    result.functions.push(name); return result;
  }
  // targets 只标识最终被调用的能力；functions 仍包含返回链中的工厂，用于依赖闭包。
  if (value.module) return { known: members.every(member => typeof member === 'string'), modules: [value.module], functions: [],
    targets: members.every(member => typeof member === 'string') ? [JSON.stringify(['module', value.module, ...(value.chain || []), ...members])] : [] };
  return { known: Boolean((!members.length && value.functionPath) || value.bindingKind === 'parameter' || value.kind === 'literal' || value.kind === 'regexp'),
    modules: [], functions: !members.length && value.functionPath ? [value.functionPath] : [],
    targets: !members.length && value.functionPath ? [JSON.stringify(['local', analysis.from, value.functionStart ?? value.functionPath])] : [] };
}

// bind 创建函数不执行目标；调用时合并预绑定实参。call/apply 在 scanner 入口去除 thisArg。
function callTargets(reference, args, method = null, seen = new Set()) {
  if (!reference || seen.has(reference)) return [{ reference: { kind: 'unknown', reason: 'recursive-call' }, args, method }];
  const next = new Set([...seen, reference]);
  if (reference.kind === 'bound-function') return callTargets(reference.target, [...reference.args, ...args], reference.method, next);
  if (reference.kind === 'candidates' || reference.alternatives) {
    return (reference.values || reference.alternatives).flatMap(value => callTargets(value, args, method, next));
  }
  return [{ reference, args, method: reference.chain?.at(-1) || reference.property || method }];
}


// 读取/通用具名编排按实际调用追踪；模块被装载不代表所有导出都执行。
// 不可解释的导出保守退回该 helper 全文件，禁止把未知别名当成安全边界。
function executionScopes(scan, roots, { stop = () => false, skipSite = () => false } = {}) {
  const scopes = []; const visited = new Set(); const exportsCache = new Map(); const locationCache = new Map();
  const parameterValues = new Map(); let parameterRevision = 0;
  const rootPaths = new Set(roots.map(scope => scope.path));
  const allSites = (scan.sites || []).flatMap(site => site.invocations ? site.invocations.map(invocation => ({ ...site, ...invocation })) : [site]);
  const sitesByFile = new Map(); const edgesByFile = new Map();
  for (const site of allSites) { if (!sitesByFile.has(site.from)) sitesByFile.set(site.from, []); sitesByFile.get(site.from).push(site); }
  for (const edge of scan.edges || []) { if (!edgesByFile.has(edge.from)) edgesByFile.set(edge.from, []); edgesByFile.get(edge.from).push(edge); }
  function add(path, functionPath, mode = 'exact', thread = 'main') {
    if (stop(path) && !rootPaths.has(path)) return;
    const key = JSON.stringify([path, functionPath, mode, thread]);
    if (!visited.has(key)) { visited.add(key); scopes.push({ path, functionPath, mode, thread }); }
  }
  function inThread(site, thread) {
    const analysis = scan.analyses.get(site.from);
    if (!analysis) return true;
    if (!locationCache.has(site.from)) {
      const locations = new Map();
      for (const node of analysis.nodes) { const key = `${node.loc.start.line}:${node.loc.start.column}`; if (!locations.has(key)) locations.set(key, node); }
      locationCache.set(site.from, locations);
    }
    const node = locationCache.get(site.from).get(`${site.line}:${site.column}`);
    const truth = test => {
      if (test.type === 'UnaryExpression' && test.operator === '!') { const inner = truth(test.argument); return inner === null ? null : !inner; }
      const reference = analysis.describe(test);
      if (reference.module === 'node:worker_threads' && reference.chain?.join('.') === 'isMainThread') return thread === 'main';
      return null;
    };
    for (let current = node; current; current = analysis.parents.get(current)) {
      if (current.type !== 'IfStatement') continue;
      const value = truth(current.test);
      if (value === null) continue;
      const excluded = value ? current.alternate : current.consequent;
      if (excluded && node.start >= excluded.start && node.end <= excluded.end) return false;
    }
    return true;
  }
  const matches = (site, scope) => site.from === scope.path && inThread(site, scope.thread) && (scope.mode === 'subtree'
    ? scopeContains(scope, { path: site.from, functionPath: site.functionPath ?? null })
    : (site.functionPath ?? null) === scope.functionPath);
  function exportValue(analysis) {
    if (exportsCache.has(analysis.from)) return exportsCache.get(analysis.from);
    let value = { kind: 'object', properties: {}, spreads: [] };
    for (const node of analysis.nodes) {
      if (analysis.functionPath(node) !== null) continue;
      if (node.type === 'AssignmentExpression' && node.operator === '=') {
        const target = analysis.describe(node.left); const chain = target.chain || [];
        if (!target.rootFree) continue;
        if (chain.join('.') === 'module.exports') value = analysis.describe(node.right);
        else if ((chain[0] === 'exports' && chain.length === 2) || (chain[0] === 'module' && chain[1] === 'exports' && chain.length === 3)) {
          if (value.kind !== 'object') value = { kind: 'object', properties: {}, spreads: [value] };
          value.properties[chain.at(-1)] = analysis.describe(node.right);
        }
      }
      if (node.type === 'ExportDefaultDeclaration') value.properties.default = analysis.describe(node.declaration);
      if (node.type === 'ExportNamedDeclaration') {
        if (node.declaration?.id) value.properties[node.declaration.id.name] = analysis.describe(node.declaration);
        if (node.declaration?.declarations) for (const item of node.declaration.declarations) {
          if (item.id.type === 'Identifier') value.properties[item.id.name] = analysis.describe(item.init);
        }
        for (const specifier of node.specifiers || []) {
          if (!node.source) value.properties[specifier.exported.name] = analysis.describe(specifier.local);
          else {
            const edge = (edgesByFile.get(analysis.from) || []).find(e => e.specifier === node.source.value);
            if (edge) value.properties[specifier.exported.name] = { kind: 'reference', module: edge.to, external: edge.external, chain: [specifier.local.name] };
          }
        }
      }
    }
    exportsCache.set(analysis.from, value); return value;
  }
  function bindArguments(target, args, caller) {
    if (!target.node) return;
    target.node.params.forEach((_param, index) => {
      if (!args[index]) return;
      const key = `${target.analysis.from}:${target.node.start}:${index}`;
      if (!parameterValues.has(key)) parameterValues.set(key, []);
      const values = parameterValues.get(key);
      if (!values.some(item => item.value === args[index] && item.analysis === caller)) {
        values.push({ value: args[index], analysis: caller }); parameterRevision += 1;
      }
    });
  }
  function parameterArguments(value, analysis) {
    if (value?.bindingKind !== 'parameter') return [];
    const fn = analysis.functionNodesByStart.get(value.bindingFunctionStart) || analysis.functionNodes.get(value.bindingFunctionPath);
    const binding = fn && analysis.lookup(value.chain[0], fn.body);
    if (!binding) return [];
    return (parameterValues.get(`${analysis.from}:${fn.start}:${binding.parameterIndex}`) || []).map(item => ({ ...item,
      selection: [...binding.selector, ...value.chain.slice(1)] }));
  }
  function constantKeys(value, analysis, seen = new Set()) {
    if (!value || seen.has(value)) return [null];
    const next = new Set([...seen, value]);
    const inputs = parameterArguments(value, analysis);
    if (inputs.length) return inputs.flatMap(item => item.selection.length ? [null] : constantKeys(item.value, item.analysis, next));
    if (value.kind === 'literal' && (typeof value.value === 'string' || Number.isSafeInteger(value.value))) return [String(value.value)];
    const choices = value.alternatives || value.values;
    return choices?.length ? choices.flatMap(item => constantKeys(item, analysis, next)) : [null];
  }
  function resolve(value, analysis, members = [], seen = new Set(), coverage = {}) {
    if (!value || seen.has(value)) return [];
    const next = new Set([...seen, value]);
    const inputs = parameterArguments(value, analysis);
    if (inputs.length) return inputs.flatMap(item => resolve(item.value, item.analysis, [...item.selection, ...members], next, coverage));
    const choices = value.alternatives || value.values;
    if (choices) return choices.flatMap(item => resolve(item, analysis, members, next, coverage));
    if (value.reason === 'computed-member' && value.propertyValue) return constantKeys(value.propertyValue, analysis).filter(key => key !== null)
      .flatMap(key => resolve(value.object, analysis, [key, ...members], next, coverage));
    if (['member-base', 'computed-member'].includes(value.reason)) return resolve(value.object, analysis, [value.property, ...members], next, coverage);
    if (value.kind === 'bound-function') return resolve(value.target, analysis, members, next, coverage);
    if (value.module) {
      if (value.external || stop(value.module)) return [];
      const imported = scan.analyses.get(value.module);
      if (!imported) return [];
      const selection = [...(value.chain || []), ...members];
      const exported = exportValue(imported);
      const selected = resolve(exported, imported, selection, next, coverage);
      // 精确导出缺失或动态选择仍以该 helper 的全部职责保守检查。
      if (!selected.length && selection.length && (exported.kind !== 'object' || !Object.hasOwn(exported.properties, selection[0]))) return [{ analysis: imported, all: true }];
      return selected;
    }
    if (value.kind === 'object') {
      if (!members.length) return [];
      if (typeof members[0] !== 'string' || !Object.hasOwn(value.properties, members[0])) return (value.spreads || []).flatMap(item => resolve(item, analysis, members, next, coverage));
      return resolve(value.properties[members[0]], analysis, members.slice(1), next, coverage);
    }
    if (value.kind === 'array') {
      if (!members.length || !/^(0|[1-9][0-9]*)$/.test(members[0])) return [];
      const targets = resolve(value.elements[Number(members[0])], analysis, members.slice(1), next, coverage);
      // 只有被当作函数调用的数组元素需要能力证明；数据元素上的原生方法另按既有规则解释。
      if (!targets.length && members.length === 1) coverage.unresolvedArray = true;
      return targets;
    }
    if (value.kind === 'call-result') {
      if (value.callee?.bindingKind === 'class' || value.callee?.kind === 'class') return resolve(value.callee, analysis, members, next, coverage);
      // 只选工厂返回的能力；工厂本身是否执行由对应 CallExpression 决定。
      const factories = resolve(value.callee, analysis, [], next, coverage);
      for (const factory of factories) bindArguments(factory, value.args, analysis);
      const instanceMethods = members.length ? resolve(value.callee, analysis, members, next, coverage) : [];
      return [...instanceMethods, ...factories.flatMap(factory => {
        if (factory.all) return [factory];
        const fn = factory.node;
        if (!fn) return [];
        const own = factory.analysis;
        const name = own.functionPath(fn);
        const returns = fn.type === 'ArrowFunctionExpression' && fn.body.type !== 'BlockStatement' ? [fn.body] : own.nodes.filter(node =>
          node.type === 'ReturnStatement' && node.start >= fn.start && node.end <= fn.end && own.functionPath(node) === name).map(node => node.argument);
        return returns.flatMap(node => resolve(own.describe(node), own, members, next, coverage));
      })];
    }
    if (value.functionPath && members.length === 0) {
      const node = analysis.functionNodesByStart.get(value.functionStart) || analysis.functionNodes.get(value.functionPath);
      return node ? [{ analysis, node }] : [];
    }
    // 类实例的方法与 constructor 都按真实 AST 定位，避免退回整模块。
    if (value.bindingKind === 'class' || value.kind === 'class') {
      const declaration = analysis.nodes.find(node => node.start === value.classStart && ['ClassDeclaration', 'ClassExpression'].includes(node.type));
      const method = members[0] || 'constructor';
      if (declaration) return declaration.body.body.filter(item => item.type === 'MethodDefinition' && (item.key.name || item.key.value) === method)
        .map(item => ({ analysis, node: item.value }));
    }
    return [];
  }
  const calledTargets = (site, coverage) => resolve(site.reference, scan.analyses.get(site.from), [], new Set(), coverage);
  for (const scope of roots) add(scope.path, scope.functionPath, 'subtree');
  let checkedRevision = -1;
  while (checkedRevision !== parameterRevision) {
    checkedRevision = parameterRevision;
    for (let index = 0; index < scopes.length; index += 1) {
      const scope = scopes[index];
      for (const edge of edgesByFile.get(scope.path) || []) if (!edge.external && edge.callee !== 'require.resolve' && matches(edge, scope)) {
        // require/import 执行顶层初始化；不执行其未调用的函数体。
        add(edge.to, null, 'exact', edge.kind === 'worker' ? 'worker' : scope.thread);
      }
      for (const site of sitesByFile.get(scope.path) || []) {
        if (!matches(site, scope) || !['call', 'new'].includes(site.type) || skipSite(site)) continue;
        const targets = calledTargets(site);
        for (const target of targets) {
          bindArguments(target, site.args || [], scan.analyses.get(site.from));
          add(target.analysis.from, target.all ? null : target.analysis.functionPath(target.node), target.all ? 'subtree' : 'exact', scope.thread);
        }
        // 可解析 helper 只沿实际调用的参数成员传播；原生/注入执行器的直接回调保守视为可能执行。
        if (!targets.length) for (const arg of site.args || []) for (const callback of resolve(arg, scan.analyses.get(site.from))) {
          add(callback.analysis.from, callback.all ? null : callback.analysis.functionPath(callback.node), callback.all ? 'subtree' : 'exact', scope.thread);
        }
      }
    }
  }
  const reachedSites = allSites.filter(site => scopes.some(scope => matches(site, scope)));
  const unresolvedCalls = reachedSites.filter(site => {
    if (!['call', 'new'].includes(site.type)) return false;
    const coverage = {}; calledTargets(site, coverage);
    return coverage.unresolvedArray || (site.dynamicCallee &&
      valueCandidates(site.reference).some(value => value.reason === 'computed-member' && value.property === undefined &&
        constantKeys(value.propertyValue, scan.analyses.get(site.from)).includes(null)));
  });
  return { scopes, sites: reachedSites, calledTargets, unresolvedCalls };
}

module.exports = { scopeContains, valueCandidates, factoryCalls, factoryPresent, callableOrigins, callTargets, executionScopes };
