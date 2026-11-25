// v3.0.8 BUG3：readers.js 大文件内存类错误 → 真实文案「文件过大，超出处理能力，请拆分后再试」
//   （旧实现统一吞成「文件为空或不可读」，误导用户——文件明明有内容、只是太大）。
//
// 覆盖 isMemoryLimitError 判定（纯谓词）：RangeError / V8 OOM 关键字命中 → true；普通错误 → false。

const test = require('node:test');
const assert = require('node:assert/strict');

const { isMemoryLimitError } = require('../../../../src/backend/file-service/readers');

test.describe('isMemoryLimitError（大文件全量读触顶内存类错误判定）', () => {
  test('容量类 RangeError → true（V8 ArrayBuffer / string / array 上限）', () => {
    assert.equal(isMemoryLimitError(new RangeError('Array buffer allocation failed')), true);
    assert.equal(isMemoryLimitError(new RangeError('Invalid string length')), true);
    assert.equal(isMemoryLimitError(new RangeError('Invalid array length')), true);
  });

  // v3.2.22 B19：小型损坏文件解析时抛出的非容量类 RangeError 不再误报「文件过大」
  test('非容量类 RangeError → false', () => {
    assert.equal(isMemoryLimitError(new RangeError('任意 range 错误')), false);
    assert.equal(isMemoryLimitError(new RangeError('Offset is outside the bounds of the DataView')), false);
    assert.equal(isMemoryLimitError(new RangeError('Maximum call stack size exceeded')), false);
    assert.equal(isMemoryLimitError(new RangeError('Invalid typed array length: -1')), false);
  });

  test('Node 容量类错误码 → true（文件超过 2 GiB、字符串 / Buffer 超出上限）', () => {
    for (const code of ['ERR_FS_FILE_TOO_LARGE', 'ERR_STRING_TOO_LONG', 'ERR_BUFFER_TOO_LARGE']) {
      assert.equal(isMemoryLimitError(Object.assign(new RangeError('size limit'), { code })), true, code);
    }
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
