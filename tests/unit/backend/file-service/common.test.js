const test = require('node:test');
const assert = require('node:assert/strict');

const {
  FileValidationError,
  FIXED_FIELD_VALUE_PREFIX,
  SUPPORTED_EXTENSIONS,
  isRowMeaningful,
  normalizeCell,
  trimTrailingEmptyCells
} = require('../../../../src/backend/file-service/common');

// ========================================================================
// 常量自洽性
// ========================================================================

test.describe('FIXED_FIELD_VALUE_PREFIX 常量', () => {
  test('值 = __FIXED__:', () => {
    assert.equal(FIXED_FIELD_VALUE_PREFIX, '__FIXED__:');
  });
});

test.describe('SUPPORTED_EXTENSIONS 常量', () => {
  test('Set 实例', () => {
    assert.ok(SUPPORTED_EXTENSIONS instanceof Set);
  });

  test('支持 .xlsx / .xls / .csv', () => {
    assert.ok(SUPPORTED_EXTENSIONS.has('.xlsx'));
    assert.ok(SUPPORTED_EXTENSIONS.has('.xls'));
    assert.ok(SUPPORTED_EXTENSIONS.has('.csv'));
  });

  test('不支持 .pdf（v2.1.1 起移除）', () => {
    assert.equal(SUPPORTED_EXTENSIONS.has('.pdf'), false);
  });

  test('不支持 .txt / .json', () => {
    assert.equal(SUPPORTED_EXTENSIONS.has('.txt'), false);
    assert.equal(SUPPORTED_EXTENSIONS.has('.json'), false);
  });
});

// ========================================================================
// FileValidationError
// ========================================================================

test.describe('FileValidationError — 构造', () => {
  test('基本构造（仅 code + message）', () => {
    const err = new FileValidationError('FILE_READ', '读取失败');
    assert.equal(err.name, 'FileValidationError');
    assert.equal(err.code, 'FILE_READ');
    assert.equal(err.message, '读取失败');
    assert.ok(err instanceof Error);
  });

  test('options.detailLines 拷贝（不共享引用）', () => {
    const lines = ['line A', 'line B'];
    const err = new FileValidationError('FILE_TYPE', '类型不支持', { detailLines: lines });
    assert.deepEqual(err.detailLines, ['line A', 'line B']);
    // 修改原数组不应影响 err.detailLines
    lines.push('line C');
    assert.equal(err.detailLines.length, 2);
  });

  test('options.context 拷贝（不共享引用）', () => {
    const ctx = { file: 'foo.xlsx', row: 5 };
    const err = new FileValidationError('FILE_READ', 'err', { context: ctx });
    assert.deepEqual(err.context, { file: 'foo.xlsx', row: 5 });
    ctx.row = 999;
    assert.equal(err.context.row, 5);
  });

  test('detailLines 不是数组 → 兜底空数组', () => {
    const err = new FileValidationError('X', 'msg', { detailLines: 'not array' });
    assert.deepEqual(err.detailLines, []);
  });

  test('detailLines 缺失 → 默认空数组', () => {
    const err = new FileValidationError('X', 'msg');
    assert.deepEqual(err.detailLines, []);
  });

  test('context 不是 object → 默认空对象', () => {
    const err = new FileValidationError('X', 'msg', { context: null });
    assert.deepEqual(err.context, {});
  });

  test('context 缺失 → 默认空对象', () => {
    const err = new FileValidationError('X', 'msg');
    assert.deepEqual(err.context, {});
  });

  test('可被 throw + 捕获', () => {
    assert.throws(
      () => { throw new FileValidationError('TEST', '测试错误'); },
      /测试错误/
    );
  });
});

// ========================================================================
// normalizeCell
// ========================================================================

test.describe('normalizeCell — 单元格归一', () => {
  test('null / undefined → 空串', () => {
    assert.equal(normalizeCell(null), '');
    assert.equal(normalizeCell(undefined), '');
  });

  test('字符串 → trim', () => {
    assert.equal(normalizeCell('  abc  '), 'abc');
    assert.equal(normalizeCell('abc'), 'abc');
  });

  test('数字 → 字符串', () => {
    assert.equal(normalizeCell(0), '0');
    assert.equal(normalizeCell(123.45), '123.45');
  });

  test('空字符串 → 空串', () => {
    assert.equal(normalizeCell(''), '');
    assert.equal(normalizeCell('   '), '');
  });

  test('布尔值 → 字符串', () => {
    assert.equal(normalizeCell(false), 'false');
    assert.equal(normalizeCell(true), 'true');
  });
});

// ========================================================================
// isRowMeaningful
// ========================================================================

test.describe('isRowMeaningful — 判断行非空', () => {
  test('全空行 → false', () => {
    assert.equal(isRowMeaningful([null, '', '   ', undefined]), false);
  });

  test('至少一个有效单元格 → true', () => {
    assert.equal(isRowMeaningful(['', '', 'X']), true);
    assert.equal(isRowMeaningful([0, '', '']), true);
  });

  test('空数组 → false', () => {
    assert.equal(isRowMeaningful([]), false);
  });

  test('非数组 → false', () => {
    assert.equal(isRowMeaningful(null), false);
    assert.equal(isRowMeaningful(undefined), false);
    assert.equal(isRowMeaningful('abc'), false);
  });
});

// ========================================================================
// trimTrailingEmptyCells
// ========================================================================

test.describe('trimTrailingEmptyCells — 剥末尾空单元格', () => {
  test('末尾全空 → 截到最后有意义单元格', () => {
    assert.deepEqual(
      trimTrailingEmptyCells(['A', 'B', '', null, '   ']),
      ['A', 'B']
    );
  });

  test('全行空 → 空数组', () => {
    assert.deepEqual(trimTrailingEmptyCells(['', null, '   ']), []);
  });

  test('全部有意义 → 原样', () => {
    assert.deepEqual(trimTrailingEmptyCells(['A', 'B', 'C']), ['A', 'B', 'C']);
  });

  test('中间有空白 → 保留', () => {
    assert.deepEqual(
      trimTrailingEmptyCells(['A', '', 'C', '']),
      ['A', '', 'C']
    );
  });

  test('非数组 → 空数组', () => {
    assert.deepEqual(trimTrailingEmptyCells(null), []);
    assert.deepEqual(trimTrailingEmptyCells(undefined), []);
    assert.deepEqual(trimTrailingEmptyCells('abc'), []);
  });

  test('空数组 → 空数组', () => {
    assert.deepEqual(trimTrailingEmptyCells([]), []);
  });
});
