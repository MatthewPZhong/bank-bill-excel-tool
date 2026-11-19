'use strict';

// v3.2.19 拆分/合并账单「费用账单发生额特殊取值逻辑」公式（spec §3.4、§3.5）：
//   先乘除后加减；运算字段带正负号参与、空白或无法识别按 0；结果取绝对值、四舍五入保留 2 位；
//   非 0 ÷ 0 标记报错，0 ÷ 0 按 0；保存校验要求只有最后一组且必须是「运算结束」。

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  evaluateFeeAmountFormula,
  normalizeFeeAmountFormula,
  roundFeeAmount,
  validateFeeAmountFormula
} = require('../../../../src/backend/file-service/bill-split-fee-formula');

function formula(...parts) {
  // formula('A', '+', 'B', 'end') → [{ field: 'A', op: '+' }, { field: 'B', op: 'end' }]
  const items = [];
  for (let index = 0; index < parts.length; index += 2) {
    items.push({ field: parts[index], op: parts[index + 1] });
  }
  return items;
}

function evaluate(items, cells) {
  return evaluateFeeAmountFormula(items, (field) => cells[field]);
}

test('先乘除后加减，同级从左到右', () => {
  const cells = { A: '1', B: '2', C: '3', D: '4' };
  assert.equal(evaluate(formula('A', '+', 'B', '*', 'C', 'end'), cells).amount, '7');
  assert.equal(evaluate(formula('A', '-', 'B', '*', 'C', '+', 'D', 'end'), cells).amount, '1');
  assert.equal(evaluate(formula('D', '/', 'B', '*', 'C', 'end'), cells).amount, '6');
  assert.equal(evaluate(formula('D', '-', 'B', '-', 'A', 'end'), cells).amount, '1');
  assert.equal(evaluate(formula('A', 'end'), cells).amount, '1');
});

test('运算字段带正负号参与，去千分位与货币符号；空白或无法识别按 0', () => {
  const cells = { fee: '-5.00', post: '¥1,200.50', blank: '', text: 'N/A', num: 3 };
  assert.equal(evaluate(formula('post', '+', 'fee', 'end'), cells).amount, '1195.5');
  assert.equal(evaluate(formula('fee', '+', 'blank', '+', 'text', 'end'), cells).amount, '5');
  assert.equal(evaluate(formula('num', '*', 'blank', 'end'), cells).amount, '');
});

test('按十进制精确计算：大金额的半分边界照常进位，数值型与文本型运算字段（含指数形式）结果一致', () => {
  assert.equal(evaluate(formula('A', '+', 'B', 'end'), { A: '10000', B: '0.005' }).amount, '10000.01');
  assert.equal(evaluate(formula('A', '+', 'B', 'end'), { A: 8192, B: 0.005 }).amount, '8192.01');
  assert.equal(evaluate(formula('A', '-', 'B', 'end'), { A: '10000.025', B: '0.01' }).amount, '10000.02');
  assert.equal(evaluate(formula('A', 'end'), { A: '999999999999.995' }).amount, '1000000000000');
  for (const cells of [{ A: 10000000, B: 0.0000001 }, { A: '10000000', B: '0.0000001' }, { A: '1E+7', B: '1e-7' }]) {
    assert.equal(evaluate(formula('A', '*', 'B', 'end'), cells).amount, '1', JSON.stringify(cells));
  }
  assert.equal(evaluate(formula('A', '/', 'B', '*', 'C', 'end'), { A: '1', B: '3', C: '3' }).amount, '1');
});

test('结果取绝对值，四舍五入保留 2 位（十进制半入，不受浮点尾差影响）', () => {
  assert.equal(evaluate(formula('A', '-', 'B', 'end'), { A: '1', B: '8.456' }).amount, '7.46');
  assert.equal(evaluate(formula('A', '+', 'B', 'end'), { A: '0.1', B: '0.2' }).amount, '0.3');
  assert.equal(evaluate(formula('A', '*', 'B', 'end'), { A: '1.005', B: '1' }).amount, '1.01');
  assert.equal(evaluate(formula('A', '/', 'B', 'end'), { A: '10', B: '3' }).amount, '3.33');
  assert.equal(evaluate(formula('A', '/', 'B', 'end'), { A: '20', B: '3' }).amount, '6.67');
  assert.equal(roundFeeAmount(2.5), '2.5');
  assert.equal(roundFeeAmount(-0.004), '0');
  assert.equal(roundFeeAmount(1234567.895), '1234567.9');
});

test('非 0 ÷ 0 标记报错；0 ÷ 0（如空白行）按 0', () => {
  assert.deepEqual(evaluate(formula('A', '/', 'B', 'end'), { A: '5', B: '' }), { amount: '', divisionByZero: true });
  assert.deepEqual(evaluate(formula('A', '/', 'B', 'end'), { A: '', B: '0' }), { amount: '', divisionByZero: false });
  assert.deepEqual(
    evaluate(formula('A', '+', 'B', '/', 'C', 'end'), { A: '1', B: '', C: '' }),
    { amount: '1', divisionByZero: false }
  );
});

test('规范化：接受数组或 JSON，丢弃两项都为空白的组与非法项', () => {
  assert.deepEqual(
    normalizeFeeAmountFormula([{ field: ' 手续费 ', op: '+' }, { field: '', op: '' }, null, ['x'], { field: '邮电费', op: 'end' }]),
    formula('手续费', '+', '邮电费', 'end')
  );
  assert.deepEqual(normalizeFeeAmountFormula('[{"field":"A","op":"end"}]'), formula('A', 'end'));
  assert.deepEqual(normalizeFeeAmountFormula('not json'), []);
  assert.deepEqual(normalizeFeeAmountFormula(''), []);
  assert.deepEqual(normalizeFeeAmountFormula(null), []);
});

test('保存校验：至少一组、字段与运算符必选、只有最后一组且必须是「运算结束」、字段须在表头', () => {
  const headers = ['手续费', '邮电费'];
  assert.deepEqual(
    validateFeeAmountFormula(formula('手续费', '+', '邮电费', 'end'), headers),
    formula('手续费', '+', '邮电费', 'end')
  );
  assert.throws(() => validateFeeAmountFormula([], headers), /请至少新增一组运算字段/);
  assert.throws(() => validateFeeAmountFormula(formula('', 'end'), headers), /第 1 组：请选择运算字段/);
  assert.throws(() => validateFeeAmountFormula(formula('手续费', '', '邮电费', 'end'), headers), /第 1 组：请选择运算符/);
  assert.throws(() => validateFeeAmountFormula(formula('手续费', '+'), headers), /最后一组的运算符必须是「运算结束」/);
  assert.throws(
    () => validateFeeAmountFormula(formula('手续费', 'end', '邮电费', 'end'), headers),
    /「运算结束」只能用在最后一组，第 1 组之后还有运算字段/
  );
  assert.throws(() => validateFeeAmountFormula(formula('手续费', '%', '邮电费', 'end'), headers), /第 1 组：运算符无效/);
  assert.throws(() => validateFeeAmountFormula(formula('利息', 'end'), headers), /映射字段不存在：利息/);
  // headers 为 null 时只校验结构（生成前另有失效引用拦截）
  assert.deepEqual(validateFeeAmountFormula(formula('利息', 'end'), null), formula('利息', 'end'));
});
