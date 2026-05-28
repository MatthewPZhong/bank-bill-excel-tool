// v2.1.10 A3 Phase 1 T08 — serialize-error unit test
//
// 覆盖 ≥ 6 case（spec §2.4 + tasks T08）：
//   1. 普通 Error
//   2. FileValidationError（含 detailLines / context）
//   3. SQLITE 错误（含 code）
//   4. 嵌套 cause（3 层）
//   5. 循环引用截断（11 层 cause）
//   6. stack 完整性 round-trip
//   7. TypeError name 透传
//   8. 空入参 / 非 Error 入参
//   9. context 含函数 / Symbol 安全丢弃
//   10. context 含循环引用安全降级

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { serializeError, deserializeError, __test_only__ } = require('../../../src/main-process/serialize-error');
const { FileValidationError } = require('../../../src/backend/file-service/common');

test.describe('serialize-error', () => {

  test('1. 普通 Error round-trip', () => {
    const err = new Error('basic error');
    const s = serializeError(err);
    assert.equal(s.name, 'Error');
    assert.equal(s.message, 'basic error');
    assert.ok(s.stack, 'stack 应保留');
    assert.equal(s.code, null);
    assert.equal(s.cause, null);

    const r = deserializeError(s);
    assert.ok(r instanceof Error);
    assert.equal(r.name, 'Error');
    assert.equal(r.message, 'basic error');
    assert.equal(r.stack, err.stack, 'stack 必须 byte-for-byte 一致');
  });

  test('2. FileValidationError（含 detailLines / context）round-trip', () => {
    const err = new FileValidationError('TEST_CODE_42', '校验失败', {
      detailLines: ['第 1 行：单元格为空', '第 2 行：日期格式错'],
      context: { fileName: 'test.xlsx', sheetIndex: 0, rowCount: 100 },
    });
    const s = serializeError(err);
    assert.equal(s.name, 'FileValidationError');
    assert.equal(s.code, 'TEST_CODE_42');
    assert.equal(s.message, '校验失败');
    assert.deepEqual(s.detailLines, ['第 1 行：单元格为空', '第 2 行：日期格式错']);
    assert.deepEqual(s.context, { fileName: 'test.xlsx', sheetIndex: 0, rowCount: 100 });

    const r = deserializeError(s);
    // 反序列化后 instanceof FileValidationError = false（prototype chain 不跨进程）
    assert.equal(r instanceof FileValidationError, false, 'instanceof 不恢复');
    // 但 err.name 透传
    assert.equal(r.name, 'FileValidationError');
    assert.equal(r.code, 'TEST_CODE_42');
    assert.deepEqual(r.detailLines, ['第 1 行：单元格为空', '第 2 行：日期格式错']);
    assert.deepEqual(r.context, { fileName: 'test.xlsx', sheetIndex: 0, rowCount: 100 });
  });

  test('3. SQLITE 错误（含 code）round-trip', () => {
    const err = new Error('database is locked');
    err.code = 'SQLITE_BUSY';
    const s = serializeError(err);
    assert.equal(s.code, 'SQLITE_BUSY');
    const r = deserializeError(s);
    assert.equal(r.code, 'SQLITE_BUSY');
    assert.equal(r.message, 'database is locked');
  });

  test('4. 嵌套 cause（3 层）round-trip', () => {
    const innermost = new Error('innermost');
    innermost.code = 'INNER';
    const middle = new Error('middle');
    middle.cause = innermost;
    const outer = new Error('outer');
    outer.cause = middle;

    const s = serializeError(outer);
    assert.equal(s.message, 'outer');
    assert.equal(s.cause.message, 'middle');
    assert.equal(s.cause.cause.message, 'innermost');
    assert.equal(s.cause.cause.code, 'INNER');

    const r = deserializeError(s);
    assert.equal(r.message, 'outer');
    assert.equal(r.cause.message, 'middle');
    assert.equal(r.cause.cause.message, 'innermost');
    assert.equal(r.cause.cause.code, 'INNER');
  });

  test('5. 循环引用截断（cause > 10 层 → __truncated__）', () => {
    // 构造 12 层 cause（防御性 over）
    let chain = new Error('depth-0');
    for (let i = 1; i <= 12; i++) {
      const wrapper = new Error(`depth-${i}`);
      wrapper.cause = chain;
      chain = wrapper;
    }
    // 最外层 message=depth-12，依次 cause 到 depth-0
    const s = serializeError(chain);
    // 跑到第 11 层（depth=11 = MAX_CAUSE_DEPTH + 1）应被截断
    let cursor = s;
    let level = 0;
    while (cursor && cursor.cause) {
      level++;
      cursor = cursor.cause;
      if (level > 15) throw new Error('serialize 死循环');
    }
    // cursor 现在是最深一层（含 __truncated__ 标志或非）
    assert.ok(cursor.__truncated__, `深层应被截断（depth=${level}）；实际 truncated=${cursor.__truncated__}`);
    // round-trip 也保留 __truncated__
    const r = deserializeError(s);
    let rCursor = r;
    while (rCursor.cause) rCursor = rCursor.cause;
    assert.ok(rCursor.__truncated__, '反序列化保留 __truncated__');
  });

  test('6. stack 完整性 — 多行 stack round-trip 一致', () => {
    function deepFn() {
      throw new Error('with stack');
    }
    let captured;
    try { deepFn(); } catch (e) { captured = e; }
    const s = serializeError(captured);
    const r = deserializeError(s);
    assert.equal(r.stack, captured.stack, 'stack 必须 byte-for-byte 一致');
    assert.ok(r.stack.includes('deepFn'), 'stack 含 deepFn 函数名');
  });

  test('7. TypeError name 透传（instanceof 不恢复）', () => {
    const err = new TypeError('type mismatch');
    const s = serializeError(err);
    assert.equal(s.name, 'TypeError');
    const r = deserializeError(s);
    // r 是 Error 不是 TypeError（prototype chain 不跨进程）
    assert.equal(r instanceof TypeError, false);
    assert.equal(r.name, 'TypeError');
    assert.equal(r.message, 'type mismatch');
  });

  test('8. 空入参 / 非 Error 入参', () => {
    assert.equal(serializeError(null), null);
    assert.equal(serializeError(undefined), null);

    // 字符串
    const s1 = serializeError('plain string');
    assert.equal(s1.message, 'plain string');
    assert.equal(s1.name, 'Error');

    // 反序列化空
    const r1 = deserializeError(null);
    assert.ok(r1 instanceof Error);
    assert.equal(r1.message, 'unknown worker error');
  });

  test('9. context 含函数 / Symbol 安全丢弃', () => {
    const err = new FileValidationError('TEST', 'msg', {
      context: {
        fileName: 'x.xlsx',
        callback: () => 'never',
        sym: Symbol('s'),
        bigInt: 100n,
        normalNumber: 42,
      },
    });
    const s = serializeError(err);
    assert.equal(s.context.fileName, 'x.xlsx');
    assert.equal(s.context.normalNumber, 42);
    assert.equal(s.context.callback, undefined, 'function 丢弃');
    assert.equal(s.context.sym, undefined, 'symbol 丢弃');
    assert.equal(s.context.bigInt, undefined, 'bigint 丢弃（JSON 不支持）');
  });

  test('10. context 含循环引用安全降级（不抛错）', () => {
    const cyclic = { a: 1 };
    cyclic.self = cyclic;
    const err = new FileValidationError('TEST', 'msg', {
      context: { cyclicObj: cyclic, normalKey: 'value' },
    });
    const s = serializeError(err);
    // 不抛错；cyclicObj 通过 JSON.stringify fail 后用 String() 兜底
    assert.equal(s.context.normalKey, 'value');
    assert.ok(typeof s.context.cyclicObj === 'string', 'cyclicObj 应降级为 string');
  });

  test('11. __test_only__ 暴露常量', () => {
    assert.equal(__test_only__.MAX_CAUSE_DEPTH, 10);
    assert.equal(typeof __test_only__.safeCloneContext, 'function');
  });
});
