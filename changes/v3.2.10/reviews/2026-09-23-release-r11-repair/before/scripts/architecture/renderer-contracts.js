'use strict';

// 只解释静态对象、命名工厂返回与显式参数转发；不执行 Renderer/Preload。
const cache = new WeakMap();
function createRendererContracts(scan) {
  if (cache.has(scan)) return cache.get(scan);
  const analyses = scan.analyses;
  const globals = new Map();
  const objectNodes = new Map([...analyses].map(([file, analysis]) =>
    [file, new Map(analysis.nodes.filter(node => node.type === 'ObjectExpression').map(node => [node.start, node]))]));
  // 数组描述的 elements 在别名投影中保持引用；私有映射避免改变共享扫描结果。
  const arrayNodes = new Map([...analyses].map(([file, analysis]) =>
    [file, new Map(analysis.nodes.filter(node => node.type === 'ArrayExpression').map(node => [analysis.describe(node).elements, node]))]));
  const unknown = reason => ({ kind: 'unknown', reason });
  const missing = { kind: 'missing-renderer-value' };
  const pathOf = value => value?.chain || [];
  const directName = node => node?.type === 'MemberExpression' && !node.computed ? node.property.name : null;
  const functionReturns = new WeakMap();
  const parameterCalls = new WeakMap();
  const memberWrites = new WeakMap();
  const returnedValues = (callee, analysis) => {
    if (!functionReturns.has(analysis)) functionReturns.set(analysis, new Map());
    const cache = functionReturns.get(analysis); const key = callee.functionStart ?? callee.functionPath;
    if (cache.has(key)) return cache.get(key);
    const fn = analysis.functionNodesByStart.get(callee.functionStart) || analysis.functionNodes.get(callee.functionPath);
    const returns = !fn ? [] : fn.body.type !== 'BlockStatement' ? [fn.body] : analysis.nodes.filter(node =>
      node.type === 'ReturnStatement' && node.start >= fn.start && node.end <= fn.end &&
      analysis.functionPath(node) === callee.functionPath).map(node => node.argument);
    const values = returns.map(node => analysis.describe(node)); cache.set(key, values); return values;
  };
  // 身份附在求值结果上，与 bound/member/return 共用解析；符号不参与能力字段或结构比较。
  const identity = Symbol('renderer-object-identity');
  const origin = Symbol('renderer-object-origin');
  const truthiness = Symbol('renderer-known-truthiness');
  const nonNullish = Symbol('renderer-known-non-nullish');
  const uncertainElements = Symbol('renderer-uncertain-array-elements');
  const deferred = Symbol('renderer-deferred-identity');
  const defer = read => {
    let value;
    return { kind: 'deferred-identity', [deferred]: () => (value ||= read()) };
  };
  const frames = Symbol('renderer-call-frames');
  const parameterBindings = Symbol('renderer-parameter-bindings');
  const emptyEnv = new Map();
  const callNodes = new Map([...analyses].map(([file, analysis]) => [file,
    new Map(analysis.nodes.filter(node => ['CallExpression', 'NewExpression'].includes(node.type)).map(node => [node.start, node]))]));
  const frameAt = (analysis, node, env) => {
    for (let current = node; current; current = analysis.parents.get(current)) {
      if (analysis.functionNodesByStart.get(current.start) === current) return env.get(frames)?.get(`${analysis.from}:${current.start}`) || '';
    }
    return '';
  };
  const objectIdentity = (value, analysis, env) => {
    const node = value.kind === 'array' ? arrayNodes.get(analysis.from)?.get(value.elements) : objectNodes.get(analysis.from)?.get(value.objectStart);
    return node ? [JSON.stringify([analysis.from, node.start, frameAt(analysis, node, env)])] : [];
  };
  const identityCache = new WeakMap();
  const identitiesOf = value => value?.[identity] || (value?.kind === 'identity-candidates' ? value.values.flatMap(identitiesOf) : []);
  const sameObject = (actual, identities, analysis, env) => {
    if (!actual || !identities.length) return false;
    if (!identityCache.has(env)) identityCache.set(env, new WeakMap());
    const byAnalysis = identityCache.get(env);
    if (!byAnalysis.has(analysis)) byAnalysis.set(analysis, new WeakMap());
    const values = byAnalysis.get(analysis);
    if (!values.has(actual)) {
      // 成员快照会反向核对写入接收者；同一身份正在求值时不能再次从深度零递归。
      values.set(actual, unknown('recursive-renderer-identity'));
      values.set(actual, resolve(actual, analysis, env, 0, new Set(), false));
    }
    return identitiesOf(values.get(actual)).some(key => identities.includes(key));
  };
  const assignments = new WeakMap();
  const arrayMutators = new Set(['copyWithin', 'fill', 'pop', 'push', 'reverse', 'shift', 'sort', 'splice', 'unshift']);
  const unsupportedArrayMutation = (object, analysis, env, read = null) => {
    const identities = identitiesOf(object);
    const writeEnv = object[origin]?.analysis === analysis ? object[origin].env : env;
    const mutations = [];
    if (!identities.length) return mutations;
    for (const node of analysis.nodes) {
      let member;
      if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression') {
        const name = node.callee.computed ? analysis.describe(node.callee.property).value : node.callee.property.name;
        if (arrayMutators.has(name)) member = node.callee;
      }
      if (node.type === 'AssignmentExpression' && node.left.type === 'MemberExpression') {
        const key = node.left.computed ? analysis.describe(node.left.property) : { kind: 'literal', value: node.left.property.name };
        if (key.kind !== 'literal' || key.value === 'length' || node.operator !== '=') member = node.left;
      }
      if ((node.type === 'UpdateExpression' || (node.type === 'UnaryExpression' && node.operator === 'delete')) && node.argument.type === 'MemberExpression') member = node.argument;
      if (member && (!read || writtenBefore(node, read, analysis, writeEnv, env) !== false) && sameObject(analysis.describe(member.object), identities, analysis, writeEnv)) mutations.push(node);
    }
    return mutations;
  };
  const executionPositions = (node, analysis, env) => {
    const positions = []; const seen = new Set();
    for (let current = node; current && !seen.has(current);) {
      positions.push(current); seen.add(current);
      const frame = frameAt(analysis, current, env);
      if (!frame) break;
      const [file, start] = JSON.parse(frame);
      if (file !== analysis.from) break;
      current = callNodes.get(file)?.get(start);
    }
    return positions;
  };
  const writtenBefore = (write, read, analysis, writeEnv, readEnv) => {
    for (const atWrite of executionPositions(write, analysis, writeEnv)) for (const atRead of executionPositions(read, analysis, readEnv)) {
      if (analysis.functionPath(atWrite) !== analysis.functionPath(atRead)) continue;
      // 工厂调用作为成员表达式的接收者时，先完成工厂内部写入，再读取返回值成员。
      if (atWrite !== write && atWrite.start >= atRead.start && atWrite.end <= atRead.end) return true;
      return atWrite.end <= atRead.start;
    }
    return null;
  };
  const mutationSources = (items, analysis, env, depth, visited) => {
    if (depth > 35) return [unknown('recursive-renderer-mutation-source')];
    return items.flatMap(node => {
      if (node.type !== 'SpreadElement') return [resolve(analysis.describe(node), analysis, env, depth + 1, visited, false)];
      const expanded = resolve(analysis.describe(node.argument), analysis, env, depth + 1, visited, false);
      const elements = value => {
        if (value.kind === 'identity-candidates') return value.values.flatMap(elements);
        if (value.kind !== 'array') return [value];
        const writeEnv = value[origin]?.analysis === analysis ? value[origin].env : env;
        const keys = new Set(value.elements.map((_, index) => String(index)));
        // 初始空数组也可能已被 mutator 填入对象，不能因为没有初始槽位就跳过来源快照。
        if (value[uncertainElements] || unsupportedArrayMutation(value, analysis, env, node).length) keys.add('0');
        // 此处只收集可能插入的来源，不推断 mutator 执行后的槽位；扩容写入也不能丢失。
        for (const write of analysis.nodes) {
          if (write.type !== 'AssignmentExpression' || write.left.type !== 'MemberExpression' || writtenBefore(write, node, analysis, writeEnv, env) === false) continue;
          const key = write.left.computed ? analysis.describe(write.left.property) : { kind: 'literal', value: write.left.property.name };
          if (key.kind === 'literal' && /^(0|[1-9][0-9]*)$/.test(String(key.value)) && sameObject(analysis.describe(write.left.object), identitiesOf(value), analysis, writeEnv)) keys.add(String(key.value));
        }
        return [...keys].map(property => snapshotMember(value, { property, node }, analysis, env, depth + 1, visited));
      };
      // 不透明的 spread 保留覆盖缺口；字面量中仍可见的插入对象继续参与身份检查。
      return expanded.kind === 'unknown' && node.argument.type === 'ArrayExpression'
        ? [expanded, ...mutationSources(node.argument.elements.filter(Boolean), analysis, env, depth + 1, visited)] : elements(expanded);
    });
  };
  const snapshotMember = (object, access, analysis, env, depth, visited) => {
    if (object.kind === 'identity-candidates') return { kind: 'identity-candidates', values: object.values.map(item =>
      snapshotMember(item, access, analysis, env, depth, visited)) };
    const mutations = object.kind === 'array' ? unsupportedArrayMutation(object, analysis, env, access.node) : [];
    const identities = identitiesOf(object);
    let selected = select(object, [access.property]);
    if (!identities.length) return selected;
    const writeEnv = object[origin]?.analysis === analysis ? object[origin].env : env;
    if (!assignments.has(analysis)) assignments.set(analysis, analysis.nodes.filter(node =>
      node.type === 'AssignmentExpression' && node.left.type === 'MemberExpression'));
    const writes = [];
    for (const node of assignments.get(analysis)) {
      const before = writtenBefore(node, access.node, analysis, writeEnv, env);
      if (before === false) continue;
      const key = node.left.computed ? analysis.describe(node.left.property) : { kind: 'literal', value: node.left.property.name };
      if (key.kind === 'literal' && String(key.value) !== access.property) continue;
      if (!sameObject(analysis.describe(node.left.object), identities, analysis, writeEnv)) continue;
      if (key.kind !== 'literal' || node.operator !== '=') {
        if (object.kind === 'array') continue; // 下方保留不确定数组改写的来源候选。
        return unknown('unordered-renderer-member-write');
      }
      let conditional = before === null || identities.length > 1;
      // 只给有确定顺序的静态替换建立新身份；分支/循环不能用源码最后一项冒充实际结果。
      for (let parent = analysis.parents.get(node); parent && !analysis.functionNodesByStart.has(parent.start); parent = analysis.parents.get(parent)) {
        if (['IfStatement', 'ConditionalExpression', 'SwitchStatement', 'ForStatement', 'ForOfStatement', 'ForInStatement', 'WhileStatement', 'DoWhileStatement'].includes(parent.type)) conditional = true;
      }
      writes.push({ node, conditional, order: executionPositions(node, analysis, writeEnv).reverse().map(item => item.start) });
    }
    // 函数声明的文本位置不是执行顺序；工厂内写入必须排在调用返回后的外层替换之前。
    writes.sort((a, b) => {
      for (let index = 0; index < Math.min(a.order.length, b.order.length); index += 1) if (a.order[index] !== b.order[index]) return a.order[index] - b.order[index];
      return a.order.length - b.order.length;
    });
    let uncertain = false;
    for (const { node, conditional } of writes) {
      uncertain ||= conditional;
      const assigned = resolve(analysis.describe(node.right), analysis, writeEnv, depth + 1, visited, false);
      selected = uncertain ? { kind: 'identity-candidates', values: [selected, assigned] } : assigned;
    }
    if (!mutations.length) return selected;
    // 不支持的数组操作不能抹去已知来源；既保留覆盖缺口，也保留可能被移动/插入的对象。
    return { kind: 'identity-candidates', values: [selected, missing, unknown('unsupported-renderer-array-mutation'),
      ...object.elements.map((_, index) => select(object, [String(index)])),
      ...mutations.flatMap(node => mutationSources(node.type === 'CallExpression' ? node.arguments : node.type === 'AssignmentExpression' ? [node.right] : [],
        analysis, writeEnv, depth + 1, visited))] };
  };
  const mergeIdentities = values => {
    const initial = values[0];
    if (initial[deferred]) return defer(() => mergeIdentities(values.map(value => value[deferred]())));
    // 结构相同不代表分支事实相同：来源取并集，排除默认值的证明只能取交集。
    const first = { ...initial,
      [truthiness]: values.every(value => value[truthiness] === initial[truthiness]) ? initial[truthiness] : undefined,
      [nonNullish]: values.every(value => value[nonNullish] === true || value[truthiness] === true) };
    if (values.some(value => value[uncertainElements])) first[uncertainElements] = values.flatMap(value => value[uncertainElements] || []);
    if (first.kind === 'object') return { ...first,
      [identity]: [...new Set(values.flatMap(value => value[identity] || []))],
      properties: Object.fromEntries(Object.keys(first.properties).map(key =>
        [key, mergeIdentities(values.map(value => value.properties[key]))])) };
    if (first.kind === 'array') return { ...first, [identity]: [...new Set(values.flatMap(value => value[identity] || []))],
      elements: first.elements.map((_, index) => mergeIdentities(values.map(value => value.elements[index]))) };
    return first;
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
    for (let index = 0; index < chain.length; index += 1) {
      const part = chain[index];
      if (value?.kind === 'identity-candidates') return { ...value, values: value.values.map(item => select(item, chain.slice(index))) };
      if (value?.kind === 'ipc-data') { value = { ...value, fields: [...(value.fields || []), part] }; continue; }
      if (value?.kind === 'array' && !value.opaque && /^(0|[1-9][0-9]*)$/.test(part)) {
        if (value[uncertainElements]) return select({ kind: 'identity-candidates', values: [unknown('uncertain-renderer-array-index'),
          ...value.elements.map(item => item[deferred] ? item[deferred]() : item), ...value[uncertainElements]] }, chain.slice(index + 1));
        value = value.elements[Number(part)] || missing;
        if (value[deferred]) value = value[deferred]();
        if (value.kind === 'unknown' && value.reason === 'missing') value = missing;
        continue;
      }
      if (value?.kind !== 'object') return unknown('unresolved-static-member');
      if (!Object.hasOwn(value.properties, part)) return Object.hasOwn(Object.prototype, part) ? unknown('inherited-renderer-member') : missing;
      value = value.properties[part];
      if (value?.[deferred]) value = value[deferred]();
    }
    return value;
  };
  function bindPattern(pattern, value, env, read) {
    if (!pattern) return;
    if (pattern.type === 'AssignmentPattern') {
      const fallback = () => read ? resolve(read.source.describe(pattern.right), read.source, env, read.depth + 1, read.visited, false)
        : unknown('unresolved-renderer-default');
      const choose = item => {
        if (item?.kind === 'identity-candidates') return { ...item, values: item.values.map(choose) };
        if (item === missing || (item?.kind === 'literal' && item.value === undefined) ||
          (item?.kind === 'reference' && item.rootFree && pathOf(item).join('.') === 'undefined')) return fallback();
        // OR/nullish 选中的左值已排除 undefined，不能在默认参数处重新引入被排除的分支。
        if (item?.[nonNullish] || item?.[truthiness] === true) return item;
        if (['object', 'array', 'literal', 'function', 'native-function', 'regexp', 'panel-node'].includes(item?.kind)) return item;
        // IPC 来源标签不证明字段存在；未知实参都必须保留可能触发的默认来源。
        return { kind: 'identity-candidates', values: [item || unknown('unresolved-renderer-argument'), fallback()] };
      };
      return bindPattern(pattern.left, choose(value), env, read);
    }
    if (pattern.type === 'Identifier') {
      env.set(pattern.name, value);
      if (read) {
        // 闭包保留声明函数的参数身份，不能被调用栈中其他函数的同名参数覆盖。
        const bindings = new Map(env.get(parameterBindings) || []);
        bindings.set(`${read.source.from}:${read.functionStart}:${pattern.name}`, value);
        env.set(parameterBindings, bindings);
      }
      return;
    }
    // 解构与普通成员访问共用调用时点快照；参数绑定保留身份，使用处再检查能力。
    const member = key => read && ['object', 'array', 'identity-candidates'].includes(value?.kind)
      ? snapshotMember(value, { property: key, node: read.node }, read.analysis, read.env, read.depth, read.visited)
      : select(value, [key]);
    if (pattern.type === 'ObjectPattern') for (const property of pattern.properties) {
      if (property.type === 'Property' && (!property.computed || property.key.type === 'Literal')) {
        bindPattern(property.value, member(String(property.key.name ?? property.key.value)), env, read);
      }
    }
    if (pattern.type === 'ArrayPattern') pattern.elements.forEach((item, index) => bindPattern(item, member(String(index)), env, read));
  }
  function parameterValue(value, analysis, env, depth, visited) {
    const chain = pathOf(value);
    const fn = analysis.functionNodesByStart.get(value.bindingFunctionStart) || analysis.functionNodes.get(value.bindingFunctionPath);
    if (!fn) return null;
    const bindings = env.get(parameterBindings); const key = `${analysis.from}:${fn.start}:${chain[0]}`;
    if (bindings?.has(key)) return { value: selectOrSelf(bindings.get(key), chain.slice(1)) };
    if (!parameterCalls.has(analysis)) parameterCalls.set(analysis, new Map());
    const callCache = parameterCalls.get(analysis);
    if (!callCache.has(value.bindingFunctionPath)) callCache.set(value.bindingFunctionPath, scan.sites.filter(site => site.type === 'call' &&
      ((site.from === analysis.from && site.reference?.functionPath === value.bindingFunctionPath) ||
        (site.reference?.rootFree && site.reference?.chain?.at(-1) === value.bindingFunctionPath.split('.').at(-1)))));
    const calls = callCache.get(value.bindingFunctionPath);
    if (calls.length !== 1) return null;
    const context = new Map(env); const caller = analyses.get(calls[0].from);
    const call = [...callNodes.get(caller.from).values()].find(node => node.loc.start.line === calls[0].line && node.loc.start.column === calls[0].column);
    if (!call) return null;
    context.set(frames, new Map([...(env.get(frames) || []), [`${analysis.from}:${fn.start}`, JSON.stringify([caller.from, call.start, frameAt(caller, call, env)])]]));
    const read = { analysis: caller, source: analysis, functionStart: fn.start, env, node: call, depth, visited };
    fn.params.forEach((param, index) => bindPattern(param, calls[0].args[index]
      ? resolve(calls[0].args[index], caller, env, depth + 1, visited, false) : missing, context, read));
    return context.has(chain[0]) ? { value: selectOrSelf(context.get(chain[0]), chain.slice(1)) } : null;
  }
  function resolve(value, analysis, env = emptyEnv, depth = 0, visited = new Set(), inspectMutations = true) {
    if (!value || depth > 35 || visited.has(value)) return unknown('recursive-renderer-value');
    const next = new Set([...visited, value]);
    const recurse = (item, source = analysis, context = env) => resolve(item, source, context, depth + 1, next, inspectMutations);
    const hydrate = item => inspectMutations && item?.kind === 'identity-candidates'
      ? { ...item, values: item.values.map(hydrate) } : inspectMutations && item?.[origin]
      ? resolve(item[origin].value, item[origin].analysis, item[origin].env, depth + 1, next, true) : item;
    if (value.bindingKind === 'parameter' && value.opaque) {
      const fn = analysis.functionNodesByStart.get(value.bindingFunctionStart) || analysis.functionNodes.get(value.bindingFunctionPath);
      const binding = fn && analysis.lookup(pathOf(value)[0], fn.body);
      // 参数绑定已按缺失/undefined 选择默认来源；实际重赋值仍沿原候选分析。
      const bound = binding?.defaultInit && !binding.mutated && parameterValue(value, analysis, env, depth, next);
      if (bound) return hydrate(bound.value);
    }
    const access = analysis.memberRead(value);
    if (access) {
      const object = resolve(access.object, analysis, env, depth + 1, next, false);
      if (['object', 'array', 'identity-candidates'].includes(object.kind)) {
        const selected = snapshotMember(object, access, analysis, env, depth, next);
        if (!inspectMutations) return selected;
        if (selected.kind === 'identity-candidates') {
          const choices = selected.values.map(hydrate);
          return choices.every(item => JSON.stringify(item) === JSON.stringify(choices[0])) ? mergeIdentities(choices) : unknown('ambiguous-renderer-member');
        }
        return hydrate(selected);
      }
    }
    if (value.kind === 'literal' || value.kind === 'regexp') return value;
    if (value.functionPath) return { ...value, kind: 'function', sourceFile: analysis.from, sourceEnv: env };
    if (value.kind === 'bound-function') {
      const target = recurse(value.target);
      return target.kind === 'function' || target.kind === 'native-function'
        ? { ...target, boundArgs: [...(target.boundArgs || []), ...value.args.map(item => resolve(item, analysis, env, depth + 1, next, false))] }
        : unknown('unresolved-bound-function');
    }
    if (value.kind === 'array') {
      const literal = arrayNodes.get(analysis.from)?.get(value.elements);
      if (value.opaque && !literal) return unknown(value.reason);
      const array = { ...value, opaque: false, elements: [], [identity]: value[identity] || objectIdentity(value, analysis, env), [origin]: { value, analysis, env } };
      const memberValue = item => inspectMutations ? recurse(item) : defer(() => recurse(item));
      if (literal) for (const node of literal.elements) {
        if (node?.type !== 'SpreadElement') { array.elements.push(memberValue(analysis.describe(node))); continue; }
        const expanded = resolve(analysis.describe(node.argument), analysis, env, depth + 1, next, false);
        const uncertain = reason => {
          if (inspectMutations) return unknown(reason);
          // 不能定位索引时仍保留展开时可见的对象来源，避免别名写入绕过最终 API 检查。
          (array[uncertainElements] ||= []).push(...mutationSources([node], analysis, env, depth + 1, next));
          return null;
        };
        if (expanded.kind !== 'array' || expanded[uncertainElements] || unsupportedArrayMutation(expanded, analysis, env, node).length) {
          const result = uncertain('opaque-renderer-array-spread');
          if (result) return result;
          continue;
        }
        // spread 在复制时读取槽位；复制后源数组的替换不能改写已捕获的元素。
        const count = expanded.elements.length;
        const writeEnv = expanded[origin]?.analysis === analysis ? expanded[origin].env : env;
        let resized = false;
        for (const write of analysis.nodes) {
          if (write.type !== 'AssignmentExpression' || write.left.type !== 'MemberExpression' || writtenBefore(write, node, analysis, writeEnv, env) === false) continue;
          const key = write.left.computed ? analysis.describe(write.left.property) : { kind: 'literal', value: write.left.property.name };
          if (key.kind === 'literal' && /^(0|[1-9][0-9]*)$/.test(String(key.value)) && Number(key.value) >= count && sameObject(analysis.describe(write.left.object), identitiesOf(expanded), analysis, writeEnv)) resized = true;
        }
        if (resized) {
          const result = uncertain('resized-renderer-array-spread');
          if (result) return result;
          continue;
        }
        for (let index = 0; index < count; index++) {
          const selected = snapshotMember(expanded, { property: String(index), node }, analysis, env, depth, next);
          array.elements.push(inspectMutations ? hydrate(selected) : selected);
        }
      } else array.elements = value.elements.map(memberValue);
      if (inspectMutations) {
        if (unsupportedArrayMutation(array, analysis, env).length) return unknown('unsupported-renderer-array-mutation');
        for (const node of analysis.nodes) {
          if (node.type !== 'AssignmentExpression' || node.left.type !== 'MemberExpression' || !sameObject(analysis.describe(node.left.object), identitiesOf(array), analysis, env)) continue;
          const key = node.left.computed ? analysis.describe(node.left.property) : { kind: 'literal', value: node.left.property.name };
          if (key.kind !== 'literal' || !/^(0|[1-9][0-9]*)$/.test(String(key.value)) || Number(key.value) > 10000) return unknown('unsupported-renderer-array-property');
          const index = Number(key.value);
          const assigned = recurse(analysis.describe(node.right));
          // 整体数据注入没有单独槽位读取时点，检查全部可能写入，不能让后列分支掩盖能力。
          array.elements[index] = index in array.elements ? { kind: 'identity-candidates', values: [array.elements[index], assigned] } : assigned;
        }
      }
      return array;
    }
    if (value.kind === 'object') {
      const identities = value[identity] || objectIdentity(value, analysis, env);
      // 身份比较只沿选中的成员求值，避免为每个别名展开无关能力树。
      const memberValue = item => inspectMutations ? recurse(item) : defer(() => recurse(item));
      const properties = Object.create(null);
      // 重新解释原始顺序，避免通用扫描器展开 spread 时丢失来源身份或覆盖顺序。
      const literal = objectNodes.get(analysis.from)?.get(value.objectStart);
      if (literal) {
        for (const property of literal.properties) {
          if (property.type === 'SpreadElement') {
            const expanded = recurse(analysis.describe(property.argument));
            if (expanded.kind !== 'object') return unknown('opaque-renderer-spread');
            if (inspectMutations) Object.assign(properties, expanded.properties);
            else for (const key of Object.keys(expanded.properties)) properties[key] = defer(() =>
              snapshotMember(expanded, { property: key, node: property }, analysis, env, depth, next));
          } else {
            const key = property.computed ? recurse(analysis.describe(property.key))
              : { kind: 'literal', value: property.key.name ?? property.key.value };
            if (key.kind !== 'literal' || property.kind !== 'init') return unknown('computed-or-accessor');
            if (!property.computed && !property.method && !property.shorthand && key.value === '__proto__') {
              const prototype = recurse(analysis.describe(property.value));
              if (prototype.kind !== 'literal' || prototype.value !== null) return unknown('object-prototype-setter');
              continue;
            }
            properties[key.value] = memberValue(analysis.describe(property.value));
          }
        }
      } else {
        for (const spread of value.spreads || []) {
          const expanded = recurse(spread);
          if (expanded.kind !== 'object') return unknown('opaque-renderer-spread');
          Object.assign(properties, expanded.properties);
        }
        for (const [key, member] of Object.entries(value.properties)) properties[key] = memberValue(member);
      }
      // 向未知 helper 传出能力对象可能改变其成员；不执行或猜测这些写入。
      if (inspectMutations && identities.length) for (const node of analysis.nodes) {
        if (node.type !== 'CallExpression') continue;
        const escaped = node.arguments.some(argument => {
          // 字面量在此创建并交给调用方；之后经成员/别名传出的同一对象仍须检查。
          if (argument.type === 'ObjectExpression' && argument.start === value.objectStart) return false;
          const actual = analysis.describe(argument);
          return sameObject(actual, identities, analysis, env);
        });
        const callee = analysis.describe(node.callee);
        if (escaped && !(callee.rootFree && ['Object.freeze', 'Object.seal', 'Object.keys', 'Object.values', 'Object.entries'].includes(pathOf(callee).join('.')))) return unknown('escaped-renderer-object');
      }
      // 对象声明后的静态写入属于同一能力集合，不能只看初始字面量。
      if (inspectMutations && identities.length) for (const node of analysis.nodes) {
        if (node.type !== 'AssignmentExpression' || node.left.type !== 'MemberExpression') continue;
        const base = analysis.describe(node.left.object);
        if (!sameObject(base, identities, analysis, env)) continue;
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
      return { kind: 'object', properties, [identity]: identities, [origin]: { value, analysis, env } };
    }
    if (value.kind === 'candidates' || value.alternatives) {
      const choices = value.values || value.alternatives;
      if (['&&', '||', '??'].includes(value.operator)) {
        const choose = left => {
          if (left.kind === 'identity-candidates') return left.values.flatMap(choose);
          const absent = left === missing || (left.kind === 'reference' && left.rootFree && pathOf(left).join('.') === 'undefined');
          const truthy = left[truthiness] ?? (absent ? false : left.kind === 'literal' ? Boolean(left.value)
            : ['object', 'array', 'function', 'native-function', 'regexp', 'panel-node'].includes(left.kind) ? true : null);
          const nullish = absent ? true : left.kind === 'literal' ? left.value == null : left[nonNullish] || truthy === true ? false : null;
          const takeRight = value.operator === '&&' ? truthy : value.operator === '||' ? (truthy === null ? null : !truthy) : nullish;
          if (takeRight === true) return [recurse(choices.at(-1))];
          if (takeRight === false) return [left];
          // 未知值保留两个分支，但给返回的左值保留该分支的真值/非空约束。
          const selected = value.operator === '&&' ? { ...left, [truthiness]: false }
            : { ...left, [nonNullish]: true, ...(value.operator === '||' ? { [truthiness]: true } : {}) };
          return [selected, recurse(choices.at(-1))];
        };
        const resolved = choose(recurse(choices[0]));
        if (resolved.length === 1) return resolved[0];
        if (resolved.every(item => JSON.stringify(item) === JSON.stringify(resolved[0]))) return mergeIdentities(resolved);
        return { kind: 'identity-candidates', values: resolved };
      }
      const resolved = choices.map(item => recurse(item)).filter(item => !(item.kind === 'literal' && item.value == null));
      if (resolved.length === 1) return resolved[0];
      if (!inspectMutations && resolved.some(item => ['object', 'array', 'identity-candidates'].includes(item.kind))) return { kind: 'identity-candidates', values: resolved };
      if (resolved.length && resolved.every(item => JSON.stringify(item) === JSON.stringify(resolved[0]))) return mergeIdentities(resolved);
      return unknown('ambiguous-renderer-value');
    }
    if (value.reason === 'member-base') {
      const object = recurse(value.object);
      if (['object', 'array', 'ipc-data', 'identity-candidates'].includes(object.kind)) return select(object, [value.property]);
      return unknown('unresolved-renderer-member');
    }
    if (value.kind === 'reference') {
      const chain = pathOf(value);
      if (value.bindingKind === 'parameter') {
        const bound = parameterValue(value, analysis, env, depth, next);
        if (bound) return hydrate(bound.value);
        return { ...value, kind: 'parameter-value' };
      }
      const globalChain = ['window', 'globalThis'].includes(chain[0]) && value.rootFree ? chain.slice(1) : value.rootFree ? chain : null;
      if (globalChain) {
        if (globalChain[0] === 'desktopApi' && globalChain.length === 1) {
          // 完整 API 仍禁止注入；只有已登记的对象 provider 才能证明短路守卫为真。
          return { ...unknown('whole-desktop-api'), [truthiness]: globals.get('desktopApi')?.value.kind === 'object' ? true : null };
        }
        if (globalChain[0] === 'state' || globalChain[0] === 'elements') return unknown('whole-application-state');
        const provider = globals.get(globalChain[0]);
        if (provider) return selectOrSelf(recurse(provider.value, provider.analysis, emptyEnv), globalChain.slice(1));
        if (['alert', 'confirm'].includes(globalChain[0]) && globalChain.length === 1) return { kind: 'native-function' };
      }
      // 单一静态成员赋值仍可还原；多次赋值必须保留不透明诊断。
      if (chain.length > 1 && !value.opaque) {
        if (!memberWrites.has(analysis)) memberWrites.set(analysis, new Map());
        const writeCache = memberWrites.get(analysis); const name = chain.join('.');
        if (!writeCache.has(name)) writeCache.set(name, analysis.nodes.filter(node => node.type === 'AssignmentExpression' && node.operator === '=' &&
          pathOf(analysis.describe(node.left)).join('.') === name));
        const writes = writeCache.get(name);
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
      // 参数先保留调用时的对象身份；返回/成员使用处再检查完整能力，避免外层容器逃逸抹掉已捕获成员。
      const args = [...(callee.boundArgs || []), ...value.args.map(item => resolve(item, analysis, env, depth + 1, next, false))];
      const calls = new Map(context.get(frames) || []);
      const call = callNodes.get(analysis.from)?.get(value.callStart);
      if (!call) return unknown('missing-renderer-call-identity');
      calls.set(`${source.from}:${fn.start}`, JSON.stringify([analysis.from, value.callStart, frameAt(analysis, call, env)]));
      context.set(frames, calls);
      const read = { analysis, source, functionStart: fn.start, env, node: call, depth, visited: next };
      fn.params.forEach((param, index) => bindPattern(param, args[index] || missing, context, read));
      const returns = returnedValues(callee, source);
      if (returns.length !== 1) return unknown('nonliteral-renderer-factory-return');
      return recurse(returns[0], source, context);
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
    (value?.kind === 'identity-candidates' && value.values.length > 0 && value.values.every(data)) ||
    (value?.kind === 'array' && !value.opaque && value.elements.every(data)) || (value?.kind === 'object' && !value.opaque && Object.values(value.properties).every(data));
}

module.exports = { createRendererContracts, rendererDataLiteral };
