'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { builtinModules } = require('node:module');
const acorn = require('acorn');
const { callTargets } = require('./contracts');

const JS = /\.(?:js|cjs|mjs)$/;
const BUILTINS = new Set(builtinModules.map((name) => name.replace(/^node:/, '')));
const OMIT_AST_FIELDS = new Set(['start', 'end', 'loc', 'raw']);
const FUNCTION_TYPES = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);
const REQUIRE_CHAINS = new Set(['require', 'module.require', 'globalThis.require', 'window.require']);
const posix = (value) => value.split(path.sep).join('/');
const inside = (root, target) => target === root || target.startsWith(`${root}${path.sep}`);
const sorted = (items) => items.sort((a, b) => (a.from || '').localeCompare(b.from || '', 'en') || (a.line || 0) - (b.line || 0) || (a.column || 0) - (b.column || 0) || (a.type || a.kind || '').localeCompare(b.type || b.kind || '', 'en') || (a.to || '').localeCompare(b.to || '', 'en'));

function normalizeAst(value) {
  if (Array.isArray(value)) return value.map(normalizeAst);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).filter((key) => !OMIT_AST_FIELDS.has(key)).sort()
      .map((key) => [key, normalizeAst(value[key])]));
  }
  return typeof value === 'bigint' ? String(value) : value;
}

function fingerprint(node, occurrence = 0) {
  return crypto.createHash('sha256').update(JSON.stringify({ ast: normalizeAst(node), occurrence })).digest('hex');
}

function children(node) {
  const result = [];
  for (const [key, value] of Object.entries(node)) {
    if (OMIT_AST_FIELDS.has(key)) continue;
    if (Array.isArray(value)) {
      for (const item of value) if (item && typeof item.type === 'string') result.push(item);
    } else if (value && typeof value.type === 'string') result.push(value);
  }
  return result;
}

function parse(source, filename) {
  const modes = filename.endsWith('.mjs') ? ['module'] : filename.endsWith('.cjs') ? ['script'] : ['script', 'module'];
  let error;
  for (const sourceType of modes) {
    try { return acorn.parse(source, { ecmaVersion: 'latest', sourceType, locations: true, allowHashBang: true }); }
    catch (cause) { error = cause; }
  }
  throw error;
}

function normalizeExternal(specifier) {
  const name = specifier.replace(/^node:/, '');
  if (BUILTINS.has(name) || specifier.startsWith('node:')) return `node:${name}`;
  return specifier;
}

function externalPackage(specifier) {
  if (specifier.startsWith('node:')) return specifier;
  return specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
}

// 逐段核对真实目录项，不能依赖宿主文件系统是否大小写敏感。
function exactPath(root, absolute) {
  if (!inside(root, absolute)) return { error: 'outside-root' };
  let current = root;
  for (const segment of path.relative(root, absolute).split(path.sep).filter(Boolean)) {
    let names;
    try { names = fs.readdirSync(current); } catch { return { error: 'missing' }; }
    if (!names.includes(segment)) {
      return { error: names.some((name) => name.toLowerCase() === segment.toLowerCase()) ? 'case-mismatch' : 'missing' };
    }
    current = path.join(current, segment);
    try {
      if (!inside(root, fs.realpathSync(current))) return { error: 'symlink-outside-root' };
    } catch { return { error: 'unreadable-path' }; }
  }
  return { absolute: current };
}

function resolveSpecifier(root, from, specifier) {
  if (typeof specifier !== 'string' || !specifier) return { error: 'invalid-specifier' };
  if (!specifier.startsWith('.') && !path.isAbsolute(specifier) && !/^[A-Za-z]:[\\/]/.test(specifier)) {
    const to = normalizeExternal(specifier);
    return { to, external: true, package: externalPackage(to) };
  }
  const absolute = path.resolve(root, path.dirname(from), specifier.replace(/\\/g, '/'));
  if (!inside(root, absolute)) return { error: 'outside-root' };
  let failure = 'missing';
  for (const candidate of [absolute, ...['.js', '.cjs', '.mjs', '.json'].map((ext) => absolute + ext),
    ...['.js', '.cjs', '.mjs', '.json'].map((ext) => path.join(absolute, `index${ext}`))]) {
    const checked = exactPath(root, candidate);
    if (checked.error) {
      if (checked.error !== 'missing') failure = checked.error;
      continue;
    }
    try {
      if (fs.statSync(candidate).isFile()) return { to: posix(path.relative(root, candidate)), external: false };
    } catch { failure = 'unreadable-path'; }
  }
  return { error: failure };
}

function enumerate(root, errors) {
  const files = [];
  const visit = (directory, ancestors) => {
    let real;
    try { real = fs.realpathSync(directory); } catch { return; }
    if (!inside(root, real)) {
      errors.push({ from: posix(path.relative(root, directory)), reason: 'symlink-outside-root' });
      return;
    }
    if (ancestors.has(real)) {
      errors.push({ from: posix(path.relative(root, directory)), reason: 'symlink-cycle' });
      return;
    }
    const next = new Set([...ancestors, real]);
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      if (['node_modules', 'changes', 'tests', 'fixtures', 'dist', 'build'].includes(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      let stat;
      try {
        if (!inside(root, fs.realpathSync(absolute))) {
          errors.push({ from: posix(path.relative(root, absolute)), reason: 'symlink-outside-root' });
          continue;
        }
        stat = fs.statSync(absolute);
      } catch { errors.push({ from: posix(path.relative(root, absolute)), reason: 'unreadable-path' }); continue; }
      if (stat.isDirectory()) visit(absolute, next);
      else if (stat.isFile() && JS.test(entry.name)) files.push(posix(path.relative(root, absolute)));
    }
  };
  visit(path.join(root, 'src'), new Set());
  return files.sort();
}

function propertyName(node) {
  if (!node) return null;
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'Literal' && ['string', 'number'].includes(typeof node.value)) return String(node.value);
  return null;
}

