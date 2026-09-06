'use strict';

const { canonicalizeDecimal, addCanonicalDecimals: add, subtractCanonicalDecimals: subtract,
  absoluteDecimal, compareCanonicalDecimals: compare } = require('../financial-decimal');
const { fail } = require('./contracts');

const REASONS = Object.freeze([
  ['AMOUNT_MISMATCH', '金额不平'], ['MISSING_BOTH_OP', '两端缺OP'], ['MISSING_START_OP', '缺起始OP'],
  ['MISSING_END_OP', '缺终止OP'], ['START_BALANCE_CONFLICT', '起始余额冲突'], ['END_BALANCE_CONFLICT', '终止余额冲突'],
  ['MULTIPLE_OP', '多个OP'], ['DESCRIPTION_CHANGED', '描述字段变化'],
  ['START_DESCRIPTION_CONFLICT', '起始描述冲突'], ['END_DESCRIPTION_CONFLICT', '终止描述冲突']
]);
const DESCRIPTION_FIELDS = Object.freeze(['entity', 'customer_no', 'account_type']);
function compareText(left, right) { return Buffer.compare(Buffer.from(left), Buffer.from(right)); }
function keyOf(row) { return [row.key_bu, row.key_account, row.key_currency]; }
function compareKeys(left, right) {
  for (let i = 0; i < 3; i += 1) { const compared = compareText(left[i], right[i]); if (compared) return compared; }
  return 0;
}
function createGroup(key) {
  const side = () => ({ count: 0, balance: null, balanceConflict: false, bu: null,
    descriptions: Object.fromEntries(DESCRIPTION_FIELDS.map((field) => [field, { count: 0, value: null }])) });
  return { key, START_OP: side(), END_OP: side(), FLOW: { count: 0, bu: null, incoming: '0', outgoing: '0' }, descriptionChanged: false };
}
function observe(group, row) {
  if (compareKeys(group.key, keyOf(row)) !== 0 || !group[row.role]) fail('BIZOP_COMPUTE_KEY_INVALID');
  const side = group[row.role];
  side.count += 1;
  if (side.bu === null || compareText(row.bu_display, side.bu) < 0) side.bu = row.bu_display;
  const amount = canonicalizeDecimal(row.balance_or_amount);
  if (row.role === 'FLOW') {
    if (!['入', '出'].includes(row.direction)) fail('BIZOP_FLOW_DIRECTION_INVALID');
    const name = row.direction === '入' ? 'incoming' : 'outgoing';
    side[name] = add(side[name], amount);
  } else if (side.balance === null) side.balance = amount;
  else if (compare(side.balance, amount) !== 0) side.balanceConflict = true;
}
function observeDescription(group, row) {
  if (compareKeys(group.key, keyOf(row)) !== 0 || !DESCRIPTION_FIELDS.includes(row.field_key)) fail('BIZOP_DESCRIPTION_KEY_INVALID');
  for (const [role, present] of [['START_OP', row.in_start], ['END_OP', row.in_end]]) {
    if (!present) continue;
    const field = group[role].descriptions[row.field_key];
    field.count += 1;
    if (field.count === 1) field.value = row.null_flag ? null : row.normalized_value;
  }
  if (row.in_start !== row.in_end) group.descriptionChanged = true;
}
function finishGroup(group, { startDate, endDate, rowOrdinal, locator = String(rowOrdinal) }) {
  const start = group.START_OP; const end = group.END_OP; const flow = group.FLOW;
  const sourceRole = end.count ? 'END_OP' : start.count ? 'START_OP' : 'NONE';
  const chosen = sourceRole === 'NONE' ? null : group[sourceRole];
  const startBalance = start.count && !start.balanceConflict ? start.balance : null;
  const endBalance = end.count && !end.balanceConflict ? end.balance : null;
  const reverseFlow = subtract(flow.outgoing, flow.incoming);
  const reverseEnd = endBalance === null ? null : add(endBalance, reverseFlow);
  const difference = startBalance === null || reverseEnd === null ? null : subtract(startBalance, reverseEnd);
  const amountStatus = difference === null ? '无法计算' : compare(absoluteDecimal(difference), '0.01') > 0 ? '金额不平' : '金额相等';
  const multiple = start.count >= 2 || end.count >= 2;
  const hasDescriptionConflict = (side) => DESCRIPTION_FIELDS.some((field) => side.descriptions[field].count > 1);
  const condition = { AMOUNT_MISMATCH: amountStatus === '金额不平', MISSING_BOTH_OP: !start.count && !end.count,
    MISSING_START_OP: !start.count && end.count > 0, MISSING_END_OP: start.count > 0 && !end.count,
    START_BALANCE_CONFLICT: start.balanceConflict, END_BALANCE_CONFLICT: end.balanceConflict, MULTIPLE_OP: multiple,
    DESCRIPTION_CHANGED: start.count > 0 && end.count > 0 && group.descriptionChanged,
    START_DESCRIPTION_CONFLICT: hasDescriptionConflict(start), END_DESCRIPTION_CONFLICT: hasDescriptionConflict(end) };
  const reasons = REASONS.filter(([code]) => condition[code]);
  const labels = reasons.map(([, label]) => label);
  const described = (field) => chosen?.descriptions[field].count === 1 ? chosen.descriptions[field].value : null;
  const presence = Boolean(start.count) === Boolean(end.count) ? null : `${startDate}${start.count ? '有' : '无'}，${endDate}${end.count ? '有' : '无'}`;
  const values = [chosen?.bu || flow.bu, described('entity'), described('customer_no'), group.key[1], described('account_type'),
    group.key[2], startDate, startBalance, endDate, endBalance, flow.incoming, flow.outgoing, reverseFlow, reverseEnd, difference,
    presence, multiple ? '是' : '否', [amountStatus, ...labels.filter((label) => label !== '金额不平')].join('；'),
    labels.length ? `${labels.join('；')}；详见核对说明:${locator}` : null];
  const reasonBits = REASONS.reduce((bits, [code], index) => bits | (condition[code] ? 1 << index : 0), 0);
  return { rowOrdinal, values, key: group.key, isDifference: reasons.length ? 1 : 0, reasonBits,
    reasonCodes: reasons.map(([code]) => code), descriptionSourceRole: sourceRole,
    counts: { start: start.count, end: end.count, flow: flow.count },
    description: Object.fromEntries(DESCRIPTION_FIELDS.map((field) => [field, { value: described(field),
      startCandidateCount: start.descriptions[field].count, endCandidateCount: end.descriptions[field].count }])) };
}

module.exports = { REASONS, DESCRIPTION_FIELDS, compareText, keyOf, compareKeys, createGroup, observe, observeDescription, finishGroup };
