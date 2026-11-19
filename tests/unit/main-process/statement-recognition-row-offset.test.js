'use strict';

// v3.2.19：工作表有效范围不从第 1 行开始时，大账号分段识别记录的表头行号须与 readRowsWithMetadata 的源行号同为物理行号
//   （finalizeBigAccountRecognitionBasis 按行号比较两者）；只记偏移，不改按下标读取的候选行。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const acorn = require('acorn');
const XLSX = require('xlsx');

const { buildExpectedHeaderCandidates, normalizeCell } = require('../../../src/backend/file-service/common');
const { readRowsWithMetadata } = require('../../../src/backend/file-service/readers');

function loadRecognition() {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'src', 'main.js'), 'utf8');
  const ast = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'script' });
  const functionSource = (name) => {
    const node = ast.body.find((item) => item.type === 'FunctionDeclaration' && item.id && item.id.name === name);
    if (!node) throw new Error(`未找到 main.js 函数：${name}`);
    return source.slice(node.start, node.end);
  };
  const scope = new Map([
    ['buildExpectedHeaderCandidates', buildExpectedHeaderCandidates],
    ['normalizeCell', normalizeCell],
    ['matchMerchantIds', () => 'none']
  ]);
  const proxy = new Proxy({}, {
    has: (_target, key) => scope.has(key),
    get: (_target, key) => (key === Symbol.unscopables ? undefined : scope.get(key))
  });
  const evaluate = (code) => Function('scope', `with (scope) { return (${code}); }`)(proxy);
  ['findHeaderRowNumbersInRawRows', 'buildBigAccountRecognitionBasis'].forEach((name) => scope.set(name, evaluate(functionSource(name))));
  return scope.get('buildBigAccountRecognitionBasis');
}

test('分段文件的有效范围从第 4 行开始：分段识别的表头行号与源行号、分段表头行号一致（都是物理行号）', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recognition-row-offset-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'segments.xlsx');
  const sheet = XLSX.utils.aoa_to_sheet([
    ['账号：ACC1'],
    ['日期', '收入'],
    ['2026-11-01', '100'],
    ['账号：ACC2'],
    ['日期', '收入'],
    ['2026-11-01', '50']
  ], { origin: 'A4' });
  sheet['!ref'] = 'A4:B9';
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, 'Sheet1');
  XLSX.writeFile(workbook, filePath);

  let rawRows = null;
  const read = readRowsWithMetadata(filePath, ['日期', '收入'], { onWorkbookRows: (rows) => { rawRows = rows; } });
  const basis = loadRecognition()({ rawRows, expectedSourceHeaders: ['日期', '收入'] });
  assert.deepEqual(read.rowNumbers, [5, 6, 7, 9], '分段之间的账号说明行照常读出');
  assert.deepEqual(read.headerBreaks, [8]);
  assert.deepEqual(basis.headerWindows.map((window) => window.headerRowNumber), [5, 8]);
  // 候补行仍按下标取：各段表头紧上方是该段的账号行
  assert.deepEqual(basis.headerWindows.map((window) => window.candidateRows.at(-1)), [['账号：ACC1'], ['账号：ACC2']]);
});
