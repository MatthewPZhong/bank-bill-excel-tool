'use strict';

// 只解释静态对象、命名工厂返回与显式参数转发；不执行 Renderer/Preload。
const cache = new WeakMap();
function createRendererContracts(scan) {
  if (cache.has(scan)) return cache.get(scan);
  const analyses = scan.analyses;
  const globals = new Map();
  const objectNodes = new Map([...analyses].map(([file, analysis]) =>
    [file, new Map(analysis.nodes.filter(node => node.type === 'ObjectExpression').map(node => [node.start, node]))]));
  const unknown = reason => ({ kind: 'unknown', reason });
  const pathOf = value => value?.chain || [];
  const directName = node => node?.type === 'MemberExpression' && !node.computed ? node.property.name : null;
  const sameObject = (actual, value) => {
    if (value.objectStart !== undefined && actual?.objectStart === value.objectStart) return true;
    if ((actual?.alternatives || actual?.values || []).some(item => sameObject(item, value))) return true;
    return value.objectStart === undefined && value.chain?.length &&
      actual?.chain?.join('.') === value.chain.join('.') && actual.bindingFunctionPath === value.bindingFunctionPath;
  };
  for (const [file, analysis] of analyses) for (const node of analysis.nodes) {
    if (node.type === 'AssignmentExpression') {
      const target = analysis.describe(node.left); const chain = pathOf(target);
      const entry = (scan.globals || []).find(site => site.from === file && site.type === 'global-write' && site.line === node.left.loc.start.line && site.column === node.left.loc.start.column);
      if (entry && chain.length >= 2) {
        const name = chain.slice(1).join('.');
        globals.set(name, { value: globals.has(name) ? unknown('mutable-global-provider') : analysis.describe(node.right), analysis });
      }
    }
    if (node.type === 'CallExpression' && directName(node.callee) === 'exposeInMainWorld' && node.arguments[0]?.type === 'Literal') {
      const target = analysis.describe(node.callee);
      if (target.module === 'electron') globals.set(node.arguments[0].value, { value: analysis.describe(node.arguments[1]), analysis });
    }
  }
  const select = (value, chain) => {
    for (const part of chain) {
      if (value?.kind === 'ipc-data') { value = { ...value, fields: [...(value.fields || []), part] }; continue; }
      if (value?.kind !== 'object' || !Object.hasOwn(value.properties, part)) return unknown('unresolved-static-member');
      value = value.properties[part];
    }
    return value;
  };
  function bindPattern(pattern, value, env) {
    if (!pattern) return;
    if (pattern.type === 'AssignmentPattern') return bindPattern(pattern.left, value, env);
    if (pattern.type === 'Identifier') { env.set(pattern.name, value); return; }
    if (pattern.type === 'ObjectPattern') for (const property of pattern.properties) {
      if (property.type === 'Property' && !property.computed) bindPattern(property.value, select(value, [property.key.name || property.key.value]), env);
    }
  }
  function resolve(value, analysis, env = new Map(), depth = 0, visited = new Set()) {
    if (!value || depth > 35 || visited.has(value)) return unknown('recursive-renderer-value');
    const next = new Set([...visited, value]);
    const recurse = (item, source = analysis, context = env) => resolve(item, source, context, depth + 1, next);
    if (value.kind === 'literal' || value.kind === 'regexp') return value;
    if (value.functionPath) return { ...value, kind: 'function', sourceFile: analysis.from, sourceEnv: env };
    if (value.kind === 'bound-function') {
      const target = recurse(value.target);
      return target.kind === 'function' || target.kind === 'native-function'
        ? { ...target, boundArgs: [...(target.boundArgs || []), ...value.args.map(item => recurse(item))] }
        : unknown('unresolved-bound-function');
    }
    if (value.kind === 'array') return { ...value, elements: value.elements.map(item => recurse(item)) };
    if (value.kind === 'object') {
      const properties = {};
      // 重新解释原始顺序，避免通用扫描器展开 spread 时丢失来源身份或覆盖顺序。
      const literal = objectNodes.get(analysis.from)?.get(value.objectStart);
      if (literal) {
        for (const property of literal.properties) {
          if (property.type === 'SpreadElement') {
            const expanded = recurse(analysis.describe(property.argument));
            if (expanded.kind !== 'object') return unknown('opaque-renderer-spread');
            Object.assign(properties, expanded.properties);
          } else {
            const key = property.computed ? recurse(analysis.describe(property.key))
              : { kind: 'literal', value: property.key.name ?? property.key.value };
            if (key.kind !== 'literal' || property.kind !== 'init') return unknown('computed-or-accessor');
            properties[key.value] = recurse(analysis.describe(property.value));
          }
        }
      } else {
        for (const spread of value.spreads || []) {
          const expanded = recurse(spread);
          if (expanded.kind !== 'object') return unknown('opaque-renderer-spread');
          Object.assign(properties, expanded.properties);
        }
        for (const [key, member] of Object.entries(value.properties)) properties[key] = recurse(member);
      }
      // 向未知 helper 传出能力对象可能改变其成员；不执行或猜测这些写入。
      if (value.chain?.length) for (const node of analysis.nodes) {
        if (node.type !== 'CallExpression') continue;
        const escaped = node.arguments.some(argument => {
          const actual = analysis.describe(argument);
          return sameObject(actual, value);
        });
        const callee = analysis.describe(node.callee);
        if (escaped && !(callee.rootFree && ['Object.freeze', 'Object.seal', 'Object.keys', 'Object.values', 'Object.entries'].includes(pathOf(callee).join('.')))) return unknown('escaped-renderer-object');
      }
      // 对象声明后的静态写入属于同一能力集合，不能只看初始字面量。
      if (value.chain?.length) for (const node of analysis.nodes) {
        if (node.type !== 'AssignmentExpression' || node.left.type !== 'MemberExpression') continue;
        const base = analysis.describe(node.left.object);
        if (!sameObject(base, value)) continue;
        let keys = !node.left.computed ? [{ kind: 'literal', value: node.left.property.name }] : [recurse(analysis.describe(node.left.property))];
        if (keys.some(key => key.kind !== 'literal')) {
          const keyReference = analysis.describe(node.left.property);
          const callback = analysis.functionNodes.get(keyReference.bindingFunctionPath);
          const call = callback && analysis.parents.get(callback);
          if (callback && call?.type === 'CallExpression' && directName(call.callee) === 'forEach') {
            const list = recurse(analysis.describe(call.callee.object));
            if (list.kind === 'array') keys = list.elements;
          }
        }
        if (!keys.length || keys.some(key => key.kind !== 'literal' || typeof key.value !== 'string')) return unknown('dynamic-renderer-member-write');
        for (const key of keys) properties[key.value] = recurse(analysis.describe(node.right));
      }
      return { kind: 'object', properties };
    }
    if (value.kind === 'candidates' || value.alternatives) {
      // && 左值只用于短路守卫，不能把 || 的完整 API 当成同类守卫。
      const choices = value.values || value.alternatives;
      if (value.operator === '&&') return recurse(choices.at(-1));
      const resolved = choices.map(item => recurse(item)).filter(item => !(item.kind === 'literal' && item.value == null));
      if (resolved.length === 1) return resolved[0];
      if (resolved.length && resolved.every(item => JSON.stringify(item) === JSON.stringify(resolved[0]))) return resolved[0];
      return unknown('ambiguous-renderer-value');
    }
    if (value.reason === 'member-base') {
      const object = recurse(value.object);
      if (object.kind === 'object' || object.kind === 'ipc-data') return select(object, [value.property]);
      return unknown('unresolved-renderer-member');
    }
    if (value.kind === 'reference') {
      const chain = pathOf(value);
      if (value.bindingKind === 'parameter') {
        if (env.has(chain[0])) return selectOrSelf(env.get(chain[0]), chain.slice(1));
        const fn = analysis.functionNodes.get(value.bindingFunctionPath);
        if (fn) {
          const calls = scan.sites.filter(site => site.type === 'call' &&
            ((site.from === analysis.from && site.reference?.functionPath === value.bindingFunctionPath) ||
              (site.reference?.rootFree && site.reference?.chain?.at(-1) === value.bindingFunctionPath.split('.').at(-1))));
          if (calls.length === 1) {
            const context = new Map();
            fn.params.forEach((param, index) => bindPattern(param, resolve(calls[0].args[index], analyses.get(calls[0].from), new Map(), depth + 1, next), context));
            if (context.has(chain[0])) return selectOrSelf(context.get(chain[0]), chain.slice(1));
          }
        }
        return { ...value, kind: 'parameter-value' };
      }
      const globalChain = ['window', 'globalThis'].includes(chain[0]) && value.rootFree ? chain.slice(1) : value.rootFree ? chain : null;
      if (globalChain) {
        if (globalChain[0] === 'desktopApi' && globalChain.length === 1) return unknown('whole-desktop-api');
        if (globalChain[0] === 'state' || globalChain[0] === 'elements') return unknown('whole-application-state');
        const provider = globals.get(globalChain[0]);
        if (provider) return selectOrSelf(recurse(provider.value, provider.analysis, new Map()), globalChain.slice(1));
        if (['alert', 'confirm'].includes(globalChain[0]) && globalChain.length === 1) return { kind: 'native-function' };
      }
      // 单一静态成员赋值仍可还原；多次赋值必须保留不透明诊断。
      if (chain.length > 1 && !value.opaque) {
        const writes = analysis.nodes.filter(node => node.type === 'AssignmentExpression' && node.operator === '=' &&
          pathOf(analysis.describe(node.left)).join('.') === chain.join('.'));
        if (writes.length === 1) return recurse(analysis.describe(writes[0].right));
      }
      return value;
    }
    if (value.kind === 'call-result') {
      const chain = pathOf(value.callee);
      if (value.callee.module === 'electron' && chain.join('.') === 'ipcRenderer.invoke' && value.args[0]?.kind === 'literal') return { kind: 'ipc-data', channel: value.args[0].value, fields: [] };
      if (value.callee.rootFree && ['document.getElementById', 'document.querySelector'].includes(chain.join('.')) && value.args.length === 1 && value.args[0]?.kind === 'literal') {
        const selector = value.args[0].value;
        const id = chain.at(-1) === 'getElementById' ? selector : typeof selector === 'string' && selector.startsWith('#') ? selector.slice(1) : null;
        if (typeof id === 'string' && /^[A-Za-z_][\w:-]*$/.test(id) && !['modalRoot', 'body', 'html'].includes(id)) return { kind: 'panel-node', id };
      }
      if (value.callee.rootFree && chain.join('.') === 'Object.keys' && value.args.length === 1) {
        const object = recurse(value.args[0]);
        if (object.kind === 'object') return { kind: 'array', elements: Object.keys(object.properties).map(key => ({ kind: 'literal', value: key })) };
      }
      const callee = recurse(value.callee);
      if (callee.kind !== 'function') return unknown('unregistered-renderer-factory');
      const source = analyses.get(callee.sourceFile) || analysis;
      const fn = source.functionNodesByStart.get(callee.functionStart) || source.functionNodes.get(callee.functionPath);
      if (!fn) return unknown('missing-renderer-factory');
      const context = new Map(callee.sourceEnv || []);
      const args = [...(callee.boundArgs || []), ...value.args.map(item => recurse(item))];
      fn.params.forEach((param, index) => bindPattern(param, args[index] || unknown('missing-factory-argument'), context));
      const returns = fn.body.type !== 'BlockStatement' ? [fn.body] : source.nodes.filter(node => node.type === 'ReturnStatement' &&
        node.start >= fn.start && node.end <= fn.end && source.functionPath(node) === callee.functionPath).map(node => node.argument);
      if (returns.length !== 1) return unknown('nonliteral-renderer-factory-return');
      return recurse(source.describe(returns[0]), source, context);
    }
    return value;
  }
  const selectOrSelf = (value, chain) => chain.length ? select(value, chain) : value;
  const result = { resolve, globals };
  cache.set(scan, result);
  return result;
}

function rendererDataLiteral(value, ipcChannel = null) {
  const data = item => rendererDataLiteral(item, ipcChannel);
  return value?.kind === 'literal' || (ipcChannel !== null && value?.kind === 'ipc-data' && value.channel === ipcChannel) ||
    (value?.kind === 'array' && value.elements.every(data)) || (value?.kind === 'object' && Object.values(value.properties).every(data));
}

module.exports = { createRendererContracts, rendererDataLiteral };
