'use strict';
// 大表导入引擎 contract 校验单测（v3.0.3 PR-G1）
//   三层白名单防护「第 1 层 · 静态推导」：whitelist 非 null 时必须 ⊇ requiredColumns，否则拒绝启动。
//   + schema 校验 + 越界 sanity。

const { test } = require('node:test');
const assert = require('node:assert');
const { validateContract, ContractValidationError } = require('../../../../src/backend/big-table-import/contract');

// 合法契约工厂（可覆盖字段）
function baseContract(over = {}) {
  return Object.assign({
    expectedHeaders: ['A', 'B', 'C', 'D', 'E'],
    valueColumnWhitelist: [0, 2, 4],
    requiredColumns: [0, 2, 4],
    validateHeaders: (cells) => ({ ok: true, error: '', detailLines: [] }),
    mapRow: ({ values }) => ({ params: [values[0]] }),
    insertSql: 'INSERT INTO t (a) VALUES (?)',
    monthKeyOf: ({ values }) => values[0]
  }, over);
}

test.describe('big-table-import contract.validateContract', () => {

  test('合法契约 → 通过，返回归一化（whitelist→Set，requiredColumns 去重升序）', () => {
    const c = validateContract(baseContract({ requiredColumns: [4, 0, 2, 0] }));
    assert.ok(c.valueColumnWhitelist instanceof Set, 'whitelist 归一化为 Set');
    assert.deepEqual([...c.valueColumnWhitelist].sort((a, b) => a - b), [0, 2, 4]);
    assert.deepEqual(c.requiredColumns, [0, 2, 4], 'requiredColumns 去重升序');
  });

  test('whitelist=null（全列）→ 通过（默认安全，不做必需列校验）', () => {
    const c = validateContract(baseContract({ valueColumnWhitelist: null }));
    assert.equal(c.valueColumnWhitelist, null, 'null 保持 null');
  });

  // 🔴 第 1 层防护核心：whitelist 漏配必需列 → 拒绝启动
  test('🔴 whitelist 漏配必需列 → throw（拒绝启动），错误含漏配列索引与表头名', () => {
    let err = null;
    try {
      // requiredColumns 含 2，但 whitelist 缺 2
      validateContract(baseContract({ valueColumnWhitelist: [0, 4], requiredColumns: [0, 2, 4] }));
    } catch (e) {
      err = e;
    }
    assert.ok(err, '应抛错');
    assert.equal(err.name, 'ContractValidationError', '错误类型 ContractValidationError');
    assert.match(err.message, /未涵盖全部必需列/, 'message 指明未涵盖必需列');
    assert.match(err.message, /拒绝启动/, 'message 含「拒绝启动」');
    const joined = err.message + (err.detailLines || []).join('');
    assert.ok(joined.includes('2'), '指出漏配列索引 2');
    assert.ok(joined.includes('C'), '指出漏配列表头名 C（索引 2）');
  });

  test('🔴 whitelist 漏配多列 → 全部列入 detailLines', () => {
    let err = null;
    try {
      validateContract(baseContract({ valueColumnWhitelist: [0], requiredColumns: [0, 2, 4] }));
    } catch (e) { err = e; }
    assert.ok(err && err.name === 'ContractValidationError');
    const joined = (err.detailLines || []).join('');
    assert.ok(joined.includes('C') && joined.includes('E'), '漏配的列 C(2)/E(4) 都列出');
  });

  test('whitelist ⊇ requiredColumns（白名单更宽）→ 通过', () => {
    const c = validateContract(baseContract({ valueColumnWhitelist: [0, 1, 2, 4], requiredColumns: [0, 2] }));
    assert.ok(c.valueColumnWhitelist.has(1), '白名单可比必需列宽');
  });

  // schema 校验
  test('expectedHeaders 非数组/空/含非字符串 → throw', () => {
    assert.throws(() => validateContract(baseContract({ expectedHeaders: [] })), ContractValidationError);
    assert.throws(() => validateContract(baseContract({ expectedHeaders: 'X' })), ContractValidationError);
    assert.throws(() => validateContract(baseContract({ expectedHeaders: ['A', 1] })), ContractValidationError);
  });

  test('validateHeaders / mapRow / monthKeyOf 非函数 → throw', () => {
    assert.throws(() => validateContract(baseContract({ validateHeaders: null })), ContractValidationError);
    assert.throws(() => validateContract(baseContract({ mapRow: 'x' })), ContractValidationError);
    assert.throws(() => validateContract(baseContract({ monthKeyOf: 123 })), ContractValidationError);
  });

  test('insertSql 非字符串/空 → throw', () => {
    assert.throws(() => validateContract(baseContract({ insertSql: '' })), ContractValidationError);
    assert.throws(() => validateContract(baseContract({ insertSql: null })), ContractValidationError);
  });

  test('requiredColumns 非「非负整数数组」→ throw', () => {
    assert.throws(() => validateContract(baseContract({ requiredColumns: [0, -1] })), ContractValidationError);
    assert.throws(() => validateContract(baseContract({ requiredColumns: [0, 1.5] })), ContractValidationError);
    assert.throws(() => validateContract(baseContract({ requiredColumns: 'x' })), ContractValidationError);
  });

  test('valueColumnWhitelist 非 null 且非「非负整数数组」→ throw', () => {
    assert.throws(() => validateContract(baseContract({ valueColumnWhitelist: [0, -1] })), ContractValidationError);
    assert.throws(() => validateContract(baseContract({ valueColumnWhitelist: 'x' })), ContractValidationError);
  });

  // 越界 sanity
  test('🔴 requiredColumns 越界 expectedHeaders 长度 → throw', () => {
    let err = null;
    try {
      // expectedHeaders 5 列（索引 0-4），requiredColumns 含 5（越界）
      validateContract(baseContract({ requiredColumns: [0, 5], valueColumnWhitelist: [0, 5] }));
    } catch (e) { err = e; }
    assert.ok(err && err.name === 'ContractValidationError');
    assert.match(err.message, /requiredColumns 含越界/, 'message 指明 requiredColumns 越界');
  });

  test('🔴 whitelist 越界 expectedHeaders 长度 → throw', () => {
    let err = null;
    try {
      validateContract(baseContract({ valueColumnWhitelist: [0, 2, 4, 9], requiredColumns: [0, 2, 4] }));
    } catch (e) { err = e; }
    assert.ok(err && err.name === 'ContractValidationError');
    assert.match(err.message, /valueColumnWhitelist 含越界/, 'message 指明 whitelist 越界');
  });

  test('requiredColumns 为空数组（无必需列）→ 通过（whitelist 任意）', () => {
    const c = validateContract(baseContract({ requiredColumns: [], valueColumnWhitelist: [0] }));
    assert.deepEqual(c.requiredColumns, []);
  });

  test('contract 非对象 → throw', () => {
    assert.throws(() => validateContract(null), ContractValidationError);
    assert.throws(() => validateContract(undefined), ContractValidationError);
    assert.throws(() => validateContract(42), ContractValidationError);
  });
});
