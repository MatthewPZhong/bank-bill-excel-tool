'use strict';

// v3.2.21 第三十三轮审查：跨 Sheet 回填弹窗按当前草稿校验回填目标时，字段筛选特征值按特征值引用的源列（不是特征值 id）
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const acorn = require('acorn');

const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/dialogs/configuration.js'), 'utf8');
const ast = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'script' });

function findFunction(name) {
  let found = null;
  (function visit(node) {
    if (found || !node || typeof node !== 'object') return;
    if (node.type === 'FunctionDeclaration' && node.id && node.id.name === name) {
      found = node;
      return;
    }
    Object.values(node).forEach((value) => {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') visit(value);
    });
  }(ast));
  assert.ok(found, name);
  return source.slice(found.start, found.end);
}

function compile(name, deps) {
  return Function(...Object.keys(deps), `return (${findFunction(name)});`)(...Object.values(deps));
}

const FEATURE_FILTER_MAPPING_FIELD = '字段筛选特征值';
const findFeatureFilterById = compile('findFeatureFilterById', {});
const getFeatureFilterRef = compile('getFeatureFilterRef', {});

function excludedTargets({ headers, mappings, featureFilters }) {
  return compile('collectCrossSheetBackfillExcludedTargets', {
    payload: { template: { headers } },
    tbody: {},
    collectMappingDraftFromTable: () => mappings,
    currentFeatureFilters: featureFilters,
    findFeatureFilterById,
    getFeatureFilterRef,
    FEATURE_FILTER_MAPPING_FIELD
  })();
}

test('发生额选了字段筛选特征值：排除特征值实际读取的源列，不按特征值 id 排除同名的另一列', () => {
  const excluded = excludedTargets({
    headers: ['Date', 'Description', '1', 'Debit'],
    mappings: [
      { templateField: 'Credit Amount', mappedField: FEATURE_FILTER_MAPPING_FIELD, mappedFields: ['1'] },
      { templateField: 'Debit Amount', mappedField: 'Debit', mappedFields: ['Debit'] },
      { templateField: 'Remark', mappedField: '1', mappedFields: ['1'] }
    ],
    featureFilters: [{ id: '1', sourceField: 'Description' }]
  });
  assert.deepEqual(excluded.sort(), ['Debit', 'Description']);
});

test('特征值未选或已删除时不排除任何列（保存前检查另行提示）', () => {
  const excluded = excludedTargets({
    headers: ['Date', 'Description', '1'],
    mappings: [{ templateField: 'Credit Amount', mappedField: FEATURE_FILTER_MAPPING_FIELD, mappedFields: ['9'] }],
    featureFilters: [{ id: '1', sourceField: 'Description' }]
  });
  assert.deepEqual(excluded, []);
});
