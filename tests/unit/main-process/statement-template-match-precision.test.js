'use strict';

// 多个模板都能匹配同一份账单时，只保留“最精确”的模板。v3.2.15 起模板表头保留合并单元格占位的中间空列（K1），
// 精确度须按非空表头计数：空占位多、有效字段少的模板借去空口径也能匹配上，按原始长度会挤掉有效字段更多的正确模板。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const acorn = require('acorn');
const XLSX = require('xlsx');

const { FileValidationError, normalizeCell } = require('../../../src/backend/file-service');
const { readRowsWithMetadata } = require('../../../src/backend/file-service/readers');

const ROOT = path.join(__dirname, '..', '..', '..');
const MAIN_SOURCE = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
const MAIN_AST = acorn.parse(MAIN_SOURCE, { ecmaVersion: 'latest', sourceType: 'script' });

function loadMatchFileToTemplate() {
  const node = MAIN_AST.body.find((item) => (
    item.type === 'FunctionDeclaration' && item.id && item.id.name === 'matchFileToTemplate'
  ));
  const names = ['readRowsWithMetadata', 'createStatementWorkbookReadGuard', 'FileValidationError', 'normalizeCell'];
  return Function(...names, `return (${MAIN_SOURCE.slice(node.start, node.end)});`)(
    readRowsWithMetadata, () => undefined, FileValidationError, normalizeCell
  );
}

function writeStatement(t, rows) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'template-match-precision-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'statement.xlsx');
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), 'Sheet1');
  XLSX.writeFile(workbook, filePath);
  return filePath;
}

test('多个模板都匹配时按非空表头数取最精确的模板，空占位不计入（release/v3.2.15 审查）', (t) => {
  const matchFileToTemplate = loadMatchFileToTemplate();
  const templateA = { id: 1, name: 'BANK-A', headers: ['账号', '币种', '日期', '收入', '支出', '余额'] };
  // 模板包导入保留了合并单元格占位的空列：7 个位置、4 个有效字段；完整结构匹配不上，去空口径能匹配 A 的前 4 列。
  const templateB = { id: 2, name: 'BANK-B', headers: ['账号', '', '', '', '币种', '日期', '收入'] };
  const filePath = writeStatement(t, [
    ['账号', '币种', '日期', '收入', '支出', '余额'],
    ['A001', 'USD', '2026-11-01', '100', '', '1100'],
    ['A001', 'USD', '2026-11-01', '', '50', '1050']
  ]);

  assert.deepEqual(matchFileToTemplate(filePath, [templateA, templateB]).map((item) => item.name), ['BANK-A']);
  assert.deepEqual(matchFileToTemplate(filePath, [templateB, templateA]).map((item) => item.name), ['BANK-A']);
  // 前置：B 单独也能匹配（去空口径），说明是精确度排序决定了结果。
  assert.deepEqual(matchFileToTemplate(filePath, [templateB]).map((item) => item.name), ['BANK-B']);
});

test('有效字段数相同的两个模板都保留，交由调用方提示多模板命中', (t) => {
  const matchFileToTemplate = loadMatchFileToTemplate();
  const compact = { id: 1, name: 'COMPACT', headers: ['账号', '币种', '日期', '收入'] };
  const spaced = { id: 2, name: 'SPACED', headers: ['账号', '', '币种', '日期', '收入'] };
  const filePath = writeStatement(t, [
    ['账号', '币种', '日期', '收入'],
    ['A001', 'USD', '2026-11-01', '100']
  ]);
  assert.deepEqual(matchFileToTemplate(filePath, [compact, spaced]).map((item) => item.name), ['COMPACT', 'SPACED']);
});
