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
  const exportedMember = (value, name) => value?.kind === 'object' && !(value.spreads || []).length &&
    Object.entries(value.properties).some(([key, member]) => (key === name && actualFunction(member)) || exportedMember(member, name));
  return analysis.nodes.some(node => {
    if (node.type === 'AssignmentExpression' && node.operator === '=') {
      const target = analysis.describe(node.left); const chain = target.chain || [];
      const publicTarget = target.rootFree && (['window', 'globalThis', 'exports'].includes(chain[0]) || chain.slice(0, 2).join('.') === 'module.exports');
      if (!publicTarget) return false;
      const value = analysis.describe(node.right);
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

module.exports = { scopeContains, valueCandidates, factoryCalls, factoryPresent, callableOrigins, callTargets };