function createAnalysis(ast, from, root) {
  const parents = new WeakMap();
  const scopeFor = new WeakMap();
  const bindingsFor = new WeakMap();
  const nodes = [];
  const functions = new WeakMap();
  const rootScope = { type: 'program', parent: null, bindings: new Map(), functionPath: null };
  const anonymousCounts = new Map();
  const functionName = (node, parent, outer) => {
    if (node.id) return node.id.name;
    if (parent?.type === 'VariableDeclarator') return propertyName(parent.id);
    if (parent?.type === 'Property' || parent?.type === 'MethodDefinition') return propertyName(parent.key);
    if (parent?.type === 'AssignmentExpression') {
      let left = parent.left;
      if (left.type === 'Identifier') return left.name;
      if (left.type === 'MemberExpression') return propertyName(left.property);
    }
    const key = outer.functionPath || '';
    const count = (anonymousCounts.get(key) || 0) + 1;
    anonymousCounts.set(key, count);
    return `<anonymous:${count}>`;
  };
  const declare = (pattern, scope, info, selector = []) => {
    if (!pattern) return;
    if (pattern.type === 'Identifier') {
      const binding = { name: pattern.name, scope, selector, ...info };
      scope.bindings.set(pattern.name, binding);
      bindingsFor.set(pattern, binding);
    } else if (pattern.type === 'ObjectPattern') {
      for (const prop of pattern.properties) {
        if (prop.type === 'Property') declare(prop.value, scope, info, [...selector, propertyName(prop.key)]);
        else declare(prop.argument, scope, { ...info, opaque: true }, selector);
      }
    } else if (pattern.type === 'ArrayPattern') {
      pattern.elements.forEach((item, index) => declare(item, scope, info, [...selector, String(index)]));
    } else if (pattern.type === 'AssignmentPattern') declare(pattern.left, scope, { ...info, defaultInit: pattern.right }, selector);
    else if (pattern.type === 'RestElement') declare(pattern.argument, scope, { ...info, opaque: true }, selector);
  };
  const walk = (node, scope, parent) => {
    if (!node) return;
    if (parent) parents.set(node, parent);
    if (node.type === 'FunctionDeclaration' && node.id) declare(node.id, scope, { kind: 'function', init: node });
    let current = scope;
    if (FUNCTION_TYPES.has(node.type)) {
      const name = functionName(node, parent, scope) || '<anonymous>';
      const functionPath = [scope.functionPath, name].filter(Boolean).join('.');
      current = { type: 'function', parent: scope, bindings: new Map(), functionPath };
      functions.set(node, functionPath);
      if (node.id) declare(node.id, current, { kind: 'function', init: node });
      node.params.forEach((param, parameterIndex) => declare(param, current, { kind: 'parameter', init: null, functionNode: node, parameterIndex }));
    } else if (node.type === 'StaticBlock' || node.type === 'BlockStatement' || node.type === 'CatchClause' || node.type === 'ForStatement' || node.type === 'ForOfStatement' || node.type === 'ForInStatement' || node.type === 'SwitchStatement') {
      current = { type: node.type === 'StaticBlock' ? 'static-block' : node.type === 'CatchClause' ? 'catch' : 'block', parent: scope, bindings: new Map(), functionPath: scope.functionPath };
      if (node.type === 'CatchClause') declare(node.param, current, { kind: 'parameter', init: null });
    }
    scopeFor.set(node, current);
    nodes.push(node);
    if (node.type === 'VariableDeclaration') {
      let target = current;
      if (node.kind === 'var') while (target.parent && !['function', 'program', 'static-block'].includes(target.type)) target = target.parent;
      for (const declaration of node.declarations) declare(declaration.id, target, { kind: node.kind, init: declaration.init });
    }
    if (node.type === 'ClassDeclaration' && node.id) declare(node.id, current, { kind: 'class', init: node });
    if (node.type === 'ImportDeclaration') {
      for (const specifier of node.specifiers) declare(specifier.local, current, {
        kind: 'import', imported: propertyName(specifier.imported) || (specifier.type === 'ImportNamespaceSpecifier' ? '*' : 'default'), specifier: node.source.value
      });
    }
    for (const child of children(node)) walk(child, current, node);
  };
  walk(ast, rootScope, null);
  const lookup = (name, scope) => {
    for (let current = scope; current; current = current.parent) if (current.bindings.has(name)) return current.bindings.get(name);
    return null;
  };
  for (const node of nodes) {
    const changed = node.type === 'AssignmentExpression' ? node.left : node.type === 'UpdateExpression' ? node.argument : null;
    if (changed?.type === 'Identifier') {
      const binding = lookup(changed.name, scopeFor.get(node));
      if (binding) {
        binding.mutated = true;
        if (node.type === 'AssignmentExpression') (binding.assignments ||= []).push(node.right);
      }
    }
  }
  const moduleDescription = (specifier, chain = []) => {
    const resolved = resolveSpecifier(root, from, specifier);
    return { kind: 'reference', chain, module: resolved.to || specifier, specifier, importedNames: chain.length ? [chain[0]] : null,
      rootFree: false, external: !!resolved.external };
  };
  const unknown = (reason) => ({ kind: 'unknown', reason });
  const descriptionCache = new WeakMap();
  const describe = (node, seen = new Set()) => {
    if (!node) return { kind: 'unknown', reason: 'missing' };
    if (descriptionCache.has(node)) return descriptionCache.get(node);
    const value = describeValue(node, seen);
    descriptionCache.set(node, value);
    return value;
  };
  const selectBindingValue = (initial, selector) => {
    let value = initial;
    for (const segment of selector) {
      if (value.kind === 'object') value = value.properties[segment] || unknown('missing-property');
      else if (value.kind === 'reference') value = { ...value, chain: [...value.chain, segment], importedNames: value.module ? [value.chain[0] || segment] : value.importedNames };
      else value = { kind: 'unknown', reason: 'member-base', object: value, property: segment };
    }
    return value;
  };
  // 配置与调用方共用完整绑定解析，包含 destructuring selector、import 和工厂初始化。
  const describeBinding = (binding, seen = new Set()) => {
    if (!binding) return unknown('missing-binding');
    const reference = { kind: 'reference', chain: [binding.name], rootFree: false, bindingScope: binding.scope.type,
      bindingFunctionPath: binding.scope.functionPath, bindingFunctionStart: binding.functionNode?.start, bindingKind: binding.kind };
    if (binding.kind === 'import') return moduleDescription(binding.specifier, binding.imported === '*' ? [] : [binding.imported]);
    if (binding.kind === 'parameter' && !binding.mutated && binding.functionNode) {
      const invocation = parents.get(binding.functionNode);
      if (invocation?.type === 'CallExpression' && invocation.callee === binding.functionNode) {
        const input = describe(invocation.arguments[binding.parameterIndex], new Set([...seen, binding]));
        if (input.kind === 'function' && !binding.selector.length) return input;
        const choices = input.values || [input];
        const globals = choices.filter(value => value.kind === 'reference' && value.rootFree && value.chain?.length === 1 && ['window', 'globalThis'].includes(value.chain[0]));
        if (globals.length && choices.every(value => globals.includes(value) || (value.kind === 'literal' && value.value === null))) return { ...globals[0], chain: ['window'] };
      }
    }

    if (seen.has(binding) || binding.opaque) return { ...reference, opaque: true };
    if (binding.mutated || binding.kind === 'let' || binding.kind === 'var' || binding.defaultInit) {
      const next = new Set([...seen, binding]);
      const initial = binding.init ? [selectBindingValue(describe(binding.init, next), binding.selector)] : [];
      return { ...reference, opaque: true, alternatives: [...initial,
        ...[binding.defaultInit, ...(binding.assignments || [])].filter(Boolean).map(value => describe(value, next))] };
    }
    if (binding.kind === 'const' && binding.init) {
      const next = new Set([...seen, binding]);
      const value = selectBindingValue(describe(binding.init, next), binding.selector);
      if (value.kind === 'object') return { ...value, ...reference, kind: 'object', properties: value.properties, spreads: value.spreads };
      // 本地工厂结果的成员虽未在此展开，仍须为后续来源追踪保留对象和属性。
      if (value.kind !== 'unknown' || value.reason === 'member-base') return value;
      return { ...reference, opaque: true, reason: value.reason };
    }
    if (binding.kind === 'class' && binding.init) return { ...reference, kind: 'class', classStart: binding.init.start };
    if (binding.kind === 'function') return { ...reference, functionPath: functions.get(binding.init), functionStart: binding.init.start };
    return reference;
  };
  const describeValue = (node, seen = new Set()) => {
    if (!node) return unknown('missing');
    if (node.type === 'ChainExpression' || node.type === 'AwaitExpression') return describe(node.expression || node.argument, seen);
    if (node.type === 'Literal' && node.regex) return { kind: 'regexp' };
    if (node.type === 'Literal') return { kind: 'literal', value: typeof node.value === 'bigint' ? String(node.value) : node.value };
    if (node.type === 'TemplateLiteral') {
      const expressions = node.expressions.map((expression) => describe(expression, seen));
      if (expressions.every((value) => value.kind === 'literal')) {
        return { kind: 'literal', value: node.quasis.map((quasi, index) => quasi.value.cooked + (index < expressions.length ? expressions[index].value : '')).join('') };
      }
      return unknown('dynamic-template');
    }
    if (node.type === 'Identifier') {
      const binding = lookup(node.name, scopeFor.get(node));
      if (!binding) {
        if (node.name === '__dirname') return { kind: 'literal', value: path.dirname(path.join(root, from)), pathValue: true };
        return { kind: 'reference', chain: [node.name], rootFree: true, bindingScope: null };
      }
      return describeBinding(binding, seen);
    }
    if (node.type === 'MemberExpression') {
      const object = describe(node.object, seen);
      const prop = node.computed ? describe(node.property, seen) : { kind: 'literal', value: propertyName(node.property) };
      if (prop.kind !== 'literal' || !['string', 'number'].includes(typeof prop.value)) return { kind: 'unknown', reason: 'computed-member', object, propertyValue: prop };
      const key = String(prop.value);
      const alternatives = object.alternatives || (object.kind === 'candidates' ? object.values : null);
      if (alternatives) return { kind: 'candidates', values: alternatives.map((value) => value.kind === 'reference' ? { ...value, chain: [...value.chain, key], importedNames: value.module ? [value.chain[0] || key] : value.importedNames } : { kind: 'unknown', reason: 'member-base', object: value, property: key }) };
      if (object.kind === 'object' && object.properties[key]) return object.properties[key];
      if (object.kind === 'reference' || object.kind === 'object') {
        return { ...object, kind: 'reference', properties: undefined, chain: [...(object.chain || []), key],
          importedNames: object.module ? [object.chain?.[0] || key] : object.importedNames };
      }
      return { kind: 'unknown', reason: 'member-base', object, property: key };
    }
    if (node.type === 'ObjectExpression') {
      const properties = {};
      const spreads = [];
      for (const property of node.properties) {
        if (property.type === 'SpreadElement') {
        const spread = describe(property.argument, seen);
        if (spread.kind === 'object' && !spread.opaque && !(spread.spreads || []).length) Object.assign(properties, spread.properties);
        else spreads.push(spread);
        continue;
      }
        const key = property.computed ? describe(property.key, seen) : { kind: 'literal', value: propertyName(property.key) };
        if (key.kind !== 'literal' || property.kind !== 'init') { spreads.push(unknown('computed-or-accessor')); continue; }
        properties[key.value] = describe(property.value, seen);
      }
      return { kind: 'object', properties, spreads, objectStart: node.start };
    }
    if (node.type === 'ArrayExpression') return { kind: 'array', elements: node.elements.flatMap(item => {
      if (item?.type !== 'SpreadElement') return [describe(item, seen)];
      const source = describe(item.argument, seen);
      return source.kind === 'array' ? source.elements : [unknown('opaque-array-spread')];
    }) };
    if (FUNCTION_TYPES.has(node.type)) return { kind: 'function', functionPath: functions.get(node), functionStart: node.start };
    if (node.type === 'ClassDeclaration' || node.type === 'ClassExpression') return { kind: 'class', classStart: node.start };
    if (node.type === 'MetaProperty' && node.meta.name === 'import' && node.property.name === 'meta') {
      return { kind: 'reference', chain: ['import', 'meta'], rootFree: true };
    }
    if (node.type === 'CallExpression' || node.type === 'NewExpression') {
      const callee = describe(node.callee, seen);
      const args = node.arguments.map((argument) => describe(argument, seen));
      if (callee.kind === 'reference' && callee.rootFree && REQUIRE_CHAINS.has(callee.chain.join('.')) && args[0]?.kind === 'literal' && typeof args[0].value === 'string') {
        return moduleDescription(args[0].value);
      }
      if (callee.kind === 'reference' && callee.rootFree && ['Object.freeze', 'Object.seal'].includes(callee.chain.join('.')) && args.length === 1) return args[0];
      if (callee.kind === 'reference' && callee.module === 'node:path' && ['join', 'resolve'].includes(callee.chain.at(-1)) && args.length && args.every((arg) => arg.kind === 'literal' && typeof arg.value === 'string')) {
        return { kind: 'literal', value: callee.chain.at(-1) === 'resolve' ? path.resolve(root, ...args.map((arg) => arg.value)) : path.join(...args.map((arg) => arg.value)), pathValue: true };
      }
      if (node.type === 'NewExpression' && callee.rootFree && callee.chain?.join('.') === 'URL' && args[0]?.kind === 'literal' && args[1]?.chain?.join('.') === 'import.meta.url') {
        return { kind: 'literal', value: path.resolve(root, path.dirname(from), args[0].value), pathValue: true };
      }
      if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression' &&
        (!node.callee.computed || node.callee.property.type === 'Literal') && propertyName(node.callee.property) === 'bind') {
        const target = describe(node.callee.object, seen);
        return { kind: 'bound-function', target, receiver: args[0], args: args.slice(1),
          method: target.chain?.at(-1) || target.property || null };
      }
      return { kind: 'call-result', callee, args };
    }
    if (node.type === 'LogicalExpression') return { kind: 'candidates', operator: node.operator, values: [describe(node.left, seen), describe(node.right, seen)] };
    if (node.type === 'ConditionalExpression') {
      const test = node.test;
      // 支持目标运行时中 globalThis 恒存在；局部同名绑定不继承该结论。
      if (test.type === 'BinaryExpression' && ['!==', '!=', '===', '=='].includes(test.operator) &&
          test.left.type === 'UnaryExpression' && test.left.operator === 'typeof' && test.right.type === 'Literal' && test.right.value === 'undefined') {
        const global = describe(test.left.argument, seen);
        if (global.rootFree && global.chain?.join('.') === 'globalThis') return describe(['!==', '!='].includes(test.operator) ? node.consequent : node.alternate, seen);
      }
      return { kind: 'candidates', values: [describe(node.consequent, seen), describe(node.alternate, seen)] };
    }
    if (node.type === 'BinaryExpression' && node.operator === '+') {
      const left = describe(node.left, seen); const right = describe(node.right, seen);
      if (left.kind === 'literal' && right.kind === 'literal') return { kind: 'literal', value: left.value + right.value };
    }
    return unknown(node.type);
  };
  const occurrences = new Map();
  const siteFor = new WeakMap();
  const site = (node) => {
    if (siteFor.has(node)) return siteFor.get(node);
    const functionPath = scopeFor.get(node)?.functionPath || null;
    const shape = fingerprint(node);
    const key = `${functionPath || ''}\0${shape}`;
    const occurrence = occurrences.get(key) || 0;
    occurrences.set(key, occurrence + 1);
    const result = { from, line: node.loc.start.line, column: node.loc.start.column, source: { line: node.loc.start.line, column: node.loc.start.column },
      functionPath, evidenceId: fingerprint(node, occurrence), occurrence };
    siteFor.set(node, result);
    return result;
  };
  // 扫描按源码节点顺序首次登记；辅助 API 复用相同节点结果。
  const functionNodes = new Map(nodes.filter((node) => FUNCTION_TYPES.has(node.type)).map((node) => [functions.get(node), node]));
  const functionNodesByStart = new Map(nodes.filter((node) => FUNCTION_TYPES.has(node.type)).map(node => [node.start, node]));
  return { from, ast, parents, scopeFor, bindingsFor, functionNodes, functionNodesByStart, nodes, describe, describeBinding, resolve: describe, site,
    functionPath: (node) => scopeFor.get(node)?.functionPath || null,
    lookup: (name, node) => lookup(name, scopeFor.get(node)), walk: (visitor) => nodes.forEach(visitor) };
}

