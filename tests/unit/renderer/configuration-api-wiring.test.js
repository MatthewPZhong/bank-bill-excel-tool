'use strict';

// 配置弹窗用到的每个 api 命名空间，都必须在生产 renderer.js 的 configurationApi 中接上。
//   v3.2.16【余额管理】曾漏接 balanceSeeds：生命周期夹具手工注入 cfg.api.balanceSeeds，绕过了生产装配点，未能发现。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const acorn = require('acorn');

const ROOT = path.join(__dirname, '..', '..', '..');

function productionConfigurationApiKeys() {
  const source = fs.readFileSync(path.join(ROOT, 'src', 'renderer.js'), 'utf8');
  const ast = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'script' });
  for (const statement of ast.body) {
    if (statement.type !== 'VariableDeclaration') continue;
    for (const declarator of statement.declarations) {
      if (declarator.id.name !== 'configurationApi') continue;
      const init = declarator.init;
      assert.equal(init && init.type, 'CallExpression', 'configurationApi 应为 Object.freeze({...})');
      const [objectExpression] = init.arguments;
      assert.equal(objectExpression && objectExpression.type, 'ObjectExpression');
      return new Set(objectExpression.properties.map((property) => property.key.name || property.key.value));
    }
  }
  throw new Error('src/renderer.js 中未找到顶层 configurationApi');
}

function configurationDialogApiNamespaces() {
  const source = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'dialogs', 'configuration.js'), 'utf8');
  return new Set(Array.from(source.matchAll(/\bapi\.([A-Za-z_$][\w$]*)/g), (match) => match[1]));
}

test('配置弹窗使用的 api 命名空间全部在生产 configurationApi 中装配', () => {
  const wired = productionConfigurationApiKeys();
  const used = configurationDialogApiNamespaces();
  assert.ok(used.has('balanceSeeds'), '应能识别到【余额管理】使用的 balanceSeeds');
  assert.deepEqual([...used].filter((namespace) => !wired.has(namespace)).sort(), []);
});
