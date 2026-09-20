'use strict';
// 一次性 Q4 位置清点，不是 G8 别名/闭包边界门禁。
// 从本 worktree 根目录运行 node changes/v3.2.10/codex/v3.2.10-bizop-query-boundaries/evidence/query-boundary-inventory.cjs
const fs = require('node:fs');
const path = require('node:path');
const espree = require('espree');
const base = 'src/main-process/biz-op-v327';
const scopes = ['compute-inputs.js', 'export-inputs.js', 'import-main.js'];
const inventory = []; const violations = []; const commands = [];
for (const file of fs.readdirSync(base).filter((name) => name.endsWith('.js')).sort()) {
  const source = fs.readFileSync(path.join(base, file), 'utf8');
  const ast = espree.parse(source, { ecmaVersion: 2024, sourceType: 'commonjs', range: true, loc: true });
  function walk(node, names = []) {
    if (!node || typeof node.type !== 'string') return;
    if (node.type === 'FunctionDeclaration' && node.id) names = [...names, node.id.name];
    const protectedScope = scopes.includes(file) || file === 'delete-preview.js' && names.includes('collect');
    if (protectedScope && node.type === 'MemberExpression'
        && ['db', 'prepare', 'exec'].includes(node.computed ? node.property.value : node.property.name)) {
      violations.push({ file, line: node.loc.start.line, source: source.slice(...node.range) });
    }
    if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression'
        && ['prepare', 'exec'].includes(node.callee.property.name)) {
      const row = { file: path.join(base, file), functionPath: names.join('.'), line: node.loc.start.line,
        api: node.callee.property.name, expression: source.slice(...node.range) };
      inventory.push(row);
      if (file === 'delete-preview.js') commands.push(row);
    }
    for (const [key, value] of Object.entries(node)) {
      if (['loc', 'range', 'tokens', 'comments'].includes(key)) continue;
      if (Array.isArray(value)) value.forEach((item) => walk(item, names));
      else if (value && typeof value === 'object') walk(value, names);
    }
  }
  walk(ast);
}
const report = { head: '11086a3cbf632a30adbcfa796e4cd81810c5aef9', dirty: true,
  scope: '当前直接属性访问与 SQL 调用位置的 AST 清点；非 G8 别名闭包检查器', g8: '未接入，未声明 active',
  protectedScopes: [...scopes, 'delete-preview.js:createBizOpDeletePreview.collect'], violations,
  legalPreviewCommands: commands, remainingSql: inventory };
fs.writeFileSync(path.join(__dirname, 'query-boundary-inventory.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ protectedRawAccesses: violations.length, previewCommandSites: commands.length, inventorySites: inventory.length }));
if (violations.length || commands.length !== 5) process.exitCode = 1;
