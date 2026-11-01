'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  TEMPLATE_STRUCTURE_HINT,
  describeHeaderMismatch
} = require('../../../../src/backend/file-service/header-structure-diff');

const GATEWAY = ['bizId', 'batchNo', 'billDate', 'fieldId', 'currency'];
const OUTBOUND = ['业务单号', '账单日期', '币种'];
const candidates = [
  { name: '中台网关原始出账订单', headers: OUTBOUND },
  { name: '中台网关原始入账订单', headers: GATEWAY, versionLabel: 'V1' }
];

test('改名列：选最接近的结构，逐列给出差异、缺少与多出，并提示导入新版本', () => {
  const lines = describeHeaderMismatch({
    sheets: [{ name: '账单明细', headers: ['bizId', 'batchNo', 'billDate', 'fileId', 'currency', ''] }],
    candidates
  });
  assert.deepEqual(lines, [
    '最接近：中台网关原始入账订单（当前版本 V1，5 列；文件 5 列）',
    '第 4 列（D）：应为「fieldId」，实际为「fileId」',
    '缺少列：fieldId',
    '多出列：fileId',
    TEMPLATE_STRUCTURE_HINT
  ]);
});

test('增删与调序：缺列、多列与仅顺序不同分别说明', () => {
  const missing = describeHeaderMismatch({
    sheets: [{ name: 'S', headers: ['bizId', 'batchNo', 'billDate', 'fieldId'] }],
    candidates,
    hint: null
  });
  assert.deepEqual(missing, [
    '最接近：中台网关原始入账订单（当前版本 V1，5 列；文件 4 列）',
    '第 5 列（E）：应为「currency」，实际为空',
    '缺少列：currency'
  ]);

  const extra = describeHeaderMismatch({
    sheets: [{ name: 'S', headers: [...GATEWAY, 'remark'] }],
    candidates,
    hint: null
  });
  assert.deepEqual(extra.slice(1), ['第 6 列（F）：多出「remark」', '多出列：remark']);

  const reordered = describeHeaderMismatch({
    sheets: [{ name: 'S', headers: ['batchNo', 'bizId', 'billDate', 'fieldId', 'currency'] }],
    candidates,
    hint: null
  });
  assert.deepEqual(reordered.slice(1), [
    '第 1 列（A）：应为「bizId」，实际为「batchNo」',
    '第 2 列（B）：应为「batchNo」，实际为「bizId」',
    '列名一致，但顺序不同'
  ]);
});

test('多工作表时标出最接近的那张；与任何结构都无相同列名时列出各表首行', () => {
  const lines = describeHeaderMismatch({
    sheets: [
      { name: '说明', headers: ['备注'] },
      { name: '明细', headers: ['业务单号', '账单日期', '金额'] }
    ],
    candidates,
    hint: null
  });
  assert.equal(lines[0], '工作表「明细」最接近：中台网关原始出账订单（3 列；文件 3 列）');

  const unrelated = describeHeaderMismatch({
    sheets: [{ name: 'Sheet1', headers: ['a', 'b'] }, { name: 'Sheet2', headers: [] }],
    candidates,
    hint: null
  });
  assert.deepEqual(unrelated, [
    '文件表头与所有已知结构都没有相同的列名',
    '工作表「Sheet1」第 1 行（2 列）：a、b',
    '工作表「Sheet2」第 1 行为空'
  ]);
});

test('大量位置差异时截断，明细不超过 100 行', () => {
  const expected = Array.from({ length: 200 }, (_, index) => `c${index}`);
  const actual = ['inserted', ...expected];
  const lines = describeHeaderMismatch({
    sheets: [{ name: 'S', headers: actual }],
    candidates: [{ name: '宽表', headers: expected }]
  });
  assert.ok(lines.length <= 100);
  assert.ok(lines.includes('另有 181 列位置不一致'));
  assert.ok(lines.includes('多出列：inserted'));
  assert.equal(lines[lines.length - 1], TEMPLATE_STRUCTURE_HINT);
});

const {
  canonicalHeaderMapping,
  describeCanonicalMapping,
  projectRowToCanonical
} = require('../../../../src/backend/file-service/header-structure-diff');

test('对应回内置列：同名优先，同一位置的非内置列名视为改名，其余置空或不导入', () => {
  const canonical = ['id', 'amount', 'memo', 'extra1', 'extra2'];
  const mapping = canonicalHeaderMapping(canonical, ['amount', 'id', 'note', 'extra1', 'newCol', 'tail']);
  // memo（第 3 列）→ 同位置 note 视为改名；extra2（第 5 列）同位置 newCol 视为改名；tail 不导入。
  assert.deepEqual(mapping.sourceIndex, [1, 0, 2, 3, 4]);
  assert.deepEqual(mapping.renamed, [
    { column: 3, from: 'memo', to: 'note' },
    { column: 5, from: 'extra2', to: 'newCol' }
  ]);
  assert.deepEqual(mapping.emptied, []);
  assert.deepEqual(mapping.dropped, ['tail']);
  assert.deepEqual(projectRowToCanonical(['10', 'A', 'n', 'e1', 'x', 't'], mapping.sourceIndex), ['A', '10', 'n', 'e1', 'x']);
});

test('同一位置是另一个内置列名或已被使用时不按位置改名，内置列置空', () => {
  const mapping = canonicalHeaderMapping(['a', 'b', 'c'], ['a', 'c']);
  assert.deepEqual(mapping.sourceIndex, [0, -1, 1]);
  assert.deepEqual(mapping.renamed, []);
  assert.deepEqual(mapping.emptied, ['b']);
  assert.deepEqual(describeCanonicalMapping(mapping), ['导入后为空：b']);
  assert.deepEqual(projectRowToCanonical(['1', '3'], mapping.sourceIndex), ['1', undefined, '3']);
});

test('调用方给出行描述时（表头行不确定，按前几个非空行比较）用它代替工作表前缀', () => {
  const lines = describeHeaderMismatch({
    sheets: [
      { name: 'Sheet1', rowLabel: '', headers: ['外汇交割查询'] },
      { name: 'Sheet1', rowLabel: '第 2 个非空行', headers: ['bizId', 'batchNo', 'billDate', 'fileId', 'currency'] }
    ],
    candidates
  });
  assert.equal(lines[0], '第 2 个非空行最接近：中台网关原始入账订单（当前版本 V1，5 列；文件 5 列）');
  assert.deepEqual(describeHeaderMismatch({
    sheets: [{ name: 'Sheet1', rowLabel: '', headers: ['x'] }, { name: 'Sheet1', rowLabel: '第 2 个非空行', headers: [] }],
    candidates,
    hint: null
  }), ['文件表头与所有已知结构都没有相同的列名', '第 1 个非空行（1 列）：x', '第 2 个非空行为空']);
});
