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
const { extractHeaders, readRowsWithMetadata } = require('../../../src/backend/file-service/readers');

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

test('按文件名匹配模板的表头预检只解析第一个 sheet（v3.2.21：跨 Sheet 回填的来源表可能很大）', (t) => {
  const node = MAIN_AST.body.find((item) => (
    item.type === 'FunctionDeclaration' && item.id && item.id.name === 'matchFileToTemplate'
  ));
  const seen = [];
  const spyRead = (filePath, headers, options) => {
    seen.push(options);
    return readRowsWithMetadata(filePath, headers, options);
  };
  const matchFileToTemplate = Function('readRowsWithMetadata', 'createStatementWorkbookReadGuard', 'FileValidationError', 'normalizeCell',
    `return (${MAIN_SOURCE.slice(node.start, node.end)});`)(spyRead, () => undefined, FileValidationError, normalizeCell);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'template-match-only-first-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'statement.xlsx');
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['账号', '币种'], ['A001', 'USD']]), 'MAIN');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['Date', 'Credit'], ['2026-09-26', 1]]), 'USD');
  XLSX.writeFile(workbook, filePath);
  assert.deepEqual(matchFileToTemplate(filePath, [{ id: 1, name: 'A', headers: ['账号', '币种'] }]).map((item) => item.name), ['A']);
  assert.equal(seen[0].onlyTargetSheet, true);
});

// ---- v3.2.21 审查回归（第二十八轮）----

function loadMainFunction(name) {
  const node = MAIN_AST.body.find((item) => item.type === 'FunctionDeclaration' && item.id && item.id.name === name);
  const names = ['readRowsWithMetadata', 'createStatementWorkbookReadGuard', 'FileValidationError', 'normalizeCell'];
  return Function(...names, `return (${MAIN_SOURCE.slice(node.start, node.end)});`)(
    readRowsWithMetadata, () => undefined, FileValidationError, normalizeCell
  );
}

test('按文件名匹配模板的两个表头预检与正式映射同一表头取值规则：ODS 表头只写在 office:string-value 上（开闭标签之间没有文字，读取库读成空）时同样匹配', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'template-match-ods-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['Date', 'IN_HEADER'], ['2026-09-25', 1]]), 'MAIN');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['Date', 'Credit']]), 'SRC');
  const container = XLSX.CFB.read(XLSX.write(workbook, { type: 'buffer', bookType: 'ods' }), { type: 'buffer' });
  const content = XLSX.CFB.find(container, 'content.xml');
  const original = '<table:table-cell office:value-type="string"><text:p>IN_HEADER</text:p></table:table-cell>';
  const xml = Buffer.from(content.content).toString('utf8');
  assert.ok(xml.includes(original));
  content.content = Buffer.from(xml.replace(original, '<table:table-cell office:value-type="string" office:string-value="In"></table:table-cell>'), 'utf8');
  const filePath = path.join(dir, 'statement.xls');
  fs.writeFileSync(filePath, XLSX.CFB.write(container, { type: 'buffer', fileType: 'zip' }));
  const template = { id: 1, name: 'ODS', headers: ['Date', 'In'] };
  assert.deepEqual(loadMainFunction('matchFileToTemplate')(filePath, [template]).map((item) => item.name), ['ODS']);
  assert.equal(loadMainFunction('matchesTemplateHeaders')(filePath, template), true);
  // 只要求 Date 的模板不会因另一模板读不到 In 而被选为更精确的一项
  assert.deepEqual(loadMainFunction('matchFileToTemplate')(filePath, [{ id: 2, name: 'DATE-ONLY', headers: ['Date'] }, template])
    .map((item) => item.name), ['ODS']);
});

// ---- v3.2.21 审查回归（第二十九轮）----

test('网银模板的表头（创建、更新共用）与预检同一取值规则：ODS 中间表头只写在属性上时，模板保存原表头，并能匹配该文件自身', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'template-headers-ods-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['Date', 'MEMO_HEADER', 'Amount'], ['2026-09-25', 'x', 1]]), 'MAIN');
  const container = XLSX.CFB.read(XLSX.write(workbook, { type: 'buffer', bookType: 'ods' }), { type: 'buffer' });
  const content = XLSX.CFB.find(container, 'content.xml');
  const original = '<table:table-cell office:value-type="string"><text:p>MEMO_HEADER</text:p></table:table-cell>';
  const xml = Buffer.from(content.content).toString('utf8');
  assert.ok(xml.includes(original));
  content.content = Buffer.from(xml.replace(original, '<table:table-cell office:value-type="string" office:string-value="Memo"></table:table-cell>'), 'utf8');
  const filePath = path.join(dir, 'statement.xls');
  fs.writeFileSync(filePath, XLSX.CFB.write(container, { type: 'buffer', fileType: 'zip' }));
  const node = MAIN_AST.body.find((item) => item.type === 'FunctionDeclaration' && item.id && item.id.name === 'extractStatementTemplateHeaders');
  const extractStatementTemplateHeaders = Function('extractHeaders', `return (${MAIN_SOURCE.slice(node.start, node.end)});`)(extractHeaders);
  const headers = extractStatementTemplateHeaders(filePath);
  assert.deepEqual(headers, ['Date', 'Memo', 'Amount']);
  const template = { id: 1, name: 'ODS', headers };
  assert.deepEqual(loadMainFunction('matchFileToTemplate')(filePath, [template]).map((item) => item.name), ['ODS']);
  assert.equal(loadMainFunction('matchesTemplateHeaders')(filePath, template), true);
  // 【导入模板】【导入子模板】【更新模板】都经同一入口取表头，不直接调用旧的读取口径
  const callers = ['importStatementChildTemplate', 'prepareOrdinaryTemplateImport', 'importOrdinaryTemplate', 'prepareTemplateHeaderUpdate'];
  const found = MAIN_AST.body.filter((item) => item.type === 'FunctionDeclaration' && item.id && callers.includes(item.id.name));
  assert.equal(found.length, callers.length);
  found.forEach((item) => {
    const body = MAIN_SOURCE.slice(item.start, item.end);
    assert.doesNotMatch(body, /\bextractHeaders\(/, item.id.name);
  });
});
