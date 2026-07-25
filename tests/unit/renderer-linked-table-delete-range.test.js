'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(
  path.join(__dirname, '..', '..', 'src', 'renderer-dialogs.js'),
  'utf8'
);

function extractFunction(startName, endName) {
  const start = source.indexOf(`function ${startName}(`);
  const end = source.indexOf(`function ${endName}(`, start + 1);
  assert.ok(start >= 0 && end > start, `应能提取 ${startName}`);
  return source.slice(start, end);
}

test.describe('资金对账链接表删除框标题', () => {
  const linkedDelete = extractFunction(
    'createLinkedTableDeleteRangeDialog',
    'createScenariosManagerDialog'
  );
  const preFundDelete = extractFunction(
    'createPreFundTempDeleteRangeDialog',
    'createLinkedTableManagerDialog'
  );

  test('三种目标表共用固定标题“删除数据”', () => {
    assert.match(linkedDelete, /class="dialog-title" data-role="title">删除数据<\/div>/);
    assert.doesNotMatch(linkedDelete, /titleEl\.textContent\s*=\s*`删除/);
    assert.doesNotMatch(linkedDelete, /删除\$\{escapeHtml\(LINKED_DELETE_TABLE_LABELS/);
  });

  test('切表仍重新计数并按当前 tableKey 删除', () => {
    assert.match(linkedDelete, /tableSelect\.addEventListener\('change'[\s\S]*confirmBtn\.disabled = true[\s\S]*countToken \+= 1[\s\S]*refreshState\(\)/);
    assert.match(linkedDelete, /countByDateRange\(s, e, tableKey\)/);
    assert.match(linkedDelete, /deleteByDateRange\(s, e, tableKey\)/);
    assert.match(linkedDelete, /已删除 \$\{deleted\} 行\$\{label\}数据/);
  });

  test('前置资金临时链接表删除标题保持按来源变化', () => {
    assert.match(preFundDelete, /删除\$\{defaultTable\.label\}数据/);
    assert.match(preFundDelete, /titleEl\.textContent = `删除\$\{selectedTable\(\)\.label\}数据`/);
  });
});
