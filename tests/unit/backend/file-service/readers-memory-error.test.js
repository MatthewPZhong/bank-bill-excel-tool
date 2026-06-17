// v3.0.8 BUG3：readers.js 大文件内存类错误 → 真实文案「文件过大，超出处理能力，请拆分后再试」
//   （旧实现统一吞成「文件为空或不可读」，误导用户——文件明明有内容、只是太大）。
//
// 覆盖 isMemoryLimitError 判定（纯谓词）：RangeError / V8 OOM 关键字命中 → true；普通错误 → false。

const test = require('node:test');
const assert = require('node:assert/strict');

const { isMemoryLimitError } = require('../../../../src/backend/file-service/readers');

test.describe('isMemoryLimitError（大文件全量读触顶内存类错误判定）', () => {
  test('RangeError → true（V8 ArrayBuffer / string / array 上限均抛 RangeError）', () => {
    assert.equal(isMemoryLimitError(new RangeError('Array buffer allocation failed')), true);
    assert.equal(isMemoryLimitError(new RangeError('Invalid string length')), true);
    assert.equal(isMemoryLimitError(new RangeError('Invalid array length')), true);
    assert.equal(isMemoryLimitError(new RangeError('任意 range 错误')), true, 'RangeError 子类一律视为容量类');
  });

  test('message 命中 OOM 关键字 → true（即便不是 RangeError 实例）', () => {
    assert.equal(isMemoryLimitError(new Error('JavaScript heap out of memory')), true);
    assert.equal(isMemoryLimitError(new Error('Cannot allocate memory')), true);
    assert.equal(isMemoryLimitError(new Error('allocation failed - process out of memory')), true);
  });

  test('普通错误 → false（不误判为大文件）', () => {
    assert.equal(isMemoryLimitError(new Error('文件损坏')), false);
    assert.equal(isMemoryLimitError(new TypeError('xx is not a function')), false);
    assert.equal(isMemoryLimitError(null), false);
    assert.equal(isMemoryLimitError(undefined), false);
  });
});
