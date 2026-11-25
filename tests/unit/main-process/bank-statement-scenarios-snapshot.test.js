'use strict';

// v3.2.22 B5：银行对账单运行 / 导出的场景快照（buildScenariosSnapshot）按 key 排序序列化场景配置，
//   同语义配置在库内往返后 key 顺序不同不再被判为场景已变化而拒绝导出；真实变化仍能识别。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const acorn = require('acorn');

const MAIN_SOURCE = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'src', 'main.js'), 'utf8');
const MAIN_AST = acorn.parse(MAIN_SOURCE, { ecmaVersion: 'latest', sourceType: 'script' });

// 两个函数定义在 registerAppHandlers 内部
function loadNestedFunctions(parentName, names) {
  const parent = MAIN_AST.body.find((node) => node.type === 'FunctionDeclaration' && node.id && node.id.name === parentName);
  assert.ok(parent, parentName);
  const sources = names.map((name) => {
    const node = parent.body.body.find((item) => item.type === 'FunctionDeclaration' && item.id && item.id.name === name);
    assert.ok(node, name);
    return MAIN_SOURCE.slice(node.start, node.end);
  });
  return Function(`${sources.join('\n')}\nreturn { ${names.join(', ')} };`)();
}

const { buildScenariosSnapshot } = loadNestedFunctions('registerAppHandlers', ['buildScenariosSnapshot', 'stableJsonStringify']);

const scenario = (config) => ({ id: 3, name: 'C1 金额匹配', priority: 1, enabled: true, config });

test('同语义场景配置 key 顺序不同（含嵌套与数组内对象）时快照相同', () => {
  const before = buildScenariosSnapshot([scenario({ tolerance: 0.01, fields: [{ a: 1, b: 2 }], options: { x: true, y: 'z' } })], 'policy-1');
  const after = buildScenariosSnapshot([scenario({ options: { y: 'z', x: true }, fields: [{ b: 2, a: 1 }], tolerance: 0.01 })], 'policy-1');
  assert.equal(after, before);
});

test('配置值、数组顺序或日期策略变化时快照不同', () => {
  const base = buildScenariosSnapshot([scenario({ tolerance: 0.01, fields: ['a', 'b'] })], 'policy-1');
  assert.notEqual(buildScenariosSnapshot([scenario({ tolerance: 0.02, fields: ['a', 'b'] })], 'policy-1'), base);
  assert.notEqual(buildScenariosSnapshot([scenario({ tolerance: 0.01, fields: ['b', 'a'] })], 'policy-1'), base);
  assert.notEqual(buildScenariosSnapshot([scenario({ tolerance: 0.01, fields: ['a', 'b'] })], 'policy-2'), base);
});
