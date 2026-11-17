'use strict';

// v3.2.18【导入模板】命名：名称规范化（D1）、与模板 / 渠道重名判断（D2）、待确认文件登记。
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createPendingTemplateImportStore,
  findTemplateImportNameConflict,
  normalizeTemplateImportName
} = require('../../../src/main-process/template-import-naming');

test('小写转大写，首尾空格去掉、连续空格合并，模板名为「银行渠道名-地区」', () => {
  assert.deepEqual(normalizeTemplateImportName({ bankName: ' metacomp ', region: 'sg' }), {
    ok: true, bankName: 'METACOMP', region: 'SG', templateName: 'METACOMP-SG'
  });
  assert.deepEqual(normalizeTemplateImportName({ bankName: 'za   Bank', region: 'Hong  kong 2' }), {
    ok: true, bankName: 'ZA BANK', region: 'HONG KONG 2', templateName: 'ZA BANK-HONG KONG 2'
  });
  assert.equal(normalizeTemplateImportName({ bankName: '1money', region: 'us' }).templateName, '1MONEY-US');
});

test('为空、含「-」、中文、符号或全角字母时拒绝，并说明是哪一项', () => {
  const cases = [
    [{ bankName: '', region: 'SG' }, '请填写银行渠道名'],
    [{ bankName: '  ', region: '' }, '请填写银行渠道名和地区'],
    [{ bankName: 'META-COMP', region: 'SG' }, '银行渠道名只能输入英文字母、数字和空格'],
    [{ bankName: 'METACOMP', region: '新加坡' }, '地区只能输入英文字母、数字和空格'],
    [{ bankName: 'DBS_', region: 'H.K' }, '银行渠道名、地区只能输入英文字母、数字和空格'],
    [{ bankName: 'ＤＢＳ', region: 'SG' }, '银行渠道名只能输入英文字母、数字和空格'],
    [{}, '请填写银行渠道名和地区']
  ];
  for (const [input, message] of cases) {
    assert.deepEqual(normalizeTemplateImportName(input), { ok: false, errorCode: 'TEMPLATE_IMPORT_NAME_INVALID', message }, JSON.stringify(input));
  }
});

test('与已有模板（含子模板）或渠道重名时拒绝，忽略大小写；模板优先于渠道判断', () => {
  const templates = [{ name: 'metacomp-sg' }, { name: 'DBS-HK-子模板-1' }];
  const channels = [{ name: 'Kbank-VN' }, { name: 'METACOMP-SG' }];
  assert.equal(findTemplateImportNameConflict({ templateName: 'METACOMP-SG', templates, channels }).errorCode, 'TEMPLATE_NAME_DUPLICATED');
  assert.match(findTemplateImportNameConflict({ templateName: 'METACOMP-SG', templates, channels }).message, /已有同名模板「metacomp-sg」/);
  const channelConflict = findTemplateImportNameConflict({ templateName: 'KBANK-VN', templates, channels });
  assert.equal(channelConflict.errorCode, 'TEMPLATE_NAME_CHANNEL_CONFLICT');
  assert.match(channelConflict.message, /已有同名渠道「Kbank-VN」/);
  assert.equal(findTemplateImportNameConflict({ templateName: 'DBS-HK', templates, channels }), null);
  assert.equal(findTemplateImportNameConflict({ templateName: 'NEW-SG' }), null);
});

test('待确认文件按窗口归属：别的窗口拿不到、丢弃不了；同一窗口再次预检替换旧登记', () => {
  let counter = 0;
  const store = createPendingTemplateImportStore({ createToken: () => `t${++counter}` });
  const first = store.register({ ownerId: 1, filePath: '/a.xlsx', sourceFileName: 'a.xlsx', headers: ['日期', '金额'] });
  const other = store.register({ ownerId: 2, filePath: '/b.xlsx', sourceFileName: 'b.xlsx', headers: ['X'] });
  assert.equal(store.peek(first, 2), null);
  store.discard(first, 2);
  assert.equal(store.peek(first, 1).filePath, '/a.xlsx');

  const peeked = store.peek(first, 1);
  peeked.headers.push('篡改');
  assert.deepEqual(store.peek(first, 1).headers, ['日期', '金额']);

  const second = store.register({ ownerId: 1, filePath: '/c.xlsx', sourceFileName: 'c.xlsx', headers: [] });
  assert.equal(store.peek(first, 1), null);
  assert.equal(store.peek(second, 1).filePath, '/c.xlsx');
  assert.equal(store.peek(other, 2).filePath, '/b.xlsx');
  assert.equal(store.size(), 2);
});

test('consume 只能取一次；discard 后失效；超时登记作废', () => {
  let now = 1000;
  let counter = 0;
  const store = createPendingTemplateImportStore({ now: () => now, createToken: () => `t${++counter}`, ttlMs: 500 });
  const token = store.register({ ownerId: 1, filePath: '/a.xlsx', sourceFileName: 'a.xlsx', headers: [] });
  assert.equal(store.consume(token, 1).filePath, '/a.xlsx');
  assert.equal(store.consume(token, 1), null);

  const discarded = store.register({ ownerId: 1, filePath: '/b.xlsx', sourceFileName: 'b.xlsx', headers: [] });
  store.discard(discarded, 1);
  assert.equal(store.peek(discarded, 1), null);

  const expiring = store.register({ ownerId: 1, filePath: '/c.xlsx', sourceFileName: 'c.xlsx', headers: [] });
  now += 500;
  assert.equal(store.peek(expiring, 1).filePath, '/c.xlsx');
  now += 1;
  assert.equal(store.peek(expiring, 1), null);
  assert.equal(store.peek('', 1), null);
  assert.equal(store.peek(undefined, 1), null);
});
