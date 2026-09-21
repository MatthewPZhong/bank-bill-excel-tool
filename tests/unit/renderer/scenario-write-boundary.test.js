'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const acorn = require('acorn');
const root = path.resolve(__dirname, '../../..');
const writes = {
  scenarios: new Set(['create', 'update', 'deleteOne', 'toggleEnabled', 'transfer', 'batchDelete', 'setApplicableChannels', 'applyImport']),
  channels: new Set(['create', 'update', 'deleteOne'])
};
function filesIn(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const filename = path.join(directory, entry.name);
    return entry.isDirectory() ? filesIn(filename) : /\.(?:js|cjs|mjs)$/.test(entry.name) ? [filename] : [];
  });
}
function walk(node, visit, parent = null) {
  if (!node || typeof node !== 'object') return;
  if (typeof node.type === 'string') visit(node, parent);
  for (const [key, value] of Object.entries(node)) {
    if (key === 'parent') continue;
    if (Array.isArray(value)) value.forEach((child) => walk(child, visit, node));
    else if (value && typeof value === 'object') walk(value, visit, node);
  }
}
const propertyName = (node) => node.computed ? node.property.value : node.property.name;
function analyze(source) {
  const ast = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'module', locations: true });
  const aliases = new Map([['desktopApi', 'raw-api'], ['scenarioCommands', 'service']]);
  const nodes = [];
  walk(ast, (node, parent) => nodes.push({ node, parent }));
  function classify(node) {
    if (!node) return null;
    if (node.type === 'ChainExpression') return classify(node.expression);
    if (node.type === 'Identifier') return aliases.get(node.name) || null;
    if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression') {
      if (propertyName(node.callee) === 'createScenarioCommandService') return 'service';
      if (['bind', 'call', 'apply'].includes(propertyName(node.callee))) return classify(node.callee.object);
    }
    if (node.type !== 'MemberExpression') return null;
    const key = propertyName(node);
    if (key === 'desktopApi') return 'raw-api';
    const base = classify(node.object);
    if (base === 'raw-api' && Object.hasOwn(writes, key)) return `raw-${key}`;
    if (base === 'service' && Object.hasOwn(writes, key)) return `service-${key}`;
    if (/^(?:raw|service)-(?:scenarios|channels)$/.test(base || '')) return `${base}.${key ?? '*'}`;
    return null;
  }
  function bind(pattern, tag) {
    if (!pattern || !tag) return;
    if (pattern.type === 'Identifier') aliases.set(pattern.name, tag);
    else if (pattern.type === 'ObjectPattern') {
      for (const property of pattern.properties) {
        const key = property.key?.name ?? property.key?.value;
        if (tag === 'raw-api' && Object.hasOwn(writes, key)) bind(property.value, `raw-${key}`);
        else if (tag === 'service' && Object.hasOwn(writes, key)) bind(property.value, `service-${key}`);
        else if (/^(?:raw|service)-(?:scenarios|channels)$/.test(tag)) bind(property.value, `${tag}.${key}`);
        else if (key === 'desktopApi') bind(property.value, 'raw-api');
      }
    }
  }
  // 固定点覆盖跨多级赋值、解构和bind别名；原始API分组只准在composition交给service。
  for (let pass = 0; pass < nodes.length && pass < 32; pass++) {
    const before = JSON.stringify([...aliases]);
    for (const { node } of nodes) {
      if (node.type === 'VariableDeclarator') bind(node.id, classify(node.init) || (node.id.type === 'ObjectPattern' ? 'unknown' : null));
      if (node.type === 'AssignmentExpression') bind(node.left, classify(node.right));
    }
    if (before === JSON.stringify([...aliases])) break;
  }
  const rawUses = [];
  const rawCalls = [];
  const serviceCalls = new Set();
  const constructions = [];
  for (const { node, parent } of nodes) {
    const tag = classify(node);
    if (node.type === 'VariableDeclarator' && node.id.type === 'ObjectPattern' && classify(node.init) === 'raw-api') {
      for (const property of node.id.properties) {
        const key = property.key?.name ?? property.key?.value;
        if (Object.hasOwn(writes, key)) rawUses.push({ line: node.loc.start.line, key: undefined, tag: `raw-${key}` });
      }
    }
    if (/^raw-(scenarios|channels)$/.test(tag || '') && node.type === 'MemberExpression') rawUses.push({ line: node.loc.start.line, key: parent?.key?.name, tag });
    if (node.type !== 'CallExpression') continue;
    if (node.callee.type === 'MemberExpression' && propertyName(node.callee) === 'createScenarioCommandService') constructions.push(node);
    const callTag = classify(node.callee)?.replace(/\.(?:call|apply)$/, '');
    const matched = /^(raw|service)-(scenarios|channels)\.([^.]*)$/.exec(callTag || '');
    if (matched && (writes[matched[2]].has(matched[3]) || matched[3] === '*')) {
      if (matched[1] === 'raw') rawCalls.push({ line: node.loc.start.line, method: `${matched[2]}.${matched[3]}` });
      else serviceCalls.add(`${matched[2]}.${matched[3]}`);
    }
  }
  return { rawUses, rawCalls, serviceCalls, constructions };
}
const analyzed = filesIn(path.join(root, 'src')).map((filename) => ({ filename: path.relative(root, filename), result: analyze(fs.readFileSync(filename, 'utf8')) }));
test('全生产 JS 的原始场景/渠道 API 只在 root 各注入同一 service 一次，无直接或别名写旁路', () => {
  const calls = analyzed.flatMap(({ filename, result }) => result.rawCalls.map((call) => ({ filename, ...call })));
  assert.deepEqual(calls, []);
  const uses = analyzed.flatMap(({ filename, result }) => result.rawUses.map((use) => ({ filename, ...use })));
  assert.deepEqual(uses.map(({ filename, key, tag }) => ({ filename, key, tag })), [
    { filename: 'src/renderer.js', key: 'scenariosApi', tag: 'raw-scenarios' },
    { filename: 'src/renderer.js', key: 'channelsApi', tag: 'raw-channels' }
  ]);
});
test('唯一 root service 传给场景工厂，全部八项场景写和三项渠道写在该入口下调用', () => {
  const constructions = analyzed.flatMap(({ filename, result }) => result.constructions.map((node) => ({ filename, node })));
  assert.equal(constructions.length, 1);
  assert.equal(constructions[0].filename, 'src/renderer.js');
  const rootSource = fs.readFileSync(path.join(root, 'src/renderer.js'), 'utf8');
  const rootAst = acorn.parse(rootSource, { ecmaVersion: 'latest' });
  let receivesSameInstance = false;
  walk(rootAst, (node) => {
    if (node.type !== 'CallExpression' || node.callee.type !== 'MemberExpression' || propertyName(node.callee) !== 'createRendererDialogs') return;
    receivesSameInstance = node.arguments[0].properties.some((property) => property.key?.name === 'scenarioCommands' && property.value.name === 'scenarioCommands');
  });
  assert.equal(receivesSameInstance, true);
  const dialogs = analyzed.find(({ filename }) => filename === 'src/renderer/dialogs/scenarios.js').result;
  assert.deepEqual([...dialogs.serviceCalls].sort(), Object.entries(writes).flatMap(([group, methods]) => [...methods].map((method) => `${group}.${method}`)).sort());
});
test('边界扫描能识别解构、多级别名、计算属性及bind，不以单文件正则代替审计', () => {
  const result = analyze(`const original=window.desktopApi; const {scenarios:s}=original; const x=s; const {update:write}=x; write(1,{}); const bound=original.channels['deleteOne'].bind(null); bound(2);`);
  assert.deepEqual(result.rawCalls.map((call) => call.method), ['scenarios.update', 'channels.deleteOne']);
  assert.equal(analyze('const {scenarios:s}=window.desktopApi; passthrough(s);').rawUses.length, 1, '解构出的整组API外传同样受原始分组边界限制');
});
