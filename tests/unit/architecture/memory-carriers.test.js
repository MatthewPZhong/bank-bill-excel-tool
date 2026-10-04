'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parse } = require('acorn');
const root = path.resolve(__dirname, '../../..');
function carriers(source) {
  const result = [];
  const tree = parse(source, { ecmaVersion: 'latest', sourceType: 'script', locations: true, allowReturnOutsideFunction: true });
  const constructors = new Set(['Worker', 'WorkerClass']);
  const functions = new Set(['spawn']);
  function imports(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'VariableDeclarator' && node.id.type === 'ObjectPattern' &&
        node.init?.callee?.name === 'require') {
      const moduleName = node.init.arguments[0]?.value?.replace(/^node:/, '');
      for (const property of node.id.properties) {
        if (moduleName === 'child_process' && ['fork', 'spawn'].includes(property.key?.name)) functions.add(property.value?.name);
        if (moduleName === 'worker_threads' && property.key?.name === 'Worker') constructors.add(property.value?.name);
      }
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(imports);
      else if (value && typeof value === 'object' && value.type) imports(value);
    }
  }
  imports(tree);
  function visit(node, parent) {
    if (!node || typeof node !== 'object') return;
    const callee = node.callee;
    const isCarrier = node.type === 'NewExpression' && constructors.has(callee?.name) ||
      node.type === 'CallExpression' && (functions.has(callee?.name) || callee?.property?.name === 'fork');
    if (isCarrier) result.push({ guarded: parent?.type === 'CallExpression' && parent.callee?.property?.name === 'observe' &&
      parent.callee?.object?.callee?.name === 'memoryCarrierAdmission', line: node.loc.start.line });
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach((item) => visit(item, node));
      else if (value && typeof value === 'object' && value.type) visit(value, node);
    }
  }
  visit(tree);
  return result;
}
test('所有现存 root/nested 原生载体创建前同步检查准入，新增未观察载体会失败', () => {
  const found = [];
  function visit(directory) {
    for (const item of fs.readdirSync(path.join(root, directory), { withFileTypes: true })) {
      const file = path.posix.join(directory, item.name);
      if (item.isDirectory()) visit(file);
      else if (item.name.endsWith('.js')) for (const entry of carriers(fs.readFileSync(path.join(root, file), 'utf8'))) {
        assert.equal(entry.guarded, true, `${file}:${entry.line}`); found.push(file);
      }
    }
  }
  visit('src');
  const inventory = require('../../../changes/v3.2.11/v3.2.11-bizop-rows-low-memory/carrier-inventory.json');
  assert.deepEqual(found.sort(), inventory.entries.map((item) => item.file).sort());
  assert.equal(carriers('const worker = new Worker(path);')[0].guarded, false);
  assert.equal(carriers('memoryCarrierAdmission().observe(new Worker(path));')[0].guarded, true);
});

test('child_process 和 Worker 解构别名同样检测观察缺失', () => {
  for (const [moduleName, exported, local, expression] of [
    ['node:child_process', 'fork', 'forkChild', 'forkChild(path)'],
    ['child_process', 'spawn', 'spawnChild', 'spawnChild(path)'],
    ['node:worker_threads', 'Worker', 'ParserWorker', 'new ParserWorker(path)']
  ]) {
    const imported = `const { ${exported}: ${local} } = require('${moduleName}');`;
    assert.deepEqual(carriers(`${imported}${expression};`).map((entry) => entry.guarded), [false]);
    assert.deepEqual(carriers(`${imported}memoryCarrierAdmission().observe(${expression});`).map((entry) => entry.guarded), [true]);
  }
});
