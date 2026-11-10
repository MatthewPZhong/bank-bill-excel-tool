'use strict';

// 配置弹窗用到的每个 api 命名空间，都必须在生产 renderer.js 的 configurationApi 中接上，且绑定到 preload 同名命名空间。
//   v3.2.16【余额管理】曾漏接 balanceSeeds：生命周期夹具手工注入 cfg.api.balanceSeeds，绕过了生产装配点，未能发现。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const acorn = require('acorn');

const ROOT = path.join(__dirname, '..', '..', '..');
const readSource = (...segments) => fs.readFileSync(path.join(ROOT, ...segments), 'utf8');
const keyName = (property) => property.key.name || property.key.value;

// `window.desktopApi.a.b` → ['a', 'b']；不是 window.desktopApi 链时返回 null。
function desktopApiPath(node) {
  const parts = [];
  let current = node;
  while (current && current.type === 'MemberExpression' && !current.computed) {
    parts.unshift(current.property.name);
    current = current.object;
  }
  if (!current || current.type !== 'Identifier' || current.name !== 'window' || parts[0] !== 'desktopApi') return null;
  return parts.slice(1);
}

// 返回 { 命名空间: 绑定到的 desktopApi 路径列表 }；嵌套对象（如 app: { getInfo }）逐个方法记录。
function productionConfigurationApiBindings() {
  const ast = acorn.parse(readSource('src', 'renderer.js'), { ecmaVersion: 'latest', sourceType: 'script' });
  for (const statement of ast.body) {
    if (statement.type !== 'VariableDeclaration') continue;
    const declarator = statement.declarations.find((item) => item.id.name === 'configurationApi');
    if (!declarator) continue;
    const [objectExpression] = declarator.init.arguments;
    assert.equal(objectExpression && objectExpression.type, 'ObjectExpression', 'configurationApi 应为 Object.freeze({...})');
    return new Map(objectExpression.properties.map((property) => {
      const value = property.value;
      const paths = value.type === 'ObjectExpression'
        ? value.properties.map((inner) => ({ expected: [keyName(property), keyName(inner)], actual: desktopApiPath(inner.value) }))
        : [{ expected: [keyName(property)], actual: desktopApiPath(value) }];
      return [keyName(property), paths];
    }));
  }
  throw new Error('src/renderer.js 中未找到顶层 configurationApi');
}

// preload 暴露给 desktopApi 的命名空间及其方法名。
function preloadDesktopApiMethods() {
  const ast = acorn.parse(readSource('src', 'preload.js'), { ecmaVersion: 'latest', sourceType: 'script' });
  for (const statement of ast.body) {
    const call = statement.type === 'ExpressionStatement' ? statement.expression : null;
    if (!call || call.type !== 'CallExpression' || call.arguments[0]?.value !== 'desktopApi') continue;
    return new Map(call.arguments[1].properties.map((property) => [
      keyName(property),
      new Set(property.value.type === 'ObjectExpression' ? property.value.properties.map(keyName) : [])
    ]));
  }
  throw new Error('src/preload.js 中未找到 desktopApi 暴露');
}

function configurationDialogApiCalls() {
  const source = readSource('src', 'renderer', 'dialogs', 'configuration.js');
  return Array.from(source.matchAll(/\bapi\.([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)/g), (match) => [match[1], match[2]]);
}

test('配置弹窗使用的 api 命名空间全部在生产 configurationApi 中装配，且绑定到 preload 同名命名空间', () => {
  const bindings = productionConfigurationApiBindings();
  const used = new Set(configurationDialogApiCalls().map(([namespace]) => namespace));
  assert.ok(used.has('balanceSeeds'), '应能识别到【余额管理】使用的 balanceSeeds');
  assert.deepEqual([...used].filter((namespace) => !bindings.has(namespace)).sort(), []);
  for (const [namespace, paths] of bindings) {
    for (const { expected, actual } of paths) {
      assert.deepEqual(actual, expected, `configurationApi.${namespace} 应绑定 window.desktopApi.${expected.join('.')}`);
    }
  }
});

test('配置弹窗调用的每个 api 方法都由 preload 暴露', () => {
  const preload = preloadDesktopApiMethods();
  const missing = configurationDialogApiCalls()
    .filter(([namespace, method]) => !(preload.get(namespace) && preload.get(namespace).has(method)))
    .map(([namespace, method]) => `${namespace}.${method}`);
  assert.deepEqual([...new Set(missing)].sort(), []);
});