// 有限 HTML tokenizer：跳过注释、惰性 template 内容和 script 原文，保留执行模式。
function parseScripts(html) {
  const scripts = [];
  let index = 0; let templateDepth = 0;
  while (index < html.length) {
    if (html.startsWith('<!--', index)) {
      const end = html.indexOf('-->', index + 4);
      if (end < 0) throw new Error('HTML 注释未关闭');
      index = end + 3; continue;
    }
    if (html[index] !== '<') { index++; continue; }
    const start = index;
    let end = index + 1; let quote = null;
    for (; end < html.length; end++) {
      const char = html[end];
      if (quote) { if (char === quote) quote = null; }
      else if (char === '"' || char === "'") quote = char;
      else if (char === '>') break;
    }
    if (end >= html.length) throw new Error('HTML 标签或属性未关闭');
    const tag = html.slice(start + 1, end);
    index = end + 1;
    if (/^\s*\/template\s*$/i.test(tag)) { templateDepth = Math.max(0, templateDepth - 1); continue; }
    const name = /^\s*([a-zA-Z][\w:-]*)\b/.exec(tag);
    if (name && ['textarea', 'title', 'style', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript'].includes(name[1].toLowerCase())) {
      const closeText = new RegExp('</' + name[1] + '\\s*>', 'gi'); closeText.lastIndex = index;
      const closingText = closeText.exec(html);
      if (!closingText) throw new Error('HTML 文本元素未关闭：' + name[1]);
      index = closingText.index + closingText[0].length; continue;
    }
    if (name?.[1].toLowerCase() === 'plaintext') break;
    if (name?.[1].toLowerCase() === 'template') { templateDepth++; continue; }
    if (!name || name[1].toLowerCase() !== 'script') continue;
    const attrs = {}; let offset = name[0].length;
    while (offset < tag.length) {
      const rest = tag.slice(offset);
      if (/^\s*\/?\s*$/.test(rest)) break;
      const attr = /^\s+([^\s=<>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/.exec(rest);
      if (!attr) throw new Error('script 属性无法解析');
      const key = attr[1].toLowerCase();
      if (Object.hasOwn(attrs, key)) throw new Error(`script 属性重复: ${key}`);
      attrs[key] = attr[2] ?? attr[3] ?? attr[4] ?? '';
      offset += attr[0].length;
    }
    const close = /<\/script\s*>/gi; close.lastIndex = index;
    const closing = close.exec(html);
    if (!closing) throw new Error('script 标签未关闭');
    const line = html.slice(0, start).split('\n').length;
    const column = start - (html.lastIndexOf('\n', start) + 1);
    const executable = templateDepth === 0 && (!attrs.type || ['module', 'text/javascript', 'application/javascript'].includes(attrs.type.toLowerCase()));
    if (executable && attrs.src !== undefined) scripts.push({ src: attrs.src, line, column, type: attrs.type?.toLowerCase() || 'classic', async: Object.hasOwn(attrs, 'async'), defer: Object.hasOwn(attrs, 'defer') });
    else if (executable && html.slice(index, closing.index).trim()) scripts.push({ inline: true, line, column });
    index = closing.index + closing[0].length;
  }
  return scripts;
}

function getGlobalRegistrations(config) {
  const result = [];
  for (const boundary of config.boundaries || []) {
    const entries = boundary.entrypoints || [];
    const globals = boundary.globals || [];
    if (Array.isArray(globals)) {
      for (const item of globals) {
        if (typeof item === 'string') result.push({ name: item, from: entries[0], boundaryId: boundary.id });
        else if (item) {
          for (const name of [].concat(item.exportsGlobal || item.exportsGlobals || item.name || [])) result.push({ name, from: item.path || entries[0], boundaryId: boundary.id });
        }
      }
    } else if (globals && typeof globals === 'object') {
      for (const name of [].concat(globals.exportsGlobal || globals.exportsGlobals || [])) result.push({ name, from: globals.path || entries[0], boundaryId: boundary.id });
    }
    for (const name of [].concat(boundary.exportsGlobal || [])) result.push({ name, from: entries[0], boundaryId: boundary.id });
  }
  return result;
}

function scan(root, config = {}) {
  root = fs.realpathSync(path.resolve(root));
  const result = { files: [], edges: [], sites: [], parseErrors: [], unresolved: [], dynamicSites: [], scripts: [], globals: [], analyses: new Map(), coverage: {} };
  result.files = enumerate(root, result.unresolved);
  const providers = getGlobalRegistrations(config);
  const globalNames = new Set(providers.map((item) => item.name));
  const addEdge = (from, specifier, kind, node, analysis, extra = {}) => {
    const location = analysis.site(node);
    const resolved = resolveSpecifier(root, kind === 'worker' ? 'index.html' : from, specifier);
    if (resolved.error) {
      result.unresolved.push({ ...location, kind, specifier, reason: resolved.error });
      return;
    }
    result.edges.push({ ...location, ...resolved, kind, specifier, importedNames: null, literal: false, ...extra });
  };
  for (const from of result.files) {
    let ast;
    try { ast = parse(fs.readFileSync(path.join(root, from), 'utf8'), from); }
    catch (error) { result.parseErrors.push({ from, line: error.loc?.line || 0, column: error.loc?.column || 0, message: error.message }); continue; }
    const analysis = createAnalysis(ast, from, root);
    result.analyses.set(from, analysis);
    const { describe, parents } = analysis;
    const isGlobal = (value) => value?.kind === 'reference' && value.rootFree && ['window', 'globalThis'].includes(value.chain[0]);
    const modalRoot = (node, seen = new Set()) => {
      if (!node || seen.has(node)) return false;
      seen.add(node);
      if (node.type === 'ChainExpression') return modalRoot(node.expression, seen);
      const value = describe(node);
      if (value.kind === 'reference' && value.chain.at(-1) === 'modalRoot' && (value.chain.includes('elements') || value.chain[0] === 'document' || ['window', 'globalThis'].includes(value.chain[0]))) return true;
      if (node.type === 'Identifier') {
        const binding = analysis.lookup(node.name, node);
        if (binding?.defaultInit && modalRoot(binding.defaultInit, seen)) return true;
        if (binding?.kind === 'const' && binding.init) return modalRoot(binding.init, seen);
      }
      if (node.type === 'MemberExpression') {
        if (value.kind === 'call-result') return value.callee?.chain?.[0] === 'document' && ['getElementById', 'querySelector'].includes(value.callee.chain.at(-1)) && ['modalRoot', '#modalRoot'].includes(value.args[0]?.value);
      }
      if (value.kind === 'call-result') return value.callee?.chain?.[0] === 'document' && ['getElementById', 'querySelector'].includes(value.callee.chain.at(-1)) && ['modalRoot', '#modalRoot'].includes(value.args[0]?.value);
      return false;
    };
    const mountedBindings = new Set();
    for (const node of analysis.nodes) {
      if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression' && modalRoot(node.callee.object) && ['append', 'appendChild', 'prepend', 'replaceChildren'].includes(propertyName(node.callee.property))) {
        for (const arg of node.arguments) if (arg.type === 'Identifier') {
          const binding = analysis.lookup(arg.name, arg);
          if (binding) mountedBindings.add(binding);
        }
      }
    }
    const isMounted = (node, seen = new Set()) => {
      if (!node || node.type !== 'Identifier' || seen.has(node)) return false;
      seen.add(node);
      const binding = analysis.lookup(node.name, node);
      if (mountedBindings.has(binding)) return true;
      if (binding?.kind === 'const') return isMounted(binding.init, seen);
      return false;
    };
    for (const node of analysis.nodes) {
      if (!['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration', 'ImportExpression', 'CallExpression', 'NewExpression', 'AssignmentExpression', 'MemberExpression', 'Identifier'].includes(node.type)) continue;
      const relevantIdentifier = node.type === 'Identifier' && (globalNames.has(node.name) || ['require', 'desktopApi'].includes(node.name));
      if (node.type === 'Identifier' && !relevantIdentifier) continue;
      const location = analysis.site(node);
      const parent = parents.get(node);
      if (['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(node.type) && node.source) {
        const importedNames = node.type === 'ImportDeclaration' ? node.specifiers.map((item) => propertyName(item.imported) || (item.type === 'ImportNamespaceSpecifier' ? '*' : 'default')).sort() : node.specifiers?.map((item) => propertyName(item.local)).filter(Boolean).sort() || ['*'];
        addEdge(from, node.source.value, node.type === 'ImportDeclaration' ? 'import' : 'export', node, analysis, { importedNames, literal: true });
      }
      if (node.type === 'ImportExpression') {
        const argument = describe(node.source);
        if (argument.kind === 'literal' && typeof argument.value === 'string') addEdge(from, argument.value, 'dynamic-import', node, analysis, { literal: node.source.type === 'Literal' });
        else result.dynamicSites.push({ ...location, kind: 'dynamic-import', callee: 'import', candidates: argument.kind === 'candidates' ? argument.values : [], reason: 'unresolved-dynamic-loader' });
      }
      if (node.type === 'CallExpression' || node.type === 'NewExpression') {
        const callee = describe(node.callee);
        const args = node.arguments.map((argument) => describe(argument));
        const chain = callee.chain || [];
        const operation = args[0]?.kind === 'literal' ? args[0].value : args.find((arg) => arg.kind === 'object' && arg.properties.operation)?.properties.operation?.value;
        const call = { ...location, type: node.type === 'NewExpression' ? 'new' : 'call', dynamicCallee: node.callee.type === 'MemberExpression' && node.callee.computed && describe(node.callee.property).kind !== 'literal', callee: chain.join('.'), chain, method: node.callee.type === 'MemberExpression' ? propertyName(node.callee.property) : null, args, operation, reference: callee,
          binding: callee.module ? { from: callee.module, importedNames: callee.importedNames } : null };
        const syntaxMethod = node.callee.type === 'MemberExpression' && (!node.callee.computed || node.callee.property.type === 'Literal') ? propertyName(node.callee.property) : null;
        const indirect = ['call', 'apply'].includes(syntaxMethod);
        const target = indirect ? describe(node.callee.object) : callee;
        const effectiveArgs = !indirect ? args : syntaxMethod === 'call' ? args.slice(1) :
          args[1]?.kind === 'array' ? args[1].elements : [{ kind: 'unknown', reason: 'opaque-apply-arguments' }];
        if (indirect || callee.kind === 'bound-function' || (callee.values || callee.alternatives || []).some(value => value.kind === 'bound-function')) {
          call.invocations = callTargets(target, effectiveArgs, indirect ? null : call.method).map(invocation => ({ ...invocation,
            chain: invocation.reference.chain || [], callee: (invocation.reference.chain || []).join('.'),
            binding: invocation.reference.module ? { from: invocation.reference.module, importedNames: invocation.reference.importedNames } : null }));
        }
        result.sites.push(call);
        if (callee.kind === 'reference' && callee.rootFree && REQUIRE_CHAINS.has(chain.join('.'))) {
          let importedNames = null;
          if (parent?.type === 'VariableDeclarator' && parent.id.type === 'ObjectPattern') importedNames = parent.id.properties.filter((item) => item.type === 'Property').map((item) => propertyName(item.key)).sort();
          else if (parent?.type === 'MemberExpression' && parent.object === node && (!parent.computed || parent.property.type === 'Literal')) importedNames = [propertyName(parent.property)];
          else if (parent?.type === 'VariableDeclarator' && parent.id.type === 'Identifier' && analysis.parents.get(parent)?.kind === 'const') {
            const binding = analysis.lookup(parent.id.name, parent); const members = new Set(); let opaque = false;
            for (const use of analysis.nodes) {
              if (use.type !== 'Identifier' || use.name !== parent.id.name || use === parent.id || analysis.lookup(use.name, use) !== binding) continue;
              const owner = analysis.parents.get(use);
              if (owner?.type === 'MemberExpression' && owner.object === use) {
                const property = owner.computed ? describe(owner.property) : { kind: 'literal', value: propertyName(owner.property) };
                const operation = analysis.parents.get(owner);
                if ((operation?.type === 'AssignmentExpression' && operation.left === owner) || operation?.type === 'UpdateExpression' ||
                    (operation?.type === 'UnaryExpression' && operation.operator === 'delete')) opaque = true;
                if (property.kind !== 'literal' || typeof property.value !== 'string') opaque = true;
                else members.add(property.value);
              } else if ((owner?.type === 'Property' && owner.key === use && !owner.shorthand && !owner.computed) ||
                (owner?.type === 'MemberExpression' && owner.property === use && !owner.computed)) continue;
              else opaque = true;
            }
            if (!opaque && members.size) importedNames = [...members].sort();
          }

          if (args[0]?.kind === 'literal' && typeof args[0].value === 'string') addEdge(from, args[0].value, 'require', node, analysis, { importedNames, literal: node.callee.type === 'Identifier' && node.callee.name === 'require' && node.arguments[0]?.type === 'Literal' });
          else result.dynamicSites.push({ ...location, kind: 'require', callee: 'require', candidates: args[0]?.kind === 'candidates' ? args[0].values : [], reason: 'unresolved-dynamic-loader' });
        }
        const references = (value, visited = new Set()) => {
          if (!value || visited.has(value)) return [];
          const next = new Set([...visited, value]);
          const choices = [value, ...((value.alternatives || value.values || []).flatMap((item) => references(item, next)))];
          if (value.reason === 'member-base' && value.object) {
            choices.push(...references(value.object, next).filter((item) => item.kind === 'reference').map((item) => ({ ...item, chain: [...item.chain, value.property] })));
          }
          if (value.kind === 'call-result' && value.callee?.functionPath) {
            const func = analysis.functionNodes.get(value.callee.functionPath);
            if (func) {
              const returns = func.type === 'ArrowFunctionExpression' && func.body.type !== 'BlockStatement' ? [func.body] : analysis.nodes.filter((item) => item.type === 'ReturnStatement' && analysis.functionPath(item) === value.callee.functionPath).map((item) => item.argument);
              choices.push(...returns.flatMap((item) => references(describe(item), next)));
            }
          }
          return choices;
        };
        for (const invocation of call.invocations || [call]) {
          const callee = invocation.reference; const chain = invocation.chain || []; const args = invocation.args;
          const workerCandidates = node.type === 'NewExpression' || chain.at(-1) === 'fork' || (node.callee.type === 'MemberExpression' && propertyName(node.callee.property) === 'fork') ? references(callee) : [callee];
          const workerReference = workerCandidates.find((value) => (value.module === 'node:worker_threads' && value.chain?.at(-1) === 'Worker') ||
            (value.module === 'node:child_process' && value.chain?.at(-1) === 'fork') ||
            (value.module === 'electron' && value.chain?.join('.') === 'utilityProcess.fork'));
          const isWorker = !!workerReference;
          if (isWorker) {
            const alternatives = value => value?.kind === 'candidates' ? value.values.flatMap(alternatives) : [value];
            const targets = alternatives(args[0]);
            let directories = [root]; let reason = 'unresolved-worker-path';
            if (workerReference.chain.at(-1) === 'fork' && targets.some(target => typeof target?.value !== 'string' || !path.isAbsolute(target.value))) {
              // argv 的内容可以动态；但必须区分数组位置与覆盖第三参数的 options 对象重载。
              const optionCandidates = alternatives(args[1]).flatMap(argv => {
                if (argv?.kind === 'object') return [argv];
                const absent = !argv || (argv.kind === 'literal' && argv.value === null) || (argv.rootFree && argv.chain?.join('.') === 'undefined');
                const nativeArray = argv?.kind === 'call-result' && argv.callee?.rootFree &&
                  ['process.argv.slice', 'process.execArgv.slice', 'Array.from', 'Array.of'].includes(argv.callee.chain?.join('.'));
                if (absent || argv.kind === 'array' || nativeArray) return alternatives(args[2]);
                return [{ kind: 'unknown', reason: 'ambiguous-fork-overload' }];
              });
              directories = optionCandidates.flatMap(option => {
                if (!option || (option.kind === 'literal' && option.value === null) || (option.rootFree && option.chain?.join('.') === 'undefined')) return [root];
                if (option.kind !== 'object' || option.opaque || option.spreads.length) return [null];
                const cwd = option.properties.cwd;
                if (!cwd || (cwd.kind === 'literal' && cwd.value === null) || (cwd.rootFree && cwd.chain?.join('.') === 'undefined')) return [root];
                return alternatives(cwd).map(value => value?.kind === 'literal' && typeof value.value === 'string' ? path.resolve(root, value.value) : null);
              });
              if (directories.some(directory => directory === null)) reason = 'unresolved-fork-cwd';
            }
            if (directories.every(Boolean) && targets.length && targets.every((target) => target?.kind === 'literal' && typeof target.value === 'string')) {
              for (const target of targets) for (const directory of new Set(directories)) addEdge(from, path.resolve(directory, target.value), 'worker', node, analysis, { operation });
            } else result.dynamicSites.push({ ...location, kind: 'worker', callee: [workerReference.module, ...workerReference.chain].join('.'), candidates: targets.filter(Boolean), reason });
          }
        }
        const loaderAlias = (callee.module === 'node:module' && chain.at(-1) === 'createRequire') || (callee.rootFree && (chain.join('.') === 'require.resolve' || (['bind', 'call', 'apply'].includes(chain.at(-1)) && REQUIRE_CHAINS.has(chain.slice(0, -1).join('.')))));
        if (loaderAlias) result.dynamicSites.push({ ...location, kind: 'loader-alias', callee: chain.join('.'), reason: 'loader-alias-requires-contract', candidates: [] });
        if ((callee.rootFree && ['eval', 'Function'].includes(chain[0])) || (callee.rootFree && ['window', 'globalThis'].includes(chain[0]) && ['eval', 'Function'].includes(chain[1]))) result.sites.push({ ...call, type: 'reflection' });
        for (const invocation of call.invocations || [call]) {
          const callChain = invocation.chain || [];
          if (['prepare', 'exec', 'query', 'run'].includes(invocation.method || callChain.at(-1)) && (callChain.includes('db') || invocation.reference.module === 'node:sqlite')) {
            result.sites.push({ ...call, ...invocation, invocations: undefined, type: 'db-operation', sql: invocation.args[0] });
          }
        }
        if (node.callee.type === 'MemberExpression') {
          const method = propertyName(node.callee.property);
          if ((modalRoot(node.callee.object) && ['append', 'appendChild', 'prepend', 'remove', 'removeChild', 'replaceChild', 'replaceChildren', 'insertBefore', 'insertAdjacentHTML', 'insertAdjacentElement'].includes(method)) || (method === 'remove' && isMounted(node.callee.object))) result.sites.push({ ...call, type: 'modal-write', operation: method });
        }
      }
      if (node.type === 'AssignmentExpression') {
        const target = describe(node.left);
        const assignment = { ...location, type: 'assignment', callee: (target.chain || []).join('.'), chain: target.chain || [], target, value: describe(node.right), operation: node.operator };
        result.sites.push(assignment);
        if (node.left.type === 'MemberExpression' && modalRoot(node.left.object) && ['innerHTML', 'textContent', 'outerHTML'].includes(propertyName(node.left.property))) result.sites.push({ ...assignment, type: 'modal-write', operation: propertyName(node.left.property) });
      }
      if (node.type === 'MemberExpression') {
        const value = describe(node);
        const object = describe(node.object);
        if (isGlobal(value) && value.chain.length >= 2) {
          const write = parent?.type === 'AssignmentExpression' && parent.left === node;
          const item = { ...location, type: write ? 'global-write' : 'global-read', name: value.chain[1], chain: value.chain, callee: value.chain.join('.'), reference: value };
          result.sites.push(item); result.globals.push(item);
        } else if (isGlobal(object) && node.computed && describe(node.property).kind !== 'literal') {
          result.sites.push({ ...location, type: 'reflection', callee: `${object.chain.join('.')}[computed]`, chain: object.chain });
        }
      }
      if (node.type === 'Identifier' && node.name === 'require' && !analysis.lookup(node.name, node)) {
        const directCall = parent?.type === 'CallExpression' && parent.callee === node;
        const memberObject = parent?.type === 'MemberExpression' && parent.object === node;
        const constAlias = parent?.type === 'VariableDeclarator' && parent.init === node && parents.get(parent)?.kind === 'const';
        const propertyKey = parent?.type === 'MemberExpression' && parent.property === node && !parent.computed || parent?.type === 'Property' && parent.key === node && !parent.computed && !parent.shorthand;
        const transfer = (parent?.type === 'CallExpression' && parent.arguments.includes(node)) || parent?.type === 'ReturnStatement' || (parent?.type === 'AssignmentExpression' && parent.right === node) || (parent?.type === 'VariableDeclarator' && parent.init === node) || (parent?.type === 'Property' && parent.value === node);
        if (transfer && !directCall && !memberObject && !constAlias && !propertyKey) result.dynamicSites.push({ ...location, kind: 'loader-alias', callee: 'require', reason: 'opaque-loader-transfer', candidates: [] });
      }
      if (node.type === 'Identifier' && (globalNames.has(node.name) || node.name === 'desktopApi') && !analysis.lookup(node.name, node)) {
        const nonRead = (parent?.type === 'MemberExpression' && parent.property === node && !parent.computed) ||
          (parent?.type === 'Property' && parent.key === node && !parent.computed && !parent.shorthand) || parent?.type?.startsWith('Import');
        if (!nonRead) {
          const item = { ...location, type: 'global-read', name: node.name, chain: [node.name], callee: node.name, reference: describe(node) };
          result.sites.push(item); result.globals.push(item);
        }
      }
    }
  }
  try {
    if (fs.existsSync(path.join(root, 'index.html'))) {
      const checked = exactPath(root, path.join(root, 'index.html'));
      if (checked.error) throw new Error(checked.error);
      for (const script of parseScripts(fs.readFileSync(path.join(root, 'index.html'), 'utf8'))) {
        if (script.inline) { result.unresolved.push({ from: 'index.html', ...script, reason: 'inline-script-not-covered' }); continue; }
        if (/^(?:[a-z]+:|\/\/|\/)/i.test(script.src) || /[?#&]/.test(script.src)) {
          result.unresolved.push({ from: 'index.html', ...script, reason: 'non-local-script' }); continue;
        }
        const resolved = resolveSpecifier(root, 'index.html', script.src.startsWith('.') ? script.src : `./${script.src}`);
        result.scripts.push({ ...script, path: resolved.to || null, from: 'index.html', order: result.scripts.length });
        if (resolved.error || !JS.test(resolved.to || '') || !result.files.includes(resolved.to)) result.unresolved.push({ from: 'index.html', ...script, reason: resolved.error || 'script-outside-production-scan' });
      }
    }
  } catch (error) { result.parseErrors.push({ from: 'index.html', line: 0, column: 0, message: error.message }); }
  for (const read of result.globals.filter((item) => item.type === 'global-read')) {
    for (const provider of providers.filter((item) => item.name === read.name && item.from !== read.from)) {
      result.edges.push({ ...read, to: provider.from, kind: 'classic-global', specifier: read.name, importedNames: [read.name], external: false, literal: false });
    }
  }
  for (const dynamic of result.dynamicSites) {
    const contract = (config.dynamicLoads || []).find((item) => item.from === dynamic.from && item.functionPath === dynamic.functionPath && item.evidenceId === dynamic.evidenceId);
    if (!contract) continue;
    for (const target of contract.allowedTargets || []) {
      const specifier = target.startsWith('src/') ? path.join(root, target) : target;
      const resolved = resolveSpecifier(root, dynamic.from, specifier);
      if (resolved.error) result.unresolved.push({ ...dynamic, specifier: target, reason: resolved.error });
      else result.edges.push({ ...dynamic, ...resolved, kind: dynamic.kind === 'worker' ? 'worker' : dynamic.kind === 'loader-alias' ? 'require' : dynamic.kind, specifier: target, importedNames: null, literal: false, dynamic: true });
    }
  }
  const unique = (items) => [...new Map(items.map((item) => [[item.from, item.evidenceId, item.line, item.column, item.type, item.kind, item.to, item.reason].join('\0'), item])).values()];
  for (const key of ['edges', 'sites', 'parseErrors', 'unresolved', 'dynamicSites', 'globals']) result[key] = sorted(unique(result[key]));
  const literalEdges = new Set(result.edges.filter((edge) => edge.literal && !edge.external && JS.test(edge.to)).map((edge) => `${edge.from}\0${edge.to}`));
  result.coverage = { scannedFiles: result.files.length, parsedFiles: result.analyses.size, literalEdges: literalEdges.size,
    workerEdges: result.edges.filter((edge) => edge.kind === 'worker').length, globalEdges: result.edges.filter((edge) => edge.kind === 'classic-global').length,
    unresolved: result.unresolved.length, dynamicSites: result.dynamicSites.length, parseErrors: result.parseErrors.length };
  return result;
}

module.exports = { scan, parse, parseScripts, createAnalysis, resolveSpecifier, normalizeAst, fingerprint, normalizeExternal };
