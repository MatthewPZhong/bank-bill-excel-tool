'use strict';

// v3.2.15 网银账单渠道：输出身份、生成分组键与余额方式（纯函数）。
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  describeBalanceMode,
  findBalanceModeMismatch,
  resolveGenerationGroupKey,
  resolveStatementOutputName,
  resolveTemplateBalanceMode
} = require('../../../src/main-process/statement-channel-identity');

test('输出身份：属于渠道取渠道名，普通模板取模板名', () => {
  assert.equal(resolveStatementOutputName({ id: 1, name: 'CMB-SH', channelId: 3, channelName: '招商银行-上海' }), '招商银行-上海');
  assert.equal(resolveStatementOutputName({ id: 2, name: '工行-深圳', channelId: null, channelName: '' }), '工行-深圳');
  assert.equal(resolveStatementOutputName({ id: 2, name: ' 工行-深圳 ' }), '工行-深圳');
  // 渠道名缺失时不输出空身份
  assert.equal(resolveStatementOutputName({ id: 4, name: 'X-Y', channelId: 5, channelName: '' }), 'X-Y');
  assert.equal(resolveStatementOutputName(null), '');
});

test('分组键：渠道内子模板同组，普通模板与已删除模板各自一组', () => {
  assert.equal(resolveGenerationGroupKey({ id: 1, channelId: 3 }), 'channel:3');
  assert.equal(resolveGenerationGroupKey({ id: 2, channelId: 3 }), 'channel:3');
  assert.equal(resolveGenerationGroupKey({ id: 7, channelId: null }), 'template:7');
  assert.equal(resolveGenerationGroupKey({ id: 9 }), 'template:9');
});

test('余额方式：未映射与“无”为不出余额，“通过发生额计算”为计算，其它列名为取账单余额', () => {
  assert.equal(resolveTemplateBalanceMode([]), 'none');
  assert.equal(resolveTemplateBalanceMode([{ templateField: 'Balance', mappedField: '' }]), 'none');
  assert.equal(resolveTemplateBalanceMode([{ templateField: 'Balance', mappedField: '无' }]), 'none');
  assert.equal(resolveTemplateBalanceMode([{ templateField: 'Balance', mappedField: '通过发生额计算' }]), 'calculated');
  assert.equal(resolveTemplateBalanceMode([{ templateField: 'BillDate', mappedField: '日期' }, { templateField: 'Balance', mappedField: '余额' }]), 'statement');
  assert.equal(describeBalanceMode('statement'), '取账单余额列');
});

test('余额方式一致返回 null，不一致逐行列出子模板与方式', () => {
  assert.equal(findBalanceModeMismatch([{ templateName: 'A', balanceMode: 'calculated' }, { templateName: 'B', balanceMode: 'calculated' }]), null);
  assert.equal(findBalanceModeMismatch([]), null);
  assert.deepEqual(
    findBalanceModeMismatch([{ templateName: 'A', balanceMode: 'calculated' }, { templateName: 'B', balanceMode: 'statement' }]),
    ['A：通过发生额计算', 'B：取账单余额列']
  );
});
